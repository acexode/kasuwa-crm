import type { Page, Request, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { TENANT_A } from '@kasuwa/db';

/**
 * The P27 half of `docs/api/records.openapi.yaml` — `searchRecords` (GET,
 * `q` and `types` only) and `lookupRecords` (POST, a closed body holding one
 * whole phone number or one whole email address) — plus the reads a "see all"
 * link lands on (`listContacts`, `listLeads`, `listAccounts` with `q`) and the
 * two the CRM shell's screens may make on the way (`listMyProgrammes`,
 * `getCurrentUser`), served into the browser by Playwright for T-0087 (the
 * global search screen and the command palette).
 *
 * ---------------------------------------------------------------------------
 * READ FROM THE CONTRACT AT RUN TIME, AND EVERY REQUEST AND ANSWER CHECKED
 *
 * The schemas, the enums, the parameter lists, the search fields
 * (`x-kasuwa-search-fields`) and every error body come out of the YAML when
 * this module loads. The identifier rule does NOT: D-L135's Unicode rule is
 * stronger than the YAML's ASCII `not` pattern (until T-0086 lands it), so
 * `identifierShaped` implements it in full here.
 *
 *   - At load, every stored record is served as a hit and validated, strictly,
 *     against its hit schema; the contract's own examples (`prefix`,
 *     `withheldNamePart`, `phoneLookup`) must round-trip through the store
 *     unchanged. A contract change this file contradicts fails here, loudly,
 *     before any journey runs.
 *   - EVERY body the mock answers with is validated against the schema the
 *     contract declares for that operation and status, strictly: a property
 *     the schema does not name is a fault, so the mock can never hand the
 *     screen a count, a total, a "more" flag, a phone or a programme name the
 *     real API does not serve. A fault is the MOCK's, recorded in
 *     `mockFaults`, which the spec's `afterEach` requires to be empty.
 *
 *   The exceptions are deliberate and filed apart, in `plantedFaults`:
 *   `hostileIds` serves two hits whose ids are NOT uuids (the screen links
 *   only from a well-formed uuid), and `futureGroup` adds a group of a type
 *   this contract does not have yet (R17: a client ignores a group whose
 *   `type` it does not know). A problem is planted only if it disappears when
 *   the planted part is replaced or removed; anything else is still a fault.
 *
 * WHAT IS NOT IN THE CONTRACT, AND IS THEREFORE DECLARED HERE
 *
 *   - The records. The contract's examples are used verbatim; the rest are
 *     declared in the same shape. Every name is synthetic (it holds Sample,
 *     Fixture, Example or Test, as the contract's R19 asks). EVERY PHONE
 *     NUMBER HERE IS A PLACEHOLDER: Nigeria has no fictional number range, so
 *     these use the contract's own `+234803000000x` placeholders.
 *   - Field security, per programme (the contact object's matrix):
 *       PROGRAMME_ONE   — nothing withheld;
 *       PROGRAMME_TWO   — `familyName` withheld, so `displayName` is too
 *                         (D-L68, the contract's `withheldNamePart` example);
 *       PROGRAMME_THREE — `givenNames`, `familyName` and `companyName`
 *                         withheld: a hit with no readable name at all.
 *     A withheld field never matches and is omitted from the hit.
 *   - Which three hits, and their order: the contract does not pin them. The
 *     mock serves by a fixed `rank`, deliberately NOT alphabetical, so a
 *     screen that sorts by name draws a different order from the one served.
 *   - The caller is an agent (reads all four types) or, with
 *     `caller: 'portal'`, a `client_portal` user, whose deal group is always
 *     answered empty (D-L115): an unreadable type is an empty group.
 *   - Phone normalisation (the tenant's default country is Nigeria): a whole
 *     number is `0` + 10 digits, `234` + 10 digits or `+234` + 10 digits once
 *     spaces, `(`, `)`, `.` and `-` are removed. Anything else, a partial
 *     number included, is `400 invalid_phone`. That is the API refusing a
 *     value, not the screen breaking a rule, so it is NOT a violation.
 *
 * WHAT THE MOCK ENFORCES ON EVERY REQUEST (recorded as `violations`, the
 * SCREEN's fault; `afterEach` in the spec fails a test that has any)
 *
 *   - Only the operations above. Anything else under `/api/v1/` is a
 *     violation: a record read per hit, a count, recent searches, a facet, a
 *     programme switch, a GET to the lookup. After `leave()` (the journey is
 *     following a link off the search) any other read is answered 404 and
 *     recorded in `afterLeave`, not blamed.
 *   - No request header names a programme or a tenant (CLAUDE.md 2.2).
 *   - searchRecords: only `q` and `types`; `q` present; `types` absent or all
 *     four (the screen searches every type); **`q` never phone- or
 *     email-shaped** (R21 as D-L135 states it: after NFKC, an `@`, or a run
 *     of 6 or more `\p{Nd}` digits of any script once everything that is
 *     neither a letter nor a digit is removed); never a control character,
 *     never over 100 characters, never under 2 once folded (NFD, marks
 *     removed, lower-cased, trimmed, inner whitespace collapsed). Each is
 *     answered as the contract says (`400` with the right detail code).
 *     **Nor phone-like at all** (the lead's R27, D-L135): a `q` that, after
 *     NFKC, holds a `\p{Nd}` digit and no `\p{L}` letter (`0803`, `+234 80`,
 *     `0803/1`, `٠٨`) is a violation even though the contract answers it 200.
 *   - lookupRecords: a POST, `application/json`, NO query string at all, the
 *     closed `LookupRequest` with exactly one of `phone` or `email`; `types`
 *     absent, all four, or exactly contact and lead. The term must be
 *     phone- or email-shaped by the same R21 rule: a name sent to the lookup
 *     is a name the screen failed to search. The term must be NFKC-normalised
 *     already (the lead's R28): full-width digits arrive as ASCII. Digits
 *     NFKC leaves alone (Arabic-Indic) arrive as typed; today's
 *     `LookupRequest.phone` pattern refuses them, and so do `/`, `_`, `,`
 *     and an en dash, as `400 invalid_phone`: the API's refusal, not a
 *     violation.
 *   - listContacts / listLeads / listAccounts: only parameters the operation
 *     declares, never a programme or scope.
 *
 * SERVER BEHAVIOUR THE SCREEN DEPENDS ON, IMPLEMENTED AS THE CONTRACT SAYS
 *
 *   - Folded PREFIX matching on the whole value of each readable search field.
 *   - One group per requested type, in the order contact, lead, account, deal,
 *     at most three hits each, no count of any kind. A lead is also a contact,
 *     so it may be in both groups with the same id.
 *   - A lookup searches contacts and leads only; account and deal groups are
 *     answered empty. A hit never carries the number or address that found it.
 * ---------------------------------------------------------------------------
 */

export const RECORDS_CONTRACT_SOURCE = 'docs/api/records.openapi.yaml';
export const AUTH_CONTRACT_SOURCE = 'docs/api/auth.openapi.yaml';
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

/** Follows `$ref`s, local or into a sibling contract (`./admin.openapi.yaml#/…`). */
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

export const SEARCH_PATH = '/api/v1/search';
export const LOOKUP_PATH = '/api/v1/search/lookup';
const CONTACTS_PATH = '/api/v1/contacts';
const LEADS_PATH = '/api/v1/leads';
const ACCOUNTS_PATH = '/api/v1/accounts';
const PROGRAMMES_PATH = '/api/v1/me/programmes';
const ME_PATH = '/api/v1/auth/me';

const OP = {
  searchRecords: [SEARCH_PATH, 'get'],
  lookupRecords: [LOOKUP_PATH, 'post'],
  listContacts: [CONTACTS_PATH, 'get'],
  listLeads: [LEADS_PATH, 'get'],
  listAccounts: [ACCOUNTS_PATH, 'get'],
  listMyProgrammes: [PROGRAMMES_PATH, 'get'],
  getCurrentUser: [ME_PATH, 'get'],
} as const;

export type Operation = keyof typeof OP;

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

function declaredKeys(spec: Json, doc: unknown): Set<string> {
  const keys = new Set(Object.keys((spec.properties ?? {}) as Json));
  for (const part of (Array.isArray(spec.allOf) ? spec.allOf : []) as unknown[]) {
    const located = deref(part, doc);
    if (isJson(located.node)) {
      for (const key of declaredKeys(located.node, located.doc)) keys.add(key);
    }
  }
  return keys;
}

/**
 * Problems with `value` against a schema. `strict` treats every object schema
 * that declares properties as closed: used on the mock's OWN answers, never on
 * what the screen sends (request bodies are judged by the contract's own
 * `additionalProperties`).
 */
export function validateBody(value: unknown, raw: unknown, path: string, doc: unknown = CONTRACT, strict = false): string[] {
  const located = deref(raw, doc);
  const spec = located.node as Json;
  const where = path || 'body';
  if (Array.isArray(spec.oneOf)) {
    const passing = spec.oneOf.filter((option) => validateBody(value, option, path, located.doc, strict).length === 0);
    if (passing.length !== 1) {
      return [`${where} matches ${passing.length} of oneOf, not exactly 1`];
    }
  }
  const problems: string[] = [];
  if (Array.isArray(spec.allOf)) {
    for (const part of spec.allOf) {
      problems.push(...validateBody(value, part, path, located.doc, false));
    }
  }
  if (spec.type !== undefined) {
    const allowed = (Array.isArray(spec.type) ? spec.type : [spec.type]).map(String);
    const actual = typeOf(value);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      return [...problems, `${where} is ${actual}, not ${allowed.join('|')}`];
    }
  }
  if ('const' in spec && spec.const !== value) {
    problems.push(`${where} is not ${String(spec.const)}`);
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
    if (typeof spec.minItems === 'number' && value.length < spec.minItems) problems.push(`${where} has too few items`);
    if (spec.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      problems.push(`${where} repeats an item`);
    }
    if (spec.items !== undefined) {
      value.forEach((item, index) => problems.push(...validateBody(item, spec.items, `${path}.${index}`, located.doc, strict)));
    }
  }
  if (isJson(value) && (spec.properties !== undefined || spec.required !== undefined || spec.additionalProperties === false)) {
    const properties = (spec.properties ?? {}) as Json;
    const declared = declaredKeys(spec, located.doc);
    for (const key of (spec.required ?? []) as string[]) {
      if (!(key in value)) problems.push(`${path ? `${path}.` : ''}${key} is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      const child = `${path ? `${path}.` : ''}${key}`;
      if (!(key in properties)) {
        if (spec.additionalProperties === false) {
          problems.push(`${child} is not a property of this closed body`);
        } else if (strict && !declared.has(key)) {
          problems.push(`${child} is not a property the contract declares`);
        }
        continue;
      }
      problems.push(...validateBody(item, properties[key], child, located.doc, strict));
    }
  }
  return problems;
}

/**
 * What is wrong with answering `operation` with `status` and `body`, judged
 * strictly against the response the contract declares. An undeclared status
 * is itself a problem.
 */
export function answerProblems(operation: Operation, status: number, body: unknown): string[] {
  const [path, method] = OP[operation];
  const document = operation === 'getCurrentUser' ? AUTH_CONTRACT : CONTRACT;
  const responses = at(document, 'paths', path, method, 'responses') as Json;
  const declared = responses[String(status)];
  if (declared === undefined) {
    return [`${operation} declares no ${status} response`];
  }
  const response = deref(declared, document);
  const content = at(response.node, 'content', 'application/json', 'schema');
  return validateBody(body, content, `${operation} ${status}`, response.doc, true);
}

/** The `code`s an operation can answer with, read from its error responses. */
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

function errorExample(response: string, name?: string): Json {
  const json = at(deref(at(CONTRACT, 'components', 'responses', response), CONTRACT).node, 'content', 'application/json') as Json;
  const body = name === undefined ? json.example : at(json.examples, name, 'value');
  return clone(body) as Json;
}

function searchRefusal(path: string, code: string): Json {
  const body = errorExample('SearchValidationFailed', 'queryRequired');
  body.details = [{ path, code }];
  return body;
}

function lookupRefusal(path: string, code: string): Json {
  const body = errorExample('LookupValidationFailed', 'oneTermRequired');
  body.details = [{ path, code }];
  return body;
}

function listRefusal(): Json {
  const body = errorExample('ValidationFailed', 'badField');
  body.details = [{ path: 'query', code: 'invalid_string' }];
  return body;
}

function parameterNames(operation: Operation): readonly string[] {
  const [path, method] = OP[operation];
  const own = (at(CONTRACT, 'paths', path, method) as Json).parameters;
  return ((Array.isArray(own) ? own : []) as unknown[]).map((raw) => String((deref(raw, CONTRACT).node as Json).name));
}

// ---------------------------------------------------------------------------
// The contract's own vocabularies and rules
// ---------------------------------------------------------------------------

export type SearchType = 'contact' | 'lead' | 'account' | 'deal';

/** The contract's group order (SearchType's enum order). */
export const SEARCH_TYPES: readonly SearchType[] = (at(schema('SearchType'), 'enum') as unknown[]).map(String) as SearchType[];
const NAME_FIELD_ORDER: readonly string[] = (at(schema('SearchNameWithheldField'), 'enum') as unknown[]).map(String);
const LEAD_STATUSES: readonly string[] = (at(schema('LeadSearchHit'), 'properties', 'status', 'enum') as unknown[]).map(String);

const SEARCH_OPERATION = at(CONTRACT, 'paths', SEARCH_PATH, 'get') as Json;
/** `x-kasuwa-search-fields`: per type, the fields `q` is prefix-matched against. */
export const SEARCH_FIELDS = clone(at(SEARCH_OPERATION, 'x-kasuwa-search-fields')) as Readonly<Record<SearchType, readonly string[]>>;

const Q_PARAMETER = ((SEARCH_OPERATION.parameters ?? []) as unknown[])
  .map((raw) => deref(raw, CONTRACT).node as Json)
  .find((parameter) => parameter.name === 'q') as { schema: { minLength: number; maxLength: number; not: { pattern: string } } };

/**
 * The YAML's ASCII form of R21 (`q`'s `not`), exported ONLY so the spec can
 * show it is weaker than D-L135. The mock never decides anything with it.
 */
export const CONTRACT_ASCII_IDENTIFIER_PATTERN = new RegExp(Q_PARAMETER.schema.not.pattern);
export const Q_MIN = Q_PARAMETER.schema.minLength;
export const Q_MAX = Q_PARAMETER.schema.maxLength;

/**
 * R21 as strengthened by D-L135 (it lands in the YAML with T-0086; until
 * then the YAML holds the older ASCII rule, so this is implemented here, in
 * full, and NOT derived from the YAML). After NFKC, text is identifier-shaped
 * when it contains `@`, or when, with every character that is neither a
 * letter (`\p{L}`) nor a decimal digit (`\p{Nd}`) removed, it holds a run of
 * 6 or more `\p{Nd}` digits of ANY script. So `0803/123/4567`,
 * `0803_123_4567`, `0803,123,4567`, `0803–123–4567` and Arabic-Indic digits
 * are identifiers; `Unit 12 Block 3456` is not (letters break the run).
 * Such input belongs to lookupRecords, never to a URL.
 */
export function identifierShaped(text: string): boolean {
  const normal = text.normalize('NFKC');
  if (normal.includes('@')) return true;
  return /\p{Nd}{6,}/u.test(normal.replace(/[^\p{L}\p{Nd}]/gu, ''));
}

/**
 * R27 (lead ruling, aligned with D-L135): after NFKC, the text holds at least
 * one `\p{Nd}` digit of any script and NO `\p{L}` letter. Such input never
 * reaches searchRecords at any keystroke, not even as a short prefix: the
 * screen waits until it is lookup-eligible and sends lookupRecords only.
 * Text with letters stays a name query, subject to `identifierShaped`.
 */
export function phoneLike(text: string): boolean {
  const normal = text.normalize('NFKC');
  return /\p{Nd}/u.test(normal) && !/\p{L}/u.test(normal);
}

/**
 * The value of each decimal digit in `text`, in order, as ASCII (`٠٨` is
 * `08`): a `\p{Nd}` digit's value is its distance from the first digit of its
 * run of ten. Used to compare numbers written in different scripts.
 */
export function digitValues(text: string): string {
  let out = '';
  for (const character of text.normalize('NFKC')) {
    if (!/\p{Nd}/u.test(character)) continue;
    const code = character.codePointAt(0) ?? 0;
    let back = 0;
    while (back < 60 && /\p{Nd}/u.test(String.fromCodePoint(code - back - 1))) back += 1;
    out += String(back % 10);
  }
  return out;
}

/** The contract's folding (searchRecords' description), for the length rule and the prefix match. */
export function folded(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, ' ');
}

/**
 * A query string as a violation message may print it: every phone- or
 * email-shaped value replaced, so the mock's own messages never carry an
 * identifier into a CI log (CLAUDE.md 6.1).
 */
export function redactedQuery(url: URL): string {
  const parts = [...url.searchParams.entries()].map(([name, value]) => `${name}=${identifierShaped(value) || phoneLike(value) ? '<identifier>' : value}`);
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/** True when `text` holds a NUL or other control character (C0, DEL or C1): `invalid_string`. */
export function hasControlCharacter(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

/** E.164 with Nigeria as the default country, or null when the value is not one whole number. */
export function normalisedPhone(value: string): string | null {
  if (!/^[0-9+() .-]+$/.test(value)) return null;
  const compact = value.replace(/[\s().-]/g, '');
  const national = /^(?:\+234|234|0)([789][01]\d{8})$/.exec(compact);
  return national === null ? null : `+234${national[1] ?? ''}`;
}

// ---------------------------------------------------------------------------
// Programmes and field security
// ---------------------------------------------------------------------------

export interface Programme {
  id: string;
  name: string;
}

/** The contract's own example programme. */
export const PROGRAMME_ONE = clone(
  at(CONTRACT, 'paths', PROGRAMMES_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', '0'),
) as Programme;
/** The programme of the contract's `withheldNamePart` example. */
export const PROGRAMME_TWO: Programme = { id: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a02', name: 'Sample Fixture Care' };
/** A third programme whose matrix withholds every name field of a contact. */
export const PROGRAMME_THREE: Programme = { id: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a03', name: 'Example Testline Sales' };

/** Contact fields withheld per programme (the contact object's matrix). */
const WITHHELD: Readonly<Record<string, readonly string[]>> = {
  [PROGRAMME_ONE.id]: [],
  [PROGRAMME_TWO.id]: ['familyName'],
  [PROGRAMME_THREE.id]: ['givenNames', 'familyName', 'companyName'],
};

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** A contact (a lead when `lead` is a lead status), as the server holds it. Phones are PLACEHOLDERS. */
export interface StoredPerson {
  id: string;
  programmeId: string;
  rank: number;
  displayName: string;
  givenNames: string | null;
  familyName: string | null;
  companyName: string | null;
  lead: string | null;
  phones: readonly string[];
  emails: readonly string[];
}

export interface StoredAccount {
  id: string;
  programmeId: string;
  rank: number;
  name: string;
}

export interface StoredDeal {
  id: string;
  programmeId: string;
  pipelineId: string;
  rank: number;
  name: string;
}

const PREFIX_EXAMPLE = at(SEARCH_OPERATION, 'responses', '200', 'content', 'application/json', 'examples', 'prefix', 'value') as Json;
const WITHHELD_EXAMPLE = at(SEARCH_OPERATION, 'responses', '200', 'content', 'application/json', 'examples', 'withheldNamePart', 'value') as Json;
const PHONE_EXAMPLE = at(CONTRACT, 'paths', LOOKUP_PATH, 'post', 'responses', '200', 'content', 'application/json', 'examples', 'phoneLookup', 'value') as Json;

function exampleHit(example: Json, type: SearchType, index: number): Json {
  const group = (example.groups as Json[]).find((entry) => entry.type === type);
  return clone((group?.hits as Json[] | undefined)?.[index] ?? {});
}

const EX_C1 = exampleHit(PREFIX_EXAMPLE, 'contact', 0);
const EX_C2 = exampleHit(PREFIX_EXAMPLE, 'contact', 1);
const EX_L1 = exampleHit(PREFIX_EXAMPLE, 'lead', 0);
const EX_A1 = exampleHit(PREFIX_EXAMPLE, 'account', 0);
const EX_D1 = exampleHit(PREFIX_EXAMPLE, 'deal', 0);
const EX_C4 = exampleHit(WITHHELD_EXAMPLE, 'contact', 0);

/** The contract's `Samplewise Testcase`: the phoneLookup example's hit (placeholder 0803 000 0001). */
export const C_SAMPLEWISE: StoredPerson = {
  id: String(EX_C2.id),
  programmeId: String(EX_C2.programmeId),
  rank: 1,
  displayName: String(EX_C2.displayName),
  givenNames: EX_C2.givenNames as string,
  familyName: EX_C2.familyName as string,
  companyName: EX_C2.companyName as string,
  lead: null,
  phones: ['+2348030000001'],
  emails: ['samplewise.testcase@example.test'],
};

/** The contract's lead `Fixture Example` (matched by its company, `Sample Wholesale Ltd`). */
export const L_FIXTURE: StoredPerson = {
  id: String(EX_L1.id),
  programmeId: String(EX_L1.programmeId),
  rank: 2,
  displayName: String(EX_L1.displayName),
  givenNames: EX_L1.givenNames as string,
  familyName: EX_L1.familyName as string,
  companyName: EX_L1.companyName as string,
  lead: String(EX_L1.status),
  phones: ['+2348030000003'],
  emails: ['fixture.example@example.test'],
};

/** The contract's `Sámple Fixture`; the lookup's email example finds it. */
export const C_SAMPLE: StoredPerson = {
  id: String(EX_C1.id),
  programmeId: String(EX_C1.programmeId),
  rank: 3,
  displayName: String(EX_C1.displayName),
  givenNames: EX_C1.givenNames as string,
  familyName: EX_C1.familyName as string,
  companyName: EX_C1.companyName as null,
  lead: null,
  phones: ['+2348030000011'],
  emails: ['sample.fixture@example.test'],
};

/** The contract's `withheldNamePart` hit, in PROGRAMME_TWO: its family name is withheld there. */
export const C_SAMPLETON: StoredPerson = {
  id: String(EX_C4.id),
  programmeId: String(EX_C4.programmeId),
  rank: 4,
  displayName: 'Sampleton Fixturedale',
  givenNames: EX_C4.givenNames as string,
  familyName: 'Fixturedale',
  companyName: EX_C4.companyName as null,
  lead: null,
  phones: ['+2348030000004'],
  emails: ['sampleton.fixturedale@example.test'],
};

/**
 * A display name that is NOT its parts joined: a screen that composes
 * `givenNames familyName` draws "Samwell Fixture-Example", which is not what
 * was served.
 */
export const C_COMPOSED_TRAP: StoredPerson = {
  id: 'a1b2c3d4-0001-4a5b-8c6d-000000000006',
  programmeId: PROGRAMME_ONE.id,
  rank: 5,
  displayName: 'Fixture-Example, Samwell (Testcase)',
  givenNames: 'Samwell',
  familyName: 'Fixture-Example',
  companyName: null,
  lead: null,
  phones: ['+2348030000006'],
  emails: ['samwell.fixture@example.test'],
};

/** A second lead, matched by its given name. */
export const L_SAMPLEFORD: StoredPerson = {
  id: 'a1b2c3d4-0001-4a5b-8c6d-000000000007',
  programmeId: PROGRAMME_ONE.id,
  rank: 6,
  displayName: 'Sampleford Example',
  givenNames: 'Sampleford',
  familyName: 'Example',
  companyName: null,
  lead: 'new',
  phones: ['+2348030000007'],
  emails: ['sampleford.example@example.test'],
};

/**
 * In PROGRAMME_THREE: every name field withheld, so a name search never finds
 * it; the lookup by its (placeholder) number does, and the hit has no
 * readable name at all. Its stored names must never reach the page.
 */
export const C_NAMELESS: StoredPerson = {
  id: 'a1b2c3d4-0001-4a5b-8c6d-000000000008',
  programmeId: PROGRAMME_THREE.id,
  rank: 7,
  displayName: 'Sampleshade Fixturemoor',
  givenNames: 'Sampleshade',
  familyName: 'Fixturemoor',
  companyName: 'Testmoor Example Ltd',
  lead: null,
  phones: ['+2348030000077'],
  emails: ['sampleshade.fixturemoor@example.test'],
};

export const A_HOLDINGS: StoredAccount = {
  id: String(EX_A1.id),
  programmeId: String(EX_A1.programmeId),
  rank: 1,
  name: String(EX_A1.name),
};

/** Matches `sam`, not `samp`: the account that tells a stale answer from a fresh one. */
export const A_SAMARA: StoredAccount = {
  id: 'a1b2c3d4-0002-4a5b-8c6d-000000000002',
  programmeId: PROGRAMME_ONE.id,
  rank: 2,
  name: 'Samara Example Stores',
};

export const D_HOLDINGS: StoredDeal = {
  id: String(EX_D1.id),
  programmeId: String(EX_D1.programmeId),
  pipelineId: String(EX_D1.pipelineId),
  rank: 1,
  name: String(EX_D1.name),
};

/** Matches `sam`, not `samp`. */
export const D_SAMARA: StoredDeal = {
  id: 'a1b2c3d4-0003-4a5b-8c6d-000000000002',
  programmeId: PROGRAMME_ONE.id,
  pipelineId: String(EX_D1.pipelineId),
  rank: 2,
  name: 'Samara Example renewal',
};

/** Under `hostileMarkup`: markup in a name, drawn as text, never parsed. Found by MARKUP_QUERY. */
export const HOSTILE_NAME = 'Samplemark<img src=x onerror="window.__kasuwaXss=1"> <b>Testcase</b>';
export const MARKUP_QUERY = 'samplemark';
const C_MARKUP: StoredPerson = {
  id: 'a1b2c3d4-0001-4a5b-8c6d-000000000009',
  programmeId: PROGRAMME_ONE.id,
  rank: 8,
  displayName: HOSTILE_NAME,
  givenNames: 'Samplemark<img src=x onerror="window.__kasuwaXss=1">',
  familyName: '<b>Testcase</b>',
  companyName: null,
  lead: null,
  phones: [],
  emails: [],
};

/** Under `hostileIds`: hits whose ids are not uuids. The screen must link neither, nor print them. */
export const HOSTILE_CONTACT_ID = '../../admin/audit?export=1#x';
export const HOSTILE_ACCOUNT_ID = 'javascript:alert(1)//';
/** The query that finds both hostile hits (and nothing else). */
export const HOSTILE_QUERY = 'hostiles';
const C_HOSTILE: StoredPerson = {
  id: HOSTILE_CONTACT_ID,
  programmeId: PROGRAMME_ONE.id,
  rank: 9,
  displayName: 'Hostilesample Testcase',
  givenNames: 'Hostilesample',
  familyName: 'Testcase',
  companyName: null,
  lead: null,
  phones: [],
  emails: [],
};
const A_HOSTILE: StoredAccount = { id: HOSTILE_ACCOUNT_ID, programmeId: PROGRAMME_ONE.id, rank: 9, name: 'Hostilesample Example Ltd' };
const SANE_CONTACT_ID = 'a1b2c3d4-0001-4a5b-8c6d-0000000000ff';
const SANE_ACCOUNT_ID = 'a1b2c3d4-0002-4a5b-8c6d-0000000000ff';

/** Under `futureGroup`: a group of a type a later contract may add (R17). */
const FUTURE_GROUP: Json = {
  type: 'ticket',
  hits: [{ type: 'ticket', id: 'a1b2c3d4-0009-4a5b-8c6d-000000000001', programmeId: PROGRAMME_ONE.id, subject: 'Sample ticket fixture' }],
};
export const FUTURE_GROUP_TEXT = 'Sample ticket fixture';

const PEOPLE: readonly StoredPerson[] = [C_SAMPLEWISE, L_FIXTURE, C_SAMPLE, C_SAMPLETON, C_COMPOSED_TRAP, L_SAMPLEFORD, C_NAMELESS];
const ACCOUNTS: readonly StoredAccount[] = [A_HOLDINGS, A_SAMARA];
const DEALS: readonly StoredDeal[] = [D_HOLDINGS, D_SAMARA];

// ---------------------------------------------------------------------------
// Hits, field security applied
// ---------------------------------------------------------------------------

function withheldOf(person: StoredPerson): string[] {
  const withheld = new Set(WITHHELD[person.programmeId] ?? []);
  if (withheld.has('givenNames') || withheld.has('familyName')) withheld.add('displayName');
  return NAME_FIELD_ORDER.filter((field) => withheld.has(field));
}

/** A contact or lead hit: withheld fields omitted, never nulled, and named (D-L68 for displayName). */
export function personHit(person: StoredPerson, type: 'contact' | 'lead'): Json {
  const withheld = withheldOf(person);
  const hit: Json = {
    type,
    id: person.id,
    programmeId: person.programmeId,
    displayName: person.displayName,
    givenNames: person.givenNames,
    familyName: person.familyName,
    companyName: person.companyName,
  };
  if (type === 'lead') hit.status = person.lead;
  hit.withheldFields = withheld;
  for (const field of withheld) delete hit[field];
  return hit;
}

export function accountHit(account: StoredAccount): Json {
  return { type: 'account', id: account.id, programmeId: account.programmeId, name: account.name };
}

export function dealHit(deal: StoredDeal): Json {
  return { type: 'deal', id: deal.id, programmeId: deal.programmeId, pipelineId: deal.pipelineId, name: deal.name };
}

const HIT_SCHEMA: Readonly<Record<SearchType, Json>> = {
  contact: schema('ContactSearchHit'),
  lead: schema('LeadSearchHit'),
  account: schema('AccountSearchHit'),
  deal: schema('DealSearchHit'),
};

function checkHit(hit: Json, type: SearchType, label: string): void {
  const problems = validateBody(hit, HIT_SCHEMA[type], label, CONTRACT, true);
  if (problems.length > 0) {
    throw new Error(`${label} disagrees with ${RECORDS_CONTRACT_SOURCE}: ${problems.join('; ')}`);
  }
}

for (const person of PEOPLE) {
  checkHit(personHit(person, 'contact'), 'contact', `contact ${person.id}`);
  if (person.lead !== null) {
    if (!LEAD_STATUSES.includes(person.lead)) throw new Error(`${person.id}: ${person.lead} is not a lead status`);
    checkHit(personHit(person, 'lead'), 'lead', `lead ${person.id}`);
  }
}
for (const account of ACCOUNTS) checkHit(accountHit(account), 'account', `account ${account.id}`);
for (const deal of DEALS) checkHit(dealHit(deal), 'deal', `deal ${deal.id}`);

/** Verbatim means verbatim: the stored records serve back exactly the contract's example hits. */
function sameJson(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    isJson(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canonical(v)])) : Array.isArray(value) ? value.map(canonical) : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

for (const [served, example, label] of [
  [personHit(C_SAMPLE, 'contact'), EX_C1, 'prefix contact 0'],
  [personHit(C_SAMPLEWISE, 'contact'), EX_C2, 'prefix contact 1'],
  [personHit(L_FIXTURE, 'lead'), EX_L1, 'prefix lead 0'],
  [accountHit(A_HOLDINGS), EX_A1, 'prefix account 0'],
  [dealHit(D_HOLDINGS), EX_D1, 'prefix deal 0'],
  [personHit(C_SAMPLETON, 'contact'), EX_C4, 'withheldNamePart contact 0'],
  [personHit(C_SAMPLEWISE, 'contact'), exampleHit(PHONE_EXAMPLE, 'contact', 0), 'phoneLookup contact 0'],
] as const) {
  if (!sameJson(served, example)) {
    throw new Error(`the ${label} example does not round-trip through the mock: ${JSON.stringify(served)}`);
  }
}

// ---------------------------------------------------------------------------
// The server's answers (the oracle the mock serves)
// ---------------------------------------------------------------------------

export type Caller = 'agent' | 'portal';

const byRank = <T extends { rank: number }>(a: T, b: T): number => a.rank - b.rank;

function readableValue(person: StoredPerson, field: string): string | null {
  const hit = personHit(person, 'contact');
  const value = hit[field];
  return typeof value === 'string' ? value : null;
}

function personMatches(person: StoredPerson, type: 'contact' | 'lead', q: string): boolean {
  const query = folded(q);
  return SEARCH_FIELDS[type].some((field) => {
    const value = readableValue(person, field);
    return value !== null && folded(value).startsWith(query);
  });
}

interface StoreOptions {
  readonly hostileMarkup?: boolean;
  readonly hostileIds?: boolean;
}

function people(options: StoreOptions): StoredPerson[] {
  return [...PEOPLE, ...(options.hostileMarkup === true ? [C_MARKUP] : []), ...(options.hostileIds === true ? [C_HOSTILE] : [])];
}

function accounts(options: StoreOptions): StoredAccount[] {
  return [...ACCOUNTS, ...(options.hostileIds === true ? [A_HOSTILE] : [])];
}

/** searchRecords' answer for a valid `q`, all four types, for `caller`. */
export function searchAnswer(q: string, caller: Caller = 'agent', options: StoreOptions = {}): { groups: Json[] } {
  const groups: Json[] = [];
  for (const type of SEARCH_TYPES) {
    let hits: Json[] = [];
    if (type === 'contact' || type === 'lead') {
      hits = people(options)
        .filter((person) => (type === 'lead' ? person.lead !== null : true))
        .filter((person) => personMatches(person, type, q))
        .sort(byRank)
        .slice(0, 3)
        .map((person) => personHit(person, type));
    } else if (type === 'account') {
      hits = accounts(options)
        .filter((account) => folded(account.name).startsWith(folded(q)))
        .sort(byRank)
        .slice(0, 3)
        .map(accountHit);
    } else if (caller !== 'portal') {
      hits = DEALS.filter((deal) => folded(deal.name).startsWith(folded(q)))
        .sort(byRank)
        .slice(0, 3)
        .map(dealHit);
    }
    groups.push({ type, hits });
  }
  return { groups };
}

/** lookupRecords' answer for a valid body: contacts and leads only, account and deal empty. */
export function lookupAnswer(term: { phone?: string; email?: string }, types: readonly SearchType[] = SEARCH_TYPES): { groups: Json[] } {
  const phone = term.phone === undefined ? null : normalisedPhone(term.phone);
  const email = term.email?.trim().toLowerCase();
  const found = PEOPLE.filter((person) =>
    phone !== null ? person.phones.includes(phone) : email !== undefined && person.emails.includes(email),
  ).sort(byRank);
  return {
    groups: SEARCH_TYPES.filter((type) => types.includes(type)).map((type) => ({
      type,
      hits:
        type === 'contact'
          ? found.slice(0, 3).map((person) => personHit(person, 'contact'))
          : type === 'lead'
            ? found.filter((person) => person.lead !== null).slice(0, 3).map((person) => personHit(person, 'lead'))
            : [],
    })),
  };
}

/** Everything the mock serves, for checks that tell served record data from UI copy (en-XA). */
export function servedData(): string {
  return JSON.stringify({
    people: [...PEOPLE, C_MARKUP, C_HOSTILE].map((person) => personHit(person, 'contact')),
    accounts: [...ACCOUNTS, A_HOSTILE],
    deals: DEALS,
    programmes: [PROGRAMME_ONE, PROGRAMME_TWO, PROGRAMME_THREE],
    lists: [CONTACTS_EXAMPLE, ACCOUNTS_EXAMPLE],
  });
}

/** Stored values field security withholds from this caller: they must never reach the page. */
export const WITHHELD_VALUES: readonly string[] = [
  String(C_SAMPLETON.familyName),
  C_SAMPLETON.displayName,
  String(C_NAMELESS.givenNames),
  String(C_NAMELESS.familyName),
  String(C_NAMELESS.companyName),
  C_NAMELESS.displayName,
];

// ---------------------------------------------------------------------------
// The "see all" landing reads and the shell's own
// ---------------------------------------------------------------------------

const CONTACTS_EXAMPLE = clone(at(CONTRACT, 'paths', CONTACTS_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example')) as Json;
const ACCOUNTS_EXAMPLE = clone(at(CONTRACT, 'paths', ACCOUNTS_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example')) as Json;
const LEADS_PAGE: Json = { data: [], nextCursor: null };
const PROGRAMMES_ANSWER: Json = { data: [clone(PROGRAMME_ONE), clone(PROGRAMME_TWO), clone(PROGRAMME_THREE)] };
const ACCOUNT_OWNER = (ACCOUNTS_EXAMPLE.data as Json[])[0]?.owner as { id: string; displayName: string };
export const CURRENT_USER: Json = {
  id: ACCOUNT_OWNER.id,
  tenantId: TENANT_A,
  email: 'sample.agent@example.test',
  displayName: 'Sample Agent Fixture',
  locale: 'en-NG',
};

for (const [operation, body] of [
  ['listContacts', CONTACTS_EXAMPLE],
  ['listLeads', LEADS_PAGE],
  ['listAccounts', ACCOUNTS_EXAMPLE],
  ['listMyProgrammes', PROGRAMMES_ANSWER],
  ['getCurrentUser', CURRENT_USER],
] as const) {
  const problems = answerProblems(operation, 200, body);
  if (problems.length > 0) {
    throw new Error(`the ${operation} answer disagrees with its contract: ${problems.join('; ')}`);
  }
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export interface SearchMockOptions extends StoreOptions {
  /** Who is searching. Default an agent; a portal user reads no deals (D-L115). */
  readonly caller?: Caller;
  /** Hold every search and lookup until `release()`: the loading frame, without a clock. */
  readonly hold?: boolean;
  /** Hold the search or lookup for exactly these terms (`q`, or the body's phone or email) until `releaseTerm(term)`. */
  readonly holdTerms?: readonly string[];
  /** Abort the search or lookup for these terms (after its hold, if held), as a dropped connection does. */
  readonly failTerms?: readonly string[];
  /** Abort every search and lookup. */
  readonly networkFailure?: boolean;
  /** Add a group of a type this contract does not have to every searchRecords answer (R17). */
  readonly futureGroup?: boolean;
}

export interface LookupCall {
  readonly url: URL;
  readonly contentType: string;
  readonly raw: string;
  readonly body: unknown;
}

export interface SearchMock {
  /** Every /api/v1 request the mock saw, in order. */
  readonly requests: URL[];
  /** searchRecords requests, in order. */
  readonly searchReads: URL[];
  /** lookupRecords requests, in order. */
  readonly lookups: LookupCall[];
  /** listContacts, listLeads and listAccounts requests (the "see all" landings), in order. */
  readonly listReads: URL[];
  /** Reads after `leave()` that no search operation explains (answered 404, not blamed). */
  readonly afterLeave: URL[];
  /** Contract breaches by the SCREEN. Must be empty at the end of every test. */
  readonly violations: string[];
  /** Answers the MOCK built that its contract rejects. Must be empty, always. */
  readonly mockFaults: string[];
  /** The deliberate contract breaches `hostileIds` and `futureGroup` serve. */
  readonly plantedFaults: string[];
  /** Terms whose held request the browser abandoned before the mock answered it. */
  readonly abandoned: string[];
  release(): void;
  releaseTerm(term: string): void;
  /** The journey is following a link off the search: unexplained reads are no longer the screen's fault. */
  leave(): void;
}

export function isSearchRead(request: Request, q?: string): boolean {
  const url = new URL(request.url());
  return request.method() === 'GET' && url.pathname === SEARCH_PATH && (q === undefined || url.searchParams.get('q') === q);
}

export function isLookup(request: Request): boolean {
  return new URL(request.url()).pathname === LOOKUP_PATH;
}

/** The term a search or lookup request carries: `q`, or the body's phone or email. */
export function termOf(request: Request): string | undefined {
  const url = new URL(request.url());
  if (url.pathname === SEARCH_PATH) return url.searchParams.get('q') ?? undefined;
  if (url.pathname === LOOKUP_PATH) {
    try {
      const body = request.postDataJSON() as unknown;
      if (isJson(body)) return typeof body.phone === 'string' ? body.phone : typeof body.email === 'string' ? body.email : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const SEARCH_PARAMETERS = parameterNames('searchRecords');
const LOOKUP_SCHEMA = schema('LookupRequest');
const LIST_OPERATION: Readonly<Record<string, Operation>> = {
  [CONTACTS_PATH]: 'listContacts',
  [LEADS_PATH]: 'listLeads',
  [ACCOUNTS_PATH]: 'listAccounts',
};

export async function installSearchMock(page: Page, options: SearchMockOptions = {}): Promise<SearchMock> {
  const caller = options.caller ?? 'agent';
  const requests: URL[] = [];
  const searchReads: URL[] = [];
  const lookups: LookupCall[] = [];
  const listReads: URL[] = [];
  const afterLeave: URL[] = [];
  const violations: string[] = [];
  const mockFaults: string[] = [];
  const plantedFaults: string[] = [];
  const abandoned: string[] = [];
  let left = false;

  let release: () => void = () => undefined;
  const gate = options.hold === true ? new Promise<void>((done) => (release = done)) : Promise.resolve();
  const termGates = new Map<string, { promise: Promise<void>; open: () => void }>();
  for (const term of options.holdTerms ?? []) {
    let open: () => void = () => undefined;
    const promise = new Promise<void>((done) => (open = done));
    termGates.set(term, { promise, open });
  }

  /** The answer with the planted parts made honest: what the same answer would be with nothing planted. */
  const honest = (body: unknown): unknown => {
    let text = JSON.stringify(body)
      .split(JSON.stringify(HOSTILE_CONTACT_ID))
      .join(JSON.stringify(SANE_CONTACT_ID))
      .split(JSON.stringify(HOSTILE_ACCOUNT_ID))
      .join(JSON.stringify(SANE_ACCOUNT_ID));
    const parsed = JSON.parse(text) as unknown;
    if (isJson(parsed) && Array.isArray(parsed.groups)) {
      parsed.groups = (parsed.groups as Json[]).filter((group) => group.type !== FUTURE_GROUP.type);
      text = JSON.stringify(parsed);
    }
    return JSON.parse(text) as unknown;
  };

  const planting = options.hostileIds === true || options.futureGroup === true;

  const answer = async (route: Route, operation: Operation, status: number, body: unknown, term?: string): Promise<void> => {
    const fine = new Set(planting ? answerProblems(operation, status, honest(body)) : []);
    for (const problem of answerProblems(operation, status, body)) {
      (planting && !fine.has(problem) ? plantedFaults : mockFaults).push(problem);
    }
    try {
      await route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store' },
        body: JSON.stringify(body),
      });
    } catch {
      // The page abandoned the request (an AbortController, a navigation) before it was answered.
      abandoned.push(term ?? operation);
    }
  };

  const fail = async (route: Route, term: string): Promise<void> => {
    try {
      await route.abort('internetdisconnected');
    } catch {
      abandoned.push(term);
    }
  };

  const waitFor = async (term: string): Promise<void> => {
    await gate;
    await termGates.get(term)?.promise;
  };

  const checkHeaders = (request: Request, label: string): void => {
    for (const header of Object.keys(request.headers())) {
      if (/programme|tenant|scope/i.test(header)) {
        violations.push(`${label} was sent a "${header}" header — scope is never supplied`);
      }
    }
  };

  // ----- searchRecords --------------------------------------------------------

  const search = async (route: Route, url: URL): Promise<void> => {
    searchReads.push(url);
    const q = url.searchParams.get('q');
    const term = q ?? '';
    await waitFor(term);
    if (options.networkFailure === true || (options.failTerms ?? []).includes(term)) {
      return fail(route, term);
    }
    const refuse = (path: string, code: string, why: string): Promise<void> => {
      violations.push(`searchRecords${redactedQuery(url)}: ${why}`);
      return answer(route, 'searchRecords', 400, searchRefusal(path, code), term);
    };
    for (const name of new Set(url.searchParams.keys())) {
      if (!SEARCH_PARAMETERS.includes(name)) {
        if (name === 'phone' || name === 'email') {
          return refuse(name, 'identifier_in_url', `a "${name}" parameter puts an identifier in the URL (R21): use lookupRecords`);
        }
        violations.push(`searchRecords${redactedQuery(url)}: the contract declares no "${name}" parameter (no scope, limit, cursor or filter)`);
      }
    }
    if (url.searchParams.getAll('q').length > 1) violations.push(`searchRecords${redactedQuery(url)}: q was sent more than once`);
    // The contract's error order: query_required, identifier_in_url, invalid_string, unknown_type, query_too_short.
    if (q === null) return refuse('q', 'query_required', 'no q');
    if (identifierShaped(q)) {
      return refuse('q', 'identifier_in_url', 'q is phone- or email-shaped: R21 sends it to lookupRecords, never into a URL');
    }
    if (phoneLike(q)) {
      // The contract lets a short run of digits through; the lead's R27 does not.
      violations.push('searchRecords was sent a phone-like q (digits and no letter, D-L135): R27 waits for a whole number and sends it to lookupRecords');
    }
    if (q.length > Q_MAX) return refuse('q', 'invalid_string', `q is ${q.length} characters, over ${Q_MAX}`);
    if (hasControlCharacter(q)) return refuse('q', 'invalid_string', 'q carries a control character');
    const types = url.searchParams.getAll('types');
    if (types.some((type) => !(SEARCH_TYPES as readonly string[]).includes(type))) {
      return refuse('types', 'unknown_type', `types=${types.join(',')} names a type the contract does not have`);
    }
    if (new Set(types).size !== types.length) return refuse('types', 'unknown_type', 'a types value was repeated');
    if (types.length > 0 && types.length !== SEARCH_TYPES.length) {
      violations.push(`searchRecords${redactedQuery(url)}: types narrowed to ${types.join(',')} — the screen searches every type`);
    }
    if (q.length < Q_MIN || folded(q).length < Q_MIN) {
      return refuse('q', 'query_too_short', `q folds to "${folded(q)}", under ${Q_MIN} characters: the screen sends nothing that short`);
    }
    const body = searchAnswer(q, caller, options);
    if (types.length > 0) body.groups = body.groups.filter((group) => types.includes(String(group.type)));
    if (options.futureGroup === true) body.groups.push(clone(FUTURE_GROUP));
    return answer(route, 'searchRecords', 200, body, term);
  };

  // ----- lookupRecords --------------------------------------------------------

  const lookup = async (route: Route, request: Request, url: URL): Promise<void> => {
    const raw = request.postData() ?? '';
    let body: unknown;
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      body = undefined;
    }
    const contentType = request.headers()['content-type'] ?? '';
    lookups.push({ url, contentType, raw, body });
    const term = isJson(body) ? String(body.phone ?? body.email ?? '') : '';
    await waitFor(term);
    if (options.networkFailure === true || (options.failTerms ?? []).includes(term)) {
      return fail(route, term);
    }
    const refuse = (path: string, code: string, why: string): Promise<void> => {
      violations.push(`lookupRecords: ${why}`);
      return answer(route, 'lookupRecords', 400, lookupRefusal(path, code), term);
    };
    if (url.search !== '') {
      violations.push(`lookupRecords was sent a query string (${url.search.length - 1} characters): it takes no parameter at all (R21)`);
    }
    if (!/^application\/json\b/i.test(contentType)) violations.push(`lookupRecords was sent "${contentType}", not application/json`);
    if (!isJson(body)) return refuse('body', 'unknown_property', 'the body is not a JSON object');
    // The contract's error order: unknown_property, one_term_required, invalid_phone, invalid_email, unknown_type.
    const unknown = Object.keys(body).filter((key) => !['phone', 'email', 'types'].includes(key));
    if (unknown.length > 0) return refuse('body', 'unknown_property', `the closed body carries ${unknown.length} property the contract does not have`);
    if (('phone' in body) === ('email' in body)) return refuse('phone', 'one_term_required', 'the body must carry exactly one of phone or email');
    const value = String(body.phone ?? body.email ?? '');
    if (typeof (body.phone ?? body.email) !== 'string') return refuse('phone' in body ? 'phone' : 'email', 'phone' in body ? 'invalid_phone' : 'invalid_email', 'the term is not a string');
    if (!identifierShaped(value)) {
      violations.push('lookupRecords was sent a term that is not phone- or email-shaped: a name belongs to searchRecords');
    }
    if (value !== value.normalize('NFKC')) {
      violations.push('lookupRecords was sent a term that is not NFKC-normalised: R28 normalises before building the body (full-width digits become ASCII)');
    }
    const types = body.types;
    if (types !== undefined) {
      const typeProblems = validateBody(types, (LOOKUP_SCHEMA.properties as Json).types, 'types');
      if (typeProblems.length > 0) return refuse('types', 'unknown_type', typeProblems.join('; '));
      const asked = [...(types as string[])].sort().join(',');
      if (asked !== [...SEARCH_TYPES].sort().join(',') && asked !== 'contact,lead') {
        violations.push(`lookupRecords types=${asked}: ask for all four, or for contact and lead`);
      }
    }
    // A value the API cannot normalise is the API's refusal, not the screen's fault.
    if ('phone' in body) {
      const schemaProblems = validateBody(value, (LOOKUP_SCHEMA.properties as Json).phone, 'phone');
      if (schemaProblems.length > 0 || normalisedPhone(value) === null) {
        return answer(route, 'lookupRecords', 400, errorExample('LookupValidationFailed', 'invalidPhone'), term);
      }
    } else {
      const schemaProblems = validateBody(value.trim(), (LOOKUP_SCHEMA.properties as Json).email, 'email');
      if (schemaProblems.length > 0) {
        return answer(route, 'lookupRecords', 400, errorExample('LookupValidationFailed', 'invalidEmail'), term);
      }
    }
    const answerBody = lookupAnswer(
      'phone' in body ? { phone: value } : { email: value },
      (types as SearchType[] | undefined) ?? SEARCH_TYPES,
    );
    return answer(route, 'lookupRecords', 200, answerBody, term);
  };

  // ----- the "see all" landings -----------------------------------------------

  const list = async (route: Route, url: URL, operation: Operation): Promise<void> => {
    listReads.push(url);
    const allowed = parameterNames(operation);
    const problems: string[] = [];
    for (const name of new Set(url.searchParams.keys())) {
      if (!allowed.includes(name)) problems.push(`${operation} declares no "${name}" parameter`);
    }
    const q = url.searchParams.get('q');
    if (q !== null && identifierShaped(q)) {
      problems.push(`${operation} was sent a phone- or email-shaped q: the search never routes an identifier into a URL (R21)`);
    }
    if (problems.length > 0) {
      violations.push(...problems.map((problem) => `${url.pathname}${redactedQuery(url)}: ${problem}`));
      return answer(route, operation, 400, listRefusal());
    }
    const body = operation === 'listContacts' ? CONTACTS_EXAMPLE : operation === 'listLeads' ? LEADS_PAGE : ACCOUNTS_EXAMPLE;
    return answer(route, operation, 200, clone(body));
  };

  // ----- routing ------------------------------------------------------------------

  await page.route(
    (url) => url.pathname.startsWith('/api/v1/'),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      requests.push(url);
      checkHeaders(request, `${method} ${url.pathname}`);

      if (url.pathname === SEARCH_PATH && method === 'GET') return search(route, url);
      if (url.pathname === LOOKUP_PATH && method === 'POST') return lookup(route, request, url);
      const listing = LIST_OPERATION[url.pathname];
      if (listing !== undefined && method === 'GET') return list(route, url, listing);
      if (url.pathname === PROGRAMMES_PATH && method === 'GET') return answer(route, 'listMyProgrammes', 200, clone(PROGRAMMES_ANSWER));
      if (url.pathname === ME_PATH && method === 'GET') return answer(route, 'getCurrentUser', 200, clone(CURRENT_USER));
      if (left && method === 'GET') {
        afterLeave.push(url);
      } else {
        // Never the path itself: a GET to the lookup with a query would carry the identifier into this message.
        violations.push(`${method} ${url.pathname.replace(/[^/]{40,}/g, '<long>')} is not an operation the search uses`);
      }
      try {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          headers: { 'cache-control': 'no-store' },
          body: JSON.stringify(errorExample('NotFound')),
        });
      } catch {
        abandoned.push(url.pathname);
      }
    },
  );

  return {
    requests,
    searchReads,
    lookups,
    listReads,
    afterLeave,
    violations,
    mockFaults,
    plantedFaults,
    abandoned,
    release: () => release(),
    releaseTerm: (term: string) => termGates.get(term)?.open(),
    leave: () => {
      left = true;
    },
  };
}
