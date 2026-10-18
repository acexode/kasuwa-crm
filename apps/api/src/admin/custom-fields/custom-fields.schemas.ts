import {
  CUSTOM_FIELD_CURRENCIES,
  CUSTOM_FIELD_LIMITS,
  CUSTOM_FIELD_OBJECTS,
  CUSTOM_FIELD_TYPES,
  FIELD_CLASSIFICATIONS,
  hasLoneSurrogate,
  isCustomFieldKey,
  PICKLIST_VALUE_PATTERN,
  type CustomFieldDefinition,
  type CustomFieldType,
} from '@kasuwa/metadata-engine';
import { z } from 'zod';
import type { AdminErrorDetail } from '../common/admin-errors';
import { NUL_REASON, text } from '../../common/text';

/**
 * Boundary schemas for the custom-field admin API (T-0088 contract, served by
 * T-0089): docs/api/admin.openapi.yaml, tag `custom-fields`. Parse, never
 * cast (CLAUDE.md 4).
 *
 * Every body is CLOSED (`.strict()`): `isRequired`, `programmeId`, `id`,
 * `retiredAt`, a tenant id or any unknown key is 400. The update body has no
 * `type`, `apiName`, `objectApiName` or `config`: the type and the currency
 * never change, and picklist values are added or relabelled, never removed.
 *
 * Every refusal carries a stable `params.reason`, which the admin filter
 * turns into `details[].code`; no detail ever echoes the value sent.
 */

/**
 * Free text with `text()`'s rules plus no lone UTF-16 surrogate (D-L142):
 * one is not a character and cannot be stored as UTF-8, so it is
 * `invalid_character` (the NUL code), never a silently corrupted label.
 */
function labelText(min: number, max: number) {
  return text(min, max).superRefine((value, context) => {
    if (hasLoneSurrogate(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'contains a lone surrogate',
        params: { reason: NUL_REASON },
      });
    }
  });
}

export const CustomFieldIdParam = z.object({ fieldId: z.string().uuid() });

export const ListCustomFieldsQuery = z
  .object({
    object: z.enum(CUSTOM_FIELD_OBJECTS),
    includeRetired: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict();

const isCustomFieldType = (value: string): value is CustomFieldType =>
  (CUSTOM_FIELD_TYPES as readonly string[]).includes(value);

export const CreateCustomFieldBody = z
  .object({
    objectApiName: z.enum(CUSTOM_FIELD_OBJECTS),
    apiName: z.string().refine(isCustomFieldKey, {
      message: 'not a custom api name',
      params: { reason: 'invalid_api_name' },
    }),
    label: labelText(1, 255),
    type: z.string().refine(isCustomFieldType, {
      message: 'not a Phase 2 type',
      params: { reason: 'unsupported_type' },
    }),
    classification: z.enum(FIELD_CLASSIFICATIONS).default('none'),
    description: labelText(0, 2000).nullable().optional(),
    config: z.unknown().optional(),
  })
  .strict();
export type CreateCustomFieldBody = z.infer<typeof CreateCustomFieldBody>;

const PicklistValue = z
  .object({
    value: z.string().regex(PICKLIST_VALUE_PATTERN),
    label: labelText(1, 255),
  })
  .strict();

export const UpdateCustomFieldBody = z
  .object({
    label: labelText(1, 255).optional(),
    description: labelText(0, 2000).nullable().optional(),
    classification: z.enum(FIELD_CLASSIFICATIONS).optional(),
    addValues: z.array(PicklistValue).min(1).max(CUSTOM_FIELD_LIMITS.picklistValues).optional(),
    relabelValues: z.array(PicklistValue).min(1).max(CUSTOM_FIELD_LIMITS.picklistValues).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'an update must change something',
    path: [],
    params: { reason: 'nothing_to_update' },
  });
export type UpdateCustomFieldBody = z.infer<typeof UpdateCustomFieldBody>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const problem = (path: string, code: string) => ({ ok: false as const, details: [{ path, code }] });

/**
 * A create's `config`, judged against its type (A2, D-L141, D-L128 Q6):
 *   - picklist: exactly `values`, 1 to 500 of `{ value, label }`, each value
 *     an api name and unique (`duplicate_value`); anything else is
 *     `invalid_config`, at `config.values` for the values themselves;
 *   - currency: exactly `currencyCode`, three capitals (`invalid_config`),
 *     one of NGN, GHS, KES or ZAR (`unknown_currency`);
 *   - every other type: no config, or `{}` (`invalid_config` at `config`).
 * Returns the config to store, or the details. Never echoes a value.
 */
export function createConfig(
  type: CustomFieldType,
  config: unknown,
): { ok: true; config: Record<string, unknown> } | { ok: false; details: AdminErrorDetail[] } {
  switch (type) {
    case 'picklist': {
      if (!isPlainObject(config) || Object.keys(config).some((key) => key !== 'values')) {
        return problem('config', 'invalid_config');
      }
      const values = config.values;
      if (!Array.isArray(values) || values.length < 1 || values.length > CUSTOM_FIELD_LIMITS.picklistValues) {
        return problem('config.values', 'invalid_config');
      }
      const parsed = z.array(PicklistValue).safeParse(values);
      if (!parsed.success) return problem('config.values', 'invalid_config');
      const seen = new Set<string>();
      for (const entry of parsed.data) {
        if (seen.has(entry.value)) return problem('config.values', 'duplicate_value');
        seen.add(entry.value);
      }
      return { ok: true, config: { values: parsed.data } };
    }
    case 'currency': {
      if (!isPlainObject(config) || Object.keys(config).some((key) => key !== 'currencyCode')) {
        return problem('config', 'invalid_config');
      }
      const code = config.currencyCode;
      if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) {
        return problem('config.currencyCode', 'invalid_config');
      }
      if (!(CUSTOM_FIELD_CURRENCIES as readonly string[]).includes(code)) {
        return problem('config.currencyCode', 'unknown_currency');
      }
      return { ok: true, config: { currencyCode: code } };
    }
    default:
      if (config === undefined || (isPlainObject(config) && Object.keys(config).length === 0)) {
        return { ok: true, config: {} };
      }
      return problem('config', 'invalid_config');
  }
}

/** A picklist's stored values, as `{ value, label }` (a malformed config reads as none). */
export function picklistValuesOf(definition: CustomFieldDefinition): { value: string; label: string }[] {
  const parsed = z.array(PicklistValue).safeParse(definition.config['values']);
  return parsed.success ? parsed.data : [];
}

export type ValuesPlan =
  | { kind: 'unchanged' }
  | { kind: 'changed'; config: Record<string, unknown>; added: string[]; relabelled: string[] }
  | { kind: 'invalid'; details: AdminErrorDetail[] }
  | { kind: 'limit_reached' };

/**
 * `addValues` and `relabelValues` against the stored definition (D-L139,
 * D-L141): on a field that is not a picklist, `not_a_picklist` at `addValues`;
 * a relabel naming a value the field does not have, `unknown_value` at
 * `relabelValues`; adding a value the field has, or the same one twice,
 * `duplicate_value` at `addValues`; past 500 values, `limit_reached` (the
 * caller answers 409). Values are appended in order and never removed.
 */
export function planValues(definition: CustomFieldDefinition, body: UpdateCustomFieldBody): ValuesPlan {
  if (body.addValues === undefined && body.relabelValues === undefined) return { kind: 'unchanged' };
  if (definition.type !== 'picklist') {
    return { kind: 'invalid', details: [{ path: 'addValues', code: 'not_a_picklist' }] };
  }
  const values = picklistValuesOf(definition).map((entry) => ({ ...entry }));
  const details: AdminErrorDetail[] = [];
  const relabelled: string[] = [];
  for (const entry of body.relabelValues ?? []) {
    const existing = values.find((candidate) => candidate.value === entry.value);
    if (existing === undefined) {
      details.push({ path: 'relabelValues', code: 'unknown_value' });
      break;
    }
    existing.label = entry.label;
    relabelled.push(entry.value);
  }
  const added: string[] = [];
  for (const entry of body.addValues ?? []) {
    if (values.some((candidate) => candidate.value === entry.value)) {
      details.push({ path: 'addValues', code: 'duplicate_value' });
      break;
    }
    values.push({ value: entry.value, label: entry.label });
    added.push(entry.value);
  }
  if (details.length > 0) return { kind: 'invalid', details };
  if (values.length > CUSTOM_FIELD_LIMITS.picklistValues) return { kind: 'limit_reached' };
  return { kind: 'changed', config: { values }, added, relabelled };
}

/** `#/components/schemas/CustomFieldDefinition` on the wire. Never a value, never a record count. */
export interface CustomFieldDefinitionWire {
  id: string;
  objectApiName: string;
  apiName: string;
  label: string;
  description: string | null;
  type: string;
  classification: string;
  config: Record<string, unknown>;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The config as the contract serves it: `values` for a picklist, `currencyCode` for a currency, `{}` otherwise. */
function configWire(definition: CustomFieldDefinition): Record<string, unknown> {
  if (definition.type === 'picklist') return { values: picklistValuesOf(definition) };
  if (definition.type === 'currency') {
    const code = definition.config['currencyCode'];
    return typeof code === 'string' ? { currencyCode: code } : {};
  }
  return {};
}

export function toCustomFieldDefinitionWire(definition: CustomFieldDefinition): CustomFieldDefinitionWire {
  return {
    id: definition.id,
    objectApiName: definition.objectApiName,
    apiName: definition.apiName,
    label: definition.label,
    description: definition.description,
    type: definition.type,
    classification: definition.classification,
    config: configWire(definition),
    retiredAt: definition.retiredAt === null ? null : definition.retiredAt.toISOString(),
    createdAt: definition.createdAt.toISOString(),
    updatedAt: definition.updatedAt.toISOString(),
  };
}
