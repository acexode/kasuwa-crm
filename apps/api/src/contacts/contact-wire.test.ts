import {
  WITHHOLDABLE_CONTACT_FIELDS,
  type Contact,
  type ContactFieldAccess,
  type ContactFieldLevel,
} from '@kasuwa/domain-core';
import { describe, expect, it } from 'vitest';
import { toContactWire, withheldWireFields } from './contact-wire';
import { EMPTY_CUSTOM_WIRE } from '../custom-fields/custom-values';

const A1 = '11111111-0000-4000-8000-0000000c0001';
const EMAIL = 'probe.wire-t0041@example.test';
// Invented (CLAUDE.md 6.1): never a seeded or real person.
const OWNER = { id: '11111111-0000-4000-8000-0000004300a1', displayName: 'Probe Owner Q4' };

const contact: Contact = {
  id: '11111111-0000-4000-8000-0000000e0001',
  programmeId: A1,
  version: 2,
  displayName: 'Probe Person',
  givenNames: 'Probe',
  familyName: null,
  companyName: 'Probe Wire Co',
  phones: [],
  emails: [EMAIL],
  accountId: null,
  account: null,
  ownerUserId: null,
  owner: null,
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

/** Every field edit in A1, except emails at `level`. */
const accessWith = (level: ContactFieldLevel): ContactFieldAccess =>
  new Map([
    [
      A1,
      new Map(
        WITHHOLDABLE_CONTACT_FIELDS.map(
          (field) => [field, field === 'emails' ? level : 'edit'] as const,
        ),
      ),
    ],
  ]);

/** Every field edit in A1, except ownerUserId at `level`. */
const ownerAccess = (level: ContactFieldLevel): ContactFieldAccess =>
  new Map([
    [
      A1,
      new Map(
        WITHHOLDABLE_CONTACT_FIELDS.map(
          (field) => [field, field === 'ownerUserId' ? level : 'edit'] as const,
        ),
      ),
    ],
  ]);

const owned: Contact = { ...contact, ownerUserId: OWNER.id, owner: OWNER };

describe('toContactWire', () => {
  it('omits a withheld field, never nulls it, and names it in withheldFields', () => {
    const wire = toContactWire(contact, accessWith('none'), EMPTY_CUSTOM_WIRE);
    expect('emails' in wire).toBe(false);
    expect(wire.withheldFields).toEqual(['emails']);
    expect(JSON.stringify(wire)).not.toContain(EMAIL);
    // A real null is still sent: null means "no value", never "hidden".
    expect(wire.familyName).toBeNull();
  });

  it('sends a readable field and an always-present empty withheldFields', () => {
    const wire = toContactWire(contact, accessWith('read'), EMPTY_CUSTOM_WIRE);
    expect(wire.emails).toEqual([EMAIL]);
    expect(wire.withheldFields).toEqual([]);
  });

  it('carries version, UTC timestamps, and nothing the contract does not name', () => {
    const wire = toContactWire(contact, accessWith('edit'), EMPTY_CUSTOM_WIRE);
    expect(wire.version).toBe(2);
    expect(wire.createdAt).toBe('2026-01-01T00:00:00.123Z');
    expect(Object.keys(wire)).not.toContain('tenantId');
    // T-0061 added account, T-0076 companyName, T-0089 custom.
    expect(Object.keys(wire)).toHaveLength(28);
    expect(wire.custom).toEqual({});
  });

  it('serves companyName, null when none, and omits and names it when withheld (T-0076)', () => {
    const readable = toContactWire(contact, accessWith('edit'), EMPTY_CUSTOM_WIRE);
    expect(readable.companyName).toBe('Probe Wire Co');
    expect(toContactWire({ ...contact, companyName: null }, accessWith('edit'), EMPTY_CUSTOM_WIRE).companyName).toBeNull();

    const withheld = toContactWire(
      contact,
      new Map([
        [
          A1,
          new Map(
            WITHHOLDABLE_CONTACT_FIELDS.map(
              (field) => [field, field === 'companyName' ? 'none' : 'edit'] as const,
            ),
          ),
        ],
      ]), EMPTY_CUSTOM_WIRE,
    );
    expect('companyName' in withheld).toBe(false);
    expect(withheld.withheldFields).toEqual(['companyName']);
    expect(JSON.stringify(withheld)).not.toContain('Probe Wire Co');
  });
});

describe('toContactWire: the embedded owner (T-0043)', () => {
  it('sends owner beside ownerUserId when the id is readable, and null when unassigned', () => {
    const wire = toContactWire(owned, ownerAccess('read'), EMPTY_CUSTOM_WIRE);
    expect(wire.owner).toEqual(OWNER);
    expect(wire.ownerUserId).toBe(OWNER.id);
    expect(wire.withheldFields).toEqual([]);
    expect(toContactWire(contact, ownerAccess('edit'), EMPTY_CUSTOM_WIRE).owner).toBeNull();
  });

  it('withholds owner WITH ownerUserId: both omitted, both named, the name nowhere', () => {
    const wire = toContactWire(owned, ownerAccess('none'), EMPTY_CUSTOM_WIRE);
    expect('ownerUserId' in wire).toBe(false);
    expect('owner' in wire).toBe(false);
    expect(wire.withheldFields).toEqual(['ownerUserId', 'owner']);
    expect(JSON.stringify(wire)).not.toContain(OWNER.displayName);
    expect(JSON.stringify(wire)).not.toContain(OWNER.id);
  });
});

const ACCOUNT = { id: '11111111-0000-4000-8000-0000006100a1', name: 'Probe Traders Q4' };
const linked: Contact = { ...contact, accountId: ACCOUNT.id, account: ACCOUNT };

/** Every field edit in A1, except accountId at `level`. */
const accountAccess = (level: ContactFieldLevel): ContactFieldAccess =>
  new Map([
    [
      A1,
      new Map(
        WITHHOLDABLE_CONTACT_FIELDS.map(
          (field) => [field, field === 'accountId' ? level : 'edit'] as const,
        ),
      ),
    ],
  ]);

describe('toContactWire: the embedded account (T-0061)', () => {
  it('sends account beside accountId when the id is readable, and null when unlinked', () => {
    const wire = toContactWire(linked, accountAccess('read'), EMPTY_CUSTOM_WIRE);
    expect(wire.account).toEqual(ACCOUNT);
    expect(wire.accountId).toBe(ACCOUNT.id);
    expect(wire.withheldFields).toEqual([]);
    expect(toContactWire(contact, accountAccess('edit'), EMPTY_CUSTOM_WIRE).account).toBeNull();
  });

  it('withholds account WITH accountId: both omitted, both named, the name nowhere', () => {
    const wire = toContactWire(linked, accountAccess('none'), EMPTY_CUSTOM_WIRE);
    expect('accountId' in wire).toBe(false);
    expect('account' in wire).toBe(false);
    expect(wire.withheldFields).toEqual(['accountId', 'account']);
    expect(JSON.stringify(wire)).not.toContain(ACCOUNT.name);
    expect(JSON.stringify(wire)).not.toContain(ACCOUNT.id);
  });
});

describe('withheldWireFields', () => {
  it('follows a withheld ownerUserId with owner, keeping contract order', () => {
    expect(withheldWireFields(['emails', 'ownerUserId', 'status'])).toEqual([
      'emails',
      'ownerUserId',
      'owner',
      'status',
    ]);
  });

  it('follows a withheld accountId with account (T-0061)', () => {
    expect(withheldWireFields(['emails', 'accountId'])).toEqual(['emails', 'accountId', 'account']);
  });

  it('adds nothing when ownerUserId and accountId are readable', () => {
    expect(withheldWireFields(['emails', 'status'])).toEqual(['emails', 'status']);
    expect(withheldWireFields([])).toEqual([]);
  });
});
