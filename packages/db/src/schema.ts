import {
  boolean,
  char,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Typed mirror of packages/db/migrations/*.sql.
 *
 * The SQL migrations are the source of truth, NOT this file: RLS policies,
 * FORCE ROW LEVEL SECURITY, composite foreign keys and grants have no Drizzle
 * representation, and generating migrations from this schema would silently
 * drop them. Drizzle is used here as a typed query builder only.
 *
 * Drift between the two is caught by the integration test
 * `packages/db/src/__tests__/schema-invariants.integration.test.ts`, which asserts
 * over pg_catalog that every table in this file exists, has RLS enabled AND
 * forced, and carries at least one policy. Adding a table here without a
 * migration (or a migration without RLS) fails that test.
 */

export const tenant = pgTable('tenant', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  regionCell: text('region_cell').notNull().default('za-1'),
  localeDefault: text('locale_default').notNull().default('en-NG'),
  currencyDefault: char('currency_default', { length: 3 }).notNull().default('NGN'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const businessUnit = pgTable(
  'business_unit',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('business_unit_tenant_idx').on(table.tenantId)],
);

export const programme = pgTable(
  'programme',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    businessUnitId: uuid('business_unit_id').notNull(),
    name: text('name').notNull(),
    clientName: text('client_name'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('programme_tenant_idx').on(table.tenantId)],
);

/** Table name is the reserved word `user`; Drizzle quotes identifiers, so this is safe. */
export const user = pgTable(
  'user',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    locale: text('locale').notNull().default('en-NG'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('user_tenant_idx').on(table.tenantId),
    uniqueIndex('user_tenant_email_key').on(table.tenantId, table.email),
  ],
);

export const userProgramme = pgTable(
  'user_programme',
  {
    userId: uuid('user_id').notNull(),
    programmeId: uuid('programme_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    skills: text('skills').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.programmeId] }),
    index('user_programme_tenant_user_idx').on(table.tenantId, table.userId),
  ],
);

export const contact = pgTable(
  'contact',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    programmeId: uuid('programme_id').notNull(),
    displayName: text('display_name').notNull(),
    givenNames: text('given_names'),
    familyName: text('family_name'),
    phones: jsonb('phones').notNull().default([]),
    emails: jsonb('emails').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('contact_keyset_idx').on(table.tenantId, table.programmeId, table.createdAt, table.id),
  ],
);

/**
 * Custom object definitions (M15).
 *
 * Tenant-scoped and deliberately NOT programme-scoped — see the header of
 * packages/db/migrations/0002_metadata_object_and_field_def.sql before adding
 * a `programmeId` column here. The isolation suite asserts the exception
 * positively.
 */
export const objectDef = pgTable(
  'object_def',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    apiName: text('api_name').notNull(),
    label: text('label').notNull(),
    pluralLabel: text('plural_label'),
    description: text('description'),
    isCustom: boolean('is_custom').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('object_def_tenant_idx').on(table.tenantId),
    // Per tenant, never global: two tenants must both be able to use a name.
    uniqueIndex('object_def_tenant_id_api_name_key').on(table.tenantId, table.apiName),
  ],
);

/** Custom field definitions (M15). Tenant-scoped, not programme-scoped. */
export const fieldDef = pgTable(
  'field_def',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    objectId: uuid('object_id').notNull(),
    apiName: text('api_name').notNull(),
    label: text('label').notNull(),
    type: text('type').notNull(),
    description: text('description'),
    isRequired: boolean('is_required').notNull().default(false),
    isCustom: boolean('is_custom').notNull().default(true),
    config: jsonb('config').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('field_def_tenant_object_idx').on(table.tenantId, table.objectId),
    uniqueIndex('field_def_tenant_id_object_id_api_name_key').on(
      table.tenantId,
      table.objectId,
      table.apiName,
    ),
  ],
);

/**
 * Every table that carries tenant data. The schema-invariant test iterates this
 * list; adding a table to the schema without adding it here fails that test too.
 */
export const TENANT_SCOPED_TABLES = [
  'tenant',
  'business_unit',
  'programme',
  'user',
  'user_programme',
  'contact',
  'object_def',
  'field_def',
] as const;

export type TenantScopedTable = (typeof TENANT_SCOPED_TABLES)[number];
