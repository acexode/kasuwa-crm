import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { hashSessionToken } from '@kasuwa/auth-crypto';
import { resolvePortalSessionIdentity } from '@kasuwa/db';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { notAuthenticated } from '../auth.errors';
import { readBearerToken } from '../../tenancy/kasuwa-auth.guard';
import { FORBIDDEN_SCOPE_HEADERS, SCOPE_HEADER_REJECTED_BODY } from '../../tenancy/auth-context';
import { BadRequestException } from '@nestjs/common';
import { PORTAL_AUTH_CONTEXT_KEY, type PortalAuthContext } from './portal-context';

/**
 * Portal bearer sessions only — never staff stub headers (ADR-0021).
 */
@Injectable()
export class PortalAuthGuard implements CanActivate {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

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

    const identity = await resolvePortalSessionIdentity(this.pool, hashSessionToken(token).toString('hex'));
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
