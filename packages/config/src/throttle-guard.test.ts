import { describe, expect, it } from 'vitest';
import { assertThrottleIsNotACellWideCliff } from './index';

/**
 * The boot guard that stops the sign-in throttle becoming a cell-wide outage.
 *
 * `SignInThrottleGuard` keys on the socket peer. Behind a load balancer that is
 * one bucket for every tenant on the cell, so a sixty-a-minute limit refuses
 * the sixty-first legitimate sign-in and logs nothing that explains why.
 *
 * The guard's source comment always said so. The point of this check — and of
 * these tests — is that a comment in a source file is not a deployment control.
 */

const base = {
  NODE_ENV: 'production' as const,
  KASUWA_TRUST_PROXY_HOPS: 0,
  KASUWA_AUTH_SIGN_IN_PER_MINUTE: 60,
};

describe('assertThrottleIsNotACellWideCliff', () => {
  it('refuses to start on the combination that produces the outage', () => {
    expect(() => assertThrottleIsNotACellWideCliff(base)).toThrow(/Refusing to start/u);
    // The message has to name both ways out, or it is just an obstacle.
    expect(() => assertThrottleIsNotACellWideCliff(base)).toThrow(/KASUWA_TRUST_PROXY_HOPS/u);
  });

  it('is satisfied by telling it about the proxy', () => {
    expect(() =>
      assertThrottleIsNotACellWideCliff({ ...base, KASUWA_TRUST_PROXY_HOPS: 1 }),
    ).not.toThrow();
  });

  it('is satisfied by sizing the limit like the global cap it would be', () => {
    expect(() =>
      assertThrottleIsNotACellWideCliff({ ...base, KASUWA_AUTH_SIGN_IN_PER_MINUTE: 600 }),
    ).not.toThrow();
  });

  it('leaves an explicit opt-out alone', () => {
    // 0 means "no throttle", which is a deliberate choice and a different
    // conversation. This check is about a limit that looks per-client and is
    // not, so it has nothing to say here.
    expect(() =>
      assertThrottleIsNotACellWideCliff({ ...base, KASUWA_AUTH_SIGN_IN_PER_MINUTE: 0 }),
    ).not.toThrow();
  });

  it('does not get in the way outside production', () => {
    // Development and test run without a proxy on purpose, and the integration
    // suite deliberately drives the throttle at low limits.
    for (const NODE_ENV of ['development', 'test'] as const) {
      expect(() => assertThrottleIsNotACellWideCliff({ ...base, NODE_ENV })).not.toThrow();
    }
  });
});
