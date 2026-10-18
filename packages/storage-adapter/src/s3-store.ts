import type { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageEnv } from '@kasuwa/config';
import { StorageError, wrapSdkError } from './errors';
import { assertMintedKey, assertMintedPrefix, type StorageKey, type StoragePrefix } from './keys';
import {
  PRESIGNED_URL_TTL_SECONDS,
  isContentType,
  planParts,
  validateCompletedParts,
  validateUploadId,
  type CompletedPart,
  type ObjectHead,
  type ObjectStore,
  type PresignUploadOptions,
  type PresignedUpload,
  type PutOptions,
} from './port';

/**
 * The one ObjectStore implementation (ADR-0017 Decision 1, D-L128 Q1): AWS S3
 * in af-south-1, a licensed MinIO in a Silo cell, SeaweedFS in development.
 * Built from `storageEnv(env)` and nothing else; no bucket, region or endpoint
 * is ever taken from a call.
 *
 * TWO CLIENTS. `internal` talks to S3_ENDPOINT, the host the API and worker
 * reach. `public` only SIGNS: the part URLs a browser uses carry
 * S3_PUBLIC_ENDPOINT's origin, which in development is not the Docker-internal
 * host. It never sends a request.
 *
 * EVERY CALL:
 *   - refuses a key or prefix this package did not mint, before any request;
 *   - wraps every SDK error (`wrapSdkError`): SeaweedFS's error XML names the
 *     key path, and the SDK keeps the raw response on the error;
 *   - logs nothing. The SDK's default logger is a no-op and none is passed.
 *
 * ENCRYPTION (D-L128 Q3): with S3_SSE_MODE=AES256 (the default) every
 * PutObject and every CreateMultipartUpload sends
 * `x-amz-server-side-encryption: AES256`. UploadPart needs none: the upload's
 * encryption is fixed at create.
 *
 * TAGGING (D-L146): every PutObject and CreateMultipartUpload tags the object
 * `kasuwa-purpose=<purpose>`, the tag the bucket lifecycle rule (expire at 8
 * days) matches, so erasure never depends on the sweeper job alone. The
 * purpose is not a leading prefix of the key, so a prefix filter could not do
 * it. In a real cell the store's identity needs s3:PutObjectTagging (T-0005).
 *
 * CHECKSUMS: `requestChecksumCalculation: 'WHEN_REQUIRED'`. The SDK's default
 * (since 3.729) adds CRC32 trailers and `x-amz-checksum-*` headers that
 * SeaweedFS 3.80 and older MinIO releases do not accept, and that a browser
 * PUT to a presigned part URL would have to repeat. DeleteObjects still sends
 * the checksum S3 requires for it.
 */

/** ListObjectsV2 page size asked for. SeaweedFS answers up to 10,000; AWS caps at 1,000. */
const LIST_PAGE = 10_000;
/** DeleteObjects takes at most 1,000 keys a call (AWS and SeaweedFS). */
const DELETE_BATCH = 1_000;
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** The lifecycle tag (D-L146). Built from the closed purpose enum, never from input. */
function lifecycleTag(key: StorageKey): string {
  return `kasuwa-purpose=${key.parts.purpose}`;
}

export class S3ObjectStore implements ObjectStore {
  readonly #internal: S3Client;
  readonly #public: S3Client;
  readonly #bucket: string;
  readonly #sse: { ServerSideEncryption: 'AES256' } | Record<string, never>;

  constructor(config: StorageEnv) {
    const base: S3ClientConfig = {
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...(config.credentials === undefined
        ? {}
        : {
            credentials: {
              accessKeyId: config.credentials.accessKeyId,
              secretAccessKey: config.credentials.secretAccessKey,
            },
          }),
    };
    this.#internal = new S3Client({
      ...base,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    });
    const publicEndpoint = config.publicEndpoint ?? config.endpoint;
    this.#public = new S3Client({
      ...base,
      ...(publicEndpoint === undefined ? {} : { endpoint: publicEndpoint }),
    });
    this.#bucket = config.bucket;
    this.#sse = config.sseMode === 'AES256' ? { ServerSideEncryption: 'AES256' } : {};
  }

  async put(key: StorageKey, body: Readable, options: PutOptions): Promise<void> {
    assertMintedKey(key);
    if (!Number.isSafeInteger(options?.contentLength) || options.contentLength < 0) {
      throw new StorageError('storage_invalid_request', 'the content length must be a non-negative integer');
    }
    if (!isContentType(options.contentType)) {
      throw new StorageError('storage_invalid_request', 'the content type is malformed');
    }
    await this.#send('put', () =>
      this.#internal.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: String(key),
          Body: body,
          ContentLength: options.contentLength,
          ContentType: options.contentType,
          Tagging: lifecycleTag(key),
          ...this.#sse,
        }),
      ),
    );
  }

  async getStream(key: StorageKey): Promise<AsyncIterable<Uint8Array>> {
    assertMintedKey(key);
    const output = await this.#send('get', () =>
      this.#internal.send(new GetObjectCommand({ Bucket: this.#bucket, Key: String(key) })),
    );
    const body = output.Body as AsyncIterable<Uint8Array> | undefined;
    if (body === undefined || typeof body[Symbol.asyncIterator] !== 'function') {
      throw new StorageError('storage_request_failed', 'object storage get returned no body');
    }
    // A failure mid-stream (a reset connection) is wrapped too.
    return (async function* stream(): AsyncGenerator<Uint8Array> {
      try {
        for await (const chunk of body) yield chunk;
      } catch (error) {
        throw wrapSdkError('get', error);
      }
    })();
  }

  async head(key: StorageKey): Promise<ObjectHead | null> {
    assertMintedKey(key);
    try {
      const output = await this.#internal.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: String(key) }),
      );
      return {
        size: output.ContentLength ?? 0,
        contentType: output.ContentType,
        etag: output.ETag,
        checksumSha256: output.ChecksumSHA256,
      };
    } catch (error) {
      const wrapped = wrapSdkError('head', error);
      if (wrapped.code === 'storage_not_found') return null;
      throw wrapped;
    }
  }

  async delete(key: StorageKey): Promise<void> {
    assertMintedKey(key);
    await this.#send('delete', () =>
      this.#internal.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: String(key) })),
    );
  }

  /**
   * Offboarding (ADR-0017, D-L128 Q2): every object under the prefix goes, and
   * so does every in-flight multipart upload (R10), or a browser holding a part
   * URL could complete the file back after the tenant left.
   *
   * Uploads are aborted FIRST, then objects deleted page by page, then uploads
   * swept once more (one opened while the delete ran). Each page is deleted in
   * batches of 1,000 and any per-key failure stops the run with a count, never
   * a key.
   */
  async deletePrefix(prefix: StoragePrefix): Promise<void> {
    assertMintedPrefix(prefix);
    const text = String(prefix);
    await this.#abortUploadsUnder(text);
    let token: string | undefined;
    do {
      const page = await this.#send('list', () =>
        this.#internal.send(
          new ListObjectsV2Command({
            Bucket: this.#bucket,
            Prefix: text,
            MaxKeys: LIST_PAGE,
            ...(token === undefined ? {} : { ContinuationToken: token }),
          }),
        ),
      );
      const keys = (page.Contents ?? [])
        .map((entry) => entry.Key)
        .filter((name): name is string => typeof name === 'string' && name.startsWith(text));
      for (let i = 0; i < keys.length; i += DELETE_BATCH) {
        const batch = keys.slice(i, i + DELETE_BATCH);
        const result = await this.#send('delete', () =>
          this.#internal.send(
            new DeleteObjectsCommand({
              Bucket: this.#bucket,
              Delete: { Objects: batch.map((name) => ({ Key: name })), Quiet: true },
            }),
          ),
        );
        const failed = result.Errors?.length ?? 0;
        if (failed > 0) {
          throw new StorageError(
            'storage_partial_delete',
            `object storage delete left ${failed} object(s) under the prefix`,
          );
        }
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    await this.#abortUploadsUnder(text);
  }

  async presignUpload(key: StorageKey, options: PresignUploadOptions): Promise<PresignedUpload> {
    assertMintedKey(key);
    const lengths = planParts(options?.contentLength, options?.partCount);
    const contentType = options.contentType ?? DEFAULT_CONTENT_TYPE;
    if (!isContentType(contentType)) {
      throw new StorageError('storage_invalid_request', 'the content type is malformed');
    }
    const created = await this.#send('create upload', () =>
      this.#internal.send(
        new CreateMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: String(key),
          ContentType: contentType,
          Tagging: lifecycleTag(key),
          ...this.#sse,
        }),
      ),
    );
    const uploadId = created.UploadId;
    if (uploadId === undefined || uploadId === '') {
      throw new StorageError('storage_request_failed', 'object storage create upload returned no upload id');
    }
    try {
      const parts = await Promise.all(
        lengths.map(async (contentLength, index) => {
          const partNumber = index + 1;
          const url = await getSignedUrl(
            this.#public,
            new UploadPartCommand({
              Bucket: this.#bucket,
              Key: String(key),
              UploadId: uploadId,
              PartNumber: partNumber,
              ContentLength: contentLength,
            }),
            // The length is SIGNED: the bucket refuses a body of any other
            // length (R5, observed on SeaweedFS 3.80; S3 does the same).
            { expiresIn: PRESIGNED_URL_TTL_SECONDS, signableHeaders: new Set(['content-length']) },
          );
          return { partNumber, url, contentLength };
        }),
      );
      return { uploadId, parts };
    } catch (error) {
      await this.abortUpload(key, uploadId).catch(() => undefined);
      throw wrapSdkError('presign', error);
    }
  }

  async completeUpload(key: StorageKey, uploadId: string, parts: readonly CompletedPart[]): Promise<void> {
    assertMintedKey(key);
    validateUploadId(uploadId);
    const sorted = validateCompletedParts(parts);
    await this.#send('complete upload', () =>
      this.#internal.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: String(key),
          UploadId: uploadId,
          MultipartUpload: { Parts: sorted.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) },
        }),
      ),
    );
  }

  /** Idempotent: an upload that is already gone is not an error. */
  async abortUpload(key: StorageKey, uploadId: string): Promise<void> {
    assertMintedKey(key);
    validateUploadId(uploadId);
    await this.#abort(String(key), uploadId);
  }

  async #abort(name: string, uploadId: string): Promise<void> {
    try {
      await this.#internal.send(
        new AbortMultipartUploadCommand({ Bucket: this.#bucket, Key: name, UploadId: uploadId }),
      );
    } catch (error) {
      const wrapped = wrapSdkError('abort upload', error);
      if (wrapped.code === 'storage_upload_not_found' || wrapped.code === 'storage_not_found') return;
      throw wrapped;
    }
  }

  async #abortUploadsUnder(prefix: string): Promise<void> {
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    for (;;) {
      const page = await this.#send('list uploads', () =>
        this.#internal.send(
          new ListMultipartUploadsCommand({
            Bucket: this.#bucket,
            Prefix: prefix,
            ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
            ...(uploadIdMarker === undefined ? {} : { UploadIdMarker: uploadIdMarker }),
          }),
        ),
      );
      for (const upload of page.Uploads ?? []) {
        if (typeof upload.Key === 'string' && upload.Key.startsWith(prefix) && typeof upload.UploadId === 'string') {
          await this.#abort(upload.Key, upload.UploadId);
        }
      }
      if (page.IsTruncated !== true) return;
      const nextKey = page.NextKeyMarker;
      const nextUpload = page.NextUploadIdMarker;
      if (nextKey === keyMarker && nextUpload === uploadIdMarker) return; // no progress: stop, never spin
      keyMarker = nextKey;
      uploadIdMarker = nextUpload;
    }
  }

  async #send<T>(operation: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw wrapSdkError(operation, error);
    }
  }
}
