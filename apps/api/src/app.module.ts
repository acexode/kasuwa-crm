import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ContactsController } from './contacts/contacts.controller';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { StubAuthGuard } from './tenancy/stub-auth.guard';
import { TenantTransactionInterceptor } from './tenancy/tenant-transaction.interceptor';
import { ValidationExceptionFilter } from './common/zod-exception.filter';

export interface AppModuleOptions {
  databaseUrl: string;
  poolMax?: number;
}

/**
 * The modular monolith's composition root (ADR-0001).
 *
 * The guard and interceptor are applied per-controller rather than globally, so
 * that HealthController can exist without a tenant. That is a deliberate,
 * narrow exception: any controller that touches tenant data must carry both
 * decorators, and the acceptance suite fails if a route serves data without
 * them.
 *
 * `forRoot` takes the database URL as an argument rather than reading the
 * environment, so tests can point an app at a Testcontainers instance without
 * mutating process.env.
 */
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DatabaseModule.forRoot(
          options.poolMax === undefined
            ? { databaseUrl: options.databaseUrl }
            : { databaseUrl: options.databaseUrl, poolMax: options.poolMax },
        ),
      ],
      controllers: [HealthController, ContactsController],
      providers: [
        StubAuthGuard,
        TenantTransactionInterceptor,
        { provide: APP_FILTER, useClass: ValidationExceptionFilter },
      ],
    };
  }
}
