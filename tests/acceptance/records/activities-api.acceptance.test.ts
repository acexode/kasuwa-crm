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
  SEED_ACCOUNTS,
  SEED_ACTIVITIES,
  SEED_CONTACTS,
  SEED_PERMISSION_SETS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { parse } from 'yaml';
import { asUser, withAuthDatabase } from '../support/api';
import { collectTelemetry, type Telemetry } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0082, the activities API: my activities, the calendar,
 * meetings, snooze and reschedule (P07; Agent 3). Written by QA for the lead
 * before the build (D-L23, D-L25), from the contract and the decisions, not
 * from an implementation.
 *
 * Sources: team/tasks/T-0082-activities-api.md; docs/api/records.openapi.yaml
 * (listMyActivities, listCalendar, the `meeting` type, updateActivity's
 * snooze and reschedule, all committed by T-0081, #115); D-L105 (the T-0081
 * rulings), D-P18 (activity rights), D-P22 (Kasuwa events only), D-L72 (audit
 * value rules), D-L80 (id-only cursors), D-L81 (activity writes, no
 * reopening), D-L85 (versions on items), D-L87 (meetings and snoozing follow
 * D-P18), D-L97, D-L102 (send only changed fields). The T-0061 and T-0080
 * suites are the prior art; their helpers are copied here, never imported
 * (importing a test file registers its tests).
 *
 * Fixtures: packages/db/src/fixtures.ts only, plus rows planted here by
 * `kasuwa_migrator` (BYPASSRLS, never serves) with ids in this suite's own
 * range (`11111111-0000-4000-8000-0082xxxxxxxx`). If the spec and this file
 * disagree on something the spec states, the spec wins and this file is the
 * defect: say so in the report, do not edit it.
 *
 * ==========================================================================
 * PINNED INTERFACES (the builder must honour these exactly)
 * ==========================================================================
 *
 * M1. COLUMNS. A meeting's times are `activity.starts_at` and
 *     `activity.ends_at` (timestamptz), and `activity.type` admits
 *     `meeting`. This suite plants meetings through the migrator with those
 *     names. Their field-security rows are STANDARD `field_def`s on the
 *     `activity` object named `starts_at` and `ends_at` (the snake_case of
 *     the wire names, as `due_at` is for `dueAt`), in every tenant: the suite
 *     plants grants against them and never field definitions.
 *
 * L1. listMyActivities. `GET /api/v1/me/activities?timeZone&bucket[&cursor]
 *     [&limit]`. The caller's OWN (`owner_user_id` = the session user) open
 *     (`completed_at IS NULL`) tasks in the programmes the session resolves,
 *     nothing else. Buckets at the server's instant N, in `timeZone`:
 *     overdue `dueAt < N`; today `N <= dueAt < M`, M the first local midnight
 *     after N; upcoming `dueAt >= M`, then undated tasks. Order `dueAt`
 *     ascending, ties and the undated tail by `id` ascending. 200 is
 *     `MyActivityPage` exactly.
 *
 * L2. listCalendar. `GET /api/v1/me/calendar?from&to[&cursor][&limit]`. The
 *     caller's own tasks with `from <= dueAt < to`, open or completed (with
 *     `completedAt`), and own meetings with `startsAt < to AND endsAt > from`.
 *     Order by start (`dueAt` or `startsAt`) ascending, ties by `id`. `to`
 *     after `from` (else `invalid_window` at `to`), at most 42 days after it
 *     (else `window_too_long` at `to`), never clamped.
 *
 * L3. FIELD SECURITY BEFORE PAGING. Judged in the activity's own programme by
 *     the set held there. A withheld `dueAt` (task) or `startsAt`/`endsAt`
 *     (meeting) drops the row from both lists before the page is cut: the id
 *     is in no body and no cursor reading, and every page with a non-null
 *     `nextCursor` holds `limit` items. Other withheld fields are omitted and
 *     named in `withheldFields`; `contact` and `account` follow `contact_id`
 *     and `account_id`.
 *
 * L4. CURSORS. Opaque, id-only (D-L80): no subject, name or time in any
 *     reading this suite can make, and no id of a row not yet served. One
 *     `400 validation_failed` body with `details[].code: invalid_cursor`
 *     whatever the reason (malformed; nowhere; someone else's; another
 *     tenant's; a note; a withheld sort field; a programme no longer
 *     reached), byte for byte. A task completed or snoozed since still
 *     resolves (200).
 *
 * W1. MEETINGS ON CREATE. `startsAt`, `endsAt` required (`required` at the
 *     missing one), `endsAt > startsAt` (`invalid_range` at `endsAt`), at
 *     most 24 h (`too_long` at `endsAt`; exactly 24 h is accepted). Either
 *     time on a note, a task or a call is `meeting_only` at that field;
 *     `dueAt` on a meeting is `task_only`. UTC with a `Z`, never null.
 *
 * W2. SNOOZE AND RESCHEDULE. updateActivity takes `dueAt` (a task; `null`
 *     clears) and `startsAt`/`endsAt` (a meeting; not nullable). The meeting
 *     rules are judged on the RESULT, at the field sent (`endsAt` when both
 *     are sent). Completing a meeting is `task_only`. Rights are
 *     `activity.write` in the activity's programme (D-P18), the owner does
 *     not matter. `version` is required; stale is `409 stale_write` and
 *     changes nothing. Absent fields are untouched (D-L102). Error order 404,
 *     403, 400, 409, on create 404, 403, 400.
 *
 * W3. AUDIT. One `updated` event per successful update on `object_type
 *     'activity'`, labelled by the id, naming exactly the fields whose value
 *     changed, each `{ field, before: null, after: null, redacted: true }`
 *     (D-L72: times are not value fields). A create of a meeting names
 *     `startsAt` and `endsAt` the same way. A refusal writes none. No time,
 *     subject or body value is anywhere in `changes`.
 *
 * T1. TIMELINES. Every activity item on the contact and account timelines
 *     carries `startsAt` and `endsAt` (null off a meeting) unless withheld,
 *     when they are omitted from the item (a timeline does not drop the row).
 *     A meeting is `activityType: meeting`.
 *
 * F1. FLAGS. Both operations and every property T-0081 marked pending are
 *     `x-kasuwa-implemented: true`.
 *
 * ==========================================================================
 * THE BUILDER'S (not asserted)
 * ==========================================================================
 * Cursor encoding (beyond L4); indexes (escalate if one needs an RLS-unsafe
 * expression, per the task); whether the database refuses a meeting with no
 * times or a note with a due time; detail paths of `limit`, `bucket`, `from`
 * and malformed times (only the status and envelope are pinned); whether an
 * unknown query parameter is ignored or 400 (either is allowed, as long as it
 * never widens what is listed); whether the server reads its instant from
 * Node or from Postgres (the bucket test tolerates five minutes of skew).
 *
 * ==========================================================================
 * D-L23: on main the two routes do not exist, `activity` has no `starts_at`
 * or `ends_at`, the live updateActivity refuses `dueAt`, `startsAt` and
 * `endsAt` as unknown properties, and the flags are false. Every test except
 * the ones titled "(self-check)" begins with a request or a plant that fails
 * on main for one of those reasons: a 404 for the route where 200 is
 * expected, a missing column, a 400 where 200 is expected, or a false flag.
 * Self-checks test this file's own helpers and pass at commit time.
 *
 * Writes: the suite reseeds before and after, and after every test.
 */

// ---------------------------------------------------------------------------
// Constants and fixtures (packages/db/src/fixtures.ts, never a second set).
// ---------------------------------------------------------------------------

const ME_ACTIVITIES = '/api/v1/me/activities';
const ME_CALENDAR = '/api/v1/me/calendar';
const ACTIVITIES = '/api/v1/activities';
const CONTACTS = '/api/v1/contacts';
const ACCOUNTS = '/api/v1/accounts';

/** This suite's id range: `0082` marks T-0082. Tails are hex. */
const id82 = (tail: string) => `11111111-0000-4000-8000-0082${tail.padStart(8, '0')}`;
/** Never a real row. */
const NOWHERE = id82('fffffff');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);
const AGENT_2 = asUser(TENANT_A, USER_A_AGENT_2);
const NO_PROGRAMME = asUser(TENANT_A, USER_A_NO_PROGRAMME);
const TENANT_B_ADMIN = asUser(TENANT_B, USER_B_AGENT_1);

type Headers = Record<string, string>;
type Json = Record<string, unknown>;
type Params = readonly (readonly [string, string])[];

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
/** Tenant A, A2: outside agent 1's reach. */
const DAMILOLA = seededContact('Damilola');
/** Tenant B, B1. */
const GRACE = seededContact('Grace');
/** "Ikoyi Traders", A1. */
const IKOYI = seededAccount(PROGRAMME_A1);

/** Tenant B's seeded task: undated, owned by tenant B's only user. */
const SEEDED_B_TASK = (() => {
  const found = SEED_ACTIVITIES.find(
    (activity) => activity.tenantId === TENANT_B && activity.type === 'task',
  );
  if (found === undefined) throw new Error('Fixture drift: no seeded task in tenant B');
  return found;
})();

/** Tenant A's seeded note on Ikoyi, owned by agent 1 (a note: never listed). */
const SEEDED_A_NOTE = (() => {
  const found = SEED_ACTIVITIES.find((activity) => activity.tenantId === TENANT_A);
  if (found === undefined) throw new Error('Fixture drift: no seeded activity in tenant A');
  return found;
})();

function permissionSet(tenantId: string, key: string): string {
  const set = SEED_PERMISSION_SETS.find(
    (candidate) => candidate.tenantId === tenantId && candidate.key === key,
  );
  if (set === undefined) throw new Error(`Fixture drift: no seeded permission set '${key}'`);
  return set.id;
}

const PROGRAMME_TENANT: Readonly<Record<string, string>> = {
  [PROGRAMME_A1]: TENANT_A,
  [PROGRAMME_A2]: TENANT_A,
  [PROGRAMME_B1]: TENANT_B,
};
const PROGRAMME_CONTACT: Readonly<Record<string, string>> = {
  [PROGRAMME_A1]: AMAKA.id,
  [PROGRAMME_A2]: DAMILOLA.id,
  [PROGRAMME_B1]: GRACE.id,
};

/** Unique per run so a probe never matches an earlier, unreseeded run. */
const RUN = Date.now().toString(36);

const iso = (ms: number) => new Date(ms).toISOString();

/** A fixed future instant for calendar windows: independent of today. */
const W = Date.UTC(2031, 2, 3, 0, 0, 0);

// ---------------------------------------------------------------------------
// Time zones: an independent next-midnight computation (Intl, not the
// server's code), proven by the self-check below.
// ---------------------------------------------------------------------------

/** The zones the bucket test runs in: WAT, SAST, EAT, IST (+05:30) and a DST zone. */
const ZONES = [
  'Africa/Lagos',
  'Africa/Johannesburg',
  'Africa/Nairobi',
  'Asia/Kolkata',
  'America/Los_Angeles',
] as const;

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(zone: string, ms: number): Wall {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = new Map(
    format
      .formatToParts(ms)
      .filter((part) => part.type !== 'literal')
      .map((part) => [String(part.type), Number(part.value)] as const),
  );
  const get = (key: string) => {
    const value = parts.get(key);
    if (value === undefined || Number.isNaN(value)) throw new Error(`Intl gave no ${key}`);
    return value;
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Wall time minus UTC, in ms, at `ms` (whole seconds). */
function offsetAt(zone: string, ms: number): number {
  const wall = wallClock(zone, ms);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(ms / SECOND) * SECOND;
}

/** The first local midnight in `zone` strictly after `ms`, as a UTC instant. */
function nextMidnight(zone: string, ms: number): number {
  const wall = wallClock(zone, ms);
  const target = Date.UTC(wall.year, wall.month - 1, wall.day + 1);
  let guess = target - offsetAt(zone, target);
  guess = target - offsetAt(zone, guess);
  guess = target - offsetAt(zone, guess);
  const check = wallClock(zone, guess);
  if (check.hour !== 0 || check.minute !== 0 || check.second !== 0 || guess <= ms) {
    throw new Error(`nextMidnight(${zone}, ${iso(ms)}) found ${iso(guess)}, not a midnight`);
  }
  return guess;
}

type Bucket = 'overdue' | 'today' | 'upcoming';
const BUCKETS: readonly Bucket[] = ['overdue', 'today', 'upcoming'];

/** L1, at the server's instant `now`. */
function bucketOf(dueAt: number | null, now: number, zone: string): Bucket {
  if (dueAt === null) return 'upcoming';
  if (dueAt < now) return 'overdue';
  return dueAt < nextMidnight(zone, now) ? 'today' : 'upcoming';
}

/** The server may read its clock from Postgres in a container; tolerate this much skew. */
const SKEW = 5 * MINUTE;

// ---------------------------------------------------------------------------
// A small JSON-Schema checker over the published YAML (no new dependency).
// Copied from the T-0080 suite: `allOf`, `oneOf`, `const`, closed objects.
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

  if (Array.isArray(value) && schema.items !== undefined && typeof schema.items === 'object') {
    value.forEach((item, index) =>
      check(schema.items as Json, at, item, `${path}[${index}]`, errors),
    );
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

function responseSchemaOf(operationId: string, status: string): Json {
  const { op } = requireOperation(operationId);
  const raw = ((op.responses ?? {}) as Json)[status] as Json | undefined;
  if (raw === undefined) throw new Error(`${operationId} documents no ${status} response`);
  const response = deref(raw, SPEC_PATH).schema;
  const schema = ((response.content as Json | undefined)?.['application/json'] as Json | undefined)
    ?.schema as Json | undefined;
  if (schema === undefined) throw new Error(`${operationId} ${status} has no JSON schema`);
  return schema;
}

function rawSchemaProperty(schema: string, key: string): Json | undefined {
  const node = atPointer(loadDoc(SPEC_PATH), `/components/schemas/${schema}`) as Json;
  return ((node.properties ?? {}) as Record<string, Json>)[key];
}

// ---------------------------------------------------------------------------
// Response checks.
// ---------------------------------------------------------------------------

/** admin.openapi.yaml `Error`, with the status and `code` the operation names. */
function expectError(response: request.Response, status: number, code: string): Json {
  expect(
    response.status,
    `expected ${status} ${code}, got ${response.status} ${JSON.stringify(response.body)}`,
  ).toBe(status);
  expect(
    schemaErrors(
      { $ref: './admin.openapi.yaml#/components/schemas/Error' },
      response.body,
      'Error',
    ),
    'response body does not match the shared Error schema',
  ).toEqual([]);
  const body = response.body as Json;
  expect(body.statusCode, 'Error.statusCode').toBe(status);
  expect(body.code, 'Error.code — clients switch on this, never on message').toBe(code);
  return body;
}

function detailsOf(body: Json): { path: string; code: string }[] {
  return Array.isArray(body.details) ? (body.details as { path: string; code: string }[]) : [];
}

/** A 400 whose details carry `code` at `path`. */
function expectDetail(response: request.Response, path: string, code: string, where: string) {
  const body = expectError(response, 400, 'validation_failed');
  expect(
    detailsOf(body).map((detail) => `${detail.path}:${detail.code}`),
    `${where}: details`,
  ).toContain(`${path}:${code}`);
  return body;
}

function expectStatus(response: request.Response, status: number, where: string): void {
  expect(response.status, `${where}: ${JSON.stringify(response.body)}`).toBe(status);
}

function expectNoStore(response: request.Response, where: string): void {
  expect(
    String(response.headers['cache-control'] ?? ''),
    `${where}: Cache-Control must be no-store`,
  ).toMatch(/(^|[\s,])no-store($|[\s,])/);
}

/** D-P13: a count in a header is a total by another name. */
function expectNoTotals(response: request.Response, where: string): void {
  const headers = Object.keys(response.headers).filter((name) => /total|count/i.test(name));
  expect(headers, `${where}: a response header carries a total`).toEqual([]);
}

interface Page {
  data: Json[];
  nextCursor: string | null;
}

function pageOf(value: unknown): Page {
  const page = (value ?? {}) as { data?: unknown; nextCursor?: unknown };
  return {
    data: Array.isArray(page.data) ? (page.data as Json[]) : [],
    nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null,
  };
}

/** MyActivity keys whose presence and withholding must agree (L3). */
const MY_WITHHOLDABLE = [
  'subject',
  'dueAt',
  'completedAt',
  'startsAt',
  'endsAt',
  'contact',
  'account',
];

type ListKind = 'listMyActivities' | 'listCalendar';

/** One MyActivityPage, validated against the operation's own 200 schema and L1-L3. */
function myPageProblems(value: unknown, kind: ListKind, where: string): string[] {
  const problems = schemaErrors(responseSchemaOf(kind, '200'), value, where);
  const keys = Object.keys((value ?? {}) as Json).sort();
  if (keys.join() !== 'data,nextCursor') problems.push(`${where}: page keys ${keys.join()}`);
  pageOf(value).data.forEach((item, index) => {
    const at = `${where}.data[${index}]`;
    const withheld = (Array.isArray(item.withheldFields) ? item.withheldFields : []) as string[];
    for (const key of MY_WITHHOLDABLE) {
      if (key in item === withheld.includes(key)) {
        problems.push(`${at}: ${key} must be present or listed in withheldFields, exactly one`);
      }
    }
    if (kind === 'listMyActivities') {
      if (item.type !== 'task') problems.push(`${at}: listMyActivities lists tasks only`);
      if ('completedAt' in item && item.completedAt !== null) {
        problems.push(`${at}: an open task's completedAt is not null`);
      }
    }
    if (item.type === 'task') {
      for (const key of ['startsAt', 'endsAt']) {
        if (key in item && item[key] !== null) problems.push(`${at}: a task's ${key} is not null`);
      }
    }
    if (item.type === 'meeting') {
      if ('dueAt' in item && item.dueAt !== null) problems.push(`${at}: a meeting has a dueAt`);
      for (const key of ['startsAt', 'endsAt']) {
        if (!(key in item) || item[key] === null) {
          problems.push(`${at}: a listed meeting must carry ${key} (a withheld one is not listed)`);
        }
      }
    }
    if (item.type === 'task' && !('dueAt' in item)) {
      problems.push(`${at}: a listed task must carry dueAt (a withheld one is not listed)`);
    }
  });
  return problems;
}

/** L1 order: dueAt ascending, undated last, ties and the undated tail by id. */
function myOrderProblems(items: Json[]): string[] {
  const problems: string[] = [];
  for (let index = 1; index < items.length; index += 1) {
    const a = items[index - 1] ?? {};
    const b = items[index] ?? {};
    const da = a.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(String(a.dueAt));
    const db = b.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(String(b.dueAt));
    if (da > db) problems.push(`[${index - 1}] is due after [${index}]`);
    if (da === db && !(String(a.id) < String(b.id))) {
      problems.push(`[${index - 1}] and [${index}] share a due time and ids are not ascending`);
    }
  }
  return problems;
}

const startOf = (item: Json): number =>
  Date.parse(String(item.type === 'meeting' ? item.startsAt : item.dueAt));

/** L2 order: by start ascending, ties by id. */
function calendarOrderProblems(items: Json[]): string[] {
  const problems: string[] = [];
  for (let index = 1; index < items.length; index += 1) {
    const a = items[index - 1] ?? {};
    const b = items[index] ?? {};
    if (startOf(a) > startOf(b)) problems.push(`[${index - 1}] starts after [${index}]`);
    if (startOf(a) === startOf(b) && !(String(a.id) < String(b.id))) {
      problems.push(`[${index - 1}] and [${index}] share a start and ids are not ascending`);
    }
  }
  return problems;
}

/** The Activity response, through the operation's own schema; times present or withheld. */
function expectActivity(
  response: request.Response,
  operationId: 'createActivity' | 'updateActivity',
  status: number,
  where: string,
): Json {
  expectStatus(response, status, where);
  expect(
    schemaErrors(responseSchemaOf(operationId, String(status)), response.body, where),
    `${where} does not match the ${operationId} ${status} schema`,
  ).toEqual([]);
  const activity = response.body as Json;
  const withheld = (
    Array.isArray(activity.withheldFields) ? activity.withheldFields : []
  ) as string[];
  const problems: string[] = [];
  for (const key of ['dueAt', 'completedAt', 'startsAt', 'endsAt']) {
    if (key in activity === withheld.includes(key)) {
      problems.push(`${key} must be present or listed in withheldFields, exactly one`);
    }
  }
  if (activity.type !== 'meeting') {
    for (const key of ['startsAt', 'endsAt']) {
      if (key in activity && activity[key] !== null) problems.push(`${key} off a meeting`);
    }
  }
  expect(problems, `${where}: Activity`).toEqual([]);
  return activity;
}

const sameInstant = (wire: unknown, ms: number | null) =>
  ms === null ? wire === null : typeof wire === 'string' && Date.parse(wire) === ms;

// ---------------------------------------------------------------------------
// Reading a cursor every way this suite can, to look inside it (L4).
// ---------------------------------------------------------------------------

function decodeOnce(text: string): string[] {
  const out: string[] = [];
  try {
    out.push(decodeURIComponent(text));
  } catch {
    // not URI-encoded
  }
  for (const encoding of ['base64url', 'base64'] as const) {
    out.push(Buffer.from(text, encoding).toString('utf8'));
    out.push(Buffer.from(text, encoding).toString('latin1'));
  }
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) {
    out.push(Buffer.from(text, 'hex').toString('utf8'));
  }
  return out;
}

function cursorReadings(cursor: string): string[] {
  const first = [cursor, ...decodeOnce(cursor)];
  const second = first.flatMap((text) =>
    /^[A-Za-z0-9_\-+/=%]+$/.test(text) ? decodeOnce(text) : [],
  );
  return [...first, ...second].map((text) => text.toLowerCase());
}

const idForms = (id: string) => [id.toLowerCase(), id.toLowerCase().replace(/-/g, '')];

/** Every rendering of an instant a cursor could carry it in. */
function timeForms(ms: number): string[] {
  const text = iso(ms);
  return [
    text.toLowerCase(),
    text.replace(/\.\d{3}z$/i, '').toLowerCase(),
    String(ms),
    String(Math.floor(ms / SECOND)),
  ];
}

// ---------------------------------------------------------------------------
// Log capture: every channel the process can write to (the T-0036 approach).
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

/** Database text an error BODY must never carry. */
const DATABASE_TEXT_IN_BODIES = [
  'Failing row contains',
  'violates',
  'constraint',
  '23514',
  '22007',
];

// ---------------------------------------------------------------------------

describe('acceptance: the activities API — my tasks, the calendar, meetings, snooze and reschedule (T-0082)', () => {
  let app: INestApplication;
  /** kasuwa_migrator — BYPASSRLS. Plants rows and observes them; never serves. */
  let observer: Pool;

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
  });

  afterAll(async () => {
    await app?.close();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();

  // --- HTTP helpers -------------------------------------------------------

  const withQuery = (path: string, params: Params) => {
    const query = new URLSearchParams(params.map(([k, v]): [string, string] => [k, v])).toString();
    return query === '' ? path : `${path}?${query}`;
  };
  const myActivities = (headers: Headers, params: Params) =>
    request(server()).get(withQuery(ME_ACTIVITIES, params)).set(headers);
  /** A raw query string, for repeated or unencodable parameters. */
  const myActivitiesRaw = (headers: Headers, query: string) =>
    request(server()).get(`${ME_ACTIVITIES}?${query}`).set(headers);
  const calendar = (headers: Headers, params: Params) =>
    request(server()).get(withQuery(ME_CALENDAR, params)).set(headers);
  const createActivity = (headers: Headers, body: Json) =>
    request(server()).post(ACTIVITIES).set(headers).send(body);
  const updateActivity = (headers: Headers, id: string, body: Json) =>
    request(server()).patch(`${ACTIVITIES}/${id}`).set(headers).send(body);
  const contactTimeline = (headers: Headers, id: string) =>
    request(server()).get(`${CONTACTS}/${id}/timeline?limit=100`).set(headers);
  const accountTimeline = (headers: Headers, id: string) =>
    request(server()).get(`${ACCOUNTS}/${id}/timeline?limit=100`).set(headers);

  const bucketParams = (zone: string, bucket: Bucket, extra: Params = []): Params => [
    ['timeZone', zone],
    ['bucket', bucket],
    ...extra,
  ];
  const windowParams = (from: number, to: number, extra: Params = []): Params => [
    ['from', iso(from)],
    ['to', iso(to)],
    ...extra,
  ];

  /** The control every list test opens with: the route answers. On main it is a 404. */
  async function expectListsServed(headers: Headers = AGENT_1) {
    const mine = await myActivities(headers, bucketParams('Africa/Lagos', 'today'));
    expectStatus(mine, 200, 'control: listMyActivities is served');
    const events = await calendar(headers, windowParams(W, W + DAY));
    expectStatus(events, 200, 'control: listCalendar is served');
  }

  /** One whole bucket (limit 100), validated, with the instants around the request. */
  async function readBucket(headers: Headers, zone: string, bucket: Bucket, where: string) {
    const before = Date.now();
    const response = await myActivities(headers, bucketParams(zone, bucket, [['limit', '100']]));
    const after = Date.now();
    expectStatus(response, 200, where);
    expectNoStore(response, where);
    expectNoTotals(response, where);
    expect(myPageProblems(response.body, 'listMyActivities', where)).toEqual([]);
    const page = pageOf(response.body);
    expect(myOrderProblems(page.data), `${where}: order`).toEqual([]);
    expect(page.nextCursor, `${where}: more than 100 items; never planted here`).toBeNull();
    return { items: page.data, before, after, text: response.text };
  }

  /** Every open-task id in every bucket for one zone. */
  async function allBuckets(headers: Headers, zone = 'Africa/Lagos'): Promise<string[]> {
    const ids: string[] = [];
    for (const bucket of BUCKETS) {
      const { items } = await readBucket(headers, zone, bucket, `${zone} ${bucket}`);
      ids.push(...items.map((item) => String(item.id)));
    }
    return ids;
  }

  async function readCalendar(headers: Headers, from: number, to: number, where: string) {
    const response = await calendar(headers, windowParams(from, to, [['limit', '100']]));
    expectStatus(response, 200, where);
    expectNoStore(response, where);
    expectNoTotals(response, where);
    expect(myPageProblems(response.body, 'listCalendar', where)).toEqual([]);
    const page = pageOf(response.body);
    expect(calendarOrderProblems(page.data), `${where}: order`).toEqual([]);
    expect(page.nextCursor, `${where}: more than 100 items; never planted here`).toBeNull();
    return page.data;
  }

  interface Walked {
    items: Json[];
    cursors: string[];
    bodies: string[];
  }

  /** Walks every page (L3, L4): a page with a cursor is full, no item repeats. */
  async function walk(
    read: (params: Params) => request.Test,
    kind: ListKind,
    limit: number | null,
  ): Promise<Walked> {
    const walked: Walked = { items: [], cursors: [], bodies: [] };
    let cursor: string | null = null;
    let pages = 0;
    do {
      const params: [string, string][] = limit === null ? [] : [['limit', String(limit)]];
      if (cursor !== null) params.push(['cursor', cursor]);
      const where = `${kind} page ${pages + 1} at limit ${String(limit)}`;
      const response = await read(params);
      expectStatus(response, 200, where);
      expectNoStore(response, where);
      expectNoTotals(response, where);
      expect(myPageProblems(response.body, kind, where)).toEqual([]);
      const page = pageOf(response.body);
      const full = limit ?? 25;
      if (page.nextCursor !== null) {
        expect(
          page.data.length,
          `${where} has a nextCursor but ${page.data.length} of ${full} items: ` +
            'rows were dropped after the page was cut (L3)',
        ).toBe(full);
        walked.cursors.push(page.nextCursor);
      }
      walked.items.push(...page.data);
      walked.bodies.push(response.text);
      cursor = page.nextCursor;
      pages += 1;
      if (pages > 150) throw new Error('paging did not terminate');
    } while (cursor !== null);
    const ids = walked.items.map((item) => String(item.id));
    expect(new Set(ids).size, `${kind}: an item was repeated across pages`).toBe(ids.length);
    const order =
      kind === 'listMyActivities'
        ? myOrderProblems(walked.items)
        : calendarOrderProblems(walked.items);
    expect(order, `${kind}: the walk as a whole is in order`).toEqual([]);
    return walked;
  }

  // --- observer helpers ----------------------------------------------------

  interface Planted {
    id: string;
    programmeId?: string;
    type: 'note' | 'task' | 'call' | 'meeting';
    subject?: string | null;
    body?: string | null;
    contactId?: string | null;
    accountId?: string | null;
    /** Omitted: agent 1. `null`: unowned. */
    ownerUserId?: string | null;
    createdByUserId?: string | null;
    dueAt?: number | null;
    completedAt?: number | null;
    startsAt?: number;
    endsAt?: number;
    createdAt?: number;
  }

  /**
   * Plants one activity as the migrator. The meeting columns are named only
   * when a meeting time is given, so planting tasks works on main and
   * planting a meeting fails there on the missing column (M1).
   */
  async function plant(row: Planted): Promise<string> {
    const programmeId = row.programmeId ?? PROGRAMME_A1;
    const tenantId = PROGRAMME_TENANT[programmeId];
    if (tenantId === undefined) throw new Error(`no tenant for programme ${programmeId}`);
    const hasTarget = row.contactId !== undefined || row.accountId !== undefined;
    const columns: [string, unknown][] = [
      ['id', row.id],
      ['tenant_id', tenantId],
      ['programme_id', programmeId],
      ['type', row.type],
      ['subject', row.subject === undefined ? `T0082 planted ${row.type} ${RUN}` : row.subject],
      ['body', row.body === undefined ? 'Invented text that names no one.' : row.body],
      ['owner_user_id', row.ownerUserId === undefined ? USER_A_AGENT_1 : row.ownerUserId],
      ['contact_id', hasTarget ? (row.contactId ?? null) : PROGRAMME_CONTACT[programmeId]],
      ['account_id', row.accountId ?? null],
      [
        'created_by_user_id',
        row.createdByUserId === undefined
          ? tenantId === TENANT_A
            ? USER_A_SUPERVISOR
            : USER_B_AGENT_1
          : row.createdByUserId,
      ],
      ['due_at', row.dueAt === undefined || row.dueAt === null ? null : iso(row.dueAt)],
      [
        'completed_at',
        row.completedAt === undefined || row.completedAt === null ? null : iso(row.completedAt),
      ],
    ];
    if (row.startsAt !== undefined || row.endsAt !== undefined) {
      columns.push(['starts_at', row.startsAt === undefined ? null : iso(row.startsAt)]);
      columns.push(['ends_at', row.endsAt === undefined ? null : iso(row.endsAt)]);
    }
    if (row.createdAt !== undefined) columns.push(['created_at', iso(row.createdAt)]);
    await observer.query(
      `INSERT INTO activity (${columns.map(([name]) => name).join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      columns.map(([, value]) => value),
    );
    return row.id;
  }

  const plantTask = (id: string, dueAt: number | null, extra: Partial<Planted> = {}) =>
    plant({ id, type: 'task', dueAt, ...extra });
  const plantMeeting = (
    id: string,
    startsAt: number,
    endsAt: number,
    extra: Partial<Planted> = {},
  ) => plant({ id, type: 'meeting', startsAt, endsAt, ...extra });

  async function activityRow(id: string): Promise<Json | null> {
    const result = await observer.query<Json>('SELECT * FROM activity WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async function versionOf(id: string): Promise<number> {
    return Number((await activityRow(id))?.version);
  }

  async function activityCount(): Promise<number> {
    const result = await observer.query<{ n: string }>('SELECT count(*) AS n FROM activity');
    return Number(result.rows[0]?.n);
  }

  const msOf = (value: unknown): number | null =>
    value === null || value === undefined ? null : new Date(value as string | Date).getTime();

  async function assign(userId: string, programmeId: string, key: string) {
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id)
       DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, TENANT_A, permissionSet(TENANT_A, key)],
    );
  }

  async function unassign(userId: string, programmeId: string) {
    await observer.query('DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2', [
      userId,
      programmeId,
    ]);
  }

  /** One activity field-security decision in tenant A, against its standard field_def (M1). */
  async function lockField(field: string, setKey: string, level: 'none' | 'read' | 'edit') {
    const found = await observer.query<{ id: string }>(
      `SELECT f.id FROM field_def f
         JOIN object_def o ON o.id = f.object_id AND o.tenant_id = f.tenant_id
        WHERE f.tenant_id = $1 AND o.api_name = 'activity' AND f.api_name = $2
          AND NOT f.is_custom`,
      [TENANT_A, field],
    );
    const fieldId = found.rows[0]?.id;
    if (fieldId === undefined) {
      throw new Error(
        `tenant A has no standard field_def activity.${field}. M1: the T-0082 migration adds ` +
          'starts_at and ends_at to the activity catalogue; this suite plants grants only.',
      );
    }
    await observer.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [TENANT_A, fieldId, permissionSet(TENANT_A, setKey), level],
    );
  }

  interface Change {
    field: string;
    before: unknown;
    after: unknown;
    redacted: unknown;
  }
  interface AuditRow {
    id: string;
    action: string;
    actor_user_id: string | null;
    object_type: string;
    object_id: string | null;
    object_label: string;
    programme_id: string | null;
    changes: Change[];
  }

  async function auditIds(): Promise<Set<string>> {
    const result = await observer.query<{ id: string }>('SELECT id FROM audit_event');
    return new Set(result.rows.map((row) => row.id));
  }

  async function auditSince(before: Set<string>): Promise<AuditRow[]> {
    const result = await observer.query<AuditRow>('SELECT * FROM audit_event ORDER BY occurred_at');
    return result.rows.filter((row) => !before.has(row.id));
  }

  const named = (field: string): Change => ({ field, before: null, after: null, redacted: true });
  const sortedChanges = (changes: Change[]) =>
    [...changes].sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));

  // =========================================================================
  // 0. Self-checks: this file's own helpers. They pass at commit time, by
  //    design; a checker only ever seen passing proves nothing.
  // =========================================================================

  describe('(self-check) the helpers this suite judges the server with', () => {
    it('(self-check) nextMidnight is right in WAT, EAT, IST and across a DST change, and today is not always 24 hours', () => {
      const noon = Date.UTC(2026, 9, 12, 12, 0, 0);
      expect(iso(nextMidnight('Africa/Lagos', noon))).toBe('2026-10-12T23:00:00.000Z');
      expect(iso(nextMidnight('Africa/Johannesburg', noon))).toBe('2026-10-12T22:00:00.000Z');
      expect(iso(nextMidnight('Africa/Nairobi', noon))).toBe('2026-10-12T21:00:00.000Z');
      expect(iso(nextMidnight('Asia/Kolkata', noon))).toBe('2026-10-12T18:30:00.000Z');
      expect(iso(nextMidnight('America/Los_Angeles', noon))).toBe('2026-10-13T07:00:00.000Z');
      expect(iso(nextMidnight('UTC', noon))).toBe('2026-10-13T00:00:00.000Z');
      // A midnight is never "now": one millisecond before it, it is next.
      const lagos = Date.UTC(2026, 9, 12, 23, 0, 0);
      expect(nextMidnight('Africa/Lagos', lagos - 1)).toBe(lagos);
      expect(nextMidnight('Africa/Lagos', lagos)).toBe(lagos + DAY);
      // Los Angeles leaves daylight time on 2026-11-01: that day is 25 hours long.
      const start = nextMidnight('America/Los_Angeles', Date.UTC(2026, 10, 1, 6, 59, 59));
      expect(iso(start)).toBe('2026-11-01T07:00:00.000Z');
      expect(nextMidnight('America/Los_Angeles', start) - start).toBe(25 * HOUR);
      // The bucket rule the suite applies.
      expect(bucketOf(lagos - 1, lagos - 2, 'Africa/Lagos')).toBe('today');
      expect(bucketOf(lagos, lagos - 2, 'Africa/Lagos')).toBe('upcoming');
      expect(bucketOf(lagos - 3, lagos - 2, 'Africa/Lagos')).toBe('overdue');
      expect(bucketOf(null, lagos, 'Africa/Lagos')).toBe('upcoming');
    });

    it('(self-check) the page checker rejects a count, a body, an owner, a wrong type and an unlisted omission', () => {
      const good = {
        data: [
          {
            id: id82('a1'),
            programmeId: PROGRAMME_A1,
            type: 'task',
            subject: 'x',
            dueAt: iso(W),
            completedAt: null,
            startsAt: null,
            endsAt: null,
            contact: { id: AMAKA.id, displayName: AMAKA.displayName },
            account: null,
            version: 1,
            withheldFields: [],
          },
        ],
        nextCursor: null,
      };
      expect(myPageProblems(good, 'listMyActivities', 'good')).toEqual([]);
      const item = good.data[0] ?? {};
      const broken: unknown[] = [
        { ...good, total: 1 },
        { ...good, data: [{ ...item, body: 'x' }] },
        { ...good, data: [{ ...item, ownerUserId: USER_A_AGENT_1 }] },
        { ...good, data: [{ ...item, type: 'note' }] },
        { ...good, data: [{ ...item, completedAt: iso(W) }] },
        {
          ...good,
          data: [Object.fromEntries(Object.entries(item).filter(([k]) => k !== 'subject'))],
        },
        { ...good, data: [{ ...item, withheldFields: ['subject'] }] },
        {
          ...good,
          data: [Object.fromEntries(Object.entries(item).filter(([k]) => k !== 'dueAt'))],
        },
      ];
      for (const [index, page] of broken.entries()) {
        expect(
          myPageProblems(page, 'listMyActivities', `broken ${index}`),
          `broken ${index}`,
        ).not.toEqual([]);
      }
      expect(
        myOrderProblems([
          { id: 'b', dueAt: null },
          { id: 'a', dueAt: iso(W) },
        ]),
        'undated before dated',
      ).not.toEqual([]);
      expect(
        myOrderProblems([
          { id: 'b', dueAt: iso(W) },
          { id: 'a', dueAt: iso(W) },
        ]),
        'a tie out of id order',
      ).not.toEqual([]);
      expect(timeForms(W)).toContain(String(W));
      expect(cursorReadings(Buffer.from(`{"id":"${NOWHERE}"}`).toString('base64url'))).toEqual(
        expect.arrayContaining([expect.stringContaining(NOWHERE)]),
      );
    });
  });

  // =========================================================================
  // 1. The flags (F1).
  // =========================================================================

  describe('the contract records the slice as served (F1)', () => {
    it('listMyActivities, listCalendar and every property T-0081 marked pending are x-kasuwa-implemented: true', () => {
      const problems: string[] = [];
      for (const id of ['listMyActivities', 'listCalendar', 'createActivity', 'updateActivity']) {
        if (requireOperation(id).op['x-kasuwa-implemented'] !== true) {
          problems.push(`${id} is not x-kasuwa-implemented: true`);
        }
      }
      for (const [schema, key] of [
        ['Activity', 'startsAt'],
        ['Activity', 'endsAt'],
        ['ActivityItem', 'startsAt'],
        ['ActivityItem', 'endsAt'],
        ['CreateActivityRequest', 'startsAt'],
        ['CreateActivityRequest', 'endsAt'],
        ['UpdateActivityRequest', 'dueAt'],
        ['UpdateActivityRequest', 'startsAt'],
        ['UpdateActivityRequest', 'endsAt'],
      ] as const) {
        const raw = rawSchemaProperty(schema, key);
        if (raw === undefined) problems.push(`${schema}.${key} is missing`);
        else if (raw['x-kasuwa-implemented'] !== true) {
          problems.push(`${schema}.${key} is not x-kasuwa-implemented: true`);
        }
      }
      expect(problems).toEqual([]);
    });
  });

  // =========================================================================
  // 2. listMyActivities: buckets, whose, what (L1).
  // =========================================================================

  describe('listMyActivities: buckets in the caller’s zone (L1, D-L105)', () => {
    it('overdue, today and upcoming in Lagos, Johannesburg, Nairobi, Kolkata and Los Angeles, either side of every midnight; completed never listed', async () => {
      await expectListsServed();
      const t0 = Date.now();
      const open = new Map<string, number | null>();
      const completed: string[] = [];
      let tail = 0;
      const next = () => id82(`b${(tail += 1).toString(16).padStart(4, '0')}`);
      // Each zone's midnight (and UTC's, which a fallback would use), from both sides.
      for (const zone of [...ZONES, 'UTC']) {
        const midnight = nextMidnight(zone, t0);
        for (const at of [midnight - SECOND, midnight, midnight + SECOND]) {
          open.set(await plantTask(next(), at), at);
        }
      }
      for (const at of [
        t0 - 3 * DAY,
        t0 - 10 * MINUTE,
        t0 + 10 * MINUTE,
        t0 + 9 * DAY,
        null,
        null,
      ]) {
        open.set(await plantTask(next(), at), at);
      }
      for (const at of [t0 - 10 * MINUTE, t0 + 10 * MINUTE, t0 + 9 * DAY, null]) {
        completed.push(await plantTask(next(), at, { completedAt: t0 - HOUR }));
      }

      const boundaryChecked = new Map<string, number>();
      for (const zone of ZONES) {
        for (const bucket of BUCKETS) {
          const where = `${zone} ${bucket}`;
          const { items, before, after } = await readBucket(AGENT_1, zone, bucket, where);
          const served = new Set(items.map((item) => String(item.id)));
          for (const id of completed) {
            expect(served.has(id), `${where}: a completed task is listed`).toBe(false);
          }
          for (const id of served) {
            expect(open.has(id), `${where}: ${id} is not one of the caller's open tasks`).toBe(
              true,
            );
          }
          for (const [id, dueAt] of open) {
            const early = bucketOf(dueAt, before - SKEW, zone);
            const late = bucketOf(dueAt, after + SKEW, zone);
            if (early !== late) continue; // a midnight (or now) fell inside the request
            expect(
              served.has(id),
              `${where}: the task due ${dueAt === null ? 'never' : iso(dueAt)} belongs in ${early}`,
            ).toBe(early === bucket);
            if (dueAt !== null && Math.abs(dueAt - nextMidnight(zone, t0)) <= SECOND) {
              boundaryChecked.set(zone, (boundaryChecked.get(zone) ?? 0) + 1);
            }
          }
          for (const item of items) {
            const dueAt = open.get(String(item.id));
            expect(sameInstant(item.dueAt, dueAt ?? null), `${where}: dueAt is the row's`).toBe(
              true,
            );
          }
        }
      }
      // At most one zone's midnight can be within the skew of the run.
      const strict = ZONES.filter((zone) => (boundaryChecked.get(zone) ?? 0) === 9);
      expect(strict.length, 'zones whose midnight was judged on both sides').toBeGreaterThanOrEqual(
        ZONES.length - 1,
      );
    });

    it('upcoming lists the dated tasks first, then every undated task by id, across pages', async () => {
      await expectListsServed();
      const t0 = Date.now();
      const dated = [t0 + 30 * DAY, t0 + 20 * DAY, t0 + 20 * DAY, t0 + 40 * DAY];
      const datedIds: string[] = [];
      for (const [index, at] of dated.entries())
        datedIds.push(await plantTask(id82(`c1${index}`), at));
      const undated = [id82('c2f'), id82('c2a'), id82('c2c')];
      for (const id of undated) await plantTask(id, null);
      const walked = await walk(
        (params) => myActivities(AGENT_1, bucketParams('Africa/Nairobi', 'upcoming', params)),
        'listMyActivities',
        2,
      );
      const ids = walked.items.map((item) => String(item.id));
      expect(ids.slice(-3), 'undated last, by id').toEqual([...undated].sort());
      expect(ids.slice(0, 4).sort(), 'every dated task first').toEqual([...datedIds].sort());
    });

    it('lists only the caller’s own tasks: not another user’s, not unowned, never a note, a call or a meeting', async () => {
      await expectListsServed();
      const due = Date.now() + 15 * DAY;
      const mine = await plantTask(id82('d01'), due);
      await plantTask(id82('d02'), due, { ownerUserId: USER_A_SUPERVISOR });
      await plantTask(id82('d03'), due, { ownerUserId: null });
      await plantTask(id82('d04'), due, { ownerUserId: USER_A_AGENT_2, programmeId: PROGRAMME_A2 });
      await plant({ id: id82('d05'), type: 'call' });
      await plantMeeting(id82('d06'), due, due + HOUR);
      const ids = await allBuckets(AGENT_1);
      expect(ids, 'agent 1 sees exactly their own task').toEqual([mine]);
      expect(ids).not.toContain(SEEDED_A_NOTE.id);
      const supervisor = await allBuckets(SUPERVISOR);
      expect(supervisor, 'the supervisor sees their own, not the agents’ nor the unowned').toEqual([
        id82('d02'),
      ]);
      const agent2 = await allBuckets(AGENT_2);
      expect(agent2).toEqual([id82('d04')]);
    });

    it('programme and tenant: a task the caller owns in a programme they do not reach is not listed, and the tenant-admin flag lifts nothing', async () => {
      await expectListsServed();
      const due = Date.now() + 15 * DAY;
      // Agent 1 owns a task in A2, which they do not reach.
      await plantTask(id82('e01'), due, { programmeId: PROGRAMME_A2 });
      const reached = await plantTask(id82('e02'), due);
      expect(await allBuckets(AGENT_1)).toEqual([reached]);
      // The supervisor (tenant admin) owns tasks in both programmes, then leaves A2.
      const a1 = await plantTask(id82('e03'), due, { ownerUserId: USER_A_SUPERVISOR });
      const a2 = await plantTask(id82('e04'), due + 1, {
        ownerUserId: USER_A_SUPERVISOR,
        programmeId: PROGRAMME_A2,
      });
      expect(await allBuckets(SUPERVISOR)).toEqual([a1, a2]);
      await unassign(USER_A_SUPERVISOR, PROGRAMME_A2);
      expect(await allBuckets(SUPERVISOR), 'A2 is gone with the membership').toEqual([a1]);
      // A user in no programme owns one: still nothing, and still 200.
      await plantTask(id82('e05'), due, { ownerUserId: USER_A_NO_PROGRAMME });
      expect(await allBuckets(NO_PROGRAMME)).toEqual([]);
      // Tenant B: its user sees its own seeded task; tenant A never does.
      const b = await allBuckets(TENANT_B_ADMIN, 'Africa/Nairobi');
      expect(b, 'control: tenant B lists its own undated task').toContain(SEEDED_B_TASK.id);
      for (const headers of [AGENT_1, SUPERVISOR, AGENT_2]) {
        expect(await allBuckets(headers)).not.toContain(SEEDED_B_TASK.id);
      }
    });

    it('completing a task removes it from every bucket, and the list never reopens it', async () => {
      await expectListsServed();
      const id = await plantTask(id82('f01'), Date.now() - DAY);
      expect(await allBuckets(AGENT_1)).toEqual([id]);
      expectActivity(
        await updateActivity(AGENT_1, id, { version: await versionOf(id), completed: true }),
        'updateActivity',
        200,
        'complete',
      );
      expect(await allBuckets(AGENT_1)).toEqual([]);
      // Snoozing the completed task moves its time and nothing else.
      expectActivity(
        await updateActivity(AGENT_1, id, {
          version: await versionOf(id),
          dueAt: iso(Date.now() + DAY),
        }),
        'updateActivity',
        200,
        'snooze a completed task',
      );
      expect(await allBuckets(AGENT_1), 'still completed, still not listed').toEqual([]);
    });

    it('an item is the row, as MyActivity: version, programme, contact and account summaries, no body and no owner', async () => {
      await expectListsServed();
      const due = Date.now() + 5 * DAY;
      const onContact = await plantTask(id82('f11'), due, { subject: `Subject ${RUN}` });
      const onAccount = await plantTask(id82('f12'), due + 1, {
        contactId: null,
        accountId: IKOYI.id,
        subject: null,
      });
      await observer.query('UPDATE activity SET subject = subject WHERE id = $1', [onContact]);
      const { items } = await readBucket(AGENT_1, 'Africa/Lagos', 'upcoming', 'upcoming');
      expect(items.map((item) => item.id)).toEqual([onContact, onAccount]);
      const [first, second] = items;
      expect(first).toMatchObject({
        id: onContact,
        programmeId: PROGRAMME_A1,
        type: 'task',
        subject: `Subject ${RUN}`,
        completedAt: null,
        startsAt: null,
        endsAt: null,
        contact: { id: AMAKA.id, displayName: AMAKA.displayName },
        account: null,
        version: await versionOf(onContact),
        withheldFields: [],
      });
      expect(first?.version, 'the live version, after the row moved').toBe(2);
      expect(second).toMatchObject({
        id: onAccount,
        subject: null,
        contact: null,
        account: { id: IKOYI.id, name: IKOYI.name },
        version: 1,
      });
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual(
          [
            'account',
            'completedAt',
            'contact',
            'dueAt',
            'endsAt',
            'id',
            'programmeId',
            'startsAt',
            'subject',
            'type',
            'version',
            'withheldFields',
          ].sort(),
        );
      }
    });

    it('every reader may call it: qa_analyst, client_portal and a user with no programme get 200, never 403', async () => {
      await expectListsServed();
      const due = Date.now() + 5 * DAY;
      const id = await plantTask(id82('f21'), due);
      for (const key of ['qa_analyst', 'client_portal', 'team_lead', 'programme_manager']) {
        await assign(USER_A_AGENT_1, PROGRAMME_A1, key);
        const { items } = await readBucket(AGENT_1, 'Africa/Lagos', 'upcoming', key);
        expect(
          items.map((item) => item.id),
          `${key} lists their own task`,
        ).toEqual([id]);
      }
      const none = await myActivities(NO_PROGRAMME, bucketParams('Africa/Lagos', 'overdue'));
      expectStatus(none, 200, 'no programme');
      expect(pageOf(none.body).data).toEqual([]);
    });
  });

  // =========================================================================
  // 3. Validation: timeZone, bucket, limit, scope (L1).
  // =========================================================================

  describe('listMyActivities: validation, never a fallback', () => {
    it('a timeZone that is not an IANA zone name is 400 invalid_time_zone at timeZone, never UTC or the tenant’s zone', async () => {
      await expectListsServed();
      await plantTask(id82('a001'), Date.now() - DAY);
      const bad = [
        'WAT',
        'EAT',
        '+01:00',
        'UTC+1',
        'GMT+01:00',
        '../etc/passwd',
        'Africa/../../etc/passwd',
        'Africa/Lagoss',
        'Mars/Olympus_Mons',
        'Africa/Lagos ',
        ' Africa/Lagos',
        'Africa Lagos',
        'Africa/Lagos\u0000',
        'Africa/Lagos/Ikeja/Extra/Deep',
        `Africa/${'L'.repeat(70)}`,
        '',
      ];
      const bodies = new Set<string>();
      for (const zone of bad) {
        for (const bucket of BUCKETS) {
          const response = await myActivities(AGENT_1, bucketParams(zone, bucket));
          const where = `timeZone ${JSON.stringify(zone)} ${bucket}`;
          expectDetail(response, 'timeZone', 'invalid_time_zone', where);
          expectNoStore(response, where);
          expect(JSON.stringify(response.body), `${where}: no data`).not.toContain('"data"');
          bodies.add(response.text);
        }
      }
      expect(bodies.size, 'one body for every invalid zone').toBe(1);
      for (const zone of bad) {
        expect([...bodies][0], 'the body never echoes the value').not.toContain(
          zone === '' ? '\u0001' : JSON.stringify(zone),
        );
      }
    });

    it('a missing or repeated timeZone, and a missing, unknown or repeated bucket, are 400', async () => {
      await expectListsServed();
      const cases: [string, string][] = [
        ['bucket=today', 'missing timeZone'],
        ['timeZone=Africa%2FLagos&timeZone=Africa%2FNairobi&bucket=today', 'timeZone twice'],
        ['timeZone=Africa%2FLagos', 'missing bucket'],
        ['timeZone=Africa%2FLagos&bucket=Today', 'Today'],
        ['timeZone=Africa%2FLagos&bucket=all', 'all'],
        ['timeZone=Africa%2FLagos&bucket=completed', 'completed'],
        ['timeZone=Africa%2FLagos&bucket=today%2Cupcoming', 'two buckets'],
        ['timeZone=Africa%2FLagos&bucket=today&bucket=overdue', 'bucket twice'],
        ['timeZone=Africa%2FLagos&bucket=', 'empty bucket'],
      ];
      for (const [query, where] of cases) {
        const response = await myActivitiesRaw(AGENT_1, query);
        expectError(response, 400, 'validation_failed');
        expectNoStore(response, where);
      }
      const missing = await myActivitiesRaw(AGENT_1, 'bucket=today');
      expect(
        detailsOf(missing.body as Json).map((detail) => detail.path),
        'a missing timeZone is reported at timeZone',
      ).toContain('timeZone');
    });

    it('limit 1..100, default 25; out of range or not an integer is 400, never clamped', async () => {
      await expectListsServed();
      for (let index = 0; index < 27; index += 1) {
        await plantTask(
          id82(`a01${index.toString(16).padStart(2, '0')}`),
          Date.now() + 10 * DAY + index,
        );
      }
      const byDefault = await myActivities(AGENT_1, bucketParams('Africa/Lagos', 'upcoming'));
      expectStatus(byDefault, 200, 'default');
      expect(pageOf(byDefault.body).data, 'the default page is 25').toHaveLength(25);
      for (const limit of ['1', '100']) {
        const response = await myActivities(
          AGENT_1,
          bucketParams('Africa/Lagos', 'upcoming', [['limit', limit]]),
        );
        expectStatus(response, 200, `limit ${limit}`);
        expect(pageOf(response.body).data).toHaveLength(Math.min(Number(limit), 27));
      }
      for (const limit of ['0', '101', '-1', '1000', '1.5', 'ten', '']) {
        const response = await myActivities(
          AGENT_1,
          bucketParams('Africa/Lagos', 'upcoming', [['limit', limit]]),
        );
        expectError(response, 400, 'validation_failed');
        expectNoStore(response, `limit ${limit}`);
      }
      for (const limit of ['0', '101']) {
        const response = await calendar(AGENT_1, windowParams(W, W + DAY, [['limit', limit]]));
        expectError(response, 400, 'validation_failed');
      }
    });

    it('scope comes from the session: a scope header is 400, a scope or owner query parameter never widens, no session is 401', async () => {
      await expectListsServed();
      const due = Date.now() + 5 * DAY;
      const mine = await plantTask(id82('a021'), due);
      await plantTask(id82('a022'), due, {
        ownerUserId: USER_A_AGENT_2,
        programmeId: PROGRAMME_A2,
      });
      await plantTask(id82('a023'), due, { ownerUserId: USER_A_SUPERVISOR });
      for (const [header, value] of [
        ['x-kasuwa-programme-ids', `{${PROGRAMME_A2}}`],
        ['x-kasuwa-programme-id', PROGRAMME_A2],
        ['x-kasuwa-scope', 'all'],
      ] as const) {
        const bodies = [
          await myActivities(AGENT_1, bucketParams('Africa/Lagos', 'upcoming')).set(header, value),
          await calendar(AGENT_1, windowParams(W, W + DAY)).set(header, value),
        ].map((response) => {
          expectError(response, 400, 'validation_failed');
          expectNoStore(response, header);
          return response.text;
        });
        expect(bodies.join(), `${header}: nothing listed`).not.toContain(mine);
      }
      for (const extra of [
        [['ownerUserId', USER_A_AGENT_2]],
        [['userId', USER_A_SUPERVISOR]],
        [['owner', 'all']],
        [['programmeId', PROGRAMME_A2]],
        [['programmeIds', PROGRAMME_A2]],
        [['tenantId', TENANT_B]],
        [['includeCompleted', 'true']],
      ] as const) {
        const response = await myActivities(
          AGENT_1,
          bucketParams('Africa/Lagos', 'upcoming', extra),
        );
        const where = `?${extra[0][0]}`;
        expect([200, 400], `${where}: 200 ignoring it, or 400`).toContain(response.status);
        if (response.status === 200) {
          expect(
            pageOf(response.body).data.map((item) => item.id),
            `${where} widened the list`,
          ).toEqual([mine]);
        }
      }
      const unauthenticated = [
        await myActivities({}, bucketParams('Africa/Lagos', 'today')),
        await myActivities({}, [
          ['timeZone', 'WAT'],
          ['bucket', 'never'],
        ]),
        await calendar({}, windowParams(W, W + DAY)),
      ].map((response) => {
        expectError(response, 401, 'not_authenticated');
        expectNoStore(response, '401');
        return response.text;
      });
      expect(new Set(unauthenticated).size, '401 says nothing about the query').toBe(1);
    });
  });

  // =========================================================================
  // 4. Field security before paging (L3).
  // =========================================================================

  describe('field security: a withheld time drops the row before the page is cut (L3)', () => {
    it('a withheld dueAt drops the task from every bucket and the calendar, judged in the task’s own programme, before paging', async () => {
      await expectListsServed();
      // Agent 1 holds `agent` in A1 and `team_lead` in A2; dueAt is withheld from `agent` only.
      await assign(USER_A_AGENT_1, PROGRAMME_A2, 'team_lead');
      const hidden: string[] = [];
      const shown: string[] = [];
      const calendarIds = new Set<string>();
      const base = Date.now() + 3 * DAY;
      for (let index = 0; index < 18; index += 1) {
        const inA1 = index % 3 !== 1;
        const programmeId = inA1 ? PROGRAMME_A1 : PROGRAMME_A2;
        const hex = index.toString(16).padStart(3, '0');
        // Soon (upcoming only) and in 2031 (upcoming and the calendar window).
        const soon = await plantTask(id82(`a1${hex}`), base + index * MINUTE, { programmeId });
        const later = await plantTask(id82(`a18${hex}`), W + index * HOUR, { programmeId });
        calendarIds.add(later);
        (inA1 ? hidden : shown).push(soon, later);
      }
      expect(
        (await allBuckets(AGENT_1)).length,
        'control: before the lock every task is listed',
      ).toBe(36);
      await lockField('due_at', 'agent', 'none');
      const everything: string[] = [];
      for (const limit of [1, 2, 4, 5, null]) {
        const mine = await walk(
          (params) => myActivities(AGENT_1, bucketParams('Africa/Lagos', 'upcoming', params)),
          'listMyActivities',
          limit,
        );
        const events = await walk(
          (params) => calendar(AGENT_1, windowParams(W, W + 2 * DAY, params)),
          'listCalendar',
          limit,
        );
        const listed = mine.items.map((item) => String(item.id));
        const onCalendar = events.items.map((item) => String(item.id));
        expect([...listed].sort(), `limit ${String(limit)}: exactly A2's tasks`).toEqual(
          [...shown].sort(),
        );
        expect([...onCalendar].sort(), `limit ${String(limit)}: exactly A2's calendar`).toEqual(
          shown.filter((id) => calendarIds.has(id)).sort(),
        );
        const ids = [...listed, ...onCalendar];
        const leaked = [...mine.bodies, ...events.bodies].join('\n').toLowerCase();
        const readings = [...mine.cursors, ...events.cursors].flatMap(cursorReadings);
        for (const id of hidden) {
          for (const form of idForms(id)) {
            expect(leaked, `limit ${String(limit)}: a dropped id is in a body`).not.toContain(form);
            for (const reading of readings) {
              expect(reading, 'a dropped id is in a cursor').not.toContain(form);
            }
          }
        }
        everything.push(...ids);
      }
      expect(everything.length, 'control: the walks returned rows').toBeGreaterThan(0);
      // The supervisor holds `admin` in A1: nothing is dropped for them.
      const handed = hidden[0] ?? '';
      await observer.query('UPDATE activity SET owner_user_id = $1 WHERE id = $2', [
        USER_A_SUPERVISOR,
        handed,
      ]);
      expect(await allBuckets(SUPERVISOR), 'the admin set in A1 sees the dueAt').toEqual([handed]);
    });

    it('a withheld startsAt or endsAt drops the meeting from the calendar, and its id never appears', async () => {
      await expectListsServed();
      const shownTask = await plantTask(id82('a201'), W + HOUR);
      const meeting = await plantMeeting(id82('a202'), W + 2 * HOUR, W + 3 * HOUR);
      const control = await readCalendar(AGENT_1, W, W + DAY, 'control');
      expect(control.map((item) => item.id)).toEqual([shownTask, meeting]);
      for (const field of ['starts_at', 'ends_at']) {
        await lockField('starts_at', 'agent', 'edit');
        await lockField('ends_at', 'agent', 'edit');
        await lockField(field, 'agent', 'none');
        for (const limit of [1, 2, null]) {
          const walked = await walk(
            (params) => calendar(AGENT_1, windowParams(W, W + DAY, params)),
            'listCalendar',
            limit,
          );
          expect(
            walked.items.map((item) => item.id),
            `${field} withheld`,
          ).toEqual([shownTask]);
          const text = [...walked.bodies, ...walked.cursors.flatMap(cursorReadings)].join('\n');
          for (const form of idForms(meeting)) expect(text.toLowerCase()).not.toContain(form);
        }
      }
    });

    it('other withheld fields are omitted and named: subject, completedAt, contact with contact_id, account with account_id', async () => {
      await expectListsServed();
      const task = await plantTask(id82('a211'), Date.now() + 2 * DAY, {
        accountId: IKOYI.id,
        contactId: AMAKA.id,
      });
      const done = await plantTask(id82('a212'), W + HOUR, { completedAt: W - DAY });
      const meeting = await plantMeeting(id82('a213'), W + 2 * HOUR, W + 3 * HOUR);
      await lockField('subject', 'agent', 'none');
      await lockField('contact_id', 'agent', 'none');
      await lockField('account_id', 'agent', 'none');
      await lockField('completed_at', 'agent', 'none');
      const { items } = await readBucket(AGENT_1, 'Africa/Lagos', 'upcoming', 'upcoming');
      expect(items.map((item) => item.id)).toEqual([task]);
      const [item] = items;
      expect(item && 'subject' in item).toBe(false);
      expect(item && 'contact' in item).toBe(false);
      expect(item && 'account' in item).toBe(false);
      expect(item && 'completedAt' in item).toBe(false);
      expect([...((item?.withheldFields ?? []) as string[])].sort()).toEqual(
        ['account', 'completedAt', 'contact', 'subject'].sort(),
      );
      const events = await readCalendar(AGENT_1, W, W + DAY, 'calendar');
      expect(
        events.map((event) => event.id),
        'withheld completedAt does not drop a row',
      ).toEqual([done, meeting]);
      for (const event of events) {
        expect(JSON.stringify(event)).not.toContain(AMAKA.displayName);
        expect(event.withheldFields).toEqual(
          expect.arrayContaining(['subject', 'contact', 'account', 'completedAt']),
        );
      }
    });
  });

  // =========================================================================
  // 5. Paging and cursors (L4).
  // =========================================================================

  describe('paging: keyset, id-only cursors, no counts (L4, D-L80, D-P13)', () => {
    it('every limit walks the same tasks in the same order as one read, ties broken by id, with no repeats or gaps', async () => {
      await expectListsServed();
      const base = Date.now() + 4 * DAY;
      const ids: string[] = [];
      for (let index = 0; index < 23; index += 1) {
        // Groups of three share one due time, so every page boundary can split a tie.
        const id = id82(`a3${((index * 7) % 23).toString(16).padStart(3, '0')}`);
        ids.push(await plantTask(id, base + Math.floor(index / 3) * MINUTE));
      }
      for (const id of [id82('a37f0'), id82('a37f1')]) ids.push(await plantTask(id, null));
      const one = await readBucket(AGENT_1, 'Asia/Kolkata', 'upcoming', 'one read');
      expect(one.items.map((item) => item.id).sort()).toEqual([...ids].sort());
      for (const limit of [1, 2, 3, 7, 24, 25]) {
        const walked = await walk(
          (params) => myActivities(AGENT_1, bucketParams('Asia/Kolkata', 'upcoming', params)),
          'listMyActivities',
          limit,
        );
        expect(
          walked.items.map((item) => item.id),
          `limit ${limit}`,
        ).toEqual(one.items.map((item) => item.id));
      }
    });

    it('keyset, not offset: a task added before the cursor position never shifts or repeats the next page', async () => {
      await expectListsServed();
      const base = Date.now() + 4 * DAY;
      for (let index = 0; index < 6; index += 1) {
        await plantTask(id82(`a38${index}`), base + index * HOUR);
      }
      const first = await myActivities(
        AGENT_1,
        bucketParams('Africa/Lagos', 'upcoming', [['limit', '3']]),
      );
      expectStatus(first, 200, 'page 1');
      const cursor = pageOf(first.body).nextCursor;
      expect(cursor, 'a second page exists').toEqual(expect.any(String));
      await plantTask(id82('a38f'), base - HOUR);
      const second = await myActivities(
        AGENT_1,
        bucketParams('Africa/Lagos', 'upcoming', [
          ['limit', '3'],
          ['cursor', cursor ?? ''],
        ]),
      );
      expectStatus(second, 200, 'page 2');
      expect(pageOf(second.body).data.map((item) => item.id)).toEqual([
        id82('a383'),
        id82('a384'),
        id82('a385'),
      ]);
    });

    it('a cursor carries an id only: no subject, contact name, account name or time, and no id the pages had not shown', async () => {
      await expectListsServed();
      const base = Date.now() + 6 * DAY + 123;
      const subjects: string[] = [];
      const dues: number[] = [];
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const subject = `Cursor probe ${RUN} ${index}`;
        const at = base + index * 7 * MINUTE + index;
        subjects.push(subject);
        dues.push(at);
        ids.push(
          await plantTask(id82(`a40${index}`), at, {
            subject,
            accountId: IKOYI.id,
            contactId: AMAKA.id,
          }),
        );
      }
      const meetingStart = W + 17 * MINUTE + 7;
      await plantMeeting(id82('a410'), meetingStart, meetingStart + HOUR, {
        subject: `Meeting ${RUN}`,
      });
      await plantTask(id82('a411'), W + 3 * HOUR + 9, { subject: `Calendar task ${RUN}` });
      const mine = await walk(
        (params) => myActivities(AGENT_1, bucketParams('Africa/Lagos', 'upcoming', params)),
        'listMyActivities',
        1,
      );
      const events = await walk(
        (params) => calendar(AGENT_1, windowParams(W, W + DAY, params)),
        'listCalendar',
        1,
      );
      // Upcoming holds the five soon tasks and the 2031 task; the window holds the meeting and that task.
      expect([mine.cursors.length, events.cursors.length], 'control: cursors were issued').toEqual([
        5, 1,
      ]);
      const forbidden = [
        ...subjects,
        `Meeting ${RUN}`,
        `Calendar task ${RUN}`,
        AMAKA.displayName,
        AMAKA.givenNames,
        IKOYI.name,
        ...dues.flatMap(timeForms),
        ...timeForms(meetingStart),
        ...timeForms(W + 3 * HOUR + 9),
      ].map((text) => text.toLowerCase());
      for (const [walked, served] of [
        [mine, [...ids, id82('a411')]],
        [events, [id82('a410'), id82('a411')]],
      ] as const) {
        walked.cursors.forEach((cursor, index) => {
          const readings = cursorReadings(cursor);
          for (const text of forbidden) {
            for (const reading of readings) {
              expect(reading, `cursor ${index} carries "${text}"`).not.toContain(text);
            }
          }
          for (const notYet of served.slice(index + 1)) {
            for (const form of idForms(notYet)) {
              for (const reading of readings) {
                expect(reading, `cursor ${index} names a row not yet served`).not.toContain(form);
              }
            }
          }
          for (const owner of [USER_A_AGENT_1, AMAKA.id, IKOYI.id, PROGRAMME_A1, TENANT_A]) {
            for (const form of idForms(owner)) {
              for (const reading of readings) expect(reading).not.toContain(form);
            }
          }
        });
      }
    });

    it('invalid_cursor is one body whatever the reason: malformed, nowhere, someone else’s, another tenant’s, a note, withheld, unreachable', async () => {
      await expectListsServed();
      const base = Date.now() + 8 * DAY;
      const own: string[] = [];
      for (let index = 0; index < 8; index += 1)
        own.push(await plantTask(id82(`a50${index}`), base + index * HOUR));
      await plantTask(id82('a520'), base, {
        ownerUserId: USER_A_AGENT_2,
        programmeId: PROGRAMME_A2,
      });
      await plantTask(id82('a521'), base + HOUR, {
        ownerUserId: USER_A_AGENT_2,
        programmeId: PROGRAMME_A2,
      });
      await plantTask(id82('a530'), base, {
        programmeId: PROGRAMME_B1,
        ownerUserId: USER_B_AGENT_1,
      });
      const params = (cursor: string): Params =>
        bucketParams('Africa/Lagos', 'upcoming', [
          ['limit', '1'],
          ['cursor', cursor],
        ]);
      const mine = await walk(
        (extra) => myActivities(AGENT_1, bucketParams('Africa/Lagos', 'upcoming', extra)),
        'listMyActivities',
        1,
      );
      // cursors[i] names own[i], the last row of page i + 1.
      expect(mine.cursors).toHaveLength(7);
      const cursorOf = (index: number) => mine.cursors[index] ?? '';
      const theirs = await myActivities(
        AGENT_2,
        bucketParams('Africa/Lagos', 'upcoming', [['limit', '1']]),
      );
      const otherTenant = await myActivities(
        TENANT_B_ADMIN,
        bucketParams('Africa/Nairobi', 'upcoming', [['limit', '1']]),
      );
      const theirCursor = pageOf(theirs.body).nextCursor ?? '';
      const otherTenantCursor = pageOf(otherTenant.body).nextCursor ?? '';
      expect([theirCursor, otherTenantCursor], 'control: both cursors exist').toEqual([
        expect.any(String),
        expect.any(String),
      ]);
      // Still resolves: completed or snoozed since the page was cut.
      await observer.query('UPDATE activity SET completed_at = now() WHERE id = $1', [own[4]]);
      expectStatus(
        await myActivities(AGENT_1, params(cursorOf(4))),
        200,
        'a completed row resolves',
      );
      await observer.query(
        "UPDATE activity SET due_at = due_at + interval '30 days' WHERE id = $1",
        [own[5]],
      );
      const moved = await myActivities(AGENT_1, params(cursorOf(5)));
      expectStatus(moved, 200, 'a snoozed row resolves, at its new position');
      expect(pageOf(moved.body).data.map((item) => item.id)).toEqual([]);
      // Invalid, each for a different reason.
      await observer.query('UPDATE activity SET owner_user_id = $1 WHERE id = $2', [
        USER_A_SUPERVISOR,
        own[0],
      ]);
      await observer.query('DELETE FROM activity WHERE id = $1', [own[1]]);
      await observer.query(
        "UPDATE activity SET type = 'note', due_at = NULL, completed_at = NULL WHERE id = $1",
        [own[2]],
      );
      const reasons: [string, request.Response][] = [
        ['garbage', await myActivities(AGENT_1, params('not-a-cursor'))],
        ['punctuation', await myActivities(AGENT_1, params('!!!!'))],
        ['NUL', await myActivities(AGENT_1, params('abc\u0000'))],
        [
          'base64 json',
          await myActivities(AGENT_1, params(Buffer.from('{"id":1}').toString('base64url'))),
        ],
        ['a raw uuid, nowhere', await myActivities(AGENT_1, params(NOWHERE))],
        ['a raw uuid of another user’s task', await myActivities(AGENT_1, params(id82('a520')))],
        ['too long', await myActivities(AGENT_1, params('A'.repeat(513)))],
        ['someone else’s cursor', await myActivities(AGENT_1, params(theirCursor))],
        ['another tenant’s cursor', await myActivities(AGENT_1, params(otherTenantCursor))],
        ['reassigned away', await myActivities(AGENT_1, params(cursorOf(0)))],
        ['deleted', await myActivities(AGENT_1, params(cursorOf(1)))],
        ['now a note', await myActivities(AGENT_1, params(cursorOf(2)))],
      ];
      await lockField('due_at', 'agent', 'none');
      reasons.push(['a withheld dueAt', await myActivities(AGENT_1, params(cursorOf(3)))]);
      await lockField('due_at', 'agent', 'edit');
      await unassign(USER_A_AGENT_1, PROGRAMME_A1);
      reasons.push([
        'a programme no longer reached',
        await myActivities(AGENT_1, params(cursorOf(6))),
      ]);
      const texts = reasons.map(([why, response]) => {
        expectDetail(response, 'cursor', 'invalid_cursor', why);
        expectNoStore(response, why);
        return response.text;
      });
      for (const [index, text] of texts.entries()) {
        expect(text, `${reasons[index]?.[0]}: one body whatever the reason`).toBe(texts[0]);
      }
    });

    it('the calendar’s invalid_cursor is the same one body: someone else’s, a note, a withheld start', async () => {
      await expectListsServed();
      for (let index = 0; index < 4; index += 1) {
        await plantMeeting(id82(`a54${index}`), W + index * HOUR, W + index * HOUR + 30 * MINUTE);
      }
      await plantTask(id82('a550'), W + HOUR, {
        ownerUserId: USER_A_AGENT_2,
        programmeId: PROGRAMME_A2,
      });
      await plantTask(id82('a551'), W + 2 * HOUR, {
        ownerUserId: USER_A_AGENT_2,
        programmeId: PROGRAMME_A2,
      });
      const walked = await walk(
        (params) => calendar(AGENT_1, windowParams(W, W + DAY, params)),
        'listCalendar',
        1,
      );
      expect(walked.cursors).toHaveLength(3);
      const theirs = await calendar(AGENT_2, windowParams(W, W + DAY, [['limit', '1']]));
      const theirCursor = pageOf(theirs.body).nextCursor ?? '';
      expect(theirCursor).toEqual(expect.any(String));
      const params = (cursor: string) =>
        windowParams(W, W + DAY, [
          ['limit', '1'],
          ['cursor', cursor],
        ]);
      const reasons: [string, request.Response][] = [
        ['garbage', await calendar(AGENT_1, params('not-a-cursor'))],
        ['nowhere', await calendar(AGENT_1, params(NOWHERE))],
        ['someone else’s', await calendar(AGENT_1, params(theirCursor))],
      ];
      await observer.query(
        "UPDATE activity SET type = 'note', starts_at = NULL, ends_at = NULL WHERE id = $1",
        [id82('a540')],
      );
      reasons.push(['now a note', await calendar(AGENT_1, params(walked.cursors[0] ?? ''))]);
      await lockField('starts_at', 'agent', 'none');
      reasons.push([
        'a withheld startsAt',
        await calendar(AGENT_1, params(walked.cursors[1] ?? '')),
      ]);
      const listBody = (
        await myActivities(
          AGENT_1,
          bucketParams('Africa/Lagos', 'today', [['cursor', 'not-a-cursor']]),
        )
      ).text;
      for (const [why, response] of reasons) {
        expectDetail(response, 'cursor', 'invalid_cursor', why);
        expect(response.text, `${why}: one body`).toBe(listBody);
      }
    });
  });

  // =========================================================================
  // 6. The calendar (L2).
  // =========================================================================

  describe('listCalendar: [from, to) for tasks, overlap for meetings (L2, D-P22)', () => {
    it('tasks with from <= dueAt < to, meetings with startsAt < to and endsAt > from, open and completed, in start order', async () => {
      await expectListsServed();
      const from = W;
      const to = W + 7 * DAY;
      const included = new Map<string, string>([
        [await plantTask(id82('a601'), from), 'a task due exactly at from'],
        [await plantTask(id82('a602'), to - 1), 'a task due 1 ms before to'],
        [
          await plantTask(id82('a603'), from + DAY, { completedAt: from - DAY }),
          'a completed task',
        ],
        [await plantMeeting(id82('a604'), from - HOUR, from + HOUR), 'a meeting begun before from'],
        [
          await plantMeeting(id82('a605'), from - 2 * HOUR, from + 1),
          'a meeting ending 1 ms after from',
        ],
        [await plantMeeting(id82('a606'), to - 1, to + HOUR), 'a meeting starting 1 ms before to'],
        [
          await plantMeeting(id82('a607'), from + 2 * DAY, from + 2 * DAY + HOUR),
          'a meeting inside',
        ],
      ]);
      const excluded = new Map<string, string>([
        [await plantTask(id82('a611'), from - 1), 'a task due 1 ms before from'],
        [await plantTask(id82('a612'), to), 'a task due exactly at to'],
        [await plantTask(id82('a613'), null), 'an undated task'],
        [
          await plantMeeting(id82('a614'), from - 2 * HOUR, from),
          'a meeting ending exactly at from',
        ],
        [await plantMeeting(id82('a615'), to, to + HOUR), 'a meeting starting exactly at to'],
        [await plant({ id: id82('a616'), type: 'note', createdAt: from + HOUR }), 'a note'],
        [await plant({ id: id82('a617'), type: 'call', createdAt: from + HOUR }), 'a call'],
        [
          await plantTask(id82('a618'), from + HOUR, { ownerUserId: USER_A_SUPERVISOR }),
          'another user’s task',
        ],
        [
          await plantMeeting(id82('a619'), from + HOUR, from + 2 * HOUR, {
            ownerUserId: USER_A_SUPERVISOR,
          }),
          'another user’s meeting',
        ],
        [await plantTask(id82('a61a'), from + HOUR, { ownerUserId: null }), 'an unowned task'],
        [
          await plantMeeting(id82('a61b'), from + HOUR, from + 2 * HOUR, { ownerUserId: null }),
          'an unowned meeting',
        ],
        [
          await plantTask(id82('a61c'), from + HOUR, { programmeId: PROGRAMME_A2 }),
          'own, in an unreached programme',
        ],
        [
          await plantMeeting(id82('a61d'), from + HOUR, from + 2 * HOUR, {
            programmeId: PROGRAMME_A2,
          }),
          'own meeting, unreached programme',
        ],
        [
          await plantTask(id82('a61e'), from + HOUR, {
            programmeId: PROGRAMME_B1,
            ownerUserId: USER_B_AGENT_1,
          }),
          'tenant B',
        ],
      ]);
      const items = await readCalendar(AGENT_1, from, to, 'the week');
      const ids = items.map((item) => String(item.id));
      for (const [id, what] of included) expect(ids, `${what} is listed`).toContain(id);
      for (const [id, what] of excluded) expect(ids, `${what} is not listed`).not.toContain(id);
      expect(ids, 'by start; the two at to - 1 ms by id').toEqual([
        id82('a605'),
        id82('a604'),
        id82('a601'),
        id82('a603'),
        id82('a607'),
        id82('a602'),
        id82('a606'),
      ]);
      const byId = new Map(items.map((item) => [String(item.id), item]));
      expect(sameInstant(byId.get(id82('a603'))?.completedAt, from - DAY), 'completedAt').toBe(
        true,
      );
      expect(byId.get(id82('a601'))?.completedAt, 'an open task').toBeNull();
      expect(byId.get(id82('a604'))).toMatchObject({
        type: 'meeting',
        dueAt: null,
        completedAt: null,
      });
      expect(sameInstant(byId.get(id82('a604'))?.startsAt, from - HOUR)).toBe(true);
      expect(sameInstant(byId.get(id82('a604'))?.endsAt, from + HOUR)).toBe(true);
      // Tenant B's own calendar has its task: the exclusion above is scope, not a broken route.
      const b = await calendar(TENANT_B_ADMIN, windowParams(from, to));
      expectStatus(b, 200, 'tenant B');
      expect(pageOf(b.body).data.map((item) => item.id)).toEqual([id82('a61e')]);
    });

    it('to must be after from (invalid_window) and at most 42 days after it (window_too_long), never clamped', async () => {
      await expectListsServed();
      const late = await plantTask(id82('a701'), W + 42 * DAY - 1);
      const after = await plantTask(id82('a702'), W + 42 * DAY);
      const full = await readCalendar(AGENT_1, W, W + 42 * DAY, 'exactly 42 days');
      expect(full.map((item) => item.id)).toEqual([late]);
      expect(full.map((item) => item.id)).not.toContain(after);
      for (const [to, where] of [
        [W, 'to equal to from'],
        [W - 1, 'to before from'],
        [W - 30 * DAY, 'to long before from'],
      ] as const) {
        const response = await calendar(AGENT_1, windowParams(W, to));
        expectDetail(response, 'to', 'invalid_window', where);
        expectNoStore(response, where);
      }
      for (const [to, where] of [
        [W + 42 * DAY + 1, '42 days and 1 ms'],
        [W + 43 * DAY, '43 days'],
        [W + 366 * DAY, 'a year'],
      ] as const) {
        const response = await calendar(AGENT_1, windowParams(W, to));
        expectDetail(response, 'to', 'window_too_long', where);
        expect(JSON.stringify(response.body), `${where}: never a clamped page`).not.toContain(late);
      }
    });

    it('from and to are required UTC date-times with a Z; an offset, a date alone, year 0 or an impossible date is 400, never 500', async () => {
      await expectListsServed();
      const good = iso(W);
      const bad = [
        '2031-03-03',
        '2031-03-03T00:00:00+01:00',
        '2031-03-03T00:00:00',
        '2031-03-03 00:00:00Z',
        '0000-01-01T00:00:00.000Z',
        '2031-02-30T00:00:00.000Z',
        '2031-13-01T00:00:00.000Z',
        '2031-03-03T25:00:00.000Z',
        'now',
        '1772496000000',
        '',
      ];
      for (const value of bad) {
        for (const [from, to, path] of [
          [value, iso(W + DAY), 'from'],
          [good, value, 'to'],
        ] as const) {
          const response = await calendar(AGENT_1, [
            ['from', from],
            ['to', to],
          ]);
          const where = `${path} ${JSON.stringify(value)}`;
          expectError(response, 400, 'validation_failed');
          expectNoStore(response, where);
          expect(
            detailsOf(response.body as Json).map((detail) => detail.path),
            where,
          ).toContain(path);
        }
      }
      for (const query of [[['to', iso(W + DAY)]], [['from', good]], []] as const) {
        expectError(await calendar(AGENT_1, query), 400, 'validation_failed');
      }
    });

    it('the calendar pages by keyset across tasks and meetings, every limit the same order as one read', async () => {
      await expectListsServed();
      for (let index = 0; index < 14; index += 1) {
        const at = W + Math.floor(index / 2) * HOUR;
        const id = id82(`a8${((index * 5) % 14).toString(16).padStart(3, '0')}`);
        if (index % 2 === 0) await plantTask(id, at);
        else await plantMeeting(id, at, at + 90 * MINUTE);
      }
      const one = await readCalendar(AGENT_1, W, W + DAY, 'one read');
      expect(one).toHaveLength(14);
      for (const limit of [1, 2, 3, 5, 13]) {
        const walked = await walk(
          (params) => calendar(AGENT_1, windowParams(W, W + DAY, params)),
          'listCalendar',
          limit,
        );
        expect(
          walked.items.map((item) => item.id),
          `limit ${limit}`,
        ).toEqual(one.map((item) => item.id));
      }
    });
  });

  // =========================================================================
  // 7. Meetings on create (W1).
  // =========================================================================

  describe('meetings: create (W1, D-L87)', () => {
    const meetingBody = (extra: Json = {}): Json => ({
      type: 'meeting',
      subject: `T0082 meeting ${RUN}`,
      startsAt: iso(W + 9 * HOUR),
      endsAt: iso(W + 10 * HOUR),
      ownerUserId: USER_A_AGENT_1,
      contactId: AMAKA.id,
      ...extra,
    });

    it('a meeting is created with its times, on the caller’s calendar, audited by field name only', async () => {
      const before = await auditIds();
      const created = expectActivity(
        await createActivity(AGENT_1, meetingBody()),
        'createActivity',
        201,
        'create a meeting',
      );
      expect(created).toMatchObject({
        type: 'meeting',
        dueAt: null,
        completedAt: null,
        ownerUserId: USER_A_AGENT_1,
        programmeId: PROGRAMME_A1,
      });
      expect(sameInstant(created.startsAt, W + 9 * HOUR)).toBe(true);
      expect(sameInstant(created.endsAt, W + 10 * HOUR)).toBe(true);
      const row = await activityRow(String(created.id));
      expect(msOf(row?.starts_at)).toBe(W + 9 * HOUR);
      expect(msOf(row?.ends_at)).toBe(W + 10 * HOUR);
      const events = await auditSince(before);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'created',
        object_type: 'activity',
        object_id: created.id,
      });
      const changes = events[0]?.changes ?? [];
      for (const field of ['startsAt', 'endsAt']) {
        expect(changes, `the create names ${field}`).toContainEqual(named(field));
      }
      const raw = JSON.stringify(changes);
      for (const form of [...timeForms(W + 9 * HOUR), ...timeForms(W + 10 * HOUR)]) {
        expect(raw.toLowerCase(), 'no time value in the audit row').not.toContain(form);
      }
      const listed = await readCalendar(AGENT_1, W, W + DAY, 'calendar');
      expect(listed.map((item) => item.id)).toEqual([created.id]);
      // A task and a note carry null times on the Activity.
      const task = expectActivity(
        await createActivity(AGENT_1, { type: 'task', contactId: AMAKA.id, dueAt: iso(W) }),
        'createActivity',
        201,
        'a task',
      );
      expect(task).toMatchObject({ startsAt: null, endsAt: null });
    });

    it('the times are required, end after start, at most 24 hours; exactly 24 hours is accepted', async () => {
      expectActivity(
        await createActivity(AGENT_1, meetingBody()),
        'createActivity',
        201,
        'control',
      );
      const count = await activityCount();
      const start = W + 9 * HOUR;
      const cases: [Json, string, string, string][] = [
        [meetingBody({ startsAt: undefined }), 'startsAt', 'required', 'no startsAt'],
        [meetingBody({ endsAt: undefined }), 'endsAt', 'required', 'no endsAt'],
        [meetingBody({ endsAt: iso(start) }), 'endsAt', 'invalid_range', 'end equal to start'],
        [meetingBody({ endsAt: iso(start - 1) }), 'endsAt', 'invalid_range', 'end before start'],
        [meetingBody({ endsAt: iso(start + DAY + 1) }), 'endsAt', 'too_long', '24 h and 1 ms'],
        [meetingBody({ endsAt: iso(start + 3 * DAY) }), 'endsAt', 'too_long', 'three days'],
        [meetingBody({ dueAt: iso(start) }), 'dueAt', 'task_only', 'dueAt on a meeting'],
      ];
      for (const [body, path, code, where] of cases) {
        expectDetail(await createActivity(AGENT_1, body), path, code, where);
      }
      const both = await createActivity(
        AGENT_1,
        meetingBody({ startsAt: undefined, endsAt: undefined }),
      );
      const paths = detailsOf(expectError(both, 400, 'validation_failed')).map(
        (detail) => `${detail.path}:${detail.code}`,
      );
      expect(paths).toEqual(expect.arrayContaining(['startsAt:required', 'endsAt:required']));
      for (const body of [
        meetingBody({ startsAt: null }),
        meetingBody({ endsAt: null }),
        meetingBody({ startsAt: '2031-03-03T09:00:00+01:00' }),
        meetingBody({ endsAt: '2031-03-03' }),
        meetingBody({ startsAt: '0000-01-01T00:00:00.000Z' }),
        meetingBody({ endsAt: '2031-02-30T10:00:00.000Z' }),
        meetingBody({ completedAt: iso(start) }),
      ]) {
        expectError(await createActivity(AGENT_1, body), 400, 'validation_failed');
      }
      expect(await activityCount(), 'no refused create wrote a row').toBe(count);
      expectActivity(
        await createActivity(AGENT_1, meetingBody({ endsAt: iso(start + DAY) })),
        'createActivity',
        201,
        'exactly 24 hours',
      );
    });

    it('startsAt or endsAt on a note, a task or a call is meeting_only at that field', async () => {
      expectActivity(
        await createActivity(AGENT_1, meetingBody()),
        'createActivity',
        201,
        'control',
      );
      const count = await activityCount();
      for (const type of ['note', 'task', 'call']) {
        for (const field of ['startsAt', 'endsAt']) {
          const response = await createActivity(AGENT_1, {
            type,
            contactId: AMAKA.id,
            [field]: iso(W + 9 * HOUR),
          });
          expectDetail(response, field, 'meeting_only', `${field} on a ${type}`);
        }
      }
      expect(await activityCount()).toBe(count);
    });

    it('meetings follow D-P18 unchanged, and the error order is 404, 403, 400', async () => {
      for (const key of ['agent', 'team_lead', 'programme_manager']) {
        await assign(USER_A_AGENT_1, PROGRAMME_A1, key);
        expectActivity(await createActivity(AGENT_1, meetingBody()), 'createActivity', 201, key);
      }
      expectActivity(
        await createActivity(SUPERVISOR, meetingBody()),
        'createActivity',
        201,
        'admin',
      );
      const count = await activityCount();
      const invalid = meetingBody({ endsAt: iso(W + 8 * HOUR) });
      // 404 beats 403 and 400: an unreachable target, a bad meeting.
      const nowhere = expectError(
        await createActivity(AGENT_1, { ...invalid, contactId: GRACE.id }),
        404,
        'not_found',
      );
      expect(
        expectError(
          await createActivity(AGENT_1, { ...invalid, contactId: DAMILOLA.id }),
          404,
          'not_found',
        ),
      ).toEqual(nowhere);
      for (const key of ['qa_analyst', 'client_portal']) {
        await assign(USER_A_AGENT_1, PROGRAMME_A1, key);
        expectError(await createActivity(AGENT_1, meetingBody()), 403, 'not_permitted');
        expectError(await createActivity(AGENT_1, invalid), 403, 'not_permitted');
      }
      await assign(USER_A_AGENT_1, PROGRAMME_A1, 'agent');
      expectDetail(await createActivity(AGENT_1, invalid), 'endsAt', 'invalid_range', '400 last');
      // A withheld time cannot be written.
      await lockField('starts_at', 'agent', 'read');
      const locked = expectError(
        await createActivity(AGENT_1, meetingBody()),
        403,
        'not_permitted',
      );
      expect(detailsOf(locked).map((detail) => `${detail.path}:${detail.code}`)).toContain(
        'startsAt:field_not_editable',
      );
      expect(await activityCount()).toBe(count);
    });
  });

  // =========================================================================
  // 8. Snooze and reschedule (W2, W3).
  // =========================================================================

  describe('updateActivity: snooze and reschedule (W2, D-P18, D-L102)', () => {
    it('snoozing a task moves dueAt and nothing else; null clears it and the task goes to the end of upcoming', async () => {
      const t0 = Date.now();
      const id = await plantTask(id82('a901'), t0 - DAY, { contactId: AMAKA.id });
      const other = await plantTask(id82('a902'), t0 + 2 * DAY);
      const target = t0 + 3 * DAY;
      const snoozed = expectActivity(
        await updateActivity(AGENT_1, id, { version: 1, dueAt: iso(target) }),
        'updateActivity',
        200,
        'snooze',
      );
      expect(sameInstant(snoozed.dueAt, target)).toBe(true);
      expect(snoozed.version).toBe(2);
      expect(snoozed).toMatchObject({
        completedAt: null,
        ownerUserId: USER_A_AGENT_1,
        contactId: AMAKA.id,
      });
      const row = await activityRow(id);
      expect(msOf(row?.due_at)).toBe(target);
      expect(row?.owner_user_id).toBe(USER_A_AGENT_1);
      const overdue = await readBucket(AGENT_1, 'Africa/Lagos', 'overdue', 'overdue');
      expect(overdue.items.map((item) => item.id)).toEqual([]);
      const upcoming = await readBucket(AGENT_1, 'Africa/Lagos', 'upcoming', 'upcoming');
      expect(upcoming.items.map((item) => item.id)).toEqual([other, id]);
      const cleared = expectActivity(
        await updateActivity(AGENT_1, id, { version: 2, dueAt: null }),
        'updateActivity',
        200,
        'clear',
      );
      expect(cleared.dueAt).toBeNull();
      expect((await activityRow(id))?.due_at).toBeNull();
      const after = await readBucket(AGENT_1, 'Africa/Lagos', 'upcoming', 'after clearing');
      expect(
        after.items.map((item) => item.id),
        'undated, last',
      ).toEqual([other, id]);
      expect(after.items[1]?.dueAt).toBeNull();
    });

    it('rescheduling a meeting: either time alone, both, judged on the result at the field sent', async () => {
      const start = W + 9 * HOUR;
      const id = await plantMeeting(id82('a911'), start, start + HOUR);
      let version = 1;
      const move = async (body: Json, where: string) => {
        const activity = expectActivity(
          await updateActivity(AGENT_1, id, { version, ...body }),
          'updateActivity',
          200,
          where,
        );
        version = Number(activity.version);
        return activity;
      };
      const resized = await move({ endsAt: iso(start + 2 * HOUR) }, 'endsAt alone');
      expect(
        sameInstant(resized.startsAt, start) && sameInstant(resized.endsAt, start + 2 * HOUR),
      ).toBe(true);
      const shifted = await move({ startsAt: iso(start + 30 * MINUTE) }, 'startsAt alone');
      expect(
        sameInstant(shifted.startsAt, start + 30 * MINUTE) &&
          sameInstant(shifted.endsAt, start + 2 * HOUR),
      ).toBe(true);
      // Three days later: each time alone would be invalid against the other's stored value.
      const later = start + 3 * DAY;
      const dragged = await move({ startsAt: iso(later), endsAt: iso(later + HOUR) }, 'both');
      expect(
        sameInstant(dragged.startsAt, later) && sameInstant(dragged.endsAt, later + HOUR),
      ).toBe(true);
      const row = await activityRow(id);
      expect([msOf(row?.starts_at), msOf(row?.ends_at)]).toEqual([later, later + HOUR]);
      // Now judged against the stored [later, later + 1 h].
      const refusals: [Json, string, string, string][] = [
        [{ startsAt: iso(later + HOUR) }, 'startsAt', 'invalid_range', 'start at the stored end'],
        [
          { startsAt: iso(later + 2 * HOUR) },
          'startsAt',
          'invalid_range',
          'start after the stored end',
        ],
        [{ endsAt: iso(later) }, 'endsAt', 'invalid_range', 'end at the stored start'],
        [
          { endsAt: iso(later + DAY + 1) },
          'endsAt',
          'too_long',
          'end 24 h 1 ms after the stored start',
        ],
        [
          { startsAt: iso(later + HOUR - DAY - 1) },
          'startsAt',
          'too_long',
          'start 24 h 1 ms before the stored end',
        ],
        [
          { startsAt: iso(later), endsAt: iso(later - 1) },
          'endsAt',
          'invalid_range',
          'both, reversed',
        ],
        [
          { startsAt: iso(later), endsAt: iso(later + 2 * DAY) },
          'endsAt',
          'too_long',
          'both, too long',
        ],
      ];
      for (const [body, path, code, where] of refusals) {
        expectDetail(await updateActivity(AGENT_1, id, { version, ...body }), path, code, where);
      }
      for (const body of [
        { startsAt: null },
        { endsAt: null },
        { startsAt: '2031-03-06T09:00:00+01:00' },
      ]) {
        expectError(
          await updateActivity(AGENT_1, id, { version, ...body }),
          400,
          'validation_failed',
        );
      }
      expect(await versionOf(id), 'no refusal moved the version').toBe(version);
      await move({ endsAt: iso(later + DAY) }, 'exactly 24 hours');
    });

    it('task_only and meeting_only are judged on the row: dueAt or completing a meeting, a time on a task, a note or a call', async () => {
      const meeting = await plantMeeting(id82('a921'), W, W + HOUR);
      const task = await plantTask(id82('a922'), W);
      expectActivity(
        await updateActivity(AGENT_1, task, { version: 1, dueAt: iso(W + DAY) }),
        'updateActivity',
        200,
        'control: a task snoozes',
      );
      const note = await plant({ id: id82('a923'), type: 'note' });
      const call = await plant({ id: id82('a924'), type: 'call' });
      expectDetail(
        await updateActivity(AGENT_1, meeting, { version: 1, dueAt: iso(W) }),
        'dueAt',
        'task_only',
        'dueAt, meeting',
      );
      expectDetail(
        await updateActivity(AGENT_1, meeting, { version: 1, dueAt: null }),
        'dueAt',
        'task_only',
        'null dueAt, meeting',
      );
      expectDetail(
        await updateActivity(AGENT_1, meeting, { version: 1, completed: true }),
        'completed',
        'task_only',
        'complete a meeting',
      );
      for (const [id, what] of [
        [task, 'task'],
        [note, 'note'],
        [call, 'call'],
      ] as const) {
        for (const field of ['startsAt', 'endsAt']) {
          expectDetail(
            await updateActivity(AGENT_1, id, { version: await versionOf(id), [field]: iso(W) }),
            field,
            'meeting_only',
            `${field} on a ${what}`,
          );
        }
      }
      for (const [id, what] of [
        [note, 'note'],
        [call, 'call'],
      ] as const) {
        expectDetail(
          await updateActivity(AGENT_1, id, { version: 1, dueAt: iso(W) }),
          'dueAt',
          'task_only',
          `dueAt on a ${what}`,
        );
      }
      expect((await activityRow(meeting))?.completed_at, 'a meeting is never completed').toBeNull();
    });

    it('rights are D-P18’s: any activity.write holder in the programme moves anyone’s task or meeting; qa_analyst and client_portal are 403', async () => {
      const task = await plantTask(id82('a931'), W, { ownerUserId: USER_A_SUPERVISOR });
      const meeting = await plantMeeting(id82('a932'), W, W + HOUR, { ownerUserId: null });
      let at = W;
      for (const key of ['agent', 'team_lead', 'programme_manager']) {
        await assign(USER_A_AGENT_1, PROGRAMME_A1, key);
        at += HOUR;
        expectActivity(
          await updateActivity(AGENT_1, task, { version: await versionOf(task), dueAt: iso(at) }),
          'updateActivity',
          200,
          `${key} snoozes the supervisor’s task`,
        );
        expectActivity(
          await updateActivity(AGENT_1, meeting, {
            version: await versionOf(meeting),
            endsAt: iso(at + HOUR),
          }),
          'updateActivity',
          200,
          `${key} reschedules an unowned meeting`,
        );
      }
      expect((await activityRow(task))?.owner_user_id, 'moving is not taking').toBe(
        USER_A_SUPERVISOR,
      );
      for (const key of ['qa_analyst', 'client_portal']) {
        await assign(USER_A_AGENT_1, PROGRAMME_A1, key);
        const before = await activityRow(task);
        expectError(
          await updateActivity(AGENT_1, task, { version: await versionOf(task), dueAt: iso(W) }),
          403,
          'not_permitted',
        );
        expectError(
          await updateActivity(AGENT_1, meeting, {
            version: await versionOf(meeting),
            startsAt: iso(W),
          }),
          403,
          'not_permitted',
        );
        expect(await activityRow(task)).toEqual(before);
      }
    });

    it('field security binds the times: read-only or withheld dueAt, startsAt, endsAt are 403 field_not_editable', async () => {
      const task = await plantTask(id82('a941'), W);
      const meeting = await plantMeeting(id82('a942'), W, W + HOUR);
      expectActivity(
        await updateActivity(AGENT_1, task, { version: 1, dueAt: iso(W + HOUR) }),
        'updateActivity',
        200,
        'control',
      );
      for (const level of ['read', 'none'] as const) {
        for (const [field, wire, id] of [
          ['due_at', 'dueAt', task],
          ['starts_at', 'startsAt', meeting],
          ['ends_at', 'endsAt', meeting],
        ] as const) {
          await lockField(field, 'agent', level);
          const before = await activityRow(id);
          const body = expectError(
            await updateActivity(AGENT_1, id, {
              version: await versionOf(id),
              [wire]: iso(W + 2 * HOUR),
            }),
            403,
            'not_permitted',
          );
          expect(
            detailsOf(body).map((detail) => `${detail.path}:${detail.code}`),
            `${wire} ${level}`,
          ).toContain(`${wire}:field_not_editable`);
          expect(await activityRow(id)).toEqual(before);
          await lockField(field, 'agent', 'edit');
        }
      }
      // D-L110: a meeting time is written only by a caller who can at least read the
      // other one. Otherwise invalid_range / too_long (judged before the version)
      // would let ~42 refused probes recover the withheld time, writing and auditing
      // nothing. With startsAt withheld, moving endsAt is 403 and changes nothing.
      await lockField('starts_at', 'agent', 'none');
      const unchanged = await activityRow(meeting);
      const refused = expectError(
        await updateActivity(AGENT_1, meeting, {
          version: await versionOf(meeting),
          endsAt: iso(W + 3 * HOUR),
        }),
        403,
        'not_permitted',
      );
      expect(
        detailsOf(refused).map((detail) => `${detail.path}:${detail.code}`),
        'endsAt with startsAt withheld (D-L110)',
      ).toContain('endsAt:field_not_editable');
      expect(await activityRow(meeting), 'a refused move changes nothing').toEqual(unchanged);
      // The same refusal whatever the probe, so the error carries no span information.
      for (const endsAt of [iso(W - HOUR), iso(W + 30 * HOUR)]) {
        const probe = expectError(
          await updateActivity(AGENT_1, meeting, { version: 2147483647, endsAt }),
          403,
          'not_permitted',
        );
        expect(probe, `probe ${endsAt} answers exactly the first refusal`).toEqual(refused);
      }
      // Readable startsAt: the move is allowed, and the answer carries both times.
      await lockField('starts_at', 'agent', 'read');
      const answer = expectActivity(
        await updateActivity(AGENT_1, meeting, {
          version: await versionOf(meeting),
          endsAt: iso(W + 3 * HOUR),
        }),
        'updateActivity',
        200,
        'endsAt with startsAt readable',
      );
      expect(answer.endsAt).toBe(iso(W + 3 * HOUR));
      expect('startsAt' in answer).toBe(true);
      await lockField('starts_at', 'agent', 'edit');
    });

    it('a stale version is 409 and changes nothing; the error order is 404, 403, 400, 409', async () => {
      const task = await plantTask(id82('a951'), W);
      const meeting = await plantMeeting(id82('a952'), W, W + HOUR);
      const a2 = await plantMeeting(id82('a953'), W, W + HOUR, {
        programmeId: PROGRAMME_A2,
        ownerUserId: USER_A_AGENT_2,
      });
      expectActivity(
        await updateActivity(AGENT_1, task, { version: 1, dueAt: iso(W + HOUR) }),
        'updateActivity',
        200,
        'control: version 1 -> 2',
      );
      const before = await activityRow(task);
      const stale = await updateActivity(AGENT_1, task, { version: 1, dueAt: iso(W + 9 * HOUR) });
      expectError(stale, 409, 'stale_write');
      expectNoStore(stale, '409');
      expect(await activityRow(task), 'a 409 changes nothing').toEqual(before);
      expectError(
        await updateActivity(AGENT_1, meeting, { version: 7, startsAt: iso(W + 10 * MINUTE) }),
        409,
        'stale_write',
      );
      // 400 before 409: an invalid move on a stale version.
      expectDetail(
        await updateActivity(AGENT_1, meeting, { version: 7, dueAt: iso(W) }),
        'dueAt',
        'task_only',
        '400 before 409',
      );
      expectDetail(
        await updateActivity(AGENT_1, meeting, { version: 7, endsAt: iso(W - HOUR) }),
        'endsAt',
        'invalid_range',
        '400 before 409',
      );
      // 403 before 400 and 409.
      await assign(USER_A_AGENT_1, PROGRAMME_A1, 'qa_analyst');
      expectError(
        await updateActivity(AGENT_1, meeting, { version: 7, dueAt: iso(W) }),
        403,
        'not_permitted',
      );
      await assign(USER_A_AGENT_1, PROGRAMME_A1, 'agent');
      await lockField('ends_at', 'agent', 'read');
      expectError(
        await updateActivity(AGENT_1, meeting, { version: 7, endsAt: iso(W - HOUR) }),
        403,
        'not_permitted',
      );
      // 404 before everything: another programme, another tenant, nowhere; one body.
      const bodies = [
        await updateActivity(AGENT_1, a2, { version: 7, dueAt: iso(W) }),
        await updateActivity(AGENT_1, SEEDED_B_TASK.id, { version: 7, startsAt: iso(W) }),
        await updateActivity(AGENT_1, NOWHERE, { version: 7, endsAt: iso(W - HOUR) }),
      ].map((response) => {
        expectError(response, 404, 'not_found');
        return response.text;
      });
      expect(new Set(bodies).size).toBe(1);
      for (const version of [0, -1, 2 ** 31, 1.5]) {
        expectError(
          await updateActivity(AGENT_1, task, { version, dueAt: iso(W) }),
          400,
          'validation_failed',
        );
      }
      expectError(await updateActivity(AGENT_1, task, { dueAt: iso(W) }), 400, 'validation_failed');
    });

    it('D-L102: absent fields are untouched, and a second save after a 409 keeps the other person’s change', async () => {
      // A task: agent 1 opens it, the supervisor reassigns it, agent 1 snoozes.
      const task = await plantTask(id82('a961'), W);
      const opened = await versionOf(task);
      expectActivity(
        await updateActivity(SUPERVISOR, task, { version: opened, ownerUserId: USER_A_SUPERVISOR }),
        'updateActivity',
        200,
        'the supervisor reassigns',
      );
      expectError(
        await updateActivity(AGENT_1, task, { version: opened, dueAt: iso(W + DAY) }),
        409,
        'stale_write',
      );
      const second = expectActivity(
        await updateActivity(AGENT_1, task, {
          version: await versionOf(task),
          dueAt: iso(W + DAY),
        }),
        'updateActivity',
        200,
        'the second save sends only dueAt',
      );
      expect(second.ownerUserId, 'the other person’s change survives').toBe(USER_A_SUPERVISOR);
      expect(sameInstant(second.dueAt, W + DAY)).toBe(true);
      // A meeting: two people resize opposite ends from the same version.
      const meeting = await plantMeeting(id82('a962'), W + 9 * HOUR, W + 10 * HOUR);
      const v = await versionOf(meeting);
      expectActivity(
        await updateActivity(SUPERVISOR, meeting, { version: v, endsAt: iso(W + 11 * HOUR) }),
        'updateActivity',
        200,
        'the supervisor extends',
      );
      expectError(
        await updateActivity(AGENT_1, meeting, { version: v, startsAt: iso(W + 8 * HOUR) }),
        409,
        'stale_write',
      );
      const merged = expectActivity(
        await updateActivity(AGENT_1, meeting, {
          version: await versionOf(meeting),
          startsAt: iso(W + 8 * HOUR),
        }),
        'updateActivity',
        200,
        'agent 1 re-applies only startsAt',
      );
      expect(
        sameInstant(merged.startsAt, W + 8 * HOUR) && sameInstant(merged.endsAt, W + 11 * HOUR),
      ).toBe(true);
      const row = await activityRow(meeting);
      expect([msOf(row?.starts_at), msOf(row?.ends_at)]).toEqual([W + 8 * HOUR, W + 11 * HOUR]);
      // Completing alone never touches dueAt; snoozing alone never touches completedAt.
      const third = await plantTask(id82('a963'), W + 5 * HOUR);
      expectActivity(
        await updateActivity(AGENT_1, third, { version: 1, completed: true }),
        'updateActivity',
        200,
        'complete',
      );
      const completedAt = msOf((await activityRow(third))?.completed_at);
      expect(msOf((await activityRow(third))?.due_at)).toBe(W + 5 * HOUR);
      expectActivity(
        await updateActivity(AGENT_1, third, { version: 2, dueAt: iso(W + 6 * HOUR) }),
        'updateActivity',
        200,
        'move a completed task',
      );
      expect(msOf((await activityRow(third))?.completed_at), 'completedAt is kept').toBe(
        completedAt,
      );
    });

    it('audit: one event per move naming exactly the fields that changed, by name only; refusals write none', async () => {
      const task = await plantTask(id82('a971'), W, {
        subject: `Audit subject ${RUN}`,
        body: `Audit body ${RUN}`,
      });
      const meeting = await plantMeeting(id82('a972'), W, W + HOUR);
      const step = async (id: string, body: Json, expected: string[], where: string) => {
        const before = await auditIds();
        expectActivity(
          await updateActivity(AGENT_1, id, { version: await versionOf(id), ...body }),
          'updateActivity',
          200,
          where,
        );
        const events = await auditSince(before);
        expect(events, `${where}: one event`).toHaveLength(1);
        expect(events[0]).toMatchObject({
          action: 'updated',
          object_type: 'activity',
          object_id: id,
          object_label: id,
          actor_user_id: USER_A_AGENT_1,
          programme_id: PROGRAMME_A1,
        });
        expect(
          sortedChanges(events[0]?.changes ?? []),
          `${where}: the changed fields, by name`,
        ).toEqual(sortedChanges(expected.map(named)));
        return events[0];
      };
      const snooze = await step(task, { dueAt: iso(W + 2 * HOUR) }, ['dueAt'], 'snooze');
      await step(task, { dueAt: null }, ['dueAt'], 'clear');
      await step(meeting, { startsAt: iso(W + 10 * MINUTE) }, ['startsAt'], 'move the start');
      await step(
        meeting,
        { startsAt: iso(W + 20 * MINUTE), endsAt: iso(W + 2 * HOUR) },
        ['endsAt', 'startsAt'],
        'drag',
      );
      await step(
        meeting,
        { startsAt: iso(W + 20 * MINUTE), endsAt: iso(W + 3 * HOUR) },
        ['endsAt'],
        'an unchanged start is not named',
      );
      await step(
        task,
        { dueAt: iso(W + 4 * HOUR), completed: true },
        ['completedAt', 'dueAt'],
        'snooze and complete',
      );
      const raw = JSON.stringify(snooze?.changes ?? []).toLowerCase();
      for (const form of [
        ...timeForms(W),
        ...timeForms(W + 2 * HOUR),
        `audit subject ${RUN}`,
        `audit body ${RUN}`,
      ]) {
        expect(raw, 'no value in the audit row').not.toContain(form.toLowerCase());
      }
      const quiet = await auditIds();
      await assign(USER_A_AGENT_1, PROGRAMME_A1, 'qa_analyst');
      const refusals = [
        await updateActivity(AGENT_1, task, { version: await versionOf(task), dueAt: iso(W) }),
      ];
      await assign(USER_A_AGENT_1, PROGRAMME_A1, 'agent');
      refusals.push(
        await updateActivity(AGENT_1, meeting, {
          version: await versionOf(meeting),
          endsAt: iso(W),
        }),
        await updateActivity(AGENT_1, meeting, { version: 1, startsAt: iso(W) }),
        await updateActivity(AGENT_1, NOWHERE, { version: 1, dueAt: iso(W) }),
      );
      expect(refusals.map((response) => response.status)).toEqual([403, 400, 409, 404]);
      expect(await auditSince(quiet), 'a refused move is not audited').toEqual([]);
    });
  });

  // =========================================================================
  // 9. Timelines carry meetings (T1, D-L85, D-L97).
  // =========================================================================

  describe('timelines carry meetings with their times (T1)', () => {
    it('the contact and account timelines carry a meeting with startsAt and endsAt, and null times on every other item', async () => {
      const meeting = await plantMeeting(id82('aa01'), W, W + HOUR, {
        contactId: AMAKA.id,
        accountId: IKOYI.id,
      });
      const task = await plantTask(id82('aa02'), W, { contactId: AMAKA.id, accountId: IKOYI.id });
      for (const [where, response] of [
        ['contact', await contactTimeline(AGENT_1, AMAKA.id)],
        ['account', await accountTimeline(AGENT_1, IKOYI.id)],
      ] as const) {
        expectStatus(response, 200, where);
        const operationId = where === 'contact' ? 'listContactTimeline' : 'listAccountTimeline';
        expect(schemaErrors(responseSchemaOf(operationId, '200'), response.body, where)).toEqual(
          [],
        );
        const items = pageOf(response.body).data.filter((item) => item.type === 'activity');
        const byActivity = new Map(items.map((item) => [String(item.activityId), item]));
        const shown = byActivity.get(meeting);
        expect(shown, `${where}: the meeting is on the timeline`).toMatchObject({
          activityType: 'meeting',
          version: 1,
        });
        expect(
          sameInstant(shown?.startsAt, W) && sameInstant(shown?.endsAt, W + HOUR),
          `${where}: times`,
        ).toBe(true);
        for (const item of items) {
          for (const key of ['startsAt', 'endsAt']) {
            expect(key in item, `${where}: every activity item carries ${key}`).toBe(true);
            if (item.activityType !== 'meeting')
              expect(item[key], `${where}: ${key} off a meeting`).toBeNull();
          }
        }
        expect(byActivity.get(task)).toMatchObject({ startsAt: null, endsAt: null });
      }
    });

    it('a meeting created through the API is on the contact timeline, and a withheld startsAt is omitted from the item, not the row', async () => {
      const created = expectActivity(
        await createActivity(AGENT_1, {
          type: 'meeting',
          subject: `Timeline meeting ${RUN}`,
          startsAt: iso(W),
          endsAt: iso(W + 45 * MINUTE),
          ownerUserId: USER_A_AGENT_1,
          contactId: AMAKA.id,
        }),
        'createActivity',
        201,
        'create',
      );
      await lockField('starts_at', 'agent', 'none');
      const response = await contactTimeline(AGENT_1, AMAKA.id);
      expectStatus(response, 200, 'timeline');
      const item = pageOf(response.body).data.find(
        (candidate) => candidate.activityId === created.id,
      );
      expect(item, 'the row stays on the timeline').toBeDefined();
      expect(item && 'startsAt' in item).toBe(false);
      expect(sameInstant(item?.endsAt, W + 45 * MINUTE)).toBe(true);
      expect(response.text).not.toContain(iso(W));
      const supervisor = await contactTimeline(SUPERVISOR, AMAKA.id);
      const full = pageOf(supervisor.body).data.find(
        (candidate) => candidate.activityId === created.id,
      );
      expect(sameInstant(full?.startsAt, W), 'the admin set sees it').toBe(true);
    });
  });

  // =========================================================================
  // 10. Leaks: logs, spans and error bodies (CLAUDE.md 6.1).
  // =========================================================================

  describe('leaks', () => {
    it('logs and spans carry no subject, body, contact or account name from the lists, the calendar or the writes; error bodies carry no database text', async () => {
      const SUBJECT = `Leak subject ${RUN}`;
      const BODY = `Leak body ${RUN} owes 40000`;
      const due = Date.now() + 2 * DAY;
      await plantTask(id82('ab01'), due, {
        subject: SUBJECT,
        body: BODY,
        accountId: IKOYI.id,
        contactId: AMAKA.id,
      });
      await plantTask(id82('ab02'), W + HOUR, { subject: SUBJECT, body: BODY });
      const meeting = await plantMeeting(id82('ab03'), W + 4 * HOUR, W + 5 * HOUR, {
        subject: SUBJECT,
        body: BODY,
      });
      const outcomes: [string, number, request.Response][] = [];
      const { telemetry, lines } = await captureEverything(async () => {
        outcomes.push([
          'my upcoming',
          200,
          await myActivities(AGENT_1, bucketParams('Africa/Lagos', 'upcoming')),
        ]);
        outcomes.push(['calendar', 200, await calendar(AGENT_1, windowParams(W, W + DAY))]);
        outcomes.push([
          'create a meeting',
          201,
          await createActivity(AGENT_1, {
            type: 'meeting',
            subject: SUBJECT,
            body: BODY,
            startsAt: iso(W + 2 * HOUR),
            endsAt: iso(W + 3 * HOUR),
            ownerUserId: USER_A_AGENT_1,
            contactId: AMAKA.id,
          }),
        ]);
        outcomes.push([
          'a too-long meeting',
          400,
          await createActivity(AGENT_1, {
            type: 'meeting',
            subject: SUBJECT,
            body: BODY,
            startsAt: iso(W),
            endsAt: iso(W + 2 * DAY),
            contactId: AMAKA.id,
          }),
        ]);
        outcomes.push([
          'a time on a note',
          400,
          await createActivity(AGENT_1, {
            type: 'note',
            subject: SUBJECT,
            body: BODY,
            startsAt: iso(W),
            contactId: AMAKA.id,
          }),
        ]);
        outcomes.push([
          'snooze',
          200,
          await updateActivity(AGENT_1, id82('ab01'), { version: 1, dueAt: iso(due + DAY) }),
        ]);
        outcomes.push([
          'a stale snooze',
          409,
          await updateActivity(AGENT_1, id82('ab01'), { version: 1, dueAt: iso(due) }),
        ]);
        outcomes.push([
          'dueAt on a meeting',
          400,
          await updateActivity(AGENT_1, meeting, { version: 1, dueAt: iso(W) }),
        ]);
        outcomes.push([
          'a bad zone',
          400,
          await myActivities(AGENT_1, bucketParams('Mars/Olympus_Mons', 'today')),
        ]);
        outcomes.push([
          'a bad cursor',
          400,
          await calendar(AGENT_1, windowParams(W, W + DAY, [['cursor', 'zz']])),
        ]);
      });
      // The controls: every request did what it should, so a clean capture is
      // not the cleanliness of a server that answered everything with 404.
      expect(outcomes.map(([label, , response]) => [label, response.status])).toEqual(
        outcomes.map(([label, status]) => [label, status]),
      );
      const served = outcomes.map(([, , response]) => response.text).join('\n');
      expect(served, 'control: the lists served the subject').toContain(SUBJECT);
      expect(served, 'control: the lists served the contact name').toContain(AMAKA.displayName);
      expect(
        telemetry.spans.length,
        'no spans were recorded — is telemetry wired?',
      ).toBeGreaterThan(0);
      const secrets = [SUBJECT, BODY, AMAKA.displayName, IKOYI.name];
      for (const [haystack, what] of [
        [JSON.stringify(telemetry.spans), 'spans (attributes and events)'],
        [lines.join('\n'), 'logs (Nest logger, stdout, stderr, console, OTel log records)'],
      ] as const) {
        for (const secret of secrets) {
          expect(haystack, `${what} carry "${secret}"`).not.toContain(secret);
        }
      }
      for (const [label, status, response] of outcomes) {
        if (status < 400) continue;
        for (const secret of [...secrets, ...DATABASE_TEXT_IN_BODIES]) {
          expect(response.text, `the ${label} error body carries "${secret}"`).not.toContain(
            secret,
          );
        }
      }
    });
  });
});
