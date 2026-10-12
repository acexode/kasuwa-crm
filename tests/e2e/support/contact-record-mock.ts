import type { Page, Request, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { TENANT_A } from '@kasuwa/db';

/**
 * The contact record half of `docs/api/records.openapi.yaml` — `getContact`,
 * `updateContact`, `listContactTimeline`, `createActivity`, `updateActivity` —
 * plus `listMyProgrammes` and `getCurrentUser` (`docs/api/auth.openapi.yaml`),
 * served into the browser by Playwright for T-0062 (the P05 contact record).
 *
 * ---------------------------------------------------------------------------
 * READ FROM THE CONTRACT AT RUN TIME, LIKE records-mock.ts AND accounts-mock.ts
 *
 * The Contact property list, every request-body schema, the timeline item
 * union, the enums and every error body come out of the YAML when this module
 * loads. Every row and every timeline item declared below is checked against
 * the contract's schemas at load, so a contract change that this file
 * contradicts fails here, loudly, before any journey runs.
 *
 * WHAT IS NOT IN THE CONTRACT, AND IS THEREFORE DECLARED HERE
 *
 *   - Contacts. The contract publishes ONE example contact (Adaeze Okonkwo,
 *     from `listContacts`). The others are DERIVED from it by spreading it and
 *     overriding named properties. Names, numbers and people are invented.
 *   - Timelines. The contract publishes one four-item example page. It is
 *     used verbatim as the newest items of CONTACT_FULL's timeline; the rest
 *     are declared in the same shapes.
 *   - The caller. `getCurrentUser` has no example. ME is the contract's
 *     example owner and timeline actor (Kemi Balogun), so "assign to me"
 *     means her id. The screen learns it from `GET /api/v1/auth/me`.
 *   - What the caller may do. The contract gives the screen no capability
 *     read (D-L84), so the mock is told the caller's permission set by the
 *     journey, as `role`:
 *       writer  — the `admin` set: any contact field, any activity write;
 *       claimer — `agent`, `team_lead`, `programme_manager` (D-P14, D-P18):
 *                 updateContact may carry `status` and `ownerUserId` set to
 *                 ME, and nothing else, or the WHOLE body is 403; activities
 *                 may be logged and completed;
 *       reader  — `qa_analyst`: every write is 403 not_permitted.
 *     The default is `claimer`: a BPO agent is the common caller.
 *   - Read-only fields. Field security has two levels and the wire only shows
 *     one: a field the caller may READ but not EDIT is served normally, and
 *     sending it is `403 field_not_editable`. `readOnlyFields` on a row says
 *     which. The screen cannot know them, so a form that round-trips fields
 *     the user did not change is refused here, exactly as the API would.
 *
 * WHAT THE MOCK ENFORCES ON EVERY REQUEST (recorded as `violations`, the
 * SCREEN's fault; `afterEach` in the spec fails a test that has any)
 *
 *   - Only the operations above. Any other `/api/v1/…` path or method —
 *     `listContacts`, `getAccount`, a getActivity that does not exist — is a
 *     violation: the record view reads the account summary embedded on the
 *     contact, and the timeline is the only activity read.
 *   - No request header names a programme or a tenant (CLAUDE.md 2.2).
 *   - listContactTimeline: only `cursor` and `limit`, `limit` in 1..100; a
 *     cursor is echoed exactly as served, and only for the contact it was
 *     served for.
 *   - updateContact: closed `UpdateContactRequest` (no `programmeId`, no
 *     `source`, `dnd` or other server-owned field, at least one field besides
 *     `version`); it names a contact the screen was served; `version` is the
 *     one it was last served; and it sends NO field the row lists in
 *     `withheldFields` (a caller cannot clear what they cannot read).
 *   - createActivity: closed `CreateActivityRequest`; a target; `contactId`
 *     is a contact the screen was served (the record on screen); `accountId`,
 *     if sent, is that contact's account; `dueAt` only on a task, UTC with a
 *     `Z`; `subject` and `body` never `""` (minLength 1: an empty box is
 *     `null` or absent); an owner, if set, is ME or the contact's owner.
 *   - updateActivity: closed `UpdateActivityRequest`; an activity the screen
 *     was served; only a task is completed; and `version` is one a 201 or 200
 *     for THAT activity actually carried. A timeline item carries no
 *     `version` (see the CONTRACT GAP in the spec header), so completing a
 *     task the screen only saw on the timeline means inventing a version, and
 *     that is recorded, as a forged cursor is.
 *
 * SERVER BEHAVIOUR THE SCREEN DEPENDS ON, IMPLEMENTED AS THE CONTRACT SAYS
 *
 *   - Out of scope is 404 with ONE body, for an id in another programme or
 *     tenant and for one that names nothing. A non-uuid id is 400.
 *   - Field security omits, never nulls; `owner` goes with `ownerUserId` and
 *     `account` with `accountId`. Timeline items for withheld fields are not
 *     served at all; activity items omit withheld `subject`/`body`.
 *   - The timeline is newest first, ties broken by item id descending; every
 *     page holds `limit` items (default 25) unless it is the last. That is
 *     the contract's promise (omission happens before paging), so this mock
 *     keeps it: a page is never short with a cursor.
 *   - Writes apply: updateContact advances `version` and adds the items the
 *     real audit trail would; createActivity adds an activity item at the
 *     top; completing a task changes its item in place and adds none.
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

function enumOf(name: string): readonly string[] {
  return (at(schema(name), 'enum') as unknown[]).map(String);
}

const CONTACTS_PATH = '/api/v1/contacts';
const ACTIVITIES_PATH = '/api/v1/activities';
const PROGRAMMES_PATH = '/api/v1/me/programmes';
const ME_PATH = '/api/v1/auth/me';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** RFC 3339 in UTC, with a `Z`: "UTC, with a Z" is the contract's rule for every time. */
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

// ---------------------------------------------------------------------------
// The contract's own vocabularies
// ---------------------------------------------------------------------------

export const CONTACT_STATUSES: readonly string[] = enumOf('ContactStatus');
export const CONSENT_STATES: readonly string[] = enumOf('ConsentState');
export const ACTIVITY_TYPES: readonly string[] = enumOf('ActivityType');

/** Contact properties the live wire carries (`Contact.properties`). */
const LIVE_PROPERTIES: readonly string[] = Object.keys(at(schema('Contact'), 'properties') as Json);
/** Specified, not served yet (`ContactPendingProperties`, D-L73): optional, never required. */
const PENDING_PROPERTIES: readonly string[] = Object.keys(at(schema('ContactPendingProperties'), 'properties') as Json);
export const CONTACT_PROPERTIES: readonly string[] = [...LIVE_PROPERTIES, ...PENDING_PROPERTIES];
const CONTACT_REQUIRED = at(schema('Contact'), 'required') as string[];

/** The fields a `field_changed` item may carry values for, and those it never does (D-L72). */
export const VALUE_FIELDS: readonly string[] = (
  at(schema('FieldChangeWithValues'), 'properties', 'field', 'enum') as unknown[]
).map(String);
export const REDACTED_FIELDS: readonly string[] = (
  at(schema('FieldChangeRedacted'), 'properties', 'field', 'enum') as unknown[]
).map(String);

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
// Validation: a JSON-Schema subset, exactly what these bodies and items use
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

// ---------------------------------------------------------------------------
// People and programmes
// ---------------------------------------------------------------------------

export interface Programme {
  id: string;
  name: string;
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

export interface Person {
  id: string;
  displayName: string;
}

const LIST_EXAMPLE = at(CONTRACT, 'paths', CONTACTS_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example');
const TIMELINE_EXAMPLE = at(
  CONTRACT,
  'paths',
  `${CONTACTS_PATH}/{contactId}/timeline`,
  'get',
  'responses',
  '200',
  'content',
  'application/json',
  'example',
) as { data: Json[]; nextCursor: string | null };

/** The contract's example contact, verbatim: Adaeze Okonkwo, `emails` and the account withheld. */
export const CONTACT_EXAMPLE = clone(at(LIST_EXAMPLE, 'data', '0')) as ContactRow;

/** The caller: the contract's example owner and timeline actor. "Me" is her id. */
export const ME: Person = clone(CONTACT_EXAMPLE.owner as Person);

/** `getCurrentUser`'s body for ME. The auth contract has no example; every required key is set. */
export const CURRENT_USER: Json = {
  id: ME.id,
  tenantId: TENANT_A,
  email: 'kemi.balogun@example.ng',
  displayName: ME.displayName,
  locale: 'en-NG',
};

/** Another member of PROGRAMME_ONE: the owner of the contact the caller claims. */
export const OTHER_OWNER: Person = { id: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02', displayName: 'Tunde Adeyemi' };

/** Somebody who has left the programme. Still named on what they did (D-L81). */
export const FORMER_MEMBER: Person = { id: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e03', displayName: 'Ifeoma Nwosu' };

/** Who `ownerUserId` may name in PROGRAMME_ONE (D-L67). The former member is not one. */
const MEMBERS: readonly Person[] = [ME, OTHER_OWNER];

/** The contract's example account (`Ọjà Foods Ltd`), as a contact's account summary. */
export const ACCOUNT_SUMMARY = ((): { id: string; name: string } => {
  const account = at(CONTRACT, 'paths', '/api/v1/accounts', 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', '0') as Json;
  return { id: String(account.id), name: String(account.name) };
})();

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export interface ContactRow {
  id: string;
  programmeId: string;
  displayName: string;
  version: number;
  withheldFields: string[];
  [property: string]: unknown;
}

function checkContact(row: ContactRow): ContactRow {
  const unknown = Object.keys(row).filter((key) => !CONTACT_PROPERTIES.includes(key));
  const missing = CONTACT_REQUIRED.filter((key) => !(key in row));
  // The T-0041 rule: every live property is served or listed as withheld.
  const unaccounted = LIVE_PROPERTIES.filter((key) => !(key in row) && !row.withheldFields.includes(key));
  const leaked = row.withheldFields.filter((field) => field in row);
  const apart =
    row.withheldFields.includes('ownerUserId') !== row.withheldFields.includes('owner') ||
    row.withheldFields.includes('accountId') !== row.withheldFields.includes('account');
  const owner = row.owner as { id?: string } | null | undefined;
  const account = row.account as { id?: string } | null | undefined;
  const ownerMismatch = 'ownerUserId' in row && (row.ownerUserId === null ? owner !== null : owner?.id !== row.ownerUserId);
  const accountMismatch = 'accountId' in row && (row.accountId === null ? account !== null : account?.id !== row.accountId);
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

function inAccount(account: { id: string; name: string } | null): { accountId: string | null; account: { id: string; name: string } | null } {
  return account === null ? { accountId: null, account: null } : { accountId: account.id, account: { id: account.id, name: account.name } };
}

function derive(overrides: Partial<ContactRow> & { id: string; displayName: string }, withheld: readonly string[] = []): ContactRow {
  const row: ContactRow = { ...clone(CONTACT_EXAMPLE), ...overrides, withheldFields: [...withheld] };
  for (const field of withheld) {
    delete row[field];
  }
  return checkContact(row);
}

/**
 * The record most journeys open: the contract's example contact with nothing
 * withheld, an account and an email added, owned by ME, in PROGRAMME_ONE.
 * Its timeline begins with the contract's example page.
 */
export const CONTACT_FULL = derive({
  id: CONTACT_EXAMPLE.id,
  displayName: CONTACT_EXAMPLE.displayName,
  emails: ['adaeze.okonkwo@example.ng'],
  ...inAccount(ACCOUNT_SUMMARY),
});

/**
 * In PROGRAMME_TWO, whose matrix withholds the phones, emails, status, consent,
 * the owner and the account from the caller (each OMITTED and listed), and an
 * activity's subject and body. Its timeline therefore carries no consent,
 * status, owner or account items at all, as the contract says.
 */
export const CONTACT_LOCKED = derive(
  {
    id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e02',
    programmeId: PROGRAMME_TWO.id,
    version: 5,
    displayName: 'Chidi Eze',
    givenNames: 'Chidi',
    familyName: 'Eze',
    tags: ['Water arrears'],
    source: 'ussd',
    preferredLanguage: 'ig',
    preferredChannel: 'sms',
    state: 'Lagos',
    lga: 'Surulere',
    whatsappOptIn: false,
    phoneNetwork: 'Airtel',
  },
  ['phones', 'emails', 'status', 'consentState', 'ownerUserId', 'owner', 'accountId', 'account'],
);

/** Every nullable property null and every list empty: "no value", never a lock. An empty timeline. */
export const CONTACT_NULLS = derive({
  id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e03',
  version: 1,
  displayName: 'Musa Danladi',
  givenNames: null,
  familyName: null,
  phones: [],
  emails: [],
  ...inAccount(null),
  ...ownedBy(null),
  status: null,
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

/** Owned by a colleague, status `new`: the one the claim journeys take and move. */
export const CONTACT_CLAIMABLE = derive({
  id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e04',
  version: 2,
  displayName: 'Ngozi Obi',
  givenNames: 'Ngozi',
  familyName: 'Obi',
  phones: [{ type: 'mobile', e164: '+2348030000004' }],
  emails: [],
  ...inAccount(null),
  ...ownedBy(OTHER_OWNER),
  status: 'new',
  consentState: 'pending',
  createdAt: '2026-10-04T12:00:00.000Z',
  updatedAt: '2026-10-04T12:00:00.000Z',
});

/** A long history: more items than any legal `limit`, so it always has a second page. */
export const CONTACT_LONG = derive({
  id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e05',
  version: 60,
  displayName: 'Amaka Nnaji',
  givenNames: 'Amaka',
  familyName: 'Nnaji',
  emails: [],
  ...inAccount(null),
});

export const HOSTILE_NAME = '<img src=x onerror="window.__kasuwaXss=1">Bùkọ́lá <b>Adé</b>';
export const HOSTILE_TAG = '<i>VIP</i>';
export const HOSTILE_SUBJECT = '<img src=y onerror="window.__kasuwaXss=3">Promise to pay';
export const HOSTILE_BODY = '<script>window.__kasuwaXss=2</script>Will pay on <b>Friday</b>';

/** Markup in record data: drawn as text, never parsed. */
export const CONTACT_HOSTILE = derive({
  id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e06',
  version: 1,
  displayName: HOSTILE_NAME,
  givenNames: null,
  familyName: null,
  emails: [],
  tags: [HOSTILE_TAG],
  ...inAccount(null),
});

/** A real-looking id the caller cannot reach (another programme or tenant): 404, one body. */
export const OUT_OF_SCOPE_ID = '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e99';
/** An id that names nothing: the same 404. */
export const NO_SUCH_ID = '00000000-0000-4000-8000-00000000dead';

/** Read-only for the caller, though readable (field security's `read` level). Sending one is 403. */
const READ_ONLY: Readonly<Record<string, readonly string[]>> = {
  [CONTACT_FULL.id]: ['consentState', 'whatsappOptIn', 'tags'],
  [CONTACT_CLAIMABLE.id]: ['consentState'],
};

/** Activity fields withheld in a contact's programme (the activity object's matrix). */
const ACTIVITY_WITHHELD: Readonly<Record<string, readonly string[]>> = {
  [PROGRAMME_ONE.id]: [],
  [PROGRAMME_TWO.id]: ['subject', 'body'],
};

const ALL_CONTACTS: readonly ContactRow[] = [
  CONTACT_FULL,
  CONTACT_LOCKED,
  CONTACT_NULLS,
  CONTACT_CLAIMABLE,
  CONTACT_LONG,
  CONTACT_HOSTILE,
];

// ---------------------------------------------------------------------------
// Timelines
// ---------------------------------------------------------------------------

export interface TimelineItem {
  id: string;
  type: 'field_changed' | 'consent_changed' | 'activity';
  occurredAt: string;
  actor: Person | null;
  [property: string]: unknown;
}

const TIMELINE_ITEM_SCHEMA = schema('TimelineItem');

function checkItem(item: TimelineItem): TimelineItem {
  const problems = validateBody(item, TIMELINE_ITEM_SCHEMA, `item ${item.id}`);
  if (problems.length > 0) {
    throw new Error(`timeline item ${item.id} disagrees with ${RECORDS_CONTRACT_SOURCE}: ${problems.join('; ')}`);
  }
  return item;
}

function actorOf(person: Person | null): Person | null {
  return person === null ? null : { id: person.id, displayName: person.displayName };
}

function change(id: string, occurredAt: string, actor: Person | null, field: string, values?: { before: unknown; after: unknown }): TimelineItem {
  const item: TimelineItem = { id, type: 'field_changed', occurredAt, actor: actorOf(actor), field };
  if (REDACTED_FIELDS.includes(field)) {
    item.redacted = true;
  } else if (values !== undefined) {
    item.before = values.before;
    item.after = values.after;
  }
  return checkItem(item);
}

function consent(id: string, occurredAt: string, actor: Person | null, values?: { before: string; after: string }): TimelineItem {
  const item: TimelineItem = { id, type: 'consent_changed', occurredAt, actor: actorOf(actor) };
  if (values !== undefined) {
    item.before = values.before;
    item.after = values.after;
  }
  return checkItem(item);
}

function activityItem(
  id: string,
  occurredAt: string,
  actor: Person | null,
  activity: { activityId: string; activityType: string; subject?: string | null; body?: string | null; dueAt?: string | null; startsAt?: string | null; endsAt?: string | null; completedAt?: string | null; version?: number },
): TimelineItem {
  // T-0080 (D-L85): every activity item carries the row's version; a planted activity is at 1 unless it says otherwise.
  return checkItem({ id, type: 'activity', occurredAt, actor: actorOf(actor), version: 1, ...clone(activity) });
}

/** The contract's example page, verbatim: the newest four items of CONTACT_FULL. */
const EXAMPLE_ITEMS = TIMELINE_EXAMPLE.data.map((item) => checkItem(clone(item) as TimelineItem));

function exampleItem(type: string, field?: string): TimelineItem {
  const found = EXAMPLE_ITEMS.find((item) => item.type === type && (field === undefined || item.field === field));
  if (found === undefined) {
    throw new Error(`${RECORDS_CONTRACT_SOURCE}: the timeline example has no ${type} ${field ?? ''} item`);
  }
  return found;
}

/** status new → contacted, by ME, with values. */
export const ITEM_STATUS = exampleItem('field_changed', 'status');
/** phones, redacted, in the same event as ITEM_STATUS (same `occurredAt`). */
export const ITEM_PHONES = exampleItem('field_changed', 'phones');
/** consent unknown → opted_in, actor null: the system. */
export const ITEM_CONSENT = exampleItem('consent_changed');
/** An open task, by ME, due 2026-10-02T15:00Z: 16:00 in Lagos (WAT, UTC+1). */
export const ITEM_TASK = exampleItem('activity');

/** tags [] → [Callback set], same event as the status change: three items, one `occurredAt`. */
export const ITEM_TAGS = change('ti_k7Rq2mXbN1', ITEM_STATUS.occurredAt, ME, 'tags', { before: [], after: ['Callback set'] });
/** An owner change: by name only, never an id or a past owner's name (D-L72). */
export const ITEM_OWNER = change('ti_m2Lp5sVcR8', '2026-10-02T11:00:00.000Z', OTHER_OWNER, 'ownerUserId');
/** whatsappOptIn false → true, by the system, in the consent event. A boolean is never drawn as "true". */
export const ITEM_WHATSAPP = change('ti_c3Hw8nVdK7', ITEM_CONSENT.occurredAt, null, 'whatsappOptIn', { before: false, after: true });
/** A note logged by somebody who has since left the programme: still named. No subject. */
export const ITEM_NOTE = activityItem('ti_n8Gb3hWyE5', '2026-09-29T10:30:00.000Z', FORMER_MEMBER, {
  activityId: '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4c02',
  activityType: 'note',
  subject: null,
  body: 'Prefers calls after 4pm, in Yoruba.',
  dueAt: null,
  startsAt: null,
  endsAt: null,
  completedAt: null,
});
/** A task already completed: no complete control. */
export const ITEM_DONE_TASK = activityItem('ti_d4Jm9pXsA3', '2026-09-25T10:00:00.000Z', ME, {
  activityId: '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4c03',
  activityType: 'task',
  subject: 'Send the account statement',
  body: null,
  dueAt: '2026-09-26T09:00:00.000Z',
  startsAt: null,
  endsAt: null,
  completedAt: '2026-09-26T08:15:00.000Z',
});
/** A logged call. */
export const ITEM_CALL = activityItem('ti_f6Kq1rZtB9', '2026-09-28T08:00:00.000Z', OTHER_OWNER, {
  activityId: '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4c04',
  activityType: 'call',
  subject: 'Payment reminder call',
  body: null,
  dueAt: null,
  startsAt: null,
  endsAt: null,
  completedAt: null,
});
/** preferredLanguage yo → en, by ME. */
export const ITEM_LANGUAGE = change('ti_g1Ns7tUuC2', '2026-09-20T12:00:00.000Z', ME, 'preferredLanguage', { before: 'yo', after: 'en' });
/** A status change audited before T-0061: by name only, no values (D-L63). */
export const ITEM_LEGACY_STATUS = change('ti_h3Pv2wQxD4', '2026-09-15T09:00:00.000Z', OTHER_OWNER, 'status');
/** A consent change audited before T-0061: no values. */
export const ITEM_LEGACY_CONSENT = consent('ti_h3Pv2wQxC9', '2026-09-15T09:00:00.000Z', OTHER_OWNER);
/** An account change, by the system: by name only, never the account id. */
export const ITEM_ACCOUNT = change('ti_j5Rx4yMzF6', '2026-09-10T07:00:00.000Z', null, 'accountId');
/** Creation (D-L81): source null → whatsapp, and the name, redacted. */
export const ITEM_CREATED_SOURCE = change('ti_k9Ty6aNbG8', '2026-09-01T07:00:00.000Z', null, 'source', { before: null, after: 'whatsapp' });
export const ITEM_CREATED_NAME = change('ti_k9Ty6aNbG1', '2026-09-01T07:00:00.000Z', null, 'displayName');

/** Newest first; ties by id descending (code-unit order), as the contract orders them. */
function ordered(items: readonly TimelineItem[]): TimelineItem[] {
  return [...items].sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/** How many items the longest default timeline holds. A first page smaller than this fails the journeys. */
export const DEFAULT_TIMELINE_MAX = 20;

/** The oldest item of CONTACT_LONG, on the last page whatever the limit. */
export const LONG_OLDEST_SUBJECT = 'First contact logged';
export const LONG_TIMELINE_LENGTH = 105;

function longTimeline(): TimelineItem[] {
  const base = Date.parse('2026-10-06T12:00:00.000Z');
  const items: TimelineItem[] = [];
  for (let index = 0; index < LONG_TIMELINE_LENGTH - 1; index += 1) {
    // Groups of three share one `occurredAt`: page edges fall inside events.
    const occurredAt = new Date(base - Math.floor(index / 3) * 60_000).toISOString();
    const id = `ti_L${String(999 - index).padStart(3, '0')}`;
    const forward = index % 2 === 0;
    items.push(
      change(id, occurredAt, index % 4 < 2 ? ME : OTHER_OWNER, 'status', {
        before: forward ? 'contacted' : 'new',
        after: forward ? 'new' : 'contacted',
      }),
    );
  }
  items.push(
    activityItem('ti_L000', '2026-01-01T09:00:00.000Z', ME, {
      activityId: '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4c09',
      activityType: 'note',
      subject: LONG_OLDEST_SUBJECT,
      body: null,
      dueAt: null,
      startsAt: null,
      endsAt: null,
      completedAt: null,
    }),
  );
  return ordered(items);
}

const TIMELINES: Readonly<Record<string, readonly TimelineItem[]>> = {
  [CONTACT_FULL.id]: ordered([
    ...EXAMPLE_ITEMS,
    ITEM_TAGS,
    ITEM_OWNER,
    ITEM_WHATSAPP,
    ITEM_NOTE,
    ITEM_DONE_TASK,
    ITEM_CALL,
    ITEM_LANGUAGE,
    ITEM_LEGACY_STATUS,
    ITEM_LEGACY_CONSENT,
    ITEM_ACCOUNT,
    ITEM_CREATED_SOURCE,
    ITEM_CREATED_NAME,
  ]),
  [CONTACT_LOCKED.id]: ordered([
    change('ti_p2Wc8dLeH3', '2026-10-04T09:00:00.000Z', OTHER_OWNER, 'tags', { before: [], after: ['Water arrears'] }),
    // The call's subject and body are withheld in PROGRAMME_TWO: omitted, never null.
    activityItem('ti_p2Wc8dLeH1', '2026-10-03T15:00:00.000Z', OTHER_OWNER, {
      activityId: '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4c05',
      activityType: 'call',
      dueAt: null,
      startsAt: null,
      endsAt: null,
      completedAt: null,
    }),
    change('ti_p2Wc8dLeG7', '2026-10-01T08:00:00.000Z', null, 'displayName'),
  ]),
  [CONTACT_NULLS.id]: [],
  [CONTACT_CLAIMABLE.id]: ordered([
    change('ti_q7Yd2fMgJ5', CONTACT_CLAIMABLE.createdAt as string, OTHER_OWNER, 'status', { before: null, after: 'new' }),
    change('ti_q7Yd2fMgJ2', CONTACT_CLAIMABLE.createdAt as string, OTHER_OWNER, 'displayName'),
    consent('ti_q7Yd2fMgH9', CONTACT_CLAIMABLE.createdAt as string, OTHER_OWNER, { before: 'unknown', after: 'pending' }),
  ]),
  [CONTACT_LONG.id]: longTimeline(),
  [CONTACT_HOSTILE.id]: ordered([
    activityItem('ti_r4Ze6gNhK1', '2026-10-05T09:00:00.000Z', ME, {
      activityId: '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4c06',
      activityType: 'note',
      subject: HOSTILE_SUBJECT,
      body: HOSTILE_BODY,
      dueAt: null,
      startsAt: null,
      endsAt: null,
      completedAt: null,
    }),
  ]),
};

for (const [id, items] of Object.entries(TIMELINES)) {
  if (id !== CONTACT_LONG.id && items.length > DEFAULT_TIMELINE_MAX) {
    throw new Error(`the ${id} timeline outgrew DEFAULT_TIMELINE_MAX`);
  }
}

/** Every item a contact's timeline serves, newest first, as the mock starts. */
export function timelineOf(contactId: string): readonly TimelineItem[] {
  return TIMELINES[contactId] ?? [];
}

export function contactById(id: string): ContactRow {
  const row = ALL_CONTACTS.find((candidate) => candidate.id === id);
  if (row === undefined) {
    throw new Error(`no mock contact ${id}`);
  }
  return row;
}

/** Everything the mock serves, for checks that tell served record data from UI copy. */
export function servedData(): string {
  return JSON.stringify({
    contacts: ALL_CONTACTS,
    timelines: TIMELINES,
    programmes: [PROGRAMME_ONE, PROGRAMME_TWO],
    me: CURRENT_USER,
  });
}

/** The ids the mock gives the activities the screen logs, in order. */
export const NEW_ACTIVITY_IDS: readonly string[] = [
  '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4c21',
  '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4c22',
  '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4c23',
  '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4c24',
  '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4c25',
  '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4c26',
];

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export type Role = 'writer' | 'claimer' | 'reader';

export interface ContactRecordMockOptions {
  /** The caller's permission set (see the header). Default `claimer`. */
  readonly role?: Role;
  /** Hold every getContact and timeline response until `release()`. The loading frame, without a clock. */
  readonly hold?: boolean;
  /** Abort every getContact, as a dropped connection does. */
  readonly networkFailure?: boolean;
  /** Abort every timeline read only; the contact itself loads. */
  readonly timelineFailure?: boolean;
  /** Hold every write until `releaseWrites()`: the in-flight state of a save. */
  readonly holdWrites?: boolean;
  /** Answer every otherwise-valid contact write with this refusal. */
  readonly refuse?: 'not_permitted' | 'stale_write';
}

export interface RecordedWrite {
  readonly method: 'POST' | 'PATCH';
  readonly path: string;
  readonly body: unknown;
}

export interface ContactRecordMock {
  /** Every request the mock answered, in order. */
  readonly requests: URL[];
  /** getContact ids, in order. */
  readonly contactReads: string[];
  /** listContactTimeline requests, in order. */
  readonly timelineReads: URL[];
  /** Every write, in order, whatever its answer. */
  readonly writes: RecordedWrite[];
  /** getCurrentUser calls. */
  readonly meCalls: string[];
  /** Contract breaches by the SCREEN. Must be empty at the end of every test. */
  readonly violations: string[];
  /** The contacts as they now stand (writes applied), as served. */
  readonly contacts: Map<string, ContactRow>;
  /** The timelines as they now stand. */
  readonly timelines: Map<string, TimelineItem[]>;
  release(): void;
  releaseWrites(): void;
}

export function isGetContact(request: Request, id: string): boolean {
  return request.method() === 'GET' && new URL(request.url()).pathname === `${CONTACTS_PATH}/${id}`;
}

export function isUpdateContact(request: Request, id: string): boolean {
  return request.method() === 'PATCH' && new URL(request.url()).pathname === `${CONTACTS_PATH}/${id}`;
}

export function isTimeline(request: Request, id?: string): boolean {
  const path = new URL(request.url()).pathname;
  return (
    request.method() === 'GET' &&
    (id === undefined ? /^\/api\/v1\/contacts\/[^/]+\/timeline$/.test(path) : path === `${CONTACTS_PATH}/${id}/timeline`)
  );
}

export function isCreateActivity(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === ACTIVITIES_PATH;
}

export function isUpdateActivity(request: Request, id?: string): boolean {
  const path = new URL(request.url()).pathname;
  return (
    request.method() === 'PATCH' &&
    (id === undefined ? path.startsWith(`${ACTIVITIES_PATH}/`) : path === `${ACTIVITIES_PATH}/${id}`)
  );
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

const UPDATE_CONTACT_SCHEMA = schema('UpdateContactRequest');
const CREATE_ACTIVITY_SCHEMA = schema('CreateActivityRequest');
const UPDATE_ACTIVITY_SCHEMA = schema('UpdateActivityRequest');
const ACTIVITY_SCHEMA = schema('Activity');

const TIMELINE_PARAMETERS: readonly string[] = (
  at(CONTRACT, 'paths', `${CONTACTS_PATH}/{contactId}/timeline`, 'get', 'parameters') as unknown[]
).map((raw) => String((deref(raw) as Json).name));

const CURRENT_USER_REQUIRED = at(AUTH_CONTRACT, 'components', 'schemas', 'CurrentUser', 'required') as string[];
for (const key of CURRENT_USER_REQUIRED) {
  if (!(key in CURRENT_USER)) {
    throw new Error(`CURRENT_USER lacks ${key}, which ${AUTH_CONTRACT_SOURCE} requires`);
  }
}

/** Server time for the n-th write: later than everything in the fixtures. */
function serverTime(n: number): string {
  return new Date(Date.parse('2026-10-07T10:00:00.000Z') + n * 60_000).toISOString();
}

interface ActivityState {
  activity: Json;
  contactId: string;
  itemId: string;
  /** Versions a 201 or 200 for this activity carried. Empty for one only seen on a timeline. */
  servedVersions: Set<number>;
}

export async function installContactRecordMock(page: Page, options: ContactRecordMockOptions = {}): Promise<ContactRecordMock> {
  const role: Role = options.role ?? 'claimer';
  const contacts = new Map<string, ContactRow>(ALL_CONTACTS.map((row) => [row.id, clone(row)]));
  const timelines = new Map<string, TimelineItem[]>(Object.entries(TIMELINES).map(([id, items]) => [id, clone([...items])]));
  const activities = new Map<string, ActivityState>();
  for (const [contactId, items] of timelines) {
    const programmeId = contacts.get(contactId)?.programmeId ?? PROGRAMME_ONE.id;
    for (const item of items) {
      if (item.type !== 'activity') continue;
      const activityId = String(item.activityId);
      activities.set(activityId, {
        contactId,
        itemId: item.id,
        // Seen on a timeline only: the screen was never served a version for it.
        servedVersions: new Set<number>(),
        activity: {
          id: activityId,
          programmeId,
          type: item.activityType,
          subject: item.subject ?? null,
          body: item.body ?? null,
          dueAt: item.dueAt ?? null,
          startsAt: item.startsAt ?? null,
          endsAt: item.endsAt ?? null,
          completedAt: item.completedAt ?? null,
          ownerUserId: null,
          contactId,
          accountId: null,
          createdByUserId: item.actor === null ? null : item.actor.id,
          version: 1,
          createdAt: item.occurredAt,
          updatedAt: item.occurredAt,
        },
      });
    }
  }

  const requests: URL[] = [];
  const contactReads: string[] = [];
  const timelineReads: URL[] = [];
  const writes: RecordedWrite[] = [];
  const meCalls: string[] = [];
  const violations: string[] = [];
  /** Contacts the screen has been served (a 200 from getContact or updateContact). */
  const servedContacts = new Set<string>();
  /** cursor -> the contact it was served for, and the last item id of its page */
  const issued = new Map<string, { contactId: string; afterId: string }>();
  let cursorCount = 0;
  let writeCount = 0;
  let activityCount = 0;

  let release: () => void = () => undefined;
  const gate = options.hold === true ? new Promise<void>((done) => (release = done)) : Promise.resolve();
  let releaseWrites: () => void = () => undefined;
  const writeGate = options.holdWrites === true ? new Promise<void>((done) => (releaseWrites = done)) : Promise.resolve();

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

  const served = (row: ContactRow): ContactRow => {
    servedContacts.add(row.id);
    return clone(row);
  };

  const addItems = (contactId: string, items: TimelineItem[]): void => {
    const list = timelines.get(contactId) ?? [];
    timelines.set(contactId, ordered([...items.map(checkItem), ...list]));
  };

  // ----- getContact -------------------------------------------------------

  const getContact = async (route: Route, id: string): Promise<void> => {
    contactReads.push(id);
    await gate;
    if (options.networkFailure === true) {
      return route.abort('internetdisconnected');
    }
    if (!UUID_PATTERN.test(id)) {
      // A malformed id from the address bar is the user's, not the screen's.
      return fulfil(route, 400, validation([{ path: 'contactId', code: 'invalid_string' }]));
    }
    const row = contacts.get(id);
    return row === undefined ? fulfil(route, 404, errorExample('NotFound')) : fulfil(route, 200, served(row));
  };

  // ----- listContactTimeline ---------------------------------------------

  const timeline = async (route: Route, url: URL, id: string): Promise<void> => {
    timelineReads.push(url);
    await gate;
    if (options.timelineFailure === true || options.networkFailure === true) {
      return route.abort('internetdisconnected');
    }
    const params = url.searchParams;
    const problems: string[] = [];
    for (const name of new Set(params.keys())) {
      if (!TIMELINE_PARAMETERS.includes(name)) problems.push(`listContactTimeline declares no "${name}" parameter`);
      if (params.getAll(name).length > 1) problems.push(`${name} was sent more than once`);
    }
    const rawLimit = params.get('limit');
    const limit = rawLimit === null ? 25 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      problems.push(`limit=${String(rawLimit)} is outside 1..100`);
    }
    if (problems.length > 0) {
      violations.push(...problems.map((problem) => `${url.search}: ${problem}`));
      return fulfil(route, 400, validation(problems.map(() => ({ path: 'query', code: 'invalid_string' }))));
    }
    if (!UUID_PATTERN.test(id)) {
      return fulfil(route, 400, validation([{ path: 'contactId', code: 'invalid_string' }]));
    }
    if (!contacts.has(id)) {
      return fulfil(route, 404, errorExample('NotFound'));
    }
    const items = timelines.get(id) ?? [];
    let start = 0;
    const cursor = params.get('cursor');
    if (cursor !== null) {
      const boundTo = issued.get(cursor);
      if (boundTo === undefined) {
        violations.push(`timeline cursor "${cursor}" was never served — it must be echoed, not built`);
        return fulfil(route, 400, errorExample('ValidationFailed', 'badCursor'));
      }
      if (boundTo.contactId !== id) {
        violations.push(`a timeline cursor served for contact ${boundTo.contactId} was sent for another contact`);
        return fulfil(route, 400, errorExample('ValidationFailed', 'badCursor'));
      }
      // Keyset: the page starts after the item the cursor names, wherever it now is.
      start = items.findIndex((item) => item.id === boundTo.afterId) + 1;
    }
    const data = items.slice(start, start + limit);
    let nextCursor: string | null = null;
    const last = data.at(-1);
    if (start + limit < items.length && last !== undefined) {
      cursorCount += 1;
      nextCursor = `tlc_${String(cursorCount).padStart(4, '0')}_a7Fq`;
      issued.set(nextCursor, { contactId: id, afterId: last.id });
    }
    return fulfil(route, 200, { data: clone(data), nextCursor });
  };

  // ----- updateContact -----------------------------------------------------

  const updateContact = async (route: Route, request: Request, id: string): Promise<void> => {
    const body = readBody(request, 'updateContact');
    writes.push({ method: 'PATCH', path: `${CONTACTS_PATH}/${id}`, body });
    await writeGate;
    const row = contacts.get(id);
    if (row === undefined || !servedContacts.has(id)) {
      violations.push(`updateContact named ${id}, which the screen was never served`);
      return fulfil(route, 404, errorExample('NotFound'));
    }
    const problems = validateBody(body, UPDATE_CONTACT_SCHEMA, '');
    violations.push(...problems.map((problem) => `updateContact: ${problem}`));
    if (!isJson(body)) {
      return fulfil(route, 400, validation([{ path: 'body', code: 'invalid_type' }]));
    }
    const sentWithheld = Object.keys(body).filter((key) => row.withheldFields.includes(key));
    if (sentWithheld.length > 0) {
      violations.push(`updateContact sent ${sentWithheld.join(', ')}, which the record withholds from the caller`);
    }
    if (body.version !== row.version) {
      violations.push(`updateContact sent version ${String(body.version)}; the screen was last served ${row.version}`);
    }
    const fields = Object.keys(body).filter((key) => key !== 'version');

    // Order (the contract): 404, 403 (field_not_editable included), 400, 409.
    const claimable = fields.every((key) => key === 'status' || key === 'ownerUserId') && (!('ownerUserId' in body) || body.ownerUserId === ME.id);
    if (role === 'reader' || (role === 'claimer' && !claimable) || options.refuse === 'not_permitted') {
      return fulfil(route, 403, errorExample('NotPermitted', 'action'));
    }
    const notEditable = fields.filter((key) => sentWithheld.includes(key) || (READ_ONLY[id] ?? []).includes(key));
    if (notEditable.length > 0) {
      const forbidden = errorExample('NotPermitted', 'field');
      forbidden.details = notEditable.map((path) => ({ path, code: 'field_not_editable' }));
      return fulfil(route, 403, forbidden);
    }
    if (problems.length > 0) {
      return fulfil(route, 400, validation(problems.map(() => ({ path: 'body', code: 'invalid_string' }))));
    }
    if (typeof body.ownerUserId === 'string' && !MEMBERS.some((member) => member.id === body.ownerUserId)) {
      violations.push(`updateContact set an owner (${body.ownerUserId}) the screen could not have been served`);
      return fulfil(route, 400, validation([{ path: 'ownerUserId', code: 'unknown_reference' }]));
    }
    if (body.version !== row.version || options.refuse === 'stale_write') {
      return fulfil(route, 409, errorExample('StaleWrite'));
    }

    writeCount += 1;
    const when = serverTime(writeCount);
    const items: TimelineItem[] = [];
    fields.forEach((key, index) => {
      const itemId = `ti_w${String(writeCount).padStart(3, '0')}x${index}`;
      if (key === 'consentState') {
        items.push(consent(itemId, when, ME, { before: String(row.consentState), after: String(body.consentState) }));
      } else if (VALUE_FIELDS.includes(key)) {
        items.push(change(itemId, when, ME, key, { before: row[key] ?? null, after: body[key] ?? null }));
      } else if (REDACTED_FIELDS.includes(key)) {
        items.push(change(itemId, when, ME, key));
      }
    });
    for (const key of fields) {
      if (key === 'ownerUserId') {
        const owner = MEMBERS.find((member) => member.id === body.ownerUserId) ?? null;
        Object.assign(row, ownedBy(owner));
      } else {
        row[key] = body[key];
      }
    }
    row.version += 1;
    row.updatedAt = when;
    checkContact(row);
    addItems(id, items);
    return fulfil(route, 200, served(row));
  };

  // ----- createActivity ----------------------------------------------------

  const activityResponse = (state: ActivityState): Json => {
    const programmeId = String(state.activity.programmeId);
    const withheld = ACTIVITY_WITHHELD[programmeId] ?? [];
    const copy: Json = { ...clone(state.activity), withheldFields: [...withheld] };
    for (const field of withheld) {
      delete copy[field];
    }
    const problems = validateBody(copy, ACTIVITY_SCHEMA, 'activity');
    if (problems.length > 0) {
      throw new Error(`the mock built an Activity the contract rejects: ${problems.join('; ')}`);
    }
    state.servedVersions.add(Number(copy.version));
    return copy;
  };

  const createActivity = async (route: Route, request: Request): Promise<void> => {
    const body = readBody(request, 'createActivity');
    writes.push({ method: 'POST', path: ACTIVITIES_PATH, body });
    await writeGate;
    if (!isJson(body)) {
      violations.push('createActivity body is not an object');
      return fulfil(route, 400, validation([{ path: 'body', code: 'invalid_type' }]));
    }
    const problems = validateBody(body, CREATE_ACTIVITY_SCHEMA, '');
    const contactId = typeof body.contactId === 'string' ? body.contactId : undefined;
    if (contactId === undefined) {
      // The contract allows an account-only activity; logged from a contact's
      // record it would never appear on that record's timeline.
      problems.push('createActivity from the contact record names no contactId');
    }
    if (body.type !== 'task' && body.dueAt !== undefined && body.dueAt !== null) {
      problems.push(`dueAt on a ${String(body.type)} (task_only)`);
    }
    violations.push(...problems.map((problem) => `createActivity: ${problem}`));
    const row = contactId === undefined ? undefined : contacts.get(contactId);
    if (contactId !== undefined && (row === undefined || !servedContacts.has(contactId))) {
      violations.push(`createActivity targeted contact ${contactId}, which the screen was never served`);
      return fulfil(route, 404, errorExample('NotFound'));
    }
    if (row === undefined) {
      return fulfil(route, 400, validation([{ path: 'contactId', code: 'required' }]));
    }
    const owner = body.ownerUserId;
    if (role === 'reader' || (role === 'claimer' && typeof owner === 'string' && owner !== ME.id)) {
      return fulfil(route, 403, errorExample('NotPermitted', 'action'));
    }
    if (problems.length > 0) {
      return fulfil(route, 400, validation(problems.map(() => ({ path: 'body', code: 'invalid_string' }))));
    }
    if (typeof body.accountId === 'string' && body.accountId !== row.accountId) {
      violations.push('createActivity sent an accountId that is not the contact’s account');
      return fulfil(route, 400, validation([{ path: 'accountId', code: 'unknown_reference' }]));
    }
    if (typeof owner === 'string' && !MEMBERS.some((member) => member.id === owner)) {
      violations.push(`createActivity set an owner (${owner}) the screen could not have been served`);
      return fulfil(route, 400, validation([{ path: 'ownerUserId', code: 'unknown_reference' }]));
    }

    const activityId = NEW_ACTIVITY_IDS[activityCount];
    if (activityId === undefined) {
      throw new Error('the mock ran out of NEW_ACTIVITY_IDS');
    }
    activityCount += 1;
    writeCount += 1;
    const when = serverTime(writeCount);
    const state: ActivityState = {
      contactId: row.id,
      itemId: `ti_new${String(activityCount).padStart(2, '0')}`,
      servedVersions: new Set<number>(),
      activity: {
        id: activityId,
        programmeId: row.programmeId,
        type: body.type,
        subject: body.subject ?? null,
        body: body.body ?? null,
        dueAt: body.dueAt ?? null,
        startsAt: body.type === 'meeting' ? (body.startsAt ?? null) : null,
        endsAt: body.type === 'meeting' ? (body.endsAt ?? null) : null,
        completedAt: null,
        ownerUserId: owner ?? null,
        contactId: row.id,
        accountId: body.accountId ?? null,
        createdByUserId: ME.id,
        version: 1,
        createdAt: when,
        updatedAt: when,
      },
    };
    activities.set(activityId, state);
    const withheld = ACTIVITY_WITHHELD[row.programmeId] ?? [];
    const item: TimelineItem = {
      id: state.itemId,
      type: 'activity',
      occurredAt: when,
      actor: actorOf(ME),
      activityId,
      activityType: String(body.type),
      subject: body.subject ?? null,
      body: body.body ?? null,
      dueAt: body.dueAt ?? null,
      startsAt: body.type === 'meeting' ? (body.startsAt ?? null) : null,
      endsAt: body.type === 'meeting' ? (body.endsAt ?? null) : null,
      completedAt: null,
      version: 1,
    };
    for (const field of withheld) {
      delete item[field];
    }
    addItems(row.id, [item]);
    return fulfil(route, 201, activityResponse(state));
  };

  // ----- updateActivity ----------------------------------------------------

  const updateActivity = async (route: Route, request: Request, id: string): Promise<void> => {
    const body = readBody(request, 'updateActivity');
    writes.push({ method: 'PATCH', path: `${ACTIVITIES_PATH}/${id}`, body });
    await writeGate;
    const state = activities.get(id);
    if (state === undefined || !servedContacts.has(state.contactId)) {
      violations.push(`updateActivity named ${id}, which the screen was never served`);
      return fulfil(route, 404, errorExample('NotFound'));
    }
    if (!isJson(body)) {
      violations.push('updateActivity body is not an object');
      return fulfil(route, 400, validation([{ path: 'body', code: 'invalid_type' }]));
    }
    const problems = validateBody(body, UPDATE_ACTIVITY_SCHEMA, '');
    if (body.completed === true && state.activity.type !== 'task') {
      problems.push(`completed on a ${String(state.activity.type)} (task_only)`);
    }
    violations.push(...problems.map((problem) => `updateActivity: ${problem}`));
    const version = Number(body.version);
    if (!state.servedVersions.has(version)) {
      violations.push(
        `updateActivity sent version ${String(body.version)} for ${id}, a version the screen was never served ` +
          '(a timeline item carries none)',
      );
    }
    const reassigning = 'ownerUserId' in body;
    if (role === 'reader' || (role === 'claimer' && reassigning && body.ownerUserId !== ME.id)) {
      return fulfil(route, 403, errorExample('NotPermitted', 'action'));
    }
    if (problems.length > 0) {
      return fulfil(route, 400, validation(problems.map(() => ({ path: 'body', code: 'invalid_string' }))));
    }
    if (version !== state.activity.version) {
      return fulfil(route, 409, errorExample('StaleWrite'));
    }
    writeCount += 1;
    const when = serverTime(writeCount);
    if (body.completed === true) {
      state.activity.completedAt = state.activity.completedAt ?? when;
    }
    if (reassigning) {
      state.activity.ownerUserId = body.ownerUserId ?? null;
    }
    state.activity.version = Number(state.activity.version) + 1;
    state.activity.updatedAt = when;
    // The item shows the activity's current state: changed in place, never added.
    const item = (timelines.get(state.contactId) ?? []).find((candidate) => candidate.id === state.itemId);
    if (item !== undefined && 'completedAt' in item) {
      item.completedAt = state.activity.completedAt;
    }
    if (item !== undefined) {
      item.version = state.activity.version;
    }
    return fulfil(route, 200, activityResponse(state));
  };

  // ----- routing -----------------------------------------------------------

  await page.route(
    (url) => url.pathname.startsWith('/api/v1/'),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      requests.push(url);
      checkHeaders(request, `${method} ${url.pathname}`);

      if (url.pathname === ME_PATH && method === 'GET') {
        meCalls.push(url.toString());
        return fulfil(route, 200, clone(CURRENT_USER));
      }
      if (url.pathname === PROGRAMMES_PATH && method === 'GET') {
        return fulfil(route, 200, { data: [clone(PROGRAMME_ONE), clone(PROGRAMME_TWO)] });
      }
      const contact = /^\/api\/v1\/contacts\/([^/]+)(\/timeline)?$/.exec(url.pathname);
      if (contact !== null) {
        const id = decodeURIComponent(contact[1] ?? '');
        if (contact[2] === '/timeline' && method === 'GET') return timeline(route, url, id);
        if (contact[2] === undefined && method === 'GET') return getContact(route, id);
        if (contact[2] === undefined && method === 'PATCH') return updateContact(route, request, id);
      }
      if (url.pathname === ACTIVITIES_PATH && method === 'POST') {
        return createActivity(route, request);
      }
      const activity = /^\/api\/v1\/activities\/([^/]+)$/.exec(url.pathname);
      if (activity !== null && method === 'PATCH') {
        return updateActivity(route, request, decodeURIComponent(activity[1] ?? ''));
      }
      violations.push(`${method} ${url.pathname} is not an operation the contact record uses`);
      return fulfil(route, 404, errorExample('NotFound'));
    },
  );

  return {
    requests,
    contactReads,
    timelineReads,
    writes,
    meCalls,
    violations,
    contacts,
    timelines,
    release: () => release(),
    releaseWrites: () => releaseWrites(),
  };
}
