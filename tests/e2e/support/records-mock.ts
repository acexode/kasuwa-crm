import type { Page, Request, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { CUSTOM_FIELDS_PATH, CustomFieldsServer, type CustomFieldsSetup } from './custom-values-mock';

/**
 * The records API (`listContacts`), as `docs/api/records.openapi.yaml`
 * describes it, served into the browser by Playwright (T-0042).
 *
 * ---------------------------------------------------------------------------
 * READ FROM THE CONTRACT AT RUN TIME, NOT GENERATED INTO A FILE
 *
 * The admin and auth mocks are generated into a committed `.generated.ts` and
 * diffed for drift. This one parses the YAML every run instead: the example
 * row, the example `nextCursor`, the declared query parameters and their
 * enums, the Contact property names and the error bodies all come out of the
 * contract the moment the test starts. There is no second copy to drift.
 *
 * WHAT IS NOT IN THE CONTRACT, AND IS THEREFORE DECLARED HERE
 *
 * The contract publishes ONE example row. A list screen cannot be tested on
 * one row: paging needs a second page, and the "withheld is not null"
 * distinction needs a row whose fields are null next to a row whose fields
 * are withheld. So three rows are DERIVED from the example by spreading it and
 * overriding named properties (below, `derive`). Every derived row is checked
 * against the Contact schema when this module loads, so a property the
 * contract does not have fails here rather than in a screen. Names, numbers
 * and addresses are invented (`+234803000000N`, `@example.com`); none is a
 * real person.
 *
 * WHAT THE MOCK ENFORCES ON EVERY REQUEST (recorded as `violations`)
 *
 *   - Every query parameter is one `listContacts` declares, with a value its
 *     schema accepts. `programmeId`, `programmeIds`, `page`, `offset`,
 *     `total`, `includeTotal` and every other invention are violations. The
 *     session decides scope (CLAUDE.md rule 2) and the contract has no totals
 *     (D-P13), so a screen that sends either is wrong whatever it renders.
 *   - No request header names a programme. Scope never travels from a client.
 *   - A cursor is echoed back exactly as served and only with the same `q`,
 *     filters and `sort` that produced it (the contract's Cursor parameter).
 *
 * CUSTOM FIELDS (T-0091, lead edit): `listCustomFields` is answered here too,
 * by `custom-values-mock.ts`, because the screen reads its definitions with the
 * custom-fields flag on. With no `customFields` option the list is EMPTY and
 * the rows carry no `custom`, so the T-0042 journeys see the screen unchanged.
 * With one, rows carry their projected `custom` and `custom.<key>` paths, and
 * the `custom[<key>]` and `customEmpty` filters are checked and applied there.
 *
 * PAGING: AT MOST TWO ROWS PER PAGE, WHATEVER `limit` SAYS
 *
 * The contract promises keyset pages, `nextCursor: null` on the last one, and
 * nothing about pages being full. Serving two rows against a default `limit`
 * of 25 is therefore legal, and it is deliberate: a screen that decides "this
 * is the last page" from `data.length < limit` instead of from `nextCursor`
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

/** Follows a local `$ref`. A ref into another file (`./admin.openapi.yaml`) is returned unresolved. */
function deref(node: unknown): unknown {
  if (!isJson(node) || typeof node.$ref !== 'string' || !node.$ref.startsWith('#/')) {
    return node;
  }
  return deref(at(CONTRACT, ...node.$ref.slice(2).split('/')));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const LIST = at(CONTRACT, 'paths', '/api/v1/contacts', 'get');
const LIST_EXAMPLE = at(LIST, 'responses', '200', 'content', 'application/json', 'example');

export interface ContactRow {
  id: string;
  programmeId: string;
  displayName: string;
  withheldFields: string[];
  [property: string]: unknown;
}

/** The contract's example row, verbatim. It withholds `emails` and `accountId`. */
export const CONTACT_EXAMPLE = clone(at(LIST_EXAMPLE, 'data', '0')) as ContactRow;

/** The contract's example cursor, verbatim. The screen must echo exactly this. */
export const EXAMPLE_NEXT_CURSOR = at(LIST_EXAMPLE, 'nextCursor') as string;

/** Every property a Contact may carry. A column the screen shows must be one of these. */
export const CONTACT_PROPERTIES: readonly string[] = Object.keys(
  at(CONTRACT, 'components', 'schemas', 'Contact', 'properties') as Json,
);

const CONTACT_REQUIRED = at(CONTRACT, 'components', 'schemas', 'Contact', 'required') as string[];

interface ParameterSpec {
  name: string;
  schema: Json;
}

/** `listContacts` query parameters, `$ref`s followed. */
export const LIST_PARAMETERS: readonly ParameterSpec[] = (at(LIST, 'parameters') as unknown[]).map(
  (raw) => {
    const parameter = deref(raw) as Json;
    return { name: String(parameter.name), schema: (deref(parameter.schema) ?? {}) as Json };
  },
);

const PARAMETER_NAMES = new Set(LIST_PARAMETERS.map((parameter) => parameter.name));

/** The filters P04's chips may send: every declared parameter that is not search, sort or paging. */
export const FILTER_PARAMETERS: readonly string[] = LIST_PARAMETERS.map((p) => p.name).filter(
  (name) => !['q', 'sort', 'cursor', 'limit'].includes(name),
);

/** The values a parameter's schema enumerates (array items or a scalar enum). */
export function parameterEnum(name: string): readonly string[] {
  const schema = LIST_PARAMETERS.find((parameter) => parameter.name === name)?.schema ?? {};
  const items = schema.type === 'array' ? (deref(schema.items) as Json) : schema;
  return Array.isArray(items.enum) ? items.enum.map(String) : [];
}

/** The `code` values `listContacts` can answer with, read from its error responses. */
export function listErrorCodes(): string[] {
  const codes = new Set<string>();
  for (const [status, raw] of Object.entries(at(LIST, 'responses') as Json)) {
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
// The rows
// ---------------------------------------------------------------------------

const createExample = at(
  CONTRACT,
  'paths',
  '/api/v1/contacts',
  'post',
  'requestBody',
  'content',
  'application/json',
  'example',
) as Json;

/** A second programme in the same tenant. Field security is per programme, so it can differ per row. */
export const OTHER_PROGRAMME_ID = '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a02';

function derive(overrides: Partial<ContactRow> & { id: string; displayName: string }): ContactRow {
  const row = { ...clone(CONTACT_EXAMPLE), ...overrides };
  const unknown = Object.keys(row).filter((key) => !CONTACT_PROPERTIES.includes(key));
  const missing = CONTACT_REQUIRED.filter((key) => !(key in row));
  // Omitted, never nulled: a withheld property must be ABSENT from the row.
  const leaked = row.withheldFields.filter((field) => field in row);
  if (unknown.length > 0 || missing.length > 0 || leaked.length > 0) {
    throw new Error(
      `derived row ${row.id} disagrees with ${RECORDS_CONTRACT_SOURCE}: ` +
        `unknown ${unknown.join(',') || '-'}; missing ${missing.join(',') || '-'}; ` +
        `withheld but present ${leaked.join(',') || '-'}`,
    );
  }
  return row;
}

/**
 * Row B: same programme and same withheld fields as the example, but every
 * nullable column it shows is NULL. Null is "no value"; it must never be drawn
 * as a lock, and a withheld field must never be drawn as empty.
 */
export const ROW_NULLS = derive({
  id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e02',
  displayName: String(createExample.displayName),
  givenNames: null,
  familyName: null,
  phones: [{ type: 'mobile', e164: '+2348030000002' }],
  ownerUserId: null,
  status: null,
  source: String(createExample.source),
  tags: [],
  state: null,
  lga: null,
  dnd: true,
  whatsappOptIn: false,
  consentState: 'unknown',
  phoneNetwork: null,
});

/** Row C: only ever on the second page. */
export const ROW_PAGE_TWO = derive({
  id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e03',
  displayName: 'Amina Bello',
  givenNames: 'Amina',
  familyName: 'Bello',
  phones: [{ type: 'mobile', e164: '+2348030000003' }],
  status: 'qualified',
  source: 'ussd',
  tags: ['Billing'],
});

/**
 * Row D: in ANOTHER programme whose permission sets withhold nothing. Its email
 * is visible while the example row's, on the same page, is withheld — so a
 * screen that locks a whole column from the first row's `withheldFields` fails.
 */
export const ROW_VISIBLE_EMAIL = derive({
  id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e04',
  programmeId: OTHER_PROGRAMME_ID,
  displayName: 'Ngozi Eze',
  givenNames: 'Ngozi',
  familyName: 'Eze',
  phones: [{ type: 'mobile', e164: '+2348030000004' }],
  emails: ['ngozi.eze@example.com'],
  accountId: null,
  withheldFields: [],
});

export type RecordsScenario = 'default' | 'empty' | 'mixedWithheld';

const DATASETS: Readonly<Record<RecordsScenario, readonly ContactRow[]>> = {
  default: [CONTACT_EXAMPLE, ROW_NULLS, ROW_PAGE_TWO],
  empty: [],
  mixedWithheld: [CONTACT_EXAMPLE, ROW_VISIBLE_EMAIL],
};

/** Every row a scenario can serve, for checks that compare rendered text to served data. */
export function scenarioRows(scenario: RecordsScenario): readonly ContactRow[] {
  return DATASETS[scenario];
}

const PAGE_SIZE = 2;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateValue(name: string, value: string, schema: Json): string | undefined {
  const scalar = schema.type === 'array' ? (deref(schema.items) as Json) : schema;
  if (Array.isArray(scalar.enum) && !scalar.enum.map(String).includes(value)) {
    return `${name}=${value} is not one of ${scalar.enum.join(', ')}`;
  }
  if (scalar.type === 'boolean' && value !== 'true' && value !== 'false') {
    return `${name}=${value} is not a boolean`;
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

function validate(params: URLSearchParams): string[] {
  const problems: string[] = [];
  for (const name of new Set(params.keys())) {
    const spec = LIST_PARAMETERS.find((parameter) => parameter.name === name);
    if (spec === undefined || !PARAMETER_NAMES.has(name)) {
      problems.push(`listContacts declares no "${name}" parameter`);
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
      const problem = validateValue(name, value, spec.schema);
      if (problem !== undefined) {
        problems.push(problem);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Server behaviour the screens depend on and an example cannot show
// ---------------------------------------------------------------------------

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function digitsOf(text: string): string {
  return text.replace(/\D/g, '');
}

/** `0803…`, `234803…` and `+234 803…` all mean `+234803…` (the contract's `q`). */
function asNigerianE164Digits(text: string): string {
  const digits = digitsOf(text);
  return digits.startsWith('0') ? `234${digits.slice(1)}` : digits;
}

function matchesQuery(row: ContactRow, q: string): boolean {
  if (/^[\d\s+()-]+$/.test(q.trim()) && digitsOf(q).length >= 3) {
    const wanted = asNigerianE164Digits(q);
    const phones = Array.isArray(row.phones) ? (row.phones as { e164: string }[]) : [];
    return phones.some((phone) => digitsOf(phone.e164).includes(wanted));
  }
  const name = [row.displayName, row.givenNames, row.familyName].filter((part) => typeof part === 'string');
  return name.some((part) => fold(String(part)).includes(fold(q.trim())));
}

function matchesFilters(row: ContactRow, params: URLSearchParams): boolean {
  const anyOf = (name: string, read: (row: ContactRow) => unknown): boolean => {
    const wanted = params.getAll(name);
    if (wanted.length === 0) {
      return true;
    }
    const value = read(row);
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    return wanted.some((item) => values.map(fold).includes(fold(item)));
  };
  const flag = (name: string): boolean => {
    const wanted = params.get(name);
    return wanted === null || String(row[name] === true) === wanted;
  };
  const owner = params.getAll('owner');
  const ownerOk =
    owner.length === 0 ||
    owner.some((value) =>
      value === 'unassigned' ? row.ownerUserId === null : value !== 'me' && row.ownerUserId === value,
    );
  return (
    ownerOk &&
    anyOf('status', (r) => r.status) &&
    anyOf('source', (r) => r.source) &&
    anyOf('tag', (r) => r.tags) &&
    anyOf('state', (r) => r.state) &&
    anyOf('lga', (r) => r.lga) &&
    flag('dnd') &&
    flag('whatsappOptIn')
  );
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

export interface RecordsMockOptions {
  readonly scenario?: RecordsScenario;
  /** Hold every list response until `release()` is called. The loading state, without a clock. */
  readonly hold?: boolean;
  /** Abort every list request, as a dropped connection does. */
  readonly networkFailure?: boolean;
  /** Custom-field definitions, values and field security (T-0091). Absent: no definitions. */
  readonly customFields?: CustomFieldsSetup;
}

export interface RecordsMock {
  /** Every `listContacts` request, in order. */
  readonly requests: URL[];
  /** Calls to any other path under `/api/v1/contacts`. Answered `404`. */
  readonly otherCalls: string[];
  /** Contract breaches by the SCREEN. Must be empty at the end of every test. */
  readonly violations: string[];
  /** Lets held responses through. Safe to call more than once. */
  release(): void;
  /** The query of the last `listContacts` request. */
  last(): URLSearchParams;
  /** The custom-field half (T-0091): definition reads and stored values. */
  readonly custom: CustomFieldsServer;
}

export function isListContacts(request: Request): boolean {
  const url = new URL(request.url());
  return request.method() === 'GET' && url.pathname === '/api/v1/contacts';
}

function fulfil(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

export async function installRecordsMock(
  page: Page,
  options: RecordsMockOptions = {},
): Promise<RecordsMock> {
  const dataset = DATASETS[options.scenario ?? 'default'];
  const requests: URL[] = [];
  const otherCalls: string[] = [];
  const violations: string[] = [];
  const custom = new CustomFieldsServer(options.customFields, violations);
  const programmeIds = [...new Set(Object.values(DATASETS).flatMap((rows) => rows.map((row) => row.programmeId)))];
  /** cursor -> the query it was served for */
  const issued = new Map<string, string>();

  let release: () => void = () => undefined;
  const gate = options.hold === true ? new Promise<void>((done) => (release = done)) : Promise.resolve();

  await page.route(
    (url) => url.pathname === CUSTOM_FIELDS_PATH,
    async (route) => {
      if (route.request().method() !== 'GET') {
        violations.push(`${route.request().method()} ${CUSTOM_FIELDS_PATH} is not an operation the list uses`);
        return fulfil(route, 404, errorExample('NotFound'));
      }
      return custom.answerList(route);
    },
  );

  await page.route(
    (url) => url.pathname === '/api/v1/contacts' || url.pathname.startsWith('/api/v1/contacts/'),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());

      if (!isListContacts(request)) {
        otherCalls.push(`${request.method()} ${url.pathname}`);
        return fulfil(route, 404, errorExample('NotFound'));
      }

      requests.push(url);
      for (const header of Object.keys(request.headers())) {
        if (/programme/i.test(header)) {
          violations.push(`listContacts was sent a "${header}" header — scope is never supplied`);
        }
      }

      await gate;

      if (options.networkFailure === true) {
        return route.abort('internetdisconnected');
      }

      const params = url.searchParams;
      // T-0091: the custom-field filters are checked by the custom half; the rest as declared.
      const problems = validate(CustomFieldsServer.withoutFilters(params));
      if (problems.length > 0) {
        violations.push(...problems.map((problem) => `${url.search}: ${problem}`));
        const body = errorExample('ValidationFailed', 'badField');
        body.details = problems.map(() => ({ path: 'query', code: 'invalid_string' }));
        return fulfil(route, 400, body);
      }
      const refused = custom.checkFilters('contact', params, programmeIds, `listContacts ${url.search}`);
      if (refused !== undefined) {
        return fulfil(route, refused.status, refused.body);
      }

      const matching = dataset.filter(
        (row) =>
          matchesQuery(row, params.get('q') ?? '') &&
          matchesFilters(row, params) &&
          custom.matches('contact', row.id, row.programmeId, params),
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
          violations.push(
            `cursor reused with a different query: served for "${boundTo}", sent with "${queryKey(params)}"`,
          );
        }
        start = PAGE_SIZE;
      }

      const data = matching.slice(start, start + PAGE_SIZE);
      const more = matching.length > start + PAGE_SIZE;
      // One opaque cursor, the contract's own. Two pages is all a dataset here reaches.
      const nextCursor = more ? EXAMPLE_NEXT_CURSOR : null;
      if (nextCursor !== null) {
        issued.set(nextCursor, queryKey(params));
      }
      return fulfil(route, 200, {
        data: clone(data).map((row) => custom.decorate(row, 'contact', row.id, row.programmeId)),
        nextCursor,
      });
    },
  );

  return {
    requests,
    otherCalls,
    violations,
    custom,
    release: () => release(),
    last: () => {
      const latest = requests.at(-1);
      if (latest === undefined) {
        throw new Error('the screen has not called listContacts');
      }
      return latest.searchParams;
    },
  };
}
