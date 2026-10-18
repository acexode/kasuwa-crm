/**
 * The errors this package throws. Every one carries a string `code` and a
 * fixed message, and NOTHING else: no key, no URL, no endpoint, no credential,
 * no `cause`.
 *
 * Why no cause: an S3 error is unsafe to keep. SeaweedFS's error XML names the
 * full key path in `<Key>` and `<Resource>` (observed, T-0092 suite), a
 * SignatureDoesNotMatch body carries the canonical request (path included) and
 * the access key id, and the SDK keeps the raw response on `$response`. A
 * wrapper that kept the original as `cause` would carry all of it into any log
 * line that serialises the error. So the original is read for its status and
 * its S3 error code, both checked against a closed shape, and then dropped.
 */

export type StorageErrorCode =
  | 'storage_key_refused'
  | 'storage_prefix_refused'
  | 'storage_programme_out_of_scope'
  | 'storage_purpose_refused'
  | 'storage_invalid_request'
  | 'storage_not_found'
  | 'storage_access_denied'
  | 'storage_upload_not_found'
  | 'storage_request_failed'
  | 'storage_partial_delete';

export class StorageError extends Error {
  override readonly name = 'StorageError';
  readonly code: StorageErrorCode;
  /** The S3 error code (`NoSuchKey`, `SignatureDoesNotMatch`), when there was one. Never a path. */
  readonly providerCode: string | undefined;
  /** The HTTP status the bucket answered, when it answered. */
  readonly httpStatus: number | undefined;

  constructor(
    code: StorageErrorCode,
    message: string,
    details: { providerCode?: string | undefined; httpStatus?: number | undefined } = {},
  ) {
    super(message);
    this.code = code;
    this.providerCode = details.providerCode;
    this.httpStatus = details.httpStatus;
  }
}

/**
 * The ONE answer for a stored object the caller cannot see (CLAUDE.md 6.4):
 * another programme's, another tenant's, an invented id and a malformed one
 * all get exactly this message and code. It names no id.
 */
export class StoredObjectNotFoundError extends Error {
  override readonly name = 'StoredObjectNotFoundError';
  readonly code = 'stored_object_not_found' as const;

  constructor() {
    super('stored object not found');
  }
}

/** A move the row's status does not allow (R8). Only ever raised for a row the caller can see. */
export class StoredObjectStateError extends Error {
  override readonly name = 'StoredObjectStateError';
  readonly code = 'stored_object_state_conflict' as const;

  constructor() {
    super('the stored object is not in a state that allows this');
  }
}

/** An invalid argument to the repository (size, content type, part count). Names no value. */
export class StoredObjectInputError extends Error {
  override readonly name = 'StoredObjectInputError';
  readonly code = 'stored_object_invalid_input' as const;

  constructor(field: string) {
    super(`invalid ${field}`);
  }
}

const PROVIDER_CODE = /^[A-Za-z][A-Za-z0-9.]{0,63}$/u;

/**
 * Turns whatever the SDK threw into a StorageError holding only a status and a
 * closed-shape S3 error code. The original is not kept (see the header).
 */
export function wrapSdkError(operation: string, error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  let providerCode: string | undefined;
  let httpStatus: number | undefined;
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && PROVIDER_CODE.test(name)) providerCode = name;
    const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
    if (typeof status === 'number' && Number.isInteger(status)) httpStatus = status;
  }
  const code: StorageErrorCode =
    providerCode === 'NoSuchUpload'
      ? 'storage_upload_not_found'
      : httpStatus === 404 || providerCode === 'NoSuchKey' || providerCode === 'NotFound'
        ? 'storage_not_found'
        : httpStatus === 403
          ? 'storage_access_denied'
          : 'storage_request_failed';
  const suffix = providerCode === undefined ? '' : ` (${providerCode})`;
  return new StorageError(code, `object storage ${operation} failed${suffix}`, { providerCode, httpStatus });
}
