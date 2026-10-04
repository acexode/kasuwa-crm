import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

/**
 * Auth-table retention (T-0045, D-L66, ADR-0012).
 *
 * `auth_challenge`, `auth_session` and `auth_rate_limit` grow without bound
 * unless something deletes from them, and `auth_rate_limit` grows with
 * attacker traffic: every identifier tried at a sign-in form leaves a row.
 * This is the one place that deletes them.
 *
 * HOW A CROSS-TENANT DELETE IS DONE WITHOUT BYPASSING RLS
 *
 * The sweep cannot use the ordinary policies. Those admit a row to a session
 * that names its tenant (`auth_challenge`, `auth_session`) or presents its key
 * (`auth_rate_limit`), and a sweep knows neither. It also must not use a
 * BYPASSRLS connection: apps/worker runs as kasuwa_app and no app process may
 * hold anything stronger (CLAUDE.md 2.1, db invariant 6). And it must not add a
 * third SECURITY DEFINER function (CLAUDE.md 2.7).
 *
 * So the transaction below, on the kasuwa_app connection it is given, does
 * `SET LOCAL ROLE kasuwa_sweeper`. That role:
 *
 *   - is NOLOGIN and NOBYPASSRLS, so RLS applies to it in full;
 *   - is granted to kasuwa_app WITH INHERIT FALSE, so its policies and grants
 *     apply only while a transaction has explicitly SET ROLE to it - an
 *     ordinary kasuwa_app transaction sees exactly what it saw before;
 *   - holds SELECT and DELETE on these three tables and nothing else;
 *   - has policies (migration 0020) whose predicate IS the retention rule.
 *
 * The last point is what makes the role safe whatever SQL runs under it: it
 * cannot read or delete a row that is not already dead, because no policy
 * admits one. The `WHERE` clauses below repeat the rule against the caller's
 * `now` as the second, independent layer (CLAUDE.md 2.3). Both must agree for
 * a row to go.
 *
 * ONE CALL IS ONE BOUNDED BATCH PER TABLE. At most `batchSize` rows per table,
 * and the counts say how many went. The caller (apps/worker) calls again while
 * any count equals `batchSize`; nothing here loops until empty, so one call
 * never holds row locks for an unbounded time.
 *
 * TWO CONCURRENT CALLS are expected: jobs are redelivered, and two worker
 * instances overlap during a deploy. Each table is guarded by a
 * transaction-scoped advisory lock taken with `pg_try_advisory_xact_lock`: a
 * call that finds the table already being pruned skips it and reports 0. So no
 * row is counted twice, and two DELETEs never lock overlapping rows in
 * different orders, which could otherwise deadlock.
 *
 * `FOR UPDATE SKIP LOCKED` is the usual tool and is deliberately NOT used: a
 * row-locking SELECT needs the UPDATE privilege and an UPDATE policy, and the
 * sweeper is granted SELECT and DELETE only (D-L66). Widening the role to save
 * an advisory lock would be the wrong trade.
 */

export interface PruneAuthTablesOptions {
  /** The instant retention is measured from. Normally `new Date()`. */
  now: Date;
  /** Maximum rows deleted from EACH table by this call. */
  batchSize: number;
}

export interface PruneAuthTablesCounts {
  authChallenge: number;
  authSession: number;
  authRateLimit: number;
}

/** The NOBYPASSRLS role the prune enters (D-L66). */
export const AUTH_SWEEPER_ROLE = 'kasuwa_sweeper';

/** The retention the prune applies; the policies in migration 0020 match it. */
export const AUTH_RETENTION = Object.freeze({
  /** A challenge is deleted this long after it expired. */
  challengeAfterExpiry: '1 day',
  /** A session is deleted this long after it expired or was revoked. */
  sessionAfterEnd: '30 days',
  /**
   * A rate-limit row is deleted this long after its last failure, and only
   * once any lock has lapsed. One day is the longest window the API can be
   * configured with (KASUWA_AUTH_LOCKOUT_WINDOW_MINUTES max 1440), so the
   * window has lapsed under every permitted configuration.
   */
  rateLimitAfterLastFailure: '1 day',
});

/** Namespace for the prune's advisory locks: ASCII 'KSWP'. */
const ADVISORY_NAMESPACE = 0x4b535750;

const OptionsSchema = z.object({
  now: z.date().refine((value) => !Number.isNaN(value.getTime()), 'now must be a valid date'),
  batchSize: z.number().int().min(1).max(100_000),
});

interface Target {
  readonly key: keyof PruneAuthTablesCounts;
  readonly lock: number;
  /** $1 = now, $2 = batch size. */
  readonly sql: string;
}

const TARGETS: readonly Target[] = [
  {
    key: 'authChallenge',
    lock: 1,
    sql: `
      DELETE FROM auth_challenge
       WHERE id IN (
         SELECT id FROM auth_challenge
          WHERE expires_at < $1::timestamptz - interval '${AUTH_RETENTION.challengeAfterExpiry}'
          ORDER BY expires_at
          LIMIT $2
       )`,
  },
  {
    key: 'authSession',
    lock: 2,
    sql: `
      DELETE FROM auth_session
       WHERE id IN (
         SELECT id FROM auth_session
          WHERE expires_at < $1::timestamptz - interval '${AUTH_RETENTION.sessionAfterEnd}'
             OR revoked_at < $1::timestamptz - interval '${AUTH_RETENTION.sessionAfterEnd}'
          LIMIT $2
       )`,
  },
  {
    key: 'authRateLimit',
    lock: 3,
    sql: `
      DELETE FROM auth_rate_limit
       WHERE key_hash IN (
         SELECT key_hash FROM auth_rate_limit
          WHERE last_failed_at < $1::timestamptz - interval '${AUTH_RETENTION.rateLimitAfterLastFailure}'
            AND (locked_until IS NULL OR locked_until < $1::timestamptz)
          ORDER BY last_failed_at
          LIMIT $2
       )`,
  },
];

/**
 * Deletes at most `batchSize` auth rows past retention from each table, as the
 * `kasuwa_sweeper` role, on a connection from the kasuwa_app pool it is given.
 */
export async function pruneAuthTables(
  pool: Pool,
  options: PruneAuthTablesOptions,
): Promise<PruneAuthTablesCounts> {
  const { now, batchSize } = OptionsSchema.parse(options);
  const counts: PruneAuthTablesCounts = { authChallenge: 0, authSession: 0, authRateLimit: 0 };

  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    // No tenant and no presented key: the ordinary policies, which still
    // apply to the sweeper alongside its own, admit nothing in here.
    await client.query(
      `SELECT set_config('app.tenant_id', '', true),
              set_config('app.rate_limit_key', '', true)`,
    );
    await client.query(`SET LOCAL ROLE ${AUTH_SWEEPER_ROLE}`);

    for (const target of TARGETS) {
      const locked = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1, $2) AS ok',
        [ADVISORY_NAMESPACE, target.lock],
      );
      if (locked.rows[0]?.ok !== true) continue;
      const result = await client.query(target.sql, [now, batchSize]);
      counts[target.key] = result.rowCount ?? 0;
    }

    await client.query('COMMIT');
    return counts;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Already broken; releasing below discards the connection.
    }
    throw error;
  } finally {
    // SET LOCAL ended with the transaction, so the connection goes back to the
    // pool as plain kasuwa_app.
    client.release();
  }
}
