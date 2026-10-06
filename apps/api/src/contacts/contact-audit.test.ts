import type { Contact } from '@kasuwa/domain-core';
import { describe, expect, it } from 'vitest';
import { contactAuditEvent, contactChanges } from './contact-audit';

// Invented values only (CLAUDE.md 6.1).
const PHONE = '+2348069990041';
const EMAIL = 'probe.t0041-unit@example.test';

const before: Contact = {
  id: '11111111-0000-4000-8000-0000000e0001',
  programmeId: '11111111-0000-4000-8000-0000000c0001',
  version: 3,
  displayName: 'Probe Person',
  givenNames: 'Probe',
  familyName: 'Person',
  phones: [{ type: 'mobile', e164: PHONE }],
  emails: [EMAIL],
  accountId: null,
  ownerUserId: null,
  status: 'new',
  source: 'manual',
  tags: [],
  preferredLanguage: null,
  preferredChannel: null,
  state: null,
  lga: null,
  dnd: false,
  whatsappOptIn: false,
  consentState: 'unknown',
  phoneNetwork: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('contactChanges', () => {
  it('records personal fields whenever sent, redacted, even when unchanged', () => {
    const changes = contactChanges(
      { phones: before.phones, emails: [EMAIL], displayName: 'Probe Person' },
      before,
    );
    expect(changes.map((entry) => entry.field)).toEqual(['displayName', 'phones', 'emails']);
    for (const entry of changes) {
      expect(entry).toEqual({ field: entry.field, before: null, after: null, redacted: true });
    }
  });

  it('records a closed-set field only when it moved, and never its value', () => {
    const changes = contactChanges({ status: 'qualified', consentState: 'unknown' }, before);
    expect(changes).toEqual([{ field: 'status', before: null, after: null, redacted: true }]);
  });

  it('compares ids case-insensitively: an upper-case owner or account that is already set is no change', () => {
    // A uuid is the same value in either case; Postgres stores it lower case.
    // An `!==` on the raw strings would record a false "owner changed" event.
    const OWNER = '11111111-0000-4000-8000-0000000d0001';
    const ACCOUNT = '11111111-0000-4000-8000-000000130001';
    const owned: Contact = { ...before, ownerUserId: OWNER, accountId: ACCOUNT };
    expect(
      contactChanges({ ownerUserId: OWNER.toUpperCase(), accountId: ACCOUNT.toUpperCase() }, owned),
    ).toEqual([]);
    // A different id still moves, whatever its case.
    const OTHER = '11111111-0000-4000-8000-0000000d0003';
    expect(
      contactChanges({ ownerUserId: OTHER.toUpperCase() }, owned).map((entry) => entry.field),
    ).toEqual(['ownerUserId']);
    // Clearing a set id still moves.
    expect(contactChanges({ accountId: null }, owned).map((entry) => entry.field)).toEqual([
      'accountId',
    ]);
  });

  it('on create, records every field that was set', () => {
    const changes = contactChanges(
      { displayName: 'X', status: 'new', ownerUserId: null, whatsappOptIn: false },
      null,
    );
    expect(changes.map((entry) => entry.field)).toEqual(['displayName', 'status', 'whatsappOptIn']);
  });

  it('never carries a phone or an address', () => {
    const changes = contactChanges(
      { phones: [{ type: 'mobile', e164: PHONE }], emails: [EMAIL], status: 'customer' },
      before,
    );
    const text = JSON.stringify(changes);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain(PHONE.slice(1));
    expect(text).not.toContain(EMAIL);
  });
});

describe('contactAuditEvent', () => {
  it('labels the event with the record id, never the name, in the record programme', () => {
    const event = contactAuditEvent('updated', before, []);
    expect(event).toEqual({
      action: 'updated',
      objectType: 'contact',
      objectId: before.id,
      objectLabel: before.id,
      programmeId: before.programmeId,
      changes: [],
    });
    expect(JSON.stringify(event)).not.toContain('Probe');
  });
});
