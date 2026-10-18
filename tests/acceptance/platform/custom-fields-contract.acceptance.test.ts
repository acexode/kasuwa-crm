import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * ACCEPTANCE — T-0088, the CUSTOM-FIELD contract (P18; ADR-0016, D-L128,
 * D-P24, D-P25, D-L45, D-L64, D-L82, D-L84, D-L88, D-L80, D-L97). Agent 2
 * serves it (T-0089); Agent 11 draws it (T-0090 studio, T-0091 record
 * screens). Contract only: no route, no migration, no code, no database.
 * Written by QA for the lead from the invariants (D-L23, D-L25), before the
 * build.
 *
 * The artefacts under test are `docs/api/records.openapi.yaml` and
 * `docs/api/admin.openapi.yaml`, read as data (parsed YAML, never a regex
 * over the raw text, so a keyword in a YAML comment satisfies nothing). The
 * T-0039 suite keeps the whole-file rules (every `$ref` resolves, unique
 * operationIds, one Error schema, every operation documents 401); this suite
 * does not repeat them. Schema rules are checked BEHAVIOURALLY wherever they
 * can be: a small validator runs fixed accept and refuse cases against the
 * published schema, so the builder chooses the JSON-Schema spelling
 * (`propertyNames` or `patternProperties`, `pattern` or `format`) and the
 * suite only cares what the schema admits.
 *
 * ---------------------------------------------------------------------------
 * PINNED INTERFACES (every name below is a lead ruling the builder follows)
 * ---------------------------------------------------------------------------
 *
 * records.openapi.yaml
 *   SCHEMAS     CustomFields          the read object, and the create bodies'
 *                                     `custom`: keys `__c`, values
 *                                     CustomFieldValue, never null, at most
 *                                     100 keys
 *               CustomFieldsPatch     the update bodies' `custom`: the same
 *                                     keys, values CustomFieldValue or null,
 *                                     1..100 keys
 *               CustomFieldValue      anyOf the six encodings below
 *               CustomFieldText       string 1..1000, no NUL
 *               CustomFieldNumber     canonical decimal string, <= 18
 *                                     significant digits
 *               CustomFieldCurrency   closed { amountMinor, currency }
 *               CustomFieldDate       YYYY-MM-DD, a real calendar date
 *               CustomFieldPicklist   one value, an api name (the stored
 *                                     `config.values[].value` rule)
 *               CustomFieldBoolean    true | false
 *               CustomFieldWithheldPath   `custom.<key>` in withheldFields
 *               AccountPendingProperties  Account's pending part (as Contact)
 *   PLACEMENT   Contact.custom in ContactPendingProperties; Account.custom in
 *               AccountPendingProperties (an allOf part of Account);
 *               Activity.custom and Deal.custom in their own `properties`.
 *   BODIES      `custom` on CreateContactRequest, CreateAccountRequest,
 *               CreateActivityRequest, CreateDealRequest (CustomFields) and
 *               on UpdateContactRequest, UpdateAccountRequest,
 *               UpdateActivityRequest, UpdateDealRequest (CustomFieldsPatch).
 *   FILTERS     query `custom` (deepObject: `custom[tier__c]=gold`) and
 *               `customEmpty` (repeatable key list), ONE shared definition
 *               each, on listContacts, listLeads, listAccounts and listDeals.
 *   400 CODES   details[].code, all under `validation_failed`:
 *                 unknown_field         custom.<key>  unknown OR retired key
 *                                                     (one code for both), on
 *                                                     a write or a filter
 *                 invalid_value         custom.<key>  wrong encoding for type
 *                 unknown_value         custom.<key>  picklist value not in
 *                                                     config.values
 *                 currency_mismatch     custom.<key>.currency  not the field's
 *                                                     currencyCode
 *                 custom_too_large      custom        merged result > 16 KiB
 *                                                     of what the caller can
 *                                                     see (D-L140; T-0089,
 *                                                     D-L142)
 *                 field_withheld        custom.<key>  filter on a key withheld
 *                                                     in ANY reachable
 *                                                     programme
 *                 filter_not_supported  custom.<key>  filter on a key that is
 *                                                     not picklist or boolean
 *   403         `not_permitted` with details[].code `field_not_editable` at
 *               `custom.<key>` (the existing semantics, row's programme).
 *
 * admin.openapi.yaml (tag `custom-fields`)
 *   listCustomFields    GET   /api/v1/admin/custom-fields?object=<object>
 *   createCustomField   POST  /api/v1/admin/custom-fields
 *   updateCustomField   PATCH /api/v1/admin/custom-fields/{fieldId}
 *   retireCustomField   POST  /api/v1/admin/custom-fields/{fieldId}/retire
 *   SCHEMAS     CustomFieldObject (contact, account, activity, deal),
 *               CustomFieldType (the six), CustomFieldPicklistValue,
 *               CustomFieldDefinition, CustomFieldList, CustomFieldLimits,
 *               CreateCustomFieldRequest, UpdateCustomFieldRequest
 *   RESPONSES   CustomFieldValidationFailed (400), CustomFieldConflict (409);
 *               admin's NotFound, NotPermitted and NotAuthenticated
 *   CODES       409 `duplicate_code` (details apiName/duplicate), 409
 *               `limit_reached` (a NEW Error.code; details
 *               objectApiName/field_limit_reached or
 *               addValues/picklist_limit_reached); 400 details
 *               apiName/invalid_api_name, type/unsupported_type,
 *               config/invalid_config, config.currencyCode/unknown_currency,
 *               config.values/duplicate_value, addValues/not_a_picklist,
 *               relabelValues/unknown_value
 *   PERMISSION  `custom_field.write` on the three writes: a TENANT action
 *               (D-L53), the tenant-admin flag only. The list is readable by
 *               every authenticated user of the tenant (T-0091's screens need
 *               labels and types), like listFieldSecurityObjects.
 *
 * ---------------------------------------------------------------------------
 * RULINGS (proposed to the lead; R-numbers are this suite's)
 * ---------------------------------------------------------------------------
 *
 *   R1  `custom` is on Contact (so on every Contact-shaped read, listLeads
 *       included: a lead is a contact, D-P17), Account, Activity and Deal.
 *       Its placement is forced by the suites already merged: Contact's and
 *       Account's own `properties` are each "the live wire's key set" that
 *       the T-0041, T-0055 and T-0054 suites check row by row and column by
 *       column, so `custom` goes into their pending allOf parts; Activity and
 *       Deal are closed (`additionalProperties: false`), which ignores allOf
 *       properties, so `custom` goes into their own `properties`, flagged, as
 *       T-0081 and T-0111 did. Optional until T-0089 serves it, then always
 *       sent (`{}` when the record has no visible value).
 *   R2  Keys are the field_def `api_name`: `^[a-z][a-z0-9_]*__c$` (ADR-0016
 *       item 2, D-P24). `custom` itself is never withheld and never named in
 *       `withheldFields`; a withheld KEY is absent from `custom` and listed
 *       as `custom.<key>`. A retired key is never sent. Values are never
 *       `null` on a read: clearing removes the key.
 *   R3  The six Phase 2 encodings (ADR-0016 item 4), as named schemas, and
 *       CustomFieldValue as their anyOf (several are strings, so oneOf would
 *       refuse every string). text 1..1000 code points, no NUL, `""` refused;
 *       number a canonical decimal STRING (no leading zero, no trailing
 *       fractional zero, no `+`, no exponent, no `-0`, a `.` only between
 *       digits), at most 18 significant digits, never a JSON number; currency
 *       closed `{ amountMinor, currency }`, `amountMinor` an integer string
 *       of at most 18 digits, SIGNED (ADR-0016 says "bigint range", which is
 *       signed; a `-0` is refused), the currency three capitals and equal to
 *       the field's `config.currencyCode` (`currency_mismatch`), never a
 *       float and never a bare `amount`; date a real calendar date; picklist
 *       one value matching the stored `config.values[].value` rule (an api
 *       name); boolean a JSON boolean.
 *   R4  The 32 KiB per-record limit (D-L128 Q1) is a server rule on the
 *       merged result, `400 custom_too_large` at `custom`; 100 keys is also
 *       `maxProperties` on both objects.
 *       AMENDED (T-0089, D-L142 lead edit): the limit callers meet is the
 *       16 KiB caller-visible API limit (D-L140); the database CHECK is a
 *       512 KiB backstop (524288 octets) no live set of keys can reach, and
 *       a backstop refusal is still `400 custom_too_large`. No description
 *       may call 32 KiB the backstop any more.
 *   R5  Create bodies take `custom` too (CustomFields: values only, no
 *       null). T-0091's activity forms create activities with values, and a
 *       create that cannot set them forces a second write.
 *   R6  Update bodies take `custom` as CustomFieldsPatch, a PER-KEY MERGE
 *       (ADR-0016 item 5): a key with a value sets it, `null` removes it, an
 *       absent key is untouched. An empty patch is refused (`minProperties:
 *       1`). Every key must be editable in the ROW's programme, else `403
 *       not_permitted` / `field_not_editable` at `custom.<key>`.
 *   R7  An unknown key and a retired key are one code, `unknown_field`: the
 *       contract does not tell a caller which keys once existed.
 *   R8  Error details carry `path` and `code` and nothing else, and no error
 *       example echoes a value used anywhere in the examples (ADR-0016 item
 *       3: Zod's default messages echo input; the builder replaces them).
 *   R9  Filters (D-L128 Q4): equality on picklist and boolean keys
 *       (`custom[key]=value`, one value per key, `true`/`false` for a
 *       boolean) and `is empty` (`customEmpty=key`), on the SAME two types
 *       (ADR-0016 item 8 is ambiguous on whether `is empty` covers every
 *       type; the narrower reading is taken, widening later is additive).
 *       No range, no text search, no nested operator. A filter on a key
 *       withheld in ANY programme the caller reaches is `400 field_withheld`
 *       (D-L64, D-L82, D-L84, D-L88); on another type `filter_not_supported`;
 *       on an unknown or retired key `unknown_field`.
 *   R10 No sort key on any custom field, in any `sort` enum in the file, and
 *       no other sort or custom-named parameter (D-L128 Q4). Cursors stay
 *       id-only (D-L80).
 *   R11 Admin paths sit beside `/api/v1/admin/field-security/*`: a flat
 *       `/api/v1/admin/custom-fields` collection taking `object` as a query
 *       parameter (as getFieldSecurityMatrix does), an item by `{fieldId}`
 *       (uuid), and `POST …/retire` (as `…/archive`). Tag `custom-fields`.
 *       Screens: list P18/B, create P18/B1, update P18/B2.
 *   R12 There is NO delete (D-L128 Q3): no DELETE method anywhere under the
 *       collection, and no restore. Retiring sets `retiredAt`, keeps the api
 *       name taken for ever (a new field can never reinterpret old values),
 *       drops the key from every read and refuses it on every write; a
 *       repeat retire answers 200 unchanged. AMENDED (lead edit, D-L140,
 *       D-L141): listCustomFields lists ACTIVE fields only, unless
 *       `includeRetired=true` (an optional boolean, default false), which
 *       adds the retired ones with `retiredAt` set, so the studio can show
 *       which names are taken. A retire is audited as `updated` with a
 *       `retiredAt` change: there is no `retired` audit action (D-L141).
 *   R13 The TYPE IS IMMUTABLE (ADR-0016 item 9): UpdateCustomFieldRequest is
 *       closed and holds exactly `label`, `description`, `classification`,
 *       `addValues` and `relabelValues`. No `type`, `apiName`,
 *       `objectApiName`, `config` (so no currency change: one currency per
 *       field, D-L128 Q6), no whole-list `values` and nothing named remove
 *       or delete: picklist values are added or relabelled, never removed.
 *       CLASSIFICATION (the lead overruled this suite's first draft, D-L138):
 *       custom fields stay freely classifiable (D-P25), so `classification`
 *       may be raised or lowered after create, audited by key. Reclassifying
 *       never rewrites the field-security matrix: R17's `none` default for
 *       `pii` and `sensitive` applies at create only.
 *   R14 CustomFieldType is exactly `text`, `number`, `currency`, `date`,
 *       `picklist`, `boolean`. The refused types (`textarea`, `datetime`,
 *       `multipicklist`, `lookup`, `formula`, `rollup`, `phone`, `email`,
 *       `url`) are NOT in the enum, are named in its description as refused,
 *       and a body carrying one is `400 unsupported_type` at `type`.
 *   R15 The create body is closed: `objectApiName`, `apiName`, `label`,
 *       `type` (required), `classification` (`none`, `pii`, `sensitive`;
 *       default `none`), `description`, `config`. `apiName` follows the `__c`
 *       rule within the existing api-name bound (2..63). `config` is one of
 *       `{ values: [CustomFieldPicklistValue, 1..500] }` or
 *       `{ currencyCode }` (three capitals; NGN, GHS, KES or ZAR, else
 *       `unknown_currency`). No `isRequired`: custom fields on standard
 *       objects are never required in Phase 2 (a required field would make
 *       every existing record invalid).
 *   R16 Limits as data: CustomFieldList carries CustomFieldLimits with
 *       `fieldsPerObject: 100`, `picklistValues: 500` and `bytesPerRecord:
 *       32768` (D-L128 Q1). The 101st active field is `409 limit_reached` /
 *       `field_limit_reached`; a picklist pushed past 500 by `addValues` is
 *       `409 limit_reached` / `picklist_limit_reached`. Retired fields do not
 *       count toward the 100 (with no purge, counting them would lock a
 *       tenant out for ever; the 32 KiB cap still bounds the row).
 *       AMENDED (lead edit, D-L140, D-L141): CustomFieldLimits is exactly
 *       `apiBytes` (const 16384, the API's limit on what the caller can see),
 *       `bytesPerRecord` (const 524288 since T-0089 / D-L142, the database
 *       BACKSTOP, 512 KiB; it was 32768),
 *       `definitionsPerObject` (const 500, retired ones included),
 *       `fieldsPerObject` (100) and `picklistValues` (500), all required.
 *       The 500-value picklist limit is reported at `config.values` on
 *       create (`invalid_config`) and at `addValues` on update
 *       (`picklist_limit_reached`).
 *   R17 A field created `pii` or `sensitive` starts at `none` for every
 *       unlocked permission set until an admin grants it (D-L128 Q2); a
 *       `none` field starts at `edit` (D-L45); the locked admin set is
 *       always `edit`. Stated on createCustomField.
 *   R18 Out of scope is ONE 404 body, admin's NotFound, on all four
 *       operations: another tenant's field, a standard field's id, an id
 *       that is not a field, and an object the tenant has no definition for.
 *   R19 Contract first: every new operation, property and parameter is
 *       `x-kasuwa-implemented: false` until T-0089 flips it (with lead edits
 *       to this suite). A list parameter matters most: the live list routes
 *       ignore unknown parameters, so a screen sending `custom[...]` to them
 *       today would get unfiltered rows that look filtered (the D-L75
 *       hazard). T-0091 must not send one while the flag is false.
 *       FLIPPED (T-0089, D-L142 lead edit): T-0089 serves all of it, so
 *       every flag, and the generated admin mock, is now pinned `true`.
 *   R20 D-L97: every example in both files validates; every e2e mock that
 *       reads either file still loads (each validates its own rows at load);
 *       and the generated admin mock is regenerated in the same change.
 *       records-mock, accounts-mock and account-record-mock take a record's
 *       OWN `properties` as its key set and derive rows from the list and
 *       get examples, so the `custom` examples for Contact and Account go on
 *       createContact's and createAccount's 201 (neither mock derives from
 *       those); those three mocks are left unchanged. leads-mock learned the
 *       two filters (lead edit, D-L138).
 *
 * OUT OF SCOPE (a later task): a custom deal field as a stage requirement
 * (`DealRequirementField`, `MoveDealFields`, moveDeal's `fields`). Nothing
 * here admits or refuses it.
 *
 * LEAD EDITS TO MERGED SUITES (D-L138, same branch), each the minimum that
 * admits this contract with every other assertion kept, and each passing both
 * before and after the contract lands: records-contract-pipeline (listDeals
 * parameters and the Deal, createDeal and updateDeal key sets admit `custom` /
 * `customEmpty`), records-contract-activities (UpdateActivityRequest admits
 * `custom`), records/deal-timeline (Activity.withheldFields items may add
 * CustomFieldWithheldPath; the standard enum must survive whole), and
 * leads-mock (the two filters) with its sha256 re-pinned in
 * records-ui/leads-screen.
 *
 * ---------------------------------------------------------------------------
 *
 * D-L23: on main neither file has any of this. Every test then fails naming
 * the missing operation, schema or parameter, rather than crashing at
 * collection: the specs are loaded lazily. Each self-check of a helper first
 * requires the contract piece it guards, so none passes on a file without it.
 * The two regression guards at the end (every OTHER example still validates;
 * every e2e mock still loads) hold on main by design: they protect what
 * exists, and say so where they are written.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const RECORDS_REL = 'docs/api/records.openapi.yaml';
const ADMIN_REL = 'docs/api/admin.openapi.yaml';
const RECORDS = resolve(repoRoot, RECORDS_REL);
const ADMIN = resolve(repoRoot, ADMIN_REL);
const E2E_SUPPORT = resolve(repoRoot, 'tests/e2e/support');

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The text with every run of whitespace collapsed, so a phrase may wrap. */
function prose(text: unknown): string {
  return str(text).replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Loading and $ref resolution (the T-0039 suite's loader, unchanged in kind)
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
      entry = { doc: undefined, error: `${posix(file)} is not valid YAML: ${(error as Error).message}` };
    }
  }
  docCache.set(file, entry);
  return entry;
}

function spec(file: string): Mapping {
  const { doc, error } = loadDoc(file);
  if (error !== null) throw new Error(`${error} — the contract is missing.`);
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
      if (Array.isArray(node)) {
        node = node[Number(key)];
      } else if (isMapping(node) && key in node) {
        node = node[key];
      } else {
        return undefined;
      }
    }
  }
  return node === undefined ? undefined : { node, file };
}

function deref(located: Located): Located {
  let current = located;
  for (let hops = 0; hops < 32; hops += 1) {
    if (!isMapping(current.node) || typeof current.node.$ref !== 'string') return current;
    const ref = current.node.$ref;
    const next = resolveRef(ref, current.file);
    if (next === undefined) throw new Error(`unresolved $ref ${ref} (from ${posix(current.file)})`);
    current = next;
  }
  throw new Error('$ref chain longer than 32 hops (a cycle?)');
}

function at(node: unknown, file: string): Located {
  return deref({ node, file });
}

function child(parent: Located, key: string): Located | undefined {
  if (!isMapping(parent.node) || parent.node[key] === undefined) return undefined;
  return at(parent.node[key], parent.file);
}

function schemaIn(file: string, name: string): Located {
  const components = isMapping(spec(file).components) ? (spec(file).components as Mapping) : {};
  const schemas = isMapping(components.schemas) ? components.schemas : {};
  if (schemas[name] === undefined) throw new Error(`${posix(file)}: components.schemas.${name} not found`);
  return at({ $ref: `#/components/schemas/${name}` }, file);
}

const rec = (name: string): Located => schemaIn(RECORDS, name);
const adm = (name: string): Located => schemaIn(ADMIN, name);

function responseIn(file: string, name: string): Located {
  return at({ $ref: `#/components/responses/${name}` }, file);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

interface Operation {
  id: string;
  method: string;
  path: string;
  op: Mapping;
  params: Located[];
  file: string;
}

function operations(file: string): Operation[] {
  const doc = spec(file);
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
      const params = [...shared, ...own].map((parameter) => at(parameter, file));
      out.push({ id: str(op.operationId), method, path, op, params, file });
    }
  }
  return out;
}

function operation(file: string, id: string): Operation {
  const found = operations(file).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`operationId ${id} not found in ${posix(file)}`);
  return found;
}

const recOp = (id: string): Operation => operation(RECORDS, id);
const admOp = (id: string): Operation => operation(ADMIN, id);

function param(op: Operation, name: string): Located | undefined {
  return op.params.find((candidate) => isMapping(candidate.node) && candidate.node.name === name);
}

function paramSchema(op: Operation, name: string): Located {
  const found = param(op, name);
  if (!found || !isMapping(found.node)) throw new Error(`${op.id} has no parameter ${name}`);
  return at(found.node.schema ?? {}, found.file);
}

function responses(op: Operation): Map<string, Located> {
  const raw = isMapping(op.op.responses) ? op.op.responses : {};
  return new Map(Object.entries(raw).map(([code, value]) => [code, at(value, op.file)]));
}

function jsonMedia(holder: Located | undefined): Located | undefined {
  if (!holder) return undefined;
  const content = child(holder, 'content');
  return content ? child(content, 'application/json') : undefined;
}

function jsonSchema(holder: Located | undefined): Located | undefined {
  const media = jsonMedia(holder);
  return media ? child(media, 'schema') : undefined;
}

function responseSchema(op: Operation, status: string): Located {
  const schema = jsonSchema(responses(op).get(status));
  if (!schema) throw new Error(`${op.id} has no ${status} application/json schema`);
  return schema;
}

function requestBody(op: Operation): Located | undefined {
  return op.op.requestBody === undefined ? undefined : at(op.op.requestBody, op.file);
}

function requestSchema(op: Operation): Located {
  const schema = jsonSchema(requestBody(op));
  if (!schema) throw new Error(`${op.id} has no application/json request schema`);
  return schema;
}

/** Every example value on a media object, `example` and `examples` alike, by label. */
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

function exampleBodies(holder: Located | undefined): Mapping[] {
  return examplesOf(jsonMedia(holder))
    .map(([, value]) => value)
    .filter(isMapping);
}

function description(op: Operation): string {
  return prose(op.op.description);
}

function nodeDescription(located: Located | undefined): string {
  return located && isMapping(located.node) ? prose(located.node.description) : '';
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Own and allOf-merged properties, each dereferenced. */
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

/** The schema's OWN `properties` keys only (not allOf parts). */
function ownKeys(schema: Located): string[] {
  const node = schema.node;
  return isMapping(node) && isMapping(node.properties) ? Object.keys(node.properties).sort() : [];
}

/** The raw (un-dereferenced) property node, own or in an allOf part, so sibling flags are seen. */
function rawProperty(schema: Located, key: string): Mapping | undefined {
  const node = schema.node;
  if (!isMapping(node)) return undefined;
  if (isMapping(node.properties) && isMapping(node.properties[key])) {
    return node.properties[key] as Mapping;
  }
  for (const part of Array.isArray(node.allOf) ? node.allOf : []) {
    const found = rawProperty(at(part, schema.file), key);
    if (found) return found;
  }
  return undefined;
}

/** The allOf part (dereferenced) that declares `key`, if any. */
function allOfPartDeclaring(schema: Located, key: string): Located | undefined {
  const node = schema.node;
  if (!isMapping(node)) return undefined;
  for (const part of Array.isArray(node.allOf) ? node.allOf : []) {
    const located = at(part, schema.file);
    if (ownKeys(located).includes(key)) return located;
  }
  return undefined;
}

function keysOf(schema: Located): string[] {
  return [...properties(schema).keys()].sort();
}

function required(schema: Located): string[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  return Array.isArray(node.required) ? node.required.map(str) : [];
}

function isClosed(schema: Located): boolean {
  return isMapping(schema.node) && schema.node.additionalProperties === false;
}

function enumOf(schema: Located): unknown[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  if (node.const !== undefined && node.const !== null) return [node.const];
  if (Array.isArray(node.enum)) return node.enum.filter((value) => value !== null);
  const items = child(schema, 'items');
  if (items) return enumOf(items);
  for (const key of ['oneOf', 'anyOf']) {
    const variants = node[key];
    if (Array.isArray(variants)) {
      const found = variants.flatMap((variant) => enumOf(at(variant, schema.file)));
      if (found.length > 0) return found;
    }
  }
  return [];
}

/**
 * True when `schema` is the named component, directly, through `$ref`, or
 * through a single-part `allOf` wrapper (the usual way to put a description
 * or a flag beside a `$ref`).
 */
function isSchema(schema: Located | undefined, target: Located): boolean {
  if (!schema) return false;
  const current = deref(schema);
  if (current.node === target.node) return true;
  const node = current.node;
  if (isMapping(node) && Array.isArray(node.allOf) && node.allOf.length === 1) {
    return isSchema(at(node.allOf[0], current.file), target);
  }
  return false;
}

/** The component nodes referenced by a schema's anyOf or oneOf. */
function variantNodes(schema: Located): unknown[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  const variants = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : [];
  return variants.map((variant) => at(variant, schema.file).node);
}

// ---------------------------------------------------------------------------
// A JSON-Schema validator: the subset these contracts use, plus
// propertyNames, patternProperties, additionalProperties-as-schema and
// min/maxProperties, which the custom-field objects need. It is proven to
// reject broken copies before it is trusted.
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    Number(y) >= 1 &&
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function validate(raw: Located, value: unknown, path: string): string[] {
  const schema = deref(raw);
  const node = schema.node;
  if (node === true || (isMapping(node) && Object.keys(node).length === 0)) return [];
  if (node === false) return [`${path}: refused by a false schema`];
  if (!isMapping(node)) return [`${path}: schema is not a mapping`];
  const problems: string[] = [];
  if (Array.isArray(node.allOf)) {
    for (const part of node.allOf) problems.push(...validate(at(part, schema.file), value, path));
  }
  for (const combinator of ['oneOf', 'anyOf'] as const) {
    const variants = node[combinator];
    if (!Array.isArray(variants)) continue;
    const passing = variants.filter(
      (variant) => validate(at(variant, schema.file), value, path).length === 0,
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
    if (typeof node.minLength === 'number' && length < node.minLength) problems.push(`${path}: too short`);
    if (typeof node.maxLength === 'number' && length > node.maxLength) problems.push(`${path}: too long`);
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern, 'u').test(value)) {
      problems.push(`${path}: does not match ${node.pattern}`);
    }
    if (node.format === 'uuid' && !UUID.test(value)) problems.push(`${path}: not a uuid`);
    if (node.format === 'email' && !EMAIL.test(value)) problems.push(`${path}: not an email`);
    if (node.format === 'date-time' && (!UTC_DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) {
      problems.push(`${path}: not a UTC date-time with a Z`);
    }
    if (node.format === 'date' && !isCalendarDate(value)) {
      problems.push(`${path}: not a calendar date YYYY-MM-DD`);
    }
  }
  if (typeof value === 'number') {
    if (typeof node.minimum === 'number' && value < node.minimum) problems.push(`${path}: < min`);
    if (typeof node.maximum === 'number' && value > node.maximum) problems.push(`${path}: > max`);
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === 'number' && value.length < node.minItems) problems.push(`${path}: too few items`);
    if (typeof node.maxItems === 'number' && value.length > node.maxItems) problems.push(`${path}: too many items`);
    if (node.uniqueItems === true) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) problems.push(`${path}: items are not unique`);
    }
    const items = child(schema, 'items');
    if (items) value.forEach((item, index) => problems.push(...validate(items, item, `${path}[${index}]`)));
  }
  if (isMapping(value)) {
    const keys = Object.keys(value);
    if (typeof node.minProperties === 'number' && keys.length < node.minProperties) {
      problems.push(`${path}: fewer than ${node.minProperties} properties`);
    }
    if (typeof node.maxProperties === 'number' && keys.length > node.maxProperties) {
      problems.push(`${path}: more than ${node.maxProperties} properties`);
    }
    const props = isMapping(node.properties) ? node.properties : {};
    const patterns = isMapping(node.patternProperties) ? node.patternProperties : {};
    for (const key of Array.isArray(node.required) ? node.required.map(str) : []) {
      if (!(key in value)) problems.push(`${path}: ${key} is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (node.propertyNames !== undefined) {
        problems.push(...validate(at(node.propertyNames, schema.file), key, `${path} key ${JSON.stringify(key)}`));
      }
      const matching = Object.keys(patterns).filter((pattern) => new RegExp(pattern, 'u').test(key));
      for (const pattern of matching) {
        problems.push(...validate(at(patterns[pattern], schema.file), item, `${path}.${key}`));
      }
      if (props[key] !== undefined) {
        problems.push(...validate(at(props[key], schema.file), item, `${path}.${key}`));
      } else if (matching.length === 0) {
        if (node.additionalProperties === false) {
          problems.push(`${path}: ${key} is not a property of this closed object`);
        } else if (isMapping(node.additionalProperties)) {
          problems.push(...validate(at(node.additionalProperties, schema.file), item, `${path}.${key}`));
        }
      }
    }
  }
  return problems;
}

const accepts = (schema: Located, value: unknown): boolean => validate(schema, value, 'v').length === 0;

/** Cases a schema got wrong: accepted refusals and refused acceptances, labelled. */
function caseProblems(schema: Located, good: unknown[], bad: unknown[], wrap: (v: unknown) => unknown = (v) => v): string[] {
  const out: string[] = [];
  for (const value of good) {
    const problems = validate(schema, wrap(value), 'v');
    if (problems.length > 0) out.push(`refused ${JSON.stringify(value)}: ${problems.join('; ')}`);
  }
  for (const value of bad) {
    if (accepts(schema, wrap(value))) out.push(`accepted ${JSON.stringify(value)}`);
  }
  return out;
}

/** A free-standing schema (for self-checks), located in the records file. */
function synthetic(node: Mapping): Located {
  return { node, file: RECORDS };
}

// ---------------------------------------------------------------------------
// Fixed cases (R2, R3, R9, R15). Every value is invented.
// ---------------------------------------------------------------------------

const GOOD_KEYS = ['tier__c', 'loan_product__c', 'a__c', 'x1__c', 'nps_2026__c', `a${'b'.repeat(59)}__c`];
const BAD_KEYS = [
  'tier',
  'Tier__c',
  'tier__C',
  '_tier__c',
  '1tier__c',
  'tier-x__c',
  '__c',
  'tier_c',
  'tier__cx',
  'tier__c__d',
  'tier__c ',
  ' tier__c',
  'tier.x__c',
  'téir__c',
  'tier__c\n',
  'custom',
  '',
];
/** Weaker key rules the cases must each catch (self-check). */
const WEAKER_KEY_PATTERNS = [
  '__c$',
  '^[a-z][a-z0-9_]*__c',
  '^[a-zA-Z][a-zA-Z0-9_]*__c$',
  '^[a-z][a-z0-9_.-]*__c$',
  '^[a-z0-9_]+__c$',
  '^[a-z][a-z0-9_]*(__c)?$',
];

const GOOD_WITHHELD_PATHS = ['custom.tier__c', 'custom.loan_product__c'];
const BAD_WITHHELD_PATHS = ['custom', 'custom.', 'custom.tier', 'tier__c', 'Custom.tier__c', 'custom.Tier__c', 'custom.tier__c.x', 'custom..tier__c', 'customtier__c'];

const NUL = String.fromCharCode(0);
// Whether `text` admits a line break is not pinned: `textarea` is a refused type, and that line
// is the builder's to draw (and report), not this suite's.
const GOOD_TEXT = ['a', 'Sample note', 'Ọ̀rọ̀ àpẹẹrẹ', 'x'.repeat(1000)];
const BAD_TEXT = ['', 'x'.repeat(1001), `a${NUL}b`, NUL, 12, true, null, {}, ['a']];

const GOOD_NUMBERS = ['0', '42', '-42', '1.5', '12.5', '-0.75', '0.001', '123456789012345678', '-123456789012345678', '12345678901234567.8'];
const BAD_NUMBERS = [
  12.5,
  42,
  0,
  '',
  '01',
  '+1',
  '1.',
  '.5',
  '1.50',
  '1.0',
  '0.0',
  '-0',
  '-0.0',
  '1e5',
  '1E5',
  '1,000',
  ' 1',
  '1 ',
  'NaN',
  'Infinity',
  '0x1F',
  '١٢',
  '1234567890123456789',
  '-1234567890123456789',
  '123456789012345678.9',
  null,
  true,
];
/** Weaker number rules the cases must each catch (self-check). */
const WEAKER_NUMBER_PATTERNS = [
  '^-?[0-9]+(\\.[0-9]+)?$',
  '^-?(0|[1-9][0-9]*)(\\.[0-9]*[1-9])?$',
  '^-?(0|[1-9][0-9]{0,17})(\\.[0-9]*[1-9])?$',
  '^-?[0-9.]{1,19}$',
];

const money = (amountMinor: unknown, currency: unknown = 'NGN'): Mapping => ({ amountMinor, currency });
const GOOD_CURRENCY = [money('0'), money('150000', 'GHS'), money('-2500', 'KES'), money('123456789012345678', 'ZAR')];
const BAD_CURRENCY = [
  money(150000),
  money(1500.5),
  money('1500.00'),
  money('01'),
  money('-0'),
  money('1e3'),
  money(' 100'),
  money('1234567890123456789'),
  money('100', 'ngn'),
  money('100', 'NG'),
  money('100', 'NGNX'),
  money('100', 42),
  { amount: '100', currency: 'NGN' },
  { amount: 100, currency: 'NGN' },
  { amountMinor: '100' },
  { currency: 'NGN' },
  { amountMinor: '100', currency: 'NGN', symbol: 'N' },
  '100',
  100,
  null,
];

const GOOD_DATES = ['2026-10-17', '2024-02-29', '1999-12-31'];
const BAD_DATES = ['2026-02-29', '2026-13-01', '2026-00-10', '2026-10-17T00:00:00Z', '17/10/2026', '2026-1-7', '0000-01-01', '', 20261017, null];

const GOOD_PICKLIST = ['gold', 'tier_one', 'a1', 'ab'];
const BAD_PICKLIST = ['Gold', 'gold tier', 'gold-tier', '1gold', 'gold_', 'g', '', 'x'.repeat(64), 1, true, null];

const GOOD_BOOLEANS = [true, false];
const BAD_BOOLEANS = ['true', 'false', 1, 0, null];

/** CustomFieldValue: the union of the six. */
const GOOD_VALUES = ['gold', 'Sample note', '12.5', '2026-10-17', true, false, money('150000')];
const BAD_VALUES = [12.5, 12, null, '', [], ['gold'], { amount: 100, currency: 'NGN' }, money(100), `a${NUL}`, {}];

const GOOD_API_NAMES = ['tier__c', 'loan_product__c', 'ab__c', `a${'b'.repeat(59)}__c`];
const BAD_API_NAMES = [...BAD_KEYS, `a${'b'.repeat(60)}__c`];

const SIX_TYPES = ['boolean', 'currency', 'date', 'number', 'picklist', 'text'];
const REFUSED_TYPES = ['textarea', 'datetime', 'multipicklist', 'lookup', 'formula', 'rollup', 'phone', 'email', 'url'];
const OBJECTS = ['account', 'activity', 'contact', 'deal'];
const CLASSIFICATIONS = ['none', 'pii', 'sensitive'];

/** The five record shapes and where `custom` sits on each (R1). */
const RECORD_SCHEMAS = ['Contact', 'Account', 'Activity', 'Deal'];
const CREATE_BODIES = ['CreateContactRequest', 'CreateAccountRequest', 'CreateActivityRequest', 'CreateDealRequest'];
const UPDATE_BODIES = ['UpdateContactRequest', 'UpdateAccountRequest', 'UpdateActivityRequest', 'UpdateDealRequest'];
const CREATE_OPS = ['createContact', 'createAccount', 'createActivity', 'createDeal'];
const UPDATE_OPS = ['updateContact', 'updateAccount', 'updateActivity', 'updateDeal'];
const LIST_OPS = ['listContacts', 'listLeads', 'listAccounts', 'listDeals'];

const ADMIN_BASE = '/api/v1/admin/custom-fields';
const ADMIN_OPS: [string, string, string][] = [
  ['listCustomFields', 'get', ADMIN_BASE],
  ['createCustomField', 'post', ADMIN_BASE],
  ['updateCustomField', 'patch', `${ADMIN_BASE}/{fieldId}`],
  ['retireCustomField', 'post', `${ADMIN_BASE}/{fieldId}/retire`],
];
const ADMIN_WRITES = ['createCustomField', 'updateCustomField', 'retireCustomField'];
const ADMIN_SCREENS: Record<string, string> = {
  listCustomFields: 'P18/B',
  createCustomField: 'P18/B1',
  updateCustomField: 'P18/B2',
};

const CREATE_KEYS = ['apiName', 'classification', 'config', 'description', 'label', 'objectApiName', 'type'];
const CREATE_REQUIRED = ['apiName', 'label', 'objectApiName', 'type'];
const UPDATE_KEYS = ['addValues', 'classification', 'description', 'label', 'relabelValues'];
const DEFINITION_KEYS = ['apiName', 'classification', 'config', 'createdAt', 'description', 'id', 'label', 'objectApiName', 'retiredAt', 'type', 'updatedAt'];

/** R7/R9: `path code` details the record write and list 400 examples must show. */
const KEY_PATH = /^custom\.[a-z][a-z0-9_]*__c$/;
const WRITE_400_CODES = ['invalid_value', 'unknown_value', 'currency_mismatch', 'custom_too_large', 'unknown_field'];
const LIST_400_CODES = ['field_withheld', 'filter_not_supported', 'unknown_field'];
/** R15/R16: admin `path code` details. */
const ADMIN_400_DETAILS = [
  'addValues not_a_picklist',
  'apiName invalid_api_name',
  'config invalid_config',
  'config.currencyCode unknown_currency',
  'config.values duplicate_value',
  'relabelValues unknown_value',
  'type unsupported_type',
];
const ADMIN_409_DETAILS = [
  'duplicate_code apiName duplicate',
  'limit_reached addValues picklist_limit_reached',
  'limit_reached objectApiName field_limit_reached',
];

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function customOf(schemaName: string): Located {
  const found = properties(rec(schemaName)).get('custom');
  if (!found) throw new Error(`${schemaName} has no custom property`);
  return found;
}

function detailsOf(body: Mapping): Mapping[] {
  return Array.isArray(body.details) ? body.details.filter(isMapping) : [];
}

function detailPairs(bodies: Mapping[]): string[] {
  return bodies.flatMap((body) => detailsOf(body).map((detail) => `${str(detail.path)} ${str(detail.code)}`));
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (isMapping(value)) return Object.values(value).flatMap(stringsIn);
  return [];
}

/**
 * Every sub-value of `value` that `schema` validates with one of the target
 * nodes, walking `$ref`, allOf, the matching oneOf/anyOf branches, items and
 * properties in step with the value.
 */
function instancesOf(schema: Located, value: unknown, targets: Map<unknown, string>, out: [string, Mapping][], seen = 0): void {
  if (seen > 64) return;
  const current = deref(schema);
  const node = current.node;
  if (!isMapping(node)) return;
  const name = targets.get(node);
  if (name !== undefined && isMapping(value)) out.push([name, value]);
  for (const part of Array.isArray(node.allOf) ? node.allOf : []) instancesOf(at(part, current.file), value, targets, out, seen + 1);
  for (const key of ['oneOf', 'anyOf']) {
    const variants = node[key];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      const located = at(variant, current.file);
      if (accepts(located, value)) instancesOf(located, value, targets, out, seen + 1);
    }
  }
  if (Array.isArray(value)) {
    const items = child(current, 'items');
    if (items) for (const item of value) instancesOf(items, item, targets, out, seen + 1);
  }
  if (isMapping(value) && isMapping(node.properties)) {
    for (const [key, item] of Object.entries(value)) {
      const prop = child(current, 'properties');
      const sub = prop ? child(prop, key) : undefined;
      if (sub) instancesOf(sub, item, targets, out, seen + 1);
    }
  }
}

/** Every example in a file paired with its schema: request bodies and responses. */
function allExamples(file: string): { label: string; schema: Located | undefined; value: unknown; op: Operation; status: string }[] {
  const out: { label: string; schema: Located | undefined; value: unknown; op: Operation; status: string }[] = [];
  for (const op of operations(file)) {
    const body = requestBody(op);
    for (const [label, value] of examplesOf(jsonMedia(body))) {
      out.push({ label: `${op.id} request ${label}`, schema: jsonSchema(body), value, op, status: 'request' });
    }
    for (const [status, response] of responses(op)) {
      for (const [label, value] of examplesOf(jsonMedia(response))) {
        out.push({ label: `${op.id} ${status} ${label}`, schema: jsonSchema(response), value, op, status });
      }
    }
  }
  return out;
}

/** Record instances (by record schema name) in every records example. */
function recordInstances(): { op: Operation; type: string; value: Mapping; label: string }[] {
  const targets = new Map<unknown, string>(RECORD_SCHEMAS.map((name) => [rec(name).node, name]));
  const out: { op: Operation; type: string; value: Mapping; label: string }[] = [];
  for (const example of allExamples(RECORDS)) {
    if (!example.schema || example.status === 'request') continue;
    const found: [string, Mapping][] = [];
    instancesOf(example.schema, example.value, targets, found);
    for (const [type, value] of found) out.push({ op: example.op, type, value, label: example.label });
  }
  return out;
}

function withheldOf(record: Mapping): string[] {
  return Array.isArray(record.withheldFields) ? record.withheldFields.map(str) : [];
}

/** R2, on data: what a record instance gets wrong about `custom`; empty when right. */
function customExampleProblems(label: string, record: Mapping): string[] {
  const problems: string[] = [];
  const withheld = withheldOf(record);
  if (withheld.includes('custom')) problems.push(`${label}: custom itself is listed as withheld`);
  const custom = record.custom;
  if (custom !== undefined && !isMapping(custom)) problems.push(`${label}: custom is not an object`);
  const values = isMapping(custom) ? custom : {};
  for (const [key, value] of Object.entries(values)) {
    if (value === null) problems.push(`${label}: custom.${key} is null on a read`);
    if (withheld.includes(`custom.${key}`)) problems.push(`${label}: custom.${key} is withheld but present`);
  }
  for (const name of withheld.filter((entry) => entry.startsWith('custom.'))) {
    if (!KEY_PATH.test(name)) problems.push(`${label}: ${name} is not a custom.<key> path`);
  }
  return problems;
}

/** Every value used in a `custom` object, or as a definition's label, api name or picklist value, in any example. */
function exampleValues(): string[] {
  const out = new Set<string>();
  const collectCustom = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collectCustom);
    if (!isMapping(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'custom' && isMapping(item)) {
        for (const leaf of stringsIn(item)) out.add(leaf);
      } else {
        collectCustom(item);
      }
    }
  };
  for (const example of allExamples(RECORDS)) collectCustom(example.value);
  for (const example of allExamples(ADMIN)) {
    if (!example.op.path.startsWith(ADMIN_BASE)) continue;
    if (example.status !== 'request' && !example.status.startsWith('2')) continue;
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      if (!isMapping(value)) return;
      for (const key of ['apiName', 'label']) if (typeof value[key] === 'string') out.add(value[key] as string);
      if (typeof value.value === 'string') out.add(value.value);
      Object.values(value).forEach(walk);
    };
    walk(example.value);
  }
  return [...out].filter((value) => [...value].length >= 3 && !/^(true|false|NGN|GHS|KES|ZAR)$/.test(value));
}

/** R8: what an error example gets wrong: extra detail keys or an echoed value; empty when right. */
function echoProblems(label: string, body: Mapping, values: string[]): string[] {
  const problems: string[] = [];
  for (const detail of detailsOf(body)) {
    const keys = Object.keys(detail).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['code', 'path'])) {
      problems.push(`${label}: a detail carries ${keys.join(', ')}, not path and code only`);
    }
    for (const segment of str(detail.path).split('.')) {
      // A key (an api name, `…__c`) belongs in a path; a value never does.
      if (!/__c$/.test(segment) && values.includes(segment)) problems.push(`${label}: the path names the value ${segment}`);
    }
    for (const [key, item] of Object.entries(detail)) {
      if (key === 'path') continue;
      for (const text of stringsIn(item)) {
        for (const value of values) if (text.includes(value)) problems.push(`${label}: detail ${key} echoes ${value}`);
      }
    }
  }
  for (const [key, item] of Object.entries(body)) {
    if (key === 'details') continue;
    for (const text of stringsIn(item)) {
      for (const value of values) if (text.includes(value)) problems.push(`${label}: ${key} echoes ${value}`);
    }
  }
  return problems;
}

/** The error bodies a custom-field caller can receive, labelled. */
function customErrorBodies(): [string, Mapping][] {
  const out: [string, Mapping][] = [];
  const add = (op: Operation, status: string): void => {
    for (const body of exampleBodies(responses(op).get(status))) out.push([`${op.id} ${status}`, body]);
  };
  for (const id of [...CREATE_OPS, ...UPDATE_OPS]) {
    add(recOp(id), '400');
    add(recOp(id), '403');
  }
  for (const id of LIST_OPS) add(recOp(id), '400');
  for (const [id] of ADMIN_OPS) for (const status of ['400', '403', '404', '409']) add(admOp(id), status);
  return out;
}

/** The custom-field operations of both files, or a failure naming the first missing: a gate. */
function gate(): void {
  for (const [id] of ADMIN_OPS) admOp(id);
  rec('CustomFields');
  rec('CustomFieldsPatch');
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe('acceptance: custom-field contract (T-0088)', () => {
  describe('records: the six value encodings (R3)', () => {
    it('CustomFieldText: 1..1000 characters, no NUL; "" refused; never a number, boolean or null', () => {
      expect(caseProblems(rec('CustomFieldText'), GOOD_TEXT, BAD_TEXT)).toEqual([]);
    });

    it('CustomFieldNumber: a canonical decimal string of at most 18 significant digits, never a JSON number', () => {
      expect(caseProblems(rec('CustomFieldNumber'), GOOD_NUMBERS, BAD_NUMBERS)).toEqual([]);
    });

    it('(self-check, R3) a looser number rule is caught by the cases', () => {
      rec('CustomFieldNumber');
      for (const pattern of WEAKER_NUMBER_PATTERNS) {
        const weak = synthetic({ type: 'string', pattern });
        expect(caseProblems(weak, GOOD_NUMBERS, BAD_NUMBERS).length, pattern).toBeGreaterThan(0);
      }
    });

    it('CustomFieldCurrency: closed { amountMinor: signed integer string, at most 18 digits; currency: three capitals }, never a float, never a bare amount', () => {
      const currency = rec('CustomFieldCurrency');
      expect(isClosed(currency), 'closed').toBe(true);
      expect(keysOf(currency)).toEqual(['amountMinor', 'currency']);
      expect(required(currency).sort()).toEqual(['amountMinor', 'currency']);
      expect(caseProblems(currency, GOOD_CURRENCY, BAD_CURRENCY)).toEqual([]);
    });

    it('CustomFieldCurrency says the currency must be the field’s currencyCode, one per field, never converted (D-L128 Q6)', () => {
      const text = nodeDescription(rec('CustomFieldCurrency'));
      expect(text).toMatch(/`currencyCode`/);
      expect(text).toMatch(/currency_mismatch/);
      expect(text).toMatch(/never converted/i);
    });

    it('CustomFieldDate: a real calendar date, YYYY-MM-DD, no time and no zone', () => {
      expect(caseProblems(rec('CustomFieldDate'), GOOD_DATES, BAD_DATES)).toEqual([]);
    });

    it('CustomFieldPicklist: one value, an api name like the stored config.values[].value', () => {
      expect(caseProblems(rec('CustomFieldPicklist'), GOOD_PICKLIST, BAD_PICKLIST)).toEqual([]);
    });

    it('CustomFieldBoolean: a JSON boolean, never the string', () => {
      expect(caseProblems(rec('CustomFieldBoolean'), GOOD_BOOLEANS, BAD_BOOLEANS)).toEqual([]);
    });

    it('CustomFieldValue is the anyOf of exactly the six named encodings, and admits each of them', () => {
      const value = rec('CustomFieldValue');
      const names = ['CustomFieldText', 'CustomFieldNumber', 'CustomFieldCurrency', 'CustomFieldDate', 'CustomFieldPicklist', 'CustomFieldBoolean'];
      const expected = names.map((name) => rec(name).node);
      const got = variantNodes(value);
      expect(got.length, 'six variants').toBe(6);
      expect(expected.every((node) => got.includes(node)), 'each of the six named schemas').toBe(true);
      expect(caseProblems(value, GOOD_VALUES, BAD_VALUES)).toEqual([]);
    });
  });

  describe('records: custom on the record shapes (R1, R2, R4)', () => {
    it('CustomFields: keys follow the __c rule, values are CustomFieldValue never null, at most 100 keys', () => {
      const custom = rec('CustomFields');
      expect(caseProblems(custom, GOOD_KEYS, BAD_KEYS, (key) => ({ [String(key)]: true }))).toEqual([]);
      const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`field_${i}__c`, true]));
      const hundred = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field_${i}__c`, true]));
      expect(caseProblems(custom, [{}, { tier__c: 'gold', vip__c: true, limit__c: money('150000') }, hundred], [
        { tier__c: null },
        { tier__c: 12 },
        { tier__c: '' },
        { tier__c: { amount: '100', currency: 'NGN' } },
        many,
        [],
        'x',
        null,
      ])).toEqual([]);
    });

    it('(self-check, R2) a looser key rule is caught by the cases', () => {
      rec('CustomFields');
      for (const pattern of WEAKER_KEY_PATTERNS) {
        const weak = synthetic({ type: 'object', propertyNames: { type: 'string', pattern } });
        expect(caseProblems(weak, GOOD_KEYS, BAD_KEYS, (key) => ({ [String(key)]: true })).length, pattern).toBeGreaterThan(0);
      }
    });

    // T-0089 / D-L142 (lead edit): the limit a caller meets is 16 KiB; the backstop is 512 KiB.
    it('CustomFields documents the withheld rule, the 16 KiB limit, the 512 KiB backstop and custom_too_large (R2, R4)', () => {
      const text = nodeDescription(rec('CustomFields'));
      expect(text).toMatch(/`custom\.<key>`/);
      expect(text).toMatch(/`withheldFields`/);
      expect(text).toMatch(/16 KiB/);
      expect(text).toMatch(/512 KiB/);
      expect(text, 'still calls 32 KiB the backstop').not.toMatch(/32 KiB[^.]*backstop|backstop[^.]*32 KiB/i);
      expect(text).toMatch(/custom_too_large/);
      expect(text).toMatch(/retired/i);
    });

    for (const name of RECORD_SCHEMAS) {
      it(`${name}.custom is CustomFields: an object, optional until T-0089 serves it`, () => {
        const custom = customOf(name);
        expect(isSchema(custom, rec('CustomFields')), `${name}.custom resolves to CustomFields`).toBe(true);
        // Optional for now: the live routes do not send it, and the merged API suites check every
        // row against this schema. T-0089 makes it always sent (lead edit to this pin).
        const holder = name === 'Contact' ? rec('ContactPendingProperties') : name === 'Account' ? rec('AccountPendingProperties') : rec(name);
        expect(required(holder), `${name}: custom is not required yet`).not.toContain('custom');
        expect(required(rec(name)), `${name}: custom is not required yet`).not.toContain('custom');
      });
    }

    it('placement (R1): Contact in ContactPendingProperties, Account in AccountPendingProperties, Activity and Deal in their own properties', () => {
      const contact = rec('Contact');
      expect(ownKeys(contact), 'Contact.properties is the live wire set').not.toContain('custom');
      expect(allOfPartDeclaring(contact, 'custom')?.node, 'Contact: in ContactPendingProperties').toBe(rec('ContactPendingProperties').node);
      const account = rec('Account');
      expect(ownKeys(account), 'Account.properties is the live wire set (T-0054 maps it to columns)').not.toContain('custom');
      expect(allOfPartDeclaring(account, 'custom')?.node, 'Account: in AccountPendingProperties').toBe(rec('AccountPendingProperties').node);
      for (const name of ['Activity', 'Deal']) {
        expect(isClosed(rec(name)), `${name} stays closed`).toBe(true);
        expect(ownKeys(rec(name)), `${name}: closed, so custom is an own property`).toContain('custom');
      }
    });

    it('listLeads rows are Contact rows, so a lead carries custom too (D-P17)', () => {
      const page = responseSchema(recOp('listLeads'), '200');
      const data = properties(page).get('data');
      const items = data ? child(data, 'items') : undefined;
      expect(items?.node, 'listLeads rows are Contact').toBe(rec('Contact').node);
      expect(properties(rec('Contact')).has('custom'), 'Contact carries custom').toBe(true);
    });

    it('CustomFieldWithheldPath admits custom.<key> and nothing else', () => {
      expect(caseProblems(rec('CustomFieldWithheldPath'), GOOD_WITHHELD_PATHS, BAD_WITHHELD_PATHS)).toEqual([]);
    });

    for (const name of RECORD_SCHEMAS) {
      it(`${name}.withheldFields admits custom.<key> paths${name === 'Activity' || name === 'Deal' ? ', and still refuses anything that is not a field or a custom path' : ''}`, () => {
        // Contact's and Account's items are any string today, so the acceptance alone would hold on
        // main; it is only meaningful on a record that carries `custom`, which is required first.
        customOf(name);
        const withheld = properties(rec(name)).get('withheldFields');
        if (!withheld) throw new Error(`${name} has no withheldFields`);
        expect(accepts(withheld, GOOD_WITHHELD_PATHS), 'custom paths').toBe(true);
        if (name === 'Activity' || name === 'Deal') {
          const items = child(withheld, 'items');
          if (!items) throw new Error(`${name}.withheldFields has no items`);
          expect(variantNodes(items).includes(rec('CustomFieldWithheldPath').node), 'items reference CustomFieldWithheldPath').toBe(true);
          for (const bad of ['custom', 'custom.tier', 'nonsense', 'custom.Tier__c']) {
            expect(accepts(withheld, [bad]), `${name} accepted ${bad}`).toBe(false);
          }
        }
      });
    }

    it('custom is never itself withheld; a withheld key is absent and listed as custom.<key> (prose, R2)', () => {
      for (const name of RECORD_SCHEMAS) {
        const raw = rawProperty(rec(name), 'custom');
        const text = prose(raw?.description) + ' ' + nodeDescription(rec('CustomFields'));
        expect(text, name).toMatch(/never (itself )?withheld|is never named in `withheldFields`/i);
      }
    });
  });

  describe('records: writes merge per key (R5, R6)', () => {
    it('CustomFieldsPatch: the same keys, a value or null, 1..100 keys', () => {
      const patch = rec('CustomFieldsPatch');
      expect(caseProblems(patch, GOOD_KEYS, BAD_KEYS, (key) => ({ [String(key)]: null }))).toEqual([]);
      const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`field_${i}__c`, null]));
      expect(caseProblems(patch, [{ tier__c: null }, { tier__c: 'gold', vip__c: null, limit__c: money('-2500') }], [
        {},
        { tier__c: '' },
        { tier__c: 1.5 },
        { tier__c: money(100) },
        { tier: null },
        many,
      ])).toEqual([]);
    });

    it('CustomFieldsPatch says: per-key merge, null removes, absent untouched, editable in the row’s programme', () => {
      const text = nodeDescription(rec('CustomFieldsPatch'));
      expect(text).toMatch(/per key|per-key/i);
      expect(text).toMatch(/`null`/);
      expect(text).toMatch(/untouched|unchanged/i);
      expect(text).toMatch(/row's programme|record's programme/i);
      expect(text).toMatch(/field_not_editable/);
      expect(text).toMatch(/unknown_field/);
    });

    for (const name of UPDATE_BODIES) {
      it(`${name}.custom is CustomFieldsPatch, and the body stays closed`, () => {
        const body = rec(name);
        expect(isSchema(properties(body).get('custom'), rec('CustomFieldsPatch'))).toBe(true);
        expect(isClosed(body)).toBe(true);
      });
    }

    for (const name of CREATE_BODIES) {
      it(`${name}.custom is CustomFields (values only, no null), and the body stays closed`, () => {
        const body = rec(name);
        expect(isSchema(properties(body).get('custom'), rec('CustomFields'))).toBe(true);
        expect(isClosed(body)).toBe(true);
        expect(required(body)).not.toContain('custom');
      });
    }

    it('each update operation documents custom', () => {
      for (const id of UPDATE_OPS) expect(description(recOp(id)), id).toMatch(/`custom`/);
    });
  });

  describe('records: errors (R7, R8)', () => {
    for (const id of [...CREATE_OPS, ...UPDATE_OPS]) {
      it(`${id}: a 400 example shows unknown_field at custom.<key>; a 403 example not_permitted / field_not_editable at custom.<key>`, () => {
        const op = recOp(id);
        const bad = exampleBodies(responses(op).get('400'));
        expect(bad.some((body) => body.code === 'validation_failed' && detailsOf(body).some((d) => d.code === 'unknown_field' && KEY_PATH.test(str(d.path)))), '400 unknown_field').toBe(true);
        const forbidden = exampleBodies(responses(op).get('403'));
        expect(forbidden.some((body) => body.code === 'not_permitted' && detailsOf(body).some((d) => d.code === 'field_not_editable' && KEY_PATH.test(str(d.path)))), '403 field_not_editable').toBe(true);
      });
    }

    it('the write 400 examples, together, show every value code at its path (R3, R4, R7)', () => {
      const pairs = UPDATE_OPS.flatMap((id) => detailPairs(exampleBodies(responses(recOp(id)).get('400'))));
      const missing: string[] = [];
      const has = (code: string, path: RegExp): boolean => pairs.some((pair) => {
        const [p, c] = pair.split(' ');
        return c === code && path.test(p ?? '');
      });
      for (const code of ['invalid_value', 'unknown_value', 'unknown_field']) if (!has(code, KEY_PATH)) missing.push(code);
      if (!has('currency_mismatch', /^custom\.[a-z][a-z0-9_]*__c\.currency$/)) missing.push('currency_mismatch');
      if (!has('custom_too_large', /^custom$/)) missing.push('custom_too_large');
      expect(missing).toEqual([]);
      expect(WRITE_400_CODES.length).toBe(5);
    });

    it('no error a custom-field caller can receive carries more than path and code, or echoes a value from any example (R8)', () => {
      gate();
      const values = exampleValues();
      expect(values.length, 'no example values to compare with').toBeGreaterThanOrEqual(5);
      const problems: string[] = [];
      let checked = 0;
      for (const [label, body] of customErrorBodies()) {
        checked += 1;
        problems.push(...echoProblems(label, body, values));
      }
      expect(problems).toEqual([]);
      expect(checked).toBeGreaterThan(10);
    });

    it('(self-check, R8) an echoed value, a received-value detail or a value in the path is caught', () => {
      gate();
      const values = exampleValues();
      const [value] = values;
      if (value === undefined) throw new Error('no example values');
      const base: Mapping = { statusCode: 400, error: 'Bad Request', code: 'validation_failed', message: 'Validation failed', details: [{ path: 'custom.tier__c', code: 'invalid_value' }] };
      expect(echoProblems('base', base, values)).toEqual([]);
      const plants: [string, Mapping][] = [
        ['message', { ...base, message: `Validation failed: ${value}` }],
        ['received', { ...base, details: [{ path: 'custom.tier__c', code: 'invalid_value', received: value }] }],
        ['path', { ...base, details: [{ path: `custom.tier__c.${value}`, code: 'unknown_value' }] }],
      ];
      for (const [label, body] of plants) expect(echoProblems(label, body, values), label).not.toEqual([]);
    });
  });

  describe('records: filters, never a sort (R9, R10)', () => {
    for (const id of LIST_OPS) {
      it(`${id}: query custom (deepObject) and customEmpty, the one shared definition of each`, () => {
        const op = recOp(id);
        const custom = param(op, 'custom');
        const empty = param(op, 'customEmpty');
        if (!custom || !isMapping(custom.node)) throw new Error(`${id} has no custom parameter`);
        if (!empty || !isMapping(empty.node)) throw new Error(`${id} has no customEmpty parameter`);
        expect([custom.node.in, custom.node.style, custom.node.explode]).toEqual(['query', 'deepObject', true]);
        expect(empty.node.in).toBe('query');
        const first = recOp(LIST_OPS[0] ?? '');
        expect(custom.node, 'one shared custom parameter').toBe(param(first, 'custom')?.node);
        expect(empty.node, 'one shared customEmpty parameter').toBe(param(first, 'customEmpty')?.node);
      });
    }

    it('custom: equality only, one api-name value per key (true/false for a boolean); no operator, list or text', () => {
      const schema = paramSchema(recOp('listContacts'), 'custom');
      expect(caseProblems(schema, [{ tier__c: 'gold' }, { vip__c: 'true' }, { vip__c: 'false', tier__c: 'gold' }], [
        { tier: 'gold' },
        { tier__c: '' },
        { tier__c: 'Gold Tier' },
        { tier__c: 'gold silver' },
        { tier__c: { gte: '5' } },
        { tier__c: ['gold', 'silver'] },
        { 'Tier__c': 'gold' },
      ])).toEqual([]);
    });

    it('customEmpty: a unique list of custom keys', () => {
      const schema = paramSchema(recOp('listContacts'), 'customEmpty');
      expect(caseProblems(schema, [['tier__c'], ['tier__c', 'vip__c']], [['tier'], ['tier__c', 'tier__c'], [''], ['custom.tier__c']])).toEqual([]);
    });

    it('the filter prose: picklist and boolean only, for both; field_withheld anywhere reachable; filter_not_supported; unknown_field', () => {
      const op = recOp('listContacts');
      const custom = nodeDescription(param(op, 'custom'));
      const empty = nodeDescription(param(op, 'customEmpty'));
      for (const [label, text] of [['custom', custom], ['customEmpty', empty]] as const) {
        expect(text, label).toMatch(/picklist/);
        expect(text, label).toMatch(/boolean/);
      }
      expect(custom).toMatch(/field_withheld/);
      expect(custom).toMatch(/any programme/i);
      expect(custom).toMatch(/filter_not_supported/);
      expect(custom).toMatch(/unknown_field/);
    });

    for (const id of LIST_OPS) {
      it(`${id}: the 400 examples show field_withheld, filter_not_supported and unknown_field at custom.<key>`, () => {
        const pairs = detailPairs(exampleBodies(responses(recOp(id)).get('400')));
        const missing = LIST_400_CODES.filter((code) => !pairs.some((pair) => {
          const [p, c] = pair.split(' ');
          return c === code && KEY_PATH.test(p ?? '');
        }));
        expect(missing).toEqual([]);
      });
    }

    it('no sort key names a custom field, anywhere in the file; no other sort, order or custom-named parameter', () => {
      gate();
      const problems: string[] = [];
      let sorts = 0;
      for (const op of operations(RECORDS)) {
        for (const located of op.params) {
          if (!isMapping(located.node)) continue;
          const name = str(located.node.name);
          if (name === 'sort') {
            sorts += 1;
            const values = enumOf(at(located.node.schema ?? {}, located.file)).map(str);
            if (values.length === 0) problems.push(`${op.id}: sort is not a fixed enum`);
            for (const value of values) if (/__c|custom/i.test(value)) problems.push(`${op.id}: sort ${value}`);
          } else if (/sort|order/i.test(name)) {
            problems.push(`${op.id}: parameter ${name}`);
          } else if (/custom/i.test(name) && name !== 'custom' && name !== 'customEmpty') {
            problems.push(`${op.id}: parameter ${name}`);
          }
        }
      }
      expect(problems).toEqual([]);
      expect(sorts, 'no sort parameter inspected').toBeGreaterThanOrEqual(4);
    });

    it('(self-check, R10) a custom sort key planted in a sort enum is caught by the same rule', () => {
      gate();
      const values = enumOf(paramSchema(recOp('listContacts'), 'sort')).map(str);
      expect(values.length).toBeGreaterThan(0);
      expect([...values, 'tier__c'].filter((value) => /__c|custom/i.test(value))).toEqual(['tier__c']);
      expect([...values, '-custom.tier__c'].filter((value) => /__c|custom/i.test(value))).toEqual(['-custom.tier__c']);
    });
  });

  describe('admin: the operations (R11, R12, R18)', () => {
    for (const [id, method, path] of ADMIN_OPS) {
      it(`${id} is ${method.toUpperCase()} ${path}, tag custom-fields`, () => {
        const op = admOp(id);
        expect(op.method).toBe(method);
        expect(op.path).toBe(path);
        expect(op.op.tags).toEqual(['custom-fields']);
      });
    }

    it('the custom-fields tag is declared; the collection has exactly these four operations and no DELETE, PUT or restore', () => {
      gate();
      const tags = Array.isArray(spec(ADMIN).tags) ? (spec(ADMIN).tags as unknown[]).filter(isMapping) : [];
      expect(tags.map((tag) => tag.name)).toContain('custom-fields');
      const under = operations(ADMIN).filter((op) => op.path === ADMIN_BASE || op.path.startsWith(`${ADMIN_BASE}/`));
      expect(under.map((op) => `${op.method} ${op.path}`).sort()).toEqual(ADMIN_OPS.map(([, method, path]) => `${method} ${path}`).sort());
      const anywhere = operations(ADMIN).filter((op) => /custom.?field/i.test(op.id) || /custom-field/.test(op.path));
      expect(anywhere.filter((op) => op.method === 'delete' || /delete|remove|restore|unretire/i.test(op.id)).map((op) => op.id)).toEqual([]);
    });

    it('listCustomFields takes exactly object (required, a CustomFieldObject) and includeRetired (optional boolean, default false) (lead edit, D-L140, D-L141)', () => {
      const op = admOp('listCustomFields');
      expect(
        op.params
          .map((p) => (isMapping(p.node) ? `${str(p.node.in)} ${str(p.node.name)} ${String(p.node.required === true)}` : ''))
          .sort(),
      ).toEqual(['query includeRetired false', 'query object true']);
      const includeRetired = paramSchema(op, 'includeRetired').node;
      expect(isMapping(includeRetired) ? [includeRetired.type, includeRetired.default] : [], 'includeRetired').toEqual(['boolean', false]);
      expect(isSchema(paramSchema(op, 'object'), adm('CustomFieldObject'))).toBe(true);
      expect(enumOf(adm('CustomFieldObject')).map(str).sort()).toEqual(OBJECTS);
    });

    it('the item operations take {fieldId}, a uuid', () => {
      for (const id of ['updateCustomField', 'retireCustomField']) {
        const op = admOp(id);
        const fieldId = param(op, 'fieldId');
        expect(isMapping(fieldId?.node) ? [fieldId.node.in, fieldId.node.required] : [], id).toEqual(['path', true]);
        const node = paramSchema(op, 'fieldId').node;
        expect(isMapping(node) ? [node.type, node.format] : [], id).toEqual(['string', 'uuid']);
      }
    });

    it('responses: list 200/400/401/404; create 201/400/401/403/404/409; update 200/400/401/403/404/409; retire 200/401/403/404', () => {
      const expected: Record<string, string[]> = {
        listCustomFields: ['200', '400', '401', '404'],
        createCustomField: ['201', '400', '401', '403', '404', '409'],
        updateCustomField: ['200', '400', '401', '403', '404', '409'],
        retireCustomField: ['200', '401', '403', '404'],
      };
      for (const [id, statuses] of Object.entries(expected)) {
        const got = [...responses(admOp(id)).keys()].filter((status) => status !== '501').sort();
        expect(got, id).toEqual(statuses);
      }
    });

    it('out of scope is one 404 body on all four: admin’s NotFound (R18)', () => {
      const notFound = responseIn(ADMIN, 'NotFound');
      for (const [id] of ADMIN_OPS) expect(responses(admOp(id)).get('404')?.node, id).toBe(notFound.node);
      expect(description(admOp('updateCustomField'))).toMatch(/standard field/i);
      expect(description(admOp('retireCustomField'))).toMatch(/standard field/i);
    });

    it('the writes need custom_field.write (a tenant action) and are audited; the list needs no permission and has no 403', () => {
      for (const id of ADMIN_WRITES) {
        const op = admOp(id);
        expect(op.op['x-kasuwa-permission'], id).toBe('custom_field.write');
        expect(op.op['x-kasuwa-audited'], id).toBe(true);
        expect(responses(op).get('403')?.node, id).toBe(responseIn(ADMIN, 'NotPermitted').node);
      }
      const list = admOp('listCustomFields');
      expect(list.op['x-kasuwa-permission']).toBeUndefined();
      expect(responses(list).has('403')).toBe(false);
      expect(description(admOp('createCustomField'))).toMatch(/tenant-admin/i);
    });

    it('screens: list P18/B, create P18/B1, update P18/B2', () => {
      for (const [id, screen] of Object.entries(ADMIN_SCREENS)) {
        const screens = admOp(id).op['x-kasuwa-screens'];
        expect(Array.isArray(screens) ? screens : [], id).toContain(screen);
      }
    });
  });

  describe('admin: the type list and the create body (R14, R15, R17)', () => {
    it('CustomFieldType is exactly the six Phase 2 types; no refused type is in it, and each refused type is named', () => {
      const type = adm('CustomFieldType');
      const values = enumOf(type).map(str);
      expect([...values].sort()).toEqual(SIX_TYPES);
      expect(values.filter((value) => [...REFUSED_TYPES, 'nin', 'bvn'].includes(value))).toEqual([]);
      const text = nodeDescription(type);
      expect(REFUSED_TYPES.filter((name) => !new RegExp(`\`${name}\``).test(text))).toEqual([]);
      expect(text).toMatch(/unsupported_type/);
    });

    it('createCustomField takes a required, closed CreateCustomFieldRequest with exactly its keys and answers 201 CustomFieldDefinition', () => {
      const op = admOp('createCustomField');
      const body = requestBody(op);
      expect(isMapping(body?.node) ? body.node.required : undefined).toBe(true);
      const schema = requestSchema(op);
      expect(schema.node).toBe(adm('CreateCustomFieldRequest').node);
      expect(isClosed(schema)).toBe(true);
      expect(keysOf(schema)).toEqual(CREATE_KEYS);
      expect(required(schema).sort()).toEqual(CREATE_REQUIRED);
      expect(responseSchema(op, '201').node).toBe(adm('CustomFieldDefinition').node);
    });

    it('apiName follows the __c rule within the 2..63 api-name bound (D-P24)', () => {
      const apiName = properties(adm('CreateCustomFieldRequest')).get('apiName');
      if (!apiName) throw new Error('no apiName');
      expect(caseProblems(apiName, GOOD_API_NAMES, BAD_API_NAMES)).toEqual([]);
    });

    it('type is a CustomFieldType; every refused type is refused by the body', () => {
      const schema = adm('CreateCustomFieldRequest');
      expect(isSchema(properties(schema).get('type'), adm('CustomFieldType'))).toBe(true);
      const base = { objectApiName: 'contact', apiName: 'note__c', label: 'Note' };
      for (const type of SIX_TYPES.filter((t) => t !== 'picklist' && t !== 'currency')) {
        expect(validate(schema, { ...base, type }, 'body'), type).toEqual([]);
      }
      for (const type of [...REFUSED_TYPES, 'nin', 'bvn', 'TEXT', '']) {
        expect(accepts(schema, { ...base, type }), `accepted ${type}`).toBe(false);
      }
    });

    it('objectApiName is a CustomFieldObject; classification is none, pii or sensitive, default none', () => {
      const props = properties(adm('CreateCustomFieldRequest'));
      expect(isSchema(props.get('objectApiName'), adm('CustomFieldObject'))).toBe(true);
      const classification = props.get('classification');
      if (!classification) throw new Error('no classification');
      expect(enumOf(classification).map(str).sort()).toEqual(CLASSIFICATIONS);
      const raw = rawProperty(adm('CreateCustomFieldRequest'), 'classification');
      const resolved = classification.node;
      const fallback = isMapping(resolved) ? resolved.default : undefined;
      expect(raw?.default ?? fallback).toBe('none');
    });

    it('config: { values: 1..500 api-name values with labels } or { currencyCode: three capitals }, never both, nothing else', () => {
      const schema = adm('CreateCustomFieldRequest');
      const config = properties(schema).get('config');
      if (!config) throw new Error('no config');
      const value = (v: string, label = 'Sample'): Mapping => ({ value: v, label });
      const values = (n: number): Mapping[] => Array.from({ length: n }, (_, i) => value(`v${i}`));
      expect(caseProblems(config, [{ values: [value('gold', 'Gold')] }, { values: values(500) }, { currencyCode: 'NGN' }, { currencyCode: 'ZAR' }], [
        { values: [] },
        { values: values(501) },
        { values: [value('Gold')] },
        { values: [value('gold', '')] },
        { values: [{ value: 'gold' }] },
        { values: [{ ...value('gold'), colour: 'gold' }] },
        { currencyCode: 'ngn' },
        { currencyCode: 'NG' },
        { currencyCode: 'NGNX' },
        { values: [value('gold')], currencyCode: 'NGN' },
        { targetObjectApiName: 'account' },
        { formula: '1+1' },
      ])).toEqual([]);
      expect(isSchema(child(properties(adm('UpdateCustomFieldRequest')).get('addValues') ?? synthetic({}), 'items'), adm('CustomFieldPicklistValue')), 'addValues items').toBe(true);
    });

    it('label 1..255; description at most 2000 or null; no isRequired, programmeId or tenant id', () => {
      const props = properties(adm('CreateCustomFieldRequest'));
      const label = props.get('label');
      const desc = props.get('description');
      if (!label || !desc) throw new Error('label or description missing');
      expect(caseProblems(label, ['L', 'x'.repeat(255)], ['', 'x'.repeat(256), null])).toEqual([]);
      expect(caseProblems(desc, [null, '', 'x'.repeat(2000)], ['x'.repeat(2001), 1])).toEqual([]);
      expect(keysOf(adm('CreateCustomFieldRequest')).filter((key) => /required|programme|tenant/i.test(key))).toEqual([]);
    });

    it('a pii or sensitive field starts at none for unlocked sets; a none field at edit; admin locked at edit (D-L128 Q2, D-L45)', () => {
      const text = description(admOp('createCustomField'));
      expect(text).toMatch(/`pii` or `sensitive`/);
      expect(text).toMatch(/starts at `none` for every unlocked permission set/);
      expect(text).toMatch(/until an admin grants/i);
      expect(text).toMatch(/`none` field starts at `edit`/);
    });

    it('create documents the name rules: the __c suffix, a taken name (retired included) is 409 duplicate_code', () => {
      const text = description(admOp('createCustomField'));
      expect(text).toMatch(/`__c`/);
      expect(text).toMatch(/duplicate_code/);
      expect(text).toMatch(/retired/i);
    });
  });

  describe('admin: update, retire and the definition (R12, R13)', () => {
    it('updateCustomField takes a required, closed UpdateCustomFieldRequest: exactly label, description, classification, addValues, relabelValues; at least one', () => {
      const op = admOp('updateCustomField');
      const schema = requestSchema(op);
      expect(schema.node).toBe(adm('UpdateCustomFieldRequest').node);
      expect(isClosed(schema)).toBe(true);
      expect(keysOf(schema)).toEqual(UPDATE_KEYS);
      expect(isMapping(schema.node) ? schema.node.minProperties : undefined).toBe(1);
      expect(responseSchema(op, '200').node).toBe(adm('CustomFieldDefinition').node);
    });

    it('the update can never change the type, the api name, the object or the config, or remove a value (R13)', () => {
      const schema = adm('UpdateCustomFieldRequest');
      for (const body of [{ type: 'text' }, { apiName: 'other__c' }, { objectApiName: 'deal' }, { config: { currencyCode: 'GHS' } }, { values: [] }, { removeValues: ['gold'] }, { isRequired: true }, { retiredAt: null }]) {
        expect(accepts(schema, body), `accepted ${JSON.stringify(body)}`).toBe(false);
      }
      expect(keysOf(schema).filter((key) => /type|remove|delete|config|currency|^values$/i.test(key))).toEqual([]);
      expect(caseProblems(schema, [{ label: 'Tier' }, { addValues: [{ value: 'platinum', label: 'Platinum' }] }, { relabelValues: [{ value: 'gold', label: 'Gold plus' }] }], [{}])).toEqual([]);
    });

    it('classification may be raised or lowered after create (D-P25, D-L138): none, pii or sensitive, never null, no default on an update', () => {
      const schema = adm('UpdateCustomFieldRequest');
      const classification = properties(schema).get('classification');
      if (!classification) throw new Error('UpdateCustomFieldRequest has no classification');
      expect(enumOf(classification).map(str).sort()).toEqual(CLASSIFICATIONS);
      expect(caseProblems(schema, CLASSIFICATIONS.map((value) => ({ classification: value })), [{ classification: null }, { classification: 'secret' }, { classification: 'PII' }])).toEqual([]);
      // A default would let an update that never named it reclassify the field.
      const raw = rawProperty(schema, 'classification');
      const resolved = classification.node;
      expect(raw?.default ?? (isMapping(resolved) ? resolved.default : undefined), 'no default on an update').toBeUndefined();
    });

    it('reclassifying is stated: raise or lower, audited by key, the matrix never rewritten, the none default at create only (D-L138)', () => {
      const text = description(admOp('updateCustomField'));
      expect(text).toMatch(/rais(e|ed|ing) or lower(ed|ing)?/i);
      expect(text).toMatch(/audited by key/i);
      expect(text).toMatch(/never rewrites the field-security matrix/i);
      expect(text).toMatch(/at create only/i);
    });

    it('addValues and relabelValues are 1..500 CustomFieldPicklistValue; the prose says values are never removed', () => {
      const props = properties(adm('UpdateCustomFieldRequest'));
      for (const key of ['addValues', 'relabelValues']) {
        const list = props.get(key);
        if (!list) throw new Error(`no ${key}`);
        const node = list.node;
        expect(isMapping(node) ? [node.type, node.minItems, node.maxItems] : [], key).toEqual(['array', 1, 500]);
        expect(isSchema(child(list, 'items'), adm('CustomFieldPicklistValue')), key).toBe(true);
      }
      const value = adm('CustomFieldPicklistValue');
      expect(isClosed(value)).toBe(true);
      expect(keysOf(value)).toEqual(['label', 'value']);
      const text = description(admOp('updateCustomField'));
      expect(text).toMatch(/never removed|cannot be removed/i);
      expect(text).toMatch(/type is immutable|type never changes|type cannot change/i);
      expect(text).toMatch(/500/);
    });

    it('retireCustomField takes no body and answers 200 with the definition, retiredAt set; never a delete, the name stays taken, a repeat is 200', () => {
      const op = admOp('retireCustomField');
      expect(op.op.requestBody).toBeUndefined();
      expect(responseSchema(op, '200').node).toBe(adm('CustomFieldDefinition').node);
      const bodies = exampleBodies(responses(op).get('200'));
      expect(bodies.length, 'no 200 example').toBeGreaterThan(0);
      for (const body of bodies) expect(UTC_DATE_TIME.test(str(body.retiredAt)), 'retiredAt set').toBe(true);
      const text = description(op);
      expect(text).toMatch(/stays taken/i);
      expect(text).toMatch(/never deleted|is not deleted/i);
      expect(text).toMatch(/already retired/i);
      expect(text).toMatch(/refused on (every )?writes?|dropped from (every )?reads?/i);
    });

    it('a retire is audited as `updated` with a `retiredAt` change, never as a `retired` event (lead edit, D-L141)', () => {
      const text = description(admOp('retireCustomField'));
      expect(text).toMatch(/audited\W*as\W*`?updated`?/i);
      expect(text).toMatch(/`?retiredAt`? change/);
      expect(text, 'the description still promises a retired audit event').not.toMatch(/`retired` event|retired event/i);
    });

    it('CustomFieldDefinition is closed with exactly its keys, all required; type is a CustomFieldType; retiredAt a nullable UTC date-time', () => {
      const schema = adm('CustomFieldDefinition');
      expect(isClosed(schema)).toBe(true);
      expect(keysOf(schema)).toEqual(DEFINITION_KEYS);
      expect(required(schema).sort()).toEqual(DEFINITION_KEYS);
      const props = properties(schema);
      expect(isSchema(props.get('type'), adm('CustomFieldType'))).toBe(true);
      expect(isSchema(props.get('objectApiName'), adm('CustomFieldObject'))).toBe(true);
      const retired = props.get('retiredAt');
      if (!retired) throw new Error('no retiredAt');
      expect(caseProblems(retired, [null, '2026-10-17T09:00:00.000Z'], ['2026-10-17', '2026-10-17T09:00:00+01:00'])).toEqual([]);
    });

    it('listCustomFields answers a closed CustomFieldList: objectApiName, limits, items (retired only with includeRetired=true)', () => {
      const list = responseSchema(admOp('listCustomFields'), '200');
      expect(list.node).toBe(adm('CustomFieldList').node);
      expect(isClosed(list)).toBe(true);
      expect(keysOf(list)).toEqual(['items', 'limits', 'objectApiName']);
      expect(required(list).sort()).toEqual(['items', 'limits', 'objectApiName']);
      const items = properties(list).get('items');
      expect(items ? child(items, 'items')?.node : undefined).toBe(adm('CustomFieldDefinition').node);
      expect(description(admOp('listCustomFields'))).toMatch(/retired/i);
      // Lead edit (D-L140, D-L141): the prose says retired fields need includeRetired.
      expect(description(admOp('listCustomFields'))).toMatch(/includeRetired/);
    });
  });

  describe('admin: limits and errors (R16)', () => {
    // T-0089 / D-L142 (lead edit): bytesPerRecord is the 512 KiB backstop (524288); 16 KiB is the limit callers meet.
    it('CustomFieldLimits: closed, exactly apiBytes 16384, bytesPerRecord 524288 (the backstop), definitionsPerObject 500, fieldsPerObject 100, picklistValues 500, all required (D-L128 Q1; lead edit, D-L140, D-L141, D-L142)', () => {
      const limits = adm('CustomFieldLimits');
      expect(isSchema(properties(adm('CustomFieldList')).get('limits'), limits)).toBe(true);
      expect(isClosed(limits)).toBe(true);
      const props = properties(limits);
      const constOf = (key: string): unknown => {
        const node = props.get(key)?.node;
        return isMapping(node) ? (node.const ?? (Array.isArray(node.enum) && node.enum.length === 1 ? node.enum[0] : undefined)) : undefined;
      };
      const KEYS = ['apiBytes', 'bytesPerRecord', 'definitionsPerObject', 'fieldsPerObject', 'picklistValues'];
      expect(KEYS.map(constOf)).toEqual([16384, 524288, 500, 100, 500]);
      for (const key of KEYS) {
        const node = props.get(key)?.node;
        expect(isMapping(node) ? node.type : undefined, `${key} type`).toBe('integer');
      }
      expect(keysOf(limits)).toEqual(KEYS);
      expect(required(limits).sort()).toEqual(KEYS);
      const text = nodeDescription(limits);
      expect(text).toMatch(/512 KiB/);
      expect(text).toMatch(/16 KiB/);
      expect(text).toMatch(/backstop/i);
      expect(text).toMatch(/retired/i);
      // 16 KiB is the limit callers meet, said in so many words, and no part of the
      // schema (property descriptions included) still gives the old 32 KiB backstop.
      expect(text).toMatch(/16 KiB[^.]*\bcallers?\b|\bcallers?\b[^.]*16 KiB/i);
      const whole = JSON.stringify(limits.node);
      expect(whole).not.toMatch(/32768/);
      expect(whole, 'still calls 32 KiB the backstop').not.toMatch(/32 KiB[^.]*backstop|backstop[^.]*32 KiB/i);
      // definitionsPerObject counts retired fields; fieldsPerObject does not.
      const definitions = nodeDescription(props.get('definitionsPerObject') ?? limits);
      expect(`${definitions} ${text}`).toMatch(/definitionsPerObject[^.]*retired|retired[^.]*definitionsPerObject/i);
    });

    it('the 500-value picklist limit is at config.values on create and at addValues on update (lead edit, D-L141)', () => {
      const create = description(admOp('createCustomField'));
      expect(create).toMatch(/500[^.]*`config\.values`/);
      const failed = responseIn(ADMIN, 'CustomFieldValidationFailed');
      expect(detailPairs(exampleBodies(failed)), 'no 400 example of invalid_config at config.values').toContain('config.values invalid_config');
      const update = description(admOp('updateCustomField'));
      expect(update.replace(/\s+/g, ' ')).toMatch(/picklist_limit_reached`? at `addValues`/);
      const conflict = responseIn(ADMIN, 'CustomFieldConflict');
      const got = exampleBodies(conflict).flatMap((body) => detailsOf(body).map((detail) => `${str(detail.path)} ${str(detail.code)}`));
      expect(got).toContain('addValues picklist_limit_reached');
      expect(got.filter((entry) => entry.endsWith('picklist_limit_reached'))).toEqual(['addValues picklist_limit_reached']);
    });

    it('Error.code gains limit_reached', () => {
      const code = properties(adm('Error')).get('code');
      expect(code ? enumOf(code) : []).toContain('limit_reached');
    });

    it('the 409 CustomFieldConflict on create and update shows duplicate_code and both limit_reached details', () => {
      const conflict = responseIn(ADMIN, 'CustomFieldConflict');
      for (const id of ['createCustomField', 'updateCustomField']) {
        expect(responses(admOp(id)).get('409')?.node, id).toBe(conflict.node);
      }
      const got = exampleBodies(conflict).flatMap((body) => detailsOf(body).map((detail) => `${str(body.code)} ${str(detail.path)} ${str(detail.code)}`));
      expect(ADMIN_409_DETAILS.filter((entry) => !got.includes(entry))).toEqual([]);
      for (const body of exampleBodies(conflict)) expect(body.statusCode).toBe(409);
    });

    it('the 400 CustomFieldValidationFailed on create and update shows every admin detail code at its path', () => {
      const failed = responseIn(ADMIN, 'CustomFieldValidationFailed');
      for (const id of ['createCustomField', 'updateCustomField']) {
        expect(responses(admOp(id)).get('400')?.node, id).toBe(failed.node);
      }
      const bodies = exampleBodies(failed);
      for (const body of bodies) expect([body.statusCode, body.code]).toEqual([400, 'validation_failed']);
      const got = detailPairs(bodies);
      expect(ADMIN_400_DETAILS.filter((entry) => !got.includes(entry))).toEqual([]);
    });

    // T-0089 / D-L142 (lead edit): the records prose states the 16 KiB limit callers meet.
    it('the limits are stated in prose where they bite: 100 and limit_reached on create, 500 on update, 16 KiB in records', () => {
      const create = description(admOp('createCustomField'));
      expect(create).toMatch(/100/);
      expect(create).toMatch(/limit_reached/);
      expect(create).toMatch(/field_limit_reached/);
      expect(description(admOp('updateCustomField'))).toMatch(/picklist_limit_reached/);
      expect(nodeDescription(rec('CustomFields'))).toMatch(/16 KiB/);
    });
  });

  // T-0089 / D-L142 (lead edit): T-0089 serves all of it, so every pin flips from `false`
  // to `true`. The prose pin that the parameter descriptions say "a screen must not send
  // them until served" is dropped, so the builder can refresh that wording.
  describe('flags: served by T-0089 (R19)', () => {
    it('the four admin operations are x-kasuwa-implemented: true', () => {
      for (const [id] of ADMIN_OPS) expect(admOp(id).op['x-kasuwa-implemented'], id).toBe(true);
    });

    it('every custom property, on the record shapes and the bodies, is x-kasuwa-implemented: true', () => {
      const problems: string[] = [];
      let checked = 0;
      for (const name of [...RECORD_SCHEMAS, ...CREATE_BODIES, ...UPDATE_BODIES]) {
        const raw = rawProperty(rec(name), 'custom');
        checked += 1;
        if (!raw) problems.push(`${name}: no custom`);
        else if (raw['x-kasuwa-implemented'] !== true) problems.push(`${name}.custom is not x-kasuwa-implemented: true`);
      }
      expect(problems).toEqual([]);
      // Not vacuous: four record shapes, four create bodies, four update bodies.
      expect(checked).toBe(12);
    });

    it('the custom and customEmpty parameters are x-kasuwa-implemented: true', () => {
      for (const name of ['custom', 'customEmpty']) {
        const located = param(recOp('listContacts'), name);
        expect(isMapping(located?.node) ? located.node['x-kasuwa-implemented'] : undefined, name).toBe(true);
      }
    });
  });

  describe('examples (R2, R8, R20, D-L97)', () => {
    it('(self-check) the validator rejects broken copies of a custom-field definition and a record’s custom', () => {
      const definition = adm('CustomFieldDefinition');
      const list = exampleBodies(responses(admOp('listCustomFields')).get('200'));
      const items = list.flatMap((body) => (Array.isArray(body.items) ? body.items.filter(isMapping) : []));
      const [first] = items;
      if (!first) throw new Error('listCustomFields 200 has no example item');
      expect(validate(definition, first, 'item')).toEqual([]);
      const mutants: [string, unknown][] = [
        ['a refused type', { ...first, type: 'multipicklist' }],
        ['no __c', { ...first, apiName: 'tier' }],
        ['isRequired', { ...first, isRequired: false }],
        ['a local retiredAt', { ...first, retiredAt: '2026-10-17 09:00' }],
        ['no retiredAt', JSON.parse(JSON.stringify({ ...first, retiredAt: undefined }))],
        ['another object', { ...first, objectApiName: 'lead' }],
        ['a fourth classification', { ...first, classification: 'secret' }],
      ];
      for (const [label, mutant] of mutants) expect(validate(definition, mutant, 'item').length, `accepted ${label}`).toBeGreaterThan(0);
      const custom = rec('CustomFields');
      for (const [label, mutant] of [
        ['a float number', { score__c: 1.5 }],
        ['a null', { tier__c: null }],
        ['a standard name', { status: 'gold' }],
        ['a bare amount', { limit__c: { amount: '100', currency: 'NGN' } }],
      ] as const) {
        expect(validate(custom, mutant, 'custom').length, `accepted ${label}`).toBeGreaterThan(0);
      }
    });

    it('every record example with custom obeys R2: custom never withheld itself, a withheld key absent, never null', () => {
      gate();
      const problems: string[] = [];
      let checked = 0;
      for (const instance of recordInstances()) {
        if (instance.value.custom === undefined && !withheldOf(instance.value).some((name) => name.startsWith('custom'))) continue;
        checked += 1;
        problems.push(...customExampleProblems(`${instance.label} (${instance.type})`, instance.value));
      }
      expect(problems).toEqual([]);
      expect(checked, 'no record example carries custom').toBeGreaterThanOrEqual(5);
    });

    it('(self-check, R2) the example checker catches a withheld-but-present key, a null value and custom itself withheld', () => {
      gate();
      const ok: Mapping = { custom: { tier__c: 'gold' }, withheldFields: ['custom.vip__c'] };
      expect(customExampleProblems('ok', ok)).toEqual([]);
      expect(customExampleProblems('present', { custom: { vip__c: true }, withheldFields: ['custom.vip__c'] })).not.toEqual([]);
      expect(customExampleProblems('null', { custom: { tier__c: null }, withheldFields: [] })).not.toEqual([]);
      expect(customExampleProblems('whole', { withheldFields: ['custom'] })).not.toEqual([]);
      expect(customExampleProblems('bad path', { custom: {}, withheldFields: ['custom.tier'] })).not.toEqual([]);
    });

    it('each record shape, and listLeads, has an example with a value in custom; each shape has one with a withheld custom key', () => {
      gate();
      const instances = recordInstances();
      const missing: string[] = [];
      for (const type of RECORD_SCHEMAS) {
        const ofType = instances.filter((instance) => instance.type === type);
        if (!ofType.some((instance) => isMapping(instance.value.custom) && Object.keys(instance.value.custom).length > 0)) missing.push(`${type}: no example with a custom value`);
        if (!ofType.some((instance) => withheldOf(instance.value).some((name) => KEY_PATH.test(name)))) missing.push(`${type}: no example with a withheld custom key`);
      }
      if (!instances.some((instance) => instance.op.id === 'listLeads' && isMapping(instance.value.custom) && Object.keys(instance.value.custom).length > 0)) {
        missing.push('listLeads: no example with a custom value');
      }
      expect(missing).toEqual([]);
    });

    it('each update operation has a request example with custom; together they clear a key with null and set a currency value', () => {
      const patches: Mapping[] = [];
      const missing: string[] = [];
      for (const id of UPDATE_OPS) {
        const found = examplesOf(jsonMedia(requestBody(recOp(id)))).map(([, value]) => value).filter(isMapping).filter((value) => isMapping(value.custom));
        if (found.length === 0) missing.push(id);
        patches.push(...found.map((value) => value.custom as Mapping));
      }
      expect(missing).toEqual([]);
      const values = patches.flatMap((patch) => Object.values(patch));
      expect(values.some((value) => value === null), 'a null clear').toBe(true);
      expect(values.some((value) => isMapping(value) && typeof value.amountMinor === 'string'), 'a currency value').toBe(true);
    });

    it('the list example shows all six types, a retired field and a pii or sensitive one; every definition’s config fits its type', () => {
      gate();
      const definitions: Mapping[] = [];
      for (const example of allExamples(ADMIN)) {
        if (!example.op.path.startsWith(ADMIN_BASE) || example.status === 'request') continue;
        const found: [string, Mapping][] = [];
        if (example.schema) instancesOf(example.schema, example.value, new Map([[adm('CustomFieldDefinition').node, 'def']]), found);
        definitions.push(...found.map(([, value]) => value));
      }
      const listed = exampleBodies(responses(admOp('listCustomFields')).get('200')).flatMap((body) => (Array.isArray(body.items) ? body.items.filter(isMapping) : []));
      expect([...new Set(listed.map((item) => str(item.type)))].sort()).toEqual(SIX_TYPES);
      expect(listed.some((item) => typeof item.retiredAt === 'string'), 'a retired field').toBe(true);
      expect(listed.some((item) => item.classification === 'pii' || item.classification === 'sensitive'), 'a pii or sensitive field').toBe(true);
      const problems: string[] = [];
      for (const definition of definitions) {
        const config = isMapping(definition.config) ? definition.config : {};
        const label = str(definition.apiName);
        if (definition.type === 'picklist') {
          if (!Array.isArray(config.values) || config.values.length === 0) problems.push(`${label}: a picklist with no values`);
        } else if (definition.type === 'currency') {
          if (!/^[A-Z]{3}$/.test(str(config.currencyCode))) problems.push(`${label}: a currency with no currencyCode`);
        } else if (Object.keys(config).length > 0) {
          problems.push(`${label}: a ${str(definition.type)} with config`);
        }
      }
      expect(problems).toEqual([]);
      expect(definitions.length).toBeGreaterThanOrEqual(7);
      expect(examplesOf(jsonMedia(requestBody(admOp('createCustomField')))).length, 'no create example').toBeGreaterThan(0);
    });

    it('every example on the custom-field operations validates against its schema', () => {
      gate();
      const problems: string[] = [];
      let checked = 0;
      for (const example of allExamples(ADMIN)) {
        if (!example.op.path.startsWith(ADMIN_BASE)) continue;
        checked += 1;
        if (example.schema) problems.push(...validate(example.schema, example.value, example.label));
      }
      expect(problems).toEqual([]);
      expect(checked).toBeGreaterThanOrEqual(10);
    });

    // T-0089 / D-L142 (lead edit): the mock is regenerated with the flags, so each is `true`.
    it('the generated admin mock is regenerated: it lists the four operations, each implemented true (D-L97)', async () => {
      const generated = (await import(resolve(E2E_SUPPORT, 'admin-mock.generated.ts'))) as { ADMIN_OPERATIONS?: readonly { operationId: string; implemented: string }[] };
      const listed = new Map((generated.ADMIN_OPERATIONS ?? []).map((entry) => [entry.operationId, entry.implemented]));
      expect(ADMIN_OPS.map(([id]) => `${id} ${String(listed.get(id))}`)).toEqual(ADMIN_OPS.map(([id]) => `${id} true`));
    });

    it('every other example in both files still validates (D-L97: custom fields break no mock)', () => {
      // A regression guard: it holds on main by design and must keep holding. Not vacuous:
      // it counts what it checked.
      const problems: string[] = [];
      let checked = 0;
      for (const file of [RECORDS, ADMIN]) {
        for (const example of allExamples(file)) {
          if (file === ADMIN && example.op.path.startsWith(ADMIN_BASE)) continue;
          checked += 1;
          if (example.schema) problems.push(...validate(example.schema, example.value, `${posix(file)} ${example.label}`));
        }
      }
      expect(problems).toEqual([]);
      expect(checked).toBeGreaterThan(100);
    });

    it('every e2e mock that reads either contract still loads: each validates its own rows when imported (D-L97)', async () => {
      // A regression guard like the one above: it holds on main by design. A mock that derives
      // rows from these files throws at import when a schema change makes its rows invalid.
      const mocks = readdirSync(E2E_SUPPORT)
        .filter((name) => /-mock\.ts$/.test(name))
        .filter((name) => /(records|admin)\.openapi\.yaml/.test(readFileSync(resolve(E2E_SUPPORT, name), 'utf8')));
      expect(mocks.length, 'no contract mock found').toBeGreaterThanOrEqual(8);
      const failures: string[] = [];
      for (const name of mocks) {
        try {
          await import(resolve(E2E_SUPPORT, name));
        } catch (error) {
          failures.push(`${name}: ${(error as Error).message}`);
        }
      }
      expect(failures).toEqual([]);
    });
  });
});
