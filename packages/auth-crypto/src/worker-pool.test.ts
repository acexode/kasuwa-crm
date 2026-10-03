import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WorkerPool,
  WorkerPoolClosedError,
  WorkerPoolOverloadedError,
  WorkerPoolUnavailableError,
  WorkerTaskError,
} from './worker-pool';

/**
 * The pool's scheduling, tested with a trivial worker so it runs in
 * milliseconds. The payload is a tiny instruction set:
 *
 *   { echo, delayMs? }  answer `echo` after an optional delay
 *   { fail: true }      answer with a task error
 *   { crash: true }     exit the thread without answering
 *   { hold: true }      never answer (until terminated)
 *   { spinMs }          burn CPU synchronously first (a stand-in for argon2)
 */
const TEST_WORKER = `
'use strict';
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, payload }) => {
  if (payload.crash) { process.exit(3); }
  if (payload.hold) { return; }
  if (payload.spinMs) { const end = Date.now() + payload.spinMs; while (Date.now() < end) {} }
  if (payload.fail) { parentPort.postMessage({ id, ok: false, message: 'boom' }); return; }
  if (payload.wrongId) { parentPort.postMessage({ id: id + 1000, ok: true, value: 'stray' }); return; }
  const reply = () => parentPort.postMessage({ id, ok: true, value: payload.echo });
  if (payload.delayMs) { setTimeout(reply, payload.delayMs); } else { reply(); }
});
parentPort.postMessage({ ready: true });
`;

const pools: WorkerPool[] = [];
let spawned = 0;

function testPool(size: number, maxQueued: number): WorkerPool {
  const pool = new WorkerPool({
    size,
    maxQueued,
    createWorker: () => {
      spawned += 1;
      return new Worker(TEST_WORKER, { eval: true });
    },
  });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
  spawned = 0;
});

describe('WorkerPool', () => {
  it('returns each result to the caller that asked for it', async () => {
    const pool = testPool(2, 16);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        // Varying delays so replies arrive out of submission order.
        pool.run<number>({ echo: index, delayMs: (10 - index) % 4 }),
      ),
    );
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('starts queued tasks in submission order', async () => {
    // One worker, so the start order is the completion order.
    const pool = testPool(1, 16);
    const finished: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        pool.run<number>({ echo: index }).then((value) => finished.push(value)),
      ),
    );
    expect(finished).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('never runs more tasks at once than it has workers', async () => {
    const pool = testPool(2, 16);
    const running = Array.from({ length: 7 }, (_, index) =>
      pool.run({ echo: index, delayMs: 5 }),
    );
    const pressure = pool.pressure();
    expect(pressure.active).toBe(2);
    expect(pressure.queued).toBe(5);
    await Promise.all(running);
    expect(pool.pressure()).toMatchObject({ active: 0, queued: 0 });
  });

  it('refuses past size + maxQueued, at once, and keeps serving what it admitted', async () => {
    const pool = testPool(1, 2);
    const admitted = [0, 1, 2].map((index) => pool.run<number>({ echo: index, delayMs: 200 }));
    const startedAt = performance.now();
    await expect(pool.run({ echo: 'surplus' })).rejects.toBeInstanceOf(
      WorkerPoolOverloadedError,
    );
    // Shed without waiting for any of the admitted work to finish.
    expect(performance.now() - startedAt).toBeLessThan(100);
    expect(await Promise.all(admitted)).toEqual([0, 1, 2]);
    // And it takes work again once there is room.
    expect(await pool.run({ echo: 'again' })).toBe('again');
  });

  it('a maxQueued of zero still admits one task per worker', async () => {
    const pool = testPool(1, 0);
    const first = pool.run({ echo: 1, delayMs: 5 });
    await expect(pool.run({ echo: 2 })).rejects.toBeInstanceOf(WorkerPoolOverloadedError);
    expect(await first).toBe(1);
  });

  it('rejects only the failing task, and the worker carries on', async () => {
    const pool = testPool(1, 4);
    const outcomes = await Promise.allSettled([
      pool.run({ echo: 'before' }),
      pool.run({ fail: true }),
      pool.run({ echo: 'after' }),
    ]);
    expect(outcomes[0]).toEqual({ status: 'fulfilled', value: 'before' });
    expect(outcomes[1]?.status).toBe('rejected');
    expect((outcomes[1] as PromiseRejectedResult).reason).toBeInstanceOf(WorkerTaskError);
    expect(outcomes[2]).toEqual({ status: 'fulfilled', value: 'after' });
    expect(spawned).toBe(1);
  });

  it('rejects the task a dying worker held, replaces the worker, and still serves the queue', async () => {
    const pool = testPool(1, 4);
    const outcomes = await Promise.allSettled([
      pool.run({ crash: true }),
      pool.run({ echo: 'queued-behind-crash' }),
    ]);
    expect(outcomes[0]?.status).toBe('rejected');
    expect((outcomes[0] as PromiseRejectedResult).reason).toBeInstanceOf(WorkerTaskError);
    expect(outcomes[1]).toEqual({ status: 'fulfilled', value: 'queued-behind-crash' });
    expect(spawned).toBe(2);
    expect(pool.pressure()).toMatchObject({ active: 0, queued: 0, limit: 1 });
  });

  it('shutdown rejects running and queued work, and refuses later work', async () => {
    const pool = testPool(1, 4);
    const running = pool.run({ hold: true });
    const queued = pool.run({ echo: 'never' });
    // Attach the expectations before the rejection happens, so it is never
    // momentarily unhandled.
    const runningRejects = expect(running).rejects.toBeInstanceOf(WorkerPoolClosedError);
    const queuedRejects = expect(queued).rejects.toBeInstanceOf(WorkerPoolClosedError);
    // Let the hold reach the worker.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pool.pressure()).toMatchObject({ active: 1, queued: 1 });
    await pool.shutdown();
    await runningRejects;
    await queuedRejects;
    await expect(pool.run({ echo: 'late' })).rejects.toBeInstanceOf(WorkerPoolClosedError);
    expect(pool.pressure()).toMatchObject({ active: 0, queued: 0 });
    // Idempotent.
    await pool.shutdown();
  });

  it('does not keep the event loop blocked while a task runs', async () => {
    // The whole point of the pool. A task that holds its worker busy must
    // leave this thread free to run timers.
    const pool = testPool(1, 4);
    const busy = pool.run({ echo: 'done', spinMs: 200 });
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    await busy;
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(3);
  });

  it('holds the process open only while a task is in flight', async () => {
    // The seed and tenant provisioning are CLIs that hash and then expect to
    // exit. An idle worker that stays ref'd keeps them alive forever — the
    // first version did exactly that, because attaching the 'message' listener
    // after `unref()` silently re-refs the port. Counted via the resources
    // that keep the loop alive, relative to before the pool existed.
    const keepAlive = (): number =>
      process
        .getActiveResourcesInfo()
        .filter((kind) => kind === 'MessagePort' || kind === 'Worker').length;
    const before = keepAlive();
    const pool = testPool(2, 4);
    const held = pool.run({ echo: 'x', delayMs: 50 });
    expect(keepAlive(), 'a busy worker must keep the process alive').toBeGreaterThan(before);
    await held;
    expect(keepAlive(), 'idle workers must not keep the process alive').toBe(before);
  });

  it('retires a worker whose task outlives the timeout, and serves the next task on a fresh one', async () => {
    const pool = new WorkerPool({
      size: 1,
      maxQueued: 4,
      taskTimeoutMs: 50,
      createWorker: () => {
        spawned += 1;
        return new Worker(TEST_WORKER, { eval: true });
      },
    });
    pools.push(pool);
    // Started first, so the timeout is the stuck TASK and not a slow start.
    expect(await pool.run({ echo: 'warm' })).toBe('warm');
    const stuck = pool.run({ hold: true });
    const behind = pool.run({ echo: 'behind-the-stuck-one' });
    await expect(stuck).rejects.toThrow(/timed out/);
    expect(await behind).toBe('behind-the-stuck-one');
    expect(spawned).toBe(2);
    expect(pool.pressure()).toMatchObject({ active: 0, queued: 0 });
  });

  it('retires a worker that answers with the wrong id, rather than routing the reply', async () => {
    const pool = testPool(1, 4);
    const outcomes = await Promise.allSettled([
      pool.run({ wrongId: true }),
      pool.run({ echo: 'after' }),
    ]);
    expect(outcomes[0]?.status).toBe('rejected');
    expect((outcomes[0] as PromiseRejectedResult).reason).toBeInstanceOf(WorkerTaskError);
    // Nobody received the stray value; the next caller got its own.
    expect(outcomes[1]).toEqual({ status: 'fulfilled', value: 'after' });
    expect(spawned).toBe(2);
  });

  it('backs off respawning a worker that cannot start, refusing at once meanwhile', async () => {
    // A worker that dies before saying it is ready — what a missing module
    // looks like. Without back-off every request would spawn a thread.
    let clock = 1_000;
    const pool = new WorkerPool({
      size: 1,
      maxQueued: 4,
      respawnBackoffMs: { initial: 100, max: 400 },
      now: () => clock,
      createWorker: () => {
        spawned += 1;
        return new Worker(`process.exit(1);`, { eval: true });
      },
    });
    pools.push(pool);

    await expect(pool.run({ echo: 1 })).rejects.toBeInstanceOf(WorkerTaskError);
    expect(spawned).toBe(1);

    // Inside the back-off: refused immediately, and no new thread.
    await expect(pool.run({ echo: 2 })).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    await expect(pool.run({ echo: 3 })).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    expect(spawned).toBe(1);

    // After it: one more attempt, which fails again and doubles the wait.
    clock += 100;
    await expect(pool.run({ echo: 4 })).rejects.toBeInstanceOf(WorkerTaskError);
    expect(spawned).toBe(2);
    clock += 100;
    await expect(pool.run({ echo: 5 })).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    expect(spawned).toBe(2);
    clock += 100;
    await expect(pool.run({ echo: 6 })).rejects.toBeInstanceOf(WorkerTaskError);
    expect(spawned).toBe(3);
  });

  it('retires a worker that hangs while starting, as a failed start', async () => {
    const clock = 1_000;
    const pool = new WorkerPool({
      size: 1,
      maxQueued: 4,
      startTimeoutMs: 50,
      now: () => clock,
      createWorker: () => {
        spawned += 1;
        // Alive, never ready, never exits.
        return new Worker(`setInterval(() => {}, 1000);`, { eval: true });
      },
    });
    pools.push(pool);
    await expect(pool.run({ echo: 1 })).rejects.toThrow(/did not start/);
    // Counted as a failed start: backing off, not respawning per request.
    await expect(pool.run({ echo: 2 })).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    expect(spawned).toBe(1);
  });

  it('a worker that started and then crashed on a task is replaced at once, without back-off', async () => {
    // Otherwise one poisonous payload could stall the pool for everybody.
    const pool = testPool(1, 4);
    await expect(pool.run({ crash: true })).rejects.toBeInstanceOf(WorkerTaskError);
    expect(await pool.run({ echo: 'straight-away' })).toBe('straight-away');
  });

  it('rejects a nonsensical size or queue bound', () => {
    const createWorker = (): Worker => new Worker(TEST_WORKER, { eval: true });
    expect(() => new WorkerPool({ size: 0, maxQueued: 1, createWorker })).toThrow(RangeError);
    expect(() => new WorkerPool({ size: 1.5, maxQueued: 1, createWorker })).toThrow(RangeError);
    expect(() => new WorkerPool({ size: 1, maxQueued: -1, createWorker })).toThrow(RangeError);
  });
});
