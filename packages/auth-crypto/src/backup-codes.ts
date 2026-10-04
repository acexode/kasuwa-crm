import { createHmac, randomInt } from 'node:crypto';

/**
 * MFA backup codes (T-0012): generation, normalisation and the keyed hash.
 *
 * FORMAT. Ten codes, each ten characters from a 31-symbol alphabet, shown as
 * two groups of five (`k7m2q-x9tfa`). The reasoning:
 *
 *   * ~49 bits per code. A code is guessed online only, behind the same
 *     per-challenge (5) and per-user (10 per 15 minutes) counters as a TOTP
 *     code, so the attacker's budget is a few thousand guesses a year against
 *     ten live targets — a success probability around 2^-34. Longer codes buy
 *     nothing but transcription errors.
 *   * No `0 o 1 l i`: these get written on paper and typed back from it.
 *   * Lower case, case-insensitive on input, hyphen and spaces ignored. A
 *     recovery code is typed by someone who has already lost their phone; the
 *     form should not fight them.
 *   * Never six digits, so a backup code can never be confused with a TOTP
 *     code at the same input, and a code typed into the wrong field fails as
 *     a wrong code rather than succeeding somewhere unexpected.
 *   * Ten, because that is what people expect from every other service, and it
 *     is enough to recover twice and still regenerate.
 *
 * STORAGE. The code is never stored. `hashBackupCode` is HMAC-SHA256 under a
 * data key that the caller obtains from the KeyProvider (D-L13) and stores only
 * wrapped. That is a keyed hash, which is what the lead's ruling allows, and it
 * is chosen over argon2id deliberately: verifying a submitted code means
 * checking it against every unused code the user has, and argon2id at the
 * password parameters runs ~86 ms synchronously on the event loop — about 0.9 s
 * of a stalled API per attempt for a set of ten. With 49 bits of entropy per
 * code, a slow hash defends against nothing a key does not already defend
 * against: without the KMS key a stolen table offers nothing to test guesses
 * against, and with it 2^49 HMACs per code is still not a realistic search.
 *
 * Nothing here logs, and nothing here may: every value in this file is a
 * credential.
 */

/** No 0/o, 1/l/i. 31 symbols. */
export const BACKUP_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const BACKUP_CODE_COUNT = 10;
export const BACKUP_CODE_LENGTH = 10;

/** The on-disk format marker stored per row: HMAC-SHA256 under an enveloped key, v1. */
export const BACKUP_CODE_HASH_ALGORITHM = 'HS256-ENV1';

/** One code, `xxxxx-xxxxx`. */
export function generateBackupCode(): string {
  let raw = '';
  for (let index = 0; index < BACKUP_CODE_LENGTH; index += 1) {
    // randomInt is uniform (rejection-sampled), so no symbol is favoured.
    raw += BACKUP_CODE_ALPHABET[randomInt(BACKUP_CODE_ALPHABET.length)];
  }
  const half = BACKUP_CODE_LENGTH / 2;
  return `${raw.slice(0, half)}-${raw.slice(half)}`;
}

/** A full set of distinct codes. */
export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    codes.add(generateBackupCode());
  }
  return [...codes];
}

/**
 * The canonical form a code is hashed in: lower case, separators and spaces
 * removed. Returns null for anything that cannot be a backup code, so a
 * malformed submission never reaches the HMAC.
 */
export function normaliseBackupCode(input: string): string | null {
  const bare = input.replace(/[\s-]/gu, '').toLowerCase();
  if (bare.length !== BACKUP_CODE_LENGTH) {
    return null;
  }
  for (const character of bare) {
    if (!BACKUP_CODE_ALPHABET.includes(character)) {
      return null;
    }
  }
  return bare;
}

/**
 * The stored form of one code.
 *
 * Bound to the tenant and the user, so a hash copied onto another user's row
 * matches nothing. `key` is a 32-byte data key from `KeyProvider`; the caller
 * zeroes it when done. Throws on a malformed code: callers normalise first.
 */
export function hashBackupCode(
  key: Buffer,
  tenantId: string,
  userId: string,
  code: string,
): Buffer {
  const normalised = normaliseBackupCode(code);
  if (normalised === null) {
    throw new Error('hashBackupCode: not a backup code');
  }
  return createHmac('sha256', key)
    .update(`user_mfa_backup_code:${tenantId}:${userId}:${normalised}`, 'utf8')
    .digest();
}
