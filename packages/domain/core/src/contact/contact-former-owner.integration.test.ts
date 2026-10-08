import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  runSeed,
  SEED_CONTACTS,
  SEED_PERMISSION_SETS,
  TENANT_A,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_SUPERVISOR,
  withTenantTransaction,
  type TenantTx,
} from '@kasuwa/db';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
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

  it('a removal that unassigns nothing is still audited, once, with "0" (CLAUDE.md 6.7)', async () => {
    await inRollback(USER_A_SUPERVISOR, async (tx) => {
      // The seed's A1 contacts have no owner, so agent 1 owns nothing in A1.
      const owned = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM contact
          WHERE tenant_id = $1 AND programme_id = $2 AND owner_user_id = $3`,
        [TENANT_A, PROGRAMME_A1, USER_A_AGENT_1],
      );
      expect(owned[0]?.n, 'fixture: agent 1 owns no A1 contact').toBe(0);
      expect(await removeAgent1FromA1(tx)).toHaveLength(1);

      const events = await tx.query<{
        actor_user_id: string | null;
        programme_id: string | null;
        changes: unknown;
      }>(
        `SELECT actor_user_id, programme_id, changes
           FROM audit_event
          WHERE tenant_id = $1
            AND changes @> '[{"field": "unassignedContacts"}]'::jsonb
            AND occurred_at >= transaction_timestamp()`,
        [TENANT_A],
      );
      expect(events).toEqual([
        {
          actor_user_id: USER_A_SUPERVISOR,
          programme_id: PROGRAMME_A1,
          changes: [
            { field: 'removedMember', before: USER_A_AGENT_1, after: null, redacted: false },
            { field: 'unassignedContacts', before: null, after: '0', redacted: false },
          ],
        },
      ]);
    });
  });

  it('one statement ending several memberships writes one event each, with its own count (0 included)', async () => {
    const agentSet = SEED_PERMISSION_SETS.find(
      (set) => set.tenantId === TENANT_A && set.key === 'agent',
    );
    if (agentSet === undefined) throw new Error('Fixture drift: no agent set');
    await inRollback(USER_A_SUPERVISOR, async (tx) => {
      // Agent 2 joins A1 too, owning nothing there: that event must say "0".
      await tx.query(
        `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
         VALUES ($1, $2, $3, $4)`,
        [USER_A_AGENT_2, PROGRAMME_A1, TENANT_A, agentSet.id],
      );
      for (let i = 0; i < 2; i += 1) {
        await insertContact(tx, PROGRAMME_A1, {
          displayName: `T0103 A1 ${i}`,
          ownerUserId: USER_A_AGENT_1,
        });
      }
      for (let i = 0; i < 3; i += 1) {
        await insertContact(tx, PROGRAMME_A2, {
          displayName: `T0103 A2 ${i}`,
          ownerUserId: USER_A_AGENT_2,
        });
      }
      const removed = await tx.query(
        `DELETE FROM user_programme
          WHERE tenant_id = $1
            AND ((user_id = $2 AND programme_id = $4)
              OR (user_id = $3 AND programme_id = ANY (ARRAY[$4, $5]::uuid[])))
         RETURNING user_id`,
        [TENANT_A, USER_A_AGENT_1, USER_A_AGENT_2, PROGRAMME_A1, PROGRAMME_A2],
      );
      expect(removed).toHaveLength(3);

      const events = await tx.query<{
        programme_id: string;
        changes: { field: string; before: string | null; after: string | null }[];
      }>(
        `SELECT programme_id, changes
           FROM audit_event
          WHERE tenant_id = $1
            AND changes @> '[{"field": "removedMember"}]'::jsonb
            AND occurred_at >= transaction_timestamp()`,
        [TENANT_A],
      );
      const counts = events
        .map((event) => {
          const member = event.changes.find((entry) => entry.field === 'removedMember');
          const count = event.changes.find((entry) => entry.field === 'unassignedContacts');
          return `${member?.before ?? '?'}@${event.programme_id}=${count?.after ?? '?'}`;
        })
        .sort();
      expect(counts).toEqual(
        [
          `${USER_A_AGENT_1}@${PROGRAMME_A1}=2`,
          `${USER_A_AGENT_2}@${PROGRAMME_A1}=0`,
          `${USER_A_AGENT_2}@${PROGRAMME_A2}=3`,
        ].sort(),
      );
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
      const events = await tx.query(
        `SELECT 1 FROM audit_event
          WHERE tenant_id = $1
            AND changes @> '[{"field": "removedMember"}]'::jsonb
            AND occurred_at >= transaction_timestamp()`,
        [TENANT_A],
      );
      expect(events, 'no membership ended, so no removal event').toEqual([]);
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

interface Latch<T = void> {
  open: (value: T) => void;
  wait: Promise<T>;
}

function latch<T = void>(): Latch<T> {
  let open: (value: T) => void = () => undefined;
  const wait = new Promise<T>((resolvePromise) => {
    open = resolvePromise;
  });
  return { open, wait };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; code: string };

const settle = <T>(work: Promise<T>): Promise<Outcome<T>> =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, code: String((error as { code?: unknown }).code ?? error) }),
  );

/**
 * Migration review, major 1 (reproduced on the row-level first version): one
 * statement ending memberships A and B, racing an assignment that moves a
 * contact from A to B, deadlocked (40P01, a 500 for the assigner). The
 * statement-level trigger takes every lock first, in key order, and only then
 * touches contacts. These rows are COMMITTED (two transactions must see them),
 * so the seed is restored after each test.
 */
describe('a removal of two memberships racing a re-assignment between them (T-0103 review)', () => {
  let appPool: ReturnType<typeof createPool>;
  let migrator: ReturnType<typeof createPool>;

  beforeAll(() => {
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 4 });
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  afterEach(async () => {
    await runSeed({ connectionString: inject('migrationUrl') });
  });

  afterAll(async () => {
    await appPool.end();
    await migrator.end();
  });

  const supervisor = { tenantId: TENANT_A, userId: USER_A_SUPERVISOR };

  async function isBlocked(pid: number): Promise<boolean> {
    const result = await migrator.query<{ blocked: boolean }>(
      'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
      [pid],
    );
    return result.rows[0]?.blocked === true;
  }

  async function waitUntil(what: string, done: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!(await done())) {
      if (Date.now() > deadline) throw new Error(`${what}: not reached within 15 s`);
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    }
  }

  it('no deadlock and no non-member owner: the assignment lands, then the removal unassigns it', async () => {
    const contact = SEED_CONTACTS.find((candidate) => candidate.programmeId === PROGRAMME_A1);
    const agentSet = SEED_PERMISSION_SETS.find(
      (set) => set.tenantId === TENANT_A && set.key === 'agent',
    );
    if (contact === undefined || agentSet === undefined) throw new Error('Fixture drift');
    // Agent 2 joins A1 (membership B); agent 1 (membership A) owns the contact.
    await migrator.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)`,
      [USER_A_AGENT_2, PROGRAMME_A1, TENANT_A, agentSet.id],
    );
    await migrator.query('UPDATE contact SET owner_user_id = $2 WHERE id = $1', [
      contact.id,
      USER_A_AGENT_1,
    ]);

    // The assigner checks B (taking B's shared lock), then pauses.
    const checked = latch();
    const proceed = latch();
    const assignment = settle(
      withTenantTransaction(appPool, supervisor, async (tx) => {
        const current = await findContactById(tx, contact.id);
        if (current === null) throw new Error('fixture contact not visible');
        expect(await programmeMemberExists(tx, PROGRAMME_A1, USER_A_AGENT_2)).toBe(true);
        checked.open();
        await proceed.wait;
        const moved = await updateContactIfVersion(tx, current, { ownerUserId: USER_A_AGENT_2 });
        return moved?.ownerUserId ?? null;
      }),
    );
    await checked.wait;

    // One statement ends A and B. It must stop on B's lock before it touches
    // the contact; the row-level version had already row-locked it under A.
    const removerPid = latch<number>();
    const removal = settle(
      withTenantTransaction(appPool, supervisor, async (tx) => {
        const [row] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        removerPid.open(row?.pid ?? -1);
        const removed = await tx.query(
          `DELETE FROM user_programme
            WHERE tenant_id = $1 AND programme_id = $2 AND user_id = ANY ($3::uuid[])
           RETURNING user_id`,
          [TENANT_A, PROGRAMME_A1, [USER_A_AGENT_1, USER_A_AGENT_2]],
        );
        return removed.length;
      }),
    );

    try {
      const pid = await removerPid.wait;
      await waitUntil('the removal waits on the assigner', () => isBlocked(pid));
    } finally {
      proceed.open();
    }

    expect(await assignment, 'the assignment answered without a deadlock').toEqual({
      ok: true,
      value: USER_A_AGENT_2,
    });
    expect(await removal, 'the removal committed both memberships').toEqual({ ok: true, value: 2 });

    const after = await migrator.query<{ owner_user_id: string | null }>(
      'SELECT owner_user_id FROM contact WHERE id = $1',
      [contact.id],
    );
    expect(after.rows[0]?.owner_user_id, 'unassigned by the removal after the move').toBeNull();
    const strays = await migrator.query(
      `SELECT c.id FROM contact c
        WHERE c.programme_id = $1 AND c.owner_user_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM user_programme up
                           WHERE up.tenant_id = c.tenant_id AND up.programme_id = c.programme_id
                             AND up.user_id = c.owner_user_id)`,
      [PROGRAMME_A1],
    );
    expect(strays.rows, 'A1 contacts owned by a non-member').toEqual([]);
  });

  it('the removal first: the assigner waits on the lock, then is refused as a non-member', async () => {
    const contact = SEED_CONTACTS.find((candidate) => candidate.programmeId === PROGRAMME_A1);
    const agentSet = SEED_PERMISSION_SETS.find(
      (set) => set.tenantId === TENANT_A && set.key === 'agent',
    );
    if (contact === undefined || agentSet === undefined) throw new Error('Fixture drift');
    await migrator.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)`,
      [USER_A_AGENT_2, PROGRAMME_A1, TENANT_A, agentSet.id],
    );
    await migrator.query('UPDATE contact SET owner_user_id = $2 WHERE id = $1', [
      contact.id,
      USER_A_AGENT_1,
    ]);

    const removed = latch();
    const release = latch();
    const removal = settle(
      withTenantTransaction(appPool, supervisor, async (tx) => {
        const rows = await tx.query(
          `DELETE FROM user_programme
            WHERE tenant_id = $1 AND programme_id = $2 AND user_id = ANY ($3::uuid[])
           RETURNING user_id`,
          [TENANT_A, PROGRAMME_A1, [USER_A_AGENT_1, USER_A_AGENT_2]],
        );
        removed.open();
        await release.wait;
        return rows.length;
      }),
    );
    await removed.wait;

    const assignerPid = latch<number>();
    const assignment = settle(
      withTenantTransaction(appPool, supervisor, async (tx) => {
        const [row] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        assignerPid.open(row?.pid ?? -1);
        return programmeMemberExists(tx, PROGRAMME_A1, USER_A_AGENT_2);
      }),
    );
    try {
      const pid = await assignerPid.wait;
      await waitUntil('the owner check waits on the removal', () => isBlocked(pid));
    } finally {
      release.open();
    }
    expect(await removal).toEqual({ ok: true, value: 2 });
    expect(await assignment, 'after the removal commits, B is no member').toEqual({
      ok: true,
      value: false,
    });
  });
});
