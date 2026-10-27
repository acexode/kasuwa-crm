import type { Page, Request, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { TENANT_A } from '@kasuwa/db';

/**
 * The P10 half of `docs/api/scripting.openapi.yaml` (T-0112; served by T-0113
 * and T-0114), plus the reads the two P10 screens need from the records, auth
 * and admin contracts, served into the browser by Playwright for T-0115 (the
 * script builder, P10/05) and T-0116 (the agent's in-call script, manual
 * mode, P10/01 to P10/04).
 *
 * ---------------------------------------------------------------------------
 * READ FROM THE CONTRACT AT RUN TIME, AND EVERY ANSWER CHECKED AGAINST IT
 *
 * Every schema, enum and error body comes out of the YAML when this module
 * loads. Two checks keep the mock honest:
 *
 *   - At load, every script, version, run, disposition and contact declared
 *     below is validated against the schema the contract declares for the
 *     operation that serves it. A contract change this file contradicts fails
 *     here, loudly, before any journey runs.
 *   - At run time, EVERY body the mock answers with is validated against the
 *     schema the contract declares for that operation and status, strictly: a
 *     property the schema does not name is a fault even where the contract
 *     leaves an object open. A fault is the MOCK's, recorded in `mockFaults`,
 *     which `afterEach` in each spec requires to be empty, separately from the
 *     screen's `violations`.
 *
 * TWO WORLDS, ONE MOCK (`world`)
 *
 *   builder — the caller is ADMIN (Kemi Adeyinka, the contract's publisher),
 *             holding `script.write` in PROGRAMME_ONE and PROGRAMME_TWO.
 *             `role: 'agent'` makes the same person a caller WITHOUT
 *             `script.write`: listScripts is an empty page, every script read
 *             or write is 404, and createScript is 403 (D-L96).
 *   agent   — the caller is AGENT (Kemi Balogun, the records contract's
 *             example owner, so the contact-record mock and this one agree on
 *             who is signed in), holding `script.run` in PROGRAMME_ONE.
 *             `role: 'no-script-run'` takes it away: listContactScripts is an
 *             empty page and startScriptRun is 403.
 *
 * WHAT IS NOT IN THE CONTRACT, AND IS THEREFORE DECLARED HERE
 *
 *   - The scripts. The contract's example Script ("Collections – Promise to
 *     pay", revision 42, v12 published) is S_MAIN, moved into the records
 *     contract's example programme (`Bank X Collections`) so that
 *     listMyProgrammes, the contact and the script agree. Its draft is the
 *     example graph plus one compliance node (`crb`, "Credit bureau notice");
 *     its v12 is the example graph with the read-back's older wording (no PIN
 *     warning). So the draft differs from v12 in exactly two compliance nodes:
 *     `readback` changed and `crb` added; `rec` is unchanged.
 *   - In the agent world S_MAIN has a v13 too: the example graph verbatim,
 *     plus one optional free-text field (`detail`) on the `ptp` form, so a
 *     journey can type a sentence an agent might hear and look for it on the
 *     device. New runs pin v13; the contract's example runs pin v12.
 *   - The runs. The contract's five example runs, with the example contact
 *     replaced by the records contract's example contact (Adaeze Okonkwo), and
 *     a handful more at the points the journeys start from.
 *   - Dispositions: the contract's two examples plus four, paged THREE at a
 *     time whatever `limit` says (legal: the contract promises no page size),
 *     so a screen that takes a short page as the last one loses rows.
 *   - Script pages are capped at FOUR rows and version pages at FIVE for the
 *     same reason.
 *
 * WHAT THE MOCK ENFORCES ON EVERY REQUEST (recorded as `violations`, the
 * SCREEN's fault; `afterEach` in each spec fails a test that has any)
 *
 *   - Only the operations listed in OP. Anything else under `/api/v1/` is a
 *     violation: in particular no write to a contact or an activity (a form
 *     never writes a CRM field, D-P31), no listScripts from the agent screen
 *     and nothing of the run API from the builder.
 *   - No request header names a programme or a tenant (CLAUDE.md 2.2).
 *   - Query parameters are the operation's own; `limit` 1..100; a cursor is
 *     echoed exactly as served, for the list it was served for.
 *   - Request bodies are judged against the contract's request schemas, which
 *     are closed. A graph whose shape the API would refuse is the screen's
 *     fault: the builder must never send one.
 *   - updateScript (D-L102): the `revision` last served; a script the screen
 *     was served; at least one changed field; and every field sent differs
 *     from the value last served (changed fields only — an untouched `name`
 *     or `graph` sent back is a violation, after any number of 409s).
 *   - putScriptTranslation: the `revision` last served; never the source
 *     locale.
 *   - publishScript: the `revision` last served.
 *   - getScriptVersion: a version the screen was served (in a version page or
 *     as `latestVersion`).
 *   - Every run write (advance, acknowledge, answers, complete): a run the
 *     screen was served, with the `revision` it was last served. A stale but
 *     served revision is not a violation: it is a 409.
 *   - acknowledgeScriptRunNode: a locale the pinned version can show (its
 *     source locale or a translated one).
 *   - completeScriptRun: a `dispositionId` the screen was served for this run;
 *     `outcome: completed` only where the server would accept it (an `end`
 *     node or a stopped run). Offering `completed` mid-script would hide the
 *     compliance nodes the call never reached (D-L93).
 *
 * SERVER BEHAVIOUR THE SCREENS DEPEND ON, IMPLEMENTED AS THE CONTRACT SAYS
 *
 *   - Out of scope is 404 with ONE body; a non-uuid path id is 400.
 *   - Writes apply. updateScript and putScriptTranslation advance `revision`
 *     and set `hasUnpublishedChanges`; publishScript mints `latest + 1`,
 *     leaves `revision` alone (T-0113), and refuses an unchanged draft with
 *     `409 script_invalid` / `unchanged`.
 *   - The run engine: advance picks the next node on the SERVER; a branch is
 *     evaluated on entry and never becomes current unless it stops the run;
 *     a compliance node needs its acknowledgement; a form needs its required
 *     answers; an `end` is `run_at_end`. Completion checks, in the contract's
 *     order, compliance, a live disposition and its requirements; an exact
 *     repeat of the completing request is `200` and writes nothing.
 *   - `branch` decides branches: `evaluate` (default) reads the contact as
 *     getContact serves it (a withheld field stops the run), `true`/`false`
 *     force a side regardless of what the screen can see — so a screen that
 *     evaluates a branch itself goes the wrong way — and `sensitive` stops
 *     with `sensitive_field`.
 * ---------------------------------------------------------------------------
 */

export const SCRIPTING_CONTRACT_SOURCE = 'docs/api/scripting.openapi.yaml';
export const RECORDS_CONTRACT_SOURCE = 'docs/api/records.openapi.yaml';
export const AUTH_CONTRACT_SOURCE = 'docs/api/auth.openapi.yaml';
export const ADMIN_CONTRACT_SOURCE = 'docs/api/admin.openapi.yaml';

const repoRoot = resolve(__dirname, '..', '..', '..');

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Key-order-insensitive JSON, for "did this change". */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isJson(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function load(source: string): unknown {
  return parse(readFileSync(resolve(repoRoot, source), 'utf8'));
}

const SCRIPTING: unknown = load(SCRIPTING_CONTRACT_SOURCE);
const RECORDS: unknown = load(RECORDS_CONTRACT_SOURCE);
const AUTH: unknown = load(AUTH_CONTRACT_SOURCE);
const ADMIN_DOC: unknown = load(ADMIN_CONTRACT_SOURCE);

const DOCUMENTS: Readonly<Record<string, unknown>> = {
  './scripting.openapi.yaml': SCRIPTING,
  './records.openapi.yaml': RECORDS,
  './auth.openapi.yaml': AUTH,
  './admin.openapi.yaml': ADMIN_DOC,
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

function schema(name: string, doc: unknown = SCRIPTING): Json {
  return at(doc, 'components', 'schemas', name) as Json;
}

function enumOf(name: string, ...path: string[]): readonly string[] {
  return (at(schema(name), ...path, 'enum') as unknown[]).filter((value) => value !== null).map(String);
}

function example(name: string): Json {
  return clone(at(SCRIPTING, 'components', 'examples', name, 'value')) as Json;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const SCRIPTS_PATH = '/api/v1/scripts';
const RUNS_PATH = '/api/v1/script-runs';
const CONTACTS_PATH = '/api/v1/contacts';
const PROGRAMMES_PATH = '/api/v1/me/programmes';
const ME_PATH = '/api/v1/auth/me';
const CAPABILITIES_PATH = '/api/v1/me/capabilities';
const ADMIN_PROGRAMMES_PATH = '/api/v1/admin/programmes';

/** Every operation either screen may call: contract path, method and the contract it is in. */
const OP = {
  listScripts: [SCRIPTS_PATH, 'get', SCRIPTING],
  createScript: [SCRIPTS_PATH, 'post', SCRIPTING],
  getScript: [`${SCRIPTS_PATH}/{scriptId}`, 'get', SCRIPTING],
  updateScript: [`${SCRIPTS_PATH}/{scriptId}`, 'patch', SCRIPTING],
  listScriptVersions: [`${SCRIPTS_PATH}/{scriptId}/versions`, 'get', SCRIPTING],
  publishScript: [`${SCRIPTS_PATH}/{scriptId}/versions`, 'post', SCRIPTING],
  getScriptVersion: [`${SCRIPTS_PATH}/{scriptId}/versions/{versionId}`, 'get', SCRIPTING],
  putScriptTranslation: [`${SCRIPTS_PATH}/{scriptId}/translations/{locale}`, 'put', SCRIPTING],
  listContactScripts: [`${CONTACTS_PATH}/{contactId}/scripts`, 'get', SCRIPTING],
  startScriptRun: [RUNS_PATH, 'post', SCRIPTING],
  getScriptRun: [`${RUNS_PATH}/{runId}`, 'get', SCRIPTING],
  getScriptRunScript: [`${RUNS_PATH}/{runId}/script`, 'get', SCRIPTING],
  advanceScriptRun: [`${RUNS_PATH}/{runId}/advance`, 'post', SCRIPTING],
  acknowledgeScriptRunNode: [`${RUNS_PATH}/{runId}/acknowledgements`, 'post', SCRIPTING],
  recordScriptRunAnswers: [`${RUNS_PATH}/{runId}/answers`, 'patch', SCRIPTING],
  listScriptRunDispositions: [`${RUNS_PATH}/{runId}/dispositions`, 'get', SCRIPTING],
  completeScriptRun: [`${RUNS_PATH}/{runId}/complete`, 'post', SCRIPTING],
  getContact: [`${CONTACTS_PATH}/{contactId}`, 'get', RECORDS],
  listMyProgrammes: [PROGRAMMES_PATH, 'get', RECORDS],
  getCurrentUser: [ME_PATH, 'get', AUTH],
  getMyCapabilities: [CAPABILITIES_PATH, 'get', AUTH],
  listDispositions: [`${ADMIN_PROGRAMMES_PATH}/{programmeId}/dispositions`, 'get', ADMIN_DOC],
} as const;

export type Operation = keyof typeof OP;

/** Which world may call which operation. A call from the other world is a violation. */
const BUILDER_OPS: readonly Operation[] = [
  'listScripts',
  'createScript',
  'getScript',
  'updateScript',
  'listScriptVersions',
  'publishScript',
  'getScriptVersion',
  'putScriptTranslation',
  'listMyProgrammes',
  'getCurrentUser',
  'getMyCapabilities',
  'listDispositions',
];
const AGENT_OPS: readonly Operation[] = [
  'listContactScripts',
  'startScriptRun',
  'getScriptRun',
  'getScriptRunScript',
  'advanceScriptRun',
  'acknowledgeScriptRunNode',
  'recordScriptRunAnswers',
  'listScriptRunDispositions',
  'completeScriptRun',
  'getContact',
  'listMyProgrammes',
  'getCurrentUser',
  'getMyCapabilities',
];

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

// ---------------------------------------------------------------------------
// Validation: the JSON-Schema subset these contracts use
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
 * that declares properties and no `additionalProperties` schema as closed:
 * used on the mock's OWN answers, never on what the screen sends.
 */
export function validateBody(value: unknown, raw: unknown, path: string, doc: unknown = SCRIPTING, strict = false): string[] {
  const located = deref(raw, doc);
  const spec = located.node as Json;
  const where = path || 'body';
  if (isJson(spec.discriminator) && Array.isArray(spec.oneOf)) {
    const property = String(spec.discriminator.propertyName);
    const mapping = (spec.discriminator.mapping ?? {}) as Json;
    if (!isJson(value)) return [`${where} is ${typeOf(value)}, not an object`];
    const target = mapping[String(value[property])];
    if (typeof target !== 'string') {
      return [`${where}.${property} is not one of ${Object.keys(mapping).join(', ')}`];
    }
    return validateBody(value, { $ref: target }, path, located.doc, strict);
  }
  if (Array.isArray(spec.oneOf)) {
    const passing = spec.oneOf.filter((option) => validateBody(value, option, path, located.doc, strict).length === 0);
    if (passing.length !== 1) {
      return [`${where} matches ${passing.length} of oneOf, not exactly 1`];
    }
  }
  const problems: string[] = [];
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
  if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
    problems.push(`${where} is not one of ${spec.enum.map(String).join(', ')}`);
  }
  if (typeof value === 'string') {
    if (typeof spec.minLength === 'number' && value.length < spec.minLength) problems.push(`${where} is too short`);
    if (typeof spec.maxLength === 'number' && value.length > spec.maxLength) problems.push(`${where} is too long`);
    if (typeof spec.pattern === 'string' && !new RegExp(spec.pattern).test(value)) {
      problems.push(`${where} does not match ${spec.pattern}`);
    }
    if (spec.format === 'uuid' && !UUID_PATTERN.test(value)) problems.push(`${where} is not a uuid`);
    if (spec.format === 'date-time' && !UTC_DATE_TIME.test(value)) problems.push(`${where} is not a UTC date-time with a Z`);
    if (spec.format === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) problems.push(`${where} is not an email`);
    if (value.includes('\u0000')) problems.push(`${where} carries a NUL`);
  }
  if (typeof value === 'number') {
    if (typeof spec.minimum === 'number' && value < spec.minimum) problems.push(`${where} is below ${spec.minimum}`);
    if (typeof spec.maximum === 'number' && value > spec.maximum) problems.push(`${where} is above ${spec.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof spec.minItems === 'number' && value.length < spec.minItems) problems.push(`${where} has too few items`);
    if (typeof spec.maxItems === 'number' && value.length > spec.maxItems) problems.push(`${where} has too many items`);
    if (spec.items !== undefined) {
      value.forEach((item, index) => problems.push(...validateBody(item, spec.items, `${path}.${index}`, located.doc, strict)));
    }
  }
  const objectish =
    spec.properties !== undefined ||
    spec.required !== undefined ||
    spec.additionalProperties !== undefined ||
    spec.propertyNames !== undefined;
  if (isJson(value) && objectish) {
    const properties = (spec.properties ?? {}) as Json;
    const declared = declaredKeys(spec, located.doc);
    for (const key of (spec.required ?? []) as string[]) {
      if (!(key in value)) problems.push(`${path ? `${path}.` : ''}${key} is required`);
    }
    const count = Object.keys(value).length;
    if (typeof spec.minProperties === 'number' && count < spec.minProperties) {
      problems.push(`${where} has fewer than ${spec.minProperties} properties`);
    }
    if (typeof spec.maxProperties === 'number' && count > spec.maxProperties) {
      problems.push(`${where} has more than ${spec.maxProperties} properties`);
    }
    for (const [key, item] of Object.entries(value)) {
      const child = `${path ? `${path}.` : ''}${key}`;
      if (spec.propertyNames !== undefined) {
        problems.push(...validateBody(key, spec.propertyNames, `${child} (name)`, located.doc, false));
      }
      if (!(key in properties)) {
        if (spec.additionalProperties === false) {
          problems.push(`${child} is not a property of this closed body`);
        } else if (isJson(spec.additionalProperties)) {
          problems.push(...validateBody(item, spec.additionalProperties, child, located.doc, strict));
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

/** What is wrong with answering `operation` with `status` and `body`, strictly. */
export function answerProblems(operation: Operation, status: number, body: unknown): string[] {
  const [path, method, document] = OP[operation];
  const responses = at(document, 'paths', path, method, 'responses') as Json;
  const declared = responses[String(status)];
  if (declared === undefined) {
    return [`${operation} declares no ${status} response`];
  }
  const response = deref(declared, document);
  const content = at(response.node, 'content', 'application/json', 'schema');
  return validateBody(body, content, `${operation} ${status}`, response.doc, true);
}

/** The error `code`s an operation can answer with, read from its error responses' examples. */
export function errorCodes(operation: Operation): string[] {
  const [path, method, document] = OP[operation];
  const codes = new Set<string>();
  for (const [status, raw] of Object.entries(at(document, 'paths', path, method, 'responses') as Json)) {
    if (status.startsWith('2')) continue;
    const json = at(deref(raw, document).node, 'content', 'application/json') as Json;
    const examples = [json.example, ...Object.values((json.examples ?? {}) as Json).map((entry) => (entry as Json).value)];
    for (const entry of examples) {
      if (isJson(entry) && typeof entry.code === 'string') codes.add(entry.code);
    }
  }
  return [...codes].sort();
}

function errorBody(response: string, name?: string): Json {
  const json = at(deref(at(SCRIPTING, 'components', 'responses', response), SCRIPTING).node, 'content', 'application/json') as Json;
  const body = name === undefined ? json.example : at(json.examples, name, 'value');
  return clone(body) as Json;
}

function validation(details: { path: string; code: string }[]): Json {
  const body = errorBody('ValidationFailed', 'badCursor');
  body.details = details;
  return body;
}

function conflict(response: string, name: string, details?: { path: string; code: string }[]): Json {
  const body = errorBody(response, name);
  if (details !== undefined) body.details = details;
  return body;
}

// ---------------------------------------------------------------------------
// The contract's vocabularies
// ---------------------------------------------------------------------------

/** The six node kinds, from ScriptNode's discriminator (D-L91). There is no disposition node. */
export const NODE_TYPES: readonly string[] = Object.keys(at(schema('ScriptNode'), 'discriminator', 'mapping') as Json);
export const CONDITION_OPERATORS: readonly string[] = enumOf('ConditionOperator');
export const CONDITION_SOURCES: readonly string[] = Object.keys(at(schema('BranchCondition'), 'discriminator', 'mapping') as Json);
export const FORM_FIELD_TYPES: readonly string[] = enumOf('FormField', 'properties', 'type');
export const SCRIPT_LOCALES: readonly string[] = enumOf('ScriptLocale');
export const STOP_REASONS: readonly string[] = enumOf('ScriptRun', 'properties', 'stopReason');
export const RUN_OUTCOMES: readonly string[] = enumOf('CompleteScriptRunRequest', 'properties', 'outcome');
/**
 * The Contact wire names a branch or a `{contact.<field>}` variable may name
 * (ContactFieldCondition: "a Contact wire name (records.openapi.yaml)").
 * `withheldFields` is the security envelope, not a field.
 */
export const CONTACT_FIELDS: readonly string[] = Object.keys(at(schema('Contact', RECORDS), 'properties') as Json).filter(
  (name) => name !== 'withheldFields',
);
/** The variable families the contract allows (ScriptGraph). `loan.*` waits (D-L88). */
export const VARIABLE_PATTERN = /^(contact\.[a-z][A-Za-z0-9]*|agent\.displayName|answer\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)$/;

/**
 * The reason codes publishScript's `409 script_invalid` names (its
 * description, not an enum). Checked against the description at load, so a
 * reason added there without a label here fails loudly.
 */
export const PUBLISH_REASONS: readonly string[] = [
  'missing_start',
  'empty_script',
  'unknown_target',
  'unreachable_end',
  'cycle',
  'unknown_field',
  'unknown_variable',
  'disposition_not_live',
  'unchanged',
  'sensitive_field',
  'branch_on_withheld_field',
];
{
  const prose = String(at(SCRIPTING, 'paths', OP.publishScript[0], 'post', 'description'));
  const named = [...prose.matchAll(/`([a-z_]+)`/g)].map((match) => match[1] ?? '');
  for (const reason of PUBLISH_REASONS) {
    if (!named.includes(reason)) throw new Error(`${SCRIPTING_CONTRACT_SOURCE}: publishScript no longer names ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// People and programmes
// ---------------------------------------------------------------------------

export interface Programme {
  id: string;
  name: string;
}

export interface Person {
  id: string;
  displayName: string;
}

/** The records contract's example programme (`Bank X Collections`). */
export const PROGRAMME_ONE = clone(
  at(RECORDS, 'paths', PROGRAMMES_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', '0'),
) as Programme;

/** A second programme of the same tenant. */
export const PROGRAMME_TWO: Programme = { id: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a02', name: 'Lagos Water Customer Care' };

const EXAMPLE_PROGRAMME = String(example('Script').programmeId);

/** The builder's caller: the contract's publisher. */
export const ADMIN: Person = clone(at(example('Script'), 'latestVersion', 'publishedBy') as Person);

const CONTACT_EXAMPLE = clone(
  at(RECORDS, 'paths', CONTACTS_PATH, 'get', 'responses', '200', 'content', 'application/json', 'example', 'data', '0'),
) as Json;

/** The agent's caller: the records contract's example owner, as the contact-record mock has it. */
export const AGENT: Person = clone(CONTACT_EXAMPLE.owner as Person);

/** Another agent of PROGRAMME_ONE. Their runs are 404 to everyone else. */
export const OTHER_AGENT: Person = clone(at(example('ScriptRunInProgress'), 'startedBy') as Person);

function currentUser(person: Person, email: string): Json {
  return { id: person.id, tenantId: TENANT_A, email, displayName: person.displayName, locale: 'en-NG' };
}

export const ADMIN_USER = currentUser(ADMIN, 'kemi.adeyinka@example.ng');
export const AGENT_USER = currentUser(AGENT, 'kemi.balogun@example.ng');

// ---------------------------------------------------------------------------
// Contacts (the agent world reads them for variables)
// ---------------------------------------------------------------------------

export interface ContactRow {
  id: string;
  programmeId: string;
  displayName: string;
  withheldFields: string[];
  [property: string]: unknown;
}

function checkContact(row: ContactRow): ContactRow {
  const problems = answerProblems('getContact', 200, row);
  const leaked = row.withheldFields.filter((field) => field in row);
  if (problems.length > 0 || leaked.length > 0) {
    throw new Error(`contact ${row.id} disagrees with ${RECORDS_CONTRACT_SOURCE}: ${[...problems, ...leaked].join('; ')}`);
  }
  return row;
}

/**
 * The records contract's example contact, verbatim: Adaeze Okonkwo, status
 * `contacted` (so the example graph's `cust` branch — `status one_of
 * [customer]` — is FALSE when evaluated honestly), `emails` withheld.
 */
export const CONTACT = checkContact(clone(CONTACT_EXAMPLE) as ContactRow);

/** In PROGRAMME_TWO, with `status` withheld: an honest branch on it stops the run. */
export const CONTACT_LOCKED = checkContact(
  ((): ContactRow => {
    const row = { ...clone(CONTACT_EXAMPLE), id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e02', programmeId: PROGRAMME_TWO.id, displayName: 'Chidi Eze', givenNames: 'Chidi', familyName: 'Eze', withheldFields: ['emails', 'accountId', 'account', 'status'] } as ContactRow;
    delete row.status;
    return row;
  })(),
);

function sibling(id: string, displayName: string, overrides: Partial<ContactRow> = {}): ContactRow {
  const [givenNames, ...rest] = displayName.split(' ');
  return checkContact({ ...(clone(CONTACT_EXAMPLE) as ContactRow), id, displayName, givenNames: givenNames ?? null, familyName: rest.join(' ') || null, ...overrides });
}

/**
 * The contact-record mock's CONTACT_NULLS (same id): no run of any script yet,
 * so starting one from its record is a 201. `status` is null.
 */
export const CONTACT_FRESH = sibling('3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e03', 'Musa Danladi', { status: null });

/**
 * One contact per seeded run: the contract allows one in-progress run per
 * agent, contact and script (D-L91), so seeded runs of S_MAIN cannot share one.
 * Each is the example contact under another id and name (status `contacted`).
 */
const RUN_CONTACT = (n: string, name: string): ContactRow => sibling(`3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e${n}`, name);
export const CONTACT_AT_GREET = RUN_CONTACT('21', 'Bola Adewale');
export const CONTACT_AT_FORM = RUN_CONTACT('22', 'Chinedu Okeke');
export const CONTACT_AT_END = RUN_CONTACT('23', 'Danjuma Bello');
export const CONTACT_AT_CALLBACK = RUN_CONTACT('24', 'Efua Mensah');
export const CONTACT_AT_READBACK = RUN_CONTACT('25', 'Fatima Sule');
export const CONTACT_AT_REC = RUN_CONTACT('26', 'Gbenga Ade');
export const CONTACT_AT_INTRO = RUN_CONTACT('27', 'Halima Musa');
export const CONTACT_AT_IDQ = RUN_CONTACT('28', 'Ifeanyi Obi');

const CONTACTS: readonly ContactRow[] = [
  CONTACT,
  CONTACT_LOCKED,
  CONTACT_FRESH,
  CONTACT_AT_GREET,
  CONTACT_AT_FORM,
  CONTACT_AT_END,
  CONTACT_AT_CALLBACK,
  CONTACT_AT_READBACK,
  CONTACT_AT_REC,
  CONTACT_AT_INTRO,
  CONTACT_AT_IDQ,
];

export function contactById(id: string): ContactRow {
  const found = CONTACTS.find((row) => row.id === id);
  if (found === undefined) throw new Error(`no scripting-mock contact ${id}`);
  return found;
}

export const NO_SUCH_ID = '00000000-0000-4000-8000-00000000dead';

// ---------------------------------------------------------------------------
// Graphs
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  type: string;
  title: string;
  [property: string]: unknown;
}

export interface Graph {
  startNodeId: string;
  nodes: GraphNode[];
}

type Translations = Record<string, Record<string, Json>>;

/** The contract's example graph (greet, rec, idq, idfail, cust, intro, payq, ptp, refused, cbend, readback, close). */
const EXAMPLE_GRAPH = clone(at(example('Script'), 'draft', 'graph')) as Graph;
const EXAMPLE_TRANSLATIONS = clone(at(example('Script'), 'draft', 'translations')) as Translations;

function node(graph: Graph, id: string): GraphNode {
  const found = graph.nodes.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`${SCRIPTING_CONTRACT_SOURCE}: the example graph has no ${id} node`);
  return found;
}

/** The read-back as v12 had it: before the PIN warning was added. */
export const V12_READBACK_TEXT = "To confirm: you'll pay {answer.ptp.amount} on {answer.ptp.date}.";
export const CRB_TITLE = 'Credit bureau notice';

/** v12: the example graph, the read-back's older wording. */
const V12_GRAPH = ((): Graph => {
  const graph = clone(EXAMPLE_GRAPH);
  node(graph, 'readback').text = V12_READBACK_TEXT;
  return graph;
})();

/** The builder's draft: the example graph plus `crb` between `intro` and `payq`. */
const DRAFT_GRAPH = ((): Graph => {
  const graph = clone(EXAMPLE_GRAPH);
  node(graph, 'intro').next = 'crb';
  const index = graph.nodes.findIndex((candidate) => candidate.id === 'payq');
  graph.nodes.splice(index, 0, {
    id: 'crb',
    type: 'compliance',
    title: CRB_TITLE,
    text: 'As your account is more than 30 days past due, it may be reported to licensed credit bureaus.',
    next: 'payq',
    position: { x: 330, y: 500 },
  });
  return graph;
})();

/** Free text an agent might hear: sensitive, so it must never reach the device or a log. */
export const DETAIL_FIELD = { key: 'detail', label: 'Anything else the customer said', type: 'text', required: false, maxLength: 500 };

/** The agent world's v13: the example graph, plus `detail` on the form and a variable on a withheld field. */
const V13_GRAPH = ((): Graph => {
  const graph = clone(EXAMPLE_GRAPH);
  (node(graph, 'ptp').fields as Json[]).push(clone(DETAIL_FIELD));
  // `emails` is withheld on CONTACT: this variable renders as a placeholder, never a guess.
  node(graph, 'intro').text = "Thank you. I'm calling about the application you started with us. I'll send a copy to {contact.emails}.";
  return graph;
})();

/** The smallest valid graph: what createScript makes with no `graph` (and what publish refuses). */
export const DEFAULT_GRAPH: Graph = { startNodeId: 'start', nodes: [{ id: 'start', type: 'end', title: 'End' }] };

export const HOSTILE_TITLE = '<b>Bold</b> greeting';
export const HOSTILE_TEXT = '<img src=x onerror="window.__kasuwaXss=1">Hello {contact.displayName}, <i>welcome</i>';

const HOSTILE_GRAPH: Graph = {
  startNodeId: 'hello',
  nodes: [
    { id: 'hello', type: 'say', title: HOSTILE_TITLE, text: HOSTILE_TEXT, next: 'bye', position: { x: 40, y: 30 } },
    { id: 'bye', type: 'end', title: 'Bye', text: null, suggestedDispositionId: null, position: { x: 40, y: 160 } },
  ],
};

// ---------------------------------------------------------------------------
// Dispositions
// ---------------------------------------------------------------------------

export interface RunDisposition {
  id: string;
  code: string;
  label: string;
  category: string;
  noteRequired: boolean;
  followUpRequired: boolean;
  position: number;
}

const DISPOSITION_EXAMPLE = clone(
  at(SCRIPTING, 'paths', OP.listScriptRunDispositions[0], 'get', 'responses', '200', 'content', 'application/json', 'example', 'data'),
) as RunDisposition[];

function exampleDisposition(code: string): RunDisposition {
  const found = DISPOSITION_EXAMPLE.find((row) => row.code === code);
  if (found === undefined) throw new Error(`${SCRIPTING_CONTRACT_SOURCE}: no ${code} disposition example`);
  return found;
}

/** Promise to pay: a note is required (the example). The `close` end node suggests it. */
export const D_PTP = exampleDisposition('PTP');
/** Call back: a follow-up is required (the example). `cbend` and `idfail` suggest it. */
export const D_CALLBACK = exampleDisposition('CALLBACK');
export const D_REFUSED: RunDisposition = { id: '9d1b4e70-2c5a-4e8f-b6d3-1a7c0e9f4b22', code: 'REFUSED', label: 'Refused to pay', category: 'resolved', noteRequired: false, followUpRequired: false, position: 2 };
export const D_NO_ANSWER: RunDisposition = { id: '9d1b4e70-2c5a-4e8f-b6d3-1a7c0e9f4b23', code: 'NOANS', label: 'No answer', category: 'not_reached', noteRequired: false, followUpRequired: false, position: 4 };
export const D_WRONG: RunDisposition = { id: '9d1b4e70-2c5a-4e8f-b6d3-1a7c0e9f4b24', code: 'WRONG', label: 'Wrong number', category: 'not_reached', noteRequired: false, followUpRequired: false, position: 5 };
export const D_ESCALATE: RunDisposition = { id: '9d1b4e70-2c5a-4e8f-b6d3-1a7c0e9f4b26', code: 'ESCALATE', label: 'Escalate to supervisor', category: 'escalated', noteRequired: true, followUpRequired: false, position: 6 };

/** In served order: position, then id. */
export const DISPOSITIONS: readonly RunDisposition[] = [D_PTP, D_REFUSED, D_CALLBACK, D_NO_ANSWER, D_WRONG, D_ESCALATE];
export const DISPOSITION_PAGE_CAP = 3;

// ---------------------------------------------------------------------------
// Scripts and versions (the builder world; the agent world reuses S_MAIN)
// ---------------------------------------------------------------------------

export interface VersionSummary {
  id: string;
  number: number;
  publishedAt: string;
  publishedBy: Person | null;
}

export interface ScriptVersionRow {
  id: string;
  scriptId: string;
  number: number;
  name: string;
  sourceLocale: string;
  graph: Graph;
  translations: Translations;
  changes: string[];
  publishedAt: string;
  publishedBy: Person | null;
}

export interface ScriptRow {
  id: string;
  programmeId: string;
  name: string;
  sourceLocale: string;
  translatedLocales: string[];
  hasUnpublishedChanges: boolean;
  latestVersion: VersionSummary | null;
  draft: { graph: Graph; translations: Translations };
  revision: number;
  createdAt: string;
  updatedAt: string;
}

function summaryOf(version: ScriptVersionRow): VersionSummary {
  return { id: version.id, number: version.number, publishedAt: version.publishedAt, publishedBy: version.publishedBy };
}

const VERSION_ID = (n: number): string => `2f8e6d14-7a3b-4c9e-8d21-5b0a9c3e7f${String(n).padStart(2, '0')}`;

function checkVersion(row: ScriptVersionRow): ScriptVersionRow {
  const problems = answerProblems('getScriptVersion', 200, row);
  if (problems.length > 0) throw new Error(`version ${row.number} disagrees with ${SCRIPTING_CONTRACT_SOURCE}: ${problems.join('; ')}`);
  return row;
}

function checkScript(row: ScriptRow): ScriptRow {
  const problems = answerProblems('getScript', 200, row);
  if (problems.length > 0) throw new Error(`script ${row.name} disagrees with ${SCRIPTING_CONTRACT_SOURCE}: ${problems.join('; ')}`);
  return row;
}

const S_MAIN_ID = String(example('Script').id);

/** v12 of S_MAIN: the contract's example version, with v12's older read-back. */
export const VERSION_12 = checkVersion({
  ...(example('ScriptVersion') as unknown as ScriptVersionRow),
  graph: clone(V12_GRAPH),
});

/** v1..v11 of S_MAIN, older and older: enough for a second version page. */
const OLDER_VERSIONS: ScriptVersionRow[] = Array.from({ length: 11 }, (_, index) => {
  const number = 11 - index;
  return checkVersion({
    ...clone(VERSION_12),
    id: VERSION_ID(number),
    number,
    changes: [`Revision ${number}`],
    publishedAt: new Date(Date.parse('2026-09-01T09:00:00Z') + number * 86_400_000).toISOString(),
  });
});

/** The agent world's v13: what new runs pin. */
export const VERSION_13 = checkVersion({
  ...clone(VERSION_12),
  id: VERSION_ID(13),
  number: 13,
  graph: clone(V13_GRAPH),
  changes: ['Read-back adds the PIN warning'],
  publishedAt: '2026-10-07T13:55:00Z',
});

/**
 * The contract's example script: draft revision 42, v12 published, unpublished
 * changes. Its draft differs from v12 in `readback` (changed) and `crb`
 * (added); `rec` is unchanged.
 */
export const S_MAIN = checkScript({
  ...(example('Script') as unknown as ScriptRow),
  programmeId: PROGRAMME_ONE.id,
  draft: { graph: clone(DRAFT_GRAPH), translations: clone(EXAMPLE_TRANSLATIONS) },
});

const SCRIPT_ID = (n: string): string => `6c3a9e10-5b2d-4f71-9a8e-0d4c2b7f1a${n}`;

function draftScript(overrides: Partial<ScriptRow> & { id: string; name: string }): ScriptRow {
  return checkScript({
    programmeId: PROGRAMME_ONE.id,
    sourceLocale: 'en',
    translatedLocales: [],
    hasUnpublishedChanges: true,
    latestVersion: null,
    draft: { graph: clone(DEFAULT_GRAPH), translations: {} },
    revision: 1,
    createdAt: '2026-09-25T13:05:00Z',
    updatedAt: '2026-09-25T13:05:00Z',
    ...overrides,
  });
}

/** The list example's second row: never published. */
export const S_HARDSHIP = draftScript({ id: SCRIPT_ID('03'), name: 'Hardship and restructuring' });

const PUBLISHED_ONCE = (scriptId: string, number: number, publishedAt: string): ScriptVersionRow =>
  checkVersion({ ...clone(VERSION_12), id: `2f8e6d14-7a3b-4c9e-8d21-${scriptId.slice(-12)}`, scriptId, number, publishedAt, changes: [] });

export const S_KYC_ID = SCRIPT_ID('04');
const KYC_VERSION = PUBLISHED_ONCE(S_KYC_ID, 3, '2026-09-20T09:00:00Z');
/** In PROGRAMME_TWO, published, no unpublished changes. */
export const S_KYC = draftScript({
  id: S_KYC_ID,
  programmeId: PROGRAMME_TWO.id,
  name: 'Address verification',
  hasUnpublishedChanges: false,
  latestVersion: summaryOf(KYC_VERSION),
  draft: { graph: clone(KYC_VERSION.graph), translations: clone(KYC_VERSION.translations) },
  translatedLocales: ['pcm'],
  revision: 9,
});

export const S_WELCOME_ID = SCRIPT_ID('05');
const WELCOME_VERSION = PUBLISHED_ONCE(S_WELCOME_ID, 1, '2026-09-10T09:00:00Z');
export const S_WELCOME = draftScript({
  id: S_WELCOME_ID,
  name: 'Welcome call',
  hasUnpublishedChanges: false,
  latestVersion: summaryOf(WELCOME_VERSION),
  draft: { graph: clone(WELCOME_VERSION.graph), translations: clone(WELCOME_VERSION.translations) },
  translatedLocales: ['pcm'],
  revision: 3,
});

export const S_SURVEY = draftScript({ id: SCRIPT_ID('06'), programmeId: PROGRAMME_TWO.id, name: 'Customer survey' });

/** Markup in wording and in a name: drawn as text, never parsed (the contract: wording is plain text). */
export const HOSTILE_NAME = '<img src=y onerror="window.__kasuwaXss=2"><b>Arrears</b> follow-up';
export const S_HOSTILE = draftScript({ id: SCRIPT_ID('07'), name: HOSTILE_NAME, draft: { graph: clone(HOSTILE_GRAPH), translations: {} } });

/** A real-looking script id the caller cannot author (another programme, tenant, or no script.write): 404. */
export const OUT_OF_SCOPE_SCRIPT_ID = SCRIPT_ID('99');

/** The id createScript gives the first new script. */
export const NEW_SCRIPT_ID = SCRIPT_ID('21');

/** Every script, as listScripts orders them for ADMIN: by name (code units), then id. */
export const ALL_SCRIPTS: readonly ScriptRow[] = [S_MAIN, S_HARDSHIP, S_KYC, S_WELCOME, S_SURVEY, S_HOSTILE].sort((a, b) =>
  a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.id < b.id ? -1 : 1,
);
export const SCRIPT_PAGE_CAP = 4;
export const VERSION_PAGE_CAP = 5;

/** S_MAIN's versions in the builder world, newest first. */
export const MAIN_VERSIONS: readonly ScriptVersionRow[] = [VERSION_12, ...OLDER_VERSIONS];

const BUILDER_VERSIONS: Readonly<Record<string, readonly ScriptVersionRow[]>> = {
  [S_MAIN.id]: MAIN_VERSIONS,
  [S_KYC.id]: [KYC_VERSION],
  [S_WELCOME.id]: [WELCOME_VERSION],
};

/** Who else edits S_MAIN, in the stale-draft journeys. */
export const OTHER_GREET_TEXT = 'Good afternoon, {contact.displayName}. This is {agent.displayName} from Bank X. Is now a good time?';
export const OTHER_NAME = 'Collections – Promise to pay (reviewed)';
export const OTHER_PAYQ_TITLE = 'Can you pay today?';

/** The live dispositions of each programme, as admin's listProgrammeDispositions serves them. */
const ADMIN_DISPOSITIONS: Readonly<Record<string, readonly RunDisposition[]>> = {
  [PROGRAMME_ONE.id]: DISPOSITIONS,
  [PROGRAMME_TWO.id]: [D_NO_ANSWER],
};

// ---------------------------------------------------------------------------
// Runs (the agent world)
// ---------------------------------------------------------------------------

export interface RunStep {
  nodeId: string;
  enteredAt: string;
  branchOutcome?: boolean | null;
}

export interface Acknowledgement {
  nodeId: string;
  locale: string;
  profileLocale: string | null;
  acknowledgedAt: string;
}

export interface ScriptRunRow {
  id: string;
  programmeId: string;
  contactId: string;
  scriptId: string;
  versionId: string;
  versionNumber: number;
  latestVersion: VersionSummary;
  status: 'in_progress' | 'stopped' | 'completed';
  outcome: string | null;
  unacknowledgedComplianceNodeIds: string[];
  endedAtNodeId: string | null;
  stopReason: string | null;
  currentNodeId: string | null;
  path: RunStep[];
  acknowledgements: Acknowledgement[];
  answers: Record<string, Json>;
  startedBy: Person;
  startedAt: string;
  completedAt: string | null;
  dispositionId: string | null;
  activityId: string | null;
  followUpTaskId: string | null;
  revision: number;
}

const RUN_ID = (n: string): string => `4a7e2c91-8b3d-4f60-a5e2-7c9d1b0f3e${n}`;

function checkRun(row: ScriptRunRow): ScriptRunRow {
  const problems = answerProblems('getScriptRun', 200, row);
  if (problems.length > 0) throw new Error(`run ${row.id} disagrees with ${SCRIPTING_CONTRACT_SOURCE}: ${problems.join('; ')}`);
  return row;
}

function exampleRun(name: string, id: string): ScriptRunRow {
  const row = example(name) as unknown as ScriptRunRow;
  if (row.programmeId !== EXAMPLE_PROGRAMME) throw new Error(`${name} is not in the example programme`);
  return checkRun({ ...row, id, programmeId: PROGRAMME_ONE.id, contactId: CONTACT.id, startedBy: clone(AGENT), latestVersion: summaryOf(VERSION_13) });
}

/** Mid-call on v12 while v13 is live: at `payq` (P10/01, the update banner). Revision 7. */
export const RUN_RESUME = exampleRun('ScriptRunInProgress', RUN_ID('40'));
/** Stopped at `cust` on a withheld field (the example). */
export const RUN_STOPPED = exampleRun('ScriptRunStopped', RUN_ID('41'));
/** Completed with a promise to pay (the example). */
export const RUN_COMPLETED = exampleRun('ScriptRunCompleted', RUN_ID('42'));

const T0 = '2026-10-12T09:00:00Z';

function v13Run(id: string, overrides: Partial<ScriptRunRow>): ScriptRunRow {
  return checkRun({
    id,
    programmeId: PROGRAMME_ONE.id,
    contactId: CONTACT.id,
    scriptId: S_MAIN_ID,
    versionId: VERSION_13.id,
    versionNumber: 13,
    latestVersion: summaryOf(VERSION_13),
    status: 'in_progress',
    outcome: null,
    unacknowledgedComplianceNodeIds: [],
    endedAtNodeId: null,
    stopReason: null,
    currentNodeId: 'greet',
    path: [{ nodeId: 'greet', enteredAt: T0 }],
    acknowledgements: [],
    answers: {},
    startedBy: clone(AGENT),
    startedAt: T0,
    completedAt: null,
    dispositionId: null,
    activityId: null,
    followUpTaskId: null,
    revision: 1,
    ...overrides,
  });
}

const step = (nodeId: string, branchOutcome?: boolean): RunStep =>
  branchOutcome === undefined ? { nodeId, enteredAt: T0 } : { nodeId, enteredAt: T0, branchOutcome };
const ack = (nodeId: string, locale = 'en'): Acknowledgement => ({ nodeId, locale, profileLocale: null, acknowledgedAt: T0 });

/** From the start, on v13: at `greet`, nothing read yet (P10/04). Revision 1. */
export const RUN_FRESH = v13Run(RUN_ID('43'), { contactId: CONTACT_AT_GREET.id });

const TO_PAYQ: RunStep[] = [step('greet'), step('rec'), step('idq'), step('cust', false), step('intro'), step('payq')];
const IDQ_YES = { idq: { type: 'question', choiceKey: 'yes', answeredAt: T0 } };

/** At the `ptp` form, nothing filled in (P10/02). Revision 6. */
export const RUN_AT_FORM = v13Run(RUN_ID('44'), {
  contactId: CONTACT_AT_FORM.id,
  currentNodeId: 'ptp',
  path: [...TO_PAYQ, step('ptp')],
  acknowledgements: [ack('rec')],
  answers: { ...IDQ_YES, payq: { type: 'question', choiceKey: 'ptp', answeredAt: T0 } },
  revision: 6,
});

/** At `close`, the end, everything read and answered (P10/03). `close` suggests D_PTP. Revision 10. */
export const RUN_AT_END = v13Run(RUN_ID('45'), {
  contactId: CONTACT_AT_END.id,
  currentNodeId: 'close',
  path: [...TO_PAYQ, step('ptp'), step('readback'), step('close')],
  acknowledgements: [ack('rec'), ack('readback')],
  answers: {
    ...IDQ_YES,
    payq: { type: 'question', choiceKey: 'ptp', answeredAt: T0 },
    ptp: { type: 'form', values: { date: '2026-10-15', amount: { amountMinor: '2500000', currency: 'NGN' }, reason: 'salary_delayed' }, updatedAt: T0 },
  },
  revision: 10,
});

/** At `cbend`, an end that suggests D_CALLBACK (a follow-up is required). Revision 6. */
export const RUN_AT_CALLBACK = v13Run(RUN_ID('46'), {
  contactId: CONTACT_AT_CALLBACK.id,
  currentNodeId: 'cbend',
  path: [...TO_PAYQ, step('cbend')],
  acknowledgements: [ack('rec')],
  answers: { ...IDQ_YES, payq: { type: 'question', choiceKey: 'cb', answeredAt: T0 } },
  revision: 6,
});

/** At the `readback` compliance node, not yet acknowledged: the call drops here (interrupted). Revision 8. */
export const RUN_AT_READBACK = v13Run(RUN_ID('47'), {
  contactId: CONTACT_AT_READBACK.id,
  currentNodeId: 'readback',
  path: [...TO_PAYQ, step('ptp'), step('readback')],
  acknowledgements: [ack('rec')],
  answers: (clone(RUN_AT_END.answers) as Record<string, Json>),
  revision: 8,
});

/** At `rec`, the first compliance node, not yet acknowledged. Revision 2. */
export const RUN_AT_REC = v13Run(RUN_ID('48'), { contactId: CONTACT_AT_REC.id, currentNodeId: 'rec', path: [step('greet'), step('rec')], revision: 2 });

/** At `intro`, whose v13 wording carries `{contact.emails}`, withheld from the caller. Revision 5. */
export const RUN_AT_INTRO = v13Run(RUN_ID('50'), {
  contactId: CONTACT_AT_INTRO.id,
  currentNodeId: 'intro',
  path: [step('greet'), step('rec'), step('idq'), step('cust', false), step('intro')],
  acknowledgements: [ack('rec')],
  answers: { ...IDQ_YES },
  revision: 5,
});

/** At `idq`, the question before the `cust` branch. Revision 4. */
export const RUN_AT_IDQ = v13Run(RUN_ID('51'), {
  contactId: CONTACT_AT_IDQ.id,
  currentNodeId: 'idq',
  path: [step('greet'), step('rec'), step('idq')],
  acknowledgements: [ack('rec')],
  revision: 4,
});

/** Another agent's run: 404 to the caller, whoever asks. */
export const RUN_OTHER_AGENT = v13Run(RUN_ID('49'), { startedBy: clone(OTHER_AGENT) });

const SEEDED_RUNS: readonly ScriptRunRow[] = [
  RUN_RESUME,
  RUN_STOPPED,
  RUN_COMPLETED,
  RUN_FRESH,
  RUN_AT_FORM,
  RUN_AT_END,
  RUN_AT_CALLBACK,
  RUN_AT_READBACK,
  RUN_AT_REC,
  RUN_AT_INTRO,
  RUN_AT_IDQ,
  RUN_OTHER_AGENT,
];

/** The ids startScriptRun gives new runs, in order. */
export const NEW_RUN_IDS: readonly string[] = [RUN_ID('61'), RUN_ID('62'), RUN_ID('63')];

/** The second runnable script for CONTACT: opens on a branch on `status`. */
export const S_STATUS_CHECK_ID = SCRIPT_ID('08');
const STATUS_CHECK_VERSION = checkVersion({
  id: '2f8e6d14-7a3b-4c9e-8d21-5b0a9c3e7f81',
  scriptId: S_STATUS_CHECK_ID,
  number: 2,
  name: 'Status check',
  sourceLocale: 'en',
  graph: {
    startNodeId: 'known',
    nodes: [
      { id: 'known', type: 'branch', title: 'Status known?', condition: { source: 'contact_field', field: 'status', operator: 'is_set' }, whenTrue: 'thanks', whenFalse: 'ask' },
      { id: 'ask', type: 'say', title: 'Ask', text: 'Could you tell me a little about your situation?', next: 'thanks' },
      { id: 'thanks', type: 'end', title: 'Thanks', text: 'Thank you.', suggestedDispositionId: null },
    ],
  },
  translations: {},
  changes: [],
  publishedAt: '2026-10-01T09:00:00Z',
  publishedBy: clone(ADMIN),
});

/** What listContactScripts serves in each programme, by name then id. */
const RUNNABLE: Readonly<Record<string, readonly { scriptId: string; name: string; version: ScriptVersionRow; translatedLocales: string[] }[]>> = {
  [PROGRAMME_ONE.id]: [
    { scriptId: S_MAIN_ID, name: S_MAIN.name, version: VERSION_13, translatedLocales: ['pcm'] },
    { scriptId: S_STATUS_CHECK_ID, name: 'Status check', version: STATUS_CHECK_VERSION, translatedLocales: [] },
  ],
  [PROGRAMME_TWO.id]: [{ scriptId: S_STATUS_CHECK_ID, name: 'Status check', version: STATUS_CHECK_VERSION, translatedLocales: [] }],
};

/** One runnable script per page, whatever `limit` says: the menu must follow `nextCursor`. */
export const RUNNABLE_PAGE_CAP = 1;

/** Every script listContactScripts serves for a contact, in order. */
export function runnableFor(contact: ContactRow): readonly { scriptId: string; name: string; versionNumber: number }[] {
  return (RUNNABLE[contact.programmeId] ?? []).map((entry) => ({ scriptId: entry.scriptId, name: entry.name, versionNumber: entry.version.number }));
}

const AGENT_VERSIONS: readonly ScriptVersionRow[] = [VERSION_12, VERSION_13, STATUS_CHECK_VERSION];

// ---------------------------------------------------------------------------
// Everything served, for checks that tell served data from UI copy
// ---------------------------------------------------------------------------

export function servedData(): string {
  return JSON.stringify({
    scripts: ALL_SCRIPTS,
    versions: [...MAIN_VERSIONS, VERSION_13, STATUS_CHECK_VERSION],
    runs: SEEDED_RUNS,
    contacts: CONTACTS,
    dispositions: DISPOSITIONS,
    programmes: [PROGRAMME_ONE, PROGRAMME_TWO],
    people: [ADMIN_USER, AGENT_USER, OTHER_AGENT],
  });
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export type World = 'builder' | 'agent';
export type Role = 'admin' | 'agent' | 'no-script-run';

export interface ScriptingMockOptions {
  readonly world: World;
  /** builder: `admin` (default, script.write) or `agent` (none). agent: `agent` (default, script.run) or `no-script-run`. */
  readonly role?: Role;
  /**
   * Leave every request that is not a scripting operation to the next route
   * handler (`route.fallback()`): the start journey runs on the contact
   * record, whose own mock serves the record.
   */
  readonly fallbackOthers?: boolean;
  /**
   * What `getMyCapabilities` answers (T-0158). Default: the role's own (builder
   * `admin` holds script.write in the first programme; every other role holds
   * script.run alone). `unreadable` answers 500, so a screen draws its controls.
   */
  readonly capabilities?: { readonly tenant: { readonly admin: boolean; readonly can: readonly string[] }; readonly programmes: readonly { readonly id: string; readonly can: readonly string[] }[] } | 'unreadable';
  /** Hold every read until `release()`: the loading frame, without a clock. */
  readonly hold?: boolean;
  /** Abort every read, as a dropped connection does. */
  readonly networkFailure?: boolean;
  /** Hold every write until `releaseWrites()`: the in-flight state. */
  readonly holdWrites?: boolean;
  /** builder: somebody else saves S_MAIN just before the screen's first updateScript lands. */
  readonly staleDraft?: 'other-node' | 'same-field';
  /** builder: the next publishScript is refused with the contract's `script_invalid` example. */
  readonly publishInvalid?: boolean;
  /** agent: how the server decides branches (header). */
  readonly branch?: 'evaluate' | 'true' | 'false' | 'sensitive';
  /** agent: the caller's other tab writes the run just before the screen's first write of this kind lands. */
  readonly staleRun?: 'advance' | 'complete';
  /** agent: this disposition is deactivated just before the first completeScriptRun lands. */
  readonly retireOnComplete?: string;
  /** agent: the caller lacks `activity.write`, so completion is 403 (the one run 403). */
  readonly noActivityWrite?: boolean;
  /** agent: the first completeScriptRun is APPLIED, and then its answer is lost on the wire. */
  readonly loseCompletionAnswer?: boolean;
}

export interface RecordedWrite {
  readonly operation: Operation;
  readonly path: string;
  readonly body: unknown;
  status?: number;
}

export interface ScriptingMock {
  readonly requests: URL[];
  /** Every request by operation, in order. */
  readonly calls: Map<Operation, URL[]>;
  readonly writes: RecordedWrite[];
  readonly violations: string[];
  readonly mockFaults: string[];
  readonly scripts: Map<string, ScriptRow>;
  readonly versions: Map<string, ScriptVersionRow[]>;
  readonly runs: Map<string, ScriptRunRow>;
  calledTimes(operation: Operation): number;
  release(): void;
  releaseWrites(): void;
}

/** Which operation a request is, and its path parameters. */
export function operationOf(request: Request | { method(): string; url(): string }): { operation: Operation; params: Record<string, string> } | undefined {
  const method = request.method().toLowerCase();
  const pathname = new URL(request.url()).pathname;
  for (const [operation, [template, verb]] of Object.entries(OP) as [Operation, (typeof OP)[Operation]][]) {
    if (verb !== method) continue;
    const names: string[] = [];
    const pattern = new RegExp(
      `^${template.replace(/\{(\w+)\}/g, (_, name: string) => {
        names.push(name);
        return '([^/]+)';
      })}$`,
    );
    const match = pattern.exec(pathname);
    if (match === null) continue;
    const params: Record<string, string> = {};
    names.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1] ?? '');
    });
    return { operation, params };
  }
  return undefined;
}

export function isOperation(request: Request, operation: Operation, id?: string): boolean {
  const found = operationOf(request);
  return found !== undefined && found.operation === operation && (id === undefined || Object.values(found.params).includes(id));
}

function parameterNames(operation: Operation): readonly string[] {
  const [path, method, document] = OP[operation];
  const own = (at(document, 'paths', path, method) as Json).parameters;
  return ((Array.isArray(own) ? own : []) as unknown[]).map((raw) => String((deref(raw, document).node as Json).name));
}

/** Today's date in Africa/Lagos (UTC+1, no DST): form date bounds count days there (D-L107). */
function lagosToday(): string {
  return new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
}

export async function installScriptingMock(page: Page, options: ScriptingMockOptions): Promise<ScriptingMock> {
  const world = options.world;
  const role: Role = options.role ?? (world === 'builder' ? 'admin' : 'agent');
  const writer = world === 'builder' && role === 'admin';
  const runner = world === 'agent' && role === 'agent';
  const allowed = world === 'builder' ? BUILDER_OPS : AGENT_OPS;
  const me = world === 'builder' ? ADMIN_USER : AGENT_USER;
  const caller = world === 'builder' ? ADMIN : AGENT;

  const scripts = new Map<string, ScriptRow>(ALL_SCRIPTS.map((row) => [row.id, clone(row)]));
  const versions = new Map<string, ScriptVersionRow[]>(
    world === 'builder'
      ? Object.entries(BUILDER_VERSIONS).map(([id, rows]) => [id, clone([...rows])])
      : [[S_MAIN_ID, clone([VERSION_13, VERSION_12])], [S_STATUS_CHECK_ID, clone([STATUS_CHECK_VERSION])]],
  );
  const runs = new Map<string, ScriptRunRow>(world === 'agent' ? SEEDED_RUNS.map((row) => [row.id, clone(row)]) : []);
  const retired = new Set<string>();

  const requests: URL[] = [];
  const calls = new Map<Operation, URL[]>();
  const writes: RecordedWrite[] = [];
  const violations: string[] = [];
  const mockFaults: string[] = [];

  /** What the screen has been served, by kind. */
  const servedScriptRevision = new Map<string, number>();
  const servedScript = new Map<string, ScriptRow>();
  const servedVersionIds = new Set<string>();
  const servedProgrammes = new Set<string>();
  const servedRunRevision = new Map<string, number>();
  const servedDispositions = new Map<string, Set<string>>();
  const cursors = new Map<string, { list: string; offset: number }>();
  /** The request that completed each run, for the exact-repeat rule. */
  const completingBodies = new Map<string, Json>();

  let cursorCount = 0;
  let newScripts = 0;
  let newRuns = 0;
  let newActivities = 0;
  let staleDraftDone = false;
  let staleRunDone = false;
  let retireDone = false;
  let loseDone = false;

  let release: () => void = () => undefined;
  const gate = options.hold === true ? new Promise<void>((done) => (release = done)) : Promise.resolve();
  let releaseWrites: () => void = () => undefined;
  const writeGate = options.holdWrites === true ? new Promise<void>((done) => (releaseWrites = done)) : Promise.resolve();

  const now = (): string => new Date().toISOString();

  const answer = (route: Route, operation: Operation, status: number, body: unknown): Promise<void> => {
    for (const problem of answerProblems(operation, status, body)) mockFaults.push(problem);
    return route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) });
  };

  const readBody = (request: Request, label: string): unknown => {
    try {
      return request.postDataJSON() as unknown;
    } catch {
      violations.push(`${label} body is not JSON`);
      return undefined;
    }
  };

  /** Query parameters and cursors: the operation's own, `limit` 1..100, cursors echoed for their list. */
  const page_ = (url: URL, operation: Operation, list: string): { offset: number; limit: number } | string[] => {
    const problems: string[] = [];
    const names = parameterNames(operation);
    for (const name of new Set(url.searchParams.keys())) {
      if (!names.includes(name)) problems.push(`${operation} declares no "${name}" parameter`);
      if (url.searchParams.getAll(name).length > 1) problems.push(`${name} was sent more than once`);
    }
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 25 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) problems.push(`limit=${String(rawLimit)} is outside 1..100`);
    let offset = 0;
    const cursor = url.searchParams.get('cursor');
    if (cursor !== null) {
      const bound = cursors.get(cursor);
      if (bound === undefined || bound.list !== list) {
        problems.push(`cursor "${cursor}" was not served for this list — it must be echoed, not built`);
      } else {
        offset = bound.offset;
      }
    }
    return problems.length > 0 ? problems : { offset, limit };
  };

  const pageOf = <T>(rows: readonly T[], list: string, offset: number, limit: number, cap: number): { data: T[]; nextCursor: string | null } => {
    const size = Math.min(limit, cap);
    const data = rows.slice(offset, offset + size);
    let nextCursor: string | null = null;
    if (offset + size < rows.length) {
      cursorCount += 1;
      nextCursor = `eyJpZCI6Im${String(cursorCount).padStart(4, '0')}In0`;
      cursors.set(nextCursor, { list, offset: offset + size });
    }
    return { data: clone(data), nextCursor };
  };

  const record = (operation: Operation, path: string, body: unknown): RecordedWrite => {
    const write: RecordedWrite = { operation, path, body };
    writes.push(write);
    return write;
  };

  // ===== builder =============================================================

  const authorable = (id: string): ScriptRow | undefined => (writer ? scripts.get(id) : undefined);

  const toScript = (row: ScriptRow): ScriptRow => {
    servedScriptRevision.set(row.id, row.revision);
    servedScript.set(row.id, clone(row));
    if (row.latestVersion !== null) servedVersionIds.add(row.latestVersion.id);
    return clone(row);
  };

  const summary = (row: ScriptRow): Json => ({
    id: row.id,
    programmeId: row.programmeId,
    name: row.name,
    sourceLocale: row.sourceLocale,
    translatedLocales: [...row.translatedLocales],
    hasUnpublishedChanges: row.hasUnpublishedChanges,
    latestVersion: clone(row.latestVersion),
    updatedAt: row.updatedAt,
  });

  const touch = (row: ScriptRow): void => {
    row.revision += 1;
    row.updatedAt = now();
    row.hasUnpublishedChanges = true;
    row.translatedLocales = Object.keys(row.draft.translations).filter((locale) => Object.keys(row.draft.translations[locale] ?? {}).length > 0);
    checkScript(row);
  };

  const otherSave = (row: ScriptRow): void => {
    if (options.staleDraft === 'other-node') {
      const greet = row.draft.graph.nodes.find((candidate) => candidate.id === 'greet');
      if (greet !== undefined) greet.text = OTHER_GREET_TEXT;
      row.name = OTHER_NAME;
    } else if (options.staleDraft === 'same-field') {
      const payq = row.draft.graph.nodes.find((candidate) => candidate.id === 'payq');
      if (payq !== undefined) payq.title = OTHER_PAYQ_TITLE;
    }
    touch(row);
  };

  const graphProblems = (graph: unknown): string[] => {
    if (!isJson(graph) || !Array.isArray(graph.nodes)) return [];
    const ids = (graph.nodes as Json[]).map((entry) => String(entry.id));
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    return duplicates.length > 0 ? [`graph repeats node ids ${duplicates.join(', ')} (the API refuses it)`] : [];
  };

  const builder = async (route: Route, request: Request, operation: Operation, params: Record<string, string>, url: URL): Promise<void> => {
    const scriptId = params.scriptId ?? '';
    if (operation === 'listScripts') {
      await gate;
      if (options.networkFailure === true) return route.abort('internetdisconnected');
      const paging = page_(url, operation, 'scripts');
      if (Array.isArray(paging)) {
        violations.push(...paging);
        return answer(route, operation, 400, validation([{ path: 'cursor', code: 'invalid_cursor' }]));
      }
      const rows = writer ? [...scripts.values()].sort((a, b) => (a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.id < b.id ? -1 : 1)) : [];
      const result = pageOf(rows.map(summary), 'scripts', paging.offset, paging.limit, SCRIPT_PAGE_CAP);
      for (const row of result.data) {
        const latest = (row as Json).latestVersion as VersionSummary | null;
        if (latest !== null) servedVersionIds.add(latest.id);
      }
      return answer(route, operation, 200, result);
    }
    if (operation === 'createScript') {
      const body = readBody(request, operation);
      const write = record(operation, SCRIPTS_PATH, body);
      await writeGate;
      const reply = (status: number, payload: unknown): Promise<void> => {
        write.status = status;
        return answer(route, operation, status, payload);
      };
      const problems = validateBody(body, schema('CreateScriptRequest'), '');
      violations.push(...problems.map((problem) => `createScript: ${problem}`));
      if (!isJson(body)) return reply(400, validation([{ path: 'body', code: 'invalid_type' }]));
      const programme = String(body.programmeId);
      if (![PROGRAMME_ONE.id, PROGRAMME_TWO.id].includes(programme)) return reply(404, errorBody('NotFound'));
      if (!servedProgrammes.has(programme)) violations.push(`createScript targeted ${programme}, a programme listMyProgrammes never served`);
      if (!writer) return reply(403, errorBody('NotPermitted'));
      if (problems.length > 0) return reply(400, validation([{ path: 'body', code: 'invalid_string' }]));
      const id = newScripts === 0 ? NEW_SCRIPT_ID : SCRIPT_ID(String(21 + newScripts));
      newScripts += 1;
      const row = draftScript({
        id,
        programmeId: programme,
        name: String(body.name),
        sourceLocale: String(body.sourceLocale),
        draft: { graph: isJson(body.graph) ? (clone(body.graph) as unknown as Graph) : clone(DEFAULT_GRAPH), translations: {} },
        createdAt: now(),
        updatedAt: now(),
      });
      scripts.set(id, row);
      return reply(201, toScript(row));
    }
    if (!UUID_PATTERN.test(scriptId)) {
      if (operation === 'getScript' || operation === 'listScriptVersions' || operation === 'getScriptVersion') await gate;
      return answer(route, operation, 400, validation([{ path: 'scriptId', code: 'invalid_string' }]));
    }
    if (operation === 'getScript') {
      await gate;
      if (options.networkFailure === true) return route.abort('internetdisconnected');
      const row = authorable(scriptId);
      return row === undefined ? answer(route, operation, 404, errorBody('NotFound')) : answer(route, operation, 200, toScript(row));
    }
    if (operation === 'listScriptVersions') {
      await gate;
      if (options.networkFailure === true) return route.abort('internetdisconnected');
      const row = authorable(scriptId);
      if (row === undefined) return answer(route, operation, 404, errorBody('NotFound'));
      const paging = page_(url, operation, `versions:${scriptId}`);
      if (Array.isArray(paging)) {
        violations.push(...paging);
        return answer(route, operation, 400, validation([{ path: 'cursor', code: 'invalid_cursor' }]));
      }
      const rows = (versions.get(scriptId) ?? []).map(summaryOf);
      const result = pageOf(rows, `versions:${scriptId}`, paging.offset, paging.limit, VERSION_PAGE_CAP);
      for (const entry of result.data) servedVersionIds.add(entry.id);
      return answer(route, operation, 200, result);
    }
    if (operation === 'getScriptVersion') {
      await gate;
      const row = authorable(scriptId);
      const versionId = params.versionId ?? '';
      const version = (versions.get(scriptId) ?? []).find((candidate) => candidate.id === versionId);
      if (row === undefined || version === undefined) return answer(route, operation, 404, errorBody('NotFound'));
      if (!servedVersionIds.has(versionId)) violations.push(`getScriptVersion named ${versionId}, a version the screen was never served`);
      return answer(route, operation, 200, clone(version));
    }

    // ----- the three draft writes ------------------------------------------
    const body = readBody(request, operation);
    const write = record(operation, new URL(request.url()).pathname, body);
    await writeGate;
    const reply = (status: number, payload: unknown): Promise<void> => {
      write.status = status;
      return answer(route, operation, status, payload);
    };
    const row = authorable(scriptId);
    if (row === undefined) return reply(404, errorBody('NotFound'));
    if (!servedScriptRevision.has(scriptId)) violations.push(`${operation} named ${scriptId}, which the screen was never served`);
    if (!isJson(body)) {
      violations.push(`${operation} body is not an object`);
      return reply(400, validation([{ path: 'body', code: 'invalid_type' }]));
    }
    if (body.revision !== servedScriptRevision.get(scriptId)) {
      violations.push(`${operation} sent revision ${String(body.revision)}; the screen was last served ${String(servedScriptRevision.get(scriptId))}`);
    }

    if (operation === 'updateScript') {
      if (options.staleDraft !== undefined && !staleDraftDone && scriptId === S_MAIN.id) {
        staleDraftDone = true;
        otherSave(row);
      }
      const problems = [...validateBody(body, schema('UpdateScriptRequest'), ''), ...graphProblems(body.graph)];
      violations.push(...problems.map((problem) => `updateScript: ${problem}`));
      // D-L102: changed fields only, judged against what the screen was last served.
      const served = servedScript.get(scriptId);
      const sent = Object.keys(body).filter((key) => key !== 'revision');
      if (sent.length === 0) violations.push('updateScript sent nothing that changed');
      for (const key of sent) {
        const before = key === 'graph' ? served?.draft.graph : (served as Json | undefined)?.[key];
        if (served !== undefined && sameJson(before, body[key])) {
          violations.push(`updateScript sent ${key} unchanged from what the screen was last served (changed fields only, D-L102)`);
        }
      }
      if (problems.length > 0) return reply(400, validation([{ path: 'graph', code: 'invalid_type' }]));
      if (body.revision !== row.revision) return reply(409, errorBody('StaleWrite'));
      if (typeof body.name === 'string') row.name = body.name;
      if (typeof body.sourceLocale === 'string') row.sourceLocale = body.sourceLocale;
      if (isJson(body.graph)) row.draft.graph = clone(body.graph) as unknown as Graph;
      touch(row);
      return reply(200, toScript(row));
    }

    if (operation === 'putScriptTranslation') {
      const locale = params.locale ?? '';
      const problems = validateBody(body, schema('PutScriptTranslationRequest'), '');
      if (!SCRIPT_LOCALES.includes(locale)) problems.push(`locale ${locale} is not a ScriptLocale`);
      if (locale === row.sourceLocale) problems.push(`translated the source locale (${locale})`);
      const nodeIds = row.draft.graph.nodes.map((entry) => entry.id);
      for (const key of Object.keys(isJson(body.texts) ? body.texts : {})) {
        if (!nodeIds.includes(key)) problems.push(`texts.${key} names no node of the draft`);
      }
      violations.push(...problems.map((problem) => `putScriptTranslation: ${problem}`));
      if (problems.length > 0) return reply(400, validation([{ path: 'texts', code: 'invalid_type' }]));
      if (body.revision !== row.revision) return reply(409, errorBody('StaleWrite'));
      const texts = clone(body.texts) as Record<string, Json>;
      if (Object.keys(texts).length === 0) {
        delete row.draft.translations[locale];
      } else {
        row.draft.translations[locale] = texts;
      }
      touch(row);
      return reply(200, toScript(row));
    }

    // publishScript
    const problems = validateBody(body, schema('PublishScriptRequest'), '');
    violations.push(...problems.map((problem) => `publishScript: ${problem}`));
    if (problems.length > 0) return reply(400, validation([{ path: 'changes', code: 'invalid_type' }]));
    if (body.revision !== row.revision) return reply(409, conflict('PublishConflict', 'staleWrite'));
    if (options.publishInvalid === true) return reply(409, conflict('PublishConflict', 'scriptInvalid'));
    const list = versions.get(scriptId) ?? [];
    const previous = list[0];
    if (
      previous !== undefined &&
      previous.name === row.name &&
      previous.sourceLocale === row.sourceLocale &&
      sameJson(previous.graph, row.draft.graph) &&
      sameJson(previous.translations, row.draft.translations)
    ) {
      return reply(409, { ...conflict('PublishConflict', 'scriptInvalid'), details: [{ path: 'draft', code: 'unchanged' }] });
    }
    if (row.draft.graph.nodes.every((entry) => entry.type === 'end')) {
      return reply(409, { ...conflict('PublishConflict', 'scriptInvalid'), details: [{ path: 'graph', code: 'empty_script' }] });
    }
    const number = (previous?.number ?? 0) + 1;
    const version = checkVersion({
      id: `2f8e6d14-7a3b-4c9e-8d21-${String(900_000_000_000 + number + versions.size * 100)}`,
      scriptId,
      number,
      name: row.name,
      sourceLocale: row.sourceLocale,
      graph: clone(row.draft.graph),
      translations: clone(row.draft.translations),
      changes: Array.isArray(body.changes) ? body.changes.map(String) : [],
      publishedAt: now(),
      publishedBy: clone(ADMIN),
    });
    versions.set(scriptId, [version, ...list]);
    row.latestVersion = summaryOf(version);
    row.hasUnpublishedChanges = false;
    // Publishing leaves `revision` alone (T-0113): it snapshots, it does not edit the draft.
    servedVersionIds.add(version.id);
    return reply(201, clone(version));
  };

  // ===== agent ===============================================================

  const contactOf = (id: string): ContactRow | undefined =>
    CONTACTS.find((row) => row.id === id && (row.programmeId === PROGRAMME_ONE.id || row.programmeId === PROGRAMME_TWO.id));

  const versionOf = (run: ScriptRunRow): ScriptVersionRow | undefined => AGENT_VERSIONS.find((row) => row.id === run.versionId);

  const graphNode = (run: ScriptRunRow, id: string | null): GraphNode | undefined =>
    id === null ? undefined : versionOf(run)?.graph.nodes.find((entry) => entry.id === id);

  /** Own runs only: another agent's run, or the own agent without script.run, is 404 (D-L93). */
  const ownRun = (id: string): ScriptRunRow | undefined => {
    const row = runs.get(id);
    return row !== undefined && runner && row.startedBy.id === caller.id ? row : undefined;
  };

  const latestOf = (scriptId: string): ScriptVersionRow | undefined => (versions.get(scriptId) ?? [])[0];

  const toRun = (row: ScriptRunRow): ScriptRunRow => {
    const latest = latestOf(row.scriptId);
    if (latest !== undefined) row.latestVersion = summaryOf(latest);
    servedRunRevision.set(row.id, row.revision);
    return clone(row);
  };

  /** Enter a node; a branch is evaluated here, on the server, and never becomes current unless it stops the run. */
  const enter = (run: ScriptRunRow, id: string, hops = 0): void => {
    const target = graphNode(run, id);
    if (target === undefined || hops > 200) return;
    if (target.type !== 'branch') {
      run.path.push({ nodeId: id, enteredAt: now() });
      run.currentNodeId = id;
      return;
    }
    const condition = target.condition as Json;
    const decide = (): boolean | 'field_withheld' | 'sensitive_field' => {
      const mode = options.branch ?? 'evaluate';
      if (mode === 'true') return true;
      if (mode === 'false') return false;
      if (mode === 'sensitive') return 'sensitive_field';
      if (condition.source !== 'contact_field') {
        const answer_ = run.answers[String(condition.nodeId)];
        return isJson(answer_) && answer_.choiceKey === condition.value;
      }
      const contact = contactOf(run.contactId);
      const field = String(condition.field);
      if (contact === undefined || contact.withheldFields.includes(field)) return 'field_withheld';
      const value = contact[field];
      const set = value !== null && value !== undefined;
      switch (condition.operator) {
        case 'is_set':
          return set;
        case 'is_not_set':
          return !set;
        case 'equals':
          return set && value === condition.value;
        case 'not_equals':
          return set && value !== condition.value;
        case 'one_of':
          return set && Array.isArray(condition.value) && condition.value.includes(value);
        default:
          return false;
      }
    };
    const outcome = decide();
    if (outcome === 'field_withheld' || outcome === 'sensitive_field') {
      run.path.push({ nodeId: id, enteredAt: now(), branchOutcome: null });
      run.currentNodeId = id;
      run.status = 'stopped';
      run.stopReason = outcome;
      return;
    }
    run.path.push({ nodeId: id, enteredAt: now(), branchOutcome: outcome });
    enter(run, String(outcome ? target.whenTrue : target.whenFalse), hops + 1);
  };

  const otherTab = (run: ScriptRunRow): void => {
    // The same agent, in another tab, saves the run: only its revision moves.
    run.revision += 1;
  };

  const runOps = async (route: Route, request: Request, operation: Operation, params: Record<string, string>, url: URL): Promise<void> => {
    if (operation === 'getContact') {
      await gate;
      if (options.networkFailure === true) return route.abort('internetdisconnected');
      const id = params.contactId ?? '';
      if (!UUID_PATTERN.test(id)) return answer(route, operation, 400, validation([{ path: 'contactId', code: 'invalid_string' }]));
      const row = contactOf(id);
      if (row === undefined) {
        return answer(route, operation, 404, clone(at(deref(at(RECORDS, 'components', 'responses', 'NotFound'), RECORDS).node, 'content', 'application/json', 'example')));
      }
      return answer(route, operation, 200, clone(row));
    }
    if (operation === 'listContactScripts') {
      await gate;
      if (options.networkFailure === true) return route.abort('internetdisconnected');
      const id = params.contactId ?? '';
      if (!UUID_PATTERN.test(id)) return answer(route, operation, 400, validation([{ path: 'contactId', code: 'invalid_string' }]));
      const contact = contactOf(id);
      if (contact === undefined) return answer(route, operation, 404, errorBody('NotFound'));
      const paging = page_(url, operation, `runnable:${id}`);
      if (Array.isArray(paging)) {
        violations.push(...paging);
        return answer(route, operation, 400, validation([{ path: 'cursor', code: 'invalid_cursor' }]));
      }
      const rows = runner
        ? (RUNNABLE[contact.programmeId] ?? []).map((entry) => ({
            id: entry.scriptId,
            name: entry.name,
            sourceLocale: entry.version.sourceLocale,
            translatedLocales: [...entry.translatedLocales],
            latestVersion: summaryOf(entry.version),
          }))
        : [];
      return answer(route, operation, 200, pageOf(rows, `runnable:${id}`, paging.offset, paging.limit, RUNNABLE_PAGE_CAP));
    }
    if (operation === 'startScriptRun') {
      const body = readBody(request, operation);
      const write = record(operation, RUNS_PATH, body);
      await writeGate;
      const reply = (status: number, payload: unknown): Promise<void> => {
        write.status = status;
        return answer(route, operation, status, payload);
      };
      const problems = validateBody(body, schema('StartScriptRunRequest'), '');
      violations.push(...problems.map((problem) => `startScriptRun: ${problem}`));
      if (!isJson(body) || problems.length > 0) return reply(400, validation([{ path: 'body', code: 'invalid_type' }]));
      const contact = contactOf(String(body.contactId));
      if (contact === undefined) return reply(404, errorBody('NotFound'));
      if (!runner) return reply(403, errorBody('NotPermitted'));
      const entry = (RUNNABLE[contact.programmeId] ?? []).find((candidate) => candidate.scriptId === body.scriptId);
      if (entry === undefined) return reply(404, errorBody('NotFound'));
      const latest = latestOf(entry.scriptId);
      if (latest === undefined) return reply(409, conflict('StartConflict', 'scriptNotPublished'));
      const existing = [...runs.values()].find(
        (row) =>
          row.startedBy.id === caller.id &&
          row.contactId === contact.id &&
          row.scriptId === entry.scriptId &&
          (row.status === 'in_progress' || (row.status === 'stopped' && row.versionId === latest.id)),
      );
      if (existing !== undefined) return reply(200, toRun(existing));
      const id = NEW_RUN_IDS[newRuns];
      if (id === undefined) throw new Error('the mock ran out of NEW_RUN_IDS');
      newRuns += 1;
      const run: ScriptRunRow = {
        ...clone(RUN_FRESH),
        id,
        programmeId: contact.programmeId,
        contactId: contact.id,
        scriptId: entry.scriptId,
        versionId: latest.id,
        versionNumber: latest.number,
        latestVersion: summaryOf(latest),
        currentNodeId: null,
        path: [],
        startedAt: now(),
        revision: 1,
      };
      enter(run, latest.graph.startNodeId);
      runs.set(id, checkRun(run));
      return reply(201, toRun(run));
    }

    const runId = params.runId ?? '';
    const reads: Operation[] = ['getScriptRun', 'getScriptRunScript', 'listScriptRunDispositions'];
    if (reads.includes(operation)) {
      await gate;
      if (options.networkFailure === true) return route.abort('internetdisconnected');
      if (!UUID_PATTERN.test(runId)) return answer(route, operation, 400, validation([{ path: 'runId', code: 'invalid_string' }]));
      const run = ownRun(runId);
      if (run === undefined) return answer(route, operation, 404, errorBody('NotFound'));
      if (operation === 'getScriptRun') return answer(route, operation, 200, toRun(run));
      if (operation === 'getScriptRunScript') {
        const version = versionOf(run);
        return version === undefined ? answer(route, operation, 404, errorBody('NotFound')) : answer(route, operation, 200, clone(version));
      }
      const paging = page_(url, operation, `dispositions:${runId}`);
      if (Array.isArray(paging)) {
        violations.push(...paging);
        return answer(route, operation, 400, validation([{ path: 'cursor', code: 'invalid_cursor' }]));
      }
      const live = DISPOSITIONS.filter((row) => !retired.has(row.id) && run.programmeId === PROGRAMME_ONE.id);
      const result = pageOf(live, `dispositions:${runId}`, paging.offset, paging.limit, DISPOSITION_PAGE_CAP);
      const seen = servedDispositions.get(runId) ?? new Set<string>();
      for (const row of result.data) seen.add(row.id);
      servedDispositions.set(runId, seen);
      return answer(route, operation, 200, result);
    }

    // ----- run writes ---------------------------------------------------------
    const body = readBody(request, operation);
    const write = record(operation, new URL(request.url()).pathname, body);
    await writeGate;
    const reply = (status: number, payload: unknown): Promise<void> => {
      write.status = status;
      return answer(route, operation, status, payload);
    };
    // A write to a run the screen was never served is the screen's fault, in scope or not.
    if (!servedRunRevision.has(runId)) violations.push(`${operation} named ${runId}, a run the screen was never served`);
    if (!UUID_PATTERN.test(runId)) return reply(400, validation([{ path: 'runId', code: 'invalid_string' }]));
    const run = ownRun(runId);
    if (run === undefined) return reply(404, errorBody('NotFound'));
    if (!isJson(body)) {
      violations.push(`${operation} body is not an object`);
      return reply(400, validation([{ path: 'body', code: 'invalid_type' }]));
    }
    const servedRevision = servedRunRevision.get(runId);
    const exactRepeat =
      operation === 'completeScriptRun' &&
      run.status === 'completed' &&
      completingBodies.has(runId) &&
      sameJson(
        { ...completingBodies.get(runId), revision: undefined },
        { ...body, revision: undefined },
      );
    if (body.revision !== servedRevision && !exactRepeat) {
      violations.push(`${operation} sent revision ${String(body.revision)}; the screen was last served ${String(servedRevision)}`);
    }
    const kind = operation === 'completeScriptRun' ? 'complete' : 'advance';
    if (options.staleRun === kind && !staleRunDone && run.status !== 'completed') {
      staleRunDone = true;
      otherTab(run);
    }
    const version = versionOf(run);
    const current = graphNode(run, run.currentNodeId);
    const onPath = (id: string): boolean => run.path.some((entry) => entry.nodeId === id);
    const acked = (id: string): boolean => run.acknowledgements.some((entry) => entry.nodeId === id);
    const stale = (): boolean => body.revision !== run.revision;
    const commit = (status: number): Promise<void> => {
      run.revision += 1;
      checkRun(run);
      return reply(status, toRun(run));
    };

    if (operation === 'advanceScriptRun') {
      const problems = validateBody(body, schema('AdvanceScriptRunRequest'), '');
      if (current?.type === 'question') {
        const keys = ((current.choices ?? []) as Json[]).map((choice) => String(choice.key));
        if (typeof body.choiceKey !== 'string') problems.push('a question was advanced with no choiceKey');
        else if (!keys.includes(body.choiceKey)) problems.push(`choiceKey ${body.choiceKey} is not one of ${current.id}'s choices`);
      } else if (body.choiceKey !== undefined) {
        problems.push(`choiceKey sent on a ${String(current?.type)} node`);
      }
      violations.push(...problems.map((problem) => `advanceScriptRun: ${problem}`));
      if (problems.length > 0) return reply(400, validation([{ path: 'choiceKey', code: 'invalid_option' }]));
      if (run.status === 'completed') return reply(409, conflict('AdvanceConflict', 'runCompleted'));
      if (run.status === 'stopped') return reply(409, conflict('AdvanceConflict', 'runStopped'));
      if (stale()) return reply(409, conflict('AdvanceConflict', 'staleWrite'));
      if (current === undefined || current.type === 'end') return reply(409, conflict('AdvanceConflict', 'runAtEnd'));
      if (current.type === 'compliance' && !acked(current.id)) {
        return reply(409, conflict('AdvanceConflict', 'complianceUnacknowledged', [{ path: `nodes.${current.id}`, code: 'not_acknowledged' }]));
      }
      if (current.type === 'form') {
        const values = (isJson(run.answers[current.id]) ? (run.answers[current.id] as Json).values : {}) as Json;
        const missing = ((current.fields ?? []) as Json[])
          .filter((field) => field.required === true && (values[String(field.key)] === undefined || values[String(field.key)] === null))
          .map((field) => ({ path: `values.${String(field.key)}`, code: 'required' }));
        if (missing.length > 0) return reply(409, conflict('AdvanceConflict', 'answersIncomplete', missing));
      }
      let next: string;
      if (current.type === 'question') {
        const choice = ((current.choices ?? []) as Json[]).find((entry) => entry.key === body.choiceKey);
        run.answers[current.id] = { type: 'question', choiceKey: String(body.choiceKey), answeredAt: now() };
        next = String(choice?.next);
      } else {
        next = String(current.next);
      }
      enter(run, next);
      return commit(200);
    }

    if (operation === 'acknowledgeScriptRunNode') {
      const problems = validateBody(body, schema('AcknowledgeScriptRunNodeRequest'), '');
      const shown = [version?.sourceLocale ?? 'en', ...Object.keys(version?.translations ?? {})];
      if (typeof body.locale === 'string' && !shown.includes(body.locale)) {
        problems.push(`locale ${body.locale} is not one the pinned version can show (${shown.join(', ')})`);
      }
      violations.push(...problems.map((problem) => `acknowledgeScriptRunNode: ${problem}`));
      if (problems.length > 0) return reply(400, validation([{ path: 'locale', code: 'invalid_type' }]));
      const target = graphNode(run, String(body.nodeId));
      if (target?.type !== 'compliance' || !onPath(target.id)) {
        violations.push(`acknowledgeScriptRunNode named ${String(body.nodeId)}, not a compliance node on the run's path`);
        return reply(400, conflict('ValidationFailed', 'notOnPath'));
      }
      if (run.status === 'completed') return reply(409, conflict('RunWriteConflict', 'runCompleted'));
      if (run.status === 'stopped') return reply(409, conflict('RunWriteConflict', 'runStopped'));
      if (stale()) return reply(409, conflict('RunWriteConflict', 'staleWrite'));
      if (acked(target.id)) return reply(200, toRun(run)); // Acknowledging again changes nothing (D-L104).
      const translated = isJson(version?.translations[String(body.locale)]?.[target.id]) && typeof (version?.translations[String(body.locale)]?.[target.id] as Json).text === 'string';
      run.acknowledgements.push({
        nodeId: target.id,
        locale: translated ? String(body.locale) : (version?.sourceLocale ?? 'en'),
        profileLocale: null,
        acknowledgedAt: now(),
      });
      return commit(200);
    }

    if (operation === 'recordScriptRunAnswers') {
      const problems = validateBody(body, schema('RecordScriptRunAnswersRequest'), '');
      violations.push(...problems.map((problem) => `recordScriptRunAnswers: ${problem}`));
      if (problems.length > 0) return reply(400, validation([{ path: 'values', code: 'invalid_type' }]));
      const target = graphNode(run, String(body.nodeId));
      if (target?.type !== 'form' || !onPath(target.id)) {
        violations.push(`recordScriptRunAnswers named ${String(body.nodeId)}, not a form node on the run's path`);
        return reply(400, conflict('ValidationFailed', 'notOnPath'));
      }
      const fields = (target.fields ?? []) as Json[];
      const details: { path: string; code: string }[] = [];
      for (const [key, value] of Object.entries(body.values as Json)) {
        const field = fields.find((entry) => entry.key === key);
        const where = `values.${key}`;
        if (field === undefined) {
          violations.push(`recordScriptRunAnswers sent ${key}, which is no field of ${target.id}`);
          details.push({ path: where, code: 'unknown_field' });
          continue;
        }
        if (value === null) continue;
        switch (field.type) {
          case 'text':
            if (typeof value !== 'string') details.push({ path: where, code: 'invalid_type' });
            else if (typeof field.maxLength === 'number' && value.length > field.maxLength) details.push({ path: where, code: 'too_big' });
            break;
          case 'number':
            if (typeof value !== 'number' || !Number.isInteger(value)) details.push({ path: where, code: 'invalid_type' });
            break;
          case 'money': {
            const money = value as Json;
            if (!isJson(value) || money.currency !== field.currency || typeof money.amountMinor !== 'string') {
              details.push({ path: where, code: 'invalid_type' });
            } else if (BigInt(String(money.amountMinor)) < BigInt(String(field.minimumMinor))) {
              details.push({ path: where, code: 'too_small' });
            } else if (BigInt(String(money.amountMinor)) > BigInt(String(field.maximumMinor))) {
              details.push({ path: where, code: 'too_big' });
            }
            break;
          }
          case 'date': {
            if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
              details.push({ path: where, code: 'invalid_date' });
              break;
            }
            const days = Math.round((Date.parse(`${value}T00:00:00Z`) - Date.parse(`${lagosToday()}T00:00:00Z`)) / 86_400_000);
            if (typeof field.minDaysAhead === 'number' && days < field.minDaysAhead) details.push({ path: where, code: 'too_small' });
            if (typeof field.maxDaysAhead === 'number' && days > field.maxDaysAhead) details.push({ path: where, code: 'too_big' });
            break;
          }
          case 'choice':
            if (!((field.options ?? []) as Json[]).some((option) => option.key === value)) details.push({ path: where, code: 'invalid_option' });
            break;
          default:
            details.push({ path: where, code: 'invalid_type' });
        }
      }
      if (details.length > 0) return reply(400, validation(details));
      if (run.status === 'completed') return reply(409, conflict('RunWriteConflict', 'runCompleted'));
      if (run.status === 'stopped') return reply(409, conflict('RunWriteConflict', 'runStopped'));
      if (stale()) return reply(409, conflict('RunWriteConflict', 'staleWrite'));
      const existing = isJson(run.answers[target.id]) ? ((run.answers[target.id] as Json).values as Json) : {};
      const merged: Json = { ...existing };
      for (const [key, value] of Object.entries(body.values as Json)) {
        if (value === null) delete merged[key];
        else merged[key] = clone(value);
      }
      run.answers[target.id] = { type: 'form', values: merged, updatedAt: now() };
      return commit(200);
    }

    // completeScriptRun
    const problems = validateBody(body, schema('CompleteScriptRunRequest'), '');
    if (isJson(body.followUp) && typeof body.followUp.dueAt === 'string') {
      const due = Date.parse(body.followUp.dueAt);
      if (!(due > Date.now()) || due > Date.now() + 366 * 86_400_000) problems.push('followUp.dueAt is not in the future, within 366 days');
    }
    if (typeof body.dispositionId === 'string' && !(servedDispositions.get(runId)?.has(body.dispositionId) ?? false) && !exactRepeat) {
      violations.push(`completeScriptRun sent disposition ${body.dispositionId}, which the screen was never served for this run`);
    }
    if (body.outcome === 'completed' && run.status === 'in_progress' && current?.type !== 'end') {
      violations.push(`completeScriptRun offered outcome "completed" at ${String(run.currentNodeId)}, which is not an end node (D-L93: interrupted)`);
    }
    violations.push(...problems.map((problem) => `completeScriptRun: ${problem}`));
    // The contract's order: 404, then 403 (no activity.write: the one run 403), then 400, then 409.
    if (options.noActivityWrite === true) return reply(403, errorBody('NotPermitted'));
    if (problems.length > 0) return reply(400, validation([{ path: 'followUp.dueAt', code: 'invalid_date' }]));
    if (run.status === 'completed') {
      return exactRepeat ? reply(200, toRun(run)) : reply(409, conflict('CompleteConflict', 'runCompleted'));
    }
    if (stale()) return reply(409, conflict('CompleteConflict', 'staleWrite'));
    if (options.retireOnComplete !== undefined && !retireDone) {
      retireDone = true;
      retired.add(options.retireOnComplete);
    }
    const compliance = run.path.map((entry) => graphNode(run, entry.nodeId)).filter((entry): entry is GraphNode => entry?.type === 'compliance');
    if (body.outcome === 'completed') {
      if (run.status !== 'stopped' && current?.type !== 'end') {
        return reply(409, conflict('CompleteConflict', 'completedAwayFromEnd'));
      }
      const unread = compliance.filter((entry) => !acked(entry.id));
      if (unread.length > 0) {
        return reply(409, conflict('CompleteConflict', 'complianceUnacknowledged', unread.map((entry) => ({ path: `nodes.${entry.id}`, code: 'not_acknowledged' }))));
      }
    } else {
      const passed = compliance.filter((entry) => entry.id !== run.currentNodeId && !acked(entry.id));
      if (passed.length > 0) {
        return reply(409, conflict('CompleteConflict', 'complianceUnacknowledged', passed.map((entry) => ({ path: `nodes.${entry.id}`, code: 'not_acknowledged' }))));
      }
    }
    const disposition = DISPOSITIONS.find((row) => row.id === body.dispositionId && !retired.has(row.id));
    if (disposition === undefined || run.programmeId !== PROGRAMME_ONE.id) return reply(409, conflict('CompleteConflict', 'dispositionNotLive'));
    const unmet = [
      ...(disposition.noteRequired && typeof body.note !== 'string' ? [{ path: 'note', code: 'required' }] : []),
      ...(disposition.followUpRequired && !isJson(body.followUp) ? [{ path: 'followUp', code: 'required' }] : []),
    ];
    if (unmet.length > 0) return reply(409, conflict('CompleteConflict', 'dispositionRequirementsUnmet', unmet));

    newActivities += 1;
    run.unacknowledgedComplianceNodeIds = body.outcome === 'interrupted' ? compliance.filter((entry) => !acked(entry.id)).map((entry) => entry.id) : [];
    run.endedAtNodeId = run.currentNodeId;
    run.currentNodeId = null;
    run.status = 'completed';
    run.outcome = String(body.outcome);
    run.dispositionId = disposition.id;
    run.completedAt = now();
    run.activityId = `8a9b0c1d-2e3f-4a5b-9c6d-7e8f9a0b1c${String(60 + newActivities * 2)}`;
    run.followUpTaskId = isJson(body.followUp) ? `8a9b0c1d-2e3f-4a5b-9c6d-7e8f9a0b1c${String(61 + newActivities * 2)}` : null;
    completingBodies.set(runId, clone(body));
    run.revision += 1;
    checkRun(run);
    if (options.loseCompletionAnswer === true && !loseDone) {
      loseDone = true;
      write.status = 0;
      return route.abort('connectionreset');
    }
    return reply(200, toRun(run));
  };

  // ===== routing =============================================================

  await page.route(
    (url) => url.pathname.startsWith('/api/v1/'),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const found = operationOf(request);
      const own = found !== undefined && allowed.includes(found.operation);
      const scripting = found !== undefined && OP[found.operation][2] === SCRIPTING;
      if (options.fallbackOthers === true && !scripting) {
        return route.fallback();
      }
      requests.push(url);
      for (const header of Object.keys(request.headers())) {
        if (/programme|tenant/i.test(header)) violations.push(`${request.method()} ${url.pathname} was sent a "${header}" header — scope is never supplied`);
      }
      if (found === undefined || !own) {
        violations.push(`${request.method()} ${url.pathname} is not an operation the ${world === 'builder' ? 'script builder' : 'agent script screen'} uses`);
        return route.fulfill({ status: 404, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(errorBody('NotFound')) });
      }
      const { operation, params } = found;
      calls.set(operation, [...(calls.get(operation) ?? []), url]);
      if (operation === 'getCurrentUser') return answer(route, operation, 200, clone(me));
      if (operation === 'getMyCapabilities') {
        if (options.capabilities === 'unreadable') return route.fulfill({ status: 500, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify({ statusCode: 500, error: 'Internal Server Error', code: 'internal_error', message: 'Internal error' }) });
        const own = {
          tenant: { admin: writer, can: [] as string[] },
          programmes: [{ id: PROGRAMME_ONE.id, can: writer ? ['activity.write', 'script.run', 'script.write'] : ['script.run'] }],
        };
        return answer(route, operation, 200, clone(options.capabilities ?? own));
      }
      if (operation === 'listMyProgrammes') {
        servedProgrammes.add(PROGRAMME_ONE.id);
        servedProgrammes.add(PROGRAMME_TWO.id);
        return answer(route, operation, 200, { data: [clone(PROGRAMME_ONE), clone(PROGRAMME_TWO)] });
      }
      if (operation === 'listDispositions') {
        const programme = params.programmeId ?? '';
        if (!writer || ADMIN_DISPOSITIONS[programme] === undefined) {
          return answer(route, operation, 404, clone(at(deref(at(ADMIN_DOC, 'components', 'responses', 'NotFound'), ADMIN_DOC).node, 'content', 'application/json', 'example')));
        }
        const items = (ADMIN_DISPOSITIONS[programme] ?? []).map((row) => ({ ...clone(row), active: true, usageCount90d: null }));
        return answer(route, operation, 200, { items, usageWindowDays: 90 });
      }
      return world === 'builder' ? builder(route, request, operation, params, url) : runOps(route, request, operation, params, url);
    },
  );

  return {
    requests,
    calls,
    writes,
    violations,
    mockFaults,
    scripts,
    versions,
    runs,
    calledTimes: (operation) => (calls.get(operation) ?? []).length,
    release: () => release(),
    releaseWrites: () => releaseWrites(),
  };
}

// ---------------------------------------------------------------------------
// Load-time self-checks of the declared answers
// ---------------------------------------------------------------------------

for (const [operation, body] of [
  ['listContactScripts', { data: [], nextCursor: null }],
  ['listScriptRunDispositions', { data: DISPOSITIONS, nextCursor: null }],
  ['getCurrentUser', ADMIN_USER],
  ['getCurrentUser', AGENT_USER],
] as const) {
  const problems = answerProblems(operation, 200, body);
  if (problems.length > 0) throw new Error(`${operation} fixtures disagree with the contract: ${problems.join('; ')}`);
}
