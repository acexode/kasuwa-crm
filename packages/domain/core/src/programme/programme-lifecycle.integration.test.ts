import {
  BU_A,
  BU_B,
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_SUPERVISOR,
  withTenantTransaction,
  type TenantTx,
} from '@kasuwa/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  ArchiveConfirmationMismatchError,
  archiveProgramme,
  BusinessUnitNotFoundError,
  createProgramme,
  getProgrammeArchivePreview,
} from './programme-lifecycle';
import { DuplicateProgrammeNameError, findProgrammeById } from './programme.repository';

/**
 * T-0029 lifecycle against real Postgres and the 0012 policies. Every write
 * is rolled back deliberately; nothing here survives.
 */
class Rollback extends Error {}

describe('programme lifecycle (T-0029, D-L46)', () => {
  let pool: ReturnType<typeof createPool>;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 3 });
  });

  afterAll(async () => {
    await pool.end();
  });

  const supervisor = { tenantId: TENANT_A, userId: USER_A_SUPERVISOR };
  const agentOne = { tenantId: TENANT_A, userId: USER_A_AGENT_1 };

  async function rolledBack(
    session: typeof supervisor,
    fn: (tx: TenantTx) => Promise<void>,
  ): Promise<void> {
    await expect(
      withTenantTransaction(pool, session, async (tx) => {
        await fn(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  it('creates under RLS without a definer function; the row is written, not yet readable, and the creator is a member', async () => {
    await rolledBack(supervisor, async (tx) => {
      const created = await createProgramme(tx, { name: 'Lifecycle Probe', businessUnitId: BU_A });
      expect(created.status).toBe('active');
      // The session's scope was resolved before the insert: invisible until
      // the next transaction, by design.
      expect(await findProgrammeById(tx, created.id)).toBeNull();
      const members = await tx.query<{ user_id: string }>(
        'SELECT user_id FROM user_programme WHERE tenant_id = $1 AND programme_id = $2',
        [TENANT_A, created.id],
      );
      expect(members.map((row) => row.user_id)).toEqual([USER_A_SUPERVISOR]);
    });
  });

  it('refuses a foreign business unit and a taken name', async () => {
    await rolledBack(supervisor, async (tx) => {
      await expect(
        createProgramme(tx, { name: 'Foreign BU Probe', businessUnitId: BU_B }),
      ).rejects.toBeInstanceOf(BusinessUnitNotFoundError);
    });
    await rolledBack(supervisor, async (tx) => {
      await expect(
        createProgramme(tx, { name: 'Telco Y Care', businessUnitId: BU_A }),
      ).rejects.toBeInstanceOf(DuplicateProgrammeNameError);
    });
  });

  it('cannot insert a programme into another tenant, even by hand', async () => {
    await expect(
      withTenantTransaction(pool, supervisor, (tx) =>
        tx.query(
          `INSERT INTO programme (id, tenant_id, business_unit_id, name)
           VALUES (gen_random_uuid(), $1, $2, 'Cross-tenant probe')`,
          [TENANT_B, BU_B],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('archives by exact name only, idempotently, and keeps every membership', async () => {
    await rolledBack(supervisor, async (tx) => {
      await expect(archiveProgramme(tx, PROGRAMME_A1, 'bank x collections')).rejects.toBeInstanceOf(
        ArchiveConfirmationMismatchError,
      );
      const before = await getProgrammeArchivePreview(tx, PROGRAMME_A1);
      const first = await archiveProgramme(tx, PROGRAMME_A1, 'Bank X Collections');
      const again = await archiveProgramme(tx, PROGRAMME_A1, 'Bank X Collections');
      expect(first?.status).toBe('archived');
      expect(again?.version).toBe(first?.version);
      expect((await getProgrammeArchivePreview(tx, PROGRAMME_A1))?.agentsLosingAccess).toBe(
        before?.agentsLosingAccess,
      );
    });
  });

  it('is null for a sibling programme, for preview and archive alike', async () => {
    await rolledBack(agentOne, async (tx) => {
      expect(await getProgrammeArchivePreview(tx, PROGRAMME_A2)).toBeNull();
      expect(await archiveProgramme(tx, PROGRAMME_A2, 'Telco Y Care')).toBeNull();
    });
  });
});
