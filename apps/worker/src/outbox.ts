import type {
  consumeOutboxJob,
  ConsumeOutboxOutcome,
  OutboxBacklog,
  OutboxHandler,
  OutboxQueueName,
  OutboxQueuePort,
  readOutboxBacklog,
  relayOutboxBatch,
  RelayOutboxBatchResult,
  sweepOutbox,
  SweepOutboxResult,
} from '@kasuwa/db';

/**
 * The outbox relay, its sweep and the consumer binding, as this process runs
 * them (T-0098, ADR-0018 points 6 to 11).
 *
 * @kasuwa/db does the database work (`relayOutboxBatch`, `sweepOutbox`,
 * `consumeOutboxJob`, R2); this file decides how often, binds BullMQ, and
 * writes the log lines. It holds no SQL.
 *
 * WHAT IS LOGGED (ADR-0018 point 10): an event's id, its type, the attempt
 * and the outcome, and counts. Never a payload, a tenant, an actor, an
 * aggregate id or an error message: a pg or Redis message can carry values,
 * so errors are reduced to their class name.
 */

/** The relay's pool, typed through @kasuwa/db so the worker needs no pg dependency. */
export type Pool = Parameters<typeof relayOutboxBatch>[0];

export type RelayBatch = typeof relayOutboxBatch;
export type Sweep = typeof sweepOutbox;
export type Backlog = typeof readOutboxBacklog;
export type Consume = typeof consumeOutboxJob;

/** Rows per batch (ADR-0018 point 6). */
export const OUTBOX_RELAY_BATCH_SIZE = 100;

/** The relay polls once a second (ADR-0018 point 6). */
export const OUTBOX_RELAY_EVERY_MS = 1_000;

/**
 * Batches per tick, at most. A full batch means more is waiting, so the tick
 * goes again at once, but never unboundedly: after this many it yields to the
 * next tick.
 */
export const OUTBOX_RELAY_MAX_BATCHES_PER_TICK = 20;

/** How often the retention sweep runs (D-L128 Q3: 7 and 30 days). */
export const OUTBOX_SWEEP_EVERY_MS = 15 * 60 * 1000;

/** Rows of each kind per sweep call, and calls per sweep run. */
export const OUTBOX_SWEEP_BATCH_SIZE = 500;
export const OUTBOX_SWEEP_MAX_BATCHES = 200;

/** How often the backlog gauge is logged. */
export const OUTBOX_BACKLOG_EVERY_MS = 60 * 1000;

/** Writes one line. The worker passes process.stdout; tests pass a recorder. */
export type Write = (line: string) => void;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u;

/** An id fit for a log line: a uuid, or a placeholder. Never what was given. */
export function loggableId(value: unknown): string {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : 'invalid';
}

/** An event type fit for a log line: a dotted code, or a placeholder. */
export function loggableEventType(value: unknown): string {
  return typeof value === 'string' && value.length <= 100 && EVENT_TYPE.test(value)
    ? value
    : 'invalid';
}

/** An error's class name, if it is a plain identifier; never its message. */
export function errorClass(error: unknown): string {
  const name: unknown =
    typeof error === 'object' && error !== null
      ? (error as { constructor?: { name?: unknown } }).constructor?.name
      : undefined;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(name)
    ? name
    : 'UnknownError';
}

/** One line per event: id, type, attempt, outcome (ADR-0018 point 10). */
export function outboxEventLines(result: RelayOutboxBatchResult): string[] {
  return result.outcomes.map(
    (event) =>
      `outbox event ${loggableId(event.id)} type=${loggableEventType(event.eventType)} ` +
      `attempt=${Number.isInteger(event.attempt) ? event.attempt : 0} outcome=${event.outcome}`,
  );
}

// ---------------------------------------------------------------------------
// boot check
// ---------------------------------------------------------------------------

/** What a pool logs in as. */
export type LoginRole = (pool: Pool) => Promise<{ sessionUser: string; currentUser: string }>;

/** Reads session_user and current_user on one pooled connection. */
export const loginRole: LoginRole = async (pool) => {
  const result = await pool.query<{ s: string; c: string }>(
    'SELECT session_user::text AS s, current_user::text AS c',
  );
  return { sessionUser: result.rows[0]?.s ?? '', currentUser: result.rows[0]?.c ?? '' };
};

/**
 * Thrown at boot when a pool is not the role it must be. Names the variables
 * and the roles they must be, never a URL or a password.
 */
export class WorkerPoolRoleError extends Error {
  override readonly name = 'WorkerPoolRoleError';

  constructor(readonly variables: readonly string[]) {
    super(
      'Refusing to start: DATABASE_URL must log in as kasuwa_app and DATABASE_RELAY_URL as ' +
        `kasuwa_relay (ADR-0018, ADR-0013 Decision 4). Not so for: ${variables.join(', ')}.`,
    );
  }
}

/**
 * The ADR-0013 Decision 4 check, for this process (ADR-0018 point 11). Before
 * any queue or schedule exists: DATABASE_URL must be kasuwa_app (NOBYPASSRLS,
 * the API's role) and DATABASE_RELAY_URL kasuwa_relay. Swapped URLs, the
 * migrator's BYPASSRLS URL, or the app URL twice would otherwise run the relay
 * with the wrong reach, or every tenant job without RLS.
 */
export async function refuseWrongPoolRolesAtBoot(
  appPool: Pool,
  relayPool: Pool,
  read: LoginRole = loginRole,
): Promise<void> {
  const [app, relay] = await Promise.all([read(appPool), read(relayPool)]);
  const wrong: string[] = [];
  if (app.sessionUser !== 'kasuwa_app' || app.currentUser !== 'kasuwa_app') {
    wrong.push('DATABASE_URL');
  }
  if (relay.sessionUser !== 'kasuwa_relay' || relay.currentUser !== 'kasuwa_relay') {
    wrong.push('DATABASE_RELAY_URL');
  }
  if (wrong.length > 0) {
    throw new WorkerPoolRoleError(wrong);
  }
}

// ---------------------------------------------------------------------------
// relay tick, sweep run, backlog gauge
// ---------------------------------------------------------------------------

/**
 * One relay tick: batches until one settles fewer than a full batch, or
 * `maxBatches` ran. Logs each event's outcome. A failed batch logs its error
 * class and ends the tick; the next tick retries.
 */
export async function runRelayTick(
  relay: RelayBatch,
  pool: Pool,
  queues: Readonly<Record<string, OutboxQueuePort>>,
  write: Write,
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<{ batches: number; claimed: number }> {
  const batchSize = options.batchSize ?? OUTBOX_RELAY_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? OUTBOX_RELAY_MAX_BATCHES_PER_TICK;
  let batches = 0;
  let claimed = 0;
  while (batches < maxBatches) {
    let result: RelayOutboxBatchResult;
    try {
      result = await relay(pool, { queues, batchSize });
    } catch (error) {
      write(`outbox relay batch failed: ${errorClass(error)}`);
      break;
    }
    batches += 1;
    claimed += result.claimed;
    for (const line of outboxEventLines(result)) write(line);
    // Go again only when the whole batch was settled: rows claimed but held
    // back (an earlier event of their aggregate is held by another relay)
    // would only be claimed again.
    if (result.outcomes.length < batchSize) break;
  }
  return { batches, claimed };
}

/** One sweep run: calls the sweep while either kind came back full. Counts only. */
export async function runOutboxSweep(
  sweep: Sweep,
  pool: Pool,
  write: Write,
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<SweepOutboxResult & { batches: number }> {
  const batchSize = options.batchSize ?? OUTBOX_SWEEP_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? OUTBOX_SWEEP_MAX_BATCHES;
  const totals = { published: 0, dead: 0, batches: 0 };
  try {
    while (totals.batches < maxBatches) {
      const counts = await sweep(pool, { batchSize });
      totals.batches += 1;
      totals.published += counts.published;
      totals.dead += counts.dead;
      if (counts.published < batchSize && counts.dead < batchSize) break;
    }
  } catch (error) {
    write(`outbox sweep failed: ${errorClass(error)}`);
  }
  write(
    `outbox sweep: deleted published=${totals.published} dead=${totals.dead} batches=${totals.batches}`,
  );
  return totals;
}

/** The backlog gauge line (ADR-0018 point 10; a dashboard reads it, nothing pages, Q4). */
export function backlogLine(backlog: OutboxBacklog): string {
  return `outbox backlog: pending=${backlog.pending} oldest_seconds=${backlog.oldestPendingSeconds}`;
}

export interface OutboxRelayDependencies {
  relay: RelayBatch;
  sweep: Sweep;
  backlog: Backlog;
  pool: Pool;
  queues: Readonly<Record<string, OutboxQueuePort>>;
  write: Write;
  everyMs?: number;
  sweepEveryMs?: number;
  backlogEveryMs?: number;
}

export interface RunningOutboxRelay {
  /** Stops scheduling and waits for the work in flight to finish. */
  stop: () => Promise<void>;
}

/**
 * Starts the relay loop, the sweep and the backlog gauge. Each is
 * single-flight: the next run is scheduled only after the previous one
 * finished, so a slow batch never overlaps itself in this process (other
 * worker instances are handled by SKIP LOCKED and the sweep's advisory lock).
 */
export function startOutboxRelay(deps: OutboxRelayDependencies): RunningOutboxRelay {
  let stopping = false;
  const timers = new Set<NodeJS.Timeout>();
  const inFlight = new Set<Promise<unknown>>();

  const schedule = (everyMs: number, work: () => Promise<unknown>, immediately: boolean): void => {
    const run = (): void => {
      if (stopping) return;
      const pending = work().finally(() => {
        inFlight.delete(pending);
        if (!stopping) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            run();
          }, everyMs);
          timers.add(timer);
        }
      });
      inFlight.add(pending);
    };
    if (immediately) {
      run();
    } else {
      const timer = setTimeout(() => {
        timers.delete(timer);
        run();
      }, everyMs);
      timers.add(timer);
    }
  };

  schedule(
    deps.everyMs ?? OUTBOX_RELAY_EVERY_MS,
    () => runRelayTick(deps.relay, deps.pool, deps.queues, deps.write),
    true,
  );
  schedule(
    deps.sweepEveryMs ?? OUTBOX_SWEEP_EVERY_MS,
    () => runOutboxSweep(deps.sweep, deps.pool, deps.write),
    true,
  );
  schedule(
    deps.backlogEveryMs ?? OUTBOX_BACKLOG_EVERY_MS,
    async () => {
      try {
        deps.write(backlogLine(await deps.backlog(deps.pool)));
      } catch (error) {
        deps.write(`outbox backlog read failed: ${errorClass(error)}`);
      }
    },
    false,
  );

  return {
    stop: async () => {
      stopping = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await Promise.allSettled([...inFlight]);
    },
  };
}

// ---------------------------------------------------------------------------
// consumer binding (T-0100 registers the first handler)
// ---------------------------------------------------------------------------

/**
 * What a consumer job throws to BullMQ. BullMQ stores a failed job's message
 * and stack in Redis, so the original is never rethrown: this names its class
 * and nothing else, and carries no `cause`.
 */
export class OutboxConsumerJobError extends Error {
  override readonly name = 'OutboxConsumerJobError';

  constructor(error: unknown) {
    super(`outbox consumer failed: ${errorClass(error)}`);
  }
}

/** The part of a BullMQ job a consumer reads. */
export interface ConsumerJob {
  id?: string;
  data: unknown;
  attemptsMade?: number;
}

/**
 * A BullMQ processor for one consuming queue, bound to that queue (a job
 * whose event type the registry routes elsewhere is dropped). The handler
 * must be idempotent: delivery is at-least-once (ADR-0018 point 8). Runs
 * `consumeOutboxJob` on the
 * app pool (kasuwa_app: the consumer re-enters the tenant as the event's
 * actor, ADR-0018 point 8). A drop resolves and is logged by reason, so a
 * forged job is not retried; any other failure rejects with a sanitised
 * error, so BullMQ retries it up to the job's five attempts and then parks it
 * in the failed set, the dead-letter queue (D-L128 Q3 and Q5).
 */
export function outboxConsumerProcessor<T>(
  consume: Consume,
  appPool: Pool,
  queue: OutboxQueueName,
  handler: OutboxHandler<T>,
  write: Write,
): (job: ConsumerJob) => Promise<ConsumeOutboxOutcome<T>['outcome']> {
  return async (job) => {
    let outcome: ConsumeOutboxOutcome<T>;
    try {
      outcome = await consume(appPool, job.data, handler, { queue });
    } catch (error) {
      write(
        `outbox consume ${loggableId(job.id)} attempt=${(job.attemptsMade ?? 0) + 1} ` +
          `outcome=failed error=${errorClass(error)}`,
      );
      throw new OutboxConsumerJobError(error);
    }
    write(
      outcome.outcome === 'dropped'
        ? `outbox consume ${loggableId(job.id)} outcome=dropped reason=${outcome.reason} ` +
            `detail=${outcome.detail}`
        : `outbox consume ${loggableId(job.id)} outcome=handled`,
    );
    return outcome.outcome;
  };
}
