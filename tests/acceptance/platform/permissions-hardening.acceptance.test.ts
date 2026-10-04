import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_PERMISSION_SETS,
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
import { reseed } from '@kasuwa/testing';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

/**
 * ACCEPTANCE — T-0046, permissions-engine hardening (Agent 1). Closes the
 * gaps the T-0032 security review left open (team/DECISIONS.md D-L55), on top
 * of D-L53 (tenant admin is a flag on the user) and D-L51 (the database guards
 * programme membership).
 *
 * Written by Agent 12 from the invariants, before any fix exists (D-L25). If
 * the task file and this suite disagree, say so in the report; do not edit it.
 *
 * Every attack runs AS kasuwa_app INSIDE A REAL `withTenantTransaction`, so
 * the scope is the one the database resolves from `user_programme`, never one
 * the test chose. Where a test needs a session with a particular shape (a
 * tenant admin who reaches A1 only; an agent holding `admin` in A1), the shape
 * is PLANTED through kasuwa_migrator in `beforeEach` or in the test, and
 * `afterEach` reseeds. `withTenantTransaction` COMMITS: on `main` the attacks
 * below succeed and land, which is why every test reseeds afterwards.
 *
 * ------------------------------------------------------------------------
 * THE DESIGN THIS SUITE ASSUMES FOR GAP 1 (permission_set_id). State it once:
 *
 *   H1. Only a TENANT ADMIN session (`"user".is_tenant_admin`, D-L53) may
 *       change which permission set a membership carries, and only for a
 *       membership in a programme the session already reaches. The database
 *       enforces it, not only the engine (CLAUDE.md 2.3).
 *
 *   H2. For a non-tenant-admin session, an UPDATE that would change a
 *       membership's set is FILTERED: it affects 0 ROWS and raises no error.
 *       That is what a RESTRICTIVE `FOR UPDATE` policy on `user_programme`
 *       whose USING requires the session's user to be a tenant admin produces
 *       (0015's `user_programme_update_in_scope` is the precedent, and the
 *       0-rows answer is the same one an out-of-scope UPDATE already gets).
 *       0 rows, not 42501, also matches CLAUDE.md 6.4: a refusal that differs
 *       from "no such row" says the row exists. A design that answers 42501
 *       instead (a trigger, a column REVOKE) contradicts H2; that is a change
 *       to this file for the lead, not for the builder.
 *
 *   H3. The same holds for every OTHER way to end up holding a different set
 *       in an existing programme, because a guard on one column is worthless
 *       if the row can be re-made around it. A non-tenant-admin session cannot:
 *         * INSERT a membership carrying a set into a reachable programme
 *           (refused by WITH CHECK, so 42501 — a WITH CHECK cannot filter);
 *         * DELETE its own membership and INSERT it back with `admin`;
 *         * take over another member's `admin` membership by rewriting
 *           `user_id`;
 *         * reach the set through `INSERT ... ON CONFLICT DO UPDATE`.
 *       The compound ones assert the END STATE (the membership is exactly as it
 *       was) and that nothing committed, rather than a particular error,
 *       because more than one sound design refuses them at a different step.
 *
 *   H4. No new SECURITY DEFINER function (CLAUDE.md 2.7, T-0046 goal 1). The
 *       catalogue still has exactly the two documented ones.
 *
 *   H5. The tenant-admin path works with plain SQL in a tenant transaction.
 *       There is no `assignPermissionSet` domain function on `main` and this
 *       suite does not require one. If the chosen design makes a domain
 *       function the ONLY way to change a set (e.g. a role switch inside it),
 *       the raw-SQL positive tests below go red and the lead adds the function
 *       to this file; the negative tests must hold either way.
 *
 * NOT ASSERTED, and why: the tenant-admin check can only read the session's
 * user from `app.user_id`, a GUC kasuwa_app can re-set mid-transaction and
 * restore before COMMIT. ADR-0010 accepts that the scope seal is detection,
 * not a privilege boundary; the same residual applies here and no design
 * without a new role or definer can close it. Recorded, not tested.
 *
 * GAP 2 (membership DELETE): programme-scoped like INSERT (D-L51). A DELETE of
 * a membership in a programme the session does not reach affects 0 rows and
 * the row survives — including in a transaction that has UPDATEd a reachable
 * programme first (the creation-marker forge D-L55 names).
 *
 * GAP 3 (catalogue guards): these PASS on `main`. They are guards, not
 * failing tests — they stop a future migration from opening a forge path for
 * the 0015 creation marker. Each guard is first run against a PLANTED
 * violation in a rolled-back migrator transaction and must catch it, so none
 * of them is a check that has only ever been seen passing.
 *
 * NO REGRESSION (task item 4), covered elsewhere and not duplicated here:
 *   tests/acceptance/platform/permissions.acceptance.test.ts (T-0032): the
 *     403/404 order, per-programme sets, re-resolution on every request, the
 *     D-L51 INSERT/UPDATE scope policies and the D-L55 marker-forge INSERT,
 *     the "user".is_tenant_admin column privilege, and createProgramme's
 *     creator enrolment (which inserts a membership WITH the admin set, as a
 *     tenant admin — it must keep working under H3);
 *   tests/acceptance/tenancy/adversarial.acceptance.test.ts: "applies a
 *     revoked membership on the very next transaction" deletes the
 *     supervisor's own A2 membership as the supervisor (a tenant admin who
 *     reaches A2) — it must keep working under gap 2.
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

const ADMIN_SET = setId(TENANT_A, 'admin');
const AGENT_SET = setId(TENANT_A, 'agent');
const TEAM_LEAD_SET = setId(TENANT_A, 'team_lead');
/** Tenant B's own set, so a cross-tenant UPDATE can never fail on the FK instead of RLS. */
const B_AGENT_SET = setId(TENANT_B, 'agent');

interface Outcome {
  /** Rows the statement reported, when it did not throw. */
  rows?: number;
  /** SQLSTATE, when it threw. */
  code?: string;
}

describe('acceptance: permissions-engine hardening (T-0046)', () => {
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

  /** Write one membership row through the migrator, creating it if needed. */
  async function plantMembership(
    userId: string,
    programmeId: string,
    permissionSetId: string | null,
    tenantId = TENANT_A,
  ) {
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id)
       DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, tenantId, permissionSetId],
    );
  }

  async function plantTenantAdmin(userId: string, value: boolean) {
    await observer.query('UPDATE "user" SET is_tenant_admin = $1 WHERE id = $2', [value, userId]);
  }

  /** The membership as the migrator sees it: null when the row does not exist. */
  async function membership(
    userId: string,
    programmeId: string,
  ): Promise<{ permission_set_id: string | null } | null> {
    const result = await observer.query<{ permission_set_id: string | null }>(
      'SELECT permission_set_id FROM user_programme WHERE user_id = $1 AND programme_id = $2',
      [userId, programmeId],
    );
    return result.rows[0] ?? null;
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

  /** `UPDATE ... RETURNING` wrapped so the statement reports how many rows it changed. */
  async function count(tx: TenantTx, sql: string, values: unknown[]): Promise<number> {
    const rows = await tx.query<{ n: number }>(
      `WITH changed AS (${sql} RETURNING 1) SELECT count(*)::int AS n FROM changed`,
      values,
    );
    return rows[0]?.n ?? -1;
  }

  const setSetOf = (tx: TenantTx, permissionSetId: string, userId: string, programmeId: string) =>
    count(
      tx,
      `UPDATE user_programme SET permission_set_id = $1 WHERE user_id = $2 AND programme_id = $3`,
      [permissionSetId, userId, programmeId],
    );

  const deleteMembership = (tx: TenantTx, userId: string, programmeId: string) =>
    count(tx, `DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2`, [
      userId,
      programmeId,
    ]);

  beforeEach(async () => {
    // The seed's shape, stated rather than trusted (same values the T-0032
    // suite plants): supervisor is tenant admin with `admin` in A1 and A2;
    // the agents are not tenant admins and hold `agent`.
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
  // GAP 1 — who may change a membership's permission set
  // ==========================================================================

  describe('gap 1: only a tenant admin may change a membership’s permission set (H1, H2)', () => {
    it('a non-tenant-admin holding `admin` in A1 changes no set in A1 — another member’s, a tenant admin’s, or its own: 0 rows each, nothing changes', async () => {
      // The strongest non-admin there is: `admin` in the programme, in scope.
      // Programme-scoped writes are his (D-L53); assigning sets is not.
      await plantMembership(USER_A_AGENT_1, PROGRAMME_A1, ADMIN_SET);
      await plantMembership(USER_A_AGENT_2, PROGRAMME_A1, AGENT_SET);

      const cases: [label: string, userId: string, to: string, before: string][] = [
        ['raise another member to admin', USER_A_AGENT_2, ADMIN_SET, AGENT_SET],
        ['demote the tenant admin', USER_A_SUPERVISOR, AGENT_SET, ADMIN_SET],
        ['change his own set', USER_A_AGENT_1, TEAM_LEAD_SET, ADMIN_SET],
      ];
      for (const [label, userId, to, before] of cases) {
        const outcome = await attempt(TENANT_A, USER_A_AGENT_1, (tx) =>
          setSetOf(tx, to, userId, PROGRAMME_A1),
        );
        expect(outcome, `${label}: H2 expects the UPDATE to be filtered (0 rows)`).toEqual({
          rows: 0,
        });
        expect(await membership(userId, PROGRAMME_A1), `${label}: the row changed`).toEqual({
          permission_set_id: before,
        });
      }
    });

    it('a plain agent cannot promote himself to admin in his own programme: 0 rows, still `agent`', async () => {
      const outcome = await attempt(TENANT_A, USER_A_AGENT_1, (tx) =>
        setSetOf(tx, ADMIN_SET, USER_A_AGENT_1, PROGRAMME_A1),
      );
      expect(outcome, 'self-escalation must be filtered (H2)').toEqual({ rows: 0 });
      expect(await membership(USER_A_AGENT_1, PROGRAMME_A1)).toEqual({
        permission_set_id: AGENT_SET,
      });
    });

    it('a tenant admin can change a set in a programme he reaches, and the change commits', async () => {
      // Passes on main: the guard against over-correcting gap 1 into "nobody
      // can assign sets at all".
      const outcome = await attempt(TENANT_A, USER_A_SUPERVISOR, (tx) =>
        setSetOf(tx, TEAM_LEAD_SET, USER_A_AGENT_1, PROGRAMME_A1),
      );
      expect(outcome).toEqual({ rows: 1 });
      expect(await membership(USER_A_AGENT_1, PROGRAMME_A1)).toEqual({
        permission_set_id: TEAM_LEAD_SET,
      });
    });

    it('a tenant admin who reaches only A1 can change A1 sets but not A2 sets, and none in another tenant', async () => {
      // Tenant admin never widens scope (D-L06, D-L53 M4). The A2 and tenant-B
      // cases pass on main through 0015's update policy and tenant isolation;
      // they are guards that the fix keeps them.
      await plantTenantAdmin(USER_A_AGENT_1, true);
      await plantMembership(USER_A_AGENT_2, PROGRAMME_A1, AGENT_SET);

      const inA1 = await attempt(TENANT_A, USER_A_AGENT_1, (tx) =>
        setSetOf(tx, TEAM_LEAD_SET, USER_A_AGENT_2, PROGRAMME_A1),
      );
      expect(inA1, 'reachable programme: the tenant admin may assign').toEqual({ rows: 1 });
      expect(await membership(USER_A_AGENT_2, PROGRAMME_A1)).toEqual({
        permission_set_id: TEAM_LEAD_SET,
      });

      const inA2 = await attempt(TENANT_A, USER_A_AGENT_1, (tx) =>
        setSetOf(tx, ADMIN_SET, USER_A_AGENT_2, PROGRAMME_A2),
      );
      expect(inA2, 'A2 is not reached: the row is invisible').toEqual({ rows: 0 });
      expect(await membership(USER_A_AGENT_2, PROGRAMME_A2)).toEqual({
        permission_set_id: AGENT_SET,
      });

      const crossTenant = await attempt(TENANT_A, USER_A_AGENT_1, (tx) =>
        setSetOf(tx, B_AGENT_SET, USER_B_AGENT_1, PROGRAMME_B1),
      );
      expect(crossTenant, 'tenant B’s membership is invisible from tenant A').toEqual({ rows: 0 });
      expect(await membership(USER_B_AGENT_1, PROGRAMME_B1)).toEqual({
        permission_set_id: setId(TENANT_B, 'admin'),
      });
    });

    it('a tenant admin of tenant B cannot change a tenant-A set', async () => {
      // Passes on main (tenant isolation). Guard.
      const outcome = await attempt(TENANT_B, USER_B_AGENT_1, (tx) =>
        setSetOf(tx, ADMIN_SET, USER_A_AGENT_1, PROGRAMME_A1),
      );
      expect(outcome).toEqual({ rows: 0 });
      expect(await membership(USER_A_AGENT_1, PROGRAMME_A1)).toEqual({
        permission_set_id: AGENT_SET,
      });
    });
  });

  describe('gap 1: the side doors around the column (H3)', () => {
    it('a non-tenant-admin cannot enrol someone in a reachable programme WITH a set: 42501, no row', async () => {
      // An INSERT carrying `admin` is an assignment as surely as an UPDATE.
      // createProgramme's creator enrolment is the one legitimate INSERT with
      // a set, and it runs as a tenant admin (T-0032 suite covers it).
      await plantMembership(USER_A_AGENT_1, PROGRAMME_A1, ADMIN_SET);
      const outcome = await attempt(TENANT_A, USER_A_AGENT_1, (tx) =>
        count(
          tx,
          `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
           VALUES ($1, $2, $3, $4)`,
          [USER_A_NO_PROGRAMME, PROGRAMME_A1, TENANT_A, ADMIN_SET],
        ),
      );
      expect(outcome, 'WITH CHECK refuses; it cannot filter').toEqual({ code: '42501' });
      expect(await membership(USER_A_NO_PROGRAMME, PROGRAMME_A1)).toBeNull();
    });

    it('a non-tenant-admin cannot delete his own membership and re-insert it as admin', async () => {
      // Survives a fix that guards only UPDATE: the row is re-made, not edited.
      const outcome = await attempt(TENANT_A, USER_A_AGENT_1, async (tx) => {
        await deleteMembership(tx, USER_A_AGENT_1, PROGRAMME_A1);
        return count(
          tx,
          `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
           VALUES ($1, $2, $3, $4)`,
          [USER_A_AGENT_1, PROGRAMME_A1, TENANT_A, ADMIN_SET],
        );
      });
      expect(outcome.rows, 'the re-insert as admin committed').toBeUndefined();
      expect(await membership(USER_A_AGENT_1, PROGRAMME_A1), 'the membership changed').toEqual({
        permission_set_id: AGENT_SET,
      });
    });

    it('a non-tenant-admin cannot take over the tenant admin’s `admin` membership by rewriting user_id', async () => {
      // Never touches permission_set_id, so a column-only guard misses it.
      // The accomplice (no membership anywhere) would come out holding `admin`
      // in A1, and the supervisor would silently lose it.
      const outcome = await attempt(TENANT_A, USER_A_AGENT_1, (tx) =>
        count(
          tx,
          `UPDATE user_programme SET user_id = $1 WHERE user_id = $2 AND programme_id = $3`,
          [USER_A_NO_PROGRAMME, USER_A_SUPERVISOR, PROGRAMME_A1],
        ),
      );
      expect(outcome, 'H2: filtered like any other non-admin UPDATE').toEqual({ rows: 0 });
      expect(await membership(USER_A_SUPERVISOR, PROGRAMME_A1)).toEqual({
        permission_set_id: ADMIN_SET,
      });
      expect(await membership(USER_A_NO_PROGRAMME, PROGRAMME_A1)).toBeNull();
    });

    it('a non-tenant-admin cannot reach the set through INSERT ... ON CONFLICT DO UPDATE', async () => {
      const outcome = await attempt(TENANT_A, USER_A_AGENT_1, (tx) =>
        count(
          tx,
          `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, programme_id)
           DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
          [USER_A_AGENT_1, PROGRAMME_A1, TENANT_A, ADMIN_SET],
        ),
      );
      expect(outcome.rows, 'the upsert to admin committed').toBeUndefined();
      expect(await membership(USER_A_AGENT_1, PROGRAMME_A1)).toEqual({
        permission_set_id: AGENT_SET,
      });
    });

    it('the fix adds no SECURITY DEFINER function: exactly the two CLAUDE.md 2.7 documents (H4)', async () => {
      // Deliberately the same census as the T-0032 suite: the task names it
      // as a condition of THIS fix, so it is asserted where the fix is judged.
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

  // ==========================================================================
  // GAP 2 — membership DELETE is programme-scoped
  // ==========================================================================

  describe('gap 2: membership DELETE is programme-scoped', () => {
    it('a session reaching only A1 cannot delete an A2 membership: 0 rows, the row survives', async () => {
      const outcome = await attempt(TENANT_A, USER_A_AGENT_1, (tx) =>
        deleteMembership(tx, USER_A_AGENT_2, PROGRAMME_A2),
      );
      expect(outcome, 'an A1-only session deleted a membership in A2').toEqual({ rows: 0 });
      expect(await membership(USER_A_AGENT_2, PROGRAMME_A2)).toEqual({
        permission_set_id: AGENT_SET,
      });
    });

    it('a tenant admin reaching only A1 cannot delete an A2 membership either', async () => {
      // Tenant admin is not a wildcard (D-L53 M4).
      await plantTenantAdmin(USER_A_AGENT_1, true);
      const outcome = await attempt(TENANT_A, USER_A_AGENT_1, (tx) =>
        deleteMembership(tx, USER_A_SUPERVISOR, PROGRAMME_A2),
      );
      expect(outcome).toEqual({ rows: 0 });
      expect(await membership(USER_A_SUPERVISOR, PROGRAMME_A2)).toEqual({
        permission_set_id: ADMIN_SET,
      });
    });

    it('cannot delete a membership in another tenant', async () => {
      // Passes on main (tenant isolation). Guard.
      const outcome = await attempt(TENANT_A, USER_A_SUPERVISOR, (tx) =>
        deleteMembership(tx, USER_B_AGENT_1, PROGRAMME_B1),
      );
      expect(outcome).toEqual({ rows: 0 });
      expect(await membership(USER_B_AGENT_1, PROGRAMME_B1)).not.toBeNull();
    });

    it('an UPDATE of a reachable programme does not let the same transaction delete a membership in an unreachable one (marker forge)', async () => {
      // D-L55: UPDATE-ing A1 stamps A1's xmin with this transaction's xid. If
      // DELETE borrows INSERT's creation-marker branch, that must still name
      // only A1 — never A2.
      const outcome = await attempt(TENANT_A, USER_A_AGENT_1, async (tx) => {
        const touched = await count(tx, `UPDATE programme SET updated_at = now() WHERE id = $1`, [
          PROGRAMME_A1,
        ]);
        expect(touched, 'precondition: the forge needs A1 rewritten in this transaction').toBe(1);
        return deleteMembership(tx, USER_A_AGENT_2, PROGRAMME_A2);
      });
      expect(outcome).toEqual({ rows: 0 });
      expect(await membership(USER_A_AGENT_2, PROGRAMME_A2)).toEqual({
        permission_set_id: AGENT_SET,
      });
    });

    it('a membership in a reachable programme can still be deleted by a tenant admin', async () => {
      // Passes on main. Guard against "DELETE refused for everyone".
      const outcome = await attempt(TENANT_A, USER_A_SUPERVISOR, (tx) =>
        deleteMembership(tx, USER_A_AGENT_1, PROGRAMME_A1),
      );
      expect(outcome).toEqual({ rows: 1 });
      expect(await membership(USER_A_AGENT_1, PROGRAMME_A1)).toBeNull();
    });
  });

  // ==========================================================================
  // GAP 3 — catalogue guards on the creation marker's forge paths
  // ==========================================================================

  /*
   * 0015's creation marker is `programme.xmin = current xid AND created_at >=
   * transaction start`. Anything that makes the database REWRITE a programme
   * row the session cannot itself UPDATE, inside the session's transaction,
   * stamps that row's xmin — half the marker, for a programme the session
   * does not reach. These guards list the ways that could happen.
   *
   * The writes-to-programme check on function bodies is TEXTUAL (a regex over
   * `prosrc`). It catches the plain forms (UPDATE / INSERT INTO / DELETE FROM /
   * MERGE INTO programme, schema-qualified or quoted); it does NOT see dynamic
   * SQL built with EXECUTE format(). Recorded rather than hidden.
   */
  const WRITES_PROGRAMME =
    '(update\\s+(only\\s+)?|insert\\s+into\\s+|delete\\s+from\\s+(only\\s+)?|merge\\s+into\\s+)("?public"?\\.)?"?programme"?([^a-z0-9_]|$)';

  type Q = Pick<PoolClient, 'query'>;

  async function names(client: Q, sql: string, values: unknown[] = []): Promise<string[]> {
    const result = await client.query<{ name: string }>(sql, values);
    return result.rows.map((row) => row.name);
  }

  /** FKs ON programme whose action rewrites programme rows when the parent changes. */
  const rewritingFksOnProgramme = (client: Q) =>
    names(
      client,
      `SELECT c.conname AS name
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.conrelid = 'public.programme'::regclass
          AND (c.confupdtype IN ('c', 'n', 'd') OR c.confdeltype IN ('n', 'd'))
        ORDER BY 1`,
    );

  /** FKs referencing programme with ON UPDATE CASCADE (the task's literal wording). */
  const cascadingFksIntoProgramme = (client: Q) =>
    names(
      client,
      `SELECT c.conrelid::regclass::text || '.' || c.conname AS name
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.confrelid = 'public.programme'::regclass
          AND c.confupdtype = 'c'
        ORDER BY 1`,
    );

  /** User (non-internal) triggers attached to programme. */
  const triggersOnProgramme = (client: Q) =>
    names(
      client,
      `SELECT t.tgname AS name
         FROM pg_trigger t
        WHERE t.tgrelid = 'public.programme'::regclass
          AND NOT t.tgisinternal
        ORDER BY 1`,
    );

  /** Any user trigger, on any table, whose function body writes programme. */
  const triggersWritingProgramme = (client: Q) =>
    names(
      client,
      `SELECT t.tgrelid::regclass::text || '.' || t.tgname AS name
         FROM pg_trigger t
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal
          AND p.prosrc ~* $1
        ORDER BY 1`,
      [WRITES_PROGRAMME],
    );

  /** Rewrite rules (not view _RETURN rules) whose action writes programme. */
  const rulesWritingProgramme = (client: Q) =>
    names(
      client,
      `SELECT r.tablename || '.' || r.rulename AS name
         FROM pg_rules r
        WHERE r.schemaname = 'public'
          AND (r.tablename = 'programme' OR r.definition ~* $1)
        ORDER BY 1`,
      [WRITES_PROGRAMME],
    );

  /**
   * SECURITY DEFINER functions whose body writes programme. Any owner — a
   * superset of the task's "owned by kasuwa_migrator" — with the owner named.
   */
  const definersWritingProgramme = (client: Q) =>
    names(
      client,
      `SELECT pg_get_userbyid(p.proowner) || ':' || n.nspname || '.' || p.proname AS name
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prosecdef
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND p.prosrc ~* $1
        ORDER BY 1`,
      [WRITES_PROGRAMME],
    );

  describe('gap 3: no catalogue object can rewrite a programme row behind the session (guards, pass on main)', () => {
    it('each guard catches a planted violation (so none of them is vacuous)', async () => {
      const client = await observer.connect();
      try {
        await client.query('BEGIN');
        // A scratch parent with ON UPDATE CASCADE INTO programme would need an
        // FK added to programme itself; adding a nullable column to programme
        // in a rolled-back transaction does exactly that.
        await client.query(`CREATE TABLE t0046_parent (id uuid PRIMARY KEY)`);
        await client.query(
          `ALTER TABLE programme ADD COLUMN t0046_parent_id uuid
             REFERENCES t0046_parent (id) ON UPDATE CASCADE`,
        );
        await client.query(
          `CREATE TABLE t0046_child (
             programme_id uuid REFERENCES programme (id) ON UPDATE CASCADE)`,
        );
        await client.query(
          `CREATE FUNCTION public.t0046_forge() RETURNS trigger
             LANGUAGE plpgsql SECURITY DEFINER AS $fn$
           BEGIN
             UPDATE public.programme SET updated_at = now() WHERE id = NEW.programme_id;
             RETURN NEW;
           END $fn$`,
        );
        await client.query(
          `CREATE TRIGGER t0046_forge_trg AFTER INSERT ON t0046_child
             FOR EACH ROW EXECUTE FUNCTION public.t0046_forge()`,
        );
        await client.query(
          `CREATE TRIGGER t0046_on_programme AFTER UPDATE ON programme
             FOR EACH ROW EXECUTE FUNCTION public.t0046_forge()`,
        );
        await client.query(
          `CREATE RULE t0046_rule AS ON INSERT TO t0046_child
             DO ALSO UPDATE programme SET updated_at = now() WHERE id = NEW.programme_id`,
        );

        expect(await rewritingFksOnProgramme(client)).toEqual([
          expect.stringMatching(/t0046_parent_id/),
        ]);
        expect(await cascadingFksIntoProgramme(client)).toEqual([
          expect.stringMatching(/^t0046_child\./),
        ]);
        expect(await triggersOnProgramme(client)).toContain('t0046_on_programme');
        expect(await triggersWritingProgramme(client)).toEqual([
          'programme.t0046_on_programme',
          't0046_child.t0046_forge_trg',
        ]);
        expect(await rulesWritingProgramme(client)).toEqual(['t0046_child.t0046_rule']);
        expect(await definersWritingProgramme(client)).toEqual([
          expect.stringMatching(/:public\.t0046_forge$/),
        ]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('no foreign key rewrites programme rows (ON UPDATE CASCADE/SET into programme), and none references programme with ON UPDATE CASCADE', async () => {
      // Non-vacuity: programme has outgoing FKs and is referenced, so both
      // queries are looking at real constraints.
      const outgoing = await observer.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_constraint
          WHERE contype = 'f' AND conrelid = 'public.programme'::regclass`,
      );
      const incoming = await observer.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_constraint
          WHERE contype = 'f' AND confrelid = 'public.programme'::regclass`,
      );
      expect(
        outgoing.rows[0]?.n,
        'programme has no FKs: the guard would be vacuous',
      ).toBeGreaterThan(0);
      expect(incoming.rows[0]?.n, 'nothing references programme: vacuous').toBeGreaterThan(0);

      expect(await rewritingFksOnProgramme(observer)).toEqual([]);
      expect(await cascadingFksIntoProgramme(observer)).toEqual([]);
    });

    it('the only trigger on programme is 0018’s updated_at one, and no trigger or rule anywhere writes programme', async () => {
      expect(await triggersOnProgramme(observer)).toEqual(['programme_touch_updated_at']);
      expect(await triggersWritingProgramme(observer)).toEqual([]);
      expect(await rulesWritingProgramme(observer)).toEqual([]);
    });

    it('no SECURITY DEFINER function writes programme', async () => {
      // Today the two definers write nothing; this keeps a future one from
      // being the owner-privileged writer the marker cannot tell apart.
      expect(await definersWritingProgramme(observer)).toEqual([]);
    });
  });
});
