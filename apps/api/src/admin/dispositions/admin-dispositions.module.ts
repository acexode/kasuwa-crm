import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { NoStoreMiddleware } from '../audit/no-store.middleware';
import { DispositionsController } from './dispositions.controller';
import { ProgrammeScriptsController } from './programme-scripts.controller';

/**
 * Admin API: dispositions and programme scripts (T-0027, P02/B5 and B6).
 *
 * Imported by AdminModule, like every admin area (D-L39). No providers of its
 * own: the guard and interceptor resolve PG_POOL from the global DatabaseModule
 * and AUTH_MODE from the global AppModule.
 *
 * listProgrammeScripts is `Cache-Control: no-store` on every response, a
 * guard's 401 or 400 included, now that it lists M10's scripts (T-0113; the
 * scripting contract's rule, D-L91): the shared no-store middleware, applied
 * before the guard runs.
 */
@Module({ controllers: [DispositionsController, ProgrammeScriptsController] })
export class AdminDispositionsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(NoStoreMiddleware).forRoutes(ProgrammeScriptsController);
  }
}
