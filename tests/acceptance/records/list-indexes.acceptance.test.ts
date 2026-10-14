import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  SEED_CONTACTS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_SUPERVISOR,
  withTenantTransaction,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import pg, { type Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, withAuthDatabase } from '../support/api';

/**
 * ACCEPTANCE — T-0084, list indexes and id-only cursors (Agent 3, M3; D-P33,
 * D-L68, D-L80, D-L65, ADR-0014). Written by QA for the lead before the build
 * (D-L23), from the invariants, not from an implementation (D-L25).
 *
 * WHAT THIS PINS. The contacts, leads and accounts lists stay index-driven for
 * a large tenant, read as kasuwa_app under FORCE RLS, and their cursors carry
 * a row id and nothing a person could be identified or dated by.
 *
 * ==========================================================================
 * PINNED INTERFACES (the builder must honour these exactly)
 * ==========================================================================
 *
 * I1. THE LISTS are the live HTTP endpoints, unchanged in contract:
 *     `GET /api/v1/contacts`, `GET /api/v1/leads`, `GET /api/v1/accounts`,
 *     with `sort`, `limit`, `cursor` and `q`. The sort enums are the
 *     contract's (hard-coded below, not imported, so a narrowed enum cannot
 *     shrink this suite's coverage).
 *
 * I2. INDEX USE is judged on the SQL the endpoint actually sends. The suite
 *     records every statement the API issues on its pg connections during one
 *     request (a wrapper on `pg.Client.prototype.query`; `pg` is one shared
 *     install), keeps those that read FROM `contact` (or `account`), and
 *     replays each one, with its own bound values, as
 *     `EXPLAIN (ANALYZE, FORMAT JSON)` inside `withTenantTransaction` for the
 *     SAME user: kasuwa_app, the same RLS scope. For every such statement:
 *       - no `Seq Scan` on `contact` or `account`, anywhere in the plan;
 *       - no `Sort` node anywhere (an `Incremental Sort`, which sorts only
 *         the ties of an index-ordered prefix, is allowed: it is not a sort
 *         over the set);
 *       - the statement's text has no `OFFSET`;
 *       - the outer (non-subplan) scans of the list table are `Index Scan` or
 *         `Index Only Scan`, and together they EXAMINE (rows returned plus
 *         rows removed by filter, times loops) at most MAX_ROWS_EXAMINED
 *         rows. That is the seek check: a deep page that rescans from the
 *         start, or filters its way to the cursor, examines tens of
 *         thousands.
 *     At least one recorded statement must be the page query (FROM the
 *     table, ORDER BY, LIMIT). Recording nothing is a failure, never a pass.
 *     The builder may split the work across statements (for example, resolve
 *     the cursor's row first); each one is held to the same rules.
 *
 * I3. A DEEP PAGE is reached format-blind: a `q` naming two marker rows that
 *     sit in the middle of every sort order, `limit=1`, gives a cursor at the
 *     first marker. That cursor is then sent WITHOUT `q`. So a cursor must
 *     remain a position that is valid under any filter of the same sort, as
 *     it is today (cursor.ts: "a position, never a scope").
 *
 * I4. CURSORS are base64url, as today. Decoded, a cursor is either the bare
 *     id of the page's last row, or JSON whose every leaf is one of: that id
 *     (any case), a member of the list's sort enum (so a cursor issued under
 *     one sort can still be refused under another, as the accounts and leads
 *     suites require), or an integer 0..99 (a format version). Keys are not
 *     leaves, but no key may contain the row's name or company. Anything
 *     else, a name, a company, a timestamp, an epoch, a sort VALUE, fails.
 *
 * I5. A cursor naming a row the caller cannot reach (another programme,
 *     another tenant) answers exactly like a cursor naming no row at all:
 *     same status, same body. The cursor's row is resolved inside the
 *     caller's scope, or the cursor is a programme-level existence oracle.
 *
 * I6. MIGRATION 0035 (one file, `0035_*.sql`, applied by the runner). It adds
 *     only plain-column B-tree indexes. Comments and its self-check aside it
 *     never says LEAKPROOF: it CHECKS (`proleakproof`, `RAISE EXCEPTION`),
 *     it never marks. Its header gives the `CREATE INDEX CONCURRENTLY`
 *     recipe for a populated cell (D-L65). No `CREATE EXTENSION`, no `gin`,
 *     no `gist`, no `trgm`, no SECURITY DEFINER (CLAUDE.md 2.7).
 *
 * I7. THE CATALOGUE after migration: no GIN or GiST index on `contact` or
 *     `account`; no `pg_trgm`; every function or operator an index
 *     expression or predicate on those tables depends on is LEAKPROOF; every
 *     B-tree operator of every key column's operator family is LEAKPROOF; and
 *     the database's set of LEAKPROOF functions is exactly `template1`'s (a
 *     pristine catalogue on the same server). Nothing was marked.
 *
 * I8. RESULTS do not change: `q` returns exactly the rows the fixture
 *     formula says it must (in the contract's order, paged to the end), a
 *     deep page returns exactly the rows a direct ORDER BY says follow the
 *     cursor's row, and a cluster of 30 rows tying on every sort key pages
 *     out exactly once under every sort.
 *
 * I9. LATENCY. A first page and a deep page, best of three, each within
 *     PAGE_BUDGET_MS. Generous on purpose: this catches a regression to a
 *     scan, it is not a benchmark.
 *
 * ==========================================================================
 * RULINGS this suite makes (the lead's, reversible)
 * ==========================================================================
 *
 *   R1. Index use is asserted on BOTH a one-programme agent (A1) and the
 *       two-programme supervisor (A1+A2). An index led by
 *       (tenant_id, programme_id, ...) cannot give the order for a session
 *       reaching two programmes, and on main that is exactly what produces
 *       the Sort. A BPO supervisor reaching every programme is the common
 *       case, not the edge.
 *   R2. The size is 120,000 contacts and 60,000 accounts in tenant A, half
 *       in each programme, seeded by kasuwa_migrator with `generate_series`
 *       and then ANALYZEd. Enough because: (a) with LIMIT 26 the cost of an
 *       index path is flat in table size while a scan-and-sort grows with
 *       it, so the planner's choice at 120k is the choice at 1M; (b) the seek
 *       check is a COUNT of rows examined, so a deep page at depth 60,000
 *       separates "seeks" (tens of rows) from "scans" (tens of thousands) by
 *       three orders of magnitude, with no timing involved; (c) seeding takes
 *       seconds and the whole file stays well under three minutes on main,
 *       where every page sorts.
 *   R3. `q` is outside the index check (D-P33: its speed waits for the
 *       LEAKPROOF review). Its results are pinned, its plan is not.
 *   R4. Incremental Sort is allowed; Sort is not (I2).
 *   R5. The deep-page cursor stays valid without the filter that produced it
 *       (I3). It is today; a cursor bound to its filter would be a contract
 *       change, which T-0084 does not make.
 *   R6. The cursor may keep the sort KEY's name (I4). The accounts and leads
 *       suites require "a cursor issued for one sort is 400 under another",
 *       and the task says those suites pass unmodified.
 *   R7. Filters other than the leads view's own status set (owner, tag,
 *       state...) are not index-checked: the task names lists and sorts, not
 *       filter combinations.
 *   R8. The displayName sort key cannot stay `left(display_name, 200)`.
 *       `left` is not LEAKPROOF, so under FORCE RLS a keyset predicate on it
 *       is never an index condition: with a (tenant_id, left(display_name,
 *       200), id) index the order comes from the index but a deep page still
 *       FILTERS its way to the cursor (measured: 59,970 rows examined). The
 *       200-character cut existed only to bound a cursor carrying the name
 *       (cursor.ts, MAX_TEXT_SORT_POSITION); an id-only cursor does not need
 *       it. Names equal in their first 200 characters may then order
 *       differently from today; no existing suite holds such names.
 *   R9. pg_depend is not evidence for I7: Postgres records no dependency on
 *       a pinned (builtin) function, so `lower`, `left` and `normalize` never
 *       appear there. The check reads the stored expression trees instead.
 *
 * FEASIBILITY, checked once by hand and then removed (not part of this file):
 * with plain B-tree indexes (tenant_id, created_at, id) and (tenant_id,
 * updated_at, id) on both tables and (tenant_id, name, id) on account, every
 * timestamp sort and both account name sorts passed I2 for both callers, under
 * today's code, at 20-30 ms a page. A planted GIN index and a planted
 * `lower(...)` partial index each failed I7 by name, and the `left(...)`
 * index failed the seek check as R8 says. So I2 and I7 are passable and bite.
 *
 * Writes: the suite reseeds before and after. Fixtures are
 * packages/db/src/fixtures.ts (tenant A, A1, A2, its agent and supervisor),
 * plus generated rows with ids in this suite's own range
 * (`11111111-0084-...`), planted by kasuwa_migrator (BYPASSRLS, never serves).
 * No generated value resembles a person: names are md5 fragments.
 */

// ---------------------------------------------------------------------------
// Sizes and budgets.
// ---------------------------------------------------------------------------

const CONTACT_COUNT = 120_000;
const ACCOUNT_COUNT = 60_000;
const PAGE = 25;
/** I2: rows a page query may examine on the list table. A scan examines ~60,000. */
const MAX_ROWS_EXAMINED = 2_000;
/**
 * I9: best of three, per page, through HTTP in-process. Measured on the dev
 * laptop: index-served pages 20-40 ms; on main, contacts and leads first pages
 * about 250 ms (they fail), deep pages 120-150 ms (borderline), accounts about
 * 80 ms (they pass: sorting 30-60k narrow rows is cheap). The plan checks are
 * the gate; this is the regression alarm.
 */
const PAGE_BUDGET_MS = 150;
const TIE_COUNT = 30;
/** Rows per seeding statement (D-L135): far under the pool's statement timeout. */
const SEED_CHUNK = 10_000;

const REPO_ROOT = resolve(__dirname, '../../..');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'packages/db/migrations');

// The contract's enums, hard-coded (I1).
const CONTACT_SORTS = [
  '-createdAt',
  'createdAt',
  '-updatedAt',
  'updatedAt',
  'displayName',
  '-displayName',
] as const;
const ACCOUNT_SORTS = [
  'name',
  '-name',
  '-createdAt',
  'createdAt',
  '-updatedAt',
  'updatedAt',
] as const;
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified'] as const;

type Table = 'contact' | 'account';

interface ListSpec {
  name: 'contacts' | 'leads' | 'accounts';
  path: string;
  table: Table;
  sorts: readonly string[];
  /** Rows the view admits beyond scope (the leads view is a status filter). */
  leadsOnly: boolean;
  /** Sort key -> column, for the ground-truth queries. */
  columns: Record<string, string>;
}

const CONTACT_COLUMNS = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  displayName: 'display_name',
};
const LISTS: readonly ListSpec[] = [
  {
    name: 'contacts',
    path: '/api/v1/contacts',
    table: 'contact',
    sorts: CONTACT_SORTS,
    leadsOnly: false,
    columns: CONTACT_COLUMNS,
  },
  {
    name: 'leads',
    path: '/api/v1/leads',
    table: 'contact',
    sorts: CONTACT_SORTS,
    leadsOnly: true,
    columns: CONTACT_COLUMNS,
  },
  {
    name: 'accounts',
    path: '/api/v1/accounts',
    table: 'account',
    sorts: ACCOUNT_SORTS,
    leadsOnly: false,
    columns: { createdAt: 'created_at', updatedAt: 'updated_at', name: 'name' },
  },
];

interface Caller {
  label: string;
  userId: string;
  programmeIds: readonly string[];
}
const AGENT: Caller = { label: 'agent (A1)', userId: USER_A_AGENT_1, programmeIds: [PROGRAMME_A1] };
const SUPERVISOR: Caller = {
  label: 'supervisor (A1+A2)',
  userId: USER_A_SUPERVISOR,
  programmeIds: [PROGRAMME_A1, PROGRAMME_A2],
};
const CALLERS = [AGENT, SUPERVISOR] as const;

// ---------------------------------------------------------------------------
// The generated tenant. Every formula here has a JS twin used by the
// expectations, so expected results never come from the code under test.
// ---------------------------------------------------------------------------

const CONTACT_ID = (i: number) => `11111111-0084-4000-8000-${String(i).padStart(12, '0')}`;
const ACCOUNT_ID = (i: number) => `11111111-0084-4000-8001-${String(i).padStart(12, '0')}`;
const CONTACT_TIE_ID = (k: number) => `11111111-0084-4000-8002-${String(k).padStart(12, '0')}`;
const ACCOUNT_TIE_ID = (k: number) => `11111111-0084-4000-8003-${String(k).padStart(12, '0')}`;

/*
 * Two marker rows in the middle of every order (I3): i = COUNT/2 and
 * COUNT/2 + 2, even so in A1, leads ('new', 'qualified'), with created_at and
 * updated_at at the midpoint and the name '8000 zqxmarker a|b'.
 */
const MARKER_Q = 'zqxmarker';
const TIE_Q = 'zqxtie';
const SEARCH_Q = 'Qtok';

const programmeOf = (i: number) => (i % 2 === 0 ? PROGRAMME_A1 : PROGRAMME_A2);
/** status = ['new','contacted','qualified','unqualified','customer',NULL][i % 6]. */
const isLead = (i: number) => i % 6 <= 3;

/*
 * Names are md5 fragments (hex and a space), so no generated name contains
 * `zqx` or `qtok` by accident. `8000 ...` sorts near the middle of hex under
 * any collation that orders digits before letters, which en_US does.
 *
 * Search tokens (I8): display name on i % 1000 in {6, 7} (one upper-case, one
 * accented: folding is part of today's behaviour); given names only on
 * {506, 507}; company only on {306, 307} (searched by leads, not contacts).
 */
const SEED_CONTACTS_SQL = `
INSERT INTO contact (id, tenant_id, programme_id, display_name, given_names, company_name,
                     status, created_at, updated_at)
SELECT ('11111111-0084-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
       $1::uuid,
       CASE WHEN i % 2 = 0 THEN $2::uuid ELSE $3::uuid END,
       CASE WHEN i = $5 THEN '8000 zqxmarker a'
            WHEN i = $5 + 2 THEN '8000 zqxmarker b'
            ELSE substr(md5('n' || i), 1, 10) || ' ' || substr(md5('f' || i), 1, 8)
                 || CASE i % 1000 WHEN 6 THEN ' QTOK' WHEN 7 THEN ' qtók' ELSE '' END
       END,
       CASE WHEN i % 1000 IN (506, 507) THEN 'Qtokgiven' END,
       CASE WHEN i % 1000 IN (306, 307) THEN 'Qtok Holdings' END,
       (ARRAY['new', 'contacted', 'qualified', 'unqualified', 'customer', NULL]::text[])[i % 6 + 1],
       timestamptz '2025-01-01 00:00:00+00' + make_interval(secs => i),
       CASE WHEN i IN ($5, $5 + 2)
            THEN timestamptz '2025-06-01 00:00:00+00' + make_interval(secs => $5 + 0.5 + (i - $5))
            ELSE timestamptz '2025-06-01 00:00:00+00'
                 + make_interval(secs => ((i::bigint * 7919) % $4)::double precision)
       END
  FROM generate_series($6::int, $7::int) AS i`;

const SEED_CONTACT_TIES_SQL = `
INSERT INTO contact (id, tenant_id, programme_id, display_name, status, created_at, updated_at)
SELECT ('11111111-0084-4000-8002-' || lpad(k::text, 12, '0'))::uuid,
       $1::uuid, $2::uuid, '8000 zqxtie', 'new',
       timestamptz '2025-01-01 00:00:00+00' + make_interval(secs => $3 + 0.25),
       timestamptz '2025-06-01 00:00:00+00' + make_interval(secs => $3 + 0.25)
  FROM generate_series(1, $4::int) AS k`;

const SEED_ACCOUNTS_SQL = `
INSERT INTO account (id, tenant_id, programme_id, name, created_at, updated_at)
SELECT ('11111111-0084-4000-8001-' || lpad(i::text, 12, '0'))::uuid,
       $1::uuid,
       CASE WHEN i % 2 = 0 THEN $2::uuid ELSE $3::uuid END,
       CASE WHEN i = $5 THEN '8000 zqxmarker a'
            WHEN i = $5 + 2 THEN '8000 zqxmarker b'
            ELSE substr(md5('a' || i), 1, 12)
                 || CASE i % 1000 WHEN 6 THEN ' Qtok' WHEN 7 THEN ' QTÓK' ELSE '' END
       END,
       timestamptz '2025-01-01 00:00:00+00' + make_interval(secs => i),
       CASE WHEN i IN ($5, $5 + 2)
            THEN timestamptz '2025-06-01 00:00:00+00' + make_interval(secs => $5 + 0.5 + (i - $5))
            ELSE timestamptz '2025-06-01 00:00:00+00'
                 + make_interval(secs => ((i::bigint * 7919) % $4)::double precision)
       END
  FROM generate_series($6::int, $7::int) AS i`;

const SEED_ACCOUNT_TIES_SQL = `
INSERT INTO account (id, tenant_id, programme_id, name, created_at, updated_at)
SELECT ('11111111-0084-4000-8003-' || lpad(k::text, 12, '0'))::uuid,
       $1::uuid, $2::uuid, '8000 zqxtie',
       timestamptz '2025-01-01 00:00:00+00' + make_interval(secs => $3 + 0.25),
       timestamptz '2025-06-01 00:00:00+00' + make_interval(secs => $3 + 0.25)
  FROM generate_series(1, $4::int) AS k`;

// ---------------------------------------------------------------------------
// Statement recording (I2).
// ---------------------------------------------------------------------------

interface Recorded {
  text: string;
  values: readonly unknown[];
}

type QueryFn = (this: unknown, ...args: unknown[]) => unknown;
const clientPrototype = pg.Client.prototype as unknown as { query: QueryFn };
const originalQuery = clientPrototype.query;
let recording: Recorded[] | null = null;

function startRecording(): void {
  clientPrototype.query = function recordingQuery(this: unknown, ...args: unknown[]) {
    const [first, second] = args;
    if (recording !== null) {
      if (typeof first === 'string') {
        recording.push({ text: first, values: Array.isArray(second) ? second : [] });
      } else if (typeof first === 'object' && first !== null && 'text' in first) {
        const config = first as { text: unknown; values?: unknown };
        if (typeof config.text === 'string') {
          const values = Array.isArray(second)
            ? second
            : Array.isArray(config.values)
              ? config.values
              : [];
          recording.push({ text: config.text, values });
        }
      }
    }
    return originalQuery.apply(this, args);
  };
}

function stopRecording(): void {
  clientPrototype.query = originalQuery;
  recording = null;
}

const readsTable = (table: Table) => new RegExp(`\\bFROM\\s+"?${table}"?(?![A-Za-z0-9_"])`, 'i');
const isPageQuery = (table: Table, text: string) =>
  readsTable(table).test(text) && /\bORDER\s+BY\b/i.test(text) && /\bLIMIT\b/i.test(text);

// ---------------------------------------------------------------------------
// Plans.
// ---------------------------------------------------------------------------

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  Alias?: string;
  'Index Name'?: string;
  'Parent Relationship'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
}

interface FlatNode {
  node: PlanNode;
  inSubplan: boolean;
}

function flatten(node: PlanNode, inSubplan = false, out: FlatNode[] = []): FlatNode[] {
  const here =
    inSubplan ||
    node['Parent Relationship'] === 'SubPlan' ||
    node['Parent Relationship'] === 'InitPlan';
  out.push({ node, inSubplan: here });
  for (const child of node.Plans ?? []) flatten(child, here, out);
  return out;
}

function describeNode(node: PlanNode): string {
  const on = node['Relation Name'] === undefined ? '' : ` on ${node['Relation Name']}`;
  const via = node['Index Name'] === undefined ? '' : ` using ${node['Index Name']}`;
  return `${node['Node Type']}${on}${via}`;
}

/** Problems with one recorded statement's plan, by I2. Empty means it passes. */
function planProblems(table: Table, text: string, root: PlanNode, isPage: boolean): string[] {
  const problems: string[] = [];
  const nodes = flatten(root);
  if (/\bOFFSET\b/i.test(text)) problems.push('the SQL pages with OFFSET');
  for (const { node } of nodes) {
    if (
      node['Node Type'] === 'Seq Scan' &&
      (node['Relation Name'] === 'contact' || node['Relation Name'] === 'account')
    ) {
      problems.push(`Seq Scan on ${node['Relation Name']}`);
    }
    if (node['Node Type'] === 'Sort')
      problems.push('a Sort node (the order does not come from an index)');
  }
  if (isPage) {
    const outer = nodes.filter(
      ({ node, inSubplan }) => !inSubplan && node['Relation Name'] === table,
    );
    if (outer.length === 0) problems.push(`no outer scan of ${table} found in the plan`);
    let examined = 0;
    for (const { node } of outer) {
      if (node['Node Type'] !== 'Index Scan' && node['Node Type'] !== 'Index Only Scan') {
        problems.push(`the page reads ${table} by ${describeNode(node)}, not an index scan`);
      }
      examined +=
        ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) *
        (node['Actual Loops'] ?? 1);
    }
    if (examined > MAX_ROWS_EXAMINED) {
      problems.push(
        `the page examined ${examined} ${table} rows (budget ${MAX_ROWS_EXAMINED}): it scans, it does not seek`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Cursors (I4).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function sensitiveValues(row: Row): string[] {
  return ['displayName', 'givenNames', 'familyName', 'companyName', 'name']
    .map((key) => row[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function cursorProblems(cursor: string, last: Row, sorts: readonly string[]): string[] {
  const id = String(last.id).toLowerCase();
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return [`not base64url: ${cursor}`];
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (decoded.toLowerCase() === id) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return [`decodes to neither the row id nor JSON: ${JSON.stringify(decoded.slice(0, 80))}`];
  }
  const problems: string[] = [];
  let sawId = false;
  const names = sensitiveValues(last).map((value) => value.toLowerCase());
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (names.some((name) => key.toLowerCase().includes(name))) {
          problems.push(`key ${path}.${key} carries the row's name`);
        }
        walk(child, `${path}.${key}`);
      }
      return;
    }
    if (typeof value === 'string') {
      if (value.toLowerCase() === id) sawId = true;
      else if (!sorts.includes(value)) problems.push(`${path} carries ${JSON.stringify(value)}`);
      return;
    }
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 99) return;
    problems.push(`${path} carries ${JSON.stringify(value)}`);
  };
  walk(parsed, '$');
  if (!sawId) problems.push(`does not carry the last row's id ${id}`);
  return problems;
}

/** The same cursor, pointing at another id (I5). Needs the id in the clear, which I4 requires. */
function repoint(cursor: string, fromId: string, toId: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const pattern = new RegExp(fromId, 'gi');
  if (!pattern.test(decoded)) throw new Error(`cursor does not carry ${fromId} in the clear`);
  return Buffer.from(decoded.replace(pattern, toId), 'utf8').toString('base64url');
}

// ---------------------------------------------------------------------------

describe('acceptance: list indexes and id-only cursors (T-0084)', () => {
  let app: INestApplication;
  /** kasuwa_app: the replayed EXPLAINs run here, inside withTenantTransaction. */
  let appPool: Pool;
  /** kasuwa_migrator: BYPASSRLS. Seeds, observes, never serves. */
  let migrator: Pool;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 2 });
    const t0 = performance.now();
    // Seeded in chunks of SEED_CHUNK rows: one 120,000-row statement can pass
    // the pool's 30 s statement timeout on a loaded host (D-L135). The rows are
    // identical to a single statement's: the formulas still read the full
    // count ($4) and only the series bounds ($6, $7) change.
    for (let from = 1; from <= CONTACT_COUNT; from += SEED_CHUNK) {
      await migrator.query(SEED_CONTACTS_SQL, [
        TENANT_A,
        PROGRAMME_A1,
        PROGRAMME_A2,
        CONTACT_COUNT,
        CONTACT_COUNT / 2,
        from,
        Math.min(from + SEED_CHUNK - 1, CONTACT_COUNT),
      ]);
    }
    await migrator.query(SEED_CONTACT_TIES_SQL, [
      TENANT_A,
      PROGRAMME_A1,
      CONTACT_COUNT / 2,
      TIE_COUNT,
    ]);
    for (let from = 1; from <= ACCOUNT_COUNT; from += SEED_CHUNK) {
      await migrator.query(SEED_ACCOUNTS_SQL, [
        TENANT_A,
        PROGRAMME_A1,
        PROGRAMME_A2,
        ACCOUNT_COUNT,
        ACCOUNT_COUNT / 2,
        from,
        Math.min(from + SEED_CHUNK - 1, ACCOUNT_COUNT),
      ]);
    }
    await migrator.query(SEED_ACCOUNT_TIES_SQL, [
      TENANT_A,
      PROGRAMME_A1,
      ACCOUNT_COUNT / 2,
      TIE_COUNT,
    ]);
    await migrator.query('ANALYZE contact');
    await migrator.query('ANALYZE account');
    process.stdout.write(`list-indexes: seeded in ${Math.round(performance.now() - t0)} ms\n`);

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot(withAuthDatabase({ databaseUrl: inject('databaseUrl'), poolMax: 5 })),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  }, 300_000);

  afterAll(async () => {
    stopRecording();
    await app?.close();
    await appPool?.end();
    await migrator?.end();
    await reseed(inject('migrationUrl'));
  }, 120_000);

  // --- HTTP ---------------------------------------------------------------

  interface Page {
    status: number;
    body: { data?: Row[]; nextCursor?: string | null } & Record<string, unknown>;
  }

  async function getPage(
    list: ListSpec,
    caller: Caller,
    params: Record<string, string | undefined>,
  ): Promise<Page> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, value);
    }
    const response = await request(app.getHttpServer())
      .get(`${list.path}?${query.toString()}`)
      .set(asUser(TENANT_A, caller.userId));
    return { status: response.status, body: response.body as Page['body'] };
  }

  async function okPage(
    list: ListSpec,
    caller: Caller,
    params: Record<string, string | undefined>,
  ): Promise<{ data: Row[]; nextCursor: string | null }> {
    const page = await getPage(list, caller, params);
    expect(
      page.status,
      `${list.name} ${JSON.stringify(params)}: ${JSON.stringify(page.body)}`,
    ).toBe(200);
    return { data: page.body.data ?? [], nextCursor: page.body.nextCursor ?? null };
  }

  /** I3: a cursor positioned at the first marker of this sort, and that marker's id. */
  async function deepCursor(
    list: ListSpec,
    caller: Caller,
    sort: string,
  ): Promise<{ cursor: string; markerId: string }> {
    const page = await okPage(list, caller, { q: MARKER_Q, sort, limit: '1' });
    const marker = page.data[0];
    expect(marker, `${list.name}: the marker rows are not found by q`).toBeDefined();
    expect(
      page.nextCursor,
      `${list.name}: two markers, limit 1, but no next cursor`,
    ).not.toBeNull();
    return { cursor: String(page.nextCursor), markerId: String(marker?.id) };
  }

  /** I2: the request's statements on the list table, each replayed as EXPLAIN ANALYZE. */
  async function planOf(
    list: ListSpec,
    caller: Caller,
    params: Record<string, string | undefined>,
  ): Promise<string[]> {
    recording = [];
    startRecording();
    let statements: Recorded[];
    try {
      await okPage(list, caller, params);
    } finally {
      statements = recording ?? [];
      stopRecording();
    }
    const relevant = statements.filter((statement) => readsTable(list.table).test(statement.text));
    const problems: string[] = [];
    if (!relevant.some((statement) => isPageQuery(list.table, statement.text))) {
      problems.push(
        `no page query (FROM ${list.table} ... ORDER BY ... LIMIT) was recorded among ` +
          `${statements.length} statements: the recorder saw nothing it could judge`,
      );
    }
    for (const statement of relevant) {
      const rows = await withTenantTransaction(
        appPool,
        { tenantId: TENANT_A, userId: caller.userId },
        (tx) =>
          tx.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
            `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`,
            statement.values,
          ),
      );
      const root = rows[0]?.['QUERY PLAN'][0]?.Plan;
      if (root === undefined) {
        problems.push('EXPLAIN returned no plan');
        continue;
      }
      problems.push(
        ...planProblems(list.table, statement.text, root, isPageQuery(list.table, statement.text)),
      );
    }
    return problems;
  }

  /** Ground truth by a direct ORDER BY, as kasuwa_migrator (I8). */
  async function expectedAfter(
    list: ListSpec,
    caller: Caller,
    sort: string,
    afterId: string,
    limit: number,
  ): Promise<string[]> {
    const descending = sort.startsWith('-');
    const key = descending ? sort.slice(1) : sort;
    const column = list.columns[key];
    if (column === undefined) throw new Error(`no column for sort ${sort}`);
    const direction = descending ? 'DESC' : 'ASC';
    const operator = descending ? '<' : '>';
    const leads = list.leadsOnly ? `AND status = ANY($4::text[])` : '';
    const result = await migrator.query<{ id: string }>(
      `SELECT id FROM ${list.table}
        WHERE tenant_id = $1 AND programme_id = ANY($2::uuid[]) ${leads}
          AND (${column}, id) ${operator}
              (SELECT ${column}, id FROM ${list.table} WHERE id = $3)
        ORDER BY ${column} ${direction}, id ${direction}
        LIMIT ${limit}`,
      list.leadsOnly
        ? [TENANT_A, caller.programmeIds, afterId, LEAD_STATUSES]
        : [TENANT_A, caller.programmeIds, afterId],
    );
    return result.rows.map((row) => row.id);
  }

  async function timed(fn: () => Promise<unknown>): Promise<number> {
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = performance.now();
      await fn();
      best = Math.min(best, performance.now() - started);
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // 0. The fixture is what the suite thinks it is (so nothing below is vacuous).
  // -------------------------------------------------------------------------

  it('the large tenant is seeded and visible to kasuwa_app in scope only', async () => {
    const counts = await migrator.query<{ contacts: string; accounts: string }>(
      `SELECT (SELECT count(*) FROM contact WHERE tenant_id = $1) AS contacts,
              (SELECT count(*) FROM account WHERE tenant_id = $1) AS accounts`,
      [TENANT_A],
    );
    expect(Number(counts.rows[0]?.contacts)).toBeGreaterThanOrEqual(CONTACT_COUNT + TIE_COUNT);
    expect(Number(counts.rows[0]?.accounts)).toBeGreaterThanOrEqual(ACCOUNT_COUNT + TIE_COUNT);
    const seen = await withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      (tx) => tx.query<{ n: string }>('SELECT count(*) AS n FROM contact'),
    );
    // A1 holds the even half, the 30 ties and the three seeded A1 contacts.
    expect(Number(seen[0]?.n)).toBe(CONTACT_COUNT / 2 + TIE_COUNT + 3);
  });

  // -------------------------------------------------------------------------
  // 1. Index use and keyset seeks (I2, I3).
  // -------------------------------------------------------------------------

  describe.each(LISTS)('$name: every sort is served by an index, first page and deep', (list) => {
    it.each(list.sorts.map((sort) => [sort]))(
      'sort=%s: no Seq Scan, no Sort, no OFFSET, and a deep page seeks',
      async (sort) => {
        const problems: string[] = [];
        for (const caller of CALLERS) {
          const first = await planOf(list, caller, { sort, limit: String(PAGE) });
          problems.push(...first.map((problem) => `${caller.label}, first page: ${problem}`));
          const { cursor } = await deepCursor(list, caller, sort);
          const deep = await planOf(list, caller, { sort, limit: String(PAGE), cursor });
          problems.push(...deep.map((problem) => `${caller.label}, deep page: ${problem}`));
        }
        expect([...new Set(problems)].join('\n'), `${list.name} sort=${sort}`).toBe('');
      },
      120_000,
    );
  });

  // -------------------------------------------------------------------------
  // 2. Cursors are id-only (I4, D-L80).
  // -------------------------------------------------------------------------

  it('the cursor checker accepts id-only shapes and refuses valued ones (checks the checker)', () => {
    // Passes on main: it tests this file's checker, so that the cursor tests
    // below can be passed by an id-only cursor and cannot be passed by
    // today's. No database involved.
    const row: Row = { id: CONTACT_ID(42), displayName: 'abc123 def456', companyName: 'Qtok Ltd' };
    const encode = (value: unknown) =>
      Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString(
        'base64url',
      );
    for (const good of [
      CONTACT_ID(42),
      { id: CONTACT_ID(42) },
      { i: CONTACT_ID(42).toUpperCase(), s: 'displayName', v: 1 },
      [CONTACT_ID(42), '-createdAt'],
    ]) {
      expect(cursorProblems(encode(good), row, CONTACT_SORTS), JSON.stringify(good)).toEqual([]);
    }
    for (const bad of [
      { c: '2025-01-01T00:00:00.000000Z', i: CONTACT_ID(42) },
      { s: 'displayName', v: 'abc123 def456', i: CONTACT_ID(42) },
      { id: CONTACT_ID(42), t: 1735689600000 },
      { id: CONTACT_ID(41) },
      { id: CONTACT_ID(42), [row.companyName as string]: 1 },
      'not json at all',
    ]) {
      expect(cursorProblems(encode(bad), row, CONTACT_SORTS), JSON.stringify(bad)).not.toEqual([]);
    }
    expect(cursorProblems('has spaces+/=', row, CONTACT_SORTS)).not.toEqual([]);
  });

  describe.each(LISTS)('$name: cursors', (list) => {
    it('every sort issues a cursor that carries the last row id and nothing a person is known by', async () => {
      const problems: string[] = [];
      for (const sort of list.sorts) {
        const pages = [await okPage(list, AGENT, { sort, limit: String(PAGE) })];
        const { cursor } = await deepCursor(list, AGENT, sort);
        pages.push(await okPage(list, AGENT, { sort, limit: String(PAGE), cursor }));
        for (const [index, page] of pages.entries()) {
          const last = page.data.at(-1);
          // Not vacuous: a full page of 25 with a next cursor, every time.
          expect(page.data).toHaveLength(PAGE);
          expect(page.nextCursor, `sort=${sort}: no cursor`).not.toBeNull();
          if (last === undefined || page.nextCursor === null) continue;
          for (const problem of cursorProblems(page.nextCursor, last, list.sorts)) {
            problems.push(`sort=${sort} ${index === 0 ? 'first' : 'deep'} page: ${problem}`);
          }
        }
      }
      expect(problems.join('\n')).toBe('');
    }, 120_000);

    it('a cursor naming an unreachable row answers exactly as one naming no row (I5)', async () => {
      // Passes on main, where the cursor still carries its sort value and the
      // id only breaks ties. It guards the new resolver: once the position is
      // looked up BY ID, the lookup must run inside the caller's scope. The
      // replacement ids all sort after the original (A2 ids above A1's here,
      // tenant B's '22222222-' and 'ffffffff-' above both), so on main all
      // three leave the original row on the same side of the position.
      const page = await okPage(list, AGENT, { limit: String(PAGE) });
      const last = page.data.at(-1);
      expect(last).toBeDefined();
      expect(page.nextCursor).not.toBeNull();
      const lastId = String(last?.id);
      const lastIndex = Number(lastId.slice(-12));
      const otherProgramme =
        list.table === 'contact'
          ? CONTACT_ID(lastIndex % 2 === 0 ? CONTACT_COUNT - 1 : CONTACT_COUNT)
          : ACCOUNT_ID(lastIndex % 2 === 0 ? ACCOUNT_COUNT - 1 : ACCOUNT_COUNT);
      const otherTenant =
        list.table === 'contact'
          ? String(SEED_CONTACTS.find((row) => row.tenantId === TENANT_B)?.id)
          : '22222222-0000-4000-8000-000000130003';
      const invented = 'ffffffff-0084-4000-8000-00000000dead';
      const answers: string[] = [];
      for (const target of [otherProgramme, otherTenant, invented]) {
        const cursor = repoint(String(page.nextCursor), lastId, target);
        const answer = await getPage(list, AGENT, { limit: String(PAGE), cursor });
        answers.push(JSON.stringify({ status: answer.status, body: answer.body }));
      }
      expect(answers[0], 'another programme vs invented').toBe(answers[2]);
      expect(answers[1], 'another tenant vs invented').toBe(answers[2]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // 3. Results do not change (I8).
  // -------------------------------------------------------------------------

  describe.each(LISTS)('$name: results on the large tenant', (list) => {
    it('q returns exactly the rows the fixture formula names, in order, paged to the end', async () => {
      for (const caller of CALLERS) {
        const expected: string[] = [];
        const total = list.table === 'contact' ? CONTACT_COUNT : ACCOUNT_COUNT;
        for (let i = total; i >= 1; i -= 1) {
          if (!caller.programmeIds.includes(programmeOf(i))) continue;
          const residue = i % 1000;
          if (list.name === 'accounts') {
            if (residue === 6 || residue === 7) expected.push(ACCOUNT_ID(i));
          } else if (list.name === 'contacts') {
            if ([6, 7, 506, 507].includes(residue)) expected.push(CONTACT_ID(i));
          } else if ([6, 7, 506, 507, 306, 307].includes(residue) && isLead(i)) {
            expected.push(CONTACT_ID(i));
          }
        }
        // Not vacuous: 60 (accounts, agent) to 480 (contacts, supervisor) matches.
        expect(expected.length).toBeGreaterThanOrEqual(60);

        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 50; guard += 1) {
          const page = await okPage(list, caller, {
            q: SEARCH_Q,
            sort: '-createdAt',
            limit: '100',
            cursor,
          });
          seen.push(...page.data.map((row) => String(row.id)));
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
        }
        expect(seen, `${list.name}, ${caller.label}`).toEqual(expected);
      }
    }, 120_000);

    it('a deep page returns exactly the rows that follow the cursor row, for three pages', async () => {
      const sorts =
        list.table === 'contact' ? ['-createdAt', 'displayName'] : ['name', '-updatedAt'];
      for (const sort of sorts) {
        const { cursor: start, markerId } = await deepCursor(list, SUPERVISOR, sort);
        const expected = await expectedAfter(list, SUPERVISOR, sort, markerId, 300);
        expect(expected).toHaveLength(300);
        const seen: string[] = [];
        let cursor: string | null = start;
        for (let pageNo = 0; pageNo < 3 && cursor !== null; pageNo += 1) {
          const page = await okPage(list, SUPERVISOR, { sort, limit: '100', cursor });
          seen.push(...page.data.map((row) => String(row.id)));
          cursor = page.nextCursor;
        }
        expect(seen, `${list.name} sort=${sort}`).toEqual(expected);
      }
    }, 120_000);

    it('thirty rows tying on every sort key page out exactly once, in id order, under every sort', async () => {
      // Passes on main (today's cursor carries the value and the id). It
      // guards the id-only resolver: comparing on the sort value alone, or
      // resolving to the wrong row of a tie, skips or repeats rows here.
      const tieIds = Array.from({ length: TIE_COUNT }, (_, k) =>
        list.table === 'contact' ? CONTACT_TIE_ID(k + 1) : ACCOUNT_TIE_ID(k + 1),
      );
      for (const sort of list.sorts) {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 20; guard += 1) {
          const page = await okPage(list, AGENT, { q: TIE_Q, sort, limit: '7', cursor });
          seen.push(...page.data.map((row) => String(row.id)));
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
        }
        const ascending = [...tieIds].sort();
        expect(seen, `sort=${sort}`).toEqual(
          sort.startsWith('-') ? ascending.reverse() : ascending,
        );
      }
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  // 4. Latency (I9).
  // -------------------------------------------------------------------------

  describe.each(LISTS)('$name: latency', (list) => {
    it(`a first page and a deep page each answer within ${PAGE_BUDGET_MS} ms (best of three)`, async () => {
      const sort = list.sorts[0] ?? '';
      const { cursor } = await deepCursor(list, SUPERVISOR, sort);
      // Warm the route once, so the budget never measures module or plan cache start-up.
      await okPage(list, SUPERVISOR, { sort, limit: String(PAGE) });
      const first = await timed(() => okPage(list, SUPERVISOR, { sort, limit: String(PAGE) }));
      const deep = await timed(() =>
        okPage(list, SUPERVISOR, { sort, limit: String(PAGE), cursor }),
      );
      process.stdout.write(
        `list-indexes latency ${list.name}: first ${first.toFixed(1)} ms, deep ${deep.toFixed(1)} ms\n`,
      );
      expect(first, 'first page ms').toBeLessThanOrEqual(PAGE_BUDGET_MS);
      expect(deep, 'deep page ms').toBeLessThanOrEqual(PAGE_BUDGET_MS);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // 5. Migration 0035 and the catalogue (I6, I7).
  // -------------------------------------------------------------------------

  describe('migration 0035', () => {
    const files = () => readdirSync(MIGRATIONS_DIR).filter((name) => /^0035_.*\.sql$/.test(name));
    const stripComments = (sql: string) =>
      sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

    it('exists as exactly one 0035_*.sql and has been applied by the runner', async () => {
      const found = files();
      expect(found, 'packages/db/migrations has no single 0035_*.sql').toHaveLength(1);
      const applied = await migrator.query<{ id: string }>(
        `SELECT id FROM _kasuwa_migration WHERE id LIKE '0035\\_%' ORDER BY id`,
      );
      expect(applied.rows.map((row) => `${row.id}.sql`)).toEqual(found);
    });

    it('checks LEAKPROOF and never marks it; plain B-tree only; gives the CONCURRENTLY recipe', () => {
      const found = files();
      expect(found, 'packages/db/migrations has no single 0035_*.sql').toHaveLength(1);
      const raw = readFileSync(resolve(MIGRATIONS_DIR, String(found[0])), 'utf8');
      const code = stripComments(raw);
      const comments = raw.match(/--[^\n]*|\/\*[\s\S]*?\*\//g)?.join('\n') ?? '';

      // The self-check exists and can fail the migration.
      expect(code, 'no self-check reading pg_proc.proleakproof').toMatch(/\bproleakproof\b/i);
      expect(code, 'the self-check cannot fail: no RAISE EXCEPTION').toMatch(
        /\bRAISE\s+EXCEPTION\b/i,
      );
      // It never marks: LEAKPROOF appears only as the column it reads.
      expect(code.replace(/\bproleakproof\b/gi, ''), 'marks something LEAKPROOF').not.toMatch(
        /\bLEAKPROOF\b/i,
      );
      expect(code, 'creates or alters a function').not.toMatch(
        /\b(CREATE\s+(OR\s+REPLACE\s+)?FUNCTION|ALTER\s+FUNCTION)\b[\s\S]*?\bLEAKPROOF\b/i,
      );
      expect(code).not.toMatch(/\bSECURITY\s+DEFINER\b/i);
      expect(code).not.toMatch(/\bCREATE\s+EXTENSION\b/i);
      expect(code).not.toMatch(/\bUSING\s+(gin|gist|brin|hash|spgist)\b/i);
      expect(code).not.toMatch(/trgm/i);
      expect(code, 'creates no index at all').toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i);
      // D-L65: the header tells the operator how to build these on a populated cell.
      expect(comments, 'no CREATE INDEX CONCURRENTLY recipe in the header').toMatch(
        /CREATE\s+INDEX\s+CONCURRENTLY/i,
      );
    });

    it('no trigram or GIN/GiST index exists on contact or account, and pg_trgm is not installed', async () => {
      // A guard; passes on main. D-P33: kasuwa_app could not use them under FORCE RLS.
      const indexes = await migrator.query<{ index: string; am: string }>(
        `SELECT i.indexrelid::regclass::text AS index, am.amname AS am
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_am am ON am.oid = c.relam
          WHERE i.indrelid IN ('contact'::regclass, 'account'::regclass)
            AND am.amname <> 'btree'`,
      );
      expect(indexes.rows).toEqual([]);
      const trgm = await migrator.query(
        `SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'
         UNION ALL
         SELECT 1 FROM pg_opclass WHERE opcname LIKE '%trgm%'`,
      );
      expect(trgm.rows).toEqual([]);
    });

    it('every function and operator the contact and account indexes use or serve is LEAKPROOF', async () => {
      // Partly a guard: on main every index is on plain uuid, timestamptz and
      // text columns, whose B-tree operators are LEAKPROOF. It catches a
      // `lower(...)` or `left(...)` expression index, or an opclass whose
      // operators kasuwa_app could not use under FORCE RLS.
      const indexCount = await migrator.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_index WHERE indrelid IN ('contact'::regclass, 'account'::regclass)`,
      );
      // Not vacuous: the tables carry their primary keys and keyset indexes.
      expect(Number(indexCount.rows[0]?.n)).toBeGreaterThan(4);

      const leaky = await migrator.query<{ index: string; what: string }>(
        `WITH idx AS (
           SELECT i.indexrelid, i.indrelid, i.indclass, i.indkey
             FROM pg_index i
            WHERE i.indrelid IN ('contact'::regclass, 'account'::regclass)
         ),
         -- Functions and operators an index expression or predicate calls. Read
         -- from the stored node trees, NOT pg_depend: Postgres records no
         -- dependency on a pinned (builtin) function, so pg_depend would never
         -- show the very functions (lower, left, normalize) this is about.
         trees AS (
           SELECT i.indexrelid,
                  coalesce(i.indexprs::text, '') || ' ' || coalesce(i.indpred::text, '') AS tree
             FROM pg_index i
            WHERE i.indexrelid IN (SELECT indexrelid FROM idx)
         ),
         expr_funcs AS (
           SELECT t.indexrelid, m[1]::oid AS func, 'expression function ' || m[1] AS what
             FROM trees t CROSS JOIN LATERAL regexp_matches(t.tree, ':funcid (\\d+)', 'g') AS m
           UNION ALL
           SELECT t.indexrelid, o.oprcode, 'expression operator ' || o.oprname
             FROM trees t CROSS JOIN LATERAL regexp_matches(t.tree, ':opno (\\d+)', 'g') AS m
             JOIN pg_operator o ON o.oid = m[1]::oid
         ),
         -- The operators each key column's operator family serves for its type.
         served AS (
           SELECT idx.indexrelid, o.oprcode AS func,
                  'served operator ' || o.oprname || ' (' || format_type(oc.opcintype, NULL) || ')' AS what
             FROM idx
             CROSS JOIN LATERAL unnest(idx.indclass::oid[]) AS k(opclass)
             JOIN pg_opclass oc ON oc.oid = k.opclass
             JOIN pg_amop ao ON ao.amopfamily = oc.opcfamily
                            AND ao.amoplefttype = oc.opcintype
                            AND ao.amoprighttype = oc.opcintype
             JOIN pg_operator o ON o.oid = ao.amopopr
         )
         SELECT x.indexrelid::regclass::text AS index, x.what || ' -> ' || p.proname AS what
           FROM (SELECT * FROM expr_funcs UNION ALL SELECT * FROM served) x
           JOIN pg_proc p ON p.oid = x.func
          WHERE NOT p.proleakproof
          ORDER BY 1, 2`,
      );
      expect(leaky.rows).toEqual([]);
    });

    it('nothing was marked LEAKPROOF: the set is exactly template1’s', async () => {
      // A guard; passes on main. Marking a builtin LEAKPROOF is a superuser
      // act that needs its own review and ADR (D-P33); it is not T-0084's.
      const census = `SELECT n.nspname || '.' || p.proname || '(' ||
                             pg_get_function_identity_arguments(p.oid) || ')' AS fn
                        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE p.proleakproof ORDER BY 1`;
      const here = await migrator.query<{ fn: string }>(census);
      const url = new URL(inject('migrationUrl'));
      url.pathname = '/template1';
      const pristine = createPool({ connectionString: url.toString(), max: 1 });
      try {
        const baseline = await pristine.query<{ fn: string }>(census);
        // Not vacuous: Postgres 16 ships hundreds of LEAKPROOF builtins.
        expect(baseline.rows.length).toBeGreaterThan(100);
        expect(here.rows.map((row) => row.fn)).toEqual(baseline.rows.map((row) => row.fn));
      } finally {
        await pristine.end();
      }
    });
  });
});
