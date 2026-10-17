import type { Page, Request, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { TENANT_A } from '@kasuwa/db';

/**
 * The P06 half of `docs/api/records.openapi.yaml`: `listPipelines`,
 * `getPipeline`, `getPipelineBoard`, `listDeals`, `createDeal`, `getDeal` and
 * `moveDeal`, plus the requirement prompt's pickers (`listContacts` and
 * `listAccounts`, `q` only), `listMyProgrammes`, and `getCurrentUser`
 * (`docs/api/auth.openapi.yaml`), served into the browser by Playwright for
 * T-0109 (the pipeline board and list) and written to be reused by T-0110
 * (deal detail). Copy it or import it; never import a SPEC file.
 *
 * ---------------------------------------------------------------------------
 * READ FROM THE CONTRACT AT RUN TIME, AND EVERY ANSWER CHECKED AGAINST IT
 *
 * The schemas, the parameter lists, the requirement and currency vocabularies
 * and every error body come out of the YAML when this module loads.
 *
 *   - At load, both pipelines are validated as `Pipeline`, and every stored
 *     deal, served as `Deal`, is validated against the contract. A contract
 *     change this file contradicts fails here, before any journey runs.
 *   - `PIPELINE_ONE` IS the contract's getPipeline example, verbatim: the
 *     template's seven stages ("B2B sales"), its requirements and its
 *     transition allow-list.
 *   - At run time EVERY body the mock answers with is validated, strictly,
 *     against the schema the contract declares for that operation and status:
 *     a property the schema does not name is a fault, so the mock can never
 *     hand the screen a field (a board-level total, a probability on a deal, a
 *     US$ amount) the real API does not serve. A fault is the MOCK's, recorded
 *     in `mockFaults`, which the spec's `afterEach` requires to be empty.
 *
 *   The one exception is `hostileSummaries`, which serves one deal whose
 *   contact and account summary ids are NOT uuids, on purpose (the screen must
 *   link only from a well-formed uuid). Exactly those problems are moved to
 *   `plantedFaults`; any other problem is still a mock fault.
 *
 * THE CLOCK
 *
 *   The server's "now" is NOW, fixed: 09:00 UTC on Monday 12 October 2026.
 *   Rotting is computed from it exactly as DealRotting says (whole 24-hour
 *   periods since `stageEnteredAt`; stale from half the stage's
 *   `rottingAfterDays`, rounded down; rotting from `rottingAfterDays`). The
 *   default won window is NOW minus 90 days; `closedSince` may reach back 366
 *   days and never past NOW. Journeys fix the browser clock to NOW (except the
 *   byte-budget journeys, D-L118).
 *
 * WHAT IS NOT IN THE CONTRACT, AND IS THEREFORE DECLARED HERE
 *
 *   - Deals. Invented, with SYNTHETIC names only (CLAUDE.md 6.1): the contract's
 *     own board examples carry realistic personal names (D-L123's contract
 *     follow-up), so they are not copied. Ids keep the contract's prefixes.
 *   - The caller, ME ("Synthetic Agent One"), the contract's example owner id.
 *   - Field security of the deal object, per programme:
 *       PROGRAMME_ONE — nothing withheld;
 *       PROGRAMME_TWO — `amount`, `ownerUserId` and `expectedCloseDate`
 *                       withheld (so totals are omitted, and the owner, close
 *                       and currency filters are `400 field_withheld`).
 *   - The caller's rights (`role`): `team_lead` by default (`deal.write_any`:
 *     moves any deal); `agent` (moves its own deals only); `qa_analyst` (no
 *     `deal.write`: create and move are `403 not_permitted`).
 *
 * WHAT THE MOCK ENFORCES ON EVERY REQUEST (recorded as `violations`, the
 * SCREEN's fault; `afterEach` in the spec fails a test that has any)
 *
 *   - Only the operations above. Anything else under `/api/v1/` is a
 *     violation: updateDeal (deal detail is T-0110), a pipeline write, a
 *     US$/FX rate, products, quotes, approvals, a count.
 *   - No request header names a programme or a tenant (CLAUDE.md 2.2).
 *   - A pipeline or deal id that is not a uuid is never read (it is the
 *     route's real 404, and the screen reads nothing).
 *   - Each read: only the parameters the contract declares for it; scalar
 *     parameters once; `limit` in range (board 1..50, others 1..100), never
 *     clamped.
 *   - Board and list filters: `q` 1..100 with no NUL; `owner` only `me`,
 *     `unassigned` or a uuid; `closeFrom`/`closeTo` calendar dates, `closeTo`
 *     not before `closeFrom`; `currency` only NGN, GHS, KES or ZAR;
 *     `closedSince` UTC with a `Z`, at most 366 days back and not in the
 *     future. A filter on a field withheld from the caller is a violation AND
 *     the contract's `400 field_withheld`: the screen knew from the board's
 *     `withheldFields` and must not offer it.
 *   - Cursors are echoed exactly: a board cursor only with the `stageId` it
 *     was served for and the same filters; a list cursor with the same
 *     filters, `stageId`s and `sort`. A board `stageId` is an open or won
 *     stage of the pipeline, never lost.
 *   - createDeal: the closed `CreateDealRequest`; NEVER `ownerUserId` (an
 *     agent's deal is theirs, and the board offers no reassignment, R7); a
 *     withheld field never sent; `amount.currency` one of the four.
 *   - moveDeal: the closed `MoveDealRequest`; a deal the screen was served; a
 *     `version` it was served for THAT deal; a version already answered `409`
 *     is a blind retry; `toStageId` a stage of the deal's pipeline as the
 *     screen last read it; a move the screen's own allow-list forbids is a
 *     violation (it must say so and send nothing); `fields` and `checks` only
 *     the target stage's own requirements; a field sent with the value the
 *     deal already holds is not "only what the person filled" (D-L102); a
 *     field sent with the value somebody else just replaced undoes their save
 *     (D-L102); a check the deal already records is not asked for again; a
 *     withheld field is never sent.
 *   - getDeal: a deal the screen was served.
 *   - The pickers: `q`, `limit`, `cursor`, `sort` only; a contact or account
 *     sent in a move must be one the picker served AND in the deal's
 *     programme (the screen offers only those; anything else is the API's
 *     `400 unknown_reference`).
 *
 * SERVER BEHAVIOUR THE SCREEN DEPENDS ON, IMPLEMENTED AS THE CONTRACT SAYS
 *
 *   - Board columns: every open stage then won, in position order; lost is
 *     never a column. `count` and `totals` over the whole filtered stage, not
 *     the page; totals one per currency, sorted by code, summed exactly
 *     (BigInt), weighted rounded half-even PER DEAL then summed; omitted when
 *     `amount` is withheld. Open columns by `stageEnteredAt` ascending then
 *     id; won by `closedAt` descending then id descending, within
 *     `closedSince`. A page with a non-null `nextCursor` holds exactly `limit`
 *     cards. A column page answers that one column only.
 *   - listDeals: every stage, lost included; won and lost only from
 *     `closedSince`; the fixed `sort` keys; keyset only.
 *   - Writes apply: a created deal joins the first open stage; a move changes
 *     the stage, `stageEnteredAt` and `closedAt`, records ticked checks (who:
 *     the caller; when: the server's time) and filled fields, and advances
 *     `version`. Refusals write nothing. Order: 404, 403, 400, 403
 *     field_not_editable (a required field withheld from the mover), 409
 *     stale_write, 409 transition_not_allowed, 422 requirements_unmet.
 *   - `concurrent`: before each of the screen's moves of the named deal
 *     lands, somebody else applies the next change in the list (the version
 *     advances), so that move is `409 stale_write`; a re-read serves it.
 *   - `concurrentArrival`: right after the screen's first successful move,
 *     somebody else creates a deal in the named stage, so a count or total
 *     the browser adjusted by itself is wrong and only a re-read is right.
 *   - `requirementDrift` / `transitionDrift`: the pipeline was reconfigured
 *     (through the API) after the screen first read it. The server judges
 *     moves against the NEW configuration from the start; getPipeline serves
 *     the old one on the first read and the new one on every read after.
 * ---------------------------------------------------------------------------
 */

export const RECORDS_CONTRACT_SOURCE = 'docs/api/records.openapi.yaml';
export const AUTH_CONTRACT_SOURCE = 'docs/api/auth.openapi.yaml';
const ADMIN_CONTRACT_SOURCE = 'docs/api/admin.openapi.yaml';

const repoRoot = resolve(__dirname, '..', '..', '..');

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function load(source: string): unknown {
  return parse(readFileSync(resolve(repoRoot, source), 'utf8'));
}

const CONTRACT: unknown = load(RECORDS_CONTRACT_SOURCE);
const AUTH_CONTRACT: unknown = load(AUTH_CONTRACT_SOURCE);
const ADMIN_CONTRACT: unknown = load(ADMIN_CONTRACT_SOURCE);

const DOCUMENTS: Readonly<Record<string, unknown>> = {
  './records.openapi.yaml': CONTRACT,
  './auth.openapi.yaml': AUTH_CONTRACT,
  './admin.openapi.yaml': ADMIN_CONTRACT,
};

function at(node: unknown, ...path: string[]): unknown {
  let current: unknown = node;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) {
      throw new Error(`contract: nothing at ${path.join('.')}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) {
    throw new Error(`contract: nothing at ${path.join('.')}`);
  }
  return current;
}

interface Located {
  node: unknown;
  doc: unknown;
}

/** Follows `$ref`s, local or into a sibling contract (`./admin.openapi.yaml#/…`). */
function deref(node: unknown, doc: unknown): Located {
  if (!isJson(node) || typeof node.$ref !== 'string') {
    return { node, doc };
  }
  const [file, pointer] = node.$ref.split('#');
  const target = file === undefined || file === '' ? doc : DOCUMENTS[file];
  if (target === undefined || pointer === undefined) {
    throw new Error(`contract: cannot follow ${node.$ref}`);
  }
  return deref(at(target, ...pointer.slice(1).split('/')), target);
}

function schema(name: string): Json {
  return at(CONTRACT, 'components', 'schemas', name) as Json;
}

const PIPELINES_PATH = '/api/v1/pipelines';
const DEALS_PATH = '/api/v1/deals';
const CONTACTS_PATH = '/api/v1/contacts';
const ACCOUNTS_PATH = '/api/v1/accounts';
const PROGRAMMES_PATH = '/api/v1/me/programmes';
const ME_PATH = '/api/v1/auth/me';

const OP = {
  listPipelines: [PIPELINES_PATH, 'get'],
  getPipeline: [`${PIPELINES_PATH}/{pipelineId}`, 'get'],
  getPipelineBoard: [`${PIPELINES_PATH}/{pipelineId}/board`, 'get'],
  listDeals: [`${PIPELINES_PATH}/{pipelineId}/deals`, 'get'],
  createDeal: [`${PIPELINES_PATH}/{pipelineId}/deals`, 'post'],
  getDeal: [`${DEALS_PATH}/{dealId}`, 'get'],
  moveDeal: [`${DEALS_PATH}/{dealId}/move`, 'post'],
  listContacts: [CONTACTS_PATH, 'get'],
  listAccounts: [ACCOUNTS_PATH, 'get'],
  listMyProgrammes: [PROGRAMMES_PATH, 'get'],
  getCurrentUser: [ME_PATH, 'get'],
} as const;

export type Operation = keyof typeof OP;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** RFC 3339 in UTC, with a `Z`: the contract's rule for every time. */
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Validation: a JSON-Schema subset, exactly what these bodies and answers use
// ---------------------------------------------------------------------------

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function declaredKeys(spec: Json, doc: unknown): Set<string> {
  const keys = new Set(Object.keys((spec.properties ?? {}) as Json));
  for (const part of (Array.isArray(spec.allOf) ? spec.allOf : []) as unknown[]) {
    const located = deref(part, doc);
    if (isJson(located.node)) {
      for (const key of declaredKeys(located.node, located.doc)) keys.add(key);
    }
  }
  return keys;
}

function validDate(value: string): boolean {
  if (!CALENDAR_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Problems with `value` against a schema. `strict` treats every object schema
 * that declares properties as closed: used on the mock's OWN answers, never on
 * what the screen sends (request bodies are judged by the contract's own
 * `additionalProperties`).
 */
export function validateBody(value: unknown, raw: unknown, path: string, doc: unknown = CONTRACT, strict = false): string[] {
  const located = deref(raw, doc);
  const spec = located.node as Json;
  const where = path || 'body';
  if (Array.isArray(spec.oneOf)) {
    const passing = spec.oneOf.filter((option) => validateBody(value, option, path, located.doc, strict).length === 0);
    if (passing.length !== 1) {
      return [`${where} matches ${passing.length} of oneOf, not exactly 1`];
    }
  }
  const problems: string[] = [];
  if (Array.isArray(spec.allOf)) {
    for (const part of spec.allOf) {
      problems.push(...validateBody(value, part, path, located.doc, false));
    }
  }
  if (spec.type !== undefined) {
    const allowed = (Array.isArray(spec.type) ? spec.type : [spec.type]).map(String);
    const actual = typeOf(value);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      return [...problems, `${where} is ${actual}, not ${allowed.join('|')}`];
    }
  }
  if ('const' in spec && spec.const !== value) {
    problems.push(`${where} is not ${String(spec.const)}`);
  }
  if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
    problems.push(`${where} is not one of ${spec.enum.join(', ')}`);
  }
  if (typeof value === 'string') {
    if (typeof spec.minLength === 'number' && value.length < spec.minLength) problems.push(`${where} is too short`);
    if (typeof spec.maxLength === 'number' && value.length > spec.maxLength) problems.push(`${where} is too long`);
    if (typeof spec.pattern === 'string' && !new RegExp(spec.pattern).test(value)) {
      problems.push(`${where} does not match ${spec.pattern}`);
    }
    if (spec.format === 'uuid' && !UUID_PATTERN.test(value)) problems.push(`${where} is not a uuid`);
    if (spec.format === 'date-time' && !UTC_DATE_TIME.test(value)) {
      problems.push(`${where} is not a UTC date-time with a Z`);
    }
    if (spec.format === 'date' && !validDate(value)) problems.push(`${where} is not a calendar date`);
    if (spec.format === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) problems.push(`${where} is not an email`);
    if (value.includes('\u0000')) problems.push(`${where} carries a NUL`);
  }
  if (typeof value === 'number') {
    if (typeof spec.minimum === 'number' && value < spec.minimum) problems.push(`${where} is below ${spec.minimum}`);
    if (typeof spec.maximum === 'number' && value > spec.maximum) problems.push(`${where} is above ${spec.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof spec.maxItems === 'number' && value.length > spec.maxItems) problems.push(`${where} has too many items`);
    if (typeof spec.minItems === 'number' && value.length < spec.minItems) problems.push(`${where} has too few items`);
    if (spec.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      problems.push(`${where} repeats an item`);
    }
    if (spec.items !== undefined) {
      value.forEach((item, index) => problems.push(...validateBody(item, spec.items, `${path}.${index}`, located.doc, strict)));
    }
  }
  if (isJson(value) && (spec.properties !== undefined || spec.required !== undefined || spec.additionalProperties === false)) {
    const properties = (spec.properties ?? {}) as Json;
    const declared = declaredKeys(spec, located.doc);
    if (typeof spec.minProperties === 'number' && Object.keys(value).length < spec.minProperties) {
      problems.push(`${where} has fewer than ${spec.minProperties} properties`);
    }
    for (const key of (spec.required ?? []) as string[]) {
      if (!(key in value)) problems.push(`${path ? `${path}.` : ''}${key} is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      const child = `${path ? `${path}.` : ''}${key}`;
      if (!(key in properties)) {
        if (spec.additionalProperties === false) {
          problems.push(`${child} is not a property of this closed body`);
        } else if (strict && !declared.has(key)) {
          problems.push(`${child} is not a property the contract declares`);
        }
        continue;
      }
      problems.push(...validateBody(item, properties[key], child, located.doc, strict));
    }
  }
  return problems;
}

/**
 * What is wrong with answering `operation` with `status` and `body`, judged
 * strictly against the response the contract declares. An undeclared status
 * is itself a problem.
 */
export function answerProblems(operation: Operation, status: number, body: unknown): string[] {
  const [path, method] = OP[operation];
  const document = operation === 'getCurrentUser' ? AUTH_CONTRACT : CONTRACT;
  const responses = at(document, 'paths', path, method, 'responses') as Json;
  const declared = responses[String(status)];
  if (declared === undefined) {
    return [`${operation} declares no ${status} response`];
  }
  const response = deref(declared, document);
  const content = at(response.node, 'content', 'application/json', 'schema');
  return validateBody(body, content, `${operation} ${status}`, response.doc, true);
}

/** The `code`s an operation can answer with, read from its error responses. */
export function errorCodes(operation: Operation): string[] {
  const [path, method] = OP[operation];
  const codes = new Set<string>();
  for (const [status, raw] of Object.entries(at(CONTRACT, 'paths', path, method, 'responses') as Json)) {
    if (status.startsWith('2')) continue;
    const json = at(deref(raw, CONTRACT).node, 'content', 'application/json') as Json;
    const examples = [json.example, ...Object.values((json.examples ?? {}) as Json).map((entry) => at(entry, 'value'))];
    for (const example of examples) {
      if (isJson(example) && typeof example.code === 'string') codes.add(example.code);
    }
  }
  return [...codes].sort();
}

function errorExample(response: string, name?: string): Json {
  const json = at(deref(at(CONTRACT, 'components', 'responses', response), CONTRACT).node, 'content', 'application/json') as Json;
  const body = name === undefined ? json.example : at(json.examples, name, 'value');
  return clone(body) as Json;
}

function validation(details: { path: string; code: string }[]): Json {
  const body = errorExample('DealValidationFailed', 'badCursor');
  body.details = details;
  return body;
}

function notFound(): Json {
  return errorExample('PipelineRecordNotFound');
}

/** The query parameters an operation declares (operation level; path parameters excluded). */
function parameterNames(operation: Operation): readonly string[] {
  const [path, method] = OP[operation];
  const own = (at(CONTRACT, 'paths', path, method) as Json).parameters;
  return ((Array.isArray(own) ? own : []) as unknown[])
    .map((raw) => deref(raw, CONTRACT).node as Json)
    .filter((parameter) => parameter.in === 'query')
    .map((parameter) => String(parameter.name));
}

/** The array-valued (repeatable) query parameters an operation declares. */
function arrayParameters(operation: Operation): readonly string[] {
  const [path, method] = OP[operation];
  const own = (at(CONTRACT, 'paths', path, method) as Json).parameters;
  return ((Array.isArray(own) ? own : []) as unknown[])
    .map((raw) => deref(raw, CONTRACT).node as Json)
    .filter((parameter) => isJson(parameter.schema) && parameter.schema.type === 'array')
    .map((parameter) => String(parameter.name));
}

// ---------------------------------------------------------------------------
// The contract's own vocabularies
// ---------------------------------------------------------------------------

/** listDeals' sort keys (never a withheld field). */
export const SORT_KEYS: readonly string[] = (
  ((at(CONTRACT, 'paths', OP.listDeals[0], 'get', 'parameters') as unknown[])
    .map((raw) => deref(raw, CONTRACT).node as Json)
    .find((parameter) => parameter.name === 'sort')?.schema as Json | undefined)?.enum as unknown[]
).map(String);

/** The standard deal fields a `field` requirement may name. */
export const REQUIREMENT_FIELDS: readonly string[] = (at(schema('DealRequirementField'), 'enum') as unknown[]).map(String);

/** The deal fields field security may withhold. */
export const WITHHOLDABLE_FIELDS: readonly string[] = (at(schema('DealWithheldField'), 'enum') as unknown[]).map(String);

/** DealMoney's currencies: in its description, deliberately not an enum. */
export const CURRENCIES: readonly string[] = ['NGN', 'GHS', 'KES', 'ZAR'];
{
  const description = String(at(schema('DealMoney'), 'description'));
  for (const code of CURRENCIES) {
    if (!description.includes(code)) {
      throw new Error(`${RECORDS_CONTRACT_SOURCE}: DealMoney no longer names ${code}; the mock's currency list is out of date`);
    }
  }
}

/** Board cards per column: BoardLimit (default 20, 1..50). */
const BOARD_LIMIT = deref(at(CONTRACT, 'components', 'parameters', 'BoardLimit'), CONTRACT).node as { schema: { default: number; minimum: number; maximum: number } };
export const BOARD_DEFAULT_LIMIT = BOARD_LIMIT.schema.default;
const LIST_LIMIT = deref(at(CONTRACT, 'components', 'parameters', 'Limit'), CONTRACT).node as { schema: { default: number; minimum: number; maximum: number } };
export const LIST_DEFAULT_LIMIT = LIST_LIMIT.schema.default;

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** The server's "now". Journeys fix the browser clock to it. */
export const NOW = '2026-10-12T09:00:00.000Z';
export const NOW_MS = Date.parse(NOW);

/** The default won window: 90 days before NOW (D-L88). */
export const DEFAULT_CLOSED_SINCE = new Date(NOW_MS - 90 * DAY).toISOString();
/** The earliest `closedSince` the server accepts (D-L115). */
export const EARLIEST_CLOSED_SINCE_MS = NOW_MS - 366 * DAY;

/** An instant `days` whole days (and `hours` more) before NOW. */
export function daysAgo(days: number, hours = 0): string {
  return new Date(NOW_MS - days * DAY - hours * HOUR).toISOString();
}

// ---------------------------------------------------------------------------
// Money: exact, per deal, half-even (D-L88, D-P19)
// ---------------------------------------------------------------------------

/** `amountMinor` times `probabilityBp` / 10000, rounded half-even, as a decimal string. */
export function weightedMinor(amountMinor: string, probabilityBp: number): string {
  const product = BigInt(amountMinor) * BigInt(probabilityBp);
  const whole = product / 10000n;
  const rest = product % 10000n;
  if (rest * 2n > 10000n || (rest * 2n === 10000n && whole % 2n === 1n)) {
    return (whole + 1n).toString();
  }
  return whole.toString();
}

// ---------------------------------------------------------------------------
// People and programmes (synthetic text only, CLAUDE.md 6.1)
// ---------------------------------------------------------------------------

export interface Programme {
  id: string;
  name: string;
}

export interface Person {
  id: string;
  displayName: string;
}

/** The contract's example programme (listMyProgrammes). */
export const PROGRAMME_ONE = clone(
  at(CONTRACT, 'paths', PROGRAMMES_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', '0'),
) as Programme;

/** A second programme whose deal matrix withholds amount, owner and close date. */
export const PROGRAMME_TWO: Programme = { id: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a02', name: 'Synthetic Field Programme' };

/** The caller: the contract's example owner id, with a synthetic name. */
export const ME: Person = { id: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01', displayName: 'Synthetic Agent One' };
/** Another member of PROGRAMME_ONE. */
export const OTHER: Person = { id: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02', displayName: 'Synthetic Agent Two' };
/** A former owner: no longer a member, served with `displayName: null` (D-P23). */
export const FORMER_OWNER_ID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e09';

export const CURRENT_USER: Json = {
  id: ME.id,
  tenantId: TENANT_A,
  email: 'synthetic.agent.one@example.com',
  displayName: ME.displayName,
  locale: 'en-NG',
};

/** Field security of the deal object, per programme (Deal's own names). */
const WITHHELD: Readonly<Record<string, readonly string[]>> = {
  [PROGRAMME_ONE.id]: [],
  [PROGRAMME_TWO.id]: ['amount', 'ownerUserId', 'expectedCloseDate'],
};

export function withheldIn(programmeId: string): readonly string[] {
  return WITHHELD[programmeId] ?? [];
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

export interface Requirement {
  id: string;
  kind: 'field' | 'check';
  field?: string;
  label?: string;
}

export interface Stage {
  id: string;
  name: string;
  kind: 'open' | 'won' | 'lost';
  position: number;
  probabilityBp: number;
  rottingAfterDays: number | null;
  requirements: Requirement[];
}

export interface PipelineConfig {
  id: string;
  programmeId: string;
  name: string;
  version: number;
  stages: Stage[];
  transitions: { fromStageId: string; toStageId: string }[];
  createdAt: string;
  updatedAt: string;
}

const PIPELINE_SCHEMA = schema('Pipeline');

function checkPipeline(pipeline: PipelineConfig): PipelineConfig {
  const problems = validateBody(pipeline, PIPELINE_SCHEMA, `pipeline ${pipeline.id}`, CONTRACT, true);
  if (problems.length > 0) {
    throw new Error(`pipeline ${pipeline.id} disagrees with ${RECORDS_CONTRACT_SOURCE}: ${problems.join('; ')}`);
  }
  return pipeline;
}

/** The contract's getPipeline example, verbatim: "B2B sales", the seeded template. */
export const PIPELINE_ONE = checkPipeline(
  clone(at(CONTRACT, 'paths', OP.getPipeline[0], 'get', 'responses', '200', 'content', 'application/json', 'example')) as PipelineConfig,
);

function stageOf(pipeline: PipelineConfig, position: number): Stage {
  const stage = pipeline.stages.find((candidate) => candidate.position === position);
  if (stage === undefined) throw new Error(`${pipeline.name} has no stage at position ${position}`);
  return stage;
}

function requirementOf(stage: Stage, index: number): Requirement {
  const requirement = stage.requirements[index];
  if (requirement === undefined) throw new Error(`${stage.name} has no requirement ${index}`);
  return requirement;
}

export const S_QUALIFIED = stageOf(PIPELINE_ONE, 0);
export const S_DISCOVERY = stageOf(PIPELINE_ONE, 1);
export const S_PROPOSAL = stageOf(PIPELINE_ONE, 2);
export const S_NEGOTIATION = stageOf(PIPELINE_ONE, 3);
export const S_CONTRACT = stageOf(PIPELINE_ONE, 4);
export const S_WON = stageOf(PIPELINE_ONE, 5);
export const S_LOST = stageOf(PIPELINE_ONE, 6);

/** Proposal's check ("Budget range confirmed with the customer"). */
export const R_BUDGET = requirementOf(S_PROPOSAL, 0);
/** Negotiation's `amount` field requirement. */
export const R_AMOUNT = requirementOf(S_NEGOTIATION, 0);
/** Negotiation's `expectedCloseDate` field requirement. */
export const R_CLOSE = requirementOf(S_NEGOTIATION, 1);
/** Negotiation's check ("Quote sent to the customer"). */
export const R_QUOTE = requirementOf(S_NEGOTIATION, 2);
/** Contract's `primaryContactId` field requirement. */
export const R_CONTACT = requirementOf(S_CONTRACT, 0);
/** Contract's check ("Purchase order received"). */
export const R_PO = requirementOf(S_CONTRACT, 1);

{
  const expect = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(`the getPipeline example changed: ${what}. The journeys depend on it; update this mock with it (D-L97).`);
  };
  expect(PIPELINE_ONE.stages.length === 7, 'it no longer has seven stages');
  expect([S_QUALIFIED, S_DISCOVERY, S_PROPOSAL, S_NEGOTIATION, S_CONTRACT].every((stage) => stage.kind === 'open'), 'positions 0-4 are not all open');
  expect(S_WON.kind === 'won' && S_LOST.kind === 'lost', 'positions 5 and 6 are not won and lost');
  expect(S_QUALIFIED.requirements.length === 0 && S_DISCOVERY.requirements.length === 0, 'Qualified or Discovery has requirements');
  expect(R_BUDGET.kind === 'check' && R_QUOTE.kind === 'check' && R_PO.kind === 'check', 'a check requirement moved');
  expect(R_AMOUNT.field === 'amount' && R_CLOSE.field === 'expectedCloseDate' && R_CONTACT.field === 'primaryContactId', 'a field requirement moved');
  expect(S_CONTRACT.rottingAfterDays === 21 && S_QUALIFIED.rottingAfterDays === 14, 'the rotting days changed');
}

/** A second pipeline, in PROGRAMME_TWO, from the same template with its own ids. */
function secondPipeline(): PipelineConfig {
  const swap = (id: string): string => id.replace(/^5d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f0/, '5d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f1').replace(/^4c5d6e7f-8a9b-4c0d-8e1f-2a3b4c5d6e0/, '4c5d6e7f-8a9b-4c0d-8e1f-2a3b4c5d6e1');
  const copy = clone(PIPELINE_ONE);
  return checkPipeline({
    ...copy,
    id: '3a4b5c6d-7e8f-4a0b-8c1d-2e3f4a5b6c02',
    programmeId: PROGRAMME_TWO.id,
    name: 'Field sales',
    stages: copy.stages.map((stage) => ({
      ...stage,
      id: swap(stage.id),
      requirements: stage.requirements.map((requirement) => ({ ...requirement, id: swap(requirement.id) })),
    })),
    transitions: copy.transitions.map((pair) => ({ fromStageId: swap(pair.fromStageId), toStageId: swap(pair.toStageId) })),
  });
}

export const PIPELINE_TWO = secondPipeline();
export const T_QUALIFIED = stageOf(PIPELINE_TWO, 0);
export const T_PROPOSAL = stageOf(PIPELINE_TWO, 2);
export const T_NEGOTIATION = stageOf(PIPELINE_TWO, 3);
export const T_R_QUOTE = requirementOf(T_NEGOTIATION, 2);

/** A pipeline id the caller does not reach (another programme or tenant): the one 404. */
export const OUT_OF_SCOPE_PIPELINE_ID = '3a4b5c6d-7e8f-4a0b-8c1d-2e3f4a5b6c99';

/** Under `requirementDrift`: the check the server added to Discovery after the screen's first read. */
export const R_DRIFT: Requirement = {
  id: '4c5d6e7f-8a9b-4c0d-8e1f-2a3b4c5d6e99',
  kind: 'check',
  label: 'Synthetic data-sharing consent recorded',
};

function drifted(pipeline: PipelineConfig, options: PipelineMockOptions): PipelineConfig {
  if (pipeline.id !== PIPELINE_ONE.id || (options.requirementDrift !== true && options.transitionDrift !== true)) {
    return pipeline;
  }
  const next = clone(pipeline);
  next.version += 1;
  next.updatedAt = daysAgo(0, 1);
  if (options.requirementDrift === true) {
    const discovery = next.stages.find((stage) => stage.id === S_DISCOVERY.id);
    discovery?.requirements.push(clone(R_DRIFT));
  }
  if (options.transitionDrift === true) {
    next.transitions = next.transitions.filter((pair) => !(pair.fromStageId === S_QUALIFIED.id && pair.toStageId === S_DISCOVERY.id));
  }
  return checkPipeline(next);
}

const PIPELINES: readonly PipelineConfig[] = [PIPELINE_ONE, PIPELINE_TWO];

/** The pipeline summaries in listPipelines order: name, then id. */
export function pipelineSummaries(): Json[] {
  return [...PIPELINES]
    .sort((a, b) => (a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.id < b.id ? -1 : 1))
    .map((pipeline) => ({
      id: pipeline.id,
      programmeId: pipeline.programmeId,
      name: pipeline.name,
      version: pipeline.version,
      createdAt: pipeline.createdAt,
      updatedAt: pipeline.updatedAt,
    }));
}

// ---------------------------------------------------------------------------
// Deals (the server's store, as the mock starts)
// ---------------------------------------------------------------------------

export interface Money {
  amountMinor: string;
  currency: string;
}

export interface StoredCheck {
  requirementId: string;
  checkedAt: string;
  checkedBy: Person;
}

/** One deal as the server holds it. Served as Deal, field security applied. */
export interface StoredDeal {
  id: string;
  pipelineId: string;
  stageId: string;
  version: number;
  name: string;
  amount: Money | null;
  expectedCloseDate: string | null;
  ownerUserId: string | null;
  contact: { id: string; displayName: string } | null;
  account: { id: string; name: string } | null;
  nextStep: string | null;
  stageEnteredAt: string;
  closedAt: string | null;
  checks: StoredCheck[];
  createdAt: string;
  updatedAt: string;
}

const DEAL_SCHEMA = schema('Deal');

function pipelineOf(id: string): PipelineConfig {
  const pipeline = PIPELINES.find((candidate) => candidate.id === id);
  if (pipeline === undefined) throw new Error(`no pipeline ${id}`);
  return pipeline;
}

function stageIn(pipeline: PipelineConfig, stageId: string): Stage | undefined {
  return pipeline.stages.find((stage) => stage.id === stageId);
}

function ownerName(id: string): string | null {
  if (id === ME.id) return ME.displayName;
  if (id === OTHER.id) return OTHER.displayName;
  return null;
}

/** DealRotting at NOW, from the stage's own days (the server's rule). */
export function rottingOf(stage: Stage, stageEnteredAt: string): 'fresh' | 'stale' | 'rotting' | null {
  if (stage.kind !== 'open' || stage.rottingAfterDays === null) return null;
  const days = Math.floor((NOW_MS - Date.parse(stageEnteredAt)) / DAY);
  if (days >= stage.rottingAfterDays) return 'rotting';
  if (days >= Math.floor(stage.rottingAfterDays / 2)) return 'stale';
  return 'fresh';
}

/** The Deal this caller is served for `row`: withheld fields omitted and named. */
export function asDeal(row: StoredDeal, config: PipelineConfig = pipelineOf(row.pipelineId)): Json {
  const stage = stageIn(config, row.stageId) ?? stageIn(pipelineOf(row.pipelineId), row.stageId);
  if (stage === undefined) throw new Error(`deal ${row.id} sits in no stage of its pipeline`);
  const withheld = withheldIn(config.programmeId);
  const out: Json = {
    id: row.id,
    programmeId: config.programmeId,
    pipelineId: row.pipelineId,
    stageId: row.stageId,
    version: row.version,
    name: row.name,
    amount: clone(row.amount),
    weightedAmount: row.amount === null ? null : { amountMinor: weightedMinor(row.amount.amountMinor, stage.probabilityBp), currency: row.amount.currency },
    expectedCloseDate: row.expectedCloseDate,
    ownerUserId: row.ownerUserId,
    owner: row.ownerUserId === null ? null : { id: row.ownerUserId, displayName: ownerName(row.ownerUserId) },
    primaryContactId: row.contact?.id ?? null,
    contact: clone(row.contact),
    accountId: row.account?.id ?? null,
    account: clone(row.account),
    nextStep: row.nextStep,
    stageEnteredAt: row.stageEnteredAt,
    closedAt: row.closedAt,
    rotting: rottingOf(stage, row.stageEnteredAt),
    checks: clone(row.checks),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    withheldFields: [...withheld],
  };
  const alsoOmitted: Readonly<Record<string, string>> = {
    amount: 'weightedAmount',
    ownerUserId: 'owner',
    primaryContactId: 'contact',
    accountId: 'account',
  };
  for (const field of withheld) {
    delete out[field];
    const also = alsoOmitted[field];
    if (also !== undefined) delete out[also];
  }
  return out;
}

function check(row: StoredDeal): StoredDeal {
  const problems = validateBody(asDeal(row), DEAL_SCHEMA, `deal ${row.id}`, CONTRACT, true);
  if (problems.length > 0) {
    throw new Error(`deal ${row.id} disagrees with ${RECORDS_CONTRACT_SOURCE}: ${problems.join('; ')}`);
  }
  return row;
}

export const DEAL_ID = (n: number): string => `2b3c4d5e-6f7a-4b8c-9d0e-${n.toString(16).padStart(12, '0')}`;

/** Contacts and accounts (closed summaries: an id and a name). */
export const C_ALPHA = { id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e01', displayName: 'Synthetic Buyer Alpha' };
export const C_BETA = { id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e42', displayName: 'Synthetic Buyer Beta' };
/** In PROGRAMME_TWO; matches the same search as C_ALPHA. Never offered for a PROGRAMME_ONE deal. */
export const C_ALPHA_ELSEWHERE = { id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e41', displayName: 'Synthetic Buyer Alphabet' };
export const A_PHARMACY = { id: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01', name: 'Synthetic Pharmacy Group' };

export const HOSTILE_NAME = '<img src=x onerror="window.__kasuwaXss=1">Synthetic <b>bold</b> deal';
/** Under `hostileSummaries`: summary ids that are not uuids. The screen must link neither. */
export const HOSTILE_CONTACT_ID = '../../admin/audit?export=1#x';
export const HOSTILE_ACCOUNT_ID = 'javascript:alert(1)//';

function deal(n: number, stage: Stage, name: string, extra: Partial<StoredDeal> = {}): StoredDeal {
  return check({
    id: DEAL_ID(n),
    pipelineId: PIPELINE_ONE.id,
    stageId: stage.id,
    version: 1,
    name,
    amount: null,
    expectedCloseDate: null,
    ownerUserId: ME.id,
    contact: null,
    account: null,
    nextStep: null,
    stageEnteredAt: daysAgo(1),
    closedAt: stage.kind === 'open' ? null : (extra.stageEnteredAt ?? daysAgo(1)),
    checks: [],
    createdAt: daysAgo(30),
    updatedAt: extra.stageEnteredAt ?? daysAgo(1),
    ...extra,
  });
}

const ngn = (amountMinor: string): Money => ({ amountMinor, currency: 'NGN' });
const ticked = (requirement: Requirement, when: string): StoredCheck => ({ requirementId: requirement.id, checkedAt: when, checkedBy: clone(ME) });

// Qualified (10%, rotting 14: stale from 7 days).
/** 2 days in Qualified: fresh. Version 2. */
export const D_Q1 = deal(0x101, S_QUALIFIED, 'Haulage pilot north', {
  amount: ngn('3100000005'),
  expectedCloseDate: '2026-12-15',
  stageEnteredAt: daysAgo(2),
  nextStep: 'Discovery call on Wednesday',
  version: 2,
});
/** 8 days in Qualified: stale. Unassigned. */
export const D_Q2 = deal(0x102, S_QUALIFIED, 'Retail terminals east', {
  amount: ngn('560000025'),
  ownerUserId: null,
  stageEnteredAt: daysAgo(8),
});
/** Owned by OTHER: an agent may not move it (403). */
export const D_Q_OTHER = deal(0x103, S_QUALIFIED, 'Courier fleet trial', {
  amount: ngn('125000000'),
  ownerUserId: OTHER.id,
  stageEnteredAt: daysAgo(1),
});
/** Markup in a name: drawn as text, never parsed. No amount (counted, adds to no total). */
export const D_Q_MARKUP = deal(0x104, S_QUALIFIED, HOSTILE_NAME, {
  stageEnteredAt: daysAgo(1, 2),
  contact: clone(C_BETA),
});

// Discovery (25%, rotting 14).
/** 15 days in Discovery: rotting. Its account summary links. */
export const D_D1 = deal(0x201, S_DISCOVERY, 'Pharmacy chain rollout', {
  amount: ngn('975000000'),
  expectedCloseDate: '2026-10-31',
  stageEnteredAt: daysAgo(15),
  account: clone(A_PHARMACY),
  version: 4,
});
/** No amount, a former owner: counted, no total, owner "Former owner". 9 days: stale. */
export const D_D2 = deal(0x202, S_DISCOVERY, 'Estates messaging', {
  ownerUserId: FORMER_OWNER_ID,
  stageEnteredAt: daysAgo(9),
});
/** Eighteen nines of kobo: exact only as a string (2^53 is sixteen digits). */
export const D_BIG = deal(0x203, S_DISCOVERY, 'National grid programme', {
  amount: ngn('999999999999999999'),
  stageEnteredAt: daysAgo(0, 2),
});

// Proposal (50%, rotting 14): two currencies, and the half-even pair.
/** Has its budget check; no close date; to Negotiation the prompt asks the close date and the quote check. */
export const D_P1 = deal(0x301, S_PROPOSAL, 'Agro inputs supply', {
  amount: ngn('2200000000'),
  stageEnteredAt: daysAgo(3),
  checks: [ticked(R_BUDGET, daysAgo(3))],
  version: 6,
});
export const D_P2 = deal(0x302, S_PROPOSAL, 'Distributor pilot west', {
  amount: { amountMinor: '4500003', currency: 'GHS' },
  expectedCloseDate: '2026-11-06',
  stageEnteredAt: daysAgo(4),
  checks: [ticked(R_BUDGET, daysAgo(4))],
  version: 3,
});
/** Weighted 500000000.5 each, half-even to 500000000: summed 1000000000, never 1000000001. */
export const D_P3 = deal(0x303, S_PROPOSAL, 'Cold-chain lockers A', {
  amount: ngn('1000000001'),
  ownerUserId: OTHER.id,
  stageEnteredAt: daysAgo(5),
  checks: [ticked(R_BUDGET, daysAgo(5))],
});
export const D_P4 = deal(0x304, S_PROPOSAL, 'Cold-chain lockers B', {
  amount: ngn('1000000001'),
  ownerUserId: OTHER.id,
  stageEnteredAt: daysAgo(5, 1),
  checks: [ticked(R_BUDGET, daysAgo(5))],
});

// Negotiation (70%, rotting 14).
/** 10 days: stale. To Contract the prompt asks the primary contact (picker) and the PO check. */
export const D_N1 = deal(0x401, S_NEGOTIATION, 'Foods Q4 supply', {
  amount: ngn('1500000015'),
  expectedCloseDate: '2026-10-31',
  stageEnteredAt: daysAgo(10),
  checks: [ticked(R_BUDGET, daysAgo(20)), ticked(R_QUOTE, daysAgo(10))],
  version: 5,
});
/** Kenyan shillings; its contact summary links. */
export const D_N2 = deal(0x402, S_NEGOTIATION, 'Kiosk network east', {
  amount: { amountMinor: '7500000', currency: 'KES' },
  expectedCloseDate: '2026-11-20',
  stageEnteredAt: daysAgo(1),
  contact: clone(C_ALPHA),
  checks: [ticked(R_BUDGET, daysAgo(9)), ticked(R_QUOTE, daysAgo(1))],
  version: 2,
});

// Contract (90%, rotting 21: stale from 10). The design's fixed 7/14 rule disagrees with all three.
const contractChecks = [ticked(R_BUDGET, daysAgo(40)), ticked(R_QUOTE, daysAgo(30)), ticked(R_PO, daysAgo(25))];
/** 8 days: FRESH (the design's 7-day rule would call it stale). Rand. */
export const D_C1 = deal(0x501, S_CONTRACT, 'Insurance desk rollout', {
  amount: { amountMinor: '125000000', currency: 'ZAR' },
  expectedCloseDate: '2026-11-30',
  stageEnteredAt: daysAgo(8),
  contact: clone(C_ALPHA),
  checks: clone(contractChecks),
  version: 3,
});
/** 15 days: STALE (the design's 14-day rule would call it rotting). */
export const D_C2 = deal(0x502, S_CONTRACT, 'Telco retail upgrade', {
  amount: ngn('880000000'),
  expectedCloseDate: '2026-10-20',
  stageEnteredAt: daysAgo(15),
  contact: clone(C_ALPHA),
  checks: clone(contractChecks),
  version: 2,
});
/** 21 days: rotting. */
export const D_C3 = deal(0x503, S_CONTRACT, 'School fees platform', {
  amount: ngn('310000000'),
  expectedCloseDate: '2026-10-15',
  stageEnteredAt: daysAgo(21),
  contact: clone(C_ALPHA),
  checks: clone(contractChecks),
  version: 2,
});

// Won and lost.
/** Closed 10 days ago: in the default 90-day window. */
export const D_W1 = deal(0x601, S_WON, 'Haulage pilot south', { amount: ngn('4500000000'), stageEnteredAt: daysAgo(10), version: 9 });
/** Closed 200 days ago: only with a window of more than 200 days. */
export const D_W2 = deal(0x602, S_WON, 'Clinic scheduling', { amount: ngn('220000000'), stageEnteredAt: daysAgo(200), version: 7 });
/** Closed 400 days ago: beyond any window the server allows. */
export const D_W3 = deal(0x603, S_WON, 'Archive digitisation', { amount: ngn('99000000'), stageEnteredAt: daysAgo(400), version: 7 });
/** Lost 5 days ago: listDeals only, never a board column. */
export const D_L1 = deal(0x701, S_LOST, 'Kiosk pilot north', { amount: ngn('150000000'), stageEnteredAt: daysAgo(5), version: 4 });
/** Lost 100 days ago: outside the default window. */
export const D_L2 = deal(0x702, S_LOST, 'Fleet tracking', { amount: ngn('90000000'), stageEnteredAt: daysAgo(100), version: 4 });

// PIPELINE_TWO (amount, owner and close date withheld from the caller).
function fieldDeal(n: number, stage: Stage, name: string, extra: Partial<StoredDeal> = {}): StoredDeal {
  return check({ ...deal(n, S_QUALIFIED, name), pipelineId: PIPELINE_TWO.id, stageId: stage.id, ...extra });
}
export const E_Q1 = fieldDeal(0x801, T_QUALIFIED, 'Field survey north', { amount: ngn('200000000'), expectedCloseDate: '2026-11-11' });
/** To Negotiation, whose amount and close date the caller cannot read: the move is 403 field_not_editable. */
export const E_P1 = fieldDeal(0x803, T_PROPOSAL, 'Field survey south', {
  amount: ngn('350000000'),
  stageEnteredAt: daysAgo(2),
  checks: [{ requirementId: requirementOf(T_PROPOSAL, 0).id, checkedAt: daysAgo(2), checkedBy: clone(ME) }],
  version: 3,
});

const BASE: readonly StoredDeal[] = [
  D_Q1, D_Q2, D_Q_OTHER, D_Q_MARKUP,
  D_D1, D_D2, D_BIG,
  D_P1, D_P2, D_P3, D_P4,
  D_N1, D_N2,
  D_C1, D_C2, D_C3,
  D_W1, D_W2, D_W3,
  D_L1, D_L2,
  E_Q1, E_P1,
];

/** A letters-only suffix, so generated names carry no digit a count check could mistake. */
function letters(n: number): string {
  const a = 'abcdefghijklmnopqrstuvwxyz';
  return `${a[Math.floor(n / 26) % 26] ?? 'a'}${a[n % 26] ?? 'a'}`;
}

/**
 * More Qualified deals than the board's largest legal `limit` (50), with no
 * amount (the totals are unchanged): whatever limit the screen sends, the
 * column has a next page. Together the list then holds more than 25 rows.
 */
export const BIG_COLUMN_LENGTH = 60;
function bigColumn(): StoredDeal[] {
  return Array.from({ length: BIG_COLUMN_LENGTH }, (_, n) =>
    check({
      ...deal(0x900 + n, S_QUALIFIED, `Generated prospect ${letters(n)}`),
      stageEnteredAt: new Date(NOW_MS - 3 * DAY + n * 60_000).toISOString(),
      updatedAt: new Date(NOW_MS - 3 * DAY + n * 60_000).toISOString(),
    }),
  );
}

/** The deal somebody else creates under `concurrentArrival`. */
export const ARRIVAL_ID = DEAL_ID(0xa01);
export const ARRIVAL_AMOUNT = '100000000';

/** The base store, for the spec's oracles (deals of both pipelines). */
export function baseDeals(): readonly StoredDeal[] {
  return BASE;
}

function initialStore(options: PipelineMockOptions): StoredDeal[] {
  if (options.empty === true) return [];
  const rows = BASE.map((row) => clone(row));
  if (options.bigColumn === true) rows.push(...bigColumn());
  if (options.hostileSummaries === true) {
    const target = rows.find((row) => row.id === D_Q_MARKUP.id);
    if (target !== undefined) {
      target.contact = { id: HOSTILE_CONTACT_ID, displayName: 'Synthetic Hostile Contact' };
      target.account = { id: HOSTILE_ACCOUNT_ID, name: 'Synthetic Hostile Account' };
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Filters, ordering and the board (the server's rules)
// ---------------------------------------------------------------------------

export interface Filters {
  q: string | null;
  owner: string[];
  closeFrom: string | null;
  closeTo: string | null;
  currency: string[];
  closedSince: string | null;
}

export const NO_FILTERS: Filters = { q: null, owner: [], closeFrom: null, closeTo: null, currency: [], closedSince: null };

function filtersOf(url: URL): Filters {
  return {
    q: url.searchParams.get('q'),
    owner: url.searchParams.getAll('owner'),
    closeFrom: url.searchParams.get('closeFrom'),
    closeTo: url.searchParams.get('closeTo'),
    currency: url.searchParams.getAll('currency'),
    closedSince: url.searchParams.get('closedSince'),
  };
}

function filtersKey(filters: Filters): string {
  return JSON.stringify({ ...filters, owner: [...filters.owner].sort(), currency: [...filters.currency].sort() });
}

/** Case- and diacritic-insensitive; `%` and `_` are literal (D-L115). */
function folded(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function selects(row: StoredDeal, filters: Filters): boolean {
  if (filters.q !== null && !folded(row.name).includes(folded(filters.q))) return false;
  if (filters.owner.length > 0) {
    const matches = filters.owner.some((value) =>
      value === 'me' ? row.ownerUserId === ME.id : value === 'unassigned' ? row.ownerUserId === null : row.ownerUserId?.toLowerCase() === value.toLowerCase(),
    );
    if (!matches) return false;
  }
  if (filters.closeFrom !== null && (row.expectedCloseDate === null || row.expectedCloseDate < filters.closeFrom)) return false;
  if (filters.closeTo !== null && (row.expectedCloseDate === null || row.expectedCloseDate > filters.closeTo)) return false;
  if (filters.currency.length > 0 && (row.amount === null || !filters.currency.includes(row.amount.currency))) return false;
  return true;
}

function sinceMs(filters: Filters): number {
  return Date.parse(filters.closedSince ?? DEFAULT_CLOSED_SINCE);
}

function byKey(key: (row: StoredDeal) => string, direction: 1 | -1) {
  return (a: StoredDeal, b: StoredDeal): number => {
    const left = key(a);
    const right = key(b);
    if (left !== right) return (left < right ? -1 : 1) * direction;
    return (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * direction;
  };
}

/** What one board column holds, in order, before paging (the contract's rule). */
export function columnRows(store: readonly StoredDeal[], pipelineId: string, stageId: string, filters: Filters = NO_FILTERS): StoredDeal[] {
  const pipeline = pipelineOf(pipelineId);
  const stage = stageIn(pipeline, stageId);
  if (stage === undefined || stage.kind === 'lost') return [];
  const rows = store.filter((row) => row.pipelineId === pipelineId && row.stageId === stageId && selects(row, filters));
  if (stage.kind === 'won') {
    return rows.filter((row) => row.closedAt !== null && Date.parse(row.closedAt) >= sinceMs(filters)).sort(byKey((row) => row.closedAt ?? '', -1));
  }
  return rows.sort(byKey((row) => row.stageEnteredAt, 1));
}

/** One column's exact totals, per currency, sorted by code (D-P19). */
export function columnTotals(rows: readonly StoredDeal[], stage: Stage): { currency: string; amountMinor: string; weightedAmountMinor: string }[] {
  const sums = new Map<string, { amount: bigint; weighted: bigint }>();
  for (const row of rows) {
    if (row.amount === null) continue;
    const sum = sums.get(row.amount.currency) ?? { amount: 0n, weighted: 0n };
    sum.amount += BigInt(row.amount.amountMinor);
    sum.weighted += BigInt(weightedMinor(row.amount.amountMinor, stage.probabilityBp));
    sums.set(row.amount.currency, sum);
  }
  return [...sums.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([currency, sum]) => ({ currency, amountMinor: sum.amount.toString(), weightedAmountMinor: sum.weighted.toString() }));
}

/** The board's columns: every open stage, then won, in position order. Never lost. */
export function boardStages(pipeline: PipelineConfig): Stage[] {
  return [...pipeline.stages].filter((stage) => stage.kind !== 'lost').sort((a, b) => a.position - b.position);
}

/** What listDeals serves, in order, before paging. */
export function listRows(store: readonly StoredDeal[], pipelineId: string, filters: Filters, stageIds: readonly string[], sort: string): StoredDeal[] {
  const pipeline = pipelineOf(pipelineId);
  const since = sinceMs(filters);
  const rows = store.filter((row) => {
    if (row.pipelineId !== pipelineId || !selects(row, filters)) return false;
    if (stageIds.length > 0 && !stageIds.includes(row.stageId)) return false;
    const stage = stageIn(pipeline, row.stageId);
    if (stage !== undefined && stage.kind !== 'open') return row.closedAt !== null && Date.parse(row.closedAt) >= since;
    return true;
  });
  const direction: 1 | -1 = sort.startsWith('-') ? -1 : 1;
  const field = sort.replace(/^-/, '') as 'updatedAt' | 'createdAt' | 'name' | 'stageEnteredAt';
  return rows.sort(byKey((row) => row[field], direction));
}

// ---------------------------------------------------------------------------
// The pickers' contacts and accounts (listContacts / listAccounts with `q`)
// ---------------------------------------------------------------------------

const CONTACT_EXAMPLE = clone(
  at(CONTRACT, 'paths', CONTACTS_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', '0'),
) as Json;
const ACCOUNT_EXAMPLE = clone(
  at(CONTRACT, 'paths', ACCOUNTS_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', '0'),
) as Json;

function contactRow(summary: { id: string; displayName: string }, programmeId: string, phone: string): Json {
  const [givenNames, ...rest] = summary.displayName.split(' ');
  return {
    ...clone(CONTACT_EXAMPLE),
    id: summary.id,
    programmeId,
    displayName: summary.displayName,
    givenNames: givenNames ?? summary.displayName,
    familyName: rest.join(' '),
    companyName: null,
    phones: [{ type: 'mobile', e164: phone }],
    ownerUserId: ME.id,
    owner: clone(ME),
    tags: [],
  };
}

export const PICK_CONTACTS: readonly Json[] = [
  contactRow(C_ALPHA, PROGRAMME_ONE.id, '+2348030000901'),
  contactRow(C_ALPHA_ELSEWHERE, PROGRAMME_TWO.id, '+2348030000902'),
  contactRow(C_BETA, PROGRAMME_ONE.id, '+2348030000903'),
];

export const PICK_ACCOUNTS: readonly Json[] = [
  { ...clone(ACCOUNT_EXAMPLE), id: A_PHARMACY.id, name: A_PHARMACY.name, owner: clone(ME), ownerUserId: ME.id, tags: [], phones: [] },
];

for (const [operation, rows] of [
  ['listContacts', PICK_CONTACTS],
  ['listAccounts', PICK_ACCOUNTS],
] as const) {
  const problems = answerProblems(operation, 200, { data: rows, nextCursor: null });
  if (problems.length > 0) {
    throw new Error(`the ${operation} picker rows disagree with ${RECORDS_CONTRACT_SOURCE}: ${problems.join('; ')}`);
  }
}

{
  const problems = answerProblems('getCurrentUser', 200, CURRENT_USER);
  if (problems.length > 0) throw new Error(`CURRENT_USER disagrees with ${AUTH_CONTRACT_SOURCE}: ${problems.join('; ')}`);
}

/** Everything the mock serves as record data, for checks that tell it from UI copy (en-XA). */
export function servedData(): string {
  return JSON.stringify({
    pipelines: PIPELINES,
    drift: R_DRIFT,
    deals: [...BASE, ...bigColumn()].map((row) => ({ ...row, rendered: asDeal(row) })),
    hostile: [HOSTILE_NAME, 'Synthetic Hostile Contact', 'Synthetic Hostile Account'],
    contacts: PICK_CONTACTS,
    accounts: PICK_ACCOUNTS,
    people: [ME, OTHER],
    programmes: [PROGRAMME_ONE, PROGRAMME_TWO],
    me: CURRENT_USER,
    arrival: 'Arrived from another desk',
  });
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export interface PipelineMockOptions {
  /** The caller's rights in every programme. Default `team_lead` (`deal.write_any`). */
  readonly role?: 'team_lead' | 'agent' | 'qa_analyst';
  /** Hold every read until `release()`: the loading frame, without a clock. */
  readonly hold?: boolean;
  /** Abort every read, as a dropped connection does. */
  readonly networkFailure?: boolean;
  /** Abort every getPipelineBoard read. */
  readonly boardFailure?: boolean;
  /** Abort every board read that pages this stage (`stageId` and `cursor`). */
  readonly columnFailure?: string;
  /** Abort every listDeals read. */
  readonly listFailure?: boolean;
  /** Hold every write until `releaseWrites()`. */
  readonly holdWrites?: boolean;
  /** No deal in any pipeline. */
  readonly empty?: boolean;
  /** The caller reaches no pipeline at all. */
  readonly noPipelines?: boolean;
  /** Add BIG_COLUMN_LENGTH deals to Qualified. */
  readonly bigColumn?: boolean;
  /** Serve D_Q_MARKUP's contact and account summaries with ids that are not uuids. */
  readonly hostileSummaries?: boolean;
  /** Somebody else writes `dealId` before each of the screen's moves of it lands: a 409 each. */
  readonly concurrent?: { readonly dealId: string; readonly changes: readonly Readonly<Partial<Record<'expectedCloseDate' | 'nextStep', string>>>[] };
  /** After the screen's first successful move, somebody else creates a deal in this stage. */
  readonly concurrentArrival?: { readonly stageId: string };
  /** The server added R_DRIFT to Discovery after the screen's first getPipeline. */
  readonly requirementDrift?: boolean;
  /** The server removed Qualified → Discovery from the allow-list after the screen's first getPipeline. */
  readonly transitionDrift?: boolean;
}

export interface RecordedWrite {
  readonly method: 'POST';
  readonly path: string;
  readonly body: unknown;
  status?: number;
}

export interface PipelineMock {
  /** Every request the mock answered, in order. */
  readonly requests: URL[];
  /** getPipeline reads, in order. */
  readonly pipelineReads: URL[];
  /** getPipelineBoard reads, in order. */
  readonly boardReads: URL[];
  /** listDeals reads, in order. */
  readonly listReads: URL[];
  /** listContacts and listAccounts reads, in order. */
  readonly pickerReads: URL[];
  /** Every write, in order, with the status it was answered. */
  readonly writes: RecordedWrite[];
  /** Contract breaches by the SCREEN. Must be empty at the end of every test. */
  readonly violations: string[];
  /** Answers the MOCK built that its contract rejects. Must be empty, always. */
  readonly mockFaults: string[];
  /** The deliberate contract breaches `hostileSummaries` serves. */
  readonly plantedFaults: string[];
  /** The deals as they now stand. */
  readonly store: StoredDeal[];
  /** Every cursor the mock issued. */
  issuedCursors(): string[];
  release(): void;
  releaseWrites(): void;
}

export function isBoardRead(request: Request, pipelineId?: string): boolean {
  const path = new URL(request.url()).pathname;
  return request.method() === 'GET' && /^\/api\/v1\/pipelines\/[^/]+\/board$/.test(path) && (pipelineId === undefined || path === `${PIPELINES_PATH}/${pipelineId}/board`);
}

export function isListDeals(request: Request): boolean {
  return request.method() === 'GET' && /^\/api\/v1\/pipelines\/[^/]+\/deals$/.test(new URL(request.url()).pathname);
}

export function isGetPipeline(request: Request): boolean {
  return request.method() === 'GET' && /^\/api\/v1\/pipelines\/[^/]+$/.test(new URL(request.url()).pathname);
}

export function isCreateDeal(request: Request): boolean {
  return request.method() === 'POST' && /^\/api\/v1\/pipelines\/[^/]+\/deals$/.test(new URL(request.url()).pathname);
}

export function isMoveDeal(request: Request, dealId?: string): boolean {
  const path = new URL(request.url()).pathname;
  return request.method() === 'POST' && (dealId === undefined ? /^\/api\/v1\/deals\/[^/]+\/move$/.test(path) : path === `${DEALS_PATH}/${dealId}/move`);
}

const CREATE_SCHEMA = schema('CreateDealRequest');
const MOVE_SCHEMA = schema('MoveDealRequest');
const PICKER_PARAMETERS = ['q', 'limit', 'cursor', 'sort'];
const FIELD_PATHS: Readonly<Record<string, keyof StoredDeal>> = {
  amount: 'amount',
  expectedCloseDate: 'expectedCloseDate',
  nextStep: 'nextStep',
  primaryContactId: 'contact',
  accountId: 'account',
};

/** Server time for the n-th write: after NOW. */
function serverTime(n: number): string {
  return new Date(NOW_MS + n * 1000).toISOString();
}

export async function installPipelineMock(page: Page, options: PipelineMockOptions = {}): Promise<PipelineMock> {
  const role = options.role ?? 'team_lead';
  const store = initialStore(options);
  const requests: URL[] = [];
  const pipelineReads: URL[] = [];
  const boardReads: URL[] = [];
  const listReads: URL[] = [];
  const pickerReads: URL[] = [];
  const writes: RecordedWrite[] = [];
  const violations: string[] = [];
  const mockFaults: string[] = [];
  const plantedFaults: string[] = [];
  /** Versions served per deal: a move must name one of them. */
  const servedVersions = new Map<string, Set<number>>();
  /** The row as served, per deal and version: "sent unchanged" is judged against it. */
  const servedRows = new Map<string, Map<number, StoredDeal>>();
  /** Versions already answered 409 per deal: sending one again is a blind retry. */
  const refusedVersions = new Map<string, Set<number>>();
  /** Values somebody else overwrote concurrently: sending one back undoes their save. */
  const overwritten = new Map<string, Map<string, string>>();
  /** What the screen last read of each pipeline (its config): judged for local allow-list violations. */
  const screenConfig = new Map<string, PipelineConfig>();
  /** Picker rows served: a move may name only these. */
  const servedTargets = new Map<string, string>();
  const boardCursors = new Map<string, { pipelineId: string; stageId: string; key: string; afterId: string }>();
  const listCursors = new Map<string, { pipelineId: string; key: string; afterId: string }>();
  const issued: string[] = [];
  let cursorCount = 0;
  let writeCount = 0;
  let createCount = 0;
  let concurrentStep = 0;
  let arrived = false;
  const pipelineReadCount = new Map<string, number>();

  let release: () => void = () => undefined;
  const gate = options.hold === true ? new Promise<void>((done) => (release = done)) : Promise.resolve();
  let releaseWrites: () => void = () => undefined;
  const writeGate = options.holdWrites === true ? new Promise<void>((done) => (releaseWrites = done)) : Promise.resolve();

  /** The server's CURRENT configuration (drifted from the start). */
  const serverConfig = (pipeline: PipelineConfig): PipelineConfig => drifted(pipeline, options);

  /**
   * A problem is planted only if it goes away when the hostile ids are replaced
   * by well-formed ones: anything else wrong with the same answer is still the
   * mock's fault.
   */
  const sanitised = (body: unknown): unknown =>
    JSON.parse(
      JSON.stringify(body)
        .split(JSON.stringify(HOSTILE_CONTACT_ID))
        .join(JSON.stringify(C_BETA.id))
        .split(JSON.stringify(HOSTILE_ACCOUNT_ID))
        .join(JSON.stringify(A_PHARMACY.id)),
    ) as unknown;

  const answer = (route: Route, operation: Operation, status: number, body: unknown): Promise<void> => {
    const honest = new Set(options.hostileSummaries === true ? answerProblems(operation, status, sanitised(body)) : []);
    for (const problem of answerProblems(operation, status, body)) {
      (options.hostileSummaries === true && !honest.has(problem) ? plantedFaults : mockFaults).push(problem);
    }
    return route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify(body),
    });
  };

  const serve = (row: StoredDeal, config?: PipelineConfig): Json => {
    const versions = servedVersions.get(row.id) ?? new Set<number>();
    versions.add(row.version);
    servedVersions.set(row.id, versions);
    const rows = servedRows.get(row.id) ?? new Map<number, StoredDeal>();
    rows.set(row.version, clone(row));
    servedRows.set(row.id, rows);
    return asDeal(row, config ?? serverConfig(pipelineOf(row.pipelineId)));
  };

  const checkHeaders = (request: Request, label: string): void => {
    for (const header of Object.keys(request.headers())) {
      if (/programme|tenant/i.test(header)) {
        violations.push(`${label} was sent a "${header}" header — scope is never supplied`);
      }
    }
  };

  const readBody = (request: Request, label: string): unknown => {
    try {
      return request.postDataJSON() as unknown;
    } catch {
      violations.push(`${label} body is not JSON`);
      return undefined;
    }
  };

  /** Shape problems with a query: undeclared or repeated parameters and an out-of-range limit. */
  const checkQuery = (url: URL, allowed: readonly string[], repeatable: readonly string[], operation: string, maxLimit: number): string[] => {
    const problems: string[] = [];
    for (const name of new Set(url.searchParams.keys())) {
      if (!allowed.includes(name)) problems.push(`${operation} declares no "${name}" parameter`);
      if (!repeatable.includes(name) && url.searchParams.getAll(name).length > 1) problems.push(`${name} was sent more than once`);
    }
    const rawLimit = url.searchParams.get('limit');
    if (rawLimit !== null) {
      const limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) problems.push(`limit=${rawLimit} is outside 1..${maxLimit}, which the API refuses, never clamps`);
    }
    return problems;
  };

  /**
   * The board's and the list's shared filter rules. Returns the contract's 400
   * body for the first refusal, or null. Every refusal is the screen's fault.
   */
  const checkFilters = (url: URL, pipeline: PipelineConfig, label: string): Json | null => {
    const filters = filtersOf(url);
    const withheld = withheldIn(pipeline.programmeId);
    const refuse = (path: string, code: string, why: string): Json => {
      violations.push(`${label}: ${why}`);
      return validation([{ path, code }]);
    };
    if (filters.q !== null && (filters.q.length < 1 || filters.q.length > 100 || filters.q.includes('\u0000'))) {
      return refuse('q', 'invalid_string', `q is ${filters.q.length} characters or carries a NUL (1..100)`);
    }
    for (const value of filters.owner) {
      if (!/^(me|unassigned)$/.test(value) && !UUID_PATTERN.test(value)) return refuse('owner', 'invalid_string', `owner=${value} is not me, unassigned or a user id`);
    }
    for (const name of ['closeFrom', 'closeTo'] as const) {
      const value = filters[name];
      if (value !== null && !validDate(value)) return refuse(name, 'invalid_string', `${name}=${value} is not a calendar date`);
    }
    if (filters.closeFrom !== null && filters.closeTo !== null && filters.closeTo < filters.closeFrom) {
      return refuse('closeTo', 'invalid_window', 'closeTo is before closeFrom');
    }
    for (const value of filters.currency) {
      if (!CURRENCIES.includes(value)) return refuse('currency', 'unknown_currency', `currency=${value} is not one of ${CURRENCIES.join(', ')}`);
    }
    if (filters.closedSince !== null) {
      const since = Date.parse(filters.closedSince);
      if (!UTC_DATE_TIME.test(filters.closedSince) || Number.isNaN(since)) {
        return refuse('closedSince', 'invalid_string', `closedSince=${filters.closedSince} is not a UTC date-time with a Z`);
      }
      if (since < EARLIEST_CLOSED_SINCE_MS) return refuse('closedSince', 'window_too_long', 'closedSince reaches back more than 366 days (never clamped)');
      if (since > NOW_MS) return refuse('closedSince', 'invalid_window', 'closedSince is in the future');
    }
    const withheldFilter: readonly (readonly [string, boolean, string])[] = [
      ['owner', filters.owner.length > 0, 'ownerUserId'],
      ['closeFrom', filters.closeFrom !== null, 'expectedCloseDate'],
      ['closeTo', filters.closeTo !== null, 'expectedCloseDate'],
      ['currency', filters.currency.length > 0, 'amount'],
    ];
    for (const [parameter, sent, field] of withheldFilter) {
      if (sent && withheld.includes(field)) {
        return refuse(parameter, 'field_withheld', `${parameter} filters on ${field}, which the board said is withheld — it must not be offered`);
      }
    }
    return null;
  };

  const nextCursorFor = (prefix: string): string => {
    cursorCount += 1;
    const cursor = `${prefix}_${String(cursorCount).padStart(4, '0')}_k7Qz`;
    issued.push(cursor);
    return cursor;
  };

  const resolvePipeline = (route: Route, rawId: string, operation: Operation): PipelineConfig | undefined => {
    const id = decodeURIComponent(rawId);
    if (!UUID_PATTERN.test(id)) {
      violations.push(`${operation} was sent "${id}", which is not a uuid: a malformed route id is a real 404 that reads nothing`);
      void answer(route, operation, 404, notFound());
      return undefined;
    }
    const pipeline = options.noPipelines === true ? undefined : PIPELINES.find((candidate) => candidate.id === id.toLowerCase());
    if (pipeline === undefined) {
      void answer(route, operation, 404, notFound());
      return undefined;
    }
    return pipeline;
  };

  // ----- listPipelines ---------------------------------------------------------

  const listPipelines = async (route: Route, url: URL): Promise<void> => {
    await gate;
    if (options.networkFailure === true) return route.abort('internetdisconnected');
    const problems = checkQuery(url, parameterNames('listPipelines'), [], 'listPipelines', 100);
    if (problems.length > 0) {
      violations.push(...problems.map((problem) => `${url.search}: ${problem}`));
      return answer(route, 'listPipelines', 400, validation(problems.map(() => ({ path: 'query', code: 'invalid_string' }))));
    }
    const rows = options.noPipelines === true ? [] : pipelineSummaries();
    const cursor = url.searchParams.get('cursor');
    let start = 0;
    if (cursor !== null) {
      const index = rows.findIndex((row) => `pl_${String(row.id)}` === cursor);
      if (index < 0) {
        violations.push(`listPipelines cursor "${cursor}" was never served`);
        return answer(route, 'listPipelines', 400, errorExample('DealValidationFailed', 'badCursor'));
      }
      start = index + 1;
    }
    const limit = Number(url.searchParams.get('limit') ?? LIST_DEFAULT_LIMIT);
    const data = rows.slice(start, start + limit);
    const last = data.at(-1);
    const nextCursor = start + limit < rows.length && last !== undefined ? `pl_${String(last.id)}` : null;
    if (nextCursor !== null) issued.push(nextCursor);
    return answer(route, 'listPipelines', 200, { data, nextCursor });
  };

  // ----- getPipeline -------------------------------------------------------------

  const getPipeline = async (route: Route, url: URL, rawId: string): Promise<void> => {
    pipelineReads.push(url);
    await gate;
    if (options.networkFailure === true) return route.abort('internetdisconnected');
    const pipeline = resolvePipeline(route, rawId, 'getPipeline');
    if (pipeline === undefined) return;
    if (url.search !== '') violations.push(`getPipeline takes no query; it was sent ${url.search}`);
    const reads = (pipelineReadCount.get(pipeline.id) ?? 0) + 1;
    pipelineReadCount.set(pipeline.id, reads);
    // Reconfigured after the screen's first read: the first read is the old one.
    const config = reads === 1 ? pipeline : serverConfig(pipeline);
    screenConfig.set(pipeline.id, clone(config));
    return answer(route, 'getPipeline', 200, clone(config));
  };

  // ----- getPipelineBoard -----------------------------------------------------------

  const board = async (route: Route, url: URL, rawId: string): Promise<void> => {
    boardReads.push(url);
    await gate;
    if (options.networkFailure === true || options.boardFailure === true) return route.abort('internetdisconnected');
    const pipeline = resolvePipeline(route, rawId, 'getPipelineBoard');
    if (pipeline === undefined) return;
    const config = serverConfig(pipeline);
    const problems = checkQuery(url, parameterNames('getPipelineBoard'), arrayParameters('getPipelineBoard'), 'getPipelineBoard', BOARD_LIMIT.schema.maximum);
    if (problems.length > 0) {
      violations.push(...problems.map((problem) => `${url.search}: ${problem}`));
      return answer(route, 'getPipelineBoard', 400, validation(problems.map(() => ({ path: 'query', code: 'invalid_string' }))));
    }
    const refused = checkFilters(url, pipeline, 'getPipelineBoard');
    if (refused !== null) return answer(route, 'getPipelineBoard', 400, refused);
    const filters = filtersOf(url);
    const key = filtersKey(filters);
    const stageId = url.searchParams.get('stageId');
    const cursor = url.searchParams.get('cursor');
    const columns = boardStages(config);
    if (stageId !== null && !columns.some((stage) => stage.id === stageId)) {
      violations.push(`getPipelineBoard stageId=${stageId} is not an open or won stage of this pipeline (lost is never a column)`);
      return answer(route, 'getPipelineBoard', 400, validation([{ path: 'stageId', code: 'unknown_reference' }]));
    }
    let afterId: string | undefined;
    if (cursor !== null) {
      const bound = boardCursors.get(cursor);
      if (stageId === null || bound === undefined || bound.pipelineId !== pipeline.id || bound.stageId !== stageId || bound.key !== key) {
        violations.push(`getPipelineBoard cursor "${cursor}" was not served for this column and these filters — echo it with its stageId and the same filters`);
        return answer(route, 'getPipelineBoard', 400, errorExample('DealValidationFailed', 'badCursor'));
      }
      if (options.columnFailure === stageId) return route.abort('internetdisconnected');
      afterId = bound.afterId;
    }
    const limit = Number(url.searchParams.get('limit') ?? BOARD_DEFAULT_LIMIT);
    const withheld = withheldIn(pipeline.programmeId);
    const stages = columns
      .filter((stage) => stageId === null || stage.id === stageId)
      .map((stage) => {
        const rows = columnRows(store, pipeline.id, stage.id, filters);
        const start = afterId === undefined ? 0 : rows.findIndex((row) => row.id === afterId) + 1;
        const cards = rows.slice(start, start + limit);
        const last = cards.at(-1);
        let nextCursor: string | null = null;
        if (start + limit < rows.length && last !== undefined) {
          nextCursor = nextCursorFor('col');
          boardCursors.set(nextCursor, { pipelineId: pipeline.id, stageId: stage.id, key, afterId: last.id });
        }
        const column: Json = { stageId: stage.id, count: rows.length };
        if (!withheld.includes('amount')) column.totals = columnTotals(rows, stage);
        column.cards = cards.map((row) => serve(row, config));
        column.nextCursor = nextCursor;
        return column;
      });
    return answer(route, 'getPipelineBoard', 200, {
      pipelineId: pipeline.id,
      closedSince: filters.closedSince ?? DEFAULT_CLOSED_SINCE,
      withheldFields: WITHHOLDABLE_FIELDS.filter((field) => withheld.includes(field)),
      stages,
    });
  };

  // ----- listDeals -------------------------------------------------------------------

  const listDeals = async (route: Route, url: URL, rawId: string): Promise<void> => {
    listReads.push(url);
    await gate;
    if (options.networkFailure === true || options.listFailure === true) return route.abort('internetdisconnected');
    const pipeline = resolvePipeline(route, rawId, 'listDeals');
    if (pipeline === undefined) return;
    const config = serverConfig(pipeline);
    const problems = checkQuery(url, parameterNames('listDeals'), arrayParameters('listDeals'), 'listDeals', 100);
    const sort = url.searchParams.get('sort') ?? '-updatedAt';
    if (!SORT_KEYS.includes(sort)) problems.push(`sort=${sort} is not one of ${SORT_KEYS.join(', ')}`);
    if (problems.length > 0) {
      violations.push(...problems.map((problem) => `${url.search}: ${problem}`));
      return answer(route, 'listDeals', 400, validation(problems.map(() => ({ path: 'query', code: 'invalid_string' }))));
    }
    const refused = checkFilters(url, pipeline, 'listDeals');
    if (refused !== null) return answer(route, 'listDeals', 400, refused);
    const stageIds = url.searchParams.getAll('stageId');
    for (const stageId of stageIds) {
      if (stageIn(config, stageId) === undefined) {
        violations.push(`listDeals stageId=${stageId} is not a stage of this pipeline`);
        return answer(route, 'listDeals', 400, validation([{ path: 'stageId', code: 'unknown_reference' }]));
      }
    }
    const filters = filtersOf(url);
    const key = JSON.stringify({ filters: filtersKey(filters), stageIds: [...stageIds].sort(), sort });
    const rows = listRows(store, pipeline.id, filters, stageIds, sort);
    let start = 0;
    const cursor = url.searchParams.get('cursor');
    if (cursor !== null) {
      const bound = listCursors.get(cursor);
      if (bound === undefined || bound.pipelineId !== pipeline.id || bound.key !== key) {
        violations.push(`listDeals cursor "${cursor}" was not served for these filters and this sort — echo it, never build or move it`);
        return answer(route, 'listDeals', 400, errorExample('DealValidationFailed', 'badCursor'));
      }
      start = rows.findIndex((row) => row.id === bound.afterId) + 1;
    }
    const limit = Number(url.searchParams.get('limit') ?? LIST_DEFAULT_LIMIT);
    const data = rows.slice(start, start + limit);
    const last = data.at(-1);
    let nextCursor: string | null = null;
    if (start + limit < rows.length && last !== undefined) {
      nextCursor = nextCursorFor('dl');
      listCursors.set(nextCursor, { pipelineId: pipeline.id, key, afterId: last.id });
    }
    return answer(route, 'listDeals', 200, { data: data.map((row) => serve(row, config)), nextCursor });
  };

  // ----- createDeal -----------------------------------------------------------------

  const createDeal = async (route: Route, request: Request, rawId: string): Promise<void> => {
    const body = readBody(request, 'createDeal');
    const write: RecordedWrite = { method: 'POST', path: new URL(request.url()).pathname, body };
    writes.push(write);
    await writeGate;
    const reply = (status: number, payload: unknown): Promise<void> => {
      write.status = status;
      return answer(route, 'createDeal', status, payload);
    };
    const pipeline = resolvePipeline(route, rawId, 'createDeal');
    if (pipeline === undefined) {
      write.status = 404;
      return;
    }
    if (role === 'qa_analyst') {
      return reply(403, errorExample('DealNotPermitted', 'action'));
    }
    if (!isJson(body)) {
      violations.push('createDeal body is not an object');
      return reply(400, validation([{ path: 'body', code: 'invalid_type' }]));
    }
    const withheld = withheldIn(pipeline.programmeId);
    if ('ownerUserId' in body) {
      violations.push('createDeal sent ownerUserId: an agent’s deal is theirs, and the board offers no reassignment (R7)');
    }
    const notEditable = Object.keys(body).filter((key) => withheld.includes(key));
    if (notEditable.length > 0) {
      violations.push(`createDeal sent ${notEditable.join(', ')}, which the board said is withheld — the form must not offer it`);
      const refusal = errorExample('DealNotPermitted', 'field');
      refusal.details = notEditable.map((path) => ({ path, code: 'field_not_editable' }));
      return reply(403, refusal);
    }
    const problems = validateBody(body, CREATE_SCHEMA, '');
    const amount = body.amount;
    if (isJson(amount) && typeof amount.currency === 'string' && !CURRENCIES.includes(amount.currency)) {
      violations.push(`createDeal amount.currency=${amount.currency} is not one of ${CURRENCIES.join(', ')}`);
      return reply(400, validation([{ path: 'amount.currency', code: 'unknown_currency' }]));
    }
    if (typeof body.name === 'string' && body.name.trim() === '') problems.push('name is blank');
    if (problems.length > 0) {
      violations.push(...problems.map((problem) => `createDeal: ${problem}`));
      return reply(400, validation(problems.map(() => ({ path: 'body', code: 'invalid_string' }))));
    }
    createCount += 1;
    writeCount += 1;
    const when = serverTime(writeCount);
    const first = boardStages(pipeline).find((stage) => stage.kind === 'open');
    if (first === undefined) throw new Error('a pipeline with no open stage');
    const row: StoredDeal = {
      id: DEAL_ID(0xb00 + createCount),
      pipelineId: pipeline.id,
      stageId: first.id,
      version: 1,
      name: String(body.name),
      amount: isJson(amount) ? { amountMinor: String(amount.amountMinor), currency: String(amount.currency) } : null,
      expectedCloseDate: typeof body.expectedCloseDate === 'string' ? body.expectedCloseDate : null,
      ownerUserId: ME.id,
      contact: null,
      account: null,
      nextStep: typeof body.nextStep === 'string' ? body.nextStep : null,
      stageEnteredAt: when,
      closedAt: null,
      checks: [],
      createdAt: when,
      updatedAt: when,
    };
    store.push(row);
    return reply(201, serve(row));
  };

  // ----- getDeal --------------------------------------------------------------------

  const getDeal = async (route: Route, url: URL, rawId: string): Promise<void> => {
    await gate;
    if (options.networkFailure === true) return route.abort('internetdisconnected');
    const id = decodeURIComponent(rawId);
    const row = store.find((candidate) => candidate.id === id);
    if (url.search !== '') violations.push(`getDeal takes no query; it was sent ${url.search}`);
    if (row === undefined || !servedVersions.has(id)) {
      violations.push(`getDeal named ${id}, which the screen was never served`);
      return answer(route, 'getDeal', 404, notFound());
    }
    return answer(route, 'getDeal', 200, serve(row));
  };

  // ----- moveDeal -------------------------------------------------------------------

  const moveDeal = async (route: Route, request: Request, rawId: string): Promise<void> => {
    const body = readBody(request, 'moveDeal');
    const id = decodeURIComponent(rawId);
    const write: RecordedWrite = { method: 'POST', path: `${DEALS_PATH}/${id}/move`, body };
    writes.push(write);
    await writeGate;
    const reply = (status: number, payload: unknown): Promise<void> => {
      write.status = status;
      return answer(route, 'moveDeal', status, payload);
    };
    const row = store.find((candidate) => candidate.id === id);
    if (row === undefined || !servedVersions.has(id)) {
      violations.push(`moveDeal named ${id}, which the screen was never served`);
      return reply(404, notFound());
    }
    const pipeline = pipelineOf(row.pipelineId);
    const config = serverConfig(pipeline);
    const seen = screenConfig.get(pipeline.id) ?? pipeline;
    const withheld = withheldIn(pipeline.programmeId);

    // 403: the action, decided before the body is read.
    const leavingClosed = stageIn(config, row.stageId)?.kind !== 'open';
    if (role === 'qa_analyst' || (role === 'agent' && (withheld.includes('ownerUserId') || row.ownerUserId !== ME.id || leavingClosed))) {
      return reply(403, errorExample('DealNotPermitted', 'action'));
    }
    if (!isJson(body)) {
      violations.push('moveDeal body is not an object');
      return reply(400, validation([{ path: 'body', code: 'invalid_type' }]));
    }
    const fields = isJson(body.fields) ? body.fields : {};
    // 403 field_not_editable on the keys sent.
    const sentWithheld = Object.keys(fields).filter((key) => withheld.includes(key));
    if (sentWithheld.length > 0) {
      violations.push(`moveDeal sent ${sentWithheld.join(', ')}, which the caller cannot read — a lock is never filled`);
      const refusal = errorExample('DealNotPermitted', 'field');
      refusal.details = sentWithheld.map((path) => ({ path, code: 'field_not_editable' }));
      return reply(403, refusal);
    }

    if (options.concurrent !== undefined && options.concurrent.dealId === id) {
      const change = options.concurrent.changes[concurrentStep];
      if (change !== undefined) {
        // Somebody else saves a moment before this move lands.
        concurrentStep += 1;
        const old = overwritten.get(id) ?? new Map<string, string>();
        for (const [field, value] of Object.entries(change)) {
          const before = (row as unknown as Record<string, unknown>)[field];
          if (typeof before === 'string') old.set(field, before);
          (row as unknown as Record<string, unknown>)[field] = value;
        }
        overwritten.set(id, old);
        row.version += 1;
        row.updatedAt = serverTime(writeCount + 1);
      }
    }

    // 400: the body.
    const problems = validateBody(body, MOVE_SCHEMA, '');
    const errors: { path: string; code: string }[] = [];
    const toStageId = typeof body.toStageId === 'string' ? body.toStageId : '';
    const target = stageIn(config, toStageId);
    if (target === undefined) {
      violations.push(`moveDeal toStageId=${toStageId} is not a stage of the deal’s pipeline`);
      return reply(400, validation([{ path: 'toStageId', code: 'unknown_reference' }]));
    }
    const targetFields = new Map(target.requirements.filter((requirement) => requirement.kind === 'field').map((requirement) => [String(requirement.field), requirement]));
    const targetChecks = new Set(target.requirements.filter((requirement) => requirement.kind === 'check').map((requirement) => requirement.id));
    for (const key of Object.keys(fields)) {
      if (!targetFields.has(key)) errors.push({ path: `fields.${key}`, code: 'not_a_requirement' });
    }
    const checks = Array.isArray(body.checks) ? body.checks.map(String) : [];
    for (const [index, requirementId] of checks.entries()) {
      if (!targetChecks.has(requirementId)) errors.push({ path: `checks.${index}`, code: 'not_a_requirement' });
    }
    if (typeof fields.primaryContactId === 'string' || typeof fields.accountId === 'string') {
      for (const key of ['primaryContactId', 'accountId'] as const) {
        const value = fields[key];
        if (typeof value !== 'string') continue;
        const programme = servedTargets.get(value);
        if (programme === undefined) {
          violations.push(`moveDeal ${key}=${value} was never offered by the picker`);
          errors.push({ path: `fields.${key}`, code: 'unknown_reference' });
        } else if (programme !== pipeline.programmeId) {
          violations.push(`moveDeal ${key}=${value} is in another programme: the picker must offer only the deal’s programme’s records`);
          errors.push({ path: `fields.${key}`, code: 'unknown_reference' });
        }
      }
    }
    const version = Number(body.version);
    const versions = servedVersions.get(id) ?? new Set<number>();
    if (!versions.has(version)) {
      problems.push(`version ${String(body.version)} for ${id} is a version the screen was never served`);
    } else if ((refusedVersions.get(id) ?? new Set<number>()).has(version)) {
      problems.push(`version ${version} for ${id} was already refused with 409: a blind retry, not a re-read`);
    }
    // The screen's own allow-list, as it last read it: a forbidden move is said, never sent.
    if (!seen.transitions.some((pair) => pair.fromStageId === row.stageId && pair.toStageId === toStageId) && versions.has(version)) {
      const servedAt = servedRows.get(id)?.get(version);
      if (servedAt !== undefined && servedAt.stageId === row.stageId) {
        problems.push(`a move from ${row.stageId} to ${toStageId} is not on the allow-list the screen read: say so and send nothing`);
      }
    }
    const servedAt = servedRows.get(id)?.get(version);
    for (const [key, value] of Object.entries(fields)) {
      const property = FIELD_PATHS[key];
      if (property === undefined || servedAt === undefined) continue;
      const held = servedAt[property];
      const canonical = (input: unknown): string =>
        isJson(input) && 'amountMinor' in input ? `${String(input.amountMinor)} ${String(input.currency)}` : isJson(input) ? String(input.id) : JSON.stringify(input);
      if (held !== null && held !== undefined && canonical(held) === canonical(value)) {
        problems.push(`fields.${key} was sent with the value the deal already holds: send only what the person filled (D-L102)`);
      }
      const before = overwritten.get(id)?.get(key);
      if (before !== undefined && canonical(before) === canonical(value)) {
        problems.push(`fields.${key} was sent with the value somebody else just replaced: that undoes their save (D-L102)`);
      }
    }
    for (const requirementId of checks) {
      if (servedAt?.checks.some((entry) => entry.requirementId === requirementId) === true) {
        problems.push(`check ${requirementId} is already recorded on the deal: the prompt shows it met, never asks again`);
      }
    }
    violations.push(...problems.map((problem) => `moveDeal: ${problem}`), ...errors.filter((error) => error.code === 'not_a_requirement').map((error) => `moveDeal: ${error.path} is not one of the target stage’s requirements`));
    const shapeProblems = problems.filter((problem) => !/never served|blind retry|already holds|just replaced|already recorded|allow-list/.test(problem));
    if (shapeProblems.length > 0 || errors.length > 0) {
      return reply(400, validation(errors.length > 0 ? errors : [{ path: 'body', code: 'invalid_string' }]));
    }

    // 403 field_not_editable: a required field the mover may not read refuses the move whatever its value.
    const requiredWithheld = [...targetFields.keys()].filter((field) => withheld.includes(field));
    if (requiredWithheld.length > 0) {
      const refusal = errorExample('DealNotPermitted', 'field');
      refusal.details = requiredWithheld.map((path) => ({ path, code: 'field_not_editable' }));
      return reply(403, refusal);
    }

    // 409 stale_write.
    if (version !== row.version) {
      const refused = refusedVersions.get(id) ?? new Set<number>();
      refused.add(version);
      refusedVersions.set(id, refused);
      return reply(409, errorExample('DealMoveConflict', 'stale'));
    }
    // 409 transition_not_allowed (the SERVER's allow-list).
    if (!config.transitions.some((pair) => pair.fromStageId === row.stageId && pair.toStageId === toStageId)) {
      return reply(409, errorExample('DealMoveConflict', 'transition'));
    }
    // 422 requirements_unmet.
    const unmet = target.requirements.filter((requirement) => {
      if (requirement.kind === 'check') return !checks.includes(requirement.id) && !row.checks.some((entry) => entry.requirementId === requirement.id);
      const field = String(requirement.field);
      if (field in fields) return false;
      const property = FIELD_PATHS[field];
      return property === undefined || row[property] === null;
    });
    if (unmet.length > 0) {
      const refusal = errorExample('RequirementsUnmet');
      refusal.details = unmet.map((requirement) => ({ path: `requirements.${requirement.id}`, code: 'requirement_unmet' }));
      return reply(422, refusal);
    }

    // Applied, in one transaction.
    writeCount += 1;
    const when = serverTime(writeCount);
    if (isJson(fields.amount)) row.amount = { amountMinor: String(fields.amount.amountMinor), currency: String(fields.amount.currency) };
    if (typeof fields.expectedCloseDate === 'string') row.expectedCloseDate = fields.expectedCloseDate;
    if (typeof fields.nextStep === 'string') row.nextStep = fields.nextStep;
    if (typeof fields.primaryContactId === 'string') {
      const contact = PICK_CONTACTS.find((entry) => entry.id === fields.primaryContactId);
      row.contact = { id: String(fields.primaryContactId), displayName: String(contact?.displayName ?? '') };
    }
    if (typeof fields.accountId === 'string') {
      const account = PICK_ACCOUNTS.find((entry) => entry.id === fields.accountId);
      row.account = { id: String(fields.accountId), name: String(account?.name ?? '') };
    }
    for (const requirementId of checks) {
      row.checks.push({ requirementId, checkedAt: when, checkedBy: clone(ME) });
    }
    row.stageId = target.id;
    row.stageEnteredAt = when;
    row.closedAt = target.kind === 'open' ? null : when;
    row.version += 1;
    row.updatedAt = when;
    if (options.concurrentArrival !== undefined && !arrived) {
      arrived = true;
      store.push({
        id: ARRIVAL_ID,
        pipelineId: pipeline.id,
        stageId: options.concurrentArrival.stageId,
        version: 1,
        name: 'Arrived from another desk',
        amount: ngn(ARRIVAL_AMOUNT),
        expectedCloseDate: null,
        ownerUserId: OTHER.id,
        contact: null,
        account: null,
        nextStep: null,
        stageEnteredAt: serverTime(writeCount + 1),
        closedAt: null,
        checks: [],
        createdAt: serverTime(writeCount + 1),
        updatedAt: serverTime(writeCount + 1),
      });
    }
    return reply(200, serve(row));
  };

  // ----- the pickers ------------------------------------------------------------------

  const picker = async (route: Route, url: URL, kind: 'contact' | 'account'): Promise<void> => {
    pickerReads.push(url);
    await gate;
    if (options.networkFailure === true) return route.abort('internetdisconnected');
    const operation = kind === 'contact' ? 'listContacts' : 'listAccounts';
    const problems = checkQuery(url, PICKER_PARAMETERS, [], `${operation} (the requirement prompt's picker)`, 100);
    const q = url.searchParams.get('q');
    if (q !== null && (q.length < 1 || q.length > 100)) problems.push(`q is ${q.length} characters; 1..100`);
    if (problems.length > 0) {
      violations.push(...problems.map((problem) => `${url.search}: ${problem}`));
      return answer(route, operation, 400, validation(problems.map(() => ({ path: 'query', code: 'invalid_string' }))));
    }
    const rows = (kind === 'contact' ? PICK_CONTACTS : PICK_ACCOUNTS).filter((row) =>
      q === null ? true : folded(String(kind === 'contact' ? row.displayName : row.name)).includes(folded(q)),
    );
    for (const row of rows) servedTargets.set(String(row.id), String(row.programmeId));
    return answer(route, operation, 200, { data: clone(rows), nextCursor: null });
  };

  // ----- routing ------------------------------------------------------------------------

  await page.route(
    (url) => url.pathname.startsWith('/api/v1/'),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      requests.push(url);
      checkHeaders(request, `${method} ${url.pathname}`);

      if (url.pathname === ME_PATH && method === 'GET') return answer(route, 'getCurrentUser', 200, clone(CURRENT_USER));
      if (url.pathname === PROGRAMMES_PATH && method === 'GET') {
        return answer(route, 'listMyProgrammes', 200, { data: [clone(PROGRAMME_ONE), clone(PROGRAMME_TWO)] });
      }
      if (url.pathname === PIPELINES_PATH && method === 'GET') return listPipelines(route, url);
      const pipelineMatch = /^\/api\/v1\/pipelines\/([^/]+)(\/board|\/deals)?$/.exec(url.pathname);
      if (pipelineMatch !== null) {
        const rawId = pipelineMatch[1] ?? '';
        const rest = pipelineMatch[2];
        if (rest === undefined && method === 'GET') return getPipeline(route, url, rawId);
        if (rest === '/board' && method === 'GET') return board(route, url, rawId);
        if (rest === '/deals' && method === 'GET') return listDeals(route, url, rawId);
        if (rest === '/deals' && method === 'POST') return createDeal(route, request, rawId);
      }
      const dealMatch = /^\/api\/v1\/deals\/([^/]+)(\/move)?$/.exec(url.pathname);
      if (dealMatch !== null) {
        const rawId = dealMatch[1] ?? '';
        if (dealMatch[2] === undefined && method === 'GET') return getDeal(route, url, rawId);
        if (dealMatch[2] === '/move' && method === 'POST') return moveDeal(route, request, rawId);
      }
      if (url.pathname === CONTACTS_PATH && method === 'GET') return picker(route, url, 'contact');
      if (url.pathname === ACCOUNTS_PATH && method === 'GET') return picker(route, url, 'account');
      violations.push(`${method} ${url.pathname} is not an operation the pipeline screen uses`);
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store' },
        body: JSON.stringify(notFound()),
      });
    },
  );

  return {
    requests,
    pipelineReads,
    boardReads,
    listReads,
    pickerReads,
    writes,
    violations,
    mockFaults,
    plantedFaults,
    store,
    issuedCursors: () => [...issued],
    release: () => release(),
    releaseWrites: () => releaseWrites(),
  };
}
