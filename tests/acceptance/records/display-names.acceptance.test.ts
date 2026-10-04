import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { inspect } from 'node:util';
import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import {
  BU_A,
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  PROGRAMME_B2,
  SEED_CONTACTS,
  SEED_PERMISSION_SETS,
  SEED_TENANTS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { parse } from 'yaml';
import { asUser } from '../support/api';
import { collectTelemetry, isInboundApiSpan, type Telemetry } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0043, scoped display names for the records screens (D-L64).
 * Contract: Agent 3. Scope review: Agent 1. Suite: Agent 12 (QA).
 *
 * The records screens may never print a UUID (D-L64), but
 * `docs/api/records.openapi.yaml` returns only ids. T-0043 adds two things,
 * and this suite pins both on the wire AND in the published contract:
 *
 *   1. `GET /api/v1/me/programmes` — operationId `listMyProgrammes`. The
 *      caller's own programmes, with their names: `{ data: [{ id, name }] }`.
 *      Exactly the caller's `user_programme` rows (D-L06: the session decides
 *      scope; the caller never does). No parameter can change whose
 *      programmes are listed.
 *
 *   2. Owner display names, EMBEDDED ON THE CONTACT:
 *
 *        Contact.owner: { id: uuid, displayName: string } | null
 *
 *      `owner.id` always equals `ownerUserId`; `null` exactly when
 *      `ownerUserId` is null (unassigned). The object is CLOSED: `id` and
 *      `displayName` and nothing else — no email, phone, locale or status.
 *
 * ------------------------------------------------------------------------
 * WHY EMBEDDED, NOT A BATCH `GET /api/v1/users/display-names?ids=` (the lead
 * asked QA to pick the safer shape and say why):
 *
 *   - "Not a user directory" becomes true BY CONSTRUCTION. An embedded name is
 *     read in the same scoped query as the row it decorates, so it exists only
 *     where the caller can already see a contact. A batch endpoint takes
 *     caller-supplied user ids and must then PROVE, per id, that some visible
 *     contact is owned by that user. Every such proof is an enumeration oracle
 *     to keep closed forever: status codes, omitted-vs-null, ordering, timing,
 *     the 100-id cap as a probe rate. Embedded has no input to probe.
 *   - `user` is RLS-scoped to the TENANT only (0001: "which users a given user
 *     may see is a permissions question, not a tenancy question"), so RLS is
 *     not a second layer for a lookup keyed on user id. A batch endpoint with
 *     one missing predicate is a tenant-wide name directory across BPO client
 *     boundaries. Embedded inherits the contact's programme-scoped RLS.
 *   - Field security composes. If `ownerUserId` is withheld from a caller, an
 *     embedded `owner` is withheld with it (tested below). A separate endpoint
 *     would hand the id back to anyone who could guess it.
 *   - One round trip; no second query the screen can get out of step with.
 *
 *   Cost, accepted: `Contact` grows one property. It is additive, and the
 *   T-0041 suite reads Contact's property list FROM THE SPEC, so it will
 *   simply expect `owner` too.
 *
 *   So the lead's point 5 (400 for > 100 ids / non-uuid ids) has no operation
 *   to apply to. In its place this suite asserts the contract publishes NO
 *   operation that takes user ids and returns names, and that no such route
 *   answers with a name on the live API.
 *
 *   The "same response for any id we may not name" requirement is pinned
 *   where a caller CAN still supply a user id: listContacts' `owner` filter.
 *   A sibling-programme user, a no-programme user, a tenant-B user and a
 *   random uuid must all give byte-identical bodies.
 *
 * ------------------------------------------------------------------------
 * READINGS THIS SUITE PINS, where the brief left a choice:
 *
 *   - `/me/programmes` items are CLOSED `{ id, name }`. No `clientName`,
 *     `status`, `isDefault` or member count. `clientName` is the BPO's
 *     customer, a separate fact from the programme's display name.
 *   - Order of `/me/programmes` is not asserted (compared sorted).
 *   - `/me/programmes` responses carry `Cache-Control` with `no-store` or
 *     `private`. The URL is IDENTICAL for every user of every tenant, so a
 *     shared cache keyed on URL would serve one tenant's programme names to
 *     the next caller. The auth `/me` routes already send `no-store`.
 *   - The tenant-admin flag does NOT widen `/me/programmes` (D-L53: tenant
 *     admin decides admin writes, not what a person can see).
 *   - Scope headers are `400 validation_failed` in the shared Error envelope
 *     (D-L63).
 *   - A planted owner from ANOTHER tenant either is refused by the database
 *     (FK, 23503) or never has their name rendered. Both pass.
 *   - Display names (people's names, PII under CLAUDE.md 6.1) and programme
 *     names never reach a log line, a span attribute or a span event on these
 *     routes. Programme names are not PII, but they are a BPO client's
 *     confidential fact and no read path has a reason to log them.
 *
 *   NOT asserted, deliberately (open decisions, not oversights):
 *   - Whether an archived programme appears in `/me/programmes`.
 *   - Whether an owner must belong to the contact's programme (D-L61). Owners
 *     are planted only inside the contact's own programme here, so this suite
 *     takes no side.
 *   - updateContact / createContact responses (they are `Contact`, so the
 *     schema obliges `owner`; T-0041 owns those operations).
 *
 * ------------------------------------------------------------------------
 * SEAMS. Owner planting needs T-0040's `contact.owner_user_id`; those tests
 * fail with "T-0040 has not landed" rather than a SQL error when it is absent.
 * Field-security planting uses the T-0026 matrix exactly as the T-0041 suite
 * does (field_def api_name = snake_case of the wire property).
 *
 * D-L23: on main neither operation exists. Contract tests fail naming the
 * missing path or property; wire tests fail with the status they got.
 *
 * Fixtures are packages/db/src/fixtures.ts only. Every test that plants
 * reseeds afterwards.
 */

// ---------------------------------------------------------------------------
// Fixtures (never a second set).
// ---------------------------------------------------------------------------

const ME_PROGRAMMES = '/api/v1/me/programmes';
const CONTACTS = '/api/v1/contacts';

/** Never a real row: same shape as the seed ids, nothing seeds it. */
const NOWHERE_USER = '11111111-0000-4000-8000-0000004300ff';
/** A programme this suite plants in tenant A with NO members. */
const PROGRAMME_A_HIDDEN = '11111111-0000-4000-8000-00000043c003';
const PROGRAMME_A_HIDDEN_NAME = 'T0043 Hidden Programme Q7';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Headers = Record<string, string>;
type Json = Record<string, unknown>;

const AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);
const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const NO_PROGRAMME = asUser(TENANT_A, USER_A_NO_PROGRAMME);
const TENANT_B_USER = asUser(TENANT_B, USER_B_AGENT_1);

function seedUser(id: string) {
  for (const tenant of SEED_TENANTS) {
    const user = tenant.users.find((candidate) => candidate.id === id);
    if (user !== undefined) return user;
  }
  throw new Error(`Fixture drift: no seeded user ${id}`);
}

function seedProgramme(id: string) {
  for (const tenant of SEED_TENANTS) {
    const programme = tenant.programmes.find((candidate) => candidate.id === id);
    if (programme !== undefined) return programme;
  }
  throw new Error(`Fixture drift: no seeded programme ${id}`);
}

function seededContact(givenNames: string) {
  const contact = SEED_CONTACTS.find((candidate) => candidate.givenNames === givenNames);
  if (contact === undefined) throw new Error(`Fixture drift: no seeded contact '${givenNames}'`);
  return contact;
}

function permissionSet(tenantId: string, key: string): string {
  const set = SEED_PERMISSION_SETS.find(
    (candidate) => candidate.tenantId === tenantId && candidate.key === key,
  );
  if (set === undefined) throw new Error(`Fixture drift: no seeded permission set '${key}'`);
  return set.id;
}

const TUNDE = seedUser(USER_A_AGENT_1); // A1 agent
const NGOZI = seedUser(USER_A_AGENT_2); // A2 agent
const MUSA = seedUser(USER_A_SUPERVISOR); // A1 + A2, tenant admin
const EMEKA = seedUser(USER_A_NO_PROGRAMME); // tenant A, no programme
const WANJIRU = seedUser(USER_B_AGENT_1); // tenant B

const ALL_USERS = SEED_TENANTS.flatMap((tenant) => tenant.users);
const ALL_EMAILS = ALL_USERS.map((user) => user.email);
const ALL_PROGRAMMES = SEED_TENANTS.flatMap((tenant) => tenant.programmes);

/** Tenant A, A1. */
const AMAKA = seededContact('Amaka');
const CHIOMA = seededContact('Chioma');
/** Tenant A, A2. */
const DAMILOLA = seededContact('Damilola');
const EFE = seededContact('Efe');
/** Tenant B, B1. */
const GRACE = seededContact('Grace');

/**
 * The owner plan every owner test plants. Each owner is a member of the
 * contact's programme (D-L61 is open; see the header).
 *
 *   Amaka (A1)    -> Tunde (A1)
 *   Chioma (A1)   -> unassigned
 *   Damilola (A2) -> Ngozi (A2)   <- agent 1 cannot see this contact
 *   Efe (A2)      -> Musa (A1+A2)
 *   Grace (B1)    -> Wanjiru (B1)
 *   Emeka owns nothing anywhere.
 */
const OWNER_PLAN: readonly (readonly [string, string | null])[] = [
  [AMAKA.id, TUNDE.id],
  [CHIOMA.id, null],
  [DAMILOLA.id, NGOZI.id],
  [EFE.id, MUSA.id],
  [GRACE.id, WANJIRU.id],
];

// ---------------------------------------------------------------------------
// The published contract, loaded as data. A small JSON-Schema checker over it
// (the same subset as the T-0041 suite; no new dependency).
// ---------------------------------------------------------------------------

const SPEC_PATH = resolve(__dirname, '../../../docs/api/records.openapi.yaml');
const docCache = new Map<string, unknown>();

function loadDoc(file: string): unknown {
  let doc = docCache.get(file);
  if (doc === undefined) {
    doc = parse(readFileSync(file, 'utf8')) as unknown;
    docCache.set(file, doc);
  }
  return doc;
}

function isMapping(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function atPointer(doc: unknown, fragment: string): unknown {
  let node = doc;
  for (const raw of fragment.replace(/^\//, '').split('/')) {
    if (raw === '') continue;
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = isMapping(node) ? node[key] : undefined;
  }
  if (node === undefined) throw new Error(`schema pointer #${fragment} resolves to nothing`);
  return node;
}

interface Located {
  schema: Json;
  file: string;
}

function deref(schema: Json, file: string): Located {
  const ref = schema.$ref;
  if (typeof ref !== 'string') return { schema, file };
  const [relative, fragment = ''] = ref.split('#');
  const target =
    relative === undefined || relative === '' ? file : resolve(dirname(file), relative);
  return deref(atPointer(loadDoc(target), fragment) as Json, target);
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

const FORMATS: Record<string, RegExp> = {
  uuid: UUID,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
  email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
};

function check(input: Json, file: string, value: unknown, path: string, errors: string[]): void {
  const { schema, file: at } = deref(input, file);

  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as Json[]).filter((branch) => {
      const branchErrors: string[] = [];
      check(branch, at, value, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (passing.length !== 1) {
      errors.push(
        `${path}: matches ${passing.length} oneOf branches (value ${JSON.stringify(value)})`,
      );
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const passing = (schema.anyOf as Json[]).some((branch) => {
      const branchErrors: string[] = [];
      check(branch, at, value, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (!passing) errors.push(`${path}: matches no anyOf branch (value ${JSON.stringify(value)})`);
  }

  const actual = jsonType(value);
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type)
      ? (schema.type as string[])
      : [schema.type as string];
    const ok = allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'));
    if (!ok) {
      errors.push(`${path}: type ${actual}, schema allows ${allowed.join('|')}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) {
      errors.push(`${path}: shorter than ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
      errors.push(`${path}: longer than ${schema.maxLength}`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${path}: does not match ${schema.pattern}`);
    }
    const format = typeof schema.format === 'string' ? FORMATS[schema.format] : undefined;
    if (format !== undefined && !format.test(value)) {
      errors.push(`${path}: not a valid ${String(schema.format)}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path}: more than ${schema.maxItems} items`);
    }
    if (schema.items !== undefined && typeof schema.items === 'object') {
      value.forEach((item, index) =>
        check(schema.items as Json, at, item, `${path}[${index}]`, errors),
      );
    }
  }

  if (actual === 'object') {
    const object = value as Json;
    const properties = (schema.properties ?? {}) as Record<string, Json>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in object)) errors.push(`${path}: required property "${key}" is missing`);
    }
    for (const [key, child] of Object.entries(object)) {
      const childSchema = properties[key];
      if (childSchema !== undefined) {
        check(childSchema, at, child, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: property "${key}" is not allowed`);
      }
    }
  }
}

function errorsAgainst(schema: Json, value: unknown, where: string): string[] {
  const errors: string[] = [];
  check(schema, SPEC_PATH, value, where, errors);
  return errors;
}

interface Spec {
  paths?: Record<string, Json>;
  components?: { schemas?: Record<string, Json> };
}

const spec = (): Spec => loadDoc(SPEC_PATH) as Spec;

/** The operation, or a failure that names exactly what T-0043 has not added. */
function operation(path: string, method: string): Json {
  const item = spec().paths?.[path];
  const op = isMapping(item) ? item[method] : undefined;
  if (!isMapping(op)) {
    throw new Error(
      `docs/api/records.openapi.yaml has no ${method.toUpperCase()} ${path} — T-0043 has not added it to the contract`,
    );
  }
  return op;
}

/** The JSON schema of an operation's response, followed through `$ref`s. */
function responseSchema(op: Json, status: string): Json {
  const responses = op.responses;
  const raw = isMapping(responses) ? responses[status] : undefined;
  if (!isMapping(raw)) throw new Error(`operation documents no ${status} response`);
  const { schema: response, file } = deref(raw, SPEC_PATH);
  const content = isMapping(response.content) ? response.content['application/json'] : undefined;
  const schema = isMapping(content) ? content.schema : undefined;
  if (!isMapping(schema)) throw new Error(`${status} response has no application/json schema`);
  // Re-anchor to the spec file: a schema found in another file is resolved there.
  return file === SPEC_PATH ? schema : (deref(schema, file).schema as Json);
}

/** The schema of `Contact.owner`, or a failure naming its absence. */
function ownerSchema(): Json {
  const contact = spec().components?.schemas?.Contact;
  if (!isMapping(contact)) throw new Error('records.openapi.yaml has no Contact schema');
  const properties = isMapping(contact.properties) ? contact.properties : {};
  const owner = properties.owner;
  if (!isMapping(owner)) {
    throw new Error(
      'records.openapi.yaml: Contact has no `owner` property — T-0043 has not added the embedded owner { id, displayName }',
    );
  }
  return owner;
}

/** The non-null branch of `owner`, followed through `$ref`s. */
function ownerObjectSchema(): Json {
  const owner = deref(ownerSchema(), SPEC_PATH).schema;
  const branches = (Array.isArray(owner.oneOf) ? owner.oneOf : owner.anyOf) as Json[] | undefined;
  if (Array.isArray(branches)) {
    const objects = branches
      .map((branch) => deref(branch, SPEC_PATH).schema)
      .filter((branch) => branch.type === 'object' || isMapping(branch.properties));
    if (objects.length !== 1) {
      throw new Error(`Contact.owner: expected exactly one object branch, found ${objects.length}`);
    }
    return objects[0] as Json;
  }
  return owner;
}

const ERROR_SCHEMA: Json = { $ref: './admin.openapi.yaml#/components/schemas/Error' };

// ---------------------------------------------------------------------------
// Wire assertions.
// ---------------------------------------------------------------------------

function expectError(response: request.Response, status: number, code: string): void {
  expect(
    response.status,
    `expected ${status} ${code}, got ${response.status} ${JSON.stringify(response.body)}`,
  ).toBe(status);
  expect(
    errorsAgainst(ERROR_SCHEMA, response.body, 'Error'),
    'body is not the shared Error envelope',
  ).toEqual([]);
  expect((response.body as Json).code, 'Error.code').toBe(code);
}

/** A 200 from /me/programmes, or a failure that says the route is missing. */
function expectMyProgrammes(
  response: request.Response,
  who: string,
): { id: string; name: string }[] {
  expect(
    response.status,
    `GET ${ME_PROGRAMMES} as ${who} answered ${response.status} ${JSON.stringify(response.body)} — ` +
      'T-0043 has not implemented listMyProgrammes',
  ).toBe(200);
  const schema = responseSchema(operation(ME_PROGRAMMES, 'get'), '200');
  expect(
    errorsAgainst(schema, response.body, 'listMyProgrammes'),
    `${who}: body does not match the published 200 schema`,
  ).toEqual([]);
  const body = response.body as Json;
  expect(Object.keys(body), `${who}: the body carries only data`).toEqual(['data']);
  const rows = body.data as Json[];
  for (const row of rows) {
    expect(Object.keys(row).sort(), `${who}: each programme is exactly { id, name }`).toEqual([
      'id',
      'name',
    ]);
  }
  return rows as { id: string; name: string }[];
}

const pairs = (ids: readonly string[]) =>
  ids
    .map((id) => ({ id, name: seedProgramme(id).name }))
    .sort((left, right) => left.id.localeCompare(right.id));

const sortRows = (rows: { id: string; name: string }[]) =>
  [...rows].sort((left, right) => left.id.localeCompare(right.id));

/** Not one of these strings appears anywhere in the raw body. */
function expectAbsent(text: string, needles: readonly string[], where: string): void {
  for (const needle of needles) {
    expect(text.includes(needle), `${where} contains "${needle}"`).toBe(false);
  }
}

/** Every programme name, id and client name the caller must not see. */
function foreignProgrammeStrings(visible: readonly string[]): string[] {
  return ALL_PROGRAMMES.filter((programme) => !visible.includes(programme.id)).flatMap(
    (programme) => [
      programme.id,
      programme.name,
      ...(programme.clientName ? [programme.clientName] : []),
    ],
  );
}

// ---------------------------------------------------------------------------
// Log capture: every channel (the T-0036 approach, with the shared helper).
// ---------------------------------------------------------------------------

let captureLines: string[] | null = null;

function render(value: unknown): string {
  return typeof value === 'string'
    ? value
    : inspect(value, { depth: 12, breakLength: Number.POSITIVE_INFINITY });
}

class RecordingLogger extends ConsoleLogger {
  private record(args: unknown[]): void {
    captureLines?.push(args.map(render).join(' '));
  }
  override log(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override error(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override warn(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override debug(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override verbose(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override fatal(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
}

async function captureEverything(
  work: () => Promise<void>,
): Promise<{ telemetry: Telemetry; lines: string[] }> {
  const lines: string[] = [];
  captureLines = lines;
  const toLines = (chunk: unknown) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString();
    for (const line of text.split('\n')) if (line !== '') lines.push(line);
  };
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      toLines(chunk);
      return true;
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      toLines(chunk);
      return true;
    }),
    ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(render).join(' '));
      }),
    ),
  ];
  let telemetry: Telemetry;
  try {
    telemetry = await collectTelemetry(work);
  } finally {
    for (const spy of spies) spy.mockRestore();
    captureLines = null;
  }
  return { telemetry, lines: [...lines, ...telemetry.logs.map((record) => render(record))] };
}

const formsOf = (value: string) => [...new Set([value, encodeURIComponent(value)])];

// ---------------------------------------------------------------------------

describe('acceptance: scoped display names (T-0043)', () => {
  let app: INestApplication;
  /** kasuwa_migrator — BYPASSRLS. Plants and observes; never serves. */
  let observer: Pool;
  let hasOwnerColumn = false;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot({ databaseUrl: inject('databaseUrl'), poolMax: 5 })],
    }).compile();
    app = moduleRef.createNestApplication({ logger: new RecordingLogger() });
    await app.init();
    observer = createPool({ connectionString: inject('migrationUrl'), max: 3 });
    const column = await observer.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'contact' AND column_name = 'owner_user_id'`,
    );
    hasOwnerColumn = (column.rowCount ?? 0) > 0;
  });

  afterAll(async () => {
    await app?.close();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();
  const myProgrammes = (headers: Headers, path = ME_PROGRAMMES) =>
    request(server()).get(path).set(headers);
  const listContacts = (headers: Headers, query = '') =>
    request(server())
      .get(query === '' ? CONTACTS : `${CONTACTS}?${query}`)
      .set(headers);
  const getContact = (headers: Headers, id: string) =>
    request(server()).get(`${CONTACTS}/${id}`).set(headers);

  /** Plants OWNER_PLAN. Fails with a clear message when T-0040 is absent. */
  async function plantOwners(): Promise<void> {
    if (!hasOwnerColumn) {
      throw new Error(
        'T-0040 has not landed: contact.owner_user_id does not exist, so no contact has an owner to name.',
      );
    }
    for (const [contactId, ownerId] of OWNER_PLAN) {
      await observer.query('UPDATE contact SET owner_user_id = $2 WHERE id = $1', [
        contactId,
        ownerId,
      ]);
    }
  }

  async function assign(tenantId: string, userId: string, programmeId: string, key: string) {
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id)
       DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, tenantId, permissionSet(tenantId, key)],
    );
  }

  /** The T-0026 matrix, planted exactly as the T-0041 suite does (S3 there). */
  async function lockField(field: string, setKey: string, level: 'none' | 'read' | 'edit') {
    await observer.query(
      `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
       VALUES (gen_random_uuid(), $1, 'contact', 'Contact', false)
       ON CONFLICT (tenant_id, api_name) DO NOTHING`,
      [TENANT_A],
    );
    const object = await observer.query<{ id: string }>(
      `SELECT id FROM object_def WHERE tenant_id = $1 AND api_name = 'contact'`,
      [TENANT_A],
    );
    const objectId = object.rows[0]?.id;
    await observer.query(
      `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, is_custom)
       VALUES (gen_random_uuid(), $1, $2, $3, $3, 'text', false)
       ON CONFLICT (tenant_id, object_id, api_name) DO NOTHING`,
      [TENANT_A, objectId, field],
    );
    const fieldRow = await observer.query<{ id: string }>(
      'SELECT id FROM field_def WHERE tenant_id = $1 AND object_id = $2 AND api_name = $3',
      [TENANT_A, objectId, field],
    );
    await observer.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [TENANT_A, fieldRow.rows[0]?.id, permissionSet(TENANT_A, setKey), level],
    );
  }

  /** Rows of a 200 contact list, or a failure naming the status. */
  async function contactRows(headers: Headers, who: string, query = ''): Promise<Json[]> {
    const response = await listContacts(headers, query);
    expect(response.status, `listContacts as ${who}: ${JSON.stringify(response.body)}`).toBe(200);
    return (response.body as { data: Json[] }).data;
  }

  /** The embedded owner on one row, with the invariants every owner obeys. */
  function ownerOf(row: Json, where: string): Json | null {
    expect('owner' in row, `${where}: Contact has no \`owner\` — T-0043 has not embedded it`).toBe(
      true,
    );
    const owner = row.owner;
    if (owner === null) {
      expect(row.ownerUserId, `${where}: owner is null but ownerUserId is set`).toBeNull();
      return null;
    }
    expect(isMapping(owner), `${where}: owner is neither an object nor null`).toBe(true);
    const object = owner as Json;
    expect(Object.keys(object).sort(), `${where}: owner is exactly { id, displayName }`).toEqual([
      'displayName',
      'id',
    ]);
    expect(object.id, `${where}: owner.id must equal ownerUserId`).toBe(row.ownerUserId);
    expect(
      errorsAgainst(ownerObjectSchema(), object, `${where}.owner`),
      `${where}: owner does not match the published schema`,
    ).toEqual([]);
    return object;
  }

  const byId = (rows: Json[], id: string): Json => {
    const row = rows.find((candidate) => candidate.id === id);
    if (row === undefined) throw new Error(`contact ${id} missing from the list`);
    return row;
  };

  // =========================================================================
  // 1. The contract.
  // =========================================================================

  describe('the contract (records.openapi.yaml)', () => {
    it('declares GET /api/v1/me/programmes as listMyProgrammes, implemented, on a screen, documenting 401', () => {
      const op = operation(ME_PROGRAMMES, 'get');
      expect(op.operationId).toBe('listMyProgrammes');
      expect(op['x-kasuwa-implemented'], 'x-kasuwa-implemented must be true once built').toBe(true);
      expect(Array.isArray(op['x-kasuwa-screens']) && op['x-kasuwa-screens'].length > 0).toBe(true);
      const responses = op.responses as Json;
      expect(Object.keys(responses)).toContain('200');
      expect(Object.keys(responses)).toContain('401');
      // A read never answers 403 (the file's rule 2).
      expect(Object.keys(responses)).not.toContain('403');
    });

    it('listMyProgrammes takes no scope from the caller: no scope-like parameter and no body', () => {
      const op = operation(ME_PROGRAMMES, 'get');
      const item = spec().paths?.[ME_PROGRAMMES] as Json;
      const params = [
        ...(Array.isArray(item.parameters) ? (item.parameters as Json[]) : []),
        ...(Array.isArray(op.parameters) ? (op.parameters as Json[]) : []),
      ].map((param) => deref(param, SPEC_PATH).schema);
      const scopeLike = params
        .map((param) => String(param.name))
        .filter((name) => /programme|tenant|scope|user|member/i.test(name));
      // `user` is in the list: a userId parameter would turn "my programmes"
      // into "anyone's programmes".
      expect(scopeLike, 'a parameter could choose whose programmes are listed').toEqual([]);
      expect(op.requestBody, 'a GET takes no body').toBeUndefined();
    });

    it('the 200 body is { data: [{ id: uuid, name: string }] }, items closed', () => {
      const schema = responseSchema(operation(ME_PROGRAMMES, 'get'), '200');
      const good = { data: [{ id: PROGRAMME_A1, name: 'Bank X Collections' }] };
      expect(errorsAgainst(schema, good, 'example')).toEqual([]);
      expect(errorsAgainst(schema, { data: [] }, 'empty')).toEqual([]);

      // A checker only ever seen passing proves nothing: each single-fault
      // mutant must be rejected by the published schema.
      const mutants: [string, unknown][] = [
        [
          'a clientName leaked onto an item',
          { data: [{ id: PROGRAMME_A1, name: 'x', clientName: 'Bank X' }] },
        ],
        ['no name', { data: [{ id: PROGRAMME_A1 }] }],
        ['no id', { data: [{ name: 'x' }] }],
        ['a non-uuid id', { data: [{ id: 'A1', name: 'x' }] }],
        ['no data', {}],
        ['items under `items`', { items: [] }],
      ];
      for (const [label, mutant] of mutants) {
        expect(
          errorsAgainst(schema, mutant, label).length,
          `the published schema accepts a body with ${label}`,
        ).toBeGreaterThan(0);
      }
    });

    it('Contact gains owner: { id: uuid, displayName: string } | null, closed', () => {
      const object = ownerObjectSchema();
      const owner = ownerSchema();
      const good = { id: USER_A_AGENT_1, displayName: 'Tunde Adeyemi' };
      expect(errorsAgainst(owner, good, 'owner')).toEqual([]);
      expect(errorsAgainst(owner, null, 'owner'), 'owner must allow null (unassigned)').toEqual([]);
      expect(Object.keys((object.properties ?? {}) as Json).sort()).toEqual(['displayName', 'id']);

      const mutants: [string, unknown][] = [
        ['an email', { ...good, email: 'tunde.agent@tenant-a.test' }],
        ['a phone', { ...good, phone: '+2348000000000' }],
        ['no displayName', { id: USER_A_AGENT_1 }],
        ['no id', { displayName: 'Tunde Adeyemi' }],
        ['a non-uuid id', { id: 'tunde', displayName: 'Tunde Adeyemi' }],
        ['a bare string', 'Tunde Adeyemi'],
      ];
      for (const [label, mutant] of mutants) {
        expect(
          errorsAgainst(owner, mutant, label).length,
          `Contact.owner accepts ${label}`,
        ).toBeGreaterThan(0);
      }
    });

    it('publishes NO operation that turns caller-supplied user ids into names (embedded owner, not a directory)', () => {
      // Vacuity guard: the file has operations to scan.
      const paths = spec().paths ?? {};
      expect(Object.keys(paths).length).toBeGreaterThan(0);
      ownerSchema(); // and the embedded shape exists, so this is a choice, not an absence

      const offenders: string[] = [];
      for (const [path, item] of Object.entries(paths)) {
        if (/\/users?\b|display-?names?/i.test(path)) offenders.push(`path ${path}`);
        for (const [method, op] of Object.entries(item)) {
          if (!isMapping(op) || !Array.isArray(op.parameters)) continue;
          for (const raw of op.parameters as Json[]) {
            const param = deref(raw, SPEC_PATH).schema;
            if (/^(ids|userIds?|user_ids?)$/i.test(String(param.name))) {
              offenders.push(`${method.toUpperCase()} ${path} ?${String(param.name)}`);
            }
          }
        }
      }
      expect(offenders, 'a user-lookup operation is a user directory (see the header)').toEqual([]);
    });
  });

  // =========================================================================
  // 2. /me/programmes on the wire.
  // =========================================================================

  describe('GET /api/v1/me/programmes', () => {
    it('agent 1 sees exactly A1, by name', async () => {
      const response = await myProgrammes(AGENT_1);
      const rows = expectMyProgrammes(response, 'agent 1');
      expect(sortRows(rows)).toEqual(pairs([PROGRAMME_A1]));
      expectAbsent(response.text, foreignProgrammeStrings([PROGRAMME_A1]), 'agent 1 body');
      // Its own clientName is not part of the shape either.
      expectAbsent(response.text, ['"Bank X"', 'clientName'], 'agent 1 body');
    });

    it('the supervisor sees exactly A1 and A2', async () => {
      const response = await myProgrammes(SUPERVISOR);
      const rows = expectMyProgrammes(response, 'supervisor');
      expect(sortRows(rows)).toEqual(pairs([PROGRAMME_A1, PROGRAMME_A2]));
      expectAbsent(
        response.text,
        foreignProgrammeStrings([PROGRAMME_A1, PROGRAMME_A2]),
        'supervisor body',
      );
    });

    it('a user with no membership gets 200 { data: [] }', async () => {
      const response = await myProgrammes(NO_PROGRAMME);
      const rows = expectMyProgrammes(response, 'no-programme user');
      // Legitimately empty: this is the user with no user_programme row. The
      // non-empty cases above are what make this assertion meaningful.
      expect(rows).toEqual([]);
      expectAbsent(response.text, foreignProgrammeStrings([]), 'no-programme body');
    });

    it('tenant B sees its own programme and nothing of tenant A', async () => {
      const response = await myProgrammes(TENANT_B_USER);
      const rows = expectMyProgrammes(response, 'tenant B');
      expect(sortRows(rows)).toEqual(pairs([PROGRAMME_B1]));
      expectAbsent(response.text, foreignProgrammeStrings([PROGRAMME_B1]), 'tenant B body');
      expect(rows.map((row) => row.id)).not.toContain(PROGRAMME_B2);
    });

    it('reads user_programme live: a membership added in the database appears on the next request', async () => {
      // Positive control. Without it, a hard-coded or cached answer that
      // happened to match the seed would pass every test above.
      await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A2, 'agent');
      const rows = expectMyProgrammes(await myProgrammes(AGENT_1), 'agent 1 (+A2)');
      expect(sortRows(rows)).toEqual(pairs([PROGRAMME_A1, PROGRAMME_A2]));

      await observer.query('DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2', [
        USER_A_AGENT_1,
        PROGRAMME_A1,
      ]);
      const after = expectMyProgrammes(await myProgrammes(AGENT_1), 'agent 1 (-A1)');
      expect(sortRows(after)).toEqual(pairs([PROGRAMME_A2]));
    });

    it('the tenant-admin flag does not widen it: an unjoined programme and a dropped membership stay invisible', async () => {
      await observer.query(
        `INSERT INTO programme (id, tenant_id, business_unit_id, name, client_name, is_default)
         VALUES ($1, $2, $3, $4, 'Hidden Client Q7', false)`,
        [PROGRAMME_A_HIDDEN, TENANT_A, BU_A, PROGRAMME_A_HIDDEN_NAME],
      );
      await observer.query('DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2', [
        USER_A_SUPERVISOR,
        PROGRAMME_A2,
      ]);
      // The supervisor is a tenant admin in the seed (D-L53).
      expect(MUSA.isTenantAdmin).toBe(true);

      const response = await myProgrammes(SUPERVISOR);
      const rows = expectMyProgrammes(response, 'tenant admin');
      expect(sortRows(rows)).toEqual(pairs([PROGRAMME_A1]));
      expectAbsent(
        response.text,
        [
          PROGRAMME_A_HIDDEN,
          PROGRAMME_A_HIDDEN_NAME,
          'Hidden Client Q7',
          PROGRAMME_A2,
          'Telco Y Care',
        ],
        'tenant admin body',
      );
    });

    it('forged scope headers are rejected with 400 validation_failed and leak no name', async () => {
      for (const [header, value] of [
        ['x-kasuwa-programme-ids', `{${PROGRAMME_A2}}`],
        ['x-kasuwa-programme-id', PROGRAMME_A2],
        ['x-kasuwa-scope', 'all'],
      ] as const) {
        const response = await myProgrammes(AGENT_1).set(header, value);
        expectError(response, 400, 'validation_failed');
        expectAbsent(response.text, foreignProgrammeStrings([]), `${header} body`);
      }
    });

    it('query parameters cannot choose whose programmes are listed', async () => {
      const response = await myProgrammes(
        AGENT_1,
        `${ME_PROGRAMMES}?programmeIds=${PROGRAMME_A2}&programmeId=${PROGRAMME_A2}` +
          `&tenantId=${TENANT_B}&userId=${USER_A_SUPERVISOR}&scope=all`,
      );
      // 400 (strict) or 200 (ignored) are both safe. What is not: anything else.
      if (response.status === 400) {
        expectError(response, 400, 'validation_failed');
      } else {
        const rows = expectMyProgrammes(response, 'agent 1 with smuggled params');
        expect(sortRows(rows)).toEqual(pairs([PROGRAMME_A1]));
      }
      expectAbsent(response.text, foreignProgrammeStrings([PROGRAMME_A1]), 'smuggled-params body');
    });

    it('unauthenticated, wrong-tenant and unknown callers get 401 and no names', async () => {
      // Positive control first: the route exists, so a 401 below is the guard
      // speaking, not a missing route.
      expectMyProgrammes(await myProgrammes(AGENT_1), 'agent 1 (control)');

      const cases: [string, request.Test][] = [
        ['no credentials', request(server()).get(ME_PROGRAMMES)],
        ['a real user under the wrong tenant', myProgrammes(asUser(TENANT_B, USER_A_AGENT_2))],
        ['an unknown user', myProgrammes(asUser(TENANT_A, NOWHERE_USER))],
      ];
      for (const [label, pending] of cases) {
        const response = await pending;
        expect(response.status, `${label}: ${response.status} ${response.text}`).toBe(401);
        expectAbsent(response.text, foreignProgrammeStrings([]), `${label} body`);
      }
    });

    it('is never cacheable by a shared cache: the URL is the same for every user', async () => {
      for (const [who, headers] of [
        ['agent 1', AGENT_1],
        ['tenant B', TENANT_B_USER],
      ] as const) {
        const response = await myProgrammes(headers);
        expectMyProgrammes(response, who);
        const cacheControl = String(response.headers['cache-control'] ?? '');
        expect(
          /\b(no-store|private)\b/i.test(cacheControl),
          `${who}: Cache-Control is "${cacheControl}"; a shared cache would serve this body to the next tenant`,
        ).toBe(true);
      }
    });
  });

  // =========================================================================
  // 3. Owner names: not a user directory.
  // =========================================================================

  describe('owner display names (embedded on Contact)', () => {
    it('agent 1 sees the names of owners of its own contacts, null for unassigned', async () => {
      await plantOwners();
      const rows = await contactRows(AGENT_1, 'agent 1');
      expect(rows.length).toBe(3);
      const amaka = ownerOf(byId(rows, AMAKA.id), 'Amaka');
      expect(amaka).toEqual({ id: TUNDE.id, displayName: TUNDE.displayName });
      expect(ownerOf(byId(rows, CHIOMA.id), 'Chioma')).toBeNull();
      for (const row of rows) ownerOf(row, `agent 1 row ${String(row.id)}`);
    });

    it('agent 1 never receives the name of a user who owns nothing it can see', async () => {
      await plantOwners();
      const response = await listContacts(AGENT_1);
      expect(response.status).toBe(200);
      // Ngozi owns Damilola (A2, invisible to agent 1); Musa owns Efe (A2);
      // Emeka owns nothing; Wanjiru is tenant B. Every row must still carry
      // `owner` (vacuity guard: an implementation that dropped owner entirely
      // would otherwise pass this test).
      for (const row of (response.body as { data: Json[] }).data) ownerOf(row, 'agent 1 row');
      expectAbsent(
        response.text,
        [NGOZI.displayName, MUSA.displayName, EMEKA.displayName, WANJIRU.displayName],
        'agent 1 contact list',
      );
      expectAbsent(response.text, ALL_EMAILS, 'agent 1 contact list');
    });

    it('the supervisor sees owners across both of its programmes', async () => {
      await plantOwners();
      const rows = await contactRows(SUPERVISOR, 'supervisor');
      expect(ownerOf(byId(rows, AMAKA.id), 'Amaka')).toEqual({
        id: TUNDE.id,
        displayName: TUNDE.displayName,
      });
      expect(ownerOf(byId(rows, DAMILOLA.id), 'Damilola')).toEqual({
        id: NGOZI.id,
        displayName: NGOZI.displayName,
      });
      expect(ownerOf(byId(rows, EFE.id), 'Efe')).toEqual({
        id: MUSA.id,
        displayName: MUSA.displayName,
      });
      const text = JSON.stringify(rows);
      expectAbsent(text, [EMEKA.displayName, WANJIRU.displayName], 'supervisor list');
      expectAbsent(text, ALL_EMAILS, 'supervisor list');
    });

    it('getContact embeds the owner; an out-of-scope contact is 404 and names nobody', async () => {
      await plantOwners();
      const own = await getContact(AGENT_1, AMAKA.id);
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      expect(ownerOf(own.body as Json, 'getContact Amaka')).toEqual({
        id: TUNDE.id,
        displayName: TUNDE.displayName,
      });

      const sibling = await getContact(AGENT_1, DAMILOLA.id);
      expectError(sibling, 404, 'not_found');
      expectAbsent(sibling.text, [NGOZI.displayName, NGOZI.id, NGOZI.email], 'sibling 404');
    });

    it('tenant B sees its own owner and no tenant-A person', async () => {
      await plantOwners();
      const response = await listContacts(TENANT_B_USER);
      expect(response.status).toBe(200);
      const rows = (response.body as { data: Json[] }).data;
      expect(ownerOf(byId(rows, GRACE.id), 'Grace')).toEqual({
        id: WANJIRU.id,
        displayName: WANJIRU.displayName,
      });
      expectAbsent(
        response.text,
        [TUNDE.displayName, NGOZI.displayName, MUSA.displayName, EMEKA.displayName],
        'tenant B list',
      );
      expectAbsent(response.text, ALL_EMAILS, 'tenant B list');
    });

    it('the owner filter is no oracle: sibling, unassigned-user, other-tenant and random ids answer identically', async () => {
      await plantOwners();
      // Ngozi is real and owns a contact, just not one agent 1 can see.
      const probes = [NGOZI.id, EMEKA.id, WANJIRU.id, NOWHERE_USER];
      const bodies: string[] = [];
      for (const id of probes) {
        const response = await listContacts(AGENT_1, `owner=${id}`);
        expect(response.status, `owner=${id}: ${response.text}`).toBe(200);
        bodies.push(response.text);
      }
      expect(new Set(bodies).size, `distinguishable bodies: ${bodies.join(' | ')}`).toBe(1);
      expect(JSON.parse(bodies[0] ?? '{}')).toEqual({ data: [], nextCursor: null });

      // Control: the filter does work for an owner agent 1 can see, so the
      // identical empties above are the scope speaking, not a dead filter.
      const own = await contactRows(AGENT_1, 'agent 1 owner=Tunde', `owner=${TUNDE.id}`);
      expect(own.map((row) => row.id)).toEqual([AMAKA.id]);
    });

    it('no user-lookup route hands out a name for a caller-supplied id', async () => {
      await plantOwners();
      // Control: the name is real and retrievable where it is allowed.
      const allowed = await listContacts(SUPERVISOR);
      expect(allowed.text).toContain(NGOZI.displayName);

      for (const path of [
        `/api/v1/users/display-names?ids=${NGOZI.id}`,
        `/api/v1/users?ids=${NGOZI.id}`,
        `/api/v1/users/${NGOZI.id}`,
        `/api/v1/me/users?ids=${NGOZI.id}`,
      ]) {
        const response = await request(server()).get(path).set(AGENT_1);
        expectAbsent(
          response.text,
          [NGOZI.displayName, NGOZI.email],
          `GET ${path} (${response.status})`,
        );
      }
    });

    it('a withheld ownerUserId withholds owner too: the name does not survive the id', async () => {
      await plantOwners();
      await lockField('owner_user_id', 'agent', 'none');
      const response = await listContacts(AGENT_1);
      expect(response.status, response.text).toBe(200);
      const rows = (response.body as { data: Json[] }).data;
      expect(rows.length).toBe(3);
      for (const row of rows) {
        const withheld = (row.withheldFields ?? []) as string[];
        expect(withheld, `row ${String(row.id)}: ownerUserId is withheld`).toContain('ownerUserId');
        expect('ownerUserId' in row, 'withheld means omitted').toBe(false);
        expect(withheld, `row ${String(row.id)}: owner must be withheld with it`).toContain(
          'owner',
        );
        expect('owner' in row, 'owner is omitted, never nulled').toBe(false);
      }
      expectAbsent(response.text, [TUNDE.displayName, TUNDE.id], 'withheld-owner list');

      // Control: the supervisor (admin set) is not withheld and still sees it.
      const control = await contactRows(SUPERVISOR, 'supervisor (control)');
      expect(ownerOf(byId(control, AMAKA.id), 'Amaka (control)')).toEqual({
        id: TUNDE.id,
        displayName: TUNDE.displayName,
      });
    });

    it('an owner planted from another tenant is refused by the database or never named', async () => {
      if (!hasOwnerColumn) {
        throw new Error('T-0040 has not landed: contact.owner_user_id does not exist.');
      }
      let refused = false;
      try {
        await observer.query('UPDATE contact SET owner_user_id = $2 WHERE id = $1', [
          AMAKA.id,
          WANJIRU.id,
        ]);
      } catch (error) {
        // A composite tenant FK is the right answer; anything else is a bug.
        expect((error as { code?: string }).code, String(error)).toBe('23503');
        refused = true;
      }
      if (refused) return;
      const response = await listContacts(AGENT_1);
      expect(response.status, response.text).toBe(200);
      expectAbsent(response.text, [WANJIRU.displayName, WANJIRU.email], 'cross-tenant owner');
    });
  });

  // =========================================================================
  // 4. Field security / PII: names never reach logs or spans.
  // =========================================================================

  describe('names stay out of logs and spans', () => {
    it('the capture sees what it should (self-check), then finds no name in any log line, span attribute or span event', async () => {
      await plantOwners();
      const canary = `t0043-canary-${Date.now().toString(36)}`;
      const bodies: string[] = [];

      const { telemetry, lines } = await captureEverything(async () => {
        process.stdout.write(`${canary}\n`);
        for (const [headers, path] of [
          [AGENT_1, ME_PROGRAMMES],
          [SUPERVISOR, ME_PROGRAMMES],
          [SUPERVISOR, CONTACTS],
          [AGENT_1, `${CONTACTS}/${AMAKA.id}`],
          [AGENT_1, `${CONTACTS}/${DAMILOLA.id}`],
          [TENANT_B_USER, CONTACTS],
        ] as const) {
          const response = await request(server()).get(path).set(headers);
          bodies.push(response.text);
        }
      });

      // Self-checks: the capture is live, and the names really were in play.
      expect(
        lines.some((line) => line.includes(canary)),
        'stdout capture saw nothing',
      ).toBe(true);
      const inbound = telemetry.spans.filter(isInboundApiSpan);
      expect(
        inbound.some((span) => String(span.attributes['http.route']).includes('me/programmes')),
        'no inbound span for /me/programmes was recorded, so the span check below would be vacuous',
      ).toBe(true);
      const served = bodies.join('\n');
      for (const name of [TUNDE.displayName, NGOZI.displayName, MUSA.displayName, 'Telco Y Care']) {
        expect(
          served,
          `"${name}" never reached a body, so its absence from logs proves nothing`,
        ).toContain(name);
      }

      const names = [
        ...ALL_USERS.map((user) => user.displayName),
        ...ALL_PROGRAMMES.map((programme) => programme.name),
      ];
      const channels: Record<string, string> = {
        'a log line': lines.join('\n'),
        'a span attribute': JSON.stringify(telemetry.spans.map((span) => span.attributes)),
        'a span event': JSON.stringify(telemetry.spans.map((span) => span.events)),
      };
      for (const span of telemetry.spans) {
        expect(Array.isArray(span.events), `${span.name}: no events array`).toBe(true);
      }
      for (const [channel, haystack] of Object.entries(channels)) {
        for (const name of names) {
          for (const form of formsOf(name)) {
            expect(haystack.includes(form), `${channel} carries "${form}"`).toBe(false);
          }
        }
      }
    });
  });
});
