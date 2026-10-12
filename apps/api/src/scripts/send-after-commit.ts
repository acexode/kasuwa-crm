import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';

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
 * one - sends it once the transaction has committed. An error never reaches
 * here: it goes to the exception filters, as on every other route.
 */
export class SendAfterCommit<T> {
  constructor(
    readonly status: number,
    readonly body: T,
  ) {}
}

@Injectable()
export class SendAfterCommitInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((result: unknown) => {
        if (!(result instanceof SendAfterCommit)) return result;
        context.switchToHttp().getResponse<Response>().status(result.status).json(result.body);
        return undefined;
      }),
    );
  }
}
