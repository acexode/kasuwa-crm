import type { Pool } from 'pg';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createPool } from './pool';
import { SessionScopeViolationError, withTenantTransaction } from './session';
import { withAuthTransaction } from './auth';
import {
  PROGRAMME_A1,
  PROGRAMME_B1,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
} from './fixtures';

/**
 * T-0020 / T-0004 FINDING-1 — a `TenantTx` callback re-scoping itself.
 *
 * `tx.query` is an unrestricted statement channel on the connection that holds
 * the RLS session GUCs, and `set_config` is executable by `kasuwa_app` (so is
 * `SET LOCAL`, which cannot be revoked for a user-settable parameter). A
 * callback can therefore point `app.tenant_id` at another tenant while
 * `tx.session.tenantId` still reports the first one.
 *
 * ADR-0010 argues why that cannot be closed with a privilege on the same
 * connection under the same role, and what is enforced instead:
 *
 *   * a result produced under a changed context is never RETURNED, and
 *   * a write made under a changed context never COMMITS.
 *
 * These tests assert both halves, and — just as importantly — the two cases
 * that must NOT trip the control: an ordinary transaction, and a subtransaction
 * that carries the GUCs away and back.
 */
describe('the session scope is verified before a tenant transaction commits', () => {
  let appPool: Pool;

  beforeAll(() => {
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 4 });
  });

  afterAll(async () => {
    await appPool.end();
  });

  it('refuses to return a result read under a re-pointed tenant', async () => {
    const attack = withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => {
        // Exactly the reproduction in team/reports/T-0004.md.
        await tx.query(
          `SELECT set_config('app.tenant_id', $1, true),
                  set_config('app.programme_ids', $2, true)`,
          [TENANT_B, `{${PROGRAMME_B1}}`],
        );
        const rows = await tx.query<{ tenant_id: string }>('SELECT tenant_id FROM contact');
        // The read itself still succeeds — RLS is reading the value the callback
        // just wrote, and no privilege can prevent that. What must not happen is
        // this value reaching the caller.
        expect(rows.length).toBeGreaterThan(0);
        return rows.map((row) => row.tenant_id);
      },
    );

    await expect(attack).rejects.toBeInstanceOf(SessionScopeViolationError);
  });

  it('is tripped by `SET LOCAL` as well as by set_config', async () => {
    // The obvious "fix" is to refuse statements containing `set_config`. It
    // would not be one: `SET LOCAL` reaches the same GUC and Postgres has no way
    // to restrict it for a user-settable parameter. The control is at commit
    // for that reason, and this test is what stops anybody replacing it with a
    // statement filter and believing the filter is sufficient.
    const attack = withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => {
        await tx.query(`SET LOCAL app.tenant_id = '${TENANT_B}'`);
        return 'not reached';
      },
    );

    await expect(attack).rejects.toBeInstanceOf(SessionScopeViolationError);
  });

  it('does not let a write made under a re-pointed tenant commit', async () => {
    const displayName = 'T-0020 scope violation probe';
    const probeId = '33333333-0000-4000-8000-00000000f001';

    const attack = withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => {
        await tx.query(
          `SELECT set_config('app.tenant_id', $1, true),
                  set_config('app.programme_ids', $2, true)`,
          [TENANT_B, `{${PROGRAMME_B1}}`],
        );
        await tx.query(
          `INSERT INTO contact (id, tenant_id, programme_id, display_name)
                VALUES ($1, $2, $3, $4)`,
          [probeId, TENANT_B, PROGRAMME_B1, displayName],
        );
        return 'inserted';
      },
    );

    await expect(attack).rejects.toBeInstanceOf(SessionScopeViolationError);

    // Read back with BYPASSRLS, so "it is not there" means it is not there
    // rather than "this session cannot see it".
    const migrator = new Client({ connectionString: inject('migrationUrl') });
    await migrator.connect();
    try {
      const rows = await migrator.query('SELECT id FROM contact WHERE id = $1', [probeId]);
      expect(rows.rowCount, 'a row written under a forged scope reached the database').toBe(0);
    } finally {
      await migrator.end();
    }
  });

  it('leaves an ordinary transaction alone', async () => {
    // NOT VACUOUS: the control has to be capable of passing, and this is the
    // path every request in the system takes.
    const seen = await withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => {
        const rows = await tx.query<{ programme_id: string }>('SELECT programme_id FROM contact');
        return new Set(rows.map((row) => row.programme_id));
      },
    );
    expect(seen).toEqual(new Set([PROGRAMME_A1]));
  });

  it('leaves a subtransaction that restores the context alone', async () => {
    // `ROLLBACK TO SAVEPOINT` reverts a transaction-local set_config to the
    // enclosing value, so the context in force at COMMIT is the resolved one
    // and there is nothing to object to. Checking after every statement instead
    // would have failed here, for no gain: what has to be true is that work
    // becomes durable under the resolved scope.
    const observed = await withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => {
        await tx.query('SAVEPOINT probe');
        await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
        await tx.query('ROLLBACK TO SAVEPOINT probe');
        const rows = await tx.query<{ tenant: string | null }>(
          `SELECT current_setting('app.tenant_id', true) AS tenant`,
        );
        return rows[0]?.tenant;
      },
    );
    expect(observed).toBe(TENANT_A);
  });

  it('covers the authentication transaction too, which is the narrowest scope there is', async () => {
    const attack = withAuthTransaction(appPool, { tenantId: TENANT_A }, async (tx) => {
      await tx.query(`SELECT set_config('app.programme_ids', $1, true)`, [`{${PROGRAMME_A1}}`]);
      return 'widened';
    });

    await expect(attack).rejects.toBeInstanceOf(SessionScopeViolationError);
  });

  it('lets an ordinary authentication transaction commit', async () => {
    const resolved = await withAuthTransaction(appPool, { tenantId: TENANT_A }, async (tx) => {
      const rows = await tx.query<{ id: string }>('SELECT id FROM tenant');
      return { tenantId: tx.tenantId, ids: rows.map((row) => row.id) };
    });
    expect(resolved.tenantId).toBe(TENANT_A);
    expect(resolved.ids).toEqual([TENANT_A]);
  });
});
