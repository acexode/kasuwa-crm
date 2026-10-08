import {
  createPool,
  PROGRAMME_A1,
  TENANT_A,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_SUPERVISOR,
  withTenantTransaction,
  type TenantTx,
} from '@kasuwa/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  findContactById,
  insertContact,
  listContacts,
  programmeMemberExists,
  updateContactIfVersion,
} from './contact.repository';

/**
 * T-0103 (D-P23, D-L99) against real Postgres, RLS on, as kasuwa_app:
 *   - the owner subquery names only a member of the contact's programme;
 *   - migration 0031's trigger unassigns a removed member's contacts in the
 *     removing transaction, with one audit event carrying the count;
 *   - the owner check's shared advisory lock and the trigger's exclusive one
 *     are the SAME lock, for an agent session too.
 * Every transaction here rolls back, so nothing outlives the test. Values
 * are invented. The acceptance suite (records/former-owner) is the contract.
 */

class Rollback extends Error {}

const LOCK_NOT_AVAILABLE = '55P03';

describe('a former owner (T-0103)', () => {
  let pool: ReturnType<typeof createPool>;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 4 });
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

  const removeAgent1FromA1 = (tx: TenantTx) =>
    tx.query<{ user_id: string }>(
      `DELETE FROM user_programme
        WHERE tenant_id = $1 AND user_id = $2 AND programme_id = $3
       RETURNING user_id`,
      [TENANT_A, USER_A_AGENT_1, PROGRAMME_A1],
    );

  it('an owner outside the contact’s programme reads as { id, displayName: null } on every path', async () => {
    await inRollback(USER_A_SUPERVISOR, async (tx) => {
      const created = await insertContact(tx, PROGRAMME_A1, {
        displayName: 'T0103 Former',
        ownerUserId: USER_A_AGENT_1,
      });
      expect(created.owner?.displayName).toEqual(expect.any(String));

      // The repository does not judge membership (the API does, D-L67), so
      // a non-member owner can be written here to stand for an old row.
      const moved = await updateContactIfVersion(tx, created, { ownerUserId: USER_A_AGENT_2 });
      const former = { id: USER_A_AGENT_2, displayName: null };
      expect(moved?.owner).toEqual(former);
      expect((await findContactById(tx, created.id))?.owner).toEqual(former);
      const page = await listContacts(tx, {
        limit: 100,
        filters: { ownerUserIds: [USER_A_AGENT_2] },
      });
      expect(page.data.find((row) => row.id === created.id)?.owner).toEqual(former);
    });
  });

  it('removing a member unassigns their contacts there, version + 1, with one counted audit event', async () => {
    await inRollback(USER_A_SUPERVISOR, async (tx) => {
      const first = await insertContact(tx, PROGRAMME_A1, {
        displayName: 'T0103 One',
        ownerUserId: USER_A_AGENT_1,
      });
      const second = await insertContact(tx, PROGRAMME_A1, {
        displayName: 'T0103 Two',
        ownerUserId: USER_A_AGENT_1,
      });
      expect(await removeAgent1FromA1(tx)).toHaveLength(1);

      for (const contact of [first, second]) {
        const now = await findContactById(tx, contact.id);
        expect(now?.ownerUserId).toBeNull();
        expect(now?.owner).toBeNull();
        expect(now?.version).toBe(contact.version + 1);
      }

      const events = await tx.query<{
        actor_user_id: string | null;
        object_type: string;
        programme_id: string | null;
        changes: { field: string; before: string | null; after: string | null }[];
      }>(
        `SELECT actor_user_id, object_type, programme_id, changes
           FROM audit_event
          WHERE tenant_id = $1
            AND changes @> '[{"field": "unassignedContacts"}]'::jsonb
            AND occurred_at >= transaction_timestamp()`,
        [TENANT_A],
      );
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event?.actor_user_id).toBe(USER_A_SUPERVISOR);
      expect(event?.object_type).toBe('programme');
      expect(event?.programme_id).toBe(PROGRAMME_A1);
      expect(event?.changes).toEqual([
        { field: 'removedMember', before: USER_A_AGENT_1, after: null, redacted: false },
        { field: 'unassignedContacts', before: null, after: '2', redacted: false },
      ]);
    });
  });

  it('a permission-set change is not a removal: no owner moves', async () => {
    await inRollback(USER_A_SUPERVISOR, async (tx) => {
      const owned = await insertContact(tx, PROGRAMME_A1, {
        displayName: 'T0103 Kept',
        ownerUserId: USER_A_AGENT_1,
      });
      await tx.query(
        `UPDATE user_programme SET permission_set_id = permission_set_id
          WHERE tenant_id = $1 AND user_id = $2 AND programme_id = $3`,
        [TENANT_A, USER_A_AGENT_1, PROGRAMME_A1],
      );
      const now = await findContactById(tx, owned.id);
      expect(now?.ownerUserId).toBe(USER_A_AGENT_1);
      expect(now?.version).toBe(owned.version);
    });
  });

  /**
   * Holds `first` open until `second` has run (or failed), then rolls both
   * back. `second` runs with a short lock_timeout, so "it waits" shows as
   * 55P03 instead of a hang.
   */
  async function whileHeld(
    firstUser: string,
    first: (tx: TenantTx) => Promise<void>,
    secondUser: string,
    second: (tx: TenantTx) => Promise<void>,
  ): Promise<unknown> {
    let outcome: unknown;
    await inRollback(firstUser, async (held) => {
      await first(held);
      try {
        await withTenantTransaction(pool, { tenantId: TENANT_A, userId: secondUser }, async (tx) => {
          await tx.query(`SET LOCAL lock_timeout = '300ms'`);
          await second(tx);
          throw new Rollback();
        });
      } catch (error) {
        outcome = error instanceof Rollback ? 'completed' : error;
      }
    });
    return outcome;
  }

  it('an agent’s owner check holds the membership lock: a removal waits for it (D-L99 trap)', async () => {
    const outcome = await whileHeld(
      USER_A_AGENT_1,
      async (tx) => {
        expect(await programmeMemberExists(tx, PROGRAMME_A1, USER_A_AGENT_1)).toBe(true);
      },
      USER_A_SUPERVISOR,
      async (tx) => {
        await removeAgent1FromA1(tx);
      },
    );
    expect(outcome).toMatchObject({ code: LOCK_NOT_AVAILABLE });
  });

  it('a removal holds the membership lock: an owner check waits for it, upper-case id included', async () => {
    const outcome = await whileHeld(
      USER_A_SUPERVISOR,
      async (tx) => {
        expect(await removeAgent1FromA1(tx)).toHaveLength(1);
      },
      USER_A_AGENT_1,
      async (tx) => {
        await programmeMemberExists(tx, PROGRAMME_A1, USER_A_AGENT_1.toUpperCase());
      },
    );
    expect(outcome).toMatchObject({ code: LOCK_NOT_AVAILABLE });
  });

  it('an owner check for another member does not wait on the removal', async () => {
    const outcome = await whileHeld(
      USER_A_SUPERVISOR,
      async (tx) => {
        expect(await removeAgent1FromA1(tx)).toHaveLength(1);
      },
      USER_A_SUPERVISOR,
      async (tx) => {
        expect(await programmeMemberExists(tx, PROGRAMME_A1, USER_A_SUPERVISOR)).toBe(true);
      },
    );
    expect(outcome).toBe('completed');
  });
});
