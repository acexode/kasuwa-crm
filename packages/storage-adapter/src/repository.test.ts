import type { TenantTx } from '@kasuwa/db';
import type * as Db from '@kasuwa/db';
import { describe, expect, it, vi } from 'vitest';
import { StoredObjectNotFoundError, StoredObjectStateError } from './errors';
import { FakeObjectStore } from './fake';
import type { ObjectStore } from './port';
import { StoredObjectRepository } from './repository';

// The live-transaction check (D-L155) needs a real withTenantTransaction.
// Here a stub tx counts as live once registered in `live`; the real check is
// tested in packages/db (live-tenant-tx.test.ts and its integration twin).
const live = vi.hoisted(() => new WeakSet<object>());
vi.mock('@kasuwa/db', async (importOriginal) => {
  const actual = await importOriginal<typeof Db>();
  return {
    ...actual,
    assertLiveTenantTx: (tx: unknown): void => {
      if (typeof tx !== 'object' || tx === null || !live.has(tx)) throw new actual.TenantTxNotLiveError();
    },
  };
});


/**
 * The repository's decisions against an in-memory stand-in for the table. The
 * real table, RLS and the bucket are the T-0092 acceptance suite's; this pins
 * the logic: scope is read from the session and filtered explicitly, an
 * unreachable id is one error and the store is never called, status moves
 * follow R8, and a short upload is rejected and deleted.
 */

const TENANT = '0a000000-0000-4000-8000-000000000001';
const P1 = '0a000000-0000-4000-8000-0000000000a1';
const P2 = '0a000000-0000-4000-8000-0000000000a2';
const USER = '0a000000-0000-4000-8000-0000000000f1';

type Row = Record<string, unknown>;

function register(registered: boolean, tx: TenantTx): TenantTx {
  if (registered) live.add(tx);
  return tx;
}

/** A tiny table that answers exactly the three statement shapes the repository sends. */
function table(): { rows: Row[]; tx: (programmeIds: string[], registered?: boolean) => TenantTx } {
  const rows: Row[] = [];
  const inScope = (row: Row, values: readonly unknown[]): boolean =>
    row.id === values[0] && row.tenant_id === values[1] && (values[2] as string[]).includes(row.programme_id as string);
  const tx = (programmeIds: string[], registered = true): TenantTx => register(registered, {
    session: { tenantId: TENANT, userId: USER, programmeIds },
    query: (async (text: string, values: readonly unknown[] = []): Promise<Row[]> => {
      const sql = text.trim();
      if (sql.startsWith('INSERT')) {
        const [id, tenant_id, programme_id, key, purpose, declared, content_type, uploaded_by_user_id] = values;
        const row: Row = {
          id,
          tenant_id,
          programme_id,
          key,
          purpose,
          status: 'pending',
          declared_size_bytes: String(declared),
          verified_size_bytes: null,
          content_type,
          uploaded_by_user_id,
          created_at: new Date(),
          expires_at: new Date(),
        };
        rows.push(row);
        return [row];
      }
      if (sql.startsWith('SELECT')) return rows.filter((row) => inScope(row, values));
      if (sql.startsWith('UPDATE')) {
        const row = rows.find((candidate) => inScope(candidate, values));
        if (row === undefined) return [];
        row.status = values[3];
        row.verified_size_bytes = values[4] === null ? null : String(values[4]);
        return [row];
      }
      throw new Error(`unexpected statement: ${sql.slice(0, 20)}`);
    }) as TenantTx['query'],
  });
  return { rows, tx };
}

function recording(inner: ObjectStore): { store: ObjectStore; calls: string[] } {
  const calls: string[] = [];
  const store = new Proxy(inner, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(name));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store, calls };
}

describe('StoredObjectRepository', () => {
  it('creates a pending row whose key is derived from its id, and never returns the key', async () => {
    const { rows, tx } = table();
    const repo = new StoredObjectRepository(new FakeObjectStore());
    const created = await repo.create(tx([P1]), {
      programmeId: P1,
      purpose: 'import',
      declaredSizeBytes: 10,
      contentType: 'text/csv',
    });
    expect(rows[0]?.key).toBe(`tenant/${TENANT}/programme/${P1}/import/${created.id}`);
    expect(rows[0]?.uploaded_by_user_id).toBe(USER);
    expect(JSON.stringify(created)).not.toContain('tenant/');
    expect(created).toMatchObject({ status: 'pending', declaredSizeBytes: 10, verifiedSizeBytes: null });
  });

  it('refuses to create outside the session, or with a bad size or type, writing nothing', async () => {
    const { rows, tx } = table();
    const repo = new StoredObjectRepository(new FakeObjectStore());
    const base = { programmeId: P1, purpose: 'import' as const, declaredSizeBytes: 10, contentType: 'text/csv' };
    await expect(repo.create(tx([P1]), { ...base, programmeId: P2 })).rejects.toThrow();
    await expect(repo.create(tx([P1]), { ...base, declaredSizeBytes: 0 })).rejects.toThrow();
    await expect(repo.create(tx([P1]), { ...base, contentType: 'text/csv\r\nx: y' })).rejects.toThrow();
    expect(rows).toEqual([]);
  });

  it('answers an unreachable, invented or malformed id, or a session with no programme, with ONE error and no store call', async () => {
    const { tx } = table();
    const { store, calls } = recording(new FakeObjectStore());
    const repo = new StoredObjectRepository(store);
    const row = await repo.create(tx([P1]), {
      programmeId: P1,
      purpose: 'import',
      declaredSizeBytes: 10,
      contentType: 'text/csv',
    });
    const messages = new Set<string>();
    for (const [session, id] of [
      [[P2], row.id],
      [[], row.id],
      [[P1], '0a000000-0000-4000-8000-00000000dead'],
      [[P1], 'not-a-uuid'],
    ] as const) {
      for (const call of [
        () => repo.get(tx([...session]), id),
        () => repo.presignUpload(tx([...session]), id, { partCount: 1 }),
        () => repo.completeUpload(tx([...session]), id, { uploadId: 'u', parts: [{ partNumber: 1, etag: '"e"' }] }),
        () => repo.markDeleted(tx([...session]), id),
      ]) {
        const error = await call().then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(StoredObjectNotFoundError);
        messages.add((error as Error).message);
      }
    }
    expect([...messages]).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('refuses every writing method on a tx that is not live, before any query or store call (D-L155)', async () => {
    const { rows, tx } = table();
    const { store, calls } = recording(new FakeObjectStore());
    const repo = new StoredObjectRepository(store);
    const id = '0a000000-0000-4000-8000-00000000beef';
    const forged = tx([P1], false);
    for (const call of [
      () => repo.create(forged, { programmeId: P1, purpose: 'import', declaredSizeBytes: 10, contentType: 'text/csv' }),
      () => repo.presignUpload(forged, id, { partCount: 1 }),
      () => repo.completeUpload(forged, id, { uploadId: 'u', parts: [{ partNumber: 1, etag: '"e"' }] }),
      () => repo.markDeleted(forged, id),
    ]) {
      await expect(call()).rejects.toThrow(/not a live tenant transaction/);
    }
    expect(rows).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('refuses a declared size over the purpose cap and a part count over it', async () => {
    const { tx } = table();
    const repo = new StoredObjectRepository(new FakeObjectStore());
    const base = { programmeId: P1, purpose: 'import' as const, contentType: 'text/csv' };
    await expect(repo.create(tx([P1]), { ...base, declaredSizeBytes: 25 * 1024 * 1024 + 1 })).rejects.toThrow();
    const row = await repo.create(tx([P1]), { ...base, declaredSizeBytes: 25 * 1024 * 1024 });
    await expect(repo.presignUpload(tx([P1]), row.id, { partCount: 5 })).rejects.toThrow();
  });

  it('signs the declared size, completes to uploaded, then markDeleted is terminal (R8)', async () => {
    const { tx } = table();
    const fake = new FakeObjectStore();
    const { store, calls } = recording(fake);
    const repo = new StoredObjectRepository(store);
    const row = await repo.create(tx([P1]), {
      programmeId: P1,
      purpose: 'import',
      declaredSizeBytes: 100,
      contentType: 'text/csv',
    });
    const upload = await repo.presignUpload(tx([P1]), row.id, { partCount: 1 });
    expect(upload.parts.map((part) => part.contentLength)).toEqual([100]);
    const sent = fake.uploadPart(upload.uploadId, 1, Buffer.alloc(100));
    const done = await repo.completeUpload(tx([P1]), row.id, {
      uploadId: upload.uploadId,
      parts: [{ partNumber: 1, etag: sent.etag }],
    });
    expect(done).toMatchObject({ status: 'uploaded', verifiedSizeBytes: 100 });
    await expect(repo.presignUpload(tx([P1]), row.id, { partCount: 1 })).rejects.toBeInstanceOf(StoredObjectStateError);
    const deleted = await repo.markDeleted(tx([P1]), row.id);
    expect(deleted.status).toBe('deleted');
    expect(fake.objects.size).toBe(0);
    const presigns = calls.filter((name) => name === 'presignUpload').length;
    await expect(repo.presignUpload(tx([P1]), row.id, { partCount: 1 })).rejects.toBeInstanceOf(StoredObjectStateError);
    expect(calls.filter((name) => name === 'presignUpload').length).toBe(presigns);
    expect((await repo.markDeleted(tx([P1]), row.id)).status).toBe('deleted');
  });

  it('rejects and deletes a short upload, returning the rejected row rather than throwing', async () => {
    const { tx } = table();
    const fake = new FakeObjectStore();
    const repo = new StoredObjectRepository(fake);
    const total = 12 * 1024 * 1024;
    const row = await repo.create(tx([P1]), {
      programmeId: P1,
      purpose: 'import',
      declaredSizeBytes: total,
      contentType: 'text/csv',
    });
    const upload = await repo.presignUpload(tx([P1]), row.id, { partCount: 2 });
    const first = upload.parts[0];
    const sent = fake.uploadPart(upload.uploadId, 1, Buffer.alloc(first?.contentLength ?? 0));
    const result = await repo.completeUpload(tx([P1]), row.id, {
      uploadId: upload.uploadId,
      parts: [{ partNumber: 1, etag: sent.etag }],
    });
    expect(result.status).toBe('rejected');
    expect(fake.objects.size).toBe(0);
  });
});
