import type { Page, Request, Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { TENANT_A } from '@kasuwa/db';
import { CUSTOM_FIELDS_PATH, CustomFieldsServer } from './custom-values-mock';

/**
 * The CSV import half of `docs/api/records.openapi.yaml` (tag `imports`,
 * T-0093: createImport, listImports, getImport, issueImportUploadUrls,
 * completeImportUpload, abortImportUpload, putImportMapping, runImport,
 * cancelImport), the object store the browser uploads to, and the reads the
 * import screen and its "open the imported contacts" link land on
 * (listContacts with `importId`, listMyProgrammes, getCurrentUser,
 * listCustomFields), served into the browser by Playwright for T-0096 (the
 * P28 import wizard).
 *
 * ---------------------------------------------------------------------------
 * READ FROM THE CONTRACT AT RUN TIME, AND EVERY REQUEST AND ANSWER CHECKED
 *
 * Schemas, enums, limits (`x-kasuwa-import-limits`), the compliance values
 * (`x-kasuwa-import-compliance`), the field vocabulary (`ImportField`), the
 * row-error codes and every error body come out of the YAML when this module
 * loads. The contract's own examples (`finished`, the list `page`) are served
 * verbatim, and must validate. EVERY body the mock answers with is validated
 * strictly against the schema the contract declares for that operation and
 * status: a property the schema does not name is a fault, so the mock can
 * never hand the screen a cell value, a sample, an "updated" count or a
 * download link the real API does not serve. A fault is the MOCK's, recorded
 * in `mockFaults`, which the spec's `afterEach` requires to be empty.
 *
 * WHAT IS NOT IN THE CONTRACT, AND IS THEREFORE DECLARED HERE
 *
 *   - The object store. Part URLs live on STORAGE_ORIGIN, the contract
 *     example's host, so every PUT is cross-origin as it is in a cell. The
 *     store answers like S3: an `ETag` header on a good part (exposed to the
 *     page with `Access-Control-Expose-Headers`), `403` with an XML body for
 *     an expired or wrongly sized part, `500` for a transient fault. Its error
 *     XML never names a key (D-L150).
 *   - The part plan (D-L160): min(4, ceil(size / 5 MiB)) parts, every part
 *     but the last exactly 5 MiB, or a quarter of the file when four parts of
 *     5 MiB would not hold it.
 *   - Programmes: PROGRAMME_ONE (the contract's own), where the caller holds
 *     `contact.import`, and PROGRAMME_TWO, which the session reaches but where
 *     the caller lacks it: createImport there is `403 not_permitted`, and no
 *     import of it is ever listed (reads never answer 403).
 *   - The caller: the contract's `createdByUserId`, a tenant member with
 *     `contact.import` and `contact.write` (D-L151).
 *   - The headers the server reads (no browser ever parses the file, so the
 *     header row is the SERVER's answer): `default` — First name, Last name,
 *     Mobile, Email, Status, DND, Notes; `noName` — Mobile, Branch, Notes,
 *     with no name field suggested.
 *   - The import history (newest first): the contract's finished example,
 *     one with 1,000 listed errors and more dropped, the contract's erased
 *     example, an erased import that still has row errors, a failed one (the
 *     creator lost the programme, D-L160) and a cancelled one.
 *   - The run: the job answers `queued` once, then `running` with growing
 *     counts, then its end, one step per getImport. The default run ends as
 *     the contract's finished example does.
 *
 * WHAT THE MOCK ENFORCES ON EVERY REQUEST (recorded as `violations`, the
 * SCREEN's fault; `afterEach` in the spec fails a test that has any)
 *
 *   - Only the operations above under `/api/v1/`; anything else is a
 *     violation. No request header names a programme, a tenant or a scope.
 *   - The API never carries file bytes (ADR-0017 item 4): no API request body
 *     over 64 KiB, none holding a CELL MARKER from the file, none holding a
 *     signed part URL. No API URL (path or query) holds the file's name.
 *   - createImport: the closed body, a programme from the session, and NEVER
 *     a declaration over `maxFileBytes` (the screen reads the published limit
 *     and refuses first: A1). A content type or filename the contract refuses
 *     is the API's `400`, not a violation.
 *   - The store: a PUT only to a URL the API issued and has not since
 *     replaced, exactly that URL, with exactly the part's size, carrying no
 *     `Authorization`, cookie, `x-kasuwa-*` or `x-requested-with` header (a
 *     signed URL is the only credential, and nothing of the session may leak
 *     to the bucket); never a part that already succeeded; never after the
 *     upload was aborted or completed; at most TWO parts in flight at once.
 *   - issueImportUploadUrls: never a part that already succeeded.
 *   - completeImportUpload: once, every part of the plan, ascending, each
 *     with the ETag the store returned for it.
 *   - putImportMapping: the closed body; never a column index beyond the
 *     headers or repeated; never a mapping that misses the required name
 *     (the screen's checklist blocks it); never a custom key the screen was
 *     not given a definition for; never a field after the API answered
 *     `403 field_not_editable` for it (it is read-only from then on);
 *     `ownerUserId` absent, null or the caller (there is no user directory,
 *     D-L64); never `fromImportId` naming an import whose headers are erased
 *     (the screen must not offer one). A repeated non-repeatable field is
 *     the API's `400 duplicate_mapping`, not a violation.
 *   - abort, run and cancel: no request body. runImport once per job, and
 *     only once the mapping is saved.
 *   - listImports: `cursor` and `limit` only. listContacts: only declared
 *     parameters.
 * ---------------------------------------------------------------------------
 */

export const RECORDS_CONTRACT_SOURCE = 'docs/api/records.openapi.yaml';
const AUTH_CONTRACT_SOURCE = 'docs/api/auth.openapi.yaml';
const ADMIN_CONTRACT_SOURCE = 'docs/api/admin.openapi.yaml';

const repoRoot = resolve(__dirname, '..', '..', '..');

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function load(source: string): unknown {
  return parse(readFileSync(resolve(repoRoot, source), 'utf8'));
}

const CONTRACT: unknown = load(RECORDS_CONTRACT_SOURCE);
const AUTH_CONTRACT: unknown = load(AUTH_CONTRACT_SOURCE);
const ADMIN_CONTRACT: unknown = load(ADMIN_CONTRACT_SOURCE);

const DOCUMENTS: Readonly<Record<string, unknown>> = {
  './records.openapi.yaml': CONTRACT,
  './auth.openapi.yaml': AUTH_CONTRACT,
  './admin.openapi.yaml': ADMIN_CONTRACT,
};

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

interface Located {
  node: unknown;
  doc: unknown;
}

function deref(node: unknown, doc: unknown): Located {
  if (!isJson(node) || typeof node.$ref !== 'string') {
    return { node, doc };
  }
  const [file, pointer] = node.$ref.split('#');
  const target = file === undefined || file === '' ? doc : DOCUMENTS[file];
  if (target === undefined || pointer === undefined) {
    throw new Error(`contract: cannot follow ${node.$ref}`);
  }
  return deref(at(target, ...pointer.slice(1).split('/')), target);
}

function schema(name: string): Json {
  return at(CONTRACT, 'components', 'schemas', name) as Json;
}

export const IMPORTS_PATH = '/api/v1/imports';
const CONTACTS_PATH = '/api/v1/contacts';
const PROGRAMMES_PATH = '/api/v1/me/programmes';
const ME_PATH = '/api/v1/auth/me';

const OP = {
  createImport: [IMPORTS_PATH, 'post'],
  listImports: [IMPORTS_PATH, 'get'],
  getImport: [`${IMPORTS_PATH}/{importId}`, 'get'],
  issueImportUploadUrls: [`${IMPORTS_PATH}/{importId}/upload-urls`, 'post'],
  completeImportUpload: [`${IMPORTS_PATH}/{importId}/complete`, 'post'],
  abortImportUpload: [`${IMPORTS_PATH}/{importId}/abort`, 'post'],
  putImportMapping: [`${IMPORTS_PATH}/{importId}/mapping`, 'put'],
  runImport: [`${IMPORTS_PATH}/{importId}/run`, 'post'],
  cancelImport: [`${IMPORTS_PATH}/{importId}/cancel`, 'post'],
  listContacts: [CONTACTS_PATH, 'get'],
  listMyProgrammes: [PROGRAMMES_PATH, 'get'],
  getCurrentUser: [ME_PATH, 'get'],
} as const;

export type Operation = keyof typeof OP;

/** The nine import operations, for the error-localisation check. */
export const IMPORT_OPERATIONS: readonly Operation[] = [
  'createImport',
  'listImports',
  'getImport',
  'issueImportUploadUrls',
  'completeImportUpload',
  'abortImportUpload',
  'putImportMapping',
  'runImport',
  'cancelImport',
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

// ---------------------------------------------------------------------------
// Validation: a JSON-Schema subset, exactly what these bodies and answers use
// ---------------------------------------------------------------------------

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/**
 * Problems with `value` against a schema. `strict` treats every object schema
 * that declares properties as closed: used on the mock's OWN answers. What
 * the screen sends is judged by the contract's own `additionalProperties`.
 */
export function validateBody(value: unknown, raw: unknown, path: string, doc: unknown = CONTRACT, strict = false): string[] {
  const located = deref(raw, doc);
  const spec = located.node as Json;
  const where = path || 'body';
  const problems: string[] = [];
  if (Array.isArray(spec.oneOf)) {
    const passing = spec.oneOf.filter((option) => validateBody(value, option, path, located.doc, strict).length === 0);
    if (passing.length !== 1) problems.push(`${where} matches ${passing.length} of oneOf, not exactly 1`);
  }
  if (Array.isArray(spec.anyOf)) {
    const passing = spec.anyOf.filter((option) => validateBody(value, option, path, located.doc, false).length === 0);
    if (passing.length === 0) problems.push(`${where} matches none of anyOf`);
  }
  if (Array.isArray(spec.allOf)) {
    for (const part of spec.allOf) problems.push(...validateBody(value, part, path, located.doc, false));
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
    if (typeof spec.minLength === 'number' && [...value].length < spec.minLength) problems.push(`${where} is too short`);
    if (typeof spec.maxLength === 'number' && [...value].length > spec.maxLength) problems.push(`${where} is too long`);
    if (typeof spec.pattern === 'string' && !new RegExp(spec.pattern, 'u').test(value)) problems.push(`${where} does not match ${spec.pattern}`);
    if (spec.format === 'uuid' && !UUID_PATTERN.test(value)) problems.push(`${where} is not a uuid`);
    if (spec.format === 'date-time' && !UTC_DATE_TIME.test(value)) problems.push(`${where} is not a UTC date-time with a Z`);
    if (spec.format === 'uri' && !/^https?:\/\/[^\s]+$/.test(value)) problems.push(`${where} is not a URI`);
  }
  if (typeof value === 'number') {
    if (typeof spec.minimum === 'number' && value < spec.minimum) problems.push(`${where} is below ${spec.minimum}`);
    if (typeof spec.maximum === 'number' && value > spec.maximum) problems.push(`${where} is above ${spec.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof spec.maxItems === 'number' && value.length > spec.maxItems) problems.push(`${where} has too many items`);
    if (typeof spec.minItems === 'number' && value.length < spec.minItems) problems.push(`${where} has too few items`);
    if (spec.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) problems.push(`${where} repeats an item`);
    if (spec.items !== undefined) {
      value.forEach((item, index) => problems.push(...validateBody(item, spec.items, `${path}.${index}`, located.doc, strict)));
    }
  }
  if (isJson(value) && (spec.properties !== undefined || spec.required !== undefined || spec.additionalProperties === false)) {
    const properties = (spec.properties ?? {}) as Json;
    for (const key of (spec.required ?? []) as string[]) {
      if (!(key in value)) problems.push(`${path ? `${path}.` : ''}${key} is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      const child = `${path ? `${path}.` : ''}${key}`;
      if (!(key in properties)) {
        if (spec.additionalProperties === false) problems.push(`${child} is not a property of this closed body`);
        else if (strict) problems.push(`${child} is not a property the contract declares`);
        continue;
      }
      problems.push(...validateBody(item, properties[key], child, located.doc, strict));
    }
  }
  return problems;
}

/** What is wrong with answering `operation` with `status` and `body`, judged strictly. */
export function answerProblems(operation: Operation, status: number, body: unknown): string[] {
  const [path, method] = OP[operation];
  const document = operation === 'getCurrentUser' ? AUTH_CONTRACT : CONTRACT;
  const responses = at(document, 'paths', path, method, 'responses') as Json;
  const declared = responses[String(status)];
  if (declared === undefined) return [`${operation} declares no ${status} response`];
  const response = deref(declared, document);
  const content = at(response.node, 'content', 'application/json', 'schema');
  return validateBody(body, content, `${operation} ${status}`, response.doc, true);
}

/** The `code`s an operation can answer with, read from its error responses' examples. */
export function errorCodes(operation: Operation): string[] {
  const [path, method] = OP[operation];
  const codes = new Set<string>();
  for (const [status, raw] of Object.entries(at(CONTRACT, 'paths', path, method, 'responses') as Json)) {
    if (status.startsWith('2')) continue;
    const json = at(deref(raw, CONTRACT).node, 'content', 'application/json') as Json;
    const examples = [json.example, ...Object.values((json.examples ?? {}) as Json).map((entry) => at(entry, 'value'))];
    for (const example of examples) {
      if (isJson(example) && typeof example.code === 'string') codes.add(example.code);
    }
  }
  return [...codes].sort();
}

/** The `details[].code`s an operation's error examples name. */
export function detailCodes(operation: Operation): string[] {
  const [path, method] = OP[operation];
  const codes = new Set<string>();
  for (const [status, raw] of Object.entries(at(CONTRACT, 'paths', path, method, 'responses') as Json)) {
    if (status.startsWith('2')) continue;
    const json = at(deref(raw, CONTRACT).node, 'content', 'application/json') as Json;
    const examples = [json.example, ...Object.values((json.examples ?? {}) as Json).map((entry) => at(entry, 'value'))];
    for (const example of examples) {
      for (const detail of (isJson(example) && Array.isArray(example.details) ? example.details : []) as unknown[]) {
        if (isJson(detail) && typeof detail.code === 'string') codes.add(detail.code);
      }
    }
  }
  return [...codes].sort();
}

function errorExample(response: string, name?: string): Json {
  const json = at(deref(at(CONTRACT, 'components', 'responses', response), CONTRACT).node, 'content', 'application/json') as Json;
  const body = name === undefined ? json.example : at(json.examples, name, 'value');
  return clone(body) as Json;
}

function refusal(response: string, name: string, details: readonly { path: string; code: string }[]): Json {
  const body = errorExample(response, name);
  body.details = details.map((detail) => ({ ...detail }));
  return body;
}

function parameterNames(operation: Operation): readonly string[] {
  const [path, method] = OP[operation];
  const own = (at(CONTRACT, 'paths', path, method) as Json).parameters;
  return ((Array.isArray(own) ? own : []) as unknown[]).map((raw) => String((deref(raw, CONTRACT).node as Json).name));
}

// ---------------------------------------------------------------------------
// The contract's own vocabularies and limits
// ---------------------------------------------------------------------------

const CREATE_OPERATION = at(CONTRACT, 'paths', IMPORTS_PATH, 'post') as Json;
const MAPPING_OPERATION = at(CONTRACT, 'paths', `${IMPORTS_PATH}/{importId}/mapping`, 'put') as Json;

/** `x-kasuwa-import-limits`: the numbers the screen and the server share. */
export const LIMITS = clone(at(CREATE_OPERATION, 'x-kasuwa-import-limits')) as {
  readonly maxFileBytes: number;
  readonly maxParts: number;
  readonly minPartBytes: number;
  readonly maxRows: number;
  readonly maxRowBytes: number;
  readonly maxColumns: number;
  readonly maxErrors: number;
};

/** `x-kasuwa-import-compliance`: the only values a mapped compliance column may write (D-L148). */
export const IMPORT_COMPLIANCE = clone(at(MAPPING_OPERATION, 'x-kasuwa-import-compliance')) as Readonly<Record<string, readonly unknown[]>>;
export const COMPLIANCE_FIELDS: readonly string[] = Object.keys(IMPORT_COMPLIANCE);

const IMPORT_FIELD = schema('ImportField');
/** The standard contact api names a column may set (ImportField's enum). */
export const IMPORT_FIELDS: readonly string[] = ((IMPORT_FIELD.anyOf as Json[])[0]?.enum as unknown[]).map(String);
export const CUSTOM_FIELD_PATTERN = new RegExp(String((IMPORT_FIELD.anyOf as Json[])[1]?.pattern));
export const ROW_ERROR_CODES: readonly string[] = (schema('ImportRowErrorCode').enum as unknown[]).map(String);
export const IMPORT_STATUSES: readonly string[] = (schema('ImportStatus').enum as unknown[]).map(String);
export const DEFAULT_COUNTRIES: readonly string[] = (schema('ImportDefaultCountry').enum as unknown[]).map(String);
export const CONTENT_TYPES: readonly string[] = (schema('ImportContentType').enum as unknown[]).map(String);

/** The fields more than one column may map (putImportMapping's description). */
export const REPEATABLE_FIELDS: readonly string[] = ['phones', 'emails', 'tags'];
/** Any one of these satisfies the required `displayName` (putImportMapping's description). */
export const NAME_FIELDS: readonly string[] = ['displayName', 'givenNames', 'familyName'];
/** Fields a column must never be offered: not ImportField members (R6 of the contract suite). */
export const NEVER_MAPPABLE: readonly string[] = ['id', 'programmeId', 'version', 'owner', 'ownerUserId', 'account', 'accountId', 'phoneNetwork', 'createdAt', 'updatedAt', 'custom', 'withheldFields'];

for (const field of NEVER_MAPPABLE) {
  if (IMPORT_FIELDS.includes(field)) throw new Error(`${RECORDS_CONTRACT_SOURCE}: ImportField now admits ${field}; T-0096's suite must be re-pinned`);
}

const FIVE_MIB = LIMITS.minPartBytes;

/** D-L160's part plan: min(4, ceil(size / 5 MiB)) parts, every part but the last at least 5 MiB. */
export function partPlan(sizeBytes: number): number[] {
  const count = Math.min(LIMITS.maxParts, Math.ceil(sizeBytes / FIVE_MIB));
  if (count <= 1) return [sizeBytes];
  const each = count * FIVE_MIB >= sizeBytes ? FIVE_MIB : Math.ceil(sizeBytes / count);
  const sizes = Array.from({ length: count - 1 }, () => each);
  sizes.push(sizeBytes - each * (count - 1));
  return sizes;
}

// ---------------------------------------------------------------------------
// The file: synthetic CSV with markers that must never leave the file
// ---------------------------------------------------------------------------

/**
 * Tokens written into the file's CELLS (never its header row). None may reach
 * the DOM, an API request, a URL, the console or device storage: the screen
 * never reads the file (no client-side parse or preview), the API never
 * carries its bytes (ADR-0017 item 4) and no cell value is ever shown.
 */
export const CELL_MARKERS: readonly string[] = ['Cellmarkzq Samplegiven', 'Cellmarkzq-Fixturefamily', 'cellmarkzq.fixture@example.test', 'Cellmarkzq branch note'];
/** The common prefix of every marker, for a single search. */
export const CELL_MARKER = 'ellmarkzq';

export const HEADERS: readonly string[] = ['First name', 'Last name', 'Mobile', 'Email', 'Status', 'DND', 'Notes'];
export const SUGGESTED: readonly (string | null)[] = ['givenNames', 'familyName', 'phones', 'emails', 'status', 'dnd', null];
export const NO_NAME_HEADERS: readonly string[] = ['Mobile', 'Branch', 'Notes'];
/**
 * A header is file content (a headerless CSV puts its first data row there),
 * so under `hostileHeaders` the last header carries markup. It must be drawn
 * as text, never parsed.
 */
export const HOSTILE_HEADER = 'Notes<img src=x onerror="window.__kasuwaXss=1"><b>bold</b>';
export const NO_NAME_SUGGESTED: readonly (string | null)[] = ['phones', null, null];

/**
 * A CSV of exactly `sizeBytes` bytes: the header row, then rows of synthetic
 * cells holding the CELL_MARKERS. Phones are PLACEHOLDERS (the contract's
 * `+234803000000x` form; Nigeria has no fictional range).
 */
export function csvFile(sizeBytes: number, headers: readonly string[] = HEADERS): Buffer {
  const head = `${headers.join(',')}\r\n`;
  const rows: string[] = [];
  let length = Buffer.byteLength(head);
  for (let index = 0; length < sizeBytes; index += 1) {
    const row = `${CELL_MARKERS[0]} ${index},${CELL_MARKERS[1]},+23480300000${String(index % 10)},${CELL_MARKERS[2]},customer,false,${CELL_MARKERS[3]}\r\n`;
    rows.push(row);
    length += Buffer.byteLength(row);
  }
  const whole = Buffer.from(head + rows.join(''), 'utf8');
  return whole.subarray(0, sizeBytes);
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Programmes, the caller and the history
// ---------------------------------------------------------------------------

export interface Programme {
  id: string;
  name: string;
}

export const PROGRAMME_ONE = clone(
  at(CONTRACT, 'paths', PROGRAMMES_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', '0'),
) as Programme;
/** The session reaches it; the caller lacks `contact.import` there. */
export const PROGRAMME_TWO: Programme = { id: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a02', name: 'Sample Fixture Care' };
const PROGRAMMES_ANSWER: Json = { data: [clone(PROGRAMME_ONE), clone(PROGRAMME_TWO)] };

const GET_EXAMPLES = at(CONTRACT, 'paths', `${IMPORTS_PATH}/{importId}`, 'get', 'responses', '200', 'content', 'application/json', 'examples') as Json;
/** The contract's `finished` example: a finished import with five row errors. */
export const FINISHED_EXAMPLE = clone(at(GET_EXAMPLES, 'finished', 'value')) as Json;
const LIST_EXAMPLE = clone(at(CONTRACT, 'paths', IMPORTS_PATH, 'get', 'responses', '200', 'content', 'application/json', 'examples', 'page', 'value')) as Json;

export const CALLER_ID = String(FINISHED_EXAMPLE.createdByUserId);
export const CURRENT_USER: Json = {
  id: CALLER_ID,
  tenantId: TENANT_A,
  email: 'sample.importer@example.test',
  displayName: 'Sample Importer Fixture',
  locale: 'en-NG',
};

const SUMMARY_KEYS = ['id', 'programmeId', 'status', 'filename', 'sizeBytes', 'counts', 'rawFileDeletedAt', 'createdByUserId', 'createdAt', 'updatedAt', 'finishedAt'];

function summaryOf(job: Json): Json {
  return Object.fromEntries(SUMMARY_KEYS.map((key) => [key, clone(job[key])]));
}

function historyJob(overrides: Json): Json {
  return {
    ...clone(FINISHED_EXAMPLE),
    suggestedMapping: null,
    errors: [],
    errorsTruncated: false,
    ...overrides,
  };
}

/** The contract's finished example, verbatim. */
export const H_FINISHED: Json = clone(FINISHED_EXAMPLE);

/** Finished, 1,000 errors listed (rows 2..1001, the cap) and more dropped. */
export const H_TRUNCATED: Json = historyJob({
  id: '5e1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6a06',
  filename: 'sample-truncated-errors.csv',
  sizeBytes: 902114,
  counts: { created: 300, skipped: 0, failed: 1450 },
  errors: Array.from({ length: LIMITS.maxErrors }, (_, index) => ({ row: index + 2, column: 2, code: 'invalid_phone' })),
  errorsTruncated: true,
  createdAt: '2026-10-17T15:00:00Z',
  updatedAt: '2026-10-17T15:06:00Z',
  finishedAt: '2026-10-17T15:06:00Z',
});

const LISTED_ERASED = clone((LIST_EXAMPLE.data as Json[])[1] ?? {});
/** The contract's erased example (filename and headers gone, D-L148), with no row errors. */
export const H_ERASED: Json = {
  ...clone(LISTED_ERASED),
  contentType: 'text/csv',
  headers: null,
  suggestedMapping: null,
  mapping: null,
  errors: [],
  errorsTruncated: false,
};

/**
 * Erased, but with row errors: a column is then shown by POSITION (there is no
 * header to name it). Column index 6 is the 7th column, `G` in a spreadsheet;
 * the row numbers (5, 9) hold neither digit.
 */
export const H_ERASED_ERRORS: Json = historyJob({
  id: '5e1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6a05',
  status: 'finished',
  filename: null,
  sizeBytes: 64210,
  headers: null,
  mapping: null,
  counts: { created: 40, skipped: 1, failed: 1 },
  errors: [
    { row: 5, column: null, code: 'possible_duplicate' },
    { row: 9, column: 6, code: 'invalid_value' },
  ],
  rawFileDeletedAt: '2026-10-12T08:00:00Z',
  createdAt: '2026-10-04T08:00:00Z',
  updatedAt: '2026-10-12T08:00:00Z',
  finishedAt: '2026-10-05T08:00:00Z',
});

/** Failed: the creator lost the programme mid-run (D-L160); counts so far kept, data cleared. */
export const H_FAILED: Json = historyJob({
  id: '5e1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6a07',
  status: 'failed',
  filename: null,
  sizeBytes: 220114,
  headers: null,
  mapping: null,
  counts: { created: 120, skipped: 0, failed: 0 },
  rawFileDeletedAt: '2026-10-03T10:00:00Z',
  createdAt: '2026-10-03T09:00:00Z',
  updatedAt: '2026-10-03T10:00:00Z',
  finishedAt: '2026-10-03T09:20:00Z',
});

/** Cancelled while running: contacts already created stay created. */
export const H_CANCELLED: Json = historyJob({
  id: '5e1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6a08',
  status: 'cancelled',
  filename: 'sample-cancelled.csv',
  sizeBytes: 310220,
  counts: { created: 400, skipped: 0, failed: 0 },
  createdAt: '2026-10-02T09:00:00Z',
  updatedAt: '2026-10-02T09:05:00Z',
  finishedAt: '2026-10-02T09:05:00Z',
});

/** Newest first, as listImports serves them. */
export const HISTORY: readonly Json[] = [H_FINISHED, H_TRUNCATED, H_ERASED, H_ERASED_ERRORS, H_FAILED, H_CANCELLED];

/** The mapping `fromImportId: H_FINISHED` resolves to on the default headers, by header name (Notes → tags is H_FINISHED's own choice). */
export const REUSED_MAPPING: Readonly<Record<string, string | null>> = {
  'First name': 'givenNames',
  'Last name': 'familyName',
  Mobile: 'phones',
  Email: 'emails',
  Status: 'status',
  DND: 'dnd',
  Notes: 'tags',
};

// The reusable history import's own headers and mapping, by name, so that
// fromImportId has something real to copy (the contract example's headers
// differ from the default upload's, which is the point of copying by name).
const REUSE_SOURCE: Json = {
  ...clone(H_FINISHED),
  headers: [...HEADERS],
  mapping: {
    columns: HEADERS.map((name, index) => ({ index, field: REUSED_MAPPING[name] ?? null })),
    defaultCountry: 'NG',
    ownerUserId: CALLER_ID,
  },
};

const CONTACTS_EXAMPLE = clone(at(CONTRACT, 'paths', CONTACTS_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example')) as Json;

// Load-time checks: the contract's examples are served verbatim, and everything stored validates.
function sameJson(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    isJson(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canonical(v)])) : Array.isArray(value) ? value.map(canonical) : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

if (!sameJson(summaryOf(H_FINISHED), (LIST_EXAMPLE.data as Json[])[0])) {
  throw new Error('the contract’s finished getImport example and its first listImports row disagree; re-pin the import mock');
}
if (!sameJson(summaryOf(H_ERASED), LISTED_ERASED)) {
  throw new Error('the erased history row no longer round-trips the contract’s listImports example');
}
for (const job of [...HISTORY, REUSE_SOURCE]) {
  const problems = answerProblems('getImport', 200, job);
  if (problems.length > 0) throw new Error(`history import ${String(job.id)} disagrees with ${RECORDS_CONTRACT_SOURCE}: ${problems.join('; ')}`);
  if (job.rawFileDeletedAt !== null && (job.headers !== null || job.filename !== null)) {
    throw new Error(`history import ${String(job.id)} keeps headers or a filename past its raw file (D-L148)`);
  }
  const counts = job.counts as { skipped: number; failed: number };
  const errors = job.errors as { code: string }[];
  if (job.errorsTruncated !== true && errors.filter((error) => error.code !== 'possible_duplicate').length !== counts.failed) {
    throw new Error(`history import ${String(job.id)}: counts.failed does not match its listed errors`);
  }
}
for (const [operation, body] of [
  ['listImports', { data: HISTORY.map(summaryOf), nextCursor: null }],
  ['listContacts', CONTACTS_EXAMPLE],
  ['listMyProgrammes', PROGRAMMES_ANSWER],
  ['getCurrentUser', CURRENT_USER],
] as const) {
  const problems = answerProblems(operation, 200, body);
  if (problems.length > 0) throw new Error(`the ${operation} answer disagrees with its contract: ${problems.join('; ')}`);
}

/** Everything the mock may serve as record data (filenames, headers, programme names), for the en-XA check. */
export function servedData(): string {
  return JSON.stringify({ history: [...HISTORY, REUSE_SOURCE], programmes: PROGRAMMES_ANSWER, headers: [HEADERS, NO_NAME_HEADERS], user: CURRENT_USER, contacts: CONTACTS_EXAMPLE });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface Counts {
  created: number;
  skipped: number;
  failed: number;
}

export interface RunPlan {
  /** One answer per getImport after runImport, in order. */
  readonly steps: readonly { readonly status: 'queued' | 'running'; readonly counts: Counts }[];
  /** Then this, for every later read. */
  readonly end: { readonly status: 'finished' | 'failed'; readonly counts: Counts; readonly errors: readonly Json[]; readonly errorsTruncated: boolean };
}

/** Ends as the contract's finished example does. Counts stay under 1,000 while running, so grouping shows only at the end. */
export const DEFAULT_RUN: RunPlan = {
  steps: [
    { status: 'queued', counts: { created: 0, skipped: 0, failed: 0 } },
    { status: 'running', counts: { created: 120, skipped: 0, failed: 1 } },
    { status: 'running', counts: { created: 480, skipped: 1, failed: 2 } },
    { status: 'running', counts: { created: 860, skipped: 2, failed: 2 } },
  ],
  end: {
    status: 'finished',
    counts: clone(FINISHED_EXAMPLE.counts) as Counts,
    errors: clone(FINISHED_EXAMPLE.errors) as Json[],
    errorsTruncated: false,
  },
};

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/** The contract example's storage host: every part PUT is cross-origin, as in a cell. */
export const STORAGE_ORIGIN = 'https://storage.example';

export interface ImportMockOptions {
  /** The headers the server reads after the upload. Default `default`. */
  readonly scenario?: 'default' | 'noName';
  /** Serve HOSTILE_HEADER as the last header of the default scenario. */
  readonly hostileHeaders?: boolean;
  /** `reading_header` answers before `awaiting_mapping`. Default 1. */
  readonly headerPolls?: number;
  /** Hold createImport until `releaseCreate()`. */
  readonly holdCreate?: boolean;
  /** Hold every part PUT until `releaseParts()`. */
  readonly holdParts?: boolean;
  /** Abort the first PUT of this part number, as a dropped connection does. */
  readonly failPartOnce?: number;
  /** Answer every PUT of this part number 500. */
  readonly failPartAlways?: number;
  /** createImport's URLs for this part number and later answer 403 "Request has expired". */
  readonly expireFromPart?: number;
  /** completeImportUpload answers 422 upload_mismatch. */
  readonly mismatch?: boolean;
  /** Fields the caller may not edit in the programme: a mapping carrying one is 403 field_not_editable. */
  readonly notEditable?: readonly string[];
  /** fromImportId answers 400 unknown_reference (the source was erased since the list was read). */
  readonly reuseRefused?: boolean;
  /** runImport answers 409 import_status_conflict (the job expired meanwhile). */
  readonly runConflict?: boolean;
  /** The run. Default DEFAULT_RUN. */
  readonly run?: RunPlan;
  /** Hold the n-th getImport after runImport (1-based) until `releasePoll()`. */
  readonly holdPoll?: number;
  /** Abort these getImport reads after runImport (1-based). */
  readonly failPolls?: readonly number[];
}

export interface ApiCall {
  readonly operation: Operation;
  readonly url: URL;
  readonly raw: string;
  readonly body: unknown;
  readonly at: number;
}

export interface PartPut {
  readonly importId: string;
  readonly partNumber: number;
  readonly url: string;
  readonly issue: number;
  readonly size: number;
  readonly at: number;
  outcome: 'pending' | 'ok' | 'expired' | 'failed' | 'aborted' | 'refused';
}

export interface Poll {
  readonly importId: string;
  readonly at: number;
  readonly phase: 'header' | 'run' | 'other';
  readonly status: string;
}

interface IssuedUrl {
  importId: string;
  partNumber: number;
  issue: number;
  sizeBytes: number;
  superseded: boolean;
  expired: boolean;
}

interface Job {
  record: Json;
  plan: number[];
  parts: Map<number, { etag: string; bytes: Buffer }>;
  issues: number;
  runPolls: number;
  headerPolls: number;
  runSent: number;
  completeSent: number;
  cancelRequested: boolean;
  refusedFields: Set<string>;
}

export interface ImportMock {
  /** Every /api/v1 request, in order. */
  readonly requests: URL[];
  /** Every import, contacts, programmes and user call, in order, with its body. */
  readonly calls: ApiCall[];
  /** Every PUT to the store, in order. */
  readonly partPuts: PartPut[];
  /** Every request to the store, any method, in order. */
  readonly storageRequests: string[];
  /** Every getImport, in order. */
  readonly polls: Poll[];
  /** listContacts reads (the report link's landing). */
  readonly contactReads: URL[];
  /** Contract breaches by the SCREEN. Must be empty at the end of every test. */
  readonly violations: string[];
  /** Answers the MOCK built that its contract rejects. Must be empty, always. */
  readonly mockFaults: string[];
  /** Part PUTs answered or abandoned so far, and those still open. */
  inFlight(): number;
  /** The most part PUTs ever open at once. */
  maxInFlight(): number;
  /** The bytes the store holds for an import, parts in order (empty until a part lands). */
  assembled(importId: string): Buffer;
  /** The current record of an import the screen created. */
  job(importId: string): Json | undefined;
  /** The id of every import the screen created, in order. */
  created(): string[];
  /** Calls of one operation. */
  callsOf(operation: Operation): ApiCall[];
  releaseCreate(): void;
  releaseParts(): void;
  releasePoll(): void;
}

function jobPath(pathname: string): { importId: string; action: string } | undefined {
  const match = /^\/api\/v1\/imports\/([^/]+)(?:\/([a-z-]+))?$/.exec(pathname);
  if (match === null) return undefined;
  return { importId: decodeURIComponent(match[1] ?? ''), action: match[2] ?? '' };
}

const S3_EXPIRED = '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>';
const S3_SIGNATURE = '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match the signature you provided.</Message></Error>';
const S3_INTERNAL = '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>InternalError</Code><Message>We encountered an internal error. Please try again.</Message></Error>';

/** The ids of jobs the screen creates, in order: never one of the history's. */
function newJobId(serial: number): string {
  return `5e1a2b3c-4d5e-4f60-8a1b-2c3d4e5f7${String(serial).padStart(3, '0')}`;
}

export async function installImportMock(page: Page, options: ImportMockOptions = {}): Promise<ImportMock> {
  const requests: URL[] = [];
  const calls: ApiCall[] = [];
  const partPuts: PartPut[] = [];
  const storageRequests: string[] = [];
  const polls: Poll[] = [];
  const contactReads: URL[] = [];
  const violations: string[] = [];
  const mockFaults: string[] = [];
  const jobs = new Map<string, Job>();
  const order: string[] = [];
  const issued = new Map<string, IssuedUrl>();
  const custom = new CustomFieldsServer(undefined, violations);
  const run = options.run ?? DEFAULT_RUN;
  const forbidden = new Set([PROGRAMME_TWO.id]);
  const reachable = new Set([PROGRAMME_ONE.id, PROGRAMME_TWO.id]);
  let open = 0;
  let maxOpen = 0;
  let serial = 0;

  const gate = (hold: boolean | undefined): { promise: Promise<void>; open: () => void } => {
    let release: () => void = () => undefined;
    const promise = hold === true ? new Promise<void>((done) => (release = done)) : Promise.resolve();
    return { promise, open: () => release() };
  };
  const createGate = gate(options.holdCreate);
  const partGate = gate(options.holdParts);
  const pollGate = gate(options.holdPoll !== undefined);

  const filenames = (): string[] => [...jobs.values()].map((job) => job.record.filename).filter((name): name is string => typeof name === 'string' && name.length >= 4);

  const answer = async (route: Route, operation: Operation, status: number, body: unknown): Promise<void> => {
    for (const problem of answerProblems(operation, status, body)) mockFaults.push(problem);
    try {
      await route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) });
    } catch {
      // The page abandoned the request before it was answered.
    }
  };

  const notFound = (route: Route, operation: Operation): Promise<void> => answer(route, operation, 404, errorExample('NotFound'));

  const issue = (job: Job, partNumbers: readonly number[]): Json => {
    job.issues += 1;
    for (const entry of issued.values()) {
      if (entry.importId === String(job.record.id) && partNumbers.includes(entry.partNumber)) entry.superseded = true;
    }
    const parts = partNumbers.map((partNumber) => {
      const sizeBytes = job.plan[partNumber - 1] ?? 0;
      const signature = createHash('sha256').update(`${String(job.record.id)}:${partNumber}:${job.issues}`).digest('hex').slice(0, 24);
      const url = `${STORAGE_ORIGIN}/kasuwa-imports/upload?upload=u${String(serial)}&part=${partNumber}&expires=300&signature=${signature}`;
      issued.set(url, {
        importId: String(job.record.id),
        partNumber,
        issue: job.issues,
        sizeBytes,
        superseded: false,
        expired: job.issues === 1 && options.expireFromPart !== undefined && partNumber >= options.expireFromPart,
      });
      return { partNumber, url, sizeBytes };
    });
    return { importId: job.record.id, parts, expiresAt: new Date(Date.now() + 300_000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  };

  const touch = (job: Job, changes: Json): void => {
    Object.assign(job.record, changes, { updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
  };

  const end = (job: Job, changes: Json): void => touch(job, { ...changes, finishedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });

  const emptyBody = (call: ApiCall, label: string): void => {
    if (call.raw.trim() !== '') violations.push(`${label} takes no request body (it was sent ${call.raw.length} characters)`);
  };

  // ----- the store ------------------------------------------------------------

  await page.route(
    (url) => url.origin === STORAGE_ORIGIN,
    async (route) => {
      const request = route.request();
      const url = request.url();
      const method = request.method();
      storageRequests.push(`${method} ${new URL(url).pathname}`);
      const origin = request.headers().origin ?? '*';
      const cors = { 'access-control-allow-origin': origin, 'access-control-expose-headers': 'ETag', vary: 'Origin' };
      if (method === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'PUT', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '300' } }).catch(() => undefined);
        return;
      }
      const entry = issued.get(url);
      const body = request.postDataBuffer() ?? Buffer.alloc(0);
      const put: PartPut = {
        importId: entry?.importId ?? '',
        partNumber: entry?.partNumber ?? 0,
        url,
        issue: entry?.issue ?? 0,
        size: body.length,
        at: Date.now(),
        outcome: 'pending',
      };
      if (method === 'PUT') partPuts.push(put);
      const xml = async (status: number, text: string, outcome: PartPut['outcome']): Promise<void> => {
        put.outcome = outcome;
        await route.fulfill({ status, contentType: 'application/xml', headers: cors, body: text }).catch(() => {
          put.outcome = 'aborted';
        });
      };
      if (method !== 'PUT') {
        violations.push(`${method} to the store: the screen only ever PUTs parts to the URLs it was given`);
        return xml(403, S3_SIGNATURE, 'refused');
      }
      for (const header of Object.keys(request.headers())) {
        if (/^(authorization|cookie|x-kasuwa|x-requested-with)/i.test(header)) {
          violations.push(`a part PUT carried a "${header}" header: nothing of the session goes to the bucket (the signed URL is the only credential)`);
        }
      }
      if (entry === undefined) {
        violations.push('a part was PUT to a URL the API never issued (or an issued URL was edited)');
        return xml(403, S3_SIGNATURE, 'refused');
      }
      const job = jobs.get(entry.importId);
      if (job === undefined || job.record.status !== 'awaiting_upload') {
        violations.push(`part ${entry.partNumber} was PUT after its upload ended (${String(job?.record.status)})`);
        return xml(403, S3_EXPIRED, 'refused');
      }
      if (entry.superseded) {
        violations.push(`part ${entry.partNumber} was PUT to a URL that had been replaced by issueImportUploadUrls`);
        return xml(403, S3_EXPIRED, 'expired');
      }
      if (job.parts.has(entry.partNumber)) {
        violations.push(`part ${entry.partNumber} was uploaded again after it had succeeded`);
      }
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      if (open > 2) violations.push(`${open} parts were in flight at once: at most two (a slow link is not a parallel one)`);
      try {
        await partGate.promise;
        if (options.failPartAlways === entry.partNumber) return await xml(500, S3_INTERNAL, 'failed');
        if (options.failPartOnce === entry.partNumber && partPuts.filter((other) => other.importId === entry.importId && other.partNumber === entry.partNumber).length === 1) {
          put.outcome = 'failed';
          await route.abort('failed').catch(() => undefined);
          return undefined;
        }
        if (entry.expired) return await xml(403, S3_EXPIRED, 'expired');
        if (body.length !== entry.sizeBytes) {
          violations.push(`part ${entry.partNumber} was ${body.length} bytes; its URL is signed for ${entry.sizeBytes}`);
          return await xml(403, S3_SIGNATURE, 'refused');
        }
        const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
        // Stored before the answer leaves, so a complete that races the answer finds it.
        const before = job.parts.get(entry.partNumber);
        put.outcome = 'ok';
        job.parts.set(entry.partNumber, { etag, bytes: body });
        await route.fulfill({ status: 200, headers: { ...cors, etag }, body: '' }).catch(() => {
          put.outcome = 'aborted';
          if (before === undefined) job.parts.delete(entry.partNumber);
          else job.parts.set(entry.partNumber, before);
        });
        return undefined;
      } finally {
        open -= 1;
      }
    },
  );

  // ----- the API --------------------------------------------------------------

  const createImport = async (route: Route, call: ApiCall): Promise<void> => {
    const body = call.body;
    if (!isJson(body)) {
      violations.push('createImport was sent a body that is not a JSON object');
      return answer(route, 'createImport', 400, refusal('ValidationFailed', 'badField', [{ path: 'body', code: 'invalid_string' }]));
    }
    if (typeof body.sizeBytes === 'number' && body.sizeBytes > LIMITS.maxFileBytes) {
      violations.push(`createImport declared ${body.sizeBytes} bytes, over the published ${LIMITS.maxFileBytes}: the screen refuses an oversized file before declaring it (A1)`);
      return answer(route, 'createImport', 400, errorExample('ImportCreateInvalid', 'fileTooLarge'));
    }
    const contentType = body.contentType;
    const filename = typeof body.filename === 'string' ? body.filename : '';
    if (typeof contentType === 'string' && (!CONTENT_TYPES.includes(contentType) || (contentType === 'application/vnd.ms-excel' && !/\.csv$/i.test(filename)))) {
      return answer(route, 'createImport', 400, errorExample('ImportCreateInvalid', 'unsupportedType'));
    }
    const filenameProblems = validateBody(body.filename, (schema('CreateImportRequest').properties as Json).filename, 'filename');
    if (typeof body.filename === 'string' && filenameProblems.length > 0) {
      return answer(route, 'createImport', 400, errorExample('ImportCreateInvalid', 'badFilename'));
    }
    const problems = validateBody(body, schema('CreateImportRequest'), '');
    if (problems.length > 0) {
      violations.push(`createImport: ${problems.join('; ')}`);
      return answer(route, 'createImport', 400, refusal('ValidationFailed', 'badField', [{ path: 'body', code: 'invalid_string' }]));
    }
    const programmeId = String(body.programmeId);
    if (!reachable.has(programmeId)) {
      violations.push('createImport named a programme the session never listed: the target comes from listMyProgrammes');
      return notFound(route, 'createImport');
    }
    if (forbidden.has(programmeId)) {
      return answer(route, 'createImport', 403, errorExample('ImportNotPermitted', 'action'));
    }
    await createGate.promise;
    serial += 1;
    const id = newJobId(serial);
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const job: Job = {
      record: {
        id,
        programmeId,
        status: 'awaiting_upload',
        filename: body.filename,
        sizeBytes: body.sizeBytes,
        contentType: body.contentType,
        headers: null,
        suggestedMapping: null,
        mapping: null,
        counts: { created: 0, skipped: 0, failed: 0 },
        errors: [],
        errorsTruncated: false,
        rawFileDeletedAt: null,
        createdByUserId: CALLER_ID,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      },
      plan: partPlan(Number(body.sizeBytes)),
      parts: new Map(),
      issues: 0,
      runPolls: 0,
      headerPolls: 0,
      runSent: 0,
      completeSent: 0,
      cancelRequested: false,
      refusedFields: new Set(),
    };
    jobs.set(id, job);
    order.push(id);
    return answer(route, 'createImport', 201, issue(job, job.plan.map((_, index) => index + 1)));
  };

  const listImports = async (route: Route, call: ApiCall): Promise<void> => {
    const allowed = parameterNames('listImports');
    for (const name of new Set(call.url.searchParams.keys())) {
      if (!allowed.includes(name)) violations.push(`listImports declares no "${name}" parameter (scope is the session's, and there is no count)`);
    }
    const limit = call.url.searchParams.get('limit');
    if (limit !== null && !(Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 100)) {
      violations.push(`listImports limit=${limit} is outside 1..100`);
      return answer(route, 'listImports', 400, refusal('ValidationFailed', 'badField', [{ path: 'limit', code: 'invalid_string' }]));
    }
    if (call.url.searchParams.has('cursor')) {
      violations.push('listImports was sent a cursor the mock never served (nextCursor is always null here)');
    }
    const mine = [...order].reverse().map((id) => jobs.get(id)?.record).filter((record): record is Json => record !== undefined);
    return answer(route, 'listImports', 200, { data: [...mine, ...HISTORY].map(summaryOf), nextCursor: null });
  };

  const getImport = async (route: Route, importId: string): Promise<void> => {
    const history = [...HISTORY, REUSE_SOURCE].find((entry) => entry.id === importId);
    const job = jobs.get(importId);
    if (job === undefined) {
      if (history === undefined) {
        violations.push('getImport asked for an import the screen was never given');
        return notFound(route, 'getImport');
      }
      polls.push({ importId, at: Date.now(), phase: 'other', status: String(history.status) });
      return answer(route, 'getImport', 200, clone(history.id === H_FINISHED.id ? H_FINISHED : history));
    }
    const status = String(job.record.status);
    if (status === 'reading_header') {
      job.headerPolls += 1;
      if (job.headerPolls > (options.headerPolls ?? 1)) {
        const noName = options.scenario === 'noName';
        const headers = noName ? NO_NAME_HEADERS : options.hostileHeaders === true ? [...HEADERS.slice(0, -1), HOSTILE_HEADER] : HEADERS;
        const suggested = noName ? NO_NAME_SUGGESTED : SUGGESTED;
        touch(job, { status: 'awaiting_mapping', headers: [...headers], suggestedMapping: suggested.map((field, index) => ({ index, field })) });
      }
      polls.push({ importId, at: Date.now(), phase: 'header', status: String(job.record.status) });
      return answer(route, 'getImport', 200, clone(job.record));
    }
    if (job.runSent > 0 && ['queued', 'running'].includes(status)) {
      job.runPolls += 1;
      const n = job.runPolls;
      polls.push({ importId, at: Date.now(), phase: 'run', status });
      if (options.holdPoll === n) await pollGate.promise;
      if ((options.failPolls ?? []).includes(n)) {
        await route.abort('internetdisconnected').catch(() => undefined);
        return undefined;
      }
      if (job.cancelRequested) {
        end(job, { status: 'cancelled' });
      } else {
        const step = run.steps[n - 1];
        if (step !== undefined) touch(job, { status: step.status, counts: clone(step.counts) });
        else end(job, { status: run.end.status, counts: clone(run.end.counts), errors: clone(run.end.errors), errorsTruncated: run.end.errorsTruncated });
      }
      return answer(route, 'getImport', 200, clone(job.record));
    }
    polls.push({ importId, at: Date.now(), phase: job.runSent > 0 ? 'run' : 'other', status });
    return answer(route, 'getImport', 200, clone(job.record));
  };

  const write = async (route: Route, call: ApiCall, importId: string, action: string): Promise<void> => {
    const job = jobs.get(importId);
    const operation: Operation =
      action === 'upload-urls'
        ? 'issueImportUploadUrls'
        : action === 'complete'
          ? 'completeImportUpload'
          : action === 'abort'
            ? 'abortImportUpload'
            : action === 'mapping'
              ? 'putImportMapping'
              : action === 'run'
                ? 'runImport'
                : 'cancelImport';
    if (job === undefined) {
      violations.push(`${operation} on an import the screen did not create`);
      return notFound(route, operation);
    }
    const conflict = (): Promise<void> => answer(route, operation, 409, errorExample('ImportStatusConflict', 'wrongStatus'));
    const status = String(job.record.status);

    if (action === 'upload-urls') {
      const problems = validateBody(call.body, schema('IssueImportUploadUrlsRequest'), '');
      if (problems.length > 0) {
        violations.push(`issueImportUploadUrls: ${problems.join('; ')}`);
        return answer(route, operation, 400, refusal('ValidationFailed', 'badField', [{ path: 'partNumbers', code: 'invalid_string' }]));
      }
      if (status !== 'awaiting_upload') return conflict();
      const asked = ((call.body as Json).partNumbers as number[]).filter((partNumber) => partNumber <= job.plan.length);
      for (const partNumber of asked) {
        if (job.parts.has(partNumber)) violations.push(`issueImportUploadUrls asked again for part ${partNumber}, which had already succeeded`);
      }
      if (asked.length !== ((call.body as Json).partNumbers as number[]).length) {
        violations.push('issueImportUploadUrls asked for a part number beyond the plan');
        return answer(route, operation, 400, refusal('ValidationFailed', 'badField', [{ path: 'partNumbers', code: 'invalid_string' }]));
      }
      return answer(route, operation, 200, issue(job, asked));
    }

    if (action === 'complete') {
      const problems = validateBody(call.body, schema('CompleteImportUploadRequest'), '');
      if (problems.length > 0) {
        violations.push(`completeImportUpload: ${problems.join('; ')}`);
        return answer(route, operation, 400, refusal('ValidationFailed', 'badField', [{ path: 'parts', code: 'invalid_string' }]));
      }
      job.completeSent += 1;
      if (status !== 'awaiting_upload') {
        violations.push(`completeImportUpload sent in ${status} (complete is sent once)`);
        return conflict();
      }
      const sent = (call.body as Json).parts as { partNumber: number; etag: string }[];
      const numbers = sent.map((part) => part.partNumber);
      const expected = job.plan.map((_, index) => index + 1);
      if (JSON.stringify(numbers) !== JSON.stringify(expected)) {
        violations.push(`completeImportUpload listed parts ${numbers.join(',')}, not every part of the plan ascending (${expected.join(',')})`);
      }
      for (const part of sent) {
        const stored = job.parts.get(part.partNumber);
        if (stored === undefined) violations.push(`completeImportUpload listed part ${part.partNumber}, which never landed`);
        else if (stored.etag !== part.etag) violations.push(`completeImportUpload sent part ${part.partNumber} with an ETag the store did not return for it`);
      }
      if (options.mismatch === true) {
        end(job, { status: 'rejected' });
        return answer(route, operation, 422, errorExample('UploadMismatch', 'mismatch'));
      }
      touch(job, { status: 'reading_header' });
      return answer(route, operation, 202, clone(job.record));
    }

    if (action === 'abort') {
      emptyBody(call, 'abortImportUpload');
      if (status !== 'awaiting_upload') return conflict();
      end(job, { status: 'cancelled' });
      return answer(route, operation, 200, clone(job.record));
    }

    if (action === 'mapping') {
      const body = call.body;
      const problems = validateBody(body, schema('PutImportMappingRequest'), '');
      if (problems.length > 0 || !isJson(body)) {
        violations.push(`putImportMapping: ${problems.join('; ')}`);
        return answer(route, operation, 400, refusal('ValidationFailed', 'badField', [{ path: 'body', code: 'invalid_string' }]));
      }
      if (status !== 'awaiting_mapping') return conflict();
      const headers = (job.record.headers ?? []) as string[];
      if (body.ownerUserId !== undefined && body.ownerUserId !== null && body.ownerUserId !== CALLER_ID) {
        violations.push('putImportMapping named an owner other than the caller: there is no user directory to choose one from (D-L64)');
        return answer(route, operation, 400, errorExample('ImportMappingInvalid', 'unknownOwner'));
      }
      let columns: { index: number; field: string | null }[];
      if (typeof body.fromImportId === 'string') {
        const source = [...HISTORY, REUSE_SOURCE].find((entry) => entry.id === body.fromImportId);
        const reusable = body.fromImportId === REUSE_SOURCE.id ? REUSE_SOURCE : source;
        if (reusable !== undefined && reusable.headers === null) {
          violations.push('putImportMapping reused an import whose headers are erased (D-L148): the screen must not offer it');
        }
        if (options.reuseRefused === true || reusable === undefined || reusable.headers === null || reusable.mapping === null) {
          return answer(route, operation, 400, errorExample('ImportMappingInvalid', 'unknownTemplate'));
        }
        const sourceHeaders = reusable.headers as string[];
        const sourceColumns = (reusable.mapping as { columns: { index: number; field: string | null }[] }).columns;
        columns = headers.map((name, index) => {
          const from = sourceHeaders.indexOf(name);
          return { index, field: from < 0 ? null : (sourceColumns.find((column) => column.index === from)?.field ?? null) };
        });
      } else {
        columns = (body.columns as { index: number; field: string | null }[]).map((column) => ({ index: column.index, field: column.field }));
        const indices = columns.map((column) => column.index);
        const beyond = indices.findIndex((index) => index >= headers.length);
        if (beyond >= 0) {
          violations.push(`putImportMapping mapped column index ${String(indices[beyond])}, beyond the ${headers.length} headers`);
          return answer(route, operation, 400, refusal('ImportMappingInvalid', 'unknownColumn', [{ path: `columns.${beyond}.index`, code: 'unknown_column' }]));
        }
        if (new Set(indices).size !== indices.length) {
          violations.push('putImportMapping mapped the same column index twice');
          return answer(route, operation, 400, refusal('ValidationFailed', 'badField', [{ path: 'columns', code: 'invalid_string' }]));
        }
        for (const column of columns) {
          if (column.field !== null && CUSTOM_FIELD_PATTERN.test(column.field) && custom.active('contact').every((field) => `custom.${field.apiName}` !== column.field)) {
            violations.push(`putImportMapping mapped ${column.field}, a custom key the screen was given no definition for`);
          }
          if (column.field !== null && job.refusedFields.has(column.field)) {
            violations.push(`putImportMapping sent ${column.field} again after the API answered field_not_editable for it: it is read-only now`);
          }
        }
        const seen = new Map<string, number>();
        for (const [position, column] of columns.entries()) {
          if (column.field === null || REPEATABLE_FIELDS.includes(column.field)) continue;
          if (seen.has(column.field)) {
            return answer(route, operation, 400, refusal('ImportMappingInvalid', 'duplicateMapping', [{ path: `columns.${position}.field`, code: 'duplicate_mapping' }]));
          }
          seen.set(column.field, position);
        }
        if (!columns.some((column) => column.field !== null && NAME_FIELDS.includes(column.field))) {
          violations.push('putImportMapping was sent without displayName, givenNames or familyName: the required-field checklist blocks Continue');
          return answer(route, operation, 400, errorExample('ImportMappingInvalid', 'mappingIncomplete'));
        }
        const locked = [...new Set(columns.map((column) => column.field).filter((field): field is string => field !== null && (options.notEditable ?? []).includes(field)))];
        if (locked.length > 0) {
          for (const field of locked) job.refusedFields.add(field);
          return answer(route, operation, 403, refusal('ImportMappingNotPermitted', 'field', locked.map((field) => ({ path: field, code: 'field_not_editable' }))));
        }
      }
      touch(job, { mapping: { columns, defaultCountry: body.defaultCountry, ownerUserId: body.ownerUserId ?? null } });
      return answer(route, operation, 200, clone(job.record));
    }

    if (action === 'run') {
      emptyBody(call, 'runImport');
      job.runSent += 1;
      if (job.runSent > 1) violations.push('runImport was sent twice for one import');
      if (options.runConflict === true) {
        touch(job, { status: 'expired', headers: null, filename: null, mapping: null, rawFileDeletedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
        job.record.finishedAt = job.record.updatedAt;
        return conflict();
      }
      if (status !== 'awaiting_mapping' || job.record.mapping === null) {
        if (job.runSent === 1) violations.push(`runImport sent in ${status} without a saved mapping`);
        return conflict();
      }
      touch(job, { status: 'queued', suggestedMapping: null });
      return answer(route, operation, 202, clone(job.record));
    }

    // cancel
    emptyBody(call, 'cancelImport');
    if (!['queued', 'running'].includes(status)) return conflict();
    job.cancelRequested = true;
    return answer(route, operation, 202, clone(job.record));
  };

  const listContacts = async (route: Route, call: ApiCall): Promise<void> => {
    contactReads.push(call.url);
    const allowed = parameterNames('listContacts');
    for (const name of new Set(call.url.searchParams.keys())) {
      if (!allowed.includes(name) && !/^custom(Empty)?\[/.test(name)) violations.push(`listContacts declares no "${name}" parameter`);
    }
    const importId = call.url.searchParams.get('importId');
    if (importId !== null && !UUID_PATTERN.test(importId)) violations.push('listContacts was sent an importId that is not a uuid');
    return answer(route, 'listContacts', 200, clone(CONTACTS_EXAMPLE));
  };

  await page.route(
    (url) => url.pathname.startsWith('/api/v1/'),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      requests.push(url);
      const raw = request.postData() ?? '';
      let body: unknown;
      try {
        body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
      } catch {
        body = undefined;
      }
      for (const header of Object.keys(request.headers())) {
        if (/programme|tenant|scope/i.test(header)) violations.push(`${method} ${url.pathname} was sent a "${header}" header: scope is never supplied`);
      }
      const where = `${method} ${url.pathname.replace(/[^/]{40,}/g, '<long>')}`;
      if (raw.length > 64 * 1024) violations.push(`${where} carried ${raw.length} characters: the API never carries file bytes`);
      if (raw.includes(CELL_MARKER) || decodeURIComponent(url.href).includes(CELL_MARKER)) violations.push(`${where} carried a cell value from the file`);
      if (raw.includes('signature=') || raw.includes(STORAGE_ORIGIN)) violations.push(`${where} carried a signed part URL back to the API`);
      const href = decodeURIComponent(`${url.pathname}${url.search}`);
      for (const name of filenames()) {
        if (href.includes(name)) violations.push(`${where} put the file's name in a URL`);
      }

      const operationOf = (): Operation | undefined => {
        if (url.pathname === IMPORTS_PATH) return method === 'POST' ? 'createImport' : method === 'GET' ? 'listImports' : undefined;
        const job = jobPath(url.pathname);
        if (job !== undefined) {
          const byAction: Record<string, [string, Operation]> = {
            '': ['GET', 'getImport'],
            'upload-urls': ['POST', 'issueImportUploadUrls'],
            complete: ['POST', 'completeImportUpload'],
            abort: ['POST', 'abortImportUpload'],
            mapping: ['PUT', 'putImportMapping'],
            run: ['POST', 'runImport'],
            cancel: ['POST', 'cancelImport'],
          };
          const found = byAction[job.action];
          return found !== undefined && found[0] === method ? found[1] : undefined;
        }
        if (url.pathname === CONTACTS_PATH && method === 'GET') return 'listContacts';
        if (url.pathname === PROGRAMMES_PATH && method === 'GET') return 'listMyProgrammes';
        if (url.pathname === ME_PATH && method === 'GET') return 'getCurrentUser';
        return undefined;
      };

      if (url.pathname === CUSTOM_FIELDS_PATH && method === 'GET') return custom.answerList(route);
      const operation = operationOf();
      if (operation === undefined) {
        violations.push(`${where} is not an operation the import screen uses`);
        await route
          .fulfill({ status: 404, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(errorExample('NotFound')) })
          .catch(() => undefined);
        return undefined;
      }
      const call: ApiCall = { operation, url, raw, body, at: Date.now() };
      calls.push(call);
      if (raw !== '' && body === undefined) violations.push(`${operation} was sent a body that is not JSON`);
      if (raw !== '' && !/^application\/json\b/i.test(request.headers()['content-type'] ?? '')) violations.push(`${operation} was sent a body that is not application/json`);

      const job = jobPath(url.pathname);
      if (job !== undefined && !UUID_PATTERN.test(job.importId)) {
        violations.push(`${operation} was sent an import id that is not a uuid`);
        return answer(route, operation, 400, refusal('ValidationFailed', 'badField', [{ path: 'importId', code: 'invalid_string' }]));
      }
      switch (operation) {
        case 'createImport':
          return createImport(route, call);
        case 'listImports':
          return listImports(route, call);
        case 'getImport':
          return getImport(route, job?.importId ?? '');
        case 'listContacts':
          return listContacts(route, call);
        case 'listMyProgrammes':
          return answer(route, operation, 200, clone(PROGRAMMES_ANSWER));
        case 'getCurrentUser':
          return answer(route, operation, 200, clone(CURRENT_USER));
        default:
          return write(route, call, job?.importId ?? '', job?.action ?? '');
      }
    },
  );

  return {
    requests,
    calls,
    partPuts,
    storageRequests,
    polls,
    contactReads,
    violations,
    mockFaults,
    inFlight: () => open,
    maxInFlight: () => maxOpen,
    assembled: (importId: string) => {
      const job = jobs.get(importId);
      if (job === undefined) return Buffer.alloc(0);
      return Buffer.concat(job.plan.map((_, index) => job.parts.get(index + 1)?.bytes ?? Buffer.alloc(0)));
    },
    job: (importId: string) => (jobs.get(importId) === undefined ? undefined : clone(jobs.get(importId)?.record)),
    created: () => [...order],
    callsOf: (operation: Operation) => calls.filter((call) => call.operation === operation),
    releaseCreate: () => createGate.open(),
    releaseParts: () => partGate.open(),
    releasePoll: () => pollGate.open(),
  };
}

/** True for a getImport read of `importId`. */
export function isGetImport(request: Request, importId?: string): boolean {
  const url = new URL(request.url());
  const job = jobPath(url.pathname);
  return request.method() === 'GET' && job !== undefined && job.action === '' && (importId === undefined || job.importId === importId);
}
