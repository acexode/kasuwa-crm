import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AuthError } from './auth.errors';
import { DEFAULT_AUTH_POLICY, type AuthPolicy } from './auth.policy';
import { SignInThrottleGuard } from './sign-in-throttle.guard';

/**
 * The per-client sign-in throttle.
 *
 * The integration suite proves it fires against the real app. These prove the
 * two properties that suite cannot reach, because every supertest request
 * arrives from the same loopback address: that the counter is keyed per client
 * at all, and that one client exhausting its allowance does not touch another.
 * A limiter with a bug in its key is a global outage that only shows up under
 * load, and "it returned 429 when I hammered it" does not distinguish the two.
 */

function contextFor(remoteAddress: string | undefined): ExecutionContext {
  const request = { socket: { remoteAddress }, headers: {} };
  // `getResponse` as well as `getRequest`: the guard hooks the response
  // lifecycle to give a slot back, and a context stub without one would test a
  // shape the application never produces.
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => undefined }),
  } as unknown as ExecutionContext;
}

/**
 * A guard with the in-flight cap off unless a test asks for it.
 *
 * The two limits are independent and each test should fail for its own reason:
 * a per-minute test that trips the concurrency cap instead tells you nothing
 * about the per-minute counter.
 */
function guardWith(overrides: Partial<AuthPolicy> = {}): SignInThrottleGuard {
  return new SignInThrottleGuard({
    ...DEFAULT_AUTH_POLICY,
    signInInFlightPerClient: 0,
    ...overrides,
  });
}

describe('SignInThrottleGuard', () => {
  it('allows requests up to the limit and refuses the next one', () => {
    const guard = guardWith({ signInPerMinutePerClient: 3 });
    const context = contextFor('203.0.113.10');

    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
    expect(() => guard.canActivate(context)).toThrow(AuthError);
  });

  it('answers a refusal with 429 and a retry time the client can act on', () => {
    const guard = guardWith({ signInPerMinutePerClient: 1 });
    const context = contextFor('203.0.113.10');
    guard.canActivate(context);

    try {
      guard.canActivate(context);
      expect.unreachable('the second request should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      const body = (error as AuthError).getResponse() as Record<string, unknown>;
      expect((error as AuthError).getStatus()).toBe(429);
      expect(body.code).toBe('too_many_requests');
      expect(body.retryAt).toEqual(expect.any(String));
      expect(body.timeZone).toBe(DEFAULT_AUTH_POLICY.cellTimeZone);
    }
  });

  it('counts each client separately, so one flood cannot lock everybody out', () => {
    // The failure this catches is a limiter keyed on nothing — a single shared
    // counter answers 429 under load and looks exactly like a working one
    // until it takes the whole cell down.
    const guard = guardWith({ signInPerMinutePerClient: 2 });
    const noisy = contextFor('203.0.113.10');
    const quiet = contextFor('198.51.100.20');

    guard.canActivate(noisy);
    guard.canActivate(noisy);
    expect(() => guard.canActivate(noisy)).toThrow(AuthError);

    // A different address is untouched and still has its full allowance.
    expect(guard.canActivate(quiet)).toBe(true);
    expect(guard.canActivate(quiet)).toBe(true);
    expect(() => guard.canActivate(quiet)).toThrow(AuthError);
  });

  it('does not let a client escape the limit by omitting an address', () => {
    // A socket with no remote address must fall into one bucket, not a fresh
    // one each time.
    const guard = guardWith({ signInPerMinutePerClient: 1 });
    expect(guard.canActivate(contextFor(undefined))).toBe(true);
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(AuthError);
  });

  it('ignores a forwarded-for header, which anyone can type', () => {
    // Trusting X-Forwarded-For with no configured trusted proxy would make the
    // limit bypassable by setting a header, which is worse than no limit
    // because it looks like one.
    const guard = guardWith({ signInPerMinutePerClient: 1 });
    const request = {
      socket: { remoteAddress: '203.0.113.10' },
      headers: { 'x-forwarded-for': '198.51.100.20' },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => undefined }),
    } as unknown as ExecutionContext;

    expect(guard.canActivate(context)).toBe(true);
    request.headers['x-forwarded-for'] = '198.51.100.21';
    expect(() => guard.canActivate(context)).toThrow(AuthError);
  });

  it('is off only when BOTH limits are zero', () => {
    // Two independent controls, two independent switches. Zeroing the
    // per-minute count alone leaves the in-flight cap doing its job, which is
    // the right behaviour and is worth pinning down: they bound different
    // things and turning one off must not quietly turn the other off too.
    const guard = guardWith({ signInPerMinutePerClient: 0, signInInFlightPerClient: 0 });
    const context = contextFor('203.0.113.10');
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(guard.canActivate(context)).toBe(true);
    }

    const perMinuteOffOnly = guardWith({
      signInPerMinutePerClient: 0,
      signInInFlightPerClient: DEFAULT_AUTH_POLICY.signInInFlightPerClient,
    });
    for (let attempt = 0; attempt < DEFAULT_AUTH_POLICY.signInInFlightPerClient; attempt += 1) {
      expect(perMinuteOffOnly.canActivate(context)).toBe(true);
    }
    expect(() => perMinuteOffOnly.canActivate(context)).toThrow(AuthError);
  });

  it('caps how many sign-ins one client may have in flight at once', () => {
    // The per-minute count does not bound concurrency: a client may spend its
    // whole allowance inside one second, and each of those requests holds an
    // argon2 slot and a pooled connection while it runs. This is the limit that
    // stops a handful of addresses keeping the cell's hashing queue full.
    const guard = guardWith({ signInInFlightPerClient: 2, signInPerMinutePerClient: 0 });
    const context = contextFor('203.0.113.10');

    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
    expect(() => guard.canActivate(context)).toThrow(AuthError);
    expect(guard.inFlightCount('203.0.113.10')).toBe(2);
  });

  it('gives an in-flight slot back when the request finishes', () => {
    const guard = guardWith({ signInInFlightPerClient: 1, signInPerMinutePerClient: 0 });
    const context = contextFor('203.0.113.10');

    expect(guard.canActivate(context)).toBe(true);
    expect(() => guard.canActivate(context)).toThrow(AuthError);

    guard.releaseInFlight('203.0.113.10');
    expect(guard.inFlightCount('203.0.113.10')).toBe(0);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('counts in-flight sign-ins per client, not globally', () => {
    const guard = guardWith({ signInInFlightPerClient: 1, signInPerMinutePerClient: 0 });
    expect(guard.canActivate(contextFor('203.0.113.10'))).toBe(true);
    // A second address is unaffected by the first one saturating its own cap.
    expect(guard.canActivate(contextFor('198.51.100.20'))).toBe(true);
  });

  it('forgets a client entirely once its last request finishes', () => {
    // Otherwise the map grows one entry per address seen and never shrinks,
    // which is the same unbounded-growth problem the window sweep exists for.
    const guard = guardWith({ signInInFlightPerClient: 2, signInPerMinutePerClient: 0 });
    guard.canActivate(contextFor('203.0.113.10'));
    guard.releaseInFlight('203.0.113.10');
    expect(guard.inFlightCount('203.0.113.10')).toBe(0);
    // Releasing again must not underflow into a negative allowance.
    guard.releaseInFlight('203.0.113.10');
    expect(guard.inFlightCount('203.0.113.10')).toBe(0);
  });

  it('gives an allowance back when cleared', () => {
    const guard = guardWith({ signInPerMinutePerClient: 1 });
    const context = contextFor('203.0.113.10');

    guard.canActivate(context);
    expect(() => guard.canActivate(context)).toThrow(AuthError);

    guard.clear();
    expect(guard.canActivate(context)).toBe(true);
  });
});
