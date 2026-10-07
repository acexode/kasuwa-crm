import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  PROGRAMME_A1,
  PROGRAMME_A2,
  SEED_ACCOUNTS,
  SEED_ACTIVITIES,
  SEED_CONTACTS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_SUPERVISOR,
} from './fixtures';
import { createPool } from './pool';
import { withTenantTransaction, type TenantTx } from './session';

/**
 * Migration 0027's guards on `activity`, beyond what the T-0060 acceptance
 * suite pins (D-L76, D-L77, and the lead's allow-list instruction after the
 * 0026 re-review):
 *
 *   - id, tenant_id and programme_id are fixed for every role but
 *     kasuwa_migrator: kasuwa_app AND kasuwa_test_admin (BYPASSRLS) are
 *     refused with 42501, and the migrator may still correct an id;
 *   - a one-statement rotation of contact or account ids is refused by the
 *     RESTRICT FKs for the roles the key guard does not cover (the migrator
 *     and the test admin), and the activity still points at its row;
 *   - kasuwa_app deletes nothing (restrictive policy), while the migrator can;
 *   - due_at and completed_at are for tasks only.
 *
 * Every write rolls back. Bodies and subjects are invented and name no one.
 */

class Rollback extends Error {}

type Outcome = { ok: true } | { ok: false; code: string };

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : String(error);
};

/** One statement under a savepoint; always rolled back to it unless `keep`. */
async function attempt(
  run: (sql: string, values?: unknown[]) => Promise<unknown>,
  sql: string,
  values: unknown[] = [],
  keep = false,
): Promise<Outcome> {
  await run('SAVEPOINT t0060_guard');
  let outcome: Outcome;
  try {
    await run(sql, values);
    outcome = { ok: true };
  } catch (error) {
    outcome = { ok: false, code: codeOf(error) };
  }
  if (keep && outcome.ok) await run('RELEASE SAVEPOINT t0060_guard');
  else await run('ROLLBACK TO SAVEPOINT t0060_guard');
  return outcome;
}

/** A tenant-A kasuwa_app session that always rolls back; returns the callback's value. */
async function asApp<T>(pool: Pool, userId: string, work: (tx: TenantTx) => Promise<T>) {
  let result: T | undefined;
  try {
    await withTenantTransaction(pool, { tenantId: TENANT_A, userId }, async (tx) => {
      result = await work(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (error instanceof Rollback) return result as T;
    throw error;
  }
  throw new Error('unreachable: the callback always throws');
}

/** A transaction on a direct pool (migrator or test admin) that always rolls back. */
async function rolledBack<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await work(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

const seededActivityA = SEED_ACTIVITIES.find((row) => row.tenantId === TENANT_A);
const contactA1 = SEED_CONTACTS.find((row) => row.programmeId === PROGRAMME_A1);
const accountA2 = SEED_ACCOUNTS.find((row) => row.programmeId === PROGRAMME_A2);

const INSERT_NOTE = `
  INSERT INTO activity (id, tenant_id, programme_id, type, subject, body,
                        owner_user_id, created_by_user_id, contact_id, account_id)
  VALUES ($1, $2, $3, $4, 'T-0060 guard', 'T-0060 guard body, names no one.', $5, $5, $6, $7)`;

describe('activity guards (0027)', () => {
  let appPool: Pool;
  let migrator: Pool;
  let testAdmin: Pool;

  beforeAll(() => {
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 2 });
    testAdmin = createPool({ connectionString: inject('testAdminUrl'), max: 2 });
  });

  afterAll(async () => {
    await appPool.end();
    await migrator.end();
    await testAdmin.end();
  });

  it('the fixtures this file relies on exist', () => {
    expect(seededActivityA, 'no seeded tenant-A activity').toBeDefined();
    expect(contactA1, 'no seeded A1 contact').toBeDefined();
    expect(accountA2, 'no seeded A2 account').toBeDefined();
  });

  describe('id, tenant_id and programme_id are fixed: an allow-list naming only kasuwa_migrator', () => {
    const changes = (id: string) =>
      [
        ['id', 'UPDATE activity SET id = $1 WHERE id = $2', [randomUUID(), id]],
        ['tenant_id', 'UPDATE activity SET tenant_id = $1 WHERE id = $2', [TENANT_B, id]],
        ['programme_id', 'UPDATE activity SET programme_id = $1 WHERE id = $2', [PROGRAMME_A2, id]],
      ] as const;

    it('kasuwa_app is refused every key change with 42501, even a supervisor who reaches both programmes', async () => {
      const id = seededActivityA?.id ?? '';
      const outcomes = await asApp(appPool, USER_A_SUPERVISOR, async (tx) => {
        const run = (sql: string, values?: unknown[]) => tx.query(sql, values);
        const result: Record<string, Outcome> = {};
        for (const [column, sql, values] of changes(id)) {
          result[column] = await attempt(run, sql, [...values]);
        }
        return result;
      });
      expect(outcomes).toEqual({
        id: { ok: false, code: '42501' },
        tenant_id: { ok: false, code: '42501' },
        programme_id: { ok: false, code: '42501' },
      });
    });

    it('kasuwa_test_admin (BYPASSRLS) is refused too: the guard names who may, not who may not', async () => {
      const id = seededActivityA?.id ?? '';
      const result = await rolledBack(testAdmin, async (client) => {
        const run = (sql: string, values?: unknown[]) => client.query(sql, values);
        const outcomes: Record<string, Outcome> = {};
        for (const [column, sql, values] of changes(id)) {
          outcomes[column] = await attempt(run, sql, [...values]);
        }
        const still = await client.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM activity WHERE id = $1 AND tenant_id = $2 AND programme_id = $3',
          [id, TENANT_A, PROGRAMME_A1],
        );
        return { outcomes, unchanged: still.rows[0]?.n };
      });
      expect(result).toEqual({
        outcomes: {
          id: { ok: false, code: '42501' },
          tenant_id: { ok: false, code: '42501' },
          programme_id: { ok: false, code: '42501' },
        },
        unchanged: 1,
      });
    });

    it('kasuwa_migrator may correct an id; a programme correction is still bound by the target FK', async () => {
      const id = seededActivityA?.id ?? '';
      const fresh = randomUUID();
      const result = await rolledBack(migrator, async (client) => {
        const run = (sql: string, values?: unknown[]) => client.query(sql, values);
        const programme = await attempt(
          run,
          'UPDATE activity SET programme_id = $1 WHERE id = $2',
          [PROGRAMME_A2, id],
        );
        const idChange = await attempt(
          run,
          'UPDATE activity SET id = $1 WHERE id = $2',
          [fresh, id],
          true,
        );
        const ids = await client.query<{ id: string }>(
          'SELECT id FROM activity WHERE id = ANY ($1::uuid[])',
          [[id, fresh]],
        );
        return { programme, idChange, ids: ids.rows.map((row) => row.id) };
      });
      // The guard lets the migrator through; the account FK (still in A1) does
      // not follow the activity to A2.
      expect(result).toEqual({
        programme: { ok: false, code: '23503' },
        idChange: { ok: true },
        ids: [fresh],
      });
    });

    it('an UPDATE that rewrites the keys to their own values is not touched by the guard', async () => {
      // As the test admin: kasuwa_app holds no UPDATE on the key columns at all.
      const id = seededActivityA?.id ?? '';
      const outcome = await rolledBack(testAdmin, async (client) =>
        attempt(
          (sql, values) => client.query(sql, values),
          `UPDATE activity SET subject = 'T-0060 edited', id = id, tenant_id = tenant_id,
                  programme_id = programme_id
            WHERE tenant_id = $1 AND id = $2`,
          [TENANT_A, id],
        ),
      );
      expect(outcome).toEqual({ ok: true });
    });
  });

  describe('column-level UPDATE for kasuwa_app: the timeline actor and ordering cannot be forged', () => {
    it.each([
      ['created_by_user_id', USER_A_SUPERVISOR],
      ['created_at', '2020-01-01T00:00:00Z'],
    ] as const)('kasuwa_app gets 42501 writing %s', async (column, value) => {
      const id = seededActivityA?.id ?? '';
      const outcome = await asApp(appPool, USER_A_AGENT_1, async (tx) =>
        attempt(
          (sql, values) => tx.query(sql, values),
          `UPDATE activity SET ${column} = $1 WHERE tenant_id = $2 AND id = $3`,
          [value, TENANT_A, id],
        ),
      );
      expect(outcome).toEqual({ ok: false, code: '42501' });
    });

    it('while every business column, version and updated_at stay writable (not vacuous)', async () => {
      const id = seededActivityA?.id ?? '';
      const outcome = await asApp(appPool, USER_A_AGENT_1, async (tx) =>
        attempt(
          (sql, values) => tx.query(sql, values),
          `UPDATE activity
              SET subject = 'T-0060 edited', body = 'T-0060 body, names no one.',
                  owner_user_id = $1, contact_id = NULL, account_id = account_id,
                  version = version + 1, updated_at = now()
            WHERE tenant_id = $2 AND id = $3`,
          [USER_A_AGENT_1, TENANT_A, id],
        ),
      );
      expect(outcome).toEqual({ ok: true });
    });
  });

  describe('a one-statement id rotation of a target is refused (RESTRICT, D-L76)', () => {
    const X = '60600000-0000-4000-8000-00000000e0a1';
    const Y = '60600000-0000-4000-8000-00000000e0a2';
    const FRESH = '60600000-0000-4000-8000-00000000e0af';

    it.each([
      ['contact', 'migrator', 'display_name', 'contact_id'],
      ['account', 'migrator', 'name', 'account_id'],
      ['contact', 'test admin', 'display_name', 'contact_id'],
      ['account', 'test admin', 'name', 'account_id'],
    ] as const)(
      '%s, as the %s: refused, and the activity still points at X',
      async (table, who, label, target) => {
        const pool = who === 'migrator' ? migrator : testAdmin;
        const result = await rolledBack(pool, async (client) => {
          const run = (sql: string, values?: unknown[]) => client.query(sql, values);
          // X < Y and X first, so the rotation reaches X first (see the T-0060 suite).
          for (const [id, name] of [
            [X, 'T-0060 X'],
            [Y, 'T-0060 Y'],
          ] as const) {
            await run(
              `INSERT INTO ${table} (id, tenant_id, programme_id, ${label}) VALUES ($1, $2, $3, $4)`,
              [id, TENANT_A, PROGRAMME_A1, name],
            );
          }
          const activityId = randomUUID();
          await run(INSERT_NOTE, [
            activityId,
            TENANT_A,
            PROGRAMME_A1,
            'note',
            USER_A_AGENT_1,
            target === 'contact_id' ? X : null,
            target === 'account_id' ? X : null,
          ]);
          const rotation = await attempt(
            run,
            `UPDATE ${table} SET id = CASE id WHEN $1::uuid THEN $3::uuid ELSE $1::uuid END
              WHERE tenant_id = $4 AND id IN ($1::uuid, $2::uuid)`,
            [X, Y, FRESH, TENANT_A],
            true,
          );
          const pointsAt = await client.query<{ label: string }>(
            `SELECT t.${label} AS label FROM activity a
               JOIN ${table} t ON t.tenant_id = a.tenant_id AND t.id = a.${target}
              WHERE a.id = $1`,
            [activityId],
          );
          return { rotation, pointsAt: pointsAt.rows.map((row) => row.label) };
        });
        expect(result).toEqual({ rotation: { ok: false, code: '23503' }, pointsAt: ['T-0060 X'] });
      },
    );
  });

  describe('indexes', () => {
    it('a NON-partial index leads with (tenant_id, programme_id): the offboarding FK lookup (review M1)', async () => {
      // Both keyset indexes are partial on their target, so neither serves
      // `WHERE tenant_id = $1 AND programme_id = $2` alone; deleting a
      // programme or tenant would seq-scan activity once per deleted row.
      const rows = await migrator.query<{ name: string }>(
        `SELECT i.relname AS name
           FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
          WHERE x.indrelid = 'public.activity'::regclass
            AND x.indisvalid AND x.indpred IS NULL
            AND pg_get_indexdef(x.indexrelid, 1, true) = 'tenant_id'
            AND pg_get_indexdef(x.indexrelid, 2, true) = 'programme_id'`,
      );
      expect(rows.rows.map((row) => row.name)).toEqual(['activity_programme_recent_idx']);
    });
  });

  describe('deletes', () => {
    it('kasuwa_app deletes nothing, not even in its own programme; the statement does not fail', async () => {
      const id = seededActivityA?.id ?? '';
      const deleted = await asApp(appPool, USER_A_AGENT_1, async (tx) =>
        tx.query<{ id: string }>(
          'DELETE FROM activity WHERE tenant_id = $1 AND id = $2 RETURNING id',
          [TENANT_A, id],
        ),
      );
      expect(deleted).toEqual([]);
    });

    it('kasuwa_app still sees the row it could not delete (not vacuous)', async () => {
      const id = seededActivityA?.id ?? '';
      const seen = await asApp(appPool, USER_A_AGENT_1, async (tx) =>
        tx.query<{ id: string }>('SELECT id FROM activity WHERE tenant_id = $1 AND id = $2', [
          TENANT_A,
          id,
        ]),
      );
      expect(seen).toEqual([{ id }]);
    });

    it('kasuwa_migrator can delete one', async () => {
      const id = seededActivityA?.id ?? '';
      const deleted = await rolledBack(migrator, async (client) =>
        client.query<{ id: string }>('DELETE FROM activity WHERE id = $1 RETURNING id', [id]),
      );
      expect(deleted.rows).toEqual([{ id }]);
    });
  });

  describe('task fields', () => {
    it.each([
      ['note', 'due_at', '23514'],
      ['call', 'due_at', '23514'],
      ['note', 'completed_at', '23514'],
      ['call', 'completed_at', '23514'],
      ['task', 'due_at', 'accepted'],
      ['task', 'completed_at', 'accepted'],
    ] as const)('a %s with %s set: %s', async (type, column, expected) => {
      const outcome = await asApp(appPool, USER_A_AGENT_1, async (tx) => {
        const run = (sql: string, values?: unknown[]) => tx.query(sql, values);
        const id = randomUUID();
        await run(INSERT_NOTE, [
          id,
          TENANT_A,
          PROGRAMME_A1,
          type,
          USER_A_AGENT_1,
          contactA1?.id ?? null,
          null,
        ]);
        return attempt(run, `UPDATE activity SET ${column} = now() WHERE id = $1`, [id]);
      });
      expect(outcome).toEqual(
        expected === 'accepted' ? { ok: true } : { ok: false, code: expected },
      );
    });

    it('a task that has a due time cannot become a note', async () => {
      const outcome = await asApp(appPool, USER_A_AGENT_1, async (tx) => {
        const run = (sql: string, values?: unknown[]) => tx.query(sql, values);
        const id = randomUUID();
        await run(INSERT_NOTE, [
          id,
          TENANT_A,
          PROGRAMME_A1,
          'task',
          USER_A_AGENT_1,
          contactA1?.id ?? null,
          null,
        ]);
        await run('UPDATE activity SET due_at = now() WHERE id = $1', [id]);
        return attempt(run, `UPDATE activity SET type = 'note' WHERE id = $1`, [id]);
      });
      expect(outcome).toEqual({ ok: false, code: '23514' });
    });
  });
});
