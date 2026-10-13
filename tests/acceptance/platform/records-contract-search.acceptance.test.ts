import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * ACCEPTANCE — T-0085, the records API contract for GLOBAL SEARCH (P27;
 * ADR-0014, ADR-0015, D-L128, D-P13, D-L87, D-L80, D-L68, D-L97, D-L115,
 * D-L127). Agent 3 serves it (T-0086) and Agent 11 draws it (T-0087).
 * Contract only: no route, no migration, no code. Written by QA for the lead
 * from the invariants (D-L23, D-L25), before the build.
 *
 * The artefact under test is `docs/api/records.openapi.yaml`, read as data
 * (parsed YAML, never a regex over the raw text, so a keyword in a YAML
 * comment satisfies nothing). The T-0039 suite keeps the whole-file rules
 * (every `$ref` resolves, unique operationIds, one Error schema, every
 * operation documents 401); this suite does not repeat them.
 *
 * ---------------------------------------------------------------------------
 * PINNED INTERFACES
 * ---------------------------------------------------------------------------
 *
 *   searchRecords   GET /api/v1/search?q=…|phone=…|email=…[&types=…]
 *
 *   PARAMETERS  exactly `q` (2..100), `phone` (6..32, digits and + ( ) . -
 *               and space), `email` (format email, 3..254) and `types`
 *               (array of SearchType, 1..4, unique). Nothing else: no limit,
 *               cursor, sort, offset, programme, tenant, scope, owner or date.
 *   200         `SearchResults { groups }`, closed. A group is
 *               `{ type, hits }`, closed, one per requested type, in the order
 *               contact, lead, account, deal, `hits` at most 3. No count of
 *               any kind.
 *   HITS        closed, each `{ type, id, programmeId, … }`:
 *                 ContactSearchHit  displayName?, givenNames?, familyName?,
 *                                   companyName?, withheldFields
 *                 LeadSearchHit     the same plus status (a lead status)
 *                 AccountSearchHit  name
 *                 DealSearchHit     pipelineId, name (pii)
 *   EXTENSIONS  `x-kasuwa-search-fields` (per type, the prefix-matched
 *               fields), `x-kasuwa-exact-fields` (per exact parameter, per
 *               type, the field compared), `x-kasuwa-rights` (per seeded set,
 *               per type, read or none), `x-kasuwa-error-order`.
 *   ERRORS      `400` (SearchValidationFailed: one_term_required,
 *               query_too_short, invalid_string, invalid_phone,
 *               invalid_email, unknown_type) and `401`. No 403, no 404.
 *   TRANSPORT   `Cache-Control: no-store` on 200, 400 and 401.
 *   FLAG        `x-kasuwa-implemented: false` until T-0086; the flag test
 *               below requires `true` and so FAILS ON THIS BRANCH BY DESIGN.
 *
 * ---------------------------------------------------------------------------
 * RULINGS (the lead accepts or reverses each; R-numbers are this suite's, not
 * decision ids)
 * ---------------------------------------------------------------------------
 *
 *   R1  One read, `GET /api/v1/search`, `searchRecords`, tag `search`. Its
 *       screens are exactly the P27 frames it serves: A1 (grouped results),
 *       A2 (phone), A4 (searching), A5 (no results) and D1 (records in the
 *       palette). Not A (recent searches: nothing is stored), A3 (filters
 *       with live counts), B and B1 (programme scope and the hidden count),
 *       C and C1 (facets with counts), D, D2, D3 (commands, switching, AI).
 *   R2  Exactly one term per request: `q`, `phone` or `email`. None or more
 *       than one is `400 one_term_required` at `q`.
 *   R3  Prefix, not substring (D-L128). Folding: Unicode NFD, combining marks
 *       removed, locale-independent default lower-casing, trimmed, inner
 *       whitespace runs made one space; comparison by code point. The prefix
 *       is of the WHOLE field value, not of each word. `%`, `_` and `\` are
 *       literal. `q` never matches a phone or an email. Trigram and word
 *       matching are a later ADDITIVE change: every prefix hit stays a hit.
 *   R4  `q` is 2..100 as sent and at least 2 once folded and trimmed
 *       (`query_too_short`); a NUL or control character is `invalid_string`.
 *       2, not 3: a prefix index serves two characters, and when trigram
 *       arrives a short query keeps prefix matching (additive), whereas
 *       raising the minimum later would break clients.
 *   R5  Exact lookups are two parameters, `phone` and `email`, each a WHOLE
 *       value compared for equality (phone normalised to E.164 with the
 *       tenant's default country; email trimmed, case-insensitive). A
 *       partial number is `400 invalid_phone`, never a prefix match: P27/A2's
 *       "0803 456 finds +234 803 456…" is overruled. They search contacts and
 *       leads only; the account and deal groups are answered empty.
 *   R6  The matched fields are data, in `x-kasuwa-search-fields`: contact and
 *       lead `displayName`, `givenNames`, `familyName`, `companyName`;
 *       account `name`; deal `name`. Each is a property of that type's record
 *       schema, and the account and deal ones are never withheld.
 *   R7  Field security, per hit's own programme, row by row, tenant-admin
 *       flag never lifting it: a withheld field is never compared, never
 *       decides the choice or order of hits, is omitted and is named in
 *       `withheldFields`. An exact lookup on a withheld number or address
 *       answers as for a number nobody has. Search NEVER answers `400
 *       field_withheld`: a withheld field just does not match.
 *   R8  D-L68, SETTLED FOR SEARCH: in a hit, `displayName` is readable
 *       exactly when BOTH `givenNames` and `familyName` are readable in the
 *       record's programme. Otherwise it is withheld: not matched, omitted,
 *       listed in `withheldFields` with the withheld part. It is never
 *       composed from, or replaced by, the readable part, and the rule holds
 *       when the withheld part is `null` on that record (withholding is not a
 *       statement about a value). getContact, listContacts and listLeads are
 *       NOT changed here; their alignment is the D-L68 follow-up, and until
 *       then listContacts' `q` still matches `displayName` (reported).
 *   R9  Readers per type are that type's own readers (`x-kasuwa-rights`):
 *       contacts, leads and accounts every seeded set, the portal included;
 *       deals the five staff sets and the tenant-admin flag (D-L127), never
 *       `client_portal` (D-L115), never a custom set until a "read deals"
 *       grant exists. A type the caller does not read is an empty group,
 *       never an error.
 *   R10 The lead group follows listLeads: when `status` is withheld from the
 *       caller in ANY programme they reach, the lead group is empty. A lead
 *       hit carries its `status`, a lead status only. A lead may appear in
 *       both the contact and the lead group, with the contact id in both.
 *   R11 Scope is the session's. No programme parameter (D-L87's narrowing is
 *       later and additive, and must intersect). Nothing out of scope is
 *       counted, shown or hinted: P27/B's "3 in programmes you're not on" is
 *       not served.
 *   R12 No counts (D-P13): no total, per-type or per-programme count, "more"
 *       flag or estimate, at any depth of the answer. "See all" is always
 *       offered where a list exists.
 *   R13 Which three hits, and their order, are NOT pinned, except: the same
 *       data and query give the same answer, neither depends on a withheld
 *       field, and a record appears at most once per group.
 *   R14 Hits are closed and minimal. Contact and lead hits never carry a
 *       phone or an email, an exact lookup included; no owner, tag or amount
 *       anywhere. Each returned field has the record schema's own type and
 *       bound. Deal hit `name` is `pii` (D-L91).
 *   R15 Errors: `400` and `401` only. Every `400` is decided from the request
 *       alone, before any record is read. Order: 401 and the scope header,
 *       then `one_term_required`, then each parameter's shape, then
 *       `query_too_short`. `x-kasuwa-error-order: ['400 validation_failed']`.
 *       The shared Error schema; details carry a path and a code only.
 *   R16 `Cache-Control: no-store` on every answer. The query string is
 *       personal data: telemetry keeps the route template only and ingress
 *       strips query strings from access logs (D-L80). GET is kept as the
 *       task file names it; whether exact lookups should move to a body is
 *       an open question in the report.
 *   R17 `types` is closed today (contact, lead, account, deal; unknown is
 *       `400 unknown_type`, a repeat is `400`) and additive tomorrow (D-L87):
 *       a client ignores a group type it does not know.
 *   R18 "See all" is the type's own list with `q` (listContacts, listLeads,
 *       listAccounts). Deals have no cross-pipeline list, so no "see all"
 *       for deals. A list's `q` is substring and matches numbers, so it may
 *       show more.
 *   R19 Examples use synthetic names only: every name-like value in the
 *       search examples contains Sample, Fixture, Example or Test.
 *   R20 Contract first: `x-kasuwa-implemented: false` on this branch; the
 *       flag test requires `true` and is the one test meant to fail here.
 *
 * ---------------------------------------------------------------------------
 *
 * D-L23: on main the file has no search operation. Every test then fails
 * naming the missing operation or schema rather than crashing at collection:
 * the spec is loaded lazily. Each negative invariant, and each self-check of a
 * helper, first requires the operation (`gate()`), so none passes on a file
 * without it.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const SPEC_REL = 'docs/api/records.openapi.yaml';
const SPEC_PATH = resolve(repoRoot, SPEC_REL);

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

const OP_ID = 'searchRecords';
const SEARCH_PATH = '/api/v1/search';

/** The search operation, or a failure naming it: a gate for negative invariants. */
function gate(): Operation {
  return operation(OP_ID);
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

function responseSchema(status: string): Located {
  const schema = jsonSchema(responses(gate()).get(status));
  if (!schema) throw new Error(`${OP_ID} has no ${status} application/json schema`);
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

/** The text with every run of whitespace collapsed, so a phrase may wrap. */
function prose(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function description(): string {
  return prose(str(gate().op.description));
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

function schemaDescription(name: string): string {
  const node = schemaNamed(name).node;
  return isMapping(node) ? prose(str(node.description)) : '';
}

function keysOf(schema: Located): string[] {
  return [...properties(schema).keys()].sort();
}

function required(schema: Located): string[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  return Array.isArray(node.required) ? node.required.map(str) : [];
}

function types(schema: Located): string[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  const out = new Set<string>();
  if (typeof node.type === 'string') out.add(node.type);
  if (Array.isArray(node.type)) node.type.map(str).forEach((type) => out.add(type));
  for (const key of ['oneOf', 'anyOf']) {
    const variants = node[key];
    if (Array.isArray(variants)) {
      variants.forEach((variant) => types(at(variant, schema.file)).forEach((t) => out.add(t)));
    }
  }
  return [...out].sort();
}

function enumOf(schema: Located): unknown[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  if (node.const !== undefined && node.const !== null) return [node.const];
  if (Array.isArray(node.enum)) return node.enum.filter((value) => value !== null);
  const items = child(schema, 'items');
  if (items) return enumOf(items);
  for (const key of ['oneOf', 'anyOf']) {
    const variants = node[key];
    if (Array.isArray(variants)) {
      const found = variants.flatMap((variant) => enumOf(at(variant, schema.file)));
      if (found.length > 0) return found;
    }
  }
  return [];
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
  for (const combinator of ['oneOf', 'anyOf', 'allOf']) {
    const variants = isMapping(node) ? node[combinator] : undefined;
    if (Array.isArray(variants)) {
      for (const variant of variants) out.push(...deepKeys(at(variant, schema.file), prefix, seen));
    }
  }
  const items = child(schema, 'items');
  if (items) out.push(...deepKeys(items, `${prefix}[]`, seen));
  for (const [key, value] of properties(schema)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    out.push(path);
    out.push(...deepKeys(value, path, seen));
  }
  return out;
}

function param(name: string): Mapping | undefined {
  return gate().params.find((candidate) => candidate.name === name);
}

function paramSchema(name: string): Located {
  const parameter = param(name);
  if (!parameter) throw new Error(`${OP_ID} has no parameter ${name}`);
  return at(parameter.schema ?? {});
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
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    Number(y) >= 1 &&
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

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
    if (node.format === 'email' && !EMAIL.test(value)) problems.push(`${path}: not an email`);
    if (node.format === 'date-time') {
      if (!UTC_DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) {
        problems.push(`${path}: not a UTC date-time with a Z`);
      }
    }
    if (node.format === 'date' && !isCalendarDate(value)) {
      problems.push(`${path}: not a calendar date YYYY-MM-DD`);
    }
  }
  if (typeof value === 'number') {
    if (typeof node.minimum === 'number' && value < node.minimum) problems.push(`${path}: < min`);
    if (typeof node.maximum === 'number' && value > node.maximum) problems.push(`${path}: > max`);
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === 'number' && value.length < node.minItems)
      problems.push(`${path}: too few items`);
    if (typeof node.maxItems === 'number' && value.length > node.maxItems)
      problems.push(`${path}: too many items`);
    if (node.uniqueItems === true) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) problems.push(`${path}: items are not unique`);
    }
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
// The folding and prefix rule (R3), as the contract states it. The examples
// are checked against it, so a contract example that only "looks" like a
// prefix hit is caught.
// ---------------------------------------------------------------------------

/** NFD, combining marks removed, default lower-casing, trimmed, inner whitespace one space. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Whole-field prefix on folded text, by code point. */
function prefixMatches(value: unknown, query: string): boolean {
  return typeof value === 'string' && fold(value).startsWith(fold(query));
}

// ---------------------------------------------------------------------------
// Fixed expectations
// ---------------------------------------------------------------------------

const TYPE_ORDER = ['contact', 'lead', 'account', 'deal'];
const SETS = ['admin', 'programme_manager', 'team_lead', 'agent', 'qa_analyst', 'client_portal'];
const STAFF_RIGHTS = { contact: 'read', lead: 'read', account: 'read', deal: 'read' };
const RIGHTS: Record<string, Record<string, string>> = {
  ...Object.fromEntries(SETS.map((set) => [set, STAFF_RIGHTS])),
  client_portal: { contact: 'read', lead: 'read', account: 'read', deal: 'none' },
};
const NAME_FIELDS = ['displayName', 'givenNames', 'familyName', 'companyName'];
const SEARCH_FIELDS: Record<string, string[]> = {
  contact: NAME_FIELDS,
  lead: NAME_FIELDS,
  account: ['name'],
  deal: ['name'],
};
const EXACT_FIELDS = {
  phone: { contact: 'phones', lead: 'phones' },
  email: { contact: 'emails', lead: 'emails' },
};
const RECORD_SCHEMA: Record<string, string> = {
  contact: 'Contact',
  lead: 'Contact',
  account: 'Account',
  deal: 'Deal',
};
const HIT_SCHEMA: Record<string, string> = {
  contact: 'ContactSearchHit',
  lead: 'LeadSearchHit',
  account: 'AccountSearchHit',
  deal: 'DealSearchHit',
};
const GROUP_SCHEMA: Record<string, string> = {
  contact: 'ContactSearchGroup',
  lead: 'LeadSearchGroup',
  account: 'AccountSearchGroup',
  deal: 'DealSearchGroup',
};
const HIT_KEYS: Record<string, string[]> = {
  contact: ['type', 'id', 'programmeId', ...NAME_FIELDS, 'withheldFields'],
  lead: ['type', 'id', 'programmeId', ...NAME_FIELDS, 'status', 'withheldFields'],
  account: ['type', 'id', 'programmeId', 'name'],
  deal: ['type', 'id', 'programmeId', 'pipelineId', 'name'],
};
const HIT_REQUIRED: Record<string, string[]> = {
  contact: ['type', 'id', 'programmeId', 'withheldFields'],
  lead: ['type', 'id', 'programmeId', 'status', 'withheldFields'],
  account: ['type', 'id', 'programmeId', 'name'],
  deal: ['type', 'id', 'programmeId', 'pipelineId', 'name'],
};
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified'];
const SCREENS = ['P27/A1', 'P27/A2', 'P27/A4', 'P27/A5', 'P27/D1'];
const PARAMS = ['email', 'phone', 'q', 'types'];
const BAD_REQUEST_DETAILS = [
  'email invalid_email',
  'phone invalid_phone',
  'q invalid_string',
  'q one_term_required',
  'q query_too_short',
  'types unknown_type',
];
const EXAMPLE_LABELS = ['portal', 'phoneLookup', 'prefix', 'withheldNamePart'];
/** Keys that would be a count, a page or a hint of more, at any depth of the answer (R12). */
const COUNT_KEY = /count|total|more|estimate|hidden|cursor|page|offset|limit|next|facet/i;
/** Keys a hit must never carry (R14). */
const FORBIDDEN_HIT_KEY =
  /phone|email|owner|amount|stage|tag|dnd|consent|nin|bvn|score|rank|highlight|snippet/i;
/** R19: a synthetic name carries one of these tokens once folded. */
const SYNTHETIC = /sample|fixture|example|test/;
const NAME_LIKE = new Set([...NAME_FIELDS, 'name']);

// ---------------------------------------------------------------------------
// Example readers
// ---------------------------------------------------------------------------

function okExamples(): [string, Mapping][] {
  return examplesOf(jsonMedia(responses(gate()).get('200'))).filter(
    (entry): entry is [string, Mapping] => isMapping(entry[1]),
  );
}

function okExample(label: string): Mapping {
  const found = okExamples().find(([name]) => name === label);
  if (!found) throw new Error(`${OP_ID} 200 has no example ${label}`);
  return found[1];
}

function list(value: unknown): Mapping[] {
  return Array.isArray(value) ? value.filter(isMapping) : [];
}

function groupsOf(answer: Mapping): Mapping[] {
  return list(answer.groups);
}

function hitsOf(answer: Mapping): [string, Mapping][] {
  return groupsOf(answer).flatMap((group) =>
    list(group.hits).map((hit): [string, Mapping] => [str(group.type), hit]),
  );
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (isMapping(value)) return Object.values(value).flatMap(stringsIn);
  return [];
}

// ---------------------------------------------------------------------------
// Rule checkers, each proven against planted defects below
// ---------------------------------------------------------------------------

/** R8: what the operation and hit prose fail to say about displayName; empty when right. */
function displayNameRuleProblems(opText: string, hitText: string): string[] {
  const problems: string[] = [];
  const op = prose(opText);
  const hit = prose(hitText);
  if (!/\*\*`displayName` follows its name parts \(the D-L68 ruling\)\.\*\*/.test(op))
    problems.push('no D-L68 heading');
  if (
    !/`displayName` is readable exactly when both `givenNames` and `familyName` are readable in that record's programme/.test(
      op,
    )
  )
    problems.push('not "readable exactly when both parts are readable"');
  if (!/When either is withheld, `displayName` is withheld too/.test(op))
    problems.push('not "withheld when either part is"');
  if (
    !/it is not matched, it is omitted, and `displayName` is listed in `withheldFields` alongside the withheld part/.test(
      op,
    )
  )
    problems.push('not "not matched, omitted, listed"');
  if (!/It is never composed from the readable part, and never replaced by one/.test(op))
    problems.push('may be composed from the readable part');
  if (!/The rule holds even when the withheld part is `null` on that record/.test(op))
    problems.push('the rule may depend on a null value');
  if (!/withheld, never composed, when either is not/.test(hit))
    problems.push('the hit schema does not restate the rule');
  if (/composed per caller|composed from the readable part\b(?!, and never)/.test(op))
    problems.push('the prose allows composition');
  return problems;
}

/** R8, on data: each hit's displayName is withheld exactly when a name part is. */
function displayNameExampleProblems(label: string, hit: Mapping): string[] {
  const withheld = Array.isArray(hit.withheldFields) ? hit.withheldFields.map(str) : [];
  const partWithheld = withheld.includes('givenNames') || withheld.includes('familyName');
  const problems: string[] = [];
  if (partWithheld && !withheld.includes('displayName'))
    problems.push(`${label}: a name part is withheld and displayName is not`);
  if (partWithheld && 'displayName' in hit)
    problems.push(`${label}: displayName is sent while a name part is withheld`);
  if (!partWithheld && withheld.includes('displayName'))
    problems.push(`${label}: displayName is withheld on its own`);
  return problems;
}

/** R7/R14, on data: omitted never nulled; every withholdable field is present xor listed. */
function omissionProblems(label: string, type: string, hit: Mapping): string[] {
  if (type !== 'contact' && type !== 'lead') return [];
  const withheld = Array.isArray(hit.withheldFields) ? hit.withheldFields.map(str) : [];
  const problems: string[] = [];
  for (const field of NAME_FIELDS) {
    const present = field in hit;
    const listed = withheld.includes(field);
    if (present === listed)
      problems.push(`${label}: ${field} is ${present ? 'both sent and listed' : 'neither sent nor listed'}`);
  }
  return problems;
}

/** R5: what the exact-lookup prose fails to say; empty when it says it all. */
function exactLookupProblems(opText: string, phoneText: string, emailText: string): string[] {
  const problems: string[] = [];
  const op = prose(opText);
  if (!/compared for equality with each stored E\.164 number/.test(op))
    problems.push('phone is not compared for equality');
  if (!/a partial number included, is `400 validation_failed` with `details\[\]\.code: invalid_phone` at `phone`/.test(op))
    problems.push('a partial number is not invalid_phone');
  if (!/\*\*never a prefix or substring of a number\.\*\*/.test(op))
    problems.push('phone may be a prefix or substring');
  if (!/`email` is a whole address, trimmed and compared for equality case-insensitively/.test(op))
    problems.push('email is not a whole address compared for equality');
  if (!/Both search contacts and leads only \(`x-kasuwa-exact-fields`\); with either, the account and deal groups are answered empty/.test(op))
    problems.push('exact lookups are not limited to contacts and leads');
  if (!/Never a prefix or a substring/.test(prose(phoneText))) problems.push('phone parameter');
  if (!/Never a prefix or a substring/.test(prose(emailText))) problems.push('email parameter');
  if (/(?<!never a )(?<!Never a )prefix of (a|the) number(?! )/.test(op))
    problems.push('the prose offers a number prefix');
  return problems;
}

/** R9: what x-kasuwa-rights gets wrong; empty when right. */
function rightsProblems(rights: unknown): string[] {
  if (!isMapping(rights)) return ['x-kasuwa-rights missing'];
  const problems: string[] = [];
  for (const set of SETS) {
    const got = rights[set];
    const want = RIGHTS[set] ?? {};
    if (!isMapping(got)) {
      problems.push(`${set}: missing or not per type`);
      continue;
    }
    for (const type of TYPE_ORDER) {
      if (got[type] !== want[type])
        problems.push(`${set}.${type} is ${String(got[type])}, not ${String(want[type])}`);
    }
    for (const key of Object.keys(got)) {
      if (!TYPE_ORDER.includes(key)) problems.push(`${set}: unknown type ${key}`);
    }
  }
  for (const key of Object.keys(rights)) {
    if (!SETS.includes(key)) problems.push(`unknown set ${key}`);
  }
  const portal = rights.client_portal;
  if (isMapping(portal) && portal.deal !== 'none') problems.push('the portal reads deals (D-L115)');
  return problems;
}

/** R12: count-like keys at any depth of a schema; empty when there are none. */
function countKeys(schema: Located): string[] {
  return deepKeys(schema).filter((path) =>
    path
      .split(/[.[\]]+/)
      .filter((part) => part !== '')
      .some((part) => COUNT_KEY.test(part)),
  );
}

/** R19: name-like values in an example that are not obviously synthetic. */
function realisticNames(value: unknown, key = ''): string[] {
  if (typeof value === 'string')
    return NAME_LIKE.has(key) && !SYNTHETIC.test(fold(value)) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => realisticNames(item, key));
  if (isMapping(value))
    return Object.entries(value).flatMap(([name, item]) => realisticNames(item, name));
  return [];
}

/** The order rule (R15) as prose; empty when it is all there. */
function errorOrderProblems(opText: string): string[] {
  const op = prose(opText);
  const problems: string[] = [];
  if (!/Every `400` is decided from the request alone, before any record is read, so no `400` depends on what exists/.test(op))
    problems.push('a 400 may depend on what exists');
  const steps = [
    'authentication (`401`) and the scope-header `400` first',
    'then the one-term rule (`one_term_required`)',
    "then each parameter's own shape",
    'then the folded length (`query_too_short`)',
  ];
  let from = op.indexOf('**Order:**');
  if (from === -1) problems.push('no **Order:**');
  for (const step of steps) {
    const found = op.indexOf(step, Math.max(from, 0));
    if (found === -1) problems.push(`step missing or out of order: ${step}`);
    else from = found;
  }
  if (!/A read, so there is never a `403`, and it names no record, so there is never a `404`/.test(op))
    problems.push('403 or 404 not excluded');
  return problems;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe('acceptance: records contract, global search (T-0085)', () => {
  describe('the operation (R1, R20)', () => {
    it('searchRecords is GET /api/v1/search, tag search, naming exactly the P27 frames it serves', () => {
      const op = gate();
      expect(op.method).toBe('get');
      expect(op.path).toBe(SEARCH_PATH);
      expect(op.op.tags).toEqual(['search']);
      const screens = Array.isArray(op.op['x-kasuwa-screens'])
        ? op.op['x-kasuwa-screens'].map(str)
        : [];
      expect([...screens].sort()).toEqual([...SCREENS].sort());
      expect(typeof op.op['x-kasuwa-implemented']).toBe('boolean');
    });

    it('the search tag is declared, and nothing else searches under another path or id', () => {
      gate();
      const tags = (Array.isArray(spec().tags) ? spec().tags : []) as unknown[];
      expect(tags.filter(isMapping).map((tag) => str(tag.name))).toContain('search');
      const others = operations()
        .filter((op) => op.id !== OP_ID)
        .filter((op) => /search/i.test(op.id) || /\/search(\/|$)/.test(op.path))
        .map((op) => `${op.method.toUpperCase()} ${op.path} (${op.id})`);
      expect(others).toEqual([]);
      expect(operations().filter((op) => op.path === SEARCH_PATH).length, 'one method only').toBe(
        1,
      );
    });

    it('the flag: x-kasuwa-implemented is true once T-0086 serves search (FAILS ON THIS BRANCH BY DESIGN)', () => {
      expect(gate().op['x-kasuwa-implemented'], 'set to true by T-0086 with the route').toBe(true);
    });
  });

  describe('parameters and scope (R2, R4, R5, R11, R17)', () => {
    it('takes exactly q, phone, email and types, all optional query parameters', () => {
      const op = gate();
      expect(op.params.map((parameter) => str(parameter.name)).sort()).toEqual(PARAMS);
      for (const parameter of op.params) {
        expect(parameter.in, str(parameter.name)).toBe('query');
        expect(parameter.required, `${str(parameter.name)} is optional`).not.toBe(true);
      }
    });

    it('no paging, sorting, limit, programme, tenant, scope, owner or date parameter; no header, cookie or auth opt-out (rule 1, R11)', () => {
      const op = gate();
      const offending = op.params
        .map((parameter) => str(parameter.name))
        .filter((name) =>
          /cursor|limit|offset|page|sort|programme|tenant|scope|business|owner|date|from|to$/i.test(
            name,
          ),
        );
      expect(offending).toEqual([]);
      expect(op.params.filter((p) => p.in === 'header' || p.in === 'cookie')).toEqual([]);
      expect(op.op.security, 'overrides security').toBeUndefined();
    });

    it('exactly one term: none or more than one is 400 one_term_required at q (R2)', () => {
      expect(description()).toMatch(
        /\*\*Exactly one search term\.\*\* A request carries exactly one of `q`, `phone` or `email`\. None, or more than one, is `400 validation_failed` with `details\[\]\.code: one_term_required` at `q`/,
      );
    });

    it('q is 2..100 as sent, at least 2 once folded, and refuses a control character (R4)', () => {
      const schema = paramSchema('q');
      const node = schema.node;
      expect(isMapping(node) ? [node.type, node.minLength, node.maxLength] : []).toEqual([
        'string',
        2,
        100,
      ]);
      expect(validate(schema, 'sa', 'q')).toEqual([]);
      expect(validate(schema, 's', 'q').length, 'one character accepted').toBeGreaterThan(0);
      expect(validate(schema, 'x'.repeat(101), 'q').length, '101 accepted').toBeGreaterThan(0);
      expect(description()).toMatch(
        /\*\*The folded query must be at least 2 characters\*\*, else `400 validation_failed` with `details\[\]\.code: query_too_short` at `q`/,
      );
      expect(prose(str(param('q')?.description))).toMatch(
        /A NUL or other control character is `400 validation_failed` with `details\[\]\.code: invalid_string`/,
      );
    });

    it('phone is one whole number in common formats, bounded; email a bounded address (R5)', () => {
      const phone = paramSchema('phone');
      for (const good of ['0803 123 4567', '+234 803 123 4567', '2348031234567', '(0803) 123-4567']) {
        expect(validate(phone, good, 'phone'), good).toEqual([]);
      }
      for (const bad of ['sample', '0803%', '080*1234', '080', '+', '0'.repeat(33), '0803\u0000123']) {
        expect(validate(phone, bad, 'phone').length, `phone accepted ${bad}`).toBeGreaterThan(0);
      }
      const email = paramSchema('email');
      const node = email.node;
      expect(isMapping(node) ? [node.type, node.format, node.minLength, node.maxLength] : []).toEqual(
        ['string', 'email', 3, 254],
      );
      expect(validate(email, 'sample@example.test', 'email')).toEqual([]);
      expect(validate(email, 'sample', 'email').length).toBeGreaterThan(0);
    });

    it('exact lookups compare whole values, never a prefix or substring, on contacts and leads only (R5)', () => {
      const problems = exactLookupProblems(
        description(),
        str(param('phone')?.description),
        str(param('email')?.description),
      );
      expect(problems).toEqual([]);
      expect(gate().op['x-kasuwa-exact-fields']).toEqual(EXACT_FIELDS);
      const contact = properties(schemaNamed('Contact'));
      for (const field of ['phones', 'emails']) expect(contact.has(field), field).toBe(true);
    });

    it('(self-check, R5) an exact lookup that turns into a prefix or substring match is caught', () => {
      const real = [
        description(),
        str(param('phone')?.description),
        str(param('email')?.description),
      ] as const;
      expect(exactLookupProblems(...real), 'the real prose').toEqual([]);
      const planted: [string, [string, string, string]][] = [
        ['a prefix', [real[0].replace('**never a prefix or substring of a number.**', 'a prefix of the number also matches.'), real[1], real[2]]],
        ['equality dropped', [real[0].replace('compared for equality with each stored E.164 number', 'matched against each stored number'), real[1], real[2]]],
        ['a partial number allowed', [real[0].replace('a partial number included, ', ''), real[1], real[2]]],
        ['email substring', [real[0], real[1], real[2].replace('Never a prefix or a substring.', 'Or any part of one.')]],
        ['accounts searched', [real[0].replace('Both search contacts and leads only', 'Both search every type'), real[1], real[2]]],
      ];
      for (const [label, texts] of planted) {
        expect(texts.join('|'), `${label}: the plant changed nothing`).not.toBe(real.join('|'));
        expect(exactLookupProblems(...texts).length, `${label} passed`).toBeGreaterThan(0);
      }
    });

    it('types is 1..4 unique SearchType values: contact, lead, account, deal; unknown is unknown_type; additive (R17)', () => {
      const parameter = param('types');
      expect([parameter?.style, parameter?.explode]).toEqual(['form', true]);
      const schema = paramSchema('types');
      expect(enumOf(schema).map(str)).toEqual(TYPE_ORDER);
      expect(validate(schema, TYPE_ORDER, 'types')).toEqual([]);
      for (const [label, bad] of [
        ['empty', []],
        ['a ticket', ['ticket']],
        ['a repeat', ['contact', 'contact']],
        ['five', [...TYPE_ORDER, 'contact']],
        ['a plural', ['contacts']],
      ] as const) {
        expect(validate(schema, bad, 'types').length, `types accepted ${label}`).toBeGreaterThan(0);
      }
      const text = prose(str(parameter?.description));
      expect(text).toMatch(/`unknown_type` for an unknown one/);
      expect(text).toMatch(/additive \(D-L87\)/);
      expect(text).toMatch(/a client ignores a group whose `type` it does not know/);
      expect(schemaDescription('SearchType')).toMatch(/Additive \(D-L87\)/);
    });

    it('scope is the session’s: no parameter widens or narrows it, and nothing outside it is counted, shown or hinted (R11)', () => {
      const text = description();
      expect(text).toMatch(/\*\*Scope is the session's \(rule 1\)\.\*\*/);
      expect(text).toMatch(/There is no programme, tenant or scope parameter/);
      expect(text).toMatch(/unknown query parameters are ignored, never honoured, and a scope header is `400 validation_failed`/);
      expect(text).toMatch(/\*\*Nothing outside that scope is counted, shown or hinted\*\* \(D-L87, CLAUDE\.md 6\.4\)/);
      expect(text).toMatch(/P27\/B's "3 in programmes you are not on" is not served/);
      expect(text).toMatch(/a record in another programme or tenant changes nothing in any answer/);
    });
  });

  describe('matching: prefix on folded text (R3, R6)', () => {
    it('the prose states the folding, whole-field prefix, literal wildcards and no phone or email in q', () => {
      const text = description();
      for (const phrase of [
        /`q` matches a field when the field's folded value STARTS WITH the folded query/,
        /Unicode NFD, every combining mark removed, lower-cased by the locale-independent Unicode default mapping, leading and trailing whitespace trimmed, and each run of inner whitespace made one space/,
        /Comparison is by code point/,
        /\*\*The prefix is of the whole field value, not of each word:\*\*/,
        /`%`, `_` and `\\` match themselves literally \(D-L115\); there are no wildcards/,
        /`q` never matches a phone or an email/,
        /The fields each type matches on are listed in `x-kasuwa-search-fields`, and only those/,
      ]) {
        expect(text).toMatch(phrase);
      }
    });

    it('trigram and word matching are named as a later, additive change: every prefix hit stays a hit (ADR-0015, D-L128)', () => {
      expect(description()).toMatch(
        /Trigram similarity and word matching are a later, additive change \(ADR-0015, once the LEAKPROOF marks are applied\): they may add hits, and every prefix hit stays a hit/,
      );
    });

    it('(self-check) the fold-and-prefix helper agrees with every worked case in the prose', () => {
      gate();
      expect(prefixMatches('Sámple Fixture', 'sam')).toBe(true);
      expect(prefixMatches('Sámple Fixture', 'SAM')).toBe(true);
      expect(prefixMatches('Sámple Fixture', 'sample f')).toBe(true);
      expect(prefixMatches('  Sámple   Fixture ', 'sample  f')).toBe(true);
      expect(prefixMatches('Sámple Fixture', 'fix'), 'whole-field, not per word').toBe(false);
      expect(prefixMatches('Fixture', 'fix')).toBe(true);
      expect(prefixMatches('Søren Sample', 'so'), 'ø has no decomposition').toBe(false);
      expect(prefixMatches('50% Sample', '50%')).toBe(true);
      expect(prefixMatches('500 Sample', '5_0'), '_ is literal').toBe(false);
      expect(prefixMatches(null, 'sa')).toBe(false);
    });

    it('x-kasuwa-search-fields names exactly each type’s fields, and each is a property of that type’s record (R6)', () => {
      const fields = gate().op['x-kasuwa-search-fields'];
      expect(fields).toEqual(SEARCH_FIELDS);
      const problems: string[] = [];
      for (const [type, names] of Object.entries(SEARCH_FIELDS)) {
        const record = properties(schemaNamed(RECORD_SCHEMA[type] ?? ''));
        for (const name of names) {
          if (!record.has(name)) problems.push(`${type}.${name} is not on ${RECORD_SCHEMA[type]}`);
        }
      }
      expect(problems).toEqual([]);
    });

    it('the account and deal search fields are fields field security never withholds (R6)', () => {
      gate();
      expect(schemaDescription('Account')).toMatch(/`id`, `programmeId`, `name`, `version`, `createdAt`, `updatedAt` and `withheldFields` are never withheld/);
      expect(schemaDescription('Deal')).toMatch(/`id`, `programmeId`, `pipelineId`, `stageId`, `version`, `name`,/);
      const withholdable = enumOf(schemaNamed('DealWithheldField')).map(str);
      expect(withholdable).not.toContain('name');
      expect(withholdable).not.toContain('pipelineId');
    });

    it('every hit of the prefix example matches q=sam on a field its type searches and the caller reads', () => {
      const answer = okExample('prefix');
      const problems: string[] = [];
      let checked = 0;
      for (const [type, hit] of hitsOf(answer)) {
        checked += 1;
        const withheld = Array.isArray(hit.withheldFields) ? hit.withheldFields.map(str) : [];
        const readable = (SEARCH_FIELDS[type] ?? []).filter((field) => !withheld.includes(field));
        if (!readable.some((field) => prefixMatches(hit[field], 'sam')))
          problems.push(`${type} ${str(hit.id)} does not match sam on a readable field`);
      }
      expect(problems).toEqual([]);
      expect(checked, 'the prefix example has hits of every type').toBeGreaterThanOrEqual(4);
      expect(groupsOf(answer).map((group) => str(group.type))).toEqual(TYPE_ORDER);
    });

    it('the prefix example shows a match on an accented name and one on a company name', () => {
      const hits = hitsOf(okExample('prefix'));
      expect(
        hits.some(([, hit]) => str(hit.displayName) !== fold(str(hit.displayName)) && prefixMatches(hit.displayName, 'sam')),
        'no hit whose match needs folding',
      ).toBe(true);
      expect(
        hits.some(
          ([, hit]) =>
            prefixMatches(hit.companyName, 'sam') &&
            !['displayName', 'givenNames', 'familyName'].some((f) => prefixMatches(hit[f], 'sam')),
        ),
        'no hit found by its company alone',
      ).toBe(true);
    });
  });

  describe('field security (R7, R8, R10)', () => {
    it('a withheld field is never compared, never chooses or orders hits, is omitted and listed; never 400 field_withheld (R7)', () => {
      const text = description();
      for (const phrase of [
        /\*\*Field security: a hit never matches on, or returns, a withheld field\.\*\*/,
        /Each field is judged in the hit's OWN programme, against the permission set the caller holds there, row by row/,
        /the tenant-admin flag never lifts it \(D-L63\)/,
        /A field withheld there is never compared with the query \(prefix or exact\), never decides which hits are chosen or their order, and is omitted from the hit and named in its `withheldFields`/,
        /An exact lookup on a number or address withheld in a record's programme does not find that record: the answer is the same as for a number nobody has/,
        /Field security never makes this read answer `400 field_withheld`: a withheld field simply does not match/,
      ]) {
        expect(text).toMatch(phrase);
      }
      const details = exampleBodies(responses(gate()).get('400')).flatMap((body) =>
        list(body.details).map((detail) => str(detail.code)),
      );
      expect(details).not.toContain('field_withheld');
    });

    it('displayName follows its name parts: withheld, never composed, when either part is withheld (R8, D-L68)', () => {
      expect(
        displayNameRuleProblems(str(gate().op.description), schemaDescription('ContactSearchHit')),
      ).toEqual([]);
      expect(schemaDescription('LeadSearchHit')).toMatch(
        /`displayName` follows its name parts exactly as on ContactSearchHit \(D-L68\)/,
      );
      expect(schemaDescription('SearchNameWithheldField')).toMatch(
        /`displayName` is listed whenever `givenNames` or `familyName` is \(D-L68\)/,
      );
      expect(description()).toMatch(
        /getContact, listContacts and listLeads are not changed by this operation \(their alignment is the D-L68 follow-up\)/,
      );
    });

    it('(self-check, R8) a looser displayName rule is caught', () => {
      const op = str(gate().op.description);
      const hit = schemaDescription('ContactSearchHit');
      expect(displayNameRuleProblems(op, hit), 'the real prose').toEqual([]);
      const planted: [string, string, string][] = [
        ['either instead of both', op.replace(/exactly when\s+both/, 'exactly when either'), hit],
        ['composition allowed', op.replace(/It is never composed\s+from the readable part, and never replaced by one/, 'It is composed from the readable part'), hit],
        ['null exempt', op.replace(/The rule holds even when the withheld\s+part is `null` on that record/, 'A null part does not count'), hit],
        ['still matched', op.replace(/it is not matched,\s+it is omitted/, 'it is omitted'), hit],
        ['hit composes', op, hit.replace('withheld, never composed, when either is not', 'composed per caller')],
      ];
      for (const [label, opText, hitText] of planted) {
        expect(opText + hitText, `${label}: the plant changed nothing`).not.toBe(op + hit);
        expect(displayNameRuleProblems(opText, hitText).length, `${label} passed`).toBeGreaterThan(0);
      }
    });

    it('every contact and lead hit in every example obeys the displayName rule and omits, never nulls (R7, R8)', () => {
      const problems: string[] = [];
      let checked = 0;
      for (const [label, answer] of okExamples()) {
        for (const [type, hit] of hitsOf(answer)) {
          if (type !== 'contact' && type !== 'lead') continue;
          checked += 1;
          const where = `${label} ${type} ${str(hit.id)}`;
          problems.push(...displayNameExampleProblems(where, hit));
          problems.push(...omissionProblems(where, type, hit));
        }
      }
      expect(problems).toEqual([]);
      expect(checked).toBeGreaterThanOrEqual(5);
    });

    it('the withheldNamePart example shows the rule: familyName withheld, so displayName withheld, matched on givenNames', () => {
      const [hit] = hitsOf(okExample('withheldNamePart'));
      expect(hit, 'no hit').toBeDefined();
      if (!hit) return;
      const [type, row] = hit;
      expect(type).toBe('contact');
      expect(row.withheldFields).toEqual(expect.arrayContaining(['displayName', 'familyName']));
      expect('displayName' in row).toBe(false);
      expect('familyName' in row).toBe(false);
      expect(prefixMatches(row.givenNames, 'sam'), 'the match is on the readable part').toBe(true);
    });

    it('(self-check, R7/R8) the example checkers catch a composed name, a nulled field and a lone withheld displayName', () => {
      const [entry] = hitsOf(okExample('withheldNamePart'));
      if (!entry) throw new Error('withheldNamePart has no hit');
      const [, row] = entry;
      expect(displayNameExampleProblems('real', row)).toEqual([]);
      expect(omissionProblems('real', 'contact', row)).toEqual([]);
      const composed = { ...row, displayName: str(row.givenNames) };
      expect(displayNameExampleProblems('composed', composed).length).toBeGreaterThan(0);
      expect(omissionProblems('composed', 'contact', composed).length).toBeGreaterThan(0);
      const unlisted = { ...row, withheldFields: ['familyName'] };
      expect(displayNameExampleProblems('unlisted', unlisted).length).toBeGreaterThan(0);
      const nulled = { ...row, familyName: null };
      expect(omissionProblems('nulled', 'contact', nulled).length).toBeGreaterThan(0);
      const lone = {
        type: 'contact',
        id: row.id,
        programmeId: row.programmeId,
        givenNames: 'Sample',
        familyName: 'Fixture',
        companyName: null,
        withheldFields: ['displayName'],
      };
      expect(displayNameExampleProblems('lone', lone).length).toBeGreaterThan(0);
    });

    it('the lead group follows listLeads: empty when status is withheld anywhere the caller reaches (R10)', () => {
      const text = description();
      expect(text).toMatch(
        /The lead group follows listLeads: a hit says the contact's `status` is a lead status, so when field security withholds `status` from the caller in any programme they reach, the lead group is answered empty, whatever matched/,
      );
      expect(text).toMatch(/A contact who is a lead may appear in both the contact group and the lead group; both carry the contact id/);
      const status = properties(schemaNamed('LeadSearchHit')).get('status');
      expect(status ? enumOf(status).map(str) : []).toEqual(LEAD_STATUSES);
      const listLeads = operation('listLeads').params.find((p) => p.name === 'status');
      expect(enumOf(at(listLeads?.schema ?? {})).map(str), 'the same set as listLeads').toEqual(
        LEAD_STATUSES,
      );
    });
  });

  describe('readers per type (R9)', () => {
    it('x-kasuwa-rights: every set reads contacts, leads and accounts; deals the staff sets only', () => {
      expect(rightsProblems(gate().op['x-kasuwa-rights'])).toEqual([]);
    });

    it('(self-check, R9) rights that let the portal read deals, or drop a type, are caught', () => {
      const real = gate().op['x-kasuwa-rights'];
      expect(rightsProblems(real)).toEqual([]);
      const base = isMapping(real) ? real : {};
      const portal = isMapping(base.client_portal) ? base.client_portal : {};
      const agent = isMapping(base.agent) ? base.agent : {};
      const planted: [string, unknown][] = [
        ['portal reads deals', { ...base, client_portal: { ...portal, deal: 'read' } }],
        ['agent loses accounts', { ...base, agent: { ...agent, account: 'none' } }],
        ['a scalar right', { ...base, admin: 'read' }],
        ['a custom set', { ...base, custom: STAFF_RIGHTS }],
        ['a ticket type', { ...base, agent: { ...agent, ticket: 'read' } }],
      ];
      for (const [label, rights] of planted) {
        expect(rightsProblems(rights).length, `${label} passed`).toBeGreaterThan(0);
      }
    });

    it('the prose: each group read as the type is read; deals per D-L127, never the portal or a custom set; no error for an unread type', () => {
      const text = description();
      for (const phrase of [
        /Each group is read by exactly the callers who read that type through its own read, in each programme the session resolves/,
        /contacts, leads and accounts by every set, the `client_portal` set included/,
        /deals by the `admin`, `programme_manager`, `team_lead`, `agent` and `qa_analyst` sets and the tenant-admin flag \(D-L127\), never by `client_portal` \(D-L115\) and never by a custom permission set until an explicit per-set "read deals" grant exists \(D-L127\)/,
        /the group is then answered as if nothing matched, never with an error/,
      ]) {
        expect(text).toMatch(phrase);
      }
    });

    it('the portal example answers its deal group empty', () => {
      const groups = groupsOf(okExample('portal'));
      expect(groups.map((group) => str(group.type))).toEqual(['account', 'deal']);
      expect(list(groups.find((group) => group.type === 'deal')?.hits)).toEqual([]);
    });
  });

  describe('the answer: groups, at most three hits, no counts (R12, R13, R14)', () => {
    it('SearchResults is closed: groups only, 1..4, each one of the four closed group schemas', () => {
      const results = responseSchema('200');
      expect(results.node).toBe(schemaNamed('SearchResults').node);
      expect(isClosed(results)).toBe(true);
      expect(keysOf(results)).toEqual(['groups']);
      expect(required(results)).toEqual(['groups']);
      const groups = properties(results).get('groups');
      const node = groups?.node;
      expect(isMapping(node) ? [node.type, node.minItems, node.maxItems] : []).toEqual([
        'array',
        1,
        4,
      ]);
      const items = groups ? child(groups, 'items') : undefined;
      const variants = isMapping(items?.node) && Array.isArray(items.node.oneOf) ? items.node.oneOf : [];
      expect(variants.map((variant) => at(variant).node)).toEqual(
        TYPE_ORDER.map((type) => schemaNamed(GROUP_SCHEMA[type] ?? '').node),
      );
    });

    for (const type of TYPE_ORDER) {
      it(`${GROUP_SCHEMA[type]} is closed { type: ${type}, hits: at most 3 ${HIT_SCHEMA[type]} }`, () => {
        gate();
        const group = schemaNamed(GROUP_SCHEMA[type] ?? '');
        expect(isClosed(group)).toBe(true);
        expect(keysOf(group)).toEqual(['hits', 'type']);
        expect(required(group).sort()).toEqual(['hits', 'type']);
        const kind = properties(group).get('type');
        expect(kind ? enumOf(kind) : []).toEqual([type]);
        const hits = properties(group).get('hits');
        expect(isMapping(hits?.node) ? hits.node.maxItems : undefined).toBe(3);
        const items = hits ? child(hits, 'items') : undefined;
        expect(items?.node).toBe(schemaNamed(HIT_SCHEMA[type] ?? '').node);
      });

      it(`${HIT_SCHEMA[type]} is closed with exactly its keys, its type a const, its ids uuids (R14)`, () => {
        gate();
        const hit = schemaNamed(HIT_SCHEMA[type] ?? '');
        expect(isClosed(hit)).toBe(true);
        expect(keysOf(hit)).toEqual([...(HIT_KEYS[type] ?? [])].sort());
        expect(required(hit).sort()).toEqual([...(HIT_REQUIRED[type] ?? [])].sort());
        const props = properties(hit);
        const kind = props.get('type');
        expect(kind ? enumOf(kind) : []).toEqual([type]);
        for (const key of ['id', 'programmeId', 'pipelineId']) {
          const value = props.get(key);
          if (value) expect(isMapping(value.node) ? value.node.format : undefined, key).toBe('uuid');
        }
        expect(keysOf(hit).filter((key) => FORBIDDEN_HIT_KEY.test(key))).toEqual([]);
      });
    }

    it('each returned field has its record schema’s own type and bound (R14)', () => {
      gate();
      const problems: string[] = [];
      for (const type of TYPE_ORDER) {
        const hit = properties(schemaNamed(HIT_SCHEMA[type] ?? ''));
        const record = properties(schemaNamed(RECORD_SCHEMA[type] ?? ''));
        for (const [key, value] of hit) {
          if (['type', 'withheldFields', 'status'].includes(key)) continue;
          const source = record.get(key);
          if (!source) {
            problems.push(`${type}.${key} is not a ${RECORD_SCHEMA[type]} property`);
            continue;
          }
          if (JSON.stringify(types(value)) !== JSON.stringify(types(source)))
            problems.push(`${type}.${key}: ${types(value).join('|')} vs ${types(source).join('|')}`);
          const max = (located: Located) =>
            isMapping(located.node) ? located.node.maxLength : undefined;
          if (max(value) !== max(source)) problems.push(`${type}.${key}: maxLength differs`);
        }
      }
      expect(problems).toEqual([]);
    });

    it('withheldFields on contact and lead hits: required, unique, at most the four name fields', () => {
      gate();
      expect(enumOf(schemaNamed('SearchNameWithheldField')).map(str)).toEqual(NAME_FIELDS);
      for (const type of ['contact', 'lead']) {
        const withheld = properties(schemaNamed(HIT_SCHEMA[type] ?? '')).get('withheldFields');
        const node = withheld?.node;
        expect(isMapping(node) ? [node.type, node.uniqueItems, node.maxItems] : [], type).toEqual([
          'array',
          true,
          4,
        ]);
        const items = withheld ? child(withheld, 'items') : undefined;
        expect(items?.node).toBe(schemaNamed('SearchNameWithheldField').node);
      }
    });

    it('the deal hit name is classified pii (D-L91)', () => {
      const name = properties(schemaNamed('DealSearchHit')).get('name');
      expect(isMapping(name?.node) ? name.node['x-kasuwa-classification'] : undefined).toBe('pii');
    });

    it('no count, total, more flag, cursor or facet at any depth of the answer (R12, D-P13)', () => {
      expect(countKeys(responseSchema('200'))).toEqual([]);
      const text = description();
      expect(text).toMatch(/\*\*No counts\*\* \(D-P13\): no total, no per-type or per-programme count, no "more" flag and no estimate/);
      expect(schemaDescription('SearchResults')).toMatch(/\*\*No counts of any kind\*\* \(D-P13\)/);
    });

    it('(self-check, R12) a count planted at the top or in a group is caught', () => {
      const results = responseSchema('200');
      expect(countKeys(results), 'the real schema').toEqual([]);
      const node = isMapping(results.node) ? results.node : {};
      const props = isMapping(node.properties) ? node.properties : {};
      const top: Located = {
        node: { ...node, properties: { ...props, total: { type: 'integer' } } },
        file: results.file,
      };
      expect(countKeys(top)).toEqual(['total']);
      const group = schemaNamed('ContactSearchGroup');
      const groupNode = isMapping(group.node) ? group.node : {};
      const groupProps = isMapping(groupNode.properties) ? groupNode.properties : {};
      const nested: Located = {
        node: {
          ...node,
          properties: {
            groups: {
              type: 'array',
              items: { ...groupNode, properties: { ...groupProps, hasMore: { type: 'boolean' } } },
            },
          },
        },
        file: results.file,
      };
      expect(countKeys(nested)).toEqual(['groups[].hasMore']);
    });

    it('groups: one per requested type, fixed order, at most three, [] when none; the choice and order of hits pinned only as deterministic and blind to withheld fields (R13)', () => {
      const text = description();
      for (const phrase of [
        /`groups` holds one group per requested type, always in the order contact, lead, account, deal, each with at most three hits, `\[\]` when none/,
        /A record appears at most once in a group/,
        /Which three hits, and their order, are not part of the contract, except that the same data and query give the same answer and that neither ever depends on a withheld field/,
        /Contact and lead hits never carry a phone or an email, an exact lookup included/,
      ]) {
        expect(text).toMatch(phrase);
      }
    });

    it('every example: groups in the fixed order, each type once, hits typed as their group, no record twice in a group', () => {
      const problems: string[] = [];
      for (const [label, answer] of okExamples()) {
        const order = groupsOf(answer).map((group) => str(group.type));
        const ranks = order.map((type) => TYPE_ORDER.indexOf(type));
        if (ranks.some((rank) => rank < 0) || ranks.some((rank, i) => i > 0 && rank <= (ranks[i - 1] ?? -1)))
          problems.push(`${label}: groups ${order.join(', ')}`);
        for (const group of groupsOf(answer)) {
          const ids = list(group.hits).map((hit) => str(hit.id));
          if (new Set(ids).size !== ids.length) problems.push(`${label} ${str(group.type)}: a record twice`);
          for (const hit of list(group.hits)) {
            if (hit.type !== group.type) problems.push(`${label}: a ${str(hit.type)} hit in ${str(group.type)}`);
          }
        }
      }
      expect(problems).toEqual([]);
      expect(okExamples().map(([label]) => label).sort()).toEqual([...EXAMPLE_LABELS].sort());
    });

    it('the phone example answers only contacts and leads; the account and deal groups are empty (R5)', () => {
      const groups = groupsOf(okExample('phoneLookup'));
      expect(groups.map((group) => str(group.type))).toEqual(TYPE_ORDER);
      for (const type of ['account', 'deal']) {
        expect(list(groups.find((group) => group.type === type)?.hits), type).toEqual([]);
      }
      expect(list(groups.find((group) => group.type === 'contact')?.hits).length).toBeGreaterThan(0);
    });

    it('"see all" is the type’s own list with q, none for deals, and a list may show more (R18)', () => {
      const text = description();
      expect(text).toMatch(/\*\*"See all" is the type's own list read with `q`\*\* \(listContacts, listLeads, listAccounts\)/);
      expect(text).toMatch(/deals have no cross-pipeline list, so a deal hit opens the deal and there is no "see all" for deals/);
      expect(text).toMatch(/A list's `q` is a substring match and also matches numbers, so "see all" may show rows this read did not/);
      for (const id of ['listContacts', 'listLeads', 'listAccounts']) {
        expect(operation(id).params.map((p) => str(p.name)), id).toContain('q');
      }
    });
  });

  describe('errors and their order (R15)', () => {
    it('documents exactly 200, 400 and 401, and decides one failure: 400 validation_failed', () => {
      const op = gate();
      expect([...responses(op).keys()].sort()).toEqual(['200', '400', '401']);
      expect(op.op['x-kasuwa-error-order']).toEqual(['400 validation_failed']);
    });

    it('every 400 is decided from the request alone, in the stated order; never 403 or 404', () => {
      expect(errorOrderProblems(str(gate().op.description))).toEqual([]);
      const bad = responses(gate()).get('400')?.node;
      expect(prose(isMapping(bad) ? str(bad.description) : '')).toMatch(
        /Decided from the request alone, before any record is read: no `400` here depends on what exists/,
      );
    });

    it('(self-check, R15) a reordered or data-dependent error rule is caught', () => {
      // Collapsed first, so a plant is not defeated by where the YAML wraps a line.
      const real = description();
      expect(errorOrderProblems(real)).toEqual([]);
      const planted: [string, string][] = [
        ['data-dependent', real.replace(/before any record is read, so no `400` depends on what exists/, 'after the scoped read')],
        ['reordered', real.replace(/then the one-term rule \(`one_term_required`\); then each parameter's own shape/, "then each parameter's own shape; then the one-term rule (`one_term_required`)")],
        ['a 404', real.replace(/so there is never a `404`/, 'so a missing record is `404`')],
      ];
      for (const [label, text] of planted) {
        expect(text, `${label}: the plant changed nothing`).not.toBe(real);
        expect(errorOrderProblems(text).length, `${label} passed`).toBeGreaterThan(0);
      }
    });

    it('the 400 and 401 use the shared Error schema; the 400 examples carry exactly the search reason codes, path and code only', () => {
      const shared = jsonSchema(responses(operation('getContact')).get('404'));
      if (!shared) throw new Error('getContact 404 has no schema');
      for (const status of ['400', '401']) {
        expect(jsonSchema(responses(gate()).get(status))?.node, status).toBe(shared.node);
      }
      const bad = responses(gate()).get('400');
      expect(bad?.node).toBe(at({ $ref: '#/components/responses/SearchValidationFailed' }).node);
      const bodies = exampleBodies(bad);
      const details: string[] = [];
      for (const body of bodies) {
        expect(body.code).toBe('validation_failed');
        expect(body.statusCode).toBe(400);
        for (const detail of list(body.details)) {
          expect(Object.keys(detail).sort(), 'a detail carries more than path and code').toEqual([
            'code',
            'path',
          ]);
          details.push(`${str(detail.path)} ${str(detail.code)}`);
        }
      }
      expect([...details].sort()).toEqual(BAD_REQUEST_DETAILS);
    });

    it('every answer, errors included, is Cache-Control: no-store; the query string is personal data (R16, D-L80)', () => {
      const problems: string[] = [];
      for (const [status, response] of responses(gate())) {
        const schema = cacheControlSchema(response);
        const values = schema ? enumOf(schema) : [];
        if (JSON.stringify(values) !== JSON.stringify(['no-store']))
          problems.push(`${status}: ${schema ? JSON.stringify(values) : 'missing'}`);
      }
      expect(problems).toEqual([]);
      const text = description();
      expect(text).toMatch(/carries `Cache-Control: no-store`: the URL is the same for every user of every tenant/);
      expect(text).toMatch(/\*\*The query string is personal data\*\* \(a name, a number or an address\): request telemetry keeps the route template only, and ingress must strip query strings from access logs before the first deployed cell \(D-L80\)/);
    });
  });

  describe('examples (R19, D-L97)', () => {
    it('(self-check) the validator rejects broken copies of the search examples', () => {
      const schema = responseSchema('200');
      const answer = okExample('prefix');
      expect(validate(schema, answer, 'answer'), 'the unbroken example').toEqual([]);
      const groups = groupsOf(answer);
      const [contacts] = groups;
      if (!contacts) throw new Error('prefix has no group');
      const [first] = list(contacts.hits);
      if (!first) throw new Error('prefix has no contact hit');
      const withGroup = (group: Mapping): Mapping => ({ ...answer, groups: [group, ...groups.slice(1)] });
      const withHit = (hit: Mapping): Mapping => withGroup({ ...contacts, hits: [hit] });
      const mutants: [string, unknown][] = [
        ['a fourth hit', withGroup({ ...contacts, hits: [first, first, first, first] })],
        ['a total', { ...answer, total: 9 }],
        ['a group count', withGroup({ ...contacts, count: 2 })],
        ['a hit with a phone', withHit({ ...first, phones: [{ type: 'mobile', e164: '+2348030000001' }] })],
        ['a hit with an email', withHit({ ...first, emails: ['sample@example.test'] })],
        ['a hit with an owner', withHit({ ...first, owner: null })],
        ['a lead hit in the contact group', withHit({ ...first, type: 'lead' })],
        ['an unknown withheld name', withHit({ ...first, withheldFields: ['phones'] })],
        ['a repeated withheld name', withHit({ ...first, withheldFields: ['familyName', 'familyName'] })],
        ['a non-uuid id', withHit({ ...first, id: 'contact-1' })],
        ['no programmeId', withHit(JSON.parse(JSON.stringify({ ...first, programmeId: undefined })) as Mapping)],
        ['a ticket group', withGroup({ type: 'ticket', hits: [] })],
        ['no groups', { groups: [] }],
        ['five groups', { groups: [...groups, contacts] }],
        ['an account with an owner', { groups: [{ type: 'account', hits: [{ type: 'account', id: first.id, programmeId: first.programmeId, name: 'Sample', ownerUserId: null }] }] }],
        ['a deal with an amount', { groups: [{ type: 'deal', hits: [{ type: 'deal', id: first.id, programmeId: first.programmeId, pipelineId: first.id, name: 'Sample', amount: null }] }] }],
        ['a customer lead', { groups: [{ type: 'lead', hits: [{ type: 'lead', id: first.id, programmeId: first.programmeId, status: 'customer', withheldFields: [] }] }] }],
      ];
      for (const [label, mutant] of mutants) {
        expect(validate(schema, mutant, 'answer').length, `accepted ${label}`).toBeGreaterThan(0);
      }
    });

    it('every example on searchRecords validates against its schema', () => {
      const problems: string[] = [];
      let checked = 0;
      for (const [status, response] of responses(gate())) {
        const schema = jsonSchema(response);
        const examples = examplesOf(jsonMedia(response));
        if (examples.length === 0) problems.push(`${status}: no example`);
        for (const [label, value] of examples) {
          checked += 1;
          if (schema) problems.push(...validate(schema, value, `${status} ${label}`));
        }
      }
      expect(problems).toEqual([]);
      // Four success answers, six 400 bodies and the 401.
      expect(checked).toBeGreaterThanOrEqual(11);
    });

    it('the examples use synthetic names only (R19)', () => {
      const offending: string[] = [];
      let checked = 0;
      for (const [label, answer] of okExamples()) {
        for (const [, hit] of hitsOf(answer)) {
          for (const key of Object.keys(hit)) if (NAME_LIKE.has(key) && typeof hit[key] === 'string') checked += 1;
        }
        offending.push(...realisticNames(answer).map((name) => `${label}: ${name}`));
      }
      expect(offending).toEqual([]);
      expect(checked, 'no names checked').toBeGreaterThanOrEqual(15);
      const summaries = stringsIn(
        isMapping(jsonMedia(responses(gate()).get('200'))?.node)
          ? (jsonMedia(responses(gate()).get('200'))?.node as Mapping).examples
          : {},
      );
      expect(summaries.filter((text) => /Okonkwo|Balogun|Bakare|Adaeze|Kemi/i.test(text))).toEqual([]);
    });

    it('(self-check, R19) a realistic name planted in an example is caught', () => {
      const answer = okExample('prefix');
      expect(realisticNames(answer)).toEqual([]);
      const [contacts, ...rest] = groupsOf(answer);
      if (!contacts) throw new Error('prefix has no group');
      const [first] = list(contacts.hits);
      const planted = {
        groups: [{ ...contacts, hits: [{ ...first, displayName: 'Chidi Okafor' }] }, ...rest],
      };
      expect(realisticNames(planted)).toEqual(['Chidi Okafor']);
    });

    it('every other example in the file still validates (D-L97: adding search breaks no mock)', () => {
      gate(); // Not vacuous on main: this holds before the work starts.
      const problems: string[] = [];
      let checked = 0;
      for (const op of operations()) {
        if (op.id === OP_ID) continue;
        const body = op.op.requestBody === undefined ? undefined : at(op.op.requestBody);
        const bodySchema = jsonSchema(body);
        for (const [label, value] of examplesOf(jsonMedia(body))) {
          checked += 1;
          if (bodySchema)
            problems.push(...validate(bodySchema, value, `${op.id} request ${label}`));
        }
        for (const [status, response] of responses(op)) {
          const schema = jsonSchema(response);
          for (const [label, value] of examplesOf(jsonMedia(response))) {
            checked += 1;
            if (schema) problems.push(...validate(schema, value, `${op.id} ${status} ${label}`));
          }
        }
      }
      expect(problems).toEqual([]);
      expect(checked).toBeGreaterThan(20);
    });
  });
});
