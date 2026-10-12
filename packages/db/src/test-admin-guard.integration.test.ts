import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { runMigrations } from './migrate';
import { createPool } from './pool';
import {
  readTestAdminUsability,
  refuseUsableTestAdminAtBoot,
  UsableTestAdminError,
} from './test-admin-guard';

/**
 * T-0117 (D-L94 addendum): the boot check reads the real catalogue as
 * kasuwa_app, the role the API and worker pools log in as.
 *
 * The shared harness has the LIVE test login by design (bootstrap-test.sql),
 * so here the role is usable: production refuses, test starts. The inert
 * case, and the runner against both, are the acceptance suite's
 * (tests/acceptance/tenancy/test-admin-absent), which builds its own
 * clusters because roles are cluster-wide.
 */
describe('refuseUsableTestAdminAtBoot on the app pool', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 1 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('kasuwa_app can see that the harness role logs in and bypasses RLS', async () => {
    const who = await pool.query<{ who: string }>('SELECT current_user::text AS who');
    expect(who.rows).toEqual([{ who: 'kasuwa_app' }]);
    expect(await readTestAdminUsability(pool)).toEqual([
      'it can log in (LOGIN)',
      'it bypasses row-level security (BYPASSRLS)',
    ]);
  });

  it('refuses to start in production', async () => {
    await expect(refuseUsableTestAdminAtBoot(pool, 'production')).rejects.toBeInstanceOf(
      UsableTestAdminError,
    );
  });

  it('starts in test, without asking', async () => {
    await expect(refuseUsableTestAdminAtBoot(pool, 'test')).resolves.toBeUndefined();
  });
});

describe('runMigrations refuses the harness database in production', () => {
  it('names the dev password first, and writes nothing', async () => {
    // The harness migrator is on its dev password, so that is the first
    // refusal, before connecting. An empty migrations directory means a
    // run that got past the guard would still apply nothing.
    const dir = mkdtempSync(join(tmpdir(), 'kasuwa-t0117-int-'));
    try {
      await expect(
        runMigrations({
          connectionString: inject('migrationUrl'),
          migrationsDir: dir,
          env: { NODE_ENV: 'production', KASUWA_AUTH_MODE: 'jwt' },
        }),
      ).rejects.toThrow(/development passwords/u);
      await expect(
        runMigrations({
          connectionString: inject('migrationUrl'),
          migrationsDir: dir,
          env: { NODE_ENV: 'test' },
        }),
      ).resolves.toEqual({ applied: [], alreadyApplied: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
