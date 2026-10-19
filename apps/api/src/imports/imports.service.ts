import { HttpStatus } from '@nestjs/common';
import { newId, type TenantTx } from '@kasuwa/db';
import {
  IMPORT_HEADER_QUEUE,
  IMPORT_LIMITS,
  IMPORT_REPEATABLE_FIELDS,
  IMPORT_RETENTION,
  IMPORT_RETENTION_QUEUE,
  IMPORT_RUN_QUEUE,
  change,
  findImportJob,
  importCustomKey,
  insertImportJob,
  isImportStandardField,
  listImportJobs,
  loadContactFieldAccess,
  notEditableContactFields,
  programmeMemberExists,
  recordAuditEvent,
  redactedChange,
  toImportSummaryWire,
  toImportWire,
  updateImportJob,
  type AuditAction,
  type ImportColumnMapping,
  type ImportJob,
  type ImportJobPayload,
  type ImportSummaryWire,
  type ImportWire,
} from '@kasuwa/domain-core';
import { loadCustomFieldAccess, notEditableCustomKeys } from '@kasuwa/metadata-engine';
import { canProgramme, loadGrants, type Grants } from '@kasuwa/permissions';
import {
  PRESIGNED_URL_TTL_SECONDS,
  StorageError,
  type StoredObjectRepository,
} from '@kasuwa/storage-adapter';
import {
  AdminError,
  notFound,
  notPermitted,
  validationFailed,
  type AdminErrorDetail,
} from '../admin/common/admin-errors';
import type { ImportQueueAction } from './import-infra';
import {
  CompleteImportUploadBody,
  CreateImportBody,
  IssueImportUploadUrlsBody,
  ListImportsQuery,
  PutImportMappingBody,
} from './imports.schemas';

/**
 * The import API's decisions (T-0094; ADR-0017 flow steps 1-3; D-L151,
 * D-L155, D-L160; the suites' R1-R17 and I1-I6).
 *
 * ORDER, for every operation with an import id (I1): 400 for a malformed id;
 * then ONE 404 for an import the caller cannot see (another tenant, another
 * programme, or a programme where it lacks `contact.import`), the same body
 * as an id that never existed and decided before anything else; then 403 for
 * anyone but the creator (cancel: the creator or a tenant admin); then 400 for
 * the body; then 409 for the status.
 *
 * Every write returns an `ImportOutcome`: the body, the queue jobs to add,
 * and an error to answer with. ImportCommitInterceptor adds the jobs and
 * throws the error only AFTER the tenant transaction commits, so a worker
 * never sees a job before its row, and a `422 upload_mismatch` still commits
 * the rejection it reports.
 *
 * Signed part URLs are bearer credentials and the filename is user text:
 * NOTHING HERE LOGS.
 */

export class ImportOutcome<T> {
  constructor(
    readonly body: T,
    readonly actions: readonly ImportQueueAction[] = [],
    readonly error: AdminError | null = null,
  ) {}
}

export interface ImportUploadWire {
  importId: string;
  parts: { partNumber: number; url: string; sizeBytes: number }[];
  expiresAt: string;
}

const ACTION = 'contact.import' as const;

export const importStatusConflict = (): AdminError =>
  new AdminError(HttpStatus.CONFLICT, 'import_status_conflict', 'This import cannot do that right now.');

export const uploadMismatch = (): AdminError =>
  new AdminError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'upload_mismatch',
    'The uploaded file does not match what was declared.',
  );

function fieldNotEditable(paths: readonly string[]): AdminError {
  return new AdminError(HttpStatus.FORBIDDEN, 'not_permitted', 'You do not have permission to do that.', {
    details: paths.map((path) => ({ path, code: 'field_not_editable' })),
  });
}

function payloadOf(job: ImportJob): ImportJobPayload {
  return { tenantId: job.tenantId, userId: job.createdByUserId, importId: job.id };
}

function retention(job: ImportJob, delayMs: number): ImportQueueAction {
  return { queue: IMPORT_RETENTION_QUEUE, payload: payloadOf(job), delayMs };
}

/** min(4, ceil(size / 5 MiB)) parts (R1). */
export function importPartCount(sizeBytes: number): number {
  return Math.min(IMPORT_LIMITS.maxParts, Math.ceil(sizeBytes / IMPORT_LIMITS.minPartBytes));
}

function expiresAt(): string {
  return new Date(Date.now() + PRESIGNED_URL_TTL_SECONDS * 1000).toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function audit(
  tx: TenantTx,
  action: AuditAction,
  objectType: 'import_job' | 'stored_object',
  objectId: string,
  programmeId: string,
  changes: ReturnType<typeof change>[] = [],
): Promise<void> {
  await recordAuditEvent(tx, { action, objectType, objectId, objectLabel: objectId, programmeId, changes });
}

/** The job, visible to a caller holding `contact.import` in its programme; else THE 404 (I1, R4). */
async function visibleJob(tx: TenantTx, grants: Grants, id: string, forUpdate: boolean): Promise<ImportJob> {
  const job = await findImportJob(tx, id, { forUpdate });
  if (job === null || !canProgramme(grants, ACTION, job.programmeId)) throw notFound();
  return job;
}

/** Visible, and the caller is its creator (D-L151); else 404 or 403. */
async function creatorsJob(tx: TenantTx, id: string): Promise<{ job: ImportJob; grants: Grants }> {
  const grants = await loadGrants(tx);
  const job = await visibleJob(tx, grants, id, true);
  if (job.createdByUserId !== tx.session.userId) throw notPermitted();
  return { job, grants };
}

function mustUpdate(job: ImportJob | null): ImportJob {
  if (job === null) throw notFound();
  return job;
}

// --- createImport ---------------------------------------------------------------

export async function createImportFor(
  tx: TenantTx,
  storedObjects: StoredObjectRepository,
  body: unknown,
): Promise<ImportOutcome<ImportUploadWire>> {
  if (!isPlainObject(body)) throw validationFailed([{ path: '', code: 'invalid_type' }]);
  const target = body.programmeId;
  if (typeof target !== 'string' || !CreateImportBody.shape.programmeId.safeParse(target).success) {
    throw validationFailed([{ path: 'programmeId', code: 'invalid_string' }]);
  }
  // A target: one the caller does not reach is 404, never 403 (CLAUDE.md 6.4).
  if (!tx.session.programmeIds.includes(target)) throw notFound();
  const grants = await loadGrants(tx);
  if (!canProgramme(grants, ACTION, target)) throw notPermitted();
  const parsed = CreateImportBody.parse(body);
  if (parsed.contentType === 'application/vnd.ms-excel' && !/\.csv$/iu.test(parsed.filename)) {
    throw validationFailed([{ path: 'contentType', code: 'unsupported_type' }]);
  }

  const partCount = importPartCount(parsed.sizeBytes);
  const record = await storedObjects.create(tx, {
    programmeId: parsed.programmeId,
    purpose: 'import',
    declaredSizeBytes: parsed.sizeBytes,
    contentType: parsed.contentType,
  });
  const upload = await storedObjects.presignUpload(tx, record.id, { partCount });
  const job = await insertImportJob(tx, {
    id: newId(),
    programmeId: parsed.programmeId,
    storedObjectId: record.id,
    uploadId: upload.uploadId,
    filename: parsed.filename,
    sizeBytes: parsed.sizeBytes,
    contentType: parsed.contentType,
    partCount,
  });
  await audit(tx, 'created', 'import_job', job.id, job.programmeId);
  return new ImportOutcome(
    {
      importId: job.id,
      parts: upload.parts.map((part) => ({ partNumber: part.partNumber, url: part.url, sizeBytes: part.contentLength })),
      expiresAt: expiresAt(),
    },
    [retention(job, IMPORT_RETENTION.abandonedUploadMs)],
  );
}

// --- reads ------------------------------------------------------------------------

export async function getImportFor(tx: TenantTx, id: string): Promise<ImportWire> {
  const grants = await loadGrants(tx);
  return toImportWire(await visibleJob(tx, grants, id, false));
}

export async function listImportsFor(
  tx: TenantTx,
  query: unknown,
): Promise<{ data: ImportSummaryWire[]; nextCursor: string | null }> {
  const { cursor, limit } = ListImportsQuery.parse(query);
  const grants = await loadGrants(tx);
  const programmes = tx.session.programmeIds.filter((id) => canProgramme(grants, ACTION, id));
  const page = await listImportJobs(tx, programmes, { limit, cursor });
  return { data: page.data.map(toImportSummaryWire), nextCursor: page.nextCursor };
}

/**
 * The importId filter on listContacts: the import's programme when the caller
 * can see the import (R9, I2), or null for an empty page.
 */
export async function importFilterFor(tx: TenantTx, importId: string): Promise<string | null> {
  const job = await findImportJob(tx, importId);
  if (job === null) return null;
  const grants = await loadGrants(tx);
  return canProgramme(grants, ACTION, job.programmeId) ? job.programmeId : null;
}

// --- upload ---------------------------------------------------------------------

export async function issueUploadUrlsFor(
  tx: TenantTx,
  storedObjects: StoredObjectRepository,
  id: string,
  body: unknown,
): Promise<ImportOutcome<ImportUploadWire>> {
  const { job } = await creatorsJob(tx, id);
  const { partNumbers } = IssueImportUploadUrlsBody.parse(body);
  if (partNumbers.some((n) => n > job.partCount)) {
    throw validationFailed([{ path: 'partNumbers', code: 'unknown_part' }]);
  }
  if (job.status !== 'awaiting_upload' || job.uploadId === null) throw importStatusConflict();
  // R2: the SAME upload, re-signed; the upload id never changes or leaves.
  const parts = await storedObjects.presignUploadParts(tx, job.storedObjectId, {
    uploadId: job.uploadId,
    partCount: job.partCount,
    partNumbers,
  });
  return new ImportOutcome({
    importId: job.id,
    parts: parts.map((part) => ({ partNumber: part.partNumber, url: part.url, sizeBytes: part.contentLength })),
    expiresAt: expiresAt(),
  });
}

/** The store's refusals that mean "this upload is not what was declared", not an outage. */
function isUploadRefusal(error: unknown): boolean {
  if (!(error instanceof StorageError)) return false;
  return (
    error.code === 'storage_upload_not_found' ||
    error.code === 'storage_invalid_request' ||
    error.code === 'storage_not_found' ||
    (error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500)
  );
}

export async function completeUploadFor(
  tx: TenantTx,
  storedObjects: StoredObjectRepository,
  id: string,
  body: unknown,
): Promise<ImportOutcome<ImportWire>> {
  const { job } = await creatorsJob(tx, id);
  const { parts } = CompleteImportUploadBody.parse(body);
  if (job.status !== 'awaiting_upload' || job.uploadId === null) throw importStatusConflict();

  let verified = false;
  try {
    // R3: the STORED upload id, never one from the body. The store refuses an
    // id that is not open on this object's key (I3).
    const record = await storedObjects.completeUpload(tx, job.storedObjectId, { uploadId: job.uploadId, parts });
    verified = record.status === 'uploaded';
  } catch (error) {
    if (!isUploadRefusal(error)) throw error;
    // Abort only an upload open on THIS key, delete anything at the key.
    await storedObjects.abortUpload(tx, job.storedObjectId, job.uploadId);
  }

  if (!verified) {
    const rejected = mustUpdate(await updateImportJob(tx, job.id, { status: 'rejected', finishedAt: 'now' }));
    await audit(tx, 'rejected', 'stored_object', job.storedObjectId, job.programmeId);
    return new ImportOutcome(toImportWire(rejected), [retention(rejected, IMPORT_RETENTION.rawFileMs)], uploadMismatch());
  }

  const reading = mustUpdate(
    await updateImportJob(tx, job.id, { status: 'reading_header', uploadedAt: 'now' }),
  );
  await audit(tx, 'updated', 'stored_object', job.storedObjectId, job.programmeId, [change('status', 'pending', 'uploaded')]);
  await audit(tx, 'updated', 'import_job', job.id, job.programmeId, [change('status', 'awaiting_upload', 'reading_header')]);
  return new ImportOutcome(toImportWire(reading), [
    { queue: IMPORT_HEADER_QUEUE, payload: payloadOf(reading) },
    // D-L160 ruling 3: the 7-day timer also starts at a successful complete.
    retention(reading, IMPORT_RETENTION.rawFileMs),
  ]);
}

export async function abortUploadFor(
  tx: TenantTx,
  storedObjects: StoredObjectRepository,
  id: string,
): Promise<ImportOutcome<ImportWire>> {
  const { job } = await creatorsJob(tx, id);
  if (job.status !== 'awaiting_upload') throw importStatusConflict();
  await storedObjects.abortUpload(tx, job.storedObjectId, job.uploadId);
  const cancelled = mustUpdate(await updateImportJob(tx, job.id, { status: 'cancelled', finishedAt: 'now' }));
  await audit(tx, 'updated', 'import_job', job.id, job.programmeId, [change('status', 'awaiting_upload', 'cancelled')]);
  return new ImportOutcome(toImportWire(cancelled), [retention(cancelled, IMPORT_RETENTION.rawFileMs)]);
}

// --- mapping --------------------------------------------------------------------

/** An earlier job's mapping copied BY HEADER NAME onto `headers`; null when unusable (D-L148). */
async function mappingFrom(
  tx: TenantTx,
  grants: Grants,
  fromImportId: string,
  headers: readonly string[],
): Promise<ImportColumnMapping[] | null> {
  const source = await findImportJob(tx, fromImportId);
  if (
    source === null ||
    !canProgramme(grants, ACTION, source.programmeId) ||
    source.rawFileDeletedAt !== null ||
    source.headers === null ||
    source.mapping === null
  ) {
    return null;
  }
  const sourceHeaders = source.headers;
  const byName = new Map<string, string>();
  for (const column of source.mapping.columns) {
    const name = sourceHeaders[column.index];
    if (column.field !== null && name !== undefined && !byName.has(name)) byName.set(name, column.field);
  }
  return headers.map((name, index) => ({ index, field: byName.get(name) ?? null }));
}

/** The 400 details of a column list against the file's headers and the live custom fields. */
function columnProblems(
  columns: readonly ImportColumnMapping[],
  headerCount: number,
  liveCustomKeys: ReadonlySet<string>,
): AdminErrorDetail[] {
  const details: AdminErrorDetail[] = [];
  const fields = new Set<string>();
  const indices = new Set<number>();
  columns.forEach((column, i) => {
    if (column.index >= headerCount) details.push({ path: `columns.${i}.index`, code: 'unknown_column' });
    else if (indices.has(column.index)) details.push({ path: `columns.${i}.index`, code: 'duplicate_mapping' });
    indices.add(column.index);
    const field = column.field;
    if (field === null) return;
    const customKey = importCustomKey(field);
    if (customKey !== null && !liveCustomKeys.has(customKey)) {
      details.push({ path: `columns.${i}.field`, code: 'unknown_field' });
      return;
    }
    const repeatable = isImportStandardField(field) && IMPORT_REPEATABLE_FIELDS.includes(field);
    if (fields.has(field) && !repeatable) details.push({ path: `columns.${i}.field`, code: 'duplicate_mapping' });
    fields.add(field);
  });
  if (!fields.has('displayName') && !fields.has('givenNames') && !fields.has('familyName')) {
    details.push({ path: 'displayName', code: 'mapping_incomplete' });
  }
  return details;
}

export async function putMappingFor(tx: TenantTx, id: string, body: unknown): Promise<ImportOutcome<ImportWire>> {
  const { job, grants } = await creatorsJob(tx, id);
  const parsed = PutImportMappingBody.parse(body);
  if (job.status !== 'awaiting_mapping' || job.headers === null) throw importStatusConflict();
  const headers = job.headers;

  let columns: ImportColumnMapping[];
  if (parsed.fromImportId !== undefined) {
    const copied = await mappingFrom(tx, grants, parsed.fromImportId, headers);
    if (copied === null) throw validationFailed([{ path: 'fromImportId', code: 'unknown_reference' }]);
    columns = copied;
  } else {
    columns = (parsed.columns ?? []).map((column) => ({ index: column.index, field: column.field }));
  }

  const custom = await loadCustomFieldAccess(tx, 'contact');
  const problems = columnProblems(columns, headers.length, new Set(custom.defs.keys()));
  if (problems.length > 0) throw validationFailed(problems);

  // Field security (403, naming the field, never a column).
  const mapped = [...new Set(columns.map((c) => c.field).filter((f): f is string => f !== null))];
  const access = await loadContactFieldAccess(tx);
  const owner = parsed.ownerUserId ?? null;
  const locked = [
    ...notEditableContactFields(access, job.programmeId, [...mapped, ...(owner === null ? [] : ['ownerUserId'])]),
    ...notEditableCustomKeys(
      custom,
      job.programmeId,
      mapped.map(importCustomKey).filter((k): k is string => k !== null),
    ).map((key) => `custom.${key}`),
  ];
  if (locked.length > 0) throw fieldNotEditable(locked);

  if (owner !== null) {
    // Another member as owner needs createContact's right (D-P14, D-L81),
    // decided BEFORE the membership check, so it cannot probe who is a
    // member (D-L167 N7).
    if (owner !== tx.session.userId && !canProgramme(grants, 'contact.write', job.programmeId)) throw notPermitted();
    if (!(await programmeMemberExists(tx, job.programmeId, owner))) {
      throw validationFailed([{ path: 'ownerUserId', code: 'unknown_reference' }]);
    }
  }

  const saved = mustUpdate(
    await updateImportJob(tx, job.id, { mapping: { columns, defaultCountry: parsed.defaultCountry, ownerUserId: owner } }),
  );
  // D-L167 N8: by id, naming the field only; never a header or a column.
  await audit(tx, 'updated', 'import_job', job.id, job.programmeId, [redactedChange('mapping')]);
  return new ImportOutcome(toImportWire(saved));
}

// --- run and cancel -------------------------------------------------------------

export async function runImportFor(tx: TenantTx, id: string): Promise<ImportOutcome<ImportWire>> {
  const { job, grants } = await creatorsJob(tx, id);
  // A run creates contacts: `contact.write` too, not only `contact.import`
  // (D-L167 N4). Re-checked by every batch.
  if (!canProgramme(grants, 'contact.write', job.programmeId)) throw notPermitted();
  if (job.status !== 'awaiting_mapping' || job.mapping === null) throw importStatusConflict();
  const queued = mustUpdate(await updateImportJob(tx, job.id, { status: 'queued' }));
  await audit(tx, 'updated', 'import_job', job.id, job.programmeId, [change('status', 'awaiting_mapping', 'queued')]);
  return new ImportOutcome(toImportWire(queued), [{ queue: IMPORT_RUN_QUEUE, payload: payloadOf(queued) }]);
}

/** A running job whose last batch committed longer ago than this is cancelled at once (D-L167 N2). */
export const STALE_RUN_MS = 10 * 60 * 1000;

export async function cancelImportFor(tx: TenantTx, id: string): Promise<ImportOutcome<ImportWire>> {
  const grants = await loadGrants(tx);
  const job = await visibleJob(tx, grants, id, true);
  if (job.createdByUserId !== tx.session.userId && !grants.isTenantAdmin) throw notPermitted();
  // Every batch commit touches changed_at, so a running job whose changed_at
  // is old has no live worker: nothing would honour cancel_requested.
  const stale = job.status === 'running' && Date.now() - job.changedAt.getTime() > STALE_RUN_MS;
  if (job.status === 'queued' || stale) {
    const cancelled = mustUpdate(
      await updateImportJob(tx, job.id, { status: 'cancelled', cancelRequested: true, finishedAt: 'now' }),
    );
    // D-L167 N8: audited whoever cancels; the actor is the session user.
    await audit(tx, 'updated', 'import_job', job.id, job.programmeId, [change('status', job.status, 'cancelled')]);
    return new ImportOutcome(toImportWire(cancelled), [retention(cancelled, IMPORT_RETENTION.rawFileMs)]);
  }
  if (job.status === 'running') {
    // Honoured by the next batch, which ends the job `cancelled`.
    const asked = mustUpdate(await updateImportJob(tx, job.id, { cancelRequested: true }));
    await audit(tx, 'updated', 'import_job', job.id, job.programmeId, [change('cancelRequested', 'false', 'true')]);
    return new ImportOutcome(toImportWire(asked));
  }
  throw importStatusConflict();
}
