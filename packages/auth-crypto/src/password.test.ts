import { describe, expect, it } from 'vitest';
import {
  constantTimeEquals,
  dummyPasswordHash,
  hashPassword,
  verifyPassword,
} from './password';

describe('password hashing', () => {
  it('produces an argon2id PHC string, never the password', async () => {
    const hash = await hashPassword('a-fixture-password-nobody-uses');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('a-fixture-password-nobody-uses');
  });

  it('salts, so the same password twice gives different hashes', async () => {
    const [first, second] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(first).not.toBe(second);
    // Both still verify: the salt lives in the PHC string.
    expect(await verifyPassword(first, 'same')).toBe(true);
    expect(await verifyPassword(second, 'same')).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('right');
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('denies rather than throws on a corrupt stored hash', async () => {
    // A hash we cannot parse must deny, and must deny in the same shape as a
    // wrong password. Throwing here would surface as a 500 and single that
    // account out.
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
    expect(await verifyPassword('', 'anything')).toBe(false);
  });

  it('gives a stable dummy hash that nothing verifies against', async () => {
    const dummy = await dummyPasswordHash();
    expect(await dummyPasswordHash()).toBe(dummy);
    expect(dummy.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(dummy, '')).toBe(false);
    expect(await verifyPassword(dummy, 'password')).toBe(false);
  });

  it('costs about the same to verify a dummy hash as a real one', async () => {
    // This is the property that stops sign-in timing from naming real
    // addresses. Generous by design: it catches "no hashing at all", not
    // scheduler jitter.
    const real = await hashPassword('a-real-one');
    const dummy = await dummyPasswordHash();

    const time = async (hash: string) => {
      const started = performance.now();
      await verifyPassword(hash, 'wrong-either-way');
      return performance.now() - started;
    };

    const realMs = Math.max(await time(real), 1);
    const dummyMs = Math.max(await time(dummy), 1);
    expect(Math.max(realMs, dummyMs) / Math.min(realMs, dummyMs)).toBeLessThan(3);
  });
});

describe('constantTimeEquals', () => {
  it('compares equal strings as equal', () => {
    expect(constantTimeEquals('123456', '123456')).toBe(true);
  });

  it('rejects different strings and different lengths without throwing', () => {
    expect(constantTimeEquals('123456', '123457')).toBe(false);
    expect(constantTimeEquals('123456', '1234567')).toBe(false);
    expect(constantTimeEquals('', 'x')).toBe(false);
  });
});
