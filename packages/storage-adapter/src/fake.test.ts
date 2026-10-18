import { Readable } from 'node:stream';
import type { TenantTx } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import { StorageError } from './errors';
import { FakeObjectStore } from './fake';
import { mintStorageKey, tenantStoragePrefix, type StorageKey } from './keys';
import { MIN_PART_BYTES, planParts } from './port';

const TENANT = '0a000000-0000-4000-8000-000000000001';
const OTHER = '0b000000-0000-4000-8000-000000000001';
const P1 = '0a000000-0000-4000-8000-0000000000a1';
const Q1 = '0b000000-0000-4000-8000-0000000000a1';

const tx = (tenantId: string, programmeId: string): TenantTx => ({
  session: { tenantId, userId: '0a000000-0000-4000-8000-0000000000f1', programmeIds: [programmeId] },
  query: async () => [],
});
const mint = (tenantId = TENANT, programmeId = P1): StorageKey =>
  mintStorageKey(tx(tenantId, programmeId), { programmeId, purpose: 'import' });

async function put(store: FakeObjectStore, key: StorageKey, body = Buffer.from('a,b\n1,2\n')): Promise<void> {
  await store.put(key, Readable.from([body]), { contentType: 'text/csv', contentLength: body.length });
}

describe('planParts', () => {
  it('sums to the total and keeps every part but the last at 5 MiB or more', () => {
    const total = 12 * 1024 * 1024 + 123;
    const parts = planParts(total, 2);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    expect(parts[0]).toBeGreaterThanOrEqual(MIN_PART_BYTES);
    expect(planParts(6 * 1024 * 1024, 2)).toEqual([MIN_PART_BYTES, 1024 * 1024]);
    expect(planParts(1024, 1)).toEqual([1024]);
  });

  it.each([
    [0, 1],
    [-1, 1],
    [10.5, 1],
    [1024, 0],
    [1024, 1.5],
    [6 * 1024 * 1024, 3],
    [1024, 2],
  ])('refuses length %d in %d part(s)', (length, count) => {
    expect(() => planParts(length, count)).toThrow(StorageError);
  });
});

describe('FakeObjectStore', () => {
  it('records AES256 on every put and every multipart create, and nothing when SSE is off', async () => {
    const store = new FakeObjectStore();
    const key = mint();
    await put(store, key);
    await store.presignUpload(mint(), { contentLength: 10, partCount: 1 });
    expect(store.requests.map((r) => [r.operation, r.serverSideEncryption, r.tagging])).toEqual([
      ['put', 'AES256', 'kasuwa-purpose=import'],
      ['createMultipartUpload', 'AES256', 'kasuwa-purpose=import'],
    ]);
    const off = new FakeObjectStore({ sseMode: 'off' });
    await put(off, mint());
    expect(off.requests[0]?.serverSideEncryption).toBeUndefined();
  });

  it('refuses every method on a key it did not mint', async () => {
    const store = new FakeObjectStore();
    const text = String(mint());
    for (const forged of [text, { toString: () => text }]) {
      const key = forged as unknown as StorageKey;
      await expect(put(store, key)).rejects.toBeInstanceOf(StorageError);
      await expect(store.head(key)).rejects.toBeInstanceOf(StorageError);
      await expect(store.getStream(key)).rejects.toBeInstanceOf(StorageError);
      await expect(store.delete(key)).rejects.toBeInstanceOf(StorageError);
      await expect(store.presignUpload(key, { contentLength: 1, partCount: 1 })).rejects.toBeInstanceOf(StorageError);
      await expect(store.completeUpload(key, 'u', [{ partNumber: 1, etag: '"e"' }])).rejects.toBeInstanceOf(StorageError);
      await expect(store.abortUpload(key, 'u')).rejects.toBeInstanceOf(StorageError);
    }
    expect(store.objects.size).toBe(0);
  });

  it('put, head (no content), getStream and an idempotent delete', async () => {
    const store = new FakeObjectStore();
    const key = mint();
    const body = Buffer.from('id,phone\n1,x\n');
    await put(store, key, body);
    const head = await store.head(key);
    expect(head?.size).toBe(body.length);
    expect(head?.contentType).toBe('text/csv');
    const chunks: Buffer[] = [];
    for await (const chunk of await store.getStream(key)) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).equals(body)).toBe(true);
    await store.delete(key);
    await store.delete(key);
    expect(await store.head(key)).toBeNull();
  });

  it('a part of the wrong length is refused, as the bucket refuses it; exact parts complete', async () => {
    const store = new FakeObjectStore();
    const key = mint();
    const upload = await store.presignUpload(key, { contentLength: 100, partCount: 1 });
    expect(upload.parts[0]?.url).toContain('X-Amz-Expires=300');
    expect(store.uploadPart(upload.uploadId, 1, Buffer.alloc(101)).status).toBe(403);
    const sent = store.uploadPart(upload.uploadId, 1, Buffer.alloc(100));
    expect(sent.status).toBe(200);
    await store.completeUpload(key, upload.uploadId, [{ partNumber: 1, etag: sent.etag }]);
    expect((await store.head(key))?.size).toBe(100);
  });

  it('an aborted upload cannot be completed', async () => {
    const store = new FakeObjectStore();
    const key = mint();
    const upload = await store.presignUpload(key, { contentLength: 10, partCount: 1 });
    const sent = store.uploadPart(upload.uploadId, 1, Buffer.alloc(10));
    await store.abortUpload(key, upload.uploadId);
    await expect(store.completeUpload(key, upload.uploadId, [{ partNumber: 1, etag: sent.etag }])).rejects.toMatchObject({
      code: 'storage_upload_not_found',
    });
    expect(await store.head(key)).toBeNull();
  });

  it('deletePrefix removes the tenant’s objects and open uploads, and nobody else’s', async () => {
    const store = new FakeObjectStore();
    const mine = mint();
    const theirs = mint(OTHER, Q1);
    await put(store, mine);
    await put(store, theirs);
    const open = await store.presignUpload(mint(), { contentLength: 10, partCount: 1 });
    await store.deletePrefix(tenantStoragePrefix(TENANT));
    expect(await store.head(mine)).toBeNull();
    expect(await store.head(theirs)).not.toBeNull();
    expect(store.openUploads()).not.toContain(open.uploadId);
    await expect(store.deletePrefix('tenant/' as never)).rejects.toBeInstanceOf(StorageError);
  });
});
