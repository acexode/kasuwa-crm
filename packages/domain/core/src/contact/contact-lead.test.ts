import { describe, expect, it } from 'vitest';
import { LEAD_STATUSES, planConvert, type ConvertState } from './contact-lead';

// Invented ids (CLAUDE.md 6.1).
const ACCOUNT = '11111111-0000-4000-8000-00007600aa01';
const OTHER = '11111111-0000-4000-8000-00007600aa02';

const unlinked = (status: string | null, version = 3): ConvertState => ({
  status,
  version,
  accountId: null,
  linkedAccountName: null,
});

const linked = (status: string | null, version = 3): ConvertState => ({
  status,
  version,
  accountId: ACCOUNT,
  linkedAccountName: 'Probe Grains Co.',
});

describe('LEAD_STATUSES', () => {
  it('is the contract’s four lead statuses: never customer, never null', () => {
    expect([...LEAD_STATUSES]).toEqual(['new', 'contacted', 'qualified', 'unqualified']);
  });
});

describe('planConvert', () => {
  it.each(['new', 'contacted', 'unqualified', null])(
    'qualifies a %s contact and links the requested account',
    (status) => {
      expect(planConvert(unlinked(status), { kind: 'existing', accountId: ACCOUNT }, 3)).toEqual({
        outcome: 'write',
        status: 'qualified',
        link: 'existing',
      });
      expect(planConvert(unlinked(status), { kind: 'new', name: 'Probe Co' }, 3)).toEqual({
        outcome: 'write',
        status: 'qualified',
        link: 'create',
      });
    },
  );

  it.each(['qualified', 'customer'])('leaves a %s status alone and only links', (status) => {
    expect(planConvert(unlinked(status), { kind: 'existing', accountId: ACCOUNT }, 3)).toEqual({
      outcome: 'write',
      status: undefined,
      link: 'existing',
    });
  });

  it.each(['qualified', 'customer'])(
    'a %s contact already linked to the target is in place, whatever version is sent',
    (status) => {
      for (const version of [1, 3, 99]) {
        expect(
          planConvert(linked(status), { kind: 'existing', accountId: ACCOUNT }, version),
        ).toEqual({ outcome: 'in_place' });
        expect(
          planConvert(linked(status), { kind: 'new', name: 'Probe Grains Co.' }, version),
        ).toEqual({ outcome: 'in_place' });
      }
    },
  );

  it('compares the account id case-insensitively', () => {
    expect(
      planConvert(linked('qualified'), { kind: 'existing', accountId: ACCOUNT.toUpperCase() }, 1),
    ).toEqual({ outcome: 'in_place' });
  });

  it('a new account name differing only in case is another account', () => {
    expect(planConvert(linked('qualified'), { kind: 'new', name: 'PROBE GRAINS CO.' }, 3)).toEqual(
      { outcome: 'already_linked', path: 'newAccount' },
    );
  });

  it('anything not in place on a stale version is stale, before already_linked', () => {
    expect(planConvert(unlinked('new'), { kind: 'existing', accountId: ACCOUNT }, 2)).toEqual({
      outcome: 'stale',
    });
    expect(planConvert(linked('new'), { kind: 'existing', accountId: OTHER }, 2)).toEqual({
      outcome: 'stale',
    });
    expect(planConvert(linked('new'), { kind: 'existing', accountId: ACCOUNT }, 2)).toEqual({
      outcome: 'stale',
    });
  });

  it('linked to another account is already_linked at the target’s path', () => {
    expect(planConvert(linked('new'), { kind: 'existing', accountId: OTHER }, 3)).toEqual({
      outcome: 'already_linked',
      path: 'accountId',
    });
    expect(planConvert(linked('customer'), { kind: 'new', name: 'Second Co' }, 3)).toEqual({
      outcome: 'already_linked',
      path: 'newAccount',
    });
  });

  it('linked to the target but not yet qualified: qualifies and keeps the link', () => {
    expect(planConvert(linked('new'), { kind: 'existing', accountId: ACCOUNT }, 3)).toEqual({
      outcome: 'write',
      status: 'qualified',
      link: 'keep',
    });
    expect(planConvert(linked(null), { kind: 'new', name: 'Probe Grains Co.' }, 3)).toEqual({
      outcome: 'write',
      status: 'qualified',
      link: 'keep',
    });
  });
});
