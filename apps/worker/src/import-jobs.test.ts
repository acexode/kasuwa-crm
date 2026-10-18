import { describe, expect, it } from 'vitest';
import { processImportRetention, processImportRun, readHeaderRow, type ImportJobDeps } from './import-jobs';

async function* bytes(text: string): AsyncGenerator<Uint8Array> {
  yield new Uint8Array(Buffer.from(text, 'utf8'));
}

describe('readHeaderRow', () => {
  it('reads only the first row, BOM stripped, names trimmed', async () => {
    expect(await readHeaderRow(bytes('﻿Name, Mobile ,Email\nsecret,0803,x@y.z\n'))).toEqual(['Name', 'Mobile', 'Email']);
  });

  it('refuses a header the contract cannot hold: empty name, over 255 characters, over 500 columns', async () => {
    expect(await readHeaderRow(bytes('Name,,Email\n'))).toBeNull();
    expect(await readHeaderRow(bytes(`Name,${'x'.repeat(256)}\n`))).toBeNull();
    expect(await readHeaderRow(bytes(`${Array.from({ length: 501 }, (_, i) => `c${i}`).join(',')}\n`))).toBeNull();
    expect(await readHeaderRow(bytes(''))).toBeNull();
  });
});

describe('payloads (interface B, I5)', () => {
  const deps = {} as unknown as ImportJobDeps;
  const ids = {
    tenantId: '11111111-0000-4000-8000-000000000001',
    userId: '11111111-0000-4000-8000-000000000002',
    importId: '11111111-0000-4000-8000-000000000003',
  };

  it('refuses an extra key or a non-uuid before touching anything, with a message that carries no value', async () => {
    await expect(processImportRun(deps, { ...ids, programmeIds: ['x'] })).rejects.toThrow('import job payload refused');
    await expect(processImportRetention(deps, { ...ids, force: true })).rejects.toThrow('import job payload refused');
    await expect(processImportRun(deps, { ...ids, importId: 'zqcell' })).rejects.toThrow(/^import job payload refused$/);
  });
});
