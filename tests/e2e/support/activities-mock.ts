import type { Page, Request, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { TENANT_A } from '@kasuwa/db';
import { CUSTOM_FIELDS_PATH, CustomFieldsServer, type CustomFieldsSetup } from './custom-values-mock';

/**
 * The P07 half of `docs/api/records.openapi.yaml` — `listMyActivities`,
 * `listCalendar`, `createActivity`, `updateActivity`, and the composer's
 * target picker (`listContacts` and `listAccounts`, `q` only) — plus
 * `listMyProgrammes` and `getCurrentUser` (`docs/api/auth.openapi.yaml`),
 * served into the browser by Playwright for T-0083 (the activities screen).
 *
 * ---------------------------------------------------------------------------
 * READ FROM THE CONTRACT AT RUN TIME, AND EVERY ANSWER CHECKED AGAINST IT
 *
 * The schemas, the enums, the parameter lists and every error body come out of
 * the YAML when this module loads. Two checks keep the mock honest:
 *
 *   - At load, every activity below is validated, as a `MyActivity`, against
 *     the contract. A contract change this file contradicts fails here,
 *     loudly, before any journey runs.
 *   - At run time EVERY body the mock answers with is validated against the
 *     schema the contract declares for that operation and status, strictly: a
 *     property the schema does not name is a fault, so the mock can never hand
 *     the screen a field (a count, a priority, an attendee list) the real API
 *     does not serve. A fault is the MOCK's, recorded in `mockFaults`, which
 *     the spec's `afterEach` requires to be empty.
 *
 *   The one exception is `hostileSummaries`, which serves two summaries whose
 *   ids are NOT uuids, on purpose (the screen must link only from a
 *   well-formed uuid). Exactly those two problems are moved to
 *   `plantedFaults`, which the journey counts; any other problem is still a
 *   mock fault.
 *
 * THE CLOCK
 *
 *   The server's "now" is NOW, fixed. Every journey fixes the browser's clock
 *   to the same instant (`page.clock.setFixedTime(NOW)`), so "today", "this
 *   week" and "this month" are the same instant on both sides of the wire, in
 *   any time zone. NOW is 22:30 UTC on Wednesday 30 September 2026: 23:30 in
 *   Lagos (still the 30th), 00:30 in Johannesburg and 01:30 in Nairobi (both
 *   already Thursday 1 October). A screen that buckets, windows or labels in
 *   the wrong zone gets a different DAY, not just a different hour.
 *
 * WHAT IS NOT IN THE CONTRACT, AND IS THEREFORE DECLARED HERE
 *
 *   - Activities. The contract publishes four (`listMyActivities`' two and
 *     `listCalendar`'s two). They are used verbatim; the rest are declared in
 *     the same shape. Names, numbers and people are invented.
 *   - The caller. ME is the example account's owner (Kemi Balogun), learnt by
 *     the screen from `GET /api/v1/auth/me`. Every activity here is ME's: the
 *     server lists only the caller's own (there is no owner parameter).
 *   - Field security, per programme (the activity object's matrix):
 *       PROGRAMME_ONE   — nothing withheld, nothing read-only;
 *       PROGRAMME_TWO   — `subject` withheld (as the contract's example);
 *                         `dueAt`, `startsAt` and `endsAt` READ-ONLY: sending
 *                         one is `403 field_not_editable`;
 *       PROGRAMME_THREE — `completedAt` and the account link withheld.
 *   - Buckets and windows are computed exactly as the contract says, in the
 *     `timeZone` the screen sends, at NOW.
 *
 * WHAT THE MOCK ENFORCES ON EVERY REQUEST (recorded as `violations`, the
 * SCREEN's fault; `afterEach` in the spec fails a test that has any)
 *
 *   - Only the operations above. Anything else under `/api/v1/` is a
 *     violation (a Google or Microsoft calendar, a booking page, a holiday
 *     list, a count, a contact's timeline...).
 *   - No request header names a programme or a tenant (CLAUDE.md 2.2).
 *   - listMyActivities: exactly `timeZone`, `bucket`, `cursor`, `limit`;
 *     `timeZone` a real IANA zone AND the browser's own (`browserTimeZone`):
 *     the zone is never guessed, defaulted or hard-coded; a cursor echoed
 *     exactly, with the bucket and zone it was served for.
 *   - listCalendar: exactly `from`, `to`, `cursor`, `limit`; both UTC with a
 *     `Z`; `to` after `from`; AT MOST 42 DAYS; a cursor echoed exactly, with
 *     the window it was served for.
 *   - listContacts / listAccounts (the picker): `q`, `limit`, `cursor` and
 *     `sort` only; never a programme or owner filter.
 *   - createActivity: the closed `CreateActivityRequest`; ONE target, a
 *     contact or account the picker served; `ownerUserId` the caller's own id
 *     (P07 composes for the caller); a meeting with both times, the end after
 *     the start and at most 24 hours after it, and no `dueAt`; a task with no
 *     `startsAt`/`endsAt`. A meeting the screen should have refused locally is
 *     a violation AND the contract's `400`.
 *   - updateActivity: the closed `UpdateActivityRequest`; an activity the
 *     screen was served; a `version` it was served for THAT activity; a
 *     version already answered `409` is a blind retry; a time field sent
 *     unchanged is not "only what changed" (D-L102); a field somebody else
 *     changed concurrently, sent back with its OLD value, undoes their save
 *     (D-L102); `dueAt` only on a task, `startsAt`/`endsAt` only on a meeting,
 *     `completed` only on a task; the result of a reschedule within the
 *     meeting rules. A stale but served version is not a violation: it is a
 *     `409`. A read-only field is not a violation: it is a `403`.
 *
 * SERVER BEHAVIOUR THE SCREEN DEPENDS ON, IMPLEMENTED AS THE CONTRACT SAYS
 *
 *   - Field security omits, never nulls. A task whose `dueAt`, or a meeting
 *     whose `startsAt`/`endsAt`, is withheld is not listed at all, except
 *     under `plantWithheldTimes`, which serves one of each anyway: the
 *     contract's promise broken, to prove the screen never guesses a time.
 *   - Order: `dueAt` ascending, ties by id, undated last (buckets); start
 *     ascending, ties by id (calendar). A page with a non-null `nextCursor`
 *     holds exactly `limit` items.
 *   - Writes apply: a created task or meeting joins the lists; completing a
 *     task removes it from every bucket and keeps it on the calendar;
 *     snoozing or rescheduling moves it. `version` advances on every write.
 *   - `concurrent`: before each of the screen's writes to the named activity
 *     lands, somebody else applies the next change in the list (and the
 *     version advances), so that write is `409 stale_write`. A re-read serves
 *     the new state.
 *
 * CUSTOM FIELDS (T-0091, lead edit). `listCustomFields` is one of the
 * operations above, answered by `custom-values-mock.ts`. With no
 * `customFields` option it lists nothing, so the T-0083 journeys are
 * unchanged. With one, createActivity's `custom` (values only) is checked for
 * the activity object there (its 403s before this file's 400s) and the 201
 * carries the projected `custom`. `MyActivity` carries no `custom`, so the
 * lists never do.
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

function enumOf(name: string, ...path: string[]): readonly string[] {
  return (at(schema(name), ...path, 'enum') as unknown[]).map(String);
}

const MY_ACTIVITIES_PATH = '/api/v1/me/activities';
const CALENDAR_PATH = '/api/v1/me/calendar';
const ACTIVITIES_PATH = '/api/v1/activities';
const CONTACTS_PATH = '/api/v1/contacts';
const ACCOUNTS_PATH = '/api/v1/accounts';
const PROGRAMMES_PATH = '/api/v1/me/programmes';
const ME_PATH = '/api/v1/auth/me';

const OP = {
  listMyActivities: [MY_ACTIVITIES_PATH, 'get'],
  listCalendar: [CALENDAR_PATH, 'get'],
  createActivity: [ACTIVITIES_PATH, 'post'],
  updateActivity: [`${ACTIVITIES_PATH}/{activityId}`, 'patch'],
  listContacts: [CONTACTS_PATH, 'get'],
  listAccounts: [ACCOUNTS_PATH, 'get'],
  listMyProgrammes: [PROGRAMMES_PATH, 'get'],
  getCurrentUser: [ME_PATH, 'get'],
} as const;

export type Operation = keyof typeof OP;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** RFC 3339 in UTC, with a `Z`: the contract's rule for every time. */
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** listCalendar's longest window (six weeks, a month grid). */
export const MAX_WINDOW_MS = 42 * DAY;
/** A meeting's longest span. */
export const MAX_MEETING_MS = 24 * HOUR;

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
    if (spec.format === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) problems.push(`${where} is not an email`);
    if (value.includes('\u0000')) problems.push(`${where} carries a NUL`);
  }
  if (typeof value === 'number') {
    if (typeof spec.minimum === 'number' && value < spec.minimum) problems.push(`${where} is below ${spec.minimum}`);
    if (typeof spec.maximum === 'number' && value > spec.maximum) problems.push(`${where} is above ${spec.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof spec.maxItems === 'number' && value.length > spec.maxItems) problems.push(`${where} has too many items`);
    if (spec.items !== undefined) {
      value.forEach((item, index) => problems.push(...validateBody(item, spec.items, `${path}.${index}`, located.doc, strict)));
    }
  }
  if (isJson(value) && (spec.properties !== undefined || spec.required !== undefined || spec.additionalProperties === false)) {
    const properties = (spec.properties ?? {}) as Json;
    const declared = declaredKeys(spec, located.doc);
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
  const body = errorExample('ValidationFailed', 'badField');
  body.details = details;
  return body;
}

function parameterNames(operation: Operation): readonly string[] {
  const [path, method] = OP[operation];
  const own = (at(CONTRACT, 'paths', path, method) as Json).parameters;
  return ((Array.isArray(own) ? own : []) as unknown[]).map((raw) => String((deref(raw, CONTRACT).node as Json).name));
}

/** The contract's pattern for `timeZone` (it must ALSO name a real zone). */
const TIME_ZONE_PATTERN = new RegExp(
  String((deref(at(CONTRACT, 'components', 'parameters', 'TimeZone'), CONTRACT).node as { schema: { pattern: string } }).schema.pattern),
);

// ---------------------------------------------------------------------------
// The contract's own vocabularies
// ---------------------------------------------------------------------------

export const BUCKETS: readonly string[] = enumOf('ActivityBucket');
export const ACTIVITY_TYPES: readonly string[] = enumOf('ActivityType');
/** What listMyActivities and listCalendar list: tasks and meetings only. */
export const LISTED_TYPES: readonly string[] = enumOf('MyActivity', 'properties', 'type');

export type Bucket = 'overdue' | 'today' | 'upcoming';

// ---------------------------------------------------------------------------
// Time, in a named zone (the oracle the mock answers with)
// ---------------------------------------------------------------------------

/** The server's "now". Every journey fixes the browser's clock to it. */
export const NOW = '2026-09-30T22:30:00.000Z';
const NOW_MS = Date.parse(NOW);

interface ZoneParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function zoneParts(instant: number, timeZone: string): ZoneParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const part = (type: string): number => Number(parts.find((entry) => entry.type === type)?.value ?? Number.NaN);
  return { y: part('year'), m: part('month'), d: part('day'), h: part('hour'), mi: part('minute'), s: part('second') };
}

function offsetMs(instant: number, timeZone: string): number {
  const p = zoneParts(instant, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(instant / 1000) * 1000;
}

/** The UTC instant of local midnight starting day `y-m-d` in `timeZone` (d may overflow). */
function localMidnight(y: number, m: number, d: number, timeZone: string): number {
  let guess = Date.UTC(y, m - 1, d);
  for (let step = 0; step < 3; step += 1) {
    guess = Date.UTC(y, m - 1, d) - offsetMs(guess, timeZone);
  }
  return guess;
}

/** The first local midnight after `instant` in `timeZone`. */
function nextMidnight(instant: number, timeZone: string): number {
  const p = zoneParts(instant, timeZone);
  return localMidnight(p.y, p.m, p.d + 1, timeZone);
}

/** True when `zone` names a zone this Node's IANA database knows. */
function knownZone(zone: string): boolean {
  if (!TIME_ZONE_PATTERN.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Which bucket an open task falls into at NOW in `timeZone` (the contract's rule). */
export function bucketOf(dueAt: string | null, timeZone: string): Bucket {
  if (dueAt === null) return 'upcoming';
  const due = Date.parse(dueAt);
  if (due < NOW_MS) return 'overdue';
  return due < nextMidnight(NOW_MS, timeZone) ? 'today' : 'upcoming';
}

// ---------------------------------------------------------------------------
// People and programmes
// ---------------------------------------------------------------------------

export interface Programme {
  id: string;
  name: string;
}

export interface Person {
  id: string;
  displayName: string;
}

/** The contract's own example programme. */
export const PROGRAMME_ONE = clone(
  at(CONTRACT, 'paths', PROGRAMMES_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', '0'),
) as Programme;

/** The programme of the contract's second listMyActivities example (subject withheld). */
export const PROGRAMME_TWO: Programme = { id: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a02', name: 'Lagos Water Customer Care' };

/** A third programme whose matrix withholds `completedAt` and the account link. */
export const PROGRAMME_THREE: Programme = { id: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a03', name: 'Kano Agro Field Sales' };

const ACCOUNT_EXAMPLE = clone(
  at(CONTRACT, 'paths', ACCOUNTS_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', '0'),
) as Json & { id: string; name: string };

const CONTACT_EXAMPLE = clone(
  at(CONTRACT, 'paths', CONTACTS_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', '0'),
) as Json & { id: string; displayName: string };

/** The caller: the example account's owner. */
export const ME: Person = clone(ACCOUNT_EXAMPLE.owner as Person);

export const CURRENT_USER: Json = {
  id: ME.id,
  tenantId: TENANT_A,
  email: 'kemi.balogun@example.ng',
  displayName: ME.displayName,
  locale: 'en-NG',
};

/** Field security of the activity object, per programme, in MyActivity's names. */
const WITHHELD: Readonly<Record<string, readonly string[]>> = {
  [PROGRAMME_ONE.id]: [],
  [PROGRAMME_TWO.id]: ['subject'],
  [PROGRAMME_THREE.id]: ['completedAt', 'account'],
};

/** Readable but not editable (field security's `read` level). Sending one is 403. */
const READ_ONLY: Readonly<Record<string, readonly string[]>> = {
  [PROGRAMME_ONE.id]: [],
  [PROGRAMME_TWO.id]: ['dueAt', 'startsAt', 'endsAt'],
  [PROGRAMME_THREE.id]: [],
};

// ---------------------------------------------------------------------------
// Activities (the server's store, as the mock starts)
// ---------------------------------------------------------------------------

export interface Summary {
  id: string;
  displayName?: string;
  name?: string;
}

/** One activity as the server holds it. Served as MyActivity or Activity, field security applied. */
export interface StoredActivity {
  id: string;
  programmeId: string;
  type: 'task' | 'meeting' | 'note' | 'call';
  subject: string | null;
  dueAt: string | null;
  completedAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  contact: { id: string; displayName: string } | null;
  account: { id: string; name: string } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Planted: served even though the contract says it is not listed. */
  plantedWithheld?: readonly string[];
}

const MY_ACTIVITY_SCHEMA = schema('MyActivity');

/** The MyActivity this caller is served for `row`: withheld fields omitted and named. */
export function asMyActivity(row: StoredActivity): Json {
  const withheld = [...(WITHHELD[row.programmeId] ?? []), ...(row.plantedWithheld ?? [])];
  const out: Json = {
    id: row.id,
    programmeId: row.programmeId,
    type: row.type,
    subject: row.subject,
    dueAt: row.dueAt,
    completedAt: row.completedAt,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    contact: clone(row.contact),
    account: clone(row.account),
    version: row.version,
    withheldFields: [...new Set(withheld)],
  };
  for (const field of withheld) {
    delete out[field];
  }
  return out;
}

/** The full Activity this caller is served after a write (Activity's own names). */
function asActivity(row: StoredActivity): Json {
  const withheld = (WITHHELD[row.programmeId] ?? []).map((field) =>
    field === 'contact' ? 'contactId' : field === 'account' ? 'accountId' : field,
  );
  const out: Json = {
    id: row.id,
    programmeId: row.programmeId,
    type: row.type,
    subject: row.subject,
    body: null,
    dueAt: row.dueAt,
    completedAt: row.completedAt,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    ownerUserId: ME.id,
    contactId: row.contact?.id ?? null,
    accountId: row.account?.id ?? null,
    createdByUserId: ME.id,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    withheldFields: withheld,
  };
  for (const field of withheld) {
    delete out[field];
  }
  return out;
}

function check(row: StoredActivity): StoredActivity {
  const problems = validateBody(asMyActivity(row), MY_ACTIVITY_SCHEMA, `activity ${row.id}`, CONTRACT, true);
  if (problems.length > 0) {
    throw new Error(`activity ${row.id} disagrees with ${RECORDS_CONTRACT_SOURCE}: ${problems.join('; ')}`);
  }
  return row;
}

/** A served MyActivity example from the contract, as a stored row (verbatim). */
function fromExample(operation: 'listMyActivities' | 'listCalendar', index: number): StoredActivity {
  const [path] = OP[operation];
  const item = clone(at(CONTRACT, 'paths', path, 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', String(index))) as Json;
  const row: StoredActivity = {
    id: String(item.id),
    programmeId: String(item.programmeId),
    type: item.type as StoredActivity['type'],
    subject: typeof item.subject === 'string' ? item.subject : null,
    dueAt: (item.dueAt ?? null) as string | null,
    completedAt: (item.completedAt ?? null) as string | null,
    startsAt: (item.startsAt ?? null) as string | null,
    endsAt: (item.endsAt ?? null) as string | null,
    contact: (item.contact ?? null) as StoredActivity['contact'],
    account: (item.account ?? null) as StoredActivity['account'],
    version: Number(item.version),
    createdAt: '2026-09-20T08:00:00.000Z',
    updatedAt: '2026-09-20T08:00:00.000Z',
  };
  // Verbatim means verbatim: the stored row must serve back exactly the example.
  const served = asMyActivity(row);
  if (JSON.stringify(Object.entries(served).sort()) !== JSON.stringify(Object.entries(item).sort())) {
    throw new Error(`the ${operation} example ${row.id} does not round-trip through the mock: ${JSON.stringify(served)}`);
  }
  return check(row);
}

const ACTIVITY_ID = (n: string): string => `5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4c${n}`;

function task(
  n: string,
  subject: string | null,
  dueAt: string | null,
  extra: Partial<StoredActivity> = {},
): StoredActivity {
  return check({
    id: ACTIVITY_ID(n),
    programmeId: PROGRAMME_ONE.id,
    type: 'task',
    subject,
    dueAt,
    completedAt: null,
    startsAt: null,
    endsAt: null,
    contact: null,
    account: null,
    version: 1,
    createdAt: '2026-09-21T08:00:00.000Z',
    updatedAt: '2026-09-21T08:00:00.000Z',
    ...extra,
  });
}

function meeting(n: string, subject: string | null, startsAt: string, endsAt: string, extra: Partial<StoredActivity> = {}): StoredActivity {
  return check({
    id: ACTIVITY_ID(n),
    programmeId: PROGRAMME_ONE.id,
    type: 'meeting',
    subject,
    dueAt: null,
    completedAt: null,
    startsAt,
    endsAt,
    contact: null,
    account: null,
    version: 1,
    createdAt: '2026-09-21T08:00:00.000Z',
    updatedAt: '2026-09-21T08:00:00.000Z',
    ...extra,
  });
}

/** Contact and account summaries (closed in the contract: an id and a name). */
export const EMEKA = { id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e01', displayName: 'Emeka Obi' };
export const BISI = { id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e21', displayName: 'Bisi Ogunleye' };
export const UBUNTU = { id: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c03', name: 'Ubuntu Insure' };
export const KANO_AGRO = { id: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c05', name: 'Kano Agro Inputs' };

export const HOSTILE_SUBJECT = '<img src=x onerror="window.__kasuwaXss=1">Chase <b>Bùkọ́lá</b> about the deposit';

/** The contract's listMyActivities examples, verbatim: both overdue at NOW. */
export const T_EMEKA = fromExample('listMyActivities', 0);
/** In PROGRAMME_TWO: subject withheld, `dueAt` read-only (a snooze is 403 field_not_editable). */
export const T_KWARA = fromExample('listMyActivities', 1);
/** The contract's listCalendar task example: open, due 14:00Z on the 30th, so overdue too. */
export const T_QBR_DECK = fromExample('listCalendar', 0);
/** The contract's listCalendar meeting example: 14:30Z–15:30Z on Wednesday the 30th. */
export const M_QBR = fromExample('listCalendar', 1);

/** Due 22:50Z on the 30th: "today" in all three zones (Lagos midnight is 23:00Z). */
export const T_LATE_TODAY = task('11', 'Send the signed PO to Obajana', '2026-09-30T22:50:00.000Z');
/** Due 20:00Z on 1 October: upcoming in Lagos, today in Johannesburg and Nairobi. */
export const T_SPLIT = task('12', 'Confirm Thursday delivery window', '2026-10-01T20:00:00.000Z', { contact: clone(EMEKA) });
/** Due 21:30Z on 1 October: upcoming in Lagos and Nairobi, today in Johannesburg. */
export const T_SPLIT2 = task('13', 'Call back about the refund', '2026-10-01T21:30:00.000Z', { contact: clone(BISI), version: 2 });
/** Due 08:00Z on Monday 5 October: upcoming everywhere. */
export const T_NEXT_WEEK = task('14', 'Renewal reminder for Ubuntu Insure', '2026-10-05T08:00:00.000Z', { account: clone(UBUNTU) });
/** No due time: upcoming, after every dated task. Never on the calendar. */
export const T_UNDATED = task('15', 'Plan the Kano route', null);
/** Markup in a subject: drawn as text, never parsed. */
export const T_HOSTILE = task('16', HOSTILE_SUBJECT, '2026-10-02T09:00:00.000Z');
/** Completed: on the calendar (marked done), on no bucket. */
export const T_DONE = task('17', 'Send the Q4 price list', '2026-09-29T10:00:00.000Z', {
  completedAt: '2026-09-29T09:40:00.000Z',
  version: 2,
});
/** In PROGRAMME_THREE, completed, `completedAt` withheld: done or not is a lock, never a guess. */
export const T_DONE_LOCKED = task('18', 'Collect the KYC pack', '2026-09-29T13:00:00.000Z', {
  programmeId: PROGRAMME_THREE.id,
  completedAt: '2026-09-29T12:00:00.000Z',
  account: clone(KANO_AGRO),
});
/** In PROGRAMME_THREE, open: its account link is withheld (a lock where the summary would be). */
export const T_P3_OPEN = task('19', 'Agree the Kano depot visit', '2026-10-02T12:00:00.000Z', {
  programmeId: PROGRAMME_THREE.id,
  account: clone(KANO_AGRO),
});

/** 21:30Z–23:30Z on the 30th: Wednesday evening in Lagos and Johannesburg, Thursday in Nairobi. */
export const M_LATE = meeting('21', 'Late call with the Nairobi desk', '2026-09-30T21:30:00.000Z', '2026-09-30T23:30:00.000Z');
/** Began before the week's window: still listed (it overlaps). */
export const M_PREV = meeting('22', 'Weekend stock count', '2026-09-27T20:00:00.000Z', '2026-09-28T02:00:00.000Z');
/** Mid-September: in Lagos' month (September) only. */
export const M_SEPT = meeting('23', 'Kano Agro close date review', '2026-09-10T09:00:00.000Z', '2026-09-10T10:00:00.000Z', {
  account: clone(KANO_AGRO),
});
/** 20 October: in Nairobi's month (October) only. */
export const M_OCT = meeting('24', 'Abuja Estates walkthrough', '2026-10-20T10:00:00.000Z', '2026-10-20T11:30:00.000Z');
/** Friday 2 October 09:00Z–10:00Z, version 2: the meeting the journeys reschedule. */
export const M_RESCHED = meeting('25', 'Discovery with Abuja Estates', '2026-10-02T09:00:00.000Z', '2026-10-02T10:00:00.000Z', {
  version: 2,
  contact: clone(EMEKA),
});
/** In PROGRAMME_TWO: subject withheld, times read-only. */
export const M_P2 = meeting('26', null, '2026-10-01T09:00:00.000Z', '2026-10-01T10:00:00.000Z', { programmeId: PROGRAMME_TWO.id });

/** Under `plantWithheldTimes`: a task served with `dueAt` withheld, against the contract. */
export const T_PLANTED = task('31', 'Follow up the Ibadan quote', '2026-10-03T09:00:00.000Z', {
  plantedWithheld: ['dueAt'],
});
/** Under `plantWithheldTimes`: a meeting served with both times withheld, against the contract. */
export const M_PLANTED = meeting('32', 'Board pre-read', '2026-10-01T13:00:00.000Z', '2026-10-01T14:00:00.000Z', {
  plantedWithheld: ['startsAt', 'endsAt'],
});

/** Under `hostileSummaries`: summaries whose ids are not uuids. The screen must link neither. */
export const HOSTILE_CONTACT_ID = '../../admin/audit?export=1#x';
export const HOSTILE_ACCOUNT_ID = 'javascript:alert(1)//';
export const T_HOSTILE_LINKS = task('33', 'Return the signed delivery note', '2026-09-30T08:00:00.000Z');
const HOSTILE_LINKS_SUMMARIES = {
  contact: { id: HOSTILE_CONTACT_ID, displayName: 'Ngozi Eze' },
  account: { id: HOSTILE_ACCOUNT_ID, name: 'Ikeja Motors' },
};

const BASE: readonly StoredActivity[] = [
  T_EMEKA,
  T_KWARA,
  T_QBR_DECK,
  M_QBR,
  T_LATE_TODAY,
  T_SPLIT,
  T_SPLIT2,
  T_NEXT_WEEK,
  T_UNDATED,
  T_HOSTILE,
  T_DONE,
  T_DONE_LOCKED,
  T_P3_OPEN,
  M_LATE,
  M_PREV,
  M_SEPT,
  M_OCT,
  M_RESCHED,
  M_P2,
];

/** A letters-only suffix, so generated subjects carry no number a count check could mistake. */
function letters(n: number): string {
  const a = 'abcdefghijklmnopqrstuvwxyz';
  return `${a[Math.floor(n / 26) % 26] ?? 'a'}${a[n % 26] ?? 'a'}`;
}

function generatedId(prefix: string, n: number): string {
  return `5e2a7b1c-3d4f-4a6b-${prefix}-${n.toString(16).padStart(12, '0')}`;
}

/** More upcoming tasks than any legal `limit`: the bucket always has a second page. */
export const LONG_UPCOMING_LENGTH = 105;
function longUpcoming(): StoredActivity[] {
  const base = Date.parse('2026-10-06T08:00:00.000Z');
  return Array.from({ length: LONG_UPCOMING_LENGTH }, (_, n) =>
    check({
      ...task('00', `Follow-up visit ${letters(n)}`, new Date(base + Math.floor(n / 2) * 30 * MINUTE).toISOString()),
      id: generatedId('9a01', n),
    }),
  );
}

/** More calendar items in the week than any legal `limit`: the window has a second page. */
export const BUSY_WEEK_LENGTH = 130;
function busyWeek(): StoredActivity[] {
  const base = Date.parse('2026-09-29T06:00:00.000Z');
  return Array.from({ length: BUSY_WEEK_LENGTH }, (_, n) => {
    const dueAt = new Date(base + Math.floor(n / 3) * HOUR).toISOString();
    // Completed, so the buckets are unchanged: only the calendar is busy.
    return check({ ...task('00', `Route stop ${letters(n)}`, dueAt, { completedAt: dueAt }), id: generatedId('9b01', n) });
  });
}

/** Everything the store starts with under `options`. */
function initialStore(options: ActivitiesMockOptions): StoredActivity[] {
  if (options.empty === true) return [];
  const rows = BASE.map((row) => clone(row));
  if (options.longUpcoming === true) rows.push(...longUpcoming());
  if (options.busyWeek === true) rows.push(...busyWeek());
  if (options.plantWithheldTimes === true) rows.push(clone(T_PLANTED), clone(M_PLANTED));
  if (options.hostileSummaries === true) rows.push({ ...clone(T_HOSTILE_LINKS), ...clone(HOSTILE_LINKS_SUMMARIES) });
  return rows;
}

/** The time a row sits at on the calendar (its sort key): `dueAt` for a task, `startsAt` for a meeting. */
function startOf(row: StoredActivity): string | null {
  return row.type === 'meeting' ? row.startsAt : row.dueAt;
}

function byKeyThenId(key: (row: StoredActivity) => string | null) {
  return (a: StoredActivity, b: StoredActivity): number => {
    const left = key(a);
    const right = key(b);
    if (left !== right) {
      if (left === null) return 1;
      if (right === null) return -1;
      return Date.parse(left) - Date.parse(right);
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

function hidden(row: StoredActivity, fields: readonly string[]): boolean {
  const withheld = WITHHELD[row.programmeId] ?? [];
  return fields.some((field) => withheld.includes(field)) && row.plantedWithheld === undefined;
}

/** What listMyActivities serves for `bucket` in `timeZone`, in order, before paging. */
export function bucketRows(store: readonly StoredActivity[], bucket: Bucket, timeZone: string): StoredActivity[] {
  return store
    .filter((row) => row.type === 'task' && row.completedAt === null && !hidden(row, ['dueAt']))
    .filter((row) => bucketOf(row.dueAt, timeZone) === bucket)
    .sort(byKeyThenId((row) => row.dueAt));
}

/** What listCalendar serves for [from, to), in order, before paging. */
export function calendarRows(store: readonly StoredActivity[], from: string, to: string): StoredActivity[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  return store
    .filter((row) => {
      if (row.type === 'task') {
        if (row.dueAt === null || hidden(row, ['dueAt'])) return false;
        const due = Date.parse(row.dueAt);
        return due >= start && due < end;
      }
      if (row.type === 'meeting') {
        if (row.startsAt === null || row.endsAt === null || hidden(row, ['startsAt', 'endsAt'])) return false;
        return Date.parse(row.startsAt) < end && Date.parse(row.endsAt) > start;
      }
      return false;
    })
    .sort(byKeyThenId(startOf));
}

/** The base store, for the spec's oracles. */
export function baseActivities(): readonly StoredActivity[] {
  return BASE;
}

// ---------------------------------------------------------------------------
// The picker's contacts and accounts (listContacts / listAccounts with `q`)
// ---------------------------------------------------------------------------

/** The contract's listContacts example, verbatim. */
export const PICK_CONTACT = clone(CONTACT_EXAMPLE);
/** The contract's listAccounts example, verbatim. */
export const PICK_ACCOUNT = clone(ACCOUNT_EXAMPLE);

const PICK_CONTACTS: readonly Json[] = [
  PICK_CONTACT,
  {
    ...clone(CONTACT_EXAMPLE),
    id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e31',
    displayName: 'Adamu Danjuma',
    givenNames: 'Adamu',
    familyName: 'Danjuma',
    companyName: null,
    phones: [{ type: 'mobile', e164: '+2348030000031' }],
  },
];

const PICK_ACCOUNTS: readonly Json[] = [
  PICK_ACCOUNT,
  {
    ...clone(ACCOUNT_EXAMPLE),
    id: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c41',
    name: 'Ọjà Foods Abuja',
    tags: [],
    phones: [],
  },
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

const CURRENT_USER_PROBLEMS = answerProblems('getCurrentUser', 200, CURRENT_USER);
if (CURRENT_USER_PROBLEMS.length > 0) {
  throw new Error(`CURRENT_USER disagrees with ${AUTH_CONTRACT_SOURCE}: ${CURRENT_USER_PROBLEMS.join('; ')}`);
}

/** Case- and diacritic-insensitive, as the contract matches `q`. */
function folded(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/** Everything the mock serves, for checks that tell served record data from UI copy. */
export function servedData(): string {
  return JSON.stringify({
    activities: [...BASE, T_PLANTED, M_PLANTED, T_HOSTILE_LINKS, ...longUpcoming(), ...busyWeek()],
    summaries: HOSTILE_LINKS_SUMMARIES,
    contacts: PICK_CONTACTS,
    accounts: PICK_ACCOUNTS,
    programmes: [PROGRAMME_ONE, PROGRAMME_TWO, PROGRAMME_THREE],
    me: CURRENT_USER,
  });
}

/** The ids the mock gives the activities the screen creates, in order. */
export const NEW_ACTIVITY_IDS: readonly string[] = [
  ACTIVITY_ID('71'),
  ACTIVITY_ID('72'),
  ACTIVITY_ID('73'),
  ACTIVITY_ID('74'),
  ACTIVITY_ID('75'),
  ACTIVITY_ID('76'),
];

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export interface ActivitiesMockOptions {
  /** The browser's IANA zone (the journey's `timezoneId`). The screen must send exactly this. Default Africa/Lagos. */
  readonly browserTimeZone?: string;
  /** Hold every read until `release()`: the loading frame, without a clock. */
  readonly hold?: boolean;
  /** Abort every read, as a dropped connection does. */
  readonly networkFailure?: boolean;
  /** Abort every listMyActivities read for this bucket only. */
  readonly bucketFailure?: Bucket;
  /** Abort every listCalendar read. */
  readonly calendarFailure?: boolean;
  /** Hold every write until `releaseWrites()`. */
  readonly holdWrites?: boolean;
  /** The caller owns nothing at all. */
  readonly empty?: boolean;
  /** Add LONG_UPCOMING_LENGTH upcoming tasks. */
  readonly longUpcoming?: boolean;
  /** Add BUSY_WEEK_LENGTH completed tasks in the week of NOW. */
  readonly busyWeek?: boolean;
  /** Serve T_PLANTED and M_PLANTED with their times withheld (the contract says never). */
  readonly plantWithheldTimes?: boolean;
  /** Serve T_HOSTILE_LINKS with summaries whose ids are not uuids. */
  readonly hostileSummaries?: boolean;
  /**
   * Somebody else writes `activityId` just before each of the screen's
   * writes to it lands: change n is applied before write n, and the version
   * advances, so that write is a 409.
   */
  readonly concurrent?: { readonly activityId: string; readonly changes: readonly Readonly<Record<string, string>>[] };
  /** Custom-field definitions, values and field security (T-0091). Absent: no definitions. */
  readonly customFields?: CustomFieldsSetup;
}

export interface RecordedWrite {
  readonly method: 'POST' | 'PATCH';
  readonly path: string;
  readonly body: unknown;
  status?: number;
}

export interface ActivitiesMock {
  /** Every request the mock answered, in order. */
  readonly requests: URL[];
  /** listMyActivities requests, in order. */
  readonly bucketReads: URL[];
  /** listCalendar requests, in order. */
  readonly calendarReads: URL[];
  /** listContacts and listAccounts requests, in order. */
  readonly pickerReads: URL[];
  /** Every write, in order, with the status it was answered. */
  readonly writes: RecordedWrite[];
  /** Contract breaches by the SCREEN. Must be empty at the end of every test. */
  readonly violations: string[];
  /** Answers the MOCK built that its contract rejects. Must be empty, always. */
  readonly mockFaults: string[];
  /** The deliberate contract breaches `hostileSummaries` serves. */
  readonly plantedFaults: string[];
  /** The activities as they now stand. */
  readonly store: StoredActivity[];
  /** The custom-field half (T-0091): definition reads, custom writes and stored values. */
  readonly custom: CustomFieldsServer;
  release(): void;
  releaseWrites(): void;
}

export function isBucketRead(request: Request, bucket?: Bucket): boolean {
  const url = new URL(request.url());
  return request.method() === 'GET' && url.pathname === MY_ACTIVITIES_PATH && (bucket === undefined || url.searchParams.get('bucket') === bucket);
}

export function isCalendarRead(request: Request): boolean {
  return request.method() === 'GET' && new URL(request.url()).pathname === CALENDAR_PATH;
}

export function isCreateActivity(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === ACTIVITIES_PATH;
}

export function isUpdateActivity(request: Request, id?: string): boolean {
  const path = new URL(request.url()).pathname;
  return request.method() === 'PATCH' && (id === undefined ? path.startsWith(`${ACTIVITIES_PATH}/`) : path === `${ACTIVITIES_PATH}/${id}`);
}

const CREATE_SCHEMA = schema('CreateActivityRequest');
const UPDATE_SCHEMA = schema('UpdateActivityRequest');
const MY_PARAMETERS = parameterNames('listMyActivities');
const CALENDAR_PARAMETERS = parameterNames('listCalendar');
const PICKER_PARAMETERS = ['q', 'limit', 'cursor', 'sort'];
const TIME_FIELDS = ['dueAt', 'startsAt', 'endsAt'] as const;

/** Server time for the n-th write: after NOW, so nothing written is in the past. */
function serverTime(n: number): string {
  return new Date(NOW_MS + n * 1000).toISOString();
}

export async function installActivitiesMock(page: Page, options: ActivitiesMockOptions = {}): Promise<ActivitiesMock> {
  const browserTimeZone = options.browserTimeZone ?? 'Africa/Lagos';
  const store = initialStore(options);
  const requests: URL[] = [];
  const bucketReads: URL[] = [];
  const calendarReads: URL[] = [];
  const pickerReads: URL[] = [];
  const writes: RecordedWrite[] = [];
  const violations: string[] = [];
  const mockFaults: string[] = [];
  const plantedFaults: string[] = [];
  const custom = new CustomFieldsServer(options.customFields, violations);
  /** Versions served per activity id: a write must name one of them. */
  const servedVersions = new Map<string, Set<number>>();
  /** Versions already answered 409 per activity: sending one again is a blind retry. */
  const refusedVersions = new Map<string, Set<number>>();
  /** Values somebody else overwrote concurrently: sending one back undoes their save. */
  const overwritten = new Map<string, Map<string, string>>();
  /** Picker rows served: a create may target only these. */
  const servedTargets = new Map<string, 'contact' | 'account'>();
  const myCursors = new Map<string, { bucket: string; timeZone: string; afterId: string }>();
  const calendarCursors = new Map<string, { from: string; to: string; afterId: string }>();
  let cursorCount = 0;
  let writeCount = 0;
  let createCount = 0;
  let concurrentStep = 0;

  let release: () => void = () => undefined;
  const gate = options.hold === true ? new Promise<void>((done) => (release = done)) : Promise.resolve();
  let releaseWrites: () => void = () => undefined;
  const writeGate = options.holdWrites === true ? new Promise<void>((done) => (releaseWrites = done)) : Promise.resolve();

  /**
   * A problem is planted only if it goes away when the two hostile ids are
   * replaced by a well-formed one: anything else wrong with the same answer is
   * still the mock's fault.
   */
  const sanitised = (body: unknown): unknown =>
    JSON.parse(
      JSON.stringify(body)
        .split(JSON.stringify(HOSTILE_CONTACT_ID))
        .join(JSON.stringify(EMEKA.id))
        .split(JSON.stringify(HOSTILE_ACCOUNT_ID))
        .join(JSON.stringify(UBUNTU.id)),
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

  const serve = (row: StoredActivity): Json => {
    const versions = servedVersions.get(row.id) ?? new Set<number>();
    versions.add(row.version);
    servedVersions.set(row.id, versions);
    return asMyActivity(row);
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

  const checkQuery = (url: URL, allowed: readonly string[], operation: string): string[] => {
    const problems: string[] = [];
    for (const name of new Set(url.searchParams.keys())) {
      if (!allowed.includes(name)) problems.push(`${operation} declares no "${name}" parameter`);
      if (url.searchParams.getAll(name).length > 1) problems.push(`${name} was sent more than once`);
    }
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 25 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      problems.push(`limit=${String(rawLimit)} is outside 1..100`);
    }
    return problems;
  };

  const nextCursorFor = (prefix: string): string => {
    cursorCount += 1;
    return `${prefix}_${String(cursorCount).padStart(4, '0')}_k7Qz`;
  };

  // ----- listMyActivities ---------------------------------------------------

  const myActivities = async (route: Route, url: URL): Promise<void> => {
    bucketReads.push(url);
    await gate;
    const bucket = url.searchParams.get('bucket') ?? '';
    if (options.networkFailure === true || (options.bucketFailure !== undefined && bucket === options.bucketFailure)) {
      return route.abort('internetdisconnected');
    }
    const problems = checkQuery(url, MY_PARAMETERS, 'listMyActivities');
    if (!BUCKETS.includes(bucket)) problems.push(`bucket=${bucket} is not one of ${BUCKETS.join(', ')}`);
    const timeZone = url.searchParams.get('timeZone');
    if (timeZone === null) {
      problems.push('listMyActivities was sent no timeZone: the zone is the browser’s, never the server’s guess');
    } else if (!knownZone(timeZone)) {
      violations.push(`timeZone=${timeZone} is not an IANA zone name`);
      return answer(route, 'listMyActivities', 400, errorExample('ValidationFailed', 'badTimeZone'));
    } else if (timeZone !== browserTimeZone) {
      violations.push(`timeZone=${timeZone} was sent from a browser in ${browserTimeZone}: the zone was guessed, not read`);
    }
    if (problems.length > 0) {
      violations.push(...problems.map((problem) => `${url.search}: ${problem}`));
      return answer(route, 'listMyActivities', 400, validation(problems.map(() => ({ path: 'query', code: 'invalid_string' }))));
    }
    const zone = timeZone ?? browserTimeZone;
    const rows = bucketRows(store, bucket as Bucket, zone);
    let start = 0;
    const cursor = url.searchParams.get('cursor');
    if (cursor !== null) {
      const boundTo = myCursors.get(cursor);
      if (boundTo === undefined || boundTo.bucket !== bucket || boundTo.timeZone !== zone) {
        violations.push(`listMyActivities cursor "${cursor}" was not served for this bucket and zone — echo it, never build or move it`);
        return answer(route, 'listMyActivities', 400, errorExample('ValidationFailed', 'badCursor'));
      }
      start = rows.findIndex((row) => row.id === boundTo.afterId) + 1;
    }
    const limit = Number(url.searchParams.get('limit') ?? 25);
    const data = rows.slice(start, start + limit);
    const last = data.at(-1);
    let nextCursor: string | null = null;
    if (start + limit < rows.length && last !== undefined) {
      nextCursor = nextCursorFor('mac');
      myCursors.set(nextCursor, { bucket, timeZone: zone, afterId: last.id });
    }
    return answer(route, 'listMyActivities', 200, { data: data.map(serve), nextCursor });
  };

  // ----- listCalendar ---------------------------------------------------------

  const calendar = async (route: Route, url: URL): Promise<void> => {
    calendarReads.push(url);
    await gate;
    if (options.networkFailure === true || options.calendarFailure === true) {
      return route.abort('internetdisconnected');
    }
    const problems = checkQuery(url, CALENDAR_PARAMETERS, 'listCalendar');
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    for (const [name, value] of [
      ['from', from],
      ['to', to],
    ] as const) {
      if (!UTC_DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) {
        problems.push(`${name}=${value} is not a UTC date-time with a Z`);
      }
    }
    if (problems.length > 0) {
      violations.push(...problems.map((problem) => `${url.search}: ${problem}`));
      return answer(route, 'listCalendar', 400, validation(problems.map(() => ({ path: 'query', code: 'invalid_string' }))));
    }
    const span = Date.parse(to) - Date.parse(from);
    if (span <= 0) {
      violations.push(`listCalendar window ${from} – ${to}: to is not after from`);
      return answer(route, 'listCalendar', 400, validation([{ path: 'to', code: 'invalid_window' }]));
    }
    if (span > MAX_WINDOW_MS) {
      violations.push(`listCalendar window ${from} – ${to} is ${(span / DAY).toFixed(2)} days, over the 42-day limit`);
      return answer(route, 'listCalendar', 400, errorExample('ValidationFailed', 'windowTooLong'));
    }
    const rows = calendarRows(store, from, to);
    let start = 0;
    const cursor = url.searchParams.get('cursor');
    if (cursor !== null) {
      const boundTo = calendarCursors.get(cursor);
      if (boundTo === undefined || boundTo.from !== from || boundTo.to !== to) {
        violations.push(`listCalendar cursor "${cursor}" was not served for this window — echo it, never build or move it`);
        return answer(route, 'listCalendar', 400, errorExample('ValidationFailed', 'badCursor'));
      }
      start = rows.findIndex((row) => row.id === boundTo.afterId) + 1;
    }
    const limit = Number(url.searchParams.get('limit') ?? 25);
    const data = rows.slice(start, start + limit);
    const last = data.at(-1);
    let nextCursor: string | null = null;
    if (start + limit < rows.length && last !== undefined) {
      nextCursor = nextCursorFor('cal');
      calendarCursors.set(nextCursor, { from, to, afterId: last.id });
    }
    return answer(route, 'listCalendar', 200, { data: data.map(serve), nextCursor });
  };

  // ----- the picker -------------------------------------------------------------

  const picker = async (route: Route, url: URL, kind: 'contact' | 'account'): Promise<void> => {
    pickerReads.push(url);
    await gate;
    if (options.networkFailure === true) {
      return route.abort('internetdisconnected');
    }
    const operation = kind === 'contact' ? 'listContacts' : 'listAccounts';
    const problems = checkQuery(url, PICKER_PARAMETERS, `${operation} (the composer's picker)`);
    const q = url.searchParams.get('q');
    if (q !== null && (q.length < 1 || q.length > 100)) problems.push(`q is ${q.length} characters; 1..100`);
    if (problems.length > 0) {
      violations.push(...problems.map((problem) => `${url.search}: ${problem}`));
      return answer(route, operation, 400, validation(problems.map(() => ({ path: 'query', code: 'invalid_string' }))));
    }
    const rows = (kind === 'contact' ? PICK_CONTACTS : PICK_ACCOUNTS).filter((row) =>
      q === null ? true : folded(String(kind === 'contact' ? row.displayName : row.name)).includes(folded(q)),
    );
    for (const row of rows) servedTargets.set(String(row.id), kind);
    return answer(route, operation, 200, { data: clone(rows), nextCursor: null });
  };

  // ----- createActivity ----------------------------------------------------------

  const createActivity = async (route: Route, request: Request): Promise<void> => {
    const body = readBody(request, 'createActivity');
    const write: RecordedWrite = { method: 'POST', path: ACTIVITIES_PATH, body };
    writes.push(write);
    await writeGate;
    const reply = (status: number, payload: unknown): Promise<void> => {
      write.status = status;
      return answer(route, 'createActivity', status, payload);
    };
    if (!isJson(body)) {
      violations.push('createActivity body is not an object');
      return reply(400, validation([{ path: 'body', code: 'invalid_type' }]));
    }
    const problems = validateBody(body, CREATE_SCHEMA, '');
    const contactId = typeof body.contactId === 'string' ? body.contactId : undefined;
    const accountId = typeof body.accountId === 'string' ? body.accountId : undefined;
    if ((contactId === undefined) === (accountId === undefined)) {
      problems.push('the composer sends exactly one target: a contact or an account the picker served');
    }
    const targetId = contactId ?? accountId;
    const targetKind = contactId !== undefined ? 'contact' : 'account';
    if (targetId !== undefined && servedTargets.get(targetId) !== targetKind) {
      violations.push(`createActivity targeted ${targetKind} ${targetId}, which the picker never served`);
      return reply(404, errorExample('NotFound'));
    }
    if (body.ownerUserId !== ME.id) {
      problems.push(`ownerUserId is ${String(body.ownerUserId)}: P07 composes for the caller (${ME.id}), learnt from /auth/me`);
    }
    const type = String(body.type);
    const errors: { path: string; code: string }[] = [];
    if (type === 'meeting') {
      if (body.dueAt !== undefined && body.dueAt !== null) errors.push({ path: 'dueAt', code: 'task_only' });
      for (const field of ['startsAt', 'endsAt'] as const) {
        if (typeof body[field] !== 'string') errors.push({ path: field, code: 'required' });
      }
      if (typeof body.startsAt === 'string' && typeof body.endsAt === 'string') {
        const span = Date.parse(body.endsAt) - Date.parse(body.startsAt);
        if (span <= 0) errors.push({ path: 'endsAt', code: 'invalid_range' });
        else if (span > MAX_MEETING_MS) errors.push({ path: 'endsAt', code: 'too_long' });
      }
    } else {
      for (const field of ['startsAt', 'endsAt'] as const) {
        if (body[field] !== undefined) errors.push({ path: field, code: 'meeting_only' });
      }
      if (type !== 'task' && body.dueAt !== undefined && body.dueAt !== null) errors.push({ path: 'dueAt', code: 'task_only' });
    }
    violations.push(
      ...problems.map((problem) => `createActivity: ${problem}`),
      ...errors.map((error) => `createActivity: ${error.path} ${error.code} — the composer should have said so and sent nothing`),
    );
    // T-0091: `custom` on a create carries values only, checked for the activity object in the target's programme.
    const targetProgramme = String(
      (targetKind === 'contact' ? PICK_CONTACTS : PICK_ACCOUNTS).find((entry) => entry.id === targetId)?.programmeId ?? PROGRAMME_ONE.id,
    );
    const customAnswer = custom.checkCreate('activity', targetProgramme, body.custom, 'createActivity');
    if (customAnswer !== undefined) {
      return reply(customAnswer.status, customAnswer.body);
    }
    if (problems.length > 0 || errors.length > 0) {
      return reply(400, validation(errors.length > 0 ? errors : problems.map(() => ({ path: 'body', code: 'invalid_string' }))));
    }
    const id = NEW_ACTIVITY_IDS[createCount];
    if (id === undefined) {
      throw new Error('the mock ran out of NEW_ACTIVITY_IDS');
    }
    createCount += 1;
    writeCount += 1;
    const when = serverTime(writeCount);
    const target = (targetKind === 'contact' ? PICK_CONTACTS : PICK_ACCOUNTS).find((row) => row.id === targetId);
    const row: StoredActivity = {
      id,
      programmeId: String(target?.programmeId ?? PROGRAMME_ONE.id),
      type: type as StoredActivity['type'],
      subject: typeof body.subject === 'string' ? body.subject : null,
      dueAt: typeof body.dueAt === 'string' ? body.dueAt : null,
      completedAt: null,
      startsAt: typeof body.startsAt === 'string' ? body.startsAt : null,
      endsAt: typeof body.endsAt === 'string' ? body.endsAt : null,
      contact: targetKind === 'contact' ? { id: String(target?.id), displayName: String(target?.displayName) } : null,
      account: targetKind === 'account' ? { id: String(target?.id), name: String(target?.name) } : null,
      version: 1,
      createdAt: when,
      updatedAt: when,
    };
    store.push(row);
    const versions = servedVersions.get(id) ?? new Set<number>();
    versions.add(1);
    servedVersions.set(id, versions);
    custom.storeCreated(id, body.custom);
    const created = asActivity(row) as Json & { withheldFields: string[] };
    return reply(201, custom.decorate(created, 'activity', id, row.programmeId));
  };

  // ----- updateActivity ----------------------------------------------------------

  const updateActivity = async (route: Route, request: Request, id: string): Promise<void> => {
    const body = readBody(request, 'updateActivity');
    const write: RecordedWrite = { method: 'PATCH', path: `${ACTIVITIES_PATH}/${id}`, body };
    writes.push(write);
    await writeGate;
    const reply = (status: number, payload: unknown): Promise<void> => {
      write.status = status;
      return answer(route, 'updateActivity', status, payload);
    };
    const row = store.find((candidate) => candidate.id === id);
    if (row === undefined || !servedVersions.has(id)) {
      violations.push(`updateActivity named ${id}, which the screen was never served`);
      return reply(404, errorExample('NotFound'));
    }
    if (!isJson(body)) {
      violations.push('updateActivity body is not an object');
      return reply(400, validation([{ path: 'body', code: 'invalid_type' }]));
    }
    if (options.concurrent !== undefined && options.concurrent.activityId === id) {
      const change = options.concurrent.changes[concurrentStep];
      if (change !== undefined) {
        // Somebody else saves a moment before this write lands.
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
    const problems = validateBody(body, UPDATE_SCHEMA, '');
    const version = Number(body.version);
    if (!(servedVersions.get(id) ?? new Set<number>()).has(version)) {
      problems.push(`version ${String(body.version)} for ${id} is a version the screen was never served`);
    } else if ((refusedVersions.get(id) ?? new Set<number>()).has(version)) {
      problems.push(`version ${version} for ${id} was already refused with 409: a blind retry, not a re-read`);
    }
    if (body.completed === true && row.type !== 'task') problems.push(`completed on a ${row.type} (task_only)`);
    if ('dueAt' in body && row.type !== 'task') problems.push(`dueAt on a ${row.type} (task_only)`);
    for (const field of ['startsAt', 'endsAt'] as const) {
      if (field in body && row.type !== 'meeting') problems.push(`${field} on a ${row.type} (meeting_only)`);
    }
    for (const field of TIME_FIELDS) {
      const sent = body[field];
      if (typeof sent !== 'string' || !UTC_DATE_TIME.test(sent)) continue;
      const current = row[field];
      if (typeof current === 'string' && Date.parse(current) === Date.parse(sent)) {
        problems.push(`${field} was sent unchanged: send only what the person changed (D-L102)`);
      }
      const before = overwritten.get(id)?.get(field);
      if (before !== undefined && Date.parse(before) === Date.parse(sent)) {
        problems.push(`${field} was sent with the value somebody else just replaced: that undoes their save (D-L102)`);
      }
    }
    const startsAt = typeof body.startsAt === 'string' ? body.startsAt : row.startsAt;
    const endsAt = typeof body.endsAt === 'string' ? body.endsAt : row.endsAt;
    const errors: { path: string; code: string }[] = [];
    if (row.type === 'meeting' && ('startsAt' in body || 'endsAt' in body) && startsAt !== null && endsAt !== null) {
      const at = 'endsAt' in body ? 'endsAt' : 'startsAt';
      const span = Date.parse(endsAt) - Date.parse(startsAt);
      if (span <= 0) errors.push({ path: at, code: 'invalid_range' });
      else if (span > MAX_MEETING_MS) errors.push({ path: at, code: 'too_long' });
    }
    violations.push(
      ...problems.map((problem) => `updateActivity: ${problem}`),
      ...errors.map((error) => `updateActivity: ${error.path} ${error.code} — the form should have said so and sent nothing`),
    );
    // Order (the contract): 404, 403 (field_not_editable included), 400, 409.
    const notEditable = Object.keys(body).filter((key) => {
      const name = key === 'completed' ? 'completedAt' : key;
      return (READ_ONLY[row.programmeId] ?? []).includes(name) || (WITHHELD[row.programmeId] ?? []).includes(name);
    });
    if (notEditable.length > 0) {
      const refused = errorExample('NotPermitted', 'field');
      refused.details = notEditable.map((path) => ({ path, code: 'field_not_editable' }));
      return reply(403, refused);
    }
    if (problems.some((problem) => !/never served|blind retry|unchanged|just replaced/.test(problem)) || errors.length > 0) {
      return reply(400, validation(errors.length > 0 ? errors : [{ path: 'body', code: 'invalid_string' }]));
    }
    if (version !== row.version) {
      const refused = refusedVersions.get(id) ?? new Set<number>();
      refused.add(version);
      refusedVersions.set(id, refused);
      return reply(409, errorExample('StaleWrite'));
    }
    writeCount += 1;
    const when = serverTime(writeCount);
    if (body.completed === true) row.completedAt = row.completedAt ?? when;
    if ('dueAt' in body) row.dueAt = typeof body.dueAt === 'string' ? body.dueAt : null;
    if (typeof body.startsAt === 'string') row.startsAt = body.startsAt;
    if (typeof body.endsAt === 'string') row.endsAt = body.endsAt;
    row.version += 1;
    row.updatedAt = when;
    const versions = servedVersions.get(id) ?? new Set<number>();
    versions.add(row.version);
    servedVersions.set(id, versions);
    return reply(200, asActivity(row));
  };

  // ----- routing -----------------------------------------------------------------

  await page.route(
    (url) => url.pathname.startsWith('/api/v1/'),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      requests.push(url);
      checkHeaders(request, `${method} ${url.pathname}`);

      if (url.pathname === ME_PATH && method === 'GET') {
        return answer(route, 'getCurrentUser', 200, clone(CURRENT_USER));
      }
      if (url.pathname === PROGRAMMES_PATH && method === 'GET') {
        return answer(route, 'listMyProgrammes', 200, { data: [clone(PROGRAMME_ONE), clone(PROGRAMME_TWO), clone(PROGRAMME_THREE)] });
      }
      if (url.pathname === CUSTOM_FIELDS_PATH && method === 'GET') return custom.answerList(route);
      if (url.pathname === MY_ACTIVITIES_PATH && method === 'GET') return myActivities(route, url);
      if (url.pathname === CALENDAR_PATH && method === 'GET') return calendar(route, url);
      if (url.pathname === CONTACTS_PATH && method === 'GET') return picker(route, url, 'contact');
      if (url.pathname === ACCOUNTS_PATH && method === 'GET') return picker(route, url, 'account');
      if (url.pathname === ACTIVITIES_PATH && method === 'POST') return createActivity(route, request);
      const activity = /^\/api\/v1\/activities\/([^/]+)$/.exec(url.pathname);
      if (activity !== null && method === 'PATCH') {
        return updateActivity(route, request, decodeURIComponent(activity[1] ?? ''));
      }
      violations.push(`${method} ${url.pathname} is not an operation the activities screen uses`);
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store' },
        body: JSON.stringify(errorExample('NotFound')),
      });
    },
  );

  return {
    requests,
    bucketReads,
    calendarReads,
    pickerReads,
    writes,
    violations,
    mockFaults,
    plantedFaults,
    store,
    custom,
    release: () => release(),
    releaseWrites: () => releaseWrites(),
  };
}
