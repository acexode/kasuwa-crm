import type { TenantTx } from '@kasuwa/db';
import { describe, expect, it, vi } from 'vitest';
import { ownerEventFor, type OwnerChange } from './owner-events';

// Invented identifiers (CLAUDE.md 6.1).
const ACTOR = '0f000000-0000-4000-8000-000000000001';
const OWNER_A = '0f000000-0000-4000-8000-000000000002';
const OWNER_B = '0f000000-0000-4000-8000-000000000003';
const RECORD = '0f000000-0000-4000-8000-000000000004';
const PROGRAMME = '0f000000-0000-4000-8000-000000000005';

const change = (over: Partial<OwnerChange> = {}): OwnerChange => ({
  object: 'contact',
  id: RECORD,
  programmeId: PROGRAMME,
  previousOwnerId: OWNER_A,
  newOwnerId: OWNER_B,
  ...over,
});

describe('ownerEventFor (T-0100 producers)', () => {
  it('names the record, both owners and nothing else', () => {
    expect(ownerEventFor(change(), ACTOR)).toEqual({
      eventType: 'contact.owner_changed',
      aggregateType: 'contact',
      aggregateId: RECORD,
      payload: { contactId: RECORD, previousOwnerId: OWNER_A, newOwnerId: OWNER_B },
    });
  });

  it.each([
    ['contact', 'contact.owner_changed', 'contactId'],
    ['account', 'account.owner_changed', 'accountId'],
    ['deal', 'deal.owner_changed', 'dealId'],
    ['activity', 'activity.assigned', 'activityId'],
  ] as const)('a %s change is %s keyed by %s', (object, eventType, key) => {
    const event = ownerEventFor(change({ object }), ACTOR);
    expect(event?.eventType).toBe(eventType);
    expect(event?.aggregateType).toBe(object);
    expect(Object.keys(event?.payload ?? {}).sort()).toEqual([key, 'newOwnerId', 'previousOwnerId']);
  });

  it('a create is an assignment: the previous owner is null', () => {
    expect(ownerEventFor(change({ previousOwnerId: null }), ACTOR)?.payload).toMatchObject({
      previousOwnerId: null,
      newOwnerId: OWNER_B,
    });
  });

  it('appends nothing for an unassignment (D-P23)', () => {
    expect(ownerEventFor(change({ newOwnerId: null }), ACTOR)).toBeNull();
  });

  it('appends nothing when the owner is unchanged, whatever the letter case', () => {
    expect(ownerEventFor(change({ previousOwnerId: OWNER_B }), ACTOR)).toBeNull();
    expect(ownerEventFor(change({ previousOwnerId: OWNER_B.toUpperCase() }), ACTOR)).toBeNull();
  });

  it('appends nothing for a self-assignment', () => {
    expect(ownerEventFor(change({ newOwnerId: ACTOR }), ACTOR)).toBeNull();
    expect(ownerEventFor(change({ newOwnerId: ACTOR.toUpperCase() }), ACTOR)).toBeNull();
  });
});

describe('appendOwnerChangedEvent', () => {
  it('refuses a tx that is not live, and appends nothing when no event is called for', async () => {
    const { appendOwnerChangedEvent } = await import('./owner-events');
    const query = vi.fn();
    const tx = {
      session: { tenantId: 't', userId: ACTOR, programmeIds: [PROGRAMME] },
      query,
    } as unknown as TenantTx;
    // No event is called for, so nothing is attempted (the live-tx check is appendOutboxEvent's).
    await expect(appendOwnerChangedEvent(tx, change({ newOwnerId: null }))).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
    // An event IS called for: a copied tx is refused before any SQL (D-L155).
    await expect(appendOwnerChangedEvent(tx, change())).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
