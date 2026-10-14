import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { inspect } from 'node:util';
import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_PERMISSION_SETS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_SUPERVISOR,
  withTenantTransaction,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import pg, { type Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { parse } from 'yaml';
import { asUser, withAuthDatabase } from '../support/api';
import { collectTelemetry, type Telemetry } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0086, the global search API and its prefix indexes (P27;
 * Agent 3). Written by QA for the lead before the build (D-L23, D-L25), from
 * the contract and the decisions, not from an implementation.
 *
 * Sources: team/tasks/T-0086-search-api.md (with "From the T-0085 review");
 * docs/api/records.openapi.yaml (searchRecords, lookupRecords, their schemas
 * and the suite records-contract-search with its rulings R1–R22, D-L133);
 * ADR-0014; ADR-0015 and its fallback (prefix ranges on a `COLLATE "C"` B-tree
 * under FORCE RLS, nothing marked LEAKPROOF); D-L128 (search ships on plain
 * prefix indexes; stored folded columns approved); D-P33; D-L65; D-L68;
 * D-L115; D-L127. Prior art, copied and never imported (importing a test file
 * registers its tests): list-indexes (the large seed, statement recording and
 * replay as kasuwa_app under FORCE RLS, the latency budget); deals-api,
 * leads-api, accounts-api (the harness, field-security grants, readers).
 *
 * The contract suite's rulings (CR1–CR22 below, "R" there) stand unchanged;
 * this file proves the served routes keep them and makes its own rulings
 * (R1–R24) where the contract leaves the serving to the builder. If the
 * contract and this file disagree on something the contract states, the
 * contract wins and this file is the defect: say so in the report, never edit
 * it.
 *
 * Fixtures: packages/db/src/fixtures.ts (tenants, programmes, permission sets,
 * the two seeded users the plan checks run as) plus rows planted here by
 * `kasuwa_migrator` (BYPASSRLS, never serves) with ids in this suite's own
 * range `11111111-0000-4000-8000-0086xxxxxxxx`. Every planted name is
 * synthetic (Sample, Fixture, Example, Test, or a `Zq…` marker). Every phone
 * number here is a PLACEHOLDER: Nigeria has no fictional number range (CR22).
 *
 * ==========================================================================
 * PINNED INTERFACES (the builder honours these exactly)
 * ==========================================================================
 *
 * ROUTES (records.openapi.yaml, unchanged).
 *   searchRecords  GET  /api/v1/search?q=…[&types=…]        -> 200 SearchResults
 *   lookupRecords  POST /api/v1/search/lookup  {phone|email} -> 200 SearchResults
 *   Both `x-kasuwa-implemented: true`. Every answer, errors and throttles
 *   included, carries `Cache-Control: no-store`.
 *
 * MIGRATION 0038 (exactly one file `0038_*.sql`, expand only).
 *   FOLDED COLUMNS, one per searched field, named `<source column>_search`:
 *     contact.display_name_search   contact.given_names_search
 *     contact.family_name_search    contact.company_name_search
 *     account.name_search           deal.name_search
 *   Each is `text`, `GENERATED ALWAYS AS (<fold of its own source column>)
 *   STORED` (R1). A lead is a contact (D-P17): the contact columns serve it.
 *   INDEXES, one B-tree per folded column, named
 *   `<table>_<folded column>_idx` (for example
 *   `contact_display_name_search_idx`), whose keys BEGIN
 *   (tenant_id, programme_id, <folded column>) with the folded key under
 *   collation "C". Trailing keys are the builder's; no partial predicate and
 *   no expression key.
 *
 * THE PREDICATE. A prefix is a RANGE on the folded column:
 *   `<folded> >= $p AND <folded> < $p_upper` under collation "C", where $p
 *   is the folded query and $p_upper the least string greater than every
 *   string that starts with $p. It must reach the plan as the Index Cond of a
 *   folded index. Never LIKE, ILIKE, `~~`, SIMILAR TO, a regex operator,
 *   `strpos` or `position` in a statement that reads a folded column.
 *
 * CODES. The contract's: 400 validation_failed with the details of
 *   SearchValidationFailed / LookupValidationFailed, 401 not_authenticated.
 *   Plus the throttle (R18): 429 `too_many_requests` in the shared Error
 *   envelope, as the existing sign-in throttle answers.
 *
 * ==========================================================================
 * THE CONTRACT'S RULINGS THIS FILE EXERCISES ON THE WIRE (records-contract-
 * search R-numbers, written CRn here)
 * ==========================================================================
 *   CR3 whole-value folded prefix, `%` `_` `\` literal, never a phone or an
 *   email; CR4 lengths; CR5 exact phone (E.164, tenant default country) and
 *   email, contacts and leads only; CR7 field security per hit's programme,
 *   a withheld field never compared and never deciding the choice; CR8 the
 *   displayName rule; CR9 readers per type, deals per D-L127, the portal
 *   none; CR10 the lead group follows listLeads; CR11 scope from the session,
 *   nothing out of scope changes an answer; CR12 at most three, no counts;
 *   CR13 deterministic; CR14 closed hits; CR15 400 and 401 only, the error
 *   order; CR16 no-store, query string and body never logged; CR17 `types`;
 *   CR21 the URL never carries a phone number or an email address.
 *
 * ==========================================================================
 * RULINGS (this suite's; the lead's to accept, reversible)
 * ==========================================================================
 *
 * R1  The folded copies are GENERATED STORED columns, never writer-
 *     maintained. The task allowed a writer-maintained copy only "if
 *     `normalize()` cannot be used in a generated column"; on the pinned image
 *     `normalize(text, text)` is IMMUTABLE (asserted below), so the condition
 *     does not hold. A database-maintained value is also the only one every
 *     writer keeps in step: the API, an import, the seed, a migration and a
 *     future NDPA erasure job (D-P27). A NULL source gives a NULL copy.
 * R2  The fold is CR3's exactly, judged by comparing stored values with this
 *     file's twin of the contract suite's fold over a corpus. Three places a
 *     hand-written SQL fold usually differs, each in the corpus: "every
 *     combining mark" is Unicode category M (Arabic harakat included, not only
 *     U+0300–U+036F); "whitespace" is JavaScript's `\s` (tab, newline and a
 *     pasted no-break space, which `btrim()` and a libc `\s` do not remove);
 *     lower-casing covers non-ASCII (`Ø` to `ø`, Cyrillic), which
 *     `lower(x COLLATE "C")` does not.
 * R3  0038 creates no function. The fold is written inline in each generation
 *     expression: Postgres never recomputes a stored generated column when a
 *     function it calls is replaced, so a helper function is a way to
 *     desynchronise every stored copy with one `CREATE OR REPLACE`.
 * R4  0038 is expand only: ALTER TABLE contact, account and deal to ADD
 *     COLUMN, and CREATE INDEX on those three. No CREATE TABLE, DROP, RENAME,
 *     UPDATE, POLICY, ROW LEVEL SECURITY, GRANT, REVOKE, TRIGGER, SECURITY
 *     DEFINER, CREATE EXTENSION, non-B-tree index, `trgm`, or LEAKPROOF
 *     outside a `proleakproof` read. Its header gives the `CREATE INDEX
 *     CONCURRENTLY` recipe for a populated cell (D-L65, as 0035).
 * R5  Index use is judged on the statements the API actually sends (the
 *     list-indexes I2 method, so no plan check tests a query nothing ships:
 *     the T-0111 review finding). Every statement a search request issues on
 *     its pg connections is recorded and those reading contact, account or
 *     deal are replayed with their own bound values as `EXPLAIN (ANALYZE,
 *     FORMAT JSON)` inside withTenantTransaction for the same user. Across
 *     them: no Seq Scan on the three tables; each of the three is read by at
 *     least one statement naming a folded column and through a folded index
 *     whose Index Cond holds both halves of the range; every folded-index
 *     scan holds the range in its Index Cond (never a Filter). Checked for a
 *     one-programme agent and the two-programme supervisor (list-indexes R1).
 * R6  ROWS EXAMINED. On the 2-character query `zq`, which matches about a
 *     fifth of the large tenant, the scans of each table examine at most
 *     MAX_ROWS_EXAMINED rows per request (rows returned plus removed by
 *     filter or recheck, times loops; a Bitmap Index Scan counts its TIDs).
 *     Two characters is the contract's minimum (CR4), so it is the query a
 *     typeahead sends most, and a plan that reads every match (a bitmap over
 *     the prefix, a sort of all matches) grows with the tenant while three
 *     hits do not. Checked by hand before commit: one index scan per field,
 *     each under LIMIT, examines 3 to 7 rows per field for either caller.
 * R7  The large tenant: 120,000 contacts, 60,000 accounts and 60,000 deals in
 *     tenant A, half in each programme, ANALYZEd. Each name field carries the
 *     `Zqcommon` marker on 5% of rows (both programmes) and `Zqrare` on 0.2%.
 * R8  Latency, best of three after a warm-up, in process: searchRecords on
 *     `zq` within SEARCH_BUDGET_MS for both callers; lookupRecords on a phone
 *     within LOOKUP_BUDGET_MS. The lookup's plan is NOT pinned: an exact
 *     `phones @> …` match cannot be an index condition under FORCE RLS until
 *     `jsonb_contains` is marked LEAKPROOF (ADR-0015, D-L128 Q3), so today it
 *     scans the session's scope. The budget catches a regression beyond that.
 * R9  When n >= 1 readable records match, a group holds exactly min(3, n)
 *     hits. "At most three" (CR12) never means fewer than exist: an answer
 *     with fewer hits than matching records is a "no results" that lies.
 * R10 A partial number is never whole: a national significant number of 6
 *     digits or fewer (after the trunk 0 or the country code) is `400
 *     invalid_phone` for every default country, P27/A2's "0803 456" included.
 *     The contacts list's `phoneSearchE164` accepts seven typed digits
 *     (`0803 456` -> `+234803456`), so reusing it fails here.
 * R11 Email equality is case-insensitive on BOTH sides: a stored
 *     `Zq.Upper@Example.Test` is found by `zq.upper@example.test`. A whole
 *     address that is a prefix of a stored one does not find it.
 * R12 The deal group follows listDeals for the same caller: a deal is a hit
 *     exactly when that caller's listDeals on its pipeline lists it. This
 *     settles a tenant admin holding `client_portal` (the flag decides
 *     pipeline reads, D-L127) without a second rule.
 * R13 When `status` is withheld anywhere the caller reaches, the lead group is
 *     empty AND listLeads refuses the same caller with `400 field_withheld`
 *     (the control that the condition is real, leads-api).
 * R14 A request whose shape is wrong in a way the order does not name (a
 *     repeated `q`, a repeated `types`, a body that is not a JSON object) is
 *     `400 validation_failed`; detail codes are the builder's. Nothing a
 *     client sends is ever answered 500.
 * R15 Group order is canonical (contact, lead, account, deal) whatever order
 *     `types` arrives in; a comma-joined `types=contact,lead` is ONE value
 *     and `unknown_type`, as is `Contact`.
 * R16 Unknown query parameters are ignored: `programmeId`, `tenantId`,
 *     `scope`, `limit`, `cursor` change nothing in the answer.
 * R17 When several codes apply, the answer carries the first in the order and
 *     only that code (CR15: "the first that applies is returned").
 * R18 THROTTLE. A per-user limit on each operation, answered as the existing
 *     throttle answers (apps/api/src/auth/sign-in-throttle.guard.ts):
 *     `429`, the shared Error envelope, `code: too_many_requests`,
 *     `error: Too Many Requests`, an optional future `retryAt`, `no-store`.
 *     Per USER, not per address: a second user behind the same address is
 *     unaffected. Separate budgets: exhausting either operation leaves the
 *     other open. Measured as requests admitted in a burst before the
 *     first 429: searchRecords SEARCH_LIMIT_MIN..SEARCH_LIMIT_MAX,
 *     lookupRecords LOOKUP_LIMIT_MIN..LOOKUP_LIMIT_MAX and strictly fewer than
 *     searchRecords. The floors keep a typist and an agent working; the
 *     ceilings make the limit real. The numbers are otherwise the builder's.
 *     IN THE CONTRACT since D-L134 (lead edit on this branch):
 *     `SearchTooManyRequests` on both operations, first in
 *     `x-kasuwa-error-order`. So a throttled caller gets the 429 even for a
 *     request that would otherwise be a 400: the throttle is decided after
 *     authentication and the scope header and before any validation.
 *     Whether a refused (400) request spends budget stays the builder's.
 * R19 The folded copies follow their source on every write path that exists
 *     today: updateContact clearing or renaming a name part, updateAccount and
 *     updateDeal renaming, and any direct write (the stand-in for a future
 *     erasure job). There is no erasure or deletion route for contacts,
 *     accounts or deals yet; a deleted row takes its copies with it.
 * R20 The default country is the tenant's own: tenant A (en-NG) dials NG,
 *     tenant B (en, KES) dials KE, for the same typed digits.
 * R21 searchRecords and lookupRecords write nothing: no audit event, no row
 *     changed, nothing stored about the query.
 * R22 Neither the query string, nor the lookup body, nor the normalised
 *     number, nor a hit's name reaches a log line or a span, in any form
 *     (raw, percent-encoded, folded).
 * R23 Fixtures and callers: every behaviour test plants its own rows and its
 *     own users, with ids never reused in the run, so no test inherits another
 *     test's throttle window or field-security grant. The suite reseeds after
 *     each behaviour test.
 * R24 Both flags `true`. The lead edit flipping records-contract-search's two
 *     flag tests to `true` is on this branch (D-L133).
 *
 * ==========================================================================
 * THE BUILDER'S (not asserted)
 * ==========================================================================
 * Which three hits and their order (CR13, beyond determinism); the exact
 * generation expression (R2 judges its output); trailing index keys; how the
 * fan-out is split into statements; whether a 400 spends throttle budget;
 * the throttle's window shape and numbers inside R18's bounds; `retryAt`.
 *
 * ==========================================================================
 * OTHER SUITES. records-contract-search's two flag tests were edited by the
 * lead on this branch (R24). list-indexes, the records API suites and
 * tests/acceptance/tenancy must still pass.
 *
 * D-L23: on main there is no 0038, no folded column and no route, and both
 * flags are false. Every test except those titled "(self-check)" or
 * "(guard, passes on main)" opens with a request that must answer 200 or a
 * read of a 0038 artefact, and so fails on main for that reason.
 */

// ---------------------------------------------------------------------------
// Sizes, budgets and limits.
// ---------------------------------------------------------------------------

const CONTACT_COUNT = 120_000;
const ACCOUNT_COUNT = 60_000;
const DEAL_COUNT = 60_000;
/** R6: rows the scans of ONE table may examine for one search request. A bitmap over `zq` examines ~12,000. */
const MAX_ROWS_EXAMINED = 500;
/** R8: hand-measured at ~14 ms for the contact fan-out at 120k; generous on purpose. */
const SEARCH_BUDGET_MS = 250;
/** R8: hand-measured at ~86 ms for a scope scan of 120k contacts' phones. */
const LOOKUP_BUDGET_MS = 500;
/** R18 bounds, as requests admitted in a burst before the first 429. */
const SEARCH_LIMIT_MIN = 60;
const SEARCH_LIMIT_MAX = 600;
const LOOKUP_LIMIT_MIN = 10;
const LOOKUP_LIMIT_MAX = 120;

const REPO_ROOT = resolve(__dirname, '../../..');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'packages/db/migrations');
const SPEC_PATH = resolve(REPO_ROOT, 'docs/api/records.openapi.yaml');

const SEARCH = '/api/v1/search';
const LOOKUP = '/api/v1/search/lookup';
const TYPE_ORDER = ['contact', 'lead', 'account', 'deal'] as const;
type SearchType = (typeof TYPE_ORDER)[number];
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified'] as const;
const NAME_FIELDS = ['displayName', 'givenNames', 'familyName', 'companyName'] as const;
const STAFF_SETS = ['admin', 'programme_manager', 'team_lead', 'agent', 'qa_analyst'] as const;

/** The live scope headers the stub guard refuses (D-L63; accounts-api). */
const SCOPE_HEADERS = [
  ['x-kasuwa-programme-ids', `{${PROGRAMME_A2}}`],
  ['x-kasuwa-programme-id', PROGRAMME_A2],
  ['x-kasuwa-scope', 'all'],
] as const;

// ---------------------------------------------------------------------------
// Ids. This suite's range: `0086` marks T-0086. Large-seed rows use a digit
// kind (1 contact, 2 account, 3 deal); planted rows a hex letter kind
// (c contact, a account, d deal, e user, f permission set) and a counter
// that never resets during the run (R23).
// ---------------------------------------------------------------------------

const id86 = (tail: string) => `11111111-0000-4000-8000-0086${tail.padStart(8, '0')}`;
let plantCounter = 0;
const nextId = (kind: 'c' | 'a' | 'd' | 'e' | 'f') =>
  id86(`${kind}${(plantCounter += 1).toString(16).padStart(7, '0')}`);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

type Headers = Record<string, string>;
type Json = Record<string, unknown>;
type Params = readonly (readonly [string, string])[];

function must<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`Fixture drift: ${what}`);
  return value;
}

function permissionSet(tenantId: string, key: string): string {
  return must(
    SEED_PERMISSION_SETS.find((set) => set.tenantId === tenantId && set.key === key),
    `no seeded permission set '${key}' in ${tenantId}`,
  ).id;
}

// ---------------------------------------------------------------------------
// CR3's fold and CR21's identifier rule, as the contract suite states them.
// ---------------------------------------------------------------------------

/** NFD, every combining mark removed, default lower-casing, trimmed, inner whitespace one space. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/** CR21: after NFKC, an `@`, or 6+ digits once whitespace and `+()-.` are removed. */
function looksLikeIdentifier(q: string): boolean {
  const text = q.normalize('NFKC');
  return text.includes('@') || /[0-9]{6,}/.test(text.replace(/[\s+().-]/gu, ''));
}

/** Pasted identifiers CR21 refuses in `q` (the contract suite's list); synthetic or placeholders. */
const IDENTIFIER_QS = [
  '08031234567',
  '+2348031234567',
  '+234 803 123 4567',
  '0803 123 4567',
  '(0803) 123-4567',
  '0803.123.4567',
  '234-803-123-4567',
  '123456',
  'Sample 080312',
  'sample@example.test',
  'a@b',
  '@sample',
  'Sample 080 312 45',
];
/** Full-width forms: refused after NFKC though the ASCII pattern misses them. */
const FULL_WIDTH_QS = ['０８０３１２３４５６７', 'sample＠example.test'];
/** Names CR21 lets through. */
const NAME_QS = [
  'Sample',
  'Sámple Fixture',
  'Sample 2026',
  'Unit 12 Block 3456',
  'Sample 12345',
  '50% Sample',
  'Sample (Lagos) Ltd',
  'Fixture-12.34',
];

/**
 * R2: the fold corpus. Every entry is synthetic. Written with escapes so the
 * source shows exactly which code points are under test.
 */
const FOLD_CORPUS = [
  'Sámple Fixture',
  '  Zq  Sample\tFixture \n',
  'ØLSEN Sample',
  'Ẹ̀xámple Zqyoruba',
  'سَامْبِل Fixture',
  'Sample Fixture',
  'İzmir Example Ltd',
  'ẞ Sample Test',
  'ТЕСТ Sample',
  'Zq%_\\ Sample',
  'Sample \u{1F372} Fixture',
  'Fixture ﬁx',
];

/**
 * Every name-shaped `q` this file sends expecting a 200 (the first self-check
 * proves none is an identifier, too short, too long or control-laden).
 * Listed by hand because a query built at runtime cannot be checked here.
 */
const SUITE_NAME_QS = [
  'zq',
  'zqrare',
  'zqfold',
  'ZQFOLD',
  'zqfóld',
  'Zqfóld',
  'zqfold s',
  'zqfold    sa',
  '  zqfold',
  'zqfold ',
  'zqfold sample',
  'qfold',
  'sample',
  'zqfoldx',
  'zqfold  sx',
  'zqfamily',
  'zqwhole',
  'zqfields',
  'zq%',
  'zq_',
  'zq\\',
  'zq\\l',
  'zqbnd',
  'zqbnf',
  'zqø',
  'zqøl',
  'ZQØL',
  'zqol',
  'example zqy',
  'سامبل',
  'سَا',
  'zq 2026',
  '+234',
  '0803',
  '2348',
  '+2348',
  'zqmail',
  'zqmail.fixture',
  'zqquiet',
  'zqwith',
  'zqord',
  'zqprog',
  'zqco',
  'zqflag',
  'zqdisp',
  'zqnull',
  'zqportal',
  'zqsets',
  'zqfollow',
  'zqlead',
  'zqstatus',
  'zqscope',
  'zqignore',
  'zqtenant',
  'zqmany',
  'zqtwo',
  'zqonce',
  'zqclosed',
  'zqorder',
  'zqecho',
  'Zqtelemetrymarker',
  'zqrate',
  'zqgiven',
  'zqclear',
  'zqoldname',
  'zqnewname',
  'zqerase',
  'zqodd',
];

// ---------------------------------------------------------------------------
// The folded columns and their indexes (pinned).
// ---------------------------------------------------------------------------

const TABLES = ['contact', 'account', 'deal'] as const;
type Table = (typeof TABLES)[number];

interface Folded {
  table: Table;
  source: string;
  column: string;
  index: string;
}

const FOLDED_SOURCES: readonly (readonly [Table, string])[] = [
  ['contact', 'display_name'],
  ['contact', 'given_names'],
  ['contact', 'family_name'],
  ['contact', 'company_name'],
  ['account', 'name'],
  ['deal', 'name'],
];
const FOLDED: readonly Folded[] = FOLDED_SOURCES.map(([table, source]) => ({
  table,
  source,
  column: `${source}_search`,
  index: `${table}_${source}_search_idx`,
}));
const FOLDED_BY_INDEX = new Map(FOLDED.map((folded) => [folded.index, folded]));
const FOLDED_COLUMN_RE = /\b(?:display_name|given_names|family_name|company_name|name)_search\b/i;
/** R5: what a statement reading a folded column must never match with. */
const FORBIDDEN_MATCH_RE =
  /\bI?LIKE\b|\bSIMILAR\s+TO\b|~~|!~|~\*|\s~\s|\bstrpos\s*\(|\bposition\s*\(|\bregexp_/i;

const isTable = (value: unknown): value is Table =>
  typeof value === 'string' && (TABLES as readonly string[]).includes(value);

const readsTable = (table: Table) =>
  new RegExp(
    String.raw`\b(?:FROM|JOIN)\s+(?:ONLY\s+)?(?:"?public"?\.)?"?${table}"?(?![A-Za-z0-9_"])`,
    'i',
  );

/** Both halves of the range on `column`, as Postgres prints an Index Cond. */
function rangeIn(cond: string, column: string): boolean {
  const sep = String.raw`(?:\)|::text|\s|COLLATE\s+"C")*`;
  return (
    new RegExp(String.raw`\b${column}\b${sep}>=`).test(cond) &&
    new RegExp(String.raw`\b${column}\b${sep}<(?![=>])`).test(cond)
  );
}

// ---------------------------------------------------------------------------
// Plans (R5, R6).
// ---------------------------------------------------------------------------

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Parent Relationship'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const child of node.Plans ?? []) flatten(child, out);
  return out;
}

function describeNode(node: PlanNode): string {
  const on = node['Relation Name'] === undefined ? '' : ` on ${node['Relation Name']}`;
  const via = node['Index Name'] === undefined ? '' : ` using ${node['Index Name']}`;
  return `${node['Node Type']}${on}${via}`;
}

const SCAN_TYPES = new Set([
  'Seq Scan',
  'Index Scan',
  'Index Only Scan',
  'Bitmap Heap Scan',
  'Bitmap Index Scan',
  'Tid Scan',
  'Tid Range Scan',
]);

interface Judged {
  text: string;
  plan: PlanNode;
}

/**
 * R5 and R6 over one search request's replayed statements. Empty means it
 * passes. `indexTable` maps every index of the three tables to its table, so a
 * Bitmap Index Scan (which names no relation) is attributed.
 */
function searchPlanProblems(
  statements: readonly Judged[],
  indexTable: ReadonlyMap<string, Table>,
): string[] {
  const problems: string[] = [];
  const examined: Record<Table, number> = { contact: 0, account: 0, deal: 0 };
  const searched = new Set<Table>();
  const served = new Set<Table>();
  for (const { text, plan } of statements) {
    const reads = TABLES.filter((table) => readsTable(table).test(text));
    if (reads.length === 0) continue;
    if (FOLDED_COLUMN_RE.test(text)) {
      reads.forEach((table) => searched.add(table));
      if (FORBIDDEN_MATCH_RE.test(text)) {
        problems.push(
          `a statement reading a folded column matches with LIKE, a regex or strpos: ${text.replace(/\s+/g, ' ').slice(0, 160)}`,
        );
      }
    }
    for (const node of flatten(plan)) {
      const relation = node['Relation Name'];
      const indexName = node['Index Name'];
      const table = isTable(relation)
        ? relation
        : indexName === undefined
          ? undefined
          : indexTable.get(indexName);
      if (table === undefined) continue;
      if (node['Node Type'] === 'Seq Scan') problems.push(`Seq Scan on ${table}`);
      const folded = indexName === undefined ? undefined : FOLDED_BY_INDEX.get(indexName);
      if (folded !== undefined) {
        const cond = node['Index Cond'] ?? '';
        if (rangeIn(cond, folded.column)) served.add(folded.table);
        else
          problems.push(
            `${describeNode(node)}: the range on ${folded.column} is not its Index Cond (${cond === '' ? 'none' : cond})`,
          );
      }
      if (SCAN_TYPES.has(node['Node Type'])) {
        examined[table] +=
          ((node['Actual Rows'] ?? 0) +
            (node['Rows Removed by Filter'] ?? 0) +
            (node['Rows Removed by Index Recheck'] ?? 0)) *
          (node['Actual Loops'] ?? 1);
      }
    }
  }
  for (const table of TABLES) {
    if (!searched.has(table)) {
      problems.push(`no recorded statement reads ${table} through a folded column`);
    } else if (!served.has(table)) {
      problems.push(
        `${table} is never read through a folded index with the range as its Index Cond`,
      );
    }
    if (examined[table] > MAX_ROWS_EXAMINED) {
      problems.push(
        `${table}: ${examined[table]} rows examined (budget ${MAX_ROWS_EXAMINED}): the scan grows with the matches, not with three hits`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Statement recording (list-indexes I2): a wrapper on pg.Client.prototype.query.
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

// ---------------------------------------------------------------------------
// A small JSON-Schema checker over the published YAML (no new dependency),
// copied from the T-0108 suite: $ref, allOf, oneOf, const, type, enum,
// string bounds, formats, pattern, array bounds, uniqueItems, closed objects.
// ---------------------------------------------------------------------------

const docCache = new Map<string, unknown>();

function loadDoc(file: string): unknown {
  let doc = docCache.get(file);
  if (doc === undefined) {
    doc = parse(readFileSync(file, 'utf8')) as unknown;
    docCache.set(file, doc);
  }
  return doc;
}

function atPointer(doc: unknown, fragment: string): unknown {
  let node = doc;
  for (const raw of fragment.replace(/^\//, '').split('/')) {
    if (raw === '') continue;
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = (node as Json | undefined)?.[key];
  }
  if (node === undefined) throw new Error(`schema pointer #${fragment} resolves to nothing`);
  return node;
}

interface LocatedSchema {
  schema: Json;
  file: string;
}

function deref(schema: Json, file: string): LocatedSchema {
  const ref = schema.$ref;
  if (typeof ref !== 'string') return { schema, file };
  const [relative, fragment = ''] = ref.split('#');
  const target =
    relative === undefined || relative === '' ? file : resolve(dirname(file), relative);
  return deref(atPointer(loadDoc(target), fragment) as Json, target);
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

const FORMATS: Record<string, RegExp> = { uuid: UUID, 'date-time': DATE_TIME };

function check(input: Json, file: string, value: unknown, path: string, errors: string[]): void {
  const { schema, file: at } = deref(input, file);
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf as Json[]) check(part, at, value, path, errors);
  }
  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as Json[]).filter((branch) => {
      const branchErrors: string[] = [];
      check(branch, at, value, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (passing.length !== 1) {
      errors.push(`${path}: matches ${passing.length} oneOf branches`);
    }
  }
  if ('const' in schema && schema.const !== value) {
    errors.push(
      `${path}: ${JSON.stringify(value)} is not the const ${JSON.stringify(schema.const)}`,
    );
  }
  const actual = jsonType(value);
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type)
      ? (schema.type as string[])
      : [schema.type as string];
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      errors.push(`${path}: type ${actual}, schema allows ${allowed.join('|')}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) {
      errors.push(`${path}: shorter than ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
      errors.push(`${path}: longer than ${schema.maxLength}`);
    }
    const format = typeof schema.format === 'string' ? FORMATS[schema.format] : undefined;
    if (format !== undefined && !format.test(value)) {
      errors.push(`${path}: not a valid ${String(schema.format)}`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${path}: does not match ${schema.pattern}`);
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path}: below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path}: above maximum ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path}: more than ${schema.maxItems} items`);
    }
    if (schema.uniqueItems === true) {
      const seen = value.map((item) => JSON.stringify(item));
      if (new Set(seen).size !== seen.length) errors.push(`${path}: items repeat`);
    }
    if (schema.items !== undefined && typeof schema.items === 'object') {
      value.forEach((item, index) =>
        check(schema.items as Json, at, item, `${path}[${index}]`, errors),
      );
    }
  }
  if (actual === 'object') {
    const object = value as Json;
    const properties = (schema.properties ?? {}) as Record<string, Json>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in object)) errors.push(`${path}: required property "${key}" is missing`);
    }
    for (const [key, child] of Object.entries(object)) {
      const childSchema = properties[key];
      if (childSchema !== undefined) {
        check(childSchema, at, child, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: property "${key}" is not allowed`);
      }
    }
  }
}

function schemaErrors(schema: Json, value: unknown, where: string): string[] {
  const errors: string[] = [];
  check(schema, SPEC_PATH, value, where, errors);
  return errors;
}

interface SpecOperation {
  path: string;
  method: string;
  op: Json;
}

function requireOperation(operationId: string): SpecOperation {
  const paths = ((loadDoc(SPEC_PATH) as Json).paths ?? {}) as Record<string, Json>;
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (typeof op === 'object' && op !== null && (op as Json).operationId === operationId) {
        return { path, method, op: op as Json };
      }
    }
  }
  throw new Error(`records.openapi.yaml has no operation ${operationId}`);
}

function responseOf(operationId: string, status: string): Json {
  const { op } = requireOperation(operationId);
  const raw = ((op.responses ?? {}) as Json)[status] as Json | undefined;
  if (raw === undefined) throw new Error(`${operationId} documents no ${status} response`);
  return deref(raw, SPEC_PATH).schema;
}

function responseSchemaOf(operationId: string, status: string): Json {
  const response = responseOf(operationId, status);
  const schema = ((response.content as Json | undefined)?.['application/json'] as Json | undefined)
    ?.schema as Json | undefined;
  if (schema === undefined) throw new Error(`${operationId} ${status} has no JSON schema`);
  return schema;
}

/** A 200 example of an operation, by label, from the published YAML. */
function okExample(operationId: string, label: string): Json {
  const response = responseOf(operationId, '200');
  const examples = (
    (response.content as Json | undefined)?.['application/json'] as Json | undefined
  )?.examples as Record<string, Json> | undefined;
  const value = examples?.[label]?.value;
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${operationId} 200 has no example ${label}`);
  }
  return value as Json;
}

// ---------------------------------------------------------------------------
// The answer: SearchResults against the schema and the prose rules.
// ---------------------------------------------------------------------------

interface Group {
  type: string;
  hits: Json[];
}
interface Results {
  groups: Group[];
}

/** CR12: keys that would be a count, a page or a hint of more, at any depth. */
const COUNT_KEY = /count|total|more|estimate|hidden|cursor|page|offset|limit|next|facet/i;

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => keysDeep(item, out));
  else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      keysDeep(child, out);
    }
  }
  return out;
}

/**
 * Everything wrong with one SearchResults body; empty when right. Schema
 * (closed hits, <= 3 per group), one group per requested type in canonical
 * order, a record at most once per group, no count-like key, and on contact
 * and lead hits: every name field present XOR listed (CR7, omitted never
 * nulled) and displayName withheld exactly when a name part is (CR8).
 */
function resultsProblems(
  operationId: 'searchRecords' | 'lookupRecords',
  body: unknown,
  requested: readonly string[],
): string[] {
  const problems = schemaErrors(responseSchemaOf(operationId, '200'), body, operationId);
  const groups = Array.isArray((body as Json | null)?.groups)
    ? ((body as Json).groups as Json[])
    : [];
  const canonical = TYPE_ORDER.filter((type) => requested.includes(type));
  const types = groups.map((group) => String(group.type));
  if (types.join() !== canonical.join()) {
    problems.push(`groups are [${types.join()}], not [${canonical.join()}]`);
  }
  for (const key of keysDeep(body)) {
    if (COUNT_KEY.test(key)) problems.push(`a count-like key "${key}" in the answer`);
  }
  for (const group of groups) {
    const hits = Array.isArray(group.hits) ? (group.hits as Json[]) : [];
    const ids = hits.map((hit) => String(hit.id));
    if (new Set(ids).size !== ids.length) problems.push(`${String(group.type)}: a record repeats`);
    for (const hit of hits) {
      if (hit.type !== group.type)
        problems.push(`${String(group.type)}: a ${String(hit.type)} hit`);
      if (group.type !== 'contact' && group.type !== 'lead') continue;
      const withheld = Array.isArray(hit.withheldFields) ? (hit.withheldFields as string[]) : [];
      for (const field of NAME_FIELDS) {
        if (field in hit === withheld.includes(field)) {
          problems.push(
            `${String(group.type)} ${String(hit.id)}: ${field} is ${field in hit ? 'both sent and listed' : 'neither sent nor listed'}`,
          );
        }
      }
      const partWithheld = withheld.includes('givenNames') || withheld.includes('familyName');
      if (partWithheld !== withheld.includes('displayName')) {
        problems.push(
          `${String(group.type)} ${String(hit.id)}: displayName withheld must follow its name parts (CR8)`,
        );
      }
    }
  }
  return problems;
}

function idsOf(results: Results, type: SearchType): string[] {
  const group = results.groups.find((candidate) => candidate.type === type);
  return (group?.hits ?? []).map((hit) => String(hit.id)).sort();
}

function hitOf(results: Results, type: SearchType, id: string): Json {
  const group = results.groups.find((candidate) => candidate.type === type);
  return must(
    group?.hits.find((hit) => hit.id === id),
    `no ${type} hit ${id} in ${JSON.stringify(results)}`,
  );
}

const sorted = (ids: readonly string[]) => [...ids].sort();

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

function expectNoStore(response: request.Response, where: string): void {
  expect(
    String(response.headers['cache-control'] ?? ''),
    `${where}: Cache-Control must be no-store`,
  ).toMatch(/(^|[\s,])no-store($|[\s,])/);
}

function expectError(
  response: request.Response,
  status: number,
  code: string,
  where: string,
): Json {
  expect(
    response.status,
    `${where}: expected ${status} ${code}, got ${response.status} ${response.text.slice(0, 300)}`,
  ).toBe(status);
  expectNoStore(response, where);
  expect(
    schemaErrors(
      { $ref: './admin.openapi.yaml#/components/schemas/Error' },
      response.body,
      'Error',
    ),
    `${where}: the body does not match the shared Error schema`,
  ).toEqual([]);
  const body = response.body as Json;
  expect(body.statusCode, `${where}: Error.statusCode`).toBe(status);
  expect(body.code, `${where}: Error.code`).toBe(code);
  return body;
}

interface Detail {
  path: string;
  code: string;
}

function detailsOf(body: unknown): Detail[] {
  const details = (body as Json | null)?.details;
  return Array.isArray(details) ? (details as Detail[]) : [];
}

/** R17: a 400 carrying `code` at `path`, and no other code. */
function expectOnlyDetail(
  response: request.Response,
  path: string,
  code: string,
  where: string,
): Json {
  const body = expectError(response, 400, 'validation_failed', where);
  const details = detailsOf(body);
  expect(
    details.map((detail) => `${detail.path}:${detail.code}`),
    `${where}: details`,
  ).toContain(`${path}:${code}`);
  expect(
    [...new Set(details.map((detail) => detail.code))],
    `${where}: only the first applicable code is returned (R17)`,
  ).toEqual([code]);
  return body;
}

// ---------------------------------------------------------------------------
// Log capture: every channel the process can write to (the T-0036 approach,
// copied from the T-0108 suite).
// ---------------------------------------------------------------------------

let captureLines: string[] | null = null;

function render(value: unknown): string {
  return typeof value === 'string'
    ? value
    : inspect(value, { depth: 12, breakLength: Number.POSITIVE_INFINITY });
}

class RecordingLogger extends ConsoleLogger {
  private record(args: unknown[]): void {
    captureLines?.push(args.map(render).join(' '));
  }
  override log(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override error(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override warn(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override debug(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override verbose(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override fatal(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
}

async function captureEverything(
  work: () => Promise<void>,
): Promise<{ telemetry: Telemetry; lines: string[] }> {
  const lines: string[] = [];
  captureLines = lines;
  const toLines = (chunk: unknown) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString();
    for (const line of text.split('\n')) if (line !== '') lines.push(line);
  };
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      toLines(chunk);
      return true;
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      toLines(chunk);
      return true;
    }),
    ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(render).join(' '));
      }),
    ),
  ];
  let telemetry: Telemetry;
  try {
    telemetry = await collectTelemetry(work);
  } finally {
    for (const spy of spies) spy.mockRestore();
    captureLines = null;
  }
  return { telemetry, lines: [...lines, ...telemetry.logs.map((record) => render(record))] };
}

/** Every form a value takes once it has passed through a URL or a fold (R22). */
function formsOf(value: string): string[] {
  return [
    ...new Set([
      value,
      value.toLowerCase(),
      fold(value),
      encodeURIComponent(value),
      new URLSearchParams([['x', value]]).toString().slice(2),
    ]),
  ];
}

// ---------------------------------------------------------------------------
// The large tenant (R7). Every formula has a description; names are md5
// fragments, markers and nothing a person is known by. Phones are
// placeholders: +23480 followed by the row number on eight digits.
// ---------------------------------------------------------------------------

const SEED_CONTACTS_SQL = `
INSERT INTO contact (id, tenant_id, programme_id, display_name, given_names, family_name,
                     company_name, status, phones)
SELECT ('11111111-0000-4000-8000-00861' || lpad(i::text, 7, '0'))::uuid,
       $1::uuid,
       CASE WHEN i % 2 = 0 THEN $2::uuid ELSE $3::uuid END,
       CASE WHEN i % 40 IN (3, 4) THEN 'Zqcommon ' || substr(md5('n' || i), 1, 10)
            WHEN i % 1000 IN (11, 12) THEN 'Zqrare ' || substr(md5('n' || i), 1, 10)
            ELSE substr(md5('n' || i), 1, 10) || ' ' || substr(md5('f' || i), 1, 8) END,
       CASE WHEN i % 40 IN (5, 6) THEN 'Zqcommon' ELSE substr(md5('g' || i), 1, 8) END,
       CASE WHEN i % 40 IN (7, 8) THEN 'Zqcommon' ELSE substr(md5('h' || i), 1, 8) END,
       CASE WHEN i % 40 IN (9, 10) THEN 'Zqcommon Holdings' END,
       (ARRAY['new', 'contacted', 'qualified', 'unqualified', 'customer', NULL]::text[])[i % 6 + 1],
       jsonb_build_array(jsonb_build_object('type', 'mobile', 'e164', '+23480' || lpad(i::text, 8, '0')))
  FROM generate_series(1, $4::int) AS i`;

const SEED_ACCOUNTS_SQL = `
INSERT INTO account (id, tenant_id, programme_id, name)
SELECT ('11111111-0000-4000-8000-00862' || lpad(i::text, 7, '0'))::uuid,
       $1::uuid,
       CASE WHEN i % 2 = 0 THEN $2::uuid ELSE $3::uuid END,
       CASE WHEN i % 40 IN (3, 4) THEN 'Zqcommon ' || substr(md5('a' || i), 1, 12)
            WHEN i % 1000 IN (11, 12) THEN 'Zqrare ' || substr(md5('a' || i), 1, 12)
            ELSE substr(md5('a' || i), 1, 12) END
  FROM generate_series(1, $4::int) AS i`;

const SEED_DEALS_SQL = `
INSERT INTO deal (id, tenant_id, programme_id, pipeline_id, stage_id, name)
SELECT ('11111111-0000-4000-8000-00863' || lpad(i::text, 7, '0'))::uuid,
       $1::uuid,
       CASE WHEN i % 2 = 0 THEN $2::uuid ELSE $3::uuid END,
       CASE WHEN i % 2 = 0 THEN $4::uuid ELSE $6::uuid END,
       CASE WHEN i % 2 = 0 THEN $5::uuid ELSE $7::uuid END,
       CASE WHEN i % 40 IN (3, 4) THEN 'Zqcommon ' || substr(md5('d' || i), 1, 12)
            WHEN i % 1000 IN (11, 12) THEN 'Zqrare ' || substr(md5('d' || i), 1, 12)
            ELSE substr(md5('d' || i), 1, 12) END
  FROM generate_series(1, $8::int) AS i`;

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

const stripComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

// ---------------------------------------------------------------------------

describe('acceptance: global search API and prefix indexes (T-0086)', () => {
  let app: INestApplication;
  /** kasuwa_migrator: BYPASSRLS. Plants rows and observes them; never serves. */
  let observer: Pool;
  /** kasuwa_app: the replayed EXPLAINs run here, inside withTenantTransaction. */
  let appPool: Pool;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot(withAuthDatabase({ databaseUrl: inject('databaseUrl'), poolMax: 5 })),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: new RecordingLogger() });
    await app.init();
    observer = createPool({ connectionString: inject('migrationUrl'), max: 3 });
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  }, 120_000);

  afterAll(async () => {
    stopRecording();
    await app?.close();
    await appPool?.end();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  }, 120_000);

  const server = () => app.getHttpServer();

  // --- HTTP ----------------------------------------------------------------

  const withQuery = (path: string, params: Params) => {
    const query = new URLSearchParams(params.map(([k, v]): [string, string] => [k, v])).toString();
    return query === '' ? path : `${path}?${query}`;
  };
  const searchRaw = (headers: Headers, params: Params) =>
    request(server()).get(withQuery(SEARCH, params)).set(headers);
  const lookupRaw = (headers: Headers, body: unknown) =>
    request(server())
      .post(LOOKUP)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));
  const lookupText = (headers: Headers, raw: string) =>
    request(server()).post(LOOKUP).set(headers).set('Content-Type', 'application/json').send(raw);
  const typesOf = (types: readonly string[] | undefined): Params =>
    (types ?? []).map((type): [string, string] => ['types', type]);

  function expectResults(
    response: request.Response,
    operationId: 'searchRecords' | 'lookupRecords',
    requested: readonly string[],
    where: string,
  ): Results {
    expect(response.status, `${where}: ${response.status} ${response.text.slice(0, 300)}`).toBe(
      200,
    );
    expectNoStore(response, where);
    const totals = Object.keys(response.headers).filter((name) => /total|count/i.test(name));
    expect(totals, `${where}: a response header carries a count`).toEqual([]);
    expect(resultsProblems(operationId, response.body, requested), where).toEqual([]);
    return response.body as Results;
  }

  async function searchOk(
    headers: Headers,
    q: string,
    types?: readonly string[],
  ): Promise<Results> {
    const response = await searchRaw(headers, [['q', q], ...typesOf(types)]);
    return expectResults(
      response,
      'searchRecords',
      types ?? TYPE_ORDER,
      `search q=${JSON.stringify(q)}`,
    );
  }

  async function lookupOk(headers: Headers, body: Json): Promise<Results> {
    const response = await lookupRaw(headers, body);
    const types = Array.isArray(body.types) ? (body.types as string[]) : TYPE_ORDER;
    return expectResults(response, 'lookupRecords', types, `lookup ${JSON.stringify(body)}`);
  }

  // --- planting (kasuwa_migrator) -------------------------------------------

  interface UserPlant {
    id: string;
    headers: Headers;
  }

  /** A user nobody else uses (R23): `[programme, set key or set id]` memberships. */
  async function freshUser(
    memberships: readonly (readonly [string, string])[],
    options: { tenantId?: string; tenantAdmin?: boolean } = {},
  ): Promise<UserPlant> {
    const tenantId = options.tenantId ?? TENANT_A;
    const id = nextId('e');
    await observer.query(
      `INSERT INTO "user" (id, tenant_id, email, display_name, is_tenant_admin)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        tenantId,
        `t0086.${id.slice(-8)}@example.test`,
        `T-0086 Fixture User ${id.slice(-4)}`,
        options.tenantAdmin ?? false,
      ],
    );
    for (const [programmeId, set] of memberships) {
      await observer.query(
        `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
         VALUES ($1, $2, $3, $4)`,
        [id, programmeId, tenantId, UUID.test(set) ? set : permissionSet(tenantId, set)],
      );
    }
    return { id, headers: asUser(tenantId, id) };
  }

  /** A custom (unlocked, unseeded) permission set in tenant A; returns its id. */
  async function customSet(): Promise<string> {
    const id = nextId('f');
    await observer.query(
      `INSERT INTO permission_set (id, tenant_id, key, label, locked, sort_order)
       VALUES ($1, $2, $3, $4, false, 90)`,
      [id, TENANT_A, `t0086_custom_${id.slice(-6)}`, 'T-0086 Fixture custom set'],
    );
    return id;
  }

  /** One field-security decision in tenant A against the STANDARD field_def (leads-api). */
  async function lockField(
    objectApiName: 'contact' | 'account' | 'deal',
    field: string,
    setKeyOrId: string,
    level: 'none' | 'read' | 'edit',
  ): Promise<void> {
    const found = await observer.query<{ id: string }>(
      `SELECT f.id FROM field_def f
         JOIN object_def o ON o.id = f.object_id AND o.tenant_id = f.tenant_id
        WHERE f.tenant_id = $1 AND o.api_name = $2 AND f.api_name = $3
          AND NOT o.is_custom AND NOT f.is_custom`,
      [TENANT_A, objectApiName, field],
    );
    const fieldId = must(
      found.rows[0]?.id,
      `tenant A has no standard field_def ${objectApiName}.${field}`,
    );
    await observer.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [
        TENANT_A,
        fieldId,
        UUID.test(setKeyOrId) ? setKeyOrId : permissionSet(TENANT_A, setKeyOrId),
        level,
      ],
    );
  }

  interface ContactPlant {
    tenantId?: string;
    programme: string;
    displayName: string;
    givenNames?: string | null;
    familyName?: string | null;
    companyName?: string | null;
    status?: string | null;
    phones?: readonly string[];
    emails?: readonly string[];
  }

  async function plantContact(row: ContactPlant): Promise<string> {
    const id = nextId('c');
    await observer.query(
      `INSERT INTO contact (id, tenant_id, programme_id, display_name, given_names, family_name,
                            company_name, status, phones, emails)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
      [
        id,
        row.tenantId ?? TENANT_A,
        row.programme,
        row.displayName,
        row.givenNames ?? null,
        row.familyName ?? null,
        row.companyName ?? null,
        row.status ?? null,
        JSON.stringify((row.phones ?? []).map((e164) => ({ type: 'mobile', e164 }))),
        JSON.stringify(row.emails ?? []),
      ],
    );
    return id;
  }

  async function plantAccount(
    programme: string,
    name: string,
    tenantId = TENANT_A,
  ): Promise<string> {
    const id = nextId('a');
    await observer.query(
      'INSERT INTO account (id, tenant_id, programme_id, name) VALUES ($1, $2, $3, $4)',
      [id, tenantId, programme, name],
    );
    return id;
  }

  /** The first open stage of the programme's first pipeline (the seed generates them). */
  async function pipelineOf(
    programme: string,
    tenantId = TENANT_A,
  ): Promise<{ pipeline: string; stage: string }> {
    const found = await observer.query<{ pipeline: string; stage: string }>(
      `SELECT p.id AS pipeline, s.id AS stage
         FROM pipeline p
         JOIN pipeline_stage s
           ON s.tenant_id = p.tenant_id AND s.programme_id = p.programme_id AND s.pipeline_id = p.id
        WHERE p.tenant_id = $1 AND p.programme_id = $2 AND s.kind = 'open'
        ORDER BY p.created_at, p.id, s.position
        LIMIT 1`,
      [tenantId, programme],
    );
    return must(found.rows[0], `no pipeline with an open stage in ${programme}`);
  }

  async function plantDeal(programme: string, name: string, tenantId = TENANT_A): Promise<string> {
    const id = nextId('d');
    const { pipeline, stage } = await pipelineOf(programme, tenantId);
    await observer.query(
      `INSERT INTO deal (id, tenant_id, programme_id, pipeline_id, stage_id, name)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, tenantId, programme, pipeline, stage, name],
    );
    return id;
  }

  async function auditCount(): Promise<number> {
    const result = await observer.query<{ n: string }>('SELECT count(*) AS n FROM audit_event');
    return Number(result.rows[0]?.n);
  }

  async function foldedOf(table: Table, id: string): Promise<Json> {
    const columns = FOLDED.filter((folded) => folded.table === table)
      .map((folded) => folded.column)
      .join(', ');
    const result = await observer.query<Json>(`SELECT ${columns} FROM ${table} WHERE id = $1`, [
      id,
    ]);
    return must(result.rows[0], `${table} ${id}`);
  }

  // =========================================================================
  // 0. Self-checks: this file's own helpers. They pass at commit time, by
  //    design: a checker only ever seen passing proves nothing, so each is
  //    shown refusing planted defects.
  // =========================================================================

  describe('(self-check) the helpers this suite judges the server with', () => {
    it('(self-check) fold and the identifier rule behave as the contract states them', () => {
      expect(fold('  Sámple   Fixture ')).toBe('sample fixture');
      expect(fold('Sample \tFixture')).toBe('sample fixture');
      expect(fold('سَامْبِل')).toBe('سامبل');
      expect(fold('Ølsen')).toBe('ølsen');
      expect(fold('ø')).not.toBe('o');
      for (const q of [...IDENTIFIER_QS, ...FULL_WIDTH_QS]) {
        expect(looksLikeIdentifier(q), q).toBe(true);
      }
      for (const q of NAME_QS) expect(looksLikeIdentifier(q), q).toBe(false);
      // Every name-shaped query this file sends (and expects a 200 for) is
      // neither an identifier nor shorter than 2 once folded. A suite that
      // accidentally sent `Zq 2026 123456` would be testing CR21, not CR3.
      for (const q of SUITE_NAME_QS) {
        expect(looksLikeIdentifier(q), q).toBe(false);
        expect([...fold(q)].length, q).toBeGreaterThanOrEqual(2);
        expect([...q].length, q).toBeLessThanOrEqual(100);
        expect(/\p{Cc}/u.test(q), q).toBe(false);
      }
    });

    it('(self-check) the plan judge passes a served plan and refuses each planted defect', () => {
      const indexTable = new Map<string, Table>([
        ...FOLDED.map((folded): [string, Table] => [folded.index, folded.table]),
        ['contact_pkey', 'contact'],
        ['contact_keyset_idx', 'contact'],
      ]);
      const cond = (column: string) =>
        `((tenant_id = 'x'::uuid) AND (programme_id = 'y'::uuid) AND (${column} >= 'zq'::text) AND (${column} < 'zr'::text))`;
      const scan = (table: Table, index: string, column: string, rows = 3): PlanNode => ({
        'Node Type': 'Limit',
        Plans: [
          {
            'Node Type': 'Index Scan',
            'Relation Name': table,
            'Index Name': index,
            'Index Cond': cond(column),
            'Actual Rows': rows,
            'Actual Loops': 1,
            'Rows Removed by Filter': 1,
          },
        ],
      });
      const good: Judged[] = [
        {
          text: 'SELECT id FROM contact WHERE display_name_search >= $3 AND display_name_search < $4 LIMIT 3',
          plan: scan('contact', 'contact_display_name_search_idx', 'display_name_search'),
        },
        {
          text: 'SELECT id FROM account a WHERE a.name_search >= $3 AND a.name_search < $4 LIMIT 3',
          plan: scan('account', 'account_name_search_idx', 'name_search'),
        },
        {
          text: 'SELECT id FROM deal WHERE name_search >= $3 AND name_search < $4 LIMIT 3',
          plan: scan('deal', 'deal_name_search_idx', 'name_search'),
        },
      ];
      expect(searchPlanProblems(good, indexTable)).toEqual([]);
      // With COLLATE "C" printed on the comparison, as a default-collation column would show it.
      const collated: Judged = {
        ...must(good[0], 'good[0]'),
        plan: {
          'Node Type': 'Index Scan',
          'Relation Name': 'contact',
          'Index Name': 'contact_display_name_search_idx',
          'Index Cond': `((tenant_id = 'x'::uuid) AND ((display_name_search)::text COLLATE "C" >= 'zq'::text) AND ((display_name_search)::text COLLATE "C" < 'zr'::text))`,
          'Actual Rows': 3,
        },
      };
      expect(searchPlanProblems([collated, ...good.slice(1)], indexTable)).toEqual([]);

      const defects: [string, Judged[]][] = [
        [
          'a Seq Scan',
          [
            {
              text: 'SELECT id FROM contact WHERE display_name_search >= $1',
              plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'contact', 'Actual Rows': 3 },
            },
            ...good.slice(1),
          ],
        ],
        [
          'the range as a Filter on another index',
          [
            {
              text: 'SELECT id FROM contact WHERE display_name_search >= $1 AND display_name_search < $2',
              plan: {
                'Node Type': 'Index Scan',
                'Relation Name': 'contact',
                'Index Name': 'contact_keyset_idx',
                'Index Cond': "(tenant_id = 'x'::uuid)",
                'Actual Rows': 3,
              },
            },
            ...good.slice(1),
          ],
        ],
        [
          'a folded index without the upper bound',
          [
            {
              text: 'SELECT id FROM contact WHERE display_name_search >= $1',
              plan: {
                'Node Type': 'Index Scan',
                'Relation Name': 'contact',
                'Index Name': 'contact_display_name_search_idx',
                'Index Cond': "((tenant_id = 'x'::uuid) AND (display_name_search >= 'zq'::text))",
                'Actual Rows': 3,
              },
            },
            ...good.slice(1),
          ],
        ],
        [
          'a bitmap over every match',
          [
            {
              text: 'SELECT id FROM contact WHERE display_name_search >= $1 AND display_name_search < $2 LIMIT 3',
              plan: {
                'Node Type': 'Limit',
                Plans: [
                  {
                    'Node Type': 'Bitmap Heap Scan',
                    'Relation Name': 'contact',
                    'Actual Rows': 3,
                    Plans: [
                      {
                        'Node Type': 'Bitmap Index Scan',
                        'Index Name': 'contact_display_name_search_idx',
                        'Index Cond': cond('display_name_search'),
                        'Actual Rows': 6000,
                      },
                    ],
                  },
                ],
              },
            },
            ...good.slice(1),
          ],
        ],
        [
          'LIKE beside the range',
          [
            {
              ...must(good[0], 'good[0]'),
              text: "SELECT id FROM contact WHERE display_name_search >= $3 AND display_name_search < $4 AND display_name_search LIKE $5 || '%'",
            },
            ...good.slice(1),
          ],
        ],
        ['no deal statement at all', good.slice(0, 2)],
        [
          'a deal statement that never names a folded column',
          [
            ...good.slice(0, 2),
            {
              text: 'SELECT id FROM deal WHERE id = ANY($1)',
              plan: {
                'Node Type': 'Index Scan',
                'Relation Name': 'deal',
                'Index Name': 'deal_pkey',
                'Index Cond': '(id = ANY ($1))',
                'Actual Rows': 3,
              },
            },
          ],
        ],
        [
          'a name_search look-alike inside display_name_search (account)',
          [
            must(good[0], 'good[0]'),
            {
              text: 'SELECT id FROM account WHERE display_name_search >= $1',
              plan: {
                'Node Type': 'Index Scan',
                'Relation Name': 'account',
                'Index Name': 'account_name_search_idx',
                'Index Cond':
                  "((x_display_name_search >= 'zq'::text) AND (x_display_name_search < 'zr'::text))",
                'Actual Rows': 3,
              },
            },
            must(good[2], 'good[2]'),
          ],
        ],
      ];
      for (const [label, statements] of defects) {
        expect(searchPlanProblems(statements, indexTable), label).not.toEqual([]);
      }
    });

    it('(self-check) the answer checker accepts the contract’s examples and refuses broken copies', () => {
      const prefix = okExample('searchRecords', 'prefix');
      expect(resultsProblems('searchRecords', prefix, TYPE_ORDER)).toEqual([]);
      const withheld = okExample('searchRecords', 'withheldNamePart');
      expect(resultsProblems('searchRecords', withheld, ['contact'])).toEqual([]);
      const portal = okExample('searchRecords', 'portal');
      expect(resultsProblems('searchRecords', portal, ['account', 'deal'])).toEqual([]);
      const phone = okExample('lookupRecords', 'phoneLookup');
      expect(resultsProblems('lookupRecords', phone, TYPE_ORDER)).toEqual([]);

      const copy = () =>
        JSON.parse(JSON.stringify(prefix)) as { groups: { type: string; hits: Json[] }[] } & Json;
      const firstContact = (body: ReturnType<typeof copy>) =>
        must(body.groups[0]?.hits[0], 'contact hit');
      const broken: [string, unknown, readonly string[]][] = [];
      broken.push(['a total', { ...copy(), total: 5 }, TYPE_ORDER]);
      const four = copy();
      const contactGroup = must(four.groups[0], 'contact group');
      contactGroup.hits = [...contactGroup.hits, ...contactGroup.hits.slice(0, 2)].map(
        (hit, index) => ({ ...hit, id: `a1b2c3d4-0001-4a5b-8c6d-00000000010${index}` }),
      );
      broken.push(['four hits', four, TYPE_ORDER]);
      const repeated = copy();
      const group0 = must(repeated.groups[0], 'contact group');
      group0.hits = [must(group0.hits[0], 'hit'), must(group0.hits[0], 'hit')];
      broken.push(['a repeated record', repeated, TYPE_ORDER]);
      const composed = copy();
      firstContact(composed).withheldFields = ['familyName'];
      delete firstContact(composed).familyName;
      broken.push(['displayName sent with a withheld part', composed, TYPE_ORDER]);
      const nulled = copy();
      firstContact(nulled).withheldFields = ['companyName'];
      broken.push(['a field both sent and listed', nulled, TYPE_ORDER]);
      const phoned = copy();
      firstContact(phoned).phones = [{ type: 'mobile', e164: '+2348030000001' }];
      broken.push(['a phone on a hit', phoned, TYPE_ORDER]);
      const swapped = copy();
      swapped.groups = [...swapped.groups].reverse();
      broken.push(['groups out of order', swapped, TYPE_ORDER]);
      const missing = copy();
      missing.groups = missing.groups.filter((group) => group.type !== 'deal');
      broken.push(['a missing group', missing, TYPE_ORDER]);
      broken.push(['an extra group', copy(), ['contact', 'lead', 'account']]);
      for (const [label, body, requested] of broken) {
        expect(resultsProblems('searchRecords', body, requested), label).not.toEqual([]);
      }
    });

    it('(self-check) the log capture sees what the process writes', async () => {
      const canary = `t0086-canary-${Date.now().toString(36)}`;
      const { lines } = await captureEverything(async () => {
        process.stdout.write(`${canary} stdout\n`);
        // eslint-disable-next-line no-console
        console.error(canary, 'console');
        await Promise.resolve();
      });
      expect(lines.filter((line) => line.includes(canary))).toHaveLength(2);
    });
  });

  // =========================================================================
  // 1. Migration 0038 and the catalogue (R1–R4).
  // =========================================================================

  describe('migration 0038 and the catalogue (R1–R4)', () => {
    const files = () => readdirSync(MIGRATIONS_DIR).filter((name) => /^0038_.*\.sql$/.test(name));
    const migrationText = () => {
      const found = files();
      expect(found, 'packages/db/migrations has no single 0038_*.sql').toHaveLength(1);
      return readFileSync(resolve(MIGRATIONS_DIR, String(found[0])), 'utf8');
    };

    it('exists as exactly one 0038_*.sql and has been applied by the runner', async () => {
      const found = files();
      expect(found, 'packages/db/migrations has no single 0038_*.sql').toHaveLength(1);
      const applied = await observer.query<{ id: string }>(
        `SELECT id FROM _kasuwa_migration WHERE id LIKE '0038\\_%' ORDER BY id`,
      );
      expect(applied.rows.map((row) => `${row.id}.sql`)).toEqual(found);
    });

    it('is expand only: it adds columns to and indexes on contact, account and deal, and nothing else (R3, R4)', () => {
      const raw = migrationText();
      const code = stripComments(raw);
      const comments = raw.match(/--[^\n]*|\/\*[\s\S]*?\*\//g)?.join('\n') ?? '';
      const altered = [
        ...code.matchAll(
          /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:"?public"?\.)?"?(\w+)"?/gi,
        ),
      ].map((m) => String(m[1]).toLowerCase());
      expect(altered.length, 'no ALTER TABLE at all').toBeGreaterThan(0);
      expect(
        [...new Set(altered)].filter((table) => !isTable(table)),
        'alters another table',
      ).toEqual([]);
      const indexed = [
        ...code.matchAll(
          /\bCREATE\s+(UNIQUE\s+)?INDEX\b[^;]*?\bON\s+(?:ONLY\s+)?(?:"?public"?\.)?"?(\w+)"?/gi,
        ),
      ];
      expect(indexed.length, 'creates no index').toBeGreaterThanOrEqual(FOLDED.length);
      expect(indexed.filter((m) => m[1] !== undefined).length, 'a UNIQUE index').toBe(0);
      expect(
        indexed.map((m) => String(m[2]).toLowerCase()).filter((table) => !isTable(table)),
        'indexes another table',
      ).toEqual([]);
      expect(code, 'no GENERATED ALWAYS AS ... STORED column (R1)').toMatch(
        /\bGENERATED\s+ALWAYS\s+AS\b[\s\S]*?\bSTORED\b/i,
      );
      const banned: [string, RegExp][] = [
        ['CREATE TABLE', /\bCREATE\s+(UNLOGGED\s+)?TABLE\b/i],
        ['DROP', /\bDROP\b/i],
        ['RENAME', /\bRENAME\b/i],
        ['an UPDATE of data', /\bUPDATE\s+(?:ONLY\s+)?"?\w+"?\s+SET\b/i],
        ['a POLICY', /\bPOLICY\b/i],
        ['ROW LEVEL SECURITY', /\bROW\s+LEVEL\s+SECURITY\b/i],
        ['GRANT', /\bGRANT\b/i],
        ['REVOKE', /\bREVOKE\b/i],
        ['a TRIGGER', /\bTRIGGER\b/i],
        ['SECURITY DEFINER', /\bSECURITY\s+DEFINER\b/i],
        ['a function (R3)', /\bCREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b/i],
        ['CREATE EXTENSION', /\bCREATE\s+EXTENSION\b/i],
        ['a non-B-tree index', /\bUSING\s+(gin|gist|brin|hash|spgist)\b/i],
        ['trgm', /trgm/i],
        ['ALTER FUNCTION', /\bALTER\s+FUNCTION\b/i],
      ];
      for (const [label, pattern] of banned) expect(code, label).not.toMatch(pattern);
      expect(code.replace(/\bproleakproof\b/gi, ''), 'marks something LEAKPROOF').not.toMatch(
        /\bLEAKPROOF\b/i,
      );
      expect(comments, 'no CREATE INDEX CONCURRENTLY recipe in the header (D-L65)').toMatch(
        /CREATE\s+INDEX\s+CONCURRENTLY/i,
      );
    });

    it('six folded columns: text, GENERATED ALWAYS … STORED, each over its own source column only, and no other *_search column anywhere (R1)', async () => {
      const found = await observer.query<{
        table: string;
        column: string;
        type: string;
        generated: string;
        expr: string | null;
      }>(
        `SELECT c.relname AS table, a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
                a.attgenerated AS generated, pg_get_expr(d.adbin, d.adrelid) AS expr
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid AND c.relkind IN ('r', 'p')
           JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attnum > 0 AND NOT a.attisdropped AND a.attname LIKE '%\\_search'
          ORDER BY 1, 2`,
      );
      expect(found.rows.map((row) => `${row.table}.${row.column}`).sort()).toEqual(
        FOLDED.map((folded) => `${folded.table}.${folded.column}`).sort(),
      );
      const columnsOf = new Map<string, string[]>();
      for (const table of TABLES) {
        const cols = await observer.query<{ name: string }>(
          `SELECT attname AS name FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`,
          [table],
        );
        columnsOf.set(
          table,
          cols.rows.map((row) => row.name),
        );
      }
      for (const folded of FOLDED) {
        const row = must(
          found.rows.find(
            (candidate) => candidate.table === folded.table && candidate.column === folded.column,
          ),
          folded.column,
        );
        const where = `${folded.table}.${folded.column}`;
        expect(row.type, `${where} type`).toBe('text');
        expect(row.generated, `${where} is not GENERATED ALWAYS … STORED (R1)`).toBe('s');
        const expr = row.expr ?? '';
        const mentions = (columnsOf.get(folded.table) ?? []).filter((name) =>
          new RegExp(String.raw`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(expr),
        );
        expect(
          mentions,
          `${where} must fold exactly its own source column; expression: ${expr}`,
        ).toEqual([folded.source]);
      }
    });

    it('the stored value is CR3’s fold, for every folded column, over the corpus (R2)', async () => {
      const programme = PROGRAMME_A1;
      const problems: string[] = [];
      try {
        for (const [index, value] of FOLD_CORPUS.entries()) {
          const contact = await plantContact({
            programme,
            displayName: value,
            givenNames: value,
            familyName: value,
            companyName: value,
          });
          const account = await plantAccount(programme, value);
          const deal = await plantDeal(programme, value);
          const expected = fold(value);
          for (const [table, id] of [
            ['contact', contact],
            ['account', account],
            ['deal', deal],
          ] as const) {
            const row = await foldedOf(table, id);
            for (const [column, stored] of Object.entries(row)) {
              if (stored !== expected) {
                problems.push(
                  `corpus[${index}] ${JSON.stringify(value)} ${table}.${column}: ${JSON.stringify(stored)}, CR3 gives ${JSON.stringify(expected)}`,
                );
              }
            }
          }
        }
      } finally {
        await reseed(inject('migrationUrl'));
      }
      expect(problems.join('\n')).toBe('');
    });

    it('a NULL source gives a NULL copy, and the copies cannot be written by anyone (R1)', async () => {
      const id = await plantContact({ programme: PROGRAMME_A1, displayName: 'Zqnull Sample' });
      try {
        expect(await foldedOf('contact', id)).toEqual({
          display_name_search: 'zqnull sample',
          given_names_search: null,
          family_name_search: null,
          company_name_search: null,
        });
        // Not writer-maintained: Postgres refuses a value for a generated column,
        // even from the table owner (SQLSTATE 428C9).
        for (const folded of FOLDED.filter((candidate) => candidate.table === 'contact')) {
          await expect(
            observer.query(`UPDATE contact SET ${folded.column} = 'zqforged' WHERE id = $1`, [id]),
            folded.column,
          ).rejects.toMatchObject({ code: '428C9' });
        }
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });

    it('one B-tree per folded column, named <table>_<column>_idx, led by (tenant_id, programme_id, <column>) under collation "C" (R3)', async () => {
      const found = await observer.query<{
        index: string;
        table: string;
        am: string;
        valid: boolean;
        nopred: boolean;
        noexpr: boolean;
        keys: string[];
        collations: string[];
      }>(
        `SELECT c.relname AS index, t.relname AS table, am.amname AS am, i.indisvalid AS valid,
                i.indpred IS NULL AS nopred, i.indexprs IS NULL AS noexpr,
                ARRAY(SELECT coalesce(a.attname::text, '?')
                        FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, n)
                        LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                       ORDER BY k.n) AS keys,
                ARRAY(SELECT coalesce(co.collname::text, '')
                        FROM unnest(i.indcollation::oid[]) WITH ORDINALITY AS k(coll, n)
                        LEFT JOIN pg_collation co ON co.oid = k.coll
                       ORDER BY k.n) AS collations
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_class t ON t.oid = i.indrelid
           JOIN pg_am am ON am.oid = c.relam
          WHERE c.relname = ANY($1::text[])`,
        [FOLDED.map((folded) => folded.index)],
      );
      const problems: string[] = [];
      for (const folded of FOLDED) {
        const row = found.rows.find((candidate) => candidate.index === folded.index);
        if (row === undefined) {
          problems.push(`no index ${folded.index}`);
          continue;
        }
        if (row.table !== folded.table) problems.push(`${folded.index} is on ${row.table}`);
        if (row.am !== 'btree') problems.push(`${folded.index} is ${row.am}`);
        if (!row.valid) problems.push(`${folded.index} is not valid`);
        if (!row.nopred) problems.push(`${folded.index} is partial`);
        if (!row.noexpr) problems.push(`${folded.index} has an expression key`);
        const lead = row.keys.slice(0, 3).join(',');
        if (lead !== `tenant_id,programme_id,${folded.column}`)
          problems.push(`${folded.index} keys begin ${lead}`);
        if (row.collations[2] !== 'C')
          problems.push(
            `${folded.index}: ${folded.column} is under collation "${row.collations[2] ?? ''}", not "C"`,
          );
      }
      expect(problems.join('\n')).toBe('');
    });

    it('RLS is enabled and forced as before, no policy names a folded column, and kasuwa_app reads the copies', async () => {
      const rls = await observer.query<{ table: string; enabled: boolean; forced: boolean }>(
        `SELECT relname AS table, relrowsecurity AS enabled, relforcerowsecurity AS forced
           FROM pg_class WHERE relname = ANY($1::text[]) AND relkind = 'r' ORDER BY 1`,
        [[...TABLES]],
      );
      expect(rls.rows).toEqual(
        [...TABLES].sort().map((table) => ({ table, enabled: true, forced: true })),
      );
      const policies = await observer.query<{ policy: string }>(
        `SELECT policyname AS policy FROM pg_policies
          WHERE tablename = ANY($1::text[])
            AND (coalesce(qual, '') ~ '_search' OR coalesce(with_check, '') ~ '_search')`,
        [[...TABLES]],
      );
      expect(policies.rows).toEqual([]);
      for (const folded of FOLDED) {
        const granted = await observer.query<{ ok: boolean }>(
          `SELECT has_column_privilege('kasuwa_app', $1::regclass, $2, 'SELECT') AS ok`,
          [folded.table, folded.column],
        );
        expect(
          granted.rows[0]?.ok,
          `kasuwa_app cannot SELECT ${folded.table}.${folded.column}`,
        ).toBe(true);
      }
    });

    it('(guard, passes on main) normalize() is IMMUTABLE; the range’s operators are LEAKPROOF; textlike is not; nothing was marked', async () => {
      // The premises of R1 and of ADR-0015's fallback, on the pinned image.
      const fns = await observer.query<{ fn: string; volatile: string; leakproof: boolean }>(
        `SELECT p.oid::regprocedure::text AS fn, p.provolatile AS volatile, p.proleakproof AS leakproof
           FROM pg_proc p
          WHERE p.oid IN ('pg_catalog.normalize(text,text)'::regprocedure,
                          'pg_catalog.text_ge(text,text)'::regprocedure,
                          'pg_catalog.text_lt(text,text)'::regprocedure,
                          'pg_catalog.texteq(text,text)'::regprocedure,
                          'pg_catalog.uuid_eq(uuid,uuid)'::regprocedure,
                          'pg_catalog.textlike(text,text)'::regprocedure)
          ORDER BY 1`,
      );
      // `normalize` is a keyword, so regprocedure prints it quoted.
      const byName = new Map(
        fns.rows.map((row) => [row.fn.replace(/^.*\./, '').replace(/"/g, ''), row]),
      );
      expect(byName.get('normalize(text,text)')?.volatile, 'normalize is not IMMUTABLE').toBe('i');
      for (const fn of [
        'text_ge(text,text)',
        'text_lt(text,text)',
        'texteq(text,text)',
        'uuid_eq(uuid,uuid)',
      ]) {
        expect(byName.get(fn)?.leakproof, `${fn} is not LEAKPROOF`).toBe(true);
      }
      expect(
        byName.get('textlike(text,text)')?.leakproof,
        'textlike must not be marked (D-L128 Q2)',
      ).toBe(false);
      // The operators a range writes resolve to those functions.
      const ops = await observer.query<{ op: string; fn: string }>(
        `SELECT o.oprname AS op, o.oprcode::regproc::text AS fn FROM pg_operator o
          WHERE o.oprleft = 'text'::regtype AND o.oprright = 'text'::regtype AND o.oprname IN ('>=', '<')
          ORDER BY 1`,
      );
      expect(ops.rows).toEqual([
        { op: '<', fn: 'text_lt' },
        { op: '>=', fn: 'text_ge' },
      ]);
      // Nothing marked: the set of LEAKPROOF functions is template1's (list-indexes I7).
      const census = `SELECT n.nspname || '.' || p.proname || '(' ||
                             pg_get_function_identity_arguments(p.oid) || ')' AS fn
                        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE p.proleakproof ORDER BY 1`;
      const here = await observer.query<{ fn: string }>(census);
      const url = new URL(inject('migrationUrl'));
      url.pathname = '/template1';
      const pristine = createPool({ connectionString: url.toString(), max: 1 });
      try {
        const baseline = await pristine.query<{ fn: string }>(census);
        expect(baseline.rows.length).toBeGreaterThan(100);
        expect(here.rows.map((row) => row.fn)).toEqual(baseline.rows.map((row) => row.fn));
      } finally {
        await pristine.end();
      }
    });

    it('every operator the folded indexes serve is LEAKPROOF, so kasuwa_app can use them under FORCE RLS', async () => {
      const indexes = await observer.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_class WHERE relname = ANY($1::text[]) AND relkind = 'i'`,
        [FOLDED.map((folded) => folded.index)],
      );
      // Not vacuous: all six folded indexes exist.
      expect(Number(indexes.rows[0]?.n)).toBe(FOLDED.length);
      const leaky = await observer.query<{ index: string; what: string }>(
        `SELECT c.relname AS index, o.oprname || ' -> ' || p.proname AS what
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           CROSS JOIN LATERAL unnest(i.indclass::oid[]) AS k(opclass)
           JOIN pg_opclass oc ON oc.oid = k.opclass
           JOIN pg_amop ao ON ao.amopfamily = oc.opcfamily
                          AND ao.amoplefttype = oc.opcintype AND ao.amoprighttype = oc.opcintype
           JOIN pg_operator o ON o.oid = ao.amopopr
           JOIN pg_proc p ON p.oid = o.oprcode
          WHERE c.relname = ANY($1::text[]) AND NOT p.proleakproof
          ORDER BY 1, 2`,
        [FOLDED.map((folded) => folded.index)],
      );
      expect(leaky.rows).toEqual([]);
    });
  });

  // =========================================================================
  // 2. Plans and latency on the large tenant (R5–R8).
  // =========================================================================

  describe('plans and latency on the large tenant (R5–R8)', () => {
    /** Every index of contact, account and deal, to attribute Bitmap Index Scans. */
    const indexTable = new Map<string, Table>();

    beforeAll(async () => {
      await reseed(inject('migrationUrl'));
      const t0 = performance.now();
      await observer.query(SEED_CONTACTS_SQL, [
        TENANT_A,
        PROGRAMME_A1,
        PROGRAMME_A2,
        CONTACT_COUNT,
      ]);
      await observer.query(SEED_ACCOUNTS_SQL, [
        TENANT_A,
        PROGRAMME_A1,
        PROGRAMME_A2,
        ACCOUNT_COUNT,
      ]);
      const a1 = await pipelineOf(PROGRAMME_A1);
      const a2 = await pipelineOf(PROGRAMME_A2);
      await observer.query(SEED_DEALS_SQL, [
        TENANT_A,
        PROGRAMME_A1,
        PROGRAMME_A2,
        a1.pipeline,
        a1.stage,
        a2.pipeline,
        a2.stage,
        DEAL_COUNT,
      ]);
      for (const table of TABLES) await observer.query(`ANALYZE ${table}`);
      const indexes = await observer.query<{ index: string; table: string }>(
        `SELECT indexname AS index, tablename AS table FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
        [[...TABLES]],
      );
      for (const row of indexes.rows) if (isTable(row.table)) indexTable.set(row.index, row.table);
      process.stdout.write(`search-api: seeded in ${Math.round(performance.now() - t0)} ms\n`);
    }, 300_000);

    afterAll(async () => {
      stopRecording();
      await reseed(inject('migrationUrl'));
    }, 120_000);

    async function judgedSearch(caller: Caller, q: string): Promise<string[]> {
      recording = [];
      startRecording();
      let statements: Recorded[];
      let response: request.Response;
      try {
        response = await searchRaw(asUser(TENANT_A, caller.userId), [['q', q]]);
      } finally {
        statements = recording ?? [];
        stopRecording();
      }
      expectResults(response, 'searchRecords', TYPE_ORDER, `${caller.label} q=${q}`);
      const judged: Judged[] = [];
      for (const statement of statements) {
        if (!TABLES.some((table) => readsTable(table).test(statement.text))) continue;
        const rows = await withTenantTransaction(
          appPool,
          { tenantId: TENANT_A, userId: caller.userId },
          (tx) =>
            tx.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
              `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`,
              statement.values,
            ),
        );
        judged.push({
          text: statement.text,
          plan: must(rows[0]?.['QUERY PLAN'][0]?.Plan, 'EXPLAIN returned no plan'),
        });
      }
      return searchPlanProblems(judged, indexTable);
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

    it('(guard, passes on main) the large tenant is seeded and kasuwa_app sees only its scope', async () => {
      const counts = await observer.query<{ contacts: string; accounts: string; deals: string }>(
        `SELECT (SELECT count(*) FROM contact WHERE tenant_id = $1) AS contacts,
                (SELECT count(*) FROM account WHERE tenant_id = $1) AS accounts,
                (SELECT count(*) FROM deal WHERE tenant_id = $1) AS deals`,
        [TENANT_A],
      );
      expect(Number(counts.rows[0]?.contacts)).toBeGreaterThanOrEqual(CONTACT_COUNT);
      expect(Number(counts.rows[0]?.accounts)).toBeGreaterThanOrEqual(ACCOUNT_COUNT);
      expect(Number(counts.rows[0]?.deals)).toBeGreaterThanOrEqual(DEAL_COUNT);
      const seen = await withTenantTransaction(
        appPool,
        { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
        (tx) =>
          tx.query<{ n: string }>(
            `SELECT count(*) AS n FROM contact WHERE display_name LIKE 'Zqcommon %'`,
          ),
      );
      // A1 holds the even half of the 5% display-name share.
      expect(Number(seen[0]?.n)).toBe(CONTACT_COUNT / 40);
    });

    for (const caller of CALLERS) {
      for (const q of ['zq', 'zqrare']) {
        it(`${caller.label}, q=${q}: every type is read through its folded index, the range is the Index Cond, no Seq Scan, rows examined within budget`, async () => {
          const problems = await judgedSearch(caller, q);
          expect([...new Set(problems)].join('\n'), `${caller.label} q=${q}`).toBe('');
        }, 120_000);
      }
    }

    it('on the large tenant each group holds three hits, each in scope and matching the prefix', async () => {
      for (const caller of CALLERS) {
        const results = await searchOk(asUser(TENANT_A, caller.userId), 'zq');
        for (const group of results.groups) {
          expect(group.hits, `${caller.label} ${group.type}`).toHaveLength(3);
          for (const hit of group.hits) {
            expect(caller.programmeIds, `${caller.label}: a hit outside scope`).toContain(
              hit.programmeId,
            );
            const values = [...NAME_FIELDS, 'name']
              .map((field) => hit[field])
              .filter((value): value is string => typeof value === 'string');
            expect(
              values.some((value) => fold(value).startsWith('zq')),
              `${caller.label} ${group.type} ${JSON.stringify(hit)}`,
            ).toBe(true);
          }
        }
      }
    }, 60_000);

    it(`searchRecords answers q=zq within ${SEARCH_BUDGET_MS} ms for either caller (best of three)`, async () => {
      for (const caller of CALLERS) {
        const headers = asUser(TENANT_A, caller.userId);
        await searchOk(headers, 'zq');
        const ms = await timed(() => searchOk(headers, 'zq'));
        process.stdout.write(`search-api latency search ${caller.label}: ${ms.toFixed(1)} ms\n`);
        expect(ms, `${caller.label} ms`).toBeLessThanOrEqual(SEARCH_BUDGET_MS);
      }
    }, 60_000);

    it(`lookupRecords finds a number on the large tenant within ${LOOKUP_BUDGET_MS} ms (best of three; plan not pinned, R8)`, async () => {
      const headers = asUser(TENANT_A, USER_A_SUPERVISOR);
      // Row 42 is even (A1); its placeholder number is +2348000000042.
      const body = { phone: '0800 000 0042' };
      const results = await lookupOk(headers, body);
      expect(idsOf(results, 'contact')).toEqual([id86('10000042')]);
      const ms = await timed(() => lookupOk(headers, body));
      process.stdout.write(`search-api latency lookup: ${ms.toFixed(1)} ms\n`);
      expect(ms).toBeLessThanOrEqual(LOOKUP_BUDGET_MS);
    }, 60_000);
  });

  // =========================================================================
  // 3. Behaviour against the contract. Every test plants its own rows and
  //    users (R23); the database is reseeded after each.
  // =========================================================================

  describe('behaviour against the contract', () => {
    afterEach(async () => {
      await reseed(inject('migrationUrl'));
    });

    const agentIn = (programme: string) => freshUser([[programme, 'agent']]);

    // --- CR3: prefix on folded text ----------------------------------------

    describe('CR3: a whole-value prefix on folded text', () => {
      it('case, accents and whitespace fold on both sides; a substring or a later word never matches', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        const id = await plantContact({
          programme: PROGRAMME_A1,
          displayName: '  Zqfóld \t Sample',
        });
        for (const q of [
          'zqfold',
          'ZQFOLD',
          'zqfóld',
          'Zqfóld',
          'zqfold s',
          'zqfold    sa',
          '  zqfold',
          'zqfold ',
          'zqfold sample',
        ]) {
          expect(idsOf(await searchOk(agent.headers, q), 'contact'), JSON.stringify(q)).toEqual([
            id,
          ]);
        }
        for (const q of ['qfold', 'sample', 'zqfoldx', 'zqfold  sx']) {
          expect(idsOf(await searchOk(agent.headers, q), 'contact'), JSON.stringify(q)).toEqual([]);
        }
      });

      it('the prefix is of the whole value: a later word matches only through another field that starts with it', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        const whole = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqwhole Zqfamily',
        });
        const byFamily = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Other Sample',
          givenNames: 'Other',
          familyName: 'Zqfamily',
        });
        expect(idsOf(await searchOk(agent.headers, 'zqfamily'), 'contact')).toEqual([byFamily]);
        expect(idsOf(await searchOk(agent.headers, 'zqwhole'), 'contact')).toEqual([whole]);
      });

      it('givenNames, familyName and companyName are matched; accounts and deals by name', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        const given = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Fixture One',
          givenNames: 'Zqfields',
        });
        const family = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Fixture Two',
          familyName: 'Zqfields',
        });
        const company = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Fixture Three',
          companyName: 'Zqfields Trading',
        });
        const account = await plantAccount(PROGRAMME_A1, 'Zqfields Holdings');
        const deal = await plantDeal(PROGRAMME_A1, 'Zqfields renewal');
        const results = await searchOk(agent.headers, 'zqfields');
        expect(idsOf(results, 'contact')).toEqual(sorted([given, family, company]));
        expect(idsOf(results, 'account')).toEqual([account]);
        expect(idsOf(results, 'deal')).toEqual([deal]);
      });

      it('`%`, `_` and `\\` match themselves only', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        const percent = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zq%lit Sample',
        });
        const underscore = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zq_lit Sample',
        });
        const backslash = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zq\\lit Sample',
        });
        await plantContact({ programme: PROGRAMME_A1, displayName: 'Zqxlit Sample' });
        await plantContact({ programme: PROGRAMME_A1, displayName: 'Zqlit Sample' });
        const account = await plantAccount(PROGRAMME_A1, 'Zq%lit Holdings');
        await plantAccount(PROGRAMME_A1, 'Zqxlit Holdings');
        expect(idsOf(await searchOk(agent.headers, 'zq%'), 'contact')).toEqual([percent]);
        expect(idsOf(await searchOk(agent.headers, 'zq%'), 'account')).toEqual([account]);
        expect(idsOf(await searchOk(agent.headers, 'zq_'), 'contact')).toEqual([underscore]);
        expect(idsOf(await searchOk(agent.headers, 'zq\\'), 'contact')).toEqual([backslash]);
        expect(idsOf(await searchOk(agent.headers, 'zq\\l'), 'contact')).toEqual([backslash]);
      });

      it('the range is exact at its ends: an equal value, any character after the prefix (ASCII, Latin-1, astral) is in; the next prefix is out', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        const equal = await plantContact({ programme: PROGRAMME_A1, displayName: 'Zqbnd' });
        const tilde = await plantContact({ programme: PROGRAMME_A1, displayName: 'Zqbnd~ Sample' });
        const latin = await plantContact({ programme: PROGRAMME_A1, displayName: 'Zqbndø Sample' });
        await plantContact({ programme: PROGRAMME_A1, displayName: 'Zqbne Sample' });
        await plantContact({ programme: PROGRAMME_A1, displayName: 'Zqbnc\u{10FFFD} Sample' });
        expect(idsOf(await searchOk(agent.headers, 'zqbnd'), 'contact')).toEqual(
          sorted([equal, tilde, latin]),
        );
        const astral = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqbnf\u{1F372} Sample',
        });
        await plantContact({ programme: PROGRAMME_A1, displayName: 'Zqbng Sample' });
        expect(idsOf(await searchOk(agent.headers, 'zqbnf'), 'contact')).toEqual([astral]);
        // A query ending in a non-ASCII letter: the upper bound is computed by code point.
        const oslash = await plantContact({ programme: PROGRAMME_A1, displayName: 'Zqø Sample' });
        await plantContact({ programme: PROGRAMME_A1, displayName: 'Zqœ Sample' });
        expect(idsOf(await searchOk(agent.headers, 'zqø'), 'contact')).toEqual([oslash]);
      });

      it('letters with no decomposition are not folded but are lower-cased; every combining mark is removed (Yoruba, Arabic)', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        const oslash = await plantContact({ programme: PROGRAMME_A1, displayName: 'ZQØL SAMPLE' });
        expect(idsOf(await searchOk(agent.headers, 'zqøl'), 'contact')).toEqual([oslash]);
        expect(idsOf(await searchOk(agent.headers, 'ZQØL'), 'contact')).toEqual([oslash]);
        expect(idsOf(await searchOk(agent.headers, 'zqol'), 'contact')).toEqual([]);
        const yoruba = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Ẹ̀xámple Zqyoruba',
        });
        expect(idsOf(await searchOk(agent.headers, 'example zqy'), 'contact')).toEqual([yoruba]);
        const arabic = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'سَامْبِل Fixture',
        });
        expect(idsOf(await searchOk(agent.headers, 'سامبل'), 'contact')).toEqual([arabic]);
        expect(idsOf(await searchOk(agent.headers, 'سَا'), 'contact')).toEqual([arabic]);
      });

      it('digits in q are text against names; q never matches a phone number or an email address', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        const year = await plantContact({ programme: PROGRAMME_A1, displayName: 'Zq 2026 Sample' });
        await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Fixture Zqphone',
          phones: ['+2348030000086'],
          emails: ['zqmail.fixture@example.test'],
        });
        expect(idsOf(await searchOk(agent.headers, 'zq 2026'), 'contact')).toEqual([year]);
        for (const q of ['+234', '0803', '2348', '+2348', 'zqmail', 'zqmail.fixture']) {
          const results = await searchOk(agent.headers, q);
          expect(
            results.groups.flatMap((group) => group.hits),
            JSON.stringify(q),
          ).toEqual([]);
        }
      });
    });

    // --- CR4 -----------------------------------------------------------------

    it('CR4: q of 2 and of 100 characters is answered; 1 once folded is too short; 101 or a control character is invalid', async () => {
      const agent = await agentIn(PROGRAMME_A1);
      await searchOk(agent.headers, 'zq');
      await searchOk(agent.headers, `zq${'x'.repeat(98)}`);
      expectOnlyDetail(
        await searchRaw(agent.headers, [['q', `zq${'x'.repeat(99)}`]]),
        'q',
        'invalid_string',
        '101 characters',
      );
      for (const q of ['z', '  z  ', 'ź', '́́́']) {
        expectOnlyDetail(
          await searchRaw(agent.headers, [['q', q]]),
          'q',
          'query_too_short',
          JSON.stringify(q),
        );
      }
      for (const q of ['zq\u0000', 'zq\u001f', 'zq\u007f', 'zq\tsample', 'zq\nsample']) {
        expectOnlyDetail(
          await searchRaw(agent.headers, [['q', q]]),
          'q',
          'invalid_string',
          JSON.stringify(q),
        );
      }
    });

    // --- CR5: exact lookups --------------------------------------------------

    describe('CR5: exact lookups by phone and email', () => {
      it('a phone in every common format finds exactly its contact, and a lead in both groups; never a longer number that starts with it', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        const lead = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqphone Lead',
          status: 'new',
          phones: ['+2348030000086'],
        });
        await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqphone Longer',
          phones: ['+23480300000861'],
        });
        const second = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqphone Second',
          status: 'customer',
          phones: ['+2348030000087', '+2348030000088'],
        });
        for (const phone of [
          '0803 000 0086',
          '+234 803 000 0086',
          '2348030000086',
          '(0803) 000-0086',
          '0803.000.0086',
          '+2348030000086',
          '0803-000-0086',
        ]) {
          const results = await lookupOk(agent.headers, { phone });
          expect(idsOf(results, 'contact'), phone).toEqual([lead]);
          expect(idsOf(results, 'lead'), phone).toEqual([lead]);
          expect(hitOf(results, 'lead', lead).status).toBe('new');
          expect(idsOf(results, 'account'), phone).toEqual([]);
          expect(idsOf(results, 'deal'), phone).toEqual([]);
        }
        const bySecond = await lookupOk(agent.headers, { phone: '0803 000 0088' });
        expect(idsOf(bySecond, 'contact')).toEqual([second]);
        expect(idsOf(bySecond, 'lead'), 'a customer is not a lead').toEqual([]);
        const narrowed = await lookupOk(agent.headers, {
          phone: '+2348030000086',
          types: ['lead'],
        });
        expect(idsOf(narrowed, 'lead')).toEqual([lead]);
      });

      it('a partial number is 400 invalid_phone, never a prefix match (R10)', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqpartial Sample',
          phones: ['+2348034560086'],
        });
        await lookupOk(agent.headers, { phone: '0803 456 0086' });
        for (const phone of ['0803 456', '+234 803 456', '803456', '0803456']) {
          expectOnlyDetail(
            await lookupRaw(agent.headers, { phone }),
            'phone',
            'invalid_phone',
            phone,
          );
        }
      });

      it('the tenant’s default country normalises the same typed digits differently in each tenant (R20)', async () => {
        const inA = await agentIn(PROGRAMME_A1);
        const nigerian = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqcountry Ng',
          phones: ['+2348030000086'],
        });
        await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqcountry Ke Decoy',
          phones: ['+2548030000086'],
        });
        expect(idsOf(await lookupOk(inA.headers, { phone: '0803 000 0086' }), 'contact')).toEqual([
          nigerian,
        ]);
        const inB = await freshUser([[PROGRAMME_B1, 'agent']], { tenantId: TENANT_B });
        const kenyan = await plantContact({
          tenantId: TENANT_B,
          programme: PROGRAMME_B1,
          displayName: 'Zqcountry Ke',
          phones: ['+254712000086'],
        });
        await plantContact({
          tenantId: TENANT_B,
          programme: PROGRAMME_B1,
          displayName: 'Zqcountry Ng Decoy',
          phones: ['+234712000086'],
        });
        expect(idsOf(await lookupOk(inB.headers, { phone: '0712 000 086' }), 'contact')).toEqual([
          kenyan,
        ]);
      });

      it('an email is a whole address, trimmed and case-insensitive on both sides; never a prefix of a longer one (R11)', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        const exact = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqmail Exact',
          status: 'contacted',
          emails: ['zq.mail@example.test'],
        });
        await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqmail Longer',
          emails: ['zq.mail@example.test.ng'],
        });
        await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqmail Prefix',
          emails: ['xzq.mail@example.test'],
        });
        const upper = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqmail Upper',
          emails: ['Zq.Upper@Example.Test'],
        });
        for (const email of [
          'zq.mail@example.test',
          'ZQ.MAIL@EXAMPLE.TEST',
          '  zq.mail@example.test  ',
        ]) {
          const results = await lookupOk(agent.headers, { email });
          expect(idsOf(results, 'contact'), email).toEqual([exact]);
          expect(idsOf(results, 'lead'), email).toEqual([exact]);
        }
        expect(
          idsOf(await lookupOk(agent.headers, { email: 'zq.upper@example.test' }), 'contact'),
        ).toEqual([upper]);
        for (const email of ['zq.mail', 'zq.mail@']) {
          expectOnlyDetail(
            await lookupRaw(agent.headers, { email }),
            'email',
            'invalid_email',
            email,
          );
        }
      });

      it('contacts and leads only: an account or a deal whose name is the address is never a hit', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        await plantAccount(PROGRAMME_A1, 'zq.named@example.test');
        await plantDeal(PROGRAMME_A1, 'zq.named@example.test');
        const contact = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqnamed Sample',
          emails: ['zq.named@example.test'],
        });
        const results = await lookupOk(agent.headers, { email: 'zq.named@example.test' });
        expect(idsOf(results, 'contact')).toEqual([contact]);
        expect(idsOf(results, 'account')).toEqual([]);
        expect(idsOf(results, 'deal')).toEqual([]);
        const narrowed = await lookupOk(agent.headers, {
          email: 'zq.named@example.test',
          types: ['account', 'deal'],
        });
        expect(narrowed.groups.flatMap((group) => group.hits)).toEqual([]);
      });

      it('a withheld number or address is never compared: the answer is the answer for one nobody has (CR7)', async () => {
        await lockField('contact', 'phones', 'team_lead', 'none');
        await lockField('contact', 'emails', 'team_lead', 'none');
        const locked = await freshUser([[PROGRAMME_A1, 'team_lead']]);
        const open = await agentIn(PROGRAMME_A1);
        const contact = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqhidden Sample',
          status: 'new',
          phones: ['+2348030000086'],
          emails: ['zq.hidden@example.test'],
        });
        expect(
          idsOf(await lookupOk(open.headers, { phone: '0803 000 0086' }), 'contact'),
          'control',
        ).toEqual([contact]);
        expect(
          idsOf(await lookupOk(open.headers, { email: 'zq.hidden@example.test' }), 'contact'),
          'control',
        ).toEqual([contact]);
        const nobodyPhone = await lookupRaw(locked.headers, { phone: '0803 000 0099' });
        const hiddenPhone = await lookupRaw(locked.headers, { phone: '0803 000 0086' });
        expect(hiddenPhone.status).toBe(200);
        expect(hiddenPhone.body).toEqual(nobodyPhone.body);
        const nobodyEmail = await lookupRaw(locked.headers, { email: 'zq.nobody@example.test' });
        const hiddenEmail = await lookupRaw(locked.headers, { email: 'zq.hidden@example.test' });
        expect(hiddenEmail.status).toBe(200);
        expect(hiddenEmail.body).toEqual(nobodyEmail.body);
        // Per row: the same number readable in A2 is found there, and only there.
        const mixed = await freshUser([
          [PROGRAMME_A1, 'team_lead'],
          [PROGRAMME_A2, 'agent'],
        ]);
        const inA2 = await plantContact({
          programme: PROGRAMME_A2,
          displayName: 'Zqhidden Other',
          phones: ['+2348030000086'],
        });
        expect(idsOf(await lookupOk(mixed.headers, { phone: '0803 000 0086' }), 'contact')).toEqual(
          [inA2],
        );
      });

      it('scope: the same number in another programme or tenant never answers', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        const mine = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqscope Mine',
          phones: ['+2348030000086'],
        });
        await plantContact({
          programme: PROGRAMME_A2,
          displayName: 'Zqscope A2',
          phones: ['+2348030000086'],
        });
        await plantContact({
          tenantId: TENANT_B,
          programme: PROGRAMME_B1,
          displayName: 'Zqscope B1',
          phones: ['+2348030000086'],
        });
        expect(
          idsOf(await lookupOk(agent.headers, { phone: '+2348030000086' }), 'contact'),
        ).toEqual([mine]);
      });

      it('a lookup hit never carries the identifier that found it; 200 not 201; nothing is written or audited (R21)', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        const id = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqquiet Sample',
          phones: ['+2348030000086'],
          emails: ['zq.quiet@example.test'],
        });
        const before = await auditCount();
        const row = await observer.query('SELECT version, updated_at FROM contact WHERE id = $1', [
          id,
        ]);
        for (const body of [{ phone: '0803 000 0086' }, { email: 'zq.quiet@example.test' }]) {
          const response = await lookupRaw(agent.headers, body);
          expect(response.status).toBe(200);
          expect(
            idsOf(
              expectResults(response, 'lookupRecords', TYPE_ORDER, JSON.stringify(body)),
              'contact',
            ),
          ).toEqual([id]);
          for (const form of ['+2348030000086', '8030000086', 'zq.quiet@example.test']) {
            expect(response.text, `the answer carries ${form}`).not.toContain(form);
          }
        }
        const search = await searchOk(agent.headers, 'zqquiet');
        expect(idsOf(search, 'contact')).toEqual([id]);
        expect(await auditCount(), 'search or lookup wrote an audit event').toBe(before);
        expect(
          (await observer.query('SELECT version, updated_at FROM contact WHERE id = $1', [id]))
            .rows,
        ).toEqual(row.rows);
      });
    });

    // --- CR7 and CR8: field security -------------------------------------------

    describe('CR7 and CR8: field security per hit, the displayName rule', () => {
      it('withholding a name part removes exactly the hits matched only through it, and changes nothing else', async () => {
        await lockField('contact', 'family_name', 'team_lead', 'none');
        const open = await agentIn(PROGRAMME_A1);
        const withheld = await freshUser([[PROGRAMME_A1, 'team_lead']]);
        const byGiven = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqwith Sample',
          givenNames: 'Zqwith',
          familyName: 'Sample',
        });
        const byFamily = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Other Fixture',
          givenNames: 'Other',
          familyName: 'Zqwith',
        });
        const byCompany = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Fixture Example',
          givenNames: 'Fixture',
          familyName: 'Example',
          companyName: 'Zqwith Ltd',
        });
        const all = idsOf(await searchOk(open.headers, 'zqwith'), 'contact');
        expect(all, 'control: the unwithheld caller').toEqual(
          sorted([byGiven, byFamily, byCompany]),
        );
        const results = await searchOk(withheld.headers, 'zqwith');
        expect(idsOf(results, 'contact')).toEqual(all.filter((id) => id !== byFamily));
        const hit = hitOf(results, 'contact', byGiven);
        expect(hit.givenNames).toBe('Zqwith');
        expect('familyName' in hit || 'displayName' in hit, JSON.stringify(hit)).toBe(false);
        expect(sorted(hit.withheldFields as string[])).toEqual(['displayName', 'familyName']);
      });

      it('a withheld field never decides which three are chosen: the readable matches are all returned', async () => {
        await lockField('contact', 'family_name', 'team_lead', 'none');
        const withheld = await freshUser([[PROGRAMME_A1, 'team_lead']]);
        // Six records match only through familyName and sort FIRST by every
        // plausible key (value, id, time); two match through givenNames and
        // sort last. Choosing three over all fields, then dropping the
        // withheld ones, returns fewer than two.
        for (let n = 0; n < 6; n += 1) {
          await plantContact({
            programme: PROGRAMME_A1,
            displayName: `Fixture Family ${n}`,
            givenNames: 'Fixture',
            familyName: `Zqorda${n}`,
          });
        }
        const readable = [
          await plantContact({
            programme: PROGRAMME_A1,
            displayName: 'Fixture Given Y',
            givenNames: 'Zqordy',
            familyName: 'Sample',
          }),
          await plantContact({
            programme: PROGRAMME_A1,
            displayName: 'Fixture Given Z',
            givenNames: 'Zqordz',
            familyName: 'Sample',
          }),
        ];
        expect(idsOf(await searchOk(withheld.headers, 'zqord'), 'contact')).toEqual(
          sorted(readable),
        );
      });

      it('field security is judged in each hit’s own programme', async () => {
        await lockField('contact', 'family_name', 'team_lead', 'none');
        const caller = await freshUser([
          [PROGRAMME_A1, 'team_lead'],
          [PROGRAMME_A2, 'agent'],
        ]);
        await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Fixture A1',
          givenNames: 'Fixture',
          familyName: 'Zqprog',
        });
        const inA2 = await plantContact({
          programme: PROGRAMME_A2,
          displayName: 'Fixture A2',
          givenNames: 'Fixture',
          familyName: 'Zqprog',
        });
        const results = await searchOk(caller.headers, 'zqprog');
        expect(idsOf(results, 'contact')).toEqual([inA2]);
        expect(hitOf(results, 'contact', inA2).familyName).toBe('Zqprog');
        expect(hitOf(results, 'contact', inA2).withheldFields).toEqual([]);
      });

      it('a withheld companyName is never compared, and is omitted and listed on a hit found by another field', async () => {
        await lockField('contact', 'company_name', 'team_lead', 'none');
        const caller = await freshUser([[PROGRAMME_A1, 'team_lead']]);
        await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Fixture Company',
          companyName: 'Zqco Trading',
        });
        const both = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqco Sample',
          companyName: 'Zqco Holdings',
        });
        const results = await searchOk(caller.headers, 'zqco');
        expect(idsOf(results, 'contact')).toEqual([both]);
        const hit = hitOf(results, 'contact', both);
        expect('companyName' in hit).toBe(false);
        expect(hit.withheldFields).toEqual(['companyName']);
        expect(hit.displayName).toBe('Zqco Sample');
      });

      it('the tenant-admin flag never lifts field security (D-L63)', async () => {
        await lockField('contact', 'family_name', 'team_lead', 'none');
        const admin = await freshUser([[PROGRAMME_A1, 'team_lead']], { tenantAdmin: true });
        await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Other Fixture',
          givenNames: 'Other',
          familyName: 'Zqflag',
        });
        const open = await agentIn(PROGRAMME_A1);
        expect(idsOf(await searchOk(open.headers, 'zqflag'), 'contact'), 'control').toHaveLength(1);
        expect(idsOf(await searchOk(admin.headers, 'zqflag'), 'contact')).toEqual([]);
      });

      it('CR8: displayName is withheld, unmatched and never composed when either part is withheld, even a null part', async () => {
        await lockField('contact', 'family_name', 'team_lead', 'none');
        await lockField('contact', 'given_names', 'programme_manager', 'none');
        const open = await agentIn(PROGRAMME_A1);
        const familyHidden = await freshUser([[PROGRAMME_A1, 'team_lead']]);
        const givenHidden = await freshUser([[PROGRAMME_A1, 'programme_manager']]);
        // Matches ONLY through displayName (its parts say something else).
        const displayOnly = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqdisp Sample',
          givenNames: 'Fixture',
          familyName: 'Example',
        });
        expect(idsOf(await searchOk(open.headers, 'zqdisp'), 'contact'), 'control').toEqual([
          displayOnly,
        ]);
        expect(idsOf(await searchOk(familyHidden.headers, 'zqdisp'), 'contact')).toEqual([]);
        expect(idsOf(await searchOk(givenHidden.headers, 'zqdisp'), 'contact')).toEqual([]);
        // The withheld part is NULL on this record: displayName is still withheld.
        const nullPart = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqnull Sample',
          givenNames: 'Zqnull',
          familyName: null,
        });
        const results = await searchOk(familyHidden.headers, 'zqnull');
        expect(idsOf(results, 'contact')).toEqual([nullPart]);
        const hit = hitOf(results, 'contact', nullPart);
        expect('displayName' in hit, JSON.stringify(hit)).toBe(false);
        expect(hit.givenNames).toBe('Zqnull');
        expect(sorted(hit.withheldFields as string[])).toEqual(['displayName', 'familyName']);
        // givenNames withheld: matched neither by displayName nor by givenNames.
        expect(idsOf(await searchOk(givenHidden.headers, 'zqnull'), 'contact')).toEqual([]);
      });
    });

    // --- CR9: readers per type -----------------------------------------------

    describe('CR9: each type’s own readers', () => {
      async function plantFour(marker: string): Promise<Record<SearchType, string>> {
        const contact = await plantContact({
          programme: PROGRAMME_A1,
          displayName: `${marker} Sample`,
          status: 'new',
        });
        return {
          contact,
          lead: contact,
          account: await plantAccount(PROGRAMME_A1, `${marker} Holdings`),
          deal: await plantDeal(PROGRAMME_A1, `${marker} renewal`),
        };
      }

      it('client_portal reads contacts, leads and accounts but never deals (D-L115); a type it cannot read is an empty group', async () => {
        const ids = await plantFour('Zqportal');
        const agent = await agentIn(PROGRAMME_A1);
        const control = await searchOk(agent.headers, 'zqportal');
        for (const type of TYPE_ORDER)
          expect(idsOf(control, type), `control ${type}`).toEqual([ids[type]]);
        const portal = await freshUser([[PROGRAMME_A1, 'client_portal']]);
        const results = await searchOk(portal.headers, 'zqportal');
        expect(idsOf(results, 'contact')).toEqual([ids.contact]);
        expect(idsOf(results, 'lead')).toEqual([ids.lead]);
        expect(idsOf(results, 'account')).toEqual([ids.account]);
        expect(idsOf(results, 'deal')).toEqual([]);
        const dealsOnly = await searchOk(portal.headers, 'zqportal', ['deal']);
        expect(dealsOnly).toEqual({ groups: [{ type: 'deal', hits: [] }] });
      });

      it('every staff set reads deals; a custom set reads none until a grant exists (D-L127)', async () => {
        const ids = await plantFour('Zqsets');
        for (const set of STAFF_SETS) {
          const user = await freshUser([[PROGRAMME_A1, set]]);
          expect(idsOf(await searchOk(user.headers, 'zqsets'), 'deal'), set).toEqual([ids.deal]);
        }
        const custom = await freshUser([[PROGRAMME_A1, await customSet()]]);
        const results = await searchOk(custom.headers, 'zqsets');
        expect(idsOf(results, 'contact'), 'control: the custom set reads contacts').toEqual([
          ids.contact,
        ]);
        expect(idsOf(results, 'deal')).toEqual([]);
      });

      it('the deal group follows listDeals for the same caller, the tenant-admin flag included (R12)', async () => {
        const ids = await plantFour('Zqfollow');
        const { pipeline } = await pipelineOf(PROGRAMME_A1);
        for (const [label, user] of [
          [
            'tenant admin holding client_portal',
            await freshUser([[PROGRAMME_A1, 'client_portal']], { tenantAdmin: true }),
          ],
          ['client_portal', await freshUser([[PROGRAMME_A1, 'client_portal']])],
          ['agent', await agentIn(PROGRAMME_A1)],
        ] as const) {
          const listed = await request(server())
            .get(`/api/v1/pipelines/${pipeline}/deals`)
            .set(user.headers);
          const listedIds =
            listed.status === 200 && Array.isArray((listed.body as Json).data)
              ? ((listed.body as Json).data as Json[]).map((deal) => String(deal.id))
              : [];
          const found = idsOf(await searchOk(user.headers, 'zqfollow'), 'deal');
          expect(
            found,
            `${label}: listDeals answered ${listed.status} with ${listedIds.length} deals`,
          ).toEqual(listedIds.includes(ids.deal) ? [ids.deal] : []);
        }
      });
    });

    // --- CR10: the lead group ------------------------------------------------

    describe('CR10: the lead group follows listLeads', () => {
      it('a lead is in both groups under the contact id; a customer or a null status only in the contact group', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        const lead = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqlead Qualified',
          status: 'qualified',
        });
        const customer = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqlead Customer',
          status: 'customer',
        });
        const none = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqlead None',
          status: null,
        });
        const results = await searchOk(agent.headers, 'zqlead');
        expect(idsOf(results, 'contact')).toEqual(sorted([lead, customer, none]));
        expect(idsOf(results, 'lead')).toEqual([lead]);
        expect(hitOf(results, 'lead', lead).status).toBe('qualified');
        expect(LEAD_STATUSES).toContain(hitOf(results, 'lead', lead).status);
      });

      it('status withheld in any programme the caller reaches empties the lead group, as listLeads refuses that caller (R13)', async () => {
        await lockField('contact', 'status', 'team_lead', 'none');
        const caller = await freshUser([
          [PROGRAMME_A1, 'agent'],
          [PROGRAMME_A2, 'team_lead'],
        ]);
        const lead = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqstatus Lead',
          status: 'new',
        });
        const listLeads = await request(server())
          .get('/api/v1/leads')
          .query({ q: 'zqstatus' })
          .set(caller.headers);
        expect(listLeads.status, 'control: listLeads refuses this caller').toBe(400);
        expect(detailsOf(listLeads.body)).toContainEqual({
          path: 'status',
          code: 'field_withheld',
        });
        const results = await searchOk(caller.headers, 'zqstatus');
        expect(idsOf(results, 'contact')).toEqual([lead]);
        expect(idsOf(results, 'lead')).toEqual([]);
        const agent = await agentIn(PROGRAMME_A1);
        expect(idsOf(await searchOk(agent.headers, 'zqstatus'), 'lead'), 'control').toEqual([lead]);
      });
    });

    // --- CR11: scope ---------------------------------------------------------

    describe('CR11: scope is the session’s', () => {
      it('records out of scope change nothing in the answer, however many there are and however they sort', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        const mine = [
          await plantContact({ programme: PROGRAMME_A1, displayName: 'Zqscope zz Sample' }),
          await plantContact({ programme: PROGRAMME_A1, displayName: 'Zqscope zy Sample' }),
        ];
        const account = await plantAccount(PROGRAMME_A1, 'Zqscope zz Holdings');
        const deal = await plantDeal(PROGRAMME_A1, 'Zqscope zz renewal');
        const first = await searchRaw(agent.headers, [['q', 'zqscope']]);
        expect(
          idsOf(expectResults(first, 'searchRecords', TYPE_ORDER, 'before'), 'contact'),
        ).toEqual(sorted(mine));
        const before = first.text;
        for (let n = 0; n < 10; n += 1) {
          await plantContact({ programme: PROGRAMME_A2, displayName: `Zqscope a${n} Sample` });
          await plantContact({
            tenantId: TENANT_B,
            programme: PROGRAMME_B1,
            displayName: `Zqscope a${n} Sample`,
          });
        }
        for (let n = 0; n < 5; n += 1) {
          await plantAccount(PROGRAMME_A2, `Zqscope a${n} Holdings`);
          await plantAccount(PROGRAMME_B1, `Zqscope a${n} Holdings`, TENANT_B);
          await plantDeal(PROGRAMME_A2, `Zqscope a${n} renewal`);
          await plantDeal(PROGRAMME_B1, `Zqscope a${n} renewal`, TENANT_B);
        }
        const after = await searchRaw(agent.headers, [['q', 'zqscope']]);
        expect(after.text).toBe(before);
        const results = expectResults(after, 'searchRecords', TYPE_ORDER, 'after');
        expect(idsOf(results, 'account')).toEqual([account]);
        expect(idsOf(results, 'deal')).toEqual([deal]);
      });

      it('unknown query parameters are ignored, never honoured (R16)', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        await plantContact({ programme: PROGRAMME_A1, displayName: 'Zqignore A1' });
        await plantContact({ programme: PROGRAMME_A2, displayName: 'Zqignore A2' });
        const plain = (await searchRaw(agent.headers, [['q', 'zqignore']])).text;
        for (const extra of [
          ['programmeId', PROGRAMME_A2],
          ['programmeIds', PROGRAMME_A2],
          ['tenantId', TENANT_B],
          ['scope', 'all'],
          ['limit', '50'],
          ['cursor', 'x'],
        ] as const) {
          const response = await searchRaw(agent.headers, [['q', 'zqignore'], extra]);
          expect(response.status, extra[0]).toBe(200);
          expect(response.text, extra[0]).toBe(plain);
        }
      });

      it('a scope header is 400; no session is 401; a user reaching no programme gets four empty groups; tenant B never sees tenant A', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqtenant Sample',
          phones: ['+2348030000086'],
        });
        for (const [header, value] of SCOPE_HEADERS) {
          expectError(
            await searchRaw(agent.headers, [['q', 'zqtenant']]).set(header, value),
            400,
            'validation_failed',
            header,
          );
          expectError(
            await lookupRaw(agent.headers, { phone: '0803 000 0086' }).set(header, value),
            400,
            'validation_failed',
            header,
          );
        }
        expectError(
          await searchRaw({}, [['q', 'zqtenant']]),
          401,
          'not_authenticated',
          'search, no session',
        );
        expectError(
          await searchRaw({}, [['q', '0803 123 4567']]),
          401,
          'not_authenticated',
          'search, no session, a bad q',
        );
        expectError(
          await lookupRaw({}, { phone: '0803 000 0086' }),
          401,
          'not_authenticated',
          'lookup, no session',
        );
        const nobody = await freshUser([]);
        expect(await searchOk(nobody.headers, 'zqtenant')).toEqual({
          groups: TYPE_ORDER.map((type) => ({ type, hits: [] })),
        });
        expect(await lookupOk(nobody.headers, { phone: '0803 000 0086' })).toEqual({
          groups: TYPE_ORDER.map((type) => ({ type, hits: [] })),
        });
        const inB = await freshUser([[PROGRAMME_B1, 'admin']], {
          tenantId: TENANT_B,
          tenantAdmin: true,
        });
        const own = await plantContact({
          tenantId: TENANT_B,
          programme: PROGRAMME_B1,
          displayName: 'Zqtenant B Sample',
        });
        expect(idsOf(await searchOk(inB.headers, 'zqtenant'), 'contact')).toEqual([own]);
        expect(idsOf(await lookupOk(inB.headers, { phone: '+2348030000086' }), 'contact')).toEqual(
          [],
        );
      });
    });

    // --- CR12, CR13, CR14, CR17 ----------------------------------------------

    describe('CR12, CR13, CR14, CR17: the shape of the answer', () => {
      it('exactly three hits per group when more match, and no count anywhere (R9)', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        for (let n = 0; n < 5; n += 1) {
          await plantContact({
            programme: PROGRAMME_A1,
            displayName: `Zqmany ${n} Sample`,
            status: 'new',
          });
          await plantAccount(PROGRAMME_A1, `Zqmany ${n} Holdings`);
          await plantDeal(PROGRAMME_A1, `Zqmany ${n} renewal`);
        }
        const results = await searchOk(agent.headers, 'zqmany');
        for (const group of results.groups) expect(group.hits, group.type).toHaveLength(3);
        const two = await plantContact({ programme: PROGRAMME_A1, displayName: 'Zqtwo Sample' });
        const two2 = await plantContact({ programme: PROGRAMME_A1, displayName: 'Zqtwo Fixture' });
        expect(idsOf(await searchOk(agent.headers, 'zqtwo'), 'contact')).toEqual(
          sorted([two, two2]),
        );
      });

      it('one group per requested type in canonical order; a record at most once per group; the same data and query give the same answer (R15)', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        const once = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqonce Sample',
          givenNames: 'Zqonce',
          familyName: 'Zqonce',
          companyName: 'Zqonce Ltd',
          status: 'new',
        });
        const narrowed = await searchOk(agent.headers, 'zqonce', ['deal', 'contact']);
        expect(narrowed.groups.map((group) => group.type)).toEqual(['contact', 'deal']);
        expect(idsOf(narrowed, 'contact')).toEqual([once]);
        const first = (await searchRaw(agent.headers, [['q', 'zqonce']])).text;
        const second = (await searchRaw(agent.headers, [['q', 'zqonce']])).text;
        expect(second).toBe(first);
        const lead = await searchOk(agent.headers, 'zqonce', ['lead']);
        expect(idsOf(lead, 'lead')).toEqual([once]);
      });

      it('hits are closed: a richly filled contact yields only the hit schema’s keys, never a phone, an email, an owner or a tag', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        const id = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqclosed Sample',
          givenNames: 'Zqclosed',
          familyName: 'Sample',
          companyName: 'Zqclosed Ltd',
          status: 'contacted',
          phones: ['+2348030000086'],
          emails: ['zq.closed@example.test'],
        });
        await observer.query(
          `UPDATE contact SET owner_user_id = $2, tags = ARRAY['zqtag'] WHERE id = $1`,
          [id, agent.id],
        );
        const response = await searchRaw(agent.headers, [['q', 'zqclosed']]);
        const results = expectResults(response, 'searchRecords', TYPE_ORDER, 'closed');
        expect(Object.keys(hitOf(results, 'contact', id)).sort()).toEqual([
          'companyName',
          'displayName',
          'familyName',
          'givenNames',
          'id',
          'programmeId',
          'type',
          'withheldFields',
        ]);
        expect(Object.keys(hitOf(results, 'lead', id)).sort()).toEqual([
          'companyName',
          'displayName',
          'familyName',
          'givenNames',
          'id',
          'programmeId',
          'status',
          'type',
          'withheldFields',
        ]);
        for (const form of ['+2348030000086', 'zq.closed@example.test', 'zqtag', agent.id]) {
          expect(response.text, form).not.toContain(form);
        }
      });
    });

    // --- CR15 and CR21: errors -------------------------------------------------

    describe('CR15 and CR21: errors, in order, from the request alone', () => {
      it('searchRecords: each detail code, and the first that applies wins (R17)', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        await searchOk(agent.headers, 'zqorder');
        const cases: [string, Params, string, string][] = [
          ['no q at all', [], 'q', 'query_required'],
          ['no q, with a phone parameter', [['phone', '08031234567']], 'q', 'query_required'],
          ['no q, with an unknown type', [['types', 'bogus']], 'q', 'query_required'],
          [
            'a phone parameter beside a good q',
            [
              ['q', 'zqorder'],
              ['phone', '08031234567'],
            ],
            'phone',
            'identifier_in_url',
          ],
          [
            'an email parameter beside a good q',
            [
              ['q', 'zqorder'],
              ['email', 'zq@example.test'],
            ],
            'email',
            'identifier_in_url',
          ],
          [
            'an identifier q that is also too long',
            [['q', `0803 123 4567 ${'x'.repeat(100)}`]],
            'q',
            'identifier_in_url',
          ],
          [
            'an identifier q with a control character',
            [['q', '08031234567\u0000']],
            'q',
            'identifier_in_url',
          ],
          [
            'an identifier q with an unknown type',
            [
              ['q', 'sample@example.test'],
              ['types', 'bogus'],
            ],
            'q',
            'identifier_in_url',
          ],
          [
            'a control character with an unknown type',
            [
              ['q', 'zq\u0001'],
              ['types', 'bogus'],
            ],
            'q',
            'invalid_string',
          ],
          ['101 characters and a short fold', [['q', '́'.repeat(101)]], 'q', 'invalid_string'],
          [
            'an unknown type with a short q',
            [
              ['q', 'z'],
              ['types', 'bogus'],
            ],
            'types',
            'unknown_type',
          ],
          [
            'a comma-joined types value (R15)',
            [
              ['q', 'zqorder'],
              ['types', 'contact,lead'],
            ],
            'types',
            'unknown_type',
          ],
          [
            'an upper-case type (R15)',
            [
              ['q', 'zqorder'],
              ['types', 'Contact'],
            ],
            'types',
            'unknown_type',
          ],
          [
            'an empty type',
            [
              ['q', 'zqorder'],
              ['types', ''],
            ],
            'types',
            'unknown_type',
          ],
          ['one character', [['q', 'z']], 'q', 'query_too_short'],
        ];
        for (const [label, params, path, code] of cases) {
          expectOnlyDetail(await searchRaw(agent.headers, params), path, code, label);
        }
        for (const params of [
          [
            ['q', 'zqorder'],
            ['types', 'contact'],
            ['types', 'contact'],
          ],
          [
            ['q', 'zq'],
            ['q', 'zqorder'],
          ],
        ] as Params[]) {
          expectError(
            await searchRaw(agent.headers, params),
            400,
            'validation_failed',
            JSON.stringify(params),
          );
        }
      });

      it('lookupRecords: each detail code, the first that applies wins, and a client key is never echoed (R17)', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        await lookupOk(agent.headers, { phone: '0803 000 0001' });
        const KEY = '08031230086';
        const cases: [string, unknown, string, string][] = [
          [
            'an unknown property beside a phone',
            { phone: '0803 000 0001', [KEY]: 1 },
            'body',
            'unknown_property',
          ],
          [
            'an unknown property with both terms',
            { phone: '0803 000 0001', email: 'zq@example.test', zq: 1 },
            'body',
            'unknown_property',
          ],
          ['an empty body', {}, 'phone', 'one_term_required'],
          [
            'both terms',
            { phone: '0803 000 0001', email: 'zq@example.test' },
            'phone',
            'one_term_required',
          ],
          ['types alone', { types: ['contact'] }, 'phone', 'one_term_required'],
          ['letters in the phone', { phone: 'zq-0803' }, 'phone', 'invalid_phone'],
          ['too short a phone', { phone: '12345' }, 'phone', 'invalid_phone'],
          ['a phone that is a number', { phone: 8030000001 }, 'phone', 'invalid_phone'],
          [
            'a bad phone with an unknown type',
            { phone: '0803 456', types: ['bogus'] },
            'phone',
            'invalid_phone',
          ],
          [
            'a bad email with an unknown type',
            { email: 'zq', types: ['bogus'] },
            'email',
            'invalid_email',
          ],
          [
            'an unknown type',
            { phone: '0803 000 0001', types: ['bogus'] },
            'types',
            'unknown_type',
          ],
        ];
        // A fresh caller per case: a 400 may count against the throttle (R18
        // leaves that to the builder), and the lookup floor is ten.
        for (const [label, body, path, code] of cases) {
          const caller = await agentIn(PROGRAMME_A1);
          const response = await lookupRaw(caller.headers, body);
          expectOnlyDetail(response, path, code, label);
          expect(response.text, `${label}: echoes the client's key`).not.toContain(KEY);
        }
        for (const raw of [
          '[]',
          '"0803 000 0001"',
          'null',
          '{"__proto__": {"phone": "0803 000 0001"}}',
          '{"phone": "0803 000 0001", "types": "contact"}',
          '{"phone":',
        ]) {
          const response = await lookupText(agent.headers, raw);
          expectError(response, 400, 'validation_failed', `R14: ${raw}`);
        }
      });

      it('a 400 is decided from the request alone: identical for every caller, never echoing the value', async () => {
        const callers = [
          await agentIn(PROGRAMME_A1),
          await freshUser([]),
          await freshUser([[PROGRAMME_B1, 'admin']], { tenantId: TENANT_B }),
        ];
        await plantContact({ programme: PROGRAMME_A1, displayName: 'Zqecho Sample' });
        const searches: Params[] = [
          [['q', 'zqecho\u0000']],
          [['q', 'z']],
          [
            ['q', 'zqecho'],
            ['types', 'zqechotype'],
          ],
          [
            ['q', 'zqecho'],
            ['email', 'zq.echo@example.test'],
          ],
        ];
        for (const params of searches) {
          const bodies = await Promise.all(
            callers.map(async (caller) => (await searchRaw(caller.headers, params)).text),
          );
          expect(new Set(bodies).size, JSON.stringify(params)).toBe(1);
          for (const [, value] of params) {
            if (value.length >= 3)
              expect(must(bodies[0], 'body'), `echoes ${value}`).not.toContain(
                value.replace('\u0000', ''),
              );
          }
        }
        for (const body of [{ phone: '0803 456' }, { email: 'zq.echo' }]) {
          const bodies = await Promise.all(
            callers.map(async (caller) => (await lookupRaw(caller.headers, body)).text),
          );
          expect(new Set(bodies).size, JSON.stringify(body)).toBe(1);
          expect(must(bodies[0], 'body')).not.toContain(Object.values(body)[0]);
        }
      });

      it('CR21: a phone or email parameter, or a phone- or email-shaped q (NFKC included), is identifier_in_url; names are not', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        for (const q of [...IDENTIFIER_QS, ...FULL_WIDTH_QS]) {
          expectOnlyDetail(
            await searchRaw(agent.headers, [['q', q]]),
            'q',
            'identifier_in_url',
            JSON.stringify(q),
          );
        }
        for (const q of NAME_QS) {
          const response = await searchRaw(agent.headers, [['q', q]]);
          expectResults(response, 'searchRecords', TYPE_ORDER, JSON.stringify(q));
        }
      });

      it('nothing a client sends is answered 500 (R14)', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        await searchOk(agent.headers, 'zqodd');
        const odd = [
          '/api/v1/search?q=%FF%FE',
          '/api/v1/search?q=%C0%80zq',
          '/api/v1/search?q=%ED%A0%80zq',
          `/api/v1/search?q=${'z'.repeat(10_000)}`,
          '/api/v1/search?q[]=zq',
          '/api/v1/search?q[a]=zq',
          '/api/v1/search?q=zq&types[]=contact',
          "/api/v1/search?q=zq'%3B%20--",
        ];
        for (const url of odd) {
          const response = await request(server()).get(url).set(agent.headers);
          expect(response.status, `${url}: ${response.text.slice(0, 200)}`).toBeLessThan(500);
          expectNoStore(response, url);
        }
      });
    });

    // --- CR16 and R22: transport, logs and telemetry ----------------------------

    it('CR16 / R22: no log line or span carries the query, the lookup body, the normalised number or a hit’s name', async () => {
      const agent = await agentIn(PROGRAMME_A1);
      await plantContact({
        programme: PROGRAMME_A1,
        displayName: 'Zqtelemetrymarker Sample',
        givenNames: 'Zqtelemetrygiven',
        phones: ['+2348030000091'],
        emails: ['zq.telemetry@example.test'],
      });
      const { telemetry, lines } = await captureEverything(async () => {
        const search = await searchRaw(agent.headers, [['q', 'Zqtelemetrymarker']]);
        expect(search.status).toBe(200);
        const byPhone = await lookupRaw(agent.headers, { phone: '0803 000 0091' });
        expect(byPhone.status).toBe(200);
        const byEmail = await lookupRaw(agent.headers, { email: 'zq.telemetry@example.test' });
        expect(byEmail.status).toBe(200);
        const refused = await searchRaw(agent.headers, [['q', 'Zqtelemetrymarker\u0000']]);
        expect(refused.status).toBe(400);
      });
      // Not vacuous: the work above produced spans.
      expect(telemetry.spans.length).toBeGreaterThan(0);
      const haystack = `${lines.join('\n')}\n${JSON.stringify(telemetry.spans)}`;
      for (const value of [
        'Zqtelemetrymarker',
        'Zqtelemetrygiven',
        '0803 000 0091',
        '+2348030000091',
        '8030000091',
        'zq.telemetry@example.test',
      ]) {
        for (const form of formsOf(value)) {
          expect(haystack.toLowerCase(), `a log or span carries "${form}"`).not.toContain(
            form.toLowerCase(),
          );
        }
      }
    });

    // --- R18: throttles ---------------------------------------------------------

    describe('R18: a per-user throttle on each operation', () => {
      let searchAdmitted: number | undefined;

      async function burst(
        send: () => Promise<request.Response>,
        cap: number,
      ): Promise<{ admitted: number; refusal: request.Response | null }> {
        for (let n = 0; n < cap; n += 1) {
          const response = await send();
          if (response.status === 429) return { admitted: n, refusal: response };
          expect(response.status, `request ${n + 1}: ${response.text.slice(0, 200)}`).toBe(200);
        }
        return { admitted: cap, refusal: null };
      }

      function expectThrottle(response: request.Response | null, where: string): void {
        expect(response, `${where}: never throttled`).not.toBeNull();
        if (response === null) return;
        const body = expectError(response, 429, 'too_many_requests', where);
        expect(body.error).toBe('Too Many Requests');
        // The documented response (D-L134), and nothing beyond its envelope.
        expect(Object.keys(responseOf('searchRecords', '429')).length).toBeGreaterThan(0);
        expect(
          Object.keys(body).filter(
            (key) => !['statusCode', 'error', 'code', 'message', 'retryAt'].includes(key),
          ),
          `${where}: the 429 carries more than the throttle envelope`,
        ).toEqual([]);
        if (body.retryAt !== undefined) {
          expect(Date.parse(String(body.retryAt)), `${where}: retryAt`).toBeGreaterThan(
            Date.now() - 5_000,
          );
        }
      }

      it(`searchRecords admits ${SEARCH_LIMIT_MIN}..${SEARCH_LIMIT_MAX} in a burst per user, then answers as the existing throttle; another user at the same address is unaffected`, async () => {
        const first = await agentIn(PROGRAMME_A1);
        const { admitted, refusal } = await burst(
          () => searchRaw(first.headers, [['q', 'zqrate']]),
          SEARCH_LIMIT_MAX + 100,
        );
        process.stdout.write(`search-api throttle: searchRecords admitted ${admitted}\n`);
        expectThrottle(refusal, 'searchRecords');
        expect(refusal?.text ?? '', 'the 429 echoes q').not.toContain('zqrate');
        expect(admitted).toBeGreaterThanOrEqual(SEARCH_LIMIT_MIN);
        expect(admitted).toBeLessThanOrEqual(SEARCH_LIMIT_MAX);
        searchAdmitted = admitted;
        // D-L134: the throttle precedes validation, so a malformed request is 429 too.
        for (const params of [[['q', 'z']], [], [['q', '0803 123 4567']]] as Params[]) {
          expectThrottle(await searchRaw(first.headers, params), `throttled ${JSON.stringify(params)}`);
        }
        const second = await agentIn(PROGRAMME_A1);
        await searchOk(second.headers, 'zqrate');
        await lookupOk(first.headers, { phone: '0803 000 0001' });
      }, 120_000);

      it(`lookupRecords admits ${LOOKUP_LIMIT_MIN}..${LOOKUP_LIMIT_MAX}, fewer than searchRecords; exhausting it leaves searchRecords open`, async () => {
        const first = await agentIn(PROGRAMME_A1);
        const { admitted, refusal } = await burst(
          () => lookupRaw(first.headers, { phone: '0803 000 0001' }),
          LOOKUP_LIMIT_MAX + 50,
        );
        process.stdout.write(`search-api throttle: lookupRecords admitted ${admitted}\n`);
        expectThrottle(refusal, 'lookupRecords');
        expect(refusal?.text ?? '').not.toContain('0803');
        expect(admitted).toBeGreaterThanOrEqual(LOOKUP_LIMIT_MIN);
        expect(admitted).toBeLessThanOrEqual(LOOKUP_LIMIT_MAX);
        expect(searchAdmitted, 'measured by the previous test').toBeDefined();
        expect(admitted, 'the lookup limit is tighter').toBeLessThan(searchAdmitted ?? 0);
        for (const body of [{}, { phone: '0803 456' }, { zq: 1 }]) {
          const throttled = await lookupRaw(first.headers, body);
          expectThrottle(throttled, `throttled ${JSON.stringify(body)}`);
          expect(throttled.text).not.toContain('0803');
        }
        await searchOk(first.headers, 'zqrate');
        const second = await agentIn(PROGRAMME_A1);
        await lookupOk(second.headers, { phone: '0803 000 0001' });
      }, 120_000);
    });

    // --- R19: the copies follow their source -------------------------------------

    describe('R19: the folded copies follow their source on every write path', () => {
      it('updateContact clearing a name part clears its copy, and search forgets it', async () => {
        const admin = await freshUser([[PROGRAMME_A1, 'admin']]);
        const id = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqclear Sample',
          givenNames: 'Zqgiven',
          familyName: 'Zqfamily',
          companyName: 'Zqco Ltd',
        });
        expect(idsOf(await searchOk(admin.headers, 'zqgiven'), 'contact'), 'control').toEqual([id]);
        const patched = await request(server())
          .patch(`/api/v1/contacts/${id}`)
          .set(admin.headers)
          .set('Content-Type', 'application/json')
          .send(JSON.stringify({ version: 1, givenNames: null, companyName: null }));
        expect(patched.status, patched.text.slice(0, 300)).toBe(200);
        expect(await foldedOf('contact', id)).toEqual({
          display_name_search: 'zqclear sample',
          given_names_search: null,
          family_name_search: 'zqfamily',
          company_name_search: null,
        });
        expect(idsOf(await searchOk(admin.headers, 'zqgiven'), 'contact')).toEqual([]);
        expect(idsOf(await searchOk(admin.headers, 'zqco'), 'contact')).toEqual([]);
        expect(idsOf(await searchOk(admin.headers, 'zqfamily'), 'contact')).toEqual([id]);
      });

      it('renaming through updateContact, updateAccount and updateDeal moves each copy', async () => {
        const admin = await freshUser([[PROGRAMME_A1, 'admin']]);
        const contact = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqoldname Sample',
        });
        const account = await plantAccount(PROGRAMME_A1, 'Zqoldname Holdings');
        const deal = await plantDeal(PROGRAMME_A1, 'Zqoldname renewal');
        const control = await searchOk(admin.headers, 'zqoldname');
        expect(
          [idsOf(control, 'contact'), idsOf(control, 'account'), idsOf(control, 'deal')],
          'control',
        ).toEqual([[contact], [account], [deal]]);
        for (const [path, name] of [
          [`/api/v1/contacts/${contact}`, { displayName: 'Zqnewname Sample' }],
          [`/api/v1/accounts/${account}`, { name: 'Zqnewname Holdings' }],
          [`/api/v1/deals/${deal}`, { name: 'Zqnewname renewal' }],
        ] as const) {
          const response = await request(server())
            .patch(path)
            .set(admin.headers)
            .set('Content-Type', 'application/json')
            .send(JSON.stringify({ version: 1, ...name }));
          expect(response.status, `${path}: ${response.text.slice(0, 300)}`).toBe(200);
        }
        expect((await foldedOf('contact', contact)).display_name_search).toBe('zqnewname sample');
        expect((await foldedOf('account', account)).name_search).toBe('zqnewname holdings');
        expect((await foldedOf('deal', deal)).name_search).toBe('zqnewname renewal');
        const old = await searchOk(admin.headers, 'zqoldname');
        expect(old.groups.flatMap((group) => group.hits)).toEqual([]);
        const renamed = await searchOk(admin.headers, 'zqnewname');
        expect([
          idsOf(renamed, 'contact'),
          idsOf(renamed, 'account'),
          idsOf(renamed, 'deal'),
        ]).toEqual([[contact], [account], [deal]]);
      });

      it('any direct write, the stand-in for a future erasure job, keeps the copies in step', async () => {
        const agent = await agentIn(PROGRAMME_A1);
        const contact = await plantContact({
          programme: PROGRAMME_A1,
          displayName: 'Zqerase Sample',
          givenNames: 'Zqerase',
          familyName: 'Zqerase',
          companyName: 'Zqerase Ltd',
        });
        const deal = await plantDeal(PROGRAMME_A1, 'Zqerase renewal');
        expect(idsOf(await searchOk(agent.headers, 'zqerase'), 'contact'), 'control').toEqual([
          contact,
        ]);
        await observer.query(
          `UPDATE contact SET display_name = 'Erased Fixture', given_names = NULL, family_name = NULL, company_name = NULL WHERE id = $1`,
          [contact],
        );
        await observer.query(`UPDATE deal SET name = 'Erased Fixture' WHERE id = $1`, [deal]);
        expect(await foldedOf('contact', contact)).toEqual({
          display_name_search: 'erased fixture',
          given_names_search: null,
          family_name_search: null,
          company_name_search: null,
        });
        expect((await foldedOf('deal', deal)).name_search).toBe('erased fixture');
        const results = await searchOk(agent.headers, 'zqerase');
        expect(results.groups.flatMap((group) => group.hits)).toEqual([]);
      });
    });
  });

  // =========================================================================
  // 4. Flags (R24).
  // =========================================================================

  describe('flags (R24)', () => {
    it('searchRecords is x-kasuwa-implemented: true', () => {
      expect(requireOperation('searchRecords').op['x-kasuwa-implemented']).toBe(true);
    });

    it('lookupRecords is x-kasuwa-implemented: true', () => {
      expect(requireOperation('lookupRecords').op['x-kasuwa-implemented']).toBe(true);
    });
  });
});
