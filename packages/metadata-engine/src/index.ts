/**
 * Metadata engine — custom objects and custom fields (PRD M15, T-0002).
 *
 * Scope today: `object_def` and `field_def` only. Layouts, validation rules,
 * record types, `custom_record` storage and the formula engine are later tasks
 * and deliberately absent.
 *
 * THE ONE THING TO KNOW BEFORE CHANGING ANYTHING HERE
 *
 * Metadata is tenant-scoped and deliberately NOT programme-scoped. A custom
 * field belongs to the tenant, not to one client engagement: a BPO's own admin
 * configures the objects its agents use across every programme. The exception
 * is documented in the header of
 * packages/db/migrations/0002_metadata_object_and_field_def.sql and asserted
 * positively by tests/acceptance/metadata.
 */

export * from './api-name';
export * from './repository';
export * from './types';
export * from './field-security';
