import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { NoStoreMiddleware } from '../admin/audit/no-store.middleware';
import { ScriptsController } from './scripts.controller';

/**
 * In-call script authoring (T-0113, M10; docs/api/scripting.openapi.yaml).
 *
 * No providers of its own: the guard and interceptor resolve PG_POOL from the
 * global DatabaseModule and AUTH_MODE from the global AppModule, as the admin
 * areas do. Every route is `Cache-Control: no-store` from before the guard
 * runs, so a guard's 401 or 400 carries it too: the shared no-store
 * middleware (T-0078's, in admin/audit until the shared common one lands).
 */
@Module({ controllers: [ScriptsController] })
export class ScriptsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(NoStoreMiddleware).forRoutes(ScriptsController);
  }
}
