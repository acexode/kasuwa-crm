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
    /** The one tenant-wide role this person holds, if any (0006). */
    roleId: uuid('role_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('user_tenant_idx').on(table.tenantId),
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
    /** `none` | `pii` | `sensitive` (0009, D-L45). Drives the matrix's filter and row tag. */
    classification: text('classification').notNull().default('none'),
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
  'user_credential',
  'user_mfa_factor',
  'auth_challenge',
  'auth_session',
  'role',
  'permission_set',
  'admin_alert',
  'admin_alert_dismissal',
  'field_security_grant',
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
