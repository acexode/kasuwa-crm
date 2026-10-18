import {
  accountFieldApiName,
  WITHHOLDABLE_ACCOUNT_FIELDS,
  type Account,
  type AccountFieldAccess,
  type AccountFieldLevel,
} from '@kasuwa/domain-core';
import { describe, expect, it } from 'vitest';
import { toAccountWire, withheldAccountWireFields } from './account-wire';
import { EMPTY_CUSTOM_WIRE } from '../custom-fields/custom-values';

const A1 = '11111111-0000-4000-8000-00005500c001';
// Invented (CLAUDE.md 6.1): never a seeded or real person or number.
const OWNER = { id: '11111111-0000-4000-8000-00005500c0a1', displayName: 'Probe Owner W5' };
const PHONE = '+2348030055999';

const account: Account = {
  id: '11111111-0000-4000-8000-00005500c0e1',
  programmeId: A1,
  version: 3,
  name: 'Probe Wire Ltd',
  ownerUserId: OWNER.id,
  owner: OWNER,
  industry: 'FMCG',
  tier: 'sme',
  tags: ['Distributor'],
  phones: [{ type: 'work', e164: PHONE }],
  state: 'Lagos',
  lga: 'Ikeja',
  parentAccountId: null,
  createdAt: new Date('2026-01-01T00:00:00.123Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
};

/** Every account field_def in A1 at edit, with overrides by api_name. */
function accessWith(overrides: Record<string, AccountFieldLevel> = {}): AccountFieldAccess {
  const fields = new Map<string, AccountFieldLevel>([['name', 'edit']]);
  for (const field of WITHHOLDABLE_ACCOUNT_FIELDS) fields.set(accountFieldApiName(field), 'edit');
  for (const [apiName, level] of Object.entries(overrides)) fields.set(apiName, level);
  return new Map([[A1, fields]]);
}

describe('toAccountWire (records.openapi.yaml Account)', () => {
  it('sends every contract property and nothing else when nothing is withheld', () => {
    const wire = toAccountWire(account, accessWith(), EMPTY_CUSTOM_WIRE);
    expect(Object.keys(wire).sort()).toEqual(
      [
        'id',
        'programmeId',
        'version',
        'name',
        'ownerUserId',
        'owner',
        'industry',
        'tier',
        'tags',
        'phones',
        'state',
        'lga',
        'parentAccountId',
        'createdAt',
        'updatedAt',
        // T-0089: always present, `{}` when nothing is visible.
        'custom',
        'withheldFields',
      ].sort(),
    );
    expect(wire.withheldFields).toEqual([]);
    expect(wire.owner).toEqual(OWNER);
    expect(wire.createdAt).toBe('2026-01-01T00:00:00.123Z');
  });

  it('omits a withheld field, never nulls it, and lists it', () => {
    const wire = toAccountWire(account, accessWith({ tier: 'none', phones: 'none' }), EMPTY_CUSTOM_WIRE);
    expect('tier' in wire).toBe(false);
    expect('phones' in wire).toBe(false);
    expect(wire.withheldFields).toEqual(['tier', 'phones']);
    expect(JSON.stringify(wire)).not.toContain(PHONE);
    // A field the caller may read but not edit is still sent.
    expect(toAccountWire(account, accessWith({ tier: 'read' }), EMPTY_CUSTOM_WIRE).tier).toBe('sme');
  });

  it('withholds owner together with ownerUserId, so no name survives a withheld id', () => {
    const wire = toAccountWire(account, accessWith({ owner_user_id: 'none' }), EMPTY_CUSTOM_WIRE);
    expect('ownerUserId' in wire).toBe(false);
    expect('owner' in wire).toBe(false);
    expect(wire.withheldFields).toEqual(['ownerUserId', 'owner']);
    expect(JSON.stringify(wire)).not.toContain(OWNER.displayName);
    expect(JSON.stringify(wire)).not.toContain(OWNER.id);
  });

  it('decides per row: a programme the access map does not carry withholds everything withholdable', () => {
    const wire = toAccountWire(
      { ...account, programmeId: '11111111-0000-4000-8000-00005500c099' },
      accessWith(), EMPTY_CUSTOM_WIRE,
    );
    expect(wire.withheldFields).toEqual(
      withheldAccountWireFields([...WITHHOLDABLE_ACCOUNT_FIELDS]),
    );
    expect(wire.name).toBe(account.name);
  });

  it('name is never withheld, whatever the matrix says about it', () => {
    const wire = toAccountWire(account, accessWith({ name: 'none' }), EMPTY_CUSTOM_WIRE);
    expect(wire.name).toBe(account.name);
    expect(wire.withheldFields).not.toContain('name');
  });

  it('sends an unowned account as null owner and ownerUserId, and lists as empty arrays', () => {
    const wire = toAccountWire(
      { ...account, ownerUserId: null, owner: null, tags: [], phones: [] },
      accessWith(), EMPTY_CUSTOM_WIRE,
    );
    expect(wire.ownerUserId).toBeNull();
    expect(wire.owner).toBeNull();
    expect(wire.tags).toEqual([]);
    expect(wire.phones).toEqual([]);
  });
});
