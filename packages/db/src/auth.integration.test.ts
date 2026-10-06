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
 *
 * It runs as kasuwa_auth, the store's only writer since migration 0024
 * (T-0049): kasuwa_app may read a presented key's row but write none.
 */

const LIMITS: RateLimitPolicy = { maxAttempts: 5, windowMinutes: 15, lockMinutes: 15 };

/** What the store needs: one connection, inside a transaction. */
interface StatementRunner {
  query: <T extends QueryResultRow>(sql: string, values?: readonly unknown[]) => Promise<T[]>;
}

function key(label: string): Buffer {
  return createHash('sha256').update(`auth.integration.test:${label}`, 'utf8').digest();
}

describe('the authentication rate-limit store', () => {
  /** kasuwa_auth: the API's auth pool, the only role that may write the store. */
  let pool: Pool;
  /** kasuwa_app: every other request's pool. */
  let appPool: Pool;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('authDatabaseUrl'), max: 10 });
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  });

  afterAll(async () => {
    await pool.end();
    await appPool.end();
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

  /**
   * The store is deliberately not tenant-scoped, but it is no longer policied
   * `USING (true)` either (T-0020, from T-0004 FINDING-3): a row is admitted
   * only to a session that presents its `key_hash` in `app.rate_limit_key`,
   * transaction-locally. So its caller is one connection inside a transaction,
   * exactly as every other table's caller is.
   *
   * That is a deliberate contract change and it is fail-closed: called outside
   * a transaction the setting lapses before the next statement runs and the
   * write is refused, rather than quietly running unscoped.
   */
  async function inTransaction<T>(
    fn: (tx: StatementRunner) => Promise<T>,
    on: Pool = pool,
  ): Promise<T> {
    const client = await on.connect();
    try {
      await client.query('BEGIN');
      const tx: StatementRunner = {
        query: async <T2 extends QueryResultRow>(sql: string, values: readonly unknown[] = []) =>
          (await client.query<T2>(sql, values as unknown[])).rows,
      };
      const value = await fn(tx);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  const fail = (target: Buffer, policy: RateLimitPolicy = LIMITS) =>
    inTransaction((tx) => registerAuthFailure(tx, target, policy));
  const lockOn = (target: Buffer) => inTransaction((tx) => readAuthLock(tx, target));
  const clear = (target: Buffer) => inTransaction((tx) => clearAuthFailures(tx, target));

  it('counts consecutive failures one at a time', async () => {
    const target = key('sequential');
    expect((await fail(target)).failedCount).toBe(1);
    expect((await fail(target)).failedCount).toBe(2);
    expect((await fail(target)).failedCount).toBe(3);
  });

  it('keys counters separately, so one identifier cannot lock another', async () => {
    await fail(key('a'));
    await fail(key('a'));
    expect((await fail(key('b'))).failedCount).toBe(1);
  });

  it('sets the lock in the same statement that reaches the threshold', async () => {
    const target = key('locks');
    for (let attempt = 1; attempt < LIMITS.maxAttempts; attempt += 1) {
      expect((await fail(target)).lockedUntil).toBeNull();
    }
    const final = await fail(target);
    expect(final.failedCount).toBe(LIMITS.maxAttempts);
    expect(final.lockedUntil).not.toBeNull();

    const lock = await lockOn(target);
    expect(lock?.lockedUntil).not.toBeNull();
  });

  it('loses no increment when failures arrive concurrently', async () => {
    // The regression that matters. Ten parallel failures against one key must
    // count ten, not one: under READ COMMITTED a read-modify-write in the
    // application reads the same value ten times and writes it back ten times,
    // and the lockout silently never fires.
    const target = key('concurrent');
    const results = await Promise.all(Array.from({ length: 10 }, () => fail(target)));

    const counts = results.map((result) => result.failedCount).sort((a, b) => a - b);
    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const lock = await lockOn(target);
    expect(lock, 'ten concurrent failures past a threshold of five must lock').not.toBeNull();
  });

  it('forgets a key when the factor it guards succeeds', async () => {
    const target = key('cleared');
    await fail(target);
    await fail(target);
    await clear(target);
    expect((await fail(target)).failedCount).toBe(1);
  });

  it('does not lock at all when the threshold is zero', async () => {
    const target = key('disabled');
    const disabled: RateLimitPolicy = { ...LIMITS, maxAttempts: 0 };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await fail(target, disabled)).lockedUntil).toBeNull();
    }
    expect(await lockOn(target)).toBeNull();
  });

  // --- the policy, not the arithmetic --------------------------------------
  //
  // T-0004 FINDING-3. The policy used to be `USING (true) WITH CHECK (true)`,
  // justified in ADR-0009 on the ground that a session could only ever touch
  // "a key it already knows". It could touch all of them: SELECT returned every
  // key in the cell, and one DELETE cleared every lockout in it. The exemption
  // from `tenant_id` is unchanged and still right; what changed is the policy.
  describe('a session reaches only the key it presents', () => {
    /**
     * The unrestricted channel a compromised caller would use, on the role
     * that CAN write the store: the policy is what confines it there.
     */
    async function asAuthRole<T>(fn: (tx: StatementRunner) => Promise<T>): Promise<T> {
      return inTransaction(fn);
    }

    it('shows no row at all to a session that presents no key', async () => {
      const victim = key('victim');
      await fail(victim);

      const rows = await asAuthRole((tx) =>
        tx.query<{ key_hash: Buffer }>('SELECT key_hash FROM auth_rate_limit'),
      );
      expect(rows, 'enumeration of every key in the cell').toEqual([]);
    });

    it('shows a session only its own key, not its neighbour’s', async () => {
      const mine = key('mine');
      const theirs = key('theirs');
      await fail(mine);
      await fail(theirs);

      const rows = await asAuthRole(async (tx) => {
        await tx.query(`SELECT set_config('app.rate_limit_key', encode($1::bytea, 'hex'), true)`, [
          mine,
        ]);
        return tx.query<{ key_hash: Buffer }>('SELECT key_hash FROM auth_rate_limit');
      });
      expect(rows.length).toBe(1);
      // NOT VACUOUS: one row IS visible, so the assertion above is about the
      // policy rather than about an empty table.
      expect(rows[0]?.key_hash.equals(mine)).toBe(true);
    });

    it('cannot clear every lockout in the cell with one statement', async () => {
      const victim = key('untouchable');
      for (let attempt = 0; attempt < LIMITS.maxAttempts; attempt += 1) {
        await fail(victim);
      }
      expect(await lockOn(victim)).not.toBeNull();

      const deleted = await asAuthRole((tx) =>
        tx.query<{ key_hash: Buffer }>('DELETE FROM auth_rate_limit RETURNING key_hash'),
      );
      expect(deleted, 'a mass clear of every lockout in the cell').toEqual([]);

      // And the lockout it tried to clear is still in force.
      expect(await lockOn(victim)).not.toBeNull();
    });

    it('refuses to write a counter under a key it did not present', async () => {
      // The WITH CHECK half. Without it a session could not read another key's
      // row but could still overwrite it.
      const presented = key('presented');
      const other = key('other');

      await expect(
        asAuthRole(async (tx) => {
          await tx.query(`SELECT set_config('app.rate_limit_key', encode($1::bytea, 'hex'), true)`, [
            presented,
          ]);
          return tx.query('INSERT INTO auth_rate_limit (key_hash, failed_count) VALUES ($1, 99)', [
            other,
          ]);
        }),
      ).rejects.toThrow();
    });

    it('still counts for a workspace that does not exist, which is the whole point of the table', async () => {
      // ADR-0009's property, re-asserted here because the new policy is exactly
      // where it could be broken: the key is computed from what the caller
      // submitted, so a slug naming no tenant must produce the same countdown
      // as a real one. Both slugs are invented; neither names a seeded tenant.
      const real = createHash('sha256').update('signin:sahel-bpo:invented@example.test').digest();
      const fake = createHash('sha256')
        .update('signin:no-such-workspace:invented@example.test')
        .digest();

      expect((await fail(real)).failedCount).toBe(1);
      expect((await fail(fake)).failedCount).toBe(1);
      expect((await fail(real)).failedCount).toBe(2);
      expect((await fail(fake)).failedCount).toBe(2);
    });

    it('fails closed when the key is presented outside a transaction', async () => {
      // `set_config(..., is_local => true)` lapses at the end of the implicit
      // transaction, so the following statement sees no key and the policy
      // denies. A caller that forgets the transaction gets an error, not an
      // unscoped write.
      const target = key('no-transaction');
      await expect(
        registerAuthFailure(
          {
            query: async <T extends QueryResultRow>(sql: string, values: readonly unknown[] = []) =>
              (await pool.query<T>(sql, values as unknown[])).rows,
          },
          target,
          LIMITS,
        ),
      ).rejects.toThrow();
    });
  });

  // --- kasuwa_app writes none of it (T-0049 review, major 1) ----------------
  //
  // Presenting a key is all the policy asks, and a user's MFA key is a hash of
  // its tenant and user ids. So before 0024, SQL injected anywhere on the app
  // pool could present a victim's key and DELETE their MFA lockout row. Now
  // the write is refused as a privilege, whatever key is presented.
  describe('kasuwa_app cannot write the store, even presenting the right key', () => {
    const sqlState = async (work: Promise<unknown>): Promise<string> => {
      try {
        await work;
        return 'committed';
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return typeof code === 'string' ? code : `not a database error: ${String(error)}`;
      }
    };

    const presenting = (target: Buffer, sql: string, values: unknown[]) =>
      inTransaction(async (tx) => {
        await tx.query(`SELECT set_config('app.rate_limit_key', encode($1::bytea, 'hex'), true)`, [
          target,
        ]);
        return tx.query(sql, values);
      }, appPool);

    it('DELETE, INSERT and UPDATE are 42501, and the lockout survives', async () => {
      const victim = key('app-role-victim');
      for (let attempt = 0; attempt < LIMITS.maxAttempts; attempt += 1) {
        await fail(victim);
      }
      expect(await lockOn(victim), 'precondition: the victim is locked').not.toBeNull();

      expect(
        await sqlState(presenting(victim, 'DELETE FROM auth_rate_limit WHERE key_hash = $1', [victim])),
      ).toBe('42501');
      expect(
        await sqlState(
          presenting(victim, 'UPDATE auth_rate_limit SET locked_until = NULL WHERE key_hash = $1', [
            victim,
          ]),
        ),
      ).toBe('42501');
      expect(
        await sqlState(
          presenting(key('app-role-new'), 'INSERT INTO auth_rate_limit (key_hash) VALUES ($1)', [
            key('app-role-new'),
          ]),
        ),
      ).toBe('42501');

      expect(await lockOn(victim), 'the lockout was cleared through kasuwa_app').not.toBeNull();
    });

    it('can still read the row for a key it presents (sign-in phase one reads the lock)', async () => {
      const target = key('app-role-reader');
      await fail(target);
      const rows = await presenting(target, 'SELECT failed_count FROM auth_rate_limit', []);
      expect(rows).toEqual([{ failed_count: 1 }]);
    });
  });
});
