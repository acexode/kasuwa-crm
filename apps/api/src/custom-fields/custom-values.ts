import type { TenantTx } from '@kasuwa/db';
import {
  measureCustomVisibleSize,
  readProjectedCustom,
  type CustomFilters,
} from '@kasuwa/domain-core';
import {
  CUSTOM_FIELD_LIMITS,
  customFieldsSchema,
  customIssueDetails,
  customWithheldAnywhere,
  isCustomFieldKey,
  jsonbTextOctets,
  loadCustomFieldAccess,
  notEditableCustomKeys,
  PICKLIST_VALUE_PATTERN,
  readableCustomKeys,
  readableCustomKeysByProgramme,
  splitCustomPatch,
  visibleCustomValues,
  withheldCustomKeys,
  type CustomFieldAccess,
  type CustomFieldDef,
  type CustomFieldObject,
  type CustomPatch,
} from '@kasuwa/metadata-engine';
import { validationFailed, type AdminErrorDetail } from '../admin/common/admin-errors';

/**
 * Custom-field values at the record APIs' boundary (T-0089; ADR-0016 items
 * 3-8; D-L128, D-L138, D-L140, D-L141). Every record service (contacts,
 * leads, accounts, activities, deals, the board) goes through these, so the
 * rules hold in one place:
 *
 *   - DEFINITIONS ARE READ LIVE, per request (V9): `loadCustom` is one round
 *     trip for the live definitions and the caller's access to each.
 *   - ORDER. 403 `field_not_editable` for a key the caller may not edit in the
 *     row's programme (the create's target) comes before every 400 on the same
 *     body (V5), so a bad value for a key one may not edit is 403, never
 *     `invalid_value`. Only keys that ARE live custom fields are judged for
 *     403; anything else is a 400 afterwards.
 *   - VALIDATION is the per-object Zod schema built from the live definitions
 *     (`customFieldsSchema`, `.strict()`); its details carry paths and codes,
 *     never a value, and a malformed key is reported at `custom`, never named.
 *   - SIZE (D-L140, D-L141): 16 KiB, measured on what the caller can read in
 *     the row's programme plus what it writes; withheld and retired bytes
 *     never count, and a write that does not grow that size is never refused.
 *   - READS are the SQL projection (`readProjectedCustom`) plus the second
 *     layer (`visibleCustomValues`). A withheld key is listed as
 *     `custom.<key>` whether or not the row holds a value (V1); a retired key
 *     is in neither (V2).
 *   - AUDIT records custom changes by KEY ONLY, whatever the classification
 *     (ADR-0016 item 7): a tenant may classify free text as `none`.
 *   - NOTHING HERE LOGS, and no error carries a value (D-L140).
 */

export type { CustomFieldAccess } from '@kasuwa/metadata-engine';

/** The live custom definitions of `object` and the caller's access to each. */
export function loadCustom(tx: TenantTx, object: CustomFieldObject): Promise<CustomFieldAccess> {
  return loadCustomFieldAccess(tx, object);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The body's own `custom`, or undefined when it sent none. */
export function rawCustomOf(raw: Record<string, unknown>): unknown {
  return Object.prototype.hasOwnProperty.call(raw, 'custom') ? raw.custom : undefined;
}

/**
 * The 403 paths of a raw body's `custom`: `custom.<key>` for each live key
 * the caller may not edit in `programmeId`, value or `null` alike (V5).
 * Judged on the raw body, before any parsing.
 */
export function customNotEditablePaths(
  custom: CustomFieldAccess,
  programmeId: string,
  raw: Record<string, unknown>,
): string[] {
  const value = rawCustomOf(raw);
  if (!isPlainObject(value)) return [];
  return notEditableCustomKeys(custom, programmeId, Object.keys(value)).map((key) => `custom.${key}`);
}

const tooLarge = () => validationFailed([{ path: 'custom', code: 'custom_too_large' }]);

/**
 * A create's `custom`: the values to set, `{}` when absent. 400 with the
 * schema's details otherwise. On a new row every key is one the caller writes
 * (and may edit), so the size is simply the values'.
 */
export function parseCustomCreate(
  custom: CustomFieldAccess,
  rawCustom: unknown,
): Record<string, unknown> {
  if (rawCustom === undefined) return {};
  const parsed = customFieldsSchema([...custom.defs.values()], 'create').safeParse(rawCustom);
  if (!parsed.success) throw validationFailed(customIssueDetails(parsed.error));
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined && value !== null) values[key] = value;
  }
  if (jsonbTextOctets(values) > CUSTOM_FIELD_LIMITS.apiBytes) throw tooLarge();
  return values;
}

/** An update's `custom` as a merge patch; undefined when the body sent none. */
export function parseCustomPatch(
  custom: CustomFieldAccess,
  rawCustom: unknown,
): CustomPatch | undefined {
  if (rawCustom === undefined) return undefined;
  const parsed = customFieldsSchema([...custom.defs.values()], 'patch').safeParse(rawCustom);
  if (!parsed.success) throw validationFailed(customIssueDetails(parsed.error));
  // Every custom write also drops the object's retired keys from the row (D-L142).
  return { ...splitCustomPatch(parsed.data), drop: [...custom.retired] };
}

/** True for Postgres's refusal by 0039's size backstop on any of the four tables. */
export function isCustomBackstopRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return (
    code === '23514' &&
    typeof constraint === 'string' &&
    /^(contact|account|activity|deal)_custom_size$/.test(constraint)
  );
}

/**
 * Runs a record write; 0039's size backstop refusing it is `400
 * custom_too_large` at `custom`, never a 500 (D-L142). The backstop is out of
 * reach of the API's own rules, so this is belt and braces. Anything else is
 * rethrown untouched.
 */
export async function customBackstopAs400<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isCustomBackstopRefusal(error)) throw tooLarge();
    throw error;
  }
}

/** D-L140 and D-L141: refused only when the visible size passes 16 KiB AND the write grows it. */
export function customWriteTooLarge(size: { before: number; after: number }): boolean {
  return size.after > CUSTOM_FIELD_LIMITS.apiBytes && size.after > size.before;
}

/**
 * The size check of an update, measured in SQL on the row (two integers come
 * back, never a value). Withheld and retired keys are outside `readable`, so
 * they never count (no size oracle); keys being written are always inside it,
 * since a caller may only write keys it may edit.
 */
export async function assertCustomPatchFits(
  tx: TenantTx,
  custom: CustomFieldAccess,
  target: { id: string; programmeId: string },
  patch: CustomPatch,
): Promise<void> {
  const readable = new Set(readableCustomKeys(custom, target.programmeId));
  for (const key of Object.keys(patch.set)) readable.add(key);
  const size = await measureCustomVisibleSize(tx, custom.object, target, [...readable], patch);
  if (size !== null && customWriteTooLarge(size)) throw tooLarge();
}

/** The keys a write touched, for the audit (by key only). */
export function customPatchKeys(patch: CustomPatch | undefined): string[] {
  if (patch === undefined) return [];
  return [...Object.keys(patch.set), ...patch.remove].sort();
}

/**
 * Records `event` with one REDACTED change per custom key (by key only). Moved
 * into @kasuwa/domain-core by T-0094 so the import worker shares it; re-exported
 * here so every record service keeps its import path.
 */
export { recordAuditWithCustom } from '@kasuwa/domain-core';

/** A record's `custom` on the wire, and the withheld paths to append to its `withheldFields`. */
export interface CustomWire {
  custom: Record<string, unknown>;
  withheld: string[];
}

/** For a record shape that carries `custom` but whose read failed to find the row (never served). */
export const EMPTY_CUSTOM_WIRE: CustomWire = Object.freeze({ custom: {}, withheld: [] }) as CustomWire;

/** One row's wire custom from what the projection returned, the second layer applied. */
export function customWireOf(
  custom: CustomFieldAccess,
  programmeId: string,
  projected: unknown,
): CustomWire {
  return {
    custom: visibleCustomValues(custom, programmeId, projected),
    withheld: withheldCustomKeys(custom, programmeId).map((key) => `custom.${key}`),
  };
}

/**
 * The wire custom of each row, by id: ONE projected read for the page, then
 * the second layer per row. A row the read did not return (impossible for a
 * row the same transaction just read) gets `{}` and its withheld list: never
 * more than the projection allowed.
 */
export async function customWiresFor(
  tx: TenantTx,
  custom: CustomFieldAccess,
  rows: readonly { id: string; programmeId: string }[],
): Promise<Map<string, CustomWire>> {
  const programmes = [...new Set(rows.map((row) => row.programmeId))];
  const projected = await readProjectedCustom(
    tx,
    custom.object,
    rows.map((row) => row.id),
    readableCustomKeysByProgramme(custom, programmes),
  );
  const result = new Map<string, CustomWire>();
  for (const row of rows) {
    result.set(row.id, customWireOf(custom, row.programmeId, projected.get(row.id)));
  }
  return result;
}

/** One row's wire custom (a get, or the answer to a write). */
export async function customWireFor(
  tx: TenantTx,
  custom: CustomFieldAccess,
  row: { id: string; programmeId: string },
): Promise<CustomWire> {
  return (await customWiresFor(tx, custom, [row])).get(row.id) ?? EMPTY_CUSTOM_WIRE;
}

// --- filters (ADR-0016 item 8; records.openapi.yaml CustomFilter, CustomEmptyFilter) ---

/** At most this many keys per parameter (the contract's maxProperties / maxItems). */
const MAX_FILTER_KEYS = 10;

const CUSTOM_PARAMETER = /^custom\[(.*)\]$/su;

/**
 * The custom filters of a raw list query, judged against the live definitions
 * and the caller's access. Undefined when the query names none.
 *
 * Every refusal is 400 `validation_failed`, never a value echoed:
 *   - a key that is not a custom api name: `unknown_field` at the parameter
 *     (`custom` or `customEmpty`), the key never named (D-L140);
 *   - an unknown or retired key: `unknown_field` at `custom.<key>`;
 *   - a key withheld from the caller in ANY programme it reaches:
 *     `field_withheld` (D-L88), so the filter is never an oracle for a value
 *     the caller cannot read somewhere in its scope;
 *   - a text, number, currency or date field: `filter_not_supported`;
 *   - a picklist value it does not define: `unknown_value`; anything that is
 *     not one picklist value, or `true`/`false` for a boolean: `invalid_value`.
 * Accepts both query parser shapes: `custom[key]` as a flat key (Express 5's
 * default) and `custom: { key }` (the extended parser).
 */
export function customFiltersFrom(
  custom: CustomFieldAccess,
  rawQuery: unknown,
): CustomFilters | undefined {
  const query = isPlainObject(rawQuery) ? rawQuery : {};
  const details: AdminErrorDetail[] = [];
  const once = new Set<string>();
  const refuse = (path: string, code: string) => {
    const id = `${path}\u0000${code}`;
    if (once.has(id)) return;
    once.add(id);
    details.push({ path, code });
  };

  const equalsRaw: [string, unknown][] = [];
  for (const [parameter, value] of Object.entries(query)) {
    const match = CUSTOM_PARAMETER.exec(parameter);
    if (match !== null) equalsRaw.push([match[1] ?? '', value]);
  }
  if (Object.prototype.hasOwnProperty.call(query, 'custom')) {
    const nested = query.custom;
    if (isPlainObject(nested)) equalsRaw.push(...Object.entries(nested));
    else refuse('custom', 'unknown_field');
  }
  const emptyRaw: unknown[] = [];
  if (Object.prototype.hasOwnProperty.call(query, 'customEmpty')) {
    const value = query.customEmpty;
    emptyRaw.push(...(Array.isArray(value) ? value : [value]));
  }
  if (equalsRaw.length === 0 && emptyRaw.length === 0 && details.length === 0) return undefined;
  if (equalsRaw.length > MAX_FILTER_KEYS) refuse('custom', 'too_big');
  if (emptyRaw.length > MAX_FILTER_KEYS) refuse('customEmpty', 'too_big');

  /** A well-formed key's verdict: the definition when it may be filtered, null after a refusal. */
  const judge = (key: string): CustomFieldDef | undefined => {
    const def = custom.defs.get(key);
    let code: string | null = null;
    if (def === undefined) code = 'unknown_field';
    else if (customWithheldAnywhere(custom, key)) code = 'field_withheld';
    else if (def.type !== 'picklist' && def.type !== 'boolean') code = 'filter_not_supported';
    if (code === null) return def;
    refuse(`custom.${key}`, code);
    return undefined;
  };

  const equals: { key: string; value: string | boolean }[] = [];
  const seen = new Set<string>();
  for (const [key, value] of equalsRaw) {
    if (!isCustomFieldKey(key)) {
      refuse('custom', 'unknown_field');
      continue;
    }
    const def = judge(key);
    if (def === undefined) continue;
    if (typeof value !== 'string' || seen.has(key)) {
      refuse(`custom.${key}`, 'invalid_value');
      continue;
    }
    seen.add(key);
    if (def.type === 'boolean') {
      if (value === 'true' || value === 'false') equals.push({ key, value: value === 'true' });
      else refuse(`custom.${key}`, 'invalid_value');
    } else if (!PICKLIST_VALUE_PATTERN.test(value)) {
      refuse(`custom.${key}`, 'invalid_value');
    } else if (!def.values.includes(value)) {
      refuse(`custom.${key}`, 'unknown_value');
    } else {
      equals.push({ key, value });
    }
  }

  const empty: string[] = [];
  for (const key of emptyRaw) {
    if (!isCustomFieldKey(key)) {
      refuse('customEmpty', 'unknown_field');
      continue;
    }
    if (judge(key) === undefined) continue;
    if (!empty.includes(key)) empty.push(key);
  }

  if (details.length > 0) throw validationFailed(details);
  // The SQL evaluates the filters on the PROJECTED custom (D-L142): the same
  // readable lists as a read, so it fails closed on its own.
  return { equals, empty, readable: readableCustomKeysByProgramme(custom, [...custom.access.keys()]) };
}
