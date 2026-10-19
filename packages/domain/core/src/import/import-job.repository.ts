import type { TenantTx } from '@kasuwa/db';
import { decodeIdCursor, encodeIdCursor } from '../cursor';
import type { DefaultCountry } from '../contact/phone';

/**
 * `import_job` (migration 0042, T-0094; ADR-0017 flow steps 1-7).
 *
 * Read and written by the import API (apps/api) and the import worker
 * (apps/worker), both inside `withTenantTransaction`, the worker AS THE
 * CREATOR (D-L128 Q7, D-L151). Two layers (CLAUDE.md 2.3): RLS on the table,
 * and every statement here filters on `tx.session`'s tenant and programmes.
 *
 * What a job holds is metadata: the declaration, column NAMES, the saved
 * mapping, counts and `{ row, column, code }` errors. Never a cell value
 * (ADR-0017 Decision 4). `filename`, `headers` and `mapping` are user text and
 * are never logged; they are erased with the raw file (D-L148).
 *
 * The record carries `uploadId` for the server's own use (complete, resume,
 * abort). The wire shapes (`toImportWire`, `toImportSummaryWire`) never carry
 * it (D-L155).
 *
 * Nothing here logs.
 */

export const IMPORT_STATUSES = [
  'awaiting_upload',
  'reading_header',
  'awaiting_mapping',
  'queued',
  'running',
  'finished',
  'failed',
  'rejected',
  'cancelled',
  'expired',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** Statuses after which nothing moves but retention's erasure. */
export const TERMINAL_IMPORT_STATUSES: readonly ImportStatus[] = [
  'finished',
  'failed',
  'rejected',
  'cancelled',
  'expired',
];

export function isTerminalImportStatus(status: ImportStatus): boolean {
  return TERMINAL_IMPORT_STATUSES.includes(status);
}

/** The closed row-error codes (records.openapi.yaml ImportRowErrorCode). */
export const IMPORT_ROW_ERROR_CODES = [
  'required',
  'invalid_value',
  'invalid_phone',
  'invalid_email',
  'too_long',
  'unknown_value',
  'unknown_field',
  'custom_too_large',
  'possible_duplicate',
  'consent_grant_refused',
  'field_not_editable',
  'row_too_large',
  'too_many_rows',
] as const;
export type ImportRowErrorCode = (typeof IMPORT_ROW_ERROR_CODES)[number];

export interface ImportRowError {
  readonly row: number;
  readonly column: number | null;
  readonly code: ImportRowErrorCode;
}

export interface ImportColumnMapping {
  readonly index: number;
  readonly field: string | null;
}

export interface ImportMapping {
  readonly columns: readonly ImportColumnMapping[];
  readonly defaultCountry: DefaultCountry;
  readonly ownerUserId: string | null;
}

export interface ImportCounts {
  readonly created: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface ImportJob {
  readonly id: string;
  readonly tenantId: string;
  readonly programmeId: string;
  readonly storedObjectId: string;
  readonly createdByUserId: string;
  readonly status: ImportStatus;
  /** The open multipart upload. Server-side only: never on the wire. */
  readonly uploadId: string | null;
  readonly filename: string | null;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly partCount: number;
  readonly headers: readonly string[] | null;
  readonly suggestedMapping: readonly ImportColumnMapping[] | null;
  readonly mapping: ImportMapping | null;
  readonly counts: ImportCounts;
  readonly errors: readonly ImportRowError[];
  readonly errorsTruncated: boolean;
  readonly cancelRequested: boolean;
  readonly rawFileDeletedAt: Date | null;
  readonly uploadedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
  readonly changedAt: Date;
}

interface ImportJobRow {
  id: string;
  tenant_id: string;
  programme_id: string;
  stored_object_id: string;
  created_by_user_id: string;
  status: string;
  upload_id: string | null;
  filename: string | null;
  size_bytes: string | number;
  content_type: string;
  part_count: number;
  headers: unknown;
  suggested_mapping: unknown;
  mapping: unknown;
  created_count: number;
  skipped_count: number;
  failed_count: number;
  errors: unknown;
  errors_truncated: boolean;
  cancel_requested: boolean;
  raw_file_deleted_at: Date | null;
  uploaded_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  changed_at: Date;
  [column: string]: unknown;
}

const COLUMNS = `id, tenant_id, programme_id, stored_object_id, created_by_user_id, status,
  upload_id, filename, size_bytes, content_type, part_count, headers, suggested_mapping,
  mapping, created_count, skipped_count, failed_count, errors, errors_truncated,
  cancel_requested, raw_file_deleted_at, uploaded_at, finished_at, created_at, changed_at`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function asStatus(value: string): ImportStatus {
  return (IMPORT_STATUSES as readonly string[]).includes(value) ? (value as ImportStatus) : 'failed';
}

function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : null;
}

function asColumns(value: unknown): ImportColumnMapping[] | null {
  if (!Array.isArray(value)) return null;
  const out: ImportColumnMapping[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const { index, field } = item as { index?: unknown; field?: unknown };
    if (typeof index !== 'number' || !(field === null || typeof field === 'string')) return null;
    out.push({ index, field });
  }
  return out;
}

function asMapping(value: unknown): ImportMapping | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { columns, defaultCountry, ownerUserId } = value as Record<string, unknown>;
  const parsed = asColumns(columns);
  if (parsed === null || typeof defaultCountry !== 'string') return null;
  return {
    columns: parsed,
    defaultCountry: defaultCountry as DefaultCountry,
    ownerUserId: typeof ownerUserId === 'string' ? ownerUserId : null,
  };
}

function asErrors(value: unknown): ImportRowError[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter(
    (item): item is ImportRowError =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as ImportRowError).row === 'number' &&
      typeof (item as ImportRowError).code === 'string',
  );
}

function toJob(row: ImportJobRow): ImportJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    programmeId: row.programme_id,
    storedObjectId: row.stored_object_id,
    createdByUserId: row.created_by_user_id,
    status: asStatus(row.status),
    uploadId: row.upload_id,
    filename: row.filename,
    sizeBytes: Number(row.size_bytes),
    contentType: row.content_type,
    partCount: row.part_count,
    headers: asStringArray(row.headers),
    suggestedMapping: asColumns(row.suggested_mapping),
    mapping: asMapping(row.mapping),
    counts: { created: row.created_count, skipped: row.skipped_count, failed: row.failed_count },
    errors: asErrors(row.errors),
    errorsTruncated: row.errors_truncated,
    cancelRequested: row.cancel_requested,
    rawFileDeletedAt: row.raw_file_deleted_at,
    uploadedAt: row.uploaded_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    changedAt: row.changed_at,
  };
}

/**
 * The job, read in the caller's scope, or null (another tenant's, another
 * programme's, an invented or malformed id). `forUpdate` locks the row for
 * the rest of the transaction, so a status move is decided on what is there.
 *
 * tenancy-reviewed: explicit tenant and programme filters from tx.session,
 * beside RLS (CLAUDE.md 2.3).
 */
export async function findImportJob(
  tx: TenantTx,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<ImportJob | null> {
  const { tenantId, programmeIds } = tx.session;
  if (!UUID.test(id) || programmeIds.length === 0) return null;
  const rows = await tx.query<ImportJobRow>(
    `SELECT ${COLUMNS} FROM import_job
      WHERE id = $1 AND tenant_id = $2 AND programme_id = ANY ($3::uuid[])
      ${options.forUpdate === true ? 'FOR UPDATE' : ''}`,
    [id, tenantId, [...programmeIds]],
  );
  const row = rows[0];
  return row === undefined ? null : toJob(row);
}

export interface NewImportJob {
  readonly id: string;
  readonly programmeId: string;
  readonly storedObjectId: string;
  readonly uploadId: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly partCount: number;
}

/** Thrown for a programme outside the session. The API answers 404 before this. */
export class ImportProgrammeOutOfScopeError extends Error {
  constructor() {
    super('Refusing to write an import in a programme outside the session scope');
    this.name = 'ImportProgrammeOutOfScopeError';
  }
}

/**
 * Inserts a job `awaiting_upload`, created by the session's user (the
 * restrictive INSERT policy re-checks it).
 *
 * tenancy-reviewed: tenant and creator from the session; the programme
 * checked against the session; RLS WITH CHECK refuses either independently.
 */
export async function insertImportJob(tx: TenantTx, input: NewImportJob): Promise<ImportJob> {
  if (!tx.session.programmeIds.includes(input.programmeId)) throw new ImportProgrammeOutOfScopeError();
  const rows = await tx.query<ImportJobRow>(
    `INSERT INTO import_job (id, tenant_id, programme_id, stored_object_id, created_by_user_id,
                             status, upload_id, filename, size_bytes, content_type, part_count)
     VALUES ($1, $2, $3, $4, $5, 'awaiting_upload', $6, $7, $8, $9, $10)
     RETURNING ${COLUMNS}`,
    [
      input.id,
      tx.session.tenantId,
      input.programmeId,
      input.storedObjectId,
      tx.session.userId,
      input.uploadId,
      input.filename,
      input.sizeBytes,
      input.contentType,
      input.partCount,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('INSERT ... RETURNING returned no row');
  return toJob(row);
}

/** The mutable columns, as the repository names them. Never a key, the creator or the declaration. */
export interface ImportJobPatch {
  status?: ImportStatus;
  uploadId?: string | null;
  filename?: string | null;
  headers?: readonly string[] | null;
  suggestedMapping?: readonly ImportColumnMapping[] | null;
  mapping?: ImportMapping | null;
  counts?: ImportCounts;
  errors?: readonly ImportRowError[];
  errorsTruncated?: boolean;
  cancelRequested?: boolean;
  rawFileDeletedAt?: 'now';
  uploadedAt?: 'now';
  finishedAt?: 'now';
}

const JSON_COLUMNS = { headers: 'headers', suggestedMapping: 'suggested_mapping', mapping: 'mapping' } as const;

/**
 * Applies `patch` to one job in scope and returns it, or null when the row is
 * not visible (the creator lost the programme, D-L160). `changed_at` moves
 * with every update.
 *
 * tenancy-reviewed: id AND tenant AND the session's programmes, beside RLS;
 * SET names only the mutable columns kasuwa_app may update (0042's grants).
 */
export async function updateImportJob(
  tx: TenantTx,
  id: string,
  patch: ImportJobPatch,
): Promise<ImportJob | null> {
  const values: unknown[] = [id, tx.session.tenantId, [...tx.session.programmeIds]];
  const add = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const sets: string[] = ['changed_at = now()'];
  if (patch.status !== undefined) sets.push(`status = ${add(patch.status)}`);
  if (patch.uploadId !== undefined) sets.push(`upload_id = ${add(patch.uploadId)}`);
  if (patch.filename !== undefined) sets.push(`filename = ${add(patch.filename)}`);
  for (const [key, column] of Object.entries(JSON_COLUMNS) as [keyof typeof JSON_COLUMNS, string][]) {
    const value = patch[key];
    if (value !== undefined) {
      sets.push(`${column} = ${add(value === null ? null : JSON.stringify(value))}::jsonb`);
    }
  }
  if (patch.counts !== undefined) {
    sets.push(
      `created_count = ${add(patch.counts.created)}`,
      `skipped_count = ${add(patch.counts.skipped)}`,
      `failed_count = ${add(patch.counts.failed)}`,
    );
  }
  if (patch.errors !== undefined) sets.push(`errors = ${add(JSON.stringify(patch.errors))}::jsonb`);
  if (patch.errorsTruncated !== undefined) sets.push(`errors_truncated = ${add(patch.errorsTruncated)}`);
  if (patch.cancelRequested !== undefined) sets.push(`cancel_requested = ${add(patch.cancelRequested)}`);
  if (patch.rawFileDeletedAt === 'now') sets.push('raw_file_deleted_at = now()');
  if (patch.uploadedAt === 'now') sets.push('uploaded_at = now()');
  if (patch.finishedAt === 'now') sets.push('finished_at = coalesce(finished_at, now())');
  const rows = await tx.query<ImportJobRow>(
    `UPDATE import_job SET ${sets.join(', ')}
      WHERE id = $1 AND tenant_id = $2 AND programme_id = ANY ($3::uuid[])
      RETURNING ${COLUMNS}`,
    values,
  );
  const row = rows[0];
  return row === undefined ? null : toJob(row);
}

/**
 * One page of imports in `programmeIds` (the programmes where the caller holds
 * `contact.import`, already a subset of the session's), newest first, keyset
 * on (created_at, id). The cursor is a position (an id), never authority: it
 * is resolved inside the same scope, and a cursor naming a row the caller
 * cannot see answers an empty page.
 *
 * tenancy-reviewed: tenant from the session, programmes intersected with the
 * session's, RLS besides.
 */
export async function listImportJobs(
  tx: TenantTx,
  programmeIds: readonly string[],
  options: { limit: number; cursor?: string | undefined },
): Promise<{ data: ImportJob[]; nextCursor: string | null }> {
  const scoped = programmeIds.filter((id) => tx.session.programmeIds.includes(id));
  if (scoped.length === 0) return { data: [], nextCursor: null };
  const values: unknown[] = [tx.session.tenantId, scoped];
  const where = ['tenant_id = $1', 'programme_id = ANY ($2::uuid[])'];
  if (options.cursor !== undefined) {
    const id = decodeIdCursor(options.cursor);
    values.push(id);
    where.push(`(created_at, id) < (
      SELECT c.created_at, c.id FROM import_job c
       WHERE c.id = $${values.length}::uuid AND c.tenant_id = $1 AND c.programme_id = ANY ($2::uuid[]))`);
  }
  values.push(options.limit + 1);
  const rows = await tx.query<ImportJobRow>(
    `SELECT ${COLUMNS} FROM import_job
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}`,
    values,
  );
  const hasMore = rows.length > options.limit;
  const page = (hasMore ? rows.slice(0, options.limit) : rows).map(toJob);
  const last = page.at(-1);
  return { data: page, nextCursor: hasMore && last !== undefined ? encodeIdCursor(last.id) : null };
}

// --- the wire ------------------------------------------------------------------

export interface ImportSummaryWire {
  id: string;
  programmeId: string;
  status: ImportStatus;
  filename: string | null;
  sizeBytes: number;
  counts: ImportCounts;
  rawFileDeletedAt: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface ImportWire extends ImportSummaryWire {
  contentType: string;
  headers: string[] | null;
  suggestedMapping: ImportColumnMapping[] | null;
  mapping: ImportMapping | null;
  errors: ImportRowError[];
  errorsTruncated: boolean;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** `ImportSummary`: no headers, mapping, errors or upload id. */
export function toImportSummaryWire(job: ImportJob): ImportSummaryWire {
  return {
    id: job.id,
    programmeId: job.programmeId,
    status: job.status,
    filename: job.rawFileDeletedAt === null ? job.filename : null,
    sizeBytes: job.sizeBytes,
    counts: { ...job.counts },
    rawFileDeletedAt: iso(job.rawFileDeletedAt),
    createdByUserId: job.createdByUserId,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.changedAt.toISOString(),
    finishedAt: iso(job.finishedAt),
  };
}

/** `Import`. Never the upload id (D-L155), never a cell. */
export function toImportWire(job: ImportJob): ImportWire {
  return {
    ...toImportSummaryWire(job),
    contentType: job.contentType,
    headers: job.headers === null ? null : [...job.headers],
    suggestedMapping: job.suggestedMapping === null ? null : job.suggestedMapping.map((c) => ({ ...c })),
    mapping:
      job.mapping === null
        ? null
        : {
            columns: job.mapping.columns.map((c) => ({ index: c.index, field: c.field })),
            defaultCountry: job.mapping.defaultCountry,
            ownerUserId: job.mapping.ownerUserId,
          },
    errors: job.errors.map((e) => ({ row: e.row, column: e.column, code: e.code })),
    errorsTruncated: job.errorsTruncated,
  };
}
