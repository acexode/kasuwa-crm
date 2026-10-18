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
  SEED_ACCOUNTS,
  SEED_ACTIVITIES,
  SEED_CONTACTS,
  SEED_DEALS,
  SEED_PERMISSION_SETS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import pg, { type Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { parse } from 'yaml';
import { asUser, withAuthDatabase } from '../support/api';
import { collectTelemetry } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0089, custom-field VALUES over the records API: encodings,
 * merge writes, adversarial WITHHOLDING, filters and retired keys (ADR-0016
 * items 3-9; D-L128 Q1, Q2, Q4, Q6; D-L138; D-L139; D-L64, D-L72, D-L80,
 * D-L82, D-L84, D-L88; CLAUDE.md 2.3, 6.1, 6.4). Agent 2 builds it. Written
 * by QA for the lead before the build (D-L23, D-L25), from the T-0088
 * contract and the ADR, not from an implementation.
 *
 * Companion suites: custom-fields-storage (0039), custom-fields-admin-api
 * (definitions) and custom-fields-budget (the 120k filter budget). Helpers
 * are restated, never imported.
 *
 * ==========================================================================
 * PINNED INTERFACES (from the contract; the builder honours these exactly)
 * ==========================================================================
 *
 * WHERE `custom` IS. Every Contact read (getContact, listContacts, listLeads,
 *   listAccountContacts, the create and update answers), every Account read,
 *   every Deal read (getDeal, listDeals, board cards, the create, update and
 *   move answers) and the Activity create and update answers carry `custom`,
 *   always: `{}` when nothing is visible. A value is never `null`. `custom`
 *   is never named in `withheldFields`; a withheld KEY is absent from
 *   `custom` and listed as `custom.<key>`.
 *
 * WRITES. Create bodies take `custom` (values only); update bodies take a
 *   per-key patch (a value sets, `null` removes the key, an absent key is
 *   untouched; `{}` is refused), under the record's `version`.
 *
 * CODES. 400 validation_failed with details (path, code), never a value:
 *     unknown_field      custom.<key>   unknown OR retired key (one code)
 *     invalid_value      custom.<key>   wrong encoding for the field's type
 *     unknown_value      custom.<key>   a well-formed picklist value the
 *                                       field does not define
 *     currency_mismatch  custom.<key>.currency
 *     custom_too_large   custom         over 16 KiB, measured on the keys the
 *                                       caller can READ in the row's
 *                                       programme plus the keys written
 *                                       (D-L140); withheld and retired
 *                                       bytes never count. The 512 KiB
 *                                       database CHECK is a backstop only
 *                                       (D-L142); if it is ever reached it
 *                                       is this same 400, never a 500.
 *     unknown_field      custom         a key failing `^[a-z][a-z0-9_]*__c$`
 *                        (or the query  is reported at `custom` (a filter: at
 *                        parameter)     `custom` / `customEmpty`), never at a
 *                                       path naming it, and is never echoed
 *                                       anywhere in the body (D-L140)
 *     field_withheld     custom.<key>   a filter on a key withheld in ANY
 *                                       programme the caller reaches
 *     filter_not_supported custom.<key> a filter on text/number/currency/date
 *   403 not_permitted, details field_not_editable at custom.<key>: a key not
 *   `edit` for the caller in the row's programme (create: the target
 *   programme). Order (unchanged): 404, 403, 400, 409.
 *
 * FILTERS. `custom[key]=value` (deepObject) and repeatable `customEmpty=key`
 *   on listContacts, listLeads, listAccounts and listDeals; picklist and
 *   boolean only; AND-ed; inside the caller's scope; cursors stay id-only.
 *   No sort on any custom key.
 *
 * FLAGS. Every `custom` property and the two filter parameters in
 *   records.openapi.yaml are `x-kasuwa-implemented: true` once served (a
 *   LEAD EDIT to custom-fields-contract R19, which pins `false` today).
 *
 * ==========================================================================
 * THE WITHHOLDING FIXTURE (section 5)
 * ==========================================================================
 * ACTOR is a tenant admin (so it may write every record type, D-L53) who
 * holds `team_lead` in A1 and `programme_manager` in A2. Field security is
 * judged on the SET in the row's programme, never on the flag (field-access
 * semantics). On every object:
 *   secret__c  text, sensitive    team_lead none,  programme_manager edit
 *   band__c    picklist           team_lead none,  programme_manager read
 *   ro__c      text               team_lead read
 * So `secret__c` and `band__c` are withheld from ACTOR in A1 and readable in
 * A2. Each A1 record holds MARK_A1 in `secret__c`; each A2 record MARK_A2.
 *
 * ==========================================================================
 * RULINGS where the contract or ADR is silent (this suite's; the lead may
 * reverse them)
 * ==========================================================================
 *
 * V1  A withheld key is listed in `withheldFields` whether or not the row
 *     holds a value for it. Listing it only when a value exists would make
 *     `withheldFields` a presence oracle for the very value it hides.
 * V2  A RETIRED key is in neither `custom` nor `withheldFields`: it is gone,
 *     not withheld (listing it would be a retired-key oracle).
 * V3  "Never leaves Postgres" (ADR-0016 item 6) is proved by recording every
 *     statement the API sends during a request, with its bound values and
 *     its RESULT rows (a wrapper on `pg.Client.prototype.query`): no row and
 *     no parameter carries a withheld value, on reads AND on writes. A write
 *     may read back the old values of the keys it patches (they are `edit`,
 *     so readable), never the whole `custom`. The control: the same recorder
 *     does see the A2 value when ACTOR reads the A2 row.
 * V4  A write by a caller from whom a key is withheld preserves that key's
 *     stored value (the SQL merge, never a read-modify-write of the visible
 *     part). RULED (T-0089, D-L142 lead edit; this said a retired value
 *     survives): every custom WRITE drops retired keys from the row, so a
 *     retired value is gone once its row is written; a row nobody writes
 *     keeps it (the purge of untouched rows is a later task).
 * V5  The 403 for a withheld or read-only key comes before every 400 on the
 *     same body (the published order), so a bad value for a key one may not
 *     edit is 403, never `invalid_value`.
 * V6  Retired and unknown keys answer byte-identical bodies once the key's
 *     name is replaced by a placeholder (the path necessarily names the key).
 * V7  `q` on the lists, and global search, never match a custom value,
 *     withheld or not (ADR-0016 item 8: search does not search custom).
 * V8  The 16 KiB rule (D-L140) is tested away from its boundary (about
 *     15.1 KB accepted, about 18.1 KB refused), so the API may measure with
 *     either JSON serialisation; the 32 KiB database boundary is the storage
 *     suite's. The withheld-bytes probe uses a realistic near-maximum value
 *     (1,000 four-octet characters, 4,000 octets), so the verdict flips on
 *     whether withheld bytes are counted. When a row's visible part is
 *     already over 16 KiB (because another reader filled keys this caller
 *     can see), a write that grows that view is refused. RULED (D-L141
 *     ruling 7): a write that only removes keys, or does not grow the
 *     caller-visible size (a same-size replacement, a shrink), is never
 *     refused for size, even on a row already over the limit.
 * V15 RULED (D-L141 ruling 6): audit READS may show custom KEY names
 *     (definitions are tenant-public); they never show a custom value. This
 *     suite asserts the second and never the absence of a key.
 * V14 (D-L140) Custom values are never logged or traced, whatever the
 *     classification: a `none` text value is held to the same rule as a
 *     sensitive one.
 * V9  Field definitions are read live: a definition, grant or retirement
 *     committed by another process is in force on the next request (ADR-0016
 *     item 3, "the live custom field_defs"). The fixture plants definitions
 *     with kasuwa_migrator between requests, which a stale per-process cache
 *     fails.
 * V10 A filter value outside a picklist's values, or a boolean filter value
 *     other than `true`/`false`, is the builder's (not asserted). A sort on a
 *     custom key is a 400 like any unknown sort.
 * V11 The contact timeline carries no custom change at all (its
 *     FieldChangedItem enums admit no custom key), so an audited custom
 *     change must not surface there, and the page must still validate.
 * V12 On the board, each CARD lists its withheld custom keys in its own
 *     `withheldFields`; the board's top-level `withheldFields` is
 *     DealWithheldField only (the contract admits no custom path there), so
 *     the whole board still validates against getPipelineBoard's schema.
 * V13 Activities have no read of their own: their withholding is judged on
 *     the createActivity and updateActivity answers, and the activity items
 *     of the timelines carry no `custom` (ActivityItem is closed).
 *
 * D-L142 (lead edits, T-0089 review rulings), pinned here:
 *   - a backstop 23514 (a non-API writer filled the row) is 400
 *     custom_too_large, byte for byte the API-limit refusal, never a 500;
 *   - every custom write drops retired keys (V4);
 *   - the size is measured under a row lock: two concurrent writes that
 *     together pass 16 KiB never both land; the loser is custom_too_large;
 *   - a lone UTF-16 surrogate in a text value is 400 invalid_value;
 *   - a filter on a withheld key is still field_withheld (section 5 already
 *     pins it; no new test).
 *
 * ==========================================================================
 * D-L23: on this branch `custom` is not a column, the bodies are closed
 * against it (400) and the filters are ignored. Every test except those
 * titled "(self-check)" begins with a request or plant that needs the build,
 * and fails there.
 *
 * Fixtures: packages/db/src/fixtures.ts, plus rows planted by kasuwa_migrator
 * with ids in this suite's range (`11111111-0000-4000-8000-0089xxxxxxxx`).
 * Every planted text is synthetic. Writes: reseed before, after, and after
 * every test.
 */

// ---------------------------------------------------------------------------
// Constants and fixtures (packages/db/src/fixtures.ts, never a second set).
// ---------------------------------------------------------------------------

const SPEC_PATH = resolve(__dirname, '../../../docs/api/records.openapi.yaml');
const id89 = (tail: string) => `11111111-0000-4000-8000-0089${tail.padStart(8, '0')}`;
const RUN = Date.now().toString(36);

const MARK_A1 = `zqwa1${RUN}`;
const MARK_A2 = `zqwa2${RUN}`;
const ECHO = `zqecho${RUN}`;

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);
const AGENT_2 = asUser(TENANT_A, USER_A_AGENT_2);
const ACTOR = asUser(TENANT_A, USER_A_NO_PROGRAMME);

type Json = Record<string, unknown>;
type Headers = Record<string, string>;
type Params = readonly (readonly [string, string])[];

function must<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`Fixture drift: ${what}`);
  return value;
}

function permissionSet(key: string): string {
  return must(
    SEED_PERMISSION_SETS.find((set) => set.tenantId === TENANT_A && set.key === key),
    `no seeded permission set '${key}'`,
  ).id;
}

const contactsIn = (programmeId: string) => SEED_CONTACTS.filter((c) => c.programmeId === programmeId);
const [C1, C1B, C1C] = contactsIn(PROGRAMME_A1).map((c) => c.id) as [string, string, string];
const [C2, C2B, C2C] = contactsIn(PROGRAMME_A2).map((c) => c.id) as [string, string, string];
const ACC1 = must(SEED_ACCOUNTS.find((a) => a.programmeId === PROGRAMME_A1), 'A1 account').id;
const ACC2 = must(SEED_ACCOUNTS.find((a) => a.programmeId === PROGRAMME_A2), 'A2 account').id;
const ACT1 = must(SEED_ACTIVITIES.find((a) => a.programmeId === PROGRAMME_A1), 'A1 activity').id;
const DEAL1 = must(SEED_DEALS.find((d) => d.programmeId === PROGRAMME_A1), 'A1 deal').id;
/** Planted in beforeEach. */
const ACT2 = id89('c0000a02');
const DEAL2 = id89('c0000d02');
const DEAL1B = id89('c0000d03');

const OBJECTS = ['contact', 'account', 'activity', 'deal'] as const;
type ObjectName = (typeof OBJECTS)[number];
const A1_ROW: Record<ObjectName, string> = { contact: C1, account: ACC1, activity: ACT1, deal: DEAL1 };
const A2_ROW: Record<ObjectName, string> = { contact: C2, account: ACC2, activity: ACT2, deal: DEAL2 };

/** The six types, one field each, on every object. */
const TIER_VALUES = ['gold', 'silver', 'bronze'];
interface FieldSpec {
  apiName: string;
  type: string;
  classification: 'none' | 'pii' | 'sensitive';
  config: Json;
}
const FIELDS: readonly FieldSpec[] = [
  { apiName: 'txt__c', type: 'text', classification: 'none', config: {} },
  { apiName: 'num__c', type: 'number', classification: 'none', config: {} },
  { apiName: 'amt__c', type: 'currency', classification: 'none', config: { currencyCode: 'NGN' } },
  { apiName: 'day__c', type: 'date', classification: 'none', config: {} },
  { apiName: 'tier__c', type: 'picklist', classification: 'none', config: { values: TIER_VALUES.map((v) => ({ value: v, label: v.toUpperCase() })) } },
  { apiName: 'vip__c', type: 'boolean', classification: 'none', config: {} },
  { apiName: 'secret__c', type: 'text', classification: 'sensitive', config: {} },
  { apiName: 'band__c', type: 'picklist', classification: 'none', config: { values: [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue' }] } },
  { apiName: 'ro__c', type: 'text', classification: 'none', config: {} },
  { apiName: 'old__c', type: 'picklist', classification: 'none', config: { values: [{ value: 'keep', label: 'Keep' }, { value: 'drop', label: 'Drop' }] } },
];
/** Contact only: twelve text fields for the 16 KiB rule. */
const BIG_FIELDS = Array.from({ length: 12 }, (_, i) => `big${String(i + 1).padStart(2, '0')}__c`);
const GRANTS: readonly [string, string, 'none' | 'read' | 'edit'][] = [
  ['secret__c', 'team_lead', 'none'],
  ['secret__c', 'programme_manager', 'edit'],
  ['band__c', 'team_lead', 'none'],
  ['band__c', 'programme_manager', 'read'],
  ['ro__c', 'team_lead', 'read'],
];

/** A full set of valid values, one per Phase 2 type. */
const VALID_SIX: Json = {
  txt__c: 'T-0089 gold member',
  num__c: '-1234.5',
  amt__c: { amountMinor: '150000', currency: 'NGN' },
  day__c: '2024-02-29',
  tier__c: 'silver',
  vip__c: true,
};

/** Database text an error BODY must never carry. */
const DATABASE_TEXT = ['Failing row contains', 'violates', 'constraint', '23514', '23505', 'jsonb', 'octet_length'];

// ---------------------------------------------------------------------------
// The JSON-Schema checker over the records contract (restated).
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS: Record<string, RegExp> = {
  uuid: UUID,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
};

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

function check(input: Json, file: string, value: unknown, path: string, errors: string[]): void {
  const { schema, file: at } = deref(input, file);
  if (Array.isArray(schema.allOf)) for (const part of schema.allOf as Json[]) check(part, at, value, path, errors);
  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as Json[]).filter((branch) => {
      const e: string[] = [];
      check(branch, at, value, path, e);
      return e.length === 0;
    });
    if (passing.length !== 1) errors.push(`${path}: matches ${passing.length} oneOf branches`);
  }
  if (Array.isArray(schema.anyOf)) {
    const ok = (schema.anyOf as Json[]).some((branch) => {
      const e: string[] = [];
      check(branch, at, value, path, e);
      return e.length === 0;
    });
    if (!ok) errors.push(`${path}: matches no anyOf branch (${JSON.stringify(value)})`);
  }
  if ('const' in schema && schema.const !== value) errors.push(`${path}: not the const`);
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
    if (schema.uniqueItems === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
      errors.push(`${path}: items repeat`);
    }
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
      else if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
        check(schema.additionalProperties as Json, at, child, `${path}.${key}`, errors);
      }
      if (typeof schema.propertyNames === 'object' && schema.propertyNames !== null) {
        check(schema.propertyNames as Json, at, key, `${path}[key ${key}]`, errors);
      }
    }
  }
}

function schemaErrors(schema: Json, value: unknown, where: string): string[] {
  const errors: string[] = [];
  check(schema, SPEC_PATH, value, where, errors);
  return errors;
}

function requireOperation(operationId: string): Json {
  const paths = ((loadDoc(SPEC_PATH) as Json).paths ?? {}) as Record<string, Json>;
  for (const item of Object.values(paths)) {
    for (const op of Object.values(item)) {
      if (typeof op === 'object' && op !== null && (op as Json).operationId === operationId) return op as Json;
    }
  }
  throw new Error(`records.openapi.yaml has no operation ${operationId}`);
}

function responseSchemaOf(operationId: string, status: string): Json {
  const raw = ((requireOperation(operationId).responses ?? {}) as Json)[status] as Json | undefined;
  if (raw === undefined) throw new Error(`${operationId} documents no ${status}`);
  const response = deref(raw, SPEC_PATH).schema;
  return must(
    ((response.content as Json | undefined)?.['application/json'] as Json | undefined)?.schema as Json | undefined,
    `${operationId} ${status} schema`,
  );
}

const CUSTOM_FIELDS = { $ref: '#/components/schemas/CustomFields' };

/**
 * Problems with one record's `custom` and `withheldFields`, by the contract:
 * `custom` present and a CustomFields object, never null-valued, never
 * withheld itself; a key never both present and listed.
 */
function customProblems(record: unknown, where: string): string[] {
  const problems: string[] = [];
  const row = (record ?? {}) as Json;
  if (!('custom' in row)) return [`${where}: no custom`];
  problems.push(...schemaErrors(CUSTOM_FIELDS, row.custom, `${where}.custom`));
  const custom = (row.custom ?? {}) as Json;
  for (const [key, value] of Object.entries(custom)) {
    if (value === null) problems.push(`${where}.custom.${key} is null`);
  }
  const withheld = Array.isArray(row.withheldFields) ? (row.withheldFields as unknown[]) : [];
  if (withheld.includes('custom')) problems.push(`${where}: custom itself is withheld`);
  for (const entry of withheld) {
    if (typeof entry === 'string' && entry.startsWith('custom.')) {
      if (!/^custom\.[a-z][a-z0-9_]*__c$/.test(entry)) problems.push(`${where}: malformed ${entry}`);
      if (entry.slice('custom.'.length) in custom) problems.push(`${where}: ${entry} is present and withheld`);
    }
  }
  return problems;
}

function customOf(record: unknown, where: string): Json {
  expect(customProblems(record, where), where).toEqual([]);
  return (record as Json).custom as Json;
}

function withheldOf(record: unknown): string[] {
  const list = (record as Json | null)?.withheldFields;
  return Array.isArray(list) ? (list as string[]) : [];
}

// ---------------------------------------------------------------------------
// Statement and result recording (V3): pg.Client.prototype.query wrapped.
// ---------------------------------------------------------------------------

interface Recorded {
  text: string;
  values: string;
  result: string;
}

type QueryFn = (this: unknown, ...args: unknown[]) => unknown;
const clientPrototype = pg.Client.prototype as unknown as { query: QueryFn };
const originalQuery = clientPrototype.query;

function renderAny(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return inspect(value, { depth: 8 });
  }
}

function rowsOf(result: unknown): unknown {
  if (Array.isArray(result)) return result.map((part) => (part as { rows?: unknown })?.rows);
  return (result as { rows?: unknown } | null)?.rows;
}

async function recordStatements(work: () => Promise<void>): Promise<Recorded[]> {
  const sink: Recorded[] = [];
  clientPrototype.query = function recordingQuery(this: unknown, ...args: unknown[]) {
    const [first, second] = args;
    const config = (typeof first === 'object' && first !== null ? first : {}) as { text?: unknown; values?: unknown };
    const entry: Recorded = {
      text: typeof first === 'string' ? first : String(config.text ?? ''),
      values: renderAny(Array.isArray(second) ? second : config.values ?? []),
      result: '',
    };
    sink.push(entry);
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const callback = last as (error: unknown, result: unknown) => unknown;
      args[args.length - 1] = (error: unknown, result: unknown) => {
        entry.result = renderAny(rowsOf(result));
        return callback(error, result);
      };
      return originalQuery.apply(this, args);
    }
    const out = originalQuery.apply(this, args);
    if (out !== null && typeof out === 'object' && typeof (out as Promise<unknown>).then === 'function') {
      return (out as Promise<unknown>).then((result) => {
        entry.result = renderAny(rowsOf(result));
        return result;
      });
    }
    return out;
  };
  try {
    await work();
  } finally {
    clientPrototype.query = originalQuery;
  }
  return sink;
}

// ---------------------------------------------------------------------------
// Log capture: every channel the process can write to (the T-0036 approach).
// ---------------------------------------------------------------------------

let captureLines: string[] | null = null;

function render(value: unknown): string {
  return typeof value === 'string' ? value : inspect(value, { depth: 12, breakLength: Number.POSITIVE_INFINITY });
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

async function captureEverything(work: () => Promise<void>): Promise<string[]> {
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
  let telemetry: { spans: unknown[]; logs: unknown[] };
  try {
    telemetry = await collectTelemetry(work);
  } finally {
    for (const spy of spies) spy.mockRestore();
    captureLines = null;
  }
  return [...lines, ...telemetry.logs.map(render), ...telemetry.spans.map(render)];
}

// ===========================================================================

describe('acceptance: custom-field values over the records API (T-0089)', () => {
  let app: INestApplication;
  /** kasuwa_migrator — BYPASSRLS. Plants and observes; never serves. */
  let observer: Pool;
  /** Default pipelines and their first two stages, per programme (regenerated by every reseed). */
  const pipelines: Record<string, { id: string; s0: string; s1: string }> = {};
  /** field_def ids, `<object>.<apiName>`. */
  const fieldIds = new Map<string, string>();

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(withAuthDatabase({ databaseUrl: inject('databaseUrl'), poolMax: 5 }))],
    }).compile();
    app = moduleRef.createNestApplication({ logger: new RecordingLogger() });
    await app.init();
    observer = createPool({ connectionString: inject('migrationUrl'), max: 3 });
  });

  afterAll(async () => {
    clientPrototype.query = originalQuery;
    await app?.close();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  beforeEach(async () => {
    for (const programmeId of [PROGRAMME_A1, PROGRAMME_A2]) {
      const stages = await observer.query<{ pipeline_id: string; id: string }>(
        `SELECT s.pipeline_id, s.id FROM pipeline_stage s
           JOIN pipeline p ON p.id = s.pipeline_id
          WHERE p.programme_id = $1 ORDER BY p.created_at, p.id, s.position LIMIT 2`,
        [programmeId],
      );
      pipelines[programmeId] = {
        id: must(stages.rows[0]?.pipeline_id, `no default pipeline in ${programmeId}`),
        s0: must(stages.rows[0]?.id, 'stage 0'),
        s1: must(stages.rows[1]?.id, 'stage 1'),
      };
    }
    // Definitions, live (V9): planted by the migrator, never through the API.
    let n = 0;
    for (const object of OBJECTS) {
      const objectRow = await observer.query<{ id: string }>(
        'SELECT id FROM object_def WHERE tenant_id = $1 AND api_name = $2',
        [TENANT_A, object],
      );
      const objectId = must(objectRow.rows[0]?.id, `no ${object} object_def`);
      const specs = object === 'contact'
        ? [...FIELDS, ...BIG_FIELDS.map((apiName): FieldSpec => ({ apiName, type: 'text', classification: 'none', config: {} }))]
        : FIELDS;
      for (const spec of specs) {
        n += 1;
        const id = id89(`f${n.toString(16).padStart(7, '0')}`);
        fieldIds.set(`${object}.${spec.apiName}`, id);
        await observer.query(
          `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification, is_custom, config)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8::jsonb)`,
          [id, TENANT_A, objectId, spec.apiName, `T-0089 ${spec.apiName}`, spec.type, spec.classification, JSON.stringify(spec.config)],
        );
      }
      for (const [apiName, setKey, level] of GRANTS) {
        await observer.query(
          `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level) VALUES ($1, $2, $3, $4)`,
          [TENANT_A, fieldIds.get(`${object}.${apiName}`), permissionSet(setKey), level],
        );
      }
    }
    // An activity and two more deals, so every object has a row in A2 and A1 holds two deals.
    await observer.query(
      `INSERT INTO activity (id, tenant_id, programme_id, type, subject, owner_user_id, account_id, created_by_user_id)
       VALUES ($1, $2, $3, 'note', 'T-0089 planted note', $4, $5, $4)`,
      [ACT2, TENANT_A, PROGRAMME_A2, USER_A_AGENT_2, ACC2],
    );
    const plantDeal = async (id: string, programmeId: string, owner: string, name: string) => {
      const p = must(pipelines[programmeId], 'pipeline');
      await observer.query(
        `INSERT INTO deal (id, tenant_id, programme_id, pipeline_id, stage_id, name, owner_user_id, stage_entered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [id, TENANT_A, programmeId, p.id, p.s0, name, owner],
      );
    };
    await plantDeal(DEAL2, PROGRAMME_A2, USER_A_AGENT_2, 'T-0089 planted deal A2');
    await plantDeal(DEAL1B, PROGRAMME_A1, USER_A_AGENT_1, 'T-0089 planted deal A1');
    // Every seeded tenant-A contact is a lead, so listLeads sees them all.
    await observer.query(`UPDATE contact SET status = 'new' WHERE tenant_id = $1`, [TENANT_A]);
  }, 60_000);

  afterEach(async () => {
    clientPrototype.query = originalQuery;
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();
  const enc = encodeURIComponent;
  const withQuery = (path: string, params: Params) => {
    const query = new URLSearchParams(params.map(([k, v]): [string, string] => [k, v])).toString();
    return query === '' ? path : `${path}?${query}`;
  };
  const send = (method: 'post' | 'patch', path: string, headers: Headers, body: unknown) =>
    request(server())[method](path).set(headers).set('Content-Type', 'application/json').send(JSON.stringify(body));
  const get = (headers: Headers, path: string, params: Params = []) =>
    request(server()).get(withQuery(path, params)).set(headers);

  const TABLE_OF: Record<ObjectName, string> = { contact: 'contact', account: 'account', activity: 'activity', deal: 'deal' };

  async function versionOf(object: ObjectName, id: string): Promise<number> {
    const rows = await observer.query<{ version: number }>(`SELECT version FROM ${TABLE_OF[object]} WHERE id = $1`, [id]);
    return Number(must(rows.rows[0], `${object} ${id} not found`).version);
  }

  async function storedCustom(object: ObjectName, id: string): Promise<Json> {
    const rows = await observer.query<{ custom: Json }>(`SELECT custom FROM ${TABLE_OF[object]} WHERE id = $1`, [id]);
    return must(rows.rows[0], `${object} ${id} not found`).custom;
  }

  async function plantCustom(object: ObjectName, id: string, custom: Json): Promise<void> {
    await observer.query(`UPDATE ${TABLE_OF[object]} SET custom = $2::jsonb WHERE id = $1`, [id, JSON.stringify(custom)]);
  }

  /** updateX with the record's current version, unless one is given. */
  async function update(object: ObjectName, headers: Headers, id: string, body: Json, version?: number) {
    const v = version ?? (await versionOf(object, id));
    const path = { contact: '/api/v1/contacts', account: '/api/v1/accounts', activity: '/api/v1/activities', deal: '/api/v1/deals' }[object];
    return send('patch', `${path}/${enc(id)}`, headers, { version: v, ...body });
  }

  function create(object: ObjectName, headers: Headers, programmeId: string, extra: Json = {}) {
    const unique = `T-0089 ${object} ${RUN} ${Math.random().toString(36).slice(2, 8)}`;
    switch (object) {
      case 'contact':
        return send('post', '/api/v1/contacts', headers, { programmeId, displayName: unique, ...extra });
      case 'account':
        return send('post', '/api/v1/accounts', headers, { programmeId, name: unique, ...extra });
      case 'activity':
        return send('post', '/api/v1/activities', headers, {
          type: 'note',
          subject: 'T-0089 note',
          accountId: programmeId === PROGRAMME_A1 ? ACC1 : ACC2,
          ...extra,
        });
      case 'deal':
        return send('post', `/api/v1/pipelines/${enc(must(pipelines[programmeId], 'pipeline').id)}/deals`, headers, {
          name: unique,
          ...extra,
        });
    }
  }

  /** The read of one record, for the objects that have one. Activities are read from their update answer. */
  function read(object: Exclude<ObjectName, 'activity'>, headers: Headers, id: string) {
    const path = { contact: '/api/v1/contacts', account: '/api/v1/accounts', deal: '/api/v1/deals' }[object];
    return get(headers, `${path}/${enc(id)}`);
  }

  async function okBody(response: request.Response, status: number, where: string): Promise<Json> {
    expect(response.status, `${where}: ${response.text}`).toBe(status);
    return response.body as Json;
  }

  interface Detail {
    path: string;
    code: string;
  }
  const detailsOf = (body: unknown): Detail[] => {
    const details = (body as Json | null)?.details;
    return Array.isArray(details) ? (details as Detail[]) : [];
  };

  function expectError(response: request.Response, status: number, code: string, where: string): Json {
    expect(response.status, `${where}: expected ${status} ${code}, got ${response.status} ${response.text}`).toBe(status);
    const body = response.body as Json;
    expect(body.code, `${where}: Error.code`).toBe(code);
    for (const text of DATABASE_TEXT) expect(response.text, `${where}: the body carries database text`).not.toContain(text);
    for (const d of detailsOf(body)) {
      expect(Object.keys(d).sort(), `${where}: a detail carries more than path and code`).toEqual(['code', 'path']);
    }
    return body;
  }

  function expectDetail(response: request.Response, status: number, code: string, detail: string, paths: readonly string[], where: string) {
    const body = expectError(response, status, code, where);
    const found = detailsOf(body).some((d) => d.code === detail && paths.includes(d.path));
    expect(found, `${where}: details ${JSON.stringify(body.details)} lack ${detail} at ${paths.join(' or ')}`).toBe(true);
    return body;
  }

  const notEditable = (response: request.Response, key: string, where: string) =>
    expectDetail(response, 403, 'not_permitted', 'field_not_editable', [`custom.${key}`], where);

  async function setTenantAdmin(userId: string, value: boolean) {
    await observer.query('UPDATE "user" SET is_tenant_admin = $1 WHERE id = $2', [value, userId]);
  }

  async function assign(userId: string, programmeId: string, key: string) {
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id) DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, TENANT_A, permissionSet(key)],
    );
  }

  async function retireField(object: ObjectName, apiName: string) {
    const id = must(fieldIds.get(`${object}.${apiName}`), apiName);
    const response = await request(server()).post(`/api/v1/admin/custom-fields/${enc(id)}/retire`).set(SUPERVISOR);
    expect(response.status, `retire ${object}.${apiName}: ${response.text}`).toBe(200);
  }

  const ids = (page: unknown) => (((page as Json | null)?.data ?? []) as Json[]).map((row) => String(row.id)).sort();

  // =========================================================================
  // 0. The contract and this file's helpers
  // =========================================================================

  describe('the contract and the checkers', () => {
    it('(self-check) customProblems passes good records and names each fault', () => {
      expect(customProblems({ custom: { tier__c: 'gold' }, withheldFields: ['custom.secret__c'] }, 'ok')).toEqual([]);
      expect(customProblems({ custom: {}, withheldFields: [] }, 'empty')).toEqual([]);
      const faults: [string, unknown][] = [
        ['no custom', { withheldFields: [] }],
        ['a null value', { custom: { tier__c: null }, withheldFields: [] }],
        ['custom withheld', { custom: {}, withheldFields: ['custom'] }],
        ['present and withheld', { custom: { tier__c: 'gold' }, withheldFields: ['custom.tier__c'] }],
        ['a standard key', { custom: { status: 'new' }, withheldFields: [] }],
        ['a JSON number', { custom: { num__c: 1.5 }, withheldFields: [] }],
        ['a malformed path', { custom: {}, withheldFields: ['custom.Tier'] }],
      ];
      for (const [label, record] of faults) expect(customProblems(record, label), label).not.toEqual([]);
    });

    it('(self-check) the statement recorder sees text, values and result rows, and restores the prototype', async () => {
      const pool = createPool({ connectionString: inject('migrationUrl'), max: 1 });
      try {
        const recorded = await recordStatements(async () => {
          await pool.query('SELECT $1::text AS probe', [`probe-${RUN}`]);
        });
        const hit = recorded.find((entry) => entry.text.includes('AS probe'));
        expect(hit?.values).toContain(`probe-${RUN}`);
        expect(hit?.result).toContain(`probe-${RUN}`);
        expect(clientPrototype.query).toBe(originalQuery);
      } finally {
        await pool.end();
      }
    });

    it('every custom property and both filter parameters are x-kasuwa-implemented: true (served)', () => {
      const doc = loadDoc(SPEC_PATH) as Json;
      const flags: string[] = [];
      const walk = (node: unknown, path: string) => {
        if (Array.isArray(node)) {
          node.forEach((child, i) => walk(child, `${path}[${i}]`));
          return;
        }
        if (typeof node !== 'object' || node === null) return;
        for (const [key, child] of Object.entries(node as Json)) {
          if (key === 'custom' && typeof child === 'object' && child !== null && 'x-kasuwa-implemented' in (child as Json)) {
            flags.push(`${path}.custom=${String((child as Json)['x-kasuwa-implemented'])}`);
          }
          walk(child, `${path}.${key}`);
        }
      };
      walk(doc.components, 'components');
      // Contact, Account, Activity, Deal and the eight bodies.
      expect(flags.length).toBeGreaterThanOrEqual(12);
      expect(flags.filter((flag) => !flag.endsWith('=true'))).toEqual([]);
      const parameters = ((doc.components as Json).parameters ?? {}) as Record<string, Json>;
      for (const name of ['CustomFilter', 'CustomEmptyFilter']) {
        expect(parameters[name]?.['x-kasuwa-implemented'], name).toBe(true);
      }
    });
  });

  // =========================================================================
  // 1. Encodings (supervisor: the locked admin set, so field security is edit)
  // =========================================================================

  describe('encodings: each Phase 2 type is accepted and refused as the contract says', () => {
    it.each(OBJECTS)('%s: a create carrying all six types is stored and served exactly, money and numbers as strings', async (object) => {
      const response = await create(object, SUPERVISOR, PROGRAMME_A1, { custom: VALID_SIX });
      const body = await okBody(response, 201, `create ${object}`);
      expect(customOf(body, object)).toEqual(VALID_SIX);
      expect(await storedCustom(object, String(body.id))).toEqual(VALID_SIX);
      // Judged on the raw text too: a number that went through a double is caught.
      expect(response.text).toContain('"num__c":"-1234.5"');
      expect(response.text).toContain('"amountMinor":"150000"');
    });

    const ACCEPT: [string, unknown][] = [
      ['txt__c', 'x'.repeat(1000)],
      ['txt__c', 'Ẹ̀kọ́ àti ìlú 😀'],
      ['num__c', '0'],
      ['num__c', '42'],
      ['num__c', '-0.25'],
      ['num__c', '123456789012345678'],
      ['num__c', '1234567890.12345678'],
      ['num__c', '0.000000000000000001'],
      // D-L140: CustomFieldNumber maxLength 40, exactly.
      ['num__c', `0.${'0'.repeat(37)}1`],
      ['amt__c', { amountMinor: '0', currency: 'NGN' }],
      ['amt__c', { amountMinor: '-500', currency: 'NGN' }],
      ['amt__c', { amountMinor: '999999999999999999', currency: 'NGN' }],
      ['amt__c', { amountMinor: '-999999999999999999', currency: 'NGN' }],
      ['day__c', '2026-02-28'],
      ['day__c', '1999-12-31'],
      ['tier__c', 'bronze'],
      ['vip__c', false],
    ];

    it('accepted values round-trip exactly through updateContact and getContact', async () => {
      for (const [key, value] of ACCEPT) {
        const where = `${key}=${JSON.stringify(value).slice(0, 40)}`;
        const written = await okBody(await update('contact', SUPERVISOR, C1, { custom: { [key]: value } }), 200, where);
        expect(customOf(written, where)[key], where).toEqual(value);
        const reread = await okBody(await read('contact', SUPERVISOR, C1), 200, where);
        expect(customOf(reread, where)[key], where).toEqual(value);
        expect((await storedCustom('contact', C1))[key], where).toEqual(value);
      }
    });

    const REFUSE: [string, unknown, string][] = [
      ['txt__c', '', 'invalid_value'],
      ['txt__c', 'x'.repeat(1001), 'invalid_value'],
      ['txt__c', 'line one\nline two', 'invalid_value'],
      ['txt__c', 'carriage\rreturn', 'invalid_value'],
      ['txt__c', 'line separator', 'invalid_value'],
      ['txt__c', 'para separator', 'invalid_value'],
      ['txt__c', 'nul\u0000byte', 'invalid_value'],
      ['txt__c', 42, 'invalid_value'],
      ['txt__c', true, 'invalid_value'],
      ['txt__c', ['a'], 'invalid_value'],
      ['num__c', 1.5, 'invalid_value'],
      ['num__c', 42, 'invalid_value'],
      ['num__c', '1.50', 'invalid_value'],
      ['num__c', '1.0', 'invalid_value'],
      ['num__c', '01', 'invalid_value'],
      ['num__c', '.5', 'invalid_value'],
      ['num__c', '+1', 'invalid_value'],
      ['num__c', '1e3', 'invalid_value'],
      ['num__c', '-0', 'invalid_value'],
      ['num__c', '1,000', 'invalid_value'],
      ['num__c', '1234567890123456789', 'invalid_value'],
      // 41 characters with one significant digit: the pattern admits it, maxLength 40 does not.
      ['num__c', `0.${'0'.repeat(38)}1`, 'invalid_value'],
      ['num__c', ' 1', 'invalid_value'],
      ['num__c', 'NaN', 'invalid_value'],
      ['num__c', '', 'invalid_value'],
      ['amt__c', { amountMinor: 1500, currency: 'NGN' }, 'invalid_value'],
      ['amt__c', { amountMinor: '1.5', currency: 'NGN' }, 'invalid_value'],
      ['amt__c', { amountMinor: '01', currency: 'NGN' }, 'invalid_value'],
      ['amt__c', { amountMinor: '-0', currency: 'NGN' }, 'invalid_value'],
      ['amt__c', { amountMinor: '1000000000000000000', currency: 'NGN' }, 'invalid_value'],
      ['amt__c', { amountMinor: '1' }, 'invalid_value'],
      ['amt__c', { amountMinor: '1', currency: 'NGN', amount: '1' }, 'invalid_value'],
      ['amt__c', { amount: '1', currency: 'NGN' }, 'invalid_value'],
      ['amt__c', '150000', 'invalid_value'],
      ['amt__c', 150000, 'invalid_value'],
      ['amt__c', { amountMinor: '1', currency: 'GHS' }, 'currency_mismatch'],
      ['amt__c', { amountMinor: '1', currency: 'USD' }, 'currency_mismatch'],
      ['day__c', '2026-02-30', 'invalid_value'],
      ['day__c', '2025-02-29', 'invalid_value'],
      ['day__c', '2026-13-01', 'invalid_value'],
      ['day__c', '2026-00-10', 'invalid_value'],
      ['day__c', '2026-1-01', 'invalid_value'],
      ['day__c', '2026-01-01T00:00:00Z', 'invalid_value'],
      ['day__c', '2026/01/01', 'invalid_value'],
      ['day__c', 20260101, 'invalid_value'],
      ['tier__c', 'diamond', 'unknown_value'],
      ['tier__c', 'Gold', 'invalid_value'],
      ['tier__c', ['gold'], 'invalid_value'],
      ['tier__c', true, 'invalid_value'],
      ['tier__c', '', 'invalid_value'],
      ['vip__c', 'true', 'invalid_value'],
      ['vip__c', 1, 'invalid_value'],
      ['vip__c', 'yes', 'invalid_value'],
    ];

    it('refused values are 400 with the contract’s code at custom.<key>, and nothing is written', async () => {
      await plantCustom('contact', C1, { txt__c: 'T-0089 before' });
      const version = await versionOf('contact', C1);
      for (const [key, value, code] of REFUSE) {
        const where = `${key}=${JSON.stringify(value).slice(0, 40)}`;
        const paths = code === 'currency_mismatch' ? [`custom.${key}.currency`] : [`custom.${key}`, `custom.${key}.amountMinor`, `custom.${key}.currency`];
        expectDetail(await update('contact', SUPERVISOR, C1, { custom: { [key]: value } }), 400, 'validation_failed', code, paths, where);
      }
      expect(await storedCustom('contact', C1)).toEqual({ txt__c: 'T-0089 before' });
      expect(await versionOf('contact', C1)).toBe(version);
    });

    // T-0089 / D-L142 (lead edit): JSON.stringify sends a lone surrogate as a `\udXXX` escape,
    // which jsonb refuses ("unsupported Unicode escape sequence"); the API must refuse it first.
    it('(D-L142) a lone UTF-16 surrogate in a text value is 400 invalid_value, never 500, on update and create; nothing is written', async () => {
      // The control: a well-formed surrogate pair is an ordinary character.
      await okBody(await update('contact', SUPERVISOR, C1, { custom: { txt__c: 'T-0089 pair 😀' } }), 200, 'a well-formed pair');
      const version = await versionOf('contact', C1);
      const lone = ['lone \uD800 high', 'lone \uDC00 low', 'reversed \uDC00\uD800 pair', 'trailing \uDBFF'];
      for (const value of lone) {
        const where = JSON.stringify(value);
        expectDetail(await update('contact', SUPERVISOR, C1, { custom: { txt__c: value } }), 400, 'validation_failed', 'invalid_value', ['custom.txt__c'], `update ${where}`);
        expectDetail(await create('activity', SUPERVISOR, PROGRAMME_A1, { custom: { txt__c: value } }), 400, 'validation_failed', 'invalid_value', ['custom.txt__c'], `create ${where}`);
      }
      expect(await storedCustom('contact', C1)).toEqual({ txt__c: 'T-0089 pair 😀' });
      expect(await versionOf('contact', C1)).toBe(version);
    });

    it.each(OBJECTS)('%s: one refused value per type at create, and nothing is created', async (object) => {
      const table = TABLE_OF[object];
      const count = async () =>
        Number((await observer.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);
      // The control: a valid create succeeds on this object.
      await okBody(await create(object, SUPERVISOR, PROGRAMME_A1, { custom: { tier__c: 'gold' } }), 201, 'control');
      const before = await count();
      for (const [key, value, code] of [
        ['txt__c', '', 'invalid_value'],
        ['num__c', 2.5, 'invalid_value'],
        ['amt__c', { amountMinor: '1', currency: 'KES' }, 'currency_mismatch'],
        ['day__c', '2026-02-30', 'invalid_value'],
        ['tier__c', 'diamond', 'unknown_value'],
        ['vip__c', 'false', 'invalid_value'],
      ] as const) {
        const paths = code === 'currency_mismatch' ? [`custom.${key}.currency`] : [`custom.${key}`];
        expectDetail(await create(object, SUPERVISOR, PROGRAMME_A1, { custom: { [key]: value } }), 400, 'validation_failed', code, paths, `${object} ${key}`);
      }
      expect(await count()).toBe(before);
    });

    it.each(OBJECTS)('%s: null is refused at create (values only), and custom: {} on update is refused', async (object) => {
      await okBody(await create(object, SUPERVISOR, PROGRAMME_A1, { custom: {} }), 201, 'control: an empty custom at create');
      expectError(await create(object, SUPERVISOR, PROGRAMME_A1, { custom: { txt__c: null } }), 400, 'validation_failed', 'null at create');
      expectError(await update(object, SUPERVISOR, A1_ROW[object], { custom: {} }), 400, 'validation_failed', 'empty patch');
      expectError(await update(object, SUPERVISOR, A1_ROW[object], { custom: null }), 400, 'validation_failed', 'custom: null');
      expectError(await update(object, SUPERVISOR, A1_ROW[object], { custom: [] }), 400, 'validation_failed', 'custom: []');
    });

    it('an unknown key, another object’s key, another tenant’s key and a standard name are all unknown_field; a hostile key is 400, never 500', async () => {
      // Another tenant's definition, and a field only accounts have.
      const b = await observer.query<{ id: string }>(
        `SELECT id FROM object_def WHERE tenant_id = $1 AND api_name = 'contact'`,
        [TENANT_B],
      );
      await observer.query(
        `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification, is_custom)
         VALUES ($1, $2, $3, 'b_only__c', 'T-0089 b only', 'text', 'none', true)`,
        [id89('c0000b01'), TENANT_B, must(b.rows[0]?.id, 'tenant B contact')],
      );
      const accountObject = await observer.query<{ id: string }>(
        `SELECT id FROM object_def WHERE tenant_id = $1 AND api_name = 'account'`,
        [TENANT_A],
      );
      await observer.query(
        `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification, is_custom)
         VALUES ($1, $2, $3, 'acc_only__c', 'T-0089 account only', 'text', 'none', true)`,
        [id89('c0000b02'), TENANT_A, must(accountObject.rows[0]?.id, 'account object')],
      );
      // The control: a known key is written.
      await okBody(await update('contact', SUPERVISOR, C1, { custom: { txt__c: 'T-0089 ok' } }), 200, 'control');
      for (const key of ['nope__c', 'acc_only__c', 'b_only__c']) {
        expectDetail(await update('contact', SUPERVISOR, C1, { custom: { [key]: 'x' } }), 400, 'validation_failed', 'unknown_field', [`custom.${key}`], key);
        expectDetail(await create('contact', SUPERVISOR, PROGRAMME_A1, { custom: { [key]: 'x' } }), 400, 'validation_failed', 'unknown_field', [`custom.${key}`], `create ${key}`);
      }
      // D-L140: a key failing the __c pattern is unknown_field at `custom`, never named.
      for (const key of ['status', 'displayName', 'TIER__C', 'tier__c ', 'constructor', 'toString']) {
        expectDetail(await update('contact', SUPERVISOR, C1, { custom: { [key]: 'x' } }), 400, 'validation_failed', 'unknown_field', ['custom'], JSON.stringify(key));
      }
      const version = await versionOf('contact', C1);
      for (const raw of [
        `{"version": ${version}, "custom": {"__proto__": {"tier__c": "gold"}}}`,
        `{"version": ${version}, "custom": {"__proto__": "x"}}`,
        `{"version": ${version}, "custom": {"constructor": {"prototype": {"x": 1}}}}`,
      ]) {
        const response = await request(server()).patch(`/api/v1/contacts/${enc(C1)}`).set(SUPERVISOR).set('Content-Type', 'application/json').send(raw);
        expectError(response, 400, 'validation_failed', raw);
      }
      expect(await storedCustom('contact', C1)).toEqual({ txt__c: 'T-0089 ok' });
    });

    it('(D-L140) a malformed key is unknown_field at custom (or the filter parameter) and is never echoed, on writes, creates and filters', async () => {
      await okBody(await update('contact', SUPERVISOR, C1, { custom: { txt__c: 'T-0089 ok' } }), 200, 'control');
      const marker = `zqbadkey${RUN}`;
      const badKeys = [`Zqbadkey${RUN}__c`, marker, `${marker} x__c`, `${marker}__c\n`, `${marker}-x__c`, `1${marker}__c`];
      for (const key of badKeys) {
        for (const [label, response] of [
          ['update', await update('contact', SUPERVISOR, C1, { custom: { [key]: 'x' } })],
          ['create', await create('contact', SUPERVISOR, PROGRAMME_A1, { custom: { [key]: 'x' } })],
          ['create deal', await create('deal', SUPERVISOR, PROGRAMME_A1, { custom: { [key]: 'x' } })],
        ] as const) {
          expectDetail(response, 400, 'validation_failed', 'unknown_field', ['custom'], `${label} ${JSON.stringify(key)}`);
          expect(response.text.toLowerCase(), `${label}: the key is echoed: ${response.text}`).not.toContain(marker);
        }
        for (const [param, params] of [
          ['custom', [[`custom[${key}]`, 'abc']]],
          ['customEmpty', [['customEmpty', key]]],
        ] as const) {
          const response = await get(SUPERVISOR, '/api/v1/contacts', params);
          expectDetail(response, 400, 'validation_failed', 'unknown_field', [param], `filter ${param} ${JSON.stringify(key)}`);
          expect(response.text.toLowerCase(), `filter: the key is echoed: ${response.text}`).not.toContain(marker);
        }
      }
      expect(await storedCustom('contact', C1)).toEqual({ txt__c: 'T-0089 ok' });
    });

    it('error bodies never echo the value sent, on any code, and the database text never surfaces', async () => {
      await okBody(await update('contact', SUPERVISOR, C1, { custom: { txt__c: 'T-0089 ok' } }), 200, 'control');
      const probes: Json[] = [
        { txt__c: `${ECHO}\nsecond line` },
        { num__c: ECHO },
        { amt__c: { amountMinor: ECHO, currency: 'NGN' } },
        { amt__c: { amountMinor: '1', currency: 'GHS', note: ECHO } },
        { day__c: ECHO },
        { tier__c: ECHO },
        { tier__c: ECHO.toUpperCase() },
        { vip__c: ECHO },
        { nope__c: ECHO },
      ];
      for (const custom of probes) {
        const response = await update('contact', SUPERVISOR, C1, { custom });
        expect(response.status, JSON.stringify(custom)).toBe(400);
        expect(response.text.toLowerCase(), `echoed: ${response.text}`).not.toContain(ECHO.toLowerCase());
      }
    });
  });

  // =========================================================================
  // 2. The 16 KiB API limit (V8; the database backstop is 512 KiB, D-L142)
  // =========================================================================

  describe('the 16 KiB API limit, judged only on what the caller can see (D-L140)', () => {
    const euros = '€'.repeat(1000); // 1,000 characters, 3,000 octets
    /** 1,000 characters of U+1D11E: the most octets one text value can hold (4,000). */
    const nearMax = '𝄞'.repeat(1000);
    const fill = (keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, euros]));
    const FIVE = BIG_FIELDS.slice(0, 5); // about 15.1 KB
    const SIX = BIG_FIELDS.slice(0, 6); // about 18.1 KB

    it('about 15 KB is accepted; one write of about 18 KB is 400 custom_too_large at custom; nothing is applied', async () => {
      await okBody(await update('contact', SUPERVISOR, C1B, { custom: fill(FIVE) }), 200, '5 x 3,000 octets');
      const response = await update('contact', SUPERVISOR, C1, { custom: fill(SIX) });
      expectDetail(response, 400, 'validation_failed', 'custom_too_large', ['custom'], '6 x 3,000 octets');
      expect(response.text).not.toContain(euros.slice(0, 10));
      expect(await storedCustom('contact', C1)).toEqual({});
    });

    it('two writes that each fit but together pass 16 KiB: the second is custom_too_large and the first survives whole', async () => {
      const first = BIG_FIELDS.slice(0, 3);
      const second = BIG_FIELDS.slice(3, 6);
      await okBody(await update('contact', SUPERVISOR, C1, { custom: fill(first) }), 200, 'first half');
      const version = await versionOf('contact', C1);
      expectDetail(await update('contact', SUPERVISOR, C1, { custom: fill(second) }), 400, 'validation_failed', 'custom_too_large', ['custom'], 'second half');
      expect(Object.keys(await storedCustom('contact', C1)).sort()).toEqual([...first].sort());
      expect(await versionOf('contact', C1)).toBe(version);
      // Removing keys while adding keeps it under: null frees room in the same patch.
      const swap = { ...Object.fromEntries(first.slice(0, 2).map((key) => [key, null])), ...fill(second.slice(0, 2)) };
      const swapped = await okBody(await update('contact', SUPERVISOR, C1, { custom: swap }), 200, 'swap');
      expect(Object.keys(customOf(swapped, 'swap')).sort()).toEqual([first[2], ...second.slice(0, 2)].sort());
    });

    // T-0089 / D-L142 (lead edit): the size measure takes FOR UPDATE. The observer holds the
    // row lock until BOTH writes are waiting on it, so the race is forced, not hoped for: a
    // measure taken without the lock passes both (the row is small when each reads it), and the
    // second then dies at the version check (409) or lands (200), either of which fails here.
    it('(D-L142) two concurrent writes to different keys, each under 16 KiB alone and over it together, never both land: exactly one is custom_too_large', async () => {
      const first = BIG_FIELDS.slice(0, 3); // about 9 KB
      const second = BIG_FIELDS.slice(3, 6); // about 9 KB; together about 18 KB
      const version = await versionOf('contact', C1);
      // Concurrent supertest requests need a server that is already listening: when supertest
      // starts the server itself, each request closes it on the other (ECONNREFUSED).
      const srv = server() as { listen: (port: number, host: string, done: () => void) => void; close: (done: () => void) => void };
      await new Promise<void>((done) => srv.listen(0, '127.0.0.1', done));
      const holder = await observer.connect();
      try {
        await holder.query('BEGIN');
        const pid = Number((await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);
        await holder.query('SELECT 1 FROM contact WHERE id = $1 FOR UPDATE', [C1]);
        let settled = 0;
        const fire = (keys: readonly string[]) =>
          send('patch', `/api/v1/contacts/${enc(C1)}`, SUPERVISOR, { version, custom: fill(keys) }).then((response) => {
            settled += 1;
            return response;
          });
        const pending = [fire(first), fire(second)] as const;
        // Wait on state, never on time: both writes blocked behind the observer's lock.
        const deadline = Date.now() + 15_000;
        let waiting = 0;
        while (waiting < 2 && settled === 0 && Date.now() < deadline) {
          const row = await observer.query<{ n: string }>(
            `SELECT count(*) AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`,
            [pid],
          );
          waiting = Number(row.rows[0]?.n);
        }
        await holder.query('ROLLBACK');
        const [left, right] = await Promise.all(pending);
        const texts = `${left.status} ${left.text.slice(0, 300)} | ${right.status} ${right.text.slice(0, 300)}`;
        expect(waiting, `the two writes never both waited on the row lock: ${texts}`).toBe(2);
        expect([left.status, right.status].sort(), texts).toEqual([200, 400]);
        const [winner, loser, winnerKeys] = left.status === 200 ? [left, right, first] : [right, left, second];
        expect(winner.status).toBe(200);
        expectDetail(loser, 400, 'validation_failed', 'custom_too_large', ['custom'], 'the losing concurrent write');
        expect(Object.keys(await storedCustom('contact', C1)).sort()).toEqual([...winnerKeys].sort());
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
        await new Promise<void>((done) => srv.close(() => done()));
      }
    });

    it('withheld bytes never count: a near-maximum withheld value changes nothing in the caller’s answers (no size oracle); the reader who can see it is judged on it', async () => {
      await setTenantAdmin(USER_A_NO_PROGRAMME, true);
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'team_lead');
      // C1 holds a withheld value of 4,000 octets; C1B holds none. Both in A1.
      await plantCustom('contact', C1, { secret__c: nearMax });
      await plantCustom('contact', C1B, {});
      // About 15.1 KB visible: accepted on both rows. Counted with the
      // withheld 4,000 octets it would be about 19.1 KB and refused on C1.
      const withValue = await update('contact', ACTOR, C1, { custom: fill(FIVE) });
      const without = await update('contact', ACTOR, C1B, { custom: fill(FIVE) });
      expect([withValue.status, without.status], `${withValue.text} | ${without.text}`).toEqual([200, 200]);
      expect((await storedCustom('contact', C1)).secret__c, 'the withheld value was dropped').toBe(nearMax);
      // Over the limit on what ACTOR sees: the same refusal, byte for byte, on both rows.
      const overWith = await update('contact', ACTOR, C1, { custom: { [String(BIG_FIELDS[5])]: euros } });
      const overWithout = await update('contact', ACTOR, C1B, { custom: { [String(BIG_FIELDS[5])]: euros } });
      expectDetail(overWith, 400, 'validation_failed', 'custom_too_large', ['custom'], 'over, with a withheld value');
      expect(overWith.text, 'the refusal tells a row with a withheld value from one without').toBe(overWithout.text);
      // The control: the supervisor reads secret__c, so on C1 its view is
      // about 19.1 KB already and any further value is refused; on C1B it is not.
      expectDetail(
        await update('contact', SUPERVISOR, C1, { custom: { tier__c: 'gold' } }),
        400,
        'validation_failed',
        'custom_too_large',
        ['custom'],
        'supervisor sees the withheld bytes',
      );
      await okBody(await update('contact', SUPERVISOR, C1B, { custom: { tier__c: 'gold' } }), 200, 'supervisor on C1B');
      // D-L141 ruling 7: on that over-limit view, a write that does not grow
      // the caller-visible size is never refused for size: a same-size
      // replacement (3,000 octets for 3,000), then a removal.
      const sameSize = '₤'.repeat(1000);
      const replaced = await update('contact', SUPERVISOR, C1, { custom: { [String(BIG_FIELDS[1])]: sameSize } });
      expect(replaced.status, `same-size replacement refused: ${replaced.text}`).toBe(200);
      const removed = await update('contact', SUPERVISOR, C1, { custom: { [String(BIG_FIELDS[0])]: null } });
      expect(removed.status, `removal refused: ${removed.text}`).toBe(200);
      const stored = await storedCustom('contact', C1);
      expect([stored[String(BIG_FIELDS[1])], String(BIG_FIELDS[0]) in stored, stored.secret__c]).toEqual([sameSize, false, nearMax]);
    });

    it('(D-L141 ruling 7) removing keys is never refused for size, even when the row is over the limit', async () => {
      // Planted over 16 KiB of visible values (the database allows up to 512 KiB, D-L142).
      await plantCustom('contact', C1, fill(SIX));
      const removeOne = await update('contact', SUPERVISOR, C1, { custom: { [String(SIX[0])]: null } });
      expect(removeOne.status, `a removal was refused: ${removeOne.text}`).toBe(200);
      // About 15.1 KB now: removing one more while adding a small value shrinks it, also accepted.
      const shrink = await update('contact', SUPERVISOR, C1, { custom: { [String(SIX[1])]: null, tier__c: 'gold' } });
      expect(shrink.status, `a shrinking write was refused: ${shrink.text}`).toBe(200);
      expect(Object.keys(await storedCustom('contact', C1)).sort()).toEqual([...SIX.slice(2), 'tier__c'].sort());
    });

    it('retired bytes never count: a large value under a retired key does not refuse a write that fits', async () => {
      // Planted directly (the database checks only its 512 KiB backstop), then retired.
      await plantCustom('contact', C1, { old__c: nearMax });
      await retireField('contact', 'old__c');
      const written = await okBody(await update('contact', SUPERVISOR, C1, { custom: fill(FIVE) }), 200, 'fits without the retired bytes');
      expect(Object.keys(customOf(written, 'answer')).sort()).toEqual([...FIVE].sort());
      // T-0089 / D-L142 (lead edit; this pinned the value surviving): the write drops retired keys.
      expect(await storedCustom('contact', C1), 'the retired value survived a custom write').toEqual(fill(FIVE));
    });
  });

  // =========================================================================
  // 3. Merge semantics
  // =========================================================================

  describe('writes merge per key under the version check', () => {
    it.each(OBJECTS)('%s: {a} then {b} keeps both; null removes the key (absent, never null); an absent key is untouched', async (object) => {
      const id = A1_ROW[object];
      await okBody(await update(object, SUPERVISOR, id, { custom: { tier__c: 'gold', txt__c: 'T-0089 a' } }), 200, 'a');
      const both = await okBody(await update(object, SUPERVISOR, id, { custom: { vip__c: true } }), 200, 'b');
      expect(customOf(both, 'b')).toEqual({ tier__c: 'gold', txt__c: 'T-0089 a', vip__c: true });
      const removed = await okBody(await update(object, SUPERVISOR, id, { custom: { tier__c: null } }), 200, 'remove');
      expect(customOf(removed, 'remove')).toEqual({ txt__c: 'T-0089 a', vip__c: true });
      expect(await storedCustom(object, id)).toEqual({ txt__c: 'T-0089 a', vip__c: true });
      // Removing a key that is not set is no error and changes nothing else.
      await okBody(await update(object, SUPERVISOR, id, { custom: { day__c: null } }), 200, 'remove absent');
      expect(await storedCustom(object, id)).toEqual({ txt__c: 'T-0089 a', vip__c: true });
    });

    it('an update that does not mention custom leaves it untouched', async () => {
      await plantCustom('contact', C1, { tier__c: 'gold' });
      await okBody(await update('contact', SUPERVISOR, C1, { status: 'contacted' }), 200, 'standard field only');
      expect(await storedCustom('contact', C1)).toEqual({ tier__c: 'gold' });
      await plantCustom('deal', DEAL1, { tier__c: 'gold' });
      await okBody(await update('deal', SUPERVISOR, DEAL1, { nextStep: 'T-0089 call back' }), 200, 'deal standard field only');
      expect(await storedCustom('deal', DEAL1)).toEqual({ tier__c: 'gold' });
    });

    it('a stale version is 409 stale_write and applies nothing', async () => {
      await plantCustom('contact', C1, { tier__c: 'gold' });
      const version = await versionOf('contact', C1);
      await okBody(await update('contact', SUPERVISOR, C1, { custom: { vip__c: true } }, version), 200, 'first');
      expectError(await update('contact', SUPERVISOR, C1, { custom: { txt__c: 'T-0089 late' } }, version), 409, 'stale_write', 'stale');
      expect(await storedCustom('contact', C1)).toEqual({ tier__c: 'gold', vip__c: true });
    });

    it.each(OBJECTS)('%s: two concurrent edits to different keys on one version: exactly one wins, the other is 409, and nothing is clobbered', async (object) => {
      const id = A1_ROW[object];
      await plantCustom(object, id, { txt__c: 'T-0089 base' });
      const version = await versionOf(object, id);
      const [left, right] = await Promise.all([
        update(object, SUPERVISOR, id, { custom: { tier__c: 'gold' } }, version),
        update(object, SUPERVISOR, id, { custom: { vip__c: true } }, version),
      ]);
      const statuses = [left.status, right.status].sort();
      expect(statuses, `${left.text} | ${right.text}`).toEqual([200, 409]);
      const winner = left.status === 200 ? { tier__c: 'gold' } : { vip__c: true };
      expect(await storedCustom(object, id)).toEqual({ txt__c: 'T-0089 base', ...winner });
      // Re-read and retry: the loser's edit then lands beside the winner's.
      const loser = left.status === 200 ? { vip__c: true } : { tier__c: 'gold' };
      await okBody(await update(object, SUPERVISOR, id, { custom: loser }), 200, 'retry');
      expect(await storedCustom(object, id)).toEqual({ txt__c: 'T-0089 base', tier__c: 'gold', vip__c: true });
    });

    it('a value is audited by key only, whatever the classification: no value of a none field reaches the audit row', async () => {
      const before = new Set((await observer.query<{ id: string }>('SELECT id FROM audit_event')).rows.map((r) => r.id));
      const plainMark = `zqplain${RUN}`;
      const secretMark = `zqsens${RUN}`;
      await okBody(
        await update('contact', SUPERVISOR, C1, { custom: { txt__c: plainMark, secret__c: secretMark, tier__c: 'gold' } }),
        200,
        'write',
      );
      await okBody(await update('contact', SUPERVISOR, C1, { custom: { txt__c: null } }), 200, 'clear');
      const events = (
        await observer.query<{ id: string; object_type: string; changes: { field: string; before?: unknown; after?: unknown; redacted?: unknown }[] }>(
          'SELECT id, object_type, changes FROM audit_event ORDER BY occurred_at',
        )
      ).rows.filter((row) => !before.has(row.id));
      expect(events.map((e) => e.object_type)).toEqual(['contact', 'contact']);
      const text = JSON.stringify(events);
      for (const mark of [plainMark, secretMark, 'gold']) expect(text, `the audit carries ${mark}`).not.toContain(mark);
      const fields = events.flatMap((e) => e.changes.map((c) => c.field));
      for (const key of ['txt__c', 'secret__c', 'tier__c']) {
        expect(fields.some((field) => field.includes(key)), `the audit does not name ${key}`).toBe(true);
      }
      for (const change of events.flatMap((e) => e.changes).filter((c) => c.field.includes('__c'))) {
        expect(change.before ?? null, `${change.field} before`).toBeNull();
        expect(change.after ?? null, `${change.field} after`).toBeNull();
      }
    });
  });

  describe('logging (D-L140, V14)', () => {
    it('no custom value reaches a log or a span, whatever its classification, on writes, reads and refusals by a reader who may see it', async () => {
      const plain = `zqlogplain${RUN}`;
      const sensitive = `zqlogsens${RUN}`;
      const statuses: number[] = [];
      const lines = await captureEverything(async () => {
        statuses.push((await update('contact', SUPERVISOR, C1, { custom: { txt__c: plain, secret__c: sensitive } })).status);
        statuses.push((await read('contact', SUPERVISOR, C1)).status);
        statuses.push((await get(SUPERVISOR, '/api/v1/contacts', [['limit', '100']])).status);
        statuses.push((await create('activity', SUPERVISOR, PROGRAMME_A1, { custom: { txt__c: plain } })).status);
        statuses.push((await update('deal', SUPERVISOR, DEAL1, { custom: { txt__c: plain } })).status);
        statuses.push((await create('account', SUPERVISOR, PROGRAMME_A1, { custom: { txt__c: plain } })).status);
        // Refusals carrying the values: stale, unknown key, bad value.
        statuses.push((await update('contact', SUPERVISOR, C1, { custom: { txt__c: plain } }, 1)).status);
        statuses.push((await update('contact', SUPERVISOR, C1, { custom: { nope__c: plain } })).status);
        statuses.push((await update('contact', SUPERVISOR, C1, { custom: { num__c: plain } })).status);
      });
      // Not vacuous: the writes and reads succeeded and the refusals refused.
      expect(statuses).toEqual([200, 200, 200, 201, 200, 201, 409, 400, 400]);
      const leaks = lines.filter((line) => line.includes(plain) || line.includes(sensitive));
      expect(leaks.map((line) => line.slice(0, 200)), 'a custom value reached a log or a span').toEqual([]);
    });
  });

  // =========================================================================
  // 4. Retired keys
  // =========================================================================

  describe('retired keys: dropped from reads, refused on writes, still stored', () => {
    it('a retired key leaves custom AND withheldFields (V2), on every read of every object', async () => {
      for (const object of OBJECTS) await plantCustom(object, A1_ROW[object], { old__c: 'keep', tier__c: 'gold' });
      // The control: before retiring, the key is served.
      const live = await okBody(await read('contact', SUPERVISOR, C1), 200, 'before');
      expect(customOf(live, 'before')).toEqual({ old__c: 'keep', tier__c: 'gold' });
      for (const object of OBJECTS) await retireField(object, 'old__c');
      const reads: [string, unknown][] = [
        ['getContact', await okBody(await read('contact', SUPERVISOR, C1), 200, 'getContact')],
        ['getAccount', await okBody(await read('account', SUPERVISOR, ACC1), 200, 'getAccount')],
        ['getDeal', await okBody(await read('deal', SUPERVISOR, DEAL1), 200, 'getDeal')],
        // T-0089 / D-L142: UpdateActivityRequest is closed and has no `subject`;
        // `dealId: null` is a write the contract admits that leaves `custom` alone.
        ['updateActivity', await okBody(await update('activity', SUPERVISOR, ACT1, { dealId: null }), 200, 'updateActivity')],
      ];
      const listed = await okBody(await get(SUPERVISOR, '/api/v1/contacts'), 200, 'listContacts');
      reads.push(['listContacts', ((listed.data ?? []) as Json[]).find((row) => row.id === C1)]);
      for (const [label, record] of reads) {
        expect(customOf(record, label), label).toEqual({ tier__c: 'gold' });
        expect(withheldOf(record).filter((f) => f.includes('old__c')), label).toEqual([]);
      }
    });

    it('(V6) writing a retired key is unknown_field, the same body as a key that never existed', async () => {
      await retireField('contact', 'old__c');
      const retired = await update('contact', SUPERVISOR, C1, { custom: { old__c: 'keep' } });
      const never = await update('contact', SUPERVISOR, C1, { custom: { gone__c: 'keep' } });
      expectDetail(retired, 400, 'validation_failed', 'unknown_field', ['custom.old__c'], 'retired');
      expectDetail(never, 400, 'validation_failed', 'unknown_field', ['custom.gone__c'], 'never');
      expect(retired.text.replace(/old__c/g, 'KEY')).toBe(never.text.replace(/gone__c/g, 'KEY'));
      const created = await create('contact', SUPERVISOR, PROGRAMME_A1, { custom: { old__c: 'keep' } });
      expectDetail(created, 400, 'validation_failed', 'unknown_field', ['custom.old__c'], 'retired at create');
      const nulled = await update('contact', SUPERVISOR, C1, { custom: { old__c: null } });
      expectDetail(nulled, 400, 'validation_failed', 'unknown_field', ['custom.old__c'], 'retired cleared');
    });

    // T-0089 / D-L142 (lead edit): this test pinned the opposite ("survives other writes, no
    // purge yet"). Every custom write now drops retired keys; an untouched row keeps them.
    it.each(OBJECTS)('(V4, D-L142) %s: a custom write drops a retired key from the stored row; a row nobody writes keeps it', async (object) => {
      const written = A1_ROW[object];
      const untouched = A2_ROW[object];
      await plantCustom(object, written, { old__c: 'keep', txt__c: 'T-0089 stays' });
      await plantCustom(object, untouched, { old__c: 'keep', txt__c: 'T-0089 untouched' });
      await retireField(object, 'old__c');
      await okBody(await update(object, SUPERVISOR, written, { custom: { tier__c: 'gold' } }), 200, `${object}: write another key`);
      // As the migrator, so nothing is projected away: the key is gone from the row itself.
      expect(await storedCustom(object, written)).toEqual({ txt__c: 'T-0089 stays', tier__c: 'gold' });
      expect(await storedCustom(object, untouched), 'a row nobody wrote lost its retired value').toEqual({
        old__c: 'keep',
        txt__c: 'T-0089 untouched',
      });
    });

    it('a filter on a retired key is unknown_field, as for a key that never existed', async () => {
      await retireField('contact', 'old__c');
      for (const params of [[['custom[old__c]', 'keep']], [['customEmpty', 'old__c']]] as const) {
        expectDetail(await get(SUPERVISOR, '/api/v1/contacts', params), 400, 'validation_failed', 'unknown_field', ['custom.old__c'], JSON.stringify(params));
      }
    });
  });

  // =========================================================================
  // 5. Adversarial withholding (the heart of T-0089)
  // =========================================================================

  describe('withholding: a key at none in A1 never leaves the database for that caller', () => {
    beforeEach(async () => {
      await setTenantAdmin(USER_A_NO_PROGRAMME, true);
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'team_lead');
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A2, 'programme_manager');
      for (const object of OBJECTS) {
        await plantCustom(object, A1_ROW[object], { secret__c: MARK_A1, band__c: 'red', ro__c: 'T-0089 read only', tier__c: 'gold' });
        await plantCustom(object, A2_ROW[object], { secret__c: MARK_A2, band__c: 'blue', tier__c: 'silver' });
      }
      // C1B: in A1, no secret value at all (V1).
      await plantCustom('contact', C1B, { tier__c: 'bronze' });
      // Contacts on the accounts, for listAccountContacts.
      await observer.query('UPDATE contact SET account_id = $2 WHERE id = $1', [C1, ACC1]);
      await observer.query('UPDATE contact SET account_id = $2 WHERE id = $1', [C2, ACC2]);
    });

    /** A record as ACTOR may see it in A1: secret and band withheld, ro and tier visible. */
    function expectWithheldA1(record: unknown, where: string) {
      const custom = customOf(record, where);
      expect(custom, where).toEqual({ ro__c: 'T-0089 read only', tier__c: 'gold' });
      expect(withheldOf(record), where).toEqual(expect.arrayContaining(['custom.secret__c', 'custom.band__c']));
    }
    /** The same record kind in A2: everything readable. */
    function expectReadableA2(record: unknown, where: string) {
      const custom = customOf(record, where);
      expect(custom, where).toEqual({ secret__c: MARK_A2, band__c: 'blue', tier__c: 'silver' });
      expect(withheldOf(record).filter((f) => f.startsWith('custom.')), where).toEqual([]);
    }

    it('get and list reads of contacts and leads: the A1 value is absent and listed; the A2 value is served (the control)', async () => {
      const responses: request.Response[] = [];
      const got1 = await read('contact', ACTOR, C1);
      const got2 = await read('contact', ACTOR, C2);
      responses.push(got1, got2);
      expectWithheldA1(await okBody(got1, 200, 'getContact A1'), 'getContact A1');
      expectReadableA2(await okBody(got2, 200, 'getContact A2'), 'getContact A2');
      for (const path of ['/api/v1/contacts', '/api/v1/leads', `/api/v1/accounts/${ACC1}/contacts`]) {
        const response = await get(ACTOR, path, [['limit', '100']]);
        responses.push(response);
        const rows = ((await okBody(response, 200, path)).data ?? []) as Json[];
        expectWithheldA1(rows.find((row) => row.id === C1), `${path} C1`);
        if (!path.includes('/accounts/')) expectReadableA2(rows.find((row) => row.id === C2), `${path} C2`);
      }
      for (const response of responses) expect(response.text).not.toContain(MARK_A1);
    });

    it('(V1) a withheld key is listed even on a row that holds no value for it', async () => {
      const response = await read('contact', ACTOR, C1B);
      const body = await okBody(response, 200, 'getContact C1B');
      expect(customOf(body, 'C1B')).toEqual({ tier__c: 'bronze' });
      expect(withheldOf(body)).toEqual(expect.arrayContaining(['custom.secret__c', 'custom.band__c']));
      const holder = await okBody(await read('contact', ACTOR, C1), 200, 'getContact C1');
      expect(
        withheldOf(body).filter((f) => f.startsWith('custom.')).sort(),
        'withheldFields tells a row with a withheld value from one without',
      ).toEqual(withheldOf(holder).filter((f) => f.startsWith('custom.')).sort());
    });

    it('accounts: getAccount and listAccounts', async () => {
      const got = await read('account', ACTOR, ACC1);
      expectWithheldA1(await okBody(got, 200, 'getAccount'), 'getAccount');
      expectReadableA2(await okBody(await read('account', ACTOR, ACC2), 200, 'getAccount A2'), 'getAccount A2');
      const listed = await get(ACTOR, '/api/v1/accounts', [['limit', '100']]);
      const rows = ((await okBody(listed, 200, 'listAccounts')).data ?? []) as Json[];
      expectWithheldA1(rows.find((row) => row.id === ACC1), 'listAccounts A1');
      expectReadableA2(rows.find((row) => row.id === ACC2), 'listAccounts A2');
      for (const response of [got, listed]) expect(response.text).not.toContain(MARK_A1);
    });

    it('deals: getDeal, listDeals and every board card', async () => {
      const p1 = must(pipelines[PROGRAMME_A1], 'A1 pipeline').id;
      const got = await read('deal', ACTOR, DEAL1);
      expectWithheldA1(await okBody(got, 200, 'getDeal'), 'getDeal');
      expectReadableA2(await okBody(await read('deal', ACTOR, DEAL2), 200, 'getDeal A2'), 'getDeal A2');
      const listed = await get(ACTOR, `/api/v1/pipelines/${p1}/deals`);
      const rows = ((await okBody(listed, 200, 'listDeals')).data ?? []) as Json[];
      expectWithheldA1(rows.find((row) => row.id === DEAL1), 'listDeals');
      const board = await get(ACTOR, `/api/v1/pipelines/${p1}/board`);
      const stages = ((await okBody(board, 200, 'board')).stages ?? []) as { cards: Json[] }[];
      const card = stages.flatMap((stage) => stage.cards).find((c) => c.id === DEAL1);
      expectWithheldA1(card, 'board card');
      // The board's own withheldFields is DealWithheldField only: no custom path fits it.
      expect(schemaErrors(responseSchemaOf('getPipelineBoard', '200'), board.body, 'board')).toEqual([]);
      for (const response of [got, listed, board]) expect(response.text).not.toContain(MARK_A1);
    });

    it('write answers: updateContact, updateAccount, updateActivity, updateDeal and moveDeal omit the A1 value', async () => {
      const p1 = must(pipelines[PROGRAMME_A1], 'A1 pipeline');
      const answers: [string, request.Response][] = [
        ['updateContact', await update('contact', ACTOR, C1, { status: 'contacted' })],
        ['updateAccount', await update('account', ACTOR, ACC1, { custom: { tier__c: 'bronze' } })],
        // T-0089 / D-L142: a standard write the closed UpdateActivityRequest admits (it has no `subject`).
        ['updateActivity', await update('activity', ACTOR, ACT1, { dealId: null })],
        ['updateDeal', await update('deal', ACTOR, DEAL1, { nextStep: 'T-0089 next' })],
      ];
      answers.push([
        'moveDeal',
        await send('post', `/api/v1/deals/${enc(DEAL1)}/move`, ACTOR, { version: await versionOf('deal', DEAL1), toStageId: p1.s1 }),
      ]);
      for (const [label, response] of answers) {
        const body = await okBody(response, 200, label);
        const custom = customOf(body, label);
        expect(custom.secret__c, label).toBeUndefined();
        expect(custom.band__c, label).toBeUndefined();
        expect(withheldOf(body), label).toEqual(expect.arrayContaining(['custom.secret__c', 'custom.band__c']));
        expect(response.text, label).not.toContain(MARK_A1);
      }
    });

    it('(V4) a write by the caller who cannot see a key keeps that key’s stored value, on every object', async () => {
      for (const object of OBJECTS) {
        await okBody(await update(object, ACTOR, A1_ROW[object], { custom: { tier__c: 'bronze', vip__c: false } }), 200, `${object} write`);
        expect(await storedCustom(object, A1_ROW[object]), object).toEqual({
          secret__c: MARK_A1,
          band__c: 'red',
          ro__c: 'T-0089 read only',
          tier__c: 'bronze',
          vip__c: false,
        });
      }
    });

    // T-0089 / D-L142 (lead edit): the 512 KiB CHECK cannot be reached through the API by live
    // keys, but a non-API writer can fill a row. Then the database refuses (23514), and that must
    // still be the ordinary 400 custom_too_large, byte for byte the refusal of an over-16-KiB view
    // (this suite's ruling, so the backstop is no oracle either), never a 500.
    it('(D-L142) a write that only the 512 KiB backstop refuses is 400 custom_too_large, the same body as the API-limit refusal; nothing is written', async () => {
      const BACKSTOP = 524288;
      const room = 1500; // less than the 3,000-octet value written below
      const wrapper = '{"secret__c": ""}'.length;
      // secret__c is withheld from ACTOR in A1, so ACTOR's own view stays tiny.
      await plantCustom('contact', C1, { secret__c: 'x'.repeat(BACKSTOP - room - wrapper) });
      const sizeOf = async () =>
        Number(
          (await observer.query<{ n: number }>('SELECT octet_length(custom::text) AS n FROM contact WHERE id = $1', [C1])).rows[0]?.n,
        );
      // Self-check: the row sits exactly `room` octets under the backstop.
      expect(await sizeOf()).toBe(BACKSTOP - room);
      const version = await versionOf('contact', C1);
      const euros = '€'.repeat(1000); // 3,000 octets: crosses the backstop, far under 16 KiB visible
      const crossing = await update('contact', ACTOR, C1, { custom: { txt__c: euros } });
      expectDetail(crossing, 400, 'validation_failed', 'custom_too_large', ['custom'], 'the backstop');
      expect(await sizeOf(), 'the refused write was applied').toBe(BACKSTOP - room);
      expect(await versionOf('contact', C1)).toBe(version);
      // The reference: an ordinary over-16-KiB refusal of ACTOR on another A1 row.
      await plantCustom('contact', C1B, {});
      const big = Object.fromEntries(BIG_FIELDS.slice(0, 6).map((key) => [key, euros]));
      const ordinary = await update('contact', ACTOR, C1B, { custom: big });
      expectDetail(ordinary, 400, 'validation_failed', 'custom_too_large', ['custom'], 'the API limit');
      expect(crossing.text, 'a backstop refusal is told apart from the API-limit refusal').toBe(ordinary.text);
    });

    it('writing a withheld key is 403 field_not_editable at custom.<key>, value or null, before any 400 (V5), on every object; nothing is written', async () => {
      for (const object of OBJECTS) {
        const id = A1_ROW[object];
        const version = await versionOf(object, id);
        for (const custom of [
          { secret__c: 'T-0089 overwrite' },
          { secret__c: null },
          { secret__c: 42 },
          { band__c: 'blue' },
          { band__c: 'diamond' },
          { ro__c: 'T-0089 overwrite' },
          { ro__c: null },
          { tier__c: 'bronze', secret__c: 'T-0089 overwrite' },
        ]) {
          const key = 'secret__c' in custom ? 'secret__c' : 'band__c' in custom ? 'band__c' : 'ro__c';
          const response = await update(object, ACTOR, id, { custom });
          notEditable(response, key, `${object} ${JSON.stringify(custom)}`);
          expect(response.text).not.toContain(MARK_A1);
          expect(response.text).not.toContain('T-0089 overwrite');
        }
        expect(await storedCustom(object, id), object).toEqual({ secret__c: MARK_A1, band__c: 'red', ro__c: 'T-0089 read only', tier__c: 'gold' });
        expect(await versionOf(object, id), object).toBe(version);
      }
    });

    it('creating with a withheld key in A1 is 403 and creates nothing; the same key in A2, where it is edit, is 201', async () => {
      for (const object of OBJECTS) {
        notEditable(await create(object, ACTOR, PROGRAMME_A1, { custom: { secret__c: 'T-0089 new' } }), 'secret__c', `${object} A1`);
        const made = await okBody(await create(object, ACTOR, PROGRAMME_A2, { custom: { secret__c: 'T-0089 new' } }), 201, `${object} A2`);
        expect(customOf(made, `${object} A2`)).toEqual({ secret__c: 'T-0089 new' });
        // In A2 band__c is read: even there it cannot be written.
        notEditable(await create(object, ACTOR, PROGRAMME_A2, { custom: { band__c: 'red' } }), 'band__c', `${object} A2 band`);
      }
      const leaked = await observer.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM contact WHERE programme_id = $1 AND custom->>'secret__c' = 'T-0089 new')
              + (SELECT count(*) FROM account WHERE programme_id = $1 AND custom->>'secret__c' = 'T-0089 new')
              + (SELECT count(*) FROM activity WHERE programme_id = $1 AND custom->>'secret__c' = 'T-0089 new')
              + (SELECT count(*) FROM deal WHERE programme_id = $1 AND custom->>'secret__c' = 'T-0089 new') AS n`,
        [PROGRAMME_A1],
      );
      expect(Number(leaked.rows[0]?.n)).toBe(0);
    });

    it('a filter on a key withheld in ANY reachable programme is 400 field_withheld, on all four lists, equality and is-empty alike', async () => {
      const p1 = must(pipelines[PROGRAMME_A1], 'A1 pipeline').id;
      const lists = ['/api/v1/contacts', '/api/v1/leads', '/api/v1/accounts', `/api/v1/pipelines/${p1}/deals`];
      for (const path of lists) {
        // The control: a filter on a visible picklist works for this caller.
        await okBody(await get(ACTOR, path, [['custom[tier__c]', 'gold']]), 200, `${path} control`);
        for (const params of [
          [['custom[band__c]', 'red']],
          [['custom[band__c]', 'blue']],
          [['customEmpty', 'band__c']],
          [['custom[tier__c]', 'gold'], ['custom[band__c]', 'blue']],
        ] as const) {
          const response = await get(ACTOR, path, params);
          expectDetail(response, 400, 'validation_failed', 'field_withheld', ['custom.band__c'], `${path} ${JSON.stringify(params)}`);
        }
      }
      // AGENT_2 reaches A2 only, where band__c is edit for the agent set: the same filter is served.
      const served = await okBody(await get(AGENT_2, '/api/v1/contacts', [['custom[band__c]', 'blue']]), 200, 'agent 2');
      expect(ids(served)).toEqual([C2]);
    });

    it('(V10) no sort on a custom key, on any list', async () => {
      const p1 = must(pipelines[PROGRAMME_A1], 'A1 pipeline').id;
      // The control fails on main: custom must be served before this means anything.
      customOf(await okBody(await read('contact', ACTOR, C2), 200, 'control'), 'control');
      for (const path of ['/api/v1/contacts', '/api/v1/leads', '/api/v1/accounts', `/api/v1/pipelines/${p1}/deals`]) {
        for (const sort of ['tier__c', 'custom.tier__c', '-custom.tier__c', 'custom[tier__c]', 'band__c', 'custom.band__c']) {
          expectError(await get(SUPERVISOR, path, [['sort', sort]]), 400, 'validation_failed', `${path} sort=${sort}`);
        }
      }
    });

    it('(V7) search and q never match a custom value, withheld or readable', async () => {
      // The control: the A2 value is served to ACTOR, so it exists to be found.
      expectReadableA2(await okBody(await read('contact', ACTOR, C2), 200, 'control'), 'control');
      for (const mark of [MARK_A1, MARK_A2]) {
        for (const path of ['/api/v1/contacts', '/api/v1/leads', '/api/v1/accounts']) {
          const page = await okBody(await get(ACTOR, path, [['q', mark]]), 200, `${path} q`);
          expect(ids(page), `${path} q=${mark}`).toEqual([]);
        }
        const search = await get(ACTOR, '/api/v1/search', [['q', mark]]);
        expect(search.status, search.text).toBe(200);
        expect(JSON.stringify(search.body).includes('"id"'), `search found something for ${mark}: ${search.text}`).toBe(false);
      }
      const byName = await get(ACTOR, '/api/v1/search', [['q', must(SEED_CONTACTS.find((c) => c.id === C1), 'C1').displayName]]);
      expect(byName.status, byName.text).toBe(200);
      expect(byName.text, 'the name search found nothing: the probe above is vacuous').toContain(C1);
      expect(byName.text).not.toContain(MARK_A1);
    });

    it('(V11) the contact timeline and the audit log never carry a custom value; the timeline still validates', async () => {
      const fresh = `zqtime${RUN}`;
      await okBody(await update('contact', SUPERVISOR, C1, { custom: { secret__c: fresh, txt__c: fresh, tier__c: 'silver' } }), 200, 'write');
      for (const [label, headers] of [['actor', ACTOR], ['supervisor', SUPERVISOR]] as const) {
        const timeline = await get(headers, `/api/v1/contacts/${enc(C1)}/timeline`);
        expect(timeline.status, `${label}: ${timeline.text}`).toBe(200);
        expect(schemaErrors(responseSchemaOf('listContactTimeline', '200'), timeline.body, `${label} timeline`)).toEqual([]);
        expect(timeline.text, label).not.toContain(fresh);
        expect(timeline.text, label).not.toContain(MARK_A1);
      }
      // V15 (D-L141 ruling 6): an audit read may name the custom keys; it never shows a value.
      const audit = await get(SUPERVISOR, '/api/v1/admin/audit/events', [['pageSize', '200']]);
      expect(audit.status, audit.text).toBe(200);
      // Not vacuous: the read holds the event of the write above.
      expect(audit.text, 'the audit read misses the custom write').toContain(C1);
      expect(audit.text).not.toContain(fresh);
      expect(audit.text).not.toContain(MARK_A1);
      expect(audit.text).not.toContain('"silver"');
    });

    it('nothing ACTOR does in A1 puts the A1 value in a log, a span or an error body', async () => {
      const p1 = must(pipelines[PROGRAMME_A1], 'A1 pipeline');
      const bodies: string[] = [];
      const lines = await captureEverything(async () => {
        const responses = [
          await read('contact', ACTOR, C1),
          await get(ACTOR, '/api/v1/contacts', [['limit', '100']]),
          await get(ACTOR, '/api/v1/contacts', [['custom[band__c]', 'red']]),
          await update('contact', ACTOR, C1, { custom: { secret__c: `${ECHO} overwrite` } }),
          await update('contact', ACTOR, C1, { custom: { tier__c: ECHO } }),
          await update('contact', ACTOR, C1, { custom: { nope__c: ECHO } }),
          await update('deal', ACTOR, DEAL1, { custom: { amt__c: { amountMinor: ECHO, currency: 'NGN' } } }),
          await send('post', `/api/v1/deals/${enc(DEAL1)}/move`, ACTOR, { version: 999, toStageId: p1.s1 }),
          await update('account', ACTOR, ACC1, { custom: { txt__c: `${ECHO}\nline` } }),
          await update('activity', ACTOR, ACT1, { custom: { day__c: ECHO } }),
          await read('deal', ACTOR, DEAL1),
          await get(ACTOR, `/api/v1/pipelines/${p1.id}/board`),
        ];
        for (const response of responses) bodies.push(response.text);
      });
      // Not vacuous: the requests ran and answered.
      expect(bodies).toHaveLength(12);
      const leaks = [...lines, ...bodies].filter((line) => line.includes(MARK_A1) || line.toLowerCase().includes(ECHO.toLowerCase()));
      expect(leaks, 'a withheld or refused value reached a log, span or body').toEqual([]);
    });

    it('(V3) the SQL projection: no statement result or bound value carries the A1 value, on reads and writes; the A2 value is seen (the control)', async () => {
      const p1 = must(pipelines[PROGRAMME_A1], 'A1 pipeline');
      const statuses: number[] = [];
      const recorded = await recordStatements(async () => {
        // T-0089 / D-L142: thunks, built and awaited one at a time. Building every
        // supertest request up front makes each listen/close on the shared server
        // race the others (ECONNREFUSED).
        const calls: (() => request.Test)[] = [
          () => read('contact', ACTOR, C1),
          () => get(ACTOR, '/api/v1/contacts', [['limit', '100']]),
          () => get(ACTOR, '/api/v1/leads', [['limit', '100']]),
          () => get(ACTOR, `/api/v1/accounts/${ACC1}/contacts`),
          () => read('account', ACTOR, ACC1),
          () => get(ACTOR, '/api/v1/accounts', [['limit', '100']]),
          () => read('deal', ACTOR, DEAL1),
          () => get(ACTOR, `/api/v1/pipelines/${p1.id}/deals`),
          () => get(ACTOR, `/api/v1/pipelines/${p1.id}/board`),
          () => get(ACTOR, '/api/v1/contacts', [['custom[tier__c]', 'gold']]),
        ];
        for (const call of calls) statuses.push((await call()).status);
        // The observer's version reads are recorded too; they select `version` only.
        statuses.push((await update('contact', ACTOR, C1, { custom: { tier__c: 'bronze' } })).status);
        statuses.push((await update('account', ACTOR, ACC1, { custom: { vip__c: true } })).status);
        // T-0089 / D-L142: the closed UpdateActivityRequest has no `subject`; `dealId: null` is admitted.
        statuses.push((await update('activity', ACTOR, ACT1, { dealId: null })).status);
        statuses.push((await update('deal', ACTOR, DEAL1, { nextStep: 'T-0089 projected' })).status);
        const version = await versionOf('deal', DEAL1);
        statuses.push((await send('post', `/api/v1/deals/${enc(DEAL1)}/move`, ACTOR, { version, toStageId: p1.s1 })).status);
      });
      expect(statuses, 'a request in the probe failed, so the probe proves nothing').toEqual(statuses.map(() => 200));
      const control = await recordStatements(async () => {
        expect((await read('contact', ACTOR, C2)).status).toBe(200);
      });
      expect(
        control.some((entry) => entry.result.includes(MARK_A2)),
        'the recorder never saw the A2 value it was served: it is blind, and the main assertion would be vacuous',
      ).toBe(true);
      const leaks = recorded
        .filter((entry) => entry.result.includes(MARK_A1) || entry.values.includes(MARK_A1) || entry.text.includes(MARK_A1))
        .map((entry) => entry.text.replace(/\s+/g, ' ').slice(0, 200));
      expect(leaks, 'a statement carried the withheld A1 value out of Postgres').toEqual([]);
      // Not vacuous: the requests above ran real statements.
      expect(recorded.length).toBeGreaterThan(20);
    });
  });

  // =========================================================================
  // 6. Filters
  // =========================================================================

  describe('filters: picklist and boolean equality and is-empty, inside the scoped page', () => {
    beforeEach(async () => {
      // tier / vip across both programmes; C1C and C2B empty.
      await plantCustom('contact', C1, { tier__c: 'gold', vip__c: true });
      await plantCustom('contact', C1B, { tier__c: 'silver', vip__c: false });
      await plantCustom('contact', C2, { tier__c: 'gold', vip__c: true });
      await plantCustom('contact', C2C, { tier__c: 'bronze' });
      await plantCustom('account', ACC1, { tier__c: 'gold' });
      await plantCustom('account', ACC2, { tier__c: 'silver', vip__c: false });
      await plantCustom('deal', DEAL1, { tier__c: 'gold', vip__c: true });
      await plantCustom('deal', DEAL1B, { tier__c: 'silver' });
    });

    it.each(['/api/v1/contacts', '/api/v1/leads'])('%s: equality, is-empty and AND return exactly the matching rows of the caller’s scope', async (path) => {
      const cases: [Params, string[]][] = [
        [[['custom[tier__c]', 'gold']], [C1, C2]],
        [[['custom[tier__c]', 'silver']], [C1B]],
        [[['custom[vip__c]', 'true']], [C1, C2]],
        [[['custom[vip__c]', 'false']], [C1B]],
        [[['customEmpty', 'tier__c']], [C1C, C2B]],
        [[['customEmpty', 'vip__c']], [C1C, C2B, C2C]],
        [[['customEmpty', 'tier__c'], ['customEmpty', 'vip__c']], [C1C, C2B]],
        [[['custom[tier__c]', 'gold'], ['custom[vip__c]', 'true']], [C1, C2]],
        [[['custom[tier__c]', 'gold'], ['custom[vip__c]', 'false']], []],
        [[['custom[tier__c]', 'bronze'], ['customEmpty', 'vip__c']], [C2C]],
      ];
      for (const [params, expected] of cases) {
        const page = await okBody(await get(SUPERVISOR, path, [...params, ['limit', '100']]), 200, `${path} ${JSON.stringify(params)}`);
        expect(ids(page), JSON.stringify(params)).toEqual([...expected].sort());
      }
      // Scope: the A1 agent never gets A2's match.
      const agent = await okBody(await get(AGENT_1, path, [['custom[tier__c]', 'gold']]), 200, 'agent');
      expect(ids(agent)).toEqual([C1]);
    });

    it('listAccounts and listDeals: equality and is-empty', async () => {
      const p1 = must(pipelines[PROGRAMME_A1], 'A1 pipeline').id;
      const cases: [string, Params, string[]][] = [
        ['/api/v1/accounts', [['custom[tier__c]', 'gold']], [ACC1]],
        ['/api/v1/accounts', [['custom[vip__c]', 'false']], [ACC2]],
        ['/api/v1/accounts', [['customEmpty', 'vip__c']], [ACC1]],
        [`/api/v1/pipelines/${p1}/deals`, [['custom[tier__c]', 'gold']], [DEAL1]],
        [`/api/v1/pipelines/${p1}/deals`, [['customEmpty', 'vip__c']], [DEAL1B]],
        [`/api/v1/pipelines/${p1}/deals`, [['custom[vip__c]', 'true'], ['custom[tier__c]', 'silver']], []],
      ];
      for (const [path, params, expected] of cases) {
        const page = await okBody(await get(SUPERVISOR, path, [...params, ['limit', '100']]), 200, `${path} ${JSON.stringify(params)}`);
        expect(ids(page), `${path} ${JSON.stringify(params)}`).toEqual([...expected].sort());
      }
    });

    it('a filtered list pages by keyset: limit 1 walks exactly the matches, once each, with id-only cursors', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const params: [string, string][] = [['custom[tier__c]', 'gold'], ['limit', '1']];
        if (cursor !== null) params.push(['cursor', cursor]);
        const page = await okBody(await get(SUPERVISOR, '/api/v1/contacts', params), 200, `page ${guard}`);
        const data = (page.data ?? []) as Json[];
        seen.push(...data.map((row) => String(row.id)));
        cursor = typeof page.nextCursor === 'string' ? page.nextCursor : null;
        if (cursor !== null) {
          const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
          expect(decoded, 'the cursor carries the filter value').not.toContain('gold');
          expect(decoded, 'the cursor carries a custom key').not.toContain('tier__c');
        }
        if (cursor === null) break;
      }
      expect([...seen].sort()).toEqual([C1, C2].sort());
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('a filter on text, number, currency or date is 400 filter_not_supported; an unknown key is unknown_field', async () => {
      // The control: a supported filter is served.
      await okBody(await get(SUPERVISOR, '/api/v1/contacts', [['custom[tier__c]', 'gold']]), 200, 'control');
      const p1 = must(pipelines[PROGRAMME_A1], 'A1 pipeline').id;
      for (const path of ['/api/v1/contacts', '/api/v1/leads', '/api/v1/accounts', `/api/v1/pipelines/${p1}/deals`]) {
        for (const key of ['txt__c', 'num__c', 'amt__c', 'day__c']) {
          for (const params of [[[`custom[${key}]`, 'abc']], [['customEmpty', key]]] as const) {
            expectDetail(await get(SUPERVISOR, path, params), 400, 'validation_failed', 'filter_not_supported', [`custom.${key}`], `${path} ${JSON.stringify(params)}`);
          }
        }
        for (const params of [[['custom[nope__c]', 'abc']], [['customEmpty', 'nope__c']]] as const) {
          expectDetail(await get(SUPERVISOR, path, params), 400, 'validation_failed', 'unknown_field', ['custom.nope__c'], `${path} ${JSON.stringify(params)}`);
        }
      }
    });

    it('(V9) a definition planted by another process is filterable on the next request, and its retirement is honoured on the next', async () => {
      const object = await observer.query<{ id: string }>(
        `SELECT id FROM object_def WHERE tenant_id = $1 AND api_name = 'contact'`,
        [TENANT_A],
      );
      // First, the key is unknown.
      expectDetail(await get(SUPERVISOR, '/api/v1/contacts', [['custom[late__c]', 'yes']]), 400, 'validation_failed', 'unknown_field', ['custom.late__c'], 'before');
      await observer.query(
        `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification, is_custom, config)
         VALUES ($1, $2, $3, 'late__c', 'T-0089 late', 'picklist', 'none', true, $4::jsonb)`,
        [id89('c0000f01'), TENANT_A, must(object.rows[0]?.id, 'contact object'), JSON.stringify({ values: [{ value: 'yes', label: 'Yes' }] })],
      );
      await plantCustom('contact', C1C, { late__c: 'yes' });
      const after = await okBody(await get(SUPERVISOR, '/api/v1/contacts', [['custom[late__c]', 'yes']]), 200, 'after');
      expect(ids(after)).toEqual([C1C]);
      await observer.query('UPDATE field_def SET retired_at = now() WHERE id = $1', [id89('c0000f01')]);
      expectDetail(await get(SUPERVISOR, '/api/v1/contacts', [['custom[late__c]', 'yes']]), 400, 'validation_failed', 'unknown_field', ['custom.late__c'], 'retired');
      const reread = await okBody(await read('contact', SUPERVISOR, C1C), 200, 'reread');
      expect(customOf(reread, 'reread')).toEqual({});
    });
  });
});
