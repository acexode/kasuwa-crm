import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  TENANT_A,
  TENANT_B,
  USER_A_SUPERVISOR,
} from './fixtures';
import { newId } from './ids';
import { createPool } from './pool';
import { withTenantTransaction, type TenantTx } from './session';

/**
 * Migration 0026's hierarchy guard and phone check, beyond what the T-0054
 * acceptance suite pins:
 *
 *   - the refusal is SQLSTATE 23514 with constraint `account_hierarchy`, so
 *     T-0055 can map it without parsing a message;
 *   - a hierarchy write outside READ COMMITTED is refused (0A000): the guard
 *     cannot see a concurrent commit through an old snapshot;
 *   - the DEPTH race the acceptance suite does not stage: one transaction adds
 *     a child under a subtree's leaf while another moves the subtree deeper;
 *   - writes that cannot lengthen a chain never wait for the lock: clearing a
 *     parent, an unrelated update, a parent set in another programme;
 *   - a tenant can still be offboarded with a hierarchy in it (NO ACTION);
 *   - a Phone object with a key the contract does not have is refused.
 *
 * USER_A_SUPERVISOR reaches A1 and A2. Rows the race tests commit are deleted
 * afterwards as kasuwa_migrator; everything else rolls back.
 */

const INSERT = `INSERT INTO account (id, tenant_id, programme_id, name, parent_account_id)
                VALUES ($1, $2, $3, 'T-0054 integration', $4)`;
const SET_PARENT = `UPDATE account SET parent_account_id = $1 WHERE tenant_id = $2 AND id = $3`;

interface Refusal {
  code: string;
  constraint: string | undefined;
}

function refusalOf(error: unknown): Refusal {
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return {
    code: typeof code === 'string' ? code : String(error),
    constraint: typeof constraint === 'string' ? constraint : undefined,
  };
}

class Rollback extends Error {}

/** One rolled-back tenant-A transaction; resolves to the refusal, or 'accepted'. */
async function attemptAsApp(
  pool: Pool,
  work: (tx: TenantTx) => Promise<void>,
): Promise<Refusal | 'accepted'> {
  try {
    await withTenantTransaction(
      pool,
      { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
      async (tx) => {
        await work(tx);
        throw new Rollback();
      },
    );
  } catch (error) {
    if (error instanceof Rollback) return 'accepted';
    return refusalOf(error);
  }
  throw new Error('unreachable: the callback always throws');
}

/** Plants ids[0] top-level and each next one under the one before. */
async function plantChain(
  run: (sql: string, values: unknown[]) => Promise<unknown>,
  tenantId: string,
  programmeId: string,
  ids: readonly string[],
): Promise<void> {
  let parent: string | null = null;
  for (const id of ids) {
    await run(INSERT, [id, tenantId, programmeId, parent]);
    parent = id;
  }
}

function latch<T = void>() {
  let open: (value: T) => void = () => undefined;
  const wait = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('account hierarchy guard (0026)', () => {
  let appPool: Pool;
  let migrator: Pool;
  /** Rows committed by a test, removed after it in one statement (NO ACTION FKs). */
  let committed: string[] = [];

  beforeAll(() => {
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 4 });
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 3 });
  });

  afterEach(async () => {
    if (committed.length > 0) {
      await migrator.query('DELETE FROM account WHERE id = ANY ($1::uuid[])', [committed]);
      committed = [];
    }
  });

  afterAll(async () => {
    await appPool.end();
    await migrator.end();
  });

  it('refuses a cycle and excess depth with 23514 and constraint account_hierarchy', async () => {
    const [a, b, c] = [newId(), newId(), newId()];
    const chain = Array.from({ length: 5 }, () => newId());
    const outcomes = {
      cycle: await attemptAsApp(appPool, async (tx) => {
        await plantChain((text, values) => tx.query(text, values), TENANT_A, PROGRAMME_A1, [
          a,
          b,
          c,
        ]);
        await tx.query(SET_PARENT, [c, TENANT_A, a]);
      }),
      depth: await attemptAsApp(appPool, async (tx) => {
        await plantChain((text, values) => tx.query(text, values), TENANT_A, PROGRAMME_A1, chain);
        await tx.query(INSERT, [newId(), TENANT_A, PROGRAMME_A1, chain[4]]);
      }),
      self: await attemptAsApp(appPool, async (tx) => {
        await tx.query(INSERT, [a, TENANT_A, PROGRAMME_A1, a]);
      }),
    };
    expect(outcomes).toEqual({
      cycle: { code: '23514', constraint: 'account_hierarchy' },
      depth: { code: '23514', constraint: 'account_hierarchy' },
      self: { code: '23514', constraint: 'account_parent_not_self_check' },
    });
  });

  it.each(['REPEATABLE READ', 'SERIALIZABLE'])(
    'refuses a parent-setting write under %s with 0A000, and lets everything else through',
    async (level) => {
      const client: PoolClient = await migrator.connect();
      const step = async (sql: string, values: unknown[]): Promise<Refusal | 'accepted'> => {
        await client.query('SAVEPOINT step');
        try {
          await client.query(sql, values);
          await client.query('RELEASE SAVEPOINT step');
          return 'accepted';
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT step');
          return refusalOf(error);
        }
      };
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${level}`);
        const [top, child] = [newId(), newId()];
        const outcomes = {
          topLevel: await step(INSERT, [top, TENANT_B, PROGRAMME_B1, null]),
          withParent: await step(INSERT, [child, TENANT_B, PROGRAMME_B1, top]),
          rename: await step(`UPDATE account SET name = 'T-0054 renamed' WHERE id = $1`, [top]),
        };
        expect(outcomes).toEqual({
          topLevel: 'accepted',
          withParent: { code: '0A000', constraint: undefined },
          rename: 'accepted',
        });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    },
  );

  it('closes the depth race: a child added under a moving subtree’s leaf', async () => {
    // A1: chain c1 <- c2 <- c3 (depth 3), and a subtree s1 <- s2 (height 2).
    // T1 adds s3 under s2 (height 3) and holds. T2 moves s1 under c3: alone
    // that is depth 3 + 2 - 1 = 5, but with T1's s3 it would be 6.
    const chain = [newId(), newId(), newId()];
    const subtree = [newId(), newId()];
    const leaf = newId();
    committed = [...chain, ...subtree, leaf];
    await withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
      async (tx) => {
        const run = (text: string, values: unknown[]) => tx.query(text, values);
        await plantChain(run, TENANT_A, PROGRAMME_A1, chain);
        await plantChain(run, TENANT_A, PROGRAMME_A1, subtree);
      },
    );

    const t1Wrote = latch();
    const t1Release = latch();
    const t2Pid = latch<number>();
    const session = { tenantId: TENANT_A, userId: USER_A_SUPERVISOR };
    let t2Statement: Refusal | 'accepted' | undefined;

    const t1 = withTenantTransaction(appPool, session, async (tx) => {
      await tx.query(INSERT, [leaf, TENANT_A, PROGRAMME_A1, subtree[1]]);
      t1Wrote.open();
      await t1Release.wait;
    });
    await t1Wrote.wait;

    const t2 = withTenantTransaction(appPool, session, async (tx) => {
      const [row] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      t2Pid.open(row?.pid ?? -1);
      try {
        await tx.query(SET_PARENT, [chain[2], TENANT_A, subtree[0]]);
        t2Statement = 'accepted';
      } catch (error) {
        t2Statement = refusalOf(error);
        throw error;
      }
    }).then(
      () => 'accepted' as const,
      (error: unknown) => refusalOf(error),
    );

    try {
      const pid = await t2Pid.wait;
      const deadline = Date.now() + 15_000;
      let waitedOn = '';
      for (;;) {
        if (t2Statement !== undefined) break;
        const locks = await migrator.query<{ locktype: string }>(
          `SELECT l.locktype FROM pg_locks l WHERE l.pid = $1 AND NOT l.granted`,
          [pid],
        );
        if (locks.rows.length > 0) {
          waitedOn = locks.rows.map((row) => row.locktype).join(',');
          break;
        }
        if (Date.now() > deadline) throw new Error('T2 neither finished nor blocked within 15 s');
      }
      // T2 is held by the guard's advisory lock, not by a row lock.
      expect(waitedOn).toBe('advisory');
    } finally {
      t1Release.open();
      await t1;
    }
    expect(await t2).toEqual({ code: '23514', constraint: 'account_hierarchy' });

    const parent = await migrator.query<{ parent_account_id: string | null }>(
      'SELECT parent_account_id FROM account WHERE id = $1',
      [subtree[0]],
    );
    expect(parent.rows).toEqual([{ parent_account_id: null }]);
  });

  it('only parent-setting writes in the same programme wait for the lock', async () => {
    const [a1Top, a1Child, a1Loose, a2Top] = [newId(), newId(), newId(), newId()];
    const held = newId();
    committed = [a1Top, a1Child, a1Loose, a2Top, held];
    await withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
      async (tx) => {
        await tx.query(INSERT, [a1Top, TENANT_A, PROGRAMME_A1, null]);
        await tx.query(INSERT, [a1Child, TENANT_A, PROGRAMME_A1, a1Top]);
        await tx.query(INSERT, [a1Loose, TENANT_A, PROGRAMME_A1, null]);
        await tx.query(INSERT, [a2Top, TENANT_A, PROGRAMME_A2, null]);
      },
    );

    // T1 holds A1's lock: it set a parent and has not committed.
    const t1Wrote = latch();
    const t1Release = latch();
    const t1 = withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
      async (tx) => {
        await tx.query(INSERT, [held, TENANT_A, PROGRAMME_A1, a1Top]);
        t1Wrote.open();
        await t1Release.wait;
      },
    );
    await t1Wrote.wait;

    try {
      // A waiting statement fails after lock_timeout instead of hanging.
      const quick = (work: (tx: TenantTx) => Promise<void>) =>
        attemptAsApp(appPool, async (tx) => {
          await tx.query(`SET LOCAL lock_timeout = '2s'`);
          await work(tx);
        });
      const outcomes = {
        clearParent: await quick(async (tx) => {
          await tx.query(SET_PARENT, [null, TENANT_A, a1Child]);
        }),
        rename: await quick(async (tx) => {
          await tx.query(
            `UPDATE account SET name = 'T-0054 renamed' WHERE tenant_id = $1 AND id = $2`,
            [TENANT_A, a1Top],
          );
        }),
        topLevelInsert: await quick(async (tx) => {
          await tx.query(INSERT, [newId(), TENANT_A, PROGRAMME_A1, null]);
        }),
        otherProgramme: await quick(async (tx) => {
          await tx.query(INSERT, [newId(), TENANT_A, PROGRAMME_A2, a2Top]);
        }),
        sameProgramme: await quick(async (tx) => {
          await tx.query(SET_PARENT, [a1Top, TENANT_A, a1Loose]);
        }),
      };
      expect(outcomes).toEqual({
        clearParent: 'accepted',
        rename: 'accepted',
        topLevelInsert: 'accepted',
        otherProgramme: 'accepted',
        // 55P03 lock_not_available: it had to wait for T1.
        sameProgramme: { code: '55P03', constraint: undefined },
      });
    } finally {
      t1Release.open();
      await t1;
    }
  });

  it('a tenant with a hierarchy can still be offboarded by the migrator', async () => {
    const client = await migrator.connect();
    try {
      await client.query('BEGIN');
      await plantChain((text, values) => client.query(text, values), TENANT_B, PROGRAMME_B1, [
        newId(),
        newId(),
        newId(),
      ]);
      const deleted = await client.query('DELETE FROM tenant WHERE id = $1', [TENANT_B]);
      expect(deleted.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('app.is_phone_list (0026)', () => {
  let migrator: Pool;

  beforeAll(() => {
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 1 });
  });

  afterAll(async () => {
    await migrator.end();
  });

  it.each([
    ['an empty list', [], true],
    [
      'every contract type',
      ['mobile', 'work', 'home', 'other'].map((type) => ({ type, e164: '+2348031234567' })),
      true,
    ],
    ['an extra key', [{ type: 'mobile', e164: '+2348031234567', dnd: false }], false],
    ['an empty object', [{}], false],
    ['a nested list', [[{ type: 'mobile', e164: '+2348031234567' }]], false],
    ['type as a number', [{ type: 1, e164: '+2348031234567' }], false],
    ['a trailing newline', [{ type: 'mobile', e164: '+2348031234567\n' }], false],
    ['an object, not a list', { type: 'mobile', e164: '+2348031234567' }, false],
  ] as const)('%s -> %s', async (_name, value, expected) => {
    const result = await migrator.query<{ ok: boolean }>(
      'SELECT app.is_phone_list($1::jsonb) AS ok',
      [JSON.stringify(value)],
    );
    expect(result.rows[0]?.ok).toBe(expected);
  });

  it('is not callable by PUBLIC, only by the roles that write accounts', async () => {
    const result = await migrator.query<{ role: string; can: boolean }>(
      `SELECT r AS role, has_function_privilege(r, 'app.is_phone_list(jsonb)', 'EXECUTE') AS can
         FROM unnest(ARRAY['kasuwa_app', 'kasuwa_test_admin', 'kasuwa_sweeper']) AS r
        ORDER BY 1`,
    );
    expect(result.rows).toEqual([
      { role: 'kasuwa_app', can: true },
      { role: 'kasuwa_sweeper', can: false },
      { role: 'kasuwa_test_admin', can: true },
    ]);
  });
});
