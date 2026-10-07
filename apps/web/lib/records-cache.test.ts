import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccount, listAccounts, listMyProgrammes, updateAccount } from './accounts-api';
import { convertLead, getLead, listLeads, moveLead } from './leads-api';
import { listContacts } from './records-api';

/**
 * Every records read and write carries a person's data (names, numbers,
 * companies, staff names) at a URL that is identical for every user of every
 * tenant. The browser must never answer one from its HTTP cache, nor store one
 * there, so every exported records call goes through `requestRecords` with
 * `cache: 'no-store'` — a second layer behind the API's own `no-store`.
 */

const ID = '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e11';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CALLS: Readonly<Record<string, () => Promise<unknown>>> = {
  listContacts: () => listContacts({}),
  listAccounts: () => listAccounts({}),
  createAccount: () => createAccount({ name: 'Bakare Logistics Ltd' }),
  updateAccount: () => updateAccount(ID, { version: 1, name: 'Bakare Logistics Ltd' }),
  listMyProgrammes: () => listMyProgrammes(),
  listLeads: () => listLeads({}),
  getLead: () => getLead(ID),
  moveLead: () => moveLead(ID, { version: 1, status: 'contacted' }),
  convertLead: () => convertLead(ID, { version: 1, newAccount: { name: 'Bakare Logistics Ltd' } }),
};

describe('records calls never touch the HTTP cache', () => {
  it.each(Object.keys(CALLS))('%s sends cache: no-store', async (name) => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    await CALLS[name]?.();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.cache).toBe('no-store');
  });
});
