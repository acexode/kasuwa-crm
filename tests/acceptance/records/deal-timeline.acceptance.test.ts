import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  ensureStandardObjectDefs,
  loadMigrations,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_ACCOUNTS,
  SEED_ACTIVITIES,
  SEED_CONTACTS,
  SEED_DEALS,
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
import { reseed } from '@kasuwa/testing';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0111, activities linked to a deal and the deal timeline (P06;
 * Agent 3, migration 0037). Written by QA for the lead before the build
 * (D-L23, D-L25), from the contract and the decisions, not from an
 * implementation.
 *
 * Sources: team/tasks/T-0111-deal-timeline.md; docs/api/records.openapi.yaml
 * (`listDealTimeline`, `DealTimelinePage`, `DealFieldChangedItem`, and
 * `dealId` on Activity, CreateActivityRequest and UpdateActivityRequest, all
 * committed with this file as a lead contract edit); D-L88 (activity.deal_id
 * approved, the 0027 pattern, composite FKs RESTRICT, the allow-list key
 * guard), D-L76 (id rotation), D-L65 (no populated cell), D-L72 (timeline
 * rulings), D-L77 (activities order by created_at), D-L80 (no names in
 * cursors), D-L81 (actors, creation), D-L85 (versions on items), D-L124 and
 * D-L127 (deal readers; client_portal reads no deal), D-P18 (activity rights).
 * Prior art, copied and never imported (importing a test file registers its
 * tests): activity-table (T-0060), timeline-v2 (T-0080), activities-api
 * (T-0082), pipeline-tables (T-0106), deals-api (T-0108), list-indexes (T-0084).
 *
 * Fixtures: packages/db/src/fixtures.ts only, plus rows planted here by
 * `kasuwa_migrator` (BYPASSRLS, never serves) with ids in this suite's own
 * range (`11111111-0000-4000-8000-0111xxxxxxxx`). Deals are planted in each
 * programme's DEFAULT pipeline (seeded by ensureStandardObjectDefs, T-0106).
 * Every planted text is synthetic. If the contract and this file disagree on
 * something the contract states, the contract wins and this file is the
 * defect: say so in the report, do not edit it.
 *
 * ==========================================================================
 * PINNED INTERFACES (the builder must honour these exactly)
 * ==========================================================================
 *
 * COLUMN.   `activity.deal_id uuid NULL`, no default; existing rows NULL.
 * KEY.      One FK from activity to deal through
 *           (tenant_id, programme_id, deal_id) -> deal (tenant_id,
 *           programme_id, id), ON UPDATE RESTRICT and ON DELETE RESTRICT. Its
 *           name is the builder's (R16).
 * INDEX.    R15.
 * GRANTS.   kasuwa_app: INSERT (table-level, as today) and column UPDATE on
 *           deal_id; still no UPDATE on id, tenant_id, programme_id,
 *           created_by_user_id, created_at.
 * METADATA. A STANDARD field_def `deal_id` on every tenant's standard
 *           `activity` object: `lookup`, config exactly
 *           `{ targetObjectApiName: 'deal' }`, classification `none`, not
 *           required (R5). This suite plants grants against it, never
 *           definitions.
 * ROUTES.   createActivity  POST  /api/v1/activities          (+ dealId)
 *           updateActivity  PATCH /api/v1/activities/{id}     (+ dealId)
 *           listDealTimeline GET  /api/v1/deals/{dealId}/timeline
 *                                 ?cursor&limit   -> DealTimelinePage
 * QUERY.    `cursor` and `limit` (1..100, default 25) only.
 * ERRORS.   Shared admin `Error` envelope. 400 validation_failed with
 *           details `{ path: 'dealId', code: 'unknown_reference' }` (R2),
 *           `{ path: 'dealId', code: 'field_not_editable' }` on 403
 *           not_permitted (R5), `{ path: 'cursor', code: 'invalid_cursor' }`
 *           (R13); 404 not_found, getDeal's bytes (R12); 409 stale_write.
 * AUDIT.    audit_event, object_type `activity`, R6.
 * FLAGS.    listDealTimeline and the four `dealId` properties are
 *           `x-kasuwa-implemented: true` once served.
 *
 * ==========================================================================
 * RULINGS where the task and contract were open (lead to accept or amend)
 * ==========================================================================
 *
 * R1  `dealId` is a LINK, never a target. `contactId` or `accountId` is still
 *     required and still decides the programme; 0027's at-least-one-target
 *     CHECK is unchanged (expand only). A body with only `dealId` is 400
 *     validation_failed (detail code the builder's). Consequence: a deal with
 *     neither a primary contact nor an account has nothing to log against on
 *     the screen; that is a product question for T-0110/T-0111's screen.
 * R2  The deal must be in the activity's programme. A deal in another
 *     programme (even one the caller reads), another tenant's, and an id that
 *     names nothing are ONE 400 body, byte for byte, details
 *     `{ path: 'dealId', code: 'unknown_reference' }`, never echoing the id.
 *     A non-uuid dealId is 400 validation_failed (detail code the builder's).
 * R3  No agreement is required between the activity's contact or account and
 *     the deal's primary contact or account (same programme suffices).
 * R4  Linking needs `activity.write` and nothing more: an agent may link to a
 *     colleague's deal or a won one. The deal row is never written (its
 *     version and updated_at stay) and no deal audit event is written.
 *     `dealId` is the one link updateActivity may change; contactId and
 *     accountId stay 400 there.
 * R5  `dealId` follows the activity's `deal_id` field security: withheld, it
 *     is omitted from the Activity and named in `withheldFields`; sending it
 *     when withheld OR read-only is 403 not_permitted, field_not_editable at
 *     dealId. Error order: create 404, 403, 400; update 404, 403, 400, 409.
 * R6  Audit by name only. A create that sets dealId names `dealId`; an update
 *     that sets, moves or clears the link names `dealId`; each such change is
 *     exactly `{ field: 'dealId', before: null, after: null, redacted: true }`.
 *     The deal id appears nowhere in the event (changes or label). A refusal
 *     writes no event.
 * R7  Every Activity answer carries `dealId` (a lower-case uuid or null)
 *     unless withheld; exactly one of "present" and "in withheldFields".
 * R8  Deal timeline field items: the closed list `name, amount,
 *     expectedCloseDate, ownerUserId, primaryContactId, accountId, nextStep,
 *     stageId, checks`, ALL by name only (`redacted: true`, never before or
 *     after), even where the audit row holds a move's stage ids or a
 *     reassignment's owner ids. `stageEnteredAt`, `closedAt` and any other
 *     name yield no item. (The P06 design prints "Proposal -> Negotiation";
 *     stage ids on the item would be a later, additive lead contract edit.)
 * R9  Deal-matrix field security on items is getDeal's: an item is omitted
 *     exactly when getDeal lists its field in `withheldFields` for that
 *     caller. `name`, `stageId` and `checks` are never withheld (D-L124 R13).
 * R10 A withheld activity `deal_id` removes every activity item from the
 *     deal timeline; withheld `contact_id` and `account_id` do not (the item
 *     names neither).
 * R11 ActivityItem is unchanged (no dealId on items): one schema on all three
 *     timelines, and an activity's item is the same on the deal and contact
 *     timelines in everything but `id`.
 * R12 Scope: the deal readers of D-L127 (admin, programme_manager, team_lead,
 *     agent, qa_analyst, the tenant-admin flag). client_portal, a custom set,
 *     no membership, another programme or tenant, nowhere and non-uuid ids
 *     all get getDeal's ONE 404 body. 404 is decided before 400.
 * R13 Cursors: a position only; no name, no id of anything the pages did not
 *     show (the deal's own id may be bound in, as T-0080 allowed the
 *     account's). A malformed cursor, another deal's, an account or contact
 *     timeline's, and a listDeals cursor are 400 invalid_cursor; one from an
 *     unreachable deal answers byte for byte as one from a reachable deal. A
 *     deal-timeline cursor on the account timeline is 400 too.
 * R14 Migration: exactly one file adds `activity.deal_id`, found by content,
 *     and it is `0037_*.sql` (reserved for agent3/T-0111 by the hook, 202c2ea);
 *     0027, 0034 and 0036 are unedited; the SECURITY DEFINER census stays two.
 * R15 Index: a valid index on activity whose keys BEGIN (tenant_id,
 *     programme_id, deal_id, created_at, id), created_at and id in the same
 *     direction, unpartial or `WHERE deal_id IS NOT NULL`. At 20,000 planted
 *     activities the canonical page and continuation queries, replayed as
 *     kasuwa_app inside withTenantTransaction for an agent (A1) and the
 *     supervisor (A1+A2), have no Sort, no Seq Scan on activity and examine at
 *     most 200 activity rows.
 * R16 The FK's name is the builder's; its pairs and actions are pinned.
 * R17 The D-L76 key guard is unchanged: kasuwa_app and kasuwa_test_admin may
 *     set deal_id, and may not change id, tenant_id or programme_id.
 * R18 An activity linked after the fact sits at its logged time (created_at,
 *     D-L77) on the deal timeline, never at the time of linking.
 * R19 No rollup: activities of the deal's contact or account without dealId,
 *     and those of other deals, are not on the deal timeline.
 *
 * ==========================================================================
 * THE BUILDER'S (not asserted)
 * ==========================================================================
 * Item ids and cursor encodings (beyond R13); whether an activity's item id is
 * the same on the deal and the contact timeline; the detail codes of a
 * non-uuid dealId and of a dealId-only body; whether re-sending the current
 * dealId is audited; how the deal's UNIQUE (tenant_id, programme_id, id)
 * target is named; order of items that differ only below the millisecond
 * (each is served once).
 *
 * ==========================================================================
 * D-L23: on main `activity` has no `deal_id`, the live strict bodies refuse
 * `dealId` as an unknown property, no deal timeline route exists, the
 * activity catalogue has no `deal_id` field and the flags are false. Every
 * test except those titled "(self-check)" and "(contract)" fails on main for
 * one of those reasons: a 42703 or a missing file, a 400 where 201/200 is
 * expected, a 404 for the route where a 200 control is asserted first (so
 * "no route" never passes for "out of scope"), a missing field_def, or a
 * false flag. The self-checks test this file's own helpers; the contract
 * pins read the YAML committed with this file and pass at commit time.
 *
 * Writes: the suite reseeds before and after, and after every test.
 */

// ---------------------------------------------------------------------------
// Constants and fixtures (packages/db/src/fixtures.ts, never a second set).
// ---------------------------------------------------------------------------

const ACTIVITIES = '/api/v1/activities';
const CONTACTS = '/api/v1/contacts';
const ACCOUNTS = '/api/v1/accounts';
const DEALS = '/api/v1/deals';
const PIPELINES = '/api/v1/pipelines';
const dealTimelinePath = (id: string) => `${DEALS}/${id}/timeline`;

/** This suite's id range: `0111` marks T-0111. Tails are hex. */
const id111 = (tail: string) => `11111111-0000-4000-8000-0111${tail.padStart(8, '0')}`;
/** Never a real row. */
const NOWHERE = id111('fffffff');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);
const AGENT_2 = asUser(TENANT_A, USER_A_AGENT_2);
const NO_PROGRAMME = asUser(TENANT_A, USER_A_NO_PROGRAMME);
const TENANT_B_ADMIN = asUser(TENANT_B, USER_B_AGENT_1);

type Headers = Record<string, string>;
type Json = Record<string, unknown>;
type Params = readonly (readonly [string, string])[];

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`Fixture drift: ${what}`);
  return value;
}

function seededContact(givenNames: string) {
  return must(
    SEED_CONTACTS.find((candidate) => candidate.givenNames === givenNames),
    `no seeded contact '${givenNames}'`,
  );
}

function seededAccount(programmeId: string) {
  return must(
    SEED_ACCOUNTS.find((candidate) => candidate.programmeId === programmeId),
    `no seeded account in ${programmeId}`,
  );
}

/** Tenant A, A1. */
const AMAKA = seededContact('Amaka');
const BASHIR = seededContact('Bashir');
/** Tenant A, A2. */
const DAMILOLA = seededContact('Damilola');
/** Tenant B, B1. */
const GRACE = seededContact('Grace');
/** "Ikoyi Traders", A1. */
const IKOYI = seededAccount(PROGRAMME_A1);
/** "Sabon Gari Mart", A2. */
const SABON = seededAccount(PROGRAMME_A2);
/** "Westlands Supplies", B1. */
const WESTLANDS = seededAccount(PROGRAMME_B1);

/** The seeded deal: A1, owned by agent 1, first open stage (T-0106). */
const SEEDED_DEAL = must(SEED_DEALS[0], 'no seeded deal');

/** Planted deals (plantDeals). */
const DEAL_A1 = id111('d0001'); // A1, owned by the supervisor, Amaka and Ikoyi
const DEAL_A1_OTHER = id111('d0002'); // A1, owned by agent 1, no contact or account
const DEAL_A1_WON = id111('d0003'); // A1, in the won stage, owned by the supervisor
const DEAL_A2 = id111('d0004'); // A2: in tenant A, outside agent 1's reach
const DEAL_B1 = id111('d0005'); // tenant B
const DEAL_NAMES: Readonly<Record<string, string>> = {
  [DEAL_A1]: 'T0111 synthetic deal one',
  [DEAL_A1_OTHER]: 'T0111 synthetic deal two',
  [DEAL_A1_WON]: 'T0111 synthetic deal won',
  [DEAL_A2]: 'T0111 synthetic deal A2',
  [DEAL_B1]: 'T0111 synthetic deal B1',
};

function displayNameOf(userId: string): string {
  for (const tenant of SEED_TENANTS) {
    const user = tenant.users.find((candidate) => candidate.id === userId);
    if (user !== undefined) return user.displayName;
  }
  throw new Error(`Fixture drift: no seeded user ${userId}`);
}

function permissionSet(tenantId: string, key: string): string {
  return must(
    SEED_PERMISSION_SETS.find(
      (candidate) => candidate.tenantId === tenantId && candidate.key === key,
    )?.id,
    `no seeded permission set '${key}'`,
  );
}

/** Unique per run so a probe never matches an earlier, unreseeded run. */
const RUN = Date.now().toString(36);
const iso = (ms: number) => new Date(ms).toISOString();

/** R8: the closed field list of a deal timeline item. */
const DEAL_TIMELINE_FIELDS = [
  'name',
  'amount',
  'expectedCloseDate',
  'ownerUserId',
  'primaryContactId',
  'accountId',
  'nextStep',
  'stageId',
  'checks',
];

/** Migration checksums at the time of writing (runner algorithm: sha256 of LF text). */
const PINNED_CHECKSUMS: Readonly<Record<string, string>> = {
  '0027_activity': 'cf97d7fc4029637aa14bcdf189ec4e1a9ad9eb4f7f13e1825bfc0eaf0415fbb6',
  '0034_activity_meeting_times': 'b1c4cfdecc3774f4a2dcceeec8c17a9ea31c36a91be431395f9cc62d5fa8d214',
  '0036_pipeline_and_deal': 'fd80e2bc4b80691fcb3fa3c0b42bafd1b9c3cd4b49382198579590ed29c2547d',
};

const MIGRATIONS_DIR = resolve(__dirname, '../../../packages/db/migrations');

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** R14: `ALTER TABLE activity ... ADD [COLUMN] [IF NOT EXISTS] deal_id`. */
const ADDS_DEAL_ID =
  /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:public\.)?"?activity"?\s+[^;]*?\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?deal_id"?\s/i;

function dealIdMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .filter((name) => ADDS_DEAL_ID.test(stripComments(readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8'))))
    .sort();
}

// ---------------------------------------------------------------------------
// A small JSON-Schema checker over the published YAML (no new dependency).
// Copied from the T-0080 suite: `allOf`, `oneOf`, `const`, closed objects.
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

const FORMATS: Record<string, RegExp> = { uuid: UUID, 'date-time': DATE_TIME };

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
      errors.push(`${path}: matches ${passing.length} oneOf branches (${JSON.stringify(value)})`);
    }
  }
  if ('const' in schema && schema.const !== value) {
    errors.push(`${path}: ${JSON.stringify(value)} is not the const ${JSON.stringify(schema.const)}`);
  }
  const actual = jsonType(value);
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
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
  if (Array.isArray(value) && schema.items !== undefined && typeof schema.items === 'object') {
    value.forEach((item, index) => check(schema.items as Json, at, item, `${path}[${index}]`, errors));
  }
  if (actual === 'object') {
    const object = value as Json;
    const properties = (schema.properties ?? {}) as Record<string, Json>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in object)) errors.push(`${path}: required property "${key}" is missing`);
    }
    for (const [key, child] of Object.entries(object)) {
      const childSchema = properties[key];
      if (childSchema !== undefined) check(childSchema, at, child, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) {
        errors.push(`${path}: property "${key}" is not allowed`);
      }
    }
  }
}

const schemaAt = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });

function schemaErrors(schema: Json, value: unknown, where: string): string[] {
  const errors: string[] = [];
  check(schema, SPEC_PATH, value, where, errors);
  return errors;
}

interface SpecOperation {
  path: string;
  method: string;
  op: Json;
  pathItem: Json;
}

function findOperation(operationId: string): SpecOperation | undefined {
  const paths = ((loadDoc(SPEC_PATH) as Json).paths ?? {}) as Record<string, Json>;
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (typeof op === 'object' && op !== null && (op as Json).operationId === operationId) {
        return { path, method, op: op as Json, pathItem: item };
      }
    }
  }
  return undefined;
}

function requireOperation(operationId: string): SpecOperation {
  return must(findOperation(operationId), `records.openapi.yaml has no operation ${operationId}`);
}

function responseOf(operationId: string, status: string): Json {
  const raw = ((requireOperation(operationId).op.responses ?? {}) as Json)[status] as Json | undefined;
  return deref(must(raw, `${operationId} documents no ${status} response`), SPEC_PATH).schema;
}

function responseSchemaOf(operationId: string, status: string): Json {
  const media = (responseOf(operationId, status).content as Json | undefined)?.[
    'application/json'
  ] as Json | undefined;
  return must(media?.schema as Json | undefined, `${operationId} ${status} has no JSON schema`);
}

function exampleOf(operationId: string, status: string): unknown {
  const media = (responseOf(operationId, status).content as Json | undefined)?.[
    'application/json'
  ] as Json | undefined;
  return must(media?.example, `${operationId} ${status} has no example`);
}

/** The node one `type` resolves to in a page's item union. */
function branchOf(pageSchema: Json, type: string): Json {
  const page = deref(pageSchema, SPEC_PATH).schema;
  const items = deref(((page.properties as Json).data as Json).items as Json, SPEC_PATH).schema;
  for (const branch of (items.oneOf ?? []) as Json[]) {
    const resolved = deref(branch, SPEC_PATH).schema;
    const typeNode = ((resolved.properties ?? {}) as Json).type as Json | undefined;
    if (typeNode?.const === type) return resolved;
  }
  throw new Error(`the page has no ${type} branch`);
}

function rawSchemaProperty(schema: string, key: string): Json | undefined {
  const node = deref(schemaAt(schema), SPEC_PATH).schema;
  return ((node.properties ?? {}) as Record<string, Json>)[key];
}

function typesOf(node: Json | undefined): string[] {
  const type = node?.type;
  return Array.isArray(type) ? (type as string[]) : typeof type === 'string' ? [type] : [];
}

// ---------------------------------------------------------------------------
// Response checks.
// ---------------------------------------------------------------------------

function expectError(response: request.Response, status: number, code: string): Json {
  expect(
    response.status,
    `expected ${status} ${code}, got ${response.status} ${JSON.stringify(response.body)}`,
  ).toBe(status);
  expect(
    schemaErrors({ $ref: './admin.openapi.yaml#/components/schemas/Error' }, response.body, 'Error'),
    'response body does not match the shared Error schema',
  ).toEqual([]);
  const body = response.body as Json;
  expect(body.statusCode, 'Error.statusCode').toBe(status);
  expect(body.code, 'Error.code').toBe(code);
  return body;
}

function detailsOf(body: Json): { path: string; code: string }[] {
  return Array.isArray(body.details) ? (body.details as { path: string; code: string }[]) : [];
}

function expectStatus(response: request.Response, status: number, where: string): void {
  expect(response.status, `${where}: ${JSON.stringify(response.body)}`).toBe(status);
}

function expectNoStore(response: request.Response, where: string): void {
  expect(
    String(response.headers['cache-control'] ?? ''),
    `${where}: Cache-Control must be no-store`,
  ).toMatch(/(^|[\s,])no-store($|[\s,])/);
}

function expectNoTotals(response: request.Response, where: string): void {
  const headers = Object.keys(response.headers).filter((name) => /total|count/i.test(name));
  expect(headers, `${where}: a response header carries a total`).toEqual([]);
}

/** R2: the unknown_reference body at dealId, which never echoes an id. */
function expectUnknownDeal(response: request.Response, where: string, ids: string[]): string {
  const body = expectError(response, 400, 'validation_failed');
  expect(detailsOf(body), where).toContainEqual({ path: 'dealId', code: 'unknown_reference' });
  for (const id of ids) {
    expect(response.text.toLowerCase(), `${where}: the body echoes ${id}`).not.toContain(
      id.toLowerCase(),
    );
  }
  return response.text;
}

/** R5: 403 not_permitted, field_not_editable at dealId. */
function expectDealNotEditable(response: request.Response, where: string): void {
  const body = expectError(response, 403, 'not_permitted');
  expect(detailsOf(body), where).toContainEqual({ path: 'dealId', code: 'field_not_editable' });
}

/** R7 and the operation's own schema: dealId present XOR listed as withheld. */
function activityProblems(
  operationId: 'createActivity' | 'updateActivity',
  status: number,
  value: unknown,
  where: string,
): string[] {
  const problems = schemaErrors(responseSchemaOf(operationId, String(status)), value, where);
  const activity = (value ?? {}) as Json;
  const withheld = (Array.isArray(activity.withheldFields) ? activity.withheldFields : []) as string[];
  if ('dealId' in activity === withheld.includes('dealId')) {
    problems.push(`${where}: dealId must be present or listed in withheldFields, exactly one`);
  }
  if ('dealId' in activity && activity.dealId !== null && !LOWER_UUID.test(String(activity.dealId))) {
    problems.push(`${where}: dealId ${JSON.stringify(activity.dealId)} is not a lower-case uuid`);
  }
  return problems;
}

function expectActivity(
  response: request.Response,
  operationId: 'createActivity' | 'updateActivity',
  status: number,
  where: string,
): Json {
  expectStatus(response, status, where);
  expect(activityProblems(operationId, status, response.body, where), where).toEqual([]);
  return response.body as Json;
}

// ---------------------------------------------------------------------------
// Timeline shapes (R8, R11).
// ---------------------------------------------------------------------------

const ACTIVITY_ITEM_KEYS = [
  'id',
  'type',
  'occurredAt',
  'actor',
  'activityId',
  'activityType',
  'subject',
  'body',
  'dueAt',
  'completedAt',
  'startsAt',
  'endsAt',
  'version',
];
const ACTIVITY_ITEM_WITHHOLDABLE = ['subject', 'body', 'dueAt', 'completedAt', 'startsAt', 'endsAt'];
const DEAL_FIELD_ITEM_KEYS = ['actor', 'field', 'id', 'occurredAt', 'redacted', 'type'];

function activityItemProblems(item: Json, where: string): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(item)) {
    if (!ACTIVITY_ITEM_KEYS.includes(key)) problems.push(`${where}: unexpected key ${key}`);
  }
  for (const key of ACTIVITY_ITEM_KEYS) {
    if (!ACTIVITY_ITEM_WITHHOLDABLE.includes(key) && !(key in item)) {
      problems.push(`${where}: ${key} missing`);
    }
  }
  if (!Number.isInteger(item.version) || Number(item.version) < 1) {
    problems.push(`${where}: version ${JSON.stringify(item.version)} is not an integer >= 1`);
  }
  if (typeof item.activityId !== 'string' || !UUID.test(item.activityId)) {
    problems.push(`${where}: activityId is not a uuid`);
  } else if (String(item.id).toLowerCase() === item.activityId.toLowerCase()) {
    problems.push(`${where}: the item id is the activity id`);
  }
  return problems;
}

function actorProblems(item: Json, where: string): string[] {
  if (!('actor' in item)) return [`${where}: actor missing`];
  const actor = item.actor;
  if (actor === null) return [];
  if (typeof actor !== 'object') return [`${where}: actor is not an object or null`];
  const keys = Object.keys(actor as Json).sort();
  const problems: string[] = [];
  if (keys.join() !== 'displayName,id') problems.push(`${where}: actor keys ${keys.join()}`);
  if (!UUID.test(String((actor as Json).id))) problems.push(`${where}: actor.id not a uuid`);
  if (typeof (actor as Json).displayName !== 'string') {
    problems.push(`${where}: actor.displayName not a string`);
  }
  return problems;
}

/** R8: by name only, a listed Deal field, nothing else. */
function dealFieldItemProblems(item: Json, where: string): string[] {
  const problems: string[] = [];
  const keys = Object.keys(item).sort();
  if (keys.join() !== DEAL_FIELD_ITEM_KEYS.join()) {
    problems.push(`${where}: keys ${keys.join()}, expected ${DEAL_FIELD_ITEM_KEYS.join()}`);
  }
  if (item.redacted !== true) problems.push(`${where}: redacted is not true`);
  if (!DEAL_TIMELINE_FIELDS.includes(String(item.field))) {
    problems.push(`${where}: ${JSON.stringify(item.field)} is not a deal timeline field`);
  }
  return problems;
}

/** Newest first; exact ties broken by id descending (code units). */
function orderProblems(items: Json[], strictTies: boolean): string[] {
  const problems: string[] = [];
  for (let index = 1; index < items.length; index += 1) {
    const newer = items[index - 1] ?? {};
    const older = items[index] ?? {};
    const a = Date.parse(String(newer.occurredAt));
    const b = Date.parse(String(older.occurredAt));
    if (a < b) problems.push(`[${index}] is newer than [${index - 1}]`);
    if (strictTies && a === b && !(String(newer.id) > String(older.id))) {
      problems.push(`[${index - 1}] and [${index}] share occurredAt and ids are not descending`);
    }
  }
  return problems;
}

interface Page {
  data: Json[];
  nextCursor: string | null;
}

function pageOf(value: unknown): Page {
  const page = (value ?? {}) as { data?: unknown; nextCursor?: unknown };
  return {
    data: Array.isArray(page.data) ? (page.data as Json[]) : [],
    nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null,
  };
}

function closedPageProblems(value: unknown, where: string): string[] {
  const keys = Object.keys((value ?? {}) as Json).sort();
  return keys.join() === 'data,nextCursor'
    ? []
    : [`${where}: the page carries ${keys.join()}, not data and nextCursor`];
}

/** The operation's own 200 schema, then this file's readings. */
function dealPageProblems(value: unknown, where: string): string[] {
  const problems = [
    ...schemaErrors(responseSchemaOf('listDealTimeline', '200'), value, where),
    ...closedPageProblems(value, where),
  ];
  pageOf(value).data.forEach((item, index) => {
    const at = `${where}.data[${index}]`;
    if (typeof item.id !== 'string' || item.id === '') problems.push(`${at}: id`);
    problems.push(...actorProblems(item, at));
    if (item.type === 'field_changed') problems.push(...dealFieldItemProblems(item, at));
    else if (item.type === 'activity') problems.push(...activityItemProblems(item, at));
    else problems.push(`${at}: type ${JSON.stringify(item.type)} is not on a deal timeline`);
  });
  return problems;
}

function expectDealPage(value: unknown, where: string, strictTies = true): Page {
  expect(dealPageProblems(value, where), `${where} is not a deal timeline page`).toEqual([]);
  const page = pageOf(value);
  expect(orderProblems(page.data, strictTies), `${where}: order`).toEqual([]);
  return page;
}

const fieldItems = (items: Json[]) => items.filter((item) => item.type === 'field_changed');
const activityItems = (items: Json[]) => items.filter((item) => item.type === 'activity');
const activityIdsOf = (items: Json[]) => activityItems(items).map((item) => String(item.activityId)).sort();
const fieldsOf = (items: Json[]) => fieldItems(items).map((item) => String(item.field)).sort();
const withoutId = (item: Json | undefined): Json =>
  Object.fromEntries(Object.entries(item ?? {}).filter(([key]) => key !== 'id'));
function withoutKey(item: Json, key: string): Json {
  return Object.fromEntries(Object.entries(item).filter(([name]) => name !== key));
}

/** An audit change as the writers record it. */
interface Change {
  field: string;
  before: unknown;
  after: unknown;
  redacted: boolean;
}
const named = (field: string): Change => ({ field, before: null, after: null, redacted: true });

// ---------------------------------------------------------------------------
// R13: reading a cursor every way this suite can, to look inside it.
// ---------------------------------------------------------------------------

function decodeOnce(text: string): string[] {
  const out: string[] = [];
  try {
    out.push(decodeURIComponent(text));
  } catch {
    // not URI-encoded
  }
  for (const encoding of ['base64url', 'base64'] as const) {
    out.push(Buffer.from(text, encoding).toString('utf8'));
    out.push(Buffer.from(text, encoding).toString('latin1'));
  }
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) {
    out.push(Buffer.from(text, 'hex').toString('utf8'));
  }
  return out;
}

function cursorReadings(cursor: string): string[] {
  const first = [cursor, ...decodeOnce(cursor)];
  const second = first.flatMap((text) => (/^[A-Za-z0-9_\-+/=%]+$/.test(text) ? decodeOnce(text) : []));
  return [...first, ...second].map((text) => text.toLowerCase());
}

const idForms = (id: string) => [id.toLowerCase(), id.toLowerCase().replace(/-/g, '')];

// ---------------------------------------------------------------------------
// Database probing (activity-table's pattern).
// ---------------------------------------------------------------------------

type Query = <R extends QueryResultRow>(sql: string, values?: unknown[]) => Promise<R[]>;

type Outcome =
  | { accepted: true }
  | { accepted: false; code: string; message: string; constraint: string };

function outcomeOf(error: unknown): Outcome {
  const { code, message, constraint } = error as {
    code?: unknown;
    message?: unknown;
    constraint?: unknown;
  };
  return {
    accepted: false,
    code: typeof code === 'string' ? code : '?',
    message: typeof message === 'string' ? message : String(error),
    constraint: typeof constraint === 'string' ? constraint : '',
  };
}

/** One statement under a savepoint, deferred checks forced, always rolled back. */
async function probe(query: Query, sql: string, values: unknown[] = []): Promise<Outcome> {
  await query('SAVEPOINT t0111_probe');
  let outcome: Outcome;
  try {
    await query(sql, values);
    await query('SET CONSTRAINTS ALL IMMEDIATE');
    outcome = { accepted: true };
  } catch (error) {
    outcome = outcomeOf(error);
  }
  await query('ROLLBACK TO SAVEPOINT t0111_probe');
  return outcome;
}

function verdict(outcome: Outcome): string {
  if (outcome.accepted) return 'accepted';
  const { code, message } = outcome;
  if (code === '23503') return 'foreign_key_violation';
  if (code === '23505') return 'unique_violation';
  if (code === '42501') return 'insufficient_privilege';
  if (code === 'P0001' || code.startsWith('23') || code.startsWith('22')) return 'refused';
  // 42703 (no such column) lands here verbatim: the honest failure on main.
  return `error ${code}: ${message}`;
}

const REFUSALS = ['foreign_key_violation', 'refused', 'insufficient_privilege'];

class Rollback<T> {
  constructor(readonly value: T) {}
}

/** withTenantTransaction (kasuwa_app, real RLS), nothing commits. */
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

/** A plain transaction on a pool that is always rolled back. */
async function rolledBackTx<T>(pool: Pool, fn: (query: Query) => Promise<T>): Promise<T> {
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

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Parent Relationship'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const child of node.Plans ?? []) flatten(child, out);
  return out;
}

/** R15: no Sort, no Seq Scan on activity, a bounded number of activity rows examined. */
function planProblems(root: PlanNode, budget: number): string[] {
  const problems: string[] = [];
  let examined = 0;
  let scans = 0;
  for (const node of flatten(root)) {
    if (node['Node Type'] === 'Sort') problems.push('a Sort node: the order does not come from an index');
    if (node['Relation Name'] === 'activity') {
      scans += 1;
      if (node['Node Type'] === 'Seq Scan') problems.push('a Seq Scan on activity');
      examined +=
        ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) * (node['Actual Loops'] ?? 1);
    }
  }
  if (scans === 0) problems.push('no scan of activity in the plan');
  if (examined > budget) problems.push(`examined ${examined} activity rows (budget ${budget})`);
  return problems;
}

// ---------------------------------------------------------------------------

describe('acceptance: activities linked to a deal, and the deal timeline (T-0111)', () => {
  let app: INestApplication;
  /** kasuwa_migrator — BYPASSRLS. Plants rows and observes them; never serves. */
  let observer: Pool;
  /** kasuwa_app — the serving role, for database-level probes under real RLS. */
  let appPool: Pool;
  /** kasuwa_test_admin — BYPASSRLS, table-level DML; the key guard must bind it (R17). */
  let testAdmin: Pool;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    app = await createApi(inject('databaseUrl'));
    observer = createPool({ connectionString: inject('migrationUrl'), max: 3 });
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
    testAdmin = createPool({ connectionString: inject('testAdminUrl'), max: 1 });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await observer?.end();
    await appPool?.end();
    await testAdmin?.end();
    await reseed(inject('migrationUrl'));
  }, 120_000);

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();

  // --- HTTP helpers -------------------------------------------------------

  const withQuery = (path: string, params: Params) => {
    const query = new URLSearchParams(params.map(([k, v]): [string, string] => [k, v])).toString();
    return query === '' ? path : `${path}?${query}`;
  };
  const dealTimeline = (headers: Headers, dealId: string, params: Params = []) =>
    request(server()).get(withQuery(dealTimelinePath(dealId), params)).set(headers);
  const dealTimelineRaw = (headers: Headers, segment: string) =>
    request(server()).get(`${DEALS}/${segment}/timeline`).set(headers);
  const contactTimeline = (headers: Headers, id: string, params: Params = []) =>
    request(server()).get(withQuery(`${CONTACTS}/${id}/timeline`, params)).set(headers);
  const accountTimeline = (headers: Headers, id: string, params: Params = []) =>
    request(server()).get(withQuery(`${ACCOUNTS}/${id}/timeline`, params)).set(headers);
  const getDeal = (headers: Headers, id: string) =>
    request(server()).get(`${DEALS}/${encodeURIComponent(id)}`).set(headers);
  const updateDeal = (headers: Headers, id: string, body: unknown) =>
    request(server()).patch(`${DEALS}/${id}`).set(headers).send(body as object);
  const createDeal = (headers: Headers, pipelineId: string, body: unknown) =>
    request(server()).post(`${PIPELINES}/${pipelineId}/deals`).set(headers).send(body as object);
  const listDeals = (headers: Headers, pipelineId: string, params: Params = []) =>
    request(server()).get(withQuery(`${PIPELINES}/${pipelineId}/deals`, params)).set(headers);
  const createActivity = (headers: Headers, body: unknown) =>
    request(server()).post(ACTIVITIES).set(headers).send(body as object);
  const updateActivity = (headers: Headers, id: string, body: unknown) =>
    request(server()).patch(`${ACTIVITIES}/${id}`).set(headers).send(body as object);

  /** One read of the whole deal timeline (limit 100), validated. */
  async function readDeal(headers: Headers, dealId: string, where: string): Promise<Json[]> {
    const response = await dealTimeline(headers, dealId, [['limit', '100']]);
    expectStatus(response, 200, where);
    expectNoStore(response, where);
    const page = expectDealPage(response.body, where);
    expect(page.nextCursor, `${where}: more than 100 items; never planted here`).toBeNull();
    return page.data;
  }

  async function readContact(headers: Headers, contactId: string, where: string): Promise<Json[]> {
    const response = await contactTimeline(headers, contactId, [['limit', '100']]);
    expectStatus(response, 200, where);
    return pageOf(response.body).data;
  }

  async function readAccount(headers: Headers, accountId: string, where: string): Promise<Json[]> {
    const response = await accountTimeline(headers, accountId, [['limit', '100']]);
    expectStatus(response, 200, where);
    return pageOf(response.body).data;
  }

  /** The control most timeline tests open with: a reachable deal serves 200. */
  async function control(headers: Headers = AGENT_1, dealId: string = DEAL_A1): Promise<void> {
    expectStatus(await dealTimeline(headers, dealId), 200, 'control: the deal timeline serves');
  }

  interface Walked {
    items: Json[];
    sizes: number[];
    cursors: string[];
    bodies: string[];
  }

  /** Walks every page: full pages carry cursors, no cursor leads to an empty page, no repeats. */
  async function walkDeal(
    headers: Headers,
    dealId: string,
    limit: number | null,
    strictTies = true,
    startCursor: string | null = null,
  ): Promise<Walked> {
    const walked: Walked = { items: [], sizes: [], cursors: [], bodies: [] };
    let cursor = startCursor;
    let pages = 0;
    do {
      const params: [string, string][] = limit === null ? [] : [['limit', String(limit)]];
      if (cursor !== null) params.push(['cursor', cursor]);
      const where = `page ${pages + 1} at limit ${String(limit)}`;
      const response = await dealTimeline(headers, dealId, params);
      expectStatus(response, 200, where);
      expectNoStore(response, where);
      expectNoTotals(response, where);
      const page = expectDealPage(response.body, where, strictTies);
      const full = limit ?? 25;
      if (page.nextCursor !== null) {
        expect(
          page.data.length,
          `${where} has a nextCursor but ${page.data.length} of ${full} items: withheld items were omitted after the page was cut`,
        ).toBe(full);
        walked.cursors.push(page.nextCursor);
      }
      if (pages > 0 || startCursor !== null) {
        expect(page.data.length, `${where}: a nextCursor led to an empty page`).toBeGreaterThan(0);
      }
      walked.items.push(...page.data);
      walked.sizes.push(page.data.length);
      walked.bodies.push(response.text);
      cursor = page.nextCursor;
      pages += 1;
      if (pages > 120) throw new Error('timeline paging did not terminate');
    } while (cursor !== null);
    const ids = walked.items.map((item) => String(item.id));
    expect(new Set(ids).size, 'an item was repeated across pages').toBe(ids.length);
    expect(orderProblems(walked.items, strictTies), 'the walk as a whole is newest first').toEqual([]);
    return walked;
  }

  async function firstCursor(read: () => request.Test, where: string): Promise<string> {
    const response = await read();
    expectStatus(response, 200, where);
    const cursor = pageOf(response.body).nextCursor;
    expect(cursor, `${where}: control, a second page exists`).toEqual(expect.any(String));
    return cursor ?? '';
  }

  const chunks = (total: number, limit: number) => {
    const sizes: number[] = [];
    for (let left = total; left > 0; left -= limit) sizes.push(Math.min(limit, left));
    return sizes.length === 0 ? [0] : sizes;
  };

  // --- observer helpers ----------------------------------------------------

  interface Stages {
    pipelineId: string;
    firstOpen: string;
    secondOpen: string;
    won: string;
  }

  /** The programme's default pipeline (T-0106, R11 there), read as the migrator. */
  async function stagesOf(programmeId: string): Promise<Stages> {
    const rows = (
      await observer.query<{ pipeline_id: string; id: string; kind: string }>(
        `SELECT p.id AS pipeline_id, s.id, s.kind
           FROM pipeline p
           JOIN pipeline_stage s ON s.pipeline_id = p.id AND s.tenant_id = p.tenant_id
          WHERE p.programme_id = $1
          ORDER BY p.created_at, p.id, s.position`,
        [programmeId],
      )
    ).rows;
    const pipelineId = must(rows[0]?.pipeline_id, `no default pipeline in ${programmeId}`);
    const mine = rows.filter((row) => row.pipeline_id === pipelineId);
    const open = mine.filter((row) => row.kind === 'open');
    return {
      pipelineId,
      firstOpen: must(open[0]?.id, 'no open stage'),
      secondOpen: must(open[1]?.id, 'no second open stage'),
      won: must(mine.find((row) => row.kind === 'won')?.id, 'no won stage'),
    };
  }

  interface DealPlant {
    id: string;
    tenantId: string;
    programmeId: string;
    owner: string | null;
    contact?: string | null;
    account?: string | null;
    won?: boolean;
  }

  async function plantDeal(row: DealPlant): Promise<void> {
    const stages = await stagesOf(row.programmeId);
    await observer.query(
      `INSERT INTO deal (id, tenant_id, programme_id, pipeline_id, stage_id, name, amount_minor,
                         currency, owner_user_id, primary_contact_id, account_id, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 125000, 'NGN', $7, $8, $9, $10)`,
      [
        row.id,
        row.tenantId,
        row.programmeId,
        stages.pipelineId,
        row.won === true ? stages.won : stages.firstOpen,
        must(DEAL_NAMES[row.id], `a name for ${row.id}`),
        row.owner,
        row.contact ?? null,
        row.account ?? null,
        row.won === true ? new Date().toISOString() : null,
      ],
    );
  }

  /** Every planted deal. Runs on main: the deal table exists since 0036. */
  async function plantDeals(): Promise<void> {
    await plantDeal({
      id: DEAL_A1,
      tenantId: TENANT_A,
      programmeId: PROGRAMME_A1,
      owner: USER_A_SUPERVISOR,
      contact: AMAKA.id,
      account: IKOYI.id,
    });
    await plantDeal({ id: DEAL_A1_OTHER, tenantId: TENANT_A, programmeId: PROGRAMME_A1, owner: USER_A_AGENT_1 });
    await plantDeal({
      id: DEAL_A1_WON,
      tenantId: TENANT_A,
      programmeId: PROGRAMME_A1,
      owner: USER_A_SUPERVISOR,
      won: true,
    });
    await plantDeal({
      id: DEAL_A2,
      tenantId: TENANT_A,
      programmeId: PROGRAMME_A2,
      owner: USER_A_AGENT_2,
      contact: DAMILOLA.id,
    });
    await plantDeal({ id: DEAL_B1, tenantId: TENANT_B, programmeId: PROGRAMME_B1, owner: USER_B_AGENT_1 });
  }

  async function dealRow(id: string): Promise<Json | null> {
    return (await observer.query<Json>('SELECT * FROM deal WHERE id = $1', [id])).rows[0] ?? null;
  }

  async function activityRow(id: string): Promise<Json | null> {
    return (await observer.query<Json>('SELECT * FROM activity WHERE id = $1', [id])).rows[0] ?? null;
  }

  async function activityCount(): Promise<number> {
    return Number((await observer.query<{ n: string }>('SELECT count(*) AS n FROM activity')).rows[0]?.n);
  }

  async function auditCount(objectType: string): Promise<number> {
    return Number(
      (await observer.query<{ n: string }>('SELECT count(*) AS n FROM audit_event WHERE object_type = $1', [objectType]))
        .rows[0]?.n,
    );
  }

  interface AuditRow {
    action: string;
    object_label: string;
    actor_user_id: string | null;
    changes: Change[];
  }

  async function activityEvents(activityId: string): Promise<AuditRow[]> {
    return (
      await observer.query<AuditRow>(
        `SELECT action, object_label, actor_user_id, changes FROM audit_event
          WHERE object_type = 'activity' AND object_id = $1 ORDER BY occurred_at, id`,
        [activityId],
      )
    ).rows;
  }

  interface PlantedActivity {
    id: string;
    tenantId?: string;
    programmeId?: string;
    type?: 'note' | 'task' | 'call';
    subject?: string | null;
    body?: string | null;
    contactId?: string | null;
    accountId?: string | null;
    dealId?: string | null;
    ownerUserId?: string | null;
    createdByUserId?: string | null;
    dueAt?: string | null;
    createdAt?: string | null;
  }

  /** Names `deal_id`: on main this is a 42703, the honest failure. */
  async function plantActivity(activity: PlantedActivity): Promise<void> {
    await observer.query(
      `INSERT INTO activity (id, tenant_id, programme_id, type, subject, body, owner_user_id,
                             contact_id, account_id, deal_id, created_by_user_id, due_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13::timestamptz, now()))`,
      [
        activity.id,
        activity.tenantId ?? TENANT_A,
        activity.programmeId ?? PROGRAMME_A1,
        activity.type ?? 'note',
        activity.subject === undefined ? `T0111 synthetic ${activity.id.slice(-6)}` : activity.subject,
        activity.body === undefined ? 'Invented text that names no one.' : activity.body,
        activity.ownerUserId ?? null,
        activity.contactId ?? null,
        activity.accountId ?? null,
        activity.dealId ?? null,
        activity.createdByUserId === undefined ? USER_A_SUPERVISOR : activity.createdByUserId,
        activity.dueAt ?? null,
        activity.createdAt ?? null,
      ],
    );
  }

  interface PlantedEvent {
    id?: string;
    objectType?: 'deal' | 'contact' | 'account' | 'activity';
    objectId: string;
    tenantId?: string;
    programmeId?: string;
    occurredAt: string;
    actorUserId: string | null;
    action?: 'created' | 'updated';
    changes: Change[];
  }

  /** One audit event, as T-0108 (or a system writer) would have written it. */
  async function plantEvent(event: PlantedEvent): Promise<string> {
    const id = event.id ?? randomUUID();
    await observer.query(
      `INSERT INTO audit_event (id, tenant_id, occurred_at, actor_kind, actor_user_id, action,
                                object_type, object_id, object_label, programme_id, changes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        id,
        event.tenantId ?? TENANT_A,
        event.occurredAt,
        event.actorUserId === null ? 'system' : 'user',
        event.actorUserId,
        event.action ?? 'updated',
        event.objectType ?? 'deal',
        event.objectId,
        event.objectId,
        event.programmeId ?? PROGRAMME_A1,
        JSON.stringify(event.changes),
      ],
    );
    return id;
  }

  async function assign(userId: string, programmeId: string, key: string, tenantId = TENANT_A) {
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id) DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, tenantId, permissionSet(tenantId, key)],
    );
  }

  async function setTenantAdmin(userId: string, value: boolean) {
    await observer.query('UPDATE "user" SET is_tenant_admin = $1 WHERE id = $2', [value, userId]);
  }

  /** One field-security decision in tenant A, against a STANDARD field_def (never planted). */
  async function lockField(
    objectApiName: 'activity' | 'deal',
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
        `tenant A has no standard field_def ${objectApiName}.${field}` +
          (field === 'deal_id' ? ' (T-0111 adds activity.deal_id, R5)' : ' (fixture drift)'),
      );
    }
    await observer.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [TENANT_A, fieldId, permissionSet(TENANT_A, setKey), level],
    );
  }

  /** A task linked to DEAL_A1 on Amaka, logged a week ago by the supervisor. */
  async function plantLinkedTask(id: string, extra: Partial<PlantedActivity> = {}) {
    await plantActivity({
      id,
      type: 'task',
      subject: `T0111 linked task ${RUN}`,
      contactId: AMAKA.id,
      dealId: DEAL_A1,
      dueAt: '2031-12-01T09:00:00.000Z',
      createdAt: iso(Date.now() - 7 * DAY),
      ...extra,
    });
  }

  interface Mixed {
    eventIds: string[];
    activityIds: string[];
    visibleToAgent: number;
    stageIds: string[];
  }

  /**
   * A history on DEAL_A1 interleaving both sources. Newest first: 4 withheld
   * events, then 8 x (visible event, withheld event, activity, withheld event),
   * then 3 withheld events. Withheld means `amount` or `nextStep` (locked for
   * the agent set by the tests that need it); visible is `expectedCloseDate`,
   * and every other visible event also carries a withheld `amount` rider.
   * Activities alternate a contact (Amaka) and an account (Ikoyi) target and
   * are owned by agent 1, whose id is never on an item, so never in a cursor.
   */
  async function plantMixedHistory(): Promise<Mixed> {
    const stages = await stagesOf(PROGRAMME_A1);
    const kinds: ('V' | 'W' | 'A')[] = [
      ...Array<'W'>(4).fill('W'),
      ...Array.from({ length: 8 }, () => ['V', 'W', 'A', 'W'] as const).flat(),
      ...Array<'W'>(3).fill('W'),
    ];
    const base = Date.parse('2026-03-01T00:00:00.000Z');
    const mixed: Mixed = {
      eventIds: [],
      activityIds: [],
      visibleToAgent: 0,
      stageIds: [stages.firstOpen, stages.secondOpen],
    };
    let visible = 0;
    let withheld = 0;
    for (const [position, kind] of kinds.entries()) {
      const at = iso(base + (kinds.length - position) * 60_000);
      const tail = String(position).padStart(4, '0');
      if (kind === 'A') {
        const id = id111(`a1${tail}`);
        await plantActivity({
          id,
          subject: `T0111 history note ${position}`,
          contactId: position % 8 === 2 ? AMAKA.id : null,
          accountId: position % 8 === 2 ? null : IKOYI.id,
          dealId: DEAL_A1,
          ownerUserId: USER_A_AGENT_1,
          createdAt: at,
        });
        mixed.activityIds.push(id);
        mixed.visibleToAgent += 1;
        continue;
      }
      const changes: Change[] = [];
      if (kind === 'V') {
        changes.push(named('expectedCloseDate'));
        if (visible % 2 === 0) changes.push(named('amount'));
        visible += 1;
        mixed.visibleToAgent += 1;
      } else {
        changes.push(named(withheld % 2 === 0 ? 'amount' : 'nextStep'));
        withheld += 1;
      }
      mixed.eventIds.push(
        await plantEvent({
          id: id111(`e1${tail}`),
          objectId: DEAL_A1,
          occurredAt: at,
          actorUserId: USER_A_SUPERVISOR,
          changes,
        }),
      );
    }
    return mixed;
  }

  // =========================================================================
  // 0. The contract (records.openapi.yaml, committed with this file).
  // =========================================================================

  describe('the contract (records.openapi.yaml)', () => {
    it('(self-check) the page checker accepts the example and rejects broken copies of it', () => {
      const example = exampleOf('listDealTimeline', '200') as Page;
      expect(dealPageProblems(example, 'example')).toEqual([]);
      expect(orderProblems(example.data, true)).toEqual([]);
      const field = example.data.find((item) => item.type === 'field_changed') ?? {};
      const activity = example.data.find((item) => item.type === 'activity') ?? {};
      expect(Object.keys(field).length * Object.keys(activity).length, 'example items').toBeGreaterThan(0);
      const one = (item: Json): Page => ({ data: [item], nextCursor: null });
      const mutants: [string, unknown][] = [
        ['a total', { ...example, total: 3 }],
        ['a stage change with stage ids', one({ ...field, field: 'stageId', before: NOWHERE, after: NOWHERE })],
        ['an owner change with ids', one({ ...field, field: 'ownerUserId', before: null, after: NOWHERE })],
        ['a name change with values', one({ ...field, field: 'name', before: 'a', after: 'b' })],
        ['a change not marked redacted', one(withoutKey(field, 'redacted'))],
        ['stageEnteredAt', one({ ...field, field: 'stageEnteredAt' })],
        ['closedAt', one({ ...field, field: 'closedAt' })],
        ['an account-only field', one({ ...field, field: 'tier' })],
        ['a contact-only field', one({ ...field, field: 'phones' })],
        ['a server-owned field', one({ ...field, field: 'version' })],
        ['a consent item', one({ ...withoutKey(withoutKey(field, 'field'), 'redacted'), type: 'consent_changed' })],
        ['an activity without a version', one(withoutKey(activity, 'version'))],
        ['an activity carrying its deal', one({ ...activity, dealId: NOWHERE })],
        ['an activity carrying its owner', one({ ...activity, ownerUserId: USER_A_AGENT_1 })],
        ['an unknown item type', one({ ...field, type: 'whatsapp_message' })],
        ['an actor with an email', one({ ...activity, actor: { id: NOWHERE, displayName: 'x', email: 'a@b.c' } })],
      ];
      for (const [label, mutant] of mutants) {
        expect(dealPageProblems(mutant, label).length, `the checker accepted ${label}`).toBeGreaterThan(0);
      }
      const tied = example.data.filter((item) => item.occurredAt === example.data[0]?.occurredAt);
      expect(tied.length, 'the example shows a tie').toBeGreaterThan(1);
      expect(orderProblems([...tied].reverse(), true).length, 'an ascending tie').toBeGreaterThan(0);
    });

    it('(self-check) the Activity checker demands dealId present or withheld, never both or neither', () => {
      const base: Json = {
        id: NOWHERE,
        programmeId: PROGRAMME_A1,
        type: 'note',
        subject: null,
        body: null,
        dueAt: null,
        completedAt: null,
        startsAt: null,
        endsAt: null,
        ownerUserId: null,
        contactId: AMAKA.id,
        accountId: null,
        createdByUserId: USER_A_AGENT_1,
        version: 1,
        createdAt: '2026-10-01T09:00:00.000Z',
        updatedAt: '2026-10-01T09:00:00.000Z',
        withheldFields: [],
      };
      expect(activityProblems('createActivity', 201, { ...base, dealId: DEAL_A1 }, 'linked')).toEqual([]);
      expect(activityProblems('createActivity', 201, { ...base, dealId: null }, 'unlinked')).toEqual([]);
      expect(
        activityProblems('createActivity', 201, { ...base, withheldFields: ['dealId'] }, 'withheld'),
      ).toEqual([]);
      for (const [label, value] of [
        ['neither', base],
        ['both', { ...base, dealId: null, withheldFields: ['dealId'] }],
        ['upper case', { ...base, dealId: DEAL_A1.toUpperCase() }],
        ['not a uuid', { ...base, dealId: 'deal-1' }],
      ] as const) {
        expect(activityProblems('createActivity', 201, value, label).length, label).toBeGreaterThan(0);
      }
    });

    it('(contract) listDealTimeline: GET /api/v1/deals/{dealId}/timeline, a deals read on P06 frames, cursor and limit, 200/400/401/404', () => {
      const { method, path, op, pathItem } = requireOperation('listDealTimeline');
      expect([method, path]).toEqual(['get', `${DEALS}/{dealId}/timeline`]);
      expect(op.tags).toEqual(['deals']);
      const screens = (op['x-kasuwa-screens'] ?? []) as string[];
      expect(screens).toContain('P06/05');
      expect(screens.filter((screen) => !/^P06\/\d{2}[a-z]?$/.test(screen))).toEqual([]);
      expect(Object.keys((op.responses ?? {}) as Json).sort()).toEqual(['200', '400', '401', '404']);
      expect(op['x-kasuwa-error-order']).toEqual(['404 not_found', '400 validation_failed']);
      expect(op['x-kasuwa-rights']).toEqual({
        admin: 'read',
        programme_manager: 'read',
        team_lead: 'read',
        agent: 'read',
        qa_analyst: 'read',
        client_portal: 'none',
      });
      const params = [...((pathItem.parameters ?? []) as Json[]), ...((op.parameters ?? []) as Json[])].map(
        (parameter) => deref(parameter, SPEC_PATH).schema,
      );
      expect(params.map((parameter) => `${String(parameter.in)}:${String(parameter.name)}`).sort()).toEqual([
        'path:dealId',
        'query:cursor',
        'query:limit',
      ]);
      // getDeal's one 404 (R12): the same response object, by reference.
      const notFound = ((op.responses ?? {}) as Json)['404'] as Json;
      const getDeal404 = ((requireOperation('getDeal').op.responses ?? {}) as Json)['404'] as Json;
      expect(notFound.$ref).toBe(getDeal404.$ref);
      const page = deref(responseSchemaOf('listDealTimeline', '200'), SPEC_PATH).schema;
      expect(page.additionalProperties, 'the page is closed').toBe(false);
      expect(Object.keys((page.properties ?? {}) as Json).sort()).toEqual(['data', 'nextCursor']);
      expect(op.requestBody, 'a GET takes no body').toBeUndefined();
    });

    it('(contract) the item union is a deal field change or the very ActivityItem of the other timelines (R11)', () => {
      const dealActivity = branchOf(responseSchemaOf('listDealTimeline', '200'), 'activity');
      const contactActivity = branchOf(schemaAt('TimelinePage'), 'activity');
      const accountActivity = branchOf(responseSchemaOf('listAccountTimeline', '200'), 'activity');
      expect(dealActivity, 'the deal timeline forks the activity item').toBe(contactActivity);
      expect(accountActivity).toBe(contactActivity);
      expect(Object.keys((dealActivity.properties ?? {}) as Json)).not.toContain('dealId');
      const fieldItem = branchOf(responseSchemaOf('listDealTimeline', '200'), 'field_changed');
      expect(fieldItem.additionalProperties).toBe(false);
      expect(((fieldItem.properties as Json).field as Json).enum).toEqual(DEAL_TIMELINE_FIELDS);
      const base = { id: 'ti_t0111', type: 'field_changed', occurredAt: '2026-10-01T09:12:00.000Z', actor: null };
      const schema = responseSchemaOf('listDealTimeline', '200');
      const page = (item: Json): Page => ({ data: [item], nextCursor: null });
      for (const field of DEAL_TIMELINE_FIELDS) {
        expect(schemaErrors(schema, page({ ...base, field, redacted: true }), field)).toEqual([]);
        for (const values of [{ before: NOWHERE, after: NOWHERE }, { before: null, after: 'b' }]) {
          expect(
            schemaErrors(schema, page({ ...base, field, redacted: true, ...values }), field).length,
            `${field} with values is expressible`,
          ).toBeGreaterThan(0);
        }
      }
    });

    it('(contract) dealId: an optional nullable uuid on Activity, CreateActivityRequest and UpdateActivityRequest; withholdable; both bodies stay closed', () => {
      for (const schema of ['Activity', 'CreateActivityRequest', 'UpdateActivityRequest']) {
        const property = rawSchemaProperty(schema, 'dealId');
        expect(property, `${schema}.dealId`).toBeDefined();
        expect(typesOf(property).sort(), `${schema}.dealId types`).toEqual(['null', 'string']);
        expect(property?.format, `${schema}.dealId format`).toBe('uuid');
        const node = deref(schemaAt(schema), SPEC_PATH).schema;
        expect((node.required ?? []) as string[], `${schema}: dealId is optional`).not.toContain('dealId');
      }
      for (const body of ['CreateActivityRequest', 'UpdateActivityRequest']) {
        expect(deref(schemaAt(body), SPEC_PATH).schema.additionalProperties, `${body} is closed`).toBe(false);
      }
      const update = Object.keys((deref(schemaAt('UpdateActivityRequest'), SPEC_PATH).schema.properties ?? {}) as Json);
      expect(update, 'R4: the update still never retargets').not.toContain('contactId');
      expect(update).not.toContain('accountId');
      expect(update).not.toContain('programmeId');
      const withheld = rawSchemaProperty('Activity', 'withheldFields');
      expect(((withheld?.items as Json | undefined)?.enum ?? []) as string[]).toContain('dealId');
    });

    it('listDealTimeline and every dealId property are x-kasuwa-implemented: true (the build flips them)', () => {
      const problems: string[] = [];
      if (requireOperation('listDealTimeline').op['x-kasuwa-implemented'] !== true) {
        problems.push('listDealTimeline is not x-kasuwa-implemented: true');
      }
      for (const id of ['createActivity', 'updateActivity']) {
        if (requireOperation(id).op['x-kasuwa-implemented'] !== true) problems.push(`${id} is not served`);
      }
      for (const schema of ['Activity', 'CreateActivityRequest', 'UpdateActivityRequest']) {
        const raw = rawSchemaProperty(schema, 'dealId');
        if (raw === undefined) problems.push(`${schema}.dealId is missing`);
        else if (raw['x-kasuwa-implemented'] !== true) {
          problems.push(`${schema}.dealId is not x-kasuwa-implemented: true`);
        }
      }
      expect(problems).toEqual([]);
    });
  });

  // =========================================================================
  // 1. Migration 0037 (as kasuwa_migrator, kasuwa_app and kasuwa_test_admin).
  // =========================================================================

  describe('migration 0037: activity.deal_id', () => {
    beforeEach(async () => {
      await plantDeals();
    });

    it('(self-check) the migration scan finds an ADD COLUMN deal_id on activity and nothing else', () => {
      for (const yes of [
        'ALTER TABLE activity ADD COLUMN deal_id uuid;',
        'alter table only public.activity\n  add column if not exists deal_id uuid null;',
        'ALTER TABLE activity ADD deal_id uuid, ADD CONSTRAINT x FOREIGN KEY (deal_id) REFERENCES deal;',
      ]) {
        expect(ADDS_DEAL_ID.test(stripComments(yes)), yes).toBe(true);
      }
      for (const no of [
        'ALTER TABLE activity_log ADD COLUMN deal_id uuid;',
        'ALTER TABLE deal ADD COLUMN deal_id_x uuid;',
        '-- ALTER TABLE activity ADD COLUMN deal_id uuid;\nSELECT 1;',
        '/* ALTER TABLE activity ADD COLUMN deal_id uuid; */',
        'ALTER TABLE activity ADD COLUMN deal_idx uuid;',
      ]) {
        expect(ADDS_DEAL_ID.test(stripComments(no)), no).toBe(false);
      }
    });

    it('exactly one migration adds the column, it is 0037 and applied; 0027, 0034 and 0036 are unedited; still two SECURITY DEFINERs', async () => {
      const files = dealIdMigrationFiles();
      expect(files, 'no single migration adds activity.deal_id').toHaveLength(1);
      expect(files[0] ?? '', 'R14: the hook reserves 0037 for T-0111').toMatch(/^0037_[a-z0-9_]+\.sql$/);
      const ids = files.map((name) => name.replace(/\.sql$/, ''));
      const applied = await observer.query<{ id: string }>(
        'SELECT id FROM _kasuwa_migration WHERE id = ANY ($1::text[])',
        [ids],
      );
      expect(applied.rows.map((row) => row.id)).toEqual(ids);
      const current = new Map(loadMigrations().map((row) => [row.id, row.checksum]));
      for (const [id, checksum] of Object.entries(PINNED_CHECKSUMS)) {
        expect(current.get(id), `${id} was edited, renamed or removed`).toBe(checksum);
      }
      const definers = await observer.query<{ name: string }>(
        `SELECT n.nspname || '.' || p.proname AS name FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`,
      );
      expect(definers.rows.map((row) => row.name)).toEqual(['app.resolve_session', 'app.resolve_tenant_by_slug']);
    });

    it('deal_id is a nullable uuid with no default, and every existing activity is NULL', async () => {
      const column = await observer.query<{ type: string; notnull: boolean; default: string | null }>(
        `SELECT format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
                pg_get_expr(d.adbin, d.adrelid) AS default
           FROM pg_attribute a
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = to_regclass('public.activity') AND a.attname = 'deal_id' AND NOT a.attisdropped`,
      );
      expect(column.rows, 'activity has no deal_id column').toEqual([{ type: 'uuid', notnull: false, default: null }]);
      // The seeded rows predate any link; a regression guard on the seed and
      // the backfill alike (a DEFAULT or an UPDATE would show here).
      const seeded = await observer.query<{ id: string; deal_id: string | null }>(
        'SELECT id, deal_id FROM activity WHERE id = ANY ($1::uuid[]) ORDER BY id',
        [SEED_ACTIVITIES.map((activity) => activity.id)],
      );
      expect(seeded.rows).toHaveLength(SEED_ACTIVITIES.length);
      expect(seeded.rows.filter((row) => row.deal_id !== null)).toEqual([]);
    });

    it('one foreign key to deal through (tenant_id, programme_id, deal_id), RESTRICT on update and delete', async () => {
      const fks = await observer.query<{ pairs: string[]; upd: string; del: string }>(
        `SELECT array_agg(la.attname || '->' || fa.attname ORDER BY la.attname) AS pairs,
                con.confupdtype AS upd, con.confdeltype AS del
           FROM pg_constraint con
           CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(local_att, foreign_att)
           JOIN pg_attribute la ON la.attrelid = con.conrelid AND la.attnum = k.local_att
           JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.foreign_att
          WHERE con.contype = 'f' AND con.conrelid = to_regclass('public.activity')
            AND con.confrelid = to_regclass('public.deal')
          GROUP BY con.oid, con.confupdtype, con.confdeltype`,
      );
      // 'r' is RESTRICT; NO ACTION ('a') accepts a one-statement rotation (D-L76).
      expect(fks.rows).toEqual([
        { pairs: ['deal_id->id', 'programme_id->programme_id', 'tenant_id->tenant_id'], upd: 'r', del: 'r' },
      ]);
    });

    it('as kasuwa_app, a link to another programme’s deal, another tenant’s or none fails one key with one message, even for the supervisor who reads both programmes', async () => {
      const ACT = id111('a0101');
      await plantActivity({ id: ACT, accountId: IKOYI.id });
      const outcomes = await rolledBackTenantTx(appPool, TENANT_A, USER_A_SUPERVISOR, async (query) => {
        const insert = (dealId: string) =>
          probe(
            query,
            `INSERT INTO activity (id, tenant_id, programme_id, type, account_id, deal_id, created_by_user_id)
             VALUES ($1, $2, $3, 'note', $4, $5, $6)`,
            [randomUUID(), TENANT_A, PROGRAMME_A1, IKOYI.id, dealId, USER_A_SUPERVISOR],
          );
        const update = (dealId: string) =>
          probe(query, 'UPDATE activity SET deal_id = $1 WHERE id = $2', [dealId, ACT]);
        return {
          insertOwn: await insert(DEAL_A1),
          insertA2: await insert(DEAL_A2),
          insertB1: await insert(DEAL_B1),
          insertNowhere: await insert(NOWHERE),
          updateOwn: await update(DEAL_A1_OTHER),
          updateA2: await update(DEAL_A2),
          updateB1: await update(DEAL_B1),
          updateNowhere: await update(NOWHERE),
          // The control the refusals are judged against: the A2 deal is visible to this session.
          seesA2: (await query<{ id: string }>('SELECT id FROM deal WHERE id = $1', [DEAL_A2])).length,
        };
      });
      expect(verdict(outcomes.insertOwn), 'a link to a deal of its own programme').toBe('accepted');
      expect(verdict(outcomes.updateOwn), 'kasuwa_app may move the link (column UPDATE, R17)').toBe('accepted');
      expect(outcomes.seesA2, 'control: the supervisor reads the A2 deal').toBe(1);
      const refused = [outcomes.insertA2, outcomes.insertB1, outcomes.insertNowhere];
      const refusedUpdates = [outcomes.updateA2, outcomes.updateB1, outcomes.updateNowhere];
      for (const outcome of [...refused, ...refusedUpdates]) {
        expect(verdict(outcome)).toBe('foreign_key_violation');
      }
      const shape = (outcome: Outcome) =>
        outcome.accepted ? 'accepted' : `${outcome.code} ${outcome.constraint} ${outcome.message}`;
      expect(new Set(refused.map(shape)).size, 'a real deal elsewhere and none differ (insert)').toBe(1);
      expect(new Set(refusedUpdates.map(shape)).size, 'a real deal elsewhere and none differ (update)').toBe(1);
    });

    it('as kasuwa_app under RLS, an A1 session sees no activity linked to an A2 or tenant B deal', async () => {
      await plantActivity({ id: id111('a0102'), accountId: IKOYI.id, dealId: DEAL_A1 });
      await plantActivity({
        id: id111('a0103'),
        programmeId: PROGRAMME_A2,
        contactId: DAMILOLA.id,
        dealId: DEAL_A2,
      });
      await plantActivity({
        id: id111('a0104'),
        tenantId: TENANT_B,
        programmeId: PROGRAMME_B1,
        accountId: WESTLANDS.id,
        dealId: DEAL_B1,
        createdByUserId: USER_B_AGENT_1,
      });
      const all = [DEAL_A1, DEAL_A2, DEAL_B1];
      const seen = await rolledBackTenantTx(appPool, TENANT_A, USER_A_AGENT_1, (query) =>
        query<{ id: string }>('SELECT id FROM activity WHERE deal_id = ANY ($1::uuid[]) ORDER BY id', [all]),
      );
      expect(seen.map((row) => row.id)).toEqual([id111('a0102')]);
      const truth = await observer.query('SELECT id FROM activity WHERE deal_id = ANY ($1::uuid[])', [all]);
      expect(truth.rows, 'control: all three links exist').toHaveLength(3);
    });

    it('the grant: kasuwa_app inserts and updates deal_id, never the keys, creator or creation time', async () => {
      const result = await observer.query<{ column: string; writable: boolean }>(
        `SELECT c AS column, has_column_privilege('kasuwa_app', 'public.activity', c, 'UPDATE') AS writable
           FROM unnest(ARRAY['deal_id', 'id', 'tenant_id', 'programme_id', 'created_by_user_id', 'created_at']) AS c
          ORDER BY 1`,
      );
      expect(Object.fromEntries(result.rows.map((row) => [row.column, row.writable]))).toEqual({
        created_at: false,
        created_by_user_id: false,
        deal_id: true,
        id: false,
        programme_id: false,
        tenant_id: false,
      });
      const insert = await observer.query<{ insert: boolean }>(
        `SELECT has_column_privilege('kasuwa_app', 'public.activity', 'deal_id', 'INSERT') AS insert`,
      );
      expect(insert.rows[0]?.insert).toBe(true);
    });

    it('the D-L76 key guard is unchanged: kasuwa_app and kasuwa_test_admin set deal_id, neither re-keys an activity', async () => {
      const ACT = id111('a0105');
      await plantActivity({ id: ACT, accountId: IKOYI.id, dealId: DEAL_A1 });
      const asApp = await rolledBackTenantTx(appPool, TENANT_A, USER_A_SUPERVISOR, async (query) => ({
        link: await probe(query, 'UPDATE activity SET deal_id = $1 WHERE id = $2', [DEAL_A1_OTHER, ACT]),
        unlink: await probe(query, 'UPDATE activity SET deal_id = NULL WHERE id = $1', [ACT]),
        programme: await probe(query, 'UPDATE activity SET programme_id = $1 WHERE id = $2', [PROGRAMME_A2, ACT]),
        id: await probe(query, 'UPDATE activity SET id = $1 WHERE id = $2', [randomUUID(), ACT]),
      }));
      expect(verdict(asApp.link)).toBe('accepted');
      expect(verdict(asApp.unlink)).toBe('accepted');
      expect(REFUSALS).toContain(verdict(asApp.programme));
      expect(REFUSALS).toContain(verdict(asApp.id));
      const asAdmin = await rolledBackTx(testAdmin, async (query) => ({
        link: await probe(query, 'UPDATE activity SET deal_id = $1 WHERE id = $2', [DEAL_A1_OTHER, ACT]),
        tenant: await probe(query, 'UPDATE activity SET tenant_id = $1 WHERE id = $2', [TENANT_B, ACT]),
        id: await probe(query, 'UPDATE activity SET id = $1 WHERE id = $2', [randomUUID(), ACT]),
      }));
      expect(verdict(asAdmin.link), 'kasuwa_test_admin may set the link').toBe('accepted');
      expect(verdict(asAdmin.tenant), 'the allow-list still binds kasuwa_test_admin').toBe('insufficient_privilege');
      expect(verdict(asAdmin.id)).toBe('insufficient_privilege');
    });

    it('(self-check) the rotation probe really rotates: under NO ACTION it silently re-points the child', async () => {
      // Throwaway tables in a transaction that always rolls back: the migrator
      // may create tables (it runs the migrations) but not TEMP ones.
      const result = await rolledBackTx(observer, async (query) => {
        await query('CREATE TABLE t0111_parent (id uuid PRIMARY KEY, name text)');
        await query(
          `CREATE TABLE t0111_child (parent_id uuid REFERENCES t0111_parent (id)
             ON UPDATE NO ACTION ON DELETE NO ACTION)`,
        );
        await query(`INSERT INTO t0111_parent VALUES ($1, 'x'), ($2, 'y')`, [DEAL_A1, DEAL_A1_OTHER]);
        await query('INSERT INTO t0111_child VALUES ($1)', [DEAL_A1]);
        await query(ROTATE_SQL('t0111_parent'), [DEAL_A1, DEAL_A1_OTHER, randomUUID()]);
        return query<{ name: string }>(
          'SELECT p.name FROM t0111_child c JOIN t0111_parent p ON p.id = c.parent_id',
        );
      });
      expect(result, 'the child now points at the other row').toEqual([{ name: 'y' }]);
    });

    it('RESTRICT: a deal with a linked activity cannot be deleted or have its id rotated, even by the migrator; one without can', async () => {
      const ACT = id111('a0106');
      await plantActivity({ id: ACT, accountId: IKOYI.id, dealId: DEAL_A1 });
      const outcomes = await rolledBackTx(observer, async (query) => ({
        deleteLinked: await probe(query, 'DELETE FROM deal WHERE id = $1', [DEAL_A1]),
        deleteUnlinked: await probe(query, 'DELETE FROM deal WHERE id = $1', [DEAL_A1_WON]),
        rotate: await probe(query, ROTATE_SQL('deal'), [DEAL_A1, DEAL_A1_OTHER, randomUUID()]),
        after: await query<{ name: string }>(
          'SELECT d.name FROM activity a JOIN deal d ON d.id = a.deal_id WHERE a.id = $1',
          [ACT],
        ),
      }));
      expect(verdict(outcomes.deleteUnlinked), 'control: a deal without activities deletes').toBe('accepted');
      expect(verdict(outcomes.deleteLinked)).toBe('foreign_key_violation');
      expect(REFUSALS, `rotation: ${verdict(outcomes.rotate)}`).toContain(verdict(outcomes.rotate));
      expect(outcomes.after, 'the activity still points at its own deal').toEqual([{ name: DEAL_NAMES[DEAL_A1] }]);
    });

    it('offboarding still cascades: the migrator deletes a programme and a tenant holding linked activities', async () => {
      await plantActivity({
        id: id111('a0107'),
        programmeId: PROGRAMME_A2,
        contactId: DAMILOLA.id,
        accountId: SABON.id,
        dealId: DEAL_A2,
      });
      await plantActivity({
        id: id111('a0108'),
        tenantId: TENANT_B,
        programmeId: PROGRAMME_B1,
        contactId: GRACE.id,
        dealId: DEAL_B1,
        createdByUserId: USER_B_AGENT_1,
      });
      const outcomes = await rolledBackTx(observer, async (query) => ({
        programme: await probe(query, 'DELETE FROM programme WHERE id = $1', [PROGRAMME_A2]),
        tenant: await probe(query, 'DELETE FROM tenant WHERE id = $1', [TENANT_B]),
      }));
      expect(verdict(outcomes.programme)).toBe('accepted');
      expect(verdict(outcomes.tenant)).toBe('accepted');
    });

    it('RLS is still ENABLED and FORCED, a policy’s WITH CHECK is its USING, deletes stay refused, and activity is tenant-scoped', async () => {
      const flags = await observer.query<{ enabled: boolean; forced: boolean }>(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class
          WHERE oid = to_regclass('public.activity')`,
      );
      expect(flags.rows).toEqual([{ enabled: true, forced: true }]);
      const policies = await observer.query<{ name: string; permissive: string; cmd: string; qual: string | null; check: string | null }>(
        `SELECT policyname AS name, permissive, cmd, qual, with_check AS check
           FROM pg_policies WHERE schemaname = 'public' AND tablename = 'activity'`,
      );
      const permissive = policies.rows.filter((row) => row.permissive === 'PERMISSIVE');
      expect(
        permissive.some((row) => row.cmd === 'ALL' && row.qual !== null && row.qual === row.check),
        `no permissive FOR ALL policy with WITH CHECK = USING: ${JSON.stringify(policies.rows)}`,
      ).toBe(true);
      for (const row of permissive) {
        expect(row.qual ?? '', row.name).toMatch(/current_tenant_id/);
        expect(row.qual ?? '', row.name).toMatch(/current_programme_ids/);
      }
      expect(
        policies.rows.some((row) => row.permissive === 'RESTRICTIVE' && row.cmd === 'DELETE'),
        'activity_no_delete (D-L79) is gone',
      ).toBe(true);
      expect([...TENANT_SCOPED_TABLES]).toContain('activity');
      // The behavioural half, through the new column: nothing reads it unscoped.
      const ACT = id111('a0109');
      await plantActivity({ id: ACT, accountId: IKOYI.id, dealId: DEAL_A1 });
      const fromA2 = await rolledBackTenantTx(appPool, TENANT_A, USER_A_AGENT_2, (query) =>
        query<{ id: string }>('SELECT id FROM activity WHERE deal_id = $1', [DEAL_A1]),
      );
      expect(fromA2, 'an A2 session reads an A1 activity through its deal link').toEqual([]);
    });

    it('an index serves one deal’s activities newest first (R15): its keys and its use as kasuwa_app, with no Sort', async () => {
      const indexes = await observer.query<{ name: string; valid: boolean; predicate: string | null; keys: string[] }>(
        `SELECT i.relname AS name, x.indisvalid AS valid, pg_get_expr(x.indpred, x.indrelid) AS predicate,
                ARRAY(SELECT pg_get_indexdef(x.indexrelid, k, true)
                        FROM generate_series(1, x.indnkeyatts) AS k ORDER BY k) AS keys
           FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
          WHERE x.indrelid = to_regclass('public.activity')`,
      );
      const direction = (key: string | undefined, column: string) =>
        new RegExp(`^${column}( DESC)?$`).exec(key ?? '')?.[1] ?? null;
      const serving = indexes.rows.filter(
        (index) =>
          index.valid &&
          (index.predicate === null || /^\(?deal_id IS NOT NULL\)?$/.test(index.predicate)) &&
          index.keys[0] === 'tenant_id' &&
          index.keys[1] === 'programme_id' &&
          index.keys[2] === 'deal_id' &&
          /^created_at( DESC)?$/.test(index.keys[3] ?? '') &&
          /^id( DESC)?$/.test(index.keys[4] ?? '') &&
          direction(index.keys[3], 'created_at') === direction(index.keys[4], 'id'),
      );
      expect(serving.length, `activity indexes: ${JSON.stringify(indexes.rows)}`).toBeGreaterThan(0);

      // 20,000 activities in A1: 50 on DEAL_A1, about 2,900 on DEAL_A1_OTHER, the rest unlinked.
      await observer.query(
        `INSERT INTO activity (id, tenant_id, programme_id, type, subject, account_id, deal_id, created_at)
         SELECT gen_random_uuid(), $1, $2, 'note', 'T0111 bulk', $3,
                CASE WHEN g % 400 = 0 THEN $4::uuid WHEN g % 7 = 0 THEN $5::uuid ELSE NULL END,
                timestamptz '2026-01-01' + g * interval '1 minute'
           FROM generate_series(1, 20000) AS g`,
        [TENANT_A, PROGRAMME_A1, IKOYI.id, DEAL_A1, DEAL_A1_OTHER],
      );
      await observer.query('ANALYZE activity');
      const PAGE = `SELECT id, created_at FROM activity
                     WHERE tenant_id = $1 AND programme_id = $2 AND deal_id = $3
                     ORDER BY created_at DESC, id DESC LIMIT 26`;
      const NEXT = `SELECT id, created_at FROM activity
                     WHERE tenant_id = $1 AND programme_id = $2 AND deal_id = $3
                       AND (created_at, id) < ($4::timestamptz, $5::uuid)
                     ORDER BY created_at DESC, id DESC LIMIT 26`;
      const middle = await observer.query<{ id: string; created_at: Date }>(
        `SELECT id, created_at FROM activity WHERE deal_id = $1 ORDER BY created_at DESC, id DESC OFFSET 20 LIMIT 1`,
        [DEAL_A1],
      );
      const cursorRow = must(middle.rows[0], 'the planted page');
      for (const userId of [USER_A_AGENT_1, USER_A_SUPERVISOR]) {
        for (const [label, sql, values] of [
          ['first page', PAGE, [TENANT_A, PROGRAMME_A1, DEAL_A1]],
          ['continuation', NEXT, [TENANT_A, PROGRAMME_A1, DEAL_A1, cursorRow.created_at, cursorRow.id]],
        ] as const) {
          const plan = await rolledBackTenantTx(appPool, TENANT_A, userId, (query) =>
            query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, [...values]),
          );
          const root = must(plan[0]?.['QUERY PLAN'][0]?.Plan, 'EXPLAIN returned no plan');
          expect(planProblems(root, 200), `${label} as ${userId}`).toEqual([]);
        }
      }
    }, 120_000);

    it('every tenant’s standard activity catalogue gains deal_id, a lookup to deal, classified none; a fresh tenant gets it too', async () => {
      const FIELD_SQL = `SELECT f.type, f.config::text AS config, f.classification, f.is_required, f.is_custom
                           FROM field_def f JOIN object_def o ON o.id = f.object_id AND o.tenant_id = f.tenant_id
                          WHERE f.tenant_id = $1 AND o.api_name = 'activity' AND NOT o.is_custom
                            AND f.api_name = 'deal_id'`;
      const expectField = (rows: { type: string; config: string; classification: string; is_required: boolean; is_custom: boolean }[], where: string) => {
        expect(rows, `${where}: no standard activity.deal_id field_def`).toHaveLength(1);
        const row = must(rows[0], where);
        expect({ ...row, config: JSON.parse(row.config) as unknown }).toEqual({
          type: 'lookup',
          config: { targetObjectApiName: 'deal' },
          classification: 'none',
          is_required: false,
          is_custom: false,
        });
      };
      for (const tenant of SEED_TENANTS) {
        expectField((await observer.query(FIELD_SQL, [tenant.id])).rows, tenant.slug);
      }
      const fresh = await rolledBackTx(observer, async (query) => {
        const tenantId = randomUUID();
        await query(`INSERT INTO tenant (id, name, slug) VALUES ($1, 'T-0111 Fresh Ltd', $2)`, [
          tenantId,
          `t0111-fresh-${RUN}`,
        ]);
        await ensureStandardObjectDefs((text, values) => query(text, [...values]), tenantId);
        return query<{ type: string; config: string; classification: string; is_required: boolean; is_custom: boolean }>(
          FIELD_SQL,
          [tenantId],
        );
      });
      expectField(fresh, 'a fresh tenant');
    });
  });

  // =========================================================================
  // 2. Writing the link: createActivity and updateActivity with dealId.
  // =========================================================================

  describe('createActivity and updateActivity with dealId', () => {
    beforeEach(async () => {
      await plantDeals();
    });

    it('an agent logs a note on a contact linked to a deal of its programme: 201, the link stored, audited by name, the deal untouched', async () => {
      const dealBefore = await dealRow(DEAL_A1);
      const dealEvents = await auditCount('deal');
      const response = await createActivity(AGENT_1, {
        type: 'note',
        subject: `T0111 note ${RUN}`,
        contactId: AMAKA.id,
        dealId: DEAL_A1,
      });
      const activity = expectActivity(response, 'createActivity', 201, 'create');
      expectNoStore(response, 'create');
      expect(activity.dealId).toBe(DEAL_A1);
      expect(activity.withheldFields).toEqual([]);
      const id = String(activity.id);
      expect((await activityRow(id))?.deal_id).toBe(DEAL_A1);
      expect(await dealRow(DEAL_A1), 'R4: the deal row is never written').toEqual(dealBefore);
      expect(await auditCount('deal'), 'R4: no deal audit event').toBe(dealEvents);
      const events = await activityEvents(id);
      expect(events.map((event) => event.action)).toEqual(['created']);
      const event = must(events[0], 'the create event');
      expect(event.changes, 'R6: dealId by name').toContainEqual({
        field: 'dealId',
        before: null,
        after: null,
        redacted: true,
      });
      expect(
        JSON.stringify(event).toLowerCase(),
        'R6: the deal id is nowhere in the event',
      ).not.toContain(DEAL_A1.toLowerCase());
    });

    it('an account-only activity links too; a link may name a colleague’s deal or a won one; the id is served in lower case (R3, R4, R7)', async () => {
      const cases: [string, Headers, Json, string][] = [
        ['account only', AGENT_1, { type: 'task', accountId: IKOYI.id, dealId: DEAL_A1 }, DEAL_A1],
        ['a colleague’s deal', AGENT_1, { type: 'call', contactId: BASHIR.id, dealId: DEAL_A1 }, DEAL_A1],
        ['a won deal', AGENT_1, { type: 'note', contactId: AMAKA.id, dealId: DEAL_A1_WON }, DEAL_A1_WON],
        ['upper case', SUPERVISOR, { type: 'note', accountId: IKOYI.id, dealId: DEAL_A1_OTHER.toUpperCase() }, DEAL_A1_OTHER],
      ];
      for (const [label, headers, body, stored] of cases) {
        const activity = expectActivity(await createActivity(headers, body), 'createActivity', 201, label);
        expect(activity.dealId, label).toBe(stored);
        expect((await activityRow(String(activity.id)))?.deal_id, label).toBe(stored);
      }
      // Without dealId: present, null (R7).
      const plain = expectActivity(
        await createActivity(AGENT_1, { type: 'note', contactId: AMAKA.id }),
        'createActivity',
        201,
        'no link',
      );
      expect(plain.dealId, 'an activity without a link carries dealId: null').toBeNull();
    });

    it('R1: dealId is a link, never a target: a body with only dealId is 400 and writes nothing', async () => {
      expectActivity(
        await createActivity(AGENT_1, { type: 'note', contactId: AMAKA.id, dealId: DEAL_A1 }),
        'createActivity',
        201,
        'control: with a target',
      );
      const before = await activityCount();
      expectError(await createActivity(AGENT_1, { type: 'note', dealId: DEAL_A1 }), 400, 'validation_failed');
      expectError(
        await createActivity(AGENT_1, { type: 'note', contactId: null, accountId: null, dealId: DEAL_A1 }),
        400,
        'validation_failed',
      );
      expectError(
        await createActivity(AGENT_1, { type: 'note', contactId: AMAKA.id, dealId: 'deal-one' }),
        400,
        'validation_failed',
      );
      expect(await activityCount()).toBe(before);
    });

    it('updateActivity sets, moves and clears the link; each change is one event naming dealId; a stale version is 409 and changes nothing', async () => {
      const ACT = id111('a0201');
      await plantActivity({ id: ACT, type: 'task', contactId: AMAKA.id, createdAt: iso(Date.now() - DAY) });
      const dealBefore = await dealRow(DEAL_A1);
      const link = expectActivity(
        await updateActivity(AGENT_1, ACT, { version: 1, dealId: DEAL_A1 }),
        'updateActivity',
        200,
        'link',
      );
      expect(link.dealId).toBe(DEAL_A1);
      expect(link.version).toBe(2);
      const moved = expectActivity(
        await updateActivity(AGENT_1, ACT, { version: 2, dealId: DEAL_A1_OTHER }),
        'updateActivity',
        200,
        'move the link',
      );
      expect(moved.dealId).toBe(DEAL_A1_OTHER);
      const settled = await activityRow(ACT);
      expectError(await updateActivity(AGENT_1, ACT, { version: 2, dealId: DEAL_A1 }), 409, 'stale_write');
      expect(await activityRow(ACT), 'a stale write changes nothing').toEqual(settled);
      const cleared = expectActivity(
        await updateActivity(AGENT_1, ACT, { version: 3, dealId: null }),
        'updateActivity',
        200,
        'unlink',
      );
      expect(cleared.dealId).toBeNull();
      expect((await activityRow(ACT))?.deal_id).toBeNull();
      expect(await dealRow(DEAL_A1), 'R4: the deal row is never written').toEqual(dealBefore);
      const events = await activityEvents(ACT);
      expect(events.map((event) => event.action)).toEqual(['updated', 'updated', 'updated']);
      for (const event of events) {
        expect(event.changes, 'R6: each change names exactly dealId').toEqual([
          { field: 'dealId', before: null, after: null, redacted: true },
        ]);
        expect(event.actor_user_id).toBe(USER_A_AGENT_1);
      }
      const text = JSON.stringify(events).toLowerCase();
      for (const id of [DEAL_A1, DEAL_A1_OTHER]) expect(text).not.toContain(id.toLowerCase());
    });

    it('R4: the update body still never retargets: contactId or accountId beside dealId is 400 and changes nothing', async () => {
      const ACT = id111('a0202');
      await plantActivity({ id: ACT, contactId: AMAKA.id });
      expectActivity(await updateActivity(AGENT_1, ACT, { version: 1, dealId: DEAL_A1 }), 'updateActivity', 200, 'control');
      const settled = await activityRow(ACT);
      for (const extra of [{ contactId: BASHIR.id }, { accountId: IKOYI.id }, { programmeId: PROGRAMME_A1 }, { deal: DEAL_A1 }]) {
        expectError(
          await updateActivity(AGENT_1, ACT, { version: 2, dealId: DEAL_A1_OTHER, ...extra }),
          400,
          'validation_failed',
        );
      }
      expect(await activityRow(ACT)).toEqual(settled);
    });

    it('rights (D-P18): qa_analyst and client_portal are 403 before the deal is judged; the order is 404, 403, 400, 409', async () => {
      const ACT = id111('a0203');
      await plantActivity({ id: ACT, contactId: AMAKA.id });
      const ACT_A2 = id111('a0204');
      await plantActivity({ id: ACT_A2, programmeId: PROGRAMME_A2, contactId: DAMILOLA.id });
      expectActivity(
        await createActivity(AGENT_1, { type: 'note', contactId: AMAKA.id, dealId: DEAL_A1 }),
        'createActivity',
        201,
        'control: the agent links',
      );
      // 404 before 400: an unreachable target or activity, with a bad deal.
      expectError(
        await createActivity(AGENT_1, { type: 'note', contactId: DAMILOLA.id, dealId: DEAL_B1 }),
        404,
        'not_found',
      );
      expectError(await updateActivity(AGENT_1, ACT_A2, { version: 1, dealId: DEAL_B1 }), 404, 'not_found');
      // 400 before 409: a bad deal on a stale version.
      expectUnknownDeal(await updateActivity(AGENT_1, ACT, { version: 9, dealId: DEAL_A2 }), 'stale and bad', []);
      // 403 before 400.
      for (const key of ['qa_analyst', 'client_portal']) {
        await assign(USER_A_AGENT_1, PROGRAMME_A1, key);
        for (const dealId of [DEAL_A1, DEAL_A2]) {
          expectError(
            await createActivity(AGENT_1, { type: 'note', contactId: AMAKA.id, dealId }),
            403,
            'not_permitted',
          );
          expectError(await updateActivity(AGENT_1, ACT, { version: 1, dealId }), 403, 'not_permitted');
        }
      }
      expect((await activityRow(ACT))?.deal_id).toBeNull();
    });

    it('field security (R5): a withheld deal_id is omitted and named; withheld or read-only, sending dealId is 403 field_not_editable before 400', async () => {
      const ACT = id111('a0205');
      await plantActivity({ id: ACT, type: 'task', contactId: AMAKA.id, dealId: DEAL_A1 });
      await lockField('activity', 'deal_id', 'agent', 'none');
      const plain = expectActivity(
        await createActivity(AGENT_1, { type: 'note', contactId: AMAKA.id }),
        'createActivity',
        201,
        'withheld: a create without dealId',
      );
      expect('dealId' in plain).toBe(false);
      expect(plain.withheldFields).toContain('dealId');
      const before = await activityCount();
      for (const dealId of [DEAL_A1, DEAL_A2, null]) {
        expectDealNotEditable(
          await createActivity(AGENT_1, { type: 'note', contactId: AMAKA.id, dealId }),
          `withheld, create ${String(dealId)}`,
        );
        expectDealNotEditable(await updateActivity(AGENT_1, ACT, { version: 1, dealId }), `withheld, update ${String(dealId)}`);
      }
      expect(await activityCount()).toBe(before);
      // An update of another field answers without the link.
      const done = expectActivity(
        await updateActivity(AGENT_1, ACT, { version: 1, ownerUserId: USER_A_AGENT_1 }),
        'updateActivity',
        200,
        'withheld: another field',
      );
      expect('dealId' in done).toBe(false);
      expect((await activityRow(ACT))?.deal_id, 'the link survives an update that cannot see it').toBe(DEAL_A1);

      await lockField('activity', 'deal_id', 'agent', 'read');
      const readable = expectActivity(
        await updateActivity(AGENT_1, ACT, { version: 2, dueAt: '2031-12-02T09:00:00.000Z' }),
        'updateActivity',
        200,
        'read-only: another field',
      );
      expect(readable.dealId, 'read-only: served').toBe(DEAL_A1);
      expectDealNotEditable(
        await createActivity(AGENT_1, { type: 'note', contactId: AMAKA.id, dealId: DEAL_A1 }),
        'read-only, create',
      );
      expectDealNotEditable(await updateActivity(AGENT_1, ACT, { version: 3, dealId: null }), 'read-only, update');
      // The admin set is never withheld.
      expectActivity(
        await updateActivity(SUPERVISOR, ACT, { version: 3, dealId: DEAL_A1_OTHER }),
        'updateActivity',
        200,
        'the admin set',
      );
    });
  });

  // =========================================================================
  // 3. The deal timeline: what is on it.
  // =========================================================================

  describe('the deal timeline: what is on it', () => {
    beforeEach(async () => {
      await plantDeals();
    });

    it('a deal with no history is an empty page: no-store, no totals, closed', async () => {
      const response = await dealTimeline(AGENT_1, SEEDED_DEAL.id);
      expectStatus(response, 200, 'seeded deal');
      expectNoStore(response, 'seeded deal');
      expectNoTotals(response, 'seeded deal');
      expect(response.body).toEqual({ data: [], nextCursor: null });
    });

    it('exactly the activities linked to it, whatever they target; nothing of its contact, account, other deals or other scopes (R19)', async () => {
      const on = (tail: string, extra: Partial<PlantedActivity>) => plantActivity({ id: id111(tail), ...extra });
      await on('a0301', { contactId: AMAKA.id, dealId: DEAL_A1 });
      await on('a0302', { type: 'task', accountId: IKOYI.id, dealId: DEAL_A1 });
      await on('a0303', { type: 'call', contactId: AMAKA.id, accountId: IKOYI.id, dealId: DEAL_A1 });
      await on('a0304', { contactId: AMAKA.id }); // the deal's contact, no link
      await on('a0305', { accountId: IKOYI.id }); // the deal's account, no link
      await on('a0306', { contactId: BASHIR.id, dealId: DEAL_A1_OTHER });
      await on('a0307', { programmeId: PROGRAMME_A2, contactId: DAMILOLA.id, dealId: DEAL_A2 });
      // Events that are not DEAL_A1's own.
      await plantEvent({ objectId: DEAL_A1_OTHER, occurredAt: '2026-04-02T09:00:00.000Z', actorUserId: null, changes: [named('name')] });
      await plantEvent({ objectId: DEAL_A1, programmeId: PROGRAMME_A2, occurredAt: '2026-04-03T09:00:00.000Z', actorUserId: null, changes: [named('amount')] });
      await plantEvent({ objectId: DEAL_A1, tenantId: TENANT_B, programmeId: PROGRAMME_B1, occurredAt: '2026-04-04T09:00:00.000Z', actorUserId: null, changes: [named('nextStep')] });
      await plantEvent({ objectType: 'activity', objectId: id111('a0301'), occurredAt: '2026-04-05T09:00:00.000Z', actorUserId: USER_A_SUPERVISOR, changes: [named('dealId')] });
      await plantEvent({ objectType: 'contact', objectId: AMAKA.id, occurredAt: '2026-04-06T09:00:00.000Z', actorUserId: USER_A_SUPERVISOR, changes: [named('phones')] });
      await plantEvent({ objectType: 'account', objectId: IKOYI.id, occurredAt: '2026-04-07T09:00:00.000Z', actorUserId: USER_A_SUPERVISOR, changes: [named('tier')] });

      for (const [label, headers] of [
        ['agent', AGENT_1],
        ['supervisor', SUPERVISOR],
      ] as const) {
        const items = await readDeal(headers, DEAL_A1, label);
        expect(activityIdsOf(items), `${label}: exactly the linked activities`).toEqual(
          [id111('a0301'), id111('a0302'), id111('a0303')].sort(),
        );
        expect(fieldItems(items), `${label}: no event is DEAL_A1's own`).toEqual([]);
      }
      // Controls: each excluded row is real and served where it belongs.
      const other = await readDeal(AGENT_1, DEAL_A1_OTHER, 'the other deal');
      expect(activityIdsOf(other)).toEqual([id111('a0306')]);
      expect(fieldsOf(other)).toEqual(['name']);
      expect(activityIdsOf(await readDeal(SUPERVISOR, DEAL_A2, 'A2 by the supervisor'))).toEqual([id111('a0307')]);
      const amaka = activityItems(await readContact(AGENT_1, AMAKA.id, 'Amaka')).map((item) => String(item.activityId));
      expect(amaka.sort()).toEqual([id111('a0301'), id111('a0303'), id111('a0304')].sort());
    });

    it('an activity item is the contact timeline’s item, current state, by its logger; its version completes the task (D-L85, R11, R18)', async () => {
      const TASK = id111('a0310');
      const logged = iso(Date.now() - 3 * DAY);
      await plantActivity({
        id: TASK,
        type: 'task',
        subject: `T0111 task ${RUN}`,
        contactId: AMAKA.id,
        createdAt: logged,
        createdByUserId: USER_A_AGENT_2,
        dueAt: '2031-12-01T09:00:00.000Z',
      });
      // Linked today, through the API: the item sits at its logged time.
      expectActivity(await updateActivity(SUPERVISOR, TASK, { version: 1, dealId: DEAL_A1 }), 'updateActivity', 200, 'link');
      const pick = (items: Json[]) => items.find((item) => item.activityId === TASK);
      const served = must(pick(await readDeal(AGENT_1, DEAL_A1, 'deal')), 'the task on the deal timeline');
      expect(Date.parse(String(served.occurredAt)), 'R18: at its logged time').toBe(Date.parse(logged));
      expect(served.actor, 'D-L81: named, though not an A1 member').toEqual({
        id: USER_A_AGENT_2,
        displayName: displayNameOf(USER_A_AGENT_2),
      });
      expect(served.version).toBe(2);
      expect(withoutId(served), 'R11: the same item as on the contact timeline').toEqual(
        withoutId(pick(await readContact(AGENT_1, AMAKA.id, 'contact'))),
      );
      expectActivity(
        await updateActivity(AGENT_1, TASK, { version: served.version, completed: true }),
        'updateActivity',
        200,
        'complete with the served version',
      );
      const after = must(pick(await readDeal(AGENT_1, DEAL_A1, 'after')), 'still there');
      expect(after.id, 'the same item').toBe(served.id);
      expect(after.occurredAt, 'completion never moves it').toBe(served.occurredAt);
      expect(after.completedAt).toEqual(expect.stringMatching(DATE_TIME));
      expect(after.version).toBe(3);
      expectError(await updateActivity(AGENT_1, TASK, { version: served.version, completed: true }), 409, 'stale_write');
      // Unlinked: gone from the deal, still on the contact.
      expectActivity(await updateActivity(SUPERVISOR, TASK, { version: 3, dealId: null }), 'updateActivity', 200, 'unlink');
      expect(pick(await readDeal(AGENT_1, DEAL_A1, 'unlinked'))).toBeUndefined();
      expect(pick(await readContact(AGENT_1, AMAKA.id, 'contact, unlinked'))).toBeDefined();
    });

    it('field changes by name only (R8): no value, stage id or owner id, whatever the audit row holds; other names yield nothing', async () => {
      const stages = await stagesOf(PROGRAMME_A1);
      const OLD = `Old Deal Name ${RUN}`;
      const NEW = `New Deal Name ${RUN}`;
      const STEP = `Call the buyer ${RUN}`;
      await plantEvent({
        objectId: DEAL_A1,
        occurredAt: '2026-04-10T09:00:00.000Z',
        actorUserId: USER_A_SUPERVISOR,
        changes: [
          { field: 'stageId', before: stages.firstOpen, after: stages.secondOpen, redacted: false },
          { field: 'ownerUserId', before: USER_A_AGENT_2, after: NOWHERE, redacted: false },
          { field: 'name', before: OLD, after: NEW, redacted: false },
          { field: 'amount', before: '125000 NGN', after: '987654 NGN', redacted: false },
          { field: 'nextStep', before: null, after: STEP, redacted: false },
          named('checks'),
          named('stageEnteredAt'),
          named('closedAt'),
          { field: 'consentState', before: 'unknown', after: 'opted_in', redacted: false },
          { field: 'priority', before: null, after: 'urgent', redacted: false },
          named('programmeId'),
        ],
      });
      const response = await dealTimeline(SUPERVISOR, DEAL_A1, [['limit', '100']]);
      expectStatus(response, 200, 'supervisor');
      const items = expectDealPage(response.body, 'planted values').data;
      expect(fieldsOf(items)).toEqual(['amount', 'checks', 'name', 'nextStep', 'ownerUserId', 'stageId']);
      for (const item of fieldItems(items)) {
        expect(item.redacted, String(item.field)).toBe(true);
        expect('before' in item || 'after' in item, String(item.field)).toBe(false);
        expect(item.actor).toEqual({ id: USER_A_SUPERVISOR, displayName: displayNameOf(USER_A_SUPERVISOR) });
      }
      for (const secret of [
        OLD,
        NEW,
        STEP,
        '987654',
        '125000',
        stages.firstOpen,
        stages.secondOpen,
        USER_A_AGENT_2,
        NOWHERE,
        'stageEnteredAt',
        'closedAt',
        'consentState',
        'opted_in',
        'priority',
        'urgent',
        'programmeId',
        PROGRAMME_A1,
      ]) {
        expect(response.text.toLowerCase(), `the deal timeline carries "${secret}"`).not.toContain(secret.toLowerCase());
      }
    });

    it('real deal writes appear by name, by the writer: a create and an update with a reassignment (T-0108’s audit, read back)', async () => {
      const stages = await stagesOf(PROGRAMME_A1);
      const created = await createDeal(AGENT_1, stages.pipelineId, {
        name: `T0111 created deal ${RUN}`,
        amount: { amountMinor: '450000', currency: 'NGN' },
        nextStep: `T0111 step ${RUN}`,
        primaryContactId: AMAKA.id,
      });
      expectStatus(created, 201, 'createDeal');
      const id = String((created.body as Json).id);
      await assign(USER_A_AGENT_2, PROGRAMME_A1, 'agent');
      expectStatus(
        await updateDeal(SUPERVISOR, id, {
          version: Number((await dealRow(id))?.version),
          expectedCloseDate: '2031-06-30',
          ownerUserId: USER_A_AGENT_2,
        }),
        200,
        'updateDeal',
      );
      const audited = await observer.query<{ actor_user_id: string; changes: Change[] }>(
        `SELECT actor_user_id, changes FROM audit_event WHERE object_type = 'deal' AND object_id = $1
          ORDER BY occurred_at, id`,
        [id],
      );
      expect(audited.rows, 'control: T-0108 wrote two events').toHaveLength(2);
      const expected = audited.rows
        .flatMap((row) =>
          row.changes
            .filter((change) => DEAL_TIMELINE_FIELDS.includes(change.field))
            .map((change) => `${row.actor_user_id}:${change.field}`),
        )
        .sort();
      expect(expected.length, 'control: the events name timeline fields').toBeGreaterThan(3);
      const response = await dealTimeline(AGENT_2, id, [['limit', '100']]);
      expectStatus(response, 200, 'agent 2 reads the deal it now owns');
      const items = expectDealPage(response.body, 'real writes').data;
      expect(
        fieldItems(items)
          .map((item) => `${String((item.actor as Json | null)?.id)}:${String(item.field)}`)
          .sort(),
      ).toEqual(expected);
      expect(response.text, 'the new owner’s id, from the reassignment’s audit values').not.toContain(
        USER_A_AGENT_2,
      );
      expect(response.text, 'the deal name').not.toContain(RUN);
    });
  });

  // =========================================================================
  // 4. Field security (R9, R10), judged in the deal's programme.
  // =========================================================================

  describe('field security: the deal and activity matrices, before paging', () => {
    beforeEach(async () => {
      await plantDeals();
    });

    async function plantEveryField(): Promise<void> {
      await plantEvent({
        objectId: DEAL_A1,
        occurredAt: '2026-04-11T09:00:00.000Z',
        actorUserId: USER_A_SUPERVISOR,
        changes: DEAL_TIMELINE_FIELDS.map(named),
      });
    }

    it('R9: an item is omitted exactly when getDeal withholds its field from the caller; name, stageId and checks never are; the admin set sees all', async () => {
      await plantEveryField();
      const unlocked = await readDeal(AGENT_1, DEAL_A1, 'unlocked');
      expect(fieldsOf(unlocked), 'control: every field before any lock').toEqual([...DEAL_TIMELINE_FIELDS].sort());
      for (const field of ['amount', 'owner_user_id', 'next_step', 'name']) await lockField('deal', field, 'agent', 'none');
      await lockField('deal', 'expected_close_date', 'agent', 'read');
      const deal = await getDeal(AGENT_1, DEAL_A1);
      expectStatus(deal, 200, 'getDeal');
      const withheld = ((deal.body as Json).withheldFields ?? []) as string[];
      expect(withheld.sort(), 'control: getDeal withholds these').toEqual(['amount', 'nextStep', 'ownerUserId']);
      const response = await dealTimeline(AGENT_1, DEAL_A1, [['limit', '100']]);
      expectStatus(response, 200, 'locked');
      const items = expectDealPage(response.body, 'locked').data;
      expect(fieldsOf(items)).toEqual(DEAL_TIMELINE_FIELDS.filter((field) => !withheld.includes(field)).sort());
      for (const name of withheld) expect(response.text).not.toContain(`"${name}"`);
      const stage = (list: Json[]) => list.find((item) => item.field === 'stageId')?.id;
      expect(stage(items), 'an id never moves with its neighbours').toBe(stage(unlocked));
      expect(fieldsOf(await readDeal(SUPERVISOR, DEAL_A1, 'admin'))).toEqual([...DEAL_TIMELINE_FIELDS].sort());
    });

    it('R9: judged by the set held in the deal’s programme, not another membership; the tenant-admin flag lifts nothing', async () => {
      await plantEveryField();
      // Agent 2: `agent` in A2, made `qa_analyst` in A1.
      await assign(USER_A_AGENT_2, PROGRAMME_A1, 'qa_analyst');
      await lockField('deal', 'amount', 'qa_analyst', 'none');
      await lockField('deal', 'next_step', 'agent', 'none');
      const agent2 = fieldsOf(await readDeal(AGENT_2, DEAL_A1, 'agent 2 (qa_analyst in A1)'));
      expect(agent2).not.toContain('amount');
      expect(agent2, 'the A2 agent lock does not apply in A1').toContain('nextStep');
      await setTenantAdmin(USER_A_AGENT_1, true);
      const agent1 = fieldsOf(await readDeal(AGENT_1, DEAL_A1, 'agent 1 with the flag'));
      expect(agent1, 'the flag lifts nothing').not.toContain('nextStep');
      expect(agent1).toContain('amount');
    });

    it('the activity matrix omits the same keys as on the contact timeline; a withheld deal_id removes every activity item (R10, R11)', async () => {
      const TASK = id111('a0401');
      await plantLinkedTask(TASK, { subject: `Subj ${RUN}` });
      await plantEvent({ objectId: DEAL_A1, occurredAt: '2026-04-12T09:00:00.000Z', actorUserId: USER_A_SUPERVISOR, changes: [named('stageId')] });
      await lockField('activity', 'subject', 'agent', 'none');
      await lockField('activity', 'due_at', 'agent', 'none');
      const pick = (items: Json[]) => items.find((item) => item.activityId === TASK);
      const onDeal = pick(await readDeal(AGENT_1, DEAL_A1, 'deal'));
      expect(onDeal, 'the activity is on the deal timeline').toBeDefined();
      expect('subject' in (onDeal ?? {}) || 'dueAt' in (onDeal ?? {})).toBe(false);
      expect(withoutId(onDeal)).toEqual(withoutId(pick(await readContact(AGENT_1, AMAKA.id, 'contact'))));

      await lockField('activity', 'deal_id', 'agent', 'none');
      const response = await dealTimeline(AGENT_1, DEAL_A1, [['limit', '100']]);
      expectStatus(response, 200, 'deal link withheld');
      const items = expectDealPage(response.body, 'deal link withheld').data;
      expect(activityItems(items), 'no activity item when its deal link is withheld').toEqual([]);
      expect(fieldsOf(items), 'the deal’s own items stay').toEqual(['stageId']);
      expect(response.text).not.toContain(TASK);
      expect(pick(await readContact(AGENT_1, AMAKA.id, 'contact')), 'control: the contact timeline still shows it').toBeDefined();
      expect(activityIdsOf(await readDeal(SUPERVISOR, DEAL_A1, 'admin'))).toEqual([TASK]);
    });

    it('R10: withheld contact and account links do not remove an item from the deal timeline', async () => {
      const TASK = id111('a0402');
      await plantLinkedTask(TASK, { accountId: IKOYI.id });
      await lockField('activity', 'contact_id', 'agent', 'none');
      await lockField('activity', 'account_id', 'agent', 'none');
      expect(activityIdsOf(await readDeal(AGENT_1, DEAL_A1, 'deal'))).toEqual([TASK]);
      const onContact = activityItems(await readContact(AGENT_1, AMAKA.id, 'contact'));
      const onAccount = activityItems(await readAccount(AGENT_1, IKOYI.id, 'account'));
      expect(onContact.concat(onAccount).map((item) => item.activityId), 'control: the locks bite there').not.toContain(TASK);
    });
  });

  // =========================================================================
  // 5. Paging (R13).
  // =========================================================================

  describe('paging: keyset across both sources, cursors', () => {
    beforeEach(async () => {
      await plantDeals();
    });

    it('every limit walks the same items in the same order as one read; the default page is 25', async () => {
      const mixed = await plantMixedHistory();
      const whole = await readDeal(SUPERVISOR, DEAL_A1, 'whole');
      // 8 visible events + 4 riders + 23 withheld events + 8 activities.
      expect(whole, 'control: the planted history is served').toHaveLength(43);
      expect(activityItems(whole)).toHaveLength(mixed.activityIds.length);
      for (const limit of [1, 2, 3, 7, 25]) {
        const walked = await walkDeal(SUPERVISOR, DEAL_A1, limit);
        expect(walked.items.map((item) => item.id), `limit ${limit}`).toEqual(whole.map((item) => item.id));
        expect(walked.sizes).toEqual(chunks(whole.length, limit));
      }
      expect((await walkDeal(SUPERVISOR, DEAL_A1, null)).sizes, 'no limit is 25 a page').toEqual([25, 18]);
    });

    it('withheld items are omitted before the page is cut: a short page with a cursor never happens', async () => {
      const mixed = await plantMixedHistory();
      for (const field of ['amount', 'next_step']) await lockField('deal', field, 'agent', 'none');
      const visible = (await readDeal(SUPERVISOR, DEAL_A1, 'supervisor')).filter(
        (item) => item.type === 'activity' || item.field === 'expectedCloseDate',
      );
      expect(visible, 'control: 8 visible events and 8 activities').toHaveLength(mixed.visibleToAgent);
      for (const limit of [1, 2, 3, 5, 7]) {
        const agent = await walkDeal(AGENT_1, DEAL_A1, limit);
        expect(agent.sizes, `page sizes at limit ${limit}`).toEqual(chunks(visible.length, limit));
        expect(agent.items.map((item) => item.id)).toEqual(visible.map((item) => item.id));
      }
    });

    it('an activity and an event at the same instant are one tie broken by id; sub-millisecond neighbours are each served once', async () => {
      const AT = '2026-04-20T10:00:01.000Z';
      await plantActivity({ id: id111('a0501'), accountId: IKOYI.id, dealId: DEAL_A1, createdAt: AT });
      await plantEvent({ objectId: DEAL_A1, occurredAt: AT, actorUserId: USER_A_SUPERVISOR, changes: [named('amount'), named('nextStep')] });
      await plantActivity({ id: id111('a0502'), type: 'call', accountId: IKOYI.id, dealId: DEAL_A1, createdAt: '2026-04-20T10:00:00.123400Z' });
      for (const micros of ['123100', '123700']) {
        await plantEvent({ objectId: DEAL_A1, occurredAt: `2026-04-20T10:00:00.${micros}Z`, actorUserId: USER_A_SUPERVISOR, changes: [named('name')] });
      }
      for (const limit of [1, 2, 4]) {
        const { items } = await walkDeal(AGENT_1, DEAL_A1, limit, false);
        expect(items, `limit ${limit}: every item once`).toHaveLength(6);
        const tie = items.filter((item) => item.occurredAt === AT);
        expect(tie.map((item) => item.type).sort()).toEqual(['activity', 'field_changed', 'field_changed']);
        expect(orderProblems(tie, true), `limit ${limit}: the tie by id descending`).toEqual([]);
      }
    });

    it('keyset, not offset: items added after page 1 never shift or repeat the pages that follow', async () => {
      await plantMixedHistory();
      const whole = await readDeal(SUPERVISOR, DEAL_A1, 'before');
      const first = await dealTimeline(SUPERVISOR, DEAL_A1, [['limit', '5']]);
      expectStatus(first, 200, 'page 1');
      const page1 = expectDealPage(first.body, 'page 1');
      expect(page1.nextCursor).toEqual(expect.any(String));
      const later = iso(Date.now() + HOUR);
      await plantActivity({ id: id111('a0510'), accountId: IKOYI.id, dealId: DEAL_A1, createdAt: later });
      await plantEvent({ objectId: DEAL_A1, occurredAt: later, actorUserId: USER_A_SUPERVISOR, changes: [named('amount')] });
      const rest = await walkDeal(SUPERVISOR, DEAL_A1, 5, true, page1.nextCursor);
      expect([...page1.data, ...rest.items].map((item) => item.id)).toEqual(whole.map((item) => item.id));
      expect((await readDeal(SUPERVISOR, DEAL_A1, 'after')).length, 'control: two new items').toBe(whole.length + 2);
    });

    it('a cursor carries a position only: no name, and no id of anything the pages served so far did not show (D-L80)', async () => {
      const mixed = await plantMixedHistory();
      const stages = await stagesOf(PROGRAMME_A1);
      // A move event, as T-0108 writes one: the stage ids are values never shown.
      await plantEvent({
        id: id111('e2000'),
        objectId: DEAL_A1,
        occurredAt: '2026-03-01T00:20:30.000Z',
        actorUserId: USER_A_SUPERVISOR,
        changes: [
          { field: 'stageId', before: stages.firstOpen, after: stages.secondOpen, redacted: false },
          named('stageEnteredAt'),
        ],
      });
      const PROBE_NAME = `Deal Cursor Probe ${RUN}`;
      await observer.query('UPDATE deal SET name = $1 WHERE id = $2', [PROBE_NAME, DEAL_A1]);
      const walked = await walkDeal(SUPERVISOR, DEAL_A1, 3);
      expect(walked.cursors.length, 'control: many cursors').toBeGreaterThan(10);
      const names = [
        PROBE_NAME,
        displayNameOf(USER_A_SUPERVISOR),
        displayNameOf(USER_A_AGENT_1),
        AMAKA.givenNames,
        IKOYI.name,
        'T0111 history note',
      ].map((name) => name.toLowerCase());
      const known = [
        ...mixed.eventIds,
        id111('e2000'),
        ...mixed.activityIds,
        ...mixed.stageIds,
        AMAKA.id,
        IKOYI.id,
        USER_A_AGENT_1, // owner of every history activity: never on an item
        DEAL_A2,
      ];
      walked.cursors.forEach((cursor, index) => {
        const readings = cursorReadings(cursor);
        const shown = walked.bodies.slice(0, index + 1).join('\n').toLowerCase();
        for (const name of names) {
          expect(readings.some((text) => text.includes(name)), `cursor ${index + 1} carries "${name}"`).toBe(false);
        }
        for (const id of known) {
          if (shown.includes(id.toLowerCase())) continue;
          for (const form of idForms(id)) {
            expect(
              readings.some((text) => text.includes(form)),
              `cursor ${index + 1} carries ${id}, which no page served so far showed`,
            ).toBe(false);
          }
        }
      });
    });

    it('a malformed cursor, or one from another deal, a contact or account timeline or listDeals, is 400 invalid_cursor; reachable or not, one body', async () => {
      const at = (minute: number) => `2026-04-23T10:0${minute}:00.000Z`;
      for (const minute of [1, 2]) {
        await plantEvent({ objectId: DEAL_A1, occurredAt: at(minute), actorUserId: null, changes: [named('amount')] });
        await plantEvent({ objectId: DEAL_A2, programmeId: PROGRAMME_A2, occurredAt: at(minute), actorUserId: null, changes: [named('amount')] });
        await plantEvent({ objectType: 'contact', objectId: AMAKA.id, occurredAt: at(minute), actorUserId: null, changes: [named('phones')] });
        await plantEvent({ objectType: 'account', objectId: IKOYI.id, occurredAt: at(minute), actorUserId: null, changes: [named('tier')] });
      }
      const stages = await stagesOf(PROGRAMME_A1);
      const own = await firstCursor(() => dealTimeline(AGENT_1, DEAL_A1, [['limit', '1']]), 'DEAL_A1');
      const a2 = await firstCursor(() => dealTimeline(SUPERVISOR, DEAL_A2, [['limit', '1']]), 'DEAL_A2 by the supervisor');
      const contact = await firstCursor(() => contactTimeline(AGENT_1, AMAKA.id, [['limit', '1']]), 'Amaka');
      const account = await firstCursor(() => accountTimeline(AGENT_1, IKOYI.id, [['limit', '1']]), 'Ikoyi');
      const list = await firstCursor(() => listDeals(AGENT_1, stages.pipelineId, [['limit', '1']]), 'listDeals');
      await control(AGENT_1, DEAL_A1_OTHER);

      const invalidCursor = (response: request.Response, where: string): string => {
        const body = expectError(response, 400, 'validation_failed');
        expect(detailsOf(body), where).toContainEqual({ path: 'cursor', code: 'invalid_cursor' });
        expectNoStore(response, where);
        return response.text;
      };
      const on = (dealId: string, cursor: string) => dealTimeline(AGENT_1, dealId, [['limit', '1'], ['cursor', cursor]]);
      const fromReachable = invalidCursor(await on(DEAL_A1_OTHER, own), 'DEAL_A1’s cursor on another deal');
      const fromUnreachable = invalidCursor(await on(DEAL_A1_OTHER, a2), 'DEAL_A2’s cursor on an A1 deal');
      expect(fromUnreachable, 'R13: out of reach answers exactly as in reach').toBe(fromReachable);
      invalidCursor(await on(DEAL_A1, contact), 'a contact timeline cursor');
      invalidCursor(await on(DEAL_A1, account), 'an account timeline cursor');
      invalidCursor(await on(DEAL_A1, list), 'a listDeals cursor');
      invalidCursor(await accountTimeline(AGENT_1, IKOYI.id, [['cursor', own]]), 'a deal cursor on the account timeline');
      invalidCursor(await on(DEAL_A1, 'not-a-cursor'), 'garbage');
      invalidCursor(await on(DEAL_A1, own.slice(0, Math.floor(own.length / 2))), 'a truncated cursor');
      for (const cursor of ['abc\u0000def', 'A'.repeat(2049), '\u{1F642}']) {
        const response = await on(DEAL_A1, cursor);
        expectError(response, 400, 'validation_failed');
        expectNoStore(response, 'an absurd cursor');
      }
      for (const limit of ['0', '101', 'ten', '1.5']) {
        expectError(await dealTimeline(AGENT_1, DEAL_A1, [['limit', limit]]), 400, 'validation_failed');
      }
      expectStatus(await on(DEAL_A1, own), 200, 'control: the cursor works where it was issued');
    });
  });

  // =========================================================================
  // 6. Scope and errors (R12).
  // =========================================================================

  describe('scope and errors', () => {
    beforeEach(async () => {
      await plantDeals();
    });

    it('another programme, another tenant, nowhere, non-uuid ids and a user with no programme are getDeal’s one 404, byte for byte, no-store', async () => {
      await control();
      const nowhere = await dealTimeline(AGENT_1, NOWHERE);
      expectError(nowhere, 404, 'not_found');
      const getNowhere = await getDeal(AGENT_1, NOWHERE);
      expectError(getNowhere, 404, 'not_found');
      expect(nowhere.text, 'R12: the timeline is no second oracle beside getDeal').toBe(getNowhere.text);
      const cases: [string, request.Response][] = [
        ['another programme', await dealTimeline(AGENT_1, DEAL_A2)],
        ['another tenant', await dealTimeline(AGENT_1, DEAL_B1)],
        ['another tenant, its own admin’s deal id from tenant A', await dealTimeline(TENANT_B_ADMIN, DEAL_A1)],
        ['no programme at all', await dealTimeline(NO_PROGRAMME, DEAL_A1)],
        ['out of reach, upper case', await dealTimeline(AGENT_1, DEAL_A2.toUpperCase())],
        ['not a uuid', await dealTimelineRaw(AGENT_1, 'not-a-uuid')],
        ['a uuid and a digit', await dealTimelineRaw(AGENT_1, `${DEAL_A2}0`)],
        ['a uuid without dashes', await dealTimelineRaw(AGENT_1, DEAL_A2.replace(/-/g, ''))],
        ['a NUL', await dealTimelineRaw(AGENT_1, '%00')],
        ['SQL', await dealTimelineRaw(AGENT_1, encodeURIComponent("1' OR '1'='1"))],
      ];
      for (const [label, response] of cases) {
        expectError(response, 404, 'not_found');
        expect(response.text, `${label}: not the same bytes as nowhere`).toBe(nowhere.text);
        expectNoStore(response, label);
      }
    });

    it('readers (D-L127): every staff set reads it; client_portal and a custom set get the one 404, as on getDeal', async () => {
      await plantLinkedTask(id111('a0601'));
      const nowhere = (await dealTimeline(AGENT_1, NOWHERE)).text;
      for (const key of ['agent', 'qa_analyst', 'team_lead', 'programme_manager', 'admin']) {
        await assign(USER_A_AGENT_1, PROGRAMME_A1, key);
        expect(activityIdsOf(await readDeal(AGENT_1, DEAL_A1, key)), `${key} reads it`).toEqual([id111('a0601')]);
      }
      const CUSTOM = id111('5e0001');
      await observer.query(
        `INSERT INTO permission_set (id, tenant_id, key, label) VALUES ($1, $2, 't0111_custom', 'T0111 custom set')`,
        [CUSTOM, TENANT_A],
      );
      for (const [label, set] of [
        ['client_portal', permissionSet(TENANT_A, 'client_portal')],
        ['a custom set', CUSTOM],
      ] as const) {
        await observer.query(
          'UPDATE user_programme SET permission_set_id = $1 WHERE user_id = $2 AND programme_id = $3',
          [set, USER_A_AGENT_1, PROGRAMME_A1],
        );
        const deal = await getDeal(AGENT_1, DEAL_A1);
        expectError(deal, 404, 'not_found');
        const timeline = await dealTimeline(AGENT_1, DEAL_A1);
        expectError(timeline, 404, 'not_found');
        expect(timeline.text, `${label}: the one 404`).toBe(nowhere);
        expectNoStore(timeline, label);
      }
    });

    it('order: 404 before 400; a read has no 403', async () => {
      for (const minute of ['1', '2']) {
        await plantEvent({ objectId: DEAL_A2, programmeId: PROGRAMME_A2, occurredAt: `2026-04-24T10:0${minute}:00.000Z`, actorUserId: null, changes: [named('amount')] });
      }
      const a2 = await firstCursor(() => dealTimeline(SUPERVISOR, DEAL_A2, [['limit', '1']]), 'DEAL_A2 by the supervisor');
      await control();
      const nowhere = (await dealTimeline(AGENT_1, NOWHERE)).text;
      for (const [label, response] of [
        ['out of reach, a malformed cursor', await dealTimeline(AGENT_1, DEAL_A2, [['cursor', 'not-a-cursor']])],
        ['out of reach, limit 0', await dealTimeline(AGENT_1, DEAL_A2, [['limit', '0']])],
        ['out of reach, its own cursor', await dealTimeline(AGENT_1, DEAL_A2, [['limit', '1'], ['cursor', a2]])],
        ['nowhere, limit 101', await dealTimeline(AGENT_1, NOWHERE, [['limit', '101']])],
        ['not a uuid, limit 0', await request(server()).get(`${DEALS}/not-a-uuid/timeline?limit=0`).set(AGENT_1)],
      ] as const) {
        expectError(response, 404, 'not_found');
        expect(response.text, label).toBe(nowhere);
      }
      const bad = await dealTimeline(AGENT_1, DEAL_A1, [['limit', '0']]);
      expectError(bad, 400, 'validation_failed');
      expectNoStore(bad, 'a 400');
    });

    it('no session is 401, one body for any id; a scope header is 400, one body in reach or out', async () => {
      await control();
      const unauthenticated = [
        await dealTimeline({}, DEAL_A1),
        await dealTimeline({}, NOWHERE),
        await dealTimelineRaw({}, 'not-a-uuid'),
      ].map((response) => {
        expectError(response, 401, 'not_authenticated');
        return response.text;
      });
      expect(new Set(unauthenticated).size, '401 tells nothing about the id').toBe(1);
      for (const [header, value] of [
        ['x-kasuwa-programme-ids', `{${PROGRAMME_A2}}`],
        ['x-kasuwa-programme-id', PROGRAMME_A2],
        ['x-kasuwa-scope', 'all'],
      ] as const) {
        const bodies = [
          await dealTimeline(AGENT_1, DEAL_A1).set(header, value),
          await dealTimeline(AGENT_1, DEAL_A2).set(header, value),
          await dealTimeline(AGENT_1, NOWHERE).set(header, value),
        ].map((response) => {
          expectError(response, 400, 'validation_failed');
          return response.text;
        });
        expect(new Set(bodies).size, `${header}: one body in reach or out`).toBe(1);
      }
    });
  });

  // =========================================================================
  // 7. Isolation: another programme's or tenant's deal is never reachable
  //    through dealId, on create, on update or on the timeline.
  // =========================================================================

  describe('isolation: dealId never reaches across a programme or a tenant', () => {
    beforeEach(async () => {
      await plantDeals();
    });

    it('create: a deal in another programme (even one the caller reads), another tenant or nowhere is one 400 body, and nothing is written', async () => {
      expectActivity(
        await createActivity(SUPERVISOR, { type: 'note', contactId: AMAKA.id, dealId: DEAL_A1 }),
        'createActivity',
        201,
        'control: the supervisor links in A1',
      );
      const before = await activityCount();
      const events = await auditCount('activity');
      const ids = [DEAL_A2, DEAL_B1, NOWHERE, SEEDED_DEAL.id];
      const bodies = [
        // The supervisor reads A2 and its deal; the activity is A1's.
        expectUnknownDeal(await createActivity(SUPERVISOR, { type: 'note', contactId: AMAKA.id, dealId: DEAL_A2 }), 'supervisor, A2 deal', ids),
        expectUnknownDeal(await createActivity(SUPERVISOR, { type: 'note', contactId: AMAKA.id, dealId: DEAL_B1 }), 'supervisor, B1 deal', ids),
        expectUnknownDeal(await createActivity(SUPERVISOR, { type: 'note', contactId: AMAKA.id, dealId: NOWHERE }), 'supervisor, nowhere', ids),
        // An A2 activity naming an A1 deal: the programme is the target's (R1).
        expectUnknownDeal(await createActivity(SUPERVISOR, { type: 'note', contactId: DAMILOLA.id, dealId: SEEDED_DEAL.id }), 'supervisor, A2 target, A1 deal', ids),
        expectUnknownDeal(await createActivity(SUPERVISOR, { type: 'note', accountId: SABON.id, dealId: DEAL_A1 }), 'supervisor, A2 account, A1 deal', ids),
        expectUnknownDeal(await createActivity(AGENT_1, { type: 'note', contactId: AMAKA.id, dealId: DEAL_A2 }), 'agent, A2 deal', ids),
        expectUnknownDeal(await createActivity(AGENT_1, { type: 'note', contactId: AMAKA.id, dealId: NOWHERE }), 'agent, nowhere', ids),
      ];
      expect(new Set(bodies).size, 'R2: one body, real elsewhere or invented').toBe(1);
      // Tenant B's admin, with tenant A's deal.
      const tenantB = expectUnknownDeal(
        await createActivity(TENANT_B_ADMIN, { type: 'note', contactId: GRACE.id, dealId: DEAL_A1 }),
        'tenant B, tenant A deal',
        ids,
      );
      expect(tenantB).toBe(bodies[0]);
      expect(await activityCount(), 'nothing was written').toBe(before);
      expect(await auditCount('activity'), 'a refusal writes no event').toBe(events);
    });

    it('update: the same one body for a deal elsewhere or nowhere, and the activity is untouched', async () => {
      const ACT = id111('a0701');
      await plantActivity({ id: ACT, contactId: AMAKA.id, dealId: DEAL_A1 });
      const ACT_B = id111('a0702');
      await plantActivity({
        id: ACT_B,
        tenantId: TENANT_B,
        programmeId: PROGRAMME_B1,
        contactId: GRACE.id,
        createdByUserId: USER_B_AGENT_1,
      });
      expectActivity(await updateActivity(SUPERVISOR, ACT, { version: 1, dealId: DEAL_A1_OTHER }), 'updateActivity', 200, 'control');
      const settled = await activityRow(ACT);
      const events = await auditCount('activity');
      const ids = [DEAL_A2, DEAL_B1, NOWHERE];
      const bodies = [
        expectUnknownDeal(await updateActivity(SUPERVISOR, ACT, { version: 2, dealId: DEAL_A2 }), 'supervisor, A2', ids),
        expectUnknownDeal(await updateActivity(SUPERVISOR, ACT, { version: 2, dealId: DEAL_B1 }), 'supervisor, B1', ids),
        expectUnknownDeal(await updateActivity(SUPERVISOR, ACT, { version: 2, dealId: NOWHERE }), 'supervisor, nowhere', ids),
        expectUnknownDeal(await updateActivity(AGENT_1, ACT, { version: 2, dealId: DEAL_A2 }), 'agent, A2', ids),
        expectUnknownDeal(await updateActivity(TENANT_B_ADMIN, ACT_B, { version: 1, dealId: DEAL_A1 }), 'tenant B, A1 deal', ids),
      ];
      expect(new Set(bodies).size, 'R2: one body').toBe(1);
      expect(await activityRow(ACT), 'the activity is untouched').toEqual(settled);
      expect((await activityRow(ACT_B))?.deal_id).toBeNull();
      expect(await auditCount('activity')).toBe(events);
    });

    it('timeline: an A1 deal never shows another scope’s activity or event, and another scope’s deal is the one 404 for every A1 caller', async () => {
      await plantLinkedTask(id111('a0703'));
      await plantActivity({ id: id111('a0704'), programmeId: PROGRAMME_A2, contactId: DAMILOLA.id, dealId: DEAL_A2, subject: `T0111 A2 secret ${RUN}` });
      await plantActivity({
        id: id111('a0705'),
        tenantId: TENANT_B,
        programmeId: PROGRAMME_B1,
        contactId: GRACE.id,
        dealId: DEAL_B1,
        createdByUserId: USER_B_AGENT_1,
        subject: `T0111 B1 secret ${RUN}`,
      });
      // Audit rows about DEAL_A1 written under another programme or tenant are not its history.
      await plantEvent({ objectId: DEAL_A1, programmeId: PROGRAMME_A2, occurredAt: '2026-05-01T09:00:00.000Z', actorUserId: USER_A_AGENT_2, changes: [named('name')] });
      await plantEvent({ objectId: DEAL_A1, tenantId: TENANT_B, programmeId: PROGRAMME_B1, occurredAt: '2026-05-02T09:00:00.000Z', actorUserId: USER_B_AGENT_1, changes: [named('amount')] });
      for (const [label, headers] of [
        ['agent', AGENT_1],
        ['supervisor', SUPERVISOR],
      ] as const) {
        const response = await dealTimeline(headers, DEAL_A1, [['limit', '100']]);
        expectStatus(response, 200, label);
        const items = expectDealPage(response.body, label).data;
        expect(activityIdsOf(items), label).toEqual([id111('a0703')]);
        expect(fieldItems(items), label).toEqual([]);
        for (const secret of ['A2 secret', 'B1 secret', USER_B_AGENT_1, displayNameOf(USER_B_AGENT_1)]) {
          expect(response.text, `${label}: ${secret}`).not.toContain(secret);
        }
      }
      const nowhere = (await dealTimeline(AGENT_1, NOWHERE)).text;
      for (const [label, headers, dealId] of [
        ['agent 1 on A2', AGENT_1, DEAL_A2],
        ['agent 2 on A1', AGENT_2, DEAL_A1],
        ['the supervisor on B1', SUPERVISOR, DEAL_B1],
      ] as const) {
        const response = await dealTimeline(headers, dealId);
        expectError(response, 404, 'not_found');
        expect(response.text, label).toBe(nowhere);
      }
      const theirs = await dealTimeline(TENANT_B_ADMIN, DEAL_A1);
      expectError(theirs, 404, 'not_found');
      expect(activityIdsOf(await readDeal(TENANT_B_ADMIN, DEAL_B1, 'control: tenant B reads its own'))).toEqual([id111('a0705')]);
    });
  });
});

/**
 * One statement that ROTATES ids (D-L76): X -> fresh, Y -> X. Under NO ACTION
 * the end state satisfies every FK and the child silently follows Y; RESTRICT
 * refuses it. Rows are updated X first: X sorts first by id and was inserted
 * first, so neither an index nor a sequential scan meets Y first (a 23505
 * would be a misordered probe, not a refusal).
 */
function ROTATE_SQL(table: string): string {
  return `UPDATE ${table} SET id = CASE id WHEN $1::uuid THEN $3::uuid WHEN $2::uuid THEN $1::uuid END
           WHERE id IN ($1::uuid, $2::uuid)`;
}
