import { z } from 'zod';

/**
 * The outbox event registry (T-0098, ADR-0018 points 1, 6 and 9; D-P29).
 *
 * WHAT AN EVENT MAY CARRY. Identifiers, enum codes, field api names and
 * timestamps. Never a name, subject, amount, phone, email or any other value
 * a person typed (D-P29). Every event type has a STRICT Zod object schema
 * whose every leaf rejects free text: a uuid, a closed enum, an integer, an
 * ISO timestamp. No `z.string()` without a format, no `z.record`, no
 * `z.unknown()`, no `.passthrough()`. The T-0098 acceptance suite walks every
 * registered schema and fails on any leaf that admits free text.
 *
 * WHO OWNS A TYPE. The domain that produces it (ADR-0018 point 9). The schema
 * lives here, in @kasuwa/db, only because `appendOutboxEvent` and the relay
 * (both in this package, the pruneAuthTables precedent, R2) must parse it, and
 * a shared package cannot import a domain. The domain re-exports the SAME
 * object from its public entry (`ContactOwnerChangedPayload` from
 * @kasuwa/domain-core), so there is one schema, not two that drift.
 *
 * ADDING A TYPE. Add its payload schema and one entry to `OUTBOX_EVENT_TYPES`
 * (the aggregate it is about, the payload key that names that aggregate, and
 * the queue of the domain that consumes it), then re-export the schema from
 * the producing domain. A type the relay does not know is never enqueued: it
 * fails each attempt and goes dead after ten, so ship the registry entry with
 * the worker before (or with) the first producer.
 */

const Uuid = z.string().uuid();

/** One queue per consuming domain (ADR-0018 point 6). */
export const OUTBOX_QUEUES = Object.freeze({
  notifications: 'kasuwa.events.notifications',
} as const);

export type OutboxQueueName = (typeof OUTBOX_QUEUES)[keyof typeof OUTBOX_QUEUES];

/**
 * `contact.owner_changed` (the contact domain; T-0100 wires the producer).
 * The contact's id and the previous and new owners' ids. Staff ids are not
 * personal data in this sense (D-L71). Either owner may be null: a contact can
 * be assigned from, or released to, nobody.
 */
export const ContactOwnerChangedPayload = z
  .object({
    contactId: Uuid,
    previousOwnerId: Uuid.nullable(),
    newOwnerId: Uuid.nullable(),
  })
  .strict();

export type ContactOwnerChangedPayload = z.infer<typeof ContactOwnerChangedPayload>;

/** Everything the outbox needs to know about one event type. */
export interface OutboxEventDefinition {
  /** The strict payload schema. */
  readonly schema: z.ZodType<Record<string, unknown>>;
  /** Written to `schema_version`; the relay refuses a row with another. */
  readonly schemaVersion: number;
  /** The only aggregate type this event may be about. */
  readonly aggregateType: string;
  /** The payload key whose value must equal the row's aggregate_id. */
  readonly aggregateKey: string;
  /** The consuming domain's queue. */
  readonly queue: OutboxQueueName;
}

export const OUTBOX_EVENT_TYPES: Readonly<Record<string, OutboxEventDefinition>> = Object.freeze({
  'contact.owner_changed': Object.freeze({
    schema: ContactOwnerChangedPayload,
    schemaVersion: 1,
    aggregateType: 'contact',
    aggregateKey: 'contactId',
    queue: OUTBOX_QUEUES.notifications,
  }),
});

/**
 * Event type -> its strict payload schema (the T-0098 suite's I5). Derived
 * from `OUTBOX_EVENT_TYPES`, so the two can never disagree.
 */
export const OUTBOX_EVENT_SCHEMAS: Readonly<Record<string, z.ZodType<Record<string, unknown>>>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(OUTBOX_EVENT_TYPES).map(([type, definition]) => [type, definition.schema]),
    ),
  );

/** The definition for a type, or undefined. Own properties only. */
export function outboxEventDefinition(eventType: string): OutboxEventDefinition | undefined {
  return Object.prototype.hasOwnProperty.call(OUTBOX_EVENT_TYPES, eventType)
    ? OUTBOX_EVENT_TYPES[eventType]
    : undefined;
}

/** Every queue some registered type routes to. */
export function outboxQueuesInUse(): OutboxQueueName[] {
  return [...new Set(Object.values(OUTBOX_EVENT_TYPES).map((definition) => definition.queue))];
}

/**
 * True when `payload` is a valid payload for `eventType` about `aggregateId`
 * of `aggregateType`, at `schemaVersion`. The one check both the producer
 * (appendOutboxEvent) and the relay apply, so they cannot disagree.
 */
export function isValidOutboxPayload(event: {
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
}): boolean {
  const definition = outboxEventDefinition(event.eventType);
  if (definition === undefined) return false;
  if (event.schemaVersion !== definition.schemaVersion) return false;
  if (event.aggregateType !== definition.aggregateType) return false;
  const parsed = definition.schema.safeParse(event.payload);
  if (!parsed.success) return false;
  return parsed.data[definition.aggregateKey] === event.aggregateId;
}

// ---------------------------------------------------------------------------
// The job envelope (ADR-0018 point 6): the outbox row, as the relay enqueues
// it and the consumer receives it. Identifiers and codes only.
// ---------------------------------------------------------------------------

/** Mirrors migration 0041's CHECKs on the two code columns. */
const EventTypeCode = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u);
const AggregateTypeCode = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);

/**
 * What the consumer accepts from Redis. Not strict: an unknown extra field is
 * dropped, never honoured (scope is re-resolved from the database, point 8).
 * The payload is not read from here at all: the consumer hands the handler the
 * row it re-read under RLS.
 */
export const OutboxEnvelopeIdentity = z.object({
  id: Uuid,
  tenantId: Uuid,
  programmeId: Uuid,
  actorUserId: Uuid,
  eventType: EventTypeCode,
  aggregateType: AggregateTypeCode,
  aggregateId: Uuid,
});

export type OutboxEnvelopeIdentity = z.infer<typeof OutboxEnvelopeIdentity>;

/** The full envelope the relay builds. */
export const OutboxEnvelope = OutboxEnvelopeIdentity.extend({
  schemaVersion: z.number().int().min(1).max(32_767),
  payload: z.record(z.unknown()),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export type OutboxEnvelope = z.infer<typeof OutboxEnvelope>;
