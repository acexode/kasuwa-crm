import { describe, expect, it } from 'vitest';
import { appendOutboxEvent, OutboxEventRefusedError } from './outbox';
import {
  assertOneQueuePerAggregateType,
  ContactOwnerChangedPayload,
  isValidOutboxPayload,
  OUTBOX_EVENT_SCHEMAS,
  OUTBOX_EVENT_TYPES,
  OUTBOX_QUEUES,
  OutboxEnvelopeIdentity,
  outboxEventDefinition,
  outboxQueuesInUse,
} from './outbox-events';
import { TenantTxNotLiveError, type TenantTx } from './session';

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

describe('the outbox event registry', () => {
  it('derives the schema map from the definitions, so the two cannot drift', () => {
    expect(Object.keys(OUTBOX_EVENT_SCHEMAS)).toEqual(Object.keys(OUTBOX_EVENT_TYPES));
    expect(OUTBOX_EVENT_SCHEMAS['contact.owner_changed']).toBe(ContactOwnerChangedPayload);
  });

  it('routes contact.owner_changed to the notifications queue', () => {
    expect(outboxEventDefinition('contact.owner_changed')?.queue).toBe(OUTBOX_QUEUES.notifications);
    expect(outboxQueuesInUse()).toEqual(['kasuwa.events.notifications']);
  });

  it('knows only its own types, never an inherited property', () => {
    expect(outboxEventDefinition('contact.renamed')).toBeUndefined();
    expect(outboxEventDefinition('toString')).toBeUndefined();
    expect(outboxEventDefinition('__proto__')).toBeUndefined();
  });

  it('contact.owner_changed is strict and takes ids only', () => {
    expect(ContactOwnerChangedPayload.safeParse(VALID_PAYLOAD).success).toBe(true);
    expect(
      ContactOwnerChangedPayload.safeParse({ ...VALID_PAYLOAD, newOwnerId: null }).success,
      'releasing a contact to nobody',
    ).toBe(true);
    for (const bad of [
      { ...VALID_PAYLOAD, note: 'Invented Person' },
      { ...VALID_PAYLOAD, contactId: 'Invented Person' },
      { contactId: CONTACT, previousOwnerId: OWNER_A },
      'contact.owner_changed for someone',
    ]) {
      expect(ContactOwnerChangedPayload.safeParse(bad).success).toBe(false);
    }
  });
});

describe('upper-case uuids (D-L161)', () => {
  it('payload ids are lower-cased, so an upper-case producer still matches aggregate_id', () => {
    const upper = {
      contactId: CONTACT.toUpperCase(),
      previousOwnerId: OWNER_A.toUpperCase(),
      newOwnerId: null,
    };
    expect(ContactOwnerChangedPayload.parse(upper)).toEqual({
      contactId: CONTACT,
      previousOwnerId: OWNER_A,
      newOwnerId: null,
    });
    expect(isValidOutboxPayload({ ...ROW, payload: upper })).toBe(true);
  });

  it('the consumer envelope lower-cases too', () => {
    const parsed = OutboxEnvelopeIdentity.parse({ ...ROW, id: EVENT.toUpperCase(), tenantId: TENANT.toUpperCase() });
    expect(parsed.id).toBe(EVENT);
    expect(parsed.tenantId).toBe(TENANT);
  });
});

describe('one queue per aggregate type (D-L161)', () => {
  const definition = (queue: string) => ({
    schema: ContactOwnerChangedPayload,
    schemaVersion: 1,
    aggregateType: 'contact',
    aggregateKey: 'contactId',
    queue: queue as 'kasuwa.events.notifications',
  });

  it('accepts the shipped registry and two types on one queue', () => {
    expect(() => assertOneQueuePerAggregateType(OUTBOX_EVENT_TYPES)).not.toThrow();
    expect(() =>
      assertOneQueuePerAggregateType({
        'contact.a_b': definition('kasuwa.events.notifications'),
        'contact.c_d': definition('kasuwa.events.notifications'),
      }),
    ).not.toThrow();
  });

  it('refuses one aggregate type routed to two queues', () => {
    expect(() =>
      assertOneQueuePerAggregateType({
        'contact.a_b': definition('kasuwa.events.notifications'),
        'contact.c_d': definition('kasuwa.events.search'),
      }),
    ).toThrow(/more than one queue/);
  });
});

describe('isValidOutboxPayload: the one check producer and relay share', () => {
  it('accepts a matching event', () => {
    expect(isValidOutboxPayload(ROW)).toBe(true);
  });

  it.each([
    ['an unknown type', { eventType: 'contact.renamed' }],
    ['another schema version', { schemaVersion: 2 }],
    ['another aggregate type', { aggregateType: 'deal' }],
    ['a payload naming another aggregate', { aggregateId: OWNER_B }],
    ['a payload with free text', { payload: { ...VALID_PAYLOAD, name: 'Invented' } }],
  ])('refuses %s', (_name, change) => {
    expect(isValidOutboxPayload({ ...ROW, ...change })).toBe(false);
  });
});

describe('the consumer envelope', () => {
  it('drops what is not an identifier, and ignores extra fields', () => {
    const identity = OutboxEnvelopeIdentity.safeParse({ ...ROW, programmeIds: [PROGRAMME] });
    expect(identity.success).toBe(true);
    expect(identity.success && 'programmeIds' in identity.data).toBe(false);
    for (const bad of [
      null,
      'a string',
      [],
      {},
      { ...ROW, tenantId: 'not-a-uuid' },
      { ...ROW, eventType: 'Contact Owner Changed' },
      { ...ROW, id: `${EVENT}) OR (true` },
    ]) {
      expect(OutboxEnvelopeIdentity.safeParse(bad).success).toBe(false);
    }
  });
});

describe('appendOutboxEvent refuses before any SQL (R4)', () => {
  /** A tx-shaped object that records every statement. Not a live tx. */
  function recordingTx(): { tx: TenantTx; statements: string[] } {
    const statements: string[] = [];
    const tx: TenantTx = {
      session: { tenantId: TENANT, userId: OWNER_A, programmeIds: [PROGRAMME] },
      query: async (text: string) => {
        statements.push(text);
        return [];
      },
    };
    return { tx, statements };
  }

  it('refuses a tx that withTenantTransaction did not hand out, sending nothing (D-L155)', async () => {
    const { tx, statements } = recordingTx();
    await expect(
      appendOutboxEvent(tx, {
        id: EVENT,
        eventType: 'contact.owner_changed',
        programmeId: PROGRAMME,
        aggregateType: 'contact',
        aggregateId: CONTACT,
        payload: VALID_PAYLOAD,
      }),
    ).rejects.toBeInstanceOf(TenantTxNotLiveError);
    expect(statements).toEqual([]);
  });

  it('its refusal names the rule and no value', () => {
    const error = new OutboxEventRefusedError('programme_out_of_scope');
    expect(error.message).toBe('outbox event refused: programme_out_of_scope');
    expect(error.message).not.toContain(PROGRAMME);
  });
});
