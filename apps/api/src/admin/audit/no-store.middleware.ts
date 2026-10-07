import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * `Cache-Control: no-store` on EVERY audit response (T-0078), set before the
 * guard runs.
 *
 * The handlers' `@Header` only reaches a response the handler produced: Nest
 * applies it after the guards, so `KasuwaAuthGuard`'s 401, its scope-header
 * 400, and any error thrown before the handler would go out without it.
 * Middleware runs before guards, so every answer an audit route gives, error
 * or not, is marked. Error bodies name nothing, but a URL that is identical
 * for every user of every tenant is never one a shared cache should keep.
 */
@Injectable()
export class NoStoreMiddleware implements NestMiddleware {
  use(_request: Request, response: Response, next: () => void): void {
    response.setHeader('Cache-Control', 'no-store');
    next();
  }
}
