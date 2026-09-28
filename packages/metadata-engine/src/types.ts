import { z } from 'zod';
import { apiNameSchema } from './api-name';

/**
 * The metadata model: object and field definitions (M15, T-0002).
 *
 * Zod at the boundary — parse, do not cast. Rows read back from Postgres are
 * parsed too: the database is a boundary like any other, and a definition read
 * from it is about to drive generated API behaviour.
 *
 * NOTE ON SCOPE. There is no `programmeId` on either type, and that is
 * deliberate: metadata is tenant-scoped, not programme-scoped. See the header
 * of packages/db/migrations/0002_metadata_object_and_field_def.sql.
 */

/** The P0 field types from the PRD. Mirrors field_def_type_check in 0002. */
export const FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'currency',
  'date',
  'datetime',
  'boolean',
  'picklist',
  'multipicklist',
  'lookup',
  'formula',
  'rollup',
  'phone',
  'email',
  'url',
  'nin',
] as const;

export const fieldTypeSchema = z.enum(FIELD_TYPES);
export type FieldType = z.infer<typeof fieldTypeSchema>;

const uuidSchema = z.string().uuid();
const labelSchema = z.string().min(1).max(255);

export const objectDefSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  apiName: apiNameSchema,
  label: labelSchema,
  pluralLabel: labelSchema.nullable(),
  description: z.string().max(2000).nullable(),
  isCustom: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ObjectDef = z.infer<typeof objectDefSchema>;

/**
 * Input for creating an object definition.
 *
 * `tenantId` is absent on purpose. The session decides scope; a caller that can
 * name its own tenant is a tenancy bug. The repository takes it from
 * `tx.session.tenantId`.
 */
export const createObjectDefInputSchema = z.object({
  id: uuidSchema.optional(),
  apiName: apiNameSchema,
  label: labelSchema,
  pluralLabel: labelSchema.nullish(),
  description: z.string().max(2000).nullish(),
  isCustom: z.boolean().default(true),
});
export type CreateObjectDefInput = z.input<typeof createObjectDefInputSchema>;

/** Type-specific settings. Shape varies by type; validated per type below. */
export const fieldConfigSchema = z.record(z.unknown());

export const fieldDefSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  objectId: uuidSchema,
  apiName: apiNameSchema,
  label: labelSchema,
  type: fieldTypeSchema,
  description: z.string().max(2000).nullable(),
  isRequired: z.boolean(),
  isCustom: z.boolean(),
  config: fieldConfigSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type FieldDef = z.infer<typeof fieldDefSchema>;

export const createFieldDefInputSchema = z.object({
  id: uuidSchema.optional(),
  objectId: uuidSchema,
  apiName: apiNameSchema,
  label: labelSchema,
  type: fieldTypeSchema,
  description: z.string().max(2000).nullish(),
  isRequired: z.boolean().default(false),
  isCustom: z.boolean().default(true),
  config: fieldConfigSchema.default({}),
});
export type CreateFieldDefInput = z.input<typeof createFieldDefInputSchema>;

/**
 * Per-type configuration rules.
 *
 * Bounded deliberately: a picklist with ten thousand values, or a definition
 * that can nominate an arbitrary lookup target, is a denial-of-service endpoint
 * with a friendly name. The limits are conservative and can be raised by a
 * decision, not by a hotfix.
 */
export const MAX_PICKLIST_VALUES = 500;

const picklistConfigSchema = z.object({
  values: z
    .array(z.object({ value: apiNameSchema, label: labelSchema }))
    .min(1)
    .max(MAX_PICKLIST_VALUES),
});

const lookupConfigSchema = z.object({
  /** api_name of the target object, resolved against the catalogue on write. */
  targetObjectApiName: apiNameSchema,
});

const currencyConfigSchema = z.object({
  /** ISO 4217. Money is minor units plus a currency code, never a float. */
  currencyCode: z.string().length(3).toUpperCase(),
});

/**
 * Validates `config` for the given type. Returns the parsed config.
 * Types with no configuration accept only an empty object, so that a typo in a
 * config key is an error rather than silently ignored data.
 */
export function parseFieldConfig(type: FieldType, config: unknown): Record<string, unknown> {
  switch (type) {
    case 'picklist':
    case 'multipicklist':
      return picklistConfigSchema.parse(config);
    case 'lookup':
      return lookupConfigSchema.parse(config);
    case 'currency':
      return currencyConfigSchema.parse(config);
    default:
      return z.object({}).strict().parse(config);
  }
}
