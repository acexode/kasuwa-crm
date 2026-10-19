import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AUTH_CONTEXT_KEY } from '../tenancy/stub-auth.guard';
import {
  NOTIFICATION_LIMITS,
  NOTIFICATION_WINDOW_MS,
  NotificationThrottleGuard,
  NotificationsTooManyRequests,
  retryAfterSeconds,
  type NotificationOperation,
} from './notification-throttle.guard';

const USER_A = 'tenant-a:user-1';
const USER_B = 'tenant-a:user-2';

function exhaust(guard: NotificationThrottleGuard, operation: NotificationOperation): void {
  for (let n = 0; n < NOTIFICATION_LIMITS[operation]; n += 1) guard.admit(operation, USER_A, 1_000);
}

describe('NotificationThrottleGuard (T-0100 N-R8, D-L134)', () => {
  it('keeps the list and the count inside the suite bounds, 60..600', () => {
    for (const operation of ['listNotifications', 'getNotificationUnreadCount'] as const) {
      expect(NOTIFICATION_LIMITS[operation]).toBeGreaterThanOrEqual(60);
      expect(NOTIFICATION_LIMITS[operation]).toBeLessThanOrEqual(600);
    }
  });

  it('admits exactly the limit in a window, then refuses with the window\'s end', () => {
    const guard = new NotificationThrottleGuard(new Reflector());
    exhaust(guard, 'listNotifications');
    expect(guard.admit('listNotifications', USER_A, 1_000)).toBe(1_000 + NOTIFICATION_WINDOW_MS);
  });

  it('is per user and per operation', () => {
    const guard = new NotificationThrottleGuard(new Reflector());
    exhaust(guard, 'getNotificationUnreadCount');
    expect(guard.admit('getNotificationUnreadCount', USER_A, 1_000)).not.toBeNull();
    expect(guard.admit('getNotificationUnreadCount', USER_B, 1_000)).toBeNull();
    expect(guard.admit('listNotifications', USER_A, 1_000)).toBeNull();
  });

  it('opens a fresh window once the old one ends, and clear() forgets every counter', () => {
    const guard = new NotificationThrottleGuard(new Reflector());
    exhaust(guard, 'markAllNotificationsRead');
    expect(guard.admit('markAllNotificationsRead', USER_A, 1_000 + NOTIFICATION_WINDOW_MS)).toBeNull();
    exhaust(guard, 'updateNotification');
    guard.clear();
    expect(guard.admit('updateNotification', USER_A, 1_000)).toBeNull();
  });

  it('Retry-After is whole seconds, at least 1', () => {
    expect(retryAfterSeconds(10_000, 9_999)).toBe(1);
    expect(retryAfterSeconds(10_000, 10_000)).toBe(1);
    expect(retryAfterSeconds(70_000, 10_001)).toBe(60);
  });

  it('the 429 body is the shared envelope and says nothing about any record', () => {
    const error = new NotificationsTooManyRequests();
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      code: 'too_many_requests',
      message: 'Too many requests. Wait a moment and try again.',
    });
  });

  it('canActivate sets an integer Retry-After and throws once the budget is spent', () => {
    const guard = new NotificationThrottleGuard({
      get: () => 'getNotificationUnreadCount',
    } as unknown as Reflector);
    const headers: Record<string, string> = {};
    const context = (auth: unknown): ExecutionContext =>
      ({
        getHandler: () => () => undefined,
        switchToHttp: () => ({
          getRequest: () => ({ [AUTH_CONTEXT_KEY]: auth }),
          getResponse: () => ({
            setHeader: (name: string, value: string) => {
              headers[name] = value;
            },
          }),
        }),
      }) as unknown as ExecutionContext;
    const caller = { tenantId: 'tenant-z', userId: 'user-z' };
    for (let n = 0; n < NOTIFICATION_LIMITS.getNotificationUnreadCount; n += 1) {
      expect(guard.canActivate(context(caller))).toBe(true);
    }
    expect(() => guard.canActivate(context(caller))).toThrow(NotificationsTooManyRequests);
    expect(headers['Retry-After']).toMatch(/^[1-9][0-9]*$/u);
  });

  it('fails closed on a handler with no budget, and when nobody authenticated', () => {
    const guard = new NotificationThrottleGuard({
      get: () => 'getNotificationUnreadCount',
    } as unknown as Reflector);
    const context = (auth: unknown): ExecutionContext =>
      ({
        getHandler: () => () => undefined,
        switchToHttp: () => ({ getRequest: () => ({ [AUTH_CONTEXT_KEY]: auth }), getResponse: () => ({}) }),
      }) as unknown as ExecutionContext;
    expect(() => guard.canActivate(context(undefined))).toThrow(/before authentication/u);
    const noBudget = new NotificationThrottleGuard({ get: () => undefined } as unknown as Reflector);
    expect(() => noBudget.canActivate(context({ tenantId: 't', userId: 'u' }))).toThrow(
      /without @NotificationBudget/u,
    );
  });
});
