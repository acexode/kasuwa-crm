import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as kasuwaDb from '@kasuwa/db';
import {
  createPool,
  ensureStandardObjectDefs,
  loadMigrations,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  runMigrations,
  SEED_ACCOUNTS,
  SEED_CONTACTS,
  SEED_TENANTS,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import type { TenantTx } from '@kasuwa/db';
import { readTableSecurity, reseed } from '@kasuwa/testing';
import { Client, type Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * ACCEPTANCE — T-0060, the `activity` table (migration only; Agent 3, Agent 1
 * reviews the migration).
 *
 * Source: team/tasks/T-0060-activity-table.md; D-L65 (hot-table migrations,
 * the version trigger), D-L67 (owner membership: repository, not here), D-L69,
 * D-L72 (`activity` is a reserved timeline item type), D-L74 and D-L76 (id
 * rotation on composite FKs), D-P18 (agents log and complete activities),
 * D-P24 (the clash pre-check); the recipe in
 * packages/db/src/standard-object-catalogue.ts; CLAUDE.md 2.3, 2.4, 2.7.
 *
 * Written from the invariants before any implementation (D-L23, D-L25). The
 * model suites are records/account-fields (T-0054), records/contact-fields
 * (T-0040) and metadata/standard-object-metadata (T-0053). Helpers are
 * restated here, never shared, so no other suite can change this one's
 * meaning.
 *
 * ------------------------------------------------------------------------
 * PINNED (the builder must honour these exactly)
 * ------------------------------------------------------------------------
 *
 * 1. MIGRATION. Exactly ONE file in packages/db/migrations creates the
 *    `activity` table (found by its `CREATE TABLE activity (`, comments
 *    stripped, NOT by number: the number is whatever is free when the task
 *    starts), and the runner has applied it. Other new files are allowed (a
 *    following no-transaction file for CONCURRENTLY builds, D-L65; a unique
 *    key on contact). 0001, 0018, 0019 and 0025 are unedited. No SECURITY
 *    DEFINER function is added (CLAUDE.md 2.7). Any OTHER table the change
 *    adds meets the tenancy invariants too.
 *
 * 2. COLUMNS, exactly these and no others (no `deal_id` until the pipeline
 *    slice; no start, end, timezone or reminder columns until P07):
 *      id uuid NOT NULL (the primary key), tenant_id uuid NOT NULL,
 *      programme_id uuid NOT NULL, type text NOT NULL, subject text,
 *      body text, due_at timestamptz NULL, completed_at timestamptz NULL,
 *      owner_user_id uuid, contact_id uuid NULL, account_id uuid NULL,
 *      created_by_user_id uuid, version integer NOT NULL DEFAULT 1,
 *      created_at timestamptz NOT NULL DEFAULT now(),
 *      updated_at timestamptz NOT NULL DEFAULT now().
 *    - type: text with a CHECK admitting exactly note, task and call (codes,
 *      never labels; text, not an enum type, per 0019's VALUE SETS note).
 *    - FKs, each carrying tenant_id (referential checks ignore RLS):
 *        tenant_id -> tenant; (tenant_id, programme_id) -> programme;
 *        (tenant_id, owner_user_id) -> "user"; (tenant_id,
 *        created_by_user_id) -> "user"; (tenant_id, programme_id,
 *        contact_id) -> contact; (tenant_id, programme_id, account_id) ->
 *        account. Nothing on activity references another tenant-scoped
 *        table without tenant_id.
 *    - At least one of contact_id and account_id is set (a CHECK), on INSERT
 *      and on UPDATE. Both may be set.
 *    - version and updated_at are maintained by the existing triggers
 *      (app.bump_version, 0019; app.touch_updated_at, 0018): a statement that
 *      leaves them alone moves them; one that writes them keeps its value;
 *      `version = version + 1` moves it exactly once.
 *
 * 3. FK ACTIONS (D-L76). As kasuwa_app inside a real withTenantTransaction:
 *    - an `UPDATE contact SET id = ...` (resp. account) that ROTATES ids in
 *      one statement (X -> fresh, Y -> X) is refused, and the activity still
 *      points at the row it pointed at. NO ACTION accepts exactly that
 *      statement and silently re-points the activity to Y; a self-check on
 *      throwaway tables proves the probe statement really does rotate.
 *    - moving a contact or an account that has activities to a sibling
 *      programme is refused (an ON UPDATE CASCADE would carry the activity,
 *      body and all, across a BPO client boundary); so is moving the
 *      activity away from its target's programme.
 *    - activity.id is immutable for kasuwa_app.
 *    "Refused" is: a FK violation (23503), another class-23 error except
 *    23502/23505, a class-22 data exception, P0001, or 42501. Never 23505
 *    (that is a misordered probe, not a refusal) and never 42P01/42703 (that
 *    is a missing table/column). The id change may also be silently kept
 *    (a trigger that restores OLD.id); what is asserted is the end state.
 *    AND OFFBOARDING STILL WORKS: kasuwa_migrator can delete a programme and
 *    a tenant that hold activities on contacts and accounts (D-L74: RESTRICT
 *    is acceptable only because it still lets offboarding cascade).
 *
 * 4. TENANCY. RLS ENABLED and FORCED; every permissive policy names
 *    app.current_tenant_id() and app.current_programme_ids(); one has WITH
 *    CHECK identical to USING; `activity` is in TENANT_SCOPED_TABLES. The
 *    table is owned by kasuwa_migrator, never kasuwa_app; kasuwa_app holds
 *    SELECT, INSERT and UPDATE (D-P18: agents log and complete); neither
 *    kasuwa_app nor any role it can enter holds TRUNCATE (TRUNCATE skips RLS)
 *    or BYPASSRLS. Behaviour:
 *    - a session sees exactly its own programmes' activities;
 *    - an A1 session cannot update, delete, or insert into A2 or tenant B;
 *    - an A1 activity cannot target a contact or account in A2 or tenant B,
 *      even for a supervisor who can SEE both programmes (only the key stops
 *      that), and a real-but-unreachable target id gets exactly the error an
 *      invented one gets (no existence oracle across the BPO boundary). The
 *      same holds for owner_user_id across tenants.
 *
 * 5. METADATA. Every tenant has exactly one STANDARD `object_def` named
 *    `activity` and a STANDARD `field_def` for each business column:
 *      type, subject, body, due_at, completed_at, owner_user_id, contact_id,
 *      account_id
 *    and none that is not one of those (created_by_user_id, created_at,
 *    updated_at and version MAY have one; id, tenant_id and programme_id may
 *    not, nor may anything that is not a column). contact_id is a `lookup`
 *    with config {"targetObjectApiName":"contact"}, account_id one with
 *    {"targetObjectApiName":"account"} (the catalogue's own account_id
 *    convention). `body` AND `subject` are classified `pii` (see "PII").
 *    Seeded tenants (ensureStandardObjectDefs via the seed), a fresh tenant
 *    given ensureStandardObjectDefs, and tenants that pre-date the migration
 *    (its backfill) all get the same object and fields: label, type,
 *    is_required, config and classification.
 *    THE CLASH PRE-CHECK (catalogue recipe step 2, D-P24): when tenants
 *    already have a CUSTOM object named `activity`, the migration stops
 *    before changing anything, with a message naming `activity` and the
 *    number of such tenants. A custom FIELD named `activity`, a custom
 *    object `activity_log`, or a custom `subject` field on another object is
 *    not a clash and is not counted: two tenants clash, a third has those,
 *    so the message says 2 and never 3. Once the clash is removed, the
 *    migration applies.
 *
 * 6. INDEXES (D-L65 keyset). For EACH of contact_id and account_id, a valid
 *    index whose keys begin tenant_id, programme_id, <target>, created_at,
 *    id, with created_at and id in the same direction (so it serves
 *    `ORDER BY created_at DESC, id DESC` for one contact or account, newest
 *    first). It may be partial only on `<target> IS NOT NULL`.
 *
 * 7. MIRROR. `activity` is exported from @kasuwa/db (packages/db/src/
 *    schema.ts) and carries exactly the database's columns, each with the
 *    database's type and nullability (read from the Drizzle table object).
 *
 * ------------------------------------------------------------------------
 * THE BUILDER'S (not pinned)
 * ------------------------------------------------------------------------
 * Nullability of subject, body, owner_user_id and created_by_user_id (the
 * probes always supply all four); whether due_at/completed_at are refused
 * on a note or a call; ON DELETE of the target FKs (D-L61 leaves deletion
 * open; NO ACTION or RESTRICT both refuse a lone delete) and how the rotation
 * is refused (ON UPDATE RESTRICT, which the T-0054 review used, or immutable
 * ids on contact and account, D-L76's follow-up); constraint and index names;
 * field_def labels, types of the non-lookup fields, is_required; the object's
 * label; whether the at-least-one-target rule is one CHECK or two; any extra
 * index (an owner index for "my tasks" is welcome); the unique key on contact
 * that the composite FK needs (contact has none today: 0001 has only the
 * PK). Owner membership in the activity's programme (D-L67) is the
 * repository's, as for contacts; this suite does not ask the database for it.
 *
 * ------------------------------------------------------------------------
 * BEYOND THE TASK FILE (suite-writer additions; the lead may rule them out)
 * ------------------------------------------------------------------------
 * - `subject` is classified pii as well as `body`. A subject line is free
 *   text too, and in practice holds names ("Call back Mrs X re arrears").
 *   Classifying only the body would leave the redaction and export paths
 *   (NDPA) reading the subject as harmless.
 * - created_by_user_id carries the composite FK to "user", as owner does: a
 *   creator from another tenant is refused.
 * - The contact/account programme-move refusal and the offboarding check.
 * - kasuwa_app holds no TRUNCATE and does not own the table.
 *
 * ------------------------------------------------------------------------
 * CROSS-SUITE CONSEQUENCES THE BUILDER MUST HANDLE (not edits to suites)
 * ------------------------------------------------------------------------
 * - tests/acceptance/tenancy/schema-hygiene (T-0011) probes every table that
 *   carries updated_at and fails a table with no seeded row and no plant
 *   ("unexercised"). So the seed must carry at least one activity, or the
 *   lead must add a plant there. This suite reads only the ids it plants,
 *   so seeded activities do not disturb it.
 * - The T-0053 and T-0054 legacy-database blocks run the full migration
 *   chain, so this migration must apply over their pre-dating tenants (no
 *   custom `activity` object exists in either).
 *
 * ------------------------------------------------------------------------
 * PII
 * ------------------------------------------------------------------------
 * Body and subject text in this file are invented and name no one. Postgres
 * error `detail` ("Failing row contains (...)") would carry the body: this
 * suite only compares details, it never prints one on success, and T-0061's
 * repository must never log or return one (as D-L74 rules for contact).
 *
 * ------------------------------------------------------------------------
 * HOW THE BACKFILL AND THE CLASH ARE TESTED
 * ------------------------------------------------------------------------
 * The shared harness migrates an EMPTY database, so the migration's backfill
 * runs over zero tenants there and proves nothing. The last block builds a
 * second database in the same container, as the T-0053 and T-0054 suites do:
 * bootstrap, every migration that sorts before the activity migration, three
 * tenants (two with a custom `activity` object), then the rest of the chain
 * (must fail cleanly), then the clash removed and the chain again (must
 * apply). It connects as the container's superuser only to CREATE and DROP
 * that database.
 *
 * Writes: the shared database is reseeded before and after. The three
 * committed activities the isolation tests read are planted by the migrator
 * in beforeAll and removed by the final reseed (TRUNCATE tenant CASCADE).
 * Every other probe runs in a transaction that is rolled back.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'packages/db/migrations');
const BOOTSTRAP_SQL = resolve(REPO_ROOT, 'packages/db/sql/bootstrap.sql');

/** Unique per run, lowercase alphanumeric. */
const RUN = Date.now().toString(36);

/** Fixed ids for this suite: `6060` marks T-0060. */
const id60 = (tail: string): string => `60600000-0000-4000-8000-${tail.padStart(12, '0')}`;

// --- the migration -------------------------------------------------------------

/** `CREATE TABLE activity (`, in any quoting, once SQL line comments are gone. */
const CREATES_ACTIVITY =
  /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?activity"?\s*\(/i;

const stripLineComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');

/** Every migration file whose SQL creates the activity table. */
function activityMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .filter((name) =>
      CREATES_ACTIVITY.test(stripLineComments(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))),
    )
    .sort();
}

const PINNED_CHECKSUMS: Readonly<Record<string, string>> = {
  '0001_tenancy_core': 'ae037c3ef279589f7b3d326b4ce62e63e23f5ce4e0b67a61f3debee0fdc52a89',
  '0018_schema_hygiene': 'a7c3c483c4e4fc144803e626e650ba9ab9fbcc404e07b01ff27abb860e3f0b49',
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

/** pg_attribute, not information_schema: the latter hides columns the reader lacks privileges on. */
const COLUMNS_SQL = `
  SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
         a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS default
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE n.nspname = 'public' AND c.relname = 'activity'
     AND a.attnum > 0 AND NOT a.attisdropped
   ORDER BY a.attnum`;

interface ColumnRow {
  column: string;
  type: string;
  notnull: boolean;
  default: string | null;
}

const TIMESTAMPTZ = 'timestamp with time zone';

/**
 * Every column of `activity`. `notNull: null` is the builder's call.
 * Adding a column (deal_id, calendar fields) is a lead edit of this list.
 */
const COLUMN_SPEC: Readonly<
  Record<string, { type: string; notNull: boolean | null; default?: RegExp }>
> = {
  id: { type: 'uuid', notNull: true },
  tenant_id: { type: 'uuid', notNull: true },
  programme_id: { type: 'uuid', notNull: true },
  type: { type: 'text', notNull: true },
  subject: { type: 'text', notNull: null },
  body: { type: 'text', notNull: null },
  due_at: { type: TIMESTAMPTZ, notNull: false },
  completed_at: { type: TIMESTAMPTZ, notNull: false },
  // T-0082: a meeting's times (lead edit).
  starts_at: { type: TIMESTAMPTZ, notNull: false },
  ends_at: { type: TIMESTAMPTZ, notNull: false },
  owner_user_id: { type: 'uuid', notNull: null },
  contact_id: { type: 'uuid', notNull: false },
  account_id: { type: 'uuid', notNull: false },
  // T-0111: the deal link (lead edit, D-L88).
  deal_id: { type: 'uuid', notNull: false },
  created_by_user_id: { type: 'uuid', notNull: null },
  version: { type: 'integer', notNull: true, default: /^1$/ },
  created_at: { type: TIMESTAMPTZ, notNull: true, default: /^now\(\)$/ },
  updated_at: { type: TIMESTAMPTZ, notNull: true, default: /^now\(\)$/ },
};
const ALL_COLUMNS = Object.keys(COLUMN_SPEC).sort();

/** The business columns: each must be a standard field_def on `activity`. */
const REQUIRED_FIELDS = [
  'account_id',
  'body',
  'completed_at',
  'contact_id',
  'deal_id',
  'due_at',
  'ends_at',
  'owner_user_id',
  'starts_at',
  'subject',
  'type',
];
/** May also be a standard field_def; nothing else may. */
const OPTIONAL_FIELDS = ['created_at', 'created_by_user_id', 'updated_at', 'version'];

const TYPES = ['note', 'task', 'call', 'meeting'];

/** STANDARD activity fields of one tenant, with everything every source must agree on. */
const ACTIVITY_FIELDS_SQL = `
  SELECT f.api_name, f.label, f.type, f.is_required, f.config::text AS config,
         f.classification, f.is_custom
    FROM field_def f
    JOIN object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
   WHERE f.tenant_id = $1 AND o.api_name = 'activity' AND NOT o.is_custom AND NOT f.is_custom
   ORDER BY f.api_name`;

const ACTIVITY_OBJECT_SQL = `
  SELECT api_name, label, plural_label, is_custom
    FROM object_def WHERE tenant_id = $1 AND api_name = 'activity'`;

interface FieldRow {
  api_name: string;
  label: string;
  type: string;
  is_required: boolean;
  config: string;
  classification: string;
  is_custom: boolean;
}

interface ObjectRow {
  api_name: string;
  label: string;
  plural_label: string | null;
  is_custom: boolean;
}

// --- probing -------------------------------------------------------------------

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
 * One statement under a savepoint, deferred checks forced. When `keep` is
 * false (the default) it is ALWAYS rolled back to the savepoint, so every
 * probe starts from the same state; when true, a successful statement's
 * effects stay, so the caller can read the end state.
 */
async function probe(
  query: Query,
  sql: string,
  values: unknown[] = [],
  keep = false,
): Promise<Outcome> {
  await query('SAVEPOINT t0060_probe');
  let outcome: Outcome;
  try {
    await query(sql, values);
    // A DEFERRABLE constraint or constraint trigger fires here, not at COMMIT.
    await query('SET CONSTRAINTS ALL IMMEDIATE');
    outcome = { accepted: true };
  } catch (error) {
    outcome = outcomeOf(error);
  }
  if (keep && outcome.accepted) await query('RELEASE SAVEPOINT t0060_probe');
  else await query('ROLLBACK TO SAVEPOINT t0060_probe');
  return outcome;
}

/** A name for every outcome; a missing table or column is printed verbatim. */
function verdict(outcome: Outcome): string {
  if (outcome.accepted) return 'accepted';
  const { code, message } = outcome;
  if (code === '23503') return 'foreign_key_violation';
  if (code === '23502') return 'not_null_violation';
  if (code === '23505') return 'unique_violation';
  if (code === '42501') return 'insufficient_privilege';
  if (code === 'P0001' || code.startsWith('23') || code.startsWith('22')) return 'refused';
  // 42P01 (no such table) and 42703 (no such column) land here: they say
  // what is missing, which is the honest failure before the build.
  return `error ${code}: ${message}`;
}

/** The pinned meaning of "refused" for rotations, moves and the immutable id. */
const REFUSALS = ['foreign_key_violation', 'refused', 'insufficient_privilege'];

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

// --- fixtures ------------------------------------------------------------------

interface ActivityInput {
  id?: string;
  tenantId: string;
  programmeId: string;
  type?: string | null;
  subject?: string;
  body?: string;
  ownerUserId: string;
  createdByUserId?: string;
  contactId?: string | null;
  accountId?: string | null;
  // T-0082 (D-L107): set only when a probe needs the meeting columns, so that
  // every other probe still runs on a schema without them.
  times?: { startsAt: string | null; endsAt: string | null };
}

const INSERT_ACTIVITY_TIMED = `
  INSERT INTO activity (id, tenant_id, programme_id, type, subject, body,
                        owner_user_id, created_by_user_id, contact_id, account_id,
                        starts_at, ends_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`;

const INSERT_ACTIVITY = `
  INSERT INTO activity (id, tenant_id, programme_id, type, subject, body,
                        owner_user_id, created_by_user_id, contact_id, account_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

function activityValues(input: ActivityInput): unknown[] {
  return [
    input.id ?? randomUUID(),
    input.tenantId,
    input.programmeId,
    input.type === undefined ? 'note' : input.type,
    input.subject ?? 'T-0060 probe subject',
    input.body ?? 'T-0060 probe body: invented text, names no one.',
    input.ownerUserId,
    input.createdByUserId ?? input.ownerUserId,
    input.contactId ?? null,
    input.accountId ?? null,
    ...(input.times === undefined ? [] : [input.times.startsAt, input.times.endsAt]),
  ];
}

const tryInsertActivity = (query: Query, input: ActivityInput) =>
  probe(
    query,
    input.times === undefined ? INSERT_ACTIVITY : INSERT_ACTIVITY_TIMED,
    activityValues(input),
  );

const MEETING_TIMES = {
  startsAt: '2026-11-02T09:00:00Z',
  endsAt: '2026-11-02T10:00:00Z',
};

async function insertActivity(query: Query, input: ActivityInput): Promise<string> {
  const values = activityValues(input);
  await query(INSERT_ACTIVITY, values);
  return String(values[0]);
}

const INSERT_CONTACT = `INSERT INTO contact (id, tenant_id, programme_id, display_name)
                        VALUES ($1, $2, $3, $4)`;
const INSERT_ACCOUNT = `INSERT INTO account (id, tenant_id, programme_id, name)
                        VALUES ($1, $2, $3, $4)`;

/** The first seeded contact of one programme. */
function seededContact(programmeId: string): string {
  const found = SEED_CONTACTS.find((row) => row.programmeId === programmeId);
  if (found === undefined) throw new Error(`no seeded contact in programme ${programmeId}`);
  return found.id;
}

/** The seeded account of one programme. */
function seededAccount(programmeId: string): string {
  const found = SEED_ACCOUNTS.find((row) => row.programmeId === programmeId);
  if (found === undefined) throw new Error(`no seeded account in programme ${programmeId}`);
  return found.id;
}

/**
 * The rotation D-L76 describes, in ONE statement: X takes a fresh id and Y
 * takes X's old one. The unique key is checked row by row, so X must be
 * written before Y: X < Y as uuids, and X is inserted first, so a sequential,
 * bitmap or primary-key scan all reach X first. A probe that reaches Y first
 * raises 23505, which is never counted as a refusal.
 */
const rotationSql = (table: string) => `
  UPDATE ${table}
     SET id = CASE id WHEN $1::uuid THEN $3::uuid ELSE $1::uuid END
   WHERE tenant_id = $4 AND id IN ($1::uuid, $2::uuid)`;

const ROTATE_X = id60('00000000c0a1');
const ROTATE_Y = id60('00000000c0a2');
const ROTATE_FRESH = id60('00000000c0af');

// =============================================================================
// 1-7: the shared harness database
// =============================================================================

describe('acceptance: the activity table (T-0060)', () => {
  /** kasuwa_app — NOBYPASSRLS. Every assertion about what a session may do. */
  let appPool: Pool;
  /** kasuwa_migrator — owns the schema. Catalogue reads, committed fixtures. */
  let migrator: Pool;

  /** Committed activities, one per programme, read by the isolation tests. */
  const ACT_A1 = id60('0000000a0001');
  const ACT_A2 = id60('0000000a0002');
  const ACT_B1 = id60('0000000a0003');
  const PLANTED = [ACT_A1, ACT_A2, ACT_B1];
  /** Why the committed fixtures could not be planted (on main: no table). */
  let plantError: unknown;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 4 });
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 2 });
    try {
      const query: Query = async (text, params) => (await migrator.query(text, params)).rows;
      await insertActivity(query, {
        id: ACT_A1,
        tenantId: TENANT_A,
        programmeId: PROGRAMME_A1,
        type: 'note',
        ownerUserId: USER_A_AGENT_1,
        contactId: seededContact(PROGRAMME_A1),
      });
      await insertActivity(query, {
        id: ACT_A2,
        tenantId: TENANT_A,
        programmeId: PROGRAMME_A2,
        type: 'task',
        ownerUserId: USER_A_AGENT_2,
        contactId: seededContact(PROGRAMME_A2),
        accountId: seededAccount(PROGRAMME_A2),
      });
      await insertActivity(query, {
        id: ACT_B1,
        tenantId: TENANT_B,
        programmeId: PROGRAMME_B1,
        type: 'call',
        ownerUserId: USER_B_AGENT_1,
        accountId: seededAccount(PROGRAMME_B1),
      });
    } catch (error) {
      plantError = error;
    }
  });

  afterAll(async () => {
    await appPool?.end();
    await migrator?.end();
    await reseed(inject('migrationUrl'));
  });

  const requirePlanted = () => {
    expect(
      plantError === undefined ? null : outcomeOf(plantError),
      'the committed activities could not be planted',
    ).toBe(null);
  };

  async function columns(): Promise<Map<string, ColumnRow>> {
    const rows = (await migrator.query<ColumnRow>(COLUMNS_SQL)).rows;
    return new Map(rows.map((row) => [row.column, row]));
  }

  // ---------------------------------------------------------------------------
  // 1. The migration
  // ---------------------------------------------------------------------------
  describe('the migration', () => {
    it('exactly one migration creates the activity table, and the runner applied it', async () => {
      const files = activityMigrationFiles();
      expect(
        files,
        'no single migration in packages/db/migrations creates `activity`',
      ).toHaveLength(1);
      const ids = files.map((name) => name.replace(/\.sql$/, ''));
      const applied = await migrator.query<{ id: string }>(
        'SELECT id FROM _kasuwa_migration WHERE id = ANY ($1::text[])',
        [ids],
      );
      expect(applied.rows.map((row) => row.id)).toEqual(ids);
    });

    it('the migration scan recognises a CREATE TABLE activity and ignores one in a comment', () => {
      // Guards the scan above against a vacuous miss or a false hit.
      expect(CREATES_ACTIVITY.test('CREATE TABLE activity (\n id uuid')).toBe(true);
      expect(CREATES_ACTIVITY.test('create table if not exists public.activity(')).toBe(true);
      expect(CREATES_ACTIVITY.test('CREATE TABLE activity_log (')).toBe(false);
      expect(
        CREATES_ACTIVITY.test(stripLineComments('-- later: CREATE TABLE activity (\nSELECT 1;')),
      ).toBe(false);
    });

    it('leaves 0001, 0018, 0019 and 0025 unedited', () => {
      // Holds on main by construction: it guards the change (contact's new
      // unique key and the catalogue rows go in a new file, never an old one).
      const current = new Map(loadMigrations().map((row) => [row.id, row.checksum]));
      for (const [id, checksum] of Object.entries(PINNED_CHECKSUMS)) {
        expect(current.get(id), `${id} was edited, renamed or removed`).toBe(checksum);
      }
    });

    it('adds no SECURITY DEFINER function: the census is still the two CLAUDE.md 2.7 names', async () => {
      // A regression guard; passes on main.
      const definers = await migrator.query<{ name: string }>(DEFINERS_SQL);
      expect(definers.rows.map((row) => row.name)).toEqual([
        'app.resolve_session',
        'app.resolve_tenant_by_slug',
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Columns and keys
  // ---------------------------------------------------------------------------
  describe('columns and keys', () => {
    it('has exactly the pinned columns: deal_id since T-0111, no calendar fields', async () => {
      const found = [...(await columns()).keys()].sort();
      expect(found.length, 'table activity not found').toBeGreaterThan(0);
      expect(found).toEqual(ALL_COLUMNS);
    });

    it('every column has the pinned type, nullability and default', async () => {
      const found = await columns();
      expect(found.size, 'table activity not found').toBeGreaterThan(0);
      const problems: string[] = [];
      for (const [name, spec] of Object.entries(COLUMN_SPEC)) {
        const column = found.get(name);
        if (column === undefined) {
          problems.push(`${name}: missing`);
          continue;
        }
        if (column.type !== spec.type) {
          problems.push(`${name}: type ${column.type}, expected ${spec.type}`);
        }
        if (spec.notNull !== null && column.notnull !== spec.notNull) {
          problems.push(
            `${name}: ${column.notnull ? 'NOT NULL' : 'nullable'}, expected the opposite`,
          );
        }
        if (spec.default !== undefined && !spec.default.test(column.default ?? '')) {
          problems.push(`${name}: default ${String(column.default)}, expected ${spec.default}`);
        }
      }
      expect(problems, 'activity columns that do not match T-0060').toEqual([]);
    });

    it('id is the primary key', async () => {
      const pk = await migrator.query<{ columns: string[] }>(
        `SELECT array_agg(a.attname::text ORDER BY a.attname) AS columns
           FROM pg_constraint con
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
          WHERE con.contype = 'p' AND con.conrelid = to_regclass('public.activity')
          GROUP BY con.oid`,
      );
      expect(pk.rows.map((row) => row.columns)).toEqual([['id']]);
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
          WHERE con.contype = 'f' AND con.conrelid = to_regclass('public.activity')
          GROUP BY con.oid, ref.relname`,
      );
      return result.rows.map((row) => ({ refTable: row.ref_table, pairs: [...row.pairs].sort() }));
    }

    it.each([
      ['tenant', ['tenant_id->id']],
      ['programme', ['programme_id->id', 'tenant_id->tenant_id']],
      ['user', ['owner_user_id->id', 'tenant_id->tenant_id']],
      ['user', ['created_by_user_id->id', 'tenant_id->tenant_id']],
      ['contact', ['contact_id->id', 'programme_id->programme_id', 'tenant_id->tenant_id']],
      ['account', ['account_id->id', 'programme_id->programme_id', 'tenant_id->tenant_id']],
    ])('a foreign key to %s through %j', async (table, pairs) => {
      const fks = await foreignKeys();
      expect(
        fks.filter((fk) => fk.refTable === table).map((fk) => fk.pairs),
        `activity FKs: ${JSON.stringify(fks)}`,
      ).toContainEqual(pairs);
    });

    it('every foreign key to a tenant-scoped table carries tenant_id', async () => {
      const fks = await foreignKeys();
      expect(fks.length, 'activity has no foreign keys').toBeGreaterThan(0);
      const unscoped = fks.filter(
        (fk) => fk.refTable !== 'tenant' && !fk.pairs.includes('tenant_id->tenant_id'),
      );
      expect(unscoped, 'a FK that would accept another tenant’s row').toEqual([]);
    });

    it('src/schema.ts mirrors every column (name, type, nullability), read from the Drizzle table', async () => {
      const table = (kasuwaDb as unknown as Record<string, unknown>).activity;
      expect(typeof table, '@kasuwa/db exports no `activity` table').toBe('object');
      const mirrored = new Map<string, { sqlType: string; notNull: boolean }>();
      for (const value of Object.values((table ?? {}) as Record<string, unknown>)) {
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
      const database = await columns();
      expect(database.size, 'table activity not found').toBeGreaterThan(0);
      const normalise = (type: string) => (type === 'timestamptz' ? TIMESTAMPTZ : type);
      const fromDatabase = Object.fromEntries(
        [...database.values()].map((row) => [
          row.column,
          `${row.type} ${row.notnull ? 'NOT NULL' : 'NULL'}`,
        ]),
      );
      const fromMirror = Object.fromEntries(
        [...mirrored].map(([name, column]) => [
          name,
          `${normalise(column.sqlType)} ${column.notNull ? 'NOT NULL' : 'NULL'}`,
        ]),
      );
      expect(fromMirror).toEqual(fromDatabase);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Values and triggers, as kasuwa_app
  // ---------------------------------------------------------------------------
  describe('values, as kasuwa_app inside withTenantTransaction', () => {
    const A1_CONTACT = () => seededContact(PROGRAMME_A1);
    const A1_ACCOUNT = () => seededAccount(PROGRAMME_A1);
    const asA1Agent = <T>(fn: (query: Query) => Promise<T>) =>
      rolledBackTenantTx(appPool, TENANT_A, USER_A_AGENT_1, (query) => fn(query));

    it('a new note gets version 1, both timestamps, and no due or completion time', async () => {
      const row = await asA1Agent(async (query) => {
        const id = await insertActivity(query, {
          tenantId: TENANT_A,
          programmeId: PROGRAMME_A1,
          ownerUserId: USER_A_AGENT_1,
          contactId: A1_CONTACT(),
        });
        const rows = await query<Record<string, unknown>>(
          `SELECT version, due_at, completed_at,
                  created_at IS NOT NULL AS has_created_at,
                  updated_at IS NOT NULL AS has_updated_at
             FROM activity WHERE id = $1`,
          [id],
        );
        return rows[0];
      });
      expect(row).toEqual({
        version: 1,
        due_at: null,
        completed_at: null,
        has_created_at: true,
        has_updated_at: true,
      });
    });

    it('type accepts exactly note, task, call and meeting; never a label, a near-miss or NULL', async () => {
      const rejected = ['Note', 'TASK', 'email', 'whatsapp', ' note', 'note ', ''];
      const outcomes = await asA1Agent(async (query) => {
        const result: Record<string, string> = {};
        for (const type of [...TYPES, ...rejected]) {
          result[JSON.stringify(type)] = verdict(
            await tryInsertActivity(query, {
              tenantId: TENANT_A,
              programmeId: PROGRAMME_A1,
              type,
              ownerUserId: USER_A_AGENT_1,
              contactId: A1_CONTACT(),
              // A meeting has its times (D-L107); every other type is probed without.
              ...(type === 'meeting' ? { times: MEETING_TIMES } : {}),
            }),
          );
        }
        const asNull = verdict(
          await tryInsertActivity(query, {
            tenantId: TENANT_A,
            programmeId: PROGRAMME_A1,
            type: null,
            ownerUserId: USER_A_AGENT_1,
            contactId: A1_CONTACT(),
          }),
        );
        // NOT NULL or a CHECK: both are refusals. `type IN (...)` alone
        // passes NULL, which is exactly what this catches.
        result.null = asNull === 'not_null_violation' ? 'refused' : asNull;
        return result;
      });
      expect(outcomes).toEqual({
        ...Object.fromEntries(TYPES.map((type) => [JSON.stringify(type), 'accepted'])),
        ...Object.fromEntries(rejected.map((type) => [JSON.stringify(type), 'refused'])),
        null: 'refused',
      });
    });

    it('a meeting has both times and only a meeting has them, end after start (D-L107)', async () => {
      const outcomes = await asA1Agent(async (query) => {
        const at = (type: string, startsAt: string | null, endsAt: string | null) =>
          tryInsertActivity(query, {
            tenantId: TENANT_A,
            programmeId: PROGRAMME_A1,
            type,
            ownerUserId: USER_A_AGENT_1,
            contactId: A1_CONTACT(),
            times: { startsAt, endsAt },
          }).then(verdict);
        return {
          meetingWithTimes: await at('meeting', MEETING_TIMES.startsAt, MEETING_TIMES.endsAt),
          meetingWithoutTimes: await at('meeting', null, null),
          meetingWithoutEnd: await at('meeting', MEETING_TIMES.startsAt, null),
          meetingWithoutStart: await at('meeting', null, MEETING_TIMES.endsAt),
          meetingEndBeforeStart: await at('meeting', MEETING_TIMES.endsAt, MEETING_TIMES.startsAt),
          meetingEndAtStart: await at('meeting', MEETING_TIMES.startsAt, MEETING_TIMES.startsAt),
          taskWithTimes: await at('task', MEETING_TIMES.startsAt, MEETING_TIMES.endsAt),
          noteWithStart: await at('note', MEETING_TIMES.startsAt, null),
          callWithoutTimes: await at('call', null, null),
        };
      });
      expect(outcomes).toEqual({
        meetingWithTimes: 'accepted',
        meetingWithoutTimes: 'refused',
        meetingWithoutEnd: 'refused',
        meetingWithoutStart: 'refused',
        meetingEndBeforeStart: 'refused',
        meetingEndAtStart: 'refused',
        taskWithTimes: 'refused',
        noteWithStart: 'refused',
        callWithoutTimes: 'accepted',
      });
    });

    it('at least one target: contact, account or both are accepted; neither is refused', async () => {
      const outcomes = await asA1Agent(async (query) => {
        const base = { tenantId: TENANT_A, programmeId: PROGRAMME_A1, ownerUserId: USER_A_AGENT_1 };
        return {
          contactOnly: verdict(
            await tryInsertActivity(query, { ...base, contactId: A1_CONTACT() }),
          ),
          accountOnly: verdict(
            await tryInsertActivity(query, { ...base, accountId: A1_ACCOUNT() }),
          ),
          both: verdict(
            await tryInsertActivity(query, {
              ...base,
              contactId: A1_CONTACT(),
              accountId: A1_ACCOUNT(),
            }),
          ),
          neither: verdict(await tryInsertActivity(query, base)),
        };
      });
      expect(outcomes).toEqual({
        contactOnly: 'accepted',
        accountOnly: 'accepted',
        both: 'accepted',
        neither: 'refused',
      });
    });

    it('an UPDATE cannot clear the last target; it may clear one of two', async () => {
      const outcomes = await asA1Agent(async (query) => {
        const id = await insertActivity(query, {
          tenantId: TENANT_A,
          programmeId: PROGRAMME_A1,
          ownerUserId: USER_A_AGENT_1,
          contactId: A1_CONTACT(),
          accountId: A1_ACCOUNT(),
        });
        const set = (assignments: string) =>
          probe(query, `UPDATE activity SET ${assignments} WHERE tenant_id = $1 AND id = $2`, [
            TENANT_A,
            id,
          ]);
        return {
          clearAccount: verdict(await set('account_id = NULL')),
          clearContact: verdict(await set('contact_id = NULL')),
          clearBoth: verdict(await set('contact_id = NULL, account_id = NULL')),
        };
      });
      expect(outcomes).toEqual({
        clearAccount: 'accepted',
        clearContact: 'accepted',
        clearBoth: 'refused',
      });
    });

    it('a task can be given a due time and completed', async () => {
      const row = await asA1Agent(async (query) => {
        const id = await insertActivity(query, {
          tenantId: TENANT_A,
          programmeId: PROGRAMME_A1,
          type: 'task',
          ownerUserId: USER_A_AGENT_1,
          contactId: A1_CONTACT(),
        });
        const rows = await query<Record<string, unknown>>(
          `UPDATE activity
              SET due_at = '2026-11-02T09:00:00+01:00', completed_at = '2026-11-02T08:30:00Z'
            WHERE tenant_id = $1 AND id = $2
           RETURNING due_at::text = '2026-11-02 08:00:00+00' AS due_in_utc,
                     completed_at IS NOT NULL AS completed`,
          [TENANT_A, id],
        );
        return rows[0];
      });
      // The session's TimeZone is the container's (UTC); the stored instant is
      // what matters, and +01:00 (WAT) lands at 08:00 UTC.
      expect(row).toEqual({ due_in_utc: true, completed: true });
    });

    it('version moves exactly once per UPDATE; updated_at moves unless the statement writes it', async () => {
      const PAST = '2020-01-01 00:00:00+00';
      const steps = await asA1Agent(async (query) => {
        const id = randomUUID();
        await query(
          `INSERT INTO activity (id, tenant_id, programme_id, type, subject, body,
                                 owner_user_id, created_by_user_id, contact_id,
                                 created_at, updated_at)
           VALUES ($1, $2, $3, 'note', 'T-0060 version', 'T-0060 body', $4, $4, $5,
                   $6::timestamptz, $6::timestamptz)`,
          [id, TENANT_A, PROGRAMME_A1, USER_A_AGENT_1, A1_CONTACT(), PAST],
        );
        const step = async (assignments: string) =>
          (
            await query<{ version: number; touched: boolean; updated_at: string }>(
              `UPDATE activity SET ${assignments} WHERE tenant_id = $1 AND id = $2
               RETURNING version, updated_at > $3::timestamptz AS touched,
                         updated_at::text AS updated_at`,
              [TENANT_A, id, PAST],
            )
          )[0];
        return {
          forgetsBoth: await step(`subject = 'T-0060 edited'`),
          bumpsItself: await step(`subject = 'T-0060 again', version = version + 1`),
          writesUpdatedAt: await step(
            `body = 'T-0060 body 2', updated_at = '2021-01-01 00:00:00+00'`,
          ),
        };
      });
      expect(steps.forgetsBoth).toMatchObject({ version: 2, touched: true });
      expect(steps.bumpsItself).toMatchObject({ version: 3, touched: true });
      expect(steps.writesUpdatedAt).toEqual({
        version: 4,
        touched: true,
        updated_at: '2021-01-01 00:00:00+00',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Tenancy
  // ---------------------------------------------------------------------------
  describe('tenancy', () => {
    it('RLS is ENABLED and FORCED; tenant AND programme on every permissive policy; WITH CHECK = USING', async () => {
      const security = (await readTableSecurity(appPool)).find((row) => row.table === 'activity');
      expect(security?.rlsEnabled, 'activity: RLS is not enabled').toBe(true);
      expect(security?.rlsForced, 'activity: RLS is not FORCED').toBe(true);

      const policies = await migrator.query<{
        name: string;
        permissive: boolean;
        using: string | null;
        check: string | null;
      }>(
        `SELECT p.polname AS name, p.polpermissive AS permissive,
                pg_get_expr(p.polqual, p.polrelid) AS using,
                pg_get_expr(p.polwithcheck, p.polrelid) AS check
           FROM pg_policy p WHERE p.polrelid = to_regclass('public.activity')`,
      );
      expect(policies.rows.length, 'activity: has no policy').toBeGreaterThan(0);
      for (const policy of policies.rows.filter((row) => row.permissive)) {
        for (const expression of [policy.using, policy.check]) {
          if (expression === null) continue;
          expect(expression, `activity.${policy.name}`).toContain('current_tenant_id()');
          expect(expression, `activity.${policy.name}`).toContain('current_programme_ids()');
        }
      }
      expect(
        policies.rows.some((row) => row.check !== null && row.check === row.using),
        'activity: no policy with WITH CHECK identical to USING',
      ).toBe(true);
    });

    it('activity is in TENANT_SCOPED_TABLES', () => {
      expect([...TENANT_SCOPED_TABLES]).toContain('activity');
    });

    it('kasuwa_migrator owns it; kasuwa_app reads, inserts and updates, and nothing it can enter may TRUNCATE or bypass RLS', async () => {
      const exists = await migrator.query<{ found: boolean }>(
        `SELECT to_regclass('public.activity') IS NOT NULL AS found`,
      );
      expect(exists.rows[0]?.found, 'table activity not found').toBe(true);
      const owner = await migrator.query<{ owner: string }>(
        `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class
          WHERE oid = to_regclass('public.activity')`,
      );
      expect(owner.rows[0]?.owner).toBe('kasuwa_migrator');

      // UPDATE is column-level (D-L79): the business columns are writable, and
      // the creator, creation time and keys are not, so the timeline actor and
      // order cannot be forged. has_table_privilege(UPDATE) is false for a
      // column-only grant, so UPDATE is checked column by column.
      const app = await migrator.query<Record<string, boolean>>(
        `SELECT has_table_privilege('kasuwa_app', 'public.activity', 'SELECT') AS select,
                has_table_privilege('kasuwa_app', 'public.activity', 'INSERT') AS insert,
                has_any_column_privilege('kasuwa_app', 'public.activity', 'UPDATE') AS update`,
      );
      expect(app.rows[0]).toEqual({ select: true, insert: true, update: true });
      const columns = await migrator.query<{ column: string; writable: boolean }>(
        `SELECT c AS column, has_column_privilege('kasuwa_app', 'public.activity', c, 'UPDATE') AS writable
           FROM unnest(ARRAY['subject', 'body', 'due_at', 'completed_at', 'owner_user_id',
                             'id', 'tenant_id', 'programme_id', 'created_by_user_id', 'created_at']) AS c
          ORDER BY 1`,
      );
      const writable = Object.fromEntries(columns.rows.map((row) => [row.column, row.writable]));
      expect(writable).toEqual({
        body: true,
        completed_at: true,
        created_at: false,
        created_by_user_id: false,
        due_at: true,
        id: false,
        owner_user_id: true,
        programme_id: false,
        subject: true,
        tenant_id: false,
      });

      // Every role kasuwa_app is a member of, whatever the INHERIT option
      // (it can SET ROLE to kasuwa_sweeper, D-L66), and kasuwa_app itself.
      const held = await migrator.query<{ held: string }>(
        `SELECT r.rolname || ':' || x.what AS held
           FROM pg_roles r
          CROSS JOIN LATERAL (
            SELECT 'TRUNCATE' AS what
             WHERE has_table_privilege(r.oid, 'public.activity', 'TRUNCATE')
            UNION ALL
            SELECT 'BYPASSRLS' WHERE r.rolbypassrls
          ) AS x
          WHERE pg_has_role('kasuwa_app', r.oid, 'MEMBER')
          ORDER BY 1`,
      );
      expect(held.rows.map((row) => row.held)).toEqual([]);
    });

    it('each session sees exactly its own programmes’ activities', async () => {
      requirePlanted();
      // Not vacuous: all three exist, committed.
      const all = await migrator.query<{ id: string }>(
        'SELECT id FROM activity WHERE id = ANY ($1::uuid[]) ORDER BY id',
        [PLANTED],
      );
      expect(all.rows.map((row) => row.id)).toEqual([...PLANTED].sort());

      const visible = (tenantId: string, userId: string) =>
        withTenantTransaction(appPool, { tenantId, userId }, async (tx) =>
          (
            await tx.query<{ id: string }>(
              'SELECT id FROM activity WHERE id = ANY ($1::uuid[]) ORDER BY id',
              [PLANTED],
            )
          ).map((row) => row.id),
        );
      expect(await visible(TENANT_A, USER_A_AGENT_1)).toEqual([ACT_A1]);
      expect(await visible(TENANT_A, USER_A_AGENT_2)).toEqual([ACT_A2]);
      expect(await visible(TENANT_A, USER_A_SUPERVISOR)).toEqual([ACT_A1, ACT_A2].sort());
      expect(await visible(TENANT_A, USER_A_NO_PROGRAMME)).toEqual([]);
      expect(await visible(TENANT_B, USER_B_AGENT_1)).toEqual([ACT_B1]);
    });

    it('an A1 session can neither change, delete nor create activities in A2 or tenant B', async () => {
      requirePlanted();
      const outcomes = await rolledBackTenantTx(
        appPool,
        TENANT_A,
        USER_A_AGENT_1,
        async (query) => ({
          updated: (
            await query<{ id: string }>(
              `UPDATE activity SET subject = 'T-0060 hijack' WHERE id = ANY ($1::uuid[]) RETURNING id`,
              [[ACT_A2, ACT_B1]],
            )
          ).map((row) => row.id),
          completed: (
            await query<{ id: string }>(
              `UPDATE activity SET completed_at = now() WHERE id = ANY ($1::uuid[]) RETURNING id`,
              [[ACT_A2, ACT_B1]],
            )
          ).map((row) => row.id),
          deleted: (
            await query<{ id: string }>(
              'DELETE FROM activity WHERE id = ANY ($1::uuid[]) RETURNING id',
              [[ACT_A2, ACT_B1]],
            )
          ).map((row) => row.id),
          insertA2: verdict(
            await tryInsertActivity(query, {
              tenantId: TENANT_A,
              programmeId: PROGRAMME_A2,
              ownerUserId: USER_A_AGENT_1,
              contactId: seededContact(PROGRAMME_A2),
            }),
          ),
          insertB1: verdict(
            await tryInsertActivity(query, {
              tenantId: TENANT_B,
              programmeId: PROGRAMME_B1,
              ownerUserId: USER_B_AGENT_1,
              accountId: seededAccount(PROGRAMME_B1),
            }),
          ),
          moveOwnToA2: verdict(
            await probe(query, 'UPDATE activity SET programme_id = $1 WHERE id = $2', [
              PROGRAMME_A2,
              ACT_A1,
            ]),
          ),
        }),
      );
      expect(outcomes).toEqual({
        updated: [],
        completed: [],
        deleted: [],
        insertA2: 'insufficient_privilege',
        insertB1: 'insufficient_privilege',
        moveOwnToA2: 'insufficient_privilege',
      });
    });

    it('a target in a sibling programme or another tenant is refused, even for a supervisor who sees both programmes', async () => {
      const outcomes = await rolledBackTenantTx(
        appPool,
        TENANT_A,
        USER_A_SUPERVISOR,
        async (query) => {
          const a1 = (targets: { contactId?: string; accountId?: string }) =>
            tryInsertActivity(query, {
              tenantId: TENANT_A,
              programmeId: PROGRAMME_A1,
              ownerUserId: USER_A_SUPERVISOR,
              ...targets,
            });
          return {
            ownContact: verdict(await a1({ contactId: seededContact(PROGRAMME_A1) })),
            // The supervisor can SEE A2's contact and account: RLS is not what
            // refuses these. Only the composite key can.
            siblingContact: verdict(await a1({ contactId: seededContact(PROGRAMME_A2) })),
            siblingAccount: verdict(await a1({ accountId: seededAccount(PROGRAMME_A2) })),
            ownContactSiblingAccount: verdict(
              await a1({
                contactId: seededContact(PROGRAMME_A1),
                accountId: seededAccount(PROGRAMME_A2),
              }),
            ),
            otherTenantContact: verdict(await a1({ contactId: seededContact(PROGRAMME_B1) })),
            otherTenantAccount: verdict(await a1({ accountId: seededAccount(PROGRAMME_B1) })),
            retarget: verdict(
              await probe(
                query,
                'UPDATE activity SET contact_id = $1 WHERE tenant_id = $2 AND id = $3',
                [seededContact(PROGRAMME_A2), TENANT_A, ACT_A1],
              ),
            ),
          };
        },
      );
      expect(outcomes).toEqual({
        ownContact: 'accepted',
        siblingContact: 'foreign_key_violation',
        siblingAccount: 'foreign_key_violation',
        ownContactSiblingAccount: 'foreign_key_violation',
        otherTenantContact: 'foreign_key_violation',
        otherTenantAccount: 'foreign_key_violation',
        retarget: 'foreign_key_violation',
      });
    });

    /** Each id replaced by a placeholder, so a real and an invented id compare equal. */
    const normalise = (outcome: Outcome, ids: string[]) => {
      if (outcome.accepted) return 'accepted';
      const scrub = (text: string) => ids.reduce((acc, id) => acc.split(id).join('<id>'), text);
      return { code: outcome.code, message: scrub(outcome.message), detail: scrub(outcome.detail) };
    };

    it.each([
      ['contact', () => seededContact(PROGRAMME_A2), 'contactId'],
      ['account', () => seededAccount(PROGRAMME_A2), 'accountId'],
    ] as const)(
      'a real A2 %s id is refused exactly as an invented one (no existence oracle)',
      async (_what, realTarget, field) => {
        // An agent in A1 only. The A2 row exists; the invented id does not.
        // If the two errors differ in any way, an A1 agent can enumerate A2.
        const invented = randomUUID();
        const fixedId = id60('0000000d0001');
        const [real, fake] = await rolledBackTenantTx(
          appPool,
          TENANT_A,
          USER_A_AGENT_1,
          async (query) => {
            const attempt = (target: string) =>
              tryInsertActivity(query, {
                id: fixedId,
                tenantId: TENANT_A,
                programmeId: PROGRAMME_A1,
                ownerUserId: USER_A_AGENT_1,
                [field]: target,
              });
            return [await attempt(realTarget()), await attempt(invented)] as const;
          },
        );
        expect(verdict(real)).toBe('foreign_key_violation');
        expect(normalise(real, [realTarget()])).toEqual(normalise(fake, [invented]));
      },
    );

    it('an owner or creator from tenant B is refused, exactly as an invented user id', async () => {
      const invented = randomUUID();
      const outcomes = await rolledBackTenantTx(
        appPool,
        TENANT_A,
        USER_A_AGENT_1,
        async (query) => {
          const base = {
            id: id60('0000000d0002'),
            tenantId: TENANT_A,
            programmeId: PROGRAMME_A1,
            contactId: seededContact(PROGRAMME_A1),
          };
          return {
            ownerB: await tryInsertActivity(query, {
              ...base,
              ownerUserId: USER_B_AGENT_1,
              createdByUserId: USER_A_AGENT_1,
            }),
            ownerInvented: await tryInsertActivity(query, {
              ...base,
              ownerUserId: invented,
              createdByUserId: USER_A_AGENT_1,
            }),
            creatorB: await tryInsertActivity(query, {
              ...base,
              ownerUserId: USER_A_AGENT_1,
              createdByUserId: USER_B_AGENT_1,
            }),
            reassignToB: await probe(
              query,
              'UPDATE activity SET owner_user_id = $1 WHERE tenant_id = $2 AND id = $3',
              [USER_B_AGENT_1, TENANT_A, ACT_A1],
            ),
          };
        },
      );
      expect({
        ownerB: verdict(outcomes.ownerB),
        ownerInvented: verdict(outcomes.ownerInvented),
        creatorB: verdict(outcomes.creatorB),
        reassignToB: verdict(outcomes.reassignToB),
      }).toEqual({
        ownerB: 'foreign_key_violation',
        ownerInvented: 'foreign_key_violation',
        creatorB: 'foreign_key_violation',
        reassignToB: 'foreign_key_violation',
      });
      expect(normalise(outcomes.ownerB, [USER_B_AGENT_1])).toEqual(
        normalise(outcomes.ownerInvented, [invented]),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 5. FK actions: rotation, moves, immutable id, offboarding (D-L74, D-L76)
  // ---------------------------------------------------------------------------
  describe('referenced keys cannot be rotated or moved out from under an activity', () => {
    it('self-check: on NO ACTION tables the probe statement really rotates and re-points', async () => {
      // Throwaway tables with the activity -> contact shape. Without this, a
      // "refused" below could mean the probe never rotated anything. Plain
      // tables, not TEMP (the bootstrap gives no role TEMP), created inside a
      // transaction that is always rolled back, so no other session or suite
      // ever sees them in the catalogue.
      const result = await rolledBackMigratorTx(migrator, async (query) => {
        await query(`CREATE TABLE t0060_parent (
                       id uuid PRIMARY KEY, tenant_id uuid NOT NULL, programme_id uuid NOT NULL,
                       label text NOT NULL, UNIQUE (tenant_id, programme_id, id))`);
        await query(`CREATE TABLE t0060_child (
                       id uuid PRIMARY KEY, tenant_id uuid NOT NULL, programme_id uuid NOT NULL,
                       parent_id uuid,
                       FOREIGN KEY (tenant_id, programme_id, parent_id)
                         REFERENCES t0060_parent (tenant_id, programme_id, id))`);
        await query(`CREATE TABLE t0060_child_restrict (
                       id uuid PRIMARY KEY, tenant_id uuid NOT NULL, programme_id uuid NOT NULL,
                       parent_id uuid,
                       FOREIGN KEY (tenant_id, programme_id, parent_id)
                         REFERENCES t0060_parent (tenant_id, programme_id, id) ON UPDATE RESTRICT)`);
        for (const [id, label] of [
          [ROTATE_X, 'X'],
          [ROTATE_Y, 'Y'],
        ] as const) {
          await query(
            'INSERT INTO t0060_parent (id, tenant_id, programme_id, label) VALUES ($1, $2, $3, $4)',
            [id, TENANT_A, PROGRAMME_A1, label],
          );
        }
        const child = randomUUID();
        await query(
          'INSERT INTO t0060_child (id, tenant_id, programme_id, parent_id) VALUES ($1, $2, $3, $4)',
          [child, TENANT_A, PROGRAMME_A1, ROTATE_X],
        );
        const params = [ROTATE_X, ROTATE_Y, ROTATE_FRESH, TENANT_A];
        await query('SAVEPOINT t0060_self_check');
        const noAction = verdict(await probe(query, rotationSql('t0060_parent'), params, true));
        const pointsAt = await query<{ label: string }>(
          `SELECT p.label FROM t0060_child c
             JOIN t0060_parent p ON p.tenant_id = c.tenant_id AND p.id = c.parent_id
            WHERE c.id = $1`,
          [child],
        );
        // Undo, then show RESTRICT refuses the very same statement.
        await query('ROLLBACK TO SAVEPOINT t0060_self_check');
        await query('DELETE FROM t0060_child');
        await query(
          `INSERT INTO t0060_child_restrict (id, tenant_id, programme_id, parent_id)
           VALUES ($1, $2, $3, $4)`,
          [child, TENANT_A, PROGRAMME_A1, ROTATE_X],
        );
        const restrict = verdict(await probe(query, rotationSql('t0060_parent'), params));
        return { noAction, nowPointsAt: pointsAt[0]?.label, restrict };
      });
      expect(result).toEqual({
        noAction: 'accepted',
        nowPointsAt: 'Y',
        restrict: 'foreign_key_violation',
      });
    });

    it.each([
      ['contact', INSERT_CONTACT, 'contactId', 'display_name'],
      ['account', INSERT_ACCOUNT, 'accountId', 'name'],
    ] as const)(
      'a one-statement rotation of %s ids is refused, and the activity still points at its row',
      async (table, insertSql, field, labelColumn) => {
        const result = await rolledBackTenantTx(
          appPool,
          TENANT_A,
          USER_A_AGENT_1,
          async (query) => {
            await query(insertSql, [ROTATE_X, TENANT_A, PROGRAMME_A1, 'T-0060 rotate X']);
            await query(insertSql, [ROTATE_Y, TENANT_A, PROGRAMME_A1, 'T-0060 rotate Y']);
            const activityId = await insertActivity(query, {
              tenantId: TENANT_A,
              programmeId: PROGRAMME_A1,
              ownerUserId: USER_A_AGENT_1,
              [field]: ROTATE_X,
            });
            const outcome = await probe(
              query,
              rotationSql(table),
              [ROTATE_X, ROTATE_Y, ROTATE_FRESH, TENANT_A],
              true,
            );
            const target = table === 'contact' ? 'contact_id' : 'account_id';
            const pointsAt = await query<{ label: string }>(
              `SELECT t.${labelColumn} AS label FROM activity a
                 JOIN ${table} t ON t.tenant_id = a.tenant_id AND t.id = a.${target}
                WHERE a.id = $1`,
              [activityId],
            );
            return { verdict: verdict(outcome), pointsAt: pointsAt.map((row) => row.label) };
          },
        );
        expect(REFUSALS, `the rotation was ${result.verdict}`).toContain(result.verdict);
        expect(result.pointsAt, 'the activity was re-pointed').toEqual(['T-0060 rotate X']);
      },
    );

    it('a contact or account with activities cannot move to a sibling programme; nor can the activity leave its target’s', async () => {
      const outcomes = await rolledBackTenantTx(
        appPool,
        TENANT_A,
        USER_A_SUPERVISOR,
        async (query) => {
          const contactId = randomUUID();
          const accountId = randomUUID();
          await query(INSERT_CONTACT, [contactId, TENANT_A, PROGRAMME_A1, 'T-0060 mover']);
          await query(INSERT_ACCOUNT, [accountId, TENANT_A, PROGRAMME_A1, 'T-0060 mover']);
          const onContact = await insertActivity(query, {
            tenantId: TENANT_A,
            programmeId: PROGRAMME_A1,
            ownerUserId: USER_A_SUPERVISOR,
            contactId,
          });
          await insertActivity(query, {
            tenantId: TENANT_A,
            programmeId: PROGRAMME_A1,
            ownerUserId: USER_A_SUPERVISOR,
            accountId,
          });
          const move = (table: string, id: string) =>
            probe(query, `UPDATE ${table} SET programme_id = $1 WHERE tenant_id = $2 AND id = $3`, [
              PROGRAMME_A2,
              TENANT_A,
              id,
            ]);
          return {
            contact: verdict(await move('contact', contactId)),
            account: verdict(await move('account', accountId)),
            activity: verdict(await move('activity', onContact)),
          };
        },
      );
      // ON UPDATE CASCADE would carry the activity, body and all, into A2.
      for (const [what, outcome] of Object.entries(outcomes)) {
        expect(REFUSALS, `moving the ${what} was ${outcome}`).toContain(outcome);
      }
    });

    it('activity.id is immutable for kasuwa_app', async () => {
      const result = await rolledBackTenantTx(appPool, TENANT_A, USER_A_AGENT_1, async (query) => {
        const id = await insertActivity(query, {
          tenantId: TENANT_A,
          programmeId: PROGRAMME_A1,
          ownerUserId: USER_A_AGENT_1,
          contactId: seededContact(PROGRAMME_A1),
        });
        const fresh = randomUUID();
        const outcome = await probe(
          query,
          'UPDATE activity SET id = $1 WHERE tenant_id = $2 AND id = $3',
          [fresh, TENANT_A, id],
          true,
        );
        const ids = await query<{ id: string }>(
          'SELECT id FROM activity WHERE id = ANY ($1::uuid[])',
          [[id, fresh]],
        );
        return { outcome: verdict(outcome), ids: ids.map((row) => row.id), id };
      });
      // Refused outright, or silently kept: either way the id never changes.
      expect(['accepted', ...REFUSALS], `the id change was ${result.outcome}`).toContain(
        result.outcome,
      );
      expect(result.ids, 'activity.id changed').toEqual([result.id]);
    });

    it('offboarding still cascades: kasuwa_migrator deletes a programme, then a tenant, that hold activities', async () => {
      const result = await rolledBackMigratorTx(migrator, async (query) => {
        const tenantId = randomUUID();
        const bu = randomUUID();
        const [p1, p2] = [randomUUID(), randomUUID()];
        const user = randomUUID();
        await query(`INSERT INTO tenant (id, name, slug) VALUES ($1, 'T-0060 Leaving Ltd', $2)`, [
          tenantId,
          `t0060-leaving-${RUN}`,
        ]);
        await query(
          `INSERT INTO business_unit (id, tenant_id, name) VALUES ($1, $2, 'Head office')`,
          [bu, tenantId],
        );
        await query(
          `INSERT INTO programme (id, tenant_id, business_unit_id, name, is_default)
           VALUES ($1, $3, $4, 'Default', true), ($2, $3, $4, 'Client Two', false)`,
          [p1, p2, tenantId, bu],
        );
        await query(
          `INSERT INTO "user" (id, tenant_id, email, display_name)
           VALUES ($1, $2, $3, 'T-0060 Agent')`,
          [user, tenantId, `agent.${RUN}@t0060.test`],
        );
        for (const programmeId of [p1, p2]) {
          const contactId = randomUUID();
          const accountId = randomUUID();
          await query(INSERT_CONTACT, [contactId, tenantId, programmeId, 'T-0060 leaving']);
          await query(INSERT_ACCOUNT, [accountId, tenantId, programmeId, 'T-0060 leaving']);
          const base = { tenantId, programmeId, ownerUserId: user };
          await insertActivity(query, { ...base, contactId });
          await insertActivity(query, { ...base, accountId });
          await insertActivity(query, { ...base, contactId, accountId });
        }
        const count = async (column: string, id: string) =>
          (
            await query<{ n: number }>(
              `SELECT count(*)::int AS n FROM activity WHERE ${column} = $1`,
              [id],
            )
          )[0]?.n;
        const before = await count('tenant_id', tenantId);
        const programme = verdict(
          await probe(query, 'DELETE FROM programme WHERE id = $1', [p2], true),
        );
        const afterProgramme = await count('programme_id', p2);
        const tenant = verdict(
          await probe(query, 'DELETE FROM tenant WHERE id = $1', [tenantId], true),
        );
        const afterTenant = await count('tenant_id', tenantId);
        return { before, programme, afterProgramme, tenant, afterTenant };
      });
      expect(result).toEqual({
        before: 6,
        programme: 'accepted',
        afterProgramme: 0,
        tenant: 'accepted',
        afterTenant: 0,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Indexes
  // ---------------------------------------------------------------------------
  describe('indexes', () => {
    async function activityIndexes() {
      const result = await migrator.query<{
        name: string;
        valid: boolean;
        predicate: string | null;
        keys: string[];
      }>(
        `SELECT i.relname AS name, x.indisvalid AS valid,
                pg_get_expr(x.indpred, x.indrelid) AS predicate,
                ARRAY(SELECT pg_get_indexdef(x.indexrelid, k, true)
                        FROM generate_series(1, x.indnkeyatts) AS k ORDER BY k) AS keys
           FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
          WHERE x.indrelid = to_regclass('public.activity')`,
      );
      return result.rows;
    }

    it.each(['contact_id', 'account_id'])(
      'a keyset index for one %s, newest first: tenant_id, programme_id, target, created_at, id',
      async (target) => {
        const indexes = await activityIndexes();
        const direction = (key: string | undefined, column: string) =>
          new RegExp(`^${column}( DESC)?$`).exec(key ?? '')?.[1] ?? null;
        const serving = indexes.filter((index) => {
          const createdAt = /^created_at( DESC)?$/.exec(index.keys[3] ?? '');
          const id = /^id( DESC)?$/.exec(index.keys[4] ?? '');
          return (
            index.valid &&
            (index.predicate === null ||
              new RegExp(`^\\(?${target} IS NOT NULL\\)?$`).test(index.predicate)) &&
            index.keys[0] === 'tenant_id' &&
            index.keys[1] === 'programme_id' &&
            index.keys[2] === target &&
            createdAt !== null &&
            id !== null &&
            direction(index.keys[3], 'created_at') === direction(index.keys[4], 'id')
          );
        });
        expect(serving.length, `activity indexes: ${JSON.stringify(indexes)}`).toBeGreaterThan(0);
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 7. Metadata
  // ---------------------------------------------------------------------------
  describe('activity is a standard object with a field for each business column', () => {
    const asMigrator: () => Query = () => async (text, params) =>
      (await migrator.query(text, params)).rows;

    /** Every rule a tenant's standard activity catalogue must meet; returns the problems. */
    function catalogueProblems(objects: ObjectRow[], fields: FieldRow[]): string[] {
      const problems: string[] = [];
      if (objects.length !== 1 || objects[0]?.is_custom !== false) {
        problems.push(`object_def activity: ${JSON.stringify(objects)}, expected one standard row`);
      }
      const names = fields.map((row) => row.api_name);
      for (const name of REQUIRED_FIELDS.filter((field) => !names.includes(field))) {
        problems.push(`${name}: no standard field_def`);
      }
      for (const name of names.filter(
        (field) => !REQUIRED_FIELDS.includes(field) && !OPTIONAL_FIELDS.includes(field),
      )) {
        problems.push(`${name}: a standard field_def that names no business column`);
      }
      const byName = new Map(fields.map((row) => [row.api_name, row]));
      for (const [name, target] of [
        ['contact_id', 'contact'],
        ['account_id', 'account'],
        ['deal_id', 'deal'],
      ] as const) {
        const row = byName.get(name);
        if (row === undefined) continue;
        // Compare the parsed value, not the text: Postgres renders jsonb as
        // `{"targetObjectApiName": "contact"}`, with a space JSON.stringify
        // never writes. Found by the T-0060 builder; the stored rows were right.
        let config: unknown;
        try {
          config = JSON.parse(row.config);
        } catch {
          config = undefined;
        }
        const isLookupTo =
          typeof config === 'object' &&
          config !== null &&
          Object.keys(config).length === 1 &&
          (config as Record<string, unknown>).targetObjectApiName === target;
        if (row.type !== 'lookup' || !isLookupTo) {
          problems.push(`${name}: ${row.type} ${row.config}, expected a lookup to ${target}`);
        }
      }
      for (const name of ['body', 'subject']) {
        const row = byName.get(name);
        if (row !== undefined && row.classification !== 'pii') {
          problems.push(`${name}: classified ${row.classification}, expected pii`);
        }
      }
      return problems;
    }

    it.each(SEED_TENANTS.map((tenant) => [tenant.slug, tenant.id] as const))(
      '%s: one standard activity object, a field per business column, lookups and pii as pinned',
      async (_slug, tenantId) => {
        const objects = await asMigrator()<ObjectRow>(ACTIVITY_OBJECT_SQL, [tenantId]);
        const fields = await asMigrator()<FieldRow>(ACTIVITY_FIELDS_SQL, [tenantId]);
        expect(catalogueProblems(objects, fields)).toEqual([]);
      },
    );

    it('the catalogue check rejects a body or subject not classified pii, and a stray field', () => {
      // Guards catalogueProblems against a vacuous pass.
      const field = (api_name: string, extra: Partial<FieldRow> = {}): FieldRow => ({
        api_name,
        label: api_name,
        type: 'text',
        is_required: false,
        config: '{}',
        classification: 'pii',
        is_custom: false,
        ...extra,
      });
      const object: ObjectRow = {
        api_name: 'activity',
        label: 'Activity',
        plural_label: null,
        is_custom: false,
      };
      const good = REQUIRED_FIELDS.map((name) =>
        name === 'contact_id'
          ? field(name, { type: 'lookup', config: '{"targetObjectApiName":"contact"}' })
          : name === 'account_id'
            ? field(name, { type: 'lookup', config: '{"targetObjectApiName":"account"}' })
            : field(name),
      );
      expect(catalogueProblems([object], good)).toEqual([]);
      expect(
        catalogueProblems(
          [object],
          good.map((row) => (row.api_name === 'body' ? { ...row, classification: 'none' } : row)),
        ),
      ).toEqual(['body: classified none, expected pii']);
      expect(catalogueProblems([object], [...good, field('tenant_id')])).toHaveLength(1);
      expect(catalogueProblems([], good)).toHaveLength(1);
    });

    it('ensureStandardObjectDefs gives a fresh tenant exactly the seeded tenants’ activity catalogue', async () => {
      const seededObject = await asMigrator()<ObjectRow>(ACTIVITY_OBJECT_SQL, [TENANT_A]);
      const seededFields = await asMigrator()<FieldRow>(ACTIVITY_FIELDS_SQL, [TENANT_A]);
      const fresh = await rolledBackMigratorTx(migrator, async (query) => {
        const tenantId = randomUUID();
        await query(`INSERT INTO tenant (id, name, slug) VALUES ($1, 'T-0060 Fresh Ltd', $2)`, [
          tenantId,
          `t0060-fresh-${RUN}`,
        ]);
        await ensureStandardObjectDefs((text, values) => query(text, [...values]), tenantId);
        return {
          objects: await query<ObjectRow>(ACTIVITY_OBJECT_SQL, [tenantId]),
          fields: await query<FieldRow>(ACTIVITY_FIELDS_SQL, [tenantId]),
        };
      });
      expect(catalogueProblems(fresh.objects, fresh.fields)).toEqual([]);
      expect(fresh.objects).toEqual(seededObject);
      expect(fresh.fields).toEqual(seededFields);
    });
  });
});

// =============================================================================
// 8: the migration over tenants that pre-date it — the clash, then the backfill
// =============================================================================

describe('acceptance: the activity migration over tenants that pre-date it (T-0060)', () => {
  const database = `kasuwa_t0060_${RUN}`;
  const LEGACY_1 = id60('000000000001');
  const LEGACY_2 = id60('000000000002');
  const LEGACY_3 = id60('000000000003');
  /** Two tenants' own custom `activity` objects: the clash. */
  const CLASH_OBJECTS = [id60('0000000000f1'), id60('0000000000f2')];
  /** Not clashes, in the third tenant: a custom object and two custom fields. */
  const ACTIVITY_LOG = id60('0000000000f3');
  const CONTACT_ACTIVITY_FIELD = id60('0000000000f4');
  const LOG_SUBJECT_FIELD = id60('0000000000f5');

  let superuserUrl: URL | undefined;
  let legacy: Pool | undefined;
  let mainObserver: Pool;
  const tempDirs: string[] = [];

  /** Why the database could not be staged (on main: there is no activity migration). */
  let setupError: unknown;
  let activityMigrationId = '';
  let clashError: unknown;
  let afterClash: { migrations: string[]; activityTable: boolean; standardActivity: number } = {
    migrations: [],
    activityTable: false,
    standardActivity: 0,
  };
  let finalError: unknown;
  let tablesBefore: string[] = [];
  let definersBefore: string[] = [];

  /** A directory holding only the migrations whose file name sorts before `bound`. */
  function migrationsBefore(bound: string): string {
    const dir = mkdtempSync(join(tmpdir(), 't0060-pre-'));
    tempDirs.push(dir);
    for (const name of readdirSync(MIGRATIONS_DIR)) {
      if (name.endsWith('.sql') && name < bound) {
        copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
      }
    }
    return dir;
  }

  const pool = (): Pool => {
    if (legacy === undefined) throw new Error('the pre-dating database was not built');
    return legacy;
  };

  const requireStaged = () => {
    expect(
      setupError === undefined ? null : String(setupError),
      'the pre-dating database could not be staged',
    ).toBe(null);
  };

  async function snapshot(p: Pool) {
    const migrations = (
      await p.query<{ id: string }>('SELECT id FROM _kasuwa_migration ORDER BY id')
    ).rows.map((row) => row.id);
    const table = await p.query<{ found: boolean }>(
      `SELECT to_regclass('public.activity') IS NOT NULL AS found`,
    );
    const standard = await p.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM object_def WHERE api_name = 'activity' AND NOT is_custom`,
    );
    return {
      migrations,
      activityTable: table.rows[0]?.found === true,
      standardActivity: standard.rows[0]?.n ?? -1,
    };
  }

  beforeAll(async () => {
    mainObserver = createPool({ connectionString: inject('migrationUrl'), max: 1 });
    const files = activityMigrationFiles();
    const file = files[0];
    if (files.length !== 1 || file === undefined) {
      setupError = new Error(
        `expected exactly one migration that creates activity, found ${files.length}`,
      );
      return;
    }
    activityMigrationId = file.replace(/\.sql$/, '');

    try {
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
          readFileSync(BOOTSTRAP_SQL, 'utf8').replace(
            /\bDATABASE kasuwa\b/g,
            `DATABASE ${database}`,
          ),
        );
      } finally {
        await bootstrap.end();
      }

      const url = new URL(migrationUrl.href);
      url.pathname = `/${database}`;
      const legacyUrl = url.href;

      // The chain before 0025, then the tenants, then the chain before this
      // migration (0025 backfills their contact and account objects): the
      // state of a cell that has run every release before this one.
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
      await runMigrations({ connectionString: legacyUrl, migrationsDir: migrationsBefore(file) });

      // The clash (D-P24): two tenants made a custom object called
      // `activity`, one of them with a field on it. The third tenant has
      // things that only LOOK related: a custom object `activity_log` with a
      // `subject` field, and a custom field `activity` on its contact object.
      for (const [index, tenantId] of [LEGACY_1, LEGACY_2].entries()) {
        await pool().query(
          `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
           VALUES ($1, $2, 'activity', 'Site activity', true)`,
          [CLASH_OBJECTS[index], tenantId],
        );
      }
      await pool().query(
        `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, is_custom)
         VALUES (gen_random_uuid(), $1, $2, 'visit_note', 'Visit note', 'text', true)`,
        [LEGACY_1, CLASH_OBJECTS[0]],
      );
      await pool().query(
        `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
         VALUES ($1, $2, 'activity_log', 'Activity log', true)`,
        [ACTIVITY_LOG, LEGACY_3],
      );
      await pool().query(
        `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, is_custom)
         VALUES ($1, $2, $3, 'subject', 'Subject', 'text', true)`,
        [LOG_SUBJECT_FIELD, LEGACY_3, ACTIVITY_LOG],
      );
      const contactObject = (
        await pool().query<{ id: string }>(
          `SELECT id FROM object_def WHERE tenant_id = $1 AND api_name = 'contact' AND NOT is_custom`,
          [LEGACY_3],
        )
      ).rows[0];
      if (contactObject === undefined) throw new Error('0025 did not backfill contact');
      await pool().query(
        `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, is_custom)
         VALUES ($1, $2, $3, 'activity', 'Activity', 'text', true)`,
        [CONTACT_ACTIVITY_FIELD, LEGACY_3, contactObject.id],
      );

      tablesBefore = (await pool().query<{ name: string }>(PUBLIC_TABLES_SQL)).rows.map(
        (row) => row.name,
      );
      definersBefore = (await pool().query<{ name: string }>(DEFINERS_SQL)).rows.map(
        (row) => row.name,
      );

      // Phase 1: the rest of the chain must stop at this migration.
      try {
        await runMigrations({ connectionString: legacyUrl });
      } catch (error) {
        clashError = error;
      }
      afterClash = await snapshot(pool());

      // Phase 2: a human resolves the clash (field_def cascades); the chain
      // then applies.
      await pool().query('DELETE FROM object_def WHERE id = ANY ($1::uuid[])', [CLASH_OBJECTS]);
      try {
        await runMigrations({ connectionString: legacyUrl });
      } catch (error) {
        finalError = error;
      }
    } catch (error) {
      setupError = error;
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

  it('a custom `activity` object in two tenants stops the migration, naming the object and the count', () => {
    requireStaged();
    expect(
      clashError,
      'the migration applied over two tenants’ custom activity object',
    ).toBeInstanceOf(Error);
    const message = clashError instanceof Error ? clashError.message : String(clashError);
    // The runner prefixes "Migration <id> failed:"; a failure elsewhere in
    // the chain is not this one.
    expect(message, 'the failure is not the activity migration’s').toContain(activityMigrationId);
    expect(message).toMatch(/\bactivity\b/);
    expect(message, 'the count of tenants affected (2)').toMatch(/\b2\b/);
    // The third tenant's activity_log, its subject field and contact.activity
    // are not clashes: counting them means the pre-check matched loosely.
    expect(message, 'a look-alike in a third tenant was counted').not.toMatch(/\b3\b/);
  });

  it('and nothing of it was applied: no ledger row, no table, no standard activity object', () => {
    requireStaged();
    // Without a failure to inspect, the checks below hold trivially, so demand one first.
    expect(clashError, 'there was no failed migration to inspect').toBeInstanceOf(Error);
    expect(afterClash.migrations).not.toContain(activityMigrationId);
    expect(afterClash.activityTable).toBe(false);
    expect(afterClash.standardActivity).toBe(0);
  });

  it('once the clash is resolved, the migration applies', async () => {
    requireStaged();
    expect(finalError === undefined ? null : String(finalError)).toBe(null);
    const applied = await pool().query<{ id: string }>(
      'SELECT id FROM _kasuwa_migration WHERE id = $1',
      [activityMigrationId],
    );
    expect(applied.rows, 'the activity migration was not applied').toHaveLength(1);
  });

  it.each([
    ['a tenant that had the clash, with a field on it', LEGACY_1],
    ['a tenant that had the clash', LEGACY_2],
    ['a tenant with look-alikes only', LEGACY_3],
  ])(
    'backfills %s with exactly the activity catalogue the seed writes',
    async (_what, tenantId) => {
      requireStaged();
      const seededObject = (await mainObserver.query<ObjectRow>(ACTIVITY_OBJECT_SQL, [TENANT_A]))
        .rows;
      const seededFields = (await mainObserver.query<FieldRow>(ACTIVITY_FIELDS_SQL, [TENANT_A]))
        .rows;
      expect(
        REQUIRED_FIELDS.filter((name) => !seededFields.some((row) => row.api_name === name)),
        'the seeded tenant itself lacks activity fields',
      ).toEqual([]);
      const object = (await pool().query<ObjectRow>(ACTIVITY_OBJECT_SQL, [tenantId])).rows;
      const fields = (await pool().query<FieldRow>(ACTIVITY_FIELDS_SQL, [tenantId])).rows;
      expect(object).toEqual(seededObject);
      expect(fields).toEqual(seededFields);
    },
  );

  it('keeps the look-alikes, still custom', async () => {
    requireStaged();
    const rows = await pool().query<{ id: string; is_custom: boolean }>(
      `SELECT id, is_custom FROM object_def WHERE id = $1
       UNION ALL
       SELECT id, is_custom FROM field_def WHERE id = ANY ($2::uuid[])
       ORDER BY id`,
      [ACTIVITY_LOG, [CONTACT_ACTIVITY_FIELD, LOG_SUBJECT_FIELD]],
    );
    expect(rows.rows).toEqual(
      [ACTIVITY_LOG, CONTACT_ACTIVITY_FIELD, LOG_SUBJECT_FIELD]
        .sort()
        .map((id) => ({ id, is_custom: true })),
    );
  });

  it('adds only tables that meet the tenancy invariants, and no SECURITY DEFINER function', async () => {
    requireStaged();
    expect(definersBefore.length, 'the census before the migration read nothing').toBe(2);
    expect(
      (await pool().query<{ name: string }>(DEFINERS_SQL)).rows.map((row) => row.name),
    ).toEqual(definersBefore);
    const after = (await pool().query<{ name: string }>(PUBLIC_TABLES_SQL)).rows.map(
      (row) => row.name,
    );
    const added = after.filter((name) => !tablesBefore.includes(name) && !name.startsWith('_'));
    // Not vacuous: activity itself is among the added tables.
    expect(added).toContain('activity');
    const problems: string[] = [];
    for (const table of added) {
      if (!(TENANT_SCOPED_TABLES as readonly string[]).includes(table)) {
        problems.push(`${table}: not in TENANT_SCOPED_TABLES`);
      }
      const state = (
        await pool().query<{ enabled: boolean; forced: boolean; tenant: boolean }>(
          `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
                  EXISTS (SELECT 1 FROM pg_attribute a
                           WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                             AND NOT a.attisdropped) AS tenant
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = $1`,
          [table],
        )
      ).rows[0];
      if (state?.tenant !== true) problems.push(`${table}: no tenant_id`);
      if (state?.enabled !== true || state.forced !== true) {
        problems.push(`${table}: RLS not enabled and forced`);
      }
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
