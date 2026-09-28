import { z } from 'zod';

/**
 * api_name validation.
 *
 * An api_name is attacker-controlled input that later reaches URLs, generated
 * API shapes and (once the dynamic query layer exists) SQL identifiers. It is
 * validated here, and again by a CHECK constraint in
 * packages/db/migrations/0002_metadata_object_and_field_def.sql, so a future
 * code path that forgets to parse still cannot store something unquotable.
 *
 * Nothing in this package ever concatenates an api_name into SQL. Queries are
 * parameterised; when a later task needs a real identifier it must resolve it
 * against the catalogue rather than quote user input.
 */

/** Lower snake_case, starts with a letter, ends alphanumeric, 2..63 characters. */
export const API_NAME_PATTERN = /^[a-z][a-z0-9_]{0,61}[a-z0-9]$/;

/**
 * Names a tenant may not take.
 *
 * Two groups: SQL reserved words (`user` is the one already double-quoted
 * throughout the hand-written SQL) and the system columns every row carries. A
 * custom field called `tenant_id` would be a name collision at exactly the
 * layer where a collision is a tenancy bug.
 */
export const RESERVED_API_NAMES: readonly string[] = [
  'id',
  'tenant_id',
  'programme_id',
  'created_at',
  'updated_at',
  'user',
  'select',
  'insert',
  'update',
  'delete',
  'from',
  'where',
  'table',
  'order',
  'group',
  'default',
  'null',
  'true',
  'false',
];

export const apiNameSchema = z
  .string()
  .regex(API_NAME_PATTERN, 'api_name must be lower snake_case, 2 to 63 characters')
  .refine((value) => !RESERVED_API_NAMES.includes(value), { message: 'api_name is reserved' });

export function isValidApiName(value: string): boolean {
  return apiNameSchema.safeParse(value).success;
}
