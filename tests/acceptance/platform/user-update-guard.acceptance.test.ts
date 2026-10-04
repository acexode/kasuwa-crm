import {
  createPool,
  PROGRAMME_A1,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withAuthTransaction,
  withTenantTransaction,
} from '@kasuwa/db';
import type { TenantTx } from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

/**
 * ACCEPTANCE — T-0048, guard UPDATE on `"user"` (Agent 1). D-L55.
 *
 * Found by the T-0047 suite: 0015 column-grants `status` and `email` (and
 * display_name, locale, role_id, updated_at) on `"user"` to kasuwa_app, and
 * 0001's `user_isolation` checks only the tenant. So a session that reaches NO
 * programme can set the tenant admin's `status` to `disabled`, and
 * `app.resolve_session` (0003) requires `status = 'active'`: a lockout. The same
 * grant lets any member rewrite another member's `email`.
 *
 * Written by Agent 12 from the invariants, before any fix exists (D-L25). If
 * the task file and this suite disagree, say so in the report; do not edit it.
 *
 * Every attack runs AS kasuwa_app INSIDE A REAL `withTenantTransaction` (or,
 * where stated, a real `withAuthTransaction`), so the scope is the one the
 * database resolves, never one the test chose. Shapes are planted through
 * kasuwa_migrator; `afterEach` reseeds. Both transaction helpers COMMIT: on
 * `main` the attacks below land, which is why every test reseeds afterwards.
 *
 * ------------------------------------------------------------------------
 * THE DESIGN THIS SUITE ASSUMES. State it once:
 *
 *   U1. A session whose user is NOT a tenant admin (`"user".is_tenant_admin`,
 *       D-L53) cannot UPDATE another user's row at all — no column, including
 *       `updated_at`, `locale` and `role_id`. Nor can it change its OWN
 *       security fields: `status`, `email`, `role_id`. Same for an
 *       authentication transaction, which has a tenant and no user.
 *
 *   U2. THE REFUSAL IS 42501, NOT 0 ROWS. This is forced, not a preference:
 *       `lockUserForFactorWrite` (apps/api/src/auth/mfa-store.ts) takes
 *       `SELECT id FROM "user" ... FOR UPDATE` on the enrolling user's own row,
 *       and the 'first'-mode enrolment does so inside `withAuthTransaction`,
 *       where `app.user_id` is EMPTY. PostgreSQL applies UPDATE policies' USING
 *       to `FOR UPDATE` row locks, so a USING that filters on the session's
 *       user (or on tenant admin) would make that lock silently return 0 rows:
 *       no error, and the enrolment race the lock exists for (T-0012 review)
 *       comes back. Guard G1 below catches exactly that. So USING must keep
 *       admitting the tenant's rows, and the refusal has to come from a WITH
 *       CHECK or a trigger — both of which raise rather than filter. A trigger
 *       should `RAISE ... USING ERRCODE = '42501'` (insufficient_privilege).
 *       42501 does not breach CLAUDE.md 6.4: every member of a tenant can
 *       already SELECT every `"user"` row of that tenant (0001 is tenant-only
 *       by design), so a refusal reveals nothing a SELECT does not. Another
 *       tenant's row is still invisible: 0 rows, as today.
 *       (Builder's note, not an assertion: a `"user"` policy that subqueries
 *       `"user"` hits PostgreSQL's "infinite recursion detected in policy".)
 *
 *   U3. A tenant admin may change another user's `status` (deactivate AND
 *       reactivate), `display_name` and `role_id`, anywhere in the tenant,
 *       whether or not the admin reaches any programme: these are tenant-level
 *       writes (D-L53). Tenant admin never reaches another tenant: 0 rows.
 *
 *   U4. NOBODY ON THE APP ROLE CHANGES `email` — not a tenant admin, not for
 *       another user and not for themselves. Ruling, with the reason: email is
 *       the sign-in identifier and will be the recovery channel. An admin who
 *       can rewrite another user's (or another admin's) address to one he
 *       controls owns that account the day email recovery ships, and a stolen
 *       session that can rewrite its own address pivots the recovery channel.
 *       There is no verified-change flow and no application code writes
 *       `email` today (grepped for this suite). When the verified flow is
 *       built it opens this door deliberately, and this file changes with it.
 *
 *   U5. Existing writes keep working, for the actor that makes them today
 *       (grepped `apps/` and `packages/` for every app-role write of
 *       `"user"`; this is the complete list on main at 379a43b):
 *         * deleteRole (apps/api/src/admin/roles/roles.service.ts) moves every
 *           holder of the doomed role: `UPDATE "user" SET role_id = $3,
 *           updated_at = now() WHERE tenant_id = $1 AND role_id = $2`, as a
 *           tenant admin (`role.write` is tenant-level, D-L53), and the
 *           admin's OWN row may be among them;
 *         * lockUserForFactorWrite (mfa-store.ts) — the row lock in U2 — in
 *           `withAuthTransaction` (enrolment at sign-in, 'first') and in
 *           `withTenantTransaction` (replacement from a session, 'replace',
 *           mfa.service.ts), for ANY user, admin or not.
 *       Nothing else updates `"user"` as kasuwa_app. Last-login, MFA flags and
 *       credential timestamps live on `auth_session`, `user_mfa_factor` and
 *       `user_credential`, not on `"user"`. provisionTenant INSERTs a user as
 *       kasuwa_migrator; disableSeededUser/enableSeededUser
 *       (packages/testing/src/auth.ts) UPDATE status as kasuwa_migrator; the
 *       seed is kasuwa_migrator. None runs on the app role, and all of them
 *       must keep working: a guard must not catch kasuwa_migrator.
 *
 *   U6. No new SECURITY DEFINER function (CLAUDE.md 2.7): exactly two.
 *
 * NOT ASSERTED, and why:
 *   * Self-service `display_name` / `locale`. No application path writes
 *     either for the session's own user (task item 3: grep first; nothing
 *     needs it). The suite neither requires nor forbids it.
 *   * LAST ACTIVE TENANT ADMIN DEACTIVATING THEMSELVES. Ruling: the
 *     APPLICATION's job, out of scope here. It is a cross-row invariant ("at
 *     least one active tenant admin remains"), and a policy or WITH CHECK
 *     cannot hold one under READ COMMITTED: two admins deactivating each other
 *     concurrently both see the other still active and both commit. A policy
 *     would therefore look like a guarantee without being one; only a locking
 *     trigger could, which is more than this task. No endpoint deactivates
 *     users yet; when one is built it must refuse with a clear error. It is
 *     also recoverable without data loss (an operator re-activates through
 *     kasuwa_migrator), unlike the T-0047 finding, where ANY member could do
 *     it to an admin — that is U1, and asserted.
 *   * The app.user_id GUC forging residual (ADR-0010): a tenant-admin check
 *     can only read the session's user from a GUC kasuwa_app can re-set and
 *     restore before COMMIT. Same residual as T-0046; recorded, not tested.
 *   * `id`, `tenant_id`, `is_tenant_admin`, `created_at`: not granted to
 *     kasuwa_app by 0015, so already refused today. Covered by
 *     permissions.acceptance.test.ts (is_tenant_admin); not repeated.
 *
 * ON MAIN (D-L23): the U1 and U4 attacks fail with `{ rows: 1 }` — the write
 * committed — where `{ code: '42501' }` is expected. The U3, U5 and U6 tests
 * PASS on main: they are guards that the fix does not over-refuse, and each
 * names, next to it, the plausible fix it exists to catch.
 */

/** Two roles planted in tenant A (the seed has none); TRUNCATE ... CASCADE in reseed removes them. */
const ROLE_DOOMED = '0a480000-0000-4000-8000-000000000001';
const ROLE_TARGET = '0a480000-0000-4000-8000-000000000002';

/** The exact statement lockUserForFactorWrite runs (apps/api/src/auth/mfa-store.ts). */
const MFA_USER_LOCK_SQL = `SELECT id FROM "user" WHERE tenant_id = $1 AND id = $2 FOR UPDATE`;

/** deleteRole's reassignment (apps/api/src/admin/roles/roles.service.ts), with its RETURNING. */
const DELETE_ROLE_REASSIGN_SQL = `UPDATE "user" SET role_id = $3, updated_at = now()
  WHERE tenant_id = $1 AND role_id = $2`;

interface Outcome {
  /** Rows the statement reported, when it did not throw. */
  rows?: number;
  /** SQLSTATE, when it threw. */
  code?: string;
}

const REFUSED: Outcome = { code: '42501' };

function sqlState(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : `non-sql error: ${String(error)}`;
}

describe('acceptance: guard UPDATE on "user" (T-0048)', () => {
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

  async function plantTenantAdmin(userId: string, value: boolean) {
    await observer.query('UPDATE "user" SET is_tenant_admin = $1 WHERE id = $2', [value, userId]);
  }

  async function plantRole(userId: string, roleId: string | null) {
    await observer.query('UPDATE "user" SET role_id = $1 WHERE id = $2', [roleId, userId]);
  }

  /** Every column of every user in a tenant, as the migrator sees it. */
  async function usersOf(tenantId: string): Promise<unknown[]> {
    const result = await observer.query<{ row: unknown }>(
      `SELECT to_jsonb(u) AS row FROM "user" u WHERE tenant_id = $1 ORDER BY id`,
      [tenantId],
    );
    return result.rows.map((r) => r.row);
  }

  async function userRow(userId: string): Promise<Record<string, unknown>> {
    const result = await observer.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(u) AS row FROM "user" u WHERE id = $1`,
      [userId],
    );
    const row = result.rows[0]?.row;
    if (row === undefined) throw new Error(`Fixture drift: no user ${userId}`);
    return row;
  }

  /** Runs `fn` as `userId` in a real tenant transaction; captures rows or SQLSTATE. */
  async function attempt(
    tenantId: string,
    userId: string,
    fn: (tx: TenantTx) => Promise<number>,
  ): Promise<Outcome> {
    try {
      return { rows: await withTenantTransaction(appPool, { tenantId, userId }, fn) };
    } catch (error) {
      return { code: sqlState(error) };
    }
  }

  /** A statement wrapped so it reports how many rows it changed. */
  async function count(tx: TenantTx, sql: string, values: unknown[]): Promise<number> {
    const rows = await tx.query<{ n: number }>(
      `WITH changed AS (${sql} RETURNING 1) SELECT count(*)::int AS n FROM changed`,
      values,
    );
    return rows[0]?.n ?? -1;
  }

  const setColumn = (tx: TenantTx, column: string, value: unknown, userId: string) =>
    count(tx, `UPDATE "user" SET ${column} = $1 WHERE id = $2`, [value, userId]);

  /**
   * Every app-writable column (0015's UPDATE grant) with a value that differs
   * from the seed's, so a "success" is always a real change, never a no-op.
   */
  const COLUMN_ATTACKS: [column: string, value: unknown][] = [
    ['status', 'disabled'],
    ['email', 'attacker@tenant-a.test'],
    ['display_name', 'Renamed By Attacker'],
    ['locale', 'fr-SN'],
    ['role_id', ROLE_TARGET],
    ['updated_at', '2001-01-01T00:00:00Z'],
  ];

  beforeEach(async () => {
    // The seed's shape, stated rather than trusted: the supervisor is tenant
    // A's only tenant admin; the agents and the unassigned user are not.
    // Tenant B's only user is its tenant admin.
    await plantTenantAdmin(USER_A_SUPERVISOR, true);
    for (const userId of [USER_A_AGENT_1, USER_A_AGENT_2, USER_A_NO_PROGRAMME]) {
      await plantTenantAdmin(userId, false);
    }
    await plantTenantAdmin(USER_B_AGENT_1, true);
    await observer.query(
      `INSERT INTO role (id, tenant_id, name) VALUES ($1, $3, 'T-0048 doomed'), ($2, $3, 'T-0048 target')`,
      [ROLE_DOOMED, ROLE_TARGET, TENANT_A],
    );
    const active = await observer.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "user" WHERE tenant_id = $1 AND status = 'active'`,
      [TENANT_A],
    );
    // Every attack below is "an active user becomes something else"; a seed
    // that already had disabled users would make those vacuous.
    expect(active.rows[0]?.n, 'fixture drift: tenant A users are not all active').toBe(4);
  });

  // ==========================================================================
  // U1 — a non-tenant-admin changes nobody else, and none of its own security
  // ==========================================================================

  describe('U1: a non-tenant-admin session cannot change another user', () => {
    // The two weakest sessions with a tenant: an agent reaching A1, and a user
    // reaching NO programme (the T-0047 finding's actor).
    const attackers: [label: string, userId: string][] = [
      ['an agent reaching A1', USER_A_AGENT_1],
      ['a user reaching no programme', USER_A_NO_PROGRAMME],
    ];
    const victims: [label: string, userId: string][] = [
      ['the tenant admin', USER_A_SUPERVISOR],
      ['another agent', USER_A_AGENT_2],
    ];

    for (const [attackerLabel, attacker] of attackers) {
      for (const [victimLabel, victim] of victims) {
        it(`${attackerLabel} cannot change any column of ${victimLabel}: 42501 each, every user unchanged`, async () => {
          const before = await usersOf(TENANT_A);
          const outcomes: Record<string, Outcome> = {};
          for (const [column, value] of COLUMN_ATTACKS) {
            outcomes[column] = await attempt(TENANT_A, attacker, (tx) =>
              setColumn(tx, column, value, victim),
            );
          }
          expect(outcomes).toEqual(
            Object.fromEntries(COLUMN_ATTACKS.map(([column]) => [column, REFUSED])),
          );
          expect(await usersOf(TENANT_A)).toEqual(before);
        });
      }
    }

    it('the T-0047 lockout itself: a no-programme session deactivating the tenant admin is refused; the admin stays active', async () => {
      const outcome = await attempt(TENANT_A, USER_A_NO_PROGRAMME, (tx) =>
        setColumn(tx, 'status', 'disabled', USER_A_SUPERVISOR),
      );
      expect(outcome, 'a member deactivated the tenant admin').toEqual(REFUSED);
      expect((await userRow(USER_A_SUPERVISOR)).status).toBe('active');
    });

    it('a bulk UPDATE over the whole tenant changes nobody: 42501, every user unchanged', async () => {
      const before = await usersOf(TENANT_A);
      const outcome = await attempt(TENANT_A, USER_A_AGENT_1, (tx) =>
        count(tx, `UPDATE "user" SET status = 'disabled' WHERE tenant_id = $1 AND id <> $2`, [
          TENANT_A,
          USER_A_AGENT_1,
        ]),
      );
      expect(outcome).toEqual(REFUSED);
      expect(await usersOf(TENANT_A)).toEqual(before);
    });

    it('INSERT ... ON CONFLICT DO UPDATE onto the tenant admin’s email changes nothing and commits nothing', async () => {
      // The upsert side door: the UPDATE arm runs against a row the INSERT
      // never had to be allowed to see. End state, not a particular SQLSTATE:
      // a sound design may refuse at the INSERT or the UPDATE step.
      const before = await usersOf(TENANT_A);
      const admin = await userRow(USER_A_SUPERVISOR);
      const outcome = await attempt(TENANT_A, USER_A_NO_PROGRAMME, (tx) =>
        count(
          tx,
          `INSERT INTO "user" (id, tenant_id, email, display_name)
           VALUES ('0a480000-0000-4000-8000-0000000000ff', $1, $2, 'upsert')
           ON CONFLICT (tenant_id, email) DO UPDATE SET status = 'disabled'`,
          [TENANT_A, admin.email],
        ),
      );
      expect(outcome.rows, 'the upsert committed').toBeUndefined();
      expect(await usersOf(TENANT_A)).toEqual(before);
    });

    it('an authentication transaction (tenant, no user) cannot change any user: 42501, unchanged', async () => {
      // Sign-in runs as kasuwa_app with app.user_id empty (packages/db/src/auth.ts).
      // It has no business writing "user"; it must not be the side door.
      const before = await usersOf(TENANT_A);
      const outcomes: Record<string, Outcome> = {};
      for (const [column, value] of COLUMN_ATTACKS) {
        try {
          outcomes[column] = {
            rows: await withAuthTransaction(appPool, { tenantId: TENANT_A }, async (tx) => {
              const rows = await tx.query<{ n: number }>(
                `WITH changed AS (UPDATE "user" SET ${column} = $1 WHERE id = $2 RETURNING 1)
                 SELECT count(*)::int AS n FROM changed`,
                [value, USER_A_SUPERVISOR],
              );
              return rows[0]?.n ?? -1;
            }),
          };
        } catch (error) {
          outcomes[column] = { code: sqlState(error) };
        }
      }
      expect(outcomes).toEqual(
        Object.fromEntries(COLUMN_ATTACKS.map(([column]) => [column, REFUSED])),
      );
      expect(await usersOf(TENANT_A)).toEqual(before);
    });

    it('a non-tenant-admin cannot change its OWN status, email or role_id: 42501 each, unchanged', async () => {
      const before = await usersOf(TENANT_A);
      const security: [column: string, value: unknown][] = [
        ['status', 'disabled'],
        ['email', 'self-change@tenant-a.test'],
        ['role_id', ROLE_TARGET],
      ];
      const outcomes: Record<string, Outcome> = {};
      for (const [column, value] of security) {
        outcomes[column] = await attempt(TENANT_A, USER_A_AGENT_1, (tx) =>
          setColumn(tx, column, value, USER_A_AGENT_1),
        );
      }
      expect(outcomes).toEqual({ status: REFUSED, email: REFUSED, role_id: REFUSED });
      expect(await usersOf(TENANT_A)).toEqual(before);
    });

    it('holding `admin` in a programme is not tenant admin: still 42501 on another user’s status', async () => {
      // The strongest non-tenant-admin: programme `admin` set in A1 (D-L53 —
      // programme-level authority does not reach tenant-level writes).
      await observer.query(
        `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
         SELECT $2, $3, $1, id FROM permission_set WHERE tenant_id = $1 AND key = 'admin'
         ON CONFLICT (user_id, programme_id)
         DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
        [TENANT_A, USER_A_AGENT_1, PROGRAMME_A1],
      );
      const outcome = await attempt(TENANT_A, USER_A_AGENT_1, (tx) =>
        setColumn(tx, 'status', 'disabled', USER_A_AGENT_2),
      );
      expect(outcome).toEqual(REFUSED);
      expect((await userRow(USER_A_AGENT_2)).status).toBe('active');
    });
  });

  // ==========================================================================
  // U3 / U4 — a tenant admin: status and display_name yes, email no, own tenant only
  // ==========================================================================

  describe('U3, U4: a tenant admin changes status and display_name in its own tenant, never email', () => {
    it('deactivates and then reactivates another user (1 row each), and the row reads back', async () => {
      // Guard (passes on main): catches a fix that refuses tenant admins too,
      // e.g. a blanket REVOKE UPDATE (status).
      const off = await attempt(TENANT_A, USER_A_SUPERVISOR, (tx) =>
        setColumn(tx, 'status', 'disabled', USER_A_AGENT_1),
      );
      expect(off).toEqual({ rows: 1 });
      expect((await userRow(USER_A_AGENT_1)).status).toBe('disabled');

      const on = await attempt(TENANT_A, USER_A_SUPERVISOR, (tx) =>
        setColumn(tx, 'status', 'active', USER_A_AGENT_1),
      );
      expect(on).toEqual({ rows: 1 });
      expect((await userRow(USER_A_AGENT_1)).status).toBe('active');
    });

    it('changes another user’s display_name: 1 row', async () => {
      const outcome = await attempt(TENANT_A, USER_A_SUPERVISOR, (tx) =>
        setColumn(tx, 'display_name', 'Ngozi (Team Lead)', USER_A_AGENT_2),
      );
      expect(outcome).toEqual({ rows: 1 });
      expect((await userRow(USER_A_AGENT_2)).display_name).toBe('Ngozi (Team Lead)');
    });

    it('may deactivate another tenant admin while it remains one itself', async () => {
      await plantTenantAdmin(USER_A_AGENT_2, true);
      const outcome = await attempt(TENANT_A, USER_A_SUPERVISOR, (tx) =>
        setColumn(tx, 'status', 'disabled', USER_A_AGENT_2),
      );
      expect(outcome).toEqual({ rows: 1 });
    });

    it('a tenant admin reaching NO programme still administers users: tenant-level, not programme-scoped', async () => {
      // Guard: catches a fix that keys the admin check on programme overlap.
      await plantTenantAdmin(USER_A_NO_PROGRAMME, true);
      const outcome = await attempt(TENANT_A, USER_A_NO_PROGRAMME, (tx) =>
        setColumn(tx, 'status', 'disabled', USER_A_AGENT_1),
      );
      expect(outcome).toEqual({ rows: 1 });
    });

    it('cannot change another user’s email, nor another admin’s, nor its own: 42501 each, unchanged (U4)', async () => {
      await plantTenantAdmin(USER_A_AGENT_2, true);
      const before = await usersOf(TENANT_A);
      const targets: [label: string, userId: string][] = [
        ['agent', USER_A_AGENT_1],
        ['other admin', USER_A_AGENT_2],
        ['self', USER_A_SUPERVISOR],
      ];
      const outcomes: Record<string, Outcome> = {};
      for (const [label, userId] of targets) {
        outcomes[label] = await attempt(TENANT_A, USER_A_SUPERVISOR, (tx) =>
          setColumn(tx, 'email', `takeover-${label.replace(' ', '-')}@tenant-a.test`, userId),
        );
      }
      expect(outcomes).toEqual({ agent: REFUSED, 'other admin': REFUSED, self: REFUSED });
      expect(await usersOf(TENANT_A)).toEqual(before);
    });

    it('cannot reach another tenant’s user: 0 rows, tenant B unchanged', async () => {
      // LEGITIMATELY PASSES BEFORE THE WORK: 0001's tenant USING already
      // filters this. Kept because a fix that rewrites user_isolation must not
      // loosen it, not because it is coverage of T-0048.
      const before = await usersOf(TENANT_B);
      const outcomes: Record<string, Outcome> = {};
      for (const [column, value] of [
        ['status', 'disabled'],
        ['display_name', 'cross-tenant'],
      ] as const) {
        outcomes[column] = await attempt(TENANT_A, USER_A_SUPERVISOR, (tx) =>
          setColumn(tx, column, value, USER_B_AGENT_1),
        );
      }
      expect(outcomes).toEqual({ status: { rows: 0 }, display_name: { rows: 0 } });
      expect(await usersOf(TENANT_B)).toEqual(before);
    });
  });

  // ==========================================================================
  // U5 — the writes the application already makes
  // ==========================================================================

  describe('U5: existing app-role writes of "user" keep working', () => {
    it('deleteRole’s reassignment, as a tenant admin, moves every holder including the admin’s own row', async () => {
      // Guard (passes on main). The admin's own row is in the set on purpose:
      // a fix that lets tenant admins change OTHER users only would drop it.
      await plantRole(USER_A_SUPERVISOR, ROLE_DOOMED);
      await plantRole(USER_A_AGENT_1, ROLE_DOOMED);
      const outcome = await attempt(TENANT_A, USER_A_SUPERVISOR, (tx) =>
        count(tx, DELETE_ROLE_REASSIGN_SQL, [TENANT_A, ROLE_DOOMED, ROLE_TARGET]),
      );
      expect(outcome).toEqual({ rows: 2 });
      expect((await userRow(USER_A_SUPERVISOR)).role_id).toBe(ROLE_TARGET);
      expect((await userRow(USER_A_AGENT_1)).role_id).toBe(ROLE_TARGET);
    });

    /**
     * G1. The MFA enrolment lock must still LOCK. Measured from outside, not
     * by row count alone: while the app-role transaction holds the lock, the
     * migrator's `FOR UPDATE NOWAIT` on the same row must fail with 55P03
     * (lock_not_available). A policy whose USING filters the row out turns
     * the lock into a 0-row no-op, and NOWAIT then succeeds. No sleeps: the
     * probe runs inside the holder's callback, so the lock is held by
     * construction.
     */
    async function probeLockHeld(): Promise<string> {
      try {
        await observer.query(
          `SELECT id FROM "user" WHERE tenant_id = $1 AND id = $2 FOR UPDATE NOWAIT`,
          [TENANT_A, USER_A_AGENT_1],
        );
        return 'not locked';
      } catch (error) {
        return sqlState(error);
      }
    }

    it('G1a: lockUserForFactorWrite in an authentication transaction (no app.user_id) locks a non-admin’s row', async () => {
      const seen = await withAuthTransaction(appPool, { tenantId: TENANT_A }, async (tx) => {
        const rows = await tx.query<{ id: string }>(MFA_USER_LOCK_SQL, [TENANT_A, USER_A_AGENT_1]);
        return { rows: rows.length, probe: await probeLockHeld() };
      });
      expect(seen).toEqual({ rows: 1, probe: '55P03' });
    });

    it('G1b: lockUserForFactorWrite in a tenant transaction locks the non-admin’s own row', async () => {
      const seen = await withTenantTransaction(
        appPool,
        { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
        async (tx) => {
          const rows = await tx.query<{ id: string }>(MFA_USER_LOCK_SQL, [
            TENANT_A,
            USER_A_AGENT_1,
          ]);
          return { rows: rows.length, probe: await probeLockHeld() };
        },
      );
      expect(seen).toEqual({ rows: 1, probe: '55P03' });
    });

    it('kasuwa_migrator still updates any user’s status and email (seed, provisioning, disableSeededUser)', async () => {
      // Guard: a trigger fires for BYPASSRLS roles too. A guard that does not
      // exempt the migrator breaks packages/testing's disableSeededUser, the
      // seed and every beforeEach in this file.
      const result = await observer.query(
        `UPDATE "user" SET status = 'disabled', email = 'moved@tenant-a.test' WHERE id = $1`,
        [USER_A_SUPERVISOR],
      );
      expect(result.rowCount).toBe(1);
    });

    it('G1c: the probe is not vacuous — with no lock held, NOWAIT succeeds', async () => {
      // The negative control for G1a/G1b: if probeLockHeld always reported a
      // lock, both would pass whatever the policy did.
      expect(await probeLockHeld()).toBe('not locked');
    });
  });

  // ==========================================================================
  // U6
  // ==========================================================================

  describe('U6: the definer census', () => {
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
