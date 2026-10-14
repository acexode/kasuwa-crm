import type { ContactFieldAccess, ContactFieldLevel } from '@kasuwa/domain-core';
import { WITHHOLDABLE_CONTACT_FIELDS } from '@kasuwa/domain-core';
import { describe, expect, it } from 'vitest';
import { contactBranches, nameAccess, toContactHit } from './search.service';

// Synthetic ids and names.
const A1 = 'a1';
const A2 = 'a2';

function access(
  overrides: Record<string, Partial<Record<string, ContactFieldLevel>>>,
): ContactFieldAccess {
  return new Map(
    Object.entries(overrides).map(([programmeId, fields]) => [
      programmeId,
      new Map(WITHHOLDABLE_CONTACT_FIELDS.map((field) => [field, fields[field] ?? 'edit'])),
    ]),
  );
}

const row = {
  id: 'c1',
  programmeId: A1,
  displayName: 'Zqwith Sample',
  givenNames: 'Zqwith',
  familyName: null,
  companyName: 'Zqwith Ltd',
  status: 'new',
};

describe('nameAccess: displayName follows its name parts (D-L68, CR8)', () => {
  it('reads displayName only when both parts are readable', () => {
    expect(nameAccess(access({ [A1]: {} }), A1).displayName).toBe(true);
    expect(nameAccess(access({ [A1]: { familyName: 'none' } }), A1).displayName).toBe(false);
    expect(nameAccess(access({ [A1]: { givenNames: 'none' } }), A1).displayName).toBe(false);
  });

  it('fails closed for a programme the access map does not know', () => {
    expect(nameAccess(access({}), A1)).toEqual({
      displayName: false,
      givenNames: false,
      familyName: false,
      companyName: false,
    });
  });
});

describe('contactBranches: a withheld field is never compared (CR7)', () => {
  it('one branch per readable field per programme, judged per programme', () => {
    const branches = contactBranches(
      access({ [A1]: { familyName: 'none' }, [A2]: { companyName: 'none' } }),
      [A1, A2],
    );
    expect(branches).toEqual([
      { programmeId: A1, column: 'given_names_search' },
      { programmeId: A1, column: 'company_name_search' },
      { programmeId: A2, column: 'display_name_search' },
      { programmeId: A2, column: 'given_names_search' },
      { programmeId: A2, column: 'family_name_search' },
    ]);
  });

  it('no readable field, no branch', () => {
    expect(contactBranches(access({}), [A1])).toEqual([]);
  });
});

describe('toContactHit: omitted and listed, never nulled', () => {
  it('omits a withheld part and displayName with it, even when the part is null', () => {
    const hit = toContactHit('contact', row, access({ [A1]: { familyName: 'none' } }));
    expect(hit).toEqual({
      type: 'contact',
      id: 'c1',
      programmeId: A1,
      givenNames: 'Zqwith',
      companyName: 'Zqwith Ltd',
      withheldFields: ['displayName', 'familyName'],
    });
  });

  it('a lead hit carries its status; a contact hit never does', () => {
    expect(toContactHit('lead', row, access({ [A1]: {} })).status).toBe('new');
    expect('status' in toContactHit('contact', row, access({ [A1]: {} }))).toBe(false);
  });
});
