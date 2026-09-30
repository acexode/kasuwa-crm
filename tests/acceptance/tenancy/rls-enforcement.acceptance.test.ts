import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_B1,
  PROGRAMME_B2,
  TENANT_A,
  TENANT_B,
  NON_TENANT_SCOPED_TABLES,
  TENANT_SCOPED_TABLES,
} from '@kasuwa/db';
import {
  readNonTenantScopedTableSecurity,
  readRoleAttributes,
  readTableSecurity,
  withForcedScope,
} from '@kasuwa/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * ACCEPTANCE — the database is the last line, and it holds on its own.
 *
 * Every other suite assumes the application behaves. This one assumes it does
 * not. It sets the RLS session variables directly to values no legitimate
 * session could produce — forged programme lists, another tenant's programmes,
 * nothing at all — and asserts what Postgres still refuses to hand over.
 *
 * Addendum A1 section 3.1, principle 5: thirteen instances of the same model
 * share failure modes, so the checks that matter are the ones a model cannot
 * talk itself past. Postgres does not read our comments.
 */

describe('acceptance: RLS enforcement independent of the application', () => {
  let appPool: Pool;

  beforeAll(() => {
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 5 });
  });

  afterAll(async () => {
    await appPool.end();
  });

  const countContacts = async (scope: Parameters<typeof withForcedScope>[1]) =>
    withForcedScope(appPool, scope, async (query) => {
      const rows = await query<{ count: string }>('SELECT count(*)::text AS count FROM contact');
      return Number(rows[0]?.count ?? '-1');
    });

  it('returns nothing when no session variables are set at all', async () => {
    expect(await countContacts({})).toBe(0);
  });

  it('returns nothing when a tenant is set but no programmes are', async () => {
    expect(await countContacts({ tenantId: TENANT_A })).toBe(0);
  });

  it('refuses to cross tenants even when the programme list is forged', async () => {
    // The attacker knows tenant B's programme ids and injects them, but the
    // tenant predicate still holds. This is the property that makes a single
    // mistaken programme id survivable.
    const count = await countContacts({
      tenantId: TENANT_A,
      programmeIds: [PROGRAMME_B1, PROGRAMME_B2],
    });
    expect(count).toBe(0);
  });

  it('returns rows only for the intersection of tenant and forged programmes', async () => {
    const count = await countContacts({
      tenantId: TENANT_A,
      programmeIds: [PROGRAMME_A1, PROGRAMME_B1],
    });
    // Three seeded contacts in A1; none from B1 despite it being named.
    expect(count).toBe(3);
  });

  it('blocks a cross-tenant INSERT through the WITH CHECK clause', async () => {
    await expect(
      withForcedScope(
        appPool,
        { tenantId: TENANT_A, programmeIds: [PROGRAMME_A1] },
        async (query) =>
          query(
            `INSERT INTO contact (id, tenant_id, programme_id, display_name)
             VALUES (gen_random_uuid(), $1, $2, 'Injected')`,
            [TENANT_B, PROGRAMME_B1],
          ),
      ),
    ).rejects.toThrow();
  });

  it('blocks an UPDATE that would move a row into another tenant', async () => {
    await expect(
      withForcedScope(
        appPool,
        { tenantId: TENANT_A, programmeIds: [PROGRAMME_A1] },
        async (query) => query(`UPDATE contact SET tenant_id = $1`, [TENANT_B]),
      ),
    ).rejects.toThrow();
  });

  it('cannot delete rows outside its scope', async () => {
    const deleted = await withForcedScope(
      appPool,
      { tenantId: TENANT_A, programmeIds: [PROGRAMME_A1] },
      async (query) => {
        const rows = await query<{ id: string }>(
          `DELETE FROM contact WHERE tenant_id = $1 RETURNING id`,
          [TENANT_B],
        );
        return rows.length;
      },
    );
    // withForcedScope always rolls back, so nothing is lost either way.
    expect(deleted).toBe(0);
  });

  it('gives the application role no way to turn RLS off', async () => {
    const attributes = await readRoleAttributes(appPool, 'kasuwa_app');
    expect(attributes).not.toBeNull();
    expect(attributes?.bypassRls).toBe(false);
    expect(attributes?.superuser).toBe(false);
    expect(attributes?.createRole).toBe(false);

    await expect(
      withForcedScope(appPool, { tenantId: TENANT_A }, async (query) =>
        query('ALTER TABLE contact DISABLE ROW LEVEL SECURITY'),
      ),
    ).rejects.toThrow();
  });

  it('has RLS enabled AND forced with at least one policy on every table', async () => {
    const state = await readTableSecurity(appPool);
    const byTable = new Map(state.map((row) => [row.table, row]));

    // Guards against a table being added to the database but never to the
    // schema module's list — and against the list being edited to hide one.
    expect(state.map((row) => row.table).sort()).toEqual([...TENANT_SCOPED_TABLES].sort());

    for (const table of TENANT_SCOPED_TABLES) {
      const row = byTable.get(table);
      expect(row, `table ${table} is missing`).toBeDefined();
      expect(row?.rlsEnabled, `${table}: RLS is not enabled`).toBe(true);
      // FORCE matters: without it the table owner bypasses its own policies,
      // which is precisely how a migration or a seed silently reads everything.
      expect(row?.rlsForced, `${table}: RLS is not FORCED`).toBe(true);
      expect(row?.policyCount, `${table}: has no policy`).toBeGreaterThan(0);
    }
  });

  it('lets no policy anywhere admit everything', async () => {
    // MOVED HERE BY THE LEAD from a `DO` block in migration 0004, on
    // `migration-reviewer`'s finding.
    //
    // That block raised if any policy on `auth_rate_limit` was `USING (true)`,
    // and its comment claimed it protected against a LATER migration reopening
    // the table. It could not: a `DO` block runs once, when its own migration
    // is applied. A migration added next month would never re-run it.
    //
    // So it guarded a mistake inside one file and read as though it guarded a
    // standing invariant. **A guard that describes itself as broader than it is
    // is worse than no guard**, because it stops anyone building the real one.
    // This repository has now been caught five times by mechanisms believed to
    // work because they were configured.
    //
    // Here it runs on every build, across every table, for ever.
    const open = await appPool.query<{ table: string; policy: string }>(
      `SELECT c.relname AS table, p.polname AS policy
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND pg_get_expr(p.polqual, p.polrelid) = 'true'`,
    );

    expect(
      open.rows.map((row) => `${row.table}.${row.policy}`),
      'a policy admits every row to every session — if this is deliberate, it needs an ADR',
    ).toEqual([]);
  });

  it('holds the exempt table to the same RLS invariant', async () => {
    // WIRED BY THE LEAD, 2026-09-27, after `migration-reviewer` found that
    // `readNonTenantScopedTableSecurity` was never called by anything.
    //
    // `auth_rate_limit` is the one table in the system with no `tenant_id`
    // (ADR-0009). Being exempt from tenant scoping does not make it exempt
    // from having RLS enabled, forced and policied — otherwise the exemption
    // is a way to smuggle a table past the invariant entirely.
    //
    // The compensating control for that exemption existed, was documented in
    // two places as "asserts those tables still have RLS enabled, forced and
    // policied", and **was dead code**. The assertion that actually ran lived
    // in the integration project, which is not the blocking gate. This is the
    // third time in this repository that a comment has claimed a guardrail was
    // armed when it was not — so it now runs here, where a regression fails CI.
    const state = await readNonTenantScopedTableSecurity(appPool);
    const byTable = new Map(state.map((row) => [row.table, row]));

    // Same set-equality guard as above: a table cannot be added to the
    // exemption list without appearing here, and the list cannot be quietly
    // grown to hide one.
    expect(state.map((row) => row.table).sort()).toEqual([...NON_TENANT_SCOPED_TABLES].sort());

    for (const table of NON_TENANT_SCOPED_TABLES) {
      const row = byTable.get(table);
      expect(row, `exempt table ${table} is missing`).toBeDefined();
      expect(row?.rlsEnabled, `${table}: RLS is not enabled`).toBe(true);
      expect(row?.rlsForced, `${table}: RLS is not FORCED`).toBe(true);
      expect(row?.policyCount, `${table}: has no policy`).toBeGreaterThan(0);
    }
  });
});
