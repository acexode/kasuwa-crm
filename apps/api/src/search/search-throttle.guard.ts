import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { HttpException, HttpStatus, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AUTH_CONTEXT_KEY } from '../tenancy/stub-auth.guard';

/**
 * The per-user search throttle (T-0086, D-L134, the T-0086 suite's R18).
 *
 * A resource and harvesting control, not a permission decision: searchRecords
 * is a typeahead, and lookupRecords tests one whole phone number or address
 * at a time, so an unthrottled lookup is a way to walk a number range. Each
 * operation has its OWN budget per user (exhausting one leaves the other
 * open), and the lookup's is tighter.
 *
 * PER USER, NEVER PER ADDRESS: the key is the authenticated tenant and user,
 * so colleagues behind one office address (a BPO floor) never share a budget.
 * That is why this guard runs AFTER `KasuwaAuthGuard` (which has put the
 * caller on the request, and has already answered 401 and the scope-header
 * 400) and BEFORE any validation: the contract's error order puts `429
 * too_many_requests` first after authentication, so a throttled caller learns
 * nothing more from a malformed request. Every admitted request spends
 * budget, a refused (400) one included.
 *
 * The answer is the sign-in throttle's (auth/sign-in-throttle.guard.ts,
 * `TooManyAttempts`): the shared Error envelope, `code: too_many_requests`
 * and `retryAt`, the end of the current window. It never echoes the query.
 *
 * STORAGE: the sign-in throttle's, in-process fixed windows in a Map, with the
 * same honest limitation: the counter is per process, so with several API
 * instances the effective budget is the limit times the instance count. A
 * shared counter belongs in Redis when there is more than one instance. The
 * map is bounded the same way (a slice swept per request, a hard cap evicting
 * the oldest windows; evicting only ever gives a fresh budget).
 *
 * Nothing here logs: the key is a user id, and the request is never read
 * beyond the authenticated caller.
 */

export type SearchOperation = 'searchRecords' | 'lookupRecords';

/**
 * Requests admitted per user per window, per operation. The suite's bounds
 * (R18): searchRecords 60..600 in a burst, lookupRecords 10..120 and fewer.
 * 120 searches a minute is a fast typist's typeahead with room to spare; 30
 * lookups a minute is an agent checking one caller's numbers, never a sweep.
 */
export const SEARCH_LIMITS: Readonly<Record<SearchOperation, number>> = {
  searchRecords: 120,
  lookupRecords: 30,
};
export const SEARCH_WINDOW_MS = 60_000;

/** Start sweeping once a map is this big; entries examined per request; hard ceiling. */
const SWEEP_THRESHOLD = 1_000;
const SWEEP_SLICE = 50;
const MAX_TRACKED_USERS = 50_000;

const SEARCH_OPERATION = 'kasuwa:search-operation';

/** Names the budget a handler spends. */
export const SearchBudget = (operation: SearchOperation) =>
  SetMetadata(SEARCH_OPERATION, operation);

interface Window {
  count: number;
  resetAt: number;
}

/** The 429 body: the shared Error envelope, never anything from the request. */
export class SearchTooManyRequests extends HttpException {
  constructor(retryAt: Date) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        code: 'too_many_requests',
        message: 'Too many searches. Wait a moment and try again.',
        retryAt: retryAt.toISOString(),
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

@Injectable()
export class SearchThrottleGuard implements CanActivate {
  private readonly windows: Record<SearchOperation, Map<string, Window>> = {
    searchRecords: new Map(),
    lookupRecords: new Map(),
  };

  // An explicit token: the test runner (esbuild) emits no decorator metadata.
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const operation = this.reflector.get<SearchOperation | undefined>(
      SEARCH_OPERATION,
      context.getHandler(),
    );
    if (operation === undefined) {
      // A handler that forgot @SearchBudget is a wiring bug: fail closed.
      throw new Error('SearchThrottleGuard on a handler without @SearchBudget');
    }
    const auth = context.switchToHttp().getRequest<Request>()[AUTH_CONTEXT_KEY];
    if (auth === undefined) {
      // KasuwaAuthGuard runs first and puts the caller here; without one,
      // nothing may pass.
      throw new Error('SearchThrottleGuard ran before authentication');
    }
    this.admit(operation, `${auth.tenantId}:${auth.userId}`, Date.now());
    return true;
  }

  /** Counts one request against `key`'s budget for `operation`, or throws the 429. */
  admit(operation: SearchOperation, key: string, now: number): void {
    const windows = this.windows[operation];
    this.sweep(windows, now);
    const window = windows.get(key);
    if (window === undefined || window.resetAt <= now) {
      windows.delete(key);
      windows.set(key, { count: 1, resetAt: now + SEARCH_WINDOW_MS });
      return;
    }
    if (window.count >= SEARCH_LIMITS[operation]) {
      throw new SearchTooManyRequests(new Date(window.resetAt));
    }
    window.count += 1;
  }

  /** Forgets every counter (an operator's seam, as SignInThrottleGuard.clear). */
  clear(): void {
    this.windows.searchRecords.clear();
    this.windows.lookupRecords.clear();
  }

  private sweep(windows: Map<string, Window>, now: number): void {
    if (windows.size < SWEEP_THRESHOLD) return;
    let examined = 0;
    for (const [key, window] of windows) {
      if (window.resetAt <= now) windows.delete(key);
      examined += 1;
      if (examined >= SWEEP_SLICE) break;
    }
    // Insertion-ordered (a renewed window is re-inserted), so the front is the oldest.
    while (windows.size > MAX_TRACKED_USERS) {
      const oldest = windows.keys().next();
      if (oldest.done === true) break;
      windows.delete(oldest.value);
    }
  }
}
