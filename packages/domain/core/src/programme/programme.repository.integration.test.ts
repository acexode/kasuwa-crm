import {
  createPool,
  withTenantTransaction,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  type TenantTx,
} from '@kasuwa/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  DuplicateProgrammeNameError,
  findProgrammeById,
  listProgrammeMembers,
  listProgrammes,
  StaleProgrammeVersionError,
  updateProgramme,
} from './programme.repository';

/**
 * T-0024 — the programme repository, below HTTP, so a bug in the controller
 * cannot mask one here. Every write runs in a transaction that is rolled back
 * deliberately: nothing this file does survives it.
 */
class Rollback extends Error {}

describe('programme repository (T-0024)', () => {
  let pool: ReturnType<typeof createPool>;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 3 });
  });

  afterAll(async () => {
    await pool.end();
  });

  const supervisor = { tenantId: TENANT_A, userId: USER_A_SUPERVISOR };
  const agentOne = { tenantId: TENANT_A, userId: USER_A_AGENT_1 };

  function read<T>(session: typeof supervisor, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenantTransaction(pool, session, fn);
  }

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

  it('lists the reachable set only, and walks it one page at a time', async () => {
    const own = await read(agentOne, (tx) => listProgrammes(tx, { limit: 50 }));
    expect(own.data.map((p) => p.id)).toEqual([PROGRAMME_A1]);

    const walked = await read(supervisor, async (tx) => {
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const result = await listProgrammes(tx, { limit: 1, cursor });
        ids.push(...result.data.map((p) => p.id));
        if (result.nextCursor === null) return ids;
        cursor = result.nextCursor;
      }
      throw new Error('pagination did not terminate');
    });
    expect(walked.sort()).toEqual([PROGRAMME_A1, PROGRAMME_A2].sort());
  });

  it('returns null for a sibling or a foreign programme, by id and by members', async () => {
    await read(agentOne, async (tx) => {
      expect(await findProgrammeById(tx, PROGRAMME_A2)).toBeNull();
      expect(await findProgrammeById(tx, PROGRAMME_B1)).toBeNull();
      expect(await listProgrammeMembers(tx, PROGRAMME_A2, { limit: 50 })).toBeNull();
      expect(await listProgrammeMembers(tx, PROGRAMME_B1, { limit: 50 })).toBeNull();
      expect(await updateProgramme(tx, PROGRAMME_A2, 0, { name: 'Hijacked' })).toBeNull();
    });
  });

  it('lists exactly the user_programme members of a reachable programme', async () => {
    const page = await read(supervisor, (tx) =>
      listProgrammeMembers(tx, PROGRAMME_A2, { limit: 50 }),
    );
    expect(page?.data.map((m) => m.userId).sort()).toEqual(
      [USER_A_AGENT_2, USER_A_SUPERVISOR].sort(),
    );
  });

  it('moves the version on every write, even twice in one millisecond, and refuses a stale one', async () => {
    await rolledBack(supervisor, async (tx) => {
      const before = await findProgrammeById(tx, PROGRAMME_A1);
      if (before === null) throw new Error('fixture drift');

      const first = await updateProgramme(tx, PROGRAMME_A1, before.version, { name: 'One' });
      const second = await updateProgramme(tx, PROGRAMME_A1, first?.version ?? -1, {});
      expect(first?.version).toBeGreaterThan(before.version);
      expect(second?.version).toBeGreaterThan(first?.version ?? Infinity);
      expect(second?.name).toBe('One');

      await expect(
        updateProgramme(tx, PROGRAMME_A1, before.version, { clientName: null }),
      ).rejects.toBeInstanceOf(StaleProgrammeVersionError);
    });
  });

  it('enforces name uniqueness inside the tenant only', async () => {
    await rolledBack(supervisor, async (tx) => {
      const a2 = await findProgrammeById(tx, PROGRAMME_A2);
      await expect(
        updateProgramme(tx, PROGRAMME_A2, a2?.version ?? -1, { name: 'Bank X Collections' }),
      ).rejects.toBeInstanceOf(DuplicateProgrammeNameError);
    });
    await rolledBack({ tenantId: TENANT_B, userId: USER_B_AGENT_1 }, async (tx) => {
      const b1 = await findProgrammeById(tx, PROGRAMME_B1);
      const renamed = await updateProgramme(tx, PROGRAMME_B1, b1?.version ?? -1, {
        name: 'Bank X Collections',
      });
      expect(renamed?.name).toBe('Bank X Collections');
    });
  });
});
