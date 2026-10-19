import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';

/**
 * The tenancy primitive. Everything that touches tenant data goes through
 * `withTenantTransaction`; there is no other supported way to query.
 *
 * Why a transaction: the RLS policies read transaction-local GUCs
 * (`set_config(..., is_local => true)`). If the work were not in a transaction
 * the settings would leak to the next user of the pooled connection — which is
 * precisely a cross-tenant data leak. The transaction boundary IS the tenancy
 * boundary.
 *
 * Why the session is *resolved*, not *supplied*: the caller says who the user
 * is; this module decides what they can reach, by reading `user_programme`.
 * A caller can never widen its own scope by passing a longer programme list.
 * The stub auth header transport depends on this being true — see the
 * header-forgery cases in tests/acceptance/tenancy.
 */

const Uuid = z.string().uuid();

export interface SessionRequest {
  tenantId: string;
  userId: string;
}

export interface TenantSession {
  readonly tenantId: string;
  readonly userId: string;
  /** Resolved from user_programme. Never supplied by the caller. */
  readonly programmeIds: readonly string[];
}

export interface TenantTx {
  readonly session: TenantSession;
  query<T extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<T[]>;
}

/**
 * The three session GUCs, as the database reports them.
 *
 * Read back before COMMIT and compared with what `withTenantTransaction`
 * resolved. See `SessionScopeViolationError` for why.
 */
export interface SessionScopeSnapshot {
  tenantId: string | null;
  userId: string | null;
  programmeIds: string | null;
}

/**
 * True when the context the database is enforcing is not the one that was
 * resolved for this transaction.
 *
 * Pure, and separated from the query so it can be tested without a database.
 * String comparison is deliberate: the GUCs are text and the policies read
 * text, so the question is whether that text changed — not whether two
 * re-interpretations of it happen to mean the same thing.
 */
export function scopeDiverged(
  expected: SessionScopeSnapshot,
  actual: SessionScopeSnapshot,
): boolean {
  return (
    expected.tenantId !== actual.tenantId ||
    expected.userId !== actual.userId ||
    expected.programmeIds !== actual.programmeIds
  );
}

/**
 * Raised when the RLS session context changed inside a transaction.
 *
 * `tx.query` is an unrestricted statement channel on the connection that holds
 * the session GUCs, and `set_config` is executable by `kasuwa_app` — as is
 * `SET LOCAL`, which no grant can take away for a user-settable parameter. So a
 * callback CAN re-point `app.tenant_id` at another tenant, and Postgres offers
 * no way to stop it on the same connection under the same role. ADR-0010 makes
 * that argument at length rather than leaving this comment to carry it.
 *
 * What IS enforceable is that nothing done under a changed context ever has an
 * effect. The context is read back before COMMIT; a difference rolls the
 * transaction back and throws this, and the callback's return value is
 * discarded rather than returned. A forged read cannot leave
 * `withTenantTransaction` and a forged write cannot commit.
 *
 * The message names no identifier, on purpose. It is thrown on a path where the
 * values in play may belong to another tenant, and an error message is a leak
 * channel like any other.
 */
export class SessionScopeViolationError extends Error {
  constructor() {
    super(
      'The RLS session context changed inside the transaction. Scope is resolved once, ' +
        'by the session helper, and may not be re-set by a callback. The transaction was ' +
        'rolled back and its result discarded.',
    );
    this.name = 'SessionScopeViolationError';
  }
}

export class UnknownSessionUserError extends Error {
  constructor(tenantId: string, userId: string) {
    super(`No active user ${userId} in tenant ${tenantId}`);
    this.name = 'UnknownSessionUserError';
  }
}

/**
 * Formats a uuid list as a Postgres array literal for `app.programme_ids`.
 * Every element is re-validated as a uuid first: the value is interpolated into
 * a GUC rather than passed as a bound parameter element, so it must not be able
 * to carry anything but uuids. Defence in depth against a corrupted read.
 */
export function formatProgrammeIds(ids: readonly string[]): string {
  for (const id of ids) {
    const parsed = Uuid.safeParse(id);
    if (!parsed.success) {
      throw new Error(`Refusing to build a programme scope containing a non-uuid value`);
    }
  }
  return `{${ids.join(',')}}`;
}

const SET_CONTEXT_SQL = `
  SELECT
    set_config('app.tenant_id',     $1, true),
    set_config('app.user_id',       $2, true),
    set_config('app.programme_ids', $3, true),
    current_user = session_user AS role_intact
`;

// Never add FOR UPDATE / FOR SHARE here: migration 0021's restrictive UPDATE
// policies apply to row locks, so a locked read would resolve every non-admin
// to zero programmes (fail closed, but an outage).
const RESOLVE_SCOPE_SQL = `
  SELECT up.programme_id
    FROM user_programme up
    JOIN "user" u ON u.id = up.user_id AND u.tenant_id = up.tenant_id
   WHERE up.user_id = $1
     AND u.status = 'active'
   ORDER BY up.programme_id
`;

const USER_EXISTS_SQL = `SELECT 1 FROM "user" WHERE id = $1 AND status = 'active'`;

/**
 * Reads the session GUCs back. Three `current_setting` calls — one round trip
 * per transaction, not per statement.
 */
const READ_CONTEXT_SQL = `
  SELECT current_setting('app.tenant_id',     true) AS tenant_id,
         current_setting('app.user_id',       true) AS user_id,
         current_setting('app.programme_ids', true) AS programme_ids,
         current_user = session_user                AS role_intact
`;

/**
 * Throws `SessionScopeViolationError` unless the row says the role in force is
 * the role the connection logged in as (T-0045).
 *
 * WHY THE ROLE IS PART OF THE SCOPE. Since D-L66, kasuwa_app is a member of
 * `kasuwa_sweeper` (NOINHERIT, SET), so that `pruneAuthTables` can enter it.
 * Membership with SET means any statement on a kasuwa_app connection can
 * switch to it - `SET ROLE`, or `set_config('role', 'kasuwa_sweeper', ...)`,
 * which works inside a SELECT. Under the sweeper the dead-row policies apply
 * across every tenant while every app.* GUC still reads as resolved, so the
 * GUC comparison alone would pass. Nothing in a tenant or auth transaction
 * ever changes role legitimately, so the check is simply equality with
 * session_user.
 */
export function assertRoleIntact(row: { role_intact?: boolean | null } | undefined): void {
  if (row?.role_intact !== true) {
    throw new SessionScopeViolationError();
  }
}

/**
 * Returns a connection to the pool with no role left on it.
 *
 * `set_config('role', ..., false)` - session-scoped - survives COMMIT, and a
 * callback can hide it at commit time behind a transaction-local reset. So
 * every helper that hands a connection to caller-supplied SQL resets the role
 * on the way out, before the next checkout can see it. A connection that
 * cannot be reset, or that the caller asks to discard (a scope violation, a
 * failed ROLLBACK), is destroyed instead of returned.
 */
export async function releaseClean(client: PoolClient, discard: boolean): Promise<void> {
  let destroy = discard;
  if (!destroy) {
    try {
      await client.query('RESET ROLE');
    } catch {
      destroy = true;
    }
  }
  client.release(destroy);
}

/**
 * Reads the context back and throws `SessionScopeViolationError` if it is not
 * the one that was set.
 *
 * Called immediately before COMMIT, in both `withTenantTransaction` and
 * `withAuthTransaction`. Deliberately NOT called between every statement: a
 * subtransaction may legitimately carry the GUCs away and back inside one
 * transaction (`ROLLBACK TO SAVEPOINT` restores them), and what has to be true
 * is that the context in force when work becomes durable is the resolved one.
 * Per-statement checking would also double the round trips on every query for
 * no additional guarantee — a caller determined to evade this can restore the
 * GUCs before returning either way. ADR-0010 is explicit that this is a
 * detection control and not a privilege boundary.
 */
export async function assertScopeIntact(
  client: Pick<PoolClient, 'query'>,
  expected: SessionScopeSnapshot,
): Promise<void> {
  const result = await client.query<{
    tenant_id: string | null;
    user_id: string | null;
    programme_ids: string | null;
    role_intact: boolean | null;
  }>(READ_CONTEXT_SQL);
  const row = result.rows[0];
  assertRoleIntact(row);
  const actual: SessionScopeSnapshot = {
    tenantId: row?.tenant_id ?? null,
    userId: row?.user_id ?? null,
    programmeIds: row?.programme_ids ?? null,
  };
  if (scopeDiverged(expected, actual)) {
    throw new SessionScopeViolationError();
  }
}

/**
 * Every TenantTx that `withTenantTransaction` handed out and whose transaction
 * is still open (D-L155). Module-private: nothing outside this module can add
 * to it. A tx is added when its callback starts and removed at COMMIT or
 * ROLLBACK, before the connection goes back to the pool.
 */
const LIVE_TENANT_TXS = new WeakSet<TenantTx>();

/**
 * Raised by `assertLiveTenantTx` for a tx that `withTenantTransaction` did not
 * hand out, or whose transaction has ended. Names nothing.
 */
export class TenantTxNotLiveError extends Error {
  override readonly name = 'TenantTxNotLiveError';
  readonly code = 'tenant_tx_not_live' as const;

  constructor() {
    super('not a live tenant transaction');
  }
}

/**
 * Refuses a TenantTx that is not the very object `withTenantTransaction` is
 * running right now: an object literal with a `session` and a `query`, a
 * spread or other copy of a real tx, or a real tx used after its transaction
 * committed or rolled back (D-L155). For code that trusts `tx.session` to
 * decide scope, such as minting a storage key, where a forged session would be
 * believed.
 */
export function assertLiveTenantTx(tx: unknown): asserts tx is TenantTx {
  if (typeof tx !== 'object' || tx === null || !LIVE_TENANT_TXS.has(tx as TenantTx)) {
    throw new TenantTxNotLiveError();
  }
}

/**
 * Opens a transaction, establishes the RLS session context, runs `fn`, then
 * commits (or rolls back on any throw) and returns the connection to the pool.
 */
export async function withTenantTransaction<T>(
  pool: Pool,
  request: SessionRequest,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const tenantId = Uuid.parse(request.tenantId);
  const userId = Uuid.parse(request.userId);

  const client: PoolClient = await pool.connect();
  let discard = false;
  let live: TenantTx | undefined;
  try {
    await client.query('BEGIN');

    // Phase 1: tenant scope only. `user` and `user_programme` are tenant-scoped
    // (not programme-scoped) precisely so that this lookup is possible before
    // the programme scope is known. The same statement confirms no role was
    // left on the connection (see `assertRoleIntact`).
    const started = await client.query<{ role_intact: boolean | null }>(SET_CONTEXT_SQL, [
      tenantId,
      userId,
      '{}',
    ]);
    assertRoleIntact(started.rows[0]);

    const exists = await client.query(USER_EXISTS_SQL, [userId]);
    if (exists.rowCount === 0) {
      // RLS already filtered by tenant, so "not found" covers both "no such
      // user" and "user belongs to a different tenant". The caller must not be
      // told which.
      throw new UnknownSessionUserError(tenantId, userId);
    }

    const scope = await client.query<{ programme_id: string }>(RESOLVE_SCOPE_SQL, [userId]);
    const programmeIds = scope.rows.map((row) => row.programme_id);

    // Phase 2: narrow to the programmes this user is actually a member of.
    await client.query(SET_CONTEXT_SQL, [tenantId, userId, formatProgrammeIds(programmeIds)]);

    const session: TenantSession = { tenantId, userId, programmeIds };
    const tx: TenantTx = {
      session,
      query: async <R extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
        const result = await client.query<R>(text, values as unknown[]);
        return result.rows;
      },
    };

    live = tx;
    LIVE_TENANT_TXS.add(tx);
    const value = await fn(tx);

    // The context the database is enforcing must still be the context that was
    // resolved above. If the callback re-set the GUCs, `value` was produced
    // under a scope nobody authorised — so it is discarded rather than
    // returned, and nothing the callback wrote is allowed to commit.
    await assertScopeIntact(client, {
      tenantId,
      userId,
      programmeIds: formatProgrammeIds(programmeIds),
    });

    LIVE_TENANT_TXS.delete(tx);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    if (live !== undefined) LIVE_TENANT_TXS.delete(live);
    // A connection whose scope or role was tampered with is not trusted again.
    if (error instanceof SessionScopeViolationError) discard = true;
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken: discard rather than reuse it.
      discard = true;
    }
    throw error;
  } finally {
    await releaseClean(client, discard);
  }
}
