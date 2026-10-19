import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * ACCEPTANCE — T-0124, the records CONTRACT for "`displayName` follows its
 * name parts everywhere" (D-L68), the contacts list `q`, and R21 on the
 * contact and lead lists. Contract half; the wire half is
 * tests/acceptance/records/display-name-field-security.acceptance.test.ts,
 * which carries the same rulings I1–I17 and states them in full. Written by
 * QA (Agent 12) for the lead before the contract edit (D-L23, D-L25), from
 * the task file, D-L68, D-L133 (R8, R21 and its open item), D-L135, D-L175
 * C9 and D-L176. Not from an implementation.
 *
 * The artefact under test is `docs/api/records.openapi.yaml` (and, for I13,
 * `docs/api/scripting.openapi.yaml`), read as parsed YAML. Helpers are the
 * records-contract-search loader and validator, restated, never imported
 * (importing a test file registers its tests).
 *
 * ==========================================================================
 * RULINGS this file pins (numbering shared with the wire suite)
 * ==========================================================================
 * I1  The rule: a contact's (and a lead's) `displayName` is readable exactly
 *     when BOTH `givenNames` and `familyName` are readable in that record's
 *     programme (T-0085 R8 carried everywhere). Never composed.
 * I2  RECORD shapes (Contact, and the search hits that already follow R8):
 *     withheld is OMITTED and listed in `withheldFields`, never `null`.
 *     `Contact.displayName` leaves `required` and stays `type: string`.
 * I3  SUMMARY shapes, the closed `{ id, displayName }` objects naming a
 *     contact inside another answer (DealContactSummary,
 *     ActivityContactSummary, DuplicateContact, ContactMergeParty):
 *     `displayName` stays required and is `[string, 'null']`, `null` meaning
 *     withheld, and the schema's text says so. Notification.objectDisplayName
 *     already does. SILENT in the task file (it names Contact and the lead
 *     shape only); ruled so because a closed summary has no
 *     `withheldFields`, and the two summaries D-L175 C9 settled already do it.
 * I4  CONFLICT with D-L175 C9, ruled per the task file: C9's "Contact.
 *     displayName is never withheld" is superseded. No description may call a
 *     contact's `displayName` never withheld or never null, and Contact's
 *     never-withheld list drops it. C9's other half (the two nullable
 *     summaries) stands and becomes I3.
 * I5  Sort keys are never-withheld fields: `displayName` and `-displayName`
 *     leave the `sort` enums of listContacts, listLeads and
 *     listAccountContacts; every remaining key is in `Contact.required`; the
 *     default is in the enum (listAccountContacts' default is `displayName`
 *     today and must move; which key it moves to is the lead's).
 * I7  `q` on listContacts and listLeads never matches a withheld
 *     `displayName`, and the contract says so.
 * I8  `q`'s limits are unchanged, 1 to 100 characters. SILENT; conservative
 *     is no widening. No throttle is added (the task sets none).
 * I9  R21 (D-L133's open item, folded into T-0124; the rule as D-L135 states
 *     it): the `q` of listContacts and listLeads carries the searchRecords
 *     `not` pattern exactly, names `identifier_in_url`, sends clients to
 *     lookupRecords, and no longer promises a number or E.164 match.
 * I10 listAccounts' and listDeals' `q` are not brought under R21 here.
 *     SILENT (D-L133 names only the contact and lead lists); flagged.
 * I12 listContactTimeline: an item naming `displayName` follows
 *     `displayName`, as one naming `ownerUserId` follows `ownerUserId`.
 *     SILENT; ruled from the operation's own omission rule.
 * I13 Scripting: `{contact.displayName}` and a branch on `displayName`
 *     follow the name parts (publish's `branch_on_withheld_field`, the run's
 *     `field_withheld`); the scripting contract says so. Not in the task
 *     file; found by grepping for displayName.
 * I17 Every schema in the records contract with a `displayName` property is
 *     classified below (contact record, contact summary, user name, request
 *     body). A new one that is not fails the sweep, so the next schema that
 *     names a contact is ruled on rather than slipping through.
 *
 * Silent points and the rest of the rulings (I6, I11, I14–I16) are on the
 * wire side.
 *
 * D-L23: on main, `Contact.displayName` is required and called never
 * withheld, the two deal and activity summaries are non-null strings, every
 * sort enum offers `displayName`, and both `q`s accept "name or number". Every
 * test fails on main for that reason except those titled "(guard, passes on
 * main)", which pin what already holds so a regression is caught, and
 * "(self-check)", which prove this file's own judges refuse planted defects.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const SPEC_REL = 'docs/api/records.openapi.yaml';
const SPEC_PATH = resolve(repoRoot, SPEC_REL);
const SCRIPTING_PATH = resolve(repoRoot, 'docs/api/scripting.openapi.yaml');

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------
// Loading and $ref resolution (the records-contract-search loader, restated)
// ---------------------------------------------------------------------------

function posix(file: string): string {
  return relative(repoRoot, file).split('\\').join('/');
}

const docCache = new Map<string, { doc: unknown; error: string | null }>();

function loadDoc(file: string): { doc: unknown; error: string | null } {
  const cached = docCache.get(file);
  if (cached) return cached;
  let entry: { doc: unknown; error: string | null };
  if (!existsSync(file)) {
    entry = { doc: undefined, error: `${posix(file)} does not exist` };
  } else {
    try {
      entry = { doc: parse(readFileSync(file, 'utf8')) as unknown, error: null };
    } catch (error) {
      entry = {
        doc: undefined,
        error: `${posix(file)} is not valid YAML: ${(error as Error).message}`,
      };
    }
  }
  docCache.set(file, entry);
  return entry;
}

function specAt(file: string): Mapping {
  const { doc, error } = loadDoc(file);
  if (error !== null) throw new Error(error);
  if (!isMapping(doc)) throw new Error(`${posix(file)} does not parse to a mapping`);
  return doc;
}

interface Located {
  node: unknown;
  file: string;
}

function resolveRef(ref: string, fromFile: string): Located | undefined {
  const hash = ref.indexOf('#');
  const filePart = hash === -1 ? ref : ref.slice(0, hash);
  const pointer = hash === -1 ? '' : ref.slice(hash + 1);
  const file = filePart === '' ? fromFile : resolve(dirname(fromFile), filePart);
  const { doc, error } = loadDoc(file);
  if (error !== null) return undefined;
  let node: unknown = doc;
  if (pointer !== '') {
    if (!pointer.startsWith('/')) return undefined;
    for (const raw of pointer.slice(1).split('/')) {
      const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      if (Array.isArray(node)) node = node[Number(key)];
      else if (isMapping(node) && key in node) node = node[key];
      else return undefined;
    }
  }
  return node === undefined ? undefined : { node, file };
}

function deref(located: Located): Located {
  let current = located;
  for (let hops = 0; hops < 32; hops += 1) {
    if (!isMapping(current.node) || typeof current.node.$ref !== 'string') return current;
    const next = resolveRef(current.node.$ref, current.file);
    if (next === undefined) throw new Error(`unresolved $ref ${current.node.$ref}`);
    current = next;
  }
  throw new Error('$ref chain longer than 32 hops (a cycle?)');
}

function at(node: unknown, file: string = SPEC_PATH): Located {
  return deref({ node, file });
}

function child(parent: Located, key: string): Located | undefined {
  if (!isMapping(parent.node) || parent.node[key] === undefined) return undefined;
  return at(parent.node[key], parent.file);
}

function schemaNames(file: string = SPEC_PATH): string[] {
  const components = specAt(file).components;
  const schemas = isMapping(components) && isMapping(components.schemas) ? components.schemas : {};
  return Object.keys(schemas);
}

function schemaNamed(name: string, file: string = SPEC_PATH): Located {
  if (!schemaNames(file).includes(name))
    throw new Error(`components.schemas.${name} not found in ${posix(file)}`);
  return at({ $ref: `#/components/schemas/${name}` }, file);
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'];

interface Operation {
  id: string;
  method: string;
  path: string;
  op: Mapping;
  params: Mapping[];
}

function operations(file: string = SPEC_PATH): Operation[] {
  const doc = specAt(file);
  const paths = isMapping(doc.paths) ? doc.paths : {};
  const out: Operation[] = [];
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = at(rawItem, file).node;
    if (!isMapping(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isMapping(op)) continue;
      const own = Array.isArray(op.parameters) ? op.parameters : [];
      const params = [...shared, ...own].map((p) => at(p, file).node).filter(isMapping);
      out.push({ id: str(op.operationId), method, path, op, params });
    }
  }
  return out;
}

function operation(id: string, file: string = SPEC_PATH): Operation {
  const found = operations(file).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`operationId ${id} not found in ${posix(file)}`);
  return found;
}

function responses(op: Operation): Map<string, Located> {
  const raw = isMapping(op.op.responses) ? op.op.responses : {};
  return new Map(Object.entries(raw).map(([code, value]) => [code, at(value)]));
}

function jsonMedia(holder: Located | undefined): Located | undefined {
  if (!holder) return undefined;
  const content = child(holder, 'content');
  return content ? child(content, 'application/json') : undefined;
}

function responseSchemaRef(op: Operation, status: string): string {
  const media = jsonMedia(responses(op).get(status));
  const schema = media && isMapping(media.node) ? media.node.schema : undefined;
  return isMapping(schema) ? str(schema.$ref) : '';
}

function examplesOf(media: Located | undefined): [string, unknown][] {
  if (!media || !isMapping(media.node)) return [];
  const out: [string, unknown][] = [];
  if (media.node.example !== undefined) out.push(['example', media.node.example]);
  const examples = child(media, 'examples');
  if (examples && isMapping(examples.node)) {
    for (const key of Object.keys(examples.node)) {
      const example = child(examples, key);
      if (example && isMapping(example.node)) out.push([key, example.node.value]);
    }
  }
  return out;
}

/** The text with every run of whitespace collapsed, so a phrase may wrap. */
function prose(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function description(op: Operation): string {
  return prose(str(op.op.description));
}

function properties(schema: Located): Map<string, Located> {
  const out = new Map<string, Located>();
  const node = schema.node;
  if (!isMapping(node)) return out;
  for (const part of Array.isArray(node.allOf) ? node.allOf : []) {
    for (const [key, value] of properties(at(part, schema.file))) out.set(key, value);
  }
  const props = child(schema, 'properties');
  if (props && isMapping(props.node)) {
    for (const key of Object.keys(props.node)) {
      const value = child(props, key);
      if (value) out.set(key, value);
    }
  }
  return out;
}

function required(schema: Located): string[] {
  const node = schema.node;
  return isMapping(node) && Array.isArray(node.required) ? node.required.map(str) : [];
}

function types(schema: Located): string[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  const out = new Set<string>();
  if (typeof node.type === 'string') out.add(node.type);
  if (Array.isArray(node.type)) node.type.map(str).forEach((type) => out.add(type));
  for (const key of ['oneOf', 'anyOf']) {
    const variants = node[key];
    if (Array.isArray(variants))
      variants.forEach((v) => types(at(v, schema.file)).forEach((t) => out.add(t)));
  }
  return [...out].sort();
}

function textOf(located: Located | undefined): string {
  return located && isMapping(located.node) ? prose(str(located.node.description)) : '';
}

function param(op: Operation, name: string): Mapping | undefined {
  return op.params.find((candidate) => candidate.name === name);
}

function paramSchema(op: Operation, name: string): Located {
  const parameter = param(op, name);
  if (!parameter) throw new Error(`${op.id} has no parameter ${name}`);
  return at(parameter.schema ?? {});
}

// ---------------------------------------------------------------------------
// The validator (records-contract-search's subset, restated), with `not`.
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function validate(raw: Located, value: unknown, path: string): string[] {
  const schema = deref(raw);
  const node = schema.node;
  if (!isMapping(node)) return [`${path}: schema is not a mapping`];
  const problems: string[] = [];
  if (Array.isArray(node.allOf)) {
    for (const part of node.allOf) problems.push(...validate(at(part, schema.file), value, path));
  }
  for (const combinator of ['oneOf', 'anyOf'] as const) {
    const variants = node[combinator];
    if (!Array.isArray(variants)) continue;
    const passing = variants.filter(
      (v) => validate(at(v, schema.file), value, path).length === 0,
    ).length;
    if (combinator === 'oneOf' ? passing !== 1 : passing < 1) {
      problems.push(`${path}: matches ${passing} ${combinator} branches`);
    }
  }
  if (node.not !== undefined && validate(at(node.not, schema.file), value, path).length === 0) {
    problems.push(`${path}: matches a not schema`);
  }
  const actual = jsonType(value);
  if (node.type !== undefined) {
    const allowed = (Array.isArray(node.type) ? node.type : [node.type]).map(str);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      return [...problems, `${path}: ${actual}, not ${allowed.join('|')}`];
    }
  }
  if ('const' in node && node.const !== value) problems.push(`${path}: not ${String(node.const)}`);
  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    problems.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(node.enum)}`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof node.minLength === 'number' && length < node.minLength)
      problems.push(`${path}: too short`);
    if (typeof node.maxLength === 'number' && length > node.maxLength)
      problems.push(`${path}: too long`);
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern, 'u').test(value)) {
      problems.push(`${path}: does not match ${node.pattern}`);
    }
    if (node.format === 'uuid' && !UUID.test(value)) problems.push(`${path}: not a uuid`);
    if (node.format === 'date-time' && !UTC_DATE_TIME.test(value))
      problems.push(`${path}: not a UTC date-time`);
  }
  if (typeof value === 'number') {
    if (typeof node.minimum === 'number' && value < node.minimum) problems.push(`${path}: < min`);
    if (typeof node.maximum === 'number' && value > node.maximum) problems.push(`${path}: > max`);
  }
  if (Array.isArray(value)) {
    const items = child(schema, 'items');
    if (items)
      value.forEach((item, index) => problems.push(...validate(items, item, `${path}[${index}]`)));
  }
  if (isMapping(value)) {
    const props = isMapping(node.properties) ? node.properties : {};
    for (const key of Array.isArray(node.required) ? node.required.map(str) : []) {
      if (!(key in value)) problems.push(`${path}: ${key} is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (props[key] !== undefined) {
        problems.push(...validate(at(props[key], schema.file), item, `${path}.${key}`));
      } else if (node.additionalProperties === false) {
        problems.push(`${path}: ${key} is not a property of this closed object`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// R21's identifier rule, exactly as records-contract-search pins it (D-L135).
// ---------------------------------------------------------------------------

const IDENTIFIER_Q_PATTERN = '[@＠﹫]|\\p{Nd}(?:[^\\p{L}\\p{Nd}]*\\p{Nd}){5}';

function looksLikeIdentifier(q: string): boolean {
  const text = q.normalize('NFKC');
  return text.includes('@') || /\p{Nd}{6,}/u.test(text.replace(/[^\p{L}\p{Nd}]/gu, ''));
}

/** Pasted identifiers the rule must refuse; synthetic or placeholders (Nigeria has no fictional range). */
const IDENTIFIER_QS = [
  '08031234567',
  '+2348031234567',
  '+234 803 123 4567',
  '0803 123 4567',
  '(0803) 123-4567',
  '0803.123.4567',
  '234-803-123-4567',
  '123456',
  'Sample 080312',
  'sample@example.test',
  'a@b',
  '@sample',
  '0803/123/4567',
  '0803_123_4567',
  '0803,123,4567',
  '0803–123–4567',
  '٠٨٠٣١٢٣٤٥٦٧',
  'Sample\t080 312 45',
];
/** Names the rule must let through. */
const NAME_QS = [
  'Sample',
  'Sámple Fixture',
  'Sample 2026',
  'Unit 12 Block 3456',
  'Sample 12345',
  '50% Sample',
  'Sample (Lagos) Ltd',
  'Fixture-12.34',
];

// ---------------------------------------------------------------------------
// The classification (I2, I3, I17).
// ---------------------------------------------------------------------------

/** I2: the contact's own record shapes. Omitted and listed when withheld. */
const CONTACT_RECORDS = ['Contact', 'ContactSearchHit', 'LeadSearchHit'] as const;
/** I3: closed summaries naming a contact inside another answer. `null` when withheld. */
const CONTACT_SUMMARIES = [
  'ActivityContactSummary',
  'DealContactSummary',
  'DuplicateContact',
  'ContactMergeParty',
] as const;
/** Summaries that already say `null` when withheld on main (D-L175 C9). */
const SUMMARIES_ALREADY_NULLABLE = new Set<string>(['DuplicateContact', 'ContactMergeParty']);
/** Search hits follow R8 on main (T-0085). */
const RECORDS_ALREADY_RULED = new Set<string>(['ContactSearchHit', 'LeadSearchHit']);
/** I15: a USER's display name (D-P23, D-L81), not contact field security. */
const USER_NAMES = [
  'NotificationActor',
  'ContactOwner',
  'TimelineActor',
  'AccountOwner',
  'DealOwner',
  'DealActor',
] as const;
/** Write bodies: what a caller sends, not what they read (I11 is on the wire side). */
const REQUEST_BODIES = ['CreateContactRequest', 'UpdateContactRequest'] as const;
const CLASSIFIED = new Set<string>([
  ...CONTACT_RECORDS,
  ...CONTACT_SUMMARIES,
  ...USER_NAMES,
  ...REQUEST_BODIES,
]);

/** The operations whose answers carry a whole Contact (I2): the schema each must still use. */
const CONTACT_ANSWERS: [string, string, string][] = [
  ['listContacts', '200', '#/components/schemas/ContactPage'],
  ['listLeads', '200', '#/components/schemas/ContactPage'],
  ['listAccountContacts', '200', '#/components/schemas/ContactPage'],
  ['getContact', '200', '#/components/schemas/Contact'],
  ['createContact', '201', '#/components/schemas/Contact'],
  ['updateContact', '200', '#/components/schemas/Contact'],
  ['convertContact', '200', '#/components/schemas/ConvertContactResponse'],
  ['getContactMergePreview', '200', '#/components/schemas/ContactMergePreview'],
];

/** I5: the lists whose `sort` must use never-withheld keys only. */
const SORTED_LISTS = ['listContacts', 'listLeads', 'listAccountContacts'] as const;
/** I7, I9: the lists whose `q` this task changes. */
const Q_LISTS = ['listContacts', 'listLeads'] as const;

/** Schemas in the records contract that carry a `displayName` property. */
function displayNameSchemas(): string[] {
  return schemaNames()
    .filter((name) => properties(schemaNamed(name)).has('displayName'))
    .sort();
}

/** Everything wrong with a record-shaped schema under I2; empty when right. */
function recordProblems(schema: Located, name: string): string[] {
  const problems: string[] = [];
  const prop = properties(schema).get('displayName');
  if (!prop) return [`${name} has no displayName`];
  if (required(schema).includes('displayName'))
    problems.push(`${name}: displayName is required, so it can never be withheld`);
  const t = types(prop);
  if (t.join() !== 'string')
    problems.push(
      `${name}: displayName is ${t.join('|')}, not a plain string (withheld is omitted, never null)`,
    );
  if (!properties(schema).has('withheldFields') || !required(schema).includes('withheldFields')) {
    problems.push(`${name}: no required withheldFields to list a withheld displayName in`);
  }
  return problems;
}

/** Everything wrong with a summary-shaped schema under I3; empty when right. */
function summaryProblems(schema: Located, name: string): string[] {
  const problems: string[] = [];
  const prop = properties(schema).get('displayName');
  if (!prop) return [`${name} has no displayName`];
  if (!required(schema).includes('displayName'))
    problems.push(`${name}: displayName is not required (a summary sends null, never omits)`);
  const t = types(prop);
  if (!(t.includes('string') && t.includes('null')))
    problems.push(`${name}: displayName is ${t.join('|')}, not string|null`);
  const text = `${textOf(schema)} ${textOf(prop)}`;
  if (!/`?null`?[^.]*withh|withh[^.]*`?null`?/i.test(text))
    problems.push(`${name}: the text does not say null means withheld`);
  if (properties(schema).has('withheldFields'))
    problems.push(`${name}: a summary with withheldFields is a record; classify it as one`);
  return problems;
}

/** I4: phrases that call a contact's displayName never withheld or never null. */
function neverWithheldClaims(text: string): string[] {
  const out: string[] = [];
  for (const sentence of prose(text).split(/(?<=\.)\s+/)) {
    if (/never withheld/i.test(sentence) && /`displayName`/.test(sentence)) out.push(sentence);
    if (/`displayName`[^.]*\bis never (`null`|null|withheld)/i.test(sentence)) out.push(sentence);
  }
  return [...new Set(out)];
}

/** Example objects (any depth) whose withheldFields name a name part; for I2's example sweep. */
function withheldPartObjects(
  value: unknown,
  path: string,
  out: [string, Mapping][] = [],
): [string, Mapping][] {
  if (Array.isArray(value))
    value.forEach((item, i) => withheldPartObjects(item, `${path}[${i}]`, out));
  else if (isMapping(value)) {
    const withheld = Array.isArray(value.withheldFields) ? value.withheldFields.map(str) : [];
    if (withheld.includes('givenNames') || withheld.includes('familyName')) out.push([path, value]);
    for (const [key, item] of Object.entries(value))
      withheldPartObjects(item, `${path}.${key}`, out);
  }
  return out;
}

function allExamples(): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const op of operations()) {
    for (const [status, response] of responses(op)) {
      for (const [label, value] of examplesOf(jsonMedia(response)))
        out.push([`${op.id} ${status} ${label}`, value]);
    }
  }
  return out;
}

/** I5: what is wrong with one list's sort parameter; empty when right. */
function sortProblems(
  op: Operation,
  sortSchema: Located,
  neverWithheld: readonly string[],
): string[] {
  const node = sortSchema.node;
  const values = isMapping(node) && Array.isArray(node.enum) ? node.enum.map(str) : [];
  const problems: string[] = [];
  if (values.length === 0)
    problems.push(`${op.id}: sort has no enum (a free column name would leak values)`);
  for (const value of values) {
    const key = value.replace(/^-/, '');
    if (!neverWithheld.includes(key))
      problems.push(`${op.id}: sort key ${value} is not a never-withheld Contact property`);
  }
  const fallback = isMapping(node) ? str(node.default) : '';
  if (fallback !== '' && !values.includes(fallback))
    problems.push(`${op.id}: default ${fallback} is not in the enum`);
  return problems;
}

/** I9: what one list's q fails to say or enforce about identifiers; empty when right. */
function qIdentifierProblems(op: Operation, qSchema: Located, qText: string): string[] {
  const problems: string[] = [];
  const node = qSchema.node;
  const not = isMapping(node) && isMapping(node.not) ? node.not : undefined;
  if (!not || not.pattern !== IDENTIFIER_Q_PATTERN)
    problems.push(`${op.id}: q has no not pattern ${IDENTIFIER_Q_PATTERN}`);
  const text = `${qText} ${description(op)}`;
  if (!/identifier_in_url/.test(text)) problems.push(`${op.id}: identifier_in_url is not named`);
  if (!/lookupRecords/.test(text)) problems.push(`${op.id}: clients are not sent to lookupRecords`);
  if (!/NFKC/.test(text)) problems.push(`${op.id}: NFKC is not stated`);
  const qOnly = `${qText} ${textOf(qSchema)}`;
  if (/E\.164|\bor numbers?\b|\bnumbers? or\b|\bname,? numbers?\b|\(normalised to E/i.test(qOnly))
    problems.push(`${op.id}: q still promises a number or E.164 match`);
  return problems;
}

// ---------------------------------------------------------------------------

describe('acceptance: records contract, displayName follows its name parts everywhere (T-0124)', () => {
  describe('every displayName is classified, and each class follows one rule (I2, I3, I4, I17)', () => {
    it('(guard, passes on main) every schema with a displayName property is classified; a new one must be ruled on first (I17)', () => {
      const found = displayNameSchemas();
      expect(found.length, 'the sweep found nothing: the loader is broken').toBeGreaterThanOrEqual(
        CLASSIFIED.size,
      );
      expect(
        found.filter((name) => !CLASSIFIED.has(name)),
        'unclassified displayName schemas',
      ).toEqual([]);
      expect(
        [...CLASSIFIED].filter((name) => !found.includes(name)),
        'classified schemas that no longer exist',
      ).toEqual([]);
    });

    // The search hits already follow T-0085 R8, so their rows are guards.
    it.each(
      CONTACT_RECORDS.map((name) => [
        RECORDS_ALREADY_RULED.has(name) ? `(guard, passes on main) ${name}` : name,
        name,
      ]),
    )(
      '%s: displayName is optional, a plain string, and listed in withheldFields when withheld (I2)',
      (_label, name) => {
        expect(recordProblems(schemaNamed(name), name)).toEqual([]);
      },
    );

    // DuplicateContact and ContactMergeParty already say null-when-withheld (D-L175 C9): guards.
    it.each(
      CONTACT_SUMMARIES.map((name) => [
        SUMMARIES_ALREADY_NULLABLE.has(name) ? `(guard, passes on main) ${name}` : name,
        name,
      ]),
    )(
      '%s: displayName is required, string or null, and the text says null means withheld (I3)',
      (_label, name) => {
        expect(summaryProblems(schemaNamed(name), name)).toEqual([]);
      },
    );

    it('(guard, passes on main) Notification.objectDisplayName is null when a contact name part is withheld, never composed', () => {
      const prop = properties(schemaNamed('Notification')).get('objectDisplayName');
      expect(prop ? types(prop) : []).toEqual(['null', 'string']);
      const text = textOf(prop);
      expect(text).toMatch(/givenNames/);
      expect(text).toMatch(/familyName/);
      expect(text).toMatch(/never composed/);
    });

    it('no description calls a contact’s displayName never withheld or never null, and Contact’s never-withheld list drops it (I4, D-L175 C9 superseded)', () => {
      const claims: string[] = [];
      for (const name of [...CONTACT_RECORDS, ...CONTACT_SUMMARIES]) {
        const schema = schemaNamed(name);
        const text = `${textOf(schema)} ${textOf(properties(schema).get('displayName'))}`;
        claims.push(...neverWithheldClaims(text).map((claim) => `${name}: ${claim}`));
      }
      for (const [opId] of CONTACT_ANSWERS) {
        claims.push(
          ...neverWithheldClaims(description(operation(opId))).map((claim) => `${opId}: ${claim}`),
        );
      }
      expect(claims).toEqual([]);
    });

    it('Contact’s text states the rule: follows givenNames and familyName, omitted and listed, never composed (I1, I2)', () => {
      const contact = schemaNamed('Contact');
      const text = `${textOf(contact)} ${textOf(properties(contact).get('displayName'))}`;
      const missing = [
        [/`displayName`/, 'names displayName'],
        [/`givenNames`/, 'names givenNames'],
        [/`familyName`/, 'names familyName'],
        [/composed/i, 'says it is never composed'],
        [/D-L68/, 'cites D-L68'],
      ]
        .filter(([pattern]) => !(pattern as RegExp).test(text))
        .map(([, label]) => label as string);
      expect(missing, `Contact's text: ${text.slice(0, 400)}…`).toEqual([]);
    });

    it('(guard, passes on main) every answer that carries a whole contact still uses Contact, so the rule reaches it: lists, get, create, update, convert, merge preview (I2)', () => {
      for (const [opId, status, ref] of CONTACT_ANSWERS) {
        expect(responseSchemaRef(operation(opId), status), `${opId} ${status}`).toBe(ref);
      }
      expect(properties(schemaNamed('ContactPage')).get('data')?.node).toBeDefined();
      for (const [schema, key] of [
        ['ConvertContactResponse', 'contact'],
        ['ContactMergePreview', 'survivor'],
        ['ContactMergePreview', 'merged'],
      ] as const) {
        const raw = (schemaNamed(schema).node as Mapping).properties as Mapping;
        expect((raw[key] as Mapping).$ref, `${schema}.${key}`).toBe('#/components/schemas/Contact');
      }
    });

    it('a Contact with displayName withheld (omitted, listed) validates; one with displayName null never does (I2)', () => {
      const contact = schemaNamed('Contact');
      const base = {
        id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e01',
        programmeId: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a01',
        version: 1,
        givenNames: 'Sample',
        createdAt: '2026-10-01T09:12:00.000Z',
        updatedAt: '2026-10-01T09:12:00.000Z',
      };
      expect(
        validate(contact, { ...base, withheldFields: ['displayName', 'familyName'] }, 'withheld'),
      ).toEqual([]);
      expect(
        validate(contact, { ...base, displayName: null, withheldFields: ['familyName'] }, 'nulled')
          .length,
        'a null displayName validated: withheld must be omitted, never nulled',
      ).toBeGreaterThan(0);
    });

    it('(self-check) the judges refuse a nullable record, a required record, a non-null summary and a summary that is silent on null', () => {
      const file = SPEC_PATH;
      const record = (prop: Mapping, req: string[]): Located => ({
        node: {
          type: 'object',
          required: [...req, 'withheldFields'],
          properties: { displayName: prop, withheldFields: { type: 'array' } },
        },
        file,
      });
      expect(recordProblems(record({ type: 'string' }, []), 'good')).toEqual([]);
      expect(
        recordProblems(record({ type: ['string', 'null'] }, []), 'nullable').length,
      ).toBeGreaterThan(0);
      expect(
        recordProblems(record({ type: 'string' }, ['displayName']), 'required').length,
      ).toBeGreaterThan(0);
      const summary = (prop: Mapping, text: string): Located => ({
        node: {
          type: 'object',
          required: ['id', 'displayName'],
          description: text,
          properties: { id: { type: 'string' }, displayName: prop },
        },
        file,
      });
      expect(
        summaryProblems(summary({ type: ['string', 'null'] }, '`null` when withheld.'), 'good'),
      ).toEqual([]);
      expect(
        summaryProblems(summary({ type: 'string' }, '`null` when withheld.'), 'string').length,
      ).toBeGreaterThan(0);
      expect(
        summaryProblems(summary({ type: ['string', 'null'] }, 'An id and a name.'), 'silent')
          .length,
      ).toBeGreaterThan(0);
      expect(
        neverWithheldClaims('`id`, `displayName` and `createdAt` are never withheld.'),
      ).toHaveLength(1);
      expect(neverWithheldClaims('`displayName` is never `null` here.')).toHaveLength(1);
      expect(
        neverWithheldClaims(
          '`id` and `createdAt` are never withheld. `displayName` follows its parts.',
        ),
      ).toEqual([]);
    });
  });

  describe('examples obey the rule (I2)', () => {
    it('(guard, passes on main) no example shows a displayName beside a withheld name part', () => {
      const offending: string[] = [];
      let seen = 0;
      for (const [label, value] of allExamples()) {
        for (const [path, object] of withheldPartObjects(value, label)) {
          seen += 1;
          const withheld = (object.withheldFields as unknown[]).map(str);
          if ('displayName' in object)
            offending.push(`${path}: displayName sent beside a withheld name part`);
          else if (!withheld.includes('displayName'))
            offending.push(`${path}: displayName omitted but not listed`);
        }
      }
      // Not vacuous: the search contract's withheldNamePart example has one.
      expect(seen, 'no example withholds a name part, so this checked nothing').toBeGreaterThan(0);
      expect(offending).toEqual([]);
    });

    it('a Contact-bearing example shows a withheld displayName, omitted and listed beside a withheld name part (I2)', () => {
      const contactOps = new Set(CONTACT_ANSWERS.map(([id]) => id));
      const found: string[] = [];
      for (const op of operations().filter((candidate) => contactOps.has(candidate.id))) {
        for (const [status, response] of responses(op)) {
          for (const [label, value] of examplesOf(jsonMedia(response))) {
            for (const [path, object] of withheldPartObjects(
              value,
              `${op.id} ${status} ${label}`,
            )) {
              const withheld = (object.withheldFields as unknown[]).map(str);
              if (!('displayName' in object) && withheld.includes('displayName')) found.push(path);
            }
          }
        }
      }
      expect(found, 'no contact, lead or merge example documents the withheld form').not.toEqual(
        [],
      );
    });
  });

  describe('sort keys are never-withheld fields (I5)', () => {
    it.each(SORTED_LISTS.map((id) => [id]))(
      '%s: no displayName key; every key is a never-withheld Contact property; the default is in the enum',
      (id) => {
        const op = operation(id);
        const neverWithheld = required(schemaNamed('Contact')).filter(
          (key) => key !== 'withheldFields',
        );
        expect(neverWithheld, 'Contact.required is the never-withheld set').toEqual(
          expect.arrayContaining(['id', 'createdAt', 'updatedAt']),
        );
        expect(sortProblems(op, paramSchema(op, 'sort'), neverWithheld)).toEqual([]);
        const values = (paramSchema(op, 'sort').node as Mapping).enum as unknown[];
        expect(values.map(str).filter((value) => /displayName/.test(value))).toEqual([]);
      },
    );

    it('(self-check) a displayName sort key, a free column name and a default outside the enum are each caught', () => {
      const op = operation('listContacts');
      const file = SPEC_PATH;
      const never = ['id', 'programmeId', 'version', 'createdAt', 'updatedAt'];
      const good: Located = {
        node: { type: 'string', enum: ['-createdAt', 'createdAt'], default: '-createdAt' },
        file,
      };
      expect(sortProblems(op, good, never)).toEqual([]);
      const planted: Located[] = [
        {
          node: { type: 'string', enum: ['-createdAt', 'displayName'], default: '-createdAt' },
          file,
        },
        { node: { type: 'string' }, file },
        { node: { type: 'string', enum: ['-createdAt'], default: 'displayName' }, file },
        { node: { type: 'string', enum: ['companyName'] }, file },
      ];
      for (const schema of planted)
        expect(sortProblems(op, schema, never).length, JSON.stringify(schema.node)).toBeGreaterThan(
          0,
        );
    });
  });

  describe('q on the contact and lead lists (I7, I8, I9, I10)', () => {
    it.each(Q_LISTS.map((id) => [id]))(
      '(guard, passes on main) %s q: 1 to 100 characters, unchanged (I8)',
      (id) => {
        const schema = paramSchema(operation(id), 'q').node as Mapping;
        expect(schema.minLength).toBe(1);
        expect(schema.maxLength).toBe(100);
      },
    );

    it.each(Q_LISTS.map((id) => [id]))(
      '%s q: the R21 rule as the schema’s not pattern, named, routed to lookupRecords, and no number match promised (I9)',
      (id) => {
        const op = operation(id);
        expect(
          qIdentifierProblems(op, paramSchema(op, 'q'), prose(str(param(op, 'q')?.description))),
        ).toEqual([]);
      },
    );

    it.each(Q_LISTS.map((id) => [id]))(
      '%s q: the schema refuses every pasted identifier and accepts every name (I9)',
      (id) => {
        const schema = paramSchema(operation(id), 'q');
        expect(
          IDENTIFIER_QS.filter((value) => validate(schema, value, 'q').length === 0),
          'identifiers let into the URL',
        ).toEqual([]);
        expect(
          NAME_QS.filter((value) => validate(schema, value, 'q').length > 0),
          'names refused',
        ).toEqual([]);
      },
    );

    it.each(Q_LISTS.map((id) => [id]))(
      '%s: the text says q never matches a withheld displayName (I7)',
      (id) => {
        const op = operation(id);
        const text = `${prose(str(param(op, 'q')?.description))} ${description(op)}`;
        expect(text).toMatch(/`displayName`[^.]*withh|withh[^.]*`displayName`/);
      },
    );

    it('(guard, passes on main) searchRecords keeps the same not pattern, so the three q rules are one rule', () => {
      const schema = paramSchema(operation('searchRecords'), 'q').node as Mapping;
      expect((schema.not as Mapping | undefined)?.pattern).toBe(IDENTIFIER_Q_PATTERN);
    });

    it('(guard, passes on main) no parameter anywhere in the file is named for a phone or an email (R21)', () => {
      const all = operations();
      const offending = all.flatMap((op) =>
        op.params
          .filter((p) => /phone|email|e164|msisdn|mobile|mail/i.test(str(p.name)))
          .map((p) => `${op.id}: ${str(p.name)}`),
      );
      expect(offending).toEqual([]);
      expect(all.reduce((sum, op) => sum + op.params.length, 0)).toBeGreaterThan(40);
    });

    it('(self-check) the identifier rule, the pattern and the q judge agree, and a weaker q is caught', () => {
      const pattern = new RegExp(IDENTIFIER_Q_PATTERN, 'u');
      for (const value of IDENTIFIER_QS) {
        expect(looksLikeIdentifier(value), value).toBe(true);
        expect(pattern.test(value), value).toBe(true);
      }
      for (const value of NAME_QS) {
        expect(looksLikeIdentifier(value), value).toBe(false);
        expect(pattern.test(value), value).toBe(false);
      }
      const op = operation('searchRecords');
      const good: Located = {
        node: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          not: { pattern: IDENTIFIER_Q_PATTERN },
        },
        file: SPEC_PATH,
      };
      const goodText =
        'A name. After NFKC an identifier is `400 identifier_in_url`; send those to lookupRecords.';
      expect(qIdentifierProblems(op, good, goodText).filter((p) => !p.includes('NFKC'))).toEqual(
        [],
      );
      const weak: Located = {
        node: { type: 'string', not: { pattern: '\\p{Nd}{6}' } },
        file: SPEC_PATH,
      };
      expect(qIdentifierProblems(op, weak, goodText).length).toBeGreaterThan(0);
      expect(
        qIdentifierProblems(op, good, 'Search by name or number, matched in E.164.').length,
      ).toBeGreaterThan(0);
    });
  });

  describe('the contact timeline and scripting follow displayName (I12, I13)', () => {
    it('listContactTimeline: an item naming displayName follows displayName (I12)', () => {
      const text = description(operation('listContactTimeline'));
      expect(text).toMatch(/`displayName`[^.]{0,160}\b(follows|withheld|omitted)\b/);
    });

    it('scripting: a branch or a variable on contact.displayName follows the name parts, at publish and in a run (I13)', () => {
      const publish = description(operation('publishScript', SCRIPTING_PATH));
      const advance = description(operation('advanceScriptRun', SCRIPTING_PATH));
      for (const [label, text] of [
        ['publishScript', publish],
        ['advanceScriptRun', advance],
      ] as const) {
        expect(text, label).toMatch(
          /displayName[^.]*(givenNames|name parts)|(givenNames|name parts)[^.]*displayName/,
        );
      }
    });
  });
});
