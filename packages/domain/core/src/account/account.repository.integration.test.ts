import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  TENANT_A,
  USER_A_AGENT_1,
  USER_A_SUPERVISOR,
  withTenantTransaction,
  type TenantTx,
} from '@kasuwa/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AccountWriteRefusedError, hierarchyVerdict } from './account-hierarchy';
import {
  AccountProgrammeOutOfScopeError,
  checkAccountHierarchy,
  findAccountById,
  insertAccount,
  listAccounts,
  updateAccountIfVersion,
  type Account,
} from './account.repository';

/**
 * T-0055: the account repository against real Postgres (RLS, 0019's version
 * trigger, 0026's hierarchy guard, CHECKs and composite keys).
 *
 * The point of most of these is the DATABASE path the API's own checks
 * normally pre-empt: the guard's refusal (what a concurrent half-cycle meets)
 * must come back as a reason code, never Postgres text. Every test runs in
 * one transaction that is rolled back, so nothing outlives it. Names invented.
 */

class Rollback extends Error {}

describe('account repository (T-0055)', () => {
  let pool: ReturnType<typeof createPool>;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 3 });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function inRollback(userId: string, work: (tx: TenantTx) => Promise<void>) {
    await expect(
      withTenantTransaction(pool, { tenantId: TENANT_A, userId }, async (tx) => {
        await work(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  /** Runs `work`, which must end in the database refusing a write; returns the error. */
  async function refusal(work: (tx: TenantTx) => Promise<void>): Promise<unknown> {
    let caught: unknown;
    await withTenantTransaction(pool, { tenantId: TENANT_A, userId: USER_A_SUPERVISOR }, (tx) =>
      work(tx),
    ).catch((error: unknown) => {
      caught = error;
    });
    return caught;
  }

  /** A chain of `length` accounts in A1, top first. */
  async function chain(tx: TenantTx, length: number, label: string): Promise<Account[]> {
    const rows: Account[] = [];
    for (let level = 1; level <= length; level += 1) {
      rows.push(
        await insertAccount(tx, PROGRAMME_A1, {
          name: `T0055 ${label} ${level}`,
          parentAccountId: rows.at(-1)?.id ?? null,
        }),
      );
    }
    return rows;
  }

  it('creates and updates with version moving exactly once, and refuses a stale one', async () => {
    await inRollback(USER_A_SUPERVISOR, async (tx) => {
      const created = await insertAccount(tx, PROGRAMME_A1, {
        name: 'T0055 Version',
        tags: ['Probe'],
        phones: [{ type: 'work', e164: '+2348030055900' }],
      });
      expect(created).toMatchObject({ version: 1, tier: null, owner: null, tags: ['Probe'] });
      const target = { id: created.id, programmeId: PROGRAMME_A1, version: 1 };
      const updated = await updateAccountIfVersion(tx, target, {
        tier: 'sme',
        ownerUserId: USER_A_AGENT_1,
      });
      expect(updated?.version).toBe(2);
      expect(updated?.owner?.id).toBe(USER_A_AGENT_1);
      expect(await updateAccountIfVersion(tx, target, { tier: 'enterprise' })).toBeNull();
    });
  });

  it('refuses to write in a programme outside the session, before SQL', async () => {
    await inRollback(USER_A_AGENT_1, async (tx) => {
      await expect(
        insertAccount(tx, PROGRAMME_A2, { name: 'T0055 Elsewhere' }),
      ).rejects.toBeInstanceOf(AccountProgrammeOutOfScopeError);
    });
  });

  it('walks the committed hierarchy: depth, the moving subtree, and a cycle', async () => {
    await inRollback(USER_A_SUPERVISOR, async (tx) => {
      const levels = await chain(tx, 5, 'Walk');
      const [top, , , fourth, fifth] = levels;
      if (top === undefined || fourth === undefined || fifth === undefined)
        throw new Error('chain');
      const mover = await insertAccount(tx, PROGRAMME_A1, { name: 'T0055 Mover' });
      await insertAccount(tx, PROGRAMME_A1, {
        name: 'T0055 Mover child',
        parentAccountId: mover.id,
      });

      // A new account under depth 5 and under depth 4.
      const underFifth = await checkAccountHierarchy(tx, PROGRAMME_A1, null, fifth.id);
      expect(underFifth).toEqual({ cycle: false, parentDepth: 5, height: 1 });
      expect(hierarchyVerdict(underFifth)).toBe('parent_depth');
      expect(
        hierarchyVerdict(await checkAccountHierarchy(tx, PROGRAMME_A1, null, fourth.id)),
      ).toBeNull();

      // Moving a two-level subtree under depth 4 puts its child at 6.
      const moved = await checkAccountHierarchy(tx, PROGRAMME_A1, mover.id, fourth.id);
      expect(moved).toEqual({ cycle: false, parentDepth: 4, height: 2 });
      expect(hierarchyVerdict(moved)).toBe('parent_depth');

      // The top of the chain under its own descendant, and under itself.
      expect((await checkAccountHierarchy(tx, PROGRAMME_A1, top.id, fifth.id)).cycle).toBe(true);
      expect((await checkAccountHierarchy(tx, PROGRAMME_A1, top.id, top.id)).cycle).toBe(true);
    });
  });

  describe('the database refusals come back as reason codes, never Postgres text', () => {
    it('the 0026 guard refusing a cycle is parent_cycle', async () => {
      const error = await refusal(async (tx) => {
        const [top, , third] = await chain(tx, 3, 'Cycle');
        if (top === undefined || third === undefined) throw new Error('chain');
        await updateAccountIfVersion(
          tx,
          { id: top.id, programmeId: PROGRAMME_A1, version: top.version },
          { parentAccountId: third.id },
        );
      });
      expect(error).toBeInstanceOf(AccountWriteRefusedError);
      expect((error as AccountWriteRefusedError).reason).toBe('parent_cycle');
      expect(JSON.stringify(error)).not.toMatch(/Failing row|T0055 Cycle|23514|account_hierarchy/);
      expect((error as Error).message).not.toMatch(/T0055|ancestor|23514/);
    });

    it('the 0026 guard refusing depth is parent_depth', async () => {
      const error = await refusal(async (tx) => {
        const levels = await chain(tx, 5, 'Deep');
        await insertAccount(tx, PROGRAMME_A1, {
          name: 'T0055 Deep 6',
          parentAccountId: levels.at(-1)?.id ?? null,
        });
      });
      expect(error).toBeInstanceOf(AccountWriteRefusedError);
      expect((error as AccountWriteRefusedError).reason).toBe('parent_depth');
    });

    it('the self-parent CHECK is parent_cycle, without its "Failing row" detail', async () => {
      const error = await refusal(async (tx) => {
        const account = await insertAccount(tx, PROGRAMME_A1, {
          name: 'T0055 Self',
          phones: [{ type: 'mobile', e164: '+2348030055901' }],
        });
        await updateAccountIfVersion(
          tx,
          { id: account.id, programmeId: PROGRAMME_A1, version: account.version },
          { parentAccountId: account.id },
        );
      });
      expect(error).toBeInstanceOf(AccountWriteRefusedError);
      expect((error as AccountWriteRefusedError).reason).toBe('parent_cycle');
      expect(Object.values(error as object).join(' ')).not.toMatch(/Failing row|2348030055901/);
    });

    it('a parent in another programme (the composite key) is unknown_parent', async () => {
      const error = await refusal(async (tx) => {
        const elsewhere = await insertAccount(tx, PROGRAMME_A2, { name: 'T0055 Elsewhere' });
        await insertAccount(tx, PROGRAMME_A1, {
          name: 'T0055 Crossed',
          parentAccountId: elsewhere.id,
        });
      });
      expect(error).toBeInstanceOf(AccountWriteRefusedError);
      expect((error as AccountWriteRefusedError).reason).toBe('unknown_parent');
    });
  });

  it('searches the name only, as a literal, folded substring, inside scope', async () => {
    await inRollback(USER_A_AGENT_1, async (tx) => {
      const oja = await insertAccount(tx, PROGRAMME_A1, {
        name: 'T0055 Ọjà Foods',
        industry: 'T0055Industry',
      });
      const ids = async (search: string) =>
        (await listAccounts(tx, { limit: 100, search })).data.map((account) => account.id);
      expect(await ids('t0055 oja')).toEqual([oja.id]);
      expect(await ids('T0055Industry')).toEqual([]);
      expect(await ids('T0055 %')).toEqual([]);
      expect(await findAccountById(tx, oja.id)).not.toBeNull();
    });
  });
});
