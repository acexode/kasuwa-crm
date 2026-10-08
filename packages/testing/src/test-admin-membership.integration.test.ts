import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  readTestAdminUsability,
  refuseUsableTestAdminAtBoot,
  runMigrations,
  UsableTestAdminError,
} from '@kasuwa/db';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBarePostgres, type BarePostgres } from './bare-postgres';

/**
 * T-0117, lead ruling on managed Postgres: a membership in or of
 * kasuwa_test_admin that is ADMIN-only (admin_option true, inherit_option and
 * set_option false) cannot be used to become the role, so neither the boot
 * check nor the runner refuses it. One with SET or INHERIT, in either
 * direction, is refused.
 *
 * Its own cluster, bootstrapped with bootstrap.sql alone (the real-cell
 * shape, the placeholder inert), because roles are cluster-wide and the shared
 * harness has the live test login. Memberships are made as the superuser,
 * which records the same catalogue rows a CREATEROLE admin's automatic grant
 * does on RDS or Cloud SQL. The boot check reads as kasuwa_app; the runner
 * runs as kasuwa_migrator on a non-dev password, in production.
 */

const BOOTSTRAP_SQL = resolve(__dirname, '..', '..', 'db', 'sql', 'bootstrap.sql');
const MIGRATOR_SECRET = 't0117-membership-not-a-real-pw';
const PRODUCTION = { NODE_ENV: 'production', KASUWA_AUTH_MODE: 'jwt' } as const;

let cluster: BarePostgres;
let emptyMigrations: string;

async function asSuperuser(sql: string): Promise<void> {
  const client = new Client({ connectionString: cluster.superuserUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function bootReasons(): Promise<{ reasons: string[]; boot: unknown }> {
  const client = new Client({ connectionString: cluster.urlFor('kasuwa_app', 'kasuwa_app_dev') });
  await client.connect();
  try {
    const reasons = await readTestAdminUsability(client);
    const boot = await refuseUsableTestAdminAtBoot(client, 'production').then(
      () => 'started',
      (error: unknown) => error,
    );
    return { reasons, boot };
  } finally {
    await client.end();
  }
}

async function migrateInProduction(): Promise<unknown> {
  return runMigrations({
    connectionString: cluster.urlFor('kasuwa_migrator', MIGRATOR_SECRET),
    migrationsDir: emptyMigrations,
    env: PRODUCTION,
  }).then(
    (result) => result,
    (error: unknown) => error,
  );
}

/** Applies `grant`, runs `body`, and always revokes the membership again. */
async function withMembership(grant: string, revoke: string, body: () => Promise<void>) {
  await asSuperuser(grant);
  try {
    await body();
  } finally {
    await asSuperuser(revoke);
  }
}

beforeAll(async () => {
  cluster = await startBarePostgres();
  await asSuperuser(readFileSync(BOOTSTRAP_SQL, 'utf8'));
  await asSuperuser(`ALTER ROLE kasuwa_migrator PASSWORD '${MIGRATOR_SECRET}'`);
  emptyMigrations = mkdtempSync(join(tmpdir(), 'kasuwa-t0117-membership-'));
}, 120_000);

afterAll(async () => {
  rmSync(emptyMigrations, { recursive: true, force: true });
  await cluster?.stop();
});

describe('kasuwa_test_admin memberships: ADMIN-only is ignored, SET or INHERIT is refused', () => {
  it('the inert placeholder starts and migrates in production (control)', async () => {
    expect(await bootReasons()).toEqual({ reasons: [], boot: 'started' });
    expect(await migrateInProduction()).toEqual({ applied: [], alreadyApplied: [] });
  });

  it.each([
    [
      'a member of it (the managed-Postgres admin shape)',
      'GRANT kasuwa_test_admin TO kasuwa_sweeper WITH ADMIN TRUE, INHERIT FALSE, SET FALSE',
      'REVOKE kasuwa_test_admin FROM kasuwa_sweeper',
    ],
    [
      'a member of another role',
      'GRANT kasuwa_sweeper TO kasuwa_test_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE',
      'REVOKE kasuwa_sweeper FROM kasuwa_test_admin',
    ],
  ])('ignores an ADMIN-only membership: %s', async (_what, grant, revoke) => {
    await withMembership(grant, revoke, async () => {
      expect(await bootReasons()).toEqual({ reasons: [], boot: 'started' });
      expect(await migrateInProduction()).toEqual({ applied: [], alreadyApplied: [] });
    });
  });

  it.each([
    [
      'SET into it',
      'GRANT kasuwa_test_admin TO kasuwa_sweeper WITH ADMIN FALSE, INHERIT FALSE, SET TRUE',
      'REVOKE kasuwa_test_admin FROM kasuwa_sweeper',
      /another role is a member of it/u,
    ],
    [
      'INHERIT from it',
      'GRANT kasuwa_test_admin TO kasuwa_sweeper WITH ADMIN TRUE, INHERIT TRUE, SET FALSE',
      'REVOKE kasuwa_test_admin FROM kasuwa_sweeper',
      /another role is a member of it/u,
    ],
    [
      'SET out of it',
      'GRANT kasuwa_sweeper TO kasuwa_test_admin WITH ADMIN FALSE, INHERIT FALSE, SET TRUE',
      'REVOKE kasuwa_sweeper FROM kasuwa_test_admin',
      /member of another role/u,
    ],
    [
      'INHERIT out of it',
      'GRANT kasuwa_sweeper TO kasuwa_test_admin WITH ADMIN FALSE, INHERIT TRUE, SET FALSE',
      'REVOKE kasuwa_sweeper FROM kasuwa_test_admin',
      /member of another role/u,
    ],
  ])('refuses a membership with %s', async (_what, grant, revoke, reason) => {
    await withMembership(grant, revoke, async () => {
      const { reasons, boot } = await bootReasons();
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toMatch(reason);
      expect(boot).toBeInstanceOf(UsableTestAdminError);
      const migrated = await migrateInProduction();
      expect(migrated).toBeInstanceOf(UsableTestAdminError);
      expect((migrated as Error).message).toContain('kasuwa_test_admin');
    });
  });
});
