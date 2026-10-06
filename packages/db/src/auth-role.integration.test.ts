import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { withAuthTransaction } from './auth';
import { TENANT_A, USER_A_AGENT_1, USER_A_SUPERVISOR } from './fixtures';
import { createPool } from './pool';
import { runSeed } from './seed';
import { SessionScopeViolationError, withTenantTransaction } from './session';

/**
 * What migration 0024 gives kasuwa_auth, seen from the helpers the API uses on
 * the auth pool (T-0049, D-P16).
 *
 * The acceptance suite (tests/acceptance/platform/auth-role) proves the
 * boundary: kasuwa_app is refused every auth-table write, and kasuwa_auth's
 * privileges are exactly the planned allowlist. This file proves the other
 * half, at the level of @kasuwa/db: the two transaction helpers still do
 * their job on a kasuwa_auth connection, and the narrowings in 0024 hold
 * (UPDATE on named columns only, no app.resolve_session, no role to borrow).
 */
describe('kasuwa_auth through the @kasuwa/db helpers (T-0049)', () => {
  let auth: Pool;
  /** One connection, so "the next checkout" is the same backend. */
  let single: Pool;

  const sqlState = (error: unknown): string => {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : `not a database error: ${String(error)}`;
  };

  async function refusal(work: Promise<unknown>): Promise<string> {
    try {
      await work;
      return 'committed';
    } catch (error) {
      return sqlState(error);
    }
  }

  beforeAll(() => {
    auth = createPool({ connectionString: inject('authDatabaseUrl'), max: 3 });
    single = createPool({ connectionString: inject('authDatabaseUrl'), max: 1 });
  });

  afterEach(async () => {
    await runSeed({ connectionString: inject('migrationUrl') });
  });

  afterAll(async () => {
    await auth.end();
    await single.end();
  });

  it('logs in as kasuwa_auth (the harness hands out the right URL)', async () => {
    const who = await auth.query<{ who: string }>('SELECT current_user::text AS who');
    expect(who.rows[0]?.who).toBe('kasuwa_auth');
  });

  it('withAuthTransaction resolves a slug and writes a session, revocable by revoked_at', async () => {
    const id = randomUUID();
    await withAuthTransaction(auth, { tenantSlug: 'sahel-bpo' }, async (tx) => {
      expect(tx.tenantId).toBe(TENANT_A);
      await tx.query(
        `INSERT INTO auth_session (id, tenant_id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
        [id, TENANT_A, USER_A_AGENT_1, randomBytes(32)],
      );
    });
    const revoked = await withAuthTransaction(auth, { tenantId: TENANT_A }, (tx) =>
      tx.query<{ id: string }>(
        `UPDATE auth_session SET revoked_at = now()
          WHERE tenant_id = $1 AND id = $2 RETURNING id`,
        [TENANT_A, id],
      ),
    );
    expect(revoked).toEqual([{ id }]);
  });

  it('cannot extend a session, re-point it, or rewrite its token: UPDATE is revoked_at only', async () => {
    const outcomes: Record<string, string> = {};
    for (const [column, value] of [
      ['expires_at', "now() + interval '30 days'"],
      ['user_id', `'${USER_A_SUPERVISOR}'::uuid`],
      ['token_hash', "'\\x00'::bytea"],
    ] as const) {
      outcomes[column] = await refusal(
        withAuthTransaction(auth, { tenantId: TENANT_A }, (tx) =>
          tx.query(`UPDATE auth_session SET ${column} = ${value} WHERE tenant_id = $1`, [TENANT_A]),
        ),
      );
    }
    expect(outcomes).toEqual({ expires_at: '42501', user_id: '42501', token_hash: '42501' });
  });

  it('withTenantTransaction on the auth pool resolves the user programme scope (the /auth/me/mfa path)', async () => {
    const scope = await withTenantTransaction(
      auth,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => tx.session.programmeIds,
    );
    expect(scope.length).toBeGreaterThan(0);
  });

  it('may lock a user row FOR UPDATE (lockUserForFactorWrite) but change nothing on it except updated_at', async () => {
    const locked = await withAuthTransaction(auth, { tenantId: TENANT_A }, (tx) =>
      tx.query<{ id: string }>(
        `SELECT id FROM "user" WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [TENANT_A, USER_A_AGENT_1],
      ),
    );
    expect(locked).toEqual([{ id: USER_A_AGENT_1 }]);

    const outcomes: Record<string, string> = {};
    for (const [column, value] of [
      ['status', "'disabled'"],
      ['email', "'changed@tenant-a.test'"],
      ['is_tenant_admin', 'true'],
    ] as const) {
      outcomes[column] = await refusal(
        withAuthTransaction(auth, { tenantId: TENANT_A }, (tx) =>
          tx.query(`UPDATE "user" SET ${column} = ${value} WHERE id = $1`, [USER_A_AGENT_1]),
        ),
      );
    }
    expect(outcomes).toEqual({ status: '42501', email: '42501', is_tenant_admin: '42501' });
  });

  it('cannot call app.resolve_session: that SECURITY DEFINER read stays with kasuwa_app', async () => {
    expect(
      await refusal(auth.query('SELECT * FROM app.resolve_session($1)', [randomBytes(32)])),
    ).toBe('42501');
  });

  it('has no role to borrow: set_config(role, ...) is refused and the connection stays clean', async () => {
    const attack = await refusal(
      withAuthTransaction(single, { tenantId: TENANT_A }, (tx) =>
        tx.query(`SELECT set_config('role', 'kasuwa_app', false)`),
      ),
    );
    expect(attack).toBe('42501');
    const who = await single.query<{ who: string }>('SELECT current_user::text AS who');
    expect(who.rows[0]?.who).toBe('kasuwa_auth');
  });

  it('keeps the commit-time scope check on the auth pool (ADR-0010)', async () => {
    const forged = withAuthTransaction(auth, { tenantId: TENANT_A }, (tx) =>
      tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [randomUUID()]),
    );
    await expect(forged).rejects.toBeInstanceOf(SessionScopeViolationError);
  });
});
