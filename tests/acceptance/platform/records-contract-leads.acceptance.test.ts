import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * ACCEPTANCE — T-0056, the records API contract for LEADS (D-P17 answered:
 * a lead is a stage of a contact, not its own object; D-L61, D-L63, D-L67,
 * D-L69, D-L72, D-L73, D-P12, D-P13, D-P14, D-P18, ADR-0004). Agent 3.
 * Contract only: no route, no migration, no code. Written by QA for the lead
 * from the invariants (D-L23, D-L25), not from an implementation; there is
 * none yet.
 *
 * The artefact under test is `docs/api/records.openapi.yaml`. This suite reads
 * it as data (parsed YAML, never a regex over the raw text, so a keyword in a
 * YAML comment satisfies nothing). The T-0039, T-0052 and T-0059 suites keep
 * contacts, accounts, the record view and the whole-file rules (every `$ref`
 * resolves, unique operationIds, every operation documents 401); this suite
 * does not repeat them.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE CHOSEN FOR THE LEADS LIST: a separate `listLeads` operation
 * ---------------------------------------------------------------------------
 *
 *   listLeads        GET  /api/v1/leads
 *
 *   NOT a `lifecycle=lead` filter on listContacts, for one reason that is a
 *   leak, not a taste: listContacts is `x-kasuwa-implemented: true`, and the
 *   live route IGNORES unknown query parameters by design (the
 *   url-and-header-manipulation suite requires it). A `lifecycle` parameter
 *   added to an implemented operation is, until T-0076 ships, a filter the
 *   server silently drops: the Leads screen pointed at the live API would list
 *   customers as leads, "rows that look filtered and are not", which is the
 *   failure the contract's `field_withheld` rule exists to prevent. A
 *   separate operation carries its own `x-kasuwa-implemented: false` and
 *   answers 404 on the live API until it is built, never wrong rows. It also
 *   leaves the T-0041 suite and the T-0042 e2e mock (which copies
 *   listContacts) untouched.
 *
 *   Because a lead is a contact (D-P17), listLeads is a VIEW, not a resource:
 *     - its 200 schema is the SAME node as listContacts' 200 (`ContactPage`):
 *       rows are Contacts under Contact field security, no total (D-P13);
 *     - nothing lives under `/api/v1/leads/{...}`, no `Lead`/`LeadPage`
 *       schema exists, and listContacts gains no lifecycle/stage/lead filter
 *       (one Leads list, not two that drift apart);
 *     - every query parameter is one listContacts also takes, and every one
 *       except `status` and `sort` has a schema deep-equal to listContacts'
 *       (same q bound, same cursor, same limit cap). It takes at least q,
 *       status, sort, cursor and limit;
 *     - `status` items admit ONLY lead statuses (a subset of new, contacted,
 *       qualified, unqualified; never `customer`), so the Kanban (P04/04)
 *       can ask for one column without widening the view;
 *     - every `sort` key is listContacts' and is a Contact property the
 *       Contact schema REQUIRES (never withheld). `companyName` is never one;
 *     - the description defines a lead: `status` in new, contacted,
 *       qualified, unqualified, and names `customer` (as excluded);
 *     - `q` is documented as matching only fields the caller may read. P04's
 *       Leads search reaches Company and Email, both lockable columns: a hit
 *       on a withheld field is a one-bit oracle on its value;
 *     - when `status` is withheld from the caller, the view IS a filter on a
 *       withheld field. One paragraph of the description names `status`,
 *       "withheld" and `field_withheld` (the listContacts rule: 400, never
 *       rows). Otherwise a row's presence tells a caller who may not read
 *       `status` that the contact is a lead and not a customer;
 *     - documents 400 and 401; never 403 (a read).
 *     - names P04/01 (the Leads table). P04 frames: 01 Leads, 02 Contacts,
 *       03 Accounts, 04 Kanban and Map, 05 empty, 06 loading and offline.
 *
 * ---------------------------------------------------------------------------
 * THE REST OF THE CONTRACT THIS SUITE PINS (the builder writes the YAML)
 * ---------------------------------------------------------------------------
 *
 *   Contact.companyName (D-P17: `contact` gains a `company_name`).
 *     On Contact (getContact 200, so list rows too): types exactly string
 *     and null, a numeric `maxLength`, NOT required (field-secured: a
 *     withheld field is omitted, never nulled; `null` means no company).
 *     PENDING (D-L73) while no apps/api/src source mentions `companyName`:
 *     it sits in an `allOf` part of Contact (ContactPendingProperties is the
 *     obvious one), not in `Contact.properties`, and its property node
 *     carries `x-kasuwa-implemented: false`. The live T-0041 suite requires
 *     every `Contact.properties` entry to be served or withheld, and the
 *     T-0053 metadata suite requires a field_def for each, so T-0076 moves it
 *     into `properties` in the same change that serves it (and adds the
 *     field_def). Once apps/api/src mentions it, this suite requires that
 *     move instead.
 *     WRITABLE: both CreateContactRequest and UpdateContactRequest declare
 *     `companyName` in their OWN `properties`. An `allOf` part is not enough:
 *     both bodies are `additionalProperties: false`, and in JSON Schema that
 *     keyword sees sibling `properties` only, so a conforming validator
 *     rejects a property only an allOf part declares. Types string and null,
 *     a numeric `maxLength`, not required on create. While unserved, each
 *     write-body `companyName` carries `x-kasuwa-implemented: false` too:
 *     createContact and updateContact are implemented, and the live strict
 *     body schema answers 400 to it until T-0076 (an extension of the D-L73
 *     pattern from the response to the request; see the report).
 *
 *   convertContact   POST /api/v1/contacts/{<id>}/convert
 *     One required `format: uuid` path parameter. `x-kasuwa-audited: true`
 *     (one audit event). Names P04/01. NOTE: it is a sub-resource of one
 *     contact, so the T-0059 suite also requires it to name a P05 frame (the
 *     record view's header is where Convert lives once drawn) and to use
 *     getContact's Error schema. That is T-0059's rule, not restated here.
 *     BODY: required, and admits EXACTLY ONE of `accountId` (a uuid, never
 *     null) or ONE new-account property (its name contains "account", e.g.
 *     `account` or `newAccount`), always with an integer `version`. Checked
 *     by simulating key sets against the schema (closedness, `required`,
 *     `oneOf`/`anyOf`, `not: { required }`), so the builder may express it
 *     as a top-level oneOf of required-lists under a closed body, or as a
 *     oneOf of closed objects; `anyOf` alone, an open body, or a branch that
 *     admits both keys fails. The suite proves its own simulator rejects
 *     those before trusting it.
 *       The new account: a CLOSED object REQUIRING `name` (string, numeric
 *       `maxLength`), every property of which CreateAccountRequest also has,
 *       never `programmeId`: the account is created in the contact's
 *       programme, full stop.
 *       Nowhere in the body, at any depth: tenantId, programmeId(s), scope,
 *       businessUnitId, contactId, or `status` (convert always qualifies;
 *       a status in the body would make it a second, unaudited updateContact).
 *     SUCCESS: exactly one 2xx (a repeat answers with the same result, so a
 *     201-then-200 pair is not idempotent). Its schema is CLOSED with exactly
 *     `contact` and `account`, both required: `contact` the same node as
 *     getContact's 200 (Contact field security applies), `account` the same
 *     node as getAccount's 200 (Account field security applies). Nothing
 *     else: a `created` flag would differ between the first call and a
 *     repeat.
 *     ERRORS: 400 (examples only validation_failed), 401, 403 (examples only
 *     and at least one not_permitted), 404 (examples only not_found), 409
 *     (examples include stale_write).
 *     DESCRIPTION, paragraph-level phrases (prose is the only place these
 *     rules can live in an OpenAPI file):
 *       - one transaction; one audit event; idempotent;
 *       - one paragraph ties a repeat/retry to the version check. A retry
 *         after a lost response carries the version the first call made
 *         stale: "409" breaks idempotency and "ignore version" breaks the
 *         concurrency check, so the contract must say which, and when;
 *       - an account the caller cannot reach (another programme, another
 *         tenant, none) is the same 404 as a contact out of reach: one
 *         paragraph names 404 (or not_found), the account, and another
 *         programme; and the description names "the contact's programme"
 *         (an existing account must be in it, a new one is created in it;
 *         a caller in A1 and A2 must not link an A1 lead to an A2 account);
 *       - names `contact.write` and `account.write` (D-P18: account writes
 *         are admin-only) and `field_not_editable` (status and accountId are
 *         field-secured; a caller who may not READ accountId would otherwise
 *         learn the existing link from the `account` in a repeat's answer);
 *       - names `customer` (what convert does to a contact that is already
 *         a customer; it must not quietly demote one to qualified) and
 *         "already" (a contact already linked to an account).
 *
 *   NOT BUILT (D-L69, D-P12): no property named like score, health or rating
 *   on Contact (pending part included) or on the convert response, at any
 *   depth. Any operation in the file whose id or path says merge, score,
 *   health or map/geo is `x-kasuwa-implemented: false`, documents 401 and
 *   501 (examples only not_implemented), names a P04 frame; a score or
 *   health stub's description names M17, a merge stub's D-P12.
 *
 *   ERRORS AND SCOPE on every operation this slice adds (listLeads,
 *   convertContact, anything under /api/v1/leads, and the not-built stubs):
 *   every 4xx/5xx is the same Error schema node as getContact's 404; no
 *   parameter named like programme, tenant, scope or business unit; no
 *   `x-kasuwa-*` header; no cookie; no `/programmes/`, `/tenants/` or
 *   `/business-units/` path segment; no `security: []` or `{}`;
 *   `x-kasuwa-implemented` is a boolean and `x-kasuwa-screens` names a P04
 *   frame.
 *
 *   IMPLEMENTED FLAG. As in the T-0052 and T-0059 suites, `false` is not
 *   pinned as a literal (that would make T-0076 edit a lead suite to flip a
 *   word). The lie is pinned: `true` with no apps/api/src controller routing
 *   `leads` (listLeads) or `convert` (convertContact). While T-0056 is the
 *   only work, that means `false`.
 *
 * THE BUILDER'S CHOICE (not asserted): the path parameter's name; the
 * new-account property's name (within "contains account"); whether the
 * success code is 200 or 201; how exclusivity is expressed (within what the
 * simulator reads); descriptions beyond the phrases named above; listLeads'
 * sort default and its subset of listContacts' sort keys; which listContacts
 * filters listLeads repeats beyond q, status, sort, cursor and limit; the
 * answer for a customer or an already-linked contact (named, not chosen);
 * whether the not-built features are 501 stubs or simply absent.
 *
 * NOT here, deliberately: whether a converted lead (now `qualified`) stays
 * on the Leads list (D-P17 keeps `qualified` in the lead set, so it does;
 * flagged in the report), import mapping of Zoho Leads (P28), dedupe on
 * convert (D-P12), Contact relationship status (D-L69).
 *
 * ---------------------------------------------------------------------------
 *
 * D-L23: on main the file has no listLeads, no convertContact and no
 * companyName. Every test then fails naming the missing operationId or
 * property rather than crashing at collection: the spec is loaded lazily and
 * nothing is read at module level. Every negative invariant (no scope
 * parameter, no score, stubs are 501, no lifecycle filter) first requires
 * listLeads or convertContact to exist, so none passes on a file without
 * them.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const SPEC_REL = 'docs/api/records.openapi.yaml';
const SPEC_PATH = resolve(repoRoot, SPEC_REL);
const API_SRC = resolve(repoRoot, 'apps', 'api', 'src');

const LIST_LEADS = 'listLeads';
const CONVERT = 'convertContact';
const COMPANY = 'companyName';
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified'] as const;

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

/** Merge, Lead score, account Health and the Map view: no module has built them (D-L69, D-P12). */
const UNBUILT: { label: string; match: RegExp; waitsFor: RegExp | null }[] = [
  { label: 'merge', match: /merge/i, waitsFor: /D-P12/ },
  { label: 'lead score', match: /score/i, waitsFor: /\bM17\b/ },
  { label: 'health', match: /health/i, waitsFor: /\bM17\b/ },
  { label: 'map', match: /(^|\/)(map|geo)(\/|$)|Map$|^map|geo/i, waitsFor: null },
];

function unbuiltLabel(op: Operation): string | undefined {
  return UNBUILT.find((entry) => entry.match.test(op.id) || entry.match.test(op.path))?.label;
}

/**
 * Every operation this slice adds: listLeads, convertContact, anything under
 * /api/v1/leads and the not-built stubs. Throws if either named operation is
 * missing, so a negative invariant iterated over this list cannot pass on main.
 */
function leadsOperations(): Operation[] {
  operation(LIST_LEADS);
  operation(CONVERT);
  return operations().filter(
    (op) =>
      op.id === LIST_LEADS ||
      op.id === CONVERT ||
      /^\/api\/v1\/leads(\/|$)/.test(op.path) ||
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

function requestBody(id: string): Located | undefined {
  const op = operation(id);
  return op.op.requestBody === undefined ? undefined : at(op.op.requestBody);
}

function requestSchema(id: string): Located {
  const schema = jsonSchema(requestBody(id));
  if (!schema) throw new Error(`${id} has no application/json request body schema`);
  return schema;
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

function description(op: Operation): string {
  return str(op.op.description);
}

/** Blank-line-separated paragraphs of an operation's description. */
function paragraphs(op: Operation): string[] {
  return description(op)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph !== '');
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Properties declared on the schema itself and in its `allOf` parts. */
function properties(schema: Located): Map<string, Located> {
  const out = new Map<string, Located>();
  const node = schema.node;
  if (!isMapping(node)) return out;
  for (const part of Array.isArray(node.allOf) ? node.allOf : []) {
    for (const [key, value] of properties(at(part, schema.file))) out.set(key, value);
  }
  for (const [key, value] of ownProperties(schema)) out.set(key, value);
  return out;
}

/** Properties declared in the schema's own `properties` only (what `additionalProperties` sees). */
function ownProperties(schema: Located): Map<string, Located> {
  const out = new Map<string, Located>();
  const props = child(schema, 'properties');
  if (props && isMapping(props.node)) {
    for (const key of Object.keys(props.node)) {
      const value = child(props, key);
      if (value) out.set(key, value);
    }
  }
  return out;
}

/** The raw (un-dereferenced) node of an own property, to read extensions beside a `$ref`. */
function rawOwnProperty(schema: Located, key: string): unknown {
  const props = child(schema, 'properties');
  return props && isMapping(props.node) ? props.node[key] : undefined;
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

/** A string's `maxLength`, looking through a `oneOf`/`anyOf` with null. */
function maxLengthOf(schema: Located): number | undefined {
  const node = schema.node;
  if (!isMapping(node)) return undefined;
  if (typeof node.maxLength === 'number') return node.maxLength;
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const variants = node[key];
    if (Array.isArray(variants)) {
      for (const variant of variants) {
        const found = maxLengthOf(at(variant, schema.file));
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
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

function queryNames(op: Operation): string[] {
  return op.params.filter((parameter) => parameter.in === 'query').map((p) => str(p.name));
}

function responseSchema(id: string, status: string): Located {
  const schema = jsonSchema(responses(operation(id)).get(status));
  if (!schema) throw new Error(`${id} has no ${status} application/json schema`);
  return schema;
}

function contactSchema(): Located {
  return responseSchema('getContact', '200');
}

/**
 * Fully dereferenced copy of a schema, for structural comparison. Cycle-safe:
 * a node already on the path is replaced by a marker.
 */
function expand(located: Located, stack: unknown[] = []): unknown {
  const current = deref(located);
  const node = current.node;
  if (stack.includes(node)) return '[cycle]';
  if (Array.isArray(node)) {
    return node.map((item) => expand({ node: item, file: current.file }, [...stack, node]));
  }
  if (!isMapping(node)) return node;
  const out: Mapping = {};
  for (const key of Object.keys(node).sort()) {
    if (key === 'description' || key === 'example' || key === 'examples') continue;
    out[key] = expand({ node: node[key], file: current.file }, [...stack, node]);
  }
  return out;
}

/** Every key at every depth of a schema, as dotted paths, branches included. Cycle-safe. */
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

function leaf(path: string): string {
  return (path.split('.').pop() ?? path).replace(/\[\]$/, '');
}

// ---------------------------------------------------------------------------
// The live API, read only to catch "implemented" claims nothing serves
// ---------------------------------------------------------------------------

let apiSourceCache: string[] | undefined;

/** The text of every non-test .ts file under apps/api/src. */
function apiSources(): string[] {
  if (apiSourceCache) return apiSourceCache;
  const out: string[] = [];
  if (existsSync(API_SRC)) {
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
        if (!entry.name.endsWith('.ts') || /\.(spec|test)\.ts$/.test(entry.name)) continue;
        out.push(readFileSync(full, 'utf8'));
      }
    }
  }
  apiSourceCache = out;
  return out;
}

/** Whether a controller declares a route whose path string contains `segment`. */
function routeDeclared(segment: string): boolean {
  const route = new RegExp(
    `@(Controller|Get|Post|Patch|Put)\\(\\s*['"\`][^'"\`\\n]*\\b${segment}\\b[^'"\`\\n]*['"\`]`,
  );
  return apiSources().some((text) => text.includes('@Controller(') && route.test(text));
}

/** Whether the live API mentions companyName at all (T-0076 has started serving it). */
function companyNameServed(): boolean {
  return apiSources().some((text) => text.includes(COMPANY));
}

// ---------------------------------------------------------------------------
// The convert body: "exactly one of", checked by simulating key sets
// ---------------------------------------------------------------------------

/**
 * Whether a body carrying exactly these top-level keys satisfies the schema's
 * key-level constraints: `required`, `additionalProperties: false` (against
 * its OWN properties, as JSON Schema reads it), min/maxProperties,
 * `not: { required }`, and `oneOf` (exactly one branch) / `anyOf` (at least
 * one), recursively. Value types are checked separately.
 */
function acceptsKeys(schema: Located, keys: readonly string[]): boolean {
  const node = schema.node;
  if (!isMapping(node)) return true;
  if (!required(schema).every((key) => keys.includes(key))) return false;
  if (node.additionalProperties === false) {
    const own = ownProperties(schema);
    if (keys.some((key) => !own.has(key))) return false;
  }
  if (typeof node.minProperties === 'number' && keys.length < node.minProperties) return false;
  if (typeof node.maxProperties === 'number' && keys.length > node.maxProperties) return false;
  if (node.not !== undefined) {
    const banned = required(at(node.not, schema.file));
    if (banned.length > 0 && banned.every((key) => keys.includes(key))) return false;
  }
  for (const part of Array.isArray(node.allOf) ? node.allOf : []) {
    if (!acceptsKeys(at(part, schema.file), keys)) return false;
  }
  if (Array.isArray(node.oneOf)) {
    const passing = node.oneOf.filter((branch) => acceptsKeys(at(branch, schema.file), keys));
    if (passing.length !== 1) return false;
  }
  if (Array.isArray(node.anyOf)) {
    if (!node.anyOf.some((branch) => acceptsKeys(at(branch, schema.file), keys))) return false;
  }
  return true;
}

/** Every property name the body declares, on itself or in any branch or part. */
function bodyKeys(schema: Located, seen = new Set<unknown>()): Set<string> {
  const out = new Set<string>();
  if (seen.has(schema.node)) return out;
  seen.add(schema.node);
  const node = schema.node;
  for (const key of properties(schema).keys()) out.add(key);
  if (isMapping(node)) {
    for (const combinator of ['oneOf', 'anyOf', 'allOf']) {
      const variants = node[combinator];
      if (Array.isArray(variants)) {
        for (const variant of variants) {
          for (const key of bodyKeys(at(variant, schema.file), seen)) out.add(key);
        }
      }
    }
  }
  return out;
}

/** The schema a body gives `key`, searching itself, then its branches and parts. */
function bodyProperty(
  schema: Located,
  key: string,
  seen = new Set<unknown>(),
): Located | undefined {
  if (seen.has(schema.node)) return undefined;
  seen.add(schema.node);
  const direct = properties(schema).get(key);
  if (direct) return direct;
  const node = schema.node;
  if (!isMapping(node)) return undefined;
  for (const combinator of ['oneOf', 'anyOf', 'allOf']) {
    const variants = node[combinator];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      const found = bodyProperty(at(variant, schema.file), key, seen);
      if (found) return found;
    }
  }
  return undefined;
}

/** The single new-account key: declared somewhere in the body, named like "account", not accountId. */
function newAccountKey(schema: Located): string {
  const candidates = [...bodyKeys(schema)].filter(
    (key) => /account/i.test(key) && key !== 'accountId',
  );
  if (candidates.length !== 1) {
    throw new Error(
      `the convert body should declare exactly one new-account property besides accountId, found ${JSON.stringify(candidates)}`,
    );
  }
  const [only] = candidates;
  if (only === undefined) throw new Error('no new-account property');
  return only;
}

/** What is wrong with a body's "exactly one of accountId or <newKey>, plus version". */
function exclusivityProblems(schema: Located, newKey: string): string[] {
  const problems: string[] = [];
  const cases: [keys: string[], accept: boolean, label: string][] = [
    [['version', 'accountId'], true, 'version + accountId'],
    [['version', newKey], true, `version + ${newKey}`],
    [['version', 'accountId', newKey], false, `both accountId and ${newKey}`],
    [['version'], false, 'neither accountId nor a new account'],
    [['accountId'], false, 'accountId without version'],
    [[newKey], false, `${newKey} without version`],
    [['version', 'accountId', 'status'], false, 'an extra status'],
    [['version', newKey, 'programmeId'], false, 'an extra programmeId'],
    [['version', 'accountId', 'unexpected'], false, 'an unknown property'],
  ];
  for (const [keys, accept, label] of cases) {
    if (acceptsKeys(schema, keys) !== accept) {
      problems.push(`${accept ? 'rejects' : 'accepts'} a body with ${label}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

const SCREEN_ID = /^P\d{2}\/[0-9A-Za-z]+$/;
const P04_FRAME = /^P04\/0[1-6]$/;
const SCORE_LIKE = /score|health|rating|temperature|grade/i;

describe('acceptance: records contract, leads (T-0056)', () => {
  describe('Contact.companyName (D-P17)', () => {
    it('Contact carries companyName: a string or null, bounded, and optional (withheld means omitted)', () => {
      const contact = contactSchema();
      const company = properties(contact).get(COMPANY);
      expect(company, 'Contact has no companyName (in properties or an allOf part)').toBeDefined();
      if (!company) return;
      expect(types(company).sort(), 'Contact.companyName types').toEqual(['null', 'string']);
      expect(maxLengthOf(company), 'Contact.companyName has no maxLength').toBeTypeOf('number');
      expect(
        required(contact),
        'companyName is required, so field security could not withhold it',
      ).not.toContain(COMPANY);
    });

    it('is pending (D-L73) until the live API serves it, and moves into Contact.properties when it does', () => {
      const contact = contactSchema();
      expect(properties(contact).has(COMPANY), 'Contact has no companyName').toBe(true);
      const own = ownProperties(contact).has(COMPANY);
      if (companyNameServed()) {
        // T-0076 serves it: D-L73 says the pending property moves in the same change.
        expect(own, 'apps/api serves companyName but Contact still lists it as pending').toBe(true);
        return;
      }
      // The live T-0041 suite requires every Contact.properties entry to be
      // served or withheld; an unserved companyName there turns it red.
      expect(
        own,
        'companyName is in Contact.properties, but no apps/api/src source serves it (D-L73)',
      ).toBe(false);
      const node = contact.node;
      const parts = isMapping(node) && Array.isArray(node.allOf) ? node.allOf : [];
      const holders = parts
        .map((part) => at(part, contact.file))
        .filter((part) => ownProperties(part).has(COMPANY));
      expect(holders.length, 'no allOf part of Contact declares companyName').toBe(1);
      const [holder] = holders;
      if (!holder) return;
      const raw = rawOwnProperty(holder, COMPANY);
      const flag = isMapping(raw) ? raw['x-kasuwa-implemented'] : undefined;
      const resolved = ownProperties(holder).get(COMPANY);
      const resolvedFlag = isMapping(resolved?.node)
        ? resolved.node['x-kasuwa-implemented']
        : undefined;
      expect(
        flag ?? resolvedFlag,
        'the pending companyName does not carry x-kasuwa-implemented: false',
      ).toBe(false);
    });

    for (const [id, label] of [
      ['createContact', 'CreateContactRequest'],
      ['updateContact', 'UpdateContactRequest'],
    ] as const) {
      it(`${id} takes companyName in its OWN properties (its closed body would reject an allOf-only one)`, () => {
        const body = requestSchema(id);
        const company = ownProperties(body).get(COMPANY);
        expect(
          company,
          `${label} does not declare companyName in its own properties; additionalProperties: false would reject it`,
        ).toBeDefined();
        if (!company) return;
        expect(types(company).sort(), `${label}.companyName types`).toEqual(['null', 'string']);
        expect(maxLengthOf(company), `${label}.companyName has no maxLength`).toBeTypeOf('number');
        expect(required(body), `${label} requires companyName`).not.toContain(COMPANY);
        if (!companyNameServed()) {
          // createContact and updateContact are implemented; the live strict
          // body answers 400 to companyName until T-0076.
          const raw = rawOwnProperty(body, COMPANY);
          const flag = isMapping(raw) ? raw['x-kasuwa-implemented'] : undefined;
          const resolved = isMapping(company.node)
            ? company.node['x-kasuwa-implemented']
            : undefined;
          expect(
            flag ?? resolved,
            `${label}.companyName is not marked x-kasuwa-implemented: false while the live API rejects it`,
          ).toBe(false);
        }
      });
    }

    it('companyName is never a sort key on any list of contacts', () => {
      expect(properties(contactSchema()).has(COMPANY), 'Contact has no companyName').toBe(true);
      const page = responseSchema('listContacts', '200').node;
      const lists = operations().filter((op) => {
        const ok = jsonSchema(responses(op).get('200'));
        return ok !== undefined && ok.node === page;
      });
      const offending: string[] = [];
      for (const op of lists) {
        const sort = param(op, 'sort');
        const keys = sort ? enumOf(paramSchema(sort)).map(str) : [];
        for (const key of keys) {
          if (/company/i.test(key)) offending.push(`${op.id}: ${key}`);
        }
      }
      expect(offending).toEqual([]);
      // listContacts, listAccountContacts and listLeads share ContactPage.
      expect(
        lists.map((op) => op.id),
        'listLeads does not return ContactPage',
      ).toContain(LIST_LEADS);
    });
  });

  describe('listLeads: the Leads list is a view of contacts', () => {
    it('is GET /api/v1/leads and names P04/01', () => {
      const op = operation(LIST_LEADS);
      expect(op.method, 'method').toBe('get');
      expect(op.path, 'path').toBe('/api/v1/leads');
      expect(typeof op.op['x-kasuwa-implemented'], 'x-kasuwa-implemented').toBe('boolean');
      const screens = screensOf(op);
      expect(
        screens.filter((screen) => !SCREEN_ID.test(screen)),
        'bad screen ids',
      ).toEqual([]);
      expect(screens, 'listLeads backs the Leads table, P04/01').toContain('P04/01');
    });

    it('does not claim x-kasuwa-implemented: true without a leads route', () => {
      const op = operation(LIST_LEADS);
      if (op.op['x-kasuwa-implemented'] === true) {
        expect(
          routeDeclared('leads'),
          'listLeads marked implemented, but no apps/api/src controller routes leads',
        ).toBe(true);
      }
      // Legitimately vacuous while it says false (T-0056's state until
      // T-0076). operation() above still fails on main.
    });

    it('returns the very ContactPage listContacts returns: Contact rows, no total (D-P13)', () => {
      const leads = responseSchema(LIST_LEADS, '200');
      const contacts = responseSchema('listContacts', '200');
      expect(
        leads.node === contacts.node,
        'listLeads 200 is not the same schema node as listContacts 200 (a lead is a contact, D-P17)',
      ).toBe(true);
      expect(
        [...properties(leads).keys()].filter((key) => /total|count|offset|^page$/i.test(key)),
        'the page reports a total or a count',
      ).toEqual([]);
    });

    it('defines a lead as status new, contacted, qualified or unqualified, and names customer', () => {
      const text = description(operation(LIST_LEADS));
      expect(text, 'the description does not say a lead is a status').toMatch(/\bstatus\b/);
      for (const status of LEAD_STATUSES) {
        expect(text, `the description does not name ${status}`).toMatch(
          new RegExp(`\\b${status}\\b`),
        );
      }
      expect(text, 'the description does not say customers are not leads').toMatch(/\bcustomer/);
    });

    it('takes q, status, sort, cursor and limit, and only parameters listContacts takes', () => {
      const leads = queryNames(operation(LIST_LEADS));
      const contacts = queryNames(operation('listContacts'));
      expect(leads, 'listLeads query parameters').toEqual(
        expect.arrayContaining(['q', 'status', 'sort', 'cursor', 'limit']),
      );
      expect(
        leads.filter((name) => !contacts.includes(name)),
        'a listLeads parameter listContacts does not take (a filter that escapes its rules)',
      ).toEqual([]);
    });

    it('every shared parameter but status and sort has the same schema as on listContacts', () => {
      const leads = operation(LIST_LEADS);
      const contacts = operation('listContacts');
      const drift: string[] = [];
      let compared = 0;
      for (const name of queryNames(leads)) {
        if (name === 'status' || name === 'sort') continue;
        const mine = param(leads, name);
        const theirs = param(contacts, name);
        if (!mine || !theirs) continue;
        compared += 1;
        const a = JSON.stringify(expand({ node: mine.schema ?? {}, file: SPEC_PATH }));
        const b = JSON.stringify(expand({ node: theirs.schema ?? {}, file: SPEC_PATH }));
        if (a !== b) drift.push(`${name}: ${a} vs listContacts ${b}`);
      }
      expect(drift, 'listLeads parameters drifted from listContacts').toEqual([]);
      // q, cursor and limit at least.
      expect(compared, 'no shared parameter compared').toBeGreaterThanOrEqual(3);
    });

    it('its status filter admits only lead statuses, never customer', () => {
      const status = param(operation(LIST_LEADS), 'status');
      expect(status, 'listLeads has no status filter').toBeDefined();
      if (!status) return;
      const values = enumOf(paramSchema(status)).map(str);
      expect(values.length, 'the status filter has no enum').toBeGreaterThan(0);
      expect(
        values.filter((value) => !(LEAD_STATUSES as readonly string[]).includes(value)),
        'status values outside the lead set (a customer filter widens the view)',
      ).toEqual([]);
    });

    it("sort is an enum of listContacts' keys, every one a never-withheld Contact property", () => {
      const sort = param(operation(LIST_LEADS), 'sort');
      expect(sort, 'listLeads has no sort').toBeDefined();
      if (!sort) return;
      const keys = enumOf(paramSchema(sort)).map(str);
      expect(keys.length, 'sort has no enum').toBeGreaterThan(0);
      const theirs = param(operation('listContacts'), 'sort');
      const allowed = theirs ? enumOf(paramSchema(theirs)).map(str) : [];
      expect(
        keys.filter((key) => !allowed.includes(key)),
        "sort keys listContacts' sort does not offer",
      ).toEqual([]);
      const never = required(contactSchema());
      expect(
        keys.map((key) => key.replace(/^-/, '')).filter((key) => !never.includes(key)),
        'sort keys that field security can withhold (the order leaks the values)',
      ).toEqual([]);
    });

    it('q is documented as matching only fields the caller may read', () => {
      const op = operation(LIST_LEADS);
      const q = param(op, 'q');
      expect(q, 'listLeads has no q').toBeDefined();
      if (!q) return;
      const schema = paramSchema(q).node;
      const text = [
        description(op),
        str(q.description),
        isMapping(schema) ? str(schema.description) : '',
      ]
        .join('\n')
        .replace(/\s+/g, ' ');
      // P04's Leads search reaches Company and Email, both lockable columns.
      expect(text, 'nothing says q matches only fields the caller may read').toMatch(
        /\bonly\b[^.]{0,100}\b(may|can) read\b/i,
      );
    });

    it('when status is withheld from the caller, the view is 400 field_withheld, never rows', () => {
      const found = paragraphs(operation(LIST_LEADS)).some(
        (paragraph) =>
          /\bstatus\b/.test(paragraph) &&
          /withh?eld/i.test(paragraph.replace(/field_withheld/g, '')) &&
          /field_withheld/.test(paragraph),
      );
      expect(
        found,
        'no paragraph of the listLeads description says a withheld status makes the view field_withheld',
      ).toBe(true);
    });

    it('documents 400 and 401, and never 403', () => {
      const codes = [...responses(operation(LIST_LEADS)).keys()];
      expect(codes).toEqual(expect.arrayContaining(['400', '401']));
      expect(codes, 'a read never answers 403').not.toContain('403');
    });

    it('there is one Leads list: no lead record, no Lead schema, no lifecycle filter on listContacts', () => {
      operation(LIST_LEADS); // Gate: each check below holds on main, before the work starts.
      expect(
        operations()
          .filter((op) => /^\/api\/v1\/leads\/.*\{/.test(op.path))
          .map((op) => `${op.method.toUpperCase()} ${op.path}`),
        'a lead is a contact (D-P17): nothing addresses a lead by id',
      ).toEqual([]);
      const doc = spec();
      const components = isMapping(doc.components) ? doc.components : {};
      const schemas = isMapping(components.schemas) ? components.schemas : {};
      expect(
        Object.keys(schemas).filter((name) => /^Leads?(Page|Row|Record|Summary)?$/.test(name)),
        'a Lead record schema',
      ).toEqual([]);
      expect(
        queryNames(operation('listContacts')).filter((name) =>
          /lifecycle|stage|^leads?$|isLead|leadOnly/i.test(name),
        ),
        'listContacts has a second, lead-shaped filter',
      ).toEqual([]);
    });
  });

  describe('convertContact: qualify and link an account, once', () => {
    it('is POST /api/v1/contacts/{id}/convert with one required uuid path parameter, naming P04/01', () => {
      const op = operation(CONVERT);
      expect(op.method, 'method').toBe('post');
      expect(op.path, 'path').toMatch(/^\/api\/v1\/contacts\/\{[A-Za-z]+\}\/convert$/);
      const pathParams = op.params.filter((parameter) => parameter.in === 'path');
      expect(pathParams.length, 'path parameters').toBe(1);
      const [only] = pathParams;
      expect(op.path, 'the path parameter is not the one in the path').toContain(
        `{${str(only?.name)}}`,
      );
      expect(only?.required, 'path parameter not required').toBe(true);
      expect(only ? formatOf(paramSchema(only)) : '', 'id is not format uuid').toBe('uuid');
      expect(typeof op.op['x-kasuwa-implemented'], 'x-kasuwa-implemented').toBe('boolean');
      expect(screensOf(op), 'convert is a Leads action, P04/01').toContain('P04/01');
    });

    it('does not claim x-kasuwa-implemented: true without a convert route', () => {
      const op = operation(CONVERT);
      if (op.op['x-kasuwa-implemented'] === true) {
        expect(
          routeDeclared('convert'),
          'convertContact marked implemented, but no apps/api/src controller routes convert',
        ).toBe(true);
      }
      // Legitimately vacuous while it says false. operation() still fails on main.
    });

    it('is audited (x-kasuwa-audited: true)', () => {
      expect(operation(CONVERT).op['x-kasuwa-audited'], 'x-kasuwa-audited').toBe(true);
    });

    it('(self-check) the key-set simulator passes an exactly-one-of body and catches the broken ones', () => {
      // The simulator only ever seen passing would prove nothing. In-memory
      // fixtures, no $ref, so this runs on main too.
      const version = { type: 'integer' };
      const accountId = { type: 'string', format: 'uuid' };
      const account = {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: { type: 'string' } },
      };
      const good = {
        type: 'object',
        additionalProperties: false,
        required: ['version'],
        properties: { version, accountId, account },
        oneOf: [{ required: ['accountId'] }, { required: ['account'] }],
      };
      const closedBranches = {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['version', 'accountId'],
            properties: { version, accountId },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['version', 'account'],
            properties: { version, account },
          },
        ],
      };
      const fixture = (node: unknown): Located => ({ node, file: SPEC_PATH });
      expect(exclusivityProblems(fixture(good), 'account'), 'required-list oneOf').toEqual([]);
      expect(exclusivityProblems(fixture(closedBranches), 'account'), 'closed branches').toEqual(
        [],
      );

      const broken: [string, unknown][] = [
        ['anyOf (both allowed)', { ...good, oneOf: undefined, anyOf: good.oneOf }],
        ['an open body', { ...good, additionalProperties: undefined }],
        ['version not required', { ...good, required: [] }],
        [
          'a branch admitting both keys',
          {
            oneOf: [
              {
                ...closedBranches.oneOf[0],
                properties: { version, accountId, account },
              },
              closedBranches.oneOf[1],
            ],
          },
        ],
        [
          'branch properties under a closed top (the allOf/additionalProperties trap)',
          {
            type: 'object',
            additionalProperties: false,
            required: ['version'],
            properties: { version },
            oneOf: [
              { required: ['accountId'], properties: { accountId } },
              { required: ['account'], properties: { account } },
            ],
          },
        ],
      ];
      for (const [label, node] of broken) {
        expect(
          exclusivityProblems(fixture(node), 'account').length,
          `the simulator accepted ${label}`,
        ).toBeGreaterThan(0);
      }
    });

    it('the body is required and admits exactly one of accountId or a new account, always with version', () => {
      const holder = requestBody(CONVERT);
      expect(
        isMapping(holder?.node) ? holder.node.required : undefined,
        'requestBody.required',
      ).toBe(true);
      const body = requestSchema(CONVERT);
      const key = newAccountKey(body);
      expect(exclusivityProblems(body, key), 'the convert body').toEqual([]);
      const version = bodyProperty(body, 'version');
      expect(version ? types(version) : [], 'version type').toContain('integer');
    });

    it('accountId is a uuid (never null); the new account is closed, needs a bounded name, and names no programme', () => {
      const body = requestSchema(CONVERT);
      const accountId = bodyProperty(body, 'accountId');
      expect(accountId, 'the body has no accountId').toBeDefined();
      if (accountId) {
        expect(types(accountId), 'accountId type').toContain('string');
        // null would mean "convert without an account": a second, unnamed branch.
        expect(types(accountId), 'accountId admits null').not.toContain('null');
        expect(formatOf(accountId), 'accountId format').toBe('uuid');
      }

      const key = newAccountKey(body);
      const account = bodyProperty(body, key);
      expect(account, `the body has no ${key} schema`).toBeDefined();
      if (!account) return;
      expect(types(account), `${key} type`).toContain('object');
      expect(types(account), `${key} admits null`).not.toContain('null');
      expect(
        isMapping(account.node) ? account.node.additionalProperties : undefined,
        `${key} is not closed`,
      ).toBe(false);
      expect(required(account), `${key} required`).toContain('name');
      const props = properties(account);
      const name = props.get('name');
      expect(name ? types(name) : [], `${key}.name type`).toContain('string');
      expect(name ? maxLengthOf(name) : undefined, `${key}.name has no maxLength`).toBeTypeOf(
        'number',
      );
      const create = properties(requestSchema('createAccount'));
      expect(
        [...props.keys()].filter((prop) => prop === 'programmeId' || !create.has(prop)),
        `${key} properties outside CreateAccountRequest, or a target programme`,
      ).toEqual([]);
    });

    it('the body chooses no scope and no status, at any depth', () => {
      const body = requestSchema(CONVERT);
      const keys = deepKeys(body);
      expect(keys.length, 'no body keys read').toBeGreaterThan(0);
      expect(
        keys.filter((path) =>
          /^(tenant[-_]?ids?|programme[-_]?ids?|scope|business[-_]?unit(ids?)?|contactId|status)$/i.test(
            leaf(path),
          ),
        ),
        'scope, a target programme, a contact id or a status in the convert body',
      ).toEqual([]);
    });

    it('answers one 2xx: a closed { contact: Contact, account: Account }, both required', () => {
      const all = responses(operation(CONVERT));
      const success = [...all.keys()].filter((code) => /^2\d\d$/.test(code));
      expect(success.length, `success codes ${JSON.stringify(success)}`).toBe(1);
      const [code] = success;
      const schema = code === undefined ? undefined : jsonSchema(all.get(code));
      expect(schema, 'the success response has no application/json schema').toBeDefined();
      if (!schema) return;
      const props = properties(schema);
      expect([...props.keys()].sort(), 'convert response properties').toEqual([
        'account',
        'contact',
      ]);
      expect(required(schema), 'convert response required').toEqual(
        expect.arrayContaining(['account', 'contact']),
      );
      expect(
        isMapping(schema.node) ? schema.node.additionalProperties : undefined,
        'the convert response is not closed',
      ).toBe(false);
      expect(
        props.get('contact')?.node === contactSchema().node,
        'contact is not the Contact schema (field security would not apply)',
      ).toBe(true);
      expect(
        props.get('account')?.node === responseSchema('getAccount', '200').node,
        'account is not the Account schema (account field security would not apply)',
      ).toBe(true);
    });

    it('documents 400, 401, 403 not_permitted, 404 not_found and 409 stale_write', () => {
      const all = responses(operation(CONVERT));
      expect([...all.keys()]).toEqual(expect.arrayContaining(['400', '401', '403', '404', '409']));
      const bad = all.get('400');
      if (bad) {
        expect(
          exampleCodes(bad).filter((code) => code !== 'validation_failed'),
          '400 examples',
        ).toEqual([]);
      }
      const forbidden = all.get('403');
      if (forbidden) {
        const codes = exampleCodes(forbidden);
        expect(codes.length, '403 has no example naming its code').toBeGreaterThan(0);
        expect(
          codes.filter((code) => code !== 'not_permitted'),
          '403 examples',
        ).toEqual([]);
      }
      const missing = all.get('404');
      if (missing) {
        expect(
          exampleCodes(missing).filter((code) => code !== 'not_found'),
          '404 examples',
        ).toEqual([]);
      }
      const conflict = all.get('409');
      if (conflict) expect(exampleCodes(conflict), '409 examples').toContain('stale_write');
    });

    it("an account out of reach is the same 404 as a contact out of reach, and must be in the contact's programme", () => {
      const op = operation(CONVERT);
      const found = paragraphs(op).some(
        (paragraph) =>
          /\b404\b|not_found/.test(paragraph) &&
          /\baccount/i.test(paragraph) &&
          /\b(another|other|different)\b[^.]{0,40}\bprogramme/i.test(paragraph),
      );
      expect(
        found,
        'no paragraph says an account in another programme is answered 404 like a missing one',
      ).toBe(true);
      expect(description(op), "the description never names the contact's programme").toMatch(
        /contact['’]s programme/i,
      );
    });

    it('says one transaction, one audit event, idempotent, and how a repeat meets the version check', () => {
      const op = operation(CONVERT);
      const text = description(op).replace(/\s+/g, ' ');
      expect(text, 'one transaction').toMatch(/\b(one|single|same)\b[^.]{0,30}\btransaction\b/i);
      expect(text, 'one audit event').toMatch(
        /\b(one|single|exactly one)\b[^.]{0,20}\baudit event/i,
      );
      expect(text, 'idempotent').toMatch(/idempot/i);
      // A retry after a lost response carries the version the first call made stale.
      expect(
        paragraphs(op).some(
          (paragraph) =>
            /repeat|retr(y|ied|ies)|idempot/i.test(paragraph) &&
            /\bversion\b|stale_write/.test(paragraph),
        ),
        'no paragraph says how a repeated convert meets the version check',
      ).toBe(true);
    });

    it('names the permissions and field security it needs', () => {
      const text = description(operation(CONVERT));
      expect(text, 'contact.write').toMatch(/contact\.write/);
      expect(text, 'account.write (D-P18: account writes are admin-only)').toMatch(
        /account\.write/,
      );
      expect(text, 'field_not_editable').toMatch(/field_not_editable/);
      expect(text, 'accountId').toMatch(/\baccountId\b/);
      expect(text, 'status').toMatch(/\bstatus\b/);
    });

    it('says what happens to a customer and to a contact already linked to an account', () => {
      const text = description(operation(CONVERT));
      expect(text, 'a customer is never quietly demoted to qualified').toMatch(/\bcustomer/);
      expect(text, 'a contact that already has an account').toMatch(/\balready\b/i);
    });
  });

  describe('Merge, Lead score, Map and Health are not built (D-L69, D-P12)', () => {
    it('no Contact-shaped schema and no convert response carries a score, health or rating', () => {
      leadsOperations(); // Gate: this holds on main, before the work starts.
      const offending = deepKeys(contactSchema()).filter((path) => SCORE_LIKE.test(leaf(path)));
      const success = [...responses(operation(CONVERT)).entries()].find(([code]) =>
        /^2\d\d$/.test(code),
      );
      const converted = success ? jsonSchema(success[1]) : undefined;
      if (converted) {
        offending.push(
          ...deepKeys(converted)
            .filter((path) => SCORE_LIKE.test(leaf(path)))
            .map((path) => `convert: ${path}`),
        );
      }
      expect(offending).toEqual([]);
    });

    it('any merge, score, health or map operation is a 501 stub naming a P04 frame and its module', () => {
      leadsOperations(); // Gate: with no stubs this holds on main.
      const problems: string[] = [];
      for (const op of operations()) {
        const label = unbuiltLabel(op);
        if (label === undefined) continue;
        const entry = UNBUILT.find((candidate) => candidate.label === label);
        if (op.op['x-kasuwa-implemented'] !== false) {
          problems.push(`${op.id}: not x-kasuwa-implemented: false`);
        }
        const codes = [...responses(op).keys()];
        if (!codes.includes('501')) problems.push(`${op.id}: documents no 501`);
        if (!codes.includes('401')) problems.push(`${op.id}: documents no 401`);
        const notImplemented = responses(op).get('501');
        if (notImplemented) {
          const stray = exampleCodes(notImplemented).filter((code) => code !== 'not_implemented');
          if (stray.length > 0) problems.push(`${op.id}: 501 examples ${JSON.stringify(stray)}`);
        }
        if (!screensOf(op).some((screen) => P04_FRAME.test(screen))) {
          problems.push(`${op.id}: names no P04 frame`);
        }
        if (entry?.waitsFor && !entry.waitsFor.test(description(op))) {
          problems.push(`${op.id} (${label}): description does not name ${String(entry.waitsFor)}`);
        }
      }
      expect(problems).toEqual([]);
      // Legitimately vacuous for merge and score when they are simply absent
      // (D-L69 allows "501 or absent"); getAccountMap exists today and is checked.
    });
  });

  describe('errors and scope on every operation this slice adds', () => {
    it("every error response uses getContact's Error schema", () => {
      const shared = jsonSchema(responses(operation('getContact')).get('404'));
      if (!shared) throw new Error('getContact 404 has no schema to compare against');
      const strays: string[] = [];
      let count = 0;
      for (const op of leadsOperations()) {
        for (const [code, response] of responses(op)) {
          if (!/^[45]\d\d$/.test(code) && code !== 'default') continue;
          count += 1;
          const schema = jsonSchema(response);
          if (!schema) strays.push(`${op.id} ${code}: no application/json schema`);
          else if (schema.node !== shared.node) strays.push(`${op.id} ${code}: a different schema`);
        }
      }
      expect(strays).toEqual([]);
      // listLeads 400/401 and convert 400/401/403/404/409.
      expect(count, 'error responses inspected').toBeGreaterThanOrEqual(7);
    });

    it('no new operation takes a programme, tenant, scope or business-unit argument', () => {
      const SCOPE_NAME = /programme|tenant|scope|business[-_]?unit|^bu$/i;
      const offending: string[] = [];
      let checked = 0;
      for (const op of leadsOperations()) {
        if (/\/(programmes|tenants|business-units)(\/|$)/i.test(op.path)) {
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
      // listLeads alone has q, status, sort, cursor and limit; convert a path id.
      expect(checked, 'parameters inspected').toBeGreaterThanOrEqual(6);
    });

    it('every new operation is authenticated, carries x-kasuwa-implemented and names a P04 frame', () => {
      const doc = spec();
      expect(Array.isArray(doc.security) && doc.security.length > 0, 'no global security').toBe(
        true,
      );
      const problems: string[] = [];
      for (const op of leadsOperations()) {
        if (typeof op.op['x-kasuwa-implemented'] !== 'boolean') {
          problems.push(`${op.id}: x-kasuwa-implemented is not a boolean`);
        }
        const screens = screensOf(op);
        if (screens.some((screen) => !SCREEN_ID.test(screen))) {
          problems.push(`${op.id}: bad screen id in ${JSON.stringify(screens)}`);
        }
        if (!screens.some((screen) => P04_FRAME.test(screen))) {
          problems.push(`${op.id}: names no P04 frame (${JSON.stringify(screens)})`);
        }
        if (!responses(op).has('401')) problems.push(`${op.id}: documents no 401`);
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
});
