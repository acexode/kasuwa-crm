import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { finalize } from 'rxjs';
import { SignInThrottleGuard } from './sign-in-throttle.guard';

/**
 * Gives back the concurrent slot `SignInThrottleGuard` took.
 *
 * The two halves are split because Nest splits them: a guard can refuse a
 * request but is never told when it finished, and a cap on how many sign-ins
 * one client may have IN FLIGHT is meaningless without the second half. That
 * cap bounds a different thing from the per-minute count — a client may spend a
 * whole minute's allowance inside one second, and each of those requests holds
 * an argon2 slot while it runs.
 *
 * A slot taken and never returned is a client refused for the life of the
 * process, which would be a worse bug than the flood the cap exists to stop. So
 * the release is in `finalize` rather than at the end of a happy path: it runs
 * on success, on a thrown error, and on a client that disconnects mid-request.
 * The last one is the case that matters, because hanging up early is free for
 * an attacker and would otherwise leak a slot per attempt.
 *
 * It asks the guard which client this request was admitted under rather than
 * working it out again. `clientKey` reads `socket.remoteAddress`, which is
 * `undefined` once the socket has closed — and this code runs at the END of the
 * request, exactly when a client that hung up has already gone. Recomputing
 * would return the slot under a different key from the one that took it, which
 * leaks a slot every time while looking perfectly correct.
 */
@Injectable()
export class SignInThrottleInterceptor implements NestInterceptor {
  constructor(@Inject(SignInThrottleGuard) private readonly throttle: SignInThrottleGuard) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const client = this.throttle.clientFor(request);
    return next.handle().pipe(finalize(() => this.throttle.releaseInFlight(client)));
  }
}
