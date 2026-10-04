import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { releaseClean } from './session';

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
 *   - holds DELETE on these three tables and SELECT on only the columns the
 *     sweep reads (key and timestamps), and nothing else;
 *   - has policies (migration 0020) whose predicate IS the retention rule.
 *
 * The ordinary policies (TO PUBLIC) still apply to the sweeper too, ORed with
 * its own. They admit rows for the tenant in `app.tenant_id` and the key in
 * `app.rate_limit_key`, so this transaction clears both and then, as the
 * sweeper, reads both accessors back and refuses to continue unless both are
 * NULL. With that confirmed, the only rows the role can read or delete are
 * rows already dead by retention, whatever SQL runs under it. The `WHERE`
 * clauses below repeat the rule against the caller's `now` as the second,
 * independent layer (CLAUDE.md 2.3). Both must agree for a row to go.
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

/**
 * The retention the prune applies, in minutes; the policies in migration 0020
 * state the same lines. Passed to Postgres as interval parameters, never
 * spliced into SQL.
 */
export const AUTH_RETENTION = Object.freeze({
  /** A challenge is deleted this long after it expired: 1 day. */
  challengeAfterExpiryMinutes: 24 * 60,
  /** A session is deleted this long after it expired or was revoked: 30 days. */
  sessionAfterEndMinutes: 30 * 24 * 60,
  /**
   * A rate-limit row is deleted this long after its last failure, and only
   * once any lock has lapsed: 1 day. That must be at least the longest window
   * the API can be configured with (KASUWA_AUTH_LOCKOUT_WINDOW_MINUTES, max
   * 1440), so the window has lapsed under every permitted configuration.
   * apps/worker's unit tests pin the two together.
   */
  rateLimitAfterLastFailureMinutes: 24 * 60,
});

/** Namespace for the prune's advisory locks: ASCII 'KSWP'. */
const ADVISORY_NAMESPACE = 0x4b535750;
const LOCK_CHALLENGE = 1;
const LOCK_SESSION = 2;
const LOCK_RATE_LIMIT = 3;

const OptionsSchema = z.object({
  now: z.date().refine((value) => !Number.isNaN(value.getTime()), 'now must be a valid date'),
  batchSize: z.number().int().min(1).max(100_000),
});

const minutes = (value: number): string => `${value} minutes`;

// Every statement: $1 = now, $2 = rows still allowed this batch, $3 = the
// retention interval. The retention predicate is in the outer DELETE as well
// as the subquery, so a row is deleted only if it is dead when it is locked,
// not merely when it was chosen.

const DELETE_CHALLENGES_SQL = `
  DELETE FROM auth_challenge
   WHERE expires_at < $1::timestamptz - $3::interval
     AND id IN (
       SELECT id FROM auth_challenge
        WHERE expires_at < $1::timestamptz - $3::interval
        ORDER BY expires_at
        LIMIT $2
     )`;

// Sessions are pruned by two statements, not one `expired OR revoked`: an OR
// across two columns cannot use auth_session_expiry_idx and scans the table.
//
// The revoked statement also requires `expires_at < now`, which lets it range
// over the same index. That loses nothing: a session lives at most 720 hours
// (KASUWA_AUTH_SESSION_HOURS' maximum) and cannot be revoked before it was
// issued, so one revoked more than 30 days ago has already expired. A row that
// broke that rule would be KEPT, never deleted early.
const DELETE_EXPIRED_SESSIONS_SQL = `
  DELETE FROM auth_session
   WHERE expires_at < $1::timestamptz - $3::interval
     AND id IN (
       SELECT id FROM auth_session
        WHERE expires_at < $1::timestamptz - $3::interval
        ORDER BY expires_at
        LIMIT $2
     )`;

const DELETE_REVOKED_SESSIONS_SQL = `
  DELETE FROM auth_session
   WHERE revoked_at < $1::timestamptz - $3::interval
     AND expires_at < $1::timestamptz
     AND id IN (
       SELECT id FROM auth_session
        WHERE revoked_at < $1::timestamptz - $3::interval
          AND expires_at < $1::timestamptz
        ORDER BY expires_at
        LIMIT $2
     )`;

const DELETE_RATE_LIMITS_SQL = `
  DELETE FROM auth_rate_limit
   WHERE last_failed_at < $1::timestamptz - $3::interval
     AND (locked_until IS NULL OR locked_until < $1::timestamptz)
     AND key_hash IN (
       SELECT key_hash FROM auth_rate_limit
        WHERE last_failed_at < $1::timestamptz - $3::interval
          AND (locked_until IS NULL OR locked_until < $1::timestamptz)
        ORDER BY last_failed_at
        LIMIT $2
     )`;

/**
 * Entering the sweeper, and proving the ordinary policies admit nothing.
 *
 * The PUBLIC policies on these tables still apply to the sweeper and are ORed
 * with its dead-row policies. Clearing the tenant and key GUCs is what keeps
 * them closed; reading both accessors back AS THE SWEEPER proves it rather
 * than assuming it.
 */
const CLEAR_CONTEXT_SQL = `
  SELECT set_config('app.tenant_id', '', true),
         set_config('app.rate_limit_key', '', true)`;
const CONFIRM_SWEEPER_SQL = `
  SELECT current_user::text AS role,
         app.current_tenant_id() IS NULL AND app.current_rate_limit_key() IS NULL AS closed`;

/** Thrown if the sweeper's transaction is not the narrow one it must be. */
export class AuthSweepContextError extends Error {
  constructor() {
    super(
      'The auth sweep did not run as kasuwa_sweeper with no tenant and no rate-limit key. ' +
        'Nothing was deleted.',
    );
    this.name = 'AuthSweepContextError';
  }
}

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
  let discard = false;
  const tryLock = async (lock: number): Promise<boolean> => {
    const result = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1, $2) AS ok',
      [ADVISORY_NAMESPACE, lock],
    );
    return result.rows[0]?.ok === true;
  };
  const run = async (sql: string, limit: number, retentionMinutes: number): Promise<number> => {
    const result = await client.query(sql, [now, limit, minutes(retentionMinutes)]);
    return result.rowCount ?? 0;
  };

  try {
    await client.query('BEGIN');
    await client.query(CLEAR_CONTEXT_SQL);
    await client.query(`SET LOCAL ROLE ${AUTH_SWEEPER_ROLE}`);
    const confirmed = await client.query<{ role: string; closed: boolean | null }>(
      CONFIRM_SWEEPER_SQL,
    );
    if (confirmed.rows[0]?.role !== AUTH_SWEEPER_ROLE || confirmed.rows[0]?.closed !== true) {
      throw new AuthSweepContextError();
    }

    if (await tryLock(LOCK_CHALLENGE)) {
      counts.authChallenge = await run(
        DELETE_CHALLENGES_SQL,
        batchSize,
        AUTH_RETENTION.challengeAfterExpiryMinutes,
      );
    }

    if (await tryLock(LOCK_SESSION)) {
      // One budget for both statements: the call still deletes at most
      // batchSize sessions.
      const expired = await run(
        DELETE_EXPIRED_SESSIONS_SQL,
        batchSize,
        AUTH_RETENTION.sessionAfterEndMinutes,
      );
      const revoked =
        expired < batchSize
          ? await run(
              DELETE_REVOKED_SESSIONS_SQL,
              batchSize - expired,
              AUTH_RETENTION.sessionAfterEndMinutes,
            )
          : 0;
      counts.authSession = expired + revoked;
    }

    if (await tryLock(LOCK_RATE_LIMIT)) {
      counts.authRateLimit = await run(
        DELETE_RATE_LIMITS_SQL,
        batchSize,
        AUTH_RETENTION.rateLimitAfterLastFailureMinutes,
      );
    }

    await client.query('COMMIT');
    return counts;
  } catch (error) {
    if (error instanceof AuthSweepContextError) discard = true;
    try {
      await client.query('ROLLBACK');
    } catch {
      // Already broken: discard rather than reuse it.
      discard = true;
    }
    throw error;
  } finally {
    // SET LOCAL ended with the transaction; RESET ROLE makes sure of it before
    // the connection goes back to the pool as plain kasuwa_app.
    await releaseClean(client, discard);
  }
}
