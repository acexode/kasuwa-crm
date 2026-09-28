import { describe, expect, it } from 'vitest';
import { base32Encode, matchTotpStep, totpCode } from './totp';
import {
  hashPassword,
  HashingOverloadedError,
  hashPressure,
  verifyPassword,
} from './password';
import { hashRateLimitKey } from './tokens';

const SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('matchTotpStep — the basis for single-use codes', () => {
  it('returns the step a code matched, not just that it did', () => {
    const at = new Date(1_700_000_000_000);
    const step = Math.floor(at.getTime() / 1000 / 30);
    expect(matchTotpStep(SECRET, totpCode(SECRET, at), { at })).toBe(step);
  });

  it('distinguishes the steps inside the drift window', () => {
    // This is what makes replay detectable: without the step, all three codes
    // in the window look the same to the caller and a used code cannot be
    // told from a fresh one.
    const at = new Date(1_700_000_000_000);
    const step = Math.floor(at.getTime() / 1000 / 30);
    const previous = totpCode(SECRET, new Date(at.getTime() - 30_000));
    const next = totpCode(SECRET, new Date(at.getTime() + 30_000));

    expect(matchTotpStep(SECRET, previous, { at })).toBe(step - 1);
    expect(matchTotpStep(SECRET, next, { at })).toBe(step + 1);
  });

  it('returns null rather than a step for anything it rejects', () => {
    expect(matchTotpStep(SECRET, '000000', { at: new Date(1_700_000_000_000) })).toBeNull();
    expect(matchTotpStep(SECRET, 'abcdef')).toBeNull();
    expect(matchTotpStep('not-base32-!!', '123456')).toBeNull();
  });
});

describe('hashRateLimitKey', () => {
  it('takes no tenant id, which is the whole point', () => {
    // A counter keyed on a resolved tenant cannot exist for a workspace that
    // does not, so the fake workspace's countdown stands still and two requests
    // tell them apart. Keying on what was typed removes the branch.
    const real = hashRateLimitKey('signin', 'sahel-bpo', 'tunde.agent@tenant-a.test');
    const fake = hashRateLimitKey('signin', 'no-such-workspace', 'tunde.agent@tenant-a.test');
    expect(real.length).toBe(32);
    expect(fake.length).toBe(32);
    expect(real.equals(fake)).toBe(false);
  });

  it('separates purposes, so one control cannot consume another"s budget', () => {
    const signIn = hashRateLimitKey('signin', 'sahel-bpo', 'a@b.test');
    const mfa = hashRateLimitKey('mfa', 'sahel-bpo', 'a@b.test');
    expect(signIn.equals(mfa)).toBe(false);
  });

  it('folds case and whitespace, so typing variants share a counter', () => {
    const plain = hashRateLimitKey('signin', 'sahel-bpo', 'tunde@tenant-a.test');
    expect(hashRateLimitKey('signin', 'Sahel-BPO', ' Tunde@Tenant-A.test ').equals(plain)).toBe(
      true,
    );
  });

  it('contains none of the values it was built from', () => {
    const key = hashRateLimitKey('signin', 'sahel-bpo', 'tunde@tenant-a.test').toString('hex');
    expect(key).not.toContain(Buffer.from('sahel-bpo', 'utf8').toString('hex'));
    expect(key).not.toContain(Buffer.from('tunde@tenant-a.test', 'utf8').toString('hex'));
  });
});

describe('argon2id concurrency cap', () => {
  it('queues work past the limit instead of allocating for all of it', async () => {
    // 19 MiB per call, run for unknown addresses too because the timing has to
    // match. Unbounded, a few hundred concurrent sign-ins are gigabytes.
    const hash = await hashPassword('a-fixture-password');
    const limit = hashPressure().limit;

    let peakActive = 0;
    const observed: Promise<boolean>[] = [];
    for (let index = 0; index < limit * 3; index += 1) {
      observed.push(verifyPassword(hash, 'wrong'));
      peakActive = Math.max(peakActive, hashPressure().active);
    }

    expect(peakActive).toBeLessThanOrEqual(limit);
    expect(hashPressure().queued).toBeGreaterThan(0);

    const results = await Promise.all(observed);
    // Every one is still answered; the cap delays, it does not drop.
    expect(results).toHaveLength(limit * 3);
    expect(results.every((result) => result === false)).toBe(true);
    expect(hashPressure().active).toBe(0);
    expect(hashPressure().queued).toBe(0);
  });
});

describe('the hashing queue is bounded', () => {
  it('sheds rather than queueing without limit, and says so with its own error', async () => {
    // An unbounded queue turns the semaphore into the very thing it was meant
    // to prevent: requests that cannot be served yet still each pin an argon2
    // call and a pending promise for as long as the flood lasts. The API turns
    // this error into a 503, never a 401 — refusing to do the work is not the
    // same as deciding the password was wrong.
    const pressure = hashPressure();
    const flood = pressure.limit + pressure.queueLimit + 8;

    const results = await Promise.allSettled(
      Array.from({ length: flood }, () => hashPassword('a-fixture-password')),
    );

    const shed = results.filter(
      (result) =>
        result.status === 'rejected' && result.reason instanceof HashingOverloadedError,
    );
    const served = results.filter((result) => result.status === 'fulfilled');

    expect(shed.length, 'nothing was shed, so the queue is still unbounded').toBeGreaterThan(0);
    // And shedding must not become the answer for everything: the work the
    // process had capacity for still completed.
    expect(served.length).toBeGreaterThanOrEqual(pressure.limit);
    expect(shed.length + served.length).toBe(flood);
  });

  it('drains back to idle afterwards, leaving no slot or waiter behind', async () => {
    await hashPassword('a-fixture-password');
    const pressure = hashPressure();
    expect(pressure.active).toBe(0);
    expect(pressure.queued).toBe(0);
  });
});
