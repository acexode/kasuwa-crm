import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { UnknownSessionUserError, withTenantTransaction } from '@kasuwa/db';
import type { Pool } from 'pg';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { from } from 'rxjs';
import { PG_POOL } from '../database/database.module';
import { annotateRequestScope } from '../telemetry/request-telemetry';
import { AUTH_CONTEXT_KEY } from './stub-auth.guard';
import { runWithTx } from './tenant-context';

/**
 * Opens the request-scoped transaction and establishes the RLS session context.
 *
 * Guards run before interceptors in Nest, so the auth context is already on the
 * request by the time this runs. The handler executes inside
 * `withTenantTransaction`, which means:
 *
 *   - every query in the request shares one connection and one transaction
 *   - `SET LOCAL`-style settings cannot leak to the next user of that
 *     connection, because the transaction ends before it is returned to the pool
 *   - a thrown error rolls the whole request back
 *
 * Routes with no tenant (health) are excluded by not applying the guard or this
 * interceptor to them — see AppModule.
 */
@Injectable()
export class TenantTransactionInterceptor implements NestInterceptor {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return interceptInTenantTransaction(this.pool, context, next);
  }
}

/**
 * The whole of what `TenantTransactionInterceptor` does, on a pool the caller
 * names.
 *
 * Exported for exactly one other caller: the auth module's
 * `AuthTenantTransactionInterceptor`, which runs the signed-in user's own MFA
 * writes (`/auth/me/mfa/*`) through the same steps on the auth pool, because
 * only `kasuwa_auth` may write the factor and backup-code tables (T-0049). The
 * steps are not duplicated there on purpose: scope is still resolved by
 * `withTenantTransaction` from `user_programme`, and the session is still
 * re-read under RLS, whichever role the connection logs in as. A second copy
 * of this function would be a second place for those two checks to drift.
 */
export function interceptInTenantTransaction(
  pool: Pool,
  context: ExecutionContext,
  next: CallHandler,
): Observable<unknown> {
  const request = context.switchToHttp().getRequest<Request>();
  const auth = request[AUTH_CONTEXT_KEY];

  if (auth === undefined) {
    // Cannot happen with StubAuthGuard applied, but an interceptor that
    // silently runs without a tenant would be a hole worth closing twice.
    throw new UnauthorizedException('Not authenticated');
  }

  return from(
    withTenantTransaction(pool, auth, async (tx) =>
      runWithTx(tx, async () => {
        // The scope the database resolved — not what the caller claimed —
        // is what the request's span reports (T-0005).
        annotateRequestScope(request, tx.session);

        // Second, independent check of the session — inside the transaction,
        // under RLS, with explicit tenant and user predicates as well.
        //
        // The guard already resolved this token through
        // app.resolve_session, which is SECURITY DEFINER and therefore the
        // one read in the system that RLS does not constrain. Re-reading the
        // row here means a mistake in that function still cannot serve a
        // request: the row has to exist, belong to this tenant, belong to
        // this user, and still be live. It is also what makes revocation and
        // a disabled user bite on the NEXT request rather than at expiry.
        if (auth.sessionId !== null) {
          const live = await tx.query<{ ok: number }>(
            `SELECT 1 AS ok
               FROM auth_session
              WHERE id = $1
                AND tenant_id = $2
                AND user_id = $3
                AND revoked_at IS NULL
                AND expires_at > now()`,
            [auth.sessionId, auth.tenantId, auth.userId],
          );
          if (live.length === 0) {
            throw new UnauthorizedException('Not authenticated');
          }
        }

        try {
          // `next.handle()` is an Observable; awaiting the promise form keeps
          // the handler inside both the transaction and the ALS scope.
          return await lastValueFromCompat(next.handle());
        } catch (error) {
          if (error instanceof UnknownSessionUserError) {
            throw new UnauthorizedException('Not authenticated');
          }
          throw error;
        }
      }),
    ).catch((error: unknown) => {
      if (error instanceof UnknownSessionUserError) {
        throw new UnauthorizedException('Not authenticated');
      }
      throw error;
    }),
  );
}

/** Minimal `lastValueFrom` without pulling the operator surface of rxjs in. */
function lastValueFromCompat<T>(source: Observable<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let hasValue = false;
    let lastValue: T | undefined;
    source.subscribe({
      next: (value) => {
        hasValue = true;
        lastValue = value;
      },
      error: reject,
      complete: () => {
        if (hasValue) {
          resolve(lastValue as T);
        } else {
          resolve(undefined as T);
        }
      },
    });
  });
}
