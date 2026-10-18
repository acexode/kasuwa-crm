import type { Pool } from 'pg';
import { OutboxEnvelopeIdentity, outboxEventDefinition } from './outbox-events';
import { UnknownSessionUserError, withTenantTransaction, type TenantTx } from './session';

/**
 * How a consumer re-enters a tenant (T-0098, ADR-0018 point 8; F-R1, F-R2,
 * R5 in the T-0098 suites).
 *
 * REDIS IS TRANSPORT, NOT AUTHORITY. Whoever can write to Redis controls a
 * job's envelope: which tenant, which actor, which event, which aggregate. So
 * nothing on the envelope is believed until the database agrees:
 *
 *   1. the envelope is parsed (identifiers and codes only). Anything that does
 *      not parse is a forged or corrupt job: dropped, never thrown;
 *   2. `withTenantTransaction({ tenantId, userId: actorUserId })`: scope comes
 *      from `user_programme`, as for any request. An actor who no longer
 *      resolves in that tenant (disabled, removed, or never there) is dropped
 *      as `actor_gone`, never widened (CLAUDE.md 6.5);
 *   3. inside that transaction the outbox row is re-read BY ID, UNDER RLS, with
 *      an explicit tenant filter as the second layer (CLAUDE.md 2.3). It must
 *      exist and match the envelope on tenant, programme, actor, event type,
 *      aggregate type and aggregate id (F-R1: the actor decides whose scope
 *      the handler runs under, so it is compared too). A missing or
 *      mismatched row is dropped as `forged`;
 *   4. only then is `handler(tx, envelope)` called, where the envelope is
 *      rebuilt FROM THE ROW, payload included, never from Redis. The handler
 *      re-reads its aggregate under RLS and acts on current state.
 *
 * OUTCOMES. A drop RESOLVES `{ outcome: 'dropped', reason }` so BullMQ does
 * not retry a forgery five times; the caller counts it by reason (R5). A
 * handler error, or any other failure, REJECTS, so BullMQ retries, and the
 * transaction rolls back with everything the handler wrote. The drop outcome
 * carries the reason and nothing else: no tenant, actor, aggregate or
 * message, because a drop path is exactly where the values in play may belong
 * to someone else. This module never logs.
 */

export type OutboxDropReason = 'forged' | 'actor_gone';

export type ConsumeOutboxOutcome<T> =
  | { outcome: 'handled'; value: T }
  | { outcome: 'dropped'; reason: OutboxDropReason };

/** What the handler receives: the row as the database holds it. */
export interface ConsumedOutboxEvent {
  id: string;
  tenantId: string;
  programmeId: string;
  actorUserId: string;
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type OutboxHandler<T> = (tx: TenantTx, event: ConsumedOutboxEvent) => Promise<T>;

const REREAD_SQL = `
  SELECT id, tenant_id, programme_id, actor_user_id, event_type, schema_version,
         aggregate_type, aggregate_id, payload, created_at
    FROM outbox_event
   WHERE id = $1
     AND tenant_id = $2`;

interface RereadRow {
  id: string;
  tenant_id: string;
  programme_id: string;
  actor_user_id: string;
  event_type: string;
  schema_version: number;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  created_at: Date;
}

const FORGED = { outcome: 'dropped', reason: 'forged' } as const;
const ACTOR_GONE = { outcome: 'dropped', reason: 'actor_gone' } as const;

/**
 * Re-enters the envelope's tenant as its actor, confirms the event against
 * the database, and runs `handler` in that transaction. See the module
 * comment.
 */
export async function consumeOutboxJob<T>(
  pool: Pool,
  data: unknown,
  handler: OutboxHandler<T>,
): Promise<ConsumeOutboxOutcome<T>> {
  const parsed = OutboxEnvelopeIdentity.safeParse(data);
  if (!parsed.success) {
    return FORGED;
  }
  const envelope = parsed.data;

  try {
    return await withTenantTransaction(
      pool,
      { tenantId: envelope.tenantId, userId: envelope.actorUserId },
      async (tx): Promise<ConsumeOutboxOutcome<T>> => {
        const rows = await tx.query<RereadRow>(REREAD_SQL, [envelope.id, tx.session.tenantId]);
        const row = rows[0];
        if (
          row === undefined ||
          row.tenant_id !== envelope.tenantId ||
          row.programme_id !== envelope.programmeId ||
          row.actor_user_id !== envelope.actorUserId ||
          row.event_type !== envelope.eventType ||
          row.aggregate_type !== envelope.aggregateType ||
          row.aggregate_id !== envelope.aggregateId ||
          // RLS already confines the read to the resolved programmes; this is
          // the explicit second check.
          !tx.session.programmeIds.includes(row.programme_id)
        ) {
          return FORGED;
        }
        const definition = outboxEventDefinition(row.event_type);
        const payload = definition?.schema.safeParse(row.payload);
        if (payload === undefined || !payload.success) {
          // The relay re-parses before enqueue (R3), so a row that fails here
          // was changed or forged after publication.
          return FORGED;
        }
        const event: ConsumedOutboxEvent = {
          id: row.id,
          tenantId: row.tenant_id,
          programmeId: row.programme_id,
          actorUserId: row.actor_user_id,
          eventType: row.event_type,
          schemaVersion: row.schema_version,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          payload: payload.data,
          createdAt: row.created_at.toISOString(),
        };
        return { outcome: 'handled', value: await handler(tx, event) };
      },
    );
  } catch (error) {
    // The actor did not resolve in that tenant. Its message names the tenant
    // and the user, so it is replaced, never passed on.
    if (error instanceof UnknownSessionUserError) {
      return ACTOR_GONE;
    }
    throw error;
  }
}
