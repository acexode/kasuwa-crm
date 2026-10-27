import type { TenantTx } from '@kasuwa/db';

/**
 * The caller's own Home layout (T-0159, D-L196; migration 0045).
 *
 * One row per user, scoped by the SESSION: the tenant and the user come from
 * `tx.session`, never an argument, so nothing a caller sends can choose whose
 * layout is read, replaced or deleted. Every statement repeats both beside
 * RLS (CLAUDE.md 2.3), and the table's policy pins them a second time.
 *
 * Deliberately no programme: a layout is the person's, and a user with no
 * programme still has a Home (see the migration).
 *
 * This module stores what it is given. The widget vocabulary (`type`, `span`)
 * is validated at the API boundary, where the contract lives; the database
 * bounds the shape (an array of at most 19, a closed role). Nothing here logs.
 */

export interface HomeLayoutItem {
  readonly type: string;
  readonly span: number;
}

export interface HomeLayoutRecord {
  readonly role: string;
  readonly items: readonly HomeLayoutItem[];
}

interface Row {
  role: string;
  items: HomeLayoutItem[];
}

/** The caller's layout, or `null` when none is saved (an empty layout is not none). */
export async function getOwnHomeLayout(tx: TenantTx): Promise<HomeLayoutRecord | null> {
  // tenancy-reviewed: the session's tenant and user, bound parameters, and RLS
  // pins both again; no value comes from the request.
  const rows = await tx.query<Row>(
    `SELECT role, items
       FROM home_layout
      WHERE tenant_id = $1
        AND user_id = $2`,
    [tx.session.tenantId, tx.session.userId],
  );
  const row = rows[0];
  return row === undefined ? null : { role: row.role, items: row.items };
}

/** Replaces the caller's layout (never appends), and returns what is stored. */
export async function putOwnHomeLayout(
  tx: TenantTx,
  layout: HomeLayoutRecord,
): Promise<HomeLayoutRecord> {
  // tenancy-reviewed: the tenant and user are the session's and are the
  // primary key, so the conflict can only ever be the caller's own row; RLS
  // checks the INSERT and the UPDATE branch again.
  const rows = await tx.query<Row>(
    `INSERT INTO home_layout (tenant_id, user_id, role, items)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (tenant_id, user_id)
     DO UPDATE SET role = EXCLUDED.role, items = EXCLUDED.items
     RETURNING role, items`,
    [tx.session.tenantId, tx.session.userId, layout.role, JSON.stringify(layout.items)],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('home_layout upsert returned no row');
  return { role: row.role, items: row.items };
}

/** Deletes the caller's layout. Idempotent: nothing saved is not an error. */
export async function deleteOwnHomeLayout(tx: TenantTx): Promise<void> {
  // tenancy-reviewed: the session's tenant and user, bound parameters; RLS
  // pins both again.
  await tx.query(
    `DELETE FROM home_layout
      WHERE tenant_id = $1
        AND user_id = $2`,
    [tx.session.tenantId, tx.session.userId],
  );
}
