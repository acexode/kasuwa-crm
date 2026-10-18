import { z } from 'zod';
import { isValidOutboxPayload, outboxEventDefinition, OutboxUuid } from './outbox-events';
import { assertLiveTenantTx, type TenantTx } from './session';

/**
 * Writing an outbox event (T-0098, ADR-0018 point 2).
 *
 * `appendOutboxEvent(tx, event)` INSERTs one `outbox_event` row on the
 * producer's own tenant transaction, so the event commits with the change or
 * not at all, and the ADR-0010 commit-time scope check covers it like any
 * other write.
 *
 * THE SESSION DECIDES, NOT THE EVENT. The row's tenant is `tx.session.tenantId`
 * and its actor is `tx.session.userId`, whatever else the object carries: an
 * extra `tenantId` or `actorUserId` on the event is ignored. The programme must
 * be one the session resolved (`tx.session.programmeIds`).
 *
 * REFUSED BEFORE ANY SQL (R4). Every refusal below happens in TypeScript, so
 * the caller's transaction is still usable afterwards. RLS is the second,
 * independent layer (CLAUDE.md 2.3): the tenant policy's WITH CHECK refuses
 * another tenant or programme, the restrictive insert policy refuses another
 * actor (F-R3), and kasuwa_app holds INSERT on no column that would let it
 * choose `seq` or pre-publish a row.
 *
 * The error names the rule broken and nothing else: no id, no tenant, no
 * payload value. A refusal is a programming error in the producer, not
 * something a user caused, so it is not translated.
 *
 * THE PRODUCER CONTRACT (D-L161):
 *   1. Take the aggregate's row lock BEFORE appending: write the record first
 *      (the UPDATE that changes the owner, say), then call appendOutboxEvent
 *      in the same transaction. `seq` is assigned at INSERT, not at COMMIT,
 *      so two transactions changing one aggregate could otherwise commit in
 *      one order and carry seqs in the other, and the relay would publish
 *      the events out of order. The row lock serialises them.
 *   2. Generate the event id with `randomUUID()` (node:crypto), fresh per
 *      event. Ids are global, not per tenant: the id is the primary key, the
 *      BullMQ jobId and every consumer's idempotency key. Never derive one
 *      from the aggregate or reuse one.
 *   3. Consumers are at-least-once (ADR-0018 point 6): an event can be
 *      delivered twice, so its handler must be idempotent.
 */

const Uuid = OutboxUuid;

/**
 * What a producer passes. Extra properties are ignored, never honoured. Every
 * id is lower-cased (D-L161), as the payload schemas lower-case theirs, so an
 * upper-case uuid from a producer still matches the row's columns.
 */
const AppendInput = z.object({
  id: Uuid,
  eventType: z.string(),
  programmeId: Uuid,
  aggregateType: z.string(),
  aggregateId: Uuid,
  payload: z.unknown(),
});

export interface OutboxEventInput {
  /** The producer's uuid: the BullMQ jobId and the consumers' idempotency key. */
  id: string;
  eventType: string;
  programmeId: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
}

export type OutboxRefusal =
  | 'invalid_event'
  | 'unknown_event_type'
  | 'programme_out_of_scope'
  | 'invalid_payload';

/** Thrown by `appendOutboxEvent` before any SQL. Names the rule, never a value. */
export class OutboxEventRefusedError extends Error {
  override readonly name = 'OutboxEventRefusedError';

  constructor(readonly refusal: OutboxRefusal) {
    super(`outbox event refused: ${refusal}`);
  }
}

const INSERT_OUTBOX_EVENT_SQL = `
  INSERT INTO outbox_event
    (id, tenant_id, programme_id, actor_user_id, event_type, schema_version,
     aggregate_type, aggregate_id, payload)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`;

/**
 * Appends one event, as the session's user, in the session's tenant. Returns
 * the event id. See the module comment for what it refuses.
 */
export async function appendOutboxEvent(
  tx: TenantTx,
  event: OutboxEventInput,
): Promise<{ id: string }> {
  // A copied or finished tx would have its session believed (D-L155).
  assertLiveTenantTx(tx);

  const input = AppendInput.safeParse(event);
  if (!input.success) {
    throw new OutboxEventRefusedError('invalid_event');
  }
  const { id, eventType, programmeId, aggregateType, aggregateId, payload } = input.data;

  const definition = outboxEventDefinition(eventType);
  if (definition === undefined) {
    throw new OutboxEventRefusedError('unknown_event_type');
  }
  if (!tx.session.programmeIds.includes(programmeId)) {
    throw new OutboxEventRefusedError('programme_out_of_scope');
  }
  const schemaVersion = definition.schemaVersion;
  if (!isValidOutboxPayload({ eventType, schemaVersion, aggregateType, aggregateId, payload })) {
    throw new OutboxEventRefusedError('invalid_payload');
  }
  // Re-parsed, so what is written is exactly what the strict schema admits.
  const stored = definition.schema.parse(payload);

  await tx.query(INSERT_OUTBOX_EVENT_SQL, [
    id,
    tx.session.tenantId,
    programmeId,
    tx.session.userId,
    eventType,
    schemaVersion,
    aggregateType,
    aggregateId,
    JSON.stringify(stored),
  ]);
  return { id };
}
