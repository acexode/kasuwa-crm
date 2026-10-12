import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { apiEnv, workerEnv, type EnvSource } from '@kasuwa/config';
import { loadMigrations, runMigrations, TENANT_A, TENANT_B } from '@kasuwa/db';
import { startBarePostgres, type BarePostgres } from '@kasuwa/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * ACCEPTANCE — T-0117, no usable `kasuwa_test_admin` in a real cell
 * (Agent 1, Platform & Security). Decisions: D-L92 as amended by D-L94.
 *
 * (The file name predates D-L94. Under D-L94 the role is not absent from a
 * real cell; it is an inert placeholder. The name is kept because the task
 * file names it.)
 *
 * THE ATTACK THIS CLOSES. `packages/db/sql/bootstrap.sql` is the file real
 * provisioning applies (packages/db/CLAUDE.md, ADR-0013). On main it creates
 * `kasuwa_test_admin`: LOGIN, BYPASSRLS, password `kasuwa_test_admin_dev`, and
 * DML on every table. A real cell built from it has a cross-tenant login whose
 * password is in the repository.
 *
 * THE MODEL (D-L94). Fourteen applied migrations GRANT or REVOKE to the role
 * by name, so it has to exist wherever they run, and applied migrations are
 * never edited. Therefore:
 *
 *   - bootstrap.sql creates it as an INERT PLACEHOLDER: NOLOGIN, NOBYPASSRLS,
 *     NOINHERIT, no password, a member of nothing, with no members. It holds
 *     what the migrations grant it, and nobody can use that. If the role
 *     already exists (an old dev volume, or a harness), bootstrap.sql leaves
 *     it alone.
 *   - bootstrap-test.sql (docker-compose and packages/testing only) makes it
 *     the test login: LOGIN, BYPASSRLS, PASSWORD 'kasuwa_test_admin_dev'.
 *   - The runner refuses, outside development and test, a database where the
 *     role is usable; refuses an unset NODE_ENV against a non-local host; and
 *     refuses the repository's dev passwords outside development and test.
 *     The API refuses the dev passwords at startup through @kasuwa/config.
 *
 * TWO DEDICATED CLUSTERS, NOT THE SHARED ONE. Roles are cluster-wide, and the
 * shared harness container has the live test role by design. This suite starts
 * its own Postgres 16 clusters with `startBarePostgres` (nothing applied):
 *
 *   REAL    = bootstrap.sql alone; kasuwa_migrator's password then replaced by
 *             a random one (what provisioning does with the secrets manager);
 *             every migration under a PRODUCTION configuration.
 *   HARNESS = bootstrap.sql, then bootstrap-test.sql, then every migration
 *             under NODE_ENV=test with the dev password, exactly as the
 *             harness does; the migrator's password is then replaced by a
 *             random one so that section 5's production refusals can only be
 *             about the role, never about a dev password. On main
 *             bootstrap-test.sql does not exist; the setup tolerates that so
 *             the failure lands in a test that names it.
 *
 * THE INTERFACE THIS FILE REQUIRES, and nothing else:
 *
 *   I1. `packages/db/sql/bootstrap.sql` keeps its path and stays idempotent.
 *       `packages/db/sql/bootstrap-test.sql` is new, runs as the superuser
 *       AFTER bootstrap.sql and BEFORE migrations, and is idempotent.
 *   I2. `runMigrations` (from `@kasuwa/db`) accepts one new optional field,
 *       `env?: EnvSource`: the raw environment the guards read, through
 *       `@kasuwa/config`, defaulting to `process.env`. Existing fields and the
 *       result are unchanged. The guards live in `runMigrations`, so every
 *       caller (db:migrate, db:reset, tenant:provision, the harness) gets them.
 *   I3. A refusal throws (rejects) BEFORE the runner writes anything: no
 *       `_kasuwa_migration` table, no file applied. The message contains no
 *       password and no connection string. A role refusal names
 *       `kasuwa_test_admin`; an unset-NODE_ENV refusal names `NODE_ENV`; a
 *       dev-password refusal says `password`.
 *   I4. The host and password the guards judge are the ones `pg` will use.
 *       `pg` parses a connection string with `pg-connection-string`, where a
 *       `?host=` or `?password=` query parameter OVERRIDES the URL's own, and
 *       the password is percent-decoded. A guard reading `new URL(u).hostname`
 *       or `.password` is fooled by all three; section 5 tries each.
 *   I5. `apiEnv` (from `@kasuwa/config`) throws, outside development and test,
 *       when DATABASE_URL or DATABASE_AUTH_URL carries one of the four dev
 *       passwords, by the same parsing as I4. The message names the variable
 *       and echoes neither the URL nor the password.
 *
 * Everything else is the builder's: how the guards query the catalogue, the
 * wording beyond I3, and what bootstrap-test.sql looks like inside, as long
 * as the role it produces has section 4's attributes and grants.
 *
 * RULINGS (R1-R3 accepted by the lead; R4-R5 are Agent 12's, for review):
 *
 *   R1. "Staging" is not an environment name here: @kasuwa/config knows
 *       development, test and production. Every NODE_ENV value that is SET and
 *       is not development or test (staging, prod, Production, and the empty
 *       string, which config's enum rejects rather than defaulting) must
 *       refuse when the role is usable.
 *   R2. The runner's production configuration is NODE_ENV=production plus
 *       KASUWA_AUTH_MODE=jwt: without the second, migratorEnv refuses on the
 *       stub-auth guard first, which would look like a pass. The API's adds
 *       the KMS provider and proxy hops its own boot guards require.
 *   R3. bootstrap.sql keeps exactly three password literals:
 *       kasuwa_migrator/'kasuwa_migrator_dev', kasuwa_app/'kasuwa_app_dev',
 *       kasuwa_auth/'kasuwa_auth_dev'. The sweeper and the placeholder have
 *       none.
 *   R4. "Usable" is what the migrator can SEE: rolcanlogin, rolbypassrls, and
 *       membership in either direction. A password on a NOLOGIN role is not
 *       visible to it (pg_roles.rolpassword always reads '********';
 *       pg_authid is superuser-only), so the runner is not required to refuse
 *       on a password alone. This suite checks the placeholder's password as
 *       the superuser instead (sections 1 and 3).
 *   R5. "Local" is exactly the lead's list: localhost, 127.0.0.1, ::1 and
 *       names ending in `.localhost`. Other 127/8 addresses count as
 *       non-local. Only localhost and 127.0.0.1 are exercised as controls:
 *       ::1 and *.localhost do not reliably reach Docker Desktop on Windows.
 *
 * D-L23, observed on main: see the commit message for the exact split. Every
 * failure is an assertion about the real reason (bootstrap.sql makes the role
 * a live login; there is no guard; there is no bootstrap-test.sql). Every
 * passing test is a pin of behaviour the change must not break or a control
 * paired with a refusal, so no refusal can pass because the runner or the
 * config simply fails everywhere.
 */

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const BOOTSTRAP_SQL = resolve(REPO_ROOT, 'packages/db/sql/bootstrap.sql');
const BOOTSTRAP_TEST_SQL = resolve(REPO_ROOT, 'packages/db/sql/bootstrap-test.sql');
const DOCKER_COMPOSE = resolve(REPO_ROOT, 'docker-compose.yml');
const DB_CLAUDE_MD = resolve(REPO_ROOT, 'packages/db/CLAUDE.md');

const TEST_ADMIN = 'kasuwa_test_admin';
const TEST_ADMIN_PASSWORD = 'kasuwa_test_admin_dev';
const MIGRATOR_PASSWORD = 'kasuwa_migrator_dev';
const APP_PASSWORD = 'kasuwa_app_dev';
const AUTH_PASSWORD = 'kasuwa_auth_dev';
/** The repository's dev password literals (D-L94). */
const DEV_PASSWORDS = [MIGRATOR_PASSWORD, APP_PASSWORD, AUTH_PASSWORD, TEST_ADMIN_PASSWORD];

/** Stand-ins for secrets-manager passwords. Hex, so no URL encoding is needed. */
const REAL_SECRET = `t0117-${randomBytes(12).toString('hex')}`;
const HARNESS_SECRET = `t0117-${randomBytes(12).toString('hex')}`;

/** Every role a real cell has, the placeholder included. */
const REAL_ROLES = [
  'kasuwa_app',
  'kasuwa_auth',
  'kasuwa_migrator',
  'kasuwa_sweeper',
  'kasuwa_test_admin',
] as const;
/** Of those, the ones that may log in. */
const REAL_LOGIN_ROLES = ['kasuwa_app', 'kasuwa_auth', 'kasuwa_migrator'] as const;

/** R2. */
const PRODUCTION: EnvSource = { NODE_ENV: 'production', KASUWA_AUTH_MODE: 'jwt' };
const TEST_ENV: EnvSource = { NODE_ENV: 'test' };
const DEVELOPMENT: EnvSource = { NODE_ENV: 'development' };
/** No NODE_ENV at all: what the dev `.env` gives a local `pnpm db:migrate`. */
const UNSET: EnvSource = {};

/** R2: the API's own boot guards also need a KMS provider and proxy hops. */
const API_PRODUCTION: EnvSource = {
  ...PRODUCTION,
  KASUWA_KMS_PROVIDER: 'aws-kms',
  KASUWA_KMS_KEY_ID: 'alias/kasuwa-t0117',
  KASUWA_TRUST_PROXY_HOPS: '1',
};

/** RFC 2606: `.invalid` never resolves, so nothing can be reached by accident. */
const REMOTE_HOST = 'db.t0117.invalid';

/**
 * I2. `runMigrations` with the one new option. A function that accepts
 * MigrateOptions also accepts MigrateOptions plus a field, so this typechecks
 * on main without a cast; once the builder adds `env` it is the same type.
 */
type GuardedOptions = Parameters<typeof runMigrations>[0] & { env?: EnvSource };
const runGuarded: (options: GuardedOptions) => ReturnType<typeof runMigrations> = runMigrations;

/**
 * What kasuwa_test_admin holds on main, at head (0028), captured from a
 * database built as the harness builds one. HARNESS must hold at least this
 * (section 4: the suites that connect as kasuwa_test_admin rely on it). The
 * placeholder in REAL must hold no more than this (section 3). Objects created
 * after 0028 are not listed, so a future migration need not edit this file.
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
 * What a default privilege may give a table, sequence or function created
 * after 0028: the shapes main's default privileges give, and nothing more
 * (never TRUNCATE, REFERENCES, TRIGGER or MAINTAIN).
 */
const FUTURE_OBJECT_PRIVILEGES: Readonly<Record<string, readonly string[]>> = {
  table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE', 'USAGE'],
  function: ['EXECUTE'],
};

/** Default privileges as `objtype|owner|schema|grantee|privileges`. */
const APP_DEFAULT_ACL = [
  'S|kasuwa_migrator|public|kasuwa_app|SELECT,USAGE',
  'f|kasuwa_migrator|public|kasuwa_app|EXECUTE',
  'r|kasuwa_migrator|public|kasuwa_app|DELETE,INSERT,SELECT,UPDATE',
];
const TEST_ADMIN_DEFAULT_ACL_ON_MAIN = [
  'S|kasuwa_migrator|public|kasuwa_test_admin|SELECT,USAGE',
  'f|kasuwa_migrator|public|kasuwa_test_admin|EXECUTE',
  'r|kasuwa_migrator|public|kasuwa_test_admin|DELETE,INSERT,SELECT,UPDATE',
];

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

/** The placeholder exactly as D-L94 states it. */
const INERT: RoleRow = {
  rolname: TEST_ADMIN,
  rolcanlogin: false,
  rolbypassrls: false,
  rolsuper: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolreplication: false,
  rolinherit: false,
};

/** Superuser only: whether a role has a password at all. */
const HAS_PASSWORD_SQL = `
  SELECT (rolpassword IS NOT NULL) AS has_password
    FROM pg_catalog.pg_authid WHERE rolname = $1`;

/** Memberships in either direction, by name. */
const MEMBERSHIPS_SQL = `
  SELECT r.rolname AS role, m.rolname AS member
    FROM pg_catalog.pg_auth_members am
    JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
    JOIN pg_catalog.pg_roles m ON m.oid = am.member
   WHERE r.rolname = $1 OR m.rolname = $1
   ORDER BY 1, 2`;

/** Every non-superuser role that can reach the role by membership, however indirect. */
const REACHES_SQL = `
  SELECT r.rolname
    FROM pg_catalog.pg_roles r
   WHERE r.rolname <> $1 AND NOT r.rolsuper AND r.rolname NOT LIKE 'pg\\_%'
     AND pg_catalog.pg_has_role(r.oid, $1::text, 'MEMBER')
   ORDER BY 1`;

/** Everything the role owns. It should own nothing. */
const OWNED_SQL = `
  SELECT 'relation ' || c.relname AS what FROM pg_catalog.pg_class c
   WHERE c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
  UNION ALL
  SELECT 'function ' || p.proname FROM pg_catalog.pg_proc p
   WHERE p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
  UNION ALL
  SELECT 'schema ' || n.nspname FROM pg_catalog.pg_namespace n
   WHERE n.nspowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
  UNION ALL
  SELECT 'database ' || d.datname FROM pg_catalog.pg_database d
   WHERE d.datdba = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)`;

/**
 * Every privilege recorded anywhere in the database, one row per (object,
 * grantee, privilege): relations (sequences included, as `table`), columns,
 * functions, types, schemas, the database itself, default privileges and role
 * memberships. PUBLIC is grantee 0.
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

async function roles(url: string): Promise<RoleRow[]> {
  return query<RoleRow & Record<string, unknown>>(url, ROLES_SQL);
}

async function hasPassword(superuserUrl: string, role: string): Promise<boolean | undefined> {
  const rows = await query<{ has_password: boolean }>(superuserUrl, HAS_PASSWORD_SQL, [role]);
  return rows[0]?.has_password;
}

async function census(url: string): Promise<CensusRow[]> {
  return query<CensusRow & Record<string, unknown>>(url, CENSUS_SQL);
}

async function defaultAcl(url: string): Promise<string[]> {
  return (await query<{ line: string }>(url, DEFAULT_ACL_SQL)).map((row) => row.line);
}

/** `kind|object` -> sorted privileges, for one grantee, default privileges excluded. */
function grantsOf(rows: readonly CensusRow[], grantee: string): Map<string, string[]> {
  const byObject = new Map<string, string[]>();
  for (const row of rows) {
    if (row.grantee !== grantee || row.kind === 'default') {
      continue;
    }
    const key = `${row.kind}|${row.object}`;
    byObject.set(key, [...(byObject.get(key) ?? []), row.privilege].sort());
  }
  return byObject;
}

function withSearchPath(url: string, schema: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

function withHost(url: string, host: string): string {
  const parsed = new URL(url);
  parsed.hostname = host;
  return parsed.href;
}

function withPassword(url: string, password: string): string {
  const parsed = new URL(url);
  parsed.password = password;
  return parsed.href;
}

function withQuery(url: string, key: string, value: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

type Outcome = { ok: true; applied: string[] } | { ok: false; message: string };

interface ScratchRun {
  outcome: Outcome;
  /** Every relation the run left in its scratch schema. */
  relations: string[];
}

/**
 * Runs the guarded runner against a throwaway migrations directory holding
 * one file, with `search_path` pinned to a throwaway schema, as the T-0044
 * runner suite does. The runner creates `_kasuwa_migration` unqualified, so
 * anything it writes lands where `relations` can see it.
 *
 * `adminUrl` makes and inspects the schema. `runnerUrl` is what the runner is
 * handed, after the search path is added; by default the same URL. Tests that
 * attack the URL (another host, an overriding query parameter) change only it.
 */
async function scratchRun(
  adminUrl: string,
  env: EnvSource,
  runnerUrl: (url: string) => string = (url) => url,
): Promise<ScratchRun> {
  const schema = `t0117_${randomBytes(6).toString('hex')}`;
  const dir = mkdtempSync(join(tmpdir(), 'kasuwa-t0117-'));
  writeFileSync(
    join(dir, '0001_t0117_probe.sql'),
    'CREATE TABLE t0117_probe (id integer PRIMARY KEY);\n',
    'utf8',
  );
  await query(adminUrl, `CREATE SCHEMA ${schema}`);
  try {
    let outcome: Outcome;
    try {
      const result = await runGuarded({
        connectionString: runnerUrl(withSearchPath(adminUrl, schema)),
        migrationsDir: dir,
        env,
      });
      outcome = { ok: true, applied: result.applied };
    } catch (error) {
      outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    const relations = await query<{ relname: string }>(
      adminUrl,
      `SELECT c.relname FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 ORDER BY 1`,
      [schema],
    );
    return { outcome, relations: relations.map((row) => row.relname) };
  } finally {
    await query(adminUrl, `DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** I3, I5: no password and no connection string in a message. */
function expectNoSecret(message: string, extra: readonly string[] = []): void {
  for (const secret of [...DEV_PASSWORDS, REAL_SECRET, HARNESS_SECRET, ...extra]) {
    expect(message).not.toContain(secret);
  }
  expect(message).not.toMatch(/postgres(?:ql)?:\/\//u);
}

/** A refusal, before anything was written, carrying no secret. */
function expectRefused(run: ScratchRun, why: string): string {
  expect(run.outcome.ok, why).toBe(false);
  expect(run.relations, 'the runner wrote before refusing').toEqual([]);
  const message = run.outcome.ok ? '' : run.outcome.message;
  expectNoSecret(message);
  return message;
}

function expectRan(run: ScratchRun): void {
  expect(run.outcome).toEqual({ ok: true, applied: ['0001_t0117_probe'] });
  expect(run.relations).toContain('t0117_probe');
}

/**
 * SQL with comments removed and string literals kept. Dollar-quoted bodies
 * (DO $$ ... $$) are kept as code, which is right: the CREATE ROLE statements
 * live inside one.
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

  // REAL: bootstrap.sql alone, then the migrator's password replaced, as
  // provisioning does. Migrated in section 2, as a test.
  await applyFile(real.superuserUrl, BOOTSTRAP_SQL);
  await query(real.superuserUrl, `ALTER ROLE kasuwa_migrator PASSWORD '${REAL_SECRET}'`);
  realMigrator = real.urlFor('kasuwa_migrator', REAL_SECRET);

  // HARNESS: both files in the order docker-compose and packages/testing must
  // apply them, every migration with the dev password under NODE_ENV=test,
  // then the migrator's password replaced (see the header).
  await applyFile(harness.superuserUrl, BOOTSTRAP_SQL);
  harnessHasTestBootstrap = existsSync(BOOTSTRAP_TEST_SQL);
  if (harnessHasTestBootstrap) {
    await applyFile(harness.superuserUrl, BOOTSTRAP_TEST_SQL);
  }
  try {
    await runGuarded({
      connectionString: harness.urlFor('kasuwa_migrator', MIGRATOR_PASSWORD),
      env: TEST_ENV,
    });
  } catch (error) {
    harnessMigrateError = error instanceof Error ? error : new Error(String(error));
  }
  await query(harness.superuserUrl, `ALTER ROLE kasuwa_migrator PASSWORD '${HARNESS_SECRET}'`);
  harnessMigrator = harness.urlFor('kasuwa_migrator', HARNESS_SECRET);
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

/**
 * Runs `body` with REAL's placeholder changed by `statements` (as the
 * superuser), starting from the inert state, and puts back what was there
 * before, whatever happens. On main the role starts live, which is restored.
 */
async function withPlaceholderChanged(
  statements: readonly string[],
  undo: readonly string[],
  body: () => Promise<void>,
): Promise<void> {
  const before = await roleNamed(real.superuserUrl, TEST_ADMIN);
  expect(before, 'REAL has no kasuwa_test_admin at all').toBeDefined();
  await query(real.superuserUrl, `ALTER ROLE ${TEST_ADMIN} NOLOGIN NOBYPASSRLS NOINHERIT`);
  for (const statement of statements) {
    await query(real.superuserUrl, statement);
  }
  try {
    await body();
  } finally {
    for (const statement of undo) {
      await query(real.superuserUrl, statement);
    }
    if (before !== undefined) {
      await query(
        real.superuserUrl,
        `ALTER ROLE ${TEST_ADMIN} ${before.rolcanlogin ? 'LOGIN' : 'NOLOGIN'} ` +
          `${before.rolbypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS'} ` +
          `${before.rolinherit ? 'INHERIT' : 'NOINHERIT'}`,
      );
    }
  }
}

/**
 * Runs `body` with REAL's migrator on its dev password, then puts the secret
 * back. `body` gets the migrator URL that works meanwhile.
 */
async function withMigratorOnDevPassword(body: (devUrl: string) => Promise<void>): Promise<void> {
  await query(real.superuserUrl, `ALTER ROLE kasuwa_migrator PASSWORD '${MIGRATOR_PASSWORD}'`);
  try {
    await body(real.urlFor('kasuwa_migrator', MIGRATOR_PASSWORD));
  } finally {
    await query(real.superuserUrl, `ALTER ROLE kasuwa_migrator PASSWORD '${REAL_SECRET}'`);
  }
}

// =============================================================================

describe('1. bootstrap.sql alone makes kasuwa_test_admin an inert placeholder', () => {
  it('the role exists with no LOGIN, no BYPASSRLS, no INHERIT and no other attribute', async () => {
    expect(await roleNamed(real.superuserUrl, TEST_ADMIN)).toEqual(INERT);
  });

  it('the role has no password at all (read as the superuser, pg_authid)', async () => {
    expect(await hasPassword(real.superuserUrl, TEST_ADMIN)).toBe(false);
  });

  it('the role is a member of nothing and has no members', async () => {
    expect(await query(real.superuserUrl, MEMBERSHIPS_SQL, [TEST_ADMIN])).toEqual([]);
  });

  it('BYPASSRLS is held by kasuwa_migrator alone', async () => {
    const rows = await roles(real.superuserUrl);
    expect(rows.filter((row) => row.rolbypassrls).map((row) => row.rolname)).toEqual([
      'kasuwa_migrator',
    ]);
  });

  it('the roles are the five known ones, and only app, auth and migrator can log in', async () => {
    const rows = await roles(real.superuserUrl);
    expect(rows.map((row) => row.rolname)).toEqual([...REAL_ROLES]);
    expect(rows.filter((row) => row.rolcanlogin).map((row) => row.rolname)).toEqual([
      ...REAL_LOGIN_ROLES,
    ]);
    // In PostgreSQL 16 a CREATEROLE role holding BYPASSRLS (the migrator
    // does) may create a BYPASSRLS login: CREATEROLE would be a way back.
    expect(rows.filter((row) => row.rolsuper || row.rolcreaterole)).toEqual([]);
  });

  it('is idempotent, and re-applying keeps the placeholder inert', async () => {
    const before = await census(real.superuserUrl);
    await applyFile(real.superuserUrl, BOOTSTRAP_SQL);
    expect(await census(real.superuserUrl)).toEqual(before);
    expect(await roleNamed(real.superuserUrl, TEST_ADMIN)).toEqual(INERT);
  });
});

describe('2. that database migrates to head under a production configuration', () => {
  it('applies every migration in packages/db/migrations, in order', async () => {
    // What provisioning does to a real cell. No guard may stop it: the
    // placeholder is inert, the migrator's password is not a dev one, and
    // NODE_ENV is set. Every migration that names the role must find it.
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

describe('3. after migrating, the placeholder holds no more than on main and nobody can use it', () => {
  it('is still inert, password-less and membership-free; BYPASSRLS is still the migrator alone', async () => {
    requireRealMigrated();
    expect(await roleNamed(real.superuserUrl, TEST_ADMIN)).toEqual(INERT);
    expect(await hasPassword(real.superuserUrl, TEST_ADMIN)).toBe(false);
    expect(await query(real.superuserUrl, MEMBERSHIPS_SQL, [TEST_ADMIN])).toEqual([]);
    const rows = await roles(real.superuserUrl);
    expect(rows.map((row) => row.rolname)).toEqual([...REAL_ROLES]);
    expect(rows.filter((row) => row.rolbypassrls).map((row) => row.rolname)).toEqual([
      'kasuwa_migrator',
    ]);
  });

  it('no non-superuser role can reach it by membership, and it owns nothing', async () => {
    requireRealMigrated();
    expect(await query(real.superuserUrl, REACHES_SQL, [TEST_ADMIN])).toEqual([]);
    expect(await query(real.superuserUrl, OWNED_SQL, [TEST_ADMIN])).toEqual([]);
  });

  it.each([
    ['kasuwa_app', APP_PASSWORD],
    ['kasuwa_auth', AUTH_PASSWORD],
    ['kasuwa_migrator', REAL_SECRET],
  ] as const)('%s cannot SET ROLE to it', async (role, password) => {
    requireRealMigrated();
    // The behavioural form of the membership check above. On main this holds
    // too: the role is a login, but nobody is a member of it.
    await expect(
      query(real.urlFor(role, password), `SET ROLE ${TEST_ADMIN}`),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot log in, with the dev password or any other', async () => {
    requireRealMigrated();
    // 28P01: no password to match. 28000: not permitted to log in.
    for (const password of [TEST_ADMIN_PASSWORD, REAL_SECRET]) {
      const code = await query(real.urlFor(TEST_ADMIN, password), 'SELECT 1').then(
        () => 'connected',
        (error: unknown) => (error as { code?: string }).code,
      );
      expect(
        ['28P01', '28000'],
        `kasuwa_test_admin with password ${password === TEST_ADMIN_PASSWORD ? 'dev' : 'random'}`,
      ).toContain(code);
    }
  });

  it('holds no grant beyond what kasuwa_test_admin held on main', async () => {
    requireRealMigrated();
    const held = grantsOf(await census(real.superuserUrl), TEST_ADMIN);
    const beyond = [...held].flatMap(([object, privileges]) => {
      const known = TEST_ADMIN_GRANTS_ON_MAIN[object];
      const allowed =
        known !== undefined
          ? known.split(',')
          : (FUTURE_OBJECT_PRIVILEGES[object.split('|')[0] ?? ''] ?? []);
      const extra = privileges.filter((privilege) => !allowed.includes(privilege));
      return extra.length === 0 ? [] : [`${object}: ${extra.join(',')}`];
    });
    expect(beyond).toEqual([]);
  });

  it('every grantee of every privilege is a known role or PUBLIC', async () => {
    requireRealMigrated();
    const allowed = new Set<string>(['PUBLIC', ...REAL_ROLES]);
    const strangers = (await census(real.superuserUrl)).filter((row) => !allowed.has(row.grantee));
    expect(strangers).toEqual([]);
  });

  it("default privileges: kasuwa_app's exactly, and the placeholder at most main's", async () => {
    requireRealMigrated();
    const lines = await defaultAcl(real.superuserUrl);
    expect(lines.filter((line) => !line.includes(`|${TEST_ADMIN}|`))).toEqual(APP_DEFAULT_ACL);
    const extra = lines
      .filter((line) => line.includes(`|${TEST_ADMIN}|`))
      .filter((line) => !TEST_ADMIN_DEFAULT_ACL_ON_MAIN.includes(line));
    expect(extra).toEqual([]);
  });
});

describe('4. with bootstrap.sql then bootstrap-test.sql, the harness behaves as today', () => {
  it('bootstrap-test.sql exists and is what makes kasuwa_test_admin a login', () => {
    expect(harnessHasTestBootstrap, 'packages/db/sql/bootstrap-test.sql does not exist').toBe(true);
    const code = stripSqlComments(readFileSync(BOOTSTRAP_TEST_SQL, 'utf8'));
    expect(code).toMatch(/\b(?:CREATE|ALTER)\s+ROLE\s+"?kasuwa_test_admin"?[^;]*\bLOGIN\b/iu);
  });

  it('kasuwa_test_admin is a BYPASSRLS login with no other power, and no memberships', async () => {
    // INHERIT is not pinned: the role is a member of nothing, so it is moot.
    const role = await roleNamed(harness.superuserUrl, TEST_ADMIN);
    expect(role).toMatchObject({
      rolname: TEST_ADMIN,
      rolcanlogin: true,
      rolbypassrls: true,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
    });
    expect(await query(harness.superuserUrl, MEMBERSHIPS_SQL, [TEST_ADMIN])).toEqual([]);
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
      const have = held.get(object) ?? [];
      const lacking = privileges.split(',').filter((privilege) => !have.includes(privilege));
      return lacking.length === 0 ? [] : [`${object}: ${lacking.join(',')}`];
    });
    expect(missing).toEqual([]);
  });

  it('default privileges include all of main’s, for kasuwa_app and kasuwa_test_admin', async () => {
    requireHarnessMigrated();
    const lines = await defaultAcl(harness.superuserUrl);
    const missing = [...APP_DEFAULT_ACL, ...TEST_ADMIN_DEFAULT_ACL_ON_MAIN].filter(
      (line) => !lines.includes(line),
    );
    expect(missing).toEqual([]);
  });

  it('re-applying bootstrap.sql alone (tools/dev.mjs does) leaves the test login live', async () => {
    // D-L94: bootstrap.sql leaves an existing role alone. If it re-asserted
    // the placeholder, every `pnpm dev` would break the harness login.
    requireHarnessMigrated();
    const before = await roleNamed(harness.superuserUrl, TEST_ADMIN);
    await applyFile(harness.superuserUrl, BOOTSTRAP_SQL);
    expect(await roleNamed(harness.superuserUrl, TEST_ADMIN)).toEqual(before);
    const rows = await query<{ who: string }>(
      harness.urlFor(TEST_ADMIN, TEST_ADMIN_PASSWORD),
      'SELECT current_user::text AS who',
    );
    expect(rows).toEqual([{ who: TEST_ADMIN }]);
  });

  it('re-applying both files after migrating fails nothing and changes nothing', async () => {
    requireHarnessMigrated();
    expect(harnessHasTestBootstrap, 'packages/db/sql/bootstrap-test.sql does not exist').toBe(true);
    const before = await census(harness.superuserUrl);
    await applyFile(harness.superuserUrl, BOOTSTRAP_SQL);
    await applyFile(harness.superuserUrl, BOOTSTRAP_TEST_SQL);
    expect(await census(harness.superuserUrl)).toEqual(before);
  });

  it('the shared harness still hands every suite a working BYPASSRLS kasuwa_test_admin', async () => {
    // The live global setup, not a copy of it: if packages/testing stops
    // applying bootstrap-test.sql this login fails.
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
    // The entrypoint runs the directory in name order.
    expect([main, test].sort()).toEqual([main, test]);
  });
});

describe('5. the runner refuses a usable kasuwa_test_admin, a blind NODE_ENV and dev passwords', () => {
  describe('5a. keyed on the role’s attributes (R4)', () => {
    it('refuses in production when the role is the live test login', async () => {
      requireHarnessMigrated();
      const message = expectRefused(
        await scratchRun(harnessMigrator, PRODUCTION),
        'the runner migrated a production database whose kasuwa_test_admin can log in',
      );
      expect(message).toContain(TEST_ADMIN);
      expect(message).toContain('production');
    });

    it.each(['staging', 'prod', 'Production', ''])(
      'refuses with NODE_ENV=%j when the role is live (R1)',
      async (nodeEnv) => {
        requireHarnessMigrated();
        expectRefused(
          await scratchRun(harnessMigrator, { ...PRODUCTION, NODE_ENV: nodeEnv }),
          `the runner migrated with NODE_ENV=${JSON.stringify(nodeEnv)}`,
        );
      },
    );

    it.each([
      ['LOGIN alone', [`ALTER ROLE ${TEST_ADMIN} LOGIN`], []],
      ['BYPASSRLS alone', [`ALTER ROLE ${TEST_ADMIN} BYPASSRLS`], []],
      [
        'a member (kasuwa_sweeper)',
        [`GRANT ${TEST_ADMIN} TO kasuwa_sweeper`],
        [`REVOKE ${TEST_ADMIN} FROM kasuwa_sweeper`],
      ],
      [
        'membership of a role (kasuwa_sweeper)',
        [`GRANT kasuwa_sweeper TO ${TEST_ADMIN}`],
        [`REVOKE kasuwa_sweeper FROM ${TEST_ADMIN}`],
      ],
    ] as const)(
      'refuses in production when the placeholder gains %s',
      async (_what, change, undo) => {
        requireRealMigrated();
        await withPlaceholderChanged(change, undo, async () => {
          const message = expectRefused(
            await scratchRun(realMigrator, PRODUCTION),
            'the runner migrated a production database with a usable kasuwa_test_admin',
          );
          expect(message).toContain(TEST_ADMIN);
        });
      },
    );

    it('RUNS in production when the role is the inert placeholder (control)', async () => {
      // Without this, a runner that refused production outright, or refused
      // on the role's mere existence, would pass every refusal above.
      requireRealMigrated();
      expectRan(await scratchRun(realMigrator, PRODUCTION));
    });

    it.each([
      ['development', DEVELOPMENT],
      ['test', TEST_ENV],
    ] as const)('runs in %s when the role is live (control)', async (_name, env) => {
      requireHarnessMigrated();
      expectRan(await scratchRun(harnessMigrator, env));
    });
  });

  describe('5b. an unset NODE_ENV is allowed only against a local host (R5)', () => {
    it.each([
      ['a remote name', (url: string) => withHost(url, REMOTE_HOST)],
      [
        'a name that only starts with localhost',
        (url: string) => withHost(url, 'localhost.t0117.invalid'),
      ],
      [
        'localhost in the URL, overridden by ?host= (I4)',
        (url: string) => withQuery(withHost(url, 'localhost'), 'host', REMOTE_HOST),
      ],
    ] as const)(
      'refuses an unset NODE_ENV against %s, before connecting',
      async (_what, attack) => {
        // The hosts never resolve: if the runner tried to connect first, the
        // error would be a DNS failure, which names neither reason.
        requireHarnessMigrated();
        const message = expectRefused(
          await scratchRun(harnessMigrator, UNSET, attack),
          'the runner ran with no NODE_ENV against a non-local host',
        );
        expect(message).toContain('NODE_ENV');
        expect(message).not.toMatch(/ENOTFOUND|getaddrinfo/u);
      },
    );

    it.each(['localhost', '127.0.0.1'])(
      'runs with an unset NODE_ENV against %s, even with the live role (control)',
      async (host) => {
        requireHarnessMigrated();
        expectRan(await scratchRun(harnessMigrator, UNSET, (url) => withHost(url, host)));
      },
    );
  });

  describe('5c. the repository’s dev passwords are refused outside development and test', () => {
    // REAL, so the placeholder is inert and the role guard cannot be the
    // reason; the migrator's password really is the dev one meanwhile, so an
    // authentication failure cannot be the reason either.
    it.each([
      ['in the URL', (url: string) => url],
      [
        'percent-encoded in the URL (I4)',
        (url: string) => withPassword(url, 'kasuwa%5Fmigrator%5Fdev'),
      ],
      [
        'as a ?password= override of a secret-looking one (I4)',
        (url: string) => withQuery(withPassword(url, REAL_SECRET), 'password', MIGRATOR_PASSWORD),
      ],
    ] as const)('refuses the dev migrator password %s in production', async (_how, attack) => {
      requireRealMigrated();
      await withMigratorOnDevPassword(async (devUrl) => {
        const message = expectRefused(
          await scratchRun(devUrl, PRODUCTION, attack),
          'the runner migrated production with the repository dev password',
        );
        expect(message).toMatch(/password/iu);
        expectNoSecret(message, ['kasuwa%5Fmigrator%5Fdev']);
      });
    });

    it.each([
      ['test', TEST_ENV],
      ['development', DEVELOPMENT],
      ['an unset NODE_ENV on localhost', UNSET],
    ] as const)('accepts the dev migrator password in %s (control)', async (_name, env) => {
      requireRealMigrated();
      await withMigratorOnDevPassword(async (devUrl) => {
        expectRan(await scratchRun(devUrl, env, (url) => withHost(url, 'localhost')));
      });
    });
  });
});

describe('6. bootstrap.sql carries no password but the three documented dev ones (R3)', () => {
  const raw = readFileSync(BOOTSTRAP_SQL, 'utf8');
  const code = stripSqlComments(raw);

  it("never contains the test role's password, even in a comment", () => {
    expect(raw).not.toContain(TEST_ADMIN_PASSWORD);
  });

  it('every PASSWORD clause is one of the three pinned role/literal pairs, once each', () => {
    const keywords = code.match(/\bPASSWORD\b/giu) ?? [];
    const pairs = [
      ...code.matchAll(
        /\b(?:CREATE|ALTER)\s+(?:ROLE|USER)\s+"?([a-z_][a-z0-9_]*)"?[^;]*?\bPASSWORD\s+('(?:[^']|'')*'|[^\s;]+)/giu,
      ),
    ].map((match) => `${match[1] ?? '?'}=${match[2] ?? '?'}`);
    // A PASSWORD keyword the pattern did not understand (a hashed literal,
    // \password, a role set some other way) fails here.
    expect(pairs.length, `PASSWORD clauses not understood: ${keywords.length}`).toBe(
      keywords.length,
    );
    expect(pairs.sort()).toEqual([
      "kasuwa_app='kasuwa_app_dev'",
      "kasuwa_auth='kasuwa_auth_dev'",
      "kasuwa_migrator='kasuwa_migrator_dev'",
    ]);
  });

  it('creates the placeholder NOLOGIN NOBYPASSRLS NOINHERIT, and never gives it more', () => {
    const statements = [
      ...code.matchAll(/\b(?:CREATE|ALTER)\s+ROLE\s+"?kasuwa_test_admin"?\b[^;]*;/giu),
    ].map((match) => match[0]);
    const create = statements.filter((statement) => /^CREATE/iu.test(statement));
    expect(create.length, 'bootstrap.sql does not CREATE ROLE kasuwa_test_admin').toBe(1);
    // Explicit, not defaulted: CREATE ROLE defaults to INHERIT.
    for (const attribute of ['NOLOGIN', 'NOBYPASSRLS', 'NOINHERIT']) {
      expect(create[0] ?? '').toMatch(new RegExp(`\\b${attribute}\\b`, 'iu'));
    }
    for (const statement of statements) {
      expect(statement).not.toMatch(/\bPASSWORD\b/iu);
      expect(statement).not.toMatch(/(?<!NO)(?:LOGIN|BYPASSRLS|SUPERUSER|CREATEROLE|CREATEDB)\b/iu);
    }
  });

  it('pulls in no other file', () => {
    expect(code).not.toMatch(/bootstrap-test/iu);
    // psql meta-commands (\i, \ir, \include) would pull bootstrap-test.sql in
    // when docker-compose or tools/dev.mjs runs this through psql.
    expect(raw.split(/\r?\n/u).filter((line) => /^\s*\\/u.test(line))).toEqual([]);
  });

  it('the header and packages/db/CLAUDE.md say which file real provisioning applies', () => {
    const header = raw.slice(0, raw.search(/^\s*(?:DO|CREATE|ALTER|GRANT|REVOKE)\b/mu));
    expect(header).toMatch(/bootstrap-test\.sql/u);
    expect(readFileSync(DB_CLAUDE_MD, 'utf8')).toMatch(/bootstrap-test\.sql/u);
  });
});

describe('7. the API refuses the repository’s dev passwords at startup in production (I5)', () => {
  const url = (role: string, password: string, suffix = ''): string =>
    `postgres://${role}:${password}@${REMOTE_HOST}:5432/kasuwa${suffix}`;
  const secretApp = url('kasuwa_app', REAL_SECRET);
  const secretAuth = url('kasuwa_auth', HARNESS_SECRET);

  function refusal(source: EnvSource): string {
    try {
      apiEnv(source);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return '';
  }

  it('boots in production with passwords that are not the repository’s (control)', () => {
    expect(() =>
      apiEnv({ ...API_PRODUCTION, DATABASE_URL: secretApp, DATABASE_AUTH_URL: secretAuth }),
    ).not.toThrow();
  });

  it('boots in development with the dev passwords (control)', () => {
    expect(() =>
      apiEnv({
        ...DEVELOPMENT,
        DATABASE_URL: url('kasuwa_app', APP_PASSWORD),
        DATABASE_AUTH_URL: url('kasuwa_auth', AUTH_PASSWORD),
      }),
    ).not.toThrow();
  });

  it.each(
    (['DATABASE_URL', 'DATABASE_AUTH_URL'] as const).flatMap((variable) =>
      DEV_PASSWORDS.map((password) => [variable, password] as const),
    ),
  )('refuses %s carrying %s', (variable, password) => {
    const message = refusal({
      ...API_PRODUCTION,
      DATABASE_URL: secretApp,
      DATABASE_AUTH_URL: secretAuth,
      [variable]: url(variable === 'DATABASE_URL' ? 'kasuwa_app' : 'kasuwa_auth', password),
    });
    expect(message, `apiEnv booted in production with ${variable} on a dev password`).not.toBe('');
    expect(message).toContain(variable);
    expectNoSecret(message);
  });

  it.each([
    ['percent-encoded', url('kasuwa_app', 'kasuwa%5Fapp%5Fdev')],
    ['as a ?password= override', url('kasuwa_app', REAL_SECRET, `?password=${APP_PASSWORD}`)],
  ])('refuses DATABASE_URL with the dev password %s (I4)', (_how, databaseUrl) => {
    const message = refusal({
      ...API_PRODUCTION,
      DATABASE_URL: databaseUrl,
      DATABASE_AUTH_URL: secretAuth,
    });
    expect(message, 'apiEnv booted in production with a disguised dev password').not.toBe('');
    expect(message).toContain('DATABASE_URL');
    expectNoSecret(message, ['kasuwa%5Fapp%5Fdev']);
  });

  // D-L95: an unset NODE_ENV is refused by the API and the worker, so a real cell that forgot it
  // cannot boot as "development" (stub auth, no dev-password or test-role check).
  const withoutNodeEnv = (source: EnvSource): EnvSource =>
    Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'NODE_ENV'));

  it('the API refuses to boot with NODE_ENV unset (D-L95)', () => {
    const message = refusal(
      withoutNodeEnv({ ...API_PRODUCTION, DATABASE_URL: secretApp, DATABASE_AUTH_URL: secretAuth }),
    );
    expect(message, 'apiEnv booted with NODE_ENV unset').not.toBe('');
    expect(message).toContain('NODE_ENV');
    expectNoSecret(message);
  });

  it('the worker refuses to boot with NODE_ENV unset (D-L95)', () => {
    let message = '';
    try {
      workerEnv({ DATABASE_URL: secretApp, REDIS_URL: 'redis://r:6379' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message, 'workerEnv booted with NODE_ENV unset').not.toBe('');
    expect(message).toContain('NODE_ENV');
    expectNoSecret(message);
  });
});
