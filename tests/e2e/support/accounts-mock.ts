import type { Page, Request, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * The accounts half of `docs/api/records.openapi.yaml` — `listAccounts`,
 * `getAccount`, `createAccount`, `updateAccount`, `listAccountContacts`,
 * `getAccountMap` — plus `listMyProgrammes`, served into the browser by
 * Playwright for T-0057 (the P04 Accounts screen).
 *
 * ---------------------------------------------------------------------------
 * READ FROM THE CONTRACT AT RUN TIME, LIKE records-mock.ts
 *
 * Parameter names, enums, bounds, the Account property list, the request-body
 * schemas and every error body come out of the YAML when this module loads.
 * There is no second copy to drift. `records-mock.ts` (T-0042) is pinned by
 * hash and is not touched; this file is its sibling for accounts.
 *
 * WHAT IS NOT IN THE CONTRACT, AND IS THEREFORE DECLARED HERE
 *
 *   - Rows. The contract publishes ONE example account (`Ọjà Foods Ltd`). The
 *     others are DERIVED from it by spreading it and overriding named
 *     properties, and every derived row is checked against the Account schema
 *     when this module loads (unknown property, missing required property, a
 *     withheld property still present, `owner` disagreeing with
 *     `ownerUserId`). Names, numbers and people are invented.
 *   - A second programme. `listMyProgrammes` publishes one; field security is
 *     per programme, so a second one is what lets a column be locked on one
 *     row and readable on the next.
 *   - A cursor. The accounts example has `nextCursor: null`, so the mock
 *     serves one invented opaque value, `ACCOUNT_CURSOR`. It carries no name
 *     (D-L80 is about the real API's cursors, not this one).
 *   - Who "me" is: `ME_USER_ID`, the example's owner.
 *
 * WHAT THE MOCK ENFORCES ON EVERY REQUEST (recorded as `violations`)
 *
 *   - listAccounts: every query parameter is declared, with a value its schema
 *     accepts (`programmeId`, `page`, `offset`, `total`, a free `sort` column
 *     and every other invention are violations); a cursor is echoed exactly as
 *     served and only with the q, filters and sort that produced it.
 *   - No request header names a programme or a tenant. Scope never travels
 *     from a client (CLAUDE.md 2.2).
 *   - createAccount and updateAccount bodies are validated against
 *     `CreateAccountRequest` / `UpdateAccountRequest`: closed, typed, bounded.
 *     On create the target programme must be one `listMyProgrammes` returned,
 *     and must be sent when the caller reaches more than one.
 *   - updateAccount must name a row the screen was served, send the `version`
 *     it was served, and send NO field the row lists in `withheldFields` (a
 *     form that round-trips every field would clear what it cannot read).
 *   - Any other method or path under `/api/v1/accounts` is a violation.
 *   - `getAccountMap` is answered 501 as the contract says, and every call is
 *     also recorded in `mapCalls`: the screen hides the Map view, so it never
 *     calls it.
 *
 * Server behaviour the screen depends on and an example cannot show is
 * implemented as the contract describes it: `q` is a case- and
 * diacritic-insensitive substring of `name`; filters are any-of; a filter on a
 * field withheld from ANY served row is `400 field_withheld` naming the
 * parameter; `sort` orders by its key with ties on `id`; created and updated
 * rows go back through the same withholding as a read.
 *
 * PAGING: AT MOST THREE ROWS PER PAGE, WHATEVER `limit` SAYS. Legal under the
 * contract (keyset pages need not be full), and deliberate: a screen that
 * decides "last page" from `data.length < limit` instead of from `nextCursor`
 * shows no way to the second page here, and fails.
 * ---------------------------------------------------------------------------
 */

export const RECORDS_CONTRACT_SOURCE = 'docs/api/records.openapi.yaml';

const repoRoot = resolve(__dirname, '..', '..', '..');

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function at(node: unknown, ...path: string[]): unknown {
  let current: unknown = node;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) {
      throw new Error(`${RECORDS_CONTRACT_SOURCE}: nothing at ${path.join('.')}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) {
    throw new Error(`${RECORDS_CONTRACT_SOURCE}: nothing at ${path.join('.')}`);
  }
  return current;
}

const CONTRACT: unknown = parse(readFileSync(resolve(repoRoot, RECORDS_CONTRACT_SOURCE), 'utf8'));

/** Follows a local `$ref`. A ref into another file is returned unresolved. */
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

const ACCOUNTS_PATH = '/api/v1/accounts';
const PROGRAMMES_PATH = '/api/v1/me/programmes';

const LIST = at(CONTRACT, 'paths', ACCOUNTS_PATH, 'get');
const LIST_EXAMPLE = at(LIST, 'responses', '200', 'content', 'application/json', 'example');

export interface AccountRow {
  id: string;
  programmeId: string;
  name: string;
  version: number;
  withheldFields: string[];
  [property: string]: unknown;
}

/** The contract's example account, verbatim: `Ọjà Foods Ltd`, nothing withheld. */
export const ACCOUNT_EXAMPLE = clone(at(LIST_EXAMPLE, 'data', '0')) as AccountRow;

/** Every property an Account may carry. A column the screen shows must be one of these. */
export const ACCOUNT_PROPERTIES: readonly string[] = Object.keys(at(schema('Account'), 'properties') as Json);

const ACCOUNT_REQUIRED = at(schema('Account'), 'required') as string[];

/** The tier codes. Labels are i18n; a code is never drawn. */
export const ACCOUNT_TIERS: readonly string[] = (at(schema('AccountTier'), 'enum') as unknown[]).map(String);

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

/** `listAccounts` query parameters, `$ref`s followed. */
export const LIST_PARAMETERS: readonly ParameterSpec[] = parametersOf(LIST);

/** What P04's chips may send: every declared parameter that is not search, sort or paging. */
export const FILTER_PARAMETERS: readonly string[] = LIST_PARAMETERS.map((p) => p.name).filter(
  (name) => !['q', 'sort', 'cursor', 'limit'].includes(name),
);

/** The values a parameter's schema enumerates (array items or a scalar enum). */
export function parameterEnum(name: string): readonly string[] {
  const spec = LIST_PARAMETERS.find((parameter) => parameter.name === name)?.schema ?? {};
  const items = spec.type === 'array' ? (deref(spec.items) as Json) : spec;
  return Array.isArray(items.enum) ? items.enum.map(String) : [];
}

/** `sort`'s enum. Every key is a field field security never withholds. */
export const SORT_VALUES: readonly string[] = parameterEnum('sort');

/** The Account properties a list may be ordered by: the `sort` keys, sign dropped. */
export const SORTABLE_FIELDS: readonly string[] = [...new Set(SORT_VALUES.map((value) => value.replace(/^-/, '')))];

/** Which Account property each filter parameter reads. A filter on a withheld one is 400. */
export const FILTER_FIELD: Readonly<Record<string, string>> = {
  owner: 'ownerUserId',
  tier: 'tier',
  industry: 'industry',
  tag: 'tags',
  state: 'state',
  lga: 'lga',
};

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

/** The contract's own example programme (`Bank X Collections`), the example account's. */
export const PROGRAMME_ONE = clone(
  at(CONTRACT, 'paths', PROGRAMMES_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', '0'),
) as Programme;

/** A second programme in the same tenant. Field security differs per programme. */
export const PROGRAMME_TWO: Programme = {
  id: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a02',
  name: 'Lagos Water Customer Care',
};

const exampleOwner = ACCOUNT_EXAMPLE.owner as { id: string; displayName: string };

/** The caller. `owner=me` means this user; it is the example account's owner. */
export const ME_USER_ID = exampleOwner.id;

export const OTHER_OWNER = { id: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02', displayName: 'Tunde Adeyemi' } as const;

const OWNERS: Readonly<Record<string, string>> = {
  [exampleOwner.id]: exampleOwner.displayName,
  [OTHER_OWNER.id]: OTHER_OWNER.displayName,
};

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

/** createAccount's request example (`Kano Grains Co.`), the name the create journey types. */
export const CREATE_EXAMPLE = clone(
  at(CONTRACT, 'paths', ACCOUNTS_PATH, 'post', 'requestBody', 'content', 'application/json', 'example'),
) as Json & { name: string };

/** The id the mock gives the account the screen creates. */
export const NEW_ACCOUNT_ID = '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c10';

function checkRow(row: AccountRow): AccountRow {
  const unknown = Object.keys(row).filter((key) => !ACCOUNT_PROPERTIES.includes(key));
  const missing = ACCOUNT_REQUIRED.filter((key) => !(key in row));
  // Omitted, never nulled: a withheld property must be ABSENT from the row.
  const leaked = row.withheldFields.filter((field) => field in row);
  const ownerWithheld = row.withheldFields.includes('ownerUserId') !== row.withheldFields.includes('owner');
  const owner = row.owner as { id?: string } | null | undefined;
  const ownerMismatch =
    'ownerUserId' in row && (row.ownerUserId === null ? owner !== null : owner?.id !== row.ownerUserId);
  if (unknown.length > 0 || missing.length > 0 || leaked.length > 0 || ownerWithheld || ownerMismatch) {
    throw new Error(
      `account row ${row.id} disagrees with ${RECORDS_CONTRACT_SOURCE}: ` +
        `unknown ${unknown.join(',') || '-'}; missing ${missing.join(',') || '-'}; ` +
        `withheld but present ${leaked.join(',') || '-'}; ` +
        `owner and ownerUserId ${ownerWithheld ? 'withheld apart' : ownerMismatch ? 'disagree' : 'agree'}`,
    );
  }
  return row;
}

function derive(
  overrides: Partial<AccountRow> & { id: string; name: string },
  withheld: readonly string[] = [],
): AccountRow {
  const row: AccountRow = { ...clone(ACCOUNT_EXAMPLE), ...overrides, withheldFields: [...withheld] };
  for (const field of withheld) {
    delete row[field];
  }
  return checkRow(row);
}

function ownedBy(id: string | null): { ownerUserId: string | null; owner: { id: string; displayName: string } | null } {
  if (id === null) {
    return { ownerUserId: null, owner: null };
  }
  return { ownerUserId: id, owner: { id, displayName: OWNERS[id] ?? 'unknown' } };
}

/**
 * Same programme as the example; every nullable property NULL and every list
 * empty. Null is "no value": never a lock. Its parent is the example account,
 * so a parent drawn as an id is caught.
 */
export const ROW_NULLS = derive({
  id: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c02',
  name: 'Delta Fisheries Ltd',
  version: 1,
  ...ownedBy(null),
  industry: null,
  tier: null,
  tags: [],
  phones: [],
  state: null,
  lga: null,
  parentAccountId: ACCOUNT_EXAMPLE.id,
  createdAt: '2026-10-02T08:00:00.000Z',
  updatedAt: '2026-10-02T08:00:00.000Z',
});

/**
 * In PROGRAMME_TWO, whose permission sets withhold `industry` and `phones`:
 * OMITTED from the row and named in `withheldFields`. Because a served row
 * withholds `industry`, the industry filter answers `400 field_withheld`.
 */
export const ROW_LOCKED = derive(
  {
    id: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c03',
    programmeId: PROGRAMME_TWO.id,
    name: 'Ibadan Haulage Ltd',
    version: 4,
    ...ownedBy(OTHER_OWNER.id),
    tier: 'enterprise',
    tags: ['Key account'],
    state: 'Oyo',
    lga: 'Ibadan North',
    createdAt: '2026-09-28T11:30:00.000Z',
    updatedAt: '2026-10-04T16:20:00.000Z',
  },
  ['industry', 'phones'],
);

/** Only ever on the second page under the default sort; first under `-name`. */
export const ROW_PAGE_TWO = derive({
  id: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c04',
  name: 'Zaria Textiles Ltd',
  version: 1,
  ...ownedBy(ME_USER_ID),
  industry: 'Textiles',
  tier: 'sme',
  tags: ['Credit hold'],
  phones: [{ type: 'work', e164: '+2348030000104' }],
  state: 'Kaduna',
  lga: 'Zaria',
  createdAt: '2026-09-30T07:45:00.000Z',
  updatedAt: '2026-09-30T07:45:00.000Z',
});

/**
 * In PROGRAMME_TWO under a stricter matrix: the owner (both `ownerUserId` and
 * `owner`, as the contract says) and the tier are withheld, on the same page as
 * the example whose owner and tier are readable. A screen that locks a whole
 * column from one row's `withheldFields` fails here.
 */
export const ROW_OWNER_LOCKED = derive(
  {
    id: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c05',
    programmeId: PROGRAMME_TWO.id,
    name: 'Jos Plateau Dairies',
    version: 3,
    industry: 'Dairy',
    tags: [],
    phones: [{ type: 'work', e164: '+2348030000105' }],
    state: 'Plateau',
    lga: 'Jos North',
    createdAt: '2026-09-29T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
  },
  ['ownerUserId', 'owner', 'tier'],
);

/** Markup in record data. It must be drawn as text, never parsed. */
export const HOSTILE_NAME = '<img src=x onerror="window.__kasuwaXss=1">Àdìsá & Sons <b>Ltd</b>';
export const HOSTILE_INDUSTRY = '<script>window.__kasuwaXss=2</script>';

export const ROW_HOSTILE = derive({
  id: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c06',
  name: HOSTILE_NAME,
  version: 1,
  industry: HOSTILE_INDUSTRY,
  tags: ['<i>VIP</i>'],
  createdAt: '2026-10-05T09:00:00.000Z',
  updatedAt: '2026-10-05T09:00:00.000Z',
});

export type AccountsScenario = 'default' | 'empty' | 'mixedWithheld' | 'hostile';

const DATASETS: Readonly<Record<AccountsScenario, readonly AccountRow[]>> = {
  default: [ACCOUNT_EXAMPLE, ROW_NULLS, ROW_LOCKED, ROW_PAGE_TWO],
  empty: [],
  mixedWithheld: [ACCOUNT_EXAMPLE, ROW_OWNER_LOCKED],
  hostile: [ROW_HOSTILE, ACCOUNT_EXAMPLE],
};

/** Every row a scenario can serve, for checks that compare rendered text to served data. */
export function scenarioRows(scenario: AccountsScenario): readonly AccountRow[] {
  return DATASETS[scenario];
}

export const PAGE_SIZE = 3;

/** The one cursor this mock serves: opaque, and carrying no name. */
export const ACCOUNT_CURSOR = 'eyJrIjoicDA0LWFjY291bnRzLXBhZ2UtMiJ9';

// ---------------------------------------------------------------------------
// Validation: query parameters, and request bodies against the contract
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** A JSON-Schema subset: exactly what the account request bodies use. */
function validateBody(value: unknown, raw: unknown, path: string): string[] {
  const spec = deref(raw) as Json;
  if (Array.isArray(spec.oneOf)) {
    const passing = spec.oneOf.filter((option) => validateBody(value, option, path).length === 0);
    return passing.length === 1 ? [] : [`${path || 'body'} matches ${passing.length} of oneOf, not exactly 1`];
  }
  const problems: string[] = [];
  if (spec.type !== undefined) {
    const allowed = (Array.isArray(spec.type) ? spec.type : [spec.type]).map(String);
    const actual = typeOf(value);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      return [`${path || 'body'} is ${actual}, not ${allowed.join('|')}`];
    }
  }
  if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
    problems.push(`${path} is not one of ${spec.enum.join(', ')}`);
  }
  if (typeof value === 'string') {
    if (typeof spec.minLength === 'number' && value.length < spec.minLength) problems.push(`${path} is too short`);
    if (typeof spec.maxLength === 'number' && value.length > spec.maxLength) problems.push(`${path} is too long`);
    if (typeof spec.pattern === 'string' && !new RegExp(spec.pattern).test(value)) {
      problems.push(`${path} does not match ${spec.pattern}`);
    }
    if (spec.format === 'uuid' && !UUID_PATTERN.test(value)) problems.push(`${path} is not a uuid`);
    if (value.includes('\u0000')) problems.push(`${path} carries a NUL`);
  }
  if (typeof value === 'number') {
    if (typeof spec.minimum === 'number' && value < spec.minimum) problems.push(`${path} is below ${spec.minimum}`);
  }
  if (Array.isArray(value)) {
    if (typeof spec.maxItems === 'number' && value.length > spec.maxItems) problems.push(`${path} has too many items`);
    value.forEach((item, index) => problems.push(...validateBody(item, spec.items ?? {}, `${path}.${index}`)));
  }
  if (isJson(value)) {
    const properties = (spec.properties ?? {}) as Json;
    for (const key of (spec.required ?? []) as string[]) {
      if (!(key in value)) problems.push(`${path ? `${path}.` : ''}${key} is required`);
    }
    if (typeof spec.minProperties === 'number' && Object.keys(value).length < spec.minProperties) {
      problems.push(`${path || 'body'} has fewer than ${spec.minProperties} properties`);
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

// ---------------------------------------------------------------------------
// Server behaviour
// ---------------------------------------------------------------------------

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function matchesQuery(row: AccountRow, q: string | null): boolean {
  return q === null || fold(row.name).includes(fold(q.trim()));
}

function matchesFilters(row: AccountRow, params: URLSearchParams): boolean {
  const anyOf = (name: string, read: unknown): boolean => {
    const wanted = params.getAll(name);
    if (wanted.length === 0) {
      return true;
    }
    const values = (Array.isArray(read) ? read : [read]).filter((v) => typeof v === 'string').map((v) => fold(String(v)));
    return wanted.some((item) => values.includes(fold(item)));
  };
  const owner = params.getAll('owner');
  const ownerOk =
    owner.length === 0 ||
    owner.some((value) =>
      value === 'unassigned'
        ? row.ownerUserId === null
        : (value === 'me' ? ME_USER_ID : value).toLowerCase() === String(row.ownerUserId).toLowerCase(),
    );
  return (
    ownerOk &&
    anyOf('tier', row.tier) &&
    anyOf('industry', row.industry) &&
    anyOf('tag', row.tags) &&
    anyOf('state', row.state) &&
    anyOf('lga', row.lga)
  );
}

function sortRows(rows: readonly AccountRow[], sort: string): AccountRow[] {
  const descending = sort.startsWith('-');
  const key = sort.replace(/^-/, '');
  const read = (row: AccountRow): string => (key === 'name' ? fold(row.name) : String(row[key] ?? ''));
  const sorted = [...rows].sort((a, b) => {
    const order = read(a).localeCompare(read(b)) || a.id.localeCompare(b.id);
    return descending ? -order : order;
  });
  return sorted;
}

/** q, filters and sort: what a cursor is bound to. */
function queryKey(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([name]) => name !== 'cursor' && name !== 'limit')
    .map(([name, value]) => `${name}=${value}`)
    .sort()
    .join('&');
}

/** Field security for a new row: whatever the dataset already withholds in that programme. */
function withheldIn(rows: readonly AccountRow[], programmeId: string): string[] {
  return [...new Set(rows.filter((row) => row.programmeId === programmeId).flatMap((row) => row.withheldFields))];
}

function withholding(row: AccountRow, withheld: readonly string[]): AccountRow {
  const copy: AccountRow = { ...clone(row), withheldFields: [...withheld] };
  for (const field of withheld) {
    delete copy[field];
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export type WriteRefusal = 'not_permitted' | 'field_not_editable' | 'stale_write';

export interface AccountsMockOptions {
  readonly scenario?: AccountsScenario;
  /** How many programmes `listMyProgrammes` returns. Default two: create must ask which. */
  readonly programmes?: 'one' | 'two';
  /** Hold every list response until `release()`. The loading state, without a clock. */
  readonly hold?: boolean;
  /** Abort every list request, as a dropped connection does. */
  readonly networkFailure?: boolean;
  /** Hold every write until `releaseWrites()`: the in-flight state of a save. */
  readonly holdWrites?: boolean;
  /** Answer every valid write with this refusal instead of applying it. */
  readonly refuse?: WriteRefusal;
}

export interface RecordedWrite {
  readonly method: 'POST' | 'PATCH';
  readonly path: string;
  readonly body: unknown;
}

export interface AccountsMock {
  /** Every `listAccounts` request, in order. */
  readonly requests: URL[];
  /** Every createAccount and updateAccount request, in order. */
  readonly writes: RecordedWrite[];
  /** Every `getAccountMap` call. The screen hides the Map view, so this stays empty. */
  readonly mapCalls: string[];
  /** `listMyProgrammes` calls. */
  readonly programmeCalls: string[];
  /** Contract breaches by the SCREEN. Must be empty at the end of every test. */
  readonly violations: string[];
  /** The rows as they now stand (writes applied), unwithheld. */
  readonly rows: AccountRow[];
  release(): void;
  releaseWrites(): void;
  /** The query of the last `listAccounts` request. */
  last(): URLSearchParams;
}

export function isListAccounts(request: Request): boolean {
  return request.method() === 'GET' && new URL(request.url()).pathname === ACCOUNTS_PATH;
}

export function isCreateAccount(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === ACCOUNTS_PATH;
}

export function isUpdateAccount(request: Request, id: string): boolean {
  return request.method() === 'PATCH' && new URL(request.url()).pathname === `${ACCOUNTS_PATH}/${id}`;
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

const ACCOUNT_CONTACTS_PARAMETERS = parametersOf(at(CONTRACT, 'paths', `${ACCOUNTS_PATH}/{accountId}/contacts`, 'get'));

const CREATE_SCHEMA = schema('CreateAccountRequest');
const UPDATE_SCHEMA = schema('UpdateAccountRequest');

const CREATED_AT = '2026-10-07T10:00:00.000Z';
const UPDATED_AT = '2026-10-07T10:05:00.000Z';

export async function installAccountsMock(page: Page, options: AccountsMockOptions = {}): Promise<AccountsMock> {
  const rows: AccountRow[] = DATASETS[options.scenario ?? 'default'].map((row) => clone(row));
  const programmes = options.programmes === 'one' ? [PROGRAMME_ONE] : [PROGRAMME_ONE, PROGRAMME_TWO];
  const requests: URL[] = [];
  const writes: RecordedWrite[] = [];
  const mapCalls: string[] = [];
  const programmeCalls: string[] = [];
  const violations: string[] = [];
  /** cursor -> the query it was served for */
  const issued = new Map<string, string>();

  let release: () => void = () => undefined;
  const gate = options.hold === true ? new Promise<void>((done) => (release = done)) : Promise.resolve();
  let releaseWrites: () => void = () => undefined;
  const writeGate =
    options.holdWrites === true ? new Promise<void>((done) => (releaseWrites = done)) : Promise.resolve();

  /** The rows a caller sees: each with its own programme's field security applied. */
  const served = (row: AccountRow): AccountRow => withholding(row, row.withheldFields);

  const checkHeaders = (request: Request, label: string): void => {
    for (const header of Object.keys(request.headers())) {
      if (/programme|tenant/i.test(header)) {
        violations.push(`${label} was sent a "${header}" header — scope is never supplied`);
      }
    }
  };

  const list = async (route: Route, url: URL): Promise<void> => {
    requests.push(url);
    await gate;
    if (options.networkFailure === true) {
      return route.abort('internetdisconnected');
    }
    const params = url.searchParams;
    const problems = validateQuery(params, LIST_PARAMETERS, 'listAccounts');
    if (problems.length > 0) {
      violations.push(...problems.map((problem) => `${url.search}: ${problem}`));
      return fulfil(route, 400, validation(problems.map(() => ({ path: 'query', code: 'invalid_string' }))));
    }

    // A filter on a field withheld in ANY programme the caller reaches is 400, never ignored.
    const withheldAnywhere = new Set(rows.flatMap((row) => row.withheldFields));
    const refused = Object.entries(FILTER_FIELD)
      .filter(([parameter, field]) => params.has(parameter) && withheldAnywhere.has(field))
      .map(([parameter]) => ({ path: parameter, code: 'field_withheld' }));
    if (refused.length > 0) {
      return fulfil(route, 400, validation(refused));
    }

    const matching = sortRows(
      rows.filter((row) => matchesQuery(row, params.get('q')) && matchesFilters(row, params)),
      params.get('sort') ?? 'name',
    );

    const cursor = params.get('cursor');
    let start = 0;
    if (cursor !== null) {
      const boundTo = issued.get(cursor);
      if (boundTo === undefined) {
        violations.push(`cursor "${cursor}" was never served — it must be echoed, not built`);
        return fulfil(route, 400, errorExample('ValidationFailed', 'badCursor'));
      }
      if (boundTo !== queryKey(params)) {
        violations.push(`cursor reused with a different query: served for "${boundTo}", sent with "${queryKey(params)}"`);
        return fulfil(route, 400, errorExample('ValidationFailed', 'badCursor'));
      }
      start = PAGE_SIZE;
    }

    const data = matching.slice(start, start + PAGE_SIZE).map(served);
    const more = matching.length > start + PAGE_SIZE;
    const nextCursor = more ? ACCOUNT_CURSOR : null;
    if (nextCursor !== null) {
      issued.set(nextCursor, queryKey(params));
    }
    return fulfil(route, 200, { data, nextCursor });
  };

  const refusal = (route: Route): Promise<void> | undefined => {
    switch (options.refuse) {
      case 'not_permitted':
        return fulfil(route, 403, errorExample('AccountNotPermitted', 'action'));
      case 'field_not_editable':
        return fulfil(route, 403, errorExample('AccountNotPermitted', 'field'));
      case 'stale_write':
        return fulfil(route, 409, errorExample('StaleWrite'));
      default:
        return undefined;
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

  const references = (programmeId: string, body: Json, selfId: string | null): { path: string; code: string }[] => {
    const details: { path: string; code: string }[] = [];
    if (typeof body.ownerUserId === 'string' && OWNERS[body.ownerUserId] === undefined) {
      details.push({ path: 'ownerUserId', code: 'unknown_reference' });
    }
    if (typeof body.parentAccountId === 'string') {
      const parent = rows.find((row) => row.id === body.parentAccountId && row.programmeId === programmeId);
      if (body.parentAccountId === selfId) {
        details.push({ path: 'parentAccountId', code: 'parent_cycle' });
      } else if (parent === undefined) {
        details.push({ path: 'parentAccountId', code: 'unknown_reference' });
      }
    }
    return details;
  };

  const create = async (route: Route, request: Request): Promise<void> => {
    const body = readBody(request, 'createAccount');
    writes.push({ method: 'POST', path: ACCOUNTS_PATH, body });
    await writeGate;
    const problems = validateBody(body, CREATE_SCHEMA, '');
    if (problems.length > 0 || !isJson(body)) {
      violations.push(...problems.map((problem) => `createAccount: ${problem}`));
      return fulfil(route, 400, validation(problems.map(() => ({ path: 'body', code: 'invalid_string' }))));
    }
    let programmeId = typeof body.programmeId === 'string' ? body.programmeId : undefined;
    if (programmeId === undefined) {
      if (programmes.length > 1) {
        violations.push('createAccount sent no programmeId, and the caller reaches more than one programme');
        return fulfil(route, 400, validation([{ path: 'programmeId', code: 'required' }]));
      }
      programmeId = PROGRAMME_ONE.id;
    }
    if (!programmes.some((programme) => programme.id === programmeId)) {
      violations.push(`createAccount targeted programme ${programmeId}, which listMyProgrammes never returned`);
      return fulfil(route, 404, errorExample('AccountNotFound'));
    }
    const refused = refusal(route);
    if (refused !== undefined) {
      return refused;
    }
    const withheld = withheldIn(rows, programmeId);
    const editedWithheld = Object.keys(body).filter((key) => withheld.includes(key));
    if (editedWithheld.length > 0) {
      const forbidden = errorExample('AccountNotPermitted', 'field');
      forbidden.details = editedWithheld.map((path) => ({ path, code: 'field_not_editable' }));
      return fulfil(route, 403, forbidden);
    }
    const unknown = references(programmeId, body, null);
    if (unknown.length > 0) {
      return fulfil(route, 400, validation(unknown));
    }
    const ownerId = typeof body.ownerUserId === 'string' ? body.ownerUserId : null;
    const row: AccountRow = {
      id: NEW_ACCOUNT_ID,
      programmeId,
      version: 1,
      name: String(body.name),
      ...ownedBy(ownerId),
      industry: body.industry ?? null,
      tier: body.tier ?? null,
      tags: body.tags ?? [],
      phones: body.phones ?? [],
      state: body.state ?? null,
      lga: body.lga ?? null,
      parentAccountId: body.parentAccountId ?? null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      withheldFields: withheld,
    };
    rows.push(row);
    return fulfil(route, 201, served(row));
  };

  const update = async (route: Route, request: Request, id: string): Promise<void> => {
    const body = readBody(request, 'updateAccount');
    writes.push({ method: 'PATCH', path: `${ACCOUNTS_PATH}/${id}`, body });
    await writeGate;
    const row = rows.find((candidate) => candidate.id === id);
    if (row === undefined) {
      violations.push(`updateAccount named ${id}, which the screen was never served`);
      return fulfil(route, 404, errorExample('AccountNotFound'));
    }
    const problems = validateBody(body, UPDATE_SCHEMA, '');
    if (problems.length > 0 || !isJson(body)) {
      violations.push(...problems.map((problem) => `updateAccount: ${problem}`));
      return fulfil(route, 400, validation(problems.map(() => ({ path: 'body', code: 'invalid_string' }))));
    }
    const sentWithheld = Object.keys(body).filter((key) => row.withheldFields.includes(key));
    if (sentWithheld.length > 0) {
      violations.push(`updateAccount sent ${sentWithheld.join(', ')}, which the row withholds from the caller`);
      const forbidden = errorExample('AccountNotPermitted', 'field');
      forbidden.details = sentWithheld.map((path) => ({ path, code: 'field_not_editable' }));
      return fulfil(route, 403, forbidden);
    }
    if (body.version !== row.version) {
      violations.push(`updateAccount sent version ${String(body.version)}; the screen was served ${row.version}`);
      return fulfil(route, 409, errorExample('StaleWrite'));
    }
    const refused = refusal(route);
    if (refused !== undefined) {
      return refused;
    }
    const unknown = references(row.programmeId, body, row.id);
    if (unknown.length > 0) {
      return fulfil(route, 400, validation(unknown));
    }
    for (const [key, value] of Object.entries(body)) {
      if (key === 'version') {
        continue;
      }
      if (key === 'ownerUserId') {
        Object.assign(row, ownedBy(typeof value === 'string' ? value : null));
        continue;
      }
      row[key] = value;
    }
    row.version += 1;
    row.updatedAt = UPDATED_AT;
    return fulfil(route, 200, served(row));
  };

  await page.route(
    (url) => url.pathname === PROGRAMMES_PATH,
    async (route) => {
      const request = route.request();
      checkHeaders(request, 'listMyProgrammes');
      programmeCalls.push(request.url());
      if (request.method() !== 'GET') {
        violations.push(`${request.method()} ${PROGRAMMES_PATH} is not an operation`);
        return fulfil(route, 404, errorExample('NotFound'));
      }
      return fulfil(route, 200, { data: clone(programmes) });
    },
  );

  await page.route(
    (url) => url.pathname === ACCOUNTS_PATH || url.pathname.startsWith(`${ACCOUNTS_PATH}/`),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      checkHeaders(request, `${method} ${url.pathname}`);

      if (url.pathname === ACCOUNTS_PATH && method === 'GET') {
        return list(route, url);
      }
      if (url.pathname === ACCOUNTS_PATH && method === 'POST') {
        return create(route, request);
      }
      if (url.pathname === `${ACCOUNTS_PATH}/map` && method === 'GET') {
        mapCalls.push(url.toString());
        return fulfil(route, 501, errorExample('NotImplemented'));
      }
      const record = /^\/api\/v1\/accounts\/([^/]+)(\/contacts)?$/.exec(url.pathname);
      const id = record?.[1] ?? '';
      if (record !== null && UUID_PATTERN.test(id)) {
        if (record[2] === '/contacts' && method === 'GET') {
          const problems = validateQuery(url.searchParams, ACCOUNT_CONTACTS_PARAMETERS, 'listAccountContacts');
          violations.push(...problems.map((problem) => `${url.search}: ${problem}`));
          const known = rows.some((row) => row.id === id);
          return known
            ? fulfil(route, 200, { data: [], nextCursor: null })
            : fulfil(route, 404, errorExample('AccountNotFound'));
        }
        if (record[2] === undefined && method === 'GET') {
          const row = rows.find((candidate) => candidate.id === id);
          return row === undefined ? fulfil(route, 404, errorExample('AccountNotFound')) : fulfil(route, 200, served(row));
        }
        if (record[2] === undefined && method === 'PATCH') {
          return update(route, request, id);
        }
      }
      violations.push(`${method} ${url.pathname} is not an operation in ${RECORDS_CONTRACT_SOURCE}`);
      return fulfil(route, 404, errorExample('AccountNotFound'));
    },
  );

  return {
    requests,
    writes,
    mapCalls,
    programmeCalls,
    violations,
    rows,
    release: () => release(),
    releaseWrites: () => releaseWrites(),
    last: () => {
      const latest = requests.at(-1);
      if (latest === undefined) {
        throw new Error('the screen has not called listAccounts');
      }
      return latest.searchParams;
    },
  };
}
