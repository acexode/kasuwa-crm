import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { hashSessionToken } from '@kasuwa/auth-crypto';
import { resolveSessionIdentity } from '@kasuwa/db';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { notAuthenticated } from '../auth/auth.errors';
import { PG_POOL } from '../database/database.module';
import {
  FORBIDDEN_SCOPE_HEADERS,
  SCOPE_HEADER_REJECTED_BODY,
  STUB_TENANT_HEADER,
  STUB_USER_HEADER,
} from './auth-context';
import { AUTH_CONTEXT_KEY, StubAuthGuard } from './stub-auth.guard';

export const AUTH_MODE = Symbol('AUTH_MODE');
export type ResolvedAuthMode = 'stub' | 'jwt';

/**
 * Authentication for every tenant-scoped route (T-0001, replacing ADR-0007's
 * stub as the primary path).
 *
 * It establishes WHO the caller is and stops there. It resolves no programme,
 * reads no `user_programme`, and puts nothing on the request but a tenant id, a
 * user id and a session id. What the caller can reach is still decided by
 * `withTenantTransaction`, from the database, on every request. That is the
 * whole of why `tests/acceptance/tenancy/` passes unchanged across this
 * change: authentication moved, authorisation did not.
 *
 * Two transports, in strict order of precedence:
 *
 *   1. `Authorization: Bearer` — a real, server-issued session. Always
 *      accepted, in every mode.
 *   2. `x-kasuwa-*` identity headers — the stub (ADR-0007). Accepted ONLY
 *      under KASUWA_AUTH_MODE=stub, which @kasuwa/config refuses to combine
 *      with NODE_ENV=production. The isolation suite depends on it to
 *      impersonate specific seeded users deliberately.
 *
 * A request carrying both is rejected. It is either confused or an attempt to
 * see which identity wins, and neither should get an answer; it is also what
 * makes "a session for tenant A cannot be replayed against tenant B" true by
 * construction rather than by a comparison somebody could get backwards.
 */
@Injectable()
export class KasuwaAuthGuard implements CanActivate {
  private readonly stub = new StubAuthGuard();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUTH_MODE) private readonly mode: ResolvedAuthMode,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    // Scope headers are rejected in every mode, with or without a session. A
    // request that tries to set its own programme scope is an attack or a bug.
    for (const header of FORBIDDEN_SCOPE_HEADERS) {
      if (request.headers[header] !== undefined) {
        throw new BadRequestException({
          ...SCOPE_HEADER_REJECTED_BODY,
          details: [...SCOPE_HEADER_REJECTED_BODY.details],
        });
      }
    }

    const token = readBearerToken(request);
    if (token === null) {
      // Note what is NOT attempted here: no `?access_token=`, no `?token=`, no
      // fragment. A token in a URL ends up in access logs, proxy logs and
      // Referer headers, so this API has exactly one transport for it.
      if (this.mode === 'stub') {
        return this.stub.canActivate(context);
      }
      throw notAuthenticated();
    }

    if (
      request.headers[STUB_TENANT_HEADER] !== undefined ||
      request.headers[STUB_USER_HEADER] !== undefined
    ) {
      throw notAuthenticated();
    }

    const identity = await resolveSessionIdentity(this.pool, hashSessionToken(token));
    if (identity === null) {
      throw notAuthenticated();
    }

    request[AUTH_CONTEXT_KEY] = {
      tenantId: identity.tenantId,
      userId: identity.userId,
      sessionId: identity.sessionId,
    };
    return true;
  }
}

/**
 * Reads `Authorization: Bearer <token>`, and nothing else.
 *
 * Returns null for any other scheme rather than trying to be helpful. The
 * tolerance people add here — accepting a bare token, or a query parameter for
 * "download links" — is how tokens end up in logs.
 */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer (?<token>[A-Za-z0-9._~+/=-]+)$/u.exec(header.trim());
  return match?.groups?.token ?? null;
}
