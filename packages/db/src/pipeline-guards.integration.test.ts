import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { DefaultPipelineRoleError, ensureDefaultPipelines } from './default-pipeline';
import {
  BU_A,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_DEALS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_SUPERVISOR,
} from './fixtures';
import { createPool } from './pool';
import { withTenantTransaction, type TenantTx } from './session';

/**
 * Migration 0036's guards, beyond what the T-0106 acceptance suite pins:
 *
 *   - the creation marker on the configuration tables admits a programme
 *     created in THIS transaction and nothing else: not another programme of
 *     the tenant, not after stamping an in-scope programme's xmin, and not in
 *     a later transaction of a session that does not reach it;
 *   - deals and checks carry no marker at all;
 *   - the move rule (R5) binds kasuwa_test_admin, and only the migrator is
 *     free of it;
 *   - a requirement's kind is fixed (a ticked check stays a check);
 *   - the seeded deal sits in its programme's default pipeline;
 *   - no existence oracle across tenants through pipeline_stage's unique
 *     keys: naming another tenant's real pipeline and naming an invented id
 *     fail the same way (D-L120);
 *   - ensureDefaultPipelines' all-programmes path refuses any role but
 *     kasuwa_migrator (D-L120, CLAUDE.md 2.3).
 *
 * Every write rolls back. Names are invented and name no one.
 */

class Rollback extends Error {}

type Outcome = { ok: true; rows: number } | { ok: false; code: string };

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : String(error);
};

/** Statements under a savepoint, deferred rules forced; always rolled back to it. */
async function attempt(
  run: (sql: string, values?: unknown[]) => Promise<unknown[]>,
  sql: string,
  values: unknown[] = [],
): Promise<Outcome> {
  await run('SAVEPOINT t0106_guard');
  let outcome: Outcome;
  try {
    const rows = await run(sql, values);
    await run('SET CONSTRAINTS ALL IMMEDIATE');
    outcome = { ok: true, rows: rows.length };
  } catch (error) {
    outcome = { ok: false, code: codeOf(error) };
  }
  await run('ROLLBACK TO SAVEPOINT t0106_guard');
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

const INSERT_PIPELINE = `INSERT INTO pipeline (id, tenant_id, programme_id, name)
                         VALUES ($1, $2, $3, 'T-0106 guard') RETURNING id`;

/** The first open stage, the stage after it, and the won stage of a programme's default pipeline. */
async function defaultStages(client: PoolClient, programmeId: string) {
  const rows = await client.query<{ pipeline_id: string; id: string; kind: string }>(
    `SELECT s.pipeline_id, s.id, s.kind FROM pipeline_stage s
      WHERE s.tenant_id = $1 AND s.programme_id = $2 ORDER BY s.position`,
    [TENANT_A, programmeId],
  );
  const [first, second] = rows.rows;
  const won = rows.rows.find((row) => row.kind === 'won');
  if (first === undefined || second === undefined || won === undefined) {
    throw new Error('the seeded programme has no default pipeline');
  }
  return { pipelineId: first.pipeline_id, first: first.id, second: second.id, won: won.id };
}

describe('pipeline guards (0036)', () => {
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

  it('the seeded deal sits in the first stage of its programme’s default pipeline', async () => {
    const [seeded] = SEED_DEALS;
    expect(seeded, 'no seeded deal').toBeDefined();
    const row = await rolledBack(migrator, async (client) => {
      const stages = await defaultStages(client, PROGRAMME_A1);
      const deal = await client.query<{ pipeline_id: string; stage_id: string }>(
        'SELECT pipeline_id, stage_id FROM deal WHERE id = $1',
        [seeded?.id],
      );
      return { stages, deal: deal.rows[0] };
    });
    expect(row.deal).toEqual({ pipeline_id: row.stages.pipelineId, stage_id: row.stages.first });
  });

  describe('the creation marker admits the programme this transaction created, and nothing else', () => {
    it('an A1 session cannot write a pipeline into A2, even after stamping A1 in the same transaction', async () => {
      const outcomes = await asApp(appPool, USER_A_AGENT_1, async (tx) => {
        const run = (sql: string, values?: unknown[]) => tx.query(sql, values);
        const control = await attempt(run, INSERT_PIPELINE, [randomUUID(), TENANT_A, PROGRAMME_A1]);
        // The forge 0021 describes: a row version of an in-scope programme
        // stamped with this transaction's xid (at top level, not in a
        // savepoint, so the xid is the one the marker compares).
        const stamped = await run(
          'UPDATE programme SET updated_at = updated_at WHERE id = $1 RETURNING id',
          [PROGRAMME_A1],
        );
        expect(stamped).toHaveLength(1);
        const intoA2 = await attempt(run, INSERT_PIPELINE, [randomUUID(), TENANT_A, PROGRAMME_A2]);
        return { control, intoA2 };
      });
      // The control is judged with deferred rules forced: a lone pipeline
      // breaks the stage rule (23514), which still proves the policy let it in.
      expect(outcomes.control).toEqual({ ok: false, code: '23514' });
      expect(outcomes.intoA2).toEqual({ ok: false, code: '42501' });
    });

    it('createProgramme-style: a programme inserted in the transaction gets its pipeline; a deal there is still refused', async () => {
      const outcome = await asApp(appPool, USER_A_SUPERVISOR, async (tx) => {
        const run = (sql: string, values?: unknown[]) => tx.query(sql, values);
        const programmeId = randomUUID();
        await run(
          `INSERT INTO programme (id, tenant_id, business_unit_id, name, created_at, updated_at)
           VALUES ($1, $2, $3, $4, date_trunc('milliseconds', clock_timestamp()),
                   date_trunc('milliseconds', clock_timestamp()))`,
          [programmeId, TENANT_A, BU_A, `T-0106 guard ${programmeId}`],
        );
        const created = await ensureDefaultPipelines(
          (text, values) => tx.query(text, values),
          TENANT_A,
          programmeId,
        );
        const stages = await run(
          'SELECT id FROM pipeline_stage WHERE tenant_id = $1 AND programme_id = $2 ORDER BY position',
          [TENANT_A, programmeId],
        );
        const pipelineId = (
          await run('SELECT id FROM pipeline WHERE tenant_id = $1 AND programme_id = $2', [
            TENANT_A,
            programmeId,
          ])
        )[0] as { id: string } | undefined;
        const rules = await attempt(run, 'SELECT 1');
        const deal = await attempt(
          run,
          `INSERT INTO deal (id, tenant_id, programme_id, pipeline_id, stage_id, name)
           VALUES ($1, $2, $3, $4, $5, 'T-0106 guard deal') RETURNING id`,
          [
            randomUUID(),
            TENANT_A,
            programmeId,
            pipelineId?.id,
            (stages[0] as { id: string } | undefined)?.id,
          ],
        );
        return { created: created.length, stages: stages.length, rules, deal };
      });
      expect(outcome).toEqual({
        created: 1,
        stages: 7,
        // The stage rules hold for the seeded pipeline when forced.
        rules: { ok: true, rows: 1 },
        // No marker on deal: the session's scope does not include the new programme.
        deal: { ok: false, code: '42501' },
      });
    });

    it('a later transaction of a session that does not reach the programme sees none of its pipeline', async () => {
      const visible = await asApp(appPool, USER_A_AGENT_2, async (tx) =>
        tx.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pipeline WHERE tenant_id = $1 AND programme_id = $2',
          [TENANT_A, PROGRAMME_A1],
        ),
      );
      expect(visible).toEqual([{ n: 0 }]);
    });
  });

  describe('no cross-tenant existence oracle through the stage keys (D-L120)', () => {
    /**
     * As a tenant-A kasuwa_app session in its own in-scope programme, insert
     * a stage that names (a) tenant B's real default pipeline and (b) an
     * invented id. With a unique key leading with pipeline_id, (a) collided
     * with B's won/lost stage or position (23505) while (b) reached the FK
     * (23503). Every key now leads with (tenant_id, programme_id,
     * pipeline_id), so neither can collide with another tenant's row and both
     * reach the same FK, with the same constraint name.
     */
    const INSERT_STAGE = `INSERT INTO pipeline_stage
        (id, tenant_id, programme_id, pipeline_id, name, kind, position, probability_bp,
         rotting_after_days)
      VALUES ($1, $2, $3, $4, 'T-0106 oracle', $5, $6, $7, $8) RETURNING id`;
    const SHAPES: [string, string, number, number, number | null][] = [
      ['won', 'won', 40, 10000, null],
      ['lost', 'lost', 41, 0, null],
      // Position 0 is taken by the first stage of every default pipeline.
      ['position', 'open', 0, 1000, 14],
    ];

    type Failure = { ok: true; rows: number } | { ok: false; code: string; constraint: string };

    async function failure(
      run: (sql: string, values?: unknown[]) => Promise<unknown[]>,
      values: unknown[],
    ): Promise<Failure> {
      await run('SAVEPOINT t0106_oracle');
      let outcome: Failure;
      try {
        const rows = await run(INSERT_STAGE, values);
        await run('SET CONSTRAINTS ALL IMMEDIATE');
        outcome = { ok: true, rows: rows.length };
      } catch (error) {
        const constraint = (error as { constraint?: unknown }).constraint;
        outcome = {
          ok: false,
          code: codeOf(error),
          constraint: typeof constraint === 'string' ? constraint : '',
        };
      }
      await run('ROLLBACK TO SAVEPOINT t0106_oracle');
      return outcome;
    }

    it.each(SHAPES)(
      'a %s stage naming tenant B’s real pipeline fails exactly as one naming an invented id',
      async (_label, kind, position, probabilityBp, rottingAfterDays) => {
        const foreignPipeline = await rolledBack(migrator, async (client) => {
          const rows = await client.query<{ id: string }>(
            'SELECT id FROM pipeline WHERE tenant_id = $1 AND programme_id = $2',
            [TENANT_B, PROGRAMME_B1],
          );
          return rows.rows[0]?.id;
        });
        expect(foreignPipeline, 'tenant B has no seeded pipeline').toBeDefined();

        const outcomes = await asApp(appPool, USER_A_AGENT_1, async (tx) => {
          const run = (sql: string, values?: unknown[]) => tx.query(sql, values);
          const values = (pipelineId: string | undefined) => [
            randomUUID(),
            TENANT_A,
            PROGRAMME_A1,
            pipelineId,
            kind,
            position,
            probabilityBp,
            rottingAfterDays,
          ];
          return {
            real: await failure(run, values(foreignPipeline)),
            invented: await failure(run, values(randomUUID())),
          };
        });
        expect(outcomes.real).toEqual(outcomes.invented);
        expect(outcomes.real).toEqual({
          ok: false,
          code: '23503',
          constraint: 'pipeline_stage_pipeline_fk',
        });
      },
    );
  });

  describe('ensureDefaultPipelines: the all-programmes path is the migrator’s alone (D-L120)', () => {
    it('refuses a kasuwa_app session, writing nothing; the programmeId path is unchanged', async () => {
      const outcome = await asApp(appPool, USER_A_SUPERVISOR, async (tx) => {
        const query = (text: string, values: readonly unknown[]) => tx.query(text, [...values]);
        // A1 already has its pipeline, so the narrowed call writes nothing.
        const narrowed = await ensureDefaultPipelines(query, TENANT_A, PROGRAMME_A1);
        const refused = await ensureDefaultPipelines(query, TENANT_A).then(
          () => 'ran',
          (error: unknown) => (error instanceof DefaultPipelineRoleError ? 'refused' : String(error)),
        );
        return { narrowed, refused };
      });
      expect(outcome).toEqual({ narrowed: [], refused: 'refused' });
    });

    it('refuses kasuwa_test_admin too: the guard names who may, not who may not', async () => {
      const refused = await rolledBack(testAdmin, (client) =>
        ensureDefaultPipelines(
          (text, values) => client.query(text, [...values]).then((result) => result.rows),
          TENANT_A,
        ).then(
          () => 'ran',
          (error: unknown) => (error instanceof DefaultPipelineRoleError ? 'refused' : String(error)),
        ),
      );
      expect(refused).toBe('refused');
    });

    it('runs for kasuwa_migrator, and changes nothing on a seeded tenant', async () => {
      const created = await rolledBack(migrator, (client) =>
        ensureDefaultPipelines(
          (text, values) => client.query(text, [...values]).then((result) => result.rows),
          TENANT_A,
        ),
      );
      expect(created).toEqual([]);
    });
  });

  describe('the move rule (R5) and the requirement kind', () => {
    it('binds kasuwa_test_admin; only kasuwa_migrator is free of it', async () => {
      const [seeded] = SEED_DEALS;
      const move = (pool: Pool) =>
        rolledBack(pool, async (client) => {
          const stages = await defaultStages(client, PROGRAMME_A1);
          const run = async (sql: string, values?: unknown[]) =>
            (await client.query(sql, values)).rows;
          return {
            onList: await attempt(run, 'UPDATE deal SET stage_id = $2 WHERE id = $1 RETURNING id', [
              seeded?.id,
              stages.second,
            ]),
            toWon: await attempt(run, 'UPDATE deal SET stage_id = $2 WHERE id = $1 RETURNING id', [
              seeded?.id,
              stages.won,
            ]),
          };
        });
      // Qualified > Discovery is on the list; Qualified > Won is not.
      expect(await move(testAdmin)).toEqual({
        onList: { ok: true, rows: 1 },
        toWon: { ok: false, code: '23514' },
      });
      expect(await move(migrator)).toEqual({
        onList: { ok: true, rows: 1 },
        toWon: { ok: true, rows: 1 },
      });
    });

    it('a requirement’s kind cannot change, for kasuwa_test_admin either', async () => {
      const outcome = await rolledBack(testAdmin, async (client) => {
        const run = async (sql: string, values?: unknown[]) =>
          (await client.query(sql, values)).rows;
        return attempt(
          run,
          `UPDATE pipeline_stage_requirement SET kind = 'field', field = 'amount', label = NULL
            WHERE tenant_id = $1 AND programme_id = $2 AND kind = 'check' RETURNING id`,
          [TENANT_A, PROGRAMME_A1],
        );
      });
      expect(outcome).toEqual({ ok: false, code: '42501' });
    });
  });
});
