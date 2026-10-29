import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { hashSessionToken } from '@kasuwa/auth-crypto';
import { resolvePortalSessionIdentity } from '@kasuwa/db';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { AUTH_PG_POOL } from '../auth-database.module';
import { notAuthenticated } from '../auth.errors';
import { readBearerToken } from '../../tenancy/kasuwa-auth.guard';
import { FORBIDDEN_SCOPE_HEADERS, SCOPE_HEADER_REJECTED_BODY } from '../../tenancy/auth-context';
import { PORTAL_AUTH_CONTEXT_KEY, type PortalAuthContext } from './portal-context';

/**
 * Portal bearer sessions only — never staff stub headers (ADR-0021).
 *
 * Presented-token resolve runs on `kasuwa_auth`: migration 0061 revoked
 * `kasuwa_app` SELECT on `portal_session.token_hash`, and Postgres evaluates
 * RLS policy expressions as the invoking role, so the presented-token policy
 * cannot apply to the app pool (0068).
 */
@Injectable()
export class PortalAuthGuard implements CanActivate {
  constructor(@Inject(AUTH_PG_POOL) private readonly authPool: Pool) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

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
      throw notAuthenticated();
    }

    const identity = await resolvePortalSessionIdentity(
      this.authPool,
      hashSessionToken(token).toString('hex'),
    );
    if (identity === null) {
      throw notAuthenticated();
    }

    const ctx: PortalAuthContext = {
      tenantId: identity.tenantId,
      portalIdentityId: identity.portalIdentityId,
      sessionId: identity.sessionId,
    };
    request[PORTAL_AUTH_CONTEXT_KEY] = ctx;
    return true;
  }
}
