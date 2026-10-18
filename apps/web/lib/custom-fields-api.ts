import { z } from 'zod';
import { request, type Result } from './admin-api';

/**
 * The browser's half of the custom-field operations in
 * `docs/api/admin.openapi.yaml` (T-0088, served since T-0089):
 * `listCustomFields`, `createCustomField`, `updateCustomField` and
 * `retireCustomField`. The P18 customisation studio (T-0090) reads and writes
 * through here and nowhere else.
 *
 * SAME-ORIGIN, ZOD-PARSED, NO SCOPE. Relative `/api/v1/...` paths rewritten by
 * `next.config.mjs`; a definition is tenant-wide (ADR-0008), so nothing here
 * carries a programme, a tenant or a header that names one. The session decides
 * who is asking and the API decides whether they may write (`custom_field.write`).
 *
 * RETIRE, NEVER DELETE (D-L128 Q3). There is no delete here because there is
 * none in the contract, and no restore either.
 *
 * Errors come back as `ScreenError`s from the shared admin transport: `code` is
 * the contract's fixed enum and `details[0].code` is the reason the studio
 * localises by its own label. The English `message` is never read.
 */

export const CUSTOM_FIELDS_PATH = '/api/v1/admin/custom-fields';

export const CUSTOM_FIELD_OBJECTS = ['contact', 'account', 'activity', 'deal'] as const;
export const CustomFieldObject = z.enum(CUSTOM_FIELD_OBJECTS);
export type CustomFieldObject = z.infer<typeof CustomFieldObject>;

/** The six Phase 2 types (ADR-0016 item 4). No other type is ever offered. */
export const CUSTOM_FIELD_TYPES = ['text', 'number', 'currency', 'date', 'picklist', 'boolean'] as const;
export const CustomFieldType = z.enum(CUSTOM_FIELD_TYPES);
export type CustomFieldType = z.infer<typeof CustomFieldType>;

/** `none < pii < sensitive` (D-L45). */
export const CLASSIFICATIONS = ['none', 'pii', 'sensitive'] as const;
export const Classification = z.enum(CLASSIFICATIONS);
export type Classification = z.infer<typeof Classification>;

/** The one currency a currency field holds, fixed for its life (D-L128 Q6). */
export const CURRENCY_CODES = ['NGN', 'GHS', 'KES', 'ZAR'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export const PicklistValue = z.object({ value: z.string(), label: z.string() });
export type PicklistValue = z.infer<typeof PicklistValue>;

/** `values` for a picklist, `currencyCode` for a currency, `{}` for the rest. */
const FieldConfig = z.union([
  z.object({ values: z.array(PicklistValue) }),
  z.object({ currencyCode: z.string() }),
  z.object({}),
]);

export const CustomFieldDefinition = z.object({
  id: z.string(),
  objectApiName: CustomFieldObject,
  apiName: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  type: CustomFieldType,
  classification: Classification,
  config: FieldConfig,
  retiredAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CustomFieldDefinition = z.infer<typeof CustomFieldDefinition>;

/** The limits arrive as data so a screen never hard-codes them (D-L141). */
const CustomFieldLimits = z.object({
  fieldsPerObject: z.number().int(),
  picklistValues: z.number().int(),
});
export type CustomFieldLimits = z.infer<typeof CustomFieldLimits>;

export const CustomFieldList = z.object({
  objectApiName: CustomFieldObject,
  limits: CustomFieldLimits,
  items: z.array(CustomFieldDefinition),
});
export type CustomFieldList = z.infer<typeof CustomFieldList>;

/** The picklist values a definition carries, in stored order. */
export function picklistValuesOf(field: CustomFieldDefinition): readonly PicklistValue[] {
  return 'values' in field.config ? field.config.values : [];
}

/** The currency a definition carries, or null. */
export function currencyOf(field: CustomFieldDefinition): string | null {
  return 'currencyCode' in field.config ? field.config.currencyCode : null;
}

/** The closed create body: only the contract's properties (D-L138). */
export interface CreateCustomFieldBody {
  objectApiName: CustomFieldObject;
  apiName: string;
  label: string;
  type: CustomFieldType;
  classification: Classification;
  description?: string;
  /** Only for picklist (`values`) and currency (`currencyCode`); absent otherwise. */
  config?: { values: readonly PicklistValue[] } | { currencyCode: string };
}

/** The closed update body: only what changed. Never the type, api name, config or currency. */
export interface UpdateCustomFieldBody {
  label?: string;
  description?: string | null;
  classification?: Classification;
  addValues?: readonly PicklistValue[];
  relabelValues?: readonly PicklistValue[];
}

/**
 * Every custom field of one object, retired ones included: the studio filters
 * them on its own "show retired" control, and needs them either way to say
 * which api names are taken for ever (D-L140, D-L141).
 */
export function listCustomFields(
  object: CustomFieldObject,
  signal?: AbortSignal,
): Promise<Result<CustomFieldList>> {
  const query = new URLSearchParams({ object, includeRetired: 'true' });
  return request('GET', `${CUSTOM_FIELDS_PATH}?${query.toString()}`, CustomFieldList, {
    noStore: true,
    ...(signal ? { signal } : {}),
  });
}

export function createCustomField(body: CreateCustomFieldBody): Promise<Result<CustomFieldDefinition>> {
  return request('POST', CUSTOM_FIELDS_PATH, CustomFieldDefinition, { body, noStore: true });
}

export function updateCustomField(
  fieldId: string,
  body: UpdateCustomFieldBody,
): Promise<Result<CustomFieldDefinition>> {
  return request('PATCH', `${CUSTOM_FIELDS_PATH}/${encodeURIComponent(fieldId)}`, CustomFieldDefinition, {
    body,
    noStore: true,
  });
}

/** Retire: a POST with no body. There is no delete and no restore. */
export function retireCustomField(fieldId: string): Promise<Result<CustomFieldDefinition>> {
  return request('POST', `${CUSTOM_FIELDS_PATH}/${encodeURIComponent(fieldId)}/retire`, CustomFieldDefinition, {
    noStore: true,
  });
}
