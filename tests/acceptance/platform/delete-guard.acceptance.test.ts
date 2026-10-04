import { randomUUID } from 'node:crypto';
import {
  BU_A,
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  SEED_PERMISSION_SETS,
  SEED_TENANTS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import type { TenantTx } from '@kasuwa/db';
import { archiveProgramme } from '@kasuwa/domain-core';
import { reseed } from '@kasuwa/testing';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

/**
 * ACCEPTANCE — T-0047, the DELETE guard on `"user"` and `programme` (Agent 1;
 * team/DECISIONS.md D-L55, follow-up to T-0046 / migration 0021).
 *
 * Written by Agent 12 from the invariants, before any fix exists (D-L25). If
 * the task file and this suite disagree, say so in the report; do not edit it.
 *
 * Every attack runs AS kasuwa_app INSIDE A REAL `withTenantTransaction`, so the
 * scope is the one the database resolves from `user_programme`, never one the
 * test chose. `withTenantTransaction` COMMITS: on `main` the deletes below
 * succeed, land and cascade, which is why every test reseeds afterwards.
 *
 * ------------------------------------------------------------------------
 * THE THREAT. user_programme's two parent FKs are ON DELETE CASCADE (0001), and
 * a referential action bypasses row security. So whoever can DELETE a `"user"`
 * or a `programme` row removes memberships without ever touching
 * user_programme, and 0021's guard on user_programme never runs. "user" is
 * tenant-scoped only (0001 user_isolation), so any session in the tenant —
 * including one that reaches NO programme — can delete the tenant admin. That
 * is the lockout T-0046 closed for direct membership deletes.
 *
 * THE DESIGN THIS SUITE ASSUMES. State it once:
 *
 *   D1. NOBODY on kasuwa_app may DELETE a `"user"` or `programme` row — not a
 *       plain agent, not a programme `admin`, not a tenant admin. Checked on
 *       `main` (grep of apps/ and packages/ for DELETE on either table, raw SQL
 *       and Drizzle): no application path deletes either. Users are DEACTIVATED
 *       (`"user".status`, which 0015 grants and resolve_session already reads);
 *       programmes are ARCHIVED (`archiveProgramme` is a `status` UPDATE that
 *       "deletes nothing", programme-lifecycle.ts). A privilege nothing uses is
 *       only attack surface, so the tenant-admin-may-delete variant the task
 *       mentions is not asserted; it would need a use first, and then this file
 *       changes (a lead decision, not the builder's).
 *
 *   D2. A refusal is EITHER 42501 OR 0 rows. The suite accepts both, so it does
 *       not pick between `REVOKE DELETE` (42501 on every attempt) and a
 *       restrictive `USING (false)`-style policy (0 rows). The recommended one
 *       is the REVOKE: one statement, visible in the catalogue, nothing to
 *       evaluate per row, and its 42501 depends on the table, never on the row,
 *       so it reveals nothing about existence (CLAUDE.md 6.4). What every test
 *       asserts regardless is the END STATE: the tenant's users, programmes,
 *       memberships and contacts are exactly as they were.
 *
 *   D3. The SAME holds for the parents ABOVE programme, because a guard on
 *       programme is worthless if the row can be removed around it.
 *       programme -> business_unit and everything -> tenant are ON DELETE
 *       CASCADE too, and business_unit and tenant policies are tenant-only
 *       (0001). On `main` an agent who reaches only A1 can DELETE business unit
 *       BU_A and take A2 — a programme outside his scope — with it, members and
 *       contacts included; any session can DELETE its own tenant. Nothing in
 *       the application deletes either (tenant offboarding is an operator job
 *       on kasuwa_migrator). NOTE FOR THE LEAD: these two tables are beyond the
 *       task file's wording; they are the side door to its stated invariant
 *       ("no cascade removes members"), in the same way T-0046's suite covered
 *       delete-then-reinsert. Strike the describe block if you rule otherwise.
 *
 *   D4. No new SECURITY DEFINER function (CLAUDE.md 2.7): still exactly two.
 *
 *   D5. kasuwa_migrator is untouched: its deletes still cascade (seed and
 *       provisioning use TRUNCATE ... CASCADE and plain DELETEs as the
 *       migrator, and offboarding will). A BEFORE DELETE trigger would break
 *       this, which is why it is asserted.
 *
 * NOT ASSERTED, and why:
 *   * TRUNCATE: kasuwa_app holds none today (bootstrap's default privileges are
 *     SELECT/INSERT/UPDATE/DELETE); asserted below as a guard, since TRUNCATE
 *     skips RLS entirely and would make D1 moot.
 *   * `"user".status` is writable by ANY member of the tenant (0015 column
 *     grant + tenant-only user_isolation). If deactivation is the answer to D1,
 *     who may deactivate is the same lockout question. It is an UPDATE, not a
 *     DELETE, so it is outside this task and reported to the lead separately.
 *   * The app.user_id GUC forging residual (ADR-0010). D1 does not read the
 *     session's user at all, so it does not apply here.
 *
 * NO REGRESSION, covered elsewhere and not duplicated here:
 *   tests/acceptance/admin/programme-lifecycle.acceptance.test.ts (archive,
 *     preview, create through the API);
 *   tests/acceptance/tenancy/provisioning.acceptance.test.ts (migrator-side
 *     provisioning);
 *   tests/acceptance/platform/permissions-hardening.acceptance.test.ts (a
 *     tenant admin still deletes a MEMBERSHIP in scope — 0021);
 *   tests/acceptance/tenancy/adversarial.acceptance.test.ts (revoking a
 *     membership applies on the next transaction).
 */

function setId(tenantId: string, key: string): string {
  const set = SEED_PERMISSION_SETS.find(
    (candidate) => candidate.tenantId === tenantId && candidate.key === key,
  );
  if (set === undefined) {
    throw new Error(`Fixture drift: tenant ${tenantId} has no seeded permission set '${key}'`);
  }
  return set.id;
}

function programmeName(programmeId: string): string {
  for (const tenant of SEED_TENANTS) {
    const found = tenant.programmes.find((programme) => programme.id === programmeId);
    if (found !== undefined) {
      return found.name;
    }
  }
  throw new Error(`Fixture drift: no seeded programme ${programmeId}`);
}

const ADMIN_SET = setId(TENANT_A, 'admin');
const AGENT_SET = setId(TENANT_A, 'agent');

interface Outcome {
  /** Rows the statement reported, when it did not throw. */
  rows?: number;
  /** SQLSTATE, when it threw. */
  code?: string;
}

/** D2: the two acceptable refusals. */
const REFUSED: Outcome[] = [{ code: '42501' }, { rows: 0 }];

describe('acceptance: DELETE guard on "user" and programme (T-0047)', () => {
  /** kasuwa_app — the role the API runs as. RLS applies. */
  let appPool: Pool;
  /** kasuwa_migrator — BYPASSRLS. Plants shapes and observes rows; never serves. */
  let observer: Pool;

  beforeAll(() => {
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
    observer = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  afterAll(async () => {
    await appPool?.end();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  async function plantMembership(userId: string, programmeId: string, permissionSetId: string) {
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id)
       DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, TENANT_A, permissionSetId],
    );
  }

  async function plantTenantAdmin(userId: string, value: boolean) {
    await observer.query('UPDATE "user" SET is_tenant_admin = $1 WHERE id = $2', [value, userId]);
  }

  /** Runs `fn` as `userId` in a real tenant transaction; captures rows or SQLSTATE. */
  async function attempt(
    tenantId: string,
    userId: string,
    fn: (tx: TenantTx) => Promise<number>,
  ): Promise<Outcome> {
    try {
      const rows = await withTenantTransaction(appPool, { tenantId, userId }, fn);
      return { rows };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return { code: typeof code === 'string' ? code : `non-sql error: ${String(error)}` };
    }
  }

  /** `DELETE ... RETURNING` wrapped so the statement reports how many rows it removed. */
  async function count(tx: TenantTx, sql: string, values: unknown[]): Promise<number> {
    const rows = await tx.query<{ n: number }>(
      `WITH changed AS (${sql} RETURNING 1) SELECT count(*)::int AS n FROM changed`,
      values,
    );
    return rows[0]?.n ?? -1;
  }

  const deleteUser = (tx: TenantTx, userId: string) =>
    count(tx, `DELETE FROM "user" WHERE id = $1`, [userId]);

  const deleteProgramme = (tx: TenantTx, programmeId: string) =>
    count(tx, `DELETE FROM programme WHERE id = $1`, [programmeId]);

  /**
   * Everything a cascade from tenant A's users, programmes, business unit or
   * tenant row could remove, as the migrator sees it. Compared whole, so a
   * cascade anywhere in the tenant shows up, not only in the row attacked.
   */
  async function tenantState(tenantId = TENANT_A) {
    const rows = async (sql: string) =>
      (await observer.query<Record<string, unknown>>(sql, [tenantId])).rows;
    return {
      tenant: await rows(`SELECT id FROM tenant WHERE id = $1`),
      businessUnits: await rows(`SELECT id FROM business_unit WHERE tenant_id = $1 ORDER BY id`),
      users: await rows(
        `SELECT id, status, is_tenant_admin FROM "user" WHERE tenant_id = $1 ORDER BY id`,
      ),
      programmes: await rows(`SELECT id, status FROM programme WHERE tenant_id = $1 ORDER BY id`),
      memberships: await rows(
        `SELECT user_id, programme_id, permission_set_id
           FROM user_programme WHERE tenant_id = $1 ORDER BY user_id, programme_id`,
      ),
      contactsPerProgramme: await rows(
        `SELECT programme_id, count(*)::int AS n
           FROM contact WHERE tenant_id = $1 GROUP BY programme_id ORDER BY programme_id`,
      ),
    };
  }

  type TenantState = Awaited<ReturnType<typeof tenantState>>;

  /** Non-vacuity: the state compared must actually contain what an attack would remove. */
  function expectPopulated(state: TenantState) {
    expect(state.tenant, 'precondition: tenant A exists').toHaveLength(1);
    expect(state.users.length, 'precondition: tenant A has users').toBeGreaterThanOrEqual(4);
    expect(state.programmes.length, 'precondition: tenant A has programmes').toBe(2);
    expect(state.memberships.length, 'precondition: tenant A has memberships').toBeGreaterThan(0);
    expect(
      state.contactsPerProgramme.length,
      'precondition: tenant A has contacts',
    ).toBeGreaterThan(0);
  }

  beforeEach(async () => {
    // The seed's shape, stated rather than trusted: the supervisor is the
    // tenant admin with `admin` in A1 and A2; the agents are not tenant admins.
    await plantTenantAdmin(USER_A_SUPERVISOR, true);
    for (const userId of [USER_A_AGENT_1, USER_A_AGENT_2, USER_A_NO_PROGRAMME]) {
      await plantTenantAdmin(userId, false);
    }
    await plantMembership(USER_A_SUPERVISOR, PROGRAMME_A1, ADMIN_SET);
    await plantMembership(USER_A_SUPERVISOR, PROGRAMME_A2, ADMIN_SET);
    await plantMembership(USER_A_AGENT_1, PROGRAMME_A1, AGENT_SET);
    await plantMembership(USER_A_AGENT_2, PROGRAMME_A2, AGENT_SET);
  });

  // ==========================================================================
  // 1. "user" — nobody on kasuwa_app deletes a user (D1)
  // ==========================================================================

  describe('"user": no session deletes a user row, so no cascade removes memberships (D1, D2)', () => {
    it('a plain agent cannot delete the tenant admin: refused, and the tenant is exactly as it was', async () => {
      // The lockout itself: the supervisor's row goes, and with it both of his
      // `admin` memberships, by cascade, past 0021.
      const before = await tenantState();
      expectPopulated(before);

      const outcome = await attempt(TENANT_A, USER_A_AGENT_1, (tx) =>
        deleteUser(tx, USER_A_SUPERVISOR),
      );
      expect(REFUSED, 'deleting the tenant admin must be 42501 or 0 rows').toContainEqual(outcome);
      expect(await tenantState(), 'the delete (or its cascade) changed tenant A').toEqual(before);
    });

    it('a session that reaches NO programme cannot delete the tenant admin either', async () => {
      // "user" is tenant-scoped, not programme-scoped: an empty scope is no
      // obstacle today, so the weakest session in the tenant is enough.
      const before = await tenantState();
      const outcome = await attempt(TENANT_A, USER_A_NO_PROGRAMME, (tx) =>
        deleteUser(tx, USER_A_SUPERVISOR),
      );
      expect(REFUSED).toContainEqual(outcome);
      expect(await tenantState()).toEqual(before);
    });

    it('a non-tenant-admin holding `admin` in A1 cannot delete another member, or himself', async () => {
      // The strongest non-admin there is. Programme `admin` is about the
      // programme's records (D-L53), not about removing people.
      await plantMembership(USER_A_AGENT_1, PROGRAMME_A1, ADMIN_SET);
      await plantMembership(USER_A_AGENT_2, PROGRAMME_A1, AGENT_SET);
      const before = await tenantState();

      for (const [label, target] of [
        ['another member', USER_A_AGENT_2],
        ['himself', USER_A_AGENT_1],
      ] as const) {
        const outcome = await attempt(TENANT_A, USER_A_AGENT_1, (tx) => deleteUser(tx, target));
        expect(REFUSED, `${label}: must be 42501 or 0 rows`).toContainEqual(outcome);
        expect(await tenantState(), `${label}: tenant A changed`).toEqual(before);
      }
    });

    it('a tenant admin cannot delete a user either — users are deactivated, not deleted (D1)', async () => {
      const before = await tenantState();
      for (const [label, target] of [
        ['an agent', USER_A_AGENT_1],
        ['himself', USER_A_SUPERVISOR],
      ] as const) {
        const outcome = await attempt(TENANT_A, USER_A_SUPERVISOR, (tx) => deleteUser(tx, target));
        expect(REFUSED, `tenant admin deleting ${label}: must be 42501 or 0 rows`).toContainEqual(
          outcome,
        );
        expect(await tenantState(), `${label}: tenant A changed`).toEqual(before);
      }
    });

    it('a tenant admin can still DEACTIVATE a user (status), and the memberships stay', async () => {
      // Passes on main. Guard: the alternative D1 relies on stays open to a
      // tenant admin, so the fix cannot be "revoke every write on user".
      const outcome = await attempt(TENANT_A, USER_A_SUPERVISOR, (tx) =>
        count(tx, `UPDATE "user" SET status = 'disabled' WHERE id = $1`, [USER_A_AGENT_1]),
      );
      expect(outcome).toEqual({ rows: 1 });
      const after = await observer.query<{ status: string }>(
        `SELECT status FROM "user" WHERE id = $1`,
        [USER_A_AGENT_1],
      );
      expect(after.rows).toEqual([{ status: 'disabled' }]);
      const kept = await observer.query(
        `SELECT 1 FROM user_programme WHERE user_id = $1 AND programme_id = $2`,
        [USER_A_AGENT_1, PROGRAMME_A1],
      );
      expect(kept.rowCount, 'deactivation removed a membership').toBe(1);
    });

    it('a tenant-B session cannot delete a tenant-A user', async () => {
      // Passes on main (tenant isolation). Guard.
      const before = await tenantState();
      const outcome = await attempt(TENANT_B, USER_B_AGENT_1, (tx) =>
        deleteUser(tx, USER_A_SUPERVISOR),
      );
      expect(REFUSED).toContainEqual(outcome);
      expect(await tenantState()).toEqual(before);
    });
  });

  // ==========================================================================
  // 2. programme — nobody on kasuwa_app deletes a programme (D1)
  // ==========================================================================

  describe('programme: no session deletes a programme it reaches, so no cascade removes members (D1, D2)', () => {
    it('a plain agent cannot delete the programme he works in: refused, members and contacts intact', async () => {
      const before = await tenantState();
      expectPopulated(before);

      const outcome = await attempt(TENANT_A, USER_A_AGENT_1, (tx) =>
        deleteProgramme(tx, PROGRAMME_A1),
      );
      expect(REFUSED, 'deleting a reachable programme must be 42501 or 0 rows').toContainEqual(
        outcome,
      );
      expect(await tenantState(), 'the delete (or its cascade) changed tenant A').toEqual(before);
    });

    it('a non-tenant-admin holding `admin` in A1 cannot delete A1', async () => {
      await plantMembership(USER_A_AGENT_1, PROGRAMME_A1, ADMIN_SET);
      const before = await tenantState();
      const outcome = await attempt(TENANT_A, USER_A_AGENT_1, (tx) =>
        deleteProgramme(tx, PROGRAMME_A1),
      );
      expect(REFUSED).toContainEqual(outcome);
      expect(await tenantState()).toEqual(before);
    });

    it('a tenant admin cannot delete a programme either — programmes are archived, not deleted (D1)', async () => {
      const before = await tenantState();
      const outcome = await attempt(TENANT_A, USER_A_SUPERVISOR, (tx) =>
        deleteProgramme(tx, PROGRAMME_A2),
      );
      expect(REFUSED, 'tenant admin deleting A2: must be 42501 or 0 rows').toContainEqual(outcome);
      expect(await tenantState()).toEqual(before);
    });

    it('a session reaching only A1 cannot delete A2', async () => {
      // Passes on main (0001 programme_isolation). Guard.
      const before = await tenantState();
      const outcome = await attempt(TENANT_A, USER_A_AGENT_1, (tx) =>
        deleteProgramme(tx, PROGRAMME_A2),
      );
      expect(REFUSED).toContainEqual(outcome);
      expect(await tenantState()).toEqual(before);
    });

    it('archiving a programme (the supported path) still works and removes no member', async () => {
      // Passes on main. Guard: archive is a status UPDATE, and the fix must
      // not reach it. Full API coverage is in programme-lifecycle.
      const archived = await withTenantTransaction(
        appPool,
        { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
        (tx) => archiveProgramme(tx, PROGRAMME_A2, programmeName(PROGRAMME_A2)),
      );
      expect(archived, 'archiveProgramme found no reachable A2').not.toBeNull();
      const state = await tenantState();
      expect(state.programmes).toContainEqual({ id: PROGRAMME_A2, status: 'archived' });
      expect(state.memberships).toContainEqual({
        user_id: USER_A_AGENT_2,
        programme_id: PROGRAMME_A2,
        permission_set_id: AGENT_SET,
      });
    });
  });

  // ==========================================================================
  // 3. side doors — the parents above programme cascade too (D3)
  // ==========================================================================

  describe('side doors: business_unit and tenant deletes cascade into programme and membership (D3)', () => {
    it('an agent reaching only A1 cannot delete the business unit, which would take A2 (out of his scope) with it', async () => {
      // A1 and A2 both hang off BU_A. business_unit is tenant-scoped, so on
      // main this removes a programme the session cannot even read.
      const before = await tenantState();
      expectPopulated(before);
      expect(before.businessUnits, 'precondition: BU_A is tenant A’s business unit').toEqual([
        { id: BU_A },
      ]);

      const outcome = await attempt(TENANT_A, USER_A_AGENT_1, (tx) =>
        count(tx, `DELETE FROM business_unit WHERE id = $1`, [BU_A]),
      );
      expect(REFUSED, 'deleting the business unit must be 42501 or 0 rows').toContainEqual(outcome);
      expect(await tenantState(), 'the cascade from business_unit changed tenant A').toEqual(
        before,
      );
    });

    it('a tenant admin cannot delete the business unit either', async () => {
      const before = await tenantState();
      const outcome = await attempt(TENANT_A, USER_A_SUPERVISOR, (tx) =>
        count(tx, `DELETE FROM business_unit WHERE id = $1`, [BU_A]),
      );
      expect(REFUSED).toContainEqual(outcome);
      expect(await tenantState()).toEqual(before);
    });

    it('no session — not even a tenant admin — can delete its own tenant row', async () => {
      // tenant_isolation admits the session's own tenant, and every tenant-
      // scoped table cascades from it: one statement empties the tenant.
      for (const [label, userId] of [
        ['a session with no programme', USER_A_NO_PROGRAMME],
        ['the tenant admin', USER_A_SUPERVISOR],
      ] as const) {
        const before = await tenantState();
        expectPopulated(before);
        const outcome = await attempt(TENANT_A, userId, (tx) =>
          count(tx, `DELETE FROM tenant WHERE id = $1`, [TENANT_A]),
        );
        expect(REFUSED, `${label}: must be 42501 or 0 rows`).toContainEqual(outcome);
        expect(await tenantState(), `${label}: tenant A changed`).toEqual(before);
      }
    });

    it('kasuwa_app holds no TRUNCATE on any table in the cascade chain (guard: TRUNCATE skips RLS)', async () => {
      // Passes on main. Non-vacuity: the same query must see a privilege that
      // IS held (SELECT), and must see TRUNCATE once it is granted in a
      // rolled-back migrator transaction.
      const tables = ['tenant', 'business_unit', 'programme', '"user"', 'user_programme'];
      const privileges = async (client: Pick<PoolClient, 'query'>, privilege: string) =>
        (
          await client.query<{ t: string }>(
            `SELECT t FROM unnest($1::text[]) AS t
              WHERE has_table_privilege('kasuwa_app', t, $2)`,
            [tables, privilege],
          )
        ).rows.map((row) => row.t);

      expect(await privileges(observer, 'SELECT'), 'the probe sees no privileges at all').toEqual(
        tables,
      );

      const client = await observer.connect();
      try {
        await client.query('BEGIN');
        await client.query('GRANT TRUNCATE ON programme TO kasuwa_app');
        expect(await privileges(client, 'TRUNCATE'), 'the probe missed a planted grant').toEqual([
          'programme',
        ]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }

      expect(await privileges(observer, 'TRUNCATE')).toEqual([]);
    });
  });

  // ==========================================================================
  // 4. no collateral damage
  // ==========================================================================

  describe('no collateral damage (D4, D5)', () => {
    it('kasuwa_migrator can still delete a user, and the delete cascades to the memberships', async () => {
      // A scratch user so the assertion is about the cascade, not the seed.
      const userId = randomUUID();
      await observer.query(
        `INSERT INTO "user" (id, tenant_id, email, display_name)
         VALUES ($1, $2, $3, 'Scratch User')`,
        [userId, TENANT_A, `scratch-${userId}@tenant-a.test`],
      );
      await plantMembership(userId, PROGRAMME_A1, AGENT_SET);
      await plantMembership(userId, PROGRAMME_A2, AGENT_SET);

      const deleted = await observer.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
      expect(deleted.rowCount).toBe(1);
      const left = await observer.query(`SELECT 1 FROM user_programme WHERE user_id = $1`, [
        userId,
      ]);
      expect(left.rowCount, 'the cascade from "user" did not run').toBe(0);
    });

    it('kasuwa_migrator can still delete a programme, and the delete cascades to members and contacts', async () => {
      const programmeId = randomUUID();
      await observer.query(
        `INSERT INTO programme (id, tenant_id, business_unit_id, name)
         VALUES ($1, $2, $3, $4)`,
        [programmeId, TENANT_A, BU_A, `Scratch ${programmeId}`],
      );
      await plantMembership(USER_A_AGENT_1, programmeId, AGENT_SET);
      await observer.query(
        `INSERT INTO contact (id, tenant_id, programme_id, display_name)
         VALUES ($1, $2, $3, 'Scratch Contact')`,
        [randomUUID(), TENANT_A, programmeId],
      );

      const deleted = await observer.query(`DELETE FROM programme WHERE id = $1`, [programmeId]);
      expect(deleted.rowCount).toBe(1);
      const members = await observer.query(`SELECT 1 FROM user_programme WHERE programme_id = $1`, [
        programmeId,
      ]);
      const contacts = await observer.query(`SELECT 1 FROM contact WHERE programme_id = $1`, [
        programmeId,
      ]);
      expect(members.rowCount, 'the cascade from programme did not reach user_programme').toBe(0);
      expect(contacts.rowCount, 'the cascade from programme did not reach contact').toBe(0);
    });

    it('kasuwa_migrator can still offboard a whole tenant, and nothing of it is left', async () => {
      const before = await tenantState(TENANT_B);
      expect(before.users.length, 'precondition: tenant B has users').toBeGreaterThan(0);
      expect(before.memberships.length, 'precondition: tenant B has memberships').toBeGreaterThan(
        0,
      );

      const deleted = await observer.query(`DELETE FROM tenant WHERE id = $1`, [TENANT_B]);
      expect(deleted.rowCount).toBe(1);
      expect(await tenantState(TENANT_B)).toEqual({
        tenant: [],
        businessUnits: [],
        users: [],
        programmes: [],
        memberships: [],
        contactsPerProgramme: [],
      });
    });

    it('the fix adds no SECURITY DEFINER function: exactly the two CLAUDE.md 2.7 documents', async () => {
      const definers = await observer.query<{ name: string }>(
        `SELECT n.nspname || '.' || p.proname AS name
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prosecdef
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          ORDER BY 1`,
      );
      expect(definers.rows.map((row) => row.name)).toEqual([
        'app.resolve_session',
        'app.resolve_tenant_by_slug',
      ]);
    });
  });
});
