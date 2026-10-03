import { newId, type TenantTx } from '@kasuwa/db';

/**
 * Dispositions — the outcome codes agents pick after an interaction (T-0027).
 *
 * Programme-scoped data in the `contact` discipline: every WHERE repeats the
 * tenant predicate AND `programme_id = ANY(session.programmeIds)`, though the
 * `disposition` policy enforces both (migration 0010). The programme ids come
 * from `tx.session`, which came from `user_programme` — never from an
 * argument. `programmeId` here is a record identifier; one outside the
 * session is `null`, which the controller turns into the one 404.
 *
 * Delete is soft (D-L47): a deleted row keeps its code (reserved, never
 * reissued) and loses its position, and is invisible to every function here
 * except the idempotency check in `deleteDisposition`.
 *
 * Writers take the programme row FOR NO KEY UPDATE first, so two concurrent
 * writes to one programme's list — two appends, or an append and a reorder —
 * are serialised rather than racing for the same position.
 */

export const DISPOSITION_CATEGORIES = [
  'promise_to_pay',
  'resolved',
  'callback',
  'escalated',
  'not_reached',
] as const;
export type DispositionCategory = (typeof DISPOSITION_CATEGORIES)[number];

export interface Disposition {
  id: string;
  code: string;
  label: string;
  category: DispositionCategory;
  noteRequired: boolean;
  followUpRequired: boolean;
  active: boolean;
  position: number;
}

export interface NewDisposition {
  code: string;
  label: string;
  category: DispositionCategory;
  noteRequired: boolean;
  followUpRequired: boolean;
}

export interface DispositionChanges {
  label?: string | undefined;
  category?: DispositionCategory | undefined;
  noteRequired?: boolean | undefined;
  followUpRequired?: boolean | undefined;
  active?: boolean | undefined;
}

/**
 * `code` is already used in this programme — by a live row or a deleted one.
 * Carries no identifier and no database text: the conflicting row may be a
 * deleted one the caller can no longer see.
 */
export class DuplicateDispositionCodeError extends Error {
  constructor() {
    super('Disposition code already used in this programme');
    this.name = 'DuplicateDispositionCodeError';
  }
}

/**
 * A reorder body that is not exactly the programme's live dispositions, each
 * once. Covers a subset, a superset, a duplicate, an id from another programme
 * and an id that names nothing — all the same failure (D-L47), so the error
 * cannot be used to learn which ids exist elsewhere.
 */
export class IncompleteDispositionOrderError extends Error {
  constructor() {
    super('Disposition order is not the complete list for this programme');
    this.name = 'IncompleteDispositionOrderError';
  }
}

interface DispositionRow {
  id: string;
  code: string;
  label: string;
  category: DispositionCategory;
  note_required: boolean;
  follow_up_required: boolean;
  active: boolean;
  position: number;
}

const SELECT_DISPOSITION = `
  id, code, label, category, note_required, follow_up_required, active, position
`;

function toDisposition(row: DispositionRow): Disposition {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    category: row.category,
    noteRequired: row.note_required,
    followUpRequired: row.follow_up_required,
    active: row.active,
    position: row.position,
  };
}

/**
 * Pure: is `requested` exactly `live`, each id once, in any order?
 * Exported for unit testing; the repository is its only caller.
 */
export function isCompleteOrder(live: readonly string[], requested: readonly string[]): boolean {
  if (requested.length !== live.length) {
    return false;
  }
  const remaining = new Set(live);
  for (const id of requested) {
    if (!remaining.delete(id)) {
      return false;
    }
  }
  return remaining.size === 0;
}

async function isReachable(tx: TenantTx, programmeId: string): Promise<boolean> {
  if (!tx.session.programmeIds.includes(programmeId)) {
    return false;
  }
  // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
  const rows = await tx.query<{ id: string }>(
    `SELECT id FROM programme
      WHERE id = $1
        AND tenant_id = $2
        AND id = ANY($3::uuid[])`,
    [programmeId, tx.session.tenantId, tx.session.programmeIds],
  );
  return rows.length > 0;
}

/** Reachability plus the write lock on the programme row; see the file header. */
async function lockReachable(tx: TenantTx, programmeId: string): Promise<boolean> {
  if (!tx.session.programmeIds.includes(programmeId)) {
    return false;
  }
  // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
  const rows = await tx.query<{ id: string }>(
    `SELECT id FROM programme
      WHERE id = $1
        AND tenant_id = $2
        AND id = ANY($3::uuid[])
        FOR NO KEY UPDATE`,
    [programmeId, tx.session.tenantId, tx.session.programmeIds],
  );
  return rows.length > 0;
}

async function readLive(tx: TenantTx, programmeId: string): Promise<Disposition[]> {
  // tenancy-reviewed: tenant_id + programme_id + session programme ids, as well as RLS.
  const rows = await tx.query<DispositionRow>(
    `SELECT ${SELECT_DISPOSITION}
       FROM disposition
      WHERE tenant_id = $1
        AND programme_id = $2
        AND programme_id = ANY($3::uuid[])
        AND deleted_at IS NULL
      ORDER BY position ASC`,
    [tx.session.tenantId, programmeId, tx.session.programmeIds],
  );
  return rows.map(toDisposition);
}

/** The live list in agent order (position ascending), or `null` if unreachable. */
export async function listDispositions(
  tx: TenantTx,
  programmeId: string,
): Promise<Disposition[] | null> {
  if (!(await isReachable(tx, programmeId))) {
    return null;
  }
  return readLive(tx, programmeId);
}

/**
 * Appends a disposition after the last live one (D-L47). `null` if the
 * programme is unreachable; throws DuplicateDispositionCodeError on a code
 * already used in the programme, deleted rows included.
 */
export async function createDisposition(
  tx: TenantTx,
  programmeId: string,
  input: NewDisposition,
): Promise<Disposition | null> {
  if (!(await lockReachable(tx, programmeId))) {
    return null;
  }
  try {
    // tenancy-reviewed: tenant_id + programme_id + session programme ids, as well as RLS.
    const rows = await tx.query<DispositionRow>(
      `INSERT INTO disposition
         (id, tenant_id, programme_id, code, label, category,
          note_required, follow_up_required, position)
       SELECT $1::uuid, $2::uuid, $3::uuid, $5::text, $6::text, $7::text,
              $8::boolean, $9::boolean,
              coalesce(max(position), 0) + 1
         FROM disposition
        WHERE tenant_id = $2::uuid
          AND programme_id = $3::uuid
          AND programme_id = ANY($4::uuid[])
          AND deleted_at IS NULL
       RETURNING ${SELECT_DISPOSITION}`,
      [
        newId(),
        tx.session.tenantId,
        programmeId,
        tx.session.programmeIds,
        input.code,
        input.label,
        input.category,
        input.noteRequired,
        input.followUpRequired,
      ],
    );
    const row = rows[0];
    return row === undefined ? null : toDisposition(row);
  } catch (error) {
    if (isUniqueViolation(error, 'disposition_programme_code_key')) {
      throw new DuplicateDispositionCodeError();
    }
    throw error;
  }
}

/**
 * Applies `changes` to a live disposition. `null` when the programme is
 * unreachable, or the id names nothing live IN THIS programme — a reachable
 * programme in the path with another programme's id is the same `null`.
 */
export async function updateDisposition(
  tx: TenantTx,
  programmeId: string,
  id: string,
  changes: DispositionChanges,
): Promise<Disposition | null> {
  if (!(await lockReachable(tx, programmeId))) {
    return null;
  }
  // tenancy-reviewed: tenant_id + programme_id + session programme ids, as well as RLS.
  const rows = await tx.query<DispositionRow>(
    `UPDATE disposition
        SET label              = coalesce($5::text, label),
            category           = coalesce($6::text, category),
            note_required      = coalesce($7::boolean, note_required),
            follow_up_required = coalesce($8::boolean, follow_up_required),
            active             = coalesce($9::boolean, active),
            updated_at         = now()
      WHERE id = $1
        AND tenant_id = $2
        AND programme_id = $3
        AND programme_id = ANY($4::uuid[])
        AND deleted_at IS NULL
      RETURNING ${SELECT_DISPOSITION}`,
    [
      id,
      tx.session.tenantId,
      programmeId,
      tx.session.programmeIds,
      changes.label ?? null,
      changes.category ?? null,
      changes.noteRequired ?? null,
      changes.followUpRequired ?? null,
      changes.active ?? null,
    ],
  );
  const row = rows[0];
  return row === undefined ? null : toDisposition(row);
}

/**
 * Soft-deletes a disposition: `deleted_at` set, position released, code kept.
 *
 * `true` when the disposition is now deleted — including when it already was
 * (the spec makes delete idempotent). `null` when the programme is
 * unreachable or the id names nothing in this programme.
 */
export async function deleteDisposition(
  tx: TenantTx,
  programmeId: string,
  id: string,
): Promise<true | null> {
  if (!(await lockReachable(tx, programmeId))) {
    return null;
  }
  // tenancy-reviewed: tenant_id + programme_id + session programme ids, as well as RLS.
  const rows = await tx.query<{ id: string }>(
    `UPDATE disposition
        SET deleted_at = coalesce(deleted_at, now()),
            position   = NULL,
            updated_at = CASE WHEN deleted_at IS NULL THEN now() ELSE updated_at END
      WHERE id = $1
        AND tenant_id = $2
        AND programme_id = $3
        AND programme_id = ANY($4::uuid[])
      RETURNING id`,
    [id, tx.session.tenantId, programmeId, tx.session.programmeIds],
  );
  return rows.length > 0 ? true : null;
}

/**
 * Sets the agent order to `orderedIds`, which must be exactly the live
 * dispositions of the programme. `null` if unreachable; throws
 * IncompleteDispositionOrderError otherwise, having changed nothing.
 */
export async function reorderDispositions(
  tx: TenantTx,
  programmeId: string,
  orderedIds: readonly string[],
): Promise<Disposition[] | null> {
  if (!(await lockReachable(tx, programmeId))) {
    return null;
  }
  const live = await readLive(tx, programmeId);
  if (
    !isCompleteOrder(
      live.map((item) => item.id),
      orderedIds,
    )
  ) {
    throw new IncompleteDispositionOrderError();
  }
  if (orderedIds.length > 0) {
    // One statement, so the DEFERRABLE position key is checked once at its end
    // rather than per row (migration 0010).
    // tenancy-reviewed: tenant_id + programme_id + session programme ids, as well as RLS.
    await tx.query(
      `UPDATE disposition AS d
          SET position = o.ord::int,
              updated_at = now()
         FROM unnest($4::uuid[]) WITH ORDINALITY AS o(id, ord)
        WHERE d.id = o.id
          AND d.tenant_id = $1
          AND d.programme_id = $2
          AND d.programme_id = ANY($3::uuid[])
          AND d.deleted_at IS NULL`,
      [tx.session.tenantId, programmeId, tx.session.programmeIds, orderedIds],
    );
  }
  return readLive(tx, programmeId);
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === constraint;
}
