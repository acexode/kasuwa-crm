import type { TenantTx } from '@kasuwa/db';
import { z } from 'zod';

/**
 * The field-security matrix (T-0026): which permission set may read or edit
 * which field of one object.
 *
 * Semantics are D-P9 and D-L45, and they are why this file looks the way it
 * does:
 *
 *   - TWO axes, field and permission set. There is no programme anywhere in
 *     here, and that is a decision, not an omission (D-P9): programme scoping
 *     comes from user_programme carrying a permission set per assignment, so
 *     each decision is stored once. Metadata is tenant-scoped, not
 *     programme-scoped (0002 header); so is this.
 *   - A never-saved cell is `edit` (D-L45: today's effective behaviour, since
 *     no FLS is enforced yet). A locked set (Admin) is always `edit`.
 *   - A write is atomic: one unknown field or set, or one locked cell, and
 *     nothing in the request is applied.
 *   - The matrix never contains a field's data. It reads field_def,
 *     permission_set and field_security_grant only - never a record table.
 *
 * The pure functions (`buildFieldSecurityMatrix`, `planFieldSecurityChanges`)
 * hold the logic and are unit-tested without a database. The repository
 * functions below them only load and store.
 */

export const FIELD_ACCESS_LEVELS = ['none', 'read', 'edit'] as const;
export const fieldAccessLevelSchema = z.enum(FIELD_ACCESS_LEVELS);
export type FieldAccessLevel = z.infer<typeof fieldAccessLevelSchema>;

/** Mirrors field_def_classification_check (migration 0009). */
export const FIELD_CLASSIFICATIONS = ['none', 'pii', 'sensitive'] as const;
export const fieldClassificationSchema = z.enum(FIELD_CLASSIFICATIONS);
export type FieldClassification = z.infer<typeof fieldClassificationSchema>;

/** D-L45. Tightening this is a product decision, not a code change. */
export const DEFAULT_FIELD_ACCESS_LEVEL: FieldAccessLevel = 'edit';
/** "Admins always have full access." */
export const LOCKED_FIELD_ACCESS_LEVEL: FieldAccessLevel = 'edit';

export interface MatrixField {
  id: string;
  apiName: string;
  label: string;
  classification: FieldClassification;
}

export interface MatrixPermissionSet {
  id: string;
  /** The spec's `permissionSetId`: a stable string, unique per tenant. */
  key: string;
  locked: boolean;
}

export interface MatrixGrant {
  fieldId: string;
  /** permission_set.id (the uuid), not the key. */
  permissionSetId: string;
  level: FieldAccessLevel;
}

export interface FieldSecurityCell {
  permissionSetId: string;
  level: FieldAccessLevel;
  locked: boolean;
}

export interface FieldSecurityRow {
  fieldApiName: string;
  label: string;
  classification: FieldClassification;
  cells: FieldSecurityCell[];
}

/** `#/components/schemas/FieldSecurityMatrix`. */
export interface FieldSecurityMatrix {
  objectApiName: string;
  version: number;
  totalFieldCount: number;
  rows: FieldSecurityRow[];
}

export interface FieldSecurityFilter {
  /** Matches field label and api name, case-insensitively. */
  q?: string | undefined;
  /** Only `pii` and `sensitive` fields. */
  sensitiveOnly?: boolean | undefined;
}

/** One requested cell, as the client names it: api name and set key. */
export interface FieldSecurityChange {
  fieldApiName: string;
  permissionSetId: string;
  level: FieldAccessLevel;
}

/** One cell the write will store, with what it was before (for the audit row). */
export interface FieldSecurityCellWrite {
  fieldId: string;
  permissionSetId: string;
  fieldApiName: string;
  permissionSetKey: string;
  before: FieldAccessLevel;
  after: FieldAccessLevel;
}

export type FieldSecurityChangePlan =
  | { kind: 'apply'; writes: FieldSecurityCellWrite[] }
  /** A field or set the session cannot see - absent or another tenant's. */
  | { kind: 'not_found' }
  /** A change to a locked permission set. */
  | { kind: 'locked' };

const cellKey = (fieldId: string, permissionSetId: string) => `${fieldId}\u0000${permissionSetId}`;

function grantIndex(grants: readonly MatrixGrant[]): Map<string, FieldAccessLevel> {
  return new Map(
    grants.map((grant) => [cellKey(grant.fieldId, grant.permissionSetId), grant.level]),
  );
}

/** The level a cell shows: locked wins, then the stored decision, then the default. */
export function effectiveLevel(
  set: MatrixPermissionSet,
  stored: FieldAccessLevel | undefined,
): FieldAccessLevel {
  if (set.locked) return LOCKED_FIELD_ACCESS_LEVEL;
  return stored ?? DEFAULT_FIELD_ACCESS_LEVEL;
}

export function matchesFieldSecurityFilter(
  field: MatrixField,
  filter: FieldSecurityFilter,
): boolean {
  if (filter.sensitiveOnly === true && field.classification === 'none') return false;
  const q = filter.q?.trim().toLowerCase() ?? '';
  if (q === '') return true;
  return field.apiName.toLowerCase().includes(q) || field.label.toLowerCase().includes(q);
}

/**
 * The matrix for one object. One row per field (in the order given), one cell
 * per permission set (in the order given), and nothing else: no id, no tenant
 * id, no programme. `totalFieldCount` is before the filter - "14 of 14 fields".
 */
export function buildFieldSecurityMatrix(input: {
  objectApiName: string;
  version: number;
  fields: readonly MatrixField[];
  sets: readonly MatrixPermissionSet[];
  grants: readonly MatrixGrant[];
  filter?: FieldSecurityFilter;
}): FieldSecurityMatrix {
  const stored = grantIndex(input.grants);
  const filter = input.filter ?? {};
  return {
    objectApiName: input.objectApiName,
    version: input.version,
    totalFieldCount: input.fields.length,
    rows: input.fields
      .filter((field) => matchesFieldSecurityFilter(field, filter))
      .map((field) => ({
        fieldApiName: field.apiName,
        label: field.label,
        classification: field.classification,
        cells: input.sets.map((set) => ({
          permissionSetId: set.key,
          level: effectiveLevel(set, stored.get(cellKey(field.id, set.id))),
          locked: set.locked,
        })),
      })),
  };
}

/**
 * Resolves a request's changes against the object's fields and the tenant's
 * sets, all-or-nothing.
 *
 * Every change is checked before any is accepted, and an unknown name wins
 * over a locked one: "does this exist for you" is answered before "may you
 * change it", so the 403 can never confirm a name the 404 would have hidden.
 *
 * The same cell named twice keeps the last value. The HTTP boundary refuses
 * duplicates outright; this is the second layer, because a duplicate reaching
 * the upsert would fail the whole statement.
 */
export function planFieldSecurityChanges(input: {
  fields: readonly MatrixField[];
  sets: readonly MatrixPermissionSet[];
  grants: readonly MatrixGrant[];
  changes: readonly FieldSecurityChange[];
}): FieldSecurityChangePlan {
  const fields = new Map(input.fields.map((field) => [field.apiName, field]));
  const sets = new Map(input.sets.map((set) => [set.key, set]));
  const resolved: { field: MatrixField; set: MatrixPermissionSet; level: FieldAccessLevel }[] = [];

  for (const change of input.changes) {
    const field = fields.get(change.fieldApiName);
    const set = sets.get(change.permissionSetId);
    if (field === undefined || set === undefined) return { kind: 'not_found' };
    resolved.push({ field, set, level: change.level });
  }
  if (resolved.some((entry) => entry.set.locked)) return { kind: 'locked' };

  const stored = grantIndex(input.grants);
  const writes = new Map<string, FieldSecurityCellWrite>();
  for (const { field, set, level } of resolved) {
    const key = cellKey(field.id, set.id);
    writes.set(key, {
      fieldId: field.id,
      permissionSetId: set.id,
      fieldApiName: field.apiName,
      permissionSetKey: set.key,
      before: effectiveLevel(set, stored.get(key)),
      after: level,
    });
  }
  return { kind: 'apply', writes: [...writes.values()] };
}

// --- repository -----------------------------------------------------------
//
// tenancy-reviewed: every statement runs in the caller's tenant transaction
// and carries an explicit `tenant_id = $1` bound to `tx.session.tenantId` IN
// ADDITION to the RLS policy on each table - two independent layers, so a typo
// in one does not leak (CLAUDE.md 2.3). Nothing here reads a tenant or
// programme id from the caller. No SQL is built from user input: the object's
// api_name and every changed name are bound parameters, never identifiers.

const objectRowSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int(),
});

const fieldRowSchema = z.object({
  id: z.string().uuid(),
  api_name: z.string(),
  label: z.string(),
  classification: fieldClassificationSchema,
});

const setRowSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  locked: z.boolean(),
});

const grantRowSchema = z.object({
  field_id: z.string().uuid(),
  permission_set_id: z.string().uuid(),
  level: fieldAccessLevelSchema,
});

const tenantOf = (tx: TenantTx) => tx.session.tenantId;

async function loadObject(
  tx: TenantTx,
  objectApiName: string,
  lock: boolean,
): Promise<z.infer<typeof objectRowSchema> | null> {
  // FOR NO KEY UPDATE, not FOR UPDATE: it serialises matrix writers on this
  // object without blocking the FOR KEY SHARE every field_def foreign-key
  // check on object_def takes. Constant text either way - never user input.
  const rows = await tx.query(
    `SELECT id, field_security_version AS version
       FROM object_def
      WHERE tenant_id = $1 AND api_name = $2
      ${lock ? 'FOR NO KEY UPDATE' : ''}`,
    [tenantOf(tx), objectApiName],
  );
  const row = rows[0];
  return row === undefined ? null : objectRowSchema.parse(row);
}

async function loadFields(tx: TenantTx, objectId: string): Promise<MatrixField[]> {
  const rows = await tx.query(
    `SELECT id, api_name, label, classification
       FROM field_def
      WHERE tenant_id = $1 AND object_id = $2
      ORDER BY api_name`,
    [tenantOf(tx), objectId],
  );
  return rows.map((row) => {
    const parsed = fieldRowSchema.parse(row);
    return {
      id: parsed.id,
      apiName: parsed.api_name,
      label: parsed.label,
      classification: parsed.classification,
    };
  });
}

async function loadSets(tx: TenantTx): Promise<MatrixPermissionSet[]> {
  const rows = await tx.query(
    `SELECT id, key, locked
       FROM permission_set
      WHERE tenant_id = $1
      ORDER BY sort_order, key`,
    [tenantOf(tx)],
  );
  return rows.map((row) => setRowSchema.parse(row));
}

async function loadGrants(tx: TenantTx, objectId: string): Promise<MatrixGrant[]> {
  const rows = await tx.query(
    `SELECT g.field_id, g.permission_set_id, g.level
       FROM field_security_grant g
       JOIN field_def f
         ON f.tenant_id = g.tenant_id
        AND f.id = g.field_id
      WHERE g.tenant_id = $1
        AND f.tenant_id = $1
        AND f.object_id = $2`,
    [tenantOf(tx), objectId],
  );
  return rows.map((row) => {
    const parsed = grantRowSchema.parse(row);
    return {
      fieldId: parsed.field_id,
      permissionSetId: parsed.permission_set_id,
      level: parsed.level,
    };
  });
}

/**
 * The matrix for one object of the session's tenant, or `null` when the
 * session cannot see an object of that name - absent and another tenant's are
 * the same answer, so the caller can only ever say 404.
 */
export async function readFieldSecurityMatrix(
  tx: TenantTx,
  objectApiName: string,
  filter: FieldSecurityFilter = {},
): Promise<FieldSecurityMatrix | null> {
  const object = await loadObject(tx, objectApiName, false);
  if (object === null) return null;
  const [fields, sets, grants] = [
    await loadFields(tx, object.id),
    await loadSets(tx),
    await loadGrants(tx, object.id),
  ];
  return buildFieldSecurityMatrix({
    objectApiName,
    version: object.version,
    fields,
    sets,
    grants,
    filter,
  });
}

export type FieldSecurityWriteResult =
  | { kind: 'saved'; matrix: FieldSecurityMatrix; writes: FieldSecurityCellWrite[] }
  | { kind: 'not_found' }
  | { kind: 'locked' }
  | { kind: 'stale' };

/**
 * Applies a matrix write atomically, or applies nothing.
 *
 * Order: the object (404), then every change (404, then 403), then the
 * version (409). Nothing is written until all of them pass, and the object
 * row's lock is held from the first read to COMMIT, so two desks saving the
 * same object are serialised and the second one sees the first one's version.
 *
 * Returns the cells written, with their before and after levels, for the audit
 * writer - see the controller's D-L38 note.
 */
export async function writeFieldSecurityMatrix(
  tx: TenantTx,
  write: { objectApiName: string; version: number; changes: readonly FieldSecurityChange[] },
): Promise<FieldSecurityWriteResult> {
  const object = await loadObject(tx, write.objectApiName, true);
  if (object === null) return { kind: 'not_found' };

  const fields = await loadFields(tx, object.id);
  const sets = await loadSets(tx);
  const grants = await loadGrants(tx, object.id);

  const plan = planFieldSecurityChanges({ fields, sets, grants, changes: write.changes });
  if (plan.kind !== 'apply') return plan;
  if (write.version !== object.version) return { kind: 'stale' };

  await tx.query(
    `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
     SELECT $1::uuid, w.field_id, w.permission_set_id, w.level
       FROM unnest($2::uuid[], $3::uuid[], $4::text[]) AS w (field_id, permission_set_id, level)
     ON CONFLICT (tenant_id, field_id, permission_set_id)
     DO UPDATE SET level = EXCLUDED.level, updated_at = now()`,
    [
      tenantOf(tx),
      plan.writes.map((cell) => cell.fieldId),
      plan.writes.map((cell) => cell.permissionSetId),
      plan.writes.map((cell) => cell.after),
    ],
  );
  await tx.query(
    `UPDATE object_def
        SET field_security_version = field_security_version + 1
      WHERE tenant_id = $1 AND id = $2`,
    [tenantOf(tx), object.id],
  );

  // Re-read rather than patch the in-memory copy: the 200 body is then exactly
  // what the next GET returns, by construction.
  const matrix = await readFieldSecurityMatrix(tx, write.objectApiName);
  if (matrix === null) throw new Error('object_def vanished while its row was locked');
  return { kind: 'saved', matrix, writes: plan.writes };
}
