import { describe, expect, it } from 'vitest';
import type { Account } from '../../lib/accounts-api';
import type { Lead } from '../../lib/leads-api';
import {
  DEFAULT_LEAD_VIEW,
  LEAD_COLUMNS,
  LEAD_FILTERS,
  LEAD_SORTS,
  LEAD_STATUSES,
  NO_LEAD_FILTERS,
  convertAttempt,
  convertBody,
  convertInDoubt,
  convertOffer,
  convertRefusal,
  leadCellWithheld,
  leadListError,
  lockedLeadColumns,
  lockedLeadFilters,
  moveBody,
  moveRefusal,
  moveTargets,
  pickableAccounts,
  suggestedAccountName,
  toColumnQuery,
  toLeadQuery,
  toggleLeadFilter,
  withRowFirst,
  withheldFromLeadError,
  withoutRow,
} from './leads-model';

const PROGRAMME_ONE = '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a01';
const PROGRAMME_TWO = '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a02';

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e11',
    programmeId: PROGRAMME_ONE,
    version: 2,
    displayName: 'Tunde Bakare',
    companyName: 'Bakare Logistics',
    phones: [{ type: 'mobile', e164: '+2348060000002' }],
    accountId: null,
    account: null,
    ownerUserId: null,
    owner: null,
    status: 'new',
    source: 'manual',
    createdAt: '2026-10-06T08:00:00.000Z',
    updatedAt: '2026-10-06T08:00:00.000Z',
    withheldFields: [],
    ...overrides,
  };
}

function withheld(fields: string[], overrides: Partial<Lead> = {}): Lead {
  const row: Record<string, unknown> = { ...lead(overrides), withheldFields: fields };
  for (const field of fields) delete row[field];
  return row as Lead;
}

function account(id: string, programmeId: string, name: string): Account {
  return {
    id,
    programmeId,
    name,
    version: 1,
    createdAt: '2026-09-15T10:00:00.000Z',
    updatedAt: '2026-09-15T10:00:00.000Z',
    withheldFields: [],
  };
}

describe('the lead stages', () => {
  it('are the four listLeads stages, never customer', () => {
    expect(LEAD_STATUSES).toEqual(['new', 'contacted', 'qualified', 'unqualified']);
    expect(LEAD_FILTERS.find((filter) => filter.key === 'status')?.options).toEqual(LEAD_STATUSES);
  });

  it('filter chips are exactly listLeads’ filters', () => {
    expect(LEAD_FILTERS.map((filter) => filter.key).sort()).toEqual(['owner', 'source', 'status']);
  });

  it('columns are Contact properties, with no score, health or last activity', () => {
    expect(LEAD_COLUMNS.map((column) => column.key)).toEqual(['displayName', 'phones', 'whatsappOptIn', 'emails', 'companyName', 'owner', 'tags', 'status', 'source']);
  });

  it('sorts only by sort’s enum, and never by the name (it follows its name parts: sort=displayName is a 400, T-0124)', () => {
    expect([...LEAD_SORTS].sort()).toEqual(['-createdAt', 'createdAt', '-updatedAt', 'updatedAt'].sort());
    expect(LEAD_SORTS.some((sort) => /displayName/.test(sort))).toBe(false);
  });
});

describe('locks are per row', () => {
  it('a withheld field locks its cell; a null never does', () => {
    expect(leadCellWithheld(withheld(['companyName']), 'companyName')).toBe(true);
    expect(leadCellWithheld(lead({ companyName: null }), 'companyName')).toBe(false);
    // owner and ownerUserId are withheld together; either locks the owner cell.
    expect(leadCellWithheld(withheld(['ownerUserId', 'owner']), 'owner')).toBe(true);
  });

  it('a header carries a lock only when some row withholds the column', () => {
    expect(lockedLeadColumns([lead(), withheld(['phones'])])).toEqual(['phones']);
    expect(lockedLeadColumns([lead()])).toEqual([]);
  });

  it('a filter on a field seen withheld is locked, and a refusal names one through its parameter', () => {
    expect(lockedLeadFilters(new Set(['owner', 'ownerUserId']))).toEqual(['owner']);
    expect(lockedLeadFilters(new Set(['emails']))).toEqual([]);
    expect(withheldFromLeadError({ code: 'validation_failed', details: [{ path: 'owner', code: 'field_withheld' }] })).toEqual([
      'ownerUserId',
      'owner',
    ]);
  });
});

describe('the queries', () => {
  it('the table sends q, its filters and its sort, never a scope', () => {
    const view = { filters: toggleLeadFilter(toggleLeadFilter(NO_LEAD_FILTERS, 'status', 'contacted'), 'owner', 'me'), sort: '-updatedAt' as const };
    const query = toLeadQuery(' Fabrics ', view, 'cursor-1');
    expect(query).toEqual({
      q: 'Fabrics',
      owner: ['me'],
      status: ['contacted'],
      sort: '-updatedAt',
      cursor: 'cursor-1',
      limit: 25,
    });
  });

  it('a status the contract does not list as a lead stage is never sent', () => {
    const view = { ...DEFAULT_LEAD_VIEW, filters: { ...NO_LEAD_FILTERS, status: ['customer', 'new'] } };
    expect(toLeadQuery('', view).status).toEqual(['new']);
  });

  it('a Kanban column reads its own stage alone, whatever the status filter says', () => {
    const view = { filters: { ...NO_LEAD_FILTERS, status: ['new'], source: ['whatsapp'] }, sort: '-createdAt' as const };
    const query = toColumnQuery('a', { ...view, column: 'qualified' });
    expect(query.status).toEqual(['qualified']);
    expect(query.source).toEqual(['whatsapp']);
    expect(query.q).toBe('a');
  });
});

describe('the Kanban move', () => {
  it('is exactly { version, status } with the served version', () => {
    expect(moveBody(lead({ version: 7 }), 'contacted')).toEqual({ version: 7, status: 'contacted' });
  });

  it('sends nothing for its own column, a non-lead stage, or a withheld status', () => {
    expect(moveBody(lead(), 'new')).toBeNull();
    expect(moveBody(lead(), 'customer')).toBeNull();
    expect(moveBody(lead(), 'nonsense')).toBeNull();
    expect(moveBody(withheld(['status']), 'contacted')).toBeNull();
  });

  it('offers every lead stage but the card’s own', () => {
    expect(moveTargets(lead({ status: 'contacted' }))).toEqual(['new', 'qualified', 'unqualified']);
  });

  it('a moved card lands first in its column, never twice, and leaves the old one', () => {
    const a = lead({ id: 'a' });
    const b = lead({ id: 'b' });
    expect(withRowFirst([a, b], { ...b, version: 3 }).map((row) => [row.id, row.version])).toEqual([
      ['b', 3],
      ['a', 2],
    ]);
    expect(withoutRow([a, b], 'a').map((row) => row.id)).toEqual(['b']);
  });

  it('a refusal is translated copy, by code', () => {
    expect(moveRefusal({ code: 'not_permitted' })).toBe('leads.move.error.notPermitted');
    expect(moveRefusal({ code: 'stale_write' })).toBe('leads.move.error.stale');
    expect(moveRefusal({ code: 'network' })).toBe('records.error.network');
  });
});

describe('convert', () => {
  it('is offered unless the row withholds status or accountId, and not again once converted', () => {
    expect(convertOffer(lead())).toBe('offer');
    expect(convertOffer(withheld(['accountId', 'account']))).toBe('locked');
    expect(convertOffer(withheld(['status']))).toBe('locked');
    expect(convertOffer(lead({ status: 'qualified', accountId: 'acc', account: { id: 'acc', name: 'Ọjà Foods Ltd' } }))).toBe(
      'converted',
    );
    // Qualified with no account yet: still to convert.
    expect(convertOffer(lead({ status: 'qualified' }))).toBe('offer');
  });

  it('the picker offers only the lead’s own programme’s accounts', () => {
    const accounts = [account('a1', PROGRAMME_ONE, 'Bakare Logistics Ltd'), account('a2', PROGRAMME_TWO, 'Lagos Water Depot Ltd')];
    expect(pickableAccounts(accounts, PROGRAMME_ONE).map((row) => row.id)).toEqual(['a1']);
    expect(pickableAccounts(accounts, PROGRAMME_TWO).map((row) => row.id)).toEqual(['a2']);
  });

  it('the body is version plus exactly one of accountId or newAccount', () => {
    expect(convertBody(lead(), { mode: 'existing', accountId: 'a1', name: 'ignored' })).toEqual({
      ok: true,
      body: { version: 2, accountId: 'a1' },
    });
    expect(convertBody(lead(), { mode: 'new', accountId: 'a1', name: '  Bakare Logistics  ' })).toEqual({
      ok: true,
      body: { version: 2, newAccount: { name: 'Bakare Logistics' } },
    });
    expect(convertBody(lead(), { mode: 'existing', accountId: null, name: '' })).toEqual({
      ok: false,
      invalid: 'leads.convert.invalid.account',
    });
    expect(convertBody(lead(), { mode: 'new', accountId: null, name: '   ' })).toEqual({ ok: false, invalid: 'accounts.invalid.name' });
    expect(convertBody(lead(), { mode: 'new', accountId: null, name: 'x'.repeat(201) }).ok).toBe(false);
  });

  it('prefills the new account from a readable company only', () => {
    expect(suggestedAccountName(lead())).toBe('Bakare Logistics');
    expect(suggestedAccountName(lead({ companyName: null }))).toBe('');
    expect(suggestedAccountName(withheld(['companyName']))).toBe('');
    // Listed as withheld but still carried (a row that disagrees with itself):
    // the list wins, and the value is never read.
    expect(suggestedAccountName(lead({ withheldFields: ['companyName'], companyName: 'Should Not Show' }))).toBe('');
  });

  it('after a lost answer re-sends exactly the lost body, whatever is chosen now', () => {
    const lost = { version: 2, newAccount: { name: 'Bakare Logistics' } } as const;
    const changed = { mode: 'existing' as const, accountId: 'a9', name: 'Something else' };
    expect(convertAttempt(lost, lead({ version: 3 }), changed)).toEqual({ ok: true, body: lost });
    // With nothing lost, a press builds a fresh body from the choice.
    expect(convertAttempt(null, lead({ version: 3 }), changed)).toEqual({
      ok: true,
      body: { version: 3, accountId: 'a9' },
    });
  });

  it('only a lost answer leaves a convert in doubt; a refusal is definitive', () => {
    expect(convertInDoubt({ code: 'network' })).toBe(true);
    for (const code of ['not_permitted', 'stale_write', 'not_found', 'validation_failed', 'internal_error'] as const) {
      expect(convertInDoubt({ code }), code).toBe(false);
    }
  });

  it('already_linked has its own sentence, and a lost answer says a retry is safe', () => {
    const linked = { code: 'validation_failed' as const, details: [{ path: 'newAccount', code: 'already_linked' }] };
    expect(convertRefusal(linked, 'new')).toBe('leads.convert.error.already_linked');
    expect(convertRefusal({ code: 'validation_failed' }, 'new')).toBe('accounts.error.notAccepted');
    expect(convertRefusal({ code: 'network' }, 'new')).toBe('leads.convert.lost');
    expect(convertRefusal({ code: 'not_permitted' }, 'new')).toBe('leads.convert.error.notPermitted');
    expect(
      convertRefusal({ code: 'not_permitted', details: [{ path: 'accountId', code: 'field_not_editable' }] }, 'existing'),
    ).toBe('accounts.error.fieldNotEditable');
    expect(convertRefusal({ code: 'stale_write' }, 'existing')).toBe('leads.convert.error.stale');
    expect(convertRefusal({ code: 'not_found' }, 'existing')).toBe('leads.convert.error.accountNotFound');
    expect(convertRefusal({ code: 'not_found' }, 'new')).toBe('records.error.not_found');
  });
});

describe('a refused list read', () => {
  it('status withheld anywhere is its own sentence, never "no leads"', () => {
    expect(leadListError({ code: 'validation_failed', details: [{ path: 'status', code: 'field_withheld' }] })).toBe(
      'leads.error.statusWithheld',
    );
    expect(leadListError({ code: 'validation_failed', details: [{ path: 'owner', code: 'field_withheld' }] })).toBe(
      'accounts.error.fieldWithheld',
    );
    expect(leadListError({ code: 'network' })).toBe('records.error.network');
    expect(leadListError(null)).toBe('records.error.network');
  });
});
