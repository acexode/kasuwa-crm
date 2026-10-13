import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BU_A,
  createPool,
  ensureStandardObjectDefs,
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
import { createProgramme } from '@kasuwa/domain-core';
import { reseed } from '@kasuwa/testing';
import { Client, type Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * ACCEPTANCE — T-0106, the pipeline and deal TABLES and the DEFAULT PIPELINE
 * (P06; Agent 3; migration only, no API: T-0107 and T-0108 serve these).
 *
 * Sources: team/tasks/T-0106-pipeline-tables.md; D-L88 (the six tables, the
 * 0027 pattern, stage kinds, the transition seed rule), D-L113 (a default
 * pipeline per programme, seeded at provisioning and backfilled), D-L115
 * (currencies NGN/GHS/KES/ZAR, deal `name` and `nextStep` are pii), D-L76
 * (the allow-list key guard; RESTRICT against id rotation), D-L65 (no
 * populated cell; plain DDL), D-P33 (indexes on plain columns, LEAKPROOF is
 * checked, never set); the T-0105 contract, docs/api/records.openapi.yaml
 * (Pipeline, PipelineStage, StageRequirement, Deal, DealMoney), read as
 * parsed YAML; the catalogue recipe in
 * packages/db/src/standard-object-catalogue.ts; CLAUDE.md 2.1, 2.3, 2.4, 2.7.
 *
 * Written from the invariants before any implementation (D-L23, D-L25). The
 * model suites are records/activity-table (T-0060) and the table section of
 * scripting/script-runs (T-0114). Helpers are restated here, never shared, so
 * no other suite can change this one's meaning. Where this file and the YAML
 * disagree, the YAML is right and this file is the defect: say so in the
 * report, do not edit it.
 *
 * ---------------------------------------------------------------------------
 * PINNED (the builder must honour these exactly)
 * ---------------------------------------------------------------------------
 *
 * M. MIGRATION. ONE migration file creates all six tables (found by `CREATE
 *    TABLE <name> (`, comments stripped, NOT by number; the task reserves
 *    0036), and the runner applied it. No SECURITY DEFINER function is added:
 *    the census stays at app.resolve_session and app.resolve_tenant_by_slug
 *    (CLAUDE.md 2.7). Nothing is marked LEAKPROOF (D-P33): the migration's
 *    LEAKPROOF self-check reads `proleakproof` and only reads it, and the set
 *    of LEAKPROOF functions is the same before and after the migration.
 *
 * C. COLUMNS, exactly these (R1). `null` nullability is the builder's.
 *      pipeline                 id, tenant_id, programme_id, name text,
 *                               version integer DEFAULT 1, created_at,
 *                               updated_at (timestamptz DEFAULT now())
 *      pipeline_stage           id, tenant_id, programme_id, pipeline_id,
 *                               name text, kind text, position integer,
 *                               probability_bp integer,
 *                               rotting_after_days integer NULL DEFAULT 14
 *      pipeline_stage_transition id, tenant_id, programme_id, pipeline_id,
 *                               from_stage_id, to_stage_id
 *      pipeline_stage_requirement id, tenant_id, programme_id, pipeline_id,
 *                               stage_id, kind text, position integer,
 *                               field text NULL, label text NULL
 *      deal                     id, tenant_id, programme_id, pipeline_id,
 *                               stage_id, name text, amount_minor
 *                               bigint NULL, currency text NULL,
 *                               expected_close_date date NULL,
 *                               owner_user_id, primary_contact_id,
 *                               account_id (uuid NULL), next_step text NULL,
 *                               stage_entered_at timestamptz NOT NULL,
 *                               closed_at timestamptz NULL, version integer
 *                               DEFAULT 1, created_at, updated_at
 *      deal_requirement_check   id, tenant_id, programme_id, pipeline_id,
 *                               deal_id, requirement_id, checked_by_user_id,
 *                               checked_at timestamptz DEFAULT now()
 *    Every table: `id uuid` is the primary key; tenant_id and programme_id
 *    are uuid NOT NULL.
 *
 * T. TENANCY, per table: RLS ENABLED and FORCED; every permissive policy
 *    names app.current_tenant_id() and app.current_programme_ids(); one has
 *    WITH CHECK identical to USING; listed in TENANT_SCOPED_TABLES; owned by
 *    kasuwa_migrator; nothing kasuwa_app can enter holds TRUNCATE or
 *    BYPASSRLS. As kasuwa_app in withTenantTransaction: each session sees
 *    exactly its own programmes' rows; an A1 session cannot change rows of A2
 *    or tenant B, nor write a row into them.
 *
 * G. GRANTS (no DELETE where the contract has none: R13 of T-0105 has no
 *    configuration write and no deal deletion). kasuwa_app, and every role it
 *    can enter, holds NO DELETE on any of the six. kasuwa_app holds SELECT on
 *    all six; INSERT and UPDATE on `deal`; INSERT and NO UPDATE on
 *    `deal_requirement_check` (R7). INSERT and UPDATE on the four
 *    configuration tables are the builder's (the provisioning path may need
 *    INSERT, R9).
 *
 * F. FOREIGN KEYS. Every table has a composite FK (tenant_id, programme_id)
 *    -> programme. Each reference to another tenant-scoped row carries
 *    tenant_id, and each reference to a programme-scoped row (pipeline,
 *    stage, requirement, deal, contact, account) also carries programme_id:
 *    referential checks ignore RLS, so only the key keeps a row in its
 *    programme. EVERY FK is ON UPDATE RESTRICT (D-L76). The deal's contact
 *    and account FKs are never ON DELETE CASCADE (R8).
 *
 * K. KEYS (D-L76, the allow-list guard). As kasuwa_app and as
 *    kasuwa_test_admin (BYPASSRLS), `id` and the parent references (a stage's
 *    pipeline, a transition's stages, a requirement's stage, a deal's
 *    pipeline, a check's deal and requirement) cannot be changed: refused or
 *    silently kept, the END STATE is asserted. The control is a trigger-free,
 *    FK-free copy of each table (`CREATE TABLE ... (LIKE ...)`) on which every
 *    probe statement really changes the row; and kasuwa_migrator, the one
 *    allowed role, can change a leaf row's id. A one-statement rotation of
 *    stage ids or contact ids is refused while a deal references one (the
 *    NO ACTION control proves the statement rotates). A contact with a deal
 *    cannot move programme. Offboarding still works: kasuwa_migrator deletes
 *    a programme, then a tenant, holding all six kinds of row.
 *
 * S. STAGES. kind is exactly open, won or lost; a pipeline has exactly one
 *    won and one lost stage (none and two are both refused, the check runs by
 *    COMMIT at the latest: probes force `SET CONSTRAINTS ALL IMMEDIATE`) and
 *    at most 30 stages (30 accepted, 31 refused); rotting_after_days is 2 to
 *    365 (1 and 366 refused), DEFAULT 14. These hold for kasuwa_migrator too:
 *    BYPASSRLS bypasses no CHECK.
 *
 * D. DEALS, as kasuwa_app: amount_minor is bigint (D-L121), 0 to 18 nines (0
 *    and 18 nines accepted; -1, 10^18 and a fraction such as '1.5' refused); currency is exactly NGN,
 *    GHS, KES or ZAR (USD, a lower-case code and the empty string refused);
 *    a deal's stage is a stage of its own pipeline; its pipeline, primary
 *    contact and account are in its programme, even for a supervisor who
 *    sees both programmes; a contact, account or owner of tenant B is
 *    refused; a real A2 contact id and a real tenant-B user id fail exactly
 *    as invented ones (no existence oracle).
 *
 * P. DEFAULT PIPELINE (D-L113). Every programme has exactly ONE pipeline
 *    built from THE TEMPLATE (R3): the seeded programmes, a programme made by
 *    createProgramme (R9), the default programme of a provisionTenant
 *    tenant, and every programme that pre-dates the migration, whatever its
 *    status (the backfill, R11). Re-running is idempotent: runMigrations
 *    again, and ensureStandardObjectDefs again, change nothing (same ids).
 *
 * O. THE DEAL STANDARD OBJECT. Every tenant has exactly one STANDARD
 *    `object_def` named `deal`, with STANDARD field_defs for name, amount,
 *    expected_close_date, owner_user_id, primary_contact_id, account_id and
 *    next_step, and nothing outside R13's list; `name` and `next_step` are
 *    classified `pii` (D-L115). The seed, ensureStandardObjectDefs on a fresh
 *    tenant, provisionTenant and the backfill write the same rows (label,
 *    type, is_required, config, classification).
 *
 * I. INDEXES (D-P33). Every index on the six tables is valid, has no
 *    expression key and no function call in its predicate. The board's two
 *    orders are served by an index as kasuwa_app under FORCE RLS (R14).
 *
 * ---------------------------------------------------------------------------
 * RULINGS BEYOND THE TASK FILE (R-numbers are this suite's; the lead accepts
 * or reverses each)
 * ---------------------------------------------------------------------------
 *  R1  The exact column lists above. Notably: `id uuid` is the primary key of
 *      all six (transitions and checks included, so every row has one key);
 *      `pipeline_id` is carried by transition, requirement and check rows so
 *      that composite FKs, not triggers, keep each in its pipeline; a
 *      requirement has a `position` (the contract's array order); NO
 *      `is_default` or template column (a programme has exactly one pipeline
 *      until pipeline.write exists), NO created_by on deal (the contract has
 *      none; the audit names the actor).
 *  R2  A `field` requirement stores the field_def api_name (snake_case):
 *      amount, expected_close_date, next_step, primary_contact_id,
 *      account_id. The wire's camelCase (`expectedCloseDate`) is refused.
 *      Field security keys on api_name, so a requirement joins to it as is.
 *  R3  THE TEMPLATE is the contract's getPipeline example, read from the
 *      YAML: "B2B sales", Qualified / Discovery / Proposal / Negotiation /
 *      Contract (open), Won, Lost, with its probabilities, rotting days and
 *      requirements (kind, field, label, in order); version 1. Its
 *      transitions are exactly the contract's seed rule (forward one stage,
 *      back to any earlier open stage, won only from the last open stage,
 *      lost from any open stage, won and lost back to any open stage, no
 *      self-pair), which reproduces the example's 30 pairs (a self-check
 *      that runs on main). The design's probabilities (P06 Deals Screen)
 *      agree.
 *  R4  Stage rules the schema can hold, beyond the task: at least one open
 *      stage; won is 10000 bp and lost 0; probability 0..10000; position
 *      0..99, unique in its pipeline; rotting_after_days set on an open stage
 *      and NULL on won and lost; at most 20 requirements per stage; a `field`
 *      requirement has a field and no label, a `check` requirement a label
 *      of 1 to 200 characters and no field; kind is exactly field or check.
 *      A transition never pairs a stage with itself, both ends are stages of
 *      its pipeline, and a pair appears once.
 *  R5  "stage_id changes only through the move path": the part the schema
 *      can hold is that kasuwa_app can only change a deal's stage along a
 *      transition of its pipeline. Off the allow-list is refused; on it is
 *      accepted; writing the same stage is accepted.
 *  R6  amount_minor and currency are both set or both NULL (DealMoney is the
 *      pair). Text bounds from the contract: deal name 1..200, next_step
 *      1..200 when set, pipeline and stage name 1..100.
 *  R7  deal_requirement_check: once per deal and requirement; only a `check`
 *      requirement of the deal's own pipeline; checked_by has a composite FK
 *      to "user"; kasuwa_app may insert but never update or delete it ("a
 *      recorded check stays recorded", T-0105 R6).
 *  R8  The deal's contact and account FKs are not ON DELETE CASCADE: deleting
 *      a contact never silently deletes a deal (D-P27's sweeper decides).
 *  R9  THE PROVISIONING PATH is `createProgramme` (@kasuwa/domain-core), used
 *      by provisionTenant AND the admin API: when its transaction commits,
 *      the new programme has its default pipeline. TRAP: in the admin API it
 *      runs as kasuwa_app, whose scope was resolved before the programme
 *      existed. Solving that must not widen a policy or add a SECURITY
 *      DEFINER function (0015's created-in-this-transaction marker is the
 *      precedent).
 *  R10 THE DEPLOY-WINDOW REPAIR (as 0034's header): ensureStandardObjectDefs
 *      (query, tenantId) leaves every programme of the tenant with exactly
 *      one default pipeline, so a programme inserted with plain SQL (the
 *      seed, or a previous release after the migrate) is repaired by it. A
 *      second call changes nothing.
 *  R11 Archived, paused and draft programmes are backfilled as well (archived
 *      is restorable for 30 days).
 *  R12 The catalogue recipe's clash pre-check: a tenant's CUSTOM object named
 *      `deal` stops the migration before anything changes, with a message
 *      naming `deal` and the number of such tenants; look-alikes (a custom
 *      `deal_note` object, a custom `deal` field on contact) are not counted.
 *  R13 Deal field_defs: required `name`, `amount`, `expected_close_date`,
 *      `owner_user_id`, `primary_contact_id`, `account_id`, `next_step`;
 *      allowed `pipeline_id`, `stage_id`, `stage_entered_at`, `closed_at`,
 *      `version`, `created_at`, `updated_at`; nothing else (not
 *      `amount_minor` or `currency`: the withholdable wire field is `amount`;
 *      not id, tenant_id, programme_id). primary_contact_id is a lookup to
 *      contact and account_id a lookup to account (activity's convention).
 *  R14 The board's open column (one stage, `stage_entered_at` then `id`
 *      ascending) and won column (one stage, `closed_at` then `id`
 *      descending) are each read by an index scan with no Sort node, as
 *      kasuwa_app inside withTenantTransaction, with sequential scans, bitmap
 *      scans and sorts disabled. That is what "plain columns" buys under
 *      FORCE RLS, observed rather than assumed.
 *  R15 deal.version and deal.updated_at are maintained by the existing
 *      triggers (app.bump_version, app.touch_updated_at).
 *
 * ---------------------------------------------------------------------------
 * THE BUILDER'S (not pinned)
 * ---------------------------------------------------------------------------
 * Constraint, trigger, index and policy names; whether the won/lost/count
 * rules are CHECKs, unique partial indexes or (deferred) constraint
 * triggers; ON DELETE between the pipeline tables; whether kasuwa_app may
 * INSERT or UPDATE configuration; the migrator's freedom from R5; the deal
 * object's label and the non-lookup field types; stage_entered_at's default;
 * any extra index; whether a deal's owner must be a member of its programme
 * (D-L67: the repository's, as for contacts); closed_at's agreement with the
 * stage kind and the first open stage having no requirements (both need the
 * stage's kind or order at write time: the API's).
 *
 * NOT TESTABLE HERE, said rather than faked:
 *  - pipeline's own key guard. Every pipeline has stages, and their RESTRICT
 *    FKs refuse any change to its id, tenant or programme first, so no
 *    statement can tell a guard from the FK. The probe still runs (it must
 *    leave the row unchanged), but it is not evidence of the guard; the
 *    migration review is.
 *
 * ---------------------------------------------------------------------------
 * CROSS-SUITE CONSEQUENCES (for the builder; not edits to other suites)
 * ---------------------------------------------------------------------------
 *  - schema-hygiene (T-0011) probes every table carrying updated_at and fails
 *    one with no seeded row: the seed needs at least one deal (pipelines it
 *    gets by P).
 *  - The T-0053/T-0054/T-0060 legacy-database blocks run the whole chain over
 *    their own pre-dating tenants: the backfill must apply there too.
 *  - rls-enforcement, schema-hygiene and migration-runner must still pass
 *    unmodified (task file).
 *
 * VACUOUS-PASS GUARDS. Before the build, the six tables do not exist: the
 * committed fixtures cannot be planted, and every test that needs them fails
 * first on `requirePlanted` with the real reason (42P01). Every "refused"
 * probe runs beside an "accepted" control in the same session, and verdict()
 * never counts 42P01 or 42703 as a refusal. The self-checks that pass on main
 * say so.
 *
 * PII. Deal names, next steps and labels here are invented and name no one.
 * Postgres `detail` ("Failing row contains ...") would carry a deal name: this
 * suite compares details and never prints one on success.
 *
 * WRITES. Each top-level block reseeds before and after. Committed fixtures
 * use this suite's id range (`0106....-0000-4000-8000-...`); every other
 * probe is rolled back.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'packages/db/migrations');
const BOOTSTRAP_SQL = resolve(REPO_ROOT, 'packages/db/sql/bootstrap.sql');
const RECORDS_SPEC = resolve(REPO_ROOT, 'docs/api/records.openapi.yaml');

/** Unique per run, lowercase alphanumeric. */
const RUN = Date.now().toString(36);

/** This suite's ids: `0106` marks T-0106; `scope` separates fixture sets (4 hex digits). */
const idIn =
  (scope: string) =>
  (tail: string): string =>
    `0106${scope}-0000-4000-8000-${tail.padStart(12, '0')}`;
const id106 = idIn('0000');

const TABLES = [
  'pipeline',
  'pipeline_stage',
  'pipeline_stage_transition',
  'pipeline_stage_requirement',
  'deal',
  'deal_requirement_check',
] as const;
type Table = (typeof TABLES)[number];

type Json = Record<string, unknown>;

// --- the migration -------------------------------------------------------------

const stripLineComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');

const createsTable = (table: string): RegExp =>
  new RegExp(
    `\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"?public"?\\.)?"?${table}"?\\s*\\(`,
    'i',
  );

/** Every migration file whose SQL creates `table`. */
function migrationsCreating(table: string): string[] {
  const pattern = createsTable(table);
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .filter((name) =>
      pattern.test(stripLineComments(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))),
    )
    .sort();
}

/**
 * D-P33: the migration may READ `proleakproof`, and may never mark anything
 * LEAKPROOF. Comments and string literals are removed first (a RAISE message
 * may say "not LEAKPROOF"), then the column name; any LEAKPROOF left is a
 * marking. Returns the problems.
 */
function leakproofProblems(sql: string): string[] {
  const code = stripLineComments(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
  const problems: string[] = [];
  if (!/\bproleakproof\b/i.test(code)) problems.push('no LEAKPROOF self-check (proleakproof)');
  if (/\bLEAKPROOF\b/i.test(code.replace(/\bproleakproof\b/gi, ' '))) {
    problems.push('marks something LEAKPROOF');
  }
  return problems;
}

/** The SECURITY DEFINER census, CLAUDE.md 2.7. */
const DEFINERS_SQL = `
  SELECT n.nspname || '.' || p.proname AS name
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   ORDER BY 1`;

const LEAKPROOF_SQL = `SELECT p.oid::regprocedure::text AS name FROM pg_proc p
                        WHERE p.proleakproof ORDER BY 1`;

const PUBLIC_TABLES_SQL = `
  SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
   ORDER BY 1`;

// --- columns ---------------------------------------------------------------------

const TIMESTAMPTZ = 'timestamp with time zone';

interface ColumnSpec {
  type: string;
  /** `null`: the builder's. */
  notNull: boolean | null;
  /** Pinned default, matched against pg_get_expr; absent: the builder's. */
  default?: RegExp;
  /** The column must have no default. */
  noDefault?: true;
}

const KEYS: Record<string, ColumnSpec> = {
  id: { type: 'uuid', notNull: true },
  tenant_id: { type: 'uuid', notNull: true },
  programme_id: { type: 'uuid', notNull: true },
};
const NOW = /^now\(\)$/;

const COLUMN_SPEC: Readonly<Record<Table, Readonly<Record<string, ColumnSpec>>>> = {
  pipeline: {
    ...KEYS,
    name: { type: 'text', notNull: true },
    version: { type: 'integer', notNull: true, default: /^1$/ },
    created_at: { type: TIMESTAMPTZ, notNull: true, default: NOW },
    updated_at: { type: TIMESTAMPTZ, notNull: true, default: NOW },
  },
  pipeline_stage: {
    ...KEYS,
    pipeline_id: { type: 'uuid', notNull: true },
    name: { type: 'text', notNull: true },
    kind: { type: 'text', notNull: true },
    position: { type: 'integer', notNull: true },
    probability_bp: { type: 'integer', notNull: true },
    rotting_after_days: { type: 'integer', notNull: false, default: /^14$/ },
  },
  pipeline_stage_transition: {
    ...KEYS,
    pipeline_id: { type: 'uuid', notNull: true },
    from_stage_id: { type: 'uuid', notNull: true },
    to_stage_id: { type: 'uuid', notNull: true },
  },
  pipeline_stage_requirement: {
    ...KEYS,
    pipeline_id: { type: 'uuid', notNull: true },
    stage_id: { type: 'uuid', notNull: true },
    kind: { type: 'text', notNull: true },
    position: { type: 'integer', notNull: true },
    field: { type: 'text', notNull: false },
    label: { type: 'text', notNull: false },
  },
  deal: {
    ...KEYS,
    pipeline_id: { type: 'uuid', notNull: true },
    stage_id: { type: 'uuid', notNull: true },
    name: { type: 'text', notNull: true },
    amount_minor: { type: 'bigint', notNull: false, noDefault: true },
    currency: { type: 'text', notNull: false, noDefault: true },
    expected_close_date: { type: 'date', notNull: false },
    owner_user_id: { type: 'uuid', notNull: false },
    primary_contact_id: { type: 'uuid', notNull: false },
    account_id: { type: 'uuid', notNull: false },
    next_step: { type: 'text', notNull: false },
    stage_entered_at: { type: TIMESTAMPTZ, notNull: true },
    closed_at: { type: TIMESTAMPTZ, notNull: false },
    version: { type: 'integer', notNull: true, default: /^1$/ },
    created_at: { type: TIMESTAMPTZ, notNull: true, default: NOW },
    updated_at: { type: TIMESTAMPTZ, notNull: true, default: NOW },
  },
  deal_requirement_check: {
    ...KEYS,
    pipeline_id: { type: 'uuid', notNull: true },
    deal_id: { type: 'uuid', notNull: true },
    requirement_id: { type: 'uuid', notNull: true },
    checked_by_user_id: { type: 'uuid', notNull: true },
    checked_at: { type: TIMESTAMPTZ, notNull: true, default: NOW },
  },
};

/** pg_attribute, not information_schema: the latter hides columns the reader lacks privileges on. */
const COLUMNS_SQL = `
  SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
         a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = to_regclass('public.' || $1::text)
     AND a.attnum > 0 AND NOT a.attisdropped
   ORDER BY a.attnum`;

interface ColumnRow {
  column: string;
  type: string;
  notnull: boolean;
  default: string | null;
}

/** Every FK of a table, as `local->foreign` pairs, with its actions. */
const FOREIGN_KEYS_SQL = `
  SELECT ref.relname AS ref_table, con.confupdtype::text AS on_update,
         con.confdeltype::text AS on_delete,
         array_agg(la.attname || '->' || fa.attname ORDER BY la.attname) AS pairs
    FROM pg_constraint con
    JOIN pg_class ref ON ref.oid = con.confrelid
   CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(local_att, foreign_att)
    JOIN pg_attribute la ON la.attrelid = con.conrelid AND la.attnum = k.local_att
    JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.foreign_att
   WHERE con.contype = 'f' AND con.conrelid = to_regclass('public.' || $1::text)
   GROUP BY con.oid, ref.relname, con.confupdtype, con.confdeltype`;

interface ForeignKey {
  refTable: string;
  pairs: string[];
  onUpdate: string;
  onDelete: string;
}

/**
 * The references F pins: table -> [referenced table, local column]. Each must
 * be covered by ONE FK carrying tenant_id, programme_id (except "user") and
 * `<local>->id`.
 */
const REFERENCES: Readonly<Record<Table, readonly (readonly [string, string])[]>> = {
  pipeline: [],
  pipeline_stage: [['pipeline', 'pipeline_id']],
  pipeline_stage_transition: [
    ['pipeline_stage', 'from_stage_id'],
    ['pipeline_stage', 'to_stage_id'],
  ],
  pipeline_stage_requirement: [['pipeline_stage', 'stage_id']],
  deal: [
    ['pipeline_stage', 'stage_id'],
    ['contact', 'primary_contact_id'],
    ['account', 'account_id'],
    ['user', 'owner_user_id'],
  ],
  deal_requirement_check: [
    ['deal', 'deal_id'],
    ['pipeline_stage_requirement', 'requirement_id'],
    ['user', 'checked_by_user_id'],
  ],
};

/** Problems with one table's FKs against F. Pure, so the self-check can plant defects. */
function foreignKeyProblems(table: Table, fks: readonly ForeignKey[]): string[] {
  const problems: string[] = [];
  if (
    !fks.some(
      (fk) =>
        fk.refTable === 'programme' &&
        fk.pairs.includes('tenant_id->tenant_id') &&
        fk.pairs.includes('programme_id->id'),
    )
  ) {
    problems.push(`${table}: no composite FK (tenant_id, programme_id) -> programme`);
  }
  for (const fk of fks) {
    if (fk.refTable !== 'tenant' && !fk.pairs.includes('tenant_id->tenant_id')) {
      problems.push(`${table} -> ${fk.refTable}: FK without tenant_id ${fk.pairs.join(',')}`);
    }
    // confupdtype: r = RESTRICT. NO ACTION ('a') accepts a one-statement key
    // rotation; CASCADE ('c') would carry rows across programmes.
    if (fk.onUpdate !== 'r') {
      problems.push(`${table} -> ${fk.refTable}: ON UPDATE is '${fk.onUpdate}', not RESTRICT`);
    }
  }
  for (const [target, column] of REFERENCES[table]) {
    const covering = fks.filter(
      (fk) =>
        fk.refTable === target &&
        fk.pairs.includes('tenant_id->tenant_id') &&
        (target === 'user' || fk.pairs.includes('programme_id->programme_id')) &&
        fk.pairs.includes(`${column}->id`),
    );
    if (covering.length === 0) {
      problems.push(
        `${table}.${column}: no composite FK to ${target} through tenant and programme`,
      );
    }
    if (table === 'deal' && (target === 'contact' || target === 'account')) {
      for (const fk of covering.filter((candidate) => candidate.onDelete === 'c')) {
        problems.push(`deal.${column} -> ${fk.refTable}: ON DELETE CASCADE (R8)`);
      }
    }
  }
  return problems;
}

// --- probing -------------------------------------------------------------------

type Query = <R extends QueryResultRow>(sql: string, values?: unknown[]) => Promise<R[]>;

type Outcome =
  | { accepted: true; rows: number }
  | { accepted: false; code: string; message: string; detail: string };

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
 * Statements under ONE savepoint, then deferred constraints forced. When
 * `keep` is false (the default) it is ALWAYS rolled back to the savepoint,
 * so every probe starts from the same state. `rows` counts the rows the
 * statements returned (use RETURNING to see whether an UPDATE matched).
 */
async function probe(
  query: Query,
  statements: string | readonly (readonly [string, unknown[]])[],
  values: unknown[] = [],
  keep = false,
  /** false: judge the statements alone, leaving deferred rules for later. */
  deferred = true,
): Promise<Outcome> {
  const list: readonly (readonly [string, unknown[]])[] =
    typeof statements === 'string' ? [[statements, values]] : statements;
  await query('SAVEPOINT t0106_probe');
  let outcome: Outcome;
  try {
    let rows = 0;
    for (const [sql, params] of list) rows += (await query(sql, params)).length;
    // A DEFERRABLE constraint or constraint trigger fires here, not at COMMIT.
    if (deferred) await query('SET CONSTRAINTS ALL IMMEDIATE');
    outcome = { accepted: true, rows };
  } catch (error) {
    outcome = outcomeOf(error);
  }
  if (keep && outcome.accepted) await query('RELEASE SAVEPOINT t0106_probe');
  else await query('ROLLBACK TO SAVEPOINT t0106_probe');
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

/** "Refused" for keys, references and rotations. Never 42P01/42703. */
const REFUSALS = ['foreign_key_violation', 'refused', 'insufficient_privilege'];
/** For the stage-count and kind rules, a unique partial index is a legitimate mechanism. */
const RULE_REFUSALS = [...REFUSALS, 'unique_violation', 'not_null_violation'];

class Rollback<T> {
  constructor(readonly value: T) {}
}

/** withTenantTransaction, but nothing commits: the callback's value is carried out by a throw. */
async function rolledBackTenantTx<T>(
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

/** A plain transaction on `pool` (migrator or test admin) that is always rolled back. */
async function rolledBackTx<T>(pool: Pool, fn: (query: Query) => Promise<T>): Promise<T> {
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

/**
 * INSERT a copy of one row with some columns overridden, naming only the
 * columns the current role may insert.
 */
async function cloneSql(query: Query, table: string): Promise<string> {
  const columns = await query<{ quoted: string }>(
    `SELECT quote_ident(a.attname) AS quoted
       FROM pg_attribute a
      WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attgenerated = ''
        AND has_column_privilege(current_user, a.attrelid, a.attnum, 'INSERT')
      ORDER BY a.attnum`,
    [`public.${table}`],
  );
  const list = columns.map((column) => column.quoted);
  return `INSERT INTO ${table} (${list.join(', ')})
          SELECT ${list.map((column) => `r.${column}`).join(', ')}
            FROM ${table} s,
                 LATERAL jsonb_populate_record(NULL::${table}, to_jsonb(s) || $2::jsonb) AS r
           WHERE s.id = $1`;
}

/** One-statement id rotation (D-L76): X takes a fresh id and Y takes X's old one. */
const rotationSql = (table: string) => `
  UPDATE ${table}
     SET id = CASE id WHEN $1::uuid THEN $3::uuid ELSE $1::uuid END
   WHERE tenant_id = $4 AND id IN ($1::uuid, $2::uuid)`;

// --- fixtures ------------------------------------------------------------------

function seededContacts(programmeId: string): [string, string] {
  const found = SEED_CONTACTS.filter((row) => row.programmeId === programmeId).map((row) => row.id);
  const [first, second] = found;
  if (first === undefined || second === undefined) {
    throw new Error(`fewer than two seeded contacts in ${programmeId}`);
  }
  return [first, second];
}

function seededAccount(programmeId: string): string {
  const found = SEED_ACCOUNTS.find((row) => row.programmeId === programmeId);
  if (found === undefined) throw new Error(`no seeded account in programme ${programmeId}`);
  return found.id;
}

/**
 * One fixture pipeline. Stage ids sort S0 < S1 < SLEAF so that a rotation
 * reaches S1 before SLEAF (a probe that reaches Y first raises 23505, never
 * counted as a refusal).
 *
 *   P: S0 open(0), S1 open(1), SLEAF open(2), SW won(3), SL lost(4)
 *   transitions: S0>S1, S1>S0, S0>SL, S1>SL, S1>SW, SW>S0, SL>S0 (TLEAF = S0>S1)
 *   requirements on S1: RF field amount(0), RC check(1), RC2 check(2, leaf)
 *   deals: D in S1 (contact, account, owner), DLEAF in S0
 *   check: K = D ticks RC
 *
 * SLEAF, TLEAF, RC2, DLEAF and K are LEAVES: nothing references them, so
 * only a key guard can stop a change to their keys.
 */
interface Fixture {
  tenantId: string;
  programmeId: string;
  owner: string;
  currency: string;
  contact: string;
  account: string;
  P: string;
  S0: string;
  S1: string;
  SLEAF: string;
  SW: string;
  SL: string;
  TLEAF: string;
  transitions: string[];
  RF: string;
  RC: string;
  RC2: string;
  D: string;
  DLEAF: string;
  K: string;
}

function fixture(
  make: (tail: string) => string,
  tenantId: string,
  programmeId: string,
  owner: string,
  currency: string,
  contact: string,
  account: string,
): Fixture {
  return {
    tenantId,
    programmeId,
    owner,
    currency,
    contact,
    account,
    P: make('a0001'),
    S0: make('b0000'),
    S1: make('b0001'),
    SLEAF: make('b0002'),
    SW: make('b0003'),
    SL: make('b0004'),
    TLEAF: make('c0001'),
    transitions: ['c0001', 'c0002', 'c0003', 'c0004', 'c0005', 'c0006', 'c0007'].map(make),
    RF: make('d0001'),
    RC: make('d0002'),
    RC2: make('d0003'),
    D: make('e0001'),
    DLEAF: make('e0002'),
    K: make('f0001'),
  };
}

const INSERT_PIPELINE = `INSERT INTO pipeline (id, tenant_id, programme_id, name)
                         VALUES ($1, $2, $3, $4)`;

/** Stages as one multi-row statement, so a statement-level rule sees them all. */
function insertStagesSql(count: number): string {
  const rows = Array.from({ length: count }, (_unused, index) => {
    const at = index * 7;
    return `($${at + 1}::uuid, $${at + 2}::uuid, $${at + 3}::uuid, $${at + 4}::uuid, $${at + 5}::text, $${at + 6}::text, $${at + 7}::integer)`;
  });
  // probability and rotting follow the kind, so a probe varies one thing at a time.
  return `INSERT INTO pipeline_stage (id, tenant_id, programme_id, pipeline_id, name, kind, position,
                                      probability_bp, rotting_after_days)
          SELECT v.id, v.tenant_id, v.programme_id, v.pipeline_id, v.name, v.kind, v.position,
                 CASE v.kind WHEN 'won' THEN 10000 WHEN 'lost' THEN 0 ELSE 5000 END,
                 CASE WHEN v.kind = 'open' THEN 14 END
            FROM (VALUES ${rows.join(', ')}) AS v (id, tenant_id, programme_id, pipeline_id, name, kind, position)`;
}

interface StageInput {
  id: string;
  kind: string;
  position: number;
}

const stageStatement = (
  tenantId: string,
  programmeId: string,
  pipelineId: string,
  stages: readonly StageInput[],
): readonly [string, unknown[]] => [
  insertStagesSql(stages.length),
  stages.flatMap((stage) => [
    stage.id,
    tenantId,
    programmeId,
    pipelineId,
    `T-0106 stage ${stage.position}`,
    stage.kind,
    stage.position,
  ]),
];

const INSERT_TRANSITION = `INSERT INTO pipeline_stage_transition
                             (id, tenant_id, programme_id, pipeline_id, from_stage_id, to_stage_id)
                           VALUES ($1, $2, $3, $4, $5, $6)`;
const INSERT_REQUIREMENT = `INSERT INTO pipeline_stage_requirement
                              (id, tenant_id, programme_id, pipeline_id, stage_id, kind, position,
                               field, label)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
const INSERT_DEAL = `INSERT INTO deal (id, tenant_id, programme_id, pipeline_id, stage_id, name,
                                       amount_minor, currency, expected_close_date, owner_user_id,
                                       primary_contact_id, account_id, next_step, stage_entered_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8, $9::date, $10, $11, $12, $13,
                             $14::timestamptz)`;
const INSERT_CHECK = `INSERT INTO deal_requirement_check
                        (id, tenant_id, programme_id, pipeline_id, deal_id, requirement_id,
                         checked_by_user_id)
                      VALUES ($1, $2, $3, $4, $5, $6, $7)`;

interface DealInput {
  id?: string;
  pipelineId: string;
  stageId: string;
  name?: string;
  amountMinor?: string | null;
  currency?: string | null;
  owner?: string | null;
  contact?: string | null;
  account?: string | null;
  nextStep?: string | null;
  stageEnteredAt?: string;
}

function dealValues(f: Fixture, input: DealInput): unknown[] {
  return [
    input.id ?? randomUUID(),
    f.tenantId,
    f.programmeId,
    input.pipelineId,
    input.stageId,
    input.name ?? 'T-0106 probe deal',
    input.amountMinor === undefined ? '250000' : input.amountMinor,
    input.currency === undefined ? f.currency : input.currency,
    '2026-12-01',
    input.owner === undefined ? f.owner : input.owner,
    input.contact === undefined ? f.contact : input.contact,
    input.account === undefined ? f.account : input.account,
    input.nextStep === undefined ? 'T-0106 next step: send the proposal' : input.nextStep,
    input.stageEnteredAt ?? '2026-10-01T08:00:00Z',
  ];
}

/** The fixture as statements, in dependency order. */
function fixtureStatements(f: Fixture): (readonly [string, unknown[]])[] {
  const { tenantId: t, programmeId: p } = f;
  const pairs: [string, string][] = [
    [f.S0, f.S1],
    [f.S1, f.S0],
    [f.S0, f.SL],
    [f.S1, f.SL],
    [f.S1, f.SW],
    [f.SW, f.S0],
    [f.SL, f.S0],
  ];
  return [
    [INSERT_PIPELINE, [f.P, t, p, 'T-0106 fixture pipeline']],
    stageStatement(t, p, f.P, [
      { id: f.S0, kind: 'open', position: 0 },
      { id: f.S1, kind: 'open', position: 1 },
      { id: f.SLEAF, kind: 'open', position: 2 },
      { id: f.SW, kind: 'won', position: 3 },
      { id: f.SL, kind: 'lost', position: 4 },
    ]),
    ...pairs.map(([from, to], index): readonly [string, unknown[]] => [
      INSERT_TRANSITION,
      [f.transitions[index], t, p, f.P, from, to],
    ]),
    [INSERT_REQUIREMENT, [f.RF, t, p, f.P, f.S1, 'field', 0, 'amount', null]],
    [INSERT_REQUIREMENT, [f.RC, t, p, f.P, f.S1, 'check', 1, null, 'T-0106 fixture check']],
    [INSERT_REQUIREMENT, [f.RC2, t, p, f.P, f.S1, 'check', 2, null, 'T-0106 leaf check']],
    [INSERT_DEAL, dealValues(f, { id: f.D, pipelineId: f.P, stageId: f.S1 })],
    [
      INSERT_DEAL,
      dealValues(f, { id: f.DLEAF, pipelineId: f.P, stageId: f.S0, contact: null, account: null }),
    ],
    [INSERT_CHECK, [f.K, t, p, f.P, f.D, f.RC, f.owner]],
  ];
}

const FX_A1 = fixture(
  idIn('0001'),
  TENANT_A,
  PROGRAMME_A1,
  USER_A_AGENT_1,
  'NGN',
  seededContacts(PROGRAMME_A1)[0],
  seededAccount(PROGRAMME_A1),
);
const FX_A2 = fixture(
  idIn('0002'),
  TENANT_A,
  PROGRAMME_A2,
  USER_A_AGENT_2,
  'GHS',
  seededContacts(PROGRAMME_A2)[0],
  seededAccount(PROGRAMME_A2),
);
const FX_B1 = fixture(
  idIn('0003'),
  TENANT_B,
  PROGRAMME_B1,
  USER_B_AGENT_1,
  'KES',
  seededContacts(PROGRAMME_B1)[0],
  seededAccount(PROGRAMME_B1),
);

/**
 * A second pipeline in A1: Q0 open(0), Q1 open(1), QW won(2), QL lost(3); a
 * check requirement RQ on Q1; no transitions. "Another pipeline in the SAME
 * programme" is what only a pipeline-carrying key can refuse.
 */
const P2_A1 = id106('a0002');
const Q0 = id106('b0010');
const Q1 = id106('b0011');
const QW = id106('b0012');
const QL = id106('b0013');
const RQ = id106('d0010');

/** The ids of one table's committed fixture rows in one programme fixture. */
function fixtureIds(f: Fixture, table: Table): string[] {
  switch (table) {
    case 'pipeline':
      return [f.P];
    case 'pipeline_stage':
      return [f.S0, f.S1, f.SLEAF, f.SW, f.SL];
    case 'pipeline_stage_transition':
      return f.transitions;
    case 'pipeline_stage_requirement':
      return [f.RF, f.RC, f.RC2];
    case 'deal':
      return [f.D, f.DLEAF];
    case 'deal_requirement_check':
      return [f.K];
  }
}

function a1ExtraIds(table: Table): string[] {
  if (table === 'pipeline') return [P2_A1];
  if (table === 'pipeline_stage') return [Q0, Q1, QW, QL];
  if (table === 'pipeline_stage_requirement') return [RQ];
  return [];
}

// --- the template ----------------------------------------------------------------

/** wire -> api_name (R2). */
const snake = (wire: string): string => wire.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

interface TemplateStage {
  name: string;
  kind: string;
  position: number;
  probabilityBp: number;
  rottingAfterDays: number | null;
  requirements: { kind: string; field: string | null; label: string | null }[];
}

interface Template {
  name: string;
  version: number;
  stages: TemplateStage[];
  /** `from>to` by stage NAME, sorted. */
  transitions: string[];
}

interface ExampleStage {
  id: string;
  name: string;
  kind: string;
  position: number;
  probabilityBp: number;
  rottingAfterDays: number | null;
  requirements: { kind: string; field?: string; label?: string }[];
}

/** The getPipeline 200 example: the template (R3). */
function contractExample(): {
  name: string;
  version: number;
  stages: ExampleStage[];
  transitions: { fromStageId: string; toStageId: string }[];
} {
  const spec = parseYaml(readFileSync(RECORDS_SPEC, 'utf8')) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  const ok = spec.paths['/api/v1/pipelines/{pipelineId}']?.get?.responses['200'] as
    { content: { 'application/json': { example: unknown } } } | undefined;
  const example = ok?.content['application/json'].example;
  if (example === undefined) throw new Error('getPipeline has no 200 example');
  return example as ReturnType<typeof contractExample>;
}

/**
 * The contract's seed rule (getPipeline, D-L88), on stages known by name:
 * forward one stage (the last open stage forward is won), back to any earlier
 * open stage, lost from any open stage, won and lost back to any open stage.
 */
function seedRule(stages: readonly { name: string; kind: string; position: number }[]): string[] {
  const opens = stages
    .filter((stage) => stage.kind === 'open')
    .sort((a, b) => a.position - b.position);
  const won = stages.find((stage) => stage.kind === 'won');
  const lost = stages.find((stage) => stage.kind === 'lost');
  if (won === undefined || lost === undefined) throw new Error('no won or no lost stage');
  const pairs: string[] = [];
  opens.forEach((stage, index) => {
    pairs.push(`${stage.name}>${(opens[index + 1] ?? won).name}`);
    for (const earlier of opens.slice(0, index)) pairs.push(`${stage.name}>${earlier.name}`);
    pairs.push(`${stage.name}>${lost.name}`);
  });
  for (const closed of [won, lost]) {
    for (const open of opens) pairs.push(`${closed.name}>${open.name}`);
  }
  return [...new Set(pairs)].sort();
}

function template(): Template {
  const example = contractExample();
  const stages = [...example.stages]
    .sort((a, b) => a.position - b.position)
    .map((stage) => ({
      name: stage.name,
      kind: stage.kind,
      position: stage.position,
      probabilityBp: stage.probabilityBp,
      rottingAfterDays: stage.rottingAfterDays,
      requirements: stage.requirements.map((requirement) => ({
        kind: requirement.kind,
        field: requirement.field === undefined ? null : snake(requirement.field),
        label: requirement.label ?? null,
      })),
    }));
  return { name: example.name, version: 1, stages, transitions: seedRule(stages) };
}

interface PipelineSnapshot {
  count: number;
  /** One per pipeline in the programme, ordered by id. */
  pipelines: (Template & { ids: string[] })[];
}

/** A programme's pipelines, as the template shape plus every id (for idempotency). */
async function programmePipelines(query: Query, programmeId: string): Promise<PipelineSnapshot> {
  const pipelines = await query<{ id: string; name: string; version: number }>(
    'SELECT id, name, version FROM pipeline WHERE programme_id = $1 ORDER BY id',
    [programmeId],
  );
  const result: PipelineSnapshot['pipelines'] = [];
  for (const pipeline of pipelines) {
    const stages = await query<{
      id: string;
      name: string;
      kind: string;
      position: number;
      probability_bp: number;
      rotting_after_days: number | null;
    }>(
      `SELECT id, name, kind, position, probability_bp, rotting_after_days
         FROM pipeline_stage WHERE pipeline_id = $1 ORDER BY position, id`,
      [pipeline.id],
    );
    const requirements = await query<{
      id: string;
      stage_id: string;
      kind: string;
      field: string | null;
      label: string | null;
    }>(
      `SELECT id, stage_id, kind, field, label FROM pipeline_stage_requirement
        WHERE pipeline_id = $1 ORDER BY stage_id, position, id`,
      [pipeline.id],
    );
    const transitions = await query<{ id: string; from_name: string; to_name: string }>(
      `SELECT t.id, f.name AS from_name, s.name AS to_name
         FROM pipeline_stage_transition t
         JOIN pipeline_stage f ON f.id = t.from_stage_id
         JOIN pipeline_stage s ON s.id = t.to_stage_id
        WHERE t.pipeline_id = $1 ORDER BY t.id`,
      [pipeline.id],
    );
    result.push({
      name: pipeline.name,
      version: pipeline.version,
      stages: stages.map((stage) => ({
        name: stage.name,
        kind: stage.kind,
        position: stage.position,
        probabilityBp: stage.probability_bp,
        rottingAfterDays: stage.rotting_after_days,
        requirements: requirements
          .filter((requirement) => requirement.stage_id === stage.id)
          .map((requirement) => ({
            kind: requirement.kind,
            field: requirement.field,
            label: requirement.label,
          })),
      })),
      transitions: transitions.map((row) => `${row.from_name}>${row.to_name}`).sort(),
      ids: [
        pipeline.id,
        ...stages.map((row) => row.id),
        ...requirements.map((row) => row.id),
        ...transitions.map((row) => row.id),
      ],
    });
  }
  return { count: pipelines.length, pipelines: result };
}

/** The template shape of a snapshot, ids dropped. */
const shapeOf = (snapshot: PipelineSnapshot): Template[] =>
  snapshot.pipelines.map(({ ids: _ids, ...shape }) => shape);

// --- the deal standard object ----------------------------------------------------

const REQUIRED_DEAL_FIELDS = [
  'account_id',
  'amount',
  'expected_close_date',
  'name',
  'next_step',
  'owner_user_id',
  'primary_contact_id',
];
const OPTIONAL_DEAL_FIELDS = [
  'closed_at',
  'created_at',
  'pipeline_id',
  'stage_entered_at',
  'stage_id',
  'updated_at',
  'version',
];

const DEAL_FIELDS_SQL = `
  SELECT f.api_name, f.label, f.type, f.is_required, f.config::text AS config,
         f.classification, f.is_custom
    FROM field_def f
    JOIN object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
   WHERE f.tenant_id = $1 AND o.api_name = 'deal' AND NOT o.is_custom AND NOT f.is_custom
   ORDER BY f.api_name`;

const DEAL_OBJECT_SQL = `
  SELECT api_name, label, plural_label, is_custom
    FROM object_def WHERE tenant_id = $1 AND api_name = 'deal'`;

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

/** Every rule O and R13 set for one tenant's deal catalogue; returns the problems. */
function dealCatalogueProblems(objects: ObjectRow[], fields: FieldRow[]): string[] {
  const problems: string[] = [];
  if (objects.length !== 1 || objects[0]?.is_custom !== false) {
    problems.push(`object_def deal: ${JSON.stringify(objects)}, expected one standard row`);
  }
  const names = fields.map((row) => row.api_name);
  for (const name of REQUIRED_DEAL_FIELDS.filter((field) => !names.includes(field))) {
    problems.push(`${name}: no standard field_def`);
  }
  for (const name of names.filter(
    (field) => !REQUIRED_DEAL_FIELDS.includes(field) && !OPTIONAL_DEAL_FIELDS.includes(field),
  )) {
    problems.push(`${name}: a standard field_def outside R13`);
  }
  const byName = new Map(fields.map((row) => [row.api_name, row]));
  for (const [name, target] of [
    ['primary_contact_id', 'contact'],
    ['account_id', 'account'],
  ] as const) {
    const row = byName.get(name);
    if (row === undefined) continue;
    // Parsed, not text: Postgres renders jsonb with a space after the colon.
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
  for (const name of ['name', 'next_step']) {
    const row = byName.get(name);
    if (row !== undefined && row.classification !== 'pii') {
      problems.push(`${name}: classified ${row.classification}, expected pii`);
    }
  }
  return problems;
}

// =============================================================================
// 1. The tables: migration, columns, keys, tenancy, rules (the shared database)
// =============================================================================

describe('acceptance: the pipeline and deal tables (T-0106)', () => {
  /** kasuwa_app — NOBYPASSRLS. Every assertion about what a session may do. */
  let appPool: Pool;
  /** kasuwa_migrator — owns the schema; plants and observes; the allow-list's one role. */
  let migrator: Pool;
  /** kasuwa_test_admin — BYPASSRLS; the role D-L76's allow-list must still refuse. */
  let testAdmin: Pool;
  /** Why the committed fixtures could not be planted (on main: no tables). */
  let plantError: unknown;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 3 });
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 3 });
    testAdmin = createPool({ connectionString: inject('testAdminUrl'), max: 2 });
    const client = await migrator.connect();
    try {
      await client.query('BEGIN');
      for (const f of [FX_A1, FX_A2, FX_B1]) {
        for (const [sql, values] of fixtureStatements(f)) await client.query(sql, values);
      }
      await client.query(INSERT_PIPELINE, [P2_A1, TENANT_A, PROGRAMME_A1, 'T-0106 second']);
      const [sql, values] = stageStatement(TENANT_A, PROGRAMME_A1, P2_A1, [
        { id: Q0, kind: 'open', position: 0 },
        { id: Q1, kind: 'open', position: 1 },
        { id: QW, kind: 'won', position: 2 },
        { id: QL, kind: 'lost', position: 3 },
      ]);
      await client.query(sql, values);
      await client.query(INSERT_REQUIREMENT, [
        RQ,
        TENANT_A,
        PROGRAMME_A1,
        P2_A1,
        Q1,
        'check',
        0,
        null,
        'T-0106 second pipeline check',
      ]);
      await client.query('COMMIT');
    } catch (error) {
      plantError = error;
      await client.query('ROLLBACK').catch(() => undefined);
    } finally {
      client.release();
    }
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await migrator?.end();
    await testAdmin?.end();
    await reseed(inject('migrationUrl'));
  });

  const requirePlanted = () => {
    expect(
      plantError === undefined ? null : verdict(outcomeOf(plantError)),
      'the committed pipeline fixtures could not be planted',
    ).toBe(null);
  };

  const asMigrator: () => Query = () => async (text, params) =>
    (await migrator.query(text, params)).rows;

  // ---------------------------------------------------------------------------
  // M. The migration
  // ---------------------------------------------------------------------------
  describe('the migration', () => {
    it('one migration creates all six tables, and the runner applied it', async () => {
      const files = TABLES.map((table) => [table, migrationsCreating(table)] as const);
      const found = Object.fromEntries(files);
      const all = [...new Set(files.flatMap(([, names]) => names))];
      expect(all, `migrations creating the six tables: ${JSON.stringify(found)}`).toHaveLength(1);
      for (const [table, names] of files) expect(names, table).toEqual(all);
      const ids = all.map((name) => name.replace(/\.sql$/, ''));
      const applied = await migrator.query<{ id: string }>(
        'SELECT id FROM _kasuwa_migration WHERE id = ANY ($1::text[])',
        [ids],
      );
      expect(applied.rows.map((row) => row.id)).toEqual(ids);
    });

    it('(self-check, passes on main) the scan finds each table and nothing near it, and ignores comments', () => {
      expect(createsTable('pipeline').test('CREATE TABLE pipeline (\n id uuid')).toBe(true);
      expect(createsTable('pipeline').test('create table if not exists public.pipeline(')).toBe(
        true,
      );
      expect(createsTable('pipeline').test('CREATE TABLE pipeline_stage (')).toBe(false);
      expect(createsTable('deal').test('CREATE TABLE deal_requirement_check (')).toBe(false);
      expect(
        createsTable('deal').test(stripLineComments('-- CREATE TABLE deal (\nSELECT 1;')),
      ).toBe(false);
    });

    it('carries a LEAKPROOF self-check that only reads proleakproof (D-P33)', () => {
      const [file] = migrationsCreating('pipeline');
      expect(file, 'no migration creates pipeline').toBeDefined();
      if (file === undefined) return;
      expect(leakproofProblems(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))).toEqual([]);
    });

    it('(self-check, passes on main) the LEAKPROOF scan accepts 0034 and rejects a marking or a missing check', () => {
      const name = readdirSync(MIGRATIONS_DIR).find((file) => file.startsWith('0034_'));
      expect(name, '0034 is the model self-check').toBeDefined();
      const model = readFileSync(join(MIGRATIONS_DIR, name ?? ''), 'utf8');
      expect(leakproofProblems(model)).toEqual([]);
      expect(
        leakproofProblems(`${model}\nALTER FUNCTION pg_catalog.texteq(text, text) LEAKPROOF;`),
      ).toEqual(['marks something LEAKPROOF']);
      expect(leakproofProblems('SELECT 1; -- proleakproof')).toEqual([
        'no LEAKPROOF self-check (proleakproof)',
      ]);
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
  // C. Columns and keys
  // ---------------------------------------------------------------------------
  describe('columns and keys', () => {
    it.each(TABLES)(
      '%s has exactly the pinned columns, types, nullability and defaults',
      async (table) => {
        const rows = (await migrator.query<ColumnRow>(COLUMNS_SQL, [table])).rows;
        expect(rows.length, `table ${table} not found`).toBeGreaterThan(0);
        const spec = COLUMN_SPEC[table];
        expect(rows.map((row) => row.column).sort()).toEqual(Object.keys(spec).sort());
        const problems: string[] = [];
        for (const row of rows) {
          const want = spec[row.column];
          if (want === undefined) continue;
          if (row.type !== want.type)
            problems.push(`${row.column}: ${row.type}, want ${want.type}`);
          if (want.notNull !== null && row.notnull !== want.notNull) {
            problems.push(`${row.column}: NOT NULL is ${row.notnull}, want ${want.notNull}`);
          }
          if (want.default !== undefined && !want.default.test(row.default ?? '')) {
            problems.push(`${row.column}: default ${row.default}, want ${want.default.source}`);
          }
          if (want.noDefault === true && row.default !== null) {
            problems.push(`${row.column}: has a default ${row.default}`);
          }
        }
        expect(problems).toEqual([]);
      },
    );

    it.each(TABLES)('%s: id is the primary key', async (table) => {
      const pk = await migrator.query<{ columns: string[] }>(
        `SELECT array_agg(a.attname::text ORDER BY a.attname) AS columns
           FROM pg_constraint con
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
          WHERE con.contype = 'p' AND con.conrelid = to_regclass('public.' || $1::text)
          GROUP BY con.oid`,
        [table],
      );
      expect(pk.rows.map((row) => row.columns)).toEqual([['id']]);
    });

    it.each(TABLES)(
      '%s: composite FKs through tenant and programme, every one ON UPDATE RESTRICT (D-L76, R8)',
      async (table) => {
        const fks = (
          await migrator.query<{
            ref_table: string;
            pairs: string[];
            on_update: string;
            on_delete: string;
          }>(FOREIGN_KEYS_SQL, [table])
        ).rows.map((row) => ({
          refTable: row.ref_table,
          pairs: [...row.pairs].sort(),
          onUpdate: row.on_update,
          onDelete: row.on_delete,
        }));
        expect(fks.length, `${table} has no foreign keys (or does not exist)`).toBeGreaterThan(0);
        expect(foreignKeyProblems(table, fks)).toEqual([]);
      },
    );

    it('(self-check, passes on main) the FK check rejects NO ACTION, a tenant-less FK, a missing programme column and a cascading contact', () => {
      const good: ForeignKey[] = [
        {
          refTable: 'programme',
          pairs: ['programme_id->id', 'tenant_id->tenant_id'],
          onUpdate: 'r',
          onDelete: 'c',
        },
        {
          refTable: 'pipeline_stage',
          pairs: [
            'pipeline_id->pipeline_id',
            'programme_id->programme_id',
            'stage_id->id',
            'tenant_id->tenant_id',
          ],
          onUpdate: 'r',
          onDelete: 'r',
        },
        {
          refTable: 'contact',
          pairs: ['primary_contact_id->id', 'programme_id->programme_id', 'tenant_id->tenant_id'],
          onUpdate: 'r',
          onDelete: 'r',
        },
        {
          refTable: 'account',
          pairs: ['account_id->id', 'programme_id->programme_id', 'tenant_id->tenant_id'],
          onUpdate: 'r',
          onDelete: 'a',
        },
        {
          refTable: 'user',
          pairs: ['owner_user_id->id', 'tenant_id->tenant_id'],
          onUpdate: 'r',
          onDelete: 'r',
        },
      ];
      expect(foreignKeyProblems('deal', good)).toEqual([]);
      const swap = (index: number, change: Partial<ForeignKey>) =>
        good.map((fk, at) => (at === index ? { ...fk, ...change } : fk));
      expect(foreignKeyProblems('deal', swap(1, { onUpdate: 'a' }))).toHaveLength(1);
      expect(
        foreignKeyProblems(
          'deal',
          swap(2, { pairs: ['primary_contact_id->id', 'tenant_id->tenant_id'] }),
        ),
      ).toHaveLength(1);
      expect(foreignKeyProblems('deal', swap(4, { pairs: ['owner_user_id->id'] }))).toHaveLength(2);
      expect(foreignKeyProblems('deal', swap(2, { onDelete: 'c' }))).toEqual([
        'deal.primary_contact_id -> contact: ON DELETE CASCADE (R8)',
      ]);
      expect(foreignKeyProblems('deal', good.slice(1))).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // T, G. Tenancy and grants
  // ---------------------------------------------------------------------------
  describe('tenancy and grants', () => {
    it.each(TABLES)(
      '%s: RLS ENABLED and FORCED; tenant AND programme on every permissive policy; WITH CHECK = USING',
      async (table) => {
        const state = await migrator.query<{ enabled: boolean; forced: boolean }>(
          `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
             FROM pg_class c WHERE c.oid = to_regclass('public.' || $1::text)`,
          [table],
        );
        expect(state.rows[0], `${table}: not found, or RLS not enabled and forced`).toEqual({
          enabled: true,
          forced: true,
        });
        const policies = await migrator.query<{
          name: string;
          permissive: boolean;
          using: string | null;
          check: string | null;
        }>(
          `SELECT p.polname AS name, p.polpermissive AS permissive,
                  pg_get_expr(p.polqual, p.polrelid) AS using,
                  pg_get_expr(p.polwithcheck, p.polrelid) AS check
             FROM pg_policy p WHERE p.polrelid = to_regclass('public.' || $1::text)`,
          [table],
        );
        expect(policies.rows.length, `${table} has no policy`).toBeGreaterThan(0);
        for (const policy of policies.rows.filter((row) => row.permissive)) {
          for (const expression of [policy.using, policy.check]) {
            if (expression === null) continue;
            expect(expression, `${table}.${policy.name}`).toContain('current_tenant_id()');
            expect(expression, `${table}.${policy.name}`).toContain('current_programme_ids()');
          }
        }
        expect(
          policies.rows.some((row) => row.check !== null && row.check === row.using),
          `${table}: no policy with WITH CHECK identical to USING`,
        ).toBe(true);
      },
    );

    it('all six are in TENANT_SCOPED_TABLES', () => {
      expect(
        TABLES.filter((table) => !(TENANT_SCOPED_TABLES as readonly string[]).includes(table)),
      ).toEqual([]);
    });

    it('kasuwa_migrator owns all six; kasuwa_app holds the pinned privileges and no DELETE; nothing it can enter may DELETE, TRUNCATE or bypass RLS', async () => {
      const rows = await migrator.query<{
        table: string;
        owner: string | null;
        select: boolean;
        insert: boolean;
        update: boolean;
      }>(
        `SELECT t AS table,
                (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = to_regclass('public.' || t)) AS owner,
                to_regclass('public.' || t) IS NOT NULL
                  AND has_table_privilege('kasuwa_app', 'public.' || t, 'SELECT') AS select,
                to_regclass('public.' || t) IS NOT NULL
                  AND has_table_privilege('kasuwa_app', 'public.' || t, 'INSERT') AS insert,
                to_regclass('public.' || t) IS NOT NULL
                  AND has_any_column_privilege('kasuwa_app', 'public.' || t, 'UPDATE') AS update
           FROM unnest($1::text[]) AS t ORDER BY 1`,
        [[...TABLES]],
      );
      const got = Object.fromEntries(rows.rows.map((row) => [row.table, row]));
      for (const table of TABLES) {
        expect(got[table]?.owner, `${table}: not found, or not the migrator’s`).toBe(
          'kasuwa_migrator',
        );
        expect(got[table]?.select, `${table}: kasuwa_app cannot SELECT`).toBe(true);
      }
      expect(got.deal).toMatchObject({ insert: true, update: true });
      expect(got.deal_requirement_check).toMatchObject({ insert: true, update: false });

      // Every role kasuwa_app is a member of, whatever the INHERIT option
      // (it can SET ROLE to kasuwa_sweeper, D-L66), and kasuwa_app itself.
      const held = await migrator.query<{ held: string }>(
        `SELECT r.rolname || ':' || t || ':' || x.what AS held
           FROM pg_roles r
          CROSS JOIN unnest($1::text[]) AS t
          CROSS JOIN LATERAL (
            SELECT 'DELETE' AS what WHERE has_table_privilege(r.oid, 'public.' || t, 'DELETE')
            UNION ALL
            SELECT 'TRUNCATE' WHERE has_table_privilege(r.oid, 'public.' || t, 'TRUNCATE')
            UNION ALL
            SELECT 'BYPASSRLS' WHERE r.rolbypassrls
          ) AS x
          WHERE pg_has_role('kasuwa_app', r.oid, 'MEMBER')
            AND to_regclass('public.' || t) IS NOT NULL
          ORDER BY 1`,
        [[...TABLES]],
      );
      expect(held.rows.map((row) => row.held)).toEqual([]);
    });

    it.each(TABLES)(
      '%s: a DELETE by kasuwa_app, even of its own programme’s row, is refused',
      async (table) => {
        requirePlanted();
        const [own] = fixtureIds(FX_A1, table);
        const outcome = await rolledBackTenantTx(
          appPool,
          TENANT_A,
          USER_A_AGENT_1,
          async (query) => ({
            // The control: the row is visible to this session, so a refusal is
            // the privilege, not RLS hiding it.
            visible: (await query(`SELECT 1 FROM ${table} WHERE id = $1`, [own])).length,
            delete: verdict(
              await probe(query, `DELETE FROM ${table} WHERE id = $1 RETURNING id`, [own]),
            ),
          }),
        );
        expect(outcome).toEqual({ visible: 1, delete: 'insufficient_privilege' });
      },
    );

    it.each(TABLES)('%s: each session sees exactly its own programmes’ rows', async (table) => {
      requirePlanted();
      const a1 = [...fixtureIds(FX_A1, table), ...a1ExtraIds(table)].sort();
      const a2 = fixtureIds(FX_A2, table).sort();
      const b1 = fixtureIds(FX_B1, table).sort();
      const all = [...a1, ...a2, ...b1];
      const visible = (tenantId: string, userId: string) =>
        withTenantTransaction(appPool, { tenantId, userId }, async (tx) =>
          (
            await tx.query<{ id: string }>(
              `SELECT id FROM ${table} WHERE id = ANY ($1::uuid[]) ORDER BY id`,
              [all],
            )
          ).map((row) => row.id),
        );
      expect(await visible(TENANT_A, USER_A_AGENT_1)).toEqual(a1);
      expect(await visible(TENANT_A, USER_A_AGENT_2)).toEqual(a2);
      expect(await visible(TENANT_A, USER_A_SUPERVISOR)).toEqual([...a1, ...a2].sort());
      expect(await visible(TENANT_A, USER_A_NO_PROGRAMME)).toEqual([]);
      expect(await visible(TENANT_B, USER_B_AGENT_1)).toEqual(b1);
    });

    it.each(TABLES)(
      '%s: an A1 session can neither change rows of A2 or tenant B nor write a row into them',
      async (table) => {
        requirePlanted();
        const [ownSource] = fixtureIds(FX_A1, table);
        const foreign = [...fixtureIds(FX_A2, table), ...fixtureIds(FX_B1, table)];
        const outcomes = await rolledBackTenantTx(
          appPool,
          TENANT_A,
          USER_A_AGENT_1,
          async (query) => {
            const writable = await query<{ quoted: string }>(
              `SELECT quote_ident(a.attname) AS quoted FROM pg_attribute a
            WHERE a.attrelid = to_regclass('public.' || $1::text) AND a.attnum > 0
              AND NOT a.attisdropped
              AND a.attname NOT IN ('id', 'tenant_id', 'programme_id')
              AND has_column_privilege(current_user, a.attrelid, a.attnum, 'UPDATE')
            ORDER BY a.attnum LIMIT 1`,
              [table],
            );
            const column = writable[0]?.quoted;
            const canInsert = (
              await query<{ ok: boolean }>(
                `SELECT has_table_privilege(current_user, 'public.' || $1::text, 'INSERT') AS ok`,
                [table],
              )
            )[0]?.ok;
            const sql = await cloneSql(query, table);
            // The INSERT statement alone is judged (deferred rules left for a
            // COMMIT that never comes): a lone pipeline copy breaks the
            // one-won-one-lost rule, and that must not pass for a WITH CHECK.
            const insert = (overrides: Json) =>
              probe(
                query,
                sql,
                [ownSource, JSON.stringify({ id: randomUUID(), ...overrides })],
                false,
                false,
              ).then(verdict);
            return {
              // When kasuwa_app holds no UPDATE here, nothing can match: say so
              // rather than count it (the configuration tables, G).
              updated:
                column === undefined
                  ? []
                  : (
                      await query<{ id: string }>(
                        `UPDATE ${table} SET ${column} = ${column} WHERE id = ANY ($1::uuid[]) RETURNING id`,
                        [foreign],
                      )
                    ).map((row) => row.id),
              canInsert,
              // A copy of A1's own row, kept in A1 with a fresh id. Only the WITH
              // CHECK separates it from the two below. A unique key (one check
              // per deal and requirement, R7) may refuse the in-programme copy:
              // that is still a statement that reached the table.
              control: canInsert === true ? await insert({}) : 'no INSERT',
              intoA2: await insert({ programme_id: PROGRAMME_A2 }),
              intoB1: await insert({ tenant_id: TENANT_B, programme_id: PROGRAMME_B1 }),
            };
          },
        );
        expect(outcomes.updated, 'an A1 session updated another programme’s row').toEqual([]);
        if (table === 'deal' || table === 'deal_requirement_check') {
          expect(outcomes.canInsert, `kasuwa_app cannot INSERT into ${table}`).toBe(true);
        }
        if (outcomes.canInsert === true) {
          expect(
            ['accepted', 'unique_violation'],
            `the in-programme copy was ${outcomes.control}`,
          ).toContain(outcomes.control);
        }
        expect(REFUSALS, `a copy into A2 was ${outcomes.intoA2}`).toContain(outcomes.intoA2);
        expect(REFUSALS, `a copy into tenant B was ${outcomes.intoB1}`).toContain(outcomes.intoB1);
      },
    );
  });

  // ---------------------------------------------------------------------------
  // S. Stage rules, as the migrator (BYPASSRLS bypasses no CHECK)
  // ---------------------------------------------------------------------------
  describe('stage rules hold for every role, the migrator included', () => {
    const P = id106('aa000');
    const sid = (n: number) => id106(`ab${n.toString(16).padStart(3, '0')}`);
    const t = TENANT_A;
    const p = PROGRAMME_A1;

    /** open..., won, lost, by default; `kinds` overrides. */
    const build = (kinds: readonly string[]): (readonly [string, unknown[]])[] => [
      [INSERT_PIPELINE, [P, t, p, 'T-0106 rules']],
      stageStatement(
        t,
        p,
        P,
        kinds.map((kind, position) => ({ id: sid(position), kind, position })),
      ),
    ];
    const BASE = ['open', 'open', 'won', 'lost'];

    it('exactly one won and one lost stage; at least one open stage (R4)', async () => {
      const result = await rolledBackTx(migrator, async (query) => ({
        control: verdict(await probe(query, build(BASE))),
        noWon: verdict(await probe(query, build(['open', 'open', 'lost']))),
        noLost: verdict(await probe(query, build(['open', 'open', 'won']))),
        twoWon: verdict(await probe(query, build(['open', 'won', 'won', 'lost']))),
        twoLost: verdict(await probe(query, build(['open', 'won', 'lost', 'lost']))),
        noOpen: verdict(await probe(query, build(['won', 'lost']))),
        noStages: verdict(await probe(query, [[INSERT_PIPELINE, [P, t, p, 'T-0106 empty']]])),
      }));
      expect(result.control, 'a valid pipeline').toBe('accepted');
      for (const [name, outcome] of Object.entries(result).filter(([name]) => name !== 'control')) {
        expect(RULE_REFUSALS, `${name} was ${outcome}`).toContain(outcome);
      }
    });

    it('the rule holds after creation too: the lost stage cannot become open, and the won stage cannot be deleted alone', async () => {
      const result = await rolledBackTx(migrator, async (query) => {
        for (const [sql, values] of build(BASE)) await query(sql, values);
        return {
          reopenLost: verdict(
            await probe(
              query,
              `UPDATE pipeline_stage SET kind = 'open', probability_bp = 5000, rotting_after_days = 14
                WHERE id = $1 RETURNING id`,
              [sid(3)],
            ),
          ),
          // No transition or deal references it, so only the rule can refuse.
          deleteWon: verdict(
            await probe(query, 'DELETE FROM pipeline_stage WHERE id = $1 RETURNING id', [sid(2)]),
          ),
          // The control: an open stage of the same pipeline can go.
          deleteOpen: verdict(
            await probe(query, 'DELETE FROM pipeline_stage WHERE id = $1 RETURNING id', [sid(1)]),
          ),
        };
      });
      expect(result.deleteOpen, 'deleting a spare open stage').toBe('accepted');
      expect(RULE_REFUSALS, `re-opening lost was ${result.reopenLost}`).toContain(
        result.reopenLost,
      );
      expect(RULE_REFUSALS, `deleting won was ${result.deleteWon}`).toContain(result.deleteWon);
    });

    it('kind is exactly open, won or lost: a label, a near-miss and NULL are refused', async () => {
      const result = await rolledBackTx(migrator, async (query) => {
        const out: Record<string, string> = {};
        for (const kind of ['Open', 'closed', 'won ', 'approval']) {
          out[kind] = verdict(await probe(query, build(['open', kind, 'won', 'lost'])));
        }
        out.null = verdict(
          await probe(query, [
            ...build(BASE),
            [
              `INSERT INTO pipeline_stage (id, tenant_id, programme_id, pipeline_id, name, kind, position, probability_bp)
               VALUES ($1, $2, $3, $4, 'T-0106 null kind', NULL, 9, 100)`,
              [sid(9), t, p, P],
            ],
          ]),
        );
        return out;
      });
      for (const [kind, outcome] of Object.entries(result)) {
        expect(RULE_REFUSALS, `kind ${JSON.stringify(kind)} was ${outcome}`).toContain(outcome);
      }
    });

    it('at most 30 stages: 30 accepted, 31 refused', async () => {
      const kinds = (opens: number) => [
        ...Array.from({ length: opens }, () => 'open'),
        'won',
        'lost',
      ];
      const result = await rolledBackTx(migrator, async (query) => ({
        thirty: verdict(await probe(query, build(kinds(28)))),
        thirtyOne: verdict(await probe(query, build(kinds(29)))),
        // Added one at a time after creation, the 31st is refused as well.
        later: verdict(
          await probe(query, [
            ...build(kinds(28)),
            [
              `INSERT INTO pipeline_stage (id, tenant_id, programme_id, pipeline_id, name, kind, position,
                                           probability_bp, rotting_after_days)
               VALUES ($1, $2, $3, $4, 'T-0106 one too many', 'open', 40, 100, 14)`,
              [sid(40), t, p, P],
            ],
          ]),
        ),
      }));
      expect(result.thirty, '30 stages').toBe('accepted');
      expect(RULE_REFUSALS, `31 stages was ${result.thirtyOne}`).toContain(result.thirtyOne);
      expect(RULE_REFUSALS, `a 31st stage added later was ${result.later}`).toContain(result.later);
    });

    it('rotting_after_days is 2 to 365, DEFAULT 14 on an open stage; set on open, NULL on won and lost (R4)', async () => {
      // Each case is a whole valid pipeline (open, open, won, lost) in which
      // ONE stage's rotting_after_days is the SQL fragment under test, so the
      // one-won-one-lost rule never refuses for its own reason.
      const whole = (
        openB: string,
        won = 'NULL',
        lost = 'NULL',
      ): (readonly [string, unknown[]])[] => [
        [INSERT_PIPELINE, [P, t, p, 'T-0106 rotting']],
        [
          `INSERT INTO pipeline_stage (id, tenant_id, programme_id, pipeline_id, name, kind, position,
                                       probability_bp, rotting_after_days)
           VALUES ($1, $5, $6, $7, 'T-0106 a', 'open', 0, 1000, 14),
                  ($2, $5, $6, $7, 'T-0106 b', 'open', 1, 2000, ${openB}),
                  ($3, $5, $6, $7, 'T-0106 w', 'won', 2, 10000, ${won}),
                  ($4, $5, $6, $7, 'T-0106 l', 'lost', 3, 0, ${lost})
           RETURNING id`,
          [sid(0), sid(1), sid(2), sid(3), t, p, P],
        ],
      ];
      const result = await rolledBackTx(migrator, async (query) => {
        const out: Record<string, string> = {};
        for (const value of ['1', '2', '365', '366', 'NULL', '0', '-14']) {
          out[`open ${value}`] = verdict(await probe(query, whole(value)));
        }
        out['won 14'] = verdict(await probe(query, whole('14', '14')));
        out['lost 14'] = verdict(await probe(query, whole('14', 'NULL', '14')));
        out['won and lost NULL'] = verdict(await probe(query, whole('14')));
        // DEFAULT in a multi-row VALUES is the column default.
        const kept = await probe(query, whole('DEFAULT'), [], true);
        const defaulted = kept.accepted
          ? (
              await query<{ rotting_after_days: number | null }>(
                'SELECT rotting_after_days FROM pipeline_stage WHERE id = $1',
                [sid(1)],
              )
            )[0]?.rotting_after_days
          : verdict(kept);
        return { out, defaulted };
      });
      expect(result.defaulted, 'an open stage given no rotting_after_days').toBe(14);
      expect(result.out).toMatchObject({
        'open 2': 'accepted',
        'open 365': 'accepted',
        'won and lost NULL': 'accepted',
      });
      for (const name of [
        'open 1',
        'open 366',
        'open NULL',
        'open 0',
        'open -14',
        'won 14',
        'lost 14',
      ]) {
        expect(RULE_REFUSALS, `${name} was ${result.out[name]}`).toContain(result.out[name]);
      }
    });

    it('probability is 0..10000, won 10000 and lost 0; position is 0..99 and unique in its pipeline (R4)', async () => {
      const variant = (set: string, where: number) =>
        rolledBackTx(migrator, async (query) => {
          for (const [sql, values] of build(BASE)) await query(sql, values);
          return verdict(
            await probe(query, `UPDATE pipeline_stage SET ${set} WHERE id = $1 RETURNING id`, [
              sid(where),
            ]),
          );
        });
      const controls = {
        openBp: await variant('probability_bp = 0', 0),
        openBpMax: await variant('probability_bp = 10000', 1),
        position: await variant('position = 99', 3),
      };
      expect(controls).toEqual({ openBp: 'accepted', openBpMax: 'accepted', position: 'accepted' });
      const refused = {
        negative: await variant('probability_bp = -1', 0),
        over: await variant('probability_bp = 10001', 0),
        wonNot10000: await variant('probability_bp = 9000', 2),
        lostNot0: await variant('probability_bp = 100', 3),
        positionNegative: await variant('position = -1', 0),
        position100: await variant('position = 100', 0),
        positionTaken: await variant('position = 1', 0),
      };
      for (const [name, outcome] of Object.entries(refused)) {
        expect(RULE_REFUSALS, `${name} was ${outcome}`).toContain(outcome);
      }
    });

    it('text bounds: pipeline and stage names 1..100 characters (R6)', async () => {
      const result = await rolledBackTx(migrator, async (query) => {
        for (const [sql, values] of build(BASE)) await query(sql, values);
        const set = (table: string, id: string, value: string) =>
          probe(query, `UPDATE ${table} SET name = $2 WHERE id = $1 RETURNING id`, [
            id,
            value,
          ]).then(verdict);
        return {
          pipeline100: await set('pipeline', P, 'p'.repeat(100)),
          stage100: await set('pipeline_stage', sid(0), 's'.repeat(100)),
          pipelineEmpty: await set('pipeline', P, ''),
          pipeline101: await set('pipeline', P, 'p'.repeat(101)),
          stageEmpty: await set('pipeline_stage', sid(0), ''),
          stage101: await set('pipeline_stage', sid(0), 's'.repeat(101)),
        };
      });
      expect(result).toMatchObject({ pipeline100: 'accepted', stage100: 'accepted' });
      for (const name of ['pipelineEmpty', 'pipeline101', 'stageEmpty', 'stage101'] as const) {
        expect(RULE_REFUSALS, `${name} was ${result[name]}`).toContain(result[name]);
      }
    });

    it('requirements: kind field or check, each with its own shape; field codes are api_names; at most 20 per stage (R2, R4)', async () => {
      const result = await rolledBackTx(migrator, async (query) => {
        for (const [sql, values] of build(BASE)) await query(sql, values);
        const req = (
          kind: string | null,
          field: string | null,
          label: string | null,
          position = 0,
        ) =>
          probe(query, INSERT_REQUIREMENT, [
            randomUUID(),
            t,
            p,
            P,
            sid(1),
            kind,
            position,
            field,
            label,
          ]).then(verdict);
        const out: Record<string, string> = {};
        for (const field of [
          'amount',
          'expected_close_date',
          'next_step',
          'primary_contact_id',
          'account_id',
        ]) {
          out[`field ${field}`] = await req('field', field, null);
        }
        out['check label'] = await req('check', null, 'Signed purchase order received');
        out['check 200'] = await req('check', null, 'c'.repeat(200));
        // Refusals.
        out['field expectedCloseDate'] = await req('field', 'expectedCloseDate', null);
        out['field territory'] = await req('field', 'territory', null);
        out['field name'] = await req('field', 'name', null);
        out['field without field'] = await req('field', null, null);
        out['field with label'] = await req('field', 'amount', 'Amount please');
        out['check without label'] = await req('check', null, null);
        out['check empty label'] = await req('check', null, '');
        out['check 201'] = await req('check', null, 'c'.repeat(201));
        out['check with field'] = await req('check', 'amount', 'Amount please');
        out['kind approval'] = await req('approval', null, 'Manager approval');
        out['kind null'] = await req(null, null, 'No kind');
        // Twenty on one stage, then a twenty-first.
        const many = (count: number): (readonly [string, unknown[]])[] =>
          Array.from({ length: count }, (_unused, index) => [
            INSERT_REQUIREMENT,
            [randomUUID(), t, p, P, sid(0), 'check', index, null, `T-0106 check ${index}`],
          ]);
        out.twenty = verdict(await probe(query, many(20)));
        out.twentyOne = verdict(await probe(query, many(21)));
        return out;
      });
      const accepted = [
        'field amount',
        'field expected_close_date',
        'field next_step',
        'field primary_contact_id',
        'field account_id',
        'check label',
        'check 200',
        'twenty',
      ];
      for (const name of accepted) expect(result[name], name).toBe('accepted');
      for (const [name, outcome] of Object.entries(result).filter(
        ([name]) => !accepted.includes(name),
      )) {
        expect(RULE_REFUSALS, `${name} was ${outcome}`).toContain(outcome);
      }
    });

    it('transitions: never a stage to itself, both ends in the pipeline, each pair once (R4)', async () => {
      requirePlanted();
      const result = await rolledBackTx(migrator, async (query) => {
        for (const [sql, values] of build(BASE)) await query(sql, values);
        const pair = (from: string, to: string, pipelineId = P) =>
          probe(query, INSERT_TRANSITION, [randomUUID(), t, p, pipelineId, from, to]).then(verdict);
        await query(INSERT_TRANSITION, [randomUUID(), t, p, P, sid(0), sid(1)]);
        return {
          control: await pair(sid(1), sid(0)),
          self: await pair(sid(0), sid(0)),
          duplicate: await pair(sid(0), sid(1)),
          // Another pipeline's stage, in the same programme.
          otherPipelineTo: await pair(sid(0), Q0),
          otherPipelineFrom: await pair(Q0, sid(1)),
          // Both ends real, but the row names the other pipeline.
          mislabelled: await pair(sid(1), sid(2), P2_A1),
        };
      });
      expect(result.control).toBe('accepted');
      for (const [name, outcome] of Object.entries(result).filter(([name]) => name !== 'control')) {
        expect(RULE_REFUSALS, `${name} was ${outcome}`).toContain(outcome);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // D. Deals, as kasuwa_app
  // ---------------------------------------------------------------------------
  describe('deal values and references, as kasuwa_app inside withTenantTransaction', () => {
    const asA1Agent = <T>(fn: (query: Query) => Promise<T>) =>
      rolledBackTenantTx(appPool, TENANT_A, USER_A_AGENT_1, fn);
    const tryDeal = (query: Query, input: Partial<DealInput>, f: Fixture = FX_A1) =>
      probe(query, INSERT_DEAL, dealValues(f, { pipelineId: f.P, stageId: f.S0, ...input })).then(
        verdict,
      );

    it('amount_minor is bigint, 0 to 18 nines, never a fraction; amount and currency come together (R6, D-L121)', async () => {
      requirePlanted();
      const result = await asA1Agent(async (query) => ({
        control: await tryDeal(query, {}),
        zero: await tryDeal(query, { amountMinor: '0' }),
        max: await tryDeal(query, { amountMinor: '999999999999999999' }),
        none: await tryDeal(query, { amountMinor: null, currency: null }),
        negative: await tryDeal(query, { amountMinor: '-1' }),
        tooBig: await tryDeal(query, { amountMinor: '1000000000000000000' }),
        // bigint refuses a fraction outright; numeric(18,0) would round it to 2.
        fraction: await tryDeal(query, { amountMinor: '1.5' }),
        amountOnly: await tryDeal(query, { amountMinor: '100', currency: null }),
        currencyOnly: await tryDeal(query, { amountMinor: null, currency: 'NGN' }),
      }));
      expect(result).toMatchObject({
        control: 'accepted',
        zero: 'accepted',
        max: 'accepted',
        none: 'accepted',
      });
      for (const name of ['negative', 'tooBig', 'fraction', 'amountOnly', 'currencyOnly'] as const) {
        expect(RULE_REFUSALS, `${name} was ${result[name]}`).toContain(result[name]);
      }
    });

    it('currency is exactly NGN, GHS, KES or ZAR: USD, a lower-case code, a near-miss and the empty string are refused (D-L115)', async () => {
      requirePlanted();
      const result = await asA1Agent(async (query) => {
        const out: Record<string, string> = {};
        for (const code of ['NGN', 'GHS', 'KES', 'ZAR', 'USD', 'ngn', 'NGN ', 'XOF', 'EUR', '']) {
          out[JSON.stringify(code)] = await tryDeal(query, { currency: code });
        }
        return out;
      });
      for (const code of ['NGN', 'GHS', 'KES', 'ZAR'])
        expect(result[JSON.stringify(code)], code).toBe('accepted');
      for (const code of ['USD', 'ngn', 'NGN ', 'XOF', 'EUR', '']) {
        const outcome = result[JSON.stringify(code)];
        expect(RULE_REFUSALS, `${JSON.stringify(code)} was ${outcome}`).toContain(outcome);
      }
    });

    it('text bounds: name 1..200, next_step 1..200 when set (R6)', async () => {
      requirePlanted();
      const result = await asA1Agent(async (query) => ({
        name200: await tryDeal(query, { name: 'n'.repeat(200) }),
        next200: await tryDeal(query, { nextStep: 's'.repeat(200) }),
        nextNull: await tryDeal(query, { nextStep: null }),
        nameEmpty: await tryDeal(query, { name: '' }),
        name201: await tryDeal(query, { name: 'n'.repeat(201) }),
        nextEmpty: await tryDeal(query, { nextStep: '' }),
        next201: await tryDeal(query, { nextStep: 's'.repeat(201) }),
      }));
      expect(result).toMatchObject({
        name200: 'accepted',
        next200: 'accepted',
        nextNull: 'accepted',
      });
      for (const name of ['nameEmpty', 'name201', 'nextEmpty', 'next201'] as const) {
        expect(RULE_REFUSALS, `${name} was ${result[name]}`).toContain(result[name]);
      }
    });

    it('a deal’s stage belongs to its own pipeline, and its pipeline, contact and account to its programme, even for a supervisor who sees both', async () => {
      requirePlanted();
      const [, otherA1Contact] = seededContacts(PROGRAMME_A1);
      const result = await rolledBackTenantTx(
        appPool,
        TENANT_A,
        USER_A_SUPERVISOR,
        async (query) => ({
          control: await tryDeal(query, { contact: otherA1Contact }),
          otherPipelinesStage: await tryDeal(query, { stageId: Q0 }),
          secondPipeline: await tryDeal(query, { pipelineId: P2_A1, stageId: Q0 }),
          a2Pipeline: await tryDeal(query, { pipelineId: FX_A2.P, stageId: FX_A2.S0 }),
          a2Contact: await tryDeal(query, { contact: FX_A2.contact }),
          a2Account: await tryDeal(query, { account: FX_A2.account }),
          a2Owner: await tryDeal(query, { owner: USER_A_AGENT_2 }),
        }),
      );
      // The control and its in-pipeline twin: references inside A1 are fine.
      expect(result.control).toBe('accepted');
      expect(result.secondPipeline).toBe('accepted');
      // An A2 member as owner is the repository's business (D-L67), not the key's.
      expect(['accepted', ...REFUSALS]).toContain(result.a2Owner);
      for (const name of ['otherPipelinesStage', 'a2Pipeline', 'a2Contact', 'a2Account'] as const) {
        expect(REFUSALS, `${name} was ${result[name]}`).toContain(result[name]);
      }
    });

    it('a contact, account or owner of tenant B is refused', async () => {
      requirePlanted();
      const result = await asA1Agent(async (query) => ({
        contact: await tryDeal(query, { contact: FX_B1.contact }),
        account: await tryDeal(query, { account: FX_B1.account }),
        owner: await tryDeal(query, { owner: USER_B_AGENT_1 }),
      }));
      expect(result).toEqual({
        contact: 'foreign_key_violation',
        account: 'foreign_key_violation',
        owner: 'foreign_key_violation',
      });
    });

    it.each([
      ['an A2 contact', 'contact', FX_A2.contact],
      ['a tenant-B user', 'owner', USER_B_AGENT_1],
      ['an A2 account', 'account', FX_A2.account],
    ] as const)(
      '%s fails exactly as an invented id (no existence oracle across the boundary)',
      async (_what, column, realId) => {
        requirePlanted();
        const invented = randomUUID();
        const fixedId = id106('ee0001');
        const [real, fake] = await asA1Agent(async (query) => {
          const attempt = (value: string) =>
            probe(
              query,
              INSERT_DEAL,
              dealValues(FX_A1, {
                id: fixedId,
                pipelineId: FX_A1.P,
                stageId: FX_A1.S0,
                [column]: value,
              }),
            );
          return [await attempt(realId), await attempt(invented)] as const;
        });
        const normalise = (outcome: Outcome, id: string) =>
          outcome.accepted
            ? 'accepted'
            : {
                code: outcome.code,
                message: outcome.message.split(id).join('<id>'),
                detail: outcome.detail.split(id).join('<id>'),
              };
        expect(REFUSALS).toContain(verdict(real));
        expect(normalise(real, realId)).toEqual(normalise(fake, invented));
      },
    );

    it('(R5) kasuwa_app changes a deal’s stage only along a transition of its pipeline', async () => {
      requirePlanted();
      const move = (query: Query, deal: string, stage: string) =>
        probe(query, 'UPDATE deal SET stage_id = $2 WHERE id = $1 RETURNING id', [
          deal,
          stage,
        ]).then(verdict);
      const result = await asA1Agent(async (query) => ({
        onList: await move(query, FX_A1.D, FX_A1.S0), // S1 > S0
        toWon: await move(query, FX_A1.D, FX_A1.SW), // S1 > SW
        same: await move(query, FX_A1.D, FX_A1.S1), // no change
        skip: await move(query, FX_A1.D, FX_A1.SLEAF), // S1 > SLEAF: not on the list
        backwardsOff: await move(query, FX_A1.DLEAF, FX_A1.SW), // S0 > SW: not on the list
        intoOtherPipeline: await move(query, FX_A1.DLEAF, Q0),
      }));
      expect(result).toMatchObject({ onList: 'accepted', toWon: 'accepted', same: 'accepted' });
      for (const name of ['skip', 'backwardsOff', 'intoOtherPipeline'] as const) {
        expect(REFUSALS, `${name} was ${result[name]}`).toContain(result[name]);
      }
    });

    it('(R15) version moves exactly once per UPDATE; updated_at moves unless the statement writes it', async () => {
      requirePlanted();
      const PAST = '2020-01-01 00:00:00+00';
      const steps = await asA1Agent(async (query) => {
        const id = randomUUID();
        await query(INSERT_DEAL, dealValues(FX_A1, { id, pipelineId: FX_A1.P, stageId: FX_A1.S0 }));
        await query(`UPDATE deal SET updated_at = $2::timestamptz WHERE id = $1`, [id, PAST]);
        const step = async (assignments: string) =>
          (
            await query<{ version: number; touched: boolean; updated_at: string }>(
              `UPDATE deal SET ${assignments} WHERE tenant_id = $1 AND id = $2
               RETURNING version, updated_at > $3::timestamptz AS touched, updated_at::text AS updated_at`,
              [TENANT_A, id, PAST],
            )
          )[0];
        return {
          forgetsBoth: await step(`name = 'T-0106 renamed'`),
          bumpsItself: await step(`name = 'T-0106 again', version = version + 1`),
          writesUpdatedAt: await step(
            `next_step = 'T-0106 call', updated_at = '2021-01-01 00:00:00+00'`,
          ),
        };
      });
      // The first statement above (setting updated_at) is itself an UPDATE: version 2.
      expect(steps.forgetsBoth).toMatchObject({ version: 3, touched: true });
      expect(steps.bumpsItself).toMatchObject({ version: 4, touched: true });
      expect(steps.writesUpdatedAt).toEqual({
        version: 5,
        touched: true,
        updated_at: '2021-01-01 00:00:00+00',
      });
    });

    it('(R7) a check names only a check requirement of the deal’s own pipeline, once, by a user of the tenant', async () => {
      requirePlanted();
      const result = await asA1Agent(async (query) => {
        const tick = (overrides: Json) =>
          cloneSql(query, 'deal_requirement_check').then((sql) =>
            probe(query, sql, [FX_A1.K, JSON.stringify({ id: randomUUID(), ...overrides })]).then(
              verdict,
            ),
          );
        return {
          control: await tick({ requirement_id: FX_A1.RC2 }),
          again: await tick({}),
          fieldRequirement: await tick({ requirement_id: FX_A1.RF }),
          // Same programme, another pipeline: only a pipeline-carrying key stops it.
          otherPipeline: await tick({ requirement_id: RQ }),
          otherProgramme: await tick({ requirement_id: FX_A2.RC }),
          otherProgrammesDeal: await tick({ deal_id: FX_A2.D }),
          tenantBUser: await tick({
            requirement_id: FX_A1.RC2,
            checked_by_user_id: USER_B_AGENT_1,
          }),
          update: verdict(
            await probe(
              query,
              `UPDATE deal_requirement_check SET checked_at = now() - interval '1 day' WHERE id = $1 RETURNING id`,
              [FX_A1.K],
            ),
          ),
        };
      });
      expect(result.control).toBe('accepted');
      expect(result.again, 'a second tick of the same requirement').toBe('unique_violation');
      for (const name of [
        'fieldRequirement',
        'otherPipeline',
        'otherProgramme',
        'otherProgrammesDeal',
        'tenantBUser',
        'update',
      ] as const) {
        expect(REFUSALS, `${name} was ${result[name]}`).toContain(result[name]);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // K. Keys: the allow-list guard, rotation, moves and offboarding
  // ---------------------------------------------------------------------------
  describe('keys: the allow-list guard, rotation, moves and offboarding', () => {
    /** The key attempts per table, on LEAF rows unless said otherwise. */
    const attempts = (): [Table, string, string, unknown[]][] => [
      // Not evidence of a guard: RESTRICT FKs from the stages refuse first (header).
      ['pipeline', 'id', 'UPDATE pipeline SET id = $2 WHERE id = $1', [FX_A1.P, id106('ff0001')]],
      [
        'pipeline_stage',
        'id',
        'UPDATE pipeline_stage SET id = $2 WHERE id = $1',
        [FX_A1.SLEAF, id106('ff0002')],
      ],
      [
        'pipeline_stage',
        'pipeline_id',
        'UPDATE pipeline_stage SET pipeline_id = $2, position = 50 WHERE id = $1',
        [FX_A1.SLEAF, P2_A1],
      ],
      [
        'pipeline_stage_transition',
        'id',
        'UPDATE pipeline_stage_transition SET id = $2 WHERE id = $1',
        [FX_A1.TLEAF, id106('ff0003')],
      ],
      [
        'pipeline_stage_transition',
        'to_stage_id',
        'UPDATE pipeline_stage_transition SET to_stage_id = $2 WHERE id = $1',
        [FX_A1.TLEAF, FX_A1.SLEAF],
      ],
      [
        'pipeline_stage_requirement',
        'id',
        'UPDATE pipeline_stage_requirement SET id = $2 WHERE id = $1',
        [FX_A1.RC2, id106('ff0004')],
      ],
      [
        'pipeline_stage_requirement',
        'stage_id',
        'UPDATE pipeline_stage_requirement SET stage_id = $2 WHERE id = $1',
        [FX_A1.RC2, FX_A1.SLEAF],
      ],
      ['deal', 'id', 'UPDATE deal SET id = $2 WHERE id = $1', [FX_A1.DLEAF, id106('ff0005')]],
      [
        'deal',
        'pipeline_id',
        'UPDATE deal SET pipeline_id = $2, stage_id = $3 WHERE id = $1',
        [FX_A1.DLEAF, P2_A1, Q0],
      ],
      [
        'deal_requirement_check',
        'id',
        'UPDATE deal_requirement_check SET id = $2 WHERE id = $1',
        [FX_A1.K, id106('ff0006')],
      ],
      [
        'deal_requirement_check',
        'requirement_id',
        'UPDATE deal_requirement_check SET requirement_id = $2 WHERE id = $1',
        [FX_A1.K, FX_A1.RC2],
      ],
      [
        'deal_requirement_check',
        'deal_id',
        'UPDATE deal_requirement_check SET deal_id = $2 WHERE id = $1',
        [FX_A1.K, FX_A1.DLEAF],
      ],
    ];

    const rowOf = async (query: Query, table: string, id: string) =>
      JSON.stringify(
        (
          await query<{ row: unknown }>(
            `SELECT to_jsonb(r) AS row FROM ${table} r WHERE r.id = $1`,
            [id],
          )
        )[0]?.row ?? null,
      );

    it('(control) on a trigger-free, FK-free copy of each table every key statement really changes the row', async () => {
      requirePlanted();
      const onCopy = await rolledBackTx(migrator, async (query) => {
        const result: Record<string, string> = {};
        for (const table of TABLES) {
          await query(`CREATE TABLE t0106_copy_${table} (LIKE ${table} INCLUDING DEFAULTS)`);
          await query(
            `INSERT INTO t0106_copy_${table} SELECT * FROM ${table} WHERE tenant_id = $1`,
            [TENANT_A],
          );
        }
        for (const [table, column, sql, values] of attempts()) {
          const copySql = sql.replace(`UPDATE ${table} `, `UPDATE t0106_copy_${table} `);
          const outcome = await probe(query, `${copySql} RETURNING 1`, values);
          result[`${table}.${column}`] = outcome.accepted
            ? `accepted:${outcome.rows}`
            : verdict(outcome);
        }
        return result;
      });
      expect(Object.values(onCopy), JSON.stringify(onCopy)).toEqual(
        attempts().map(() => 'accepted:1'),
      );
    });

    it.each(['kasuwa_app', 'kasuwa_test_admin'] as const)(
      '%s cannot change a key or a parent reference (D-L76): refused or silently kept',
      async (role) => {
        requirePlanted();
        const problems: string[] = [];
        for (const [table, column, sql, values] of attempts()) {
          const id = String(values[0]);
          const before = await rowOf(asMigrator(), table, id);
          expect(JSON.parse(before), `${table} fixture ${id} is missing`).not.toBeNull();
          const attempt = async (query: Query) => {
            const outcome = verdict(await probe(query, sql, values, true));
            return { outcome, changed: (await rowOf(query, table, id)) !== before };
          };
          const result =
            role === 'kasuwa_app'
              ? await rolledBackTenantTx(appPool, TENANT_A, USER_A_SUPERVISOR, attempt)
              : await rolledBackTx(testAdmin, attempt);
          if (!['accepted', 'unique_violation', ...REFUSALS].includes(result.outcome)) {
            problems.push(`${table}.${column}: ${result.outcome}`);
          }
          if (result.changed) problems.push(`${table}.${column} was changed (${result.outcome})`);
        }
        expect(problems).toEqual([]);
      },
    );

    it('the allow-list’s one exception: kasuwa_migrator can change a leaf row’s id', async () => {
      requirePlanted();
      const result = await rolledBackTx(migrator, async (query) => {
        const out: Record<string, string> = {};
        for (const [table, column, sql, values] of attempts()) {
          if (column !== 'id' || table === 'pipeline') continue;
          const outcome = await probe(query, `${sql} RETURNING 1`, values);
          out[table] = outcome.accepted ? `accepted:${outcome.rows}` : verdict(outcome);
        }
        return out;
      });
      expect(result).toEqual({
        pipeline_stage: 'accepted:1',
        pipeline_stage_transition: 'accepted:1',
        pipeline_stage_requirement: 'accepted:1',
        deal: 'accepted:1',
        deal_requirement_check: 'accepted:1',
      });
    });

    it('a one-statement rotation of stage or contact ids is refused while a deal references one; a contact or account with a deal cannot move programme', async () => {
      requirePlanted();
      // Fresh rows, referenced by ONE deal and nothing else, so a refusal is
      // the deal's FK and not some other table's. X < Y as uuids and X is
      // inserted first, so every scan reaches X first (Y first raises 23505,
      // never counted as a refusal).
      const PR = id106('fd0100');
      const stageX = id106('fd0001');
      const stageY = id106('fd0002');
      const won = id106('fd0003');
      const lost = id106('fd0004');
      const contactX = id106('fd0011');
      const contactY = id106('fd0012');
      const contactFree = id106('fd0013');
      const accountX = id106('fd0021');
      const accountFree = id106('fd0022');
      const dealId = id106('fd0031');
      const result = await rolledBackTx(migrator, async (query) => {
        // The control, on throwaway NO ACTION tables: the rotation statement
        // really rotates and re-points, so "refused" below is the RESTRICT.
        await query(`CREATE TABLE t0106_parent (
                       id uuid PRIMARY KEY, tenant_id uuid NOT NULL, label text NOT NULL,
                       UNIQUE (tenant_id, id))`);
        await query(`CREATE TABLE t0106_child (
                       id uuid PRIMARY KEY, tenant_id uuid NOT NULL, parent_id uuid,
                       FOREIGN KEY (tenant_id, parent_id) REFERENCES t0106_parent (tenant_id, id))`);
        await query(
          `INSERT INTO t0106_parent (id, tenant_id, label) VALUES ($1, $3, 'X'), ($2, $3, 'Y')`,
          [stageX, stageY, TENANT_A],
        );
        await query('INSERT INTO t0106_child (id, tenant_id, parent_id) VALUES ($1, $2, $3)', [
          randomUUID(),
          TENANT_A,
          stageX,
        ]);
        const controlOutcome = verdict(
          await probe(
            query,
            rotationSql('t0106_parent'),
            [stageX, stageY, id106('fa0001'), TENANT_A],
            true,
          ),
        );
        // probe() switched to SET CONSTRAINTS ALL IMMEDIATE and RELEASE keeps that mode, so put
        // deferral back before building a pipeline in two statements (D-L119).
        await query('SET CONSTRAINTS ALL DEFERRED');
        const childPointsAt = await query<{ label: string }>(
          `SELECT p.label FROM t0106_child c JOIN t0106_parent p ON p.tenant_id = c.tenant_id AND p.id = c.parent_id`,
        );

        for (const [id, name] of [
          [contactX, 'T-0106 Rotation X'],
          [contactY, 'T-0106 Rotation Y'],
          [contactFree, 'T-0106 Free Contact'],
        ] as const) {
          await query(
            'INSERT INTO contact (id, tenant_id, programme_id, display_name) VALUES ($1, $2, $3, $4)',
            [id, TENANT_A, PROGRAMME_A1, name],
          );
        }
        for (const id of [accountX, accountFree]) {
          await query(
            'INSERT INTO account (id, tenant_id, programme_id, name) VALUES ($1, $2, $3, $4)',
            [id, TENANT_A, PROGRAMME_A1, 'T-0106 Rotation Account'],
          );
        }
        await query(INSERT_PIPELINE, [PR, TENANT_A, PROGRAMME_A1, 'T-0106 rotation']);
        const [stagesSql, stagesValues] = stageStatement(TENANT_A, PROGRAMME_A1, PR, [
          { id: stageX, kind: 'open', position: 0 },
          { id: stageY, kind: 'open', position: 1 },
          { id: won, kind: 'won', position: 2 },
          { id: lost, kind: 'lost', position: 3 },
        ]);
        await query(stagesSql, stagesValues);
        await query(
          INSERT_DEAL,
          dealValues(FX_A1, {
            id: dealId,
            pipelineId: PR,
            stageId: stageX,
            contact: contactX,
            account: accountX,
          }),
        );
        const dealBefore = await rowOf(query, 'deal', dealId);
        const move = (table: string, id: string) =>
          probe(query, `UPDATE ${table} SET programme_id = $2 WHERE id = $1 RETURNING id`, [
            id,
            PROGRAMME_A2,
          ]).then(verdict);
        return {
          control: `${controlOutcome}:${String(childPointsAt[0]?.label)}`,
          stageRotation: verdict(
            await probe(
              query,
              rotationSql('pipeline_stage'),
              [stageX, stageY, id106('fa0002'), TENANT_A],
              true,
            ),
          ),
          contactRotation: verdict(
            await probe(
              query,
              rotationSql('contact'),
              [contactX, contactY, id106('fa0003'), TENANT_A],
              true,
            ),
          ),
          dealUnchanged: (await rowOf(query, 'deal', dealId)) === dealBefore,
          freeContactMove: await move('contact', contactFree),
          freeAccountMove: await move('account', accountFree),
          contactMove: await move('contact', contactX),
          accountMove: await move('account', accountX),
        };
      });
      expect(result.control, 'the rotation on NO ACTION tables rotates and re-points').toBe(
        'accepted:Y',
      );
      // The controls: the same move of an unreferenced contact or account is accepted.
      expect(result).toMatchObject({ freeContactMove: 'accepted', freeAccountMove: 'accepted' });
      expect(REFUSALS, `the stage rotation was ${result.stageRotation}`).toContain(
        result.stageRotation,
      );
      expect(REFUSALS, `the contact rotation was ${result.contactRotation}`).toContain(
        result.contactRotation,
      );
      expect(result.dealUnchanged, 'the deal was re-pointed').toBe(true);
      expect(REFUSALS, `moving a contact with a deal was ${result.contactMove}`).toContain(
        result.contactMove,
      );
      expect(REFUSALS, `moving an account with a deal was ${result.accountMove}`).toContain(
        result.accountMove,
      );
    });

    it('offboarding still works: kasuwa_migrator deletes a programme, then a tenant, holding all six kinds of row', async () => {
      requirePlanted();
      const result = await rolledBackTx(migrator, async (query) => {
        const tenantId = id106('fb0001');
        const bu = id106('fb0002');
        const user = id106('fb0003');
        const programmes = [id106('fb0011'), id106('fb0012')];
        await query(`INSERT INTO tenant (id, name, slug) VALUES ($1, 'T-0106 Leaving Ltd', $2)`, [
          tenantId,
          `t0106-leaving-${RUN}`,
        ]);
        await query(
          `INSERT INTO business_unit (id, tenant_id, name) VALUES ($1, $2, 'Head office')`,
          [bu, tenantId],
        );
        await query(
          `INSERT INTO programme (id, tenant_id, business_unit_id, name, is_default)
           VALUES ($1, $3, $4, 'Default', true), ($2, $3, $4, 'Client Two', false)`,
          [programmes[0], programmes[1], tenantId, bu],
        );
        await query(
          `INSERT INTO "user" (id, tenant_id, email, display_name) VALUES ($1, $2, $3, 'T-0106 Admin')`,
          [user, tenantId, `admin.${RUN}@t0106.test`],
        );
        const fixtures = programmes.map((programmeId, index) => {
          const scope = `ff1${index}`;
          return fixture(
            idIn(scope),
            tenantId,
            programmeId,
            user,
            'ZAR',
            idIn(scope)('9c0001'),
            idIn(scope)('9a0001'),
          );
        });
        for (const f of fixtures) {
          await query(
            'INSERT INTO contact (id, tenant_id, programme_id, display_name) VALUES ($1, $2, $3, $4)',
            [f.contact, tenantId, f.programmeId, 'T-0106 Leaving Contact'],
          );
          await query(
            'INSERT INTO account (id, tenant_id, programme_id, name) VALUES ($1, $2, $3, $4)',
            [f.account, tenantId, f.programmeId, 'T-0106 Leaving Account'],
          );
          for (const [sql, values] of fixtureStatements(f)) await query(sql, values);
        }
        const counts = async (column: string, id: string) =>
          (
            await query<{ n: number }>(
              `SELECT (${TABLES.map((table) => `(SELECT count(*) FROM ${table} WHERE ${column} = $1)`).join(' + ')})::int AS n`,
              [id],
            )
          )[0]?.n;
        const before = await counts('tenant_id', tenantId);
        const programme = verdict(
          await probe(query, 'DELETE FROM programme WHERE id = $1', [programmes[1]], true),
        );
        const afterProgramme = await counts('programme_id', programmes[1] ?? '');
        const tenant = verdict(
          await probe(query, 'DELETE FROM tenant WHERE id = $1', [tenantId], true),
        );
        const afterTenant = await counts('tenant_id', tenantId);
        return { planted: (before ?? 0) >= 2 * 19, programme, afterProgramme, tenant, afterTenant };
      });
      expect(result).toEqual({
        planted: true,
        programme: 'accepted',
        afterProgramme: 0,
        tenant: 'accepted',
        afterTenant: 0,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // I. Indexes
  // ---------------------------------------------------------------------------
  describe('indexes (D-P33)', () => {
    it('every index on the six tables is valid, with plain-column keys and no function call in its predicate', async () => {
      const rows = await migrator.query<{
        table: string;
        def: string;
        valid: boolean;
        expressions: boolean;
        predicate: string | null;
      }>(
        `SELECT c.relname AS table, pg_get_indexdef(x.indexrelid) AS def, x.indisvalid AS valid,
                x.indexprs IS NOT NULL AS expressions, pg_get_expr(x.indpred, x.indrelid) AS predicate
           FROM pg_index x JOIN pg_class c ON c.oid = x.indrelid
          WHERE c.oid = ANY (SELECT to_regclass('public.' || t) FROM unnest($1::text[]) AS t)
          ORDER BY 1, 2`,
        [[...TABLES]],
      );
      expect(
        new Set(rows.rows.map((row) => row.table)).size,
        'indexes found on the six tables',
      ).toBe(6);
      const problems = rows.rows.flatMap((row) => [
        ...(row.valid ? [] : [`${row.def}: not valid`]),
        ...(row.expressions ? [`${row.def}: an expression key`] : []),
        // A function call (`lower(`, `coalesce(`) in the predicate; a cast
        // such as 'won'::text is not one.
        ...(row.predicate !== null && /\b[a-z_][a-z0-9_]*\s*\(/i.test(row.predicate)
          ? [`${row.def}: a function in the predicate`]
          : []),
      ]);
      expect(problems).toEqual([]);
    });

    const explain = async (sql: string) =>
      rolledBackTenantTx(appPool, TENANT_A, USER_A_AGENT_1, async (query) => {
        await query('SET LOCAL enable_seqscan = off');
        await query('SET LOCAL enable_bitmapscan = off');
        await query('SET LOCAL enable_sort = off');
        await query('SET LOCAL enable_incremental_sort = off');
        const plan = await query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`);
        return plan.map((row) => row['QUERY PLAN']).join('\n');
      });

    const literal = (id: string) => {
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`not a uuid: ${id}`);
      return `'${id}'::uuid`;
    };

    it('(R14) the board’s open column is read by an index in stage_entered_at, id order, under FORCE RLS', async () => {
      requirePlanted();
      const plan = await explain(
        `SELECT id FROM deal
          WHERE tenant_id = ${literal(TENANT_A)} AND programme_id = ${literal(PROGRAMME_A1)}
            AND pipeline_id = ${literal(FX_A1.P)} AND stage_id = ${literal(FX_A1.S1)}
          ORDER BY stage_entered_at, id LIMIT 21`,
      );
      expect(plan, plan).toMatch(/Index (Only )?Scan( Backward)? using \S+ on deal\b/);
      expect(plan, plan).not.toMatch(/\bSort\b/);
    });

    it('(R14) the board’s won column is read by an index in closed_at DESC, id DESC order, under FORCE RLS', async () => {
      requirePlanted();
      const plan = await explain(
        `SELECT id FROM deal
          WHERE tenant_id = ${literal(TENANT_A)} AND programme_id = ${literal(PROGRAMME_A1)}
            AND pipeline_id = ${literal(FX_A1.P)} AND stage_id = ${literal(FX_A1.SW)}
            AND closed_at >= '2026-07-01T00:00:00Z'::timestamptz
          ORDER BY closed_at DESC, id DESC LIMIT 21`,
      );
      expect(plan, plan).toMatch(/Index (Only )?Scan( Backward)? using \S+ on deal\b/);
      expect(plan, plan).not.toMatch(/\bSort\b/);
    });
  });

  // ---------------------------------------------------------------------------
  // O. The deal standard object (on the seeded tenants and a fresh one)
  // ---------------------------------------------------------------------------
  describe('deal is a standard object with a field for each business column (D-L115, R13)', () => {
    it.each(SEED_TENANTS.map((tenant) => [tenant.slug, tenant.id] as const))(
      '%s: one standard deal object; name and next_step pii; lookups as pinned',
      async (_slug, tenantId) => {
        const objects = (await migrator.query<ObjectRow>(DEAL_OBJECT_SQL, [tenantId])).rows;
        const fields = (await migrator.query<FieldRow>(DEAL_FIELDS_SQL, [tenantId])).rows;
        expect(dealCatalogueProblems(objects, fields)).toEqual([]);
      },
    );

    it('(self-check, passes on main) the catalogue check rejects a name not classified pii, a stray field and a missing object', () => {
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
        api_name: 'deal',
        label: 'Deal',
        plural_label: 'Deals',
        is_custom: false,
      };
      const good = REQUIRED_DEAL_FIELDS.map((name) =>
        name === 'primary_contact_id'
          ? field(name, { type: 'lookup', config: '{"targetObjectApiName": "contact"}' })
          : name === 'account_id'
            ? field(name, { type: 'lookup', config: '{"targetObjectApiName":"account"}' })
            : field(name),
      );
      expect(dealCatalogueProblems([object], good)).toEqual([]);
      expect(
        dealCatalogueProblems(
          [object],
          good.map((row) =>
            row.api_name === 'next_step' ? { ...row, classification: 'none' } : row,
          ),
        ),
      ).toEqual(['next_step: classified none, expected pii']);
      expect(dealCatalogueProblems([object], [...good, field('amount_minor')])).toHaveLength(1);
      expect(
        dealCatalogueProblems(
          [object],
          good.filter((row) => row.api_name !== 'name'),
        ),
      ).toHaveLength(1);
      expect(dealCatalogueProblems([], good)).toHaveLength(1);
      expect(
        dealCatalogueProblems(
          [object],
          good.map((row) =>
            row.api_name === 'account_id'
              ? { ...row, config: '{"targetObjectApiName":"contact"}' }
              : row,
          ),
        ),
      ).toHaveLength(1);
    });

    it('ensureStandardObjectDefs gives a fresh tenant exactly the seeded tenants’ deal catalogue', async () => {
      const seededObject = (await migrator.query<ObjectRow>(DEAL_OBJECT_SQL, [TENANT_A])).rows;
      const seededFields = (await migrator.query<FieldRow>(DEAL_FIELDS_SQL, [TENANT_A])).rows;
      expect(seededFields.length, 'the seeded tenant has no deal fields').toBeGreaterThan(0);
      expect((await migrator.query<FieldRow>(DEAL_FIELDS_SQL, [TENANT_B])).rows).toEqual(
        seededFields,
      );
      const fresh = await rolledBackTx(migrator, async (query) => {
        const tenantId = randomUUID();
        await query(`INSERT INTO tenant (id, name, slug) VALUES ($1, 'T-0106 Fresh Ltd', $2)`, [
          tenantId,
          `t0106-fresh-${RUN}`,
        ]);
        await ensureStandardObjectDefs((text, values) => query(text, [...values]), tenantId);
        return {
          objects: await query<ObjectRow>(DEAL_OBJECT_SQL, [tenantId]),
          fields: await query<FieldRow>(DEAL_FIELDS_SQL, [tenantId]),
        };
      });
      expect(fresh.objects).toEqual(seededObject);
      expect(fresh.fields).toEqual(seededFields);
    });
  });
});

// =============================================================================
// 2. The default pipeline: seed, createProgramme, provisioning, repair
// =============================================================================

const PROVISIONING = '@kasuwa/domain-core/provisioning';

interface ProvisionedTenant {
  tenantId: string;
  programmeId: string;
  adminUserId: string;
}

type ProvisionTenant = (options: {
  connectionString: string;
  slug: string;
  name: string;
  adminEmail: string;
  adminDisplayName: string;
}) => Promise<ProvisionedTenant>;

async function loadProvisionTenant(): Promise<ProvisionTenant> {
  const loaded = (await import(PROVISIONING)) as Record<string, unknown>;
  const candidate = loaded.provisionTenant;
  if (typeof candidate !== 'function')
    throw new Error(`${PROVISIONING} does not export provisionTenant`);
  return candidate as ProvisionTenant;
}

describe('acceptance: every programme has its default pipeline (T-0106, D-L113)', () => {
  let appPool: Pool;
  let migrator: Pool;
  const asMigrator: () => Query = () => async (text, params) =>
    (await migrator.query(text, params)).rows;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  afterAll(async () => {
    await appPool?.end();
    await migrator?.end();
    await reseed(inject('migrationUrl'));
  });

  it('(self-check, passes on main) the template is the contract’s getPipeline example, and the seed rule reproduces its 30 transitions', () => {
    const example = contractExample();
    const byId = new Map(example.stages.map((stage) => [stage.id, stage.name]));
    const listed = example.transitions
      .map((pair) => `${byId.get(pair.fromStageId) ?? '?'}>${byId.get(pair.toStageId) ?? '?'}`)
      .sort();
    const built = template();
    expect(built.transitions).toEqual(listed);
    expect(built.transitions).toHaveLength(30);
    expect(built.name).toBe('B2B sales');
    expect(
      built.stages.map((stage) => `${stage.name}:${stage.kind}:${stage.probabilityBp}`),
    ).toEqual([
      'Qualified:open:1000',
      'Discovery:open:2500',
      'Proposal:open:5000',
      'Negotiation:open:7000',
      'Contract:open:9000',
      'Won:won:10000',
      'Lost:lost:0',
    ]);
    expect(
      built.stages.flatMap((stage) => stage.requirements.map((r) => r.field ?? r.label)),
    ).toEqual([
      'Budget range confirmed with the customer',
      'amount',
      'expected_close_date',
      'Quote sent to the customer',
      'primary_contact_id',
      'Purchase order received',
    ]);
    // The rule is not vacuous: a planted extra pair, a dropped one and a
    // won-from-anywhere reading all differ from the contract's list.
    expect([...listed, 'Won>Lost'].sort()).not.toEqual(built.transitions);
    expect(listed.filter((pair) => pair !== 'Contract>Won')).not.toEqual(built.transitions);
    expect(listed.includes('Proposal>Won')).toBe(false);
  });

  it.each(
    SEED_TENANTS.flatMap((tenant) =>
      tenant.programmes.map((programme) => [programme.name, programme.id] as const),
    ),
  )(
    'seeded programme %s has exactly one pipeline, built from the template',
    async (_name, programmeId) => {
      const snapshot = await programmePipelines(asMigrator(), programmeId);
      expect(snapshot.count, 'pipelines in the programme').toBe(1);
      expect(shapeOf(snapshot)).toEqual([template()]);
    },
  );

  it('every pipeline row of a seeded programme carries that programme and its tenant', async () => {
    const rows = await migrator.query<{ problem: string }>(
      `SELECT t || ':' || x.id AS problem
         FROM unnest($1::text[]) AS t
        CROSS JOIN LATERAL (
          SELECT r.id FROM pipeline_stage r JOIN pipeline p ON p.id = r.pipeline_id
           WHERE t = 'pipeline_stage' AND (r.programme_id, r.tenant_id) <> (p.programme_id, p.tenant_id)
          UNION ALL
          SELECT r.id FROM pipeline_stage_transition r JOIN pipeline p ON p.id = r.pipeline_id
           WHERE t = 'pipeline_stage_transition' AND (r.programme_id, r.tenant_id) <> (p.programme_id, p.tenant_id)
          UNION ALL
          SELECT r.id FROM pipeline_stage_requirement r JOIN pipeline p ON p.id = r.pipeline_id
           WHERE t = 'pipeline_stage_requirement' AND (r.programme_id, r.tenant_id) <> (p.programme_id, p.tenant_id)
          UNION ALL
          SELECT p.id FROM pipeline p JOIN programme g ON g.id = p.programme_id
           WHERE t = 'pipeline' AND p.tenant_id <> g.tenant_id
        ) AS x`,
      [['pipeline', 'pipeline_stage', 'pipeline_stage_transition', 'pipeline_stage_requirement']],
    );
    // Not vacuous: the seeded pipelines exist (the test above), and a
    // missing table fails here with 42P01.
    expect(rows.rows).toEqual([]);
  });

  it('a session sees exactly the pipelines of its own programmes', async () => {
    const seeded = await migrator.query<{ id: string; programme_id: string }>(
      'SELECT id, programme_id FROM pipeline WHERE programme_id = ANY ($1::uuid[]) ORDER BY id',
      [[PROGRAMME_A1, PROGRAMME_A2, PROGRAMME_B1]],
    );
    const of = (programmeId: string) =>
      seeded.rows.filter((row) => row.programme_id === programmeId).map((row) => row.id);
    expect(of(PROGRAMME_A1), 'A1 has its default pipeline').toHaveLength(1);
    const visible = (tenantId: string, userId: string) =>
      withTenantTransaction(appPool, { tenantId, userId }, async (tx) =>
        (await tx.query<{ id: string }>('SELECT id FROM pipeline ORDER BY id')).map(
          (row) => row.id,
        ),
      );
    expect(await visible(TENANT_A, USER_A_AGENT_1)).toEqual(of(PROGRAMME_A1));
    expect(await visible(TENANT_A, USER_A_AGENT_2)).toEqual(of(PROGRAMME_A2));
    expect(await visible(TENANT_A, USER_A_NO_PROGRAMME)).toEqual([]);
    expect(await visible(TENANT_B, USER_B_AGENT_1)).toEqual(of(PROGRAMME_B1));
  });

  it('(R9) createProgramme, as a tenant admin over kasuwa_app, commits the new programme with exactly one template pipeline', async () => {
    const created = await withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
      (tx) => createProgramme(tx, { name: `T-0106 New Client ${RUN}`, businessUnitId: BU_A }),
    );
    const snapshot = await programmePipelines(asMigrator(), created.id);
    expect(snapshot.count, 'pipelines in the new programme').toBe(1);
    expect(shapeOf(snapshot)).toEqual([template()]);
    const tenants = await migrator.query<{ tenant_id: string }>(
      'SELECT DISTINCT tenant_id FROM pipeline WHERE programme_id = $1',
      [created.id],
    );
    expect(tenants.rows).toEqual([{ tenant_id: TENANT_A }]);
  });

  it('(R10) a programme inserted with plain SQL is repaired by ensureStandardObjectDefs, and a second call changes nothing', async () => {
    const result = await rolledBackTx(migrator, async (query) => {
      const programmeId = id106('fc0001');
      await query(
        `INSERT INTO programme (id, tenant_id, business_unit_id, name, is_default)
         VALUES ($1, $2, $3, $4, false)`,
        [programmeId, TENANT_A, BU_A, `T-0106 Window Client ${RUN}`],
      );
      const ensure = () =>
        ensureStandardObjectDefs((text, values) => query(text, [...values]), TENANT_A);
      await ensure();
      const once = await Promise.all(
        [PROGRAMME_A1, PROGRAMME_A2, programmeId].map((id) => programmePipelines(query, id)),
      );
      await ensure();
      const twice = await Promise.all(
        [PROGRAMME_A1, PROGRAMME_A2, programmeId].map((id) => programmePipelines(query, id)),
      );
      return { once, twice };
    });
    const [, , repaired] = result.once;
    expect(repaired?.count, 'pipelines in the repaired programme').toBe(1);
    expect(repaired === undefined ? null : shapeOf(repaired)).toEqual([template()]);
    expect(result.once.map((snapshot) => snapshot.count)).toEqual([1, 1, 1]);
    // Same ids, same everything: the second call wrote nothing.
    expect(result.twice).toEqual(result.once);
  });

  it('(P) ensureStandardObjectDefs again on a seeded tenant changes no pipeline', async () => {
    const before = await Promise.all(
      [PROGRAMME_A1, PROGRAMME_A2].map((id) => programmePipelines(asMigrator(), id)),
    );
    expect(
      before.map((snapshot) => snapshot.count),
      'the seeded pipelines exist',
    ).toEqual([1, 1]);
    const after = await rolledBackTx(migrator, async (query) => {
      await ensureStandardObjectDefs((text, values) => query(text, [...values]), TENANT_A);
      return Promise.all([PROGRAMME_A1, PROGRAMME_A2].map((id) => programmePipelines(query, id)));
    });
    expect(after).toEqual(before);
  });

  it('provisionTenant gives the new tenant’s default programme one template pipeline, and the seeded deal catalogue', async () => {
    const provisionTenant = await loadProvisionTenant();
    const provisioned = await provisionTenant({
      connectionString: inject('migrationUrl'),
      slug: `t0106-new-${RUN}`,
      name: 'Pipeline Provisioned Ltd',
      adminEmail: `admin.${RUN}@t0106.test`,
      adminDisplayName: 'T-0106 Provisioned Admin',
    });
    const snapshot = await programmePipelines(asMigrator(), provisioned.programmeId);
    expect(snapshot.count, 'pipelines in the provisioned default programme').toBe(1);
    expect(shapeOf(snapshot)).toEqual([template()]);
    const fields = (await migrator.query<FieldRow>(DEAL_FIELDS_SQL, [provisioned.tenantId])).rows;
    const seeded = (await migrator.query<FieldRow>(DEAL_FIELDS_SQL, [TENANT_A])).rows;
    expect(seeded.length, 'the seeded tenant has no deal fields').toBeGreaterThan(0);
    expect(fields).toEqual(seeded);
  }, 60_000);
});

// =============================================================================
// 3. The migration over a cell that pre-dates it: the clash, then the backfill
// =============================================================================

describe('acceptance: the pipeline migration over tenants and programmes that pre-date it (T-0106)', () => {
  const database = `kasuwa_t0106_${RUN}`;
  const LEGACY = [id106('100000000001'), id106('100000000002'), id106('100000000003')] as const;
  const BUS = [id106('100000000b01'), id106('100000000b02'), id106('100000000b03')] as const;
  /** Programmes per legacy tenant, with the status each pre-dates the migration in (R11). */
  const PROGRAMMES: readonly (readonly [string, number, string, boolean])[] = [
    [id106('100000000c11'), 0, 'active', true],
    [id106('100000000c21'), 1, 'active', true],
    [id106('100000000c22'), 1, 'archived', false],
    [id106('100000000c31'), 2, 'active', true],
    [id106('100000000c32'), 2, 'paused', false],
    [id106('100000000c33'), 2, 'draft', false],
  ];
  /** Two tenants' own custom `deal` objects: the clash (R12). */
  const CLASH_OBJECTS = [id106('1000000000f1'), id106('1000000000f2')];
  /** Not clashes, in the third tenant: a custom object `deal_note`, a custom field `deal` on contact. */
  const DEAL_NOTE = id106('1000000000f3');
  const CONTACT_DEAL_FIELD = id106('1000000000f4');

  let superuserUrl: URL | undefined;
  let legacyUrl = '';
  let legacy: Pool | undefined;
  let mainObserver: Pool;
  const tempDirs: string[] = [];

  /** Why the database could not be staged (on main: no pipeline migration). */
  let setupError: unknown;
  let migrationId = '';
  let clashError: unknown;
  let afterClash = { migrations: [] as string[], pipelineTable: false, standardDeal: -1 };
  let finalError: unknown;
  let tablesBefore: string[] = [];
  let definersBefore: string[] = [];
  let leakproofBefore: string[] = [];

  function migrationsBefore(bound: string): string {
    const dir = mkdtempSync(join(tmpdir(), 't0106-pre-'));
    tempDirs.push(dir);
    for (const name of readdirSync(MIGRATIONS_DIR)) {
      if (name.endsWith('.sql') && name < bound)
        copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
    }
    return dir;
  }

  const pool = (): Pool => {
    if (legacy === undefined) throw new Error('the pre-dating database was not built');
    return legacy;
  };
  const asLegacy: () => Query = () => async (text, params) =>
    (await pool().query(text, params)).rows;

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
      `SELECT to_regclass('public.pipeline') IS NOT NULL AS found`,
    );
    const standard = await p.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM object_def WHERE api_name = 'deal' AND NOT is_custom`,
    );
    return {
      migrations,
      pipelineTable: table.rows[0]?.found === true,
      standardDeal: standard.rows[0]?.n ?? -1,
    };
  }

  beforeAll(async () => {
    mainObserver = createPool({ connectionString: inject('migrationUrl'), max: 1 });
    const files = migrationsCreating('pipeline');
    const file = files[0];
    if (files.length !== 1 || file === undefined) {
      setupError = new Error(
        `expected exactly one migration that creates pipeline, found ${files.length}`,
      );
      return;
    }
    migrationId = file.replace(/\.sql$/, '');

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
      legacyUrl = url.href;

      // The chain before 0025, then the tenants (so 0025 onwards backfill
      // them as they would a real cell), then the chain before this migration.
      await runMigrations({ connectionString: legacyUrl, migrationsDir: migrationsBefore('0025') });
      legacy = createPool({ connectionString: legacyUrl, max: 2 });
      for (const [index, tenantId] of LEGACY.entries()) {
        await pool().query(`INSERT INTO tenant (id, name, slug) VALUES ($1, $2, $3)`, [
          tenantId,
          `Legacy ${index + 1}`,
          `t0106-legacy-${index + 1}`,
        ]);
        await pool().query(
          `INSERT INTO business_unit (id, tenant_id, name) VALUES ($1, $2, 'Head office')`,
          [BUS[index], tenantId],
        );
      }
      await runMigrations({ connectionString: legacyUrl, migrationsDir: migrationsBefore(file) });
      for (const [id, tenantIndex, status, isDefault] of PROGRAMMES) {
        await pool().query(
          `INSERT INTO programme (id, tenant_id, business_unit_id, name, is_default, status)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            id,
            LEGACY[tenantIndex],
            BUS[tenantIndex],
            `Legacy programme ${id.slice(-3)}`,
            isDefault,
            status,
          ],
        );
      }

      // The clash (R12): two tenants made a custom object called `deal`, one
      // with a field on it. The third has look-alikes only.
      for (const [index, tenantId] of [LEGACY[0], LEGACY[1]].entries()) {
        await pool().query(
          `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
           VALUES ($1, $2, 'deal', 'Opportunity', true)`,
          [CLASH_OBJECTS[index], tenantId],
        );
      }
      await pool().query(
        `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, is_custom)
         VALUES (gen_random_uuid(), $1, $2, 'stage_note', 'Stage note', 'text', true)`,
        [LEGACY[0], CLASH_OBJECTS[0]],
      );
      await pool().query(
        `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
         VALUES ($1, $2, 'deal_note', 'Deal note', true)`,
        [DEAL_NOTE, LEGACY[2]],
      );
      const contactObject = (
        await pool().query<{ id: string }>(
          `SELECT id FROM object_def WHERE tenant_id = $1 AND api_name = 'contact' AND NOT is_custom`,
          [LEGACY[2]],
        )
      ).rows[0];
      if (contactObject === undefined) throw new Error('0025 did not backfill contact');
      await pool().query(
        `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, is_custom)
         VALUES ($1, $2, $3, 'deal', 'Deal', 'text', true)`,
        [CONTACT_DEAL_FIELD, LEGACY[2], contactObject.id],
      );

      tablesBefore = (await pool().query<{ name: string }>(PUBLIC_TABLES_SQL)).rows.map(
        (row) => row.name,
      );
      definersBefore = (await pool().query<{ name: string }>(DEFINERS_SQL)).rows.map(
        (row) => row.name,
      );
      leakproofBefore = (await pool().query<{ name: string }>(LEAKPROOF_SQL)).rows.map(
        (row) => row.name,
      );

      // Phase 1: the rest of the chain must stop at this migration.
      try {
        await runMigrations({ connectionString: legacyUrl });
      } catch (error) {
        clashError = error;
      }
      afterClash = await snapshot(pool());

      // Phase 2: a human resolves the clash (field_def cascades); the chain applies.
      await pool().query('DELETE FROM object_def WHERE id = ANY ($1::uuid[])', [CLASH_OBJECTS]);
      try {
        await runMigrations({ connectionString: legacyUrl });
      } catch (error) {
        finalError = error;
      }
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

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

  it('(R12) a custom `deal` object in two tenants stops the migration, naming the object and the count', () => {
    requireStaged();
    expect(clashError, 'the migration applied over two tenants’ custom deal object').toBeInstanceOf(
      Error,
    );
    const message = clashError instanceof Error ? clashError.message : String(clashError);
    expect(message, 'the failure is not the pipeline migration’s').toContain(migrationId);
    expect(message).toMatch(/\bdeal\b/);
    expect(message, 'the count of tenants affected (2)').toMatch(/\b2\b/);
    expect(message, 'a look-alike in a third tenant was counted').not.toMatch(/\b3\b/);
  });

  it('and nothing of it was applied: no ledger row, no pipeline table, no standard deal object', () => {
    requireStaged();
    // Without a failure to inspect, the checks below hold trivially, so demand one first.
    expect(clashError, 'there was no failed migration to inspect').toBeInstanceOf(Error);
    expect(afterClash.migrations).not.toContain(migrationId);
    expect(afterClash.pipelineTable).toBe(false);
    expect(afterClash.standardDeal).toBe(0);
  });

  it('once the clash is resolved, the migration applies', async () => {
    requireStaged();
    expect(finalError === undefined ? null : String(finalError)).toBe(null);
    const applied = await pool().query<{ id: string }>(
      'SELECT id FROM _kasuwa_migration WHERE id = $1',
      [migrationId],
    );
    expect(applied.rows, 'the pipeline migration was not applied').toHaveLength(1);
  });

  it.each(
    PROGRAMMES.map(
      ([id, tenantIndex, status]) =>
        [`${status} programme of legacy tenant ${tenantIndex + 1}`, id] as const,
    ),
  )('(R11) backfills the %s with exactly one template pipeline', async (_what, programmeId) => {
    requireStaged();
    const snap = await programmePipelines(asLegacy(), programmeId);
    expect(snap.count, 'pipelines in the programme').toBe(1);
    expect(shapeOf(snap)).toEqual([template()]);
  });

  it.each(LEGACY.map((tenantId, index) => [index + 1, tenantId] as const))(
    'backfills legacy tenant %s with exactly the deal catalogue the seed writes',
    async (_index, tenantId) => {
      requireStaged();
      const seededObject = (await mainObserver.query<ObjectRow>(DEAL_OBJECT_SQL, [TENANT_A])).rows;
      const seededFields = (await mainObserver.query<FieldRow>(DEAL_FIELDS_SQL, [TENANT_A])).rows;
      expect(dealCatalogueProblems(seededObject, seededFields), 'the seeded tenant itself').toEqual(
        [],
      );
      expect((await pool().query<ObjectRow>(DEAL_OBJECT_SQL, [tenantId])).rows).toEqual(
        seededObject,
      );
      expect((await pool().query<FieldRow>(DEAL_FIELDS_SQL, [tenantId])).rows).toEqual(
        seededFields,
      );
    },
  );

  it('keeps the look-alikes, still custom', async () => {
    requireStaged();
    const rows = await pool().query<{ id: string; is_custom: boolean }>(
      `SELECT id, is_custom FROM object_def WHERE id = $1
       UNION ALL SELECT id, is_custom FROM field_def WHERE id = $2
       ORDER BY id`,
      [DEAL_NOTE, CONTACT_DEAL_FIELD],
    );
    expect(rows.rows).toEqual(
      [DEAL_NOTE, CONTACT_DEAL_FIELD].sort().map((id) => ({ id, is_custom: true })),
    );
  });

  it('re-running is idempotent: runMigrations and ensureStandardObjectDefs again change no pipeline', async () => {
    requireStaged();
    expect(
      finalError === undefined ? null : String(finalError),
      'the migration did not apply',
    ).toBe(null);
    const all = () => Promise.all(PROGRAMMES.map(([id]) => programmePipelines(asLegacy(), id)));
    const before = await all();
    expect(
      before.map((snap) => snap.count),
      'the backfilled pipelines exist',
    ).toEqual(PROGRAMMES.map(() => 1));
    await runMigrations({ connectionString: legacyUrl });
    for (const tenantId of LEGACY) {
      await ensureStandardObjectDefs(
        async (text, values) => (await pool().query(text, [...values])).rows,
        tenantId,
      );
    }
    expect(await all()).toEqual(before);
  });

  it('adds only tables that meet the tenancy invariants, no SECURITY DEFINER function, and marks nothing LEAKPROOF', async () => {
    requireStaged();
    expect(definersBefore.length, 'the census before the migration read nothing').toBe(2);
    expect(
      (await pool().query<{ name: string }>(DEFINERS_SQL)).rows.map((row) => row.name),
    ).toEqual(definersBefore);
    expect(
      leakproofBefore.length,
      'the LEAKPROOF census before the migration read nothing',
    ).toBeGreaterThan(0);
    expect(
      (await pool().query<{ name: string }>(LEAKPROOF_SQL)).rows.map((row) => row.name),
    ).toEqual(leakproofBefore);
    const after = (await pool().query<{ name: string }>(PUBLIC_TABLES_SQL)).rows.map(
      (row) => row.name,
    );
    const added = after.filter((name) => !tablesBefore.includes(name) && !name.startsWith('_'));
    // Not vacuous: the six are among the added tables.
    expect(TABLES.filter((table) => !added.includes(table))).toEqual([]);
    const problems: string[] = [];
    for (const table of added) {
      if (!(TENANT_SCOPED_TABLES as readonly string[]).includes(table))
        problems.push(`${table}: not in TENANT_SCOPED_TABLES`);
      const state = (
        await pool().query<{ enabled: boolean; forced: boolean; tenant: boolean }>(
          `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
                  EXISTS (SELECT 1 FROM pg_attribute a
                           WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS tenant
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = $1`,
          [table],
        )
      ).rows[0];
      if (state?.tenant !== true) problems.push(`${table}: no tenant_id`);
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
