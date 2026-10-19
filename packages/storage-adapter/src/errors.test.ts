import { describe, expect, it } from 'vitest';
import { StorageError, StoredObjectNotFoundError, wrapSdkError } from './errors';

const KEY_PATH = 'tenant/0a000000-0000-4000-8000-000000000001/programme/x/import/y';

/** Every string reachable from a value, own properties included, across `cause`. */
function strings(root: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): void => {
    if (typeof value === 'string') {
      found.push(value);
      return;
    }
    if (value === null || typeof value !== 'object' || depth > 5 || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Error) found.push(String(value));
    for (const name of Object.getOwnPropertyNames(value)) {
      walk((value as Record<string, unknown>)[name], depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/** The shape of what the SDK throws for SeaweedFS's error XML. */
function sdkError(name: string, status: number): Error {
  return Object.assign(new Error(`The specified key does not exist. ${KEY_PATH}`), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: status, requestId: 'r-1' },
    Key: KEY_PATH,
    Resource: `/kasuwa-test/${KEY_PATH}`,
    $response: { body: `<Error><Key>${KEY_PATH}</Key></Error>` },
    cause: new Error(KEY_PATH),
  });
}

describe('wrapSdkError', () => {
  it('keeps the status and the S3 code and nothing else: no path anywhere, no cause', () => {
    const wrapped = wrapSdkError('get', sdkError('NoSuchKey', 404));
    expect(wrapped).toBeInstanceOf(StorageError);
    expect(wrapped.code).toBe('storage_not_found');
    expect(wrapped.providerCode).toBe('NoSuchKey');
    expect(wrapped.httpStatus).toBe(404);
    expect(wrapped.cause).toBeUndefined();
    expect(strings(wrapped).some((text) => text.includes('tenant/'))).toBe(false);
  });

  it.each([
    ['NoSuchUpload', 404, 'storage_upload_not_found'],
    ['NotFound', 404, 'storage_not_found'],
    ['SignatureDoesNotMatch', 403, 'storage_access_denied'],
    ['InternalError', 500, 'storage_request_failed'],
  ])('maps %s (%i) to %s', (name, status, code) => {
    expect(wrapSdkError('op', sdkError(name, status)).code).toBe(code);
  });

  it('refuses to carry a provider code that is not a bare word', () => {
    const wrapped = wrapSdkError('op', Object.assign(new Error('x'), { name: KEY_PATH }));
    expect(wrapped.providerCode).toBeUndefined();
    expect(wrapped.message).not.toContain('tenant/');
  });

  it('wraps a non-Error and passes a StorageError through', () => {
    expect(wrapSdkError('op', 'boom').code).toBe('storage_request_failed');
    const already = new StorageError('storage_key_refused', 'x');
    expect(wrapSdkError('op', already)).toBe(already);
  });
});

describe('StoredObjectNotFoundError', () => {
  it('is one message and one code, naming nothing', () => {
    const a = new StoredObjectNotFoundError();
    const b = new StoredObjectNotFoundError();
    expect([a.message, a.code]).toEqual([b.message, b.code]);
    expect(a.code).toBe('stored_object_not_found');
  });
});
