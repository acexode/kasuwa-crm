import type { Readable } from 'node:stream';
import { StorageError } from './errors';
import type { StorageKey, StoragePrefix, StoragePurpose } from './keys';

/**
 * The object-store port (ADR-0017 Decision 1, T-0092 suite P). Exactly eight
 * methods, keyed by a minted StorageKey; no method takes a string key, a
 * bucket or a region.
 */

/** URLs expire in 5 minutes (ADR-0017 Decision 1). */
export const PRESIGNED_URL_TTL_SECONDS = 300;

/** S3's minimum size for every part but the last. */
export const MIN_PART_BYTES = 5 * 1024 * 1024;
/** S3's maximum part size and part count. */
export const MAX_PART_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_PARTS = 10_000;

/**
 * Per-purpose caps (D-L155, D-L128 Q4, D-L146): an import file is at most
 * 25 MiB in at most 4 parts. Enforced by both stores on put and presign, and
 * by the repository at create, so no caller can sign a URL for more.
 */
export const PURPOSE_LIMITS: Readonly<Record<StoragePurpose, { maxBytes: number; maxParts: number }>> =
  Object.freeze({ import: Object.freeze({ maxBytes: 25 * 1024 * 1024, maxParts: 4 }) });

export function assertWithinPurposeLimits(purpose: StoragePurpose, contentLength: number, partCount = 1): void {
  const limits = PURPOSE_LIMITS[purpose];
  if (contentLength > limits.maxBytes || partCount > limits.maxParts) {
    throw new StorageError('storage_invalid_request', 'the object exceeds the limits of its purpose');
  }
}

export interface PutOptions {
  readonly contentType: string;
  readonly contentLength: number;
}

/** What `head` reports. Never content. */
export interface ObjectHead {
  readonly size: number;
  readonly contentType: string | undefined;
  readonly etag: string | undefined;
  /** Base64 SHA-256, when the store kept one. */
  readonly checksumSha256: string | undefined;
}

export interface PresignUploadOptions {
  readonly contentLength: number;
  readonly partCount: number;
  /** Recorded on the object at CreateMultipartUpload. Optional: the store defaults it. */
  readonly contentType?: string;
}

export interface PresignedPart {
  readonly partNumber: number;
  readonly url: string;
  /** The exact body length this URL accepts: it is signed into the URL. */
  readonly contentLength: number;
}

export interface PresignedUpload {
  readonly uploadId: string;
  readonly parts: readonly PresignedPart[];
}

export interface CompletedPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface ObjectStore {
  put(key: StorageKey, body: Readable, options: PutOptions): Promise<void>;
  getStream(key: StorageKey): Promise<AsyncIterable<Uint8Array>>;
  /** `null`: there is no such object (D-L146 reconciles that to `deleted`). */
  head(key: StorageKey): Promise<ObjectHead | null>;
  /** Idempotent. */
  delete(key: StorageKey): Promise<void>;
  /** Every object under the prefix, and every in-flight multipart upload (R10). */
  deletePrefix(prefix: StoragePrefix): Promise<void>;
  presignUpload(key: StorageKey, options: PresignUploadOptions): Promise<PresignedUpload>;
  completeUpload(key: StorageKey, uploadId: string, parts: readonly CompletedPart[]): Promise<void>;
  abortUpload(key: StorageKey, uploadId: string): Promise<void>;
}

/**
 * The part lengths for a declared total: every part but the last is the same
 * size and at least 5 MiB, the last holds the remainder (at least one byte),
 * and they sum to the total. Refuses what S3 cannot accept.
 */
export function planParts(contentLength: number, partCount: number): number[] {
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    throw new StorageError('storage_invalid_request', 'the content length must be a positive integer');
  }
  if (!Number.isSafeInteger(partCount) || partCount < 1 || partCount > MAX_PARTS) {
    throw new StorageError('storage_invalid_request', 'the part count is out of range');
  }
  if (partCount === 1) {
    if (contentLength > MAX_PART_BYTES) {
      throw new StorageError('storage_invalid_request', 'a single part cannot hold this length');
    }
    return [contentLength];
  }
  const size = Math.max(Math.ceil(contentLength / partCount), MIN_PART_BYTES);
  const last = contentLength - size * (partCount - 1);
  if (last < 1 || size > MAX_PART_BYTES || last > MAX_PART_BYTES) {
    throw new StorageError(
      'storage_invalid_request',
      'the part count cannot satisfy the 5 MiB minimum for every part but the last',
    );
  }
  return [...Array.from({ length: partCount - 1 }, () => size), last];
}

const ETAG = /^"?[A-Za-z0-9-]{1,128}"?$/u;

/** Checks a client-supplied part list before it is sent anywhere. Returns it sorted. */
export function validateCompletedParts(parts: readonly CompletedPart[]): CompletedPart[] {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS) {
    throw new StorageError('storage_invalid_request', 'the part list is empty or too long');
  }
  const seen = new Set<number>();
  for (const part of parts) {
    const { partNumber, etag } = (part ?? {}) as { partNumber?: unknown; etag?: unknown };
    if (
      typeof partNumber !== 'number' ||
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > MAX_PARTS ||
      seen.has(partNumber) ||
      typeof etag !== 'string' ||
      !ETAG.test(etag)
    ) {
      throw new StorageError('storage_invalid_request', 'the part list is malformed');
    }
    seen.add(partNumber);
  }
  return [...parts].sort((a, b) => a.partNumber - b.partNumber);
}

const UPLOAD_ID = /^[A-Za-z0-9._~+/=-]{1,1024}$/u;

export function validateUploadId(uploadId: unknown): asserts uploadId is string {
  if (typeof uploadId !== 'string' || !UPLOAD_ID.test(uploadId)) {
    throw new StorageError('storage_invalid_request', 'the upload id is malformed');
  }
}

/** A conservative MIME shape: `type/subtype` with optional parameters, no control characters. */
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(?:\s*;\s*[a-z0-9-]+=[a-z0-9-]+)*$/iu;

export function isContentType(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && CONTENT_TYPE.test(value);
}
