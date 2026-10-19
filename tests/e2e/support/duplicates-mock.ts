import type { Page, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { TENANT_A } from '@kasuwa/db';
import { CUSTOM_FIELDS_PATH, CustomFieldsServer } from './custom-values-mock';

/**
 * The duplicates half of `docs/api/records.openapi.yaml` (tag `duplicates`,
 * T-0093's contract, served by T-0095: listDuplicates,
 * getContactMergePreview, createContactMerge, listContactMerges,
 * undoContactMerge), the reads the screen and its links land on
 * (listMyProgrammes, getCurrentUser, listCustomFields and, for the Contacts
 * journey only, listContacts, getContact and listContactTimeline), and the
 * audit log's two reads (`docs/api/admin.openapi.yaml`), served into the
 * browser by Playwright for T-0097 (the P28 duplicates and merge screen).
 *
 * ---------------------------------------------------------------------------
 * READ FROM THE CONTRACT AT RUN TIME, AND EVERY REQUEST AND ANSWER CHECKED
 *
 * Schemas, the merge vocabulary (`MergeField`), the compliance order
 * (`x-kasuwa-compliance-order`) and every error body come out of the YAML when
 * this module loads. The contract's first listDuplicates page is served
 * verbatim (only its `nextCursor` is set, so there is a second page), and the
 * contract's preview example decides the first pair's compliance outcome.
 * EVERY body the mock answers with is validated strictly against the schema
 * the contract declares for that operation and status: a property the schema
 * does not name is a fault, so the mock can never hand the screen a matched
 * value, a score, a count or a "merged into" pointer the real API does not
 * serve. A fault is the MOCK's, recorded in `mockFaults`, which the spec's
 * `afterEach` requires to be empty.
 *
 * WHAT IS NOT IN THE CONTRACT, AND IS THEREFORE DECLARED HERE
 *
 *   - Programmes: PROGRAMME_ONE (the contract's own), with the sets below, and
 *     PROGRAMME_TWO, which the session reaches and which has no duplicates.
 *   - Contacts: derived from the contract's preview example by spreading it
 *     and overriding named properties. Names and numbers are invented; phones
 *     are the contract's `+234803000000x` placeholders.
 *   - The sets. Page one is the contract's example (a phone pair and an email
 *     pair, one name withheld). Page two holds a set of three (pairwise merge
 *     means two must be picked) and a pair one of whose names is markup.
 *   - The defaults, computed as the contract says and as T-0095 does: for
 *     every MergeField the caller may edit, the side updated more recently if
 *     its value is non-empty, else the other side (equal values included).
 *     So a field absent from `defaults` and not withheld is one the caller
 *     may read but not edit.
 *   - The merges history, relative to the moment the mock is installed (the
 *     30-day window is a real-clock fact): an open merge by the caller, an
 *     open merge by another user, an undone one whose survivor kept its edits,
 *     an expired one, and on a second page an older expired one.
 *   - The caller: the contract's `mergedByUserId`, holding `contact.write`
 *     (role `writer`), or an `agent` (D-P14): every merge `403 not_permitted`
 *     and no merges listed (listContactMerges needs `contact.write`).
 *
 * WHAT THE MOCK ENFORCES ON EVERY REQUEST (recorded as `violations`, the
 * SCREEN's fault; `afterEach` in the spec fails a test that has any)
 *
 *   - Only the operations above under `/api/v1/`. No request header names a
 *     programme, a tenant or a scope, and no query carries `programmeId`.
 *   - listDuplicates: the programme in the path is one listMyProgrammes
 *     served; `cursor` and `limit` only; a cursor exactly as served, for that
 *     programme. NEVER while a `Retry-After` is running (a 429's wait is the
 *     server's to set, D-L163), and never more than 20 in a minute (the
 *     per-user budget: each page is a whole-programme scan).
 *   - getContactMergePreview: `with` only; the two ids are distinct contacts
 *     the screen was served in ONE set.
 *   - createContactMerge: the closed body; `survivorId`/`mergedId` the
 *     `contactId`/`with` of a preview the screen read, with THAT preview's
 *     versions; `choices` naming only keys of that preview's `defaults` (so
 *     never a compliance field, a withheld field or one the caller may not
 *     edit), each `survivor` or `merged`; never a field again after the API
 *     answered `403 field_not_editable` for it; never a pair already merged.
 *   - listContactMerges: `cursor` and `limit` only; a cursor exactly as served.
 *   - undoContactMerge: no body; a merge the screen was served; never one past
 *     its `undoUntil`, already undone, or answered 410 or 404 (the screen must
 *     not offer what cannot be undone).
 * ---------------------------------------------------------------------------
 */

export const RECORDS_CONTRACT_SOURCE = 'docs/api/records.openapi.yaml';
const AUTH_CONTRACT_SOURCE = 'docs/api/auth.openapi.yaml';
export const ADMIN_CONTRACT_SOURCE = 'docs/api/admin.openapi.yaml';

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
 * that declares properties as closed: used on the mock's OWN answers. What the
 * screen sends is judged by the contract's own `additionalProperties`.
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
  }
  if (typeof value === 'number') {
    if (typeof spec.minimum === 'number' && value < spec.minimum) problems.push(`${where} is below ${spec.minimum}`);
    if (typeof spec.maximum === 'number' && value > spec.maximum) problems.push(`${where} is above ${spec.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof spec.maxItems === 'number' && value.length > spec.maxItems) problems.push(`${where} has too many items`);
    if (typeof spec.minItems === 'number' && value.length < spec.minItems) problems.push(`${where} has too few items`);
    if (spec.items !== undefined) {
      value.forEach((item, index) => problems.push(...validateBody(item, spec.items, `${path}.${index}`, located.doc, strict)));
    }
  }
  if (isJson(value)) {
    if (isJson(spec.propertyNames)) {
      for (const key of Object.keys(value)) problems.push(...validateBody(key, spec.propertyNames, `${path ? `${path}.` : ''}${key} (name)`, located.doc, false));
    }
    if (spec.properties !== undefined || spec.required !== undefined || spec.additionalProperties !== undefined) {
      const properties = (spec.properties ?? {}) as Json;
      for (const key of (spec.required ?? []) as string[]) {
        if (!(key in value)) problems.push(`${path ? `${path}.` : ''}${key} is required`);
      }
      for (const [key, item] of Object.entries(value)) {
        const child = `${path ? `${path}.` : ''}${key}`;
        if (key in properties) {
          problems.push(...validateBody(item, properties[key], child, located.doc, strict));
        } else if (isJson(spec.additionalProperties)) {
          problems.push(...validateBody(item, spec.additionalProperties, child, located.doc, strict));
        } else if (spec.additionalProperties === false) {
          problems.push(`${child} is not a property of this closed body`);
        } else if (strict && spec.properties !== undefined) {
          problems.push(`${child} is not a property the contract declares`);
        }
      }
    }
  }
  return problems;
}

export const DUPLICATES_PATH = '/api/v1/programmes/{programmeId}/duplicates';
export const MERGES_PATH = '/api/v1/contact-merges';
const CONTACTS_PATH = '/api/v1/contacts';
const PROGRAMMES_PATH = '/api/v1/me/programmes';
const ME_PATH = '/api/v1/auth/me';

const OP = {
  listDuplicates: [DUPLICATES_PATH, 'get'],
  getContactMergePreview: [`${CONTACTS_PATH}/{contactId}/merge-preview`, 'get'],
  createContactMerge: [MERGES_PATH, 'post'],
  listContactMerges: [MERGES_PATH, 'get'],
  undoContactMerge: [`${MERGES_PATH}/{mergeId}/undo`, 'post'],
  listContacts: [CONTACTS_PATH, 'get'],
  getContact: [`${CONTACTS_PATH}/{contactId}`, 'get'],
  listContactTimeline: [`${CONTACTS_PATH}/{contactId}/timeline`, 'get'],
  listMyProgrammes: [PROGRAMMES_PATH, 'get'],
  getCurrentUser: [ME_PATH, 'get'],
} as const;

export type Operation = keyof typeof OP;

/** The five duplicates operations, for the error-localisation check. */
export const DUPLICATES_OPERATIONS: readonly Operation[] = ['listDuplicates', 'getContactMergePreview', 'createContactMerge', 'listContactMerges', 'undoContactMerge'];

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

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// The contract's own vocabularies
// ---------------------------------------------------------------------------

/** The standard fields a merge may choose (MergeField's enum). */
export const MERGE_FIELDS: readonly string[] = (schema('MergeField').enum as unknown[]).map(String);
/** `x-kasuwa-compliance-order`, most restrictive first (D-P28). */
export const COMPLIANCE_ORDER = clone(at(CONTRACT, 'paths', MERGES_PATH, 'post', 'x-kasuwa-compliance-order')) as Readonly<Record<string, readonly unknown[]>>;
export const COMPLIANCE_FIELDS: readonly string[] = Object.keys(COMPLIANCE_ORDER);
export const MATCH_ON: readonly string[] = (schema('DuplicateMatchOn').enum as unknown[]).map(String);
export const CONSENT_STATES: readonly string[] = (schema('ConsentState').enum as unknown[]).map(String);

for (const field of COMPLIANCE_FIELDS) {
  if (MERGE_FIELDS.includes(field)) throw new Error(`${RECORDS_CONTRACT_SOURCE}: MergeField now admits ${field}; T-0097's suite must be re-pinned (D-P28)`);
}

// ---------------------------------------------------------------------------
// Programmes, the caller, the contacts and the sets
// ---------------------------------------------------------------------------

export interface Programme {
  id: string;
  name: string;
}

export const PROGRAMME_ONE = clone(
  at(CONTRACT, 'paths', PROGRAMMES_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', '0'),
) as Programme;
/** The session reaches it; it has no duplicates. */
export const PROGRAMME_TWO: Programme = { id: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a02', name: 'Sample Fixture Care' };
const PROGRAMMES_ANSWER: Json = { data: [clone(PROGRAMME_ONE), clone(PROGRAMME_TWO)] };

const MERGE_EXAMPLE = clone(at(CONTRACT, 'paths', MERGES_PATH, 'post', 'responses', '201', 'content', 'application/json', 'examples', 'merged', 'value')) as Json;
export const CALLER_ID = String(MERGE_EXAMPLE.mergedByUserId);
/** Another member of the programme, who merged HM_OTHER. */
export const OTHER_USER_ID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02';
export const CURRENT_USER: Json = {
  id: CALLER_ID,
  tenantId: TENANT_A,
  email: 'sample.merger@example.test',
  displayName: 'Sample Merger Fixture',
  locale: 'en-NG',
};

const PREVIEW_EXAMPLE = clone(
  at(CONTRACT, 'paths', `${CONTACTS_PATH}/{contactId}/merge-preview`, 'get', 'responses', '200', 'content', 'application/json', 'examples', 'preview', 'value'),
) as Json;
const LIST_EXAMPLE = clone(at(CONTRACT, 'paths', DUPLICATES_PATH, 'get', 'responses', '200', 'content', 'application/json', 'examples', 'page', 'value')) as Json;

/** A contact as stored: every Contact property, before field security. */
type Stored = Json & { id: string; programmeId: string; version: number; displayName: string; updatedAt: string };

const BASE = clone(PREVIEW_EXAMPLE.survivor) as Stored;

function derive(overrides: Json): Stored {
  return { ...clone(BASE), withheldFields: [], ...overrides } as Stored;
}

/** Markup a person's name may hold: it must be drawn as text, never parsed. */
export const HOSTILE_NAME = '<img src=x onerror="window.__kasuwaXss=1">Bùkọ́lá <b>Adé</b>';
export const HOSTILE_COMPANY = '<script>window.__kasuwaXss=2</script>Adé <i>Textiles</i>';

/** The contract example's survivor, as the first phone pair's older side. */
export const A1 = derive({ ...(clone(PREVIEW_EXAMPLE.survivor) as Json) });
/** The example's merged side; the list example calls it "A. Okonkwo". */
export const A2 = derive({ ...(clone(PREVIEW_EXAMPLE.merged) as Json), displayName: 'A. Okonkwo' });
/** The email pair: B1's name is withheld from the caller in the list (the list example's `null`). */
export const B1 = derive({ id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e03', displayName: 'Sample Withheld Fixture', givenNames: null, familyName: null, emails: ['sample.shared@example.test'], phones: [{ type: 'mobile', e164: '+2348030000003' }], updatedAt: '2026-10-12T08:15:00Z' });
export const B2 = derive({ id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e04', displayName: 'Tunde Bakare', givenNames: 'Tunde', familyName: 'Bakare', emails: ['sample.shared@example.test'], phones: [{ type: 'mobile', e164: '+2348030000004' }], dnd: false, whatsappOptIn: false, consentState: 'unknown', updatedAt: '2026-10-09T16:45:00Z' });
/** A set of three (page two): pairwise merge, so two must be picked. */
export const C1 = derive({ id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e11', displayName: 'Chinedu Eze', givenNames: 'Chinedu', familyName: 'Eze', phones: [{ type: 'mobile', e164: '+2348030000005' }], emails: [], updatedAt: '2026-10-11T10:00:00Z' });
export const C2 = derive({ id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e12', displayName: 'Chinedu E.', givenNames: 'Chinedu', familyName: null, phones: [{ type: 'mobile', e164: '+2348030000005' }], emails: [], status: 'new', updatedAt: '2026-10-13T10:00:00Z' });
export const C3 = derive({ id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e13', displayName: 'C. Eze', givenNames: null, familyName: 'Eze', phones: [{ type: 'mobile', e164: '+2348030000005' }], emails: [], updatedAt: '2026-10-08T10:00:00Z' });
/** A pair one of whose names and company is markup (page two). */
export const H1 = derive({ id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e21', displayName: HOSTILE_NAME, givenNames: null, familyName: null, companyName: HOSTILE_COMPANY, emails: ['sample.markup@example.test'], phones: [{ type: 'mobile', e164: '+2348030000006' }], updatedAt: '2026-10-15T10:00:00Z' });
export const H2 = derive({ id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e22', displayName: 'Bukola Ade', givenNames: 'Bukola', familyName: 'Ade', companyName: null, emails: ['sample.markup@example.test'], phones: [{ type: 'mobile', e164: '+2348030000007' }], updatedAt: '2026-10-07T10:00:00Z' });

export const CONTACTS: readonly Stored[] = [A1, A2, B1, B2, C1, C2, C3, H1, H2];

/** Every person-identifying value the fixtures hold: none may reach the console, a URL or the title. */
export const PII_VALUES: readonly string[] = [
  ...new Set(
    CONTACTS.flatMap((contact) => [
      contact.displayName,
      ...((contact.phones ?? []) as { e164: string }[]).map((phone) => phone.e164),
      ...((contact.emails ?? []) as string[]),
    ]),
  ),
].filter((value) => value.length >= 6);

interface SetDef {
  readonly matchOn: 'phone' | 'email';
  readonly members: readonly string[];
}

/** Set definitions per page, by contact id, in served order. */
const PAGES: readonly (readonly SetDef[])[] = [
  [
    { matchOn: 'phone', members: [A1.id, A2.id] },
    { matchOn: 'email', members: [B1.id, B2.id] },
  ],
  [
    { matchOn: 'phone', members: [C1.id, C2.id, C3.id] },
    { matchOn: 'email', members: [H1.id, H2.id] },
  ],
];
/** Names the caller may not read in the LIST (DuplicateContact.displayName null). */
const LIST_NAME_WITHHELD = new Set([B1.id]);

/** Opaque, as served; the screen echoes it, never builds one. */
export const SETS_CURSOR = 'ZHVwOnYxOjNmMGM5YTUyLTZkMWUtNGI4YS05ZjJlLTFhMmIzYzRkNWUwMzplbWFpbDow';
export const MERGES_CURSOR = 'bXJnOnYxOjlhMWIyYzNkLTRlNWYtNGE2MC04YjcxLThjOWQwZTFmMmEwNA';

// ---------------------------------------------------------------------------
// The merges history, relative to installation (the window is a real-clock fact)
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const WINDOW = 30 * DAY;

export const HM_OPEN_ID = '9a1b2c3d-4e5f-4a60-8b71-8c9d0e1f2a11';
export const HM_OTHER_ID = '9a1b2c3d-4e5f-4a60-8b71-8c9d0e1f2a12';
export const HM_UNDONE_ID = '9a1b2c3d-4e5f-4a60-8b71-8c9d0e1f2a13';
export const HM_EXPIRED_ID = '9a1b2c3d-4e5f-4a60-8b71-8c9d0e1f2a14';
export const HM_OLD_ID = '9a1b2c3d-4e5f-4a60-8b71-8c9d0e1f2a15';

/** Names in the history, for the en-XA and markup checks. */
export const HISTORY_NAMES: readonly string[] = ['Ngozi Adebayo', 'Ngozi A.', 'Halima Musa', 'H. Musa', 'Tunde Bakare', 'Emeka Obi', 'E. Obi', 'Ifeanyi Okeke', 'I. Okeke'];

function historyMerge(id: string, survivor: [string, string | null], merged: [string, string | null], mergedAgoDays: number, by: string, undone?: { afterDays: number; reverted: boolean }): Json {
  const mergedAt = Date.now() - mergedAgoDays * DAY;
  return {
    ...clone(MERGE_EXAMPLE),
    id,
    survivor: { id: survivor[0], displayName: survivor[1] },
    merged: { id: merged[0], displayName: merged[1] },
    mergedByUserId: by,
    mergedAt: isoSeconds(mergedAt),
    undoUntil: isoSeconds(mergedAt + WINDOW),
    undoneAt: undone === undefined ? null : isoSeconds(mergedAt + undone.afterDays * DAY),
    undoneByUserId: undone === undefined ? null : by,
    survivorReverted: undone === undefined ? null : undone.reverted,
  };
}

function buildHistory(): Json[] {
  return [
    historyMerge(HM_OPEN_ID, ['3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e31', 'Ngozi Adebayo'], ['3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e32', 'Ngozi A.'], 2, CALLER_ID),
    historyMerge(HM_OTHER_ID, ['3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e37', 'Halima Musa'], ['3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e38', 'H. Musa'], 5, OTHER_USER_ID),
    // The contract's second list example: a survivor name withheld, undone, survivor edited since.
    historyMerge(HM_UNDONE_ID, ['3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e35', null], ['3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e36', 'Tunde Bakare'], 12, CALLER_ID, { afterDays: 1, reverted: false }),
    historyMerge(HM_EXPIRED_ID, ['3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e33', 'Emeka Obi'], ['3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e34', 'E. Obi'], 40, CALLER_ID),
  ];
}

function buildOlder(): Json[] {
  return [historyMerge(HM_OLD_ID, ['3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e39', 'Ifeanyi Okeke'], ['3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e40', 'I. Okeke'], 60, CALLER_ID)];
}

// ---------------------------------------------------------------------------
// Field security, defaults and compliance, as the contract describes them
// ---------------------------------------------------------------------------

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

/** A Contact as the caller sees it: withheld properties absent and named. */
function visible(contact: Stored, withheld: ReadonlySet<string>): Json {
  const out: Json = clone(contact);
  const names: string[] = [];
  for (const field of [...MERGE_FIELDS, ...COMPLIANCE_FIELDS]) {
    if (withheld.has(field) && field !== 'displayName' && field in out) {
      delete out[field];
      names.push(field);
    }
  }
  out.withheldFields = names;
  return out;
}

/** The side whose value each choosable field defaults to (T-0095's rule, M16). */
function defaultsFor(survivor: Stored, merged: Stored, editable: (field: string) => boolean): Json {
  const mergedIsNewer = Date.parse(merged.updatedAt) > Date.parse(survivor.updatedAt);
  const out: Json = {};
  for (const field of MERGE_FIELDS) {
    if (!editable(field)) continue;
    const order: ('survivor' | 'merged')[] = mergedIsNewer ? ['merged', 'survivor'] : ['survivor', 'merged'];
    const value = (side: 'survivor' | 'merged') => (side === 'survivor' ? survivor[field] : merged[field]);
    out[field] = order.find((side) => !isEmpty(value(side))) ?? 'survivor';
  }
  return out;
}

/** The most restrictive of two values by `x-kasuwa-compliance-order`. */
export function mostRestrictive(field: string, left: unknown, right: unknown): unknown {
  const order = COMPLIANCE_ORDER[field] ?? [];
  const rank = (value: unknown) => {
    const index = order.indexOf(value);
    return index < 0 ? order.length : index;
  };
  return rank(left) <= rank(right) ? left : right;
}

function complianceOutcome(survivor: Stored, merged: Stored, withheld: ReadonlySet<string>): Json {
  const out: Json = { withheldFields: [] };
  for (const field of COMPLIANCE_FIELDS) {
    if (withheld.has(field)) {
      (out.withheldFields as string[]).push(field);
      continue;
    }
    out[field] = mostRestrictive(field, survivor[field], merged[field]);
  }
  return out;
}

// Load-time checks: the contract's examples are served verbatim, and everything stored validates.
for (const contact of CONTACTS) {
  if (contact.programmeId !== PROGRAMME_ONE.id) throw new Error(`contact ${contact.id} is not in PROGRAMME_ONE: the contract's examples no longer agree on the programme`);
  const problems = answerProblems('getContact', 200, visible(contact, new Set()));
  if (problems.length > 0) throw new Error(`contact ${contact.id} disagrees with ${RECORDS_CONTRACT_SOURCE}: ${problems.join('; ')}`);
}
{
  // The example pair's outcome is the contract's own example (D-P28: the stricter side wins, whichever survives).
  const outcome = complianceOutcome(A1, A2, new Set());
  const want = PREVIEW_EXAMPLE.compliance as Json;
  for (const field of COMPLIANCE_FIELDS) {
    if (outcome[field] !== want[field]) throw new Error(`the compliance outcome for the example pair is not the contract's (${field}): re-pin the duplicates mock`);
  }
  if (outcome.consentState === A1.consentState) throw new Error('the example pair no longer shows the outcome differing from the main record: the compliance journey would prove nothing');
}

function setsOf(page: readonly SetDef[], live: ReadonlyMap<string, Stored>): Json[] {
  return page
    .map((set) => ({
      matchOn: set.matchOn,
      contacts: set.members
        .map((id) => live.get(id))
        .filter((contact): contact is Stored => contact !== undefined)
        .map((contact) => ({ id: contact.id, displayName: LIST_NAME_WITHHELD.has(contact.id) ? null : contact.displayName, updatedAt: contact.updatedAt })),
    }))
    .filter((set) => set.contacts.length >= 2);
}

{
  const first = { data: setsOf(PAGES[0] ?? [], new Map(CONTACTS.map((contact) => [contact.id, contact]))), nextCursor: null };
  if (JSON.stringify(first) !== JSON.stringify(LIST_EXAMPLE)) {
    throw new Error('the first page of sets no longer IS the contract’s listDuplicates example: re-pin the duplicates mock');
  }
}
for (const [operation, body] of [
  ['listMyProgrammes', PROGRAMMES_ANSWER],
  ['getCurrentUser', CURRENT_USER],
  ['listContactMerges', { data: [...buildHistory(), ...buildOlder()], nextCursor: null }],
] as const) {
  const problems = answerProblems(operation, 200, body);
  if (problems.length > 0) throw new Error(`the ${operation} answer disagrees with its contract: ${problems.join('; ')}`);
}

/** Everything the mock may serve as record data (names, programme names), for the en-XA check. */
export function servedData(): string {
  return JSON.stringify({ contacts: CONTACTS, history: [...buildHistory(), ...buildOlder()], programmes: PROGRAMMES_ANSWER, user: CURRENT_USER });
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export interface DuplicatesMockOptions {
  /** `agent` (D-P14): every merge is 403 not_permitted and no merges are listed. Default `writer`. */
  readonly role?: 'writer' | 'agent';
  /** listDuplicates calls (1-based) answered 429 with `Retry-After: retryAfter`. */
  readonly rateLimited?: { readonly calls: readonly number[]; readonly retryAfter: number };
  /** Fields withheld from the caller on every preview (standard or compliance). */
  readonly withheld?: readonly string[];
  /** Fields the caller may read but not edit: left out of every preview's defaults. */
  readonly notEditable?: readonly string[];
  /** Fields in the defaults that the API refuses at merge time (403 field_not_editable), once chosen. */
  readonly revokedOnMerge?: readonly string[];
  /** The first createContactMerge answers this. */
  readonly mergeRefusal?: 'already_merged' | 'stale_write' | 'not_found';
  /** The first undoContactMerge answers this. */
  readonly undoRefusal?: 'not_found' | 'not_permitted' | 'expired' | 'already_merged';
  /** Undo finds the survivor edited since the merge: `survivorReverted: false`. */
  readonly survivorEdited?: boolean;
  /** No merges listed. */
  readonly emptyHistory?: boolean;
  /**
   * The journey also visits screens this mock does not own (the Contacts list
   * and the contact record): an undeclared GET is answered 404 and recorded in
   * `otherReads`, not as a violation.
   */
  readonly otherScreens?: boolean;
}

export interface ApiCall {
  readonly operation: Operation;
  readonly url: URL;
  readonly raw: string;
  readonly body: unknown;
  readonly at: number;
}

interface Preview {
  readonly survivorId: string;
  readonly mergedId: string;
  readonly survivorVersion: number;
  readonly mergedVersion: number;
  readonly defaults: readonly string[];
}

export interface DuplicatesMock {
  /** Every /api/v1 request, in order. */
  readonly requests: URL[];
  /** Every declared call, in order, with its body. */
  readonly calls: ApiCall[];
  /** When each listDuplicates 429 was answered, and its Retry-After in seconds. */
  readonly throttles: { readonly at: number; readonly retryAfter: number }[];
  /** listContacts reads (the Contacts journey). */
  readonly contactReads: URL[];
  /** Undeclared GETs answered 404 under `otherScreens`. */
  readonly otherReads: string[];
  /** Contract breaches by the SCREEN. Must be empty at the end of every test. */
  readonly violations: string[];
  /** Answers the MOCK built that its contract rejects. Must be empty, always. */
  readonly mockFaults: string[];
  /** Calls of one operation. */
  callsOf(operation: Operation): ApiCall[];
  /** Ids merged away and not restored. */
  mergedAway(): string[];
  /** The id of every merge the screen made, in order. */
  merges(): string[];
  /** The stored contact, as it now is. */
  contact(id: string): Json | undefined;
}

export async function installDuplicatesMock(page: Page, options: DuplicatesMockOptions = {}): Promise<DuplicatesMock> {
  const requests: URL[] = [];
  const calls: ApiCall[] = [];
  const throttles: { at: number; retryAfter: number }[] = [];
  const contactReads: URL[] = [];
  const otherReads: string[] = [];
  const violations: string[] = [];
  const mockFaults: string[] = [];
  const custom = new CustomFieldsServer(undefined, violations);
  const role = options.role ?? 'writer';
  const withheld = new Set(options.withheld ?? []);
  const notEditable = new Set(options.notEditable ?? []);
  const revoked = new Set(options.revokedOnMerge ?? []);
  const refusedFields = new Set<string>();
  const live = new Map(CONTACTS.map((contact) => [contact.id, clone(contact)]));
  const away = new Map<string, Stored>();
  const servedSets: string[][] = [];
  const servedSetsCursors = new Map<string, string>();
  const previews: Preview[] = [];
  const history = options.emptyHistory === true || role === 'agent' ? [] : buildHistory();
  const older = options.emptyHistory === true || role === 'agent' ? [] : buildOlder();
  const made: Json[] = [];
  const servedMerges = new Set<string>();
  const deadMerges = new Set<string>();
  let listDuplicatesCount = 0;
  let throttledUntil = 0;
  let mergeCount = 0;
  let undoCount = 0;
  let listMergesHidden = false;

  for (const merge of [...history, ...older]) {
    const party = merge.merged as { id: string; displayName: string | null };
    if (merge.undoneAt === null) away.set(party.id, derive({ id: party.id, displayName: party.displayName ?? 'Sample Fixture' }));
  }

  const answer = async (route: Route, operation: Operation, status: number, body: unknown, headers: Record<string, string> = {}): Promise<void> => {
    for (const problem of answerProblems(operation, status, body)) mockFaults.push(problem);
    try {
      await route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store', ...headers }, body: JSON.stringify(body) });
    } catch {
      // The page abandoned the request before it was answered.
    }
  };

  const notFound = (route: Route, operation: Operation): Promise<void> => answer(route, operation, 404, errorExample('NotFound'));

  const badParameters = (call: ApiCall, operation: Operation): boolean => {
    const allowed = parameterNames(operation);
    let bad = false;
    for (const name of new Set(call.url.searchParams.keys())) {
      if (!allowed.includes(name)) {
        violations.push(`${operation} declares no "${name}" parameter (scope is the session's, and there is no count)`);
        bad = true;
      }
    }
    const limit = call.url.searchParams.get('limit');
    if (limit !== null && !(Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 100)) {
      violations.push(`${operation} limit=${limit} is outside 1..100`);
      bad = true;
    }
    return bad;
  };

  // ----- listDuplicates ------------------------------------------------------

  const listDuplicates = async (route: Route, call: ApiCall, programmeId: string): Promise<void> => {
    listDuplicatesCount += 1;
    const now = Date.now();
    if (now < throttledUntil - 250) {
      violations.push(`listDuplicates was sent ${Math.round((throttledUntil - now) / 100) / 10} s before the 429's Retry-After ran out: the screen must wait, not hammer (D-L163)`);
    }
    const recent = calls.filter((other) => other.operation === 'listDuplicates' && other.at > now - 60_000).length;
    if (recent > 20) violations.push(`${recent} listDuplicates calls in a minute: the per-user budget is 20 (D-L163), and each is a whole-programme scan`);
    if (badParameters(call, 'listDuplicates')) return answer(route, 'listDuplicates', 400, refusal('ValidationFailed', 'badField', [{ path: 'query', code: 'invalid_string' }]));
    if (!UUID_PATTERN.test(programmeId)) {
      violations.push('listDuplicates was sent a programme id that is not a uuid');
      return answer(route, 'listDuplicates', 400, refusal('ValidationFailed', 'badField', [{ path: 'programmeId', code: 'invalid_string' }]));
    }
    if (programmeId !== PROGRAMME_ONE.id && programmeId !== PROGRAMME_TWO.id) {
      violations.push('listDuplicates named a programme listMyProgrammes never served');
      return notFound(route, 'listDuplicates');
    }
    const limited = options.rateLimited;
    if (limited !== undefined && limited.calls.includes(listDuplicatesCount)) {
      throttles.push({ at: now, retryAfter: limited.retryAfter });
      throttledUntil = now + limited.retryAfter * 1000;
      return answer(route, 'listDuplicates', 429, errorExample('DuplicatesTooManyRequests', 'tooManyRequests'), { 'retry-after': String(limited.retryAfter) });
    }
    const cursor = call.url.searchParams.get('cursor');
    if (programmeId === PROGRAMME_TWO.id) {
      if (cursor !== null) violations.push('listDuplicates sent a cursor for a programme that was never given one');
      return answer(route, 'listDuplicates', 200, { data: [], nextCursor: null });
    }
    let index = 0;
    if (cursor !== null) {
      if (servedSetsCursors.get(cursor) !== programmeId) {
        violations.push('listDuplicates was sent a cursor the mock never served for this programme (echo nextCursor unchanged)');
        return answer(route, 'listDuplicates', 400, refusal('ValidationFailed', 'badCursor', [{ path: 'cursor', code: 'invalid_cursor' }]));
      }
      index = 1;
    }
    const data = setsOf(PAGES[index] ?? [], live);
    for (const set of data) servedSets.push((set.contacts as { id: string }[]).map((contact) => contact.id));
    const nextCursor = index === 0 ? SETS_CURSOR : null;
    if (nextCursor !== null) servedSetsCursors.set(nextCursor, programmeId);
    return answer(route, 'listDuplicates', 200, { data, nextCursor });
  };

  // ----- getContactMergePreview ---------------------------------------------

  const editable = (field: string): boolean => !withheld.has(field) && !notEditable.has(field) && !refusedFields.has(field);

  const preview = async (route: Route, call: ApiCall, contactId: string): Promise<void> => {
    if (badParameters(call, 'getContactMergePreview')) return answer(route, 'getContactMergePreview', 400, refusal('ValidationFailed', 'badField', [{ path: 'query', code: 'invalid_string' }]));
    const other = call.url.searchParams.get('with') ?? '';
    if (!UUID_PATTERN.test(contactId) || !UUID_PATTERN.test(other)) {
      violations.push('getContactMergePreview was sent an id that is not a uuid');
      return answer(route, 'getContactMergePreview', 400, refusal('ValidationFailed', 'badField', [{ path: 'with', code: 'invalid_string' }]));
    }
    if (contactId === other) {
      violations.push('getContactMergePreview was asked to merge a contact with itself');
      return answer(route, 'getContactMergePreview', 400, errorExample('MergePreviewInvalid', 'sameContact'));
    }
    if (!servedSets.some((set) => set.includes(contactId) && set.includes(other))) {
      violations.push('getContactMergePreview named two contacts the screen was never served in one set');
    }
    const survivor = live.get(contactId);
    const merged = live.get(other);
    if (survivor === undefined || merged === undefined) return notFound(route, 'getContactMergePreview');
    const defaults = defaultsFor(survivor, merged, editable);
    previews.push({ survivorId: survivor.id, mergedId: merged.id, survivorVersion: survivor.version, mergedVersion: merged.version, defaults: Object.keys(defaults) });
    return answer(route, 'getContactMergePreview', 200, {
      survivor: visible(survivor, withheld),
      merged: visible(merged, withheld),
      defaults,
      compliance: complianceOutcome(survivor, merged, withheld),
    });
  };

  // ----- createContactMerge -------------------------------------------------

  const createMerge = async (route: Route, call: ApiCall): Promise<void> => {
    mergeCount += 1;
    const body = call.body;
    const sentChoices = isJson(body) && isJson(body.choices) ? body.choices : {};
    const compliance = Object.keys(sentChoices).filter((key) => COMPLIANCE_FIELDS.includes(key));
    if (compliance.length > 0) {
      violations.push(`createContactMerge chose ${compliance.join(', ')}: compliance is never choosable (D-P28)`);
      return answer(route, 'createContactMerge', 400, refusal('MergeInvalid', 'complianceNotChoosable', compliance.map((key) => ({ path: `choices.${key}`, code: 'compliance_not_choosable' }))));
    }
    const problems = validateBody(body, schema('CreateContactMergeRequest'), '');
    if (!isJson(body) || problems.length > 0) {
      violations.push(`createContactMerge: ${problems.join('; ') || 'not a JSON object'}`);
      return answer(route, 'createContactMerge', 400, refusal('ValidationFailed', 'badField', [{ path: 'body', code: 'invalid_string' }]));
    }
    const choices = sentChoices as Record<string, string>;
    const survivorId = String(body.survivorId);
    const mergedId = String(body.mergedId);
    const read = [...previews].reverse().find((entry) => entry.survivorId === survivorId && entry.mergedId === mergedId);
    if (read === undefined) {
      violations.push('createContactMerge named a pair (survivor, merged) the screen never previewed in that order');
    } else {
      if (read.survivorVersion !== body.survivorVersion || read.mergedVersion !== body.mergedVersion) {
        violations.push('createContactMerge sent versions other than those of the last preview of the pair');
      }
      for (const key of Object.keys(choices)) {
        if (!read.defaults.includes(key)) violations.push(`createContactMerge chose ${key}, which the preview did not offer (withheld or not editable: a merge is never a way round field security)`);
      }
    }
    for (const key of Object.keys(choices)) {
      if (refusedFields.has(key)) violations.push(`createContactMerge chose ${key} again after the API answered field_not_editable for it`);
    }
    if (away.has(mergedId) && made.some((merge) => (merge.merged as Json).id === mergedId && merge.undoneAt === null)) {
      violations.push('createContactMerge was sent again for a pair the screen had already merged');
    }
    const survivor = live.get(survivorId);
    const merged = live.get(mergedId);
    if (away.has(mergedId) || away.has(survivorId)) {
      return answer(route, 'createContactMerge', 409, errorExample('MergeConflict', 'alreadyMerged'));
    }
    if (survivor === undefined || merged === undefined) return notFound(route, 'createContactMerge');
    if (role === 'agent') return answer(route, 'createContactMerge', 403, errorExample('MergeNotPermitted', 'action'));
    if (mergeCount === 1 && options.mergeRefusal === 'already_merged') {
      // Someone else merged it away meanwhile.
      live.delete(mergedId);
      away.set(mergedId, merged);
      return answer(route, 'createContactMerge', 409, errorExample('MergeConflict', 'alreadyMerged'));
    }
    if (mergeCount === 1 && options.mergeRefusal === 'stale_write') {
      survivor.version += 1;
      survivor.updatedAt = isoSeconds(Date.now());
      return answer(route, 'createContactMerge', 409, errorExample('MergeConflict', 'stale'));
    }
    if (mergeCount === 1 && options.mergeRefusal === 'not_found') {
      live.delete(mergedId);
      return notFound(route, 'createContactMerge');
    }
    if (survivor.version !== body.survivorVersion || merged.version !== body.mergedVersion) {
      return answer(route, 'createContactMerge', 409, errorExample('MergeConflict', 'stale'));
    }
    // A field the caller may not edit, or that is withheld, is 403 field_not_editable (T-0095, D-L162).
    const refused = Object.keys(choices).filter((key) => revoked.has(key) || !MERGE_FIELDS.includes(key) || !editable(key));
    if (refused.length > 0) {
      for (const key of refused) refusedFields.add(key);
      return answer(route, 'createContactMerge', 403, refusal('MergeNotPermitted', 'field', refused.map((key) => ({ path: `choices.${key}`, code: 'field_not_editable' }))));
    }
    const defaults = defaultsFor(survivor, merged, editable) as Record<string, string>;
    for (const field of Object.keys(defaults)) {
      const side = choices[field] ?? defaults[field];
      if (side === 'merged') survivor[field] = clone(merged[field]);
    }
    for (const field of COMPLIANCE_FIELDS) survivor[field] = mostRestrictive(field, survivor[field], merged[field]);
    survivor.version += 1;
    survivor.updatedAt = isoSeconds(Date.now());
    live.delete(mergedId);
    away.set(mergedId, merged);
    const now = Date.now();
    const record: Json = {
      id: `9a1b2c3d-4e5f-4a60-8b71-8c9d0e1f3${String(made.length + 1).padStart(3, '0')}`,
      programmeId: PROGRAMME_ONE.id,
      survivor: { id: survivor.id, displayName: survivor.displayName },
      merged: { id: merged.id, displayName: merged.displayName },
      mergedByUserId: CALLER_ID,
      mergedAt: isoSeconds(now),
      undoUntil: isoSeconds(now + WINDOW),
      undoneAt: null,
      undoneByUserId: null,
      survivorReverted: null,
    };
    made.push(record);
    servedMerges.add(String(record.id));
    return answer(route, 'createContactMerge', 201, clone(record));
  };

  // ----- listContactMerges and undoContactMerge -----------------------------

  const listMerges = async (route: Route, call: ApiCall): Promise<void> => {
    if (badParameters(call, 'listContactMerges')) return answer(route, 'listContactMerges', 400, refusal('ValidationFailed', 'badField', [{ path: 'query', code: 'invalid_string' }]));
    if (listMergesHidden) return answer(route, 'listContactMerges', 200, { data: [], nextCursor: null });
    const cursor = call.url.searchParams.get('cursor');
    if (cursor !== null && cursor !== MERGES_CURSOR) {
      violations.push('listContactMerges was sent a cursor the mock never served');
      return answer(route, 'listContactMerges', 400, refusal('ValidationFailed', 'badCursor', [{ path: 'cursor', code: 'invalid_cursor' }]));
    }
    const data = cursor === null ? [...[...made].reverse(), ...history] : older;
    for (const merge of data) servedMerges.add(String(merge.id));
    const nextCursor = cursor === null && older.length > 0 ? MERGES_CURSOR : null;
    return answer(route, 'listContactMerges', 200, { data: clone(data), nextCursor });
  };

  const undo = async (route: Route, call: ApiCall, mergeId: string): Promise<void> => {
    undoCount += 1;
    if (call.raw.trim() !== '') violations.push(`undoContactMerge takes no request body (it was sent ${call.raw.length} characters)`);
    if (!UUID_PATTERN.test(mergeId)) {
      violations.push('undoContactMerge was sent a merge id that is not a uuid');
      return answer(route, 'undoContactMerge', 400, refusal('ValidationFailed', 'badField', [{ path: 'mergeId', code: 'invalid_string' }]));
    }
    if (!servedMerges.has(mergeId)) {
      violations.push('undoContactMerge named a merge the screen was never served');
      return notFound(route, 'undoContactMerge');
    }
    if (deadMerges.has(mergeId)) violations.push('undoContactMerge was sent again for a merge the API had answered 404 or 410 for: it is not undoable');
    const merge = [...made, ...history, ...older].find((entry) => entry.id === mergeId);
    if (merge === undefined) return notFound(route, 'undoContactMerge');
    if (merge.undoneAt !== null) {
      violations.push('undoContactMerge was sent for a merge already undone: the screen must not offer it');
      return answer(route, 'undoContactMerge', 200, clone(merge));
    }
    if (Date.parse(String(merge.undoUntil)) <= Date.now()) {
      violations.push('undoContactMerge was sent for a merge past its undoUntil: the screen must show "undo expired", not an undo control');
      deadMerges.add(mergeId);
      return answer(route, 'undoContactMerge', 410, errorExample('UndoExpired', 'expired'));
    }
    if (undoCount === 1 && options.undoRefusal !== undefined) {
      switch (options.undoRefusal) {
        case 'not_found':
          // The merger lost contact.write (D-L163): 404, and the merges list now shows them nothing.
          deadMerges.add(mergeId);
          listMergesHidden = true;
          return notFound(route, 'undoContactMerge');
        case 'expired':
          // The window closed between the read and the click (the browser's clock is not the
          // server's): the server decides, and a re-read now shows the merge expired.
          deadMerges.add(mergeId);
          merge.mergedAt = isoSeconds(Date.now() - WINDOW - 1_000);
          merge.undoUntil = isoSeconds(Date.now() - 1_000);
          return answer(route, 'undoContactMerge', 410, errorExample('UndoExpired', 'expired'));
        case 'already_merged':
          return answer(route, 'undoContactMerge', 409, errorExample('UndoConflict', 'alreadyMerged'));
        case 'not_permitted':
          return answer(route, 'undoContactMerge', 403, errorExample('MergeUndoNotPermitted', 'action'));
      }
    }
    if (merge.mergedByUserId !== CALLER_ID) return answer(route, 'undoContactMerge', 403, errorExample('MergeUndoNotPermitted', 'action'));
    const mergedId = String((merge.merged as Json).id);
    const restored = away.get(mergedId);
    away.delete(mergedId);
    if (restored !== undefined && CONTACTS.some((contact) => contact.id === mergedId)) live.set(mergedId, restored);
    merge.undoneAt = isoSeconds(Date.now());
    merge.undoneByUserId = CALLER_ID;
    merge.survivorReverted = options.survivorEdited !== true;
    return answer(route, 'undoContactMerge', 200, clone(merge));
  };

  // ----- the Contacts journey's reads ----------------------------------------

  const listContacts = async (route: Route, call: ApiCall): Promise<void> => {
    contactReads.push(call.url);
    const rows = [...live.values()].filter((contact) => contact.programmeId === PROGRAMME_ONE.id).map((contact) => visible(contact, new Set()));
    return answer(route, 'listContacts', 200, { data: rows, nextCursor: null });
  };

  const getContact = async (route: Route, contactId: string): Promise<void> => {
    const contact = live.get(contactId);
    // A merged-away contact is 404 on every contact operation, the one body (D-P27).
    if (contact === undefined) return notFound(route, 'getContact');
    return answer(route, 'getContact', 200, visible(contact, new Set()));
  };

  const timeline = async (route: Route, contactId: string): Promise<void> => {
    if (!live.has(contactId)) return notFound(route, 'listContactTimeline');
    return answer(route, 'listContactTimeline', 200, { data: [], nextCursor: null });
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
      if (url.searchParams.has('programmeId') || url.searchParams.has('programmeIds')) violations.push(`${method} ${url.pathname} was sent a programme in its query: scope is the session's (CLAUDE.md 2.2)`);
      const href = decodeURIComponent(`${url.pathname}${url.search}`);
      for (const value of PII_VALUES) {
        if (href.includes(value)) violations.push(`${method} ${url.pathname} put a person's name, number or address in a URL`);
      }

      if (url.pathname === CUSTOM_FIELDS_PATH && method === 'GET') return custom.answerList(route);

      const segments = url.pathname.split('/').map((segment) => decodeURIComponent(segment));
      let operation: Operation | undefined;
      let id = '';
      if (segments[3] === 'programmes' && segments[5] === 'duplicates' && segments.length === 6 && method === 'GET') {
        operation = 'listDuplicates';
        id = segments[4] ?? '';
      } else if (url.pathname === MERGES_PATH) {
        operation = method === 'POST' ? 'createContactMerge' : method === 'GET' ? 'listContactMerges' : undefined;
      } else if (segments[3] === 'contact-merges' && segments[5] === 'undo' && segments.length === 6 && method === 'POST') {
        operation = 'undoContactMerge';
        id = segments[4] ?? '';
      } else if (segments[3] === 'contacts' && segments[5] === 'merge-preview' && segments.length === 6 && method === 'GET') {
        operation = 'getContactMergePreview';
        id = segments[4] ?? '';
      } else if (url.pathname === PROGRAMMES_PATH && method === 'GET') {
        operation = 'listMyProgrammes';
      } else if (url.pathname === ME_PATH && method === 'GET') {
        operation = 'getCurrentUser';
      } else if (options.otherScreens === true && method === 'GET' && url.pathname === CONTACTS_PATH) {
        operation = 'listContacts';
      } else if (options.otherScreens === true && method === 'GET' && segments[3] === 'contacts' && segments.length === 5) {
        operation = 'getContact';
        id = segments[4] ?? '';
      } else if (options.otherScreens === true && method === 'GET' && segments[3] === 'contacts' && segments[5] === 'timeline' && segments.length === 6) {
        operation = 'listContactTimeline';
        id = segments[4] ?? '';
      }

      if (operation === undefined) {
        const where = `${method} ${url.pathname.replace(/[^/]{40,}/g, '<long>')}`;
        if (options.otherScreens === true && method === 'GET') otherReads.push(where);
        else violations.push(`${where} is not an operation the duplicates screen uses`);
        await route
          .fulfill({ status: 404, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(errorExample('NotFound')) })
          .catch(() => undefined);
        return undefined;
      }
      const call: ApiCall = { operation, url, raw, body, at: Date.now() };
      calls.push(call);
      if (raw !== '' && body === undefined) violations.push(`${operation} was sent a body that is not JSON`);
      if (raw !== '' && !/^application\/json\b/i.test(request.headers()['content-type'] ?? '')) violations.push(`${operation} was sent a body that is not application/json`);

      switch (operation) {
        case 'listDuplicates':
          return listDuplicates(route, call, id);
        case 'getContactMergePreview':
          return preview(route, call, id);
        case 'createContactMerge':
          return createMerge(route, call);
        case 'listContactMerges':
          return listMerges(route, call);
        case 'undoContactMerge':
          return undo(route, call, id);
        case 'listMyProgrammes':
          return answer(route, operation, 200, clone(PROGRAMMES_ANSWER));
        case 'getCurrentUser':
          return answer(route, operation, 200, clone(CURRENT_USER));
        case 'listContacts':
          return listContacts(route, call);
        case 'getContact':
          return getContact(route, id);
        case 'listContactTimeline':
          return timeline(route, id);
      }
    },
  );

  return {
    requests,
    calls,
    throttles,
    contactReads,
    otherReads,
    violations,
    mockFaults,
    callsOf: (operation: Operation) => calls.filter((call) => call.operation === operation),
    mergedAway: () => [...away.keys()],
    merges: () => made.map((merge) => String(merge.id)),
    contact: (id: string) => (live.get(id) === undefined ? undefined : clone(live.get(id))),
  };
}

// ---------------------------------------------------------------------------
// The audit log (P02/E): merged and restored events (D-L162)
// ---------------------------------------------------------------------------

const AUDIT_EVENTS_EXAMPLE = clone(at(ADMIN_CONTRACT, 'paths', '/api/v1/admin/audit/events', 'get', 'responses', '200', 'content', 'application/json', 'example')) as Json;
const AUDIT_OPTIONS_EXAMPLE = clone(at(ADMIN_CONTRACT, 'paths', '/api/v1/admin/audit/filter-options', 'get', 'responses', '200', 'content', 'application/json', 'example')) as Json;
/** The audit actions the admin contract publishes. */
export const AUDIT_ACTIONS: readonly string[] = ((at(ADMIN_CONTRACT, 'components', 'schemas', 'AuditAction') as Json).enum as unknown[]).map(String);

/** As T-0095 writes them: object `contact`, labelled with the record id, field names only, every change redacted. */
function auditEvent(id: string, action: 'merged' | 'restored', occurredAt: string, objectId: string): Json {
  return {
    id,
    occurredAt,
    actor: { kind: 'user', id: CALLER_ID, displayName: 'Sample Merger Fixture', roleName: 'Team lead' },
    action,
    objectType: 'contact',
    objectLabel: objectId,
    objectId,
    programmeId: PROGRAMME_ONE.id,
    sourceIp: null,
    sourceLocation: null,
    changes: ['status', 'tags'].map((field) => ({ field, before: null, after: null, redacted: true })),
  };
}

export const AUDIT_MERGED = auditEvent('11111111-0000-4000-8000-000000a20001', 'merged', '2026-10-18T09:00:00.000Z', A1.id);
export const AUDIT_RESTORED = auditEvent('11111111-0000-4000-8000-000000a20002', 'restored', '2026-10-18T10:30:00.000Z', A2.id);

function auditProblems(path: string, body: unknown): string[] {
  const response = at(ADMIN_CONTRACT, 'paths', path, 'get', 'responses', '200', 'content', 'application/json', 'schema');
  return validateBody(body, response, path, ADMIN_CONTRACT, true);
}

export const AUDIT_PAGE: Json = {
  items: [clone(AUDIT_RESTORED), clone(AUDIT_MERGED), ...clone((AUDIT_EVENTS_EXAMPLE.items as Json[]).slice(0, 1))],
  page: { nextCursor: null, hasMore: false, totalCount: null },
};
export const AUDIT_OPTIONS: Json = { ...clone(AUDIT_OPTIONS_EXAMPLE), actions: [...new Set([...(AUDIT_OPTIONS_EXAMPLE.actions as string[]), 'merged', 'restored'])] };

for (const [path, body] of [
  ['/api/v1/admin/audit/events', AUDIT_PAGE],
  ['/api/v1/admin/audit/filter-options', AUDIT_OPTIONS],
] as const) {
  const problems = auditProblems(path, body);
  if (problems.length > 0) throw new Error(`the audit fixture for ${path} disagrees with ${ADMIN_CONTRACT_SOURCE}: ${problems.join('; ')}`);
}

export interface AuditMock {
  /** Audit reads, in order. */
  readonly reads: URL[];
  readonly mockFaults: string[];
}

/**
 * Serves listAuditEvents and getAuditFilterOptions with a merged and a
 * restored event. Install AFTER `installAdminMock`: Playwright tries the
 * newest route first, so every other admin read falls through to it.
 */
export async function installAuditMock(page: Page): Promise<AuditMock> {
  const reads: URL[] = [];
  const mockFaults: string[] = [];
  await page.route('**/api/v1/admin/audit/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || !['/api/v1/admin/audit/events', '/api/v1/admin/audit/filter-options'].includes(url.pathname)) {
      await route.fallback();
      return;
    }
    reads.push(url);
    const action = url.searchParams.get('action');
    const body =
      url.pathname === '/api/v1/admin/audit/events'
        ? { ...clone(AUDIT_PAGE), items: (AUDIT_PAGE.items as Json[]).filter((entry) => action === null || entry.action === action) }
        : clone(AUDIT_OPTIONS);
    mockFaults.push(...auditProblems(url.pathname, body));
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) }).catch(() => undefined);
  });
  return { reads, mockFaults };
}
