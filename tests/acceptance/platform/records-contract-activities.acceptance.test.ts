import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * ACCEPTANCE — T-0081, the records API contract for ACTIVITIES, TASKS AND THE
 * CALENDAR (P07; D-L87, D-P18, D-P22, D-L81, D-L85, D-L80, D-L97, D-L102,
 * D-P13). Agent 3 owns the follow-up API (T-0082) and Agent 11 the screen
 * (T-0083). Contract only: no route, no migration, no code. Written by QA for
 * the lead from the invariants (D-L23, D-L25).
 *
 * The artefact under test is `docs/api/records.openapi.yaml`, read as data
 * (parsed YAML, never a regex over the raw text, so a keyword in a YAML
 * comment satisfies nothing). The T-0039 suite keeps the whole-file rules
 * (every `$ref` resolves, unique operationIds, one Error schema); the T-0059
 * suite keeps the timeline. This suite does not repeat them.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT THIS SUITE PINS
 * ---------------------------------------------------------------------------
 *
 *   listMyActivities  GET /api/v1/me/activities   x-kasuwa-implemented: true
 *     (since T-0082)
 *     ?timeZone (required IANA name, pattern, no default; invalid is 400
 *     invalid_time_zone, never a fallback) &bucket (required: overdue, today,
 *     upcoming) &cursor (id only, D-L80) &limit (1..100). The caller's OWN open
 *     tasks (ownerUserId = the session's user) in the programmes the session
 *     resolves. Buckets are computed by the server: overdue before now, today
 *     until the next midnight in timeZone, upcoming after it, undated last.
 *
 *   listCalendar      GET /api/v1/me/calendar     x-kasuwa-implemented: true
 *     (since T-0082)
 *     ?from&to (required UTC date-times; to after from, invalid_window; at most
 *     42 days, window_too_long, never clamped) &cursor &limit. The caller's own
 *     Kasuwa events: tasks with a dueAt in [from, to), meetings overlapping the
 *     window. No external calendar (D-P22).
 *
 *   Both answer MyActivityPage `{ data: MyActivity[], nextCursor }`, closed,
 *   no counts (D-P13); errors 400 and 401 only (a read never answers 403, and
 *   neither takes a record id). Every answer `Cache-Control: no-store`.
 *   MyActivity: closed; a task or a meeting; field security omits and names in
 *   withheldFields; a row whose time field is withheld is not listed at all.
 *
 *   ActivityType gains `meeting` (exactly note, task, call, meeting). Activity,
 *   the timeline's ActivityItem and CreateActivityRequest gain `startsAt` and
 *   `endsAt`; UpdateActivityRequest gains `dueAt`, `startsAt` and `endsAt`
 *   (D-L102: version plus changed fields). Every new property is marked
 *   `x-kasuwa-implemented: true` since T-0082 (false until it served them);
 *   the two write operations stay implemented. Meeting invariants: both times required, end after start
 *   (invalid_range), at most 24 hours (too_long), times only on a meeting
 *   (meeting_only), no dueAt on one (task_only); judged on the result on
 *   update. Errors on updateActivity in the order 404, 403, 400, 409.
 *
 *   NO REOPENING (D-L81, D-L87): `completed` admits only `true`; no request
 *   body anywhere takes `completedAt`; no operation reopens, undoes or
 *   restores. NO EXTERNAL CALENDAR AND NO REMINDER CHANNEL (D-P22, D-P29): no
 *   operation, parameter or activity property for sync, booking, holidays,
 *   reminders, notifications, attendees or a provider.
 *
 *   EXAMPLES: every example on the four operations validates against its own
 *   schema (a JSON-Schema subset implemented below, itself proven to reject
 *   broken copies first), and the meeting and paging examples obey the rules
 *   the schema cannot express.
 *
 * ---------------------------------------------------------------------------
 *
 * D-L23: on main the file has neither read, no `meeting` and no new fields.
 * Every test then fails naming the missing operation or property rather than
 * crashing at collection: the spec is loaded lazily. Each negative invariant
 * (no reopen, no external calendar) first requires listMyActivities, so none
 * passes on a file without it.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const SPEC_REL = 'docs/api/records.openapi.yaml';
const SPEC_PATH = resolve(repoRoot, SPEC_REL);

const MY_ACTIVITIES = 'listMyActivities';
const CALENDAR = 'listCalendar';
const CREATE = 'createActivity';
const UPDATE = 'updateActivity';
const NEW_READS = [MY_ACTIVITIES, CALENDAR] as const;
const TOUCHED = [MY_ACTIVITIES, CALENDAR, CREATE, UPDATE] as const;

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
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
      entry = {
        doc: undefined,
        error: `${posix(file)} is not valid YAML: ${(error as Error).message}`,
      };
    }
  }
  docCache.set(file, entry);
  return entry;
}

function spec(): Mapping {
  const { doc, error } = loadDoc(SPEC_PATH);
  if (error !== null) throw new Error(`${error} — the records contract is missing.`);
  if (!isMapping(doc)) throw new Error(`${SPEC_REL} does not parse to a mapping`);
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
    if (next === undefined) {
      throw new Error(`unresolved $ref ${ref} (from ${posix(current.file)})`);
    }
    current = next;
  }
  throw new Error('$ref chain longer than 32 hops (a cycle?)');
}

function at(node: unknown, file: string = SPEC_PATH): Located {
  return deref({ node, file });
}

function child(parent: Located, key: string): Located | undefined {
  if (!isMapping(parent.node) || parent.node[key] === undefined) return undefined;
  return at(parent.node[key], parent.file);
}

function schemaNamed(name: string): Located {
  const components = isMapping(spec().components) ? (spec().components as Mapping) : {};
  const schemas = isMapping(components.schemas) ? components.schemas : {};
  if (schemas[name] === undefined) throw new Error(`components.schemas.${name} not found`);
  return at({ $ref: `#/components/schemas/${name}` });
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
  params: Mapping[];
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
      const params = [...shared, ...own].map((parameter) => at(parameter).node).filter(isMapping);
      out.push({ id: str(op.operationId), method, path, op, params });
    }
  }
  return out;
}

function operation(id: string): Operation {
  const found = operations().find((candidate) => candidate.id === id);
  if (!found) throw new Error(`operationId ${id} not found in ${SPEC_REL}`);
  return found;
}

/** The two new reads, or a failure naming the missing one: a gate for negative invariants. */
function gate(): void {
  for (const id of NEW_READS) operation(id);
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

function requestBody(id: string): Located | undefined {
  const op = operation(id);
  return op.op.requestBody === undefined ? undefined : at(op.op.requestBody);
}

function requestSchema(id: string): Located {
  const schema = jsonSchema(requestBody(id));
  if (!schema) throw new Error(`${id} has no application/json request schema`);
  return schema;
}

function responseSchema(id: string, status: string): Located {
  const schema = jsonSchema(responses(operation(id)).get(status));
  if (!schema) throw new Error(`${id} has no ${status} application/json schema`);
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

function exampleCodes(holder: Located): string[] {
  return examplesOf(jsonMedia(holder))
    .map(([, value]) => value)
    .filter(isMapping)
    .map((value) => str(value.code));
}

function exampleDetails(holder: Located): { path: string; code: string }[] {
  return examplesOf(jsonMedia(holder))
    .map(([, value]) => value)
    .filter(isMapping)
    .flatMap((value) => (Array.isArray(value.details) ? value.details : []))
    .filter(isMapping)
    .map((detail) => ({ path: str(detail.path), code: str(detail.code) }));
}

function screensOf(op: Operation): string[] {
  const raw = op.op['x-kasuwa-screens'];
  return Array.isArray(raw) ? raw.map(str) : [];
}

function description(op: Operation): string {
  return str(op.op.description);
}

/** The description with every run of whitespace collapsed, so a phrase may wrap. */
function prose(text: string): string {
  return text.replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

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

/** A property's own node, before `$ref` resolution (where `x-kasuwa-*` marks live). */
function rawProperty(schema: Located, key: string): Mapping | undefined {
  const node = schema.node;
  if (!isMapping(node) || !isMapping(node.properties)) return undefined;
  const value = node.properties[key];
  return isMapping(value) ? value : undefined;
}

function required(schema: Located): string[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  const own = Array.isArray(node.required) ? node.required.map(str) : [];
  const inherited = (Array.isArray(node.allOf) ? node.allOf : []).flatMap((part) =>
    required(at(part, schema.file)),
  );
  return [...own, ...inherited];
}

function types(schema: Located): string[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  const out = new Set<string>();
  if (typeof node.type === 'string') out.add(node.type);
  if (Array.isArray(node.type)) node.type.map(str).forEach((type) => out.add(type));
  if (node.nullable === true) out.add('null');
  if (node.const === null || (Array.isArray(node.enum) && node.enum.includes(null)))
    out.add('null');
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const variants = node[key];
    if (Array.isArray(variants)) {
      variants.forEach((variant) => types(at(variant, schema.file)).forEach((t) => out.add(t)));
    }
  }
  if (out.size === 0 && isMapping(node.properties)) out.add('object');
  return [...out];
}

function enumOf(schema: Located): unknown[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  if (node.const !== undefined && node.const !== null) return [node.const];
  if (Array.isArray(node.enum)) return node.enum.filter((value) => value !== null);
  const items = child(schema, 'items');
  if (items) return enumOf(items);
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const variants = node[key];
    if (Array.isArray(variants)) {
      const found = variants.flatMap((variant) => enumOf(at(variant, schema.file)));
      if (found.length > 0) return found;
    }
  }
  return [];
}

function formatOf(schema: Located): string {
  const node = schema.node;
  if (!isMapping(node)) return '';
  if (typeof node.format === 'string') return node.format;
  for (const key of ['oneOf', 'anyOf']) {
    const variants = node[key];
    if (Array.isArray(variants)) {
      for (const variant of variants) {
        const format = formatOf(at(variant, schema.file));
        if (format !== '') return format;
      }
    }
  }
  return '';
}

function isClosed(schema: Located): boolean {
  return isMapping(schema.node) && schema.node.additionalProperties === false;
}

/** Every key at every depth of a schema, as dotted paths. Cycle-safe. */
function deepKeys(schema: Located, prefix = '', seen = new Set<unknown>()): string[] {
  if (seen.has(schema.node)) return [];
  seen.add(schema.node);
  const out: string[] = [];
  const node = schema.node;
  for (const combinator of ['oneOf', 'anyOf']) {
    const variants = isMapping(node) ? node[combinator] : undefined;
    if (Array.isArray(variants)) {
      for (const variant of variants) out.push(...deepKeys(at(variant, schema.file), prefix, seen));
    }
  }
  for (const [key, value] of properties(schema)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    out.push(path);
    out.push(...deepKeys(value, path, seen));
    const items = child(value, 'items');
    if (items) out.push(...deepKeys(items, `${path}[]`, seen));
  }
  return out;
}

function leafOf(path: string): string {
  return (path.split('.').pop() ?? path).replace(/\[\]$/, '');
}

/** The single object branch of a `{...} | null` property. */
function objectBranch(value: Located, where: string): Located {
  const node = value.node;
  const variants = isMapping(node)
    ? [node.oneOf, node.anyOf].find((candidate): candidate is unknown[] => Array.isArray(candidate))
    : undefined;
  if (!variants) return value;
  const objects = variants
    .map((variant) => at(variant, value.file))
    .filter((variant) => types(variant).includes('object'));
  const [only] = objects;
  if (objects.length !== 1 || !only) {
    throw new Error(`${where}: expected exactly one object branch, found ${objects.length}`);
  }
  return only;
}

function param(op: Operation, name: string): Mapping | undefined {
  return op.params.find((candidate) => candidate.name === name);
}

function paramSchema(parameter: Mapping | undefined): Located {
  return at(parameter?.schema ?? {});
}

function cacheControlSchema(response: Located): Located | undefined {
  const headers = child(response, 'headers');
  if (!headers || !isMapping(headers.node)) return undefined;
  const key = Object.keys(headers.node).find((name) => name.toLowerCase() === 'cache-control');
  const header = key ? child(headers, key) : undefined;
  return header ? child(header, 'schema') : undefined;
}

// ---------------------------------------------------------------------------
// A JSON-Schema validator: the subset this contract uses, nothing more. It is
// proven to reject broken copies of the examples before it is trusted.
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** "Times are UTC, ISO 8601, with a Z." */
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function validate(raw: Located, value: unknown, path: string): string[] {
  const schema = deref(raw);
  const node = schema.node;
  if (!isMapping(node)) return [`${path}: schema is not a mapping`];
  const problems: string[] = [];
  if (Array.isArray(node.allOf)) {
    for (const part of node.allOf) problems.push(...validate(at(part, schema.file), value, path));
  }
  for (const combinator of ['oneOf', 'anyOf'] as const) {
    const variants = node[combinator];
    if (!Array.isArray(variants)) continue;
    const passing = variants.filter(
      (variant) => validate(at(variant, schema.file), value, path).length === 0,
    ).length;
    if (combinator === 'oneOf' ? passing !== 1 : passing < 1) {
      problems.push(`${path}: matches ${passing} ${combinator} branches`);
    }
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
    if (typeof node.minLength === 'number' && length < node.minLength)
      problems.push(`${path}: too short`);
    if (typeof node.maxLength === 'number' && length > node.maxLength)
      problems.push(`${path}: too long`);
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern, 'u').test(value)) {
      problems.push(`${path}: does not match ${node.pattern}`);
    }
    if (node.format === 'uuid' && !UUID.test(value)) problems.push(`${path}: not a uuid`);
    if (node.format === 'date-time') {
      if (!UTC_DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) {
        problems.push(`${path}: not a UTC date-time with a Z`);
      }
    }
  }
  if (typeof value === 'number') {
    if (typeof node.minimum === 'number' && value < node.minimum) problems.push(`${path}: < min`);
    if (typeof node.maximum === 'number' && value > node.maximum) problems.push(`${path}: > max`);
  }
  if (Array.isArray(value)) {
    const items = child(schema, 'items');
    if (items)
      value.forEach((item, index) => problems.push(...validate(items, item, `${path}[${index}]`)));
  }
  if (isMapping(value)) {
    const props = isMapping(node.properties) ? node.properties : {};
    for (const key of Array.isArray(node.required) ? node.required.map(str) : []) {
      if (!(key in value)) problems.push(`${path}: ${key} is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (props[key] !== undefined) {
        problems.push(...validate(at(props[key], schema.file), item, `${path}.${key}`));
      } else if (node.additionalProperties === false) {
        problems.push(`${path}: ${key} is not a property of this closed object`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Example fixtures read from the contract
// ---------------------------------------------------------------------------

function okExample(id: string, status = '200'): Mapping {
  const examples = examplesOf(jsonMedia(responses(operation(id)).get(status)));
  const [first] = examples;
  if (!first || !isMapping(first[1])) throw new Error(`${id} ${status} has no example`);
  return first[1];
}

function rows(page: Mapping): Mapping[] {
  return Array.isArray(page.data) ? page.data.filter(isMapping) : [];
}

function startOf(row: Mapping): number {
  return Date.parse(str(row.type === 'meeting' ? row.startsAt : row.dueAt));
}

const HOUR = 3_600_000;

/** The rules the schema cannot say, for one meeting-shaped object. */
function meetingProblems(row: Mapping, where: string): string[] {
  const problems: string[] = [];
  const starts = Date.parse(str(row.startsAt));
  const ends = Date.parse(str(row.endsAt));
  if (Number.isNaN(starts) || Number.isNaN(ends))
    problems.push(`${where}: startsAt/endsAt missing`);
  if (!(ends > starts)) problems.push(`${where}: endsAt is not after startsAt`);
  if (ends - starts > 24 * HOUR) problems.push(`${where}: longer than 24 hours`);
  if (row.dueAt !== undefined && row.dueAt !== null)
    problems.push(`${where}: a meeting has a dueAt`);
  return problems;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

const P07_FRAME = /^P07\/0[1-9]$/;
const OFFSET_PAGING =
  /^(offset|skip|page|pageNumber|pageNo|pageIndex|start|total|includeTotal|count)$/i;
const SCOPE_OR_OWNER = /programme|tenant|scope|business[-_]?unit|owner|user|assignee|member|team/i;

/** Names that would mean an external calendar, a reminder channel or another out-of-scope P07 frame. */
const OUT_OF_SCOPE =
  /google|microsoft|outlook|office365|ical|\bics\b|caldav|sync|oauth|connect|booking|bookable|slot|holiday|remind|notif|subscri|webhook|sms|whatsapp|email|push|channel|external|provider|attendee|invitee|guest|rsvp|recurr|rrule|location|latitude|longitude|gps|geo|check-?in|brief|prep|priority|offline|queue/i;

/** A route that would reopen a task, by any name. */
const REOPEN = /reopen|re-open|uncomplete|incomplete|undo|restore|revert|unfinish/i;

const ACTIVITY_SCHEMAS = [
  'Activity',
  'ActivityItem',
  'CreateActivityRequest',
  'UpdateActivityRequest',
  'MyActivity',
  'MyActivityPage',
] as const;

describe('acceptance: records contract, activities, tasks and the calendar (T-0081)', () => {
  describe('the operations', () => {
    it('listMyActivities is GET /api/v1/me/activities, implemented since T-0082, and names P07/01', () => {
      const op = operation(MY_ACTIVITIES);
      expect(op.method).toBe('get');
      expect(op.path).toBe('/api/v1/me/activities');
      expect(op.op['x-kasuwa-implemented'], 'T-0082 serves it').toBe(true);
      expect(screensOf(op), 'My tasks is P07/01').toContain('P07/01');
      expect(screensOf(op).filter((screen) => !P07_FRAME.test(screen))).toEqual([]);
    });

    it('listCalendar is GET /api/v1/me/calendar, implemented since T-0082, and names the calendar frames', () => {
      const op = operation(CALENDAR);
      expect(op.method).toBe('get');
      expect(op.path).toBe('/api/v1/me/calendar');
      expect(op.op['x-kasuwa-implemented'], 'T-0082 serves it').toBe(true);
      expect(screensOf(op)).toEqual(expect.arrayContaining(['P07/03', 'P07/04', 'P07/05']));
      expect(screensOf(op).filter((screen) => !P07_FRAME.test(screen))).toEqual([]);
    });

    it('createActivity and updateActivity stay served at their paths and name their P07 frames', () => {
      gate();
      const create = operation(CREATE);
      expect([create.method, create.path]).toEqual(['post', '/api/v1/activities']);
      expect(create.op['x-kasuwa-implemented'], 'T-0061 serves it').toBe(true);
      expect(screensOf(create), 'the composer is P07/07').toContain('P07/07');
      const update = operation(UPDATE);
      expect(update.method).toBe('patch');
      expect(update.path).toMatch(/^\/api\/v1\/activities\/\{[A-Za-z]+\}$/);
      expect(update.op['x-kasuwa-implemented'], 'T-0061 serves it').toBe(true);
      expect(screensOf(update), 'complete and snooze (P07/01), drag (P07/03)').toEqual(
        expect.arrayContaining(['P07/01', 'P07/03']),
      );
    });

    it('every property this slice adds to a served schema is marked x-kasuwa-implemented: true (T-0082 serves it)', () => {
      const added: [string, string][] = [
        ['Activity', 'startsAt'],
        ['Activity', 'endsAt'],
        ['ActivityItem', 'startsAt'],
        ['ActivityItem', 'endsAt'],
        ['CreateActivityRequest', 'startsAt'],
        ['CreateActivityRequest', 'endsAt'],
        ['UpdateActivityRequest', 'dueAt'],
        ['UpdateActivityRequest', 'startsAt'],
        ['UpdateActivityRequest', 'endsAt'],
      ];
      const problems: string[] = [];
      for (const [schema, key] of added) {
        const raw = rawProperty(schemaNamed(schema), key);
        if (!raw) problems.push(`${schema}.${key} is missing`);
        else if (raw['x-kasuwa-implemented'] !== true) {
          problems.push(`${schema}.${key} is not marked x-kasuwa-implemented: true`);
        }
      }
      expect(problems).toEqual([]);
      // The served properties are not marked pending: the mark must mean something.
      expect(rawProperty(schemaNamed('Activity'), 'dueAt')?.['x-kasuwa-implemented']).not.toBe(
        false,
      );
    });
  });

  describe('listMyActivities: whose, which bucket, which zone', () => {
    it('takes exactly timeZone, bucket, cursor and limit, all in the query', () => {
      const op = operation(MY_ACTIVITIES);
      expect(op.params.map((parameter) => str(parameter.name)).sort()).toEqual(
        ['bucket', 'cursor', 'limit', 'timeZone'].sort(),
      );
      expect(op.params.filter((parameter) => parameter.in !== 'query')).toEqual([]);
      expect(op.op.requestBody, 'a GET takes no body').toBeUndefined();
    });

    it('timeZone is a required string with a pattern and no default', () => {
      const tz = param(operation(MY_ACTIVITIES), 'timeZone');
      expect(
        tz?.required,
        'timeZone must be required: a default gives a WAT user UTC buckets',
      ).toBe(true);
      const schema = paramSchema(tz);
      const node = isMapping(schema.node) ? schema.node : {};
      expect(types(schema)).toEqual(['string']);
      expect(node.default, 'no default zone').toBeUndefined();
      expect(typeof node.pattern, 'no pattern').toBe('string');
      expect(typeof node.maxLength === 'number' && node.maxLength <= 64, 'maxLength <= 64').toBe(
        true,
      );
    });

    // The pattern is the first filter; the IANA database is the second. Each
    // rejected value below is one a careless lookup would accept or misuse.
    const ACCEPTED = [
      'Africa/Lagos',
      'Africa/Nairobi',
      'Africa/Johannesburg',
      'Africa/Accra',
      'UTC',
      'Etc/UTC',
      'Etc/GMT-1',
      'America/Argentina/Buenos_Aires',
      'America/Port-au-Prince',
    ];
    const REJECTED = [
      '',
      '+01:00',
      'UTC+1',
      'GMT+01:00',
      '../etc/passwd',
      'Africa/../../etc/passwd',
      '/etc/localtime',
      'Africa//Lagos',
      'Africa/Lagos/',
      'Africa\\Lagos',
      ' Africa/Lagos',
      'Africa/Lagos ',
      'Africa/Lagos\u0000',
      'Africa/Lagos\n',
      'Africa/Lagos%2F..',
      'A/B/C/D',
      `Africa/${'x'.repeat(80)}`,
    ];
    it('the timeZone pattern accepts IANA names and rejects offsets, paths, padding and NUL', () => {
      const schema = paramSchema(param(operation(MY_ACTIVITIES), 'timeZone'));
      const accepted = ACCEPTED.filter((value) => validate(schema, value, 'timeZone').length > 0);
      expect(accepted, 'valid IANA names the contract rejects').toEqual([]);
      const leaked = REJECTED.filter((value) => validate(schema, value, 'timeZone').length === 0);
      expect(
        leaked.map((value) => JSON.stringify(value)),
        'values the contract lets through',
      ).toEqual([]);
    });

    it('an unknown zone is 400 invalid_time_zone, never a fallback to UTC or the tenant zone', () => {
      const tz = param(operation(MY_ACTIVITIES), 'timeZone');
      const text = prose(`${description(operation(MY_ACTIVITIES))}\n${str(tz?.description)}`);
      expect(text).toMatch(/invalid_time_zone/);
      expect(text, 'the IANA database decides').toMatch(/IANA time-zone database/);
      expect(text, 'an abbreviation is named as refused').toMatch(/`WAT`/);
      expect(text, 'an offset is named as refused').toMatch(/`\+01:00`/);
      expect(text, 'no silent substitution').toMatch(/never substitutes UTC/i);
      // The 400 carries an example a client can switch on.
      const bad = responses(operation(MY_ACTIVITIES)).get('400');
      expect(bad ? exampleDetails(bad) : []).toContainEqual({
        path: 'timeZone',
        code: 'invalid_time_zone',
      });
    });

    it('bucket is required and exactly overdue, today, upcoming', () => {
      const bucket = param(operation(MY_ACTIVITIES), 'bucket');
      expect(bucket?.required).toBe(true);
      expect(enumOf(paramSchema(bucket)).map(str)).toEqual(['overdue', 'today', 'upcoming']);
    });

    it('the buckets are computed by the server from now and the next midnight in timeZone, disjoint, undated last', () => {
      const text = prose(description(operation(MY_ACTIVITIES)));
      expect(text).toMatch(/`overdue`: `dueAt` before now/);
      expect(text).toMatch(/`today`: `dueAt` from now until the next midnight in `timeZone`/);
      expect(text).toMatch(/`upcoming`: `dueAt` at or after that midnight/);
      expect(text, 'undated tasks have a place').toMatch(/no `dueAt`, last/);
      expect(text).toMatch(/disjoint/i);
      expect(text, 'every time on the wire stays UTC').toMatch(/UTC with a `Z`/);
    });

    it("lists only the caller's own open tasks in the session's programmes; completing one removes it", () => {
      const text = prose(description(operation(MY_ACTIVITIES)));
      expect(text).toMatch(/`ownerUserId` is the session's user/);
      expect(text).toMatch(/programmes the session resolves/);
      expect(text, 'a task in a programme the caller left').toMatch(
        /no longer reach is not listed/,
      );
      expect(text).toMatch(/A completed task is not listed/);
      expect(text).toMatch(/no operation reopens it \(D-L81\)/);
      expect(text, 'notes, calls and meetings are not tasks').toMatch(
        /Notes, calls and meetings are never listed/,
      );
    });

    it("its items are tasks and meetings only, and a listMyActivities item's completedAt is null", () => {
      const item = schemaNamed('MyActivity');
      const type = properties(item).get('type');
      expect(type ? enumOf(type).map(str).sort() : []).toEqual(['meeting', 'task']);
      const page = okExample(MY_ACTIVITIES);
      const data = rows(page);
      expect(data.length, 'the example lists no task').toBeGreaterThan(0);
      for (const row of data) {
        expect(row.type, 'listMyActivities lists tasks').toBe('task');
        expect(row.completedAt, 'listMyActivities lists open tasks').toBeNull();
      }
    });
  });

  describe('listCalendar: a bounded UTC window of Kasuwa events', () => {
    it('takes exactly from, to, cursor and limit; from and to are required UTC date-times', () => {
      const op = operation(CALENDAR);
      expect(op.params.map((parameter) => str(parameter.name)).sort()).toEqual(
        ['cursor', 'from', 'limit', 'to'].sort(),
      );
      expect(op.params.filter((parameter) => parameter.in !== 'query')).toEqual([]);
      for (const name of ['from', 'to']) {
        const parameter = param(op, name);
        expect(parameter?.required, `${name} required`).toBe(true);
        expect(formatOf(paramSchema(parameter)), `${name} format`).toBe('date-time');
        // An unbounded or offset time is what the window bound is for.
        const schema = paramSchema(parameter);
        expect(validate(schema, '2026-09-28T00:00:00.000Z', name)).toEqual([]);
        expect(
          validate(schema, '2026-09-28T01:00:00+01:00', name).length,
          `${name}: an offset`,
        ).toBeGreaterThan(0);
        expect(
          validate(schema, '2026-09-28', name).length,
          `${name}: a date alone`,
        ).toBeGreaterThan(0);
      }
    });

    it('the window is at most 42 days, to after from, both 400 with their own codes, never clamped', () => {
      const op = operation(CALENDAR);
      const text = prose(`${description(op)}\n${str(param(op, 'to')?.description)}`);
      expect(text).toMatch(/at most 42 days/);
      expect(text).toMatch(/window_too_long/);
      expect(text).toMatch(/invalid_window/);
      expect(text).toMatch(/never clamped/);
      expect(text, 'equal from and to is not a window').toMatch(/equal is not after/);
      expect(text, 'the server assumes no zone').toMatch(/assumes no zone/);
      const bad = responses(op).get('400');
      expect(bad ? exampleDetails(bad) : []).toContainEqual({
        path: 'to',
        code: 'window_too_long',
      });
      // No second way to ask for more: no `days`, `range` or `limitDays` knob.
      expect(
        op.params.filter((parameter) => /day|range|span|window/i.test(str(parameter.name))),
      ).toEqual([]);
    });

    it('lists tasks with a dueAt in [from, to) and meetings that overlap the window, nothing else', () => {
      const text = prose(description(operation(CALENDAR)));
      expect(text).toMatch(/`from` <= `dueAt` < `to`/);
      expect(text).toMatch(/`startsAt` before `to` and `endsAt` after `from`/);
      expect(text).toMatch(/began before `from` is listed/);
      expect(text).toMatch(/Notes, calls and tasks with no `dueAt` .* never listed/);
      expect(text).toMatch(/`ownerUserId` is the session's user/);
      expect(text).toMatch(/programmes the session resolves/);
    });

    it('shows Kasuwa events only: no external calendar, sync, booking page or holiday (D-P22)', () => {
      const text = prose(description(operation(CALENDAR)));
      expect(text).toMatch(/Kasuwa events only \(D-P22\)/);
      expect(text).toMatch(/No Google, Microsoft or other external calendar/);
      expect(text).toMatch(/no booking page/);
      expect(text).toMatch(/no public-holiday calendar/);
    });

    it('the example window holds a task and a meeting, ordered by start, each obeying its rules', () => {
      const data = rows(okExample(CALENDAR));
      expect(data.map((row) => row.type).sort()).toEqual(
        expect.arrayContaining(['meeting', 'task']),
      );
      const starts = data.map(startOf);
      expect(starts.some(Number.isNaN), 'an item with no start').toBe(false);
      expect(
        [...starts].sort((a, b) => a - b),
        'not ordered by start',
      ).toEqual(starts);
      const problems = data.flatMap((row, index) =>
        row.type === 'meeting'
          ? meetingProblems(row, `item ${index}`)
          : row.startsAt !== null || row.endsAt !== null
            ? [`item ${index}: a task with meeting times`]
            : [],
      );
      expect(problems).toEqual([]);
    });
  });

  describe('paging: keyset, an id-only cursor, no counts (D-L80, D-P13)', () => {
    for (const id of NEW_READS) {
      it(`${id}: an opaque id-only cursor that cannot test whether an id exists, and a limit of at most 100`, () => {
        const op = operation(id);
        const cursor = param(op, 'cursor');
        expect(cursor, 'no cursor').toBeDefined();
        expect(cursor?.required, 'cursor is optional').not.toBe(true);
        const text = prose(str(cursor?.description));
        expect(text).toMatch(/opaque/i);
        expect(text).toMatch(/id of the last row and nothing else \(D-L80\)/);
        expect(text).toMatch(/invalid_cursor/);
        expect(text, 'one body for every refused cursor').toMatch(
          /cannot test whether an id exists/,
        );
        expect(text, 'a moved row still resolves').toMatch(/CURRENT sort key/);
        const cursorNode = paramSchema(cursor).node;
        expect(
          isMapping(cursorNode) && typeof cursorNode.maxLength === 'number',
          'cursor maxLength',
        ).toBe(true);
        const limit = paramSchema(param(op, 'limit')).node;
        expect(isMapping(limit) ? limit.type : undefined).toBe('integer');
        expect(isMapping(limit) ? limit.minimum : undefined).toBe(1);
        expect(Number(isMapping(limit) ? limit.maximum : Infinity)).toBeLessThanOrEqual(100);
        expect(
          op.params
            .map((parameter) => str(parameter.name))
            .filter((name) => OFFSET_PAGING.test(name)),
        ).toEqual([]);
      });

      it(`${id}: the 200 is a closed { data, nextCursor } page with no count of any kind`, () => {
        const page = responseSchema(id, '200');
        expect(isClosed(page), 'page not closed').toBe(true);
        expect([...properties(page).keys()].sort()).toEqual(['data', 'nextCursor']);
        expect(required(page)).toEqual(expect.arrayContaining(['data', 'nextCursor']));
        const next = properties(page).get('nextCursor');
        expect(next ? types(next).sort() : []).toEqual(['null', 'string']);
        const data = properties(page).get('data');
        const item = data ? child(data, 'items') : undefined;
        expect(item?.node, `${id} rows are not MyActivity`).toBe(schemaNamed('MyActivity').node);
        expect(prose(description(operation(id))), 'D-P13 not cited').toMatch(/D-P13/);
      });

      it(`${id}: ordered ascending with an id tie-break`, () => {
        const text = prose(description(operation(id)));
        expect(text).toMatch(/ascending/);
        expect(text).toMatch(/ties broken by `id` ascending/);
      });
    }

    it('the listMyActivities example is in dueAt order', () => {
      const starts = rows(okExample(MY_ACTIVITIES)).map((row) => Date.parse(str(row.dueAt)));
      expect(starts.length).toBeGreaterThan(1);
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    });
  });

  describe('field security on the new lists', () => {
    it('MyActivity is closed; never-withheld fields are required, the rest optional', () => {
      const item = schemaNamed('MyActivity');
      expect(isClosed(item)).toBe(true);
      const req = required(item);
      expect(req).toEqual(
        expect.arrayContaining(['id', 'programmeId', 'type', 'version', 'withheldFields']),
      );
      const withheld = properties(item).get('withheldFields');
      const names = withheld ? enumOf(withheld).map(str) : [];
      expect(names.length, 'withheldFields has no enum').toBeGreaterThan(0);
      const props = [...properties(item).keys()];
      expect(
        names.filter((name) => !props.includes(name)),
        'withheld names that are not properties',
      ).toEqual([]);
      expect(
        names.filter((name) => req.includes(name)),
        'a withholdable field is required',
      ).toEqual([]);
      expect(names).toEqual(
        expect.arrayContaining(['subject', 'dueAt', 'startsAt', 'endsAt', 'contact', 'account']),
      );
      for (const never of ['id', 'programmeId', 'type', 'version', 'withheldFields']) {
        expect(names, `${never} is never withheld`).not.toContain(never);
      }
    });

    it('a row whose time is withheld is not listed, and omission happens before paging', () => {
      const my = prose(description(operation(MY_ACTIVITIES)));
      expect(my).toMatch(/A task whose `dueAt` is withheld from the caller is not listed at all/);
      expect(my).toMatch(/before the page is cut/);
      const cal = prose(description(operation(CALENDAR)));
      expect(cal).toMatch(/whose `startsAt` or `endsAt` is withheld, is not listed at all/);
      expect(cal).toMatch(/before the page is cut/);
    });

    it('MyActivity carries no body, owner, tenant or free text beyond the subject', () => {
      const keys = [...properties(schemaNamed('MyActivity')).keys()];
      expect(
        keys.filter((key) =>
          /^(body|notes?|description|owner|ownerUserId|tenantId|createdByUserId)$/.test(key),
        ),
      ).toEqual([]);
    });

    it('contact and account are { id, name } | null, closed', () => {
      const item = schemaNamed('MyActivity');
      for (const [key, nameKey] of [
        ['contact', 'displayName'],
        ['account', 'name'],
      ] as const) {
        const value = properties(item).get(key);
        expect(value, `MyActivity.${key}`).toBeDefined();
        if (!value) continue;
        expect(types(value), `${key} admits null`).toContain('null');
        const object = objectBranch(value, key);
        expect(isClosed(object), `${key} closed`).toBe(true);
        expect([...properties(object).keys()].sort()).toEqual(['id', nameKey].sort());
        expect(required(object)).toEqual(expect.arrayContaining(['id', nameKey]));
        const id = properties(object).get('id');
        expect(id ? formatOf(id) : '').toBe('uuid');
      }
    });

    it('every time on MyActivity is a nullable date-time', () => {
      const item = schemaNamed('MyActivity');
      for (const key of ['dueAt', 'completedAt', 'startsAt', 'endsAt']) {
        const value = properties(item).get(key);
        expect(value ? formatOf(value) : '', `${key} format`).toBe('date-time');
        expect(value ? types(value).sort() : [], `${key} types`).toEqual(['null', 'string']);
      }
    });
  });

  describe('the meeting type', () => {
    it('ActivityType is exactly note, task, call, meeting', () => {
      expect(enumOf(schemaNamed('ActivityType')).map(str)).toEqual([
        'note',
        'task',
        'call',
        'meeting',
      ]);
    });

    it('Activity and the timeline item carry optional, nullable startsAt and endsAt; Activity may withhold them', () => {
      for (const name of ['Activity', 'ActivityItem']) {
        const schema = schemaNamed(name);
        expect(isClosed(schema), `${name} closed`).toBe(true);
        for (const key of ['startsAt', 'endsAt']) {
          const value = properties(schema).get(key);
          expect(value, `${name}.${key}`).toBeDefined();
          expect(value ? formatOf(value) : '', `${name}.${key}`).toBe('date-time');
          expect(value ? types(value).sort() : [], `${name}.${key}`).toEqual(['null', 'string']);
          expect(
            required(schema),
            `${name}.${key} must stay optional (withheld, and unserved until T-0082)`,
          ).not.toContain(key);
        }
      }
      const withheld = properties(schemaNamed('Activity')).get('withheldFields');
      expect(withheld ? enumOf(withheld).map(str) : []).toEqual(
        expect.arrayContaining(['startsAt', 'endsAt']),
      );
      expect(
        required(schemaNamed('ActivityItem')),
        'the timeline item still carries its version',
      ).toContain('version');
    });

    it('a create takes startsAt and endsAt as non-null UTC date-times, and nothing server-owned', () => {
      const body = requestSchema(CREATE);
      expect(isClosed(body)).toBe(true);
      for (const key of ['startsAt', 'endsAt']) {
        const value = properties(body).get(key);
        expect(value, key).toBeDefined();
        expect(value ? formatOf(value) : '', key).toBe('date-time');
        expect(value ? types(value) : [], `${key}: a meeting always has both`).toEqual(['string']);
      }
      expect(
        [...properties(body).keys()].filter((key) =>
          /^(id|programmeId|version|completedAt|createdByUserId|completed)$/.test(key),
        ),
      ).toEqual([]);
    });

    it('createActivity states the meeting invariants and their codes', () => {
      const text = prose(description(operation(CREATE)));
      expect(text).toMatch(/A `meeting` requires `startsAt` and `endsAt`/);
      expect(text).toMatch(/`endsAt` must be after `startsAt` \(`400 invalid_range`/);
      expect(text).toMatch(/equal is not after/);
      expect(text).toMatch(/at most 24 hours after it \(`400 too_long`/);
      expect(text).toMatch(/`400 meeting_only`/);
      expect(text, 'dueAt on a meeting').toMatch(
        /`dueAt` on a note, a call or a meeting is `400` \(`task_only`\)/,
      );
      expect(text, 'no new right (D-L87)').toMatch(/there is no new permission/);
      expect(text).toMatch(/Order: `404`, `403`, `400`/);
    });

    it('the createActivity examples include a valid meeting', () => {
      const examples = examplesOf(jsonMedia(requestBody(CREATE)));
      const meetings = examples
        .map(([, value]) => value)
        .filter((value) => isMapping(value) && value.type === 'meeting');
      expect(meetings.length, 'no meeting example').toBeGreaterThan(0);
      expect(
        meetings.flatMap((value, index) =>
          isMapping(value) ? meetingProblems(value, `meeting ${index}`) : [],
        ),
      ).toEqual([]);
    });
  });

  describe('updateActivity: snooze and reschedule (D-L102, D-P18)', () => {
    it('the body is closed: version plus completed, ownerUserId, dueAt, startsAt, endsAt, dealId (T-0111)', () => {
      const body = requestSchema(UPDATE);
      expect(isClosed(body)).toBe(true);
      // T-0111 (lead edit): dealId, the deal link, is the one link an update may change.
      expect([...properties(body).keys()].sort()).toEqual(
        ['completed', 'dealId', 'dueAt', 'endsAt', 'ownerUserId', 'startsAt', 'version'].sort(),
      );
      expect(required(body)).toEqual(['version']);
      const due = properties(body).get('dueAt');
      expect(due ? formatOf(due) : '').toBe('date-time');
      expect(due ? types(due).sort() : [], 'dueAt: null clears it').toEqual(['null', 'string']);
      for (const key of ['startsAt', 'endsAt']) {
        const value = properties(body).get(key);
        expect(value ? formatOf(value) : '', key).toBe('date-time');
        expect(value ? types(value) : [], `${key} is not nullable`).toEqual(['string']);
      }
    });

    it('sends only the changed fields, judges the meeting rules on the result, and orders its errors 404, 403, 400, 409', () => {
      const text = prose(description(operation(UPDATE)));
      expect(text).toMatch(/ONLY the fields the person changed \(D-L102\)/);
      expect(text).toMatch(/judged on the RESULT/);
      expect(text).toMatch(/`400 meeting_only`/);
      expect(text).toMatch(/`400 task_only`/);
      expect(text).toMatch(/`400 invalid_range`/);
      expect(text).toMatch(/`400 too_long`/);
      expect(text).toMatch(/Order: `404`, `403`, `400`, `409`/);
      expect(text, 'no new right to snooze or reschedule').toMatch(
        /whoever may update the activity may move it \(D-L87, D-P18\)/,
      );
      expect(text, 'field security binds the new fields').toMatch(
        /`dueAt`, `startsAt` and `endsAt`: sending one that is withheld from, or read-only for, the caller is `403 not_permitted`/,
      );
      expect(text).toMatch(/field_not_editable/);
      const codes = [...responses(operation(UPDATE)).keys()].sort();
      expect(codes).toEqual(['200', '400', '401', '403', '404', '409']);
    });

    it('its examples complete, snooze and reschedule, each sending version plus the changed fields', () => {
      const examples = examplesOf(jsonMedia(requestBody(UPDATE)))
        .map(([, value]) => value)
        .filter(isMapping);
      expect(
        examples.some((value) => 'dueAt' in value),
        'no snooze example',
      ).toBe(true);
      expect(
        examples.some((value) => 'startsAt' in value && 'endsAt' in value),
        'no reschedule example',
      ).toBe(true);
      const reschedule = examples.find((value) => 'startsAt' in value && 'endsAt' in value);
      expect(reschedule ? meetingProblems(reschedule, 'reschedule') : ['none']).toEqual([]);
      for (const value of examples) {
        expect(typeof value.version, 'every example sends version').toBe('number');
        expect(Object.keys(value).length, 'an example that changes nothing').toBeGreaterThan(1);
      }
    });
  });

  describe('no operation reopens a task (D-L81, D-L87)', () => {
    it('completed admits only true', () => {
      const completed = properties(requestSchema(UPDATE)).get('completed');
      expect(completed ? enumOf(completed) : []).toEqual([true]);
      expect(prose(description(operation(UPDATE)))).toMatch(/a completed task stays completed/);
    });

    it('no request body anywhere in the file takes completedAt or a reopening flag', () => {
      gate();
      const offending: string[] = [];
      for (const op of operations()) {
        const body = jsonSchema(
          op.op.requestBody === undefined ? undefined : at(op.op.requestBody),
        );
        if (!body) continue;
        for (const key of properties(body).keys()) {
          if (
            /^completedAt$|^(re)?open(ed)?$|^incomplete$|^uncomplete|^undone$|^done$/i.test(key)
          ) {
            offending.push(`${op.id}: ${key}`);
          }
        }
      }
      expect(offending).toEqual([]);
    });

    it('no operation is named or routed like reopen, undo or restore', () => {
      gate();
      expect(
        operations()
          .filter((op) => REOPEN.test(op.id) || REOPEN.test(op.path))
          .map((op) => op.id),
      ).toEqual([]);
    });
  });

  describe('no external calendar and no reminder channel (D-P22, D-P29)', () => {
    it('no operation in the file is about sync, booking, holidays, reminders or a calendar provider', () => {
      gate();
      const offending = operations()
        .filter((op) => /calendar|activit/i.test(op.path) || /calendar|activit/i.test(op.id))
        .filter((op) => OUT_OF_SCOPE.test(op.id) || OUT_OF_SCOPE.test(op.path))
        .map((op) => `${op.id} ${op.path}`);
      expect(offending).toEqual([]);
      // And none at all whose path names a provider or a booking page.
      expect(
        operations()
          .filter((op) =>
            /google|microsoft|outlook|caldav|ical|booking|holiday|remind/i.test(op.path),
          )
          .map((op) => op.path),
      ).toEqual([]);
    });

    it('no parameter of the touched operations names a provider, a channel or a reminder', () => {
      gate();
      const offending: string[] = [];
      for (const id of TOUCHED) {
        for (const parameter of operation(id).params) {
          if (OUT_OF_SCOPE.test(str(parameter.name)))
            offending.push(`${id}: ${str(parameter.name)}`);
        }
      }
      expect(offending).toEqual([]);
    });

    it('no activity schema has a property for a provider, a channel, a reminder, attendees, a place or an AI brief', () => {
      gate();
      const offending: string[] = [];
      let inspected = 0;
      for (const name of ACTIVITY_SCHEMAS) {
        for (const path of deepKeys(schemaNamed(name))) {
          inspected += 1;
          if (OUT_OF_SCOPE.test(leafOf(path))) offending.push(`${name}.${path}`);
        }
      }
      expect(offending).toEqual([]);
      expect(inspected, 'no property inspected').toBeGreaterThan(40);
    });
  });

  describe('errors, scope and caching', () => {
    it('the new reads document exactly 200, 400 and 401: never 403, and no 404 without a record id', () => {
      for (const id of NEW_READS) {
        expect([...responses(operation(id)).keys()].sort(), id).toEqual(['200', '400', '401']);
      }
    });

    it('every error on the touched operations uses the same Error schema as getContact', () => {
      const shared = jsonSchema(responses(operation('getContact')).get('404'));
      if (!shared) throw new Error('getContact 404 has no schema');
      const strays: string[] = [];
      let count = 0;
      for (const id of TOUCHED) {
        for (const [code, response] of responses(operation(id))) {
          if (!/^[45]\d\d$/.test(code)) continue;
          count += 1;
          const schema = jsonSchema(response);
          if (!schema || schema.node !== shared.node) strays.push(`${id} ${code}`);
          const expected: Record<string, string> = {
            '400': 'validation_failed',
            '401': 'not_authenticated',
            '403': 'not_permitted',
            '404': 'not_found',
            '409': 'stale_write',
          };
          const want = expected[code];
          if (want) {
            const codes = exampleCodes(response);
            if (codes.length === 0 || codes.some((value) => value !== want)) {
              strays.push(`${id} ${code}: example codes ${JSON.stringify(codes)}`);
            }
          }
        }
      }
      expect(strays).toEqual([]);
      expect(count).toBeGreaterThanOrEqual(13);
    });

    it('no touched operation takes a programme, tenant, owner or user argument (rule 1)', () => {
      const offending: string[] = [];
      for (const id of TOUCHED) {
        const op = operation(id);
        if (/\/(programmes|tenants|users)\//i.test(op.path)) offending.push(`${id}: ${op.path}`);
        for (const parameter of op.params) {
          const name = str(parameter.name);
          if (parameter.in === 'path') continue;
          if (SCOPE_OR_OWNER.test(name)) offending.push(`${id}: ${str(parameter.in)} ${name}`);
          if (parameter.in === 'header' || parameter.in === 'cookie')
            offending.push(`${id}: ${str(parameter.in)} ${name}`);
        }
        if (op.op.security !== undefined) offending.push(`${id}: overrides security`);
      }
      expect(offending).toEqual([]);
    });

    it('every response of the touched operations, errors included, is Cache-Control: no-store', () => {
      const problems: string[] = [];
      let checked = 0;
      for (const id of TOUCHED) {
        for (const [status, response] of responses(operation(id))) {
          checked += 1;
          const schema = cacheControlSchema(response);
          const values = schema ? enumOf(schema) : [];
          if (JSON.stringify(values) !== JSON.stringify(['no-store'])) {
            problems.push(`${id} ${status}: ${schema ? JSON.stringify(values) : 'missing'}`);
          }
        }
      }
      expect(problems).toEqual([]);
      expect(checked).toBeGreaterThanOrEqual(17);
    });
  });

  describe('examples are valid against their schemas', () => {
    it('(self-check) the validator rejects broken copies of the contract examples', () => {
      // A validator only ever seen passing proves nothing.
      const page = responseSchema(CALENDAR, '200');
      const example = okExample(CALENDAR);
      const data = rows(example);
      const [task, meeting] = [
        data.find((row) => row.type === 'task'),
        data.find((row) => row.type === 'meeting'),
      ];
      if (!task || !meeting) throw new Error('the calendar example needs a task and a meeting');
      expect(validate(page, example, 'page'), 'the unbroken example').toEqual([]);
      const mutants: [string, unknown][] = [
        ['a page with a total', { ...example, total: 2 }],
        ['an item with a body', { ...example, data: [{ ...task, body: 'x' }] }],
        ['an item with an owner', { ...example, data: [{ ...task, ownerUserId: task.id }] }],
        ['a visit', { ...example, data: [{ ...meeting, type: 'visit' }] }],
        ['a note', { ...example, data: [{ ...task, type: 'note' }] }],
        [
          'an offset time',
          { ...example, data: [{ ...meeting, startsAt: '2026-09-30T15:30:00+01:00' }] },
        ],
        [
          'an item with no version',
          {
            ...example,
            data: [{ ...task, version: undefined }].map(
              (row) => JSON.parse(JSON.stringify(row)) as unknown,
            ),
          },
        ],
        [
          'a contact with a phone',
          {
            ...example,
            data: [
              { ...task, contact: { id: task.id, displayName: 'A', phone: '+2348030000000' } },
            ],
          },
        ],
        [
          'a withheld name not in the enum',
          { ...example, data: [{ ...task, withheldFields: ['body'] }] },
        ],
        ['no nextCursor', { data: example.data }],
      ];
      for (const [label, mutant] of mutants) {
        expect(validate(page, mutant, 'page').length, `accepted ${label}`).toBeGreaterThan(0);
      }
      const update = requestSchema(UPDATE);
      expect(
        validate(update, { version: 2, completed: false }, 'body').length,
        'accepted completed: false',
      ).toBeGreaterThan(0);
      expect(
        validate(update, { version: 2, completedAt: null }, 'body').length,
        'accepted completedAt',
      ).toBeGreaterThan(0);
      expect(
        validate(update, { version: 2, startsAt: null }, 'body').length,
        'accepted startsAt: null',
      ).toBeGreaterThan(0);
      expect(
        validate(update, { dueAt: '2026-10-01T08:00:00.000Z' }, 'body').length,
        'accepted no version',
      ).toBeGreaterThan(0);
      expect(
        meetingProblems({ ...meeting, endsAt: meeting.startsAt }, 'm').length,
        'accepted a zero-length meeting',
      ).toBeGreaterThan(0);
      expect(
        meetingProblems(
          {
            ...meeting,
            endsAt: new Date(Date.parse(str(meeting.startsAt)) + 25 * HOUR).toISOString(),
          },
          'm',
        ).length,
        'accepted a 25-hour meeting',
      ).toBeGreaterThan(0);
    });

    it('every request and response example on the four touched operations validates', () => {
      const problems: string[] = [];
      let checked = 0;
      for (const id of TOUCHED) {
        const op = operation(id);
        const body = op.op.requestBody === undefined ? undefined : at(op.op.requestBody);
        const bodySchema = jsonSchema(body);
        for (const [label, value] of examplesOf(jsonMedia(body))) {
          checked += 1;
          if (bodySchema) problems.push(...validate(bodySchema, value, `${id} request ${label}`));
        }
        for (const [status, response] of responses(op)) {
          const schema = jsonSchema(response);
          for (const [label, value] of examplesOf(jsonMedia(response))) {
            checked += 1;
            if (schema) problems.push(...validate(schema, value, `${id} ${status} ${label}`));
          }
        }
      }
      expect(problems).toEqual([]);
      // Two 200 examples, two create and three update bodies, and the error examples.
      expect(checked).toBeGreaterThanOrEqual(15);
    });

    it('the timeline examples still validate against the widened activity item (D-L97)', () => {
      const problems: string[] = [];
      for (const id of ['listContactTimeline', 'listAccountTimeline']) {
        const schema = responseSchema(id, '200');
        for (const [label, value] of examplesOf(jsonMedia(responses(operation(id)).get('200')))) {
          problems.push(...validate(schema, value, `${id} ${label}`));
        }
      }
      expect(problems).toEqual([]);
      gate(); // Not vacuous on main: this holds before the work starts.
    });
  });
});
