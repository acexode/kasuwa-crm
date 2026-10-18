import { newId, type TenantTx } from '@kasuwa/db';

/**
 * Contact merge and undo (T-0095; D-P12, D-P27, D-P28, D-L151, D-L153):
 * migration 0043's `contact_merge` and `contact.deleted_at`.
 *
 * THIS IS THE ONLY CODE THAT READS A MERGED-AWAY CONTACT. Every other contact
 * read carries `deleted_at IS NULL` (contact.repository's LIVE_CONTACT); the
 * merge needs the row to answer `409 already_merged` to a caller who could
 * read it, and undo needs it to restore. Nothing here decides permission or
 * field security: the API does, and hands in the values to write.
 *
 * Defence in depth as everywhere: every statement repeats the session's
 * tenant and programme scope on top of RLS. Values are bound parameters and
 * column names come from the fixed map below, never from input.
 */

/** The wire names a merge may choose (the contract's MergeField). */
export const MERGE_FIELDS = [
  'displayName',
  'givenNames',
  'familyName',
  'companyName',
  'phones',
  'emails',
  'accountId',
  'ownerUserId',
  'status',
  'source',
  'tags',
  'preferredLanguage',
  'preferredChannel',
  'state',
  'lga',
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

/** D-P28: never chosen, always the most restrictive. */
export const COMPLIANCE_FIELDS = ['dnd', 'whatsappOptIn', 'consentState'] as const;
export type ComplianceField = (typeof COMPLIANCE_FIELDS)[number];

export type MergeColumnField = MergeField | ComplianceField;

type Cast = 'text' | 'uuid' | 'jsonb' | 'text[]' | 'boolean';

const COLUMNS: Record<MergeColumnField, { column: string; cast: Cast }> = {
  displayName: { column: 'display_name', cast: 'text' },
  givenNames: { column: 'given_names', cast: 'text' },
  familyName: { column: 'family_name', cast: 'text' },
  companyName: { column: 'company_name', cast: 'text' },
  phones: { column: 'phones', cast: 'jsonb' },
  emails: { column: 'emails', cast: 'jsonb' },
  accountId: { column: 'account_id', cast: 'uuid' },
  ownerUserId: { column: 'owner_user_id', cast: 'uuid' },
  status: { column: 'status', cast: 'text' },
  source: { column: 'source', cast: 'text' },
  tags: { column: 'tags', cast: 'text[]' },
  preferredLanguage: { column: 'preferred_language', cast: 'text' },
  preferredChannel: { column: 'preferred_channel', cast: 'text' },
  state: { column: 'state', cast: 'text' },
  lga: { column: 'lga', cast: 'text' },
  dnd: { column: 'dnd', cast: 'boolean' },
  whatsappOptIn: { column: 'whatsapp_opt_in', cast: 'boolean' },
  consentState: { column: 'consent_state', cast: 'text' },
};

const FIELD_LIST = [...MERGE_FIELDS, ...COMPLIANCE_FIELDS] as const;

/** A contact's values by wire name, as stored. */
export type MergeValues = Partial<Record<MergeColumnField, unknown>>;

/** A contact as the merge sees it, merged away or not. */
export interface MergeContact {
  id: string;
  programmeId: string;
  version: number;
  deletedAt: Date | null;
  updatedAt: Date;
  values: Required<MergeValues>;
  /** The whole stored custom object (every key, withheld ones included). Never served. */
  custom: Record<string, unknown>;
}

const SELECT = `id, programme_id, version, deleted_at, updated_at, custom,
  ${FIELD_LIST.map((field) => `${COLUMNS[field].column} AS "${field}"`).join(', ')}`;

type MergeContactRow = Record<string, unknown> & {
  id: string;
  programme_id: string;
  version: number;
  deleted_at: Date | null;
  updated_at: Date;
  custom: Record<string, unknown> | null;
};

function toMergeContact(row: MergeContactRow): MergeContact {
  const values = {} as Record<MergeColumnField, unknown>;
  for (const field of FIELD_LIST) values[field] = row[field] ?? null;
  if (values.tags === null) values.tags = [];
  return {
    id: row.id,
    programmeId: row.programme_id,
    version: row.version,
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at,
    values,
    custom: row.custom ?? {},
  };
}

/**
 * The contacts named, merged away or not, that the session reaches. `lock`
 * takes FOR UPDATE on them, in id order, so two merges of the same pair in
 * opposite directions queue rather than deadlock; the second then sees the
 * first's result (READ COMMITTED re-reads a locked row).
 *
 * tenancy-reviewed: ids AND tenant (session) AND programme in the session's
 * scope; RLS besides.
 */
export async function findContactsForMerge(
  tx: TenantTx,
  ids: readonly string[],
  lock = false,
): Promise<MergeContact[]> {
  const rows = await tx.query<MergeContactRow>(
    `SELECT ${SELECT}
       FROM contact
      WHERE id = ANY($1::uuid[])
        AND tenant_id = $2
        AND programme_id = ANY($3::uuid[])
      ORDER BY id${lock ? '\n      FOR UPDATE' : ''}`,
    [[...ids], tx.session.tenantId, [...tx.session.programmeIds]],
  );
  return rows.map(toMergeContact);
}

/** Bound parameters, numbered as added. */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

function assignments(values: MergeValues, params: Params): string[] {
  const sets: string[] = [];
  for (const field of FIELD_LIST) {
    if (!(field in values)) continue;
    const value = values[field];
    const { column, cast } = COLUMNS[field];
    const bound =
      cast === 'jsonb' && value !== null && value !== undefined ? JSON.stringify(value) : value;
    sets.push(`${column} = ${params.add(bound ?? null)}::${cast}`);
  }
  return sets;
}

/** Thrown for a programme outside the session. The API answers 404 before this. */
export class MergeProgrammeOutOfScopeError extends Error {
  constructor() {
    super('Refusing to merge contacts in a programme outside the session scope');
    this.name = 'MergeProgrammeOutOfScopeError';
  }
}

function assertInScope(tx: TenantTx, programmeId: string): void {
  if (!tx.session.programmeIds.includes(programmeId)) throw new MergeProgrammeOutOfScopeError();
}

/**
 * Writes `values` and `custom` (the whole object) to a LIVE contact at
 * `version`, and moves its version on. Returns the new version, or null when
 * no row matched (the version moved, or the row was merged away).
 *
 * tenancy-reviewed: id AND tenant AND programme (checked against the session)
 * AND version AND live; RLS USING and WITH CHECK besides.
 */
export async function writeMergedValues(
  tx: TenantTx,
  target: { id: string; programmeId: string; version: number },
  values: MergeValues,
  custom: Record<string, unknown>,
): Promise<number | null> {
  assertInScope(tx, target.programmeId);
  const params = new Params();
  const sets = assignments(values, params);
  sets.push(`custom = ${params.add(JSON.stringify(custom))}::jsonb`, 'version = version + 1');
  const rows = await tx.query<{ version: number }>(
    `UPDATE contact
        SET ${sets.join(', ')}
      WHERE id = ${params.add(target.id)}::uuid
        AND tenant_id = ${params.add(tx.session.tenantId)}::uuid
        AND programme_id = ${params.add(target.programmeId)}::uuid
        AND version = ${params.add(target.version)}::integer
        AND deleted_at IS NULL
      RETURNING version`,
    params.values,
  );
  return rows[0]?.version ?? null;
}

/**
 * Merges a live contact away (sets `deleted_at`) iff it is still at
 * `version`. False when no row matched.
 *
 * tenancy-reviewed: as writeMergedValues.
 */
export async function softDeleteContact(
  tx: TenantTx,
  target: { id: string; programmeId: string; version: number },
): Promise<boolean> {
  assertInScope(tx, target.programmeId);
  const rows = await tx.query<{ id: string }>(
    `UPDATE contact
        SET deleted_at = now(), version = version + 1
      WHERE id = $1 AND tenant_id = $2 AND programme_id = $3 AND version = $4
        AND deleted_at IS NULL
      RETURNING id`,
    [target.id, tx.session.tenantId, target.programmeId, target.version],
  );
  return rows.length > 0;
}

/**
 * Brings a merged-away contact back with `values` and `custom` (undo).
 * False when the row is not merged away.
 *
 * tenancy-reviewed: id AND tenant AND programme (checked against the session);
 * RLS besides. The 0043 freeze trigger does not fire: deleted_at goes NULL.
 */
export async function restoreContact(
  tx: TenantTx,
  target: { id: string; programmeId: string },
  values: MergeValues,
  custom: Record<string, unknown>,
): Promise<boolean> {
  assertInScope(tx, target.programmeId);
  const params = new Params();
  const sets = assignments(values, params);
  sets.push(
    `custom = ${params.add(JSON.stringify(custom))}::jsonb`,
    'deleted_at = NULL',
    'version = version + 1',
  );
  const rows = await tx.query<{ id: string }>(
    `UPDATE contact
        SET ${sets.join(', ')}
      WHERE id = ${params.add(target.id)}::uuid
        AND tenant_id = ${params.add(tx.session.tenantId)}::uuid
        AND programme_id = ${params.add(target.programmeId)}::uuid
        AND deleted_at IS NOT NULL
      RETURNING id`,
    params.values,
  );
  return rows.length > 0;
}

export interface MovedChildren {
  activities: string[];
  deals: string[];
}

/**
 * Re-points the activities and deals of `from` to `to`, both contacts of
 * `programmeId`. `only`, when given, limits the move to those ids (undo moves
 * back only what the merge moved, M11). Writes no audit: a merge is one event
 * (M3). The composite keys hold every child in the programme.
 *
 * tenancy-reviewed: tenant (session) AND programme (checked against the
 * session) AND the contact column; RLS besides.
 */
export async function moveContactChildren(
  tx: TenantTx,
  programmeId: string,
  from: string,
  to: string,
  only?: MovedChildren,
): Promise<MovedChildren> {
  assertInScope(tx, programmeId);
  const base = [tx.session.tenantId, programmeId, from, to];
  const activities = await tx.query<{ id: string }>(
    `UPDATE activity SET contact_id = $4
      WHERE tenant_id = $1 AND programme_id = $2 AND contact_id = $3
        ${only === undefined ? '' : 'AND id = ANY($5::uuid[])'}
      RETURNING id`,
    only === undefined ? base : [...base, only.activities],
  );
  const deals = await tx.query<{ id: string }>(
    `UPDATE deal SET primary_contact_id = $4
      WHERE tenant_id = $1 AND programme_id = $2 AND primary_contact_id = $3
        ${only === undefined ? '' : 'AND id = ANY($5::uuid[])'}
      RETURNING id`,
    only === undefined ? base : [...base, only.deals],
  );
  return {
    activities: activities.map((row) => row.id).sort(),
    deals: deals.map((row) => row.id).sort(),
  };
}

/** A merge as served (never the snapshot), with the parties' names. */
export interface ContactMergeRecord {
  id: string;
  programmeId: string;
  survivorId: string;
  survivorDisplayName: string | null;
  mergedId: string;
  mergedDisplayName: string | null;
  mergedByUserId: string;
  mergedAt: Date;
  undoUntil: Date;
  undoneAt: Date | null;
  undoneByUserId: string | null;
  survivorReverted: boolean | null;
  /** `undo_until > now()`, judged by the database clock. */
  undoOpen: boolean;
}

interface MergeDbRow {
  id: string;
  programme_id: string;
  survivor_id: string;
  survivor_display_name: string | null;
  merged_id: string;
  merged_display_name: string | null;
  merged_by_user_id: string;
  created_at: Date;
  undo_until: Date;
  undone_at: Date | null;
  undone_by_user_id: string | null;
  survivor_reverted: boolean | null;
  undo_open: boolean;
}

/**
 * The parties' names, read from the contact rows (merged away or not: the
 * history is where a merged-away contact is found). A correlated subquery on
 * the merge's own tenant, programme and contact, never on caller input.
 */
const MERGE_COLUMNS = `m.id, m.programme_id, m.survivor_id, m.merged_id, m.merged_by_user_id,
  m.created_at, m.undo_until, m.undone_at, m.undone_by_user_id, m.survivor_reverted,
  m.undo_until > now() AS undo_open,
  (SELECT c.display_name FROM contact c
    WHERE c.tenant_id = m.tenant_id AND c.programme_id = m.programme_id AND c.id = m.survivor_id)
    AS survivor_display_name,
  (SELECT c.display_name FROM contact c
    WHERE c.tenant_id = m.tenant_id AND c.programme_id = m.programme_id AND c.id = m.merged_id)
    AS merged_display_name`;

function toRecord(row: MergeDbRow): ContactMergeRecord {
  return {
    id: row.id,
    programmeId: row.programme_id,
    survivorId: row.survivor_id,
    survivorDisplayName: row.survivor_display_name,
    mergedId: row.merged_id,
    mergedDisplayName: row.merged_display_name,
    mergedByUserId: row.merged_by_user_id,
    mergedAt: row.created_at,
    undoUntil: row.undo_until,
    undoneAt: row.undone_at,
    undoneByUserId: row.undone_by_user_id,
    survivorReverted: row.survivor_reverted,
    undoOpen: row.undo_open,
  };
}

/**
 * Records a merge as the session user, open for exactly 720 hours (the 0043
 * CHECK). `snapshot` is what undo restores; it is PII and is never read back
 * by anything that serves it.
 *
 * tenancy-reviewed: tenant and merger from the session, the programme checked
 * against it; RLS WITH CHECK and the restrictive merger policy besides.
 */
export async function insertContactMerge(
  tx: TenantTx,
  input: { programmeId: string; survivorId: string; mergedId: string; snapshot: unknown },
): Promise<ContactMergeRecord> {
  assertInScope(tx, input.programmeId);
  const id = newId();
  await tx.query(
    `INSERT INTO contact_merge (id, tenant_id, programme_id, survivor_id, merged_id,
                                merged_by_user_id, created_at, undo_until, snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now() + interval '720 hours', $7::jsonb)`,
    [
      id,
      tx.session.tenantId,
      input.programmeId,
      input.survivorId,
      input.mergedId,
      tx.session.userId,
      JSON.stringify(input.snapshot),
    ],
  );
  const record = await findContactMerge(tx, id);
  if (record === null) throw new Error('INSERT contact_merge returned no row');
  return record;
}

/**
 * One merge the session reaches, or null (another tenant's, another
 * programme's and an absent one alike).
 *
 * tenancy-reviewed: id AND tenant AND programme in scope; RLS besides.
 */
export async function findContactMerge(
  tx: TenantTx,
  id: string,
): Promise<ContactMergeRecord | null> {
  const rows = await tx.query<MergeDbRow>(
    `SELECT ${MERGE_COLUMNS}
       FROM contact_merge m
      WHERE m.id = $1 AND m.tenant_id = $2 AND m.programme_id = ANY($3::uuid[])`,
    [id, tx.session.tenantId, [...tx.session.programmeIds]],
  );
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

/**
 * The snapshot of an OPEN merge, locked FOR UPDATE until COMMIT, or null when
 * it has been undone meanwhile (the 0043 restrictive UPDATE policy hides an
 * undone merge from a locking read, so two undos cannot both proceed).
 *
 * tenancy-reviewed: as findContactMerge.
 */
export async function lockOpenMergeSnapshot(tx: TenantTx, id: string): Promise<unknown> {
  const rows = await tx.query<{ snapshot: unknown }>(
    `SELECT snapshot
       FROM contact_merge
      WHERE id = $1 AND tenant_id = $2 AND programme_id = ANY($3::uuid[]) AND undone_at IS NULL
      FOR UPDATE`,
    [id, tx.session.tenantId, [...tx.session.programmeIds]],
  );
  return rows[0]?.snapshot ?? null;
}

/**
 * Marks an open merge undone by the session user (the restrictive policy
 * pins the undoer). False when it was not open.
 *
 * tenancy-reviewed: as findContactMerge; RLS besides.
 */
export async function markContactMergeUndone(
  tx: TenantTx,
  id: string,
  survivorReverted: boolean,
): Promise<boolean> {
  const rows = await tx.query<{ id: string }>(
    `UPDATE contact_merge
        SET undone_at = now(), undone_by_user_id = $4, survivor_reverted = $5
      WHERE id = $1 AND tenant_id = $2 AND programme_id = ANY($3::uuid[]) AND undone_at IS NULL
      RETURNING id`,
    [id, tx.session.tenantId, [...tx.session.programmeIds], tx.session.userId, survivorReverted],
  );
  return rows.length > 0;
}

export interface ContactMergePageRows {
  data: ContactMergeRecord[];
  /** The last row's id when another page exists. */
  nextId: string | null;
}

/**
 * The merges of `programmeIds` (a subset of the session's scope: the API
 * passes those where the caller may write contacts), newest first, keyset on
 * (created_at, id). `afterId` is resolved inside the same programmes; one
 * naming anything else resolves to no row and the page is empty.
 *
 * tenancy-reviewed: tenant from the session, programmes intersected with the
 * session's in SQL; RLS besides.
 */
export async function listContactMerges(
  tx: TenantTx,
  programmeIds: readonly string[],
  limit: number,
  afterId: string | null,
): Promise<ContactMergePageRows> {
  const scope = programmeIds.filter((id) => tx.session.programmeIds.includes(id));
  if (scope.length === 0) return { data: [], nextId: null };
  const seek =
    afterId === null
      ? ''
      : `AND (m.created_at, m.id) < (
           SELECT p.created_at, p.id FROM contact_merge p
            WHERE p.id = $4::uuid AND p.tenant_id = $1 AND p.programme_id = ANY($2::uuid[]))`;
  const values: unknown[] = [tx.session.tenantId, scope, limit + 1];
  if (afterId !== null) values.push(afterId);
  const rows = await tx.query<MergeDbRow>(
    `SELECT ${MERGE_COLUMNS}
       FROM contact_merge m
      WHERE m.tenant_id = $1
        AND m.programme_id = ANY($2::uuid[])
        ${seek}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $3`,
    values,
  );
  const page = rows.slice(0, limit).map(toRecord);
  const last = page.at(-1);
  return { data: page, nextId: rows.length > limit && last !== undefined ? last.id : null };
}
