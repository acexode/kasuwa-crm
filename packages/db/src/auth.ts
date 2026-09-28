import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';

/**
 * The authentication bootstrap: how a request that has no session yet reaches
 * the database at all.
 *
 * Every RLS policy in Kasuwa reads `app.tenant_id`, and `withTenantTransaction`
 * sets it from a user who is already known. Sign-in is the one place where
 * nobody is known yet, so it needs its own, narrower door. This file is that
 * door and it is deliberately the whole of it.
 *
 * What makes it narrow:
 *
 *   * It still runs in a transaction, and it still sets the session GUCs. There
 *     is no unscoped query here any more than anywhere else.
 *   * `app.programme_ids` is `'{}'` for the entire transaction. Every
 *     programme-scoped policy tests `= ANY (app.current_programme_ids())`,
 *     which is false against an empty array, so an authentication transaction
 *     can read no business row at all — not one contact, not one programme.
 *     That property is worth more than any amount of care in the caller.
 *   * `app.user_id` is left unset, because there is no user yet. No policy
 *     reads it today; if one ever does, it will deny, which is correct here.
 *   * When the workspace does not resolve, `app.tenant_id` is left unset too,
 *     and every tenant-scoped policy denies. **The transaction still opens and
 *     the same code runs.** That is deliberate: making the unknown-workspace
 *     path structurally identical to the known one is what stops it being
 *     distinguishable, and an early return here was exactly the enumeration
 *     oracle a security review found in the first version of this file.
 *
 * A caller supplying a tenant slug is not the caller choosing its own scope.
 * The slug says which workspace they claim to belong to; the password decides
 * whether that claim holds, and `user_programme` — read later, inside a real
 * tenant transaction — still decides everything they can reach.
 */

const Uuid = z.string().uuid();

export interface AuthTx {
  /**
   * The resolved tenant, or null when the workspace does not exist, is
   * suspended, or the supplied id names nothing. Null means every tenant-scoped
   * policy in the transaction denies.
   */
  readonly tenantId: string | null;
  query<T extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<T[]>;
}

/** An `AuthTx` that is known to have resolved a tenant. */
export type ResolvedAuthTx = AuthTx & { readonly tenantId: string };

export function hasTenant(tx: AuthTx): tx is ResolvedAuthTx {
  return tx.tenantId !== null;
}

const SET_AUTH_CONTEXT_SQL = `
  SELECT
    set_config('app.tenant_id',     $1, true),
    set_config('app.user_id',       '', true),
    set_config('app.programme_ids', '{}', true)
`;

const RESOLVE_TENANT_BY_SLUG_SQL = `SELECT app.resolve_tenant_by_slug($1) AS tenant_id`;

/**
 * Confirms a supplied tenant id names a tenant that is not suspended.
 *
 * Runs AFTER the GUC is set, so the `tenant` policy (`id = current_tenant_id()`)
 * permits exactly this one row and nothing else — no extra SECURITY DEFINER
 * function needed, and no way to use this to read another tenant.
 *
 * The status check is the point. Suspension has to contain: a suspended tenant
 * that can still finish a sign-in it started, or still use a session issued
 * yesterday, is not suspended in any sense that matters after a compliance
 * event.
 */
const CONFIRM_TENANT_SQL = `SELECT 1 FROM tenant WHERE id = $1 AND status <> 'suspended'`;

export type TenantSelector = { tenantSlug: string } | { tenantId: string };

/**
 * Opens an authentication transaction, scoped to one tenant where one resolves.
 *
 * `tx.tenantId` is null when the workspace does not exist or is suspended. The
 * caller must NOT short-circuit on that: it is expected to do the same argon2id
 * work and record the same failed attempt it would for a real workspace, so
 * that the two are indistinguishable in body and in timing.
 */
export async function withAuthTransaction<T>(
  pool: Pool,
  selector: TenantSelector,
  fn: (tx: AuthTx) => Promise<T>,
): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    const tenantId = await resolveTenantId(client, selector);
    await client.query(SET_AUTH_CONTEXT_SQL, [tenantId ?? '']);

    const tx: AuthTx = {
      tenantId,
      query: async <R extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
        const result = await client.query<R>(text, values as unknown[]);
        return result.rows;
      },
    };

    const value = await fn(tx);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Already broken; releasing below discards the connection.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function resolveTenantId(
  client: PoolClient,
  selector: TenantSelector,
): Promise<string | null> {
  if ('tenantId' in selector) {
    // A client-supplied id (the tenant half of a challenge id). It is a routing
    // hint, not a credential, and it is confirmed rather than trusted — the
    // first version of this file parsed it as a uuid and went no further, which
    // let a suspended tenant finish a sign-in it was not allowed to start.
    const parsed = Uuid.safeParse(selector.tenantId);
    if (!parsed.success) {
      return null;
    }
    await client.query(SET_AUTH_CONTEXT_SQL, [parsed.data]);
    const confirmed = await client.query(CONFIRM_TENANT_SQL, [parsed.data]);
    return confirmed.rowCount === 0 ? null : parsed.data;
  }

  const result = await client.query<{ tenant_id: string | null }>(RESOLVE_TENANT_BY_SLUG_SQL, [
    selector.tenantSlug,
  ]);
  return result.rows[0]?.tenant_id ?? null;
}

export interface SessionIdentity {
  sessionId: string;
  tenantId: string;
  userId: string;
}

const RESOLVE_SESSION_SQL = `SELECT session_id, tenant_id, user_id FROM app.resolve_session($1)`;

/**
 * Turns a session token hash into the identity it names, or null.
 *
 * This is the only read in the system that happens before a tenant context
 * exists, and it is the reason `app.resolve_session` is SECURITY DEFINER: the
 * token is the only thing the request carries, and until it is resolved there
 * is no tenant to scope by.
 *
 * It returns identifiers and nothing else, and it is only the FIRST of two
 * checks. The caller opens a real tenant transaction with the identity this
 * returns, and re-reads the same session row under RLS before serving
 * anything. If this function were wrong, the second check would still refuse.
 */
export async function resolveSessionIdentity(
  pool: Pool,
  tokenHash: Buffer,
): Promise<SessionIdentity | null> {
  const result = await pool.query<{ session_id: string; tenant_id: string; user_id: string }>(
    RESOLVE_SESSION_SQL,
    [tokenHash],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : { sessionId: row.session_id, tenantId: row.tenant_id, userId: row.user_id };
}

// --- the rate-limit store --------------------------------------------------
//
// `auth_rate_limit` carries no tenant_id. That is an exception to the rule that
// every table does, it is argued in ADR-0009 and in migration 0003, and it is
// named in NON_TENANT_SCOPED_TABLES so the catalogue invariant's exemption is
// visible rather than silent.
//
// Every function below is a SINGLE statement. That is not tidiness: the first
// version of this feature read a counter, added one in JavaScript, and wrote
// the result back, which under READ COMMITTED means N concurrent attempts all
// read the same value and all write the same value — so the counter never
// reaches its threshold and the lockout never fires. Postgres does the
// arithmetic here, and the caller believes what it returns.

export interface RateLimitState {
  failedCount: number;
  lockedUntil: Date | null;
}

export interface RateLimitPolicy {
  /** Failures inside the window before the key is locked. 0 disables lockout. */
  maxAttempts: number;
  /** Failures older than this stop counting. */
  windowMinutes: number;
  /** How long a lock lasts. */
  lockMinutes: number;
}

const REGISTER_FAILURE_SQL = `
  INSERT INTO auth_rate_limit (key_hash, failed_count)
       VALUES ($1, 1)
  ON CONFLICT (key_hash) DO UPDATE
       SET failed_count = CASE
             WHEN auth_rate_limit.first_failed_at < now() - $2::interval THEN 1
             ELSE auth_rate_limit.failed_count + 1
           END,
           first_failed_at = CASE
             WHEN auth_rate_limit.first_failed_at < now() - $2::interval THEN now()
             ELSE auth_rate_limit.first_failed_at
           END,
           last_failed_at = now(),
           locked_until = CASE
             WHEN $3::int > 0 AND (
                    CASE
                      WHEN auth_rate_limit.first_failed_at < now() - $2::interval THEN 1
                      ELSE auth_rate_limit.failed_count + 1
                    END
                  ) >= $3::int
             THEN now() + $4::interval
             ELSE auth_rate_limit.locked_until
           END
    RETURNING failed_count, locked_until
`;

/**
 * Records one failure and returns the resulting state, deciding the lock in the
 * same statement.
 *
 * Deciding the lock here rather than in a follow-up UPDATE is what makes it
 * hold under concurrency: whichever transaction writes the row that reaches the
 * threshold is the one that sets `locked_until`, and no interleaving can leave
 * the counter past the threshold with no lock set.
 */
export async function registerAuthFailure(
  client: { query: <T extends QueryResultRow>(sql: string, values?: readonly unknown[]) => Promise<T[]> },
  keyHash: Buffer,
  policy: RateLimitPolicy,
): Promise<RateLimitState> {
  const rows = await client.query<{ failed_count: number; locked_until: Date | null }>(
    REGISTER_FAILURE_SQL,
    [
      keyHash,
      `${policy.windowMinutes} minutes`,
      policy.maxAttempts,
      `${policy.lockMinutes} minutes`,
    ],
  );
  const row = rows[0];
  return {
    failedCount: row?.failed_count ?? 1,
    lockedUntil: row?.locked_until ?? null,
  };
}

const READ_LOCK_SQL = `
  SELECT failed_count, locked_until
    FROM auth_rate_limit
   WHERE key_hash = $1
     AND locked_until > now()
`;

/** The active lock on a key, or null. */
export async function readAuthLock(
  client: { query: <T extends QueryResultRow>(sql: string, values?: readonly unknown[]) => Promise<T[]> },
  keyHash: Buffer,
): Promise<RateLimitState | null> {
  const rows = await client.query<{ failed_count: number; locked_until: Date }>(READ_LOCK_SQL, [
    keyHash,
  ]);
  const row = rows[0];
  return row === undefined
    ? null
    : { failedCount: row.failed_count, lockedUntil: row.locked_until };
}

/** Forgets a key's failures. Called after the factor it guards succeeds. */
export async function clearAuthFailures(
  client: { query: <T extends QueryResultRow>(sql: string, values?: readonly unknown[]) => Promise<T[]> },
  keyHash: Buffer,
): Promise<void> {
  await client.query(`DELETE FROM auth_rate_limit WHERE key_hash = $1`, [keyHash]);
}
