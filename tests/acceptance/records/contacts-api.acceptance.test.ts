import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { inspect } from 'node:util';
import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_CONTACTS,
  SEED_PERMISSION_SETS,
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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from 'vitest';
import { parse } from 'yaml';
import { asUser, withAuthDatabase } from '../support/api';
import { collectTelemetry, type Telemetry } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0041, the contacts write, search and filter API (Agent 3, M3).
 *
 * THE CONTRACT is `docs/api/records.openapi.yaml` (T-0039, merged as #76),
 * which shares admin's `Error` schema. This suite does not transcribe the
 * schemas by hand: it LOADS the YAML and validates every response body against
 * `Contact`, `ContactPage` and `Error` with a small JSON-Schema checker below
 * (there is no schema-validation helper in tests/acceptance/support, and no
 * new dependency is added for one). If the spec and this file disagree, the
 * spec is right and this file is the defect: say so in the report, do not edit
 * it.
 *
 * Sources: team/tasks/T-0041-contacts-api.md; D-L60 (the slice), D-L61 (value
 * sets, DND), D-L53 (permissions model, 404 -> 403 -> 400), D-L54 (audit:
 * `email` is a redacted change), D-L45/D-P9 (field-security matrix), D-P13
 * (no totals); team/reports/T-0039.md "drift"; CLAUDE.md 2.1-2.3 and 6.1-6.4.
 *
 * ------------------------------------------------------------------------
 * SEAMS THE BUILDER MUST PROVIDE. Internals are yours; these are not.
 *
 *   S1. PERMISSION. A new PROGRAMME-SCOPED action in `@kasuwa/permissions`,
 *       named `contact.write` (the name is the builder's; the behaviour is
 *       not), covering createContact AND updateContact. Per D-L53 it is
 *       permitted by the locked `admin` set held IN THE TARGET PROGRAMME (the
 *       record's programme for update, `programmeId` for create) or by the
 *       tenant-admin flag, always only inside a programme the session already
 *       reaches. Every other set (`agent`, `team_lead`, `qa_analyst`,
 *       `programme_manager`, `client_portal`) is READ-ONLY for contacts this
 *       round, exactly as D-L53 makes them read-only for admin writes. Widening
 *       it to `agent` is a lead decision (P04 shows agents editing Owner and
 *       Status inline); if it is taken, the single test named "the agent set
 *       may not write" is the one assertion that changes.
 *
 *   S2. AUDIT. One `audit_event` row per successful create or update, through
 *       the T-0033 pattern: `object_type = 'contact'`, `object_id` = the
 *       contact id, `action` `created` / `updated`, `programme_id` = the
 *       contact's programme (D-L48: an event with a programme is visible to
 *       that programme's members only; null would publish it tenant-wide),
 *       `actor_kind = 'user'` and `actor_user_id` = the session user.
 *       `changes[].field` uses the wire names (D-L48). `phones` and `emails`,
 *       whenever sent, appear as REDACTED changes (D-L54's `email` rule:
 *       `redacted: true`, `before` and `after` null), and no phone number or
 *       email address appears anywhere in the row. Refused writes write none.
 *
 *   S3. FIELD SECURITY is the T-0026 matrix (D-P9, D-L45): object_def
 *       `api_name = 'contact'`, field_def `api_name` = the snake_case of the
 *       wire property (`emails`, `phones`, `lga`), and
 *       `field_security_grant.level` for the permission set the caller holds
 *       IN THE RECORD'S PROGRAMME (create: the target programme). No grant
 *       row is `edit` (D-L45). `none` withholds (omitted from the object,
 *       named in `withheldFields`); `read` reads but may not be written
 *       (`403 not_permitted`, `details[].code: field_not_editable`, per the
 *       contract's NotPermitted example). The locked `admin` set is always
 *       `edit`. The TENANT-ADMIN FLAG IS NOT A PERMISSION SET and does not lift
 *       field security: it decides admin writes (D-L53), never what a person
 *       can see (D-L06 in spirit). The suite plants object_def / field_def
 *       with ON CONFLICT DO NOTHING, so a builder who seeds a standard contact
 *       catalogue is compatible.
 *
 *   S4. DEFAULT COUNTRY. `q` is normalised to E.164 with the tenant's default
 *       country. Where that comes from is yours (a column, `region_cell`,
 *       `currency_default`); the suite relies only on tenant A (Sahel BPO,
 *       NGN, za-1) being NG and tenant B (Rift Valley Contact, KES, ke-1)
 *       being KE.
 *
 *   S5. T-0040's columns, including `version` on contact. The suite plants
 *       values through `kasuwa_migrator` (BYPASSRLS, never serves). If the
 *       columns are absent, the blocks that plant fail with
 *       "T-0040 has not landed" rather than a SQL error.
 *
 * ------------------------------------------------------------------------
 * CONTRACT READINGS this suite pins, where the YAML leaves a choice:
 *
 *   - A write that sets a withheld (or read-only-for-you) field is
 *     `403 not_permitted` naming the field in `details[].path` with
 *     `code: field_not_editable` — the contract's own example. Not 400.
 *   - "Field security omits": EVERY `Contact` property is either present or
 *     listed in `withheldFields`, never both and never neither. A property
 *     that is simply missing is indistinguishable from a withheld one, which
 *     is the ambiguity the rule exists to remove.
 *   - A `Contact` carries no property the schema does not name (a leaked
 *     `tenantId` would otherwise pass a JSON-Schema check, because `Contact`
 *     does not set `additionalProperties: false`).
 *   - The scope-header rejection is `400` with the shared Error envelope and
 *     `code: validation_failed`: the contract lists "a scope header" under
 *     `ValidationFailed`.
 *   - `q` matching: whole given name, family name and the formats the
 *     contract lists. Prefix/substring matching is NOT asserted either way. A
 *     `q` of `%`, `_` or `.*` matches literally (nothing here), never as a
 *     wildcard.
 *   - D-L53's order (404, then 403, then 400) applies to contact writes too.
 *   - Not asserted: the version a NEW contact starts at (only that it is an
 *     integer >= 1 and that an update adds exactly 1); audit `before`/`after`
 *     for non-PII fields; the contact's `object_label` (whether a contact's
 *     name may be an audit label is an open question for the lead); whether
 *     an owner must belong to the contact's programme (D-L61 open).
 *
 * Writes. Every test reseeds afterwards; the suite reseeds before and after.
 */

// ---------------------------------------------------------------------------
// Constants and fixtures (packages/db/src/fixtures.ts, never a second set).
// ---------------------------------------------------------------------------

const CONTACTS = '/api/v1/contacts';
const contactPath = (id: string) => `${CONTACTS}/${id}`;

/** Never a real row: same shape as the seed ids, nothing seeds it. */
const NOWHERE = '11111111-0000-4000-8000-0000004199ff';
/** An account this suite plants in A2 (T-0040 shape), for the cross-programme probe. */
const ACCOUNT_A2 = '11111111-0000-4000-8000-00000041a002';
/** A contact planted with the contract's own diacritics example. */
const CONTACT_ADEBAYO = '11111111-0000-4000-8000-00000041c001';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);
const AGENT_2 = asUser(TENANT_A, USER_A_AGENT_2);
const NO_PROGRAMME = asUser(TENANT_A, USER_A_NO_PROGRAMME);
const TENANT_B_USER = asUser(TENANT_B, USER_B_AGENT_1);

type Headers = Record<string, string>;
type Json = Record<string, unknown>;

function seeded(givenNames: string) {
  const contact = SEED_CONTACTS.find((candidate) => candidate.givenNames === givenNames);
  if (contact === undefined) throw new Error(`Fixture drift: no seeded contact '${givenNames}'`);
  return contact;
}

/** Tenant A, programme A1. */
const AMAKA = seeded('Amaka');
const BASHIR = seeded('Bashir');
const CHIOMA = seeded('Chioma');
/** Tenant A, programme A2. */
const DAMILOLA = seeded('Damilola');
const EFE = seeded('Efe');
/** Tenant B, programme B1. */
const GRACE = seeded('Grace');

const idsIn = (programmeId: string) =>
  SEED_CONTACTS.filter((contact) => contact.programmeId === programmeId).map((c) => c.id);

function permissionSet(tenantId: string, key: string): string {
  const set = SEED_PERMISSION_SETS.find(
    (candidate) => candidate.tenantId === tenantId && candidate.key === key,
  );
  if (set === undefined) throw new Error(`Fixture drift: no seeded permission set '${key}'`);
  return set.id;
}

const READ_ONLY_KEYS = ['team_lead', 'qa_analyst', 'programme_manager', 'client_portal'] as const;

/** Unique per run so a probe name never matches an earlier, unreseeded run. */
const RUN = Date.now().toString(36);
let sequence = 0;
const unique = (label: string) => `${label} ${RUN}-${(sequence += 1)}`;

/** T-0040's columns this suite plants or relies on (S5). */
const T0040_COLUMNS = [
  'owner_user_id',
  'status',
  'source',
  'tags',
  'preferred_language',
  'preferred_channel',
  'state',
  'lga',
  'dnd',
  'whatsapp_opt_in',
  'consent_state',
  'phone_network',
  'account_id',
  'version',
] as const;

// ---------------------------------------------------------------------------
// A small JSON-Schema checker over the published YAML (no new dependency).
// Supports exactly what records.openapi.yaml and admin's Error use: $ref
// (local and relative-file), type (incl. arrays), enum, oneOf, required,
// properties, additionalProperties: false, items, min/maxItems,
// min/maxLength, pattern, minimum/maximum, format uuid/date-time/email.
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

function atPointer(doc: unknown, fragment: string): unknown {
  let node = doc;
  for (const raw of fragment.replace(/^\//, '').split('/')) {
    if (raw === '') continue;
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = (node as Json | undefined)?.[key];
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
  // The contract: "Times are UTC, ISO 8601, with a Z".
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

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path}: below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path}: above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path}: more than ${schema.maxItems} items`);
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} items`);
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

function schemaAt(pointer: string): Json {
  return { $ref: `#/components/schemas/${pointer}` };
}

/** Validates against a schema in records.openapi.yaml and fails with every error at once. */
function expectSchema(value: unknown, schemaName: string, where: string): void {
  const errors: string[] = [];
  check(schemaAt(schemaName), SPEC_PATH, value, where, errors);
  expect(errors, `${where} does not match #/components/schemas/${schemaName}`).toEqual([]);
}

/** Every property `Contact` names — read from the spec, not restated. */
function contactProperties(): string[] {
  const { schema } = deref(schemaAt('Contact'), SPEC_PATH);
  return Object.keys((schema.properties ?? {}) as Json);
}

/** Never withheld, per the Contact schema's description. */
const NEVER_WITHHELD = [
  'id',
  'programmeId',
  'version',
  'displayName',
  'createdAt',
  'updatedAt',
  'withheldFields',
];

/**
 * `Contact` plus the two readings in the header: no unnamed property, and
 * every property either present or withheld, exactly one of the two.
 */
function expectContact(value: unknown, where: string): Json {
  expectSchema(value, 'Contact', where);
  const contact = value as Json;
  const named = contactProperties();
  const extra = Object.keys(contact).filter((key) => !named.includes(key));
  expect(extra, `${where} carries properties the contract does not name`).toEqual([]);

  const withheld = Array.isArray(contact.withheldFields)
    ? (contact.withheldFields as string[])
    : [];
  const problems: string[] = [];
  for (const name of withheld) {
    if (NEVER_WITHHELD.includes(name)) problems.push(`${name} is never withheld`);
    if (name in contact) problems.push(`${name} is withheld but present (withheld means omitted)`);
    if (!named.includes(name)) problems.push(`${name} is not a Contact property`);
  }
  for (const name of named) {
    if (!(name in contact) && !withheld.includes(name)) {
      problems.push(`${name} is neither present nor listed in withheldFields`);
    }
  }
  expect(problems, `${where}: field-security omission rule`).toEqual([]);
  return contact;
}

function expectPage(value: unknown, where: string): { data: Json[]; nextCursor: string | null } {
  expectSchema(value, 'ContactPage', where);
  const page = value as { data: Json[]; nextCursor: string | null };
  // D-P13: no total, offset or page number. ContactPage is not closed, so say it.
  expect(
    Object.keys(page).sort(),
    `${where}: keyset page carries only data and nextCursor`,
  ).toEqual(['data', 'nextCursor']);
  page.data.forEach((row, index) => expectContact(row, `${where}.data[${index}]`));
  return page;
}

/** admin.openapi.yaml `Error`, with the status and `code` the operation names. */
function expectError(response: request.Response, status: number, code: string): Json {
  expect(
    response.status,
    `expected ${status} ${code}, got body ${JSON.stringify(response.body)}`,
  ).toBe(status);
  const errors: string[] = [];
  check(
    { $ref: './admin.openapi.yaml#/components/schemas/Error' },
    SPEC_PATH,
    response.body,
    'Error',
    errors,
  );
  expect(errors, 'response body does not match the shared Error schema').toEqual([]);
  const body = response.body as Json;
  expect(body.statusCode, 'Error.statusCode').toBe(status);
  expect(body.code, 'Error.code — clients switch on this, never on message').toBe(code);
  return body;
}

function detailsOf(body: Json): { path: string; code: string }[] {
  return Array.isArray(body.details) ? (body.details as { path: string; code: string }[]) : [];
}

const idsOf = (page: { data: Json[] }) => page.data.map((row) => row.id as string).sort();
const sorted = (ids: readonly string[]) => [...ids].sort();

// ---------------------------------------------------------------------------
// Log capture: every channel the process can write to (the T-0036 approach).
// ---------------------------------------------------------------------------

let captureLines: string[] | null = null;

function render(value: unknown): string {
  return typeof value === 'string'
    ? value
    : inspect(value, { depth: 12, breakLength: Number.POSITIVE_INFINITY });
}

/** The application logger: records raw arguments while a capture is open, prints nothing. */
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

/** Every form a phone or address can take on its way into a log line. */
function phoneForms(e164: string): string[] {
  const digits = e164.replace(/^\+/, '');
  // +234 803 ... -> 0803 ...: the national form a "helpful" normaliser logs.
  const national = digits.startsWith('234') ? `0${digits.slice(3)}` : digits;
  return [...new Set([e164, encodeURIComponent(e164), digits, national])];
}

function emailForms(address: string): string[] {
  const local = address.split('@')[0] ?? address;
  return [...new Set([address, encodeURIComponent(address), local])];
}

// ---------------------------------------------------------------------------

describe('acceptance: contacts API (T-0041)', () => {
  let app: INestApplication;
  /** kasuwa_migrator — BYPASSRLS. Plants values and observes rows; never serves. */
  let observer: Pool;
  /** T-0040 columns missing from `contact` on this database (S5). */
  let missingT0040: string[] = [];

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot(withAuthDatabase({ databaseUrl: inject('databaseUrl'), poolMax: 5 })),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: new RecordingLogger() });
    await app.init();
    observer = createPool({ connectionString: inject('migrationUrl'), max: 3 });

    const columns = await observer.query<{ column: string }>(
      `SELECT a.attname AS column
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'contact'
          AND a.attnum > 0 AND NOT a.attisdropped`,
    );
    const present = new Set(columns.rows.map((row) => row.column));
    missingT0040 = T0040_COLUMNS.filter((column) => !present.has(column));
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

  /** Fails with a clear message, never a SQL error, when T-0040 is absent (S5). */
  function requireT0040(): void {
    if (missingT0040.length > 0) {
      throw new Error(
        `T-0040 has not landed: contact is missing ${missingT0040.join(', ')}. ` +
          'This suite plants T-0040 values and cannot run without them.',
      );
    }
  }

  // --- HTTP helpers -------------------------------------------------------

  const list = (headers: Headers, params: readonly (readonly [string, string])[] = []) => {
    const query = new URLSearchParams(params.map(([k, v]): [string, string] => [k, v])).toString();
    return request(server())
      .get(query === '' ? CONTACTS : `${CONTACTS}?${query}`)
      .set(headers);
  };
  const getOne = (headers: Headers, id: string) =>
    request(server()).get(contactPath(id)).set(headers);
  const create = (headers: Headers, body: unknown) =>
    request(server())
      .post(CONTACTS)
      .set(headers)
      .send(body as object);
  const update = (headers: Headers, id: string, body: unknown) =>
    request(server())
      .patch(contactPath(id))
      .set(headers)
      .send(body as object);

  // --- observer helpers -----------------------------------------------------

  async function contactRow(id: string): Promise<Json | null> {
    const result = await observer.query<Json>('SELECT * FROM contact WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async function contactCount(): Promise<number> {
    const result = await observer.query<{ n: number }>('SELECT count(*)::int AS n FROM contact');
    return result.rows[0]?.n ?? -1;
  }

  async function contactsNamed(displayName: string): Promise<number> {
    const result = await observer.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM contact WHERE display_name = $1',
      [displayName],
    );
    return result.rows[0]?.n ?? -1;
  }

  async function versionOf(id: string): Promise<number> {
    const row = await contactRow(id);
    return Number(row?.version);
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
    changes: { field: string; before?: unknown; after?: unknown; redacted?: unknown }[];
  }

  async function auditIds(): Promise<Set<string>> {
    const result = await observer.query<{ id: string }>('SELECT id FROM audit_event');
    return new Set(result.rows.map((row) => row.id));
  }

  async function auditSince(before: Set<string>): Promise<AuditRow[]> {
    const result = await observer.query<AuditRow>('SELECT * FROM audit_event ORDER BY occurred_at');
    return result.rows.filter((row) => !before.has(row.id));
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

  async function setTenantAdmin(userId: string, value: boolean) {
    await observer.query('UPDATE "user" SET is_tenant_admin = $1 WHERE id = $2', [value, userId]);
  }

  /** S3: one field-security decision for tenant A's contact object. */
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

  /** Plants T-0040 values on one seeded contact. Only the columns named change. */
  async function plant(id: string, values: Record<string, unknown>) {
    const columns = Object.keys(values);
    const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
    await observer.query(`UPDATE contact SET ${assignments} WHERE id = $1`, [
      id,
      ...columns.map((column) => values[column]),
    ]);
  }

  /** A minimal valid create for a caller who must name the programme. */
  const createBody = (extra: Json = {}): Json => ({
    programmeId: PROGRAMME_A1,
    displayName: unique('T0041 Create'),
    ...extra,
  });

  // =========================================================================
  // 1. The wire matches the contract.
  // =========================================================================

  describe('the wire matches records.openapi.yaml', () => {
    it('(self-check) the schema checker accepts the contract’s own example and rejects broken copies of it', () => {
      // A checker only ever seen passing proves nothing. This one must pass
      // the spec's example and fail each single-fault mutant of it.
      const spec = loadDoc(SPEC_PATH) as {
        paths: Record<string, Record<string, Json>>;
      };
      const responses = spec.paths[CONTACTS]?.get?.responses as Json;
      const ok = ((responses['200'] as Json).content as Json)['application/json'] as Json;
      const example = ok.example as { data: Json[]; nextCursor: string | null };
      expectPage(example, 'contract example');

      const row = example.data[0] ?? {};
      const mutants: [string, Json][] = [
        ['a withheld field sent as null', { ...row, emails: null }],
        [
          'version missing',
          Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'version')),
        ],
        ['a display label as status', { ...row, status: 'Qualified' }],
        ['a non-E.164 phone', { ...row, phones: [{ type: 'mobile', e164: '08030000001' }] }],
        ['an unnamed property', { ...row, tenantId: TENANT_A }],
        [
          'a field neither present nor withheld',
          Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'tags')),
        ],
      ];
      for (const [label, mutant] of mutants) {
        let rejected = false;
        try {
          expectContact(mutant, label);
        } catch {
          rejected = true;
        }
        expect(rejected, `the checker accepted a Contact with ${label}`).toBe(true);
      }
    });

    it('listContacts returns a ContactPage: { data, nextCursor }, every row a Contact with version and withheldFields', async () => {
      const response = await list(AGENT_1).expect(200);
      const page = expectPage(response.body, 'listContacts');
      // Not vacuous: the seed gives agent 1 three rows to check.
      expect(page.data.length).toBe(3);
      for (const row of page.data) {
        expect(Number.isInteger(row.version), 'version is an integer').toBe(true);
        expect(Array.isArray(row.withheldFields), 'withheldFields is always present').toBe(true);
      }
    });

    it('getContact returns one Contact', async () => {
      const response = await getOne(AGENT_1, AMAKA.id).expect(200);
      const contact = expectContact(response.body, 'getContact');
      expect(contact.id).toBe(AMAKA.id);
      expect(contact.programmeId).toBe(PROGRAMME_A1);
      expect(contact.displayName).toBe(AMAKA.displayName);
    });

    it('createContact answers 201 with the created Contact, and the row exists', async () => {
      const body = createBody({
        phones: [{ type: 'mobile', e164: '+2348060041001' }],
        status: 'new',
        source: 'manual',
        preferredChannel: 'whatsapp',
      });
      const response = await create(SUPERVISOR, body);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const contact = expectContact(response.body, 'createContact');
      expect(contact.id).toMatch(UUID);
      expect(contact.programmeId).toBe(PROGRAMME_A1);
      expect(contact.displayName).toBe(body.displayName);
      expect(contact.status).toBe('new');
      expect(contact.source).toBe('manual');
      expect(contact.phones).toEqual([{ type: 'mobile', e164: '+2348060041001' }]);
      // Server-owned defaults (D-L61, ConsentState).
      expect(contact.dnd).toBe(false);
      expect(contact.consentState).toBe('unknown');

      const row = await contactRow(contact.id as string);
      expect(row, 'createContact answered 201 but no row was written').not.toBeNull();
      expect(row?.tenant_id).toBe(TENANT_A);
      expect(row?.programme_id).toBe(PROGRAMME_A1);
      expect(Number(row?.version)).toBe(contact.version);
    });

    it('updateContact answers 200 with the updated Contact', async () => {
      const before = expectContact((await getOne(SUPERVISOR, AMAKA.id).expect(200)).body, 'before');
      const response = await update(SUPERVISOR, AMAKA.id, {
        version: before.version,
        status: 'qualified',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const contact = expectContact(response.body, 'updateContact');
      expect(contact.status).toBe('qualified');
      expect(contact.id).toBe(AMAKA.id);
    });

    it('a contact out of reach is 404 with code not_found, the shared Error shape', async () => {
      expectError(await getOne(AGENT_1, NOWHERE), 404, 'not_found');
    });

    it('a malformed cursor is 400 validation_failed with details[].code invalid_cursor', async () => {
      const body = expectError(
        await list(AGENT_1, [['cursor', 'not-base64-json']]),
        400,
        'validation_failed',
      );
      expect(detailsOf(body)).toContainEqual({ path: 'cursor', code: 'invalid_cursor' });
    });

    it('a non-uuid contact id is 400 validation_failed', async () => {
      expectError(await getOne(AGENT_1, 'not-a-uuid'), 400, 'validation_failed');
    });

    it('limit out of range is 400 validation_failed, never clamped', async () => {
      expectError(await list(AGENT_1, [['limit', '0']]), 400, 'validation_failed');
      expectError(await list(AGENT_1, [['limit', '101']]), 400, 'validation_failed');
    });

    it('sort accepts only its enum: a free column name is 400, never an ordering by it', async () => {
      // Ordering by a field that can be withheld leaks it one comparison at a time.
      for (const sort of ['emails', 'phones', '-lga', 'given_names', 'id']) {
        expectError(await list(AGENT_1, [['sort', sort]]), 400, 'validation_failed');
      }
    });

    it('the spec marks createContact and updateContact implemented once they are', () => {
      // x-kasuwa-implemented: false tells T-0042 to stay on the mock. Shipping
      // the routes without flipping it leaves the screen on fake data.
      const spec = loadDoc(SPEC_PATH) as { paths: Record<string, Record<string, Json>> };
      expect(spec.paths[CONTACTS]?.post?.['x-kasuwa-implemented'], 'createContact').toBe(true);
      expect(
        spec.paths[`${CONTACTS}/{contactId}`]?.patch?.['x-kasuwa-implemented'],
        'updateContact',
      ).toBe(true);
    });
  });

  // =========================================================================
  // 2-3. Search, filters, sort and paging.
  // =========================================================================

  describe('search, filters, sort and paging', () => {
    beforeEach(async () => {
      requireT0040();
      // A1 (agent 1's programme): three distinct profiles.
      await plant(AMAKA.id, {
        owner_user_id: USER_A_AGENT_1,
        status: 'new',
        source: 'whatsapp',
        tags: ['VIP', 'Callback set'],
        state: 'Lagos',
        lga: 'Ikeja',
        dnd: true,
        whatsapp_opt_in: true,
      });
      await plant(BASHIR.id, {
        owner_user_id: USER_A_SUPERVISOR,
        status: 'qualified',
        source: 'manual',
        tags: ['Late payer'],
        state: 'Kano',
        lga: 'Nassarawa',
        dnd: false,
        whatsapp_opt_in: false,
      });
      await plant(CHIOMA.id, {
        owner_user_id: null,
        status: null,
        source: null,
        tags: [],
        state: null,
        lga: null,
        dnd: false,
        whatsapp_opt_in: true,
      });
      // A2 and tenant B: rows that match EVERY filter agent 1 tries. If any
      // appears in agent 1's results, scope leaked through the filter path.
      for (const id of [DAMILOLA.id, GRACE.id]) {
        await plant(id, {
          status: 'new',
          source: 'whatsapp',
          tags: ['VIP', 'Callback set'],
          state: 'Lagos',
          lga: 'Ikeja',
          dnd: true,
          whatsapp_opt_in: true,
        });
      }
      await plant(DAMILOLA.id, { owner_user_id: USER_A_AGENT_1 });
      await plant(GRACE.id, { owner_user_id: USER_B_AGENT_1 });
    });

    const agentIds = async (params: readonly (readonly [string, string])[]) => {
      const response = await list(AGENT_1, params);
      expect(response.status, `${JSON.stringify(params)}: ${JSON.stringify(response.body)}`).toBe(
        200,
      );
      return idsOf(expectPage(response.body, `list ${JSON.stringify(params)}`));
    };

    describe('q searches name or number', () => {
      it('matches a given name and a family name, case-insensitively', async () => {
        expect(await agentIds([['q', 'amaka']])).toEqual([AMAKA.id]);
        expect(await agentIds([['q', 'EZE']])).toEqual([CHIOMA.id]);
      });

      it('matches regardless of diacritics (the contract: Adebayo finds Adébáyọ̀)', async () => {
        await observer.query(
          `INSERT INTO contact (id, tenant_id, programme_id, display_name, given_names, family_name)
           VALUES ($1, $2, $3, 'Adébáyọ̀ Ògúnlẹ̀', 'Adébáyọ̀', 'Ògúnlẹ̀')`,
          [CONTACT_ADEBAYO, TENANT_A, PROGRAMME_A1],
        );
        expect(await agentIds([['q', 'Adebayo']])).toEqual([CONTACT_ADEBAYO]);
      });

      it.each([
        ['local, 0-prefixed', '08031234001'],
        ['local, spaced', '0803 123 4001'],
        ['international without +', '2348031234001'],
        ['E.164', '+2348031234001'],
        ['international, spaced', '+234 803 123 4001'],
      ])(
        'matches a phone written %s, normalised with the tenant default country',
        async (_label, q) => {
          expect(await agentIds([['q', q]])).toEqual([AMAKA.id]);
        },
      );

      it("normalises with THIS tenant's country: a Kenyan local number finds a +254 contact in tenant B", async () => {
        const response = await list(TENANT_B_USER, [['q', '0712 345 021']]).expect(200);
        expect(idsOf(expectPage(response.body, 'tenant B search'))).toEqual([GRACE.id]);
      });

      it('never searches outside scope: a name in A2 finds nothing for agent 1, and does for the supervisor', async () => {
        expect(await agentIds([['q', 'Damilola']])).toEqual([]);
        expect(await agentIds([['q', '+2348031234011']])).toEqual([]);
        // The control: the row exists and the search works for someone who reaches it.
        const response = await list(SUPERVISOR, [['q', 'Damilola']]).expect(200);
        expect(idsOf(expectPage(response.body, 'supervisor search'))).toEqual([DAMILOLA.id]);
      });

      it('treats LIKE and regex metacharacters literally, never as wildcards', async () => {
        for (const q of ['%', '_', '.*', '%a%']) {
          expect(await agentIds([['q', q]]), `q=${q}`).toEqual([]);
        }
      });

      it('rejects a q longer than 100 characters, and an empty q, with 400 validation_failed', async () => {
        expectError(await list(AGENT_1, [['q', 'a'.repeat(101)]]), 400, 'validation_failed');
        expectError(await list(AGENT_1, [['q', '']]), 400, 'validation_failed');
        // The boundary itself is allowed.
        await list(AGENT_1, [['q', 'a'.repeat(100)]]).expect(200);
      });
    });

    describe('each filter narrows, and only within scope', () => {
      it('owner: me, unassigned, a user id, and several (any of)', async () => {
        expect(await agentIds([['owner', 'me']])).toEqual([AMAKA.id]);
        expect(await agentIds([['owner', 'unassigned']])).toEqual([CHIOMA.id]);
        expect(await agentIds([['owner', USER_A_SUPERVISOR]])).toEqual([BASHIR.id]);
        expect(
          await agentIds([
            ['owner', 'me'],
            ['owner', 'unassigned'],
          ]),
        ).toEqual(sorted([AMAKA.id, CHIOMA.id]));
      });

      it('status, any of', async () => {
        expect(await agentIds([['status', 'new']])).toEqual([AMAKA.id]);
        expect(
          await agentIds([
            ['status', 'new'],
            ['status', 'qualified'],
          ]),
        ).toEqual(sorted([AMAKA.id, BASHIR.id]));
      });

      it('source, any of', async () => {
        expect(await agentIds([['source', 'manual']])).toEqual([BASHIR.id]);
        expect(await agentIds([['source', 'whatsapp']])).toEqual([AMAKA.id]);
      });

      it('tag: exact, case-insensitive, any of', async () => {
        expect(await agentIds([['tag', 'vip']])).toEqual([AMAKA.id]);
        expect(await agentIds([['tag', 'Callback set']])).toEqual([AMAKA.id]);
        expect(
          await agentIds([
            ['tag', 'VIP'],
            ['tag', 'late payer'],
          ]),
        ).toEqual(sorted([AMAKA.id, BASHIR.id]));
        // Exact, not substring.
        expect(await agentIds([['tag', 'Callback']])).toEqual([]);
      });

      it('state and lga: exact, case-insensitive', async () => {
        expect(await agentIds([['state', 'lagos']])).toEqual([AMAKA.id]);
        expect(await agentIds([['lga', 'NASSARAWA']])).toEqual([BASHIR.id]);
        expect(
          await agentIds([
            ['state', 'Lagos'],
            ['state', 'Kano'],
          ]),
        ).toEqual(sorted([AMAKA.id, BASHIR.id]));
      });

      it('dnd: true, false', async () => {
        expect(await agentIds([['dnd', 'true']])).toEqual([AMAKA.id]);
        expect(await agentIds([['dnd', 'false']])).toEqual(sorted([BASHIR.id, CHIOMA.id]));
      });

      it('whatsappOptIn: true, false', async () => {
        expect(await agentIds([['whatsappOptIn', 'true']])).toEqual(sorted([AMAKA.id, CHIOMA.id]));
        expect(await agentIds([['whatsappOptIn', 'false']])).toEqual([BASHIR.id]);
      });

      it('different filters combine with AND', async () => {
        expect(
          await agentIds([
            ['whatsappOptIn', 'true'],
            ['owner', 'unassigned'],
          ]),
        ).toEqual([CHIOMA.id]);
        expect(
          await agentIds([
            ['q', 'Amaka'],
            ['dnd', 'false'],
          ]),
        ).toEqual([]);
      });

      it('a value outside a filter’s schema is 400 validation_failed', async () => {
        for (const params of [
          [['status', 'Qualified']],
          [['source', 'Missed call']],
          [['owner', 'not-a-uuid']],
          [['dnd', 'maybe']],
          [['whatsappOptIn', 'yes please']],
        ] as const) {
          expectError(await list(AGENT_1, params), 400, 'validation_failed');
        }
      });

      it('a filtered page pages correctly with its cursor', async () => {
        const params = [
          ['status', 'new'],
          ['status', 'qualified'],
        ] as const;
        const first = await list(SUPERVISOR, [...params, ['limit', '2']]).expect(200);
        const firstPage = expectPage(first.body, 'filtered page 1');
        // A1: Amaka(new), Bashir(qualified); A2: Damilola(new). Supervisor reaches all three.
        expect(firstPage.data).toHaveLength(2);
        expect(firstPage.nextCursor).toEqual(expect.any(String));
        const second = await list(SUPERVISOR, [
          ...params,
          ['limit', '2'],
          ['cursor', firstPage.nextCursor ?? ''],
        ]).expect(200);
        const secondPage = expectPage(second.body, 'filtered page 2');
        expect(secondPage.nextCursor).toBeNull();
        expect(sorted([...idsOf(firstPage), ...idsOf(secondPage)])).toEqual(
          sorted([AMAKA.id, BASHIR.id, DAMILOLA.id]),
        );
      });
    });

    describe('sort', () => {
      beforeEach(async () => {
        // Break the correlation between name and creation order, so an
        // ignored `sort` cannot pass by coincidence.
        await plant(AMAKA.id, { display_name: 'Yetunde Obi', updated_at: '2026-03-01T00:00:00Z' });
        await plant(BASHIR.id, { updated_at: '2026-03-03T00:00:00Z' });
        await plant(CHIOMA.id, { updated_at: '2026-03-02T00:00:00Z' });
      });

      const order = async (sort: string) => {
        const response = await list(AGENT_1, [['sort', sort]]).expect(200);
        return expectPage(response.body, `sort=${sort}`).data.map((row) => row.id);
      };

      it('orders by each documented key, default -createdAt', async () => {
        expect(await order('displayName')).toEqual([BASHIR.id, CHIOMA.id, AMAKA.id]);
        expect(await order('-displayName')).toEqual([AMAKA.id, CHIOMA.id, BASHIR.id]);
        expect(await order('createdAt')).toEqual([AMAKA.id, BASHIR.id, CHIOMA.id]);
        expect(await order('-createdAt')).toEqual([CHIOMA.id, BASHIR.id, AMAKA.id]);
        expect(await order('updatedAt')).toEqual([AMAKA.id, CHIOMA.id, BASHIR.id]);
        expect(await order('-updatedAt')).toEqual([BASHIR.id, CHIOMA.id, AMAKA.id]);
        const unsorted = await list(AGENT_1).expect(200);
        expect(expectPage(unsorted.body, 'default').data.map((row) => row.id)).toEqual([
          CHIOMA.id,
          BASHIR.id,
          AMAKA.id,
        ]);
      });

      it('the keyset follows the sort: paging by displayName returns every row once, in name order', async () => {
        const first = expectPage(
          (
            await list(AGENT_1, [
              ['sort', 'displayName'],
              ['limit', '2'],
            ]).expect(200)
          ).body,
          'page 1',
        );
        expect(first.data.map((row) => row.id)).toEqual([BASHIR.id, CHIOMA.id]);
        const second = expectPage(
          (
            await list(AGENT_1, [
              ['sort', 'displayName'],
              ['limit', '2'],
              ['cursor', first.nextCursor ?? ''],
            ]).expect(200)
          ).body,
          'page 2',
        );
        expect(second.data.map((row) => row.id)).toEqual([AMAKA.id]);
        expect(second.nextCursor).toBeNull();
      });
    });
  });

  // =========================================================================
  // 4. Scope: 404 not 403, never a leak, never a client-supplied scope.
  // =========================================================================

  describe('scope', () => {
    it('get: another programme, another tenant and nowhere are one identical 404 body', async () => {
      const nowhere = await getOne(AGENT_1, NOWHERE);
      const sibling = await getOne(AGENT_1, DAMILOLA.id);
      const otherTenant = await getOne(AGENT_1, GRACE.id);
      expectError(nowhere, 404, 'not_found');
      expectError(sibling, 404, 'not_found');
      expectError(otherTenant, 404, 'not_found');
      expect(sibling.body).toEqual(nowhere.body);
      expect(otherTenant.body).toEqual(nowhere.body);
    });

    it('update: a tenant admin patching another tenant’s contact gets 404, and the row is untouched', async () => {
      requireT0040();
      const before = await contactRow(GRACE.id);
      const response = await update(SUPERVISOR, GRACE.id, { version: 1, displayName: 'Hijacked' });
      expectError(response, 404, 'not_found');
      expect(await contactRow(GRACE.id)).toEqual(before);
    });

    it('update: a programme admin patching a sibling programme’s contact gets 404, not 403', async () => {
      requireT0040();
      // Agent 2 holds `admin` in A2 only (not a tenant admin): permitted to
      // write, but A1 is not in scope. 404 must win over any permission answer.
      await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A2, 'admin');
      const before = await contactRow(AMAKA.id);
      const response = await update(AGENT_2, AMAKA.id, { version: 1, displayName: 'Hijacked' });
      expectError(response, 404, 'not_found');
      expect(await contactRow(AMAKA.id)).toEqual(before);
      // The same caller with no permission at all on a reachable record would
      // be 403; an unreachable one is 404 whoever asks (D-L53 order).
      expectError(
        await update(AGENT_1, DAMILOLA.id, { version: 1, status: 'new' }),
        404,
        'not_found',
      );
    });

    it('list never includes out-of-scope rows', async () => {
      const agent = expectPage(
        (await list(AGENT_1, [['limit', '100']]).expect(200)).body,
        'agent 1',
      );
      expect(idsOf(agent)).toEqual(sorted(idsIn(PROGRAMME_A1)));
      const none = expectPage((await list(NO_PROGRAMME).expect(200)).body, 'no programme');
      expect(none.data).toEqual([]);
      expect(none.nextCursor).toBeNull();
    });

    it('create: an unreachable programmeId is 404 — sibling, other tenant, nowhere — one body, nothing written', async () => {
      // Agent 1 is made a writer in A1 so the refusal can only be about scope.
      await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'admin');
      const count = await contactCount();
      const bodies: Json[] = [];
      for (const programmeId of [PROGRAMME_A2, PROGRAMME_B1, NOWHERE]) {
        const response = await create(AGENT_1, createBody({ programmeId }));
        bodies.push(expectError(response, 404, 'not_found'));
      }
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
      expect(await contactCount()).toBe(count);
    });

    it('create without programmeId: 400 at programmeId when the caller reaches several, the one programme when they reach one', async () => {
      const name = unique('T0041 NoTarget');
      const several = await create(SUPERVISOR, { displayName: name });
      const body = expectError(several, 400, 'validation_failed');
      expect(detailsOf(body).map((detail) => detail.path)).toContain('programmeId');
      expect(await contactsNamed(name)).toBe(0);

      await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'admin');
      const one = await create(AGENT_1, { displayName: name });
      expect(one.status, JSON.stringify(one.body)).toBe(201);
      expect(expectContact(one.body, 'single-programme create').programmeId).toBe(PROGRAMME_A1);
    });

    it('create by a user who reaches no programme writes nothing', async () => {
      // The contract names only "exactly one" and "several". Zero is either
      // 400 (no target) or 404 (an unreachable target); both are acceptable,
      // a write is not.
      const name = unique('T0041 Orphan');
      const response = await create(NO_PROGRAMME, { displayName: name });
      expect([400, 404]).toContain(response.status);
      expectError(
        response,
        response.status,
        response.status === 400 ? 'validation_failed' : 'not_found',
      );
      expect(await contactsNamed(name)).toBe(0);
      const targeted = await create(NO_PROGRAMME, { programmeId: PROGRAMME_A1, displayName: name });
      expectError(targeted, 404, 'not_found');
      expect(await contactsNamed(name)).toBe(0);
    });

    it('scope headers are rejected on every contact route with 400 validation_failed, and nothing is written', async () => {
      const name = unique('T0041 Header');
      const before = await contactRow(AMAKA.id);
      for (const [header, value] of [
        ['x-kasuwa-programme-ids', `{${PROGRAMME_A2}}`],
        ['x-kasuwa-programme-id', PROGRAMME_A2],
        ['x-kasuwa-scope', 'all'],
      ] as const) {
        expectError(await list(AGENT_1).set(header, value), 400, 'validation_failed');
        expectError(
          await getOne(AGENT_1, DAMILOLA.id).set(header, value),
          400,
          'validation_failed',
        );
        expectError(
          await create(SUPERVISOR, createBody({ displayName: name })).set(header, value),
          400,
          'validation_failed',
        );
        expectError(
          await update(SUPERVISOR, AMAKA.id, { version: 1, displayName: name }).set(header, value),
          400,
          'validation_failed',
        );
      }
      expect(await contactsNamed(name)).toBe(0);
      expect(await contactRow(AMAKA.id)).toEqual(before);
    });

    it('a body cannot carry scope: tenantId on create, programmeId on update, are 400 and change nothing', async () => {
      requireT0040();
      const name = unique('T0041 Smuggle');
      expectError(
        await create(SUPERVISOR, createBody({ displayName: name, tenantId: TENANT_B })),
        400,
        'validation_failed',
      );
      expect(await contactsNamed(name)).toBe(0);

      const before = await contactRow(AMAKA.id);
      expectError(
        await update(SUPERVISOR, AMAKA.id, {
          version: Number(before?.version),
          programmeId: PROGRAMME_A2,
        }),
        400,
        'validation_failed',
      );
      expect(await contactRow(AMAKA.id)).toEqual(before);
    });

    it('a reference to another tenant’s user, or another programme’s account, is indistinguishable from one that does not exist', async () => {
      requireT0040();
      await observer.query(
        `INSERT INTO account (id, tenant_id, programme_id, name) VALUES ($1, $2, $3, $4)`,
        [ACCOUNT_A2, TENANT_A, PROGRAMME_A2, 'T0041 A2 account'],
      );
      // Agent 1 writes in A1 only.
      await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'admin');
      const before = await contactRow(AMAKA.id);
      const version = Number(before?.version);

      const realOwner = await update(AGENT_1, AMAKA.id, { version, ownerUserId: USER_B_AGENT_1 });
      const fakeOwner = await update(AGENT_1, AMAKA.id, { version, ownerUserId: NOWHERE });
      const realAccount = await update(AGENT_1, AMAKA.id, { version, accountId: ACCOUNT_A2 });
      const fakeAccount = await update(AGENT_1, AMAKA.id, { version, accountId: NOWHERE });

      for (const response of [realOwner, fakeOwner, realAccount, fakeAccount]) {
        expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(400);
        // Never a 500 (an unmapped FK violation) and never a success.
        expect(response.status, JSON.stringify(response.body)).toBeLessThan(500);
      }
      expect(realOwner.status).toBe(fakeOwner.status);
      expect(realOwner.body).toEqual(fakeOwner.body);
      expect(realAccount.status).toBe(fakeAccount.status);
      expect(realAccount.body).toEqual(fakeAccount.body);
      expect(await contactRow(AMAKA.id)).toEqual(before);

      // The control, without which every assertion above passes on a server
      // that has no PATCH route at all (four identical 404s): a reference
      // that IS reachable is accepted.
      const legitimate = await update(AGENT_1, AMAKA.id, {
        version,
        ownerUserId: USER_A_SUPERVISOR,
      });
      expect(legitimate.status, JSON.stringify(legitimate.body)).toBe(200);
      expect(expectContact(legitimate.body, 'legitimate owner').ownerUserId).toBe(
        USER_A_SUPERVISOR,
      );
    });
  });

  // =========================================================================
  // 5. Permissions (S1).
  // =========================================================================

  describe('permissions: writes need contact.write in the target programme', () => {
    // D-P14 (answered 2026-10-04) replaces "the agent set may not write", as S1
    // foresaw. The agent set may change `status`, and may assign the owner to
    // THEMSELVES, on contacts in a programme where they hold it, and nothing
    // else: no create, no other field, no other owner, no clearing the owner.
    // A refused body is refused whole; nothing in it is written.
    describe('the agent set (D-P14): status, and owner to self, nothing else', () => {
      /** Every column the agent did not ask to change, as the observer sees it. */
      const untouched = (row: Json | null, changed: readonly string[]) =>
        Object.fromEntries(
          Object.entries(row ?? {}).filter(
            ([column]) => ![...changed, 'version', 'updated_at'].includes(column),
          ),
        );

      it('may not create: 403 not_permitted, nothing written', async () => {
        requireT0040();
        const name = unique('T0041 AgentCreate');
        expectError(await create(AGENT_1, createBody({ displayName: name })), 403, 'not_permitted');
        expect(await contactsNamed(name)).toBe(0);
      });

      it('may change status in its own programme: 200, and only status moves', async () => {
        requireT0040();
        await plant(AMAKA.id, { status: 'new' });
        const before = await contactRow(AMAKA.id);
        const auditBefore = await auditIds();
        const response = await update(AGENT_1, AMAKA.id, {
          version: Number(before?.version),
          status: 'contacted',
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(expectContact(response.body, 'agent status').status).toBe('contacted');

        // An agent's write is audited like any other (S2), as the agent.
        const events = await auditSince(auditBefore);
        expect(events, 'an agent update writes exactly one audit event').toHaveLength(1);
        expect(events[0]).toMatchObject({
          actor_kind: 'user',
          actor_user_id: USER_A_AGENT_1,
          action: 'updated',
          object_type: 'contact',
          object_id: AMAKA.id,
          programme_id: PROGRAMME_A1,
        });
        expect(events[0]?.changes.map((change) => change.field)).toEqual(['status']);

        const after = await contactRow(AMAKA.id);
        expect(after?.status).toBe('contacted');
        expect(Number(after?.version)).toBe(Number(before?.version) + 1);
        expect(untouched(after, ['status'])).toEqual(untouched(before, ['status']));
      });

      it('may assign the owner to themselves, taking it from another member: 200', async () => {
        requireT0040();
        await plant(AMAKA.id, { owner_user_id: USER_A_SUPERVISOR });
        const before = await contactRow(AMAKA.id);
        const response = await update(AGENT_1, AMAKA.id, {
          version: Number(before?.version),
          ownerUserId: USER_A_AGENT_1,
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(expectContact(response.body, 'agent owner').ownerUserId).toBe(USER_A_AGENT_1);

        const after = await contactRow(AMAKA.id);
        expect(after?.owner_user_id).toBe(USER_A_AGENT_1);
        expect(untouched(after, ['owner_user_id'])).toEqual(untouched(before, ['owner_user_id']));
      });

      it('may set status and own the record in one request: 200', async () => {
        requireT0040();
        await plant(AMAKA.id, { status: 'new', owner_user_id: null });
        const before = await contactRow(AMAKA.id);
        const response = await update(AGENT_1, AMAKA.id, {
          version: Number(before?.version),
          status: 'qualified',
          ownerUserId: USER_A_AGENT_1,
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const after = await contactRow(AMAKA.id);
        expect(after?.status).toBe('qualified');
        expect(after?.owner_user_id).toBe(USER_A_AGENT_1);
      });

      it.each([
        // A reachable member of the same programme: the D-L67 rule would accept
        // this owner from an admin, so a refusal here is the agent rule.
        ['another member as owner', { ownerUserId: USER_A_SUPERVISOR }],
        ['clearing the owner', { ownerUserId: null }],
        ['displayName', { displayName: 'T0041 Agent Rename' }],
        ['familyName', { familyName: 'Agent' }],
        ['phones', { phones: [{ type: 'mobile', e164: '+2348039990001' }] }],
        ['tags', { tags: ['agent-tag'] }],
        ['consentState', { consentState: 'opted_in' }],
        ['accountId', { accountId: null }],
        ['status alongside a field it may not write', { status: 'customer', lga: 'Ikeja' }],
        ['owner to self alongside a field it may not write', {
          ownerUserId: USER_A_AGENT_1,
          tags: ['agent-tag'],
        }],
      ])('may not write %s: 403 not_permitted, nothing written', async (_label, fields) => {
        requireT0040();
        await plant(AMAKA.id, { status: 'new', owner_user_id: USER_A_AGENT_1 });
        const before = await contactRow(AMAKA.id);
        expectError(
          await update(AGENT_1, AMAKA.id, { version: Number(before?.version), ...fields }),
          403,
          'not_permitted',
        );
        expect(await contactRow(AMAKA.id)).toEqual(before);
      });

      it('stops at the programme boundary: a contact in a programme it is not in is 404', async () => {
        requireT0040();
        // Agent 1 holds the agent set in A1 only; Damilola is in A2.
        const before = await contactRow(DAMILOLA.id);
        expectError(
          await update(AGENT_1, DAMILOLA.id, {
            version: Number(before?.version),
            status: 'contacted',
          }),
          404,
          'not_found',
        );
        expect(await contactRow(DAMILOLA.id)).toEqual(before);
      });
    });

    it.each(READ_ONLY_KEYS)(
      'the %s set may not write: 403 not_permitted, nothing written',
      async (key) => {
        requireT0040();
        await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, key);
        const name = unique(`T0041 ${key}`);
        expectError(await create(AGENT_1, createBody({ displayName: name })), 403, 'not_permitted');
        expect(await contactsNamed(name)).toBe(0);

        const before = await contactRow(AMAKA.id);
        expectError(
          await update(AGENT_1, AMAKA.id, { version: Number(before?.version), status: 'customer' }),
          403,
          'not_permitted',
        );
        expect(await contactRow(AMAKA.id)).toEqual(before);
      },
    );

    it('the admin set held in the programme permits both writes, without the tenant-admin flag', async () => {
      requireT0040();
      await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'admin');
      const created = await create(AGENT_1, createBody());
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const version = await versionOf(AMAKA.id);
      const updated = await update(AGENT_1, AMAKA.id, { version, status: 'customer' });
      expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    });

    it('the permission is per programme: admin in A2 does not permit writing in A1', async () => {
      requireT0040();
      // The supervisor stripped to a plain member: read-only in A1, admin in A2.
      // team_lead, not agent: since D-P14 the agent set may change status.
      await setTenantAdmin(USER_A_SUPERVISOR, false);
      await assign(TENANT_A, USER_A_SUPERVISOR, PROGRAMME_A1, 'team_lead');
      await assign(TENANT_A, USER_A_SUPERVISOR, PROGRAMME_A2, 'admin');

      expectError(
        await create(SUPERVISOR, createBody({ programmeId: PROGRAMME_A1 })),
        403,
        'not_permitted',
      );
      const inA2 = await create(SUPERVISOR, createBody({ programmeId: PROGRAMME_A2 }));
      expect(inA2.status, JSON.stringify(inA2.body)).toBe(201);

      expectError(
        await update(SUPERVISOR, AMAKA.id, {
          version: await versionOf(AMAKA.id),
          status: 'customer',
        }),
        403,
        'not_permitted',
      );
      const a2 = await update(SUPERVISOR, EFE.id, {
        version: await versionOf(EFE.id),
        status: 'customer',
      });
      expect(a2.status, JSON.stringify(a2.body)).toBe(200);
    });

    it('the decision is re-read on every request: a revoked set refuses the very next write', async () => {
      requireT0040();
      await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'admin');
      const first = await update(AGENT_1, AMAKA.id, {
        version: await versionOf(AMAKA.id),
        status: 'contacted',
      });
      expect(first.status, JSON.stringify(first.body)).toBe(200);

      // Revoked to a read-only set. Not agent: since D-P14 it may change status.
      await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'team_lead');
      expectError(
        await update(AGENT_1, AMAKA.id, { version: await versionOf(AMAKA.id), status: 'customer' }),
        403,
        'not_permitted',
      );
    });

    it('403 comes before 400: an unpermitted caller learns nothing from validation (D-L53)', async () => {
      requireT0040();
      expectError(
        await create(AGENT_1, { programmeId: PROGRAMME_A1, displayName: '', dnd: true, bogus: 1 }),
        403,
        'not_permitted',
      );
      expectError(
        await update(AGENT_1, AMAKA.id, {
          version: await versionOf(AMAKA.id),
          phones: [{ type: 'x', e164: '0803' }],
        }),
        403,
        'not_permitted',
      );
    });
  });

  // =========================================================================
  // 6. Optimistic concurrency.
  // =========================================================================

  describe('optimistic concurrency', () => {
    beforeEach(() => {
      requireT0040();
    });

    it('a successful update bumps version by exactly 1, in the response and the row', async () => {
      const before = await versionOf(AMAKA.id);
      const read = expectContact((await getOne(SUPERVISOR, AMAKA.id).expect(200)).body, 'read');
      expect(read.version, 'getContact serves the stored version').toBe(before);

      const response = await update(SUPERVISOR, AMAKA.id, { version: before, status: 'contacted' });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const contact = expectContact(response.body, 'updated');
      expect(contact.version).toBe(before + 1);
      expect(await versionOf(AMAKA.id)).toBe(before + 1);
      expect(Date.parse(contact.updatedAt as string)).toBeGreaterThan(
        Date.parse(read.updatedAt as string),
      );
    });

    it('a stale version is 409 stale_write and nothing is applied', async () => {
      const version = await versionOf(AMAKA.id);
      const first = await update(SUPERVISOR, AMAKA.id, { version, status: 'contacted' });
      expect(first.status, JSON.stringify(first.body)).toBe(200);

      const before = await contactRow(AMAKA.id);
      expectError(
        await update(SUPERVISOR, AMAKA.id, { version, status: 'customer' }),
        409,
        'stale_write',
      );
      // A version from the future is just as stale.
      expectError(
        await update(SUPERVISOR, AMAKA.id, { version: version + 5, status: 'customer' }),
        409,
        'stale_write',
      );
      expect(await contactRow(AMAKA.id)).toEqual(before);
    });

    it('version is required, and an update must change something', async () => {
      const before = await contactRow(AMAKA.id);
      expectError(
        await update(SUPERVISOR, AMAKA.id, { status: 'customer' }),
        400,
        'validation_failed',
      );
      expectError(
        await update(SUPERVISOR, AMAKA.id, { version: Number(before?.version) }),
        400,
        'validation_failed',
      );
      expect(await contactRow(AMAKA.id)).toEqual(before);
    });

    it('concurrent updates with the same version: exactly one succeeds, the rest are 409', async () => {
      // Deterministic for a correct implementation (a conditional UPDATE on
      // version, or a row lock): exactly one can win however the five
      // interleave. A read-check-write without either is likely, not certain,
      // to let two through; this is a detector for that, not a proof.
      const version = await versionOf(AMAKA.id);
      const statuses = ['new', 'contacted', 'qualified', 'unqualified', 'customer'];
      const audit = await auditIds();
      const responses = await Promise.all(
        statuses.map((status) => update(SUPERVISOR, AMAKA.id, { version, status })),
      );
      const codes = responses.map((response) => response.status).sort();
      expect(codes, responses.map((r) => JSON.stringify(r.body)).join('\n')).toEqual([
        200, 409, 409, 409, 409,
      ]);
      for (const loser of responses.filter((response) => response.status === 409)) {
        expectError(loser, 409, 'stale_write');
      }
      const winner = responses.find((response) => response.status === 200);
      const row = await contactRow(AMAKA.id);
      expect(Number(row?.version)).toBe(version + 1);
      expect(row?.status).toBe((winner?.body as Json).status);
      expect(
        (await auditSince(audit)).filter((event) => event.object_id === AMAKA.id),
      ).toHaveLength(1);
    });
  });

  // =========================================================================
  // 7. Field security (S3).
  // =========================================================================

  describe('field security: omitted, never nulled', () => {
    const PROBE_EMAIL = 'amaka.fls-probe.t0041@example.test';

    beforeEach(async () => {
      requireT0040();
      await plant(AMAKA.id, { emails: JSON.stringify([PROBE_EMAIL]) });
      await lockField('emails', 'agent', 'none');
    });

    it('list and get omit a withheld field and name it in withheldFields; the admin set still sees it', async () => {
      const page = expectPage((await list(AGENT_1).expect(200)).body, 'agent list');
      expect(page.data.length).toBe(3);
      for (const row of page.data) {
        expect('emails' in row, `${String(row.id)}: emails must be omitted, not nulled`).toBe(
          false,
        );
        expect(row.withheldFields).toContain('emails');
        expect('phones' in row, 'a field that is not withheld is still sent').toBe(true);
      }
      const one = expectContact((await getOne(AGENT_1, AMAKA.id).expect(200)).body, 'agent get');
      expect('emails' in one).toBe(false);
      expect(one.withheldFields).toContain('emails');
      expect(JSON.stringify(page) + JSON.stringify(one)).not.toContain(PROBE_EMAIL);

      // The control: the value is really there for someone allowed to read it.
      const admin = expectContact(
        (await getOne(SUPERVISOR, AMAKA.id).expect(200)).body,
        'admin get',
      );
      expect(admin.emails).toEqual([PROBE_EMAIL]);
      expect(admin.withheldFields).not.toContain('emails');
    });

    it('withholding is decided per row, by the set held in THAT row’s programme', async () => {
      // Agent 2: agent in A2 (emails withheld), admin in A1 (never withheld).
      await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A1, 'admin');
      const page = expectPage((await list(AGENT_2, [['limit', '100']]).expect(200)).body, 'mixed');
      const a1 = page.data.filter((row) => row.programmeId === PROGRAMME_A1);
      const a2 = page.data.filter((row) => row.programmeId === PROGRAMME_A2);
      expect(a1.length).toBe(3);
      expect(a2.length).toBe(3);
      for (const row of a1) expect(row.withheldFields).not.toContain('emails');
      for (const row of a2) expect(row.withheldFields).toContain('emails');
    });

    it('a filter on a withheld field is 400 field_withheld; the same filter is fine for the admin set', async () => {
      await lockField('lga', 'agent', 'none');
      const body = expectError(await list(AGENT_1, [['lga', 'Ikeja']]), 400, 'validation_failed');
      expect(detailsOf(body)).toContainEqual({ path: 'lga', code: 'field_withheld' });
      await list(SUPERVISOR, [['lga', 'Ikeja']]).expect(200);
    });

    it('q never matches a field the caller cannot read: a number finds nothing when phones are withheld', async () => {
      await lockField('phones', 'agent', 'none');
      const byNumber = expectPage(
        (await list(AGENT_1, [['q', '08031234001']]).expect(200)).body,
        'by number',
      );
      expect(byNumber.data, 'searching a withheld phone is an oracle for its value').toEqual([]);
      const byName = expectPage(
        (await list(AGENT_1, [['q', 'Amaka']]).expect(200)).body,
        'by name',
      );
      expect(idsOf(byName)).toEqual([AMAKA.id]);
      expect('phones' in (byName.data[0] ?? {})).toBe(false);
      // The control: the number search works where phones are readable.
      const admin = expectPage(
        (await list(SUPERVISOR, [['q', '08031234001']]).expect(200)).body,
        'admin',
      );
      expect(idsOf(admin)).toEqual([AMAKA.id]);
    });

    describe('a writer with a withheld field (tenant admin holding the agent set in A1)', () => {
      beforeEach(async () => {
        // S1 lets the tenant-admin flag write; S3 says the flag does not lift
        // field security, so the set held in A1 (agent) still withholds emails.
        await setTenantAdmin(USER_A_AGENT_1, true);
      });

      it('create and update responses omit the withheld field too', async () => {
        const created = await create(AGENT_1, createBody());
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const contact = expectContact(created.body, 'create');
        expect('emails' in contact).toBe(false);
        expect(contact.withheldFields).toContain('emails');

        const updated = await update(AGENT_1, AMAKA.id, {
          version: await versionOf(AMAKA.id),
          status: 'contacted',
        });
        expect(updated.status, JSON.stringify(updated.body)).toBe(200);
        const after = expectContact(updated.body, 'update');
        expect('emails' in after).toBe(false);
        expect(after.withheldFields).toContain('emails');
        expect(JSON.stringify(after)).not.toContain(PROBE_EMAIL);
      });

      it('setting a withheld field is 403 not_permitted naming it (field_not_editable); clearing it too; nothing written', async () => {
        const name = unique('T0041 FlsCreate');
        const createRefused = expectError(
          await create(
            AGENT_1,
            createBody({ displayName: name, emails: ['someone.t0041@example.test'] }),
          ),
          403,
          'not_permitted',
        );
        expect(detailsOf(createRefused)).toContainEqual({
          path: 'emails',
          code: 'field_not_editable',
        });
        expect(await contactsNamed(name)).toBe(0);

        const before = await contactRow(AMAKA.id);
        const updateRefused = expectError(
          await update(AGENT_1, AMAKA.id, { version: Number(before?.version), emails: [] }),
          403,
          'not_permitted',
        );
        expect(detailsOf(updateRefused)).toContainEqual({
          path: 'emails',
          code: 'field_not_editable',
        });
        expect(await contactRow(AMAKA.id)).toEqual(before);
      });

      it('a read-only field is readable and still may not be written', async () => {
        await lockField('emails', 'agent', 'read');
        const read = expectContact(
          (await getOne(AGENT_1, AMAKA.id).expect(200)).body,
          'read level',
        );
        expect(read.emails).toEqual([PROBE_EMAIL]);
        const before = await contactRow(AMAKA.id);
        const refused = expectError(
          await update(AGENT_1, AMAKA.id, {
            version: Number(before?.version),
            emails: ['x.t0041@example.test'],
          }),
          403,
          'not_permitted',
        );
        expect(detailsOf(refused)).toContainEqual({ path: 'emails', code: 'field_not_editable' });
        expect(await contactRow(AMAKA.id)).toEqual(before);
      });
    });
  });

  // =========================================================================
  // 8. Read-only fields, closed bodies, E.164.
  // =========================================================================

  describe('closed bodies: server-owned fields and non-E.164 phones are 400', () => {
    beforeEach(() => {
      requireT0040();
    });

    it.each([
      ['dnd', { dnd: false }],
      ['phoneNetwork', { phoneNetwork: 'MTN' }],
      ['id', { id: NOWHERE }],
      ['version', { version: 1 }],
      ['createdAt', { createdAt: '2026-01-01T00:00:00Z' }],
      ['withheldFields', { withheldFields: [] }],
      ['an unknown property', { nickname: 'Ada' }],
    ])('create with %s is 400 and writes nothing', async (_label, extra) => {
      const name = unique('T0041 Closed');
      expectError(
        await create(SUPERVISOR, createBody({ displayName: name, ...extra })),
        400,
        'validation_failed',
      );
      expect(await contactsNamed(name)).toBe(0);
    });

    it('update cannot clear DND, set phoneNetwork or change source: 400, row unchanged', async () => {
      await plant(AMAKA.id, { dnd: true, phone_network: null, source: 'whatsapp' });
      const before = await contactRow(AMAKA.id);
      const version = Number(before?.version);
      for (const body of [
        { version, dnd: false },
        { version, phoneNetwork: 'Airtel' },
        { version, source: 'manual' },
        { version, updatedAt: '2026-01-01T00:00:00Z' },
      ]) {
        expectError(await update(SUPERVISOR, AMAKA.id, body), 400, 'validation_failed');
      }
      expect(await contactRow(AMAKA.id)).toEqual(before);
    });

    it.each(['08031234567', '+234 803 123 4567', '2348031234567', '+0803123456', 'not-a-number'])(
      'a phone written as %s is 400 at phones.0.e164, on create and on update',
      async (e164) => {
        const name = unique('T0041 Phone');
        const created = expectError(
          await create(
            SUPERVISOR,
            createBody({ displayName: name, phones: [{ type: 'mobile', e164 }] }),
          ),
          400,
          'validation_failed',
        );
        expect(detailsOf(created).map((detail) => detail.path)).toContain('phones.0.e164');
        expect(await contactsNamed(name)).toBe(0);
        // Paths and reason codes only — never the submitted value (Error.details).
        expect(JSON.stringify(created)).not.toContain(e164);

        const before = await contactRow(AMAKA.id);
        expectError(
          await update(SUPERVISOR, AMAKA.id, {
            version: Number(before?.version),
            phones: [{ type: 'mobile', e164 }],
          }),
          400,
          'validation_failed',
        );
        expect(await contactRow(AMAKA.id)).toEqual(before);
      },
    );

    it('value sets are the D-L61 codes: a display label is 400', async () => {
      for (const extra of [
        { status: 'Qualified' },
        { source: 'Missed call' },
        { consentState: 'Opted in' },
      ]) {
        expectError(await create(SUPERVISOR, createBody(extra)), 400, 'validation_failed');
      }
    });
  });

  // =========================================================================
  // 9. Audit (S2).
  // =========================================================================

  describe('audit: one event per successful write, no PII in it', () => {
    const PHONE = '+2348069041041';
    const EMAIL = 'tunde.audit-probe.t0041@example.test';
    const NEW_PHONE = '+2348069041042';
    const NEW_EMAIL = 'tunde.audit-probe2.t0041@example.test';

    beforeEach(() => {
      requireT0040();
    });

    function expectNoContactPii(event: AuditRow, values: { phones: string[]; emails: string[] }) {
      const haystack = JSON.stringify(event);
      for (const phone of values.phones) {
        for (const form of phoneForms(phone)) {
          expect(haystack, `audit event carries the phone (as "${form}")`).not.toContain(form);
        }
      }
      for (const email of values.emails) {
        for (const form of emailForms(email)) {
          expect(haystack, `audit event carries the email (as "${form}")`).not.toContain(form);
        }
      }
    }

    function expectRedacted(event: AuditRow, field: string) {
      const change = event.changes.find((candidate) => candidate.field === field);
      expect(change, `no ${field} change recorded (D-L54: a redacted change)`).toBeDefined();
      expect(change?.redacted, `${field} change must be redacted`).toBe(true);
      expect(change?.before ?? null, `${field}: redacted, so before is null`).toBeNull();
      expect(change?.after ?? null, `${field}: redacted, so after is null`).toBeNull();
    }

    it('a create records exactly one `created` event by the session user, in the contact’s programme', async () => {
      const before = await auditIds();
      const response = await create(
        SUPERVISOR,
        createBody({ phones: [{ type: 'mobile', e164: PHONE }], emails: [EMAIL], status: 'new' }),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const id = (response.body as Json).id as string;

      const events = await auditSince(before);
      expect(events, 'exactly one event per successful write').toHaveLength(1);
      const [event] = events;
      expect(event).toMatchObject({
        tenant_id: TENANT_A,
        actor_kind: 'user',
        actor_user_id: USER_A_SUPERVISOR,
        action: 'created',
        object_type: 'contact',
        object_id: id,
        programme_id: PROGRAMME_A1,
      });
      if (event === undefined) return;
      expectRedacted(event, 'phones');
      expectRedacted(event, 'emails');
      expectNoContactPii(event, { phones: [PHONE], emails: [EMAIL] });
    });

    it('an update records exactly one `updated` event naming the changed fields, phones and emails redacted', async () => {
      await plant(AMAKA.id, {
        phones: JSON.stringify([{ type: 'mobile', e164: PHONE }]),
        emails: JSON.stringify([EMAIL]),
      });
      // A programme admin who is not a tenant admin, so the actor is unambiguous.
      await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'admin');
      const before = await auditIds();
      const response = await update(AGENT_1, AMAKA.id, {
        version: await versionOf(AMAKA.id),
        status: 'qualified',
        phones: [{ type: 'mobile', e164: NEW_PHONE }],
        emails: [NEW_EMAIL],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      const events = await auditSince(before);
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event).toMatchObject({
        actor_kind: 'user',
        actor_user_id: USER_A_AGENT_1,
        action: 'updated',
        object_type: 'contact',
        object_id: AMAKA.id,
        programme_id: PROGRAMME_A1,
      });
      if (event === undefined) return;
      expect(event.changes.map((change) => change.field)).toContain('status');
      expectRedacted(event, 'phones');
      expectRedacted(event, 'emails');
      expectNoContactPii(event, { phones: [PHONE, NEW_PHONE], emails: [EMAIL, NEW_EMAIL] });
    });

    it('a refused write records nothing: 400, 403, 404 and 409', async () => {
      const version = await versionOf(AMAKA.id);
      await update(SUPERVISOR, AMAKA.id, { version, status: 'contacted' }).expect(200);
      const before = await auditIds();

      const refusals = [
        await create(SUPERVISOR, createBody({ dnd: true })), // 400
        await create(AGENT_1, createBody()), // 403
        // A field outside the D-P14 agent grant (status and self-ownership only).
        await update(AGENT_1, AMAKA.id, { version: version + 1, tags: ['t0041-refused'] }), // 403
        await update(SUPERVISOR, GRACE.id, { version: 1, status: 'customer' }), // 404
        await create(SUPERVISOR, createBody({ programmeId: PROGRAMME_B1 })), // 404
        await update(SUPERVISOR, AMAKA.id, { version, status: 'customer' }), // 409
      ];
      expect(refusals.map((response) => response.status)).toEqual([400, 403, 403, 404, 404, 409]);
      expect(await auditSince(before), 'a refused write is not audited (D-L53)').toEqual([]);
    });
  });

  // =========================================================================
  // 10. No PII in logs or telemetry.
  // =========================================================================

  describe('no phone or email in logs, spans or span events', () => {
    const PHONE = '+2348069041077';
    const EMAIL = 'ngozi.log-probe.t0041@example.test';
    const BAD_PHONE = '08069041078';

    beforeEach(() => {
      requireT0040();
    });

    function expectClean(haystack: string, what: string) {
      for (const form of [
        ...phoneForms(PHONE),
        ...phoneForms(`+234${BAD_PHONE.slice(1)}`),
        BAD_PHONE,
      ]) {
        expect(haystack, `${what} carries a phone (as "${form}")`).not.toContain(form);
      }
      for (const form of emailForms(EMAIL)) {
        expect(haystack, `${what} carries the email (as "${form}")`).not.toContain(form);
      }
    }

    it('create, update, search and the refusals emit no phone or email anywhere', async () => {
      let createdId = '';
      const { telemetry, lines } = await captureEverything(async () => {
        const created = await create(
          SUPERVISOR,
          createBody({ phones: [{ type: 'mobile', e164: PHONE }], emails: [EMAIL] }),
        );
        createdId = String((created.body as Json).id ?? '');
        await update(SUPERVISOR, createdId, {
          version: (created.body as Json).version,
          phones: [{ type: 'mobile', e164: PHONE }],
          emails: [EMAIL],
        });
        await list(SUPERVISOR, [['q', PHONE]]);
        await list(SUPERVISOR, [['q', `0${PHONE.slice(4)}`]]);
        // Refusals: a non-E.164 phone (400), a stale write (409), an
        // unpermitted write (403) and an unreachable target (404).
        await create(
          SUPERVISOR,
          createBody({ phones: [{ type: 'mobile', e164: BAD_PHONE }], emails: [EMAIL] }),
        );
        await update(SUPERVISOR, createdId, { version: 99, emails: [EMAIL] });
        await create(AGENT_2, createBody({ programmeId: PROGRAMME_A2, emails: [EMAIL] }));
        await create(
          SUPERVISOR,
          createBody({ programmeId: PROGRAMME_B1, phones: [{ type: 'mobile', e164: PHONE }] }),
        );
      });

      expect(createdId, 'the create inside the capture did not succeed').toMatch(UUID);
      expect(
        telemetry.spans.length,
        'no spans were recorded at all — is telemetry wired?',
      ).toBeGreaterThan(0);
      expectClean(JSON.stringify(telemetry.spans), 'spans (attributes and events)');
      expectClean(
        lines.join('\n'),
        'logs (Nest logger, stdout, stderr, console, OTel log records)',
      );
    });
  });
});
