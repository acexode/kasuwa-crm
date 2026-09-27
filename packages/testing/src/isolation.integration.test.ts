import { createPool, NON_TENANT_SCOPED_TABLES, TENANT_SCOPED_TABLES } from '@kasuwa/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { readNonTenantScopedTableSecurity, readTableSecurity } from './isolation';

/**
 * The catalogue-invariant harness, tested against a real catalogue.
 *
 * `readTableSecurity` is what the blocking tenancy suite calls to assert that
 * every table in `public` is tenant-scoped and protected. `ADR-0009` added one
 * deliberate exemption to that rule, and the exemption works by having
 * `readTableSecurity` skip the tables named in `NON_TENANT_SCOPED_TABLES`.
 *
 * That is a hole unless something checks the other half, and for one round
 * nothing did: `readNonTenantScopedTableSecurity` existed, the ADR cited it as
 * the thing enforcing the guarantee, and it was never called — the real
 * assertion was a hand-rolled copy of its query inside an application test,
 * where the module-boundary rule keeps this package out. A helper documenting a
 * guarantee nobody invokes is precisely the pattern this task has been
 * criticising elsewhere, so it is called here, in the package that owns it.
 *
 * These tests live in `@kasuwa/testing` rather than in the acceptance suite
 * because they are tests OF the harness, not of the database. If the harness
 * can be made to look away from a table, every suite that trusts it is worth
 * less, and no acceptance test would notice.
 */
describe('catalogue invariant harness', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 3 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('reports every tenant-scoped table and no others', async () => {
    const state = await readTableSecurity(pool);
    expect(state.map((row) => row.table).sort()).toEqual([...TENANT_SCOPED_TABLES].sort());
  });

  it('hides exempt tables from the set-equality check, and only those', async () => {
    // The exemption must be exactly as wide as the named list — no wider.
    const scoped = new Set((await readTableSecurity(pool)).map((row) => row.table));
    for (const table of NON_TENANT_SCOPED_TABLES) {
      expect(scoped.has(table), `${table} should be exempt from the set-equality check`).toBe(
        false,
      );
    }
  });

  it('still requires RLS enabled, forced and policied on every exempt table', async () => {
    // Being exempt from carrying `tenant_id` is not being exempt from row-level
    // security. Without this, NON_TENANT_SCOPED_TABLES would be a way to
    // smuggle a table past the invariant entirely rather than a narrow,
    // argued exception to one clause of it.
    const exempt = await readNonTenantScopedTableSecurity(pool);

    expect(exempt.map((row) => row.table).sort()).toEqual([...NON_TENANT_SCOPED_TABLES].sort());
    for (const row of exempt) {
      expect(row.rlsEnabled, `${row.table}: RLS is not enabled`).toBe(true);
      expect(row.rlsForced, `${row.table}: RLS is not FORCED`).toBe(true);
      expect(row.policyCount, `${row.table}: has no policy`).toBeGreaterThan(0);
    }
  });

  it('accounts for every table in public between the two lists', async () => {
    // The real guarantee: nothing exists that neither list knows about. A table
    // added with no tenant_id and no ADR shows up here as an unexplained name.
    const known = new Set<string>([...TENANT_SCOPED_TABLES, ...NON_TENANT_SCOPED_TABLES]);
    const everything = await pool.query<{ table: string }>(
      `SELECT c.relname AS table
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname NOT LIKE '\\_%'`,
    );

    const unexplained = everything.rows.map((row) => row.table).filter((name) => !known.has(name));
    expect(unexplained).toEqual([]);
  });
});
