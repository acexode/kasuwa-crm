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
 *   searchRecords   GET  /api/v1/search?q=…[&types=…]
 *   lookupRecords   POST /api/v1/search/lookup   { phone | email, types? }
 *
 *   PARAMETERS  searchRecords: exactly `q` (required, 2..100) and `types`
 *               (array of SearchType, 1..4, unique). Nothing else: no phone,
 *               email, limit, cursor, sort, offset, programme, tenant,
 *               scope, owner or date. lookupRecords: no parameter at all.
 *   BODY        lookupRecords: `LookupRequest`, closed, exactly one of
 *               `phone` (6..32, digits and + ( ) . - and space) or `email`
 *               (format email, 3..254), plus optional `types`. A read sent
 *               as a POST: it writes nothing, answers 200, is not audited.
 *   200         both: `SearchResults { groups }`, closed. A group is
 *               `{ type, hits }`, closed, one per requested type, in the order
 *               contact, lead, account, deal, `hits` at most 3. No count of
 *               any kind.
 *   HITS        closed, each `{ type, id, programmeId, … }`:
 *                 ContactSearchHit  displayName?, givenNames?, familyName?,
 *                                   companyName?, withheldFields
 *                 LeadSearchHit     the same plus status (a lead status)
 *                 AccountSearchHit  name
 *                 DealSearchHit     pipelineId, name (pii)
 *   EXTENSIONS  `x-kasuwa-search-fields` on searchRecords (per type, the
 *               prefix-matched fields), `x-kasuwa-exact-fields` on
 *               lookupRecords (per body property, per type, the field
 *               compared), `x-kasuwa-rights` on both, identical (per seeded
 *               set, per type, read or none), `x-kasuwa-error-order`.
 *   ERRORS      `400`, `401` and `429` only, no 403, no 404 (429 added by
 *               D-L134, T-0086).
 *                 both           SearchTooManyRequests: 429
 *                                too_many_requests, per user, decided after
 *                                authentication and before validation
 *                 searchRecords  SearchValidationFailed: query_required,
 *                                identifier_in_url, invalid_string,
 *                                query_too_short, unknown_type
 *                 lookupRecords  LookupValidationFailed: unknown_property,
 *                                one_term_required, invalid_phone,
 *                                invalid_email, unknown_type
 *   TRANSPORT   `Cache-Control: no-store` on every answer of both.
 *   FLAGS       `x-kasuwa-implemented: true` on both since T-0086: the two
 *               flag tests pinned `false` (lead edit, D-L133, as T-0105) and
 *               T-0086's suite flipped them to `true` with the routes (lead
 *               edit on lead/T-0086-acceptance).
 *
 * ---------------------------------------------------------------------------
 * RULINGS (R1–R20 accepted by the lead on 2026-10-14 with the amendment to
 * R1, R2, R5, R15, R16 and R20 and the new R21; then the review fixes to R2,
 * R15 and R21 and the new R22; R-numbers are this suite's, not decision ids)
 * ---------------------------------------------------------------------------
 *
 *   R1  Two reads, tag `search`: `GET /api/v1/search` (`searchRecords`) for
 *       the prefix and `POST /api/v1/search/lookup` (`lookupRecords`) for
 *       exact lookups. Screens are exactly the P27 frames each serves:
 *       searchRecords A1 (grouped results), A4 (searching), A5 (no results)
 *       and D1 (records in the palette); lookupRecords A2 (phone) and D1.
 *       Not A (recent searches: nothing is stored), A3 (filters with live
 *       counts), B and B1 (programme scope and the hidden count), C and C1
 *       (facets with counts), D, D2, D3 (commands, switching, AI).
 *   R2  searchRecords: `q` is required (`400 query_required`). lookupRecords:
 *       exactly one of `phone` or `email` in the body; none or both is `400
 *       one_term_required` at `phone`, any other property `400
 *       unknown_property` at the FIXED path `body`, never echoing the
 *       client's key (review fix 2: a key can be an identifier).
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
 *   R5  Exact lookups are lookupRecords' body properties `phone` and
 *       `email`, each a WHOLE value compared for equality (phone normalised
 *       to E.164 with the tenant's default country; email trimmed,
 *       case-insensitive). A partial number is `400 invalid_phone`, never a
 *       prefix match: P27/A2's "0803 456 finds +234 803 456…" is overruled.
 *       They search contacts and leads only; the account and deal groups,
 *       when requested, are answered empty. lookupRecords writes nothing: a
 *       POST for privacy, not a mutation (200, never 201; not audited).
 *   R6  The matched fields are data, in `x-kasuwa-search-fields`: contact and
 *       lead `displayName`, `givenNames`, `familyName`, `companyName`;
 *       account `name`; deal `name`. Each is a property of that type's record
 *       schema, and the account and deal ones are never withheld.
 *   R7  Field security, per hit's own programme, row by row, tenant-admin
 *       flag never lifting it: a withheld field is never compared, never
 *       decides the choice or order of hits, is omitted and is named in
 *       `withheldFields`. A lookup on a withheld number or address answers
 *       as for a number nobody has. Neither operation ever answers `400
 *       field_withheld`: a withheld field just does not match.
 *   R8  D-L68, SETTLED FOR SEARCH: in a hit, `displayName` is readable
 *       exactly when BOTH `givenNames` and `familyName` are readable in the
 *       record's programme. Otherwise it is withheld: not matched, omitted,
 *       listed in `withheldFields` with the withheld part. It is never
 *       composed from, or replaced by, the readable part, and the rule holds
 *       when the withheld part is `null` on that record (withholding is not a
 *       statement about a value). getContact, listContacts and listLeads are
 *       NOT changed here; their alignment is the D-L68 follow-up (filed).
 *   R9  Readers per type are that type's own readers (`x-kasuwa-rights`,
 *       identical on both operations): contacts, leads and accounts every
 *       seeded set, the portal included; deals the five staff sets and the
 *       tenant-admin flag (D-L127), never `client_portal` (D-L115), never a
 *       custom set until a "read deals" grant exists. A type the caller does
 *       not read is an empty group, never an error.
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
 *       phone or an email, a lookup included; no owner, tag or amount
 *       anywhere. Each returned field has the record schema's own type and
 *       bound. Deal hit `name` is `pii` (D-L91).
 *   R15 Errors: `400`, `401` and `429` only, on both, never from any record
 *       (`429` added by the lead, D-L134, with T-0086's throttle).
 *       searchRecords' 400s come from the request alone; lookupRecords' from
 *       the request and the caller's own tenant settings (the default country
 *       `invalid_phone` normalises with; review fix 3). The 429 is
 *       `SearchTooManyRequests`, shared by both: the shared Error envelope,
 *       `too_many_requests`, an optional `retryAt`, the sign-in throttle's
 *       shape; per user, separate budgets, the lookup's tighter; it never
 *       echoes the query. `x-kasuwa-error-order` lists it first and then
 *       each detail code in the order decided (401 and the scope header
 *       precede all):
 *         both           429 too_many_requests, then:
 *         searchRecords  query_required, identifier_in_url (strictly after;
 *                        review fix 4), invalid_string, unknown_type,
 *                        query_too_short
 *         lookupRecords  unknown_property, one_term_required, invalid_phone,
 *                        invalid_email, unknown_type
 *       The shared Error schema; details carry a fixed path and a code only.
 *   R16 `Cache-Control: no-store` on every answer of both. searchRecords'
 *       query string is personal data (a name): telemetry keeps the route
 *       template only and ingress strips query strings from access logs
 *       (D-L80). lookupRecords' body is never logged or traced.
 *   R17 `types` is closed today (contact, lead, account, deal; unknown is
 *       `400 unknown_type`, a repeat is `400`) and additive tomorrow (D-L87):
 *       a client ignores a group type it does not know. The body's `types`
 *       has the same shape as the query parameter's.
 *   R18 "See all" is the type's own list with `q` (listContacts, listLeads,
 *       listAccounts). Deals have no cross-pipeline list, so no "see all"
 *       for deals. A list's `q` is substring, so it may show more. (T-0124,
 *       D-L180 I9, lead re-pin: a list's `q` no longer matches numbers.)
 *   R19 Examples use synthetic names only: every name-like value in the
 *       search examples contains Sample, Fixture, Example or Test.
 *   R20 Contract first: `x-kasuwa-implemented: false` on both operations
 *       until T-0086, which flips the two flag tests to `true` (D-L133).
 *   R21 THE URL NEVER CARRIES A PHONE NUMBER OR AN EMAIL ADDRESS (lead
 *       amendment; CLAUDE.md 6.1, D-L80). Neither search operation has a
 *       path, query, header or cookie parameter for one; lookupRecords has
 *       no parameter at all; searchRecords answers a `phone` or `email`
 *       query parameter with `400 identifier_in_url` rather than ignoring
 *       it, so the mistake is loud. No parameter anywhere in the file is
 *       named for a phone or an email. **`q` itself (review fix 1,
 *       strengthened by D-L135 from the T-0086 security review):** after
 *       NFKC, a `q` holding `@`, or a run of 6 or more decimal digits of any
 *       script (`\p{Nd}`) once every character that is neither a letter
 *       (`\p{L}`) nor a decimal digit is removed, is `400 identifier_in_url`
 *       at `q`, decided right after `query_required`. The old rule stripped
 *       only whitespace and `+()-.`, so `0803/123/4567`, `0803_123_4567`,
 *       `0803,123,4567`, an en dash and Arabic-Indic digits reached the URL.
 *       The `not` pattern on `q`'s schema is the same rule as an ECMA-262
 *       Unicode regex, `[@＠﹫]|\p{Nd}(?:[^\p{L}\p{Nd}]*\p{Nd}){5}`;
 *       only digits NFKC maps to ASCII (superscript, circled) need the
 *       server's NFKC step. Clients send phone- or email-shaped
 *       input to lookupRecords (T-0087 tests that). A name that itself holds
 *       such a run cannot be prefix-searched by it. (listContacts' and
 *       listLeads' `q` still accept a number in the URL: reported, not
 *       changed here. T-0124 brought them under this rule, D-L180 I9.)
 *   R22 The phone examples (`0803 000 0001`) are placeholders and say so:
 *       Nigeria has no fictional number range (review fix 5).
 *
 * ---------------------------------------------------------------------------
 *
 * D-L23: on main the file has no search operation. Every test then fails
 * naming the missing operation or schema rather than crashing at collection:
 * the spec is loaded lazily. Each negative invariant, and each self-check of a
 * helper, first requires both operations (`gate()`), so none passes on a file
 * without them.
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

const SEARCH = 'searchRecords';
const LOOKUP = 'lookupRecords';
const OP_IDS = [SEARCH, LOOKUP];
const SEARCH_PATH = '/api/v1/search';
const LOOKUP_PATH = '/api/v1/search/lookup';

/** Both search operations, or a failure naming the first missing: a gate for negative invariants. */
function gate(): Operation[] {
  return OP_IDS.map((id) => operation(id));
}

function search(): Operation {
  return operation(SEARCH);
}

function lookup(): Operation {
  return operation(LOOKUP);
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

function description(op: Operation): string {
  return prose(str(op.op.description));
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

function param(op: Operation, name: string): Mapping | undefined {
  return op.params.find((candidate) => candidate.name === name);
}

function paramSchema(op: Operation, name: string): Located {
  const parameter = param(op, name);
  if (!parameter) throw new Error(`${op.id} has no parameter ${name}`);
  return at(parameter.schema ?? {});
}

function bodyProperty(name: string): Located {
  const found = properties(schemaNamed('LookupRequest')).get(name);
  if (!found) throw new Error(`LookupRequest has no ${name}`);
  return found;
}

function propertyDescription(located: Located): string {
  return isMapping(located.node) ? prose(str(located.node.description)) : '';
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
const SCREENS: Record<string, string[]> = {
  [SEARCH]: ['P27/A1', 'P27/A4', 'P27/A5', 'P27/D1'],
  [LOOKUP]: ['P27/A2', 'P27/D1'],
};
const SEARCH_PARAMS = ['q', 'types'];
const BAD_REQUEST_DETAILS: Record<string, string[]> = {
  [SEARCH]: [
    'phone identifier_in_url',
    'q identifier_in_url',
    'q invalid_string',
    'q query_required',
    'q query_too_short',
    'types unknown_type',
  ],
  [LOOKUP]: [
    'body unknown_property',
    'email invalid_email',
    'phone invalid_phone',
    'phone one_term_required',
    'types unknown_type',
  ],
};
/** R15: each detail code, in the order decided (review fix 4: query_required strictly first). */
const ERROR_ORDER: Record<string, string[]> = {
  [SEARCH]: [
    '429 too_many_requests',
    '400 validation_failed query_required',
    '400 validation_failed identifier_in_url',
    '400 validation_failed invalid_string',
    '400 validation_failed unknown_type',
    '400 validation_failed query_too_short',
  ],
  [LOOKUP]: [
    '429 too_many_requests',
    '400 validation_failed unknown_property',
    '400 validation_failed one_term_required',
    '400 validation_failed invalid_phone',
    '400 validation_failed invalid_email',
    '400 validation_failed unknown_type',
  ],
};
/** R21 (review fix 1, D-L135): the identifier rule as the schema's `not` pattern, an ECMA-262 `u` regex. */
// The full-width and small commercial at are written literally in the YAML (U+FF20, U+FE6B).
const IDENTIFIER_Q_PATTERN = '[@＠﹫]|\\p{Nd}(?:[^\\p{L}\\p{Nd}]*\\p{Nd}){5}';
/**
 * The whole rule as the prose states it (D-L135): NFKC, then `@`, or 6+
 * decimal digits of any script once everything that is neither a letter nor
 * a decimal digit is removed.
 */
function looksLikeIdentifier(q: string): boolean {
  const text = q.normalize('NFKC');
  return text.includes('@') || /\p{Nd}{6,}/u.test(text.replace(/[^\p{L}\p{Nd}]/gu, ''));
}
/** Two weakened rules the self-check proves the cases catch (D-L135). */
const WEAKER_RULES: [string, (q: string) => boolean][] = [
  [
    'ASCII digits only',
    (q) => {
      const text = q.normalize('NFKC');
      return text.includes('@') || /[0-9]{6,}/.test(text.replace(/[^\p{L}\p{Nd}]/gu, ''));
    },
  ],
  [
    'punctuation-only stripping (the pre-D-L135 rule)',
    (q) => {
      const text = q.normalize('NFKC');
      return text.includes('@') || /[0-9]{6,}/.test(text.replace(/[\s+().-]/gu, ''));
    },
  ],
];
/** Pasted identifiers the rule must refuse; each is synthetic or a placeholder. */
const IDENTIFIER_QS = [
  '08031234567',
  '+2348031234567',
  '+234 803 123 4567',
  '0803 123 4567',
  '(0803) 123-4567',
  '0803.123.4567',
  '234-803-123-4567',
  '123456',
  'Sample 080312',
  'sample@example.test',
  'a@b',
  '@sample',
  // D-L135: separators the pre-D-L135 rule did not strip, and digits of another script.
  '0803/123/4567',
  '0803_123_4567',
  '0803,123,4567',
  '0803–123–4567',
  '٠٨٠٣١٢٣٤٥٦٧',
  'Sample\t080 312 45',
];
/** Digits NFKC maps to ASCII but which are not `\p{Nd}`: refused by the server's NFKC step, missed by the pattern. */
const NFKC_ONLY_QS = ['Sample ¹²³⁴⁵⁶', '①②③④⑤⑥'];
/** The identifiers D-L135 added: each slipped past the pre-D-L135 rule. */
const D_L135_QS = [
  '0803/123/4567',
  '0803_123_4567',
  '0803,123,4567',
  '0803–123–4567',
  '٠٨٠٣١٢٣٤٥٦٧',
];
/** Names the rule must let through. */
const NAME_QS = ['Sample', 'Sámple Fixture', 'Sample 2026', 'Unit 12 Block 3456', 'Sample 12345', '50% Sample', 'Sample (Lagos) Ltd', 'Fixture-12.34'];
/** Full-width forms: refused by the rule after NFKC, and by the pattern too (full-width digits are `\p{Nd}`). */
const FULL_WIDTH_QS = ['０８０３１２３４５６７', 'sample＠example.test'];
const EXAMPLE_LABELS: Record<string, string[]> = {
  [SEARCH]: ['portal', 'prefix', 'withheldNamePart'],
  [LOOKUP]: ['leadsOnly', 'phoneLookup'],
};
const REQUEST_LABELS = ['email', 'phone', 'phoneNarrowed'];
/** Keys that would be a count, a page or a hint of more, at any depth of the answer (R12). */
const COUNT_KEY = /count|total|more|estimate|hidden|cursor|page|offset|limit|next|facet/i;
/** Keys a hit must never carry (R14). */
const FORBIDDEN_HIT_KEY =
  /phone|email|owner|amount|stage|tag|dnd|consent|nin|bvn|score|rank|highlight|snippet/i;
/** R21: a parameter named for a phone number or an email address. */
const IDENTIFIER_PARAM = /phone|email|e164|msisdn|mobile|mail/i;
/** R19: a synthetic name carries one of these tokens once folded. */
const SYNTHETIC = /sample|fixture|example|test/;
const NAME_LIKE = new Set([...NAME_FIELDS, 'name']);

// ---------------------------------------------------------------------------
// Example readers
// ---------------------------------------------------------------------------

function okExamples(op: Operation): [string, Mapping][] {
  return examplesOf(jsonMedia(responses(op).get('200'))).filter(
    (entry): entry is [string, Mapping] => isMapping(entry[1]),
  );
}

/** Every 200 example of both operations, labelled with the operation. */
function allOkExamples(): [string, Mapping][] {
  return gate().flatMap((op) =>
    okExamples(op).map(([label, value]): [string, Mapping] => [`${op.id} ${label}`, value]),
  );
}

function okExample(op: Operation, label: string): Mapping {
  const found = okExamples(op).find(([name]) => name === label);
  if (!found) throw new Error(`${op.id} 200 has no example ${label}`);
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
      problems.push(
        `${label}: ${field} is ${present ? 'both sent and listed' : 'neither sent nor listed'}`,
      );
  }
  return problems;
}

/** R5: what the exact-lookup prose fails to say; empty when it says it all. */
function exactLookupProblems(opText: string, phoneText: string, emailText: string): string[] {
  const problems: string[] = [];
  const op = prose(opText);
  if (!/compared for equality with each stored E\.164 number/.test(op))
    problems.push('phone is not compared for equality');
  if (
    !/a partial number included, is `400 validation_failed` with `details\[\]\.code: invalid_phone` at `phone`/.test(
      op,
    )
  )
    problems.push('a partial number is not invalid_phone');
  if (!/\*\*never a prefix or substring of a number\.\*\*/.test(op))
    problems.push('phone may be a prefix or substring');
  if (!/`email` is a whole address, trimmed and compared for equality case-insensitively/.test(op))
    problems.push('email is not a whole address compared for equality');
  if (
    !/Contacts and leads only: the account and deal groups, when requested, are answered empty/.test(
      op,
    )
  )
    problems.push('lookups are not limited to contacts and leads');
  if (!/Never a prefix or a substring/.test(prose(phoneText))) problems.push('phone property');
  if (!/Never a prefix or a substring/.test(prose(emailText))) problems.push('email property');
  if (/(?<!never a )(?<!Never a )prefix of (a|the) number(?! )/.test(op))
    problems.push('the prose offers a number prefix');
  return problems;
}

/** R5/R21: what lookupRecords' prose fails to say about being a read; empty when right. */
function readOnlyPostProblems(opText: string): string[] {
  const op = prose(opText);
  const problems: string[] = [];
  if (!/\*\*A POST used for privacy, not a mutation: it writes nothing\.\*\*/.test(op))
    problems.push('not "a POST used for privacy, not a mutation: it writes nothing"');
  if (!/It creates, changes and audits nothing, it is safe to retry, and it answers `200`, never `201`/.test(op))
    problems.push('may create, change or audit, or answer 201');
  if (!/\*\*the URL never carries a phone number or an email address\*\*/.test(op))
    problems.push('no URL rule');
  if (/\b(creates|records|stores|saves) (a|the) (search|lookup|history)/i.test(op))
    problems.push('the lookup stores something');
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

const SEARCH_STEPS = [
  'authentication (`401`) and the scope-header `400` first',
  'then the per-user throttle (`429 too_many_requests`)',
  'then `q` present (`query_required`)',
  'then no identifier in the URL, in a `phone` or `email` parameter or in `q` itself (`identifier_in_url`)',
  "then each parameter's own shape",
  '`invalid_string`, then `types` values as `unknown_type`',
  'then the length, as sent or once folded (`query_too_short`)',
];
const LOOKUP_STEPS = [
  'authentication (`401`) and the scope-header `400` first',
  'then the per-user throttle (`429 too_many_requests`)',
  'then the body as a closed JSON object (`unknown_property`)',
  'then the one-identifier rule (`one_term_required`)',
  "then each property's own shape",
  '`invalid_phone`, `email` format as `invalid_email`, then `types` values as `unknown_type`',
];
/** What each operation's 400s may be decided from (review fix 3). */
const SEARCH_BASIS =
  /Every `400` is decided from the request alone, before any record is read, so no `400` depends on what exists/;
const LOOKUP_BASIS =
  /Every `400` is decided from the request and the caller's own tenant settings \(the default country `invalid_phone` normalises with\), never from any record, so no `400` depends on what exists/;

/** Values a throttle body must never carry: the search and lookup examples' query values (R15, D-L134). */
const QUERY_VALUES = ['sam', 'Sam', '0803 000 0001', '+2348030000001', 'sample.fixture@example.test'];
/** The keys a throttle body may carry: the sign-in throttle's envelope, less its cell time zone. */
const THROTTLE_KEYS = ['code', 'error', 'message', 'retryAt', 'statusCode'];

/**
 * R15 (D-L134): what the shared 429 gets wrong; empty when right. `node` is
 * the response object, `auth` the sign-in throttle's (`TooManyAttempts`).
 */
function throttleProblems(node: unknown, auth: Located | undefined): string[] {
  if (!isMapping(node)) return ['no 429 response'];
  const problems: string[] = [];
  const text = prose(str(node.description));
  for (const [label, rule] of [
    ['per user', /\*\*per user\*\*, never per address/],
    ['separate budgets', /Each operation has its \*\*own budget\*\*: exhausting one leaves the other open/],
    ['the lookup tighter', /the lookup's budget is \*\*tighter\*\*/],
    ['after authentication, before validation', /decided after authentication and the scope-header check and before any validation/],
    ['never echoes the query', /\*\*The body never echoes the query\*\*: no `q`, no phone number, no address/],
    ['the sign-in shape', /Same shape as the sign-in throttle \(`TooManyAttempts`/],
  ] as const) {
    if (!rule.test(text)) problems.push(`description: ${label}`);
  }
  const examples = examplesOf(jsonMedia(at(node)))
    .map(([, value]) => value)
    .filter(isMapping);
  if (examples.length === 0) problems.push('no example');
  const authExample = examplesOf(jsonMedia(auth))
    .map(([, value]) => value)
    .filter(isMapping)[0];
  if (!authExample) problems.push('no sign-in throttle example to compare with');
  for (const body of examples) {
    if (body.statusCode !== 429) problems.push(`statusCode ${String(body.statusCode)}`);
    if (body.code !== 'too_many_requests') problems.push(`code ${String(body.code)}`);
    if (body.error !== 'Too Many Requests') problems.push(`error ${String(body.error)}`);
    if (typeof body.message !== 'string' || body.message === '') problems.push('no message');
    if (body.retryAt !== undefined && !UTC_DATE_TIME.test(str(body.retryAt)))
      problems.push('retryAt is not a UTC date-time');
    for (const key of Object.keys(body)) {
      if (!THROTTLE_KEYS.includes(key)) problems.push(`key ${key} is not the throttle's`);
      if (authExample && !(key in authExample)) problems.push(`key ${key} is not in the sign-in throttle's body`);
    }
    for (const value of stringsIn(body)) {
      if (QUERY_VALUES.some((query) => value.includes(query)) || looksLikeIdentifier(value.replace(/^\d{4}-\d{2}-\d{2}T.*Z$/, '')))
        problems.push(`the body echoes a query value: ${value}`);
    }
  }
  const media = jsonMedia(at(node));
  const schema = media ? child(media, 'schema') : undefined;
  if (!schema || !isMapping(schema.node) || !isMapping(schema.node.properties) || !('retryAt' in schema.node.properties))
    problems.push('the schema has no retryAt');
  return problems;
}

/** The order rule (R15) as prose; empty when it is all there. */
function errorOrderProblems(opText: string, steps: string[], basis: RegExp): string[] {
  const op = prose(opText);
  const problems: string[] = [];
  if (!basis.test(op)) problems.push('a 400 may depend on what exists');
  let from = op.indexOf('**Order**');
  if (from === -1) problems.push('no **Order**');
  for (const step of steps) {
    const found = op.indexOf(step, Math.max(from, 0));
    if (found === -1) problems.push(`step missing or out of order: ${step}`);
    else from = found;
  }
  if (
    !/A read, so there is never a `403`, and it names no record, so there is never a `404`/.test(op)
  )
    problems.push('403 or 404 not excluded');
  return problems;
}

/** R21: what searchRecords' prose and q schema fail to say about identifiers in q; empty when right. */
function identifierInQProblems(opText: string, qSchema: Located): string[] {
  const op = prose(opText);
  const problems: string[] = [];
  if (
    !/\*\*`q` itself is refused when it looks like an identifier:\*\* after Unicode NFKC normalisation, a `q` that contains `@`, or that contains a run of 6 or more decimal digits of any script \(`\\p\{Nd\}`\) once every character that is neither a letter \(`\\p\{L\}`\) nor a decimal digit is removed, is `400 validation_failed` with `details\[\]\.code: identifier_in_url` at `q` \(D-L135\)/.test(
      op,
    )
  )
    problems.push('the q identifier rule is not stated exactly');
  if (!/\*\*Clients send phone- or email-shaped input to lookupRecords,\*\* never to this operation/.test(op))
    problems.push('clients are not sent to lookupRecords');
  if (!/the server applies it after NFKC/.test(op)) problems.push('NFKC is not applied');
  const node = qSchema.node;
  const not = isMapping(node) && isMapping(node.not) ? node.not : undefined;
  if (!not || not.pattern !== IDENTIFIER_Q_PATTERN)
    problems.push(`q schema has no not pattern ${IDENTIFIER_Q_PATTERN}`);
  return problems;
}

/** R21: parameters on an operation that could carry a phone or an email in the URL. */
function identifierParams(op: Operation): string[] {
  return op.params
    .filter((parameter) => IDENTIFIER_PARAM.test(str(parameter.name)))
    .map((parameter) => `${op.id}: ${str(parameter.in)} ${str(parameter.name)}`);
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe('acceptance: records contract, global search (T-0085)', () => {
  describe('the operations (R1, R20)', () => {
    it('searchRecords is GET /api/v1/search, tag search, naming exactly the P27 frames it serves', () => {
      const op = search();
      expect(op.method).toBe('get');
      expect(op.path).toBe(SEARCH_PATH);
      expect(op.op.tags).toEqual(['search']);
      const screens = Array.isArray(op.op['x-kasuwa-screens'])
        ? op.op['x-kasuwa-screens'].map(str)
        : [];
      expect([...screens].sort()).toEqual([...(SCREENS[SEARCH] ?? [])].sort());
      expect(typeof op.op['x-kasuwa-implemented']).toBe('boolean');
      expect(op.op.requestBody, 'a GET takes no body').toBeUndefined();
    });

    it('lookupRecords is POST /api/v1/search/lookup, tag search, naming P27/A2 and D1', () => {
      const op = lookup();
      expect(op.method).toBe('post');
      expect(op.path).toBe(LOOKUP_PATH);
      expect(op.op.tags).toEqual(['search']);
      const screens = Array.isArray(op.op['x-kasuwa-screens'])
        ? op.op['x-kasuwa-screens'].map(str)
        : [];
      expect([...screens].sort()).toEqual([...(SCREENS[LOOKUP] ?? [])].sort());
      expect(typeof op.op['x-kasuwa-implemented']).toBe('boolean');
    });

    it('lookupRecords writes nothing: a POST for privacy, 200 never 201, not audited, no permission (R5)', () => {
      const op = lookup();
      expect(readOnlyPostProblems(str(op.op.description))).toEqual([]);
      expect(op.op['x-kasuwa-audited'], 'audited').not.toBe(true);
      expect(op.op['x-kasuwa-permission'], 'a write permission').toBeUndefined();
      expect([...responses(op).keys()].filter((status) => /^2/.test(status))).toEqual(['200']);
    });

    it('(self-check, R5) a lookup that writes, audits or answers 201 is caught', () => {
      const real = description(lookup());
      expect(readOnlyPostProblems(real)).toEqual([]);
      const planted: [string, string][] = [
        ['a mutation', real.replace('**A POST used for privacy, not a mutation: it writes nothing.**', '**A POST.**')],
        ['audited', real.replace('It creates, changes and audits nothing', 'It audits each lookup')],
        ['a 201', real.replace('answers `200`, never `201`', 'answers `201`')],
        ['stores history', `${real} It records a search history entry.`.replace('records a search history', 'records the search history')],
      ];
      for (const [label, text] of planted) {
        expect(text, `${label}: the plant changed nothing`).not.toBe(real);
        expect(readOnlyPostProblems(text).length, `${label} passed`).toBeGreaterThan(0);
      }
    });

    it('the search tag is declared, and nothing else searches under another path or id', () => {
      gate();
      const tags = (Array.isArray(spec().tags) ? spec().tags : []) as unknown[];
      expect(tags.filter(isMapping).map((tag) => str(tag.name))).toContain('search');
      const others = operations()
        .filter((op) => !OP_IDS.includes(op.id))
        .filter(
          (op) =>
            /search|lookup/i.test(op.id) ||
            /\/search(\/|$)/.test(op.path) ||
            /\/lookup(\/|$)/.test(op.path),
        )
        .map((op) => `${op.method.toUpperCase()} ${op.path} (${op.id})`);
      expect(others).toEqual([]);
      expect(operations().filter((op) => op.path === SEARCH_PATH).length, 'one method').toBe(1);
      expect(operations().filter((op) => op.path === LOOKUP_PATH).length, 'one method').toBe(1);
    });

    // Lead edit for T-0086 (D-L133, as T-0105's): both routes are served from T-0086, so both
    // flags are true. T-0086's own suite (records/search-api) pins the same with the routes.
    it('the flag: searchRecords is x-kasuwa-implemented: true, served since T-0086', () => {
      expect(search().op['x-kasuwa-implemented'], 'T-0086 sets it to true with the route').toBe(
        true,
      );
    });

    it('the flag: lookupRecords is x-kasuwa-implemented: true, served since T-0086', () => {
      expect(lookup().op['x-kasuwa-implemented'], 'T-0086 sets it to true with the route').toBe(
        true,
      );
    });
  });

  describe('the URL never carries a phone number or an email address (R21)', () => {
    it('neither search operation has a parameter for one; lookupRecords has no parameter at all', () => {
      const offending = gate().flatMap(identifierParams);
      expect(offending).toEqual([]);
      expect(lookup().params.map((parameter) => str(parameter.name))).toEqual([]);
    });

    it('no parameter anywhere in the file is named for a phone or an email', () => {
      gate(); // Not vacuous: the file has dozens of parameters, counted below.
      const all = operations();
      expect(all.flatMap(identifierParams)).toEqual([]);
      expect(all.reduce((sum, op) => sum + op.params.length, 0)).toBeGreaterThan(40);
    });

    it('(self-check, R21) a phone or email parameter planted on either operation is caught', () => {
      for (const op of gate()) {
        expect(identifierParams(op)).toEqual([]);
        for (const name of ['phone', 'email', 'msisdn', 'phoneE164']) {
          const planted: Operation = { ...op, params: [...op.params, { name, in: 'query' }] };
          expect(identifierParams(planted).length, `${op.id} ${name}`).toBe(1);
        }
      }
    });

    it('searchRecords refuses a phone or email query parameter loudly, identifier_in_url, never ignoring it', () => {
      const text = description(search());
      expect(text).toMatch(
        /\*\*The URL never carries a phone number or an email address\.\*\* Whole identifiers in a query string reach proxy and access logs \(CLAUDE\.md 6\.1, D-L80\), so exact lookups are lookupRecords, a POST with a JSON body/,
      );
      expect(text).toMatch(
        /A `phone` or `email` query parameter here is not ignored: it is `400 validation_failed` with `details\[\]\.code: identifier_in_url` at that parameter/,
      );
      expect(description(lookup())).toMatch(
        /searchRecords refuses them in its query string, `q` included, so a client sends any phone- or email-shaped input here/,
      );
    });

    it('q that looks like a phone number or an email address is 400 identifier_in_url at q, stated exactly and as the schema’s not pattern (review fix 1)', () => {
      expect(
        identifierInQProblems(str(search().op.description), paramSchema(search(), 'q')),
      ).toEqual([]);
      expect(prose(str(param(search(), 'q')?.description))).toMatch(
        /Never a phone number or an email address: an `@`, or a run of 6 or more decimal digits of any script once everything that is neither a letter nor a digit is removed \(after NFKC\), is `400 identifier_in_url`; send those to lookupRecords/,
      );
    });

    it('the q schema refuses every pasted identifier and accepts every name in the cases (R21)', () => {
      const schema = paramSchema(search(), 'q');
      const leaked = IDENTIFIER_QS.filter((value) => validate(schema, value, 'q').length === 0);
      expect(leaked, 'identifiers the schema lets into the URL').toEqual([]);
      const refused = NAME_QS.filter((value) => validate(schema, value, 'q').length > 0);
      expect(refused, 'names the schema refuses').toEqual([]);
    });

    it('the stated rule (NFKC first) agrees with the schema on every case, full-width forms included; only NFKC-mapped digits need the server (D-L135)', () => {
      gate();
      for (const value of IDENTIFIER_QS) expect(looksLikeIdentifier(value), value).toBe(true);
      for (const value of NAME_QS) expect(looksLikeIdentifier(value), value).toBe(false);
      const pattern = new RegExp(IDENTIFIER_Q_PATTERN, 'u');
      for (const value of [...IDENTIFIER_QS, ...NAME_QS, ...FULL_WIDTH_QS]) {
        expect(pattern.test(value), `pattern and rule disagree on ${value}`).toBe(
          looksLikeIdentifier(value),
        );
      }
      for (const value of NFKC_ONLY_QS) {
        expect(looksLikeIdentifier(value), `${value} after NFKC`).toBe(true);
        expect(pattern.test(value), `${value} is why the server applies NFKC first`).toBe(false);
      }
      // The three names D-L135 names stay searchable.
      for (const value of ['Sample 2026', 'Unit 12 Block 3456', 'Fixture-12.34']) {
        expect(NAME_QS, value).toContain(value);
      }
    });

    it('(self-check, D-L135) a weakened rule is caught by the cases: ASCII-only digits, or punctuation-only stripping', () => {
      for (const value of D_L135_QS) expect(IDENTIFIER_QS, value).toContain(value);
      for (const [label, weaker] of WEAKER_RULES) {
        const leaked = D_L135_QS.filter((value) => !weaker(value));
        expect(leaked.length, `${label} catches every D-L135 case`).toBeGreaterThan(0);
        // ...while still agreeing on the names, so it is the identifiers that expose it.
        for (const value of NAME_QS) expect(weaker(value), `${label} on ${value}`).toBe(false);
      }
      expect(
        WEAKER_RULES.find(([label]) => label === 'ASCII digits only')?.[1](
          '٠٨٠٣١٢٣٤٥٦٧',
        ),
        'ASCII-only digits let Arabic-Indic digits through',
      ).toBe(false);
    });

    it('(self-check, R21) a looser q rule is caught: no not pattern, a weaker pattern, or the prose softened', () => {
      const text = str(search().op.description);
      const schema = paramSchema(search(), 'q');
      expect(identifierInQProblems(text, schema)).toEqual([]);
      const node = isMapping(schema.node) ? schema.node : {};
      const withPattern = (pattern: string | undefined): Located => ({
        node: pattern === undefined ? { ...node, not: undefined } : { ...node, not: { pattern } },
        file: schema.file,
      });
      const weaker: [string, Located][] = [
        ['no not', withPattern(undefined)],
        ['seven digits', withPattern('[@\\uFF20\\uFE6B]|\\p{Nd}(?:[^\\p{L}\\p{Nd}]*\\p{Nd}){6}')],
        ['contiguous only', withPattern('[@\\uFF20\\uFE6B]|\\p{Nd}{6}')],
        ['no @', withPattern('\\p{Nd}(?:[^\\p{L}\\p{Nd}]*\\p{Nd}){5}')],
        ['ASCII digits only (D-L135)', withPattern('[@\\uFF20\\uFE6B]|[0-9](?:[^\\p{L}\\p{Nd}]*[0-9]){5}')],
        ['punctuation-only stripping (pre-D-L135)', withPattern('@|[0-9](?:[\\s+().-]*[0-9]){5}')],
      ];
      for (const [label, planted] of weaker) {
        expect(identifierInQProblems(text, planted).length, `${label} passed the rule`).toBeGreaterThan(0);
      }
      // The schema-level effect: each weaker pattern lets a pasted identifier through.
      for (const [label, planted] of weaker) {
        const leaked = IDENTIFIER_QS.filter((value) => validate(planted, value, 'q').length === 0);
        expect(leaked.length, `${label} leaks nothing`).toBeGreaterThan(0);
      }
      const softened: [string, string][] = [
        ['no NFKC', prose(text).replace('after Unicode NFKC normalisation, ', '')],
        ['8 digits', prose(text).replace('a run of 6 or more decimal digits', 'a run of 8 or more decimal digits')],
        [
          'ASCII digits only',
          prose(text).replace('decimal digits of any script (`\\p{Nd}`)', 'ASCII digits'),
        ],
        ['clients not told', prose(text).replace('**Clients send phone- or email-shaped input to lookupRecords,**', 'Clients may send anything,')],
      ];
      for (const [label, planted] of softened) {
        expect(planted, `${label}: the plant changed nothing`).not.toBe(prose(text));
        expect(identifierInQProblems(planted, schema).length, `${label} passed`).toBeGreaterThan(0);
      }
    });
  });

  describe('parameters, body and scope (R2, R4, R5, R11, R17)', () => {
    it('searchRecords takes exactly q (required) and types (optional), both query parameters', () => {
      const op = search();
      expect(op.params.map((parameter) => str(parameter.name)).sort()).toEqual(SEARCH_PARAMS);
      for (const parameter of op.params) expect(parameter.in, str(parameter.name)).toBe('query');
      expect(param(op, 'q')?.required, 'q is required').toBe(true);
      expect(param(op, 'types')?.required, 'types is optional').not.toBe(true);
    });

    it('no paging, sorting, limit, programme, tenant, scope, owner or date parameter; no header, cookie or auth opt-out (rule 1, R11)', () => {
      const offending: string[] = [];
      for (const op of gate()) {
        offending.push(
          ...op.params
            .map((parameter) => str(parameter.name))
            .filter((name) =>
              /cursor|limit|offset|page|sort|programme|tenant|scope|business|owner|date|from|to$/i.test(
                name,
              ),
            )
            .map((name) => `${op.id}: ${name}`),
        );
        offending.push(
          ...op.params
            .filter((p) => p.in === 'header' || p.in === 'cookie')
            .map((p) => `${op.id}: ${str(p.in)}`),
        );
        if (op.op.security !== undefined) offending.push(`${op.id}: overrides security`);
      }
      expect(offending).toEqual([]);
    });

    it('searchRecords: q is required, 400 query_required without it (R2)', () => {
      expect(description(search())).toMatch(
        /\*\*`q` is required\.\*\* A request without `q` is `400 validation_failed` with `details\[\]\.code: query_required` at `q`/,
      );
    });

    it('q is 2..100 as sent, at least 2 once folded, and refuses a control character (R4)', () => {
      const schema = paramSchema(search(), 'q');
      const node = schema.node;
      expect(isMapping(node) ? [node.type, node.minLength, node.maxLength] : []).toEqual([
        'string',
        2,
        100,
      ]);
      expect(validate(schema, 'sa', 'q')).toEqual([]);
      expect(validate(schema, 's', 'q').length, 'one character accepted').toBeGreaterThan(0);
      expect(validate(schema, 'x'.repeat(101), 'q').length, '101 accepted').toBeGreaterThan(0);
      expect(description(search())).toMatch(
        /\*\*The folded query must be at least 2 characters\*\*, else `400 validation_failed` with `details\[\]\.code: query_too_short` at `q`/,
      );
      expect(prose(str(param(search(), 'q')?.description))).toMatch(
        /A NUL or other control character is `400 validation_failed` with `details\[\]\.code: invalid_string`/,
      );
    });

    it('lookupRecords takes a required, closed LookupRequest: phone, email and types, nothing else', () => {
      const body = requestBody(lookup());
      expect(isMapping(body?.node) ? body.node.required : undefined, 'body required').toBe(true);
      const schema = jsonSchema(body);
      expect(schema?.node).toBe(schemaNamed('LookupRequest').node);
      const request = schemaNamed('LookupRequest');
      expect(isClosed(request)).toBe(true);
      expect(keysOf(request)).toEqual(['email', 'phone', 'types']);
    });

    it('LookupRequest holds exactly one of phone or email; none, both or anything else is refused (R2)', () => {
      const request = schemaNamed('LookupRequest');
      for (const good of [
        { phone: '0803 123 4567' },
        { email: 'sample@example.test' },
        { phone: '+2348031234567', types: ['contact', 'lead'] },
      ]) {
        expect(validate(request, good, 'body'), JSON.stringify(good)).toEqual([]);
      }
      for (const [label, bad] of [
        ['empty', {}],
        ['both', { phone: '+2348031234567', email: 'sample@example.test' }],
        ['types only', { types: ['contact'] }],
        ['a q', { q: 'sam' }],
        ['a q beside a phone', { phone: '+2348031234567', q: 'sam' }],
        ['a ticket type', { phone: '+2348031234567', types: ['ticket'] }],
        ['a null phone', { phone: null }],
      ] as const) {
        expect(validate(request, bad, 'body').length, `accepted ${label}`).toBeGreaterThan(0);
      }
      const text = description(lookup());
      expect(text).toMatch(
        /The closed JSON body carries exactly one of `phone` or `email`, plus optional `types`\. None, or both, is `400 validation_failed` with `details\[\]\.code: one_term_required` at `phone`\. Any other property is `400 validation_failed` with `details\[\]\.code: unknown_property` at the fixed path `body`/,
      );
    });

    it('phone is one whole number in common formats, bounded; email a bounded address (R5)', () => {
      const phone = bodyProperty('phone');
      for (const good of [
        '0803 123 4567',
        '+234 803 123 4567',
        '2348031234567',
        '(0803) 123-4567',
      ]) {
        expect(validate(phone, good, 'phone'), good).toEqual([]);
      }
      for (const bad of [
        'sample',
        '0803%',
        '080*1234',
        '080',
        '+',
        '0'.repeat(33),
        '0803\u0000123',
      ]) {
        expect(validate(phone, bad, 'phone').length, `phone accepted ${bad}`).toBeGreaterThan(0);
      }
      const email = bodyProperty('email');
      const node = email.node;
      expect(
        isMapping(node) ? [node.type, node.format, node.minLength, node.maxLength] : [],
      ).toEqual(['string', 'email', 3, 254]);
      expect(validate(email, 'sample@example.test', 'email')).toEqual([]);
      expect(validate(email, 'sample', 'email').length).toBeGreaterThan(0);
    });

    it('lookups compare whole values, never a prefix or substring, on contacts and leads only (R5)', () => {
      const problems = exactLookupProblems(
        description(lookup()),
        propertyDescription(bodyProperty('phone')),
        propertyDescription(bodyProperty('email')),
      );
      expect(problems).toEqual([]);
      expect(lookup().op['x-kasuwa-exact-fields']).toEqual(EXACT_FIELDS);
      expect(search().op['x-kasuwa-exact-fields'], 'the GET matches no identifier').toBeUndefined();
      const contact = properties(schemaNamed('Contact'));
      for (const field of ['phones', 'emails']) expect(contact.has(field), field).toBe(true);
    });

    it('(self-check, R5) a lookup that turns into a prefix or substring match is caught', () => {
      const real: [string, string, string] = [
        description(lookup()),
        propertyDescription(bodyProperty('phone')),
        propertyDescription(bodyProperty('email')),
      ];
      expect(exactLookupProblems(...real), 'the real prose').toEqual([]);
      const planted: [string, [string, string, string]][] = [
        [
          'a prefix',
          [
            real[0].replace(
              '**never a prefix or substring of a number.**',
              'a prefix of the number also matches.',
            ),
            real[1],
            real[2],
          ],
        ],
        [
          'equality dropped',
          [
            real[0].replace(
              'compared for equality with each stored E.164 number',
              'matched against each stored number',
            ),
            real[1],
            real[2],
          ],
        ],
        [
          'a partial number allowed',
          [real[0].replace('a partial number included, ', ''), real[1], real[2]],
        ],
        [
          'email substring',
          [real[0], real[1], real[2].replace('Never a prefix or a substring.', 'Or any part of one.')],
        ],
        [
          'accounts searched',
          [real[0].replace('Contacts and leads only', 'Every type'), real[1], real[2]],
        ],
      ];
      for (const [label, texts] of planted) {
        expect(texts.join('|'), `${label}: the plant changed nothing`).not.toBe(real.join('|'));
        expect(exactLookupProblems(...texts).length, `${label} passed`).toBeGreaterThan(0);
      }
    });

    it('types is 1..4 unique SearchType values: contact, lead, account, deal; unknown is unknown_type; additive; the same in the body (R17)', () => {
      const parameter = param(search(), 'types');
      expect([parameter?.style, parameter?.explode]).toEqual(['form', true]);
      const query = paramSchema(search(), 'types');
      const body = bodyProperty('types');
      for (const [where, schema] of [
        ['query', query],
        ['body', body],
      ] as const) {
        expect(enumOf(schema).map(str), where).toEqual(TYPE_ORDER);
        expect(validate(schema, TYPE_ORDER, 'types'), where).toEqual([]);
        for (const [label, bad] of [
          ['empty', []],
          ['a ticket', ['ticket']],
          ['a repeat', ['contact', 'contact']],
          ['five', [...TYPE_ORDER, 'contact']],
          ['a plural', ['contacts']],
        ] as const) {
          expect(
            validate(schema, bad, 'types').length,
            `${where} types accepted ${label}`,
          ).toBeGreaterThan(0);
        }
        const node = schema.node;
        expect(
          isMapping(node) ? [node.minItems, node.maxItems, node.uniqueItems] : [],
          where,
        ).toEqual([1, 4, true]);
      }
      const text = prose(str(parameter?.description));
      expect(text).toMatch(/`unknown_type` for an unknown one/);
      expect(text).toMatch(/additive \(D-L87\)/);
      expect(text).toMatch(/a client ignores a group whose `type` it does not know/);
      expect(schemaDescription('SearchType')).toMatch(/Additive \(D-L87\)/);
    });

    it('scope is the session’s: no parameter widens or narrows it, and nothing outside it is counted, shown or hinted (R11)', () => {
      const text = description(search());
      expect(text).toMatch(/\*\*Scope is the session's \(rule 1\)\.\*\*/);
      expect(text).toMatch(/There is no programme, tenant or scope parameter/);
      expect(text).toMatch(
        /unknown query parameters are ignored, never honoured, and a scope header is `400 validation_failed`/,
      );
      expect(text).toMatch(
        /\*\*Nothing outside that scope is counted, shown or hinted\*\* \(D-L87, CLAUDE\.md 6\.4\)/,
      );
      expect(text).toMatch(/P27\/B's "3 in programmes you are not on" is not served/);
      expect(text).toMatch(/a record in another programme or tenant changes nothing in any answer/);
      expect(description(lookup())).toMatch(
        /scope from the session only, nothing out of scope counted, shown or hinted/,
      );
    });
  });

  describe('matching: prefix on folded text (R3, R6)', () => {
    it('the prose states the folding, whole-field prefix, literal wildcards and no phone or email in q', () => {
      const text = description(search());
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
      expect(description(search())).toMatch(
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
      expect(search().op['x-kasuwa-search-fields']).toEqual(SEARCH_FIELDS);
      expect(lookup().op['x-kasuwa-search-fields'], 'the lookup matches no name').toBeUndefined();
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
      expect(schemaDescription('Account')).toMatch(
        /`id`, `programmeId`, `name`, `version`, `createdAt`, `updatedAt` and `withheldFields` are never withheld/,
      );
      expect(schemaDescription('Deal')).toMatch(
        /`id`, `programmeId`, `pipelineId`, `stageId`, `version`, `name`,/,
      );
      const withholdable = enumOf(schemaNamed('DealWithheldField')).map(str);
      expect(withholdable).not.toContain('name');
      expect(withholdable).not.toContain('pipelineId');
    });

    it('every hit of the prefix example matches q=sam on a field its type searches and the caller reads', () => {
      const answer = okExample(search(), 'prefix');
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
      const hits = hitsOf(okExample(search(), 'prefix'));
      expect(
        hits.some(
          ([, hit]) =>
            str(hit.displayName) !== fold(str(hit.displayName)) &&
            prefixMatches(hit.displayName, 'sam'),
        ),
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
      const text = description(search());
      for (const phrase of [
        /\*\*Field security: a hit never matches on, or returns, a withheld field\.\*\*/,
        /Each field is judged in the hit's OWN programme, against the permission set the caller holds there, row by row/,
        /the tenant-admin flag never lifts it \(D-L63\)/,
        /A field withheld there is never compared with the query, never decides which hits are chosen or their order, and is omitted from the hit and named in its `withheldFields`/,
        /Field security never makes this read answer `400 field_withheld`: a withheld field simply does not match/,
      ]) {
        expect(text).toMatch(phrase);
      }
      const details = gate().flatMap((op) =>
        exampleBodies(responses(op).get('400')).flatMap((body) =>
          list(body.details).map((detail) => str(detail.code)),
        ),
      );
      expect(details).not.toContain('field_withheld');
    });

    it('lookupRecords shares field security: a withheld number or address is never compared, the D-L68 rule holds (R7)', () => {
      const text = description(lookup());
      expect(text).toMatch(
        /field security per hit's own programme with the D-L68 `displayName` rule/,
      );
      expect(text).toMatch(
        /\*\*A number or address withheld in a record's programme is never compared:\*\* the lookup does not find that record, and the answer is the same as for a number nobody has/,
      );
      expect(text).toMatch(/Field security never answers `400 field_withheld`/);
      expect(text).toMatch(/a hit never carries the phone or address that found it/);
    });

    it('displayName follows its name parts: withheld, never composed, when either part is withheld (R8, D-L68)', () => {
      expect(
        displayNameRuleProblems(str(search().op.description), schemaDescription('ContactSearchHit')),
      ).toEqual([]);
      expect(schemaDescription('LeadSearchHit')).toMatch(
        /`displayName` follows its name parts exactly as on ContactSearchHit \(D-L68\)/,
      );
      expect(schemaDescription('SearchNameWithheldField')).toMatch(
        /`displayName` is listed whenever `givenNames` or `familyName` is \(D-L68\)/,
      );
      expect(description(search())).toMatch(
        /getContact, listContacts and listLeads are not changed by this operation \(their alignment is the D-L68 follow-up\)/,
      );
    });

    it('(self-check, R8) a looser displayName rule is caught', () => {
      const op = str(search().op.description);
      const hit = schemaDescription('ContactSearchHit');
      expect(displayNameRuleProblems(op, hit), 'the real prose').toEqual([]);
      const planted: [string, string, string][] = [
        ['either instead of both', op.replace(/exactly when\s+both/, 'exactly when either'), hit],
        [
          'composition allowed',
          op.replace(
            /It is never composed\s+from the readable part, and never replaced by one/,
            'It is composed from the readable part',
          ),
          hit,
        ],
        [
          'null exempt',
          op.replace(
            /The rule holds even when the withheld\s+part is `null` on that record/,
            'A null part does not count',
          ),
          hit,
        ],
        ['still matched', op.replace(/it is not matched,\s+it is omitted/, 'it is omitted'), hit],
        [
          'hit composes',
          op,
          hit.replace('withheld, never composed, when either is not', 'composed per caller'),
        ],
      ];
      for (const [label, opText, hitText] of planted) {
        expect(opText + hitText, `${label}: the plant changed nothing`).not.toBe(op + hit);
        expect(displayNameRuleProblems(opText, hitText).length, `${label} passed`).toBeGreaterThan(
          0,
        );
      }
    });

    it('every contact and lead hit in every example of both operations obeys the displayName rule and omits, never nulls (R7, R8)', () => {
      const problems: string[] = [];
      let checked = 0;
      for (const [label, answer] of allOkExamples()) {
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
      const [hit] = hitsOf(okExample(search(), 'withheldNamePart'));
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
      const [entry] = hitsOf(okExample(search(), 'withheldNamePart'));
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
      const text = description(search());
      expect(text).toMatch(
        /The lead group follows listLeads: a hit says the contact's `status` is a lead status, so when field security withholds `status` from the caller in any programme they reach, the lead group is answered empty, whatever matched/,
      );
      expect(text).toMatch(
        /A contact who is a lead may appear in both the contact group and the lead group; both carry the contact id/,
      );
      const status = properties(schemaNamed('LeadSearchHit')).get('status');
      expect(status ? enumOf(status).map(str) : []).toEqual(LEAD_STATUSES);
      const listLeads = operation('listLeads').params.find((p) => p.name === 'status');
      expect(enumOf(at(listLeads?.schema ?? {})).map(str), 'the same set as listLeads').toEqual(
        LEAD_STATUSES,
      );
    });
  });

  describe('readers per type (R9)', () => {
    for (const id of OP_IDS) {
      it(`${id}: x-kasuwa-rights: every set reads contacts, leads and accounts; deals the staff sets only`, () => {
        expect(rightsProblems(operation(id).op['x-kasuwa-rights'])).toEqual([]);
      });
    }

    it('the two operations carry identical rights', () => {
      expect(lookup().op['x-kasuwa-rights']).toEqual(search().op['x-kasuwa-rights']);
    });

    it('(self-check, R9) rights that let the portal read deals, or drop a type, are caught', () => {
      gate();
      const real = search().op['x-kasuwa-rights'];
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
      const text = description(search());
      for (const phrase of [
        /Each group is read by exactly the callers who read that type through its own read, in each programme the session resolves/,
        /contacts, leads and accounts by every set, the `client_portal` set included/,
        /deals by the `admin`, `programme_manager`, `team_lead`, `agent` and `qa_analyst` sets and the tenant-admin flag \(D-L127\), never by `client_portal` \(D-L115\) and never by a custom permission set until an explicit per-set "read deals" grant exists \(D-L127\)/,
        /the group is then answered as if nothing matched, never with an error/,
      ]) {
        expect(text).toMatch(phrase);
      }
      expect(description(lookup())).toMatch(
        /\*\*Shared with searchRecords, unchanged:\*\* who reads what \(`x-kasuwa-rights`, D-L127, D-L115\)/,
      );
    });

    it('the portal example answers its deal group empty', () => {
      const groups = groupsOf(okExample(search(), 'portal'));
      expect(groups.map((group) => str(group.type))).toEqual(['account', 'deal']);
      expect(list(groups.find((group) => group.type === 'deal')?.hits)).toEqual([]);
    });
  });

  describe('the answer: groups, at most three hits, no counts (R12, R13, R14)', () => {
    it('both operations answer the one SearchResults: closed, groups only, 1..4, each one of the four closed group schemas', () => {
      for (const op of gate()) {
        expect(responseSchema(op, '200').node, op.id).toBe(schemaNamed('SearchResults').node);
      }
      const results = schemaNamed('SearchResults');
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
      const variants =
        isMapping(items?.node) && Array.isArray(items.node.oneOf) ? items.node.oneOf : [];
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
          if (value)
            expect(isMapping(value.node) ? value.node.format : undefined, key).toBe('uuid');
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
            problems.push(
              `${type}.${key}: ${types(value).join('|')} vs ${types(source).join('|')}`,
            );
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
      gate();
      const name = properties(schemaNamed('DealSearchHit')).get('name');
      expect(isMapping(name?.node) ? name.node['x-kasuwa-classification'] : undefined).toBe('pii');
    });

    it('no count, total, more flag, cursor or facet at any depth of the answer (R12, D-P13)', () => {
      gate();
      expect(countKeys(schemaNamed('SearchResults'))).toEqual([]);
      expect(description(search())).toMatch(
        /\*\*No counts\*\* \(D-P13\): no total, no per-type or per-programme count, no "more" flag and no estimate/,
      );
      expect(description(lookup())).toMatch(/At most three hits per group, no counts \(D-P13\)/);
      expect(schemaDescription('SearchResults')).toMatch(/\*\*No counts of any kind\*\* \(D-P13\)/);
    });

    it('(self-check, R12) a count planted at the top or in a group is caught', () => {
      gate();
      const results = schemaNamed('SearchResults');
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
      const text = description(search());
      for (const phrase of [
        /`groups` holds one group per requested type, always in the order contact, lead, account, deal, each with at most three hits, `\[\]` when none/,
        /A record appears at most once in a group/,
        /Which three hits, and their order, are not part of the contract, except that the same data and query give the same answer and that neither ever depends on a withheld field/,
        /Contact and lead hits never carry a phone or an email/,
      ]) {
        expect(text).toMatch(phrase);
      }
    });

    it('every example of both: groups in the fixed order, each type once, hits typed as their group, no record twice in a group', () => {
      const problems: string[] = [];
      for (const [label, answer] of allOkExamples()) {
        const order = groupsOf(answer).map((group) => str(group.type));
        const ranks = order.map((type) => TYPE_ORDER.indexOf(type));
        if (
          ranks.some((rank) => rank < 0) ||
          ranks.some((rank, i) => i > 0 && rank <= (ranks[i - 1] ?? -1))
        )
          problems.push(`${label}: groups ${order.join(', ')}`);
        for (const group of groupsOf(answer)) {
          const ids = list(group.hits).map((hit) => str(hit.id));
          if (new Set(ids).size !== ids.length)
            problems.push(`${label} ${str(group.type)}: a record twice`);
          for (const hit of list(group.hits)) {
            if (hit.type !== group.type)
              problems.push(`${label}: a ${str(hit.type)} hit in ${str(group.type)}`);
          }
        }
      }
      expect(problems).toEqual([]);
      for (const op of gate()) {
        expect(
          okExamples(op)
            .map(([label]) => label)
            .sort(),
          op.id,
        ).toEqual([...(EXAMPLE_LABELS[op.id] ?? [])].sort());
      }
    });

    it('every lookup example answers only contacts and leads; any requested account or deal group is empty (R5)', () => {
      const problems: string[] = [];
      let groupsChecked = 0;
      for (const [label, answer] of okExamples(lookup())) {
        for (const group of groupsOf(answer)) {
          if (group.type !== 'account' && group.type !== 'deal') continue;
          groupsChecked += 1;
          if (list(group.hits).length > 0) problems.push(`${label}: ${str(group.type)} has hits`);
        }
      }
      expect(problems).toEqual([]);
      expect(groupsChecked, 'no example requests an account or deal group').toBeGreaterThan(0);
      const phone = groupsOf(okExample(lookup(), 'phoneLookup'));
      expect(phone.map((group) => str(group.type))).toEqual(TYPE_ORDER);
      expect(list(phone.find((group) => group.type === 'contact')?.hits).length).toBeGreaterThan(0);
      expect(description(lookup())).toMatch(
        /\*\*The answer is searchRecords' `SearchResults`\.\*\* Contacts and leads only/,
      );
    });

    it('"see all" is the type’s own list with q, none for deals, and a list may show more (R18)', () => {
      const text = description(search());
      expect(text).toMatch(
        /\*\*"See all" is the type's own list read with `q`\*\* \(listContacts, listLeads, listAccounts\)/,
      );
      expect(text).toMatch(
        /deals have no cross-pipeline list, so a deal hit opens the deal and there is no "see all" for deals/,
      );
      expect(text).toMatch(
        /A list's `q` is a substring match, so "see all" may show rows this read did not/,
      );
      expect(text, 'T-0124: a list q no longer matches numbers (D-L180 I9)').not.toMatch(
        /also matches numbers/,
      );
      for (const id of ['listContacts', 'listLeads', 'listAccounts']) {
        expect(operation(id).params.map((p) => str(p.name)), id).toContain('q');
      }
    });
  });

  describe('errors and their order (R15)', () => {
    for (const id of OP_IDS) {
      it(`${id}: documents exactly 200, 400, 401 and 429, and lists the throttle then every 400 detail code in the order decided`, () => {
        const op = operation(id);
        expect([...responses(op).keys()].sort()).toEqual(['200', '400', '401', '429']);
        expect(op.op['x-kasuwa-error-order']).toEqual(ERROR_ORDER[id]);
        // D-L134: the throttle is decided before any validation.
        expect((ERROR_ORDER[id] ?? [])[0]).toBe('429 too_many_requests');
        const codes = (ERROR_ORDER[id] ?? [])
          .filter((entry) => entry.startsWith('400 '))
          .map((entry) => entry.split(' ')[2]);
        const documented = BAD_REQUEST_DETAILS[id]?.map((entry) => entry.split(' ')[1]) ?? [];
        expect([...new Set(documented)].sort(), 'the order names exactly the documented codes').toEqual(
          [...codes].sort(),
        );
      });
    }

    it('query_required is decided strictly before identifier_in_url (review fix 4)', () => {
      const raw: unknown = search().op['x-kasuwa-error-order'];
      const order = Array.isArray(raw) ? raw.map(str) : [];
      const required = order.indexOf('400 validation_failed query_required');
      const identifier = order.indexOf('400 validation_failed identifier_in_url');
      expect(required, 'query_required listed').toBeGreaterThanOrEqual(0);
      expect(identifier, 'identifier_in_url strictly after query_required').toBe(required + 1);
    });

    it('every 400 is decided without reading a record, in the stated order; never 403 or 404 (review fix 3)', () => {
      expect(
        errorOrderProblems(str(search().op.description), SEARCH_STEPS, SEARCH_BASIS),
        SEARCH,
      ).toEqual([]);
      expect(
        errorOrderProblems(str(lookup().op.description), LOOKUP_STEPS, LOOKUP_BASIS),
        LOOKUP,
      ).toEqual([]);
      const basis: [Operation, string, RegExp][] = [
        [
          search(),
          'SearchValidationFailed',
          /Decided from the request alone, before any record is read: no `400` here depends on what exists/,
        ],
        [
          lookup(),
          'LookupValidationFailed',
          /Decided from the request and the caller's own tenant settings, never from any record: no `400` here depends on what exists/,
        ],
      ];
      for (const [op, name, rule] of basis) {
        const bad = responses(op).get('400');
        expect(bad?.node, op.id).toBe(at({ $ref: `#/components/responses/${name}` }).node);
        expect(prose(isMapping(bad?.node) ? str(bad.node.description) : ''), op.id).toMatch(rule);
      }
      expect(description(lookup()), 'the lookup no longer claims "the request alone"').not.toMatch(
        /request alone/,
      );
    });

    it('unknown_property sits at the fixed path body and never echoes the client’s key (review fix 2)', () => {
      expect(description(lookup())).toMatch(
        /`details\[\]\.code: unknown_property` at the fixed path `body`: the client's key is never echoed/,
      );
      const paths = exampleBodies(responses(lookup()).get('400'))
        .flatMap((body) => list(body.details))
        .filter((detail) => detail.code === 'unknown_property')
        .map((detail) => str(detail.path));
      expect(paths).toEqual(['body']);
      const lookupKeys = keysOf(schemaNamed('LookupRequest'));
      const allPaths = exampleBodies(responses(lookup()).get('400'))
        .flatMap((body) => list(body.details))
        .map((detail) => str(detail.path));
      expect(
        allPaths.filter((path) => path !== 'body' && !lookupKeys.includes(path)),
        'a 400 path that is neither body nor a LookupRequest property',
      ).toEqual([]);
    });

    it('(self-check, R15) a reordered or data-dependent error rule is caught', () => {
      // Collapsed first, so a plant is not defeated by where the YAML wraps a line.
      const real = description(search());
      expect(errorOrderProblems(real, SEARCH_STEPS, SEARCH_BASIS)).toEqual([]);
      const planted: [string, string][] = [
        [
          'data-dependent',
          real.replace(
            /before any record is read, so no `400` depends on what exists/,
            'after the scoped read',
          ),
        ],
        [
          'identifier before required',
          real.replace(
            /then `q` present \(`query_required`\); then no identifier in the URL, in a `phone` or `email` parameter or in `q` itself \(`identifier_in_url`\)/,
            'then no identifier in the URL, in a `phone` or `email` parameter or in `q` itself (`identifier_in_url`); then `q` present (`query_required`)',
          ),
        ],
        ['a 404', real.replace(/so there is never a `404`/, 'so a missing record is `404`')],
      ];
      for (const [label, text] of planted) {
        expect(text, `${label}: the plant changed nothing`).not.toBe(real);
        expect(
          errorOrderProblems(text, SEARCH_STEPS, SEARCH_BASIS).length,
          `${label} passed`,
        ).toBeGreaterThan(0);
      }
      const lookupReal = description(lookup());
      expect(errorOrderProblems(lookupReal, LOOKUP_STEPS, LOOKUP_BASIS)).toEqual([]);
      const alone = lookupReal.replace(
        "decided from the request and the caller's own tenant settings (the default country `invalid_phone` normalises with), never from any record",
        'decided from the request alone, before any record is read',
      );
      expect(alone, 'the basis plant changed nothing').not.toBe(lookupReal);
      expect(
        errorOrderProblems(alone, LOOKUP_STEPS, LOOKUP_BASIS).length,
        'the old "request alone" wording passed for the lookup',
      ).toBeGreaterThan(0);
      const swapped = lookupReal.replace(
        /then the body as a closed JSON object \(`unknown_property`\); then the one-identifier rule \(`one_term_required`\)/,
        'then the one-identifier rule (`one_term_required`); then the body as a closed JSON object (`unknown_property`)',
      );
      expect(swapped, 'the lookup plant changed nothing').not.toBe(lookupReal);
      expect(
        errorOrderProblems(swapped, LOOKUP_STEPS, LOOKUP_BASIS).length,
        'lookup reorder passed',
      ).toBeGreaterThan(0);
    });

    for (const id of OP_IDS) {
      it(`${id}: the 400, 401 and 429 use the shared Error schema; the 400 examples carry exactly its reason codes, path and code only`, () => {
        const op = operation(id);
        const shared = jsonSchema(responses(operation('getContact')).get('404'));
        if (!shared) throw new Error('getContact 404 has no schema');
        for (const status of ['400', '401', '429']) {
          expect(jsonSchema(responses(op).get(status))?.node, status).toBe(shared.node);
        }
        const details: string[] = [];
        for (const body of exampleBodies(responses(op).get('400'))) {
          expect(body.code).toBe('validation_failed');
          expect(body.statusCode).toBe(400);
          for (const detail of list(body.details)) {
            expect(Object.keys(detail).sort(), 'a detail carries more than path and code').toEqual(
              ['code', 'path'],
            );
            details.push(`${str(detail.path)} ${str(detail.code)}`);
          }
        }
        expect([...details].sort()).toEqual(BAD_REQUEST_DETAILS[id]);
      });
    }

    it('every answer of both, errors included, is Cache-Control: no-store; the query string and the body are personal data (R16, D-L80)', () => {
      const problems: string[] = [];
      for (const op of gate()) {
        for (const [status, response] of responses(op)) {
          const schema = cacheControlSchema(response);
          const values = schema ? enumOf(schema) : [];
          if (JSON.stringify(values) !== JSON.stringify(['no-store']))
            problems.push(`${op.id} ${status}: ${schema ? JSON.stringify(values) : 'missing'}`);
        }
      }
      expect(problems).toEqual([]);
      const text = description(search());
      expect(text).toMatch(
        /carries `Cache-Control: no-store`: the URL is the same for every user of every tenant/,
      );
      expect(text).toMatch(
        /\*\*The query string is personal data\*\* \(a name\): request telemetry keeps the route template only, and ingress must strip query strings from access logs before the first deployed cell \(D-L80\)/,
      );
      expect(description(lookup())).toMatch(
        /The body is personal data: it is never logged or traced, and neither is the normalised number/,
      );
      expect(schemaDescription('LookupRequest')).toMatch(/Personal data: never logged or traced/);
    });

    const signInThrottle = (): Located =>
      at({ $ref: './auth.openapi.yaml#/components/responses/TooManyAttempts' });

    it('the 429 (D-L134): one shared response on both, the sign-in throttle’s shape, per user, separate budgets, and it never echoes q or the lookup body', () => {
      const [searchOp, lookupOp] = gate();
      const fromSearch = searchOp ? responses(searchOp).get('429') : undefined;
      const fromLookup = lookupOp ? responses(lookupOp).get('429') : undefined;
      expect(fromSearch?.node, 'searchRecords 429').toBe(
        at({ $ref: '#/components/responses/SearchTooManyRequests' }).node,
      );
      expect(fromLookup?.node, 'one shared 429').toBe(fromSearch?.node);
      expect(throttleProblems(fromSearch?.node, signInThrottle())).toEqual([]);
      for (const op of [search(), lookup()]) {
        expect(description(op), op.id).toMatch(
          /\*\*Throttle \(T-0086, D-L134\)\.\*\* Each user has a budget of/,
        );
        expect(description(op), op.id).toMatch(
          /decided after authentication and before any validation, and the body never echoes the/,
        );
      }
      expect(description(lookup())).toMatch(/tighter than and separate from their searchRecords budget/);
    });

    it('(self-check, D-L134) the throttle checker refuses an echoing, misshapen or silent 429', () => {
      const real = responses(search()).get('429')?.node;
      expect(throttleProblems(real, signInThrottle()), 'the real one').toEqual([]);
      const copy = (): Mapping => JSON.parse(JSON.stringify(real)) as Mapping;
      const exampleOf = (node: Mapping): Mapping => {
        const media = (node.content as Mapping)['application/json'] as Mapping;
        const examples = media.examples as Mapping;
        return (examples[Object.keys(examples)[0] ?? ''] as Mapping).value as Mapping;
      };
      const plants: [string, (node: Mapping) => void][] = [
        ['echoes q', (node) => (exampleOf(node).message = 'No more searches for sam today.')],
        ['echoes a phone', (node) => (exampleOf(node).message = 'Too many lookups of 0803 000 0001.')],
        ['carries the query', (node) => (exampleOf(node).q = 'Sample')],
        ['another code', (node) => (exampleOf(node).code = 'rate_limited')],
        ['a non-UTC retryAt', (node) => (exampleOf(node).retryAt = '2026-10-14 10:01')],
        ['per address', (node) => (node.description = str(node.description).replace('**per user**', '**per address**'))],
        ['one budget', (node) => (node.description = str(node.description).replace('**own budget**', 'shared budget'))],
        ['silent on echoes', (node) => (node.description = str(node.description).replace('**The body never echoes the query**', 'The body'))],
      ];
      for (const [label, plant] of plants) {
        const node = copy();
        plant(node);
        expect(JSON.stringify(node), `${label}: the plant changed nothing`).not.toBe(JSON.stringify(real));
        expect(throttleProblems(node, signInThrottle()), label).not.toEqual([]);
      }
    });
  });

  describe('examples (R19, D-L97)', () => {
    it('(self-check) the validator rejects broken copies of the search examples', () => {
      const schema = schemaNamed('SearchResults');
      const answer = okExample(search(), 'prefix');
      expect(validate(schema, answer, 'answer'), 'the unbroken example').toEqual([]);
      const groups = groupsOf(answer);
      const [contacts] = groups;
      if (!contacts) throw new Error('prefix has no group');
      const [first] = list(contacts.hits);
      if (!first) throw new Error('prefix has no contact hit');
      const withGroup = (group: Mapping): Mapping => ({
        ...answer,
        groups: [group, ...groups.slice(1)],
      });
      const withHit = (hit: Mapping): Mapping => withGroup({ ...contacts, hits: [hit] });
      const mutants: [string, unknown][] = [
        ['a fourth hit', withGroup({ ...contacts, hits: [first, first, first, first] })],
        ['a total', { ...answer, total: 9 }],
        ['a group count', withGroup({ ...contacts, count: 2 })],
        [
          'a hit with a phone',
          withHit({ ...first, phones: [{ type: 'mobile', e164: '+2348030000001' }] }),
        ],
        ['a hit with an email', withHit({ ...first, emails: ['sample@example.test'] })],
        ['a hit with an owner', withHit({ ...first, owner: null })],
        ['a lead hit in the contact group', withHit({ ...first, type: 'lead' })],
        ['an unknown withheld name', withHit({ ...first, withheldFields: ['phones'] })],
        [
          'a repeated withheld name',
          withHit({ ...first, withheldFields: ['familyName', 'familyName'] }),
        ],
        ['a non-uuid id', withHit({ ...first, id: 'contact-1' })],
        [
          'no programmeId',
          withHit(JSON.parse(JSON.stringify({ ...first, programmeId: undefined })) as Mapping),
        ],
        ['a ticket group', withGroup({ type: 'ticket', hits: [] })],
        ['no groups', { groups: [] }],
        ['five groups', { groups: [...groups, contacts] }],
        [
          'an account with an owner',
          {
            groups: [
              {
                type: 'account',
                hits: [
                  {
                    type: 'account',
                    id: first.id,
                    programmeId: first.programmeId,
                    name: 'Sample',
                    ownerUserId: null,
                  },
                ],
              },
            ],
          },
        ],
        [
          'a deal with an amount',
          {
            groups: [
              {
                type: 'deal',
                hits: [
                  {
                    type: 'deal',
                    id: first.id,
                    programmeId: first.programmeId,
                    pipelineId: first.id,
                    name: 'Sample',
                    amount: null,
                  },
                ],
              },
            ],
          },
        ],
        [
          'a customer lead',
          {
            groups: [
              {
                type: 'lead',
                hits: [
                  {
                    type: 'lead',
                    id: first.id,
                    programmeId: first.programmeId,
                    status: 'customer',
                    withheldFields: [],
                  },
                ],
              },
            ],
          },
        ],
      ];
      for (const [label, mutant] of mutants) {
        expect(validate(schema, mutant, 'answer').length, `accepted ${label}`).toBeGreaterThan(0);
      }
    });

    it('every example on both operations, request bodies included, validates against its schema', () => {
      const problems: string[] = [];
      let checked = 0;
      for (const op of gate()) {
        const body = requestBody(op);
        const bodySchema = jsonSchema(body);
        for (const [label, value] of examplesOf(jsonMedia(body))) {
          checked += 1;
          if (bodySchema) problems.push(...validate(bodySchema, value, `${op.id} request ${label}`));
        }
        for (const [status, response] of responses(op)) {
          const schema = jsonSchema(response);
          const examples = examplesOf(jsonMedia(response));
          if (examples.length === 0) problems.push(`${op.id} ${status}: no example`);
          for (const [label, value] of examples) {
            checked += 1;
            if (schema) problems.push(...validate(schema, value, `${op.id} ${status} ${label}`));
          }
        }
      }
      expect(problems).toEqual([]);
      // Five success answers, three request bodies, ten 400 bodies and two 401s.
      expect(checked).toBeGreaterThanOrEqual(20);
      expect(
        examplesOf(jsonMedia(requestBody(lookup())))
          .map(([label]) => label)
          .sort(),
      ).toEqual(REQUEST_LABELS);
    });

    it('every example that shows a Nigerian-format number says it is a placeholder (R22)', () => {
      const summaries: string[] = [];
      for (const media of [
        jsonMedia(requestBody(lookup())),
        jsonMedia(responses(lookup()).get('200')),
      ]) {
        const examples = media ? child(media, 'examples') : undefined;
        if (!examples || !isMapping(examples.node)) continue;
        for (const key of Object.keys(examples.node)) {
          const example = child(examples, key);
          if (!example || !isMapping(example.node)) continue;
          const shown = [str(example.node.summary), ...stringsIn(example.node.value)];
          if (shown.some((text) => /0803 000 0001/.test(text))) summaries.push(str(example.node.summary));
        }
      }
      expect(summaries.length, 'no example shows the placeholder number').toBeGreaterThanOrEqual(2);
      expect(
        summaries.filter((summary) => !/a placeholder; Nigeria has no fictional number range/.test(summary)),
      ).toEqual([]);
    });

    it('the examples use synthetic names only (R19)', () => {
      const offending: string[] = [];
      let checked = 0;
      for (const [label, answer] of allOkExamples()) {
        for (const [, hit] of hitsOf(answer)) {
          for (const key of Object.keys(hit))
            if (NAME_LIKE.has(key) && typeof hit[key] === 'string') checked += 1;
        }
        offending.push(...realisticNames(answer).map((name) => `${label}: ${name}`));
      }
      expect(offending).toEqual([]);
      expect(checked, 'no names checked').toBeGreaterThanOrEqual(15);
      const texts = gate().flatMap((op) => {
        const media = jsonMedia(responses(op).get('200'));
        const body = jsonMedia(requestBody(op));
        return [
          ...stringsIn(isMapping(media?.node) ? media.node.examples : {}),
          ...stringsIn(isMapping(body?.node) ? body.node.examples : {}),
        ];
      });
      expect(texts.filter((text) => /Okonkwo|Balogun|Bakare|Adaeze|Kemi/i.test(text))).toEqual(
        [],
      );
      const emails = examplesOf(jsonMedia(requestBody(lookup())))
        .map(([, value]) => (isMapping(value) ? str(value.email) : ''))
        .filter((email) => email !== '');
      expect(emails.length).toBeGreaterThan(0);
      expect(emails.filter((email) => !/\.test$|\.example$|example\.(com|org|net)$/.test(email))).toEqual(
        [],
      );
    });

    it('(self-check, R19) a realistic name planted in an example is caught', () => {
      const answer = okExample(search(), 'prefix');
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
        if (OP_IDS.includes(op.id)) continue;
        const body = requestBody(op);
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
