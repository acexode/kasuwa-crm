import { Readable } from 'node:stream';
import { storageEnv } from '@kasuwa/config';
import { describe, expect, it } from 'vitest';
import { StorageError } from './errors';
import type { StorageKey, StoragePrefix } from './keys';
import { S3ObjectStore } from './s3-store';

/**
 * No network: every call below must be refused BEFORE a request is built. The
 * endpoint is a reserved, unroutable name, so a call that did reach the SDK
 * would fail with a different code (and slowly).
 */
const store = new S3ObjectStore(
  storageEnv({
    NODE_ENV: 'test',
    S3_ENDPOINT: 'http://storage.invalid:9',
    S3_REGION: 'af-south-1',
    S3_BUCKET: 'kasuwa-unit',
    S3_FORCE_PATH_STYLE: 'true',
    S3_ACCESS_KEY_ID: 'unit-access-not-real',
    S3_SECRET_ACCESS_KEY: 'unit-secret-not-real',
  }),
);

const forged = 'tenant/0a000000-0000-4000-8000-000000000001/programme/x/import/y' as unknown as StorageKey;

describe('S3ObjectStore is built only from storageEnv (D-L155)', () => {
  it('refuses a hand-assembled or copied configuration', () => {
    const real = storageEnv({ NODE_ENV: 'test', S3_REGION: 'af-south-1', S3_BUCKET: 'kasuwa-unit' });
    for (const config of [{ ...real }, { region: 'af-south-1', bucket: 'kasuwa-unit', sseMode: 'off' }]) {
      expect(() => new S3ObjectStore(config as typeof real)).toThrow(StorageError);
    }
  });
});

describe('S3ObjectStore refuses what it did not mint, before any request', () => {
  it.each([
    ['put', () => store.put(forged, Readable.from([Buffer.from('x')]), { contentType: 'text/csv', contentLength: 1 })],
    ['getStream', () => store.getStream(forged)],
    ['head', () => store.head(forged)],
    ['delete', () => store.delete(forged)],
    ['presignUpload', () => store.presignUpload(forged, { contentLength: 1, partCount: 1 })],
    ['completeUpload', () => store.completeUpload(forged, 'u', [{ partNumber: 1, etag: '"e"' }])],
    ['abortUpload', () => store.abortUpload(forged, 'u')],
    ['deletePrefix', () => store.deletePrefix('tenant/' as unknown as StoragePrefix)],
  ])('%s', async (_name, call) => {
    const error = await call().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code).toMatch(/^storage_(key|prefix)_refused$/);
    expect((error as Error).message).not.toContain('tenant/');
  });
});
