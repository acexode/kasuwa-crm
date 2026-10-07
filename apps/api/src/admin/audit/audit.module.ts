import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { NoStoreMiddleware } from './no-store.middleware';

/**
 * Admin API: the audit log (T-0025, M2).
 *
 * Imported by AdminModule, like every admin area (D-L39). No providers of its
 * own: the guard and interceptor resolve PG_POOL from the global DatabaseModule
 * and AUTH_MODE from the global AppModule. The writer other areas call,
 * `audit-writer.ts`, is a plain function over the request's `TenantTx`.
 *
 * Every audit route is `Cache-Control: no-store` from before the guard runs,
 * so a guard's 401 or 400 carries it too (T-0078, `no-store.middleware.ts`).
 */
@Module({ controllers: [AuditController] })
export class AdminAuditModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(NoStoreMiddleware).forRoutes(AuditController);
  }
}
