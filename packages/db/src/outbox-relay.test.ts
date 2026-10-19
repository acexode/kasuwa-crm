import { describe, expect, it } from 'vitest';
import { OutboxEnvelope } from './outbox-events';
import {
  OUTBOX_CONSUMER_ATTEMPTS,
  OUTBOX_RETENTION,
  outboxEnvelopeFor,
  outboxJobOptions,
} from './outbox-relay';

// Invented identifiers; none names a real record.
const CONTACT = '0d000000-0000-4000-8000-000000000001';
const OWNER_A = '0d000000-0000-4000-8000-000000000002';
const OWNER_B = '0d000000-0000-4000-8000-000000000003';
const TENANT = '0d000000-0000-4000-8000-000000000004';
const PROGRAMME = '0d000000-0000-4000-8000-000000000005';
const EVENT = '0d000000-0000-4000-8000-000000000006';

const VALID_PAYLOAD = { contactId: CONTACT, previousOwnerId: OWNER_A, newOwnerId: OWNER_B };

const ROW = {
  id: EVENT,
  tenantId: TENANT,
  programmeId: PROGRAMME,
  actorUserId: OWNER_A,
  eventType: 'contact.owner_changed',
  schemaVersion: 1,
  aggregateType: 'contact',
  aggregateId: CONTACT,
  payload: VALID_PAYLOAD,
  createdAt: new Date('2026-10-18T10:00:00.000Z'),
};

describe('the relay envelope', () => {
  it('is built from a valid row, with exactly the admitted payload keys', () => {
    const built = outboxEnvelopeFor(ROW);
    expect(built?.queue).toBe('kasuwa.events.notifications');
    expect(built?.envelope).toEqual({
      id: EVENT,
      tenantId: TENANT,
      programmeId: PROGRAMME,
      actorUserId: OWNER_A,
      eventType: 'contact.owner_changed',
      schemaVersion: 1,
      aggregateType: 'contact',
      aggregateId: CONTACT,
      payload: VALID_PAYLOAD,
      createdAt: '2026-10-18T10:00:00.000Z',
    });
    expect(OutboxEnvelope.safeParse(built?.envelope).success).toBe(true);
  });

  it('is not built for a row its schema rejects (R3)', () => {
    expect(outboxEnvelopeFor({ ...ROW, payload: { contactId: 'Invented Person' } })).toBeUndefined();
    expect(outboxEnvelopeFor({ ...ROW, eventType: 'contact.exported' })).toBeUndefined();
    expect(outboxEnvelopeFor({ ...ROW, aggregateId: OWNER_B })).toBeUndefined();
  });
});

describe('job options (R1, D-L128 Q3 and Q5)', () => {
  it('five consumer attempts, exponential backoff, completed kept a week, failed kept 30 days (D-L174)', () => {
    const options = outboxJobOptions(EVENT);
    expect(options).toEqual({
      jobId: EVENT,
      attempts: OUTBOX_CONSUMER_ATTEMPTS,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: OUTBOX_RETENTION.publishedDays * 24 * 60 * 60 },
      removeOnFail: { age: 2_592_000 },
    });
    // D-L174: bounded to the dead-row retention, never kept forever.
    expect(options.removeOnFail.age).toBe(OUTBOX_RETENTION.deadDays * 24 * 60 * 60);
    expect(options.attempts).toBe(5);
    expect(options.removeOnComplete.age).toBeGreaterThanOrEqual(604_800);
  });
});
