import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTH_POLICY } from './auth.policy';
import { SignInThrottleGuard } from './sign-in-throttle.guard';
import { SignInThrottleInterceptor } from './sign-in-throttle.interceptor';

/**
 * The release half of the in-flight cap.
 *
 * A slot that is taken and never given back locks a client out of signing in
 * for the life of the process, so this is the half that must not be wrong. It
 * has to fire on success, on a handler that throws, and on a client that hangs
 * up — the last one being free for an attacker and therefore the one that would
 * be exploited.
 */
function contextFor(request: object): ExecutionContext {
  // `getResponse` as well as `getRequest`: the guard hooks the response
  // lifecycle to give a slot back, and a context stub without one would test a
  // shape the application never produces.
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => undefined }),
  } as unknown as ExecutionContext;
}

describe('SignInThrottleInterceptor', () => {
  const setUp = () => {
    const guard = new SignInThrottleGuard({
      ...DEFAULT_AUTH_POLICY,
      signInPerMinutePerClient: 0,
      signInInFlightPerClient: 1,
    });
    const interceptor = new SignInThrottleInterceptor(guard);
    const request = { socket: { remoteAddress: '203.0.113.10' }, headers: {} };
    return { guard, interceptor, request };
  };

  it('releases the slot when the handler succeeds', async () => {
    const { guard, interceptor, request } = setUp();
    guard.canActivate(contextFor(request));
    expect(guard.inFlightCount('203.0.113.10')).toBe(1);

    const handler: CallHandler = { handle: () => of('ok') };
    await new Promise<void>((resolve) => {
      interceptor.intercept(contextFor(request), handler).subscribe({ complete: resolve });
    });

    expect(guard.inFlightCount('203.0.113.10')).toBe(0);
  });

  it('releases the slot when the handler throws', async () => {
    const { guard, interceptor, request } = setUp();
    guard.canActivate(contextFor(request));

    const handler: CallHandler = { handle: () => throwError(() => new Error('boom')) };
    await new Promise<void>((resolve) => {
      interceptor.intercept(contextFor(request), handler).subscribe({ error: () => resolve() });
    });

    expect(guard.inFlightCount('203.0.113.10')).toBe(0);
  });

  it('releases the slot when the caller unsubscribes, as a disconnect does', async () => {
    const { guard, interceptor, request } = setUp();
    guard.canActivate(contextFor(request));

    const handler: CallHandler = { handle: () => new Promise(() => undefined) as never };
    const subscription = interceptor
      .intercept(contextFor(request), { handle: () => of('slow') } as CallHandler)
      .subscribe();
    subscription.unsubscribe();
    void handler;

    expect(guard.inFlightCount('203.0.113.10')).toBe(0);
  });

  it('does nothing for a request that was never admitted', () => {
    const { guard, interceptor } = setUp();
    const stranger = { socket: { remoteAddress: '198.51.100.20' }, headers: {} };
    interceptor.intercept(contextFor(stranger), { handle: () => of('ok') }).subscribe();
    expect(guard.inFlightCount('198.51.100.20')).toBe(0);
  });
});
