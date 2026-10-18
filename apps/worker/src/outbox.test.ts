import type { OutboxBacklog, RelayOutboxBatchResult, SweepOutboxResult } from '@kasuwa/db';
import { describe, expect, it, vi } from 'vitest';
import {
  backlogLine,
  errorClass,
  loggableEventType,
  loggableId,
  outboxConsumerProcessor,
  OutboxConsumerJobError,
  outboxEventLines,
  refuseWrongPoolRolesAtBoot,
  runOutboxSweep,
  runRelayTick,
  startOutboxRelay,
  WorkerPoolRoleError,
  type Consume,
  type LoginRole,
  type Pool,
  type RelayBatch,
  type Sweep,
} from './outbox';

// Invented identifiers only.
const EVENT = '0e000000-0000-4000-8000-000000000001';
const APP_POOL = { name: 'app' } as unknown as Pool;
const RELAY_POOL = { name: 'relay' } as unknown as Pool;

function lines(): { write: (line: string) => void; seen: string[] } {
  const seen: string[] = [];
  return { write: (line) => seen.push(line), seen };
}

describe('log hygiene (ADR-0018 point 10)', () => {
  it('prints an id only when it is a uuid, and a type only when it is a code', () => {
    expect(loggableId(EVENT)).toBe(EVENT);
    expect(loggableId('Invented Person')).toBe('invalid');
    expect(loggableId(undefined)).toBe('invalid');
    expect(loggableEventType('contact.owner_changed')).toBe('contact.owner_changed');
    expect(loggableEventType('owner changed for Invented Person')).toBe('invalid');
  });

  it('reduces an error to its class name', () => {
    class PgLikeError extends Error {}
    expect(errorClass(new PgLikeError('duplicate key value (phone)=(+234...)'))).toBe('PgLikeError');
    expect(errorClass('a string')).toBe('UnknownError');
  });

  it('one line per event: id, type, attempt and outcome, nothing else', () => {
    const result: RelayOutboxBatchResult = {
      claimed: 2,
      outcomes: [
        { id: EVENT, eventType: 'contact.owner_changed', attempt: 1, outcome: 'published' },
        { id: 'not an id', eventType: 'Free Text', attempt: 10, outcome: 'dead' },
      ],
    };
    expect(outboxEventLines(result)).toEqual([
      `outbox event ${EVENT} type=contact.owner_changed attempt=1 outcome=published`,
      'outbox event invalid type=invalid attempt=10 outcome=dead',
    ]);
    expect(backlogLine({ pending: 3, oldestPendingSeconds: 42 } satisfies OutboxBacklog)).toBe(
      'outbox backlog: pending=3 oldest_seconds=42',
    );
  });
});

describe('refuseWrongPoolRolesAtBoot (ADR-0018 point 11)', () => {
  const roles =
    (app: string, relay: string, appCurrent = app, relayCurrent = relay): LoginRole =>
    async (pool) =>
      pool === APP_POOL
        ? { sessionUser: app, currentUser: appCurrent }
        : { sessionUser: relay, currentUser: relayCurrent };

  it('passes kasuwa_app and kasuwa_relay', async () => {
    await expect(
      refuseWrongPoolRolesAtBoot(APP_POOL, RELAY_POOL, roles('kasuwa_app', 'kasuwa_relay')),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['swapped', 'kasuwa_relay', 'kasuwa_app', ['DATABASE_URL', 'DATABASE_RELAY_URL']],
    ['the relay on the migrator', 'kasuwa_app', 'kasuwa_migrator', ['DATABASE_RELAY_URL']],
    ['the relay on the app', 'kasuwa_app', 'kasuwa_app', ['DATABASE_RELAY_URL']],
    ['the app on the migrator', 'kasuwa_migrator', 'kasuwa_relay', ['DATABASE_URL']],
  ])('refuses %s, naming the variables and kasuwa_relay', async (_name, app, relay, wrong) => {
    const outcome = await refuseWrongPoolRolesAtBoot(APP_POOL, RELAY_POOL, roles(app, relay)).catch(
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(WorkerPoolRoleError);
    expect((outcome as WorkerPoolRoleError).variables).toEqual(wrong);
    expect((outcome as Error).message).toMatch(/kasuwa_relay/);
  });

  it('refuses a login that SET ROLE moved elsewhere (current_user differs)', async () => {
    await expect(
      refuseWrongPoolRolesAtBoot(
        APP_POOL,
        RELAY_POOL,
        roles('kasuwa_app', 'kasuwa_relay', 'kasuwa_app', 'kasuwa_migrator'),
      ),
    ).rejects.toBeInstanceOf(WorkerPoolRoleError);
  });
});

describe('runRelayTick', () => {
  const batch = (claimed: number, settled = claimed): RelayOutboxBatchResult => ({
    claimed,
    outcomes: Array.from({ length: settled }, () => ({
      id: EVENT,
      eventType: 'contact.owner_changed',
      attempt: 1,
      outcome: 'published' as const,
    })),
  });

  it('goes again while batches come back full, and stops at a short one', async () => {
    const relay = vi.fn<RelayBatch>()
      .mockResolvedValueOnce(batch(2))
      .mockResolvedValueOnce(batch(2))
      .mockResolvedValueOnce(batch(1));
    const { write } = lines();
    const run = await runRelayTick(relay, RELAY_POOL, {}, write, { batchSize: 2 });
    expect(run).toEqual({ batches: 3, claimed: 5 });
  });

  it('stops when a full claim was not all settled (rows held behind another relay)', async () => {
    const relay = vi.fn<RelayBatch>().mockResolvedValue(batch(2, 1));
    const { write, seen } = lines();
    expect(await runRelayTick(relay, RELAY_POOL, {}, write, { batchSize: 2 })).toEqual({
      batches: 1,
      claimed: 2,
    });
    expect(seen).toEqual([`outbox event ${EVENT} type=contact.owner_changed attempt=1 outcome=published`]);
  });

  it('never runs more than maxBatches', async () => {
    const relay = vi.fn<RelayBatch>().mockResolvedValue(batch(2));
    const { write } = lines();
    expect(await runRelayTick(relay, RELAY_POOL, {}, write, { batchSize: 2, maxBatches: 3 })).toEqual({
      batches: 3,
      claimed: 6,
    });
  });

  it('a failed batch logs its class only and ends the tick', async () => {
    class QueueError extends Error {}
    const relay = vi.fn<RelayBatch>().mockRejectedValue(new QueueError('redis said +2348000000000'));
    const { write, seen } = lines();
    expect(await runRelayTick(relay, RELAY_POOL, {}, write)).toEqual({ batches: 0, claimed: 0 });
    expect(seen).toEqual(['outbox relay batch failed: QueueError']);
  });
});

describe('runOutboxSweep', () => {
  it('sweeps while either kind is full, and logs counts only', async () => {
    const sweep = vi.fn<Sweep>()
      .mockResolvedValueOnce({ published: 2, dead: 0 } satisfies SweepOutboxResult)
      .mockResolvedValueOnce({ published: 0, dead: 2 })
      .mockResolvedValueOnce({ published: 1, dead: 0 });
    const { write, seen } = lines();
    expect(await runOutboxSweep(sweep, RELAY_POOL, write, { batchSize: 2 })).toEqual({
      published: 3,
      dead: 2,
      batches: 3,
    });
    expect(seen).toEqual(['outbox sweep: deleted published=3 dead=2 batches=3']);
  });

  it('a failing sweep logs its class and what it managed', async () => {
    const sweep = vi.fn<Sweep>().mockRejectedValue(new TypeError('anything'));
    const { write, seen } = lines();
    await runOutboxSweep(sweep, RELAY_POOL, write);
    expect(seen).toEqual(['outbox sweep failed: TypeError', 'outbox sweep: deleted published=0 dead=0 batches=0']);
  });
});

describe('startOutboxRelay', () => {
  it('runs the relay and the sweep at once, and stop() waits for them', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const relay = vi.fn<RelayBatch>(async () => {
      await gate;
      return { claimed: 0, outcomes: [] };
    });
    const sweep = vi.fn<Sweep>().mockResolvedValue({ published: 0, dead: 0 });
    const backlog = vi.fn().mockResolvedValue({ pending: 0, oldestPendingSeconds: 0 });
    const { write } = lines();
    const running = startOutboxRelay({
      relay,
      sweep,
      backlog,
      pool: RELAY_POOL,
      queues: {},
      write,
      everyMs: 60_000,
      sweepEveryMs: 60_000,
      backlogEveryMs: 60_000,
    });
    expect(relay).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = running.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped, 'stop() returned while a batch was in flight').toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(relay).toHaveBeenCalledTimes(1);
    expect(backlog).not.toHaveBeenCalled();
  });
});

describe('outboxConsumerProcessor', () => {
  const handler = async (): Promise<string> => 'done';

  it('logs a drop by reason and resolves, so BullMQ does not retry a forgery', async () => {
    const consume = vi.fn(async () => ({ outcome: 'dropped', reason: 'forged' }) as const);
    const { write, seen } = lines();
    const process = outboxConsumerProcessor(consume as unknown as Consume, APP_POOL, handler, write);
    await expect(process({ id: 'Invented Person', data: {} })).resolves.toBe('dropped');
    expect(seen).toEqual(['outbox consume invalid outcome=dropped reason=forged']);
  });

  it('a handler failure rejects with the class name only, and no cause', async () => {
    class HandlerError extends Error {}
    const consume = vi.fn(async () => {
      throw new HandlerError('contact Invented Person not found');
    });
    const { write, seen } = lines();
    const process = outboxConsumerProcessor(consume as unknown as Consume, APP_POOL, handler, write);
    const error = await process({ id: EVENT, data: {}, attemptsMade: 2 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutboxConsumerJobError);
    expect((error as Error).message).toBe('outbox consumer failed: HandlerError');
    expect((error as Error).cause).toBeUndefined();
    expect(seen).toEqual([`outbox consume ${EVENT} attempt=3 outcome=failed error=HandlerError`]);
  });
});
