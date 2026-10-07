import type { Contact } from '@kasuwa/domain-core';
import { describe, expect, it } from 'vitest';
import { contactAuditEvent, contactChanges, encodeContactAuditValue } from './contact-audit';

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
  companyName: 'Probe Person Trading',
  phones: [{ type: 'mobile', e164: PHONE }],
  emails: [EMAIL],
  accountId: null,
  account: null,
  ownerUserId: null,
  owner: null,
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

  it('records a value field only when it moved, with its before and after (D-L72)', () => {
    const changes = contactChanges({ status: 'qualified', consentState: 'unknown' }, before);
    expect(changes).toEqual([
      { field: 'status', before: 'new', after: 'qualified', redacted: false },
    ]);
  });

  it('encodes booleans and tag lists in the string type, and null as had-none (D-L81)', () => {
    const changes = contactChanges(
      { whatsappOptIn: true, tags: ['Late payer', 'VIP'], state: 'Lagos', lga: null },
      { ...before, tags: ['Late payer'], lga: 'Ikeja' },
    );
    expect(changes).toEqual([
      { field: 'whatsappOptIn', before: 'false', after: 'true', redacted: false },
      { field: 'state', before: null, after: 'Lagos', redacted: false },
      { field: 'lga', before: 'Ikeja', after: null, redacted: false },
      { field: 'tags', before: '["Late payer"]', after: '["Late payer","VIP"]', redacted: false },
    ]);
  });

  it('records nothing for a value field sent unchanged, tags and State included', () => {
    const same = { ...before, tags: ['VIP'], state: 'Lagos' };
    expect(contactChanges({ tags: ['VIP'], state: 'Lagos', status: 'new' }, same)).toEqual([]);
  });

  it('records the owner and the account by name only, never their ids', () => {
    const OWNER = '11111111-0000-4000-8000-0000000d0001';
    const ACCOUNT = '11111111-0000-4000-8000-000000130001';
    const changes = contactChanges({ ownerUserId: OWNER, accountId: ACCOUNT }, before);
    expect(changes).toEqual([
      { field: 'ownerUserId', before: null, after: null, redacted: true },
      { field: 'accountId', before: null, after: null, redacted: true },
    ]);
  });

  it('records a value too long for the writer by name only, rather than refusing the write', () => {
    const tags = Array.from({ length: 50 }, (_, index) => `tag-${index}-`.padEnd(64, 'x'));
    expect(contactChanges({ tags }, before)).toEqual([
      { field: 'tags', before: null, after: null, redacted: true },
    ]);
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

  it('on create, records every field that was set: values from null, consent from unknown (D-L81)', () => {
    const changes = contactChanges(
      {
        displayName: 'X',
        status: 'new',
        ownerUserId: null,
        whatsappOptIn: false,
        consentState: 'opted_in',
        lga: null,
      },
      null,
    );
    expect(changes).toEqual([
      { field: 'displayName', before: null, after: null, redacted: true },
      { field: 'status', before: null, after: 'new', redacted: false },
      { field: 'consentState', before: 'unknown', after: 'opted_in', redacted: false },
      { field: 'whatsappOptIn', before: null, after: 'false', redacted: false },
    ]);
  });

  it('records companyName whenever sent, by name only, and never its value (T-0076, D-L82)', () => {
    for (const companyName of ['Probe Person Trading', 'Another Probe Co', null]) {
      const changes = contactChanges({ companyName }, before);
      expect(changes).toEqual([
        { field: 'companyName', before: null, after: null, redacted: true },
      ]);
      expect(JSON.stringify(changes)).not.toContain('Probe');
    }
    expect(
      contactChanges({ companyName: 'Probe Co' }, null).map((entry) => entry.field),
    ).toEqual(['companyName']);
  });

  it('a convert names exactly the fields that moved: status and accountId, redacted', () => {
    const ACCOUNT = '11111111-0000-4000-8000-00007600aa01';
    expect(contactChanges({ status: 'qualified', accountId: ACCOUNT }, before)).toEqual([
      { field: 'status', before: null, after: null, redacted: true },
      { field: 'accountId', before: null, after: null, redacted: true },
    ]);
    // A customer keeps its status: only the link moved.
    const customer: Contact = { ...before, status: 'customer' };
    expect(
      contactChanges({ accountId: ACCOUNT }, customer).map((entry) => entry.field),
    ).toEqual(['accountId']);
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

describe('encodeContactAuditValue', () => {
  it('keeps strings, spells booleans, writes arrays as JSON and absence as null', () => {
    expect(encodeContactAuditValue('contacted')).toBe('contacted');
    expect(encodeContactAuditValue(false)).toBe('false');
    expect(encodeContactAuditValue(['a', 'b'])).toBe('["a","b"]');
    expect(encodeContactAuditValue(null)).toBeNull();
    expect(encodeContactAuditValue(undefined)).toBeNull();
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
