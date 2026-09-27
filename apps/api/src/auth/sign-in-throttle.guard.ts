import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthError } from './auth.errors';
import { AUTH_POLICY, type AuthPolicy } from './auth.policy';

/**
 * A per-client cap on how often the expensive sign-in routes may be called.
 *
 * **This is a resource control, not a credential control.** Guessing passwords
 * is bounded by the identifier lockout in `AuthService`, which counts the
 * workspace and address and therefore works no matter where the requests come
 * from. This guard exists for the other attack: argon2id costs 19 MiB per call
 * and Kasuwa runs it for addresses and workspaces that do not exist as well,
 * because equalising the timing means doing the work either way. A few hundred
 * concurrent sign-ins cost gigabytes of resident memory and take the API down
 * for **every tenant in the cell**, and varying the email each time means the
 * identifier lockout is never even approached.
 *
 * It is one of two bounds, and the weaker one. The other is the concurrency cap
 * inside `@kasuwa/auth-crypto`, which caps memory absolutely regardless of how
 * many requests arrive. This one keeps the queue in front of that cap from
 * growing without bound.
 *
 * ## Two honest limitations
 *
 * **It counts the socket peer, not `X-Forwarded-For`.** Trusting a forwarded
 * header that nothing in this repository sets or strips would make the limit
 * bypassable by typing a different value, which is worse than no limit because
 * it looks like one. Behind a load balancer this therefore throttles the
 * balancer, and the limit needs raising and a trusted-proxy configuration
 * added. Nothing in the repository establishes that such a proxy exists, which
 * is exactly why the application does not assume one.
 *
 * **The counter is per process.** With several API instances the effective
 * limit is the configured number times the instance count. A shared counter
 * belongs in Redis, and that is worth doing when there is more than one
 * instance; it is not worth pretending to have now.
 */
@Injectable()
export class SignInThrottleGuard implements CanActivate {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(@Inject(AUTH_POLICY) private readonly policy: AuthPolicy) {}

  canActivate(context: ExecutionContext): boolean {
    const limit = this.policy.signInPerMinutePerClient;
    if (limit <= 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const client = clientKey(request);
    const now = Date.now();

    this.evictExpired(now);

    const window = this.windows.get(client);
    if (window === undefined || window.resetAt <= now) {
      this.windows.set(client, { count: 1, resetAt: now + 60_000 });
      return true;
    }

    window.count += 1;
    if (window.count > limit) {
      throw new AuthError(
        HttpStatus.TOO_MANY_REQUESTS,
        'too_many_requests',
        'Too many attempts from this device. Wait a moment and try again.',
        { retryAt: new Date(window.resetAt).toISOString(), timeZone: this.policy.cellTimeZone },
      );
    }
    return true;
  }

  /**
   * Forgets every counter.
   *
   * A real seam, not a test hatch. The counter is a sixty-second in-process
   * window, so the only way to give a caller their allowance back early — after
   * a bad deploy, or a misconfigured limit that is locking staff out — is to
   * clear it; there is nothing to edit in a database.
   *
   * The integration suite uses it between tests. That is deliberate and it is
   * NOT the same as turning the throttle off: the suite runs with the real
   * default limit, and each test gets a clean window instead of inheriting the
   * previous one's. Tests that shared a counter failed in a different
   * combination on every run, which is how a flaky suite teaches people to
   * re-run rather than read.
   */
  clear(): void {
    this.windows.clear();
  }

  /**
   * Keeps the map from being its own memory-exhaustion vector: an attacker
   * cycling source addresses would otherwise add an entry per address and never
   * remove one.
   */
  private evictExpired(now: number): void {
    if (this.windows.size < 10_000) {
      return;
    }
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) {
        this.windows.delete(key);
      }
    }
  }
}

function clientKey(request: Request): string {
  return request.socket.remoteAddress ?? 'unknown';
}
