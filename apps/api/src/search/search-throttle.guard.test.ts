import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import {
  SEARCH_LIMITS,
  SEARCH_WINDOW_MS,
  SearchThrottleGuard,
  SearchTooManyRequests,
} from './search-throttle.guard';

const USER_A = 'tenant-a:user-1';
const USER_B = 'tenant-a:user-2';

function exhaust(guard: SearchThrottleGuard, operation: 'searchRecords' | 'lookupRecords') {
  for (let n = 0; n < SEARCH_LIMITS[operation]; n += 1) guard.admit(operation, USER_A, 1_000);
}

describe('SearchThrottleGuard (T-0086 R18, D-L134)', () => {
  it('keeps the lookup budget tighter than the search budget, both inside the suite bounds', () => {
    expect(SEARCH_LIMITS.searchRecords).toBeGreaterThanOrEqual(60);
    expect(SEARCH_LIMITS.searchRecords).toBeLessThanOrEqual(600);
    expect(SEARCH_LIMITS.lookupRecords).toBeGreaterThanOrEqual(10);
    expect(SEARCH_LIMITS.lookupRecords).toBeLessThanOrEqual(120);
    expect(SEARCH_LIMITS.lookupRecords).toBeLessThan(SEARCH_LIMITS.searchRecords);
  });

  it('admits exactly the limit in a window, then answers the 429 envelope with retryAt', () => {
    const guard = new SearchThrottleGuard(new Reflector());
    exhaust(guard, 'lookupRecords');
    let refusal: unknown;
    try {
      guard.admit('lookupRecords', USER_A, 1_000);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SearchTooManyRequests);
    const response = (refusal as SearchTooManyRequests).getResponse();
    expect((refusal as SearchTooManyRequests).getStatus()).toBe(429);
    expect(response).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      code: 'too_many_requests',
      message: 'Too many searches. Wait a moment and try again.',
      retryAt: new Date(1_000 + SEARCH_WINDOW_MS).toISOString(),
    });
  });

  it('is per user and per operation: another user, and the other operation, stay open', () => {
    const guard = new SearchThrottleGuard(new Reflector());
    exhaust(guard, 'searchRecords');
    expect(() => guard.admit('searchRecords', USER_A, 1_000)).toThrow(SearchTooManyRequests);
    expect(() => guard.admit('searchRecords', USER_B, 1_000)).not.toThrow();
    expect(() => guard.admit('lookupRecords', USER_A, 1_000)).not.toThrow();
  });

  it('opens a fresh window once the old one ends, and clear() forgets every counter', () => {
    const guard = new SearchThrottleGuard(new Reflector());
    exhaust(guard, 'lookupRecords');
    expect(() => guard.admit('lookupRecords', USER_A, 1_000 + SEARCH_WINDOW_MS)).not.toThrow();
    exhaust(guard, 'searchRecords');
    guard.clear();
    expect(() => guard.admit('searchRecords', USER_A, 1_000)).not.toThrow();
  });

  it('fails closed on a handler without @SearchBudget or a request without a caller', () => {
    const guard = new SearchThrottleGuard(new Reflector());
    const context = (handler: () => void, request: object) =>
      ({
        getHandler: () => handler,
        switchToHttp: () => ({ getRequest: () => request }),
      }) as unknown as ExecutionContext;
    expect(() => guard.canActivate(context(() => undefined, {}))).toThrow(/SearchBudget/);
  });
});
