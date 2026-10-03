import { randomBytes, randomFillSync, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { WorkerPool, WorkerPoolOverloadedError } from './worker-pool';

/**
 * Password hashing — argon2id (founding pack 3.11).
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet's argon2id profile:
 * 19 MiB of memory, two iterations, one lane. Memory-hard rather than merely
 * slow, which is the point of argon2 over PBKDF2: a GPU farm gains far less.
 *
 * They are encoded in the PHC string alongside the hash, so raising them later
 * is a code change and a re-hash on next sign-in — never a migration.
 *
 * WHY hash-wasm RATHER THAN A NATIVE BINDING. `argon2` and `@node-rs/argon2`
 * ship native binaries, and Windows Smart App Control on the current
 * development machine blocks unsigned native binaries — the same problem that
 * forced the rollup WASM pin (D-L20). A WASM implementation is portable, has no
 * install-time compiler step, and is fast enough at these parameters. If the
 * pin is ever lifted and agents run in a devcontainer, a native argon2 is a
 * drop-in improvement worth making.
 */

const MEMORY_KIB = 19_456;
const ITERATIONS = 2;
const PARALLELISM = 1;
const HASH_LENGTH = 32;
const SALT_LENGTH = 16;

/**
 * WHERE THE HASH RUNS, AND WHY IT MOVED (T-0013).
 *
 * `hash-wasm`'s argon2id runs synchronously on whatever thread calls it. A
 * security review measured it on the main thread: ~86 ms per hash with the
 * event loop stopped for all of it, six concurrent = 464 ms fully serialised.
 * Every unauthenticated sign-in froze the whole API for every tenant in the
 * cell, and about a dozen source addresses could keep it frozen with no
 * account, no workspace and no password.
 *
 * So every hash and verify now runs on a worker thread (`worker-pool.ts`). The
 * main thread posts the password, the salt and the parameters, and awaits the
 * answer. The parameters are unchanged and still live here, in one place; the
 * worker only forwards them.
 *
 * THE BOUNDS
 *
 *   * Concurrency = the number of workers, sized from the CPU count: one per
 *     core with one left for the main thread, between 1 and
 *     `MAX_HASH_WORKERS`. Each worker runs one hash at a time, so this is also
 *     the bound on live 19 MiB argon2 buffers. It replaces the semaphore that
 *     used to sit here, which bounded nothing while the hash was synchronous.
 *   * Queue = `MAX_QUEUED_HASHES`. Past that, a caller is refused at once with
 *     `HashingOverloadedError` (the API answers 503) rather than queueing
 *     without limit.
 *
 * Both paths — real account and dummy hash — go through this same pool, in
 * the same queue, with the same parameters, so queueing cannot reintroduce a
 * timing difference between them.
 */
const MAX_HASH_WORKERS = 4;

function hashWorkerCount(): number {
  return Math.min(MAX_HASH_WORKERS, Math.max(1, availableParallelism() - 1));
}

/**
 * How many callers may wait for a worker before the next one is refused.
 *
 * Capacity is workers + this, so at least 33 even on a single-core node. The
 * floor that matters is sixteen: a BPO shift change is dozens of agents signing
 * in inside a minute, and sixteen concurrent sign-ins drawing a 503 would be an
 * outage we built ourselves (the T-0013 acceptance suite pins it). The ceiling
 * matters too: a queued task is a held socket and a pending promise, and at
 * ~86 ms a hash, thirty-two queued on one worker is already ~3 s of waiting.
 */
const MAX_QUEUED_HASHES = 32;

/**
 * Thrown when the queue is full. The API turns it into a 503, NOT a 401:
 * refusing to do the work is not the same as deciding the credentials were
 * wrong, and answering 401 here would both mislead the caller and — because
 * shedding is cheap and verification is not — hand an attacker a fast oracle
 * for "this request never reached argon2".
 */
export class HashingOverloadedError extends Error {
  constructor() {
    super('Password hashing is at capacity');
    this.name = 'HashingOverloadedError';
  }
}

/**
 * The worker body. Plain CommonJS, run with `eval: true` so the same code works
 * under vitest, tsx and the esbuild bundle without a separately compiled file.
 * It loads `hash-wasm` from an absolute path the main thread resolved, does
 * exactly what it is told, and answers once per task.
 *
 * It never echoes the password or a library error message back: the reply is
 * the result, or a fixed string.
 */
const ARGON2_WORKER_SOURCE = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { argon2id, argon2Verify } = require(workerData.hashWasmPath);
parentPort.on('message', async ({ id, payload }) => {
  try {
    if (payload.op === 'hash') {
      const value = await argon2id({
        password: payload.password,
        salt: new Uint8Array(payload.salt),
        memorySize: payload.memorySize,
        iterations: payload.iterations,
        parallelism: payload.parallelism,
        hashLength: payload.hashLength,
        outputType: 'encoded',
      });
      parentPort.postMessage({ id, ok: true, value });
    } else if (payload.op === 'verify') {
      let value;
      try {
        value = await argon2Verify({ password: payload.password, hash: payload.hash });
      } catch {
        // A stored hash that cannot be parsed denies, like a wrong password.
        value = false;
      }
      parentPort.postMessage({ id, ok: true, value: value === true });
    } else {
      parentPort.postMessage({ id, ok: false, message: 'unknown operation' });
    }
  } catch {
    parentPort.postMessage({ id, ok: false, message: 'argon2 failed' });
  }
});
`;

/**
 * Where the worker loads `hash-wasm` from.
 *
 * Resolved on the main thread, where module resolution knows this package's
 * dependencies; an eval worker resolves bare specifiers from the working
 * directory, which under pnpm does not see them. A bundled build (esbuild,
 * `apps/api` `build`) has no `node_modules` beside it, so the build emits a
 * self-contained copy as `hash-wasm.cjs` next to the bundle, and that wins when
 * present. If neither exists the worker fails to start and every hash rejects
 * — loudly, as a 500 — rather than quietly falling back to the main thread.
 */
function hashWasmPath(): string {
  const bundled = join(__dirname, 'hash-wasm.cjs');
  // `createRequire` rather than `require.resolve`, which esbuild flags in
  // every bundle that includes this file; the result is the same.
  return existsSync(bundled) ? bundled : createRequire(__filename).resolve('hash-wasm');
}

let pool: WorkerPool | undefined;

function hashPool(): WorkerPool {
  if (pool === undefined) {
    const workerData = { hashWasmPath: hashWasmPath() };
    pool = new WorkerPool({
      size: hashWorkerCount(),
      maxQueued: MAX_QUEUED_HASHES,
      createWorker: () => new Worker(ARGON2_WORKER_SOURCE, { eval: true, workerData }),
    });
  }
  return pool;
}

async function runOnPool(payload: unknown, transfer: ArrayBuffer[] = []): Promise<unknown> {
  try {
    return await hashPool().run<unknown>(payload, transfer);
  } catch (error) {
    if (error instanceof WorkerPoolOverloadedError) {
      throw new HashingOverloadedError();
    }
    throw error;
  }
}

/** Test and diagnostic hook: how many hashes are in flight or waiting. */
export function hashPressure(): {
  active: number;
  queued: number;
  limit: number;
  queueLimit: number;
} {
  return (
    pool?.pressure() ?? {
      active: 0,
      queued: 0,
      limit: hashWorkerCount(),
      queueLimit: MAX_QUEUED_HASHES,
    }
  );
}

/**
 * Terminates the hashing workers. Anything queued or running rejects. The next
 * hash starts a fresh pool, so this is safe to call from a test or a shutdown
 * hook in a process that may hash again.
 *
 * Idle workers are already `unref`ed and do not hold a process open, so nothing
 * HAS to call this for a CLI to exit. The API deliberately does not call it on
 * application shutdown: the pool is process-wide, and tests boot several
 * applications in one process.
 */
export async function shutdownPasswordHashing(): Promise<void> {
  const closing = pool;
  pool = undefined;
  await closing?.shutdown();
}

export async function hashPassword(password: string): Promise<string> {
  // A dedicated ArrayBuffer holding exactly the salt, so it can be transferred
  // rather than copied — and not `randomBytes`, whose small Buffers are slices
  // of a shared pool that must never cross the thread boundary whole.
  const saltBuffer = new ArrayBuffer(SALT_LENGTH);
  randomFillSync(new Uint8Array(saltBuffer));
  const encoded = await runOnPool(
    {
      op: 'hash',
      password,
      salt: saltBuffer,
      memorySize: MEMORY_KIB,
      iterations: ITERATIONS,
      parallelism: PARALLELISM,
      hashLength: HASH_LENGTH,
    },
    [saltBuffer],
  );
  if (typeof encoded !== 'string' || !encoded.startsWith('$argon2id$')) {
    // Never store something that is not a PHC string; an unverifiable
    // credential row is a locked-out user discovered much later.
    throw new Error('argon2 worker returned an unexpected result');
  }
  return encoded;
}

/**
 * Verifies a password against a stored PHC string.
 *
 * Returns false rather than throwing on a malformed or corrupt hash. A stored
 * hash we cannot parse must deny, and it must deny in the same shape as a wrong
 * password — an exception here would surface as a 500 and tell an attacker that
 * this particular account exists and is in an unusual state.
 *
 * That swallowing happens INSIDE the worker, around the library call only.
 * `HashingOverloadedError` (the queue was full) and a worker failure must
 * escape: turning "we refused to do the work" into "the password was wrong" is
 * both a lie to the caller and a cheap oracle for whether a request reached
 * argon2.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  // Only a literal `true` from the worker is a match; anything else denies.
  return (await runOnPool({ op: 'verify', password, hash })) === true;
}

/**
 * A hash of a value nobody knows, verified against when no user was found.
 *
 * This is the whole defence against user enumeration by timing. Returning early
 * for an unknown email skips argon2id entirely, and the difference between
 * "about 20 ms of memory-hard work" and "one index lookup" is measurable over a
 * network — repeat it a few times and an attacker has a list of your real
 * addresses. Verifying an unknown email against this hash costs the same as
 * verifying a real one against a real hash, and always fails.
 *
 * Computed once, lazily, from fresh randomness: there is no constant here that
 * could ever be mistaken for a credential or checked into the repository.
 */
let dummyHash: Promise<string> | undefined;

export function dummyPasswordHash(): Promise<string> {
  if (dummyHash === undefined) {
    const pending = hashPassword(randomBytes(32).toString('base64'));
    dummyHash = pending;
    // A FAILED dummy hash must not be cached. If the very first unknown-user
    // sign-in after boot landed on a full queue, caching its rejection would
    // make every later unknown-user sign-in fail with a 503 while known users
    // still got 401 — a permanent outage for one branch, and a clean
    // enumeration oracle between the two.
    pending.catch(() => {
      if (dummyHash === pending) {
        dummyHash = undefined;
      }
    });
  }
  return dummyHash;
}

/** Constant-time comparison of two short ASCII strings (codes, hashes). */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // timingSafeEqual throws on a length mismatch, and the length of a rejected
    // six-digit code is not a secret worth padding for.
    return false;
  }
  return timingSafeEqual(left, right);
}
