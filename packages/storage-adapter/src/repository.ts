import { randomUUID } from 'node:crypto';
import type { TenantTx } from '@kasuwa/db';
import {
  StoredObjectInputError,
  StoredObjectNotFoundError,
  StoredObjectStateError,
} from './errors';
import { isCanonicalUuid, isStoragePurpose, keyForStoredRow, mintKeyWithId, type StoragePurpose } from './keys';
import { MAX_PARTS, isContentType, type CompletedPart, type ObjectStore, type PresignedUpload } from './port';

/**
 * `stored_object` (migration 0040, ADR-0017 Decision 3): every object has a
 * metadata row, and access goes through it.
 *
 *   - A URL is issued only AFTER the row is read inside the caller's tenant
 *     transaction. A row the caller cannot see (another programme, another
 *     tenant, an invented or malformed id, a caller with no programme) is ONE
 *     error, StoredObjectNotFoundError, and the store is never called.
 *   - Two layers (CLAUDE.md 2.3): RLS on the table, AND every statement here
 *     filters on `tx.session`'s tenant and programmes explicitly, so a session
 *     narrower than the connection's GUCs still cannot read the wider row (R7).
 *   - fileId IS the row id (R1), so the key is rebuilt from the row's own
 *     columns, never parsed from a string; the database holds `key` to the
 *     same shape and never lets it change.
 *   - The record never carries the key text (R4): nothing that serialises one
 *     can leak a path.
 *   - Status moves (R8): presign and complete from `pending` only; markDeleted
 *     from any status; `deleted` is terminal. kasuwa_app cannot DELETE a row.
 *
 * Nothing here logs. Errors carry codes and fixed messages.
 */

export type StoredObjectStatus = 'pending' | 'uploaded' | 'rejected' | 'deleted';

export interface StoredObjectRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly programmeId: string;
  readonly purpose: StoragePurpose;
  readonly status: StoredObjectStatus;
  readonly declaredSizeBytes: number;
  readonly verifiedSizeBytes: number | null;
  readonly contentType: string;
  readonly uploadedByUserId: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface CreateStoredObjectInput {
  readonly programmeId: string;
  readonly purpose: StoragePurpose;
  readonly declaredSizeBytes: number;
  readonly contentType: string;
}

export interface CompleteStoredObjectInput {
  readonly uploadId: string;
  readonly parts: readonly CompletedPart[];
}

/** A `pending` row nobody completes is swept after this (ADR-0017 "Retention"; T-0094's sweeper). */
const PENDING_TTL = '24 hours';

const COLUMNS = `id, tenant_id, programme_id, purpose, status, declared_size_bytes, verified_size_bytes,
  content_type, uploaded_by_user_id, created_at, expires_at`;

interface Row {
  id: string;
  tenant_id: string;
  programme_id: string;
  purpose: string;
  status: string;
  declared_size_bytes: string | number;
  verified_size_bytes: string | number | null;
  content_type: string;
  uploaded_by_user_id: string;
  created_at: Date | string;
  expires_at: Date | string | null;
  [column: string]: unknown;
}

function toSize(value: string | number): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size)) throw new StoredObjectInputError('size');
  return size;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toRecord(row: Row): StoredObjectRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    programmeId: row.programme_id,
    purpose: row.purpose as StoragePurpose,
    status: row.status as StoredObjectStatus,
    declaredSizeBytes: toSize(row.declared_size_bytes),
    verifiedSizeBytes: row.verified_size_bytes === null ? null : toSize(row.verified_size_bytes),
    contentType: row.content_type,
    uploadedByUserId: row.uploaded_by_user_id,
    createdAt: toIso(row.created_at),
    expiresAt: row.expires_at === null ? null : toIso(row.expires_at),
  };
}

function keyOf(record: StoredObjectRecord) {
  return keyForStoredRow({
    tenantId: record.tenantId,
    programmeId: record.programmeId,
    purpose: record.purpose,
    fileId: record.id,
  });
}

export class StoredObjectRepository {
  readonly #store: ObjectStore;

  constructor(store: ObjectStore) {
    this.#store = store;
  }

  /**
   * Inserts a `pending` row as the session's user, in one of the session's
   * programmes. The key is minted from the session with the row's id (R1).
   */
  async create(tx: TenantTx, input: CreateStoredObjectInput): Promise<StoredObjectRecord> {
    const { declaredSizeBytes, contentType } = input;
    if (!Number.isSafeInteger(declaredSizeBytes) || declaredSizeBytes <= 0) {
      throw new StoredObjectInputError('declared size');
    }
    if (!isContentType(contentType)) throw new StoredObjectInputError('content type');
    // Refuses a programme outside the session and a purpose outside the enum.
    const key = mintKeyWithId(tx, input, randomUUID());
    const { tenantId, programmeId, purpose, fileId } = key.parts;
    const rows = await tx.query<Row>(
      `INSERT INTO stored_object (id, tenant_id, programme_id, key, purpose, declared_size_bytes,
                                  content_type, uploaded_by_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + $9::interval)
       RETURNING ${COLUMNS}`,
      [fileId, tenantId, programmeId, String(key), purpose, declaredSizeBytes, contentType, tx.session.userId, PENDING_TTL],
    );
    const row = rows[0];
    if (row === undefined) throw new StoredObjectNotFoundError();
    return toRecord(row);
  }

  /** The row, read in the caller's scope. Anything else is StoredObjectNotFoundError. */
  async get(tx: TenantTx, id: string): Promise<StoredObjectRecord> {
    return this.#read(tx, id, false);
  }

  /**
   * Part URLs for a `pending` row, each signed for its part of the row's
   * DECLARED size. The client chooses the part count, never the length.
   */
  async presignUpload(tx: TenantTx, id: string, options: { partCount: number }): Promise<PresignedUpload> {
    const record = await this.#read(tx, id, true);
    if (record.status !== 'pending') throw new StoredObjectStateError();
    const partCount = options?.partCount;
    if (!Number.isSafeInteger(partCount) || partCount < 1 || partCount > MAX_PARTS) {
      throw new StoredObjectInputError('part count');
    }
    return this.#store.presignUpload(keyOf(record), {
      contentLength: record.declaredSizeBytes,
      partCount,
      contentType: record.contentType,
    });
  }

  /**
   * Completes the upload, then VERIFIES it with `head` (ADR-0017 flow step 2):
   * an object whose size differs from the declaration (a part never sent, R5's
   * second layer), whose type differs from the one recorded at create, or
   * that is missing is deleted and the row moves to
   * `rejected`, which is returned rather than thrown so the move commits.
   * A failed complete (an unknown or aborted upload, a wrong ETag) throws and
   * leaves the row `pending`.
   */
  async completeUpload(tx: TenantTx, id: string, input: CompleteStoredObjectInput): Promise<StoredObjectRecord> {
    const record = await this.#read(tx, id, true);
    if (record.status !== 'pending') throw new StoredObjectStateError();
    const key = keyOf(record);
    await this.#store.completeUpload(key, input?.uploadId, input?.parts);
    const head = await this.#store.head(key);
    const verified =
      head !== null &&
      head.size === record.declaredSizeBytes &&
      (head.contentType === undefined || head.contentType === record.contentType);
    if (!verified) {
      await this.#store.delete(key);
    }
    return this.#move(tx, record, verified ? 'uploaded' : 'rejected', head?.size ?? null);
  }

  /** Deletes the object and moves the row to `deleted` (terminal). Idempotent on a deleted row. */
  async markDeleted(tx: TenantTx, id: string): Promise<StoredObjectRecord> {
    const record = await this.#read(tx, id, true);
    if (record.status === 'deleted') return record;
    await this.#store.delete(keyOf(record));
    return this.#move(tx, record, 'deleted', record.verifiedSizeBytes);
  }

  async #read(tx: TenantTx, id: string, forUpdate: boolean): Promise<StoredObjectRecord> {
    const { tenantId, programmeIds } = tx.session;
    if (!isCanonicalUuid(id) || programmeIds.length === 0) throw new StoredObjectNotFoundError();
    const rows = await tx.query<Row>(
      `SELECT ${COLUMNS} FROM stored_object
        WHERE id = $1 AND tenant_id = $2 AND programme_id = ANY ($3::uuid[])
        ${forUpdate ? 'FOR UPDATE' : ''}`,
      [id, tenantId, [...programmeIds]],
    );
    const row = rows[0];
    if (row === undefined || !isStoragePurpose(row.purpose)) throw new StoredObjectNotFoundError();
    return toRecord(row);
  }

  async #move(
    tx: TenantTx,
    record: StoredObjectRecord,
    status: StoredObjectStatus,
    verifiedSizeBytes: number | null,
  ): Promise<StoredObjectRecord> {
    const rows = await tx.query<Row>(
      `UPDATE stored_object SET status = $4, verified_size_bytes = $5
        WHERE id = $1 AND tenant_id = $2 AND programme_id = ANY ($3::uuid[])
        RETURNING ${COLUMNS}`,
      [record.id, tx.session.tenantId, [...tx.session.programmeIds], status, verifiedSizeBytes],
    );
    const row = rows[0];
    if (row === undefined) throw new StoredObjectNotFoundError();
    return toRecord(row);
  }
}
