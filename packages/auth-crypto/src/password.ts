import { randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';

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
 * How many argon2id buffers may be live at once, process-wide.
 *
 * READ THIS BEFORE RELYING ON IT. An earlier version of this comment called it
 * "the bound that actually protects the cell". It is not, and a security
 * review measured why: `hash-wasm`'s argon2id at these parameters runs
 * **synchronously on the main thread** — about 86 ms per hash on the
 * development machine, during which the event loop does not turn. Six
 * concurrent hashes took 464 ms and were fully serialised.
 *
 * So the real concurrency was already one, and this semaphore does not reduce
 * peak memory below what the runtime would have allowed. What it does:
 *
 *   * it bounds how many 19 MiB buffers can be ALLOCATED AND LIVE at once if
 *     the implementation ever becomes genuinely concurrent (a worker thread, or
 *     a native binding that releases the loop), and
 *   * it makes the queue explicit and observable via `hashPressure()`.
 *
 * What it does NOT do, and what nothing in this package currently does:
 *
 *   * it does not bound event-loop blocking. **Each unauthenticated sign-in
 *     makes the single-threaded API unresponsive for ~86 ms**, so on the order
 *     of a dozen source addresses can stall a whole cell with no account, no
 *     valid workspace slug and no credentials.
 *   * the hash also runs inside an open `withAuthTransaction`, so that traffic
 *     holds a pool connection for the duration as well.
 *
 * The real fix is argon2 on a worker thread, and moving the hash outside the
 * open transaction. That is a threading change, it is raised as its own task,
 * and it deliberately did not happen in T-0001. The per-client throttle in
 * `apps/api` is what stands in front of this in the meantime, and it is a
 * weaker control than it sounds — see `SignInThrottleGuard`.
 *
 * Both paths — real account and dummy hash — go through this same gate, so the
 * queueing cannot reintroduce a timing difference between them.
 */
const MAX_CONCURRENT_HASHES = 6;

let activeHashes = 0;
const hashQueue: (() => void)[] = [];

async function withHashSlot<T>(work: () => Promise<T>): Promise<T> {
  // `while`, not `if`. A woken waiter used to take a slot without re-checking,
  // so two resolutions landing in the same microtask could both proceed and
  // push the count past the maximum — making the invariant this file asserts
  // quietly false. The window is tiny and there is no exploit in it; the point
  // is that a comment claiming a bound should not be defeated by the code
  // underneath it.
  while (activeHashes >= MAX_CONCURRENT_HASHES) {
    await new Promise<void>((resolve) => hashQueue.push(resolve));
  }
  activeHashes += 1;
  try {
    return await work();
  } finally {
    activeHashes -= 1;
    hashQueue.shift()?.();
  }
}

/** Test and diagnostic hook: how many hashes are in flight or waiting. */
export function hashPressure(): { active: number; queued: number; limit: number } {
  return { active: activeHashes, queued: hashQueue.length, limit: MAX_CONCURRENT_HASHES };
}

export async function hashPassword(password: string): Promise<string> {
  return withHashSlot(async () =>
    argon2id({
      password,
      salt: randomBytes(SALT_LENGTH),
      memorySize: MEMORY_KIB,
      iterations: ITERATIONS,
      parallelism: PARALLELISM,
      hashLength: HASH_LENGTH,
      outputType: 'encoded',
    }),
  );
}

/**
 * Verifies a password against a stored PHC string.
 *
 * Returns false rather than throwing on a malformed or corrupt hash. A stored
 * hash we cannot parse must deny, and it must deny in the same shape as a wrong
 * password — an exception here would surface as a 500 and tell an attacker that
 * this particular account exists and is in an unusual state.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return withHashSlot(async () => {
    try {
      return await argon2Verify({ password, hash });
    } catch {
      return false;
    }
  });
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
  dummyHash ??= hashPassword(randomBytes(32).toString('base64'));
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
