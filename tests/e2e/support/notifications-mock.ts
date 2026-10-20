import type { Page, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * The notifications half of `docs/api/records.openapi.yaml` (tag
 * `notifications`, T-0099's contract, served by T-0100: listNotifications,
 * getNotificationUnreadCount, markAllNotificationsRead, updateNotification),
 * served into the browser by Playwright for T-0101 (the P26 bell and
 * notification centre).
 *
 * ---------------------------------------------------------------------------
 * READ FROM THE CONTRACT AT RUN TIME, AND EVERY REQUEST AND ANSWER CHECKED
 *
 * The kinds (`NotificationKind`, `x-kasuwa-notification-kinds`), the count's
 * cap, the unread window, the poll interval, the limit range and every error
 * body come out of the YAML when this module loads. The contract's own
 * listNotifications example page is the top of the stored list, verbatim.
 * EVERY body the mock answers with is validated strictly against the schema
 * the contract declares for that operation and status: a property the schema
 * does not name is a fault, so the mock can never hand the screen a title, a
 * body, a per-kind count or an exact total the real API does not serve. A
 * fault is the MOCK's, recorded in `mockFaults`, which the spec's `afterEach`
 * requires to be empty.
 *
 * TWO LABELLED EXEMPTIONS, each validated against its contract twin:
 *   - `futureKind`: one item of a kind the contract does not know yet. The
 *     contract says kinds only grow and "a client ignores an item whose kind
 *     it does not know rather than failing the page", so this is the one way
 *     to prove the client does. Its twin (kind and object type replaced by a
 *     known pair) must validate.
 *   - `malformedIds`: one item whose `objectId` is not a uuid. The task file
 *     says links are made "only from well-formed uuids"; this proves it. Its
 *     twin (a uuid in place) must validate.
 * And 500 `internal_error` (the shared envelope's fixed body, which any
 * operation may answer, admin.openapi.yaml `Error`) is validated against that
 * envelope rather than a per-operation response.
 *
 * WHAT IS NOT IN THE CONTRACT, AND IS THEREFORE DECLARED HERE
 *
 *   - The clock. `NOW` is ten minutes after the example's newest item, and
 *     every journey that reads a day or a cadence installs it as the page's
 *     clock. The mock stamps every call with the PAGE's time (asked of the
 *     page), so a Retry-After or a poll gap is judged on the clock the screen
 *     runs on, fake or real.
 *   - The rest of the list. Under the example: a pair whose names are markup,
 *     a contact whose actor and name are both withheld, a deal created at
 *     23:30 UTC on the 17th (00:30 on the 18th in Lagos, WAT), two of
 *     yesterday's, and 130 older, all read. 140 visible in all, more than the
 *     largest page (100), so the centre always has a second page.
 *   - The unread state: the example's four unread, plus the markup pair, the
 *     withheld pair and the boundary deal. Seven unread by default.
 * ---------------------------------------------------------------------------
 *
 * WHAT THE MOCK ENFORCES ON EVERY REQUEST (recorded as `violations`, the
 * SCREEN's fault; `afterEach` in the spec fails a test that has any)
 *
 *   - Only the four operations under `/api/v1/notifications` (and, unless
 *     `otherScreens`, nothing else under `/api/v1/`). No header names a
 *     programme, a tenant or a scope; no query carries `programmeId`; no name
 *     the mock serves appears in a URL.
 *   - listNotifications: `filter`, `kind`, `cursor` and `limit` only; `limit`
 *     1..100; a known `filter` and ONE known `kind`; a cursor exactly as
 *     served, and only with the filter and kind it was served for (a filter
 *     change starts at the top).
 *   - getNotificationUnreadCount: no parameter.
 *   - updateNotification: a uuid the screen was served; the closed body
 *     `{ read: boolean }`; never again for an id the API answered 404.
 *   - markAllNotificationsRead: the closed body; ALWAYS a `throughId`
 *     (without it, a notification that arrives after the reader looked is
 *     marked read too, D-L154); a `throughId` the screen was served, and not
 *     older than the newest UNREAD item of that kind (any kind when `kind` is
 *     absent) the screen was served: "mark all read" never stops short of
 *     what the reader saw.
 *   - Any operation: never while that operation's `Retry-After` is running
 *     (a 429's wait is the server's to set, D-L134).
 * ---------------------------------------------------------------------------
 */

export const RECORDS_CONTRACT_SOURCE = 'docs/api/records.openapi.yaml';
export const ADMIN_CONTRACT_SOURCE = 'docs/api/admin.openapi.yaml';
/** T-0148: the shell's own identity read (getCurrentUser, T-0130's avatar) is answered from this contract. */
export const AUTH_CONTRACT_SOURCE = 'docs/api/auth.openapi.yaml';

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
const ADMIN_CONTRACT: unknown = load(ADMIN_CONTRACT_SOURCE);
const AUTH_CONTRACT: unknown = load(AUTH_CONTRACT_SOURCE);

const DOCUMENTS: Readonly<Record<string, unknown>> = {
  './records.openapi.yaml': CONTRACT,
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

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

/**
 * Problems with `value` against a schema. `strict` treats every object schema
 * that declares properties as closed: used on the mock's OWN answers. What the
 * screen sends is judged by the contract's own `additionalProperties`.
 */
export function validateBody(value: unknown, raw: unknown, path: string, doc: unknown = CONTRACT, strict = false): string[] {
  const located = deref(raw, doc);
  const spec = located.node as Json;
  const where = path || 'body';
  const problems: string[] = [];
  if (Array.isArray(spec.oneOf)) {
    const passing = spec.oneOf.filter((option) => validateBody(value, option, path, located.doc, false).length === 0);
    if (passing.length !== 1) problems.push(`${where} matches ${passing.length} of oneOf, not exactly 1`);
  }
  if (Array.isArray(spec.anyOf)) {
    const passing = spec.anyOf.filter((option) => validateBody(value, option, path, located.doc, false).length === 0);
    if (passing.length === 0) problems.push(`${where} matches none of anyOf`);
  }
  if (Array.isArray(spec.allOf)) {
    for (const part of spec.allOf) problems.push(...validateBody(value, part, path, located.doc, false));
  }
  if (spec.type !== undefined) {
    const allowed = (Array.isArray(spec.type) ? spec.type : [spec.type]).map(String);
    const actual = typeOf(value);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      return [...problems, `${where} is ${actual}, not ${allowed.join('|')}`];
    }
  }
  if ('const' in spec && spec.const !== value) problems.push(`${where} is not ${String(spec.const)}`);
  if (Array.isArray(spec.enum) && !spec.enum.includes(value)) problems.push(`${where} is not one of ${spec.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (typeof spec.minLength === 'number' && [...value].length < spec.minLength) problems.push(`${where} is too short`);
    if (typeof spec.maxLength === 'number' && [...value].length > spec.maxLength) problems.push(`${where} is too long`);
    if (typeof spec.pattern === 'string' && !new RegExp(spec.pattern, 'u').test(value)) problems.push(`${where} does not match ${spec.pattern}`);
    if (spec.format === 'uuid' && !UUID_PATTERN.test(value)) problems.push(`${where} is not a uuid`);
    if (spec.format === 'date-time' && !UTC_DATE_TIME.test(value)) problems.push(`${where} is not a UTC date-time with a Z`);
  }
  if (typeof value === 'number') {
    if (typeof spec.minimum === 'number' && value < spec.minimum) problems.push(`${where} is below ${spec.minimum}`);
    if (typeof spec.maximum === 'number' && value > spec.maximum) problems.push(`${where} is above ${spec.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof spec.maxItems === 'number' && value.length > spec.maxItems) problems.push(`${where} has too many items`);
    if (typeof spec.minItems === 'number' && value.length < spec.minItems) problems.push(`${where} has too few items`);
    if (spec.items !== undefined) {
      value.forEach((item, index) => problems.push(...validateBody(item, spec.items, `${path}.${index}`, located.doc, strict)));
    }
  }
  if (isJson(value)) {
    if (spec.properties !== undefined || spec.required !== undefined || spec.additionalProperties !== undefined) {
      const properties = (spec.properties ?? {}) as Json;
      for (const key of (spec.required ?? []) as string[]) {
        if (!(key in value)) problems.push(`${path ? `${path}.` : ''}${key} is required`);
      }
      for (const [key, item] of Object.entries(value)) {
        const child = `${path ? `${path}.` : ''}${key}`;
        if (key in properties) {
          problems.push(...validateBody(item, properties[key], child, located.doc, strict));
        } else if (isJson(spec.additionalProperties)) {
          problems.push(...validateBody(item, spec.additionalProperties, child, located.doc, strict));
        } else if (spec.additionalProperties === false) {
          problems.push(`${child} is not a property of this closed body`);
        } else if (strict && spec.properties !== undefined) {
          problems.push(`${child} is not a property the contract declares`);
        }
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The four operations, from the contract
// ---------------------------------------------------------------------------

export const NOTIFICATIONS_PATH = '/api/v1/notifications';

/** T-0148: the shell's identity read (auth.openapi.yaml getCurrentUser). */
const ME_PATH = '/api/v1/auth/me';
if ((at(AUTH_CONTRACT, 'paths', ME_PATH, 'get') as Json).operationId !== 'getCurrentUser') {
  throw new Error(`${AUTH_CONTRACT_SOURCE}: GET ${ME_PATH} is no longer getCurrentUser: re-pin the notifications mock`);
}

/** getCurrentUser's body: a placeholder person (the auth contract has no example). Identity only, never scope. */
const CURRENT_USER: Json = {
  id: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e09',
  tenantId: '11111111-0000-4000-8000-00000000a001',
  email: 'reader@example.test',
  displayName: 'Sample Reader',
  locale: 'en-NG',
};

/** The body against the contract's CurrentUser, closed: a property it does not name is the mock's fault. */
function meProblems(body: Json): string[] {
  return validateBody(body, at(AUTH_CONTRACT, 'components', 'schemas', 'CurrentUser'), '', AUTH_CONTRACT, true);
}

const OP = {
  listNotifications: [NOTIFICATIONS_PATH, 'get'],
  getNotificationUnreadCount: [`${NOTIFICATIONS_PATH}/unread-count`, 'get'],
  markAllNotificationsRead: [`${NOTIFICATIONS_PATH}/read-all`, 'post'],
  updateNotification: [`${NOTIFICATIONS_PATH}/{notificationId}`, 'patch'],
} as const;

export type Operation = keyof typeof OP;
export const OPERATIONS: readonly Operation[] = Object.keys(OP) as Operation[];

for (const [operationId, [path, method]] of Object.entries(OP)) {
  const declared = (at(CONTRACT, 'paths', path, method) as Json).operationId;
  if (declared !== operationId) throw new Error(`${RECORDS_CONTRACT_SOURCE}: ${method.toUpperCase()} ${path} is no longer ${operationId}: re-pin the notifications mock`);
}

/** What is wrong with answering `operation` with `status` and `body`, judged strictly. */
export function answerProblems(operation: Operation, status: number, body: unknown): string[] {
  const [path, method] = OP[operation];
  const responses = at(CONTRACT, 'paths', path, method, 'responses') as Json;
  const declared = responses[String(status)];
  if (declared === undefined) return [`${operation} declares no ${status} response`];
  const response = deref(declared, CONTRACT);
  const content = at(response.node, 'content', 'application/json', 'schema');
  return validateBody(body, content, `${operation} ${status}`, response.doc, true);
}

/** The headers an operation's answer must carry at `status`, by the contract (lower-cased names). */
export function requiredHeaders(operation: Operation, status: number): string[] {
  const [path, method] = OP[operation];
  const declared = (at(CONTRACT, 'paths', path, method, 'responses') as Json)[String(status)];
  if (declared === undefined) return [];
  const headers = (deref(declared, CONTRACT).node as Json).headers;
  if (!isJson(headers)) return [];
  return Object.entries(headers)
    .filter(([, header]) => isJson(deref(header, CONTRACT).node) && (deref(header, CONTRACT).node as Json).required === true)
    .map(([name]) => name.toLowerCase());
}

function responseBody(operation: Operation, status: number, name?: string): Json {
  const [path, method] = OP[operation];
  const declared = at(CONTRACT, 'paths', path, method, 'responses', String(status));
  const json = at(deref(declared, CONTRACT).node, 'content', 'application/json') as Json;
  const body = name === undefined ? (json.example ?? Object.values((json.examples ?? {}) as Json).map((entry) => (entry as Json).value)[0]) : at(json.examples, name, 'value');
  return clone(body) as Json;
}

function parameterNames(operation: Operation): readonly string[] {
  const [path, method] = OP[operation];
  const own = (at(CONTRACT, 'paths', path, method) as Json).parameters;
  return ((Array.isArray(own) ? own : []) as unknown[]).map((raw) => String((deref(raw, CONTRACT).node as Json).name));
}

// ---------------------------------------------------------------------------
// The contract's own vocabularies and numbers
// ---------------------------------------------------------------------------

export const KINDS: readonly string[] = (schema('NotificationKind').enum as unknown[]).map(String);
export const OBJECT_TYPES: readonly string[] = (schema('NotificationObjectType').enum as unknown[]).map(String);
export const FILTERS: readonly string[] = (schema('NotificationFilter').enum as unknown[]).map(String);
/** `x-kasuwa-notification-kinds`: the object types each kind may name. */
export const KIND_OBJECTS = clone(at(CONTRACT, 'paths', NOTIFICATIONS_PATH, 'get', 'x-kasuwa-notification-kinds')) as Readonly<Record<string, readonly string[]>>;
/** The badge's cap: NotificationUnreadCount.count's maximum (99). */
export const COUNT_CAP = Number((at(schema('NotificationUnreadCount'), 'properties', 'count') as Json).maximum);
/** `x-kasuwa-poll-interval-seconds` on getNotificationUnreadCount (30). */
export const POLL_INTERVAL_SECONDS = Number(at(CONTRACT, 'paths', `${NOTIFICATIONS_PATH}/unread-count`, 'get', 'x-kasuwa-poll-interval-seconds'));
/** The count examines at most this many of the newest unread (D-L157: 500). */
export const UNREAD_WINDOW = Number(/at most the (\d+) newest unread/.exec(String(at(CONTRACT, 'paths', `${NOTIFICATIONS_PATH}/unread-count`, 'get', 'description')).replace(/\s+/g, ' '))?.[1] ?? NaN);
const LIMIT_SCHEMA = (deref(at(CONTRACT, 'components', 'parameters', 'Limit'), CONTRACT).node as Json).schema as Json;
export const LIMIT_MAX = Number(LIMIT_SCHEMA.maximum);
export const LIMIT_DEFAULT = Number(LIMIT_SCHEMA.default);

if (!Number.isInteger(COUNT_CAP) || !Number.isInteger(POLL_INTERVAL_SECONDS) || !Number.isInteger(UNREAD_WINDOW) || !Number.isInteger(LIMIT_MAX)) {
  throw new Error(`${RECORDS_CONTRACT_SOURCE}: a notifications number moved (cap ${COUNT_CAP}, poll ${POLL_INTERVAL_SECONDS}, window ${UNREAD_WINDOW}, limit ${LIMIT_MAX}): re-pin the notifications mock`);
}
for (const kind of KINDS) {
  if (!Array.isArray(KIND_OBJECTS[kind])) throw new Error(`${RECORDS_CONTRACT_SOURCE}: x-kasuwa-notification-kinds names no object type for ${kind}`);
}

// ---------------------------------------------------------------------------
// The stored list
// ---------------------------------------------------------------------------

/** A notification as stored, before the read-time resolution. */
export interface Stored {
  id: string;
  kind: string;
  objectType: string;
  objectId: string;
  actorId: string;
  actorName: string | null;
  objectName: string | null;
  createdAt: string;
  readAt: string | null;
  /** False when the reader can no longer read the object: dropped from every answer (D-P29). */
  visible: boolean;
  /** One of the two labelled exemptions (see the header). */
  exempt?: 'future-kind' | 'malformed-id';
}

function toWire(row: Stored): Json {
  return {
    id: row.id,
    kind: row.kind,
    objectType: row.objectType,
    objectId: row.objectId,
    actor: { id: row.actorId, displayName: row.actorName },
    objectDisplayName: row.objectName,
    createdAt: row.createdAt,
    readAt: row.readAt,
  };
}

/** The contract-valid twin an exempt item is validated as. */
function twin(row: Stored): Stored {
  const { exempt, ...rest } = row;
  if (exempt === 'future-kind') return { ...rest, kind: 'record_assigned', objectType: 'deal' };
  if (exempt === 'malformed-id') return { ...rest, objectId: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5eff' };
  return row;
}

const EXAMPLE_PAGE = clone(at(CONTRACT, 'paths', NOTIFICATIONS_PATH, 'get', 'responses', '200', 'content', 'application/json', 'examples', 'page', 'value')) as {
  data: { id: string; kind: string; objectType: string; objectId: string; actor: { id: string; displayName: string | null }; objectDisplayName: string | null; createdAt: string; readAt: string | null }[];
};

function fromWire(item: (typeof EXAMPLE_PAGE.data)[number]): Stored {
  return {
    id: item.id,
    kind: item.kind,
    objectType: item.objectType,
    objectId: item.objectId,
    actorId: item.actor.id,
    actorName: item.actor.displayName,
    objectName: item.objectDisplayName,
    createdAt: item.createdAt,
    readAt: item.readAt,
    visible: true,
  };
}

/** The contract's example page, newest first: a contact, an account (actor withheld), a deal (read), a task (name withheld), an import. */
export const EXAMPLE: readonly Stored[] = EXAMPLE_PAGE.data.map(fromWire);

function exampleOf(kind: string, objectType: string): Stored {
  const found = EXAMPLE.find((row) => row.kind === kind && row.objectType === objectType);
  if (found === undefined) throw new Error(`${RECORDS_CONTRACT_SOURCE}: the listNotifications example no longer holds a ${kind} on a ${objectType}: re-pin the notifications mock`);
  return found;
}

export const EX_CONTACT = exampleOf('record_assigned', 'contact');
export const EX_ACCOUNT = exampleOf('record_assigned', 'account');
export const EX_DEAL = exampleOf('record_assigned', 'deal');
export const EX_TASK = exampleOf('task_assigned', 'activity');
export const EX_IMPORT = exampleOf('import_finished', 'import');

if (EX_ACCOUNT.actorName !== null || EX_TASK.objectName !== null || EX_DEAL.readAt === null || EX_CONTACT.readAt !== null) {
  throw new Error(`${RECORDS_CONTRACT_SOURCE}: the listNotifications example no longer withholds the account's actor and the task's name, or its read states moved: re-pin the notifications mock`);
}

/** The page's clock in every journey that reads a day or a cadence: ten minutes after the example's newest item. */
export const NOW = '2026-10-18T10:00:00Z';
if (!(Date.parse(NOW) > Date.parse(EXAMPLE[0]?.createdAt ?? NOW))) throw new Error('NOW is not after the example page: re-pin the notifications mock');

/** The reader's timezone in the day-group journey: WAT, UTC+1, no daylight saving. */
export const READER_TIME_ZONE = 'Africa/Lagos';
/** The reader's local date of NOW, and of the day before, in READER_TIME_ZONE. */
export const TODAY = '2026-10-18';
export const YESTERDAY = '2026-10-17';

const ACTOR_ID = EX_CONTACT.actorId;
const OTHER_ACTOR_ID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e09';

function nid(n: number): string {
  return `8a1b2c3d-4e5f-4a6b-8c7d-${n.toString(16).padStart(12, '0')}`;
}

function oid(n: number): string {
  return `3f0c9a52-6d1e-4b8a-9f2e-${(0x100000 + n).toString(16).padStart(12, '0')}`;
}

/** Markup a person's name, or an account's, may hold: drawn as text, never parsed. */
export const HOSTILE_ACTOR = '<img src=x onerror="window.__kasuwaXss=1">Ngozi <b>Okafor</b>';
export const HOSTILE_OBJECT = '<script>window.__kasuwaXss=2</script>Adé <i>Holdings</i>';

/** An account whose actor's and name's text is markup. Unread. */
export const N_MARKUP: Stored = {
  id: nid(0xa001),
  kind: 'record_assigned',
  objectType: 'account',
  objectId: oid(1),
  actorId: OTHER_ACTOR_ID,
  actorName: HOSTILE_ACTOR,
  objectName: HOSTILE_OBJECT,
  createdAt: '2026-10-18T08:00:00Z',
  readAt: null,
  visible: true,
};
/** A contact whose actor and name are both withheld: the generic sentence. Unread. */
export const N_WITHHELD: Stored = {
  id: nid(0xa002),
  kind: 'record_assigned',
  objectType: 'contact',
  objectId: oid(2),
  actorId: OTHER_ACTOR_ID,
  actorName: null,
  objectName: null,
  createdAt: '2026-10-18T07:30:00Z',
  readAt: null,
  visible: true,
};
/** 23:30 UTC on the 17th: 00:30 on the 18th in Lagos. Grouped with TODAY there, never yesterday. Unread. */
export const N_BOUNDARY: Stored = {
  id: nid(0xa003),
  kind: 'record_assigned',
  objectType: 'deal',
  objectId: oid(3),
  actorId: ACTOR_ID,
  actorName: 'Sample Agent',
  objectName: 'Sample boundary renewal',
  createdAt: '2026-10-17T23:30:00Z',
  readAt: null,
  visible: true,
};
/** Yesterday in Lagos: a task, read. */
export const N_YESTERDAY_TASK: Stored = {
  id: nid(0xa004),
  kind: 'task_assigned',
  objectType: 'activity',
  objectId: oid(4),
  actorId: ACTOR_ID,
  actorName: 'Sample Agent',
  objectName: 'Call back about the renewal',
  createdAt: '2026-10-17T15:00:00Z',
  readAt: '2026-10-17T15:10:00Z',
  visible: true,
};
/** Yesterday: an import whose filename was erased with its raw file (D-L148). Read. */
export const N_YESTERDAY_IMPORT: Stored = {
  id: nid(0xa005),
  kind: 'import_finished',
  objectType: 'import',
  objectId: oid(5),
  actorId: ACTOR_ID,
  actorName: 'Sample Agent',
  objectName: null,
  createdAt: '2026-10-17T12:00:00Z',
  readAt: '2026-10-17T12:30:00Z',
  visible: true,
};
/** A kind the contract does not know yet (the first exemption): ignored by the client. */
export const N_FUTURE_KIND: Stored = {
  id: nid(0xa006),
  kind: 'deal_won',
  objectType: 'deal',
  objectId: oid(6),
  actorId: ACTOR_ID,
  actorName: 'Sample Agent',
  objectName: 'Sample future deal',
  createdAt: '2026-10-18T09:55:00Z',
  readAt: null,
  visible: true,
  exempt: 'future-kind',
};
/** An objectId that is not a uuid (the second exemption): drawn with no link. */
export const N_MALFORMED_ID: Stored = {
  id: nid(0xa007),
  kind: 'record_assigned',
  objectType: 'contact',
  objectId: '../../admin/roles',
  actorId: ACTOR_ID,
  actorName: 'Sample Agent',
  objectName: 'Sample odd contact',
  createdAt: '2026-10-18T09:45:00Z',
  readAt: '2026-10-18T09:46:00Z',
  visible: true,
  exempt: 'malformed-id',
};

const FILLER_TYPES: readonly (readonly [kind: string, objectType: string])[] = [
  ['record_assigned', 'contact'],
  ['record_assigned', 'account'],
  ['record_assigned', 'deal'],
  ['task_assigned', 'activity'],
  ['import_finished', 'import'],
];

function filler(index: number): Stored {
  const [kind, objectType] = FILLER_TYPES[index % FILLER_TYPES.length] ?? ['record_assigned', 'contact'];
  const number = String(index + 1).padStart(3, '0');
  const name = objectType === 'import' ? `sample-batch-${number}.csv` : objectType === 'activity' ? `Sample follow-up ${number}` : `Sample Fixture ${objectType} ${number}`;
  return {
    id: nid(0x1000 + index),
    kind,
    objectType,
    objectId: oid(0x1000 + index),
    actorId: ACTOR_ID,
    actorName: 'Sample Agent',
    objectName: name,
    createdAt: new Date(Date.parse('2026-10-16T23:00:00Z') - index * 2 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    readAt: new Date(Date.parse('2026-10-16T23:00:00Z') - index * 2 * 3_600_000 + 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    visible: true,
  };
}

const FILLER_COUNT = 130;
/** The 130 older notifications, newest first, all read by default. */
export const FILLERS: readonly Stored[] = Array.from({ length: FILLER_COUNT }, (_, index) => filler(index));
/** The first filler of each kind and object type: same actor, named objects, so their sentences differ only by type. */
export const FILLER_OF: Readonly<Record<string, Stored>> = Object.fromEntries(
  FILLER_TYPES.map(([, objectType]) => [objectType, FILLERS.find((row) => row.objectType === objectType) as Stored]),
);

/** Every name the mock may serve: for the privacy, markup and en-XA checks. */
export function servedNames(): string[] {
  const rows = [...EXAMPLE, N_MARKUP, N_WITHHELD, N_BOUNDARY, N_YESTERDAY_TASK, N_YESTERDAY_IMPORT, N_FUTURE_KIND, N_MALFORMED_ID, ...FILLERS];
  return [...new Set(rows.flatMap((row) => [row.actorName, row.objectName]).filter((name): name is string => typeof name === 'string'))];
}

/** Names long enough to be unambiguous in a URL, the console or storage. */
export const PII_VALUES: readonly string[] = servedNames().filter((name) => name.length >= 6);

function key(row: Pick<Stored, 'createdAt' | 'id'>): string {
  // Fixed width: seconds-only and millisecond stamps compare as instants.
  return `${new Date(row.createdAt).toISOString()}|${row.id}`;
}

/** Newest first, by createdAt then id, both descending (the contract's order). */
function sortRows(rows: Stored[]): Stored[] {
  return rows.sort((left, right) => (key(left) < key(right) ? 1 : key(left) > key(right) ? -1 : 0));
}

// Load-time checks: everything stored validates, the example is served verbatim, and the cap and window are the contract's.
{
  const all = [...EXAMPLE, N_MARKUP, N_WITHHELD, N_BOUNDARY, N_YESTERDAY_TASK, N_YESTERDAY_IMPORT, N_FUTURE_KIND, N_MALFORMED_ID, ...FILLERS];
  for (const row of all) {
    const problems = validateBody(toWire(twin(row)), schema('Notification'), row.id, CONTRACT, true);
    if (problems.length > 0) throw new Error(`stored notification ${row.id} disagrees with ${RECORDS_CONTRACT_SOURCE}: ${problems.join('; ')}`);
  }
  for (const row of [N_FUTURE_KIND, N_MALFORMED_ID]) {
    if (validateBody(toWire(row), schema('Notification'), row.id, CONTRACT, true).length === 0) {
      throw new Error(`the ${row.exempt} exemption now validates as it is: the contract changed, re-pin the notifications mock`);
    }
  }
  if (new Set(all.map((row) => row.id)).size !== all.length) throw new Error('two stored notifications share an id');
  if (JSON.stringify(EXAMPLE.map(toWire)) !== JSON.stringify(EXAMPLE_PAGE.data)) throw new Error('the top of the stored list is no longer the contract’s example page: re-pin the notifications mock');
  if (COUNT_CAP !== 99 || UNREAD_WINDOW !== 500 || LIMIT_MAX !== 100) throw new Error(`the contract's cap (${COUNT_CAP}), unread window (${UNREAD_WINDOW}) or limit (${LIMIT_MAX}) moved: T-0101's suite must be re-pinned (D-L157)`);
}

/** Opaque, as the contract's example shapes it (base64url JSON of the id); the screen echoes it, never builds one. */
function cursorFor(id: string, salt: string): string {
  return Buffer.from(JSON.stringify({ id, v: salt }), 'utf8').toString('base64url');
}

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export type FailureMode = 500 | 'network';

export interface NotificationsMockOptions {
  /**
   * The journey visits a screen whose own reads this mock does not own (a CRM
   * screen with the bell, the admin console): every other `/api/v1` request
   * falls through to the route registered before this one, or the network.
   */
  readonly otherScreens?: boolean;
  /** Mark the newest N fillers unread (7 + N unread in all). */
  readonly extraUnread?: number;
  /** Every notification read (the "all caught up" frame with items). */
  readonly allRead?: boolean;
  /** No notifications at all (B2 and A3). */
  readonly empty?: boolean;
  /** Add the item of a kind the contract does not know yet (first exemption). */
  readonly futureKind?: boolean;
  /** Add the item whose objectId is not a uuid (second exemption). */
  readonly malformedIds?: boolean;
  /** 110 of the fillers after the first ten are no longer visible: a run longer than the largest page (D-P29 drop). */
  readonly dropped?: boolean;
  /** Calls (1-based, per operation) answered 429 with `Retry-After: retryAfter`. */
  readonly throttle?: Partial<Record<Operation, { readonly calls: readonly number[]; readonly retryAfter: number }>>;
  /** Calls (1-based, per operation) answered with a failure. */
  readonly fail?: Partial<Record<Operation, { readonly calls: readonly number[]; readonly mode: FailureMode }>>;
  /** Calls (1-based, per operation) whose answer is lost on the way back: the change applied (or not), then the connection reset. */
  readonly lose?: Partial<Record<'updateNotification' | 'markAllNotificationsRead', { readonly calls: readonly number[]; readonly applied: boolean }>>;
}

export interface ApiCall {
  readonly operation: Operation;
  readonly url: URL;
  readonly raw: string;
  readonly body: unknown;
  /** The PAGE's clock when the request arrived (ms since the epoch). */
  readonly at: number;
  /**
   * How the mock answered it. A request the page abandoned while it was held
   * may still read as the status the mock sent: watch `requestfailed` for that.
   */
  outcome?: number | 'network' | 'aborted-by-page';
  /** For a listNotifications answered 200: the nextCursor it served. */
  nextCursor?: string | null;
}

export interface Held {
  /** Resolves when a request of the operation arrives and is held. */
  readonly arrived: Promise<ApiCall>;
  /** Answer it, with the body computed when it ARRIVED (a stale answer, if anything changed since). */
  release(): void;
  /** Whether a request has been held yet. */
  isHeld(): boolean;
}

export interface NotificationsMock {
  /** Every /api/v1 request this mock saw, in order. */
  readonly requests: URL[];
  /** Every call to the four operations, in order. */
  readonly calls: ApiCall[];
  /** Other /api/v1 requests let through under `otherScreens`. */
  readonly otherReads: string[];
  /** The shell's own getCurrentUser reads (T-0130's avatar), answered here unless `otherScreens` (T-0148). */
  readonly shellReads: string[];
  /** Contract breaches by the SCREEN. Must be empty at the end of every test. */
  readonly violations: string[];
  /** Answers the MOCK built that its contract rejects. Must be empty, always. */
  readonly mockFaults: string[];
  callsOf(operation: Operation): ApiCall[];
  /** Requests received and not yet answered (held ones included). */
  inFlight(): number;
  /** Requests received and not yet answered, held ones excluded: what a settle waits for. */
  busy(): number;
  /** The count getNotificationUnreadCount would answer now. */
  unread(): { count: number; capped: boolean };
  /** Whether a stored notification is read now. */
  isRead(id: string): boolean;
  /** Visible notifications in the contract's order, for a filter and kind. */
  visibleOrder(filter?: string, kind?: string): string[];
  /** Ids served in any list answer so far. */
  served(): string[];
  /** The last nextCursor served (undefined before any list answer). */
  lastNextCursor(): string | null | undefined;
  /** New unread notifications, created now on the page's clock, newest first. Returns their ids. */
  arrive(count: number, kind?: string): Promise<string[]>;
  /** Mark stored notifications read or unread, as if from another tab. */
  setRead(ids: readonly string[], read: boolean): void;
  /** The reader can no longer read this notification's object: dropped from answers, 404 on PATCH. */
  hide(id: string): void;
  /** Fail every later call of an operation, until `recover`. */
  failAll(operation: Operation, modes: readonly FailureMode[]): void;
  recover(operation: Operation): void;
  /** Hold the next request of an operation until `release()`. */
  holdNext(operation: Operation): Held;
}

export async function installNotificationsMock(page: Page, options: NotificationsMockOptions = {}): Promise<NotificationsMock> {
  const requests: URL[] = [];
  const calls: ApiCall[] = [];
  const otherReads: string[] = [];
  const shellReads: string[] = [];
  const violations: string[] = [];
  const mockFaults: string[] = [];

  const rows: Stored[] = [];
  if (options.empty !== true) {
    rows.push(...clone([...EXAMPLE, N_MARKUP, N_WITHHELD, N_BOUNDARY, N_YESTERDAY_TASK, N_YESTERDAY_IMPORT, ...FILLERS]));
    if (options.futureKind === true) rows.push(clone(N_FUTURE_KIND));
    if (options.malformedIds === true) rows.push(clone(N_MALFORMED_ID));
  }
  sortRows(rows);
  const fillerIds = new Set(FILLERS.map((row) => row.id));
  if (options.extraUnread !== undefined) {
    for (const row of rows.filter((entry) => fillerIds.has(entry.id)).slice(0, options.extraUnread)) row.readAt = null;
  }
  if (options.allRead === true) {
    for (const row of rows) row.readAt ??= isoSeconds(Date.parse(row.createdAt) + 60_000);
  }
  if (options.dropped === true) {
    for (const row of rows.filter((entry) => fillerIds.has(entry.id)).slice(10, 120)) row.visible = false;
  }

  const servedIds = new Set<string>();
  /** For each kind (and '*'), the newest key of an item served UNREAD. */
  const newestUnreadServed = new Map<string, string>();
  const servedCursors = new Map<string, { filter: string; kind: string; afterKey: string }>();
  let lastNext: string | null | undefined;
  const deadIds = new Set<string>();
  const counts = new Map<Operation, number>();
  const throttledUntil = new Map<Operation, number>();
  const failing = new Map<Operation, { modes: readonly FailureMode[]; index: number }>();
  const holds = new Map<Operation, { resolve: (call: ApiCall) => void; released: Promise<void>; release: () => void; held: boolean }>();
  let pending = 0;
  let heldNow = 0;
  let arrivals = 0;
  let lastPageNow = Date.now();

  const pageNow = async (): Promise<number> => {
    try {
      lastPageNow = await page.evaluate(() => Date.now());
    } catch {
      // The page is between documents; the last reading stands.
    }
    return lastPageNow;
  };

  const find = (id: string): Stored | undefined => rows.find((row) => row.id === id);

  const unread = (): { count: number; capped: boolean } => {
    const window = rows.filter((row) => row.readAt === null).slice(0, UNREAD_WINDOW);
    // The server counts every kind it knows, a kind this client does not know included.
    const visible = window.filter((row) => row.visible).length;
    return { count: Math.min(visible, COUNT_CAP), capped: visible > COUNT_CAP };
  };

  const send = async (route: Route, call: ApiCall, status: number, body: unknown, headers: Record<string, string> = {}): Promise<void> => {
    if (status === 500) {
      mockFaults.push(...validateBody(body, at(ADMIN_CONTRACT, 'components', 'schemas', 'Error'), 'internal_error', ADMIN_CONTRACT, true));
    } else if (call.operation === 'listNotifications' && status === 200 && isJson(body) && Array.isArray(body.data)) {
      // The two labelled exemptions are validated as their contract twins.
      const validated = {
        ...body,
        data: (body.data as Json[]).map((item) => {
          const stored = find(String(item.id));
          return stored?.exempt === undefined ? item : toWire(twin(stored));
        }),
      };
      mockFaults.push(...answerProblems(call.operation, status, validated));
    } else {
      mockFaults.push(...answerProblems(call.operation, status, body));
    }
    const all = { 'cache-control': 'no-store', ...headers };
    for (const name of status === 500 ? [] : requiredHeaders(call.operation, status)) {
      if (!(name in all)) mockFaults.push(`${call.operation} ${status} answered without its required ${name} header`);
    }
    try {
      await route.fulfill({ status, contentType: 'application/json', headers: all, body: JSON.stringify(body) });
      call.outcome = status;
    } catch {
      call.outcome = 'aborted-by-page';
    }
  };

  const drop = async (route: Route, call: ApiCall): Promise<void> => {
    try {
      await route.abort('connectionreset');
      call.outcome = 'network';
    } catch {
      call.outcome = 'aborted-by-page';
    }
  };

  const refusal = (operation: Operation, status: number, name: string | undefined, details?: readonly { path: string; code: string }[]): Json => {
    const body = responseBody(operation, status, name);
    if (details !== undefined) body.details = details.map((detail) => ({ ...detail }));
    return body;
  };

  const badParameters = (call: ApiCall): boolean => {
    const allowed = parameterNames(call.operation);
    let bad = false;
    for (const name of new Set(call.url.searchParams.keys())) {
      if (!allowed.includes(name)) {
        violations.push(`${call.operation} declares no "${name}" parameter (scope is the session's, and there is no total or offset)`);
        bad = true;
      }
      if (call.url.searchParams.getAll(name).length > 1) {
        violations.push(`${call.operation} was sent "${name}" more than once (kind is one kind, not a list)`);
        bad = true;
      }
    }
    return bad;
  };

  // ----- listNotifications ---------------------------------------------------

  const list = (call: ApiCall): { status: number; body: Json } => {
    if (badParameters(call)) return { status: 400, body: refusal('listNotifications', 400, 'invalidFilter') };
    const filter = call.url.searchParams.get('filter') ?? 'all';
    const kind = call.url.searchParams.get('kind') ?? '';
    const limitText = call.url.searchParams.get('limit');
    const limit = limitText === null ? LIMIT_DEFAULT : Number(limitText);
    if (!FILTERS.includes(filter)) {
      violations.push(`listNotifications filter=${filter} is not one of ${FILTERS.join(', ')}`);
      return { status: 400, body: refusal('listNotifications', 400, 'invalidFilter') };
    }
    if (kind !== '' && !KINDS.includes(kind)) {
      violations.push(`listNotifications kind=${kind} is not a known kind`);
      return { status: 400, body: refusal('listNotifications', 400, 'invalidKind') };
    }
    if (!(Number.isInteger(limit) && limit >= 1 && limit <= LIMIT_MAX)) {
      violations.push(`listNotifications limit=${limitText ?? ''} is outside 1..${LIMIT_MAX} (never clamped)`);
      return { status: 400, body: refusal('listNotifications', 400, 'invalidFilter', [{ path: 'limit', code: 'invalid_value' }]) };
    }
    const cursor = call.url.searchParams.get('cursor');
    let afterKey: string | undefined;
    if (cursor !== null) {
      const served = servedCursors.get(cursor);
      if (served === undefined) {
        violations.push('listNotifications was sent a cursor the mock never served (echo nextCursor unchanged)');
        return { status: 400, body: refusal('listNotifications', 400, 'invalidCursor') };
      }
      if (served.filter !== filter || served.kind !== kind) {
        violations.push(`listNotifications sent a cursor served for filter=${served.filter} kind=${served.kind || '(any)'} with filter=${filter} kind=${kind || '(any)'}: a filter change starts at the top`);
      }
      afterKey = served.afterKey;
    }
    const candidates = rows.filter((row) => (filter === 'unread' ? row.readAt === null : true) && (kind === '' ? true : row.kind === kind) && (afterKey === undefined || key(row) < afterKey));
    const examined = candidates.slice(0, limit);
    const data = examined.filter((row) => row.visible);
    for (const row of data) {
      servedIds.add(row.id);
      if (row.readAt === null) {
        for (const bucket of ['*', row.kind]) {
          const current = newestUnreadServed.get(bucket);
          if (current === undefined || key(row) > current) newestUnreadServed.set(bucket, key(row));
        }
      }
    }
    const last = examined.at(-1);
    let nextCursor: string | null = null;
    if (candidates.length > examined.length && last !== undefined) {
      nextCursor = cursorFor(last.id, `${filter}:${kind}:${servedCursors.size}`);
      servedCursors.set(nextCursor, { filter, kind, afterKey: key(last) });
    }
    lastNext = nextCursor;
    call.nextCursor = nextCursor;
    return { status: 200, body: { data: data.map(toWire), nextCursor } };
  };

  // ----- updateNotification ---------------------------------------------------

  const update = (call: ApiCall, id: string, apply: boolean, now: number): { status: number; body: Json } => {
    if (!UUID_PATTERN.test(id)) {
      violations.push('updateNotification was sent an id that is not a uuid');
      return { status: 400, body: refusal('updateNotification', 400, 'invalidRead', [{ path: 'notificationId', code: 'invalid_value' }]) };
    }
    const problems = validateBody(call.body, schema('UpdateNotificationRequest'), '');
    if (problems.length > 0) {
      violations.push(`updateNotification: ${problems.join('; ')}`);
      return { status: 400, body: refusal('updateNotification', 400, 'invalidRead') };
    }
    if (!servedIds.has(id)) violations.push('updateNotification named a notification the screen was never served');
    if (deadIds.has(id)) violations.push('updateNotification was sent again for a notification the API answered 404 for: it is gone from the reader’s view');
    const row = find(id);
    if (row === undefined || !row.visible) {
      deadIds.add(id);
      return { status: 404, body: refusal('updateNotification', 404, undefined) };
    }
    if (apply) {
      const read = (call.body as { read: boolean }).read;
      row.readAt = read ? (row.readAt ?? isoSeconds(now)) : null;
    }
    return { status: 200, body: toWire(row) };
  };

  // ----- markAllNotificationsRead ---------------------------------------------

  const readAll = (call: ApiCall, apply: boolean, now: number): { status: number; body: Json } => {
    const problems = validateBody(call.body, schema('MarkAllNotificationsReadRequest'), '');
    if (!isJson(call.body) || problems.length > 0) {
      violations.push(`markAllNotificationsRead: ${problems.join('; ') || 'not a JSON object'}`);
      return { status: 400, body: refusal('markAllNotificationsRead', 400, 'invalidKind') };
    }
    const kind = typeof call.body.kind === 'string' ? call.body.kind : '';
    const throughId = typeof call.body.throughId === 'string' ? call.body.throughId : undefined;
    if (throughId === undefined) {
      violations.push('markAllNotificationsRead was sent without a throughId: a notification that arrives after the reader looked would be marked read too (D-L154)');
    } else {
      if (!servedIds.has(throughId)) violations.push('markAllNotificationsRead bounded by a notification the screen was never served');
      const through = find(throughId);
      const newest = newestUnreadServed.get(kind === '' ? '*' : kind);
      if (through !== undefined && newest !== undefined && key(through) < newest) {
        violations.push(`markAllNotificationsRead stops short of what the reader saw: an unread ${kind || 'notification'} newer than throughId was drawn`);
      }
      if (through === undefined) return { status: 400, body: refusal('markAllNotificationsRead', 400, 'invalidThroughId') };
    }
    if (apply) {
      const bound = throughId === undefined ? undefined : find(throughId);
      for (const row of rows) {
        if (row.readAt !== null) continue;
        if (kind !== '' && row.kind !== kind) continue;
        if (bound !== undefined && key(row) > key(bound)) continue;
        row.readAt = isoSeconds(now);
      }
    }
    return { status: 200, body: unread() };
  };

  // ----- the route -------------------------------------------------------------

  await page.route(
    (url) => url.pathname.startsWith('/api/v1/'),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const ours = url.pathname === NOTIFICATIONS_PATH || url.pathname.startsWith(`${NOTIFICATIONS_PATH}/`);
      if (!ours && options.otherScreens === true) {
        otherReads.push(`${method} ${url.pathname.replace(/[^/]{40,}/g, '<long>')}`);
        await route.fallback();
        return;
      }
      requests.push(url);
      const raw = request.postData() ?? '';
      let body: unknown;
      try {
        body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
      } catch {
        body = undefined;
      }
      for (const header of Object.keys(request.headers())) {
        if (/programme|tenant|scope/i.test(header)) violations.push(`${method} ${url.pathname} was sent a "${header}" header: scope is never supplied`);
      }
      if (url.searchParams.has('programmeId') || url.searchParams.has('programmeIds')) violations.push(`${method} ${url.pathname} was sent a programme in its query: scope is the session's (CLAUDE.md 2.2)`);
      const href = decodeURIComponent(`${url.pathname}${url.search}`);
      for (const value of PII_VALUES) {
        if (href.includes(value)) violations.push(`${method} ${url.pathname} put a name in a URL`);
      }

      // T-0148 (T-0130): the CRM and admin shells read the signed-in person's name ONCE per page load for the
      // avatar's initials. It is the shell's read, not the notification screens': answered from the auth
      // contract, checked like theirs (GET only, no query, no scope; the checks above), and kept apart in
      // `shellReads`. Anything else under /api/v1 is still a violation.
      if (url.pathname === ME_PATH) {
        if (method !== 'GET' || url.search !== '' || raw !== '') {
          violations.push(`${method} ${ME_PATH}${url.search === '' ? '' : ' with a query'}${raw === '' ? '' : ' with a body'} is not getCurrentUser`);
        }
        shellReads.push(`${method} ${ME_PATH}`);
        const problems = meProblems(CURRENT_USER);
        if (problems.length > 0) mockFaults.push(...problems.map((problem) => `getCurrentUser 200: ${problem}`));
        await route
          .fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(CURRENT_USER) })
          .catch(() => undefined);
        return;
      }

      const segments = url.pathname.split('/').map((segment) => decodeURIComponent(segment));
      let operation: Operation | undefined;
      let id = '';
      if (url.pathname === NOTIFICATIONS_PATH && method === 'GET') operation = 'listNotifications';
      else if (url.pathname === `${NOTIFICATIONS_PATH}/unread-count` && method === 'GET') operation = 'getNotificationUnreadCount';
      else if (url.pathname === `${NOTIFICATIONS_PATH}/read-all` && method === 'POST') operation = 'markAllNotificationsRead';
      else if (segments.length === 5 && segments[3] === 'notifications' && method === 'PATCH' && segments[4] !== 'read-all' && segments[4] !== 'unread-count') {
        operation = 'updateNotification';
        id = segments[4] ?? '';
      }

      if (operation === undefined) {
        violations.push(`${method} ${url.pathname.replace(/[^/]{40,}/g, '<long>')} is not an operation the notification screens use`);
        await route
          .fulfill({ status: 404, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(refusal('updateNotification', 404, undefined)) })
          .catch(() => undefined);
        return;
      }

      const now = await pageNow();
      const call: ApiCall = { operation, url, raw, body, at: now };
      calls.push(call);
      pending += 1;
      try {
        const index = (counts.get(operation) ?? 0) + 1;
        counts.set(operation, index);
        if (raw !== '' && body === undefined) violations.push(`${operation} was sent a body that is not JSON`);
        if (raw !== '' && !/^application\/json\b/i.test(request.headers()['content-type'] ?? '')) violations.push(`${operation} was sent a body that is not application/json`);
        if (operation === 'getNotificationUnreadCount' || operation === 'listNotifications') {
          if (raw !== '') violations.push(`${operation} is a GET and takes no body`);
        }
        if (operation === 'getNotificationUnreadCount' && [...url.searchParams.keys()].length > 0) {
          violations.push('getNotificationUnreadCount takes no parameter (per-kind counts are not served)');
        }

        const until = throttledUntil.get(operation) ?? 0;
        if (now < until - 250) {
          violations.push(`${operation} was sent ${Math.round((until - now) / 100) / 10} s before the 429's Retry-After ran out: the screen must wait, not hammer (D-L134)`);
        }

        // Compute the answer NOW (a held request answers with what was true when it arrived).
        let status = 200;
        let answer: Json = {};
        let headers: Record<string, string> = {};
        let failure: FailureMode | undefined;
        let lostApplied: boolean | undefined;

        const throttle = options.throttle?.[operation];
        const failOnce = options.fail?.[operation];
        const failingNow = failing.get(operation);
        const lose = operation === 'updateNotification' || operation === 'markAllNotificationsRead' ? options.lose?.[operation] : undefined;
        if (throttle !== undefined && throttle.calls.includes(index)) {
          throttledUntil.set(operation, now + throttle.retryAfter * 1000);
          status = 429;
          answer = refusal(operation, 429, 'tooManyRequests');
          headers = { 'retry-after': String(throttle.retryAfter) };
        } else if (failingNow !== undefined) {
          failure = failingNow.modes[failingNow.index % failingNow.modes.length] ?? 500;
          failingNow.index += 1;
        } else if (failOnce !== undefined && failOnce.calls.includes(index)) {
          failure = failOnce.mode;
        } else {
          if (lose !== undefined && lose.calls.includes(index)) lostApplied = lose.applied;
          const apply = lostApplied ?? true;
          const result =
            operation === 'listNotifications'
              ? list(call)
              : operation === 'getNotificationUnreadCount'
                ? { status: 200, body: unread() as unknown as Json }
                : operation === 'updateNotification'
                  ? update(call, id, apply, now)
                  : readAll(call, apply, now);
          status = result.status;
          answer = result.body;
        }

        const hold = holds.get(operation);
        if (hold !== undefined && !hold.held) {
          hold.held = true;
          heldNow += 1;
          hold.resolve(call);
          await hold.released;
          heldNow -= 1;
          holds.delete(operation);
        }

        if (failure === 'network' || lostApplied !== undefined) {
          await drop(route, call);
          return;
        }
        if (failure === 500) {
          await send(route, call, 500, { statusCode: 500, error: 'Internal Server Error', code: 'internal_error', message: 'Internal server error' });
          return;
        }
        await send(route, call, status, answer, headers);
      } finally {
        pending -= 1;
      }
    },
  );

  return {
    requests,
    calls,
    otherReads,
    shellReads,
    violations,
    mockFaults,
    callsOf: (operation: Operation) => calls.filter((call) => call.operation === operation),
    inFlight: () => pending,
    busy: () => pending - heldNow,
    unread,
    isRead: (id: string) => {
      const row = find(id);
      return row !== undefined && row.readAt !== null;
    },
    visibleOrder: (filter = 'all', kind = '') => rows.filter((row) => row.visible && (filter === 'unread' ? row.readAt === null : true) && (kind === '' || row.kind === kind)).map((row) => row.id),
    served: () => [...servedIds],
    lastNextCursor: () => lastNext,
    arrive: async (count: number, kind = 'record_assigned') => {
      const now = await pageNow();
      const objectType = KIND_OBJECTS[kind]?.[0] ?? 'contact';
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) {
        arrivals += 1;
        const row: Stored = {
          id: nid(0xb000 + arrivals),
          kind,
          objectType,
          objectId: oid(0xb000 + arrivals),
          actorId: ACTOR_ID,
          actorName: 'Sample Agent',
          objectName: `Sample arrival ${String(arrivals).padStart(3, '0')}`,
          // Millisecond precision: arrivals in one second still sort, newest first, by createdAt then id.
          createdAt: new Date(now).toISOString(),
          readAt: null,
          visible: true,
        };
        mockFaults.push(...validateBody(toWire(row), schema('Notification'), row.id, CONTRACT, true));
        rows.push(row);
        ids.push(row.id);
      }
      sortRows(rows);
      return ids;
    },
    setRead: (ids: readonly string[], read: boolean) => {
      for (const id of ids) {
        const row = find(id);
        if (row !== undefined) row.readAt = read ? (row.readAt ?? isoSeconds(lastPageNow)) : null;
      }
    },
    hide: (id: string) => {
      const row = find(id);
      if (row !== undefined) row.visible = false;
    },
    failAll: (operation: Operation, modes: readonly FailureMode[]) => {
      failing.set(operation, { modes, index: 0 });
    },
    recover: (operation: Operation) => {
      failing.delete(operation);
    },
    holdNext: (operation: Operation): Held => {
      let resolveArrived: (call: ApiCall) => void = () => undefined;
      const arrived = new Promise<ApiCall>((done) => {
        resolveArrived = done;
      });
      let release: () => void = () => undefined;
      const released = new Promise<void>((done) => {
        release = done;
      });
      const entry = { resolve: resolveArrived, released, release, held: false };
      holds.set(operation, entry);
      return { arrived, release: () => entry.release(), isHeld: () => entry.held };
    },
  };
}
