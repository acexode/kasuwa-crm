import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * ACCEPTANCE — T-0052, the records API contract for ACCOUNTS (D-L69, D-L63,
 * D-L67, D-P13, ADR-0004). Agent 3. Contract only: no route, no migration, no
 * code. Written by QA for the lead from the invariants (D-L23, D-L25), not
 * from an implementation; there is none yet.
 *
 * The artefact under test is `docs/api/records.openapi.yaml`, the file T-0039
 * created for contacts. This suite reads it as data (parsed YAML, never a
 * regex over the text, so a keyword in a YAML comment satisfies nothing) and
 * pins what T-0055 (the Accounts API) and T-0057 (the Accounts screen) will
 * both build against. The T-0039 suite (records-contract.acceptance.test.ts)
 * keeps holding the contacts half and the whole-file rules (every `$ref`
 * resolves, unique operationIds); this suite does not repeat them.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT THIS SUITE PINS (the builder writes the YAML)
 * ---------------------------------------------------------------------------
 *
 *   listAccounts         GET   /api/v1/accounts
 *   createAccount        POST  /api/v1/accounts
 *   getAccount           GET   /api/v1/accounts/{<id>}
 *   updateAccount        PATCH /api/v1/accounts/{<id>}
 *   listAccountContacts  GET   /api/v1/accounts/{<id>}/contacts
 *
 *   PATCH, not PUT, as updateContact. The path parameter is one required
 *   `format: uuid` string; its name is the builder's.
 *
 *   Each carries `x-kasuwa-implemented` (boolean) and `x-kasuwa-screens`
 *   naming at least one of P04/03 (Accounts), P04/05 (empty, no results),
 *   P04/06 (loading, offline); listAccounts names P04/03. The task says
 *   `false` until T-0055. This suite does not pin `false` (that would make
 *   T-0055 edit a lead suite to flip one word); it pins the lie that matters:
 *   `true` with no accounts controller under apps/api/src.
 *
 *   SCOPE (CLAUDE.md 2.2). On every account operation: no parameter in path,
 *   query, header or cookie named like programme, tenant, scope or business
 *   unit; no `x-kasuwa-*` header; no path segment `/programmes/` or
 *   `/tenants/`. Request bodies are scanned RECURSIVELY for tenantId,
 *   programmeIds, scope and programmeId. The one exception is createAccount's
 *   top-level target `programmeId`: a single uuid, and if it exists
 *   createAccount documents 404 (unreachable target answers like a missing
 *   one). updateAccount takes no programmeId: moving a record across the BPO
 *   boundary is not a field edit.
 *     Note: this is BROADER than the contacts suite's name rule. A
 *     `programme=` narrowing filter on listAccounts is refused too, because a
 *     client-supplied programme list is the thing rule 2.2 names a bug.
 *
 *   listAccounts: `q` (string, bounded), filters owner|ownerId|ownerUserId,
 *   tier, industry, tag|tags, state, lga; `sort` an enum; opaque `cursor`;
 *   `limit` 1..N, N <= 100; no offset/page/skip. 200 is
 *   `{ data: Account[], nextCursor: string | null }`, both required, no
 *   total or count (D-P13). A filter on a withheld field is documented as
 *   400 `field_withheld` (the T-0039 rule).
 *     SORT KEYS ARE NEVER-WITHHELD FIELDS. Every sort value, a leading `-`
 *     stripped, must be a property the Account schema REQUIRES. Ordering by a
 *     withholdable field (tier, industry, owner) leaks its values one
 *     comparison at a time; "required" is the contract's own statement of
 *     "never withheld", because a withheld field is omitted.
 *     FILTER VALUE SETS: if Account.tier (or industry) carries an enum, the
 *     filter's enum is the same set, and every value is a snake_case code
 *     (D-L61: labels like "Mid-market" are i18n, never values).
 *
 *   listAccountContacts: the account's contacts the caller can reach. Same
 *   paging and page shape as listContacts. A row REQUIRES `withheldFields`
 *   and carries no property the Contact schema does not have, so no field
 *   escapes Contact's field security by being re-declared on a slimmer row.
 *   It documents 404 for the account, never 403.
 *     THE ATTACK THE TASK DID NOT NAME: P04/02 locks a contact's Account
 *     column for the agent role. Listing an account's contacts IS the filter
 *     `accountId = X`, and it discloses exactly the link field security
 *     withholds. The contract's own rule for a filter on a withheld field is
 *     400 `field_withheld`, so this operation's description must name
 *     `field_withheld` for the case where `accountId` is withheld from the
 *     caller. (Reversible reading; see the T-0052 report. An answer that
 *     returns the rows anyway is the leak.)
 *
 *   Errors: every 4xx/5xx on an account operation resolves to the SAME Error
 *   schema node the contacts operations use (admin.openapi.yaml's). Every
 *   account operation documents 401; writes document 400. An operation with
 *   a record id documents 404 whose examples are only `not_found`. A read
 *   never documents 403. Writes document 403 whose only example code is
 *   `not_permitted`. updateAccount documents 409 `stale_write`.
 *
 *   Account (getAccount 200; and the same rules on createAccount 201,
 *   updateAccount 200 and the listAccounts row):
 *     present:  id (uuid), programmeId (uuid), name (string), version
 *               (integer), createdAt, updatedAt (date-time), owner, industry,
 *               tier, tags (string[]), phones (items with an E.164 `e164`),
 *               state, lga, parentAccountId (uuid or null), withheldFields
 *               (string[]).
 *     required: id, programmeId, name, version, createdAt, updatedAt,
 *               withheldFields — the never-withheld set.
 *     optional: owner, industry, tier, tags, phones, state, lga,
 *               parentAccountId. A field-secured field is OMITTED, never
 *               nulled, so it cannot be required; and a list (tags, phones)
 *               is never nullable (an empty list means none).
 *     owner:    `{ id: uuid, displayName: string } | null`, the T-0043
 *               ruling: exactly one object branch, CLOSED, both required,
 *               nothing else (no email, phone, programme). `null` is
 *               unassigned.
 *     absent:   any Health, score, deal or pipeline property, a count or
 *               total of related records (contactCount, ...), or an
 *               embedded children list (D-L69: Health waits for M17; a
 *               hierarchy rollup of deals has no owning module). A count of
 *               an account's contacts is also a D-P13 total by another
 *               name. Firmographics (employeeCount) are not matched.
 *
 *   Write bodies: requestBody required, `additionalProperties: false`. No
 *   id, tenantId, createdAt, updatedAt, withheldFields; create also no
 *   version; neither takes the embedded `owner` object (its displayName is
 *   the server's). The owner is set by id: both bodies take `ownerUserId`
 *   or `ownerId`, a uuid or null. createAccount requires `name`.
 *   updateAccount requires an integer `version`. A `parentAccountId`, if
 *   taken, is a single uuid or null.
 *
 *   Money: any money-named property on an account-shaped schema is minor
 *   units plus an ISO currency, never a float (CLAUDE.md 4).
 *
 *   Map view and Health: an account operation whose id or path says map,
 *   geo or health is `x-kasuwa-implemented: false`, documents 501 in the
 *   shared envelope, and any 501 example code is `not_implemented`.
 *
 * THE BUILDER'S CHOICE (not asserted): operation descriptions beyond the
 * `field_withheld` sentence; the path parameter's name; whether tier and
 * industry are enums (only their consistency is pinned); the owner filter's
 * value syntax (`me`, `unassigned`); whether Account also carries a bare
 * `ownerUserId` beside `owner`; extra optional Account fields that are not
 * money, rollups or counts; whether createAccount takes a target
 * programmeId; the sort enum's members, within the never-withheld rule;
 * how an unreachable `ownerUserId` or `parentAccountId` is answered (D-L67
 * says 400 `unknown_reference` for contacts, and T-0055's suite will test
 * that on the wire, not this one).
 *
 * NOT here, deliberately: leads (D-P17 is open), DND on account phones (the
 * P04/03 split view greys SMS for DND; no decision yet says where that flag
 * lives for an account), FX ("Show US$", D-L69).
 *
 * ---------------------------------------------------------------------------
 *
 * D-L23: on main the file has no account operation. Every test then fails
 * naming the missing operationId (or, for the shape tests, the missing
 * getAccount) rather than crashing at collection: the spec is loaded lazily
 * and the operation list is static. The negative invariants (no scope
 * parameter, no 403 on reads, no Health) first require the account
 * operations to exist, so none of them passes on a file that has none.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const SPEC_REL = 'docs/api/records.openapi.yaml';
const SPEC_PATH = resolve(repoRoot, SPEC_REL);
const API_SRC = resolve(repoRoot, 'apps', 'api', 'src');

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

const ACCOUNT_OPERATIONS = [
  { id: 'listAccounts', method: 'get', path: /^\/api\/v1\/accounts$/ },
  { id: 'getAccount', method: 'get', path: /^\/api\/v1\/accounts\/\{[A-Za-z]+\}$/ },
  { id: 'createAccount', method: 'post', path: /^\/api\/v1\/accounts$/ },
  { id: 'updateAccount', method: 'patch', path: /^\/api\/v1\/accounts\/\{[A-Za-z]+\}$/ },
  {
    id: 'listAccountContacts',
    method: 'get',
    path: /^\/api\/v1\/accounts\/\{[A-Za-z]+\}\/contacts$/,
  },
] as const;

const READS = ['listAccounts', 'getAccount', 'listAccountContacts'] as const;
const WRITES = ['createAccount', 'updateAccount'] as const;

/**
 * The five named operations plus every other operation under /api/v1/accounts
 * (a map or Health stub, say). Throws if any of the five is missing, so a
 * negative invariant iterated over this list cannot pass on a file that has
 * no accounts at all.
 */
function accountOperations(): Operation[] {
  for (const expected of ACCOUNT_OPERATIONS) operation(expected.id);
  // Any `accounts` segment, not only the /api/v1/accounts prefix: a
  // /programmes/{id}/accounts route is exactly the scope-in-path to catch.
  return operations().filter((op) => /(^|\/)accounts(\/|$)/.test(op.path));
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

function exampleValues(holder: Located): Mapping[] {
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
  return values.filter(isMapping);
}

function exampleCodes(holder: Located): string[] {
  return exampleValues(holder).map((value) => str(value.code));
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

/** The enum of a schema, its `items`, or its non-null oneOf/anyOf branch. */
function enumOf(schema: Located): unknown[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
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

/** A `format` on the schema or on any of its non-null branches. */
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

function accountSchema(): Located {
  return responseSchema('getAccount', '200');
}

function contactSchema(): Located {
  return responseSchema('getContact', '200');
}

function pageRows(id: string): Located {
  const page = responseSchema(id, '200');
  const rows = properties(page).get('data');
  const item = rows ? child(rows, 'items') : undefined;
  if (!item) throw new Error(`${id} 200 has no data[] items schema`);
  return item;
}

/** Every schema the API hands an account back in. Each must obey the Account rules. */
function accountShapes(): [string, Located][] {
  return [
    ['getAccount 200', accountSchema()],
    ['createAccount 201', responseSchema('createAccount', '201')],
    ['updateAccount 200', responseSchema('updateAccount', '200')],
    ['listAccounts data[]', pageRows('listAccounts')],
  ];
}

/** Every key at every depth of a schema, as dotted paths. Cycle-safe. */
function deepKeys(schema: Located, prefix = '', seen = new Set<unknown>()): string[] {
  if (seen.has(schema.node)) return [];
  seen.add(schema.node);
  const out: string[] = [];
  for (const [key, value] of properties(schema)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    out.push(path);
    out.push(...deepKeys(value, path, seen));
    const items = child(value, 'items');
    if (items) out.push(...deepKeys(items, `${path}[]`, seen));
    const node = value.node;
    for (const combinator of ['oneOf', 'anyOf']) {
      const variants = isMapping(node) ? node[combinator] : undefined;
      if (Array.isArray(variants)) {
        for (const variant of variants) out.push(...deepKeys(at(variant, value.file), path, seen));
      }
    }
  }
  return out;
}

/** The single object branch of `owner`, or a failure naming why there is none. */
function ownerObject(owner: Located, where: string): Located {
  const node = owner.node;
  const variants = isMapping(node)
    ? [node.oneOf, node.anyOf].find((value): value is unknown[] => Array.isArray(value))
    : undefined;
  if (variants) {
    const objects = variants
      .map((variant) => at(variant, owner.file))
      .filter((variant) => types(variant).includes('object'));
    if (objects.length !== 1) {
      throw new Error(
        `${where}.owner: expected exactly one object branch, found ${objects.length}`,
      );
    }
    const [only] = objects;
    if (!only) throw new Error(`${where}.owner: no object branch`);
    return only;
  }
  return owner;
}

/** Whether an apps/api/src controller declares an accounts route. */
function accountsControllerExists(): boolean {
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
      if (text.includes('@Controller(') && /['"`][^'"`\n]*\baccounts\b[^'"`\n]*['"`]/.test(text)) {
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

/** Account properties field security may withhold: never required (omitted, not nulled). */
const WITHHOLDABLE = [
  'owner',
  'industry',
  'tier',
  'tags',
  'phones',
  'state',
  'lga',
  'parentAccountId',
] as const;
const NEVER_WITHHELD = [
  'id',
  'programmeId',
  'name',
  'version',
  'createdAt',
  'updatedAt',
  'withheldFields',
] as const;

/**
 * Health, scores, deal rollups, counts of related records and embedded
 * children (D-L69, D-P13). Firmographics such as `employeeCount` or an
 * `annualRevenue` (money rules below) are not rollups and are not matched.
 */
const NO_ROLLUP =
  /health|score|deal|pipeline|opportunit|roll_?up|children|childAccount|subsidiar|(contacts?|tickets?|activit(y|ies)|leads?|accounts?)(Count|Total)|^(count|total)/i;

describe('acceptance: records contract, accounts (T-0052)', () => {
  describe('the account operations', () => {
    for (const expected of ACCOUNT_OPERATIONS) {
      it(`${expected.id} is ${expected.method.toUpperCase()} ${String(expected.path)} and names its P04 frames`, () => {
        const op = operation(expected.id);
        expect(op.method, `${expected.id} method`).toBe(expected.method);
        expect(op.path, `${expected.id} path`).toMatch(expected.path);
        expect(typeof op.op['x-kasuwa-implemented'], `${expected.id} x-kasuwa-implemented`).toBe(
          'boolean',
        );
        const raw = op.op['x-kasuwa-screens'];
        expect(
          Array.isArray(raw) && raw.length > 0,
          `${expected.id} x-kasuwa-screens missing or empty`,
        ).toBe(true);
        const screens = Array.isArray(raw) ? raw.map(str) : [];
        expect(
          screens.filter((screen) => !SCREEN_ID.test(screen)),
          `${expected.id}: bad screen ids`,
        ).toEqual([]);
        expect(
          screens.some((screen) => /^P04\/0[356]$/.test(screen)),
          `${expected.id} names none of P04/03, P04/05, P04/06: ${JSON.stringify(screens)}`,
        ).toBe(true);
        if (expected.id === 'listAccounts') {
          expect(screens, 'listAccounts backs the Accounts list, frame 03').toContain('P04/03');
        }
      });
    }

    it('the record id in an account path is one required uuid, the one the path names', () => {
      for (const id of ['getAccount', 'updateAccount', 'listAccountContacts']) {
        const op = operation(id);
        const pathParams = op.params.filter((parameter) => parameter.in === 'path');
        expect(pathParams.length, `${id} path parameters`).toBe(1);
        const [only] = pathParams;
        expect(op.path, `${id}: the path parameter is not the one in the path`).toContain(
          `{${str(only?.name)}}`,
        );
        expect(only?.required, `${id}: path parameter not required`).toBe(true);
        expect(only ? formatOf(paramSchema(only)) : '', `${id}: id is not format uuid`).toBe(
          'uuid',
        );
      }
    });

    it('no account operation claims x-kasuwa-implemented: true without an accounts controller', () => {
      const claimed = accountOperations()
        .filter((op) => op.op['x-kasuwa-implemented'] === true)
        .map((op) => op.id);
      if (claimed.length > 0) {
        expect(
          accountsControllerExists(),
          `${claimed.join(', ')} marked implemented, but no @Controller under apps/api/src routes accounts`,
        ).toBe(true);
      }
      // Legitimately vacuous while every operation says false (the task's
      // state until T-0055). accountOperations() above still fails the test
      // on a file with no account operations.
    });

    it('every account operation is authenticated (no security: [] or {} override)', () => {
      const doc = spec();
      expect(Array.isArray(doc.security) && doc.security.length > 0, 'no global security').toBe(
        true,
      );
      const problems: string[] = [];
      for (const op of accountOperations()) {
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

  describe('scope comes from the session only', () => {
    const SCOPE_NAME = /programme|tenant|scope|business[-_]?unit|^bu$/i;

    it('no account operation takes a programme, tenant or scope argument in a path, query, header or cookie', () => {
      const offending: string[] = [];
      let checked = 0;
      for (const op of accountOperations()) {
        if (/\/(programmes|tenants|business-units)\//i.test(op.path)) {
          offending.push(`${op.id}: path ${op.path}`);
        }
        for (const parameter of op.params) {
          checked += 1;
          const name = str(parameter.name);
          const where = str(parameter.in);
          if (SCOPE_NAME.test(name)) offending.push(`${op.id}: ${where} ${name}`);
          if (where === 'header' && /^x-kasuwa-/i.test(name)) {
            offending.push(`${op.id}: header ${name}`);
          }
          if (where === 'cookie') offending.push(`${op.id}: cookie ${name} (auth is bearer only)`);
        }
      }
      expect(offending).toEqual([]);
      // listAccounts alone has a dozen parameters; zero means none were found.
      expect(checked, 'no parameters inspected').toBeGreaterThan(5);
    });

    it('no account request body carries tenantId, programmeIds or scope, at any depth', () => {
      const offending: string[] = [];
      let bodies = 0;
      for (const op of accountOperations()) {
        const body = requestSchema(op);
        if (!body) continue;
        bodies += 1;
        for (const path of deepKeys(body)) {
          const leaf = path.split('.').pop() ?? path;
          const bare = leaf.replace(/\[\]$/, '');
          if (
            /^(tenant[-_]?ids?|programme[-_]?ids|scopes?|business[-_]?unit[-_]?ids?)$/i.test(bare)
          ) {
            offending.push(`${op.id}: ${path}`);
          }
          // createAccount's top-level target is the one programmeId allowed.
          const topLevelTarget = op.id === 'createAccount' && path === 'programmeId';
          if (/^programme[-_]?id$/i.test(bare) && !topLevelTarget) {
            offending.push(`${op.id}: ${path}`);
          }
        }
      }
      expect(offending).toEqual([]);
      expect(bodies, 'createAccount and updateAccount carry no JSON body').toBe(2);
    });

    it("createAccount's target programmeId, if taken, is one uuid and an unreachable one is 404", () => {
      const create = operation('createAccount');
      const body = requestSchema(create);
      expect(body, 'createAccount has no JSON request body').toBeDefined();
      const target = body ? properties(body).get('programmeId') : undefined;
      if (target) {
        expect(types(target), 'programmeId is a single value, not a list').not.toContain('array');
        expect(formatOf(target), 'programmeId format').toBe('uuid');
        expect(
          [...responses(create).keys()],
          'createAccount takes programmeId but documents no 404 for an unreachable one',
        ).toContain('404');
      }
      // When createAccount takes no programmeId this branch is legitimately
      // empty: the server picks the target from the session.
    });
  });

  describe('listAccounts: search, filters, sort and keyset paging', () => {
    it('q searches by name, and is bounded', () => {
      const q = param(operation('listAccounts'), 'q');
      expect(q, 'listAccounts has no q query parameter').toBeDefined();
      if (!q) return;
      const schema = paramSchema(q);
      expect(types(schema), 'q type').toContain('string');
      const maxLength = isMapping(schema.node) ? schema.node.maxLength : undefined;
      expect(typeof maxLength === 'number' && maxLength > 0, 'q has no maxLength').toBe(true);
      expect(
        `${str(q.description)}\n${describedAs(schema)}`,
        'q does not say it matches the name',
      ).toMatch(/name/i);
    });

    const FILTERS: [label: string, name: RegExp][] = [
      ['owner', /^owner(Id|UserId)?$/],
      ['tier', /^tier$/],
      ['industry', /^industry$/],
      ['tag', /^tags?$/],
      ['state', /^state$/],
      ['lga', /^lga$/i],
    ];
    for (const [label, name] of FILTERS) {
      it(`filters on ${label} (query parameter ${String(name)})`, () => {
        expect(
          param(operation('listAccounts'), name),
          `listAccounts has no ${label} filter`,
        ).toBeDefined();
      });
    }

    it('the tier and industry filters accept exactly the values Account carries, as snake_case codes', () => {
      const account = properties(accountSchema());
      const op = operation('listAccounts');
      for (const field of ['tier', 'industry']) {
        const filter = param(op, field);
        const property = account.get(field);
        expect(filter, `listAccounts has no ${field} filter`).toBeDefined();
        expect(property, `Account has no ${field}`).toBeDefined();
        if (!filter || !property) continue;
        const onRecord = enumOf(property).map(str).sort();
        const onFilter = enumOf(paramSchema(filter)).map(str).sort();
        expect(
          onFilter,
          `${field}: the filter's value set differs from Account.${field}'s`,
        ).toEqual(onRecord);
        // D-L61: stored values are codes; "Mid-market" is an i18n label.
        expect(
          onRecord.filter((value) => !/^[a-z][a-z0-9_]*$/.test(value)),
          `${field}: enum values that are display labels, not codes`,
        ).toEqual([]);
        // Both sets are legitimately empty when the field is free text.
      }
    });

    it('sort is an enum whose every key is a never-withheld (required) Account property', () => {
      const sort = param(operation('listAccounts'), 'sort');
      expect(sort, 'listAccounts has no sort query parameter').toBeDefined();
      if (!sort) return;
      const keys = enumOf(paramSchema(sort)).map(str);
      expect(keys.length, 'sort has no enum (a free column name)').toBeGreaterThan(0);
      // Ordering by a field the caller cannot read leaks its values one
      // comparison at a time. "Required" is the contract's own word for
      // "never withheld", because a withheld field is omitted.
      const never = required(accountSchema());
      expect(
        keys.map((key) => key.replace(/^-/, '')).filter((key) => !never.includes(key)),
        'sort keys on a withholdable (non-required) field',
      ).toEqual([]);
    });

    it('a filter on a field withheld from the caller is documented as 400 field_withheld', () => {
      const op = operation('listAccounts');
      const bad = responses(op).get('400');
      expect(bad, 'listAccounts documents no 400').toBeDefined();
      if (!bad) return;
      const text = `${str(op.op.description)}\n${describedAs(bad)}\n${JSON.stringify(exampleValues(bad))}`;
      expect(text, 'nothing on listAccounts or its 400 names field_withheld').toMatch(
        /field_withheld/,
      );
    });
  });

  describe('keyset paging on both account lists (D-P13)', () => {
    for (const id of ['listAccounts', 'listAccountContacts'] as const) {
      it(`${id}: an opaque cursor and a limit of at most 100; no offset or page`, () => {
        const op = operation(id);
        const cursor = param(op, 'cursor');
        expect(cursor, `${id} has no cursor query parameter`).toBeDefined();
        if (cursor) {
          expect(types(paramSchema(cursor)), 'cursor type').toContain('string');
          expect(
            `${str(cursor.description)}\n${describedAs(paramSchema(cursor))}`,
            'cursor is not documented as opaque',
          ).toMatch(/opaque/i);
        }
        const limit = param(op, 'limit');
        expect(limit, `${id} has no limit query parameter`).toBeDefined();
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

      it(`${id}: the 200 is { data, nextCursor } with no total or count`, () => {
        const page = responseSchema(id, '200');
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
        expect(
          [...props.keys()].filter((key) => /total|count|offset|^page$/i.test(key)),
          'the page reports a total, a count or an offset',
        ).toEqual([]);
        const row = pageRows(id);
        expect(required(row), `${id} rows do not always say which fields were withheld`).toContain(
          'withheldFields',
        );
      });
    }
  });

  describe("listAccountContacts: the account's contacts the caller can reach", () => {
    it('a row is a Contact under Contact field security: no property the Contact schema lacks', () => {
      const contact = new Set(properties(contactSchema()).keys());
      const row = [...properties(pageRows('listAccountContacts')).keys()];
      expect(row.length, 'the row schema has no properties').toBeGreaterThan(0);
      expect(
        row.filter((key) => !contact.has(key)),
        'row properties outside Contact (they escape its field security)',
      ).toEqual([]);
    });

    it('when contact.accountId is withheld from the caller, the operation says field_withheld', () => {
      // P04/02 locks Account for the agent role. Listing an account's
      // contacts is the filter accountId = X and discloses exactly that link.
      const op = operation('listAccountContacts');
      const bad = responses(op).get('400');
      expect(bad, 'listAccountContacts documents no 400').toBeDefined();
      expect(str(op.op.description), 'listAccountContacts description').toMatch(/field_withheld/);
      expect(str(op.op.description), 'the description does not name accountId').toMatch(
        /accountId/,
      );
    });
  });

  describe('errors', () => {
    it('every account error response uses the same Error schema as contacts', () => {
      const shared = jsonSchema(responses(operation('getContact')).get('404'));
      if (!shared) throw new Error('getContact 404 has no schema to compare against');
      const strays: string[] = [];
      let count = 0;
      for (const op of accountOperations()) {
        for (const [code, response] of responses(op)) {
          if (!/^[45]\d\d$/.test(code) && code !== 'default') continue;
          count += 1;
          const schema = jsonSchema(response);
          if (!schema) strays.push(`${op.id} ${code}: no application/json schema`);
          else if (schema.node !== shared.node) strays.push(`${op.id} ${code}: a different schema`);
        }
      }
      expect(strays).toEqual([]);
      expect(count, 'no account error responses documented at all').toBeGreaterThanOrEqual(10);
    });

    it('every account operation documents 401; every write documents 400', () => {
      for (const op of accountOperations()) {
        expect([...responses(op).keys()], `${op.id} responses`).toContain('401');
      }
      for (const id of WRITES) {
        expect([...responses(operation(id)).keys()], `${id} responses`).toContain('400');
      }
    });

    it('an account operation with a record id documents 404 not_found; a read never documents 403', () => {
      for (const id of READS) {
        expect([...responses(operation(id)).keys()], `${id} documents 403`).not.toContain('403');
      }
      let withId = 0;
      for (const op of accountOperations()) {
        if (op.method === 'get') {
          expect(
            responses(op).has('403'),
            `${op.id} documents 403: an out-of-scope account is 404, never 403`,
          ).toBe(false);
        }
        if (!op.path.includes('{')) continue;
        withId += 1;
        const notFound = responses(op).get('404');
        expect(notFound, `${op.id} takes a record id but documents no 404`).toBeDefined();
        if (notFound) {
          expect(
            exampleCodes(notFound).filter((code) => code !== 'not_found'),
            `${op.id} 404 examples`,
          ).toEqual([]);
        }
      }
      expect(withId, 'getAccount, updateAccount, listAccountContacts').toBeGreaterThanOrEqual(3);
    });

    for (const id of WRITES) {
      it(`${id} documents 403 whose only example code is not_permitted`, () => {
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

    it('updateAccount documents 409 stale_write', () => {
      const conflict = responses(operation('updateAccount')).get('409');
      expect(conflict, 'updateAccount documents no 409').toBeDefined();
      if (conflict) {
        expect(exampleCodes(conflict), 'updateAccount 409 examples').toContain('stale_write');
      }
    });
  });

  describe('the Account shape and field security', () => {
    it("carries the task's properties with their types", () => {
      const props = properties(accountSchema());
      expect([...props.keys()]).toEqual(
        expect.arrayContaining([...NEVER_WITHHELD, ...WITHHOLDABLE]),
      );
      const typeOf = (key: string): string[] => {
        const value = props.get(key);
        return value ? types(value) : [];
      };
      const formatAt = (key: string): string => {
        const value = props.get(key);
        return value ? formatOf(value) : '';
      };
      expect(formatAt('id'), 'id format').toBe('uuid');
      expect(formatAt('programmeId'), 'programmeId format').toBe('uuid');
      expect(typeOf('name'), 'name type').toContain('string');
      expect(typeOf('version'), 'version type').toContain('integer');
      expect(formatAt('createdAt'), 'createdAt format').toBe('date-time');
      expect(formatAt('updatedAt'), 'updatedAt format').toBe('date-time');
      expect(typeOf('parentAccountId'), 'parentAccountId type').toEqual(
        expect.arrayContaining(['string', 'null']),
      );
      expect(formatAt('parentAccountId'), 'parentAccountId format').toBe('uuid');
      expect(typeOf('tags'), 'tags type').toContain('array');
      const tag = props.get('tags');
      const tagItem = tag ? child(tag, 'items') : undefined;
      expect(tagItem ? types(tagItem) : [], 'tags items').toContain('string');
    });

    it('phones[] carry an E.164 number, and the pattern rejects a local one', () => {
      const phones = properties(accountSchema()).get('phones');
      expect(phones ? types(phones) : [], 'phones type').toContain('array');
      const item = phones ? child(phones, 'items') : undefined;
      const e164 = item ? properties(item).get('e164') : undefined;
      expect(e164, 'phones[] carries no e164').toBeDefined();
      const pattern = e164 && isMapping(e164.node) ? str(e164.node.pattern) : '';
      expect(pattern, 'e164 has no pattern').not.toBe('');
      const compiled = new RegExp(pattern);
      expect(compiled.test('+2348031234567'), 'pattern refuses an E.164 number').toBe(true);
      expect(compiled.test('08031234567'), 'pattern accepts a local number').toBe(false);
    });

    it('withheld fields are omitted, never nulled, and every account-shaped response lists them', () => {
      for (const [where, shape] of accountShapes()) {
        const props = properties(shape);
        const req = required(shape);
        const withheld = props.get('withheldFields');
        expect(withheld, `${where} has no withheldFields`).toBeDefined();
        expect(req, `${where}: withheldFields is always present`).toContain('withheldFields');
        expect(withheld ? types(withheld) : [], `${where}: withheldFields type`).toContain('array');
        const item = withheld ? child(withheld, 'items') : undefined;
        expect(item ? types(item) : [], `${where}: withheldFields items`).toContain('string');
        expect(
          WITHHOLDABLE.filter((key) => req.includes(key)),
          `${where}: a withholdable field is required (it must be omittable)`,
        ).toEqual([]);
        for (const list of ['tags', 'phones']) {
          const value = props.get(list);
          if (value) {
            expect(
              types(value),
              `${where}.${list}: a list is never null (empty means none)`,
            ).not.toContain('null');
          }
        }
      }
      expect(
        required(accountSchema()),
        'the never-withheld fields are required on Account',
      ).toEqual(expect.arrayContaining([...NEVER_WITHHELD]));
      expect(
        describedAs(accountSchema(), properties(accountSchema()).get('withheldFields')),
        'nothing on Account says a withheld field is omitted',
      ).toMatch(/omit/i);
    });

    it('owner is { id: uuid, displayName } | null, closed, on every account-shaped response', () => {
      for (const [where, shape] of accountShapes()) {
        const owner = properties(shape).get('owner');
        expect(owner, `${where} has no owner`).toBeDefined();
        if (!owner) continue;
        expect(types(owner), `${where}.owner admits null (unassigned)`).toContain('null');
        const object = ownerObject(owner, where);
        const props = properties(object);
        expect([...props.keys()].sort(), `${where}.owner properties`).toEqual([
          'displayName',
          'id',
        ]);
        expect(
          isMapping(object.node) ? object.node.additionalProperties : undefined,
          `${where}.owner is not closed`,
        ).toBe(false);
        expect(required(object), `${where}.owner required`).toEqual(
          expect.arrayContaining(['id', 'displayName']),
        );
        const id = props.get('id');
        expect(id ? formatOf(id) : '', `${where}.owner.id format`).toBe('uuid');
        const name = props.get('displayName');
        expect(name ? types(name) : [], `${where}.owner.displayName type`).toContain('string');
      }
    });

    it('no Health, score, deal rollup, count or children on any account-shaped schema', () => {
      const doc = spec();
      const roots = accountShapes();
      const components = isMapping(doc.components) ? doc.components : {};
      const schemas = isMapping(components.schemas) ? components.schemas : {};
      for (const [name, value] of Object.entries(schemas)) {
        if (/^account/i.test(name)) roots.push([`components.schemas.${name}`, at(value)]);
      }
      const offending: string[] = [];
      for (const [where, shape] of roots) {
        for (const path of deepKeys(shape)) {
          const leaf = path.split('.').pop() ?? path;
          if (NO_ROLLUP.test(leaf)) offending.push(`${where}: ${path}`);
        }
      }
      expect(offending).toEqual([]);
      // Not vacuous: accountShapes() throws on a file with no getAccount.
    });

    it('any money on an account-shaped schema is minor units plus a currency, never a float', () => {
      const MONEY_NAME = /amount|revenue|balance|price|cost|turnover|income|spend|money|minor$/i;
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
            } else if (![...props.keys()].some((name) => /currency/i.test(name))) {
              problems.push(`${path} is a bare amount with no currency beside it`);
            }
          }
          visit(path, value);
          const items = child(value, 'items');
          if (items) visit(`${path}[]`, items);
        }
      };
      for (const [where, shape] of accountShapes()) visit(where, shape);
      // Legitimately vacuous today: the task's Account fields carry no money,
      // so `problems` is empty because nothing is money-named. It bites the
      // day an annual revenue lands. accountShapes() fails on a file with no
      // accounts, so this cannot pass on main.
      expect(problems).toEqual([]);
    });
  });

  describe('write bodies', () => {
    for (const id of WRITES) {
      it(`${id}: the request body is required, closed and takes no server-owned field`, () => {
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
        const serverOwned = ['id', 'tenantId', 'createdAt', 'updatedAt', 'withheldFields', 'owner'];
        if (id === 'createAccount') serverOwned.push('version');
        expect(
          [...properties(schema).keys()].filter((key) => serverOwned.includes(key)),
          `${id} accepts a server-owned field`,
        ).toEqual([]);
      });

      it(`${id}: the owner is set by id (ownerUserId or ownerId, uuid or null)`, () => {
        const schema = requestSchema(operation(id));
        expect(schema, `${id} has no JSON body schema`).toBeDefined();
        if (!schema) return;
        const props = properties(schema);
        const key = ['ownerUserId', 'ownerId'].find((candidate) => props.has(candidate));
        expect(key, `${id} cannot set the owner`).toBeDefined();
        const owner = key ? props.get(key) : undefined;
        expect(owner ? types(owner) : [], `${id}.${String(key)} type`).toEqual(
          expect.arrayContaining(['string', 'null']),
        );
        expect(owner ? formatOf(owner) : '', `${id}.${String(key)} format`).toBe('uuid');
        const parent = props.get('parentAccountId');
        if (parent) {
          expect(types(parent), `${id}.parentAccountId is one id`).not.toContain('array');
          expect(formatOf(parent), `${id}.parentAccountId format`).toBe('uuid');
        }
      });
    }

    it('createAccount requires a name', () => {
      const schema = requestSchema(operation('createAccount'));
      expect(schema, 'createAccount has no JSON body schema').toBeDefined();
      if (!schema) return;
      expect(required(schema), 'createAccount body required').toContain('name');
      const name = properties(schema).get('name');
      expect(name ? types(name) : [], 'name type').toContain('string');
      expect(name ? types(name) : [], 'name may be null').not.toContain('null');
    });

    it('updateAccount requires an integer version and cannot move an account between programmes', () => {
      const schema = requestSchema(operation('updateAccount'));
      expect(schema, 'updateAccount has no JSON body schema').toBeDefined();
      if (!schema) return;
      expect(required(schema), 'updateAccount body required').toContain('version');
      const version = properties(schema).get('version');
      expect(version ? types(version) : [], 'version type').toContain('integer');
      expect([...properties(schema).keys()], 'updateAccount takes programmeId').not.toContain(
        'programmeId',
      );
    });
  });

  describe('the Map view and Health are never silently implemented', () => {
    it('any account map, geo or health operation is x-kasuwa-implemented: false and documents 501', () => {
      const stubs = accountOperations().filter(
        (op) => /map|geo|health/i.test(op.id) || /\/(map|geo|health)/i.test(op.path),
      );
      for (const op of stubs) {
        expect(op.op['x-kasuwa-implemented'], `${op.id} marked implemented`).toBe(false);
        const notImplemented = responses(op).get('501');
        expect(notImplemented, `${op.id} documents no 501`).toBeDefined();
        if (notImplemented) {
          expect(
            exampleCodes(notImplemented).filter((code) => code !== 'not_implemented'),
            `${op.id} 501 examples`,
          ).toEqual([]);
        }
        const screens = Array.isArray(op.op['x-kasuwa-screens'])
          ? op.op['x-kasuwa-screens'].map(str)
          : [];
        expect(screens.length, `${op.id} names no screen`).toBeGreaterThan(0);
      }
      // Legitimately vacuous when the contract leaves the map out (the T-0039
      // file's own choice). accountOperations() still fails on main.
    });
  });
});
