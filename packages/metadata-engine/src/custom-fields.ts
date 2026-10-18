import type { TenantTx } from '@kasuwa/db';
import { z, type ZodError, type ZodIssue } from 'zod';
import { API_NAME_PATTERN } from './api-name';
import { fieldLevel, resolveFieldAccess, type FieldAccess } from './field-access';
import { fieldAccessLevelSchema, fieldClassificationSchema, type FieldClassification } from './field-security';
import { UnknownObjectDefError } from './repository';

/**
 * Custom-field VALUES on the standard objects (ADR-0016, T-0089): the live
 * definitions a request validates against, the caller's access to each, and
 * the per-(tenant, object) Zod schema built from them.
 *
 * READ THIS BEFORE "FIXING" THE MISSING programme_id. A definition is the
 * tenant's, not one programme's (ADR-0008, 0002 header): every programme of a
 * tenant sees the same custom fields. Only the VALUE is programme-scoped, by
 * the record row it lives on, and only the caller's ACCESS to a field varies
 * by programme (the permission set held there, D-P9).
 *
 * THIS IS USER-AUTHORED SCHEMA. A tenant admin decides the keys, types and
 * picklist values that this file turns into validators, so:
 *   - definitions are read LIVE, on every request (V9): never cached per
 *     process, so a retirement or a new grant is in force on the next request;
 *   - an api_name is never an identifier: it is a bound parameter or a JSON key;
 *   - no error detail ever carries a received value. Zod's own messages echo
 *     input, so they are never used: every issue raised here carries a stable
 *     `params.reason`, and `customIssueDetails` builds `{ path, code }` from
 *     the path and that reason alone. A key that does not even look like a
 *     custom api name is reported at `custom` (D-L140) and never echoed.
 */

/** The standard objects that take custom fields (D-P17: a lead is a contact). */
export const CUSTOM_FIELD_OBJECTS = ['contact', 'account', 'activity', 'deal'] as const;
export type CustomFieldObject = (typeof CUSTOM_FIELD_OBJECTS)[number];

export function isCustomFieldObject(value: unknown): value is CustomFieldObject {
  return typeof value === 'string' && (CUSTOM_FIELD_OBJECTS as readonly string[]).includes(value);
}

/** The Phase 2 types (ADR-0016 item 4). Every other type is refused at create. */
export const CUSTOM_FIELD_TYPES = ['text', 'number', 'currency', 'date', 'picklist', 'boolean'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** A custom field's currency: one per field, never converted (D-L128 Q6). */
export const CUSTOM_FIELD_CURRENCIES = ['NGN', 'GHS', 'KES', 'ZAR'] as const;

/** The limits (D-L128 Q1, D-L140, D-L141), served as data by listCustomFields. */
export const CUSTOM_FIELD_LIMITS = {
  /** The API's limit on a record's custom values, on what the caller can see plus what it writes. */
  apiBytes: 16_384,
  /** The database backstop (0039's CHECK) on the whole stored object. */
  bytesPerRecord: 32_768,
  /** Definitions per object, retired ones included. */
  definitionsPerObject: 500,
  /** Active fields per object. */
  fieldsPerObject: 100,
  picklistValues: 500,
} as const;

/** The most keys one `custom` object (or patch) may carry. */
export const MAX_CUSTOM_KEYS = 100;

/**
 * A custom api name: lower snake case ending in `__c` (D-P24), within the
 * api-name bound (63 characters, ending alphanumeric). Anchored without the
 * `m` flag, so `$` is the end of the string, never the end of a line: a
 * trailing newline does not pass.
 */
export const CUSTOM_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]*__c$/;

export function isCustomFieldKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 4 &&
    value.length <= 63 &&
    CUSTOM_FIELD_KEY_PATTERN.test(value) &&
    API_NAME_PATTERN.test(value)
  );
}

/** A picklist value: an api name, as stored in `config.values[].value`. */
export const PICKLIST_VALUE_PATTERN = API_NAME_PATTERN;

/** One live custom field definition, as the record APIs need it. */
export interface CustomFieldDef {
  id: string;
  apiName: string;
  type: CustomFieldType;
  classification: FieldClassification;
  /** Picklist values, in order (picklist only; empty otherwise). */
  values: readonly string[];
  /** The field's one currency (currency only; null otherwise). */
  currencyCode: string | null;
}

// --- value encodings (ADR-0016 item 4; records.openapi.yaml CustomField*) -------

/** CustomFieldText: one line, 1..1000 code points, no NUL. */
/** Line breaks; NUL is tested with `includes` (a NUL in a regex trips no-control-regex). */
const TEXT_LINE_BREAK = /[\n\r\u2028\u2029]/u;
const TEXT_MAX_CODE_POINTS = 1000;

/** CustomFieldNumber, verbatim from the contract: canonical, at most 18 significant digits. */
const NUMBER_PATTERN =
  /^(?:0|-?0\.0*[1-9](?:[0-9]{0,16}[1-9])?|-?(?=(?:[^0-9]*[0-9]){1,18}[^0-9]*$)[1-9][0-9]*(?:\.[0-9]*[1-9])?)$/;
const NUMBER_MAX_LENGTH = 40;

/** CustomFieldCurrency.amountMinor: a signed bigint string, at most 18 digits. */
const AMOUNT_MINOR_PATTERN = /^(?:0|-?[1-9][0-9]{0,17})$/;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const DATE_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** Why a value was refused: a contract detail code, and where under the key. */
export interface CustomValueProblem {
  code: 'invalid_value' | 'unknown_value' | 'currency_mismatch';
  /** Below `custom.<key>`: empty, or `['currency']` for a mismatch. */
  path: readonly string[];
}

const invalid: CustomValueProblem = { code: 'invalid_value', path: [] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(year); // years below 100 are not 19xx
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * The problem with one non-null value for `def`, or null when it is valid.
 * Pure; never looks at anything but the value's shape and the definition.
 */
export function customValueProblem(def: CustomFieldDef, value: unknown): CustomValueProblem | null {
  switch (def.type) {
    case 'text': {
      if (typeof value !== 'string') return invalid;
      const length = [...value].length;
      if (length < 1 || length > TEXT_MAX_CODE_POINTS) return invalid;
      if (value.includes('\u0000') || TEXT_LINE_BREAK.test(value)) return invalid;
      return null;
    }
    case 'number':
      return typeof value === 'string' && value.length <= NUMBER_MAX_LENGTH && NUMBER_PATTERN.test(value)
        ? null
        : invalid;
    case 'currency': {
      if (!isPlainObject(value)) return invalid;
      const keys = Object.keys(value);
      if (keys.length !== 2 || !keys.includes('amountMinor') || !keys.includes('currency')) return invalid;
      const { amountMinor, currency } = value;
      if (typeof amountMinor !== 'string' || !AMOUNT_MINOR_PATTERN.test(amountMinor)) return invalid;
      if (typeof currency !== 'string' || !CURRENCY_CODE_PATTERN.test(currency)) return invalid;
      if (currency !== def.currencyCode) return { code: 'currency_mismatch', path: ['currency'] };
      return null;
    }
    case 'date':
      return typeof value === 'string' && isCalendarDate(value) ? null : invalid;
    case 'picklist':
      if (typeof value !== 'string' || !PICKLIST_VALUE_PATTERN.test(value)) return invalid;
      return def.values.includes(value) ? null : { code: 'unknown_value', path: [] };
    case 'boolean':
      return typeof value === 'boolean' ? null : invalid;
  }
}

// --- the per-(tenant, object) Zod builder ----------------------------------------

/**
 * `create`: the values to set (CustomFields): a `null` is refused.
 * `patch`: a per-key merge (CustomFieldsPatch): `null` removes the key, and an
 * empty object is refused.
 */
export type CustomSchemaMode = 'create' | 'patch';

function reason(ctx: z.RefinementCtx, code: string, path: readonly string[] = []): void {
  // The message is a constant: details are built from `path` and `params.reason` only.
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid', path: [...path], params: { reason: code } });
}

/**
 * The Zod schema for one object's `custom`, built from its LIVE definitions
 * (retired fields are absent, so a retired key is refused exactly like one
 * that never existed: `unknown_field`). `.strict()`: an unknown key is an
 * issue, never stripped.
 */
export function customFieldsSchema(
  defs: readonly CustomFieldDef[],
  mode: CustomSchemaMode,
): z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const def of defs) {
    shape[def.apiName] = z
      .unknown()
      .superRefine((value, ctx) => {
        if (value === null) {
          if (mode === 'create') reason(ctx, 'invalid_value');
          return;
        }
        const problem = customValueProblem(def, value);
        if (problem !== null) reason(ctx, problem.code, problem.path);
      })
      .optional();
  }
  return z
    .unknown()
    .superRefine((value, ctx) => {
      if (!isPlainObject(value)) {
        reason(ctx, 'invalid_type');
        return;
      }
      const keys = Object.keys(value);
      // A key that is not a custom api name at all: one detail at `custom`,
      // the key never named (D-L140). Checked before Zod's own key handling
      // so `__proto__`, `constructor` and the like never reach a lookup.
      if (keys.some((key) => !isCustomFieldKey(key))) reason(ctx, 'unknown_field');
      if (keys.length > MAX_CUSTOM_KEYS) reason(ctx, 'too_many_keys');
      if (mode === 'patch' && keys.length === 0) reason(ctx, 'nothing_to_update');
    })
    .pipe(z.object(shape).strict()) as unknown as z.ZodType<
    Record<string, unknown>,
    z.ZodTypeDef,
    unknown
  >;
}

/** A detail on the wire: a path and a code, never a value. */
export interface CustomIssueDetail {
  path: string;
  code: string;
}

/**
 * Details for a failed `customFieldsSchema` parse, rooted at `root`
 * (`custom`). Built from issue paths and `params.reason` only; Zod's message
 * is never read. An unrecognised key is `unknown_field` at `<root>.<key>`
 * when it is a well-formed custom api name (unknown, retired, or another
 * object's or tenant's), and at `<root>` itself when it is not, so a hostile
 * key is never echoed.
 */
export function customIssueDetails(error: ZodError, root = 'custom'): CustomIssueDetail[] {
  const details: CustomIssueDetail[] = [];
  const seen = new Set<string>();
  const push = (path: string, code: string) => {
    const id = `${path}\u0000${code}`;
    if (seen.has(id)) return;
    seen.add(id);
    details.push({ path, code });
  };
  for (const issue of error.issues) {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      for (const key of issue.keys) push(isCustomFieldKey(key) ? `${root}.${key}` : root, 'unknown_field');
      continue;
    }
    push(issuePath(issue, root), issueCode(issue));
  }
  return details;
}

function issuePath(issue: ZodIssue, root: string): string {
  const [key, ...rest] = issue.path.map(String);
  if (key === undefined) return root;
  // Only a defined (so well-formed) key can head an issue path here; checked
  // anyway, so no path can ever carry a key that is not a custom api name.
  if (!isCustomFieldKey(key)) return root;
  const below = rest.filter((part) => part === 'currency' || part === 'amountMinor');
  return [root, key, ...below].join('.');
}

function issueCode(issue: ZodIssue): string {
  const code: unknown = issue.code === z.ZodIssueCode.custom ? issue.params?.['reason'] : undefined;
  return typeof code === 'string' ? code : 'invalid_value';
}

/** A parsed patch, split for the SQL merge `custom || set - remove`. */
export interface CustomPatch {
  set: Record<string, unknown>;
  remove: string[];
}

export function splitCustomPatch(parsed: Record<string, unknown>): CustomPatch {
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    if (value === null) remove.push(key);
    else set[key] = value;
  }
  return { set, remove };
}

/**
 * The octets of `value` in Postgres's jsonb text form (`{"a": 1, "b": 2}`:
 * a space after every `:` and `,`), which is what 0039's backstop and the
 * repositories' SQL size check measure. Key order does not change the count.
 */
export function jsonbTextOctets(value: unknown): number {
  return Buffer.byteLength(jsonbText(value), 'utf8');
}

function jsonbText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(', ')}]`;
  if (isPlainObject(value)) {
    return `{${Object.entries(value)
      .map(([key, child]) => `${JSON.stringify(key)}: ${jsonbText(child)}`)
      .join(', ')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// --- the live definitions and the caller's access, in one round trip -----------

/**
 * The live custom definitions of one standard object, and the caller's level
 * for each in every programme it reaches.
 */
export interface CustomFieldAccess {
  object: CustomFieldObject;
  /** Live (not retired) custom fields, by api name. */
  defs: ReadonlyMap<string, CustomFieldDef>;
  /** Programme id -> api name -> level, for those fields (`fieldLevel` semantics). */
  access: FieldAccess;
}

const PicklistValues = z.array(z.object({ value: z.string() }).passthrough());

const DefRow = z.object({
  id: z.string().uuid(),
  apiName: z.string(),
  type: z.string(),
  classification: fieldClassificationSchema,
  config: z.unknown(),
});

const AccessRow = z.object({
  fields: z.array(DefRow),
  grants: z.array(
    z.object({
      field: z.string(),
      set: z.string().uuid(),
      locked: z.boolean(),
      level: fieldAccessLevelSchema,
    }),
  ),
  memberships: z.array(
    z.object({
      programme: z.string().uuid(),
      set: z.string().uuid().nullable(),
      locked: z.boolean(),
    }),
  ),
});

/**
 * ONE round trip, as `loadFieldAccess` (field-access.ts) is: the standard
 * object is the FROM, so an object the session cannot see yields no row; the
 * three aggregates hang off it. Only LIVE custom fields (`is_custom`,
 * `retired_at IS NULL`) are read, with their grants.
 *
 * tenancy-reviewed: tenant, user and programmes all from `tx.session`; every
 * join on (tenant_id, id) and every table filtered on tenant_id explicitly,
 * with RLS on each besides. The object name is checked against the constant
 * list, then bound; it is never an identifier. Deliberately no programme
 * predicate on field_def or field_security_grant (see the header): only the
 * memberships are per programme.
 */
const CUSTOM_FIELD_ACCESS_SQL = `
  SELECT
    (SELECT coalesce(json_agg(json_build_object(
              'id', f.id, 'apiName', f.api_name, 'type', f.type,
              'classification', f.classification, 'config', f.config)
            ORDER BY f.api_name), '[]'::json)
       FROM field_def f
      WHERE f.tenant_id = $1 AND f.object_id = o.id
        AND f.is_custom AND f.retired_at IS NULL) AS fields,
    (SELECT coalesce(json_agg(json_build_object(
              'field', f.api_name, 'set', gs.id, 'locked', gs.locked, 'level', g.level)),
            '[]'::json)
       FROM field_security_grant g
       JOIN field_def f
         ON f.tenant_id = g.tenant_id AND f.id = g.field_id
       JOIN permission_set gs
         ON gs.tenant_id = g.tenant_id AND gs.id = g.permission_set_id
      WHERE g.tenant_id = $1 AND f.tenant_id = $1 AND f.object_id = o.id
        AND f.is_custom AND f.retired_at IS NULL) AS grants,
    (SELECT coalesce(json_agg(json_build_object(
              'programme', up.programme_id, 'set', ps.id,
              'locked', coalesce(ps.locked, false))),
            '[]'::json)
       FROM user_programme up
       LEFT JOIN permission_set ps
         ON ps.tenant_id = up.tenant_id AND ps.id = up.permission_set_id
      WHERE up.tenant_id = $1
        AND up.user_id = $3
        AND up.programme_id = ANY ($4::uuid[])) AS memberships
    FROM object_def o
   WHERE o.tenant_id = $1 AND o.api_name = $2 AND NOT o.is_custom`;

/** A stored definition as the record APIs use it; null for a type outside Phase 2 (never served). */
export function toCustomFieldDef(row: z.infer<typeof DefRow>): CustomFieldDef | null {
  if (!(CUSTOM_FIELD_TYPES as readonly string[]).includes(row.type)) return null;
  const type = row.type as CustomFieldType;
  const config = (typeof row.config === 'object' && row.config !== null ? row.config : {}) as Record<
    string,
    unknown
  >;
  const values = type === 'picklist' ? PicklistValues.safeParse(config['values']) : null;
  const currency = config['currencyCode'];
  return {
    id: row.id,
    apiName: row.apiName,
    type,
    classification: row.classification,
    values: values?.success === true ? values.data.map((entry) => entry.value) : [],
    currencyCode: type === 'currency' && typeof currency === 'string' ? currency : null,
  };
}

/**
 * The session's live custom fields of `object`, and its access to each, per
 * programme it reaches. Read on every call: nothing is cached (V9). Rejects
 * with `UnknownObjectDefError` for an object the tenant has no standard
 * definition of (a broken catalogue fails closed, never as "no fields").
 */
export async function loadCustomFieldAccess(
  tx: TenantTx,
  object: CustomFieldObject,
): Promise<CustomFieldAccess> {
  if (!isCustomFieldObject(object)) throw new UnknownObjectDefError();
  const { tenantId, userId, programmeIds } = tx.session;
  const rows = await tx.query(CUSTOM_FIELD_ACCESS_SQL, [tenantId, object, userId, [...programmeIds]]);
  const raw = rows[0];
  if (raw === undefined) throw new UnknownObjectDefError();
  const row = AccessRow.parse(raw);
  const defs = new Map<string, CustomFieldDef>();
  for (const field of row.fields) {
    const def = toCustomFieldDef(field);
    if (def !== null && isCustomFieldKey(def.apiName)) defs.set(def.apiName, def);
  }
  const access = resolveFieldAccess({
    fieldApiNames: [...defs.keys()],
    grants: row.grants
      .filter((grant) => defs.has(grant.field))
      .map((grant) => ({
        fieldApiName: grant.field,
        permissionSetId: grant.set,
        locked: grant.locked,
        level: grant.level,
      })),
    memberships: row.memberships.map((membership) => ({
      programmeId: membership.programme,
      permissionSetId: membership.set,
      locked: membership.locked,
    })),
    reachableProgrammeIds: programmeIds,
  });
  return { object, defs, access };
}

// --- questions the record APIs ask of it ------------------------------------------

/** Live keys the caller may READ in `programmeId`, by api name. Unknown programme: none. */
export function readableCustomKeys(custom: CustomFieldAccess, programmeId: string): string[] {
  return [...custom.defs.keys()]
    .filter((key) => fieldLevel(custom.access, programmeId, key) !== 'none')
    .sort();
}

/** Live keys WITHHELD from the caller in `programmeId` (V1: whether or not a row holds them). */
export function withheldCustomKeys(custom: CustomFieldAccess, programmeId: string): string[] {
  return [...custom.defs.keys()]
    .filter((key) => fieldLevel(custom.access, programmeId, key) === 'none')
    .sort();
}

/** For the SQL projection: programme id -> the keys readable there, for each programme given. */
export function readableCustomKeysByProgramme(
  custom: CustomFieldAccess,
  programmeIds: readonly string[],
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const programmeId of programmeIds) result[programmeId] = readableCustomKeys(custom, programmeId);
  return result;
}

/** True when `key` is withheld from the caller in ANY programme it reaches (filters, D-L88). */
export function customWithheldAnywhere(custom: CustomFieldAccess, key: string): boolean {
  return [...custom.access.keys()].some(
    (programmeId) => fieldLevel(custom.access, programmeId, key) === 'none',
  );
}

/**
 * The keys of a raw `custom` body the caller may not EDIT in `programmeId`:
 * live keys whose level there is not `edit`. Keys that are not live custom
 * fields are not judged here (they are a 400, `unknown_field`, after every
 * 403), and a malformed key is never returned, so it is never echoed.
 */
export function notEditableCustomKeys(
  custom: CustomFieldAccess,
  programmeId: string,
  keys: readonly string[],
): string[] {
  return keys.filter(
    (key) =>
      isCustomFieldKey(key) &&
      custom.defs.has(key) &&
      fieldLevel(custom.access, programmeId, key) !== 'edit',
  );
}

/**
 * The SECOND layer (ADR-0016 item 6): the values the SQL projection returned
 * for one row, kept only where the key is live and readable in the row's
 * programme, and never as `null`. The projection already did this in
 * Postgres; this is the independent re-check, so a bug in one layer does not
 * leak (CLAUDE.md 2.3).
 */
export function visibleCustomValues(
  custom: CustomFieldAccess,
  programmeId: string,
  projected: unknown,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!isPlainObject(projected)) return result;
  for (const key of readableCustomKeys(custom, programmeId)) {
    if (!Object.prototype.hasOwnProperty.call(projected, key)) continue;
    const value = projected[key];
    if (value !== null && value !== undefined) result[key] = value;
  }
  return result;
}
