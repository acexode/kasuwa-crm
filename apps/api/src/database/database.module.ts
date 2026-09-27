import { Global, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { createPool } from '@kasuwa/db';
import type { Pool } from 'pg';

export const PG_POOL = Symbol('PG_POOL');

/**
 * The application connection pool.
 *
 * It is built from DATABASE_URL, which resolves to kasuwa_app: NOBYPASSRLS, no
 * DDL rights, not the owner of any table. There is deliberately no provider
 * here for DATABASE_MIGRATION_URL - the API must have no way to reach the
 * migrator role, even by accident.
 */
@Global()
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  private static pool: Pool | undefined;

  static forRoot(options: { databaseUrl: string; poolMax?: number }): DynamicModule {
    const pool = createPool({
      connectionString: options.databaseUrl,
      max: options.poolMax ?? 10,
      applicationName: 'kasuwa-api',
    });
    DatabaseModule.pool = pool;

    return {
      module: DatabaseModule,
      providers: [{ provide: PG_POOL, useValue: pool }],
      exports: [PG_POOL],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await DatabaseModule.pool?.end();
    DatabaseModule.pool = undefined;
  }
}
