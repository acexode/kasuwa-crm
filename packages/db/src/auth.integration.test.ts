import { createPool } from './pool';
import {
  clearAuthFailures,
  readAuthLock,
  registerAuthFailure,
  type RateLimitPolicy,
} from './auth';
import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

/**
 * The rate-limit primitive, on its own.
 *
 * It sits underneath every lockout in the system, and the first version of it
 * was wrong in a way no end-to-end test noticed: a read-modify-write in
 * application code that simply lost increments under concurrency, so the
 * threshold was never reached and nothing ever locked. Testing it here rather
 * than only through the API means the next such failure names the counter
 * instead of appearing as an unrelated assertion four layers up.
 */

const LIMITS: RateLimitPolicy = { maxAttempts: 5, windowMinutes: 15, lockMinutes: 15 };

function key(label: string): Buffer {
  return createHash('sha256').update(`auth.integration.test:${label}`, 'utf8').digest();
}

describe('the authentication rate-limit store', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 10 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    const client = new Client({ connectionString: inject('migrationUrl') });
    await client.connect();
    try {
      await client.query('TRUNCATE TABLE auth_rate_limit');
    } finally {
      await client.end();
    }
  });

  /** The store is deliberately not tenant-scoped, so a plain pool is its caller. */
  const tx = {
    query: async <T extends QueryResultRow>(
      sql: string,
      values: readonly unknown[] = [],
    ): Promise<T[]> => (await pool.query<T>(sql, values as unknown[])).rows,
  };

  it('counts consecutive failures one at a time', async () => {
    const target = key('sequential');
    expect((await registerAuthFailure(tx, target, LIMITS)).failedCount).toBe(1);
    expect((await registerAuthFailure(tx, target, LIMITS)).failedCount).toBe(2);
    expect((await registerAuthFailure(tx, target, LIMITS)).failedCount).toBe(3);
  });

  it('keys counters separately, so one identifier cannot lock another', async () => {
    await registerAuthFailure(tx, key('a'), LIMITS);
    await registerAuthFailure(tx, key('a'), LIMITS);
    expect((await registerAuthFailure(tx, key('b'), LIMITS)).failedCount).toBe(1);
  });

  it('sets the lock in the same statement that reaches the threshold', async () => {
    const target = key('locks');
    for (let attempt = 1; attempt < LIMITS.maxAttempts; attempt += 1) {
      expect((await registerAuthFailure(tx, target, LIMITS)).lockedUntil).toBeNull();
    }
    const final = await registerAuthFailure(tx, target, LIMITS);
    expect(final.failedCount).toBe(LIMITS.maxAttempts);
    expect(final.lockedUntil).not.toBeNull();

    const lock = await readAuthLock(tx, target);
    expect(lock?.lockedUntil).not.toBeNull();
  });

  it('loses no increment when failures arrive concurrently', async () => {
    // The regression that matters. Ten parallel failures against one key must
    // count ten, not one: under READ COMMITTED a read-modify-write in the
    // application reads the same value ten times and writes it back ten times,
    // and the lockout silently never fires.
    const target = key('concurrent');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => registerAuthFailure(tx, target, LIMITS)),
    );

    const counts = results.map((result) => result.failedCount).sort((a, b) => a - b);
    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const lock = await readAuthLock(tx, target);
    expect(lock, 'ten concurrent failures past a threshold of five must lock').not.toBeNull();
  });

  it('forgets a key when the factor it guards succeeds', async () => {
    const target = key('cleared');
    await registerAuthFailure(tx, target, LIMITS);
    await registerAuthFailure(tx, target, LIMITS);
    await clearAuthFailures(tx, target);
    expect((await registerAuthFailure(tx, target, LIMITS)).failedCount).toBe(1);
  });

  it('does not lock at all when the threshold is zero', async () => {
    const target = key('disabled');
    const disabled: RateLimitPolicy = { ...LIMITS, maxAttempts: 0 };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await registerAuthFailure(tx, target, disabled)).lockedUntil).toBeNull();
    }
    expect(await readAuthLock(tx, target)).toBeNull();
  });
});
