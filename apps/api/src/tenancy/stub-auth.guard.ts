import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import {
  FORBIDDEN_SCOPE_HEADERS,
  SCOPE_HEADER_REJECTED_BODY,
  STUB_TENANT_HEADER,
  STUB_USER_HEADER,
  StubAuthHeaders,
  type AuthContext,
} from './auth-context';

export const AUTH_CONTEXT_KEY = 'kasuwaAuthContext';

declare module 'express' {
  interface Request {
    [AUTH_CONTEXT_KEY]?: AuthContext;
  }
}

/**
 * Stubbed authentication (docs/adr/0007, team/DECISIONS.md D-L05).
 *
 * Real auth — password/MFA/SSO, sessions, permission sets — is M2 and belongs
 * to Agent 1. This guard exists so the tenancy slice can be built and tested
 * before that lands, and so the isolation suite can impersonate specific users
 * deliberately.
 *
 * It is safe only because:
 *   1. the process refuses to boot with KASUWA_AUTH_MODE=stub in production
 *      (@kasuwa/config), and
 *   2. it grants NO scope of its own. It asserts an identity; the database
 *      decides what that identity reaches.
 *
 * When Agent 1 replaces this, the acceptance tests under tests/acceptance/tenancy
 * should keep passing unchanged. If they need editing, something has regressed.
 */
@Injectable()
export class StubAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    for (const header of FORBIDDEN_SCOPE_HEADERS) {
      if (request.headers[header] !== undefined) {
        throw new BadRequestException({
          ...SCOPE_HEADER_REJECTED_BODY,
          details: [...SCOPE_HEADER_REJECTED_BODY.details],
        });
      }
    }

    const parsed = StubAuthHeaders.safeParse({
      [STUB_TENANT_HEADER]: request.headers[STUB_TENANT_HEADER],
      [STUB_USER_HEADER]: request.headers[STUB_USER_HEADER],
    });

    if (!parsed.success) {
      // Deliberately uninformative: a caller probing for valid tenant ids
      // learns nothing from the difference between "missing" and "malformed".
      throw new UnauthorizedException('Not authenticated');
    }

    request[AUTH_CONTEXT_KEY] = {
      tenantId: parsed.data[STUB_TENANT_HEADER],
      userId: parsed.data[STUB_USER_HEADER],
      // No session row exists for a stubbed identity; there is nothing to
      // re-check and nothing to revoke. Another reason it must never run in
      // production.
      sessionId: null,
    };
    return true;
  }
}
