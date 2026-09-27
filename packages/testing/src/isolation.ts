import type { Pool, QueryResultRow } from 'pg';

/**
 * The tenant isolation harness (founding pack 3.3).
 *
 * These helpers exist to attack the tenancy model from below. `withTenantTransaction`
 * in @kasuwa/db is the safe path: it resolves scope from the database and a
 * caller cannot widen it. The helpers here do the opposite — they set the RLS
 * session GUCs to whatever a test asks for, including values no legitimate
 * session could ever produce.
 *
 * That is the point. It lets the isolation suite ask the question that actually
 * matters: "if the application layer were completely compromised and set any
 * session variables it liked, what could still leak?" The answer must be
 * "nothing outside the tenant named in app.tenant_id" — because RLS, not the
 * application, is the last line.
 *
 * NEVER import this from application code. The lint config forbids
 * @kasuwa/testing outside test files.
 */

export interface ForcedScope {
  /** Omit to leave app.tenant_id unset, which must deny everything. */
  tenantId?: string;
  userId?: string;
  /** Raw list; not validated against user_programme. That is the whole idea. */
  programmeIds?: readonly string[];
}

const SET_SQL = `
  SELECT
    set_config('app.tenant_id',     $1, true),
    set_config('app.user_id',       $2, true),
    set_config('app.programme_ids', $3, true)
`;

/**
 * Opens a transaction with arbitrary, unvalidated RLS session variables and
 * runs `fn`. Always rolls back, so an attack test can attempt writes safely.
 */
export async function withForcedScope<T>(
  pool: Pool,
  scope: ForcedScope,
  fn: (
    query: <R extends QueryResultRow>(sql: string, values?: unknown[]) => Promise<R[]>,
  ) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(SET_SQL, [
      scope.tenantId ?? '',
      scope.userId ?? '',
      scope.programmeIds === undefined ? '' : `{${scope.programmeIds.join(',')}}`,
    ]);

    const query = async <R extends QueryResultRow>(sql: string, values: unknown[] = []) => {
      const result = await client.query<R>(sql, values);
      return result.rows;
    };

    return await fn(query);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** Every table that must be covered by the catalogue invariants. */
export interface TableSecurityState {
  table: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
  policyCount: number;
}

const TABLE_SECURITY_SQL = `
  SELECT c.relname                        AS table,
         c.relrowsecurity                 AS rls_enabled,
         c.relforcerowsecurity            AS rls_forced,
         (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policy_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relname NOT LIKE '\\_%'
   ORDER BY c.relname
`;

/**
 * Reads RLS state for every ordinary table in `public`, skipping internal
 * tables prefixed with `_` (the migration ledger).
 *
 * Used by the "no table without RLS" invariant, which is the one check that
 * keeps working when someone adds a table in six months and forgets everything
 * written in CLAUDE.md.
 */
export async function readTableSecurity(pool: Pool): Promise<TableSecurityState[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      table: string;
      rls_enabled: boolean;
      rls_forced: boolean;
      policy_count: number;
    }>(TABLE_SECURITY_SQL);
    return result.rows.map((row) => ({
      table: row.table,
      rlsEnabled: row.rls_enabled,
      rlsForced: row.rls_forced,
      policyCount: row.policy_count,
    }));
  } finally {
    client.release();
  }
}

/** Reads the role attributes the tenancy model depends on. */
export async function readRoleAttributes(
  pool: Pool,
  roleName: string,
): Promise<{ bypassRls: boolean; superuser: boolean; createRole: boolean } | null> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      rolbypassrls: boolean;
      rolsuper: boolean;
      rolcreaterole: boolean;
    }>(`SELECT rolbypassrls, rolsuper, rolcreaterole FROM pg_roles WHERE rolname = $1`, [roleName]);
    const row = result.rows[0];
    return row === undefined
      ? null
      : { bypassRls: row.rolbypassrls, superuser: row.rolsuper, createRole: row.rolcreaterole };
  } finally {
    client.release();
  }
}
