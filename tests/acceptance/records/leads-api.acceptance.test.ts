import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import {
  contact as contactTable,
  createPool,
  ensureStandardObjectDefs,
  loadMigrations,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  runMigrations,
  SEED_ACCOUNTS,
  SEED_CONTACTS,
  SEED_PERMISSION_SETS,
  SEED_TENANTS,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import { readTableSecurity, reseed } from '@kasuwa/testing';
import { Client, type Pool, type PoolClient, type QueryResultRow } from 'pg';
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
 * ACCEPTANCE — T-0076, leads: `contact.company_name`, the Leads list and
 * convert (Agent 3, M3; Agent 1 reviews the migration). Written by QA for the
 * lead before the build (D-L23), from the contract and the decisions, not
 * from an implementation (D-L25).
 *
 * Sources: team/tasks/T-0076-leads-company-and-convert.md (and its "Watch
 * for" on the `accountId` contact filter); the T-0056 contract in
 * docs/api/records.openapi.yaml (`listLeads`, `convertContact`,
 * `ConvertContactRequest`, `ConvertContactResponse`, `Contact.companyName`)
 * and its suite (platform/records-contract-leads); D-P17 and D-P18
 * (answered), D-P14, D-L53 (404 -> 403 -> 400 -> 409), D-L54 and D-L63 (no
 * PII in audit, the label is the record id, the tenant-admin flag never lifts
 * field security), D-L64 (`q` redacted from logs), D-L65, D-L67, D-L72
 * (timeline values), D-L73 (a pending property moves into
 * `Contact.properties` when served), D-L74 (no Postgres `detail`), D-L75
 * (the leads contract rulings), D-L76, D-L78 (NUL is 400), D-L80, D-L81,
 * D-P24 (the clash pre-check); the recipe in
 * packages/db/src/standard-object-catalogue.ts. Model suites:
 * records/contacts-api (T-0041), records/accounts-api (T-0055),
 * records/account-fields (T-0054), records/activity-table (T-0060). Helpers
 * are copied, never imported: importing a test file registers its tests. If
 * the spec and this file disagree on something the spec states, the spec
 * wins and this file is the defect: say so in the report, do not edit it.
 *
 * ==========================================================================
 * PINNED INTERFACES (the builder must honour these exactly)
 * ==========================================================================
 *
 * L1. MIGRATION. Exactly ONE file in packages/db/migrations adds
 *     `contact.company_name` (found by its `ALTER TABLE contact ... ADD
 *     [COLUMN] company_name`, SQL line comments stripped, NOT by number; the
 *     number is whatever is free when the task starts, 0028 today). It sorts
 *     after every migration on main and the runner has applied it. 0001,
 *     0019, 0025, 0026 and 0027 are unedited. No SECURITY DEFINER function is
 *     added (CLAUDE.md 2.7). `contact` keeps RLS ENABLED and FORCED and stays
 *     in TENANT_SCOPED_TABLES; any table the change adds meets the same rules.
 *     The column: `text` (or `character varying` of at least 200), NULLABLE,
 *     no default but NULL; readable and writable by kasuwa_app inside its own
 *     programme. `contact` in packages/db/src/schema.ts mirrors it.
 *
 * L2. METADATA (the catalogue recipe, D-P24). Every tenant has a STANDARD
 *     `field_def` `company_name` (type `text`, not required) on its STANDARD
 *     `contact` object. Seeded tenants, a fresh tenant given
 *     `ensureStandardObjectDefs`, and tenants that pre-date the migration (its
 *     backfill) all get the SAME standard contact fields: label, type,
 *     is_required, config and classification (classification is the
 *     builder's; see below). THE CLASH PRE-CHECK: when tenants already have a
 *     CUSTOM `company_name` on `contact`, the migration stops before changing
 *     anything, with a message naming `contact`, `company_name` and the
 *     number of tenants (2). A custom `company_name` on ACCOUNT in a third
 *     tenant is not a clash and is not counted (never 3). Once removed, the
 *     migration applies and the backfill reaches every tenant.
 *
 * L3. `Contact.companyName`. Served on getContact, listContacts, listLeads,
 *     createContact, updateContact and convertContact's `contact`; `null`
 *     when none. Field security is the contact object's, field `company_name`
 *     (S3 of the T-0041 suite): withheld is OMITTED and listed in
 *     `withheldFields`, the value appears nowhere in the body. Writable on
 *     create and update with `contact.write` and edit on the field; otherwise
 *     403 `not_permitted` (`field_not_editable` at `companyName` when the field
 *     is withheld or read-only). The D-P14 claim sets (agent, team_lead,
 *     programme_manager) may not send it: 403 for the whole body, nothing
 *     written. In the spec it moves from `ContactPendingProperties` into
 *     `Contact.properties` (D-L73), and the write bodies' `companyName` loses
 *     `x-kasuwa-implemented: false`. A NUL character, a non-string or more
 *     than 200 characters is 400.
 *     AUDIT: a create or update that sets it names `companyName` in
 *     `changes`, BY NAME ONLY (`redacted: true`, no values): a company name is
 *     free text that is often a person's name (a sole trader), and D-L72's
 *     value list does not include it. So the timeline contract must admit
 *     `companyName` as a REDACTED field_changed item and never with values
 *     (the builder adds it to FieldChangeRedacted's `field` enum: T-0061 turns
 *     every change into an item, and an item outside the closed union would
 *     break the contract).
 *
 * L4. listLeads, `GET /api/v1/leads`. Exactly the contacts in the caller's
 *     programmes whose `status` is new, contacted, qualified or unqualified
 *     (never customer, never null). A `ContactPage` of Contacts, `{ data,
 *     nextCursor }` only, no total header, `Cache-Control` no-store or
 *     private. Sort keys and default (`-createdAt`), keyset paging, `limit`
 *     1..100, `invalid_cursor`, owner and source filters, unknown query
 *     parameters ignored, scope headers 400: all as listContacts. `status`
 *     narrows to lead statuses only (`customer` is 400). `q` matches the
 *     display, given and family names, numbers (E.164-normalised) and
 *     `companyName`, each ONLY where the caller may read it IN THAT ROW'S
 *     PROGRAMME. If `status` is withheld from the caller in ANY programme they
 *     reach, the answer is 400 `validation_failed` with
 *     `{ path: 'status', code: 'field_withheld' }`, with or without a `status`
 *     parameter, and no row. A cursor never widens the view: replayed from
 *     another caller or from listContacts, it yields only this caller's leads
 *     (or 400 `invalid_cursor`).
 *
 * L5. convertContact, `POST /api/v1/contacts/{id}/convert`.
 *     BODY, closed: `version` (integer >= 1) plus EXACTLY ONE of `accountId`
 *     (a uuid, never null) or `newAccount: { name }` (closed, 1..200
 *     characters, no NUL). Anything else, at any depth, is 400.
 *     EFFECT: `new`, `contacted`, `unqualified` and `null` become `qualified`;
 *     `qualified` stays; `customer` stays `customer` (never demoted). The
 *     contact is linked to the account. `newAccount` creates an account IN
 *     THE CONTACT'S PROGRAMME, unassigned, every other field at its default.
 *     `companyName` is neither copied nor cleared; an existing account is not
 *     changed. The contact's `version` advances by EXACTLY ONE (one UPDATE,
 *     not a status write and then a link write).
 *     RESPONSE: 200, exactly `{ contact, account }`; `contact` deep-equals
 *     what getContact then returns to the same caller, and `account` what
 *     getAccount returns, each under its own field security.
 *     IDEMPOTENT (D-L75): when the result is already in place (status
 *     qualified or customer AND accountId is the requested one, or for
 *     `newAccount` the linked account's name equals the requested name
 *     EXACTLY) the answer is 200 with a body deep-equal to the first answer,
 *     WHATEVER `version` is sent, and nothing is written (no version bump, no
 *     audit event, no account). Any other request on a stale version is 409.
 *     ALREADY LINKED: a contact linked to another account (or a `newAccount`
 *     whose name differs, even only in case) is 400 `validation_failed` with
 *     `details[].code: already_linked` at `accountId` or `newAccount`, and
 *     nothing is written; the body names neither account. Linked to the SAME
 *     account (or a `newAccount` named exactly as it) but not yet qualified:
 *     qualifies it, no account is created.
 *     SCOPE: the contact unreachable (sibling programme, other tenant,
 *     nowhere, or a tenant admin who does not reach the programme) is 404;
 *     an account outside the contact's programme (another programme even if
 *     the caller reaches it, another tenant, nowhere) is 404 with the SAME
 *     BODY, byte for byte, as each other and as a contact out of reach.
 *     PERMISSION: `contact.write` in the contact's programme (the `admin` set
 *     or the tenant-admin flag), plus `account.write` for `newAccount`; read
 *     AND edit on `status` and on `accountId` (else 403 `field_not_editable`
 *     naming the field). agent, team_lead, programme_manager, qa_analyst and
 *     client_portal: 403, with one body whatever account the request names.
 *     ORDER: contact 404, 403, body 400, account 404, the repeat rule, 409,
 *     400 already_linked.
 *     CONCURRENCY: N identical `newAccount` converts racing on one version
 *     create ONE account, ONE contact event and ONE account event (L6, as
 *     amended by T-0104); each answer is 200 (naming that account) or 409.
 *     Racing converts to two different accounts, or two different new names,
 *     link one and leave no orphan account and no orphan account event.
 *
 * L6. THE CONVERT AUDIT EVENT (the D-L75 open point, chosen here; AMENDED by
 *     T-0104, see the end of this item). Exactly ONE contact `audit_event`
 *     per successful convert, none per repeat or refusal:
 *     `object_type 'contact'`, `object_id` and `object_label` the contact id,
 *     `action 'updated'`, `programme_id` the contact's programme,
 *     `actor_kind 'user'`, `actor_user_id` the session user. `changes` names
 *     EXACTLY the fields whose values changed, from {status, accountId}:
 *       - `accountId` is `{ redacted: true }` with null values (D-L72: account
 *         changes carry no ids);
 *       - `status` is either redacted with null values, or (D-L72 / T-0061)
 *         `redacted: false` with `before` the previous code (or null) and
 *         `after` 'qualified'. Nothing else.
 *     HOW IT REFERS TO A CREATED ACCOUNT: it does not, beyond that redacted
 *     `accountId` change. A convert that creates an account writes the SAME
 *     event shape as one that links an existing account, carries neither the
 *     account's id nor its name anywhere, and NO separate event on the
 *     account (no `object_type 'account'` row, nothing whose object_id is the
 *     new account). Why: the contract allows one event, on the contact, with
 *     field names and no values; the T-0061 timeline turns every `changes`
 *     entry into an item from a CLOSED field list, so an extra entry such as
 *     `newAccount` would put an off-contract item on every reader's timeline;
 *     and an account name can be a person's name (D-L63, D-L80). The cost is
 *     that a convert-created account has no audit event of its own; that is
 *     raised for the lead in the report, not decided here.
 *
 *     AMENDED BY T-0104 (D-L82's tracked item, taken): "a convert that
 *     creates an account writes two audit events in its one transaction: the
 *     contact `updated` (as now) and the account `created`, names only
 *     (D-L78). A repeat or a refusal writes neither." So, for a `newAccount`
 *     convert that creates an account, besides the contact event above
 *     (unchanged: still no account id or name in it):
 *       - EXACTLY ONE more row, `action 'created'`, `object_type 'account'`,
 *         `object_id` and `object_label` the new account's id (the accounts
 *         API's shape, D-L63), `programme_id` the contact's programme (where
 *         the account is created), the same `actor_kind 'user'` and
 *         `actor_user_id`;
 *       - `changes` names `name` and only field names: every change
 *         `redacted: true` with null values (D-L78). The account's name is
 *         nowhere in either row;
 *       - written in the convert's own transaction: a convert that loses a
 *         race and rolls back its account leaves no account event behind;
 *       - a convert that links an existing account, a repeat and every
 *         refusal write NO account event.
 *
 * L7. EVERYWHERE. No phone, contact name, company name, account name, `q` or
 *     Postgres `detail` in logs, spans or error bodies; error bodies carry no
 *     constraint name, "violates" text or SQLSTATE. Scope headers are 400.
 *
 * L8. THE `accountId` FILTER (the task's "Watch for"). Whether listContacts or
 *     listLeads exposes an account filter is the builder's. Whatever it does,
 *     for a caller from whom `accountId` is withheld, `?account=<id>` and
 *     `?accountId=<id>` naming the real linked account answer BYTE-
 *     IDENTICALLY to the same parameter naming an invented id (200 and
 *     ignored, or 400 `field_withheld`), never an oracle on the link.
 *
 * ==========================================================================
 * THE BUILDER'S (not asserted)
 * ==========================================================================
 * The migration's number and name, its messages beyond the three facts in
 * L2, and any index on company_name (a search index for `q` is welcome under
 * D-L68); the field_def's label and classification (only that every source
 * agrees; `none` and `pii` both defensible: see the report); whether
 * companyName is trimmed, and whether "" is accepted; whether listContacts'
 * `q` also searches companyName; the convert route's internals (row lock,
 * conditional UPDATE, SERIALIZABLE); whether a repeat re-reads or replays;
 * whether `version` above 2^31 is 400 or 409 (never 500); the `path` of an
 * owner `field_withheld` (`owner` or `ownerUserId`); listLeads' sort subset
 * beyond the keys pinned here (all six of listContacts' are exercised).
 *
 * ==========================================================================
 * BEYOND THE BRIEF (suite-writer additions; the lead may rule them out)
 * ==========================================================================
 * - `q` honours field security PER ROW: a company withheld in A2 but readable
 *   in A1 is found only in A1, for one caller who reaches both.
 * - A cursor from listContacts, replayed on listLeads, never yields a
 *   customer or a status-null contact.
 * - A tenant admin who reaches no programme cannot convert (404), and a
 *   non-writer's exact repeat of a finished convert is 403, not 200 (a 200
 *   would confirm the link to a caller who may not write it).
 * - A case-differing `newAccount` name is not a repeat (exact, per the
 *   contract).
 * - The created account is in the CONTACT's programme even when the caller
 *   reaches several (the supervisor converting an A2 lead).
 * - Concurrency and atomicity probes (L5): duplicate accounts and orphans.
 * - The convert `contact` is getContact's and the `account` getAccount's,
 *   deep-equal.
 * - companyName follows D-P14 (claim sets refused) and is never logged.
 * - The timeline contract admits companyName only as a redacted item.
 *
 * ==========================================================================
 * D-L23: on main there is no migration, no `company_name` column, no field_def,
 * no `/api/v1/leads` route and no convert route, and `companyName` is still
 * pending in the spec. Every test then fails on one of those (a 404 for a
 * route, "T-0076 has not landed: contact has no company_name column", the
 * missing standard field_def, the pending property), never on a harness
 * crash. Tests that assert a 404 or a refusal first assert a 200 control on a
 * reachable record, so "no route" cannot pass for "out of scope". The
 * checker self-test and the regression guards marked as such pass on main
 * by design.
 *
 * Writes: the suite reseeds before and after, and after every test. Rows this
 * suite plants use ids `...-00007600xxxx` and are planted by kasuwa_migrator
 * (BYPASSRLS, never serves). Fixtures are packages/db/src/fixtures.ts only.
 */

// ---------------------------------------------------------------------------
// Constants and fixtures.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '../../..');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'packages/db/migrations');
const BOOTSTRAP_SQL = resolve(REPO_ROOT, 'packages/db/sql/bootstrap.sql');
const SPEC_PATH = resolve(REPO_ROOT, 'docs/api/records.openapi.yaml');

const CONTACTS = '/api/v1/contacts';
const LEADS = '/api/v1/leads';
const ACCOUNTS = '/api/v1/accounts';
const contactPath = (id: string) => `${CONTACTS}/${id}`;
const convertPath = (id: string) => `${CONTACTS}/${id}/convert`;
const accountPath = (id: string) => `${ACCOUNTS}/${id}`;
const accountContactsPath = (id: string) => `${ACCOUNTS}/${id}/contacts`;

/** Unique per run, lowercase alphanumeric. */
const RUN = Date.now().toString(36);
let sequence = 0;
const unique = (label: string) => `${label} ${RUN}-${(sequence += 1)}`;

/** Ids this suite plants: `7600` marks T-0076. */
const idA = (tail: string) => `11111111-0000-4000-8000-00007600${tail}`;
const idB = (tail: string) => `22222222-0000-4000-8000-00007600${tail}`;

/** Never a real row. */
const NOWHERE = idA('ffff');
const NOWHERE_B = idB('ffff');

/** Planted contacts, A1 unless the name says otherwise. */
const KELECHI = idA('c001');
const ZAINAB = idA('c002');
const OBINNA = idA('c003');
const PII_LEAD = idA('c004');
/** A second account in A1. */
const OJA = idA('a001');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified'] as const;

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);
const AGENT_2 = asUser(TENANT_A, USER_A_AGENT_2);
const NO_PROGRAMME = asUser(TENANT_A, USER_A_NO_PROGRAMME);
const TENANT_B_USER = asUser(TENANT_B, USER_B_AGENT_1);

type Headers = Record<string, string>;
type Json = Record<string, unknown>;
type Params = readonly (readonly [string, string])[];

function seededContact(givenNames: string) {
  const found = SEED_CONTACTS.find((candidate) => candidate.givenNames === givenNames);
  if (found === undefined) throw new Error(`Fixture drift: no seeded contact '${givenNames}'`);
  return found;
}

/** Tenant A, A1. */
const AMAKA = seededContact('Amaka');
const BASHIR = seededContact('Bashir');
const CHIOMA = seededContact('Chioma');
/** Tenant A, A2. */
const DAMILOLA = seededContact('Damilola');
const EFE = seededContact('Efe');
/** Tenant B, B1. */
const GRACE = seededContact('Grace');

function seededAccount(programmeId: string) {
  const found = SEED_ACCOUNTS.find((candidate) => candidate.programmeId === programmeId);
  if (found === undefined) throw new Error(`Fixture drift: no seeded account in ${programmeId}`);
  return found;
}

/** "Ikoyi Traders", A1. */
const IKOYI = seededAccount(PROGRAMME_A1);
/** "Sabon Gari Mart", A2. */
const SABON = seededAccount(PROGRAMME_A2);
/** "Westlands Supplies", tenant B, B1. */
const WESTLANDS = seededAccount(PROGRAMME_B1);

function permissionSet(tenantId: string, key: string): string {
  const set = SEED_PERMISSION_SETS.find(
    (candidate) => candidate.tenantId === tenantId && candidate.key === key,
  );
  if (set === undefined) throw new Error(`Fixture drift: no seeded permission set '${key}'`);
  return set.id;
}

/** D-P14 / D-P18: status, and owner to self, on contacts. Never convert. */
const CLAIM_KEYS = ['agent', 'team_lead', 'programme_manager'] as const;
/** No contact write at all. */
const READ_ONLY_KEYS = ['qa_analyst', 'client_portal'] as const;

/** The live scope headers the stub guard refuses (D-L63). */
const SCOPE_HEADERS = [
  ['x-kasuwa-programme-ids', `{${PROGRAMME_A2}}`],
  ['x-kasuwa-programme-id', PROGRAMME_A2],
  ['x-kasuwa-scope', 'all'],
] as const;

// ---------------------------------------------------------------------------
// A small JSON-Schema checker over the published YAML (no new dependency).
// The T-0041 / T-0055 suites' checker, plus `const` (the timeline items use
// it): $ref (local and relative-file), type (incl. arrays), enum, const,
// oneOf, required, properties, additionalProperties: false, items,
// min/maxItems, min/maxLength, pattern, minimum/maximum, formats.
// ---------------------------------------------------------------------------

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
  if ('const' in schema && schema.const !== value) {
    errors.push(
      `${path}: ${JSON.stringify(value)} is not the const ${JSON.stringify(schema.const)}`,
    );
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

function schemaErrors(value: unknown, schemaName: string, where: string): string[] {
  const errors: string[] = [];
  check(schemaAt(schemaName), SPEC_PATH, value, where, errors);
  return errors;
}

function expectSchema(value: unknown, schemaName: string, where: string): void {
  expect(
    schemaErrors(value, schemaName, where),
    `${where} does not match #/components/schemas/${schemaName}`,
  ).toEqual([]);
}

function specSchemas(): Record<string, Json> {
  const spec = loadDoc(SPEC_PATH) as { components?: { schemas?: Record<string, Json> } };
  return spec.components?.schemas ?? {};
}

function specOperation(path: string, method: string): Json | undefined {
  const spec = loadDoc(SPEC_PATH) as { paths?: Record<string, Record<string, Json>> };
  return spec.paths?.[path]?.[method];
}

function propertiesOf(schemaName: string): string[] {
  const { schema } = deref(schemaAt(schemaName), SPEC_PATH);
  return Object.keys((schema.properties ?? {}) as Json);
}

/** The pending part's properties, or none once the part is gone. */
function pendingContactProperties(): string[] {
  const part = specSchemas().ContactPendingProperties;
  return part === undefined ? [] : Object.keys((part.properties ?? {}) as Json);
}

/**
 * T-0089 / D-L143 (lead edit): Account's pending allOf part (`custom`, placed
 * there by the T-0088 pin), or none once the part is gone. Admitted, never required.
 */
function pendingAccountProperties(): string[] {
  const part = specSchemas().AccountPendingProperties;
  return part === undefined ? [] : Object.keys((part.properties ?? {}) as Json);
}

const CONTACT_NEVER_WITHHELD = [
  'id',
  'programmeId',
  'version',
  'displayName',
  'createdAt',
  'updatedAt',
  'withheldFields',
];

const ACCOUNT_NEVER_WITHHELD = [
  'id',
  'programmeId',
  'name',
  'version',
  'createdAt',
  'updatedAt',
  'withheldFields',
];

/**
 * The field-security omission rule, the T-0041 / T-0055 reading: every named
 * property present or withheld, never both, never neither; nothing unnamed;
 * derived properties withheld with their source and consistent with it.
 */
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
  for (const [derived, source] of [
    ['owner', 'ownerUserId'],
    ['account', 'accountId'],
  ] as const) {
    if (!named.includes(derived) && !allowedExtra.includes(derived)) continue;
    if (derived in record && withheld.includes(source)) {
      problems.push(`${derived} is sent while ${source} is withheld`);
    }
    if (derived in record && source in record) {
      const summary = record[derived] as Json | null;
      if (record[source] === null && summary !== null) {
        problems.push(`${derived} must be null exactly when ${source} is null`);
      }
      if (record[source] !== null && (summary === null || summary.id !== record[source])) {
        problems.push(`${derived}.id must equal ${source}`);
      }
    }
  }
  if (named.includes('owner') && withheld.includes('owner') !== withheld.includes('ownerUserId')) {
    problems.push('owner and ownerUserId must be withheld together');
  }
  return problems;
}

/** `Contact`, the omission rule, and pending properties allowed but not required. */
function expectContact(value: unknown, where: string): Json {
  expectSchema(value, 'Contact', where);
  const contact = value as Json;
  expect(
    omissionProblems(
      contact,
      propertiesOf('Contact'),
      pendingContactProperties(),
      CONTACT_NEVER_WITHHELD,
    ),
    `${where}: field-security omission rule`,
  ).toEqual([]);
  return contact;
}

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
  page.data.forEach((row, index) => expectContact(row, `${where}.data[${index}]`));
  return page;
}

function expectAccount(value: unknown, where: string): Json {
  expectSchema(value, 'Account', where);
  const account = value as Json;
  expect(
    omissionProblems(account, propertiesOf('Account'), pendingAccountProperties(), ACCOUNT_NEVER_WITHHELD),
    `${where}: field-security omission rule`,
  ).toEqual([]);
  return account;
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

function expectNoTotals(response: request.Response, where: string): void {
  const headers = Object.keys(response.headers).filter((name) => /total|count/i.test(name));
  expect(headers, `${where}: a response header carries a total`).toEqual([]);
}

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

function phoneForms(e164: string): string[] {
  const digits = e164.replace(/^\+/, '');
  const national = digits.startsWith('234') ? `0${digits.slice(3)}` : digits;
  return [...new Set([e164, encodeURIComponent(e164), digits, national])];
}

/** A Postgres `detail` carries the row (D-L74). Never anywhere. */
const ROW_DETAIL = 'Failing row contains';

/** Database text an ERROR BODY must never carry. */
const DATABASE_TEXT_IN_BODIES = [ROW_DETAIL, 'violates', 'constraint', '23514', '23503', '22021'];

// ---------------------------------------------------------------------------
// The migration, found by content.
// ---------------------------------------------------------------------------

/** `ALTER TABLE [ONLY] [public.]contact ... ADD [COLUMN] [IF NOT EXISTS] company_name`. */
const ADDS_COMPANY_NAME =
  /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"?public"?\.)?"?contact"?\s[^;]*?\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?company_name"?\s/i;

const stripLineComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');

function companyNameMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .filter((name) =>
      ADDS_COMPANY_NAME.test(stripLineComments(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))),
    )
    .sort();
}

/** The last migration on main when this suite was written. */
const LAST_ON_MAIN = '0027_activity.sql';

const PINNED_CHECKSUMS: Readonly<Record<string, string>> = {
  '0001_tenancy_core': 'ae037c3ef279589f7b3d326b4ce62e63e23f5ce4e0b67a61f3debee0fdc52a89',
  '0019_contact_fields_and_account':
    'b9e3ed18883fb6f40528c210cfc38850539a2f49b35ee34f65d9280712d5b3b8',
  '0025_standard_object_metadata':
    'c3a26e95ed0d7d4672e31d60809bb6c5e72a62ad75160a5c27bbab94c694c3be',
  '0026_account_fields': '634e06379be99ffffea0ad191d531851a1e9a5964edde94754a1c9d496befdf3',
  '0027_activity': 'cf97d7fc4029637aa14bcdf189ec4e1a9ad9eb4f7f13e1825bfc0eaf0415fbb6',
};

const DEFINERS_SQL = `
  SELECT n.nspname || '.' || p.proname AS name
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   ORDER BY 1`;

const PUBLIC_TABLES_SQL = `
  SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
   ORDER BY 1`;

const CONTACT_COLUMNS_SQL = `
  SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
         a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS default
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE n.nspname = 'public' AND c.relname = 'contact'
     AND a.attnum > 0 AND NOT a.attisdropped
   ORDER BY a.attnum`;

/** STANDARD contact fields of one tenant, with everything every source must agree on. */
const CONTACT_FIELDS_SQL = `
  SELECT f.api_name, f.label, f.type, f.is_required, f.config::text AS config,
         f.classification, f.is_custom
    FROM field_def f
    JOIN object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
   WHERE f.tenant_id = $1 AND o.api_name = 'contact' AND NOT o.is_custom AND NOT f.is_custom
   ORDER BY f.api_name`;

interface FieldRow {
  api_name: string;
  label: string;
  type: string;
  is_required: boolean;
  config: string;
  classification: string;
  is_custom: boolean;
}

/** A company column type that holds the contract's 200 characters. */
function companyTypeOk(type: string): boolean {
  if (type === 'text') return true;
  const varchar = /^character varying(?:\((\d+)\))?$/.exec(type);
  if (varchar === null) return false;
  return varchar[1] === undefined || Number(varchar[1]) >= 200;
}

type Query = <R extends QueryResultRow>(sql: string, values?: unknown[]) => Promise<R[]>;

class Rollback<T> {
  constructor(readonly value: T) {}
}

async function rolledBackTenantTx<T>(
  pool: Pool,
  tenantId: string,
  userId: string,
  fn: (query: Query) => Promise<T>,
): Promise<T> {
  try {
    await withTenantTransaction(pool, { tenantId, userId }, async (tx) => {
      const query: Query = (text, params) => tx.query(text, params);
      throw new Rollback(await fn(query));
    });
  } catch (signal) {
    if (signal instanceof Rollback) return signal.value as T;
    throw signal;
  }
  throw new Error('unreachable: the callback always throws');
}

async function rolledBackMigratorTx<T>(pool: Pool, fn: (query: Query) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const query: Query = async (text, params) => (await client.query(text, params)).rows;
    return await fn(query);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

// ===========================================================================
// 1-14: the shared harness database and the real API
// ===========================================================================

describe('acceptance: leads API (T-0076)', () => {
  let app: INestApplication;
  /** kasuwa_migrator — BYPASSRLS. Plants values and observes rows; never serves. */
  let observer: Pool;
  /** kasuwa_app — NOBYPASSRLS. Only for the column probes. */
  let appPool: Pool;
  let hasCompanyColumn = false;

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
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
    const columns = await observer.query<{ column: string }>(CONTACT_COLUMNS_SQL);
    hasCompanyColumn = columns.rows.some((row) => row.column === 'company_name');
  });

  afterAll(async () => {
    await app?.close();
    await observer?.end();
    await appPool?.end();
    await reseed(inject('migrationUrl'));
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();

  /** A clear failure, never a 42703, when the migration has not landed. */
  function requireCompanyColumn(): void {
    if (!hasCompanyColumn) {
      throw new Error(
        'T-0076 has not landed: contact has no company_name column. This suite plants company ' +
          'names and cannot run without it.',
      );
    }
  }

  // --- HTTP helpers -------------------------------------------------------

  const withQuery = (path: string, params: Params) => {
    const query = new URLSearchParams(params.map(([k, v]): [string, string] => [k, v])).toString();
    return query === '' ? path : `${path}?${query}`;
  };
  const leads = (headers: Headers, params: Params = []) =>
    request(server()).get(withQuery(LEADS, params)).set(headers);
  const contacts = (headers: Headers, params: Params = []) =>
    request(server()).get(withQuery(CONTACTS, params)).set(headers);
  const getContact = (headers: Headers, id: string) =>
    request(server()).get(contactPath(id)).set(headers);
  const getAccount = (headers: Headers, id: string) =>
    request(server()).get(accountPath(id)).set(headers);
  const createContact = (headers: Headers, body: unknown) =>
    request(server())
      .post(CONTACTS)
      .set(headers)
      .send(body as object);
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

  // --- observer helpers -----------------------------------------------------

  async function contactRow(id: string): Promise<Json | null> {
    const result = await observer.query<Json>('SELECT * FROM contact WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async function versionOf(id: string): Promise<number> {
    const row = await contactRow(id);
    if (row === null) throw new Error(`no contact ${id} to read a version from`);
    return Number(row.version);
  }

  async function accountRow(id: string): Promise<Json | null> {
    const result = await observer.query<Json>('SELECT * FROM account WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async function accountCount(): Promise<number> {
    const result = await observer.query<{ n: number }>('SELECT count(*)::int AS n FROM account');
    return result.rows[0]?.n ?? -1;
  }

  async function accountsNamed(name: string): Promise<Json[]> {
    const result = await observer.query<Json>('SELECT * FROM account WHERE name = $1', [name]);
    return result.rows;
  }

  async function contactsCompany(company: string): Promise<number> {
    requireCompanyColumn();
    const result = await observer.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM contact WHERE company_name = $1',
      [company],
    );
    return result.rows[0]?.n ?? -1;
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
   * One field-security decision in tenant A, against the STANDARD field_def
   * the seed already holds. Never invents one: on main, `company_name` has
   * none, and that is the failure.
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
        WHERE f.tenant_id = $1 AND o.api_name = $2 AND f.api_name = $3
          AND NOT o.is_custom AND NOT f.is_custom`,
      [TENANT_A, objectApiName, field],
    );
    const fieldId = found.rows[0]?.id;
    if (fieldId === undefined) {
      throw new Error(
        `Fixture drift or T-0076 missing: tenant A has no standard field_def ` +
          `${objectApiName}.${field}. This suite plants grants, never field definitions.`,
      );
    }
    await observer.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [TENANT_A, fieldId, permissionSet(TENANT_A, setKey), level],
    );
  }

  /** Sets columns on an existing contact in ONE statement. */
  async function setContact(id: string, values: Record<string, unknown>) {
    if ('company_name' in values) requireCompanyColumn();
    const columns = Object.keys(values);
    const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
    await observer.query(`UPDATE contact SET ${assignments} WHERE id = $1`, [
      id,
      ...columns.map((column) => values[column]),
    ]);
  }

  interface PlantedContact {
    id: string;
    programmeId: string;
    tenantId?: string;
    displayName: string;
    givenNames: string;
    familyName: string;
    phone: string;
    status: string | null;
    companyName?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }

  async function plantContact(planted: PlantedContact) {
    const values: Record<string, unknown> = {
      id: planted.id,
      tenant_id: planted.tenantId ?? TENANT_A,
      programme_id: planted.programmeId,
      display_name: planted.displayName,
      given_names: planted.givenNames,
      family_name: planted.familyName,
      phones: JSON.stringify([{ type: 'mobile', e164: planted.phone }]),
      status: planted.status,
      created_at: planted.createdAt ?? '2026-02-01T00:00:00Z',
      updated_at: planted.updatedAt ?? '2026-02-01T00:00:00Z',
    };
    if (planted.companyName !== undefined) {
      requireCompanyColumn();
      values.company_name = planted.companyName;
    }
    const columns = Object.keys(values);
    await observer.query(
      `INSERT INTO contact (${columns.join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      columns.map((column) => values[column]),
    );
  }

  async function plantAccount(id: string, programmeId: string, name: string, tenantId = TENANT_A) {
    await observer.query(
      'INSERT INTO account (id, tenant_id, programme_id, name) VALUES ($1, $2, $3, $4)',
      [id, tenantId, programmeId, name],
    );
  }

  /**
   * Agent 1's leads in A1, with three different orders:
   *   displayName  Amaka, Bashir, Kelechi, Zainab
   *   createdAt    Kelechi, Amaka, Bashir, Zainab
   *   updatedAt    Bashir, Zainab, Amaka, Kelechi
   * Not leads: Chioma (customer) and Obinna (status null) in A1. Decoys that
   * ARE leads, owned by agent 1 where it matters: Damilola (A2) and Grace
   * (tenant B).
   */
  async function plantLeads() {
    await setContact(AMAKA.id, {
      status: 'new',
      owner_user_id: USER_A_AGENT_1,
      source: 'manual',
      updated_at: '2026-03-03T00:00:00Z',
    });
    await setContact(BASHIR.id, {
      status: 'contacted',
      source: 'whatsapp',
      updated_at: '2026-03-01T00:00:00Z',
    });
    await setContact(CHIOMA.id, { status: 'customer', owner_user_id: USER_A_AGENT_1 });
    await plantContact({
      id: KELECHI,
      programmeId: PROGRAMME_A1,
      displayName: 'Kelechi Uba',
      givenNames: 'Kelechi',
      familyName: 'Uba',
      phone: '+2348030076001',
      status: 'unqualified',
      createdAt: '2025-12-31T23:59:00Z',
      updatedAt: '2026-03-04T00:00:00Z',
    });
    await plantContact({
      id: ZAINAB,
      programmeId: PROGRAMME_A1,
      displayName: 'Zainab Danjuma',
      givenNames: 'Zainab',
      familyName: 'Danjuma',
      phone: '+2348030076002',
      status: 'qualified',
      createdAt: '2026-01-01T00:05:00Z',
      updatedAt: '2026-03-02T00:00:00Z',
    });
    await plantContact({
      id: OBINNA,
      programmeId: PROGRAMME_A1,
      displayName: 'Obinna Ede',
      givenNames: 'Obinna',
      familyName: 'Ede',
      phone: '+2348030076003',
      status: null,
    });
    await setContact(DAMILOLA.id, { status: 'new', owner_user_id: USER_A_AGENT_1 });
    await setContact(GRACE.id, { status: 'new' });
  }

  const AGENT_1_LEADS = sorted([AMAKA.id, BASHIR.id, KELECHI, ZAINAB]);

  /** Every id a caller reaches through listLeads, walking every page. */
  async function allLeadIds(headers: Headers, params: Params = []): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const response = await leads(headers, [
        ...params,
        ['limit', '100'],
        ...(cursor === null ? [] : ([['cursor', cursor]] as const)),
      ]);
      expectStatus(response, 200, 'listLeads');
      const page = expectContactPage(response.body, 'listLeads');
      seen.push(...orderOf(page));
      cursor = page.nextCursor;
      if (cursor === null) return seen;
    }
    throw new Error('listLeads never returned a null nextCursor');
  }

  const leadIds = async (headers: Headers, params: Params = []) => {
    const response = await leads(headers, params);
    expectStatus(response, 200, `listLeads ${JSON.stringify(params)}`);
    return idsOf(expectContactPage(response.body, `listLeads ${JSON.stringify(params)}`));
  };

  /** The convert answer: 200, exactly { contact, account }, each checked. */
  function expectConverted(
    response: request.Response,
    where: string,
  ): { contact: Json; account: Json } {
    expectStatus(response, 200, where);
    const body = response.body as Json;
    expect(
      Object.keys(body).sort(),
      `${where}: the answer is exactly { contact, account }`,
    ).toEqual(['account', 'contact']);
    expectSchema(body, 'ConvertContactResponse', where);
    const contact = expectContact(body.contact, `${where}.contact`);
    const account = expectAccount(body.account, `${where}.account`);
    return { contact, account };
  }

  // =========================================================================
  // 1. The contract carries what is served.
  // =========================================================================

  describe('the spec matches what is served', () => {
    it('(self-check) the checker passes the contract’s example and refuses broken copies; const is honoured', () => {
      // Passes on main by design: it tests this file's checker, not the API.
      const responses = specOperation(CONTACTS, 'get')?.responses as Json | undefined;
      const ok = ((responses?.['200'] as Json).content as Json)['application/json'] as Json;
      const example = ok.example as { data: Json[] };
      expectSchema(example, 'ContactPage', 'contract example');
      const row = example.data[0] ?? {};
      const without = (key: string) =>
        Object.fromEntries(Object.entries(row).filter(([candidate]) => candidate !== key));
      const mutants: [string, Json][] = [
        ['a withheld field sent as null', { ...row, emails: null }],
        ['a status display label', { ...row, status: 'Qualified' }],
        ['a tenantId', { ...row, tenantId: TENANT_A }],
        ['a field neither present nor withheld', without('phones')],
        [
          'owner sent while ownerUserId is withheld',
          { ...without('ownerUserId'), withheldFields: ['ownerUserId'] },
        ],
        [
          'displayName listed as withheld',
          { ...without('displayName'), withheldFields: ['displayName'] },
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
      expect(
        schemaErrors(
          {
            id: 'ti_x',
            type: 'consent_changed',
            occurredAt: '2026-10-01T09:12:00.000Z',
            actor: null,
            field: 'phones',
            redacted: true,
          },
          'FieldChangeRedacted',
          'const probe',
        ).length,
        'the checker ignores const',
      ).toBeGreaterThan(0);
    });

    it('Contact.companyName is served: in Contact.properties, string or null, bounded, no longer pending', () => {
      const contact = specSchemas().Contact;
      const property = (contact?.properties as Record<string, Json> | undefined)?.companyName;
      expect(
        property,
        'Contact.properties has no companyName (D-L73: move it when served)',
      ).toBeDefined();
      expect(property?.type).toEqual(['string', 'null']);
      expect(typeof property?.maxLength).toBe('number');
      expect(property?.['x-kasuwa-implemented']).not.toBe(false);
      expect((contact?.required as string[] | undefined) ?? []).not.toContain('companyName');
      expect(pendingContactProperties(), 'companyName is still in the pending part').not.toContain(
        'companyName',
      );
      // The listContacts example (the e2e mock copies it) satisfies the rule
      // with companyName served.
      const responses = specOperation(CONTACTS, 'get')?.responses as Json | undefined;
      const ok = ((responses?.['200'] as Json).content as Json)['application/json'] as Json;
      const example = ok.example as { data: Json[] };
      example.data.forEach((row, index) => expectContact(row, `listContacts example[${index}]`));
    });

    it('the create and update bodies accept companyName (no longer marked unimplemented)', () => {
      for (const name of ['CreateContactRequest', 'UpdateContactRequest']) {
        const property = (specSchemas()[name]?.properties as Record<string, Json> | undefined)
          ?.companyName;
        expect(property, `${name} declares no companyName`).toBeDefined();
        expect(property?.['x-kasuwa-implemented'], `${name}.companyName`).not.toBe(false);
      }
    });

    it('listLeads and convertContact are marked implemented', () => {
      expect(specOperation(LEADS, 'get')?.['x-kasuwa-implemented'], 'listLeads').toBe(true);
      expect(
        specOperation(`${CONTACTS}/{contactId}/convert`, 'post')?.['x-kasuwa-implemented'],
        'convertContact',
      ).toBe(true);
    });

    it('the timeline admits a companyName change by name only, never with values (L3)', () => {
      const base = {
        id: 'ti_t0076',
        type: 'field_changed',
        occurredAt: '2026-10-01T09:12:00.000Z',
        actor: null,
      };
      // The controls: a known redacted field passes, an invented one fails.
      expect(
        schemaErrors({ ...base, field: 'phones', redacted: true }, 'TimelineItem', 'phones'),
      ).toEqual([]);
      expect(
        schemaErrors({ ...base, field: 'notAField', redacted: true }, 'TimelineItem', 'invented')
          .length,
      ).toBeGreaterThan(0);
      expect(
        schemaErrors({ ...base, field: 'companyName', redacted: true }, 'TimelineItem', 'company'),
        'a companyName change is not a valid redacted timeline item',
      ).toEqual([]);
      expect(
        schemaErrors(
          { ...base, field: 'companyName', before: 'Old Co', after: 'New Co' },
          'TimelineItem',
          'company with values',
        ).length,
        'the timeline would carry a company name as a value',
      ).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 2. The migration and the column, on the shared database.
  // =========================================================================

  describe('the company_name migration', () => {
    it('exactly one migration adds contact.company_name; it sorts after main’s last and is applied', async () => {
      const files = companyNameMigrationFiles();
      expect(files, 'no single migration adds contact.company_name').toHaveLength(1);
      const file = files[0] ?? '';
      expect(file > LAST_ON_MAIN, `${file} does not sort after ${LAST_ON_MAIN}`).toBe(true);
      const applied = await observer.query<{ id: string }>(
        'SELECT id FROM _kasuwa_migration WHERE id = $1',
        [file.replace(/\.sql$/, '')],
      );
      expect(applied.rows, `${file} has not been applied by the runner`).toHaveLength(1);
    });

    it('leaves 0001, 0019, 0025, 0026 and 0027 unedited', () => {
      // Regression guard; holds on main by construction.
      const current = new Map(loadMigrations().map((row) => [row.id, row.checksum]));
      for (const [id, checksum] of Object.entries(PINNED_CHECKSUMS)) {
        expect(current.get(id), `${id} was edited, renamed or removed`).toBe(checksum);
      }
    });

    it('adds no SECURITY DEFINER function', async () => {
      // Regression guard; holds on main.
      const definers = await observer.query<{ name: string }>(DEFINERS_SQL);
      expect(definers.rows.map((row) => row.name)).toEqual([
        'app.resolve_session',
        'app.resolve_tenant_by_slug',
      ]);
    });

    it('contact keeps RLS enabled and FORCED and stays tenant-scoped', async () => {
      // Regression guard; holds on main.
      const security = (await readTableSecurity(appPool)).find((row) => row.table === 'contact');
      expect(security?.rlsEnabled).toBe(true);
      expect(security?.rlsForced).toBe(true);
      expect([...TENANT_SCOPED_TABLES]).toContain('contact');
    });

    it('company_name is text, nullable, with no default but NULL', async () => {
      const columns = (
        await observer.query<{
          column: string;
          type: string;
          notnull: boolean;
          default: string | null;
        }>(CONTACT_COLUMNS_SQL)
      ).rows;
      expect(columns.length, 'table contact not found').toBeGreaterThan(0);
      const column = columns.find((row) => row.column === 'company_name');
      expect(column, 'contact has no company_name column').toBeDefined();
      expect(companyTypeOk(column?.type ?? ''), `company_name is ${String(column?.type)}`).toBe(
        true,
      );
      expect(column?.notnull, 'company_name must be nullable: null is "no company"').toBe(false);
      expect(column?.default ?? 'NULL').toMatch(/^NULL(::.*)?$/i);
    });

    it('src/schema.ts mirrors company_name on contact (nullable)', () => {
      const mirrored = new Map<string, { sqlType: string; notNull: boolean }>();
      for (const value of Object.values(contactTable as unknown as Record<string, unknown>)) {
        const column = value as { name?: unknown; notNull?: unknown; getSQLType?: unknown };
        if (
          typeof column === 'object' &&
          column !== null &&
          typeof column.name === 'string' &&
          typeof column.notNull === 'boolean' &&
          typeof column.getSQLType === 'function'
        ) {
          const sqlType = (column.getSQLType as () => unknown).call(column);
          mirrored.set(column.name, { sqlType: String(sqlType), notNull: column.notNull });
        }
      }
      // Guards the reader: contact has mirrored display_name since 0001.
      expect(mirrored.get('display_name'), 'the Drizzle reader found no columns').toEqual({
        sqlType: 'text',
        notNull: true,
      });
      const company = mirrored.get('company_name');
      expect(company, 'company_name is not in the contact table of src/schema.ts').toBeDefined();
      expect(companyTypeOk(company?.sqlType ?? '')).toBe(true);
      expect(company?.notNull).toBe(false);
    });

    it('kasuwa_app writes and reads company_name in its own programme, and RLS still hides tenant B', async () => {
      requireCompanyColumn();
      const seen = await rolledBackTenantTx(appPool, TENANT_A, USER_A_AGENT_1, async (query) => {
        const updated = await query<{ id: string }>(
          `UPDATE contact SET company_name = 'Zuma Rock Quarries' WHERE id = $1 RETURNING id`,
          [AMAKA.id],
        );
        const read = await query<{ company_name: string | null }>(
          'SELECT company_name FROM contact WHERE id = $1',
          [AMAKA.id],
        );
        const foreign = await query<{ id: string }>(
          `UPDATE contact SET company_name = 'Hijacked' WHERE id = ANY($1::uuid[]) RETURNING id`,
          [[DAMILOLA.id, GRACE.id]],
        );
        return { updated: updated.length, read: read[0]?.company_name, foreign: foreign.length };
      });
      expect(seen).toEqual({ updated: 1, read: 'Zuma Rock Quarries', foreign: 0 });
    });

    describe('every tenant has a standard contact.company_name field', () => {
      it.each(SEED_TENANTS.map((tenant) => [tenant.slug, tenant.id] as const))(
        '%s: a standard text field_def company_name on the standard contact object',
        async (_slug, tenantId) => {
          const rows = (await observer.query<FieldRow>(CONTACT_FIELDS_SQL, [tenantId])).rows;
          expect(rows.length, 'the tenant has no standard contact fields').toBeGreaterThan(0);
          const company = rows.find((row) => row.api_name === 'company_name');
          expect(company, 'no standard field_def contact.company_name').toBeDefined();
          expect(company?.type).toBe('text');
          expect(company?.is_required).toBe(false);
        },
      );

      it('ensureStandardObjectDefs gives a fresh tenant the same contact fields as the seed', async () => {
        const seeded = (await observer.query<FieldRow>(CONTACT_FIELDS_SQL, [TENANT_A])).rows;
        const fresh = await rolledBackMigratorTx(observer, async (query) => {
          const tenantId = randomUUID();
          await query(`INSERT INTO tenant (id, name, slug) VALUES ($1, 'T-0076 Fresh Ltd', $2)`, [
            tenantId,
            `t0076-fresh-${RUN}`,
          ]);
          await ensureStandardObjectDefs((text, values) => query(text, [...values]), tenantId);
          return query<FieldRow>(CONTACT_FIELDS_SQL, [tenantId]);
        });
        expect(
          fresh.map((row) => row.api_name),
          'the catalogue has no company_name',
        ).toContain('company_name');
        expect(fresh).toEqual(seeded);
      });
    });
  });

  // =========================================================================
  // 3. Contact.companyName on the contact routes.
  // =========================================================================

  describe('Contact.companyName on the contact routes', () => {
    const COMPANY = 'Zuma Rock Quarries';

    beforeEach(async () => {
      await setContact(AMAKA.id, { company_name: COMPANY });
    });

    it('get and list serve it; a contact without one says null', async () => {
      const amaka = expectContact((await getContact(AGENT_1, AMAKA.id)).body, 'get');
      expect(amaka.companyName).toBe(COMPANY);
      const bashir = expectContact((await getContact(AGENT_1, BASHIR.id)).body, 'get bashir');
      expect(bashir.companyName, 'no company is null, never omitted').toBeNull();
      const listed = await contacts(AGENT_1);
      expectStatus(listed, 200, 'listContacts');
      const page = expectContactPage(listed.body, 'listContacts');
      expect(page.data.find((row) => row.id === AMAKA.id)?.companyName).toBe(COMPANY);
    });

    it('createContact stores it and answers it; null is accepted', async () => {
      const company = unique('Kano Grains Co.');
      const created = await createContact(SUPERVISOR, {
        programmeId: PROGRAMME_A1,
        displayName: unique('T0076 Create'),
        companyName: company,
      });
      expectStatus(created, 201, 'create with companyName');
      const contact = expectContact(created.body, 'create');
      expect(contact.companyName).toBe(company);
      expect((await contactRow(contact.id as string))?.company_name).toBe(company);

      const none = await createContact(SUPERVISOR, {
        programmeId: PROGRAMME_A1,
        displayName: unique('T0076 Create'),
        companyName: null,
      });
      expectStatus(none, 201, 'create with null companyName');
      expect(expectContact(none.body, 'create null').companyName).toBeNull();
    });

    it('updateContact sets it and null clears it; version advances by one each time', async () => {
      const version = await versionOf(AMAKA.id);
      const renamed = await updateContact(SUPERVISOR, AMAKA.id, {
        version,
        companyName: 'Jos Tin Smelting',
      });
      expectStatus(renamed, 200, 'set');
      expect(expectContact(renamed.body, 'set').companyName).toBe('Jos Tin Smelting');
      expect(await versionOf(AMAKA.id)).toBe(version + 1);
      const cleared = await updateContact(SUPERVISOR, AMAKA.id, {
        version: version + 1,
        companyName: null,
      });
      expectStatus(cleared, 200, 'clear');
      expect(expectContact(cleared.body, 'clear').companyName).toBeNull();
      expect((await contactRow(AMAKA.id))?.company_name).toBeNull();
    });

    it('200 characters are accepted; 201, a NUL, a number or an object are 400 and write nothing', async () => {
      const at200 = await updateContact(SUPERVISOR, AMAKA.id, {
        version: await versionOf(AMAKA.id),
        companyName: 'C'.repeat(200),
      });
      expectStatus(at200, 200, 'a 200-character company');
      const before = await contactRow(AMAKA.id);
      for (const companyName of ['C'.repeat(201), 'Zuma\u0000 Rock', 42, { name: 'X' }]) {
        expectError(
          await updateContact(SUPERVISOR, AMAKA.id, {
            version: Number(before?.version),
            companyName,
          }),
          400,
          'validation_failed',
        );
        const name = unique('T0076 Bad');
        expectError(
          await createContact(SUPERVISOR, {
            programmeId: PROGRAMME_A1,
            displayName: name,
            companyName,
          }),
          400,
          'validation_failed',
        );
      }
      expect(await contactRow(AMAKA.id)).toEqual(before);
    });

    describe('field security', () => {
      it('withheld: omitted and listed on get, list and listLeads; the value is nowhere; the admin set sees it', async () => {
        await setContact(AMAKA.id, { status: 'new' });
        await lockField('contact', 'company_name', 'agent', 'none');
        const one = await getContact(AGENT_1, AMAKA.id);
        expectStatus(one, 200, 'agent get');
        const listed = await contacts(AGENT_1);
        expectStatus(listed, 200, 'agent listContacts');
        const leadPage = await leads(AGENT_1);
        expectStatus(leadPage, 200, 'agent listLeads');
        const rows = [
          expectContact(one.body, 'get'),
          ...expectContactPage(listed.body, 'list').data,
          ...expectContactPage(leadPage.body, 'leads').data,
        ];
        expect(rows.length).toBeGreaterThanOrEqual(3);
        for (const row of rows) {
          expect('companyName' in row, `${String(row.id)}: omitted, not nulled`).toBe(false);
          expect(row.withheldFields).toContain('companyName');
        }
        for (const body of [one.body, listed.body, leadPage.body]) {
          expect(JSON.stringify(body)).not.toContain(COMPANY);
        }
        const admin = expectContact((await getContact(SUPERVISOR, AMAKA.id)).body, 'admin');
        expect(admin.companyName).toBe(COMPANY);
        expect(admin.withheldFields).not.toContain('companyName');
      });

      describe('a writer from whom it is withheld (tenant admin holding the agent set in A1)', () => {
        beforeEach(async () => {
          await setTenantAdmin(USER_A_AGENT_1, true);
        });

        it.each([
          ['none', 'setting it on create', 'create', { companyName: 'Any Co' }],
          ['none', 'setting it on update', 'update', { companyName: 'Any Co' }],
          ['none', 'clearing it on update', 'update', { companyName: null }],
          ['read', 'setting a read-only one on update', 'update', { companyName: 'Any Co' }],
        ] as const)(
          'level %s, %s: 403 field_not_editable at companyName, nothing written',
          async (level, _label, op, fields) => {
            await lockField('contact', 'company_name', 'agent', level);
            // The control: the flag holder may write contacts at all.
            expectStatus(
              await updateContact(AGENT_1, BASHIR.id, {
                version: await versionOf(BASHIR.id),
                status: 'contacted',
              }),
              200,
              'the flag holder writes another field',
            );
            const before = await contactRow(AMAKA.id);
            const name = unique('T0076 FLS');
            const response =
              op === 'create'
                ? await createContact(AGENT_1, {
                    programmeId: PROGRAMME_A1,
                    displayName: name,
                    ...fields,
                  })
                : await updateContact(AGENT_1, AMAKA.id, {
                    version: Number(before?.version),
                    ...fields,
                  });
            const body = expectError(response, 403, 'not_permitted');
            expect(detailsOf(body)).toContainEqual({
              path: 'companyName',
              code: 'field_not_editable',
            });
            expect(await contactRow(AMAKA.id)).toEqual(before);
            expect(await contactsCompany('Any Co')).toBe(0);
          },
        );
      });
    });

    describe('permissions', () => {
      it.each(CLAIM_KEYS)(
        'the %s set (D-P14) may not send companyName, alone or beside status: 403, nothing written',
        async (key) => {
          await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, key);
          const before = await contactRow(AMAKA.id);
          const version = Number(before?.version);
          for (const body of [
            { version, companyName: 'Claimed Co' },
            { version, status: 'contacted', companyName: 'Claimed Co' },
            { version, companyName: null },
          ]) {
            expectError(await updateContact(AGENT_1, AMAKA.id, body), 403, 'not_permitted');
          }
          expect(await contactRow(AMAKA.id)).toEqual(before);
          // The control: this set's D-P14 right is live, so the 403 is about companyName.
          expectStatus(
            await updateContact(AGENT_1, AMAKA.id, { version, status: 'contacted' }),
            200,
            `${key} changes status`,
          );
          expect((await contactRow(AMAKA.id))?.company_name).toBe(COMPANY);
        },
      );

      it.each(READ_ONLY_KEYS)('the %s set may not write it: 403, nothing written', async (key) => {
        await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, key);
        const before = await contactRow(AMAKA.id);
        expectError(
          await updateContact(AGENT_1, AMAKA.id, {
            version: Number(before?.version),
            companyName: 'Read Only Co',
          }),
          403,
          'not_permitted',
        );
        expect(await contactRow(AMAKA.id)).toEqual(before);
        expect(expectContact((await getContact(AGENT_1, AMAKA.id)).body, 'reads').companyName).toBe(
          COMPANY,
        );
      });

      it('the admin set held in the programme writes it, without the tenant-admin flag', async () => {
        await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'admin');
        const response = await updateContact(AGENT_1, AMAKA.id, {
          version: await versionOf(AMAKA.id),
          companyName: 'Admin Set Co',
        });
        expectStatus(response, 200, 'programme admin');
        expect((await contactRow(AMAKA.id))?.company_name).toBe('Admin Set Co');
      });
    });

    it('audit: create and update name companyName by name only; its value is nowhere in the event', async () => {
      const company = 'Adaeze Okonkwo Trading';
      const before = await auditIds();
      const created = await createContact(SUPERVISOR, {
        programmeId: PROGRAMME_A1,
        displayName: unique('T0076 Audit'),
        companyName: company,
      });
      expectStatus(created, 201, 'create');
      const updated = await updateContact(SUPERVISOR, AMAKA.id, {
        version: await versionOf(AMAKA.id),
        companyName: `${company} II`,
      });
      expectStatus(updated, 200, 'update');
      const events = await auditSince(before);
      expect(events, 'one event per write').toHaveLength(2);
      for (const event of events) {
        const change = event.changes.find((candidate) => candidate.field === 'companyName');
        expect(change, `${event.action}: companyName is not named`).toBeDefined();
        expect(change?.redacted, 'companyName is recorded by name only').toBe(true);
        expect(change?.before ?? null).toBeNull();
        expect(change?.after ?? null).toBeNull();
        const text = JSON.stringify(event);
        expect(text).not.toContain('Okonkwo');
        expect(text).not.toContain(COMPANY);
      }
    });
  });

  // =========================================================================
  // 4. listLeads: what a lead is, and scope.
  // =========================================================================

  describe('listLeads: what a lead is, and whose', () => {
    beforeEach(async () => {
      await plantLeads();
    });

    it('agent 1 gets exactly A1’s new, contacted, qualified and unqualified contacts: no customer, no null status', async () => {
      const response = await leads(AGENT_1);
      expectStatus(response, 200, 'listLeads');
      const page = expectContactPage(response.body, 'listLeads');
      expect(idsOf(page)).toEqual(AGENT_1_LEADS);
      for (const row of page.data) {
        expect(LEAD_STATUSES as readonly unknown[], `${String(row.id)} is not a lead`).toContain(
          row.status,
        );
        expect(row.programmeId).toBe(PROGRAMME_A1);
      }
      expect(page.nextCursor).toBeNull();
      expectNoTotals(response, 'listLeads');
      expectNotShared(response, 'listLeads');
      // The control: listContacts still lists the customer and the null status.
      const all = expectContactPage((await contacts(AGENT_1, [['limit', '100']])).body, 'contacts');
      expect(idsOf(all)).toEqual(expect.arrayContaining([CHIOMA.id, OBINNA]));
    });

    it('scope: the supervisor gets A1 and A2, tenant B its own, a user with no programme nothing', async () => {
      expect(sorted(await allLeadIds(SUPERVISOR))).toEqual(sorted([...AGENT_1_LEADS, DAMILOLA.id]));
      expect(await allLeadIds(TENANT_B_USER)).toEqual([GRACE.id]);
      expect(await allLeadIds(AGENT_2)).toEqual([DAMILOLA.id]);
      // Vacuous alone; the lines above are its control.
      expect(await allLeadIds(NO_PROGRAMME)).toEqual([]);
    });

    it('a lead moved to customer leaves the list; a contact moved to a lead status joins it', async () => {
      expectStatus(
        await updateContact(SUPERVISOR, AMAKA.id, {
          version: await versionOf(AMAKA.id),
          status: 'customer',
        }),
        200,
        'to customer',
      );
      expectStatus(
        await updateContact(SUPERVISOR, CHIOMA.id, {
          version: await versionOf(CHIOMA.id),
          status: 'contacted',
        }),
        200,
        'back to contacted',
      );
      expect(await leadIds(AGENT_1)).toEqual(sorted([BASHIR.id, KELECHI, ZAINAB, CHIOMA.id]));
    });

    it('status narrows to lead statuses, any of; customer, a label and a fifth value are 400', async () => {
      expect(await leadIds(AGENT_1, [['status', 'new']])).toEqual([AMAKA.id]);
      expect(
        await leadIds(AGENT_1, [
          ['status', 'qualified'],
          ['status', 'unqualified'],
        ]),
      ).toEqual(sorted([ZAINAB, KELECHI]));
      for (const params of [
        [['status', 'customer']],
        [['status', 'Qualified']],
        [['status', 'lead']],
        [
          ['status', 'new'],
          ['status', 'customer'],
        ],
        [
          ['status', 'new'],
          ['status', 'contacted'],
          ['status', 'qualified'],
          ['status', 'unqualified'],
          ['status', 'new'],
        ],
      ] as const) {
        expectError(await leads(AGENT_1, params), 400, 'validation_failed');
      }
    });

    it('owner and source filter as on listContacts, inside scope only', async () => {
      // Damilola (A2) is a lead owned by agent 1 too: it must not appear.
      expect(await leadIds(AGENT_1, [['owner', 'me']])).toEqual([AMAKA.id]);
      expect(await leadIds(AGENT_1, [['owner', 'unassigned']])).toEqual(
        sorted([BASHIR.id, KELECHI, ZAINAB]),
      );
      expect(await leadIds(AGENT_1, [['source', 'whatsapp']])).toEqual([BASHIR.id]);
      expect(
        await leadIds(AGENT_1, [
          ['owner', 'me'],
          ['source', 'whatsapp'],
        ]),
      ).toEqual([]);
    });

    it('an owner filter naming a user agent 1 cannot see answers byte-for-byte as an invented id', async () => {
      await setContact(DAMILOLA.id, { owner_user_id: USER_A_AGENT_2 });
      const invented = await leads(AGENT_1, [['owner', NOWHERE]]);
      const sibling = await leads(AGENT_1, [['owner', USER_A_AGENT_2]]);
      const otherTenant = await leads(AGENT_1, [['owner', USER_B_AGENT_1]]);
      for (const response of [invented, sibling, otherTenant]) {
        expectStatus(response, 200, 'owner filter');
        expectContactPage(response.body, 'owner filter');
      }
      expect(sibling.body).toEqual(invented.body);
      expect(otherTenant.body).toEqual(invented.body);
    });

    it('unknown query parameters are ignored: neither a programme nor a lifecycle widens or narrows', async () => {
      const plain = await leadIds(AGENT_1);
      expect(plain).toEqual(AGENT_1_LEADS);
      expect(
        await leadIds(AGENT_1, [
          ['programmeId', PROGRAMME_A2],
          ['programmeIds', PROGRAMME_A2],
          ['tenantId', TENANT_B],
          ['scope', 'all'],
          ['lifecycle', 'all'],
          ['includeCustomers', 'true'],
          ['view', 'contacts'],
        ]),
      ).toEqual(plain);
    });

    it('scope headers are 400 validation_failed', async () => {
      await leads(AGENT_1).expect(200);
      for (const [header, value] of SCOPE_HEADERS) {
        expectError(await leads(AGENT_1).set(header, value), 400, 'validation_failed');
      }
    });

    it('is 401 without a session', async () => {
      await leads(AGENT_1).expect(200);
      expectError(await request(server()).get(LEADS), 401, 'not_authenticated');
    });
  });

  // =========================================================================
  // 5. listLeads: sort and keyset paging.
  // =========================================================================

  describe('listLeads: sort and paging', () => {
    beforeEach(async () => {
      await plantLeads();
    });

    const order = async (sort: string | null) => {
      const response = await leads(AGENT_1, sort === null ? [] : [['sort', sort]]);
      expectStatus(response, 200, `sort=${String(sort)}`);
      return orderOf(expectContactPage(response.body, `sort=${String(sort)}`));
    };

    it('orders by each listContacts key; the default is -createdAt', async () => {
      expect(await order('displayName')).toEqual([AMAKA.id, BASHIR.id, KELECHI, ZAINAB]);
      expect(await order('-displayName')).toEqual([ZAINAB, KELECHI, BASHIR.id, AMAKA.id]);
      expect(await order('createdAt')).toEqual([KELECHI, AMAKA.id, BASHIR.id, ZAINAB]);
      expect(await order('-createdAt')).toEqual([ZAINAB, BASHIR.id, AMAKA.id, KELECHI]);
      expect(await order('updatedAt')).toEqual([BASHIR.id, ZAINAB, AMAKA.id, KELECHI]);
      expect(await order('-updatedAt')).toEqual([KELECHI, AMAKA.id, ZAINAB, BASHIR.id]);
      expect(await order(null)).toEqual([ZAINAB, BASHIR.id, AMAKA.id, KELECHI]);
    });

    it('limit 2 gives two rows and a cursor, then the rest; every row exactly once under each sort', async () => {
      for (const sort of ['-createdAt', 'displayName', 'updatedAt']) {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 10; guard += 1) {
          const response = await leads(AGENT_1, [
            ['sort', sort],
            ['limit', '2'],
            ...(cursor === null ? [] : ([['cursor', cursor]] as const)),
          ]);
          expectStatus(response, 200, `sort=${sort} page ${guard + 1}`);
          const page = expectContactPage(response.body, `sort=${sort} page ${guard + 1}`);
          expect(page.data.length).toBeLessThanOrEqual(2);
          expectNoTotals(response, 'page');
          seen.push(...orderOf(page));
          cursor = page.nextCursor;
          if (cursor === null) break;
        }
        expect(cursor, `sort=${sort}: paging never ended`).toBeNull();
        expect(seen, `sort=${sort}: in order, each once`).toEqual(await order(sort));
      }
    });

    it('a cursor issued for one sort is 400 invalid_cursor under another; a malformed one too', async () => {
      const first = await leads(AGENT_1, [['limit', '1']]);
      expectStatus(first, 200, 'page 1');
      const cursor = expectContactPage(first.body, 'page 1').nextCursor ?? '';
      expect(cursor).not.toBe('');
      for (const params of [
        [
          ['sort', 'displayName'],
          ['cursor', cursor],
        ],
        [['cursor', 'not-base64-json']],
      ] as const) {
        const body = expectError(await leads(AGENT_1, params), 400, 'validation_failed');
        expect(detailsOf(body)).toContainEqual({ path: 'cursor', code: 'invalid_cursor' });
      }
    });

    it('a cursor never widens the view: the supervisor’s, or one from listContacts, yields only agent 1’s leads', async () => {
      const foreign = await leads(SUPERVISOR, [
        ['sort', 'displayName'],
        ['limit', '1'],
      ]);
      expectStatus(foreign, 200, 'supervisor page 1');
      const supervisorCursor = expectContactPage(foreign.body, 'supervisor').nextCursor ?? '';
      const replayed = await leads(AGENT_1, [
        ['sort', 'displayName'],
        ['limit', '100'],
        ['cursor', supervisorCursor],
      ]);
      expectStatus(replayed, 200, 'agent 1 with the supervisor’s cursor');
      expect(orderOf(expectContactPage(replayed.body, 'replayed'))).toEqual([
        BASHIR.id,
        KELECHI,
        ZAINAB,
      ]);

      // listContacts by name: Amaka Obi, Bashir Lawal, Chioma (customer),
      // Kelechi, Obinna (null), Zainab. A cursor after Bashir, replayed here.
      const contactPage = await contacts(AGENT_1, [
        ['sort', 'displayName'],
        ['limit', '2'],
      ]);
      expectStatus(contactPage, 200, 'listContacts page 1');
      const contactCursor = expectContactPage(contactPage.body, 'contacts').nextCursor ?? '';
      const crossed = await leads(AGENT_1, [
        ['sort', 'displayName'],
        ['limit', '100'],
        ['cursor', contactCursor],
      ]);
      if (crossed.status === 400) {
        expect(detailsOf(expectError(crossed, 400, 'validation_failed'))).toContainEqual({
          path: 'cursor',
          code: 'invalid_cursor',
        });
      } else {
        expectStatus(crossed, 200, 'a listContacts cursor on listLeads');
        const ids = orderOf(expectContactPage(crossed.body, 'crossed'));
        expect(ids).not.toContain(CHIOMA.id);
        expect(ids).not.toContain(OBINNA);
        for (const id of ids) expect(AGENT_1_LEADS).toContain(id);
      }
    });

    it('limit 0 and 101, a sort on companyName or status, and an empty or 101-character q are 400', async () => {
      for (const params of [
        [['limit', '0']],
        [['limit', '101']],
        [['sort', 'companyName']],
        [['sort', '-status']],
        [['sort', 'emails']],
        [['q', '']],
        [['q', 'a'.repeat(101)]],
      ] as const) {
        expectError(await leads(AGENT_1, params), 400, 'validation_failed');
      }
      await leads(AGENT_1, [['q', 'a'.repeat(100)]]).expect(200);
    });
  });

  // =========================================================================
  // 6. listLeads: q, and field security.
  // =========================================================================

  describe('listLeads: q and field security', () => {
    const COMPANY = 'Zuma Rock Quarries';

    beforeEach(async () => {
      await plantLeads();
      await setContact(ZAINAB, { company_name: COMPANY });
    });

    it('q finds names, numbers in any format and the company; never a customer or a null status', async () => {
      expect(await leadIds(AGENT_1, [['q', 'Amaka']])).toEqual([AMAKA.id]);
      expect(await leadIds(AGENT_1, [['q', 'lawal']])).toEqual([BASHIR.id]);
      for (const number of ['08030076001', '+2348030076001', '2348030076001']) {
        expect(await leadIds(AGENT_1, [['q', number]]), `q=${number}`).toEqual([KELECHI]);
      }
      expect(await leadIds(AGENT_1, [['q', COMPANY]])).toEqual([ZAINAB]);
      expect(await leadIds(AGENT_1, [['q', COMPANY.toLowerCase()]])).toEqual([ZAINAB]);
      expect(await leadIds(AGENT_1, [['q', 'Chioma']]), 'a customer is not a lead').toEqual([]);
      expect(await leadIds(AGENT_1, [['q', 'Obinna']]), 'a null status is not a lead').toEqual([]);
      for (const q of ['%', '_', '.*']) expect(await leadIds(AGENT_1, [['q', q]])).toEqual([]);
    });

    it('q never searches outside scope', async () => {
      await setContact(DAMILOLA.id, { company_name: 'Sokoto Hides Ltd' });
      expect(await leadIds(AGENT_1, [['q', 'Damilola']])).toEqual([]);
      expect(await leadIds(AGENT_1, [['q', 'Sokoto Hides Ltd']])).toEqual([]);
      expect(await leadIds(SUPERVISOR, [['q', 'Sokoto Hides Ltd']])).toEqual([DAMILOLA.id]);
    });

    it('a withheld company is never matched; the admin set still finds it', async () => {
      await lockField('contact', 'company_name', 'agent', 'none');
      expect(
        await leadIds(AGENT_1, [['q', COMPANY]]),
        'q is an oracle on a withheld value',
      ).toEqual([]);
      expect(await leadIds(SUPERVISOR, [['q', COMPANY]])).toEqual([ZAINAB]);
    });

    it('q follows field security PER ROW: one caller finds the company where readable, not where withheld', async () => {
      // Agent 2: admin in A1 (readable), agent in A2 (company withheld).
      await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A1, 'admin');
      await setContact(DAMILOLA.id, { company_name: COMPANY });
      await lockField('contact', 'company_name', 'agent', 'none');
      expect(await leadIds(AGENT_2, [['q', COMPANY]])).toEqual([ZAINAB]);
      // The control: with the field readable in A2 too, both are found.
      await lockField('contact', 'company_name', 'agent', 'read');
      expect(await leadIds(AGENT_2, [['q', COMPANY]])).toEqual(sorted([ZAINAB, DAMILOLA.id]));
    });

    it('a withheld phone is never matched by number', async () => {
      await lockField('contact', 'phones', 'agent', 'none');
      expect(await leadIds(AGENT_1, [['q', '08030076001']])).toEqual([]);
      expect(await leadIds(SUPERVISOR, [['q', '08030076001']])).toEqual([KELECHI]);
    });

    it('status withheld: 400 field_withheld at status, with or without a status parameter, and no row', async () => {
      await lockField('contact', 'status', 'agent', 'none');
      const cases: Params[] = [[], [['status', 'new']], [['q', 'Amaka']]];
      for (const params of cases) {
        const response = await leads(AGENT_1, params);
        const body = expectError(response, 400, 'validation_failed');
        expect(detailsOf(body)).toContainEqual({ path: 'status', code: 'field_withheld' });
        for (const id of AGENT_1_LEADS) expect(JSON.stringify(response.body)).not.toContain(id);
      }
      // The control: the admin set lists them.
      expect(await leadIds(SUPERVISOR)).toEqual(sorted([...AGENT_1_LEADS, DAMILOLA.id]));
    });

    it('status withheld in ANY programme the caller reaches refuses the whole list', async () => {
      // Agent 2: admin in A1 (status readable), agent in A2 (withheld).
      await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A1, 'admin');
      await lockField('contact', 'status', 'agent', 'none');
      const body = expectError(await leads(AGENT_2), 400, 'validation_failed');
      expect(detailsOf(body)).toContainEqual({ path: 'status', code: 'field_withheld' });
    });

    it('status read-only still lists: reading is enough for a view', async () => {
      await lockField('contact', 'status', 'agent', 'read');
      expect(await leadIds(AGENT_1)).toEqual(AGENT_1_LEADS);
    });

    it('rows are under Contact field security: a withheld field is omitted and listed', async () => {
      const probe = 'zainab.t0076-probe@example.test';
      await setContact(ZAINAB, { emails: JSON.stringify([probe]) });
      await lockField('contact', 'emails', 'agent', 'none');
      const response = await leads(AGENT_1);
      expectStatus(response, 200, 'listLeads');
      const page = expectContactPage(response.body, 'withheld emails');
      expect(page.data.length).toBe(4);
      for (const row of page.data) {
        expect('emails' in row).toBe(false);
        expect(row.withheldFields).toContain('emails');
      }
      expect(JSON.stringify(response.body)).not.toContain(probe);
    });

    it('a filter on a withheld owner or source is 400 field_withheld', async () => {
      await lockField('contact', 'owner_user_id', 'agent', 'none');
      const owner = expectError(await leads(AGENT_1, [['owner', 'me']]), 400, 'validation_failed');
      expect(
        detailsOf(owner).some(
          (detail) =>
            (detail.path === 'owner' || detail.path === 'ownerUserId') &&
            detail.code === 'field_withheld',
        ),
        JSON.stringify(owner),
      ).toBe(true);
      await lockField('contact', 'source', 'agent', 'none');
      const source = expectError(
        await leads(AGENT_1, [['source', 'whatsapp']]),
        400,
        'validation_failed',
      );
      expect(detailsOf(source)).toContainEqual({ path: 'source', code: 'field_withheld' });
      await leads(SUPERVISOR, [['source', 'whatsapp']]).expect(200);
    });

    it.each([
      ['listContacts', CONTACTS],
      ['listLeads', LEADS],
    ])(
      '%s: an account filter is never an oracle on a withheld accountId (the task’s Watch for)',
      async (_name, path) => {
        await leads(AGENT_1).expect(200);
        await setContact(AMAKA.id, { account_id: IKOYI.id });
        await lockField('contact', 'account_id', 'agent', 'none');
        for (const parameter of ['account', 'accountId']) {
          const real = await request(server())
            .get(withQuery(path, [[parameter, IKOYI.id]]))
            .set(AGENT_1);
          const invented = await request(server())
            .get(withQuery(path, [[parameter, NOWHERE]]))
            .set(AGENT_1);
          expect([200, 400], JSON.stringify(real.body)).toContain(real.status);
          if (real.status === 400) {
            expect(detailsOf(expectError(real, 400, 'validation_failed'))).toContainEqual({
              path: parameter,
              code: 'field_withheld',
            });
          }
          expect(invented.status).toBe(real.status);
          expect(invented.body, `${parameter}: the linked account changes the answer`).toEqual(
            real.body,
          );
        }
      },
    );
  });

  // =========================================================================
  // 7. convertContact: what it does.
  // =========================================================================

  describe('convertContact: the conversion', () => {
    const COMPANY = 'Zuma Rock Quarries';

    beforeEach(async () => {
      await plantLeads();
      await setContact(AMAKA.id, { company_name: COMPANY });
      await plantAccount(OJA, PROGRAMME_A1, 'Ọjà Foods Ltd');
    });

    it('linking an existing account: qualified, linked, version +1, the account and the company untouched', async () => {
      const version = await versionOf(AMAKA.id);
      const accountBefore = await accountRow(IKOYI.id);
      const response = await convert(SUPERVISOR, AMAKA.id, { version, accountId: IKOYI.id });
      const { contact, account } = expectConverted(response, 'convert');
      expect(contact).toMatchObject({
        id: AMAKA.id,
        status: 'qualified',
        accountId: IKOYI.id,
        companyName: COMPANY,
        version: version + 1,
      });
      expect(account).toMatchObject({ id: IKOYI.id, name: IKOYI.name, programmeId: PROGRAMME_A1 });
      const row = await contactRow(AMAKA.id);
      expect(row?.status).toBe('qualified');
      expect(row?.account_id).toBe(IKOYI.id);
      expect(row?.company_name).toBe(COMPANY);
      expect(Number(row?.version), 'one UPDATE: version moves exactly once').toBe(version + 1);
      expect(await accountRow(IKOYI.id), 'convert changed the existing account').toEqual(
        accountBefore,
      );
    });

    it('the answer is getContact’s contact and getAccount’s account, deep-equal', async () => {
      const response = await convert(SUPERVISOR, BASHIR.id, {
        version: await versionOf(BASHIR.id),
        accountId: IKOYI.id,
      });
      const { contact, account } = expectConverted(response, 'convert');
      expect(contact).toEqual((await getContact(SUPERVISOR, BASHIR.id)).body);
      expect(account).toEqual((await getAccount(SUPERVISOR, IKOYI.id)).body);
    });

    it('creating an account: in the contact’s programme, unassigned, defaults, exactly one; the company is not copied', async () => {
      const name = unique('Kano Grains Co.');
      const count = await accountCount();
      const version = await versionOf(AMAKA.id);
      const response = await convert(SUPERVISOR, AMAKA.id, { version, newAccount: { name } });
      const { contact, account } = expectConverted(response, 'convert new');
      expect(account.id).toMatch(UUID);
      expect(account).toMatchObject({
        name,
        programmeId: PROGRAMME_A1,
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
      expect(contact).toMatchObject({
        status: 'qualified',
        accountId: account.id,
        companyName: COMPANY,
        version: version + 1,
      });
      expect(await accountCount()).toBe(count + 1);
      const rows = await accountsNamed(name);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: account.id,
        tenant_id: TENANT_A,
        programme_id: PROGRAMME_A1,
        owner_user_id: null,
      });
      expect(await accountsNamed(COMPANY), 'companyName was copied into an account').toEqual([]);
      // The account is a real account: readable, and lists its contact.
      const listed = await request(server())
        .get(accountContactsPath(account.id as string))
        .set(SUPERVISOR);
      expectStatus(listed, 200, 'listAccountContacts');
      expect((listed.body as { data: Json[] }).data.map((row) => row.id)).toEqual([AMAKA.id]);
    });

    it('a new account for an A2 lead lands in A2, even for a caller who reaches A1 too', async () => {
      const name = unique('Telco Y Dealer');
      const response = await convert(SUPERVISOR, DAMILOLA.id, {
        version: await versionOf(DAMILOLA.id),
        newAccount: { name },
      });
      const { account } = expectConverted(response, 'convert in A2');
      expect(account.programmeId).toBe(PROGRAMME_A2);
      expect((await accountsNamed(name))[0]?.programme_id).toBe(PROGRAMME_A2);
    });

    it.each([
      ['new', 'qualified'],
      ['contacted', 'qualified'],
      ['unqualified', 'qualified'],
      [null, 'qualified'],
      ['qualified', 'qualified'],
      ['customer', 'customer'],
    ] as const)('a %s contact ends %s, and is linked', async (from, to) => {
      await setContact(BASHIR.id, { status: from });
      const response = await convert(SUPERVISOR, BASHIR.id, {
        version: await versionOf(BASHIR.id),
        accountId: OJA,
      });
      const { contact } = expectConverted(response, `convert from ${String(from)}`);
      expect(contact.status).toBe(to);
      expect(contact.accountId).toBe(OJA);
      const row = await contactRow(BASHIR.id);
      expect(row?.status).toBe(to);
      expect(row?.account_id).toBe(OJA);
    });

    it('a converted lead stays on the Leads list; a converted customer stays off it', async () => {
      expectConverted(
        await convert(SUPERVISOR, AMAKA.id, {
          version: await versionOf(AMAKA.id),
          accountId: IKOYI.id,
        }),
        'convert lead',
      );
      expectConverted(
        await convert(SUPERVISOR, CHIOMA.id, {
          version: await versionOf(CHIOMA.id),
          accountId: IKOYI.id,
        }),
        'convert customer',
      );
      expect(await leadIds(AGENT_1)).toEqual(AGENT_1_LEADS);
    });
  });

  // =========================================================================
  // 8. convertContact: idempotent.
  // =========================================================================

  describe('convertContact: an exact repeat is the same 200 and writes nothing', () => {
    beforeEach(async () => {
      await plantLeads();
      await plantAccount(OJA, PROGRAMME_A1, 'Ọjà Foods Ltd');
    });

    it('linking: a repeat on the stale, the current or a future version answers the same body and writes nothing', async () => {
      const version = await versionOf(AMAKA.id);
      const first = await convert(SUPERVISOR, AMAKA.id, { version, accountId: IKOYI.id });
      expectConverted(first, 'first');
      const row = await contactRow(AMAKA.id);
      const audit = await auditIds();
      const count = await accountCount();
      for (const repeatVersion of [version, version + 1, version + 9]) {
        const repeat = await convert(SUPERVISOR, AMAKA.id, {
          version: repeatVersion,
          accountId: IKOYI.id,
        });
        expectConverted(repeat, `repeat on version ${repeatVersion}`);
        expect(repeat.body, `repeat on version ${repeatVersion}`).toEqual(first.body);
      }
      expect(await contactRow(AMAKA.id), 'a repeat wrote to the contact').toEqual(row);
      expect(await auditSince(audit), 'a repeat was audited').toEqual([]);
      expect(await accountCount()).toBe(count);
    });

    it('creating: a retry after a lost answer (the stale version) creates no second account', async () => {
      const name = unique('Kano Grains Co.');
      const version = await versionOf(AMAKA.id);
      const first = await convert(SUPERVISOR, AMAKA.id, { version, newAccount: { name } });
      expectConverted(first, 'first');
      const audit = await auditIds();
      const retry = await convert(SUPERVISOR, AMAKA.id, { version, newAccount: { name } });
      expectConverted(retry, 'retry');
      expect(retry.body).toEqual(first.body);
      expect(await accountsNamed(name), 'the retry created a second account').toHaveLength(1);
      expect(await auditSince(audit)).toEqual([]);
    });

    it('a customer already linked is in place: a repeat is 200 and writes nothing', async () => {
      const version = await versionOf(CHIOMA.id);
      const first = await convert(SUPERVISOR, CHIOMA.id, { version, accountId: IKOYI.id });
      expect(expectConverted(first, 'first').contact.status).toBe('customer');
      const audit = await auditIds();
      const repeat = await convert(SUPERVISOR, CHIOMA.id, { version, accountId: IKOYI.id });
      expect(repeat.body).toEqual(first.body);
      expect(await auditSince(audit)).toEqual([]);
    });

    it('a different request on a stale version is 409 stale_write, and nothing is written', async () => {
      const version = await versionOf(AMAKA.id);
      expectStatus(
        await updateContact(SUPERVISOR, AMAKA.id, { version, status: 'contacted' }),
        200,
        'someone else saves',
      );
      const before = await contactRow(AMAKA.id);
      const count = await accountCount();
      const audit = await auditIds();
      expectError(
        await convert(SUPERVISOR, AMAKA.id, { version, accountId: IKOYI.id }),
        409,
        'stale_write',
      );
      expectError(
        await convert(SUPERVISOR, AMAKA.id, { version, newAccount: { name: unique('Stale Co') } }),
        409,
        'stale_write',
      );
      expect(await contactRow(AMAKA.id)).toEqual(before);
      expect(await accountCount(), 'a refused convert left an account behind').toBe(count);
      expect(await auditSince(audit)).toEqual([]);
    });

    it('a name differing only in case is not a repeat: 400 already_linked, no second account', async () => {
      const name = unique('Kano Grains Co.');
      const first = await convert(SUPERVISOR, AMAKA.id, {
        version: await versionOf(AMAKA.id),
        newAccount: { name },
      });
      expectConverted(first, 'first');
      const body = expectError(
        await convert(SUPERVISOR, AMAKA.id, {
          version: await versionOf(AMAKA.id),
          newAccount: { name: name.toUpperCase() },
        }),
        400,
        'validation_failed',
      );
      expect(detailsOf(body)).toContainEqual({ path: 'newAccount', code: 'already_linked' });
      expect(await accountsNamed(name.toUpperCase())).toEqual([]);
    });

    it('a non-writer’s exact repeat of a finished convert is 403, never the 200 that would confirm the link', async () => {
      const version = await versionOf(AMAKA.id);
      expectConverted(
        await convert(SUPERVISOR, AMAKA.id, { version, accountId: IKOYI.id }),
        'admin converts',
      );
      const refused = expectError(
        await convert(AGENT_1, AMAKA.id, { version: version + 1, accountId: IKOYI.id }),
        403,
        'not_permitted',
      );
      expect(JSON.stringify(refused)).not.toContain(IKOYI.name);
    });

    it('a version beyond 32 bits on a repeat or a first call is never a 500', async () => {
      const huge = 2 ** 31;
      const first = await convert(SUPERVISOR, KELECHI, { version: huge, accountId: OJA });
      expect([400, 409], JSON.stringify(first.body)).toContain(first.status);
      expectConverted(
        await convert(SUPERVISOR, KELECHI, { version: await versionOf(KELECHI), accountId: OJA }),
        'control',
      );
      const repeat = await convert(SUPERVISOR, KELECHI, {
        version: Number.MAX_SAFE_INTEGER,
        accountId: OJA,
      });
      expect([200, 400], JSON.stringify(repeat.body)).toContain(repeat.status);
    });
  });

  // =========================================================================
  // 9. convertContact: a contact already linked.
  // =========================================================================

  describe('convertContact: a contact already linked to an account', () => {
    beforeEach(async () => {
      await plantLeads();
      await plantAccount(OJA, PROGRAMME_A1, 'Ọjà Foods Ltd');
      await setContact(AMAKA.id, { account_id: IKOYI.id });
    });

    it('naming another account is 400 already_linked at accountId; nothing written; neither account named', async () => {
      const before = await contactRow(AMAKA.id);
      const audit = await auditIds();
      const response = await convert(SUPERVISOR, AMAKA.id, {
        version: Number(before?.version),
        accountId: OJA,
      });
      const body = expectError(response, 400, 'validation_failed');
      expect(detailsOf(body)).toContainEqual({ path: 'accountId', code: 'already_linked' });
      const text = JSON.stringify(response.body);
      for (const leaked of [IKOYI.id, IKOYI.name, OJA, 'Ọjà']) expect(text).not.toContain(leaked);
      expect(await contactRow(AMAKA.id)).toEqual(before);
      expect(await auditSince(audit)).toEqual([]);
    });

    it('a new account under another name is 400 already_linked at newAccount, and no account is created', async () => {
      const before = await contactRow(AMAKA.id);
      const count = await accountCount();
      const body = expectError(
        await convert(SUPERVISOR, AMAKA.id, {
          version: Number(before?.version),
          newAccount: { name: unique('Second Co') },
        }),
        400,
        'validation_failed',
      );
      expect(detailsOf(body)).toContainEqual({ path: 'newAccount', code: 'already_linked' });
      expect(await accountCount()).toBe(count);
      expect(await contactRow(AMAKA.id)).toEqual(before);
    });

    it('naming the SAME account qualifies it and creates nothing; a new account named exactly as it, too', async () => {
      const count = await accountCount();
      const same = await convert(SUPERVISOR, AMAKA.id, {
        version: await versionOf(AMAKA.id),
        accountId: IKOYI.id,
      });
      expect(expectConverted(same, 'same account').contact).toMatchObject({
        status: 'qualified',
        accountId: IKOYI.id,
      });
      await setContact(BASHIR.id, { account_id: OJA });
      const named = await convert(SUPERVISOR, BASHIR.id, {
        version: await versionOf(BASHIR.id),
        newAccount: { name: 'Ọjà Foods Ltd' },
      });
      expect(expectConverted(named, 'same name').contact).toMatchObject({
        status: 'qualified',
        accountId: OJA,
      });
      expect(await accountCount(), 'an account was created for a contact already linked').toBe(
        count,
      );
    });

    it('409 comes before already_linked: a stale version naming another account is 409', async () => {
      const version = await versionOf(AMAKA.id);
      await setContact(AMAKA.id, { lga: 'Ikeja' });
      expectError(
        await convert(SUPERVISOR, AMAKA.id, { version, accountId: OJA }),
        409,
        'stale_write',
      );
    });
  });

  // =========================================================================
  // 10. convertContact: scope.
  // =========================================================================

  describe('convertContact: scope', () => {
    beforeEach(async () => {
      await plantLeads();
    });

    it('an account outside the contact’s programme is 404, one body for A2 (reachable!), tenant B and nowhere — the same as a missing contact', async () => {
      // The control first: the route converts for this caller.
      expectConverted(
        await convert(SUPERVISOR, BASHIR.id, {
          version: await versionOf(BASHIR.id),
          accountId: IKOYI.id,
        }),
        'control',
      );
      const version = await versionOf(AMAKA.id);
      const before = await contactRow(AMAKA.id);
      const bodies: Json[] = [];
      for (const accountId of [SABON.id, WESTLANDS.id, NOWHERE]) {
        bodies.push(
          expectError(
            await convert(SUPERVISOR, AMAKA.id, { version, accountId }),
            404,
            'not_found',
          ),
        );
      }
      bodies.push(
        expectError(
          await convert(SUPERVISOR, NOWHERE, { version, accountId: IKOYI.id }),
          404,
          'not_found',
        ),
      );
      for (const body of bodies.slice(1)) expect(body).toEqual(bodies[0]);
      expect(await contactRow(AMAKA.id)).toEqual(before);
      // And the same contact converts to an account in its own programme.
      expectConverted(
        await convert(SUPERVISOR, AMAKA.id, { version, accountId: IKOYI.id }),
        'same contact, own programme',
      );
    });

    it('the mirror: an A2 lead cannot take an A1 account', async () => {
      // The control first: Efe (A2) converts to A2's account.
      expectConverted(
        await convert(SUPERVISOR, EFE.id, {
          version: await versionOf(EFE.id),
          accountId: SABON.id,
        }),
        'control',
      );
      const version = await versionOf(DAMILOLA.id);
      const crossed = await convert(SUPERVISOR, DAMILOLA.id, { version, accountId: IKOYI.id });
      const invented = await convert(SUPERVISOR, DAMILOLA.id, { version, accountId: NOWHERE });
      expectError(crossed, 404, 'not_found');
      expect(crossed.body).toEqual(invented.body);
      expect((await contactRow(DAMILOLA.id))?.account_id).toBeNull();
    });

    it('tenant B: a tenant-A account is 404 like an invented one; its own account works', async () => {
      // The control first: Hassan (B1, no status) converts to B1's account.
      const hassan = seededContact('Hassan');
      expectConverted(
        await convert(TENANT_B_USER, hassan.id, {
          version: await versionOf(hassan.id),
          accountId: WESTLANDS.id,
        }),
        'control',
      );
      const version = await versionOf(GRACE.id);
      const crossed = await convert(TENANT_B_USER, GRACE.id, { version, accountId: IKOYI.id });
      const invented = await convert(TENANT_B_USER, GRACE.id, { version, accountId: NOWHERE_B });
      expectError(crossed, 404, 'not_found');
      expect(crossed.body).toEqual(invented.body);
      expect((await contactRow(GRACE.id))?.account_id).toBeNull();
    });

    it('an unreachable contact is 404 — sibling programme, other tenant, nowhere — one body, nothing written', async () => {
      // Agent 2 holds admin in A2: a writer, but A1 is out of reach.
      await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A2, 'admin');
      expectConverted(
        await convert(AGENT_2, DAMILOLA.id, {
          version: await versionOf(DAMILOLA.id),
          accountId: SABON.id,
        }),
        'control: agent 2 converts in A2',
      );
      const before = await contactRow(AMAKA.id);
      const sibling = await convert(AGENT_2, AMAKA.id, {
        version: Number(before?.version),
        accountId: IKOYI.id,
      });
      const otherTenant = await convert(AGENT_2, GRACE.id, {
        version: await versionOf(GRACE.id),
        accountId: WESTLANDS.id,
      });
      const nowhere = await convert(AGENT_2, NOWHERE, { version: 1, accountId: SABON.id });
      for (const response of [sibling, otherTenant, nowhere])
        expectError(response, 404, 'not_found');
      expect(sibling.body).toEqual(nowhere.body);
      expect(otherTenant.body).toEqual(nowhere.body);
      expect(await contactRow(AMAKA.id)).toEqual(before);
    });

    it('the tenant-admin flag does not widen reach: a flagged user in no programme gets 404', async () => {
      await setTenantAdmin(USER_A_NO_PROGRAMME, true);
      expectConverted(
        await convert(SUPERVISOR, BASHIR.id, {
          version: await versionOf(BASHIR.id),
          accountId: IKOYI.id,
        }),
        'control: the route converts',
      );
      const response = await convert(NO_PROGRAMME, AMAKA.id, {
        version: await versionOf(AMAKA.id),
        accountId: IKOYI.id,
      });
      expectError(response, 404, 'not_found');
      expect((await contactRow(AMAKA.id))?.status).toBe('new');
    });

    it('the account 404 comes before 409 and before already_linked: real-elsewhere and invented stay identical', async () => {
      expectConverted(
        await convert(SUPERVISOR, BASHIR.id, {
          version: await versionOf(BASHIR.id),
          accountId: IKOYI.id,
        }),
        'control',
      );
      const stale = (await versionOf(AMAKA.id)) + 5;
      const staleSibling = await convert(SUPERVISOR, AMAKA.id, {
        version: stale,
        accountId: SABON.id,
      });
      const staleInvented = await convert(SUPERVISOR, AMAKA.id, {
        version: stale,
        accountId: NOWHERE,
      });
      expectError(staleSibling, 404, 'not_found');
      expect(staleSibling.body).toEqual(staleInvented.body);
      // Bashir is now linked to Ikoyi: another programme's account is still 404.
      const version = await versionOf(BASHIR.id);
      const linkedSibling = await convert(SUPERVISOR, BASHIR.id, { version, accountId: SABON.id });
      const linkedInvented = await convert(SUPERVISOR, BASHIR.id, { version, accountId: NOWHERE });
      expectError(linkedSibling, 404, 'not_found');
      expect(linkedSibling.body).toEqual(linkedInvented.body);
    });

    it('scope headers are 400, and nothing is written', async () => {
      const before = await contactRow(AMAKA.id);
      for (const [header, value] of SCOPE_HEADERS) {
        expectError(
          await convert(SUPERVISOR, AMAKA.id, {
            version: Number(before?.version),
            accountId: IKOYI.id,
          }).set(header, value),
          400,
          'validation_failed',
        );
      }
      expect(await contactRow(AMAKA.id)).toEqual(before);
      expectConverted(
        await convert(SUPERVISOR, AMAKA.id, {
          version: Number(before?.version),
          accountId: IKOYI.id,
        }),
        'control',
      );
    });

    it('is 401 without a session', async () => {
      expectConverted(
        await convert(SUPERVISOR, AMAKA.id, {
          version: await versionOf(AMAKA.id),
          accountId: IKOYI.id,
        }),
        'control',
      );
      expectError(
        await request(server())
          .post(convertPath(BASHIR.id))
          .send({ version: 1, accountId: IKOYI.id }),
        401,
        'not_authenticated',
      );
    });
  });

  // =========================================================================
  // 11. convertContact: permissions and field security.
  // =========================================================================

  describe('convertContact: permissions and field security', () => {
    beforeEach(async () => {
      await plantLeads();
    });

    it.each([...CLAIM_KEYS, ...READ_ONLY_KEYS])(
      'the %s set may not convert: 403, one body whatever account is named, nothing written or audited',
      async (key) => {
        await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, key);
        const before = await contactRow(AMAKA.id);
        const version = Number(before?.version);
        const count = await accountCount();
        const audit = await auditIds();
        const bodies: Json[] = [];
        for (const body of [
          { version, accountId: IKOYI.id },
          { version, accountId: SABON.id },
          { version, accountId: NOWHERE },
          { version, newAccount: { name: unique('Agent Co') } },
        ]) {
          bodies.push(expectError(await convert(AGENT_1, AMAKA.id, body), 403, 'not_permitted'));
        }
        for (const body of bodies.slice(1)) {
          expect(body, 'the refusal varies with the account: an existence oracle').toEqual(
            bodies[0],
          );
        }
        expect(await contactRow(AMAKA.id)).toEqual(before);
        expect(await accountCount()).toBe(count);
        expect(await auditSince(audit)).toEqual([]);
        expectStatus(await getContact(AGENT_1, AMAKA.id), 200, `${key} reads the contact`);
      },
    );

    it('the admin set in the programme converts both ways, without the tenant-admin flag', async () => {
      await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'admin');
      expectConverted(
        await convert(AGENT_1, AMAKA.id, {
          version: await versionOf(AMAKA.id),
          accountId: IKOYI.id,
        }),
        'link',
      );
      expectConverted(
        await convert(AGENT_1, BASHIR.id, {
          version: await versionOf(BASHIR.id),
          newAccount: { name: unique('Programme Admin Co') },
        }),
        'create',
      );
    });

    it('the tenant-admin flag converts both ways whatever set is held (D-L53, D-P18)', async () => {
      await setTenantAdmin(USER_A_AGENT_1, true);
      expectConverted(
        await convert(AGENT_1, AMAKA.id, {
          version: await versionOf(AMAKA.id),
          accountId: IKOYI.id,
        }),
        'link',
      );
      expectConverted(
        await convert(AGENT_1, BASHIR.id, {
          version: await versionOf(BASHIR.id),
          newAccount: { name: unique('Tenant Admin Co') },
        }),
        'create',
      );
    });

    it('the permission is per programme, and re-read on every request', async () => {
      await setTenantAdmin(USER_A_SUPERVISOR, false);
      await assign(TENANT_A, USER_A_SUPERVISOR, PROGRAMME_A1, 'team_lead');
      await assign(TENANT_A, USER_A_SUPERVISOR, PROGRAMME_A2, 'admin');
      expectError(
        await convert(SUPERVISOR, AMAKA.id, {
          version: await versionOf(AMAKA.id),
          accountId: IKOYI.id,
        }),
        403,
        'not_permitted',
      );
      expectConverted(
        await convert(SUPERVISOR, DAMILOLA.id, {
          version: await versionOf(DAMILOLA.id),
          accountId: SABON.id,
        }),
        'A2',
      );
      await assign(TENANT_A, USER_A_SUPERVISOR, PROGRAMME_A2, 'programme_manager');
      expectError(
        await convert(SUPERVISOR, EFE.id, {
          version: await versionOf(EFE.id),
          accountId: SABON.id,
        }),
        403,
        'not_permitted',
      );
    });

    describe('field security on status and accountId (tenant admin holding the agent set in A1)', () => {
      beforeEach(async () => {
        await setTenantAdmin(USER_A_AGENT_1, true);
      });

      it.each([
        ['status', 'none', 'status'],
        ['status', 'read', 'status'],
        ['account_id', 'none', 'accountId'],
        ['account_id', 'read', 'accountId'],
      ] as const)(
        '%s at %s: 403 field_not_editable at %s, for a link and a new account; nothing written',
        async (field, level, path) => {
          // The control: before the lock, this caller converts.
          expectConverted(
            await convert(AGENT_1, KELECHI, {
              version: await versionOf(KELECHI),
              accountId: IKOYI.id,
            }),
            'control',
          );
          await lockField('contact', field, 'agent', level);
          const before = await contactRow(AMAKA.id);
          const count = await accountCount();
          for (const body of [
            { version: Number(before?.version), accountId: IKOYI.id },
            { version: Number(before?.version), newAccount: { name: unique('FLS Co') } },
          ]) {
            const refused = expectError(
              await convert(AGENT_1, AMAKA.id, body),
              403,
              'not_permitted',
            );
            expect(detailsOf(refused)).toContainEqual({ path, code: 'field_not_editable' });
          }
          expect(await contactRow(AMAKA.id)).toEqual(before);
          expect(await accountCount()).toBe(count);
        },
      );

      it('field_not_editable comes before 400 and before the account 404', async () => {
        await lockField('contact', 'status', 'agent', 'read');
        const version = await versionOf(AMAKA.id);
        for (const body of [
          { version, accountId: IKOYI.id, newAccount: { name: 'Both' }, bogus: 1 },
          { version, accountId: SABON.id },
          { version, accountId: NOWHERE },
        ]) {
          const refused = expectError(await convert(AGENT_1, AMAKA.id, body), 403, 'not_permitted');
          expect(detailsOf(refused)).toContainEqual({ path: 'status', code: 'field_not_editable' });
        }
      });

      it('the answer is under field security: a withheld contact field and a withheld account field are omitted', async () => {
        const probe = 'amaka.t0076-probe@example.test';
        await setContact(AMAKA.id, { emails: JSON.stringify([probe]) });
        await observer.query('UPDATE account SET tier = $2 WHERE id = $1', [
          IKOYI.id,
          'enterprise',
        ]);
        await lockField('contact', 'emails', 'agent', 'none');
        await lockField('account', 'tier', 'agent', 'none');
        const response = await convert(AGENT_1, AMAKA.id, {
          version: await versionOf(AMAKA.id),
          accountId: IKOYI.id,
        });
        const { contact, account } = expectConverted(response, 'field-secured answer');
        expect('emails' in contact).toBe(false);
        expect(contact.withheldFields).toContain('emails');
        expect('tier' in account).toBe(false);
        expect(account.withheldFields).toContain('tier');
        expect(JSON.stringify(response.body)).not.toContain(probe);
      });
    });

    it('404 before 403: a non-writer converting an unreachable contact gets the missing-contact body', async () => {
      // The control first: the same caller is refused 403 on a contact it reads.
      expectStatus(await getContact(AGENT_1, AMAKA.id), 200, 'agent 1 reads A1');
      expectError(
        await convert(AGENT_1, AMAKA.id, { version: 1, accountId: IKOYI.id }),
        403,
        'not_permitted',
      );
      const sibling = await convert(AGENT_1, DAMILOLA.id, { version: 1, accountId: SABON.id });
      const nowhere = await convert(AGENT_1, NOWHERE, { version: 1, accountId: IKOYI.id });
      expectError(sibling, 404, 'not_found');
      expect(sibling.body).toEqual(nowhere.body);
    });

    it('403 before 400: a non-writer’s malformed body is 403', async () => {
      for (const body of [
        {},
        { version: 0 },
        { version: 1, accountId: 'nope', newAccount: { name: '' }, status: 'customer' },
      ]) {
        expectError(await convert(AGENT_1, AMAKA.id, body), 403, 'not_permitted');
      }
    });
  });

  // =========================================================================
  // 12. convertContact: the body is closed.
  // =========================================================================

  describe('convertContact: the body', () => {
    beforeEach(async () => {
      await plantLeads();
    });

    it.each([
      ['an empty body', () => ({})],
      ['version only (neither target)', (v: number) => ({ version: v })],
      ['no version', () => ({ accountId: IKOYI.id })],
      [
        'both accountId and newAccount',
        (v: number) => ({ version: v, accountId: IKOYI.id, newAccount: { name: 'Both Co' } }),
      ],
      ['a null accountId', (v: number) => ({ version: v, accountId: null })],
      ['a non-uuid accountId', (v: number) => ({ version: v, accountId: 'ikoyi' })],
      ['a null newAccount', (v: number) => ({ version: v, newAccount: null })],
      ['a string newAccount', (v: number) => ({ version: v, newAccount: 'Kano Co' })],
      ['an empty newAccount', (v: number) => ({ version: v, newAccount: {} })],
      ['an empty name', (v: number) => ({ version: v, newAccount: { name: '' } })],
      [
        'a 201-character name',
        (v: number) => ({ version: v, newAccount: { name: 'N'.repeat(201) } }),
      ],
      ['a numeric name', (v: number) => ({ version: v, newAccount: { name: 42 } })],
      [
        'a NUL in the name (text cannot store it)',
        (v: number) => ({ version: v, newAccount: { name: 'Acme\u0000 Ltd' } }),
      ],
      [
        'a programmeId on the new account',
        (v: number) => ({ version: v, newAccount: { name: 'P Co', programmeId: PROGRAMME_A2 } }),
      ],
      [
        'an owner on the new account',
        (v: number) => ({ version: v, newAccount: { name: 'O Co', ownerUserId: USER_A_AGENT_1 } }),
      ],
      [
        'a tier on the new account',
        (v: number) => ({ version: v, newAccount: { name: 'T Co', tier: 'sme' } }),
      ],
      ['a status', (v: number) => ({ version: v, accountId: IKOYI.id, status: 'qualified' })],
      ['status customer', (v: number) => ({ version: v, accountId: IKOYI.id, status: 'customer' })],
      [
        'a programmeId',
        (v: number) => ({ version: v, accountId: IKOYI.id, programmeId: PROGRAMME_A2 }),
      ],
      ['a tenantId', (v: number) => ({ version: v, accountId: IKOYI.id, tenantId: TENANT_B })],
      ['a contactId', (v: number) => ({ version: v, accountId: IKOYI.id, contactId: BASHIR.id })],
      [
        'a companyName',
        (v: number) => ({ version: v, accountId: IKOYI.id, companyName: 'Copy Co' }),
      ],
      ['version 0', () => ({ version: 0, accountId: IKOYI.id })],
      ['version as a string', (v: number) => ({ version: String(v), accountId: IKOYI.id })],
      ['a fractional version', () => ({ version: 1.5, accountId: IKOYI.id })],
    ] as [string, (version: number) => Json][])(
      '%s is 400 validation_failed; nothing written, created or audited',
      async (_label, build) => {
        const before = await contactRow(AMAKA.id);
        const count = await accountCount();
        const audit = await auditIds();
        expectError(
          await convert(SUPERVISOR, AMAKA.id, build(Number(before?.version))),
          400,
          'validation_failed',
        );
        expect(await contactRow(AMAKA.id)).toEqual(before);
        expect(await accountCount()).toBe(count);
        expect(await auditSince(audit)).toEqual([]);
      },
    );

    it('a JSON array body and a non-uuid contact id are 400', async () => {
      expectError(
        await request(server())
          .post(convertPath(AMAKA.id))
          .set(SUPERVISOR)
          .set('Content-Type', 'application/json')
          .send('[]'),
        400,
        'validation_failed',
      );
      expectError(
        await convert(SUPERVISOR, 'not-a-uuid', { version: 1, accountId: IKOYI.id }),
        400,
        'validation_failed',
      );
    });

    it('a raw __proto__ carrying programmeId is refused, and no account appears anywhere', async () => {
      const version = await versionOf(AMAKA.id);
      const name = unique('Proto Co');
      const raw = `{"version":${version},"newAccount":{"name":"${name}","__proto__":{"programmeId":"${PROGRAMME_A2}"}}}`;
      expectError(
        await request(server())
          .post(convertPath(AMAKA.id))
          .set(SUPERVISOR)
          .set('Content-Type', 'application/json')
          .send(raw),
        400,
        'validation_failed',
      );
      expect(await accountsNamed(name)).toEqual([]);
    });

    it('the boundary is accepted: a 200-character name', async () => {
      const name = `${RUN}-${'N'.repeat(200)}`.slice(0, 200);
      const response = await convert(SUPERVISOR, AMAKA.id, {
        version: await versionOf(AMAKA.id),
        newAccount: { name },
      });
      expect(expectConverted(response, '200 characters').account.name).toBe(name);
    });

    it('400 comes before the account 404: a closed-body breach naming another programme’s account is 400', async () => {
      expectError(
        await convert(SUPERVISOR, AMAKA.id, {
          version: await versionOf(AMAKA.id),
          accountId: SABON.id,
          status: 'qualified',
        }),
        400,
        'validation_failed',
      );
    });
  });

  // =========================================================================
  // 13. One transaction, one audit event.
  // =========================================================================

  describe('convertContact: one transaction, one audit event (L6)', () => {
    beforeEach(async () => {
      await plantLeads();
      await plantAccount(OJA, PROGRAMME_A1, 'Ọjà Foods Ltd');
      await setContact(AMAKA.id, { company_name: 'Zuma Rock Quarries' });
    });

    function expectConvertEvent(
      event: AuditRow | undefined,
      contactId: string,
      programmeId: string,
      actor: string,
      statusBefore: string | null | 'unchanged',
    ) {
      expect(event, 'no audit event').toBeDefined();
      if (event === undefined) return;
      expect(event).toMatchObject({
        tenant_id: TENANT_A,
        actor_kind: 'user',
        actor_user_id: actor,
        action: 'updated',
        object_type: 'contact',
        object_id: contactId,
        object_label: contactId,
        programme_id: programmeId,
      });
      const fields = event.changes.map((change) => change.field).sort();
      expect(fields).toEqual(
        statusBefore === 'unchanged' ? ['accountId'] : ['accountId', 'status'],
      );
      const account = event.changes.find((change) => change.field === 'accountId');
      expect(account?.redacted, 'accountId is recorded by name only (D-L72)').toBe(true);
      expect(account?.before ?? null).toBeNull();
      expect(account?.after ?? null).toBeNull();
      const status = event.changes.find((change) => change.field === 'status');
      if (status !== undefined) {
        if (status.redacted === true) {
          expect(status.before ?? null).toBeNull();
          expect(status.after ?? null).toBeNull();
        } else {
          expect(status.redacted).toBe(false);
          expect(status.before ?? null).toBe(statusBefore);
          expect(status.after).toBe('qualified');
        }
      }
    }

    /** L6 as amended by T-0104: the ONE account `created` event a creating convert writes. */
    function expectAccountCreatedEvent(
      accountEvents: AuditRow[],
      accountId: string,
      programmeId: string,
      actor: string,
    ) {
      expect(
        accountEvents,
        'a convert that creates an account writes exactly one account event (T-0104)',
      ).toHaveLength(1);
      const [event] = accountEvents;
      if (event === undefined) return;
      expect(event).toMatchObject({
        tenant_id: TENANT_A,
        actor_kind: 'user',
        actor_user_id: actor,
        action: 'created',
        object_type: 'account',
        object_id: accountId,
        object_label: accountId,
        programme_id: programmeId,
      });
      expect(
        event.changes.map((change) => change.field),
        'the create names the account’s name',
      ).toContain('name');
      for (const change of event.changes) {
        expect(change.redacted, `${change.field}: names only (D-L78)`).toBe(true);
        expect(change.before ?? null, `${change.field}: no before value (D-L78)`).toBeNull();
        expect(change.after ?? null, `${change.field}: no after value (D-L78)`).toBeNull();
      }
    }

    it('linking: exactly one contact event, the session user, the contact’s programme, status and accountId only', async () => {
      await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'admin');
      const audit = await auditIds();
      expectConverted(
        await convert(AGENT_1, AMAKA.id, {
          version: await versionOf(AMAKA.id),
          accountId: IKOYI.id,
        }),
        'link',
      );
      const events = await auditSince(audit);
      expect(events, 'one event per convert').toHaveLength(1);
      expectConvertEvent(events[0], AMAKA.id, PROGRAMME_A1, USER_A_AGENT_1, 'new');
      const text = JSON.stringify(events[0]);
      for (const leaked of [IKOYI.id, IKOYI.name, 'Zuma', 'Amaka', 'Obi', '2348031234001']) {
        expect(text, `the event carries "${leaked}"`).not.toContain(leaked);
      }
    });

    // T-0104 (D-L82's tracked item): "a convert that creates an account writes
    // two audit events in its one transaction: the contact `updated` (as now)
    // and the account `created`, names only (D-L78)." Before T-0104 this test
    // pinned one event and no account event.
    it('creating: the same contact event plus ONE account `created` event, names only; the name is in neither (T-0104)', async () => {
      const name = 'Hauwa Kankarofi Ventures';
      const audit = await auditIds();
      const response = await convert(SUPERVISOR, DAMILOLA.id, {
        version: await versionOf(DAMILOLA.id),
        newAccount: { name },
      });
      const { account } = expectConverted(response, 'create');
      const events = await auditSince(audit);
      expect(events, 'one contact event and one account event').toHaveLength(2);
      const contactEvents = events.filter((event) => event.object_type === 'contact');
      expect(contactEvents, 'one contact event').toHaveLength(1);
      expectConvertEvent(contactEvents[0], DAMILOLA.id, PROGRAMME_A2, USER_A_SUPERVISOR, 'new');
      // The contact event is unchanged by T-0104: no account id, no account name.
      const contactText = JSON.stringify(contactEvents);
      expect(contactText).not.toContain(String(account.id));
      expect(contactText).not.toContain('Kankarofi');
      expectAccountCreatedEvent(
        events.filter((event) => event.object_type === 'account'),
        String(account.id),
        PROGRAMME_A2,
        USER_A_SUPERVISOR,
      );
      // The name appears in no row, in any spelling the writer might use.
      const text = JSON.stringify(events).toLowerCase();
      for (const part of ['kankarofi', 'hauwa', name.toLowerCase()]) {
        expect(text, `an audit row carries "${part}"`).not.toContain(part);
      }
    });

    it('a customer: only accountId changed, so only accountId is named', async () => {
      const audit = await auditIds();
      expectConverted(
        await convert(SUPERVISOR, CHIOMA.id, {
          version: await versionOf(CHIOMA.id),
          accountId: IKOYI.id,
        }),
        'customer',
      );
      const events = await auditSince(audit);
      expect(events).toHaveLength(1);
      expectConvertEvent(events[0], CHIOMA.id, PROGRAMME_A1, USER_A_SUPERVISOR, 'unchanged');
    });

    it('a null status: status is named, from null', async () => {
      const audit = await auditIds();
      expectConverted(
        await convert(SUPERVISOR, OBINNA, { version: await versionOf(OBINNA), accountId: OJA }),
        'null status',
      );
      const events = await auditSince(audit);
      expect(events).toHaveLength(1);
      expectConvertEvent(events[0], OBINNA, PROGRAMME_A1, USER_A_SUPERVISOR, null);
    });

    it('refused converts record nothing: 400, 403, 404 (contact and account), 409 and already_linked', async () => {
      await setContact(BASHIR.id, { account_id: IKOYI.id });
      const amaka = await versionOf(AMAKA.id);
      const bashir = await versionOf(BASHIR.id);
      const audit = await auditIds();
      const count = await accountCount();
      const refusals = [
        await convert(SUPERVISOR, AMAKA.id, { version: amaka, accountId: IKOYI.id, bogus: 1 }),
        await convert(AGENT_1, AMAKA.id, { version: amaka, newAccount: { name: unique('R') } }),
        await convert(SUPERVISOR, NOWHERE, { version: 1, accountId: IKOYI.id }),
        await convert(SUPERVISOR, AMAKA.id, { version: amaka, accountId: SABON.id }),
        await convert(SUPERVISOR, AMAKA.id, {
          version: amaka + 3,
          newAccount: { name: unique('R') },
        }),
        await convert(SUPERVISOR, BASHIR.id, {
          version: bashir,
          newAccount: { name: unique('R') },
        }),
      ];
      expect(refusals.map((response) => response.status)).toEqual([400, 403, 404, 404, 409, 400]);
      expect(await auditSince(audit)).toEqual([]);
      expect(await accountCount(), 'a refused convert left an account behind').toBe(count);
      // The control: the same contact converts.
      expectConverted(
        await convert(SUPERVISOR, AMAKA.id, { version: amaka, accountId: IKOYI.id }),
        'control',
      );
    });

    it('racing identical new-account converts create ONE account, ONE contact event and ONE account event; every 200 names it', async () => {
      const name = unique('Race Co');
      const version = await versionOf(AMAKA.id);
      const audit = await auditIds();
      const responses = await Promise.all(
        [1, 2, 3, 4].map(() => convert(SUPERVISOR, AMAKA.id, { version, newAccount: { name } })),
      );
      const statuses = responses.map((response) => response.status);
      for (const response of responses) {
        expect([200, 409], JSON.stringify(response.body)).toContain(response.status);
      }
      expect(statuses, 'no racer succeeded').toContain(200);
      const created = await accountsNamed(name);
      expect(created, 'the race created more than one account').toHaveLength(1);
      const accountId = created[0]?.id;
      for (const response of responses.filter((candidate) => candidate.status === 200)) {
        expect(((response.body as Json).account as Json).id).toBe(accountId);
      }
      expect((await contactRow(AMAKA.id))?.account_id).toBe(accountId);
      const events = await auditSince(audit);
      expect(events.filter((event) => event.object_id === AMAKA.id)).toHaveLength(1);
      // T-0104: and ONE account event, for the one account that exists. A
      // racer that created an account and rolled back left no event behind.
      expectAccountCreatedEvent(
        events.filter((event) => event.object_type === 'account'),
        String(accountId),
        PROGRAMME_A1,
        USER_A_SUPERVISOR,
      );
      expect(events, 'one contact event and one account event, nothing else').toHaveLength(2);
    });

    it('racing converts to two existing accounts link one; the loser is 409 or already_linked; one event', async () => {
      const version = await versionOf(AMAKA.id);
      const audit = await auditIds();
      const [toIkoyi, toOja] = await Promise.all([
        convert(SUPERVISOR, AMAKA.id, { version, accountId: IKOYI.id }),
        convert(SUPERVISOR, AMAKA.id, { version, accountId: OJA }),
      ]);
      const pair = [toIkoyi, toOja];
      const winners = pair.filter((response) => response.status === 200);
      expect(winners, pair.map((r) => JSON.stringify(r.body)).join('\n')).toHaveLength(1);
      const loser = pair.find((response) => response.status !== 200);
      expect([400, 409]).toContain(loser?.status);
      const linked = (await contactRow(AMAKA.id))?.account_id;
      expect(linked).toBe(winners[0] === toIkoyi ? IKOYI.id : OJA);
      expect(await auditSince(audit)).toHaveLength(1);
    });

    it('racing converts with two different new names leave exactly one new account, no orphan', async () => {
      const version = await versionOf(AMAKA.id);
      const count = await accountCount();
      const audit = await auditIds();
      const names = [unique('Left Co'), unique('Right Co')];
      const responses = await Promise.all(
        names.map((name) => convert(SUPERVISOR, AMAKA.id, { version, newAccount: { name } })),
      );
      const winners = responses.filter((response) => response.status === 200);
      expect(winners).toHaveLength(1);
      expect(await accountCount(), 'a losing convert left its account behind').toBe(count + 1);
      // T-0104: the account event shares the convert's transaction, so the
      // loser leaves no orphan EVENT either: exactly one, for the winner's account.
      const winner = (winners[0]?.body as Json | undefined)?.account as Json | undefined;
      const events = await auditSince(audit);
      expectAccountCreatedEvent(
        events.filter((event) => event.object_type === 'account'),
        String(winner?.id),
        PROGRAMME_A1,
        USER_A_SUPERVISOR,
      );
      expect(events, 'one contact event and one account event, nothing else').toHaveLength(2);
    });
  });

  // =========================================================================
  // 14. No PII or database text in logs, spans or error bodies.
  // =========================================================================

  describe('no phone, name, company, q or database text in logs, spans or error bodies (L7)', () => {
    const PHONE = '+2348030076601';
    const COMPANY = 'Yetunde Abiodun Stores';
    const ACCOUNT = 'Hauwa Kankarofi Ventures';

    function expectClean(haystack: string, what: string, databaseText: readonly string[]) {
      for (const form of phoneForms(PHONE)) {
        expect(haystack, `${what} carries a phone (as "${form}")`).not.toContain(form);
      }
      for (const text of ['Ikwuemesi', 'Zebulon', 'Abiodun', 'Kankarofi']) {
        expect(haystack, `${what} carries a name, company or q ("${text}")`).not.toContain(text);
      }
      for (const text of databaseText) {
        expect(haystack, `${what} carries database text ("${text}")`).not.toContain(text);
      }
    }

    it('listLeads searches, converts, company writes and every refusal emit none of it', async () => {
      await plantLeads();
      await plantContact({
        id: PII_LEAD,
        programmeId: PROGRAMME_A1,
        displayName: 'Zebulon Ikwuemesi',
        givenNames: 'Zebulon',
        familyName: 'Ikwuemesi',
        phone: PHONE,
        status: 'new',
        companyName: COMPANY,
      });
      const version = await versionOf(PII_LEAD);
      const bashir = await versionOf(BASHIR.id);

      const outcomes: [string, number, request.Response][] = [];
      const { telemetry, lines } = await captureEverything(async () => {
        outcomes.push(['search company', 200, await leads(SUPERVISOR, [['q', 'Abiodun']])]);
        outcomes.push(['search number', 200, await leads(SUPERVISOR, [['q', '08030076601']])]);
        outcomes.push([
          'convert',
          200,
          await convert(SUPERVISOR, PII_LEAD, { version, newAccount: { name: ACCOUNT } }),
        ]);
        outcomes.push([
          'already linked',
          400,
          await convert(SUPERVISOR, PII_LEAD, {
            version: version + 1,
            newAccount: { name: 'Kankarofi Holdings' },
          }),
        ]);
        outcomes.push([
          'stale',
          409,
          await convert(SUPERVISOR, PII_LEAD, { version, newAccount: { name: 'Kankarofi Two' } }),
        ]);
        outcomes.push([
          'NUL name',
          400,
          await convert(SUPERVISOR, BASHIR.id, {
            version: bashir,
            newAccount: { name: 'Kankarofi\u0000 Bad' },
          }),
        ]);
        outcomes.push([
          'account elsewhere',
          404,
          await convert(SUPERVISOR, BASHIR.id, { version: bashir, accountId: SABON.id }),
        ]);
        outcomes.push([
          'unpermitted',
          403,
          await convert(AGENT_1, BASHIR.id, {
            version: bashir,
            newAccount: { name: 'Kankarofi Agent' },
          }),
        ]);
        outcomes.push([
          'company update',
          200,
          await updateContact(SUPERVISOR, PII_LEAD, {
            version: version + 1,
            companyName: 'Abiodun Abiodun Ltd',
          }),
        ]);
        outcomes.push([
          'company NUL',
          400,
          await updateContact(SUPERVISOR, PII_LEAD, {
            version: version + 2,
            companyName: 'Abiodun\u0000 Ltd',
          }),
        ]);
      });

      // The controls: every request did what it should, so a clean capture is
      // not the cleanliness of a server that refused everything.
      expect(outcomes.map(([label, , response]) => [label, response.status])).toEqual(
        outcomes.map(([label, status]) => [label, status]),
      );
      for (const label of ['search company', 'search number']) {
        const found = outcomes.find(([candidate]) => candidate === label)?.[2];
        expect(idsOf(expectContactPage(found?.body, label)), label).toEqual([PII_LEAD]);
      }
      expect(
        telemetry.spans.length,
        'no spans were recorded — is telemetry wired?',
      ).toBeGreaterThan(0);

      expectClean(JSON.stringify(telemetry.spans), 'spans (attributes and events)', [ROW_DETAIL]);
      expectClean(lines.join('\n'), 'logs (Nest, stdout, stderr, console, OTel)', [ROW_DETAIL]);
      for (const [label, status, response] of outcomes) {
        if (status < 400) continue;
        expectClean(
          JSON.stringify(response.body),
          `the ${label} error body`,
          DATABASE_TEXT_IN_BODIES,
        );
      }
    });
  });
});

// ===========================================================================
// 15: the migration over tenants that pre-date it — the clash, then the backfill
// ===========================================================================

describe('acceptance: company_name over tenants that pre-date it (T-0076)', () => {
  const database = `kasuwa_t0076_${RUN}`;
  const LEGACY_1 = '76000000-0000-4000-8000-000000000001';
  const LEGACY_2 = '76000000-0000-4000-8000-000000000002';
  const LEGACY_3 = '76000000-0000-4000-8000-000000000003';
  const LEGACY_BU = '76000000-0000-4000-8000-0000000000b1';
  const LEGACY_PROGRAMME = '76000000-0000-4000-8000-0000000000c1';
  const LEGACY_CONTACT = '76000000-0000-4000-8000-0000000000e1';
  const CLASH_FIELDS = [
    '76000000-0000-4000-8000-0000000000f1',
    '76000000-0000-4000-8000-0000000000f2',
  ];
  const NOT_A_CLASH = '76000000-0000-4000-8000-0000000000f3';

  let superuserUrl: URL | undefined;
  let legacy: Pool | undefined;
  let mainObserver: Pool;
  const tempDirs: string[] = [];

  let setupError: unknown;
  let migrationId = '';
  let clashError: unknown;
  let afterClash: { migrations: string[]; column: boolean; standardCompany: number } = {
    migrations: [],
    column: false,
    standardCompany: -1,
  };
  let finalError: unknown;
  let tablesBefore: string[] = [];
  let definersBefore: string[] = [];

  function migrationsBefore(bound: string): string {
    const dir = mkdtempSync(join(tmpdir(), 't0076-pre-'));
    tempDirs.push(dir);
    for (const name of readdirSync(MIGRATIONS_DIR)) {
      if (name.endsWith('.sql') && name < bound) {
        copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
      }
    }
    return dir;
  }

  const pool = (): Pool => {
    if (legacy === undefined) throw new Error('the pre-dating database was not built');
    return legacy;
  };

  const requireStaged = () => {
    expect(
      setupError === undefined ? null : String(setupError),
      'the pre-dating database could not be staged',
    ).toBe(null);
  };

  async function snapshot(p: Pool) {
    const migrations = (
      await p.query<{ id: string }>('SELECT id FROM _kasuwa_migration ORDER BY id')
    ).rows.map((row) => row.id);
    const column = (await p.query<{ column: string }>(CONTACT_COLUMNS_SQL)).rows.some(
      (row) => row.column === 'company_name',
    );
    const standard = await p.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM field_def f
         JOIN object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
        WHERE o.api_name = 'contact' AND f.api_name = 'company_name' AND NOT f.is_custom`,
    );
    return { migrations, column, standardCompany: standard.rows[0]?.n ?? -1 };
  }

  beforeAll(async () => {
    mainObserver = createPool({ connectionString: inject('migrationUrl'), max: 1 });
    const files = companyNameMigrationFiles();
    const file = files[0];
    if (files.length !== 1 || file === undefined) {
      setupError = new Error(
        `expected exactly one migration that adds contact.company_name, found ${files.length}`,
      );
      return;
    }
    migrationId = file.replace(/\.sql$/, '');

    try {
      const migrationUrl = new URL(inject('migrationUrl'));
      // Only a superuser may CREATE DATABASE (packages/testing/src/containers.ts).
      const superuser = new URL(migrationUrl.href);
      superuser.username = 'postgres';
      superuser.password = 'postgres';
      superuser.pathname = '/postgres';
      superuserUrl = superuser;
      const admin = new Client({ connectionString: superuser.href });
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
        await admin.query(`CREATE DATABASE ${database}`);
      } finally {
        await admin.end();
      }

      const inNewDatabase = new URL(superuser.href);
      inNewDatabase.pathname = `/${database}`;
      const bootstrap = new Client({ connectionString: inNewDatabase.href });
      await bootstrap.connect();
      try {
        await bootstrap.query(
          readFileSync(BOOTSTRAP_SQL, 'utf8').replace(
            /\bDATABASE kasuwa\b/g,
            `DATABASE ${database}`,
          ),
        );
      } finally {
        await bootstrap.end();
      }

      const url = new URL(migrationUrl.href);
      url.pathname = `/${database}`;
      const legacyUrl = url.href;

      // The chain before 0025, the tenants, then the chain before this
      // migration (0025-0027 backfill their parts): a cell that has run every
      // release before this one.
      await runMigrations({ connectionString: legacyUrl, migrationsDir: migrationsBefore('0025') });
      legacy = createPool({ connectionString: legacyUrl, max: 2 });
      for (const [id, slug] of [
        [LEGACY_1, 'legacy-one'],
        [LEGACY_2, 'legacy-two'],
        [LEGACY_3, 'legacy-three'],
      ] as const) {
        await legacy.query(`INSERT INTO tenant (id, name, slug) VALUES ($1, $2, $3)`, [
          id,
          `Legacy ${slug}`,
          slug,
        ]);
      }
      await runMigrations({ connectionString: legacyUrl, migrationsDir: migrationsBefore(file) });
      await legacy.query(
        `INSERT INTO business_unit (id, tenant_id, name) VALUES ($1, $2, 'Head office')`,
        [LEGACY_BU, LEGACY_1],
      );
      await legacy.query(
        `INSERT INTO programme (id, tenant_id, business_unit_id, name, is_default)
         VALUES ($1, $2, $3, 'Default', true)`,
        [LEGACY_PROGRAMME, LEGACY_1, LEGACY_BU],
      );
      await legacy.query(
        `INSERT INTO contact (id, tenant_id, programme_id, display_name, status)
         VALUES ($1, $2, $3, 'Legacy Lead', 'new')`,
        [LEGACY_CONTACT, LEGACY_1, LEGACY_PROGRAMME],
      );

      // The clash (D-P24): two tenants made a custom `company_name` on
      // contact. The third made one on ACCOUNT, which is not a clash.
      const objectId = async (tenantId: string, api: string) => {
        const row = (
          await pool().query<{ id: string }>(
            `SELECT id FROM object_def WHERE tenant_id = $1 AND api_name = $2 AND NOT is_custom`,
            [tenantId, api],
          )
        ).rows[0];
        if (row === undefined) throw new Error(`0025 did not backfill ${api} for ${tenantId}`);
        return row.id;
      };
      for (const [index, tenantId] of [LEGACY_1, LEGACY_2].entries()) {
        await pool().query(
          `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, is_custom)
           VALUES ($1, $2, $3, 'company_name', 'Employer', 'text', true)`,
          [CLASH_FIELDS[index], tenantId, await objectId(tenantId, 'contact')],
        );
      }
      await pool().query(
        `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, is_custom)
         VALUES ($1, $2, $3, 'company_name', 'Trading name', 'text', true)`,
        [NOT_A_CLASH, LEGACY_3, await objectId(LEGACY_3, 'account')],
      );

      tablesBefore = (await pool().query<{ name: string }>(PUBLIC_TABLES_SQL)).rows.map(
        (row) => row.name,
      );
      definersBefore = (await pool().query<{ name: string }>(DEFINERS_SQL)).rows.map(
        (row) => row.name,
      );

      // Phase 1: the rest of the chain must stop at this migration.
      try {
        await runMigrations({ connectionString: legacyUrl });
      } catch (error) {
        clashError = error;
      }
      afterClash = await snapshot(pool());

      // Phase 2: a human resolves the clash; the chain then applies.
      await pool().query('DELETE FROM field_def WHERE id = ANY ($1::uuid[])', [CLASH_FIELDS]);
      try {
        await runMigrations({ connectionString: legacyUrl });
      } catch (error) {
        finalError = error;
      }
    } catch (error) {
      setupError = error;
    }
  }, 150_000);

  afterAll(async () => {
    await legacy?.end();
    await mainObserver?.end();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    if (superuserUrl === undefined) return;
    const admin = new Client({ connectionString: superuserUrl.href });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it('a custom contact.company_name stops the migration, naming the object, the field and the tenant count', () => {
    requireStaged();
    expect(
      clashError,
      'the migration applied over two tenants’ custom contact.company_name',
    ).toBeInstanceOf(Error);
    const message = clashError instanceof Error ? clashError.message : String(clashError);
    expect(message, 'the failure is not this migration’s').toContain(migrationId);
    expect(message).toMatch(/\bcontact\b/);
    expect(message).toMatch(/\bcompany_name\b/);
    expect(message, 'the count of tenants affected (2)').toMatch(/\b2\b/);
    expect(message, 'a custom field on account was counted').not.toMatch(/\b3\b/);
  });

  it('and nothing of it was applied: no ledger row, no column, no standard field', () => {
    requireStaged();
    // Without a failure to inspect, the checks below hold trivially.
    expect(clashError, 'there was no failed migration to inspect').toBeInstanceOf(Error);
    expect(afterClash.migrations).not.toContain(migrationId);
    expect(afterClash.column).toBe(false);
    expect(afterClash.standardCompany).toBe(0);
  });

  it('once the clash is resolved, the migration applies', async () => {
    requireStaged();
    expect(finalError === undefined ? null : String(finalError)).toBe(null);
    const applied = await pool().query<{ id: string }>(
      'SELECT id FROM _kasuwa_migration WHERE id = $1',
      [migrationId],
    );
    expect(applied.rows).toHaveLength(1);
  });

  it.each([
    ['the tenant with a pre-dating contact', LEGACY_1],
    ['a tenant that had the clash', LEGACY_2],
    ['a tenant with a custom account.company_name', LEGACY_3],
  ])('backfills %s with exactly the contact fields the seed writes', async (_what, tenantId) => {
    requireStaged();
    const seeded = (await mainObserver.query<FieldRow>(CONTACT_FIELDS_SQL, [TENANT_A])).rows;
    expect(seeded.map((row) => row.api_name)).toContain('company_name');
    const backfilled = (await pool().query<FieldRow>(CONTACT_FIELDS_SQL, [tenantId])).rows;
    expect(backfilled).toEqual(seeded);
  });

  it('keeps the custom account.company_name, still custom', async () => {
    requireStaged();
    const row = await pool().query<{ is_custom: boolean; label: string }>(
      'SELECT is_custom, label FROM field_def WHERE id = $1',
      [NOT_A_CLASH],
    );
    expect(row.rows).toEqual([{ is_custom: true, label: 'Trading name' }]);
  });

  it('the pre-dating contact reads company_name NULL, everything else as it was', async () => {
    requireStaged();
    const rows = await pool().query<Record<string, unknown>>(
      'SELECT display_name, status, company_name FROM contact WHERE id = $1',
      [LEGACY_CONTACT],
    );
    expect(rows.rows).toEqual([{ display_name: 'Legacy Lead', status: 'new', company_name: null }]);
  });

  it('adds only tables that meet the tenancy invariants, and no SECURITY DEFINER function', async () => {
    requireStaged();
    // The table loop is vacuous when the migration adds no table (the expected
    // case); it is here so that a side table cannot skip the rules.
    expect(definersBefore.length, 'the census before the migration read nothing').toBe(2);
    expect(
      (await pool().query<{ name: string }>(DEFINERS_SQL)).rows.map((row) => row.name),
    ).toEqual(definersBefore);
    const after = (await pool().query<{ name: string }>(PUBLIC_TABLES_SQL)).rows.map(
      (row) => row.name,
    );
    const problems: string[] = [];
    for (const table of after.filter(
      (name) => !tablesBefore.includes(name) && !name.startsWith('_'),
    )) {
      if (!(TENANT_SCOPED_TABLES as readonly string[]).includes(table)) {
        problems.push(`${table}: not in TENANT_SCOPED_TABLES`);
      }
      const state = (
        await pool().query<{ enabled: boolean; forced: boolean }>(
          `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = $1`,
          [table],
        )
      ).rows[0];
      if (state?.enabled !== true || state.forced !== true) {
        problems.push(`${table}: RLS not enabled and forced`);
      }
      const policies = await pool().query<{ qual: string | null; with_check: string | null }>(
        `SELECT qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      );
      if (
        !policies.rows.some((policy) => policy.qual !== null && policy.qual === policy.with_check)
      ) {
        problems.push(`${table}: no policy whose WITH CHECK equals its USING`);
      }
    }
    expect(problems).toEqual([]);
  });
});
