import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AUTH_CONTEXT_KEY } from '../tenancy/stub-auth.guard';

/**
 * The per-user listDuplicates throttle (D-L151; the T-0095 suite's M7).
 *
 * Every page of duplicate sets is a scan of the programme's live contacts
 * (D-P33), so a caller walking pages in a loop is a load problem before it
 * is anything else. The pattern is the search throttle's
 * (search/search-throttle.guard.ts): PER USER (tenant and user, never an
 * address), decided AFTER `KasuwaAuthGuard` and BEFORE any validation, so a
 * throttled caller learns nothing from a malformed request, and every
 * admitted request spends budget. In-process fixed windows, with the same
 * honest limitation: several API instances multiply the budget, until the
 * counter moves to Redis.
 *
 * The 429 is the shared Error envelope with `code: too_many_requests` and an
 * integer `Retry-After` header (seconds to the end of the window, at least
 * 1). It says nothing about any contact. Nothing here logs.
 */

/** Requests admitted per user per window: a person paging the P28 queue, never a sweep. */
export const DUPLICATES_LIMIT = 120;
export const DUPLICATES_WINDOW_MS = 60_000;

const SWEEP_THRESHOLD = 1_000;
const SWEEP_SLICE = 50;
const MAX_TRACKED_USERS = 50_000;

interface Window {
  count: number;
  resetAt: number;
}

export class DuplicatesTooManyRequests extends HttpException {
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
export class DuplicatesThrottleGuard implements CanActivate {
  private readonly windows = new Map<string, Window>();

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const auth = http.getRequest<Request>()[AUTH_CONTEXT_KEY];
    if (auth === undefined) {
      // KasuwaAuthGuard runs first; without a caller nothing may pass.
      throw new Error('DuplicatesThrottleGuard ran before authentication');
    }
    const now = Date.now();
    const refusedUntil = this.admit(`${auth.tenantId}:${auth.userId}`, now);
    if (refusedUntil !== null) {
      // Set here: the error filter keeps headers already on the response.
      http
        .getResponse<Response>()
        .setHeader('Retry-After', String(retryAfterSeconds(refusedUntil, now)));
      throw new DuplicatesTooManyRequests();
    }
    return true;
  }

  /** Counts one request; returns null when admitted, else the window's end. */
  admit(key: string, now: number): number | null {
    this.sweep(now);
    const window = this.windows.get(key);
    if (window === undefined || window.resetAt <= now) {
      this.windows.delete(key);
      this.windows.set(key, { count: 1, resetAt: now + DUPLICATES_WINDOW_MS });
      return null;
    }
    if (window.count >= DUPLICATES_LIMIT) return window.resetAt;
    window.count += 1;
    return null;
  }

  /** Forgets every counter (an operator's seam). */
  clear(): void {
    this.windows.clear();
  }

  private sweep(now: number): void {
    if (this.windows.size < SWEEP_THRESHOLD) return;
    let examined = 0;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
      examined += 1;
      if (examined >= SWEEP_SLICE) break;
    }
    while (this.windows.size > MAX_TRACKED_USERS) {
      const oldest = this.windows.keys().next();
      if (oldest.done === true) break;
      this.windows.delete(oldest.value);
    }
  }
}
