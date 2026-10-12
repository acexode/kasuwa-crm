import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { inspect } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import {
  BU_A,
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  SEED_ACCOUNTS,
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
  withTenantTransaction,
  type TenantTx,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { parse } from 'yaml';
import { asUser, withAuthDatabase } from '../support/api';
import { collectTelemetry, isInboundApiSpan, type Telemetry } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0103, a contact's owner who has left its programme (D-P23).
 * Owner: Agent 3. Suite: Agent 12 (QA), on the lead's branch.
 *
 * D-P23 (answered 2026-10-07): nobody sees the name of a person who no longer
 * shares the contact's programme. Two halves, pinned here against the real API
 * and the real database:
 *
 *   R. READS. An owner who is not a member of the CONTACT'S programme reads as
 *      `owner: { id, displayName: null }` ("former owner"), on every
 *      Contact-shaped answer: getContact, listContacts, listLeads,
 *      listAccountContacts, and (beyond the brief) the contact inside an
 *      updateContact and a convertContact answer. Never a 500, never the name.
 *      `ContactOwnerUnresolvedError` is no longer thrown for that case.
 *
 *   U. REMOVAL UNASSIGNS. Removing a user from a programme sets
 *      `owner_user_id = NULL` on their contacts IN THAT PROGRAMME ONLY, in the
 *      same transaction as the removal, `version` + 1 on each, with ONE audit
 *      event carrying the count and no names, AND (T-0104, D-L101 amended)
 *      one contact `updated` event per contact unassigned.
 *
 * ------------------------------------------------------------------------
 * THE WRITE PATHS THAT REMOVE A MEMBERSHIP (the lead asked QA to find them all)
 *
 *   There is NO application write path. Nothing in apps/ or packages/ deletes
 *   or rewrites a `user_programme` row (grep of DELETE / UPDATE on
 *   user_programme, raw SQL and Drizzle, 2026-10-08; 0021's header says the
 *   same). admin.openapi.yaml has no membership-removal operation: no DELETE
 *   or PATCH under /programmes/{id}/agents or anywhere else. archiveProgramme
 *   deletes nothing (D-L46). So the paths that exist are the database's own:
 *
 *     P1. `DELETE FROM user_programme` by `kasuwa_app` inside a tenant-admin
 *         session that reaches the programme (0021 policy 3). THE path a
 *         serving process can take. Exercised here inside a real
 *         `withTenantTransaction`, as the T-0046 suite does.
 *     P2. `UPDATE user_programme SET user_id | programme_id` by the same
 *         session (0021 policy 1 + 0015): a rewrite removes the old member
 *         from the old programme. Either it is refused (any error, nothing
 *         changed) or it unassigns. Both pass; leaving the owner does not.
 *     P3. `kasuwa_migrator` (operator jobs; the other suites' observers):
 *         a plain DELETE unassigns too. Its audit is NOT asserted (there is no
 *         session user, and 0008 admits no `system` writer for kasuwa_app).
 *
 *   The cascades from "user", programme and tenant are migrator-only (0022)
 *   and take the contacts with them (programme, tenant) or are refused by the
 *   owner FK ("user"); they are pinned only as "offboarding still works".
 *
 *   Consequence, for the lead: with no application path, the only place the
 *   unassignment can live is the database (a trigger on user_programme, or an
 *   equivalent). If the lead would rather add a membership-removal API, that
 *   is a new admin operation, a contract decision, and P1-P3 still hold as
 *   the backstop.
 *
 * ------------------------------------------------------------------------
 * READINGS THIS SUITE PINS, where the brief left a choice:
 *
 *   - "Member" means a `user_programme` row in the CONTACT's programme.
 *     Sharing another programme with the owner, the reader's included, does
 *     not restore the name (the supervisor shares A2 with Ngozi and still
 *     sees an A1 contact's owner Ngozi as former). A disabled user is still a
 *     member and keeps the name, as D-L81 rules for actors.
 *   - The rule is read at request time: a former owner who rejoins is named
 *     again; a rename of a former owner never shows.
 *   - Read-path tests PLANT a non-member owner as kasuwa_migrator. That row
 *     stands for data written before T-0103 (D-P23: "until that ships") and
 *     for anything removal does not reach. A guard that refuses the
 *     migrator's plant would also break contacts-api (DAMILOLA -> agent 1)
 *     and leads-api (DAMILOLA -> agent 1), which plant the same shape.
 *   - The audit event (U): exactly one new row per removed membership that
 *     unassigned at least one contact; `programme_id` = that programme (an
 *     event with no programme is visible tenant-wide, D-L48); for P1 the
 *     actor is the session user; one `changes[]` entry carries the count as
 *     its `after`, a decimal string (AuditChange values are strings); the
 *     field name is the builder's (suggested: `unassignedContacts`). No
 *     contact id, contact name, phone, user display name or email anywhere
 *     in the row; `object_id` is never a contact. The removed user's id is
 *     allowed (a staff id, D-L71). A removal that unassigned nothing: not
 *     asserted either way.
 *   - T-0104 (D-L101, amended 2026-10-08: the per-contact events moved to
 *     T-0104): "besides the programme event, each unassigned contact gets its
 *     own audit event, `updated`, change `ownerUserId` with before = the
 *     removed user's id and after = null. Staff ids are not customer PII
 *     (D-L71)." Pinned as: the programme event above is UNCHANGED (everything
 *     the bullet above says still holds of it; it is told apart as the one
 *     new row whose object_type is not 'contact'), and in addition, for each
 *     contact the removal unassigned and for no other, exactly one row with
 *     object_type 'contact', object_id and object_label the contact's id
 *     (the contact writer's label, never a name), action 'updated',
 *     programme_id the contact's programme, the remover as actor (as on the
 *     programme event), and changes EXACTLY
 *     [{ field: 'ownerUserId', before: <removed user id>, after: null,
 *        redacted: false }]. It carries no other contact's id, and no name,
 *     phone or email. A rollback or a refusal writes neither kind. The
 *     contact's timeline then shows that owner change, redacted, naming
 *     neither the removed owner nor their id (D-L72, D-L85, unchanged).
 *     The migrator path (P3) stays unasserted, as before.
 *   - "Same transaction" is pinned as: committed with the removal, invisible
 *     to every other connection before that COMMIT, gone with a ROLLBACK.
 *     Whether the removing transaction sees it before COMMIT (a row trigger)
 *     or only at COMMIT (a deferred one) is the builder's.
 *   - The removal's own audit event is not a contact event, so the contact
 *     timeline gains no item for it (not asserted: the builder may choose).
 *   - Concurrency: the end state is judged, not the mechanism. After a removal
 *     races an owner assignment, no contact in the programme is owned by a
 *     non-member, AND the removal committed (an admin's removal must not be
 *     lost to a concurrent assignment). The assignment may win (200, then
 *     unassigned) or lose (400 unknown_reference, no name in the body).
 *
 *   NOT asserted (other decisions): accounts. `Account.owner` embeds a name
 *   with the same subquery and has the same former-owner leak; D-P23 names
 *   contacts only. Activities keep a removed owner too. Both are in the report.
 *
 * ------------------------------------------------------------------------
 * EXISTING SUITES. Nothing here contradicts contacts-api, display-names or
 * contact-timeline. display-names (`reads user_programme live`, `the
 * tenant-admin flag does not widen it`) and contact-timeline (`a former
 * member of the programme is still shown, by name`) delete memberships as the
 * migrator with no contact owners planted, so an unassigning trigger changes
 * nothing they read.
 *
 * Fixtures are packages/db/src/fixtures.ts only. Every test reseeds afterwards.
 * Nothing sleeps: the races wait on lock state (pg_blocking_pids), as the
 * T-0054 hierarchy suite does.
 *
 * NOT VACUOUS. On main 18 tests fail: the reads show the former owner's name,
 * and no removal unassigns anything. QA also ran the suite against a local,
 * uncommitted prototype (a row trigger on user_programme, a membership
 * predicate in the owner subquery, a locking member check): 30/30 pass.
 * Without the lock all three races fail; an audit insert made even when
 * nothing was unassigned fails the offboarding guard (audit_event's programme
 * FK). For the builder: that prototype locked with `FOR KEY SHARE` on
 * user_programme, which 0021's restrictive UPDATE policy filters for every
 * non-admin session, so contacts-api's D-P14 self-assign tests went red. The
 * lock has to work for an agent too (the second race here).
 */

// ---------------------------------------------------------------------------
// Fixtures (never a second set).
// ---------------------------------------------------------------------------

const CONTACTS = '/api/v1/contacts';
const LEADS = '/api/v1/leads';
const ACCOUNTS = '/api/v1/accounts';
const contactPath = (id: string) => `${CONTACTS}/${id}`;
const timelinePath = (id: string) => `${CONTACTS}/${id}/timeline`;
const convertPath = (id: string) => `${CONTACTS}/${id}/convert`;
const accountContactsPath = (id: string) => `${ACCOUNTS}/${id}/contacts`;

/** Never a real row: this suite's id range (`0103`), nothing seeds it. */
const NOWHERE = '11111111-0000-4000-8000-0103000000ff';

const RUN = Date.now().toString(36);

type Headers = Record<string, string>;
type Json = Record<string, unknown>;

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);

function seedUser(id: string) {
  for (const tenant of SEED_TENANTS) {
    const user = tenant.users.find((candidate) => candidate.id === id);
    if (user !== undefined) return user;
  }
  throw new Error(`Fixture drift: no seeded user ${id}`);
}

function seeded(givenNames: string) {
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
const MUSA = seedUser(USER_A_SUPERVISOR); // A1 + A2 admin, tenant admin
const EMEKA = seedUser(USER_A_NO_PROGRAMME); // tenant A, no programme
const WANJIRU = seedUser(USER_B_AGENT_1); // tenant B

const ALL_USERS = SEED_TENANTS.flatMap((tenant) => tenant.users);

/** Tenant A, A1. */
const AMAKA = seeded('Amaka');
const BASHIR = seeded('Bashir');
const CHIOMA = seeded('Chioma');
/** Tenant A, A2. */
const DAMILOLA = seeded('Damilola');
const EFE = seeded('Efe');
/** Tenant B, B1. */
const GRACE = seeded('Grace');

const A1_CONTACTS = SEED_CONTACTS.filter((contact) => contact.programmeId === PROGRAMME_A1);
const A2_CONTACTS = SEED_CONTACTS.filter((contact) => contact.programmeId === PROGRAMME_A2);

/** A1's seeded account (Ikoyi Traders). */
const IKOYI = (() => {
  const account = SEED_ACCOUNTS.find(
    (candidate) => candidate.tenantId === TENANT_A && candidate.programmeId === PROGRAMME_A1,
  );
  if (account === undefined) throw new Error('Fixture drift: tenant A has no A1 account');
  return account;
})();

// ---------------------------------------------------------------------------
// The published contract, loaded as data (the checker the T-0041 and T-0043
// suites use; no new dependency).
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS: Record<string, RegExp> = {
  uuid: UUID,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
};

function check(input: Json, file: string, value: unknown, path: string, errors: string[]): void {
  const { schema, file: at } = deref(input, file);

  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf as Json[]) check(part, at, value, path, errors);
  }
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
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: ${JSON.stringify(value)} is not ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'string') {
    const format = typeof schema.format === 'string' ? FORMATS[schema.format] : undefined;
    if (format !== undefined && !format.test(value)) {
      errors.push(`${path}: not a valid ${String(schema.format)}`);
    }
  }
  if (Array.isArray(value) && schema.items !== undefined && typeof schema.items === 'object') {
    value.forEach((item, index) =>
      check(schema.items as Json, at, item, `${path}[${index}]`, errors),
    );
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

const schemaRef = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });

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

function contactSchema(): Json {
  const contact = spec().components?.schemas?.Contact;
  if (!isMapping(contact)) throw new Error('records.openapi.yaml has no Contact schema');
  return contact;
}

/** `Contact.owner`, as published. */
function ownerSchema(): Json {
  const properties = contactSchema().properties;
  const owner = isMapping(properties) ? properties.owner : undefined;
  if (!isMapping(owner)) throw new Error('records.openapi.yaml: Contact has no `owner` property');
  return owner;
}

function operationDescription(path: string, method: string): string {
  const item = spec().paths?.[path];
  const op = isMapping(item) ? item[method] : undefined;
  if (!isMapping(op)) throw new Error(`records.openapi.yaml has no ${method} ${path}`);
  return String(op.description ?? '');
}

const ERROR_SCHEMA: Json = { $ref: './admin.openapi.yaml#/components/schemas/Error' };

// ---------------------------------------------------------------------------
// Wire assertions.
// ---------------------------------------------------------------------------

function expectStatus(response: request.Response, status: number, where: string): void {
  expect(
    response.status,
    `${where}: expected ${status}, got ${response.status} ${JSON.stringify(response.body)}`,
  ).toBe(status);
}

function expectError(response: request.Response, status: number, code: string): Json {
  expectStatus(response, status, code);
  expect(errorsAgainst(ERROR_SCHEMA, response.body, 'Error'), 'not the shared Error').toEqual([]);
  const body = response.body as Json;
  expect(body.code, 'Error.code').toBe(code);
  return body;
}

/** A Contact as published, or a failure naming every schema error. */
function expectContact(value: unknown, where: string): Json {
  expect(
    errorsAgainst(schemaRef('Contact'), value, where),
    `${where} does not match Contact`,
  ).toEqual([]);
  return value as Json;
}

function expectPage(response: request.Response, where: string): Json[] {
  expectStatus(response, 200, where);
  expect(
    errorsAgainst(schemaRef('ContactPage'), response.body, where),
    `${where} does not match ContactPage`,
  ).toEqual([]);
  const page = response.body as { data: Json[]; nextCursor: string | null };
  expect(page.nextCursor, `${where}: this suite never plants more than one page`).toBeNull();
  return page.data;
}

const byId = (rows: Json[], id: string, where: string): Json => {
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) {
    throw new Error(
      `${where}: contact ${id} is missing from the page. A former owner must never drop the row ` +
        '(an inner join on membership would).',
    );
  }
  return row;
};

/**
 * The `owner` on one row, with the invariants every owner obeys: the published
 * shape, `owner.id === ownerUserId`, and exactly `{ id, displayName }`.
 */
function ownerOf(row: Json, where: string): Json | null {
  expect('owner' in row, `${where}: no \`owner\` (and it is not withheld)`).toBe(true);
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
    errorsAgainst(ownerSchema(), object, `${where}.owner`),
    `${where}: owner does not match Contact.owner`,
  ).toEqual([]);
  return object;
}

/** The former-owner form, and none of `user`'s names or address in the row. */
function expectFormerOwner(
  row: Json,
  user: { id: string; displayName: string; email: string },
  where: string,
  alsoAbsent: readonly string[] = [],
): void {
  expect(
    ownerOf(row, where),
    `${where}: a former owner reads as { id, displayName: null }`,
  ).toEqual({ id: user.id, displayName: null });
  const text = JSON.stringify(row);
  for (const needle of [user.displayName, user.email, ...alsoAbsent]) {
    expect(text.includes(needle), `${where}: the row carries "${needle}"`).toBe(false);
  }
}

function expectNamedOwner(row: Json, user: { id: string; displayName: string }, where: string) {
  expect(ownerOf(row, where), `${where}: a member owner is named`).toEqual({
    id: user.id,
    displayName: user.displayName,
  });
}

function expectAbsent(text: string, needles: readonly string[], where: string): void {
  for (const needle of needles) {
    expect(text.includes(needle), `${where} contains "${needle}"`).toBe(false);
  }
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
// Concurrency plumbing: a latch, and a wait on lock state (never on time).
// ---------------------------------------------------------------------------

interface Latch<T = void> {
  open: (value: T) => void;
  wait: Promise<T>;
}

function latch<T = void>(): Latch<T> {
  let open: (value: T) => void = () => undefined;
  const wait = new Promise<T>((resolvePromise) => {
    open = resolvePromise;
  });
  return { open, wait };
}

// ---------------------------------------------------------------------------

describe('acceptance: a former owner (T-0103, D-P23)', () => {
  let app: INestApplication;
  /** kasuwa_migrator — BYPASSRLS. Plants and observes; never serves. */
  let observer: Pool;
  /** kasuwa_app — the serving role, for the removals a session can make (P1, P2). */
  let appPool: Pool;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot(withAuthDatabase({ databaseUrl: inject('databaseUrl'), poolMax: 5 })),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: new RecordingLogger() });
    await app.init();
    observer = createPool({ connectionString: inject('migrationUrl'), max: 4 });
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 3 });
  });

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();
  const getContact = (headers: Headers, id: string) =>
    request(server()).get(contactPath(id)).set(headers);
  const listContacts = (headers: Headers) =>
    request(server()).get(`${CONTACTS}?limit=100`).set(headers);
  const listLeads = (headers: Headers) => request(server()).get(`${LEADS}?limit=100`).set(headers);
  const listAccountContacts = (headers: Headers, accountId: string) =>
    request(server())
      .get(`${accountContactsPath(accountId)}?limit=100`)
      .set(headers);
  const updateContact = (headers: Headers, id: string, body: unknown) =>
    request(server())
      .patch(contactPath(id))
      .set(headers)
      .send(body as object);
  const convert = (headers: Headers, id: string, body: unknown) =>
    request(server())
      .post(convertPath(id))
      .set(headers)
      .send(body as object);
  const timeline = (headers: Headers, id: string) =>
    request(server())
      .get(`${timelinePath(id)}?limit=100`)
      .set(headers);

  // --- observer helpers -----------------------------------------------------

  interface ContactRow {
    id: string;
    programme_id: string;
    owner_user_id: string | null;
    version: number;
    [column: string]: unknown;
  }

  async function contactRow(id: string): Promise<ContactRow> {
    const result = await observer.query<ContactRow>('SELECT * FROM contact WHERE id = $1', [id]);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`no contact ${id}`);
    return row;
  }

  async function snapshot(ids: readonly string[]): Promise<Map<string, ContactRow>> {
    const result = await observer.query<ContactRow>(
      'SELECT * FROM contact WHERE id = ANY ($1::uuid[])',
      [ids],
    );
    return new Map(result.rows.map((row) => [row.id, row]));
  }

  /** Every column but the three an unassignment may change. */
  function untouchedColumns(row: ContactRow | undefined): Json {
    if (row === undefined) return {};
    const rest: Json = { ...row };
    delete rest.owner_user_id;
    delete rest.version;
    delete rest.updated_at;
    return rest;
  }

  async function plantOwner(contactId: string, ownerUserId: string | null): Promise<void> {
    try {
      await observer.query('UPDATE contact SET owner_user_id = $2 WHERE id = $1', [
        contactId,
        ownerUserId,
      ]);
    } catch (error) {
      throw new Error(
        `planting owner ${String(ownerUserId)} on ${contactId} as kasuwa_migrator failed ` +
          `(${String((error as { code?: unknown }).code)}). The read tests plant a non-member owner ` +
          'to stand for rows written before T-0103; see the header.',
      );
    }
  }

  async function setContact(id: string, values: Record<string, unknown>) {
    const columns = Object.keys(values);
    const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
    await observer.query(`UPDATE contact SET ${assignments} WHERE id = $1`, [
      id,
      ...columns.map((column) => values[column]),
    ]);
  }

  async function assign(userId: string, programmeId: string, key: string) {
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id)
       DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, TENANT_A, permissionSet(TENANT_A, key)],
    );
  }

  async function isMember(userId: string, programmeId: string): Promise<boolean> {
    const result = await observer.query(
      'SELECT 1 FROM user_programme WHERE user_id = $1 AND programme_id = $2',
      [userId, programmeId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** The invariant D-P23 protects: contacts in `programmeId` owned by a non-member. */
  async function ownedByNonMembers(programmeId: string): Promise<{ id: string; owner: string }[]> {
    const result = await observer.query<{ id: string; owner: string }>(
      `SELECT c.id, c.owner_user_id AS owner
         FROM contact c
        WHERE c.programme_id = $1
          AND c.owner_user_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM user_programme up
             WHERE up.tenant_id = c.tenant_id
               AND up.programme_id = c.programme_id
               AND up.user_id = c.owner_user_id)
        ORDER BY c.id`,
      [programmeId],
    );
    return result.rows;
  }

  interface AuditRow {
    id: string;
    tenant_id: string;
    actor_kind: string;
    actor_user_id: string | null;
    action: string;
    object_type: string;
    object_id: string | null;
    object_label: string;
    programme_id: string | null;
    changes: { field?: unknown; before?: unknown; after?: unknown; redacted?: unknown }[];
  }

  async function auditIds(): Promise<Set<string>> {
    const result = await observer.query<{ id: string }>('SELECT id FROM audit_event');
    return new Set(result.rows.map((row) => row.id));
  }

  async function auditSince(before: Set<string>): Promise<AuditRow[]> {
    const result = await observer.query<AuditRow>('SELECT * FROM audit_event ORDER BY occurred_at');
    return result.rows.filter((row) => !before.has(row.id));
  }

  /** The T-0026 matrix, against the standard field_def the seed holds (T-0053). */
  async function lockField(field: string, setKey: string, level: 'none' | 'read' | 'edit') {
    const found = await observer.query<{ id: string }>(
      `SELECT f.id FROM field_def f
         JOIN object_def o ON o.id = f.object_id AND o.tenant_id = f.tenant_id
        WHERE f.tenant_id = $1 AND o.api_name = 'contact' AND f.api_name = $2`,
      [TENANT_A, field],
    );
    const fieldId = found.rows[0]?.id;
    if (fieldId === undefined) {
      throw new Error(`Fixture drift: tenant A has no standard field_def contact.${field}`);
    }
    await observer.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [TENANT_A, fieldId, permissionSet(TENANT_A, setKey), level],
    );
  }

  /** Runs `fn` as `userId` in a real tenant transaction on kasuwa_app. */
  const asSession = <T>(userId: string, fn: (tx: TenantTx) => Promise<T>) =>
    withTenantTransaction(appPool, { tenantId: TENANT_A, userId }, fn);

  /** `<statement> RETURNING 1`, reporting how many rows it touched. */
  async function touched(tx: TenantTx, sql: string, values: unknown[]): Promise<number> {
    const rows = await tx.query<{ n: number }>(
      `WITH changed AS (${sql} RETURNING 1) SELECT count(*)::int AS n FROM changed`,
      values,
    );
    return rows[0]?.n ?? -1;
  }

  const removeSql = 'DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2';

  /** P1: the supervisor (tenant admin, reaches A1 and A2) removes a membership. */
  const removeAsAdmin = (userId: string, programmeId: string) =>
    asSession(USER_A_SUPERVISOR, (tx) => touched(tx, removeSql, [userId, programmeId]));

  /**
   * THE READ FIXTURE. Owners planted as the migrator (see the header):
   *
   *   Amaka (A1)    -> Ngozi   (A2 only)      former: in a programme, not this one
   *   Bashir (A1)   -> Emeka   (no programme) former
   *   Chioma (A1)   -> Musa    (A1 + A2)      named
   *   Damilola (A2) -> Ngozi   (A2)           named: the same person, her programme
   *
   * All three A1 contacts are leads and linked to A1's account, so listLeads
   * and listAccountContacts return them.
   */
  async function plantReadFixture(): Promise<void> {
    for (const contact of [AMAKA, BASHIR, CHIOMA]) {
      await setContact(contact.id, { status: 'new', account_id: IKOYI.id });
    }
    await plantOwner(AMAKA.id, NGOZI.id);
    await plantOwner(BASHIR.id, EMEKA.id);
    await plantOwner(CHIOMA.id, MUSA.id);
    await plantOwner(DAMILOLA.id, NGOZI.id);
    // The fixture's premise, stated rather than trusted.
    expect(await isMember(NGOZI.id, PROGRAMME_A1), 'fixture: Ngozi is not in A1').toBe(false);
    expect(await isMember(NGOZI.id, PROGRAMME_A2), 'fixture: Ngozi is in A2').toBe(true);
    expect(await isMember(EMEKA.id, PROGRAMME_A1), 'fixture: Emeka is not in A1').toBe(false);
    expect(await isMember(MUSA.id, PROGRAMME_A1), 'fixture: Musa is in A1').toBe(true);
  }

  /**
   * THE REMOVAL FIXTURE. Tunde joins A2 as well, so a removal from one
   * programme has his contacts in the other to leave alone.
   *
   *   Amaka (A1), Bashir (A1) -> Tunde
   *   Chioma (A1)             -> Musa      (another A1 owner: untouched)
   *   Damilola (A2)           -> Tunde     (his other programme: untouched)
   *   Efe (A2)                -> unassigned
   *   Grace (B1)              -> Wanjiru   (another tenant: untouched)
   */
  async function plantRemovalFixture(): Promise<void> {
    await assign(TUNDE.id, PROGRAMME_A2, 'agent');
    await plantOwner(AMAKA.id, TUNDE.id);
    await plantOwner(BASHIR.id, TUNDE.id);
    await plantOwner(CHIOMA.id, MUSA.id);
    await plantOwner(DAMILOLA.id, TUNDE.id);
    await plantOwner(EFE.id, null);
    await plantOwner(GRACE.id, WANJIRU.id);
  }

  const FIXTURE_IDS = [AMAKA.id, BASHIR.id, CHIOMA.id, DAMILOLA.id, EFE.id, GRACE.id];

  /** Every string an audit row about a removal must not carry. */
  const forbiddenInAudit = (): string[] => [
    ...SEED_CONTACTS.flatMap((contact) => [
      contact.id,
      contact.displayName,
      contact.givenNames,
      contact.familyName,
      contact.phoneE164,
    ]),
    ...ALL_USERS.flatMap((user) => [user.displayName, user.email]),
  ];

  /** The one removal event (D-L99), unchanged by T-0104: every new row that is not a contact event. */
  const programmeEvents = (events: readonly AuditRow[]) =>
    events.filter((event) => event.object_type !== 'contact');

  /**
   * T-0104 (D-L101 amended): exactly one contact `updated` event per
   * unassigned contact, and none for any other contact.
   */
  function expectUnassignmentEvents(
    events: readonly AuditRow[],
    removed: string,
    remover: string,
    unassigned: readonly { id: string; programmeId: string; givenNames: string }[],
  ): void {
    const contactEvents = events.filter((event) => event.object_type === 'contact');
    expect(
      contactEvents.map((event) => event.object_id).sort(),
      'T-0104 (D-L101): one contact event per unassigned contact, and none for any other',
    ).toEqual(unassigned.map((contact) => contact.id).sort());
    for (const contact of unassigned) {
      const event = contactEvents.find((candidate) => candidate.object_id === contact.id);
      if (event === undefined) continue; // reported by the comparison above
      expect(event, `${contact.givenNames}: the unassignment event`).toMatchObject({
        tenant_id: TENANT_A,
        action: 'updated',
        object_type: 'contact',
        object_id: contact.id,
        object_label: contact.id,
        programme_id: contact.programmeId,
        actor_kind: 'user',
        actor_user_id: remover,
      });
      expect(event.changes, `${contact.givenNames}: the owner change, with its values`).toEqual([
        { field: 'ownerUserId', before: removed, after: null, redacted: false },
      ]);
      const others = forbiddenInAudit().filter((needle) => needle !== contact.id);
      expectAbsent(JSON.stringify(event), others, `${contact.givenNames}'s unassignment event`);
    }
  }

  // =========================================================================
  // 1. The contract.
  // =========================================================================

  describe('the contract (records.openapi.yaml)', () => {
    it('Contact.owner admits the former-owner form { id, displayName: null }, beside a named owner and null', () => {
      const owner = ownerSchema();
      expect(errorsAgainst(owner, { id: NGOZI.id, displayName: null }, 'former')).toEqual([]);
      expect(errorsAgainst(owner, { id: MUSA.id, displayName: MUSA.displayName }, 'named')).toEqual(
        [],
      );
      expect(errorsAgainst(owner, null, 'unassigned')).toEqual([]);

      // Mutants: each single fault must be refused, or the schema checks nothing.
      const mutants: [string, unknown][] = [
        ['no displayName key at all (null must be sent, not omitted)', { id: NGOZI.id }],
        ['no id', { displayName: null }],
        ['an email beside the null name', { id: NGOZI.id, displayName: null, email: NGOZI.email }],
        ['a non-uuid id', { id: 'ngozi', displayName: null }],
        ['a number for the name', { id: NGOZI.id, displayName: 42 }],
        ['a bare null-ish string', 'former'],
      ];
      for (const [label, mutant] of mutants) {
        expect(
          errorsAgainst(owner, mutant, label).length,
          `Contact.owner accepts ${label}`,
        ).toBeGreaterThan(0);
      }
    });

    it('a whole Contact with a former owner validates, so every Contact-shaped answer may carry it', () => {
      const row: Json = {
        id: AMAKA.id,
        programmeId: PROGRAMME_A1,
        version: 2,
        displayName: AMAKA.displayName,
        ownerUserId: NGOZI.id,
        owner: { id: NGOZI.id, displayName: null },
        withheldFields: [],
        createdAt: '2026-01-01T00:01:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z',
      };
      expect(errorsAgainst(schemaRef('Contact'), row, 'Contact')).toEqual([]);
      expect(
        errorsAgainst(schemaRef('ContactPage'), { data: [row], nextCursor: null }, 'ContactPage'),
      ).toEqual([]);
    });

    it('the timeline actor rule is unchanged: an actor is always named, never { id, displayName: null }', () => {
      const actor = schemaRef('TimelineActor');
      expect(errorsAgainst(actor, { id: MUSA.id, displayName: MUSA.displayName }, 'actor')).toEqual(
        [],
      );
      expect(
        errorsAgainst(actor, { id: NGOZI.id, displayName: null }, 'null-named actor').length,
        'TimelineActor must not admit a null name (D-L81: a former member is still named)',
      ).toBeGreaterThan(0);
    });

    it('documents the former owner on Contact.owner, listLeads and convertContact, naming D-P23', () => {
      const ownerText = String(ownerSchema().description ?? '');
      expect(ownerText, 'Contact.owner').toContain('D-P23');
      expect(ownerText, 'Contact.owner').toContain('displayName: null');
      expect(operationDescription(LEADS, 'get'), 'listLeads').toContain('D-P23');
      expect(operationDescription(`${CONTACTS}/{contactId}/convert`, 'post'), 'convert').toContain(
        'D-P23',
      );
    });
  });

  // =========================================================================
  // 2. Reads: a non-member owner is { id, displayName: null }.
  // =========================================================================

  describe('reads: an owner outside the contact’s programme is a former owner', () => {
    it('getContact: removed-from-this-programme and never-in-a-programme owners are former; a member is named', async () => {
      await plantReadFixture();
      for (const [who, headers] of [
        ['supervisor', SUPERVISOR],
        ['agent 1', AGENT_1],
      ] as const) {
        const amaka = await getContact(headers, AMAKA.id);
        expectStatus(amaka, 200, `${who} getContact(Amaka)`);
        expectFormerOwner(expectContact(amaka.body, 'Amaka'), NGOZI, `${who}: Amaka`);
        expectAbsent(amaka.text, [NGOZI.displayName, NGOZI.email], `${who}: Amaka body`);

        const bashir = await getContact(headers, BASHIR.id);
        expectStatus(bashir, 200, `${who} getContact(Bashir)`);
        expectFormerOwner(expectContact(bashir.body, 'Bashir'), EMEKA, `${who}: Bashir`);
        expectAbsent(bashir.text, [EMEKA.displayName, EMEKA.email], `${who}: Bashir body`);

        const chioma = await getContact(headers, CHIOMA.id);
        expectStatus(chioma, 200, `${who} getContact(Chioma)`);
        expectNamedOwner(expectContact(chioma.body, 'Chioma'), MUSA, `${who}: Chioma`);
      }
    });

    it('listContacts: the former owner’s row stays on the page, as a former owner, beside named and unassigned rows', async () => {
      await plantReadFixture();
      const agentRows = expectPage(await listContacts(AGENT_1), 'agent 1 listContacts');
      expect(agentRows.map((row) => row.id).sort(), 'agent 1 sees all of A1, no more').toEqual(
        A1_CONTACTS.map((contact) => contact.id).sort(),
      );
      expectFormerOwner(byId(agentRows, AMAKA.id, 'agent 1'), NGOZI, 'agent 1 list: Amaka');
      expectFormerOwner(byId(agentRows, BASHIR.id, 'agent 1'), EMEKA, 'agent 1 list: Bashir');
      expectNamedOwner(byId(agentRows, CHIOMA.id, 'agent 1'), MUSA, 'agent 1 list: Chioma');
      // Agent 1 shares no programme with Ngozi or Emeka: neither name anywhere.
      const agentText = JSON.stringify(agentRows);
      expectAbsent(
        agentText,
        [NGOZI.displayName, NGOZI.email, EMEKA.displayName, EMEKA.email],
        'agent 1 list',
      );

      const supervisorRows = expectPage(await listContacts(SUPERVISOR), 'supervisor listContacts');
      expect(supervisorRows.map((row) => row.id).sort()).toEqual(
        [...A1_CONTACTS, ...A2_CONTACTS].map((contact) => contact.id).sort(),
      );
      expectFormerOwner(byId(supervisorRows, AMAKA.id, 'supervisor'), NGOZI, 'supervisor: Amaka');
      expectFormerOwner(byId(supervisorRows, BASHIR.id, 'supervisor'), EMEKA, 'supervisor: Bashir');
    });

    it('the test is THIS contact’s programme: Ngozi is named on her A2 contact and former on an A1 one, for a reader who shares A2 with her', async () => {
      await plantReadFixture();
      // The supervisor reaches A2, where Ngozi is a member. That must not
      // restore her name on an A1 contact.
      const rows = expectPage(await listContacts(SUPERVISOR), 'supervisor listContacts');
      expectNamedOwner(byId(rows, DAMILOLA.id, 'supervisor'), NGOZI, 'supervisor: Damilola (A2)');
      expectFormerOwner(byId(rows, AMAKA.id, 'supervisor'), NGOZI, 'supervisor: Amaka (A1)');
      const amaka = await getContact(SUPERVISOR, AMAKA.id);
      expectStatus(amaka, 200, 'supervisor getContact(Amaka)');
      expectAbsent(amaka.text, [NGOZI.displayName], 'supervisor: Amaka body');
    });

    it('listLeads: the same former-owner form on lead rows', async () => {
      await plantReadFixture();
      for (const [who, headers] of [
        ['agent 1', AGENT_1],
        ['supervisor', SUPERVISOR],
      ] as const) {
        const rows = expectPage(await listLeads(headers), `${who} listLeads`);
        expectFormerOwner(byId(rows, AMAKA.id, who), NGOZI, `${who} leads: Amaka`);
        expectFormerOwner(byId(rows, BASHIR.id, who), EMEKA, `${who} leads: Bashir`);
        expectNamedOwner(byId(rows, CHIOMA.id, who), MUSA, `${who} leads: Chioma`);
      }
    });

    it('listAccountContacts: the same former-owner form on an account’s contacts', async () => {
      await plantReadFixture();
      for (const [who, headers] of [
        ['agent 1', AGENT_1],
        ['supervisor', SUPERVISOR],
      ] as const) {
        const response = await listAccountContacts(headers, IKOYI.id);
        const rows = expectPage(response, `${who} listAccountContacts`);
        expect(rows.map((row) => row.id).sort()).toEqual([AMAKA.id, BASHIR.id, CHIOMA.id].sort());
        expectFormerOwner(byId(rows, AMAKA.id, who), NGOZI, `${who} account: Amaka`);
        expectFormerOwner(byId(rows, BASHIR.id, who), EMEKA, `${who} account: Bashir`);
        expectNamedOwner(byId(rows, CHIOMA.id, who), MUSA, `${who} account: Chioma`);
        expectAbsent(
          response.text,
          [NGOZI.displayName, EMEKA.displayName],
          `${who} listAccountContacts body`,
        );
      }
    });

    it('beyond the brief: updateContact and convertContact answer with the former-owner form, never a 500', async () => {
      await plantReadFixture();
      const before = await contactRow(AMAKA.id);
      const updated = await updateContact(SUPERVISOR, AMAKA.id, {
        version: before.version,
        lga: 'Ikeja',
      });
      expectStatus(updated, 200, 'updateContact(Amaka, lga)');
      expectFormerOwner(expectContact(updated.body, 'updateContact'), NGOZI, 'updateContact');
      // Writing another field leaves the owner as it was.
      expect((await contactRow(AMAKA.id)).owner_user_id).toBe(NGOZI.id);

      const converted = await convert(SUPERVISOR, BASHIR.id, {
        version: (await contactRow(BASHIR.id)).version,
        accountId: IKOYI.id,
      });
      expectStatus(converted, 200, 'convertContact(Bashir)');
      const body = converted.body as Json;
      expectFormerOwner(expectContact(body.contact, 'convert.contact'), EMEKA, 'convert.contact');
      expectAbsent(converted.text, [EMEKA.displayName, EMEKA.email], 'convert body');
    });

    it('a disabled user who is still a member keeps their name (D-L81 for actors, applied to owners)', async () => {
      await plantOwner(CHIOMA.id, TUNDE.id);
      await observer.query(`UPDATE "user" SET status = 'disabled' WHERE id = $1`, [TUNDE.id]);
      expect(await isMember(TUNDE.id, PROGRAMME_A1), 'fixture: Tunde is still in A1').toBe(true);
      const response = await getContact(SUPERVISOR, CHIOMA.id);
      expectStatus(response, 200, 'getContact(Chioma) with a disabled owner');
      expectNamedOwner(expectContact(response.body, 'Chioma'), TUNDE, 'disabled member');
      const rows = expectPage(await listContacts(SUPERVISOR), 'supervisor listContacts');
      expectNamedOwner(byId(rows, CHIOMA.id, 'supervisor'), TUNDE, 'disabled member, list');
    });

    it('read at request time: a former owner’s rename never shows, and rejoining the programme restores the name', async () => {
      await plantReadFixture();
      const renamed = `T0103 Renamed ${RUN}`;
      await observer.query('UPDATE "user" SET display_name = $1 WHERE id = $2', [
        renamed,
        NGOZI.id,
      ]);
      const after = await getContact(AGENT_1, AMAKA.id);
      expectStatus(after, 200, 'getContact(Amaka) after the rename');
      expectFormerOwner(after.body as Json, NGOZI, 'renamed former owner', [renamed]);

      // Positive control: the predicate is live, not a stored flag.
      await assign(NGOZI.id, PROGRAMME_A1, 'agent');
      const rejoined = await getContact(AGENT_1, AMAKA.id);
      expectStatus(rejoined, 200, 'getContact(Amaka) after Ngozi rejoins A1');
      expectNamedOwner(rejoined.body as Json, { id: NGOZI.id, displayName: renamed }, 'rejoined');
    });
  });

  // =========================================================================
  // 3. Removal unassigns, in the same transaction, in that programme only.
  // =========================================================================

  describe('removal unassigns the user’s contacts in that programme (P1: kasuwa_app, tenant admin)', () => {
    it('unassigns Tunde’s A1 contacts, version + 1 each, when the removal commits and not before; nothing else moves', async () => {
      await plantRemovalFixture();
      const before = await snapshot(FIXTURE_IDS);

      let seenOutside: (string | null)[] = [];
      const removed = await asSession(USER_A_SUPERVISOR, async (tx) => {
        const n = await touched(tx, removeSql, [TUNDE.id, PROGRAMME_A1]);
        // Whether the transaction sees its own unassignment before COMMIT (a
        // row trigger) or only at COMMIT (a deferred one) is the builder's.
        // What is pinned: nobody else sees it before COMMIT. No side commit,
        // no worker, no second transaction.
        const outside = await observer.query<{ owner_user_id: string | null }>(
          'SELECT owner_user_id FROM contact WHERE id = ANY ($1::uuid[])',
          [[AMAKA.id, BASHIR.id]],
        );
        seenOutside = outside.rows.map((row) => row.owner_user_id);
        return n;
      });
      expect(removed, 'the removal itself must succeed (one membership row)').toBe(1);
      expect(seenOutside, 'another connection before COMMIT still sees the owner').toEqual([
        TUNDE.id,
        TUNDE.id,
      ]);

      const after = await snapshot(FIXTURE_IDS);
      for (const contact of [AMAKA, BASHIR]) {
        const was = before.get(contact.id);
        const now = after.get(contact.id);
        expect(now?.owner_user_id, `${contact.givenNames}: unassigned`).toBeNull();
        expect(now?.version, `${contact.givenNames}: version + 1, exactly`).toBe(
          Number(was?.version) + 1,
        );
        expect(untouchedColumns(now), `${contact.givenNames}: nothing else changed`).toEqual(
          untouchedColumns(was),
        );
      }
      for (const contact of [CHIOMA, DAMILOLA, EFE, GRACE]) {
        expect(after.get(contact.id), `${contact.givenNames}: untouched, version included`).toEqual(
          before.get(contact.id),
        );
      }
      expect(await isMember(TUNDE.id, PROGRAMME_A2), 'his A2 membership stays').toBe(true);
      expect(await ownedByNonMembers(PROGRAMME_A1)).toEqual([]);

      // The removal as seen on the wire.
      const read = await getContact(SUPERVISOR, AMAKA.id);
      expectStatus(read, 200, 'getContact(Amaka) after the removal');
      expect(ownerOf(expectContact(read.body, 'Amaka'), 'Amaka')).toBeNull();
    });

    it('writes exactly one audit event: in A1, by the remover, carrying the count and no name, contact id or address', async () => {
      await plantRemovalFixture();
      const audit = await auditIds();
      expect(await removeAsAdmin(TUNDE.id, PROGRAMME_A1)).toBe(1);

      const all = await auditSince(audit);
      // D-L101 (amended, T-0104): "besides the programme event, each
      // unassigned contact gets its own audit event". So "exactly one event"
      // now reads "exactly one programme event"; every assertion on that
      // event below is unchanged. Before T-0104, `events` was every new row.
      const events = programmeEvents(all);
      expect(events, `one audit event for one removal; got ${JSON.stringify(events)}`).toHaveLength(
        1,
      );
      const [event] = events;
      if (event === undefined) throw new Error('unreachable');
      expect(event.tenant_id).toBe(TENANT_A);
      expect(event.programme_id, 'carries the programme (D-L48: null is tenant-wide)').toBe(
        PROGRAMME_A1,
      );
      expect(event.actor_kind).toBe('user');
      expect(event.actor_user_id, 'the session user who removed the membership').toBe(MUSA.id);
      expect(
        event.changes.filter((change) => change.after === '2'),
        `one change carries the count, 2, as a decimal string: ${JSON.stringify(event.changes)}`,
      ).toHaveLength(1);
      const contactIds = SEED_CONTACTS.map((contact) => contact.id);
      expect(
        event.object_id === null || !contactIds.includes(event.object_id),
        'the event is not about one contact',
      ).toBe(true);
      expectAbsent(JSON.stringify(event), forbiddenInAudit(), 'the audit row');
      // T-0104: and one event per unassigned contact, Amaka and Bashir only.
      expectUnassignmentEvents(all, TUNDE.id, MUSA.id, [AMAKA, BASHIR]);
      expect(all, 'nothing else was written').toHaveLength(3);
    });

    it('T-0104: each unassigned contact’s timeline shows the owner change, naming neither the removed owner nor their id', async () => {
      await plantRemovalFixture();
      expect(await removeAsAdmin(TUNDE.id, PROGRAMME_A1)).toBe(1);
      for (const contact of [AMAKA, BASHIR]) {
        const response = await timeline(SUPERVISOR, contact.id);
        expectStatus(response, 200, `timeline(${contact.givenNames})`);
        const items = (response.body as { data: Json[] }).data;
        const owner = items.filter((item) => item.field === 'ownerUserId');
        expect(owner.length, `${contact.givenNames}: the unassignment is on the timeline`).toBe(1);
        expect(owner[0]?.redacted, 'owner changes stay redacted on the timeline (D-L72)').toBe(
          true,
        );
        expect(owner[0]?.actor, 'by the remover, named').toEqual({
          id: MUSA.id,
          displayName: MUSA.displayName,
        });
        expectAbsent(
          response.text,
          [TUNDE.displayName, TUNDE.email, TUNDE.id],
          `${contact.givenNames}: timeline body`,
        );
      }
    });

    it('removing him from A2 instead unassigns only Damilola; A1 is untouched; the event is A2’s, with 1', async () => {
      await plantRemovalFixture();
      const before = await snapshot(FIXTURE_IDS);
      const audit = await auditIds();
      expect(await removeAsAdmin(TUNDE.id, PROGRAMME_A2)).toBe(1);

      const after = await snapshot(FIXTURE_IDS);
      expect(after.get(DAMILOLA.id)?.owner_user_id).toBeNull();
      expect(after.get(DAMILOLA.id)?.version).toBe(Number(before.get(DAMILOLA.id)?.version) + 1);
      for (const contact of [AMAKA, BASHIR, CHIOMA, EFE, GRACE]) {
        expect(after.get(contact.id), `${contact.givenNames}: untouched`).toEqual(
          before.get(contact.id),
        );
      }
      const all = await auditSince(audit);
      // D-L101 (amended, T-0104): "besides the programme event, each
      // unassigned contact gets its own audit event". The one-event pin now
      // applies to the programme event. Before T-0104, `events` was every new row.
      const events = programmeEvents(all);
      expect(events).toHaveLength(1);
      expect(events[0]?.programme_id).toBe(PROGRAMME_A2);
      expect(events[0]?.changes.filter((change) => change.after === '1')).toHaveLength(1);
      expectUnassignmentEvents(all, TUNDE.id, MUSA.id, [DAMILOLA]);
      expect(all, 'nothing else was written').toHaveLength(2);
    });

    it('one statement removing both his memberships clears both programmes, each event in its own programme', async () => {
      await plantRemovalFixture();
      const audit = await auditIds();
      const n = await asSession(USER_A_SUPERVISOR, (tx) =>
        touched(tx, 'DELETE FROM user_programme WHERE user_id = $1', [TUNDE.id]),
      );
      expect(n).toBe(2);
      const after = await snapshot(FIXTURE_IDS);
      for (const contact of [AMAKA, BASHIR, DAMILOLA]) {
        expect(after.get(contact.id)?.owner_user_id, `${contact.givenNames}`).toBeNull();
      }
      expect(after.get(CHIOMA.id)?.owner_user_id).toBe(MUSA.id);
      expect(after.get(GRACE.id)?.owner_user_id).toBe(WANJIRU.id);
      const all = await auditSince(audit);
      for (const event of all) {
        expect(
          [PROGRAMME_A1, PROGRAMME_A2],
          'never a programme-less (tenant-wide) event',
        ).toContain(event.programme_id);
      }
      // D-L101 (amended, T-0104): "besides the programme event, each
      // unassigned contact gets its own audit event". A contact event names
      // its own contact by id, so the no-contact-id scan applies to the
      // programme events; the contact events get their own scan (every other
      // contact's id, and every name, phone and email) in
      // expectUnassignmentEvents. Before T-0104 both checks ran on every new row.
      const events = programmeEvents(all);
      expect(events.length, 'at least one event').toBeGreaterThan(0);
      for (const event of events) {
        expectAbsent(JSON.stringify(event), forbiddenInAudit(), 'the audit row');
      }
      // Each in its own programme: Amaka and Bashir in A1, Damilola in A2.
      expectUnassignmentEvents(all, TUNDE.id, MUSA.id, [AMAKA, BASHIR, DAMILOLA]);
    });

    it('a removal that rolls back changes nothing: owners, versions and the audit log are as they were', async () => {
      // Passes on main, where nothing is unassigned at all. It is not vacuous
      // once the work lands: an unassignment committed apart from the removal
      // (a side connection, a job queued from the DELETE) survives this
      // rollback and fails here. The commit case is the first test above.
      await plantRemovalFixture();
      const before = await snapshot(FIXTURE_IDS);
      const audit = await auditIds();
      let deletedInside = -1;
      const abort = new Error('T0103: abort after the removal');
      await expect(
        asSession(USER_A_SUPERVISOR, async (tx) => {
          deletedInside = await touched(tx, removeSql, [TUNDE.id, PROGRAMME_A1]);
          throw abort;
        }),
      ).rejects.toBe(abort);
      expect(deletedInside, 'the DELETE ran before the rollback').toBe(1);

      expect(await snapshot(FIXTURE_IDS)).toEqual(before);
      expect(await auditSince(audit)).toEqual([]);
      expect(await isMember(TUNDE.id, PROGRAMME_A1)).toBe(true);
    });

    it('a refused removal changes nothing: a non-admin, and an admin outside the programme, delete 0 rows and unassign nothing', async () => {
      // Passes on main by construction (0021 filters both). It guards against
      // an implementation that unassigns ahead of, or apart from, the DELETE.
      await plantRemovalFixture();
      await observer.query(removeSql, [MUSA.id, PROGRAMME_A2]); // the admin no longer reaches A2
      const before = await snapshot(FIXTURE_IDS);
      const audit = await auditIds();

      const nonAdmin = await asSession(USER_A_AGENT_1, (tx) =>
        touched(tx, removeSql, [TUNDE.id, PROGRAMME_A1]),
      );
      expect(nonAdmin, 'a non-admin’s DELETE is filtered (0021)').toBe(0);
      const outside = await asSession(USER_A_SUPERVISOR, (tx) =>
        touched(tx, removeSql, [TUNDE.id, PROGRAMME_A2]),
      );
      expect(outside, 'an admin cannot remove from a programme he does not reach').toBe(0);

      expect(await snapshot(FIXTURE_IDS)).toEqual(before);
      expect(await auditSince(audit)).toEqual([]);
    });

    it('P2: rewriting the membership to another user removes the old one; refused, or it unassigns', async () => {
      await plantRemovalFixture();
      let outcome = 'accepted';
      try {
        await asSession(USER_A_SUPERVISOR, (tx) =>
          touched(
            tx,
            'UPDATE user_programme SET user_id = $1 WHERE user_id = $2 AND programme_id = $3',
            [EMEKA.id, TUNDE.id, PROGRAMME_A1],
          ),
        );
      } catch (error) {
        outcome = `refused ${String((error as { code?: unknown }).code)}`;
      }
      const tundeStillIn = await isMember(TUNDE.id, PROGRAMME_A1);
      if (outcome !== 'accepted') {
        expect(tundeStillIn, `${outcome}: a refused rewrite changes nothing`).toBe(true);
      }
      expect(await ownedByNonMembers(PROGRAMME_A1), `rewrite ${outcome}`).toEqual([]);
      expect((await contactRow(DAMILOLA.id)).owner_user_id, 'A2 untouched').toBe(TUNDE.id);
    });

    it('P2: moving the membership to another programme removes it from the first; refused, or it unassigns', async () => {
      // Seed shape: Tunde is in A1 only, so the move cannot collide.
      await plantOwner(AMAKA.id, TUNDE.id);
      let outcome = 'accepted';
      try {
        await asSession(USER_A_SUPERVISOR, (tx) =>
          touched(
            tx,
            'UPDATE user_programme SET programme_id = $1 WHERE user_id = $2 AND programme_id = $3',
            [PROGRAMME_A2, TUNDE.id, PROGRAMME_A1],
          ),
        );
      } catch (error) {
        outcome = `refused ${String((error as { code?: unknown }).code)}`;
      }
      if (outcome !== 'accepted') {
        expect(await isMember(TUNDE.id, PROGRAMME_A1), `${outcome}: nothing changed`).toBe(true);
      }
      expect(await ownedByNonMembers(PROGRAMME_A1), `move ${outcome}`).toEqual([]);
    });

    it('P3: a removal made as kasuwa_migrator (operator jobs) unassigns too, in that programme only', async () => {
      await plantRemovalFixture();
      const before = await snapshot(FIXTURE_IDS);
      const deleted = await observer.query(removeSql, [TUNDE.id, PROGRAMME_A1]);
      expect(deleted.rowCount).toBe(1);
      const after = await snapshot(FIXTURE_IDS);
      expect(after.get(AMAKA.id)?.owner_user_id).toBeNull();
      expect(after.get(BASHIR.id)?.owner_user_id).toBeNull();
      expect(after.get(DAMILOLA.id)).toEqual(before.get(DAMILOLA.id));
      expect(after.get(CHIOMA.id)).toEqual(before.get(CHIOMA.id));
      expect(await ownedByNonMembers(PROGRAMME_A1)).toEqual([]);
    });

    it('not a removal: a permission-set change, an archive and a disabled user leave every owner in place', async () => {
      // Guards, passing on main: the unassignment must hang on membership
      // ending, not on a member losing rights or a programme going quiet.
      await plantRemovalFixture();
      const before = await snapshot(FIXTURE_IDS);
      const changed = await asSession(USER_A_SUPERVISOR, (tx) =>
        touched(
          tx,
          'UPDATE user_programme SET permission_set_id = $1 WHERE user_id = $2 AND programme_id = $3',
          [permissionSet(TENANT_A, 'qa_analyst'), TUNDE.id, PROGRAMME_A1],
        ),
      );
      expect(changed).toBe(1);
      await observer.query(`UPDATE "user" SET status = 'disabled' WHERE id = $1`, [TUNDE.id]);
      const programme = await observer.query<{ name: string }>(
        'SELECT name FROM programme WHERE id = $1',
        [PROGRAMME_A2],
      );
      const archived = await request(server())
        .post(`/api/v1/admin/programmes/${PROGRAMME_A2}/archive`)
        .set(SUPERVISOR)
        .send({ confirmation: programme.rows[0]?.name });
      expectStatus(archived, 200, 'archiveProgramme(A2)');
      expect(await snapshot(FIXTURE_IDS)).toEqual(before);
    });

    it('offboarding still works with owned contacts: the migrator deletes a programme and a tenant, and nothing is left', async () => {
      // Guards, passing on main (delete-guard D5 plants no owners). An
      // unassigning trigger must not break the cascades it now rides on.
      const scratch = randomUUID();
      await observer.query(
        `INSERT INTO programme (id, tenant_id, business_unit_id, name)
         VALUES ($1, $2, $3, $4)`,
        [scratch, TENANT_A, BU_A, `T0103 Scratch ${RUN}`],
      );
      await assign(TUNDE.id, scratch, 'agent');
      const scratchContact = randomUUID();
      await observer.query(
        `INSERT INTO contact (id, tenant_id, programme_id, display_name, owner_user_id)
         VALUES ($1, $2, $3, 'T0103 Scratch Contact', $4)`,
        [scratchContact, TENANT_A, scratch, TUNDE.id],
      );
      const programmeDeleted = await observer.query('DELETE FROM programme WHERE id = $1', [
        scratch,
      ]);
      expect(programmeDeleted.rowCount).toBe(1);
      const leftover = await observer.query('SELECT 1 FROM contact WHERE id = $1', [
        scratchContact,
      ]);
      expect(leftover.rowCount).toBe(0);

      await plantOwner(GRACE.id, WANJIRU.id);
      const tenantDeleted = await observer.query('DELETE FROM tenant WHERE id = $1', [TENANT_B]);
      expect(tenantDeleted.rowCount).toBe(1);
      const remaining = await observer.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM contact WHERE tenant_id = $1)
              + (SELECT count(*) FROM user_programme WHERE tenant_id = $1)
              + (SELECT count(*) FROM "user" WHERE tenant_id = $1) AS n`,
        [TENANT_B],
      );
      expect(Number(remaining.rows[0]?.n)).toBe(0);
    });
  });

  // =========================================================================
  // 4. Concurrency: a removal racing an owner assignment.
  // =========================================================================

  describe('concurrency: a removal racing an assignment never leaves a non-member owner', () => {
    /** Is any backend waiting on a lock that `pid` holds? */
    async function someoneBlockedBy(pid: number): Promise<boolean> {
      const result = await observer.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE NOT granted AND $1 = ANY (pg_blocking_pids(pid))`,
        [pid],
      );
      return (result.rows[0]?.n ?? 0) > 0;
    }

    async function isBlocked(pid: number): Promise<boolean> {
      const result = await observer.query<{ blocked: boolean }>(
        'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
        [pid],
      );
      return result.rows[0]?.blocked === true;
    }

    /** Polls STATE until `done()` or a deadline (which only turns a hang into a failure). */
    async function waitFor(what: string, done: () => Promise<boolean> | boolean): Promise<void> {
      const deadline = Date.now() + 15_000;
      for (;;) {
        if (await done()) return;
        if (Date.now() > deadline) throw new Error(`${what}: not reached within 15 s`);
        // Yield to the event loop (not a sleep): a condition that reads only
        // local state would otherwise starve the I/O it is waiting for.
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      }
    }

    interface Race {
      removal?: Promise<number>;
      release: Latch;
    }

    /** Starts a removal of Tunde from A1 as the supervisor, held open after its DELETE. */
    function startRemoval(): {
      race: Race;
      pid: Promise<number>;
      statement: { done: boolean; error?: string };
    } {
      const pid = latch<number>();
      const statement: { done: boolean; error?: string } = { done: false };
      const race: Race = { release: latch() };
      race.removal = asSession(USER_A_SUPERVISOR, async (tx) => {
        const [row] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        pid.open(row?.pid ?? -1);
        try {
          const n = await touched(tx, removeSql, [TUNDE.id, PROGRAMME_A1]);
          statement.done = true;
          await race.release.wait;
          return n;
        } catch (error) {
          statement.done = true;
          statement.error = String((error as { code?: unknown }).code ?? error);
          throw error;
        }
      });
      return { race, pid: pid.wait, statement };
    }

    /** The verdict both orders share. */
    async function expectNoNonMemberOwner(patch: request.Response, where: string): Promise<void> {
      expect(await isMember(TUNDE.id, PROGRAMME_A1), `${where}: the removal committed`).toBe(false);
      expect(
        await ownedByNonMembers(PROGRAMME_A1),
        `${where}: A1 contacts owned by a non-member (assignment answered ${patch.status})`,
      ).toEqual([]);
      if (patch.status === 200) {
        // The assignment won; the removal must then have unassigned it.
        expect((await contactRow(CHIOMA.id)).owner_user_id, where).toBeNull();
      } else {
        // Refused as a non-member owner (400 unknown_reference, D-L67) or, for
        // a caller whose own membership has just gone, as out of scope (404).
        if (patch.status === 404) {
          expectError(patch, 404, 'not_found');
        } else {
          const body = expectError(patch, 400, 'validation_failed');
          expect(JSON.stringify(body), `${where}: the refusal names the field`).toContain(
            'unknown_reference',
          );
        }
        expectAbsent(patch.text, [TUNDE.displayName, TUNDE.email], `${where}: refusal body`);
      }
    }

    // Two assigners: an admin assigning Tunde, and Tunde claiming it himself
    // (D-P14), the agent's path, which 0021's restrictive policies treat
    // differently from a tenant admin's.
    for (const [assigner, headers] of [
      ['the supervisor assigns Tunde', SUPERVISOR],
      ['Tunde claims it himself (D-P14)', AGENT_1],
    ] as const) {
      it(`removal first, held open; while it is uncommitted, ${assigner}`, async () => {
        await plantOwner(AMAKA.id, TUNDE.id);
        await plantOwner(CHIOMA.id, null);
        const version = (await contactRow(CHIOMA.id)).version;

        const { race, pid, statement } = startRemoval();
        let patch: Promise<request.Response> | undefined;
        try {
          const removalPid = await pid;
          await waitFor('the removal’s DELETE', () => statement.done);
          expect(statement.error, 'the removal’s DELETE failed on its own').toBeUndefined();

          let answered = false;
          patch = updateContact(headers, CHIOMA.id, { version, ownerUserId: TUNDE.id }).then(
            (response) => {
              answered = true;
              return response;
            },
          );
          // State, not time: the assignment answered, or it waits on the removal.
          await waitFor('the assignment answered or blocked', async () =>
            answered ? true : someoneBlockedBy(removalPid),
          );
          race.release.open();
          expect(await race.removal, 'one membership removed').toBe(1);
          const response = await patch;
          await expectNoNonMemberOwner(response, `removal first, ${assigner}`);
          expect((await contactRow(AMAKA.id)).owner_user_id, 'Amaka, owned before').toBeNull();
        } finally {
          race.release.open();
          await Promise.allSettled([race.removal, patch].filter((p) => p !== undefined));
        }
      });
    }

    it('assignment first, stalled on the contact row; the removal runs while it waits', async () => {
      await plantOwner(CHIOMA.id, null);
      const version = (await contactRow(CHIOMA.id)).version;

      // A migrator transaction holds Chioma's row, so the assignment stops
      // wherever it first touches the row (after or before its member check).
      const locker: PoolClient = await observer.connect();
      let lockerOpen = false;
      let patch: Promise<request.Response> | undefined;
      let race: Race | undefined;
      try {
        await locker.query('BEGIN');
        lockerOpen = true;
        await locker.query('SELECT 1 FROM contact WHERE id = $1 FOR UPDATE', [CHIOMA.id]);
        const lockerPid = Number(
          (await locker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid,
        );

        let answered = false;
        patch = updateContact(SUPERVISOR, CHIOMA.id, { version, ownerUserId: TUNDE.id }).then(
          (response) => {
            answered = true;
            return response;
          },
        );
        await waitFor('the assignment stalled on the row (or answered)', async () =>
          answered ? true : someoneBlockedBy(lockerPid),
        );

        const started = startRemoval();
        race = started.race;
        const removalPid = await started.pid;
        await waitFor('the removal’s DELETE finished or blocked', async () =>
          started.statement.done ? true : isBlocked(removalPid),
        );

        if (started.statement.done) {
          // The removal did not wait for the assignment: commit it first.
          race.release.open();
          expect(await race.removal).toBe(1);
          await locker.query('ROLLBACK');
          lockerOpen = false;
        } else {
          // The removal waits on the assignment: let the assignment through.
          await locker.query('ROLLBACK');
          lockerOpen = false;
          race.release.open();
          expect(await race.removal).toBe(1);
        }
        const response = await patch;
        await expectNoNonMemberOwner(response, 'assignment first');
      } finally {
        if (lockerOpen) await locker.query('ROLLBACK');
        locker.release();
        race?.release.open();
        await Promise.allSettled([race?.removal, patch].filter((p) => p !== undefined));
      }
    });
  });

  // =========================================================================
  // 5. Leaks: field security, logs, errors, the timeline.
  // =========================================================================

  describe('leaks', () => {
    it('field security on ownerUserId still applies: withheld means no owner key at all, on every read', async () => {
      await plantReadFixture();
      await lockField('owner_user_id', 'agent', 'none');
      const reads: [string, request.Response][] = [
        ['getContact', await getContact(AGENT_1, AMAKA.id)],
        ['listContacts', await listContacts(AGENT_1)],
        ['listLeads', await listLeads(AGENT_1)],
        ['listAccountContacts', await listAccountContacts(AGENT_1, IKOYI.id)],
      ];
      for (const [operation, response] of reads) {
        expectStatus(response, 200, `agent 1 ${operation}`);
        const body = response.body as Json;
        const rows = Array.isArray(body.data) ? (body.data as Json[]) : [body];
        expect(rows.length, `${operation}: rows to check`).toBeGreaterThan(0);
        for (const row of rows) {
          expect('owner' in row, `${operation}: owner present though withheld`).toBe(false);
          expect('ownerUserId' in row, `${operation}: ownerUserId present though withheld`).toBe(
            false,
          );
          expect(row.withheldFields, `${operation}: both listed`).toEqual(
            expect.arrayContaining(['owner', 'ownerUserId']),
          );
        }
        expectAbsent(
          response.text,
          [NGOZI.id, NGOZI.displayName, EMEKA.id, EMEKA.displayName, MUSA.id],
          `${operation} body`,
        );
      }
      // Control: the lock is the agent set's, not everyone's.
      const supervisor = await getContact(SUPERVISOR, AMAKA.id);
      expectStatus(supervisor, 200, 'supervisor getContact');
      expectFormerOwner(supervisor.body as Json, NGOZI, 'supervisor, unlocked');
    });

    it('no former owner’s name or address reaches a log line, a span attribute or a span event', async () => {
      await plantReadFixture();
      const canary = `t0103-canary-${RUN}`;
      const bodies: string[] = [];
      const statuses: number[] = [];
      const { telemetry, lines } = await captureEverything(async () => {
        process.stdout.write(`${canary}\n`);
        for (const call of [
          () => getContact(AGENT_1, AMAKA.id),
          () => getContact(SUPERVISOR, BASHIR.id),
          () => listContacts(SUPERVISOR),
          () => listLeads(AGENT_1),
          () => listAccountContacts(SUPERVISOR, IKOYI.id),
          () => timeline(SUPERVISOR, AMAKA.id),
        ]) {
          const response = await call();
          statuses.push(response.status);
          bodies.push(response.text);
        }
      });
      expect(statuses, 'every read answered 200: never a 500').toEqual(statuses.map(() => 200));

      // Self-checks: the capture is live, and the reads were recorded.
      expect(
        lines.some((line) => line.includes(canary)),
        'stdout capture saw nothing',
      ).toBe(true);
      expect(
        telemetry.spans.filter(isInboundApiSpan).length,
        'no inbound span was recorded, so the span check would be vacuous',
      ).toBeGreaterThan(0);
      // Ngozi's name is legitimately served once (Damilola, A2, supervisor):
      // proof the name was in play, so its absence from logs means something.
      expect(bodies.join('\n'), 'the name never reached a body').toContain(NGOZI.displayName);

      const channels: Record<string, string> = {
        'a log line': lines.join('\n'),
        'a span attribute': JSON.stringify(telemetry.spans.map((span) => span.attributes)),
        'a span event': JSON.stringify(telemetry.spans.map((span) => span.events)),
      };
      for (const [channel, haystack] of Object.entries(channels)) {
        for (const needle of [NGOZI.displayName, NGOZI.email, EMEKA.displayName, EMEKA.email]) {
          for (const form of formsOf(needle)) {
            expect(haystack.includes(form), `${channel} carries "${form}"`).toBe(false);
          }
        }
      }
    });

    it('assigning a removed member answers exactly as an invented id, naming no one', async () => {
      // Passes on main (D-L67's check). It pins the refusal for a FORMER
      // member, the case removal now creates every time.
      expect(await removeAsAdmin(TUNDE.id, PROGRAMME_A1)).toBe(1);
      const version = (await contactRow(CHIOMA.id)).version;
      const former = await updateContact(SUPERVISOR, CHIOMA.id, { version, ownerUserId: TUNDE.id });
      const invented = await updateContact(SUPERVISOR, CHIOMA.id, {
        version,
        ownerUserId: NOWHERE,
      });
      expect(expectError(former, 400, 'validation_failed')).toEqual(
        expectError(invented, 400, 'validation_failed'),
      );
      expectAbsent(former.text, [TUNDE.displayName, TUNDE.email, TUNDE.id], 'refusal body');
      expect((await contactRow(CHIOMA.id)).version, 'a refusal writes nothing').toBe(version);
    });

    it('the timeline: past owner changes show neither name nor id, before and after the owner is removed (D-L85)', async () => {
      // Two audited owner changes through the API: unassigned -> Tunde -> Musa.
      const first = await updateContact(SUPERVISOR, AMAKA.id, {
        version: (await contactRow(AMAKA.id)).version,
        ownerUserId: TUNDE.id,
      });
      expectStatus(first, 200, 'assign Tunde');
      const second = await updateContact(SUPERVISOR, AMAKA.id, {
        version: (await contactRow(AMAKA.id)).version,
        ownerUserId: MUSA.id,
      });
      expectStatus(second, 200, 'assign Musa');
      // And a former owner on another contact, through the plant.
      await plantOwner(BASHIR.id, NGOZI.id);

      const read = async (where: string) => {
        const response = await timeline(SUPERVISOR, AMAKA.id);
        expectStatus(response, 200, where);
        const items = (response.body as { data: Json[] }).data;
        const ownerItems = items.filter((item) => item.field === 'ownerUserId');
        expect(ownerItems.length, `${where}: the two owner changes are on the timeline`).toBe(2);
        for (const item of ownerItems) {
          expect(item.redacted, `${where}: owner changes are redacted`).toBe(true);
          // The actor rule is unchanged: the supervisor made both, by name.
          expect(item.actor, `${where}: actor`).toEqual({
            id: MUSA.id,
            displayName: MUSA.displayName,
          });
        }
        expectAbsent(
          response.text,
          [TUNDE.displayName, TUNDE.email, TUNDE.id],
          `${where}: timeline body`,
        );
      };
      await read('before the removal');
      expect(await removeAsAdmin(TUNDE.id, PROGRAMME_A1)).toBe(1);
      await read('after the removal');

      const bashir = await timeline(SUPERVISOR, BASHIR.id);
      expectStatus(bashir, 200, 'timeline of a contact with a former owner');
      expectAbsent(bashir.text, [NGOZI.displayName, NGOZI.id], 'Bashir timeline');
    });
  });
});
