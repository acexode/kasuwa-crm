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

/**
 * A uuid, LOWER-CASED (D-L161). Postgres stores and returns uuids in lower
 * case, so a payload id compared with a column (contactId against
 * aggregate_id) must be lower case too, or a producer passing an upper-case
 * id writes an event the relay rejects ten times and kills, silently. Every
 * id in a payload schema and in the producer's input goes through this.
 */
export const OutboxUuid = z.uuid().transform((value) => value.toLowerCase());
const Uuid = OutboxUuid;

/** One queue per consuming domain (ADR-0018 point 6). */
export const OUTBOX_QUEUES = Object.freeze({
  notifications: 'kasuwa.events.notifications',
} as const);

export type OutboxQueueName = (typeof OUTBOX_QUEUES)[keyof typeof OUTBOX_QUEUES];

/**
 * `contact.owner_changed` (the contact domain; T-0100 is the producer).
 * The contact's id and the previous and new owners' ids. Staff ids are not
 * personal data in this sense (D-L71). Either owner may be null: a contact can
 * be assigned from, or released to, nobody.
 */
export const ContactOwnerChangedPayload = z.strictObject({
  contactId: Uuid,
  previousOwnerId: Uuid.nullable(),
  newOwnerId: Uuid.nullable(),
});

export type ContactOwnerChangedPayload = z.infer<typeof ContactOwnerChangedPayload>;

/**
 * `account.owner_changed`, `deal.owner_changed` and `activity.assigned` (T-0100,
 * I2): the same shape as the contact's, keyed by the aggregate they are about.
 * Ids only (D-P29); either owner may be null.
 */
export const AccountOwnerChangedPayload = z.strictObject({
  accountId: Uuid,
  previousOwnerId: Uuid.nullable(),
  newOwnerId: Uuid.nullable(),
});

export type AccountOwnerChangedPayload = z.infer<typeof AccountOwnerChangedPayload>;

export const DealOwnerChangedPayload = z.strictObject({
  dealId: Uuid,
  previousOwnerId: Uuid.nullable(),
  newOwnerId: Uuid.nullable(),
});

export type DealOwnerChangedPayload = z.infer<typeof DealOwnerChangedPayload>;

export const ActivityAssignedPayload = z.strictObject({
  activityId: Uuid,
  previousOwnerId: Uuid.nullable(),
  newOwnerId: Uuid.nullable(),
});

export type ActivityAssignedPayload = z.infer<typeof ActivityAssignedPayload>;

/**
 * `import.finished` (T-0100; T-0094's worker is the producer): one event per
 * import job, never one per row. The job's id and nothing else: the outcome
 * is re-read from the job, and the recipient is its creator.
 */
export const ImportFinishedPayload = z.strictObject({ importId: Uuid });

export type ImportFinishedPayload = z.infer<typeof ImportFinishedPayload>;

/**
 * `quote.approval_requested` (T-0166): ids only (D-P29). The notifications
 * consumer skips this until notification kinds expand; the outbox still
 * records the request so a later consumer can deliver in-app / WhatsApp.
 */
export const QuoteApprovalRequestedPayload = z.strictObject({
  approvalId: Uuid,
  quoteId: Uuid,
});

export type QuoteApprovalRequestedPayload = z.infer<typeof QuoteApprovalRequestedPayload>;

/** Everything the outbox needs to know about one event type. */
export interface OutboxEventDefinition {
  /** The strict payload schema. */
  readonly schema: z.ZodType<Record<string, unknown>, unknown>;
  /** Written to `schema_version`; the relay refuses a row with another. */
  readonly schemaVersion: number;
  /** The only aggregate type this event may be about. */
  readonly aggregateType: string;
  /** The payload key whose value must equal the row's aggregate_id. */
  readonly aggregateKey: string;
  /** The consuming domain's queue. */
  readonly queue: OutboxQueueName;
}

/**
 * Throws unless every aggregate type routes to exactly one queue (D-L161).
 * Order is kept per aggregate within one queue's addBulk; if two event types
 * about the same aggregate went to different queues, one queue's failure
 * could let a later event out ahead of an earlier one.
 */
export function assertOneQueuePerAggregateType(
  types: Readonly<Record<string, OutboxEventDefinition>>,
): void {
  const queueOf = new Map<string, string>();
  for (const definition of Object.values(types)) {
    const existing = queueOf.get(definition.aggregateType);
    if (existing !== undefined && existing !== definition.queue) {
      throw new Error(
        `outbox registry: aggregate type ${definition.aggregateType} routes to more than one queue`,
      );
    }
    queueOf.set(definition.aggregateType, definition.queue);
  }
}

export const OUTBOX_EVENT_TYPES: Readonly<Record<string, OutboxEventDefinition>> = Object.freeze({
  'contact.owner_changed': Object.freeze({
    schema: ContactOwnerChangedPayload,
    schemaVersion: 1,
    aggregateType: 'contact',
    aggregateKey: 'contactId',
    queue: OUTBOX_QUEUES.notifications,
  }),
  'account.owner_changed': Object.freeze({
    schema: AccountOwnerChangedPayload,
    schemaVersion: 1,
    aggregateType: 'account',
    aggregateKey: 'accountId',
    queue: OUTBOX_QUEUES.notifications,
  }),
  'deal.owner_changed': Object.freeze({
    schema: DealOwnerChangedPayload,
    schemaVersion: 1,
    aggregateType: 'deal',
    aggregateKey: 'dealId',
    queue: OUTBOX_QUEUES.notifications,
  }),
  'activity.assigned': Object.freeze({
    schema: ActivityAssignedPayload,
    schemaVersion: 1,
    aggregateType: 'activity',
    aggregateKey: 'activityId',
    queue: OUTBOX_QUEUES.notifications,
  }),
  'import.finished': Object.freeze({
    schema: ImportFinishedPayload,
    schemaVersion: 1,
    aggregateType: 'import',
    aggregateKey: 'importId',
    queue: OUTBOX_QUEUES.notifications,
  }),
  'quote.approval_requested': Object.freeze({
    schema: QuoteApprovalRequestedPayload,
    schemaVersion: 1,
    aggregateType: 'quote_approval',
    aggregateKey: 'approvalId',
    queue: OUTBOX_QUEUES.notifications,
  }),
});
assertOneQueuePerAggregateType(OUTBOX_EVENT_TYPES);

/**
 * Event type -> its strict payload schema (the T-0098 suite's I5). Derived
 * from `OUTBOX_EVENT_TYPES`, so the two can never disagree.
 */
export const OUTBOX_EVENT_SCHEMAS: Readonly<
  Record<string, z.ZodType<Record<string, unknown>, unknown>>
> =
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
export const OutboxEnvelope = z.strictObject({
  ...OutboxEnvelopeIdentity.shape,
  schemaVersion: z.number().int().min(1).max(32_767),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime({ offset: true }),
});

export type OutboxEnvelope = z.infer<typeof OutboxEnvelope>;
