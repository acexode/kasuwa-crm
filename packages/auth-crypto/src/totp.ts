import { createHmac, randomBytes } from 'node:crypto';
import { constantTimeEquals } from './password';

/**
 * TOTP (RFC 6238) over HMAC-SHA1, six digits, thirty-second steps.
 *
 * Hand-written rather than pulled from a package: it is forty lines of
 * arithmetic against a published test vector, and a dependency in the
 * authentication path is a supply-chain surface for no benefit.
 *
 * SHA-1 here is not a weakness. HOTP uses HMAC-SHA1, whose security does not
 * rest on collision resistance, and every authenticator app in the world
 * implements it. Choosing SHA-256 would be more "modern" and would render the
 * enrolment QR unusable in most apps.
 */

const DIGITS = 6;
const STEP_SECONDS = 30;

/**
 * Accept the previous and next step as well as the current one.
 *
 * Phone clocks drift and people start typing at second 29. One step either side
 * is the standard trade: a 90-second window in exchange for an OTP form that
 * does not reject correct codes. Widening it further starts to matter.
 */
const DEFAULT_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding, case-insensitive. Throws on a bad character. */
export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/=+$/u, '').replace(/\s+/gu, '').toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const character of cleaned) {
    const value = BASE32_ALPHABET.indexOf(character);
    if (value === -1) {
      throw new Error('Invalid base32 character in TOTP secret');
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return Buffer.from(bytes);
}

export function base32Encode(input: Buffer): string {
  let output = '';
  let buffer = 0;
  let bits = 0;

  for (const byte of input) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(buffer >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  }
  return output;
}

/** A fresh 160-bit TOTP secret, base32-encoded, as authenticator apps expect. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The six-digit code for a base32 secret at a point in time. */
export function totpCode(secret: string, at: Date = new Date()): string {
  return hotp(base32Decode(secret), Math.floor(at.getTime() / 1000 / STEP_SECONDS));
}

/**
 * Verifies a submitted code and returns the step it matched, or null.
 *
 * The step is returned rather than a boolean because a code must be usable
 * ONCE, not for the whole ninety seconds it stays arithmetically valid. The
 * caller records the step it accepted and refuses anything at or below it
 * afterwards, which is what stops a code seen over a shoulder, in a screen
 * share or in a phishing form being replayed while the victim is still typing.
 *
 * Compares in constant time and rejects anything that is not exactly six
 * digits before doing any work, so a malformed code cannot reach the HMAC.
 */
export function matchTotpStep(
  secret: string,
  code: string,
  options: { at?: Date; window?: number } = {},
): number | null {
  if (!/^[0-9]{6}$/u.test(code)) {
    return null;
  }

  const at = options.at ?? new Date();
  const window = options.window ?? DEFAULT_WINDOW;
  const counter = Math.floor(at.getTime() / 1000 / STEP_SECONDS);

  let key: Buffer;
  try {
    key = base32Decode(secret);
  } catch {
    return null;
  }

  let matched: number | null = null;
  for (let offset = -window; offset <= window; offset += 1) {
    // No early return: checking every step regardless keeps the time taken
    // independent of WHICH step matched, so the response cannot be used to
    // measure a phone's clock offset.
    if (constantTimeEquals(hotp(key, counter + offset), code)) {
      matched = counter + offset;
    }
  }
  return matched;
}

/** Whether a code is arithmetically valid, ignoring single use. */
export function verifyTotp(
  secret: string,
  code: string,
  options: { at?: Date; window?: number } = {},
): boolean {
  return matchTotpStep(secret, code, options) !== null;
}

/** HOTP (RFC 4226) with dynamic truncation. */
function hotp(key: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', key).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}
