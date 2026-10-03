import { describe, expect, it, vi } from 'vitest';
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

describe('password hashing off the event loop (T-0013)', () => {
  it('keeps the event loop turning while a hash runs', async () => {
    // The property, measured. With argon2id on the main thread this thread
    // gets at most one tick per hash (the T-0013 measurement: 1 tick in 86 ms);
    // on a worker it gets dozens. Several hashes so a fast machine cannot
    // finish inside a handful of ticks anyway.
    await hashPassword('warm-the-workers');
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    const started = performance.now();
    try {
      await Promise.all([hashPassword('one'), hashPassword('two'), hashPassword('three')]);
    } finally {
      clearInterval(timer);
    }
    const elapsed = performance.now() - started;
    // A blocked loop manages ~0 ticks in total (measured: 0 against the
    // main-thread implementation). The threshold is deliberately loose — one
    // tick per 40 ms — because Windows timers can be as coarse as ~16 ms and
    // other test files share the CPU; it only has to separate dozens from none.
    expect(ticks).toBeGreaterThanOrEqual(Math.max(3, Math.floor(elapsed / 40)));
  });

  it('writes the unchanged argon2id parameters', async () => {
    expect(await hashPassword('parameters')).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
  });

  it('verifies a hash written before the move to a worker', async () => {
    // A fixed vector produced by the main-thread implementation (the same one
    // the T-0013 acceptance suite pins). Every stored credential is one of
    // these; if it stops verifying, a deploy locks everybody out.
    const legacy =
      '$argon2id$v=19$m=19456,t=2,p=1$a2FzdXdhLXQwMDEzLXNsdA$fsuclpjg4utgztGHSjdVA8cslilj2/aeNvWU0rz8YxM';
    expect(await verifyPassword(legacy, 't0013-legacy-probe-not-a-real-password')).toBe(true);
    expect(await verifyPassword(legacy, 'not-it')).toBe(false);
  });

  it('does not cache a dummy hash that failed, so one overload cannot poison every later sign-in', async () => {
    // A fresh module instance: a fresh pool and no cached dummy hash.
    vi.resetModules();
    const fresh = await import('./password');
    try {
      const { limit, queueLimit } = fresh.hashPressure();
      const flood = Array.from({ length: limit + queueLimit }, () =>
        fresh.hashPassword('flood'),
      );
      await expect(fresh.dummyPasswordHash()).rejects.toBeInstanceOf(
        fresh.HashingOverloadedError,
      );
      await Promise.all(flood);
      const dummy = await fresh.dummyPasswordHash();
      expect(dummy.startsWith('$argon2id$')).toBe(true);
    } finally {
      await fresh.shutdownPasswordHashing();
    }
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
