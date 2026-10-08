import { describe, expect, it } from 'vitest';
import type { Account } from '../../lib/accounts-api';
import { AccountTimelineField } from '../../lib/account-record-api';
import type { RecordsResult } from '../../lib/records-api';
import {
  MAX_ANCESTORS,
  accountFieldLabel,
  contactsOutcome,
  describeAccountValue,
  isLocked,
  walkAncestors,
} from './account-record-model';

const id = (n: number): string => `5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c${String(n).padStart(2, '0')}`;

function account(n: number, parent: number | null, overrides: Partial<Account> = {}): Account {
  return {
    id: id(n),
    programmeId: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a01',
    name: `Account ${n}`,
    version: 1,
    ownerUserId: null,
    owner: null,
    industry: null,
    tier: null,
    tags: [],
    phones: [],
    state: null,
    lga: null,
    parentAccountId: parent === null ? null : id(parent),
    createdAt: '2026-09-01T07:00:00.000Z',
    updatedAt: '2026-09-01T07:00:00.000Z',
    withheldFields: [],
    ...overrides,
  };
}

function withheld(row: Account, fields: string[]): Account {
  const copy: Record<string, unknown> = { ...row, withheldFields: fields };
  for (const field of fields) delete copy[field];
  return copy as Account;
}

/** A getAccount over `rows` that records every id it was asked for. */
function reader(rows: readonly Account[], failing: ReadonlySet<string> = new Set()) {
  const reads: string[] = [];
  const read = async (target: string): Promise<RecordsResult<Account>> => {
    reads.push(target);
    const row = rows.find((candidate) => candidate.id === target);
    if (failing.has(target)) return { ok: false, error: { code: 'network' } };
    return row === undefined ? { ok: false, error: { code: 'not_found' } } : { ok: true, value: row };
  };
  return { reads, read };
}

describe('the details panel', () => {
  it('locks the owner and its id together, whichever name the server withheld', () => {
    const row = withheld(account(1, null), ['ownerUserId']);
    expect(isLocked(row, 'owner')).toBe(true);
    expect(isLocked(row, 'ownerUserId')).toBe(true);
    expect(isLocked(row, 'tier')).toBe(false);
  });

  it('draws a tier by its label, free text as text, and nothing set as nothing set', () => {
    expect(describeAccountValue('tier', account(1, null, { tier: 'mid_market' }))).toEqual({ kind: 'label', id: 'accounts.tier.mid_market' });
    expect(describeAccountValue('industry', account(1, null, { industry: 'Retail' }))).toEqual({ kind: 'text', text: 'Retail' });
    expect(describeAccountValue('state', account(1, null))).toEqual({ kind: 'empty' });
    expect(describeAccountValue('lga', account(1, null, { lga: '' }))).toEqual({ kind: 'empty' });
  });

  it('names every field the account timeline can name, the parent link included', () => {
    for (const field of AccountTimelineField.options) {
      const label = accountFieldLabel(field);
      expect(label, field).not.toBeNull();
      expect(label?.endsWith(`.field.${field}`) || label?.endsWith(`.col.${field}`) || field === 'name', field).toBe(true);
    }
    expect(accountFieldLabel('parentAccountId')).toBe('account.field.parentAccountId');
    expect(accountFieldLabel('displayName')).toBeNull();
  });
});

describe('the hierarchy walk (D-L74, D-L98)', () => {
  it('reads each ancestor once and returns them root first', async () => {
    const rows = [account(1, null), account(2, 1), account(3, 2), account(4, 3), account(5, 4)];
    const { reads, read } = reader(rows);
    const walked = await walkAncestors(rows[4] as Account, read);
    expect(walked.end).toBe('root');
    expect(walked.ancestors.map((row) => row.id)).toEqual([id(1), id(2), id(3), id(4)]);
    expect(reads).toEqual([id(4), id(3), id(2), id(1)]);
  });

  it('reads nothing for a top-level account', async () => {
    const { reads, read } = reader([]);
    expect(await walkAncestors(account(1, null), read)).toEqual({ ancestors: [], end: 'root' });
    expect(reads).toEqual([]);
  });

  it('reads nothing above a withheld parent link, and says it is locked', async () => {
    const { reads, read } = reader([account(1, null)]);
    const walked = await walkAncestors(withheld(account(2, 1), ['parentAccountId']), read);
    expect(walked).toEqual({ ancestors: [], end: 'locked' });
    expect(reads).toEqual([]);
  });

  it('stops at four ancestors however long the served chain claims to be', async () => {
    const rows = [account(1, 9), account(2, 1), account(3, 2), account(4, 3), account(5, 4), account(9, 8), account(8, null)];
    const { reads, read } = reader(rows);
    const walked = await walkAncestors(rows[4] as Account, read);
    expect(reads).toHaveLength(MAX_ANCESTORS);
    expect(walked.end).toBe('limit');
    expect(walked.ancestors).toHaveLength(MAX_ANCESTORS);
  });

  it('stops at a served cycle without reading anything twice', async () => {
    // 1 -> 3 -> 2 -> 1: the database forbids it; the walk must not loop on the day it is wrong.
    const rows = [account(1, 3), account(2, 1), account(3, 2)];
    const { reads, read } = reader(rows);
    const walked = await walkAncestors(rows[0] as Account, read);
    expect(walked.end).toBe('cycle');
    expect(new Set(reads).size).toBe(reads.length);
    expect(reads).not.toContain(id(1));
  });

  it('keeps what it read when a read fails, and stops', async () => {
    const rows = [account(1, null), account(2, 1), account(3, 2)];
    const { reads, read } = reader(rows, new Set([id(1)]));
    const walked = await walkAncestors(rows[2] as Account, read);
    expect(walked).toEqual({ ancestors: [rows[1]], end: 'failed' });
    expect(reads).toEqual([id(2), id(1)]);
  });
});

describe('the contacts grid: withheld, empty and failed never look alike', () => {
  it('a page is ready, its cursor kept for "more"', () => {
    expect(contactsOutcome({ ok: true, value: { data: [], nextCursor: 'acc_1' } })).toMatchObject({ phase: 'ready', rows: [], cursor: 'acc_1' });
  });

  it('a field_withheld refusal is its own state, never "no contacts"', () => {
    const refused = contactsOutcome({
      ok: false,
      error: { code: 'validation_failed', details: [{ path: 'accountId', code: 'field_withheld' }] },
    });
    expect(refused.phase).toBe('withheld');
  });

  it('any other failure is an error, a plain 400 included', () => {
    expect(contactsOutcome({ ok: false, error: { code: 'network' } }).phase).toBe('error');
    expect(contactsOutcome({ ok: false, error: { code: 'validation_failed' } }).phase).toBe('error');
  });
});
