import type { Page, Request, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * The custom-field half of `docs/api/admin.openapi.yaml` (T-0088 contract,
 * served since T-0089): `listCustomFields`, `createCustomField`,
 * `updateCustomField` and `retireCustomField`, plus the two reads the admin
 * shell makes on every console screen (`getAdminHomeSummary` for the
 * residency badge, `getSettingsMenuBadges` for the menu), served into the
 * browser by Playwright for T-0090 (the P18 customisation studio).
 *
 * ---------------------------------------------------------------------------
 * READ FROM THE CONTRACT AT RUN TIME, AND EVERY REQUEST AND ANSWER CHECKED
 *
 * The schemas, the enums, the limits, the error bodies and the seed rows come
 * out of the YAML when this module loads:
 *
 *   - `contact` holds the `listCustomFields` example's seven definitions
 *     VERBATIM (six active, `legacy_ref__c` retired). `account` holds the
 *     `createCustomField` `currency` example as a definition. The others are
 *     declared here in the same shape, and every stored definition is
 *     validated, strictly, against `CustomFieldDefinition` at load. A contract
 *     change this file contradicts fails here, loudly, before any journey.
 *   - EVERY body the mock answers with is validated against the schema the
 *     contract declares for that operation and status, strictly: a property
 *     the schema does not name is a fault (a record count, a "used in", a
 *     plan). A fault is the MOCK's, in `mockFaults`; the spec's `afterEach`
 *     requires it to be empty.
 *   - The one deliberate exception is `forced`: an answer queued by a journey
 *     (`createAnswers`, `updateAnswers`, `retireAnswers`) that the contract
 *     declares for the operation, served whatever was sent, so the screen can
 *     be shown drawing every error the operation can answer. A forced answer
 *     is still validated against its declared response; it is "planted" only
 *     in that it need not follow from the request.
 *
 * WHAT IS NOT IN THE CONTRACT, AND IS THEREFORE DECLARED HERE
 *
 *   - Who is calling. `caller: 'admin'` (default) holds `custom_field.write`;
 *     `caller: 'member'` does not, so every write is `403 not_permitted`,
 *     checked BEFORE the 404 and the body (D-L140's order), while the list
 *     still answers (it needs no permission).
 *   - The deal and activity rows, and the account rows beyond the example.
 *     Every label is synthetic. One deal label carries markup, which a screen
 *     must draw as text.
 *   - `atFieldLimit`: the object already holds 100 active fields (the
 *     contract's `fieldsPerObject`), so a create is `409 limit_reached` /
 *     `field_limit_reached`. `picklistFull`: deal's `stage_band__c` already
 *     holds 500 values (`picklistValues`), so `addValues` is `409` /
 *     `picklist_limit_reached`.
 *
 * WHAT THE MOCK ENFORCES ON EVERY REQUEST (`violations`, the SCREEN's fault)
 *
 *   - Only the six operations above; anything else under `/api/v1/` is a
 *     violation (a record count, a usage read, a delete, a type change, a
 *     field-security write). No header names a programme, tenant or scope.
 *   - listCustomFields: only `object` (one of the four) and `includeRetired`
 *     (`true` or `false`).
 *   - createCustomField: `application/json`, the closed body, and nothing the
 *     studio can know is refused before it sends it: an api name that fails
 *     `^[a-z][a-z0-9_]*__c$` or the 4..63 bound, a type outside the six, a
 *     picklist without 1..500 unique, well-formed values, a currency outside
 *     NGN/GHS/KES/ZAR, or a `config` on any other type (`config: {}`
 *     included). Each is still answered as the contract says.
 *   - updateCustomField: the closed body, at least one property, and ONLY
 *     what the admin changed: a `label`, `description` or `classification`
 *     equal to the stored one, or a `relabelValues` entry whose label is
 *     unchanged, is a violation (the audit names what changed, by key). A
 *     picklist edit on a field that is not a picklist, a relabel of a value
 *     the field does not have, and any update to a retired field (the studio
 *     shows those read-only) are violations too.
 *   - retireCustomField: no body; never a field that is already retired.
 *   - An id the mock never served (404) is a violation on every write.
 *
 * SERVER BEHAVIOUR THE SCREEN DEPENDS ON, IMPLEMENTED AS THE CONTRACT SAYS
 *
 *   - The list is ordered by `apiName`; retired fields only with
 *     `includeRetired=true`; the limits are the contract's constants.
 *   - A taken api name, live or retired, is `409 duplicate_code` at `apiName`.
 *   - Retired fields do not count toward the 100; they do toward the 500.
 *   - `classification` defaults to `none`; `config` is `{}` for every type
 *     but picklist and currency.
 *   - A repeat retire answers `200` with the first `retiredAt`.
 * ---------------------------------------------------------------------------
 */

export const ADMIN_CONTRACT_SOURCE = 'docs/api/admin.openapi.yaml';

const repoRoot = resolve(__dirname, '..', '..', '..');

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const CONTRACT: unknown = parse(readFileSync(resolve(repoRoot, ADMIN_CONTRACT_SOURCE), 'utf8'));

function at(node: unknown, ...path: string[]): unknown {
  let current: unknown = node;
  for (const segment of path) {
    if (!isJson(current) && !Array.isArray(current)) {
      throw new Error(`contract: nothing at ${path.join('.')}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) {
    throw new Error(`contract: nothing at ${path.join('.')}`);
  }
  return current;
}

/** Follows a local `$ref`. The admin contract has no remote refs. */
function deref(node: unknown): unknown {
  if (!isJson(node) || typeof node.$ref !== 'string') return node;
  if (!node.$ref.startsWith('#/')) throw new Error(`contract: remote $ref ${node.$ref}`);
  return deref(at(CONTRACT, ...node.$ref.slice(2).split('/')));
}

function schema(name: string): Json {
  return at(CONTRACT, 'components', 'schemas', name) as Json;
}

export const LIST_PATH = '/api/v1/admin/custom-fields';
const FIELD_PATH = /^\/api\/v1\/admin\/custom-fields\/([^/]+)$/;
const RETIRE_PATH = /^\/api\/v1\/admin\/custom-fields\/([^/]+)\/retire$/;
const HOME_SUMMARY_PATH = '/api/v1/admin/home/summary';
const BADGES_PATH = '/api/v1/admin/settings-menu/badges';

const OP = {
  listCustomFields: [LIST_PATH, 'get'],
  createCustomField: [LIST_PATH, 'post'],
  updateCustomField: ['/api/v1/admin/custom-fields/{fieldId}', 'patch'],
  retireCustomField: ['/api/v1/admin/custom-fields/{fieldId}/retire', 'post'],
  getAdminHomeSummary: [HOME_SUMMARY_PATH, 'get'],
  getSettingsMenuBadges: [BADGES_PATH, 'get'],
} as const;

export type Operation = keyof typeof OP;

for (const [name, [path, method]] of Object.entries(OP)) {
  const operationId = (at(CONTRACT, 'paths', path, method) as Json).operationId;
  if (operationId !== name) throw new Error(`contract: ${method.toUpperCase()} ${path} is ${String(operationId)}, not ${name}`);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

// ---------------------------------------------------------------------------
// Validation: the JSON-Schema subset these bodies and answers use
// ---------------------------------------------------------------------------

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/**
 * Problems with `value` against `raw`. `strict` treats every object schema
 * that declares properties as closed: used on the mock's OWN answers, never on
 * what the screen sends (request bodies are judged by the contract's own
 * `additionalProperties`).
 */
export function validateBody(value: unknown, raw: unknown, path = '', strict = false): string[] {
  const spec = deref(raw) as Json;
  const where = path || 'body';
  if (Array.isArray(spec.oneOf)) {
    const passing = spec.oneOf.filter((option) => validateBody(value, option, path, strict).length === 0);
    if (passing.length !== 1) return [`${where} matches ${passing.length} of oneOf, not exactly 1`];
  }
  const problems: string[] = [];
  if (Array.isArray(spec.allOf)) {
    for (const part of spec.allOf) problems.push(...validateBody(value, part, path, false));
  }
  if (spec.type !== undefined) {
    const allowed = (Array.isArray(spec.type) ? spec.type : [spec.type]).map(String);
    const actual = typeOf(value);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      return [...problems, `${where} is ${actual}, not ${allowed.join('|')}`];
    }
  }
  if ('const' in spec && spec.const !== value) problems.push(`${where} is not ${String(spec.const)}`);
  if (Array.isArray(spec.enum) && !spec.enum.includes(value)) problems.push(`${where} is not one of ${spec.enum.join(', ')}`);
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof spec.minLength === 'number' && length < spec.minLength) problems.push(`${where} is too short`);
    if (typeof spec.maxLength === 'number' && length > spec.maxLength) problems.push(`${where} is too long`);
    if (typeof spec.pattern === 'string' && !new RegExp(spec.pattern, 'u').test(value)) problems.push(`${where} does not match ${spec.pattern}`);
    if (spec.format === 'uuid' && !UUID_PATTERN.test(value)) problems.push(`${where} is not a uuid`);
    if (spec.format === 'date-time' && !UTC_DATE_TIME.test(value)) problems.push(`${where} is not a UTC date-time with a Z`);
  }
  if (typeof value === 'number') {
    if (typeof spec.minimum === 'number' && value < spec.minimum) problems.push(`${where} is below ${spec.minimum}`);
    if (typeof spec.maximum === 'number' && value > spec.maximum) problems.push(`${where} is above ${spec.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof spec.maxItems === 'number' && value.length > spec.maxItems) problems.push(`${where} has too many items`);
    if (typeof spec.minItems === 'number' && value.length < spec.minItems) problems.push(`${where} has too few items`);
    if (spec.items !== undefined) {
      value.forEach((item, index) => problems.push(...validateBody(item, spec.items, `${path}.${index}`, strict)));
    }
  }
  if (isJson(value)) {
    const count = Object.keys(value).length;
    if (typeof spec.minProperties === 'number' && count < spec.minProperties) problems.push(`${where} has too few properties`);
    if (typeof spec.maxProperties === 'number' && count > spec.maxProperties) problems.push(`${where} has too many properties`);
    if (spec.properties !== undefined || spec.required !== undefined || spec.additionalProperties === false) {
      const properties = (spec.properties ?? {}) as Json;
      for (const key of (spec.required ?? []) as string[]) {
        if (!(key in value)) problems.push(`${path ? `${path}.` : ''}${key} is required`);
      }
      for (const [key, item] of Object.entries(value)) {
        const child = `${path ? `${path}.` : ''}${key}`;
        if (!(key in properties)) {
          if (spec.additionalProperties === false) problems.push(`${child} is not a property of this closed body`);
          else if (strict && spec.properties !== undefined) problems.push(`${child} is not a property the contract declares`);
          continue;
        }
        problems.push(...validateBody(item, properties[key], child, strict));
      }
    }
  }
  return problems;
}

function declaredResponse(operation: Operation, status: number): unknown {
  const [path, method] = OP[operation];
  const responses = at(CONTRACT, 'paths', path, method, 'responses') as Json;
  const declared = responses[String(status)];
  return declared === undefined ? undefined : deref(declared);
}

/** What is wrong with answering `operation` with `status` and `body`, judged strictly. */
export function answerProblems(operation: Operation, status: number, body: unknown): string[] {
  const response = declaredResponse(operation, status);
  if (response === undefined) return [`${operation} declares no ${status} response`];
  return validateBody(body, at(response, 'content', 'application/json', 'schema'), `${operation} ${status}`, true);
}

/** Every error example an operation declares, by status, as `[status, name, body]`. */
export function errorExamples(operation: Operation): [status: number, name: string, body: Json][] {
  const [path, method] = OP[operation];
  const out: [number, string, Json][] = [];
  for (const [status, raw] of Object.entries(at(CONTRACT, 'paths', path, method, 'responses') as Json)) {
    if (status.startsWith('2')) continue;
    const json = at(deref(raw), 'content', 'application/json') as Json;
    if (isJson(json.example)) out.push([Number(status), 'default', clone(json.example)]);
    for (const [name, entry] of Object.entries((json.examples ?? {}) as Json)) {
      const value = at(entry, 'value');
      if (isJson(value)) out.push([Number(status), name, clone(value)]);
    }
  }
  return out;
}

/** The `code`s an operation can answer with, and the `details[].code`s, from its examples. */
export function errorCodes(operation: Operation): { codes: string[]; details: string[] } {
  const codes = new Set<string>();
  const details = new Set<string>();
  for (const [, , body] of errorExamples(operation)) {
    if (typeof body.code === 'string') codes.add(body.code);
    for (const detail of (Array.isArray(body.details) ? body.details : []) as Json[]) {
      if (typeof detail.code === 'string') details.add(detail.code);
    }
  }
  return { codes: [...codes].sort(), details: [...details].sort() };
}

function responseExample(response: string, name?: string): Json {
  const json = at(deref(at(CONTRACT, 'components', 'responses', response)), 'content', 'application/json') as Json;
  return clone(name === undefined ? json.example : at(json.examples, name, 'value')) as Json;
}

/** A `400 validation_failed` with one detail, from the contract's custom-field envelope. */
function refusal(path: string, code: string): Json {
  const body = responseExample('CustomFieldValidationFailed', 'invalidApiName');
  body.details = [{ path, code }];
  return body;
}

function conflict(name: 'duplicate' | 'fieldLimit' | 'picklistLimit'): Json {
  return responseExample('CustomFieldConflict', name);
}

// ---------------------------------------------------------------------------
// The contract's own vocabularies
// ---------------------------------------------------------------------------

export type CustomFieldObject = 'contact' | 'account' | 'activity' | 'deal';
export type Classification = 'none' | 'pii' | 'sensitive';

export const OBJECTS = (at(schema('CustomFieldObject'), 'enum') as unknown[]).map(String) as CustomFieldObject[];
/** The six Phase 2 types, in the contract's order. */
export const TYPES: readonly string[] = (at(schema('CustomFieldType'), 'enum') as unknown[]).map(String);
/** The types the contract names as refused until each has its own decision (CustomFieldType's description). */
export const REFUSED_TYPES: readonly string[] = ['textarea', 'datetime', 'multipicklist', 'lookup', 'formula', 'rollup', 'phone', 'email', 'url'];
export const CLASSIFICATIONS = (at(schema('CreateCustomFieldRequest'), 'properties', 'classification', 'enum') as unknown[]).map(String) as Classification[];
export const API_NAME_PATTERN = new RegExp(String(at(schema('CustomFieldApiName'), 'pattern')), 'u');
export const API_NAME_MAX = Number(at(schema('CustomFieldApiName'), 'maxLength'));
export const LABEL_MAX = Number(at(schema('CreateCustomFieldRequest'), 'properties', 'label', 'maxLength'));
const VALUE_PATTERN = new RegExp(String(at(schema('CustomFieldPicklistValue'), 'properties', 'value', 'pattern')), 'u');

/** NGN, GHS, KES and ZAR: the contract's prose (the schema is deliberately not an enum). */
export const CURRENCIES: readonly string[] = ['NGN', 'GHS', 'KES', 'ZAR'];
const currencyProse = String(at(schema('CustomFieldCurrencyConfig'), 'description'));
for (const code of CURRENCIES) {
  if (!currencyProse.includes(code)) throw new Error(`contract: CustomFieldCurrencyConfig no longer names ${code}`);
}
for (const type of REFUSED_TYPES) {
  if (!String(at(schema('CustomFieldType'), 'description')).includes(`\`${type}\``)) {
    throw new Error(`contract: CustomFieldType no longer names ${type} as refused`);
  }
}

const LIST_EXAMPLE = at(CONTRACT, 'paths', LIST_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example') as Json;
/** The limits, as the contract publishes them (constants). */
export const LIMITS = clone(LIST_EXAMPLE.limits) as {
  apiBytes: number;
  bytesPerRecord: number;
  definitionsPerObject: number;
  fieldsPerObject: number;
  picklistValues: number;
};

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface Definition {
  id: string;
  objectApiName: CustomFieldObject;
  apiName: string;
  label: string;
  description: string | null;
  type: string;
  classification: Classification;
  config: Json;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const NOW = '2026-10-18T09:00:00.000Z';
const CREATED = '2026-10-14T09:00:00.000Z';

const DEFINITION_SCHEMA = schema('CustomFieldDefinition');

function idFor(object: CustomFieldObject, index: number): string {
  const block = { contact: 'c', account: 'a', activity: 'e', deal: 'd' }[object];
  return `11111111-0000-4000-8000-0000000${block}${String(index).padStart(4, '0')}`;
}

function definition(object: CustomFieldObject, index: number, fields: Partial<Definition> & Pick<Definition, 'apiName' | 'label' | 'type'>): Definition {
  return {
    id: idFor(object, index),
    objectApiName: object,
    description: null,
    classification: 'none',
    config: {},
    retiredAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...fields,
  };
}

/** The contract's own list example, verbatim: six active contact fields and one retired. */
export const CONTACT_FIELDS: readonly Definition[] = clone(LIST_EXAMPLE.items) as Definition[];

const CURRENCY_EXAMPLE = at(CONTRACT, 'paths', LIST_PATH, 'post', 'requestBody', 'content', 'application/json', 'examples', 'currency', 'value') as Json;

export const ACCOUNT_FIELDS: readonly Definition[] = [
  definition('account', 1, {
    apiName: String(CURRENCY_EXAMPLE.apiName),
    label: String(CURRENCY_EXAMPLE.label),
    type: String(CURRENCY_EXAMPLE.type),
    classification: CURRENCY_EXAMPLE.classification as Classification,
    config: clone(CURRENCY_EXAMPLE.config) as Json,
  }),
  definition('account', 2, { apiName: 'region_code__c', label: 'Sample region code', type: 'text', classification: 'pii', description: 'A synthetic fixture field.' }),
];

/** Markup in a label: drawn as text, never parsed. */
export const HOSTILE_LABEL = 'Samplemark<img src=x onerror="window.__kasuwaXss=1"> <b>Fixture</b>';

export const DEAL_PICKLIST_API_NAME = 'stage_band__c';
export const DEAL_FIELDS: readonly Definition[] = [
  definition('deal', 1, {
    apiName: DEAL_PICKLIST_API_NAME,
    label: 'Sample stage band',
    type: 'picklist',
    config: { values: [{ value: 'early', label: 'Early' }, { value: 'late', label: 'Late' }] },
  }),
  definition('deal', 2, { apiName: 'renewal_flag__c', label: 'Sample renewal flag', type: 'boolean' }),
  definition('deal', 3, { apiName: 'markup_note__c', label: HOSTILE_LABEL, type: 'text' }),
];

for (const row of [...CONTACT_FIELDS, ...ACCOUNT_FIELDS, ...DEAL_FIELDS]) {
  const problems = validateBody(row, DEFINITION_SCHEMA, `definition ${row.apiName}`, true);
  if (problems.length > 0) throw new Error(`a stored definition disagrees with ${ADMIN_CONTRACT_SOURCE}: ${problems.join('; ')}`);
}

/** The contact field the list example shows retired. */
export const RETIRED_CONTACT = CONTACT_FIELDS.find((row) => row.retiredAt !== null) as Definition;
if (RETIRED_CONTACT === undefined) throw new Error('contract: the listCustomFields example no longer shows a retired field');

function byApiName(a: Definition, b: Definition): number {
  return a.apiName < b.apiName ? -1 : a.apiName > b.apiName ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/** A queued answer: a declared status and the name of one of its contract examples, or a dropped connection. */
export type Forced = { readonly status: number; readonly example: string } | 'network';

export interface CustomFieldsMockOptions {
  /** Default `admin` (holds `custom_field.write`). A `member` is refused every write with `403`. */
  readonly caller?: 'admin' | 'member';
  /** This object already holds `fieldsPerObject` active fields. */
  readonly atFieldLimit?: CustomFieldObject;
  /** Deal's picklist already holds `picklistValues` values. */
  readonly picklistFull?: boolean;
  /** The next creates, updates or retires are answered with these, whatever was sent. */
  readonly createAnswers?: readonly Forced[];
  readonly updateAnswers?: readonly Forced[];
  readonly retireAnswers?: readonly Forced[];
  /** Hold every write until `release()`: the saving state and double submits, without a clock. */
  readonly holdWrites?: boolean;
  /** Abort every listCustomFields read, as a dropped connection does. */
  readonly listFailure?: boolean;
}

export interface WriteCall {
  readonly operation: 'createCustomField' | 'updateCustomField' | 'retireCustomField';
  readonly url: URL;
  readonly contentType: string;
  readonly raw: string;
  readonly body: unknown;
  readonly fieldId?: string;
  readonly status: number;
}

export interface CustomFieldsMock {
  /** Every /api/v1 request the mock saw, in order. */
  readonly requests: URL[];
  /** listCustomFields requests, in order. */
  readonly listReads: URL[];
  /** Every write, in order, with the status it was answered. */
  readonly writes: WriteCall[];
  /** Contract breaches by the SCREEN. Must be empty at the end of every test. */
  readonly violations: string[];
  /** Answers the MOCK built that its contract rejects. Must be empty, always. */
  readonly mockFaults: string[];
  /** The store, live: per object, every definition, retired included. */
  readonly store: Readonly<Record<CustomFieldObject, Definition[]>>;
  release(): void;
}

export function isListRead(request: Request, object?: CustomFieldObject): boolean {
  const url = new URL(request.url());
  return request.method() === 'GET' && url.pathname === LIST_PATH && (object === undefined || url.searchParams.get('object') === object);
}

export function isWrite(request: Request): boolean {
  const url = new URL(request.url());
  return url.pathname.startsWith(LIST_PATH) && request.method() !== 'GET';
}

const CREATE_SCHEMA = schema('CreateCustomFieldRequest');
const UPDATE_SCHEMA = schema('UpdateCustomFieldRequest');
const HOME_SUMMARY = clone(at(CONTRACT, 'paths', HOME_SUMMARY_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example'));
const BADGES = clone(at(CONTRACT, 'paths', BADGES_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example'));

for (const [operation, body] of [
  ['getAdminHomeSummary', HOME_SUMMARY],
  ['getSettingsMenuBadges', BADGES],
  ['listCustomFields', LIST_EXAMPLE],
] as const) {
  const problems = answerProblems(operation, 200, body);
  if (problems.length > 0) throw new Error(`the ${operation} example disagrees with its own schema: ${problems.join('; ')}`);
}

function forcedBody(operation: Operation, forced: { status: number; example: string }): Json {
  const found = errorExamples(operation).find(([status, name]) => status === forced.status && name === forced.example);
  if (found === undefined) throw new Error(`${operation} declares no ${forced.status} example named ${forced.example}`);
  return found[2];
}

export async function installCustomFieldsMock(page: Page, options: CustomFieldsMockOptions = {}): Promise<CustomFieldsMock> {
  const caller = options.caller ?? 'admin';
  const requests: URL[] = [];
  const listReads: URL[] = [];
  const writes: WriteCall[] = [];
  const violations: string[] = [];
  const mockFaults: string[] = [];
  const createQueue = [...(options.createAnswers ?? [])];
  const updateQueue = [...(options.updateAnswers ?? [])];
  const retireQueue = [...(options.retireAnswers ?? [])];

  const store: Record<CustomFieldObject, Definition[]> = {
    contact: clone([...CONTACT_FIELDS]),
    account: clone([...ACCOUNT_FIELDS]),
    activity: [],
    deal: clone([...DEAL_FIELDS]),
  };
  if (options.atFieldLimit !== undefined) {
    const object = options.atFieldLimit;
    const active = store[object].filter((row) => row.retiredAt === null).length;
    for (let index = 0; index < LIMITS.fieldsPerObject - active; index += 1) {
      store[object].push(definition(object, 5000 + index, { apiName: `sample_filler_${String(index).padStart(3, '0')}__c`, label: `Sample filler ${index + 1}`, type: 'text' }));
    }
  }
  if (options.picklistFull === true) {
    const picklist = store.deal.find((row) => row.apiName === DEAL_PICKLIST_API_NAME) as Definition;
    const values = picklist.config.values as Json[];
    for (let index = values.length; index < LIMITS.picklistValues; index += 1) {
      values.push({ value: `band_${String(index).padStart(3, '0')}`, label: `Sample band ${index + 1}` });
    }
  }
  let sequence = 0;

  let release: () => void = () => undefined;
  const gate = options.holdWrites === true ? new Promise<void>((done) => (release = done)) : Promise.resolve();

  const find = (id: string): Definition | undefined => OBJECTS.flatMap((object) => store[object]).find((row) => row.id === id);

  const answer = async (route: Route, operation: Operation, status: number, body: unknown): Promise<void> => {
    mockFaults.push(...answerProblems(operation, status, body));
    try {
      await route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) });
    } catch {
      // The page abandoned the request before it was answered.
    }
  };

  const drop = async (route: Route): Promise<void> => {
    try {
      await route.abort('internetdisconnected');
    } catch {
      // Already abandoned.
    }
  };

  /** Serves a queued answer, if one is queued. True when it did. */
  const servedForced = async (route: Route, operation: Operation, queue: Forced[], record: (status: number) => void): Promise<boolean> => {
    const next = queue.shift();
    if (next === undefined) return false;
    if (next === 'network') {
      record(0);
      await drop(route);
      return true;
    }
    record(next.status);
    await answer(route, operation, next.status, forcedBody(operation, next));
    return true;
  };

  const readBody = (request: Request): { raw: string; body: unknown; contentType: string } => {
    const raw = request.postData() ?? '';
    let body: unknown;
    try {
      body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
    } catch {
      body = Symbol.for('unparseable');
    }
    return { raw, body, contentType: request.headers()['content-type'] ?? '' };
  };

  // ----- listCustomFields -----------------------------------------------------

  const list = async (route: Route, url: URL): Promise<void> => {
    listReads.push(url);
    if (options.listFailure === true) return drop(route);
    for (const name of new Set(url.searchParams.keys())) {
      if (name !== 'object' && name !== 'includeRetired') violations.push(`listCustomFields: the contract declares no "${name}" parameter`);
      if (url.searchParams.getAll(name).length > 1) violations.push(`listCustomFields: ${name} was sent more than once`);
    }
    const object = url.searchParams.get('object');
    const includeRetired = url.searchParams.get('includeRetired');
    if (object === null || !(OBJECTS as readonly string[]).includes(object)) {
      violations.push(`listCustomFields: object=${String(object)} is not one of ${OBJECTS.join(', ')}`);
      const body = responseExample('ValidationFailed');
      body.details = [{ path: 'object', code: 'invalid_enum_value' }];
      return answer(route, 'listCustomFields', 400, body);
    }
    if (includeRetired !== null && includeRetired !== 'true' && includeRetired !== 'false') {
      violations.push(`listCustomFields: includeRetired=${includeRetired} is not a boolean`);
    }
    const items = store[object as CustomFieldObject]
      .filter((row) => includeRetired === 'true' || row.retiredAt === null)
      .sort(byApiName)
      .map((row) => clone(row));
    return answer(route, 'listCustomFields', 200, { objectApiName: object, limits: clone(LIMITS), items });
  };

  // ----- createCustomField ----------------------------------------------------

  const create = async (route: Route, request: Request, url: URL): Promise<void> => {
    const { raw, body, contentType } = readBody(request);
    let status = 0;
    const record = (answered: number) => {
      status = answered;
      writes.push({ operation: 'createCustomField', url, contentType, raw, body, status });
    };
    await gate;
    if (caller === 'member') {
      record(403);
      return answer(route, 'createCustomField', 403, responseExample('NotPermitted'));
    }
    if (await servedForced(route, 'createCustomField', createQueue, record)) return;
    const refuse = (path: string, code: string, why: string): Promise<void> => {
      violations.push(`createCustomField: ${why}`);
      record(400);
      return answer(route, 'createCustomField', 400, refusal(path, code));
    };
    if (!/^application\/json\b/i.test(contentType)) violations.push(`createCustomField was sent "${contentType}", not application/json`);
    if (url.search !== '') violations.push('createCustomField was sent a query string: it takes none');
    if (!isJson(body)) return refuse('body', 'invalid_type', 'the body is not a JSON object');
    // The rules the studio could have applied before sending are reported below, each with its own detail code.
    const shape = validateBody(body, CREATE_SCHEMA).filter((problem) => !/^apiName (does not match|is too)|^type is not one of|^config matches/.test(problem));
    if (shape.length > 0) return refuse('body', 'invalid_body', `the body breaks CreateCustomFieldRequest: ${shape.join('; ')}`);
    const apiName = String(body.apiName);
    const type = String(body.type);
    const object = body.objectApiName as CustomFieldObject;
    if (!API_NAME_PATTERN.test(apiName) || [...apiName].length > API_NAME_MAX || [...apiName].length < 4) {
      return refuse('apiName', 'invalid_api_name', `an api name the studio could have refused was sent (${[...apiName].length} characters)`);
    }
    if (!TYPES.includes(type)) return refuse('type', 'unsupported_type', `a type outside the Phase 2 six was offered and sent ("${type}")`);
    const config = body.config;
    if (type === 'picklist') {
      const values = isJson(config) && Array.isArray(config.values) ? (config.values as unknown[]) : undefined;
      if (values === undefined || values.length < 1 || values.length > LIMITS.picklistValues) {
        return refuse('config.values', 'invalid_config', `a picklist was sent with ${values?.length ?? 'no'} values (1..${LIMITS.picklistValues})`);
      }
      if (Object.keys(config as Json).length !== 1) return refuse('config', 'invalid_config', 'a picklist config carries more than values');
      const malformed = values.filter((entry) => !isJson(entry) || validateBody(entry, schema('CustomFieldPicklistValue')).length > 0);
      if (malformed.length > 0) return refuse('config.values', 'invalid_config', `${malformed.length} picklist value(s) break CustomFieldPicklistValue`);
      const stored = (values as Json[]).map((entry) => String(entry.value));
      if (new Set(stored).size !== stored.length) return refuse('config.values', 'duplicate_value', 'a picklist was sent with a repeated value');
    } else if (type === 'currency') {
      const code = isJson(config) ? config.currencyCode : undefined;
      if (!isJson(config) || Object.keys(config).length !== 1 || typeof code !== 'string') {
        return refuse('config', 'invalid_config', 'a currency field was sent without exactly config.currencyCode');
      }
      if (!CURRENCIES.includes(code)) return refuse('config.currencyCode', 'unknown_currency', `a currency outside ${CURRENCIES.join('/')} was offered and sent`);
    } else if (config !== undefined) {
      return refuse('config', 'invalid_config', `a ${type} field was sent a config (${JSON.stringify(config).length} characters): only picklist and currency take one`);
    }
    const rows = store[object];
    if (rows.some((row) => row.apiName === apiName)) {
      record(409);
      return answer(route, 'createCustomField', 409, conflict('duplicate'));
    }
    if (rows.filter((row) => row.retiredAt === null).length >= LIMITS.fieldsPerObject || rows.length >= LIMITS.definitionsPerObject) {
      record(409);
      return answer(route, 'createCustomField', 409, conflict('fieldLimit'));
    }
    sequence += 1;
    const created: Definition = {
      id: idFor(object, 9000 + sequence),
      objectApiName: object,
      apiName,
      label: String(body.label),
      description: typeof body.description === 'string' ? body.description : null,
      type,
      classification: (body.classification as Classification | undefined) ?? 'none',
      config: type === 'picklist' || type === 'currency' ? clone(config as Json) : {},
      retiredAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    rows.push(created);
    record(201);
    return answer(route, 'createCustomField', 201, clone(created));
  };

  // ----- updateCustomField ----------------------------------------------------

  const update = async (route: Route, request: Request, url: URL, fieldId: string): Promise<void> => {
    const { raw, body, contentType } = readBody(request);
    const record = (answered: number) => writes.push({ operation: 'updateCustomField', url, contentType, raw, body, fieldId, status: answered });
    await gate;
    if (caller === 'member') {
      record(403);
      return answer(route, 'updateCustomField', 403, responseExample('NotPermitted'));
    }
    const row = find(decodeURIComponent(fieldId));
    if (row === undefined) {
      violations.push('updateCustomField: an id the studio was never served');
      record(404);
      return answer(route, 'updateCustomField', 404, responseExample('NotFound'));
    }
    if (await servedForced(route, 'updateCustomField', updateQueue, record)) return;
    const refuse = (path: string, code: string, why: string): Promise<void> => {
      violations.push(`updateCustomField ${row.apiName}: ${why}`);
      record(400);
      return answer(route, 'updateCustomField', 400, refusal(path, code));
    };
    if (!/^application\/json\b/i.test(contentType)) violations.push(`updateCustomField was sent "${contentType}", not application/json`);
    if (row.retiredAt !== null) return refuse('fieldId', 'field_retired', 'a retired field was edited: the studio shows retired fields read-only');
    if (!isJson(body)) return refuse('body', 'invalid_type', 'the body is not a JSON object');
    const shape = validateBody(body, UPDATE_SCHEMA);
    if (shape.length > 0) return refuse('body', 'invalid_body', `the body breaks UpdateCustomFieldRequest: ${shape.join('; ')}`);
    for (const key of ['label', 'description', 'classification'] as const) {
      if (key in body && body[key] === row[key]) violations.push(`updateCustomField ${row.apiName}: ${key} was sent unchanged (send only what changed; the audit names it)`);
    }
    const values = (isJson(row.config) && Array.isArray(row.config.values) ? row.config.values : []) as Json[];
    const addValues = (body.addValues ?? []) as Json[];
    const relabelValues = (body.relabelValues ?? []) as Json[];
    if ((addValues.length > 0 || relabelValues.length > 0) && row.type !== 'picklist') {
      return refuse('addValues', 'not_a_picklist', 'picklist values were sent for a field that is not a picklist');
    }
    for (const entry of relabelValues) {
      const current = values.find((value) => value.value === entry.value);
      if (current === undefined) return refuse('relabelValues', 'unknown_value', 'a relabel named a value the field does not have');
      if (current.label === entry.label) violations.push(`updateCustomField ${row.apiName}: relabelValues carries a value whose label did not change`);
    }
    const added = addValues.map((entry) => String(entry.value));
    if (new Set(added).size !== added.length || added.some((value) => values.some((existing) => existing.value === value))) {
      record(400);
      return answer(route, 'updateCustomField', 400, refusal('addValues', 'duplicate_value'));
    }
    if (values.length + addValues.length > LIMITS.picklistValues) {
      record(409);
      return answer(route, 'updateCustomField', 409, conflict('picklistLimit'));
    }
    if (typeof body.label === 'string') row.label = body.label;
    if ('description' in body) row.description = (body.description as string | null) ?? null;
    if (typeof body.classification === 'string') row.classification = body.classification as Classification;
    for (const entry of relabelValues) {
      const current = values.find((value) => value.value === entry.value);
      if (current !== undefined) current.label = entry.label;
    }
    values.push(...addValues.map((entry) => clone(entry)));
    row.updatedAt = NOW;
    record(200);
    return answer(route, 'updateCustomField', 200, clone(row));
  };

  // ----- retireCustomField ----------------------------------------------------

  const retire = async (route: Route, request: Request, url: URL, fieldId: string): Promise<void> => {
    const { raw, body, contentType } = readBody(request);
    const record = (answered: number) => writes.push({ operation: 'retireCustomField', url, contentType, raw, body, fieldId, status: answered });
    await gate;
    if (caller === 'member') {
      record(403);
      return answer(route, 'retireCustomField', 403, responseExample('NotPermitted'));
    }
    const row = find(decodeURIComponent(fieldId));
    if (row === undefined) {
      violations.push('retireCustomField: an id the studio was never served');
      record(404);
      return answer(route, 'retireCustomField', 404, responseExample('NotFound'));
    }
    if (await servedForced(route, 'retireCustomField', retireQueue, record)) return;
    if (raw !== '' && raw !== '{}') violations.push(`retireCustomField was sent a body (${raw.length} characters): it takes none`);
    if (row.retiredAt !== null) {
      violations.push(`retireCustomField ${row.apiName}: an already retired field was offered for retiring`);
    } else {
      row.retiredAt = NOW;
      row.updatedAt = NOW;
    }
    record(200);
    return answer(route, 'retireCustomField', 200, clone(row));
  };

  // ----- routing ------------------------------------------------------------------

  await page.route(
    (url) => url.pathname.startsWith('/api/v1/'),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      requests.push(url);
      for (const header of Object.keys(request.headers())) {
        if (/programme|tenant|scope/i.test(header)) violations.push(`${method} ${url.pathname} was sent a "${header}" header: scope is never supplied`);
      }
      const retiring = RETIRE_PATH.exec(url.pathname);
      const field = FIELD_PATH.exec(url.pathname);
      if (url.pathname === LIST_PATH && method === 'GET') return list(route, url);
      if (url.pathname === LIST_PATH && method === 'POST') return create(route, request, url);
      if (retiring !== null && method === 'POST') return retire(route, request, url, retiring[1] ?? '');
      if (field !== null && method === 'PATCH') return update(route, request, url, field[1] ?? '');
      if (url.pathname === HOME_SUMMARY_PATH && method === 'GET') return answer(route, 'getAdminHomeSummary', 200, clone(HOME_SUMMARY));
      if (url.pathname === BADGES_PATH && method === 'GET') return answer(route, 'getSettingsMenuBadges', 200, clone(BADGES));
      violations.push(`${method} ${url.pathname.replace(/[^/]{40,}/g, '<long>')} is not an operation the studio uses`);
      try {
        await route.fulfill({ status: 404, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(responseExample('NotFound')) });
      } catch {
        // Abandoned.
      }
    },
  );

  return { requests, listReads, writes, violations, mockFaults, store, release: () => release() };
}

/** Every label, description, api name and picklist label the mock can serve: record-like data, not UI copy (en-XA). */
export function servedData(): string {
  return JSON.stringify([...CONTACT_FIELDS, ...ACCOUNT_FIELDS, ...DEAL_FIELDS]);
}

/** True when `value` is a well-formed picklist `value` (what a record stores). */
export function wellFormedValue(value: string): boolean {
  return VALUE_PATTERN.test(value);
}
