import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Account,
  accountListSearch,
  createAccount,
  isAccountWithheld,
  listAccounts,
  listMyProgrammes,
  updateAccount,
} from './accounts-api';
import { hasDetail } from './records-api';

const ROW = {
  id: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01',
  programmeId: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a01',
  version: 2,
  name: 'Ọjà Foods Ltd',
  ownerUserId: null,
  owner: null,
  industry: 'FMCG',
  tier: 'mid_market',
  tags: ['Distributor'],
  phones: [{ type: 'work', e164: '+2348030000101' }],
  state: 'Lagos',
  lga: 'Ikeja',
  parentAccountId: null,
  createdAt: '2026-10-01T09:12:00.000Z',
  updatedAt: '2026-10-03T14:40:00.000Z',
  withheldFields: [],
};

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('accountListSearch', () => {
  it('sends only declared parameters, arrays exploded, and no scope', () => {
    const search = accountListSearch({
      q: '  Oja  ',
      owner: ['me', 'unassigned'],
      tier: ['sme'],
      tag: ['Credit hold'],
      state: ['Lagos'],
      sort: '-name',
      cursor: 'abc',
      limit: 25,
    });
    const params = new URLSearchParams(search.slice(1));
    expect(params.get('q')).toBe('Oja');
    expect(params.getAll('owner')).toEqual(['me', 'unassigned']);
    expect(params.getAll('tier')).toEqual(['sme']);
    expect(params.getAll('tag')).toEqual(['Credit hold']);
    expect(params.get('sort')).toBe('-name');
    expect(params.get('cursor')).toBe('abc');
    expect([...params.keys()].some((key) => /programme|tenant/i.test(key))).toBe(false);
  });

  it('caps q at the contract maximum, drops an empty one, and leaves the default sort to the server', () => {
    expect(new URLSearchParams(accountListSearch({ q: 'x'.repeat(150) }).slice(1)).get('q')).toHaveLength(100);
    expect(accountListSearch({ q: '   ' })).toBe('');
    expect(accountListSearch({ sort: 'name' })).toBe('');
  });
});

describe('the account schema', () => {
  it('accepts a row with withheld fields OMITTED, and tells withheld from null', () => {
    const { industry: _industry, phones: _phones, ...rest } = ROW;
    const row = Account.parse({ ...rest, withheldFields: ['industry', 'phones'] });
    expect(isAccountWithheld(row, 'industry')).toBe(true);
    expect(row.industry).toBeUndefined();
    const nulls = Account.parse({ ...ROW, industry: null });
    expect(isAccountWithheld(nulls, 'industry')).toBe(false);
    expect(nulls.industry).toBeNull();
  });

  it('refuses a tier the contract does not list', () => {
    expect(Account.safeParse({ ...ROW, tier: 'gold' }).success).toBe(false);
  });
});

describe('the account operations', () => {
  it('reads same-origin and parses the page', async () => {
    const fetch = vi.fn(async () => answer(200, { data: [ROW], nextCursor: 'next' }));
    vi.stubGlobal('fetch', fetch);
    const result = await listAccounts({ q: 'Oja' });
    expect(result).toEqual({ ok: true, value: { data: [ROW], nextCursor: 'next' } });
    expect(fetch).toHaveBeenCalledWith('/api/v1/accounts?q=Oja', expect.objectContaining({ method: 'GET' }));
  });

  it('reads a refusal by code and details, never by message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        answer(400, {
          statusCode: 400,
          error: 'Bad Request',
          code: 'validation_failed',
          message: 'Validation failed',
          details: [{ path: 'industry', code: 'field_withheld' }],
        }),
      ),
    );
    const result = await listAccounts({ industry: ['FMCG'] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation_failed');
      expect(hasDetail(result.error, 'field_withheld')).toBe(true);
      expect(JSON.stringify(result.error)).not.toContain('Validation failed');
    }
  });

  it('a dropped connection, or an answer the contract does not describe, is a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    expect(await listAccounts({})).toEqual({ ok: false, error: { code: 'network' } });
    vi.stubGlobal('fetch', vi.fn(async () => answer(200, { data: 'nope' })));
    expect(await listAccounts({})).toEqual({ ok: false, error: { code: 'network' } });
  });

  it('creates with a JSON body and updates by id with PATCH', async () => {
    const fetch = vi.fn(async () => answer(201, ROW));
    vi.stubGlobal('fetch', fetch);
    await createAccount({ name: 'Kano Grains Co.', programmeId: ROW.programmeId });
    expect(fetch).toHaveBeenLastCalledWith(
      '/api/v1/accounts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Kano Grains Co.', programmeId: ROW.programmeId }),
      }),
    );
    await updateAccount(ROW.id, { version: 2, name: 'X' });
    expect(fetch).toHaveBeenLastCalledWith(
      `/api/v1/accounts/${ROW.id}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ version: 2, name: 'X' }) }),
    );
  });

  it('lists the caller’s programmes with their names, and no scope of its own', async () => {
    const fetch = vi.fn(async () => answer(200, { data: [{ id: ROW.programmeId, name: 'Bank X Collections' }] }));
    vi.stubGlobal('fetch', fetch);
    expect(await listMyProgrammes()).toEqual({ ok: true, value: [{ id: ROW.programmeId, name: 'Bank X Collections' }] });
    expect(fetch).toHaveBeenCalledWith('/api/v1/me/programmes', expect.objectContaining({ method: 'GET' }));
  });
});
