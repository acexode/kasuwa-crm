import {
  bigint,
  boolean,
  char,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * `bytea` as a Node Buffer. Drizzle has no built-in for it.
 *
 * Used for the two columns that hold a digest — a session token hash and a
 * hashed sign-in identifier. Both are fixed-width binary and neither is ever
 * rendered, so bytea rather than text avoids an encoding to get wrong.
 */
const customBytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * The generation expression of the six folded search columns (migration 0038,
 * T-0086). Mirrored AS GENERATED so Drizzle's insert and update types leave
 * them out (Postgres refuses a value for them, SQLSTATE 428C9) and no
 * row-copy helper tries to write one. The expression itself lives only in the
 * migration, the source of truth: this placeholder is a bare SQL comment, so
 * DDL generated from it would be a syntax error, never a wrong fold.
 */
const FOLDED_IN_0038 = sql.raw(
  '/* the fold in packages/db/migrations/0038_search_prefix_columns.sql */',
);

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
  /** RoleList.version — the role hierarchy's optimistic-concurrency counter (0006). */
  roleHierarchyVersion: integer('role_hierarchy_version').notNull().default(1),
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
    /** active | paused | draft | archived — CHECK `programme_status_check` (0012). */
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
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
    /** The one tenant-wide role this person holds, if any (0006). */
    roleId: uuid('role_id'),
    /**
     * D-L53: a tenant-level permission flag, never derived from membership and
     * never a scope (D-L06). Not writable by kasuwa_app (0015 column grants).
     *
     * Consequence: kasuwa_app holds only COLUMN-level INSERT/UPDATE on "user".
     * A Drizzle `insert(user)` as kasuwa_app emits every column, this one
     * included, and fails with a privilege error. Writes to "user" from the
     * app must name only granted columns.
     */
    isTenantAdmin: boolean('is_tenant_admin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('user_tenant_role_idx').on(table.tenantId, table.roleId),
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
    /**
     * The permission set this person holds in this programme (D-P9, 0015).
     * NULL means no permission. Composite FK `(tenant_id, permission_set_id)`
     * -> `permission_set (tenant_id, id)`.
     */
    permissionSetId: uuid('permission_set_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.programmeId] }),
    index('user_programme_tenant_user_idx').on(table.tenantId, table.userId),
    index('user_programme_tenant_permission_set_idx').on(table.tenantId, table.permissionSetId),
  ],
);

// --- contact value sets (D-L61) -------------------------------------------
// Stored values are snake_case codes; display labels live in @kasuwa/i18n.
// Enforced by CHECK constraints in 0019; these lists must match them exactly.

export const CONTACT_STATUSES = [
  'new',
  'contacted',
  'qualified',
  'unqualified',
  'customer',
] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const CONTACT_SOURCES = [
  'whatsapp',
  'ussd',
  'web_form',
  'missed_call',
  'import',
  'api',
  'manual',
  'referral',
  'walk_in',
] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];

export const CONTACT_PREFERRED_CHANNELS = ['whatsapp', 'sms', 'voice', 'email'] as const;
export type ContactPreferredChannel = (typeof CONTACT_PREFERRED_CHANNELS)[number];

/** NOT NULL, default 'unknown'. Never defaults to consent. */
export const CONTACT_CONSENT_STATES = ['unknown', 'opted_in', 'pending', 'withdrawn'] as const;
export type ContactConsentState = (typeof CONTACT_CONSENT_STATES)[number];

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
    // --- M3 fields (migration 0019, T-0040, D-L61) ---
    /** Composite FK (tenant_id, owner_user_id) -> "user" (tenant_id, id). */
    ownerUserId: uuid('owner_user_id'),
    status: text('status', { enum: CONTACT_STATUSES }),
    source: text('source', { enum: CONTACT_SOURCES }),
    tags: text('tags').array(),
    /** BCP-47 tag, format-checked in SQL. */
    preferredLanguage: text('preferred_language'),
    preferredChannel: text('preferred_channel', { enum: CONTACT_PREFERRED_CHANNELS }),
    state: text('state'),
    lga: text('lga'),
    /**
     * false means "not known to be on the NCC register", NOT "checked and clear".
     * No promotional send may rely on it (D-L61).
     */
    dnd: boolean('dnd').notNull().default(false),
    whatsappOptIn: boolean('whatsapp_opt_in').notNull().default(false),
    consentState: text('consent_state', { enum: CONTACT_CONSENT_STATES })
      .notNull()
      .default('unknown'),
    phoneNetwork: text('phone_network'),
    /** Composite FK (tenant_id, programme_id, account_id) -> account. */
    accountId: uuid('account_id'),
    /** Optimistic-concurrency counter (T-0039); kept moving by app.bump_version(). */
    version: integer('version').notNull().default(1),
    /**
     * Migration 0028 (T-0076, D-P17): free-text company, 1..200 characters
     * (CHECK, NOT VALID). Not a link: account_id is. Classified pii (D-L82).
     */
    companyName: text('company_name'),
    // --- Migration 0038 (T-0086): folded search copies, generated and stored ---
    displayNameSearch: text('display_name_search').generatedAlwaysAs(FOLDED_IN_0038),
    givenNamesSearch: text('given_names_search').generatedAlwaysAs(FOLDED_IN_0038),
    familyNameSearch: text('family_name_search').generatedAlwaysAs(FOLDED_IN_0038),
    companyNameSearch: text('company_name_search').generatedAlwaysAs(FOLDED_IN_0038),
    /**
     * Migration 0039 (T-0089, ADR-0016): custom-field values, keyed by the
     * field_def api_name (`...__c`). Guarded by three CHECKs (object, at most
     * 32 KiB, every key `^[a-z][a-z0-9_]*__c$`). Programme-scoped by the row;
     * withheld keys are projected out in SQL and never read whole by the API.
     */
    custom: jsonb('custom').notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    /** Migration 0027: the target of activity's composite contact FK. */
    uniqueIndex('contact_tenant_programme_id_key').on(table.tenantId, table.programmeId, table.id),
    index('contact_keyset_idx').on(table.tenantId, table.programmeId, table.createdAt, table.id),
    /** Migration 0035 (T-0084): tenant-led list orders, usable under FORCE RLS (D-P33). */
    index('contact_tenant_created_keyset_idx').on(table.tenantId, table.createdAt, table.id),
    index('contact_tenant_updated_keyset_idx').on(table.tenantId, table.updatedAt, table.id),
    index('contact_tenant_display_name_keyset_idx').on(
      table.tenantId,
      table.displayName,
      table.id,
    ),
    /** Migration 0035: programme-led, for a one-programme session's scalar predicate (M1). */
    index('contact_programme_updated_keyset_idx').on(
      table.tenantId,
      table.programmeId,
      table.updatedAt,
      table.id,
    ),
    index('contact_programme_display_name_keyset_idx').on(
      table.tenantId,
      table.programmeId,
      table.displayName,
      table.id,
    ),
    index('contact_account_idx')
      .on(table.tenantId, table.programmeId, table.accountId)
      .where(sql`account_id IS NOT NULL`),
    index('contact_owner_idx')
      .on(table.tenantId, table.ownerUserId)
      .where(sql`owner_user_id IS NOT NULL`),
    /** Migration 0038 (T-0086): the prefix indexes (the folded key is COLLATE "C" there). */
    index('contact_display_name_search_idx').on(
      table.tenantId,
      table.programmeId,
      table.displayNameSearch,
      table.id,
    ),
    index('contact_given_names_search_idx').on(
      table.tenantId,
      table.programmeId,
      table.givenNamesSearch,
      table.id,
    ),
    index('contact_family_name_search_idx').on(
      table.tenantId,
      table.programmeId,
      table.familyNameSearch,
      table.id,
    ),
    index('contact_company_name_search_idx').on(
      table.tenantId,
      table.programmeId,
      table.companyNameSearch,
      table.id,
    ),
    /** Migration 0038: their partial twins for the leads view (T-0086 review fix 2). */
    index('contact_display_name_search_lead_idx')
      .on(table.tenantId, table.programmeId, table.displayNameSearch, table.id)
      .where(sql`status IN ('new', 'contacted', 'qualified', 'unqualified')`),
    index('contact_given_names_search_lead_idx')
      .on(table.tenantId, table.programmeId, table.givenNamesSearch, table.id)
      .where(sql`status IN ('new', 'contacted', 'qualified', 'unqualified')`),
    index('contact_family_name_search_lead_idx')
      .on(table.tenantId, table.programmeId, table.familyNameSearch, table.id)
      .where(sql`status IN ('new', 'contacted', 'qualified', 'unqualified')`),
    index('contact_company_name_search_lead_idx')
      .on(table.tenantId, table.programmeId, table.companyNameSearch, table.id)
      .where(sql`status IN ('new', 'contacted', 'qualified', 'unqualified')`),
    /** Migration 0031 (T-0103): a programme removal reads only that programme's owned rows. */
    index('contact_owner_programme_idx')
      .on(table.tenantId, table.ownerUserId, table.programmeId)
      .where(sql`owner_user_id IS NOT NULL`),
  ],
);

// --- account value sets (T-0054) -------------------------------------------
// The records contract's `AccountTier` (T-0052). Enforced by
// account_tier_check in 0026; this list must match it exactly.
export const ACCOUNT_TIERS = ['enterprise', 'mid_market', 'sme'] as const;
export type AccountTier = (typeof ACCOUNT_TIERS)[number];

/**
 * The deepest an account may sit in its hierarchy; a top-level account is
 * depth 1 (D-L74). Enforced by app.guard_account_hierarchy() in 0026.
 */
export const ACCOUNT_MAX_DEPTH = 5;

/**
 * Programme-scoped exactly like contact (migration 0019, T-0040). A contact
 * links to an account in its own programme only.
 */
export const account = pgTable(
  'account',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    programmeId: uuid('programme_id').notNull(),
    name: text('name').notNull(),
    /** Optimistic-concurrency counter (T-0039); kept moving by app.bump_version(). */
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Maintained by the app.touch_updated_at() trigger when a statement leaves it unchanged. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // --- the T-0052 contract's fields (migration 0026, T-0054) ---
    /**
     * Composite FK (tenant_id, owner_user_id) -> "user" (tenant_id, id). That
     * the owner belongs to the account's programme (D-L67) is the repository's
     * check, not the schema's.
     */
    ownerUserId: uuid('owner_user_id'),
    industry: text('industry'),
    tier: text('tier', { enum: ACCOUNT_TIERS }),
    /** Never null; no NULL element (account_tags_no_null_element_check). */
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The contract's Phone list, shape-checked in SQL by app.is_phone_list(). */
    phones: jsonb('phones').notNull().default([]),
    state: text('state'),
    lga: text('lga'),
    /**
     * Composite FK (tenant_id, programme_id, parent_account_id) -> account: a
     * parent is always in the same programme. No cycle, depth at most
     * ACCOUNT_MAX_DEPTH (the 0026 hierarchy guard).
     */
    parentAccountId: uuid('parent_account_id'),
    /** Migration 0038 (T-0086): the folded search copy of `name`, generated and stored. */
    nameSearch: text('name_search').generatedAlwaysAs(FOLDED_IN_0038),
    /**
     * Migration 0039 (T-0089, ADR-0016): custom-field values, keyed by the
     * field_def api_name (`...__c`). Guarded by three CHECKs (object, at most
     * 32 KiB, every key `^[a-z][a-z0-9_]*__c$`). Programme-scoped by the row;
     * withheld keys are projected out in SQL and never read whole by the API.
     */
    custom: jsonb('custom').notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    /** Migration 0038 (T-0086): the prefix index (the folded key is COLLATE "C" there). */
    index('account_name_search_idx').on(
      table.tenantId,
      table.programmeId,
      table.nameSearch,
      table.id,
    ),
    uniqueIndex('account_tenant_id_programme_id_id_key').on(
      table.tenantId,
      table.programmeId,
      table.id,
    ),
    index('account_keyset_idx').on(table.tenantId, table.programmeId, table.createdAt, table.id),
    index('account_name_keyset_idx').on(table.tenantId, table.programmeId, table.name, table.id),
    /** Migration 0035 (T-0084): tenant-led list orders, usable under FORCE RLS (D-P33). */
    index('account_tenant_created_keyset_idx').on(table.tenantId, table.createdAt, table.id),
    index('account_tenant_updated_keyset_idx').on(table.tenantId, table.updatedAt, table.id),
    index('account_tenant_name_keyset_idx').on(table.tenantId, table.name, table.id),
    /** Migration 0035: programme-led, for a one-programme session's scalar predicate (M1). */
    index('account_programme_updated_keyset_idx').on(
      table.tenantId,
      table.programmeId,
      table.updatedAt,
      table.id,
    ),
    index('account_owner_idx')
      .on(table.tenantId, table.ownerUserId)
      .where(sql`owner_user_id IS NOT NULL`),
    index('account_parent_idx')
      .on(table.tenantId, table.programmeId, table.parentAccountId)
      .where(sql`parent_account_id IS NOT NULL`),
  ],
);

// --- activity (migration 0027, T-0060) --------------------------------------

/** The activity kinds: codes, never labels (a CHECK in 0027; `meeting` since 0034). */
export const ACTIVITY_TYPES = ['note', 'task', 'call', 'meeting'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/**
 * A note, a task or a logged call against a contact, an account or both
 * (migration 0027, T-0060). Programme-scoped like contact; every FK is
 * composite and carries tenant_id, and the contact and account FKs carry
 * programme_id too, so a target is always in the activity's own programme.
 *
 * Not expressed here (SQL only): at least one target is set; due_at and
 * completed_at are for tasks only; a meeting has both starts_at and ends_at,
 * end after start, and nothing else has either (0034); id, tenant_id and programme_id are fixed
 * for every role but kasuwa_migrator (app.guard_activity_keys_fixed); and
 * kasuwa_app may not DELETE (a restrictive policy). subject and body are free
 * text that may hold PII: never log them.
 */
export const activity = pgTable(
  'activity',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    programmeId: uuid('programme_id').notNull(),
    type: text('type', { enum: ACTIVITY_TYPES }).notNull(),
    subject: text('subject'),
    body: text('body'),
    /** Tasks only. */
    dueAt: timestamp('due_at', { withTimezone: true }),
    /** Tasks only. */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Meetings only (0034, T-0082). */
    startsAt: timestamp('starts_at', { withTimezone: true }),
    /** Meetings only, after starts_at (0034, T-0082). */
    endsAt: timestamp('ends_at', { withTimezone: true }),
    /** Composite FK (tenant_id, owner_user_id) -> "user" (tenant_id, id). */
    ownerUserId: uuid('owner_user_id'),
    /** Composite FK (tenant_id, programme_id, contact_id) -> contact. */
    contactId: uuid('contact_id'),
    /** Composite FK (tenant_id, programme_id, account_id) -> account. */
    accountId: uuid('account_id'),
    /**
     * The deal link (0037, T-0111): a link, never a target. Composite FK
     * (tenant_id, programme_id, deal_id) -> deal (tenant_id, programme_id, id),
     * RESTRICT on update and delete.
     */
    dealId: uuid('deal_id'),
    /** Composite FK (tenant_id, created_by_user_id) -> "user". NULL is the system. */
    createdByUserId: uuid('created_by_user_id'),
    /** Optimistic-concurrency counter; kept moving by app.bump_version(). */
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Maintained by the app.touch_updated_at() trigger when a statement leaves it unchanged. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Migration 0039 (T-0089, ADR-0016): custom-field values, keyed by the
     * field_def api_name (`...__c`). Guarded by three CHECKs (object, at most
     * 32 KiB, every key `^[a-z][a-z0-9_]*__c$`). Programme-scoped by the row;
     * withheld keys are projected out in SQL and never read whole by the API.
     */
    custom: jsonb('custom').notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    index('activity_contact_keyset_idx')
      .on(
        table.tenantId,
        table.programmeId,
        table.contactId,
        table.createdAt.desc(),
        table.id.desc(),
      )
      .where(sql`contact_id IS NOT NULL`),
    index('activity_account_keyset_idx')
      .on(
        table.tenantId,
        table.programmeId,
        table.accountId,
        table.createdAt.desc(),
        table.id.desc(),
      )
      .where(sql`account_id IS NOT NULL`),
    index('activity_owner_due_idx')
      .on(table.tenantId, table.ownerUserId, table.dueAt)
      .where(sql`owner_user_id IS NOT NULL`),
    /** listMyActivities (0034): the owner's open tasks by due time, undated last. */
    index('activity_owner_open_task_due_idx')
      .on(table.tenantId, table.ownerUserId, table.dueAt, table.id)
      .where(sql`type = 'task' AND completed_at IS NULL`),
    /** listCalendar (0034): the owner's meetings by start. */
    index('activity_owner_meeting_starts_idx')
      .on(table.tenantId, table.ownerUserId, table.startsAt, table.id)
      .where(sql`type = 'meeting'`),
    /** The deal timeline (0037, T-0111): one deal's activities, newest first, and the FK lookup. */
    index('activity_deal_keyset_idx')
      .on(table.tenantId, table.programmeId, table.dealId, table.createdAt.desc(), table.id.desc())
      .where(sql`deal_id IS NOT NULL`),
    /** Not partial: the tenant and programme FK lookup, and a programme-wide feed. */
    index('activity_programme_recent_idx').on(
      table.tenantId,
      table.programmeId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  ],
);

// --- in-call scripts (migration 0030, T-0113) ------------------------------

/** The seven design-menu locales a script is written or translated in (D-L91). */
export const SCRIPT_LOCALES = ['en', 'fr', 'pcm', 'ha', 'yo', 'ig', 'sw'] as const;

/**
 * A programme's script and its DRAFT (0030). Keys fixed at creation for every
 * role but the migrator (app.guard_script_keys_fixed). `revision` is the
 * draft's concurrency token; `publishedRevision` the revision the latest
 * version was published from.
 */
export const script = pgTable(
  'script',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    programmeId: uuid('programme_id').notNull(),
    name: text('name').notNull(),
    sourceLocale: text('source_locale', { enum: SCRIPT_LOCALES }).notNull(),
    /**
     * The draft ScriptGraph; Zod-validated by the API, an object here. The
     * default is the empty draft: one end node that is also the start.
     */
    draftGraph: jsonb('draft_graph')
      .notNull()
      .default(
        sql`'{"startNodeId": "start", "nodes": [{"id": "start", "type": "end", "title": "End"}]}'::jsonb`,
      ),
    draftTranslations: jsonb('draft_translations').notNull().default(sql`'{}'::jsonb`),
    revision: integer('revision').notNull().default(1),
    publishedRevision: integer('published_revision'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Maintained by the app.touch_updated_at() trigger when a statement leaves it unchanged. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('script_tenant_programme_id_key').on(table.tenantId, table.programmeId, table.id),
    /** Name in COLLATE "C" in the migration; Drizzle has no collation on an index column. */
    index('script_name_keyset_idx').on(table.tenantId, table.name, table.id),
  ],
);

/**
 * A PUBLISHED script version (0030): immutable for every role
 * (app.refuse_script_version_update), and deleted only by the migrator or an
 * offboarding cascade. No updated_at, on purpose.
 */
export const scriptVersion = pgTable(
  'script_version',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    programmeId: uuid('programme_id').notNull(),
    /** Composite FK (tenant_id, programme_id, script_id) -> script, RESTRICT both ways. */
    scriptId: uuid('script_id').notNull(),
    number: integer('number').notNull(),
    name: text('name').notNull(),
    sourceLocale: text('source_locale', { enum: SCRIPT_LOCALES }).notNull(),
    graph: jsonb('graph').notNull(),
    translations: jsonb('translations').notNull().default(sql`'{}'::jsonb`),
    changes: text('changes').array().notNull().default(sql`'{}'::text[]`),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    /** Composite FK (tenant_id, published_by_user_id) -> "user". */
    publishedByUserId: uuid('published_by_user_id'),
  },
  (table) => [
    uniqueIndex('script_version_number_key').on(
      table.tenantId,
      table.programmeId,
      table.scriptId,
      table.number,
    ),
    /** 0032: the target of script_run's version FK (a run names a version of its own script). */
    uniqueIndex('script_version_script_id_key').on(
      table.tenantId,
      table.programmeId,
      table.scriptId,
      table.id,
    ),
  ],
);

/** A run's lifecycle (0032, T-0114). */
export const SCRIPT_RUN_STATUSES = ['in_progress', 'stopped', 'completed'] as const;
export const SCRIPT_RUN_OUTCOMES = ['completed', 'interrupted', 'superseded'] as const;
export const SCRIPT_RUN_STOP_REASONS = ['field_withheld', 'sensitive_field'] as const;

/**
 * One agent walking one published version for one contact (0032, T-0114).
 * The keys, the pinned version, the contact and the agent are fixed for every
 * role but the migrator (app.guard_script_run_keys_fixed). `answers` is
 * classified `sensitive` (D-L93): never logged, audited or echoed. No
 * updated_at, on purpose: `revision` is the concurrency token.
 */
export const scriptRun = pgTable(
  'script_run',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    /** The contact's programme, fixed at start. */
    programmeId: uuid('programme_id').notNull(),
    scriptId: uuid('script_id').notNull(),
    /** Composite FK (tenant_id, programme_id, script_id, version_id) -> script_version, RESTRICT. */
    versionId: uuid('version_id').notNull(),
    /** Composite FK (tenant_id, programme_id, contact_id) -> contact, RESTRICT both ways. */
    contactId: uuid('contact_id').notNull(),
    /** Composite FK (tenant_id, started_by_user_id) -> "user". The run's own agent. */
    startedByUserId: uuid('started_by_user_id').notNull(),
    status: text('status', { enum: SCRIPT_RUN_STATUSES }).notNull().default('in_progress'),
    outcome: text('outcome', { enum: SCRIPT_RUN_OUTCOMES }),
    stopReason: text('stop_reason', { enum: SCRIPT_RUN_STOP_REASONS }),
    currentNodeId: text('current_node_id'),
    endedAtNodeId: text('ended_at_node_id'),
    path: jsonb('path').notNull().default(sql`'[]'::jsonb`),
    acknowledgements: jsonb('acknowledgements').notNull().default(sql`'[]'::jsonb`),
    /** Classified `sensitive` (D-L93). */
    answers: jsonb('answers').notNull().default(sql`'{}'::jsonb`),
    unacknowledgedComplianceNodeIds: text('unacknowledged_compliance_node_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    dispositionId: uuid('disposition_id'),
    activityId: uuid('activity_id'),
    followUpTaskId: uuid('follow_up_task_id'),
    /** SHA-256 of the completing request, for the exact-repeat rule (D-L91). */
    completionDigest: text('completion_digest'),
    revision: integer('revision').notNull().default(1),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    /** Partial in the migration: WHERE status = 'in_progress'. */
    uniqueIndex('script_run_in_progress_key').on(
      table.tenantId,
      table.programmeId,
      table.startedByUserId,
      table.contactId,
      table.scriptId,
    ),
    index('script_run_contact_idx').on(table.tenantId, table.programmeId, table.contactId),
    /** The agent FK's RESTRICT lookup: offboarding deletes every user of a tenant. */
    index('script_run_started_by_idx').on(table.tenantId, table.startedByUserId),
    index('script_run_version_idx').on(
      table.tenantId,
      table.programmeId,
      table.scriptId,
      table.versionId,
    ),
  ],
);

// --- pipelines and deals (migration 0036, T-0106) ---------------------------

/** Stage kinds (a CHECK in 0036): exactly one won and one lost per pipeline. */
export const PIPELINE_STAGE_KINDS = ['open', 'won', 'lost'] as const;
/** Requirement kinds (a CHECK in 0036). */
export const PIPELINE_REQUIREMENT_KINDS = ['field', 'check'] as const;
/** The currencies a deal may carry (D-L115; a CHECK in 0036). Never converted. */
export const DEAL_CURRENCIES = ['NGN', 'GHS', 'KES', 'ZAR'] as const;

/**
 * A programme's pipeline (0036). Every programme has a default one, from
 * DEFAULT_PIPELINE_TEMPLATE. Keys fixed for every role but the migrator
 * (app.guard_pipeline_keys_fixed, as on the five tables below); kasuwa_app may
 * read and insert, never update or delete.
 */
export const pipeline = pgTable(
  'pipeline',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    programmeId: uuid('programme_id').notNull(),
    name: text('name').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Maintained by the app.touch_updated_at() trigger when a statement leaves it unchanged. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('pipeline_tenant_programme_id_key').on(table.tenantId, table.programmeId, table.id),
  ],
);

/**
 * A stage (0036). Not expressed here (SQL only): one won and one lost stage,
 * at least one open, at most 30 per pipeline (a deferred constraint trigger);
 * probability 0..10000 (won 10000, lost 0); rotting_after_days 2..365 on open
 * stages and NULL on won and lost.
 */
export const pipelineStage = pgTable(
  'pipeline_stage',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    programmeId: uuid('programme_id').notNull(),
    /** Composite FK (tenant_id, programme_id, pipeline_id) -> pipeline. */
    pipelineId: uuid('pipeline_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: PIPELINE_STAGE_KINDS }).notNull(),
    position: integer('position').notNull(),
    probabilityBp: integer('probability_bp').notNull(),
    rottingAfterDays: integer('rotting_after_days').default(14),
  },
  (table) => [
    uniqueIndex('pipeline_stage_pipeline_id_key').on(
      table.tenantId,
      table.programmeId,
      table.pipelineId,
      table.id,
    ),
    uniqueIndex('pipeline_stage_position_key').on(
      table.tenantId,
      table.programmeId,
      table.pipelineId,
      table.position,
    ),
  ],
);

/** The move allow-list (0036): a (from, to) pair once per pipeline, never a self-pair. */
export const pipelineStageTransition = pgTable(
  'pipeline_stage_transition',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    programmeId: uuid('programme_id').notNull(),
    pipelineId: uuid('pipeline_id').notNull(),
    /** Composite FK (tenant_id, programme_id, pipeline_id, from_stage_id) -> pipeline_stage. */
    fromStageId: uuid('from_stage_id').notNull(),
    /** Composite FK (tenant_id, programme_id, pipeline_id, to_stage_id) -> pipeline_stage. */
    toStageId: uuid('to_stage_id').notNull(),
  },
  (table) => [
    uniqueIndex('pipeline_stage_transition_pair_key').on(
      table.tenantId,
      table.programmeId,
      table.pipelineId,
      table.fromStageId,
      table.toStageId,
    ),
    index('pipeline_stage_transition_to_idx').on(
      table.tenantId,
      table.programmeId,
      table.pipelineId,
      table.toStageId,
    ),
  ],
);

/**
 * An entry requirement of a stage (0036). `field` holds a deal field_def
 * api_name (snake_case, R2) and no label; `check` a label of 1..200 and no
 * field. position 0..19, unique per stage.
 */
export const pipelineStageRequirement = pgTable(
  'pipeline_stage_requirement',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    programmeId: uuid('programme_id').notNull(),
    pipelineId: uuid('pipeline_id').notNull(),
    /** Composite FK (tenant_id, programme_id, pipeline_id, stage_id) -> pipeline_stage. */
    stageId: uuid('stage_id').notNull(),
    kind: text('kind', { enum: PIPELINE_REQUIREMENT_KINDS }).notNull(),
    position: integer('position').notNull(),
    field: text('field'),
    label: text('label'),
  },
  (table) => [
    uniqueIndex('pipeline_stage_requirement_pipeline_id_key').on(
      table.tenantId,
      table.programmeId,
      table.pipelineId,
      table.id,
    ),
    uniqueIndex('pipeline_stage_requirement_position_key').on(
      table.tenantId,
      table.programmeId,
      table.pipelineId,
      table.stageId,
      table.position,
    ),
  ],
);

/**
 * A deal (0036). Money is `amount_minor` bigint (0 to 18 nines, D-L121) plus
 * `currency`, both or neither; never a float. name and next_step are free
 * text classified pii (D-L115): never log them. Not expressed here (SQL only): stage_id changes
 * only along a transition of the deal's pipeline for every role but the
 * migrator (app.guard_deal_stage_move, R5); kasuwa_app may not DELETE.
 */
export const deal = pgTable(
  'deal',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    programmeId: uuid('programme_id').notNull(),
    pipelineId: uuid('pipeline_id').notNull(),
    /** Composite FK (tenant_id, programme_id, pipeline_id, stage_id) -> pipeline_stage. */
    stageId: uuid('stage_id').notNull(),
    name: text('name').notNull(),
    /** bigint minor units (D-L121); a JS bigint, never a JS number (18 nines exceeds 2^53). */
    amountMinor: bigint('amount_minor', { mode: 'bigint' }),
    currency: text('currency', { enum: DEAL_CURRENCIES }),
    expectedCloseDate: date('expected_close_date'),
    /** Composite FK (tenant_id, owner_user_id) -> "user". */
    ownerUserId: uuid('owner_user_id'),
    /** Composite FK (tenant_id, programme_id, primary_contact_id) -> contact, RESTRICT. */
    primaryContactId: uuid('primary_contact_id'),
    /** Composite FK (tenant_id, programme_id, account_id) -> account, RESTRICT. */
    accountId: uuid('account_id'),
    nextStep: text('next_step'),
    stageEnteredAt: timestamp('stage_entered_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Maintained by the app.touch_updated_at() trigger when a statement leaves it unchanged. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Migration 0038 (T-0086): the folded search copy of `name`, generated and stored. */
    nameSearch: text('name_search').generatedAlwaysAs(FOLDED_IN_0038),
    /**
     * Migration 0039 (T-0089, ADR-0016): custom-field values, keyed by the
     * field_def api_name (`...__c`). Guarded by three CHECKs (object, at most
     * 32 KiB, every key `^[a-z][a-z0-9_]*__c$`). Programme-scoped by the row;
     * withheld keys are projected out in SQL and never read whole by the API.
     */
    custom: jsonb('custom').notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    /** Migration 0038 (T-0086): the prefix index (the folded key is COLLATE "C" there). */
    index('deal_name_search_idx').on(
      table.tenantId,
      table.programmeId,
      table.nameSearch,
      table.id,
    ),
    uniqueIndex('deal_pipeline_id_key').on(
      table.tenantId,
      table.programmeId,
      table.pipelineId,
      table.id,
    ),
    /** 0037 (T-0111): the target of activity's composite deal FK. */
    uniqueIndex('deal_tenant_programme_id_key').on(table.tenantId, table.programmeId, table.id),
    /** R14: an open board column. */
    index('deal_board_open_idx').on(
      table.tenantId,
      table.programmeId,
      table.pipelineId,
      table.stageId,
      table.stageEnteredAt,
      table.id,
    ),
    /** R14: a won or lost column, newest first. */
    index('deal_board_closed_idx')
      .on(
        table.tenantId,
        table.programmeId,
        table.pipelineId,
        table.stageId,
        table.closedAt.desc(),
        table.id.desc(),
      )
      .where(sql`closed_at IS NOT NULL`),
    index('deal_contact_idx')
      .on(table.tenantId, table.programmeId, table.primaryContactId)
      .where(sql`primary_contact_id IS NOT NULL`),
    index('deal_account_idx')
      .on(table.tenantId, table.programmeId, table.accountId)
      .where(sql`account_id IS NOT NULL`),
    index('deal_owner_idx')
      .on(table.tenantId, table.ownerUserId)
      .where(sql`owner_user_id IS NOT NULL`),
  ],
);

/** A ticked check requirement (0036): once per deal and requirement; insert-only for kasuwa_app. */
export const dealRequirementCheck = pgTable(
  'deal_requirement_check',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    programmeId: uuid('programme_id').notNull(),
    pipelineId: uuid('pipeline_id').notNull(),
    /** Composite FK (tenant_id, programme_id, pipeline_id, deal_id) -> deal. */
    dealId: uuid('deal_id').notNull(),
    /** Composite FK (tenant_id, programme_id, pipeline_id, requirement_id) -> requirement. */
    requirementId: uuid('requirement_id').notNull(),
    /** Composite FK (tenant_id, checked_by_user_id) -> "user". */
    checkedByUserId: uuid('checked_by_user_id').notNull(),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('deal_requirement_check_once_key').on(
      table.tenantId,
      table.programmeId,
      table.pipelineId,
      table.dealId,
      table.requirementId,
    ),
    index('deal_requirement_check_requirement_idx').on(
      table.tenantId,
      table.programmeId,
      table.pipelineId,
      table.requirementId,
    ),
    index('deal_requirement_check_checked_by_idx').on(table.tenantId, table.checkedByUserId),
  ],
);

// --- authentication (migration 0002) ---------------------------------------
// Identity only. Nothing below records what a user may reach; scope is still
// resolved from user_programme on every request.

export const userCredential = pgTable(
  'user_credential',
  {
    userId: uuid('user_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    passwordHash: text('password_hash').notNull(),
    passwordUpdatedAt: timestamp('password_updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

export const userMfaFactor = pgTable(
  'user_mfa_factor',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    type: text('type').notNull(),
    label: text('label'),
    /**
     * LEGACY base32 TOTP secret, in plaintext. Nullable since 0005.
     *
     * Being replaced by the four `secret*` columns below (envelope encryption,
     * D-L13). Writers populate both during the expand phase; readers take the
     * envelope first and fall back to this. The contract migration drops it.
     * Never selected into a response, in either form.
     */
    secret: text('secret'),
    /** TOTP secret under AES-256-GCM with a per-secret data key: iv || tag || body. */
    secretCiphertext: customBytea('secret_ciphertext'),
    /** The data key, wrapped by this environment's KMS key. */
    secretWrappedKey: customBytea('secret_wrapped_key'),
    /** Which KMS key wrapped it. Per row, so a rotation can be incremental. */
    secretKeyId: text('secret_key_id'),
    /** On-disk format marker, e.g. `A256GCM-ENV1`. */
    secretAlgorithm: text('secret_algorithm'),
    /**
     * Highest TOTP step already accepted. A code at or below it is refused, so
     * a code is single-use rather than valid for its whole drift window.
     */
    lastUsedStep: bigint('last_used_step', { mode: 'number' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('user_mfa_factor_tenant_user_idx').on(table.tenantId, table.userId),
    /** The rotation work queue: partial, over encrypted rows only. */
    index('user_mfa_factor_secret_key_id_idx').on(table.secretKeyId),
    /**
     * At most one confirmed and one pending factor per user and type (0017),
     * so a replacement can be confirmed while the old factor keeps working.
     */
    uniqueIndex('user_mfa_factor_confirmed_key')
      .on(table.tenantId, table.userId, table.type)
      .where(sql`confirmed_at IS NOT NULL`),
    uniqueIndex('user_mfa_factor_pending_key')
      .on(table.tenantId, table.userId, table.type)
      .where(sql`confirmed_at IS NULL`),
  ],
);

/**
 * Single-use MFA backup codes (migration 0017, T-0012).
 *
 * The code itself is never stored. `codeHash` is HMAC-SHA256 under a per-set
 * data key that is stored only wrapped by the KeyProvider (D-L13), so a dump of
 * this table is not something guesses can be tested against offline.
 */
export const userMfaBackupCode = pgTable(
  'user_mfa_backup_code',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    codeHash: customBytea('code_hash').notNull(),
    hashKeyWrapped: customBytea('hash_key_wrapped').notNull(),
    hashKeyId: text('hash_key_id').notNull(),
    hashAlgorithm: text('hash_algorithm').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('user_mfa_backup_code_user_hash_key').on(
      table.tenantId,
      table.userId,
      table.codeHash,
    ),
    index('user_mfa_backup_code_unused_idx')
      .on(table.tenantId, table.userId)
      .where(sql`used_at IS NULL`),
  ],
);

export const authChallenge = pgTable(
  'auth_challenge',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    method: text('method').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('auth_challenge_expiry_idx').on(table.expiresAt)],
);

export const authSession = pgTable(
  'auth_session',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    /** SHA-256 of the token. The token itself is never stored. */
    tokenHash: customBytea('token_hash').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('auth_session_tenant_user_idx').on(table.tenantId, table.userId),
    index('auth_session_expiry_idx').on(table.expiresAt),
    uniqueIndex('auth_session_token_hash_key').on(table.tokenHash),
  ],
);

/**
 * Failed-attempt counters for sign-in and second-factor verification.
 *
 * NOT TENANT-SCOPED, ON PURPOSE. It is the only such table in the system and
 * the exception is argued in ADR-0009 and in migration 0003, not assumed. In
 * one line: its job is to count failures for a workspace that may not exist, so
 * that a real and a fake workspace answer identically — and a counter that
 * could only be kept for real tenants would give the game away after two
 * requests.
 *
 * Listed in NON_TENANT_SCOPED_TABLES below so the catalogue invariant's
 * exemption is named rather than silent.
 */
export const authRateLimit = pgTable(
  'auth_rate_limit',
  {
    /** SHA-256 of a purpose-prefixed key. Never an address, never a tenant id. */
    keyHash: customBytea('key_hash').primaryKey(),
    failedCount: integer('failed_count').notNull().default(0),
    firstFailedAt: timestamp('first_failed_at', { withTimezone: true }).notNull().defaultNow(),
    lastFailedAt: timestamp('last_failed_at', { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
  },
  (table) => [index('auth_rate_limit_expiry_idx').on(table.lastFailedAt)],
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
    /** The field-security matrix's optimistic-concurrency version (0009). */
    fieldSecurityVersion: integer('field_security_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
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
    /**
     * `none` < `pii` < `sensitive` (0009, D-L45). Drives the matrix's filter and row tag.
     * On a standard field (`isCustom` false) any role may raise it, never lower it (0029,
     * D-P25): SQLSTATE 23514, constraint `field_def_classification_raise_only`.
     */
    classification: text('classification').notNull().default('none'),
    /**
     * Migration 0039 (T-0089, ADR-0016 item 9): when a custom field was
     * retired; NULL while live. A custom field of a standard object is retired,
     * never deleted, so its api_name stays taken.
     */
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('field_def_tenant_id_object_id_api_name_key').on(
      table.tenantId,
      table.objectId,
      table.apiName,
    ),
  ],
);

/**
 * The role hierarchy (M2, migration 0006). Tenant-wide and deliberately NOT
 * programme-scoped — see the header of 0006 before adding a `programmeId`.
 * Acyclicity is enforced by the API and, independently, by a trigger.
 *
 * Names are unique per tenant CASE-INSENSITIVELY: the SQL index is
 * `role_tenant_name_key ON role (tenant_id, lower(name))`, an expression index
 * Drizzle cannot mirror, so it is named here rather than declared below.
 */
export const role = pgTable(
  'role',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    parentRoleId: uuid('parent_role_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('role_tenant_parent_idx').on(table.tenantId, table.parentRoleId)],
);

/**
 * The field-security matrix's columns (M2, migration 0006). Names sets; defines
 * no grant. Tenant-level per D-P9.
 */
export const permissionSet = pgTable(
  'permission_set',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    locked: boolean('locked').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('permission_set_tenant_id_key_key').on(table.tenantId, table.key)],
);

/**
 * A programme's SLA policy (T-0028, migration 0011). One row per configured
 * programme; no row means the API answers with the platform default (version
 * 0). Programme-scoped. Targets are in `programme_sla_target`.
 */
export const programmeSla = pgTable(
  'programme_sla',
  {
    tenantId: uuid('tenant_id').notNull(),
    programmeId: uuid('programme_id').notNull(),
    version: integer('version').notNull().default(1),
    pauseOutsideOperatingHours: boolean('pause_outside_operating_hours').notNull(),
    pauseAwaitingCustomer: boolean('pause_awaiting_customer').notNull(),
    warnAtPercentOfTarget: integer('warn_at_percent_of_target').notNull(),
    warnNotifyRole: text('warn_notify_role').notNull(),
    breachNotifyRole: text('breach_notify_role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.programmeId] })],
);

/** One channel target of a programme's SLA policy. Integer seconds; null = no target. */
export const programmeSlaTarget = pgTable(
  'programme_sla_target',
  {
    tenantId: uuid('tenant_id').notNull(),
    programmeId: uuid('programme_id').notNull(),
    channel: text('channel').notNull(),
    firstResponseSeconds: integer('first_response_seconds'),
    resolutionSeconds: integer('resolution_seconds'),
    clock: text('clock').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.programmeId, table.channel] })],
);

/**
 * A programme's record-retention policy (T-0028, migration 0011). No row means
 * "not set" (the API answers 404). `callRecordingsDays` is stored, NOT
 * enforced by Kasuwa: recording retention belongs to the telephony platform
 * (D-T4).
 */
export const programmeRetention = pgTable(
  'programme_retention',
  {
    tenantId: uuid('tenant_id').notNull(),
    programmeId: uuid('programme_id').notNull(),
    version: integer('version').notNull().default(1),
    callRecordingsDays: integer('call_recordings_days').notNull(),
    messageTranscriptsDays: integer('message_transcripts_days').notNull(),
    screenRecordingsDays: integer('screen_recordings_days').notNull(),
    qaEvaluationsDays: integer('qa_evaluations_days').notNull(),
    onExpiry: text('on_expiry').notNull(),
    redactSensitiveNumbersInTranscripts: boolean(
      'redact_sensitive_numbers_in_transcripts',
    ).notNull(),
    legalHold: boolean('legal_hold').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.programmeId] })],
);

/**
 * The admin audit log (M2, migration 0008). APPEND-ONLY for kasuwa_app: the
 * migration grants SELECT and INSERT and revokes everything else, and a trigger
 * refuses UPDATE for every role. Events with a `programmeId` are visible only
 * to that programme's members; events without one to the whole tenant (D-L48).
 * The actor's display name is NOT stored - it is joined from "user" at read
 * time, so the log never holds a second copy of anyone's identity.
 */
export const auditEvent = pgTable(
  'audit_event',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    actorKind: text('actor_kind').notNull(),
    actorUserId: uuid('actor_user_id'),
    actorRoleName: text('actor_role_name'),
    action: text('action').notNull(),
    objectType: text('object_type').notNull(),
    objectId: uuid('object_id'),
    objectLabel: text('object_label').notNull(),
    programmeId: uuid('programme_id'),
    changes: jsonb('changes').notNull().default([]),
  },
  (table) => [
    index('audit_event_tenant_actor_idx').on(table.tenantId, table.actorUserId),
    index('audit_event_tenant_object_idx').on(table.tenantId, table.objectId),
    index('audit_event_tenant_programme_idx').on(table.tenantId, table.programmeId),
  ],
);

/**
 * Dispositions (M10 configuration, migration 0010). Programme-scoped, in the
 * `contact` pattern. Soft-deleted (D-L47): a deleted row keeps its `code`,
 * which stays reserved, and has a null `position`. The two unique keys —
 * `(tenant_id, programme_id, code)` and the DEFERRABLE
 * `(tenant_id, programme_id, position)` — are constraints in the SQL; the
 * deferrable one has no Drizzle representation, so neither is declared here.
 */
export const disposition = pgTable('disposition', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  programmeId: uuid('programme_id').notNull(),
  code: text('code').notNull(),
  label: text('label').notNull(),
  category: text('category').notNull(),
  noteRequired: boolean('note_required').notNull().default(false),
  followUpRequired: boolean('follow_up_required').notNull().default(false),
  active: boolean('active').notNull().default(true),
  /** Null exactly when the row is deleted. */
  position: integer('position'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Admin-home alerts (P02/A, migration 0014, T-0031). Programme-scoped: an
 * alert belongs to one programme (D-L47); a tenant-wide alert is stored once
 * per programme it concerns.
 */
export const adminAlert = pgTable(
  'admin_alert',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    programmeId: uuid('programme_id').notNull(),
    severity: text('severity').notNull(),
    category: text('category').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    sourceLabel: text('source_label'),
    raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
    actionLabel: text('action_label'),
    settingId: text('setting_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('admin_alert_tenant_programme_raised_idx').on(
      table.tenantId,
      table.programmeId,
      table.raisedAt.desc(),
    ),
  ],
);

/**
 * Audit-log export requests (migration 0008). Visible only to the requester.
 * Never holds a URL; the file is emailed by a worker that does not exist yet.
 */
export const auditExport = pgTable(
  'audit_export',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    requestedByUserId: uuid('requested_by_user_id').notNull(),
    format: text('format').notNull(),
    scope: text('scope').notNull(),
    filters: jsonb('filters').notNull().default({}),
    includeIpAddresses: boolean('include_ip_addresses').notNull().default(false),
    status: text('status').notNull().default('queued'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('audit_export_tenant_requester_idx').on(table.tenantId, table.requestedByUserId),
  ],
);

/**
 * Per-user alert dismissal (migration 0014). One row per user per alert; the
 * policy admits only the session's own rows.
 */
export const adminAlertDismissal = pgTable(
  'admin_alert_dismissal',
  {
    alertId: uuid('alert_id').notNull(),
    userId: uuid('user_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    programmeId: uuid('programme_id').notNull(),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.alertId, table.userId] }),
    index('admin_alert_dismissal_tenant_user_idx').on(table.tenantId, table.userId),
  ],
);

/**
 * The field-security matrix's decisions (migration 0009, T-0026): one row per
 * (field, permission set). Tenant-level and deliberately NOT programme-scoped
 * (D-P9) - see the header of 0009 before adding a `programmeId`. A missing row
 * means the default level (`edit`, D-L45).
 */
export const fieldSecurityGrant = pgTable(
  'field_security_grant',
  {
    tenantId: uuid('tenant_id').notNull(),
    fieldId: uuid('field_id').notNull(),
    permissionSetId: uuid('permission_set_id').notNull(),
    level: text('level').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.fieldId, table.permissionSetId] }),
    index('field_security_grant_tenant_set_idx').on(table.tenantId, table.permissionSetId),
  ],
);

/**
 * Client-portal users and their pending invitations (M18 groundwork, migration
 * 0013, T-0030). Programme-scoped: a portal user sees exactly one programme.
 * The invite token is never stored, only its SHA-256.
 *
 * Unique per programme on the address CASE-INSENSITIVELY: the SQL index is
 * `portal_user_programme_email_key ON portal_user (tenant_id, programme_id,
 * lower(email))`, an expression index Drizzle cannot mirror.
 */
export const portalUser = pgTable(
  'portal_user',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    programmeId: uuid('programme_id').notNull(),
    /** The invited address. Never returned by a list, never logged. */
    email: text('email').notNull(),
    emailMasked: text('email_masked').notNull(),
    displayName: text('display_name').notNull(),
    access: text('access').notNull(),
    status: text('status').notNull().default('invited'),
    /** SHA-256 of the current invite token. The token itself is never stored. */
    inviteTokenHash: customBytea('invite_token_hash'),
    inviteTokenExpiresAt: timestamp('invite_token_expires_at', { withTimezone: true }),
    invitedAt: timestamp('invited_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('portal_user_programme_list_idx').on(
      table.tenantId,
      table.programmeId,
      table.invitedAt,
      table.id,
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
  'account',
  'activity',
  'script',
  'script_version',
  'script_run',
  'pipeline',
  'pipeline_stage',
  'pipeline_stage_transition',
  'pipeline_stage_requirement',
  'deal',
  'deal_requirement_check',
  'object_def',
  'field_def',
  'user_credential',
  'user_mfa_factor',
  'user_mfa_backup_code',
  'auth_challenge',
  'auth_session',
  'role',
  'permission_set',
  'disposition',
  'admin_alert',
  'admin_alert_dismissal',
  'field_security_grant',
  'programme_sla',
  'programme_sla_target',
  'programme_retention',
  'portal_user',
  'audit_event',
  'audit_export',
] as const;

export type TenantScopedTable = (typeof TENANT_SCOPED_TABLES)[number];

/**
 * Tables that deliberately carry no `tenant_id`, and the reason each one does
 * not. **Adding an entry here is an architecture decision and needs an ADR.**
 *
 * This list exists so that the exemption from the catalogue invariant in
 * `tests/acceptance/tenancy/rls-enforcement.acceptance.test.ts` — which asserts
 * set equality between `TENANT_SCOPED_TABLES` and every table in `public` — is
 * something a reader can find and a reviewer can challenge. An exemption that
 * only existed as a quiet `NOT IN` in a query would be worse than the finding
 * it answers.
 *
 * Everything on this list must STILL have RLS enabled and forced and at least
 * one policy; `readTableSecurity` skips these tables only for the set-equality
 * check, and `schema-invariants` asserts their RLS state separately.
 */
export const NON_TENANT_SCOPED_TABLES = [
  /**
   * `auth_rate_limit` — counts failed sign-ins for a workspace slug that may
   * name no tenant at all. Scoping it to a tenant would make an unknown
   * workspace answer differently from a real one, which is the enumeration
   * oracle it exists to close. Holds a SHA-256 and three integers: no business
   * data and no tenant id, but the digest is unkeyed over a low-entropy input
   * and is therefore pseudonymised personal data under the NDPA, not the
   * absence of it. ADR-0009.
   *
   * Not tenant-scoped is not the same as unscoped: since T-0020 its policy
   * admits a row only to a session presenting that row's `key_hash` in
   * `app.rate_limit_key`. Before that it was `USING (true)`, which let any
   * session enumerate every key in the cell and clear every lockout in it
   * (T-0004 FINDING-3).
   */
  'auth_rate_limit',
] as const;

export type NonTenantScopedTable = (typeof NON_TENANT_SCOPED_TABLES)[number];
