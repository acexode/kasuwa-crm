import {
  createPool,
  TENANT_A,
  TENANT_B,
  USER_A_SUPERVISOR,
  withAuthTransaction,
  withTenantTransaction,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * ACCEPTANCE — T-0157 (T-0075, D-L70, ADR-0013 decision 6): sign-in's reads of
 * credentials and MFA secrets leave the `kasuwa_app` pool, and `kasuwa_app` can
 * no longer read them. D-A3: a personal-review path (@acexode).
 *
 * THE GAP. T-0049 moved the auth tables' WRITES to `kasuwa_auth`. Their READS
 * stayed on `kasuwa_app`: sign-in phase one (`findAccount`) reads
 * `user_credential.password_hash` on the general pool. So any SQL injection or
 * misused query on the app pool can still read every password hash in the
 * tenant. This suite holds the second half: the app role has no SELECT on a
 * credential hash or an MFA secret, whatever the code does.
 *
 * File-free and API-free by design. It asks the catalogue what `kasuwa_app` may
 * read, then proves the refusal with real statements. That sign-in still works
 * end to end on the auth pool is held by the existing smoke test in
 * `platform/auth-role.acceptance.test.ts`, which must keep passing, and by the
 * `@p01-auth`, `@p02-live` and `@bff-session` e2e tags the task names.
 *
 * What is held:
 *
 *   1. `kasuwa_app` cannot SELECT any column of `user_credential`, and cannot
 *      SELECT the secret columns of `user_mfa_factor` (the legacy plaintext
 *      `secret` included) or `user_mfa_backup_code`.
 *   2. What `kasuwa_app` CAN select on those three tables is exactly the named
 *      non-secret columns the session interceptor, the admin home and
 *      `GET /auth/me/mfa` need, and no table has a table-level SELECT for it.
 *      Widening it is a diff to this list, not a quiet GRANT.
 *   3. As the app role, inside a tenant transaction, each secret read is refused
 *      with 42501 (`SELECT *` included), while the retained reads still work.
 *      Non-vacuous: the same reads succeed as `kasuwa_auth`, inside its own
 *      tenant only.
 *   4. A catalogue standing test: any public table with a credential or secret
 *      column must be one of the three above, so a new auth table cannot skip
 *      the revoke.
 *
 * Out of scope, and not asserted: dropping the legacy `user_mfa_factor.secret`
 * column (a contract migration of its own, see the task file), and
 * `auth_session.token_hash`, which is a SHA-256 of a random token and stays
 * readable for the session interceptor.
 */

/** Columns that must be unreadable by the app role. */
const SECRET_COLUMNS: Record<string, readonly string[]> = {
  portal_identity: ['password_hash'],
  portal_session: ['token_hash'],
  user_credential: ['password_hash'],
  user_mfa_factor: [
    'secret',
    'secret_ciphertext',
    'secret_wrapped_key',
    'secret_key_id',
    'secret_algorithm',
  ],
  user_mfa_backup_code: ['code_hash', 'hash_key_wrapped', 'hash_key_id', 'hash_algorithm'],
};

/**
 * Exactly what the app role may still read. `user_credential` has none: the
 * app pool never needs a credential row. `user_mfa_factor` and
 * `user_mfa_backup_code` keep the columns the MFA status read and the admin
 * home count (`id`, `tenant_id`, `user_id`, `type`, `confirmed_at`; `used_at`
 * for unused backup codes).
 */
const READABLE_COLUMNS: Record<string, readonly string[]> = {
  portal_identity: [
    'created_at',
    'display_name',
    'email',
    'email_masked',
    'id',
    'programme_id',
    'status',
    'tenant_id',
    'updated_at',
  ],
  portal_session: [
    'created_at',
    'expires_at',
    'id',
    'portal_identity_id',
    'programme_id',
    'revoked_at',
    'tenant_id',
    'updated_at',
  ],
  user_credential: [],
  user_mfa_factor: ['confirmed_at', 'id', 'tenant_id', 'type', 'user_id'],
  user_mfa_backup_code: ['id', 'tenant_id', 'used_at', 'user_id'],
};

const AUTH_TABLES = Object.keys(SECRET_COLUMNS);
const TENANT_A_SLUG = 'sahel-bpo';
const SUITE_APP_NAME = 'acceptance-t0157';

/** Every name that marks a credential or a secret. A table owning one must be listed above. */
const SECRET_COLUMN_NAMES = [
  'password_hash',
  'token_hash',
  'code_hash',
  'hash_key_wrapped',
  'secret',
  'secret_ciphertext',
  'secret_wrapped_key',
];

function sqlState(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : `non-sql error: ${String(error)}`;
}

function authDatabaseUrl(): string {
  const value: unknown = (inject as unknown as (key: string) => unknown)('authDatabaseUrl');
  if (typeof value !== 'string' || value === '') {
    throw new Error("The harness provides no inject('authDatabaseUrl') (T-0049 I7)");
  }
  if (new URL(value).username !== 'kasuwa_auth') {
    throw new Error("inject('authDatabaseUrl') does not log in as kasuwa_auth");
  }
  return value;
}

describe('acceptance: sign-in reads leave the app pool (T-0157)', () => {
  let appPool: Pool;
  let authPool: Pool;
  /** kasuwa_test_admin: reads the catalogue. */
  let catalogue: Pool;

  beforeAll(() => {
    appPool = createPool({
      connectionString: inject('databaseUrl'),
      max: 2,
      applicationName: SUITE_APP_NAME,
    });
    authPool = createPool({
      connectionString: authDatabaseUrl(),
      max: 2,
      applicationName: SUITE_APP_NAME,
    });
    catalogue = createPool({
      connectionString: inject('testAdminUrl'),
      max: 1,
      applicationName: SUITE_APP_NAME,
    });
  });

  afterAll(async () => {
    await appPool?.end();
    await authPool?.end();
    await catalogue?.end();
    await reseed(inject('migrationUrl'));
  });

  /** Columns of `table` for which `has_column_privilege(kasuwa_app, ..., 'SELECT')` holds, sorted. */
  async function selectableByApp(table: string): Promise<string[]> {
    const result = await catalogue.query<{ attname: string }>(
      `SELECT a.attname
         FROM pg_attribute a
        WHERE a.attrelid = ('public.' || $1)::regclass
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND has_column_privilege('kasuwa_app', a.attrelid, a.attnum, 'SELECT')
        ORDER BY a.attname`,
      [table],
    );
    return result.rows.map((row) => row.attname);
  }

  async function asApp(sql: string): Promise<{ ok: true } | { code: string }> {
    try {
      await withTenantTransaction(
        appPool,
        { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
        async (tx) => {
          await tx.query(sql);
        },
      );
      return { ok: true };
    } catch (error) {
      return { code: sqlState(error) };
    }
  }

  // =========================================================================
  // 1 and 2. What the catalogue says kasuwa_app may read.
  // =========================================================================

  describe('1. no credential hash or MFA secret is selectable by kasuwa_app', () => {
    for (const [table, columns] of Object.entries(SECRET_COLUMNS)) {
      for (const column of columns) {
        it(`${table}.${column}`, async () => {
          const exists = await catalogue.query(
            `SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
            [table, column],
          );
          expect(exists.rowCount, `precondition: ${table}.${column} exists`).toBe(1);

          const privilege = await catalogue.query<{ ok: boolean }>(
            `SELECT has_column_privilege('kasuwa_app', $1, $2, 'SELECT') AS ok`,
            [`public.${table}`, column],
          );
          expect(privilege.rows[0]?.ok, `kasuwa_app can SELECT ${table}.${column}`).toBe(false);
        });
      }
    }
  });

  describe('2. what kasuwa_app can still read is exactly the named columns', () => {
    for (const table of AUTH_TABLES) {
      it(`${table}: only ${READABLE_COLUMNS[table]?.join(', ') || 'nothing'}`, async () => {
        expect(await selectableByApp(table)).toEqual([...(READABLE_COLUMNS[table] ?? [])]);
      });

      it(`${table}: no table-level SELECT`, async () => {
        const privilege = await catalogue.query<{ ok: boolean }>(
          `SELECT has_table_privilege('kasuwa_app', $1, 'SELECT') AS ok`,
          [`public.${table}`],
        );
        expect(
          privilege.rows[0]?.ok,
          `a table-level SELECT on ${table} would expose every column`,
        ).toBe(false);
      });
    }
  });

  // =========================================================================
  // 3. Real statements, as the app role and as kasuwa_auth.
  // =========================================================================

  describe('3. the refusal is real, and the retained reads still work', () => {
    const refused: Array<[string, string]> = [
      ['the password hash', 'SELECT password_hash FROM user_credential'],
      ['SELECT * on user_credential', 'SELECT * FROM user_credential'],
      ['the legacy plaintext MFA secret', 'SELECT secret FROM user_mfa_factor'],
      ['the MFA secret ciphertext', 'SELECT secret_ciphertext FROM user_mfa_factor'],
      ['SELECT * on user_mfa_factor', 'SELECT * FROM user_mfa_factor'],
      ['the backup-code hash', 'SELECT code_hash FROM user_mfa_backup_code'],
      ['SELECT * on user_mfa_backup_code', 'SELECT * FROM user_mfa_backup_code'],
      ['the portal password hash', 'SELECT password_hash FROM portal_identity'],
      ['the portal session digest', 'SELECT token_hash FROM portal_session'],
    ];
    for (const [label, sql] of refused) {
      it(`refuses ${label} with 42501`, async () => {
        expect(await asApp(sql)).toEqual({ code: '42501' });
      });
    }

    const allowed: Array<[string, string]> = [
      [
        'the confirmed MFA factor count (admin home)',
        'SELECT count(*) FROM user_mfa_factor WHERE confirmed_at IS NOT NULL',
      ],
      [
        'the MFA status read (GET /auth/me/mfa)',
        'SELECT id, type, confirmed_at FROM user_mfa_factor WHERE user_id = app.current_user_id()',
      ],
      [
        'the unused backup-code count',
        'SELECT count(*) FROM user_mfa_backup_code WHERE used_at IS NULL AND user_id = app.current_user_id()',
      ],
      [
        'the session interceptor re-read',
        'SELECT id, tenant_id, user_id, revoked_at, expires_at FROM auth_session',
      ],
    ];
    for (const [label, sql] of allowed) {
      it(`still allows ${label}`, async () => {
        expect(await asApp(sql)).toEqual({ ok: true });
      });
    }

    it('control: kasuwa_auth reads the same secrets inside its own tenant, and no other', async () => {
      const own = await withAuthTransaction(authPool, { tenantSlug: TENANT_A_SLUG }, async (tx) => {
        const hashes = await tx.query<{ n: number }>(
          'SELECT count(password_hash)::int AS n FROM user_credential WHERE tenant_id = $1',
          [TENANT_A],
        );
        const secrets = await tx.query<{ n: number }>(
          'SELECT count(secret_ciphertext)::int AS n FROM user_mfa_factor WHERE tenant_id = $1',
          [TENANT_A],
        );
        const foreign = await tx.query<{ n: number }>(
          `SELECT (SELECT count(*) FROM user_credential WHERE tenant_id = $1)
                + (SELECT count(*) FROM user_mfa_factor WHERE tenant_id = $1)
                + (SELECT count(*) FROM user_mfa_backup_code WHERE tenant_id = $1) AS n`,
          [TENANT_B],
        );
        return {
          hashes: hashes[0]?.n,
          secrets: secrets[0]?.n,
          foreign: Number(foreign[0]?.n),
        };
      });
      expect(own.hashes, 'precondition: tenant A has credentials').toBeGreaterThan(0);
      expect(own.secrets, 'precondition: tenant A has an MFA secret').toBeGreaterThan(0);
      expect(own.foreign, 'kasuwa_auth saw another tenant').toBe(0);
    });
  });

  // =========================================================================
  // 4. The standing catalogue test.
  // =========================================================================

  describe('4. a new auth table cannot skip the revoke', () => {
    it('every public table with a credential or secret column is one of the three listed', async () => {
      const result = await catalogue.query<{ table_name: string; column_name: string }>(
        `SELECT c.table_name, c.column_name
           FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public'
            AND t.table_type = 'BASE TABLE'
            AND c.column_name = ANY ($1::text[])
          ORDER BY c.table_name, c.column_name`,
        [SECRET_COLUMN_NAMES],
      );
      expect(
        result.rows.length,
        'non-vacuous: the walk found the known secret columns',
      ).toBeGreaterThan(0);
      const strangers = result.rows
        .filter((row) => {
          if (row.table_name === 'auth_session' && row.column_name === 'token_hash') {
            return false;
          }
          return !AUTH_TABLES.includes(row.table_name);
        })
        .map((row) => `${row.table_name}.${row.column_name}`);
      expect(
        strangers,
        'a table with a credential or secret column that this suite (and its revoke) does not know',
      ).toEqual([]);
    });
  });
});
