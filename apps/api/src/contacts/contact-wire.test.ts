import { resolveContactFieldAccess, type Contact } from '@kasuwa/domain-core';
import { describe, expect, it } from 'vitest';
import { toContactWire } from './contact-wire';

const A1 = '11111111-0000-4000-8000-0000000c0001';
const EMAIL = 'probe.wire-t0041@example.test';

const contact: Contact = {
  id: '11111111-0000-4000-8000-0000000e0001',
  programmeId: A1,
  version: 2,
  displayName: 'Probe Person',
  givenNames: 'Probe',
  familyName: null,
  phones: [],
  emails: [EMAIL],
  accountId: null,
  ownerUserId: null,
  status: null,
  source: null,
  tags: [],
  preferredLanguage: null,
  preferredChannel: null,
  state: null,
  lga: null,
  dnd: false,
  whatsappOptIn: false,
  consentState: 'unknown',
  phoneNetwork: null,
  createdAt: new Date('2026-01-01T00:00:00.123Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
};

const accessWith = (level: 'none' | 'read' | 'edit') =>
  resolveContactFieldAccess({
    programmeSets: new Map([[A1, 'agent']]),
    reachableProgrammeIds: [A1],
    matrix: [
      { fieldApiName: 'emails', cells: [{ permissionSetId: 'agent', level, locked: false }] },
    ],
  });

describe('toContactWire', () => {
  it('omits a withheld field, never nulls it, and names it in withheldFields', () => {
    const wire = toContactWire(contact, accessWith('none'));
    expect('emails' in wire).toBe(false);
    expect(wire.withheldFields).toEqual(['emails']);
    expect(JSON.stringify(wire)).not.toContain(EMAIL);
    // A real null is still sent: null means "no value", never "hidden".
    expect(wire.familyName).toBeNull();
  });

  it('sends a readable field and an always-present empty withheldFields', () => {
    const wire = toContactWire(contact, accessWith('read'));
    expect(wire.emails).toEqual([EMAIL]);
    expect(wire.withheldFields).toEqual([]);
  });

  it('carries version, UTC timestamps, and nothing the contract does not name', () => {
    const wire = toContactWire(contact, accessWith('edit'));
    expect(wire.version).toBe(2);
    expect(wire.createdAt).toBe('2026-01-01T00:00:00.123Z');
    expect(Object.keys(wire)).not.toContain('tenantId');
    expect(Object.keys(wire)).toHaveLength(24);
  });
});
