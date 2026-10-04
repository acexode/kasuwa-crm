import type { pruneAuthTables, PruneAuthTablesCounts, PruneAuthTablesOptions } from '@kasuwa/db';

/** The kasuwa_app pool, typed through @kasuwa/db so the worker needs no pg dependency. */
export type Pool = Parameters<typeof pruneAuthTables>[0];

/**
 * The auth-table retention job (T-0045, D-L66).
 *
 * `pruneAuthTables` in @kasuwa/db does the deleting, one bounded batch per
 * table per call, on the kasuwa_app pool it is given. This file decides only
 * how often and how many: a BullMQ job scheduler fires the job every
 * `AUTH_RETENTION_EVERY_MS`, and the job calls the prune again while any table
 * came back with a full batch - so a backlog drains in one run, but in short
 * transactions rather than one long one.
 *
 * The job carries no payload and no tenant: the prune is cross-tenant by
 * design and its reach is bounded by the database role it enters, not by
 * anything on the job (apps/worker/CLAUDE.md invariant 2). It is idempotent
 * (invariant 3): a redelivered or overlapping run deletes what is left and
 * counts nothing twice.
 */

export const AUTH_RETENTION_QUEUE = 'kasuwa.auth-retention';
export const AUTH_RETENTION_SCHEDULER_ID = 'auth-retention';
export const AUTH_RETENTION_JOB_NAME = 'prune-auth-tables';

/** How often the scheduler fires. `auth_rate_limit` grows with attacker traffic. */
export const AUTH_RETENTION_EVERY_MS = 15 * 60 * 1000;

/** Rows per table per call: one short transaction each. */
export const AUTH_RETENTION_BATCH_SIZE = 500;

/**
 * Calls per run, at most. A run that hits this leaves the rest for the next
 * one, fifteen minutes later; it never spins on a table that refills as fast
 * as it is emptied.
 */
export const AUTH_RETENTION_MAX_BATCHES = 200;

export type Prune = (pool: Pool, options: PruneAuthTablesOptions) => Promise<PruneAuthTablesCounts>;

export interface AuthRetentionRun extends PruneAuthTablesCounts {
  batches: number;
}

/**
 * Prunes until no table returns a full batch, or `maxBatches` calls have run.
 * `now` is fixed for the whole run so every batch applies the same cut-off.
 */
export async function runAuthRetention(
  prune: Prune,
  pool: Pool,
  options: { now: Date; batchSize?: number; maxBatches?: number },
): Promise<AuthRetentionRun> {
  const batchSize = options.batchSize ?? AUTH_RETENTION_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? AUTH_RETENTION_MAX_BATCHES;
  const totals: AuthRetentionRun = { authChallenge: 0, authSession: 0, authRateLimit: 0, batches: 0 };

  while (totals.batches < maxBatches) {
    const counts = await prune(pool, { now: options.now, batchSize });
    totals.batches += 1;
    totals.authChallenge += counts.authChallenge;
    totals.authSession += counts.authSession;
    totals.authRateLimit += counts.authRateLimit;
    const full =
      counts.authChallenge === batchSize ||
      counts.authSession === batchSize ||
      counts.authRateLimit === batchSize;
    if (!full) break;
  }
  return totals;
}

/** One log line: counts only. A row's content never leaves the database. */
export function authRetentionLine(run: AuthRetentionRun): string {
  return (
    `auth retention: deleted challenges=${run.authChallenge} sessions=${run.authSession} ` +
    `rate_limits=${run.authRateLimit} batches=${run.batches}`
  );
}

/** An error's class name, if it is a plain identifier; never its message. */
function errorClass(error: unknown): string {
  const name: unknown =
    typeof error === 'object' && error !== null
      ? (error as { constructor?: { name?: unknown } }).constructor?.name
      : undefined;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)
    ? name
    : 'UnknownError';
}

/**
 * What a failed run throws to BullMQ. BullMQ stores a failed job's message as
 * `failedReason` and its stack in Redis, and a pg error's message or detail
 * can carry row values. So the job never rethrows the original: it throws this,
 * which names the error's class and nothing else, and carries no `cause`.
 */
export class AuthRetentionJobError extends Error {
  constructor(error: unknown) {
    super(`auth retention failed: ${errorClass(error)}`);
    this.name = 'AuthRetentionJobError';
  }
}

/** The job body: one retention run, with any failure sanitised for BullMQ. */
export async function authRetentionJob(
  prune: Prune,
  pool: Pool,
  now: Date,
): Promise<AuthRetentionRun> {
  try {
    return await runAuthRetention(prune, pool, { now });
  } catch (error) {
    throw new AuthRetentionJobError(error);
  }
}
