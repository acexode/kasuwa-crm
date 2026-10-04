import { randomBytes } from 'node:crypto';
import { hashPassword } from '@kasuwa/auth-crypto';
import {
  DEFAULT_PERMISSION_SET_CATALOGUE,
  newId,
  withTenantTransaction,
  type TenantTx,
} from '@kasuwa/db';
import { ADMIN_PERMISSION_SET_KEY } from '@kasuwa/permissions';
import { Client } from 'pg';
import { parse as parseConnectionString } from 'pg-connection-string';
import { z } from 'zod';
import { createProgramme } from '../programme/programme-lifecycle';
import { isUniqueViolation } from '../programme/programme.repository';
import { savepointPool } from './savepoint-pool';
import { slugSkeleton, tenantSlugProblem, type TenantSlugProblem } from './tenant-slug';

/**
 * Sales-led tenant provisioning (T-0015; D-P2, D-L54).
 *
 * `provisionTenant` is the operator's implementation of "create a tenant",
 * wrapped by the CLI (`pnpm tenant:provision`). It holds migrator credentials
 * and is for operator use only. Nothing under apps/** may import it (ESLint),
 * and the self-serve sign-up endpoint (T-0016) needs its own design that
 * never holds migrator credentials.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RUNS ON THE MIGRATOR CONNECTION (CLAUDE.md 2.1, D-L54)
 * ---------------------------------------------------------------------------
 * Rule 2.1 says every query touching tenant data runs inside
 * `withTenantTransaction`. Creating a tenant is the one write that cannot
 * start there: a tenant transaction needs a tenant row and an active user in
 * it before it can open, and neither exists yet. Under kasuwa_app the `tenant`
 * policy refuses an INSERT whose id is not already the session's tenant, so
 * the application role cannot create the very row its context would name.
 *
 * So, exactly as `db:seed`: this is an operator command, and it takes the
 * kasuwa_migrator connection string as an argument. `apps/api` has no
 * migrator URL in its configuration, so nothing serving traffic can call it.
 * What runs outside a tenant context is the minimum: the `tenant` row and the
 * first `user` row — the two rows a tenant context is built FROM. Everything
 * else (business unit, credential, permission sets, the default programme and
 * the admin's membership) is written inside a real `withTenantTransaction`
 * for the new tenant, through the reusable `createProgramme`, with the tenant
 * id taken from `tx.session` and never from this function's arguments.
 * That is structure, not enforcement; see "WHAT KEEPS IT SAFE" below.
 *
 * ONE TRANSACTION. That tenant transaction runs on the SAME connection, as a
 * savepoint inside the outer transaction (`savepoint-pool.ts`). A failure
 * anywhere, whether a taken slug found late, a constraint or a dropped
 * connection, rolls back everything. `withTenantTransaction` is called
 * unmodified. The adapter rewrites exactly its BEGIN/COMMIT/ROLLBACK and
 * throws on any other transaction-control statement.
 *
 * RLS IS NOT EXERCISED HERE (D-L54 as amended). kasuwa_migrator holds
 * BYPASSRLS, and BYPASSRLS overrides FORCE, so no policy is consulted on any
 * write in this file, including the ones inside `withTenantTransaction`.
 *
 * WHAT KEEPS IT SAFE is explicit and local:
 *   - every row written carries the new tenant's id, taken from
 *     `tx.session` (or, for the two bootstrap rows, from the id generated
 *     a few lines above), and every read repeats `tenant_id`;
 *   - every id is fresh (`newId()`), so no statement here can address an
 *     existing row in another tenant, and the only cross-tenant read is the
 *     slug list;
 *   - the operator boundary: the connection string is an argument, the
 *     local-database guard runs first, and apps/** cannot import this.
 *
 * No SECURITY DEFINER function is added (CLAUDE.md 2.7).
 * ---------------------------------------------------------------------------
 */

export const TENANT_REGIONS = ['ZA', 'NG', 'KE'] as const;
export type TenantRegion = (typeof TENANT_REGIONS)[number];

/**
 * Region -> the cell that holds its data, written to `tenant.region_cell` (the
 * one value the cell router and the admin home's `dataRegion` read).
 *
 * ZA -> za-1 (D-L54). NG and KE have no cell yet: where their data lives is a
 * later cell-routing decision (D-L54), so they are refused rather than
 * written into za-1 under a label that says otherwise.
 */
export const REGION_CELLS: Readonly<Record<TenantRegion, string | null>> = {
  ZA: 'za-1',
  NG: null,
  KE: null,
};

/** D-P2: omitted means ZA. Never inferred from the customer. */
export const DEFAULT_TENANT_REGION: TenantRegion = 'ZA';

export interface ProvisionTenantOptions {
  /** kasuwa_migrator, exactly as db:seed. */
  connectionString: string;
  slug: string;
  name: string;
  /** Omitted -> 'ZA' (D-P2). Never inferred. */
  region?: TenantRegion;
  adminEmail: string;
  adminDisplayName: string;
  /** The loud opt-in for a non-local database host. Default false. */
  allowNonLocalDatabase?: boolean;
  /**
   * Operator log. Receives progress and the audit-event shape; never the
   * setup credential, its hash, or the admin's email or name.
   */
  log?: (message: string) => void;
}

export interface ProvisionedTenant {
  tenantId: string;
  slug: string;
  region: TenantRegion;
  /** What `tenant.region_cell` now holds. */
  regionCell: string;
  businessUnitId: string;
  /** The default programme. */
  programmeId: string;
  adminUserId: string;
  /** One-time. Returned once; only its argon2id hash is stored; never logged. */
  setupCredential: string;
}

/** The slug already exists — or one that looks the same does (any tenant). */
export class TenantSlugTakenError extends Error {
  constructor(reason: 'exists' | 'confusable' = 'exists') {
    super(
      reason === 'exists'
        ? 'A tenant with this slug already exists'
        : 'This slug is too similar to an existing tenant slug',
    );
    this.name = 'TenantSlugTakenError';
  }
}

/** Reserved, too short or long, non-ASCII, punycode, upper case, ... */
export class InvalidTenantSlugError extends Error {
  readonly problem: TenantSlugProblem;
  constructor(problem: TenantSlugProblem) {
    super(`Invalid tenant slug (${problem})`);
    this.name = 'InvalidTenantSlugError';
    this.problem = problem;
  }
}

/** Anything that is not one of the region codes. Never echoes the value. */
export class InvalidRegionError extends Error {
  constructor() {
    super(`Invalid region: expected one of ${TENANT_REGIONS.join(', ')}`);
    this.name = 'InvalidRegionError';
  }
}

/** A valid region whose cell does not exist yet (NG, KE — D-L54). */
export class RegionNotServedError extends Error {
  readonly region: TenantRegion;
  constructor(region: TenantRegion) {
    super(
      `Region ${region} has no cell yet: where its data lives is a pending cell-routing ` +
        `decision (D-L54). Provisioning it into this cell would record a residency that ` +
        `is not true.`,
    );
    this.name = 'RegionNotServedError';
    this.region = region;
  }
}

/**
 * The first admin's default-programme membership did not get the tenant's
 * `admin` permission set. An internal invariant, not an input problem: the
 * provisioning is rolled back rather than leaving a tenant with no
 * administrator.
 */
export class FirstAdminGrantMissingError extends Error {
  constructor() {
    super(
      "Provisioning invariant failed: the first admin does not hold the tenant's admin " +
        'permission set in the default programme. Nothing was created.',
    );
    this.name = 'FirstAdminGrantMissingError';
  }
}

/** A name, email or display name failed validation. Names the field, never the value. */
export class InvalidProvisioningInputError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`Invalid provisioning input: ${field}`);
    this.name = 'InvalidProvisioningInputError';
    this.field = field;
  }
}

// --- the local-database guard ----------------------------------------------

/**
 * The same host list as `runSeed`'s guard, for the same reason, with a real
 * credential behind it instead of a fixture one. `[::1]` carries its brackets
 * because that is what `new URL().hostname` returns for IPv6 loopback.
 *
 * The guard is on the FUNCTION, not only on the CLI: a check on the command
 * line protects only the callers that use the command line.
 */
const LOCAL_DATABASE_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

/**
 * The host pg will ACTUALLY connect to, decided by `pg-connection-string`,
 * which is the parser pg itself uses. Reading `new URL().hostname` would be
 * wrong: `postgres://localhost/kasuwa?host=prod.internal` has hostname
 * `localhost`, but pg connects to `prod.internal`.
 *
 * Returns '' when no host is named. pg then falls back to PGHOST or a default
 * this function cannot see, so the caller treats '' as non-local.
 */
export function databaseHost(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    // Not echoed: a malformed connection string may still contain a password.
    throw new InvalidProvisioningInputError('connectionString');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new InvalidProvisioningInputError('connectionString');
  }
  let host: string | null | undefined;
  try {
    host = parseConnectionString(connectionString).host;
  } catch {
    throw new InvalidProvisioningInputError('connectionString');
  }
  return host ?? '';
}

/**
 * Local means a loopback TCP host, exactly. NOT local:
 *   - a Unix socket path (`?host=/var/run/postgresql`). A socket can front a
 *     proxy to anywhere (cloud SQL proxies are sockets);
 *   - an empty host, because pg's fallback is not visible here;
 *   - a multi-host list, even if it starts with localhost.
 */
export function isLocalDatabaseHost(host: string): boolean {
  return LOCAL_DATABASE_HOSTS.has(host);
}

/**
 * Throws unless the host is local or the opt-in was given; when it was, says
 * so in the log. Returns nothing — the decision is the side effect.
 */
export function assertProvisioningTarget(
  connectionString: string,
  allowNonLocalDatabase: boolean,
  log: (message: string) => void,
): void {
  const host = databaseHost(connectionString) || '(no host: PGHOST or the pg default)';
  if (isLocalDatabaseHost(host)) {
    return;
  }
  if (!allowNonLocalDatabase) {
    throw new Error(
      `provisionTenant refuses a non-local database host (${host}) without the explicit ` +
        `opt-in: pass allowNonLocalDatabase: true, or --allow-non-local on the CLI. This ` +
        `command creates a real, working admin credential.`,
    );
  }
  log(
    `WARNING: provisioning against NON-LOCAL database host ${host} ` +
      `(allowNonLocalDatabase / --allow-non-local was given). This creates a real tenant ` +
      `and a working admin credential there.`,
  );
}

// --- validation ------------------------------------------------------------

export function resolveRegion(region: unknown): { region: TenantRegion; regionCell: string } {
  const value = region === undefined ? DEFAULT_TENANT_REGION : region;
  const parsed = z.enum(TENANT_REGIONS).safeParse(value);
  if (!parsed.success) {
    throw new InvalidRegionError();
  }
  const cell = REGION_CELLS[parsed.data];
  if (cell === null) {
    throw new RegionNotServedError(parsed.data);
  }
  return { region: parsed.data, regionCell: cell };
}

export function assertValidTenantSlug(slug: unknown): string {
  if (typeof slug !== 'string') {
    throw new InvalidTenantSlugError('characters');
  }
  const problem = tenantSlugProblem(slug);
  if (problem !== null) {
    throw new InvalidTenantSlugError(problem);
  }
  return slug;
}

const Inputs = z.object({
  name: z.string().trim().min(1).max(200),
  adminEmail: z.string().trim().email().max(320),
  adminDisplayName: z.string().trim().min(1).max(200),
});

function parseInputs(options: ProvisionTenantOptions): z.infer<typeof Inputs> {
  const parsed = Inputs.safeParse({
    name: options.name,
    adminEmail: options.adminEmail,
    adminDisplayName: options.adminDisplayName,
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    throw new InvalidProvisioningInputError(typeof field === 'string' ? field : 'input');
  }
  return parsed.data;
}

/**
 * 24 random bytes, base64url: 32 characters, 192 bits. Never a word list and
 * never anything an operator chose — it is a credential, briefly, and then
 * (once a change-password endpoint exists, with T-0012) it is replaced.
 */
export function newSetupCredential(): string {
  return randomBytes(24).toString('base64url');
}

// --- the audit event shape -------------------------------------------------

export interface ProvisioningAuditChange {
  field: string;
  before: string | null;
  after: string | null;
  redacted: boolean;
}

/**
 * The `audit_event` row this provisioning WOULD write, column for column
 * (migration 0008), so the audit task can adopt it unchanged.
 *
 * Not persisted (D-L54): `audit_event_actor_is_session` admits only
 * `actor_kind = 'user'` rows from the application, and a system-actor policy
 * waits on D-L52. The migrator could write it past RLS; doing so would be
 * deciding that policy by the back door. It is logged instead.
 *
 * Carries ids, the slug and the region. Never the admin's email or name (the
 * email is a redacted change, as D-L54 requires for invitees) and never the
 * credential.
 */
export interface TenantProvisionedAuditEvent {
  tenantId: string;
  actorKind: 'system';
  actorUserId: null;
  actorRoleName: null;
  action: 'created';
  objectType: 'tenant';
  objectId: string;
  objectLabel: string;
  programmeId: null;
  changes: ProvisioningAuditChange[];
}

export function buildTenantProvisionedAuditEvent(
  result: Omit<ProvisionedTenant, 'setupCredential'>,
): TenantProvisionedAuditEvent {
  const created = (field: string, after: string): ProvisioningAuditChange => ({
    field,
    before: null,
    after,
    redacted: false,
  });
  return {
    tenantId: result.tenantId,
    actorKind: 'system',
    actorUserId: null,
    actorRoleName: null,
    action: 'created',
    objectType: 'tenant',
    objectId: result.tenantId,
    objectLabel: result.slug,
    programmeId: null,
    changes: [
      created('slug', result.slug),
      created('region', result.region),
      created('region_cell', result.regionCell),
      created('business_unit_id', result.businessUnitId),
      created('default_programme_id', result.programmeId),
      created('admin_user_id', result.adminUserId),
      { field: 'admin_email', before: null, after: null, redacted: true },
    ],
  };
}

// --- provisioning ----------------------------------------------------------

/**
 * Serialises provisioners against each other (not against the application):
 * the confusable-slug check reads every slug and must not race a concurrent
 * provision of a look-alike. Transaction-scoped; released at COMMIT/ROLLBACK.
 */
const PROVISIONING_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('kasuwa:tenant-provision'))`;

/**
 * Creates, in one transaction: the tenant (status `active`, region recorded
 * once in `region_cell`), one business unit, the default permission sets, the
 * first admin user with a one-time argon2id setup credential and no second
 * factor (MFA enrolment is required at first sign-in, T-0012), and the
 * default programme — through `createProgramme`, which makes the admin its
 * first and only member.
 *
 * Validation happens before any connection is opened, in this order: the
 * local-database guard, region, slug, the remaining inputs. Each refusal is a
 * typed error and writes nothing.
 *
 * NOT created (gaps in the T-0015 completion report): billing identity
 * (no table; may need a payment-provider account first, which the task says is
 * a product decision), and the persisted audit event (see above).
 */
export async function provisionTenant(options: ProvisionTenantOptions): Promise<ProvisionedTenant> {
  const log = options.log ?? (() => undefined);

  assertProvisioningTarget(options.connectionString, options.allowNonLocalDatabase === true, log);
  const { region, regionCell } = resolveRegion(options.region);
  const slug = assertValidTenantSlug(options.slug);
  const inputs = parseInputs(options);

  // Hashed before the transaction opens: argon2id is deliberately slow, and a
  // transaction holding the provisioning lock should not wait on it.
  const setupCredential = newSetupCredential();
  const credentialHash = await hashPassword(setupCredential);

  const tenantId = newId();
  const adminUserId = newId();

  log(`provisioning tenant ${slug} in region ${region} (cell ${regionCell})`);

  const client = new Client({
    connectionString: options.connectionString,
    application_name: 'kasuwa-tenant-provision',
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
  await client.connect();

  try {
    await client.query('BEGIN');
    await client.query(PROVISIONING_LOCK_SQL);

    // Operator scope (D-L54): the slug check is across every tenant in the
    // cell, which only the migrator can read. Exact match first, then
    // confusables.
    const existing = await client.query<{ slug: string }>(`SELECT slug FROM tenant`);
    if (existing.rows.some((row) => row.slug === slug)) {
      throw new TenantSlugTakenError('exists');
    }
    const skeleton = slugSkeleton(slug);
    if (existing.rows.some((row) => slugSkeleton(row.slug) === skeleton)) {
      throw new TenantSlugTakenError('confusable');
    }

    // The two bootstrap rows a tenant context is built from. Nothing else is
    // written outside withTenantTransaction.
    try {
      await client.query(
        `INSERT INTO tenant (id, name, slug, region_cell, status) VALUES ($1, $2, $3, $4, 'active')`,
        [tenantId, inputs.name, slug, regionCell],
      );
    } catch (error) {
      // Unreachable while the advisory lock is held, unless a writer that
      // does not take it (a seed) raced us. Still the same clean answer.
      if (isUniqueViolation(error, 'tenant_slug_key')) {
        throw new TenantSlugTakenError('exists');
      }
      throw error;
    }
    // D-L53: the first admin is a TENANT admin, the tenant-level flag
    // `"user".is_tenant_admin`. Written here, by the migrator, because 0015
    // deliberately withholds that column from kasuwa_app: no application
    // session can make anyone a tenant admin. Without it a new tenant has no
    // administrator.
    await client.query(
      `INSERT INTO "user" (id, tenant_id, email, display_name, status, is_tenant_admin)
       VALUES ($1, $2, $3, $4, 'active', true)`,
      [adminUserId, tenantId, inputs.adminEmail, inputs.adminDisplayName],
    );

    const created = await withTenantTransaction(
      savepointPool(client),
      { tenantId, userId: adminUserId },
      (tx) => populateTenant(tx, inputs.name, credentialHash),
    );

    await client.query('COMMIT');

    const result: ProvisionedTenant = {
      tenantId,
      slug,
      region,
      regionCell,
      businessUnitId: created.businessUnitId,
      programmeId: created.programmeId,
      adminUserId,
      setupCredential,
    };

    log(
      `provisioned tenant ${slug}: tenant ${tenantId}, business unit ${created.businessUnitId}, ` +
        `default programme ${created.programmeId}, first admin user ${adminUserId}, ` +
        `${created.permissionSets} permission sets`,
    );
    const { setupCredential: _secret, ...auditable } = result;
    log(
      `audit event (NOT persisted: awaits a system-actor policy, D-L52/D-L54): ` +
        JSON.stringify(buildTenantProvisionedAuditEvent(auditable)),
    );
    log('not created: billing identity (no table yet; T-0015 escalation)');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Everything after the bootstrap rows, inside the new tenant's transaction.
 * Every tenant id here is `tx.session.tenantId` and the admin is
 * `tx.session.userId`; nothing is taken from the caller.
 */
async function populateTenant(
  tx: TenantTx,
  name: string,
  credentialHash: string,
): Promise<{ businessUnitId: string; programmeId: string; permissionSets: number }> {
  const { tenantId, userId } = tx.session;

  const businessUnitId = newId();
  // tenancy-reviewed: tenant_id from the session.
  await tx.query(`INSERT INTO business_unit (id, tenant_id, name) VALUES ($1, $2, $3)`, [
    businessUnitId,
    tenantId,
    name,
  ]);

  // tenancy-reviewed: tenant_id + user id from the session. The hash only.
  await tx.query(
    `INSERT INTO user_credential (user_id, tenant_id, password_hash) VALUES ($1, $2, $3)`,
    [userId, tenantId, credentialHash],
  );

  for (const set of DEFAULT_PERMISSION_SET_CATALOGUE) {
    // tenancy-reviewed: tenant_id from the session; fresh ids, never the seed's.
    await tx.query(
      `INSERT INTO permission_set (id, tenant_id, key, label, locked, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId(), tenantId, set.key, set.label, set.locked, set.sortOrder],
    );
  }

  // The reusable path (T-0029, T-0032): it also makes the session's user (the
  // admin) the programme's first member, holding the tenant's `admin`
  // permission set (`user_programme.permission_set_id`). That is why the sets
  // are inserted ABOVE this call: createProgramme looks the set up by key and
  // falls back to NULL (no permission) when the tenant has none.
  const programme = await createProgramme(tx, { name, businessUnitId, isDefault: true });

  // The NULL fallback is right for createProgramme in general, but here it
  // would quietly provision a tenant whose only user administers nothing. So
  // check it, and fail (rolling everything back) rather than hand that out.
  // tenancy-reviewed: tenant_id + user id from the session.
  const grant = await tx.query<{ key: string }>(
    `SELECT ps.key
       FROM user_programme up
       JOIN permission_set ps
         ON ps.id = up.permission_set_id AND ps.tenant_id = up.tenant_id
      WHERE up.tenant_id = $1 AND up.user_id = $2 AND up.programme_id = $3`,
    [tenantId, userId, programme.id],
  );
  if (grant[0]?.key !== ADMIN_PERMISSION_SET_KEY) {
    throw new FirstAdminGrantMissingError();
  }

  return {
    businessUnitId,
    programmeId: programme.id,
    permissionSets: DEFAULT_PERMISSION_SET_CATALOGUE.length,
  };
}
