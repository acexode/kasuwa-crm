import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_ACCOUNTS,
  SEED_ACTIVITIES,
  SEED_CONTACTS,
  SEED_PERMISSION_SETS,
  SEED_TENANTS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0080, timeline activity versions and the account timeline
 * (Agent 3, M3/M6). Written by QA for the lead before the build (D-L23), from
 * the contract and the decisions, not from an implementation (D-L25).
 *
 * Sources: team/tasks/T-0080-timeline-versions-and-account-timeline.md;
 * docs/api/records.openapi.yaml (`listAccountTimeline`, `ActivityItem.version`,
 * `AccountTimelinePage`, committed with this file); D-L85 (the version gap),
 * D-L72 (timeline rulings), D-L77 (activities order by created_at), D-L78
 * (account audit is names only), D-L80 (no names in cursors), D-L81 (actors,
 * creation), D-L83 (T-0078: no account value fields), D-P13 (no totals),
 * D-P26 (client portal: open, so parity only). The T-0061 suite
 * (contact-timeline.acceptance.test.ts) is the prior art; its helpers are
 * copied here, never imported (importing a test file registers its tests).
 *
 * Fixtures are packages/db/src/fixtures.ts only, plus rows planted here by
 * `kasuwa_migrator` (BYPASSRLS, never serves) with ids in this suite's own
 * range (`...-0080xxxxxxxx`). If the spec and this file disagree on something
 * the spec states, the spec wins and this file is the defect: say so in the
 * report, do not edit it.
 *
 * ==========================================================================
 * PINNED INTERFACES (the builder must honour these exactly)
 * ==========================================================================
 *
 * V1. VERSION ON THE ACTIVITY ITEM (D-L85). Every `activity` item, on the
 *     contact's timeline and the account's, carries `version`: the activity
 *     row's `version` at read time, an integer >= 1, never withheld (it is
 *     there when subject, body, dueAt and completedAt are all withheld). It
 *     is exactly what updateActivity needs: a served version completes the
 *     task (200), a stale one is 409 `stale_write` and changes nothing.
 *
 * A1. THE ACCOUNT TIMELINE. `GET /api/v1/accounts/{id}/timeline`,
 *     `listAccountTimeline`, `x-kasuwa-implemented: true` once served.
 *     200 is `{ data, nextCursor }` exactly, validated against the operation's
 *     own 200 schema (`AccountTimelinePage`). Item types: `field_changed` and
 *     `activity` only (an account has no consent).
 *
 * A2. FIELD CHANGES, BY NAME ONLY (D-L78, T-0078). One `field_changed` item
 *     per field named by an `audit_event` with `object_type = 'account'`,
 *     `object_id` = the account, in the account's programme, `created` and
 *     `updated` alike. Every item is exactly `{ id, type, occurredAt, actor,
 *     field, redacted: true }`, `field` an Account wire name. Never `before`
 *     or `after`, EVEN WHEN an audit row carries values. A change naming
 *     something that is not an Account field yields no item, and never a
 *     `consent_changed` item.
 *
 * A3. ACTIVITIES. One `activity` item per activity whose `account_id` is the
 *     account (with or without a contact). NOT: an activity of the account's
 *     contact with no `account_id`, a child account's activity, another
 *     account's. Not items either: a contact's audit event that names its
 *     `accountId`, an activity's own audit events, a child account's events,
 *     an event about this account recorded in another programme or tenant.
 *
 * A4. FIELD SECURITY, BEFORE PAGING. Judged today, in the account's
 *     programme, by the set the caller holds THERE (not the union of their
 *     sets), and the tenant-admin flag lifts nothing (D-L63). The ACCOUNT
 *     matrix (`tier`, `phones`, `owner_user_id`, `industry`, ...) omits a
 *     withheld field's items, name and all. The ACTIVITY matrix omits a
 *     withheld `subject`, `body`, `dueAt` or `completedAt` from the item,
 *     the same keys the contact timeline omits for the same activity; a
 *     withheld activity `account_id` removes every activity item from the
 *     account timeline. A page with a non-null `nextCursor` is full, and a
 *     cursor never leads to an empty page.
 *
 * A5. PAGING. Newest first across both sources; exact ties by item `id`
 *     descending in code-unit order; `limit` 1..100, default 25, out of range
 *     400; no totals; keyset, so items added after page 1 never shift or
 *     repeat later pages. THE CURSOR CARRIES A POSITION ONLY: read every way
 *     this suite can decode it (raw, URI, base64, base64url, hex, twice), it
 *     holds no name (the account's, an actor's, a subject) and no id of
 *     anything the pages served so far did not show (an audit event id, a
 *     contact id, an owner id, an activity not yet served). A malformed cursor
 *     and one issued for another account, a contact's timeline or the
 *     accounts list are 400 `invalid_cursor`; a cursor from an account the
 *     caller cannot reach answers exactly as one from an account they can.
 *
 * A6. SCOPE AND ERRORS. Another programme's account, another tenant's,
 *     nowhere, an id that is not a uuid (several forms) and a caller with no
 *     programme: one 404 body, the same bytes, also getAccount's for nowhere.
 *     Order 404 then 400 (a read has no 403): a bad cursor or limit on an
 *     unreachable account is 404. Every reader set, `qa_analyst` and
 *     `client_portal` included, gets 200. `Cache-Control: no-store` on 200,
 *     404 and 400. No session is 401, one body whatever the id. A scope
 *     header is 400 `validation_failed`, one body for a reachable and an
 *     unreachable account (authentication refuses it before any lookup, as
 *     on the contact timeline).
 *
 * A7. CLIENT PORTAL (D-P26 is open). Parity, not a new rule: `client_portal`
 *     sees the same items as the `agent` set on both timelines, and an
 *     activity's item is the same on both timelines in everything but `id`.
 *
 * ==========================================================================
 * THE BUILDER'S (not asserted)
 * ==========================================================================
 * Item id and cursor encodings (beyond A5); whether an activity's item id is
 * the same on the contact and the account timeline; what the account timeline
 * does when the activity's `contact_id` is withheld (the item carries no
 * contact); order of items that differ only below the millisecond (each is
 * served once); the exact field list a create records (T-0055 owns it; this
 * suite derives the expected items from the audit rows).
 *
 * ==========================================================================
 * D-L23: on main no account timeline route exists and no activity item
 * carries `version`. Every API test then fails on a 404 for the route (each
 * test that asserts a 404 first asserts a 200 control on a reachable account,
 * so "no route" never passes for "out of scope") or on the missing `version`.
 * The four contract tests read the YAML committed with this suite; three pass
 * at commit time by design (they pin the contract, not the API), and the
 * `x-kasuwa-implemented` test fails until the builder flips it.
 *
 * Writes: the suite reseeds before and after, and after every test.
 */

// ---------------------------------------------------------------------------
// Constants and fixtures (packages/db/src/fixtures.ts, never a second set).
// ---------------------------------------------------------------------------

const ACCOUNTS = '/api/v1/accounts';
const CONTACTS = '/api/v1/contacts';
const ACTIVITIES = '/api/v1/activities';
const accountTimelinePath = (id: string) => `${ACCOUNTS}/${id}/timeline`;
const contactTimelinePath = (id: string) => `${CONTACTS}/${id}/timeline`;

/** This suite's id range: `0080` marks T-0080. Tails are hex. */
const id80 = (tail: string) => `11111111-0000-4000-8000-0080${tail.padStart(8, '0')}`;
/** Never a real row. */
const NOWHERE = id80('ffff');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);
const AGENT_2 = asUser(TENANT_A, USER_A_AGENT_2);
const NO_PROGRAMME = asUser(TENANT_A, USER_A_NO_PROGRAMME);

type Headers = Record<string, string>;
type Json = Record<string, unknown>;
type Params = readonly (readonly [string, string])[];

function seededContact(givenNames: string) {
  const contact = SEED_CONTACTS.find((candidate) => candidate.givenNames === givenNames);
  if (contact === undefined) throw new Error(`Fixture drift: no seeded contact '${givenNames}'`);
  return contact;
}

/** Tenant A, A1. */
const AMAKA = seededContact('Amaka');
const BASHIR = seededContact('Bashir');

function seededAccount(programmeId: string) {
  const account = SEED_ACCOUNTS.find((candidate) => candidate.programmeId === programmeId);
  if (account === undefined) throw new Error(`Fixture drift: no seeded account in ${programmeId}`);
  return account;
}

/** "Ikoyi Traders", A1: the account under test. */
const IKOYI = seededAccount(PROGRAMME_A1);
/** "Sabon Gari Mart", A2: in tenant A, outside agent 1's reach. */
const SABON = seededAccount(PROGRAMME_A2);
/** "Westlands Supplies", tenant B. */
const WESTLANDS = seededAccount(PROGRAMME_B1);

/** The seeded note on Ikoyi (D-L77 fixture): logged by agent 1, at seed time. */
const SEEDED_NOTE = (() => {
  const found = SEED_ACTIVITIES.find(
    (activity) => activity.tenantId === TENANT_A && activity.accountId === IKOYI.id,
  );
  if (found === undefined) throw new Error('Fixture drift: no seeded activity on Ikoyi');
  return found;
})();

/** Planted here: a second A1 account, and a child of Ikoyi. */
const OTHER_A1 = id80('c0001');
const CHILD = id80('c0002');

function displayNameOf(userId: string): string {
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

/** Unique per run so a probe never matches an earlier, unreseeded run. */
const RUN = Date.now().toString(36);

// ---------------------------------------------------------------------------
// A small JSON-Schema checker over the published YAML (no new dependency).
// Copied from the T-0061 suite: `allOf`, `oneOf`, `const`, closed objects.
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

function schemaAt(name: string): Json {
  return { $ref: `#/components/schemas/${name}` };
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

function findOperation(operationId: string): SpecOperation | undefined {
  const paths = ((loadDoc(SPEC_PATH) as Json).paths ?? {}) as Record<string, Json>;
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (typeof op === 'object' && op !== null && (op as Json).operationId === operationId) {
        return { path, method, op: op as Json };
      }
    }
  }
  return undefined;
}

function requireOperation(operationId: string): SpecOperation {
  const found = findOperation(operationId);
  if (found === undefined) throw new Error(`records.openapi.yaml has no operation ${operationId}`);
  return found;
}

function responseOf(operationId: string, status: string): Json {
  const { op } = requireOperation(operationId);
  const raw = ((op.responses ?? {}) as Json)[status] as Json | undefined;
  if (raw === undefined) throw new Error(`${operationId} documents no ${status} response`);
  return deref(raw, SPEC_PATH).schema;
}

/** The JSON schema of one documented response of an operation. */
function responseSchemaOf(operationId: string, status: string): Json {
  const schema = (
    (responseOf(operationId, status).content as Json | undefined)?.['application/json'] as
      Json | undefined
  )?.schema as Json | undefined;
  if (schema === undefined) throw new Error(`${operationId} ${status} has no JSON schema`);
  return schema;
}

function exampleOf(operationId: string, status: string): unknown {
  const media = (responseOf(operationId, status).content as Json | undefined)?.[
    'application/json'
  ] as Json | undefined;
  if (media?.example === undefined) throw new Error(`${operationId} ${status} has no example`);
  return media.example;
}

/** The account page's activity branch: the schema node `type: activity` resolves to. */
function activityBranchOf(pageSchema: Json): Json {
  const page = deref(pageSchema, SPEC_PATH).schema;
  const items = deref(((page.properties as Json).data as Json).items as Json, SPEC_PATH).schema;
  for (const branch of (items.oneOf ?? []) as Json[]) {
    const resolved = deref(branch, SPEC_PATH).schema;
    const type = ((resolved.properties ?? {}) as Json).type as Json | undefined;
    if (type?.const === 'activity') return resolved;
  }
  throw new Error('the page has no activity branch');
}

/** Account wire names a change may name: Account's properties, minus server-owned and derived. */
function accountFieldNames(): string[] {
  const { schema } = deref(schemaAt('Account'), SPEC_PATH);
  const serverOwned = ['id', 'programmeId', 'version', 'createdAt', 'updatedAt', 'withheldFields'];
  // `owner` is derived from `ownerUserId` (D-L73); a change names the id field.
  return Object.keys((schema.properties ?? {}) as Json).filter(
    (name) => !serverOwned.includes(name) && name !== 'owner',
  );
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

function expectStatus(response: request.Response, status: number, where: string): void {
  expect(response.status, `${where}: ${JSON.stringify(response.body)}`).toBe(status);
}

/** The task: `Cache-Control: no-store`, on 200, 404 and 400 alike. */
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

// ---------------------------------------------------------------------------
// Timeline shapes (A1, A2, V1).
// ---------------------------------------------------------------------------

/** V1: the activity item, exactly these keys; `version` is new and never withheld. */
const ACTIVITY_ITEM_KEYS = [
  'id',
  'type',
  'occurredAt',
  'actor',
  'activityId',
  'activityType',
  'subject',
  'body',
  'dueAt',
  'completedAt',
  'version',
];
const ACTIVITY_ITEM_WITHHOLDABLE = ['subject', 'body', 'dueAt', 'completedAt'];
const ACCOUNT_FIELD_ITEM_KEYS = ['actor', 'field', 'id', 'occurredAt', 'redacted', 'type'];

function activityItemProblems(item: Json, where: string): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(item)) {
    if (!ACTIVITY_ITEM_KEYS.includes(key)) problems.push(`${where}: unexpected key ${key}`);
  }
  for (const key of ACTIVITY_ITEM_KEYS) {
    if (!ACTIVITY_ITEM_WITHHOLDABLE.includes(key) && !(key in item)) {
      problems.push(`${where}: ${key} missing`);
    }
  }
  if (!Number.isInteger(item.version) || Number(item.version) < 1) {
    problems.push(`${where}: version ${JSON.stringify(item.version)} is not an integer >= 1`);
  }
  if (typeof item.activityId !== 'string' || !UUID.test(item.activityId)) {
    problems.push(`${where}: activityId is not a uuid`);
  } else if (String(item.id).toLowerCase() === item.activityId.toLowerCase()) {
    problems.push(`${where}: the item id is the activity id`);
  }
  if (!['note', 'task', 'call'].includes(item.activityType as string)) {
    problems.push(`${where}: activityType ${JSON.stringify(item.activityType)}`);
  }
  for (const key of ['dueAt', 'completedAt']) {
    if (key in item && item[key] !== null && !DATE_TIME.test(String(item[key]))) {
      problems.push(`${where}: ${key} is not a date-time or null`);
    }
  }
  return problems;
}

function actorProblems(item: Json, where: string): string[] {
  if (!('actor' in item)) return [`${where}: actor missing`];
  const actor = item.actor;
  if (actor === null) return [];
  if (typeof actor !== 'object') return [`${where}: actor is not an object or null`];
  const keys = Object.keys(actor as Json).sort();
  const problems: string[] = [];
  if (keys.join() !== 'displayName,id') problems.push(`${where}: actor keys ${keys.join()}`);
  if (!UUID.test(String((actor as Json).id))) problems.push(`${where}: actor.id not a uuid`);
  if (typeof (actor as Json).displayName !== 'string') {
    problems.push(`${where}: actor.displayName not a string`);
  }
  return problems;
}

/** A2: by name only, an Account field, nothing else. */
function accountFieldItemProblems(item: Json, where: string): string[] {
  const problems: string[] = [];
  const keys = Object.keys(item).sort();
  if (keys.join() !== ACCOUNT_FIELD_ITEM_KEYS.join()) {
    problems.push(`${where}: keys ${keys.join()}, expected ${ACCOUNT_FIELD_ITEM_KEYS.join()}`);
  }
  if (item.redacted !== true) problems.push(`${where}: redacted is not true`);
  if (!accountFieldNames().includes(String(item.field))) {
    problems.push(`${where}: ${JSON.stringify(item.field)} is not an Account field`);
  }
  return problems;
}

/** A5: newest first; exact ties broken by id descending (code units). */
function orderProblems(items: Json[], strictTies: boolean): string[] {
  const problems: string[] = [];
  for (let index = 1; index < items.length; index += 1) {
    const newer = items[index - 1] ?? {};
    const older = items[index] ?? {};
    const a = Date.parse(String(newer.occurredAt));
    const b = Date.parse(String(older.occurredAt));
    if (a < b) problems.push(`[${index}] is newer than [${index - 1}]`);
    if (strictTies && a === b && !(String(newer.id) > String(older.id))) {
      problems.push(`[${index - 1}] and [${index}] share occurredAt and ids are not descending`);
    }
  }
  return problems;
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

function closedPageProblems(value: unknown, where: string): string[] {
  const keys = Object.keys((value ?? {}) as Json).sort();
  return keys.join() === 'data,nextCursor'
    ? []
    : [`${where}: the page carries ${keys.join()}, not data and nextCursor`];
}

/** A1/A2/V1 on an account page: the operation's own 200 schema, then the readings. */
function accountPageProblems(value: unknown, where: string): string[] {
  const problems = [
    ...schemaErrors(responseSchemaOf('listAccountTimeline', '200'), value, where),
    ...closedPageProblems(value, where),
  ];
  pageOf(value).data.forEach((item, index) => {
    const at = `${where}.data[${index}]`;
    if (typeof item.id !== 'string' || item.id === '') problems.push(`${at}: id`);
    problems.push(...actorProblems(item, at));
    if (item.type === 'field_changed') problems.push(...accountFieldItemProblems(item, at));
    else if (item.type === 'activity') problems.push(...activityItemProblems(item, at));
    else problems.push(`${at}: type ${JSON.stringify(item.type)} is not on an account timeline`);
  });
  return problems;
}

/** The contact page (TimelinePage), with V1's activity reading. */
function contactPageProblems(value: unknown, where: string): string[] {
  const problems = [
    ...schemaErrors(schemaAt('TimelinePage'), value, where),
    ...closedPageProblems(value, where),
  ];
  pageOf(value).data.forEach((item, index) => {
    const at = `${where}.data[${index}]`;
    problems.push(...actorProblems(item, at));
    if (item.type === 'activity') problems.push(...activityItemProblems(item, at));
  });
  return problems;
}

function expectAccountPage(value: unknown, where: string, strictTies = true): Page {
  expect(accountPageProblems(value, where), `${where} is not an account timeline page`).toEqual([]);
  const page = pageOf(value);
  expect(orderProblems(page.data, strictTies), `${where}: order (A5)`).toEqual([]);
  return page;
}

function expectContactPage(value: unknown, where: string): Page {
  expect(contactPageProblems(value, where), `${where} is not a TimelinePage`).toEqual([]);
  const page = pageOf(value);
  expect(orderProblems(page.data, true), `${where}: order`).toEqual([]);
  return page;
}

const fieldItems = (items: Json[]) => items.filter((item) => item.type === 'field_changed');
const activityItems = (items: Json[]) => items.filter((item) => item.type === 'activity');
const withoutSeededNote = (items: Json[]) =>
  items.filter((item) => item.activityId !== SEEDED_NOTE.id);
const withoutId = (item: Json | undefined): Json =>
  Object.fromEntries(Object.entries(item ?? {}).filter(([key]) => key !== 'id'));

/** A2: a change as T-0055 writes it: the wire name, no values. */
interface Change {
  field: string;
  before: string | null;
  after: string | null;
  redacted: boolean;
}
const named = (field: string): Change => ({ field, before: null, after: null, redacted: true });

// ---------------------------------------------------------------------------
// A5: reading a cursor every way this suite can, to look inside it.
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

/** The cursor and everything it decodes to, two levels deep, lower-cased. */
function cursorReadings(cursor: string): string[] {
  const first = [cursor, ...decodeOnce(cursor)];
  const second = first.flatMap((text) =>
    /^[A-Za-z0-9_\-+/=%]+$/.test(text) ? decodeOnce(text) : [],
  );
  return [...first, ...second].map((text) => text.toLowerCase());
}

/** An id in each form a cursor could carry it. */
const idForms = (id: string) => [id.toLowerCase(), id.toLowerCase().replace(/-/g, '')];

// ---------------------------------------------------------------------------

describe('acceptance: activity versions on the timeline, and the account timeline (T-0080)', () => {
  let app: INestApplication;
  /** kasuwa_migrator — BYPASSRLS. Plants rows and observes them; never serves. */
  let observer: Pool;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    app = await createApi(inject('databaseUrl'));
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
  const accountTimeline = (headers: Headers, accountId: string, params: Params = []) =>
    request(server())
      .get(withQuery(accountTimelinePath(accountId), params))
      .set(headers);
  /** A raw path segment, for ids a URL builder would refuse. */
  const accountTimelineRaw = (headers: Headers, segment: string) =>
    request(server()).get(`${ACCOUNTS}/${segment}/timeline`).set(headers);
  const contactTimeline = (headers: Headers, contactId: string, params: Params = []) =>
    request(server())
      .get(withQuery(contactTimelinePath(contactId), params))
      .set(headers);
  const getAccount = (headers: Headers, id: string) =>
    request(server()).get(`${ACCOUNTS}/${id}`).set(headers);
  const listAccounts = (headers: Headers, params: Params = []) =>
    request(server()).get(withQuery(ACCOUNTS, params)).set(headers);
  const createAccount = (headers: Headers, body: Json) =>
    request(server()).post(ACCOUNTS).set(headers).send(body);
  const updateAccount = (headers: Headers, id: string, body: Json) =>
    request(server()).patch(`${ACCOUNTS}/${id}`).set(headers).send(body);
  const updateContact = (headers: Headers, id: string, body: Json) =>
    request(server()).patch(`${CONTACTS}/${id}`).set(headers).send(body);
  const updateActivity = (headers: Headers, id: string, body: Json) =>
    request(server()).patch(`${ACTIVITIES}/${id}`).set(headers).send(body);

  /** One read of the whole account timeline (limit 100), validated. */
  async function readAccount(headers: Headers, accountId: string, where: string) {
    const response = await accountTimeline(headers, accountId, [['limit', '100']]);
    expectStatus(response, 200, where);
    expectNoStore(response, where);
    const page = expectAccountPage(response.body, where);
    expect(page.nextCursor, `${where}: more than 100 items; never planted here`).toBeNull();
    return page.data;
  }

  async function readContact(headers: Headers, contactId: string, where: string) {
    const response = await contactTimeline(headers, contactId, [['limit', '100']]);
    expectStatus(response, 200, where);
    const page = expectContactPage(response.body, where);
    expect(page.nextCursor, `${where}: more than 100 items; never planted here`).toBeNull();
    return page.data;
  }

  interface Walked {
    items: Json[];
    sizes: number[];
    cursors: string[];
    bodies: string[];
  }

  /**
   * Walks every page of an account timeline (A4, A5): a page with a cursor is
   * full, a cursor never leads to an empty page, no item repeats, the whole
   * walk is in order, and every page is no-store with no totals.
   */
  async function walkAccount(
    headers: Headers,
    accountId: string,
    limit: number | null,
    strictTies = true,
    startCursor: string | null = null,
  ): Promise<Walked> {
    const walked: Walked = { items: [], sizes: [], cursors: [], bodies: [] };
    let cursor = startCursor;
    let pages = 0;
    do {
      const params: [string, string][] = limit === null ? [] : [['limit', String(limit)]];
      if (cursor !== null) params.push(['cursor', cursor]);
      const where = `page ${pages + 1} at limit ${String(limit)}`;
      const response = await accountTimeline(headers, accountId, params);
      expectStatus(response, 200, where);
      expectNoStore(response, where);
      expectNoTotals(response, where);
      const page = expectAccountPage(response.body, where, strictTies);
      const full = limit ?? 25;
      if (page.nextCursor !== null) {
        expect(
          page.data.length,
          `${where} has a nextCursor but ${page.data.length} of ${full} items: ` +
            'withheld items were omitted after the page was cut (A4)',
        ).toBe(full);
        walked.cursors.push(page.nextCursor);
      }
      if (pages > 0 || startCursor !== null) {
        expect(
          page.data.length,
          `${where}: a nextCursor led to an empty page (A4)`,
        ).toBeGreaterThan(0);
      }
      walked.items.push(...page.data);
      walked.sizes.push(page.data.length);
      walked.bodies.push(response.text);
      cursor = page.nextCursor;
      pages += 1;
      if (pages > 120) throw new Error('timeline paging did not terminate');
    } while (cursor !== null);
    const ids = walked.items.map((item) => String(item.id));
    expect(new Set(ids).size, 'an item was repeated across pages').toBe(ids.length);
    expect(orderProblems(walked.items, strictTies), 'the walk as a whole is newest first').toEqual(
      [],
    );
    return walked;
  }

  /** One page, for cursors. */
  async function firstCursor(
    read: () => request.Test,
    where: string,
  ): Promise<{ cursor: string; response: request.Response }> {
    const response = await read();
    expectStatus(response, 200, where);
    const cursor = pageOf(response.body).nextCursor;
    expect(cursor, `${where}: control, a second page exists`).toEqual(expect.any(String));
    return { cursor: cursor ?? '', response };
  }

  /** Sizes a correct walk of `total` items at `limit` produces. */
  const chunks = (total: number, limit: number) => {
    const sizes: number[] = [];
    for (let left = total; left > 0; left -= limit) sizes.push(Math.min(limit, left));
    return sizes.length === 0 ? [0] : sizes;
  };

  // --- observer helpers ----------------------------------------------------

  async function activityRow(id: string): Promise<Json | null> {
    const result = await observer.query<Json>('SELECT * FROM activity WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async function activityVersion(id: string): Promise<number> {
    return Number((await activityRow(id))?.version);
  }

  async function accountVersion(id: string): Promise<number> {
    const result = await observer.query<{ version: number }>(
      'SELECT version FROM account WHERE id = $1',
      [id],
    );
    return Number(result.rows[0]?.version);
  }

  async function contactVersion(id: string): Promise<number> {
    const result = await observer.query<{ version: number }>(
      'SELECT version FROM contact WHERE id = $1',
      [id],
    );
    return Number(result.rows[0]?.version);
  }

  interface PlantedActivity {
    id: string;
    programmeId?: string;
    type: 'note' | 'task' | 'call';
    subject?: string | null;
    body?: string | null;
    contactId?: string | null;
    accountId?: string | null;
    ownerUserId?: string | null;
    createdByUserId?: string | null;
    dueAt?: string | null;
    createdAt?: string | null;
    version?: number;
  }

  async function plantActivity(activity: PlantedActivity) {
    await observer.query(
      `INSERT INTO activity (id, tenant_id, programme_id, type, subject, body, owner_user_id,
                             contact_id, account_id, created_by_user_id, due_at, created_at,
                             version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               COALESCE($12::timestamptz, now()), $13)`,
      [
        activity.id,
        TENANT_A,
        activity.programmeId ?? PROGRAMME_A1,
        activity.type,
        activity.subject ?? null,
        activity.body ?? null,
        activity.ownerUserId ?? null,
        activity.contactId ?? null,
        activity.accountId ?? null,
        activity.createdByUserId ?? null,
        activity.dueAt ?? null,
        activity.createdAt ?? null,
        activity.version ?? 1,
      ],
    );
  }

  interface PlantedEvent {
    id?: string;
    objectType?: 'account' | 'contact';
    objectId: string;
    tenantId?: string;
    programmeId?: string;
    occurredAt: string;
    /** null is the system. */
    actorUserId: string | null;
    action?: 'created' | 'updated';
    changes: Change[];
  }

  /** Plants one audit event, as T-0055 (or a system writer) would have. */
  async function plantEvent(event: PlantedEvent): Promise<string> {
    const id = event.id ?? randomUUID();
    await observer.query(
      `INSERT INTO audit_event (id, tenant_id, occurred_at, actor_kind, actor_user_id, action,
                                object_type, object_id, object_label, programme_id, changes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        id,
        event.tenantId ?? TENANT_A,
        event.occurredAt,
        event.actorUserId === null ? 'system' : 'user',
        event.actorUserId,
        event.action ?? 'updated',
        event.objectType ?? 'account',
        event.objectId,
        event.objectId,
        event.programmeId ?? PROGRAMME_A1,
        JSON.stringify(event.changes),
      ],
    );
    return id;
  }

  async function plantAccount(id: string, name: string, parentAccountId: string | null = null) {
    await observer.query(
      `INSERT INTO account (id, tenant_id, programme_id, name, parent_account_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, TENANT_A, PROGRAMME_A1, name, parentAccountId],
    );
  }

  async function assign(userId: string, programmeId: string, key: string) {
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id)
       DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, TENANT_A, permissionSet(TENANT_A, key)],
    );
  }

  async function setTenantAdmin(userId: string, value: boolean) {
    await observer.query('UPDATE "user" SET is_tenant_admin = $1 WHERE id = $2', [value, userId]);
  }

  /** One field-security decision in tenant A, against the standard field_def the seed holds. */
  async function lockField(
    objectApiName: 'contact' | 'activity' | 'account',
    field: string,
    setKey: string,
    level: 'none' | 'read' | 'edit',
  ) {
    const found = await observer.query<{ id: string }>(
      `SELECT f.id FROM field_def f
         JOIN object_def o ON o.id = f.object_id AND o.tenant_id = f.tenant_id
        WHERE f.tenant_id = $1 AND o.api_name = $2 AND f.api_name = $3`,
      [TENANT_A, objectApiName, field],
    );
    const fieldId = found.rows[0]?.id;
    if (fieldId === undefined) {
      throw new Error(
        `Fixture drift: tenant A has no standard field_def ${objectApiName}.${field} ` +
          '(T-0053 / T-0054 / T-0060 seed them). This suite plants grants, never field definitions.',
      );
    }
    await observer.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [TENANT_A, fieldId, permissionSet(TENANT_A, setKey), level],
    );
  }

  /** A task in A1, logged a week ago by the supervisor. */
  async function plantTask(id: string, extra: Partial<PlantedActivity> = {}) {
    await plantActivity({
      id,
      type: 'task',
      subject: 'T0080 planted task',
      body: 'Invented text that names no one.',
      createdByUserId: USER_A_SUPERVISOR,
      dueAt: '2026-12-01T09:00:00.000Z',
      createdAt: new Date(Date.now() - 7 * 24 * 3_600_000).toISOString(),
      ...extra,
    });
  }

  interface Mixed {
    eventIds: string[];
    activityIds: string[];
    /** Items an agent with `tier` and `phones` locked sees, the seeded note excluded. */
    visibleToAgent: number;
  }

  /**
   * A history on Ikoyi that interleaves both sources (A4, A5). Newest first:
   * 4 withheld events, then 8 x (visible event, withheld event, activity,
   * withheld event), then 3 withheld events. Withheld means `tier` or `phones`
   * (locked for the agent set by the tests that need it); visible is
   * `industry`, and every other visible event also carries a withheld `tier`
   * rider. Activities alternate account-only and account + Amaka, owned by
   * agent 2 (an owner id is never on an item, so never in a cursor).
   */
  async function plantMixedHistory(): Promise<Mixed> {
    const kinds: ('V' | 'W' | 'A')[] = [
      ...Array<'W'>(4).fill('W'),
      ...Array.from({ length: 8 }, () => ['V', 'W', 'A', 'W'] as const).flat(),
      ...Array<'W'>(3).fill('W'),
    ];
    const base = Date.parse('2026-03-01T00:00:00.000Z');
    const mixed: Mixed = { eventIds: [], activityIds: [], visibleToAgent: 0 };
    let visible = 0;
    let withheld = 0;
    for (const [position, kind] of kinds.entries()) {
      const at = new Date(base + (kinds.length - position) * 60_000).toISOString();
      const tail = String(position).padStart(4, '0');
      if (kind === 'A') {
        const id = id80(`a1${tail}`);
        await plantActivity({
          id,
          type: 'note',
          subject: `T0080 history note ${position}`,
          body: 'Invented text that names no one.',
          accountId: IKOYI.id,
          contactId: position % 8 === 2 ? AMAKA.id : null,
          ownerUserId: USER_A_AGENT_2,
          createdByUserId: USER_A_SUPERVISOR,
          createdAt: at,
        });
        mixed.activityIds.push(id);
        mixed.visibleToAgent += 1;
        continue;
      }
      const changes: Change[] = [];
      if (kind === 'V') {
        changes.push(named('industry'));
        if (visible % 2 === 0) changes.push(named('tier'));
        visible += 1;
        mixed.visibleToAgent += 1;
      } else {
        changes.push(named(withheld % 2 === 0 ? 'tier' : 'phones'));
        withheld += 1;
      }
      mixed.eventIds.push(
        await plantEvent({
          id: id80(`e1${tail}`),
          objectId: IKOYI.id,
          occurredAt: at,
          actorUserId: USER_A_SUPERVISOR,
          changes,
        }),
      );
    }
    return mixed;
  }

  // =========================================================================
  // 0. The contract records the slice (records.openapi.yaml).
  // =========================================================================

  describe('the contract (records.openapi.yaml)', () => {
    it('(self-check) the checkers accept both timelines’ examples and reject broken copies of the account one', () => {
      // Passes once the contract is committed, by design: it tests this
      // file's checkers. A checker only ever seen passing proves nothing.
      const contactExample = exampleOf('listContactTimeline', '200');
      expect(contactPageProblems(contactExample, 'contact example')).toEqual([]);
      expect(
        activityItems(pageOf(contactExample).data).length,
        'the contact example shows an activity item, so V1 is visible to a mock',
      ).toBeGreaterThan(0);

      const example = exampleOf('listAccountTimeline', '200') as Page;
      expect(accountPageProblems(example, 'account example')).toEqual([]);
      expect(orderProblems(example.data, true)).toEqual([]);
      const field = example.data.find((item) => item.type === 'field_changed') ?? {};
      const activity = example.data.find((item) => item.type === 'activity') ?? {};
      expect(
        Object.keys(field).length * Object.keys(activity).length,
        'example items',
      ).toBeGreaterThan(0);
      const one = (item: Json): Page => ({ data: [item], nextCursor: null });
      const mutants: [string, unknown][] = [
        ['a page with a total', { ...example, total: 3 }],
        ['a tier change with values', one({ ...field, before: 'sme', after: 'enterprise' })],
        ['a tags change with values', one({ ...field, field: 'tags', before: [], after: ['x'] })],
        ['a state change with values', one({ ...field, field: 'state', before: null, after: 'x' })],
        ['a change not marked redacted', one(withoutKey(field, 'redacted'))],
        ['a contact-only field', one({ ...field, field: 'emails' })],
        ['a server-owned field', one({ ...field, field: 'version' })],
        [
          'a consent item',
          one({ ...withoutKey(withoutKey(field, 'field'), 'redacted'), type: 'consent_changed' }),
        ],
        ['an activity without a version', one(withoutKey(activity, 'version'))],
        ['an activity at version 0', one({ ...activity, version: 0 })],
        ['an activity version as a string', one({ ...activity, version: '3' })],
        ['an activity carrying its owner', one({ ...activity, ownerUserId: USER_A_AGENT_1 })],
        ['an unknown item type', one({ ...field, type: 'whatsapp_message' })],
        [
          'an actor with an email',
          one({ ...activity, actor: { id: NOWHERE, displayName: 'x', email: 'a@b.c' } }),
        ],
      ];
      for (const [label, mutant] of mutants) {
        expect(
          accountPageProblems(mutant, label).length,
          `the checker accepted a page with ${label}`,
        ).toBeGreaterThan(0);
      }
      const tied = example.data.filter((item) => item.occurredAt === example.data[0]?.occurredAt);
      expect(tied.length, 'the example shows a tie').toBeGreaterThan(1);
      expect(orderProblems([...tied].reverse(), true).length, 'an ascending tie').toBeGreaterThan(
        0,
      );
    });

    it('listAccountTimeline is GET /api/v1/accounts/{id}/timeline, implemented, closed, 200/400/401/404 and never 403', () => {
      const { method, path, op } = requireOperation('listAccountTimeline');
      expect([method, path.replace(/\{[A-Za-z]+\}/, '{id}')]).toEqual([
        'get',
        `${ACCOUNTS}/{id}/timeline`,
      ]);
      expect(op['x-kasuwa-implemented'], 'listAccountTimeline is served').toBe(true);
      const codes = Object.keys((op.responses ?? {}) as Json).sort();
      expect(codes).toEqual(['200', '400', '401', '404']);
      const page = deref(responseSchemaOf('listAccountTimeline', '200'), SPEC_PATH).schema;
      expect(page.additionalProperties, 'the page is closed').toBe(false);
      expect(Object.keys((page.properties ?? {}) as Json).sort()).toEqual(['data', 'nextCursor']);
      const params = ((op.parameters ?? []) as Json[]).map(
        (parameter) => deref(parameter, SPEC_PATH).schema.name,
      );
      expect(params.sort(), 'cursor and limit, nothing else in the query').toEqual([
        'cursor',
        'limit',
      ]);
    });

    it('the activity item requires an integer version >= 1, and both timelines share that one schema (V1)', () => {
      const contactBranch = activityBranchOf(schemaAt('TimelinePage'));
      const accountBranch = activityBranchOf(responseSchemaOf('listAccountTimeline', '200'));
      expect(accountBranch, 'the account timeline forks the activity item').toBe(contactBranch);
      expect((contactBranch.required ?? []) as string[]).toContain('version');
      const version = ((contactBranch.properties ?? {}) as Json).version as Json | undefined;
      expect(version).toMatchObject({ type: 'integer', minimum: 1 });
    });

    it('an account field change is an Account field by name only: no value is expressible, for any field (A2)', () => {
      const fields = accountFieldNames();
      expect(fields, 'Account fields read from the contract').toEqual(
        expect.arrayContaining(['name', 'tier', 'tags', 'state', 'phones', 'ownerUserId']),
      );
      const base = {
        id: 'ti_t0080',
        type: 'field_changed',
        occurredAt: '2026-10-01T09:12:00.000Z',
        actor: null,
      };
      const schema = responseSchemaOf('listAccountTimeline', '200');
      const page = (item: Json): Page => ({ data: [item], nextCursor: null });
      for (const field of fields) {
        expect(
          schemaErrors(schema, page({ ...base, field, redacted: true }), field),
          `${field} by name is not a valid account item`,
        ).toEqual([]);
        for (const values of [
          { before: 'a', after: 'b' },
          { before: null, after: 'b' },
          { before: ['a'], after: ['b'] },
        ]) {
          expect(
            schemaErrors(schema, page({ ...base, field, ...values }), field).length,
            `${field} with values ${JSON.stringify(values)} is a valid account item`,
          ).toBeGreaterThan(0);
          expect(
            schemaErrors(schema, page({ ...base, field, redacted: true, ...values }), field).length,
            `${field}, redacted, with values is a valid account item`,
          ).toBeGreaterThan(0);
        }
      }
    });
  });

  // =========================================================================
  // 1. Activity versions (V1, D-L85).
  // =========================================================================

  describe('activity versions on the timeline (D-L85)', () => {
    it('the item’s version is the row’s, read live on both timelines, and is never withheld', async () => {
      const TASK = id80('a0001');
      await plantTask(TASK, { contactId: AMAKA.id, accountId: IKOYI.id, version: 4 });
      const pick = (items: Json[]) => items.find((item) => item.activityId === TASK);

      expect(pick(await readContact(AGENT_1, AMAKA.id, 'contact'))?.version).toBe(4);
      expect(pick(await readAccount(AGENT_1, IKOYI.id, 'account'))?.version).toBe(4);

      // Not a constant, and not cached: the row moves, the item follows.
      await observer.query('UPDATE activity SET version = 9 WHERE id = $1', [TASK]);
      expect(await activityVersion(TASK), 'control: the row moved').toBe(9);
      expect(pick(await readContact(AGENT_1, AMAKA.id, 'contact, moved'))?.version).toBe(9);
      expect(pick(await readAccount(AGENT_1, IKOYI.id, 'account, moved'))?.version).toBe(9);

      // Every withholdable key withheld: the version stays.
      for (const field of ['subject', 'body', 'due_at', 'completed_at']) {
        await lockField('activity', field, 'agent', 'none');
      }
      for (const [where, items] of [
        ['contact, locked', await readContact(AGENT_1, AMAKA.id, 'contact, locked')],
        ['account, locked', await readAccount(AGENT_1, IKOYI.id, 'account, locked')],
      ] as const) {
        const item = pick(items);
        expect(item, `${where}: the activity is still shown`).toBeDefined();
        expect(Object.keys(item ?? {}).sort(), where).toEqual(
          ['activityId', 'activityType', 'actor', 'id', 'occurredAt', 'type', 'version'].sort(),
        );
        expect(item?.version, `${where}: a version is never withheld`).toBe(9);
      }
    });

    it('a task someone else logged last week completes from the contact timeline with the served version; a stale one is 409', async () => {
      const TASK = id80('a0002');
      await plantTask(TASK, { contactId: AMAKA.id, ownerUserId: null });
      const pick = (items: Json[]) => items.find((item) => item.activityId === TASK);

      const served = pick(await readContact(AGENT_1, AMAKA.id, 'first read'));
      expect(served, 'the task is on the contact timeline').toBeDefined();
      expect(served?.version, 'served version = row version').toBe(await activityVersion(TASK));
      expect(served?.actor).toEqual({
        id: USER_A_SUPERVISOR,
        displayName: displayNameOf(USER_A_SUPERVISOR),
      });

      // Meanwhile the supervisor assigns it to agent 1: the served version goes stale.
      expectStatus(
        await updateActivity(SUPERVISOR, TASK, {
          version: served?.version,
          ownerUserId: USER_A_AGENT_1,
        }),
        200,
        'the supervisor’s write',
      );
      const between = await activityRow(TASK);
      expectError(
        await updateActivity(AGENT_1, TASK, { version: served?.version, completed: true }),
        409,
        'stale_write',
      );
      expect(await activityRow(TASK), 'a stale write changes nothing').toEqual(between);

      const reread = pick(await readContact(AGENT_1, AMAKA.id, 'second read'));
      expect(reread?.version, 'the timeline serves the new version').toBe(Number(between?.version));
      const done = await updateActivity(AGENT_1, TASK, {
        version: reread?.version,
        completed: true,
      });
      expectStatus(done, 200, 'complete with the re-served version');

      const after = pick(await readContact(AGENT_1, AMAKA.id, 'after'));
      expect(after?.id, 'the same item').toBe(served?.id);
      expect(after?.occurredAt, 'completion does not move it').toBe(served?.occurredAt);
      expect(after?.completedAt).toEqual(expect.stringMatching(DATE_TIME));
      expect(after?.version).toBe((done.body as Json).version);
      expect(after?.version).toBe(await activityVersion(TASK));
    });

    it('an account-only task completes from the account timeline with the served version; replaying it is 409', async () => {
      const TASK = id80('a0003');
      await plantTask(TASK, { accountId: IKOYI.id, ownerUserId: USER_A_AGENT_1 });
      const pick = (items: Json[]) => items.find((item) => item.activityId === TASK);

      const served = pick(await readAccount(AGENT_1, IKOYI.id, 'first read'));
      expect(served, 'the account-only task is on the account timeline').toBeDefined();
      expect(served?.completedAt).toBeNull();
      const done = await updateActivity(AGENT_1, TASK, {
        version: served?.version,
        completed: true,
      });
      expectStatus(done, 200, 'complete with the served version');
      const after = pick(await readAccount(AGENT_1, IKOYI.id, 'after'));
      expect(after?.id).toBe(served?.id);
      expect(after?.completedAt).toEqual(expect.stringMatching(DATE_TIME));
      expect(after?.version).toBe(Number(served?.version) + 1);

      const settled = await activityRow(TASK);
      expectError(
        await updateActivity(AGENT_1, TASK, {
          version: served?.version,
          ownerUserId: USER_A_AGENT_1,
        }),
        409,
        'stale_write',
      );
      expect(await activityRow(TASK)).toEqual(settled);
    });
  });

  // =========================================================================
  // 2. What is on the account timeline (A2, A3).
  // =========================================================================

  describe('the account timeline: what is on it', () => {
    it('at seed it is exactly the seeded note: the item shape, the actor by name, version 1, no-store, no totals', async () => {
      const response = await accountTimeline(AGENT_1, IKOYI.id);
      expectStatus(response, 200, 'seed');
      expectNoStore(response, 'seed');
      expectNoTotals(response, 'seed');
      const page = expectAccountPage(response.body, 'seed');
      expect(page.nextCursor).toBeNull();
      expect(page.data).toEqual([
        {
          id: expect.any(String),
          type: 'activity',
          occurredAt: expect.stringMatching(DATE_TIME),
          actor: { id: USER_A_AGENT_1, displayName: displayNameOf(USER_A_AGENT_1) },
          activityId: SEEDED_NOTE.id,
          activityType: SEEDED_NOTE.type,
          subject: SEEDED_NOTE.subject,
          body: SEEDED_NOTE.body,
          dueAt: null,
          completedAt: null,
          version: 1,
        },
      ]);
    });

    it('API writes appear one item per audited field, by name only, by the writer; no value of any field is on the page', async () => {
      const NAME = `Adaeze T0080 Trading ${RUN}`;
      const PHONE = '+2348030080001';
      const TAG = `T0080 tag ${RUN}`;
      const STATE = `Kano${RUN}`;
      const INDUSTRY = `FMCG ${RUN}`;
      const created = await createAccount(SUPERVISOR, {
        programmeId: PROGRAMME_A1,
        name: NAME,
        tier: 'mid_market',
        phones: [{ type: 'work', e164: PHONE }],
        tags: [TAG],
        state: STATE,
      });
      expectStatus(created, 201, 'create');
      const id = String((created.body as Json).id);
      expectStatus(
        await updateAccount(SUPERVISOR, id, {
          version: await accountVersion(id),
          tier: 'enterprise',
          industry: INDUSTRY,
        }),
        200,
        'update',
      );

      const events = await observer.query<{ id: string; occurred_at: Date; changes: Change[] }>(
        `SELECT id, occurred_at, changes FROM audit_event
          WHERE object_type = 'account' AND object_id = $1 ORDER BY occurred_at`,
        [id],
      );
      const expected = events.rows.flatMap((event) =>
        event.changes
          .filter((change) => accountFieldNames().includes(change.field))
          .map((change) => `${change.field}@${event.occurred_at.toISOString()}`),
      );
      expect(events.rows, 'control: T-0055 audits a create and an update').toHaveLength(2);
      expect(expected.map((key) => key.split('@')[0])).toEqual(
        expect.arrayContaining(['name', 'phones', 'tags', 'state', 'tier', 'industry']),
      );

      const read = await accountTimeline(AGENT_1, id, [['limit', '100']]);
      expectStatus(read, 200, 'agent reads the new account');
      const items = expectAccountPage(read.body, 'new account').data;
      expect(activityItems(items)).toEqual([]);
      expect(
        items.map((item) => `${String(item.field)}@${String(item.occurredAt)}`).sort(),
        'one item per audited field, at the event’s time',
      ).toEqual([...expected].sort());
      expect(
        items
          .slice(0, 2)
          .map((item) => item.field)
          .sort(),
        'the update is newest',
      ).toEqual(['industry', 'tier']);
      for (const item of items) {
        expect(item.actor).toEqual({
          id: USER_A_SUPERVISOR,
          displayName: displayNameOf(USER_A_SUPERVISOR),
        });
        for (const event of events.rows) {
          expect(String(item.id).toLowerCase(), 'an item id is never the audit event id').not.toBe(
            event.id.toLowerCase(),
          );
        }
      }
      expect(new Set(items.map((item) => item.id)).size, 'item ids are per item').toBe(
        items.length,
      );
      const digits = PHONE.replace(/^\+/, '');
      for (const secret of [
        NAME,
        PHONE,
        digits,
        `0${digits.slice(3)}`,
        TAG,
        STATE,
        INDUSTRY,
        'mid_market',
        'enterprise',
      ]) {
        expect(read.text, `the account timeline carries "${secret}"`).not.toContain(secret);
      }
    });

    it('never a value even when an audit row carries one; a name that is not an Account field yields nothing, and never a consent item', async () => {
      const OLD_NAME = `Old Name ${RUN}`;
      const NEW_NAME = `New Name ${RUN}`;
      const NEW_TAG = `T0080 new tag ${RUN}`;
      const NEW_STATE = `Kaduna${RUN}`;
      await plantEvent({
        objectId: IKOYI.id,
        occurredAt: '2026-04-01T09:00:00.000Z',
        actorUserId: USER_A_SUPERVISOR,
        changes: [
          { field: 'tier', before: 'sme', after: 'mid_market', redacted: false },
          { field: 'name', before: OLD_NAME, after: NEW_NAME, redacted: false },
          { field: 'tags', before: '[]', after: JSON.stringify([NEW_TAG]), redacted: false },
          { field: 'state', before: null, after: NEW_STATE, redacted: false },
          { field: 'consentState', before: 'unknown', after: 'opted_in', redacted: false },
          named('emails'),
          { field: 'priority', before: null, after: 'urgent', redacted: false },
          named('programmeId'),
        ],
      });
      const read = await accountTimeline(SUPERVISOR, IKOYI.id, [['limit', '100']]);
      expectStatus(read, 200, 'supervisor');
      const items = expectAccountPage(read.body, 'planted values').data;
      expect(
        fieldItems(items)
          .map((item) => item.field)
          .sort(),
        'Account fields only, one item each',
      ).toEqual(['name', 'state', 'tags', 'tier']);
      for (const item of fieldItems(items)) {
        expect(item.redacted, `${String(item.field)} is by name only`).toBe(true);
        expect('before' in item || 'after' in item, `${String(item.field)} values`).toBe(false);
      }
      expect(withoutSeededNote(activityItems(items))).toEqual([]);
      for (const secret of [
        OLD_NAME,
        NEW_NAME,
        NEW_TAG,
        NEW_STATE,
        'mid_market',
        'opted_in',
        'consent',
        'emails',
        'priority',
        'urgent',
        'programmeId',
        PROGRAMME_A2,
      ]) {
        expect(read.text, `the account timeline carries "${secret}"`).not.toContain(secret);
      }
    });

    it('activities whose account is this one, with or without a contact; nothing of contacts, children, other accounts or other scopes', async () => {
      await plantAccount(CHILD, `T0080 Child ${RUN}`, IKOYI.id);
      await observer.query('UPDATE contact SET account_id = $1 WHERE id = $2', [
        IKOYI.id,
        AMAKA.id,
      ]);
      const on = (tail: string, extra: Partial<PlantedActivity>) =>
        plantActivity({
          id: id80(tail),
          type: 'note',
          subject: `T0080 ${tail}`,
          createdByUserId: USER_A_SUPERVISOR,
          ...extra,
        });
      await on('a0010', { accountId: IKOYI.id });
      await on('a0011', { accountId: IKOYI.id, contactId: AMAKA.id });
      await on('a0012', { contactId: AMAKA.id }); // Amaka is linked to Ikoyi; this is not.
      await on('a0013', { contactId: BASHIR.id });
      await on('a0014', { accountId: CHILD });
      await on('a0015', { accountId: SABON.id, programmeId: PROGRAMME_A2 });
      await plantEvent({
        objectId: CHILD,
        occurredAt: '2026-04-02T09:00:00.000Z',
        actorUserId: USER_A_SUPERVISOR,
        changes: [named('tier')],
      });
      // About Ikoyi, but recorded in another programme, and in another tenant.
      await plantEvent({
        objectId: IKOYI.id,
        programmeId: PROGRAMME_A2,
        occurredAt: '2026-04-03T09:00:00.000Z',
        actorUserId: USER_A_SUPERVISOR,
        changes: [named('industry')],
      });
      await plantEvent({
        objectId: IKOYI.id,
        tenantId: TENANT_B,
        programmeId: PROGRAMME_B1,
        occurredAt: '2026-04-04T09:00:00.000Z',
        actorUserId: null,
        changes: [named('lga')],
      });
      // A contact event naming accountId, and an activity's own events.
      expectStatus(
        await updateContact(SUPERVISOR, BASHIR.id, {
          version: await contactVersion(BASHIR.id),
          accountId: IKOYI.id,
        }),
        200,
        'link Bashir to Ikoyi',
      );
      await plantTask(id80('a0016'), { accountId: IKOYI.id, ownerUserId: USER_A_AGENT_1 });
      expectStatus(
        await updateActivity(SUPERVISOR, id80('a0016'), { version: 1, completed: true }),
        200,
        'complete a task (an activity event)',
      );

      const expectedActivities = [id80('a0010'), id80('a0011'), id80('a0016'), SEEDED_NOTE.id];
      for (const [label, headers] of [
        ['agent', AGENT_1],
        ['supervisor', SUPERVISOR],
      ] as const) {
        const items = await readAccount(headers, IKOYI.id, label);
        expect(
          activityItems(items)
            .map((item) => item.activityId)
            .sort(),
          `${label}: exactly Ikoyi’s activities`,
        ).toEqual([...expectedActivities].sort());
        expect(fieldItems(items), `${label}: no event is Ikoyi’s own`).toEqual([]);
      }

      // The controls: each excluded row is real and served where it belongs.
      const child = await readAccount(AGENT_1, CHILD, 'child');
      expect(activityItems(child).map((item) => item.activityId)).toEqual([id80('a0014')]);
      expect(fieldItems(child).map((item) => item.field)).toEqual(['tier']);
      const amaka = await readContact(AGENT_1, AMAKA.id, 'Amaka');
      expect(
        activityItems(amaka)
          .map((item) => item.activityId)
          .sort(),
      ).toEqual([id80('a0011'), id80('a0012')].sort());
      const sabon = await readAccount(SUPERVISOR, SABON.id, 'Sabon');
      expect(activityItems(sabon).map((item) => item.activityId)).toContain(id80('a0015'));
    });
  });

  // =========================================================================
  // 3. Field security (A4).
  // =========================================================================

  describe('field security: both matrices, judged in the account’s programme, before paging', () => {
    it('the account matrix omits a withheld field’s items, name and all, judged today; neighbours’ ids do not move; the admin set sees all', async () => {
      await plantEvent({
        objectId: IKOYI.id,
        occurredAt: '2026-04-10T09:01:00.000Z',
        actorUserId: USER_A_SUPERVISOR,
        changes: [named('tier'), named('phones')],
      });
      await plantEvent({
        objectId: IKOYI.id,
        occurredAt: '2026-04-10T09:02:00.000Z',
        actorUserId: USER_A_SUPERVISOR,
        changes: [named('ownerUserId'), named('parentAccountId'), named('industry')],
      });
      await plantEvent({
        objectId: IKOYI.id,
        occurredAt: '2026-04-10T09:03:00.000Z',
        actorUserId: null,
        action: 'created',
        changes: [named('name')],
      });
      const unlocked = fieldItems(await readAccount(AGENT_1, IKOYI.id, 'unlocked'));
      expect(unlocked, 'control: the agent sees all six before any lock').toHaveLength(6);

      // Locked AFTER the changes were made: judged today, not then.
      for (const field of ['tier', 'phones', 'owner_user_id', 'parent_account_id']) {
        await lockField('account', field, 'agent', 'none');
      }
      const read = await accountTimeline(AGENT_1, IKOYI.id, [['limit', '100']]);
      expectStatus(read, 200, 'locked');
      const items = expectAccountPage(read.body, 'locked').data;
      expect(
        fieldItems(items)
          .map((item) => item.field)
          .sort(),
      ).toEqual(['industry', 'name']);
      for (const name of ['tier', 'phones', 'ownerUserId', 'parentAccountId']) {
        expect(read.text, `the withheld ${name} is named on the page`).not.toContain(`"${name}"`);
      }
      const industry = (list: Json[]) => list.find((item) => item.field === 'industry')?.id;
      expect(industry(items), 'an id never moves with its neighbours').toBe(industry(unlocked));
      expect(
        fieldItems(items).find((item) => item.field === 'name')?.actor,
        'the system is null',
      ).toBeNull();
      // The admin set is never withheld.
      expect(fieldItems(await readAccount(SUPERVISOR, IKOYI.id, 'admin'))).toHaveLength(6);
    });

    it('the activity matrix omits the same keys as on the contact timeline; a withheld activity account link removes every activity item', async () => {
      const TASK = id80('a0020');
      await plantTask(TASK, { contactId: AMAKA.id, accountId: IKOYI.id, subject: `Subj ${RUN}` });
      await plantEvent({
        objectId: IKOYI.id,
        occurredAt: '2026-04-11T09:00:00.000Z',
        actorUserId: USER_A_SUPERVISOR,
        changes: [named('industry')],
      });
      await lockField('activity', 'subject', 'agent', 'none');
      await lockField('activity', 'due_at', 'agent', 'none');
      const pick = (items: Json[]) => items.find((item) => item.activityId === TASK);
      const onAccount = pick(await readAccount(AGENT_1, IKOYI.id, 'account'));
      const onContact = pick(await readContact(AGENT_1, AMAKA.id, 'contact'));
      expect(onAccount, 'the activity is on the account timeline').toBeDefined();
      expect('subject' in (onAccount ?? {}) || 'dueAt' in (onAccount ?? {})).toBe(false);
      expect(withoutId(onAccount), 'the same item, in the same shape, on both timelines').toEqual(
        withoutId(onContact),
      );

      await lockField('activity', 'account_id', 'agent', 'none');
      const read = await accountTimeline(AGENT_1, IKOYI.id, [['limit', '100']]);
      expectStatus(read, 200, 'account link withheld');
      const items = expectAccountPage(read.body, 'account link withheld').data;
      expect(activityItems(items), 'no activity item when its account link is withheld').toEqual(
        [],
      );
      expect(
        fieldItems(items).map((item) => item.field),
        'the account’s own items stay',
      ).toEqual(['industry']);
      for (const secret of [TASK, SEEDED_NOTE.id, SEEDED_NOTE.subject]) {
        expect(read.text).not.toContain(secret);
      }
      // The control: the admin set still sees both activities.
      const admin = activityItems(await readAccount(SUPERVISOR, IKOYI.id, 'admin'));
      expect(admin.map((item) => item.activityId).sort()).toEqual([TASK, SEEDED_NOTE.id].sort());
    });

    it('judged by the set held in the account’s programme, not another membership; the tenant-admin flag lifts nothing', async () => {
      // Agent 2: `agent` in A2, made `qa_analyst` in A1. Agent 1: `agent` in A1.
      await assign(USER_A_AGENT_2, PROGRAMME_A1, 'qa_analyst');
      await lockField('account', 'tier', 'qa_analyst', 'none');
      await lockField('account', 'industry', 'agent', 'none');
      await lockField('activity', 'subject', 'qa_analyst', 'none');
      await plantEvent({
        objectId: IKOYI.id,
        occurredAt: '2026-04-12T09:00:00.000Z',
        actorUserId: USER_A_SUPERVISOR,
        changes: [named('tier'), named('industry')],
      });
      const agent2 = await readAccount(AGENT_2, IKOYI.id, 'agent 2 (qa_analyst in A1)');
      expect(
        fieldItems(agent2).map((item) => item.field),
        'the A1 set decides',
      ).toEqual(['industry']);
      const note2 = activityItems(agent2).find((item) => item.activityId === SEEDED_NOTE.id);
      expect('subject' in (note2 ?? {}), 'qa_analyst’s activity lock applies in A1').toBe(false);
      expect(note2?.body).toBe(SEEDED_NOTE.body);

      await setTenantAdmin(USER_A_AGENT_1, true);
      const agent1 = await readAccount(AGENT_1, IKOYI.id, 'agent 1 with the tenant-admin flag');
      expect(
        fieldItems(agent1).map((item) => item.field),
        'the flag lifts nothing',
      ).toEqual(['tier']);
      const note1 = activityItems(agent1).find((item) => item.activityId === SEEDED_NOTE.id);
      expect(note1?.subject, 'agent 1’s set has no activity lock').toBe(SEEDED_NOTE.subject);
    });
  });

  // =========================================================================
  // 4. Paging (A4, A5).
  // =========================================================================

  describe('paging: keyset across both sources, cursors', () => {
    it('every limit walks the same items in the same order as one read; the default page is 25', async () => {
      const mixed = await plantMixedHistory();
      const whole = await readAccount(SUPERVISOR, IKOYI.id, 'whole');
      // 8 visible events + 4 riders + 23 withheld events + 8 activities + the seeded note.
      expect(whole, 'control: the planted history is served').toHaveLength(44);
      expect(activityItems(whole)).toHaveLength(mixed.activityIds.length + 1);
      for (const limit of [1, 2, 3, 7, 25]) {
        const walked = await walkAccount(SUPERVISOR, IKOYI.id, limit);
        expect(
          walked.items.map((item) => item.id),
          `limit ${limit}`,
        ).toEqual(whole.map((item) => item.id));
        expect(walked.sizes).toEqual(chunks(whole.length, limit));
      }
      const byDefault = await walkAccount(SUPERVISOR, IKOYI.id, null);
      expect(byDefault.sizes, 'no limit is 25 a page').toEqual([25, 19]);
    });

    it('withheld items are omitted before the page is cut: a short page with a cursor never happens, at any limit', async () => {
      const mixed = await plantMixedHistory();
      for (const field of ['tier', 'phones']) await lockField('account', field, 'agent', 'none');
      const supervisor = await readAccount(SUPERVISOR, IKOYI.id, 'supervisor');
      const visible = supervisor.filter(
        (item) => item.type === 'activity' || item.field === 'industry',
      );
      expect(visible, 'control: 8 industry items, 8 activities, the seeded note').toHaveLength(
        mixed.visibleToAgent + 1,
      );
      for (const limit of [1, 2, 3, 5, 7]) {
        const agent = await walkAccount(AGENT_1, IKOYI.id, limit);
        expect(agent.sizes, `page sizes at limit ${limit}`).toEqual(chunks(visible.length, limit));
        expect(
          agent.items.map((item) => item.id),
          `limit ${limit}`,
        ).toEqual(visible.map((item) => item.id));
      }
    });

    it('an activity and an event at the same instant are one tie broken by id; sub-millisecond neighbours are each served once', async () => {
      const AT = '2026-04-20T10:00:01.000Z';
      await plantActivity({ id: id80('a0030'), type: 'note', accountId: IKOYI.id, createdAt: AT });
      await plantEvent({
        objectId: IKOYI.id,
        occurredAt: AT,
        actorUserId: USER_A_SUPERVISOR,
        changes: [named('tier'), named('industry')],
      });
      await plantActivity({
        id: id80('a0031'),
        type: 'call',
        accountId: IKOYI.id,
        createdAt: '2026-04-20T10:00:00.123400Z',
      });
      for (const micros of ['123100', '123700']) {
        await plantEvent({
          objectId: IKOYI.id,
          occurredAt: `2026-04-20T10:00:00.${micros}Z`,
          actorUserId: USER_A_SUPERVISOR,
          changes: [named('lga')],
        });
      }
      for (const limit of [1, 2, 4]) {
        const { items } = await walkAccount(AGENT_1, IKOYI.id, limit, false);
        expect(withoutSeededNote(items), `limit ${limit}: every item once`).toHaveLength(6);
        const tie = items.filter((item) => item.occurredAt === AT);
        expect(tie.map((item) => item.type).sort()).toEqual([
          'activity',
          'field_changed',
          'field_changed',
        ]);
        expect(orderProblems(tie, true), `limit ${limit}: the tie by id descending`).toEqual([]);
      }
    });

    it('keyset, not offset: items added after page 1 never shift or repeat the pages that follow', async () => {
      await plantMixedHistory();
      const whole = await readAccount(SUPERVISOR, IKOYI.id, 'before');
      const first = await accountTimeline(SUPERVISOR, IKOYI.id, [['limit', '5']]);
      expectStatus(first, 200, 'page 1');
      const page1 = expectAccountPage(first.body, 'page 1');
      expect(page1.nextCursor).toEqual(expect.any(String));
      const later = new Date(Date.now() + 3_600_000).toISOString();
      await plantActivity({
        id: id80('a0040'),
        type: 'note',
        accountId: IKOYI.id,
        createdAt: later,
      });
      await plantEvent({
        objectId: IKOYI.id,
        occurredAt: later,
        actorUserId: USER_A_SUPERVISOR,
        changes: [named('tier')],
      });
      const rest = await walkAccount(SUPERVISOR, IKOYI.id, 5, true, page1.nextCursor);
      expect([...page1.data, ...rest.items].map((item) => item.id)).toEqual(
        whole.map((item) => item.id),
      );
      expect(
        (await readAccount(SUPERVISOR, IKOYI.id, 'after')).length,
        'control: the two new items exist',
      ).toBe(whole.length + 2);
    });

    it('a cursor carries a position only: no name, and no id of anything the pages served so far did not show (D-L80)', async () => {
      const mixed = await plantMixedHistory();
      const PROBE_NAME = `Ikoyi Cursor Probe ${RUN}`;
      await observer.query('UPDATE account SET name = $1 WHERE id = $2', [PROBE_NAME, IKOYI.id]);
      const walked = await walkAccount(SUPERVISOR, IKOYI.id, 3);
      expect(walked.cursors.length, 'control: many cursors').toBeGreaterThan(10);
      const names = [
        PROBE_NAME,
        IKOYI.name,
        displayNameOf(USER_A_SUPERVISOR),
        displayNameOf(USER_A_AGENT_1),
        AMAKA.givenNames,
        'T0080 history note',
        SEEDED_NOTE.subject,
      ].map((name) => name.toLowerCase());
      // Never on an item: owners, contacts, other accounts, audit events.
      const known = [
        ...mixed.eventIds,
        ...mixed.activityIds,
        SEEDED_NOTE.id,
        AMAKA.id,
        USER_A_AGENT_2,
        SABON.id,
      ];
      walked.cursors.forEach((cursor, index) => {
        const readings = cursorReadings(cursor);
        const shown = walked.bodies
          .slice(0, index + 1)
          .join('\n')
          .toLowerCase();
        for (const name of names) {
          expect(
            readings.some((text) => text.includes(name)),
            `cursor ${index + 1} carries the name "${name}"`,
          ).toBe(false);
        }
        for (const id of known) {
          if (shown.includes(id.toLowerCase())) continue;
          for (const form of idForms(id)) {
            expect(
              readings.some((text) => text.includes(form)),
              `cursor ${index + 1} carries ${id}, which no page served so far showed`,
            ).toBe(false);
          }
        }
      });
    });

    it('a malformed cursor, or one from another account, a contact’s timeline or the accounts list, is 400 invalid_cursor, no-store', async () => {
      await plantAccount(OTHER_A1, `T0080 Other ${RUN}`);
      const at = (minute: number) => `2026-04-23T10:0${minute}:00.000Z`;
      await plantEvent({
        objectId: IKOYI.id,
        occurredAt: at(1),
        actorUserId: null,
        changes: [named('tier')],
      });
      for (const minute of [1, 2]) {
        await plantEvent({
          objectId: SABON.id,
          programmeId: PROGRAMME_A2,
          occurredAt: at(minute),
          actorUserId: null,
          changes: [named('tier')],
        });
        await plantEvent({
          objectType: 'contact',
          objectId: AMAKA.id,
          occurredAt: at(minute),
          actorUserId: null,
          changes: [named('phones')],
        });
      }
      const ikoyi = await firstCursor(
        () => accountTimeline(AGENT_1, IKOYI.id, [['limit', '1']]),
        'Ikoyi',
      );
      const sabon = await firstCursor(
        () => accountTimeline(SUPERVISOR, SABON.id, [['limit', '1']]),
        'Sabon, by the supervisor',
      );
      const amaka = await firstCursor(
        () => contactTimeline(AGENT_1, AMAKA.id, [['limit', '1']]),
        'Amaka’s contact timeline',
      );
      const list = await firstCursor(() => listAccounts(AGENT_1, [['limit', '1']]), 'listAccounts');
      expectStatus(await accountTimeline(AGENT_1, OTHER_A1), 200, 'control: the other A1 account');

      const invalidCursor = (response: request.Response, where: string): Json => {
        const body = expectError(response, 400, 'validation_failed');
        expect(detailsOf(body), where).toContainEqual({ path: 'cursor', code: 'invalid_cursor' });
        expectNoStore(response, where);
        return body;
      };
      const on = (accountId: string, cursor: string) =>
        accountTimeline(AGENT_1, accountId, [
          ['limit', '1'],
          ['cursor', cursor],
        ]);
      const fromReachable = invalidCursor(await on(OTHER_A1, ikoyi.cursor), 'Ikoyi’s on another');
      const fromUnreachable = invalidCursor(await on(OTHER_A1, sabon.cursor), 'Sabon’s on A1');
      expect(
        fromUnreachable,
        'a cursor from an account out of reach answers exactly as one from an account in reach',
      ).toEqual(fromReachable);
      invalidCursor(await on(IKOYI.id, amaka.cursor), 'a contact cursor on an account');
      invalidCursor(await on(IKOYI.id, list.cursor), 'a listAccounts cursor');
      invalidCursor(
        await contactTimeline(AGENT_1, AMAKA.id, [['cursor', ikoyi.cursor]]),
        'an account cursor on a contact',
      );
      invalidCursor(await on(IKOYI.id, 'not-a-cursor'), 'garbage');
      invalidCursor(
        await on(IKOYI.id, ikoyi.cursor.slice(0, Math.floor(ikoyi.cursor.length / 2))),
        'a truncated cursor',
      );
      for (const cursor of ['abc\u0000def', 'A'.repeat(2049), '\u{1F642}']) {
        const response = await on(IKOYI.id, cursor);
        expectError(response, 400, 'validation_failed');
        expectNoStore(response, 'an absurd cursor');
      }
      for (const limit of ['0', '101', 'ten', '1.5']) {
        expectError(
          await accountTimeline(AGENT_1, IKOYI.id, [['limit', limit]]),
          400,
          'validation_failed',
        );
      }
      expectStatus(
        await on(IKOYI.id, ikoyi.cursor),
        200,
        'control: the cursor works where it was issued',
      );
    });
  });

  // =========================================================================
  // 5. Scope and errors (A6).
  // =========================================================================

  describe('scope and errors', () => {
    it('another programme, another tenant, nowhere, a non-uuid id and a user with no programme are one 404, byte for byte, no-store', async () => {
      const control = await accountTimeline(AGENT_1, IKOYI.id);
      expectStatus(control, 200, 'control: a reachable account');
      const nowhere = await accountTimeline(AGENT_1, NOWHERE);
      expectError(nowhere, 404, 'not_found');
      const cases: [string, request.Response][] = [
        ['another programme', await accountTimeline(AGENT_1, SABON.id)],
        ['another tenant', await accountTimeline(AGENT_1, WESTLANDS.id)],
        ['no programme at all', await accountTimeline(NO_PROGRAMME, IKOYI.id)],
        ['out of reach, upper case', await accountTimeline(AGENT_1, SABON.id.toUpperCase())],
        ['not a uuid', await accountTimelineRaw(AGENT_1, 'not-a-uuid')],
        ['a uuid and a digit', await accountTimelineRaw(AGENT_1, `${SABON.id}0`)],
        ['a uuid without dashes', await accountTimelineRaw(AGENT_1, SABON.id.replace(/-/g, ''))],
        ['a NUL', await accountTimelineRaw(AGENT_1, '%00')],
        ['SQL', await accountTimelineRaw(AGENT_1, encodeURIComponent("1' OR '1'='1"))],
      ];
      for (const [label, response] of cases) {
        expectError(response, 404, 'not_found');
        expect(response.text, `${label}: not the same bytes as nowhere`).toBe(nowhere.text);
        expectNoStore(response, label);
      }
      expectNoStore(nowhere, 'nowhere');
      const getNowhere = await getAccount(AGENT_1, NOWHERE);
      expectError(getNowhere, 404, 'not_found');
      expect(nowhere.text, 'the timeline is no second oracle beside getAccount').toBe(
        getNowhere.text,
      );
    });

    it('order: 404 before 400; a read has no 403, so every reader set gets 200', async () => {
      for (const minute of ['1', '2']) {
        await plantEvent({
          objectId: SABON.id,
          programmeId: PROGRAMME_A2,
          occurredAt: `2026-04-24T10:0${minute}:00.000Z`,
          actorUserId: null,
          changes: [named('tier')],
        });
      }
      const sabon = await firstCursor(
        () => accountTimeline(SUPERVISOR, SABON.id, [['limit', '1']]),
        'Sabon, by the supervisor',
      );
      expectStatus(await accountTimeline(AGENT_1, IKOYI.id), 200, 'control');
      const nowhere = (await accountTimeline(AGENT_1, NOWHERE)).text;
      for (const [label, response] of [
        [
          'out of reach, a malformed cursor',
          await accountTimeline(AGENT_1, SABON.id, [['cursor', 'not-a-cursor']]),
        ],
        ['out of reach, limit 0', await accountTimeline(AGENT_1, SABON.id, [['limit', '0']])],
        [
          'out of reach, its own cursor',
          await accountTimeline(AGENT_1, SABON.id, [
            ['limit', '1'],
            ['cursor', sabon.cursor],
          ]),
        ],
        ['nowhere, limit 101', await accountTimeline(AGENT_1, NOWHERE, [['limit', '101']])],
        [
          'not a uuid, limit 0',
          await request(server()).get(`${ACCOUNTS}/not-a-uuid/timeline?limit=0`).set(AGENT_1),
        ],
      ] as const) {
        expectError(response, 404, 'not_found');
        expect(response.text, label).toBe(nowhere);
      }
      const bad = await accountTimeline(AGENT_1, IKOYI.id, [['limit', '0']]);
      expectError(bad, 400, 'validation_failed');
      expectNoStore(bad, 'a 400');

      for (const key of ['qa_analyst', 'client_portal', 'team_lead', 'programme_manager']) {
        await assign(USER_A_AGENT_1, PROGRAMME_A1, key);
        expect(await readAccount(AGENT_1, IKOYI.id, key), `${key} reads it`).toHaveLength(1);
      }
    });

    it('no session is 401, one body for any id; a scope header is 400, one body in reach or out', async () => {
      expectStatus(await accountTimeline(AGENT_1, IKOYI.id), 200, 'control');
      const unauthenticated = [
        await accountTimeline({}, IKOYI.id),
        await accountTimeline({}, NOWHERE),
        await accountTimelineRaw({}, 'not-a-uuid'),
      ].map((response) => {
        expectError(response, 401, 'not_authenticated');
        return response.text;
      });
      expect(new Set(unauthenticated).size, '401 tells nothing about the id').toBe(1);

      for (const [header, value] of [
        ['x-kasuwa-programme-ids', `{${PROGRAMME_A2}}`],
        ['x-kasuwa-programme-id', PROGRAMME_A2],
        ['x-kasuwa-scope', 'all'],
      ] as const) {
        const bodies = [
          await accountTimeline(AGENT_1, IKOYI.id).set(header, value),
          await accountTimeline(AGENT_1, SABON.id).set(header, value),
          await accountTimeline(AGENT_1, NOWHERE).set(header, value),
        ].map((response) => {
          expectError(response, 400, 'validation_failed');
          return response.text;
        });
        expect(new Set(bodies).size, `${header}: one body in reach or out`).toBe(1);
      }
    });
  });

  // =========================================================================
  // 6. The client portal (A7, D-P26: parity only).
  // =========================================================================

  describe('client_portal: parity with the contact timeline (D-P26 is open)', () => {
    it('client_portal sees what the agent set sees on both timelines, and an activity is the same item on both', async () => {
      const SUBJECT = `T0080 portal subject ${RUN}`;
      const BODY = `T0080 portal body ${RUN}`;
      await plantTask(id80('a0050'), {
        contactId: AMAKA.id,
        accountId: IKOYI.id,
        subject: SUBJECT,
        body: BODY,
      });
      await plantEvent({
        objectId: IKOYI.id,
        occurredAt: '2026-04-25T10:00:00.000Z',
        actorUserId: USER_A_SUPERVISOR,
        changes: [named('tier')],
      });
      await plantEvent({
        objectType: 'contact',
        objectId: AMAKA.id,
        occurredAt: '2026-04-25T10:00:00.000Z',
        actorUserId: USER_A_SUPERVISOR,
        changes: [{ field: 'status', before: 'new', after: 'contacted', redacted: false }],
      });
      const agentAccount = await readAccount(AGENT_1, IKOYI.id, 'agent, account');
      const agentContact = await readContact(AGENT_1, AMAKA.id, 'agent, contact');

      await assign(USER_A_AGENT_1, PROGRAMME_A1, 'client_portal');
      const portalAccount = await readAccount(AGENT_1, IKOYI.id, 'portal, account');
      const portalContact = await readContact(AGENT_1, AMAKA.id, 'portal, contact');
      expect(portalAccount, 'no new rule on the account timeline').toEqual(agentAccount);
      expect(portalContact, 'the contact timeline is unchanged for the portal').toEqual(
        agentContact,
      );
      const pick = (items: Json[]) => items.find((item) => item.activityId === id80('a0050'));
      expect(pick(portalAccount), 'control: the activity is shown').toBeDefined();
      expect(withoutId(pick(portalAccount)), 'one activity, one item, on both timelines').toEqual(
        withoutId(pick(portalContact)),
      );
    });
  });
});

function withoutKey(item: Json, key: string): Json {
  return Object.fromEntries(Object.entries(item).filter(([name]) => name !== key));
}
