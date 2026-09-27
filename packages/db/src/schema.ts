import {
  bigint,
  boolean,
  char,
  customType,
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
  (table) => [index('user_credential_tenant_idx').on(table.tenantId)],
);

export const userMfaFactor = pgTable(
  'user_mfa_factor',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    type: text('type').notNull(),
    label: text('label'),
    /** Base32 TOTP secret. Never selected into a response. See migration 0002. */
    secret: text('secret').notNull(),
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
    uniqueIndex('user_mfa_factor_tenant_id_user_id_type_key').on(
      table.tenantId,
      table.userId,
      table.type,
    ),
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
  'user_credential',
  'user_mfa_factor',
  'auth_challenge',
  'auth_session',
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
   * oracle it exists to close. Holds a SHA-256 and three integers: no personal
   * data, no business data, no tenant id. ADR-0009.
   */
  'auth_rate_limit',
] as const;

export type NonTenantScopedTable = (typeof NON_TENANT_SCOPED_TABLES)[number];
