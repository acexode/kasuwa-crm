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
 * T-0117, memberships of kasuwa_test_admin (lead ruling, revised by the
 * security review, M1). Every membership in either direction is refused,
 * except one IN the role that carries neither SET nor INHERIT (ADMIN-only)
 * and is held by a SUPERUSER or CREATEROLE role: the managed-Postgres
 * provisioning admin, which could make the role usable anyway. ADMIN-only held
 * by anyone else is refused, because ADMIN OPTION lets the holder grant the
 * role to itself with SET and then SET ROLE; one test below does exactly that.
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

/** Every membership in or of kasuwa_test_admin, as `role<-member`. */
async function testAdminMemberships(): Promise<string[]> {
  const client = new Client({ connectionString: cluster.superuserUrl });
  await client.connect();
  try {
    const rows = await client.query<{ line: string }>(
      `SELECT r.rolname || '<-' || m.rolname AS line
         FROM pg_catalog.pg_auth_members am
         JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
         JOIN pg_catalog.pg_roles m ON m.oid = am.member
        WHERE r.rolname = 'kasuwa_test_admin' OR m.rolname = 'kasuwa_test_admin'
        ORDER BY 1`,
    );
    return rows.rows.map((row) => row.line);
  } finally {
    await client.end();
  }
}

async function expectRefused(reason: RegExp): Promise<void> {
  const { reasons, boot } = await bootReasons();
  expect(reasons).toHaveLength(1);
  expect(reasons[0]).toMatch(reason);
  expect(boot).toBeInstanceOf(UsableTestAdminError);
  const migrated = await migrateInProduction();
  expect(migrated).toBeInstanceOf(UsableTestAdminError);
  expect((migrated as Error).message).toContain('kasuwa_test_admin');
}

async function expectIgnored(): Promise<void> {
  expect(await bootReasons()).toEqual({ reasons: [], boot: 'started' });
  expect(await migrateInProduction()).toEqual({ applied: [], alreadyApplied: [] });
}

describe('kasuwa_test_admin memberships (T-0117 review M1)', () => {
  it('the inert placeholder starts and migrates in production (control)', async () => {
    expect(await testAdminMemberships()).toEqual([]);
    await expectIgnored();
  });

  it('ignores ADMIN-only held by a CREATEROLE role (the managed-Postgres admin)', async () => {
    await asSuperuser('CREATE ROLE t0117_provisioner NOLOGIN CREATEROLE');
    try {
      await withMembership(
        'GRANT kasuwa_test_admin TO t0117_provisioner WITH ADMIN TRUE, INHERIT FALSE, SET FALSE',
        'REVOKE kasuwa_test_admin FROM t0117_provisioner',
        expectIgnored,
      );
    } finally {
      await asSuperuser('DROP ROLE t0117_provisioner');
    }
  });

  it('refuses ADMIN-only held by a CREATEROLE role that kasuwa_app can enter', async () => {
    // Re-review round 2: kasuwa_app could SET ROLE to the admin and use its
    // ADMIN OPTION. The exemption needs the holder unreachable by the checker.
    await asSuperuser('CREATE ROLE t_admin NOLOGIN CREATEROLE');
    await asSuperuser('GRANT t_admin TO kasuwa_app WITH INHERIT FALSE, SET TRUE');
    try {
      await withMembership(
        'GRANT kasuwa_test_admin TO t_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE',
        'REVOKE kasuwa_test_admin FROM t_admin',
        async () => {
          // The boot check runs as kasuwa_app, which reaches t_admin: refused.
          const { reasons, boot } = await bootReasons();
          expect(reasons).toHaveLength(1);
          expect(reasons[0]).toMatch(/another role is a member of it/u);
          expect(boot).toBeInstanceOf(UsableTestAdminError);
        },
      );
    } finally {
      await asSuperuser('REVOKE t_admin FROM kasuwa_app');
      await asSuperuser('DROP ROLE t_admin');
    }
  });

  it('refuses ADMIN-only held by kasuwa_app, which could otherwise SET ROLE to it', async () => {
    await withMembership(
      'GRANT kasuwa_test_admin TO kasuwa_app WITH ADMIN TRUE, INHERIT FALSE, SET FALSE',
      'REVOKE kasuwa_test_admin FROM kasuwa_app CASCADE',
      async () => {
        await expectRefused(/another role is a member of it/u);

        // Why: ADMIN OPTION lets kasuwa_app grant the role to itself with SET.
        const app = new Client({
          connectionString: cluster.urlFor('kasuwa_app', 'kasuwa_app_dev'),
        });
        await app.connect();
        try {
          await app.query('GRANT kasuwa_test_admin TO kasuwa_app WITH SET TRUE');
          await app.query('SET ROLE kasuwa_test_admin');
          const who = await app.query<{ who: string }>('SELECT current_user::text AS who');
          expect(who.rows).toEqual([{ who: 'kasuwa_test_admin' }]);
        } finally {
          await app.end();
        }
      },
    );
    expect(await testAdminMemberships(), 'the CASCADE revoke left a membership').toEqual([]);
  });

  it.each([
    [
      'ADMIN-only held by a NOLOGIN role without CREATEROLE',
      'GRANT kasuwa_test_admin TO kasuwa_sweeper WITH ADMIN TRUE, INHERIT FALSE, SET FALSE',
      'REVOKE kasuwa_test_admin FROM kasuwa_sweeper',
      /another role is a member of it/u,
    ],
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
      'ADMIN-only out of it',
      'GRANT kasuwa_sweeper TO kasuwa_test_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE',
      'REVOKE kasuwa_sweeper FROM kasuwa_test_admin',
      /member of another role/u,
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
  ])('refuses %s', async (_what, grant, revoke, reason) => {
    await withMembership(grant, revoke, () => expectRefused(reason));
  });
});
