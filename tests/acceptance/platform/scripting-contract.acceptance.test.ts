import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * ACCEPTANCE — T-0112, the in-call script contract, manual mode (P10; D-L88,
 * D-P31, D-P32, D-P14, D-L40, ADR-0003). Agent 6. Contract only: no route, no
 * migration, no code.
 *
 * The artefact under test is `docs/api/scripting.openapi.yaml`. This suite
 * reads it as data (parsed YAML, so a keyword in a comment satisfies nothing),
 * in the style of the records contract suites, and pins what T-0113 (authoring
 * API), T-0114 (runs API), T-0115 (builder) and T-0116 (agent screen) build
 * against. The one raw-text check is the telephony-name scan, where a name in
 * a comment is as much a breach of CLAUDE.md 2.8 as one in a description.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT THIS SUITE PINS
 * ---------------------------------------------------------------------------
 *
 *   Authoring (`x-kasuwa-permission: script.write`, frame P10/05):
 *     listScripts           GET   /api/v1/scripts
 *     createScript          POST  /api/v1/scripts
 *     getScript             GET   /api/v1/scripts/{scriptId}
 *     updateScript          PATCH /api/v1/scripts/{scriptId}
 *     listScriptVersions    GET   /api/v1/scripts/{scriptId}/versions
 *     publishScript         POST  /api/v1/scripts/{scriptId}/versions
 *     getScriptVersion      GET   /api/v1/scripts/{scriptId}/versions/{versionId}
 *     putScriptTranslation  PUT   /api/v1/scripts/{scriptId}/translations/{locale}
 *
 *   Runs (`x-kasuwa-permission: script.run`, frames P10/01..P10/04):
 *     listContactScripts         GET   /api/v1/contacts/{contactId}/scripts
 *     startScriptRun             POST  /api/v1/script-runs
 *     getScriptRun               GET   /api/v1/script-runs/{runId}
 *     getScriptRunScript         GET   /api/v1/script-runs/{runId}/script
 *     advanceScriptRun           POST  /api/v1/script-runs/{runId}/advance
 *     acknowledgeScriptRunNode   POST  /api/v1/script-runs/{runId}/acknowledgements
 *     recordScriptRunAnswers     PATCH /api/v1/script-runs/{runId}/answers
 *     listScriptRunDispositions  GET   /api/v1/script-runs/{runId}/dispositions
 *     completeScriptRun          POST  /api/v1/script-runs/{runId}/complete
 *
 *   Exactly these seventeen, every one `x-kasuwa-implemented: false` until
 *   T-0113 and T-0114 serve it. A new operation is a contract change and an
 *   edit to this table, not a silent addition.
 *
 *   P10 frames, numbered from the design's own view and scenario controls
 *   (docs/design/P10, "Kasuwa Scripting.html"): P10/01 agent mid-call (with
 *   the version banner), P10/02 required field missing, P10/03 disposition
 *   (blocked), P10/04 from the start, P10/05 the admin script builder.
 *
 *   Errors: the shared Error schema (admin.openapi.yaml, by $ref, the same
 *   node records uses). `x-kasuwa-error-order` lists `<status> <code>` in the
 *   order decided, always 404, then 403, then 400, then 409 (D-L88); 401
 *   precedes all and is not listed. The list and the documented responses
 *   agree both ways. Reads never document 403.
 *
 *   Every response, errors included, carries `Cache-Control: no-store`.
 *   Lists are `{ data, nextCursor }`, cursor opaque and id-only (D-L80), and
 *   no total or count appears anywhere. The graph is a typed, closed
 *   discriminated union of six node kinds. Answers are `pii`. Nothing writes
 *   a contact field (D-P31). A run pins `versionId`; `latestVersion` is
 *   read-only. Completion refuses unacknowledged compliance and a disposition
 *   that is not live, and the server stamps acknowledgements.
 *
 *   D-L91 (lead rulings on the first draft): completion takes `outcome`
 *   `completed | interrupted`. `interrupted` (a dropped call) excuses the
 *   current node and nodes not yet passed, never creates an acknowledgement,
 *   and the server lists the unread compliance nodes on the run read.
 *   startScriptRun is idempotent per (agent, contact, script) while a run is
 *   `in_progress`: 200 with that run, 201 for a new one. Runs never expire in
 *   Phase 2; a supervisor close waits for the role hierarchy.
 *
 *   D-L91 security review (lead rulings), each pinned in "the D-L91 security
 *   review" block below: `completed` only at an `end` node or on a `stopped`
 *   run, with `endedAtNodeId` recorded (B1); a run is visible to its own
 *   agent only, everyone else 404 (B2); the completion and publish audit
 *   names (M1, minor 13); listProgrammeScripts needs script.write once
 *   backed (M2); retention and erasure with the contact (M3); answers are
 *   `sensitive`; bounds, NUL, size, follow-up horizon, cursor scope,
 *   acknowledgement locale, plain-text wording and sensitive-field refusals.
 *
 * ---------------------------------------------------------------------------
 *
 * D-L23: on main this suite runs before the spec exists. Every test that
 * reads it fails with "docs/api/scripting.openapi.yaml does not exist" rather
 * than crashing at collection. Three self-checks do not read the spec and
 * pass on main by design: they prove this suite's own detectors fire on a
 * planted defect, so that a green detector is not a detector that does
 * nothing.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const SPEC_REL = 'docs/api/scripting.openapi.yaml';
const SPEC_PATH = resolve(repoRoot, SPEC_REL);
const RECORDS_PATH = resolve(repoRoot, 'docs/api/records.openapi.yaml');
const ADMIN_PATH = resolve(repoRoot, 'docs/api/admin.openapi.yaml');

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------
// Loading and $ref resolution (the records suites' loader)
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
  if (error !== null) {
    throw new Error(`${error} — T-0112 has not delivered the scripting contract yet.`);
  }
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
  file: string;
}

function operationsOf(file: string): Operation[] {
  const { doc } = loadDoc(file);
  const paths = isMapping(doc) && isMapping(doc.paths) ? doc.paths : {};
  const out: Operation[] = [];
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = at(rawItem, file).node;
    if (!isMapping(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isMapping(op)) continue;
      const own = Array.isArray(op.parameters) ? op.parameters : [];
      const params = [...shared, ...own]
        .map((parameter) => at(parameter, file).node)
        .filter(isMapping);
      out.push({ id: str(op.operationId), method, path, op, params, file });
    }
  }
  return out;
}

function operations(): Operation[] {
  spec();
  return operationsOf(SPEC_PATH);
}

function operation(id: string): Operation {
  const found = operations().find((candidate) => candidate.id === id);
  if (!found) throw new Error(`operationId ${id} not found in ${SPEC_REL}`);
  return found;
}

function responses(op: Operation): Map<string, Located> {
  const raw = isMapping(op.op.responses) ? op.op.responses : {};
  return new Map(Object.entries(raw).map(([code, value]) => [code, at(value, op.file)]));
}

function media(holder: Located | undefined): Located | undefined {
  if (!holder) return undefined;
  const content = child(holder, 'content');
  return content ? child(content, 'application/json') : undefined;
}

function jsonSchema(holder: Located | undefined): Located | undefined {
  const found = media(holder);
  return found ? child(found, 'schema') : undefined;
}

function requestBody(op: Operation): Located | undefined {
  return op.op.requestBody === undefined ? undefined : at(op.op.requestBody, op.file);
}

function requestSchema(op: Operation): Located | undefined {
  return jsonSchema(requestBody(op));
}

/** Every example value on a media object: `example`, and each `examples[*].value`. */
function exampleValues(holder: Located | undefined): { name: string; value: unknown }[] {
  const found = media(holder);
  if (!found || !isMapping(found.node)) return [];
  const out: { name: string; value: unknown }[] = [];
  if (found.node.example !== undefined) out.push({ name: 'example', value: found.node.example });
  const examples = child(found, 'examples');
  if (examples && isMapping(examples.node)) {
    for (const key of Object.keys(examples.node)) {
      const example = child(examples, key);
      if (example && isMapping(example.node)) out.push({ name: key, value: example.node.value });
    }
  }
  return out;
}

function exampleCodes(holder: Located): string[] {
  return exampleValues(holder)
    .map((entry) => entry.value)
    .filter(isMapping)
    .map((value) => str(value.code));
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

/** A property's own (un-dereferenced) node, where `readOnly` and siblings of `$ref` live. */
function rawProperty(schema: Located, key: string): Mapping | undefined {
  const node = schema.node;
  if (!isMapping(node)) return undefined;
  const props = isMapping(node.properties) ? node.properties : {};
  const raw = props[key];
  return isMapping(raw) ? raw : undefined;
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
  return [...out];
}

function enumOf(schema: Located): unknown[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  if (Array.isArray(node.enum)) return node.enum;
  if (node.const !== undefined) return [node.const];
  const items = child(schema, 'items');
  return items ? enumOf(items) : [];
}

function describedAs(...located: (Located | Mapping | undefined)[]): string {
  return located
    .map((entry) => {
      if (entry === undefined) return '';
      const node = 'node' in entry && 'file' in entry ? (entry as Located).node : entry;
      return isMapping(node) ? str(node.description) : '';
    })
    .join('\n');
}

function schemaOf(id: string, status: string): Located {
  const schema = jsonSchema(responses(operation(id)).get(status));
  if (!schema) throw new Error(`${id} has no ${status} application/json schema`);
  return schema;
}

/**
 * Every schema reachable from `root`, through properties, items, allOf/oneOf/
 * anyOf, additionalProperties and propertyNames, each once. `where` is a
 * readable path for failure messages.
 */
function walkSchemas(root: Located, visit: (where: string, schema: Located) => void): void {
  const seen = new Set<unknown>();
  const queue: { where: string; schema: Located }[] = [{ where: '', schema: root }];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const { where, schema } = next;
    if (!isMapping(schema.node) || seen.has(schema.node)) continue;
    seen.add(schema.node);
    visit(where, schema);
    const node = schema.node;
    const props = child(schema, 'properties');
    if (props && isMapping(props.node)) {
      for (const key of Object.keys(props.node)) {
        const value = child(props, key);
        if (value) queue.push({ where: `${where}.${key}`, schema: value });
      }
    }
    for (const key of ['allOf', 'oneOf', 'anyOf']) {
      const variants = node[key];
      if (Array.isArray(variants)) {
        variants.forEach((variant, index) =>
          queue.push({ where: `${where}<${key}${index}>`, schema: at(variant, schema.file) }),
        );
      }
    }
    for (const key of ['items', 'additionalProperties', 'propertyNames']) {
      const inner = child(schema, key);
      if (inner && isMapping(inner.node)) queue.push({ where: `${where}[${key}]`, schema: inner });
    }
  }
}

/** Every property name declared anywhere under `root`, with where it was found. */
function propertyNamesUnder(root: Located): { where: string; name: string }[] {
  const out: { where: string; name: string }[] = [];
  walkSchemas(root, (where, schema) => {
    const props =
      isMapping(schema.node) && isMapping(schema.node.properties) ? schema.node.properties : {};
    for (const name of Object.keys(props)) out.push({ where, name });
  });
  return out;
}

// ---------------------------------------------------------------------------
// A small JSON Schema checker, for the examples (the mock serves them)
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(declared: string, value: unknown): boolean {
  const actual = jsonType(value);
  return declared === actual || (declared === 'number' && actual === 'integer');
}

/**
 * Checks `value` against the subset of JSON Schema this repo's contracts use.
 * Returns the problems found; an empty list means the value conforms.
 */
function check(schema: Located, value: unknown, where = '$'): string[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  const problems: string[] = [];

  for (const part of Array.isArray(node.allOf) ? node.allOf : []) {
    problems.push(...check(at(part, schema.file), value, where));
  }
  if (Array.isArray(node.oneOf)) {
    const passing = node.oneOf.filter(
      (variant) => check(at(variant, schema.file), value, where).length === 0,
    ).length;
    if (passing !== 1) problems.push(`${where}: matches ${passing} oneOf variants, not 1`);
  }
  if (Array.isArray(node.anyOf)) {
    const passing = node.anyOf.some(
      (variant) => check(at(variant, schema.file), value, where).length === 0,
    );
    if (!passing) problems.push(`${where}: matches no anyOf variant`);
  }

  const declared =
    typeof node.type === 'string'
      ? [node.type]
      : Array.isArray(node.type)
        ? node.type.map(str)
        : [];
  if (declared.length > 0 && !declared.some((type) => typeMatches(type, value))) {
    problems.push(`${where}: is ${jsonType(value)}, expected ${declared.join('|')}`);
    return problems;
  }
  if (Array.isArray(node.enum) && !node.enum.some((option) => option === value)) {
    problems.push(`${where}: ${JSON.stringify(value)} is not one of ${JSON.stringify(node.enum)}`);
  }
  if (node.const !== undefined && node.const !== value) {
    problems.push(`${where}: is not ${JSON.stringify(node.const)}`);
  }

  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof node.minLength === 'number' && length < node.minLength)
      problems.push(`${where}: shorter than ${node.minLength}`);
    if (typeof node.maxLength === 'number' && length > node.maxLength)
      problems.push(`${where}: longer than ${node.maxLength}`);
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern, 'u').test(value)) {
      problems.push(`${where}: ${JSON.stringify(value)} does not match ${node.pattern}`);
    }
    if (node.format === 'uuid' && !UUID.test(value)) problems.push(`${where}: not a uuid`);
    if (node.format === 'date-time' && !DATE_TIME_UTC.test(value))
      problems.push(`${where}: not a UTC date-time with Z`);
    if (node.format === 'date' && !DATE.test(value)) problems.push(`${where}: not a date`);
  }
  if (typeof value === 'number') {
    if (typeof node.minimum === 'number' && value < node.minimum)
      problems.push(`${where}: below ${node.minimum}`);
    if (typeof node.maximum === 'number' && value > node.maximum)
      problems.push(`${where}: above ${node.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === 'number' && value.length < node.minItems)
      problems.push(`${where}: fewer than ${node.minItems} items`);
    if (typeof node.maxItems === 'number' && value.length > node.maxItems)
      problems.push(`${where}: more than ${node.maxItems} items`);
    const items = child(schema, 'items');
    if (items)
      value.forEach((item, index) => problems.push(...check(items, item, `${where}[${index}]`)));
  }
  if (isMapping(value)) {
    const keys = Object.keys(value);
    for (const key of Array.isArray(node.required) ? node.required.map(str) : []) {
      if (!(key in value)) problems.push(`${where}: missing required ${key}`);
    }
    if (typeof node.minProperties === 'number' && keys.length < node.minProperties)
      problems.push(`${where}: fewer than ${node.minProperties} properties`);
    if (typeof node.maxProperties === 'number' && keys.length > node.maxProperties)
      problems.push(`${where}: more than ${node.maxProperties} properties`);
    const props = child(schema, 'properties');
    const declaredProps = props && isMapping(props.node) ? props.node : {};
    // allOf parts declare properties too; a closed schema admits those.
    const allowed = new Set([...Object.keys(declaredProps), ...properties(schema).keys()]);
    const names = child(schema, 'propertyNames');
    for (const key of keys) {
      if (names) problems.push(...check(names, key, `${where}{${key}}`));
      const declaredSchema = props ? child(props, key) : undefined;
      if (declaredSchema) {
        problems.push(...check(declaredSchema, value[key], `${where}.${key}`));
      } else if (node.additionalProperties === false) {
        if (!allowed.has(key)) problems.push(`${where}: unexpected property ${key}`);
      } else if (isMapping(node.additionalProperties)) {
        const extra = child(schema, 'additionalProperties');
        if (extra) problems.push(...check(extra, value[key], `${where}.${key}`));
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Detectors with self-checks
// ---------------------------------------------------------------------------

/**
 * Telephony and contact-centre platforms, their media and SIP components, and
 * the CPaaS channel providers. CLAUDE.md 2.8: only `packages/telephony-adapter`
 * (and the channel adapters) may name one. Distinctive names only, so the
 * scan never fires on an English word.
 */
const PLATFORM_NAMES = [
  'Genesys',
  'PureCloud',
  'Five9',
  'Avaya',
  'CXone',
  'inContact',
  'Talkdesk',
  'Twilio',
  'Vonage',
  'Nexmo',
  'Amazon Connect',
  'RingCentral',
  '8x8',
  'Aircall',
  'Asterisk',
  'FreeSWITCH',
  'Kamailio',
  'rtpengine',
  'OpenSIPS',
  'Vicidial',
  '3CX',
  'Ozonetel',
  'Exotel',
  'Mitel',
  'Cisco',
  'Webex',
  'UCCX',
  'Dialpad',
  'Plivo',
  'Sinch',
  'Infobip',
  'Telnyx',
  'Knowlarity',
  'Freshcaller',
  'Alvaria',
  'Convoso',
  'Enghouse',
  'Ameyo',
  'Puzzel',
  'Vocalcom',
  "Africa's Talking",
  'Africastalking',
  'Termii',
  'Hubtel',
];

function platformNamesIn(text: string): string[] {
  return PLATFORM_NAMES.filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, 'i').test(text);
  });
}

/** A cursor that is base64url JSON must hold `{ id }` and nothing else (D-L80). */
function cursorProblems(cursor: string): string[] {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return [`${cursor}: not base64url`];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return [`${cursor}: does not decode to JSON (${decoded.slice(0, 40)})`];
  }
  if (!isMapping(parsed)) return [`${cursor}: decodes to ${jsonType(parsed)}, not an object`];
  const keys = Object.keys(parsed);
  const problems: string[] = [];
  if (keys.length !== 1 || keys[0] !== 'id')
    problems.push(`${cursor}: carries ${keys.join(', ')}, not id alone`);
  if (!UUID.test(str(parsed.id))) problems.push(`${cursor}: id is not a uuid`);
  return problems;
}

// ---------------------------------------------------------------------------
// The pinned table
// ---------------------------------------------------------------------------

interface Expected {
  id: string;
  method: string;
  path: string;
  permission: 'script.write' | 'script.run';
  screens: string[];
  errors: string[];
  audited: boolean;
}

const SCRIPT = '/api/v1/scripts/{scriptId}';
const RUN = '/api/v1/script-runs/{runId}';
const BUILDER = ['P10/05'];

const EXPECTED: Expected[] = [
  {
    id: 'listScripts',
    method: 'get',
    path: '/api/v1/scripts',
    permission: 'script.write',
    screens: BUILDER,
    audited: false,
    errors: ['400 validation_failed'],
  },
  {
    id: 'createScript',
    method: 'post',
    path: '/api/v1/scripts',
    permission: 'script.write',
    screens: BUILDER,
    audited: true,
    errors: ['404 not_found', '403 not_permitted', '400 validation_failed'],
  },
  {
    id: 'getScript',
    method: 'get',
    path: SCRIPT,
    permission: 'script.write',
    screens: BUILDER,
    audited: false,
    errors: ['404 not_found', '400 validation_failed'],
  },
  {
    id: 'updateScript',
    method: 'patch',
    path: SCRIPT,
    permission: 'script.write',
    screens: BUILDER,
    audited: true,
    errors: ['404 not_found', '400 validation_failed', '409 stale_write'],
  },
  {
    id: 'listScriptVersions',
    method: 'get',
    path: `${SCRIPT}/versions`,
    permission: 'script.write',
    screens: BUILDER,
    audited: false,
    errors: ['404 not_found', '400 validation_failed'],
  },
  {
    id: 'publishScript',
    method: 'post',
    path: `${SCRIPT}/versions`,
    permission: 'script.write',
    screens: BUILDER,
    audited: true,
    errors: ['404 not_found', '400 validation_failed', '409 stale_write', '409 script_invalid'],
  },
  {
    id: 'getScriptVersion',
    method: 'get',
    path: `${SCRIPT}/versions/{versionId}`,
    permission: 'script.write',
    screens: BUILDER,
    audited: false,
    errors: ['404 not_found', '400 validation_failed'],
  },
  {
    id: 'putScriptTranslation',
    method: 'put',
    path: `${SCRIPT}/translations/{locale}`,
    permission: 'script.write',
    screens: BUILDER,
    audited: true,
    errors: ['404 not_found', '400 validation_failed', '409 stale_write'],
  },
  {
    id: 'listContactScripts',
    method: 'get',
    path: '/api/v1/contacts/{contactId}/scripts',
    permission: 'script.run',
    screens: ['P10/04'],
    audited: false,
    errors: ['404 not_found', '400 validation_failed'],
  },
  {
    id: 'startScriptRun',
    method: 'post',
    path: '/api/v1/script-runs',
    permission: 'script.run',
    screens: ['P10/04'],
    audited: true,
    // D-L91 review, minor 1: the 403 is decided on the contact's programme
    // BEFORE the script is looked up, so the script's 404 follows it.
    errors: [
      '404 not_found (contact)',
      '403 not_permitted',
      '404 not_found (script)',
      '400 validation_failed',
      '409 script_not_published',
    ],
  },
  {
    id: 'getScriptRun',
    method: 'get',
    path: RUN,
    permission: 'script.run',
    screens: ['P10/01', 'P10/02', 'P10/03'],
    audited: false,
    errors: ['404 not_found', '400 validation_failed'],
  },
  {
    id: 'getScriptRunScript',
    method: 'get',
    path: `${RUN}/script`,
    permission: 'script.run',
    screens: ['P10/01', 'P10/04'],
    audited: false,
    errors: ['404 not_found', '400 validation_failed'],
  },
  {
    id: 'advanceScriptRun',
    method: 'post',
    path: `${RUN}/advance`,
    permission: 'script.run',
    screens: ['P10/01', 'P10/02'],
    audited: false,
    errors: [
      '404 not_found',
      '403 not_permitted',
      '400 validation_failed',
      '409 run_completed',
      '409 run_stopped',
      '409 stale_write',
      '409 run_at_end',
      '409 compliance_unacknowledged',
      '409 answers_incomplete',
    ],
  },
  {
    id: 'acknowledgeScriptRunNode',
    method: 'post',
    path: `${RUN}/acknowledgements`,
    permission: 'script.run',
    screens: ['P10/01'],
    audited: true,
    errors: [
      '404 not_found',
      '403 not_permitted',
      '400 validation_failed',
      '409 run_completed',
      '409 run_stopped',
      '409 stale_write',
    ],
  },
  {
    id: 'recordScriptRunAnswers',
    method: 'patch',
    path: `${RUN}/answers`,
    permission: 'script.run',
    screens: ['P10/02'],
    audited: true,
    errors: [
      '404 not_found',
      '403 not_permitted',
      '400 validation_failed',
      '409 run_completed',
      '409 run_stopped',
      '409 stale_write',
    ],
  },
  {
    id: 'listScriptRunDispositions',
    method: 'get',
    path: `${RUN}/dispositions`,
    permission: 'script.run',
    screens: ['P10/03'],
    audited: false,
    errors: ['404 not_found', '400 validation_failed'],
  },
  {
    id: 'completeScriptRun',
    method: 'post',
    path: `${RUN}/complete`,
    permission: 'script.run',
    screens: ['P10/03'],
    audited: true,
    errors: [
      '404 not_found',
      '403 not_permitted',
      '400 validation_failed',
      '409 run_completed',
      '409 stale_write',
      '409 compliance_unacknowledged',
      '409 disposition_not_live',
      '409 disposition_requirements_unmet',
    ],
  },
];

const LISTS = [
  'listScripts',
  'listScriptVersions',
  'listContactScripts',
  'listScriptRunDispositions',
];
const RUN_WRITES = [
  'startScriptRun',
  'advanceScriptRun',
  'acknowledgeScriptRunNode',
  'recordScriptRunAnswers',
  'completeScriptRun',
];
const STATUS_RANK: Record<string, number> = { '404': 0, '403': 1, '400': 2, '409': 3 };
/** Entries ruled out of the 404 < 403 < 400 < 409 order, each with its ruling. */
const ORDER_EXCEPTIONS = [
  // D-L91 review, minor 1: no oracle on script ids for a caller without script.run.
  'startScriptRun: 404 not_found (script)',
];
/** Run operations: visible to the run's own agent only (D-L91 review, B2). */
const RUN_OPERATIONS = [
  'getScriptRun',
  'getScriptRunScript',
  'advanceScriptRun',
  'acknowledgeScriptRunNode',
  'recordScriptRunAnswers',
  'listScriptRunDispositions',
  'completeScriptRun',
];
const NODE_KINDS = ['say', 'question', 'form', 'branch', 'compliance', 'end'];
const P10_FRAME = /^P10\/0[1-5]$/;

function errorOrder(op: Operation): string[] {
  const raw = op.op['x-kasuwa-error-order'];
  return Array.isArray(raw) ? raw.map(str) : [];
}

function cacheControlSchema(response: Located): Located | undefined {
  const headers = child(response, 'headers');
  if (!headers || !isMapping(headers.node)) return undefined;
  const key = Object.keys(headers.node).find((name) => name.toLowerCase() === 'cache-control');
  const header = key ? child(headers, key) : undefined;
  return header ? child(header, 'schema') : undefined;
}

function contactPropertyNames(): string[] {
  const records = operationsOf(RECORDS_PATH).find((op) => op.id === 'getContact');
  if (!records) throw new Error('records.openapi.yaml has no getContact');
  const schema = jsonSchema(responses(records).get('200'));
  if (!schema) throw new Error('getContact has no 200 schema');
  return [...properties(schema).keys()];
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe('acceptance: scripting contract (T-0112)', () => {
  describe('the document', () => {
    it(`${SPEC_REL} exists and parses as OpenAPI 3.x`, () => {
      const doc = spec();
      expect(str(doc.openapi), 'openapi version').toMatch(/^3\.\d+\.\d+$/);
      const info = isMapping(doc.info) ? doc.info : {};
      expect(str(info.title), 'info.title').not.toBe('');
      expect(str(info.version), 'info.version').not.toBe('');
      expect(isMapping(doc.paths) && Object.keys(doc.paths).length > 0, 'paths is empty').toBe(
        true,
      );
    });

    it('validates as an OpenAPI document: keys, path templates, parameters, responses, tags, security', () => {
      const doc = spec();
      const problems: string[] = [];
      const TOP = [
        'openapi',
        'info',
        'servers',
        'paths',
        'components',
        'security',
        'tags',
        'externalDocs',
        'webhooks',
        'jsonSchemaDialect',
      ];
      for (const key of Object.keys(doc)) {
        if (!TOP.includes(key) && !key.startsWith('x-'))
          problems.push(`unknown top-level key ${key}`);
      }
      const declaredTags = new Set(
        (Array.isArray(doc.tags) ? doc.tags : []).filter(isMapping).map((tag) => str(tag.name)),
      );
      const components = isMapping(doc.components) ? doc.components : {};
      const schemes = isMapping(components.securitySchemes) ? components.securitySchemes : {};
      const requirements = [doc.security, ...operations().map((op) => op.op.security)];
      for (const list of requirements) {
        for (const requirement of Array.isArray(list) ? list : []) {
          for (const name of isMapping(requirement) ? Object.keys(requirement) : []) {
            if (!(name in schemes)) problems.push(`security names undeclared scheme ${name}`);
          }
        }
      }
      for (const op of operations()) {
        if (!op.path.startsWith('/')) problems.push(`${op.path} does not start with /`);
        const templated = [...op.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? '');
        const pathParams = op.params.filter((parameter) => parameter.in === 'path');
        for (const name of templated) {
          const declared = pathParams.filter((parameter) => parameter.name === name);
          if (declared.length !== 1)
            problems.push(`${op.id}: {${name}} declared ${declared.length} times`);
          if (declared[0] && declared[0].required !== true)
            problems.push(`${op.id}: {${name}} not required`);
        }
        for (const parameter of pathParams) {
          if (!templated.includes(str(parameter.name)))
            problems.push(`${op.id}: path parameter ${str(parameter.name)} is not in the path`);
        }
        for (const parameter of op.params) {
          if (str(parameter.name) === '') problems.push(`${op.id}: a parameter has no name`);
          if (!['query', 'header', 'path', 'cookie'].includes(str(parameter.in)))
            problems.push(`${op.id}: ${str(parameter.name)} in ${str(parameter.in)}`);
          if (parameter.schema === undefined && parameter.content === undefined)
            problems.push(`${op.id}: ${str(parameter.name)} has no schema`);
        }
        const body = requestBody(op);
        if (body && !isMapping(child(body, 'content')?.node))
          problems.push(`${op.id}: requestBody has no content`);
        const all = responses(op);
        if (![...all.keys()].some((code) => /^2\d\d$/.test(code)))
          problems.push(`${op.id}: no 2xx response`);
        for (const [code, response] of all) {
          if (!/^[1-5]\d\d$|^[1-5]XX$|^default$/.test(code))
            problems.push(`${op.id}: bad status ${code}`);
          if (!isMapping(response.node) || str(response.node.description) === '')
            problems.push(`${op.id} ${code}: no description`);
        }
        for (const tag of Array.isArray(op.op.tags) ? op.op.tags.map(str) : []) {
          if (!declaredTags.has(tag)) problems.push(`${op.id}: undeclared tag ${tag}`);
        }
      }
      // Discriminators: every mapping target resolves, and each variant pins
      // the discriminator to its own key (required, single-value enum).
      const schemas = isMapping(components.schemas) ? components.schemas : {};
      let discriminators = 0;
      for (const [name, raw] of Object.entries(schemas)) {
        const schema = at(raw);
        if (!isMapping(schema.node)) continue;
        const declaredType = schema.node.type;
        const validTypes = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];
        for (const type of Array.isArray(declaredType)
          ? declaredType
          : declaredType === undefined
            ? []
            : [declaredType]) {
          if (!validTypes.includes(str(type))) problems.push(`${name}: type ${String(type)}`);
        }
        const props = isMapping(schema.node.properties) ? Object.keys(schema.node.properties) : [];
        if (props.length > 0 && !Array.isArray(schema.node.allOf)) {
          for (const key of required(schema)) {
            if (!props.includes(key)) problems.push(`${name}: requires undeclared ${key}`);
          }
        }
        const discriminator = isMapping(schema.node.discriminator)
          ? schema.node.discriminator
          : undefined;
        if (!discriminator) continue;
        discriminators += 1;
        const property = str(discriminator.propertyName);
        const mapping = isMapping(discriminator.mapping) ? discriminator.mapping : {};
        for (const [key, target] of Object.entries(mapping)) {
          const variant = resolveRef(str(target), SPEC_PATH);
          if (!variant) {
            problems.push(`${name}: mapping ${key} does not resolve`);
            continue;
          }
          const located = at(variant.node, variant.file);
          const own = properties(located).get(property);
          if (!required(located).includes(property))
            problems.push(`${name}.${key}: ${property} not required`);
          if (!own || JSON.stringify(enumOf(own)) !== JSON.stringify([key]))
            problems.push(`${name}.${key}: ${property} is not [${key}]`);
        }
      }
      expect(problems).toEqual([]);
      expect(
        discriminators,
        'no discriminated union found (the graph is not typed)',
      ).toBeGreaterThan(0);
    });

    it('every $ref resolves, following relative file refs', () => {
      spec();
      const unresolved: string[] = [];
      const seen = new Set<unknown>();
      let refCount = 0;
      const queue: Located[] = [{ node: loadDoc(SPEC_PATH).doc, file: SPEC_PATH }];
      while (queue.length > 0) {
        const current = queue.pop();
        if (!current || typeof current.node !== 'object' || current.node === null) continue;
        if (seen.has(current.node)) continue;
        seen.add(current.node);
        if (Array.isArray(current.node)) {
          current.node.forEach((node) => queue.push({ node, file: current.file }));
          continue;
        }
        const node = current.node as Mapping;
        if (typeof node.$ref === 'string') {
          refCount += 1;
          const target = resolveRef(node.$ref, current.file);
          if (target === undefined) unresolved.push(`${node.$ref} (in ${posix(current.file)})`);
          else queue.push(target);
        }
        Object.entries(node).forEach(([key, value]) => {
          if (key !== '$ref') queue.push({ node: value, file: current.file });
        });
      }
      expect(unresolved, 'dangling $ref').toEqual([]);
      expect(
        refCount,
        'no $ref at all: the shared Error schema was copied, not referenced',
      ).toBeGreaterThan(0);
    });

    it('(self-check) the example checker rejects a malformed run and accepts a good one', () => {
      // Does not read the spec, so it passes on main. It proves `check` fires.
      const file = SPEC_PATH;
      const schema: Located = {
        file,
        node: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'status', 'answers'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['in_progress', 'stopped', 'completed'] },
            answers: {
              type: 'object',
              propertyNames: { type: 'string', pattern: '^[a-z]+$' },
              additionalProperties: { type: 'integer' },
            },
            at: { type: 'string', format: 'date-time' },
          },
        },
      };
      const good = {
        id: '4a7e2c91-8b3d-4f60-a5e2-7c9d1b0f3e40',
        status: 'stopped',
        answers: { ptp: 1 },
        at: '2026-10-07T13:20:02Z',
      };
      expect(check(schema, good)).toEqual([]);
      const bad = {
        id: 'run-1',
        status: 'paused',
        answers: { PTP: 1.5 },
        at: '2026-10-07 13:20',
        extra: true,
      };
      const found = check(schema, bad).join('\n');
      for (const expected of [
        'not a uuid',
        'not one of',
        'does not match',
        'expected integer',
        'not a UTC date-time',
        'unexpected property extra',
      ]) {
        expect(found, `the checker missed: ${expected}`).toContain(expected);
      }
      expect(check(schema, { id: good.id, status: 'stopped' }).join('\n')).toContain(
        'missing required answers',
      );
    });

    it('every example in the file conforms to the schema it illustrates (the mock serves them)', () => {
      const problems: string[] = [];
      let checked = 0;
      for (const op of operations()) {
        const holders: [string, Located | undefined][] = [
          ['request', requestBody(op)],
          ...[...responses(op)].map(([code, response]): [string, Located] => [code, response]),
        ];
        for (const [label, holder] of holders) {
          const schema = jsonSchema(holder);
          if (!schema) continue;
          for (const { name, value } of exampleValues(holder)) {
            checked += 1;
            for (const problem of check(schema, value))
              problems.push(`${op.id} ${label} ${name}: ${problem}`);
          }
        }
      }
      expect(problems).toEqual([]);
      // Every operation has at least its error examples; zero means none were found.
      expect(checked, 'no examples were checked').toBeGreaterThan(30);
    });
  });

  describe('every operation, its operationId and its security', () => {
    it('exactly the seventeen operations, no more', () => {
      const ids = operations().map((op) => op.id);
      expect(
        ids.filter((id) => id === ''),
        'an operation has no operationId',
      ).toEqual([]);
      expect(
        ids.filter((id, index) => ids.indexOf(id) !== index),
        'duplicate operationId',
      ).toEqual([]);
      expect([...ids].sort()).toEqual(EXPECTED.map((entry) => entry.id).sort());
    });

    for (const expected of EXPECTED) {
      it(`${expected.id} is ${expected.method.toUpperCase()} ${expected.path}, needs ${expected.permission}, and names its P10 frames`, () => {
        const op = operation(expected.id);
        expect(op.method, 'method').toBe(expected.method);
        expect(op.path, 'path').toBe(expected.path);
        expect(op.op['x-kasuwa-permission'], 'x-kasuwa-permission').toBe(expected.permission);
        const screens = Array.isArray(op.op['x-kasuwa-screens'])
          ? op.op['x-kasuwa-screens'].map(str)
          : [];
        expect(
          screens.filter((screen) => !P10_FRAME.test(screen)),
          'a screen id outside P10/01..05',
        ).toEqual([]);
        expect(screens, 'x-kasuwa-screens').toEqual(expect.arrayContaining(expected.screens));
        expect(op.op['x-kasuwa-audited'] === true, 'x-kasuwa-audited').toBe(expected.audited);
      });
    }

    it('every operation is authenticated by the session token and none opts out', () => {
      const doc = spec();
      const components = isMapping(doc.components) ? doc.components : {};
      const schemes = isMapping(components.securitySchemes) ? components.securitySchemes : {};
      const token = isMapping(schemes.sessionToken) ? schemes.sessionToken : {};
      expect([token.type, token.scheme], 'sessionToken is http bearer').toEqual(['http', 'bearer']);
      expect(doc.security, 'global security').toEqual([{ sessionToken: [] }]);
      for (const op of operations()) {
        const effective = op.op.security ?? doc.security;
        expect(effective, `${op.id} effective security`).toEqual([{ sessionToken: [] }]);
      }
    });

    it('every path is x-kasuwa-implemented: false until T-0113 and T-0114 serve it', () => {
      const offending = operations()
        .filter((op) => op.op['x-kasuwa-implemented'] !== false)
        .map((op) => `${op.id}: ${String(op.op['x-kasuwa-implemented'])}`);
      expect(offending).toEqual([]);
      expect(operations().length).toBe(EXPECTED.length);
    });

    it('a record id in a path is one required uuid; the locale is the ScriptLocale enum', () => {
      const problems: string[] = [];
      for (const op of operations()) {
        for (const parameter of op.params.filter((candidate) => candidate.in === 'path')) {
          const schema = at(parameter.schema ?? {});
          const node = isMapping(schema.node) ? schema.node : {};
          if (parameter.name === 'locale') {
            if (
              JSON.stringify(enumOf(schema)) !==
              JSON.stringify(['en', 'fr', 'pcm', 'ha', 'yo', 'ig', 'sw'])
            ) {
              problems.push(`${op.id}: locale enum ${JSON.stringify(enumOf(schema))}`);
            }
          } else if (node.format !== 'uuid' || !/Id$/.test(str(parameter.name))) {
            problems.push(`${op.id}: ${str(parameter.name)} is not a uuid record id`);
          }
        }
      }
      expect(problems).toEqual([]);
    });
  });

  describe('errors: the shared envelope, the codes and their order', () => {
    function errorResponses(): {
      label: string;
      status: string;
      response: Located;
      schema: Located;
    }[] {
      const out: { label: string; status: string; response: Located; schema: Located }[] = [];
      for (const op of operations()) {
        for (const [status, response] of responses(op)) {
          if (!/^[45]\d\d$/.test(status) && status !== 'default') continue;
          const schema = jsonSchema(response);
          if (!schema) throw new Error(`${op.id} ${status} has no application/json schema`);
          out.push({ label: `${op.id} ${status}`, status, response, schema });
        }
      }
      return out;
    }

    it('every error response uses the Error schema records uses (admin.openapi.yaml, by $ref)', () => {
      const all = errorResponses();
      expect(all.length, 'no error responses at all').toBeGreaterThan(0);
      const distinct = new Set(all.map((entry) => entry.schema.node));
      expect(distinct.size, 'error responses use more than one schema').toBe(1);
      const records = operationsOf(RECORDS_PATH).find((op) => op.id === 'getContact');
      const recordsError = records ? jsonSchema(responses(records).get('404')) : undefined;
      expect(recordsError, 'records getContact 404 schema').toBeDefined();
      expect(all[0]?.schema.node === recordsError?.node, 'not the same Error node as records').toBe(
        true,
      );
      expect(posix(all[0]?.schema.file ?? ''), 'Error lives in admin.openapi.yaml').toBe(
        'docs/api/admin.openapi.yaml',
      );
    });

    it('every error example uses a code in the Error enum, and its details carry no value', () => {
      const [first] = errorResponses();
      const codes = first ? enumOf(properties(first.schema).get('code') ?? at({})).map(str) : [];
      expect(codes.length, 'Error.code has no enum').toBeGreaterThan(0);
      const strays: string[] = [];
      for (const { label, response } of errorResponses()) {
        for (const { name, value } of exampleValues(response)) {
          if (!isMapping(value)) continue;
          if (!codes.includes(str(value.code))) strays.push(`${label} ${name}: ${str(value.code)}`);
          for (const detail of Array.isArray(value.details) ? value.details : []) {
            const keys = isMapping(detail) ? Object.keys(detail) : [];
            if (keys.some((key) => key !== 'path' && key !== 'code'))
              strays.push(`${label} ${name}: details carry ${keys.join(',')}`);
          }
        }
      }
      expect(strays).toEqual([]);
    });

    it('every operation documents 401 not_authenticated', () => {
      for (const op of operations()) {
        const unauthenticated = responses(op).get('401');
        expect(unauthenticated, `${op.id} 401`).toBeDefined();
        if (unauthenticated)
          expect(exampleCodes(unauthenticated), `${op.id} 401 code`).toEqual(['not_authenticated']);
      }
    });

    for (const expected of EXPECTED) {
      it(`${expected.id} documents exactly ${expected.errors.length} failures, in the pinned order`, () => {
        const op = operation(expected.id);
        const order = errorOrder(op);
        expect(order, 'x-kasuwa-error-order').toEqual(expected.errors);

        // Always 404, then 403, then 400, then 409 (D-L88). The one ruled
        // exception is ORDER_EXCEPTIONS (startScriptRun's script 404).
        const ranks = order
          .filter((entry) => !ORDER_EXCEPTIONS.includes(`${expected.id}: ${entry}`))
          .map((entry) => STATUS_RANK[entry.split(' ')[0] ?? ''] ?? 99);
        expect(ranks, 'the order is not 404 < 403 < 400 < 409').toEqual(
          [...ranks].sort((a, b) => a - b),
        );

        // Both ways: each listed failure is a documented response whose
        // examples name its code, and every documented 4xx code but 401 is listed.
        const all = responses(op);
        for (const entry of order) {
          const [status = '', code = ''] = entry.split(' ');
          const response = all.get(status);
          expect(
            response,
            `${expected.id} lists ${entry} but documents no ${status}`,
          ).toBeDefined();
          if (response)
            expect(exampleCodes(response), `${expected.id} ${status} examples`).toContain(code);
        }
        const documented = [...all]
          .filter(([status]) => /^4\d\d$/.test(status) && status !== '401')
          .flatMap(([status, response]) =>
            exampleCodes(response).map((code) => `${status} ${code}`),
          );
        const listed = [...new Set(order.map((entry) => entry.split(' ').slice(0, 2).join(' ')))];
        expect([...new Set(documented)].sort(), 'documented 4xx codes').toEqual(listed.sort());
      });
    }

    it('a read never documents 403; 404 is only not_found, 403 only not_permitted, 400 only validation_failed', () => {
      const problems: string[] = [];
      for (const op of operations()) {
        const all = responses(op);
        if (op.method === 'get' && all.has('403')) problems.push(`${op.id}: a read documents 403`);
        const only: [string, string][] = [
          ['404', 'not_found'],
          ['403', 'not_permitted'],
          ['400', 'validation_failed'],
        ];
        for (const [status, code] of only) {
          const response = all.get(status);
          for (const found of response ? exampleCodes(response) : []) {
            if (found !== code) problems.push(`${op.id} ${status}: ${found}`);
          }
        }
      }
      expect(problems).toEqual([]);
    });
  });

  describe('no-store on every response', () => {
    it('every response of every operation, errors included, is Cache-Control: no-store', () => {
      const problems: string[] = [];
      let checked = 0;
      for (const op of operations()) {
        for (const [status, response] of responses(op)) {
          checked += 1;
          const schema = cacheControlSchema(response);
          const values = schema ? enumOf(schema) : [];
          if (JSON.stringify(values) !== JSON.stringify(['no-store'])) {
            problems.push(
              `${op.id} ${status}: Cache-Control ${schema ? JSON.stringify(values) : 'missing'}`,
            );
          }
        }
      }
      expect(problems).toEqual([]);
      expect(checked, 'responses inspected').toBeGreaterThanOrEqual(EXPECTED.length * 3);
    });
  });

  describe('keyset lists: id-only opaque cursors and no totals anywhere', () => {
    for (const id of LISTS) {
      it(`${id}: an opaque, id-only cursor and a limit of at most 100; no offset or page`, () => {
        const op = operation(id);
        const cursor = op.params.find(
          (parameter) => parameter.in === 'query' && parameter.name === 'cursor',
        );
        expect(cursor, `${id} has no cursor`).toBeDefined();
        if (cursor) {
          const text = `${str(cursor.description)}\n${describedAs(at(cursor.schema ?? {}))}`;
          expect(types(at(cursor.schema ?? {})), 'cursor type').toContain('string');
          expect(text, 'cursor not documented as opaque').toMatch(/opaque/i);
          expect(text, 'cursor not documented as carrying the id only').toMatch(
            /\bid\b[^.]*\b(only|nothing else)\b/i,
          );
          expect(text, 'cursor does not cite D-L80').toMatch(/D-L80/);
        }
        const limit = op.params.find(
          (parameter) => parameter.in === 'query' && parameter.name === 'limit',
        );
        expect(limit, `${id} has no limit`).toBeDefined();
        const limitNode = limit ? at(limit.schema ?? {}).node : undefined;
        if (isMapping(limitNode)) {
          expect(limitNode.type, 'limit type').toBe('integer');
          expect(limitNode.minimum, 'limit minimum').toBe(1);
          expect(Number(limitNode.maximum), 'limit maximum').toBeLessThanOrEqual(100);
        }
        const offsetLike = op.params
          .map((parameter) => str(parameter.name))
          .filter((name) =>
            /^(offset|skip|page|pageNumber|pageNo|pageIndex|start|total|includeTotal|count)$/i.test(
              name,
            ),
          );
        expect(offsetLike, 'offset paging or a total on request').toEqual([]);
      });

      it(`${id}: the 200 is a closed { data: [], nextCursor: string | null }`, () => {
        const page = schemaOf(id, '200');
        const props = properties(page);
        expect([...props.keys()].sort()).toEqual(['data', 'nextCursor']);
        expect(required(page).sort()).toEqual(['data', 'nextCursor']);
        expect(
          isMapping(page.node) ? page.node.additionalProperties : undefined,
          'page is closed',
        ).toBe(false);
        expect(types(props.get('data') ?? at({})), 'data').toContain('array');
        expect(types(props.get('nextCursor') ?? at({})).sort(), 'nextCursor').toEqual([
          'null',
          'string',
        ]);
      });
    }

    it('(self-check) the cursor decoder accepts { id } and rejects a cursor carrying a name', () => {
      // Does not read the spec, so it passes on main. It proves the next test can fail.
      const good = Buffer.from(
        JSON.stringify({ id: '6c3a9e10-5b2d-4f71-9a8e-0d4c2b7f1a03' }),
      ).toString('base64url');
      expect(cursorProblems(good)).toEqual([]);
      const named = Buffer.from(
        JSON.stringify({ name: 'Adaeze Okonkwo', id: '6c3a9e10-5b2d-4f71-9a8e-0d4c2b7f1a03' }),
      ).toString('base64url');
      expect(cursorProblems(named).join('\n')).toContain('not id alone');
      expect(cursorProblems('bm90IGpzb24').join('\n')).toContain('does not decode to JSON');
    });

    it('every non-null nextCursor example holds the last row id and nothing else (D-L80)', () => {
      const problems: string[] = [];
      let cursors = 0;
      for (const id of LISTS) {
        for (const { name, value } of exampleValues(responses(operation(id)).get('200'))) {
          if (!isMapping(value) || value.nextCursor === null || value.nextCursor === undefined)
            continue;
          cursors += 1;
          const rows = Array.isArray(value.data) ? value.data : [];
          const last = rows[rows.length - 1];
          for (const problem of cursorProblems(str(value.nextCursor)))
            problems.push(`${id} ${name}: ${problem}`);
          const decoded = JSON.parse(
            Buffer.from(str(value.nextCursor), 'base64url').toString('utf8') || 'null',
          ) as unknown;
          if (isMapping(decoded) && isMapping(last) && decoded.id !== last.id) {
            problems.push(`${id} ${name}: the cursor is not the last row's id`);
          }
        }
      }
      expect(problems).toEqual([]);
      expect(
        cursors,
        'no list example shows a next page, so the cursor rule is unproven',
      ).toBeGreaterThan(0);
    });

    it('no response schema anywhere carries a total, count or offset', () => {
      const offending: string[] = [];
      let names = 0;
      for (const op of operations()) {
        for (const [status, response] of responses(op)) {
          const schema = jsonSchema(response);
          if (!schema || /^[45]/.test(status)) continue;
          for (const { where, name } of propertyNamesUnder(schema)) {
            names += 1;
            if (/total|count|^offset$|^page(Number|Index|Size)?$|hasMore/i.test(name))
              offending.push(`${op.id} ${status}${where}.${name}`);
          }
        }
      }
      expect(offending).toEqual([]);
      expect(names, 'no response properties inspected').toBeGreaterThan(50);
    });
  });

  describe('scope comes from the session only', () => {
    const SCOPE_NAME = /programme[-_]?ids?|tenant[-_]?ids?|(^|[-_])scope|business[-_]?unit/i;

    it('no operation takes a programme, tenant or scope argument in a path, query, header or cookie', () => {
      const offending: string[] = [];
      let checked = 0;
      for (const op of operations()) {
        for (const parameter of op.params) {
          checked += 1;
          const name = str(parameter.name);
          if (SCOPE_NAME.test(name) || (parameter.in === 'header' && /^x-kasuwa-/i.test(name))) {
            offending.push(`${op.id}: ${str(parameter.in)} ${name}`);
          }
        }
      }
      expect(offending).toEqual([]);
      expect(checked, 'no parameters inspected').toBeGreaterThan(EXPECTED.length);
    });

    it('no request body carries tenantId, programmeIds or scope, at any depth; only createScript names a programme', () => {
      const offending: string[] = [];
      for (const op of operations()) {
        const body = requestSchema(op);
        if (!body) continue;
        for (const { where, name } of propertyNamesUnder(body)) {
          if (/^tenant[-_]?ids?$|^programme[-_]?ids$|^scope$|^businessUnitIds?$/i.test(name))
            offending.push(`${op.id}${where}.${name}`);
          if (/^programme[-_]?id$/i.test(name) && !(op.id === 'createScript' && where === ''))
            offending.push(`${op.id}${where}.${name}`);
        }
      }
      expect(offending).toEqual([]);
      expect(
        [...properties(requestSchema(operation('createScript')) ?? at({})).keys()],
        'createScript target',
      ).toContain('programmeId');
      expect(errorOrder(operation('createScript'))[0], 'an unreachable target programme').toBe(
        '404 not_found',
      );
    });
  });

  describe('the script graph is a typed schema, not a free-form object', () => {
    function graphSchema(): Located {
      const draft = properties(schemaOf('getScript', '200')).get('draft');
      const graph = draft ? properties(draft).get('graph') : undefined;
      if (!graph) throw new Error('Script.draft.graph not found');
      return graph;
    }

    it('the draft and every published version share one closed graph schema', () => {
      const graph = graphSchema();
      const versionGraph = properties(schemaOf('getScriptVersion', '200')).get('graph');
      const runGraph = properties(schemaOf('getScriptRunScript', '200')).get('graph');
      expect(versionGraph?.node === graph.node, 'ScriptVersion.graph is another schema').toBe(true);
      expect(runGraph?.node === graph.node, "the run's script is another schema").toBe(true);
      expect(
        isMapping(graph.node) ? graph.node.additionalProperties : undefined,
        'graph closed',
      ).toBe(false);
      expect(required(graph).sort()).toEqual(['nodes', 'startNodeId']);
    });

    it(`nodes are a discriminated union on type of exactly: ${NODE_KINDS.join(', ')}`, () => {
      const nodes = properties(graphSchema()).get('nodes');
      const item = nodes ? child(nodes, 'items') : undefined;
      expect(item, 'nodes has no items').toBeDefined();
      if (!item || !isMapping(item.node)) return;
      const discriminator = isMapping(item.node.discriminator) ? item.node.discriminator : {};
      expect(discriminator.propertyName, 'discriminator').toBe('type');
      const mapping = isMapping(discriminator.mapping) ? discriminator.mapping : {};
      expect(Object.keys(mapping).sort()).toEqual([...NODE_KINDS].sort());
      const variants = Array.isArray(item.node.oneOf)
        ? item.node.oneOf.map((variant) => at(variant, item.file))
        : [];
      expect(variants.length, 'oneOf variants').toBe(NODE_KINDS.length);
      for (const variant of variants) {
        const kind = str(enumOf(properties(variant).get('type') ?? at({}))[0]);
        expect(NODE_KINDS, `variant kind ${kind}`).toContain(kind);
        expect(
          isMapping(variant.node) ? variant.node.additionalProperties : undefined,
          `${kind} closed`,
        ).toBe(false);
        expect(required(variant), `${kind} required`).toEqual(
          expect.arrayContaining(['id', 'type', 'title']),
        );
      }
    });

    it('each kind carries what it needs, and an end node has no next', () => {
      const nodes = properties(graphSchema()).get('nodes');
      const item = nodes ? child(nodes, 'items') : undefined;
      const variants = new Map<string, Located>();
      const oneOf =
        item && isMapping(item.node) && Array.isArray(item.node.oneOf) ? item.node.oneOf : [];
      for (const raw of oneOf) {
        const variant = at(raw, item?.file);
        variants.set(str(enumOf(properties(variant).get('type') ?? at({}))[0]), variant);
      }
      const needs: Record<string, string[]> = {
        say: ['text', 'next'],
        question: ['text', 'choices'],
        form: ['text', 'fields', 'next'],
        branch: ['condition', 'whenTrue', 'whenFalse'],
        compliance: ['text', 'next'],
        end: [],
      };
      for (const [kind, keys] of Object.entries(needs)) {
        const variant = variants.get(kind);
        expect(variant, `no ${kind} node`).toBeDefined();
        if (variant)
          expect(required(variant), `${kind} requires`).toEqual(expect.arrayContaining(keys));
      }
      const end = variants.get('end');
      expect(end ? [...properties(end).keys()] : [], 'an end node routes nowhere').not.toContain(
        'next',
      );
      const branch = variants.get('branch');
      expect(
        branch ? [...properties(branch).keys()] : [],
        'a branch has nothing for the agent to read',
      ).not.toContain('text');
      const condition = branch ? properties(branch).get('condition') : undefined;
      const sources =
        condition &&
        isMapping(condition.node) &&
        isMapping(condition.node.discriminator) &&
        isMapping(condition.node.discriminator.mapping)
          ? Object.keys(condition.node.discriminator.mapping).sort()
          : [];
      expect(sources, 'a branch reads a contact field or an answer, nothing else').toEqual([
        'answer',
        'contact_field',
      ]);
    });

    it('no schema in the graph is free-form: every object is closed or a typed map', () => {
      const problems: string[] = [];
      let objects = 0;
      walkSchemas(graphSchema(), (where, schema) => {
        const node = schema.node;
        if (!isMapping(node)) return;
        const isObject = node.type === 'object' || node.properties !== undefined;
        if (!isObject) {
          if (Object.keys(node).filter((key) => key !== 'description').length === 0)
            problems.push(`graph${where}: {} accepts anything`);
          return;
        }
        objects += 1;
        if (node.additionalProperties === undefined || node.additionalProperties === true)
          problems.push(`graph${where}: object is open`);
        if (isMapping(node.additionalProperties) && node.propertyNames === undefined)
          problems.push(`graph${where}: a map with untyped keys`);
      });
      expect(problems).toEqual([]);
      expect(objects, 'graph objects inspected').toBeGreaterThan(8);
    });
  });

  describe('no operation writes contact fields (D-P31 is open)', () => {
    it('no operation writes to a contact, account or activity path', () => {
      const writes = operations().filter(
        (op) =>
          op.method !== 'get' &&
          /^\/api\/v1\/(contacts|accounts|activities|leads)(\/|$)/.test(op.path),
      );
      expect(writes.map((op) => `${op.method.toUpperCase()} ${op.path}`)).toEqual([]);
    });

    it('no run write body takes a Contact property, at any depth', () => {
      const contactFields = contactPropertyNames();
      expect(
        contactFields.length,
        'Contact properties read from records.openapi.yaml',
      ).toBeGreaterThan(10);
      const offending: string[] = [];
      let names = 0;
      for (const id of RUN_WRITES) {
        const body = requestSchema(operation(id));
        if (!body) {
          offending.push(`${id}: no JSON body`);
          continue;
        }
        for (const { where, name } of propertyNamesUnder(body)) {
          names += 1;
          if (contactFields.includes(name)) offending.push(`${id}${where}.${name}`);
        }
      }
      expect(offending).toEqual([]);
      expect(names, 'run body properties inspected').toBeGreaterThan(8);
    });

    it('a form field is closed and has no property that binds it to a record', () => {
      const form = schemaOfKind('form');
      const field = properties(form).get('fields');
      const item = field ? child(field, 'items') : undefined;
      expect(item, 'form fields have no item schema').toBeDefined();
      if (!item) return;
      expect(
        isMapping(item.node) ? item.node.additionalProperties : undefined,
        'FormField closed',
      ).toBe(false);
      const BINDING =
        /bind|write|target|maps?To|crm|record|contact|fieldApiName|fieldDef|object|source|destination/i;
      const offending = [form, item]
        .flatMap((schema) => [...properties(schema).keys()])
        .filter((name) => BINDING.test(name));
      expect(offending, 'a form or field property that could write a record').toEqual([]);
    });

    it('answers and completion say the answers stay on the run, citing D-P31', () => {
      for (const id of ['recordScriptRunAnswers', 'completeScriptRun']) {
        const text = describedAs(operation(id).op);
        expect(text, `${id} does not cite D-P31`).toMatch(/D-P31/);
        expect(text, `${id} does not say answers stay on the run`).toMatch(/stay on the run/i);
      }
    });

    function schemaOfKind(kind: string): Located {
      const draft = properties(schemaOf('getScript', '200')).get('draft');
      const graph = draft ? properties(draft).get('graph') : undefined;
      const nodes = graph ? properties(graph).get('nodes') : undefined;
      const item = nodes ? child(nodes, 'items') : undefined;
      const oneOf =
        item && isMapping(item.node) && Array.isArray(item.node.oneOf) ? item.node.oneOf : [];
      for (const raw of oneOf) {
        const variant = at(raw, item?.file);
        if (enumOf(properties(variant).get('type') ?? at({}))[0] === kind) return variant;
      }
      throw new Error(`no ${kind} node kind`);
    }
  });

  describe('answers are classified sensitive (D-L91 review, minor 11)', () => {
    it("the run's answers and the answers body are x-kasuwa-classification: sensitive, never logged", () => {
      const answers = properties(schemaOf('getScriptRun', '200')).get('answers');
      expect(answers, 'ScriptRun has no answers').toBeDefined();
      if (!answers || !isMapping(answers.node)) return;
      expect(answers.node['x-kasuwa-classification'], 'ScriptRun.answers classification').toBe(
        'sensitive',
      );
      const text = describedAs(answers);
      expect(text, 'answers description').toMatch(/\bsensitive\b/);
      expect(text, 'why: health or hardship, NDPA').toMatch(/health or hardship[\s\S]*NDPA/i);
      expect(text, 'answers description').toMatch(/never logged/i);
      expect(text, 'answers are audited by name only').toMatch(/audited by .*(name|key)/i);
      const values = properties(requestSchema(operation('recordScriptRunAnswers')) ?? at({})).get(
        'values',
      );
      expect(
        isMapping(values?.node) ? values.node['x-kasuwa-classification'] : undefined,
        'answers body classification',
      ).toBe('sensitive');
      // No schema anywhere still calls answers merely pii.
      const doc = spec();
      const stale: string[] = [];
      const queue: unknown[] = [doc];
      while (queue.length > 0) {
        const node = queue.pop();
        if (Array.isArray(node)) queue.push(...node);
        else if (isMapping(node)) {
          if (
            node['x-kasuwa-classification'] !== undefined &&
            node['x-kasuwa-classification'] !== 'sensitive'
          ) {
            stale.push(String(node['x-kasuwa-classification']));
          }
          queue.push(...Object.values(node));
        }
      }
      expect(stale, 'a classification other than sensitive').toEqual([]);
    });
  });

  describe("completion's preconditions", () => {
    it('completion refuses unacknowledged compliance and a disposition that is not live, with examples', () => {
      const conflict = responses(operation('completeScriptRun')).get('409');
      expect(conflict, 'completeScriptRun documents no 409').toBeDefined();
      if (!conflict) return;
      expect(exampleCodes(conflict)).toEqual(
        expect.arrayContaining([
          'compliance_unacknowledged',
          'disposition_not_live',
          'disposition_requirements_unmet',
        ]),
      );
      const text = describedAs(operation('completeScriptRun').op).replace(/\s+/g, ' ');
      expect(text, 'every compliance node on the path').toMatch(
        /every compliance node on the path/i,
      );
      expect(text, 'a live disposition').toMatch(/live disposition/i);
      expect(text, 'one transaction').toMatch(/one transaction/i);
      expect(text, 'a call activity whose subject is the label').toMatch(
        /`call` activity[\s\S]*subject[\s\S]*label/i,
      );
      expect(text, 'the callback task').toMatch(/callback[\s\S]*`task`/i);
    });

    it('the completion body is closed: revision, outcome, a uuid dispositionId, note and followUp; no subject or acknowledgement', () => {
      const body = requestSchema(operation('completeScriptRun'));
      expect(body, 'no body').toBeDefined();
      if (!body) return;
      expect(isMapping(body.node) ? body.node.additionalProperties : undefined, 'closed').toBe(
        false,
      );
      expect(required(body).sort()).toEqual(['dispositionId', 'outcome', 'revision']);
      const props = properties(body);
      expect([...props.keys()].sort()).toEqual([
        'dispositionId',
        'followUp',
        'note',
        'outcome',
        'revision',
      ]);
      expect(enumOf(props.get('outcome') ?? at({})), 'outcome (D-L91)').toEqual([
        'completed',
        'interrupted',
      ]);
      expect(
        isMapping(props.get('dispositionId')?.node)
          ? (props.get('dispositionId')?.node as Mapping).format
          : undefined,
      ).toBe('uuid');
      const offending = propertyNamesUnder(body)
        .map(({ name }) => name)
        .filter((name) =>
          /acknowledg|subject|activity|completedAt|owner|assignee|version/i.test(name),
        );
      expect(offending, 'the client chooses something the server owns').toEqual([]);
    });

    it('the run links the call activity and the callback task it created', () => {
      const run = schemaOf('getScriptRun', '200');
      for (const key of ['activityId', 'followUpTaskId', 'dispositionId']) {
        const prop = properties(run).get(key);
        expect(prop, `ScriptRun.${key}`).toBeDefined();
        if (prop) {
          expect(types(prop).sort(), `${key} type`).toEqual(['null', 'string']);
          expect(isMapping(prop.node) ? prop.node.format : undefined, `${key} format`).toBe('uuid');
        }
      }
    });

    it('the server stamps acknowledgements: the body carries no time, and acknowledgedAt is read-only', () => {
      const body = requestSchema(operation('acknowledgeScriptRunNode'));
      expect(body, 'no body').toBeDefined();
      if (!body) return;
      expect(isMapping(body.node) ? body.node.additionalProperties : undefined, 'closed').toBe(
        false,
      );
      const timeLike = propertyNamesUnder(body)
        .map(({ name }) => name)
        .filter((name) => /At$|time|date|clock|when/i.test(name));
      expect(timeLike, 'a client-supplied time would let an acknowledgement be backdated').toEqual(
        [],
      );
      const acks = properties(schemaOf('getScriptRun', '200')).get('acknowledgements');
      const item = acks ? child(acks, 'items') : undefined;
      expect(
        item ? rawProperty(item, 'acknowledgedAt')?.readOnly : undefined,
        'acknowledgedAt readOnly',
      ).toBe(true);
    });

    it("agents read the programme's live dispositions through the run, without admin usage counts", () => {
      const page = schemaOf('listScriptRunDispositions', '200');
      const row = child(properties(page).get('data') ?? at({}), 'items');
      expect(row, 'no row schema').toBeDefined();
      if (!row) return;
      const keys = [...properties(row).keys()];
      expect(keys).toEqual(
        expect.arrayContaining([
          'id',
          'code',
          'label',
          'noteRequired',
          'followUpRequired',
          'position',
        ]),
      );
      expect(
        keys.filter((key) => /usage|count|active|deleted/i.test(key)),
        'admin-only or non-live state',
      ).toEqual([]);
      expect(describedAs(operation('listScriptRunDispositions').op), 'only live ones').toMatch(
        /live/i,
      );
    });
  });

  describe('a dropped call completes as interrupted, and is never acknowledged (D-L91)', () => {
    /** The run examples the contract publishes on every operation that answers a run. */
    function runExamples(): { label: string; run: Mapping }[] {
      const out: { label: string; run: Mapping }[] = [];
      for (const op of operations()) {
        for (const [status, response] of responses(op)) {
          if (!/^2/.test(status)) continue;
          const schema = jsonSchema(response);
          if (!schema || schema.node !== schemaOf('getScriptRun', '200').node) continue;
          for (const { name, value } of exampleValues(response)) {
            if (isMapping(value)) out.push({ label: `${op.id} ${status} ${name}`, run: value });
          }
        }
      }
      return out;
    }

    /** Node id -> kind, from the graph of the version the example runs are pinned to. */
    function exampleNodeKinds(): Map<string, string> {
      const kinds = new Map<string, string>();
      for (const { value } of exampleValues(
        responses(operation('getScriptRunScript')).get('200'),
      )) {
        const graph = isMapping(value) && isMapping(value.graph) ? value.graph : {};
        for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
          if (isMapping(node)) kinds.set(str(node.id), str(node.type));
        }
      }
      return kinds;
    }

    it('the run records outcome and the unacknowledged compliance node ids, both server-set and read-only', () => {
      const run = schemaOf('getScriptRun', '200');
      expect(required(run)).toEqual(
        expect.arrayContaining(['outcome', 'unacknowledgedComplianceNodeIds']),
      );
      expect(enumOf(properties(run).get('outcome') ?? at({}))).toEqual([
        'completed',
        'interrupted',
        null,
      ]);
      expect(rawProperty(run, 'outcome')?.readOnly, 'outcome readOnly').toBe(true);
      const list = properties(run).get('unacknowledgedComplianceNodeIds');
      expect(list ? types(list) : [], 'a list').toContain('array');
      expect(
        rawProperty(run, 'unacknowledgedComplianceNodeIds')?.readOnly,
        'the server sets the list',
      ).toBe(true);
      const item = list ? child(list, 'items') : undefined;
      const nodeId = resolveRef('#/components/schemas/NodeId', SPEC_PATH);
      expect(nodeId, 'NodeId schema').toBeDefined();
      expect(item?.node === nodeId?.node, 'items are NodeIds').toBe(true);
    });

    it('no request body anywhere supplies an unacknowledged list or an outcome but completion', () => {
      const offending: string[] = [];
      for (const op of operations()) {
        const body = requestSchema(op);
        for (const { where, name } of body ? propertyNamesUnder(body) : []) {
          if (/unacknowledg/i.test(name)) offending.push(`${op.id}${where}.${name}`);
          if (/^outcome$/i.test(name) && !(op.id === 'completeScriptRun' && where === '')) {
            offending.push(`${op.id}${where}.${name}`);
          }
        }
      }
      expect(offending).toEqual([]);
    });

    it('completion documents both outcomes: what each excuses, and that interrupted never acknowledges', () => {
      const text = describedAs(operation('completeScriptRun').op).replace(/\s+/g, ' ');
      expect(text).toMatch(/`completed`[\s\S]*current node included/i);
      expect(text).toMatch(/`interrupted`[\s\S]*current node[\s\S]*not yet passed/i);
      expect(text).toMatch(/already passed was acknowledged when it was passed/i);
      expect(text).toMatch(/client never supplies that list/i);
      expect(text).toMatch(/`interrupted` never produces an acknowledgement/i);
      expect(text, 'a live disposition is still required').toMatch(
        /live disposition is chosen\*\*, for either outcome/i,
      );
      expect(
        exampleValues(requestBody(operation('completeScriptRun'))).some(
          ({ value }) => isMapping(value) && value.outcome === 'interrupted',
        ),
        'no interrupted completion example',
      ).toBe(true);
    });

    it("an interrupted run's unacknowledged nodes are visible on the run read, and none is acknowledged", () => {
      const runs = runExamples();
      const kinds = exampleNodeKinds();
      expect(kinds.size, 'the pinned version example has no graph').toBeGreaterThan(0);
      const problems: string[] = [];
      for (const { label, run } of runs) {
        const unacked = Array.isArray(run.unacknowledgedComplianceNodeIds)
          ? run.unacknowledgedComplianceNodeIds.map(str)
          : [];
        const acked = (Array.isArray(run.acknowledgements) ? run.acknowledgements : [])
          .filter(isMapping)
          .map((ack) => str(ack.nodeId));
        const path = (Array.isArray(run.path) ? run.path : [])
          .filter(isMapping)
          .map((step) => str(step.nodeId));
        if (run.outcome !== 'interrupted' && unacked.length > 0) {
          problems.push(`${label}: lists unacknowledged nodes without being interrupted`);
        }
        for (const id of unacked) {
          if (acked.includes(id))
            problems.push(`${label}: ${id} is both unacknowledged and acknowledged`);
          if (!path.includes(id)) problems.push(`${label}: ${id} is not on the path`);
          if (kinds.get(id) !== 'compliance')
            problems.push(`${label}: ${id} is not a compliance node`);
        }
        if (run.outcome === 'completed') {
          for (const id of path.filter((node) => kinds.get(node) === 'compliance')) {
            if (!acked.includes(id)) problems.push(`${label}: completed with ${id} unacknowledged`);
          }
        }
        // B1 (D-L91 review): interrupted lists EVERY unread compliance node
        // on the path, the current one included, and nothing else.
        if (run.outcome === 'interrupted') {
          const expected = [
            ...new Set(
              path.filter((node) => kinds.get(node) === 'compliance' && !acked.includes(node)),
            ),
          ].sort();
          if (JSON.stringify([...unacked].sort()) !== JSON.stringify(expected)) {
            problems.push(
              `${label}: lists ${JSON.stringify(unacked)}, the path leaves ${JSON.stringify(expected)} unread`,
            );
          }
        }
        // B1: completed only at an end node, or on a stopped run; endedAtNodeId
        // is where the run was, and is null until completion.
        const ended = run.endedAtNodeId;
        if (run.status === 'completed') {
          if (typeof ended !== 'string') problems.push(`${label}: completed with no endedAtNodeId`);
          else if (ended !== path[path.length - 1])
            problems.push(`${label}: endedAtNodeId ${ended} is not where the path ends`);
          if (run.currentNodeId !== null) problems.push(`${label}: completed with a currentNodeId`);
          if (
            run.outcome === 'completed' &&
            kinds.get(str(ended)) !== 'end' &&
            run.stopReason === null
          ) {
            problems.push(
              `${label}: outcome completed at a ${kinds.get(str(ended)) ?? '?'} node, not an end, on a run that never stopped`,
            );
          }
        } else {
          if (ended !== null) problems.push(`${label}: endedAtNodeId set before completion`);
          if (run.outcome !== null) problems.push(`${label}: outcome set before completion`);
        }
      }
      expect(problems).toEqual([]);
      expect(
        runs.filter(({ run }) => run.outcome === 'completed').length,
        'no completed example to hold to the end-node rule',
      ).toBeGreaterThan(0);
      const interrupted = runs.filter(({ run }) => run.outcome === 'interrupted');
      expect(
        interrupted.map(({ label }) => label),
        'getScriptRun publishes no interrupted run',
      ).toEqual(expect.arrayContaining([expect.stringMatching(/^getScriptRun 200 /)]));
      expect(
        interrupted.some(
          ({ run }) =>
            Array.isArray(run.unacknowledgedComplianceNodeIds) &&
            run.unacknowledgedComplianceNodeIds.length > 0,
        ),
        'no interrupted example shows an unread compliance node',
      ).toBe(true);
    });
  });

  describe('starting is idempotent per agent, contact and script; runs never expire (D-L91)', () => {
    it('startScriptRun answers 200 with the in-progress run, or 201 with a new one, both a ScriptRun', () => {
      const all = responses(operation('startScriptRun'));
      const run = schemaOf('getScriptRun', '200').node;
      expect(jsonSchema(all.get('200'))?.node, '200 is the existing run').toBe(run);
      expect(jsonSchema(all.get('201'))?.node, '201 is the new run').toBe(run);
      const text = describedAs(operation('startScriptRun').op).replace(/\s+/g, ' ');
      expect(text).toMatch(/same\s+agent, contact and script/i);
      expect(text).toMatch(/`in_progress` run/);
      expect(text).toMatch(/`200` with THAT run/);
      expect(text).toMatch(/different script or a\s+different agent starts a new run/i);
    });

    it('no expiry: a run stays in progress until its agent completes it; supervisor close waits', () => {
      for (const text of [
        describedAs(operation('startScriptRun').op),
        describedAs(schemaOf('getScriptRun', '200')),
      ]) {
        expect(text).toMatch(/No expiry in Phase 2/);
        // Descriptions wrap, so every space here is \s+.
        expect(text).toMatch(/until\s+its\s+(own\s+)?agent\s+completes\s+it/i);
        expect(text).toMatch(
          /supervisor\s+closing\s+another\s+agent's\s+run\s+waits\s+for\s+the\s+role\s+hierarchy/i,
        );
      }
    });
  });

  describe('the D-L91 security review: blockers, majors and minors', () => {
    /** Descriptions wrap; compare them with whitespace collapsed. */
    function prose(...located: (Located | Mapping | undefined)[]): string {
      return describedAs(...located).replace(/\s+/g, ' ');
    }

    function infoProse(): string {
      const info = spec().info;
      return isMapping(info) ? str(info.description).replace(/\s+/g, ' ') : '';
    }

    /** Every `description` string anywhere in the spec. */
    function allDescriptions(): string[] {
      const out: string[] = [];
      const queue: unknown[] = [spec()];
      while (queue.length > 0) {
        const node = queue.pop();
        if (Array.isArray(node)) queue.push(...node);
        else if (isMapping(node)) {
          if (typeof node.description === 'string') out.push(node.description.replace(/\s+/g, ' '));
          queue.push(...Object.values(node));
        }
      }
      return out;
    }

    function auditNames(id: string): string[] {
      const raw = operation(id).op['x-kasuwa-audit-names'];
      return Array.isArray(raw) ? raw.map(str) : [];
    }

    function componentSchema(name: string): Located {
      const found = resolveRef(`#/components/schemas/${name}`, SPEC_PATH);
      if (!found) throw new Error(`no components.schemas.${name}`);
      return at(found.node, found.file);
    }

    // --- B1 -----------------------------------------------------------------

    it('B1: completed only at an end node or on a stopped run; anything else is interrupted or refused not_at_end', () => {
      const text = prose(operation('completeScriptRun').op);
      expect(text).toMatch(
        /`completed` is allowed only when the current node is an `end` node, or when the run is `stopped`/,
      );
      expect(text).toMatch(
        /must be `interrupted`; `completed` is refused with `409 compliance_unacknowledged`/,
      );
      expect(text).toMatch(/`code: not_at_end`/);
      expect(text).toMatch(
        /every compliance node on the path, the current node included, that was NOT acknowledged/,
      );
      const refused = exampleValues(responses(operation('completeScriptRun')).get('409'))
        .map(({ value }) => value)
        .filter(isMapping)
        .filter((value) => value.code === 'compliance_unacknowledged')
        .flatMap((value) => (Array.isArray(value.details) ? value.details : []))
        .filter(isMapping);
      expect(
        refused.some((detail) => detail.path === 'outcome' && detail.code === 'not_at_end'),
        'no 409 example refuses completed away from an end node',
      ).toBe(true);
      const outcome = properties(requestSchema(operation('completeScriptRun')) ?? at({})).get(
        'outcome',
      );
      expect(prose(outcome)).toMatch(/allowed only at an `end` node or on a `stopped` run/);
    });

    it('B1: the run records endedAtNodeId, server-set, read-only, and no body supplies it', () => {
      const run = schemaOf('getScriptRun', '200');
      expect(required(run)).toContain('endedAtNodeId');
      expect(rawProperty(run, 'endedAtNodeId')?.readOnly, 'endedAtNodeId readOnly').toBe(true);
      expect(types(properties(run).get('endedAtNodeId') ?? at({})).sort()).toEqual([
        'null',
        'string',
      ]);
      expect(prose(rawProperty(run, 'endedAtNodeId'))).toMatch(/`currentNodeId` becomes `null`/);
      const offending = operations().flatMap((op) => {
        const body = requestSchema(op);
        return body
          ? propertyNamesUnder(body)
              .filter(({ name }) => /^endedAt/i.test(name))
              .map(({ where, name }) => `${op.id}${where}.${name}`)
          : [];
      });
      expect(offending).toEqual([]);
    });

    // --- B2 -----------------------------------------------------------------

    for (const id of RUN_OPERATIONS) {
      it(`B2: ${id} answers only the run's own agent; everyone else is 404`, () => {
        const text = prose(operation(id).op);
        expect(text, `${id} does not say only the run's own agent`).toMatch(
          /only (by )?(its|the run's) own agent|Only the run's agent|Only the agent who started the run/i,
        );
        expect(text, `${id} does not say everyone else gets 404`).toMatch(
          /(anyone|everyone) else[^.]*gets `404`/i,
        );
        expect(errorOrder(operation(id))[0], `${id} decides 404 first`).toBe('404 not_found');
      });
    }

    it("B2: the run id, 404 and 403 bodies say another agent's run is 404, never 403; supervisor reads wait for M11", () => {
      const runId = operation('getScriptRun').params.find(
        (parameter) => parameter.name === 'runId',
      );
      const idText = prose(runId);
      expect(idText).toMatch(/A run is visible only to its own agent/);
      expect(idText).toMatch(/team lead, a programme manager and an admin included/);
      expect(idText).toMatch(/are one `404 not_found`, on every run operation/);
      const forbidden = responses(operation('advanceScriptRun')).get('403');
      expect(prose(forbidden)).toMatch(/Another agent's run is never `403`: it is `404`/);
      const read = prose(operation('getScriptRun').op);
      expect(read).toMatch(
        /team lead, a programme manager or an admin included, gets `404`, never `403`/,
      );
      expect(read).toMatch(/supervisor or QA read[\s\S]*waits for M11/);
    });

    it('B2: nothing in the file says a run is readable by other script.run holders', () => {
      const offending = allDescriptions().filter((text) =>
        /readable by any|any `script\.run` holder|open to `?script\.run`? holders/i.test(text),
      );
      expect(offending).toEqual([]);
      expect(allDescriptions().length, 'descriptions inspected').toBeGreaterThan(100);
    });

    // --- M1, M2, M3 ---------------------------------------------------------

    it('M1: completion audits outcome, the unacknowledged ids and endedAtNodeId, by id only, interrupted always', () => {
      const names = auditNames('completeScriptRun');
      expect(names).toEqual([
        'dispositionId',
        'activityId',
        'followUpTaskId',
        'outcome',
        'unacknowledgedComplianceNodeIds',
        'endedAtNodeId',
      ]);
      const runProps = [...properties(schemaOf('getScriptRun', '200')).keys()];
      expect(
        names.filter((name) => !runProps.includes(name)),
        'audit names a run property',
      ).toEqual([]);
      const text = prose(operation('completeScriptRun').op);
      expect(text).toMatch(
        /`interrupted` with any disposition stays allowed, and is always audited as interrupted/,
      );
      expect(text).toMatch(/configuration ids only, never an answer or a note/);
      expect(text).toMatch(
        /Tracked follow-ups: showing the outcome on the call activity, and the QA read path/,
      );
    });

    it('M2: listProgrammeScripts, once backed by M10, requires script.write (404 otherwise) and is no-store', () => {
      const list = operationsOf(ADMIN_PATH).find((op) => op.id === 'listProgrammeScripts');
      const text = prose(list?.op);
      expect(text).toMatch(/Once backed by M10 it requires `script\.write` in the programme/);
      expect(text).toMatch(/anyone else gets `404`/);
      expect(text).toMatch(/`Cache-Control: no-store`/);
    });

    it('M3: a run follows its programme retention and is erased with its contact, runs first (D-P27)', () => {
      const text = prose(schemaOf('getScriptRun', '200'));
      expect(text).toMatch(/A run follows its programme's retention policy/);
      expect(text).toMatch(
        /the D-P27 sweeper deletes a contact's runs before it deletes the contact/,
      );
    });

    // --- minors -------------------------------------------------------------

    it('minor 1: startScriptRun decides the 403 on the contact before it looks up the script', () => {
      const order = errorOrder(operation('startScriptRun'));
      expect(order.indexOf('403 not_permitted'), '403 before the script 404').toBeLessThan(
        order.indexOf('404 not_found (script)'),
      );
      expect(order.indexOf('404 not_found (contact)'), 'the contact 404 first').toBe(0);
      const text = prose(operation('startScriptRun').op);
      expect(text).toMatch(/decided before the script is looked up/);
      expect(text).toMatch(/a real script id and a random one get the same answer/);
    });

    it('minor 2: the start replay looks only at the caller own runs; another agent gets a new run', () => {
      const text = prose(operation('startScriptRun').op);
      expect(text).toMatch(/The replay looks only at the caller's own runs/);
      expect(text).toMatch(/decided before any replay check/);
      expect(text).toMatch(/a different agent always gets a new run/);
    });

    it('minor 3: a run stopped by field_withheld on the same version is replayed; T-0114 gets a partial index', () => {
      const text = prose(operation('startScriptRun').op);
      expect(text).toMatch(
        /`stopped` with `stopReason: field_withheld` on the version a new run would pin: `200` with that run/,
      );
      expect(text).toMatch(/unique partial index/);
      expect(text).toMatch(/for `in_progress` runs/);
    });

    it('minor 4: every integer a request can carry is bounded; revision is 1..2147483647', () => {
      const problems: string[] = [];
      let integers = 0;
      for (const op of operations()) {
        const body = requestSchema(op);
        if (!body) continue;
        walkSchemas(body, (where, schema) => {
          if (!types(schema).includes('integer') || !isMapping(schema.node)) return;
          if (schema.node.type !== 'integer') return;
          integers += 1;
          if (typeof schema.node.minimum !== 'number' || typeof schema.node.maximum !== 'number') {
            problems.push(`${op.id}${where}: an unbounded integer`);
          }
        });
        const revision = properties(body).get('revision');
        if (revision && isMapping(revision.node)) {
          if (revision.node.minimum !== 1 || revision.node.maximum !== 2147483647) {
            problems.push(`${op.id}.revision is not 1..2147483647`);
          }
        }
      }
      for (const [name, schema] of [
        ['Script', schemaOf('getScript', '200')],
        ['ScriptRun', schemaOf('getScriptRun', '200')],
      ] as const) {
        const revision = properties(schema).get('revision');
        if (!revision || !isMapping(revision.node) || revision.node.maximum !== 2147483647) {
          problems.push(`${name}.revision has no 2147483647 maximum`);
        }
      }
      const INT32 = { minimum: -2147483648, maximum: 2147483647 };
      const bounded = (schema: Located | undefined): boolean =>
        !!schema &&
        isMapping(schema.node) &&
        schema.node.minimum === INT32.minimum &&
        schema.node.maximum === INT32.maximum;
      for (const name of ['AnswerValue', 'ConditionValue']) {
        const variants = componentSchema(name).node;
        const integer = (isMapping(variants) && Array.isArray(variants.oneOf) ? variants.oneOf : [])
          .map((variant) => at(variant))
          .find((variant) => isMapping(variant.node) && variant.node.type === 'integer');
        if (!bounded(integer)) problems.push(`${name}: its integer is not -2147483648..2147483647`);
      }
      const field = componentSchema('FormField');
      for (const key of ['minimum', 'maximum']) {
        if (!bounded(properties(field).get(key)))
          problems.push(`FormField.${key} is not int32-bounded`);
      }
      expect(problems).toEqual([]);
      expect(integers, 'request integers inspected').toBeGreaterThan(10);
      expect(infoProse()).toMatch(/`revision` is 1\.\.2147483647/);
      expect(infoProse()).toMatch(/-2147483648\.\.2147483647/);
    });

    it('minor 5: a NUL in any string is 400 nul_character, documented and exemplified', () => {
      expect(infoProse()).toMatch(/A NUL character \(`\\u0000`\) in any string/);
      expect(infoProse()).toMatch(/wording, an answer, a note, a name or a translation, is `400`/);
      expect(infoProse()).toMatch(/`details\[\]\.code: nul_character`/);
      const details = exampleValues(responses(operation('completeScriptRun')).get('400'))
        .map(({ value }) => value)
        .filter(isMapping)
        .flatMap((value) => (Array.isArray(value.details) ? value.details : []))
        .filter(isMapping);
      expect(
        details.some((detail) => detail.code === 'nul_character'),
        'no nul_character example',
      ).toBe(true);
    });

    it('minor 6: a version is capped at 256 KiB serialised, and publish checks reachability linearly', () => {
      expect(componentSchema('ScriptVersion').node).toMatchObject({
        'x-kasuwa-max-serialised-bytes': 262144,
      });
      const publish = prose(operation('publishScript').op);
      expect(publish).toMatch(/Reachability is checked in linear time/);
      expect(publish).toMatch(/never by enumerating paths/);
      for (const id of ['updateScript', 'putScriptTranslation']) {
        const text = prose(operation(id).op);
        expect(text, `${id} cap`).toMatch(/262144 bytes \(256 KiB\)/);
        expect(text, `${id} too_big`).toMatch(/too_big/);
      }
    });

    it('minor 7: a callback is due at most 366 days ahead', () => {
      const body = requestSchema(operation('completeScriptRun'));
      const followUp = body ? properties(body).get('followUp') : undefined;
      const dueAt = followUp ? properties(followUp).get('dueAt') : undefined;
      expect(prose(dueAt)).toMatch(/at most 366 days ahead; anything else is `400`/);
    });

    it('minor 8: a cursor id is resolved inside its own list; anything else is invalid_cursor, like a missing id', () => {
      const cursor = operation('listScripts').params.find(
        (parameter) => parameter.name === 'cursor',
      );
      const text = prose(cursor);
      expect(text).toMatch(/The id is resolved inside the list's own filter/);
      expect(text).toMatch(/`details\[\]\.code: invalid_cursor`/);
      expect(text).toMatch(/exactly as for an id that does not exist/);
      expect(text).toMatch(/D-L90/);
    });

    it('minor 9: an acknowledgement records the locale its wording was shown in', () => {
      const locale = componentSchema('ScriptLocale').node;
      const body = requestSchema(operation('acknowledgeScriptRunNode'));
      expect(body ? required(body) : [], 'the body requires locale').toContain('locale');
      expect(body ? properties(body).get('locale')?.node === locale : false, 'a ScriptLocale').toBe(
        true,
      );
      const ack = componentSchema('Acknowledgement');
      expect(required(ack), 'the acknowledgement records locale').toContain('locale');
      expect(properties(ack).get('locale')?.node === locale, 'a ScriptLocale').toBe(true);
    });

    it('minor 10: wording is plain text; substitution produces text, never HTML', () => {
      const graph = prose(componentSchema('ScriptGraph'));
      expect(graph).toMatch(/Wording is plain text/);
      expect(graph).toMatch(/Substitution produces text, never HTML/);
      expect(infoProse()).toMatch(/produces text, never HTML/);
    });

    it('minor 12: publish refuses a branch or variable on a sensitive field until D-L13', () => {
      const publish = prose(operation('publishScript').op);
      expect(publish).toMatch(
        /`sensitive_field` \(a branch or a variable on any contact field classified `sensitive`/,
      );
      expect(publish).toMatch(/until D-L13/);
      expect(prose(componentSchema('ScriptGraph'))).toMatch(/`sensitive_field`/);
    });

    it('minor 13: the publish audit names the compliance nodes added, removed or changed, by id', () => {
      expect(auditNames('publishScript')).toEqual(
        expect.arrayContaining([
          'complianceNodesAdded',
          'complianceNodesRemoved',
          'complianceNodesChanged',
        ]),
      );
      expect(prose(operation('publishScript').op)).toMatch(/node ids only, never their wording/);
    });
  });

  describe('version pinning', () => {
    it('a run carries its versionId, read-only; latestVersion is required and read-only', () => {
      const run = schemaOf('getScriptRun', '200');
      expect(required(run)).toEqual(
        expect.arrayContaining(['versionId', 'versionNumber', 'latestVersion', 'scriptId']),
      );
      expect(
        isMapping(properties(run).get('versionId')?.node)
          ? (properties(run).get('versionId')?.node as Mapping).format
          : undefined,
      ).toBe('uuid');
      expect(rawProperty(run, 'versionId')?.readOnly, 'versionId readOnly').toBe(true);
      expect(rawProperty(run, 'latestVersion')?.readOnly, 'latestVersion readOnly').toBe(true);
      expect(
        types(properties(run).get('latestVersion') ?? at({})),
        'a run always has a latest version',
      ).not.toContain('null');
    });

    it('no request body anywhere chooses or changes a version', () => {
      const offending: string[] = [];
      for (const op of operations()) {
        const body = requestSchema(op);
        if (!body) continue;
        for (const { where, name } of propertyNamesUnder(body)) {
          if (/^(versionId|versionNumber|latestVersion|version)$/i.test(name))
            offending.push(`${op.id}${where}.${name}`);
        }
      }
      expect(offending).toEqual([]);
    });

    it('a published version is immutable: nothing writes under /versions/{id}, and it has no revision', () => {
      const writes = operations().filter(
        (op) => op.method !== 'get' && /\/versions\/\{/.test(op.path),
      );
      expect(writes.map((op) => op.id)).toEqual([]);
      const version = schemaOf('getScriptVersion', '200');
      expect(
        [...properties(version).keys()],
        'a version with a revision can be edited',
      ).not.toContain('revision');
      expect(
        schemaOf('publishScript', '201').node === version.node,
        'publish answers the version',
      ).toBe(true);
    });

    it("the run's script is the pinned version, the same schema as a published version", () => {
      expect(
        schemaOf('getScriptRunScript', '200').node === schemaOf('getScriptVersion', '200').node,
      ).toBe(true);
      const text = describedAs(operation('getScriptRunScript').op);
      expect(text, 'getScriptRunScript says it is the pinned version').toMatch(/versionId/);
      expect(text, 'never the latest').toMatch(/never the latest/i);
    });

    it('startScriptRun pins the latest published version on the server, and refuses an unpublished script', () => {
      const text = describedAs(operation('startScriptRun').op).replace(/\s+/g, ' ');
      expect(text).toMatch(/latest published version/i);
      expect(errorOrder(operation('startScriptRun'))).toContain('409 script_not_published');
    });
  });

  describe('a branch on a withheld field stops the run', () => {
    it('ScriptRun can be stopped with stopReason field_withheld, and the advance documents it', () => {
      const run = schemaOf('getScriptRun', '200');
      expect(enumOf(properties(run).get('status') ?? at({}))).toEqual([
        'in_progress',
        'stopped',
        'completed',
      ]);
      expect(enumOf(properties(run).get('stopReason') ?? at({}))).toContain('field_withheld');
      const advance = describedAs(operation('advanceScriptRun').op);
      expect(advance).toMatch(/evaluated on the server/i);
      expect(advance).toMatch(/withheld[\s\S]*stops the run/i);
      const stopped = exampleValues(responses(operation('advanceScriptRun')).get('200'))
        .map((entry) => entry.value)
        .filter(isMapping)
        .find((value) => value.status === 'stopped');
      expect(stopped?.stopReason, 'no stopped example on advance').toBe('field_withheld');
    });
  });

  describe('ADR-0003 and CLAUDE.md 2.8: no telephony platform, no call binding', () => {
    it('(self-check) the platform-name scan catches a planted name and ignores ordinary words', () => {
      // Does not read the spec, so it passes on main.
      expect(platformNamesIn('Screen-pop arrives from Genesys Cloud via FreeSWITCH.')).toEqual([
        'Genesys',
        'FreeSWITCH',
      ]);
      expect(platformNamesIn("Sent by africa's talking")).toEqual(["Africa's Talking"]);
      expect(platformNamesIn('the telephony platform, a disposition, a cisco-style call')).toEqual([
        'Cisco',
      ]);
      expect(
        platformNamesIn('the telephony platform, a compliance notice, assisted, nice'),
      ).toEqual([]);
    });

    it('no telephony or channel platform is named anywhere in the file, comments included', () => {
      spec();
      expect(platformNamesIn(readFileSync(SPEC_PATH, 'utf8'))).toEqual([]);
    });

    it('no run is bound to a call, an interaction, a queue or agent state (M09 waits)', () => {
      const CALL =
        /^(call|interaction|session|queue|campaign|ani|dnis|agentState|wrapUp)(Id|s)?$|wrap|screenPop|softphone|recording/i;
      const offending: string[] = [];
      for (const op of operations()) {
        if (/\/(calls?|interactions?|screen-pop|wrap-?up|agent-state)(\/|$)/.test(op.path))
          offending.push(`${op.id}: path ${op.path}`);
        for (const parameter of op.params) {
          if (CALL.test(str(parameter.name))) offending.push(`${op.id}: ${str(parameter.name)}`);
        }
        const body = requestSchema(op);
        for (const { where, name } of body ? propertyNamesUnder(body) : []) {
          if (CALL.test(name)) offending.push(`${op.id}${where}.${name}`);
        }
      }
      for (const name of [...properties(schemaOf('getScriptRun', '200')).keys()]) {
        if (CALL.test(name)) offending.push(`ScriptRun.${name}`);
      }
      expect(offending).toEqual([]);
    });
  });

  describe('admin.openapi.yaml points at this contract', () => {
    it('listProgrammeScripts names scripting.openapi.yaml and T-0112', () => {
      spec();
      const list = operationsOf(ADMIN_PATH).find((op) => op.id === 'listProgrammeScripts');
      expect(list, 'admin listProgrammeScripts').toBeDefined();
      const text = describedAs(list?.op);
      expect(text).toMatch(/scripting\.openapi\.yaml/);
      expect(text).toMatch(/T-0112/);
    });
  });
});
