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
  /** How long a caller waits for a free connection before failing. */
  connectionTimeoutMillis?: number;
}

/**
 * The default wait for a pooled connection (T-0013).
 *
 * `pg` defaults to waiting FOREVER. When something holds every connection — a
 * flood of sign-ins did, back when the hash ran inside the transaction — every
 * other tenant's request queued behind it indefinitely, holding its socket and
 * its memory, and the cell looked hung rather than overloaded. Five seconds is
 * already far past anything a user waits for; after that, an error the caller
 * can see and retry is better than a request that never answers.
 */
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

export function createPool(options: PoolOptions): Pool {
  return new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    application_name: options.applicationName ?? 'kasuwa',
    // A request holds a connection for the life of its transaction, so a stuck
    // statement is a stuck tenant. Fail fast rather than pile up.
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 15_000,
  });
}
