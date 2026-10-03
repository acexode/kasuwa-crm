import { newId, type TenantTx } from '@kasuwa/db';
import {
  createFieldDefInputSchema,
  createObjectDefInputSchema,
  fieldDefSchema,
  objectDefSchema,
  objectDefSummarySchema,
  parseFieldConfig,
  type CreateFieldDefInput,
  type CreateObjectDefInput,
  type FieldDef,
  type ObjectDef,
  type ObjectDefSummary,
} from './types';

/**
 * The metadata repository.
 *
 * Two rules hold in every function here:
 *
 *   1. It runs inside `withTenantTransaction`; there is no other connection and
 *      no evaluation context that can see more than the request does. RLS is
 *      the last line, so every statement ALSO filters on tenant_id explicitly —
 *      two independent layers, and a typo in one does not leak.
 *   2. `tenant_id` comes from `tx.session`, never from the caller's input. A
 *      caller that can name its own tenant is a tenancy bug.
 *
 * No SQL here is built by string concatenation from user input. api_names are
 * bound parameters, never identifiers.
 */

const OBJECT_COLUMNS = `id, tenant_id, api_name, label, plural_label, description,
                        is_custom, created_at, updated_at`;

const FIELD_COLUMNS = `id, tenant_id, object_id, api_name, label, type, description,
                       is_required, is_custom, config, created_at, updated_at`;

interface ObjectDefRow {
  id: string;
  tenant_id: string;
  api_name: string;
  label: string;
  plural_label: string | null;
  description: string | null;
  is_custom: boolean;
  created_at: Date;
  updated_at: Date;
  [key: string]: unknown;
}

interface FieldDefRow {
  id: string;
  tenant_id: string;
  object_id: string;
  api_name: string;
  label: string;
  type: string;
  description: string | null;
  is_required: boolean;
  is_custom: boolean;
  config: unknown;
  created_at: Date;
  updated_at: Date;
  [key: string]: unknown;
}

/** The api_name is already taken on this tenant (and object, for a field). */
export class DuplicateApiNameError extends Error {
  constructor(apiName: string) {
    super(`api_name ${apiName} is already in use`);
    this.name = 'DuplicateApiNameError';
  }
}

/**
 * No such object definition *in reach of this session*.
 *
 * Deliberately does not distinguish "does not exist" from "belongs to another
 * tenant": errors must not leak existence, so this maps to 404, never 403.
 */
export class UnknownObjectDefError extends Error {
  constructor(objectId: string) {
    super(`No object definition ${objectId}`);
    this.name = 'UnknownObjectDefError';
  }
}

function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function toObjectDef(row: ObjectDefRow): ObjectDef {
  return objectDefSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    apiName: row.api_name,
    label: row.label,
    pluralLabel: row.plural_label,
    description: row.description,
    isCustom: row.is_custom,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toFieldDef(row: FieldDefRow): FieldDef {
  return fieldDefSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    objectId: row.object_id,
    apiName: row.api_name,
    label: row.label,
    type: row.type,
    description: row.description,
    isRequired: row.is_required,
    isCustom: row.is_custom,
    config: row.config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export async function createObjectDef(
  tx: TenantTx,
  input: CreateObjectDefInput,
): Promise<ObjectDef> {
  const parsed = createObjectDefInputSchema.parse(input);
  try {
    const rows = await tx.query<ObjectDefRow>(
      `INSERT INTO object_def (id, tenant_id, api_name, label, plural_label, description, is_custom)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${OBJECT_COLUMNS}`,
      [
        parsed.id ?? newId(),
        tx.session.tenantId,
        parsed.apiName,
        parsed.label,
        parsed.pluralLabel ?? null,
        parsed.description ?? null,
        parsed.isCustom,
      ],
    );
    const row = rows[0];
    if (row === undefined) {
      // RLS rejected the WITH CHECK. Unreachable while tenant_id comes from
      // the session, which is why it throws rather than returning null.
      throw new Error('object_def insert produced no row');
    }
    return toObjectDef(row);
  } catch (error) {
    if (pgErrorCode(error) === '23505') {
      throw new DuplicateApiNameError(parsed.apiName);
    }
    throw error;
  }
}

export async function getObjectDefById(tx: TenantTx, id: string): Promise<ObjectDef | null> {
  const rows = await tx.query<ObjectDefRow>(
    `SELECT ${OBJECT_COLUMNS} FROM object_def WHERE tenant_id = $1 AND id = $2`,
    [tx.session.tenantId, id],
  );
  const row = rows[0];
  return row === undefined ? null : toObjectDef(row);
}

export async function getObjectDefByApiName(
  tx: TenantTx,
  apiName: string,
): Promise<ObjectDef | null> {
  const rows = await tx.query<ObjectDefRow>(
    `SELECT ${OBJECT_COLUMNS} FROM object_def WHERE tenant_id = $1 AND api_name = $2`,
    [tx.session.tenantId, apiName],
  );
  const row = rows[0];
  return row === undefined ? null : toObjectDef(row);
}

/**
 * Every object definition the tenant has — not only those of the caller's
 * programmes. See the migration header: metadata is not programme-scoped.
 */
export async function listObjectDefs(tx: TenantTx): Promise<ObjectDef[]> {
  const rows = await tx.query<ObjectDefRow>(
    `SELECT ${OBJECT_COLUMNS} FROM object_def WHERE tenant_id = $1 ORDER BY api_name`,
    [tx.session.tenantId],
  );
  return rows.map(toObjectDef);
}

interface ObjectDefSummaryRow {
  api_name: string;
  label: string;
  field_count: number;
  [key: string]: unknown;
}

/**
 * Every object definition the tenant has, with how many fields each carries.
 *
 * Tenant-wide, not programme-wide (see the 0002 header). An object with no
 * fields is listed with a count of zero rather than dropped: it is still a tab
 * on the field-security screen.
 *
 * Both sides of the join filter on the session's tenant explicitly, so RLS is
 * the second line here and not the only one. `count(...)::int` because a
 * bigint arrives from pg as a string; a definition catalogue never approaches
 * 2^31 fields per object.
 */
export async function listObjectDefSummaries(tx: TenantTx): Promise<ObjectDefSummary[]> {
  const rows = await tx.query<ObjectDefSummaryRow>(
    `SELECT o.api_name, o.label, count(f.id)::int AS field_count
       FROM object_def o
       LEFT JOIN field_def f
         ON f.tenant_id = o.tenant_id
        AND f.object_id = o.id
        AND f.tenant_id = $1
      WHERE o.tenant_id = $1
      GROUP BY o.id, o.api_name, o.label
      ORDER BY o.api_name`,
    [tx.session.tenantId],
  );
  return rows.map((row) =>
    objectDefSummarySchema.parse({
      apiName: row.api_name,
      label: row.label,
      fieldCount: row.field_count,
    }),
  );
}

export async function createFieldDef(tx: TenantTx, input: CreateFieldDefInput): Promise<FieldDef> {
  const parsed = createFieldDefInputSchema.parse(input);
  const config = parseFieldConfig(parsed.type, parsed.config);

  // Resolve the parent inside the session's own scope first, so the caller gets
  // "no such object" rather than a raw constraint violation. The composite
  // foreign key in the migration is what actually makes a cross-tenant parent
  // impossible; this check is the readable half of the same guarantee.
  const parent = await getObjectDefById(tx, parsed.objectId);
  if (parent === null) {
    throw new UnknownObjectDefError(parsed.objectId);
  }

  try {
    const rows = await tx.query<FieldDefRow>(
      `INSERT INTO field_def
         (id, tenant_id, object_id, api_name, label, type, description, is_required, is_custom, config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       RETURNING ${FIELD_COLUMNS}`,
      [
        parsed.id ?? newId(),
        tx.session.tenantId,
        parsed.objectId,
        parsed.apiName,
        parsed.label,
        parsed.type,
        parsed.description ?? null,
        parsed.isRequired,
        parsed.isCustom,
        JSON.stringify(config),
      ],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('field_def insert produced no row');
    }
    return toFieldDef(row);
  } catch (error) {
    const code = pgErrorCode(error);
    if (code === '23505') {
      throw new DuplicateApiNameError(parsed.apiName);
    }
    if (code === '23503') {
      throw new UnknownObjectDefError(parsed.objectId);
    }
    throw error;
  }
}

export async function listFieldDefs(tx: TenantTx, objectId: string): Promise<FieldDef[]> {
  const rows = await tx.query<FieldDefRow>(
    `SELECT ${FIELD_COLUMNS}
       FROM field_def
      WHERE tenant_id = $1 AND object_id = $2
      ORDER BY api_name`,
    [tx.session.tenantId, objectId],
  );
  return rows.map(toFieldDef);
}
