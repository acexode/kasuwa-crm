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
 *   * The tenant comes from `app.resolve_tenant_by_slug`, a SECURITY DEFINER
 *     function that takes a public slug and returns an id and nothing else.
 *
 * A caller supplying a tenant slug is not the caller choosing its own scope.
 * The slug says which workspace they claim to belong to; the password decides
 * whether that claim holds, and `user_programme` — read later, inside a real
 * tenant transaction — still decides everything they can reach.
 */

const Uuid = z.string().uuid();

export interface AuthTx {
  /** The resolved tenant. Set as `app.tenant_id` for the whole transaction. */
  readonly tenantId: string;
  query<T extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<T[]>;
}

const SET_AUTH_CONTEXT_SQL = `
  SELECT
    set_config('app.tenant_id',     $1, true),
    set_config('app.user_id',       '', true),
    set_config('app.programme_ids', '{}', true)
`;

const RESOLVE_TENANT_SQL = `SELECT app.resolve_tenant_by_slug($1) AS tenant_id`;

export type TenantSelector = { tenantSlug: string } | { tenantId: string };

/**
 * Opens an authentication transaction scoped to one tenant.
 *
 * `fn` receives `null` when the slug names no tenant. It must NOT short-circuit
 * on that: the caller is expected to do the same argon2id work it would have
 * done for a real account, so that an unknown workspace and a wrong password
 * take the same time. Returning early here is exactly the enumeration oracle
 * the acceptance suite measures.
 */
export async function withAuthTransaction<T>(
  pool: Pool,
  selector: TenantSelector,
  fn: (tx: AuthTx | null) => Promise<T>,
): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    const tenantId = await resolveTenantId(client, selector);
    if (tenantId === null) {
      const value = await fn(null);
      await client.query('COMMIT');
      return value;
    }

    await client.query(SET_AUTH_CONTEXT_SQL, [tenantId]);

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

async function resolveTenantId(client: PoolClient, selector: TenantSelector): Promise<string | null> {
  if ('tenantId' in selector) {
    return Uuid.parse(selector.tenantId);
  }
  const result = await client.query<{ tenant_id: string | null }>(RESOLVE_TENANT_SQL, [
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
