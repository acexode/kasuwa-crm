import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { notAuthenticated } from '../../auth/auth.errors';

/**
 * Gives the admin API's 401 the body its contract promises.
 *
 * docs/api/admin.openapi.yaml's `NotAuthenticated` response is the shared
 * `Error` envelope with `code: not_authenticated`. The stub guard and the
 * tenant interceptor throw a bare `UnauthorizedException`, whose body has no
 * `code` - and a client told to "switch on code" then has nothing to switch on.
 *
 * Applied per controller with `@UseFilters`, NOT globally: changing what every
 * existing route returns on a 401 is auth's decision, not the admin API's. A
 * controller-scoped filter is consulted before the global ones and only for its
 * own routes, so contacts, auth and health are untouched.
 *
 * Every 401 becomes the same body. That is the point rather than a loss of
 * detail: the contract's 401 is deliberately uninformative (CLAUDE.md 6.4).
 * An `AuthError` already carries a code and is not an `UnauthorizedException`,
 * so it never reaches this filter.
 */
@Catch(UnauthorizedException)
export class AdminNotAuthenticatedFilter implements ExceptionFilter {
  catch(_exception: UnauthorizedException, host: ArgumentsHost): void {
    const error = notAuthenticated();
    host.switchToHttp().getResponse<Response>().status(error.getStatus()).json(error.getResponse());
  }
}
