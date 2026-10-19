import type { Page, Request, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { TENANT_A } from '@kasuwa/db';
import { CUSTOM_FIELDS_PATH, CustomFieldsServer, type CustomFieldsSetup } from './custom-values-mock';

/**
 * The account record half of `docs/api/records.openapi.yaml` — `getAccount`,
 * `updateAccount`, `listAccountContacts`, `listAccountTimeline`,
 * `createActivity`, `updateActivity` and `listMyProgrammes` — plus
 * `getCurrentUser` (`docs/api/auth.openapi.yaml`), served into the browser by
 * Playwright for T-0063 (the P05 account record, frame 04).
 *
 * ---------------------------------------------------------------------------
 * READ FROM THE CONTRACT AT RUN TIME, AND EVERY ANSWER CHECKED AGAINST IT
 *
 * The Account and Contact property lists, every request-body schema, the
 * account timeline item union, the enums and every error body come out of the
 * YAML when this module loads. Two checks keep the mock honest:
 *
 *   - At load, every account, contact row and timeline item declared below is
 *     validated against its schema. A contract change this file contradicts
 *     fails here, loudly, before any journey runs.
 *   - At run time, EVERY body the mock answers with is validated against the
 *     schema the contract declares for that operation and status, strictly: a
 *     property the schema does not name is a fault even where the contract
 *     leaves the object open, so the mock can never hand the screen a field
 *     (a `children` list, a rollup, a count) the real API does not serve. A
 *     fault is the MOCK's, recorded in `mockFaults`, which `afterEach` in the
 *     spec requires to be empty, separately from the screen's `violations`.
 *
 * WHAT IS NOT IN THE CONTRACT, AND IS THEREFORE DECLARED HERE
 *
 *   - Accounts. The contract publishes ONE example account (`Ọjà Foods Ltd`,
 *     from `listAccounts`). The others are DERIVED from it by spreading it and
 *     overriding named properties. Names, numbers and people are invented.
 *     The example is placed at level 2 of a five-level chain so the hierarchy
 *     has something to draw.
 *   - Contacts. The contract's one example contact (Adaeze Okonkwo) is the
 *     first row of the example account's contacts; the rest derive from it.
 *   - Timelines. The contract publishes one three-item example page for
 *     `listAccountTimeline`. It is used verbatim as the newest items of
 *     ACCOUNT_FULL's timeline; the rest are declared in the same shapes.
 *   - The caller. ME is the example account's owner (Kemi Balogun), learnt by
 *     the screen from `GET /api/v1/auth/me`.
 *   - What the caller may do. No capability read exists (D-L84), so the
 *     journey tells the mock the caller's permission set, as `role`:
 *       admin  — `account.write` and `activity.write` (D-L69: account writes
 *                are admin-only);
 *       agent  — `activity.write` only (D-P18): updateAccount is 403, an
 *                activity may be logged and completed, reassigned only to ME;
 *       reader — `qa_analyst`: every write is 403 not_permitted.
 *     The default is `agent`: a BPO agent is the common caller.
 *   - Read-only fields. A field the caller may READ but not EDIT is served
 *     normally and sending it is `403 field_not_editable`; READ_ONLY below
 *     says which. A form that round-trips unchanged fields is refused here,
 *     exactly as the API would.
 *
 * WHAT THE MOCK ENFORCES ON EVERY REQUEST (recorded as `violations`, the
 * SCREEN's fault; `afterEach` in the spec fails a test that has any)
 *
 *   - Only the operations above. `listAccounts`, `listContacts`, `getContact`,
 *     a contact's timeline, `getAccountMap` and anything else under
 *     `/api/v1/` are violations: the record reads its own account, its
 *     ancestors, its contacts and its timeline, and nothing else. In
 *     particular there is no operation that lists an account's CHILDREN
 *     (`Account` says so: "the hierarchy is the one parentAccountId link"),
 *     and scanning `listAccounts` for them is refused here.
 *   - No request header names a programme or a tenant (CLAUDE.md 2.2).
 *   - getAccount: the record the journey opened (`recordId`), or a
 *     `parentAccountId` the mock has served. Never more than FOUR ancestor
 *     reads per record (D-L74: a hierarchy is at most five levels deep), even
 *     when the served chain claims to go on (`hierarchyCycle`).
 *   - listAccountTimeline: only `cursor` and `limit`, `limit` in 1..100; a
 *     cursor echoed exactly as served, for the account it was served for.
 *   - listAccountContacts: only `sort` (its enum), `cursor` and `limit`; a
 *     cursor echoed exactly, for the account AND sort it was served for.
 *   - updateAccount: closed `UpdateAccountRequest`; an account the screen was
 *     served; the `version` it was last served; no field the account lists in
 *     `withheldFields`.
 *   - createActivity: closed `CreateActivityRequest`; `accountId` is an
 *     account the screen was served and NO `contactId` (logged from the
 *     account record, it is the account's activity); `dueAt` only on a task,
 *     UTC with a `Z`; `subject`/`body` never `""`.
 *   - updateActivity: closed `UpdateActivityRequest`; an activity the screen
 *     was served; only a task completed; a `version` the screen was actually
 *     served for THAT activity, on a timeline item (T-0080) or a 201/200. A
 *     stale but served version is not a violation: it is a 409.
 *
 * SERVER BEHAVIOUR THE SCREEN DEPENDS ON, IMPLEMENTED AS THE CONTRACT SAYS
 *
 *   - Out of scope is 404 with ONE body. On getAccount, updateAccount and
 *     listAccountContacts a non-uuid id is 400; on listAccountTimeline it is
 *     the same 404 (T-0080).
 *   - Field security omits, never nulls; `owner` goes with `ownerUserId`.
 *   - listAccountContacts answers 400 `field_withheld` at `accountId` when the
 *     CONTACT matrix of the account's programme withholds `accountId`
 *     (PROGRAMME_TWO here), and never returns rows in that case.
 *   - listAccountContacts pages hold AT MOST FOUR rows, whatever `limit` says.
 *     Legal (the contract promises full pages for the timelines, not for
 *     contact lists) and deliberate: a screen that decides "last page" from
 *     `data.length < limit` rather than `nextCursor` loses rows here.
 *   - The timeline is newest first, ties by item id descending; a page with a
 *     cursor holds `limit` items (default 25). Account field changes are
 *     always `{ field, redacted: true }`; there is no consent item.
 *   - Writes apply: updateAccount advances `version` and adds one redacted
 *     item per field changed; createActivity adds an activity item at the top;
 *     completing a task changes its item in place, version included.
 *   - `staleTask`: somebody else reassigns ITEM_TASK just before the screen's
 *     first updateActivity for it lands, so its version moves 3 -> 4 and that
 *     write is `409 stale_write`. A re-read of the timeline serves 4.
 *
 * CUSTOM FIELDS (T-0091, lead edit). `listCustomFields` is one of the
 * operations above, answered by `custom-values-mock.ts` (its answers are
 * checked against admin.openapi.yaml there, not by `answerProblems`). With no
 * `customFields` option it lists nothing and no row carries `custom`, so the
 * T-0063 journeys see the record unchanged. With one, getAccount and
 * updateAccount carry the projected `custom` and `custom.<key>` paths,
 * updateAccount's `custom` is checked and merged per key there (after the
 * 403s, before the 400s and the 409), and createActivity's `custom` is
 * checked and stored for the activity object.
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

/** A schema node and the document its local `$ref`s resolve against. */
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

const ACCOUNTS_PATH = '/api/v1/accounts';
const ACTIVITIES_PATH = '/api/v1/activities';
const PROGRAMMES_PATH = '/api/v1/me/programmes';
const ME_PATH = '/api/v1/auth/me';

/** Contract path templates, for looking up what each answer must be. */
const OP = {
  getAccount: [`${ACCOUNTS_PATH}/{accountId}`, 'get'],
  updateAccount: [`${ACCOUNTS_PATH}/{accountId}`, 'patch'],
  listAccountContacts: [`${ACCOUNTS_PATH}/{accountId}/contacts`, 'get'],
  listAccountTimeline: [`${ACCOUNTS_PATH}/{accountId}/timeline`, 'get'],
  createActivity: [ACTIVITIES_PATH, 'post'],
  updateActivity: [`${ACTIVITIES_PATH}/{activityId}`, 'patch'],
  listMyProgrammes: [PROGRAMMES_PATH, 'get'],
  getCurrentUser: [ME_PATH, 'get'],
} as const;

export type Operation = keyof typeof OP;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** RFC 3339 in UTC, with a `Z`: "UTC, with a Z" is the contract's rule for every time. */
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

// ---------------------------------------------------------------------------
// Validation: a JSON-Schema subset, exactly what these bodies and answers use
// ---------------------------------------------------------------------------

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** Every property name an object schema declares, its `allOf` parts included. */
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
    if (typeof spec.minProperties === 'number' && Object.keys(value).length < spec.minProperties) {
      problems.push(`${where} has fewer than ${spec.minProperties} properties`);
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

// ---------------------------------------------------------------------------
// The contract's own vocabularies
// ---------------------------------------------------------------------------

export const ACCOUNT_TIERS: readonly string[] = enumOf('AccountTier');
export const ACTIVITY_TYPES: readonly string[] = enumOf('ActivityType');
/** The Account fields an account timeline item may name (AccountFieldChangedItem). */
export const ACCOUNT_TIMELINE_FIELDS: readonly string[] = enumOf('AccountFieldChangedItem', 'properties', 'field');
const CONTACT_SORT_SCHEMA = (at(CONTRACT, 'paths', OP.listAccountContacts[0], 'get', 'parameters') as unknown[])
  .map((raw) => deref(raw, CONTRACT).node as Json)
  .find((parameter) => parameter.name === 'sort')?.schema as { enum: string[]; default?: string };
export const CONTACT_SORTS: readonly string[] = CONTACT_SORT_SCHEMA.enum.map(String);
/**
 * The contract's default for listAccountContacts' `sort`, read from the YAML
 * rather than invented: `-createdAt` since T-0124 (D-L180 I5, D-L183).
 */
export const CONTACT_SORT_DEFAULT: string = String(CONTACT_SORT_SCHEMA.default ?? '-createdAt');

const ACCOUNT_PROPERTIES: readonly string[] = Object.keys(at(schema('Account'), 'properties') as Json);
const ACCOUNT_REQUIRED = at(schema('Account'), 'required') as string[];
const CONTACT_PROPERTIES: readonly string[] = [
  ...Object.keys(at(schema('Contact'), 'properties') as Json),
  ...Object.keys(at(schema('ContactPendingProperties'), 'properties') as Json),
];
const CONTACT_LIVE: readonly string[] = Object.keys(at(schema('Contact'), 'properties') as Json);

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

/** The contract's own example programme (`Bank X Collections`). */
export const PROGRAMME_ONE = clone(
  at(CONTRACT, 'paths', PROGRAMMES_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', '0'),
) as Programme;

/**
 * A second programme of the same tenant whose matrices are stricter: the
 * Account matrix withholds phones, tier, the owner and the parent link; the
 * Contact matrix withholds `accountId` (so listAccountContacts is 400
 * field_withheld there); the Activity matrix withholds subject and body.
 */
export const PROGRAMME_TWO: Programme = {
  id: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a02',
  name: 'Lagos Water Customer Care',
};

const ACCOUNT_EXAMPLE = clone(
  at(CONTRACT, 'paths', ACCOUNTS_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', '0'),
) as AccountRow;

const CONTACT_EXAMPLE = clone(
  at(CONTRACT, 'paths', '/api/v1/contacts', 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', '0'),
) as ContactRow;

/** The caller: the example account's owner. */
export const ME: Person = clone(ACCOUNT_EXAMPLE.owner as Person);

/** `getCurrentUser`'s body for ME. The auth contract has no example; every required key is set. */
export const CURRENT_USER: Json = {
  id: ME.id,
  tenantId: TENANT_A,
  email: 'kemi.balogun@example.ng',
  displayName: ME.displayName,
  locale: 'en-NG',
};

/** Another member of both programmes. */
export const OTHER_OWNER: Person = { id: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02', displayName: 'Tunde Adeyemi' };

/** Somebody who has left the programme. Still named on what they did (D-L81). */
export const FORMER_MEMBER: Person = { id: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e03', displayName: 'Ifeoma Nwosu' };

/** Who `ownerUserId` may name in either programme (D-L67). The former member is not one. */
const MEMBERS: readonly Person[] = [ME, OTHER_OWNER];

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface AccountRow {
  id: string;
  programmeId: string;
  name: string;
  version: number;
  withheldFields: string[];
  [property: string]: unknown;
}

function checkAccount(row: AccountRow): AccountRow {
  const unknown = Object.keys(row).filter((key) => !ACCOUNT_PROPERTIES.includes(key));
  const missing = ACCOUNT_REQUIRED.filter((key) => !(key in row));
  const unaccounted = ACCOUNT_PROPERTIES.filter((key) => !(key in row) && !row.withheldFields.includes(key));
  const leaked = row.withheldFields.filter((field) => field in row);
  const apart = row.withheldFields.includes('ownerUserId') !== row.withheldFields.includes('owner');
  const owner = row.owner as { id?: string } | null | undefined;
  const ownerMismatch = 'ownerUserId' in row && (row.ownerUserId === null ? owner !== null : owner?.id !== row.ownerUserId);
  const typed = validateBody(row, schema('Account'), `account ${row.id}`, CONTRACT, true);
  const problems = [
    unknown.length > 0 ? `unknown ${unknown.join(',')}` : '',
    missing.length > 0 ? `missing ${missing.join(',')}` : '',
    unaccounted.length > 0 ? `neither served nor withheld ${unaccounted.join(',')}` : '',
    leaked.length > 0 ? `withheld but present ${leaked.join(',')}` : '',
    apart ? 'owner and ownerUserId withheld apart' : '',
    ownerMismatch ? 'owner disagrees with ownerUserId' : '',
    ...typed,
  ].filter((problem) => problem !== '');
  if (problems.length > 0) {
    throw new Error(`account ${row.id} disagrees with ${RECORDS_CONTRACT_SOURCE}: ${problems.join('; ')}`);
  }
  return row;
}

function ownedBy(person: Person | null): { ownerUserId: string | null; owner: Person | null } {
  return person === null ? { ownerUserId: null, owner: null } : { ownerUserId: person.id, owner: clone(person) };
}

function deriveAccount(overrides: Partial<AccountRow> & { id: string; name: string }, withheld: readonly string[] = []): AccountRow {
  const row: AccountRow = { ...clone(ACCOUNT_EXAMPLE), ...overrides, withheldFields: [...withheld] };
  for (const field of withheld) {
    delete row[field];
  }
  return checkAccount(row);
}

const ACCOUNT_ID = (n: string): string => `5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c${n}`;

/** Level 1: the group at the top of the example account's hierarchy. */
export const ACCOUNT_GROUP = deriveAccount({
  id: ACCOUNT_ID('10'),
  version: 4,
  name: 'Ọjà Group Holdings',
  industry: 'Conglomerate',
  tier: 'enterprise',
  tags: [],
  phones: [{ type: 'work', e164: '+2348030000110' }],
  lga: 'Lagos Island',
  parentAccountId: null,
  createdAt: '2026-09-01T07:00:00.000Z',
  updatedAt: '2026-09-01T07:00:00.000Z',
});

/**
 * The record most journeys open: the contract's example account, verbatim but
 * for its parent (level 2, under ACCOUNT_GROUP). Owned by ME, in PROGRAMME_ONE.
 * Its timeline begins with the contract's example page; it has six contacts.
 */
export const ACCOUNT_FULL = deriveAccount({ id: ACCOUNT_EXAMPLE.id, name: ACCOUNT_EXAMPLE.name, parentAccountId: ACCOUNT_GROUP.id });

/** Level 3. */
export const ACCOUNT_REGION = deriveAccount({
  id: ACCOUNT_ID('22'),
  version: 1,
  name: 'Ọjà Foods South-West',
  tags: [],
  phones: [],
  parentAccountId: ACCOUNT_FULL.id,
});

/** Level 4. */
export const ACCOUNT_BRANCH = deriveAccount({
  id: ACCOUNT_ID('23'),
  version: 1,
  name: 'Ọjà Foods Lagos Mainland',
  tags: [],
  phones: [],
  parentAccountId: ACCOUNT_REGION.id,
});

/** Level 5, the deepest the database allows (D-L74): four ancestors to draw. */
export const ACCOUNT_DEEP = deriveAccount({
  id: ACCOUNT_ID('24'),
  version: 1,
  name: 'Ọjà Foods Ikeja Outlet',
  tier: 'sme',
  tags: ['Outlet'],
  phones: [{ type: 'work', e164: '+2348030000124' }],
  parentAccountId: ACCOUNT_BRANCH.id,
});

/** Root first, the record last: what ACCOUNT_DEEP's breadcrumb draws. */
export const DEEP_CHAIN: readonly AccountRow[] = [ACCOUNT_GROUP, ACCOUNT_FULL, ACCOUNT_REGION, ACCOUNT_BRANCH, ACCOUNT_DEEP];

/**
 * In PROGRAMME_TWO: phones, tier, the owner and the parent link withheld
 * (omitted and listed). Its contacts cannot be listed (field_withheld) and its
 * activity items carry no subject or body.
 */
export const ACCOUNT_LOCKED = deriveAccount(
  {
    id: ACCOUNT_ID('02'),
    programmeId: PROGRAMME_TWO.id,
    version: 5,
    name: 'Surulere Water Kiosks',
    industry: 'Utilities',
    tags: ['Water arrears'],
    state: 'Lagos',
    lga: 'Surulere',
  },
  ['phones', 'tier', 'ownerUserId', 'owner', 'parentAccountId'],
);

/** Every nullable property null and every list empty, top level: "no value", never a lock. No contacts, no history. */
export const ACCOUNT_NULLS = deriveAccount({
  id: ACCOUNT_ID('03'),
  version: 1,
  name: 'Kano Grains Co.',
  ...ownedBy(null),
  industry: null,
  tier: null,
  tags: [],
  phones: [],
  state: null,
  lga: null,
  parentAccountId: null,
  createdAt: '2026-10-05T08:00:00.000Z',
  updatedAt: '2026-10-05T08:00:00.000Z',
});

/** A long history: more items than any legal `limit`, so it always has a second page. */
export const ACCOUNT_LONG = deriveAccount({
  id: ACCOUNT_ID('05'),
  version: 60,
  name: 'Abuja Logistics Hub',
  tags: [],
  phones: [],
  state: 'FCT',
  lga: 'Garki',
  parentAccountId: null,
});

export const HOSTILE_NAME = '<img src=x onerror="window.__kasuwaXss=1">Bùkọ́lá <b>Stores</b>';
export const HOSTILE_TAG = '<i>VIP</i>';
export const HOSTILE_SUBJECT = '<img src=y onerror="window.__kasuwaXss=3">Promise to pay';
export const HOSTILE_BODY = '<script>window.__kasuwaXss=2</script>Will pay on <b>Friday</b>';
export const HOSTILE_CONTACT_NAME = '<img src=z onerror="window.__kasuwaXss=4">Ẹmẹka <b>Obi</b>';

/** Markup in record data: drawn as text, never parsed. */
export const ACCOUNT_HOSTILE = deriveAccount({
  id: ACCOUNT_ID('06'),
  version: 1,
  name: HOSTILE_NAME,
  tags: [HOSTILE_TAG],
  phones: [],
  parentAccountId: null,
});

/** A real-looking id the caller cannot reach (another programme or tenant): 404, one body. */
export const OUT_OF_SCOPE_ID = ACCOUNT_ID('99');
/** An id that names nothing: the same 404. */
export const NO_SUCH_ID = '00000000-0000-4000-8000-00000000dead';

const ALL_ACCOUNTS: readonly AccountRow[] = [
  ACCOUNT_GROUP,
  ACCOUNT_FULL,
  ACCOUNT_REGION,
  ACCOUNT_BRANCH,
  ACCOUNT_DEEP,
  ACCOUNT_LOCKED,
  ACCOUNT_NULLS,
  ACCOUNT_LONG,
  ACCOUNT_HOSTILE,
];

/** Readable but not editable for the caller (field security's `read` level). Sending one is 403. */
const READ_ONLY: Readonly<Record<string, readonly string[]>> = {
  [ACCOUNT_FULL.id]: ['tier', 'tags'],
};

/** Activity fields withheld in each programme (the activity object's matrix). */
const ACTIVITY_WITHHELD: Readonly<Record<string, readonly string[]>> = {
  [PROGRAMME_ONE.id]: [],
  [PROGRAMME_TWO.id]: ['subject', 'body'],
};

/** Programmes whose CONTACT matrix withholds `accountId`: listAccountContacts is 400 there. */
const CONTACT_ACCOUNT_WITHHELD: ReadonlySet<string> = new Set([PROGRAMME_TWO.id]);

// ---------------------------------------------------------------------------
// Contacts of an account
// ---------------------------------------------------------------------------

export interface ContactRow {
  id: string;
  programmeId: string;
  displayName: string;
  version: number;
  withheldFields: string[];
  [property: string]: unknown;
}

function checkContact(row: ContactRow): ContactRow {
  const unknown = Object.keys(row).filter((key) => !CONTACT_PROPERTIES.includes(key));
  const unaccounted = CONTACT_LIVE.filter((key) => !(key in row) && !row.withheldFields.includes(key));
  const leaked = row.withheldFields.filter((field) => field in row);
  const typed = validateBody(row, schema('Contact'), `contact ${row.id}`, CONTRACT, true);
  const problems = [
    unknown.length > 0 ? `unknown ${unknown.join(',')}` : '',
    unaccounted.length > 0 ? `neither served nor withheld ${unaccounted.join(',')}` : '',
    leaked.length > 0 ? `withheld but present ${leaked.join(',')}` : '',
    ...typed,
  ].filter((problem) => problem !== '');
  if (problems.length > 0) {
    throw new Error(`contact ${row.id} disagrees with ${RECORDS_CONTRACT_SOURCE}: ${problems.join('; ')}`);
  }
  return row;
}

/**
 * A contact of `account`, derived from the contract's example contact. In
 * PROGRAMME_ONE the Contact matrix withholds `emails` (as the example does) and
 * not the account link, which listAccountContacts would otherwise refuse.
 */
function contactOf(account: AccountRow, overrides: Partial<ContactRow> & { id: string; displayName: string }): ContactRow {
  const row: ContactRow = {
    ...clone(CONTACT_EXAMPLE),
    ...overrides,
    programmeId: account.programmeId,
    accountId: account.id,
    account: { id: account.id, name: account.name },
    withheldFields: ['emails'],
  };
  delete row.emails;
  return checkContact(row);
}

const CONTACT_ID = (n: string): string => `3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e${n}`;

function person(id: string, displayName: string, phone: string, extra: Partial<ContactRow> = {}): Partial<ContactRow> & { id: string; displayName: string } {
  const [givenNames, ...rest] = displayName.split(' ');
  return {
    id,
    displayName,
    givenNames: givenNames ?? null,
    familyName: rest.join(' ') || null,
    companyName: null,
    phones: [{ type: 'mobile', e164: phone }],
    ...extra,
  };
}

const CONTACTS: Readonly<Record<string, readonly ContactRow[]>> = {
  // Served sorted by displayName (the default sort), ties on id.
  [ACCOUNT_FULL.id]: [
    contactOf(ACCOUNT_FULL, { id: CONTACT_EXAMPLE.id, displayName: CONTACT_EXAMPLE.displayName }),
    contactOf(ACCOUNT_FULL, person(CONTACT_ID('11'), 'Bola Adewale', '+2348030000111', { status: 'customer', consentState: 'pending' })),
    contactOf(ACCOUNT_FULL, person(CONTACT_ID('12'), 'Chinedu Okeke', '+2348030000112', { ...ownedBy(OTHER_OWNER), status: 'qualified' })),
    contactOf(ACCOUNT_FULL, person(CONTACT_ID('13'), 'Danjuma Bello', '+2348030000113', { status: null, whatsappOptIn: false })),
    contactOf(ACCOUNT_FULL, person(CONTACT_ID('14'), 'Efua Mensah', '+2348030000114', { preferredLanguage: 'tw' })),
    contactOf(ACCOUNT_FULL, person(CONTACT_ID('15'), 'Fatima Sule', '+2348030000115', { ...ownedBy(null), consentState: 'withdrawn' })),
  ],
  [ACCOUNT_HOSTILE.id]: [contactOf(ACCOUNT_HOSTILE, person(CONTACT_ID('16'), HOSTILE_CONTACT_NAME, '+2348030000116'))],
};

/** At most this many contact rows on one page, whatever `limit` asks for. */
export const CONTACT_PAGE_CAP = 4;

/** Every contact listAccountContacts serves for an account, in default order. */
export function contactsOf(accountId: string): readonly ContactRow[] {
  return CONTACTS[accountId] ?? [];
}

// ---------------------------------------------------------------------------
// Timelines
// ---------------------------------------------------------------------------

export interface TimelineItem {
  id: string;
  type: 'field_changed' | 'activity';
  occurredAt: string;
  actor: Person | null;
  [property: string]: unknown;
}

const ACCOUNT_ITEM_SCHEMA = schema('AccountTimelineItem');

function checkItem(item: TimelineItem): TimelineItem {
  const problems = validateBody(item, ACCOUNT_ITEM_SCHEMA, `item ${item.id}`, CONTRACT, true);
  if (problems.length > 0) {
    throw new Error(`account timeline item ${item.id} disagrees with ${RECORDS_CONTRACT_SOURCE}: ${problems.join('; ')}`);
  }
  return item;
}

function actorOf(who: Person | null): Person | null {
  return who === null ? null : { id: who.id, displayName: who.displayName };
}

/** A field change: by name only, always (D-L78, D-L90). */
function change(id: string, occurredAt: string, actor: Person | null, field: string): TimelineItem {
  return checkItem({ id, type: 'field_changed', occurredAt, actor: actorOf(actor), field, redacted: true });
}

function activityItem(
  id: string,
  occurredAt: string,
  actor: Person | null,
  activity: { activityId: string; activityType: string; subject?: string | null; body?: string | null; dueAt?: string | null; startsAt?: string | null; endsAt?: string | null; completedAt?: string | null; version: number },
): TimelineItem {
  return checkItem({ id, type: 'activity', occurredAt, actor: actorOf(actor), ...clone(activity) });
}

const TIMELINE_EXAMPLE = at(
  CONTRACT,
  'paths',
  OP.listAccountTimeline[0],
  'get',
  'responses',
  '200',
  'content',
  'application/json',
  'example',
) as { data: Json[] };

/** The contract's example page, verbatim: the newest three items of ACCOUNT_FULL. */
const EXAMPLE_ITEMS = TIMELINE_EXAMPLE.data.map((item) => checkItem(clone(item) as TimelineItem));

function exampleItem(type: string, field?: string): TimelineItem {
  const found = EXAMPLE_ITEMS.find((item) => item.type === type && (field === undefined || item.field === field));
  if (found === undefined) {
    throw new Error(`${RECORDS_CONTRACT_SOURCE}: the account timeline example has no ${type} ${field ?? ''} item`);
  }
  return found;
}

/** tier, by ME, by name only. The current tier is never drawn as if it were the change. */
export const ITEM_TIER = exampleItem('field_changed', 'tier');
/** phones, by ME, in the same event as ITEM_TIER. Never a number. */
export const ITEM_PHONES = exampleItem('field_changed', 'phones');
/**
 * An open task logged by the system, version 3, due 2026-10-02T15:00Z (16:00
 * in Lagos). Its version is served ONLY on the timeline: completing it is the
 * T-0080 journey.
 */
export const ITEM_TASK = exampleItem('activity');

export const ITEM_OWNER = change('ti_a2Lp5sVcR8', '2026-10-02T11:00:00.000Z', OTHER_OWNER, 'ownerUserId');
export const ITEM_PARENT = change('ti_a3Kq9wBnT2', '2026-10-01T10:00:00.000Z', ME, 'parentAccountId');
/** A note by somebody who has since left the programme: still named. */
export const ITEM_NOTE = activityItem('ti_a8Gb3hWyE5', '2026-09-29T10:30:00.000Z', FORMER_MEMBER, {
  activityId: '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4d02',
  activityType: 'note',
  subject: null,
  body: 'Deliveries go to the Ikeja depot, gate B.',
  dueAt: null,
  startsAt: null,
  endsAt: null,
  completedAt: null,
  version: 1,
});
export const ITEM_CALL = activityItem('ti_a6Kq1rZtB9', '2026-09-28T08:00:00.000Z', OTHER_OWNER, {
  activityId: '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4d04',
  activityType: 'call',
  subject: 'Quarterly review call',
  body: null,
  dueAt: null,
  startsAt: null,
  endsAt: null,
  completedAt: null,
  version: 1,
});
/** A task already completed: no complete control. */
export const ITEM_DONE_TASK = activityItem('ti_a4Jm9pXsA3', '2026-09-25T10:00:00.000Z', ME, {
  activityId: '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4d03',
  activityType: 'task',
  subject: 'Send the Q4 price list',
  body: null,
  dueAt: '2026-09-26T09:00:00.000Z',
  startsAt: null,
  endsAt: null,
  completedAt: '2026-09-26T08:15:00.000Z',
  version: 2,
});
export const ITEM_TAGS = change('ti_a1Ns7tUuC2', '2026-09-20T12:00:00.000Z', ME, 'tags');
export const ITEM_STATE = change('ti_a5Pv2wQxD4', '2026-09-15T09:00:00.000Z', OTHER_OWNER, 'state');
export const ITEM_LGA = change('ti_a5Pv2wQxD1', '2026-09-15T09:00:00.000Z', OTHER_OWNER, 'lga');
/** Creation renders like an update (D-L81): one item per field set, by the system. */
export const ITEM_CREATED_NAME = change('ti_a9Ty6aNbG8', '2026-09-01T07:00:00.000Z', null, 'name');
export const ITEM_CREATED_INDUSTRY = change('ti_a9Ty6aNbG1', '2026-09-01T07:00:00.000Z', null, 'industry');

/** Newest first; ties by id descending (code-unit order), as the contract orders them. */
function ordered(items: readonly TimelineItem[]): TimelineItem[] {
  return [...items].sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/** How many items the longest default timeline holds. A first page smaller than this fails the journeys. */
export const DEFAULT_TIMELINE_MAX = 20;

export const LONG_OLDEST_SUBJECT = 'First visit to the hub logged';
export const LONG_TIMELINE_LENGTH = 105;

function longTimeline(): TimelineItem[] {
  const base = Date.parse('2026-10-06T12:00:00.000Z');
  const items: TimelineItem[] = [];
  for (let index = 0; index < LONG_TIMELINE_LENGTH - 1; index += 1) {
    // Groups of three share one `occurredAt`: page edges fall inside events.
    const occurredAt = new Date(base - Math.floor(index / 3) * 60_000).toISOString();
    const field = ACCOUNT_TIMELINE_FIELDS[index % ACCOUNT_TIMELINE_FIELDS.length] ?? 'name';
    items.push(change(`ti_L${String(999 - index).padStart(3, '0')}`, occurredAt, index % 4 < 2 ? ME : OTHER_OWNER, field));
  }
  items.push(
    activityItem('ti_L000', '2026-01-01T09:00:00.000Z', ME, {
      activityId: '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4d09',
      activityType: 'note',
      subject: LONG_OLDEST_SUBJECT,
      body: null,
      dueAt: null,
      startsAt: null,
      endsAt: null,
      completedAt: null,
      version: 1,
    }),
  );
  return ordered(items);
}

const TIMELINES: Readonly<Record<string, readonly TimelineItem[]>> = {
  [ACCOUNT_FULL.id]: ordered([
    ...EXAMPLE_ITEMS,
    ITEM_OWNER,
    ITEM_PARENT,
    ITEM_NOTE,
    ITEM_CALL,
    ITEM_DONE_TASK,
    ITEM_TAGS,
    ITEM_STATE,
    ITEM_LGA,
    ITEM_CREATED_NAME,
    ITEM_CREATED_INDUSTRY,
  ]),
  [ACCOUNT_LOCKED.id]: ordered([
    change('ti_b2Wc8dLeH3', '2026-10-04T09:00:00.000Z', OTHER_OWNER, 'tags'),
    // The call's subject and body are withheld in PROGRAMME_TWO: omitted, never null.
    activityItem('ti_b2Wc8dLeH1', '2026-10-03T15:00:00.000Z', OTHER_OWNER, {
      activityId: '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4d05',
      activityType: 'call',
      dueAt: null,
      startsAt: null,
      endsAt: null,
      completedAt: null,
      version: 1,
    }),
    change('ti_b2Wc8dLeG7', '2026-10-01T08:00:00.000Z', null, 'name'),
  ]),
  [ACCOUNT_NULLS.id]: [],
  [ACCOUNT_GROUP.id]: [change('ti_c1Aa1aAaA1', '2026-09-01T07:00:00.000Z', null, 'name')],
  [ACCOUNT_REGION.id]: [],
  [ACCOUNT_BRANCH.id]: [],
  [ACCOUNT_DEEP.id]: [change('ti_c2Bb2bBbB2', '2026-09-02T07:00:00.000Z', ME, 'name')],
  [ACCOUNT_LONG.id]: longTimeline(),
  [ACCOUNT_HOSTILE.id]: [
    activityItem('ti_d4Ze6gNhK1', '2026-10-05T09:00:00.000Z', ME, {
      activityId: '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4d06',
      activityType: 'note',
      subject: HOSTILE_SUBJECT,
      body: HOSTILE_BODY,
      dueAt: null,
      startsAt: null,
      endsAt: null,
      completedAt: null,
      version: 1,
    }),
  ],
};

for (const [id, items] of Object.entries(TIMELINES)) {
  if (id !== ACCOUNT_LONG.id && items.length > DEFAULT_TIMELINE_MAX) {
    throw new Error(`the ${id} timeline outgrew DEFAULT_TIMELINE_MAX`);
  }
}

/** Every item an account's timeline serves, newest first, as the mock starts. */
export function timelineOf(accountId: string): readonly TimelineItem[] {
  return TIMELINES[accountId] ?? [];
}

export function accountById(id: string): AccountRow {
  const row = ALL_ACCOUNTS.find((candidate) => candidate.id === id);
  if (row === undefined) {
    throw new Error(`no mock account ${id}`);
  }
  return row;
}

/** Everything the mock serves, for checks that tell served record data from UI copy. */
export function servedData(): string {
  return JSON.stringify({
    accounts: ALL_ACCOUNTS,
    contacts: CONTACTS,
    timelines: TIMELINES,
    programmes: [PROGRAMME_ONE, PROGRAMME_TWO],
    me: CURRENT_USER,
  });
}

/** The ids the mock gives the activities the screen logs, in order. */
export const NEW_ACTIVITY_IDS: readonly string[] = [
  '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4d21',
  '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4d22',
  '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4d23',
  '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4d24',
  '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4d25',
  '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4d26',
];

/** How many ancestors a record may have: a hierarchy is at most five levels (D-L74). */
export const MAX_ANCESTORS = 4;

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export type Role = 'admin' | 'agent' | 'reader';

export interface AccountRecordMockOptions {
  /** The record the journey opens. getAccount for anything else must be a served parent. */
  readonly recordId?: string;
  /** The caller's permission set (see the header). Default `agent`. */
  readonly role?: Role;
  /** Hold every read until `release()`. The loading frame, without a clock. */
  readonly hold?: boolean;
  /** Abort every read, as a dropped connection does. */
  readonly networkFailure?: boolean;
  /** Abort every timeline read only. */
  readonly timelineFailure?: boolean;
  /** Abort every listAccountContacts read only. */
  readonly contactsFailure?: boolean;
  /** Hold every write until `releaseWrites()`: the in-flight state of a save. */
  readonly holdWrites?: boolean;
  /** Answer every otherwise-valid updateAccount with this refusal. */
  readonly refuse?: 'not_permitted' | 'stale_write';
  /** Somebody else reassigns ITEM_TASK just before the screen's first write to it (header). */
  readonly staleTask?: boolean;
  /**
   * Serve ACCOUNT_GROUP with ACCOUNT_DEEP as its parent: a chain that never
   * ends. The database forbids it (D-L74); the screen must still stop at four.
   */
  readonly hierarchyCycle?: boolean;
  /** Custom-field definitions, values and field security (T-0091). Absent: no definitions. */
  readonly customFields?: CustomFieldsSetup;
}

export interface RecordedWrite {
  readonly method: 'POST' | 'PATCH';
  readonly path: string;
  readonly body: unknown;
  status?: number;
}

export interface AccountRecordMock {
  /** Every request the mock answered, in order. */
  readonly requests: URL[];
  /** getAccount ids, in order. */
  readonly accountReads: string[];
  /** listAccountTimeline requests, in order. */
  readonly timelineReads: URL[];
  /** listAccountContacts requests, in order. */
  readonly contactsReads: URL[];
  /** Every write, in order, with the status it was answered. */
  readonly writes: RecordedWrite[];
  /** Contract breaches by the SCREEN. Must be empty at the end of every test. */
  readonly violations: string[];
  /** Answers the MOCK built that its contract rejects. Must be empty, always. */
  readonly mockFaults: string[];
  /** The accounts as they now stand (writes applied). */
  readonly accounts: Map<string, AccountRow>;
  /** The timelines as they now stand. */
  readonly timelines: Map<string, TimelineItem[]>;
  /** The custom-field half (T-0091): definition reads, custom writes and stored values. */
  readonly custom: CustomFieldsServer;
  release(): void;
  releaseWrites(): void;
}

export function isGetAccount(request: Request, id?: string): boolean {
  const path = new URL(request.url()).pathname;
  return request.method() === 'GET' && (id === undefined ? /^\/api\/v1\/accounts\/[^/]+$/.test(path) : path === `${ACCOUNTS_PATH}/${id}`);
}

export function isUpdateAccount(request: Request, id: string): boolean {
  return request.method() === 'PATCH' && new URL(request.url()).pathname === `${ACCOUNTS_PATH}/${id}`;
}

export function isAccountTimeline(request: Request, id?: string): boolean {
  const path = new URL(request.url()).pathname;
  return (
    request.method() === 'GET' &&
    (id === undefined ? /^\/api\/v1\/accounts\/[^/]+\/timeline$/.test(path) : path === `${ACCOUNTS_PATH}/${id}/timeline`)
  );
}

export function isAccountContacts(request: Request, id?: string): boolean {
  const path = new URL(request.url()).pathname;
  return (
    request.method() === 'GET' &&
    (id === undefined ? /^\/api\/v1\/accounts\/[^/]+\/contacts$/.test(path) : path === `${ACCOUNTS_PATH}/${id}/contacts`)
  );
}

export function isCreateActivity(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === ACTIVITIES_PATH;
}

export function isUpdateActivity(request: Request, id?: string): boolean {
  const path = new URL(request.url()).pathname;
  return request.method() === 'PATCH' && (id === undefined ? path.startsWith(`${ACTIVITIES_PATH}/`) : path === `${ACTIVITIES_PATH}/${id}`);
}

function validation(details: { path: string; code: string }[]): Json {
  const body = errorExample('ValidationFailed', 'badField');
  body.details = details;
  return body;
}

const UPDATE_ACCOUNT_SCHEMA = schema('UpdateAccountRequest');
const CREATE_ACTIVITY_SCHEMA = schema('CreateActivityRequest');
const UPDATE_ACTIVITY_SCHEMA = schema('UpdateActivityRequest');

function parameterNames(operation: Operation): readonly string[] {
  const [path, method] = OP[operation];
  const own = (at(CONTRACT, 'paths', path, method) as Json).parameters;
  return ((Array.isArray(own) ? own : []) as unknown[]).map((raw) => String((deref(raw, CONTRACT).node as Json).name));
}

const TIMELINE_PARAMETERS = parameterNames('listAccountTimeline');
const CONTACTS_PARAMETERS = parameterNames('listAccountContacts');

const CURRENT_USER_PROBLEMS = answerProblems('getCurrentUser', 200, CURRENT_USER);
if (CURRENT_USER_PROBLEMS.length > 0) {
  throw new Error(`CURRENT_USER disagrees with ${AUTH_CONTRACT_SOURCE}: ${CURRENT_USER_PROBLEMS.join('; ')}`);
}

/** Server time for the n-th write: later than everything in the fixtures. */
function serverTime(n: number): string {
  return new Date(Date.parse('2026-10-07T10:00:00.000Z') + n * 60_000).toISOString();
}

interface ActivityState {
  activity: Json;
  accountId: string;
  itemId: string;
  /** Versions this caller was served for the activity: on a timeline item, or in a 201/200. */
  servedVersions: Set<number>;
}

/** The level of `id` (a top-level account is 1), bounded so a served cycle cannot loop. */
function depthOf(accounts: Map<string, AccountRow>, id: string): number {
  let depth = 1;
  let parent = accounts.get(id)?.parentAccountId;
  while (typeof parent === 'string' && depth <= MAX_ANCESTORS + 1) {
    depth += 1;
    parent = accounts.get(parent)?.parentAccountId;
  }
  return depth;
}

/** Levels in the subtree rooted at `id`, itself included: what moves with a re-parent (D-L74). */
function heightOf(accounts: Map<string, AccountRow>, id: string, budget = MAX_ANCESTORS + 1): number {
  if (budget <= 0) return 1;
  const children = [...accounts.values()].filter((row) => row.parentAccountId === id);
  return 1 + Math.max(0, ...children.map((child) => heightOf(accounts, child.id, budget - 1)));
}

export async function installAccountRecordMock(page: Page, options: AccountRecordMockOptions = {}): Promise<AccountRecordMock> {
  const role: Role = options.role ?? 'agent';
  const accounts = new Map<string, AccountRow>(ALL_ACCOUNTS.map((row) => [row.id, clone(row)]));
  if (options.hierarchyCycle === true) {
    const group = accounts.get(ACCOUNT_GROUP.id);
    if (group !== undefined) group.parentAccountId = ACCOUNT_DEEP.id;
  }
  const timelines = new Map<string, TimelineItem[]>(Object.entries(TIMELINES).map(([id, items]) => [id, clone([...items])]));
  const activities = new Map<string, ActivityState>();
  for (const [accountId, items] of timelines) {
    const programmeId = accounts.get(accountId)?.programmeId ?? PROGRAMME_ONE.id;
    for (const item of items) {
      if (item.type !== 'activity') continue;
      const activityId = String(item.activityId);
      activities.set(activityId, {
        accountId,
        itemId: item.id,
        servedVersions: new Set<number>(),
        activity: {
          id: activityId,
          programmeId,
          type: item.activityType,
          subject: item.subject ?? null,
          body: item.body ?? null,
          dueAt: item.dueAt ?? null,
          startsAt: item.startsAt ?? null,
          endsAt: item.endsAt ?? null,
          completedAt: item.completedAt ?? null,
          ownerUserId: null,
          contactId: null,
          accountId,
          createdByUserId: item.actor === null ? null : item.actor.id,
          version: Number(item.version),
          createdAt: item.occurredAt,
          updatedAt: item.occurredAt,
        },
      });
    }
  }

  const requests: URL[] = [];
  const accountReads: string[] = [];
  const timelineReads: URL[] = [];
  const contactsReads: URL[] = [];
  const writes: RecordedWrite[] = [];
  const violations: string[] = [];
  const mockFaults: string[] = [];
  const custom = new CustomFieldsServer(options.customFields, violations);
  /** Accounts the screen has been served (a 200 from getAccount or updateAccount). */
  const servedAccounts = new Set<string>();
  /** parentAccountId values the mock has served, so getAccount on them is legitimate. */
  const servedParents = new Set<string>();
  let ancestorReads = 0;
  /** cursor -> what it was served for, and the last item id of its page */
  const timelineCursors = new Map<string, { accountId: string; afterId: string }>();
  const contactCursors = new Map<string, { accountId: string; sort: string; offset: number }>();
  let cursorCount = 0;
  let writeCount = 0;
  let activityCount = 0;
  let staled = false;

  let release: () => void = () => undefined;
  const gate = options.hold === true ? new Promise<void>((done) => (release = done)) : Promise.resolve();
  let releaseWrites: () => void = () => undefined;
  const writeGate = options.holdWrites === true ? new Promise<void>((done) => (releaseWrites = done)) : Promise.resolve();

  /** Every answer goes through here, checked against the contract first. */
  const answer = (route: Route, operation: Operation, status: number, body: unknown): Promise<void> => {
    for (const problem of answerProblems(operation, status, body)) {
      mockFaults.push(problem);
    }
    return route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify(body),
    });
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

  const served = (row: AccountRow): AccountRow => {
    servedAccounts.add(row.id);
    if (typeof row.parentAccountId === 'string') servedParents.add(row.parentAccountId);
    return custom.decorate(clone(row), 'account', row.id, row.programmeId);
  };

  const addItems = (accountId: string, items: TimelineItem[]): void => {
    const list = timelines.get(accountId) ?? [];
    timelines.set(accountId, ordered([...items.map(checkItem), ...list]));
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

  // ----- getAccount --------------------------------------------------------

  const getAccount = async (route: Route, id: string): Promise<void> => {
    accountReads.push(id);
    await gate;
    if (options.networkFailure === true) {
      return route.abort('internetdisconnected');
    }
    if (!UUID_PATTERN.test(id)) {
      // A malformed id typed into the address bar is the user's, not the screen's.
      return answer(route, 'getAccount', 400, validation([{ path: 'accountId', code: 'invalid_string' }]));
    }
    const row = accounts.get(id);
    if (options.recordId !== undefined) {
      // A read of the record starts a new walk; the record read AS a parent
      // (only possible in a served cycle) is one more step of the same walk.
      if (id === options.recordId && !servedParents.has(id)) {
        ancestorReads = 0;
      } else if (servedParents.has(id)) {
        ancestorReads += 1;
        if (ancestorReads > MAX_ANCESTORS) {
          violations.push(`getAccount walked ${ancestorReads} ancestors; a hierarchy is at most five levels (D-L74)`);
        }
      } else if (row !== undefined) {
        violations.push(`getAccount named ${id}, which is neither the record nor a parent the screen was served`);
      }
    }
    return row === undefined ? answer(route, 'getAccount', 404, errorExample('AccountNotFound')) : answer(route, 'getAccount', 200, served(row));
  };

  // ----- listAccountTimeline ------------------------------------------------

  const timeline = async (route: Route, url: URL, id: string): Promise<void> => {
    timelineReads.push(url);
    await gate;
    if (options.timelineFailure === true || options.networkFailure === true) {
      return route.abort('internetdisconnected');
    }
    // Order (T-0080): 404 first, a non-uuid id included; then 400.
    if (!UUID_PATTERN.test(id) || !accounts.has(id)) {
      return answer(route, 'listAccountTimeline', 404, errorExample('AccountNotFound'));
    }
    const problems = checkQuery(url, TIMELINE_PARAMETERS, 'listAccountTimeline');
    if (problems.length > 0) {
      violations.push(...problems.map((problem) => `${url.search}: ${problem}`));
      return answer(route, 'listAccountTimeline', 400, validation(problems.map(() => ({ path: 'query', code: 'invalid_string' }))));
    }
    const limit = Number(url.searchParams.get('limit') ?? 25);
    const items = timelines.get(id) ?? [];
    let start = 0;
    const cursor = url.searchParams.get('cursor');
    if (cursor !== null) {
      const boundTo = timelineCursors.get(cursor);
      if (boundTo === undefined) {
        violations.push(`timeline cursor "${cursor}" was never served — it must be echoed, not built`);
        return answer(route, 'listAccountTimeline', 400, errorExample('ValidationFailed', 'badCursor'));
      }
      if (boundTo.accountId !== id) {
        violations.push(`a timeline cursor served for account ${boundTo.accountId} was sent for another account`);
        return answer(route, 'listAccountTimeline', 400, errorExample('ValidationFailed', 'badCursor'));
      }
      start = items.findIndex((item) => item.id === boundTo.afterId) + 1;
    }
    const data = items.slice(start, start + limit);
    let nextCursor: string | null = null;
    const last = data.at(-1);
    if (start + limit < items.length && last !== undefined) {
      cursorCount += 1;
      nextCursor = `atc_${String(cursorCount).padStart(4, '0')}_q9Lm`;
      timelineCursors.set(nextCursor, { accountId: id, afterId: last.id });
    }
    for (const item of data) {
      if (item.type === 'activity') activities.get(String(item.activityId))?.servedVersions.add(Number(item.version));
    }
    return answer(route, 'listAccountTimeline', 200, { data: clone(data), nextCursor });
  };

  // ----- listAccountContacts -------------------------------------------------

  const accountContacts = async (route: Route, url: URL, id: string): Promise<void> => {
    contactsReads.push(url);
    await gate;
    if (options.contactsFailure === true || options.networkFailure === true) {
      return route.abort('internetdisconnected');
    }
    const problems = checkQuery(url, CONTACTS_PARAMETERS, 'listAccountContacts');
    const sort = url.searchParams.get('sort') ?? CONTACT_SORT_DEFAULT;
    if (!CONTACT_SORTS.includes(sort)) problems.push(`sort=${sort} is not in the contract's enum`);
    if (problems.length > 0) {
      violations.push(...problems.map((problem) => `${url.search}: ${problem}`));
      return answer(route, 'listAccountContacts', 400, validation(problems.map(() => ({ path: 'query', code: 'invalid_string' }))));
    }
    if (!UUID_PATTERN.test(id)) {
      return answer(route, 'listAccountContacts', 400, validation([{ path: 'accountId', code: 'invalid_string' }]));
    }
    const account = accounts.get(id);
    if (account === undefined) {
      return answer(route, 'listAccountContacts', 404, errorExample('AccountNotFound'));
    }
    if (CONTACT_ACCOUNT_WITHHELD.has(account.programmeId)) {
      const refused = errorExample('ValidationFailed', 'withheldFilter');
      refused.details = [{ path: 'accountId', code: 'field_withheld' }];
      return answer(route, 'listAccountContacts', 400, refused);
    }
    const rows = [...contactsOf(id)];
    const descending = sort.startsWith('-');
    const key = sort.replace(/^-/, '');
    rows.sort((a, b) => {
      const left = String(a[key] ?? '');
      const right = String(b[key] ?? '');
      const byKey = left < right ? -1 : left > right ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      return descending ? -byKey : byKey;
    });
    let offset = 0;
    const cursor = url.searchParams.get('cursor');
    if (cursor !== null) {
      const boundTo = contactCursors.get(cursor);
      if (boundTo === undefined || boundTo.accountId !== id || boundTo.sort !== sort) {
        violations.push(`contacts cursor "${cursor}" was not served for this account and sort — it must be echoed, not built`);
        return answer(route, 'listAccountContacts', 400, errorExample('ValidationFailed', 'badCursor'));
      }
      offset = boundTo.offset;
    }
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 25), CONTACT_PAGE_CAP);
    const data = rows.slice(offset, offset + limit);
    let nextCursor: string | null = null;
    if (offset + limit < rows.length) {
      cursorCount += 1;
      nextCursor = `acc_${String(cursorCount).padStart(4, '0')}_v3Xp`;
      contactCursors.set(nextCursor, { accountId: id, sort, offset: offset + limit });
    }
    return answer(route, 'listAccountContacts', 200, { data: clone(data), nextCursor });
  };

  // ----- updateAccount -------------------------------------------------------

  const updateAccount = async (route: Route, request: Request, id: string): Promise<void> => {
    const body = readBody(request, 'updateAccount');
    const write: RecordedWrite = { method: 'PATCH', path: `${ACCOUNTS_PATH}/${id}`, body };
    writes.push(write);
    await writeGate;
    const reply = (status: number, payload: unknown): Promise<void> => {
      write.status = status;
      return answer(route, 'updateAccount', status, payload);
    };
    const row = accounts.get(id);
    if (row === undefined || !servedAccounts.has(id)) {
      violations.push(`updateAccount named ${id}, which the screen was never served`);
      return reply(404, errorExample('AccountNotFound'));
    }
    const problems = validateBody(body, UPDATE_ACCOUNT_SCHEMA, '');
    violations.push(...problems.map((problem) => `updateAccount: ${problem}`));
    if (!isJson(body)) {
      return reply(400, validation([{ path: 'body', code: 'invalid_type' }]));
    }
    const sentWithheld = Object.keys(body).filter((key) => row.withheldFields.includes(key));
    if (sentWithheld.length > 0) {
      violations.push(`updateAccount sent ${sentWithheld.join(', ')}, which the account withholds from the caller`);
    }
    if (body.version !== row.version) {
      violations.push(`updateAccount sent version ${String(body.version)}; the screen was last served ${row.version}`);
    }
    const fields = Object.keys(body).filter((key) => key !== 'version');

    // Order (the contract): 404, 403 (field_not_editable included), 400, 409.
    if (role !== 'admin' || options.refuse === 'not_permitted') {
      return reply(403, errorExample('AccountNotPermitted', 'action'));
    }
    const notEditable = fields.filter((key) => sentWithheld.includes(key) || (READ_ONLY[id] ?? []).includes(key));
    if (notEditable.length > 0) {
      const forbidden = errorExample('AccountNotPermitted', 'field');
      forbidden.details = notEditable.map((path) => ({ path, code: 'field_not_editable' }));
      return reply(403, forbidden);
    }
    // T-0091: `custom` is a per-key merge, checked by the custom half (its own 403s, then 400s).
    const customAnswer = 'custom' in body ? custom.checkPatch('account', id, row.programmeId, body.custom, 'updateAccount') : undefined;
    if (customAnswer !== undefined) {
      return reply(customAnswer.status, customAnswer.body);
    }
    if (problems.length > 0) {
      return reply(400, validation(problems.map(() => ({ path: 'body', code: 'invalid_string' }))));
    }
    if (typeof body.ownerUserId === 'string' && !MEMBERS.some((member) => member.id === body.ownerUserId)) {
      violations.push(`updateAccount set an owner (${body.ownerUserId}) the screen could not have been served`);
      return reply(400, validation([{ path: 'ownerUserId', code: 'unknown_reference' }]));
    }
    if (typeof body.parentAccountId === 'string') {
      const parent = accounts.get(body.parentAccountId);
      if (parent === undefined || parent.programmeId !== row.programmeId || !servedAccounts.has(parent.id)) {
        violations.push('updateAccount set a parent the screen was never served in this programme');
        return reply(400, validation([{ path: 'parentAccountId', code: 'unknown_reference' }]));
      }
      let cursor: unknown = parent.id;
      for (let hop = 0; hop <= MAX_ANCESTORS + 1 && typeof cursor === 'string'; hop += 1) {
        if (cursor === id) return reply(400, validation([{ path: 'parentAccountId', code: 'parent_cycle' }]));
        cursor = accounts.get(cursor)?.parentAccountId;
      }
      if (depthOf(accounts, parent.id) + heightOf(accounts, id) > MAX_ANCESTORS + 1) {
        return reply(400, validation([{ path: 'parentAccountId', code: 'parent_depth' }]));
      }
    }
    if (body.version !== row.version || options.refuse === 'stale_write') {
      return reply(409, errorExample('StaleWrite'));
    }

    writeCount += 1;
    const when = serverTime(writeCount);
    const items = fields
      .filter((key) => ACCOUNT_TIMELINE_FIELDS.includes(key))
      .map((key, index) => change(`ti_w${String(writeCount).padStart(3, '0')}x${index}`, when, ME, key));
    for (const key of fields) {
      if (key === 'custom') {
        custom.applyPatch('account', id, body.custom as Json);
      } else if (key === 'ownerUserId') {
        Object.assign(row, ownedBy(MEMBERS.find((member) => member.id === body.ownerUserId) ?? null));
      } else {
        row[key] = body[key];
      }
    }
    row.version += 1;
    row.updatedAt = when;
    checkAccount(row);
    addItems(id, items);
    return reply(200, served(row));
  };

  // ----- createActivity ------------------------------------------------------

  const activityResponse = (state: ActivityState): Json => {
    const withheld = ACTIVITY_WITHHELD[String(state.activity.programmeId)] ?? [];
    const copy: Json = { ...clone(state.activity), withheldFields: [...withheld] };
    for (const field of withheld) {
      delete copy[field];
    }
    custom.decorate(copy as Json & { withheldFields: string[] }, 'activity', String(state.activity.id), String(state.activity.programmeId));
    state.servedVersions.add(Number(copy.version));
    return copy;
  };

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
    const problems = validateBody(body, CREATE_ACTIVITY_SCHEMA, '');
    const accountId = typeof body.accountId === 'string' ? body.accountId : undefined;
    if (accountId === undefined) {
      problems.push('createActivity from the account record names no accountId');
    }
    if (body.contactId !== undefined && body.contactId !== null) {
      // An activity with a contact belongs to the contact's record first; from
      // the account record the target is the account alone (T-0063).
      problems.push('createActivity from the account record names a contactId');
    }
    if (body.type !== 'task' && body.dueAt !== undefined && body.dueAt !== null) {
      problems.push(`dueAt on a ${String(body.type)} (task_only)`);
    }
    violations.push(...problems.map((problem) => `createActivity: ${problem}`));
    const row = accountId === undefined ? undefined : accounts.get(accountId);
    if (accountId !== undefined && (row === undefined || !servedAccounts.has(accountId))) {
      violations.push(`createActivity targeted account ${accountId}, which the screen was never served`);
      return reply(404, errorExample('NotFound'));
    }
    if (row === undefined) {
      return reply(400, validation([{ path: 'accountId', code: 'required' }]));
    }
    const owner = body.ownerUserId;
    if (role === 'reader' || (role === 'agent' && typeof owner === 'string' && owner !== ME.id)) {
      return reply(403, errorExample('NotPermitted', 'action'));
    }
    // T-0091: `custom` on a create carries values only, checked for the activity object.
    const customAnswer = custom.checkCreate('activity', row.programmeId, body.custom, 'createActivity');
    if (customAnswer !== undefined) {
      return reply(customAnswer.status, customAnswer.body);
    }
    if (problems.length > 0) {
      return reply(400, validation(problems.map(() => ({ path: 'body', code: 'invalid_string' }))));
    }
    if (typeof owner === 'string' && !MEMBERS.some((member) => member.id === owner)) {
      violations.push(`createActivity set an owner (${owner}) the screen could not have been served`);
      return reply(400, validation([{ path: 'ownerUserId', code: 'unknown_reference' }]));
    }

    const activityId = NEW_ACTIVITY_IDS[activityCount];
    if (activityId === undefined) {
      throw new Error('the mock ran out of NEW_ACTIVITY_IDS');
    }
    activityCount += 1;
    writeCount += 1;
    const when = serverTime(writeCount);
    const state: ActivityState = {
      accountId: row.id,
      itemId: `ti_new${String(activityCount).padStart(2, '0')}`,
      servedVersions: new Set<number>(),
      activity: {
        id: activityId,
        programmeId: row.programmeId,
        type: body.type,
        subject: body.subject ?? null,
        body: body.body ?? null,
        dueAt: body.dueAt ?? null,
        startsAt: body.type === 'meeting' ? (body.startsAt ?? null) : null,
        endsAt: body.type === 'meeting' ? (body.endsAt ?? null) : null,
        completedAt: null,
        ownerUserId: owner ?? null,
        contactId: null,
        accountId: row.id,
        createdByUserId: ME.id,
        version: 1,
        createdAt: when,
        updatedAt: when,
      },
    };
    activities.set(activityId, state);
    custom.storeCreated(activityId, body.custom);
    const item: TimelineItem = {
      id: state.itemId,
      type: 'activity',
      occurredAt: when,
      actor: actorOf(ME),
      activityId,
      activityType: String(body.type),
      subject: body.subject ?? null,
      body: body.body ?? null,
      dueAt: body.dueAt ?? null,
      startsAt: body.type === 'meeting' ? (body.startsAt ?? null) : null,
      endsAt: body.type === 'meeting' ? (body.endsAt ?? null) : null,
      completedAt: null,
      version: 1,
    };
    for (const field of ACTIVITY_WITHHELD[row.programmeId] ?? []) {
      delete item[field];
    }
    addItems(row.id, [item]);
    return reply(201, activityResponse(state));
  };

  // ----- updateActivity ------------------------------------------------------

  const updateActivity = async (route: Route, request: Request, id: string): Promise<void> => {
    const body = readBody(request, 'updateActivity');
    const write: RecordedWrite = { method: 'PATCH', path: `${ACTIVITIES_PATH}/${id}`, body };
    writes.push(write);
    await writeGate;
    const reply = (status: number, payload: unknown): Promise<void> => {
      write.status = status;
      return answer(route, 'updateActivity', status, payload);
    };
    const state = activities.get(id);
    if (state === undefined || !servedAccounts.has(state.accountId)) {
      violations.push(`updateActivity named ${id}, which the screen was never served`);
      return reply(404, errorExample('NotFound'));
    }
    if (!isJson(body)) {
      violations.push('updateActivity body is not an object');
      return reply(400, validation([{ path: 'body', code: 'invalid_type' }]));
    }
    if (options.staleTask === true && !staled && id === String(ITEM_TASK.activityId)) {
      // Somebody else reassigns the task a moment before this write lands.
      staled = true;
      state.activity.version = Number(state.activity.version) + 1;
      state.activity.ownerUserId = OTHER_OWNER.id;
      const item = (timelines.get(state.accountId) ?? []).find((candidate) => candidate.id === state.itemId);
      if (item !== undefined) item.version = state.activity.version;
    }
    const problems = validateBody(body, UPDATE_ACTIVITY_SCHEMA, '');
    if (body.completed === true && state.activity.type !== 'task') {
      problems.push(`completed on a ${String(state.activity.type)} (task_only)`);
    }
    violations.push(...problems.map((problem) => `updateActivity: ${problem}`));
    const version = Number(body.version);
    if (!state.servedVersions.has(version)) {
      violations.push(`updateActivity sent version ${String(body.version)} for ${id}, a version the screen was never served`);
    }
    const reassigning = 'ownerUserId' in body;
    if (role === 'reader' || (role === 'agent' && reassigning && body.ownerUserId !== ME.id)) {
      return reply(403, errorExample('NotPermitted', 'action'));
    }
    if (problems.length > 0) {
      return reply(400, validation(problems.map(() => ({ path: 'body', code: 'invalid_string' }))));
    }
    if (version !== state.activity.version) {
      return reply(409, errorExample('StaleWrite'));
    }
    writeCount += 1;
    const when = serverTime(writeCount);
    if (body.completed === true) {
      state.activity.completedAt = state.activity.completedAt ?? when;
    }
    if (reassigning) {
      state.activity.ownerUserId = body.ownerUserId ?? null;
    }
    state.activity.version = Number(state.activity.version) + 1;
    state.activity.updatedAt = when;
    // The item shows the activity's current state: changed in place, never added.
    const item = (timelines.get(state.accountId) ?? []).find((candidate) => candidate.id === state.itemId);
    if (item !== undefined) {
      if ('completedAt' in item) item.completedAt = state.activity.completedAt;
      item.version = state.activity.version;
    }
    return reply(200, activityResponse(state));
  };

  // ----- routing -------------------------------------------------------------

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
        return answer(route, 'listMyProgrammes', 200, { data: [clone(PROGRAMME_ONE), clone(PROGRAMME_TWO)] });
      }
      if (url.pathname === CUSTOM_FIELDS_PATH && method === 'GET') {
        return custom.answerList(route);
      }
      const account = /^\/api\/v1\/accounts\/([^/]+)(\/timeline|\/contacts)?$/.exec(url.pathname);
      if (account !== null && account[1] !== 'map') {
        const id = decodeURIComponent(account[1] ?? '');
        if (account[2] === '/timeline' && method === 'GET') return timeline(route, url, id);
        if (account[2] === '/contacts' && method === 'GET') return accountContacts(route, url, id);
        if (account[2] === undefined && method === 'GET') return getAccount(route, id);
        if (account[2] === undefined && method === 'PATCH') return updateAccount(route, request, id);
      }
      if (url.pathname === ACTIVITIES_PATH && method === 'POST') {
        return createActivity(route, request);
      }
      const activity = /^\/api\/v1\/activities\/([^/]+)$/.exec(url.pathname);
      if (activity !== null && method === 'PATCH') {
        return updateActivity(route, request, decodeURIComponent(activity[1] ?? ''));
      }
      violations.push(`${method} ${url.pathname} is not an operation the account record uses`);
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
    accountReads,
    timelineReads,
    contactsReads,
    writes,
    violations,
    mockFaults,
    accounts,
    timelines,
    custom,
    release: () => release(),
    releaseWrites: () => releaseWrites(),
  };
}
