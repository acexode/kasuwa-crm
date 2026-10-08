import { describe, expect, it } from 'vitest';
import type { ContactRecord } from '../../lib/contact-record-api';
import { changedFields, draftOf, rebaseDraft, saveBody, type Draft } from './record-model';

/**
 * The T-0063 security review's lost update on the contact record
 * (scratchpad/review-t0063/contact-lost-update.ts): the sheet opened on v1
 * (two phones); somebody else saved v2 first, removing the second phone; the
 * person typed only a new family name. After the 409 and the re-read, the
 * save must send the family name and v2's version, and never the phones.
 */

const v1: ContactRecord = {
  id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e01',
  programmeId: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a01',
  version: 1,
  displayName: 'Ada Obi',
  givenNames: 'Ada',
  familyName: 'Obi',
  phones: [
    { type: 'mobile', e164: '+2348010000001' },
    { type: 'mobile', e164: '+2348010000002' },
  ],
  emails: ['ada@example.test'],
  tags: [],
  status: 'contacted',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  withheldFields: [],
};

const v2: ContactRecord = { ...v1, version: 2, phones: [{ type: 'mobile', e164: '+2348010000001' }] };

describe('the contact edit after a 409 sends only what the person changed, against the fresh version', () => {
  const typed: Draft = { ...draftOf(v1), familyName: 'Obi-Eze' };

  it('the bug, kept as a guard: the v1 draft diffed against v2 resends the erased phone', () => {
    expect(changedFields(v2, typed).body.phones).toEqual(v1.phones);
  });

  it('the reviewer’s scenario: after the re-read only the family name goes, with v2’s version', () => {
    expect(saveBody(v1, typed).body).toEqual({ version: 1, familyName: 'Obi-Eze' });
    const rebased = rebaseDraft(v1, v2, typed);
    expect(rebased.edited).toEqual(['familyName']);
    expect(rebased.conflicts).toEqual([]);
    expect(rebased.form).toEqual({ ...draftOf(v2), familyName: 'Obi-Eze' });
    expect(saveBody(v2, rebased.form).body).toEqual({ version: 2, familyName: 'Obi-Eze' });
  });

  it('a field both changed keeps the typed value and is flagged', () => {
    const v3: ContactRecord = { ...v2, version: 3, familyName: 'Obi-Okafor' };
    const rebased = rebaseDraft(v1, v3, typed);
    expect(rebased.conflicts).toEqual(['familyName']);
    expect(saveBody(v3, rebased.form).body).toEqual({ version: 3, familyName: 'Obi-Eze' });
  });

  it('nothing edited is nothing sent', () => {
    expect(saveBody(v2, rebaseDraft(v1, v2, draftOf(v1)).form).body).toBeNull();
  });
});
