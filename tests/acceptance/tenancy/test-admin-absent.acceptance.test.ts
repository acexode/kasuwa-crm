import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { EnvSource } from '@kasuwa/config';
import { loadMigrations, runMigrations, TENANT_A, TENANT_B } from '@kasuwa/db';
import { startBarePostgres, type BarePostgres } from '@kasuwa/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * ACCEPTANCE — T-0117, `kasuwa_test_admin` never exists in a real cell
 * (Agent 1, Platform & Security). Decision: D-L92.
 *
 * THE ATTACK THIS CLOSES. `packages/db/sql/bootstrap.sql` is the file real
 * provisioning applies (packages/db/CLAUDE.md, ADR-0013). On main it creates
 * `kasuwa_test_admin`: LOGIN, BYPASSRLS, password `kasuwa_test_admin_dev`, and
 * DML on every future table through default privileges. A real cell built
 * from it has a cross-tenant login whose password is in the repository.
 *
 * TWO DEDICATED CLUSTERS, NOT THE SHARED ONE. Roles are cluster-wide, and the
 * shared harness container has `kasuwa_test_admin` by design, so a fresh
 * database inside it can never show the role's absence. This suite starts its
 * own Postgres 16 clusters with `startBarePostgres` (nothing applied) and
 * chooses the bootstrap files itself:
 *
 *   REAL  = bootstrap.sql alone, then every migration, under a PRODUCTION
 *           configuration. That is exactly what provisioning does to a cell.
 *   HARNESS = bootstrap.sql, then bootstrap-test.sql, then every migration,
 *           under NODE_ENV=test. That is what docker-compose and
 *           packages/testing must do. On main bootstrap-test.sql does not
 *           exist; the setup tolerates that (HARNESS is then bootstrap.sql
 *           alone) so that the failure lands in a test that names it, not in
 *           a beforeAll crash.
 *
 * THE INTERFACE THIS FILE REQUIRES, and nothing else:
 *
 *   I1. `packages/db/sql/bootstrap.sql` keeps its path and stays idempotent.
 *       `packages/db/sql/bootstrap-test.sql` is new, runs as the superuser
 *       AFTER bootstrap.sql and BEFORE migrations, and is idempotent too.
 *   I2. `runMigrations` (from `@kasuwa/db`) accepts one new optional field,
 *       `env?: EnvSource` (the `@kasuwa/config` type): the raw environment the
 *       guard reads, through `@kasuwa/config`, defaulting to `process.env`.
 *       The shape of every existing field and of the result is unchanged. The
 *       guard lives in `runMigrations`, not only in the CLI: every caller of
 *       the runner (db:migrate, db:reset, tenant:provision, the harness) gets
 *       it. Until I2 exists the extra field is ignored at runtime, which is
 *       why section 5's refusals fail on main for the real reason.
 *   I3. A refusal throws (rejects) BEFORE the runner writes anything: no
 *       `_kasuwa_migration` table is created and no file is applied. Its
 *       message names `kasuwa_test_admin` and the configured environment, and
 *       contains no password and no connection string.
 *
 * Everything else is the builder's: how the guard queries the catalogue, the
 * wording beyond I3, how the migrations stop naming the role (guards, a new
 * migration, or something the lead rules on; see the report), and what
 * bootstrap-test.sql looks like inside, as long as the role it creates holds
 * section 4's attributes and grants.
 *
 * RULINGS PINNED HERE (Agent 12, for the lead to confirm):
 *
 *   R1. "Staging" is not an environment name in this codebase: `@kasuwa/config`
 *       knows development, test and production, and a staging cell runs as
 *       production. So the guard's refusal is pinned for NODE_ENV=production,
 *       and for every value that is not development or test (staging, prod,
 *       Production, the empty string) the runner must refuse when the role
 *       exists, for whatever reason. An UNSET NODE_ENV is development to
 *       `@kasuwa/config` (the dev `.env` relies on that) and is deliberately
 *       not pinned either way.
 *   R2. The production configuration used throughout is the smallest one
 *       `@kasuwa/config` accepts in production: NODE_ENV=production and
 *       KASUWA_AUTH_MODE=jwt. Without the second, `migratorEnv` refuses on the
 *       stub-auth guard, and a refusal for THAT reason must not be mistaken
 *       for this guard's (I3 requires the message to name the role).
 *   R3. bootstrap.sql may keep exactly three password literals, each on its
 *       own role: kasuwa_migrator/'kasuwa_migrator_dev',
 *       kasuwa_app/'kasuwa_app_dev', kasuwa_auth/'kasuwa_auth_dev'. Real
 *       provisioning creates those three first with secrets-manager passwords
 *       and `IF NOT EXISTS` leaves them alone (packages/db/CLAUDE.md,
 *       ADR-0013). kasuwa_sweeper is NOLOGIN and has no password, and must not
 *       gain one. Any other PASSWORD clause, including a hashed one or a
 *       second literal for an allowed role, fails section 6.
 *
 * D-L23, observed on main (31 tests: 20 fail, 11 pass). Failing for the real
 * reason (bootstrap.sql creates the role; there is no guard; there is no
 * bootstrap-test.sql): sections 1 and 3 except the idempotence test, all of
 * section 6, section 4's bootstrap-test.sql, re-apply and docker-compose tests,
 * and section 5's six refusals. Passing, legitimately: section 1's idempotence,
 * section 2, section 4's attribute, login, grant, default-privilege and
 * live-harness pins, and section 5's three "runs normally" controls. Those pin
 * behaviour the change must not break, and each refusal in section 5 is paired
 * with a control that must apply, so no refusal can pass because the runner
 * simply fails everywhere.
 *
 * WHAT SECTION 2 WILL DO TO THE BUILDER. On main it passes only because the
 * role exists. With the role gone, 0000_app_session_context is the first of
 * fourteen applied migrations that GRANT or REVOKE to kasuwa_test_admin
 * unguarded, and it fails with `role "kasuwa_test_admin" does not exist`. A
 * new migration cannot fix that, since it would run after them. That is the
 * task's own escalation condition, and the lead's ruling decides how section
 * 2 goes green; this file does not presume the answer.
 */

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const BOOTSTRAP_SQL = resolve(REPO_ROOT, 'packages/db/sql/bootstrap.sql');
const BOOTSTRAP_TEST_SQL = resolve(REPO_ROOT, 'packages/db/sql/bootstrap-test.sql');
const DOCKER_COMPOSE = resolve(REPO_ROOT, 'docker-compose.yml');
const DB_CLAUDE_MD = resolve(REPO_ROOT, 'packages/db/CLAUDE.md');

const TEST_ADMIN = 'kasuwa_test_admin';
const TEST_ADMIN_PASSWORD = 'kasuwa_test_admin_dev';
const MIGRATOR_PASSWORD = 'kasuwa_migrator_dev';

/** The roles a real cell has. PUBLIC is not a role but is an allowed grantee. */
const REAL_ROLES = ['kasuwa_app', 'kasuwa_auth', 'kasuwa_migrator', 'kasuwa_sweeper'] as const;
/** Of those, the ones that may log in. */
const REAL_LOGIN_ROLES = ['kasuwa_app', 'kasuwa_auth', 'kasuwa_migrator'] as const;

/** R2: the smallest environment @kasuwa/config accepts as production. */
const PRODUCTION: EnvSource = { NODE_ENV: 'production', KASUWA_AUTH_MODE: 'jwt' };
const TEST_ENV: EnvSource = { NODE_ENV: 'test' };

/**
 * I2. `runMigrations` with the one new option. Typed this way so the file
 * typechecks on main, where MigrateOptions lacks `env` (a function taking the
 * narrower options is assignable to one taking the wider). Once the builder
 * adds the field, this is the same type. No cast.
 */
type GuardedOptions = Parameters<typeof runMigrations>[0] & { env?: EnvSource };
const runGuarded: (options: GuardedOptions) => ReturnType<typeof runMigrations> = runMigrations;

/**
 * What kasuwa_test_admin holds on main, at head (0028), captured from a
 * database built exactly as the harness builds one. Section 4 requires the
 * HARNESS database to hold AT LEAST this: it is what the integration and
 * acceptance suites that connect as kasuwa_test_admin rely on (catalogue
 * reads, observers, cross-tenant setup). A superset is allowed; losing any of
 * it is not. Objects created after 0028 are not listed, so a future migration
 * does not have to edit this file.
 */
const TEST_ADMIN_GRANTS_ON_MAIN: Readonly<Record<string, string>> = {
  'database|kasuwa': 'CONNECT',
  'schema|app': 'USAGE',
  'schema|public': 'USAGE',
  'function|app.current_programme_ids()': 'EXECUTE',
  'function|app.current_rate_limit_key()': 'EXECUTE',
  'function|app.current_tenant_id()': 'EXECUTE',
  'function|app.current_user_id()': 'EXECUTE',
  'function|app.is_phone_list(jsonb)': 'EXECUTE',
  'function|app.resolve_session(bytea)': 'EXECUTE',
  'function|app.resolve_tenant_by_slug(text)': 'EXECUTE',
  'table|public.account': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.activity': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.admin_alert': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.admin_alert_dismissal': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.audit_event': 'SELECT',
  'table|public.audit_export': 'SELECT',
  'table|public.auth_challenge': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.auth_rate_limit': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.auth_session': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.business_unit': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.contact': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.disposition': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.field_def': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.field_security_grant': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.object_def': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.permission_set': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.portal_user': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.programme': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.programme_retention': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.programme_sla': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.programme_sla_target': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.role': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.tenant': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.user': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.user_credential': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.user_mfa_backup_code': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.user_mfa_factor': 'DELETE,INSERT,SELECT,UPDATE',
  'table|public.user_programme': 'DELETE,INSERT,SELECT,UPDATE',
};

/**
 * Default privileges as `objtype|owner|schema|grantee|privileges`. A real cell
 * gets exactly the kasuwa_app rows (packages/db/CLAUDE.md invariant 9: no
 * default privilege names kasuwa_auth). The harness gets those plus the
 * kasuwa_test_admin rows, exactly as on main.
 */
const REAL_DEFAULT_ACL = [
  'S|kasuwa_migrator|public|kasuwa_app|SELECT,USAGE',
  'f|kasuwa_migrator|public|kasuwa_app|EXECUTE',
  'r|kasuwa_migrator|public|kasuwa_app|DELETE,INSERT,SELECT,UPDATE',
];
const HARNESS_DEFAULT_ACL = [
  ...REAL_DEFAULT_ACL,
  'S|kasuwa_migrator|public|kasuwa_test_admin|SELECT,USAGE',
  'f|kasuwa_migrator|public|kasuwa_test_admin|EXECUTE',
  'r|kasuwa_migrator|public|kasuwa_test_admin|DELETE,INSERT,SELECT,UPDATE',
].sort();

// --- catalogue queries -------------------------------------------------------

/** Every role except the container's superuser and the built-in pg_* roles. */
const ROLES_SQL = `
  SELECT rolname, rolcanlogin, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb,
         rolreplication, rolinherit
    FROM pg_catalog.pg_roles
   WHERE rolname <> 'postgres' AND rolname NOT LIKE 'pg\\_%'
   ORDER BY rolname`;

interface RoleRow {
  rolname: string;
  rolcanlogin: boolean;
  rolbypassrls: boolean;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolinherit: boolean;
}

/**
 * Every privilege recorded anywhere in the database, one row per (object,
 * grantee, privilege): relations, columns, functions, types, schemas, the
 * database itself, default privileges, and role memberships. PUBLIC is
 * grantee 0. An ACL can only name a role that exists, so on a database where
 * the role is absent "nothing names it" is true by construction; the census
 * is therefore always run against HARNESS as well, where it must find the
 * role, so it is shown to be capable of seeing it.
 */
const CENSUS_SQL = `
  WITH acl AS (
    SELECT 'table' AS kind, n.nspname || '.' || c.relname AS object, a.grantee, a.privilege_type
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
    UNION ALL
    SELECT 'column', n.nspname || '.' || c.relname || '.' || att.attname, a.grantee, a.privilege_type
      FROM pg_catalog.pg_attribute att
      JOIN pg_catalog.pg_class c ON c.oid = att.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
    UNION ALL
    SELECT 'function', p.oid::pg_catalog.regprocedure::text, a.grantee, a.privilege_type
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
    UNION ALL
    SELECT 'type', t.oid::pg_catalog.regtype::text, a.grantee, a.privilege_type
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
     CROSS JOIN LATERAL pg_catalog.aclexplode(t.typacl) a
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
    UNION ALL
    SELECT 'schema', n.nspname, a.grantee, a.privilege_type
      FROM pg_catalog.pg_namespace n
     CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
    UNION ALL
    SELECT 'database', d.datname, a.grantee, a.privilege_type
      FROM pg_catalog.pg_database d
     CROSS JOIN LATERAL pg_catalog.aclexplode(d.datacl) a
     WHERE d.datname = pg_catalog.current_database()
    UNION ALL
    SELECT 'default', d.defaclobjtype::text || ' in ' || coalesce(n.nspname, '*'), a.grantee, a.privilege_type
      FROM pg_catalog.pg_default_acl d
      LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
     CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
    UNION ALL
    SELECT 'membership', r.rolname, m.member, 'MEMBER'
      FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
    UNION ALL
    SELECT 'member of', r.rolname, m.roleid, 'MEMBER'
      FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles r ON r.oid = m.member
  )
  SELECT acl.kind, acl.object,
         CASE acl.grantee WHEN 0 THEN 'PUBLIC' ELSE g.rolname END AS grantee,
         acl.privilege_type AS privilege
    FROM acl
    LEFT JOIN pg_catalog.pg_roles g ON g.oid = acl.grantee
   WHERE acl.grantee = 0 OR (g.rolname <> 'postgres' AND g.rolname NOT LIKE 'pg\\_%')
   ORDER BY 1, 2, 3, 4`;

interface CensusRow {
  kind: string;
  object: string;
  grantee: string;
  privilege: string;
}

const DEFAULT_ACL_SQL = `
  SELECT acl.line FROM (
    SELECT d.defaclobjtype::text || '|' || o.rolname || '|' || coalesce(n.nspname, '*') || '|' ||
           CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE g.rolname END || '|' ||
           pg_catalog.string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS line
      FROM pg_catalog.pg_default_acl d
      JOIN pg_catalog.pg_roles o ON o.oid = d.defaclrole
      LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
     CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
      LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
     GROUP BY d.defaclobjtype, o.rolname, n.nspname, a.grantee, g.rolname
  ) AS acl
  -- Byte order, to match the JavaScript sort of the expected lists: the
  -- image's default collation is not something to depend on.
  ORDER BY acl.line COLLATE "C"`;

// --- helpers -------------------------------------------------------------------

async function query<Row extends Record<string, unknown>>(
  url: string,
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<Row>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

async function applyFile(superuserUrl: string, path: string): Promise<void> {
  await query(superuserUrl, readFileSync(path, 'utf8'));
}

async function roleNamed(url: string, name: string): Promise<RoleRow | undefined> {
  const rows = await query<RoleRow & Record<string, unknown>>(url, ROLES_SQL);
  return rows.find((row) => row.rolname === name);
}

async function census(url: string): Promise<CensusRow[]> {
  return query<CensusRow & Record<string, unknown>>(url, CENSUS_SQL);
}

/** `kind|object` -> sorted, comma-joined privileges, for one grantee. */
function grantsOf(rows: readonly CensusRow[], grantee: string): Map<string, string> {
  const byObject = new Map<string, string[]>();
  for (const row of rows) {
    if (row.grantee !== grantee) {
      continue;
    }
    const key = `${row.kind}|${row.object}`;
    byObject.set(key, [...(byObject.get(key) ?? []), row.privilege]);
  }
  return new Map([...byObject].map(([key, privileges]) => [key, [...privileges].sort().join(',')]));
}

function withSearchPath(url: string, schema: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

type Outcome = { ok: true; applied: string[] } | { ok: false; message: string };

interface ScratchRun {
  outcome: Outcome;
  /** Every relation the run left in its scratch schema. */
  relations: string[];
}

/**
 * Runs the guarded runner against a throwaway migrations directory holding
 * one file, with `search_path` pinned to a throwaway schema, exactly as the
 * T-0044 runner suite does. The runner creates `_kasuwa_migration`
 * unqualified, so anything it writes lands in the scratch schema, where
 * `relations` can see it, and the real schema is never touched.
 */
async function scratchRun(migratorUrl: string, env: EnvSource): Promise<ScratchRun> {
  const schema = `t0117_${randomBytes(6).toString('hex')}`;
  const dir = mkdtempSync(join(tmpdir(), 'kasuwa-t0117-'));
  writeFileSync(
    join(dir, '0001_t0117_probe.sql'),
    'CREATE TABLE t0117_probe (id integer PRIMARY KEY);\n',
    'utf8',
  );
  await query(migratorUrl, `CREATE SCHEMA ${schema}`);
  try {
    let outcome: Outcome;
    try {
      const result = await runGuarded({
        connectionString: withSearchPath(migratorUrl, schema),
        migrationsDir: dir,
        env,
      });
      outcome = { ok: true, applied: result.applied };
    } catch (error) {
      outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    const relations = await query<{ relname: string }>(
      migratorUrl,
      `SELECT c.relname FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 ORDER BY 1`,
      [schema],
    );
    return { outcome, relations: relations.map((row) => row.relname) };
  } finally {
    await query(migratorUrl, `DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** I3: no password and no connection string in a refusal. */
function expectNoSecret(message: string, migratorUrl: string): void {
  expect(message).not.toContain(MIGRATOR_PASSWORD);
  expect(message).not.toContain(TEST_ADMIN_PASSWORD);
  expect(message).not.toContain(migratorUrl);
  expect(message).not.toMatch(/postgres(?:ql)?:\/\//u);
}

/**
 * SQL with comments removed and string literals kept, so that a role named in
 * a comment ("kasuwa_test_admin now lives in bootstrap-test.sql") is not
 * mistaken for one created by code. Dollar-quoted bodies (DO $$ ... $$) are
 * kept as code, which is right: the CREATE ROLE statements live inside one.
 */
function stripSqlComments(sql: string): string {
  let out = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "'" || char === '"') {
      const end = sql.indexOf(char, index + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(index, stop);
      index = stop;
    } else if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end;
    } else if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

// --- the two clusters --------------------------------------------------------

let real: BarePostgres;
let harness: BarePostgres;
let realMigrator: string;
let harnessMigrator: string;
let harnessHasTestBootstrap = false;
let harnessMigrateError: Error | undefined;
/** Set by section 2. Sections 3 and 5 refuse to read a half-migrated REAL. */
let realMigrated = false;

beforeAll(async () => {
  [real, harness] = await Promise.all([startBarePostgres(), startBarePostgres()]);
  realMigrator = real.urlFor('kasuwa_migrator', MIGRATOR_PASSWORD);
  harnessMigrator = harness.urlFor('kasuwa_migrator', MIGRATOR_PASSWORD);

  // REAL: bootstrap.sql alone. Migrated in section 2, as a test, so that a
  // migration that cannot run without the role fails THERE, by name.
  await applyFile(real.superuserUrl, BOOTSTRAP_SQL);

  // HARNESS: both files, in the order docker-compose and packages/testing
  // must apply them, then every migration.
  await applyFile(harness.superuserUrl, BOOTSTRAP_SQL);
  harnessHasTestBootstrap = existsSync(BOOTSTRAP_TEST_SQL);
  if (harnessHasTestBootstrap) {
    await applyFile(harness.superuserUrl, BOOTSTRAP_TEST_SQL);
  }
  try {
    await runGuarded({ connectionString: harnessMigrator, env: TEST_ENV });
  } catch (error) {
    harnessMigrateError = error instanceof Error ? error : new Error(String(error));
  }
}, 240_000);

afterAll(async () => {
  await Promise.all([real?.stop(), harness?.stop()]);
});

function requireRealMigrated(): void {
  expect(realMigrated, 'section 2 did not migrate REAL to head; see its failure').toBe(true);
}

function requireHarnessMigrated(): void {
  expect(harnessMigrateError?.message, 'HARNESS did not migrate to head').toBeUndefined();
}

// =============================================================================

describe('1. a database bootstrapped with bootstrap.sql alone', () => {
  it('has no kasuwa_test_admin role', async () => {
    const role = await roleNamed(real.superuserUrl, TEST_ADMIN);
    expect(role, 'bootstrap.sql created kasuwa_test_admin, a BYPASSRLS test login').toBeUndefined();
  });

  it('gives BYPASSRLS to no role but kasuwa_migrator', async () => {
    const roles = await query<RoleRow & Record<string, unknown>>(real.superuserUrl, ROLES_SQL);
    expect(roles.filter((row) => row.rolbypassrls).map((row) => row.rolname)).toEqual([
      'kasuwa_migrator',
    ]);
  });

  it('creates exactly the four real roles, and only app, auth and migrator can log in', async () => {
    const roles = await query<RoleRow & Record<string, unknown>>(real.superuserUrl, ROLES_SQL);
    expect(roles.map((row) => row.rolname)).toEqual([...REAL_ROLES]);
    expect(roles.filter((row) => row.rolcanlogin).map((row) => row.rolname)).toEqual([
      ...REAL_LOGIN_ROLES,
    ]);
    // No real role is a superuser or can make roles. In PostgreSQL 16 a
    // CREATEROLE role may create a BYPASSRLS login if it holds BYPASSRLS
    // itself, which the migrator does: CREATEROLE on it would be a way back.
    expect(roles.filter((row) => row.rolsuper || row.rolcreaterole)).toEqual([]);
  });

  it('is idempotent: applying it again changes nothing', async () => {
    const before = await census(real.superuserUrl);
    await applyFile(real.superuserUrl, BOOTSTRAP_SQL);
    expect(await census(real.superuserUrl)).toEqual(before);
  });
});

describe('2. that database migrates to head under a production configuration', () => {
  it('applies every migration in packages/db/migrations, in order', async () => {
    // What provisioning does to a real cell: bootstrap.sql, then the runner,
    // in production. The guard must not stop this, and no migration may need
    // the test role. (On main this passes: bootstrap.sql still creates it.)
    const expected = loadMigrations().map((migration) => migration.id);
    expect(expected.length, 'no migrations found; this test would prove nothing').toBeGreaterThan(
      0,
    );
    const result = await runGuarded({ connectionString: realMigrator, env: PRODUCTION });
    expect(result.applied).toEqual(expected);
    expect(result.alreadyApplied).toEqual([]);
    realMigrated = true;
  }, 180_000);

  it('a second run in production applies nothing and refuses nothing', async () => {
    requireRealMigrated();
    const expected = loadMigrations().map((migration) => migration.id);
    const result = await runGuarded({ connectionString: realMigrator, env: PRODUCTION });
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toEqual(expected);
  }, 60_000);
});

describe('3. after migrating, nothing in the real database names kasuwa_test_admin', () => {
  it('still has no kasuwa_test_admin, and still no BYPASSRLS role but the migrator', async () => {
    requireRealMigrated();
    expect(await roleNamed(real.superuserUrl, TEST_ADMIN)).toBeUndefined();
    const roles = await query<RoleRow & Record<string, unknown>>(real.superuserUrl, ROLES_SQL);
    expect(roles.map((row) => row.rolname)).toEqual([...REAL_ROLES]);
    expect(roles.filter((row) => row.rolbypassrls).map((row) => row.rolname)).toEqual([
      'kasuwa_migrator',
    ]);
  });

  it('no grant, default privilege or membership names kasuwa_test_admin', async () => {
    requireRealMigrated();
    // Control first: the census sees the role where it exists. Without this,
    // the REAL assertion below is true by construction (an ACL can only name
    // a role that exists) and would prove nothing.
    requireHarnessMigrated();
    const harnessRows = await census(harness.superuserUrl);
    expect(
      harnessRows.filter((row) => row.grantee === TEST_ADMIN).length,
      'the census cannot see kasuwa_test_admin grants even in HARNESS',
    ).toBeGreaterThan(0);

    const realRows = await census(real.superuserUrl);
    expect(realRows.filter((row) => row.grantee === TEST_ADMIN)).toEqual([]);
  });

  it('every grantee of every privilege is a real role or PUBLIC', async () => {
    // The non-vacuous form of the test above: an allow-list of grantees
    // catches the test role, a renamed copy of it, or any role nobody chose.
    requireRealMigrated();
    const allowed = new Set<string>(['PUBLIC', ...REAL_ROLES]);
    const strangers = (await census(real.superuserUrl)).filter((row) => !allowed.has(row.grantee));
    expect(strangers).toEqual([]);
  });

  it('default privileges name kasuwa_app alone', async () => {
    requireRealMigrated();
    const lines = (await query<{ line: string }>(real.superuserUrl, DEFAULT_ACL_SQL)).map(
      (row) => row.line,
    );
    expect(lines).toEqual(REAL_DEFAULT_ACL);
  });
});

describe('4. with bootstrap.sql then bootstrap-test.sql, the harness behaves as today', () => {
  it('bootstrap-test.sql exists and is what creates kasuwa_test_admin', () => {
    expect(harnessHasTestBootstrap, 'packages/db/sql/bootstrap-test.sql does not exist').toBe(true);
    const code = stripSqlComments(readFileSync(BOOTSTRAP_TEST_SQL, 'utf8'));
    expect(code).toMatch(/\bCREATE\s+ROLE\s+"?kasuwa_test_admin"?/iu);
  });

  it('kasuwa_test_admin has exactly its attributes on main, and no memberships', async () => {
    const role = await roleNamed(harness.superuserUrl, TEST_ADMIN);
    expect(role).toEqual({
      rolname: TEST_ADMIN,
      rolcanlogin: true,
      rolbypassrls: true,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolinherit: true,
    });
    const memberships = (await census(harness.superuserUrl)).filter(
      (row) =>
        row.kind.startsWith('member') && (row.grantee === TEST_ADMIN || row.object === TEST_ADMIN),
    );
    expect(memberships).toEqual([]);
  });

  it('logs in with its development password, as the harness does', async () => {
    const rows = await query<{ who: string }>(
      harness.urlFor(TEST_ADMIN, TEST_ADMIN_PASSWORD),
      'SELECT current_user::text AS who',
    );
    expect(rows).toEqual([{ who: TEST_ADMIN }]);
  });

  it('holds every grant it held on main (a superset is allowed)', async () => {
    requireHarnessMigrated();
    const held = grantsOf(await census(harness.superuserUrl), TEST_ADMIN);
    const missing = Object.entries(TEST_ADMIN_GRANTS_ON_MAIN).flatMap(([object, privileges]) => {
      const have = new Set((held.get(object) ?? '').split(',').filter(Boolean));
      const lacking = privileges.split(',').filter((privilege) => !have.has(privilege));
      return lacking.length === 0 ? [] : [`${object}: ${lacking.join(',')}`];
    });
    expect(missing).toEqual([]);
  });

  it('default privileges are exactly those on main: kasuwa_app and kasuwa_test_admin', async () => {
    requireHarnessMigrated();
    const lines = (await query<{ line: string }>(harness.superuserUrl, DEFAULT_ACL_SQL)).map(
      (row) => row.line,
    );
    expect(lines).toEqual(HARNESS_DEFAULT_ACL);
  });

  it('re-applying both files after migrating (pnpm dev) fails nothing and changes nothing', async () => {
    requireHarnessMigrated();
    expect(harnessHasTestBootstrap, 'packages/db/sql/bootstrap-test.sql does not exist').toBe(true);
    const before = await census(harness.superuserUrl);
    await applyFile(harness.superuserUrl, BOOTSTRAP_SQL);
    await applyFile(harness.superuserUrl, BOOTSTRAP_TEST_SQL);
    expect(await census(harness.superuserUrl)).toEqual(before);
  });

  it('the shared harness still hands every suite a working BYPASSRLS kasuwa_test_admin', async () => {
    // The live global setup, not a copy of it: if packages/testing stops
    // applying bootstrap-test.sql this login fails, and every suite that
    // injects testAdminUrl fails with it.
    const rows = await query<{ who: string; bypass: boolean; tenants: string }>(
      inject('testAdminUrl'),
      `SELECT current_user::text AS who,
              (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user) AS bypass,
              (SELECT count(DISTINCT tenant_id) FROM contact WHERE tenant_id IN ($1, $2))::text AS tenants`,
      [TENANT_A, TENANT_B],
    );
    expect(rows).toEqual([{ who: TEST_ADMIN, bypass: true, tenants: '2' }]);
  });

  it('docker-compose mounts both files into the init directory, bootstrap.sql first', () => {
    const compose = parseYaml(readFileSync(DOCKER_COMPOSE, 'utf8')) as {
      services?: { postgres?: { volumes?: unknown[] } };
    };
    const mounts = new Map<string, string>();
    for (const volume of compose.services?.postgres?.volumes ?? []) {
      const match =
        typeof volume === 'string'
          ? /^\.\/packages\/db\/sql\/(bootstrap(?:-test)?\.sql):\/docker-entrypoint-initdb\.d\/([^:]+)(?::ro)?$/u.exec(
              volume,
            )
          : null;
      if (match?.[1] !== undefined && match[2] !== undefined) {
        mounts.set(match[1], match[2]);
      }
    }
    const main = mounts.get('bootstrap.sql');
    const test = mounts.get('bootstrap-test.sql');
    expect(main, 'bootstrap.sql is not mounted in the init directory').toBeDefined();
    expect(test, 'bootstrap-test.sql is not mounted in the init directory').toBeDefined();
    // The entrypoint runs the directory in name order; the test file needs
    // the roles and the database grants bootstrap.sql makes.
    expect([main, test].sort()).toEqual([main, test]);
  });
});

describe('5. the runner refuses a non-dev, non-test database that has kasuwa_test_admin', () => {
  it('refuses in production, before writing anything, saying why and leaking nothing', async () => {
    requireHarnessMigrated();
    const { outcome, relations } = await scratchRun(harnessMigrator, PRODUCTION);
    expect(outcome.ok, 'the runner migrated a production database that has the test role').toBe(
      false,
    );
    if (!outcome.ok) {
      expect(outcome.message).toContain(TEST_ADMIN);
      expect(outcome.message).toContain('production');
      expectNoSecret(outcome.message, harnessMigrator);
    }
    // I3: refused BEFORE anything, the bookkeeping table included.
    expect(relations).toEqual([]);
  });

  it.each(['staging', 'prod', 'Production', ''])(
    'refuses with NODE_ENV=%j too, and writes nothing (R1)',
    async (nodeEnv) => {
      requireHarnessMigrated();
      const { outcome, relations } = await scratchRun(harnessMigrator, {
        ...PRODUCTION,
        NODE_ENV: nodeEnv,
      });
      expect(outcome.ok, `the runner migrated with NODE_ENV=${JSON.stringify(nodeEnv)}`).toBe(
        false,
      );
      if (!outcome.ok) {
        expectNoSecret(outcome.message, harnessMigrator);
      }
      expect(relations).toEqual([]);
    },
  );

  it.each([
    ['development', { NODE_ENV: 'development' }],
    ['test', TEST_ENV],
  ] as const)('runs normally in %s when the role exists (control)', async (_name, env) => {
    requireHarnessMigrated();
    const { outcome, relations } = await scratchRun(harnessMigrator, env);
    expect(outcome).toEqual({ ok: true, applied: ['0001_t0117_probe'] });
    expect(relations).toContain('t0117_probe');
  });

  it('runs normally in production when the role is absent (control)', async () => {
    // Without this, a runner that refused production outright would pass the
    // refusal above. Also covered at full scale by section 2.
    requireRealMigrated();
    const { outcome, relations } = await scratchRun(realMigrator, PRODUCTION);
    expect(outcome).toEqual({ ok: true, applied: ['0001_t0117_probe'] });
    expect(relations).toContain('t0117_probe');
  });

  it('keys on existence: a NOLOGIN, NOBYPASSRLS kasuwa_test_admin is refused as well', async () => {
    // A guard that checked "can it log in" would wave through a role that is
    // one ALTER ROLE away from being the test login again, still holding its
    // grants. The contract is existence (T-0117).
    requireRealMigrated();
    const existed = (await roleNamed(real.superuserUrl, TEST_ADMIN)) !== undefined;
    if (!existed) {
      await query(real.superuserUrl, `CREATE ROLE ${TEST_ADMIN} NOLOGIN NOBYPASSRLS`);
    }
    try {
      const { outcome, relations } = await scratchRun(realMigrator, PRODUCTION);
      expect(outcome.ok, 'the runner migrated a production database that has the test role').toBe(
        false,
      );
      if (!outcome.ok) {
        expect(outcome.message).toContain(TEST_ADMIN);
      }
      expect(relations).toEqual([]);
    } finally {
      if (!existed) {
        await query(real.superuserUrl, `DROP ROLE ${TEST_ADMIN}`);
      }
    }
  });
});

describe('6. bootstrap.sql carries no password but the three documented dev ones (R3)', () => {
  const raw = readFileSync(BOOTSTRAP_SQL, 'utf8');
  const code = stripSqlComments(raw);

  it("never contains the test role's password, even in a comment", () => {
    expect(raw).not.toContain(TEST_ADMIN_PASSWORD);
  });

  it('names kasuwa_test_admin nowhere but in comments', () => {
    // Catches a conditional CREATE ROLE (IF some_setting = 'test' THEN ...)
    // that section 1 would miss, since it would not fire in the container.
    expect(code).not.toMatch(/kasuwa_test_admin/iu);
    expect(code).not.toMatch(/bootstrap-test/iu);
    // psql meta-commands (\i, \ir, \include) would pull another file in when
    // docker-compose or tools/dev.mjs runs this through psql.
    expect(raw.split(/\r?\n/u).filter((line) => /^\s*\\/u.test(line))).toEqual([]);
  });

  it('every PASSWORD clause is one of the three pinned role/literal pairs, once each', () => {
    const keywords = code.match(/\bPASSWORD\b/giu) ?? [];
    const pairs = [
      ...code.matchAll(
        /\b(?:CREATE|ALTER)\s+(?:ROLE|USER)\s+"?([a-z_][a-z0-9_]*)"?[^;]*?\bPASSWORD\s+('(?:[^']|'')*'|[^\s;]+)/giu,
      ),
    ].map((match) => `${match[1] ?? '?'}=${match[2] ?? '?'}`);
    // Every PASSWORD keyword has to be one the pattern understood; one it did
    // not (a hashed literal, \password, a role set some other way) fails here
    // rather than slipping past the allow-list.
    expect(pairs.length, `PASSWORD clauses not understood: ${keywords.length}`).toBe(
      keywords.length,
    );
    expect(pairs.sort()).toEqual([
      "kasuwa_app='kasuwa_app_dev'",
      "kasuwa_auth='kasuwa_auth_dev'",
      "kasuwa_migrator='kasuwa_migrator_dev'",
    ]);
  });

  it('the header and packages/db/CLAUDE.md say which file real provisioning applies', () => {
    const header = raw.slice(0, raw.search(/^\s*(?:DO|CREATE|ALTER|GRANT|REVOKE)\b/mu));
    expect(header).toMatch(/bootstrap-test\.sql/u);
    expect(readFileSync(DB_CLAUDE_MD, 'utf8')).toMatch(/bootstrap-test\.sql/u);
  });
});
