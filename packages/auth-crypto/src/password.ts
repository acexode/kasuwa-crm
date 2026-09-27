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

export async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(SALT_LENGTH),
    memorySize: MEMORY_KIB,
    iterations: ITERATIONS,
    parallelism: PARALLELISM,
    hashLength: HASH_LENGTH,
    outputType: 'encoded',
  });
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
  try {
    return await argon2Verify({ password, hash });
  } catch {
    return false;
  }
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
