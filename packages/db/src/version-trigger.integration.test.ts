import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PROGRAMME_A1, SEED_ACCOUNTS, SEED_CONTACTS, TENANT_A, USER_A_AGENT_1 } from './fixtures';
import { createPool } from './pool';
import { withTenantTransaction } from './session';

/**
 * Migration 0019, finding M1: `version` on contact and account is kept moving
 * by app.bump_version(). An UPDATE that forgets it is bumped exactly once. An
 * UPDATE that sets it itself (`version = version + 1`, the T-0041 repository)
 * is left alone, so the value never moves twice.
 *
 * Runs as kasuwa_app through withTenantTransaction. Every write rolls back.
 */

class Rollback<T> {
  constructor(readonly value: T) {}
}

async function rolledBack<T>(
  pool: Pool,
  fn: (version: (sql: string, values: unknown[]) => Promise<number | undefined>) => Promise<T>,
): Promise<T> {
  try {
    await withTenantTransaction(
      pool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => {
        throw new Rollback(
          await fn(
            async (sql, values) => (await tx.query<{ version: number }>(sql, values))[0]?.version,
          ),
        );
      },
    );
  } catch (signal) {
    if (signal instanceof Rollback) return signal.value as T;
    throw signal;
  }
  throw new Error('unreachable: the callback always throws');
}

const contactA1 = SEED_CONTACTS.find((row) => row.programmeId === PROGRAMME_A1);
const accountA1 = SEED_ACCOUNTS.find((row) => row.programmeId === PROGRAMME_A1);

describe('version is maintained by the schema (0019)', () => {
  let appPool: Pool;

  beforeAll(() => {
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  });

  afterAll(async () => {
    await appPool.end();
  });

  it.each([
    ['contact', 'display_name', contactA1?.id],
    ['account', 'name', accountA1?.id],
  ] as const)(
    '%s: bumps once when an UPDATE forgets version, and leaves a self-bump alone',
    async (table, column, id) => {
      expect(id, `fixture drift: no seeded ${table} in A1`).toBeDefined();
      const versions = await rolledBack(appPool, async (read) => {
        return {
          start: await read(`SELECT version FROM ${table} WHERE tenant_id = $1 AND id = $2`, [
            TENANT_A,
            id,
          ]),
          forgot: await read(
            `UPDATE ${table} SET ${column} = ${column} || ' x'
              WHERE tenant_id = $1 AND id = $2 RETURNING version`,
            [TENANT_A, id],
          ),
          // Twice in one transaction: unlike now(), the counter must keep moving.
          forgotAgain: await read(
            `UPDATE ${table} SET ${column} = ${column} || ' y'
              WHERE tenant_id = $1 AND id = $2 RETURNING version`,
            [TENANT_A, id],
          ),
          selfBumped: await read(
            `UPDATE ${table} SET ${column} = ${column} || ' z', version = version + 1
              WHERE tenant_id = $1 AND id = $2 RETURNING version`,
            [TENANT_A, id],
          ),
        };
      });
      expect(versions).toEqual({ start: 1, forgot: 2, forgotAgain: 3, selfBumped: 4 });
    },
  );
});
