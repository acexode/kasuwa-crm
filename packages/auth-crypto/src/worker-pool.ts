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

/** The task ran and failed, or the worker running it died. */
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
}

export interface WorkerPoolPressure {
  active: number;
  queued: number;
  limit: number;
  queueLimit: number;
}

/**
 * Wire format. A worker receives `{ id, payload }` and must answer with exactly
 * one `{ id, ok: true, value }` or `{ id, ok: false, message }` per task.
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
}

function isTaskReply(message: unknown): message is TaskReply {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { id?: unknown }).id === 'number' &&
    typeof (message as { ok?: unknown }).ok === 'boolean'
  );
}

export class WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Task[] = [];
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: WorkerPoolOptions) {
    if (!Number.isInteger(options.size) || options.size < 1) {
      throw new RangeError('WorkerPool size must be a positive integer');
    }
    if (!Number.isInteger(options.maxQueued) || options.maxQueued < 0) {
      throw new RangeError('WorkerPool maxQueued must be a non-negative integer');
    }
  }

  /**
   * Runs one task on a worker.
   *
   * Throws `WorkerPoolOverloadedError` SYNCHRONOUSLY-in-effect (the returned
   * promise is already rejected) when every worker is busy and the queue is
   * full. The check counts the task it is about to queue, so capacity is
   * exactly `size + maxQueued`.
   */
  run<T>(payload: unknown, transfer: ArrayBuffer[] = []): Promise<T> {
    if (this.closed) {
      return Promise.reject(new WorkerPoolClosedError());
    }
    this.ensureWorkers();
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
      slot.task?.reject(error);
      slot.task = null;
    }
    await Promise.all(slots.map((slot) => slot.worker.terminate()));
  }

  // --- internals ---------------------------------------------------------

  /** Starts every worker on first use, and replaces any that died. */
  private ensureWorkers(): void {
    while (this.slots.length < this.options.size) {
      this.slots.push(this.spawn());
    }
  }

  private spawn(): Slot {
    const worker = this.options.createWorker();
    const slot: Slot = { worker, task: null };

    worker.on('message', (message: unknown) => {
      const task = slot.task;
      if (task === null || !isTaskReply(message) || message.id !== task.id) {
        // A reply nobody is waiting for: a protocol fault in the worker. It
        // cannot be routed, so it is dropped rather than resolving the wrong
        // caller's promise with somebody else's result.
        return;
      }
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

    const retire = (reason: string): void => {
      const index = this.slots.indexOf(slot);
      if (index === -1) {
        return; // already retired, or shut down
      }
      this.slots.splice(index, 1);
      const task = slot.task;
      slot.task = null;
      task?.reject(new WorkerTaskError(reason));
      // Queued work must not strand behind a worker that no longer exists.
      if (!this.closed && this.queue.length > 0) {
        this.ensureWorkers();
        for (const idle of this.slots) {
          if (idle.task === null) {
            this.release(idle);
          }
        }
      }
    };

    // The error's own message is deliberately not forwarded: it can carry
    // whatever the worker was handling, and the caller only needs to know the
    // task did not complete.
    worker.on('error', () => retire('Worker failed while running a task'));
    worker.on('exit', () => retire('Worker exited while running a task'));
    // AFTER the listeners: attaching a 'message' listener re-refs the worker's
    // port, so an unref done first is silently undone and a CLI that started
    // the pool never exits. (It hung, which is how this comment got here.)
    worker.unref();
    return slot;
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
    slot.worker.postMessage({ id: task.id, payload: task.payload }, task.transfer);
  }
}
