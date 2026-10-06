import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  account as accountTable,
  createPool,
  ensureStandardObjectDefs,
  loadMigrations,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  runMigrations,
  SEED_ACCOUNTS,
  SEED_TENANTS,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import type { TenantTx } from '@kasuwa/db';
import { readTableSecurity, reseed, withForcedScope } from '@kasuwa/testing';
import { Client, type Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * ACCEPTANCE — T-0054, account fields (migration only; Agent 3, Agent 1 reviews).
 *
 * Source: team/tasks/T-0054-account-fields.md; the `Account`, `AccountTier` and
 * `Phone` schemas in docs/api/records.openapi.yaml (T-0052), which the columns
 * must serve exactly; D-L65, D-L67, D-L69, D-L73 (derived properties get no
 * field_def), D-P24 (the clash pre-check); the recipe in
 * packages/db/src/standard-object-catalogue.ts; CLAUDE.md 2.3, 2.4, 2.7.
 *
 * Written from the invariants before any implementation (D-L23, D-L25). The
 * model suites are records/contact-fields (T-0040) and
 * metadata/standard-object-metadata (T-0053); helpers are restated here
 * rather than shared, so neither suite can change this one's meaning.
 *
 * ------------------------------------------------------------------------
 * PINNED (the builder must honour these exactly)
 * ------------------------------------------------------------------------
 *
 * 1. MIGRATION. Exactly one `packages/db/migrations/0026_*.sql`, applied by
 *    the runner. 0019 and 0025 are unchanged (checksums). No SECURITY DEFINER
 *    function is added (the census stays at the two CLAUDE.md 2.7 names).
 *    `account` keeps RLS ENABLED and FORCED, every permissive policy scoped on
 *    tenant AND programme, one with WITH CHECK = USING; it stays in
 *    TENANT_SCOPED_TABLES. Any table the change adds meets the same rules.
 *    A following no-transaction file for CONCURRENTLY index builds (D-L65,
 *    the T-0044 runner marker) is allowed; the index pins read the final
 *    catalogue, wherever the index was built.
 *
 * 2. COLUMNS. Exactly the snake_case of every withholdable `Account` property
 *    except the derived `owner` (D-L73): owner_user_id uuid, industry text,
 *    tier (text or an enum type: the builder's), tags text[] NOT NULL DEFAULT
 *    '{}', phones jsonb NOT NULL DEFAULT '[]', state text, lga text,
 *    parent_account_id uuid. Everything except tags and phones is nullable.
 *    - owner_user_id: composite FK (tenant_id, owner_user_id) -> "user".
 *    - parent_account_id: composite FK (tenant_id, programme_id,
 *      parent_account_id) -> account (tenant_id, programme_id, id). A parent
 *      in a sibling programme or another tenant is refused, and so is moving
 *      a parent or a child across programmes once they are linked.
 *    - tier: exactly the contract's `AccountTier` enum, read from the YAML;
 *      P04's labels ("Enterprise", "Mid-market", "SME") are refused.
 *    - tags: no NULL element (as contact_tags_no_null_element_check).
 *    - phones: the database itself refuses anything but an array of objects
 *      with `type` in the contract's enum and `e164` matching the contract's
 *      pattern (read from the YAML). See "PHONES" below for why the database.
 *
 * 3. HIERARCHY. Refused by the database, for kasuwa_app inside a real
 *    `withTenantTransaction` AND for kasuwa_migrator:
 *    - a self-parent;
 *    - a direct (2) and an indirect (3) cycle, by UPDATE;
 *    - a cycle made by ONE statement: a two-row UPDATE that swaps parents, and
 *      a two-row INSERT whose rows name each other;
 *    - a cycle made by TWO CONCURRENT TRANSACTIONS that each add half of it
 *      (see "CONCURRENCY");
 *    - DEPTH: a top-level account is depth 1, and the cap is 5. A chain of
 *      five accounts is accepted; a sixth below it is refused. Re-parenting a
 *      subtree counts the subtree's own height (a two-level subtree may go
 *      under depth 3, not under depth 4). One multi-row INSERT listing a chain
 *      child-first is accepted at five and refused at six: the guard must see
 *      rows the same statement wrote before, not only committed ones.
 *    "Refused" means the statement, or the transaction's deferred checks
 *    (each probe runs SET CONSTRAINTS ALL IMMEDIATE, so a DEFERRABLE
 *    constraint trigger counts), raises SQLSTATE class 23 other than
 *    23502/23503/23505, or P0001 (a plain RAISE). Never 42703 (the column is
 *    missing) and never a stack-depth error: those are not a refusal.
 *
 * 4. METADATA. Every tenant has a STANDARD `field_def` on its standard
 *    `account` object for each of the eight columns, and none called `owner`
 *    (D-L73). Seeded tenants (written by `ensureStandardObjectDefs`), a fresh
 *    tenant given `ensureStandardObjectDefs`, and tenants that pre-date 0026
 *    (written by the migration's backfill) all get the same eight, with the
 *    same label, type, is_required, config and classification.
 *    THE CLASH PRE-CHECK (catalogue recipe step 2, D-P24): when any tenant
 *    already has a CUSTOM field of a new standard name on `account`, 0026
 *    stops before changing anything, with a message naming the object
 *    (`account`), the field (`industry`) and the number of tenants affected.
 *    A custom `industry` on a DIFFERENT object is not a clash and is not
 *    counted: two tenants clash, a third has contact.industry, so the message
 *    says 2 and never 3. Once the clash is removed, 0026 applies.
 *
 * 5. INDEXES. A valid, non-partial index on account whose key columns begin
 *    tenant_id, programme_id, then `name` (or an expression of it: a
 *    collation or folding is the builder's call) and include `id` — the
 *    keyset for listAccounts' default `sort=name`. And a valid owner index:
 *    tenant_id first, owner_user_id second or third.
 *
 * 6. TENANCY. Tenant A cannot write an account owned by a tenant B user, nor
 *    one parented to a tenant B account. A real-but-unreachable parent id is
 *    refused with exactly the same error as an invented one (no existence
 *    oracle across the BPO boundary). RLS still isolates.
 *
 * 7. MIRROR. `account` in packages/db/src/schema.ts carries the eight columns
 *    with the right SQL type and nullability (read from the Drizzle table
 *    object, not by grepping the source).
 *
 * ------------------------------------------------------------------------
 * THE BUILDER'S (not pinned)
 * ------------------------------------------------------------------------
 * How the hierarchy is guarded (BEFORE/AFTER row trigger, statement trigger,
 * constraint trigger, advisory or row locks), its messages, and its ERRCODE
 * within the set above; whether tier is a CHECK or an enum type; how the
 * phones CHECK is written; whether a Phone object may carry extra keys (the
 * contract is closed, but not pinned at the database); field_def types,
 * labels and classification (only that every source agrees); index names
 * and directions; ON DELETE of the new FKs (D-L61 leaves it open: NO ACTION,
 * as 0019, is the safe default); any index on parent_account_id; whether the
 * database also enforces D-L67 (owner in the account's programme). It may;
 * this suite does not ask it to, so T-0055 must check it in the repository.
 *
 * ------------------------------------------------------------------------
 * WHY THE DEPTH CAP IS 5
 * ------------------------------------------------------------------------
 * PRD M03 says "Account hierarchies" (P0) and nothing about depth; neither
 * does the founding pack or the P04 export. Five covers group -> subsidiary
 * -> region -> branch -> outlet, the deepest shape a Nigerian distributor or
 * bank customer plausibly needs, and it bounds the work of every chain walk
 * (this trigger, and T-0055's reads) to five rows. Raising it later is a new
 * migration plus a lead edit of this suite; lowering it would strand data.
 *
 * ------------------------------------------------------------------------
 * PHONES: why the database checks E.164
 * ------------------------------------------------------------------------
 * contact.phones has NO database check: contact enforces E.164 in the API
 * (packages/domain/core/src/contact/phone.ts and the request schemas). T-0054
 * is a migration-only task, so the database is the only place this task can
 * refuse a non-E.164 number, and an account phone written by an import or a
 * script would otherwise carry a format screen-pop (US-1) cannot match. The
 * shape pinned is the contract's `Phone`: the same shape contact stores.
 *
 * ------------------------------------------------------------------------
 * CONCURRENCY
 * ------------------------------------------------------------------------
 * A trigger that walks the committed chain with a plain SELECT passes every
 * single-session test and still lets two sessions build a cycle: T1 sets
 * R1 -> R2 and T2 sets R2 -> R1, each seeing the other's half uncommitted.
 * The test holds T1 open after its write, starts T2's write, and waits ON
 * STATE (T2's statement has finished, or T2 is blocked on a lock, read from
 * pg_blocking_pids) before committing T1 and then T2. It never sleeps.
 * Whatever the mechanism, the committed result must be R1 -> R2 and R2
 * top-level. A guard that defers its check to COMMIT passes this ordering;
 * two commits at the very same instant are beyond what a deterministic test
 * can stage, and the builder's header should say how that case is closed.
 *
 * ------------------------------------------------------------------------
 * HOW THE BACKFILL AND THE CLASH ARE TESTED
 * ------------------------------------------------------------------------
 * The shared harness migrates an EMPTY database, so 0026's backfill would run
 * over zero tenants and prove nothing. The last block builds a second
 * database in the same container (as the T-0053 suite does): bootstrap,
 * every migration before 0025, three tenants (one with a pre-0026 account
 * row), every migration before 0026 (0025 backfills them), then the clashing
 * custom fields, then the rest of the chain (must fail cleanly), then the
 * clash removed and the chain again (must apply). It connects as the
 * container's superuser only to CREATE and DROP that database.
 *
 * Writes: the shared database is reseeded before and after. Every probe but
 * the concurrency test runs in a transaction that is rolled back.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'packages/db/migrations');
const BOOTSTRAP_SQL = resolve(REPO_ROOT, 'packages/db/sql/bootstrap.sql');
const RECORDS_SPEC = resolve(REPO_ROOT, 'docs/api/records.openapi.yaml');

/** Unique per run, lowercase alphanumeric. */
const RUN = Date.now().toString(36);

/** The pinned cap: a top-level account is depth 1. */
const MAX_DEPTH = 5;

// --- the contract ------------------------------------------------------------

interface SchemaObject {
  properties?: Record<string, SchemaObject>;
  required?: string[];
  enum?: unknown[];
  pattern?: string;
}

function contractSchemas(): Record<string, SchemaObject> {
  const spec = parseYaml(readFileSync(RECORDS_SPEC, 'utf8')) as {
    components?: { schemas?: Record<string, SchemaObject> };
  };
  return spec.components?.schemas ?? {};
}

function schema(name: string): SchemaObject {
  const found = contractSchemas()[name];
  if (found === undefined) throw new Error(`records.openapi.yaml has no ${name} schema`);
  return found;
}

const snake = (wire: string): string =>
  wire.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** Not a field: the list of what was withheld. */
const META_PROPERTY = 'withheldFields';
/** Derived, read-only views of another property; no column, no field_def (D-L73). */
const DERIVED: Readonly<Record<string, string>> = { owner: 'ownerUserId' };

/** Column name for every withholdable, non-derived Account property. */
function accountContractColumns(): string[] {
  const account = schema('Account');
  const properties = Object.keys(account.properties ?? {});
  const required = account.required ?? [];
  return properties
    .filter((name) => name !== META_PROPERTY && !required.includes(name) && !(name in DERIVED))
    .map(snake)
    .sort();
}

function stringEnum(value: SchemaObject | undefined, what: string): string[] {
  const values = value?.enum;
  if (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== 'string')) {
    throw new Error(`records.openapi.yaml: ${what} has no string enum`);
  }
  return values as string[];
}

const tierCodes = (): string[] => stringEnum(schema('AccountTier'), 'AccountTier');
const phoneTypes = (): string[] => stringEnum(schema('Phone').properties?.type, 'Phone.type');

function e164Pattern(): RegExp {
  const pattern = schema('Phone').properties?.e164?.pattern;
  if (typeof pattern !== 'string')
    throw new Error('records.openapi.yaml: Phone.e164 has no pattern');
  return new RegExp(pattern);
}

/**
 * What each contract column must be. `type: null` is the builder's call.
 * If the contract grows a property, the first column test fails until the
 * lead adds it here: the suite and the contract never silently diverge.
 */
const COLUMN_SPEC: Readonly<Record<string, { type: string | null; notNull: boolean }>> = {
  industry: { type: 'text', notNull: false },
  lga: { type: 'text', notNull: false },
  owner_user_id: { type: 'uuid', notNull: false },
  parent_account_id: { type: 'uuid', notNull: false },
  phones: { type: 'jsonb', notNull: true },
  state: { type: 'text', notNull: false },
  tags: { type: 'text[]', notNull: true },
  tier: { type: null, notNull: false },
};
const NEW_COLUMNS = Object.keys(COLUMN_SPEC).sort();

// --- migrations this change must not touch -----------------------------------

const PINNED_CHECKSUMS: Readonly<Record<string, string>> = {
  '0019_contact_fields_and_account':
    'b9e3ed18883fb6f40528c210cfc38850539a2f49b35ee34f65d9280712d5b3b8',
  '0025_standard_object_metadata':
    'c3a26e95ed0d7d4672e31d60809bb6c5e72a62ad75160a5c27bbab94c694c3be',
};

/** The SECURITY DEFINER census, CLAUDE.md 2.7. */
const DEFINERS_SQL = `
  SELECT n.nspname || '.' || p.proname AS name
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   ORDER BY 1`;

const PUBLIC_TABLES_SQL = `
  SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
   ORDER BY 1`;

const COLUMNS_SQL = `
  SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
         a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS default
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE n.nspname = 'public' AND c.relname = 'account'
     AND a.attnum > 0 AND NOT a.attisdropped
   ORDER BY a.attnum`;

/** STANDARD account fields of one tenant, with everything every source must agree on. */
const ACCOUNT_FIELDS_SQL = `
  SELECT f.api_name, f.label, f.type, f.is_required, f.config::text AS config,
         f.classification, f.is_custom
    FROM field_def f
    JOIN object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
   WHERE f.tenant_id = $1 AND o.api_name = 'account' AND NOT o.is_custom AND NOT f.is_custom
   ORDER BY f.api_name`;

interface FieldRow {
  api_name: string;
  label: string;
  type: string;
  is_required: boolean;
  config: string;
  classification: string;
  is_custom: boolean;
}

// --- probing -----------------------------------------------------------------

type Query = <R extends QueryResultRow>(sql: string, values?: unknown[]) => Promise<R[]>;

type Outcome =
  { accepted: true } | { accepted: false; code: string; message: string; detail: string };

function outcomeOf(error: unknown): Outcome {
  const { code, message, detail } = error as {
    code?: unknown;
    message?: unknown;
    detail?: unknown;
  };
  return {
    accepted: false,
    code: typeof code === 'string' ? code : '?',
    message: typeof message === 'string' ? message : String(error),
    detail: typeof detail === 'string' ? detail : '',
  };
}

/**
 * One statement under a savepoint, deferred checks forced, then ALWAYS rolled
 * back to the savepoint, so every probe starts from the same state.
 */
async function probe(query: Query, sql: string, values: unknown[] = []): Promise<Outcome> {
  await query('SAVEPOINT t0054_probe');
  let outcome: Outcome;
  try {
    await query(sql, values);
    // A DEFERRABLE constraint trigger fires here instead of at COMMIT.
    await query('SET CONSTRAINTS ALL IMMEDIATE');
    outcome = { accepted: true };
  } catch (error) {
    outcome = outcomeOf(error);
  }
  await query('ROLLBACK TO SAVEPOINT t0054_probe');
  return outcome;
}

/** A hierarchy refusal: class 23 except not-null, FK and unique, or a plain RAISE. */
function hierarchyVerdict(outcome: Outcome): string {
  if (outcome.accepted) return 'accepted';
  const { code, message } = outcome;
  if (code === '23503') return 'foreign_key_violation';
  if (code === '23502') return 'not_null_violation';
  if (code === 'P0001' || (code.startsWith('23') && code !== '23505')) return 'refused';
  // 42703 (undefined column) lands here, verbatim: it says what is missing.
  return `error ${code}: ${message}`;
}

/** A value refusal: as above, plus a data exception (class 22: an enum's invalid input, a jsonb function on a non-array). */
function valueVerdict(outcome: Outcome): string {
  if (!outcome.accepted && outcome.code.startsWith('22')) return 'refused';
  return hierarchyVerdict(outcome);
}

class Rollback<T> {
  constructor(readonly value: T) {}
}

/** withTenantTransaction, but nothing commits: the callback's value is carried out by a throw. */
async function rolledBackTenantTx<T>(
  pool: Pool,
  tenantId: string,
  userId: string,
  fn: (query: Query, tx: TenantTx) => Promise<T>,
): Promise<T> {
  try {
    await withTenantTransaction(pool, { tenantId, userId }, async (tx) => {
      const query: Query = (text, params) => tx.query(text, params);
      throw new Rollback(await fn(query, tx));
    });
  } catch (signal) {
    if (signal instanceof Rollback) return signal.value as T;
    throw signal;
  }
  throw new Error('unreachable: the callback always throws');
}

/** A kasuwa_migrator transaction that is always rolled back. */
async function rolledBackMigratorTx<T>(pool: Pool, fn: (query: Query) => Promise<T>): Promise<T> {
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

const INSERT_ACCOUNT = `INSERT INTO account (id, tenant_id, programme_id, name) VALUES ($1, $2, $3, $4)`;
const INSERT_CHILD = `INSERT INTO account (id, tenant_id, programme_id, name, parent_account_id)
                      VALUES ($1, $2, $3, $4, $5)`;
const SET_PARENT = `UPDATE account SET parent_account_id = $1 WHERE tenant_id = $2 AND id = $3`;

/** Plants a chain top-down: ids[0] is top-level, each next one its child. */
async function plantChain(query: Query, tenantId: string, programmeId: string, ids: string[]) {
  let parent: string | null = null;
  for (const id of ids) {
    await query(INSERT_CHILD, [id, tenantId, programmeId, 'T-0054 chain', parent]);
    parent = id;
  }
}

const freshIds = (n: number): string[] => Array.from({ length: n }, () => randomUUID());

/** list[index], or a loud failure: never a silent `undefined` id. */
function at(list: readonly string[], index: number): string {
  const value = list[index];
  if (value === undefined) throw new Error(`no element ${index} in a list of ${list.length}`);
  return value;
}

/** One multi-row INSERT of a chain, rows listed CHILD FIRST: ids[0] is the top. */
function childFirstChainInsert(ids: string[], tenantId: string, programmeId: string) {
  const rows: string[] = [];
  const values: unknown[] = [];
  for (let level = ids.length - 1; level >= 0; level -= 1) {
    const base = values.length;
    rows.push(
      `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::uuid, 'T-0054 batch', $${base + 4}::uuid)`,
    );
    values.push(ids[level], tenantId, programmeId, level === 0 ? null : ids[level - 1]);
  }
  return {
    sql: `INSERT INTO account (id, tenant_id, programme_id, name, parent_account_id) VALUES ${rows.join(', ')}`,
    values,
  };
}

/** The seeded account of one programme. */
function seededAccount(programmeId: string): string {
  const found = SEED_ACCOUNTS.find((row) => row.programmeId === programmeId);
  if (found === undefined) throw new Error(`no seeded account in programme ${programmeId}`);
  return found.id;
}

// =============================================================================
// 1-7: the shared harness database
// =============================================================================

describe('acceptance: account fields (T-0054)', () => {
  /** kasuwa_app — NOBYPASSRLS. Every assertion about what a session may do. */
  let appPool: Pool;
  /** kasuwa_migrator — owns the schema. Catalogue reads and the migrator probes. */
  let migrator: Pool;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 4 });
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  afterAll(async () => {
    await appPool?.end();
    await migrator?.end();
    await reseed(inject('migrationUrl'));
  });

  const A1_SCOPE = { tenantId: TENANT_A, programmeIds: [PROGRAMME_A1] };

  // ---------------------------------------------------------------------------
  // 1. The migration
  // ---------------------------------------------------------------------------
  describe('migration 0026', () => {
    it('exists as exactly one 0026_*.sql and has been applied by the runner', async () => {
      const files = readdirSync(MIGRATIONS_DIR).filter((name) => /^0026_.*\.sql$/.test(name));
      expect(files, 'packages/db/migrations has no single 0026_*.sql').toHaveLength(1);
      const applied = await migrator.query<{ id: string }>(
        `SELECT id FROM _kasuwa_migration WHERE id LIKE '0026\\_%' ORDER BY id`,
      );
      expect(applied.rows.map((row) => `${row.id}.sql`)).toEqual(files);
    });

    it('leaves 0019 (account) and 0025 (the standard catalogue) unedited', () => {
      // Holds on main by construction: it guards the change (the columns go in
      // a new file, never into 0019; the fields never into 0025's literal).
      const current = new Map(loadMigrations().map((row) => [row.id, row.checksum]));
      for (const [id, checksum] of Object.entries(PINNED_CHECKSUMS)) {
        expect(current.get(id), `${id} was edited, renamed or removed`).toBe(checksum);
      }
    });

    it('adds no SECURITY DEFINER function: the census is still the two CLAUDE.md 2.7 names', async () => {
      // A regression guard; passes on main. A chain walk that "needs" to see
      // past RLS is exactly the convenience CLAUDE.md 2.7 forbids.
      const definers = await migrator.query<{ name: string }>(DEFINERS_SQL);
      expect(definers.rows.map((row) => row.name)).toEqual([
        'app.resolve_session',
        'app.resolve_tenant_by_slug',
      ]);
    });

    it('account keeps RLS enabled and FORCED, tenant AND programme on every permissive policy, WITH CHECK = USING', async () => {
      // A regression guard; passes on main.
      const security = (await readTableSecurity(appPool)).find((row) => row.table === 'account');
      expect(security?.rlsEnabled, 'account: RLS is not enabled').toBe(true);
      expect(security?.rlsForced, 'account: RLS is not FORCED').toBe(true);

      const policies = await migrator.query<{
        name: string;
        permissive: boolean;
        using: string | null;
        check: string | null;
      }>(
        `SELECT p.polname AS name, p.polpermissive AS permissive,
                pg_get_expr(p.polqual, p.polrelid) AS using,
                pg_get_expr(p.polwithcheck, p.polrelid) AS check
           FROM pg_policy p WHERE p.polrelid = to_regclass('public.account')`,
      );
      expect(policies.rows.length, 'account: has no policy').toBeGreaterThan(0);
      for (const policy of policies.rows.filter((row) => row.permissive)) {
        for (const expression of [policy.using, policy.check]) {
          if (expression === null) continue;
          expect(expression, `account.${policy.name}`).toContain('current_tenant_id()');
          expect(expression, `account.${policy.name}`).toContain('current_programme_ids()');
        }
      }
      expect(
        policies.rows.some((row) => row.check !== null && row.check === row.using),
        'account: no policy with WITH CHECK identical to USING',
      ).toBe(true);
    });

    it('account stays in TENANT_SCOPED_TABLES', () => {
      expect([...TENANT_SCOPED_TABLES]).toContain('account');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Columns and keys
  // ---------------------------------------------------------------------------
  describe('the columns serve the Account contract', () => {
    it('the contract’s withholdable Account properties are exactly the columns this suite pins', () => {
      // Guards every column check below against a misread or a drifted spec.
      expect(accountContractColumns()).toEqual(NEW_COLUMNS);
      expect(tierCodes().length).toBeGreaterThan(0);
    });

    it('every column exists with the right type, nullability and default', async () => {
      const columns = new Map(
        (
          await migrator.query<{
            column: string;
            type: string;
            notnull: boolean;
            default: string | null;
          }>(COLUMNS_SQL)
        ).rows.map((row) => [row.column, row]),
      );
      expect(columns.size, 'table account not found').toBeGreaterThan(0);

      const problems: string[] = [];
      for (const name of NEW_COLUMNS) {
        const spec = COLUMN_SPEC[name];
        const column = columns.get(name);
        if (spec === undefined) continue;
        if (column === undefined) {
          problems.push(`${name}: missing`);
          continue;
        }
        if (spec.type !== null && column.type !== spec.type) {
          problems.push(`${name}: type ${column.type}, expected ${spec.type}`);
        }
        if (column.notnull !== spec.notNull) {
          problems.push(
            `${name}: ${column.notnull ? 'NOT NULL' : 'nullable'}, expected the opposite`,
          );
        }
      }
      const tagsDefault = columns.get('tags')?.default ?? null;
      if (columns.has('tags') && !/^'\{\}'/.test(tagsDefault ?? '')) {
        problems.push(`tags: default ${String(tagsDefault)}, expected '{}'`);
      }
      const phonesDefault = columns.get('phones')?.default ?? null;
      if (columns.has('phones') && !/^'\[\]'/.test(phonesDefault ?? '')) {
        problems.push(`phones: default ${String(phonesDefault)}, expected '[]'`);
      }
      expect(problems, 'account columns that do not match T-0054').toEqual([]);
    });

    async function foreignKeys(): Promise<{ refTable: string; pairs: string[] }[]> {
      const result = await migrator.query<{ ref_table: string; pairs: string[] }>(
        `SELECT ref.relname AS ref_table,
                array_agg(la.attname || '->' || fa.attname ORDER BY la.attname) AS pairs
           FROM pg_constraint con
           JOIN pg_class ref ON ref.oid = con.confrelid
           CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(local_att, foreign_att)
           JOIN pg_attribute la ON la.attrelid = con.conrelid AND la.attnum = k.local_att
           JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.foreign_att
          WHERE con.contype = 'f' AND con.conrelid = to_regclass('public.account')
          GROUP BY con.conname, ref.relname`,
      );
      return result.rows.map((row) => ({ refTable: row.ref_table, pairs: [...row.pairs].sort() }));
    }

    it('owner_user_id references "user" through (tenant_id, owner_user_id)', async () => {
      const fks = await foreignKeys();
      expect(
        fks.filter((fk) => fk.refTable === 'user').map((fk) => fk.pairs),
        `account FKs: ${JSON.stringify(fks)}`,
      ).toContainEqual(['owner_user_id->id', 'tenant_id->tenant_id']);
    });

    it('parent_account_id references account through (tenant_id, programme_id, parent_account_id)', async () => {
      const fks = await foreignKeys();
      expect(
        fks.filter((fk) => fk.refTable === 'account').map((fk) => fk.pairs),
        `account FKs: ${JSON.stringify(fks)}`,
      ).toContainEqual([
        'parent_account_id->id',
        'programme_id->programme_id',
        'tenant_id->tenant_id',
      ]);
    });

    it('src/schema.ts mirrors the columns (type and nullability, from the Drizzle table)', () => {
      const mirrored = new Map<string, { sqlType: string; notNull: boolean }>();
      for (const value of Object.values(accountTable as unknown as Record<string, unknown>)) {
        const column = value as { name?: unknown; notNull?: unknown; getSQLType?: unknown };
        if (
          typeof column === 'object' &&
          column !== null &&
          typeof column.name === 'string' &&
          typeof column.notNull === 'boolean' &&
          typeof column.getSQLType === 'function'
        ) {
          const sqlType = (column.getSQLType as () => unknown).call(column);
          mirrored.set(column.name, { sqlType: String(sqlType), notNull: column.notNull });
        }
      }
      // Guards the reader: account has mirrored `name` since 0019.
      expect(mirrored.get('name'), 'the Drizzle reader found no columns').toEqual({
        sqlType: 'text',
        notNull: true,
      });

      const problems: string[] = [];
      for (const name of NEW_COLUMNS) {
        const spec = COLUMN_SPEC[name];
        const column = mirrored.get(name);
        if (spec === undefined) continue;
        if (column === undefined) {
          problems.push(`${name}: not in the account table of src/schema.ts`);
          continue;
        }
        if (spec.type !== null && column.sqlType !== spec.type) {
          problems.push(`${name}: mirrored as ${column.sqlType}, expected ${spec.type}`);
        }
        if (column.notNull !== spec.notNull) {
          problems.push(`${name}: mirrored notNull=${String(column.notNull)}`);
        }
      }
      expect(problems).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Values, as kasuwa_app
  // ---------------------------------------------------------------------------
  describe('the columns hold their values against kasuwa_app', () => {
    const insertWith = (column: string, cast = '') =>
      `INSERT INTO account (id, tenant_id, programme_id, name, ${column})
       VALUES (gen_random_uuid(), $1, $2, 'T-0054 probe', $3${cast})`;

    it('a new account gets tags {} and phones [], and nothing else invented', async () => {
      const row = await withForcedScope(appPool, A1_SCOPE, async (query) => {
        const rows = await query<Record<string, unknown>>(
          `INSERT INTO account (id, tenant_id, programme_id, name)
           VALUES (gen_random_uuid(), $1, $2, 'T-0054 defaults')
           RETURNING owner_user_id, industry, tier, tags, phones, state, lga, parent_account_id`,
          [TENANT_A, PROGRAMME_A1],
        );
        return rows[0];
      });
      expect(row).toEqual({
        owner_user_id: null,
        industry: null,
        tier: null,
        tags: [],
        phones: [],
        state: null,
        lga: null,
        parent_account_id: null,
      });
    });

    it('tags and phones refuse an explicit NULL; tags refuse a NULL element', async () => {
      const outcomes = await withForcedScope(appPool, A1_SCOPE, async (query) => ({
        tagsNull: valueVerdict(
          await probe(query, insertWith('tags'), [TENANT_A, PROGRAMME_A1, null]),
        ),
        phonesNull: valueVerdict(
          await probe(query, insertWith('phones', '::jsonb'), [TENANT_A, PROGRAMME_A1, null]),
        ),
        tagsNullElement: valueVerdict(
          await probe(query, insertWith('tags'), [TENANT_A, PROGRAMME_A1, ['Distributor', null]]),
        ),
        tagsOk: valueVerdict(
          await probe(query, insertWith('tags'), [TENANT_A, PROGRAMME_A1, ['Distributor', 'Q4']]),
        ),
      }));
      expect(outcomes).toEqual({
        tagsNull: 'not_null_violation',
        phonesNull: 'not_null_violation',
        tagsNullElement: 'refused',
        tagsOk: 'accepted',
      });
    });

    it('tier accepts exactly the contract’s AccountTier codes, and NULL', async () => {
      const accepted = tierCodes();
      // P04's display labels and near-misses: codes, never labels (D-L61).
      const rejected = [
        'Enterprise',
        'Mid-market',
        'mid-market',
        'SME',
        'sme ',
        'midmarket',
        'smb',
        '',
      ];
      const outcomes = await withForcedScope(appPool, A1_SCOPE, async (query) => {
        const result: Record<string, string> = {};
        for (const value of [...accepted, ...rejected, null]) {
          result[String(value)] = valueVerdict(
            await probe(query, insertWith('tier'), [TENANT_A, PROGRAMME_A1, value]),
          );
        }
        return result;
      });
      expect(outcomes).toEqual(
        Object.fromEntries([
          ...accepted.map((value) => [value, 'accepted']),
          ...rejected.map((value) => [value, 'refused']),
          ['null', 'accepted'],
        ]),
      );
    });

    it('industry, state and lga store free text', async () => {
      const row = await withForcedScope(appPool, A1_SCOPE, async (query) => {
        const rows = await query<Record<string, unknown>>(
          `INSERT INTO account (id, tenant_id, programme_id, name, industry, state, lga)
           VALUES (gen_random_uuid(), $1, $2, 'T-0054 text', 'FMCG', 'Lagos', 'Ikeja')
           RETURNING industry, state, lga`,
          [TENANT_A, PROGRAMME_A1],
        );
        return rows[0];
      });
      expect(row).toEqual({ industry: 'FMCG', state: 'Lagos', lga: 'Ikeja' });
    });

    // Fixtures for phones. Each e164 string's expected verdict is checked
    // against the CONTRACT's pattern first, so the fixtures cannot drift.
    const GOOD_E164 = ['+2348031234567', '+254712345021', '+1234567', '+123456789012345'];
    const BAD_E164 = [
      '08031234567', // national format
      '2348031234567', // no +
      '+234 803 123 4567', // separators
      '+02348031234567', // leading zero after +
      '+123456', // too short
      '+1234567890123456', // too long
      '',
    ];

    it('the phone fixtures agree with the contract’s Phone.e164 pattern and type enum', () => {
      const pattern = e164Pattern();
      expect(GOOD_E164.filter((value) => !pattern.test(value))).toEqual([]);
      expect(BAD_E164.filter((value) => pattern.test(value))).toEqual([]);
      expect(phoneTypes()).toEqual(expect.arrayContaining(['mobile', 'work']));
    });

    it('phones accepts arrays of contract Phone objects', async () => {
      const types = phoneTypes();
      const lists: unknown[][] = [
        [],
        ...GOOD_E164.map((e164) => [{ type: 'work', e164 }]),
        types.map((type, index) => ({
          type,
          e164: `+23480312345${String(index).padStart(2, '0')}`,
        })),
      ];
      const outcomes = await withForcedScope(appPool, A1_SCOPE, async (query) => {
        const result: string[] = [];
        for (const list of lists) {
          result.push(
            valueVerdict(
              await probe(query, insertWith('phones', '::jsonb'), [
                TENANT_A,
                PROGRAMME_A1,
                JSON.stringify(list),
              ]),
            ),
          );
        }
        return result;
      });
      expect(outcomes).toEqual(lists.map(() => 'accepted'));
    });

    it('phones refuses a non-E.164 number and anything that is not a list of Phone objects', async () => {
      const valid = { type: 'mobile', e164: '+2348031234567' };
      const cases: Record<string, unknown> = {
        ...Object.fromEntries(
          BAD_E164.map((e164) => [`e164 ${JSON.stringify(e164)}`, [{ type: 'mobile', e164 }]]),
        ),
        'a bad number after a good one': [valid, { type: 'mobile', e164: '08031234567' }],
        'e164 missing': [{ type: 'mobile' }],
        'e164 as a JSON number': [{ type: 'mobile', e164: 2348031234567 }],
        'type missing': [{ e164: '+2348031234567' }],
        'type not in the contract enum': [{ type: 'fax', e164: '+2348031234567' }],
        'a bare string element': ['+2348031234567'],
        'a null element': [null],
        'an object, not a list': valid,
        'a string, not a list': '+2348031234567',
        'JSON null, not a list': null,
      };
      const outcomes = await withForcedScope(appPool, A1_SCOPE, async (query) => {
        const result: Record<string, string> = {};
        for (const [name, value] of Object.entries(cases)) {
          result[name] = valueVerdict(
            await probe(query, insertWith('phones', '::jsonb'), [
              TENANT_A,
              PROGRAMME_A1,
              // JSON null is the jsonb value `null`, not SQL NULL.
              JSON.stringify(value),
            ]),
          );
        }
        return result;
      });
      expect(outcomes).toEqual(
        Object.fromEntries(Object.keys(cases).map((name) => [name, 'refused'])),
      );
    });

    it('the seeded accounts still load, with tags {} and phones []', async () => {
      const load = (tenantId: string, userId: string) =>
        withTenantTransaction(appPool, { tenantId, userId }, (tx) =>
          tx.query<{ id: string; tags: unknown; phones: unknown; parent_account_id: unknown }>(
            `SELECT id, tags, phones, parent_account_id FROM account
              WHERE id = ANY ($1::uuid[]) ORDER BY id`,
            [SEED_ACCOUNTS.map((row) => row.id)],
          ),
        );
      const rows = [
        ...(await load(TENANT_A, USER_A_SUPERVISOR)),
        ...(await load(TENANT_B, USER_B_AGENT_1)),
      ];
      // Supervisor: A1 + A2; tenant B's agent: B1.
      expect(rows.map((row) => row.id).sort()).toEqual(
        [
          seededAccount(PROGRAMME_A1),
          seededAccount(PROGRAMME_A2),
          seededAccount(PROGRAMME_B1),
        ].sort(),
      );
      for (const row of rows) {
        expect(row, row.id).toEqual({ id: row.id, tags: [], phones: [], parent_account_id: null });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Tenancy
  // ---------------------------------------------------------------------------
  describe('tenancy: owners and parents never cross a tenant or a programme', () => {
    it('tenant A cannot own an account by a tenant B user; its own user is fine', async () => {
      const outcomes = await rolledBackTenantTx(
        appPool,
        TENANT_A,
        USER_A_AGENT_1,
        async (query) => {
          const insert = `INSERT INTO account (id, tenant_id, programme_id, name, owner_user_id)
                        VALUES (gen_random_uuid(), $1, $2, 'T-0054 owner', $3)`;
          return {
            sameTenant: hierarchyVerdict(
              await probe(query, insert, [TENANT_A, PROGRAMME_A1, USER_A_AGENT_1]),
            ),
            otherTenant: hierarchyVerdict(
              await probe(query, insert, [TENANT_A, PROGRAMME_A1, USER_B_AGENT_1]),
            ),
            reassign: hierarchyVerdict(
              await probe(
                query,
                'UPDATE account SET owner_user_id = $1 WHERE tenant_id = $2 AND id = $3',
                [USER_B_AGENT_1, TENANT_A, seededAccount(PROGRAMME_A1)],
              ),
            ),
          };
        },
      );
      expect(outcomes).toEqual({
        sameTenant: 'accepted',
        otherTenant: 'foreign_key_violation',
        reassign: 'foreign_key_violation',
      });
    });

    it('a parent in tenant B, or in a sibling programme, is refused even for a session that sees both programmes', async () => {
      const outcomes = await rolledBackTenantTx(
        appPool,
        TENANT_A,
        USER_A_SUPERVISOR,
        async (query) => {
          const child = (parent: string) =>
            probe(query, INSERT_CHILD, [
              randomUUID(),
              TENANT_A,
              PROGRAMME_A1,
              'T-0054 child',
              parent,
            ]);
          return {
            sameProgramme: hierarchyVerdict(await child(seededAccount(PROGRAMME_A1))),
            // The supervisor can SEE the A2 account: RLS is not what refuses
            // this. Only the composite key can.
            siblingProgramme: hierarchyVerdict(await child(seededAccount(PROGRAMME_A2))),
            otherTenant: hierarchyVerdict(await child(seededAccount(PROGRAMME_B1))),
            reparentToTenantB: hierarchyVerdict(
              await probe(query, SET_PARENT, [
                seededAccount(PROGRAMME_B1),
                TENANT_A,
                seededAccount(PROGRAMME_A1),
              ]),
            ),
          };
        },
      );
      expect(outcomes).toEqual({
        sameProgramme: 'accepted',
        siblingProgramme: 'foreign_key_violation',
        otherTenant: 'foreign_key_violation',
        reparentToTenantB: 'foreign_key_violation',
      });
    });

    it('a real but unreachable parent id is refused exactly as an invented one (no existence oracle)', async () => {
      // An agent in A1 only. The A2 account exists; the invented id does not.
      // If the two errors differ in any way, the A1 agent can enumerate A2.
      const inventedId = randomUUID();
      const [real, invented] = await rolledBackTenantTx(
        appPool,
        TENANT_A,
        USER_A_AGENT_1,
        async (query) => {
          const attempt = (parent: string) =>
            probe(query, INSERT_CHILD, [
              '11111111-0000-4000-8000-0000005400f1',
              TENANT_A,
              PROGRAMME_A1,
              'T-0054 oracle',
              parent,
            ]);
          return [await attempt(seededAccount(PROGRAMME_A2)), await attempt(inventedId)] as const;
        },
      );
      const normalise = (outcome: Outcome, id: string) =>
        outcome.accepted
          ? 'accepted'
          : {
              code: outcome.code,
              message: outcome.message.split(id).join('<id>'),
              detail: outcome.detail.split(id).join('<id>'),
            };
      expect(hierarchyVerdict(real)).toBe('foreign_key_violation');
      expect(normalise(real, seededAccount(PROGRAMME_A2))).toEqual(normalise(invented, inventedId));
    });

    it('a linked parent or child cannot be moved to a sibling programme', async () => {
      const parent = randomUUID();
      const child = randomUUID();
      const outcomes = await rolledBackTenantTx(
        appPool,
        TENANT_A,
        USER_A_SUPERVISOR,
        async (query) => {
          await plantChain(query, TENANT_A, PROGRAMME_A1, [parent, child]);
          const move = (id: string) =>
            probe(query, 'UPDATE account SET programme_id = $1 WHERE tenant_id = $2 AND id = $3', [
              PROGRAMME_A2,
              TENANT_A,
              id,
            ]);
          return {
            moveChild: hierarchyVerdict(await move(child)),
            moveParent: hierarchyVerdict(await move(parent)),
          };
        },
      );
      // An ON UPDATE CASCADE would silently carry a child across a BPO
      // client boundary; the refusal is the only acceptable answer.
      expect(outcomes).toEqual({
        moveChild: 'foreign_key_violation',
        moveParent: 'foreign_key_violation',
      });
    });

    it('RLS still isolates: each session sees only its own programmes’ seeded accounts', async () => {
      // A regression guard; passes on main.
      const visible = (tenantId: string, userId: string) =>
        withTenantTransaction(appPool, { tenantId, userId }, async (tx) =>
          (
            await tx.query<{ id: string }>(
              'SELECT id FROM account WHERE id = ANY ($1::uuid[]) ORDER BY id',
              [SEED_ACCOUNTS.map((row) => row.id)],
            )
          ).map((row) => row.id),
        );
      expect(await visible(TENANT_A, USER_A_AGENT_1)).toEqual([seededAccount(PROGRAMME_A1)]);
      expect(await visible(TENANT_B, USER_B_AGENT_1)).toEqual([seededAccount(PROGRAMME_B1)]);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. The hierarchy, as kasuwa_app and as kasuwa_migrator
  // ---------------------------------------------------------------------------

  /** Every hierarchy rule, run on one connection; returns verdicts by name. */
  async function hierarchyProbes(query: Query, tenantId: string, programmeId: string) {
    const verdicts: Record<string, string> = {};

    // Self-parent, on insert and on update.
    const self = randomUUID();
    verdicts.selfInsert = hierarchyVerdict(
      await probe(query, INSERT_CHILD, [self, tenantId, programmeId, 'T-0054 self', self]),
    );
    const top = randomUUID();
    await query(INSERT_ACCOUNT, [top, tenantId, programmeId, 'T-0054 top']);
    verdicts.selfUpdate = hierarchyVerdict(await probe(query, SET_PARENT, [top, tenantId, top]));

    // Direct cycle: A <- B, then A -> B.
    const [a, b] = [randomUUID(), randomUUID()];
    await plantChain(query, tenantId, programmeId, [a, b]);
    verdicts.directCycle = hierarchyVerdict(await probe(query, SET_PARENT, [b, tenantId, a]));

    // Indirect cycle: A <- B <- C, then A -> C.
    const [ia, ib, ic] = [randomUUID(), randomUUID(), randomUUID()];
    await plantChain(query, tenantId, programmeId, [ia, ib, ic]);
    verdicts.indirectCycle = hierarchyVerdict(await probe(query, SET_PARENT, [ic, tenantId, ia]));

    // One statement: two top-level accounts swap into each other.
    const [s1, s2] = [randomUUID(), randomUUID()];
    await query(INSERT_ACCOUNT, [s1, tenantId, programmeId, 'T-0054 swap one']);
    await query(INSERT_ACCOUNT, [s2, tenantId, programmeId, 'T-0054 swap two']);
    verdicts.oneStatementSwap = hierarchyVerdict(
      await probe(
        query,
        `UPDATE account
            SET parent_account_id = CASE id WHEN $1::uuid THEN $2::uuid ELSE $1::uuid END
          WHERE tenant_id = $3 AND id IN ($1::uuid, $2::uuid)`,
        [s1, s2, tenantId],
      ),
    );

    // One statement: two new rows naming each other.
    const [x, y] = [randomUUID(), randomUUID()];
    verdicts.oneStatementInsertCycle = hierarchyVerdict(
      await probe(
        query,
        `INSERT INTO account (id, tenant_id, programme_id, name, parent_account_id)
         VALUES ($1::uuid, $3, $4, 'T-0054 x', $2::uuid), ($2::uuid, $3, $4, 'T-0054 y', $1::uuid)`,
        [x, y, tenantId, programmeId],
      ),
    );

    // Depth: a chain of MAX_DEPTH - 1, then the MAX_DEPTH-th (accepted), then
    // one more (refused).
    const chain = freshIds(MAX_DEPTH);
    const last = at(chain, MAX_DEPTH - 1);
    await plantChain(query, tenantId, programmeId, chain.slice(0, MAX_DEPTH - 1));
    verdicts.depthAtCap = hierarchyVerdict(
      await probe(query, INSERT_CHILD, [
        last,
        tenantId,
        programmeId,
        'T-0054 at cap',
        at(chain, MAX_DEPTH - 2),
      ]),
    );
    await query(INSERT_CHILD, [
      last,
      tenantId,
      programmeId,
      'T-0054 at cap',
      at(chain, MAX_DEPTH - 2),
    ]);
    verdicts.depthOverCap = hierarchyVerdict(
      await probe(query, INSERT_CHILD, [
        randomUUID(),
        tenantId,
        programmeId,
        'T-0054 over cap',
        last,
      ]),
    );

    // Depth by re-parenting a two-level subtree: under depth MAX_DEPTH - 2 it
    // reaches exactly MAX_DEPTH; under MAX_DEPTH - 1 its leaf would be
    // MAX_DEPTH + 1.
    const [subRoot, subLeaf] = [randomUUID(), randomUUID()];
    await plantChain(query, tenantId, programmeId, [subRoot, subLeaf]);
    verdicts.subtreeFits = hierarchyVerdict(
      await probe(query, SET_PARENT, [at(chain, MAX_DEPTH - 3), tenantId, subRoot]),
    );
    verdicts.subtreeTooDeep = hierarchyVerdict(
      await probe(query, SET_PARENT, [at(chain, MAX_DEPTH - 2), tenantId, subRoot]),
    );

    // Depth in one multi-row INSERT, child first.
    const fits = childFirstChainInsert(freshIds(MAX_DEPTH), tenantId, programmeId);
    verdicts.batchAtCap = hierarchyVerdict(await probe(query, fits.sql, fits.values));
    const over = childFirstChainInsert(freshIds(MAX_DEPTH + 1), tenantId, programmeId);
    verdicts.batchOverCap = hierarchyVerdict(await probe(query, over.sql, over.values));

    return verdicts;
  }

  const EXPECTED_HIERARCHY = {
    selfInsert: 'refused',
    selfUpdate: 'refused',
    directCycle: 'refused',
    indirectCycle: 'refused',
    oneStatementSwap: 'refused',
    oneStatementInsertCycle: 'refused',
    depthAtCap: 'accepted',
    depthOverCap: 'refused',
    subtreeFits: 'accepted',
    subtreeTooDeep: 'refused',
    batchAtCap: 'accepted',
    batchOverCap: 'refused',
  };

  describe('the hierarchy: no cycle, depth at most 5', () => {
    it('as kasuwa_app inside a real withTenantTransaction', async () => {
      const verdicts = await rolledBackTenantTx(appPool, TENANT_A, USER_A_AGENT_1, (query) =>
        hierarchyProbes(query, TENANT_A, PROGRAMME_A1),
      );
      expect(verdicts).toEqual(EXPECTED_HIERARCHY);
    });

    it('as kasuwa_migrator (BYPASSRLS does not bypass the guard)', async () => {
      const verdicts = await rolledBackMigratorTx(migrator, (query) =>
        hierarchyProbes(query, TENANT_B, PROGRAMME_B1),
      );
      expect(verdicts).toEqual(EXPECTED_HIERARCHY);
    });

    it('two concurrent transactions cannot each add half of a cycle', async () => {
      const one = randomUUID();
      const two = randomUUID();
      const session = { tenantId: TENANT_A, userId: USER_A_AGENT_1 };
      await withTenantTransaction(appPool, session, async (tx) => {
        await tx.query(INSERT_ACCOUNT, [one, TENANT_A, PROGRAMME_A1, 'T-0054 race one']);
        await tx.query(INSERT_ACCOUNT, [two, TENANT_A, PROGRAMME_A1, 'T-0054 race two']);
      });

      const latch = <T = void>() => {
        let open: (value: T) => void = () => undefined;
        const wait = new Promise<T>((resolveLatch) => {
          open = resolveLatch;
        });
        return { wait, open };
      };
      const tx1Wrote = latch();
      const tx1Release = latch();
      const tx2Pid = latch<number>();
      const tx2Release = latch();

      // The state of T2's statement, written by T2 and read by the wait below.
      const tx2Statement: { outcome?: Outcome } = {};
      let tx1: Promise<void> | undefined;
      let tx2: Promise<void> | undefined;
      let final: Outcome = { accepted: true };
      try {
        // T1: one -> two, then held open.
        tx1 = withTenantTransaction(appPool, session, async (tx) => {
          await tx.query(SET_PARENT, [two, TENANT_A, one]);
          tx1Wrote.open();
          await tx1Release.wait;
        });
        const first = await Promise.race([
          tx1Wrote.wait.then(() => 'wrote' as const),
          tx1.then(() => 'finished' as const),
        ]);
        if (first === 'finished') throw new Error('T1 finished before its write was observed');

        // T2: two -> one, while T1 is uncommitted.
        tx2 = withTenantTransaction(appPool, session, async (tx) => {
          const [row] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          tx2Pid.open(row?.pid ?? -1);
          try {
            await tx.query(SET_PARENT, [one, TENANT_A, two]);
            tx2Statement.outcome = { accepted: true };
          } catch (error) {
            tx2Statement.outcome = outcomeOf(error);
            throw error;
          }
          await tx2Release.wait;
        });
        const tx2Final = tx2.then(
          (): Outcome => ({ accepted: true }),
          (error: unknown) => outcomeOf(error),
        );

        // Wait on state, never on time: T2's statement has finished, or T2 is
        // blocked behind a lock. The deadline only turns a hang into a failure.
        const pid = await tx2Pid.wait;
        const deadline = Date.now() + 15_000;
        for (;;) {
          if (tx2Statement.outcome !== undefined) break;
          const blocked = await migrator.query<{ blocked: boolean }>(
            'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
            [pid],
          );
          if (blocked.rows[0]?.blocked === true) break;
          if (Date.now() > deadline) {
            throw new Error('T2 neither finished its statement nor blocked within 15 s');
          }
        }

        tx1Release.open();
        await tx1; // T1 must commit: it was alone when it wrote.
        tx2Release.open();
        final = await tx2Final;
      } finally {
        // On any failure above, let both transactions end so the pool can close.
        tx1Release.open();
        tx2Release.open();
        await Promise.allSettled([tx1, tx2].filter((p): p is Promise<void> => p !== undefined));
      }

      const committed = await migrator.query<{ id: string; parent_account_id: string | null }>(
        'SELECT id, parent_account_id FROM account WHERE id = ANY ($1::uuid[])',
        [[one, two]],
      );
      const parents = Object.fromEntries(
        committed.rows.map((row) => [row.id, row.parent_account_id]),
      );
      expect(
        parents,
        `committed hierarchy after the race; T2's statement: ${JSON.stringify(tx2Statement.outcome)}, T2: ${JSON.stringify(final)}`,
      ).toEqual({ [one]: two, [two]: null });
      expect(hierarchyVerdict(final), 'T2 was not refused for a hierarchy reason').toBe('refused');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Indexes
  // ---------------------------------------------------------------------------
  describe('indexes', () => {
    async function accountIndexes() {
      const result = await migrator.query<{
        name: string;
        valid: boolean;
        partial: boolean;
        keys: string[];
      }>(
        `SELECT i.relname AS name, x.indisvalid AS valid, x.indpred IS NOT NULL AS partial,
                ARRAY(SELECT pg_get_indexdef(x.indexrelid, k, true)
                        FROM generate_series(1, x.indnkeyatts) AS k ORDER BY k) AS keys
           FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
          WHERE x.indrelid = to_regclass('public.account')`,
      );
      return result.rows;
    }

    it('a keyset index leads with tenant_id, programme_id, name and includes id', async () => {
      const indexes = await accountIndexes();
      const keyset = indexes.filter(
        (index) =>
          index.valid &&
          !index.partial &&
          index.keys[0] === 'tenant_id' &&
          index.keys[1] === 'programme_id' &&
          /\bname\b/.test(index.keys[2] ?? '') &&
          index.keys.includes('id'),
      );
      expect(keyset.length, `account indexes: ${JSON.stringify(indexes)}`).toBeGreaterThan(0);
    });

    it('an owner index leads with tenant_id and carries owner_user_id', async () => {
      const indexes = await accountIndexes();
      const owner = indexes.filter(
        (index) =>
          index.valid &&
          index.keys[0] === 'tenant_id' &&
          (index.keys[1] === 'owner_user_id' ||
            (index.keys[1] === 'programme_id' && index.keys[2] === 'owner_user_id')),
      );
      expect(owner.length, `account indexes: ${JSON.stringify(indexes)}`).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Metadata
  // ---------------------------------------------------------------------------
  describe('every new column is a standard account field', () => {
    async function standardAccountFields(query: Query, tenantId: string) {
      const rows = await query<FieldRow>(ACCOUNT_FIELDS_SQL, [tenantId]);
      return { standard: rows.map((row) => row.api_name) };
    }

    const asMigrator: () => Query = () => async (text, params) =>
      (await migrator.query(text, params)).rows;

    it.each(SEED_TENANTS.map((tenant) => [tenant.slug, tenant.id] as const))(
      '%s: a standard field_def for each new column, none for the derived owner',
      async (_slug, tenantId) => {
        const { standard } = await standardAccountFields(asMigrator(), tenantId);
        expect(standard, 'the tenant has no standard account fields').toContain('name');
        expect(
          NEW_COLUMNS.filter((name) => !standard.includes(name)),
          'columns with no standard field_def',
        ).toEqual([]);
        expect(standard, 'owner is derived from owner_user_id (D-L73)').not.toContain('owner');
      },
    );

    it('ensureStandardObjectDefs gives a fresh tenant the same account fields as the seeded tenants', async () => {
      const seeded = await asMigrator()<FieldRow>(ACCOUNT_FIELDS_SQL, [TENANT_A]);
      const fresh = await rolledBackMigratorTx(migrator, async (query) => {
        const tenantId = randomUUID();
        await query(`INSERT INTO tenant (id, name, slug) VALUES ($1, 'T-0054 Fresh Ltd', $2)`, [
          tenantId,
          `t0054-fresh-${RUN}`,
        ]);
        await ensureStandardObjectDefs((text, values) => query(text, [...values]), tenantId);
        return query<FieldRow>(ACCOUNT_FIELDS_SQL, [tenantId]);
      });
      expect(NEW_COLUMNS.filter((name) => !fresh.some((row) => row.api_name === name))).toEqual([]);
      expect(fresh).toEqual(seeded);
    });
  });
});

// =============================================================================
// 8: 0026 on a database whose tenants pre-date it — the clash, then the backfill
// =============================================================================

describe('acceptance: 0026 over tenants that pre-date it (T-0054)', () => {
  const database = `kasuwa_t0054_${RUN}`;
  const LEGACY_1 = '54000000-0000-4000-8000-000000000001';
  const LEGACY_2 = '54000000-0000-4000-8000-000000000002';
  const LEGACY_3 = '54000000-0000-4000-8000-000000000003';
  const LEGACY_BU = '54000000-0000-4000-8000-0000000000b1';
  const LEGACY_PROGRAMME = '54000000-0000-4000-8000-0000000000c1';
  const LEGACY_ACCOUNT = '54000000-0000-4000-8000-0000000000a1';
  const CLASH_FIELDS = [
    '54000000-0000-4000-8000-0000000000f1',
    '54000000-0000-4000-8000-0000000000f2',
  ];
  const NOT_A_CLASH = '54000000-0000-4000-8000-0000000000f3';

  let superuserUrl: URL | undefined;
  let legacyUrl = '';
  let legacy: Pool | undefined;
  let mainObserver: Pool;
  const tempDirs: string[] = [];

  let clashError: unknown;
  let afterClash: {
    migrations: string[];
    columns: string[];
    standardAccountFields: string[];
  } = { migrations: [], columns: [], standardAccountFields: [] };
  let finalError: unknown;
  let tablesBefore: string[] = [];
  let definersBefore: string[] = [];

  /** A directory holding only the migrations that sort before `prefix`. */
  function migrationsBefore(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `t0054-pre${prefix}-`));
    tempDirs.push(dir);
    for (const name of readdirSync(MIGRATIONS_DIR)) {
      if (name.endsWith('.sql') && name < prefix)
        copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
    }
    return dir;
  }

  const pool = (): Pool => {
    if (legacy === undefined) throw new Error('the legacy database was not built');
    return legacy;
  };

  async function snapshot(p: Pool) {
    const migrations = (
      await p.query<{ id: string }>('SELECT id FROM _kasuwa_migration ORDER BY id')
    ).rows.map((row) => row.id);
    const columns = (await p.query<{ column: string }>(COLUMNS_SQL)).rows.map((row) => row.column);
    const fields = (await p.query<FieldRow>(ACCOUNT_FIELDS_SQL, [LEGACY_1])).rows
      .filter((row) => !row.is_custom)
      .map((row) => row.api_name);
    return { migrations, columns, standardAccountFields: fields };
  }

  beforeAll(async () => {
    mainObserver = createPool({ connectionString: inject('migrationUrl'), max: 1 });
    const migrationUrl = new URL(inject('migrationUrl'));

    // Only a superuser may CREATE DATABASE (packages/testing/src/containers.ts).
    const superuser = new URL(migrationUrl.href);
    superuser.username = 'postgres';
    superuser.password = 'postgres';
    superuser.pathname = '/postgres';
    superuserUrl = superuser;
    const admin = new Client({ connectionString: superuser.href });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${database}`);
    } finally {
      await admin.end();
    }

    const inNewDatabase = new URL(superuser.href);
    inNewDatabase.pathname = `/${database}`;
    const bootstrap = new Client({ connectionString: inNewDatabase.href });
    await bootstrap.connect();
    try {
      await bootstrap.query(
        readFileSync(BOOTSTRAP_SQL, 'utf8').replace(/\bDATABASE kasuwa\b/g, `DATABASE ${database}`),
      );
    } finally {
      await bootstrap.end();
    }

    const url = new URL(migrationUrl.href);
    url.pathname = `/${database}`;
    legacyUrl = url.href;

    // The chain before 0025, then tenants, then 0025 backfills them: the state
    // of a cell that has run every release up to T-0053.
    await runMigrations({ connectionString: legacyUrl, migrationsDir: migrationsBefore('0025') });
    legacy = createPool({ connectionString: legacyUrl, max: 2 });
    for (const [id, slug] of [
      [LEGACY_1, 'legacy-one'],
      [LEGACY_2, 'legacy-two'],
      [LEGACY_3, 'legacy-three'],
    ] as const) {
      await legacy.query(`INSERT INTO tenant (id, name, slug) VALUES ($1, $2, $3)`, [
        id,
        `Legacy ${slug}`,
        slug,
      ]);
    }
    await legacy.query(
      `INSERT INTO business_unit (id, tenant_id, name) VALUES ($1, $2, 'Head office')`,
      [LEGACY_BU, LEGACY_1],
    );
    await legacy.query(
      `INSERT INTO programme (id, tenant_id, business_unit_id, name, is_default)
       VALUES ($1, $2, $3, 'Default', true)`,
      [LEGACY_PROGRAMME, LEGACY_1, LEGACY_BU],
    );
    await legacy.query(INSERT_ACCOUNT, [
      LEGACY_ACCOUNT,
      LEGACY_1,
      LEGACY_PROGRAMME,
      'Ọjà Foods Ltd',
    ]);
    await runMigrations({ connectionString: legacyUrl, migrationsDir: migrationsBefore('0026') });

    // The clash (D-P24): two tenants made a custom `industry` on account; a
    // third made one on contact, which is not a clash.
    const objectId = async (tenantId: string, api: string) => {
      const row = (
        await pool().query<{ id: string }>(
          `SELECT id FROM object_def WHERE tenant_id = $1 AND api_name = $2 AND NOT is_custom`,
          [tenantId, api],
        )
      ).rows[0];
      if (row === undefined) throw new Error(`0025 did not backfill ${api} for ${tenantId}`);
      return row.id;
    };
    for (const [index, tenantId] of [LEGACY_1, LEGACY_2].entries()) {
      await pool().query(
        `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, is_custom)
         VALUES ($1, $2, $3, 'industry', 'Sector', 'text', true)`,
        [CLASH_FIELDS[index], tenantId, await objectId(tenantId, 'account')],
      );
    }
    await pool().query(
      `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, is_custom)
       VALUES ($1, $2, $3, 'industry', 'Industry', 'text', true)`,
      [NOT_A_CLASH, LEGACY_3, await objectId(LEGACY_3, 'contact')],
    );

    tablesBefore = (await pool().query<{ name: string }>(PUBLIC_TABLES_SQL)).rows.map(
      (row) => row.name,
    );
    definersBefore = (await pool().query<{ name: string }>(DEFINERS_SQL)).rows.map(
      (row) => row.name,
    );

    // Phase 1: the rest of the chain must stop at 0026.
    try {
      await runMigrations({ connectionString: legacyUrl });
    } catch (error) {
      clashError = error;
    }
    afterClash = await snapshot(pool());

    // Phase 2: a human resolves the clash; the chain then applies.
    await pool().query('DELETE FROM field_def WHERE id = ANY ($1::uuid[])', [CLASH_FIELDS]);
    try {
      await runMigrations({ connectionString: legacyUrl });
    } catch (error) {
      finalError = error;
    }
  }, 150_000);

  afterAll(async () => {
    await legacy?.end();
    await mainObserver?.end();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    if (superuserUrl === undefined) return;
    const admin = new Client({ connectionString: superuserUrl.href });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it('a custom account.industry stops 0026 with a message naming the object, the field and the tenant count', () => {
    expect(clashError, '0026 applied over two tenants’ custom account.industry').toBeInstanceOf(
      Error,
    );
    const message = clashError instanceof Error ? clashError.message : String(clashError);
    expect(message, 'the failure is not 0026’s').toMatch(/\b0026_/);
    expect(message).toMatch(/\baccount\b/);
    expect(message).toMatch(/\bindustry\b/);
    expect(message, 'the count of tenants affected (2)').toMatch(/\b2\b/);
    // contact.industry in a third tenant is not a clash: counting it means
    // the pre-check ignored the object.
    expect(message, 'a custom field on another object was counted').not.toMatch(/\b3\b/);
  });

  it('and nothing of 0026 was applied: no ledger row, no column, no field_def', () => {
    // Without a failure to inspect, the three lists below hold trivially (on a
    // checkout with no 0026 there is nothing to apply), so demand one first.
    expect(clashError, 'there was no failed 0026 to inspect').toBeInstanceOf(Error);
    expect(afterClash.migrations.filter((id) => id >= '0026')).toEqual([]);
    expect(afterClash.columns.filter((name) => NEW_COLUMNS.includes(name))).toEqual([]);
    expect(afterClash.standardAccountFields).toEqual(['name']);
  });

  it('once the clash is resolved, 0026 applies', async () => {
    expect(finalError === undefined ? null : String(finalError)).toBe(null);
    const applied = await pool().query<{ id: string }>(
      `SELECT id FROM _kasuwa_migration WHERE id LIKE '0026\\_%'`,
    );
    expect(applied.rows, '0026 was not applied').toHaveLength(1);
  });

  it.each([
    ['the tenant with a pre-0026 account', LEGACY_1],
    ['a tenant that had the clash', LEGACY_2],
    ['a tenant with a custom contact.industry', LEGACY_3],
  ])('backfills %s with exactly the account fields the seed writes', async (_what, tenantId) => {
    const seeded = (await mainObserver.query<FieldRow>(ACCOUNT_FIELDS_SQL, [TENANT_A])).rows;
    expect(NEW_COLUMNS.filter((name) => !seeded.some((row) => row.api_name === name))).toEqual([]);
    const backfilled = (await pool().query<FieldRow>(ACCOUNT_FIELDS_SQL, [tenantId])).rows;
    expect(backfilled).toEqual(seeded);
  });

  it('keeps the custom contact.industry, still custom', async () => {
    const row = await pool().query<{ is_custom: boolean; label: string }>(
      'SELECT is_custom, label FROM field_def WHERE id = $1',
      [NOT_A_CLASH],
    );
    expect(row.rows).toEqual([{ is_custom: true, label: 'Industry' }]);
  });

  it('the pre-0026 account reads tags {} and phones [], everything else null', async () => {
    const rows = await pool().query<Record<string, unknown>>(
      `SELECT name, owner_user_id, industry, tier, tags, phones, state, lga, parent_account_id
         FROM account WHERE id = $1`,
      [LEGACY_ACCOUNT],
    );
    expect(rows.rows).toEqual([
      {
        name: 'Ọjà Foods Ltd',
        owner_user_id: null,
        industry: null,
        tier: null,
        tags: [],
        phones: [],
        state: null,
        lga: null,
        parent_account_id: null,
      },
    ]);
  });

  it('adds only tables that meet the tenancy invariants, and no SECURITY DEFINER function', async () => {
    // The table loop is vacuous when 0026 adds no table (the expected case);
    // it is here so that a hierarchy side table cannot skip the rules.
    expect(definersBefore.length, 'the census before 0026 read nothing').toBe(2);
    expect(
      (await pool().query<{ name: string }>(DEFINERS_SQL)).rows.map((row) => row.name),
    ).toEqual(definersBefore);
    const after = (await pool().query<{ name: string }>(PUBLIC_TABLES_SQL)).rows.map(
      (row) => row.name,
    );
    const problems: string[] = [];
    for (const table of after.filter(
      (name) => !tablesBefore.includes(name) && !name.startsWith('_'),
    )) {
      if (!(TENANT_SCOPED_TABLES as readonly string[]).includes(table)) {
        problems.push(`${table}: not in TENANT_SCOPED_TABLES`);
      }
      const state = (
        await pool().query<{ enabled: boolean; forced: boolean }>(
          `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = $1`,
          [table],
        )
      ).rows[0];
      if (state?.enabled !== true || state.forced !== true)
        problems.push(`${table}: RLS not enabled and forced`);
      const policies = await pool().query<{ qual: string | null; with_check: string | null }>(
        `SELECT qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      );
      if (
        !policies.rows.some((policy) => policy.qual !== null && policy.qual === policy.with_check)
      ) {
        problems.push(`${table}: no policy whose WITH CHECK equals its USING`);
      }
    }
    expect(problems).toEqual([]);
  });
});
