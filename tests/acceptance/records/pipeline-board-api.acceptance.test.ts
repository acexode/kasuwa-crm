import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { inspect } from 'node:util';
import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  PROGRAMME_B2,
  SEED_ACCOUNTS,
  SEED_CONTACTS,
  SEED_DEALS,
  SEED_PERMISSION_SETS,
  SEED_TENANTS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import pg, { type Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { parse } from 'yaml';
import { asUser, withAuthDatabase } from '../support/api';
import { collectTelemetry } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0107, pipelines and the board API (P06; Agent 3). Written by
 * QA for the lead before the build (D-L23, D-L25), from the contract and the
 * decisions, not from an implementation.
 *
 * Sources: team/tasks/T-0107-pipeline-board-api.md; docs/api/records.openapi.yaml
 * (listPipelines, getPipeline, getPipelineBoard and their schemas, parameters
 * and examples, committed by T-0105); D-L88 (money, probability, half-even per
 * deal, the board), D-L113 (a default pipeline per programme), D-L115
 * (closedSince at most 366 days, currencies, numeric sums, client_portal
 * reads nothing, a non-uuid id is the same 404), D-L117 / D-L120 / D-L121
 * (the 0036 tables, bigint money, the deploy-window gap), D-P19 (exact
 * per-stage counts and per-currency totals in scope, omitted when amount is
 * withheld), D-P33 (indexes on plain columns, observed under FORCE RLS),
 * D-L80 / D-L116 (id-only cursors); T-0123 and D-L127 (a former checker is
 * unnamed: the lead's edit of R17). Prior art, copied and never imported
 * (importing a test file registers its tests): records/activities-api
 * (harness, schema checker, log capture), records/pipeline-tables (planting
 * as kasuwa_migrator), records/list-indexes (statement recording and EXPLAIN
 * replay as kasuwa_app).
 *
 * Fixtures: packages/db/src/fixtures.ts only, plus rows planted here by
 * `kasuwa_migrator` (BYPASSRLS, never serves) with ids in this suite's own
 * range (`11111111-0000-4000-8000-0107xxxxxxxx`). Deal names, next steps and
 * labels are synthetic and name no one. If the contract and this file
 * disagree on something the contract states, the contract wins and this file
 * is the defect: say so in the report, do not edit it.
 *
 * ==========================================================================
 * PINNED INTERFACES (the builder must honour these exactly)
 * ==========================================================================
 *
 * I1. ROUTES. `GET /api/v1/pipelines` (listPipelines; query `cursor`,
 *     `limit` 1..100 default 25); `GET /api/v1/pipelines/{pipelineId}`
 *     (getPipeline); `GET /api/v1/pipelines/{pipelineId}/board`
 *     (getPipelineBoard; query `q`, `owner` (repeatable: a user id, `me`,
 *     `unassigned`), `closeFrom`, `closeTo` (YYYY-MM-DD), `currency`
 *     (repeatable), `closedSince` (UTC date-time with Z), `stageId`,
 *     `cursor`, `limit` 1..50 default 20). Every answer, 200, 400 and 404,
 *     carries `Cache-Control: no-store`.
 *
 * I2. SHAPES are the contract's: PipelinePage, Pipeline, PipelineBoard (with
 *     BoardStage, StageTotal, Deal), checked against the parsed YAML,
 *     closed objects included.
 *
 * I3. SCOPE. Pipelines are programme-scoped: a session sees the pipelines of
 *     the programmes it resolves, nothing else. Anything out of scope on
 *     getPipeline or the board is the ONE `404 not_found` body
 *     (PipelineRecordNotFound), byte for byte, whatever the reason.
 *
 * I4. COUNTS AND TOTALS (D-P19). Per board column: an exact `count` over the
 *     whole stage after filters; `totals` one entry per currency among the
 *     counted deals that have an amount, sorted by code; `amountMinor` and
 *     `weightedAmountMinor` as decimal strings; weighted = amount times the
 *     stage's probabilityBp / 10000, rounded half-even PER DEAL, then summed;
 *     never summed across currencies.
 *
 * I5. WITHHELD. With `amount` withheld from the caller in the pipeline's
 *     programme: `totals` is absent from every column, `withheldFields`
 *     lists `amount`, cards omit `amount` and `weightedAmount`; counts stay.
 *     A filter on a withheld field is `400 validation_failed` with
 *     `details[].code: field_withheld` at the parameter (`owner`,
 *     `closeFrom`, `closeTo`, `currency`).
 *
 * I6. CURSORS. Opaque, base64url, id-only (see R7). Board cursors are
 *     refused with ONE `400 validation_failed` body, `details[].code:
 *     invalid_cursor` at `cursor`, whatever the reason (R8). listPipelines
 *     cursors likewise (R9).
 *
 * I7. WON AND closedSince. The won column covers deals closed at or after
 *     `closedSince` (default 90 days before the request, echoed); at most
 *     366 days back (`window_too_long`), never in the future
 *     (`invalid_window`), both at `closedSince`, never clamped.
 *
 * I8. ERROR ORDER. 404 before 400 (R3): a bad parameter on a pipeline the
 *     caller cannot reach is the 404.
 *
 * I9. PLANS (D-P33). The board's per-stage card statements use the 0036
 *     board indexes with no Sort node, replayed as kasuwa_app under FORCE
 *     RLS (R20).
 *
 * F1. FLAGS. listPipelines, getPipeline and getPipelineBoard are
 *     `x-kasuwa-implemented: true`.
 *
 * ==========================================================================
 * RULINGS (where the contract is silent or ambiguous; accepted by the lead)
 * ==========================================================================
 *
 *  R1  Routes and parameter names exactly as I1. Repeated parameters are
 *      sent as repeated keys (`currency=GHS&currency=KES`).
 *  R2  LOST IS NOT A BOARD COLUMN (the contract outranks the task's "won and
 *      lost honour closedSince", which describes listDeals, T-0108). No lost
 *      deal appears on the board under any closedSince, and `stageId` naming
 *      the lost stage is `400 unknown_reference` at `stageId`.
 *  R3  NO 403 on these three reads (the contract: "a read, so no 403"). The
 *      task's "404 before 403 before 400" reduces to 404 before 400.
 *      client_portal, a user with no programme, another programme and another
 *      tenant all meet the one 404 (getPipeline, board) or an empty page
 *      (listPipelines).
 *  R4  The one 404 body is identical byte for byte across: no such id,
 *      another tenant's pipeline, another programme's, a non-uuid, a real
 *      stage id, a real deal id, injection text, an over-long string, every
 *      caller, and getPipeline and getPipelineBoard alike.
 *  R5  (LEAD RULING) THE WON WINDOW IS JUDGED ON `closed_at`. The contract
 *      names `stage_entered_at` ("the deals that entered the won stage at or
 *      after closedSince") but orders the won column by `closedAt`; the lead
 *      rules `closed_at`. Fixtures keep a won deal's stage_entered_at equal
 *      to its closed_at, so the two readings give the same answer here. Only
 *      365 days (accepted) and 367 days (refused) are probed; the exact
 *      366-day instant is not asserted. The future is probed at +1 day.
 *  R6  The default closedSince is echoed within five minutes of (request -
 *      90 days); a sent closedSince is echoed as the same instant.
 *  R7  CURSOR SHAPE (T-0084 I4, applied here): base64url; decoded, either the
 *      bare id of the page's last row, or JSON whose every leaf is that id
 *      (any case) or an integer 0..99. No stage id, time, amount or name.
 *      The id in the clear is how this suite tampers (it re-points cursors).
 *  R8  BOARD CURSOR REFUSALS are one body (the contract's BoardCursor, which
 *      differs from the contacts lists' empty page, D-L116): malformed; not
 *      base64url; no such deal; a deal of another stage; another
 *      programme's; another tenant's; a lost deal; a won deal outside
 *      closedSince; a deal the filters sent no longer select; a deal moved
 *      since; a cursor sent without `stageId` or with another `stageId`.
 *  R9  listPipelines: a cursor naming no pipeline the caller reaches is the
 *      same `400 invalid_cursor` body as a malformed one (PipelineCursor).
 *  R10 `nextCursor` is non-null whenever more rows follow and null when a page
 *      holds fewer than `limit`; with exactly `limit` left either is allowed,
 *      and the page after may be empty.
 *  R11 Stages and each stage's requirements are in position order;
 *      transitions are compared as a set (the contract gives no order).
 *  R12 A `field` requirement leaves as the contract's camelCase
 *      DealRequirementField (`expected_close_date` -> `expectedCloseDate`).
 *  R13 Unknown query parameters are ignored, including `programmeId` on
 *      listPipelines ("no parameter narrows or widens that set"): a
 *      supervisor sending programmeId=A1 still gets A2's pipelines.
 *  R14 listPipelines writes nothing: a programme with no pipeline (the
 *      deploy-window gap) lists none, answers 200, and is not repaired by the
 *      read.
 *  R15 A column counts every deal of its stage that the filters select: no
 *      staff permission set narrows by owner. The agent and the supervisor see
 *      the same A1 board.
 *  R16 `rotting` from whole 24-hour periods since stageEnteredAt; fixtures sit
 *      12 hours from every boundary.
 *  R17 (LEAD EDIT, T-0123 and D-L127; replaces the T-0107 ruling that named
 *      every checker by their current name.) `owner.displayName` is null for
 *      a former owner (D-P23), and `checks[].checkedBy.displayName` is null
 *      for a former checker, by the same test: the user has no
 *      `user_programme` row in the DEAL's programme when the board is read.
 *      Neither the tenant-admin flag nor membership of another programme
 *      (even one the reader also reaches) makes a member. A member is served
 *      their current name; `checkedBy.id` is always served; a user re-added
 *      to the programme is named again (read time, never a snapshot); and a
 *      former checker's name appears nowhere in the body.
 *  R18 A non-uuid `stageId` is `unknown_reference` at `stageId` ("anything
 *      else"), not a generic format error.
 *  R19 A lower-case currency (`ngn`) is `unknown_currency` ("well-formed or
 *      not").
 *  R20 PLANS. A card statement is a statement the API sends during the
 *      request that reads FROM deal with ORDER BY and LIMIT. It is replayed
 *      with its own values as EXPLAIN (ANALYZE, FORMAT JSON) inside
 *      withTenantTransaction for the same user. For each: no `Sort` or
 *      `Incremental Sort` node anywhere (the board indexes give the whole
 *      order); no Seq Scan or Bitmap Heap Scan of deal; its outer
 *      (non-subplan) deal scans are Index Scan / Index Only Scan using
 *      `deal_board_open_idx` or `deal_board_closed_idx` (the 0036 names,
 *      fixed by an append-only migration); together they examine at most
 *      MAX_ROWS_EXAMINED rows. At least one card statement must be recorded,
 *      and a whole-board request must use both indexes. A page computed in a
 *      SubPlan or InitPlan (a materialised CTE) has no outer deal scan and
 *      fails: write it as the outer query or a LATERAL. Count and total
 *      statements are exact by definition and are not plan-checked. Both a
 *      one-programme agent and the two-programme supervisor are checked.
 *  R21 The board's `withheldFields` lists every Deal field withheld from the
 *      caller in the pipeline's programme, and every card's list equals it.
 *  R22 A card's `version` is the row's.
 *  R23 An amount of 0 is an amount: it makes a totals entry ("0", "0").
 *  R24 `q` is case- and diacritic-insensitive, and `%` and `_` match
 *      themselves (the contract), probed with synthetic names.
 *
 * ==========================================================================
 * THE BUILDER'S (not asserted)
 * ==========================================================================
 * Cursor encoding beyond R7; detail paths for a malformed limit, date or
 * closedSince (only the status and envelope are pinned); the order of
 * `withheldFields`; how the count and totals are queried; whether the server
 * reads its instant from Node or Postgres (five minutes of skew tolerated);
 * which 400 code wins when two parameters are bad at once.
 *
 * ==========================================================================
 * CROSS-SUITE
 * ==========================================================================
 * platform/records-contract-pipeline (T-0105) is amended by the lead in the
 * same branch as this file: listPipelines, getPipeline and getPipelineBoard
 * must be `x-kasuwa-implemented: true`, the five deal operations stay false
 * (T-0108). That suite, pipeline-tables and the tenancy folder must
 * otherwise pass unmodified.
 *
 * ==========================================================================
 * D-L23: on main none of the three routes exists and the flags are false.
 * Every test except those titled "(self-check)" begins with a request that
 * expects 200 from one of the three routes (Nest answers 404 on main), or
 * reads a false flag. Self-checks test this file's own helpers against the
 * contract's examples and pass at commit time; a checker only ever seen
 * passing proves nothing, so each also shows it rejecting broken input.
 *
 * T-0123 (lead edit, after T-0107 merged): the routes now exist on main, so
 * the one R17 former-checker test fails on main for its own reason, the
 * board still naming a checker who is not a member of the deal's programme.
 *
 * Writes: the suite reseeds before and after, after every functional test,
 * and after the plans block.
 */

// ---------------------------------------------------------------------------
// Constants and fixtures.
// ---------------------------------------------------------------------------

const PIPELINES = '/api/v1/pipelines';

/** This suite's id range: `0107` marks T-0107. Tails are 8 hex digits. */
const id107 = (tail: string) => `11111111-0000-4000-8000-0107${tail.padStart(8, '0')}`;
const NOWHERE = id107('ffffffff');
const OWN_RANGE = '11111111-0000-4000-8000-0107%';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const HALF_DAY = 12 * HOUR;
const SKEW = 5 * MINUTE;

const AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);
const AGENT_2 = asUser(TENANT_A, USER_A_AGENT_2);
const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const NO_PROGRAMME = asUser(TENANT_A, USER_A_NO_PROGRAMME);
const TENANT_B_ADMIN = asUser(TENANT_B, USER_B_AGENT_1);

type Headers = Record<string, string>;
type Json = Record<string, unknown>;
type Params = readonly (readonly [string, string])[];
type Currency = 'NGN' | 'GHS' | 'KES' | 'ZAR';

const iso = (ms: number) => new Date(ms).toISOString();
const pad2 = (n: number) => String(n).padStart(2, '0');
const arr = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

const PROGRAMME_TENANT: Readonly<Record<string, string>> = {
  [PROGRAMME_A1]: TENANT_A,
  [PROGRAMME_A2]: TENANT_A,
  [PROGRAMME_B1]: TENANT_B,
  [PROGRAMME_B2]: TENANT_B,
};
function tenantOf(programmeId: string): string {
  const tenantId = PROGRAMME_TENANT[programmeId];
  if (tenantId === undefined) throw new Error(`no tenant for programme ${programmeId}`);
  return tenantId;
}

function seededContact(givenNames: string) {
  const contact = SEED_CONTACTS.find((candidate) => candidate.givenNames === givenNames);
  if (contact === undefined) throw new Error(`Fixture drift: no seeded contact '${givenNames}'`);
  return contact;
}
function seededAccount(programmeId: string) {
  const account = SEED_ACCOUNTS.find((candidate) => candidate.programmeId === programmeId);
  if (account === undefined) throw new Error(`Fixture drift: no seeded account in ${programmeId}`);
  return account;
}
/** Tenant A, A1. */
const AMAKA = seededContact('Amaka');
/** Tenant A, A1. */
const IKOYI = seededAccount(PROGRAMME_A1);

const SEEDED_DEAL = (() => {
  const found = SEED_DEALS[0];
  if (found === undefined) throw new Error('Fixture drift: no seeded deal');
  return found;
})();

function userName(userId: string): string {
  for (const tenant of SEED_TENANTS) {
    const user = tenant.users.find((candidate) => candidate.id === userId);
    if (user !== undefined) return user.displayName;
  }
  throw new Error(`Fixture drift: no seeded user ${userId}`);
}

function permissionSet(tenantId: string, key: string): string {
  const set = SEED_PERMISSION_SETS.find(
    (candidate) => candidate.tenantId === tenantId && candidate.key === key,
  );
  if (set === undefined) throw new Error(`Fixture drift: no seeded permission set '${key}'`);
  return set.id;
}

// ---------------------------------------------------------------------------
// The board pipeline: planted in A1 beside the default one, so its deals are
// all this suite's. Stage probabilities are chosen so that half-even per deal,
// half-up, and rounding once at the end all give different totals.
// ---------------------------------------------------------------------------

type StageKey = 'S0' | 'S1' | 'S2' | 'SW' | 'SL';
type StageKind = 'open' | 'won' | 'lost';

interface StageSpec {
  key: StageKey;
  id: string;
  name: string;
  kind: StageKind;
  position: number;
  bp: number;
  rotting: number | null;
}

const BOARD_ID = id107('a0000001');
const BOARD_NAME = 'T0107 Board';
const STAGES: readonly StageSpec[] = [
  {
    key: 'S0',
    id: id107('a0000101'),
    name: 'T0107 Open zero',
    kind: 'open',
    position: 0,
    bp: 1000,
    rotting: 14,
  },
  {
    key: 'S1',
    id: id107('a0000102'),
    name: 'T0107 Open one',
    kind: 'open',
    position: 1,
    bp: 2500,
    rotting: 10,
  },
  {
    key: 'S2',
    id: id107('a0000103'),
    name: 'T0107 Open two',
    kind: 'open',
    position: 2,
    bp: 7000,
    rotting: 30,
  },
  {
    key: 'SW',
    id: id107('a0000104'),
    name: 'T0107 Won',
    kind: 'won',
    position: 3,
    bp: 10000,
    rotting: null,
  },
  {
    key: 'SL',
    id: id107('a0000105'),
    name: 'T0107 Lost',
    kind: 'lost',
    position: 4,
    bp: 0,
    rotting: null,
  },
];
function stage(key: StageKey): StageSpec {
  const found = STAGES.find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`no stage ${key}`);
  return found;
}
/** Open stages then won, in position order; lost is not a column (R2). */
const COLUMNS: readonly StageKey[] = ['S0', 'S1', 'S2', 'SW'];

const CHECK_REQ = id107('a0000201');
const FIELD_REQ_NEXT = id107('a0000202');
const FIELD_REQ_ACCOUNT = id107('a0000203');
const CHECK_ID = id107('a0000401');

/** Planted transitions (id, from, to). */
const BOARD_TRANSITIONS: readonly (readonly [string, StageKey, StageKey])[] = [
  [id107('a0000301'), 'S0', 'S1'],
  [id107('a0000302'), 'S1', 'S0'],
  [id107('a0000303'), 'S1', 'S2'],
  [id107('a0000304'), 'S2', 'SW'],
  [id107('a0000305'), 'S0', 'SL'],
];

interface DealSpec {
  id: string;
  stage: StageKey;
  name: string;
  amount: readonly [string, Currency] | null;
  owner: string | null;
  close: string | null;
  nextStep: string | null;
  /** ms before T0 at which it entered its stage (and closed, for won and lost). */
  ago: number;
  contactId?: string;
  accountId?: string;
}

const d = (n: number) => id107(`d${n.toString(16).padStart(7, '0')}`);

const NINES_5 = '999999999999999995';
const NINES_85 = '999999999999999985';
const BIG_GHS = '900719925474099301';

function plain(
  n: number,
  stageKey: StageKey,
  name: string,
  amount: readonly [string, Currency] | null,
  owner: string | null,
  ago: number,
  nextStep: string | null = null,
): DealSpec {
  return { id: d(n), stage: stageKey, name, amount, owner, close: null, nextStep, ago };
}

const DEALS: readonly DealSpec[] = [
  // S0 (1000 bp, rotting 14): 25 deals, more than the default page of 20.
  ...Array.from({ length: 12 }, (_, k): DealSpec => {
    const n = k + 1;
    return {
      id: d(n),
      stage: 'S0',
      name: `T0107 card ${pad2(n)}`,
      amount: [NINES_5, 'NGN'],
      owner: n % 2 === 1 ? USER_A_AGENT_1 : USER_A_SUPERVISOR,
      close: n <= 10 ? `2031-03-${pad2(n)}` : null,
      nextStep: n % 3 === 0 ? `T0107 synthetic step ${n}` : null,
      ago: n * DAY + HALF_DAY,
      ...(n === 1 ? { contactId: AMAKA.id, accountId: IKOYI.id } : {}),
    };
  }),
  plain(13, 'S0', 'T0107 CAFE upper', ['25', 'NGN'], null, 13 * DAY + HALF_DAY),
  plain(14, 'S0', 'T0107 5000 units', ['25', 'NGN'], null, 14 * DAY + HALF_DAY),
  plain(15, 'S0', 'T0107 card 15', ['25', 'NGN'], null, 15 * DAY + HALF_DAY),
  plain(16, 'S0', 'T0107 card 16', ['25', 'NGN'], null, 16 * DAY + HALF_DAY),
  // A four-way tie on stage_entered_at with d(2): ordered by id.
  plain(17, 'S0', 'T0107 card 17', [NINES_85, 'NGN'], USER_A_AGENT_1, 2 * DAY + HALF_DAY),
  plain(18, 'S0', 'T0107 card 18', [NINES_85, 'NGN'], USER_A_AGENT_1, 2 * DAY + HALF_DAY),
  plain(19, 'S0', 'T0107 card 19', [NINES_85, 'NGN'], USER_A_AGENT_1, 2 * DAY + HALF_DAY),
  plain(20, 'S0', 'T0107 café run', ['35', 'GHS'], USER_A_SUPERVISOR, 3 * HOUR),
  plain(21, 'S0', 'T0107 50% off', ['35', 'GHS'], USER_A_SUPERVISOR, 4 * HOUR),
  plain(22, 'S0', 'T0107 under_score', ['35', 'GHS'], USER_A_SUPERVISOR, 5 * HOUR),
  // A former owner: agent 2 is not a member of A1 (R17).
  plain(
    23,
    'S0',
    'T0107 card 23',
    [BIG_GHS, 'GHS'],
    USER_A_AGENT_2,
    20 * DAY + HALF_DAY,
    'T0107 synthetic step 23',
  ),
  plain(24, 'S0', 'T0107 card 24', null, null, 6 * HOUR),
  plain(25, 'S0', 'T0107 card 25', null, null, 7 * HOUR),
  // S1 (2500 bp, rotting 10: stale from 5).
  plain(31, 'S1', 'T0107 s1 deal 31', ['2', 'NGN'], USER_A_AGENT_1, 1 * DAY + HALF_DAY),
  plain(32, 'S1', 'T0107 s1 deal 32', ['6', 'NGN'], USER_A_SUPERVISOR, 5 * DAY + HALF_DAY),
  plain(33, 'S1', 'T0107 s1 deal 33', ['10', 'NGN'], USER_A_AGENT_1, 10 * DAY + HALF_DAY),
  plain(34, 'S1', 'T0107 s1 deal 34', ['0', 'KES'], null, 2 * DAY + HALF_DAY),
  // S2: empty.
  // SW (won).
  plain(41, 'SW', 'T0107 won deal 41', ['1000', 'NGN'], USER_A_AGENT_1, 10 * DAY),
  plain(42, 'SW', 'T0107 won deal 42', ['5', 'ZAR'], null, 60 * DAY),
  plain(43, 'SW', 'T0107 won deal 43', ['7', 'NGN'], USER_A_AGENT_1, 100 * DAY),
  plain(44, 'SW', 'T0107 won deal 44', ['9', 'NGN'], null, 400 * DAY),
  plain(45, 'SW', 'T0107 won deal 45', ['11', 'NGN'], USER_A_SUPERVISOR, 10 * DAY),
  // SL (lost): never on the board (R2).
  plain(51, 'SL', 'T0107 lost deal 51', ['123', 'NGN'], USER_A_AGENT_1, 5 * DAY),
];
function deal(id: string): DealSpec {
  const found = DEALS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no planted deal ${id}`);
  return found;
}

/** A deal in A2's default pipeline and one in B1's (cursor targets). */
const FOREIGN_A2 = id107('d000a201');
const FOREIGN_B1 = id107('d000b101');

// ---------------------------------------------------------------------------
// The model: expected counts, totals and card orders, from the fixtures above
// and BigInt arithmetic, never from the code under test.
// ---------------------------------------------------------------------------

/** amount * bp / 10000, rounded half to even. */
function halfEven(amount: bigint, bp: number): bigint {
  const n = amount * BigInt(bp);
  const q = n / 10000n;
  const r = n % 10000n;
  if (r * 2n > 10000n) return q + 1n;
  if (r * 2n === 10000n) return q % 2n === 0n ? q : q + 1n;
  return q;
}

interface Filters {
  currency?: readonly Currency[];
  /** User ids, or 'unassigned'. */
  owners?: readonly string[];
  closeFrom?: string;
  closeTo?: string;
  /** For `q`: the ids it must select, listed by hand. */
  only?: ReadonlySet<string>;
  /** The won window in days before T0 (90 by default). */
  windowDays?: number;
}

interface Total {
  currency: string;
  amountMinor: string;
  weightedAmountMinor: string;
}

function selected(spec: DealSpec, filters: Filters): boolean {
  if (spec.stage === 'SL') return false;
  if (spec.stage === 'SW' && spec.ago > (filters.windowDays ?? 90) * DAY) return false;
  if (filters.currency !== undefined) {
    if (spec.amount === null || !filters.currency.includes(spec.amount[1])) return false;
  }
  if (filters.owners !== undefined) {
    const key = spec.owner ?? 'unassigned';
    if (!filters.owners.includes(key)) return false;
  }
  if (filters.closeFrom !== undefined && (spec.close === null || spec.close < filters.closeFrom)) {
    return false;
  }
  if (filters.closeTo !== undefined && (spec.close === null || spec.close > filters.closeTo)) {
    return false;
  }
  if (filters.only !== undefined && !filters.only.has(spec.id)) return false;
  return true;
}

function columnOrder(key: StageKey, filters: Filters): DealSpec[] {
  const rows = DEALS.filter((spec) => spec.stage === key && selected(spec, filters));
  const won = stage(key).kind === 'won';
  return [...rows].sort((a, b) => {
    // Open: stage_entered_at ascending (largest `ago` first), then id ascending.
    // Won: closed_at descending (smallest `ago` first), then id descending.
    if (a.ago !== b.ago) return won ? a.ago - b.ago : b.ago - a.ago;
    if (a.id === b.id) return 0;
    if (won) return a.id < b.id ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });
}

function totalsOf(rows: readonly DealSpec[], bp: number): Total[] {
  const sums = new Map<string, { amount: bigint; weighted: bigint }>();
  for (const spec of rows) {
    if (spec.amount === null) continue;
    const [minor, currency] = spec.amount;
    const sum = sums.get(currency) ?? { amount: 0n, weighted: 0n };
    sum.amount += BigInt(minor);
    sum.weighted += halfEven(BigInt(minor), bp);
    sums.set(currency, sum);
  }
  return [...sums.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, sum]) => ({
      currency,
      amountMinor: sum.amount.toString(),
      weightedAmountMinor: sum.weighted.toString(),
    }));
}

interface ExpectedColumn {
  stageId: string;
  count: number;
  totals: Total[];
  order: string[];
}

function expectedColumn(key: StageKey, filters: Filters): ExpectedColumn {
  const rows = columnOrder(key, filters);
  return {
    stageId: stage(key).id,
    count: rows.length,
    totals: totalsOf(rows, stage(key).bp),
    order: rows.map((spec) => spec.id),
  };
}

function rottingOf(spec: DealSpec): 'fresh' | 'stale' | 'rotting' | null {
  const at = stage(spec.stage);
  if (at.kind !== 'open' || at.rotting === null) return null;
  const days = Math.floor(spec.ago / DAY);
  if (days >= at.rotting) return 'rotting';
  if (days >= Math.floor(at.rotting / 2)) return 'stale';
  return 'fresh';
}

/** The display name the board must print for an A1 deal's owner (R17). */
function ownerName(userId: string): string | null {
  return userId === USER_A_AGENT_2 ? null : userName(userId);
}

/** One card exactly as the contract says it leaves, minus createdAt/updatedAt. */
function expectedCard(spec: DealSpec, t0: number, withheld: readonly string[]): Json {
  const at = stage(spec.stage);
  const time = iso(t0 - spec.ago);
  const card: Json = {
    id: spec.id,
    programmeId: PROGRAMME_A1,
    pipelineId: BOARD_ID,
    stageId: at.id,
    version: 1,
    name: spec.name,
    amount: spec.amount === null ? null : { amountMinor: spec.amount[0], currency: spec.amount[1] },
    weightedAmount:
      spec.amount === null
        ? null
        : {
            amountMinor: halfEven(BigInt(spec.amount[0]), at.bp).toString(),
            currency: spec.amount[1],
          },
    expectedCloseDate: spec.close,
    ownerUserId: spec.owner,
    owner: spec.owner === null ? null : { id: spec.owner, displayName: ownerName(spec.owner) },
    primaryContactId: spec.contactId ?? null,
    contact:
      spec.contactId === undefined ? null : { id: AMAKA.id, displayName: AMAKA.displayName },
    accountId: spec.accountId ?? null,
    account: spec.accountId === undefined ? null : { id: IKOYI.id, name: IKOYI.name },
    nextStep: spec.nextStep,
    stageEnteredAt: time,
    closedAt: at.kind === 'open' ? null : time,
    rotting: rottingOf(spec),
    checks:
      spec.id === d(33)
        ? [
            {
              requirementId: CHECK_REQ,
              checkedAt: iso(t0 - 10 * DAY),
              checkedBy: { id: USER_A_SUPERVISOR, displayName: userName(USER_A_SUPERVISOR) },
            },
          ]
        : [],
    withheldFields: [...withheld].sort(),
  };
  const companions: Record<string, string> = {
    amount: 'weightedAmount',
    ownerUserId: 'owner',
    primaryContactId: 'contact',
    accountId: 'account',
  };
  for (const field of withheld) {
    delete card[field];
    const companion = companions[field];
    if (companion !== undefined) delete card[companion];
  }
  return card;
}

/** A served card normalised for comparison: timestamps as ISO, no createdAt/updatedAt. */
function normaliseCard(card: Json): Json {
  const out: Json = { ...card };
  delete out.createdAt;
  delete out.updatedAt;
  // T-0089 / D-L143 (lead edit): a card is a Deal, so it may carry `custom` (absent on main).
  // This suite plants no custom value, so when present it is exactly `{}`.
  if ('custom' in out) {
    expect(out.custom, `card ${String(out.id)}: custom with no custom values planted`).toEqual({});
    delete out.custom;
  }
  for (const key of ['stageEnteredAt', 'closedAt']) {
    if (typeof out[key] === 'string') out[key] = iso(Date.parse(String(out[key])));
  }
  out.checks = arr(out.checks).map((entry) => ({
    ...entry,
    checkedAt: iso(Date.parse(String(entry.checkedAt))),
  }));
  out.withheldFields = strings(out.withheldFields).sort();
  return out;
}

// ---------------------------------------------------------------------------
// A small JSON-Schema checker over the published YAML (no new dependency).
// Copied from the T-0082 suite, plus `pattern`, `date` and item bounds.
// ---------------------------------------------------------------------------

const SPEC_PATH = resolve(__dirname, '../../../docs/api/records.openapi.yaml');
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

interface Located {
  schema: Json;
  file: string;
}

function deref(schema: Json, file: string): Located {
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

const FORMATS: Record<string, RegExp> = {
  uuid: UUID,
  'date-time': DATE_TIME,
  date: /^\d{4}-\d{2}-\d{2}$/,
};

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
      errors.push(
        `${path}: matches ${passing.length} oneOf branches (value ${JSON.stringify(value)})`,
      );
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
    const ok = allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'));
    if (!ok) {
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
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match ${schema.pattern}`);
    }
    const format = typeof schema.format === 'string' ? FORMATS[schema.format] : undefined;
    if (format !== undefined && !format.test(value)) {
      errors.push(`${path}: not a valid ${String(schema.format)}`);
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
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path}: more than ${schema.maxItems} items`);
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} items`);
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

function okContent(operationId: string): Json {
  const { op } = requireOperation(operationId);
  const raw = ((op.responses ?? {}) as Json)['200'] as Json | undefined;
  if (raw === undefined) throw new Error(`${operationId} documents no 200 response`);
  const response = deref(raw, SPEC_PATH).schema;
  const content = (response.content as Json | undefined)?.['application/json'] as
    | Json
    | undefined;
  if (content === undefined) throw new Error(`${operationId} 200 has no JSON content`);
  return content;
}

function okSchema(operationId: string): Json {
  const schema = okContent(operationId).schema as Json | undefined;
  if (schema === undefined) throw new Error(`${operationId} 200 has no schema`);
  return schema;
}

function okExample(operationId: string, name?: string): Json {
  const content = okContent(operationId);
  const value =
    name === undefined
      ? content.example
      : ((content.examples as Json | undefined)?.[name] as Json | undefined)?.value;
  if (value === undefined) throw new Error(`${operationId} has no example ${name ?? ''}`);
  return structuredClone(value) as Json;
}

// ---------------------------------------------------------------------------
// Response checks.
// ---------------------------------------------------------------------------

function expectStatus(response: request.Response, status: number, where: string): void {
  expect(response.status, `${where}: ${response.status} ${response.text.slice(0, 400)}`).toBe(
    status,
  );
}

function expectNoStore(response: request.Response, where: string): void {
  expect(
    String(response.headers['cache-control'] ?? ''),
    `${where}: Cache-Control must be no-store`,
  ).toMatch(/(^|[\s,])no-store($|[\s,])/);
}

/** admin.openapi.yaml `Error`, with the status and `code` the operation names. */
function expectError(
  response: request.Response,
  status: number,
  code: string,
  where: string,
): Json {
  expectStatus(response, status, where);
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

function detailsOf(body: Json): string[] {
  return arr(body.details).map((detail) => `${String(detail.path)}:${String(detail.code)}`);
}

/** A 400 whose details carry `code` at `path`. */
function expectDetail(response: request.Response, path: string, code: string, where: string) {
  const body = expectError(response, 400, 'validation_failed', where);
  expect(detailsOf(body), `${where}: details`).toContain(`${path}:${code}`);
  return body;
}

const WITHHOLDABLE: readonly (readonly [string, string | null])[] = [
  ['amount', 'weightedAmount'],
  ['ownerUserId', 'owner'],
  ['primaryContactId', 'contact'],
  ['accountId', 'account'],
  ['expectedCloseDate', null],
  ['nextStep', null],
];

/** Deal's "omitted, never nulled" rule, and every card agrees with the board (R21). */
function dealWithholdingProblems(
  card: Json,
  at: string,
  boardWithheld: readonly string[],
): string[] {
  const problems: string[] = [];
  const listed = strings(card.withheldFields);
  for (const [field, companion] of WITHHOLDABLE) {
    if (field in card === listed.includes(field)) {
      problems.push(`${at}: ${field} must be present or listed in withheldFields, exactly one`);
    }
    if (companion !== null && companion in card !== field in card) {
      problems.push(`${at}: ${companion} must be withheld with ${field}`);
    }
  }
  if ([...listed].sort().join() !== [...boardWithheld].sort().join()) {
    problems.push(`${at}: withheldFields ${listed.join()} differ from the board's`);
  }
  return problems;
}

/** One PipelineBoard, by the operation's own 200 schema and I5. */
function boardProblems(value: unknown, where: string): string[] {
  const problems = schemaErrors(okSchema('getPipelineBoard'), value, where);
  const board = (value ?? {}) as Json;
  const withheld = strings(board.withheldFields);
  arr(board.stages).forEach((stageColumn, index) => {
    const at = `${where}.stages[${index}]`;
    if (withheld.includes('amount') === 'totals' in stageColumn) {
      problems.push(`${at}: totals must be omitted exactly when amount is withheld`);
    }
    arr(stageColumn.cards).forEach((card, position) =>
      problems.push(...dealWithholdingProblems(card, `${at}.cards[${position}]`, withheld)),
    );
  });
  return problems;
}

// ---------------------------------------------------------------------------
// Cursors (R7).
// ---------------------------------------------------------------------------

function cursorProblems(cursor: string, lastId: string): string[] {
  const id = lastId.toLowerCase();
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
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
      return;
    }
    if (typeof value === 'string' && value.toLowerCase() === id) {
      sawId = true;
      return;
    }
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 99) return;
    problems.push(`${path} carries ${JSON.stringify(value)}, not the last row's id`);
  };
  walk(parsed, '$');
  if (!sawId) problems.push(`does not carry the last row's id ${id}`);
  return problems;
}

/** The same cursor, pointing at another id. Needs the id in the clear (R7). */
function repoint(cursor: string, fromId: string, toId: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const pattern = new RegExp(fromId, 'gi');
  if (!pattern.test(decoded)) throw new Error(`cursor does not carry ${fromId} in the clear`);
  return Buffer.from(decoded.replace(pattern, toId), 'utf8').toString('base64url');
}

// ---------------------------------------------------------------------------
// Log capture (the T-0036 approach), for the "never logged" check.
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

async function captureEverything(work: () => Promise<void>): Promise<string[]> {
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
  let telemetry: Awaited<ReturnType<typeof collectTelemetry>>;
  try {
    telemetry = await collectTelemetry(work);
  } finally {
    for (const spy of spies) spy.mockRestore();
    captureLines = null;
  }
  return [
    ...lines,
    ...telemetry.logs.map((record) => render(record)),
    ...telemetry.spans.map((span) => render(span)),
  ];
}

// ---------------------------------------------------------------------------
// Statement recording and plans (R20; the list-indexes approach).
// ---------------------------------------------------------------------------

/** Rows a card statement may examine on deal. A stage holds ~4,300 in the plans block. */
const MAX_ROWS_EXAMINED = 500;
const BOARD_INDEXES = ['deal_board_open_idx', 'deal_board_closed_idx'] as const;
const BULK_PER_PROGRAMME = 30_000;

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

const READS_DEAL = /\bFROM\s+(?:"?public"?\.)?"?deal"?(?![A-Za-z0-9_"])/i;
const isCardStatement = (text: string) =>
  READS_DEAL.test(text) && /\bORDER\s+BY\b/i.test(text) && /\bLIMIT\b/i.test(text);

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
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

/** R20 for one card statement's plan. */
function planProblems(root: PlanNode): { problems: string[]; indexes: Set<string> } {
  const problems: string[] = [];
  const indexes = new Set<string>();
  const nodes = flatten(root);
  for (const { node } of nodes) {
    if (node['Node Type'] === 'Sort' || node['Node Type'] === 'Incremental Sort') {
      problems.push(`a ${node['Node Type']} node: the order does not come from a board index`);
    }
    if (
      node['Relation Name'] === 'deal' &&
      (node['Node Type'] === 'Seq Scan' || node['Node Type'] === 'Bitmap Heap Scan')
    ) {
      problems.push(describeNode(node));
    }
  }
  const outer = nodes.filter(
    ({ node, inSubplan }) => !inSubplan && node['Relation Name'] === 'deal',
  );
  if (outer.length === 0) problems.push('no outer scan of deal in the plan');
  let examined = 0;
  for (const { node } of outer) {
    const index = node['Index Name'];
    if (
      (node['Node Type'] !== 'Index Scan' && node['Node Type'] !== 'Index Only Scan') ||
      index === undefined ||
      !(BOARD_INDEXES as readonly string[]).includes(index)
    ) {
      problems.push(`the cards are read by ${describeNode(node)}, not a board index`);
    } else {
      indexes.add(index);
    }
    examined +=
      ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) *
      (node['Actual Loops'] ?? 1);
  }
  if (examined > MAX_ROWS_EXAMINED) {
    problems.push(
      `the card statement examined ${examined} deal rows (budget ${MAX_ROWS_EXAMINED}): it scans, it does not seek`,
    );
  }
  return { problems, indexes };
}

// ---------------------------------------------------------------------------

describe('acceptance: pipelines and the board API (T-0107)', () => {
  let app: INestApplication;
  /** kasuwa_migrator — BYPASSRLS. Plants rows and observes them; never serves. */
  let observer: Pool;
  /** kasuwa_app — the replayed EXPLAINs run here, inside withTenantTransaction. */
  let appPool: Pool;
  /** When the board's deals were planted; every relative time hangs off it. */
  let T0 = 0;

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
  });

  afterAll(async () => {
    stopRecording();
    await app?.close();
    await observer?.end();
    await appPool?.end();
    await reseed(inject('migrationUrl'));
  }, 120_000);

  const server = () => app.getHttpServer();

  // --- HTTP helpers -------------------------------------------------------

  const withQuery = (path: string, params: Params) => {
    const query = new URLSearchParams(params.map(([k, v]): [string, string] => [k, v])).toString();
    return query === '' ? path : `${path}?${query}`;
  };
  const listPipelines = (headers: Headers, params: Params = []) =>
    request(server()).get(withQuery(PIPELINES, params)).set(headers);
  const getPipeline = (headers: Headers, id: string) =>
    request(server()).get(`${PIPELINES}/${encodeURIComponent(id)}`).set(headers);
  const board = (headers: Headers, id: string, params: Params = []) =>
    request(server())
      .get(withQuery(`${PIPELINES}/${encodeURIComponent(id)}/board`, params))
      .set(headers);

  // --- planting (kasuwa_migrator) -------------------------------------------

  type Query = (text: string, values?: readonly unknown[]) => Promise<unknown>;

  async function inTransaction(work: (query: Query) => Promise<void>): Promise<void> {
    const client = await observer.connect();
    try {
      await client.query('BEGIN');
      await work(async (text, values) => client.query(text, values ? [...values] : []));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  interface StagePlant {
    id: string;
    name: string;
    kind: StageKind;
    position: number;
    bp: number;
    rotting: number | null;
  }
  interface RequirementPlant {
    id: string;
    stageId: string;
    kind: 'field' | 'check';
    position: number;
    field: string | null;
    label: string | null;
  }
  interface PipelinePlant {
    id: string;
    programmeId: string;
    name: string;
    stages: readonly StagePlant[];
    requirements: readonly RequirementPlant[];
    transitions: readonly (readonly [string, string, string])[];
  }

  async function plantPipeline(plant: PipelinePlant): Promise<void> {
    const tenantId = tenantOf(plant.programmeId);
    await inTransaction(async (query) => {
      await query(
        'INSERT INTO pipeline (id, tenant_id, programme_id, name) VALUES ($1, $2, $3, $4)',
        [plant.id, tenantId, plant.programmeId, plant.name],
      );
      for (const s of plant.stages) {
        await query(
          `INSERT INTO pipeline_stage (id, tenant_id, programme_id, pipeline_id, name, kind,
                                       position, probability_bp, rotting_after_days)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            s.id,
            tenantId,
            plant.programmeId,
            plant.id,
            s.name,
            s.kind,
            s.position,
            s.bp,
            s.rotting,
          ],
        );
      }
      for (const r of plant.requirements) {
        await query(
          `INSERT INTO pipeline_stage_requirement (id, tenant_id, programme_id, pipeline_id,
                                                   stage_id, kind, position, field, label)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            r.id,
            tenantId,
            plant.programmeId,
            plant.id,
            r.stageId,
            r.kind,
            r.position,
            r.field,
            r.label,
          ],
        );
      }
      for (const [id, from, to] of plant.transitions) {
        await query(
          `INSERT INTO pipeline_stage_transition (id, tenant_id, programme_id, pipeline_id,
                                                  from_stage_id, to_stage_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, tenantId, plant.programmeId, plant.id, from, to],
        );
      }
    });
  }

  /** A minimal pipeline (one open, won, lost) numbered `k`, in A1 unless told otherwise. */
  const manyId = (k: number) => id107(`c${k.toString(16).padStart(3, '0')}0000`);
  async function plantSimplePipeline(k: number, name: string, programmeId = PROGRAMME_A1) {
    const stageId = (n: number) => id107(`c${k.toString(16).padStart(3, '0')}000${n}`);
    await plantPipeline({
      id: manyId(k),
      programmeId,
      name,
      stages: [
        { id: stageId(1), name: 'T0107 open', kind: 'open', position: 0, bp: 5000, rotting: 14 },
        { id: stageId(2), name: 'T0107 won', kind: 'won', position: 1, bp: 10000, rotting: null },
        { id: stageId(3), name: 'T0107 lost', kind: 'lost', position: 2, bp: 0, rotting: null },
      ],
      requirements: [],
      transitions: [],
    });
    return manyId(k);
  }
  const TWIN_1 = manyId(1);
  const TWIN_2 = manyId(2);
  async function plantTwins() {
    await plantSimplePipeline(1, 'T0107 Twin');
    await plantSimplePipeline(2, 'T0107 Twin');
  }

  const BOARD_PLANT: PipelinePlant = {
    id: BOARD_ID,
    programmeId: PROGRAMME_A1,
    name: BOARD_NAME,
    stages: STAGES.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      position: s.position,
      bp: s.bp,
      rotting: s.rotting,
    })),
    requirements: [
      {
        id: CHECK_REQ,
        stageId: stage('S1').id,
        kind: 'check',
        position: 0,
        field: null,
        label: 'T0107 synthetic check',
      },
      {
        id: FIELD_REQ_NEXT,
        stageId: stage('S2').id,
        kind: 'field',
        position: 0,
        field: 'next_step',
        label: null,
      },
      {
        id: FIELD_REQ_ACCOUNT,
        stageId: stage('S2').id,
        kind: 'field',
        position: 1,
        field: 'account_id',
        label: null,
      },
    ],
    transitions: BOARD_TRANSITIONS.map(
      ([id, from, to]) => [id, stage(from).id, stage(to).id] as const,
    ),
  };

  interface DealPlant {
    id: string;
    programmeId: string;
    pipelineId: string;
    stageId: string;
    name: string;
    amount: readonly [string, Currency] | null;
    owner: string | null;
    close: string | null;
    nextStep: string | null;
    enteredAt: number;
    closedAt: number | null;
    contactId: string | null;
    accountId: string | null;
  }

  async function plantDeal(row: DealPlant): Promise<void> {
    await observer.query(
      `INSERT INTO deal (id, tenant_id, programme_id, pipeline_id, stage_id, name, amount_minor,
                         currency, expected_close_date, owner_user_id, primary_contact_id,
                         account_id, next_step, stage_entered_at, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8, $9::date, $10, $11, $12, $13, $14, $15)`,
      [
        row.id,
        tenantOf(row.programmeId),
        row.programmeId,
        row.pipelineId,
        row.stageId,
        row.name,
        row.amount === null ? null : row.amount[0],
        row.amount === null ? null : row.amount[1],
        row.close,
        row.owner,
        row.contactId,
        row.accountId,
        row.nextStep,
        iso(row.enteredAt),
        row.closedAt === null ? null : iso(row.closedAt),
      ],
    );
  }

  /** The board pipeline, its deals and one ticked check. Sets T0. */
  async function plantBoard(): Promise<void> {
    await plantPipeline(BOARD_PLANT);
    T0 = Date.now();
    for (const spec of DEALS) {
      const at = stage(spec.stage);
      await plantDeal({
        id: spec.id,
        programmeId: PROGRAMME_A1,
        pipelineId: BOARD_ID,
        stageId: at.id,
        name: spec.name,
        amount: spec.amount,
        owner: spec.owner,
        close: spec.close,
        nextStep: spec.nextStep,
        enteredAt: T0 - spec.ago,
        closedAt: at.kind === 'open' ? null : T0 - spec.ago,
        contactId: spec.contactId ?? null,
        accountId: spec.accountId ?? null,
      });
    }
    await observer.query(
      `INSERT INTO deal_requirement_check (id, tenant_id, programme_id, pipeline_id, deal_id,
                                           requirement_id, checked_by_user_id, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        CHECK_ID,
        TENANT_A,
        PROGRAMME_A1,
        BOARD_ID,
        d(33),
        CHECK_REQ,
        USER_A_SUPERVISOR,
        iso(T0 - 10 * DAY),
      ],
    );
  }

  interface DbStage {
    id: string;
    kind: string;
    position: number;
  }

  /** The programme's seeded default pipeline (exactly one outside this suite's range). */
  async function defaultPipeline(programmeId: string): Promise<{ id: string; stages: DbStage[] }> {
    const found = await observer.query<{ id: string }>(
      'SELECT id FROM pipeline WHERE programme_id = $1 AND id::text NOT LIKE $2',
      [programmeId, OWN_RANGE],
    );
    if (found.rows.length !== 1) {
      throw new Error(
        `expected one default pipeline in ${programmeId}, found ${found.rows.length}`,
      );
    }
    const id = String(found.rows[0]?.id);
    const stages = await observer.query<DbStage>(
      'SELECT id, kind, position FROM pipeline_stage WHERE pipeline_id = $1 ORDER BY position',
      [id],
    );
    return { id, stages: stages.rows };
  }

  /** A deal in A2's and in B1's default pipelines, first stage. */
  async function plantForeignDeals(): Promise<void> {
    for (const [id, programmeId] of [
      [FOREIGN_A2, PROGRAMME_A2],
      [FOREIGN_B1, PROGRAMME_B1],
    ] as const) {
      const target = await defaultPipeline(programmeId);
      const first = target.stages[0];
      if (first === undefined) throw new Error('a default pipeline without stages');
      await plantDeal({
        id,
        programmeId,
        pipelineId: target.id,
        stageId: first.id,
        name: 'T0107 foreign deal',
        amount: ['100', 'NGN'],
        owner: null,
        close: null,
        nextStep: null,
        enteredAt: Date.now() - DAY,
        closedAt: null,
        contactId: null,
        accountId: null,
      });
    }
  }

  async function assign(userId: string, programmeId: string, key: string) {
    const tenantId = tenantOf(programmeId);
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id)
       DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, tenantId, permissionSet(tenantId, key)],
    );
  }

  /**
   * Removes a membership (copied from the deals-api suite, T-0123). The
   * delete writes its own programme membership audit event (0031/0033,
   * D-L126); no test here counts audit events.
   */
  async function unassign(userId: string, programmeId: string) {
    await observer.query('DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2', [
      userId,
      programmeId,
    ]);
  }

  /** One more tick of the board's check requirement, on an A1 board deal (T-0123). */
  async function plantBoardCheck(id: string, dealId: string, by: string, at: number) {
    await observer.query(
      `INSERT INTO deal_requirement_check (id, tenant_id, programme_id, pipeline_id, deal_id,
                                           requirement_id, checked_by_user_id, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, TENANT_A, PROGRAMME_A1, BOARD_ID, dealId, CHECK_REQ, by, iso(at)],
    );
  }

  /** One deal field-security decision in tenant A, against its standard field_def. */
  async function lockField(field: string, setKey: string, level: 'none' | 'read' | 'edit') {
    const found = await observer.query<{ id: string }>(
      `SELECT f.id FROM field_def f
         JOIN object_def o ON o.id = f.object_id AND o.tenant_id = f.tenant_id
        WHERE f.tenant_id = $1 AND o.api_name = 'deal' AND f.api_name = $2
          AND NOT f.is_custom`,
      [TENANT_A, field],
    );
    const fieldId = found.rows[0]?.id;
    if (fieldId === undefined) throw new Error(`tenant A has no standard field_def deal.${field}`);
    await observer.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [TENANT_A, fieldId, permissionSet(TENANT_A, setKey), level],
    );
  }

  // --- expectations from the database (ground truth as kasuwa_migrator) -----

  const byNameThenId = (a: Json, b: Json) => {
    const an = String(a.name);
    const bn = String(b.name);
    if (an !== bn) return an < bn ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  };

  /**
   * PipelineSummary rows of these programmes, name then id. This suite's names
   * are chosen so that code-point and en_US orders agree.
   */
  async function dbSummaries(programmeIds: readonly string[]): Promise<Json[]> {
    const result = await observer.query<{
      id: string;
      programme_id: string;
      name: string;
      version: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, programme_id, name, version, created_at, updated_at
         FROM pipeline WHERE programme_id = ANY ($1::uuid[])`,
      [programmeIds],
    );
    return result.rows
      .map((row) => ({
        id: row.id,
        programmeId: row.programme_id,
        name: row.name,
        version: row.version,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }))
      .sort(byNameThenId);
  }

  const normaliseSummary = (row: Json): Json => ({
    ...row,
    createdAt: iso(Date.parse(String(row.createdAt))),
    updatedAt: iso(Date.parse(String(row.updatedAt))),
  });

  const camel = (snake: string) => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const pairKey = (pair: Json) => `${String(pair.fromStageId)}>${String(pair.toStageId)}`;
  const byPair = (a: Json, b: Json) => (pairKey(a) < pairKey(b) ? -1 : 1);

  /** The Pipeline the contract says getPipeline serves, read from the tables. */
  async function dbPipeline(id: string): Promise<Json> {
    const head = await observer.query<{
      programme_id: string;
      name: string;
      version: number;
      created_at: Date;
      updated_at: Date;
    }>(
      'SELECT programme_id, name, version, created_at, updated_at FROM pipeline WHERE id = $1',
      [id],
    );
    const row = head.rows[0];
    if (row === undefined) throw new Error(`no pipeline ${id}`);
    const stages = await observer.query<{
      id: string;
      name: string;
      kind: string;
      position: number;
      probability_bp: number;
      rotting_after_days: number | null;
    }>(
      `SELECT id, name, kind, position, probability_bp, rotting_after_days
         FROM pipeline_stage WHERE pipeline_id = $1 ORDER BY position`,
      [id],
    );
    const requirements = await observer.query<{
      id: string;
      stage_id: string;
      kind: string;
      field: string | null;
      label: string | null;
    }>(
      `SELECT id, stage_id, kind, field, label FROM pipeline_stage_requirement
        WHERE pipeline_id = $1 ORDER BY position`,
      [id],
    );
    const transitions = await observer.query<{ from_stage_id: string; to_stage_id: string }>(
      'SELECT from_stage_id, to_stage_id FROM pipeline_stage_transition WHERE pipeline_id = $1',
      [id],
    );
    return {
      id,
      programmeId: row.programme_id,
      name: row.name,
      version: row.version,
      stages: stages.rows.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        position: s.position,
        probabilityBp: s.probability_bp,
        rottingAfterDays: s.rotting_after_days,
        requirements: requirements.rows
          .filter((r) => r.stage_id === s.id)
          .map((r) =>
            r.kind === 'field'
              ? { id: r.id, kind: 'field', field: camel(String(r.field)) }
              : { id: r.id, kind: 'check', label: r.label },
          ),
      })),
      transitions: transitions.rows
        .map((t) => ({ fromStageId: t.from_stage_id, toStageId: t.to_stage_id }))
        .sort(byPair),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  const normalisePipeline = (value: Json): Json => ({
    ...value,
    transitions: [...arr(value.transitions)].sort(byPair),
    createdAt: iso(Date.parse(String(value.createdAt))),
    updatedAt: iso(Date.parse(String(value.updatedAt))),
  });

  /** A pipeline without ids or times, transitions by stage position (the template check). */
  function shapeOf(value: Json): Json {
    const stages = arr(value.stages);
    const positionOf = new Map(stages.map((s) => [String(s.id), Number(s.position)]));
    return {
      name: value.name,
      version: value.version,
      stages: stages.map((s) => ({
        name: s.name,
        kind: s.kind,
        position: s.position,
        probabilityBp: s.probabilityBp,
        rottingAfterDays: s.rottingAfterDays,
        requirements: arr(s.requirements).map((r) => {
          const copy: Json = { ...r };
          delete copy.id;
          return copy;
        }),
      })),
      transitions: arr(value.transitions)
        .map(
          (t) =>
            `${String(positionOf.get(String(t.fromStageId)))}>${String(positionOf.get(String(t.toStageId)))}`,
        )
        .sort(),
    };
  }

  // --- board expectations ----------------------------------------------------

  interface BoardOptions {
    limit?: number;
    withheld?: readonly string[];
  }

  /** A whole board, against the model. */
  function expectBoard(
    response: request.Response,
    filters: Filters,
    where: string,
    options: BoardOptions = {},
  ): Json {
    expectStatus(response, 200, where);
    expectNoStore(response, where);
    expect(boardProblems(response.body, where), `${where}: PipelineBoard`).toEqual([]);
    const body = response.body as Json;
    const limit = options.limit ?? 20;
    const withheld = options.withheld ?? [];
    expect(body.pipelineId, `${where}: pipelineId`).toBe(BOARD_ID);
    expect(strings(body.withheldFields).sort(), `${where}: withheldFields`).toEqual(
      [...withheld].sort(),
    );
    const stages = arr(body.stages);
    expect(
      stages.map((entry) => entry.stageId),
      `${where}: one column per open stage then won, in position order; lost is not a column`,
    ).toEqual(COLUMNS.map((key) => stage(key).id));
    COLUMNS.forEach((key, index) => {
      const entry = stages[index] ?? {};
      const want = expectedColumn(key, filters);
      const at = `${where} ${key}`;
      expect(entry.count, `${at}: count over the whole stage`).toBe(want.count);
      if (withheld.includes('amount')) {
        expect('totals' in entry, `${at}: totals omitted while amount is withheld`).toBe(false);
      } else {
        expect(entry.totals, `${at}: totals`).toEqual(want.totals);
      }
      expect(
        arr(entry.cards).map((card) => card.id),
        `${at}: the first ${limit} cards in order`,
      ).toEqual(want.order.slice(0, limit));
      if (want.order.length > limit) {
        expect(typeof entry.nextCursor, `${at}: more cards follow, so a nextCursor`).toBe(
          'string',
        );
      } else if (want.order.length < limit) {
        expect(entry.nextCursor, `${at}: no card follows (R10)`).toBeNull();
      }
    });
    return body;
  }

  function column(body: Json, key: StageKey): Json {
    const found = arr(body.stages).find((candidate) => candidate.stageId === stage(key).id);
    if (found === undefined) throw new Error(`no column ${key}`);
    return found;
  }

  /** The control every board test opens with. On main the route is a 404. */
  async function servedBoard(headers: Headers = AGENT_1, params: Params = []) {
    const response = await board(headers, BOARD_ID, params);
    expectStatus(response, 200, 'control: getPipelineBoard is served');
    return response;
  }

  /** Walks one column with stageId + cursor; returns every card id and every column seen. */
  async function walkColumn(
    headers: Headers,
    key: StageKey,
    limit: number,
    params: Params = [],
  ): Promise<{ ids: string[]; columns: Json[] }> {
    const ids: string[] = [];
    const columns: Json[] = [];
    const first = await board(headers, BOARD_ID, [...params, ['limit', String(limit)]]);
    expectStatus(first, 200, `${key} first page`);
    let current = column(first.body as Json, key);
    let pages = 0;
    for (;;) {
      columns.push(current);
      const cards = arr(current.cards);
      ids.push(...cards.map((card) => String(card.id)));
      const next = current.nextCursor;
      if (typeof next !== 'string') break;
      expect(cards.length, `${key}: a page with a nextCursor is full`).toBe(limit);
      const response = await board(headers, BOARD_ID, [
        ...params,
        ['limit', String(limit)],
        ['stageId', stage(key).id],
        ['cursor', next],
      ]);
      const where = `${key} page ${pages + 2} at limit ${limit}`;
      expectStatus(response, 200, where);
      expectNoStore(response, where);
      expect(boardProblems(response.body, where)).toEqual([]);
      const stages = arr((response.body as Json).stages);
      expect(
        stages.map((entry) => entry.stageId),
        `${where}: only that column`,
      ).toEqual([stage(key).id]);
      current = stages[0] ?? {};
      pages += 1;
      if (pages > 60) throw new Error('paging did not terminate');
    }
    expect(new Set(ids).size, `${key}: a card repeated across pages`).toBe(ids.length);
    return { ids, columns };
  }

  const stripClosedSince = (value: Json): Json => ({ ...value, closedSince: null });

  // =========================================================================
  // 0. Self-checks: this file's own helpers, against the contract's examples.
  // =========================================================================

  describe('(self-check) the helpers this suite judges the server with', () => {
    it('(self-check) halfEven rounds half to even, the model differs from half-up and end-rounding, and the contract’s board example agrees', () => {
      expect(halfEven(25n, 1000)).toBe(2n);
      expect(halfEven(35n, 1000)).toBe(4n);
      expect(halfEven(15n, 1000)).toBe(2n);
      expect(halfEven(2n, 2500)).toBe(0n);
      expect(halfEven(6n, 2500)).toBe(2n);
      expect(halfEven(10n, 2500)).toBe(2n);
      expect(halfEven(BigInt(NINES_5), 1000)).toBe(100000000000000000n);
      expect(halfEven(BigInt(NINES_85), 1000)).toBe(99999999999999998n);
      expect(halfEven(7n, 10000)).toBe(7n);

      const s0 = expectedColumn('S0', {});
      const ngn = s0.totals.find((total) => total.currency === 'NGN');
      expect(ngn?.weightedAmountMinor).toBe('1500000000000000002');
      expect(ngn?.weightedAmountMinor, 'half-up per deal').not.toBe('1500000000000000009');
      expect(ngn?.weightedAmountMinor, 'rounded once at the end').not.toBe('1500000000000000000');
      expect(BigInt(ngn?.amountMinor ?? '0') > 9223372036854775807n, 'beyond int8').toBe(true);
      expect(s0.totals.map((total) => total.currency)).toEqual(['GHS', 'NGN']);
      expect(s0.count).toBe(25);
      expect(expectedColumn('S2', {})).toMatchObject({ count: 0, totals: [], order: [] });
      expect(expectedColumn('SW', {}).order).toEqual([d(45), d(41), d(42)]);
      expect(expectedColumn('SW', { windowDays: 120 }).order).toEqual([
        d(45),
        d(41),
        d(42),
        d(43),
      ]);
      expect(
        columnOrder('S0', {})
          .map((spec) => spec.id)
          .slice(14, 20),
        'the tie at 2.5 days, by id, ends the first page at d(1)',
      ).toEqual([d(3), d(2), d(17), d(18), d(19), d(1)]);
      expect(rottingOf(deal(d(7)))).toBe('stale');
      expect(rottingOf(deal(d(6)))).toBe('fresh');
      expect(rottingOf(deal(d(32)))).toBe('stale');

      const pipeline = okExample('getPipeline');
      const bpOf = new Map(
        arr(pipeline.stages).map((s) => [String(s.id), Number(s.probabilityBp)]),
      );
      const example = okExample('getPipelineBoard', 'board');
      const nextPage = okExample('getPipelineBoard', 'oneColumn');
      const extra = arr(nextPage.stages).flatMap((entry) => arr(entry.cards));
      for (const entry of arr(example.stages)) {
        const bp = bpOf.get(String(entry.stageId));
        if (bp === undefined) throw new Error('example stage not in the getPipeline example');
        const cards = [
          ...arr(entry.cards),
          ...extra.filter((card) => card.stageId === entry.stageId),
        ];
        expect(cards.length, `example ${String(entry.stageId)}: all cards known`).toBe(
          entry.count,
        );
        const sums = new Map<string, { a: bigint; w: bigint }>();
        for (const card of cards) {
          if (card.amount === null) continue;
          const money = card.amount as Json;
          const weighted = halfEven(BigInt(String(money.amountMinor)), bp);
          expect((card.weightedAmount as Json).amountMinor).toBe(weighted.toString());
          const sum = sums.get(String(money.currency)) ?? { a: 0n, w: 0n };
          sum.a += BigInt(String(money.amountMinor));
          sum.w += weighted;
          sums.set(String(money.currency), sum);
        }
        expect(entry.totals).toEqual(
          [...sums.entries()]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([currency, s]) => ({
              currency,
              amountMinor: s.a.toString(),
              weightedAmountMinor: s.w.toString(),
            })),
        );
      }
    });

    it('(self-check) the board checker accepts the contract’s three examples and rejects broken boards', () => {
      for (const name of ['board', 'oneColumn', 'amountWithheld']) {
        expect(boardProblems(okExample('getPipelineBoard', name), name), name).toEqual([]);
      }
      expect(
        schemaErrors(okSchema('getPipeline'), okExample('getPipeline'), 'getPipeline example'),
      ).toEqual([]);
      expect(
        schemaErrors(
          okSchema('listPipelines'),
          okExample('listPipelines'),
          'listPipelines example',
        ),
      ).toEqual([]);

      const broken: [string, Json][] = [];
      const noTotals = okExample('getPipelineBoard', 'board');
      delete (arr(noTotals.stages)[0] ?? {}).totals;
      broken.push(['totals missing while amount is readable', noTotals]);
      const withheldTotals = okExample('getPipelineBoard', 'amountWithheld');
      (arr(withheldTotals.stages)[1] ?? {}).totals = [];
      broken.push(['totals present while amount is withheld', withheldTotals]);
      const numeric = okExample('getPipelineBoard', 'board');
      const firstCard = arr((arr(numeric.stages)[0] ?? {}).cards)[0] ?? {};
      firstCard.amount = { amountMinor: 3100000005, currency: 'NGN' };
      broken.push(['amountMinor as a JSON number', numeric]);
      const numericTotal = okExample('getPipelineBoard', 'board');
      (arr((arr(numericTotal.stages)[0] ?? {}).totals)[0] ?? {}).amountMinor = 3660000030;
      broken.push(['a total as a JSON number', numericTotal]);
      const extraKey = okExample('getPipelineBoard', 'board');
      (arr(extraKey.stages)[0] ?? {}).total = 2;
      broken.push(['an extra property on a column', extraKey]);
      const noCount = okExample('getPipelineBoard', 'board');
      delete (arr(noCount.stages)[0] ?? {}).count;
      broken.push(['a column without count', noCount]);
      const listedButPresent = okExample('getPipelineBoard', 'board');
      const card = arr((arr(listedButPresent.stages)[0] ?? {}).cards)[0] ?? {};
      card.withheldFields = ['amount'];
      broken.push(['a card lists amount but carries it', listedButPresent]);
      const nulled = okExample('getPipelineBoard', 'amountWithheld');
      const withheldCard = arr((arr(nulled.stages)[0] ?? {}).cards)[0] ?? {};
      withheldCard.amount = null;
      broken.push(['a withheld amount nulled, not omitted', nulled]);
      for (const [label, value] of broken) {
        expect(boardProblems(value, label), label).not.toEqual([]);
      }
    });

    it('(self-check) the cursor checker accepts an id-only cursor and rejects names, times, stage ids and amounts', () => {
      const id = d(1);
      const bare = Buffer.from(id).toString('base64url');
      expect(cursorProblems(bare, id)).toEqual([]);
      expect(
        cursorProblems(Buffer.from(JSON.stringify({ i: id, v: 1 })).toString('base64url'), id),
      ).toEqual([]);
      const bad = [
        { i: id, n: 'T0107 card 01' },
        { i: id, t: iso(Date.now()) },
        { i: id, s: stage('S0').id },
        { i: id, a: NINES_5 },
        { i: id, e: Date.now() },
        { s: stage('S0').id },
      ];
      for (const payload of bad) {
        expect(
          cursorProblems(Buffer.from(JSON.stringify(payload)).toString('base64url'), id),
          JSON.stringify(payload),
        ).not.toEqual([]);
      }
      expect(cursorProblems('not base64!', id)).not.toEqual([]);
      expect(Buffer.from(repoint(bare, id, NOWHERE), 'base64url').toString('utf8')).toBe(NOWHERE);
    });

    it('(self-check) the plan checker refuses a Sort, a Seq Scan, a non-board index and a scan-sized page, and accepts a board seek', () => {
      const seek: PlanNode = {
        'Node Type': 'Limit',
        Plans: [
          {
            'Node Type': 'Index Scan',
            'Relation Name': 'deal',
            'Index Name': 'deal_board_open_idx',
            'Actual Rows': 21,
            'Actual Loops': 1,
          },
        ],
      };
      expect(planProblems(seek).problems).toEqual([]);
      expect([...planProblems(seek).indexes]).toEqual(['deal_board_open_idx']);
      const sorted: PlanNode = {
        'Node Type': 'Limit',
        Plans: [
          {
            'Node Type': 'Sort',
            Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'deal', 'Actual Rows': 9000 }],
          },
        ],
      };
      expect(planProblems(sorted).problems.length).toBeGreaterThanOrEqual(3);
      const otherIndex: PlanNode = {
        'Node Type': 'Index Scan',
        'Relation Name': 'deal',
        'Index Name': 'deal_owner_idx',
        'Actual Rows': 21,
      };
      expect(planProblems(otherIndex).problems).not.toEqual([]);
      const filtering: PlanNode = {
        'Node Type': 'Index Scan',
        'Relation Name': 'deal',
        'Index Name': 'deal_board_open_idx',
        'Actual Rows': 20,
        'Rows Removed by Filter': 2000,
      };
      expect(planProblems(filtering).problems).not.toEqual([]);
      const inCte: PlanNode = {
        'Node Type': 'CTE Scan',
        Plans: [
          {
            'Node Type': 'Index Scan',
            'Relation Name': 'deal',
            'Index Name': 'deal_board_open_idx',
            'Parent Relationship': 'InitPlan',
            'Actual Rows': 21,
          },
        ],
      };
      expect(planProblems(inCte).problems).toContain('no outer scan of deal in the plan');
      expect(isCardStatement('SELECT id FROM deal d WHERE x ORDER BY a LIMIT 21')).toBe(true);
      expect(isCardStatement('SELECT count(*) FROM deal WHERE x')).toBe(false);
      expect(isCardStatement('SELECT * FROM deal_requirement_check ORDER BY a LIMIT 1')).toBe(
        false,
      );
    });
  });

  // =========================================================================
  // 1. The flags (F1). Fails on main: all three are false.
  // =========================================================================

  describe('the contract records the three reads as served (F1)', () => {
    it('listPipelines, getPipeline and getPipelineBoard are x-kasuwa-implemented: true', () => {
      const problems = ['listPipelines', 'getPipeline', 'getPipelineBoard']
        .filter((id) => requireOperation(id).op['x-kasuwa-implemented'] !== true)
        .map((id) => `${id} is not x-kasuwa-implemented: true`);
      expect(problems).toEqual([]);
    });
  });

  // =========================================================================
  // 2. Functional tests. Every one reseeds after itself.
  // =========================================================================

  describe('served over the real API and Postgres', () => {
    afterEach(async () => {
      stopRecording();
      await reseed(inject('migrationUrl'));
    });

    // -----------------------------------------------------------------------
    // listPipelines
    // -----------------------------------------------------------------------

    describe('listPipelines: only the programmes the session reaches (I3, R13, R14)', () => {
      async function readAll(headers: Headers, params: Params = [], where = 'listPipelines') {
        const response = await listPipelines(headers, [...params, ['limit', '100']]);
        expectStatus(response, 200, where);
        expectNoStore(response, where);
        expect(schemaErrors(okSchema('listPipelines'), response.body, where)).toEqual([]);
        const body = response.body as Json;
        expect(Object.keys(body).sort(), `${where}: page keys (no count, D-P13)`).toEqual([
          'data',
          'nextCursor',
        ]);
        expect(body.nextCursor, `${where}: fewer than 100 rows`).toBeNull();
        return arr(body.data).map(normaliseSummary);
      }

      it('an agent sees exactly A1’s pipelines, by name then id; never A2’s or tenant B’s', async () => {
        await plantBoard();
        await plantTwins();
        const rows = await readAll(AGENT_1);
        const expected = await dbSummaries([PROGRAMME_A1]);
        expect(expected.map((row) => row.id)).toEqual(
          expect.arrayContaining([BOARD_ID, TWIN_1, TWIN_2]),
        );
        expect(rows).toEqual(expected);
        const outside = await dbSummaries([PROGRAMME_A2, PROGRAMME_B1, PROGRAMME_B2]);
        expect(outside.length, 'vacuous unless the other programmes have pipelines').toBe(3);
        const ids = new Set(rows.map((row) => row.id));
        expect(outside.filter((row) => ids.has(row.id))).toEqual([]);
      });

      it('the supervisor sees A1 and A2 (a BPO tenant, two programmes); tenant B sees B1 only, not B2', async () => {
        await plantTwins();
        expect(await readAll(SUPERVISOR)).toEqual(
          await dbSummaries([PROGRAMME_A1, PROGRAMME_A2]),
        );
        expect(await readAll(AGENT_2)).toEqual(await dbSummaries([PROGRAMME_A2]));
        expect(await readAll(TENANT_B_ADMIN)).toEqual(await dbSummaries([PROGRAMME_B1]));
      });

      it('unknown parameters neither narrow nor widen: programmeId, tenantId and programmeIds are ignored', async () => {
        await plantTwins();
        const supervisorPlain = await readAll(SUPERVISOR);
        expect(
          await readAll(SUPERVISOR, [['programmeId', PROGRAMME_A1]], 'programmeId=A1'),
          'programmeId=A1 must not narrow (R13)',
        ).toEqual(supervisorPlain);
        const agentPlain = await readAll(AGENT_1);
        expect(
          await readAll(
            AGENT_1,
            [
              ['programmeId', PROGRAMME_A2],
              ['tenantId', TENANT_B],
              ['programmeIds', `${PROGRAMME_A1},${PROGRAMME_A2}`],
            ],
            'widening attempts',
          ),
        ).toEqual(agentPlain);
      });

      it('a programme without a pipeline lists none (200, empty) and the read repairs nothing; no programme and client_portal list nothing', async () => {
        await readAll(AGENT_2, [], 'control');
        const a2 = await defaultPipeline(PROGRAMME_A2);
        await observer.query('DELETE FROM pipeline WHERE id = $1', [a2.id]);
        const empty = await listPipelines(AGENT_2);
        expectStatus(empty, 200, 'A2 without a pipeline');
        expectNoStore(empty, 'A2 without a pipeline');
        expect(empty.body).toEqual({ data: [], nextCursor: null });
        expect(await readAll(SUPERVISOR)).toEqual(await dbSummaries([PROGRAMME_A1]));
        const left = await observer.query<{ n: string }>(
          'SELECT count(*) AS n FROM pipeline WHERE programme_id = $1',
          [PROGRAMME_A2],
        );
        expect(Number(left.rows[0]?.n), 'a read never creates a pipeline (R14)').toBe(0);

        const none = await listPipelines(NO_PROGRAMME);
        expectStatus(none, 200, 'no programme');
        expect(none.body).toEqual({ data: [], nextCursor: null });
        await assign(USER_A_AGENT_1, PROGRAMME_A1, 'client_portal');
        const portal = await listPipelines(AGENT_1);
        expectStatus(portal, 200, 'client_portal (D-L115)');
        expect(portal.body).toEqual({ data: [], nextCursor: null });
      });

      it('pages on id-only cursors at limit 1; default limit 25; out-of-range limits are 400 with no-store', async () => {
        await plantTwins();
        const expected = await dbSummaries([PROGRAMME_A1, PROGRAMME_A2]);
        const seen: Json[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const params: [string, string][] = [['limit', '1']];
          if (cursor !== null) params.push(['cursor', cursor]);
          const response = await listPipelines(SUPERVISOR, params);
          const where = `page ${pages + 1}`;
          expectStatus(response, 200, where);
          expectNoStore(response, where);
          expect(schemaErrors(okSchema('listPipelines'), response.body, where)).toEqual([]);
          const data = arr((response.body as Json).data);
          seen.push(...data.map(normaliseSummary));
          const next = (response.body as Json).nextCursor;
          cursor = typeof next === 'string' ? next : null;
          if (cursor !== null) {
            const last = data[data.length - 1];
            expect(data.length, `${where}: full page with a cursor`).toBe(1);
            expect(cursorProblems(cursor, String(last?.id)), `${where}: cursor (R7)`).toEqual([]);
          }
          pages += 1;
          if (pages > 20) throw new Error('paging did not terminate');
        } while (cursor !== null);
        expect(seen).toEqual(expected);

        for (let k = 3; k <= 27; k += 1) await plantSimplePipeline(k, `T0107 Many ${pad2(k)}`);
        const first = await listPipelines(AGENT_1);
        expectStatus(first, 200, 'default limit');
        expect(arr((first.body as Json).data).length, 'default limit 25').toBe(25);
        expect(typeof (first.body as Json).nextCursor).toBe('string');

        for (const limit of ['0', '101', 'x', '1.5', '-1']) {
          expectError(
            await listPipelines(AGENT_1, [['limit', limit]]),
            400,
            'validation_failed',
            `limit=${limit}`,
          );
        }
      });

      it('a cursor naming no pipeline the caller reaches is the same 400 invalid_cursor body as a malformed one (R9)', async () => {
        await plantTwins();
        const first = await listPipelines(AGENT_1, [['limit', '1']]);
        expectStatus(first, 200, 'control');
        const genuine = String((first.body as Json).nextCursor);
        const lastId = String(arr((first.body as Json).data)[0]?.id);
        expectStatus(
          await listPipelines(AGENT_1, [
            ['limit', '1'],
            ['cursor', genuine],
          ]),
          200,
          'genuine cursor',
        );
        const a2 = await defaultPipeline(PROGRAMME_A2);
        const b1 = await defaultPipeline(PROGRAMME_B1);
        const tampered: [string, string][] = [
          ['malformed', 'not-a-cursor!!'],
          ['garbage base64url', Buffer.from('{"x":').toString('base64url')],
          ['no such pipeline', repoint(genuine, lastId, NOWHERE)],
          ['another programme’s pipeline', repoint(genuine, lastId, a2.id)],
          ['another tenant’s pipeline', repoint(genuine, lastId, b1.id)],
        ];
        const bodies = new Set<string>();
        for (const [label, cursor] of tampered) {
          const response = await listPipelines(AGENT_1, [
            ['limit', '1'],
            ['cursor', cursor],
          ]);
          expectDetail(response, 'cursor', 'invalid_cursor', label);
          bodies.add(response.text);
        }
        expect(bodies.size, 'one body whatever the reason').toBe(1);
      });

      it('no session is 401 not_authenticated with no-store', async () => {
        expectStatus(await listPipelines(AGENT_1), 200, 'control');
        const response = await request(server()).get(PIPELINES);
        expectError(response, 401, 'not_authenticated', 'no session');
      });
    });

    // -----------------------------------------------------------------------
    // getPipeline
    // -----------------------------------------------------------------------

    describe('getPipeline: stages, requirements and transitions; one 404 (I2, I3, R4, R11, R12)', () => {
      async function readPipeline(headers: Headers, id: string, where: string): Promise<Json> {
        const response = await getPipeline(headers, id);
        expectStatus(response, 200, where);
        expectNoStore(response, where);
        expect(schemaErrors(okSchema('getPipeline'), response.body, where)).toEqual([]);
        return response.body as Json;
      }

      it('A1’s default pipeline is the template, served from its rows: stages and requirements in position order, camelCase fields, the seed transitions', async () => {
        const a1 = await defaultPipeline(PROGRAMME_A1);
        const served = await readPipeline(AGENT_1, a1.id, 'A1 default');
        expect(normalisePipeline(served)).toEqual(await dbPipeline(a1.id));
        expect(shapeOf(served), 'the contract’s getPipeline example is the template').toEqual(
          shapeOf(okExample('getPipeline')),
        );
      });

      it('a planted pipeline is served from its own rows, not from the template', async () => {
        await plantBoard();
        const served = await readPipeline(AGENT_1, BOARD_ID, 'planted');
        expect(normalisePipeline(served)).toEqual(await dbPipeline(BOARD_ID));
        const stages = arr(served.stages);
        expect(stages.map((s) => s.name)).toEqual(STAGES.map((s) => s.name));
        expect(arr(stages[2]?.requirements)).toEqual([
          { id: FIELD_REQ_NEXT, kind: 'field', field: 'nextStep' },
          { id: FIELD_REQ_ACCOUNT, kind: 'field', field: 'accountId' },
        ]);
        expect(arr(stages[1]?.requirements)).toEqual([
          { id: CHECK_REQ, kind: 'check', label: 'T0107 synthetic check' },
        ]);
        expect(arr(served.transitions)).toHaveLength(BOARD_TRANSITIONS.length);
        expect(stages[3]?.rottingAfterDays, 'won: null').toBeNull();
        expect(stages[0]?.rottingAfterDays).toBe(14);
      });

      it('one identical 404 body for no such id, another tenant’s, another programme’s, a non-uuid, a stage id, a deal id and injection text', async () => {
        await plantBoard();
        const a1 = await defaultPipeline(PROGRAMME_A1);
        await readPipeline(AGENT_1, a1.id, 'control');
        const a2 = await defaultPipeline(PROGRAMME_A2);
        const b1 = await defaultPipeline(PROGRAMME_B1);
        const probes: [string, string][] = [
          ['no such pipeline', NOWHERE],
          ['another tenant’s', b1.id],
          ['another programme’s', a2.id],
          ['not a uuid', 'not-a-uuid'],
          ['a stage id', stage('S0').id],
          ['a deal id', SEEDED_DEAL.id],
          ['injection text', "1' OR '1'='1"],
          ['over-long', 'x'.repeat(300)],
        ];
        const bodies = new Set<string>();
        for (const [label, id] of probes) {
          const response = await getPipeline(AGENT_1, id);
          expectError(response, 404, 'not_found', label);
          bodies.add(response.text);
        }
        for (const [label, headers] of [
          ['no programme', NO_PROGRAMME],
          ['agent 2 (A2 only)', AGENT_2],
          ['tenant B', TENANT_B_ADMIN],
        ] as const) {
          const response = await getPipeline(headers, a1.id);
          expectError(response, 404, 'not_found', label);
          bodies.add(response.text);
        }
        expect(bodies.size, 'one 404 body, byte for byte (R4)').toBe(1);
      });

      it('client_portal reads no pipeline (D-L115); tenant B reads B1’s but not B2’s', async () => {
        const a1 = await defaultPipeline(PROGRAMME_A1);
        await readPipeline(AGENT_1, a1.id, 'control');
        const plain404 = await getPipeline(AGENT_1, NOWHERE);
        expectError(plain404, 404, 'not_found', 'nowhere');
        await assign(USER_A_AGENT_1, PROGRAMME_A1, 'client_portal');
        const portal = await getPipeline(AGENT_1, a1.id);
        expectError(portal, 404, 'not_found', 'client_portal');
        expect(portal.text).toBe(plain404.text);
        const b1 = await defaultPipeline(PROGRAMME_B1);
        const b2 = await defaultPipeline(PROGRAMME_B2);
        await readPipeline(TENANT_B_ADMIN, b1.id, 'B1');
        const other = await getPipeline(TENANT_B_ADMIN, b2.id);
        expectError(other, 404, 'not_found', 'B2');
        expect(other.text).toBe(plain404.text);
      });
    });

    // -----------------------------------------------------------------------
    // getPipelineBoard
    // -----------------------------------------------------------------------

    describe('getPipelineBoard: counts, totals and cards (I4, D-P19)', () => {
      it('the whole board: open stages then won, no lost; exact count and per-currency totals; an empty column; closedSince echoed', async () => {
        await plantBoard();
        const before = Date.now();
        // limit 50: the unpriced S0 cards below sort after position 20; the default limit has its own test (D-L125).
        const response = await servedBoard(AGENT_1, [['limit', '50']]);
        const after = Date.now();
        const body = expectBoard(response, {}, 'whole board', { limit: 50 });
        const closedSince = Date.parse(String(body.closedSince));
        expect(
          closedSince,
          'default closedSince ~ 90 days before the request (R6)',
        ).toBeGreaterThanOrEqual(before - 90 * DAY - SKEW);
        expect(closedSince).toBeLessThanOrEqual(after - 90 * DAY + SKEW);
        expect(column(body, 'S2')).toEqual({
          stageId: stage('S2').id,
          count: 0,
          totals: [],
          cards: [],
          nextCursor: null,
        });
        // A deal with no amount is counted and adds to no total.
        expect(column(body, 'S0').count).toBe(25);
        const unpriced = arr(column(body, 'S0').cards).filter((card) => card.amount === null);
        expect(unpriced.map((card) => card.id).sort()).toEqual([d(24), d(25)].sort());
      });

      it('more than a page: 25 deals at the default limit of 20; the column pages on stageId and cursor, its count and totals still for the whole stage', async () => {
        await plantBoard();
        const whole = expectBoard(await servedBoard(), {}, 'first page');
        const s0 = column(whole, 'S0');
        expect(arr(s0.cards)).toHaveLength(20);
        const next = await board(AGENT_1, BOARD_ID, [
          ['stageId', stage('S0').id],
          ['cursor', String(s0.nextCursor)],
        ]);
        expectStatus(next, 200, 'S0 page 2');
        expectNoStore(next, 'S0 page 2');
        expect(boardProblems(next.body, 'S0 page 2')).toEqual([]);
        const body = next.body as Json;
        expect(body.pipelineId).toBe(BOARD_ID);
        const stages = arr(body.stages);
        expect(stages).toHaveLength(1);
        const page2 = stages[0] ?? {};
        expect(page2.stageId).toBe(stage('S0').id);
        expect(page2.count).toBe(25);
        expect(page2.totals).toEqual(s0.totals);
        const want = expectedColumn('S0', {});
        expect(arr(page2.cards).map((card) => card.id)).toEqual(want.order.slice(20));
        expect(page2.nextCursor).toBeNull();

        // A tie straddling the page boundary (limit 17 ends inside it), and a small limit.
        for (const limit of [17, 3]) {
          const walked = await walkColumn(AGENT_1, 'S0', limit);
          expect(walked.ids, `S0 at limit ${limit}`).toEqual(want.order);
          for (const entry of walked.columns) {
            expect(entry.count).toBe(25);
            expect(entry.totals).toEqual(want.totals);
          }
        }
        // The won column pages too, newest first, ties by id descending.
        const won = await walkColumn(AGENT_1, 'SW', 1, [
          ['closedSince', iso(Date.now() - 365 * DAY)],
        ]);
        expect(won.ids).toEqual([d(45), d(41), d(42), d(43)]);
      });

      it('money leaves as strings: amounts above 2^53 exact on cards, totals beyond the int8 range exact, no precision loss and no bigint crash', async () => {
        await plantBoard();
        const response = await servedBoard();
        const body = expectBoard(response, {}, 'money');
        const s0 = column(body, 'S0');
        const ngn = arr(s0.totals).find((total) => total.currency === 'NGN');
        const ghs = arr(s0.totals).find((total) => total.currency === 'GHS');
        const expectedNgn = (12n * BigInt(NINES_5) + 4n * 25n + 3n * BigInt(NINES_85)).toString();
        expect(ngn?.amountMinor).toBe(expectedNgn);
        expect(BigInt(String(ngn?.amountMinor)) > 9223372036854775807n).toBe(true);
        expect(ghs?.amountMinor).toBe((3n * 35n + BigInt(BIG_GHS)).toString());
        expect(response.text, 'the exact digits on the wire').toContain(
          `"amountMinor":"${NINES_5}"`,
        );
        expect(response.text).toContain(`"amountMinor":"${BIG_GHS}"`);
        expect(response.text).toContain(`"amountMinor":"${expectedNgn}"`);
        for (const card of arr(s0.cards)) {
          if (card.amount === null) continue;
          expect(typeof (card.amount as Json).amountMinor, 'a string, never a number').toBe(
            'string',
          );
        }
      });

      it('weighted totals are rounded half-even per deal, then summed, one total per currency, never across currencies', async () => {
        await plantBoard();
        // limit 50: d(20) is the newest S0 card, past the default page of 20 (D-L125).
        const body = expectBoard(await servedBoard(AGENT_1, [['limit', '50']]), {}, 'weighted', {
          limit: 50,
        });
        expect(column(body, 'S0').totals).toEqual([
          {
            currency: 'GHS',
            amountMinor: (105n + BigInt(BIG_GHS)).toString(),
            weightedAmountMinor: '90071992547409942',
          },
          {
            currency: 'NGN',
            amountMinor: (12n * BigInt(NINES_5) + 100n + 3n * BigInt(NINES_85)).toString(),
            weightedAmountMinor: '1500000000000000002',
          },
        ]);
        expect(column(body, 'S1').totals, 'an amount of 0 is an amount (R23)').toEqual([
          { currency: 'KES', amountMinor: '0', weightedAmountMinor: '0' },
          { currency: 'NGN', amountMinor: '18', weightedAmountMinor: '4' },
        ]);
        expect(column(body, 'SW').totals).toEqual([
          { currency: 'NGN', amountMinor: '1011', weightedAmountMinor: '1011' },
          { currency: 'ZAR', amountMinor: '5', weightedAmountMinor: '5' },
        ]);
        const weightedOf = (id: string) =>
          (
            (arr(column(body, deal(id).stage).cards).find((card) => card.id === id)
              ?.weightedAmount ?? {}) as Json
          ).amountMinor;
        expect(weightedOf(d(13)), '2.5 rounds to 2').toBe('2');
        expect(weightedOf(d(17)), 'x.5 on an even x stays').toBe('99999999999999998');
        expect(weightedOf(d(1)), 'x.5 on an odd x rounds up').toBe('100000000000000000');
        expect(weightedOf(d(20)), '3.5 rounds to 4').toBe('4');
      });

      it('cards are Deal rows: order, rotting from the stage’s days, weighted amount, owner (a former owner unnamed), contact, account, checks, version', async () => {
        await plantBoard();
        const body = expectBoard(await servedBoard(SUPERVISOR, [['limit', '50']]), {}, 'cards', {
          limit: 50,
        });
        for (const key of COLUMNS) {
          const cards = arr(column(body, key).cards);
          const want = columnOrder(key, {});
          expect(cards.map(normaliseCard), `${key} cards`).toEqual(
            want.map((spec) => expectedCard(spec, T0, [])),
          );
        }
        const rot = (id: string) =>
          arr(column(body, deal(id).stage).cards).find((card) => card.id === id)?.rotting;
        expect([rot(d(6)), rot(d(7)), rot(d(14))], 'S0, 14 days').toEqual([
          'fresh',
          'stale',
          'rotting',
        ]);
        expect([rot(d(34)), rot(d(32)), rot(d(33))], 'S1, 10 days').toEqual([
          'fresh',
          'stale',
          'rotting',
        ]);
        expect(rot(d(41)), 'won').toBeNull();
      });

      it('a former checker is unnamed, judged per check in the deal’s programme at read time: removed, a member elsewhere, the tenant-admin flag; a member keeps the name (R17, T-0123)', async () => {
        await plantBoard();
        // d(33) is ticked by the supervisor (plantBoard). Two more ticks of the S1
        // requirement: agent 2, a member of A2 only (which the supervisor also
        // reaches), on d(31); agent 1, an A1 member, on d(32).
        await plantBoardCheck(id107('a0000402'), d(31), USER_A_AGENT_2, T0 - 2 * DAY);
        await plantBoardCheck(id107('a0000403'), d(32), USER_A_AGENT_1, T0 - 3 * DAY);
        const read = async (headers: Headers, where: string) => {
          const response = await servedBoard(headers, [['limit', '50']]);
          expect(boardProblems(response.body, where), `${where}: board shape`).toEqual([]);
          const s1 = arr(column(response.body as Json, 'S1').cards);
          // A missing card yields [], which fails every expectation below (never vacuous).
          const by = (id: string) =>
            arr(s1.find((card) => card.id === id)?.checks).map((entry) => entry.checkedBy);
          return { text: response.text, d31: by(d(31)), d32: by(d(32)), d33: by(d(33)) };
        };
        const named = (userId: string) => ({ id: userId, displayName: userName(userId) });
        const unnamed = (userId: string) => ({ id: userId, displayName: null });

        // The supervisor reads, and shares A2 with agent 2: agent 2 is still no A1 member.
        const shared = await read(SUPERVISOR, 'read by the supervisor');
        expect(shared.d33, 'an A1 member is named').toEqual([named(USER_A_SUPERVISOR)]);
        expect(shared.d32, 'an A1 member is named').toEqual([named(USER_A_AGENT_1)]);
        expect(
          shared.d31,
          'a member of another programme, even one the reader reaches, is unnamed',
        ).toEqual([unnamed(USER_A_AGENT_2)]);
        expect(shared.text, 'agent 2’s name nowhere in the body').not.toContain(
          userName(USER_A_AGENT_2),
        );

        // The supervisor leaves A1. Still a tenant admin and an A2 member: not an A1 member.
        await unassign(USER_A_SUPERVISOR, PROGRAMME_A1);
        const left = await read(AGENT_1, 'after the supervisor left A1');
        expect(left.d33, 'a checker who left the programme is unnamed, the id kept').toEqual([
          unnamed(USER_A_SUPERVISOR),
        ]);
        expect(left.d32, 'a member is still named').toEqual([named(USER_A_AGENT_1)]);
        expect(left.d31).toEqual([unnamed(USER_A_AGENT_2)]);
        expect(left.text, 'the former checker’s name nowhere in the body').not.toContain(
          userName(USER_A_SUPERVISOR),
        );

        // Re-added: named again. Judged at read time, never a snapshot taken at removal.
        await assign(USER_A_SUPERVISOR, PROGRAMME_A1, 'admin');
        const back = await read(AGENT_1, 'after the supervisor rejoined A1');
        expect(back.d33, 'a member again, named again').toEqual([named(USER_A_SUPERVISOR)]);
      });

      it('won honours closedSince (default 90 days, sent values echoed); open columns ignore it; lost deals are on no column', async () => {
        await plantBoard();
        expectBoard(await servedBoard(), {}, 'default window');
        for (const days of [120, 365]) {
          const sent = iso(Date.now() - days * DAY);
          const response = await board(AGENT_1, BOARD_ID, [
            ['closedSince', sent],
            ['limit', '50'],
          ]);
          const body = expectBoard(response, { windowDays: days }, `closedSince ${days} days`, {
            limit: 50,
          });
          expect(Date.parse(String(body.closedSince)), 'echoed (R6)').toBe(Date.parse(sent));
        }
        const recent = iso(Date.now() - 30 * DAY);
        const body = expectBoard(
          await board(AGENT_1, BOARD_ID, [
            ['closedSince', recent],
            ['limit', '50'],
          ]),
          { windowDays: 30 },
          'closedSince 30 days',
          { limit: 50 },
        );
        expect(arr(column(body, 'SW').cards).map((card) => card.id)).toEqual([d(45), d(41)]);
        const everywhere = arr(body.stages).flatMap((entry) =>
          arr(entry.cards).map((card) => card.id),
        );
        expect(everywhere, 'a lost deal is never on the board (R2)').not.toContain(d(51));
      });

      it('closedSince is bounded: 367 days back is window_too_long, the future is invalid_window, a non-UTC or malformed value is 400; never clamped', async () => {
        await plantBoard();
        expectStatus(
          await board(AGENT_1, BOARD_ID, [['closedSince', iso(Date.now() - 365 * DAY)]]),
          200,
          'control: 365 days',
        );
        expectDetail(
          await board(AGENT_1, BOARD_ID, [['closedSince', iso(Date.now() - 367 * DAY)]]),
          'closedSince',
          'window_too_long',
          '367 days',
        );
        expectDetail(
          await board(AGENT_1, BOARD_ID, [['closedSince', iso(Date.now() + DAY)]]),
          'closedSince',
          'invalid_window',
          'tomorrow',
        );
        for (const value of ['2026-07-14T09:00:00+01:00', 'yesterday', '2026-07-14']) {
          expectError(
            await board(AGENT_1, BOARD_ID, [['closedSince', value]]),
            400,
            'validation_failed',
            `closedSince=${value}`,
          );
        }
      });
    });

    describe('getPipelineBoard: filters (I4, R19, R24)', () => {
      it('currency and owner filters narrow counts, totals and cards alike', async () => {
        await plantBoard();
        await servedBoard();
        const cases: [string, Params, Filters, Headers][] = [
          ['currency=GHS', [['currency', 'GHS']], { currency: ['GHS'] }, AGENT_1],
          [
            'currency=GHS&KES',
            [
              ['currency', 'GHS'],
              ['currency', 'KES'],
            ],
            { currency: ['GHS', 'KES'] },
            AGENT_1,
          ],
          ['owner=me (agent)', [['owner', 'me']], { owners: [USER_A_AGENT_1] }, AGENT_1],
          [
            'owner=me (supervisor)',
            [['owner', 'me']],
            { owners: [USER_A_SUPERVISOR] },
            SUPERVISOR,
          ],
          ['owner=unassigned', [['owner', 'unassigned']], { owners: ['unassigned'] }, AGENT_1],
          [
            'owner=<id>',
            [['owner', USER_A_SUPERVISOR]],
            { owners: [USER_A_SUPERVISOR] },
            AGENT_1,
          ],
          [
            'owner=me&unassigned',
            [
              ['owner', 'me'],
              ['owner', 'unassigned'],
            ],
            { owners: [USER_A_AGENT_1, 'unassigned'] },
            AGENT_1,
          ],
          [
            'currency=NGN&owner=me',
            [
              ['currency', 'NGN'],
              ['owner', 'me'],
            ],
            { currency: ['NGN'], owners: [USER_A_AGENT_1] },
            AGENT_1,
          ],
        ];
        for (const [label, params, filters, headers] of cases) {
          expectBoard(await board(headers, BOARD_ID, [...params, ['limit', '50']]), filters, label, {
            limit: 50,
          });
        }
      });

      it('closeFrom, closeTo and q: dates inclusive; q case- and diacritic-insensitive; % and _ match themselves', async () => {
        await plantBoard();
        await servedBoard();
        const cases: [string, Params, Filters][] = [
          [
            'closeFrom..closeTo',
            [
              ['closeFrom', '2031-03-04'],
              ['closeTo', '2031-03-07'],
            ],
            { closeFrom: '2031-03-04', closeTo: '2031-03-07' },
          ],
          ['closeFrom only', [['closeFrom', '2031-03-09']], { closeFrom: '2031-03-09' }],
          ['closeTo only', [['closeTo', '2031-03-02']], { closeTo: '2031-03-02' }],
          ['q=café', [['q', 'café']], { only: new Set([d(20), d(13)]) }],
          ['q=CAFE', [['q', 'CAFE']], { only: new Set([d(20), d(13)]) }],
          ['q=50%', [['q', '50%']], { only: new Set([d(21)]) }],
          ['q=_', [['q', '_']], { only: new Set([d(22)]) }],
          [
            'q=card 0',
            [['q', 'card 0']],
            { only: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9].map(d)) },
          ],
          [
            'q=won deal',
            [['q', 'won deal']],
            { only: new Set([d(41), d(42), d(43), d(44), d(45)]) },
          ],
          ['q=lost deal', [['q', 'lost deal']], { only: new Set<string>() }],
          [
            'q=card&currency=GHS',
            [
              ['q', 'card'],
              ['currency', 'GHS'],
            ],
            { only: new Set([d(23)]), currency: ['GHS'] },
          ],
        ];
        for (const [label, params, filters] of cases) {
          expectBoard(await board(AGENT_1, BOARD_ID, [...params, ['limit', '50']]), filters, label, {
            limit: 50,
          });
        }
      });

      it('bad filters are 400 with the contract’s codes: unknown_currency, invalid_window, unknown_reference (a lost stage, another pipeline’s, a non-uuid)', async () => {
        await plantBoard();
        await servedBoard();
        const a1 = await defaultPipeline(PROGRAMME_A1);
        const detailed: [string, Params, string, string][] = [
          ['USD', [['currency', 'USD']], 'currency', 'unknown_currency'],
          ['ngn', [['currency', 'ngn']], 'currency', 'unknown_currency'],
          [
            'closeTo before closeFrom',
            [
              ['closeFrom', '2031-03-07'],
              ['closeTo', '2031-03-04'],
            ],
            'closeTo',
            'invalid_window',
          ],
          ['the lost stage', [['stageId', stage('SL').id]], 'stageId', 'unknown_reference'],
          [
            'another pipeline’s stage',
            [['stageId', String(a1.stages[0]?.id)]],
            'stageId',
            'unknown_reference',
          ],
          ['no such stage', [['stageId', NOWHERE]], 'stageId', 'unknown_reference'],
          ['a non-uuid stage', [['stageId', 'not-a-uuid']], 'stageId', 'unknown_reference'],
        ];
        for (const [label, params, path, code] of detailed) {
          expectDetail(await board(AGENT_1, BOARD_ID, params), path, code, label);
        }
        const plainBad: [string, Params][] = [
          ['limit=0', [['limit', '0']]],
          ['limit=51', [['limit', '51']]],
          ['limit=x', [['limit', 'x']]],
          ['owner=bogus', [['owner', 'bogus']]],
          ['closeFrom=2031-02-30', [['closeFrom', '2031-02-30']]],
          ['q with NUL', [['q', 'card\u0000']]],
          ['q too long', [['q', 'x'.repeat(101)]]],
        ];
        for (const [label, params] of plainBad) {
          expectError(await board(AGENT_1, BOARD_ID, params), 400, 'validation_failed', label);
        }
      });
    });

    describe('getPipelineBoard: field security (I5, R21)', () => {
      it('amount withheld: totals omitted on every column, cards omit amount and weightedAmount, counts stay; a currency filter is 400 field_withheld', async () => {
        await plantBoard();
        expectBoard(await servedBoard(), {}, 'control: amount readable');
        await lockField('amount', 'agent', 'none');
        const body = expectBoard(
          await board(AGENT_1, BOARD_ID, [['limit', '50']]),
          {},
          'amount withheld',
          { limit: 50, withheld: ['amount'] },
        );
        for (const entry of arr(body.stages)) {
          for (const card of arr(entry.cards)) {
            expect('amount' in card || 'weightedAmount' in card, String(card.id)).toBe(false);
          }
        }
        expectDetail(
          await board(AGENT_1, BOARD_ID, [['currency', 'NGN']]),
          'currency',
          'field_withheld',
          'currency while withheld',
        );
        expectBoard(
          await board(AGENT_1, BOARD_ID, [['owner', 'me']]),
          { owners: [USER_A_AGENT_1] },
          'another filter still works',
          { withheld: ['amount'] },
        );
        // The locked admin set still sees totals in the same programme.
        expectBoard(await board(SUPERVISOR, BOARD_ID), {}, 'admin unaffected');
      });

      it('ownerUserId or expectedCloseDate withheld: the matching filter is 400 field_withheld at its parameter; totals stay', async () => {
        await plantBoard();
        expectBoard(
          await servedBoard(AGENT_1, [['owner', 'me']]),
          { owners: [USER_A_AGENT_1] },
          'control',
        );
        await lockField('owner_user_id', 'agent', 'none');
        expectBoard(await board(AGENT_1, BOARD_ID), {}, 'owner withheld', {
          withheld: ['ownerUserId'],
        });
        expectDetail(
          await board(AGENT_1, BOARD_ID, [['owner', 'me']]),
          'owner',
          'field_withheld',
          'owner=me',
        );
        expectDetail(
          await board(AGENT_1, BOARD_ID, [['owner', 'unassigned']]),
          'owner',
          'field_withheld',
          'owner=unassigned',
        );
        await lockField('expected_close_date', 'agent', 'none');
        expectDetail(
          await board(AGENT_1, BOARD_ID, [['closeFrom', '2031-03-01']]),
          'closeFrom',
          'field_withheld',
          'closeFrom',
        );
        expectDetail(
          await board(AGENT_1, BOARD_ID, [['closeTo', '2031-03-01']]),
          'closeTo',
          'field_withheld',
          'closeTo',
        );
        expectBoard(await board(AGENT_1, BOARD_ID), {}, 'both withheld', {
          withheld: ['ownerUserId', 'expectedCloseDate'],
        });
      });
    });

    describe('getPipelineBoard: strict id-only cursors (I6, R7, R8)', () => {
      it('a column’s cursor carries the last card’s id and nothing else, open and won alike', async () => {
        await plantBoard();
        const body = expectBoard(
          await servedBoard(AGENT_1, [
            ['limit', '2'],
            ['closedSince', iso(Date.now() - 365 * DAY)],
          ]),
          { windowDays: 365 },
          'limit 2',
          { limit: 2 },
        );
        for (const key of ['S0', 'S1', 'SW'] as const) {
          const entry = column(body, key);
          const cards = arr(entry.cards);
          const cursor = String(entry.nextCursor);
          expect(
            cursorProblems(cursor, String(cards[cards.length - 1]?.id)),
            `${key} cursor`,
          ).toEqual([]);
        }
      });

      it('every tampered or stale cursor is one 400 invalid_cursor body: nowhere, another stage, another programme or tenant, lost, out of window, filtered out, no or wrong stageId, moved since', async () => {
        await plantBoard();
        await plantForeignDeals();
        const first = await servedBoard();
        const s0 = column(first.body as Json, 'S0');
        const genuine = String(s0.nextCursor);
        const lastId = String(arr(s0.cards)[19]?.id);
        expect(lastId, 'the 20th S0 card').toBe(d(1));
        const s0Params = (cursor: string): Params => [
          ['stageId', stage('S0').id],
          ['cursor', cursor],
        ];
        expectStatus(
          await board(AGENT_1, BOARD_ID, s0Params(genuine)),
          200,
          'control: the genuine cursor',
        );

        const wonPage = await board(AGENT_1, BOARD_ID, [['limit', '1']]);
        expectStatus(wonPage, 200, 'won page');
        const wonCursor = String(column(wonPage.body as Json, 'SW').nextCursor);
        const wonLast = String(arr(column(wonPage.body as Json, 'SW').cards)[0]?.id);

        const refusals: [string, Params][] = [
          ['malformed', s0Params('not a cursor!')],
          ['garbage base64url', s0Params(Buffer.from('{"i":').toString('base64url'))],
          ['no such deal', s0Params(repoint(genuine, lastId, NOWHERE))],
          ['a deal of another stage', s0Params(repoint(genuine, lastId, d(31)))],
          ['another programme’s deal', s0Params(repoint(genuine, lastId, FOREIGN_A2))],
          ['another tenant’s deal', s0Params(repoint(genuine, lastId, FOREIGN_B1))],
          ['a lost deal of this pipeline', s0Params(repoint(genuine, lastId, d(51)))],
          ['a pipeline id', s0Params(repoint(genuine, lastId, BOARD_ID))],
          ['no stageId', [['cursor', genuine]]],
          [
            'another stageId',
            [
              ['stageId', stage('S1').id],
              ['cursor', genuine],
            ],
          ],
          [
            'a won cursor on an open column',
            [
              ['stageId', stage('S0').id],
              ['cursor', wonCursor],
            ],
          ],
          [
            'a won deal outside closedSince',
            [
              ['stageId', stage('SW').id],
              ['cursor', repoint(wonCursor, wonLast, d(44))],
            ],
          ],
          ['filtered out since', [...s0Params(genuine), ['currency', 'GHS']]],
        ];
        const bodies = new Set<string>();
        for (const [label, params] of refusals) {
          const response = await board(AGENT_1, BOARD_ID, params);
          expectDetail(response, 'cursor', 'invalid_cursor', label);
          bodies.add(response.text);
        }
        await observer.query('UPDATE deal SET stage_id = $1 WHERE id = $2', [
          stage('S1').id,
          lastId,
        ]);
        const moved = await board(AGENT_1, BOARD_ID, s0Params(genuine));
        expectDetail(moved, 'cursor', 'invalid_cursor', 'moved since');
        bodies.add(moved.text);
        expect(bodies.size, 'one body whatever the reason (R8)').toBe(1);
      });
    });

    describe('getPipelineBoard: scope and error order (I3, I8, R3, R4, R15)', () => {
      it('the supervisor sees the same A1 board as the agent; A2, tenant B, no programme and client_portal meet the one 404', async () => {
        await plantBoard();
        await plantForeignDeals();
        const agent = expectBoard(await servedBoard(AGENT_1, [['limit', '50']]), {}, 'agent', {
          limit: 50,
        });
        const supervisor = expectBoard(
          await board(SUPERVISOR, BOARD_ID, [['limit', '50']]),
          {},
          'supervisor',
          { limit: 50 },
        );
        expect(stripClosedSince(supervisor)).toEqual(stripClosedSince(agent));
        const plain404 = await board(AGENT_1, NOWHERE);
        expectError(plain404, 404, 'not_found', 'nowhere');
        const pipeline404 = await getPipeline(AGENT_1, NOWHERE);
        expect(plain404.text, 'the board’s 404 is getPipeline’s (R4)').toBe(pipeline404.text);
        for (const [label, headers] of [
          ['agent 2 (A2 only)', AGENT_2],
          ['tenant B', TENANT_B_ADMIN],
          ['no programme', NO_PROGRAMME],
        ] as const) {
          const response = await board(headers, BOARD_ID);
          expectError(response, 404, 'not_found', label);
          expect(response.text, label).toBe(plain404.text);
        }
        await assign(USER_A_AGENT_1, PROGRAMME_A1, 'client_portal');
        const portal = await board(AGENT_1, BOARD_ID);
        expectError(portal, 404, 'not_found', 'client_portal');
        expect(portal.text).toBe(plain404.text);
      });

      it('unknown parameters are ignored, never honoured: programmeId, tenantId and pipelineId change nothing', async () => {
        await plantBoard();
        const plainBoard = expectBoard(await servedBoard(), {}, 'plain');
        const a2 = await defaultPipeline(PROGRAMME_A2);
        const noisy = expectBoard(
          await board(AGENT_1, BOARD_ID, [
            ['programmeId', PROGRAMME_A2],
            ['tenantId', TENANT_B],
            ['pipelineId', a2.id],
            ['sort', '-amount'],
          ]),
          {},
          'noisy',
        );
        expect(stripClosedSince(noisy)).toEqual(stripClosedSince(plainBoard));
      });

      it('404 before 400: a bad parameter on a pipeline the caller cannot reach is the one 404, withheld-field filters included', async () => {
        await plantBoard();
        await servedBoard();
        const plain404 = await board(AGENT_1, NOWHERE);
        expectError(plain404, 404, 'not_found', 'nowhere');
        await lockField('amount', 'agent', 'none');
        const a2 = await defaultPipeline(PROGRAMME_A2);
        const b1 = await defaultPipeline(PROGRAMME_B1);
        const bad: [string, Params][] = [
          ['limit=0', [['limit', '0']]],
          ['closedSince in the future', [['closedSince', iso(Date.now() + DAY)]]],
          ['closedSince too long', [['closedSince', iso(Date.now() - 400 * DAY)]]],
          ['currency=USD', [['currency', 'USD']]],
          ['currency while amount is withheld', [['currency', 'NGN']]],
          ['an unknown stageId', [['stageId', NOWHERE]]],
          [
            'a garbage cursor',
            [
              ['stageId', NOWHERE],
              ['cursor', 'garbage!'],
            ],
          ],
        ];
        for (const target of [a2.id, b1.id, NOWHERE, 'not-a-uuid']) {
          for (const [label, params] of bad) {
            const response = await board(AGENT_1, target, params);
            expectError(response, 404, 'not_found', `${target}: ${label}`);
            expect(response.text, `${target}: ${label}`).toBe(plain404.text);
          }
        }
        // The control: the same parameter on a reachable pipeline is the 400.
        expectError(
          await board(AGENT_1, BOARD_ID, [['limit', '0']]),
          400,
          'validation_failed',
          'reachable, limit=0',
        );
      });
    });

    describe('getPipelineBoard: personal data (CLAUDE.md 6.1)', () => {
      it('deal names and next steps (pii, D-L115) are in the answer but in no log line, log record or span', async () => {
        await plantBoard();
        let text = '';
        const lines = await captureEverything(async () => {
          const response = await board(AGENT_1, BOARD_ID, [['limit', '50']]);
          expectStatus(response, 200, 'board');
          text = response.text;
        });
        const secrets = [
          ...DEALS.map((spec) => spec.name),
          ...DEALS.flatMap((spec) => (spec.nextStep === null ? [] : [spec.nextStep])),
        ];
        expect(
          secrets.filter((secret) => text.includes(secret)).length,
          'the names are served, so their absence from logs means something',
        ).toBeGreaterThan(0);
        const leaks = secrets.filter((secret) => lines.some((line) => line.includes(secret)));
        expect(leaks).toEqual([]);
      });
    });
  });

  // =========================================================================
  // 3. Plans (I9, R20): a large tenant, the SQL the board actually sends,
  //    replayed as kasuwa_app under FORCE RLS.
  // =========================================================================

  describe('plans: the board’s card statements use the 0036 board indexes, no Sort (D-P33, R20)', () => {
    let a1: { id: string; stages: DbStage[] } = { id: '', stages: [] };

    const BULK_SQL = `
      WITH s AS (SELECT id, kind, position FROM pipeline_stage WHERE pipeline_id = $3::uuid)
      INSERT INTO deal (id, tenant_id, programme_id, pipeline_id, stage_id, name, amount_minor,
                        currency, stage_entered_at, closed_at)
      SELECT ($5 || lpad(to_hex(g.i), 7, '0'))::uuid, $1::uuid, $2::uuid, $3::uuid, s.id,
             'T0107 bulk ' || substr(md5(g.i::text), 1, 8),
             (g.i::bigint * 104729) % 1000000000, 'NGN',
             t.at, CASE WHEN s.kind = 'open' THEN NULL ELSE t.at END
        FROM generate_series(1, $4::int) AS g(i)
        JOIN s ON s.position = g.i % 7
        CROSS JOIN LATERAL (
          SELECT now() - make_interval(secs => ((g.i::bigint * 7919) % 25000000)::double precision) AS at
        ) AS t`;

    beforeAll(async () => {
      await reseed(inject('migrationUrl'));
      a1 = await defaultPipeline(PROGRAMME_A1);
      const a2 = await defaultPipeline(PROGRAMME_A2);
      for (const [programmeId, pipeline, prefix] of [
        [PROGRAMME_A1, a1, '11111111-0000-4000-8000-0107e'],
        [PROGRAMME_A2, a2, '11111111-0000-4000-8000-0107f'],
      ] as const) {
        if (pipeline.stages.length !== 7) throw new Error('the template has seven stages');
        await observer.query(BULK_SQL, [
          TENANT_A,
          programmeId,
          pipeline.id,
          BULK_PER_PROGRAMME,
          prefix,
        ]);
      }
      await observer.query('ANALYZE deal');
    }, 300_000);

    afterAll(async () => {
      stopRecording();
      await reseed(inject('migrationUrl'));
    }, 120_000);

    /** One request; its card statements replayed; problems and the indexes they used. */
    async function judge(
      userId: string,
      params: Params,
      where: string,
    ): Promise<{ problems: string[]; indexes: Set<string>; body: Json }> {
      recording = [];
      startRecording();
      let statements: Recorded[];
      let response: request.Response;
      try {
        response = await board(asUser(TENANT_A, userId), a1.id, params);
      } finally {
        statements = recording ?? [];
        stopRecording();
      }
      expectStatus(response, 200, where);
      const cards = statements.filter((statement) => isCardStatement(statement.text));
      const problems: string[] = [];
      const indexes = new Set<string>();
      if (cards.length === 0) {
        problems.push(
          `no card statement (FROM deal ... ORDER BY ... LIMIT) among ${statements.length} recorded`,
        );
      }
      for (const statement of cards) {
        const rows = await withTenantTransaction(appPool, { tenantId: TENANT_A, userId }, (tx) =>
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
        const judged = planProblems(root);
        problems.push(...judged.problems.map((problem) => `${where}: ${problem}`));
        for (const index of judged.indexes) indexes.add(index);
      }
      return { problems, indexes, body: response.body as Json };
    }

    const CALLERS = [
      ['agent (A1)', USER_A_AGENT_1],
      ['supervisor (A1+A2)', USER_A_SUPERVISOR],
    ] as const;

    it.each(CALLERS)(
      '%s: the whole board reads every column by a board index, open and won, with no Sort',
      async (label, userId) => {
        const { problems, indexes } = await judge(userId, [], `${label} whole board`);
        expect(problems).toEqual([]);
        expect([...indexes].sort(), 'both board indexes are used').toEqual(
          [...BOARD_INDEXES].sort(),
        );
      },
      120_000,
    );

    it.each(CALLERS)(
      '%s: a deep page of an open and of the won column seeks (bounded rows examined) and returns exactly the rows after the cursor',
      async (label, userId) => {
        const closedSince = iso(Date.now() - 200 * DAY);
        const qualified = a1.stages.find((s) => s.position === 0);
        const won = a1.stages.find((s) => s.kind === 'won');
        if (qualified === undefined || won === undefined) throw new Error('template stages');
        const open = await observer.query<{ id: string }>(
          `SELECT id FROM deal WHERE tenant_id = $1 AND pipeline_id = $2 AND stage_id = $3
            ORDER BY stage_entered_at, id`,
          [TENANT_A, a1.id, qualified.id],
        );
        const closed = await observer.query<{ id: string }>(
          `SELECT id FROM deal WHERE tenant_id = $1 AND pipeline_id = $2 AND stage_id = $3
              AND closed_at >= $4 ORDER BY closed_at DESC, id DESC`,
          [TENANT_A, a1.id, won.id, closedSince],
        );
        const columnsChecked: string[] = [];
        for (const [name, stageId, rows] of [
          ['open', qualified.id, open.rows],
          ['won', won.id, closed.rows],
        ] as const) {
          expect(rows.length, `${name}: the stage is large`).toBeGreaterThan(1000);
          const middle = Math.floor(rows.length / 2);
          const params: Params = [
            ['stageId', stageId],
            ['limit', '20'],
            ['closedSince', closedSince],
          ];
          const first = await board(asUser(TENANT_A, userId), a1.id, params);
          expectStatus(first, 200, `${label} ${name} first page`);
          const entry = arr((first.body as Json).stages)[0] ?? {};
          const cards = arr(entry.cards);
          const cursor = repoint(
            String(entry.nextCursor),
            String(cards[cards.length - 1]?.id),
            String(rows[middle]?.id),
          );
          const judged = await judge(
            userId,
            [...params, ['cursor', cursor]],
            `${label} ${name} deep page`,
          );
          expect(judged.problems).toEqual([]);
          const served = arr(arr(judged.body.stages)[0]?.cards).map((card) => card.id);
          expect(served, `${label} ${name}: the 20 rows after the cursor`).toEqual(
            rows.slice(middle + 1, middle + 21).map((row) => row.id),
          );
          columnsChecked.push(name);
        }
        expect(columnsChecked).toEqual(['open', 'won']);
      },
      120_000,
    );
  });
});
