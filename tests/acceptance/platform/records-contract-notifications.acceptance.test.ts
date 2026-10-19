import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * ACCEPTANCE — T-0099, the records API contract for IN-APP NOTIFICATIONS
 * (P26 frames A, A1, A3, B and B2; D-P29, ADR-0018, D-L87, D-L134, D-L146,
 * D-L151, D-L97). Agent 1 serves it (T-0100) and Agent 11 draws it (T-0101)
 * on mocks first. Contract only: no route, no migration, no code, no
 * database. Written by QA for the lead from the invariants (D-L23, D-L25),
 * before the build.
 *
 * The artefacts under test are `docs/api/records.openapi.yaml` and, for the
 * shared Error envelope's `code` enum only, `docs/api/admin.openapi.yaml`.
 * Both are read as data (parsed YAML, never a regex over the raw text, so a
 * keyword in a YAML comment satisfies nothing). The T-0039 suite keeps the
 * whole-file rules (every `$ref` resolves, unique operationIds, one Error
 * schema, every operation documents 401 and carries x-kasuwa-screens); this
 * suite does not repeat them. Schema rules are checked BEHAVIOURALLY where
 * they can be: a small validator runs fixed accept and refuse cases against
 * the published schema, so the builder chooses the JSON-Schema spelling and
 * the suite only cares what the schema admits.
 *
 * ---------------------------------------------------------------------------
 * PINNED INTERFACES (every name the task file leaves open is a ruling below)
 * ---------------------------------------------------------------------------
 *
 * OPERATIONS (all `x-kasuwa-implemented: false`, tag `notifications`)
 *   listNotifications           GET   /api/v1/notifications
 *                               200 NotificationPage           P26/A A3 B B2
 *   getNotificationUnreadCount  GET   /api/v1/notifications/unread-count
 *                               200 NotificationUnreadCount    P26/A A1
 *   updateNotification          PATCH /api/v1/notifications/{notificationId}
 *                               200 Notification               P26/A B
 *   markAllNotificationsRead    POST  /api/v1/notifications/read-all
 *                               200 NotificationUnreadCount    P26/A1 B
 *
 * PARAMETERS
 *   listNotifications           query exactly `filter` (NotificationFilter,
 *                               default `all`), `kind` (NotificationKind),
 *                               `cursor` (the `NotificationCursor` parameter
 *                               component) and `limit` (1..100).
 *   getNotificationUnreadCount  none.
 *   updateNotification          path `notificationId` (uuid) only.
 *   markAllNotificationsRead    none.
 *
 * SCHEMAS (records.openapi.yaml, components.schemas)
 *   NotificationKind        record_assigned task_assigned import_finished
 *   NotificationObjectType  contact account deal activity import
 *   NotificationFilter      all unread
 *   Notification            closed { id, kind, objectType, objectId, actor,
 *                           objectDisplayName, createdAt, readAt }, all
 *                           required; kind and objectType coupled (R2)
 *   NotificationActor       closed { id, displayName: string | null }
 *   NotificationPage        closed { data: Notification[], nextCursor }
 *   NotificationUnreadCount closed { count: 0..99, capped: boolean }
 *   UpdateNotificationRequest       closed { read: boolean }, required
 *   MarkAllNotificationsReadRequest closed { kind?: NotificationKind,
 *                           throughId?: uuid } (D-L154)
 *
 * RESPONSES (components.responses)
 *   NotificationNotFound          updateNotification's 404: one body
 *   NotificationsTooManyRequests  the 429 of all four, with `Retry-After`
 *
 * EXTENSIONS (data, so a screen and the server read one table)
 *   x-kasuwa-notification-kinds on listNotifications: exactly
 *     { record_assigned: [contact, account, deal], task_assigned: [activity],
 *       import_finished: [import] }
 *   x-kasuwa-notification-display-fields on listNotifications: exactly
 *     { contact: displayName, account: name, deal: name, activity: subject,
 *       import: filename }, each a property of its record schema
 *   x-kasuwa-poll-interval-seconds on getNotificationUnreadCount: 30
 *
 * ERRORS (no new Error.code; `too_many_requests` exists since D-L134)
 *   400 validation_failed, `{ path, code }` only:
 *     listNotifications     cursor invalid_cursor; kind invalid_value;
 *                           filter invalid_value
 *     updateNotification    read invalid_value
 *     markAllNotificationsRead kind invalid_value; throughId invalid_value
 *                           (unknown and someone else's alike, D-L154)
 *   404 not_found           updateNotification only (NotificationNotFound)
 *   429 too_many_requests   all four (NotificationsTooManyRequests)
 *   No 403 anywhere: a notification is the recipient's own, and anything
 *   else is 404.
 *
 * ---------------------------------------------------------------------------
 * RULINGS (proposed to the lead; R-numbers are this suite's, not decision ids)
 * ---------------------------------------------------------------------------
 *
 *   R1  Operation ids, paths, schema, response and extension names are as
 *       pinned above. The four operations carry tag `notifications`,
 *       declared at the top of the file, and screens from P26/A, A1, A3, B
 *       and B2 only. Hidden frames (A2 critical alerts, C toasts, D and D1
 *       preferences, E to E2 push) and approvals are not served (D-L87,
 *       D-P29: in-app only).
 *   R2  KINDS (D-L87): `NotificationKind` is closed today and GROW-ONLY: a
 *       later kind is an additive contract change, and a client ignores an
 *       item whose kind it does not know rather than failing the page. The
 *       kind fixes the object type, as data in `x-kasuwa-notification-kinds`
 *       and enforced by the schema: record_assigned names a contact, account
 *       or deal (a lead is a contact); task_assigned an activity;
 *       import_finished an import.
 *   R3  WHAT AN ITEM IS (D-P29, ADR-0018): `Notification` is exactly the
 *       stored identifiers (id, kind, objectType, objectId, actor id) plus
 *       what is resolved at read time (`actor.displayName`,
 *       `objectDisplayName`) and the two times. It is closed. No title,
 *       body, message, sentence, label, icon, link, programme, payload or
 *       value: the client builds the sentence from `kind` with i18n. The
 *       only strings that are not an enum, a uuid or a UTC time are the two
 *       display names (and the opaque `nextCursor`).
 *   R4  DISPLAY NAMES, AT READ TIME. `objectDisplayName` is the object's
 *       field named in `x-kasuwa-notification-display-fields` (contact
 *       `displayName`, account `name`, deal `name`, activity `subject`,
 *       import `filename`), read now under the reader's scope and field
 *       security in the object's programme. It is `null` when that field is
 *       withheld from the reader, empty, or erased (an import's filename is
 *       cleared with its raw file, D-L148). 1..255 characters otherwise.
 *       A contact's name follows its parts, as search's R8 settled D-L68:
 *       `null` whenever `givenNames` or `familyName` is withheld from the
 *       reader, never composed from the readable part (otherwise the
 *       notification list would undo field security on the name parts).
 *       Unlike a record, a notification is a summary: `null` here may mean
 *       withheld, as on DuplicateContact and ContactMergeParty (T-0093).
 *   R5  THE ACTOR. `actor` is always present (Phase 2 has no system event:
 *       an import's actor is the user who started it, ADR-0018 Q2).
 *       `actor.displayName` is the actor's current display name while they
 *       are a member of the object's programme, else `null` (the D-P23
 *       former-owner rule): a notification is current state, re-read every
 *       time, not a historical record like TimelineActor. Never the id
 *       printed as a name (D-L64); no email, phone, role or avatar.
 *   R6  DROPPED, NOT REDACTED (D-P29). An item whose object the reader can
 *       no longer read (the object's own read would answer 404: out of
 *       scope, programme left, rights lost, a contact merged away under
 *       D-P27) is left out of the page, out of the unread count, and is
 *       `404` to updateNotification. It is never sent with its names
 *       nulled.
 *   R7  PAGING. Keyset, newest first by `createdAt` then `id`, both
 *       descending. The cursor carries ONLY a notification id, never a
 *       time, a kind, a filter, a name or any other value; the server
 *       resolves the position from that row, which is the caller's own even
 *       when its object is no longer visible. A cursor naming another
 *       user's notification answers an empty page (no oracle). The server
 *       examines at most `limit` of the caller's notifications per page and
 *       returns the visible ones among them, so a page's cost is bounded and
 *       a page may hold FEWER than `limit` items, even none, while
 *       `nextCursor` is non-null. Only `nextCursor: null` means the end.
 *       No total, count or offset (D-P13).
 *   R8  THE UNREAD COUNT. `{ count, capped }`: the caller's unread
 *       notifications that would appear in the list now (R6), up to 99.
 *       When there are more than 99, `count` is 99 and `capped` is true
 *       (the "99+" badge, P26/A1); otherwise `capped` is false. It takes no
 *       parameter. Per-kind counts (A1's "noisy types" summary) and a
 *       list-valued `kind` are OUT for Phase 2 (D-L154): not served, and
 *       not to be added by the build.
 *   R9  READ AND UNREAD. `PATCH { read: true }` sets `readAt` (an
 *       already-read item keeps its first `readAt`: idempotent); `{ read:
 *       false }` clears it ("click the dot to toggle read", P26/A). The
 *       answer is the item, names resolved as in the list.
 *   R10 READ ALL. `POST /read-all { kind? }` marks every unread notification
 *       of the caller read, or only those of `kind` (A1's "clear
 *       assignments in one tap"; assignments are two kinds today, so that
 *       is two calls). It covers items whose object is no longer visible
 *       too, which changes nothing anyone can see. The body is required and
 *       may be `{}`. The answer is the new `NotificationUnreadCount`, never
 *       a count of rows changed (which would count invisible items).
 *       THE RACE (D-L154): an optional `throughId` (a uuid, and only ever a
 *       notification id) bounds it: only notifications at or older than that
 *       one, by `createdAt` then `id`, are marked read, so one that arrives
 *       after the caller looked stays unread. A `throughId` that names no
 *       notification and one that names another user's (or another
 *       tenant's) are the same `400 validation_failed` with
 *       `details[].code: invalid_value` at `throughId`: it never says
 *       whether the id exists. The caller's own notification whose object
 *       is no longer visible is a valid bound (like the cursor, R7): it is
 *       their own row and reveals nothing.
 *   R11 404, ONE BODY. updateNotification answers one `404 not_found` body
 *       (`NotificationNotFound`, its example identical to `NotFound`'s) for
 *       no such notification, another user's in this tenant, another
 *       tenant's, and one whose object the caller can no longer read. No
 *       operation answers 403.
 *   R12 THE THROTTLE (D-L134, as D-L151 did for listDuplicates): all four
 *       operations answer `429 too_many_requests` through their own
 *       response component, `NotificationsTooManyRequests`, with a
 *       `Retry-After` header (integer seconds, at least 1) and `no-store`.
 *       Per user, decided after authentication and before validation.
 *   R13 POLLING (D-L87: polling, no socket in Phase 2). The recommended
 *       interval is data, `x-kasuwa-poll-interval-seconds: 30`, on
 *       getNotificationUnreadCount: the client polls the COUNT, only while
 *       the page is visible, fetches the list when the bell or the centre
 *       opens, and on a 429 waits `Retry-After` before resuming.
 *   R14 NO CREATE, NO DELETE. Notifications come only from events (the
 *       outbox consumer, ADR-0018 point 8). No operation creates, replaces
 *       or deletes one; the only operations under `/api/v1/notifications`
 *       are the four above. An assignment the recipient made themselves
 *       produces no notification. Read notifications are kept 90 days
 *       (D-L146); the purge is the deferred follow-up.
 *   R15 Every answer of every new operation, errors included, is
 *       `Cache-Control: no-store` (names are personal data). None is
 *       audited.
 *   R16 EXAMPLES (D-L97). Every example on the new operations validates and
 *       is coherent: newest first; each kind shown; a withheld object name
 *       and a former-member actor shown as null; a page with no items and a
 *       non-null `nextCursor` (R7); a capped count is 99. Every name in them
 *       is synthetic (contains Sample, Fixture, Example or Test); no
 *       phone- or email-like string; no cursor that decodes to a time, a
 *       kind or a name. Every OTHER example in the file still validates and
 *       every e2e mock that reads the contract still loads.
 *
 * LEAD EDITS TO MERGED SUITES: none were needed to admit the contract. A
 * draft contract that passes this suite was run against every merged
 * contract suite; none of their guards refuses the four operations.
 * Separately (D-L154), the "every e2e mock … still loads" guards in
 * records-contract-import (T-0093) and custom-fields-contract (T-0088) were
 * observed timing out at vitest's 5 s default under load on main; each now
 * has an explicit 60 s timeout, and nothing else in them changed.
 * NOT a suite edit, for the builder: `team/FEATURES.md` is generated from the
 * contract (`pnpm features`), so the features-register suite fails until it is
 * regenerated in the same change.
 *
 * ---------------------------------------------------------------------------
 *
 * D-L23: on main the file has none of this. Every test then fails naming the
 * missing operation, schema, response or extension rather than crashing at
 * collection: the specs are loaded lazily. Each negative invariant and each
 * self-check of a helper first requires the contract piece it guards
 * (`gate()`), so none passes on a file without it. The two regression guards
 * at the end (every OTHER example still validates; every e2e mock still
 * loads) hold on main by design: they protect what exists, and say so where
 * they are written.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const RECORDS_REL = 'docs/api/records.openapi.yaml';
const RECORDS = resolve(repoRoot, RECORDS_REL);
const E2E_SUPPORT = resolve(repoRoot, 'tests/e2e/support');

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The text with every run of whitespace collapsed, so a phrase may wrap. */
function prose(text: unknown): string {
  return str(text).replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Loading and $ref resolution (the T-0039 suite's loader, unchanged in kind)
// ---------------------------------------------------------------------------

function posix(file: string): string {
  return relative(repoRoot, file).split('\\').join('/');
}

const docCache = new Map<string, { doc: unknown; error: string | null }>();

function loadDoc(file: string): { doc: unknown; error: string | null } {
  const cached = docCache.get(file);
  if (cached) return cached;
  let entry: { doc: unknown; error: string | null };
  if (!existsSync(file)) {
    entry = { doc: undefined, error: `${posix(file)} does not exist` };
  } else {
    try {
      entry = { doc: parse(readFileSync(file, 'utf8')) as unknown, error: null };
    } catch (error) {
      entry = { doc: undefined, error: `${posix(file)} is not valid YAML: ${(error as Error).message}` };
    }
  }
  docCache.set(file, entry);
  return entry;
}

function spec(file: string = RECORDS): Mapping {
  const { doc, error } = loadDoc(file);
  if (error !== null) throw new Error(`${error} — the contract is missing.`);
  if (!isMapping(doc)) throw new Error(`${posix(file)} does not parse to a mapping`);
  return doc;
}

interface Located {
  node: unknown;
  file: string;
}

function resolveRef(ref: string, fromFile: string): Located | undefined {
  const hash = ref.indexOf('#');
  const filePart = hash === -1 ? ref : ref.slice(0, hash);
  const pointer = hash === -1 ? '' : ref.slice(hash + 1);
  const file = filePart === '' ? fromFile : resolve(dirname(fromFile), filePart);
  const { doc, error } = loadDoc(file);
  if (error !== null) return undefined;
  let node: unknown = doc;
  if (pointer !== '') {
    if (!pointer.startsWith('/')) return undefined;
    for (const raw of pointer.slice(1).split('/')) {
      const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      if (Array.isArray(node)) {
        node = node[Number(key)];
      } else if (isMapping(node) && key in node) {
        node = node[key];
      } else {
        return undefined;
      }
    }
  }
  return node === undefined ? undefined : { node, file };
}

function deref(located: Located): Located {
  let current = located;
  for (let hops = 0; hops < 32; hops += 1) {
    if (!isMapping(current.node) || typeof current.node.$ref !== 'string') return current;
    const ref = current.node.$ref;
    const next = resolveRef(ref, current.file);
    if (next === undefined) throw new Error(`unresolved $ref ${ref} (from ${posix(current.file)})`);
    current = next;
  }
  throw new Error('$ref chain longer than 32 hops (a cycle?)');
}

function at(node: unknown, file: string = RECORDS): Located {
  return deref({ node, file });
}

function child(parent: Located, key: string): Located | undefined {
  if (!isMapping(parent.node) || parent.node[key] === undefined) return undefined;
  return at(parent.node[key], parent.file);
}

function components(): Mapping {
  return isMapping(spec().components) ? (spec().components as Mapping) : {};
}

function rec(name: string): Located {
  const schemas = isMapping(components().schemas) ? (components().schemas as Mapping) : {};
  if (schemas[name] === undefined) throw new Error(`${RECORDS_REL}: components.schemas.${name} not found`);
  return at({ $ref: `#/components/schemas/${name}` });
}

function responseComponent(name: string): Located {
  const all = isMapping(components().responses) ? (components().responses as Mapping) : {};
  if (all[name] === undefined) throw new Error(`${RECORDS_REL}: components.responses.${name} not found`);
  return at({ $ref: `#/components/responses/${name}` });
}

function parameterComponent(name: string): Located {
  const all = isMapping(components().parameters) ? (components().parameters as Mapping) : {};
  if (all[name] === undefined) throw new Error(`${RECORDS_REL}: components.parameters.${name} not found`);
  return at({ $ref: `#/components/parameters/${name}` });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

interface Operation {
  id: string;
  method: string;
  path: string;
  op: Mapping;
  params: Located[];
}

function operations(): Operation[] {
  const doc = spec();
  const paths = isMapping(doc.paths) ? doc.paths : {};
  const out: Operation[] = [];
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = at(rawItem).node;
    if (!isMapping(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isMapping(op)) continue;
      const own = Array.isArray(op.parameters) ? op.parameters : [];
      const params = [...shared, ...own].map((parameter) => at(parameter));
      out.push({ id: str(op.operationId), method, path, op, params });
    }
  }
  return out;
}

function operation(id: string): Operation {
  const found = operations().find((candidate) => candidate.id === id);
  if (!found) throw new Error(`operationId ${id} not found in ${RECORDS_REL}`);
  return found;
}

function paramLocated(op: Operation, name: string, where?: string): Located | undefined {
  return op.params.find((located) => isMapping(located.node) && located.node.name === name && (where === undefined || located.node.in === where));
}

function paramNode(op: Operation, name: string, where?: string): Mapping | undefined {
  const located = paramLocated(op, name, where);
  return located && isMapping(located.node) ? located.node : undefined;
}

function paramSchema(op: Operation, name: string, where?: string): Located {
  const node = paramNode(op, name, where);
  if (!node) throw new Error(`${op.id} has no parameter ${name}`);
  return at(node.schema ?? {});
}

function paramNames(op: Operation, where: string): string[] {
  return op.params
    .map((located) => located.node)
    .filter(isMapping)
    .filter((node) => node.in === where)
    .map((node) => str(node.name))
    .sort();
}

function responses(op: Operation): Map<string, Located> {
  const raw = isMapping(op.op.responses) ? op.op.responses : {};
  return new Map(Object.entries(raw).map(([code, value]) => [code, at(value)]));
}

function jsonMedia(holder: Located | undefined): Located | undefined {
  if (!holder) return undefined;
  const content = child(holder, 'content');
  return content ? child(content, 'application/json') : undefined;
}

function jsonSchema(holder: Located | undefined): Located | undefined {
  const media = jsonMedia(holder);
  return media ? child(media, 'schema') : undefined;
}

function responseSchema(op: Operation, status: string): Located {
  const schema = jsonSchema(responses(op).get(status));
  if (!schema) throw new Error(`${op.id} has no ${status} application/json schema`);
  return schema;
}

function requestBody(op: Operation): Located | undefined {
  return op.op.requestBody === undefined ? undefined : at(op.op.requestBody);
}

function requestSchema(op: Operation): Located {
  const schema = jsonSchema(requestBody(op));
  if (!schema) throw new Error(`${op.id} has no application/json request schema`);
  return schema;
}

/** Every example value on a media object, `example` and `examples` alike, by label. */
function examplesOf(media: Located | undefined): [string, unknown][] {
  if (!media || !isMapping(media.node)) return [];
  const out: [string, unknown][] = [];
  if (media.node.example !== undefined) out.push(['example', media.node.example]);
  const examples = child(media, 'examples');
  if (examples && isMapping(examples.node)) {
    for (const key of Object.keys(examples.node)) {
      const example = child(examples, key);
      if (example && isMapping(example.node)) out.push([key, example.node.value]);
    }
  }
  return out;
}

function exampleBodies(holder: Located | undefined): Mapping[] {
  return examplesOf(jsonMedia(holder))
    .map(([, value]) => value)
    .filter(isMapping);
}

function successExamples(op: Operation, status: string): Mapping[] {
  return exampleBodies(responses(op).get(status));
}

function requestExamples(op: Operation): Mapping[] {
  return exampleBodies(requestBody(op));
}

function description(op: Operation): string {
  return prose(op.op.description);
}

function nodeDescription(located: Located | undefined): string {
  return located && isMapping(located.node) ? prose(located.node.description) : '';
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Own and allOf-merged properties, each dereferenced. */
function properties(schema: Located): Map<string, Located> {
  const out = new Map<string, Located>();
  const node = schema.node;
  if (!isMapping(node)) return out;
  for (const part of Array.isArray(node.allOf) ? node.allOf : []) {
    for (const [key, value] of properties(at(part, schema.file))) out.set(key, value);
  }
  const props = child(schema, 'properties');
  if (props && isMapping(props.node)) {
    for (const key of Object.keys(props.node)) {
      const value = child(props, key);
      if (value) out.set(key, value);
    }
  }
  return out;
}

function keysOf(schema: Located): string[] {
  return [...properties(schema).keys()].sort();
}

function required(schema: Located): string[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  return (Array.isArray(node.required) ? node.required.map(str) : []).sort();
}

function isClosed(schema: Located): boolean {
  return isMapping(schema.node) && schema.node.additionalProperties === false;
}

function enumOf(schema: Located): unknown[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  if (node.const !== undefined && node.const !== null) return [node.const];
  if (Array.isArray(node.enum)) return node.enum.filter((value) => value !== null);
  const items = child(schema, 'items');
  if (items) return enumOf(items);
  const found: unknown[] = [];
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const variants = node[key];
    if (Array.isArray(variants)) found.push(...variants.flatMap((variant) => enumOf(at(variant, schema.file))));
  }
  return found;
}

/**
 * True when `schema` is the named component, directly, through `$ref`, or
 * through a single-part `allOf` wrapper (the usual way to put a description
 * or a flag beside a `$ref`).
 */
function isSchema(schema: Located | undefined, target: Located): boolean {
  if (!schema) return false;
  const current = deref(schema);
  if (current.node === target.node) return true;
  const node = current.node;
  if (isMapping(node) && Array.isArray(node.allOf) && node.allOf.length === 1) {
    return isSchema(at(node.allOf[0], current.file), target);
  }
  return false;
}

/** The items schema of an array property. */
function itemsOf(schema: Located, key: string): Located {
  const prop = properties(schema).get(key);
  const items = prop ? child(deref(prop), 'items') : undefined;
  if (!items) throw new Error(`${key} is not an array with items`);
  return items;
}

// ---------------------------------------------------------------------------
// A JSON-Schema validator: the subset these contracts use (the T-0088
// suite's). It is proven to reject broken copies before it is trusted.
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function validate(raw: Located, value: unknown, path: string): string[] {
  const schema = deref(raw);
  const node = schema.node;
  if (node === true || (isMapping(node) && Object.keys(node).length === 0)) return [];
  if (node === false) return [`${path}: refused by a false schema`];
  if (!isMapping(node)) return [`${path}: schema is not a mapping`];
  const problems: string[] = [];
  if (Array.isArray(node.allOf)) {
    for (const part of node.allOf) problems.push(...validate(at(part, schema.file), value, path));
  }
  for (const combinator of ['oneOf', 'anyOf'] as const) {
    const variants = node[combinator];
    if (!Array.isArray(variants)) continue;
    const passing = variants.filter((variant) => validate(at(variant, schema.file), value, path).length === 0).length;
    if (combinator === 'oneOf' ? passing !== 1 : passing < 1) {
      problems.push(`${path}: matches ${passing} ${combinator} branches`);
    }
  }
  if (node.not !== undefined && validate(at(node.not, schema.file), value, path).length === 0) {
    problems.push(`${path}: matches a not schema`);
  }
  const actual = jsonType(value);
  if (node.type !== undefined) {
    const allowed = (Array.isArray(node.type) ? node.type : [node.type]).map(str);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      return [...problems, `${path}: ${actual}, not ${allowed.join('|')}`];
    }
  }
  if ('const' in node && node.const !== value) problems.push(`${path}: not ${String(node.const)}`);
  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    problems.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(node.enum)}`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof node.minLength === 'number' && length < node.minLength) problems.push(`${path}: too short`);
    if (typeof node.maxLength === 'number' && length > node.maxLength) problems.push(`${path}: too long`);
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern, 'u').test(value)) {
      problems.push(`${path}: does not match ${node.pattern}`);
    }
    if (node.format === 'uuid' && !UUID.test(value)) problems.push(`${path}: not a uuid`);
    if (node.format === 'email' && !EMAIL.test(value)) problems.push(`${path}: not an email`);
    if (node.format === 'date-time' && (!UTC_DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) {
      problems.push(`${path}: not a UTC date-time with a Z`);
    }
  }
  if (typeof value === 'number') {
    if (typeof node.minimum === 'number' && value < node.minimum) problems.push(`${path}: < min`);
    if (typeof node.maximum === 'number' && value > node.maximum) problems.push(`${path}: > max`);
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === 'number' && value.length < node.minItems) problems.push(`${path}: too few items`);
    if (typeof node.maxItems === 'number' && value.length > node.maxItems) problems.push(`${path}: too many items`);
    if (node.uniqueItems === true) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) problems.push(`${path}: items are not unique`);
    }
    const items = child(schema, 'items');
    if (items) value.forEach((item, index) => problems.push(...validate(items, item, `${path}[${index}]`)));
  }
  if (isMapping(value)) {
    const keys = Object.keys(value);
    if (typeof node.minProperties === 'number' && keys.length < node.minProperties) {
      problems.push(`${path}: fewer than ${node.minProperties} properties`);
    }
    if (typeof node.maxProperties === 'number' && keys.length > node.maxProperties) {
      problems.push(`${path}: more than ${node.maxProperties} properties`);
    }
    const props = isMapping(node.properties) ? node.properties : {};
    const patterns = isMapping(node.patternProperties) ? node.patternProperties : {};
    for (const key of Array.isArray(node.required) ? node.required.map(str) : []) {
      if (!(key in value)) problems.push(`${path}: ${key} is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (node.propertyNames !== undefined) {
        problems.push(...validate(at(node.propertyNames, schema.file), key, `${path} key ${JSON.stringify(key)}`));
      }
      const matching = Object.keys(patterns).filter((pattern) => new RegExp(pattern, 'u').test(key));
      for (const pattern of matching) {
        problems.push(...validate(at(patterns[pattern], schema.file), item, `${path}.${key}`));
      }
      if (props[key] !== undefined) {
        problems.push(...validate(at(props[key], schema.file), item, `${path}.${key}`));
      } else if (matching.length === 0) {
        if (node.additionalProperties === false) {
          problems.push(`${path}: ${key} is not a property of this closed object`);
        } else if (isMapping(node.additionalProperties)) {
          problems.push(...validate(at(node.additionalProperties, schema.file), item, `${path}.${key}`));
        }
      }
    }
  }
  return problems;
}

const accepts = (schema: Located, value: unknown): boolean => validate(schema, value, 'v').length === 0;

/** Cases a schema got wrong: accepted refusals and refused acceptances, labelled. */
function caseProblems(schema: Located, good: unknown[], bad: unknown[], wrap: (v: unknown) => unknown = (v) => v): string[] {
  const out: string[] = [];
  for (const value of good) {
    const problems = validate(schema, wrap(value), 'v');
    if (problems.length > 0) out.push(`refused ${JSON.stringify(value)}: ${problems.join('; ')}`);
  }
  for (const value of bad) {
    if (accepts(schema, wrap(value))) out.push(`accepted ${JSON.stringify(value)}`);
  }
  return out;
}

/** A free-standing schema (for self-checks), located in the records file. */
function synthetic(node: Mapping): Located {
  return { node, file: RECORDS };
}

// ---------------------------------------------------------------------------
// The pinned operations
// ---------------------------------------------------------------------------

interface OpSpec {
  id: string;
  method: string;
  path: string;
  success: string;
  schema: string;
  body: string | null;
  statuses: string[];
  screens: string[];
}

const BASE = '/api/v1/notifications';

const OPS: OpSpec[] = [
  { id: 'listNotifications', method: 'get', path: BASE, success: '200', schema: 'NotificationPage', body: null, statuses: ['400', '401', '429'], screens: ['P26/A', 'P26/B'] },
  { id: 'getNotificationUnreadCount', method: 'get', path: `${BASE}/unread-count`, success: '200', schema: 'NotificationUnreadCount', body: null, statuses: ['401', '429'], screens: ['P26/A1'] },
  { id: 'updateNotification', method: 'patch', path: `${BASE}/{notificationId}`, success: '200', schema: 'Notification', body: 'UpdateNotificationRequest', statuses: ['400', '401', '404', '429'], screens: ['P26/A'] },
  { id: 'markAllNotificationsRead', method: 'post', path: `${BASE}/read-all`, success: '200', schema: 'NotificationUnreadCount', body: 'MarkAllNotificationsReadRequest', statuses: ['400', '401', '429'], screens: ['P26/A1'] },
];

const FRAMES = /^P26\/(A|A1|A3|B|B2)$/;

/** Every new operation, or a failure naming the first missing: a gate for negative invariants. */
function gate(): Operation[] {
  return OPS.map((entry) => operation(entry.id));
}

const op = (id: string): Operation => operation(id);

// ---------------------------------------------------------------------------
// Fixed values and cases. Every value is invented.
// ---------------------------------------------------------------------------

const KINDS = ['import_finished', 'record_assigned', 'task_assigned'];
const OBJECT_TYPES = ['account', 'activity', 'contact', 'deal', 'import'];
const FILTERS = ['all', 'unread'];
const KIND_OBJECTS: Record<string, string[]> = {
  record_assigned: ['contact', 'account', 'deal'],
  task_assigned: ['activity'],
  import_finished: ['import'],
};
const DISPLAY_FIELDS: Record<string, string> = {
  contact: 'displayName',
  account: 'name',
  deal: 'name',
  activity: 'subject',
  import: 'filename',
};
/** The record schema that holds each object type's display field. */
const OBJECT_SCHEMAS: Record<string, string> = {
  contact: 'Contact',
  account: 'Account',
  deal: 'Deal',
  activity: 'Activity',
  import: 'Import',
};
const POLL_SECONDS = 30;

const NOTIFICATION_KEYS = ['actor', 'createdAt', 'id', 'kind', 'objectDisplayName', 'objectId', 'objectType', 'readAt'];

const NID = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01';
const OID = '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e01';
const UID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01';
const T0 = '2026-10-18T09:00:00Z';
const T1 = '2026-10-18T09:05:00Z';

const item = (over: Mapping = {}): Mapping => ({
  id: NID,
  kind: 'record_assigned',
  objectType: 'contact',
  objectId: OID,
  actor: { id: UID, displayName: 'Sample Agent' },
  objectDisplayName: 'Sample Customer',
  createdAt: T0,
  readAt: null,
  ...over,
});
const omit = (value: Mapping, key: string): Mapping => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

const GOOD_ITEMS = [
  item(),
  item({ objectType: 'account', objectDisplayName: 'Sample Holdings' }),
  item({ objectType: 'deal', objectDisplayName: 'Sample renewal' }),
  item({ kind: 'task_assigned', objectType: 'activity', objectDisplayName: 'Sample follow-up call' }),
  item({ kind: 'task_assigned', objectType: 'activity', objectDisplayName: null }),
  item({ kind: 'import_finished', objectType: 'import', objectDisplayName: 'sample-customers.csv' }),
  item({ kind: 'import_finished', objectType: 'import', objectDisplayName: null }),
  item({ readAt: T1 }),
  item({ objectDisplayName: null }),
  item({ actor: { id: UID, displayName: null } }),
  item({ objectDisplayName: 'x'.repeat(255) }),
];
const BAD_ITEMS = [
  // kinds that are not served (approvals hidden, D-L87; critical alerts A2; the design's other types)
  item({ kind: 'approval_requested' }),
  item({ kind: 'mention' }),
  item({ kind: 'security_alert' }),
  item({ kind: 'RECORD_ASSIGNED' }),
  // kind and object type disagree (R2)
  item({ kind: 'task_assigned', objectType: 'contact' }),
  item({ kind: 'import_finished', objectType: 'deal' }),
  item({ kind: 'record_assigned', objectType: 'activity' }),
  item({ kind: 'record_assigned', objectType: 'import' }),
  item({ objectType: 'lead' }),
  item({ objectType: 'ticket' }),
  // server text and values (R3)
  item({ title: 'Sample was assigned to you' }),
  item({ body: 'x' }),
  item({ message: 'x' }),
  item({ programmeId: OID }),
  item({ payload: {} }),
  item({ url: 'https://example.test/contacts/1' }),
  item({ critical: true }),
  item({ actions: [] }),
  // shapes
  omit(item(), 'readAt'),
  omit(item(), 'objectDisplayName'),
  omit(item(), 'actor'),
  item({ actor: null }),
  item({ actor: { id: UID } }),
  item({ actor: { id: UID, displayName: 'Sample Agent', email: 'x' } }),
  item({ actor: { id: 'me', displayName: 'Sample Agent' } }),
  item({ id: 'not-a-uuid' }),
  item({ objectId: 'not-a-uuid' }),
  item({ objectDisplayName: '' }),
  item({ objectDisplayName: 'x'.repeat(256) }),
  item({ objectDisplayName: 3 }),
  item({ createdAt: '2026-10-18 09:00' }),
  item({ createdAt: null }),
  item({ readAt: '2026-10-18' }),
  item({ readAt: false }),
];

/** Property names that would carry server text, a value or a channel (R3). */
const TEXT_NAME =
  /title|^body$|message|text|summary|description|label|subject|content|html|snippet|preview|note|comment|reason|payload|meta|detail|url|link|href|icon|severity|priority|critical|action|programme|tenant|email|phone|avatar|channel|value/i;

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function detailsOf(body: Mapping): Mapping[] {
  return Array.isArray(body.details) ? body.details.filter(isMapping) : [];
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (isMapping(value)) return Object.values(value).flatMap(stringsIn);
  return [];
}

/** Error examples of one status on one operation. */
function errorExamples(id: string, status: string): Mapping[] {
  return exampleBodies(responses(op(id)).get(status));
}

/** True when some error example of the status has `code` and (optionally) a detail at a path matching `path` with `detail`. */
function hasError(id: string, status: string, code: string, path?: RegExp, detail?: string): boolean {
  return errorExamples(id, status).some((body) => {
    if (body.code !== code) return false;
    if (path === undefined || detail === undefined) return true;
    return detailsOf(body).some((d) => path.test(str(d.path)) && d.code === detail);
  });
}

/** Every schema reachable from `roots`, by a short label, each visited once. */
function reachable(roots: [string, Located][]): [string, Located][] {
  const out: [string, Located][] = [];
  const seen = new Set<unknown>();
  const visit = (label: string, raw: Located, depth: number): void => {
    if (depth > 40) return;
    const schema = deref(raw);
    if (seen.has(schema.node)) return;
    seen.add(schema.node);
    out.push([label, schema]);
    const node = schema.node;
    if (!isMapping(node)) return;
    for (const key of ['allOf', 'oneOf', 'anyOf']) {
      const variants = node[key];
      if (Array.isArray(variants)) variants.forEach((variant, i) => visit(`${label}/${key}${i}`, at(variant, schema.file), depth + 1));
    }
    const items = child(schema, 'items');
    if (items) visit(`${label}[]`, items, depth + 1);
    const props = child(schema, 'properties');
    if (props && isMapping(props.node)) {
      for (const key of Object.keys(props.node)) {
        const value = child(props, key);
        if (value) visit(`${label}.${key}`, value, depth + 1);
      }
    }
  };
  for (const [label, schema] of roots) visit(label, schema, 0);
  return out;
}

/** R3: the properties in a schema tree that are named for text or a value; empty when right. */
function textNamedProperties(roots: [string, Located][]): string[] {
  const out: string[] = [];
  for (const [label, schema] of reachable(roots)) {
    const node = schema.node;
    if (!isMapping(node) || !isMapping(node.properties)) continue;
    for (const key of Object.keys(node.properties)) {
      if (key === 'objectDisplayName' || key === 'displayName') continue;
      if (TEXT_NAME.test(key)) out.push(`${label}.${key}`);
    }
  }
  return out;
}

/** R3: the object schemas in a tree that are not closed; empty when right. */
function openObjects(roots: [string, Located][]): string[] {
  const out: string[] = [];
  for (const [label, schema] of reachable(roots)) {
    const node = schema.node;
    if (!isMapping(node) || !isMapping(node.properties)) continue;
    // An untyped combinator branch is a constraint on its parent (the kind/objectType coupling
    // spelled as oneOf), not an object of its own; the parent's closedness governs.
    if (/\/(anyOf|oneOf|allOf)\d+$/.test(label) && node.type === undefined) continue;
    if (node.additionalProperties !== false) out.push(label);
  }
  return out;
}

/** Strips trailing combinator steps, so `x.displayName/oneOf0` is `x.displayName`. */
function baseLabel(label: string): string {
  return label.replace(/(\/(anyOf|oneOf|allOf)\d+)+$/, '');
}

const FREE_STRING_ALLOWED = [/\.objectDisplayName$/, /\.actor\.displayName$/, /\.nextCursor$/];

/**
 * R3: every string a schema tree admits that is not an enum or const, a uuid
 * or a UTC time, other than the two display names and the opaque cursor.
 * Empty when right.
 */
function freeStrings(roots: [string, Located][]): string[] {
  const out: string[] = [];
  for (const [label, schema] of reachable(roots)) {
    const node = schema.node;
    if (!isMapping(node)) continue;
    const types = node.type === undefined ? [] : (Array.isArray(node.type) ? node.type : [node.type]).map(str);
    if (!types.includes('string')) continue;
    if (Array.isArray(node.enum) || node.const !== undefined) continue;
    if (node.format === 'uuid' || node.format === 'date-time') continue;
    const base = baseLabel(label);
    if (FREE_STRING_ALLOWED.some((pattern) => pattern.test(base))) continue;
    out.push(label);
  }
  return out;
}

/** R2: what a kind table gets wrong against the pinned one; empty when right. */
function kindTableProblems(table: unknown): string[] {
  if (!isMapping(table)) return ['x-kasuwa-notification-kinds is not a mapping'];
  const problems: string[] = [];
  const kinds = Object.keys(table).sort();
  if (JSON.stringify(kinds) !== JSON.stringify(KINDS)) problems.push(`kinds ${kinds.join(', ')}, not ${KINDS.join(', ')}`);
  for (const kind of KINDS) {
    const types = table[kind];
    const expected = KIND_OBJECTS[kind] ?? [];
    if (!Array.isArray(types)) {
      problems.push(`${kind}: no object types`);
      continue;
    }
    if (JSON.stringify([...types].map(str).sort()) !== JSON.stringify([...expected].sort())) {
      problems.push(`${kind}: ${types.map(str).join(', ')}, not ${expected.join(', ')}`);
    }
  }
  const covered = Object.values(table)
    .flatMap((types) => (Array.isArray(types) ? types.map(str) : []))
    .sort();
  if (JSON.stringify(covered) !== JSON.stringify(OBJECT_TYPES)) problems.push(`the kinds cover ${covered.join(', ')}, each object type exactly once is ${OBJECT_TYPES.join(', ')}`);
  return problems;
}

/** R7: items of a page out of order (newest first by createdAt, then id); empty when right. */
function orderProblems(label: string, rows: Mapping[]): string[] {
  const problems: string[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1] ?? {};
    const cur = rows[i] ?? {};
    const a = Date.parse(str(prev.createdAt));
    const b = Date.parse(str(cur.createdAt));
    if (b > a || (b === a && str(cur.id) >= str(prev.id))) problems.push(`${label}: item ${i} is not older than item ${i - 1}`);
  }
  return problems;
}

/** Decodes a base64url or base64 string when it is one; else ''. */
function decoded(text: string): string {
  if (!/^[A-Za-z0-9_\-+/]+={0,2}$/.test(text)) return '';
  try {
    return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/** R7: what a cursor carries beyond an id (a time, a kind, a filter or a name); empty when right. */
function cursorProblems(cursor: string, names: string[]): string[] {
  const problems: string[] = [];
  for (const text of [cursor, decoded(cursor)]) {
    if (text === '') continue;
    if (/\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}|\b1[6-9]\d{8}(\d{3})?\b/.test(text)) problems.push(`${cursor}: carries a time`);
    if (/record_assigned|task_assigned|import_finished|unread|createdAt|readAt|kind|filter/.test(text)) problems.push(`${cursor}: carries a kind, filter or sort key`);
    for (const name of names) if (name.length >= 4 && text.toLowerCase().includes(name.toLowerCase())) problems.push(`${cursor}: carries the name ${name}`);
  }
  return problems;
}

/** R16: strings in an example that look like a phone number or an email; empty when right. */
function identifierLikeStrings(value: unknown): string[] {
  return stringsIn(value).filter((text) => {
    if (UUID.test(text) || UTC_DATE_TIME.test(text)) return false;
    if (decoded(text) !== '' && text.length >= 24) return false; // an opaque cursor; cursorProblems reads it
    return text.includes('@') || text.replace(/[^0-9]/g, '').length >= 7;
  });
}

/** R16: display-name strings in examples that are not obviously synthetic; empty when right. */
function unsyntheticNames(value: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (isMapping(node)) {
      for (const [key, inner] of Object.entries(node)) {
        if ((key === 'displayName' || key === 'objectDisplayName') && typeof inner === 'string' && !/sample|fixture|example|test/i.test(inner)) out.push(inner);
        visit(inner);
      }
    }
  };
  visit(value);
  return out;
}

/** Every display name in the examples of the new operations (for the cursor check). */
function exampleNames(): string[] {
  const out = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (isMapping(node)) {
      for (const [key, inner] of Object.entries(node)) {
        if ((key === 'displayName' || key === 'objectDisplayName') && typeof inner === 'string') out.add(inner);
        visit(inner);
      }
    }
  };
  for (const entry of OPS) for (const [, response] of responses(op(entry.id))) for (const body of exampleBodies(response)) visit(body);
  return [...out];
}

/** Every example in the file paired with its schema: request bodies and responses. */
function allExamples(): { label: string; schema: Located | undefined; value: unknown; op: Operation; status: string }[] {
  const out: { label: string; schema: Located | undefined; value: unknown; op: Operation; status: string }[] = [];
  for (const operationItem of operations()) {
    const body = requestBody(operationItem);
    for (const [label, value] of examplesOf(jsonMedia(body))) {
      out.push({ label: `${operationItem.id} request ${label}`, schema: jsonSchema(body), value, op: operationItem, status: 'request' });
    }
    for (const [status, response] of responses(operationItem)) {
      for (const [label, value] of examplesOf(jsonMedia(response))) {
        out.push({ label: `${operationItem.id} ${status} ${label}`, schema: jsonSchema(response), value, op: operationItem, status });
      }
    }
  }
  return out;
}

function errorCodeEnum(): string[] {
  const error = responseSchema(op('listNotifications'), '400');
  const code = properties(error).get('code');
  return code ? enumOf(code).map(str) : [];
}

function headerNamed(response: Located, name: string): Located | undefined {
  const headers = child(response, 'headers');
  if (!headers || !isMapping(headers.node)) return undefined;
  const key = Object.keys(headers.node).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : child(headers, key);
}

function noStore(response: Located): boolean {
  const header = headerNamed(response, 'Cache-Control');
  const schema = header ? child(header, 'schema') : undefined;
  return schema !== undefined && JSON.stringify(enumOf(schema)) === JSON.stringify(['no-store']);
}

function pageRows(page: Mapping): Mapping[] {
  return Array.isArray(page.data) ? page.data.filter(isMapping) : [];
}

function listPages(): Mapping[] {
  return successExamples(op('listNotifications'), '200');
}

function listItems(): Mapping[] {
  return listPages().flatMap(pageRows);
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe('acceptance: notifications contract (T-0099)', () => {
  describe('the operations (R1, R14)', () => {
    for (const entry of OPS) {
      it(`${entry.id} is ${entry.method.toUpperCase()} ${entry.path}, tag notifications, answering ${entry.success} ${entry.schema}`, () => {
        const found = op(entry.id);
        expect(`${found.method} ${found.path}`).toBe(`${entry.method} ${entry.path}`);
        expect(found.op.tags, `${entry.id} tags`).toEqual(['notifications']);
        const successes = [...responses(found).keys()].filter((code) => /^2\d\d$/.test(code));
        expect(successes, `${entry.id} success statuses`).toEqual([entry.success]);
        expect(isSchema(responseSchema(found, entry.success), rec(entry.schema)), `${entry.id} ${entry.success} is ${entry.schema}`).toBe(true);
      });
    }

    it('the notifications tag is declared at the top of the file', () => {
      gate();
      const tags = Array.isArray(spec().tags) ? (spec().tags as unknown[]).filter(isMapping).map((tag) => str(tag.name)) : [];
      expect(tags).toContain('notifications');
    });

    it('screens: only P26/A, A1, A3, B and B2; the list draws A and B, the count and read-all A1, the toggle A', () => {
      const problems: string[] = [];
      for (const entry of OPS) {
        const screens = op(entry.id).op['x-kasuwa-screens'];
        const list = Array.isArray(screens) ? screens.map(str) : [];
        if (list.length === 0) problems.push(`${entry.id}: no screens`);
        for (const screen of list) if (!FRAMES.test(screen)) problems.push(`${entry.id}: ${screen} is not a served P26 frame`);
        for (const screen of entry.screens) if (!list.includes(screen)) problems.push(`${entry.id}: does not name ${screen}`);
      }
      expect(problems).toEqual([]);
    });

    for (const entry of OPS) {
      it(`${entry.id} documents ${entry.statuses.join(', ')} and never 403${entry.path.includes('{') ? '' : ' or 404'}`, () => {
        const found = [...responses(op(entry.id)).keys()];
        expect(found, entry.id).toEqual(expect.arrayContaining(entry.statuses));
        expect(found, `${entry.id}: a notification is the caller's own; anything else is 404, never 403`).not.toContain('403');
        if (!entry.path.includes('{')) expect(found, `${entry.id}: no id, so no 404`).not.toContain('404');
      });
    }

    it('R14: the only operations under /api/v1/notifications are the four; none creates, replaces or deletes', () => {
      gate();
      const under = operations()
        .filter((found) => found.path === BASE || found.path.startsWith(`${BASE}/`))
        .map((found) => `${found.method} ${found.path}`)
        .sort();
      expect(under).toEqual(OPS.map((entry) => `${entry.method} ${entry.path}`).sort());
      const creating = operations()
        .filter((found) => /notification/i.test(found.id) || /notification/i.test(found.path))
        .filter((found) => found.method === 'delete' || found.method === 'put' || /create|delete|remove|send|publish|dismiss/i.test(found.id))
        .map((found) => found.id);
      expect(creating).toEqual([]);
      const named = operations()
        .filter((found) => /notification/i.test(found.id))
        .map((found) => found.id)
        .sort();
      expect(named, 'an operation named for notifications that is not one of the four').toEqual(OPS.map((entry) => entry.id).sort());
    });

    it('the description says notifications come only from events (the outbox), and an assignment to yourself makes none', () => {
      const text = description(op('listNotifications'));
      expect(text).toMatch(/only from events|only by events|produced only/i);
      expect(text).toMatch(/outbox|ADR-0018/);
      expect(text).toMatch(/no (create|delete)|never created|never deleted|cannot (be )?create/i);
      expect(text).toMatch(/(themselves|yourself|own assignment|self-assign)/i);
    });

    it('R14: read notifications are kept 90 days (D-L146)', () => {
      const text = description(op('listNotifications'));
      expect(text).toMatch(/90 days/);
      expect(text).toMatch(/D-L146/);
    });
  });

  describe('parameters (R7, R8, R13)', () => {
    it('listNotifications takes exactly filter, kind, cursor and limit in the query, and no header', () => {
      expect(paramNames(op('listNotifications'), 'query')).toEqual(['cursor', 'filter', 'kind', 'limit']);
      expect(paramNames(op('listNotifications'), 'header')).toEqual([]);
      expect(paramNames(op('listNotifications'), 'cookie')).toEqual([]);
    });

    it('filter is NotificationFilter (exactly all and unread), optional, default all', () => {
      expect(enumOf(rec('NotificationFilter')).map(str).sort()).toEqual(FILTERS);
      const node = paramNode(op('listNotifications'), 'filter', 'query');
      expect(node?.required === undefined || node.required === false, 'filter is optional').toBe(true);
      const schema = paramSchema(op('listNotifications'), 'filter', 'query');
      expect(isSchema(schema, rec('NotificationFilter')), 'filter is NotificationFilter').toBe(true);
      expect(caseProblems(schema, ['all', 'unread'], ['read', 'ALL', '', 'archived', null])).toEqual([]);
      const declaredDefault = isMapping(schema.node) ? schema.node.default : undefined;
      const viaComponent = isMapping(rec('NotificationFilter').node) ? (rec('NotificationFilter').node as Mapping).default : undefined;
      expect(declaredDefault ?? viaComponent, 'default all').toBe('all');
    });

    it('kind is one optional NotificationKind (not a list)', () => {
      const node = paramNode(op('listNotifications'), 'kind', 'query');
      expect(node?.required === undefined || node.required === false, 'kind is optional').toBe(true);
      const schema = paramSchema(op('listNotifications'), 'kind', 'query');
      expect(isSchema(schema, rec('NotificationKind')), 'kind is NotificationKind').toBe(true);
      expect(caseProblems(schema, KINDS, ['approval_requested', ['record_assigned'], '', null])).toEqual([]);
    });

    it('limit is an integer 1..100, optional', () => {
      const node = paramNode(op('listNotifications'), 'limit', 'query');
      expect(node?.required === undefined || node.required === false, 'limit is optional').toBe(true);
      expect(caseProblems(paramSchema(op('listNotifications'), 'limit', 'query'), [1, 25, 100], [0, 101, 1.5, '25', -1])).toEqual([]);
    });

    it('cursor is the NotificationCursor parameter: optional, bounded, and its text says it carries only a notification id, never a value', () => {
      const located = paramLocated(op('listNotifications'), 'cursor', 'query');
      expect(located?.node, 'cursor is the NotificationCursor component').toBe(parameterComponent('NotificationCursor').node);
      const node = paramNode(op('listNotifications'), 'cursor', 'query');
      expect(node?.required === undefined || node.required === false, 'cursor is optional').toBe(true);
      const schema = paramSchema(op('listNotifications'), 'cursor', 'query');
      expect(accepts(schema, 'eyJpZCI6IngifQ'), 'a cursor').toBe(true);
      expect(accepts(schema, ''), 'an empty cursor').toBe(false);
      expect(accepts(schema, 'x'.repeat(4097)), 'an unbounded cursor').toBe(false);
      const text = prose(node?.description);
      expect(text).toMatch(/only[^.]*notification id|notification id[^.]*only/i);
      expect(text).toMatch(/never[^.]*(time|value|name|kind)/i);
      expect(text).toMatch(/another user['’]s[^.]*empty page|empty page[^.]*another user/i);
      expect(text).toMatch(/invalid_cursor/);
    });

    it('getNotificationUnreadCount and markAllNotificationsRead take no parameter; updateNotification only its path id, a uuid', () => {
      gate();
      for (const id of ['getNotificationUnreadCount', 'markAllNotificationsRead']) {
        expect(op(id).params.map((located) => (isMapping(located.node) ? `${str(located.node.in)} ${str(located.node.name)}` : '?')), id).toEqual([]);
      }
      const update = op('updateNotification');
      expect(paramNames(update, 'path')).toEqual(['notificationId']);
      expect(paramNames(update, 'query')).toEqual([]);
      expect(paramNames(update, 'header')).toEqual([]);
      const schema = paramSchema(update, 'notificationId', 'path');
      expect(isMapping(schema.node) && schema.node.type === 'string' && schema.node.format === 'uuid', 'notificationId is a uuid string').toBe(true);
    });

    it('no new operation takes a programme, tenant, scope, recipient or user in any parameter', () => {
      const offending: string[] = [];
      for (const found of gate()) {
        for (const located of found.params) {
          const node = located.node;
          if (!isMapping(node)) continue;
          if (/programme|tenant|scope|owner|recipient|user/i.test(str(node.name)) || (node.in === 'header' && /^x-kasuwa-/i.test(str(node.name)))) {
            offending.push(`${found.id}: ${str(node.in)} ${str(node.name)}`);
          }
        }
      }
      expect(offending).toEqual([]);
    });
  });

  describe('kinds (R2)', () => {
    it('NotificationKind is exactly record_assigned, task_assigned and import_finished', () => {
      expect(enumOf(rec('NotificationKind')).map(str).sort()).toEqual(KINDS);
    });

    it('NotificationObjectType is exactly contact, account, deal, activity and import', () => {
      expect(enumOf(rec('NotificationObjectType')).map(str).sort()).toEqual(OBJECT_TYPES);
    });

    it('x-kasuwa-notification-kinds is exactly the kind-to-object-type table, each object type under one kind', () => {
      expect(kindTableProblems(op('listNotifications').op['x-kasuwa-notification-kinds'])).toEqual([]);
    });

    it('(self-check, R2) the kind table check catches an extra kind, a moved object type and a missing one', () => {
      gate();
      expect(kindTableProblems(KIND_OBJECTS)).toEqual([]);
      expect(kindTableProblems({ ...KIND_OBJECTS, approval_requested: ['deal'] }).length, 'extra kind').toBeGreaterThan(0);
      expect(kindTableProblems({ ...KIND_OBJECTS, task_assigned: ['activity', 'contact'] }).length, 'moved').toBeGreaterThan(0);
      expect(kindTableProblems({ ...KIND_OBJECTS, record_assigned: ['contact', 'account'] }).length, 'missing deal').toBeGreaterThan(0);
    });

    it('the kinds grow only: the description says a later kind is additive and a client ignores a kind it does not know (D-L87)', () => {
      const text = `${description(op('listNotifications'))} ${nodeDescription(rec('NotificationKind'))}`;
      expect(text).toMatch(/additive|grow/i);
      expect(text).toMatch(/ignores?[^.]*kind[^.]*(not know|unknown)|unknown kind[^.]*ignor/i);
      expect(text).toMatch(/D-L87/);
    });

    it('Notification.kind is NotificationKind and Notification.objectType is NotificationObjectType', () => {
      const props = properties(rec('Notification'));
      expect(isSchema(props.get('kind'), rec('NotificationKind')), 'kind').toBe(true);
      expect(isSchema(props.get('objectType'), rec('NotificationObjectType')), 'objectType').toBe(true);
    });
  });

  describe('the item (R3–R5)', () => {
    it('Notification is closed with exactly its eight keys, all required', () => {
      const schema = rec('Notification');
      expect(isClosed(schema)).toBe(true);
      expect(keysOf(schema)).toEqual(NOTIFICATION_KEYS);
      expect(required(schema)).toEqual(NOTIFICATION_KEYS);
    });

    it('it admits each kind with its object types, nulls where R4 and R5 allow, and refuses mismatched kinds, server text and wrong shapes', () => {
      expect(caseProblems(rec('Notification'), GOOD_ITEMS, BAD_ITEMS)).toEqual([]);
    });

    it('(self-check, R2) the cases catch a schema without the kind/object-type coupling', () => {
      rec('Notification');
      const props = {
        id: { type: 'string', format: 'uuid' },
        kind: { type: 'string', enum: KINDS },
        objectType: { type: 'string', enum: OBJECT_TYPES },
        objectId: { type: 'string', format: 'uuid' },
        actor: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'displayName'],
          properties: { id: { type: 'string', format: 'uuid' }, displayName: { type: ['string', 'null'], minLength: 1 } },
        },
        objectDisplayName: { type: ['string', 'null'], minLength: 1, maxLength: 255 },
        createdAt: { type: 'string', format: 'date-time' },
        readAt: { type: ['string', 'null'], format: 'date-time' },
      };
      const base = { type: 'object', additionalProperties: false, required: NOTIFICATION_KEYS, properties: props };
      const coupling = Object.entries(KIND_OBJECTS).map(([kind, types]) => ({ properties: { kind: { const: kind }, objectType: { enum: types } } }));
      expect(caseProblems(synthetic({ ...base, oneOf: coupling }), GOOD_ITEMS, BAD_ITEMS), 'the cases refuse a faithful schema').toEqual([]);
      expect(caseProblems(synthetic(base), GOOD_ITEMS, BAD_ITEMS).length, 'no coupling').toBeGreaterThan(0);
      const open = { ...base, additionalProperties: true, oneOf: coupling };
      expect(caseProblems(synthetic(open), GOOD_ITEMS, BAD_ITEMS).length, 'open item').toBeGreaterThan(0);
    });

    it('NotificationActor is closed, exactly { id: uuid, displayName: string or null }, both required; Notification.actor is it', () => {
      const actor = rec('NotificationActor');
      expect(isClosed(actor)).toBe(true);
      expect(keysOf(actor)).toEqual(['displayName', 'id']);
      expect(required(actor)).toEqual(['displayName', 'id']);
      expect(isSchema(properties(rec('Notification')).get('actor'), actor), 'Notification.actor').toBe(true);
      expect(caseProblems(actor, [{ id: UID, displayName: 'Sample Agent' }, { id: UID, displayName: null }], [
        { id: UID },
        { id: UID, displayName: '' },
        { id: UID, displayName: 'Sample Agent', email: 'x' },
        { id: UID, displayName: 'Sample Agent', avatarUrl: 'x' },
        { id: 'x', displayName: 'Sample Agent' },
        null,
      ])).toEqual([]);
    });

    it('R3: no schema of the notification tree has a property named for text, a link, a value, a programme or a channel', () => {
      gate();
      const roots: [string, Located][] = ['NotificationPage', 'Notification', 'NotificationUnreadCount', 'UpdateNotificationRequest', 'MarkAllNotificationsReadRequest'].map((name) => [name, rec(name)]);
      expect(textNamedProperties(roots)).toEqual([]);
    });

    it('R3: every object in that tree is closed', () => {
      gate();
      const roots: [string, Located][] = ['NotificationPage', 'Notification', 'NotificationUnreadCount', 'UpdateNotificationRequest', 'MarkAllNotificationsReadRequest'].map((name) => [name, rec(name)]);
      expect(openObjects(roots)).toEqual([]);
    });

    it('R3: the only free strings are objectDisplayName, actor.displayName and nextCursor; every other string is an enum, a uuid or a UTC time', () => {
      gate();
      const roots: [string, Located][] = ['NotificationPage', 'Notification', 'NotificationUnreadCount'].map((name) => [name, rec(name)]);
      expect(freeStrings(roots)).toEqual([]);
      // Not vacuous: the two display names are strings the sweep reached and allowed.
      const labels = reachable(roots).map(([label]) => baseLabel(label));
      expect(labels.some((label) => /\.objectDisplayName$/.test(label)), 'objectDisplayName reached').toBe(true);
      expect(labels.some((label) => /\.actor\.displayName$/.test(label)), 'actor.displayName reached').toBe(true);
    });

    it('(self-check, R3) the sweeps catch a planted title, message and link, an open nested object and a free string', () => {
      gate();
      for (const name of ['title', 'body', 'message', 'summaryText', 'link', 'iconName', 'programmeId', 'payload', 'severity']) {
        const planted = synthetic({ type: 'object', additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' }, [name]: { type: 'string' } } });
        expect(textNamedProperties([['planted', planted]]), name).toEqual([`planted.${name}`]);
        expect(freeStrings([['planted', planted]]), `${name} as a free string`).toEqual([`planted.${name}`]);
      }
      const clean = synthetic({
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: KINDS },
          id: { type: 'string', format: 'uuid' },
          objectDisplayName: { type: ['string', 'null'] },
          actor: { type: 'object', additionalProperties: false, properties: { displayName: { oneOf: [{ type: 'string' }, { type: 'null' }] } } },
        },
      });
      expect(textNamedProperties([['clean', clean]])).toEqual([]);
      expect(freeStrings([['clean', clean]])).toEqual([]);
      const open = synthetic({ type: 'object', additionalProperties: false, properties: { actor: { type: 'object', properties: { id: { type: 'string' } } } } });
      expect(openObjects([['open', open]])).toEqual(['open.actor']);
    });

    it('R4: x-kasuwa-notification-display-fields is exactly the display field per object type, each a property of that record schema', () => {
      const table = op('listNotifications').op['x-kasuwa-notification-display-fields'];
      expect(table).toEqual(DISPLAY_FIELDS);
      const missing: string[] = [];
      for (const [type, field] of Object.entries(DISPLAY_FIELDS)) {
        const schemaName = OBJECT_SCHEMAS[type] ?? '';
        if (!keysOf(rec(schemaName)).includes(field)) missing.push(`${schemaName}.${field}`);
      }
      expect(missing).toEqual([]);
    });

    it('R4: objectDisplayName fits every source field: it admits the longest a source allows and nothing longer than 255', () => {
      const prop = properties(rec('Notification')).get('objectDisplayName');
      if (!prop) throw new Error('Notification has no objectDisplayName');
      const longest = Math.max(
        ...Object.entries(DISPLAY_FIELDS).map(([type, field]) => {
          const source = properties(rec(OBJECT_SCHEMAS[type] ?? '')).get(field);
          const node = source ? deref(source).node : undefined;
          return isMapping(node) && typeof node.maxLength === 'number' ? node.maxLength : 0;
        }),
      );
      expect(longest, 'every source field is bounded').toBeGreaterThan(0);
      expect(accepts(prop, 'x'.repeat(longest)), `admits ${longest}`).toBe(true);
      expect(accepts(prop, 'x'.repeat(256)), 'refuses 256').toBe(false);
      expect(accepts(prop, null), 'admits null').toBe(true);
    });

    it('R4, R5: the schemas say the names are resolved at read time, under scope and field security, null when withheld; the actor rule is D-P23', () => {
      const props = properties(rec('Notification'));
      const objectName = nodeDescription(props.get('objectDisplayName'));
      const rawProps = isMapping(rec('Notification').node) && isMapping((rec('Notification').node as Mapping).properties) ? ((rec('Notification').node as Mapping).properties as Mapping) : {};
      const objectText = `${objectName} ${prose(isMapping(rawProps.objectDisplayName) ? rawProps.objectDisplayName.description : '')}`;
      expect(objectText).toMatch(/read time|when (it is )?read/i);
      expect(objectText).toMatch(/field security/i);
      expect(objectText).toMatch(/withheld/i);
      expect(objectText).toMatch(/null/);
      expect(objectText).toMatch(/D-L148|erased|raw file/i);
      // A contact's name follows its parts (D-L68, search R8): withheld when either part is.
      expect(objectText).toMatch(/D-L68/);
      expect(objectText).toMatch(/`givenNames`[^.]*`familyName`[^.]*withheld|withheld[^.]*`givenNames`[^.]*`familyName`/);
      const actorText = `${nodeDescription(rec('NotificationActor'))} ${nodeDescription(properties(rec('NotificationActor')).get('displayName'))}`;
      expect(actorText).toMatch(/D-P23/);
      expect(actorText).toMatch(/member/i);
      expect(actorText).toMatch(/null/);
      expect(actorText).toMatch(/never[^.]*\bid\b|D-L64/i);
    });

    it('R3: the server sends no title or sentence; the client builds it from kind with i18n (D-P29)', () => {
      const text = description(op('listNotifications'));
      expect(text).toMatch(/no title|never (sends|a) title|no (sentence|title) text/i);
      expect(text).toMatch(/i18n/);
      expect(text).toMatch(/D-P29/);
    });
  });

  describe('the list (R6, R7)', () => {
    it('NotificationPage is closed { data: Notification[], nextCursor: string or null }, both required, no total or count', () => {
      const page = rec('NotificationPage');
      expect(isClosed(page)).toBe(true);
      expect(keysOf(page)).toEqual(['data', 'nextCursor']);
      expect(required(page)).toEqual(['data', 'nextCursor']);
      expect(isSchema(itemsOf(page, 'data'), rec('Notification')), 'data[] is Notification').toBe(true);
      const cursor = properties(page).get('nextCursor') ?? synthetic({ not: {} });
      expect(accepts(cursor, null) && accepts(cursor, 'eyJpZCI6IngifQ') && !accepts(cursor, ''), 'nextCursor').toBe(true);
      const counting = reachable([['NotificationPage', page]])
        .flatMap(([label, schema]) => (isMapping(schema.node) && isMapping(schema.node.properties) ? Object.keys(schema.node.properties).map((key) => `${label}.${key}`) : []))
        .filter((path) => /total|count|offset|\.page$|more$|estimate/i.test(path.split('.').pop() ?? ''));
      expect(counting).toEqual([]);
    });

    it('R7: the description states keyset, newest first by createdAt then id, and the id-only cursor', () => {
      const text = description(op('listNotifications'));
      expect(text).toMatch(/keyset/i);
      expect(text).toMatch(/newest first/i);
      expect(text).toMatch(/`createdAt`[^.]*`id`/);
      expect(text).toMatch(/cursor[^.]*only[^.]*id|only[^.]*id[^.]*cursor/i);
    });

    it('R6: an item whose object the reader can no longer read is dropped, not redacted, and a merged-away contact is one', () => {
      const text = description(op('listNotifications'));
      expect(text).toMatch(/dropped/i);
      expect(text).toMatch(/not redacted|never redacted|never sent with[^.]*null/i);
      expect(text).toMatch(/can no longer (read|see)|no longer visible/i);
      expect(text).toMatch(/merged away|merged-away|D-P27/i);
    });

    it('R7: a page may hold fewer than limit items, even none, while nextCursor continues; only a null nextCursor is the end; at most limit rows are examined', () => {
      const text = description(op('listNotifications'));
      expect(text).toMatch(/fewer (items )?than `limit`/i);
      expect(text).toMatch(/even none|no items|empty `data`|`data: \[\]`/i);
      expect(text).toMatch(/only `nextCursor: null`|only a `null` `nextCursor`|`nextCursor` is `null`[^.]*(only|end)/i);
      expect(text).toMatch(/at most `limit`/i);
    });

    it('R7: filter unread means readAt is null; kind narrows to one kind', () => {
      const text = description(op('listNotifications'));
      expect(text).toMatch(/unread[^.]*`readAt`[^.]*null|`readAt`[^.]*null[^.]*unread/i);
      expect(text).toMatch(/`kind`/);
    });

    it('errors: 400 invalid_cursor at cursor and invalid_value at kind and at filter', () => {
      expect(hasError('listNotifications', '400', 'validation_failed', /^cursor$/, 'invalid_cursor'), 'cursor').toBe(true);
      expect(hasError('listNotifications', '400', 'validation_failed', /^kind$/, 'invalid_value'), 'kind').toBe(true);
      expect(hasError('listNotifications', '400', 'validation_failed', /^filter$/, 'invalid_value'), 'filter').toBe(true);
    });
  });

  describe('the unread count (R8, R13)', () => {
    it('NotificationUnreadCount is closed { count: integer 0..99, capped: boolean }, both required', () => {
      const schema = rec('NotificationUnreadCount');
      expect(isClosed(schema)).toBe(true);
      expect(keysOf(schema)).toEqual(['capped', 'count']);
      expect(required(schema)).toEqual(['capped', 'count']);
      expect(caseProblems(schema, [
        { count: 0, capped: false },
        { count: 7, capped: false },
        { count: 99, capped: false },
        { count: 99, capped: true },
      ], [
        { count: 100, capped: false },
        { count: 100, capped: true },
        { count: -1, capped: false },
        { count: 1.5, capped: false },
        { count: '3', capped: false },
        { count: 3 },
        { capped: true },
        { count: 3, capped: 'no' },
        { count: 3, capped: false, byKind: {} },
        { count: 3, capped: false, total: 3 },
      ])).toEqual([]);
    });

    it('the description: visible items only, 99 then capped, no parameter, the poll rule', () => {
      const text = description(op('getNotificationUnreadCount'));
      expect(text).toMatch(/visible|would appear in the list/i);
      expect(text).toMatch(/99/);
      expect(text).toMatch(/`capped`/);
      expect(text).toMatch(/poll/i);
      expect(text).toMatch(/only while[^.]*visible|while the (page|tab) is visible/i);
      expect(text).toMatch(/Retry-After/);
    });

    it('R13: the recommended poll interval is data: x-kasuwa-poll-interval-seconds is 30 on getNotificationUnreadCount', () => {
      expect(op('getNotificationUnreadCount').op['x-kasuwa-poll-interval-seconds']).toBe(POLL_SECONDS);
    });

    it('R13: the description names the interval and that the list is fetched when the bell or centre opens, not polled', () => {
      const text = description(op('getNotificationUnreadCount'));
      expect(text).toMatch(/30 seconds/);
      expect(text).toMatch(/x-kasuwa-poll-interval-seconds/);
      expect(text).toMatch(/(bell|centre)[^.]*open|open[^.]*(bell|centre)/i);
    });

    it('the examples: a capped count is 99, and both a capped and an uncapped count are shown', () => {
      const examples = [...successExamples(op('getNotificationUnreadCount'), '200'), ...successExamples(op('markAllNotificationsRead'), '200')];
      expect(examples.length, 'count examples').toBeGreaterThan(0);
      const problems = examples.filter((example) => example.capped === true && example.count !== 99).map((example) => JSON.stringify(example));
      expect(problems, 'a capped count that is not 99').toEqual([]);
      const counts = successExamples(op('getNotificationUnreadCount'), '200');
      expect(counts.some((example) => example.capped === true), 'a capped example').toBe(true);
      expect(counts.some((example) => example.capped === false), 'an uncapped example').toBe(true);
    });
  });

  describe('read and unread (R9–R11)', () => {
    it('UpdateNotificationRequest is closed { read: boolean }, required; the body is required', () => {
      const schema = rec('UpdateNotificationRequest');
      expect(isClosed(schema)).toBe(true);
      expect(keysOf(schema)).toEqual(['read']);
      expect(required(schema)).toEqual(['read']);
      expect(isSchema(requestSchema(op('updateNotification')), schema), 'updateNotification body').toBe(true);
      const body = requestBody(op('updateNotification'));
      expect(isMapping(body?.node) ? body.node.required : undefined, 'body required').toBe(true);
      expect(caseProblems(schema, [{ read: true }, { read: false }], [{}, { read: 'true' }, { read: null }, { read: 1 }, { read: true, readAt: T0 }, { read: true, kind: 'task_assigned' }, { readAt: T0 }])).toEqual([]);
    });

    it('MarkAllNotificationsReadRequest is closed { kind?: NotificationKind, throughId?: uuid }; the body is required and may be {}', () => {
      const schema = rec('MarkAllNotificationsReadRequest');
      expect(isClosed(schema)).toBe(true);
      expect(keysOf(schema)).toEqual(['kind', 'throughId']);
      expect(required(schema)).toEqual([]);
      expect(isSchema(properties(schema).get('kind'), rec('NotificationKind')), 'kind is NotificationKind').toBe(true);
      expect(isSchema(requestSchema(op('markAllNotificationsRead')), schema), 'markAllNotificationsRead body').toBe(true);
      const body = requestBody(op('markAllNotificationsRead'));
      expect(isMapping(body?.node) ? body.node.required : undefined, 'body required').toBe(true);
      expect(caseProblems(schema, [
        {},
        { kind: 'record_assigned' },
        { kind: 'task_assigned' },
        { kind: 'import_finished' },
        { throughId: NID },
        { kind: 'task_assigned', throughId: NID },
      ], [
        { kind: 'approval_requested' },
        { kind: ['record_assigned', 'task_assigned'] },
        { kind: null },
        { ids: [NID] },
        { before: T0 },
        { read: true },
        // throughId carries an id and nothing else (D-L154): never a time, a cursor, a list or an object.
        { throughId: 'not-a-uuid' },
        { throughId: T0 },
        { throughId: null },
        { throughId: [NID] },
        { throughId: { id: NID } },
        { throughId: Buffer.from(JSON.stringify({ id: NID })).toString('base64url') },
        { throughCreatedAt: T0 },
      ])).toEqual([]);
    });

    it('D-L154: throughId bounds read-all to notifications at or older than it (createdAt, then id); a later arrival stays unread', () => {
      const text = description(op('markAllNotificationsRead'));
      const field = nodeDescription(properties(rec('MarkAllNotificationsReadRequest')).get('throughId'));
      const both = `${text} ${field}`;
      expect(text).toMatch(/`throughId`/);
      expect(both).toMatch(/at or older|or older than/i);
      expect(both).toMatch(/`createdAt`[^.]*`id`/);
      expect(both).toMatch(/(later|after)[^.]*stays? unread|stays? unread[^.]*(later|after)/i);
      expect(both).toMatch(/only (ever )?(a|the) notification id|carries only[^.]*id|only[^.]*an id/i);
      expect(text).toMatch(/D-L154/);
    });

    it('D-L154: an unknown throughId and another user’s are the same 400 invalid_value at throughId, never revealing existence', () => {
      const text = description(op('markAllNotificationsRead'));
      expect(text).toMatch(/invalid_value/);
      expect(text).toMatch(/another user['’]s|someone else['’]s/i);
      expect(text).toMatch(/(unknown|no such|names no)/i);
      expect(text).toMatch(/whether[^.]*exists|existence/i);
      expect(hasError('markAllNotificationsRead', '400', 'validation_failed', /^throughId$/, 'invalid_value'), '400 at throughId').toBe(true);
      // One answer, not two: every throughId detail in every error example is invalid_value,
      // and no status but 400 is documented for it (no 404, no 403, no unknown_reference).
      const throughCodes = [...responses(op('markAllNotificationsRead'))]
        .flatMap(([status]) => errorExamples('markAllNotificationsRead', status).flatMap((body) => detailsOf(body).filter((d) => d.path === 'throughId').map((d) => `${status} ${str(d.code)}`)));
      expect([...new Set(throughCodes)]).toEqual(['400 invalid_value']);
    });

    it('D-L154: a request example uses throughId, and it names an item the list example shows (the newest the caller saw)', () => {
      const ids = new Set(listItems().map((entry) => str(entry.id)));
      const bounded = requestExamples(op('markAllNotificationsRead')).filter((body) => typeof body.throughId === 'string');
      expect(bounded.length, 'a throughId example').toBeGreaterThan(0);
      expect(bounded.filter((body) => !ids.has(str(body.throughId))).map((body) => str(body.throughId)), 'a throughId no list example shows').toEqual([]);
    });

    it('R9: updateNotification sets or clears readAt, keeps the first readAt on a repeat, and answers the item', () => {
      const text = description(op('updateNotification'));
      expect(text).toMatch(/`readAt`/);
      expect(text).toMatch(/read: false/);
      expect(text).toMatch(/idempotent|keeps (its|the) first `readAt`/i);
    });

    it('R11: another user’s notification, another tenant’s, none and one whose object is no longer readable are one 404', () => {
      const text = description(op('updateNotification'));
      expect(text).toMatch(/another user/i);
      expect(text).toMatch(/404/);
      expect(text).toMatch(/no longer (read|visible|see)/i);
      expect(text).toMatch(/never 403|not 403|no 403/i);
    });

    it('R11: the 404 is NotificationNotFound, whose one example is identical to the shared NotFound body', () => {
      const response = responses(op('updateNotification')).get('404');
      expect(response?.node, 'updateNotification 404 is NotificationNotFound').toBe(responseComponent('NotificationNotFound').node);
      const own = examplesOf(jsonMedia(responseComponent('NotificationNotFound')));
      expect(own.length, 'exactly one example: a second would be a second body').toBe(1);
      const shared = examplesOf(jsonMedia(responseComponent('NotFound')));
      expect(own[0]?.[1]).toEqual(shared[0]?.[1]);
      expect(isMapping(own[0]?.[1]) ? (own[0]?.[1] as Mapping).code : undefined).toBe('not_found');
      const prose404 = nodeDescription(responseComponent('NotificationNotFound'));
      expect(prose404).toMatch(/another user/i);
      expect(prose404).toMatch(/another tenant/i);
      expect(prose404).toMatch(/no longer/i);
    });

    it('R10: read-all marks every unread notification of the caller, or of one kind; it answers the new unread count, never a count of rows changed', () => {
      const text = description(op('markAllNotificationsRead'));
      expect(text).toMatch(/`kind`/);
      expect(text).toMatch(/every unread|all unread/i);
      expect(text).toMatch(/NotificationUnreadCount|new unread count/);
      expect(text).toMatch(/never[^.]*(how many|count of rows|rows changed)/i);
      expect(text).toMatch(/no longer visible|no longer (read|see)/i);
      expect(text).toMatch(/assignments/i);
    });

    it('errors: updateNotification 400 invalid_value at read; markAllNotificationsRead 400 invalid_value at kind (throughId: above)', () => {
      expect(hasError('updateNotification', '400', 'validation_failed', /^read$/, 'invalid_value'), 'read').toBe(true);
      expect(hasError('markAllNotificationsRead', '400', 'validation_failed', /^kind$/, 'invalid_value'), 'kind').toBe(true);
    });
  });

  describe('the throttle (R12, R13)', () => {
    it('all four answer 429 through NotificationsTooManyRequests', () => {
      const component = responseComponent('NotificationsTooManyRequests');
      const problems: string[] = [];
      for (const found of gate()) {
        if (responses(found).get('429')?.node !== component.node) problems.push(found.id);
      }
      expect(problems).toEqual([]);
    });

    it('NotificationsTooManyRequests: Retry-After (integer seconds, at least 1), no-store, the shared Error with too_many_requests', () => {
      const component = responseComponent('NotificationsTooManyRequests');
      const retry = headerNamed(component, 'Retry-After');
      if (!retry) throw new Error('NotificationsTooManyRequests has no Retry-After header');
      const schema = child(retry, 'schema') ?? synthetic({});
      expect(caseProblems(schema, [1, 30, 300], [0, -1, 1.5, '30'])).toEqual([]);
      expect(noStore(component), 'no-store').toBe(true);
      expect(jsonSchema(component)?.node, 'the shared Error').toBe(responseSchema(op('listNotifications'), '400').node);
      const bodies = exampleBodies(component);
      expect(bodies.length, 'an example').toBeGreaterThan(0);
      for (const body of bodies) {
        expect(body.code).toBe('too_many_requests');
        expect(body.statusCode).toBe(429);
      }
    });

    it('its description: per user, after authentication and before validation, honour Retry-After, says nothing about any record', () => {
      const text = nodeDescription(responseComponent('NotificationsTooManyRequests'));
      expect(text).toMatch(/per user/i);
      expect(text).toMatch(/after authentication/i);
      expect(text).toMatch(/before (any )?validation/i);
      expect(text).toMatch(/Retry-After/);
      expect(text).toMatch(/D-L134/);
      expect(text).toMatch(/poll/i);
    });

    it('it is its own component, not the search or duplicates one', () => {
      const component = responseComponent('NotificationsTooManyRequests');
      expect(component.node).not.toBe(responseComponent('SearchTooManyRequests').node);
      expect(component.node).not.toBe(responseComponent('DuplicatesTooManyRequests').node);
    });
  });

  describe('transport, flags and errors (R12, R15)', () => {
    it('every answer of every new operation, errors included, is Cache-Control: no-store', () => {
      const missing: string[] = [];
      for (const found of gate()) {
        for (const [status, response] of responses(found)) if (!noStore(response)) missing.push(`${found.id} ${status}`);
      }
      expect(missing).toEqual([]);
    });

    it('none of the four is audited', () => {
      for (const found of gate()) expect(found.op['x-kasuwa-audited'] === undefined || found.op['x-kasuwa-audited'] === false, found.id).toBe(true);
    });

    // Lead edit for T-0100 (the build serves all four): flipped from `false`.
    // This test fails on main until the build flips the contract.
    it('every new operation is x-kasuwa-implemented: true (T-0100 serves them)', () => {
      const problems: string[] = [];
      for (const entry of OPS) if (op(entry.id).op['x-kasuwa-implemented'] !== true) problems.push(entry.id);
      expect(problems).toEqual([]);
    });

    it('every error example on the new operations has its status as statusCode, a code in the enum, and details of path and code only', () => {
      const codes = errorCodeEnum();
      const problems: string[] = [];
      let checked = 0;
      for (const entry of OPS) {
        for (const [status] of responses(op(entry.id))) {
          if (!/^[45]/.test(status)) continue;
          for (const body of errorExamples(entry.id, status)) {
            checked += 1;
            if (body.statusCode !== Number(status)) problems.push(`${entry.id} ${status}: statusCode ${String(body.statusCode)}`);
            if (!codes.includes(str(body.code))) problems.push(`${entry.id} ${status}: ${str(body.code)} not in the enum`);
            for (const detail of detailsOf(body)) {
              const keys = Object.keys(detail).sort();
              if (JSON.stringify(keys) !== JSON.stringify(['code', 'path'])) problems.push(`${entry.id} ${status}: a detail carries ${keys.join(', ')}`);
            }
          }
        }
      }
      expect(problems).toEqual([]);
      // Not vacuous: 400s on three operations, the 404, and the 429 on four.
      expect(checked).toBeGreaterThanOrEqual(10);
    });
  });

  describe('examples (R16, D-L97)', () => {
    it('(self-check) the validator rejects broken copies of a listed item', () => {
      const [first] = listItems();
      if (!first) throw new Error('listNotifications 200 has no item');
      expect(validate(rec('Notification'), first, 'item')).toEqual([]);
      const mutants: [string, unknown][] = [
        ['a title', { ...first, title: 'Sample' }],
        ['an unknown kind', { ...first, kind: 'mention' }],
        ['a mismatched object type', { ...first, kind: 'import_finished', objectType: 'contact' }],
        ['no readAt', omit(first, 'readAt')],
        ['an actor email', { ...first, actor: { id: UID, displayName: null, email: 'x' } }],
        ['a local time', { ...first, createdAt: '2026-10-18T10:00:00+01:00' }],
      ];
      for (const [label, mutant] of mutants) expect(validate(rec('Notification'), mutant, 'item').length, `accepted ${label}`).toBeGreaterThan(0);
    });

    it('every new operation has an example on its success answer, and every new body has a request example', () => {
      const missing: string[] = [];
      for (const entry of OPS) {
        if (successExamples(op(entry.id), entry.success).length === 0) missing.push(`${entry.id} ${entry.success}`);
        if (entry.body !== null && requestExamples(op(entry.id)).length === 0) missing.push(`${entry.id} request`);
      }
      expect(missing).toEqual([]);
    });

    it('every example on the new operations validates against its schema', () => {
      const ids = new Set(gate().map((found) => found.id));
      const problems: string[] = [];
      let checked = 0;
      for (const example of allExamples()) {
        if (!ids.has(example.op.id)) continue;
        checked += 1;
        if (example.schema) problems.push(...validate(example.schema, example.value, example.label));
      }
      expect(problems).toEqual([]);
      expect(checked).toBeGreaterThanOrEqual(12);
    });

    it('the list examples show every kind and every object type, read and unread items, a withheld object name and a former-member actor', () => {
      const items = listItems();
      expect(new Set(items.map((entry) => str(entry.kind)))).toEqual(new Set(KINDS));
      expect([...new Set(items.map((entry) => str(entry.objectType)))].sort()).toEqual(OBJECT_TYPES);
      expect(items.some((entry) => entry.readAt === null), 'an unread item').toBe(true);
      expect(items.some((entry) => typeof entry.readAt === 'string'), 'a read item').toBe(true);
      expect(items.some((entry) => entry.objectDisplayName === null), 'an object name null').toBe(true);
      expect(items.some((entry) => isMapping(entry.actor) && entry.actor.displayName === null), 'an actor name null').toBe(true);
    });

    it('R7: every list page is newest first, readAt is never before createdAt, and one page has no items and a non-null nextCursor', () => {
      const pages = listPages();
      const problems: string[] = [];
      pages.forEach((page, index) => {
        const rows = pageRows(page);
        problems.push(...orderProblems(`page ${index}`, rows));
        for (const row of rows) if (typeof row.readAt === 'string' && Date.parse(row.readAt) < Date.parse(str(row.createdAt))) problems.push(`page ${index}: ${str(row.id)} read before it was created`);
      });
      expect(problems).toEqual([]);
      expect(pages.some((page) => pageRows(page).length >= 3), 'a page with at least three items, or the order shows little').toBe(true);
      expect(pages.some((page) => Array.isArray(page.data) && page.data.length === 0 && typeof page.nextCursor === 'string'), 'a page whose items were all dropped, with nextCursor continuing').toBe(true);
    });

    it('(self-check, R7) the order check catches an older item first and a tie broken upward', () => {
      gate();
      const a = { id: 'b', createdAt: T1 };
      const b = { id: 'a', createdAt: T0 };
      expect(orderProblems('x', [a, b])).toEqual([]);
      expect(orderProblems('x', [b, a]).length).toBeGreaterThan(0);
      expect(orderProblems('x', [{ id: 'a', createdAt: T0 }, { id: 'b', createdAt: T0 }]).length).toBeGreaterThan(0);
    });

    it('R7: no example cursor carries a time, a kind, a filter or a name, raw or decoded', () => {
      const names = exampleNames();
      const cursors = listPages()
        .map((page) => page.nextCursor)
        .filter((cursor): cursor is string => typeof cursor === 'string');
      expect(cursors.length, 'an example cursor').toBeGreaterThan(0);
      expect(cursors.flatMap((cursor) => cursorProblems(cursor, names))).toEqual([]);
    });

    it('(self-check, R7) the cursor check catches a timestamp, an epoch, a kind and a name, and spares an id-only cursor', () => {
      gate();
      const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
      expect(cursorProblems(b64(JSON.stringify({ id: NID })), ['Sample Customer'])).toEqual([]);
      expect(cursorProblems(b64(JSON.stringify({ id: NID, createdAt: T0 })), []).length, 'timestamp').toBeGreaterThan(0);
      expect(cursorProblems(b64(`1760778000|${NID}`), []).length, 'epoch').toBeGreaterThan(0);
      expect(cursorProblems(b64(JSON.stringify({ id: NID, filter: 'unread' })), []).length, 'filter').toBeGreaterThan(0);
      expect(cursorProblems(b64(`Sample Customer|${NID}`), ['Sample Customer']).length, 'name').toBeGreaterThan(0);
    });

    it('R16: every name in the new examples is synthetic, and none holds a phone- or email-like string', () => {
      gate();
      const unsynthetic: string[] = [];
      const identifiers: string[] = [];
      let checked = 0;
      for (const entry of OPS) {
        for (const [status, response] of responses(op(entry.id))) {
          for (const body of exampleBodies(response)) {
            checked += 1;
            for (const name of unsyntheticNames(body)) unsynthetic.push(`${entry.id} ${status}: ${name}`);
            for (const text of identifierLikeStrings(body)) identifiers.push(`${entry.id} ${status}: ${text}`);
          }
        }
        for (const body of requestExamples(op(entry.id))) for (const text of identifierLikeStrings(body)) identifiers.push(`${entry.id} request: ${text}`);
      }
      expect(unsynthetic).toEqual([]);
      expect(identifiers).toEqual([]);
      expect(checked).toBeGreaterThanOrEqual(10);
    });

    it('(self-check, R16) the sweeps catch a real-looking name, a phone and an email, and spare uuids, times and cursors', () => {
      gate();
      expect(unsyntheticNames({ actor: { displayName: 'Adaeze Okonkwo' } })).toEqual(['Adaeze Okonkwo']);
      expect(unsyntheticNames({ objectDisplayName: 'Sample Customer', actor: { displayName: null } })).toEqual([]);
      expect(identifierLikeStrings({ a: '+234 803 000 0001' })).toEqual(['+234 803 000 0001']);
      expect(identifierLikeStrings({ a: 'sample@example.com' })).toEqual(['sample@example.com']);
      expect(identifierLikeStrings({ a: NID, b: T0, c: Buffer.from(JSON.stringify({ id: NID })).toString('base64url') })).toEqual([]);
    });

    it('the updateNotification examples: a request for each of read and unread, and an answer with readAt set', () => {
      const requests = requestExamples(op('updateNotification'));
      expect(requests.some((body) => body.read === true), 'read: true').toBe(true);
      expect(requests.some((body) => body.read === false), 'read: false').toBe(true);
      expect(successExamples(op('updateNotification'), '200').some((body) => typeof body.readAt === 'string'), 'an answer with readAt').toBe(true);
    });

    it('the markAllNotificationsRead examples: {} and one kind', () => {
      const requests = requestExamples(op('markAllNotificationsRead'));
      expect(requests.some((body) => Object.keys(body).length === 0), '{}').toBe(true);
      expect(requests.some((body) => typeof body.kind === 'string'), 'a kind').toBe(true);
    });

    it('every other example in the file still validates (D-L97: notifications break no mock)', () => {
      // A regression guard: it holds on main by design and must keep holding.
      // Not vacuous: it counts what it checked.
      const ids = new Set(OPS.map((entry) => entry.id));
      const problems: string[] = [];
      let checked = 0;
      for (const example of allExamples()) {
        if (ids.has(example.op.id)) continue;
        checked += 1;
        if (example.schema) problems.push(...validate(example.schema, example.value, example.label));
      }
      expect(problems).toEqual([]);
      expect(checked).toBeGreaterThan(100);
    });

    it('every e2e mock that reads the records contract still loads: each validates its own rows when imported (D-L97)', async () => {
      // A regression guard like the one above: it holds on main by design. A mock that derives
      // rows from this file throws at import when a schema change makes its rows invalid.
      const mocks = readdirSync(E2E_SUPPORT)
        .filter((name) => /-mock\.ts$/.test(name))
        .filter((name) => /records\.openapi\.yaml/.test(readFileSync(resolve(E2E_SUPPORT, name), 'utf8')));
      expect(mocks.length, 'no contract mock found').toBeGreaterThanOrEqual(8);
      const failures: string[] = [];
      for (const name of mocks) {
        try {
          await import(resolve(E2E_SUPPORT, name));
        } catch (error) {
          failures.push(`${name}: ${(error as Error).message}`);
        }
      }
      expect(failures).toEqual([]);
      // Ten mocks each parse the 10k-line contract on import; under a loaded machine that
      // exceeded vitest's default 5 s once while this suite was written (2026-10-18). A slow
      // import is not a broken mock, so the guard waits on the imports rather than the clock.
    }, 60_000);
  });
});
