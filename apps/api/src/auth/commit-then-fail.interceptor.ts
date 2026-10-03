import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AuthError } from './auth.errors';

/**
 * Raises an `AuthError` that a handler RETURNED, after the tenant transaction
 * has committed.
 *
 * `AuthService.commitThenFail` explains the problem for the pre-session routes:
 * a failed second factor has a side effect that must survive (the per-user
 * counter), and throwing from inside the transaction rolls that side effect
 * back, so lockout silently never fires. The session-bound MFA routes run inside
 * `TenantTransactionInterceptor`, which rolls back on a throw for exactly the
 * same reason it should everywhere else — so those handlers return the error
 * instead, and this interceptor throws it on the way out.
 *
 * ORDER IS THE WHOLE POINT. It must be listed BEFORE
 * `TenantTransactionInterceptor` in `@UseInterceptors(...)`, which makes it the
 * outer one: the inner transaction commits, then this sees the value. Listed the
 * other way round it would throw inside the transaction and undo the counter.
 *
 * Only `AuthError` is converted. Anything else a handler returns passes through
 * untouched, and anything a handler throws is still thrown — and still rolls
 * back, which is right for every failure that has nothing to record.
 */
@Injectable()
export class CommitThenFailInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return new Observable<unknown>((subscriber) => {
      const subscription = next.handle().subscribe({
        next: (value) => {
          if (value instanceof AuthError) {
            subscriber.error(value);
          } else {
            subscriber.next(value);
          }
        },
        error: (error: unknown) => subscriber.error(error),
        complete: () => subscriber.complete(),
      });
      return () => subscription.unsubscribe();
    });
  }
}
