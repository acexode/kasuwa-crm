import { Pool } from 'pg';

/**
 * Connection pools.
 *
 * Four distinct connection strings, four distinct Postgres roles:
 *   - DATABASE_URL           -> kasuwa_app       (NOBYPASSRLS, no DDL)  runtime
 *   - DATABASE_AUTH_URL      -> kasuwa_auth      (NOBYPASSRLS, no DDL)  the API's auth
 *                               module only; the sole writer of the auth tables (T-0049)
 *   - DATABASE_RELAY_URL     -> kasuwa_relay     (NOBYPASSRLS, no DDL)  apps/worker's
 *                               outbox relay only; outbox_event alone (T-0098, ADR-0018)
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

/**
 * The two messages `pg-pool` gives a caller that could not get a connection in
 * `connectionTimeoutMillis` (T-0045). Neither error carries a code or a class
 * of its own, so the message is the only signal the driver offers; keeping the
 * match here, beside `createPool`, means no other package names pg internals.
 *
 *   - every pooled connection is busy and none came free in time;
 *   - a NEW connection was being opened and did not finish in time.
 *
 * Both mean the same to a caller: the database is unavailable right now and a
 * retry later may succeed. Neither says anything about the request.
 */
const POOL_TIMEOUT_MESSAGES: ReadonlySet<string> = new Set([
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
]);

/** True for a `pg` pool connection timeout, and for nothing else. */
export function isPoolConnectionTimeout(error: unknown): boolean {
  return error instanceof Error && POOL_TIMEOUT_MESSAGES.has(error.message);
}
