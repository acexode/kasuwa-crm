import type { Worker } from 'node:worker_threads';

/**
 * A small, bounded pool of worker threads that each run one task at a time.
 *
 * Written for argon2id (see `password.ts`), kept generic so that its
 * scheduling — ordering, error propagation, shedding, shutdown — can be tested
 * with a trivial worker in milliseconds rather than with a 19 MiB hash.
 *
 * THE PROPERTIES IT EXISTS TO HOLD
 *
 *   * The main thread never runs the task. It posts a message and waits on a
 *     promise, so the event loop keeps turning however many tasks are queued.
 *   * At most `size` tasks run at once — one per worker — which is what bounds
 *     the number of live argon2 buffers. This replaces the old semaphore: the
 *     concurrency bound is now the thread count, and nothing can push it past
 *     the maximum because a busy worker is simply not handed a second task.
 *   * At most `maxQueued` tasks wait. The next one is refused synchronously
 *     with `WorkerPoolOverloadedError`, so a flood is shed in one tick instead
 *     of piling up pending promises, sockets and memory.
 *   * Tasks start in the order they were submitted (FIFO).
 *   * A task that fails rejects ITS promise and nobody else's. A worker that
 *     dies rejects only the task it was running; it is replaced on demand.
 *   * A worker cannot hold a slot forever. A task that outlives
 *     `taskTimeoutMs`, or a reply that does not match the task in hand, retires
 *     the worker (terminated, task rejected) and a fresh one takes its place.
 *   * A worker that cannot start does not respawn on every request. Workers
 *     that die without ever answering back off exponentially; while backing
 *     off with no live worker, work is refused at once with
 *     `WorkerPoolUnavailableError` rather than queued behind nothing.
 *   * Idle workers are `unref`ed, so a CLI that hashed one password (the seed,
 *     tenant provisioning) still exits. A worker with a task in hand is
 *     `ref`ed, so the process cannot exit underneath a pending result.
 */

/** Refused because every worker is busy and the queue is full. */
export class WorkerPoolOverloadedError extends Error {
  constructor() {
    super('Worker pool is at capacity');
    this.name = 'WorkerPoolOverloadedError';
  }
}

/** The pool was shut down before this task could finish. */
export class WorkerPoolClosedError extends Error {
  constructor() {
    super('Worker pool is shut down');
    this.name = 'WorkerPoolClosedError';
  }
}

/** Workers keep failing to start and the pool is backing off. */
export class WorkerPoolUnavailableError extends Error {
  constructor() {
    super('Worker pool has no live worker');
    this.name = 'WorkerPoolUnavailableError';
  }
}

/** The task ran and failed, timed out, or the worker running it died. */
export class WorkerTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerTaskError';
  }
}

export interface WorkerPoolOptions {
  /** Worker threads to run. At least one. */
  size: number;
  /** Tasks that may wait for a free worker before the next is refused. */
  maxQueued: number;
  /** Builds one worker. Called lazily, and again to replace a dead one. */
  createWorker: () => Worker;
  /** A running task older than this retires its worker. Unset: no limit. */
  taskTimeoutMs?: number;
  /** A worker not `ready` this long after spawning is a failed start. Unset: no limit. */
  startTimeoutMs?: number;
  /** Respawn back-off after a worker dies without ever answering. */
  respawnBackoffMs?: { initial: number; max: number };
  /** Clock, injectable so back-off can be tested without sleeping. */
  now?: () => number;
}

export interface WorkerPoolPressure {
  active: number;
  queued: number;
  limit: number;
  queueLimit: number;
}

/**
 * Wire format. A worker posts `{ ready: true }` once, when it has loaded what
 * it needs. It then receives `{ id, payload }` and must answer with exactly one
 * `{ id, ok: true, value }` or `{ id, ok: false, message }` per task. Tasks
 * posted before `ready` wait in the worker's port; they are not lost.
 */
interface TaskReply {
  id: number;
  ok: boolean;
  value?: unknown;
  message?: unknown;
}

interface Task {
  id: number;
  payload: unknown;
  transfer: ArrayBuffer[];
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  task: Task | null;
  timer: NodeJS.Timeout | null;
  /** Has the worker said `{ ready: true }`? One that dies before that failed to start. */
  ready: boolean;
  retire: (reason: string) => void;
}

function isTaskReply(message: unknown): message is TaskReply {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { id?: unknown }).id === 'number' &&
    typeof (message as { ok?: unknown }).ok === 'boolean'
  );
}

function isReady(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { ready?: unknown }).ready === true
  );
}

const DEFAULT_BACKOFF ={ initial: 100, max: 30_000 };

export class WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Task[] = [];
  private nextId = 1;
  private closed = false;
  private startFailures = 0;
  private respawnAt = 0;
  private readonly now: () => number;

  constructor(private readonly options: WorkerPoolOptions) {
    if (!Number.isInteger(options.size) || options.size < 1) {
      throw new RangeError('WorkerPool size must be a positive integer');
    }
    if (!Number.isInteger(options.maxQueued) || options.maxQueued < 0) {
      throw new RangeError('WorkerPool maxQueued must be a non-negative integer');
    }
    this.now = options.now ?? Date.now;
  }

  /**
   * Runs one task on a worker.
   *
   * The returned promise is already rejected — no waiting — with
   * `WorkerPoolOverloadedError` when every worker is busy and the queue is
   * full (capacity is exactly `size + maxQueued`), and with
   * `WorkerPoolUnavailableError` when no worker is alive and the pool is
   * backing off from failed starts.
   */
  run<T>(payload: unknown, transfer: ArrayBuffer[] = []): Promise<T> {
    if (this.closed) {
      return Promise.reject(new WorkerPoolClosedError());
    }
    this.ensureWorkers();
    if (this.slots.length === 0) {
      return Promise.reject(new WorkerPoolUnavailableError());
    }
    const idle = this.slots.find((slot) => slot.task === null);
    if (idle === undefined && this.queue.length >= this.options.maxQueued) {
      return Promise.reject(new WorkerPoolOverloadedError());
    }

    return new Promise<T>((resolve, reject) => {
      const task: Task = {
        id: this.nextId,
        payload,
        transfer,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      this.nextId += 1;
      if (idle !== undefined) {
        this.assign(idle, task);
      } else {
        this.queue.push(task);
      }
    });
  }

  pressure(): WorkerPoolPressure {
    return {
      active: this.slots.filter((slot) => slot.task !== null).length,
      queued: this.queue.length,
      limit: this.options.size,
      queueLimit: this.options.maxQueued,
    };
  }

  /**
   * Rejects everything queued or running with `WorkerPoolClosedError` and
   * terminates every worker. Idempotent. Later `run` calls reject.
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    const error = new WorkerPoolClosedError();
    for (const task of this.queue.splice(0)) {
      task.reject(error);
    }
    const slots = this.slots.splice(0);
    for (const slot of slots) {
      this.clearTimer(slot);
      slot.task?.reject(error);
      slot.task = null;
    }
    await Promise.all(slots.map((slot) => slot.worker.terminate()));
  }

  // --- internals ---------------------------------------------------------

  /** Starts every worker on first use, and replaces dead ones unless backing off. */
  private ensureWorkers(): void {
    if (this.now() < this.respawnAt) {
      return;
    }
    while (this.slots.length < this.options.size) {
      this.slots.push(this.spawn());
    }
  }

  private spawn(): Slot {
    const worker = this.options.createWorker();
    const slot: Slot = {
      worker,
      task: null,
      timer: null,
      ready: false,
      retire: (reason) => this.retire(slot, reason),
    };

    worker.on('message', (message: unknown) => {
      if (!slot.ready && isReady(message)) {
        // Loaded and listening. Only now has the worker proved it can start,
        // so only now does the start-failure back-off reset.
        slot.ready = true;
        this.startFailures = 0;
        this.clearTimer(slot);
        if (slot.task !== null) {
          this.startTimer(slot, this.options.taskTimeoutMs, 'Worker task timed out');
        }
        return;
      }
      const task = slot.task;
      if (task === null || !isTaskReply(message) || message.id !== task.id) {
        // A reply nobody is waiting for is a protocol fault. It cannot be
        // routed — resolving the wrong caller with somebody else's result is
        // the one thing worse than failing — and a worker that sends one
        // cannot be trusted with the next task either.
        slot.retire('Worker sent an unexpected reply');
        return;
      }
      this.clearTimer(slot);
      slot.task = null;
      if (message.ok) {
        task.resolve(message.value);
      } else {
        task.reject(
          new WorkerTaskError(
            typeof message.message === 'string' ? message.message : 'Worker task failed',
          ),
        );
      }
      this.release(slot);
    });

    // The error's own message is deliberately not forwarded: it can carry
    // whatever the worker was handling, and the caller only needs to know the
    // task did not complete.
    worker.on('error', () => slot.retire('Worker failed while running a task'));
    worker.on('exit', () => slot.retire('Worker exited while running a task'));
    // AFTER the listeners: attaching a 'message' listener re-refs the worker's
    // port, so an unref done first is silently undone and a CLI that started
    // the pool never exits. (It hung, which is how this comment got here.)
    worker.unref();
    // A worker that never says `ready` (hung while loading) is retired as a
    // failed start, so it cannot hold a slot forever either.
    this.startTimer(slot, this.options.startTimeoutMs, 'Worker did not start in time');
    return slot;
  }

  private retire(slot: Slot, reason: string): void {
    const index = this.slots.indexOf(slot);
    if (index === -1) {
      return; // already retired, or shut down
    }
    this.slots.splice(index, 1);
    this.clearTimer(slot);
    const task = slot.task;
    slot.task = null;
    // Harmless if it already exited; essential if it is stuck or misbehaving.
    void slot.worker.terminate();
    task?.reject(new WorkerTaskError(reason));

    if (!slot.ready) {
      // Died before saying it was ready: a failed start. Back off, so a worker
      // that cannot load is not respawned on every request. A worker that was
      // ready and then died on a task is replaced at once — otherwise one bad
      // payload could stall the pool for everybody.
      this.startFailures += 1;
      const { initial, max } = this.options.respawnBackoffMs ?? DEFAULT_BACKOFF;
      this.respawnAt = this.now() + Math.min(max, initial * 2 ** (this.startFailures - 1));
    }

    // Queued work must not strand behind a worker that no longer exists.
    if (!this.closed && this.queue.length > 0) {
      this.ensureWorkers();
      if (this.slots.length === 0) {
        const unavailable = new WorkerPoolUnavailableError();
        for (const queued of this.queue.splice(0)) {
          queued.reject(unavailable);
        }
        return;
      }
      for (const idle of this.slots) {
        if (idle.task === null) {
          this.release(idle);
        }
      }
    }
  }

  /** A worker finished; hand it the next task, or let it idle. */
  private release(slot: Slot): void {
    const next = this.queue.shift();
    if (next === undefined) {
      slot.worker.unref();
      return;
    }
    this.assign(slot, next);
  }

  private assign(slot: Slot, task: Task): void {
    slot.task = task;
    slot.worker.ref();
    // A worker still starting is already under its start timer; the task's
    // own clock begins at `ready`, so a slow start is not billed to the task.
    if (slot.ready) {
      this.startTimer(slot, this.options.taskTimeoutMs, 'Worker task timed out');
    }
    slot.worker.postMessage({ id: task.id, payload: task.payload }, task.transfer);
  }

  /**
   * Arms the one timer a slot has: the start timer (spawn until `ready`) or
   * the task timer (`ready` or assignment until the reply), from
   * `startTimeoutMs` and `taskTimeoutMs` respectively; an unset one is no limit.
   */
  private startTimer(slot: Slot, timeout: number | undefined, reason: string): void {
    if (timeout === undefined) {
      return;
    }
    this.clearTimer(slot);
    slot.timer = setTimeout(() => slot.retire(reason), timeout);
    // Never the reason the process stays up: a ref'd busy worker already is.
    slot.timer.unref();
  }

  private clearTimer(slot: Slot): void {
    if (slot.timer !== null) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
  }
}
