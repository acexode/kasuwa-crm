import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { withAuthTransaction } from './auth';
import { pruneAuthTables } from './auth-retention';
import { TENANT_A, TENANT_B, USER_A_AGENT_1, USER_B_AGENT_1 } from './fixtures';
import { createPool } from './pool';
import { SessionScopeViolationError, withTenantTransaction } from './session';

/**
 * T-0045 security review: kasuwa_app is a member of kasuwa_sweeper (D-L66,
 * NOINHERIT, SET), so any SQL on a kasuwa_app connection can switch to it -
 * `SET ROLE`, or `set_config('role', ...)` inside a SELECT. Under the sweeper
 * the dead-row policies apply across every tenant while the app.* GUCs still
 * read as resolved. These tests pin the controls: the role is part of the
 * verified scope, and no role survives on a pooled connection.
 */
describe('a tenant or auth transaction cannot borrow kasuwa_sweeper', () => {
  let pool: Pool;
  /** One connection, so "the next checkout" is the same backend. */
  let single: Pool;
  const planted: string[] = [];

  async function asMigrator<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: inject('migrationUrl') });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 4 });
    single = createPool({ connectionString: inject('databaseUrl'), max: 1 });
    // A dead tenant-B challenge: what the sweeper's policies would expose to a
    // tenant-A transaction that switched role.
    const id = randomUUID();
    planted.push(id);
    await asMigrator((client) =>
      client.query(
        `INSERT INTO auth_challenge (id, tenant_id, user_id, method, expires_at, created_at)
         VALUES ($1, $2, $3, 'totp', now() - interval '3 days', now() - interval '3 days')`,
        [id, TENANT_B, USER_B_AGENT_1],
      ),
    );
  });

  afterAll(async () => {
    await asMigrator((client) =>
      client.query('DELETE FROM auth_challenge WHERE id = ANY($1::uuid[])', [planted]),
    );
    await pool.end();
    await single.end();
  });

  const currentUser = async (target: Pool): Promise<string | undefined> =>
    (await target.query<{ who: string }>('SELECT current_user::text AS who')).rows[0]?.who;

  it('refuses set_config(role, kasuwa_sweeper, true) inside withTenantTransaction', async () => {
    let sawTenantB = -1;
    const attack = withTenantTransaction(
      pool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => {
        await tx.query(`SELECT set_config('role', 'kasuwa_sweeper', true)`);
        // Non-vacuous: the switch really does open tenant B's dead rows.
        const rows = await tx.query<{ n: string }>(
          'SELECT count(*) AS n FROM auth_challenge WHERE id = ANY($1::uuid[])',
          [planted],
        );
        sawTenantB = Number(rows[0]?.n);
        return rows;
      },
    );
    await expect(attack).rejects.toBeInstanceOf(SessionScopeViolationError);
    expect(sawTenantB, 'the attack did not reach the sweeper policies').toBe(1);
  });

  it('refuses SET LOCAL ROLE and SET ROLE alike', async () => {
    for (const statement of ['SET LOCAL ROLE kasuwa_sweeper', 'SET ROLE kasuwa_sweeper']) {
      const attack = withTenantTransaction(
        single,
        { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
        async (tx) => {
          await tx.query(statement);
          return 'not reached';
        },
      );
      await expect(attack, statement).rejects.toBeInstanceOf(SessionScopeViolationError);
      expect(await currentUser(single), `${statement} leaked to the next checkout`).toBe(
        'kasuwa_app',
      );
    }
  });

  it('does not let a session-scoped role leak to the next checkout', async () => {
    const attack = withTenantTransaction(
      single,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => {
        await tx.query(`SELECT set_config('role', 'kasuwa_sweeper', false)`);
        return 'not reached';
      },
    );
    await expect(attack).rejects.toBeInstanceOf(SessionScopeViolationError);
    expect(await currentUser(single)).toBe('kasuwa_app');
  });

  it('resets a session-scoped role hidden behind a local reset at commit', async () => {
    // The callback sets the role for the SESSION, then masks it for the rest
    // of the transaction, so the commit-time check sees kasuwa_app. After
    // COMMIT the session value would come back on the pooled connection;
    // releaseClean's RESET ROLE is what stops it reaching the next user.
    await withTenantTransaction(
      single,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => {
        await tx.query(`SELECT set_config('role', 'kasuwa_sweeper', false)`);
        await tx.query(`SELECT set_config('role', 'none', true)`);
        return null;
      },
    ).catch(() => null);
    expect(await currentUser(single)).toBe('kasuwa_app');
    const seen = await single.query<{ n: string }>('SELECT count(*) AS n FROM auth_challenge');
    expect(Number(seen.rows[0]?.n)).toBe(0);
  });

  it('refuses the same switch inside withAuthTransaction', async () => {
    const attack = withAuthTransaction(single, { tenantSlug: 'sahel-bpo' }, async (tx) => {
      await tx.query(`SELECT set_config('role', 'kasuwa_sweeper', true)`);
      return 'not reached';
    });
    await expect(attack).rejects.toBeInstanceOf(SessionScopeViolationError);
    expect(await currentUser(single)).toBe('kasuwa_app');
  });

  it('returns the prune connection to the pool as kasuwa_app', async () => {
    // `now` in 1970: the role switch and its checks run, but the WHERE layer
    // matches nothing, so rows other test files planted are left alone.
    const counts = await pruneAuthTables(single, { now: new Date(0), batchSize: 1 });
    expect(counts).toEqual({ authChallenge: 0, authSession: 0, authRateLimit: 0 });
    expect(await currentUser(single)).toBe('kasuwa_app');
  });
});

describe('kasuwa_sweeper reads only the columns the sweep needs', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 1 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('holds column-level SELECT, not table-level, and no token hash or tenant id', async () => {
    const result = await pool.query<{
      session_table: boolean;
      session_id: boolean;
      session_token: boolean;
      session_tenant: boolean;
      challenge_user: boolean;
      rate_key: boolean;
      rate_count: boolean;
    }>(
      `SELECT has_table_privilege('kasuwa_sweeper', 'auth_session', 'SELECT')                AS session_table,
              has_column_privilege('kasuwa_sweeper', 'auth_session', 'id', 'SELECT')          AS session_id,
              has_column_privilege('kasuwa_sweeper', 'auth_session', 'token_hash', 'SELECT')  AS session_token,
              has_column_privilege('kasuwa_sweeper', 'auth_session', 'tenant_id', 'SELECT')   AS session_tenant,
              has_column_privilege('kasuwa_sweeper', 'auth_challenge', 'user_id', 'SELECT')   AS challenge_user,
              has_column_privilege('kasuwa_sweeper', 'auth_rate_limit', 'key_hash', 'SELECT') AS rate_key,
              has_column_privilege('kasuwa_sweeper', 'auth_rate_limit', 'failed_count', 'SELECT') AS rate_count`,
    );
    expect(result.rows[0]).toEqual({
      session_table: false,
      session_id: true,
      session_token: false,
      session_tenant: false,
      challenge_user: false,
      rate_key: true,
      rate_count: false,
    });
  });

  it('is refused a token hash even for a dead row it can delete', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE kasuwa_sweeper');
      await expect(client.query('SELECT token_hash FROM auth_session')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await client.query('ROLLBACK');
      await client.query('RESET ROLE');
      client.release();
    }
  });
});
