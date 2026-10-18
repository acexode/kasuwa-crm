import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  SEED_ACCOUNTS,
  SEED_ACTIVITIES,
  SEED_CONTACTS,
  SEED_DEALS,
  TENANT_A,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_SUPERVISOR,
  withTenantTransaction,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * ACCEPTANCE — T-0089, custom-field STORAGE: migration 0039, the database
 * guards and the tenancy invariants (ADR-0016 items 1, 2, 8, 9, 10 and its
 * "Migration shape"; D-L128, D-L65, D-P33, D-P24, D-P25; CLAUDE.md 2.1, 2.4,
 * 2.7). Agent 2 builds it. Written by QA for the lead before the build (D-L23,
 * D-L25), from the ADR and the T-0088 contract, not from an implementation.
 *
 * Companion suites: custom-fields-admin-api (definitions over the admin API),
 * custom-fields-values-api (values, merge, withholding, filters, retire over
 * the records API) and custom-fields-budget (one filter at the T-0084 120k
 * seed). Helpers are restated in each, never imported (importing a test file
 * registers its tests).
 *
 * ==========================================================================
 * PINNED (the builder honours these exactly)
 * ==========================================================================
 *
 * M. MIGRATION. Exactly one `0039_*.sql`, applied by the runner. Comments
 *    stripped, it: adds `custom` to contact, account, activity and deal; adds
 *    every CHECK it adds `NOT VALID` and validates none (D-L65: VALIDATE is
 *    a later file); creates no table, role, extension or index; adds no
 *    SECURITY DEFINER; marks nothing LEAKPROOF (D-P33); creates, alters or
 *    drops no policy except ONE new `CREATE POLICY ... ON field_def`.
 *
 * C. COLUMNS. `custom jsonb NOT NULL DEFAULT '{}'::jsonb` on the four tables
 *    (a constant default: existing rows read `{}`). `field_def.retired_at
 *    timestamptz NULL`, no default.
 *
 * K. CHECKS (every role, the migrator included; BYPASSRLS bypasses no CHECK).
 *    On each of the four tables a direct write is refused when `custom` is
 *    not a JSON object; when `octet_length(custom::text) > 524288` (BYTES of
 *    the jsonb text form, not characters: exactly 524288 is accepted, 524289
 *    refused); or when any TOP-LEVEL key fails `^[a-z][a-z0-9_]*__c$` (keys
 *    inside a value, such as a currency's `amountMinor`, are not checked).
 *    The 512 KiB CHECK is a BACKSTOP only (D-L140; T-0089, D-L142 lead edit:
 *    it was 32 KiB, which retired values and disjoint readers could reach,
 *    making it a size oracle): the API's own limit is 16 KiB on what the
 *    caller can see, pinned in custom-fields-values-api.
 *
 * G. GRANTS. kasuwa_app may SELECT, INSERT and UPDATE the `custom` column of
 *    all four. On activity and deal, which use column privileges (0027,
 *    0036), that is a column grant: kasuwa_app still holds NO table-level
 *    UPDATE on either (a widened grant would also hand it the keys and
 *    `created_by_user_id`).
 *
 * F. FIELD_DEF. As kasuwa_app (tenant admin or not, RLS scope irrelevant): a
 *    DELETE of a custom field of any of the four standard objects matches
 *    nothing and the row stays (a restrictive policy, the 0025 pattern); the
 *    TYPE of a custom field cannot change; its label, description,
 *    classification (both directions, D-P25), config (picklist values are
 *    added, so config must stay writable) and retired_at can. kasuwa_migrator
 *    can still delete one (offboarding, D5 of the delete-guard suite).
 *    ADDED (T-0089, D-L142 lead edit):
 *      - a custom field's `object_id` is frozen for EVERY role, the migrator
 *        included: moving one to a custom object (then deleting it there) or
 *        to another standard object (then re-creating its api_name) fails;
 *      - the new restrictive DELETE policy is written positively, an
 *        `EXISTS (... o.is_custom)` and no `NOT EXISTS`, so it fails closed;
 *      - `CHECK (retired_at IS NULL OR is_custom)`, binding every role: a
 *        standard field cannot be retired;
 *      - kasuwa_app cannot un-retire a field (retired_at back to NULL).
 *
 * T. TENANCY UNCHANGED (ADR-0016 item 10). The four tables and field_def keep
 *    RLS ENABLED and FORCED and a policy whose WITH CHECK equals its USING;
 *    the record tables' permissive policies still name the tenant and the
 *    programme. As kasuwa_app an A1 session can neither read nor write A2's
 *    `custom`. No new table, role or function; the SECURITY DEFINER census
 *    is still the two CLAUDE.md 2.7 names; TENANT_SCOPED_TABLES still lists
 *    the four.
 *
 * I. INDEXES (D-P33, ADR-0016 item 8). No index of any kind on the four
 *    tables mentions `custom` (no GIN, no `jsonb_path_ops`, no `->>`
 *    expression, no partial predicate), and no GIN index exists on them.
 *    The LEAKPROOF set is still template1's.
 *
 * D. DRIZZLE. packages/db/src/schema.ts declares `custom` on the four tables
 *    and `retired_at` on fieldDef.
 *
 * ==========================================================================
 * RULINGS where the ADR is silent (this suite's; the lead may reverse)
 * ==========================================================================
 *
 * S1  The byte limit is measured exactly as ADR-0016 item 2 writes it,
 *     `octet_length(custom::text)`, so the boundary is pinned at 524288 /
 *     524289 bytes of the jsonb text form (D-L142; it was 32768 / 32769).
 *     (The API's own 16 KiB rule is tested well away from the boundary in
 *     the values suite, so the two serialisations need not agree to the
 *     byte.)
 * S2  The key check rejects a key with a trailing or embedded newline, an
 *     upper-case letter, a leading digit or underscore, a non-ASCII letter
 *     and a space. A regex test that is not anchored, or anchored with a
 *     newline-sensitive `$`, fails here.
 * S3  A custom field on a CUSTOM object stays deletable by kasuwa_app: the
 *     ADR retires custom fields of STANDARD objects only. This is also the
 *     control that proves the new policy does not simply forbid every
 *     DELETE on field_def.
 * S4  The freeze is pinned for kasuwa_app only, as 0025 freezes standard
 *     fields (a migration may still correct a definition). Whether the
 *     migrator is also frozen is the builder's.
 * S5  The migration does not VALIDATE its own CHECKs (D-L65: expand now,
 *     validate in a later file). Whether that later file is part of T-0089
 *     is the lead's; this suite only pins 0039.
 * S6  "No new function" is a census: every function in the `app` and
 *     `public` schemas is named by a `CREATE FUNCTION` in bootstrap.sql or a
 *     migration before 0039. Replacing an existing function (to extend the
 *     0025 freeze trigger) is allowed; adding one is not.
 *
 * ==========================================================================
 * D-L23: on this branch there is no 0039, no `custom` column and no
 * `retired_at`. Every test fails for that reason except those titled
 * "(guard)", which protect what exists and pass by design, and those titled
 * "(self-check)", which test this file's helpers.
 *
 * Fixtures: packages/db/src/fixtures.ts, plus field_def rows planted by
 * kasuwa_migrator with ids in this suite's range
 * (`11111111-0000-4000-8000-0089xxxxxxxx`). Every probe runs in a rolled-back
 * transaction; the suite reseeds before and after.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'packages/db/migrations');
const BOOTSTRAP_SQL = resolve(REPO_ROOT, 'packages/db/sql/bootstrap.sql');
const SCHEMA_TS = resolve(REPO_ROOT, 'packages/db/src/schema.ts');

const TABLES = ['contact', 'account', 'activity', 'deal'] as const;
type Table = (typeof TABLES)[number];

const id89 = (tail: string) => `11111111-0000-4000-8000-0089${tail.padStart(8, '0')}`;

/** T-0089 / D-L142 (lead edit): the backstop is 512 KiB; it was 32768. */
const LIMIT_BYTES = 524288;

type Json = Record<string, unknown>;

function must<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`Fixture drift: ${what}`);
  return value;
}

/** One seeded row per table in each programme (tenant A). */
const ROW_A1: Record<Table, string> = {
  contact: must(SEED_CONTACTS.find((c) => c.programmeId === PROGRAMME_A1), 'A1 contact').id,
  account: must(SEED_ACCOUNTS.find((a) => a.programmeId === PROGRAMME_A1), 'A1 account').id,
  activity: must(SEED_ACTIVITIES.find((a) => a.programmeId === PROGRAMME_A1), 'A1 activity').id,
  deal: must(SEED_DEALS.find((d) => d.programmeId === PROGRAMME_A1), 'A1 deal').id,
};
const CONTACT_A2 = must(SEED_CONTACTS.find((c) => c.programmeId === PROGRAMME_A2), 'A2 contact').id;
const ACCOUNT_A2 = must(SEED_ACCOUNTS.find((a) => a.programmeId === PROGRAMME_A2), 'A2 account').id;

// ---------------------------------------------------------------------------
// The migration file.
// ---------------------------------------------------------------------------

/** Line and block comments, then string literals, removed. */
function codeOf(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}
const withoutStrings = (code: string) => code.replace(/'(?:[^']|'')*'/g, "''");

function migration0039(): { name: string; sql: string } | null {
  const found = readdirSync(MIGRATIONS_DIR).filter((name) => /^0039_.*\.sql$/.test(name));
  if (found.length !== 1) return null;
  const name = String(found[0]);
  return { name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') };
}

function require0039(): { name: string; sql: string } {
  const file = migration0039();
  expect(file, 'packages/db/migrations has no single 0039_*.sql').not.toBeNull();
  return file as { name: string; sql: string };
}

/**
 * Problems with 0039's text, by M. Returns the list (empty: it passes).
 * Exported to the self-check below so the scan is seen to fail.
 */
function migrationProblems(sql: string): string[] {
  const code = withoutStrings(codeOf(sql));
  const problems: string[] = [];
  for (const table of TABLES) {
    const adds = new RegExp(
      `ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:"?public"?\\.)?"?${table}"?\\b[^;]*?ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?"?custom"?\\s+jsonb\\b`,
      'i',
    );
    if (!adds.test(code)) problems.push(`does not add custom jsonb to ${table}`);
  }
  const checks = (code.match(/\bADD\s+CONSTRAINT\s+\S+\s+CHECK\b/gi) ?? []).length;
  const notValid = (code.match(/\bNOT\s+VALID\b/gi) ?? []).length;
  if (checks < TABLES.length * 3) problems.push(`adds ${checks} CHECK constraints, expected at least 12`);
  if (notValid < checks) problems.push(`adds ${checks} CHECKs but only ${notValid} NOT VALID`);
  if (/\bVALIDATE\s+CONSTRAINT\b/i.test(code)) problems.push('validates a constraint (D-L65: a later file)');
  if (/\bCREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\b/i.test(code)) problems.push('creates a table');
  if (/\bCREATE\s+ROLE\b|\bCREATE\s+USER\b/i.test(code)) problems.push('creates a role');
  if (/\bCREATE\s+EXTENSION\b/i.test(code)) problems.push('creates an extension');
  if (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(code)) problems.push('creates an index (D-P33)');
  if (/\bSECURITY\s+DEFINER\b/i.test(code)) problems.push('adds a SECURITY DEFINER');
  if (/\bLEAKPROOF\b/i.test(code.replace(/\bproleakproof\b/gi, ' '))) problems.push('marks something LEAKPROOF');
  if (/\b(?:ALTER|DROP)\s+POLICY\b/i.test(code)) problems.push('alters or drops a policy');
  const policies = code.match(/\bCREATE\s+POLICY\s+\S+\s+ON\s+(?:"?public"?\.)?"?(\w+)"?/gi) ?? [];
  const onFieldDef = policies.filter((statement) => /\bfield_def\b/i.test(statement));
  if (policies.length !== 1 || onFieldDef.length !== 1) {
    problems.push(`creates ${policies.length} policies (${policies.join('; ')}), expected exactly one, on field_def`);
  }
  if (/\b(?:DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i.test(code)) problems.push('weakens row level security');
  return problems;
}

// ---------------------------------------------------------------------------
// Probing (the pipeline-tables approach, restated).
// ---------------------------------------------------------------------------

type Query = <R extends QueryResultRow>(sql: string, values?: unknown[]) => Promise<R[]>;

type Outcome =
  | { accepted: true; rows: number }
  | { accepted: false; code: string; message: string };

function outcomeOf(error: unknown): Outcome {
  const { code, message } = error as { code?: unknown; message?: unknown };
  return {
    accepted: false,
    code: typeof code === 'string' ? code : '?',
    message: typeof message === 'string' ? message : String(error),
  };
}

/** One statement under a savepoint, always rolled back to it. */
async function probe(query: Query, sql: string, values: unknown[] = []): Promise<Outcome> {
  await query('SAVEPOINT t0089_probe');
  let outcome: Outcome;
  try {
    const rows = (await query(sql, values)).length;
    outcome = { accepted: true, rows };
  } catch (error) {
    outcome = outcomeOf(error);
  }
  await query('ROLLBACK TO SAVEPOINT t0089_probe');
  return outcome;
}

/** A name for every outcome; a missing column is printed verbatim (the honest failure on main). */
function verdict(outcome: Outcome): string {
  if (outcome.accepted) return outcome.rows === 0 ? 'matched nothing' : 'accepted';
  const { code, message } = outcome;
  if (code === '23514') return 'check_violation';
  if (code === '23502') return 'not_null_violation';
  if (code === '42501') return 'insufficient_privilege';
  if (code === '23001' || code === 'P0001') return 'refused';
  return `error ${code}: ${message}`;
}

class Rollback<T> {
  constructor(readonly value: T) {}
}

/** withTenantTransaction as kasuwa_app, always rolled back. */
async function asApp<T>(
  pool: Pool,
  tenantId: string,
  userId: string,
  fn: (query: Query) => Promise<T>,
): Promise<T> {
  try {
    await withTenantTransaction(pool, { tenantId, userId }, async (tx) => {
      const query: Query = (text, params) => tx.query(text, params);
      throw new Rollback(await fn(query));
    });
  } catch (signal) {
    if (signal instanceof Rollback) return signal.value as T;
    throw signal;
  }
  throw new Error('unreachable: the callback always throws');
}

/** A plain transaction on `pool`, always rolled back. */
async function rolledBack<T>(pool: Pool, fn: (query: Query) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const query: Query = async (text, params) => (await client.query(text, params)).rows;
    return await fn(query);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** A jsonb text of exactly `bytes` octets in its `::text` form: `{"a__c": "xxx"}`. */
function jsonOfBytes(bytes: number): string {
  const wrapper = '{"a__c": ""}'.length;
  return `{"a__c": "${'x'.repeat(bytes - wrapper)}"}`;
}

const SECURITY_DEFINERS_SQL = `
  SELECT n.nspname || '.' || p.proname AS name
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   ORDER BY 1`;

/** Every function name a CREATE FUNCTION in bootstrap or a migration before 0039 introduces. */
function functionsCreatedBefore0039(): Set<string> {
  const files = [
    BOOTSTRAP_SQL,
    ...readdirSync(MIGRATIONS_DIR)
      .filter((name) => /^\d{4}_.*\.sql$/.test(name) && name < '0039')
      .map((name) => join(MIGRATIONS_DIR, name)),
  ];
  const names = new Set<string>();
  for (const file of files) {
    const code = codeOf(readFileSync(file, 'utf8'));
    for (const match of code.matchAll(
      /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?(\w+)"?\.)?"?(\w+)"?\s*\(/gi,
    )) {
      names.add(`${(match[1] ?? 'public').toLowerCase()}.${String(match[2]).toLowerCase()}`);
    }
  }
  return names;
}

// ===========================================================================

describe('acceptance: custom-field storage, migration 0039 (T-0089)', () => {
  /** kasuwa_app — NOBYPASSRLS. Every assertion about what a session may do. */
  let appPool: Pool;
  /** kasuwa_migrator — owns the schema; plants and observes; never serves. */
  let migrator: Pool;
  /** Ids of the standard object_defs in tenant A, by api name. */
  const objectIds = new Map<string, string>();

  /** A custom field on each standard object, and one on a custom object (S3). */
  const CUSTOM_FIELD: Record<Table, string> = {
    contact: id89('f0000001'),
    account: id89('f0000002'),
    activity: id89('f0000003'),
    deal: id89('f0000004'),
  };
  const WIDGET_OBJECT = id89('f00000a0');
  const WIDGET_FIELD = id89('f00000a1');
  /** T-0089 / D-L142: a contact field whose api_name no other object holds, for the move probes. */
  const MOVER_FIELD = id89('f0000005');

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 2 });
    const objects = await migrator.query<{ id: string; api_name: string }>(
      `SELECT id, api_name FROM object_def WHERE tenant_id = $1 AND NOT is_custom`,
      [TENANT_A],
    );
    for (const row of objects.rows) objectIds.set(row.api_name, row.id);
    for (const table of TABLES) {
      await migrator.query(
        `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification, is_custom, config)
         VALUES ($1, $2, $3, 'probe__c', 'T-0089 probe', 'text', 'none', true, '{}'::jsonb)`,
        [CUSTOM_FIELD[table], TENANT_A, must(objectIds.get(table), `tenant A has no ${table} object_def`)],
      );
    }
    await migrator.query(
      `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification, is_custom, config)
       VALUES ($1, $2, $3, 'mover__c', 'T-0089 mover', 'text', 'none', true, '{}'::jsonb)`,
      [MOVER_FIELD, TENANT_A, must(objectIds.get('contact'), 'tenant A has no contact object_def')],
    );
    await migrator.query(
      `INSERT INTO object_def (id, tenant_id, api_name, label, plural_label, is_custom)
       VALUES ($1, $2, 'widget', 'Widget', 'Widgets', true)`,
      [WIDGET_OBJECT, TENANT_A],
    );
    await migrator.query(
      `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification, is_custom, config)
       VALUES ($1, $2, $3, 'colour', 'T-0089 widget colour', 'text', 'none', true, '{}'::jsonb)`,
      [WIDGET_FIELD, TENANT_A, WIDGET_OBJECT],
    );
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await migrator?.end();
    await reseed(inject('migrationUrl'));
  });

  // -------------------------------------------------------------------------
  // M. The migration
  // -------------------------------------------------------------------------
  describe('M: the migration file', () => {
    it('exists as exactly one 0039_*.sql and the runner applied it', async () => {
      const file = require0039();
      const applied = await migrator.query<{ id: string }>(
        `SELECT id FROM _kasuwa_migration WHERE id LIKE '0039\\_%' ORDER BY id`,
      );
      expect(applied.rows.map((row) => `${row.id}.sql`)).toEqual([file.name]);
    });

    it('adds custom to the four tables, every CHECK NOT VALID, nothing validated, no table, role, index, definer, LEAKPROOF mark or policy change but one field_def policy', () => {
      expect(migrationProblems(require0039().sql)).toEqual([]);
    });

    it('(self-check) the file scan accepts a conforming migration and names each fault it is shown', () => {
      const add = (table: string) =>
        `ALTER TABLE ${table} ADD COLUMN custom jsonb NOT NULL DEFAULT '{}'::jsonb,
           ADD CONSTRAINT ${table}_custom_object CHECK (jsonb_typeof(custom) = 'object') NOT VALID,
           ADD CONSTRAINT ${table}_custom_size CHECK (octet_length(custom::text) <= 524288) NOT VALID,
           ADD CONSTRAINT ${table}_custom_keys CHECK (true) NOT VALID;`;
      const good = [
        ...TABLES.map(add),
        `-- CREATE INDEX nothing_here ON contact (custom); a comment says LEAKPROOF`,
        `ALTER TABLE field_def ADD COLUMN retired_at timestamptz;`,
        `CREATE POLICY field_def_custom_retire_only ON field_def AS RESTRICTIVE FOR DELETE USING (true);`,
        `SELECT 1 FROM pg_proc WHERE NOT proleakproof;`,
      ].join('\n');
      expect(migrationProblems(good)).toEqual([]);
      const faults: [string, string, RegExp][] = [
        ['missing table', good.replace(/ALTER TABLE deal ADD COLUMN custom/, 'ALTER TABLE deal ADD COLUMN other'), /deal/],
        ['validated', `${good}\nALTER TABLE deal VALIDATE CONSTRAINT deal_custom_keys;`, /validates/],
        ['a check without NOT VALID', good.replace(/CHECK \(true\) NOT VALID;/, 'CHECK (true);'), /NOT VALID/],
        ['a GIN index', `${good}\nCREATE INDEX contact_custom_gin ON contact USING gin (custom);`, /index/],
        ['a definer', `${good}\nCREATE FUNCTION app.x() RETURNS int SECURITY DEFINER AS 'select 1' LANGUAGE sql;`, /DEFINER/],
        ['a mark', `${good}\nALTER FUNCTION pg_catalog.jsonb_object_field_text(jsonb, text) LEAKPROOF;`, /LEAKPROOF/],
        ['a dropped policy', `${good}\nDROP POLICY contact_isolation ON contact;`, /policy/],
        ['a second policy', `${good}\nCREATE POLICY contact_x ON contact USING (true);`, /policies/],
        ['a table', `${good}\nCREATE TABLE custom_field_value (id uuid);`, /table/],
      ];
      for (const [label, sql, expected] of faults) {
        expect(migrationProblems(sql).join('\n'), label).toMatch(expected);
      }
    });
  });

  // -------------------------------------------------------------------------
  // C. Columns
  // -------------------------------------------------------------------------
  describe('C: columns', () => {
    it.each(TABLES)('%s.custom is jsonb NOT NULL DEFAULT {}', async (table) => {
      const rows = await migrator.query<{ type: string; nullable: string; default: string | null }>(
        `SELECT data_type AS type, is_nullable AS nullable, column_default AS default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'custom'`,
        [table],
      );
      expect(rows.rows, `${table} has no custom column`).toHaveLength(1);
      expect(rows.rows[0]?.type).toBe('jsonb');
      expect(rows.rows[0]?.nullable).toBe('NO');
      expect(String(rows.rows[0]?.default).replace(/\s+/g, '')).toBe("'{}'::jsonb");
    });

    it.each(TABLES)('%s: every existing row reads {} and a row inserted without custom gets {}', async (table) => {
      const counts = await migrator.query<{ total: string; empty: string }>(
        `SELECT count(*) AS total, count(*) FILTER (WHERE custom = '{}'::jsonb) AS empty FROM ${table}`,
      );
      // Not vacuous: the seed holds rows of all four.
      expect(Number(counts.rows[0]?.total)).toBeGreaterThan(0);
      expect(counts.rows[0]?.empty).toBe(counts.rows[0]?.total);
    });

    it.each(TABLES)('%s: kasuwa_app cannot set custom to SQL NULL', async (table) => {
      const outcome = await asApp(appPool, TENANT_A, USER_A_SUPERVISOR, async (query) =>
        verdict(await probe(query, `UPDATE ${table} SET custom = NULL WHERE id = $1 RETURNING id`, [ROW_A1[table]])),
      );
      expect(outcome).toBe('not_null_violation');
    });

    it('field_def.retired_at is timestamptz NULL with no default', async () => {
      const rows = await migrator.query<{ type: string; nullable: string; default: string | null }>(
        `SELECT data_type AS type, is_nullable AS nullable, column_default AS default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'field_def' AND column_name = 'retired_at'`,
      );
      expect(rows.rows, 'field_def has no retired_at').toHaveLength(1);
      expect(rows.rows[0]).toEqual({ type: 'timestamp with time zone', nullable: 'YES', default: null });
      const live = await migrator.query<{ n: string }>(
        'SELECT count(*) AS n FROM field_def WHERE retired_at IS NOT NULL',
      );
      expect(Number(live.rows[0]?.n), 'the migration retired existing fields').toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // K. The three CHECKs
  // -------------------------------------------------------------------------
  describe('K: the database guards refuse what no code path may store', () => {
    const NOT_OBJECTS = ['[]', '"text"', '42', 'true', 'null', '[{"tier__c": "gold"}]'];
    const BAD_KEYS = [
      'status',
      'tier',
      'Tier__c',
      'tier__C',
      'TIER__C',
      '1tier__c',
      '_tier__c',
      'ti er__c',
      'tier-x__c',
      'tier__c ',
      ' tier__c',
      'tier__cx',
      'tier_c',
      '__c',
      'tír__c',
      'tier__c\n',
      'ti\ner__c',
      '',
    ];
    const GOOD = [
      '{}',
      '{"tier__c": "gold"}',
      '{"a__c": 1, "b_2__c": true, "very_long_name_9__c": null}',
      // Keys INSIDE a value are not checked: a currency value has its own keys.
      '{"price__c": {"amountMinor": "150000", "currency": "NGN"}}',
    ];

    it.each(TABLES)('%s: as kasuwa_app, a non-object, an over-size object and every malformed top-level key are refused; good objects pass', async (table) => {
      const results = await asApp(appPool, TENANT_A, USER_A_SUPERVISOR, async (query) => {
        const set = async (json: string) =>
          verdict(
            await probe(query, `UPDATE ${table} SET custom = $2::jsonb WHERE id = $1 RETURNING id`, [
              ROW_A1[table],
              json,
            ]),
          );
        const out: Record<string, string> = {};
        for (const json of NOT_OBJECTS) out[`not an object ${json}`] = await set(json);
        for (const key of BAD_KEYS) out[`key ${JSON.stringify(key)}`] = await set(JSON.stringify({ [key]: 'x' }));
        out['a bad key beside a good one'] = await set(JSON.stringify({ tier__c: 'gold', status: 'x' }));
        out[`exactly ${LIMIT_BYTES} bytes`] = await set(jsonOfBytes(LIMIT_BYTES));
        out[`${LIMIT_BYTES + 1} bytes`] = await set(jsonOfBytes(LIMIT_BYTES + 1));
        out['32769 bytes (the old 32 KiB boundary)'] = await set(jsonOfBytes(32769));
        // Bytes, not characters: 174,763 three-byte characters are 524,289 octets
        // (with the 12-octet wrapper, 524,301 octets in 174,775 characters).
        out['524,301 octets in 174,775 characters'] = await set(`{"a__c": "${'€'.repeat(174763)}"}`);
        for (const json of GOOD) out[`good ${json}`] = await set(json);
        return out;
      });
      const expected: Record<string, string> = {};
      for (const json of NOT_OBJECTS) expected[`not an object ${json}`] = 'check_violation';
      for (const key of BAD_KEYS) expected[`key ${JSON.stringify(key)}`] = 'check_violation';
      expected['a bad key beside a good one'] = 'check_violation';
      expected[`exactly ${LIMIT_BYTES} bytes`] = 'accepted';
      expected[`${LIMIT_BYTES + 1} bytes`] = 'check_violation';
      expected['524,301 octets in 174,775 characters'] = 'check_violation';
      // And the old 32 KiB boundary no longer refuses (D-L142): 32769 octets are stored.
      expected['32769 bytes (the old 32 KiB boundary)'] = 'accepted';
      for (const json of GOOD) expected[`good ${json}`] = 'accepted';
      expect(results).toEqual(expected);
    });

    it('(self-check) jsonOfBytes builds exactly the octet length it is asked for', async () => {
      // Checked against Postgres itself, so the boundary above is the real one.
      for (const bytes of [12, 100, LIMIT_BYTES, LIMIT_BYTES + 1]) {
        const row = await migrator.query<{ n: number }>('SELECT octet_length($1::jsonb::text) AS n', [
          jsonOfBytes(bytes),
        ]);
        expect(row.rows[0]?.n, `jsonOfBytes(${bytes})`).toBe(bytes);
      }
    });

    it.each(TABLES)('%s: the guards bind kasuwa_migrator too (BYPASSRLS skips policies, not CHECKs), on INSERT as on UPDATE', async (table) => {
      const results = await rolledBack(migrator, async (query) => {
        // Insertable columns only: 0038's search columns are GENERATED.
        const columns = (
          await query<{ quoted: string }>(
            `SELECT quote_ident(attname) AS quoted FROM pg_attribute
              WHERE attrelid = to_regclass('public.' || $1::text) AND attnum > 0
                AND NOT attisdropped AND attgenerated = ''
              ORDER BY attnum`,
            [table],
          )
        ).map((row) => row.quoted);
        const list = columns.join(', ');
        return {
          update: verdict(
            await probe(query, `UPDATE ${table} SET custom = '{"status": "x"}'::jsonb WHERE id = $1 RETURNING id`, [
              ROW_A1[table],
            ]),
          ),
          // A copy of the row with a fresh id and an array for custom. A CHECK
          // is evaluated before any unique index, so a copied unique value
          // cannot mask the verdict.
          insert: verdict(
            await probe(
              query,
              `INSERT INTO ${table} (${list})
               SELECT ${columns.map((c) => `r.${c}`).join(', ')}
                 FROM ${table} s,
                      LATERAL jsonb_populate_record(NULL::${table},
                        to_jsonb(s) || jsonb_build_object('id', gen_random_uuid(), 'custom', '[]'::jsonb)) AS r
                WHERE s.id = $1 RETURNING id`,
              [ROW_A1[table]],
            ),
          ),
        };
      });
      expect(results).toEqual({ update: 'check_violation', insert: 'check_violation' });
    });
  });

  // -------------------------------------------------------------------------
  // G. Grants
  // -------------------------------------------------------------------------
  describe('G: grants', () => {
    it('kasuwa_app may SELECT, INSERT and UPDATE custom on all four tables', async () => {
      const rows = await migrator.query<{ t: string; s: boolean; i: boolean; u: boolean }>(
        `SELECT t,
                has_column_privilege('kasuwa_app', 'public.' || t, 'custom', 'SELECT') AS s,
                has_column_privilege('kasuwa_app', 'public.' || t, 'custom', 'INSERT') AS i,
                has_column_privilege('kasuwa_app', 'public.' || t, 'custom', 'UPDATE') AS u
           FROM unnest($1::text[]) AS t ORDER BY t`,
        [[...TABLES]],
      );
      expect(rows.rows).toEqual(
        [...TABLES].sort().map((t) => ({ t, s: true, i: true, u: true })),
      );
    });

    it('activity and deal keep column privileges: kasuwa_app gains UPDATE (custom), never table-level UPDATE', async () => {
      const rows = await migrator.query<{ t: string; table_update: boolean; custom_update: boolean }>(
        `SELECT t,
                has_table_privilege('kasuwa_app', 'public.' || t, 'UPDATE') AS table_update,
                has_column_privilege('kasuwa_app', 'public.' || t, 'custom', 'UPDATE') AS custom_update
           FROM unnest(ARRAY['activity', 'deal']) AS t ORDER BY t`,
      );
      expect(rows.rows).toEqual([
        { t: 'activity', table_update: false, custom_update: true },
        { t: 'deal', table_update: false, custom_update: true },
      ]);
    });

    it.each(TABLES)('%s: kasuwa_app really writes custom in its own programme (the grant is live)', async (table) => {
      const written = await asApp(appPool, TENANT_A, USER_A_AGENT_1, async (query) => {
        const rows = await query<{ custom: Json }>(
          `UPDATE ${table} SET custom = '{"probe__c": "ok"}'::jsonb WHERE id = $1 RETURNING custom`,
          [ROW_A1[table]],
        );
        return rows.map((row) => row.custom);
      });
      expect(written).toEqual([{ probe__c: 'ok' }]);
    });
  });

  // -------------------------------------------------------------------------
  // F. field_def: retire instead of delete; the type is frozen
  // -------------------------------------------------------------------------
  describe('F: field_def lifecycle guards', () => {
    it.each(TABLES)('a custom field of %s cannot be deleted by kasuwa_app, tenant admin included: nothing matches and the row stays', async (table) => {
      const outcome = await asApp(appPool, TENANT_A, USER_A_SUPERVISOR, async (query) => ({
        // The control: the session sees the row, so a refusal is the policy.
        visible: (await query('SELECT 1 FROM field_def WHERE id = $1', [CUSTOM_FIELD[table]])).length,
        retiredAtExists: (
          await query(
            `SELECT 1 FROM information_schema.columns
              WHERE table_name = 'field_def' AND column_name = 'retired_at'`,
          )
        ).length,
        delete: verdict(
          await probe(query, 'DELETE FROM field_def WHERE id = $1 RETURNING id', [CUSTOM_FIELD[table]]),
        ),
      }));
      // On main the DELETE succeeds; retired_at is the reason this file exists at all.
      expect(outcome).toEqual({ visible: 1, retiredAtExists: 1, delete: 'matched nothing' });
    });

    it('(S3) a custom field of a CUSTOM object is still deletable by kasuwa_app (the policy is not a blanket ban)', async () => {
      const outcome = await asApp(appPool, TENANT_A, USER_A_SUPERVISOR, async (query) => ({
        retiredAtExists: (
          await query(
            `SELECT 1 FROM information_schema.columns
              WHERE table_name = 'field_def' AND column_name = 'retired_at'`,
          )
        ).length,
        delete: verdict(await probe(query, 'DELETE FROM field_def WHERE id = $1 RETURNING id', [WIDGET_FIELD])),
      }));
      expect(outcome).toEqual({ retiredAtExists: 1, delete: 'accepted' });
    });

    it('a restrictive DELETE policy on field_def exists beyond 0025’s standard-only one', async () => {
      const rows = await migrator.query<{ name: string; using: string }>(
        `SELECT polname AS name, pg_get_expr(polqual, polrelid) AS using
           FROM pg_policy
          WHERE polrelid = 'public.field_def'::regclass AND polcmd = 'd' AND NOT polpermissive
          ORDER BY polname`,
      );
      const others = rows.rows.filter((row) => row.name !== 'field_def_delete_custom_only');
      expect(others.length, `restrictive DELETE policies: ${JSON.stringify(rows.rows)}`).toBe(1);
      expect(others[0]?.using, 'the new policy names the tenant').toContain('current_tenant_id()');
    });

    it('(guard) kasuwa_migrator can still delete a custom field of a standard object (offboarding is untouched)', async () => {
      // Passes on main by design: it protects the offboarding cascade from a
      // guard written as a trigger (which would bind the migrator) instead of
      // a restrictive policy.
      const outcome = await rolledBack(migrator, async (query) =>
        verdict(await probe(query, 'DELETE FROM field_def WHERE id = $1 RETURNING id', [CUSTOM_FIELD.contact])),
      );
      expect(outcome).toBe('accepted');
    });

    // -----------------------------------------------------------------------
    // T-0089 / D-L142 (lead edit): the migration-review fixes to 0039.
    // -----------------------------------------------------------------------

    /** One statement under a savepoint that is KEPT when it succeeds (the next step builds on it). */
    async function step(query: Query, sql: string, values: unknown[] = []): Promise<Outcome> {
      await query('SAVEPOINT t0089_step');
      try {
        const rows = (await query(sql, values)).length;
        await query('RELEASE SAVEPOINT t0089_step');
        return { accepted: true, rows };
      } catch (error) {
        await query('ROLLBACK TO SAVEPOINT t0089_step');
        return outcomeOf(error);
      }
    }
    const REFUSALS = ['insufficient_privilege', 'refused', 'check_violation'];

    it('(D-L142) a custom field moved to a CUSTOM object cannot then be deleted there: the move is refused for kasuwa_app and kasuwa_migrator alike', async () => {
      const app = await asApp(appPool, TENANT_A, USER_A_SUPERVISOR, async (query) => {
        const move = verdict(
          await step(query, 'UPDATE field_def SET object_id = $2 WHERE id = $1 RETURNING id', [MOVER_FIELD, WIDGET_OBJECT]),
        );
        const del = verdict(await probe(query, 'DELETE FROM field_def WHERE id = $1 RETURNING id', [MOVER_FIELD]));
        const where = (await query<{ object_id: string }>('SELECT object_id FROM field_def WHERE id = $1', [MOVER_FIELD]))
          .map((row) => row.object_id);
        return { move, del, where };
      });
      expect(REFUSALS, `kasuwa_app's move was ${app.move}`).toContain(app.move);
      // Had the move landed, the field would sit on a custom object, where 0039 lets kasuwa_app delete it.
      expect({ del: app.del, where: app.where }).toEqual({
        del: 'matched nothing',
        where: [must(objectIds.get('contact'), 'contact object')],
      });
      // Every role: the migrator cannot move it either.
      const migratorMove = await rolledBack(migrator, async (query) =>
        verdict(await probe(query, 'UPDATE field_def SET object_id = $2 WHERE id = $1 RETURNING id', [MOVER_FIELD, WIDGET_OBJECT])),
      );
      expect(REFUSALS, `kasuwa_migrator's move was ${migratorMove}`).toContain(migratorMove);
    });

    it('(D-L142) a custom field moved to ANOTHER standard object cannot free its api_name for re-creation: the move is refused for every role and the name stays taken', async () => {
      const accountObject = must(objectIds.get('account'), 'account object');
      const contactObject = must(objectIds.get('contact'), 'contact object');
      const recreate = `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification, is_custom, config)
                        VALUES ($1, $2, $3, 'mover__c', 'T-0089 impostor', 'text', 'none', true, '{}'::jsonb) RETURNING id`;
      const app = await asApp(appPool, TENANT_A, USER_A_SUPERVISOR, async (query) => {
        const move = verdict(
          await step(query, 'UPDATE field_def SET object_id = $2 WHERE id = $1 RETURNING id', [MOVER_FIELD, accountObject]),
        );
        const again = await probe(query, recreate, [id89('f0000006'), TENANT_A, contactObject]);
        return { move, again: again.accepted ? 'accepted' : again.code };
      });
      expect(REFUSALS, `kasuwa_app's move was ${app.move}`).toContain(app.move);
      // The original still holds the name on contact: a re-creation is the unique violation.
      expect(app.again, 'the api_name was re-created on contact').toBe('23505');
      const migratorRun = await rolledBack(migrator, async (query) => {
        const move = verdict(
          await step(query, 'UPDATE field_def SET object_id = $2 WHERE id = $1 RETURNING id', [MOVER_FIELD, accountObject]),
        );
        const again = await probe(query, recreate, [id89('f0000006'), TENANT_A, contactObject]);
        return { move, again: again.accepted ? 'accepted' : again.code };
      });
      expect(REFUSALS, `kasuwa_migrator's move was ${migratorRun.move}`).toContain(migratorRun.move);
      expect(migratorRun.again).toBe('23505');
    });

    it('(D-L142) the new restrictive DELETE policy is written positively: EXISTS (... is_custom), never NOT EXISTS, so it fails closed', async () => {
      const rows = await migrator.query<{ name: string; using: string }>(
        `SELECT polname AS name, pg_get_expr(polqual, polrelid) AS using
           FROM pg_policy
          WHERE polrelid = 'public.field_def'::regclass AND polcmd = 'd' AND NOT polpermissive
            AND polname <> 'field_def_delete_custom_only'`,
      );
      expect(rows.rows, 'no restrictive DELETE policy beyond 0025’s').toHaveLength(1);
      const using = String(rows.rows[0]?.using);
      expect(using).toMatch(/\bEXISTS\b/);
      expect(using, 'the policy is a NOT EXISTS (fails open when the object row is unseen)').not.toMatch(/\bNOT\s+EXISTS\b/i);
      expect(using).toMatch(/\bis_custom\b/);
      expect(using, 'the policy tests NOT is_custom').not.toMatch(/\bNOT\s+\(*\s*(?:\w+\.)?is_custom\b/i);
      expect(using).toContain('current_tenant_id()');
    });

    it('(D-L142) CHECK (retired_at IS NULL OR is_custom): a standard field cannot be retired, by kasuwa_migrator or kasuwa_app', async () => {
      const defs = await migrator.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'public.field_def'::regclass AND contype = 'c'`,
      );
      expect(
        defs.rows.map((row) => row.def).filter((def) => /retired_at IS NULL\)? OR (?:\(?\w+\.)?is_custom/.test(def)),
        `field_def CHECKs: ${JSON.stringify(defs.rows)}`,
      ).toHaveLength(1);
      const standard = must(
        (
          await migrator.query<{ id: string }>(
            `SELECT id FROM field_def WHERE tenant_id = $1 AND object_id = $2 AND NOT is_custom ORDER BY api_name LIMIT 1`,
            [TENANT_A, must(objectIds.get('contact'), 'contact object')],
          )
        ).rows[0]?.id,
        'a standard contact field',
      );
      const byMigrator = await rolledBack(migrator, async (query) =>
        verdict(await probe(query, 'UPDATE field_def SET retired_at = now() WHERE id = $1 RETURNING id', [standard])),
      );
      expect(byMigrator, 'the CHECK binds the migrator').toBe('check_violation');
      const byApp = await asApp(appPool, TENANT_A, USER_A_SUPERVISOR, async (query) =>
        verdict(await probe(query, 'UPDATE field_def SET retired_at = now() WHERE id = $1 RETURNING id', [standard])),
      );
      expect(REFUSALS, `kasuwa_app retiring a standard field was ${byApp}`).toContain(byApp);
    });

    it('(D-L142) kasuwa_app cannot un-retire a custom field: retired_at never goes back to NULL', async () => {
      const outcome = await asApp(appPool, TENANT_A, USER_A_SUPERVISOR, async (query) => ({
        // The control: retiring is allowed (and kept for the next step).
        retire: verdict(await step(query, 'UPDATE field_def SET retired_at = now() WHERE id = $1 RETURNING id', [CUSTOM_FIELD.contact])),
        unretire: verdict(await probe(query, 'UPDATE field_def SET retired_at = NULL WHERE id = $1 RETURNING id', [CUSTOM_FIELD.contact])),
      }));
      expect(outcome.retire).toBe('accepted');
      expect(REFUSALS, `un-retiring was ${outcome.unretire}`).toContain(outcome.unretire);
    });

    it.each(TABLES)('a custom field of %s: kasuwa_app cannot change its type; label, description, classification both ways, config and retired_at stay writable', async (table) => {
      const id = CUSTOM_FIELD[table];
      const outcome = await asApp(appPool, TENANT_A, USER_A_SUPERVISOR, async (query) => {
        const run = async (set: string) =>
          verdict(await probe(query, `UPDATE field_def SET ${set} WHERE id = $1 RETURNING id`, [id]));
        return {
          'type text -> number': await run(`type = 'number'`),
          'type text -> picklist': await run(`type = 'picklist', config = '{"values": [{"value": "a", "label": "A"}]}'::jsonb`),
          label: await run(`label = 'T-0089 relabelled'`),
          description: await run(`description = 'T-0089 described'`),
          'classification raised': await run(`classification = 'sensitive'`),
          'classification lowered': await (async () => {
            await query(`UPDATE field_def SET classification = 'pii' WHERE id = $1`, [id]);
            return run(`classification = 'none'`);
          })(),
          config: await run(`config = '{"note": "T-0089"}'::jsonb`),
          retired_at: await run('retired_at = now()'),
        };
      });
      const refusals = ['insufficient_privilege', 'refused', 'check_violation'];
      expect(refusals, `type text -> number was ${outcome['type text -> number']}`).toContain(outcome['type text -> number']);
      expect(refusals, `type text -> picklist was ${outcome['type text -> picklist']}`).toContain(
        outcome['type text -> picklist'],
      );
      expect({
        label: outcome.label,
        description: outcome.description,
        'classification raised': outcome['classification raised'],
        'classification lowered': outcome['classification lowered'],
        config: outcome.config,
        retired_at: outcome.retired_at,
      }).toEqual({
        label: 'accepted',
        description: 'accepted',
        'classification raised': 'accepted',
        'classification lowered': 'accepted',
        config: 'accepted',
        retired_at: 'accepted',
      });
    });
  });

  // -------------------------------------------------------------------------
  // T. Tenancy unchanged
  // -------------------------------------------------------------------------
  describe('T: tenancy is unchanged', () => {
    it.each([...TABLES, 'field_def'])(
      '(guard) %s: RLS ENABLED and FORCED; a policy with WITH CHECK = USING; record tables name tenant and programme',
      async (table) => {
        // Passes on main by design: ADR-0016 item 10 says these do not change.
        const state = await migrator.query<{ enabled: boolean; forced: boolean }>(
          `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
             FROM pg_class WHERE oid = to_regclass('public.' || $1::text)`,
          [table],
        );
        expect(state.rows[0]).toEqual({ enabled: true, forced: true });
        const policies = await migrator.query<{ permissive: boolean; using: string | null; check: string | null }>(
          `SELECT polpermissive AS permissive, pg_get_expr(polqual, polrelid) AS using,
                  pg_get_expr(polwithcheck, polrelid) AS check
             FROM pg_policy WHERE polrelid = to_regclass('public.' || $1::text)`,
          [table],
        );
        expect(policies.rows.some((p) => p.check !== null && p.check === p.using)).toBe(true);
        for (const policy of policies.rows.filter((p) => p.permissive)) {
          for (const expression of [policy.using, policy.check]) {
            if (expression === null) continue;
            expect(expression).toContain('current_tenant_id()');
            if (table !== 'field_def') expect(expression).toContain('current_programme_ids()');
          }
        }
      },
    );

    it('(guard) the four tables are still in TENANT_SCOPED_TABLES', () => {
      expect(TABLES.filter((t) => !(TENANT_SCOPED_TABLES as readonly string[]).includes(t))).toEqual([]);
    });

    it('an A1 session can neither read nor write another programme’s custom, even naming the id', async () => {
      const outcome = await asApp(appPool, TENANT_A, USER_A_AGENT_1, async (query) => ({
        read: (await query('SELECT custom FROM contact WHERE id = $1', [CONTACT_A2])).length,
        update: verdict(
          await probe(query, `UPDATE contact SET custom = '{"probe__c": "x"}'::jsonb WHERE id = $1 RETURNING id`, [
            CONTACT_A2,
          ]),
        ),
        accountUpdate: verdict(
          await probe(query, `UPDATE account SET custom = '{"probe__c": "x"}'::jsonb WHERE id = $1 RETURNING id`, [
            ACCOUNT_A2,
          ]),
        ),
      }));
      expect(outcome).toEqual({ read: 0, update: 'matched nothing', accountUpdate: 'matched nothing' });
      const stored = await migrator.query<{ custom: Json }>('SELECT custom FROM contact WHERE id = $1', [CONTACT_A2]);
      expect(stored.rows[0]?.custom).toEqual({});
    });

    it('(guard) the SECURITY DEFINER census is still the two CLAUDE.md 2.7 names', async () => {
      const rows = await migrator.query<{ name: string }>(SECURITY_DEFINERS_SQL);
      expect(rows.rows.map((row) => row.name)).toEqual(['app.resolve_session', 'app.resolve_tenant_by_slug']);
    });

    it('(guard, S6) no new function: every app and public function was created before 0039', async () => {
      const known = functionsCreatedBefore0039();
      // Not vacuous: the app schema has dozens of functions.
      expect(known.size).toBeGreaterThan(10);
      const rows = await migrator.query<{ name: string }>(
        `SELECT n.nspname || '.' || p.proname AS name
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname IN ('app', 'public')
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
          ORDER BY 1`,
      );
      expect(rows.rows.map((row) => row.name).filter((name) => !known.has(name))).toEqual([]);
    });

    it('(guard) no new table or role: 0039 creates none, and the kasuwa roles are bootstrap’s', async () => {
      const bootstrap = codeOf(readFileSync(BOOTSTRAP_SQL, 'utf8'));
      const declared = new Set(
        [...bootstrap.matchAll(/\bCREATE\s+ROLE\s+"?(\w+)"?/gi)].map((m) => String(m[1]).toLowerCase()),
      );
      // Some roles are created inside DO blocks, as format() strings.
      for (const m of bootstrap.matchAll(/'(kasuwa_\w+)'/g)) declared.add(String(m[1]).toLowerCase());
      const roles = await migrator.query<{ name: string }>(
        `SELECT rolname AS name FROM pg_roles WHERE rolname LIKE 'kasuwa%' ORDER BY 1`,
      );
      expect(roles.rows.length).toBeGreaterThan(2);
      expect(roles.rows.map((r) => r.name).filter((name) => !declared.has(name))).toEqual([]);
      const file = migration0039();
      if (file !== null) {
        expect(codeOf(file.sql)).not.toMatch(/\bCREATE\s+(?:ROLE|USER|TABLE)\b/i);
      }
    });
  });

  // -------------------------------------------------------------------------
  // I. Indexes (D-P33)
  // -------------------------------------------------------------------------
  describe('I: no index on custom', () => {
    it('no index on the four tables mentions custom, by key, expression or predicate, and none is GIN', async () => {
      const columns = await migrator.query<{ n: string }>(
        `SELECT count(*) AS n FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'custom' AND table_name = ANY ($1::text[])`,
        [[...TABLES]],
      );
      // Without the column this check would be vacuous: require it first.
      expect(Number(columns.rows[0]?.n), 'the custom column is missing').toBe(4);
      const rows = await migrator.query<{ index: string; def: string; am: string }>(
        `SELECT i.indexrelid::regclass::text AS index, pg_get_indexdef(i.indexrelid) AS def, am.amname AS am
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_am am ON am.oid = c.relam
          WHERE i.indrelid = ANY (ARRAY['contact', 'account', 'activity', 'deal']::regclass[])`,
      );
      expect(rows.rows.length).toBeGreaterThan(4);
      const offenders = rows.rows.filter((row) => /\bcustom\b/i.test(row.def) || row.am === 'gin');
      expect(offenders).toEqual([]);
    });

    it('(guard) nothing was marked LEAKPROOF: the set is exactly template1’s', async () => {
      const census = `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p WHERE p.proleakproof ORDER BY 1`;
      const here = await migrator.query<{ fn: string }>(census);
      const url = new URL(inject('migrationUrl'));
      url.pathname = '/template1';
      const pristine = createPool({ connectionString: url.toString(), max: 1 });
      try {
        const baseline = await pristine.query<{ fn: string }>(census);
        expect(baseline.rows.length).toBeGreaterThan(100);
        expect(here.rows.map((r) => r.fn)).toEqual(baseline.rows.map((r) => r.fn));
      } finally {
        await pristine.end();
      }
    });
  });

  // -------------------------------------------------------------------------
  // D. Drizzle
  // -------------------------------------------------------------------------
  describe('D: the Drizzle schema follows the migration', () => {
    it('schema.ts declares custom on contact, account, activity and deal, and retired_at on fieldDef', () => {
      expect(existsSync(SCHEMA_TS)).toBe(true);
      const source = readFileSync(SCHEMA_TS, 'utf8');
      const block = (name: string) => {
        const start = source.indexOf(`export const ${name} = pgTable(`);
        expect(start, `schema.ts has no ${name} table`).toBeGreaterThanOrEqual(0);
        const next = source.indexOf('export const ', start + 1);
        return source.slice(start, next === -1 ? undefined : next);
      };
      for (const name of ['contact', 'account', 'activity', 'deal']) {
        expect(block(name), `${name}: no jsonb('custom')`).toMatch(/jsonb\(\s*'custom'\s*\)/);
      }
      expect(block('fieldDef'), "fieldDef: no 'retired_at'").toMatch(/'retired_at'/);
    });
  });
});
