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
    set_config('app.programme_ids', $3, true)
`;

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
  try {
    await client.query('BEGIN');

    // Phase 1: tenant scope only. `user` and `user_programme` are tenant-scoped
    // (not programme-scoped) precisely so that this lookup is possible before
    // the programme scope is known.
    await client.query(SET_CONTEXT_SQL, [tenantId, userId, '{}']);

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

    const value = await fn(tx);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; releasing it below with an error
      // tells pg to discard rather than reuse it.
    }
    throw error;
  } finally {
    client.release();
  }
}
