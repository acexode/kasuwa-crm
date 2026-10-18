import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  isValidOutboxPayload,
  OutboxEnvelope,
  outboxEventDefinition,
  outboxQueuesInUse,
  type OutboxQueueName,
} from './outbox-events';

/**
 * The outbox relay and its retention sweep (T-0098, ADR-0018 points 4, 6 and
 * 7, as amended by D-L156; D-L128 Q3).
 *
 * BOTH RUN ON THE `kasuwa_relay` POOL, and on nothing else. That role is
 * NOBYPASSRLS and holds SELECT, DELETE and UPDATE on four publication columns
 * of `outbox_event` alone (migration 0041). Its policies admit only rows not
 * yet dispatched, rows it marked in the current transaction, and rows past
 * retention, in every tenant. That cross-tenant reach is the point (a worker
 * has no ambient tenant) and is bounded by the catalogue, not by this code:
 * whatever SQL runs here, it can read identifiers of undispatched events and
 * mark them, and nothing else. Each call confirms the connection really is
 * kasuwa_relay before it claims anything, so a mis-wired pool (the app's, or
 * worse the migrator's) fails closed instead of quietly working.
 *
 * ONE CALL OF `relayOutboxBatch` IS ONE BATCH, in one transaction:
 *   1. claim at most `batchSize` undispatched rows outside their publish
 *      backoff and not behind an earlier event of their aggregate that is
 *      inside its backoff, ORDER BY seq, FOR UPDATE SKIP LOCKED; then set aside (leave
 *      untouched) any claimed row with an earlier undispatched row of the
 *      same aggregate that this batch did NOT claim (an EXISTS that reads
 *      without locking, so it sees rows another relay holds). So two relays
 *      never claim one row, and never publish one aggregate out of order;
 *      earlier rows of an aggregate that this batch did claim go first, in
 *      seq order, in the same addBulk;
 *   2. re-parse each row against its event type's strict schema (R3). A row
 *      that fails (raw SQL inside a tenant can write any payload; kasuwa_app
 *      holds INSERT) is never enqueued and records a failed attempt, without
 *      holding back the rest of the batch (only the later events of its own
 *      aggregate wait);
 *   3. enqueue the rest with `addBulk`, one call per consuming queue, each
 *      job's id the event id, while the claim transaction is still open;
 *   4. on success set published_at = now() (no RETURNING: a published row is
 *      out of the relay's view after this transaction); on failure add one to
 *      `attempts`, set last_attempt_at, and at the tenth set dead_at;
 *   5. commit.
 * A crash between 3 and 5 rolls the marks back and the next pass re-enqueues
 * the same job ids: BullMQ drops a duplicate while the first is retained, and
 * the consumer's idempotency catches the rest. Delivery is at-least-once.
 *
 * NOTHING HERE LOGS. The result lists, per event, its id, type, attempt and
 * outcome (ADR-0018 point 10), and the caller logs exactly that. Never the
 * payload, a tenant, or anything resolved from the aggregate.
 */

/** The role both functions here must run as. */
export const OUTBOX_RELAY_ROLE = 'kasuwa_relay';

/** Publish attempts before a row is dead (D-L128 Q3). */
export const OUTBOX_MAX_PUBLISH_ATTEMPTS = 10;

/** Consumer attempts in all, BullMQ `attempts` (D-L128 Q3, R1). */
export const OUTBOX_CONSUMER_ATTEMPTS = 5;

/**
 * Retention, in days (D-L128 Q3). Migration 0041's relay policies state the
 * same windows: change both, or the sweep and the policy disagree (the policy
 * wins, so a longer window here deletes nothing early, a shorter one deletes
 * nothing at all).
 */
export const OUTBOX_RETENTION = Object.freeze({
  publishedDays: 7,
  deadDays: 30,
});

/**
 * A completed job is kept at least as long as a published row (ADR-0018
 * point 7), so a re-enqueue inside that window is still deduplicated.
 */
const COMPLETED_JOB_RETENTION_SECONDS = OUTBOX_RETENTION.publishedDays * 24 * 60 * 60;

/** First consumer retry after 5 s, then 10, 20, 40 (BullMQ exponential). */
const CONSUMER_BACKOFF_MS = 5_000;

/**
 * Publish backoff, in seconds, after the nth failed attempt: 2^n, capped at
 * an hour. Without it a Redis outage of ten seconds would kill every pending
 * event; with it, a row reaches its tenth attempt after roughly 17 minutes of
 * failures. Applied in the claim query.
 */
const PUBLISH_BACKOFF_CAP_SECONDS = 3_600;

/** BullMQ's job options for every outbox job. */
export interface OutboxJobOptions {
  jobId: string;
  attempts: number;
  backoff: { type: 'exponential'; delay: number };
  removeOnComplete: { age: number };
  removeOnFail: false;
}

export interface OutboxJob {
  /** The event type: a code, safe for BullMQ's job name. */
  name: string;
  data: OutboxEnvelope;
  opts: OutboxJobOptions;
}

/**
 * The queue port (R2): anything with BullMQ's `addBulk`. apps/worker binds a
 * real `Queue`; tests pass a recording double.
 */
export interface OutboxQueuePort {
  addBulk(jobs: OutboxJob[]): Promise<unknown>;
}

export interface RelayOutboxBatchOptions {
  /** Queue name -> port. Every queue a registered event routes to must be present. */
  queues: Readonly<Record<string, OutboxQueuePort>>;
  /** Rows claimed at most by this call. The relay uses 100. */
  batchSize: number;
}

export type OutboxPublishOutcome = 'published' | 'failed' | 'dead' | 'rejected';

/** One line of what happened to one event. Identifiers and codes only. */
export interface OutboxEventOutcome {
  id: string;
  eventType: string;
  /** Which publish attempt this was (1 for the first). */
  attempt: number;
  /**
   * published: enqueued and marked. failed: the enqueue failed, retried
   * later. rejected: the row failed its schema and was not enqueued (R3),
   * retried later. dead: the attempt that made it ten.
   */
  outcome: OutboxPublishOutcome;
}

export interface RelayOutboxBatchResult {
  claimed: number;
  outcomes: OutboxEventOutcome[];
}

const BatchOptions = z.object({
  batchSize: z.number().int().min(1).max(1_000),
});

const SweepOptions = z.object({
  batchSize: z.number().int().min(1).max(100_000),
});

/** Thrown when the pool given is not kasuwa_relay. Names the role, nothing else. */
export class OutboxRelayRoleError extends Error {
  override readonly name = 'OutboxRelayRoleError';

  constructor() {
    super(`The outbox relay must run on a connection that logs in as ${OUTBOX_RELAY_ROLE}.`);
  }
}

/** Thrown when a registered event's queue was not supplied. Names the queue. */
export class OutboxRelayConfigError extends Error {
  override readonly name = 'OutboxRelayConfigError';

  constructor(queue: string) {
    super(`The outbox relay was given no queue named ${queue}.`);
  }
}

const CONFIRM_ROLE_SQL = `
  SELECT current_user::text = $1 AND session_user::text = $1 AS ok`;

// $1 = batch size, $2 = backoff cap in seconds. Locks what it returns and
// skips what another relay holds. Not taken: a row still inside its publish
// backoff, and a row with an EARLIER undispatched row of its aggregate that
// is inside its backoff (a failing or poison event blocks only its own
// aggregate, and does so without filling every batch with rows that cannot
// go: no head-of-line blocking for other aggregates).
const IN_BACKOFF = (alias: string): string => `
  (${alias}.last_attempt_at IS NOT NULL
   AND ${alias}.last_attempt_at
       >= now() - make_interval(secs => least(power(2, ${alias}.attempts), $2::double precision)))`;

const CLAIM_SQL = `
  SELECT o.id, o.tenant_id, o.programme_id, o.actor_user_id, o.event_type,
         o.schema_version, o.aggregate_type, o.aggregate_id, o.payload,
         o.created_at, o.attempts
    FROM outbox_event o
   WHERE o.published_at IS NULL
     AND o.dead_at IS NULL
     AND NOT ${IN_BACKOFF('o')}
     AND NOT EXISTS (
           SELECT 1 FROM outbox_event e
            WHERE e.aggregate_type = o.aggregate_type
              AND e.aggregate_id = o.aggregate_id
              AND e.seq < o.seq
              AND e.published_at IS NULL
              AND e.dead_at IS NULL
              AND ${IN_BACKOFF('e')})
   ORDER BY o.seq
   LIMIT $1
   FOR UPDATE OF o SKIP LOCKED`;

// The claimed rows ($1) that must wait: an EARLIER undispatched row of the
// same aggregate exists that this batch did not claim, because another relay
// holds it (CLAIM_SQL already excludes rows behind one in backoff, and an
// earlier row sorts before a later one, so the limit cannot split them).
// A plain read, so it sees rows locked by others and waits for none. Earlier
// rows this batch DID claim do not block: they are enqueued first, in seq
// order, in the same addBulk.
const BLOCKED_SQL = `
  SELECT o.id
    FROM outbox_event o
   WHERE o.id = ANY ($1::uuid[])
     AND EXISTS (
           SELECT 1 FROM outbox_event e
            WHERE e.aggregate_type = o.aggregate_type
              AND e.aggregate_id = o.aggregate_id
              AND e.seq < o.seq
              AND e.published_at IS NULL
              AND e.dead_at IS NULL
              AND NOT (e.id = ANY ($1::uuid[])))`;

// No RETURNING: the published row passes the relay's SELECT policy only for
// the rest of this transaction (D-L156), and nothing needs it back.
const MARK_PUBLISHED_SQL = `
  UPDATE outbox_event
     SET published_at = now()
   WHERE id = ANY ($1::uuid[])
     AND published_at IS NULL
     AND dead_at IS NULL`;

// $2 = the attempt that makes a row dead.
const MARK_FAILED_SQL = `
  UPDATE outbox_event
     SET attempts = attempts + 1,
         last_attempt_at = now(),
         dead_at = CASE WHEN attempts + 1 >= $2 THEN now() ELSE NULL END
   WHERE id = ANY ($1::uuid[])
     AND published_at IS NULL
     AND dead_at IS NULL`;

interface ClaimedRow {
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
  attempts: number;
}

/** The envelope for a row, or undefined when the row fails its schema (R3). */
export function outboxEnvelopeFor(row: {
  id: string;
  tenantId: string;
  programmeId: string;
  actorUserId: string;
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  createdAt: Date;
}): { envelope: OutboxEnvelope; queue: OutboxQueueName } | undefined {
  const definition = outboxEventDefinition(row.eventType);
  if (definition === undefined || !isValidOutboxPayload(row)) return undefined;
  const parsed = OutboxEnvelope.safeParse({
    id: row.id,
    tenantId: row.tenantId,
    programmeId: row.programmeId,
    actorUserId: row.actorUserId,
    eventType: row.eventType,
    schemaVersion: row.schemaVersion,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    // The strict schema's output: exactly the admitted keys.
    payload: definition.schema.parse(row.payload),
    createdAt: row.createdAt.toISOString(),
  });
  return parsed.success ? { envelope: parsed.data, queue: definition.queue } : undefined;
}

/** BullMQ options for one event (R1, D-L128 Q3 and Q5). */
export function outboxJobOptions(eventId: string): OutboxJobOptions {
  return {
    jobId: eventId,
    attempts: OUTBOX_CONSUMER_ATTEMPTS,
    backoff: { type: 'exponential', delay: CONSUMER_BACKOFF_MS },
    removeOnComplete: { age: COMPLETED_JOB_RETENTION_SECONDS },
    // The failed set is the dead-letter queue, trimmed by hand (Q5).
    removeOnFail: false,
  };
}

async function confirmRelayRole(client: PoolClient): Promise<void> {
  const result = await client.query<{ ok: boolean | null }>(CONFIRM_ROLE_SQL, [OUTBOX_RELAY_ROLE]);
  if (result.rows[0]?.ok !== true) {
    throw new OutboxRelayRoleError();
  }
}

async function rollbackAndRelease(client: PoolClient, error: unknown): Promise<never> {
  let destroy = error instanceof OutboxRelayRoleError;
  try {
    await client.query('ROLLBACK');
  } catch {
    destroy = true;
  }
  client.release(destroy);
  throw error;
}

/**
 * Claims, enqueues and marks one batch. See the module comment. Resolves with
 * what happened to each claimed event, including when an enqueue failed (the
 * failure is recorded on the rows and committed). Rejects only when the
 * transaction itself fails, in which case nothing it did is kept.
 */
export async function relayOutboxBatch(
  pool: Pool,
  options: RelayOutboxBatchOptions,
): Promise<RelayOutboxBatchResult> {
  const { batchSize } = BatchOptions.parse({ batchSize: options.batchSize });
  for (const queue of outboxQueuesInUse()) {
    if (!Object.prototype.hasOwnProperty.call(options.queues, queue)) {
      throw new OutboxRelayConfigError(queue);
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await confirmRelayRole(client);

    const claimed = await client.query<ClaimedRow>(CLAIM_SQL, [
      batchSize,
      PUBLISH_BACKOFF_CAP_SECONDS,
    ]);

    const blocked = new Set(
      claimed.rows.length === 0
        ? []
        : (
            await client.query<{ id: string }>(BLOCKED_SQL, [claimed.rows.map((row) => row.id)])
          ).rows.map((row) => row.id),
    );

    const outcomes: OutboxEventOutcome[] = [];
    const rejected: ClaimedRow[] = [];
    const byQueue = new Map<string, { rows: ClaimedRow[]; jobs: OutboxJob[] }>();
    // An aggregate whose earlier event in this batch is waiting or was
    // rejected: its later events wait too, untouched, so order holds.
    const heldAggregates = new Set<string>();

    // claimed.rows is in seq order (CLAIM_SQL's ORDER BY).
    for (const row of claimed.rows) {
      const aggregate = `${row.aggregate_type}:${row.aggregate_id}`;
      if (blocked.has(row.id) || heldAggregates.has(aggregate)) {
        heldAggregates.add(aggregate);
        continue;
      }
      const built = outboxEnvelopeFor({
        id: row.id,
        tenantId: row.tenant_id,
        programmeId: row.programme_id,
        actorUserId: row.actor_user_id,
        eventType: row.event_type,
        schemaVersion: row.schema_version,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        createdAt: row.created_at,
      });
      if (built === undefined) {
        rejected.push(row);
        heldAggregates.add(aggregate);
        continue;
      }
      const entry = byQueue.get(built.queue) ?? { rows: [], jobs: [] };
      entry.rows.push(row);
      entry.jobs.push({ name: row.event_type, data: built.envelope, opts: outboxJobOptions(row.id) });
      byQueue.set(built.queue, entry);
    }

    const failed: ClaimedRow[] = [...rejected];
    const published: ClaimedRow[] = [];
    for (const [queue, entry] of byQueue) {
      const port = options.queues[queue];
      try {
        if (port === undefined) throw new OutboxRelayConfigError(queue);
        await port.addBulk(entry.jobs);
        published.push(...entry.rows);
      } catch {
        // The error is not kept: it may come from Redis or a test double, and
        // nothing about it is safe to carry further than "it failed".
        failed.push(...entry.rows);
      }
    }

    if (published.length > 0) {
      await client.query(MARK_PUBLISHED_SQL, [published.map((row) => row.id)]);
    }
    if (failed.length > 0) {
      await client.query(MARK_FAILED_SQL, [
        failed.map((row) => row.id),
        OUTBOX_MAX_PUBLISH_ATTEMPTS,
      ]);
    }
    await client.query('COMMIT');
    client.release();

    const rejectedIds = new Set(rejected.map((row) => row.id));
    for (const row of published) {
      outcomes.push({ id: row.id, eventType: row.event_type, attempt: row.attempts + 1, outcome: 'published' });
    }
    for (const row of failed) {
      const attempt = row.attempts + 1;
      const outcome: OutboxPublishOutcome =
        attempt >= OUTBOX_MAX_PUBLISH_ATTEMPTS
          ? 'dead'
          : rejectedIds.has(row.id)
            ? 'rejected'
            : 'failed';
      outcomes.push({ id: row.id, eventType: row.event_type, attempt, outcome });
    }
    return { claimed: claimed.rows.length, outcomes };
  } catch (error) {
    return rollbackAndRelease(client, error);
  }
}

export interface SweepOutboxResult {
  published: number;
  dead: number;
}

/** Namespace for the sweep's advisory lock: ASCII 'KOBX'. */
const SWEEP_LOCK_NAMESPACE = 0x4b4f4258;
const SWEEP_LOCK = 1;

// $1 = rows allowed, $2 = the retention interval. The rule is in the outer
// DELETE as well as the subquery, and in the relay's DELETE policy: all three
// must agree for a row to go.
const DELETE_PUBLISHED_SQL = `
  DELETE FROM outbox_event
   WHERE published_at < now() - $2::interval
     AND id IN (
       SELECT id FROM outbox_event
        WHERE published_at < now() - $2::interval
        ORDER BY published_at
        LIMIT $1)`;

const DELETE_DEAD_SQL = `
  DELETE FROM outbox_event
   WHERE dead_at < now() - $2::interval
     AND id IN (
       SELECT id FROM outbox_event
        WHERE dead_at < now() - $2::interval
        ORDER BY dead_at
        LIMIT $1)`;

/**
 * Deletes at most `batchSize` published rows older than 7 days and at most
 * `batchSize` dead rows older than 30 days, in one transaction on the relay
 * pool, under a transaction-scoped advisory lock (a concurrent sweep skips and
 * reports zero, as pruneAuthTables does). The caller calls again while a
 * count equals `batchSize`; nothing here loops.
 */
export async function sweepOutbox(
  pool: Pool,
  options: { batchSize: number },
): Promise<SweepOutboxResult> {
  const { batchSize } = SweepOptions.parse({ batchSize: options.batchSize });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await confirmRelayRole(client);
    const locked = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1, $2) AS ok',
      [SWEEP_LOCK_NAMESPACE, SWEEP_LOCK],
    );
    const result: SweepOutboxResult = { published: 0, dead: 0 };
    if (locked.rows[0]?.ok === true) {
      const published = await client.query(DELETE_PUBLISHED_SQL, [
        batchSize,
        `${OUTBOX_RETENTION.publishedDays} days`,
      ]);
      const dead = await client.query(DELETE_DEAD_SQL, [batchSize, `${OUTBOX_RETENTION.deadDays} days`]);
      result.published = published.rowCount ?? 0;
      result.dead = dead.rowCount ?? 0;
    }
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (error) {
    return rollbackAndRelease(client, error);
  }
}

export interface OutboxBacklog {
  /** Undispatched rows, every tenant. */
  pending: number;
  /** Age in seconds of the oldest undispatched row, or 0. */
  oldestPendingSeconds: number;
}

/**
 * The backlog gauge (ADR-0018 point 10): how many events wait and for how
 * long. Counts only; read on the relay pool, which sees undispatched rows in
 * every tenant and nothing about them but what the policy admits.
 */
export async function readOutboxBacklog(pool: Pool): Promise<OutboxBacklog> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await confirmRelayRole(client);
    const result = await client.query<{ pending: number; oldest: number }>(
      `SELECT count(*)::int AS pending,
              coalesce(extract(epoch FROM now() - min(created_at)), 0)::int AS oldest
         FROM outbox_event
        WHERE published_at IS NULL AND dead_at IS NULL`,
    );
    await client.query('COMMIT');
    client.release();
    return {
      pending: result.rows[0]?.pending ?? 0,
      oldestPendingSeconds: result.rows[0]?.oldest ?? 0,
    };
  } catch (error) {
    return rollbackAndRelease(client, error);
  }
}
