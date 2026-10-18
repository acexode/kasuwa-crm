import type { TenantTx } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import { StorageError } from './errors';
import {
  STORAGE_PURPOSES,
  StorageKey,
  StoragePrefix,
  assertMintedKey,
  assertMintedPrefix,
  keyForStoredRow,
  mintStorageKey,
  tenantStoragePrefix,
} from './keys';

// Invented ids; nothing here is a person.
const TENANT = '0a000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '0b000000-0000-4000-8000-000000000001';
const P1 = '0a000000-0000-4000-8000-0000000000a1';
const P2 = '0a000000-0000-4000-8000-0000000000a2';
const USER = '0a000000-0000-4000-8000-0000000000f1';

function txWith(programmeIds: string[]): TenantTx {
  return {
    session: { tenantId: TENANT, userId: USER, programmeIds },
    query: async () => {
      throw new Error('minting must not query');
    },
  };
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('mintStorageKey', () => {
  it('builds tenant/<session tenant>/programme/<programme>/<purpose>/<fresh uuid>', () => {
    const first = String(mintStorageKey(txWith([P1]), { programmeId: P1, purpose: 'import' }));
    const second = String(mintStorageKey(txWith([P1]), { programmeId: P1, purpose: 'import' }));
    const match = new RegExp(`^tenant/${TENANT}/programme/${P1}/import/(.+)$`).exec(first);
    expect(match?.[1]).toMatch(UUID_V4);
    expect(first).not.toBe(second);
  });

  it('takes the tenant from the session and ignores any other input', () => {
    const input = {
      programmeId: P1,
      purpose: 'import',
      tenantId: OTHER_TENANT,
      fileId: P2,
      filename: 'list.csv',
    } as unknown as Parameters<typeof mintStorageKey>[1];
    const key = String(mintStorageKey(txWith([P1]), input));
    expect(key.startsWith(`tenant/${TENANT}/`)).toBe(true);
    expect(key).not.toContain(OTHER_TENANT);
    expect(key).not.toContain(P2);
    expect(key).not.toContain('csv');
  });

  it.each([
    ['a programme outside the session', P2],
    ['a traversal', `${P1}/../${P2}`],
    ['an upper-cased id', P1.toUpperCase()],
    ['an empty programme', ''],
  ])('refuses %s', (_label, programmeId) => {
    expect(() => mintStorageKey(txWith([P1]), { programmeId, purpose: 'import' })).toThrow(StorageError);
  });

  it('refuses a session with no programme', () => {
    expect(() => mintStorageKey(txWith([]), { programmeId: P1, purpose: 'import' })).toThrow(StorageError);
  });

  it.each(['export', 'IMPORT', '', 'import/../x'])('refuses the purpose %j', (purpose) => {
    expect(() =>
      mintStorageKey(txWith([P1]), { programmeId: P1, purpose } as unknown as Parameters<typeof mintStorageKey>[1]),
    ).toThrow(StorageError);
  });

  it('never names the input in a refusal', () => {
    try {
      mintStorageKey(txWith([P1]), { programmeId: P2, purpose: 'import' });
    } catch (error) {
      expect((error as Error).message).not.toContain(P2);
      expect((error as StorageError).code).toBe('storage_programme_out_of_scope');
      return;
    }
    throw new Error('it did not throw');
  });

  it('exports exactly one purpose', () => {
    expect([...STORAGE_PURPOSES]).toEqual(['import']);
  });
});

describe('StorageKey', () => {
  const key = mintStorageKey(txWith([P1]), { programmeId: P1, purpose: 'import' });

  it('recognises only keys this module minted', () => {
    const text = String(key);
    expect(StorageKey.isMinted(key)).toBe(true);
    for (const forged of [
      text,
      { toString: () => text },
      { ...(key as object) },
      Object.create(Object.getPrototypeOf(key) as object) as unknown,
      null,
      undefined,
    ]) {
      expect(StorageKey.isMinted(forged)).toBe(false);
      expect(() => assertMintedKey(forged)).toThrow(StorageError);
    }
  });

  it('cannot be constructed outside the module', () => {
    expect(
      () => new StorageKey(Symbol('forged'), { tenantId: TENANT, programmeId: P1, purpose: 'import', fileId: P2 }),
    ).toThrow(StorageError);
  });

  it('is redacted from JSON and from util.inspect', async () => {
    const { inspect } = await import('node:util');
    expect(JSON.stringify({ key })).not.toContain('tenant/');
    expect(inspect(key)).not.toContain('tenant/');
  });

  it('is rebuilt from a row read in scope with the same text', () => {
    const { tenantId, programmeId, purpose, fileId } = key.parts;
    expect(String(keyForStoredRow({ tenantId, programmeId, purpose, fileId }))).toBe(String(key));
  });

  it('refuses to rebuild from parts that are not canonical uuids', () => {
    expect(() => keyForStoredRow({ tenantId: '../x', programmeId: P1, purpose: 'import', fileId: P2 })).toThrow(
      StorageError,
    );
  });
});

describe('tenantStoragePrefix', () => {
  it('is tenant/<id>/', () => {
    expect(String(tenantStoragePrefix(TENANT))).toBe(`tenant/${TENANT}/`);
    expect(StoragePrefix.isMinted(tenantStoragePrefix(TENANT))).toBe(true);
  });

  it.each(['', 'not-a-uuid', `${TENANT}/`, `${TENANT}/../${OTHER_TENANT}`, '*', '../'])('refuses %j', (bad) => {
    expect(() => tenantStoragePrefix(bad)).toThrow(StorageError);
  });

  it('refuses a string or a look-alike where a prefix is expected', () => {
    for (const forged of ['', 'tenant/', `tenant/${TENANT}/`, { toString: () => `tenant/${TENANT}/` }]) {
      expect(() => assertMintedPrefix(forged)).toThrow(StorageError);
    }
  });
});
