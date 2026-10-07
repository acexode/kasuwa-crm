import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { Account } from '../../lib/accounts-api';
import { appendPage } from '../records/list-model';
import {
  ACCOUNT_COLUMNS,
  ACCOUNT_FILTERS,
  ACCOUNT_SORTS,
  DEFAULT_ACCOUNT_VIEW,
  NO_ACCOUNT_FILTERS,
  accountToForm,
  addFreeValue,
  cardShows,
  cellWithheld,
  createBody,
  defaultHiddenAccountColumns,
  emptyAccountForm,
  listErrorMessage,
  lockedAccountColumns,
  lockedAccountFilters,
  lockedFormFields,
  nameAriaSort,
  programmeName,
  refusalMessage,
  toAccountQuery,
  toggleAccountColumn,
  toggleAccountFilter,
  updateBody,
  validateAccountForm,
  withheldFromError,
  type AccountForm,
} from './accounts-model';

const here = dirname(fileURLToPath(import.meta.url));

const contract = parse(
  readFileSync(resolve(here, '..', '..', '..', '..', 'docs', 'api', 'records.openapi.yaml'), 'utf8'),
) as {
  paths: Record<string, { get: { parameters: ({ name?: string; $ref?: string; schema?: { enum?: string[] } })[] } }>;
  components: { schemas: { Account: { properties: Record<string, unknown> } } };
};

const ACCOUNT_PROPERTIES = Object.keys(contract.components.schemas.Account.properties);
const LIST_PARAMETERS = contract.paths['/api/v1/accounts']?.get.parameters ?? [];

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'a-1',
    programmeId: 'p-1',
    name: 'Ọjà Foods Ltd',
    version: 2,
    ownerUserId: null,
    owner: null,
    industry: 'FMCG',
    tier: 'mid_market',
    tags: ['Distributor'],
    phones: [{ type: 'mobile', e164: '+2348030000101' }],
    state: 'Lagos',
    lga: 'Ikeja',
    parentAccountId: null,
    createdAt: '2026-10-01T09:12:00.000Z',
    updatedAt: '2026-10-03T14:40:00.000Z',
    withheldFields: [],
    ...overrides,
  };
}

/** A row as field security sends it: the withheld properties absent, and named. */
function withheld(row: Account, fields: readonly string[]): Account {
  const copy: Record<string, unknown> = { ...row, withheldFields: [...fields] };
  for (const field of fields) delete copy[field];
  return copy as unknown as Account;
}

describe('columns are Account properties (the contract wins over the design)', () => {
  it('draws no column without a property: no Health, no rollups', () => {
    for (const column of ACCOUNT_COLUMNS) {
      expect(ACCOUNT_PROPERTIES, column.key).toContain(column.key);
      for (const field of column.fields) expect(ACCOUNT_PROPERTIES, field).toContain(field);
    }
  });

  it('never hides the name, and hides and restores the rest', () => {
    expect(toggleAccountColumn([], 'name')).toEqual([]);
    expect(toggleAccountColumn([], 'tags')).toEqual(['tags']);
    expect(toggleAccountColumn(['tags'], 'tags')).toEqual([]);
    expect(defaultHiddenAccountColumns()).toEqual(['programmeId']);
  });

  it('locks per row, and a null is never a lock', () => {
    const locked = withheld(account({ id: 'a-2' }), ['industry', 'phones']);
    const nulls = account({ id: 'a-3', industry: null, phones: [] });
    expect(cellWithheld(locked, 'industry')).toBe(true);
    expect(cellWithheld(nulls, 'industry')).toBe(false);
    expect(cellWithheld(account(), 'industry')).toBe(false);
    expect(lockedAccountColumns([account(), locked, nulls])).toEqual(['industry', 'phones']);
  });

  it('a 360 px card leaves out what nobody filled in, and always shows a lock', () => {
    const nulls = account({ industry: null, tier: null, phones: [], tags: [], state: null });
    expect(['tier', 'industry', 'phones', 'tags', 'state'].map((key) => cardShows(nulls, key as 'tier'))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(cardShows(nulls, 'owner')).toBe(true);
    expect(cardShows(account(), 'industry')).toBe(true);
    expect(cardShows(withheld(account(), ['phones']), 'phones')).toBe(true);
  });

  it('locks the owner column when either owner property is withheld', () => {
    expect(cellWithheld(withheld(account(), ['owner', 'ownerUserId']), 'owner')).toBe(true);
  });
});

describe('filters are listAccounts parameters', () => {
  it('offers exactly the declared filter parameters, and the tier codes the contract lists', () => {
    const declared = LIST_PARAMETERS.map((parameter) => parameter.name).filter(
      (name): name is string => name !== undefined && !['q', 'sort'].includes(name),
    );
    expect(ACCOUNT_FILTERS.map((filter) => filter.key).sort()).toEqual([...declared].sort());
    expect(ACCOUNT_FILTERS.find((filter) => filter.key === 'tier')?.options).toEqual(['enterprise', 'mid_market', 'sme']);
  });

  it('sorts only by the contract enum', () => {
    const sort = LIST_PARAMETERS.find((parameter) => parameter.name === 'sort');
    expect([...ACCOUNT_SORTS].sort()).toEqual([...(sort?.schema?.enum ?? [])].sort());
    expect(nameAriaSort('name')).toBe('ascending');
    expect(nameAriaSort('-name')).toBe('descending');
    expect(nameAriaSort('-updatedAt')).toBe('none');
  });

  it('toggles options and adds typed values trimmed, once, within maxItems', () => {
    expect(toggleAccountFilter(NO_ACCOUNT_FILTERS, 'tier', 'sme').tier).toEqual(['sme']);
    expect(toggleAccountFilter({ ...NO_ACCOUNT_FILTERS, tier: ['sme'] }, 'tier', 'sme').tier).toEqual([]);
    const tagged = addFreeValue(NO_ACCOUNT_FILTERS, 'tag', '  Credit hold ');
    expect(tagged.tag).toEqual(['Credit hold']);
    expect(addFreeValue(tagged, 'tag', 'credit HOLD')).toBe(tagged);
    expect(addFreeValue(tagged, 'tag', '   ')).toBe(tagged);
    expect(addFreeValue(tagged, 'tag', 'x'.repeat(65))).toBe(tagged);
    const full = { ...NO_ACCOUNT_FILTERS, tag: Array.from({ length: 20 }, (_, index) => `t${index}`) };
    expect(addFreeValue(full, 'tag', 'one more')).toBe(full);
  });

  it('locks a filter whose field the caller has been shown withheld, and reads a field_withheld refusal', () => {
    expect(lockedAccountFilters(new Set(['industry']))).toEqual(['industry']);
    expect(lockedAccountFilters(new Set(['ownerUserId', 'tags']))).toEqual(['owner', 'tag']);
    const refusal = { code: 'validation_failed' as const, details: [{ path: 'industry', code: 'field_withheld' }] };
    expect(withheldFromError(refusal)).toEqual(['industry']);
    expect(listErrorMessage(refusal)).toBe('accounts.error.fieldWithheld');
    expect(listErrorMessage({ code: 'network' })).toBe('records.error.network');
    expect(listErrorMessage(null)).toBe('records.error.network');
  });

  it('builds a query with no scope, and drops the cursor when it is not paging', () => {
    const view = { filters: { ...NO_ACCOUNT_FILTERS, tier: ['sme', 'gold'], owner: ['me'] }, sort: '-name' as const };
    const query = toAccountQuery('  Oja ', view);
    expect(query).toEqual({ q: 'Oja', owner: ['me'], tier: ['sme'], sort: '-name', limit: 25 });
    expect(toAccountQuery('', DEFAULT_ACCOUNT_VIEW, 'c1')).toEqual({ sort: 'name', cursor: 'c1', limit: 25 });
    expect(Object.keys(query).some((key) => /programme/i.test(key))).toBe(false);
  });
});

describe('the create and edit sheet', () => {
  const programmes = [
    { id: 'p-1', name: 'Bank X Collections' },
    { id: 'p-2', name: 'Lagos Water Customer Care' },
  ];
  const blank = (overrides: Partial<AccountForm> = {}): AccountForm => ({ ...emptyAccountForm(null), ...overrides });

  it('preselects the only programme, and asks when there are several', () => {
    expect(emptyAccountForm([programmes[0] ?? { id: '', name: '' }]).programmeId).toBe('p-1');
    expect(emptyAccountForm(programmes).programmeId).toBe('');
    const missing = validateAccountForm(blank({ name: 'Kano Grains Co.' }), { needProgramme: true, locked: [] });
    expect(missing).toEqual({ ok: false, errors: { programmeId: 'accounts.invalid.programme' } });
  });

  it('checks the name, the lengths and E.164 before anything is sent', () => {
    const result = validateAccountForm(
      blank({ name: ' ', industry: 'x'.repeat(65), phones: '0803 000 0101', tags: 'ok, ' + 'y'.repeat(65) }),
      { needProgramme: false, locked: [] },
    );
    expect(result).toEqual({
      ok: false,
      errors: {
        name: 'accounts.invalid.name',
        industry: 'accounts.invalid.tooLong',
        phones: 'accounts.invalid.phones',
        tags: 'accounts.invalid.tags',
      },
    });
  });

  it('creates with the chosen programme and only what was filled in', () => {
    const result = validateAccountForm(
      blank({ programmeId: 'p-1', name: ' Kano Grains Co. ', tier: 'sme', tags: 'Agro, agro, Export', phones: '+234 806 000 0102' }),
      { needProgramme: true, locked: [] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(createBody(result.values, 'p-1')).toEqual({
      programmeId: 'p-1',
      name: 'Kano Grains Co.',
      tier: 'sme',
      tags: ['Agro', 'Export'],
      phones: [{ type: 'work', e164: '+2348060000102' }],
    });
    expect('programmeId' in createBody(result.values, '')).toBe(false);
  });

  it('edits with the served version and only what changed', () => {
    const row = account();
    const form = { ...accountToForm(row), name: 'Ọjà Foods Nigeria Ltd' };
    const result = validateAccountForm(form, { needProgramme: false, locked: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(updateBody(row, result.values)).toEqual({ version: 2, name: 'Ọjà Foods Nigeria Ltd' });
    const unchanged = validateAccountForm(accountToForm(row), { needProgramme: false, locked: [] });
    expect(unchanged.ok && updateBody(row, unchanged.values)).toBeNull();
  });

  it('keeps the type of a number the row already had, and clears with null', () => {
    const row = account();
    const form = { ...accountToForm(row), phones: '+2348030000101, +2348030000999', industry: '', tier: '' };
    const result = validateAccountForm(form, { needProgramme: false, locked: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(updateBody(row, result.values)).toEqual({
      version: 2,
      industry: null,
      tier: null,
      phones: [
        { type: 'mobile', e164: '+2348030000101' },
        { type: 'work', e164: '+2348030000999' },
      ],
    });
  });

  it('never sends a field the row withholds, so it can never clear one', () => {
    const row = withheld(account({ version: 4 }), ['industry', 'phones']);
    expect(lockedFormFields(row)).toEqual(['industry', 'phones']);
    const form = { ...accountToForm(row), name: 'Ibadan Haulage & Storage Ltd' };
    expect(form.phones).toBe('');
    const result = validateAccountForm(form, { needProgramme: false, locked: lockedFormFields(row) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(updateBody(row, result.values)).toEqual({ version: 4, name: 'Ibadan Haulage & Storage Ltd' });
  });

  it('says a refusal in its own words: the field, the permission, the stale version', () => {
    expect(refusalMessage({ code: 'not_permitted' })).toBe('records.error.not_permitted');
    expect(refusalMessage({ code: 'not_permitted', details: [{ path: 'tier', code: 'field_not_editable' }] })).toBe(
      'accounts.error.fieldNotEditable',
    );
    expect(refusalMessage({ code: 'stale_write' })).toBe('records.error.stale_write');
    expect(refusalMessage({ code: 'validation_failed' })).toBe('accounts.error.notAccepted');
  });

  it('names a programme, never prints its id', () => {
    expect(programmeName(programmes, 'p-2')).toBe('Lagos Water Customer Care');
    expect(programmeName(programmes, 'p-9')).toBeNull();
    expect(programmeName(null, 'p-1')).toBeNull();
  });
});

describe('paging', () => {
  it('appends a page without repeating a row already held', () => {
    const one = account({ id: 'a-1' });
    const two = account({ id: 'a-2' });
    expect(appendPage([one], [one, two]).map((row) => row.id)).toEqual(['a-1', 'a-2']);
  });
});
