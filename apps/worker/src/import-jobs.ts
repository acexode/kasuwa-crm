import { UnknownSessionUserError, withTenantTransaction, type TenantTx } from '@kasuwa/db';
import {
  IMPORT_JOB_NAMES,
  IMPORT_JOB_OPTIONS,
  IMPORT_LIMITS,
  IMPORT_RETENTION,
  IMPORT_RETENTION_QUEUE,
  ImportJobPayload,
  appendImportFinishedEvent,
  change,
  contactAuditEvent,
  contactChanges,
  contactFieldLevel,
  findImportJob,
  insertContact,
  isTerminalImportStatus,
  loadContactFieldAccess,
  loadProgrammeDuplicates,
  parseImportRow,
  programmeMemberExists,
  recordAuditEvent,
  recordAuditWithCustom,
  redisConnectionOptions,
  suggestImportMapping,
  updateImportJob,
  type AuditAction,
  type DuplicateCandidatePort,
  type ImportJob,
  type ImportJobPatch,
  type ImportQueueName,
  type ImportRowError,
} from '@kasuwa/domain-core';
import { hasLoneSurrogate, loadCustomFieldAccess } from '@kasuwa/metadata-engine';
import { canProgramme, loadGrants } from '@kasuwa/permissions';
import { StoredObjectRepository, type ObjectStore } from '@kasuwa/storage-adapter';
import { Queue } from 'bullmq';
import type { Pool } from 'pg';
import { CsvStreamError, forEachCsvRecord, readFirstCsvRecord } from './csv-stream';

/**
 * The import worker's three processors (T-0094 suite interface C; ADR-0017
 * flow steps 3-7; D-L128 Q5 and Q7, D-L146, D-L148, D-L151, D-L160).
 *
 *   processImportHeader     kasuwa.import.header: reads the first row only and
 *                           stores the column NAMES and a suggested mapping.
 *   processImportRun        kasuwa.import.run: streams the file through
 *                           csv-parse and creates contacts in batches.
 *   processImportRetention  kasuwa.import.retention: deletes the raw file and
 *                           erases the filename, headers and mapping when due.
 *
 * RUN AS THE CREATOR (D-L128 Q7, D-L151). Every transaction here is
 * `withTenantTransaction({ tenantId, userId })` with the payload's ids, and the
 * job is acted on only when it is visible in that session AND its
 * `created_by_user_id` is that user. So a forged payload (another user, another
 * tenant, a user of another tenant) reads, creates and deletes nothing (I5),
 * and scope comes from `user_programme` at run time, never from the payload.
 * Each batch (at most 1,000 rows, R5) re-resolves scope and re-checks
 * `contact.import` and field security (R6, R12). A creator who lost the
 * programme no longer sees the row; migration 0042's trigger has already
 * failed and erased it (D-L160).
 *
 * NO CELL, HEADER, FILENAME, KEY OR URL IS EVER LOGGED, thrown or queued.
 * Nothing here logs at all; a failure is thrown as `ImportJobError`, which
 * carries a fixed message and no cause (a pg or csv-parse error can quote a
 * row). Payloads are `{ tenantId, userId, importId }`, Zod-parsed, closed.
 *
 * Importing this module starts nothing.
 */

export interface ImportJobDeps {
  /** kasuwa_app: NOBYPASSRLS, the role the worker runs as. */
  readonly pool: Pool;
  readonly store: ObjectStore;
  /** For the jobs a processor enqueues itself (retention). */
  readonly redisUrl: string;
  /** The clock retention decides "due" by. Default: the real one. */
  readonly now?: () => Date;
}

/** A processor's failure. A fixed message, never a cell, never a cause. */
export class ImportJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportJobError';
  }
}

/**
 * Every processor's failure leaves as an ImportJobError with a fixed message
 * and no cause (D-L167 N5): a pg, csv-parse or SDK error can quote a row, a
 * key or a host, and BullMQ stores `failedReason` and the stack.
 */
async function withFixedErrors<T>(message: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ImportJobError) throw error;
    throw new ImportJobError(message);
  }
}

/** Rows per batch: each batch is one short transaction as the creator (R5). */
export const IMPORT_BATCH_ROWS = 1_000;

type Outcome = 'skipped' | 'done';

function parsePayload(raw: unknown): ImportJobPayload {
  const parsed = ImportJobPayload.safeParse(raw);
  if (!parsed.success) throw new ImportJobError('import job payload refused');
  return parsed.data;
}

/**
 * Runs `fn` as the payload's user, or answers null when that user does not
 * exist in that tenant (a forged payload naming a user of another tenant).
 */
async function asCreator<T>(
  deps: ImportJobDeps,
  payload: ImportJobPayload,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T | null> {
  try {
    return await withTenantTransaction(deps.pool, { tenantId: payload.tenantId, userId: payload.userId }, fn);
  } catch (error) {
    if (error instanceof UnknownSessionUserError) return null;
    throw error;
  }
}

/** The job, when the session sees it and the payload's user created it; else null. */
async function creatorsJob(tx: TenantTx, payload: ImportJobPayload): Promise<ImportJob | null> {
  const job = await findImportJob(tx, payload.importId, { forUpdate: true });
  if (job === null) return null;
  if (job.tenantId !== payload.tenantId || job.createdByUserId !== payload.userId) return null;
  return job;
}

async function enqueue(deps: ImportJobDeps, name: ImportQueueName, payload: ImportJobPayload, delayMs: number): Promise<void> {
  const queue = new Queue(name, { connection: redisConnectionOptions(deps.redisUrl) });
  try {
    await queue.add(IMPORT_JOB_NAMES[name], ImportJobPayload.parse(payload), {
      ...IMPORT_JOB_OPTIONS,
      delay: delayMs,
    });
  } finally {
    await queue.close();
  }
}

const retentionOf = (job: ImportJob): ImportJobPayload => ({
  tenantId: job.tenantId,
  userId: job.createdByUserId,
  importId: job.id,
});

async function auditJob(tx: TenantTx, job: ImportJob, action: AuditAction, changes: ReturnType<typeof change>[]): Promise<void> {
  await recordAuditEvent(tx, {
    action,
    objectType: 'import_job',
    objectId: job.id,
    objectLabel: job.id,
    programmeId: job.programmeId,
    changes,
  });
}

/** Ends a job in `status` with its counts, audited by id with the counts (no content). */
async function endJob(
  tx: TenantTx,
  job: ImportJob,
  status: 'finished' | 'failed' | 'cancelled',
  patch: ImportJobPatch = {},
): Promise<ImportJob | null> {
  const ended = await updateImportJob(tx, job.id, { ...patch, status, finishedAt: 'now' });
  if (ended === null) return null;
  await auditJob(tx, ended, 'updated', [
    change('status', job.status, status),
    change('created', null, String(ended.counts.created)),
    change('skipped', null, String(ended.counts.skipped)),
    change('failed', null, String(ended.counts.failed)),
  ]);
  // T-0100: ONE notification event per job that ran to an end or failed, never
  // one per row. A job the user cancelled needs no notification: they know.
  // The session user is the creator (asCreator), who is the one told.
  if (status !== 'cancelled') {
    await appendImportFinishedEvent(tx, { id: ended.id, programmeId: ended.programmeId });
  }
  return ended;
}

// ---------------------------------------------------------------------------
// kasuwa.import.header
// ---------------------------------------------------------------------------

/**
 * The header row, or null when it cannot be one the contract can hold: none
 * at all, more than 500 columns, or a name that is empty, over 255
 * characters, or carries a NUL or a lone surrogate.
 */
export async function readHeaderRow(stream: AsyncIterable<Uint8Array>): Promise<string[] | null> {
  const first = await readFirstCsvRecord(stream);
  if (first === null || first.tooLarge) return null;
  const headers = first.cells.map((cell) => cell.trim());
  if (headers.length === 0 || headers.length > IMPORT_LIMITS.maxColumns) return null;
  for (const name of headers) {
    const length = [...name].length;
    if (length < 1 || length > IMPORT_LIMITS.maxHeaderBytes || name.includes('\u0000') || hasLoneSurrogate(name)) {
      return null;
    }
  }
  return headers;
}

export async function processImportHeader(deps: ImportJobDeps, rawPayload: unknown): Promise<Outcome> {
  return withFixedErrors('import header failed', () => runImportHeaderJob(deps, rawPayload));
}

async function runImportHeaderJob(deps: ImportJobDeps, rawPayload: unknown): Promise<Outcome> {
  const payload = parsePayload(rawPayload);
  const storedObjects = new StoredObjectRepository(deps.store);
  const ended = await asCreator(deps, payload, async (tx) => {
    const job = await creatorsJob(tx, payload);
    if (job === null || job.status !== 'reading_header') return null;
    const grants = await loadGrants(tx);
    if (!canProgramme(grants, 'contact.import', job.programmeId)) return endJob(tx, job, 'failed');
    const headers = await readHeaderRow(await storedObjects.openStream(tx, job.storedObjectId));
    if (headers === null) return endJob(tx, job, 'failed');
    await updateImportJob(tx, job.id, {
      status: 'awaiting_mapping',
      headers,
      suggestedMapping: suggestImportMapping(headers),
    });
    return null;
  });
  if (ended !== null) {
    await enqueue(deps, IMPORT_RETENTION_QUEUE, retentionOf(ended), IMPORT_RETENTION.rawFileMs);
  }
  return 'done';
}

// ---------------------------------------------------------------------------
// kasuwa.import.run
// ---------------------------------------------------------------------------

interface PendingRow {
  readonly row: number;
  readonly record: readonly string[];
  readonly tooLarge: boolean;
}

type BatchResult = 'continue' | 'stopped';

function appendErrors(
  job: ImportJob,
  added: readonly ImportRowError[],
): { errors: ImportRowError[]; errorsTruncated: boolean } {
  const room = IMPORT_LIMITS.maxErrors - job.errors.length;
  if (added.length <= room) return { errors: [...job.errors, ...added], errorsTruncated: job.errorsTruncated };
  return { errors: [...job.errors, ...added.slice(0, Math.max(0, room))], errorsTruncated: true };
}

/**
 * The rights a run needs, re-read every batch (D-L167 N4): `contact.import`
 * AND `contact.write` in the import's programme.
 */
function mayRun(grants: Awaited<ReturnType<typeof loadGrants>>, programmeId: string): boolean {
  return canProgramme(grants, 'contact.import', programmeId) && canProgramme(grants, 'contact.write', programmeId);
}

/** One batch, in one transaction as the creator, with scope, the right and field security re-read. */
async function runBatch(
  deps: ImportJobDeps,
  payload: ImportJobPayload,
  rows: readonly PendingRow[],
  duplicates: DuplicateCandidatePort,
  trailing: readonly ImportRowError[],
): Promise<{ result: BatchResult; ended: ImportJob | null }> {
  const outcome = await asCreator(deps, payload, async (tx) => {
    const job = await creatorsJob(tx, payload);
    // Not visible: the creator lost the programme (0042's trigger failed it).
    if (job === null) return { result: 'stopped' as const, ended: null };
    if (job.status !== 'running') return { result: 'stopped' as const, ended: null };
    if (job.cancelRequested) return { result: 'stopped' as const, ended: await endJob(tx, job, 'cancelled') };
    const grants = await loadGrants(tx);
    if (!mayRun(grants, job.programmeId) || job.mapping === null) {
      return { result: 'stopped' as const, ended: await endJob(tx, job, 'failed') };
    }
    const mapping = job.mapping;
    if (mapping.ownerUserId !== null && !(await programmeMemberExists(tx, job.programmeId, mapping.ownerUserId))) {
      return { result: 'stopped' as const, ended: await endJob(tx, job, 'failed') };
    }
    const contactAccess = await loadContactFieldAccess(tx);
    const custom = await loadCustomFieldAccess(tx, 'contact');
    const context = { mapping, programmeId: job.programmeId, contactAccess, custom };

    const counts = { ...job.counts };
    const added: ImportRowError[] = [];
    for (const pending of rows) {
      if (pending.tooLarge) {
        counts.failed += 1;
        added.push({ row: pending.row, column: null, code: 'row_too_large' });
        continue;
      }
      const parsed = parseImportRow(pending.record, context);
      if (!parsed.ok) {
        counts.failed += 1;
        for (const error of parsed.errors) added.push({ row: pending.row, column: error.column, code: error.code });
        continue;
      }
      const keys = {
        phones: (parsed.values.phones ?? []).map((phone) => phone.e164),
        emails: parsed.values.emails ?? [],
      };
      if (duplicates.isDuplicate(keys)) {
        counts.skipped += 1;
        added.push({ row: pending.row, column: null, code: 'possible_duplicate' });
        continue;
      }
      // The repository's own create path, so RLS, the programme check and
      // the composite FKs apply unchanged; audited as createContact is.
      const contact = await insertContact(tx, job.programmeId, parsed.values, parsed.custom, {
        importJobId: job.id,
        dnd: parsed.dnd,
      });
      const changes = contactChanges(parsed.values, null);
      if (parsed.dnd) changes.push(change('dnd', 'false', 'true'));
      await recordAuditWithCustom(tx, contactAuditEvent('created', contact, changes), Object.keys(parsed.custom).sort());
      duplicates.remember(keys);
      counts.created += 1;
    }
    added.push(...trailing);
    const progress = await updateImportJob(tx, job.id, { counts, ...appendErrors(job, added) });
    return { result: 'continue' as const, ended: null, progress };
  });
  if (outcome === null) return { result: 'stopped', ended: null };
  return { result: outcome.result, ended: outcome.ended };
}

async function finishRun(deps: ImportJobDeps, payload: ImportJobPayload): Promise<ImportJob | null> {
  const ended = await asCreator(deps, payload, async (tx) => {
    const job = await creatorsJob(tx, payload);
    if (job === null || job.status !== 'running') return null;
    return endJob(tx, job, job.cancelRequested ? 'cancelled' : 'finished');
  });
  return ended ?? null;
}

async function failRun(deps: ImportJobDeps, payload: ImportJobPayload, trailing: readonly ImportRowError[]): Promise<ImportJob | null> {
  const ended = await asCreator(deps, payload, async (tx) => {
    const job = await creatorsJob(tx, payload);
    if (job === null || isTerminalImportStatus(job.status)) return null;
    return endJob(tx, job, 'failed', appendErrors(job, trailing));
  });
  return ended ?? null;
}

export async function processImportRun(deps: ImportJobDeps, rawPayload: unknown): Promise<Outcome> {
  return withFixedErrors('import run failed', () => runImportRunJob(deps, rawPayload));
}

async function runImportRunJob(deps: ImportJobDeps, rawPayload: unknown): Promise<Outcome> {
  const payload = parsePayload(rawPayload);
  const storedObjects = new StoredObjectRepository(deps.store);

  // Start: as the creator, a queued job only; the right re-checked.
  const started = await asCreator(deps, payload, async (tx) => {
    const job = await creatorsJob(tx, payload);
    if (job === null || job.status !== 'queued' || job.mapping === null) return null;
    const grants = await loadGrants(tx);
    if (!mayRun(grants, job.programmeId)) {
      return { ended: await endJob(tx, job, 'failed') };
    }
    const running = await updateImportJob(tx, job.id, { status: 'running' });
    if (running === null) return null;
    const access = await loadContactFieldAccess(tx);
    // D-L160 ruling 5: match only on what the creator can read here.
    const duplicates = await loadProgrammeDuplicates(tx, job.programmeId, {
      phones: contactFieldLevel(access, job.programmeId, 'phones') !== 'none',
      emails: contactFieldLevel(access, job.programmeId, 'emails') !== 'none',
    });
    const stream = await storedObjects.openStream(tx, job.storedObjectId);
    return { job: running, duplicates, stream };
  });
  if (started === null) return 'skipped';
  if ('ended' in started) {
    if (started.ended !== null) {
      await enqueue(deps, IMPORT_RETENTION_QUEUE, retentionOf(started.ended), IMPORT_RETENTION.rawFileMs);
    }
    return 'done';
  }

  const { duplicates } = started;
  let dataRows = 0;
  let batch: PendingRow[] = [];
  let ended: ImportJob | null = null;
  let stopped = false;
  try {
    try {
      await forEachCsvRecord(started.stream, async (record, index) => {
        if (index === 0) return 'continue'; // the header row
        if (dataRows >= IMPORT_LIMITS.maxRows) {
          // R7: the first row past 100,000 is the one too_many_rows error, not imported.
          const tail: ImportRowError = { row: dataRows + 2, column: null, code: 'too_many_rows' };
          const flushed = await runBatch(deps, payload, batch, duplicates, [tail]);
          batch = [];
          ended = flushed.ended;
          stopped = flushed.result === 'stopped';
          return 'stop';
        }
        batch.push({ row: dataRows + 2, record: record.cells, tooLarge: record.tooLarge });
        dataRows += 1;
        if (batch.length < IMPORT_BATCH_ROWS) return 'continue';
        const done = await runBatch(deps, payload, batch, duplicates, []);
        batch = [];
        if (done.result === 'continue') return 'continue';
        ended = done.ended;
        stopped = true;
        return 'stop';
      });
    } catch (error) {
      if (!(error instanceof CsvStreamError)) throw error;
      if (error.failure === 'source') throw error;
      // A malformed file: what was committed stays; the rest is one error.
      ended = await failRun(deps, payload, [{ row: dataRows + 2, column: null, code: 'invalid_value' }]);
      stopped = true;
    }
    if (!stopped && batch.length > 0) {
      const done = await runBatch(deps, payload, batch, duplicates, []);
      if (done.result === 'stopped') {
        ended = done.ended;
        stopped = true;
      }
    }
    if (!stopped) ended = await finishRun(deps, payload);
  } catch {
    // Anything unexpected (the bucket stream failing, the database): fail the
    // job if it is still visible, and throw a fixed error (D-L167 N5).
    const failed = await failRun(deps, payload, []).catch(() => null);
    if (failed !== null) {
      await enqueue(deps, IMPORT_RETENTION_QUEUE, retentionOf(failed), IMPORT_RETENTION.rawFileMs).catch(() => undefined);
    }
    throw new ImportJobError('import run failed');
  }
  if (ended !== null) {
    await enqueue(deps, IMPORT_RETENTION_QUEUE, retentionOf(ended), IMPORT_RETENTION.rawFileMs);
  }
  return 'done';
}

// ---------------------------------------------------------------------------
// kasuwa.import.retention
// ---------------------------------------------------------------------------

const ERASED: ImportJobPatch = {
  filename: null,
  headers: null,
  suggestedMapping: null,
  mapping: null,
  rawFileDeletedAt: 'now',
};

const plus = (date: Date, ms: number) => new Date(date.getTime() + ms);

/**
 * Decided from the ROW and the clock (R13), as the creator:
 *   - awaiting_upload, 24 hours after creation: the upload is aborted, the
 *     job `expired`;
 *   - reading_header or awaiting_mapping, 7 days after the upload completed
 *     (D-L160 ruling 3): the file deleted, the job `expired`;
 *   - queued or running: left alone, and checked again later (a NEW job);
 *   - ended, 7 days after it ended: the file deleted.
 * Each erasure moves stored_object to `deleted`, sets raw_file_deleted_at and
 * clears filename, headers and mapping (D-L148, D-L150); counts and errors
 * stay; `deleted` is audited on stored_object with the creator as actor. A
 * job that is not due, already erased, or not the payload user's own changes
 * nothing.
 */
export async function processImportRetention(deps: ImportJobDeps, rawPayload: unknown): Promise<Outcome> {
  return withFixedErrors('import retention failed', () => runImportRetentionJob(deps, rawPayload));
}

async function runImportRetentionJob(deps: ImportJobDeps, rawPayload: unknown): Promise<Outcome> {
  const payload = parsePayload(rawPayload);
  const now = (deps.now ?? (() => new Date()))();
  const storedObjects = new StoredObjectRepository(deps.store);
  const decision = await asCreator(deps, payload, async (tx): Promise<'reschedule' | 'erased' | null> => {
    const job = await creatorsJob(tx, payload);
    if (job === null || job.rawFileDeletedAt !== null) return null;
    let erase: ImportJobPatch | null = null;
    if (job.status === 'queued' || job.status === 'running') return 'reschedule';
    if (job.status === 'awaiting_upload') {
      if (now < plus(job.createdAt, IMPORT_RETENTION.abandonedUploadMs)) return null;
      await storedObjects.abortUpload(tx, job.storedObjectId, job.uploadId);
      erase = { ...ERASED, status: 'expired', finishedAt: 'now' };
    } else if (job.status === 'reading_header' || job.status === 'awaiting_mapping') {
      if (now < plus(job.uploadedAt ?? job.createdAt, IMPORT_RETENTION.rawFileMs)) return null;
      await storedObjects.markDeleted(tx, job.storedObjectId);
      erase = { ...ERASED, status: 'expired', finishedAt: 'now' };
    } else {
      if (now < plus(job.finishedAt ?? job.createdAt, IMPORT_RETENTION.rawFileMs)) return null;
      await storedObjects.markDeleted(tx, job.storedObjectId);
      erase = ERASED;
    }
    await updateImportJob(tx, job.id, erase);
    await recordAuditEvent(tx, {
      action: 'deleted',
      objectType: 'stored_object',
      objectId: job.storedObjectId,
      objectLabel: job.storedObjectId,
      programmeId: job.programmeId,
      changes: [],
    });
    return 'erased';
  });
  if (decision === 'reschedule') {
    await enqueue(deps, IMPORT_RETENTION_QUEUE, payload, IMPORT_RETENTION.recheckRunningMs);
  }
  return decision === null ? 'skipped' : 'done';
}
