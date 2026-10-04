import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * ACCEPTANCE — T-0039, the records API contract, contacts first (D-L60, D-L12,
 * ADR-0004). Agent 3. Contract only: no route, no migration, no code.
 *
 * The artefact under test is `docs/api/records.openapi.yaml`. This suite reads
 * it as data (parsed YAML, never a regex over the text, so a keyword in a
 * comment satisfies nothing) and pins the properties T-0041 (the API) and
 * T-0042 (the P04 Contacts list) will both build against.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT THIS SUITE PINS (the builder writes the YAML)
 * ---------------------------------------------------------------------------
 *
 *   openapi: 3.x, modelled on docs/api/admin.openapi.yaml. Every `$ref`
 *   resolves (a relative file ref such as `./admin.openapi.yaml#/...` is
 *   followed, so the Error schema may be shared rather than copied).
 *
 *   listContacts    GET   /api/v1/contacts
 *   createContact   POST  /api/v1/contacts
 *   getContact      GET   /api/v1/contacts/{<id>}
 *   updateContact   PATCH /api/v1/contacts/{<id>}
 *
 *   The paths are the LIVE ones. `GET /api/v1/contacts` and `/:id` exist today
 *   (apps/api/src/contacts/contacts.controller.ts) and three blocking tenancy
 *   suites hit them. A contract at another path would orphan the route those
 *   suites prove isolated.
 *
 *   Every operation in the file carries `x-kasuwa-implemented` (a boolean
 *   here — the brief asks for true/false, not admin's `partial`) and
 *   `x-kasuwa-screens`, a non-empty list of design frame ids. P04 frames are
 *   numbered by section, as T-0042 already names them: `P04/02` is the
 *   Contacts list (BPO programme scope, locked columns), `P04/04` Kanban and
 *   Map, `P04/05` empty and no results, `P04/06` loading and offline.
 *
 *   listContacts query parameters:
 *     q              "name or number"; a phone is matched in E.164. Bounded.
 *     owner|ownerId, status, source, tag|tags, state, lga  — filters
 *     dnd, whatsappOptIn                                   — boolean filters
 *     sort           an ENUM. A free-form sort column would let a caller order
 *                    rows by a field field-security withholds from them, which
 *                    leaks the hidden values one comparison at a time.
 *     cursor         opaque (and documented as opaque)
 *     limit          integer, 1..N with N <= 100 (MAX_PAGE_SIZE today)
 *   No offset, page or skip parameter.
 *
 *   listContacts 200: `{ data: Contact[], nextCursor: string | null }`.
 *   `data`, NOT `items`: that is the live wire shape, and api-isolation and
 *   cursor-tampering read `body.data`. No total count of any kind.
 *
 *   Contact: keeps the live fields (id, programmeId, displayName, phones[].e164,
 *   createdAt, updatedAt), adds `version` (integer — updateContact cannot
 *   require one the client was never given) and `withheldFields: string[]`,
 *   always present. A withheld field is OMITTED, never null — so `emails`, the
 *   column P04/02 locks, is neither required nor nullable.
 *
 *   Errors: one shared Error schema (`statusCode, error, code, message`, `code`
 *   an enum) behind every 4xx/5xx. An operation with a record id documents
 *   404. A read never documents 403. Writes document 403 whose only example
 *   code is `not_permitted` (the T-0032 engine). updateContact documents 409
 *   `stale_write`.
 *
 *   Scope: no query, header or cookie parameter named like programmeId(s),
 *   tenantId(s) or scope, on any operation; no request body carries
 *   `tenantId` or `programmeIds`. If createContact takes a target
 *   `programmeId`, it also documents 404 (an unreachable target answers like a
 *   missing one). updateContact does not take `programmeId` at all: moving a
 *   record across the BPO isolation boundary is not a field edit.
 *
 *   Write bodies: `additionalProperties: false`. updateContact requires an
 *   integer `version`. Neither accepts server-owned fields (id, tenantId,
 *   createdAt, updatedAt, withheldFields; create also not version).
 *
 *   Money: any money-named property on Contact or Account is minor units plus
 *   an ISO currency, never a float.
 *
 *   Map view (M03 P2): absent, or `x-kasuwa-implemented: false` with a 501.
 *
 * ---------------------------------------------------------------------------
 *
 * D-L23: on main this suite runs before the spec exists. Every test then fails
 * with "docs/api/records.openapi.yaml does not exist" rather than crashing at
 * collection — the spec is loaded lazily and the operation list is static.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const SPEC_REL = 'docs/api/records.openapi.yaml';
const SPEC_PATH = resolve(repoRoot, SPEC_REL);

/**
 * The key the list page puts its rows under. The brief said `items`; the live
 * endpoint and the blocking tenancy suites say `data`. Kept in one place so
 * the lead can flip it with one line if the decision goes the other way.
 */
const PAGE_ROWS = 'data';

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------
// Loading and $ref resolution
// ---------------------------------------------------------------------------

/** Repo-relative, forward slashes, so a failure message reads the same on Windows. */
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

/** The spec, or a clean failure naming why there is none. Never called at collection. */
function spec(): Mapping {
  const { doc, error } = loadDoc(SPEC_PATH);
  if (error !== null) {
    throw new Error(`${error} — T-0039 has not delivered the records contract yet.`);
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

/** Follows `$ref` until it reaches a node that is not one. Throws on a dangling ref. */
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

function requestSchema(op: Operation): Located | undefined {
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
  for (const key of ['oneOf', 'anyOf']) {
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
  const items = child(schema, 'items');
  return items ? enumOf(items) : [];
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

function contactSchema(): Located {
  const schema = jsonSchema(responses(operation('getContact')).get('200'));
  if (!schema) throw new Error('getContact has no 200 application/json schema');
  return schema;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

const CONTACT_OPERATIONS = [
  { id: 'listContacts', method: 'get', path: /^\/api\/v1\/contacts$/ },
  { id: 'getContact', method: 'get', path: /^\/api\/v1\/contacts\/\{[A-Za-z]+\}$/ },
  { id: 'createContact', method: 'post', path: /^\/api\/v1\/contacts$/ },
  { id: 'updateContact', method: 'patch', path: /^\/api\/v1\/contacts\/\{[A-Za-z]+\}$/ },
] as const;

const WRITES = ['createContact', 'updateContact'] as const;

const SCREEN_ID = /^P\d{2}\/[0-9A-Za-z]+$/;

describe('acceptance: records contract (T-0039)', () => {
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
          if (target === undefined) {
            unresolved.push(`${node.$ref} (in ${posix(current.file)})`);
          } else {
            queue.push(target);
          }
        }
        Object.entries(node).forEach(([key, value]) => {
          if (key !== '$ref') queue.push({ node: value, file: current.file });
        });
      }
      expect(unresolved, 'dangling $ref').toEqual([]);
      // Not a vacuous pass: a contract whose error responses share one schema
      // must reference it, so a file with no $ref at all has copied it.
      expect(
        refCount,
        'no $ref at all — the shared Error schema was copied, not referenced',
      ).toBeGreaterThan(0);
    });

    it('operationIds are unique, and no operation opts out of authentication', () => {
      const doc = spec();
      const ids = operations().map((op) => op.id);
      expect(
        ids.filter((id) => id === ''),
        'an operation has no operationId',
      ).toEqual([]);
      expect(
        ids.filter((id, index) => ids.indexOf(id) !== index),
        'duplicate operationId',
      ).toEqual([]);

      expect(Array.isArray(doc.security) && doc.security.length > 0, 'no global security').toBe(
        true,
      );
      for (const op of operations()) {
        if (op.op.security === undefined) continue;
        const list = Array.isArray(op.op.security) ? op.op.security : [];
        expect(list.length, `${op.id} sets security: [] (unauthenticated)`).toBeGreaterThan(0);
        for (const requirement of list) {
          expect(
            isMapping(requirement) && Object.keys(requirement).length > 0,
            `${op.id} lists {} as a security option (authentication optional)`,
          ).toBe(true);
        }
      }
    });

    it('every operation in the file carries x-kasuwa-implemented (boolean) and x-kasuwa-screens', () => {
      const problems: string[] = [];
      for (const op of operations()) {
        if (typeof op.op['x-kasuwa-implemented'] !== 'boolean') {
          problems.push(`${op.id}: x-kasuwa-implemented is not true/false`);
        }
        const screens = op.op['x-kasuwa-screens'];
        if (!Array.isArray(screens) || screens.length === 0) {
          problems.push(`${op.id}: x-kasuwa-screens missing or empty`);
        } else {
          for (const screen of screens) {
            if (!SCREEN_ID.test(str(screen)))
              problems.push(`${op.id}: bad screen id ${String(screen)}`);
          }
        }
      }
      expect(problems).toEqual([]);
    });
  });

  describe('the contacts operations', () => {
    for (const expected of CONTACT_OPERATIONS) {
      it(`${expected.id} is ${expected.method.toUpperCase()} ${String(expected.path)} and names its P04 frames`, () => {
        const op = operation(expected.id);
        expect(op.method, `${expected.id} method`).toBe(expected.method);
        expect(op.path, `${expected.id} path`).toMatch(expected.path);
        expect(typeof op.op['x-kasuwa-implemented'], `${expected.id} x-kasuwa-implemented`).toBe(
          'boolean',
        );
        const screens = Array.isArray(op.op['x-kasuwa-screens'])
          ? op.op['x-kasuwa-screens'].map(str)
          : [];
        expect(
          screens.some((screen) => /^P04\/0[1-6]$/.test(screen)),
          `${expected.id} names no P04 frame (P04/01..P04/06): ${JSON.stringify(screens)}`,
        ).toBe(true);
        if (expected.id === 'listContacts') {
          expect(screens, 'listContacts backs the Contacts list, frame 02').toContain('P04/02');
        }
      });
    }

    it('the record id in a path is a uuid', () => {
      for (const id of ['getContact', 'updateContact']) {
        const op = operation(id);
        const pathParams = op.params.filter((parameter) => parameter.in === 'path');
        expect(pathParams.length, `${id} declares no path parameter`).toBe(1);
        const [only] = pathParams;
        expect(op.path, `${id}: the path parameter is not the one in the path`).toContain(
          `{${str(only?.name)}}`,
        );
        expect(only?.required, `${id}: path parameter not required`).toBe(true);
        const schema = only ? paramSchema(only).node : undefined;
        expect(isMapping(schema) ? schema.format : undefined, `${id}: id is not format uuid`).toBe(
          'uuid',
        );
      }
    });
  });

  describe('listContacts: search, filters, sort and keyset paging', () => {
    it('q is "name or number", a phone matched in E.164, and bounded', () => {
      const q = param(operation('listContacts'), 'q');
      expect(q, 'listContacts has no q query parameter').toBeDefined();
      if (!q) return;
      const schema = paramSchema(q);
      expect(types(schema), 'q type').toContain('string');
      const maxLength = isMapping(schema.node) ? schema.node.maxLength : undefined;
      expect(typeof maxLength === 'number' && maxLength > 0, 'q has no maxLength').toBe(true);
      const description = `${str(q.description)}\n${describedAs(schema)}`;
      expect(description, 'q is not documented as "name or number"').toMatch(/name or number/i);
      expect(description, 'q does not say a phone is matched in E.164').toMatch(/E\.164/);
    });

    const FILTERS: [label: string, name: RegExp][] = [
      ['owner', /^owner(Id)?$/],
      ['status', /^status$/],
      ['source', /^source$/],
      ['tag', /^tags?$/],
      ['state', /^state$/],
      ['lga', /^lga$/i],
      ['dnd', /^dnd$/i],
      ['whatsappOptIn', /^whatsappOptIn$/],
    ];
    for (const [label, name] of FILTERS) {
      it(`filters on ${label} (query parameter ${String(name)})`, () => {
        const found = param(operation('listContacts'), name);
        expect(found, `listContacts has no ${label} filter`).toBeDefined();
        if (found && (label === 'dnd' || label === 'whatsappOptIn')) {
          expect(types(paramSchema(found)), `${label} is a yes/no filter`).toContain('boolean');
        }
      });
    }

    it('sort is an enum, never a free-form column name', () => {
      const sort = param(operation('listContacts'), 'sort');
      expect(sort, 'listContacts has no sort query parameter').toBeDefined();
      if (!sort) return;
      // A free string lets a caller order rows by a field field-security
      // withholds from them: the order leaks the hidden values.
      expect(enumOf(paramSchema(sort)).length, 'sort has no enum').toBeGreaterThan(0);
    });

    it('paging is an opaque cursor and a limit of at most 100; no offset', () => {
      const op = operation('listContacts');
      const cursor = param(op, 'cursor');
      expect(cursor, 'listContacts has no cursor query parameter').toBeDefined();
      if (cursor) {
        expect(types(paramSchema(cursor)), 'cursor type').toContain('string');
        expect(
          `${str(cursor.description)}\n${describedAs(paramSchema(cursor))}`,
          'cursor is not documented as opaque',
        ).toMatch(/opaque/i);
      }

      const limit = param(op, 'limit');
      expect(limit, 'listContacts has no limit query parameter').toBeDefined();
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

      const offsetLike = op.params
        .map((parameter) => str(parameter.name))
        .filter((name) => /^(offset|skip|page|pageNumber|pageNo|pageIndex|start)$/i.test(name));
      expect(offsetLike, 'offset paging').toEqual([]);
    });

    it(`the 200 is { ${PAGE_ROWS}: Contact[], nextCursor } with no total count`, () => {
      const page = jsonSchema(responses(operation('listContacts')).get('200'));
      expect(page, 'listContacts has no 200 application/json schema').toBeDefined();
      if (!page) return;
      const props = properties(page);
      expect([...props.keys()], 'page properties').toEqual(
        expect.arrayContaining([PAGE_ROWS, 'nextCursor']),
      );
      expect(required(page), 'page required').toEqual(
        expect.arrayContaining([PAGE_ROWS, 'nextCursor']),
      );

      const rows = props.get(PAGE_ROWS);
      expect(rows ? types(rows) : [], `${PAGE_ROWS} type`).toContain('array');
      const cursor = props.get('nextCursor');
      expect(cursor ? types(cursor) : [], 'nextCursor type').toEqual(
        expect.arrayContaining(['string', 'null']),
      );

      const counting = [...props.keys()].filter((key) => /total|count|offset|^page$/i.test(key));
      expect(counting, 'the list reports a total or an offset').toEqual([]);

      const item = rows ? child(rows, 'items') : undefined;
      expect(item, `${PAGE_ROWS} has no items schema`).toBeDefined();
      if (item) {
        expect(
          [...properties(item).keys()],
          'a list row does not say which fields were withheld',
        ).toContain('withheldFields');
      }
    });
  });

  describe('scope comes from the session only', () => {
    const SCOPE_NAME = /programme[-_]?ids?|tenant[-_]?ids?|(^|[-_])scope/i;

    it('no operation takes a programme, tenant or scope argument in a query, header or cookie', () => {
      const offending: string[] = [];
      let checked = 0;
      for (const op of operations()) {
        for (const parameter of op.params) {
          if (parameter.in === 'path') continue;
          checked += 1;
          const name = str(parameter.name);
          if (SCOPE_NAME.test(name) || (parameter.in === 'header' && /^x-kasuwa-/i.test(name))) {
            offending.push(`${op.id}: ${str(parameter.in)} ${name}`);
          }
        }
      }
      expect(offending).toEqual([]);
      // listContacts alone has a dozen query parameters; zero means the
      // parameters were not found, not that the rule holds.
      expect(checked, 'no non-path parameters inspected').toBeGreaterThan(0);
    });

    it('no request body carries tenantId or programmeIds', () => {
      const offending: string[] = [];
      for (const op of operations()) {
        const body = requestSchema(op);
        if (!body) continue;
        for (const key of properties(body).keys()) {
          if (/^tenant[-_]?ids?$|^programme[-_]?ids$/i.test(key))
            offending.push(`${op.id}: ${key}`);
        }
      }
      expect(offending).toEqual([]);
    });

    it('a target programmeId on createContact is answered 404 when unreachable; updateContact cannot move a record', () => {
      const create = operation('createContact');
      const createBody = requestSchema(create);
      if (createBody && properties(createBody).has('programmeId')) {
        expect(
          [...responses(create).keys()],
          'createContact takes programmeId but documents no 404 for an unreachable one',
        ).toContain('404');
      }
      // When createContact takes no programmeId this branch is legitimately
      // empty: the server picks the target from the session.

      const updateBody = requestSchema(operation('updateContact'));
      expect(updateBody, 'updateContact has no JSON request body').toBeDefined();
      if (updateBody) {
        expect(
          [...properties(updateBody).keys()],
          'updateContact moves records between programmes',
        ).not.toContain('programmeId');
      }
    });
  });

  describe('errors', () => {
    function errorSchemas(): Map<string, Located> {
      const out = new Map<string, Located>();
      for (const op of operations()) {
        for (const [code, response] of responses(op)) {
          if (!/^[45]\d\d$/.test(code) && code !== 'default') continue;
          const schema = jsonSchema(response);
          if (!schema) throw new Error(`${op.id} ${code} has no application/json schema`);
          out.set(`${op.id} ${code}`, schema);
        }
      }
      return out;
    }

    it('every error response uses one shared Error schema with a code enum', () => {
      const schemas = errorSchemas();
      expect(schemas.size, 'no error responses documented at all').toBeGreaterThan(0);
      const distinct = new Set([...schemas.values()].map((schema) => schema.node));
      expect(distinct.size, `error responses use ${distinct.size} different schemas`).toBe(1);

      const [error] = [...schemas.values()];
      if (!error) return;
      expect(required(error), 'Error envelope').toEqual(
        expect.arrayContaining(['statusCode', 'error', 'code', 'message']),
      );
      const code = properties(error).get('code');
      const codes = code ? enumOf(code).map(str) : [];
      expect(codes, 'Error.code enum').toEqual(
        expect.arrayContaining([
          'validation_failed',
          'not_authenticated',
          'not_permitted',
          'not_found',
          'stale_write',
        ]),
      );

      const strays: string[] = [];
      for (const op of operations()) {
        for (const [status, response] of responses(op)) {
          for (const example of exampleCodes(response)) {
            if (/^[45]/.test(status) && !codes.includes(example)) {
              strays.push(`${op.id} ${status}: ${example}`);
            }
          }
        }
      }
      expect(strays, 'an error example uses a code outside the enum').toEqual([]);
    });

    it('every operation documents 401; every write documents 400', () => {
      for (const op of operations()) {
        expect([...responses(op).keys()], `${op.id} responses`).toContain('401');
      }
      for (const id of WRITES) {
        expect([...responses(operation(id)).keys()], `${id} responses`).toContain('400');
      }
    });

    it('every operation that takes a record id documents 404 not_found, and a read never documents 403', () => {
      let withId = 0;
      for (const op of operations()) {
        if (!op.path.includes('{')) continue;
        withId += 1;
        const all = responses(op);
        const notFound = all.get('404');
        expect(notFound, `${op.id} takes a record id but documents no 404`).toBeDefined();
        if (notFound) {
          for (const example of exampleCodes(notFound)) {
            expect(example, `${op.id} 404 example`).toBe('not_found');
          }
        }
        if (op.method === 'get') {
          expect(
            all.has('403'),
            `${op.id} documents 403: an out-of-scope record must be 404, never 403`,
          ).toBe(false);
        }
      }
      expect(withId, 'no operation with a record id found').toBeGreaterThanOrEqual(2);
    });

    for (const id of WRITES) {
      it(`${id} documents 403 not_permitted, and that 403 is never the not-found answer`, () => {
        const forbidden = responses(operation(id)).get('403');
        expect(forbidden, `${id} documents no 403`).toBeDefined();
        if (!forbidden) return;
        const codes = exampleCodes(forbidden);
        expect(codes.length, `${id} 403 has no example naming its code`).toBeGreaterThan(0);
        expect(
          codes.filter((code) => code !== 'not_permitted'),
          `${id} 403 examples`,
        ).toEqual([]);
      });
    }

    it('updateContact documents 409 stale_write', () => {
      const conflict = responses(operation('updateContact')).get('409');
      expect(conflict, 'updateContact documents no 409').toBeDefined();
      if (conflict) {
        expect(exampleCodes(conflict), 'updateContact 409 examples').toContain('stale_write');
      }
    });
  });

  describe('the Contact shape and field security', () => {
    it('keeps the live fields and adds an integer version', () => {
      const props = properties(contactSchema());
      expect([...props.keys()]).toEqual(
        expect.arrayContaining([
          'id',
          'programmeId',
          'displayName',
          'phones',
          'createdAt',
          'updatedAt',
          'version',
        ]),
      );
      const version = props.get('version');
      expect(version ? types(version) : [], 'version type').toContain('integer');
      const phones = props.get('phones');
      const phone = phones ? child(phones, 'items') : undefined;
      expect(phone ? [...properties(phone).keys()] : [], 'phones[] carries e164').toContain('e164');
    });

    it('withheld fields are omitted, never nulled, and the response lists them', () => {
      const contact = contactSchema();
      const props = properties(contact);
      const withheld = props.get('withheldFields');
      expect(withheld, 'Contact has no withheldFields').toBeDefined();
      if (!withheld) return;
      expect(required(contact), 'withheldFields is always present (possibly empty)').toContain(
        'withheldFields',
      );
      expect(types(withheld), 'withheldFields type').toContain('array');
      const item = child(withheld, 'items');
      expect(item ? types(item) : [], 'withheldFields items').toContain('string');
      expect(describedAs(contact, withheld), 'nothing says a withheld field is omitted').toMatch(
        /omit/i,
      );

      // P04/02 locks Email for the agent role. Omitted-not-null means the
      // field cannot be required, and null cannot be how "withheld" is said.
      const emails = props.get('emails') ?? props.get('email');
      if (emails) {
        expect(required(contact), 'a withholdable field cannot be required').not.toEqual(
          expect.arrayContaining([props.has('emails') ? 'emails' : 'email']),
        );
        expect(types(emails), 'a withheld field is omitted, not null').not.toContain('null');
      }
    });

    it('a write echoes the record through the same withheld-field rule', () => {
      // A create or update response that returned the full row would hand the
      // writer every field field-security hides from their reads.
      for (const [id, status] of [
        ['createContact', '201'],
        ['updateContact', '200'],
      ] as const) {
        const schema = jsonSchema(responses(operation(id)).get(status));
        expect(schema, `${id} has no ${status} application/json schema`).toBeDefined();
        if (schema) {
          expect([...properties(schema).keys()], `${id} ${status}`).toContain('withheldFields');
        }
      }
    });
  });

  describe('money', () => {
    const MONEY_NAME = /amount|revenue|balance|price|cost|turnover|income|spend|money|minor$/i;

    it('any money on Contact or Account is minor units plus a currency, never a float', () => {
      const doc = spec();
      const roots: [string, Located][] = [['Contact (getContact 200)', contactSchema()]];
      const components = isMapping(doc.components) ? doc.components : {};
      const schemas = isMapping(components.schemas) ? components.schemas : {};
      for (const [name, value] of Object.entries(schemas)) {
        if (/^(contact|account)/i.test(name)) roots.push([name, at(value)]);
      }

      const problems: string[] = [];
      const seen = new Set<unknown>();
      const visit = (where: string, schema: Located): void => {
        if (seen.has(schema.node)) return;
        seen.add(schema.node);
        const props = properties(schema);
        for (const [key, value] of props) {
          const path = `${where}.${key}`;
          if (MONEY_NAME.test(key)) {
            const valueTypes = types(value);
            if (valueTypes.includes('number')) problems.push(`${path} is a float`);
            if (valueTypes.includes('object')) {
              const inner = properties(value);
              const minor = [...inner.entries()].find(([name]) => /minor$/i.test(name));
              if (!minor) problems.push(`${path} has no *Minor amount`);
              else if (types(minor[1]).includes('number'))
                problems.push(`${path}.${minor[0]} is a float`);
              if (!inner.has('currency')) problems.push(`${path} has no currency`);
            } else if (!props.has('currency') && !/currency/i.test([...props.keys()].join(' '))) {
              problems.push(`${path} is a bare number with no currency beside it`);
            }
          }
          visit(path, value);
          const items = child(value, 'items');
          if (items) visit(`${path}[]`, items);
        }
      };
      for (const [name, schema] of roots) visit(name, schema);
      // Legitimately vacuous today: D-L60's contact fields carry no money, so
      // `problems` is empty because there is nothing to check. It bites the
      // day an Account grows annual revenue.
      expect(problems).toEqual([]);
    });
  });

  describe('write bodies', () => {
    for (const id of WRITES) {
      it(`${id}: the request body is required, closed (additionalProperties: false) and takes no server-owned field`, () => {
        const op = operation(id);
        const body = op.op.requestBody === undefined ? undefined : at(op.op.requestBody);
        expect(body, `${id} has no requestBody`).toBeDefined();
        expect(isMapping(body?.node) ? body.node.required : undefined, `${id} body required`).toBe(
          true,
        );
        const schema = requestSchema(op);
        expect(schema, `${id} has no application/json body schema`).toBeDefined();
        if (!schema) return;
        expect(
          isMapping(schema.node) ? schema.node.additionalProperties : undefined,
          `${id} body additionalProperties`,
        ).toBe(false);

        const serverOwned = ['id', 'tenantId', 'createdAt', 'updatedAt', 'withheldFields'];
        if (id === 'createContact') serverOwned.push('version');
        expect(
          [...properties(schema).keys()].filter((key) => serverOwned.includes(key)),
          `${id} accepts a server-owned field`,
        ).toEqual([]);
      });
    }

    it('updateContact requires an integer version (optimistic concurrency)', () => {
      const schema = requestSchema(operation('updateContact'));
      expect(schema, 'updateContact has no JSON body schema').toBeDefined();
      if (!schema) return;
      expect(required(schema), 'updateContact body required').toContain('version');
      const version = properties(schema).get('version');
      expect(version ? types(version) : [], 'version type').toContain('integer');
    });
  });

  describe('the P04 map view (M03 P2) is never silently implemented', () => {
    it('any map operation is x-kasuwa-implemented: false and documents 501', () => {
      const maps = operations().filter(
        (op) => /map|geo/i.test(op.id) || /(^|\/)(map|geo)/i.test(op.path),
      );
      for (const op of maps) {
        expect(op.op['x-kasuwa-implemented'], `${op.id} is a map view marked implemented`).toBe(
          false,
        );
        expect([...responses(op).keys()], `${op.id} responses`).toContain('501');
      }
      // Legitimately vacuous when the contract leaves the map out (the other
      // permitted answer). Still asserts the document loaded:
      expect(operations().length, 'no operations parsed').toBeGreaterThan(0);
    });
  });
});
