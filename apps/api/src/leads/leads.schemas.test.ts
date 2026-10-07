import { describe, expect, it } from 'vitest';
import { ListLeadsQuery } from './leads.schemas';

describe('ListLeadsQuery (T-0076)', () => {
  it('defaults as listContacts: -createdAt, 25 rows', () => {
    expect(ListLeadsQuery.parse({})).toMatchObject({ sort: '-createdAt', limit: 25 });
  });

  it('narrows status to lead statuses only, one or several', () => {
    expect(ListLeadsQuery.parse({ status: 'new' }).status).toEqual(['new']);
    expect(ListLeadsQuery.parse({ status: ['qualified', 'unqualified'] }).status).toEqual([
      'qualified',
      'unqualified',
    ]);
    for (const status of ['customer', 'Qualified', 'lead', ['new', 'customer']]) {
      expect(ListLeadsQuery.safeParse({ status }).success, JSON.stringify(status)).toBe(false);
    }
    expect(
      ListLeadsQuery.safeParse({ status: ['new', 'contacted', 'qualified', 'unqualified', 'new'] })
        .success,
      'more than the four lead statuses',
    ).toBe(false);
  });

  it('ignores unknown parameters: nothing names a programme, a lifecycle or an account', () => {
    const parsed = ListLeadsQuery.parse({
      programmeId: 'x',
      lifecycle: 'all',
      includeCustomers: 'true',
      account: 'y',
      accountId: 'z',
    });
    expect(Object.keys(parsed).sort()).toEqual(['limit', 'sort']);
  });

  it('refuses a sort on companyName or status, an empty, 101-character or NUL q, and limits outside 1..100', () => {
    for (const query of [
      { sort: 'companyName' },
      { sort: '-status' },
      { q: '' },
      { q: 'a'.repeat(101) },
      { q: 'Probe\u0000' },
      { limit: '0' },
      { limit: '101' },
    ]) {
      expect(ListLeadsQuery.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
    expect(ListLeadsQuery.safeParse({ q: 'a'.repeat(100) }).success).toBe(true);
  });
});
