import {
  createPool,
  PROGRAMME_A1,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import {
  readTableSecurity,
  seedObjectDef as seedObjectDefFixture,
  withForcedScope,
} from '@kasuwa/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * ACCEPTANCE — T-0002, metadata engine foundations (Agent 2, M15).
 *
 * PENDING. Real tests, failing today because `object_def` and `field_def` do
 * not exist. `pnpm test:pending` runs them. Renaming this file to drop
 * `.pending` is what assigns the task — `pnpm verify:tasks` enforces it.
 *
 * WHY THIS SUITE IS SHAPED THE WAY IT IS
 *
 * Metadata is the one part of the system that is deliberately tenant-scoped but
 * **not** programme-scoped: a custom field belongs to the tenant, not to one
 * client engagement. That exception is correct and it is also exactly the kind
 * of thing that gets "fixed" by a later reviewer who sees a missing
 * `programme_id` and assumes an oversight.
 *
 * So this suite asserts the exception *positively* — a user in one programme
 * must see definitions created by a user in another — alongside the usual
 * cross-tenant denials. If someone adds programme scoping to these tables, the
 * suite fails and says why.
 */

const OBJECT_A = '11111111-0000-4000-8000-0000000f0001';
const OBJECT_B = '22222222-0000-4000-8000-0000000f0002';

describe('acceptance (pending): metadata definition isolation', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 5 });
  });

  afterAll(async () => {
    await pool.end();
  });

  /**
   * T-0002 implements this; it is part of the task, not of the contract.
   *
   * AMENDED BY THE LEAD, 2026-09-27. This was a local stub that threw, and the
   * task said both "implementing it is yours" and "never edit
   * tests/acceptance/". Those cannot both hold when the helper lives inside the
   * protected file — a contradiction in the task design, not in the builder.
   *
   * The T-0002 builder spotted it, refused to route around the hook, and
   * implemented the fixture where a builder legitimately can: exported from
   * `@kasuwa/testing`, covered end to end by
   * `packages/testing/src/metadata-factories.integration.test.ts`. This is the
   * one-line delegation it could not make itself.
   *
   * The lesson, recorded for the next pending suite: a fixture a builder must
   * implement belongs in `@kasuwa/testing` from the start, so nobody ever needs
   * a hand on the acceptance file to finish their task.
   *
   * It runs through `withTenantTransaction` and the real repository — not a
   * privileged connection — so seeding is subject to the same RLS the
   * assertions are testing.
   */
  const seedObjectDef = async (tenantId: string, objectId: string, apiName: string) =>
    seedObjectDefFixture(pool, tenantId, objectId, apiName);

  it('puts the new tables under the same catalogue invariant as everything else', async () => {
    // RLS enabled AND forced, at least one policy. The same check that guards
    // every other table — metadata gets no exemption for being configuration.
    const state = await readTableSecurity(pool);
    const byTable = new Map(state.map((row) => [row.table, row]));

    for (const table of ['object_def', 'field_def']) {
      const row = byTable.get(table);
      expect(row, `${table} does not exist`).toBeDefined();
      expect(row?.rlsEnabled, `${table}: RLS not enabled`).toBe(true);
      expect(row?.rlsForced, `${table}: RLS not FORCED`).toBe(true);
      expect(row?.policyCount, `${table}: no policy`).toBeGreaterThan(0);
    }
  });

  it('registers the new tables in TENANT_SCOPED_TABLES', () => {
    // Forgetting this is how a table ends up outside the invariant above.
    expect(TENANT_SCOPED_TABLES).toContain('object_def');
    expect(TENANT_SCOPED_TABLES).toContain('field_def');
  });

  it('does not let tenant A read tenant B object definitions', async () => {
    await seedObjectDef(TENANT_B, OBJECT_B, 'competitor_intel');

    const visible = await withTenantTransaction(
      pool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => tx.query<{ id: string }>('SELECT id FROM object_def WHERE id = $1', [OBJECT_B]),
    );

    expect(visible).toEqual([]);
  });

  it('does not let tenant A read tenant B field definitions', async () => {
    const visible = await withTenantTransaction(
      pool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) =>
        tx.query<{ id: string }>('SELECT id FROM field_def WHERE tenant_id = $1', [TENANT_B]),
    );

    expect(visible).toEqual([]);
  });

  it('does not let tenant A update or delete a tenant B definition, even knowing its id', async () => {
    // Knowing the id is the realistic case: ids leak through logs, screenshots
    // and support tickets far more often than through the API.
    const updated = await withTenantTransaction(
      pool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) =>
        tx.query<{ id: string }>(
          `UPDATE object_def SET label = 'hijacked' WHERE id = $1 RETURNING id`,
          [OBJECT_B],
        ),
    );
    expect(updated).toEqual([]);

    const deleted = await withTenantTransaction(
      pool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) =>
        tx.query<{ id: string }>('DELETE FROM object_def WHERE id = $1 RETURNING id', [OBJECT_B]),
    );
    expect(deleted).toEqual([]);
  });

  it('refuses a field definition pointing at another tenant object definition', async () => {
    await seedObjectDef(TENANT_A, OBJECT_A, 'site_visit');

    // The composite foreign key carrying tenant_id is what makes this
    // impossible rather than merely unlikely.
    await expect(
      withTenantTransaction(pool, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, async (tx) =>
        tx.query(
          `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type)
           VALUES (gen_random_uuid(), $1, $2, 'leak', 'Leak', 'text')`,
          [TENANT_A, OBJECT_B],
        ),
      ),
    ).rejects.toThrow();
  });

  it('scopes api_name uniqueness per tenant and object, not globally', async () => {
    // Two tenants must both be able to call a field "priority". A global unique
    // index would mean the first tenant to define a name takes it from everyone.
    await seedObjectDef(TENANT_A, OBJECT_A, 'site_visit');
    await seedObjectDef(TENANT_B, OBJECT_B, 'site_visit');

    const insert = (tenantId: string, objectId: string, userId: string) =>
      withTenantTransaction(pool, { tenantId, userId }, async (tx) =>
        tx.query(
          `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type)
           VALUES (gen_random_uuid(), $1, $2, 'priority', 'Priority', 'text')`,
          [tenantId, objectId],
        ),
      );

    await expect(insert(TENANT_A, OBJECT_A, USER_A_AGENT_1)).resolves.toBeDefined();
    await expect(insert(TENANT_B, OBJECT_B, USER_B_AGENT_1)).resolves.toBeDefined();

    // Same name twice on the same object, though, is still a conflict.
    await expect(insert(TENANT_A, OBJECT_A, USER_A_AGENT_1)).rejects.toThrow();
  });

  /**
   * The deliberate exception, asserted positively.
   *
   * A custom field belongs to the tenant, not to a client programme. An agent
   * on programme A2 must see a definition created by an agent on A1 — otherwise
   * a BPO's own admin could not configure the objects its agents use.
   */
  it('is tenant-scoped but NOT programme-scoped', async () => {
    await seedObjectDef(TENANT_A, OBJECT_A, 'site_visit');

    // USER_A_AGENT_2 is in programme A2 only; the definition was made under A1.
    const visible = await withTenantTransaction(
      pool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_2 },
      async (tx) => tx.query<{ id: string }>('SELECT id FROM object_def WHERE id = $1', [OBJECT_A]),
    );

    expect(
      visible,
      'metadata must not be programme-scoped — see the comment at the top of this file',
    ).toHaveLength(1);
  });

  it('still denies cross-tenant reads when the programme scope is forged', async () => {
    // The application layer compromised entirely: any session variable the
    // attacker likes. The tenant predicate must still hold.
    const rows = await withForcedScope(
      pool,
      { tenantId: TENANT_A, programmeIds: [PROGRAMME_A1] },
      async (query) =>
        query<{ id: string }>('SELECT id FROM object_def WHERE tenant_id = $1', [TENANT_B]),
    );

    expect(rows).toEqual([]);
  });

  it('denies everything when no session context is set at all', async () => {
    const rows = await withForcedScope(pool, {}, async (query) =>
      query<{ count: string }>('SELECT count(*)::text AS count FROM object_def'),
    );
    expect(Number(rows[0]?.count ?? -1)).toBe(0);
  });
});
