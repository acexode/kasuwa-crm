import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
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
 * ## Who the client is
 *
 * `KASUWA_TRUST_PROXY_HOPS` decides. At 0 — the default — the socket peer is
 * the client, and `X-Forwarded-For` is ignored entirely: trusting a header that
 * nothing here sets or strips would let a caller pick their own bucket by
 * typing an address, which is worse than no limit because it looks like one. At
 * N, the Nth-from-last entry of `X-Forwarded-For` is the client and the N
 * entries nearer to us are our own infrastructure's.
 *
 * Getting this wrong in the safe direction is still an outage: behind a
 * balancer with 0 hops, the whole cell shares one bucket and the sixty-first
 * legitimate sign-in in a minute is refused. That is no longer left to a
 * comment — `assertThrottleIsNotACellWideCliff` in `@kasuwa/config` refuses to
 * boot in production with 0 hops and a low limit, because a source comment is
 * not a deployment control.
 *
 * ## One honest limitation that remains
 *
 * **The counter is per process.** With several API instances the effective
 * limit is the configured number times the instance count. A shared counter
 * belongs in Redis, and that is worth doing when there is more than one
 * instance; it is not worth pretending to have now.
 */
/**
 * Where the resolved client key is remembered for the life of the request.
 *
 * On the request itself rather than in a map keyed by request: a map would need
 * its own eviction policy and would be one more thing able to leak.
 */
const THROTTLE_CLIENT_KEY = 'kasuwaThrottleClient';

declare module 'express' {
  interface Request {
    [THROTTLE_CLIENT_KEY]?: string;
  }
}

@Injectable()
export class SignInThrottleGuard implements CanActivate {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly inFlight = new Map<string, number>();

  constructor(@Inject(AUTH_POLICY) private readonly policy: AuthPolicy) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const client = this.clientFor(request);

    // TWO LIMITS, AND THE SECOND ONE IS THE REASON THIS CLASS EXISTS AT ALL.
    //
    // A per-minute count does not bound concurrency. One address may spend its
    // whole minute's allowance inside the same second, perfectly within the
    // rule, and each of those requests occupies a pooled database connection
    // and an argon2 slot for the duration. A handful of addresses doing that
    // sustains it indefinitely and the cell stops serving anyone — which is
    // precisely the finding this pair of limits answers.
    //
    // So: how OFTEN, and how MANY AT ONCE. The second is checked first, because
    // it is the cheaper refusal and the one that matters under a flood.
    this.admitInFlight(client);
    this.releaseWhenFinished(context, client);
    // Record what this request was admitted UNDER, so the release cannot pick a
    // different key later. `clientKey` reads `socket.remoteAddress`, which is
    // `undefined` once the socket has closed — and the release runs at the end
    // of the request, exactly when a client that hung up has already gone. The
    // release would then hand a slot back under `'unknown'` while the admit
    // took one under the real address, leaking a slot per request until that
    // client could not sign in again for the life of the process.
    request[THROTTLE_CLIENT_KEY] = client;

    const limit = this.policy.signInPerMinutePerClient;
    if (limit <= 0) {
      return true;
    }

    const now = Date.now();

    this.sweep(now);

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
   * Takes one of this client's concurrent slots, or refuses.
   *
   * Paired with `releaseInFlight`, which `SignInThrottleInterceptor` calls when
   * the response finishes — however it finishes. A slot that is taken and never
   * given back is a client locked out until the process restarts, so the
   * release lives in a `finalize` and not at the end of a happy path.
   */
  admitInFlight(client: string): void {
    const limit = this.policy.signInInFlightPerClient;
    if (limit <= 0) {
      return;
    }

    const current = this.inFlight.get(client) ?? 0;
    if (current >= limit) {
      throw new AuthError(
        HttpStatus.TOO_MANY_REQUESTS,
        'too_many_requests',
        'Too many sign-in attempts are already in progress from this device.',
        { timeZone: this.policy.cellTimeZone },
      );
    }
    this.inFlight.set(client, current + 1);
  }

  /**
   * Gives the slot back when the response ends, however it ends.
   *
   * This used to be a separate interceptor, and the seam between the two
   * halves was where the bug lived: the interceptor's `finalize` ran, but the
   * pair only worked if both halves agreed on the client key and on the
   * instance holding the map, and in the assembled application they did not.
   * Every sign-in leaked a slot, and the fifth request from a client behaving
   * perfectly was refused with a message about requests already in progress
   * when there were none. Both halves had passing tests.
   *
   * So there is no longer a second half. The guard that takes the slot
   * registers the release itself, on the response it was given, under the key
   * it just used. Nothing to wire, nothing to forget on a new route, and no
   * way for the two to disagree.
   *
   * `close` rather than `finish`: it fires when the response completes AND
   * when the client hangs up mid-request. Hanging up early is free for an
   * attacker, and on `finish` alone it would leak a slot every time.
   */
  private releaseWhenFinished(context: ExecutionContext, client: string): void {
    const response = context.switchToHttp().getResponse<Response>();
    if (typeof response?.once !== 'function') {
      // No response object — a unit test calling the guard directly. Nothing
      // to hook, and nothing that would have been released anyway.
      return;
    }
    response.once('close', () => {
      this.releaseInFlight(client);
    });
  }

  /**
   * What this guard currently believes is in flight, by client key.
   *
   * A diagnostic, and a deliberate one: an in-flight counter that drifts is
   * invisible until a well-behaved client is refused, and "it returned 429"
   * does not say whether the cap worked or the bookkeeping leaked.
   */
  inFlightSnapshot(): Record<string, number> {
    return Object.fromEntries(this.inFlight);
  }

  /** Gives a concurrent slot back. Safe to call for a request never admitted. */
  releaseInFlight(client: string): void {
    const current = this.inFlight.get(client);
    if (current === undefined) {
      return;
    }
    if (current <= 1) {
      // Delete rather than leave a zero behind: the map would otherwise grow
      // one entry per address seen and never shrink, which is the same
      // unbounded-growth problem `sweep` exists to prevent for the other map.
      this.inFlight.delete(client);
      return;
    }
    this.inFlight.set(client, current - 1);
  }

  /**
   * Who this request counts against. Shared with the interceptor.
   *
   * The answer is computed ONCE and remembered on the request. Re-deriving it
   * at release time was a real bug and a subtle one: the interceptor's
   * `finalize` runs after the response has been written, by which point the
   * socket can already be destroyed and `request.socket.remoteAddress` is
   * empty. The release then decremented a different bucket from the one the
   * admission incremented, so **every sign-in leaked a concurrent slot** and a
   * client was refused after four of them — permanently, and with a message
   * about requests already in progress when there were none.
   *
   * It survived the guard's unit tests, which call admit and release with the
   * same string by hand, and the concurrency integration test, which never
   * releases. The acceptance suite caught it on the fifth sign-in.
   */
  clientFor(request: Request): string {
    const remembered = request[THROTTLE_CLIENT_KEY];
    if (remembered !== undefined) {
      return remembered;
    }
    const resolved = clientKey(request, this.policy.trustProxyHops);
    request[THROTTLE_CLIENT_KEY] = resolved;
    return resolved;
  }

  /** Test and diagnostic hook: concurrent sign-ins per client, right now. */
  inFlightCount(client: string): number {
    return this.inFlight.get(client) ?? 0;
  }

  /**
   * Every client currently holding a slot, and how many.
   *
   * A diagnostic, and the one an operator actually wants: "is anything stuck?"
   * is a question about the whole map, not about a key you already guessed. It
   * is also how the integration suite proves slots come back, since a test
   * cannot know which source address the kernel gave its own socket.
   */
  inFlightTotal(): number {
    let total = 0;
    for (const count of this.inFlight.values()) {
      total += count;
    }
    return total;
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
    this.inFlight.clear();
  }

  /**
   * Keeps the map from being its own denial-of-service vector.
   *
   * Two ways it could be one, and both are closed here.
   *
   * Unbounded growth: a source cycling addresses — an IPv6 /64 gives 2^64 of
   * them — would otherwise add an entry per address and never remove one.
   *
   * And the sweep itself: the first version scanned the WHOLE map on every
   * request once it passed ten thousand entries, so an attacker who kept it
   * above that line turned each request into a full scan on the same event loop
   * that argon2 is already blocking. Amortised is not enough when the trigger
   * is attacker-controlled.
   *
   * So: sweep a bounded slice per request, and hard-cap the map by evicting the
   * oldest windows when it is over size. Evicting a live window only gives that
   * client a fresh allowance, which is the safe direction to fail — this is a
   * resource control, and the credential control is the lockout, which lives in
   * the database and cannot be evicted.
   */
  private sweep(now: number): void {
    if (this.windows.size < SWEEP_THRESHOLD) {
      return;
    }

    let examined = 0;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) {
        this.windows.delete(key);
      }
      examined += 1;
      if (examined >= SWEEP_SLICE) {
        break;
      }
    }

    // Map iteration is insertion-ordered, so the front is the oldest.
    while (this.windows.size > MAX_TRACKED_CLIENTS) {
      const oldest = this.windows.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.windows.delete(oldest.value);
    }
  }
}

/** Start sweeping once the map is this big. */
const SWEEP_THRESHOLD = 1_000;
/** Entries examined per request. Bounded work, whatever an attacker does. */
const SWEEP_SLICE = 50;
/** Hard ceiling. Roughly a few megabytes of small objects. */
const MAX_TRACKED_CLIENTS = 50_000;

/**
 * Who to count this request against.
 *
 * With `hops` at 0 the socket peer is the client and the forwarded header is
 * not read at all. With `hops` at N the client is the Nth entry counted from
 * the RIGHT of `X-Forwarded-For`, because each proxy appends the address it saw
 * — so the rightmost entries are the ones our own infrastructure added and can
 * be believed, and anything to the left was supplied by the caller.
 *
 * If the header is missing or too short for the configured hop count, this
 * falls back to the socket peer rather than to an attacker-supplied value. A
 * misconfiguration should over-throttle, never under-throttle.
 */
export function clientKey(request: Request, hops: number): string {
  // An empty string, not just `undefined`. A destroyed or unusual socket
  // reports `''`, and `?? 'unknown'` does not catch it — every such request
  // would then share the one empty-string bucket, which is either a shared
  // allowance between unrelated callers or a single caller able to exhaust it
  // for all of them. Neither is a limit.
  const peer = request.socket.remoteAddress;
  const fallback = peer === undefined || peer.length === 0 ? 'unknown' : peer;
  if (hops <= 0) {
    return fallback;
  }

  const header = request.headers['x-forwarded-for'];
  const chain = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const candidate = chain[chain.length - hops];
  return candidate ?? fallback;
}
