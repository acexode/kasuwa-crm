import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';
import { hasTenantContext } from '../tenancy/tenant-context';

/**
 * A response whose status the handler decides at run time: startScriptRun is
 * `201` for a new run and `200` for the caller's own run replayed (D-L91).
 *
 * Nest replies with ONE status per route (the method's default or
 * `@HttpCode`), and overwrites a status set through `@Res({ passthrough })`
 * when it replies. A handler that takes `@Res()` must send the response
 * itself; sending it from inside the handler would answer BEFORE the tenant
 * transaction commits, so a client could read a run that is not committed
 * yet. So the handler returns this, and `SendAfterCommitInterceptor` - which
 * must be listed BEFORE `TenantTransactionInterceptor`, making it the outer
 * one - sends it once the transaction has committed. An error (the handler's,
 * or a failed COMMIT) never reaches `map`: it goes to the exception filters,
 * as on every other route, and nothing is sent from here.
 */
export class SendAfterCommit<T> {
  constructor(
    readonly status: number,
    readonly body: T,
  ) {}
}

/** The interceptors were listed the wrong way round: this would answer before COMMIT. */
export class SendBeforeCommitError extends Error {
  constructor() {
    super(
      'SendAfterCommitInterceptor ran inside a tenant transaction: list it before TenantTransactionInterceptor',
    );
    this.name = 'SendBeforeCommitError';
  }
}

@Injectable()
export class SendAfterCommitInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((result: unknown) => {
        if (!(result instanceof SendAfterCommit)) return result;
        // Still inside the transaction means this interceptor is the inner
        // one: refuse loudly (the transaction rolls back, the filter answers
        // 500) rather than answer a write that has not committed.
        if (hasTenantContext()) throw new SendBeforeCommitError();
        const response = context.switchToHttp().getResponse<Response>();
        if (response.headersSent) return undefined; // never a second send
        try {
          response.status(result.status).json(result.body);
        } catch {
          // The client went away mid-send: the run is committed either way,
          // and a retry is answered by the idempotent replay. Nothing to log:
          // the body is a run, with answers.
        }
        return undefined;
      }),
    );
  }
}
