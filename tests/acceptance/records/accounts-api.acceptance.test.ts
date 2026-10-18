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
  PROGRAMME_B2,
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
 * ACCEPTANCE — T-0055, the Accounts API (Agent 3, M3). Written before the
 * build (D-L23), from the contract and the decisions, not from an
 * implementation (D-L25).
 *
 * THE CONTRACT is the account part of `docs/api/records.openapi.yaml` (T-0052):
 * `listAccounts`, `createAccount`, `getAccount`, `updateAccount`,
 * `listAccountContacts` and `getAccountMap`. This suite LOADS the YAML and
 * validates every body against `Account`, `AccountPage`, `Contact`,
 * `ContactPage` and admin's `Error` with the same small checker the T-0041
 * suite uses (copied, not imported: importing a test file registers its
 * tests). If the spec and this file disagree, the spec is right and this
 * file is the defect: say so in the report, do not edit it.
 *
 * The schema is T-0054's `0026_account_fields.sql`: the eight columns, the
 * composite owner and parent keys, the hierarchy guard (SQLSTATE 23514,
 * constraint `account_hierarchy`, depth 5, a top-level account is depth 1),
 * the self-parent CHECK, and the immutable `account.id`.
 *
 * Sources: team/tasks/T-0055-accounts-api.md; D-L53 (404 -> 403 -> 400; the
 * tenant-admin flag), D-L54 (redacted phones in audit), D-L63 (field security
 * is not lifted by the flag; the audit label is the record id; scope headers
 * are 400), D-L64 (`q` is redacted from logs and spans), D-L67 (an owner must
 * belong to the record's programme), D-L69 (no Health, no rollups, Map is
 * 501), D-L73 (`owner` is derived), D-L74 (depth 5; no Postgres `detail` in
 * logs or bodies), D-L76 (a PATCH never moves an account between
 * programmes), D-P13 (no totals), D-P18 (ANSWERED: account writes stay
 * admin-only).
 *
 * ------------------------------------------------------------------------
 * SEAMS THE BUILDER MUST PROVIDE. Internals are yours; these are not.
 *
 *   S1. PERMISSION. A programme-scoped action `account.write` (the name is the
 *       builder's, the behaviour is not), covering createAccount and
 *       updateAccount. Granted by the locked `admin` set held IN THE TARGET
 *       PROGRAMME (the record's programme on update, `programmeId` on create)
 *       or by the tenant-admin flag, and only inside programmes the session
 *       already reaches. `agent`, `team_lead`, `qa_analyst`,
 *       `programme_manager` and `client_portal` are read-only for accounts
 *       (D-P18). Decided on every request, never cached across requests.
 *
 *   S2. AUDIT. One `audit_event` per successful create or update:
 *       `object_type = 'account'`, `object_id` = the account id,
 *       `object_label` = the account id (D-L63: a sole trader's account name
 *       is a person's name), `action` `created` / `updated`, `programme_id` =
 *       the account's programme, `actor_kind = 'user'`, `actor_user_id` = the
 *       session user. `changes[].field` uses wire names. The contract says
 *       changes are "field names, never values", so every change has
 *       `before` and `after` null or absent; `phones`, when sent, is a
 *       REDACTED change (`redacted: true`, D-L54). Refused writes write none.
 *
 *   S3. FIELD SECURITY is `loadFieldAccess(tx, 'account')` and `fieldLevel`
 *       (T-0053): the standard `account` object_def, field_def `api_name` =
 *       the snake_case of the wire property (`tier`, `phones`,
 *       `owner_user_id`, `parent_account_id`), the level for the set held IN
 *       THE ROW'S PROGRAMME. `listAccountContacts` uses the CONTACT object's
 *       `account_id`. The suite plants `field_security_grant` rows against
 *       the field_defs the seed already creates; it never invents a field_def.
 *
 * ------------------------------------------------------------------------
 * CONTRACT READINGS this suite pins, where the YAML leaves a choice:
 *
 *   - Every `Account` property is either present or listed in
 *     `withheldFields`, never both, never neither (the T-0041 reading).
 *     `Account` is not closed, so a property it does not name (`tenantId`,
 *     `health`, `contactCount`, `children`) fails here explicitly.
 *   - `owner` and `ownerUserId` are withheld TOGETHER: both omitted, both
 *     listed. When both are present, `owner` is null exactly when
 *     `ownerUserId` is, and otherwise `owner.id === ownerUserId`.
 *   - `name` is never withheld, EVEN IF a grant row says `none` for it: the
 *     contract lists it as never withheld and `sort=name` depends on that.
 *   - A filter on a field withheld in ANY programme the caller reaches is
 *     `400 field_withheld` naming the PARAMETER (`tag`, `owner`), not the
 *     field (`tags`, `owner_user_id`).
 *   - `q` matches `name` only. It never matches industry, tags, state or a
 *     phone number in any format (the contract: "not searched by phone").
 *     Matching is a case- and diacritic-insensitive SUBSTRING (the contract
 *     says substring, unlike contacts). `%`, `_` and `.*` are literal.
 *   - Unknown query parameters are ignored: `?programmeId=A2` neither
 *     narrows nor widens.
 *   - Owner (D-L67) and parent references outside the record's programme are
 *     `400 validation_failed` with `details[] = {path, code:
 *     unknown_reference}`, and the body is BYTE-IDENTICAL whether the id is
 *     real-elsewhere or invented. This holds even for a writer who can READ
 *     the other programme's row (the supervisor reaches A1 and A2).
 *   - A cycle, including a self-parent, is `400 validation_failed` with
 *     `{path: parentAccountId, code: parent_cycle}`. The contract names no
 *     code for excess depth; this suite pins `parent_depth` at the same path
 *     (lead's instruction). Never a 500, even when the database guard, not
 *     the API, is what refuses (two concurrent half-cycles).
 *   - Order on update: 404, 403 (incl. `field_not_editable`), 400, 409. So a
 *     stale version with a bad body is 400; a stale version with a field the
 *     caller may not edit is 403.
 *   - createAccount, a caller with no `account.write` in ANY programme it
 *     reaches: 403 before the body is read, so a missing `programmeId` for a
 *     caller who reaches several is 403, not 400 (the contract: "decided
 *     before the body is read").
 *   - `listAccountContacts`: reachability first (404), then the withheld
 *     `accountId` rule (400 `field_withheld`, path `accountId`, judged in the
 *     ACCOUNT's programme), then rows.
 *   - Reads of per-user data under a URL identical for every user carry
 *     `Cache-Control` with `no-store` or `private` (the T-0043 reading for
 *     `/me/programmes`, and what the live contacts handlers send). No
 *     response header carries a total or a count (D-P13).
 *   - A NUL character in a string (Postgres `text` cannot store one) is
 *     `400 validation_failed`, never a 500 and never silently stripped.
 *   - Logs, spans and error bodies never carry a phone, the account's name,
 *     `q` or a Postgres `detail` ("Failing row contains"). Error bodies also
 *     never carry a "violates ... constraint" message, a constraint name or a
 *     SQLSTATE (spans are not held to that last part: see
 *     DATABASE_TEXT_IN_BODIES).
 *
 *   NOT asserted, deliberately:
 *   - the version a new account starts at (only an integer >= 1, and +1 per
 *     update); the order of `withheldFields`; the `x-kasuwa-implemented` flag
 *     of `getAccountMap` (it answers 501 by design; whether that counts as
 *     "implemented" is the lead's call); create by a user who reaches no
 *     programme beyond "nothing is written, 400 or 404".
 *
 * Writes: the suite reseeds before and after, and after every test.
 * Fixtures are packages/db/src/fixtures.ts only, plus rows planted here by
 * `kasuwa_migrator` (BYPASSRLS, never serves) with ids in this suite's own
 * range (`...-00005500xxxx`).
 */

// ---------------------------------------------------------------------------
// Constants and fixtures.
// ---------------------------------------------------------------------------

const ACCOUNTS = '/api/v1/accounts';
const MAP = `${ACCOUNTS}/map`;
const accountPath = (id: string) => `${ACCOUNTS}/${id}`;
const accountContactsPath = (id: string) => `${ACCOUNTS}/${id}/contacts`;

/** Never a real row: same shape as the seed ids, nothing seeds it. */
const NOWHERE = '11111111-0000-4000-8000-00005500ffff';

/** Accounts this suite plants. Tenant A unless the name says B. */
const OJA = '11111111-0000-4000-8000-00005500a001';
const KANO = '11111111-0000-4000-8000-00005500a002';
const DECOY_A2 = '11111111-0000-4000-8000-00005500a003';
const DECOY_B1 = '22222222-0000-4000-8000-00005500b001';
const TWIN_1 = '11111111-0000-4000-8000-00005500a004';
const TWIN_2 = '11111111-0000-4000-8000-00005500a005';
const PARENT = '11111111-0000-4000-8000-00005500a010';
const CHILD = '11111111-0000-4000-8000-00005500a011';
const GRANDCHILD = '11111111-0000-4000-8000-00005500a012';
const ROOT_X = '11111111-0000-4000-8000-00005500a020';
const ROOT_X_CHILD = '11111111-0000-4000-8000-00005500a021';
const RACE_1 = '11111111-0000-4000-8000-00005500a030';
const RACE_2 = '11111111-0000-4000-8000-00005500a031';
const PII_ACCOUNT = '11111111-0000-4000-8000-00005500a040';
const EMPTY_ACCOUNT = '11111111-0000-4000-8000-00005500a050';
/** A chain D1 (top) .. D5 (depth 5, the cap). */
const CHAIN = [1, 2, 3, 4, 5].map((level) => `11111111-0000-4000-8000-00005500d00${level}`);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);
const AGENT_2 = asUser(TENANT_A, USER_A_AGENT_2);
const NO_PROGRAMME = asUser(TENANT_A, USER_A_NO_PROGRAMME);
const TENANT_B_USER = asUser(TENANT_B, USER_B_AGENT_1);

type Headers = Record<string, string>;
type Json = Record<string, unknown>;
type Params = readonly (readonly [string, string])[];

function seededAccount(programmeId: string) {
  const account = SEED_ACCOUNTS.find((candidate) => candidate.programmeId === programmeId);
  if (account === undefined) throw new Error(`Fixture drift: no seeded account in ${programmeId}`);
  return account;
}

/** "Ikoyi Traders", A1. */
const IKOYI = seededAccount(PROGRAMME_A1);
/** "Sabon Gari Mart", A2. */
const SABON = seededAccount(PROGRAMME_A2);
/** "Westlands Supplies", tenant B, B1. */
const WESTLANDS = seededAccount(PROGRAMME_B1);
/** "Mombasa Road Hardware", tenant B, B2 (tenant B's user does not reach B2). */
const MOMBASA = seededAccount(PROGRAMME_B2);

function seededContact(givenNames: string) {
  const contact = SEED_CONTACTS.find((candidate) => candidate.givenNames === givenNames);
  if (contact === undefined) throw new Error(`Fixture drift: no seeded contact '${givenNames}'`);
  return contact;
}

/** Tenant A, A1. */
const AMAKA = seededContact('Amaka');
const BASHIR = seededContact('Bashir');
const CHIOMA = seededContact('Chioma');
/** Tenant A, A2. */
const DAMILOLA = seededContact('Damilola');

function displayNameOf(userId: string): string {
  for (const tenant of SEED_TENANTS) {
    const user = tenant.users.find((candidate) => candidate.id === userId);
    if (user !== undefined) return user.displayName;
  }
  throw new Error(`Fixture drift: no seeded user ${userId}`);
}

function permissionSet(tenantId: string, key: string): string {
  const set = SEED_PERMISSION_SETS.find(
    (candidate) => candidate.tenantId === tenantId && candidate.key === key,
  );
  if (set === undefined) throw new Error(`Fixture drift: no seeded permission set '${key}'`);
  return set.id;
}

/** D-P18: every set but `admin` is read-only for accounts. */
const NON_WRITER_KEYS = [
  'agent',
  'team_lead',
  'qa_analyst',
  'programme_manager',
  'client_portal',
] as const;

/** The live scope headers the stub guard refuses (D-L63). */
const SCOPE_HEADERS = [
  ['x-kasuwa-programme-ids', `{${PROGRAMME_A2}}`],
  ['x-kasuwa-programme-id', PROGRAMME_A2],
  ['x-kasuwa-scope', 'all'],
] as const;

// ---------------------------------------------------------------------------
// A small JSON-Schema checker over the published YAML (no new dependency).
// The T-0041 suite's, unchanged: $ref (local and relative-file), type (incl.
// arrays), enum, oneOf, required, properties, additionalProperties: false,
// items, min/maxItems, min/maxLength, pattern, minimum/maximum, formats.
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

function schemaAt(name: string): Json {
  return { $ref: `#/components/schemas/${name}` };
}

function expectSchema(value: unknown, schemaName: string, where: string): void {
  const errors: string[] = [];
  check(schemaAt(schemaName), SPEC_PATH, value, where, errors);
  expect(errors, `${where} does not match #/components/schemas/${schemaName}`).toEqual([]);
}

function propertiesOf(schemaName: string): string[] {
  const { schema } = deref(schemaAt(schemaName), SPEC_PATH);
  return Object.keys((schema.properties ?? {}) as Json);
}

/** Never withheld, per the Account schema's description. */
const ACCOUNT_NEVER_WITHHELD = [
  'id',
  'programmeId',
  'name',
  'version',
  'createdAt',
  'updatedAt',
  'withheldFields',
];

/** Never withheld, per the Contact schema's description. */
const CONTACT_NEVER_WITHHELD = [
  'id',
  'programmeId',
  'version',
  'displayName',
  'createdAt',
  'updatedAt',
  'withheldFields',
];

/** Things D-L69 and D-P13 keep off an Account, named so a failure says which. */
const NOT_ON_AN_ACCOUNT = [
  'tenantId',
  'health',
  'healthScore',
  'score',
  'contactCount',
  'contactsCount',
  'childCount',
  'children',
  'childAccounts',
  'dealCount',
  'pipelineValue',
  'total',
];

function omissionProblems(
  record: Json,
  named: readonly string[],
  allowedExtra: readonly string[],
  neverWithheld: readonly string[],
): string[] {
  const withheld = Array.isArray(record.withheldFields) ? (record.withheldFields as string[]) : [];
  const problems: string[] = [];
  for (const key of Object.keys(record)) {
    if (!named.includes(key) && !allowedExtra.includes(key)) {
      problems.push(`${key} is not a property the contract names`);
    }
  }
  for (const name of withheld) {
    if (neverWithheld.includes(name)) problems.push(`${name} is never withheld`);
    if (name in record) problems.push(`${name} is withheld but present (withheld means omitted)`);
    if (!named.includes(name) && !allowedExtra.includes(name)) {
      problems.push(`${name} is not a property of this record`);
    }
  }
  for (const name of named) {
    if (!(name in record) && !withheld.includes(name)) {
      problems.push(`${name} is neither present nor listed in withheldFields`);
    }
  }
  // owner is derived from ownerUserId (D-L73) and withheld with it.
  if (withheld.includes('owner') !== withheld.includes('ownerUserId')) {
    problems.push('owner and ownerUserId must be withheld together');
  }
  if ('owner' in record && 'ownerUserId' in record) {
    const owner = record.owner as Json | null;
    if (record.ownerUserId === null && owner !== null) {
      problems.push('owner must be null exactly when ownerUserId is null');
    }
    if (record.ownerUserId !== null && (owner === null || owner.id !== record.ownerUserId)) {
      problems.push('owner.id must equal ownerUserId');
    }
  }
  return problems;
}

/** `Account` plus the omission rule, the owner coupling and no unnamed property. */
function expectAccount(value: unknown, where: string): Json {
  expectSchema(value, 'Account', where);
  const account = value as Json;
  const leaked = NOT_ON_AN_ACCOUNT.filter((key) => key in account);
  expect(leaked, `${where} carries properties D-L69 / D-P13 keep off an Account`).toEqual([]);
  expect(
    // T-0089 / D-L143 (lead edit): Account's pending allOf part (`custom`) is admitted, not required.
    omissionProblems(account, propertiesOf('Account'), propertiesOf('AccountPendingProperties'), ACCOUNT_NEVER_WITHHELD),
    `${where}: field-security omission rule`,
  ).toEqual([]);
  return account;
}

function expectAccountPage(
  value: unknown,
  where: string,
): { data: Json[]; nextCursor: string | null } {
  expectSchema(value, 'AccountPage', where);
  const page = value as { data: Json[]; nextCursor: string | null };
  // D-P13: no total, offset or page number. AccountPage is not closed, so say it.
  expect(Object.keys(page).sort(), `${where}: a keyset page is data and nextCursor only`).toEqual([
    'data',
    'nextCursor',
  ]);
  page.data.forEach((row, index) => expectAccount(row, `${where}.data[${index}]`));
  return page;
}

/**
 * `Contact` rows from listAccountContacts. The contract's pending properties
 * (`account`, `companyName`) are allowed, not required, so this suite does
 * not break when T-0061 or T-0076 serves them first.
 */
function expectContactPage(
  value: unknown,
  where: string,
): { data: Json[]; nextCursor: string | null } {
  expectSchema(value, 'ContactPage', where);
  const page = value as { data: Json[]; nextCursor: string | null };
  expect(Object.keys(page).sort(), `${where}: a keyset page is data and nextCursor only`).toEqual([
    'data',
    'nextCursor',
  ]);
  const pending = propertiesOf('ContactPendingProperties');
  page.data.forEach((row, index) => {
    const at = `${where}.data[${index}]`;
    expectSchema(row, 'Contact', at);
    expect(
      omissionProblems(row, propertiesOf('Contact'), pending, CONTACT_NEVER_WITHHELD),
      `${at}: field-security omission rule`,
    ).toEqual([]);
  });
  return page;
}

/** admin.openapi.yaml `Error`, with the status and `code` the operation names. */
function expectError(response: request.Response, status: number, code: string): Json {
  expect(
    response.status,
    `expected ${status} ${code}, got ${response.status} ${JSON.stringify(response.body)}`,
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

function expectStatus(response: request.Response, status: number, what: string): void {
  expect(response.status, `${what}: ${JSON.stringify(response.body)}`).toBe(status);
}

const idsOf = (page: { data: Json[] }) => page.data.map((row) => row.id as string).sort();
const orderOf = (page: { data: Json[] }) => page.data.map((row) => row.id as string);
const sorted = (ids: readonly string[]) => [...ids].sort();

/** D-P13: a count in a header is a total by another name. */
function expectNoTotals(response: request.Response, where: string): void {
  const headers = Object.keys(response.headers).filter((name) => /total|count/i.test(name));
  expect(headers, `${where}: a response header carries a total`).toEqual([]);
}

/** The URL is identical for every user of every tenant; a shared cache must not keep it. */
function expectNotShared(response: request.Response, where: string): void {
  expect(
    String(response.headers['cache-control'] ?? ''),
    `${where}: Cache-Control must keep per-user rows out of shared caches`,
  ).toMatch(/no-store|private/);
}

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

/** Every form a phone number can take on its way into a log line. */
function phoneForms(e164: string): string[] {
  const digits = e164.replace(/^\+/, '');
  const national = digits.startsWith('234') ? `0${digits.slice(3)}` : digits;
  return [...new Set([e164, encodeURIComponent(e164), digits, national])];
}

/**
 * A Postgres `detail` carries the row (D-L74). It must never reach a log line,
 * a span or a body. Checked everywhere.
 */
const ROW_DETAIL = 'Failing row contains';

/**
 * Database text an ERROR BODY must never carry (admin's Error.details: "never
 * a database message"). Checked in bodies only: a span's trace ids and
 * timestamps are long random digit strings, and would match a SQLSTATE by
 * chance often enough to make the log check flaky.
 */
const DATABASE_TEXT_IN_BODIES = [
  ROW_DETAIL,
  'violates',
  'constraint',
  '23514',
  '23503',
  'account_hierarchy',
  'account_parent',
];

// ---------------------------------------------------------------------------

describe('acceptance: accounts API (T-0055)', () => {
  let app: INestApplication;
  /** kasuwa_migrator — BYPASSRLS. Plants values and observes rows; never serves. */
  let observer: Pool;

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

  // --- HTTP helpers -------------------------------------------------------

  const withQuery = (path: string, params: Params) => {
    const query = new URLSearchParams(params.map(([k, v]): [string, string] => [k, v])).toString();
    return query === '' ? path : `${path}?${query}`;
  };
  const list = (headers: Headers, params: Params = []) =>
    request(server()).get(withQuery(ACCOUNTS, params)).set(headers);
  const getOne = (headers: Headers, id: string) =>
    request(server()).get(accountPath(id)).set(headers);
  const create = (headers: Headers, body: unknown) =>
    request(server())
      .post(ACCOUNTS)
      .set(headers)
      .send(body as object);
  const update = (headers: Headers, id: string, body: unknown) =>
    request(server())
      .patch(accountPath(id))
      .set(headers)
      .send(body as object);
  const accountContacts = (headers: Headers, id: string, params: Params = []) =>
    request(server())
      .get(withQuery(accountContactsPath(id), params))
      .set(headers);

  // --- observer helpers -----------------------------------------------------

  async function accountRow(id: string): Promise<Json | null> {
    const result = await observer.query<Json>('SELECT * FROM account WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async function accountCount(): Promise<number> {
    const result = await observer.query<{ n: number }>('SELECT count(*)::int AS n FROM account');
    return result.rows[0]?.n ?? -1;
  }

  async function accountsNamed(name: string): Promise<number> {
    const result = await observer.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM account WHERE name = $1',
      [name],
    );
    return result.rows[0]?.n ?? -1;
  }

  async function versionOf(id: string): Promise<number> {
    const row = await accountRow(id);
    if (row === null) throw new Error(`no account ${id} to read a version from`);
    return Number(row.version);
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

  /**
   * S3: one field-security decision in tenant A, against the standard
   * field_def the seed already holds (T-0053, T-0054). Never invents one.
   */
  async function lockField(
    objectApiName: 'account' | 'contact',
    field: string,
    setKey: string,
    level: 'none' | 'read' | 'edit',
  ) {
    const found = await observer.query<{ id: string }>(
      `SELECT f.id FROM field_def f
         JOIN object_def o ON o.id = f.object_id AND o.tenant_id = f.tenant_id
        WHERE f.tenant_id = $1 AND o.api_name = $2 AND f.api_name = $3`,
      [TENANT_A, objectApiName, field],
    );
    const fieldId = found.rows[0]?.id;
    if (fieldId === undefined) {
      throw new Error(
        `Fixture drift: tenant A has no standard field_def ${objectApiName}.${field} ` +
          '(T-0053 / T-0054 seed it). This suite plants grants, never field definitions.',
      );
    }
    await observer.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [TENANT_A, fieldId, permissionSet(TENANT_A, setKey), level],
    );
  }

  interface Planted {
    id: string;
    programmeId: string;
    tenantId?: string;
    name: string;
    ownerUserId?: string | null;
    industry?: string | null;
    tier?: string | null;
    tags?: string[];
    phones?: { type: string; e164: string }[];
    state?: string | null;
    lga?: string | null;
    parentAccountId?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }

  /** Plants an account through kasuwa_migrator. Parents must be planted first. */
  async function plantAccount(account: Planted) {
    await observer.query(
      `INSERT INTO account (id, tenant_id, programme_id, name, owner_user_id, industry, tier,
                            tags, phones, state, lga, parent_account_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::jsonb, $10, $11, $12,
               COALESCE($13::timestamptz, now()), COALESCE($14::timestamptz, now()))`,
      [
        account.id,
        account.tenantId ?? TENANT_A,
        account.programmeId,
        account.name,
        account.ownerUserId ?? null,
        account.industry ?? null,
        account.tier ?? null,
        account.tags ?? [],
        JSON.stringify(account.phones ?? []),
        account.state ?? null,
        account.lga ?? null,
        account.parentAccountId ?? null,
        account.createdAt ?? null,
        account.updatedAt ?? null,
      ],
    );
  }

  /** Sets columns on an existing account in ONE statement. */
  async function setAccount(id: string, values: Record<string, unknown>) {
    const columns = Object.keys(values);
    const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
    await observer.query(`UPDATE account SET ${assignments} WHERE id = $1`, [
      id,
      ...columns.map((column) => values[column]),
    ]);
  }

  async function linkContacts(accountId: string, contactIds: readonly string[]) {
    await observer.query('UPDATE contact SET account_id = $1 WHERE id = ANY($2::uuid[])', [
      accountId,
      contactIds,
    ]);
  }

  /** Every id a caller reaches through listAccounts, walking every page. */
  async function allIds(headers: Headers, params: Params = []): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const response = await list(headers, [
        ...params,
        ['limit', '100'],
        ...(cursor === null ? [] : ([['cursor', cursor]] as const)),
      ]);
      expectStatus(response, 200, 'listAccounts');
      const page = expectAccountPage(response.body, 'listAccounts');
      seen.push(...orderOf(page));
      cursor = page.nextCursor;
      if (cursor === null) return seen;
    }
    throw new Error('listAccounts never returned a null nextCursor');
  }

  /** A minimal valid create into A1. */
  let sequence = 0;
  const RUN = Date.now().toString(36);
  const unique = (label: string) => `${label} ${RUN}-${(sequence += 1)}`;
  const createBody = (extra: Json = {}): Json => ({
    programmeId: PROGRAMME_A1,
    name: unique('T0055 Create'),
    ...extra,
  });

  // =========================================================================
  // 1. The wire matches records.openapi.yaml.
  // =========================================================================

  describe('the wire matches records.openapi.yaml', () => {
    it('(self-check) the Account checker accepts the contract’s example and rejects broken copies of it', () => {
      // Passes on main by design: it tests this file's checker, not the API.
      // A checker only ever seen passing proves nothing, so each mutant below
      // must be refused.
      const spec = loadDoc(SPEC_PATH) as { paths: Record<string, Record<string, Json>> };
      const responses = spec.paths[ACCOUNTS]?.get?.responses as Json;
      const ok = ((responses['200'] as Json).content as Json)['application/json'] as Json;
      const example = ok.example as { data: Json[]; nextCursor: string | null };
      expectAccountPage(example, 'contract example');

      const row = example.data[0] ?? {};
      const without = (key: string) =>
        Object.fromEntries(Object.entries(row).filter(([candidate]) => candidate !== key));
      const mutants: [string, Json][] = [
        ['a withheld field sent as null', { ...row, phones: null }],
        ['name missing', without('name')],
        ['a display label as tier', { ...row, tier: 'Mid-market' }],
        ['a non-E.164 phone', { ...row, phones: [{ type: 'work', e164: '08030000101' }] }],
        ['a tenantId', { ...row, tenantId: TENANT_A }],
        ['a Health score (D-L69)', { ...row, health: 72 }],
        ['a contact count (D-P13)', { ...row, contactCount: 3 }],
        ['a list of children', { ...row, children: [] }],
        ['an owner with an email', { ...row, owner: { ...(row.owner as Json), email: 'x@y.z' } }],
        [
          'an owner whose id is not ownerUserId',
          { ...row, owner: { id: NOWHERE, displayName: 'X' } },
        ],
        ['an owner set while ownerUserId is null', { ...row, ownerUserId: null }],
        ['a field neither present nor withheld', without('industry')],
        [
          'ownerUserId withheld while owner is sent',
          { ...without('ownerUserId'), withheldFields: ['ownerUserId'] },
        ],
        ['name listed as withheld', { ...without('name'), withheldFields: ['name'] }],
      ];
      for (const [label, mutant] of mutants) {
        let rejected = false;
        try {
          expectAccount(mutant, label);
        } catch {
          rejected = true;
        }
        expect(rejected, `the checker accepted an Account with ${label}`).toBe(true);
      }
    });

    it('listAccounts returns an AccountPage; agent 1 sees exactly A1’s account', async () => {
      const response = await list(AGENT_1);
      expectStatus(response, 200, 'listAccounts');
      const page = expectAccountPage(response.body, 'listAccounts');
      expect(idsOf(page)).toEqual([IKOYI.id]);
      expect(page.nextCursor).toBeNull();
      expectNoTotals(response, 'listAccounts');
      expectNotShared(response, 'listAccounts');
    });

    it('getAccount returns every stored value, with the owner embedded as { id, displayName }', async () => {
      await plantAccount({
        id: OJA,
        programmeId: PROGRAMME_A1,
        name: 'Ọjà Foods Ltd',
        ownerUserId: USER_A_AGENT_1,
        industry: 'FMCG',
        tier: 'mid_market',
        tags: ['Distributor'],
        phones: [{ type: 'work', e164: '+2348030055101' }],
        state: 'Lagos',
        lga: 'Ikeja',
        parentAccountId: IKOYI.id,
      });
      const response = await getOne(SUPERVISOR, OJA);
      expectStatus(response, 200, 'getAccount');
      const account = expectAccount(response.body, 'getAccount');
      expect(account).toMatchObject({
        id: OJA,
        programmeId: PROGRAMME_A1,
        name: 'Ọjà Foods Ltd',
        ownerUserId: USER_A_AGENT_1,
        owner: { id: USER_A_AGENT_1, displayName: displayNameOf(USER_A_AGENT_1) },
        industry: 'FMCG',
        tier: 'mid_market',
        tags: ['Distributor'],
        phones: [{ type: 'work', e164: '+2348030055101' }],
        state: 'Lagos',
        lga: 'Ikeja',
        parentAccountId: IKOYI.id,
        withheldFields: [],
      });
      expect(Object.keys(account.owner as Json).sort(), 'owner is closed').toEqual([
        'displayName',
        'id',
      ]);
      expect(account.version).toBe(await versionOf(OJA));
      expectNotShared(response, 'getAccount');
    });

    it('an account with nothing set: null owner and scalars, empty lists, never null lists', async () => {
      const account = expectAccount(
        (await getOne(SUPERVISOR, IKOYI.id).expect(200)).body,
        'bare account',
      );
      expect(account).toMatchObject({
        name: IKOYI.name,
        ownerUserId: null,
        owner: null,
        industry: null,
        tier: null,
        tags: [],
        phones: [],
        state: null,
        lga: null,
        parentAccountId: null,
      });
    });

    it('createAccount answers 201 with the created Account, and the row exists where it should', async () => {
      const body = createBody({
        industry: 'Agriculture',
        tier: 'sme',
        phones: [{ type: 'work', e164: '+2348060055102' }],
        state: 'Kano',
      });
      const response = await create(SUPERVISOR, body);
      expectStatus(response, 201, 'createAccount');
      const account = expectAccount(response.body, 'createAccount');
      expect(account.id).toMatch(UUID);
      expect(account).toMatchObject({
        programmeId: PROGRAMME_A1,
        name: body.name,
        industry: 'Agriculture',
        tier: 'sme',
        phones: [{ type: 'work', e164: '+2348060055102' }],
        state: 'Kano',
        lga: null,
        tags: [],
        ownerUserId: null,
        owner: null,
        parentAccountId: null,
      });
      expect(Number.isInteger(account.version) && (account.version as number) >= 1).toBe(true);

      const row = await accountRow(account.id as string);
      expect(row, 'createAccount answered 201 but no row was written').not.toBeNull();
      expect(row?.tenant_id).toBe(TENANT_A);
      expect(row?.programme_id).toBe(PROGRAMME_A1);
      expect(Number(row?.version)).toBe(account.version);
    });

    it('updateAccount answers 200 with the updated Account', async () => {
      const response = await update(SUPERVISOR, IKOYI.id, {
        version: await versionOf(IKOYI.id),
        tier: 'enterprise',
        ownerUserId: USER_A_AGENT_1,
      });
      expectStatus(response, 200, 'updateAccount');
      const account = expectAccount(response.body, 'updateAccount');
      expect(account).toMatchObject({
        id: IKOYI.id,
        tier: 'enterprise',
        ownerUserId: USER_A_AGENT_1,
        owner: { id: USER_A_AGENT_1, displayName: displayNameOf(USER_A_AGENT_1) },
      });
    });

    it('a malformed id, cursor, limit or sort is 400 validation_failed', async () => {
      expectError(await getOne(SUPERVISOR, 'not-a-uuid'), 400, 'validation_failed');
      expectError(await accountContacts(SUPERVISOR, 'not-a-uuid'), 400, 'validation_failed');
      const cursor = expectError(
        await list(SUPERVISOR, [['cursor', 'not-base64-json']]),
        400,
        'validation_failed',
      );
      expect(detailsOf(cursor)).toContainEqual({ path: 'cursor', code: 'invalid_cursor' });
      expectError(await list(SUPERVISOR, [['limit', '0']]), 400, 'validation_failed');
      expectError(await list(SUPERVISOR, [['limit', '101']]), 400, 'validation_failed');
      // Ordering by a field that can be withheld leaks it one comparison at a time.
      for (const sort of ['tier', '-industry', 'ownerUserId', 'owner', 'phones', 'state', 'id']) {
        expectError(await list(SUPERVISOR, [['sort', sort]]), 400, 'validation_failed');
      }
      // The control: the same caller lists fine, so the 400s are about the values.
      await list(SUPERVISOR, [['limit', '100']]).expect(200);
    });

    it('the spec marks the five account operations implemented once they are', () => {
      // x-kasuwa-implemented: false keeps the screens (T-0057) on the mock.
      const spec = loadDoc(SPEC_PATH) as { paths: Record<string, Record<string, Json>> };
      const flag = (path: string, method: string) =>
        spec.paths[path]?.[method]?.['x-kasuwa-implemented'];
      expect(flag(ACCOUNTS, 'get'), 'listAccounts').toBe(true);
      expect(flag(ACCOUNTS, 'post'), 'createAccount').toBe(true);
      expect(flag(`${ACCOUNTS}/{accountId}`, 'get'), 'getAccount').toBe(true);
      expect(flag(`${ACCOUNTS}/{accountId}`, 'patch'), 'updateAccount').toBe(true);
      expect(flag(`${ACCOUNTS}/{accountId}/contacts`, 'get'), 'listAccountContacts').toBe(true);
    });
  });

  // =========================================================================
  // 2. The Map route: 501, after authentication, never shadowed.
  // =========================================================================

  describe('getAccountMap', () => {
    it('answers 501 not_implemented to any signed-in caller — not 400 from the :accountId uuid check', async () => {
      for (const headers of [SUPERVISOR, AGENT_1, NO_PROGRAMME, TENANT_B_USER]) {
        expectError(await request(server()).get(MAP).set(headers), 501, 'not_implemented');
      }
    });

    it('is 401 not_authenticated without a session', async () => {
      expectError(await request(server()).get(MAP), 401, 'not_authenticated');
    });
  });

  // =========================================================================
  // 3. listAccounts: search, filters, sort and paging.
  // =========================================================================

  describe('listAccounts: search, filters, sort and paging', () => {
    beforeEach(async () => {
      // A1 (agent 1's programme): three distinct profiles. The timestamps make
      // name, createdAt and updatedAt order three DIFFERENT permutations, so
      // an ignored `sort` cannot pass by coincidence:
      //   name       Ikoyi, Kano, Ọjà
      //   createdAt  Kano, Ikoyi, Ọjà
      //   updatedAt  Ikoyi, Ọjà, Kano
      await setAccount(IKOYI.id, {
        created_at: '2026-02-02T00:00:00Z',
        updated_at: '2026-02-05T00:00:00Z',
      });
      await plantAccount({
        id: KANO,
        programmeId: PROGRAMME_A1,
        name: 'Kano Grains Co.',
        ownerUserId: USER_A_SUPERVISOR,
        industry: 'Agriculture',
        tier: 'sme',
        tags: ['Late payer'],
        state: 'Kano',
        lga: 'Nassarawa',
        createdAt: '2026-02-01T00:00:00Z',
        updatedAt: '2026-02-10T00:00:00Z',
      });
      await plantAccount({
        id: OJA,
        programmeId: PROGRAMME_A1,
        name: 'Ọjà Foods Ltd',
        ownerUserId: USER_A_AGENT_1,
        industry: 'FMCG',
        tier: 'mid_market',
        tags: ['Distributor', 'Key account'],
        phones: [{ type: 'work', e164: '+2348030055001' }],
        state: 'Lagos',
        lga: 'Ikeja',
        createdAt: '2026-02-03T00:00:00Z',
        updatedAt: '2026-02-07T00:00:00Z',
      });
      // A2 and tenant B: rows that match EVERY filter agent 1 tries, even
      // owner=me. If one appears in agent 1's results, scope leaked through
      // the filter path.
      for (const [id, tenantId, programmeId, owner] of [
        [DECOY_A2, TENANT_A, PROGRAMME_A2, USER_A_AGENT_1],
        [DECOY_B1, TENANT_B, PROGRAMME_B1, USER_B_AGENT_1],
      ] as const) {
        await plantAccount({
          id,
          tenantId,
          programmeId,
          name: 'Ọjà Foods Decoy',
          ownerUserId: owner,
          industry: 'FMCG',
          tier: 'mid_market',
          tags: ['Distributor', 'Key account'],
          phones: [{ type: 'work', e164: '+2348030055001' }],
          state: 'Lagos',
          lga: 'Ikeja',
        });
      }
      await setAccount(SABON.id, { owner_user_id: USER_A_AGENT_2 });
    });

    const agentIds = async (params: Params) => {
      const response = await list(AGENT_1, params);
      expectStatus(response, 200, `listAccounts ${JSON.stringify(params)}`);
      return idsOf(expectAccountPage(response.body, `list ${JSON.stringify(params)}`));
    };

    describe('q searches the account name', () => {
      it('a case- and diacritic-insensitive substring of the name (the contract: Oja finds Ọjà Foods Ltd)', async () => {
        expect(await agentIds([['q', 'Oja']])).toEqual([OJA]);
        expect(await agentIds([['q', 'oja foods']])).toEqual([OJA]);
        expect(await agentIds([['q', 'FOODS']])).toEqual([OJA]);
        expect(await agentIds([['q', 'grains']])).toEqual([KANO]);
        expect(await agentIds([['q', 'Ọjà']])).toEqual([OJA]);
      });

      it('matches the name only: never industry, tags, state or a phone in any format', async () => {
        for (const q of [
          'FMCG',
          'Distributor',
          'Lagos',
          'Ikeja',
          '+2348030055001',
          '08030055001',
          '2348030055001',
        ]) {
          expect(await agentIds([['q', q]]), `q=${q}`).toEqual([]);
        }
      });

      it('never searches outside scope: a name only in A2 finds nothing for agent 1, and does for the supervisor', async () => {
        expect(await agentIds([['q', 'Decoy']])).toEqual([]);
        expect(await agentIds([['q', 'Sabon']])).toEqual([]);
        const response = await list(SUPERVISOR, [['q', 'Decoy']]);
        expectStatus(response, 200, 'supervisor search');
        expect(idsOf(expectAccountPage(response.body, 'supervisor search'))).toEqual([DECOY_A2]);
      });

      it('treats LIKE and regex metacharacters literally', async () => {
        for (const q of ['%', '_', '.*', '%a%', 'K_no']) {
          expect(await agentIds([['q', q]]), `q=${q}`).toEqual([]);
        }
      });

      it('q is 1 to 100 characters: empty and 101 are 400, 100 is allowed', async () => {
        expectError(await list(AGENT_1, [['q', '']]), 400, 'validation_failed');
        expectError(await list(AGENT_1, [['q', 'a'.repeat(101)]]), 400, 'validation_failed');
        await list(AGENT_1, [['q', 'a'.repeat(100)]]).expect(200);
      });
    });

    describe('each filter narrows, and only within scope', () => {
      it('owner: me, unassigned, a user id, and several (any of)', async () => {
        expect(await agentIds([['owner', 'me']])).toEqual([OJA]);
        expect(await agentIds([['owner', 'unassigned']])).toEqual([IKOYI.id]);
        expect(await agentIds([['owner', USER_A_SUPERVISOR]])).toEqual([KANO]);
        expect(
          await agentIds([
            ['owner', 'me'],
            ['owner', 'unassigned'],
          ]),
        ).toEqual(sorted([OJA, IKOYI.id]));
      });

      it('owner: a user agent 1 cannot see answers byte-for-byte what an invented id does', async () => {
        // Agent 2 owns Sabon Gari Mart (A2); a tenant-B user owns the B1 decoy.
        const invented = await list(AGENT_1, [['owner', NOWHERE]]);
        const sibling = await list(AGENT_1, [['owner', USER_A_AGENT_2]]);
        const otherTenant = await list(AGENT_1, [['owner', USER_B_AGENT_1]]);
        for (const response of [invented, sibling, otherTenant]) {
          expectStatus(response, 200, 'owner filter');
          expectAccountPage(response.body, 'owner filter');
        }
        expect(sibling.body).toEqual(invented.body);
        expect(otherTenant.body).toEqual(invented.body);
      });

      it('tier, any of', async () => {
        expect(await agentIds([['tier', 'mid_market']])).toEqual([OJA]);
        expect(
          await agentIds([
            ['tier', 'mid_market'],
            ['tier', 'sme'],
          ]),
        ).toEqual(sorted([OJA, KANO]));
        expect(await agentIds([['tier', 'enterprise']])).toEqual([]);
      });

      it('industry: exact, case-insensitive, never a substring', async () => {
        expect(await agentIds([['industry', 'fmcg']])).toEqual([OJA]);
        expect(await agentIds([['industry', 'FMC']])).toEqual([]);
        expect(
          await agentIds([
            ['industry', 'FMCG'],
            ['industry', 'agriculture'],
          ]),
        ).toEqual(sorted([OJA, KANO]));
      });

      it('tag: exact, case-insensitive, any of', async () => {
        expect(await agentIds([['tag', 'distributor']])).toEqual([OJA]);
        expect(await agentIds([['tag', 'KEY ACCOUNT']])).toEqual([OJA]);
        expect(await agentIds([['tag', 'Key']])).toEqual([]);
        expect(
          await agentIds([
            ['tag', 'Distributor'],
            ['tag', 'late payer'],
          ]),
        ).toEqual(sorted([OJA, KANO]));
      });

      it('state and lga: exact, case-insensitive', async () => {
        expect(await agentIds([['state', 'LAGOS']])).toEqual([OJA]);
        expect(await agentIds([['lga', 'nassarawa']])).toEqual([KANO]);
        expect(await agentIds([['state', 'Lag']])).toEqual([]);
        expect(
          await agentIds([
            ['state', 'Lagos'],
            ['state', 'Kano'],
          ]),
        ).toEqual(sorted([OJA, KANO]));
      });

      it('different filters combine with AND', async () => {
        expect(
          await agentIds([
            ['tier', 'mid_market'],
            ['state', 'Kano'],
          ]),
        ).toEqual([]);
        expect(
          await agentIds([
            ['owner', 'me'],
            ['tag', 'distributor'],
            ['q', 'oja'],
          ]),
        ).toEqual([OJA]);
      });

      it('a value outside a filter’s schema is 400 validation_failed', async () => {
        for (const params of [
          [['tier', 'Enterprise']],
          [['tier', 'mid-market']],
          [['owner', 'not-a-uuid']],
          [['owner', 'everyone']],
          [['industry', '']],
          [['industry', 'x'.repeat(65)]],
          [['tag', '']],
        ] as const) {
          expectError(await list(AGENT_1, params), 400, 'validation_failed');
        }
      });

      it('unknown query parameters are ignored: a programme or tenant in the query neither narrows nor widens', async () => {
        const plain = await agentIds([]);
        expect(plain).toEqual(sorted([IKOYI.id, KANO, OJA]));
        expect(
          await agentIds([
            ['programmeId', PROGRAMME_A2],
            ['programme', PROGRAMME_A2],
            ['programmeIds', PROGRAMME_A2],
            ['tenantId', TENANT_B],
            ['scope', 'all'],
          ]),
        ).toEqual(plain);
      });
    });

    describe('sort and keyset paging', () => {
      const order = async (sort: string) => {
        const response = await list(AGENT_1, [['sort', sort]]);
        expectStatus(response, 200, `sort=${sort}`);
        return orderOf(expectAccountPage(response.body, `sort=${sort}`));
      };

      it('orders by each documented key; the default is name', async () => {
        expect(await order('name')).toEqual([IKOYI.id, KANO, OJA]);
        expect(await order('-name')).toEqual([OJA, KANO, IKOYI.id]);
        expect(await order('createdAt')).toEqual([KANO, IKOYI.id, OJA]);
        expect(await order('-createdAt')).toEqual([OJA, IKOYI.id, KANO]);
        expect(await order('updatedAt')).toEqual([IKOYI.id, OJA, KANO]);
        expect(await order('-updatedAt')).toEqual([KANO, OJA, IKOYI.id]);
        const unsorted = await list(AGENT_1);
        expectStatus(unsorted, 200, 'default sort');
        expect(orderOf(expectAccountPage(unsorted.body, 'default'))).toEqual([IKOYI.id, KANO, OJA]);
      });

      it('pages follow the sort, with no totals: limit 2 gives two rows and a cursor, then the rest', async () => {
        const first = await list(AGENT_1, [['limit', '2']]);
        expectStatus(first, 200, 'page 1');
        const firstPage = expectAccountPage(first.body, 'page 1');
        expect(orderOf(firstPage)).toEqual([IKOYI.id, KANO]);
        expect(firstPage.nextCursor).toEqual(expect.any(String));
        expectNoTotals(first, 'page 1');

        const second = await list(AGENT_1, [
          ['limit', '2'],
          ['cursor', firstPage.nextCursor ?? ''],
        ]);
        expectStatus(second, 200, 'page 2');
        const secondPage = expectAccountPage(second.body, 'page 2');
        expect(orderOf(secondPage)).toEqual([OJA]);
        expect(secondPage.nextCursor).toBeNull();
      });

      it('ties break on id: two accounts with one name are each returned exactly once across pages', async () => {
        await plantAccount({ id: TWIN_1, programmeId: PROGRAMME_A1, name: 'Twin Holdings' });
        await plantAccount({ id: TWIN_2, programmeId: PROGRAMME_A1, name: 'Twin Holdings' });
        for (const sort of ['name', '-name']) {
          const seen: string[] = [];
          let cursor: string | null = null;
          for (let guard = 0; guard < 10; guard += 1) {
            const response = await list(AGENT_1, [
              ['sort', sort],
              ['limit', '1'],
              ...(cursor === null ? [] : ([['cursor', cursor]] as const)),
            ]);
            expectStatus(response, 200, `sort=${sort} page ${guard + 1}`);
            const page = expectAccountPage(response.body, `sort=${sort} page ${guard + 1}`);
            seen.push(...orderOf(page));
            cursor = page.nextCursor;
            if (cursor === null) break;
          }
          expect(cursor, `sort=${sort}: paging never ended`).toBeNull();
          expect(
            seen.length,
            `sort=${sort}: a row was skipped or repeated (${seen.join(', ')})`,
          ).toBe(5);
          expect(sorted(seen)).toEqual(sorted([IKOYI.id, KANO, OJA, TWIN_1, TWIN_2]));
        }
      });

      it('a cursor issued for one sort is 400 invalid_cursor under another', async () => {
        const first = await list(AGENT_1, [['limit', '1']]);
        expectStatus(first, 200, 'page 1');
        const cursor = expectAccountPage(first.body, 'page 1').nextCursor ?? '';
        expect(cursor).not.toBe('');
        const body = expectError(
          await list(AGENT_1, [
            ['sort', '-createdAt'],
            ['cursor', cursor],
          ]),
          400,
          'validation_failed',
        );
        expect(detailsOf(body)).toContainEqual({ path: 'cursor', code: 'invalid_cursor' });
      });

      it('a cursor encodes a position, never authority: the supervisor’s cursor yields only agent 1’s rows', async () => {
        const first = await list(SUPERVISOR, [['limit', '1']]);
        expectStatus(first, 200, 'supervisor page 1');
        const firstPage = expectAccountPage(first.body, 'supervisor page 1');
        expect(orderOf(firstPage)).toEqual([IKOYI.id]);
        const replayed = await list(AGENT_1, [
          ['limit', '100'],
          ['cursor', firstPage.nextCursor ?? ''],
        ]);
        expectStatus(replayed, 200, 'agent 1 with the supervisor’s cursor');
        // After "Ikoyi Traders" by name, in agent 1's scope only.
        expect(orderOf(expectAccountPage(replayed.body, 'replayed'))).toEqual([KANO, OJA]);
      });
    });
  });

  // =========================================================================
  // 4. Scope: 404 not 403, never a leak, never a client-supplied scope.
  // =========================================================================

  describe('scope', () => {
    it('get: another programme, another tenant and nowhere are one identical 404 body', async () => {
      const nowhere = await getOne(AGENT_1, NOWHERE);
      const sibling = await getOne(AGENT_1, SABON.id);
      const otherTenant = await getOne(AGENT_1, WESTLANDS.id);
      expectError(nowhere, 404, 'not_found');
      expectError(sibling, 404, 'not_found');
      expectError(otherTenant, 404, 'not_found');
      expect(sibling.body).toEqual(nowhere.body);
      expect(otherTenant.body).toEqual(nowhere.body);
      // The control: the sibling account is real and readable by someone who reaches A2.
      expectStatus(await getOne(SUPERVISOR, SABON.id), 200, 'supervisor reads A2');
    });

    it('list: every caller sees exactly the accounts of the programmes they reach', async () => {
      expect(sorted(await allIds(AGENT_1))).toEqual([IKOYI.id]);
      expect(sorted(await allIds(AGENT_2))).toEqual([SABON.id]);
      expect(sorted(await allIds(SUPERVISOR))).toEqual(sorted([IKOYI.id, SABON.id]));
      // Tenant B's user reaches B1 only; B2's account stays out.
      expect(sorted(await allIds(TENANT_B_USER))).toEqual([WESTLANDS.id]);
      expect(await allIds(TENANT_B_USER)).not.toContain(MOMBASA.id);
    });

    it('a user who reaches no programme lists nothing and reads nothing', async () => {
      // Vacuous alone; the previous test is its control (the same rows are
      // listed for every caller who reaches A1).
      expect(await allIds(NO_PROGRAMME)).toEqual([]);
      expectError(await getOne(NO_PROGRAMME, IKOYI.id), 404, 'not_found');
      expectError(await accountContacts(NO_PROGRAMME, IKOYI.id), 404, 'not_found');
    });

    it('scope headers are 400 validation_failed on every account route, and nothing is written', async () => {
      const name = unique('T0055 Header');
      const before = await accountRow(IKOYI.id);
      for (const [header, value] of SCOPE_HEADERS) {
        expectError(await list(AGENT_1).set(header, value), 400, 'validation_failed');
        expectError(await getOne(AGENT_1, SABON.id).set(header, value), 400, 'validation_failed');
        expectError(
          await accountContacts(AGENT_1, SABON.id).set(header, value),
          400,
          'validation_failed',
        );
        expectError(
          await create(SUPERVISOR, createBody({ name })).set(header, value),
          400,
          'validation_failed',
        );
        expectError(
          await update(SUPERVISOR, IKOYI.id, { version: 1, name }).set(header, value),
          400,
          'validation_failed',
        );
      }
      expect(await accountsNamed(name)).toBe(0);
      expect(await accountRow(IKOYI.id)).toEqual(before);
    });

    it('update: a tenant admin patching another tenant’s account gets 404, and the row is untouched', async () => {
      const before = await accountRow(WESTLANDS.id);
      expectError(
        await update(SUPERVISOR, WESTLANDS.id, { version: 1, name: 'Hijacked' }),
        404,
        'not_found',
      );
      expect(await accountRow(WESTLANDS.id)).toEqual(before);
    });

    it('update: a programme admin patching a sibling programme’s account gets 404, not 403', async () => {
      // Agent 2 holds `admin` in A2 only: a writer, but A1 is out of reach.
      await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A2, 'admin');
      const before = await accountRow(IKOYI.id);
      expectError(
        await update(AGENT_2, IKOYI.id, { version: Number(before?.version), name: 'Hijacked' }),
        404,
        'not_found',
      );
      expect(await accountRow(IKOYI.id)).toEqual(before);
      // A non-writer on an unreachable record is 404 too, never 403 (D-L53 order).
      expectError(
        await update(AGENT_1, SABON.id, { version: await versionOf(SABON.id), tier: 'sme' }),
        404,
        'not_found',
      );
      // The control: agent 2's write in its own programme works.
      expectStatus(
        await update(AGENT_2, SABON.id, { version: await versionOf(SABON.id), tier: 'sme' }),
        200,
        'agent 2 writes in A2',
      );
    });

    it('create: an unreachable programmeId is 404 — sibling, other tenant, nowhere — one body, nothing written', async () => {
      await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'admin');
      const count = await accountCount();
      const bodies: Json[] = [];
      for (const programmeId of [PROGRAMME_A2, PROGRAMME_B1, NOWHERE]) {
        bodies.push(
          expectError(await create(AGENT_1, createBody({ programmeId })), 404, 'not_found'),
        );
      }
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
      expect(await accountCount()).toBe(count);
      // The control: the same writer creates in the programme it reaches.
      expectStatus(await create(AGENT_1, createBody()), 201, 'agent 1 creates in A1');
    });

    it('create without programmeId: 400 at programmeId for a writer reaching several, the one programme for a writer reaching one', async () => {
      const name = unique('T0055 NoTarget');
      const several = expectError(await create(SUPERVISOR, { name }), 400, 'validation_failed');
      expect(detailsOf(several).map((detail) => detail.path)).toContain('programmeId');
      expect(await accountsNamed(name)).toBe(0);

      await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'admin');
      const one = await create(AGENT_1, { name });
      expectStatus(one, 201, 'single-programme create');
      expect(expectAccount(one.body, 'single-programme create').programmeId).toBe(PROGRAMME_A1);
    });

    it('create by a user who reaches no programme writes nothing', async () => {
      // The contract names only "exactly one" and "several" programmes. Zero
      // may be 400 (no target), 403 (no account.write anywhere) or 404 (an
      // unreachable target); a write is not. The Error envelope is required,
      // so Nest's bare "Cannot POST" 404 does not pass this on main.
      const codeFor: Record<number, string> = {
        400: 'validation_failed',
        403: 'not_permitted',
        404: 'not_found',
      };
      const name = unique('T0055 Orphan');
      const response = await create(NO_PROGRAMME, { name });
      expect([400, 403, 404], JSON.stringify(response.body)).toContain(response.status);
      expectError(response, response.status, codeFor[response.status] ?? 'unexpected');
      expect(await accountsNamed(name)).toBe(0);
      const targeted = await create(NO_PROGRAMME, { programmeId: PROGRAMME_A1, name });
      expect([403, 404], JSON.stringify(targeted.body)).toContain(targeted.status);
      expectError(targeted, targeted.status, codeFor[targeted.status] ?? 'unexpected');
      expect(await accountsNamed(name)).toBe(0);
    });
  });

  // =========================================================================
  // 5. listAccountContacts.
  // =========================================================================

  describe('listAccountContacts: the account’s reachable contacts', () => {
    beforeEach(async () => {
      await linkContacts(IKOYI.id, [AMAKA.id, BASHIR.id]);
      await linkContacts(SABON.id, [DAMILOLA.id]);
      await plantAccount({ id: EMPTY_ACCOUNT, programmeId: PROGRAMME_A1, name: 'Empty Ventures' });
    });

    it('returns a ContactPage of exactly the linked contacts, by displayName, no totals', async () => {
      const response = await accountContacts(AGENT_1, IKOYI.id);
      expectStatus(response, 200, 'listAccountContacts');
      const page = expectContactPage(response.body, 'listAccountContacts');
      // Amaka Obi, Bashir Lawal; Chioma (A1, unlinked) is not there.
      expect(orderOf(page)).toEqual([AMAKA.id, BASHIR.id]);
      for (const row of page.data) expect(row.accountId).toBe(IKOYI.id);
      expect(page.nextCursor).toBeNull();
      expectNoTotals(response, 'listAccountContacts');
      expectNotShared(response, 'listAccountContacts');
      expect(orderOf(page)).not.toContain(CHIOMA.id);
    });

    it('sorts by its enum only, and pages by keyset', async () => {
      const reversed = await accountContacts(AGENT_1, IKOYI.id, [['sort', '-displayName']]);
      expectStatus(reversed, 200, '-displayName');
      expect(orderOf(expectContactPage(reversed.body, '-displayName'))).toEqual([
        BASHIR.id,
        AMAKA.id,
      ]);
      for (const sort of ['givenNames', 'emails', 'phones', 'accountId']) {
        expectError(
          await accountContacts(AGENT_1, IKOYI.id, [['sort', sort]]),
          400,
          'validation_failed',
        );
      }
      const first = await accountContacts(AGENT_1, IKOYI.id, [['limit', '1']]);
      expectStatus(first, 200, 'page 1');
      const firstPage = expectContactPage(first.body, 'page 1');
      expect(orderOf(firstPage)).toEqual([AMAKA.id]);
      const second = await accountContacts(AGENT_1, IKOYI.id, [
        ['limit', '1'],
        ['cursor', firstPage.nextCursor ?? ''],
      ]);
      expectStatus(second, 200, 'page 2');
      const secondPage = expectContactPage(second.body, 'page 2');
      expect(orderOf(secondPage)).toEqual([BASHIR.id]);
      expect(secondPage.nextCursor).toBeNull();
    });

    it('a reachable account with no contacts is an empty page, not a 404', async () => {
      const response = await accountContacts(AGENT_1, EMPTY_ACCOUNT);
      expectStatus(response, 200, 'empty account');
      const page = expectContactPage(response.body, 'empty account');
      expect(page.data).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });

    it('an unreachable account is 404, identical for sibling, other tenant and nowhere', async () => {
      const nowhere = await accountContacts(AGENT_1, NOWHERE);
      const sibling = await accountContacts(AGENT_1, SABON.id);
      const otherTenant = await accountContacts(AGENT_1, WESTLANDS.id);
      for (const response of [nowhere, sibling, otherTenant])
        expectError(response, 404, 'not_found');
      expect(sibling.body).toEqual(nowhere.body);
      expect(otherTenant.body).toEqual(nowhere.body);
      // The control: the A2 account has a contact, for someone who reaches A2.
      const supervisor = await accountContacts(SUPERVISOR, SABON.id);
      expectStatus(supervisor, 200, 'supervisor reads A2’s contacts');
      expect(idsOf(expectContactPage(supervisor.body, 'supervisor'))).toEqual([DAMILOLA.id]);
    });

    it('a withheld contact accountId is 400 field_withheld at accountId, and no row is returned', async () => {
      await lockField('contact', 'account_id', 'agent', 'none');
      const response = await accountContacts(AGENT_1, IKOYI.id);
      const body = expectError(response, 400, 'validation_failed');
      expect(detailsOf(body)).toContainEqual({ path: 'accountId', code: 'field_withheld' });
      const text = JSON.stringify(response.body);
      for (const id of [AMAKA.id, BASHIR.id]) expect(text).not.toContain(id);
      // The control: the admin set (never withheld) lists them.
      const admin = await accountContacts(SUPERVISOR, IKOYI.id);
      expectStatus(admin, 200, 'admin');
      expect(idsOf(expectContactPage(admin.body, 'admin'))).toEqual(sorted([AMAKA.id, BASHIR.id]));
    });

    it('reachability is judged before field security: an unreachable account is 404 even when accountId is withheld', async () => {
      await lockField('contact', 'account_id', 'agent', 'none');
      const unreachable = await accountContacts(AGENT_1, SABON.id);
      const nowhere = await accountContacts(AGENT_1, NOWHERE);
      expectError(unreachable, 404, 'not_found');
      expect(unreachable.body).toEqual(nowhere.body);
    });

    it('the withheld rule is judged in the ACCOUNT’s programme', async () => {
      // Agent 2: admin in A1 (never withheld), agent in A2 (accountId withheld).
      await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A1, 'admin');
      await lockField('contact', 'account_id', 'agent', 'none');
      const inA1 = await accountContacts(AGENT_2, IKOYI.id);
      expectStatus(inA1, 200, 'A1, admin');
      expect(idsOf(expectContactPage(inA1.body, 'A1'))).toEqual(sorted([AMAKA.id, BASHIR.id]));
      const inA2 = expectError(await accountContacts(AGENT_2, SABON.id), 400, 'validation_failed');
      expect(detailsOf(inA2)).toContainEqual({ path: 'accountId', code: 'field_withheld' });
    });

    it('rows are under Contact field security: a withheld contact field is omitted and listed', async () => {
      const probe = 'amaka.t0055-probe@example.test';
      await observer.query('UPDATE contact SET emails = $2::jsonb WHERE id = $1', [
        AMAKA.id,
        JSON.stringify([probe]),
      ]);
      await lockField('contact', 'emails', 'agent', 'none');
      const response = await accountContacts(AGENT_1, IKOYI.id);
      expectStatus(response, 200, 'listAccountContacts');
      const page = expectContactPage(response.body, 'withheld emails');
      expect(page.data.length).toBe(2);
      for (const row of page.data) {
        expect('emails' in row, 'emails must be omitted, not nulled').toBe(false);
        expect(row.withheldFields).toContain('emails');
      }
      expect(JSON.stringify(response.body)).not.toContain(probe);
    });
  });

  // =========================================================================
  // 6. Permissions (S1, D-P18): account writes are admin-only.
  // =========================================================================

  describe('permissions: writes need account.write in the target programme', () => {
    it.each(NON_WRITER_KEYS)(
      'the %s set may not create or update: 403 not_permitted, nothing written, nothing audited',
      async (key) => {
        await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, key);
        const audit = await auditIds();
        const name = unique(`T0055 ${key}`);
        expectError(await create(AGENT_1, createBody({ name })), 403, 'not_permitted');
        expect(await accountsNamed(name)).toBe(0);

        const before = await accountRow(IKOYI.id);
        expectError(
          await update(AGENT_1, IKOYI.id, { version: Number(before?.version), tier: 'enterprise' }),
          403,
          'not_permitted',
        );
        // Not even the agent's D-P14 contact rights carry over: owner to self.
        expectError(
          await update(AGENT_1, IKOYI.id, {
            version: Number(before?.version),
            ownerUserId: USER_A_AGENT_1,
          }),
          403,
          'not_permitted',
        );
        expect(await accountRow(IKOYI.id)).toEqual(before);
        expect(await auditSince(audit)).toEqual([]);
        // The control: the same caller can read the record it may not write.
        expectStatus(await getOne(AGENT_1, IKOYI.id), 200, `${key} reads`);
      },
    );

    it('the admin set held in the programme permits both writes, without the tenant-admin flag', async () => {
      await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'admin');
      expectStatus(await create(AGENT_1, createBody()), 201, 'programme admin creates');
      expectStatus(
        await update(AGENT_1, IKOYI.id, { version: await versionOf(IKOYI.id), tier: 'sme' }),
        200,
        'programme admin updates',
      );
    });

    it('the tenant-admin flag permits both writes whatever set is held (D-L53)', async () => {
      await setTenantAdmin(USER_A_AGENT_1, true);
      expectStatus(await create(AGENT_1, createBody()), 201, 'tenant admin creates');
      expectStatus(
        await update(AGENT_1, IKOYI.id, { version: await versionOf(IKOYI.id), tier: 'sme' }),
        200,
        'tenant admin updates',
      );
    });

    it('the permission is per programme: admin in A2 does not permit writing in A1', async () => {
      await setTenantAdmin(USER_A_SUPERVISOR, false);
      await assign(TENANT_A, USER_A_SUPERVISOR, PROGRAMME_A1, 'team_lead');
      await assign(TENANT_A, USER_A_SUPERVISOR, PROGRAMME_A2, 'admin');

      expectError(
        await create(SUPERVISOR, createBody({ programmeId: PROGRAMME_A1 })),
        403,
        'not_permitted',
      );
      expectStatus(
        await create(SUPERVISOR, createBody({ programmeId: PROGRAMME_A2 })),
        201,
        'create in A2',
      );
      expectError(
        await update(SUPERVISOR, IKOYI.id, { version: await versionOf(IKOYI.id), tier: 'sme' }),
        403,
        'not_permitted',
      );
      expectStatus(
        await update(SUPERVISOR, SABON.id, { version: await versionOf(SABON.id), tier: 'sme' }),
        200,
        'update in A2',
      );
    });

    it('the decision is re-read on every request: a revoked set refuses the very next write', async () => {
      await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'admin');
      expectStatus(
        await update(AGENT_1, IKOYI.id, { version: await versionOf(IKOYI.id), tier: 'sme' }),
        200,
        'first write',
      );
      await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'programme_manager');
      expectError(
        await update(AGENT_1, IKOYI.id, { version: await versionOf(IKOYI.id), tier: 'enterprise' }),
        403,
        'not_permitted',
      );
    });

    it('403 comes before 400: an unpermitted caller learns nothing from validation (D-L53)', async () => {
      expectError(
        await create(AGENT_1, { programmeId: PROGRAMME_A1, name: '', tier: 'Gold', bogus: 1 }),
        403,
        'not_permitted',
      );
      expectError(
        await update(AGENT_1, IKOYI.id, {
          version: await versionOf(IKOYI.id),
          phones: [{ type: 'fax', e164: '0803' }],
          programmeId: PROGRAMME_A2,
        }),
        403,
        'not_permitted',
      );
      // A non-writer who reaches two programmes and omits programmeId: the
      // contract decides 403 "before the body is read", so it never learns
      // that it reaches several.
      await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A1, 'team_lead');
      expectError(await create(AGENT_2, { name: unique('T0055 Count') }), 403, 'not_permitted');
    });

    it('400 comes before 409: a stale version with a bad body is 400', async () => {
      const version = await versionOf(IKOYI.id);
      expectStatus(await update(SUPERVISOR, IKOYI.id, { version, tier: 'sme' }), 200, 'first');
      const before = await accountRow(IKOYI.id);
      // `version` is now stale.
      expectError(
        await update(SUPERVISOR, IKOYI.id, { version, tier: 'Gold' }),
        400,
        'validation_failed',
      );
      const reference = expectError(
        await update(SUPERVISOR, IKOYI.id, { version, ownerUserId: NOWHERE }),
        400,
        'validation_failed',
      );
      expect(detailsOf(reference)).toContainEqual({
        path: 'ownerUserId',
        code: 'unknown_reference',
      });
      expect(await accountRow(IKOYI.id)).toEqual(before);
    });
  });

  // =========================================================================
  // 7. Closed bodies, value sets, E.164 (and D-L76).
  // =========================================================================

  describe('closed bodies and values', () => {
    it.each([
      ['id', { id: NOWHERE }],
      ['version', { version: 1 }],
      ['owner', { owner: { id: USER_A_SUPERVISOR, displayName: 'Musa Bello' } }],
      ['createdAt', { createdAt: '2026-01-01T00:00:00Z' }],
      ['updatedAt', { updatedAt: '2026-01-01T00:00:00Z' }],
      ['withheldFields', { withheldFields: [] }],
      ['tenantId', { tenantId: TENANT_B }],
      ['a Health score', { health: 90 }],
      ['an unknown property', { website: 'https://example.test' }],
    ])('create with %s is 400 and writes nothing', async (_label, extra) => {
      const name = unique('T0055 Closed');
      expectError(
        await create(SUPERVISOR, createBody({ name, ...extra })),
        400,
        'validation_failed',
      );
      expect(await accountsNamed(name)).toBe(0);
    });

    it.each([
      ['programmeId to a sibling (D-L76)', { programmeId: PROGRAMME_A2 }],
      ['programmeId equal to its own programme', { programmeId: PROGRAMME_A1 }],
      ['programmeId alongside a valid field', { programmeId: PROGRAMME_A2, tier: 'sme' }],
      ['programme_id', { programme_id: PROGRAMME_A2 }],
      ['tenantId', { tenantId: TENANT_B }],
      ['id', { id: NOWHERE }],
      ['owner', { owner: { id: USER_A_SUPERVISOR, displayName: 'Musa Bello' } }],
      ['createdAt', { createdAt: '2026-01-01T00:00:00Z' }],
      ['withheldFields', { withheldFields: [] }],
    ])(
      'update with %s is 400 and the row, programme included, is unchanged',
      async (_label, extra) => {
        const before = await accountRow(IKOYI.id);
        expectError(
          await update(SUPERVISOR, IKOYI.id, { version: Number(before?.version), ...extra }),
          400,
          'validation_failed',
        );
        expect(await accountRow(IKOYI.id)).toEqual(before);
      },
    );

    it('a raw __proto__ key carrying programmeId is refused, and the account stays in A1', async () => {
      const before = await accountRow(IKOYI.id);
      const raw = `{"version":${Number(before?.version)},"name":"T0055 Proto","__proto__":{"programmeId":"${PROGRAMME_A2}"}}`;
      const response = await request(server())
        .patch(accountPath(IKOYI.id))
        .set(SUPERVISOR)
        .set('Content-Type', 'application/json')
        .send(raw);
      expectError(response, 400, 'validation_failed');
      expect(await accountRow(IKOYI.id)).toEqual(before);
    });

    it('a hierarchy cannot be carried into another programme: parent and child both stay', async () => {
      // 0026's header: one UPDATE naming a whole hierarchy can move it across
      // programmes the session reaches. The API must never issue one.
      await plantAccount({ id: PARENT, programmeId: PROGRAMME_A1, name: 'Group Parent' });
      await plantAccount({
        id: CHILD,
        programmeId: PROGRAMME_A1,
        name: 'Group Child',
        parentAccountId: PARENT,
      });
      for (const id of [PARENT, CHILD]) {
        expectError(
          await update(SUPERVISOR, id, { version: await versionOf(id), programmeId: PROGRAMME_A2 }),
          400,
          'validation_failed',
        );
      }
      expect((await accountRow(PARENT))?.programme_id).toBe(PROGRAMME_A1);
      expect((await accountRow(CHILD))?.programme_id).toBe(PROGRAMME_A1);
    });

    it.each(['08031234567', '+234 803 123 4567', '2348031234567', '+0803123456', 'not-a-number'])(
      'a phone written as %s is 400 at phones.0.e164 on create and update, and is not echoed',
      async (e164) => {
        const name = unique('T0055 Phone');
        const created = expectError(
          await create(SUPERVISOR, createBody({ name, phones: [{ type: 'work', e164 }] })),
          400,
          'validation_failed',
        );
        expect(detailsOf(created).map((detail) => detail.path)).toContain('phones.0.e164');
        expect(JSON.stringify(created)).not.toContain(e164);
        expect(await accountsNamed(name)).toBe(0);

        const before = await accountRow(IKOYI.id);
        expectError(
          await update(SUPERVISOR, IKOYI.id, {
            version: Number(before?.version),
            phones: [{ type: 'work', e164 }],
          }),
          400,
          'validation_failed',
        );
        expect(await accountRow(IKOYI.id)).toEqual(before);
      },
    );

    it.each([
      [
        'a phone with an extra key (Phone is closed)',
        { phones: [{ type: 'work', e164: '+2348030055201', dnd: true }] },
      ],
      ['a phone type outside the enum', { phones: [{ type: 'fax', e164: '+2348030055202' }] }],
      ['a tier display label', { tier: 'Enterprise' }],
      ['an empty name', { name: '' }],
      ['a 201-character name', { name: 'N'.repeat(201) }],
      ['an empty industry', { industry: '' }],
      ['a 65-character industry', { industry: 'I'.repeat(65) }],
      ['a 65-character state', { state: 'S'.repeat(65) }],
      ['a 65-character tag', { tags: ['T'.repeat(65)] }],
      ['51 tags', { tags: Array.from({ length: 51 }, (_, i) => `tag-${i}`) }],
      [
        '11 phones',
        {
          phones: Array.from({ length: 11 }, (_, i) => ({
            type: 'work',
            e164: `+23480300553${String(i).padStart(2, '0')}`,
          })),
        },
      ],
      ['a NUL character in the name (text cannot store it)', { name: 'Acme\u0000 Ltd' }],
      ['a NUL character in a tag', { tags: ['ok', 'bad\u0000tag'] }],
      ['a non-uuid ownerUserId', { ownerUserId: 'me' }],
      ['a non-uuid parentAccountId', { parentAccountId: 'top' }],
    ])(
      'create with %s is 400 validation_failed, never 500, and writes nothing',
      async (_label, extra) => {
        const count = await accountCount();
        expectError(await create(SUPERVISOR, createBody(extra)), 400, 'validation_failed');
        expect(await accountCount()).toBe(count);
      },
    );

    it('the boundaries themselves are accepted: a 200-character name, 50 tags, 10 phones', async () => {
      const response = await create(
        SUPERVISOR,
        createBody({
          name: 'N'.repeat(200),
          tags: Array.from({ length: 50 }, (_, i) => `tag-${i}`),
          phones: Array.from({ length: 10 }, (_, i) => ({
            type: 'work',
            e164: `+23480300554${String(i).padStart(2, '0')}`,
          })),
        }),
      );
      expectStatus(response, 201, 'boundaries');
      expectAccount(response.body, 'boundaries');
    });

    it('update: version is required, a body must change something, and name cannot be cleared', async () => {
      const before = await accountRow(IKOYI.id);
      const version = Number(before?.version);
      for (const body of [
        { tier: 'sme' },
        { version },
        { version, name: null },
        { version: 0, tier: 'sme' },
      ]) {
        expectError(await update(SUPERVISOR, IKOYI.id, body), 400, 'validation_failed');
      }
      expect(await accountRow(IKOYI.id)).toEqual(before);
    });

    it('update is partial: absent is unchanged, null clears, lists are replaced whole', async () => {
      await setAccount(IKOYI.id, {
        industry: 'Retail',
        tier: 'enterprise',
        tags: ['A', 'B'],
        phones: JSON.stringify([{ type: 'work', e164: '+2348030055301' }]),
        state: 'Lagos',
        lga: 'Ikeja',
        owner_user_id: USER_A_AGENT_1,
        parent_account_id: null,
      });
      const response = await update(SUPERVISOR, IKOYI.id, {
        version: await versionOf(IKOYI.id),
        tier: null,
        ownerUserId: null,
        tags: ['C'],
      });
      expectStatus(response, 200, 'partial update');
      expect(expectAccount(response.body, 'partial update')).toMatchObject({
        industry: 'Retail',
        tier: null,
        tags: ['C'],
        phones: [{ type: 'work', e164: '+2348030055301' }],
        state: 'Lagos',
        lga: 'Ikeja',
        ownerUserId: null,
        owner: null,
      });
      const row = await accountRow(IKOYI.id);
      expect(row?.tier).toBeNull();
      expect(row?.owner_user_id).toBeNull();
      expect(row?.tags).toEqual(['C']);
      expect(row?.industry).toBe('Retail');
    });
  });

  // =========================================================================
  // 8. References: owner (D-L67) and parent (same programme, no cycle, depth 5).
  // =========================================================================

  describe('references', () => {
    describe('owner must be a member of the account’s programme (D-L67)', () => {
      it('update: a real user elsewhere is indistinguishable from an invented id; a member is accepted', async () => {
        // Agent 1 writes in A1 only.
        await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'admin');
        const before = await accountRow(IKOYI.id);
        const version = Number(before?.version);
        const responses: Json[] = [];
        for (const ownerUserId of [NOWHERE, USER_A_AGENT_2, USER_A_NO_PROGRAMME, USER_B_AGENT_1]) {
          const response = await update(AGENT_1, IKOYI.id, { version, ownerUserId });
          const body = expectError(response, 400, 'validation_failed');
          expect(detailsOf(body)).toContainEqual({
            path: 'ownerUserId',
            code: 'unknown_reference',
          });
          responses.push(response.body as Json);
        }
        for (const body of responses.slice(1)) expect(body).toEqual(responses[0]);
        expect(await accountRow(IKOYI.id)).toEqual(before);

        // The control, without which four identical refusals pass on a server
        // that refuses everything.
        const legitimate = await update(AGENT_1, IKOYI.id, {
          version,
          ownerUserId: USER_A_SUPERVISOR,
        });
        expectStatus(legitimate, 200, 'a member of A1 as owner');
        expect(expectAccount(legitimate.body, 'member owner').owner).toEqual({
          id: USER_A_SUPERVISOR,
          displayName: displayNameOf(USER_A_SUPERVISOR),
        });
      });

      it('create: the same rule, judged in the target programme', async () => {
        const responses: Json[] = [];
        for (const ownerUserId of [NOWHERE, USER_A_AGENT_1, USER_B_AGENT_1]) {
          const name = unique('T0055 Owner');
          // Agent 1 is a real user, but a member of A1 only; the target is A2.
          const response = await create(SUPERVISOR, {
            programmeId: PROGRAMME_A2,
            name,
            ownerUserId,
          });
          const body = expectError(response, 400, 'validation_failed');
          expect(detailsOf(body)).toContainEqual({
            path: 'ownerUserId',
            code: 'unknown_reference',
          });
          expect(await accountsNamed(name)).toBe(0);
          responses.push(response.body as Json);
        }
        for (const body of responses.slice(1)) expect(body).toEqual(responses[0]);
        const legitimate = await create(SUPERVISOR, {
          programmeId: PROGRAMME_A2,
          name: unique('T0055 Owner ok'),
          ownerUserId: USER_A_AGENT_2,
        });
        expectStatus(legitimate, 201, 'a member of A2 as owner');
      });

      it('a writer who reaches both programmes still cannot assign an A1-only user to an A2 account', async () => {
        const before = await accountRow(SABON.id);
        const version = Number(before?.version);
        const crossed = await update(SUPERVISOR, SABON.id, {
          version,
          ownerUserId: USER_A_AGENT_1,
        });
        const invented = await update(SUPERVISOR, SABON.id, { version, ownerUserId: NOWHERE });
        expectError(crossed, 400, 'validation_failed');
        expect(crossed.body).toEqual(invented.body);
        expect(await accountRow(SABON.id)).toEqual(before);
      });
    });

    describe('parent must be an account in the same programme', () => {
      it('another programme’s account (even one the writer can read), another tenant’s, or none: one 400 body', async () => {
        const name = unique('T0055 Parent');
        const responses: Json[] = [];
        for (const parentAccountId of [NOWHERE, IKOYI.id, WESTLANDS.id]) {
          const response = await create(SUPERVISOR, {
            programmeId: PROGRAMME_A2,
            name,
            parentAccountId,
          });
          const body = expectError(response, 400, 'validation_failed');
          expect(detailsOf(body)).toContainEqual({
            path: 'parentAccountId',
            code: 'unknown_reference',
          });
          responses.push(response.body as Json);
        }
        for (const body of responses.slice(1)) expect(body).toEqual(responses[0]);
        expect(await accountsNamed(name)).toBe(0);

        const before = await accountRow(SABON.id);
        const crossed = await update(SUPERVISOR, SABON.id, {
          version: Number(before?.version),
          parentAccountId: IKOYI.id,
        });
        expectError(crossed, 400, 'validation_failed');
        expect(crossed.body).toEqual(responses[0]);
        expect(await accountRow(SABON.id)).toEqual(before);

        // The control: a parent in the same programme is accepted.
        const legitimate = await create(SUPERVISOR, {
          programmeId: PROGRAMME_A1,
          name: unique('T0055 Parent ok'),
          parentAccountId: IKOYI.id,
        });
        expectStatus(legitimate, 201, 'a parent in A1');
        expect(expectAccount(legitimate.body, 'parented').parentAccountId).toBe(IKOYI.id);
      });
    });

    describe('no cycles, depth at most 5 (D-L74)', () => {
      beforeEach(async () => {
        await plantAccount({ id: PARENT, programmeId: PROGRAMME_A1, name: 'Cycle Parent' });
        await plantAccount({
          id: CHILD,
          programmeId: PROGRAMME_A1,
          name: 'Cycle Child',
          parentAccountId: PARENT,
        });
        await plantAccount({
          id: GRANDCHILD,
          programmeId: PROGRAMME_A1,
          name: 'Cycle Grandchild',
          parentAccountId: CHILD,
        });
        for (const [index, id] of CHAIN.entries()) {
          await plantAccount({
            id,
            programmeId: PROGRAMME_A1,
            name: `Chain Level ${index + 1}`,
            parentAccountId: index === 0 ? null : (CHAIN[index - 1] ?? null),
          });
        }
      });

      const expectParentRefusal = (response: request.Response, code: string) => {
        const body = expectError(response, 400, 'validation_failed');
        expect(detailsOf(body)).toContainEqual({ path: 'parentAccountId', code });
      };

      it('closing a cycle is 400 parent_cycle at parentAccountId, and nothing changes', async () => {
        const before = await accountRow(PARENT);
        expectParentRefusal(
          await update(SUPERVISOR, PARENT, {
            version: Number(before?.version),
            parentAccountId: GRANDCHILD,
          }),
          'parent_cycle',
        );
        expectParentRefusal(
          await update(SUPERVISOR, PARENT, {
            version: Number(before?.version),
            parentAccountId: CHILD,
          }),
          'parent_cycle',
        );
        expect(await accountRow(PARENT)).toEqual(before);
      });

      it('an account as its own parent is 400 parent_cycle, never a 500 from the database CHECK', async () => {
        const before = await accountRow(CHILD);
        expectParentRefusal(
          await update(SUPERVISOR, CHILD, {
            version: Number(before?.version),
            parentAccountId: CHILD,
          }),
          'parent_cycle',
        );
        expect(await accountRow(CHILD)).toEqual(before);
      });

      it('a new account under a depth-5 account is 400 parent_depth; under depth 4 it is accepted', async () => {
        const name = unique('T0055 Deep');
        expectParentRefusal(
          await create(SUPERVISOR, createBody({ name, parentAccountId: CHAIN[4] })),
          'parent_depth',
        );
        expect(await accountsNamed(name)).toBe(0);
        const atCap = await create(SUPERVISOR, createBody({ parentAccountId: CHAIN[3] }));
        expectStatus(atCap, 201, 'depth 5 is allowed');
      });

      it('a re-parent counts the subtree that moves with it', async () => {
        // X (top) with one child: moving X under depth 4 puts the child at 6.
        await plantAccount({ id: ROOT_X, programmeId: PROGRAMME_A1, name: 'Mover' });
        await plantAccount({
          id: ROOT_X_CHILD,
          programmeId: PROGRAMME_A1,
          name: 'Mover Child',
          parentAccountId: ROOT_X,
        });
        const before = await accountRow(ROOT_X);
        expectParentRefusal(
          await update(SUPERVISOR, ROOT_X, {
            version: Number(before?.version),
            parentAccountId: CHAIN[3],
          }),
          'parent_depth',
        );
        expect(await accountRow(ROOT_X)).toEqual(before);
        // Under depth 3 instead, the child lands at exactly 5.
        const moved = await update(SUPERVISOR, ROOT_X, {
          version: Number(before?.version),
          parentAccountId: CHAIN[2],
        });
        expectStatus(moved, 200, 'a re-parent within the cap');
        expect(expectAccount(moved.body, 'moved').parentAccountId).toBe(CHAIN[2]);
      });

      it('two concurrent half-cycles: exactly one wins, the other is 400 parent_cycle, never a 500', async () => {
        // Whichever request the database guard serialises second must be
        // refused, whether the API's own check or the guard's 23514 catches it.
        await plantAccount({ id: RACE_1, programmeId: PROGRAMME_A1, name: 'Race One' });
        await plantAccount({ id: RACE_2, programmeId: PROGRAMME_A1, name: 'Race Two' });
        const [one, two] = await Promise.all([
          update(SUPERVISOR, RACE_1, { version: await versionOf(RACE_1), parentAccountId: RACE_2 }),
          update(SUPERVISOR, RACE_2, { version: await versionOf(RACE_2), parentAccountId: RACE_1 }),
        ]);
        const statuses = [one.status, two.status].sort();
        expect(statuses, `${JSON.stringify(one.body)}\n${JSON.stringify(two.body)}`).toEqual([
          200, 400,
        ]);
        const loser = one.status === 400 ? one : two;
        expectParentRefusal(loser, 'parent_cycle');
        const parents = [
          (await accountRow(RACE_1))?.parent_account_id ?? null,
          (await accountRow(RACE_2))?.parent_account_id ?? null,
        ];
        expect(
          parents.filter((parent) => parent !== null),
          'exactly one link committed',
        ).toHaveLength(1);
      });
    });
  });

  // =========================================================================
  // 9. Optimistic concurrency.
  // =========================================================================

  describe('optimistic concurrency', () => {
    it('a successful update bumps version by exactly 1, in the response and the row', async () => {
      const before = await versionOf(IKOYI.id);
      const read = expectAccount((await getOne(SUPERVISOR, IKOYI.id).expect(200)).body, 'read');
      expect(read.version, 'getAccount serves the stored version').toBe(before);
      const response = await update(SUPERVISOR, IKOYI.id, { version: before, industry: 'Retail' });
      expectStatus(response, 200, 'update');
      const account = expectAccount(response.body, 'updated');
      expect(account.version).toBe(before + 1);
      expect(await versionOf(IKOYI.id)).toBe(before + 1);
      expect(Date.parse(account.updatedAt as string)).toBeGreaterThan(
        Date.parse(read.updatedAt as string),
      );
    });

    it('a stale version is 409 stale_write, a future one too, and nothing is applied', async () => {
      const version = await versionOf(IKOYI.id);
      expectStatus(await update(SUPERVISOR, IKOYI.id, { version, tier: 'sme' }), 200, 'first');
      const before = await accountRow(IKOYI.id);
      expectError(
        await update(SUPERVISOR, IKOYI.id, { version, tier: 'enterprise' }),
        409,
        'stale_write',
      );
      expectError(
        await update(SUPERVISOR, IKOYI.id, { version: version + 5, tier: 'enterprise' }),
        409,
        'stale_write',
      );
      expect(await accountRow(IKOYI.id)).toEqual(before);
    });

    it('concurrent updates with one version: exactly one succeeds, the rest are 409, one audit event', async () => {
      // Deterministic for a conditional UPDATE on version or a row lock; a
      // read-check-write without either is likely, not certain, to let two
      // through. A detector, not a proof.
      const version = await versionOf(IKOYI.id);
      const audit = await auditIds();
      const names = [1, 2, 3, 4, 5].map((n) => `Concurrent Rename ${n}`);
      const responses = await Promise.all(
        names.map((name) => update(SUPERVISOR, IKOYI.id, { version, name })),
      );
      const codes = responses.map((response) => response.status).sort();
      expect(codes, responses.map((r) => JSON.stringify(r.body)).join('\n')).toEqual([
        200, 409, 409, 409, 409,
      ]);
      for (const loser of responses.filter((response) => response.status === 409)) {
        expectError(loser, 409, 'stale_write');
      }
      const winner = responses.find((response) => response.status === 200);
      const row = await accountRow(IKOYI.id);
      expect(Number(row?.version)).toBe(version + 1);
      expect(row?.name).toBe((winner?.body as Json).name);
      expect(
        (await auditSince(audit)).filter((event) => event.object_id === IKOYI.id),
      ).toHaveLength(1);
    });
  });

  // =========================================================================
  // 10. Field security (S3).
  // =========================================================================

  describe('field security: omitted, never nulled; the flag does not lift it', () => {
    const PROBE_PHONE = '+2348030055401';

    beforeEach(async () => {
      await setAccount(IKOYI.id, {
        tier: 'enterprise',
        industry: 'Banking',
        owner_user_id: USER_A_AGENT_1,
        phones: JSON.stringify([{ type: 'work', e164: PROBE_PHONE }]),
      });
      await lockField('account', 'tier', 'agent', 'none');
    });

    it('list and get omit a withheld field and name it; the admin set still sees it', async () => {
      const listed = await list(AGENT_1);
      expectStatus(listed, 200, 'agent list');
      const page = expectAccountPage(listed.body, 'agent list');
      expect(page.data.length).toBe(1);
      for (const row of [
        ...page.data,
        expectAccount((await getOne(AGENT_1, IKOYI.id).expect(200)).body, 'agent get'),
      ]) {
        expect('tier' in row, 'tier must be omitted, not nulled').toBe(false);
        expect(row.withheldFields).toContain('tier');
        expect(row.industry, 'a field that is not withheld is still sent').toBe('Banking');
      }
      const admin = expectAccount((await getOne(SUPERVISOR, IKOYI.id).expect(200)).body, 'admin');
      expect(admin.tier).toBe('enterprise');
      expect(admin.withheldFields).not.toContain('tier');
    });

    it('a withheld owner takes owner with it: both omitted, both listed, no name sent', async () => {
      await lockField('account', 'owner_user_id', 'agent', 'none');
      const response = await getOne(AGENT_1, IKOYI.id);
      expectStatus(response, 200, 'agent get');
      const account = expectAccount(response.body, 'withheld owner');
      expect('ownerUserId' in account).toBe(false);
      expect('owner' in account).toBe(false);
      expect(account.withheldFields).toEqual(expect.arrayContaining(['ownerUserId', 'owner']));
      expect(JSON.stringify(response.body)).not.toContain(displayNameOf(USER_A_AGENT_1));
      expect(JSON.stringify(response.body)).not.toContain(USER_A_AGENT_1);
    });

    it('a withheld phone list sends no number in any form', async () => {
      await lockField('account', 'phones', 'agent', 'none');
      const response = await getOne(AGENT_1, IKOYI.id);
      expectStatus(response, 200, 'agent get');
      const account = expectAccount(response.body, 'withheld phones');
      expect('phones' in account).toBe(false);
      for (const form of phoneForms(PROBE_PHONE)) {
        expect(JSON.stringify(response.body)).not.toContain(form);
      }
    });

    it('name is never withheld, even if a grant row says none (sort=name depends on it)', async () => {
      await lockField('account', 'name', 'agent', 'none');
      const account = expectAccount(
        (await getOne(AGENT_1, IKOYI.id).expect(200)).body,
        'name grant none',
      );
      expect(account.name).toBe(IKOYI.name);
      expect(account.withheldFields).not.toContain('name');
    });

    it('the locked admin set is never restricted, whatever a stored row says', async () => {
      await lockField('account', 'tier', 'admin', 'none');
      await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'admin');
      const account = expectAccount((await getOne(AGENT_1, IKOYI.id).expect(200)).body, 'admin');
      expect(account.tier).toBe('enterprise');
    });

    it('withholding is decided per row, by the set held in THAT row’s programme', async () => {
      await setAccount(SABON.id, { tier: 'sme' });
      await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A1, 'admin');
      const response = await list(AGENT_2, [['limit', '100']]);
      expectStatus(response, 200, 'mixed list');
      const page = expectAccountPage(response.body, 'mixed');
      const a1 = page.data.find((row) => row.id === IKOYI.id);
      const a2 = page.data.find((row) => row.id === SABON.id);
      expect(a1?.tier).toBe('enterprise');
      expect(a1?.withheldFields).not.toContain('tier');
      expect(a2 && 'tier' in a2).toBe(false);
      expect(a2?.withheldFields).toContain('tier');
    });

    it.each([
      ['tier', 'tier', 'tier', 'enterprise'],
      ['industry', 'industry', 'industry', 'Banking'],
      ['owner_user_id', 'ownerUserId', 'owner', 'me'],
      ['tags', 'tags', 'tag', 'VIP'],
      ['state', 'state', 'state', 'Lagos'],
      ['lga', 'lga', 'lga', 'Ikeja'],
    ])(
      'a filter on a withheld %s is 400 field_withheld naming the parameter; the admin set filters fine',
      async (field, _wire, parameter, value) => {
        await lockField('account', field, 'agent', 'none');
        const body = expectError(
          await list(AGENT_1, [[parameter, value]]),
          400,
          'validation_failed',
        );
        expect(detailsOf(body)).toContainEqual({ path: parameter, code: 'field_withheld' });
        expectStatus(await list(SUPERVISOR, [[parameter, value]]), 200, 'admin filter');
      },
    );

    it('a field withheld in ANY programme the caller reaches refuses the filter, even if another programme shows it', async () => {
      // Agent 2: admin in A1 (tier readable), agent in A2 (tier withheld).
      await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A1, 'admin');
      const body = expectError(
        await list(AGENT_2, [['tier', 'enterprise']]),
        400,
        'validation_failed',
      );
      expect(detailsOf(body)).toContainEqual({ path: 'tier', code: 'field_withheld' });
    });

    describe('a writer with a withheld field (tenant admin holding the agent set in A1)', () => {
      beforeEach(async () => {
        await setTenantAdmin(USER_A_AGENT_1, true);
      });

      it('create and update responses omit the withheld field too', async () => {
        const created = await create(AGENT_1, createBody({ industry: 'Logistics' }));
        expectStatus(created, 201, 'create');
        const account = expectAccount(created.body, 'create');
        expect('tier' in account).toBe(false);
        expect(account.withheldFields).toContain('tier');

        const updated = await update(AGENT_1, IKOYI.id, {
          version: await versionOf(IKOYI.id),
          industry: 'Insurance',
        });
        expectStatus(updated, 200, 'update');
        const after = expectAccount(updated.body, 'update');
        expect('tier' in after).toBe(false);
        expect((await accountRow(IKOYI.id))?.tier, 'an update of another field keeps tier').toBe(
          'enterprise',
        );
      });

      it.each([
        ['setting it on create', 'create', { tier: 'sme' }],
        ['setting it on update', 'update', { tier: 'sme' }],
        [
          'clearing it on update (a caller cannot clear what it cannot read)',
          'update',
          { tier: null },
        ],
      ])(
        '%s is 403 not_permitted with field_not_editable at tier; nothing written',
        async (_label, op, fields) => {
          const before = await accountRow(IKOYI.id);
          const count = await accountCount();
          const response =
            op === 'create'
              ? await create(AGENT_1, createBody(fields))
              : await update(AGENT_1, IKOYI.id, { version: Number(before?.version), ...fields });
          const body = expectError(response, 403, 'not_permitted');
          expect(detailsOf(body)).toContainEqual({ path: 'tier', code: 'field_not_editable' });
          expect(await accountRow(IKOYI.id)).toEqual(before);
          expect(await accountCount()).toBe(count);
        },
      );

      it.each([
        ['phones', 'phones', { phones: [] }],
        ['owner_user_id', 'ownerUserId', { ownerUserId: USER_A_SUPERVISOR }],
        ['parent_account_id', 'parentAccountId', { parentAccountId: null }],
      ])('a withheld %s may not be written either: 403 at %s', async (field, path, fields) => {
        await lockField('account', field, 'agent', 'none');
        const before = await accountRow(IKOYI.id);
        const body = expectError(
          await update(AGENT_1, IKOYI.id, { version: Number(before?.version), ...fields }),
          403,
          'not_permitted',
        );
        expect(detailsOf(body)).toContainEqual({ path, code: 'field_not_editable' });
        expect(await accountRow(IKOYI.id)).toEqual(before);
      });

      it('a read-only field is readable and still may not be written', async () => {
        await lockField('account', 'tier', 'agent', 'read');
        const read = expectAccount(
          (await getOne(AGENT_1, IKOYI.id).expect(200)).body,
          'read level',
        );
        expect(read.tier).toBe('enterprise');
        const before = await accountRow(IKOYI.id);
        const body = expectError(
          await update(AGENT_1, IKOYI.id, { version: Number(before?.version), tier: 'sme' }),
          403,
          'not_permitted',
        );
        expect(detailsOf(body)).toContainEqual({ path: 'tier', code: 'field_not_editable' });
        expect(await accountRow(IKOYI.id)).toEqual(before);
      });

      it('403 field_not_editable comes before 409: a stale version does not change the answer', async () => {
        const version = await versionOf(IKOYI.id);
        await setAccount(IKOYI.id, { industry: 'Moved On' });
        const body = expectError(
          await update(AGENT_1, IKOYI.id, { version, tier: 'sme' }),
          403,
          'not_permitted',
        );
        expect(detailsOf(body)).toContainEqual({ path: 'tier', code: 'field_not_editable' });
      });
    });
  });

  // =========================================================================
  // 11. Audit (S2).
  // =========================================================================

  describe('audit: one event per successful write, labelled by id, no values', () => {
    const PHONE = '+2348030055501';
    const NEW_PHONE = '+2348030055502';
    const NAME = 'Adaeze Okonkwo Trading';

    function expectClean(event: AuditRow, phones: readonly string[], names: readonly string[]) {
      const haystack = JSON.stringify(event);
      for (const phone of phones) {
        for (const form of phoneForms(phone)) {
          expect(haystack, `audit event carries a phone (as "${form}")`).not.toContain(form);
        }
      }
      for (const name of names) {
        expect(haystack, 'audit event carries the account name').not.toContain(name);
      }
      for (const change of event.changes) {
        expect(
          change.before ?? null,
          `${change.field}: changes are names, never values`,
        ).toBeNull();
        expect(change.after ?? null, `${change.field}: changes are names, never values`).toBeNull();
      }
    }

    function expectRedacted(event: AuditRow, field: string) {
      const change = event.changes.find((candidate) => candidate.field === field);
      expect(change, `no ${field} change recorded (D-L54: a redacted change)`).toBeDefined();
      expect(change?.redacted, `${field} change must be redacted`).toBe(true);
    }

    it('a create records exactly one `created` event by the session user, in the account’s programme', async () => {
      const before = await auditIds();
      const response = await create(
        SUPERVISOR,
        createBody({ name: NAME, phones: [{ type: 'work', e164: PHONE }], tier: 'sme' }),
      );
      expectStatus(response, 201, 'create');
      const id = (response.body as Json).id as string;
      const events = await auditSince(before);
      expect(events, 'exactly one event per successful write').toHaveLength(1);
      const [event] = events;
      expect(event).toMatchObject({
        tenant_id: TENANT_A,
        actor_kind: 'user',
        actor_user_id: USER_A_SUPERVISOR,
        action: 'created',
        object_type: 'account',
        object_id: id,
        object_label: id,
        programme_id: PROGRAMME_A1,
      });
      if (event === undefined) return;
      expectRedacted(event, 'phones');
      expectClean(event, [PHONE], [NAME]);
    });

    it('an update records exactly one `updated` event naming exactly the changed fields', async () => {
      await setAccount(IKOYI.id, {
        name: NAME,
        phones: JSON.stringify([{ type: 'work', e164: PHONE }]),
        tier: 'sme',
      });
      // A programme admin who is not a tenant admin, so the actor is unambiguous.
      await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'admin');
      const before = await auditIds();
      const response = await update(AGENT_1, IKOYI.id, {
        version: await versionOf(IKOYI.id),
        tier: 'enterprise',
        phones: [{ type: 'work', e164: NEW_PHONE }],
      });
      expectStatus(response, 200, 'update');
      const events = await auditSince(before);
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event).toMatchObject({
        actor_kind: 'user',
        actor_user_id: USER_A_AGENT_1,
        action: 'updated',
        object_type: 'account',
        object_id: IKOYI.id,
        object_label: IKOYI.id,
        programme_id: PROGRAMME_A1,
      });
      if (event === undefined) return;
      expect(event.changes.map((change) => change.field).sort()).toEqual(['phones', 'tier']);
      expectRedacted(event, 'phones');
      expectClean(event, [PHONE, NEW_PHONE], [NAME]);
    });

    it('an A2 write is audited in A2, not tenant-wide (D-L48)', async () => {
      const before = await auditIds();
      expectStatus(
        await update(SUPERVISOR, SABON.id, { version: await versionOf(SABON.id), tier: 'sme' }),
        200,
        'A2 update',
      );
      const events = await auditSince(before);
      expect(events).toHaveLength(1);
      expect(events[0]?.programme_id).toBe(PROGRAMME_A2);
    });

    it('a refused write records nothing: 400, 403, 404, 409 and a refused hierarchy change', async () => {
      await plantAccount({ id: PARENT, programmeId: PROGRAMME_A1, name: 'Audit Parent' });
      await plantAccount({
        id: CHILD,
        programmeId: PROGRAMME_A1,
        name: 'Audit Child',
        parentAccountId: PARENT,
      });
      const version = await versionOf(IKOYI.id);
      expectStatus(
        await update(SUPERVISOR, IKOYI.id, { version, tier: 'sme' }),
        200,
        'setup write',
      );
      const before = await auditIds();
      const refusals = [
        await create(SUPERVISOR, createBody({ health: 1 })), // 400 closed body
        await update(SUPERVISOR, PARENT, {
          version: await versionOf(PARENT),
          parentAccountId: CHILD,
        }), // 400 cycle
        await update(SUPERVISOR, IKOYI.id, { version: version + 1, ownerUserId: USER_A_AGENT_2 }), // 400 reference
        await create(AGENT_1, createBody()), // 403
        await update(SUPERVISOR, WESTLANDS.id, { version: 1, tier: 'sme' }), // 404
        await create(SUPERVISOR, createBody({ programmeId: PROGRAMME_B1 })), // 404
        await update(SUPERVISOR, IKOYI.id, { version, tier: 'enterprise' }), // 409
      ];
      expect(refusals.map((response) => response.status)).toEqual([
        400, 400, 400, 403, 404, 404, 409,
      ]);
      expect(await auditSince(before), 'a refused write is not audited (D-L53)').toEqual([]);
    });
  });

  // =========================================================================
  // 12. No PII or database text in logs, spans or error bodies (D-L64, D-L74).
  // =========================================================================

  describe('no phone, account name, q or database error text in logs, spans or error bodies', () => {
    const PHONE = '+2348030055601';
    const NEW_PHONE = '+2348030055602';
    const BAD_PHONE = '08030055603';
    const PLANTED_PHONE = '+2348030055604';
    const NAME = 'Hauwa Kankarofi Ventures';
    const TOKEN = 'Kankarofi';
    const PLANTED_NAME = 'Yetunde Abiodun-Bakare Stores';

    function expectClean(haystack: string, what: string, databaseText: readonly string[]) {
      for (const form of [
        ...phoneForms(PHONE),
        ...phoneForms(NEW_PHONE),
        ...phoneForms(PLANTED_PHONE),
        ...phoneForms(`+234${BAD_PHONE.slice(1)}`),
        BAD_PHONE,
      ]) {
        expect(haystack, `${what} carries a phone (as "${form}")`).not.toContain(form);
      }
      for (const text of [NAME, TOKEN, PLANTED_NAME, 'Abiodun']) {
        expect(haystack, `${what} carries an account name or q ("${text}")`).not.toContain(text);
      }
      for (const text of databaseText) {
        expect(haystack, `${what} carries database text ("${text}")`).not.toContain(text);
      }
    }

    it('writes, search, hierarchy refusals and the other refusals emit none of it anywhere', async () => {
      await plantAccount({
        id: PII_ACCOUNT,
        programmeId: PROGRAMME_A1,
        name: PLANTED_NAME,
        phones: [{ type: 'mobile', e164: PLANTED_PHONE }],
      });
      await plantAccount({ id: PARENT, programmeId: PROGRAMME_A1, name: PLANTED_NAME });
      await plantAccount({
        id: CHILD,
        programmeId: PROGRAMME_A1,
        name: PLANTED_NAME,
        parentAccountId: PARENT,
      });
      const piiVersion = await versionOf(PII_ACCOUNT);
      const parentVersion = await versionOf(PARENT);
      const sabonVersion = await versionOf(SABON.id);

      const outcomes: [string, number, request.Response][] = [];
      let createdId = '';
      const { telemetry, lines } = await captureEverything(async () => {
        const created = await create(SUPERVISOR, {
          programmeId: PROGRAMME_A1,
          name: NAME,
          phones: [{ type: 'mobile', e164: PHONE }],
        });
        outcomes.push(['create', 201, created]);
        createdId = String((created.body as Json).id ?? '');
        outcomes.push([
          'update phones',
          200,
          await update(SUPERVISOR, createdId, {
            version: (created.body as Json).version,
            phones: [{ type: 'mobile', e164: NEW_PHONE }],
          }),
        ]);
        outcomes.push(['search by q', 200, await list(SUPERVISOR, [['q', TOKEN]])]);
        // Self-parent: the CHECK path, whose Postgres detail is "Failing row
        // contains (...)" with the name and phones of the row.
        outcomes.push([
          'self-parent',
          400,
          await update(SUPERVISOR, PII_ACCOUNT, {
            version: piiVersion,
            parentAccountId: PII_ACCOUNT,
          }),
        ]);
        outcomes.push([
          'cycle',
          400,
          await update(SUPERVISOR, PARENT, { version: parentVersion, parentAccountId: CHILD }),
        ]);
        // A parent in another programme: the composite FK's 23503 path.
        outcomes.push([
          'cross-programme parent',
          400,
          await update(SUPERVISOR, SABON.id, {
            version: sabonVersion,
            parentAccountId: PII_ACCOUNT,
          }),
        ]);
        outcomes.push([
          'bad phone',
          400,
          await create(SUPERVISOR, {
            programmeId: PROGRAMME_A1,
            name: NAME,
            phones: [{ type: 'mobile', e164: BAD_PHONE }],
          }),
        ]);
        outcomes.push([
          'stale',
          409,
          await update(SUPERVISOR, PII_ACCOUNT, { version: piiVersion + 7, name: NAME }),
        ]);
        outcomes.push([
          'unpermitted',
          403,
          await create(AGENT_1, {
            programmeId: PROGRAMME_A1,
            name: NAME,
            phones: [{ type: 'mobile', e164: PHONE }],
          }),
        ]);
        outcomes.push([
          'unreachable target',
          404,
          await create(SUPERVISOR, {
            programmeId: PROGRAMME_B1,
            name: NAME,
            phones: [{ type: 'mobile', e164: PHONE }],
          }),
        ]);
      });

      // The controls: every request inside the capture did what it should,
      // so a clean capture is not the cleanliness of a server that refused
      // everything with a 404.
      expect(outcomes.map(([label, , response]) => [label, response.status])).toEqual(
        outcomes.map(([label, status]) => [label, status]),
      );
      const search = outcomes.find(([label]) => label === 'search by q')?.[2];
      expect(idsOf(expectAccountPage(search?.body, 'search'))).toEqual([createdId]);
      expect(
        telemetry.spans.length,
        'no spans were recorded at all — is telemetry wired?',
      ).toBeGreaterThan(0);

      expectClean(JSON.stringify(telemetry.spans), 'spans (attributes and events)', [ROW_DETAIL]);
      expectClean(
        lines.join('\n'),
        'logs (Nest logger, stdout, stderr, console, OTel log records)',
        [ROW_DETAIL],
      );
      for (const [label, status, response] of outcomes) {
        if (status < 400) continue;
        expectClean(
          JSON.stringify(response.body),
          `the ${label} error body`,
          DATABASE_TEXT_IN_BODIES,
        );
      }
    });

    it('q is redacted from logs and spans on a search that finds its row (D-L64)', async () => {
      await plantAccount({ id: OJA, programmeId: PROGRAMME_A1, name: NAME });
      let found: string[] = [];
      const { telemetry, lines } = await captureEverything(async () => {
        const response = await list(AGENT_1, [['q', TOKEN]]);
        expectStatus(response, 200, 'search');
        found = idsOf(expectAccountPage(response.body, 'search'));
      });
      expect(found, 'the search inside the capture must find the row').toEqual([OJA]);
      expect(telemetry.spans.length).toBeGreaterThan(0);
      for (const [haystack, what] of [
        [JSON.stringify(telemetry.spans), 'spans'],
        [lines.join('\n'), 'logs'],
      ] as const) {
        expect(haystack, `${what} carry q`).not.toContain(TOKEN);
        expect(haystack, `${what} carry q, lower-cased`).not.toContain(TOKEN.toLowerCase());
      }
    });
  });
});
