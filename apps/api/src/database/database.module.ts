import {
  Global,
  Inject,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
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
  /**
   * The pool is injected, NOT held in a static.
   *
   * It used to be a static field, which is correct for exactly one application
   * per process and silently wrong for two: the second `forRoot` overwrote the
   * reference, so closing either app ended the second app's pool and orphaned
   * the first's. Nothing created two apps until T-0001's tests did, and the
   * symptom when they did was not an error — it was connections leaking until
   * the next suite's writes started failing, which reads like a bug in
   * whatever was being tested rather than in here.
   */
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  static forRoot(options: {
    databaseUrl: string;
    poolMax?: number;
    connectionTimeoutMillis?: number;
  }): DynamicModule {
    const pool = createPool({
      connectionString: options.databaseUrl,
      max: options.poolMax ?? 10,
      applicationName: 'kasuwa-api',
      ...(options.connectionTimeoutMillis === undefined
        ? {}
        : { connectionTimeoutMillis: options.connectionTimeoutMillis }),
    });

    return {
      module: DatabaseModule,
      providers: [{ provide: PG_POOL, useValue: pool }],
      exports: [PG_POOL],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
