import { Pool } from 'pg';

/**
 * Connection pools.
 *
 * Two distinct connection strings, two distinct Postgres roles:
 *   - DATABASE_URL           -> kasuwa_app       (NOBYPASSRLS, no DDL)  runtime
 *   - DATABASE_MIGRATION_URL -> kasuwa_migrator  (owns schema)          migrations + seed
 *
 * Nothing in apps/ may open a pool with the migration URL. See D-L07.
 */
export interface PoolOptions {
  connectionString: string;
  max?: number;
  applicationName?: string;
}

export function createPool(options: PoolOptions): Pool {
  return new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'kasuwa',
    // A request holds a connection for the life of its transaction, so a stuck
    // statement is a stuck tenant. Fail fast rather than pile up.
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 15_000,
  });
}
