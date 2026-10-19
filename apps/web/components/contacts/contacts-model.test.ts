import { describe, expect, it } from 'vitest';
import { contactListSearch, isWithheld, type Contact } from '../../lib/records-api';
import {
  COLUMNS,
  FILTERS,
  NO_FILTERS,
  defaultHiddenColumns,
  formatPhone,
  formatSyncedAt,
  initials,
  listState,
  lockedColumns,
  toListQuery,
  toggleColumn,
  toggleFilter,
} from './contacts-model';

function contact(overrides: Partial<Contact>): Contact {
  return {
    id: 'c-1',
    programmeId: 'p-1',
    version: 1,
    displayName: 'Ada Obi',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    withheldFields: [],
    ...overrides,
  };
}

describe('P04/02 columns', () => {
  it('draws only Contact properties, name first and fixed', () => {
    expect(COLUMNS[0]).toMatchObject({ key: 'displayName', fixed: true });
    expect(COLUMNS.map((column) => column.key)).not.toContain('lastActivity');
  });

  it('never hides the name, and hides then restores anything else', () => {
    expect(toggleColumn([], 'displayName')).toEqual([]);
    const hidden = toggleColumn(defaultHiddenColumns(), 'tags');
    expect(hidden).toContain('tags');
    expect(toggleColumn(hidden, 'tags')).not.toContain('tags');
  });

  it('locks a column when ANY loaded row withholds it, and reads locks per row', () => {
    const withheld = contact({ id: 'a', withheldFields: ['emails'] });
    const open = contact({ id: 'b', emails: ['x@example.com'] });
    expect(lockedColumns([withheld, open])).toEqual(['emails']);
    expect(isWithheld(withheld, 'emails')).toBe(true);
    expect(isWithheld(open, 'emails')).toBe(false);
    expect(lockedColumns([open])).toEqual([]);
  });
});

describe('P04/02 filters and the query', () => {
  it('offers only listContacts parameters', () => {
    expect(FILTERS.map((filter) => filter.key)).toEqual(['status', 'source', 'owner', 'dnd', 'whatsappOptIn']);
  });

  it('toggles array filters additively and boolean filters exclusively', () => {
    let state = toggleFilter(NO_FILTERS, 'status', 'new');
    state = toggleFilter(state, 'status', 'qualified');
    expect(state.status).toEqual(['new', 'qualified']);
    state = toggleFilter(state, 'dnd', 'true');
    state = toggleFilter(state, 'dnd', 'false');
    expect(state.dnd).toEqual(['false']);
    expect(toggleFilter(state, 'dnd', 'false').dnd).toEqual([]);
  });

  it('builds a query with no scope, no total and no empty q', () => {
    const filters = toggleFilter(toggleFilter(NO_FILTERS, 'status', 'qualified'), 'dnd', 'true');
    const search = contactListSearch(toListQuery('  Sample Fixture ', filters));
    const params = new URLSearchParams(search);
    expect(params.get('q')).toBe('Sample Fixture');
    expect(params.getAll('status')).toEqual(['qualified']);
    expect(params.get('dnd')).toBe('true');
    expect(params.get('limit')).toBe('25');
    expect([...params.keys()].filter((key) => /programme|total|page|offset/i.test(key))).toEqual([]);
    expect(new URLSearchParams(contactListSearch(toListQuery('   ', NO_FILTERS))).has('q')).toBe(false);
  });

  it('never sends a number or an address as q (identifier_in_url, R21)', () => {
    expect(new URLSearchParams(contactListSearch(toListQuery('0803 000 000', NO_FILTERS))).has('q')).toBe(false);
    expect(new URLSearchParams(contactListSearch(toListQuery('sample@example.test', NO_FILTERS))).has('q')).toBe(false);
  });

  it('echoes a cursor verbatim', () => {
    const params = new URLSearchParams(contactListSearch(toListQuery('', NO_FILTERS, 'eyJjIjoi+/=')));
    expect(params.get('cursor')).toBe('eyJjIjoi+/=');
  });

  it('sends importId only when the list is one import’s contacts (T-0096, I9)', () => {
    const id = '5e1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6a01';
    expect(new URLSearchParams(contactListSearch(toListQuery('', NO_FILTERS, undefined, undefined, id))).get('importId')).toBe(id);
    expect(new URLSearchParams(contactListSearch(toListQuery('', NO_FILTERS))).has('importId')).toBe(false);
  });
});

describe('P04/05 and P04/06 states', () => {
  it('never reports "empty" while loading or after a failure', () => {
    expect(listState({ phase: 'loading', rowCount: 0, searching: false })).toBe('loading');
    expect(listState({ phase: 'error', rowCount: 0, searching: false })).toBe('error');
  });

  it('tells "no contacts yet" from "nothing matches"', () => {
    expect(listState({ phase: 'loaded', rowCount: 0, searching: false })).toBe('empty');
    expect(listState({ phase: 'loaded', rowCount: 0, searching: true })).toBe('no-results');
    expect(listState({ phase: 'loaded', rowCount: 2, searching: true })).toBe('ready');
  });
});

describe('display', () => {
  it('groups Nigerian E.164 numbers and leaves others as stored', () => {
    expect(formatPhone('+2348030000001')).toBe('+234 803 000 0001');
    expect(formatPhone('+254712345678')).toBe('+254712345678');
  });

  it('takes up to two initials', () => {
    expect(initials('Adaeze Okonkwo')).toBe('AO');
    expect(initials('Tèmítọ́pẹ́')).toBe('T');
  });

  it('names the time zone in "last synced"', () => {
    const text = formatSyncedAt('en', new Date('2026-10-04T09:42:00Z'));
    expect(text).toMatch(/\d{1,2}[:.]\d{2}/);
    expect(text).toMatch(/[A-Z]{2,}|GMT|UTC/);
  });
});
