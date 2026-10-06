import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * ACCEPTANCE — T-0059, the records API contract for the 360° RECORD VIEW,
 * contact side (P05; D-L69, D-L63, D-L64, D-L54, D-L13, D-P13, ADR-0003,
 * ADR-0004). Agent 3. Contract only: no route, no migration, no code. Written
 * by QA for the lead from the invariants (D-L23, D-L25), not from an
 * implementation; there is none yet.
 *
 * The artefact under test is `docs/api/records.openapi.yaml`. This suite reads
 * it as data (parsed YAML, never a regex over the raw text, so a keyword in a
 * YAML comment satisfies nothing). The T-0039 suite keeps the contacts half
 * and the whole-file rules (every `$ref` resolves, unique operationIds); the
 * T-0052 suite keeps accounts. This suite does not repeat them.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT THIS SUITE PINS (the builder writes the YAML)
 * ---------------------------------------------------------------------------
 *
 *   listContactTimeline   GET /api/v1/contacts/{<id>}/timeline
 *
 *   The path parameter is one required `format: uuid` string; its name is the
 *   builder's (the file's ContactId parameter is the obvious one). Carries
 *   `x-kasuwa-implemented` (boolean) and `x-kasuwa-screens` naming P05/01 (the
 *   contact record, desktop). P05 frames: 01 contact desktop, 02 tablet and
 *   mobile, 03 WhatsApp window closed, 04 account, 05 field security and
 *   offline, 06 loading and access denied. As in T-0052, `false` is not
 *   pinned; the lie is: `true` with no apps/api/src controller routing
 *   `timeline`.
 *
 *   PAGING (D-P13). Opaque `cursor`, `limit` 1..N with N <= 100, no
 *   offset/page/skip. 200 is `{ data: TimelineItem[], nextCursor: string |
 *   null }`, both required, and the page carries no total, count, offset or
 *   any "withheld"/"hidden" marker. The description says NEWEST first and
 *   names a TIE-break: one PATCH that changes three fields is one audit event
 *   and three items with the same `occurredAt`, so a keyset on time alone
 *   drops or repeats items at a page edge.
 *
 *   TimelineItem: a `oneOf` with `discriminator.propertyName: type`. Every
 *   branch pins `type` to one snake_case value (const or one-value enum); a
 *   `discriminator.mapping`, if given, agrees with them. The type set
 *   CONTAINS `field_changed` and `consent_changed` and is a SUBSET of
 *   { field_changed, consent_changed, activity } (`activity` reserved for
 *   T-0060). Every other P05 timeline kind (WhatsApp, call, SMS, email, note,
 *   ticket, payment, invoice) belongs to an unbuilt module and is not a type.
 *     Every branch REQUIRES `id` (string), `type`, `occurredAt` (date-time)
 *     and `actor`.
 *     actor: `{ id: uuid, displayName: string } | null` — one object branch,
 *     CLOSED, both required (the T-0043 owner shape). `null` is the system.
 *     Never an email, phone or anything else.
 *
 *   field_changed, after any nested oneOf/anyOf is flattened into variants:
 *     - every variant REQUIRES `field`, a string ENUM. The enum is how
 *       "names the field by its contract wire name" is checkable: every value
 *       is a Contact property, and none is server-owned (id, programmeId,
 *       version, createdAt, updatedAt, withheldFields). `given_names` or
 *       `owner_user_id` (a column name) fails.
 *     - at least one variant carries `before` and `after`.
 *     - PII NEVER CARRIES A VALUE. No variant that has a value-like property
 *       (before, after, from, to, old*, new*, previous, value*) admits a
 *       `field` in { phones, emails, givenNames, familyName, displayName }
 *       (D-L54 email is a redacted change; D-L63 a person's name is PII and
 *       stays out of events). So a value-carrying variant and a redacted one
 *       are separate schemas; how the builder splits them is theirs.
 *     - `phones` and `emails` DO appear across the field enums: a change to
 *       them is shown, redacted (name only), not hidden.
 *
 *   consent_changed carries a property whose enum is exactly ConsentState's.
 *
 *   FIELD SECURITY. The operation's description says an item for a field
 *   withheld from the caller is OMITTED (value and name), says so for
 *   `consentState` (a consent_changed item IS a change to that field by
 *   another name), and says omission happens BEFORE PAGING. Filtering after
 *   the page is cut leaves a short page with a non-null `nextCursor`, which
 *   tells the caller that hidden changes exist.
 *     If the operation takes a `type` filter, its values are item types.
 *
 *   Errors: every 4xx/5xx resolves to the SAME Error schema node as
 *   getContact's 404. Documents 400, 401 and 404; the 404's only example
 *   code is `not_found`; never 403 (D-L69: P05/06's access-denied page is not
 *   drawn; out of scope is the generic not-found).
 *
 *   SCOPE (CLAUDE.md 2.2). On every operation this slice adds: no parameter
 *   named like programme, tenant, scope or business unit; no `x-kasuwa-*`
 *   header; no cookie; no `/programmes/` or `/tenants/` path segment; no
 *   `security: []` or `{}` override.
 *
 *   ACCOUNT SUMMARY — ON Contact, as `account`. The task's "related records:
 *   the account summary, withheld when accountId is withheld" is the T-0043
 *   `owner`/`ownerUserId` pattern, so this suite pins it the same way rather
 *   than a separate related-records operation:
 *     Contact.account: `{ id: uuid, name: string } | null`, one object
 *     branch, CLOSED, both required. Optional (a withheld field is omitted).
 *     Its description names `accountId` and says it is withheld with it.
 *     Neither CreateContactRequest nor UpdateContactRequest takes `account`
 *     (the name is the server's; a write sets `accountId`).
 *   Because listContacts rows are Contact, the list carries it too.
 *
 *   NOT BUILT (P05, D-L69). No property on Contact or on any timeline item is
 *   named like NIN/BVN (D-L13), recording/playback (ADR-0003), an AI summary
 *   or next-best-action (M17), an address, follow/following (P26), the
 *   WhatsApp window or last inbound message (M08), date of birth or identity
 *   verification. Any operation in the file whose id or path names WhatsApp,
 *   composer, conversation, message, window, summary, AI, recording,
 *   playback, NIN, identity, address or follow is `x-kasuwa-implemented:
 *   false`, documents 401 and 501 (`not_implemented` only), names a P05
 *   frame, and its description names the module it waits for (M08, M17,
 *   ADR-0003, D-L13, P26; addresses have none named).
 *
 * THE BUILDER'S CHOICE (not asserted): descriptions beyond the phrases named
 * above; the path parameter's name; whether `activity` is reserved now;
 * whether before/after are required (T-0041's contact audit records field
 * names, never values, so history has none); the value types; whether
 * `ownerUserId` or `owner` is the field name for an owner change; how the
 * redacted variant is marked (`redacted: true` or its absence of values); a
 * `type` filter; whether 501 stubs exist at all or the features are simply
 * absent.
 *
 * ---------------------------------------------------------------------------
 *
 * D-L23: on main the file has no timeline operation and Contact has no
 * `account`. Every test then fails naming the missing operationId or
 * property rather than crashing at collection: the spec is loaded lazily.
 * The negative invariants (no NIN, no scope parameter, stubs are 501) first
 * require listContactTimeline to exist, so none passes on a file without it.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const SPEC_REL = 'docs/api/records.openapi.yaml';
const SPEC_PATH = resolve(repoRoot, SPEC_REL);
const API_SRC = resolve(repoRoot, 'apps', 'api', 'src');

const TIMELINE = 'listContactTimeline';

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

/**
 * The P05 features no module has built yet, each with the module its 501
 * description must name (null: the task names none, so nothing is required).
 */
const UNBUILT: { label: string; match: RegExp; waitsFor: RegExp | null }[] = [
  {
    label: 'WhatsApp composer / 24-hour window',
    match: /whatsapp|composer|conversation|message|window/i,
    waitsFor: /\bM0?8\b/,
  },
  // Case-sensitive on purpose: under /i, `Ai[A-Z]` matches the "ail" of
  // "email" and `Nin` the "nin" of "opening".
  {
    label: 'AI summary',
    match: /[Ss]ummary|(^|[^A-Za-z])ai([^A-Za-z]|$)|^ai[A-Z]|[a-z]Ai[A-Z]|AI/,
    waitsFor: /\bM17\b/,
  },
  { label: 'recording playback', match: /recording|playback/i, waitsFor: /ADR-0003/ },
  {
    label: 'NIN last-4',
    match: /(^|[^A-Za-z])nin([^A-Za-z]|$)|^nin[A-Z]|Nin|NIN|[Ii]dentity/,
    waitsFor: /D-L13/,
  },
  { label: 'addresses', match: /address/i, waitsFor: null },
  { label: 'follow', match: /follow/i, waitsFor: /\bP26\b/ },
];

function unbuiltLabel(op: Operation): string | undefined {
  return UNBUILT.find((entry) => entry.match.test(op.id) || entry.match.test(op.path))?.label;
}

/**
 * Every operation this slice adds: the timeline, any other sub-resource of
 * one contact, and any P05 stub. Throws if the timeline is missing, so a
 * negative invariant iterated over this list cannot pass on main.
 */
function recordViewOperations(): Operation[] {
  operation(TIMELINE);
  return operations().filter(
    (op) =>
      op.id === TIMELINE ||
      /^\/api\/v1\/contacts\/\{[^}]+\}\/./.test(op.path) ||
      unbuiltLabel(op) !== undefined,
  );
}

function responses(op: Operation): Map<string, Located> {
  const raw = isMapping(op.op.responses) ? op.op.responses : {};
  return new Map(Object.entries(raw).map(([code, value]) => [code, at(value)]));
}

function jsonSchema(holder: Located | undefined): Located | undefined {
  if (!holder) return undefined;
  const content = child(holder, 'content');
  const media = content ? child(content, 'application/json') : undefined;
  return media ? child(media, 'schema') : undefined;
}

function requestSchema(id: string): Located | undefined {
  const op = operation(id);
  return jsonSchema(op.op.requestBody === undefined ? undefined : at(op.op.requestBody));
}

function exampleCodes(holder: Located): string[] {
  const content = child(holder, 'content');
  const media = content ? child(content, 'application/json') : undefined;
  if (!media || !isMapping(media.node)) return [];
  const values: unknown[] = [];
  if (media.node.example !== undefined) values.push(media.node.example);
  const examples = child(media, 'examples');
  if (examples && isMapping(examples.node)) {
    for (const key of Object.keys(examples.node)) {
      const example = child(examples, key);
      if (example && isMapping(example.node)) values.push(example.node.value);
    }
  }
  return values.filter(isMapping).map((value) => str(value.code));
}

function screensOf(op: Operation): string[] {
  const raw = op.op['x-kasuwa-screens'];
  return Array.isArray(raw) ? raw.map(str) : [];
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

function required(schema: Located): string[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  const own = Array.isArray(node.required) ? node.required.map(str) : [];
  const inherited = (Array.isArray(node.allOf) ? node.allOf : []).flatMap((part) =>
    required(at(part, schema.file)),
  );
  return [...own, ...inherited];
}

/** The JSON types a schema admits, `nullable: true` and `oneOf: [.., {type: null}]` included. */
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

/** The values a schema admits: `const`, `enum`, its `items`, or its non-null branches. */
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

function describedAs(...located: (Located | undefined)[]): string {
  return located
    .map((entry) => (entry && isMapping(entry.node) ? str(entry.node.description) : ''))
    .join('\n');
}

function param(op: Operation, name: string | RegExp, where = 'query'): Mapping | undefined {
  return op.params.find(
    (candidate) =>
      candidate.in === where &&
      (typeof name === 'string' ? candidate.name === name : name.test(str(candidate.name))),
  );
}

function paramSchema(parameter: Mapping): Located {
  return at(parameter.schema ?? {});
}

function responseSchema(id: string, status: string): Located {
  const schema = jsonSchema(responses(operation(id)).get(status));
  if (!schema) throw new Error(`${id} has no ${status} application/json schema`);
  return schema;
}

function contactSchema(): Located {
  return responseSchema('getContact', '200');
}

/** Every key at every depth of a schema, as dotted paths. Cycle-safe. */
function deepKeys(schema: Located, prefix = '', seen = new Set<unknown>()): string[] {
  if (seen.has(schema.node)) return [];
  seen.add(schema.node);
  const out: string[] = [];
  const node = schema.node;
  // The schema's own branches (a union at the root, as TimelineItem is).
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

/** The single object branch of a `{...} | null` property, or a failure naming why there is none. */
function objectBranch(value: Located, where: string): Located {
  const node = value.node;
  const variants = isMapping(node)
    ? [node.oneOf, node.anyOf].find((candidate): candidate is unknown[] => Array.isArray(candidate))
    : undefined;
  if (variants) {
    const objects = variants
      .map((variant) => at(variant, value.file))
      .filter((variant) => types(variant).includes('object'));
    if (objects.length !== 1) {
      throw new Error(`${where}: expected exactly one object branch, found ${objects.length}`);
    }
    const [only] = objects;
    if (!only) throw new Error(`${where}: no object branch`);
    return only;
  }
  return value;
}

/** Assert `{ <keys> } | null`, closed, all required; returns the object's properties. */
function expectClosedRefOrNull(
  value: Located,
  where: string,
  keys: readonly string[],
): Map<string, Located> {
  expect(types(value), `${where} admits null`).toContain('null');
  const object = objectBranch(value, where);
  const props = properties(object);
  expect([...props.keys()].sort(), `${where} properties`).toEqual([...keys].sort());
  expect(
    isMapping(object.node) ? object.node.additionalProperties : undefined,
    `${where} is not closed (additionalProperties: false)`,
  ).toBe(false);
  expect(required(object), `${where} required`).toEqual(expect.arrayContaining([...keys]));
  const id = props.get('id');
  expect(id ? formatOf(id) : '', `${where}.id format`).toBe('uuid');
  return props;
}

// ---------------------------------------------------------------------------
// The timeline union
// ---------------------------------------------------------------------------

function timelineItem(): Located {
  const page = responseSchema(TIMELINE, '200');
  const rows = properties(page).get('data');
  const item = rows ? child(rows, 'items') : undefined;
  if (!item) throw new Error(`${TIMELINE} 200 has no data[] items schema`);
  return item;
}

function unionBranches(): Located[] {
  const item = timelineItem();
  const node = item.node;
  const oneOf = isMapping(node) ? node.oneOf : undefined;
  if (!Array.isArray(oneOf) || oneOf.length === 0) {
    throw new Error(`${TIMELINE} data[] items are not a oneOf union`);
  }
  return oneOf.map((branch) => at(branch, item.file));
}

/** A flattened variant: the properties and required list of one leaf of nested oneOf/anyOf. */
interface Variant {
  where: string;
  props: Map<string, Located>;
  req: string[];
}

function variantsOf(schema: Located, where: string, base?: Variant): Variant[] {
  const own: Variant = {
    where,
    props: new Map([...(base?.props ?? new Map<string, Located>()), ...properties(schema)]),
    req: [...(base?.req ?? []), ...required(schema)],
  };
  const node = schema.node;
  const branches = isMapping(node)
    ? [node.oneOf, node.anyOf].find((candidate): candidate is unknown[] => Array.isArray(candidate))
    : undefined;
  if (!branches || branches.length === 0) return [own];
  return branches.flatMap((sub, index) =>
    variantsOf(at(sub, schema.file), `${where}/${index}`, own),
  );
}

/** The `type` values one union branch admits, across its flattened variants. */
function typeValues(branch: Located): string[] {
  const out = new Set<string>();
  for (const variant of variantsOf(branch, 'branch')) {
    const type = variant.props.get('type');
    if (type)
      enumOf(type)
        .map(str)
        .forEach((value) => out.add(value));
  }
  return [...out];
}

function branchesByType(): Map<string, Located> {
  const out = new Map<string, Located>();
  for (const branch of unionBranches()) {
    for (const value of typeValues(branch)) out.set(value, branch);
  }
  return out;
}

function branch(type: string): Located {
  const found = branchesByType().get(type);
  if (!found) throw new Error(`the timeline union has no ${type} branch`);
  return found;
}

/** Whether an apps/api/src controller declares a timeline route. */
function timelineRouteExists(): boolean {
  if (!existsSync(API_SRC)) return false;
  const stack = [API_SRC];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') stack.push(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) continue;
      const text = readFileSync(full, 'utf8');
      if (text.includes('@Controller(') && /['"`][^'"`\n]*\btimeline\b[^'"`\n]*['"`]/.test(text)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

const SCREEN_ID = /^P\d{2}\/[0-9A-Za-z]+$/;
const P05_FRAME = /^P05\/0[1-6]$/;

const ITEM_TYPES = ['field_changed', 'consent_changed', 'activity'] as const;
const SERVER_OWNED = ['id', 'programmeId', 'version', 'createdAt', 'updatedAt', 'withheldFields'];
/** Contact fields whose values never leave the audit trail (D-L54, D-L63). */
const PII_FIELDS = ['phones', 'emails', 'givenNames', 'familyName', 'displayName'] as const;
const BASE_KEYS = new Set(['id', 'type', 'occurredAt', 'actor', 'field', 'redacted']);
const VALUE_KEY = /before|after|^from$|^to$|^old|^new|previous|value/i;

/** Keys that would mean an unbuilt P05 feature has been built (D-L69, D-L13, ADR-0003). */
const NOT_BUILT_CASED = /^(nin|bvn)|Nin|Bvn|NIN|BVN/;
const NOT_BUILT =
  /recording|playback|summary|nextBestAction|address|follow|whatsappWindow|window(Ends|Expires|Open)|lastInbound|lastWhatsapp|dateOfBirth|^dob$|identityVerif|verified/i;

describe('acceptance: records contract, the 360° record view (T-0059)', () => {
  describe('listContactTimeline', () => {
    it('is GET /api/v1/contacts/{id}/timeline and names P05/01', () => {
      const op = operation(TIMELINE);
      expect(op.method, 'method').toBe('get');
      expect(op.path, 'path').toMatch(/^\/api\/v1\/contacts\/\{[A-Za-z]+\}\/timeline$/);
      expect(typeof op.op['x-kasuwa-implemented'], 'x-kasuwa-implemented').toBe('boolean');
      const screens = screensOf(op);
      expect(screens.length, 'x-kasuwa-screens missing or empty').toBeGreaterThan(0);
      expect(
        screens.filter((screen) => !SCREEN_ID.test(screen)),
        'bad screen ids',
      ).toEqual([]);
      expect(screens, 'the timeline is the centre column of P05/01').toContain('P05/01');
    });

    it('the contact id in the path is one required uuid, the one the path names', () => {
      const op = operation(TIMELINE);
      const pathParams = op.params.filter((parameter) => parameter.in === 'path');
      expect(pathParams.length, 'path parameters').toBe(1);
      const [only] = pathParams;
      expect(op.path, 'the path parameter is not the one in the path').toContain(
        `{${str(only?.name)}}`,
      );
      expect(only?.required, 'path parameter not required').toBe(true);
      expect(only ? formatOf(paramSchema(only)) : '', 'id is not format uuid').toBe('uuid');
    });

    it('does not claim x-kasuwa-implemented: true without a timeline route', () => {
      const op = operation(TIMELINE);
      if (op.op['x-kasuwa-implemented'] === true) {
        expect(
          timelineRouteExists(),
          `${TIMELINE} marked implemented, but no @Controller under apps/api/src routes timeline`,
        ).toBe(true);
      }
      // Legitimately vacuous while the operation says false (the task's state
      // until the API task). operation() above still fails on main.
    });

    it('an opaque cursor and a limit of at most 100; no offset or page', () => {
      const op = operation(TIMELINE);
      const cursor = param(op, 'cursor');
      expect(cursor, 'no cursor query parameter').toBeDefined();
      if (cursor) {
        expect(types(paramSchema(cursor)), 'cursor type').toContain('string');
        expect(
          `${str(cursor.description)}\n${describedAs(paramSchema(cursor))}`,
          'cursor is not documented as opaque',
        ).toMatch(/opaque/i);
      }
      const limit = param(op, 'limit');
      expect(limit, 'no limit query parameter').toBeDefined();
      if (limit) {
        const schema = paramSchema(limit);
        expect(types(schema), 'limit type').toContain('integer');
        const node = isMapping(schema.node) ? schema.node : {};
        expect(typeof node.minimum === 'number' && node.minimum >= 1, 'limit minimum >= 1').toBe(
          true,
        );
        expect(typeof node.maximum, 'limit has no maximum').toBe('number');
        expect(Number(node.maximum), 'limit maximum').toBeLessThanOrEqual(100);
      }
      expect(
        op.params
          .map((parameter) => str(parameter.name))
          .filter((name) => /^(offset|skip|page|pageNumber|pageNo|pageIndex|start)$/i.test(name)),
        'offset paging',
      ).toEqual([]);
    });

    it('the 200 is { data, nextCursor } with no total, count or withheld marker', () => {
      const page = responseSchema(TIMELINE, '200');
      const props = properties(page);
      expect(required(page), 'page required').toEqual(
        expect.arrayContaining(['data', 'nextCursor']),
      );
      const rows = props.get('data');
      expect(rows ? types(rows) : [], 'data type').toContain('array');
      const cursor = props.get('nextCursor');
      expect(cursor ? types(cursor) : [], 'nextCursor type').toEqual(
        expect.arrayContaining(['string', 'null']),
      );
      // A count of omitted items, or a "some items hidden" flag, tells the
      // caller that changes to a field they cannot read exist.
      expect(
        [...props.keys()].filter((key) =>
          /total|count|offset|^page$|omit|hidden|withheld|redact/i.test(key),
        ),
        'the page reports a total, a count, an offset or a withheld marker',
      ).toEqual([]);
    });

    it('documents newest first, a tie-break, and omission before paging', () => {
      const text = str(operation(TIMELINE).op.description);
      expect(text, 'the description does not say newest first').toMatch(/newest/i);
      // One PATCH of three fields is three items at one instant.
      expect(text, 'the description names no tie-break for items at the same instant').toMatch(
        /\bties?\b|tie-break/i,
      );
      expect(
        text,
        'the description does not say withheld items are dropped before the page is cut',
      ).toMatch(/before\s+(the\s+)?pag/i);
    });

    it('an item for a field withheld from the caller is omitted, consent included', () => {
      const text = `${str(operation(TIMELINE).op.description)}\n${describedAs(timelineItem())}`;
      expect(text, 'nothing says a withheld field is omitted').toMatch(/omit/i);
      expect(text, 'nothing names field security / withheld fields').toMatch(/withh?eld/i);
      expect(
        str(operation(TIMELINE).op.description),
        'the description does not tie consent_changed items to consentState field security',
      ).toMatch(/consentState/);
    });

    it('a type filter, if taken, accepts only item types', () => {
      const filter = param(operation(TIMELINE), /^types?$/);
      const known = [...branchesByType().keys()];
      if (filter) {
        const values = enumOf(paramSchema(filter)).map(str);
        expect(values.length, 'the type filter has no enum').toBeGreaterThan(0);
        expect(
          values.filter((value) => !known.includes(value)),
          'type filter values that are not item types',
        ).toEqual([]);
      }
      // Legitimately vacuous without a type filter; branchesByType() above
      // still fails on main.
    });
  });

  describe('the timeline item union', () => {
    it('is a oneOf discriminated on type, one snake_case value per branch', () => {
      const item = timelineItem();
      const node = isMapping(item.node) ? item.node : {};
      const discriminator = isMapping(node.discriminator) ? node.discriminator : {};
      expect(discriminator.propertyName, 'discriminator.propertyName').toBe('type');
      const problems: string[] = [];
      unionBranches().forEach((candidate, index) => {
        const values = typeValues(candidate);
        if (values.length !== 1)
          problems.push(`branch ${index}: type admits ${JSON.stringify(values)}`);
        for (const value of values) {
          if (!/^[a-z][a-z0-9_]*$/.test(value)) problems.push(`branch ${index}: type ${value}`);
        }
      });
      expect(problems).toEqual([]);
      if (isMapping(discriminator.mapping)) {
        for (const [key, ref] of Object.entries(discriminator.mapping)) {
          expect(typeValues(at({ $ref: str(ref) }, item.file)), `mapping ${key}`).toEqual([key]);
        }
      }
    });

    it('has field_changed and consent_changed, and nothing outside { field_changed, consent_changed, activity }', () => {
      const found = [...branchesByType().keys()];
      expect(found).toEqual(expect.arrayContaining(['field_changed', 'consent_changed']));
      // A call, WhatsApp, payment or ticket item would be an unbuilt module.
      expect(
        found.filter((type) => !(ITEM_TYPES as readonly string[]).includes(type)),
        'item types outside the reserved set',
      ).toEqual([]);
    });

    it('every item requires an id, its type, occurredAt (date-time) and actor', () => {
      const problems: string[] = [];
      for (const [type, candidate] of branchesByType()) {
        for (const variant of variantsOf(candidate, type)) {
          for (const key of ['id', 'type', 'occurredAt', 'actor']) {
            if (!variant.req.includes(key)) problems.push(`${variant.where}: ${key} not required`);
          }
          const id = variant.props.get('id');
          if (!id || !types(id).includes('string'))
            problems.push(`${variant.where}: id not a string`);
          const occurred = variant.props.get('occurredAt');
          if (!occurred || formatOf(occurred) !== 'date-time') {
            problems.push(`${variant.where}: occurredAt not date-time`);
          }
        }
      }
      expect(problems).toEqual([]);
    });

    it('actor is { id: uuid, displayName } | null, closed, on every item', () => {
      let checked = 0;
      for (const [type, candidate] of branchesByType()) {
        for (const variant of variantsOf(candidate, type)) {
          const actor = variant.props.get('actor');
          expect(actor, `${variant.where} has no actor`).toBeDefined();
          if (!actor) continue;
          checked += 1;
          const props = expectClosedRefOrNull(actor, `${variant.where}.actor`, [
            'id',
            'displayName',
          ]);
          const name = props.get('displayName');
          expect(name ? types(name) : [], `${variant.where}.actor.displayName`).toContain('string');
        }
      }
      expect(checked, 'no actor inspected').toBeGreaterThanOrEqual(2);
    });

    it('field_changed names the field by a Contact wire name, never a server-owned one', () => {
      const contact = new Set(properties(contactSchema()).keys());
      const problems: string[] = [];
      const named = new Set<string>();
      for (const variant of variantsOf(branch('field_changed'), 'field_changed')) {
        if (!variant.req.includes('field')) problems.push(`${variant.where}: field not required`);
        const field = variant.props.get('field');
        const values = field ? enumOf(field).map(str) : [];
        if (values.length === 0) problems.push(`${variant.where}: field is not an enum`);
        for (const value of values) {
          named.add(value);
          if (!contact.has(value))
            problems.push(`${variant.where}: ${value} is not a Contact property`);
          if (SERVER_OWNED.includes(value))
            problems.push(`${variant.where}: ${value} is server-owned`);
        }
      }
      expect(problems).toEqual([]);
      // A change to phones or emails is shown, redacted; it is not hidden.
      expect([...named], 'phones and emails changes are not on the timeline').toEqual(
        expect.arrayContaining(['phones', 'emails']),
      );
    });

    it('field_changed carries before/after, and never for phones, emails or a name', () => {
      const variants = variantsOf(branch('field_changed'), 'field_changed');
      const carrying = variants.filter((variant) =>
        [...variant.props.keys()].some((key) => !BASE_KEYS.has(key) && VALUE_KEY.test(key)),
      );
      expect(
        carrying.some((variant) => variant.props.has('before') && variant.props.has('after')),
        'no field_changed variant carries before and after',
      ).toBe(true);
      const leaks: string[] = [];
      for (const variant of carrying) {
        const field = variant.props.get('field');
        const values = field ? enumOf(field).map(str) : [];
        if (values.length === 0) leaks.push(`${variant.where}: carries values for any field`);
        for (const value of values) {
          if ((PII_FIELDS as readonly string[]).includes(value)) {
            leaks.push(`${variant.where}: carries values for ${value}`);
          }
        }
      }
      expect(leaks, 'a value-carrying variant admits a PII field').toEqual([]);
    });

    it('consent_changed carries a ConsentState value', () => {
      const consent = enumOf(at({ $ref: '#/components/schemas/ConsentState' }))
        .map(str)
        .sort();
      expect(consent.length, 'ConsentState has no enum').toBeGreaterThan(0);
      const variants = variantsOf(branch('consent_changed'), 'consent_changed');
      for (const variant of variants) {
        const carries = [...variant.props.entries()].some(
          ([key, value]) =>
            key !== 'type' && enumOf(value).map(str).sort().join() === consent.join(),
        );
        expect(carries, `${variant.where} carries no ConsentState-valued property`).toBe(true);
      }
    });

    it('no item and no page carries a withheld marker, NIN, recording or AI summary', () => {
      const offending: string[] = [];
      const page = responseSchema(TIMELINE, '200');
      for (const path of deepKeys(page)) {
        const leaf = (path.split('.').pop() ?? path).replace(/\[\]$/, '');
        if (NOT_BUILT_CASED.test(leaf) || NOT_BUILT.test(leaf)) offending.push(path);
        if (/withheld|hidden/i.test(leaf)) offending.push(path);
      }
      expect(offending).toEqual([]);
      // Not vacuous: responseSchema() fails on a file with no timeline.
    });
  });

  describe('errors and scope', () => {
    it('every error on the new operations uses the same Error schema as getContact', () => {
      const shared = jsonSchema(responses(operation('getContact')).get('404'));
      if (!shared) throw new Error('getContact 404 has no schema to compare against');
      const strays: string[] = [];
      let count = 0;
      for (const op of recordViewOperations()) {
        for (const [code, response] of responses(op)) {
          if (!/^[45]\d\d$/.test(code) && code !== 'default') continue;
          count += 1;
          const schema = jsonSchema(response);
          if (!schema) strays.push(`${op.id} ${code}: no application/json schema`);
          else if (schema.node !== shared.node) strays.push(`${op.id} ${code}: a different schema`);
        }
      }
      expect(strays).toEqual([]);
      expect(count, 'the timeline documents at least 400, 401 and 404').toBeGreaterThanOrEqual(3);
    });

    it('the timeline documents 400, 401 and 404 not_found, and never 403', () => {
      const codes = [...responses(operation(TIMELINE)).keys()];
      expect(codes).toEqual(expect.arrayContaining(['400', '401', '404']));
      for (const op of recordViewOperations()) {
        if (op.method === 'get') {
          expect(
            responses(op).has('403'),
            `${op.id} documents 403: out of scope is the generic 404 (D-L69)`,
          ).toBe(false);
        }
        const notFound = responses(op).get('404');
        if (notFound) {
          expect(
            exampleCodes(notFound).filter((code) => code !== 'not_found'),
            `${op.id} 404 examples`,
          ).toEqual([]);
        }
      }
    });

    it('no new operation takes a programme, tenant or scope argument', () => {
      const SCOPE_NAME = /programme|tenant|scope|business[-_]?unit|^bu$/i;
      const offending: string[] = [];
      let checked = 0;
      for (const op of recordViewOperations()) {
        if (/\/(programmes|tenants|business-units)\//i.test(op.path)) {
          offending.push(`${op.id}: path ${op.path}`);
        }
        for (const parameter of op.params) {
          checked += 1;
          const name = str(parameter.name);
          const where = str(parameter.in);
          if (SCOPE_NAME.test(name)) offending.push(`${op.id}: ${where} ${name}`);
          if (where === 'header' && /^x-kasuwa-/i.test(name))
            offending.push(`${op.id}: header ${name}`);
          if (where === 'cookie') offending.push(`${op.id}: cookie ${name} (auth is bearer only)`);
        }
      }
      expect(offending).toEqual([]);
      // The timeline alone has a path id, cursor and limit.
      expect(checked, 'no parameters inspected').toBeGreaterThanOrEqual(3);
    });

    it('every new operation is authenticated and names a P05 frame', () => {
      const doc = spec();
      expect(Array.isArray(doc.security) && doc.security.length > 0, 'no global security').toBe(
        true,
      );
      const problems: string[] = [];
      for (const op of recordViewOperations()) {
        if (typeof op.op['x-kasuwa-implemented'] !== 'boolean') {
          problems.push(`${op.id}: x-kasuwa-implemented is not a boolean`);
        }
        const screens = screensOf(op);
        if (!screens.some((screen) => P05_FRAME.test(screen))) {
          problems.push(`${op.id}: names no P05 frame (${JSON.stringify(screens)})`);
        }
        if (op.op.security === undefined) continue;
        const list = Array.isArray(op.op.security) ? op.op.security : [];
        if (list.length === 0) problems.push(`${op.id}: security: []`);
        for (const requirement of list) {
          if (!isMapping(requirement) || Object.keys(requirement).length === 0) {
            problems.push(`${op.id}: {} is a security option (authentication optional)`);
          }
        }
      }
      expect(problems).toEqual([]);
    });
  });

  describe("the contact's account summary", () => {
    it('Contact.account is { id: uuid, name } | null, closed', () => {
      const account = properties(contactSchema()).get('account');
      expect(account, 'Contact has no account').toBeDefined();
      if (!account) return;
      const props = expectClosedRefOrNull(account, 'Contact.account', ['id', 'name']);
      const name = props.get('name');
      expect(name ? types(name) : [], 'Contact.account.name').toContain('string');
    });

    it('is optional and withheld together with accountId', () => {
      const contact = contactSchema();
      const account = properties(contact).get('account');
      expect(account, 'Contact has no account').toBeDefined();
      expect(required(contact), 'account is required, so it cannot be withheld').not.toContain(
        'account',
      );
      const text = describedAs(account);
      expect(text, 'Contact.account does not name accountId').toMatch(/accountId/);
      expect(text, 'Contact.account does not say it is withheld with accountId').toMatch(
        /withh?eld|omit/i,
      );
    });

    it('neither write body takes the embedded account', () => {
      for (const id of ['createContact', 'updateContact']) {
        const body = requestSchema(id);
        expect(body, `${id} has no JSON body`).toBeDefined();
        if (!body) continue;
        expect([...properties(body).keys()], `${id} accepts account`).not.toContain('account');
      }
      // Gate: without Contact.account this negative check holds before the work starts.
      expect(properties(contactSchema()).has('account'), 'Contact has no account').toBe(true);
    });
  });

  describe('P05 features no module has built', () => {
    it('Contact carries no NIN, BVN, recording, AI summary, address, follow or WhatsApp-window property', () => {
      operation(TIMELINE); // Gate: this holds on main, before the work starts.
      const offending = deepKeys(contactSchema()).filter((path) => {
        const leaf = (path.split('.').pop() ?? path).replace(/\[\]$/, '');
        return NOT_BUILT_CASED.test(leaf) || NOT_BUILT.test(leaf);
      });
      expect(offending).toEqual([]);
    });

    it('any operation for an unbuilt P05 feature is a 501 stub naming the module it waits for', () => {
      operation(TIMELINE); // Gate: with no stubs this holds on main.
      const problems: string[] = [];
      for (const op of operations()) {
        const label = unbuiltLabel(op);
        if (label === undefined) continue;
        const entry = UNBUILT.find((candidate) => candidate.label === label);
        if (op.op['x-kasuwa-implemented'] !== false)
          problems.push(`${op.id}: not implemented: false`);
        const codes = [...responses(op).keys()];
        if (!codes.includes('501')) problems.push(`${op.id}: documents no 501`);
        if (!codes.includes('401')) problems.push(`${op.id}: documents no 401`);
        const notImplemented = responses(op).get('501');
        if (notImplemented) {
          const stray = exampleCodes(notImplemented).filter((code) => code !== 'not_implemented');
          if (stray.length > 0) problems.push(`${op.id}: 501 examples ${JSON.stringify(stray)}`);
        }
        if (!screensOf(op).some((screen) => P05_FRAME.test(screen))) {
          problems.push(`${op.id}: names no P05 frame`);
        }
        if (entry?.waitsFor && !entry.waitsFor.test(str(op.op.description))) {
          problems.push(`${op.id} (${label}): description does not name ${String(entry.waitsFor)}`);
        }
      }
      expect(problems).toEqual([]);
      // Legitimately vacuous when the contract leaves every one of them out
      // (the task allows "501 or left out").
    });
  });
});
