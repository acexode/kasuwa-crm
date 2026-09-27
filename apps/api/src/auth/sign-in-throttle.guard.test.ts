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
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guardWith(overrides: Partial<AuthPolicy> = {}): SignInThrottleGuard {
  return new SignInThrottleGuard({ ...DEFAULT_AUTH_POLICY, ...overrides });
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
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    expect(guard.canActivate(context)).toBe(true);
    request.headers['x-forwarded-for'] = '198.51.100.21';
    expect(() => guard.canActivate(context)).toThrow(AuthError);
  });

  it('is off when the limit is zero, and says so by allowing everything', () => {
    const guard = guardWith({ signInPerMinutePerClient: 0 });
    const context = contextFor('203.0.113.10');
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(guard.canActivate(context)).toBe(true);
    }
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
