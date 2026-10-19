import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { HttpException, HttpStatus, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { AUTH_CONTEXT_KEY } from '../tenancy/stub-auth.guard';

/**
 * The per-user notifications throttle (T-0100, D-L134, the T-0100 suite's
 * N-R8; contract response `NotificationsTooManyRequests`).
 *
 * The pattern is the search and duplicates throttles': PER USER (tenant and
 * user, never an address, so a BPO floor behind one office address never
 * shares a budget), PER OPERATION (exhausting the list leaves the badge's
 * poll open), decided AFTER `KasuwaAuthGuard` (which has answered 401 and the
 * scope-header 400) and BEFORE any validation, so a throttled caller learns
 * nothing from a malformed request. Every admitted request spends budget.
 *
 * The 429 is the shared Error envelope with `code: too_many_requests` and an
 * integer `Retry-After` (seconds to the end of the window, at least 1). It
 * says nothing about any record.
 *
 * STORAGE: in-process fixed windows in a Map, with the honest limitation the
 * search throttle has: the counter is per process, so with several API
 * instances the effective budget is the limit times the instance count. A
 * shared counter belongs in Redis when there is more than one instance. The
 * map is bounded the same way (a slice swept per request, a hard cap evicting
 * the oldest windows; evicting only ever gives a fresh budget).
 *
 * Nothing here logs: the key is a user id.
 */

export type NotificationOperation =
  | 'listNotifications'
  | 'getNotificationUnreadCount'
  | 'updateNotification'
  | 'markAllNotificationsRead';

/**
 * Requests admitted per user per window, per operation. The suite's bounds:
 * the list and the count each 60..600 in a burst. The badge polls every 30
 * seconds (`x-kasuwa-poll-interval-seconds`) and the list opens on a click,
 * so 120 a minute is far above any person and far below a sweep. The writes
 * are clicks.
 */
export const NOTIFICATION_LIMITS: Readonly<Record<NotificationOperation, number>> = {
  listNotifications: 120,
  getNotificationUnreadCount: 120,
  updateNotification: 120,
  markAllNotificationsRead: 60,
};
export const NOTIFICATION_WINDOW_MS = 60_000;

const SWEEP_THRESHOLD = 1_000;
const SWEEP_SLICE = 50;
const MAX_TRACKED_USERS = 50_000;

const NOTIFICATION_OPERATION = 'kasuwa:notification-operation';

/** Names the budget a handler spends. */
export const NotificationBudget = (operation: NotificationOperation) =>
  SetMetadata(NOTIFICATION_OPERATION, operation);

interface Window {
  count: number;
  resetAt: number;
}

export class NotificationsTooManyRequests extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        code: 'too_many_requests',
        message: 'Too many requests. Wait a moment and try again.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Whole seconds until `resetAt`, never less than 1. */
export function retryAfterSeconds(resetAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}

@Injectable()
export class NotificationThrottleGuard implements CanActivate {
  private readonly windows: Record<NotificationOperation, Map<string, Window>> = {
    listNotifications: new Map(),
    getNotificationUnreadCount: new Map(),
    updateNotification: new Map(),
    markAllNotificationsRead: new Map(),
  };

  // An explicit token: the test runner (esbuild) emits no decorator metadata.
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const operation = this.reflector.get<NotificationOperation | undefined>(
      NOTIFICATION_OPERATION,
      context.getHandler(),
    );
    if (operation === undefined) {
      // A handler that forgot @NotificationBudget is a wiring bug: fail closed.
      throw new Error('NotificationThrottleGuard on a handler without @NotificationBudget');
    }
    const http = context.switchToHttp();
    const auth = http.getRequest<Request>()[AUTH_CONTEXT_KEY];
    if (auth === undefined) {
      // KasuwaAuthGuard runs first and puts the caller here; without one,
      // nothing may pass.
      throw new Error('NotificationThrottleGuard ran before authentication');
    }
    const now = Date.now();
    const refusedUntil = this.admit(operation, `${auth.tenantId}:${auth.userId}`, now);
    if (refusedUntil !== null) {
      // Set here: the error filter keeps headers already on the response.
      http
        .getResponse<Response>()
        .setHeader('Retry-After', String(retryAfterSeconds(refusedUntil, now)));
      throw new NotificationsTooManyRequests();
    }
    return true;
  }

  /** Counts one request; returns null when admitted, else the window's end. */
  admit(operation: NotificationOperation, key: string, now: number): number | null {
    const windows = this.windows[operation];
    this.sweep(windows, now);
    const window = windows.get(key);
    if (window === undefined || window.resetAt <= now) {
      windows.delete(key);
      windows.set(key, { count: 1, resetAt: now + NOTIFICATION_WINDOW_MS });
      return null;
    }
    if (window.count >= NOTIFICATION_LIMITS[operation]) return window.resetAt;
    window.count += 1;
    return null;
  }

  /** Forgets every counter (an operator's seam, as SignInThrottleGuard.clear). */
  clear(): void {
    for (const windows of Object.values(this.windows)) windows.clear();
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
