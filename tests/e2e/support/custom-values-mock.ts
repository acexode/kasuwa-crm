import type { Request, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * Custom-field DEFINITIONS (`listCustomFields`, docs/api/admin.openapi.yaml)
 * and custom-field VALUES on the record rows (`custom`, `CustomFieldsPatch`,
 * the `custom` and `customEmpty` list filters and `withheldFields`
 * `custom.<key>`, docs/api/records.openapi.yaml), served into the browser by
 * Playwright for T-0091 (custom values on the record screens). Written by the
 * lead's QA agent with the T-0091 acceptance suite (D-L23), and used by every
 * records mock (records, leads, accounts, contact record, account record,
 * deal, pipeline, activities) through one `CustomFieldsServer` each.
 *
 * Named `custom-values-mock.ts` so it never collides with T-0090's
 * `custom-fields-mock.ts`, the admin studio's mock of the definition writes.
 * This file reads definitions only; it never creates, edits or retires one.
 *
 * ---------------------------------------------------------------------------
 * READ FROM THE CONTRACTS AT RUN TIME, AND EVERY ANSWER CHECKED AGAINST THEM
 *
 * The value encodings (CustomFieldText … CustomFieldBoolean), the key
 * pattern, the patch and filter shapes, the error bodies and the definition
 * schema come out of the two YAML files when this module loads. Every
 * definition below is validated as `CustomFieldDefinition`, and every
 * listCustomFields answer as `CustomFieldList`, so this file cannot hand a
 * screen a shape the real API never serves.
 *
 * WITH NO SETUP (`undefined`) THE MOCK CHANGES NOTHING ON THE ROWS
 *
 * The older screen suites install their mocks with no custom-field setup.
 * Then listCustomFields answers an EMPTY list for any object, rows carry no
 * `custom` (the contract lets a client cope with its absence) and any custom
 * value a screen sends is a violation. Those suites therefore prove that with
 * no definitions every screen is exactly what it was, inside its pinned byte
 * budget, while the flag that T-0091 adds is on in their process.
 *
 * WHAT IS NOT IN THE CONTRACT, AND IS THEREFORE DECLARED HERE
 *
 *   - Definitions for the four objects. The admin contract publishes one
 *     example list (contact). The fixtures below are DECLARED in its shape,
 *     with picklist labels that differ from their values (so a raw value
 *     drawn instead of a label is caught), currencies other than NGN on the
 *     account and deal (so a hard-coded NGN is caught), and one retired field
 *     per object.
 *   - Field security of custom keys, per object and per programme: which
 *     keys are WITHHELD (`none`) and which are READ-ONLY (`read`). The wire
 *     shows only the first (D-L84: there is no capability read), so a
 *     read-only key is learned from `403 field_not_editable`.
 *   - Stored values per record, retired and withheld keys included: a
 *     withheld or retired value EXISTS here and is projected out of every
 *     read (ADR-0016 item 6), so a leak would have something to leak.
 *
 * WHAT THE MOCK ENFORCES (recorded as `violations`, the SCREEN's fault)
 *
 *   - listCustomFields: only `object` (one of the four) and `includeRetired`;
 *     `includeRetired=true` is a violation, because a record screen never
 *     shows a retired field (the studio, T-0090, is the only reader of them).
 *   - Patches (`custom` on an update): an object of 1..100 keys; every key an
 *     ACTIVE definition of the record's object; never a key withheld from the
 *     caller in the record's programme (a caller cannot write what it cannot
 *     read); every value in its field's encoding (a currency in the FIELD's
 *     currency, a picklist VALUE never its label, a canonical decimal string
 *     for a number, `YYYY-MM-DD` for a date, a JSON boolean); and ONLY
 *     changed keys: a value equal to what was served, or a `null` for a key
 *     that has no value, is "sent unchanged". A key answered
 *     `field_not_editable` and sent again in the same session is a
 *     violation: the screen was told.
 *   - Creates (`custom` on a create): values only, never `null`, the same
 *     key and encoding rules.
 *   - Filters: only `custom[<key>]=<value>` and `customEmpty=<key>`; a key at
 *     most once; at most ten of each; only ACTIVE picklist and boolean keys
 *     (any other type is a violation AND `400 filter_not_supported`); a
 *     picklist value the field defines; `true` or `false` for a boolean.
 *
 * SERVER BEHAVIOUR THE SCREENS DEPEND ON, AS THE CONTRACTS SAY
 *
 *   - Reads project: a key withheld in the record's programme is ABSENT from
 *     `custom` and listed as `custom.<key>` (even when the record has no
 *     value for it, D-L141); a retired key is in neither; a value is never
 *     `null`.
 *   - Writes merge per key; `null` removes; every write drops retired keys
 *     (D-L142).
 *   - A filter on a key withheld in ANY programme the caller reaches is
 *     `400 field_withheld` at `custom.<key>`. Not a violation: the screen
 *     cannot always know (a programme with no row on screen still counts).
 *   - Error details name a path and a code, never the value.
 * ---------------------------------------------------------------------------
 */

export const RECORDS_CONTRACT_SOURCE = 'docs/api/records.openapi.yaml';
export const ADMIN_CONTRACT_SOURCE = 'docs/api/admin.openapi.yaml';

export const CUSTOM_FIELDS_PATH = '/api/v1/admin/custom-fields';

const repoRoot = resolve(__dirname, '..', '..', '..');

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type Doc = 'records' | 'admin';

const DOCS: Readonly<Record<Doc, unknown>> = {
  records: parse(readFileSync(resolve(repoRoot, RECORDS_CONTRACT_SOURCE), 'utf8')),
  admin: parse(readFileSync(resolve(repoRoot, ADMIN_CONTRACT_SOURCE), 'utf8')),
};

function at(doc: Doc, ...path: string[]): unknown {
  let current: unknown = DOCS[doc];
  for (const segment of path) {
    if (!isJson(current)) {
      throw new Error(`${doc} contract: nothing at ${path.join('.')}`);
    }
    current = current[segment];
  }
  if (current === undefined) {
    throw new Error(`${doc} contract: nothing at ${path.join('.')}`);
  }
  return current;
}

/** Follows a `$ref`, within a file or into the sibling contract. */
function follow(ref: string, from: Doc): { node: unknown; doc: Doc } {
  const [file, pointer] = ref.includes('#') ? (ref.split('#') as [string, string]) : ['', ref];
  const doc: Doc = file === '' ? from : file.includes('admin') ? 'admin' : 'records';
  return { node: at(doc, ...pointer.replace(/^\//, '').split('/')), doc };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

function realDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/**
 * A JSON-Schema subset: exactly what these schemas use (refs across the two
 * files, allOf, anyOf, oneOf, const, enum, string bounds and patterns, uuid,
 * date and date-time formats, arrays, closed and open objects, propertyNames,
 * min/maxProperties). Problems name a path, never a value.
 */
export function schemaProblems(value: unknown, raw: unknown, doc: Doc, path = ''): string[] {
  let spec: unknown = raw;
  let where: Doc = doc;
  while (isJson(spec) && typeof spec.$ref === 'string') {
    const next = follow(spec.$ref, where);
    spec = next.node;
    where = next.doc;
  }
  if (!isJson(spec)) return [];
  const here = path || 'value';
  const problems: string[] = [];
  if (Array.isArray(spec.allOf)) {
    for (const part of spec.allOf) problems.push(...schemaProblems(value, part, where, path));
  }
  if (Array.isArray(spec.anyOf) && !spec.anyOf.some((option) => schemaProblems(value, option, where, path).length === 0)) {
    problems.push(`${here} matches none of anyOf`);
  }
  if (Array.isArray(spec.oneOf)) {
    const passing = spec.oneOf.filter((option) => schemaProblems(value, option, where, path).length === 0).length;
    if (passing !== 1) problems.push(`${here} matches ${passing} of oneOf, not exactly 1`);
  }
  if (spec.type !== undefined) {
    const allowed = (Array.isArray(spec.type) ? spec.type : [spec.type]).map(String);
    const actual = typeOf(value);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      return [...problems, `${here} is ${actual}, not ${allowed.join('|')}`];
    }
  }
  if ('const' in spec && spec.const !== value) problems.push(`${here} is not the constant ${String(spec.const)}`);
  if (Array.isArray(spec.enum) && !spec.enum.includes(value)) problems.push(`${here} is not one of its enum`);
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof spec.minLength === 'number' && length < spec.minLength) problems.push(`${here} is too short`);
    if (typeof spec.maxLength === 'number' && length > spec.maxLength) problems.push(`${here} is too long`);
    if (typeof spec.pattern === 'string' && !new RegExp(spec.pattern).test(value)) problems.push(`${here} does not match its pattern`);
    if (spec.format === 'uuid' && !UUID_PATTERN.test(value)) problems.push(`${here} is not a uuid`);
    if (spec.format === 'date' && !realDate(value)) problems.push(`${here} is not a calendar date`);
    if (spec.format === 'date-time' && !UTC_DATE_TIME.test(value)) problems.push(`${here} is not a UTC date-time with a Z`);
  }
  if (typeof value === 'number') {
    if (typeof spec.minimum === 'number' && value < spec.minimum) problems.push(`${here} is below its minimum`);
    if (typeof spec.maximum === 'number' && value > spec.maximum) problems.push(`${here} is above its maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof spec.minItems === 'number' && value.length < spec.minItems) problems.push(`${here} has too few items`);
    if (typeof spec.maxItems === 'number' && value.length > spec.maxItems) problems.push(`${here} has too many items`);
    if (spec.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      problems.push(`${here} repeats an item`);
    }
    if (spec.items !== undefined) {
      value.forEach((item, index) => problems.push(...schemaProblems(item, spec.items, where, `${path}[${index}]`)));
    }
  }
  if (isJson(value)) {
    const properties = isJson(spec.properties) ? spec.properties : {};
    const keys = Object.keys(value);
    for (const key of Array.isArray(spec.required) ? (spec.required as string[]) : []) {
      if (!(key in value)) problems.push(`${path ? `${path}.` : ''}${key} is required`);
    }
    if (typeof spec.minProperties === 'number' && keys.length < spec.minProperties) problems.push(`${here} has too few properties`);
    if (typeof spec.maxProperties === 'number' && keys.length > spec.maxProperties) problems.push(`${here} has too many properties`);
    for (const key of keys) {
      const child = `${path ? `${path}.` : ''}${key}`;
      if (spec.propertyNames !== undefined && schemaProblems(key, spec.propertyNames, where, child).length > 0) {
        problems.push(`${here} has a property name its schema refuses`);
      }
      if (key in properties) {
        problems.push(...schemaProblems(value[key], properties[key], where, child));
      } else if (spec.additionalProperties === false) {
        problems.push(`${child} is not a property of this closed object`);
      } else if (isJson(spec.additionalProperties)) {
        problems.push(...schemaProblems(value[key], spec.additionalProperties, where, child));
      }
    }
  }
  return problems;
}

function recordsSchema(name: string): Json {
  return at('records', 'components', 'schemas', name) as Json;
}

function adminSchema(name: string): Json {
  return at('admin', 'components', 'schemas', name) as Json;
}

/** The custom api-name pattern (`…__c`), from the contract. */
export const CUSTOM_KEY_PATTERN = new RegExp(String(recordsSchema('CustomFieldKey').pattern));

const LIST_EXAMPLE = at('admin', 'paths', CUSTOM_FIELDS_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example') as Json;

/** The limits, verbatim from the contract's example (they are `const`s in CustomFieldLimits). */
export const CUSTOM_FIELD_LIMITS = clone(LIST_EXAMPLE.limits) as { apiBytes: number; [limit: string]: number };

export const CUSTOM_OBJECTS = (adminSchema('CustomFieldObject').enum as unknown[]).map(String) as readonly CustomObject[];
export type CustomObject = 'contact' | 'account' | 'activity' | 'deal';
export type CustomFieldType = 'text' | 'number' | 'currency' | 'date' | 'picklist' | 'boolean';

export interface CustomFieldDefinition {
  id: string;
  objectApiName: CustomObject;
  apiName: string;
  label: string;
  description: string | null;
  type: CustomFieldType;
  classification: 'none' | 'pii' | 'sensitive';
  config: { values?: { value: string; label: string }[]; currencyCode?: string };
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The records contract's error bodies, with our details. */
function errorExample(doc: Doc, response: string, name?: string): Json {
  let node: unknown = at(doc, 'components', 'responses', response);
  let where: Doc = doc;
  while (isJson(node) && typeof node.$ref === 'string') {
    const next = follow(node.$ref, where);
    node = next.node;
    where = next.doc;
  }
  const json = (isJson(node) && isJson(node.content) ? node.content['application/json'] : undefined) as Json | undefined;
  const examples = isJson(json?.examples) ? json.examples : {};
  const named = name === undefined ? undefined : (examples[name] as Json | undefined)?.value;
  const body = named ?? json?.example ?? Object.values(examples).map((entry) => (entry as Json).value)[0];
  if (!isJson(body)) {
    throw new Error(`${doc} contract: no example body for ${response}${name === undefined ? '' : ` (${name})`}`);
  }
  return clone(body);
}

export interface Detail {
  path: string;
  code: string;
}

export interface Answer {
  status: number;
  body: Json;
}

export function validationFailed(details: readonly Detail[]): Answer {
  const body = errorExample('records', 'ValidationFailed', 'badField');
  body.details = details.map((detail) => ({ ...detail }));
  return { status: 400, body };
}

export function fieldNotEditable(details: readonly Detail[]): Answer {
  const body = errorExample('records', 'NotPermitted', 'field');
  body.details = details.map((detail) => ({ ...detail }));
  return { status: 403, body };
}

// ---------------------------------------------------------------------------
// The definitions
// ---------------------------------------------------------------------------

const DEFINITION_SCHEMA = adminSchema('CustomFieldDefinition');
const LIST_SCHEMA = adminSchema('CustomFieldList');

const CREATED_AT = '2026-10-14T09:00:00.000Z';

function definition(
  object: CustomObject,
  serial: number,
  apiName: string,
  label: string,
  type: CustomFieldType,
  extra: Partial<Pick<CustomFieldDefinition, 'config' | 'classification' | 'retiredAt' | 'description'>> = {},
): CustomFieldDefinition {
  const objectSerial = { contact: 1, account: 2, activity: 3, deal: 4 }[object];
  const field: CustomFieldDefinition = {
    id: `11111111-0000-4000-8000-0000${String(objectSerial)}${String(serial).padStart(7, '0')}`,
    objectApiName: object,
    apiName,
    label,
    description: extra.description ?? null,
    type,
    classification: extra.classification ?? 'none',
    config: extra.config ?? {},
    retiredAt: extra.retiredAt ?? null,
    createdAt: CREATED_AT,
    updatedAt: extra.retiredAt ?? CREATED_AT,
  };
  const problems = schemaProblems(field, DEFINITION_SCHEMA, 'admin', `definition ${apiName}`);
  if (problems.length > 0) {
    throw new Error(`a fixture definition disagrees with ${ADMIN_CONTRACT_SOURCE}: ${problems.join('; ')}`);
  }
  return field;
}

const RETIRED_AT = '2026-10-16T12:00:00.000Z';

/**
 * The contact object (a lead is a contact, D-P17). Picklist labels differ
 * from their values; `legacy_ref__c` is retired.
 */
export const CONTACT_FIELDS: readonly CustomFieldDefinition[] = [
  definition('contact', 1, 'alternate_name__c', 'Alternate name', 'text', { classification: 'pii' }),
  definition('contact', 2, 'credit_limit__c', 'Credit limit', 'currency', { classification: 'sensitive', config: { currencyCode: 'NGN' } }),
  definition('contact', 3, 'legacy_ref__c', 'Legacy reference', 'text', { retiredAt: RETIRED_AT }),
  definition('contact', 4, 'renewal_date__c', 'Renewal date', 'date'),
  definition('contact', 5, 'risk_band__c', 'Risk band', 'picklist', {
    config: { values: [{ value: 'low', label: 'Low risk' }, { value: 'medium', label: 'Medium risk' }, { value: 'high', label: 'High risk' }] },
  }),
  definition('contact', 6, 'satisfaction_score__c', 'Satisfaction score', 'number'),
  definition('contact', 7, 'service_note__c', 'Service note', 'text'),
  definition('contact', 8, 'tier__c', 'Customer tier', 'picklist', {
    config: { values: [{ value: 'gold', label: 'Gold' }, { value: 'silver', label: 'Silver (legacy)' }, { value: 'platinum', label: 'Platinum partner' }] },
  }),
  definition('contact', 9, 'vip__c', 'Priority customer', 'boolean'),
];

/** The account object. Its currency field is GHS, never NGN. */
export const ACCOUNT_FIELDS: readonly CustomFieldDefinition[] = [
  definition('account', 1, 'contract_value__c', 'Contract value', 'currency', { config: { currencyCode: 'GHS' } }),
  definition('account', 2, 'internal_rating__c', 'Internal rating', 'text', { classification: 'sensitive' }),
  definition('account', 3, 'key_account__c', 'Key account', 'boolean'),
  definition('account', 4, 'old_code__c', 'Old code', 'text', { retiredAt: RETIRED_AT }),
  definition('account', 5, 'review_date__c', 'Review date', 'date'),
  definition('account', 6, 'segment__c', 'Segment', 'picklist', {
    config: { values: [{ value: 'public_sector', label: 'Public sector' }, { value: 'retail', label: 'Retail trade' }, { value: 'telco', label: 'Telecoms' }] },
  }),
];

/** The deal object. Its currency field is ZAR. */
export const DEAL_FIELDS: readonly CustomFieldDefinition[] = [
  definition('deal', 1, 'go_live__c', 'Go-live date', 'date'),
  definition('deal', 2, 'margin__c', 'Margin', 'currency', { config: { currencyCode: 'ZAR' } }),
  definition('deal', 3, 'old_stage__c', 'Old stage', 'text', { retiredAt: RETIRED_AT }),
  definition('deal', 4, 'partner_led__c', 'Partner led', 'boolean'),
  definition('deal', 5, 'source_channel__c', 'Source channel', 'picklist', {
    config: { values: [{ value: 'referral', label: 'Referral' }, { value: 'tender', label: 'Public tender' }, { value: 'inbound', label: 'Inbound enquiry' }] },
  }),
  definition('deal', 6, 'win_reason__c', 'Win reason', 'text', { classification: 'sensitive' }),
];

/** The activity object. */
export const ACTIVITY_FIELDS: readonly CustomFieldDefinition[] = [
  definition('activity', 1, 'follow_up__c', 'Follow-up needed', 'boolean'),
  definition('activity', 2, 'old_flag__c', 'Old flag', 'boolean', { retiredAt: RETIRED_AT }),
  definition('activity', 3, 'outcome__c', 'Call outcome', 'picklist', {
    config: { values: [{ value: 'promise', label: 'Promise to pay' }, { value: 'refused', label: 'Refused to pay' }, { value: 'callback', label: 'Call back later' }] },
  }),
  definition('activity', 4, 'promise_date__c', 'Promise date', 'date'),
  definition('activity', 5, 'promised_amount__c', 'Promised amount', 'currency', { config: { currencyCode: 'NGN' } }),
  definition('activity', 6, 'reference__c', 'Reference', 'text'),
];

export const ALL_FIELDS: Readonly<Record<CustomObject, readonly CustomFieldDefinition[]>> = {
  contact: CONTACT_FIELDS,
  account: ACCOUNT_FIELDS,
  activity: ACTIVITY_FIELDS,
  deal: DEAL_FIELDS,
};

export function fieldOf(object: CustomObject, apiName: string): CustomFieldDefinition {
  const found = ALL_FIELDS[object].find((field) => field.apiName === apiName);
  if (found === undefined) throw new Error(`no ${object} custom field ${apiName}`);
  return found;
}

/** A picklist value's label, as the definition says. */
export function picklistLabel(object: CustomObject, apiName: string, value: string): string {
  const label = fieldOf(object, apiName).config.values?.find((entry) => entry.value === value)?.label;
  if (label === undefined) throw new Error(`${object}.${apiName} defines no value ${value}`);
  return label;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** One value's problem, as the API would answer it: a code and a path, never the value. */
export function valueProblem(field: CustomFieldDefinition, value: unknown): Detail | undefined {
  const path = `custom.${field.apiName}`;
  const encoding = {
    text: 'CustomFieldText',
    number: 'CustomFieldNumber',
    currency: 'CustomFieldCurrency',
    date: 'CustomFieldDate',
    picklist: 'CustomFieldPicklist',
    boolean: 'CustomFieldBoolean',
  }[field.type];
  if (schemaProblems(value, recordsSchema(encoding), 'records', path).length > 0) {
    return { path, code: 'invalid_value' };
  }
  if (field.type === 'currency' && isJson(value) && value.currency !== field.config.currencyCode) {
    return { path: `${path}.currency`, code: 'currency_mismatch' };
  }
  if (field.type === 'picklist' && !(field.config.values ?? []).some((entry) => entry.value === value)) {
    return { path, code: 'unknown_value' };
  }
  return undefined;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Values no screen may ever show or send: each is stored behind a key that
 * is withheld or retired in the journeys that plant it. They are distinctive
 * so a leak anywhere (DOM, URL, body) is found by a plain substring search.
 */
export const WITHHELD_SENTINELS = {
  contact: 'Zebulon Quarantine-7731',
  account: 'Rating Quarantine-5518',
  deal: 'Reason Quarantine-2290',
  retiredContact: 'Retired Quarantine-4410',
  retiredAccount: 'OldCode Quarantine-6623',
  retiredDeal: 'OldStage Quarantine-9907',
} as const;

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export interface CustomRefusal {
  /** The code to answer every otherwise-valid write carrying `key` with. */
  readonly code: 'invalid_value' | 'custom_too_large' | 'unknown_field' | 'field_not_editable';
  readonly key: string;
}

export interface CustomFieldsSetup {
  /** Definitions per object, retired ones included. Default: every fixture above. */
  readonly definitions?: Partial<Record<CustomObject, readonly CustomFieldDefinition[]>>;
  /** Stored values per record id, withheld and retired keys included. */
  readonly values?: Readonly<Record<string, Readonly<Json>>>;
  /** Keys at `none` for the caller, per object, per programme id. */
  readonly withheld?: Partial<Record<CustomObject, Readonly<Record<string, readonly string[]>>>>;
  /** Keys at `read` for the caller (readable, not editable), per object, per programme id. */
  readonly readOnly?: Partial<Record<CustomObject, Readonly<Record<string, readonly string[]>>>>;
  /**
   * Active keys created AFTER the screen read its definitions: left out of
   * listCustomFields, yet served on records (contract-legal: a field defined
   * between the two reads). A screen has no label or type for them.
   */
  readonly createdLate?: readonly string[];
  /** Abort every listCustomFields read, as a dropped connection does. */
  readonly definitionsFailure?: boolean;
  /** Refuse writes carrying one key with one code (the error journeys). */
  readonly refuse?: CustomRefusal;
}

export function isListCustomFields(request: Request): boolean {
  return request.method() === 'GET' && new URL(request.url()).pathname === CUSTOM_FIELDS_PATH;
}

export interface CustomWrite {
  readonly object: CustomObject;
  readonly recordId: string;
  readonly kind: 'create' | 'update';
  readonly custom: unknown;
}

export class CustomFieldsServer {
  /** listCustomFields requests, in order. */
  readonly definitionReads: URL[] = [];
  /** Every `custom` a write carried, in order, whatever its answer. */
  readonly writes: CustomWrite[] = [];
  private readonly store = new Map<string, Json>();
  /** `${recordId}:${key}` pairs answered field_not_editable. */
  private readonly refused = new Set<string>();

  constructor(
    private readonly setup: CustomFieldsSetup | undefined,
    private readonly violations: string[],
  ) {
    for (const [recordId, values] of Object.entries(setup?.values ?? {})) {
      this.store.set(recordId, clone(values) as Json);
    }
  }

  /** Whether a journey configured custom fields at all. */
  get configured(): boolean {
    return this.setup !== undefined;
  }

  private definitions(object: CustomObject): readonly CustomFieldDefinition[] {
    if (this.setup === undefined) return [];
    return this.setup.definitions?.[object] ?? ALL_FIELDS[object];
  }

  /** Active definitions: the keys a record may carry. */
  active(object: CustomObject): readonly CustomFieldDefinition[] {
    return this.definitions(object).filter((field) => field.retiredAt === null);
  }

  private keysIn(map: Partial<Record<CustomObject, Readonly<Record<string, readonly string[]>>>> | undefined, object: CustomObject, programmeId: string): readonly string[] {
    return map?.[object]?.[programmeId] ?? [];
  }

  withheldKeys(object: CustomObject, programmeId: string): readonly string[] {
    return this.keysIn(this.setup?.withheld, object, programmeId);
  }

  /** What the stored record holds now, retired and withheld keys included. */
  stored(recordId: string): Json {
    return clone(this.store.get(recordId) ?? {});
  }

  /** The `custom` the caller reads: active keys only, withheld keys removed. */
  visible(object: CustomObject, recordId: string, programmeId: string): Json {
    const active = new Set(this.active(object).map((field) => field.apiName));
    const withheld = new Set(this.withheldKeys(object, programmeId));
    const out: Json = {};
    for (const [key, value] of Object.entries(this.store.get(recordId) ?? {})) {
      if (active.has(key) && !withheld.has(key) && value !== null) out[key] = clone(value);
    }
    return out;
  }

  /**
   * Adds the projected `custom` and the `custom.<key>` paths to a row the
   * mock is about to serve. With no setup the row is left exactly as it was.
   */
  decorate<T extends { withheldFields: string[] }>(row: T, object: CustomObject, recordId: string, programmeId: string): T {
    if (this.setup === undefined) return row;
    const withheld = new Set(this.withheldKeys(object, programmeId));
    const paths = this.active(object)
      .filter((field) => withheld.has(field.apiName))
      .map((field) => `custom.${field.apiName}`);
    (row as T & { custom?: Json }).custom = this.visible(object, recordId, programmeId);
    row.withheldFields = [...row.withheldFields.filter((path) => !path.startsWith('custom.')), ...paths];
    return row;
  }

  // ----- listCustomFields ------------------------------------------------

  /** The answer to a listCustomFields read, checked against the contract. Pure: the self-test calls it. */
  listAnswer(url: URL): Answer {
    this.definitionReads.push(url);
    const params = url.searchParams;
    const problems: string[] = [];
    for (const name of new Set(params.keys())) {
      if (name !== 'object' && name !== 'includeRetired') problems.push(`listCustomFields declares no "${name}" parameter`);
      if (params.getAll(name).length > 1) problems.push(`listCustomFields was sent ${name} more than once`);
    }
    const object = params.get('object');
    if (object === null || !(CUSTOM_OBJECTS as readonly string[]).includes(object)) {
      problems.push(`listCustomFields object=${String(object)} is not one of ${CUSTOM_OBJECTS.join(', ')}`);
    }
    const retired = params.get('includeRetired');
    if (retired !== null && retired !== 'false') {
      problems.push(`listCustomFields includeRetired=${retired}: a record screen never shows a retired field`);
    }
    if (problems.length > 0) {
      this.violations.push(...problems);
      const body = errorExample('admin', 'ValidationFailed');
      body.details = [{ path: 'query', code: 'invalid_string' }];
      return { status: 400, body };
    }
    const late = new Set(this.setup?.createdLate ?? []);
    const items = [...this.active(object as CustomObject)]
      .filter((field) => !late.has(field.apiName))
      .sort((left, right) => (left.apiName < right.apiName ? -1 : left.apiName > right.apiName ? 1 : 0))
      .map((field) => clone(field));
    const body: Json = { objectApiName: object, limits: clone(CUSTOM_FIELD_LIMITS), items };
    const faults = schemaProblems(body, LIST_SCHEMA, 'admin', 'listCustomFields 200');
    if (faults.length > 0) {
      throw new Error(`MOCK FAULT: listCustomFields answered what ${ADMIN_CONTRACT_SOURCE} refuses: ${faults.join('; ')}`);
    }
    return { status: 200, body };
  }

  async answerList(route: Route): Promise<void> {
    const url = new URL(route.request().url());
    if (this.setup?.definitionsFailure === true) {
      this.definitionReads.push(url);
      return route.abort('internetdisconnected');
    }
    const answer = this.listAnswer(url);
    return route.fulfill({
      status: answer.status,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify(answer.body),
    });
  }

  // ----- writes ------------------------------------------------------------

  private checkKeys(
    object: CustomObject,
    recordId: string | undefined,
    programmeId: string,
    custom: Json,
    kind: 'create' | 'update',
    label: string,
  ): Answer | undefined {
    const forbidden: Detail[] = [];
    const invalid: Detail[] = [];
    const active = this.active(object);
    const withheld = new Set(this.withheldKeys(object, programmeId));
    const readOnly = new Set(this.keysIn(this.setup?.readOnly, object, programmeId));
    const visible = recordId === undefined ? {} : this.visible(object, recordId, programmeId);
    for (const [key, value] of Object.entries(custom)) {
      if (!CUSTOM_KEY_PATTERN.test(key)) {
        this.violations.push(`${label}: custom carries a key that is not a custom api name`);
        invalid.push({ path: 'custom', code: 'unknown_field' });
        continue;
      }
      const field = active.find((candidate) => candidate.apiName === key);
      if (field === undefined) {
        this.violations.push(`${label}: custom.${key} is not an active ${object} field (unknown or retired)`);
        invalid.push({ path: `custom.${key}`, code: 'unknown_field' });
        continue;
      }
      if (withheld.has(key)) {
        this.violations.push(`${label}: sent custom.${key}, which is withheld from the caller (it cannot write what it cannot read)`);
        forbidden.push({ path: `custom.${key}`, code: 'field_not_editable' });
        continue;
      }
      const told = recordId !== undefined && this.refused.has(`${recordId}:${key}`);
      if (told) {
        this.violations.push(`${label}: sent custom.${key} again after the API answered field_not_editable for it`);
      }
      const forcedReadOnly = this.setup?.refuse?.code === 'field_not_editable' && this.setup.refuse.key === key;
      if (readOnly.has(key) || told || forcedReadOnly) {
        if (recordId !== undefined) this.refused.add(`${recordId}:${key}`);
        forbidden.push({ path: `custom.${key}`, code: 'field_not_editable' });
        continue;
      }
      if (value === null) {
        if (kind === 'create') {
          this.violations.push(`${label}: custom.${key} is null on a create (a create carries values only)`);
          invalid.push({ path: `custom.${key}`, code: 'invalid_value' });
        } else if (!(key in visible)) {
          this.violations.push(`${label}: custom.${key} is null for a key that has no value — an unchanged key is never sent`);
        }
        continue;
      }
      const problem = valueProblem(field, value);
      if (problem !== undefined) {
        this.violations.push(`${label}: custom.${key} is not a valid ${field.type} value (${problem.code})`);
        invalid.push(problem);
        continue;
      }
      if (kind === 'update' && sameValue(visible[key], value)) {
        this.violations.push(`${label}: custom.${key} sent unchanged — a per-key merge carries only what changed`);
      }
    }
    if (forbidden.length > 0) return fieldNotEditable(forbidden);
    if (invalid.length > 0) return validationFailed(invalid);
    const refusal = this.setup?.refuse;
    if (refusal !== undefined && refusal.code !== 'field_not_editable' && refusal.key in custom) {
      return validationFailed([{ path: refusal.code === 'custom_too_large' ? 'custom' : `custom.${refusal.key}`, code: refusal.code }]);
    }
    const merged: Json = { ...visible };
    for (const [key, value] of Object.entries(custom)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    if (Buffer.byteLength(JSON.stringify(merged), 'utf8') > CUSTOM_FIELD_LIMITS.apiBytes) {
      return validationFailed([{ path: 'custom', code: 'custom_too_large' }]);
    }
    return undefined;
  }

  /**
   * Checks `custom` on an update. `undefined` means the patch may be applied
   * (the caller still checks `version`); otherwise answer with the result.
   */
  checkPatch(object: CustomObject, recordId: string, programmeId: string, patch: unknown, label: string): Answer | undefined {
    this.writes.push({ object, recordId, kind: 'update', custom: clone(patch) });
    if (this.setup === undefined) {
      this.violations.push(`${label}: sent custom, but no custom field is defined in this journey`);
      return validationFailed([{ path: 'custom', code: 'unknown_field' }]);
    }
    const keys = isJson(patch) ? Object.keys(patch) : [];
    if (!isJson(patch) || keys.length === 0 || keys.length > 100) {
      this.violations.push(`${label}: custom is not a patch of 1 to 100 keys`);
      return validationFailed([{ path: 'custom', code: 'invalid_value' }]);
    }
    return this.checkKeys(object, recordId, programmeId, patch, 'update', label);
  }

  /** Applies a checked patch: per key, `null` removes, retired keys dropped (D-L142). */
  applyPatch(object: CustomObject, recordId: string, patch: Json): void {
    const active = new Set(this.active(object).map((field) => field.apiName));
    const next: Json = {};
    for (const [key, value] of Object.entries(this.store.get(recordId) ?? {})) {
      if (active.has(key)) next[key] = value;
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = clone(value);
    }
    this.store.set(recordId, next);
  }

  /** Checks `custom` on a create (values only). `undefined` means it may be stored. */
  checkCreate(object: CustomObject, programmeId: string, custom: unknown, label: string): Answer | undefined {
    if (custom === undefined) return undefined;
    this.writes.push({ object, recordId: '(new)', kind: 'create', custom: clone(custom) });
    if (this.setup === undefined) {
      this.violations.push(`${label}: sent custom, but no custom field is defined in this journey`);
      return validationFailed([{ path: 'custom', code: 'unknown_field' }]);
    }
    if (!isJson(custom) || Object.keys(custom).length > 100) {
      this.violations.push(`${label}: custom on a create is not an object of at most 100 keys`);
      return validationFailed([{ path: 'custom', code: 'invalid_value' }]);
    }
    return this.checkKeys(object, undefined, programmeId, custom, 'create', label);
  }

  storeCreated(recordId: string, custom: unknown): void {
    if (isJson(custom)) this.store.set(recordId, clone(custom));
  }

  // ----- list filters ----------------------------------------------------

  /** The query without the custom-field filters, for the mock's own parameter checks. */
  static withoutFilters(params: URLSearchParams): URLSearchParams {
    const kept = new URLSearchParams();
    for (const [name, value] of params.entries()) {
      if (name !== 'customEmpty' && !name.startsWith('custom[') && name !== 'custom') kept.append(name, value);
    }
    return kept;
  }

  private static equalities(params: URLSearchParams): { name: string; key: string | undefined; value: string }[] {
    return [...params.entries()]
      .filter(([name]) => name === 'custom' || name.startsWith('custom['))
      .map(([name, value]) => ({ name, key: /^custom\[([^\]]*)\]$/.exec(name)?.[1], value }));
  }

  /**
   * Checks the custom-field filters of a list read. `undefined` means serve
   * the page (filter rows with `matches`); otherwise answer with the result.
   */
  checkFilters(object: CustomObject, params: URLSearchParams, programmeIds: readonly string[], label: string): Answer | undefined {
    const equalities = CustomFieldsServer.equalities(params);
    const empties = params.getAll('customEmpty');
    if (equalities.length === 0 && empties.length === 0) return undefined;
    if (this.setup === undefined) {
      this.violations.push(`${label}: sent a custom-field filter, but no custom field is defined in this journey`);
      return validationFailed([{ path: 'custom', code: 'unknown_field' }]);
    }
    const errors: Detail[] = [];
    const keys: string[] = [];
    for (const entry of equalities) {
      if (entry.key === undefined || !CUSTOM_KEY_PATTERN.test(entry.key)) {
        this.violations.push(`${label}: a custom filter parameter that is not custom[<api name>]`);
        errors.push({ path: 'custom', code: 'unknown_field' });
        continue;
      }
      keys.push(entry.key);
    }
    for (const key of empties) {
      if (!CUSTOM_KEY_PATTERN.test(key)) {
        this.violations.push(`${label}: customEmpty names something that is not a custom api name`);
        errors.push({ path: 'customEmpty', code: 'unknown_field' });
        continue;
      }
      keys.push(key);
    }
    if (new Set(keys).size !== keys.length) {
      this.violations.push(`${label}: a custom key filtered more than once (one value per key; "is empty" is not also an equality)`);
    }
    if (equalities.length > 10 || empties.length > 10) {
      this.violations.push(`${label}: more than ten custom-field filters`);
    }
    const active = this.active(object);
    const withheldAnywhere = new Set(programmeIds.flatMap((id) => this.withheldKeys(object, id)));
    const refusedWithheld: Detail[] = [];
    const filtered = [
      ...equalities.filter((entry) => entry.key !== undefined && CUSTOM_KEY_PATTERN.test(entry.key)).map((entry) => ({ key: entry.key ?? '', value: entry.value as string | undefined })),
      ...empties.filter((key) => CUSTOM_KEY_PATTERN.test(key)).map((key) => ({ key, value: undefined })),
    ];
    for (const { key, value } of filtered) {
      const field = active.find((candidate) => candidate.apiName === key);
      if (field === undefined) {
        this.violations.push(`${label}: filtered on custom.${key}, not an active ${object} field (unknown or retired)`);
        errors.push({ path: `custom.${key}`, code: 'unknown_field' });
        continue;
      }
      if (field.type !== 'picklist' && field.type !== 'boolean') {
        this.violations.push(`${label}: filtered on custom.${key}, a ${field.type} field: only picklist and boolean filter (D-L128 Q4)`);
        errors.push({ path: `custom.${key}`, code: 'filter_not_supported' });
        continue;
      }
      if (value !== undefined) {
        const legal =
          field.type === 'boolean' ? ['true', 'false'] : (field.config.values ?? []).map((entry) => entry.value);
        if (!legal.includes(value)) {
          this.violations.push(`${label}: custom[${key}] carries a value the field does not define`);
          errors.push({ path: `custom.${key}`, code: field.type === 'boolean' ? 'invalid_value' : 'unknown_value' });
          continue;
        }
      }
      if (withheldAnywhere.has(key)) refusedWithheld.push({ path: `custom.${key}`, code: 'field_withheld' });
    }
    if (errors.length > 0) return validationFailed(errors);
    if (refusedWithheld.length > 0) return validationFailed(refusedWithheld);
    return undefined;
  }

  /** Whether a record passes the (already checked) custom-field filters. */
  matches(object: CustomObject, recordId: string, programmeId: string, params: URLSearchParams): boolean {
    const values = this.visible(object, recordId, programmeId);
    const equal = CustomFieldsServer.equalities(params).every(
      (entry) => entry.key !== undefined && entry.key in values && String(values[entry.key]) === entry.value,
    );
    return equal && params.getAll('customEmpty').every((key) => !(key in values));
  }
}

/** Everything a setup can serve, for checks that tell served record data (labels, values) from UI copy. */
export function servedCustomData(setup: CustomFieldsSetup | undefined): string {
  return JSON.stringify({ definitions: setup?.definitions ?? ALL_FIELDS, values: setup?.values ?? {} });
}
