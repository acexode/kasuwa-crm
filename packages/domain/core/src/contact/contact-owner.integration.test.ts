import {
  createPool,
  PROGRAMME_A1,
  SEED_TENANTS,
  TENANT_A,
  USER_A_AGENT_1,
  USER_A_SUPERVISOR,
  withTenantTransaction,
  type TenantTx,
} from '@kasuwa/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  findContactById,
  insertContact,
  listContacts,
  updateContactIfVersion,
} from './contact.repository';

/**
 * T-0043 — the owner's display name is read in the same statement as the
 * contact, on every path that returns a Contact: list, get, insert and update
 * (RETURNING). Real Postgres, RLS on. Each test rolls back. Values invented.
 */

class Rollback extends Error {}

describe('the embedded contact owner (T-0043)', () => {
  let pool: ReturnType<typeof createPool>;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 3 });
  });

  afterAll(async () => {
    await pool.end();
  });

  const agentName = (() => {
    const user = SEED_TENANTS.flatMap((tenant) => tenant.users).find(
      (candidate) => candidate.id === USER_A_AGENT_1,
    );
    if (user === undefined) throw new Error('Fixture drift: no seeded agent 1');
    return user.displayName;
  })();

  async function inRollback(work: (tx: TenantTx) => Promise<void>) {
    await expect(
      withTenantTransaction(pool, { tenantId: TENANT_A, userId: USER_A_SUPERVISOR }, async (tx) => {
        await work(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  it('insert, get, list and update all carry owner, null exactly when unassigned', async () => {
    await inRollback(async (tx) => {
      const created = await insertContact(tx, PROGRAMME_A1, {
        displayName: 'T0043 Owned',
        ownerUserId: USER_A_AGENT_1,
      });
      const owner = { id: USER_A_AGENT_1, displayName: agentName };
      expect(created.owner).toEqual(owner);

      expect((await findContactById(tx, created.id))?.owner).toEqual(owner);

      const page = await listContacts(tx, {
        limit: 100,
        filters: { ownerUserIds: [USER_A_AGENT_1] },
      });
      expect(page.data.find((row) => row.id === created.id)?.owner).toEqual(owner);

      const cleared = await updateContactIfVersion(tx, created, { ownerUserId: null });
      expect(cleared?.ownerUserId).toBeNull();
      expect(cleared?.owner).toBeNull();

      const unowned = await insertContact(tx, PROGRAMME_A1, { displayName: 'T0043 Unowned' });
      expect(unowned.owner).toBeNull();
    });
  });
});
