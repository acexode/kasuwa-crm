import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import {
  createPool,
  PROGRAMME_A1,
  SEED_CONTACTS,
  SEED_PERMISSION_SETS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { asUser, withAuthDatabase } from '../support/api';

/**
 * ACCEPTANCE — T-0089, custom-field DEFINITIONS over the admin API (P18;
 * ADR-0016 items 4 and 9; D-L128 Q1-Q3, Q6; D-L138; D-L139; D-L45; D-L53;
 * D-P24; D-P25; CLAUDE.md 6.4). Agent 2 builds it. Written by QA for the lead
 * before the build (D-L23, D-L25), from the T-0088 contract
 * (docs/api/admin.openapi.yaml, tag `custom-fields`), not from an
 * implementation.
 *
 * Companion suites: custom-fields-storage (migration 0039),
 * custom-fields-values-api (values on records) and custom-fields-budget.
 * Helpers are restated, never imported.
 *
 * ==========================================================================
 * PINNED INTERFACES (from the contract; the builder honours these exactly)
 * ==========================================================================
 *
 * ROUTES.
 *   listCustomFields    GET   /api/v1/admin/custom-fields?object=<object>
 *   createCustomField   POST  /api/v1/admin/custom-fields              -> 201
 *   updateCustomField   PATCH /api/v1/admin/custom-fields/{fieldId}    -> 200
 *   retireCustomField   POST  /api/v1/admin/custom-fields/{fieldId}/retire -> 200
 *   Every 2xx body matches its operation's response schema (CustomFieldList,
 *   CustomFieldDefinition); every error matches the shared Error schema.
 *   All four are `x-kasuwa-implemented: true` once served (a LEAD EDIT to
 *   custom-fields-contract R19, which pins `false` today).
 *
 * PERMISSION. The three writes need `custom_field.write`, a TENANT action:
 *   the tenant-admin flag, whatever sets the caller holds (D-L53, D-L139).
 *   Without it, `403 not_permitted` and nothing is written. The list needs
 *   no permission: every authenticated user of the tenant.
 *
 * CODES (from the contract).
 *   400 validation_failed  apiName/invalid_api_name, type/unsupported_type,
 *                          config/invalid_config, config.currencyCode/
 *                          unknown_currency, config.values/duplicate_value,
 *                          addValues/not_a_picklist, relabelValues/
 *                          unknown_value, addValues/duplicate_value,
 *                          fieldId/field_retired.
 *   409 duplicate_code     details apiName/duplicate (live OR retired name).
 *   409 limit_reached      objectApiName/field_limit_reached (101st active),
 *                          addValues/picklist_limit_reached (past 500).
 *   404 not_found          one body: another tenant's field, a standard
 *                          field's id, an id naming nothing.
 *
 * D-L140 (the T-0088 security review, pinned as the coordinator stated it):
 *   - listCustomFields lists ACTIVE fields by default; `includeRetired=true`
 *     adds the retired ones (`retiredAt` set);
 *   - at most 500 definitions per object COUNTING retired ones, then
 *     `409 limit_reached` / `field_limit_reached`; the 100 active-field limit
 *     stands;
 *   - check order: 401, then 403 (`custom_field.write`), then 404, then 400
 *     (`field_retired` and the body codes). A non-admin gets 403 even for an
 *     invented id, a retired field, a repeat retire or an invalid body.
 *
 * LIFECYCLE. Type, apiName, objectApiName and the currency never change (the
 *   update body is closed); picklist values are added or relabelled, never
 *   removed; classification may move both ways (D-P25, D-L138) and never
 *   rewrites the matrix. Retire sets `retiredAt`, keeps the name taken, and
 *   a repeat retire answers 200 with the first `retiredAt` and writes no
 *   second audit event. Retired fields do not count toward the 100.
 *
 * FIELD SECURITY AT CREATE (D-L128 Q2). A `pii` or `sensitive` field starts
 *   at `none` for every UNLOCKED permission set of the tenant (a set the
 *   tenant created itself included); the locked admin set is `edit`. A
 *   `none` field starts at `edit` for every set (D-L45).
 *
 * AUDIT. One event per successful write, `objectType: custom_field`,
 *   `programmeId: null`; none for a refused write or a repeat retire.
 *
 * ==========================================================================
 * RULINGS where the contract is silent (this suite's; the lead may reverse)
 * ==========================================================================
 *
 * A1  RULED (D-L141): a retire is audited as action `updated` with a change
 *     named `retiredAt`. There is no `retired` action and no change to
 *     audit_event_action_check; only that form passes.
 * A2  RULED (D-L141): a picklist created with more than 500 values is
 *     `400 invalid_config` at `config.values`, exactly; on update the limit
 *     is `409 picklist_limit_reached` at `addValues`.
 * A8  (D-L140, D-L141) CustomFieldLimits is exactly apiBytes 16384,
 *     bytesPerRecord 32768, definitionsPerObject 500, fieldsPerObject 100
 *     and picklistValues 500.
 * A3  A custom field of a CUSTOM object is outside this API: its id is the
 *     same 404 as an invented one. The routes manage the four standard
 *     objects only, and must not become a back door to another object's
 *     definitions.
 * A4  An `object` the contract does not list (`lead`, `widget`) is `400`.
 *     `lead` is not an alias for `contact` here: the enum is closed.
 * A5  The created event names the api name, type and classification
 *     somewhere in its label or changes; how is the builder's.
 * A6  `updatedAt` moves on a successful update; a refused update changes no
 *     column. `createdAt` never moves.
 * A7  There is no DELETE route: a DELETE answers no 2xx and the row stays.
 *
 * ==========================================================================
 * D-L23: on this branch the four routes do not exist (404 from the router,
 * or 501), the flags are false and field_def has no `retired_at`. Every test
 * except those titled "(self-check)" begins with a request that must succeed
 * and fails there.
 *
 * Fixtures: packages/db/src/fixtures.ts, plus rows planted by kasuwa_migrator
 * with ids in this suite's range (`11111111-0000-4000-8000-0089xxxxxxxx`).
 * Writes: the suite reseeds before and after, and after every test.
 */

const ADMIN = '/api/v1/admin/custom-fields';
const MATRIX = '/api/v1/admin/field-security/matrix';
const SPEC_PATH = resolve(__dirname, '../../../docs/api/admin.openapi.yaml');

const id89 = (tail: string) => `11111111-0000-4000-8000-0089${tail.padStart(8, '0')}`;
const NOWHERE = id89('a0ffffff');

const OBJECTS = ['contact', 'account', 'activity', 'deal'] as const;

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);
/** Not a tenant admin until a test makes it one; holds whatever set a test assigns. */
const ACTOR = asUser(TENANT_A, USER_A_NO_PROGRAMME);
const TENANT_B_ADMIN = asUser(TENANT_B, USER_B_AGENT_1);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SKEW_MS = 5 * 60 * 1000;

type Json = Record<string, unknown>;
type Headers = Record<string, string>;

function must<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`Fixture drift: ${what}`);
  return value;
}

function permissionSet(tenantId: string, key: string): string {
  return must(
    SEED_PERMISSION_SETS.find((set) => set.tenantId === tenantId && set.key === key),
    `no seeded permission set '${key}'`,
  ).id;
}

const A1_CONTACT = must(SEED_CONTACTS.find((c) => c.programmeId === PROGRAMME_A1), 'A1 contact');

// ---------------------------------------------------------------------------
// A small JSON-Schema checker over the published YAML (no new dependency),
// restated from the T-0108 suite.
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
    node = (node as Json | undefined)?.[raw.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  if (node === undefined) throw new Error(`schema pointer #${fragment} resolves to nothing`);
  return node;
}

function deref(schema: Json, file: string): { schema: Json; file: string } {
  const ref = schema.$ref;
  if (typeof ref !== 'string') return { schema, file };
  const [relative, fragment = ''] = ref.split('#');
  const target = relative === undefined || relative === '' ? file : resolve(dirname(file), relative);
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
  if (Array.isArray(schema.allOf)) for (const part of schema.allOf as Json[]) check(part, at, value, path, errors);
  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as Json[]).filter((branch) => {
      const branchErrors: string[] = [];
      check(branch, at, value, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (passing.length !== 1) errors.push(`${path}: matches ${passing.length} oneOf branches`);
  }
  if (Array.isArray(schema.anyOf)) {
    const passing = (schema.anyOf as Json[]).some((branch) => {
      const branchErrors: string[] = [];
      check(branch, at, value, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (!passing) errors.push(`${path}: matches no anyOf branch`);
  }
  if ('const' in schema && schema.const !== value) errors.push(`${path}: not the const ${String(schema.const)}`);
  const actual = jsonType(value);
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!(allowed.includes(actual) || (actual === 'integer' && allowed.includes('number')))) {
      errors.push(`${path}: type ${actual}, schema allows ${allowed.join('|')}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) errors.push(`${path}: too short`);
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) errors.push(`${path}: too long`);
    const format = typeof schema.format === 'string' ? FORMATS[schema.format] : undefined;
    if (format !== undefined && !format.test(value)) errors.push(`${path}: not a ${String(schema.format)}`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${path}: does not match ${schema.pattern}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (schema.items !== undefined && typeof schema.items === 'object') {
      value.forEach((item, index) => check(schema.items as Json, at, item, `${path}[${index}]`, errors));
    }
  }
  if (actual === 'object') {
    const object = value as Json;
    const properties = (schema.properties ?? {}) as Record<string, Json>;
    if (typeof schema.maxProperties === 'number' && Object.keys(object).length > schema.maxProperties) {
      errors.push(`${path}: too many properties`);
    }
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in object)) errors.push(`${path}: required property "${key}" is missing`);
    }
    for (const [key, child] of Object.entries(object)) {
      const childSchema = properties[key];
      if (childSchema !== undefined) check(childSchema, at, child, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: property "${key}" is not allowed`);
    }
  }
}

function schemaErrors(schema: Json, value: unknown, where: string): string[] {
  const errors: string[] = [];
  check(schema, SPEC_PATH, value, where, errors);
  return errors;
}

const DEFINITION = { $ref: '#/components/schemas/CustomFieldDefinition' };
const LIST = { $ref: '#/components/schemas/CustomFieldList' };
const ERROR = { $ref: '#/components/schemas/Error' };

function adminOperation(operationId: string): Json {
  const paths = ((loadDoc(SPEC_PATH) as Json).paths ?? {}) as Record<string, Json>;
  for (const item of Object.values(paths)) {
    for (const op of Object.values(item)) {
      if (typeof op === 'object' && op !== null && (op as Json).operationId === operationId) return op as Json;
    }
  }
  throw new Error(`admin.openapi.yaml has no operation ${operationId}`);
}

// ---------------------------------------------------------------------------
// Response checks.
// ---------------------------------------------------------------------------

interface Detail {
  path: string;
  code: string;
}

function detailsOf(body: unknown): Detail[] {
  const details = (body as Json | null)?.details;
  return Array.isArray(details) ? (details as Detail[]) : [];
}

function expectError(response: request.Response, status: number, code: string, where: string): Json {
  expect(response.status, `${where}: expected ${status} ${code}, got ${response.status} ${response.text}`).toBe(status);
  expect(schemaErrors(ERROR, response.body, 'Error'), `${where}: not the shared Error schema`).toEqual([]);
  const body = response.body as Json;
  expect(body.code, `${where}: Error.code`).toBe(code);
  return body;
}

function expectDetail(response: request.Response, status: number, code: string, detail: string, paths: readonly string[], where: string): Json {
  const body = expectError(response, status, code, where);
  const found = detailsOf(body).some((d) => d.code === detail && paths.includes(d.path));
  expect(found, `${where}: details ${JSON.stringify(body.details)} lack ${detail} at ${paths.join(' or ')}`).toBe(true);
  for (const d of detailsOf(body)) {
    expect(Object.keys(d).sort(), `${where}: a detail carries more than path and code`).toEqual(['code', 'path']);
  }
  return body;
}

function expectDefinition(response: request.Response, status: number, where: string): Json {
  expect(response.status, `${where}: ${response.text}`).toBe(status);
  expect(schemaErrors(DEFINITION, response.body, where), `${where}: not a CustomFieldDefinition`).toEqual([]);
  return response.body as Json;
}

// ---------------------------------------------------------------------------

describe('acceptance: custom-field definitions over the admin API (T-0089)', () => {
  let app: INestApplication;
  /** kasuwa_migrator — BYPASSRLS. Plants and observes; never serves. */
  let observer: Pool;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(withAuthDatabase({ databaseUrl: inject('databaseUrl'), poolMax: 5 }))],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
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
  const enc = encodeURIComponent;
  const list = (headers: Headers, object?: string) =>
    request(server())
      .get(object === undefined ? ADMIN : `${ADMIN}?object=${enc(object)}`)
      .set(headers);
  const create = (headers: Headers, body: unknown) =>
    request(server()).post(ADMIN).set(headers).set('Content-Type', 'application/json').send(JSON.stringify(body));
  const update = (headers: Headers, id: string, body: unknown) =>
    request(server())
      .patch(`${ADMIN}/${enc(id)}`)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));
  const retire = (headers: Headers, id: string) => request(server()).post(`${ADMIN}/${enc(id)}/retire`).set(headers);
  const matrix = (headers: Headers, object: string) =>
    request(server()).get(`${MATRIX}?object=${enc(object)}`).set(headers);

  /** A picklist body with `n` values v0001.. */
  const picklistValues = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ value: `v${String(i + from).padStart(4, '0')}`, label: `Value ${i + from}` }));

  const tierBody = (extra: Json = {}): Json => ({
    objectApiName: 'contact',
    apiName: 'tier__c',
    label: 'T-0089 tier',
    type: 'picklist',
    config: { values: [{ value: 'gold', label: 'Gold' }, { value: 'silver', label: 'Silver' }] },
    ...extra,
  });

  /** Creates through the API (the control most tests open with) and returns the definition. */
  async function created(body: Json, headers: Headers = SUPERVISOR): Promise<Json> {
    return expectDefinition(await create(headers, body), 201, `create ${String(body.apiName)}`);
  }

  // --- observer helpers ----------------------------------------------------

  interface FieldRow {
    id: string;
    tenant_id: string;
    object: string;
    api_name: string;
    label: string;
    description: string | null;
    type: string;
    classification: string;
    is_custom: boolean;
    is_required: boolean;
    config: Json;
    retired_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }

  async function fieldRow(id: string): Promise<FieldRow | null> {
    const rows = await observer.query<FieldRow>(
      `SELECT f.*, o.api_name AS object FROM field_def f
         JOIN object_def o ON o.id = f.object_id AND o.tenant_id = f.tenant_id
        WHERE f.id = $1`,
      [id],
    );
    return rows.rows[0] ?? null;
  }

  async function customCount(tenantId = TENANT_A): Promise<number> {
    const rows = await observer.query<{ n: string }>(
      'SELECT count(*) AS n FROM field_def WHERE tenant_id = $1 AND is_custom',
      [tenantId],
    );
    return Number(rows.rows[0]?.n);
  }

  async function objectId(object: string, tenantId = TENANT_A): Promise<string> {
    const rows = await observer.query<{ id: string }>(
      'SELECT id FROM object_def WHERE tenant_id = $1 AND api_name = $2',
      [tenantId, object],
    );
    return must(rows.rows[0]?.id, `no ${object} object_def in ${tenantId}`);
  }

  async function plantField(
    id: string,
    object: string,
    apiName: string,
    type = 'text',
    config: Json = {},
    tenantId = TENANT_A,
  ): Promise<void> {
    await observer.query(
      `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification, is_custom, config)
       VALUES ($1, $2, $3, $4, $5, $6, 'none', true, $7::jsonb)`,
      [id, tenantId, await objectId(object, tenantId), apiName, `T-0089 ${apiName}`, type, JSON.stringify(config)],
    );
  }

  async function standardFieldId(object: string, apiName: string): Promise<string> {
    const rows = await observer.query<{ id: string }>(
      `SELECT f.id FROM field_def f JOIN object_def o ON o.id = f.object_id
        WHERE f.tenant_id = $1 AND o.api_name = $2 AND f.api_name = $3 AND NOT f.is_custom`,
      [TENANT_A, object, apiName],
    );
    return must(rows.rows[0]?.id, `no standard ${object}.${apiName}`);
  }

  async function assign(userId: string, programmeId: string, key: string) {
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id) DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, TENANT_A, permissionSet(TENANT_A, key)],
    );
  }

  async function setTenantAdmin(userId: string, value: boolean) {
    await observer.query('UPDATE "user" SET is_tenant_admin = $1 WHERE id = $2', [value, userId]);
  }

  interface AuditRow {
    id: string;
    action: string;
    object_type: string;
    object_id: string | null;
    object_label: string;
    programme_id: string | null;
    actor_user_id: string | null;
    changes: { field: string; before?: unknown; after?: unknown; redacted?: unknown }[];
  }

  async function auditIds(): Promise<Set<string>> {
    const rows = await observer.query<{ id: string }>('SELECT id FROM audit_event');
    return new Set(rows.rows.map((row) => row.id));
  }

  async function auditSince(before: Set<string>): Promise<AuditRow[]> {
    const rows = await observer.query<AuditRow>('SELECT * FROM audit_event ORDER BY occurred_at');
    return rows.rows.filter((row) => !before.has(row.id));
  }

  /** The matrix row of one field as { set key -> level }. */
  async function matrixLevels(object: string, apiName: string): Promise<Record<string, string>> {
    const response = await matrix(SUPERVISOR, object);
    expect(response.status, `matrix: ${response.text}`).toBe(200);
    const rows = (response.body as { rows?: { fieldApiName: string; cells: { permissionSetId: string; level: string }[] }[] }).rows ?? [];
    const row = rows.find((r) => r.fieldApiName === apiName);
    expect(row, `the ${object} matrix has no row for ${apiName}`).toBeDefined();
    return Object.fromEntries((row?.cells ?? []).map((cell) => [cell.permissionSetId, cell.level]));
  }

  // =========================================================================
  // 0. The contract and this file's checker
  // =========================================================================

  it('(self-check) the schema checker passes the contract’s list example and fails single-fault copies of it', () => {
    const op = adminOperation('listCustomFields');
    const example = ((((op.responses as Json)['200'] as Json).content as Json)['application/json'] as Json).example as Json;
    expect(schemaErrors(LIST, example, 'example')).toEqual([]);
    const items = example.items as Json[];
    const first = must(items[0], 'example item');
    const { retiredAt: _dropped, ...withoutRetiredAt } = first;
    expect(_dropped === undefined, 'the example item carries retiredAt').toBe(false);
    const mutants: [string, Json][] = [
      ['a value in a definition', { ...example, items: [{ ...first, value: 'x' }] }],
      ['no retiredAt', { ...example, items: [withoutRetiredAt] }],
      ['a refused type', { ...example, items: [{ ...first, type: 'textarea' }] }],
      ['a name without __c', { ...example, items: [{ ...first, apiName: 'alternate_name' }] }],
      ['a different limit', { ...example, limits: { fieldsPerObject: 200, picklistValues: 500, bytesPerRecord: 32768 } }],
      ['a record count', { ...example, items: [{ ...first, recordCount: 3 }] }],
    ];
    for (const [label, mutant] of mutants) {
      expect(schemaErrors(LIST, mutant, label), label).not.toEqual([]);
    }
  });

  it('the four admin operations are x-kasuwa-implemented: true (served)', () => {
    for (const id of ['listCustomFields', 'createCustomField', 'updateCustomField', 'retireCustomField']) {
      expect(adminOperation(id)['x-kasuwa-implemented'], id).toBe(true);
    }
  });

  // =========================================================================
  // 1. listCustomFields
  // =========================================================================

  describe('listCustomFields', () => {
    it.each(OBJECTS)('%s: an object with no custom field lists none, with the limits as data', async (object) => {
      const response = await list(SUPERVISOR, object);
      expect(response.status, response.text).toBe(200);
      expect(schemaErrors(LIST, response.body, 'list')).toEqual([]);
      expect(response.body).toEqual({
        objectApiName: object,
        // A8 (D-L140, D-L141): the five limits, exactly.
        limits: { apiBytes: 16384, bytesPerRecord: 32768, definitionsPerObject: 500, fieldsPerObject: 100, picklistValues: 500 },
        items: [],
      });
    });

    it('lists the object’s ACTIVE custom fields by apiName by default; includeRetired=true adds the retired ones; nothing else: no standard field, no other object, no other tenant (D-L140)', async () => {
      await created(tierBody({ apiName: 'zeta__c', type: 'text', config: undefined }));
      const alpha = await created(tierBody({ apiName: 'alpha__c' }));
      await created(tierBody({ apiName: 'mid__c', type: 'boolean', config: undefined }));
      await created(tierBody({ objectApiName: 'account', apiName: 'other_object__c', type: 'date', config: undefined }));
      await plantField(id89('a0000b01'), 'contact', 'tenant_b_only__c', 'text', {}, TENANT_B);
      expectDefinition(await retire(SUPERVISOR, String(alpha.id)), 200, 'retire alpha');

      const names = async (path: string) => {
        const response = await request(server()).get(path).set(AGENT_1);
        expect(response.status, `${path}: ${response.text}`).toBe(200);
        expect(schemaErrors(LIST, response.body, path)).toEqual([]);
        return (response.body as { items: Json[] }).items;
      };
      const active = await names(`${ADMIN}?object=contact`);
      expect(active.map((item) => item.apiName), 'default').toEqual(['mid__c', 'zeta__c']);
      expect(active.every((item) => item.retiredAt === null)).toBe(true);
      expect((await names(`${ADMIN}?object=contact&includeRetired=false`)).map((i) => i.apiName)).toEqual(['mid__c', 'zeta__c']);
      const all = await names(`${ADMIN}?object=contact&includeRetired=true`);
      expect(all.map((item) => item.apiName)).toEqual(['alpha__c', 'mid__c', 'zeta__c']);
      expect(all.find((item) => item.apiName === 'alpha__c')?.retiredAt).toEqual(expect.stringMatching(DATE_TIME));
      expect(all.find((item) => item.apiName === 'mid__c')?.retiredAt).toBeNull();
    });

    it('needs no permission: an agent and a user with no programme both read it; no session is 401', async () => {
      await created(tierBody());
      for (const [label, headers] of [['agent', AGENT_1], ['no programme', ACTOR]] as const) {
        const response = await list(headers, 'contact');
        expect(response.status, `${label}: ${response.text}`).toBe(200);
        expect((response.body as { items: Json[] }).items.map((i) => i.apiName), label).toEqual(['tier__c']);
      }
      expectError(await request(server()).get(`${ADMIN}?object=contact`), 401, 'not_authenticated', 'no session');
    });

    it('(A4) an object outside the four, or none at all, is 400', async () => {
      await created(tierBody());
      for (const object of ['lead', 'widget', 'Contact', 'contact__c', '']) {
        expectError(await list(SUPERVISOR, object), 400, 'validation_failed', `object=${object}`);
      }
      expectError(await list(SUPERVISOR), 400, 'validation_failed', 'no object');
    });

    it('tenant B sees none of tenant A’s fields', async () => {
      await created(tierBody());
      const response = await list(TENANT_B_ADMIN, 'contact');
      expect(response.status, response.text).toBe(200);
      expect((response.body as { items: Json[] }).items).toEqual([]);
    });
  });

  // =========================================================================
  // 2. createCustomField
  // =========================================================================

  describe('createCustomField', () => {
    const SIX: [string, Json | undefined, Json][] = [
      ['text', undefined, {}],
      ['number', undefined, {}],
      ['currency', { currencyCode: 'GHS' }, { currencyCode: 'GHS' }],
      ['date', undefined, {}],
      ['picklist', { values: [{ value: 'a1', label: 'A one' }] }, { values: [{ value: 'a1', label: 'A one' }] }],
      ['boolean', undefined, {}],
    ];

    it.each(OBJECTS)('%s: each of the six types is created, served as the contract’s definition and stored custom on its object', async (object) => {
      for (const [type, config, served] of SIX) {
        const apiName = `t_${type}__c`;
        const before = Date.now();
        const body = await created({
          objectApiName: object,
          apiName,
          label: `T-0089 ${type}`,
          type,
          ...(config === undefined ? {} : { config }),
        });
        expect(body).toMatchObject({
          objectApiName: object,
          apiName,
          label: `T-0089 ${type}`,
          description: null,
          type,
          classification: 'none',
          config: served,
          retiredAt: null,
        });
        expect(Math.abs(Date.parse(String(body.createdAt)) - before)).toBeLessThan(SKEW_MS);
        const row = must(await fieldRow(String(body.id)), `field ${apiName} not stored`);
        expect({ object: row.object, api_name: row.api_name, type: row.type, is_custom: row.is_custom, is_required: row.is_required }).toEqual({
          object,
          api_name: apiName,
          type,
          is_custom: true,
          is_required: false,
        });
      }
    });

    it('an apiName without the __c rule is 400 invalid_api_name at apiName, and nothing is written', async () => {
      await created(tierBody({ apiName: 'control__c' }));
      const before = await customCount();
      const names = [
        'tier',
        'Tier__c',
        'tier__C',
        '1tier__c',
        '_tier__c',
        'ti-er__c',
        'ti er__c',
        'tier__c_',
        'status',
        'tíer__c',
        `${'a'.repeat(61)}__c`,
      ];
      for (const apiName of names) {
        expectDetail(await create(SUPERVISOR, tierBody({ apiName })), 400, 'validation_failed', 'invalid_api_name', ['apiName'], apiName);
      }
      expect(await customCount()).toBe(before);
    });

    it('every refused type is 400 unsupported_type at type, and nothing is written', async () => {
      await created(tierBody({ apiName: 'control__c' }));
      const before = await customCount();
      for (const type of ['textarea', 'datetime', 'multipicklist', 'lookup', 'formula', 'rollup', 'phone', 'email', 'url', 'nin', 'bogus']) {
        expectDetail(
          await create(SUPERVISOR, { objectApiName: 'contact', apiName: 'refused__c', label: 'T-0089 refused', type }),
          400,
          'validation_failed',
          'unsupported_type',
          ['type'],
          type,
        );
      }
      expect(await customCount()).toBe(before);
    });

    it('config is validated against the type (A2), and nothing is written', async () => {
      await created(tierBody({ apiName: 'control__c' }));
      const before = await customCount();
      const base = { objectApiName: 'contact', apiName: 'cfg__c', label: 'T-0089 config' };
      const cases: [string, Json, string, string[]][] = [
        ['picklist with no config', { ...base, type: 'picklist' }, 'invalid_config', ['config', 'config.values']],
        ['picklist with no values', { ...base, type: 'picklist', config: { values: [] } }, 'invalid_config', ['config', 'config.values']],
        ['picklist with 501 values (A2, D-L141)', { ...base, type: 'picklist', config: { values: picklistValues(501) } }, 'invalid_config', ['config.values']],
        ['a repeated picklist value', { ...base, type: 'picklist', config: { values: [{ value: 'a1', label: 'A' }, { value: 'a1', label: 'B' }] } }, 'duplicate_value', ['config.values']],
        ['currency with no config', { ...base, type: 'currency' }, 'invalid_config', ['config', 'config.currencyCode']],
        ['currency USD', { ...base, type: 'currency', config: { currencyCode: 'USD' } }, 'unknown_currency', ['config.currencyCode']],
        ['currency EUR', { ...base, type: 'currency', config: { currencyCode: 'EUR' } }, 'unknown_currency', ['config.currencyCode']],
        ['text with values', { ...base, type: 'text', config: { values: [{ value: 'a1', label: 'A' }] } }, 'invalid_config', ['config']],
        ['boolean with a currency', { ...base, type: 'boolean', config: { currencyCode: 'NGN' } }, 'invalid_config', ['config']],
        ['currency with values', { ...base, type: 'currency', config: { values: [{ value: 'a1', label: 'A' }] } }, 'invalid_config', ['config', 'config.currencyCode']],
      ];
      for (const [label, body, code, paths] of cases) {
        expectDetail(await create(SUPERVISOR, body), 400, 'validation_failed', code, paths, label);
      }
      expect(await customCount()).toBe(before);
    });

    it('the body is closed: isRequired, programmeId, id, retiredAt, tenantId and an unknown key are each 400', async () => {
      await created(tierBody({ apiName: 'control__c' }));
      const before = await customCount();
      for (const extra of [
        { isRequired: false },
        { programmeId: PROGRAMME_A1 },
        { id: id89('a0000c01') },
        { retiredAt: null },
        { tenantId: TENANT_A },
        { colour: 'red' },
      ]) {
        expectError(await create(SUPERVISOR, tierBody({ apiName: 'closed__c', ...extra })), 400, 'validation_failed', JSON.stringify(extra));
      }
      expect(await customCount()).toBe(before);
    });

    it('a taken apiName is 409 duplicate_code at apiName; the same name on another object or in another tenant is not', async () => {
      await created(tierBody());
      const conflict = await create(SUPERVISOR, tierBody({ type: 'text', config: undefined, label: 'T-0089 other' }));
      const body = expectDetail(conflict, 409, 'duplicate_code', 'duplicate', ['apiName'], 'duplicate');
      expect(JSON.stringify(body), 'the answer names the existing field').not.toContain('T-0089 tier');
      await created(tierBody({ objectApiName: 'deal' }));
      await created(tierBody(), TENANT_B_ADMIN);
    });

    it('the 101st active field of an object is 409 field_limit_reached; retiring one frees a place; other objects are unaffected', async () => {
      // 100 live custom fields on contact, planted; one more on account.
      for (let i = 0; i < 100; i += 1) {
        await plantField(id89(`b${String(i).padStart(7, '0')}`), 'contact', `planted_${i}__c`);
      }
      const accountField = await created(tierBody({ objectApiName: 'account', apiName: 'acc_control__c' }));
      expect(accountField.id).toEqual(expect.stringMatching(UUID));
      const before = await customCount();
      expectDetail(await create(SUPERVISOR, tierBody()), 409, 'limit_reached', 'field_limit_reached', ['objectApiName'], '101st');
      expect(await customCount()).toBe(before);
      expectDefinition(await retire(SUPERVISOR, id89('b0000000')), 200, 'retire one');
      await created(tierBody());
      expectDetail(await create(SUPERVISOR, tierBody({ apiName: 'one_more__c' })), 409, 'limit_reached', 'field_limit_reached', ['objectApiName'], 'again at 100');
    });

    it('(D-L140) at most 500 definitions per object counting retired ones: 450 retired and 50 live is full; another object is not', async () => {
      for (let i = 0; i < 500; i += 1) {
        await plantField(id89(`b${String(i).padStart(7, '0')}`), 'contact', `planted_${i}__c`);
      }
      await observer.query(
        `UPDATE field_def SET retired_at = now() WHERE tenant_id = $1 AND api_name LIKE 'planted\\_%' AND api_name <> ALL ($2::text[])`,
        [TENANT_A, Array.from({ length: 50 }, (_, i) => `planted_${i}__c`)],
      );
      const live = await observer.query<{ n: string }>(
        `SELECT count(*) AS n FROM field_def WHERE tenant_id = $1 AND is_custom AND retired_at IS NULL`,
        [TENANT_A],
      );
      // Not vacuous: only 50 are active, far under the 100.
      expect(Number(live.rows[0]?.n)).toBe(50);
      const before = await customCount();
      expectDetail(await create(SUPERVISOR, tierBody()), 409, 'limit_reached', 'field_limit_reached', ['objectApiName'], '501st definition');
      expect(await customCount()).toBe(before);
      await created(tierBody({ objectApiName: 'account' }));
    });

    it('custom_field.write is the tenant-admin flag: an agent, and a programme admin without the flag, get 403 and nothing is written', async () => {
      await created(tierBody({ apiName: 'control__c' }));
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'admin');
      const before = await customCount();
      for (const [label, headers] of [['agent', AGENT_1], ['admin set, no flag', ACTOR]] as const) {
        expectError(await create(headers, tierBody()), 403, 'not_permitted', label);
      }
      expect(await customCount()).toBe(before);
      await setTenantAdmin(USER_A_NO_PROGRAMME, true);
      await created(tierBody(), ACTOR);
    });

    it('(D-L128 Q2) a pii or sensitive field starts at none for every unlocked set, a tenant-made set included; admin stays edit; a none field is edit for all', async () => {
      await observer.query(
        `INSERT INTO permission_set (id, tenant_id, key, label, locked, sort_order)
         VALUES ($1, $2, 't0089_custom_set', 'T-0089 custom set', false, 90)`,
        [id89('a0000d01'), TENANT_A],
      );
      await created(tierBody({ apiName: 'plain__c', type: 'text', config: undefined }));
      await created(tierBody({ apiName: 'personal__c', type: 'text', config: undefined, classification: 'pii' }));
      await created(tierBody({ apiName: 'secret__c', type: 'number', config: undefined, classification: 'sensitive' }));
      const sets = await observer.query<{ key: string; locked: boolean }>(
        'SELECT key, locked FROM permission_set WHERE tenant_id = $1 ORDER BY key',
        [TENANT_A],
      );
      // Not vacuous: the catalogue plus the planted set.
      expect(sets.rows.length).toBeGreaterThan(4);
      const expectAll = (level: (locked: boolean) => string) =>
        Object.fromEntries(sets.rows.map((set) => [set.key, level(set.locked)]));
      expect(await matrixLevels('contact', 'personal__c')).toEqual(expectAll((locked) => (locked ? 'edit' : 'none')));
      expect(await matrixLevels('contact', 'secret__c')).toEqual(expectAll((locked) => (locked ? 'edit' : 'none')));
      expect(await matrixLevels('contact', 'plain__c')).toEqual(expectAll(() => 'edit'));
    });

    it('is audited once, tenant-level, naming the api name, type and classification (A5); a refused create writes no event', async () => {
      const before = await auditIds();
      const body = await created(tierBody({ classification: 'pii' }));
      const events = await auditSince(before);
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event).toMatchObject({
        action: 'created',
        object_type: 'custom_field',
        object_id: body.id,
        programme_id: null,
        actor_user_id: USER_A_SUPERVISOR,
      });
      const text = JSON.stringify({ label: event?.object_label, changes: event?.changes });
      for (const word of ['tier__c', 'picklist', 'pii']) expect(text, `the event does not name ${word}`).toContain(word);
      const refused = await auditIds();
      expectError(await create(SUPERVISOR, tierBody()), 409, 'duplicate_code', 'refused');
      expectError(await create(AGENT_1, tierBody({ apiName: 'agent_try__c' })), 403, 'not_permitted', 'refused');
      expect(await auditSince(refused)).toEqual([]);
    });
  });

  // =========================================================================
  // 3. updateCustomField
  // =========================================================================

  describe('updateCustomField', () => {
    it('relabels, redescribes, adds values in order and relabels a value; updatedAt moves, createdAt and type do not (A6)', async () => {
      const field = await created(tierBody());
      const updated = expectDefinition(
        await update(SUPERVISOR, String(field.id), {
          label: 'T-0089 service tier',
          description: 'T-0089 described',
          addValues: [{ value: 'platinum', label: 'Platinum' }, { value: 'bronze', label: 'Bronze' }],
          relabelValues: [{ value: 'gold', label: 'Gold plus' }],
        }),
        200,
        'update',
      );
      expect(updated).toMatchObject({
        id: field.id,
        apiName: 'tier__c',
        type: 'picklist',
        label: 'T-0089 service tier',
        description: 'T-0089 described',
        createdAt: field.createdAt,
        config: {
          values: [
            { value: 'gold', label: 'Gold plus' },
            { value: 'silver', label: 'Silver' },
            { value: 'platinum', label: 'Platinum' },
            { value: 'bronze', label: 'Bronze' },
          ],
        },
      });
      expect(Date.parse(String(updated.updatedAt))).toBeGreaterThanOrEqual(Date.parse(String(field.updatedAt)));
      const row = must(await fieldRow(String(field.id)), 'row');
      expect(row.label).toBe('T-0089 service tier');
      expect(row.type).toBe('picklist');
    });

    it('value errors are 400 at their paths and nothing is applied: not_a_picklist, unknown_value, duplicate_value (existing and within the body)', async () => {
      const tier = await created(tierBody());
      const text = await created(tierBody({ apiName: 'note__c', type: 'text', config: undefined }));
      const cases: [string, string, Json, string, string][] = [
        ['addValues on text', String(text.id), { addValues: [{ value: 'a1', label: 'A' }] }, 'not_a_picklist', 'addValues'],
        ['relabelValues on text', String(text.id), { relabelValues: [{ value: 'a1', label: 'A' }] }, 'not_a_picklist', 'addValues'],
        ['relabel an unknown value', String(tier.id), { relabelValues: [{ value: 'diamond', label: 'D' }] }, 'unknown_value', 'relabelValues'],
        ['add an existing value', String(tier.id), { addValues: [{ value: 'gold', label: 'Gold again' }] }, 'duplicate_value', 'addValues'],
        ['add one value twice', String(tier.id), { addValues: [{ value: 'iron', label: 'I' }, { value: 'iron', label: 'I2' }] }, 'duplicate_value', 'addValues'],
      ];
      for (const [label, id, body, code, path] of cases) {
        const paths = label === 'relabelValues on text' ? ['addValues', 'relabelValues'] : [path];
        expectDetail(await update(SUPERVISOR, id, { label: 'T-0089 should not stick', ...body }), 400, 'validation_failed', code, paths, label);
      }
      expect((await fieldRow(String(tier.id)))?.config).toEqual(tierBody().config);
      expect((await fieldRow(String(tier.id)))?.label).toBe('T-0089 tier');
      expect((await fieldRow(String(text.id)))?.label).toBe('T-0089 tier');
    });

    it('a picklist pushed past 500 values is 409 picklist_limit_reached and nothing is applied; exactly 500 is accepted', async () => {
      const field = await created(tierBody({ config: { values: picklistValues(499) } }));
      expectDetail(
        await update(SUPERVISOR, String(field.id), { addValues: picklistValues(2, 600) }),
        409,
        'limit_reached',
        'picklist_limit_reached',
        ['addValues'],
        '501',
      );
      expect(((await fieldRow(String(field.id)))?.config.values as unknown[]).length).toBe(499);
      const ok = expectDefinition(await update(SUPERVISOR, String(field.id), { addValues: picklistValues(1, 600) }), 200, '500');
      expect(((ok.config as Json).values as unknown[]).length).toBe(500);
    });

    it('the body is closed and non-empty: type, apiName, objectApiName, config, values, removeValues, retiredAt and {} are each 400; nothing changes', async () => {
      const field = await created(tierBody({ type: 'currency', config: { currencyCode: 'NGN' } }));
      for (const body of [
        { type: 'number' },
        { apiName: 'renamed__c' },
        { objectApiName: 'account' },
        { config: { currencyCode: 'GHS' } },
        { values: [{ value: 'a1', label: 'A' }] },
        { removeValues: ['gold'] },
        { retiredAt: null },
        {},
      ]) {
        expectError(await update(SUPERVISOR, String(field.id), { ...body }), 400, 'validation_failed', JSON.stringify(body));
      }
      const row = must(await fieldRow(String(field.id)), 'row');
      expect({ type: row.type, api_name: row.api_name, object: row.object, config: row.config, retired_at: row.retired_at }).toEqual({
        type: 'currency',
        api_name: 'tier__c',
        object: 'contact',
        config: { currencyCode: 'NGN' },
        retired_at: null,
      });
    });

    it('classification moves both ways, is audited by key with before and after, and never rewrites the matrix', async () => {
      const plain = await created(tierBody({ apiName: 'plain__c', type: 'text', config: undefined }));
      const personal = await created(tierBody({ apiName: 'personal__c', type: 'text', config: undefined, classification: 'pii' }));
      const plainBefore = await matrixLevels('contact', 'plain__c');
      const personalBefore = await matrixLevels('contact', 'personal__c');

      const before = await auditIds();
      const raised = expectDefinition(await update(SUPERVISOR, String(plain.id), { classification: 'sensitive' }), 200, 'raise');
      expect(raised.classification).toBe('sensitive');
      const lowered = expectDefinition(await update(SUPERVISOR, String(personal.id), { classification: 'none' }), 200, 'lower');
      expect(lowered.classification).toBe('none');

      expect(await matrixLevels('contact', 'plain__c'), 'raising reset the matrix').toEqual(plainBefore);
      expect(await matrixLevels('contact', 'personal__c'), 'lowering reset the matrix').toEqual(personalBefore);

      const events = await auditSince(before);
      expect(events.map((e) => [e.action, e.object_type, e.object_id, e.programme_id])).toEqual([
        ['updated', 'custom_field', plain.id, null],
        ['updated', 'custom_field', personal.id, null],
      ]);
      const raise = JSON.stringify(events[0]?.changes);
      expect(raise).toContain('classification');
      expect(raise).toContain('"none"');
      expect(raise).toContain('"sensitive"');
    });

    it('a retired field cannot be changed: 400 field_retired at fieldId, nothing applied, no event', async () => {
      const field = await created(tierBody());
      expectDefinition(await retire(SUPERVISOR, String(field.id)), 200, 'retire');
      const before = await auditIds();
      for (const body of [{ label: 'T-0089 after retire' }, { addValues: [{ value: 'late', label: 'Late' }] }, { classification: 'pii' }]) {
        expectDetail(await update(SUPERVISOR, String(field.id), body), 400, 'validation_failed', 'field_retired', ['fieldId'], JSON.stringify(body));
      }
      const row = must(await fieldRow(String(field.id)), 'row');
      expect([row.label, row.classification, (row.config.values as unknown[]).length]).toEqual(['T-0089 tier', 'none', 2]);
      expect(await auditSince(before)).toEqual([]);
    });

    it('needs the tenant-admin flag: an agent and a programme admin without it get 403; nothing changes', async () => {
      const field = await created(tierBody());
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'admin');
      for (const [label, headers] of [['agent', AGENT_1], ['admin set, no flag', ACTOR]] as const) {
        expectError(await update(headers, String(field.id), { label: 'T-0089 hijack' }), 403, 'not_permitted', label);
        expectError(await retire(headers, String(field.id)), 403, 'not_permitted', `${label} retire`);
      }
      const row = must(await fieldRow(String(field.id)), 'row');
      expect([row.label, row.retired_at]).toEqual(['T-0089 tier', null]);
    });
  });

  // =========================================================================
  // 4. retireCustomField
  // =========================================================================

  describe('retireCustomField', () => {
    it('sets retiredAt, keeps the row, audits once; a repeat answers 200 with the first retiredAt and no second event', async () => {
      const field = await created(tierBody());
      const before = await auditIds();
      const t0 = Date.now();
      const first = expectDefinition(await retire(SUPERVISOR, String(field.id)), 200, 'retire');
      expect(first.retiredAt).toEqual(expect.stringMatching(DATE_TIME));
      expect(Math.abs(Date.parse(String(first.retiredAt)) - t0)).toBeLessThan(SKEW_MS);
      const row = must(await fieldRow(String(field.id)), 'the field was deleted, not retired');
      expect(row.retired_at).not.toBeNull();

      const events = await auditSince(before);
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event).toMatchObject({ object_type: 'custom_field', object_id: field.id, programme_id: null });
      expect(event?.action, `(A1, D-L141) the retire event is ${JSON.stringify(event)}`).toBe('updated');
      expect(
        (event?.changes ?? []).some((change) => change.field === 'retiredAt'),
        `(A1, D-L141) the retire event names no retiredAt change: ${JSON.stringify(event?.changes)}`,
      ).toBe(true);

      const afterFirst = await auditIds();
      const repeat = expectDefinition(await retire(SUPERVISOR, String(field.id)), 200, 'repeat');
      expect(repeat.retiredAt).toBe(first.retiredAt);
      expect(repeat).toEqual(first);
      expect(await auditSince(afterFirst)).toEqual([]);
    });

    it('a retired name stays taken: creating it again is the same 409 body as a live duplicate', async () => {
      const live = await created(tierBody({ apiName: 'live__c' }));
      const gone = await created(tierBody({ apiName: 'gone__c' }));
      expectDefinition(await retire(SUPERVISOR, String(gone.id)), 200, 'retire');
      const liveDup = await create(SUPERVISOR, tierBody({ apiName: 'live__c', type: 'boolean', config: undefined }));
      const goneDup = await create(SUPERVISOR, tierBody({ apiName: 'gone__c', type: 'boolean', config: undefined }));
      expectDetail(goneDup, 409, 'duplicate_code', 'duplicate', ['apiName'], 'retired name');
      expect(goneDup.text, 'the answer tells a retired name from a live one').toBe(liveDup.text);
      expect(live.id).toEqual(expect.stringMatching(UUID));
    });

    it('(A7) there is no delete: DELETE answers no 2xx and the field stays', async () => {
      const field = await created(tierBody());
      const response = await request(server()).delete(`${ADMIN}/${enc(String(field.id))}`).set(SUPERVISOR);
      expect(response.status >= 200 && response.status < 300, `DELETE answered ${response.status}`).toBe(false);
      expect(await fieldRow(String(field.id))).not.toBeNull();
    });
  });

  // =========================================================================
  // 5. Out of scope is one 404
  // =========================================================================

  describe('out of scope is one 404 body (CLAUDE.md 6.4)', () => {
    it('another tenant’s field, a standard field, a custom object’s field (A3) and an invented id: one body, on update and on retire, and nothing changes', async () => {
      const control = await created(tierBody());
      await plantField(id89('a0000e01'), 'contact', 'b_field__c', 'text', {}, TENANT_B);
      const widget = id89('a0000e10');
      await observer.query(
        `INSERT INTO object_def (id, tenant_id, api_name, label, plural_label, is_custom)
         VALUES ($1, $2, 'widget', 'Widget', 'Widgets', true)`,
        [widget, TENANT_A],
      );
      await observer.query(
        `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification, is_custom)
         VALUES ($1, $2, $3, 'colour__c', 'T-0089 colour', 'text', 'none', true)`,
        [id89('a0000e11'), TENANT_A, widget],
      );
      const targets: [string, string][] = [
        ['another tenant', id89('a0000e01')],
        ['a standard field', await standardFieldId('contact', 'status')],
        ['a custom object’s field', id89('a0000e11')],
        ['nothing', NOWHERE],
      ];
      const bodies = new Set<string>();
      for (const [label, id] of targets) {
        const patched = await update(SUPERVISOR, id, { label: 'T-0089 hijack' });
        expectError(patched, 404, 'not_found', `${label}: update`);
        bodies.add(patched.text);
        const retired = await retire(SUPERVISOR, id);
        expectError(retired, 404, 'not_found', `${label}: retire`);
        bodies.add(retired.text);
      }
      expect([...bodies], 'the 404 bodies differ').toHaveLength(1);
      for (const [, id] of targets) {
        const row = await fieldRow(id);
        expect(row?.label, `${id} was changed`).not.toBe('T-0089 hijack');
        expect(row?.retired_at ?? null).toBeNull();
      }
      expect(control.id).toEqual(expect.stringMatching(UUID));
    });

    it('tenant B’s admin gets the same 404 for tenant A’s field', async () => {
      const field = await created(tierBody());
      const invented = await update(TENANT_B_ADMIN, NOWHERE, { label: 'T-0089 hijack' });
      const foreign = await update(TENANT_B_ADMIN, String(field.id), { label: 'T-0089 hijack' });
      expectError(foreign, 404, 'not_found', 'foreign');
      expect(foreign.text).toBe(invented.text);
      expect((await fieldRow(String(field.id)))?.label).toBe('T-0089 tier');
    });
  });

  // =========================================================================
  // 5b. Check order (D-L140): 401, then 403, then 404, then 400
  // =========================================================================

  describe('check order (D-L140): 401, 403 custom_field.write, 404, 400', () => {
    it('no session is 401 on all four operations, whatever the target', async () => {
      const field = await created(tierBody());
      const anonymous: [string, request.Test][] = [
        ['list', request(server()).get(`${ADMIN}?object=contact`)],
        ['create', request(server()).post(ADMIN).set('Content-Type', 'application/json').send(JSON.stringify({ bogus: true }))],
        ['update', request(server()).patch(`${ADMIN}/${field.id}`).set('Content-Type', 'application/json').send('{}')],
        ['update nowhere', request(server()).patch(`${ADMIN}/${NOWHERE}`).set('Content-Type', 'application/json').send('{}')],
        ['retire', request(server()).post(`${ADMIN}/${field.id}/retire`)],
      ];
      for (const [label, pending] of anonymous) expectError(await pending, 401, 'not_authenticated', label);
    });

    it('a non-admin gets 403 before 404 and before every 400: an invented id, another tenant’s field, a retired field, a repeat retire and an invalid body', async () => {
      const live = await created(tierBody({ apiName: 'live__c' }));
      const gone = await created(tierBody({ apiName: 'gone__c' }));
      expectDefinition(await retire(SUPERVISOR, String(gone.id)), 200, 'retire');
      await plantField(id89('a0000f01'), 'contact', 'b_field__c', 'text', {}, TENANT_B);
      const cases: [string, () => request.Test][] = [
        ['update an invented id', () => update(AGENT_1, NOWHERE, { label: 'T-0089 x' })],
        ['retire an invented id', () => retire(AGENT_1, NOWHERE)],
        ['update another tenant’s field', () => update(AGENT_1, id89('a0000f01'), { label: 'T-0089 x' })],
        ['update a retired field', () => update(AGENT_1, String(gone.id), { label: 'T-0089 x' })],
        ['repeat a retire', () => retire(AGENT_1, String(gone.id))],
        ['update with an invalid body', () => update(AGENT_1, String(live.id), { type: 'number' })],
        ['update with an empty body', () => update(AGENT_1, String(live.id), {})],
        ['create with an invalid body', () => create(AGENT_1, { objectApiName: 'contact', apiName: 'NoSuffix', type: 'textarea' })],
        ['create a duplicate', () => create(AGENT_1, tierBody({ apiName: 'live__c' }))],
      ];
      const before = await auditIds();
      for (const [label, call] of cases) expectError(await call(), 403, 'not_permitted', label);
      expect(await auditSince(before)).toEqual([]);
    });

    it('an admin gets 404 before 400: an invented id with an invalid body is the one 404', async () => {
      await created(tierBody({ apiName: 'control__c' }));
      const plain = await update(SUPERVISOR, NOWHERE, { label: 'T-0089 x' });
      const invalid = await update(SUPERVISOR, NOWHERE, { type: 'number' });
      expectError(plain, 404, 'not_found', 'invented id');
      expectError(invalid, 404, 'not_found', 'invented id, invalid body');
      expect(invalid.text).toBe(plain.text);
    });
  });

  // =========================================================================
  // 6. A new field is live on the records at once
  // =========================================================================

  it('a field created as pii is withheld from an agent at once; a value written by the admin is readable by the admin', async () => {
    await created(tierBody({ apiName: 'personal__c', type: 'text', config: undefined, classification: 'pii' }));
    const written = await request(server())
      .patch(`/api/v1/contacts/${enc(A1_CONTACT.id)}`)
      .set(SUPERVISOR)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ version: await contactVersion(A1_CONTACT.id), custom: { personal__c: 'T-0089 personal' } }));
    expect(written.status, written.text).toBe(200);
    expect((written.body as Json).custom).toEqual({ personal__c: 'T-0089 personal' });
    const agentView = await request(server()).get(`/api/v1/contacts/${enc(A1_CONTACT.id)}`).set(AGENT_1);
    expect(agentView.status, agentView.text).toBe(200);
    expect((agentView.body as Json).custom).toEqual({});
    expect((agentView.body as Json).withheldFields).toContain('custom.personal__c');
    expect(agentView.text).not.toContain('T-0089 personal');
  });

  async function contactVersion(id: string): Promise<number> {
    const rows = await observer.query<{ version: number }>('SELECT version FROM contact WHERE id = $1', [id]);
    return Number(rows.rows[0]?.version);
  }
});
