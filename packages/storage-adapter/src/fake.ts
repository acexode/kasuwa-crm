import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { StorageError } from './errors';
import { assertMintedKey, assertMintedPrefix, type StorageKey, type StoragePrefix } from './keys';
import {
  PRESIGNED_URL_TTL_SECONDS,
  assertWithinPurposeLimits,
  isContentType,
  planParts,
  validateCompletedParts,
  validateUploadId,
  type CompletedPart,
  type ObjectHead,
  type ObjectStore,
  type PresignUploadOptions,
  type PresignUploadPartsOptions,
  type PresignedPart,
  type PresignedUpload,
  selectPlannedParts,
  type PutOptions,
} from './port';

/**
 * An in-memory ObjectStore for unit tests (ADR-0017 Decision 1). TESTS ONLY:
 * it stores bytes in process memory and its "URLs" lead nowhere. App code may
 * not import it (eslint.config.mjs).
 *
 * It keeps the real store's rules: it refuses unminted keys and prefixes, it
 * plans parts with the same `planParts`, it records the encryption and the
 * lifecycle tag every write asked for (`requests`), so a unit test can assert
 * SSE was sent, and an
 * aborted upload cannot be completed. `uploadPart` stands in for the
 * browser's PUT and enforces the signed length as the bucket does.
 */

export interface FakeObjectStoreRequest {
  readonly operation: 'put' | 'createMultipartUpload';
  /** The key text. Test memory only. */
  readonly key: string;
  readonly serverSideEncryption: 'AES256' | undefined;
  /** The lifecycle tag the real store sends (D-L146). */
  readonly tagging: string;
}

interface StoredObject {
  readonly body: Buffer;
  readonly contentType: string;
  readonly serverSideEncryption: 'AES256' | undefined;
}

interface OpenUpload {
  readonly key: string;
  readonly contentType: string;
  readonly lengths: readonly number[];
  readonly parts: Map<number, { body: Buffer; etag: string }>;
}

function etagOf(body: Buffer): string {
  return `"${createHash('md5').update(body).digest('hex')}"`;
}

export class FakeObjectStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();
  readonly requests: FakeObjectStoreRequest[] = [];
  readonly #uploads = new Map<string, OpenUpload>();
  readonly #sse: 'AES256' | undefined;
  readonly #publicOrigin: string;

  constructor(options: { sseMode?: 'AES256' | 'off'; publicOrigin?: string } = {}) {
    this.#sse = options.sseMode === 'off' ? undefined : 'AES256';
    this.#publicOrigin = options.publicOrigin ?? 'https://storage.fake.invalid';
  }

  async put(key: StorageKey, body: Readable, options: PutOptions): Promise<void> {
    assertMintedKey(key);
    if (!isContentType(options.contentType) || !Number.isSafeInteger(options.contentLength)) {
      throw new StorageError('storage_invalid_request', 'the put options are malformed');
    }
    assertWithinPurposeLimits(key.parts.purpose, options.contentLength);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== options.contentLength) {
      throw new StorageError('storage_invalid_request', 'the body is not the declared length');
    }
    this.requests.push({
      operation: 'put',
      key: String(key),
      serverSideEncryption: this.#sse,
      tagging: `kasuwa-purpose=${key.parts.purpose}`,
    });
    this.objects.set(String(key), { body: bytes, contentType: options.contentType, serverSideEncryption: this.#sse });
  }

  async getStream(key: StorageKey): Promise<AsyncIterable<Uint8Array>> {
    assertMintedKey(key);
    const found = this.objects.get(String(key));
    if (found === undefined) throw new StorageError('storage_not_found', 'object storage get failed (NoSuchKey)');
    const body = found.body;
    return (async function* stream(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(body);
    })();
  }

  async head(key: StorageKey): Promise<ObjectHead | null> {
    assertMintedKey(key);
    const found = this.objects.get(String(key));
    if (found === undefined) return null;
    return {
      size: found.body.length,
      contentType: found.contentType,
      etag: etagOf(found.body),
      checksumSha256: createHash('sha256').update(found.body).digest('base64'),
    };
  }

  async delete(key: StorageKey): Promise<void> {
    assertMintedKey(key);
    this.objects.delete(String(key));
  }

  async deletePrefix(prefix: StoragePrefix): Promise<void> {
    assertMintedPrefix(prefix);
    const text = String(prefix);
    for (const [uploadId, upload] of this.#uploads) {
      if (upload.key.startsWith(text)) this.#uploads.delete(uploadId);
    }
    for (const name of [...this.objects.keys()]) {
      if (name.startsWith(text)) this.objects.delete(name);
    }
  }

  async presignUpload(key: StorageKey, options: PresignUploadOptions): Promise<PresignedUpload> {
    assertMintedKey(key);
    const lengths = planParts(options?.contentLength, options?.partCount);
    assertWithinPurposeLimits(key.parts.purpose, options.contentLength, options.partCount);
    const contentType = options.contentType ?? 'application/octet-stream';
    // One open upload per key, as the real store: an earlier one is aborted.
    for (const [openId, open] of this.#uploads) {
      if (open.key === String(key)) this.#uploads.delete(openId);
    }
    const uploadId = randomUUID();
    this.requests.push({
      operation: 'createMultipartUpload',
      key: String(key),
      serverSideEncryption: this.#sse,
      tagging: `kasuwa-purpose=${key.parts.purpose}`,
    });
    this.#uploads.set(uploadId, { key: String(key), contentType, lengths, parts: new Map() });
    return {
      uploadId,
      parts: lengths.map((contentLength, index) => ({
        partNumber: index + 1,
        url: `${this.#publicOrigin}/fake/${uploadId}/${index + 1}?X-Amz-Expires=${PRESIGNED_URL_TTL_SECONDS}`,
        contentLength,
      })),
    };
  }

  async presignUploadParts(
    key: StorageKey,
    uploadId: string,
    options: PresignUploadPartsOptions,
  ): Promise<readonly PresignedPart[]> {
    assertMintedKey(key);
    validateUploadId(uploadId);
    const selected = selectPlannedParts(options?.contentLength, options?.partCount, options?.partNumbers);
    const upload = this.#uploads.get(uploadId);
    if (upload === undefined || upload.key !== String(key)) {
      throw new StorageError('storage_upload_not_found', 'object storage upload not found (NoSuchUpload)');
    }
    return selected.map(({ partNumber, contentLength }) => ({
      partNumber,
      url: `${this.#publicOrigin}/fake/${uploadId}/${partNumber}?X-Amz-Expires=${PRESIGNED_URL_TTL_SECONDS}`,
      contentLength,
    }));
  }

  /** The browser's PUT of one part. Refuses a body of any length but the signed one, as the bucket does. */
  uploadPart(uploadId: string, partNumber: number, body: Buffer): { status: number; etag: string } {
    const upload = this.#uploads.get(uploadId);
    const expected = upload?.lengths[partNumber - 1];
    if (upload === undefined || expected === undefined || body.length !== expected) {
      return { status: 403, etag: '' };
    }
    const etag = etagOf(body);
    upload.parts.set(partNumber, { body, etag });
    return { status: 200, etag };
  }

  async completeUpload(key: StorageKey, uploadId: string, parts: readonly CompletedPart[]): Promise<void> {
    assertMintedKey(key);
    validateUploadId(uploadId);
    const sorted = validateCompletedParts(parts);
    const upload = this.#uploads.get(uploadId);
    if (upload === undefined || upload.key !== String(key)) {
      throw new StorageError('storage_upload_not_found', 'object storage complete upload failed (NoSuchUpload)');
    }
    const bodies: Buffer[] = [];
    for (const part of sorted) {
      const sent = upload.parts.get(part.partNumber);
      if (sent === undefined || sent.etag !== part.etag) {
        throw new StorageError('storage_request_failed', 'object storage complete upload failed (InvalidPart)');
      }
      bodies.push(sent.body);
    }
    this.#uploads.delete(uploadId);
    this.objects.set(upload.key, {
      body: Buffer.concat(bodies),
      contentType: upload.contentType,
      serverSideEncryption: this.#sse,
    });
  }

  async abortUpload(key: StorageKey, uploadId: string): Promise<void> {
    assertMintedKey(key);
    validateUploadId(uploadId);
    const upload = this.#uploads.get(uploadId);
    if (upload !== undefined && upload.key === String(key)) this.#uploads.delete(uploadId);
  }

  /** The ids of uploads still open (for assertions). */
  openUploads(): string[] {
    return [...this.#uploads.keys()];
  }
}
