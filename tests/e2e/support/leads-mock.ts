import type { Page, Request, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { TENANT_A } from '@kasuwa/db';
import { CUSTOM_FIELDS_PATH, CustomFieldsServer, type CustomFieldsSetup } from './custom-fields-mock';

/**
 * The leads half of `docs/api/records.openapi.yaml` — `listLeads`,
 * `convertContact`, and the two contact operations a lead row uses
 * (`getContact`, `updateContact`) — plus the account picker's `listAccounts`,
 * `listMyProgrammes` and `getCurrentUser` (`docs/api/auth.openapi.yaml`),
 * served into the browser by Playwright for T-0058 (the P04 Leads screen).
 *
 * ---------------------------------------------------------------------------
 * READ FROM THE CONTRACT AT RUN TIME, LIKE records-mock.ts AND accounts-mock.ts
 *
 * Parameter names, enums and bounds, the Contact and Account property lists,
 * the request-body schemas and every error body come out of the YAML when
 * this module loads. Every row declared below is checked against the Contact
 * or Account schema at load, so a contract change this file contradicts fails
 * here, loudly, before any journey runs. If `listLeads` grows a filter this
 * mock does not implement, it refuses to load rather than silently ignoring it.
 *
 * WHAT IS NOT IN THE CONTRACT, AND IS THEREFORE DECLARED HERE
 *
 *   - Leads. `listLeads` publishes no example, so the rows are DERIVED from
 *     listContacts' one example contact (Adaeze Okonkwo, `contacted`, with
 *     `emails`, `accountId` and `account` withheld) by spreading it and
 *     overriding named properties. Names, numbers and companies are invented.
 *     One CUSTOMER is in the underlying data too: listLeads never serves it,
 *     and a screen that reads listContacts instead would show it first.
 *   - Accounts for the convert picker: the contract's example account (`Ọjà
 *     Foods Ltd`) and two derived ones, one of them in a SECOND programme.
 *   - A second programme. Field security is per programme, so it is what lets
 *     a column be locked on one row and readable on the next; and convert is
 *     confined to the lead's programme, so it is what the picker must leave out.
 *   - The caller (`ME`, the example contact's owner) and what they may do. The
 *     contract gives the screen no capability read (D-L84), so the journey
 *     tells the mock the caller's permission set, as `role`:
 *       writer  — the `admin` set: contact.write and account.write, so
 *                 convert (both forms) and any status change;
 *       claimer — `agent`, `team_lead`, `programme_manager` (D-P14, D-P18):
 *                 updateContact may carry `status` (and `ownerUserId` = ME)
 *                 and nothing else; convert is `403 not_permitted`, because it
 *                 sets `accountId`;
 *       reader  — `qa_analyst`: every write is `403 not_permitted`.
 *     The default is `claimer`: a BPO agent working a lead queue.
 *   - Opaque cursors, minted per page and bound to the query that produced
 *     them. They carry no name (D-L80 is about the real API's cursors).
 *
 * WHAT THE MOCK ENFORCES ON EVERY REQUEST (recorded as `violations`, the
 * SCREEN's fault; `afterEach` in the spec fails a test that has any)
 *
 *   - listLeads: every query parameter declared, with a value its schema
 *     accepts — so `status=customer`, `sort=companyName`, `programmeId`,
 *     `account`, `page`, `total` and every other invention are violations; a
 *     cursor is echoed exactly as served and only with the q, filters and
 *     sort that produced it.
 *   - The Leads screen never reads `listContacts`. D-L75: an older server
 *     ignores unknown parameters there, so a status filter on it would list
 *     customers as leads. Leads are read from `listLeads` or not at all.
 *   - No request header names a programme or a tenant (CLAUDE.md 2.2).
 *   - updateContact is the Kanban move, and nothing else: the body is EXACTLY
 *     `{ version, status }`, the status is a lead status different from the
 *     row's, the row is one the screen was served, and `version` is the one
 *     it was LAST served for that row (a second move sends the version the
 *     first move's 200 carried).
 *   - convertContact: a closed `ConvertContactRequest` with exactly one of
 *     `accountId` / `newAccount`; a lead the screen was served; never on a row
 *     whose `status` or `accountId` is withheld (the screen was told it cannot
 *     edit them); an `accountId` that the picker was served AND that is in the
 *     lead's own programme (listAccounts says: filter client-side on
 *     `programmeId`); `version` the last one served, except for the exact
 *     repeat the contract answers `200`.
 *   - The account is created BY convert. `createAccount` from this screen is a
 *     violation: create-then-link is two transactions and two audit events
 *     where D-P17 says one.
 *   - listAccounts (the picker): declared parameters only; no scope.
 *   - Any other method or path under `/api/v1/leads`, `/api/v1/contacts` or
 *     `/api/v1/accounts` is a violation.
 *
 * SERVER BEHAVIOUR THE SCREEN DEPENDS ON, IMPLEMENTED AS THE CONTRACT SAYS
 *
 *   - A lead is a contact whose status is new, contacted, qualified or
 *     unqualified. `q` matches names, readable phones (E.164-normalised) and
 *     a readable `companyName`; filters are any-of; `sort` orders by its key
 *     with ties on `id`.
 *   - The custom-field filters (T-0088, lead edit, D-L138): `custom[key]=value`
 *     (equality) and `customEmpty=key` (is empty). While the contract marks
 *     them `x-kasuwa-implemented: false`, sending either is a violation (the
 *     live route ignores unknown parameters: unfiltered rows that look
 *     filtered). Once served, a key withheld in any programme is `400
 *     field_withheld` at `custom.<key>`, and rows match on their `custom`
 *     values. The mock holds no field definitions, so it never answers
 *     `unknown_field` or `filter_not_supported`. They are not Leads chips
 *     (T-0091 draws them), so they are left out of `FILTER_PARAMETERS`.
 *   - If `status` is withheld from the caller in any programme they reach,
 *     every listLeads answer is `400 field_withheld` at `status`. A filter on
 *     another field withheld in any programme is `400 field_withheld` naming
 *     the parameter.
 *   - convertContact's order: 404 contact, 403 (permission, then
 *     field_not_editable), 400 body, 404 account, the exact-repeat rule (200,
 *     nothing written), 409 stale_write, 400 already_linked. A convert
 *     qualifies the lead (a customer keeps its status), links the account,
 *     creates it first for `newAccount`, and advances `version` once.
 *
 * PAGING: AT MOST FOUR ROWS PER PAGE BY DEFAULT, WHATEVER `limit` SAYS.
 * Legal under the contract and deliberate: a screen that decides "last page"
 * from `data.length < limit` instead of from `nextCursor` shows no way to the
 * second page here, and fails. `pageSize` overrides it for one journey.
 * ---------------------------------------------------------------------------
 */

export const RECORDS_CONTRACT_SOURCE = 'docs/api/records.openapi.yaml';
export const AUTH_CONTRACT_SOURCE = 'docs/api/auth.openapi.yaml';

const repoRoot = resolve(__dirname, '..', '..', '..');

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function at(node: unknown, ...path: string[]): unknown {
  let current: unknown = node;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) {
      throw new Error(`contract: nothing at ${path.join('.')}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) {
    throw new Error(`contract: nothing at ${path.join('.')}`);
  }
  return current;
}

const CONTRACT: unknown = parse(readFileSync(resolve(repoRoot, RECORDS_CONTRACT_SOURCE), 'utf8'));
const AUTH_CONTRACT: unknown = parse(readFileSync(resolve(repoRoot, AUTH_CONTRACT_SOURCE), 'utf8'));

/** Follows a local `$ref`. A ref into another file is returned unresolved (an error body). */
function deref(node: unknown): unknown {
  if (!isJson(node) || typeof node.$ref !== 'string' || !node.$ref.startsWith('#/')) {
    return node;
  }
  return deref(at(CONTRACT, ...node.$ref.slice(2).split('/')));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function schema(name: string): Json {
  return at(CONTRACT, 'components', 'schemas', name) as Json;
}

const LEADS_PATH = '/api/v1/leads';
const CONTACTS_PATH = '/api/v1/contacts';
const ACCOUNTS_PATH = '/api/v1/accounts';
const PROGRAMMES_PATH = '/api/v1/me/programmes';
const ME_PATH = '/api/v1/auth/me';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** RFC 3339 in UTC, with a `Z`: the contract's rule for every time. */
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

// ---------------------------------------------------------------------------
// Validation: a JSON-Schema subset, exactly what these bodies and rows use
// ---------------------------------------------------------------------------

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

export function validateBody(value: unknown, raw: unknown, path: string): string[] {
  const spec = deref(raw) as Json;
  const where = path || 'body';
  if (Array.isArray(spec.oneOf)) {
    const passing = spec.oneOf.filter((option) => validateBody(value, option, path).length === 0);
    if (passing.length !== 1) {
      return [`${where} matches ${passing.length} of oneOf, not exactly 1`];
    }
  }
  const problems: string[] = [];
  if (Array.isArray(spec.allOf)) {
    for (const part of spec.allOf) {
      problems.push(...validateBody(value, part, path));
    }
  }
  if (spec.type !== undefined) {
    const allowed = (Array.isArray(spec.type) ? spec.type : [spec.type]).map(String);
    const actual = typeOf(value);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      return [...problems, `${where} is ${actual}, not ${allowed.join('|')}`];
    }
  }
  if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
    problems.push(`${where} is not one of ${spec.enum.join(', ')}`);
  }
  if (typeof value === 'string') {
    if (typeof spec.minLength === 'number' && value.length < spec.minLength) problems.push(`${where} is too short`);
    if (typeof spec.maxLength === 'number' && value.length > spec.maxLength) problems.push(`${where} is too long`);
    if (typeof spec.pattern === 'string' && !new RegExp(spec.pattern).test(value)) {
      problems.push(`${where} does not match ${spec.pattern}`);
    }
    if (spec.format === 'uuid' && !UUID_PATTERN.test(value)) problems.push(`${where} is not a uuid`);
    if (spec.format === 'date-time' && !UTC_DATE_TIME.test(value)) {
      problems.push(`${where} is not a UTC date-time with a Z`);
    }
    if (spec.format === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) problems.push(`${where} is not an email`);
    if (value.includes('\u0000')) problems.push(`${where} carries a NUL`);
  }
  if (typeof value === 'number') {
    if (typeof spec.minimum === 'number' && value < spec.minimum) problems.push(`${where} is below ${spec.minimum}`);
    if (typeof spec.maximum === 'number' && value > spec.maximum) problems.push(`${where} is above ${spec.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof spec.maxItems === 'number' && value.length > spec.maxItems) problems.push(`${where} has too many items`);
    if (spec.items !== undefined) {
      value.forEach((item, index) => problems.push(...validateBody(item, spec.items, `${path}.${index}`)));
    }
  }
  if (isJson(value) && (spec.properties !== undefined || spec.required !== undefined || spec.additionalProperties === false)) {
    const properties = (spec.properties ?? {}) as Json;
    for (const key of (spec.required ?? []) as string[]) {
      if (!(key in value)) problems.push(`${path ? `${path}.` : ''}${key} is required`);
    }
    if (typeof spec.minProperties === 'number' && Object.keys(value).length < spec.minProperties) {
      problems.push(`${where} has fewer than ${spec.minProperties} properties`);
    }
    for (const [key, item] of Object.entries(value)) {
      const child = `${path ? `${path}.` : ''}${key}`;
      if (!(key in properties)) {
        if (spec.additionalProperties === false) problems.push(`${child} is not a property of this closed body`);
        continue;
      }
      problems.push(...validateBody(item, properties[key], child));
    }
  }
  return problems;
}

interface ParameterSpec {
  name: string;
  schema: Json;
}

function parametersOf(operation: unknown): ParameterSpec[] {
  return (at(operation, 'parameters') as unknown[]).map((raw) => {
    const parameter = deref(raw) as Json;
    return { name: String(parameter.name), schema: (deref(parameter.schema) ?? {}) as Json };
  });
}

function validateScalar(name: string, value: string, spec: Json): string | undefined {
  const scalar = spec.type === 'array' ? (deref(spec.items) as Json) : spec;
  if (Array.isArray(scalar.enum) && !scalar.enum.map(String).includes(value)) {
    return `${name}=${value} is not one of ${scalar.enum.join(', ')}`;
  }
  if (scalar.type === 'integer') {
    const number = Number(value);
    const minimum = typeof scalar.minimum === 'number' ? scalar.minimum : -Infinity;
    const maximum = typeof scalar.maximum === 'number' ? scalar.maximum : Infinity;
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
      return `${name}=${value} is outside ${minimum}..${maximum}`;
    }
  }
  if (scalar.type === 'boolean' && value !== 'true' && value !== 'false') {
    return `${name}=${value} is not a boolean`;
  }
  if (typeof scalar.minLength === 'number' && value.length < scalar.minLength) {
    return `${name} is shorter than ${scalar.minLength}`;
  }
  if (typeof scalar.maxLength === 'number' && value.length > scalar.maxLength) {
    return `${name} is longer than ${scalar.maxLength}`;
  }
  if (typeof scalar.pattern === 'string' && !new RegExp(scalar.pattern).test(value)) {
    return `${name}=${value} does not match ${scalar.pattern}`;
  }
  return undefined;
}

function validateQuery(params: URLSearchParams, declared: readonly ParameterSpec[], operation: string): string[] {
  const problems: string[] = [];
  for (const name of new Set(params.keys())) {
    const spec = declared.find((parameter) => parameter.name === name);
    if (spec === undefined) {
      problems.push(`${operation} declares no "${name}" parameter`);
      continue;
    }
    const values = params.getAll(name);
    if (spec.schema.type !== 'array' && values.length > 1) {
      problems.push(`${name} was sent ${values.length} times; it is not an array`);
    }
    if (typeof spec.schema.maxItems === 'number' && values.length > spec.schema.maxItems) {
      problems.push(`${name} has more than ${spec.schema.maxItems} values`);
    }
    for (const value of values) {
      const problem = validateScalar(name, value, spec.schema);
      if (problem !== undefined) {
        problems.push(problem);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The contract's own vocabularies
// ---------------------------------------------------------------------------

const LIST = at(CONTRACT, 'paths', LEADS_PATH, 'get');

/** `listLeads` query parameters, `$ref`s followed. */
export const LIST_PARAMETERS: readonly ParameterSpec[] = parametersOf(LIST);

/** T-0088 (lead edit, D-L138): the custom-field filters. Not Leads chips; handled on their own below. */
const CUSTOM_FILTERS: readonly string[] = ['custom', 'customEmpty'];

/** What the Leads chips may send: every declared parameter that is not search, sort, paging or a custom-field filter. */
export const FILTER_PARAMETERS: readonly string[] = LIST_PARAMETERS.map((p) => p.name).filter(
  (name) => !['q', 'sort', 'cursor', 'limit', ...CUSTOM_FILTERS].includes(name),
);

/** The raw (dereferenced) listLeads parameter object, or undefined when the contract has none. */
function rawListParameter(name: string): Json | undefined {
  return (at(LIST, 'parameters') as unknown[]).map((raw) => deref(raw) as Json).find((parameter) => parameter.name === name);
}

/** Whether the contract says the custom-field filters are served (`x-kasuwa-implemented: true`). */
const CUSTOM_FILTERS_SERVED = CUSTOM_FILTERS.every((name) => rawListParameter(name)?.['x-kasuwa-implemented'] === true);
const CUSTOM_SCHEMA = (deref(rawListParameter('custom')?.schema) ?? {}) as Json;
const CUSTOM_KEY_PATTERN = String(((deref(CUSTOM_SCHEMA.propertyNames) ?? {}) as Json).pattern ?? '^[a-z][a-z0-9_]*__c$');
const CUSTOM_VALUE_PATTERN = String(((deref(CUSTOM_SCHEMA.additionalProperties) ?? {}) as Json).pattern ?? '^[a-z][a-z0-9_]{0,61}[a-z0-9]$');

/** `custom[key]=value` pairs from a query string. */
function customEquals(params: URLSearchParams): [string, string][] {
  return [...params.entries()]
    .map(([name, value]): [RegExpExecArray | null, string] => [/^custom\[([^\]]*)\]$/.exec(name), value])
    .filter((entry): entry is [RegExpExecArray, string] => entry[0] !== null)
    .map(([match, value]) => [match[1] ?? '', value]);
}

/** The query without the custom-field filters, for the declared-parameter check. */
function withoutCustomFilters(params: URLSearchParams): URLSearchParams {
  const kept = new URLSearchParams();
  for (const [name, value] of params.entries()) {
    if (name !== 'customEmpty' && !/^custom\[/.test(name)) kept.append(name, value);
  }
  return kept;
}

/** Problems with the custom-field filters as sent; empty when there are none or they are well formed. */
function customFilterProblems(params: URLSearchParams): string[] {
  const equals = customEquals(params);
  const empty = params.getAll('customEmpty');
  if (equals.length === 0 && empty.length === 0) return [];
  if (!CUSTOM_FILTERS_SERVED) {
    return ['listLeads custom-field filters are x-kasuwa-implemented: false; a screen must not send them (T-0088 R19)'];
  }
  const problems: string[] = [];
  for (const [key, value] of equals) {
    if (!new RegExp(CUSTOM_KEY_PATTERN).test(key)) problems.push(`custom[${key}] is not a custom-field key`);
    if (!new RegExp(CUSTOM_VALUE_PATTERN).test(value)) problems.push(`custom[${key}]=${value} is not a picklist or boolean value`);
  }
  for (const key of empty) {
    if (!new RegExp(CUSTOM_KEY_PATTERN).test(key)) problems.push(`customEmpty=${key} is not a custom-field key`);
  }
  return problems;
}

/** Whether a row passes the custom-field filters: equality, and absence for `customEmpty`. */
function matchesCustom(row: ContactRow, params: URLSearchParams): boolean {
  const values = isJson(row.custom) ? row.custom : {};
  return (
    customEquals(params).every(([key, value]) => key in values && String(values[key]) === value) &&
    params.getAll('customEmpty').every((key) => !(key in values))
  );
}

/** The values a listLeads parameter's schema enumerates (array items or a scalar enum). */
export function parameterEnum(name: string): readonly string[] {
  const spec = LIST_PARAMETERS.find((parameter) => parameter.name === name)?.schema ?? {};
  const items = spec.type === 'array' ? (deref(spec.items) as Json) : spec;
  return Array.isArray(items.enum) ? items.enum.map(String) : [];
}

/** The lead stages: listLeads' `status` enum. One Kanban column each. Never `customer`. */
export const LEAD_STATUSES: readonly string[] = parameterEnum('status');

/** Every contact status, `customer` included. */
export const CONTACT_STATUSES: readonly string[] = (at(schema('ContactStatus'), 'enum') as unknown[]).map(String);

/** `sort`'s enum. Every key is a field field security never withholds. */
export const SORT_VALUES: readonly string[] = parameterEnum('sort');

/** The Contact properties the list may be ordered by: the `sort` keys, sign dropped. */
export const SORTABLE_FIELDS: readonly string[] = [...new Set(SORT_VALUES.map((value) => value.replace(/^-/, '')))];

/** Which Contact property each listLeads filter reads. A filter on a withheld one is 400. */
export const FILTER_FIELD: Readonly<Record<string, string>> = {
  owner: 'ownerUserId',
  status: 'status',
  source: 'source',
};

for (const parameter of FILTER_PARAMETERS) {
  if (FILTER_FIELD[parameter] === undefined) {
    throw new Error(
      `${RECORDS_CONTRACT_SOURCE}: listLeads declares a "${parameter}" filter this mock does not implement. ` +
        'Teach the mock, then ask the lead to re-pin it.',
    );
  }
}

if (LEAD_STATUSES.includes('customer') || LEAD_STATUSES.length !== 4) {
  throw new Error(`${RECORDS_CONTRACT_SOURCE}: listLeads' status enum is no longer the four lead stages`);
}

const ACCOUNT_LIST = at(CONTRACT, 'paths', ACCOUNTS_PATH, 'get');
const ACCOUNT_LIST_PARAMETERS: readonly ParameterSpec[] = parametersOf(ACCOUNT_LIST);

/** Contact properties the live wire carries (`Contact.properties`). */
const LIVE_PROPERTIES: readonly string[] = Object.keys(at(schema('Contact'), 'properties') as Json);
/** Specified, not served yet (`ContactPendingProperties`): optional, never required. */
const PENDING_PROPERTIES: readonly string[] = Object.keys(at(schema('ContactPendingProperties'), 'properties') as Json);
/** Every property a Contact may carry. A column the screen shows must be one of these. */
export const CONTACT_PROPERTIES: readonly string[] = [...LIVE_PROPERTIES, ...PENDING_PROPERTIES];
const CONTACT_REQUIRED = at(schema('Contact'), 'required') as string[];

const ACCOUNT_PROPERTIES: readonly string[] = Object.keys(at(schema('Account'), 'properties') as Json);
const ACCOUNT_REQUIRED = at(schema('Account'), 'required') as string[];

const UPDATE_SCHEMA = schema('UpdateContactRequest');
const CONVERT_SCHEMA = schema('ConvertContactRequest');

/** The `code`s an operation can answer with, read from its error responses. */
export function errorCodes(path: string, method: string): string[] {
  const codes = new Set<string>();
  for (const [status, raw] of Object.entries(at(CONTRACT, 'paths', path, method, 'responses') as Json)) {
    if (status.startsWith('2')) {
      continue;
    }
    const json = at(deref(raw), 'content', 'application/json') as Json;
    const examples = [json.example, ...Object.values((json.examples ?? {}) as Json).map((e) => at(e, 'value'))];
    for (const example of examples) {
      if (isJson(example) && typeof example.code === 'string') {
        codes.add(example.code);
      }
    }
  }
  return [...codes].sort();
}

function errorExample(response: string, name?: string): Json {
  const json = at(deref(at(CONTRACT, 'components', 'responses', response)), 'content', 'application/json') as Json;
  const body = name === undefined ? json.example : at(json.examples, name, 'value');
  return clone(body) as Json;
}

// ---------------------------------------------------------------------------
// Programmes and people
// ---------------------------------------------------------------------------

export interface Programme {
  id: string;
  name: string;
}

export interface Person {
  id: string;
  displayName: string;
}

/** The contract's own example programme (`Bank X Collections`). */
export const PROGRAMME_ONE = clone(
  at(CONTRACT, 'paths', PROGRAMMES_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', '0'),
) as Programme;

/** A second programme in the same tenant, with a stricter field-security matrix. */
export const PROGRAMME_TWO: Programme = {
  id: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a02',
  name: 'Lagos Water Customer Care',
};

export interface ContactRow {
  id: string;
  programmeId: string;
  displayName: string;
  version: number;
  withheldFields: string[];
  [property: string]: unknown;
}

const CONTACT_EXAMPLE = clone(
  at(CONTRACT, 'paths', CONTACTS_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', '0'),
) as ContactRow;

/** The caller: the contract's example owner (Kemi Balogun). `owner=me` means her. */
export const ME: Person = clone(CONTACT_EXAMPLE.owner as Person);

/** Another member of PROGRAMME_ONE. */
export const OTHER_OWNER: Person = { id: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02', displayName: 'Tunde Adeyemi' };

/** `getCurrentUser`'s body for ME. The auth contract has no example; every required key is set. */
export const CURRENT_USER: Json = {
  id: ME.id,
  tenantId: TENANT_A,
  email: 'kemi.balogun@example.ng',
  displayName: ME.displayName,
  locale: 'en-NG',
};

for (const key of at(AUTH_CONTRACT, 'components', 'schemas', 'CurrentUser', 'required') as string[]) {
  if (!(key in CURRENT_USER)) {
    throw new Error(`CURRENT_USER lacks ${key}, which ${AUTH_CONTRACT_SOURCE} requires`);
  }
}

// ---------------------------------------------------------------------------
// Accounts (the convert picker)
// ---------------------------------------------------------------------------

export interface AccountRow {
  id: string;
  programmeId: string;
  name: string;
  version: number;
  withheldFields: string[];
  [property: string]: unknown;
}

function checkAccount(row: AccountRow): AccountRow {
  const unknown = Object.keys(row).filter((key) => !ACCOUNT_PROPERTIES.includes(key));
  const missing = ACCOUNT_REQUIRED.filter((key) => !(key in row));
  const typed = Object.entries(row).flatMap(([key, value]) =>
    ACCOUNT_PROPERTIES.includes(key) ? validateBody(value, at(schema('Account'), 'properties', key), key) : [],
  );
  const problems = [
    unknown.length > 0 ? `unknown ${unknown.join(',')}` : '',
    missing.length > 0 ? `missing ${missing.join(',')}` : '',
    ...typed,
  ].filter((problem) => problem !== '');
  if (problems.length > 0) {
    throw new Error(`account ${row.id} disagrees with ${RECORDS_CONTRACT_SOURCE}: ${problems.join('; ')}`);
  }
  return row;
}

/** The contract's example account, verbatim: `Ọjà Foods Ltd`, in PROGRAMME_ONE. */
export const ACCOUNT_EXAMPLE = checkAccount(
  clone(at(ACCOUNT_LIST, 'responses', '200', 'content', 'application/json', 'example', 'data', '0')) as AccountRow,
);

function deriveAccount(overrides: Partial<AccountRow> & { id: string; name: string }): AccountRow {
  return checkAccount({ ...clone(ACCOUNT_EXAMPLE), ...overrides, withheldFields: [] });
}

/** A second account in PROGRAMME_ONE: what the "existing account" journey links. */
export const ACCOUNT_SAME_PROGRAMME = deriveAccount({
  id: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c11',
  name: 'Bakare Logistics Ltd',
  version: 1,
  ownerUserId: null,
  owner: null,
  industry: 'Logistics',
  tier: 'sme',
  tags: [],
  phones: [],
  state: 'Lagos',
  lga: 'Apapa',
  createdAt: '2026-09-15T10:00:00.000Z',
  updatedAt: '2026-09-15T10:00:00.000Z',
});

/**
 * In PROGRAMME_TWO. The caller reaches it, so listAccounts serves it; a
 * PROGRAMME_ONE lead cannot be linked to it (convert answers 404), so the
 * picker must not offer it there.
 */
export const ACCOUNT_OTHER_PROGRAMME = deriveAccount({
  id: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c12',
  programmeId: PROGRAMME_TWO.id,
  name: 'Lagos Water Depot Ltd',
  version: 1,
  ownerUserId: null,
  owner: null,
  industry: 'Utilities',
  tier: 'enterprise',
  tags: [],
  phones: [],
  state: 'Lagos',
  lga: 'Surulere',
  createdAt: '2026-09-16T10:00:00.000Z',
  updatedAt: '2026-09-16T10:00:00.000Z',
});

const ALL_ACCOUNTS: readonly AccountRow[] = [ACCOUNT_EXAMPLE, ACCOUNT_SAME_PROGRAMME, ACCOUNT_OTHER_PROGRAMME];

/** The ids the mock gives accounts convert creates, in order. One is expected; a second is a duplicate. */
export const NEW_ACCOUNT_IDS: readonly string[] = Array.from(
  { length: 10 },
  (_, index) => `5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c2${index}`,
);

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

function checkContact(row: ContactRow): ContactRow {
  const unknown = Object.keys(row).filter((key) => !CONTACT_PROPERTIES.includes(key));
  const missing = CONTACT_REQUIRED.filter((key) => !(key in row));
  // The T-0041 rule: every live property is served or listed as withheld.
  const unaccounted = LIVE_PROPERTIES.filter((key) => !(key in row) && !row.withheldFields.includes(key));
  // T-0088 (D-L140): a withheld custom key is listed as `custom.<key>` and
  // must be absent from `row.custom`, not from the row itself.
  const custom = (row.custom ?? {}) as Record<string, unknown>;
  const leaked = row.withheldFields.filter((field) =>
    field.startsWith('custom.') ? field.slice('custom.'.length) in custom : field in row,
  );
  const apart =
    row.withheldFields.includes('ownerUserId') !== row.withheldFields.includes('owner') ||
    row.withheldFields.includes('accountId') !== row.withheldFields.includes('account');
  const owner = row.owner as { id?: string } | null | undefined;
  const account = row.account as { id?: string } | null | undefined;
  const ownerMismatch = 'ownerUserId' in row && (row.ownerUserId === null ? owner !== null : owner?.id !== row.ownerUserId);
  const accountMismatch =
    'accountId' in row && (row.accountId === null ? account !== null : account?.id !== row.accountId);
  const typed = Object.entries(row)
    .filter(([key]) => LIVE_PROPERTIES.includes(key))
    .flatMap(([key, value]) => validateBody(value, at(schema('Contact'), 'properties', key), key));
  const problems = [
    unknown.length > 0 ? `unknown ${unknown.join(',')}` : '',
    missing.length > 0 ? `missing ${missing.join(',')}` : '',
    unaccounted.length > 0 ? `neither served nor withheld ${unaccounted.join(',')}` : '',
    leaked.length > 0 ? `withheld but present ${leaked.join(',')}` : '',
    apart ? 'owner/ownerUserId or account/accountId withheld apart' : '',
    ownerMismatch ? 'owner disagrees with ownerUserId' : '',
    accountMismatch ? 'account disagrees with accountId' : '',
    ...typed,
  ].filter((problem) => problem !== '');
  if (problems.length > 0) {
    throw new Error(`contact ${row.id} disagrees with ${RECORDS_CONTRACT_SOURCE}: ${problems.join('; ')}`);
  }
  return row;
}

function ownedBy(person: Person | null): { ownerUserId: string | null; owner: Person | null } {
  return person === null ? { ownerUserId: null, owner: null } : { ownerUserId: person.id, owner: clone(person) };
}

function inAccount(account: AccountRow | null): {
  accountId: string | null;
  account: { id: string; name: string } | null;
} {
  return account === null
    ? { accountId: null, account: null }
    : { accountId: account.id, account: { id: account.id, name: account.name } };
}

function derive(
  overrides: Partial<ContactRow> & { id: string; displayName: string },
  withheld: readonly string[] = [],
): ContactRow {
  const row: ContactRow = { ...clone(CONTACT_EXAMPLE), ...overrides, withheldFields: [...withheld] };
  for (const field of withheld) {
    if (field.startsWith('custom.')) {
      const custom = row.custom as Record<string, unknown> | undefined;
      if (custom !== undefined) delete custom[field.slice('custom.'.length)];
    } else {
      delete row[field];
    }
  }
  return checkContact(row);
}

/**
 * listContacts' example contact, verbatim: Adaeze Okonkwo, `contacted`, owned
 * by ME, company `Okonkwo Fabrics`, in PROGRAMME_ONE. It WITHHOLDS `accountId`
 * (and `account` and `emails`), so the caller cannot convert it: convert
 * writes `accountId`.
 */
export const LEAD_EXAMPLE = checkContact(clone(CONTACT_EXAMPLE));

/** A fresh lead, nothing withheld, no account, owned by a colleague: the one the journeys drag and convert. */
export const LEAD_NEW = derive({
  id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e11',
  version: 2,
  displayName: 'Tunde Bakare',
  givenNames: 'Tunde',
  familyName: 'Bakare',
  companyName: 'Bakare Logistics',
  phones: [{ type: 'mobile', e164: '+2348060000002' }],
  emails: [],
  ...inAccount(null),
  ...ownedBy(OTHER_OWNER),
  status: 'new',
  source: 'manual',
  tags: ['Q4 promo'],
  state: 'Lagos',
  lga: 'Apapa',
  consentState: 'pending',
  whatsappOptIn: false,
  phoneNetwork: 'Glo',
  createdAt: '2026-10-06T08:00:00.000Z',
  updatedAt: '2026-10-06T08:00:00.000Z',
});

/** Every nullable property null and every list empty: "no value", never a lock. */
export const LEAD_NULLS = derive({
  id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e12',
  version: 1,
  displayName: 'Musa Danladi',
  givenNames: null,
  familyName: null,
  companyName: null,
  phones: [],
  emails: [],
  ...inAccount(null),
  ...ownedBy(null),
  status: 'unqualified',
  source: null,
  tags: [],
  preferredLanguage: null,
  preferredChannel: null,
  state: null,
  lga: null,
  dnd: false,
  whatsappOptIn: false,
  consentState: 'unknown',
  phoneNetwork: null,
  createdAt: '2026-10-05T08:00:00.000Z',
  updatedAt: '2026-10-05T08:00:00.000Z',
});

/**
 * In PROGRAMME_TWO, whose matrix withholds `companyName`, `phones` and
 * `emails`: OMITTED and listed. Beside LEAD_NEW, whose company and phone are
 * readable, so a screen that locks a whole column from one row fails.
 */
export const LEAD_LOCKED = derive(
  {
    id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e13',
    programmeId: PROGRAMME_TWO.id,
    version: 5,
    displayName: 'Chidi Eze',
    givenNames: 'Chidi',
    familyName: 'Eze',
    ...inAccount(null),
    ...ownedBy(OTHER_OWNER),
    status: 'new',
    source: 'ussd',
    tags: ['Water arrears'],
    preferredLanguage: 'ig',
    state: 'Lagos',
    lga: 'Surulere',
    phoneNetwork: 'Airtel',
    createdAt: '2026-10-04T08:00:00.000Z',
    updatedAt: '2026-10-04T08:00:00.000Z',
  },
  ['companyName', 'phones', 'emails'],
);

/** Already converted: `qualified` and linked to the example account. It stays on the list (D-L75). */
export const LEAD_LINKED = derive({
  id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e14',
  version: 3,
  displayName: 'Ifeoma Nwosu',
  givenNames: 'Ifeoma',
  familyName: 'Nwosu',
  companyName: 'Ọjà Foods Ltd',
  phones: [{ type: 'mobile', e164: '+2348030000014' }],
  emails: [],
  ...inAccount(ACCOUNT_EXAMPLE),
  ...ownedBy(ME),
  status: 'qualified',
  source: 'referral',
  tags: [],
  createdAt: '2026-09-28T08:00:00.000Z',
  updatedAt: '2026-10-02T08:00:00.000Z',
});

/** Oldest: only ever on the second page under the default sort; first under `-displayName`. */
export const LEAD_PAGE_TWO = derive({
  id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e15',
  version: 1,
  displayName: 'Zainab Lawal',
  givenNames: 'Zainab',
  familyName: 'Lawal',
  companyName: 'Lawal Textiles',
  phones: [{ type: 'mobile', e164: '+2348030000015' }],
  emails: [],
  ...inAccount(null),
  ...ownedBy(ME),
  status: 'contacted',
  source: 'whatsapp',
  tags: [],
  createdAt: '2026-09-20T08:00:00.000Z',
  updatedAt: '2026-09-20T08:00:00.000Z',
});

/**
 * A customer, and the NEWEST contact: not a lead, never served by listLeads.
 * A screen that read listContacts would put it first.
 */
export const CUSTOMER = derive({
  id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e16',
  version: 7,
  displayName: 'Emeka Okafor',
  givenNames: 'Emeka',
  familyName: 'Okafor',
  companyName: 'Okafor Motors',
  phones: [{ type: 'mobile', e164: '+2348030000016' }],
  emails: [],
  ...inAccount(ACCOUNT_SAME_PROGRAMME),
  ...ownedBy(ME),
  status: 'customer',
  createdAt: '2026-10-07T07:00:00.000Z',
  updatedAt: '2026-10-07T07:00:00.000Z',
});

/** In PROGRAMME_TWO under a stricter matrix: the owner is withheld (both properties), on the same page as readable owners. */
export const LEAD_OWNER_LOCKED = derive(
  {
    id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e17',
    programmeId: PROGRAMME_TWO.id,
    version: 2,
    displayName: 'Halima Garba',
    givenNames: 'Halima',
    familyName: 'Garba',
    companyName: 'Garba Agro',
    phones: [{ type: 'mobile', e164: '+2348030000017' }],
    ...inAccount(null),
    status: 'contacted',
    tags: [],
    createdAt: '2026-10-03T08:00:00.000Z',
    updatedAt: '2026-10-03T08:00:00.000Z',
  },
  ['ownerUserId', 'owner', 'emails'],
);

/** In PROGRAMME_TWO with `status` withheld: then listLeads answers every request 400 at `status`. */
export const LEAD_STATUS_LOCKED = derive(
  {
    id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e18',
    programmeId: PROGRAMME_TWO.id,
    version: 1,
    displayName: 'Yusuf Abdullahi',
    givenNames: 'Yusuf',
    familyName: 'Abdullahi',
    companyName: null,
    ...inAccount(null),
    tags: [],
    createdAt: '2026-10-02T08:00:00.000Z',
    updatedAt: '2026-10-02T08:00:00.000Z',
  },
  ['status', 'emails'],
);

/** Markup in record data. It must be drawn as text, never parsed. */
export const HOSTILE_NAME = '<img src=x onerror="window.__kasuwaXss=1">Bùkọ́lá <b>Adé</b>';
export const HOSTILE_COMPANY = '<script>window.__kasuwaXss=2</script>Àdìsá & Sons <b>Ltd</b>';

export const LEAD_HOSTILE = derive({
  id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e19',
  version: 1,
  displayName: HOSTILE_NAME,
  givenNames: null,
  familyName: null,
  companyName: HOSTILE_COMPANY,
  emails: [],
  ...inAccount(null),
  status: 'new',
  tags: ['<i>VIP</i>'],
  createdAt: '2026-10-06T09:00:00.000Z',
  updatedAt: '2026-10-06T09:00:00.000Z',
});

export type LeadsScenario = 'default' | 'empty' | 'mixedWithheld' | 'statusWithheld' | 'hostile';

const DATASETS: Readonly<Record<LeadsScenario, readonly ContactRow[]>> = {
  default: [LEAD_NEW, LEAD_NULLS, LEAD_LOCKED, LEAD_EXAMPLE, LEAD_LINKED, LEAD_PAGE_TWO, CUSTOMER],
  // No leads at all — but a customer exists. The empty state, not a list of customers.
  empty: [CUSTOMER],
  mixedWithheld: [LEAD_NEW, LEAD_OWNER_LOCKED, LEAD_EXAMPLE],
  statusWithheld: [LEAD_NEW, LEAD_STATUS_LOCKED],
  hostile: [LEAD_HOSTILE, LEAD_NEW],
};

/** Every row a scenario holds, customers included, for checks that compare the page to served data. */
export function scenarioRows(scenario: LeadsScenario): readonly ContactRow[] {
  return DATASETS[scenario];
}

/** Every account the picker can be served. */
export function allAccounts(): readonly AccountRow[] {
  return ALL_ACCOUNTS;
}

export const DEFAULT_PAGE_SIZE = 4;

// ---------------------------------------------------------------------------
// Server behaviour
// ---------------------------------------------------------------------------

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function isLead(row: ContactRow): boolean {
  return typeof row.status === 'string' && LEAD_STATUSES.includes(row.status);
}

function matchesQuery(row: ContactRow, q: string | null): boolean {
  if (q === null) {
    return true;
  }
  const text = fold(q.trim());
  // Only what the caller may read: a withheld property is absent from the row.
  const words = [row.displayName, row.givenNames, row.familyName, row.companyName].filter(
    (value): value is string => typeof value === 'string',
  );
  if (words.some((word) => fold(word).includes(text))) {
    return true;
  }
  let digits = q.replace(/\D/g, '');
  if (digits.length < 4 || !Array.isArray(row.phones)) {
    return false;
  }
  if (digits.startsWith('0')) {
    digits = `234${digits.slice(1)}`;
  }
  return (row.phones as { e164: string }[]).some((phone) => phone.e164.replace(/\D/g, '').includes(digits));
}

function matchesFilters(row: ContactRow, params: URLSearchParams): boolean {
  const owner = params.getAll('owner');
  const ownerOk =
    owner.length === 0 ||
    owner.some((value) =>
      value === 'unassigned'
        ? row.ownerUserId === null
        : (value === 'me' ? ME.id : value).toLowerCase() === String(row.ownerUserId).toLowerCase(),
    );
  const status = params.getAll('status');
  const source = params.getAll('source');
  return (
    ownerOk &&
    (status.length === 0 || status.includes(String(row.status))) &&
    (source.length === 0 || source.includes(String(row.source)))
  );
}

function sortRows(rows: readonly ContactRow[], sort: string): ContactRow[] {
  const descending = sort.startsWith('-');
  const key = sort.replace(/^-/, '');
  const read = (row: ContactRow): string => (key === 'displayName' ? fold(row.displayName) : String(row[key] ?? ''));
  return [...rows].sort((a, b) => {
    const order = read(a).localeCompare(read(b)) || a.id.localeCompare(b.id);
    return descending ? -order : order;
  });
}

/** q, filters and sort: what a cursor is bound to. */
function queryKey(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([name]) => name !== 'cursor' && name !== 'limit')
    .map(([name, value]) => `${name}=${value}`)
    .sort()
    .join('&');
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export type Role = 'writer' | 'claimer' | 'reader';

export type ConvertRefusal = 'stale_write' | 'already_linked' | 'account_not_found';

export interface LeadsMockOptions {
  readonly scenario?: LeadsScenario;
  /** The caller's permission set (see the header). Default `claimer`. */
  readonly role?: Role;
  /** Rows per listLeads page. Default four. */
  readonly pageSize?: number;
  /** Hold every listLeads response until `release()`. The loading state, without a clock. */
  readonly hold?: boolean;
  /** Abort every listLeads request, as a dropped connection does. */
  readonly networkFailure?: boolean;
  /** Hold every write until `releaseWrites()`: the in-flight state of a move or a convert. */
  readonly holdWrites?: boolean;
  /** Answer every valid status change 409, as if another desk had saved first. */
  readonly refuseUpdate?: 'stale_write';
  /** Answer every valid convert with this refusal instead of applying it. */
  readonly refuseConvert?: ConvertRefusal;
  /**
   * Apply the FIRST convert, then drop its response, as a lost connection
   * does after the server committed. The retry meets the contract's
   * exact-repeat rule.
   */
  readonly loseConvertResponse?: boolean;
  /**
   * Custom-field definitions, values and field security (T-0091, lead edit),
   * served by `custom-fields-mock.ts`: listCustomFields (the contact object),
   * the projected `custom` and `custom.<key>` paths on every served lead, and
   * the `custom[<key>]` and `customEmpty` filters, checked and applied there
   * in place of this file's own pattern-only check. Absent: listCustomFields
   * lists nothing and the T-0058 journeys are unchanged.
   */
  readonly customFields?: CustomFieldsSetup;
}

export interface RecordedWrite {
  readonly id: string;
  readonly body: unknown;
}

export interface LeadsMock {
  /** Every `listLeads` request, in order. */
  readonly requests: URL[];
  /** Every `listAccounts` request (the picker), in order. */
  readonly accountRequests: URL[];
  /** Every `updateContact` request, in order. */
  readonly updates: RecordedWrite[];
  /** Every `convertContact` request, in order. */
  readonly converts: RecordedWrite[];
  /** Contract breaches by the SCREEN. Must be empty at the end of every test. */
  readonly violations: string[];
  /** The contacts as they now stand (writes applied). */
  readonly rows: ContactRow[];
  /** Accounts created by convert. More than one for one lead is a duplicate. */
  readonly createdAccounts: AccountRow[];
  /** Converts answered under the exact-repeat rule (200, nothing written). */
  repeats(): number;
  /** Every cursor this mock has served. */
  issuedCursors(): string[];
  /** The custom-field half (T-0091): definition reads and stored values. */
  readonly custom: CustomFieldsServer;
  release(): void;
  releaseWrites(): void;
}

export function isListLeads(request: Request): boolean {
  return request.method() === 'GET' && new URL(request.url()).pathname === LEADS_PATH;
}

export function isListAccounts(request: Request): boolean {
  return request.method() === 'GET' && new URL(request.url()).pathname === ACCOUNTS_PATH;
}

export function isUpdateContact(request: Request, id: string): boolean {
  return request.method() === 'PATCH' && new URL(request.url()).pathname === `${CONTACTS_PATH}/${id}`;
}

export function isConvert(request: Request, id: string): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === `${CONTACTS_PATH}/${id}/convert`;
}

function fulfil(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  });
}

function validation(details: { path: string; code: string }[]): Json {
  const body = errorExample('ValidationFailed', 'badField');
  body.details = details;
  return body;
}

function forbidden(details?: { path: string; code: string }[]): Json {
  if (details === undefined) {
    return errorExample('NotPermitted', 'action');
  }
  const body = errorExample('NotPermitted', 'field');
  body.details = details;
  return body;
}

/** Server time for the n-th write: later than everything in the fixtures. */
function serverTime(n: number): string {
  return new Date(Date.parse('2026-10-07T10:00:00.000Z') + n * 60_000).toISOString();
}

export async function installLeadsMock(page: Page, options: LeadsMockOptions = {}): Promise<LeadsMock> {
  const role: Role = options.role ?? 'claimer';
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const rows: ContactRow[] = DATASETS[options.scenario ?? 'default'].map((row) => clone(row));
  const accounts: AccountRow[] = ALL_ACCOUNTS.map((account) => clone(account));
  const programmes = [PROGRAMME_ONE, PROGRAMME_TWO];

  const requests: URL[] = [];
  const accountRequests: URL[] = [];
  const updates: RecordedWrite[] = [];
  const converts: RecordedWrite[] = [];
  const violations: string[] = [];
  const createdAccounts: AccountRow[] = [];
  const custom = new CustomFieldsServer(options.customFields, violations);

  /** The version of each contact the screen was LAST served, by any read or write. */
  const servedVersion = new Map<string, number>();
  /** Accounts the picker was served. */
  const servedAccounts = new Set<string>();
  /** cursor -> the query it was served for, and where its page starts */
  const issued = new Map<string, { query: string; start: number }>();
  let cursorCount = 0;
  let writeCount = 0;
  let repeatCount = 0;
  let lostOne = false;

  let release: () => void = () => undefined;
  const gate = options.hold === true ? new Promise<void>((done) => (release = done)) : Promise.resolve();
  let releaseWrites: () => void = () => undefined;
  const writeGate =
    options.holdWrites === true ? new Promise<void>((done) => (releaseWrites = done)) : Promise.resolve();

  const serve = (row: ContactRow): ContactRow => {
    servedVersion.set(row.id, row.version);
    return custom.decorate(clone(row), 'contact', row.id, row.programmeId);
  };

  const serveAccount = (account: AccountRow): AccountRow => {
    servedAccounts.add(account.id);
    return clone(account);
  };

  const mint = (query: string, start: number): string => {
    cursorCount += 1;
    const cursor = Buffer.from(JSON.stringify({ k: `p${cursorCount}` }), 'utf8').toString('base64url');
    issued.set(cursor, { query, start });
    return cursor;
  };

  const checkHeaders = (request: Request, label: string): void => {
    for (const header of Object.keys(request.headers())) {
      if (/programme|tenant/i.test(header)) {
        violations.push(`${label} was sent a "${header}" header — scope is never supplied`);
      }
    }
  };

  const readBody = (request: Request, label: string): unknown => {
    try {
      return request.postDataJSON() as unknown;
    } catch {
      violations.push(`${label} body is not JSON`);
      return undefined;
    }
  };

  // ----- listLeads --------------------------------------------------------

  const list = async (route: Route, url: URL): Promise<void> => {
    requests.push(url);
    await gate;
    if (options.networkFailure === true) {
      return route.abort('internetdisconnected');
    }
    const params = url.searchParams;
    // T-0088 (lead edit, D-L138): the custom-field filters are checked on their own; the rest as declared.
    const problems = [
      ...validateQuery(withoutCustomFilters(params), LIST_PARAMETERS, 'listLeads'),
      // T-0091 (lead edit): with a custom-field setup the custom half checks them, below.
      ...(custom.configured ? [] : customFilterProblems(params)),
    ];
    if (problems.length > 0) {
      violations.push(...problems.map((problem) => `${url.search}: ${problem}`));
      return fulfil(route, 400, validation(problems.map(() => ({ path: 'query', code: 'invalid_string' }))));
    }

    const withheldAnywhere = new Set(rows.flatMap((row) => row.withheldFields));
    // This view IS a filter on status: withheld anywhere, no rows are ever returned.
    if (withheldAnywhere.has('status')) {
      return fulfil(route, 400, validation([{ path: 'status', code: 'field_withheld' }]));
    }
    const refused = Object.entries(FILTER_FIELD)
      .filter(([parameter, field]) => params.has(parameter) && withheldAnywhere.has(field))
      .map(([parameter]) => ({ path: parameter, code: 'field_withheld' }));
    const customKeys = [...new Set([...customEquals(params).map(([key]) => key), ...params.getAll('customEmpty')])];
    refused.push(
      ...customKeys
        .filter((key) => withheldAnywhere.has(`custom.${key}`))
        .map((key) => ({ path: `custom.${key}`, code: 'field_withheld' })),
    );
    if (refused.length > 0) {
      return fulfil(route, 400, validation(refused));
    }
    if (custom.configured) {
      const customRefused = custom.checkFilters('contact', params, programmes.map((programme) => programme.id), `listLeads ${url.search}`);
      if (customRefused !== undefined) {
        return fulfil(route, customRefused.status, customRefused.body);
      }
    }
    const customMatch = (row: ContactRow): boolean =>
      custom.configured ? custom.matches('contact', row.id, row.programmeId, params) : matchesCustom(row, params);

    const matching = sortRows(
      rows.filter(
        (row) => isLead(row) && matchesQuery(row, params.get('q')) && matchesFilters(row, params) && customMatch(row),
      ),
      params.get('sort') ?? '-createdAt',
    );

    let start = 0;
    const cursor = params.get('cursor');
    if (cursor !== null) {
      const boundTo = issued.get(cursor);
      if (boundTo === undefined) {
        violations.push(`cursor "${cursor}" was never served — it must be echoed, not built`);
        return fulfil(route, 400, errorExample('ValidationFailed', 'badCursor'));
      }
      if (boundTo.query !== queryKey(params)) {
        violations.push(`cursor reused with a different query: served for "${boundTo.query}", sent with "${queryKey(params)}"`);
        return fulfil(route, 400, errorExample('ValidationFailed', 'badCursor'));
      }
      start = boundTo.start;
    }

    const data = matching.slice(start, start + pageSize).map(serve);
    const nextCursor = matching.length > start + pageSize ? mint(queryKey(params), start + pageSize) : null;
    return fulfil(route, 200, { data, nextCursor });
  };

  // ----- getContact -------------------------------------------------------

  const getContact = (route: Route, id: string): Promise<void> => {
    const row = rows.find((candidate) => candidate.id === id);
    if (!servedVersion.has(id) || row === undefined) {
      violations.push(`getContact named ${id}, which the screen was never served`);
      return fulfil(route, 404, errorExample('NotFound'));
    }
    return fulfil(route, 200, serve(row));
  };

  // ----- updateContact: the Kanban move ------------------------------------

  const update = async (route: Route, request: Request, id: string): Promise<void> => {
    const body = readBody(request, 'updateContact');
    updates.push({ id, body });
    await writeGate;
    const row = rows.find((candidate) => candidate.id === id);
    if (!servedVersion.has(id) || row === undefined) {
      violations.push(`updateContact named ${id}, which the screen was never served`);
      return fulfil(route, 404, errorExample('NotFound'));
    }
    const keys = isJson(body) ? Object.keys(body).sort() : [];
    if (keys.join(',') !== 'status,version') {
      violations.push(
        `updateContact sent {${keys.join(', ')}}: a Leads move is exactly { version, status }, never a round trip of the row`,
      );
      return fulfil(route, 400, validation([{ path: 'body', code: 'invalid_string' }]));
    }
    const sent = body as { version: unknown; status: unknown };

    if (role === 'reader') {
      return fulfil(route, 403, forbidden());
    }
    // The claimer's narrow grant (D-P14, D-P18) covers { version, status }; the
    // exact-keys rule above already refused anything wider.
    if (row.withheldFields.includes('status')) {
      violations.push(`updateContact moved ${id}, whose status the row withholds from the caller`);
      return fulfil(route, 403, forbidden([{ path: 'status', code: 'field_not_editable' }]));
    }
    const problems = validateBody(body, UPDATE_SCHEMA, '');
    if (problems.length > 0) {
      violations.push(...problems.map((problem) => `updateContact: ${problem}`));
      return fulfil(route, 400, validation(problems.map(() => ({ path: 'body', code: 'invalid_string' }))));
    }
    if (typeof sent.status !== 'string' || !LEAD_STATUSES.includes(sent.status)) {
      violations.push(`updateContact set status ${String(sent.status)}: a Leads move is to a lead status only`);
      return fulfil(route, 400, validation([{ path: 'status', code: 'invalid_enum_value' }]));
    }
    if (sent.status === row.status) {
      violations.push(`updateContact moved ${id} to "${sent.status}", the column it was already in: nothing to write`);
      return fulfil(route, 400, validation([{ path: 'status', code: 'invalid_enum_value' }]));
    }
    if (sent.version !== servedVersion.get(id)) {
      violations.push(
        `updateContact sent version ${String(sent.version)} for ${id}; the screen was last served ${String(servedVersion.get(id))}`,
      );
    }
    if (sent.version !== row.version || options.refuseUpdate === 'stale_write') {
      return fulfil(route, 409, errorExample('StaleWrite'));
    }
    writeCount += 1;
    row.status = sent.status;
    row.version += 1;
    row.updatedAt = serverTime(writeCount);
    return fulfil(route, 200, serve(row));
  };

  // ----- convertContact ---------------------------------------------------

  const convert = async (route: Route, request: Request, id: string): Promise<void> => {
    const body = readBody(request, 'convertContact');
    converts.push({ id, body });
    await writeGate;
    const row = rows.find((candidate) => candidate.id === id);
    if (!servedVersion.has(id) || row === undefined) {
      violations.push(`convertContact named ${id}, which the screen was never served`);
      return fulfil(route, 404, errorExample('NotFound'));
    }
    // Without contact.write (claimer, reader): 403 before the body is read.
    if (role !== 'writer') {
      return fulfil(route, 403, forbidden());
    }
    const locked = ['status', 'accountId'].filter((field) => row.withheldFields.includes(field));
    if (locked.length > 0) {
      violations.push(
        `convertContact on ${id}, whose ${locked.join(' and ')} the row withholds: the screen was told it cannot convert it`,
      );
      return fulfil(route, 403, forbidden(locked.map((path) => ({ path, code: 'field_not_editable' }))));
    }
    const problems = validateBody(body, CONVERT_SCHEMA, '');
    if (problems.length > 0 || !isJson(body)) {
      violations.push(...problems.map((problem) => `convertContact: ${problem}`));
      return fulfil(route, 400, validation(problems.map(() => ({ path: 'body', code: 'invalid_string' }))));
    }
    const requested = typeof body.accountId === 'string' ? body.accountId : undefined;
    const newName = isJson(body.newAccount) ? String(body.newAccount.name) : undefined;

    let target: AccountRow | undefined;
    if (requested !== undefined) {
      target = accounts.find((account) => account.id === requested);
      if (target === undefined || !servedAccounts.has(target.id)) {
        violations.push(`convertContact named account ${requested}, which the picker was never served`);
        return fulfil(route, 404, errorExample('NotFound'));
      }
      if (target.programmeId !== row.programmeId) {
        violations.push(
          `convertContact linked ${id} to account ${target.id} in another programme: the picker offers only the ` +
            "lead's programme's accounts (listAccounts: filter client-side on programmeId)",
        );
        return fulfil(route, 404, errorExample('NotFound'));
      }
    }
    if (options.refuseConvert === 'account_not_found') {
      return fulfil(route, 404, errorExample('NotFound'));
    }

    // The exact-repeat rule: already in place answers 200, whatever version, and writes nothing.
    const current = row.accountId === null ? undefined : accounts.find((account) => account.id === row.accountId);
    const converted = row.status === 'qualified' || row.status === 'customer';
    const inPlace =
      converted &&
      current !== undefined &&
      (target !== undefined ? current.id === target.id : current.name === newName);
    if (inPlace && current !== undefined) {
      repeatCount += 1;
      return fulfil(route, 200, { contact: serve(row), account: serveAccount(current) });
    }

    if (options.refuseConvert === 'stale_write') {
      return fulfil(route, 409, errorExample('StaleWrite'));
    }
    if (body.version !== row.version) {
      if (body.version !== servedVersion.get(id)) {
        violations.push(
          `convertContact sent version ${String(body.version)} for ${id}; the screen was last served ${String(servedVersion.get(id))}`,
        );
      }
      return fulfil(route, 409, errorExample('StaleWrite'));
    }
    if (options.refuseConvert === 'already_linked' || row.accountId !== null) {
      return fulfil(
        route,
        400,
        validation([{ path: requested !== undefined ? 'accountId' : 'newAccount', code: 'already_linked' }]),
      );
    }

    writeCount += 1;
    if (target === undefined) {
      target = {
        id: NEW_ACCOUNT_IDS[createdAccounts.length] ?? NEW_ACCOUNT_IDS[0] ?? '',
        programmeId: row.programmeId,
        name: newName ?? '',
        version: 1,
        ownerUserId: null,
        owner: null,
        industry: null,
        tier: null,
        tags: [],
        phones: [],
        state: null,
        lga: null,
        parentAccountId: null,
        createdAt: serverTime(writeCount),
        updatedAt: serverTime(writeCount),
        withheldFields: [],
      };
      accounts.push(target);
      createdAccounts.push(target);
    }
    row.accountId = target.id;
    row.account = { id: target.id, name: target.name };
    if (row.status !== 'customer') {
      row.status = 'qualified';
    }
    row.version += 1;
    row.updatedAt = serverTime(writeCount);

    if (options.loseConvertResponse === true && !lostOne) {
      // Committed, and the answer never arrives. The screen still holds the old version.
      lostOne = true;
      return route.abort('failed');
    }
    return fulfil(route, 200, { contact: serve(row), account: serveAccount(target) });
  };

  // ----- listAccounts: the convert picker ---------------------------------

  const listAccounts = (route: Route, url: URL): Promise<void> => {
    accountRequests.push(url);
    const params = url.searchParams;
    const problems = validateQuery(params, ACCOUNT_LIST_PARAMETERS, 'listAccounts');
    if (params.has('cursor')) {
      problems.push('listAccounts was sent a cursor, and this mock never served one');
    }
    if (problems.length > 0) {
      violations.push(...problems.map((problem) => `${url.search}: ${problem}`));
      return fulfil(route, 400, validation(problems.map(() => ({ path: 'query', code: 'invalid_string' }))));
    }
    const q = params.get('q');
    const data = accounts
      .filter((account) => q === null || fold(account.name).includes(fold(q.trim())))
      .sort((a, b) => fold(a.name).localeCompare(fold(b.name)) || a.id.localeCompare(b.id))
      .map(serveAccount);
    return fulfil(route, 200, { data, nextCursor: null });
  };

  // ----- routing ----------------------------------------------------------

  await page.route(
    (url) => url.pathname === PROGRAMMES_PATH || url.pathname === ME_PATH,
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      checkHeaders(request, url.pathname);
      if (request.method() !== 'GET') {
        violations.push(`${request.method()} ${url.pathname} is not an operation`);
        return fulfil(route, 404, errorExample('NotFound'));
      }
      return url.pathname === ME_PATH
        ? fulfil(route, 200, clone(CURRENT_USER))
        : fulfil(route, 200, { data: clone(programmes) });
    },
  );

  await page.route(
    (url) => url.pathname === CUSTOM_FIELDS_PATH,
    async (route) => {
      const request = route.request();
      checkHeaders(request, 'listCustomFields');
      if (request.method() !== 'GET') {
        violations.push(`${request.method()} ${CUSTOM_FIELDS_PATH} is not an operation the Leads screen uses`);
        return fulfil(route, 404, errorExample('NotFound'));
      }
      return custom.answerList(route);
    },
  );

  await page.route(
    (url) =>
      url.pathname.startsWith(LEADS_PATH) || url.pathname.startsWith(CONTACTS_PATH) || url.pathname.startsWith(ACCOUNTS_PATH),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      checkHeaders(request, `${method} ${url.pathname}`);

      if (url.pathname === LEADS_PATH && method === 'GET') {
        return list(route, url);
      }
      if (url.pathname === ACCOUNTS_PATH && method === 'GET') {
        return listAccounts(route, url);
      }
      if (url.pathname === ACCOUNTS_PATH && method === 'POST') {
        violations.push(
          'createAccount was called: convert creates the account itself (newAccount). Create-then-link is two ' +
            'transactions and two audit events where D-P17 says one',
        );
        return fulfil(route, 404, errorExample('NotFound'));
      }
      if (url.pathname === CONTACTS_PATH && method === 'GET') {
        violations.push(
          'listContacts was called: leads are read from listLeads only (D-L75 — an older server ignores a status ' +
            'filter on listContacts and lists customers as leads)',
        );
        return fulfil(route, 404, errorExample('NotFound'));
      }
      const record = /^\/api\/v1\/contacts\/([^/]+)(\/convert)?$/.exec(url.pathname);
      const id = record?.[1] ?? '';
      if (record !== null && UUID_PATTERN.test(id)) {
        if (record[2] === undefined && method === 'GET') {
          return getContact(route, id);
        }
        if (record[2] === undefined && method === 'PATCH') {
          return update(route, request, id);
        }
        if (record[2] === '/convert' && method === 'POST') {
          return convert(route, request, id);
        }
      }
      violations.push(`${method} ${url.pathname} is not an operation the Leads screen uses`);
      return fulfil(route, 404, errorExample('NotFound'));
    },
  );

  return {
    requests,
    accountRequests,
    updates,
    converts,
    violations,
    rows,
    createdAccounts,
    repeats: () => repeatCount,
    issuedCursors: () => [...issued.keys()],
    custom,
    release: () => release(),
    releaseWrites: () => releaseWrites(),
  };
}
