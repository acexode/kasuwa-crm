import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * `Cache-Control: no-store` on EVERY answer of the routes it is applied to,
 * set before the guard runs (T-0078 for the audit routes; T-0080 for every
 * records route, closing D-L90's follow-up). The one copy in the app.
 *
 * The handlers' `@Header` does not reach every answer: Nest sets it AFTER the
 * guards run (router-execution-context.js: guards, then status and headers,
 * then interceptors and the handler). So a 400 or 404 thrown by an
 * interceptor or a handler carries it, but `KasuwaAuthGuard`'s 401 and its
 * scope-header 400 go out without it, as would any route that forgot the
 * decorator. Middleware runs before guards, so every answer such a route
 * gives, error or not, is marked, and every exception filter's
 * `status().json()` keeps the header. Error bodies name nothing, but a URL
 * that is identical for every user of every tenant is never one a shared
 * cache should keep.
 *
 * Applied by `AdminAuditModule` (the audit controller), by
 * `AdminDispositionsModule` (listProgrammeScripts, T-0113) and by `AppModule`
 * (`RECORDS_CONTROLLERS` and `SCRIPTING_CONTROLLERS`). The handlers keep their
 * own `@Header` as well, where they have one.
 */
@Injectable()
export class NoStoreMiddleware implements NestMiddleware {
  use(_request: Request, response: Response, next: NextFunction): void {
    response.setHeader('Cache-Control', 'no-store');
    next();
  }
}
