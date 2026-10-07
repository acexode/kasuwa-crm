import { Injectable, RequestMethod, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * `Cache-Control: no-store` on EVERY answer of the routes it is applied to,
 * errors included (T-0080).
 *
 * Nest's `@Header` is applied only when a handler returns: a `400` or `404`
 * thrown inside it, or a `401` from the guard, is written by an exception
 * filter and never carries the header. A middleware runs before the guard,
 * the interceptor and the handler, so the header is set on the response
 * before anything can answer, and every filter's `status().json()` keeps it.
 * An error body names no record, but the answer for one of these URLs is
 * still not something a shared or browser cache may keep and replay: they
 * are the same for every user of every tenant.
 *
 * Applied in `AppModule.configure` to `NO_STORE_ROUTES` only. A middleware
 * for every `/api/v1` route, replacing the per-handler headers, is the
 * tracked follow-up in D-L90, not this change.
 */
@Injectable()
export class NoStoreMiddleware implements NestMiddleware {
  use(_request: Request, response: Response, next: NextFunction): void {
    response.setHeader('Cache-Control', 'no-store');
    next();
  }
}

/** The routes whose every answer, 200, 400 and 404 alike, is `no-store`. */
export const NO_STORE_ROUTES = [
  // listContactTimeline (T-0061) and listAccountTimeline (T-0080): one
  // shared implementation, one caching rule.
  { path: 'api/v1/contacts/:contactId/timeline', method: RequestMethod.GET },
  { path: 'api/v1/accounts/:accountId/timeline', method: RequestMethod.GET },
];
