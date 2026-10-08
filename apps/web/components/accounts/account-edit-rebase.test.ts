import { describe, expect, it } from 'vitest';
import type { Account } from '../../lib/accounts-api';
import { accountToForm, editBody, lockedFormFields, rebaseAccountForm, validateAccountForm, type AccountForm } from './accounts-model';

/**
 * The T-0063 security review's lost update (scratchpad/review-t0063/lost-update.ts):
 * the sheet opened on v1 (two phones); somebody else saved v2 first (the second
 * phone removed, an erasure request, and the industry changed); the person
 * typed only a new name. The first save is a 409 and the account is re-read.
 * The second save must send the new name and NOTHING else — sending the form
 * seeded from v1 would put the erased phone back.
 */

const v1: Account = {
  id: '11111111-1111-4111-8111-111111111111',
  programmeId: '22222222-2222-4222-8222-222222222222',
  name: 'Acme',
  version: 1,
  ownerUserId: null,
  owner: null,
  industry: 'Banking',
  tier: null,
  tags: [],
  phones: [
    { type: 'work', e164: '+2348010000001' },
    { type: 'work', e164: '+2348010000002' },
  ],
  state: null,
  lga: null,
  parentAccountId: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  withheldFields: [],
};

const v2: Account = { ...v1, version: 2, industry: 'Fintech', phones: [{ type: 'work', e164: '+2348010000001' }] };

function save(base: Account, form: AccountForm) {
  const checked = validateAccountForm(form, { needProgramme: false, locked: lockedFormFields(base) });
  if (!checked.ok) throw new Error(`invalid form: ${JSON.stringify(checked.errors)}`);
  return editBody(base, form, checked.values);
}

describe('an edit after a 409 sends only what the person changed, against the fresh version', () => {
  const typed: AccountForm = { ...accountToForm(v1), name: 'Acme Holdings' };

  it('the first save, against v1, sends the name alone', () => {
    expect(save(v1, typed)).toEqual({ version: 1, name: 'Acme Holdings' });
  });

  it('the reviewer’s scenario: after the re-read the erased phone and the old industry are NOT sent', () => {
    const rebased = rebaseAccountForm(v1, v2, typed);
    expect(rebased.edited).toEqual(['name']);
    expect(rebased.conflicts).toEqual([]);
    // The form now shows what somebody else saved, with the person's edit on top.
    expect(rebased.form).toEqual({ ...accountToForm(v2), name: 'Acme Holdings' });
    expect(save(v2, rebased.form)).toEqual({ version: 2, name: 'Acme Holdings' });
  });

  it('the bug, kept as a guard: the v1 form diffed against v2 resends the erased phone', () => {
    // This is why the sheet never pairs a fresh row with an un-rebased form:
    // against v2, every field the person did not touch looks changed.
    const stale = save(v2, typed);
    expect(stale?.phones).toEqual(v1.phones);
    expect(stale?.industry).toBe('Banking');
  });

  it('a field both people changed keeps the typed value, is flagged, and is the only other field sent', () => {
    const both: AccountForm = { ...typed, industry: 'Insurance' };
    const rebased = rebaseAccountForm(v1, v2, both);
    expect(rebased.conflicts).toEqual(['industry']);
    expect(rebased.form.industry).toBe('Insurance');
    expect(rebased.form.phones).toBe(accountToForm(v2).phones);
    expect(save(v2, rebased.form)).toEqual({ version: 2, name: 'Acme Holdings', industry: 'Insurance' });
  });

  it('an edit to a field withheld on the fresh row is dropped, never sent', () => {
    const v3: Account = { ...v2, version: 3, withheldFields: ['phones'] };
    delete (v3 as { phones?: unknown }).phones;
    const rebased = rebaseAccountForm(v1, v3, { ...typed, phones: '+2348010000009' });
    expect(rebased.edited).toEqual(['name']);
    const body = save(v3, rebased.form);
    expect(body).toEqual({ version: 3, name: 'Acme Holdings' });
  });

  it('nothing edited is nothing sent', () => {
    const rebased = rebaseAccountForm(v1, v2, accountToForm(v1));
    expect(rebased.edited).toEqual([]);
    expect(save(v2, rebased.form)).toBeNull();
  });
});
