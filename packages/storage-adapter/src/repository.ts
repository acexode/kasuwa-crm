import { randomUUID } from 'node:crypto';
import { assertLiveTenantTx, type TenantTx } from '@kasuwa/db';
import {
  StoredObjectInputError,
  StoredObjectNotFoundError,
  StoredObjectStateError,
} from './errors';
import { isCanonicalUuid, isStoragePurpose, keyForStoredRow, mintKeyWithId, type StoragePurpose } from './keys';
import {
  PURPOSE_LIMITS,
  isContentType,
  type CompletedPart,
  type ObjectStore,
  type PresignedUpload,
} from './port';

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
 *     Migration 0040 holds the same moves in the database.
 *   - Every method that writes or issues a URL demands the LIVE tx that
 *     `withTenantTransaction` is running (`assertLiveTenantTx`, D-L155), so a
 *     made-up session is never believed. `get` is the exception: see its note.
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
    assertLiveTenantTx(tx);
    const { declaredSizeBytes, contentType, purpose: requested } = input;
    if (!Number.isSafeInteger(declaredSizeBytes) || declaredSizeBytes <= 0) {
      throw new StoredObjectInputError('declared size');
    }
    if (isStoragePurpose(requested) && declaredSizeBytes > PURPOSE_LIMITS[requested].maxBytes) {
      throw new StoredObjectInputError('declared size');
    }
    if (!isContentType(contentType)) throw new StoredObjectInputError('content type');
    // Refuses a programme outside the session and a purpose outside the enum.
    const key = mintKeyWithId(tx, input, randomUUID());
    const { tenantId, programmeId, purpose, fileId } = key.parts;
    // tenancy-reviewed: tenant, programme and uploader come from the live
    // session (the minted key); RLS and the restrictive INSERT policy re-check.
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

  /**
   * The row, read in the caller's scope. Anything else is StoredObjectNotFoundError.
   *
   * NOT gated by `assertLiveTenantTx`, unlike every other method. The T-0092
   * suite's R7 test hands `get` a hand-built TenantTx whose session is
   * NARROWER than its connection's GUCs and expects the narrower read to work,
   * which the live check would refuse. A read cannot widen anything: it runs
   * on the caller's own connection under RLS, and filters on `tx.session` as
   * well. Escalated in the T-0092 report rather than resolved here.
   */
  async get(tx: TenantTx, id: string): Promise<StoredObjectRecord> {
    return this.#read(tx, id, false);
  }

  /**
   * Part URLs for a `pending` row, each signed for its part of the row's
   * DECLARED size. The client chooses the part count (at most the purpose's
   * cap), never the length. Presigning again aborts the row's earlier open
   * upload (the store keeps one open upload per key, D-L155).
   */
  async presignUpload(tx: TenantTx, id: string, options: { partCount: number }): Promise<PresignedUpload> {
    assertLiveTenantTx(tx);
    const record = await this.#read(tx, id, true);
    if (record.status !== 'pending') throw new StoredObjectStateError();
    const partCount = options?.partCount;
    if (!Number.isSafeInteger(partCount) || partCount < 1 || partCount > PURPOSE_LIMITS[record.purpose].maxParts) {
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
   *
   * METADATA ONLY (D-L155): size and content type, as `head` reports them.
   * The bytes are not read here; parsing them is the import job's (T-0094). A
   * missing content type in `head` is accepted, because the server set the
   * type at CreateMultipartUpload from the row, not the client.
   */
  async completeUpload(tx: TenantTx, id: string, input: CompleteStoredObjectInput): Promise<StoredObjectRecord> {
    assertLiveTenantTx(tx);
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
    assertLiveTenantTx(tx);
    const record = await this.#read(tx, id, true);
    if (record.status === 'deleted') return record;
    await this.#store.delete(keyOf(record));
    return this.#move(tx, record, 'deleted', record.verifiedSizeBytes);
  }

  async #read(tx: TenantTx, id: string, forUpdate: boolean): Promise<StoredObjectRecord> {
    const { tenantId, programmeIds } = tx.session;
    if (!isCanonicalUuid(id) || programmeIds.length === 0) throw new StoredObjectNotFoundError();
    // tenancy-reviewed: explicit tenant and programme filters from tx.session,
    // beside RLS (CLAUDE.md 2.3, R7).
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
    // tenancy-reviewed: the same explicit filters as the read; migration 0040's
    // guard holds the status moves.
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
