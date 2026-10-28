import { describe, expect, it } from 'vitest';
import {
  AccountOwnerChangedPayload,
  ActivityAssignedPayload,
  assertOneQueuePerAggregateType,
  DealOwnerChangedPayload,
  ImportFinishedPayload,
  isValidOutboxPayload,
  OUTBOX_EVENT_SCHEMAS,
  OUTBOX_EVENT_TYPES,
  OUTBOX_QUEUES,
  outboxEventDefinition,
} from './outbox-events';

// Invented identifiers (CLAUDE.md 6.1).
const ID = '0e000000-0000-4000-8000-000000000001';
const OWNER_A = '0e000000-0000-4000-8000-000000000002';
const OWNER_B = '0e000000-0000-4000-8000-000000000003';

const OWNER_EVENTS = [
  ['account.owner_changed', 'account', 'accountId', AccountOwnerChangedPayload],
  ['deal.owner_changed', 'deal', 'dealId', DealOwnerChangedPayload],
  ['activity.assigned', 'activity', 'activityId', ActivityAssignedPayload],
] as const;

describe('the notification event types (T-0100 I2)', () => {
  it.each(OWNER_EVENTS)(
    '%s is registered, routed to the notifications queue and about its own aggregate',
    (eventType, aggregate, key, schema) => {
      expect(OUTBOX_EVENT_SCHEMAS[eventType]).toBe(schema);
      expect(outboxEventDefinition(eventType)).toMatchObject({
        aggregateType: aggregate,
        aggregateKey: key,
        queue: OUTBOX_QUEUES.notifications,
        schemaVersion: 1,
      });
    },
  );

  it.each(OWNER_EVENTS)('%s is strict, ids only, owners nullable and required', (eventType, aggregate, key, schema) => {
    const valid = { [key]: ID, previousOwnerId: null, newOwnerId: OWNER_B };
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, previousOwnerId: OWNER_A }).success).toBe(true);
    expect(schema.safeParse({ ...valid, newOwnerId: null }).success).toBe(true);
    expect(schema.safeParse({ ...valid, displayName: 'Sample' }).success).toBe(false);
    expect(schema.safeParse({ ...valid, [key]: 'Sample Holdings' }).success).toBe(false);
    expect(schema.safeParse({ [key]: ID, newOwnerId: OWNER_B }).success).toBe(false);
    expect(
      isValidOutboxPayload({ eventType, schemaVersion: 1, aggregateType: aggregate, aggregateId: ID, payload: valid }),
    ).toBe(true);
    // The payload's id must be the row's aggregate id.
    expect(
      isValidOutboxPayload({ eventType, schemaVersion: 1, aggregateType: aggregate, aggregateId: OWNER_A, payload: valid }),
    ).toBe(false);
  });

  it('lower-cases an upper-case id, as every payload schema does (D-L161)', () => {
    const parsed = DealOwnerChangedPayload.parse({
      dealId: ID.toUpperCase(),
      previousOwnerId: null,
      newOwnerId: OWNER_A.toUpperCase(),
    });
    expect(parsed).toEqual({ dealId: ID, previousOwnerId: null, newOwnerId: OWNER_A });
  });

  it('import.finished carries the job id and nothing else', () => {
    expect(ImportFinishedPayload.safeParse({ importId: ID }).success).toBe(true);
    expect(ImportFinishedPayload.safeParse({ importId: ID, filename: 'people.csv' }).success).toBe(false);
    expect(ImportFinishedPayload.safeParse({ importId: 'people.csv' }).success).toBe(false);
    expect(ImportFinishedPayload.safeParse({}).success).toBe(false);
    expect(outboxEventDefinition('import.finished')).toMatchObject({
      aggregateType: 'import',
      aggregateKey: 'importId',
      queue: OUTBOX_QUEUES.notifications,
    });
  });

  it('keeps one queue per aggregate type with every new type registered', () => {
    expect(() => assertOneQueuePerAggregateType(OUTBOX_EVENT_TYPES)).not.toThrow();
    expect(Object.keys(OUTBOX_EVENT_TYPES).sort()).toEqual([
      'account.owner_changed',
      'activity.assigned',
      'contact.owner_changed',
      'deal.owner_changed',
      'import.finished',
      'quote.approval_requested',
    ]);
  });
});
