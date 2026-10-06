import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Observable } from 'rxjs';
import { interceptInTenantTransaction } from '../tenancy/tenant-transaction.interceptor';
import { AUTH_PG_POOL } from './auth-database.module';

/**
 * `TenantTransactionInterceptor`, on the auth pool (T-0049).
 *
 * For the signed-in user's own second-factor WRITES only: replacing the TOTP
 * factor and regenerating backup codes (`POST /auth/me/mfa/*`). Since migration
 * 0024 those tables are writable by `kasuwa_auth` alone, so these routes'
 * request transaction has to run as that role.
 *
 * Nothing about the transaction changes but the role. The same function runs
 * it: `withTenantTransaction` resolves scope from `user_programme`, the session
 * row is re-read under RLS, a thrown error rolls back, and
 * `CommitThenFailInterceptor` still sits OUTSIDE this one so a wrong step-up
 * code is counted. Authentication still decides only WHO: the programme ids
 * resolved here are never read by the MFA service and never leave the server.
 *
 * Every other authenticated route, including `GET /auth/me` and
 * `GET /auth/me/mfa` (reads), stays on `TenantTransactionInterceptor` and
 * `kasuwa_app`.
 */
@Injectable()
export class AuthTenantTransactionInterceptor implements NestInterceptor {
  constructor(@Inject(AUTH_PG_POOL) private readonly pool: Pool) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return interceptInTenantTransaction(this.pool, context, next);
  }
}
