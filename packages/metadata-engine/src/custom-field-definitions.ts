import { newId, type TenantTx } from '@kasuwa/db';
import {
  CUSTOM_FIELD_LIMITS,
  CUSTOM_FIELD_OBJECTS,
  isCustomFieldKey,
  isCustomFieldObject,
  type CustomFieldObject,
  type CustomFieldType,
} from './custom-fields';
import type { FieldClassification } from './field-security';

/**
 * Custom field DEFINITIONS on the four standard objects, for the admin API
 * (T-0089; ADR-0016 items 4 and 9; D-L128, D-L138, D-L140, D-L141).
 *
 * READ THIS BEFORE "FIXING" THE MISSING programme_id. A definition belongs to
 * the tenant, not to a programme (ADR-0008, the 0002 header): a field one
 * admin defines is the same field in every programme. Nothing here takes or
 * adds a programme predicate, deliberately.
 *
 * Every statement runs on the request's TenantTx and filters on the session's
 * tenant explicitly, with RLS besides (CLAUDE.md 2.1, 2.3). Nothing takes a
 * tenant id from its caller. Every value is a bound parameter; no api_name is
 * ever an identifier.
 *
 * What these functions do NOT decide: permission (the caller checks
 * `custom_field.write` before calling), and the shape of a body (the API's
 * Zod schema). They do decide what only the database can answer: whether a
 * name is taken, how many definitions an object holds, and which row an id
 * names.
 */

export interface CustomFieldPicklistValue {
  value: string;
  label: string;
}

/** `#/components/schemas/CustomFieldDefinition` (admin.openapi.yaml), before serialisation. */
export interface CustomFieldDefinition {
  id: string;
  objectApiName: CustomFieldObject;
  apiName: string;
  label: string;
  description: string | null;
  type: CustomFieldType;
  classification: FieldClassification;
  config: Record<string, unknown>;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface DefinitionRow {
  id: string;
  object_api_name: string;
  api_name: string;
  label: string;
  description: string | null;
  type: string;
  classification: string;
  config: unknown;
  retired_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * A stored row that is not a Phase 2 custom field of a standard object.
 * The queries below only ever select such rows; this is the second check.
 * Carries no value.
 */
export class CustomFieldDefinitionShapeError extends Error {
  constructor() {
    super('A custom field definition row does not have the expected shape');
    this.name = 'CustomFieldDefinitionShapeError';
  }
}

function toDefinition(row: DefinitionRow): CustomFieldDefinition {
  if (!isCustomFieldObject(row.object_api_name) || !isCustomFieldKey(row.api_name)) {
    throw new CustomFieldDefinitionShapeError();
  }
  return {
    id: row.id,
    objectApiName: row.object_api_name,
    apiName: row.api_name,
    label: row.label,
    description: row.description,
    type: row.type as CustomFieldType,
    classification: row.classification as FieldClassification,
    config:
      typeof row.config === 'object' && row.config !== null && !Array.isArray(row.config)
        ? (row.config as Record<string, unknown>)
        : {},
    retiredAt: row.retired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The columns, and the join that ties a field to a STANDARD object of the
 * four. tenancy-reviewed: joined on (tenant_id, id), the composite key of
 * 0002, so a field can only ever be paired with its own tenant's object.
 */
const SELECT_DEFINITION = `
  SELECT f.id, o.api_name AS object_api_name, f.api_name, f.label, f.description,
         f.type, f.classification, f.config, f.retired_at, f.created_at, f.updated_at
    FROM field_def f
    JOIN object_def o
      ON o.tenant_id = f.tenant_id AND o.id = f.object_id`;

/** Only custom fields of the four standard objects: anything else is outside this API (A3). */
const MANAGED = `f.is_custom AND NOT o.is_custom AND o.api_name = ANY ($2::text[])`;

/** The row's object is a standard one (a custom object's fields are outside this API, A3). */
const ON_STANDARD_OBJECT = `EXISTS (
          SELECT 1 FROM object_def o
           WHERE o.tenant_id = field_def.tenant_id AND o.id = field_def.object_id AND NOT o.is_custom)`;

/**
 * The object's custom fields, by api name: active ones, plus the retired ones
 * when asked (D-L140). Null when the tenant has no standard definition of the
 * object (the one 404).
 */
export async function listCustomFieldDefinitions(
  tx: TenantTx,
  object: CustomFieldObject,
  includeRetired: boolean,
): Promise<CustomFieldDefinition[] | null> {
  const tenantId = tx.session.tenantId;
  const objects = await tx.query<{ id: string }>(
    `SELECT id FROM object_def WHERE tenant_id = $1 AND api_name = $2 AND NOT is_custom`,
    [tenantId, object],
  );
  if (objects.length === 0) return null;
  const rows = await tx.query<DefinitionRow>(
    `${SELECT_DEFINITION}
      WHERE f.tenant_id = $1 AND ${MANAGED}
        AND o.api_name = $3
        AND ($4::boolean OR f.retired_at IS NULL)
      ORDER BY f.api_name`,
    [tenantId, [...CUSTOM_FIELD_OBJECTS], object, includeRetired],
  );
  return rows.map(toDefinition);
}

/**
 * One custom field of a standard object, by id, in the session's tenant; null
 * for anything else (another tenant's field, a standard field, a custom
 * object's field, an id that names nothing): the caller answers all of them
 * with the one 404. `forUpdate` locks the row for a read-modify-write.
 */
export async function findCustomFieldDefinition(
  tx: TenantTx,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<CustomFieldDefinition | null> {
  const rows = await tx.query<DefinitionRow>(
    `${SELECT_DEFINITION}
      WHERE f.tenant_id = $1 AND ${MANAGED} AND f.id = $3
      ${options.forUpdate === true ? 'FOR UPDATE OF f' : ''}`,
    [tx.session.tenantId, [...CUSTOM_FIELD_OBJECTS], id],
  );
  const row = rows[0];
  return row === undefined ? null : toDefinition(row);
}

export interface NewCustomFieldDefinition {
  objectApiName: CustomFieldObject;
  apiName: string;
  label: string;
  description: string | null;
  type: CustomFieldType;
  classification: FieldClassification;
  config: Record<string, unknown>;
}

export type CreateCustomFieldResult =
  | { kind: 'created'; definition: CustomFieldDefinition }
  | { kind: 'no_object' }
  | { kind: 'duplicate' }
  | { kind: 'limit_reached' };

/**
 * Defines a custom field. In one transaction, in this order:
 *
 *   1. the object row is locked (its matrix version is bumped: the matrix
 *      gains a row), which serialises every create on this object, so the
 *      limit check below cannot be raced past;
 *   2. a name already taken on the object, by a live or a RETIRED field, is
 *      `duplicate` (a retired name stays taken for ever, ADR-0016 item 9);
 *   3. 100 active fields, or 500 definitions counting retired ones, is
 *      `limit_reached` (D-L128 Q1, D-L140);
 *   4. the row is inserted, custom and never required;
 *   5. a `pii` or `sensitive` field starts at `none` for every UNLOCKED
 *      permission set of the tenant, a tenant-made one included (D-L128 Q2).
 *      The locked admin set keeps `edit` (no row is ever stored for it), and a
 *      `none` field stores nothing, so every cell is the D-L45 `edit`.
 *
 * tenancy-reviewed: tenant from the session in every statement; the object is
 * matched on (tenant_id, api_name) and the field inserted with that object's
 * id and the same tenant, which the composite FK requires anyway; the grants
 * pair the new field with the tenant's own permission sets only.
 */
export async function createCustomFieldDefinition(
  tx: TenantTx,
  input: NewCustomFieldDefinition,
): Promise<CreateCustomFieldResult> {
  if (!isCustomFieldObject(input.objectApiName) || !isCustomFieldKey(input.apiName)) {
    throw new CustomFieldDefinitionShapeError();
  }
  const tenantId = tx.session.tenantId;
  const locked = await tx.query<{ id: string }>(
    `UPDATE object_def
        SET field_security_version = field_security_version + 1
      WHERE tenant_id = $1 AND api_name = $2 AND NOT is_custom
      RETURNING id`,
    [tenantId, input.objectApiName],
  );
  const objectId = locked[0]?.id;
  if (objectId === undefined) return { kind: 'no_object' };

  const taken = await tx.query<{ ok: number }>(
    `SELECT 1 AS ok FROM field_def WHERE tenant_id = $1 AND object_id = $2 AND api_name = $3`,
    [tenantId, objectId, input.apiName],
  );
  if (taken.length > 0) return { kind: 'duplicate' };

  const [counts] = await tx.query<{ active: number; total: number }>(
    `SELECT count(*) FILTER (WHERE retired_at IS NULL)::int AS active, count(*)::int AS total
       FROM field_def
      WHERE tenant_id = $1 AND object_id = $2 AND is_custom`,
    [tenantId, objectId],
  );
  if (
    (counts?.active ?? 0) >= CUSTOM_FIELD_LIMITS.fieldsPerObject ||
    (counts?.total ?? 0) >= CUSTOM_FIELD_LIMITS.definitionsPerObject
  ) {
    return { kind: 'limit_reached' };
  }

  const id = newId();
  await tx.query(
    `INSERT INTO field_def
       (id, tenant_id, object_id, api_name, label, description, type, classification,
        is_required, is_custom, config)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, true, $9::jsonb)`,
    [
      id,
      tenantId,
      objectId,
      input.apiName,
      input.label,
      input.description,
      input.type,
      input.classification,
      JSON.stringify(input.config),
    ],
  );
  if (input.classification !== 'none') {
    await tx.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
       SELECT $1, $2, ps.id, 'none'
         FROM permission_set ps
        WHERE ps.tenant_id = $1 AND NOT ps.locked`,
      [tenantId, id],
    );
  }
  const definition = await findCustomFieldDefinition(tx, id);
  if (definition === null) throw new CustomFieldDefinitionShapeError();
  return { kind: 'created', definition };
}

export interface CustomFieldDefinitionChanges {
  label?: string | undefined;
  description?: string | null | undefined;
  classification?: FieldClassification | undefined;
  /** The whole new config (picklist values added or relabelled by the caller). */
  config?: Record<string, unknown> | undefined;
}

/**
 * Applies `changes` to a LIVE custom field of a standard object; null when no
 * such row matched. Type, api name and object are never written (0039's
 * trigger refuses a type change for kasuwa_app in any case). Reclassifying
 * never touches field_security_grant (D-L138). `updated_at` moves through
 * 0018's touch trigger.
 *
 * tenancy-reviewed: id AND tenant (session) AND custom AND live; RLS besides.
 */
export async function updateCustomFieldDefinition(
  tx: TenantTx,
  id: string,
  changes: CustomFieldDefinitionChanges,
): Promise<CustomFieldDefinition | null> {
  const values: unknown[] = [id, tx.session.tenantId];
  const sets: string[] = [];
  // Column names come from this constant list only.
  const columns: [keyof CustomFieldDefinitionChanges, string, string][] = [
    ['label', 'label', 'text'],
    ['description', 'description', 'text'],
    ['classification', 'classification', 'text'],
    ['config', 'config', 'jsonb'],
  ];
  for (const [key, column, cast] of columns) {
    const value = changes[key];
    if (value === undefined) continue;
    values.push(cast === 'jsonb' ? JSON.stringify(value) : value);
    sets.push(`${column} = $${values.length}::${cast}`);
  }
  if (sets.length === 0) return findCustomFieldDefinition(tx, id);
  const rows = await tx.query<{ id: string }>(
    `UPDATE field_def
        SET ${sets.join(', ')}
      WHERE id = $1 AND tenant_id = $2 AND is_custom AND retired_at IS NULL
        AND ${ON_STANDARD_OBJECT}
      RETURNING id`,
    values,
  );
  if (rows.length === 0) return null;
  return findCustomFieldDefinition(tx, id);
}

/**
 * Retires a live custom field (ADR-0016 item 9): `retired_at` is set to the
 * transaction's time, the row stays, and its name stays taken. Returns the
 * retired definition, or null when no live row matched (already retired, or
 * nothing in reach): the caller has already told those apart.
 *
 * tenancy-reviewed: id AND tenant (session) AND custom AND live; RLS besides.
 */
export async function retireCustomFieldDefinition(
  tx: TenantTx,
  id: string,
): Promise<CustomFieldDefinition | null> {
  const rows = await tx.query<{ id: string }>(
    `UPDATE field_def
        SET retired_at = now()
      WHERE id = $1 AND tenant_id = $2 AND is_custom AND retired_at IS NULL
        AND ${ON_STANDARD_OBJECT}
      RETURNING id`,
    [id, tx.session.tenantId],
  );
  if (rows.length === 0) return null;
  return findCustomFieldDefinition(tx, id);
}
