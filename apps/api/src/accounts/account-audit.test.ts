import type { Account } from '@kasuwa/domain-core';
import { describe, expect, it } from 'vitest';
import { accountAuditEvent, accountChanges } from './account-audit';

// Invented (CLAUDE.md 6.1).
const NAME = 'Probe Audit Trading';
const PHONE = '+2348030055998';
const OWNER = '11111111-0000-4000-8000-00005500d0a1';

const before: Account = {
  id: '11111111-0000-4000-8000-00005500d0e1',
  programmeId: '11111111-0000-4000-8000-00005500d001',
  version: 4,
  name: NAME,
  ownerUserId: OWNER,
  owner: { id: OWNER, displayName: 'Probe Owner A6' },
  industry: 'Retail',
  tier: 'sme',
  tags: ['A'],
  phones: [{ type: 'work', e164: PHONE }],
  state: 'Lagos',
  lga: 'Ikeja',
  parentAccountId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
};

const fields = (changes: ReturnType<typeof accountChanges>) =>
  changes.map((change) => change.field).sort();

describe('account audit (S2: field names only, labelled by id)', () => {
  it('every change is redacted: a field name and never a value', () => {
    const changes = accountChanges(
      { name: 'Renamed', tier: 'enterprise', phones: [{ type: 'work', e164: PHONE }] },
      before,
    );
    for (const change of changes) {
      expect(change).toEqual({ field: change.field, before: null, after: null, redacted: true });
    }
    expect(JSON.stringify(changes)).not.toContain(PHONE);
    expect(JSON.stringify(changes)).not.toContain('enterprise');
  });

  it('an update names exactly the fields that moved (closed values) or were sent (free text, phones)', () => {
    expect(
      fields(
        accountChanges(
          { tier: 'enterprise', phones: [{ type: 'work', e164: '+2348030055997' }] },
          before,
        ),
      ),
    ).toEqual(['phones', 'tier']);
    // A closed value or id sent unchanged is not news; an upper-case spelling
    // of the same owner id is the same owner.
    expect(
      fields(accountChanges({ tier: 'sme', ownerUserId: OWNER.toUpperCase() }, before)),
    ).toEqual([]);
    // Clearing is a change.
    expect(fields(accountChanges({ ownerUserId: null, tier: null }, before))).toEqual([
      'ownerUserId',
      'tier',
    ]);
  });

  it('a create records every field sent, and the closed values that are set', () => {
    expect(
      fields(
        accountChanges(
          { name: NAME, tier: 'sme', phones: [], ownerUserId: null, parentAccountId: null },
          null,
        ),
      ),
    ).toEqual(['name', 'phones', 'tier']);
  });

  it('the event is labelled with the record id, never the name, in the account’s programme', () => {
    const event = accountAuditEvent('updated', before, []);
    expect(event).toEqual({
      action: 'updated',
      objectType: 'account',
      objectId: before.id,
      objectLabel: before.id,
      programmeId: before.programmeId,
      changes: [],
    });
    expect(JSON.stringify(event)).not.toContain(NAME);
  });
});
