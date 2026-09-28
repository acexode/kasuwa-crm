import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateTotpSecret, totpCode, verifyTotp } from './totp';

/**
 * RFC 6238 publishes test vectors against the ASCII secret '12345678901234567890'.
 * Checking against them is the only way to know this implementation agrees with
 * every authenticator app in the world rather than merely with itself.
 */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xff, 0xab, 0xcd]);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });

  it('ignores padding, whitespace and case, as authenticator apps print it', () => {
    const secret = base32Encode(Buffer.from('kasuwa', 'ascii'));
    expect(base32Decode(secret.toLowerCase()).toString('ascii')).toBe('kasuwa');
    expect(base32Decode(`${secret}====`).toString('ascii')).toBe('kasuwa');
  });

  it('refuses characters outside the alphabet', () => {
    expect(() => base32Decode('ABC1DEF')).toThrow(/base32/u);
  });
});

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    // The RFC prints eight digits; these are the low six of 94287082,
    // 07081804 and 89005924 respectively.
    expect(totpCode(RFC_SECRET, new Date(59_000))).toBe('287082');
    expect(totpCode(RFC_SECRET, new Date(1_111_111_109_000))).toBe('081804');
    expect(totpCode(RFC_SECRET, new Date(1_234_567_890_000))).toBe('005924');
  });

  it('accepts the current code', () => {
    const at = new Date(1_700_000_000_000);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, at), { at })).toBe(true);
  });

  it('accepts one step either side, for a phone with a drifting clock', () => {
    const at = new Date(1_700_000_000_000);
    const previous = totpCode(RFC_SECRET, new Date(at.getTime() - 30_000));
    const next = totpCode(RFC_SECRET, new Date(at.getTime() + 30_000));
    expect(verifyTotp(RFC_SECRET, previous, { at })).toBe(true);
    expect(verifyTotp(RFC_SECRET, next, { at })).toBe(true);
  });

  it('rejects a code two steps out', () => {
    const at = new Date(1_700_000_000_000);
    const stale = totpCode(RFC_SECRET, new Date(at.getTime() - 90_000));
    expect(verifyTotp(RFC_SECRET, stale, { at })).toBe(false);
  });

  it('rejects anything that is not exactly six digits, without hashing', () => {
    expect(verifyTotp(RFC_SECRET, '00000')).toBe(false);
    expect(verifyTotp(RFC_SECRET, '0000000')).toBe(false);
    expect(verifyTotp(RFC_SECRET, 'abcdef')).toBe(false);
    expect(verifyTotp(RFC_SECRET, '')).toBe(false);
  });

  it('rejects rather than throws on a malformed secret', () => {
    // A corrupt stored secret must deny like a wrong code, not 500.
    expect(verifyTotp('not-base32-!!', '123456')).toBe(false);
  });

  it('generates a 160-bit secret', () => {
    const secret = generateTotpSecret();
    expect(base32Decode(secret).length).toBe(20);
    expect(secret).not.toBe(generateTotpSecret());
  });
});
