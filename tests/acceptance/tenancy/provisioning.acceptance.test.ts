import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  SEED_PASSWORD,
  SEED_PERMISSION_SETS,
  SEED_TENANTS,
  TENANT_A,
  TENANT_SCOPED_TABLES,
  withTenantTransaction,
} from '@kasuwa/db';
import { reseed, withForcedScope } from '@kasuwa/testing';
import { Client, type Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0015, sales-led tenant provisioning.
 *
 * Source: team/tasks/T-0015-sales-led-tenant-provisioning.md ("Acceptance
 * tests"), DECISION-LOG D-P2 (region chosen by @acexode per tenant, default
 * ZA, NG only on explicit instruction), CLAUDE.md sections 2 and 6.
 *
 * ------------------------------------------------------------------------
 * THE INTERFACE THE BUILDER MUST PROVIDE
 * ------------------------------------------------------------------------
 *
 * 1. An importable function, exported from `@kasuwa/domain-core`
 *    (packages/domain/core/src/index.ts), defined in a file under
 *    packages/domain/core/src/ — the same package as `createProgramme`, which
 *    it must call:
 *
 *      provisionTenant(options: ProvisionTenantOptions): Promise<ProvisionedTenant>
 *
 *      interface ProvisionTenantOptions {
 *        connectionString: string;        // kasuwa_migrator, exactly as db:seed
 *        slug: string;
 *        name: string;
 *        region?: 'ZA' | 'NG' | 'KE';     // omitted -> 'ZA' (D-P2). Never inferred.
 *        adminEmail: string;
 *        adminDisplayName: string;
 *        allowNonLocalDatabase?: boolean; // the loud opt-in; default false
 *        log?: (message: string) => void;
 *      }
 *
 *      interface ProvisionedTenant {
 *        tenantId: string;
 *        slug: string;
 *        region: 'ZA' | 'NG' | 'KE';
 *        regionCell: string;              // what tenant.region_cell now holds
 *        businessUnitId: string;
 *        programmeId: string;             // the default programme
 *        adminUserId: string;
 *        setupCredential: string;         // one-time; returned once, never stored or logged
 *      }
 *
 *    plus three error classes, also exported from `@kasuwa/domain-core`:
 *      TenantSlugTakenError    — the slug already exists (any tenant)
 *      InvalidTenantSlugError  — reserved, too short/long, non-ASCII, punycode, ...
 *      InvalidRegionError      — anything that is not one of the region codes
 *
 * 2. A root script that wraps it, reading DATABASE_MIGRATION_URL through
 *    @kasuwa/config like `db:seed`, and printing the setup credential to the
 *    operator ONCE on stdout and nowhere else:
 *
 *      pnpm tenant:provision --slug <slug> --name <name> --admin-email <email> \
 *        --admin-name <display name> [--region ZA|NG|KE] [--allow-non-local]
 *
 *    The CLI is not spawned here (tests may not touch process.env to point it
 *    at a database); its existence is asserted, and the guard is asserted on
 *    the function, for the reason runSeed's guard moved there: a check on the
 *    command line protects only the callers that use the command line.
 *
 * ------------------------------------------------------------------------
 * WHAT "IMMEDIATELY USABLE" MEANS HERE
 * ------------------------------------------------------------------------
 *
 * The first admin gets a one-time setup credential, never a password anyone
 * chose and never the fixture password. It must be accepted by the REAL
 * first-factor endpoint (POST /api/v1/auth/sign-in), and the challenge must
 * say `enrolmentRequired: true`, because the admin has no second factor until
 * they enrol one (T-0012). Completing the second factor needs T-0012's
 * enrolment endpoint, which does not exist; this suite does not wait for it.
 * The "sees exactly one programme" half is asserted twice: through the real
 * session resolver (`withTenantTransaction`, which reads user_programme), and
 * through the admin programmes API as that user.
 *
 * ------------------------------------------------------------------------
 * DELIBERATELY NOT ASSERTED
 * ------------------------------------------------------------------------
 *   - billing identity: no table exists, and the task says to escalate if it
 *     needs a payment-provider account first;
 *   - the audit event: audit_event refuses `system` actors from kasuwa_app and
 *     the task asks only for an adoptable shape, argued in the report;
 *   - that the setup credential must be changed: there is no change-password
 *     endpoint to prove it against;
 *   - NG and KE placement: this database is one cell (za-1), and where an NG
 *     tenant's data lives is a cell-routing question this suite cannot see.
 *
 * Writes: this suite creates tenants. It reseeds in afterAll (the seed's
 * `TRUNCATE tenant CASCADE` removes every provisioned tenant), and every slug
 * carries a per-run suffix so an unreseeded earlier run cannot collide.
 */

const repoRoot = resolve(__dirname, '../../..');
const DOMAIN_CORE_SRC = resolve(repoRoot, 'packages/domain/core/src');

const SIGN_IN = '/api/v1/auth/sign-in';
const PROGRAMMES = '/api/v1/admin/programmes';
const HOME_SUMMARY = '/api/v1/admin/home/summary';

/** Unique per run, lowercase alphanumeric, so every slug built from it is valid. */
const RUN = Date.now().toString(36);

type Region = 'ZA' | 'NG' | 'KE';

interface ProvisionTenantOptions {
  connectionString: string;
  slug: string;
  name: string;
  region?: Region;
  adminEmail: string;
  adminDisplayName: string;
  allowNonLocalDatabase?: boolean;
  log?: (message: string) => void;
}

interface ProvisionedTenant {
  tenantId: string;
  slug: string;
  region: Region;
  regionCell: string;
  businessUnitId: string;
  programmeId: string;
  adminUserId: string;
  setupCredential: string;
}

type ErrorClass = new (...args: never[]) => Error;

interface ProvisioningModule {
  provisionTenant: (options: ProvisionTenantOptions) => Promise<ProvisionedTenant>;
  TenantSlugTakenError: ErrorClass;
  InvalidTenantSlugError: ErrorClass;
  InvalidRegionError: ErrorClass;
}

const REQUIRED_EXPORTS: readonly (keyof ProvisioningModule)[] = [
  'provisionTenant',
  'TenantSlugTakenError',
  'InvalidTenantSlugError',
  'InvalidRegionError',
];

// Typed as `string`, not as the literal, so tsc checks this file against the
// local interface above rather than against exports that do not exist yet.
const DOMAIN_CORE: string = '@kasuwa/domain-core';

async function loadProvisioning(): Promise<ProvisioningModule> {
  const loaded = (await import(DOMAIN_CORE)) as Partial<Record<keyof ProvisioningModule, unknown>>;
  const missing = REQUIRED_EXPORTS.filter((name) => typeof loaded[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(`T-0015: ${DOMAIN_CORE} is missing exports: ${missing.join(', ')}`);
  }
  return loaded as unknown as ProvisioningModule;
}

/** The column that names a row's tenant: `tenant` is keyed by its own id. */
const tenantColumn = (table: string) => (table === 'tenant' ? 'id' : 'tenant_id');

describe('acceptance: sales-led tenant provisioning (T-0015)', () => {
  let app: INestApplication;
  let appPool: Pool;
  let provisioning: ProvisioningModule;
  let primary: ProvisionedTenant;
  const primaryLogs: string[] = [];

  const primaryOptions = (): ProvisionTenantOptions => ({
    connectionString: inject('migrationUrl'),
    slug: `harmattan-${RUN}`,
    name: 'Harmattan Collections',
    adminEmail: `founder.${RUN}@harmattan.test`,
    adminDisplayName: 'Amina Lawal',
    log: (message) => primaryLogs.push(message),
  });

  /** The primary tenant's options without its log sink, for attempts that must fail. */
  const quietOptions = (): ProvisionTenantOptions => {
    const { log: _log, ...rest } = primaryOptions();
    return rest;
  };

  /** Runs `fn` as kasuwa_migrator (BYPASSRLS): the auditor's view of the whole cell. */
  async function asMigrator<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: inject('migrationUrl') });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  /** Row count of every tenant-scoped table, across every tenant. */
  async function countEverything(): Promise<Record<string, number>> {
    return asMigrator(async (client) => {
      const counts: Record<string, number> = {};
      for (const table of TENANT_SCOPED_TABLES) {
        const result = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "${table}"`,
        );
        counts[table] = result.rows[0]?.n ?? -1;
      }
      return counts;
    });
  }

  async function tenantIdForSlug(slug: string): Promise<string | null> {
    return asMigrator(async (client) => {
      const result = await client.query<{ id: string }>(`SELECT id FROM tenant WHERE slug = $1`, [
        slug,
      ]);
      return result.rows[0]?.id ?? null;
    });
  }

  beforeAll(async () => {
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 5 });
    app = await createApi(inject('databaseUrl'));
    provisioning = await loadProvisioning();
    primary = await provisioning.provisionTenant(primaryOptions());
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();

  // --- immediately usable ----------------------------------------------------

  it('lets the first admin sign in through the real auth API with the one-time setup credential', async () => {
    const options = primaryOptions();

    const started = await request(server())
      .post(SIGN_IN)
      .send({
        tenantSlug: options.slug,
        email: options.adminEmail,
        password: primary.setupCredential,
      })
      .expect(200);

    expect(started.body.mfaRequired).toBe(true);
    expect(started.body.challengeId).toEqual(expect.any(String));
    // No factor exists yet; the admin must enrol one (T-0012). A provisioned
    // admin who arrives with a factor somebody else set up is a shared secret.
    expect(started.body.enrolmentRequired).toBe(true);

    const factors = await asMigrator(async (client) => {
      const result = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM user_mfa_factor WHERE tenant_id = $1`,
        [primary.tenantId],
      );
      return result.rows[0]?.n;
    });
    expect(factors).toBe(0);

    // And the credential is actually checked: a wrong one is the ordinary 401.
    await request(server())
      .post(SIGN_IN)
      .send({ tenantSlug: options.slug, email: options.adminEmail, password: 'not-the-one' })
      .expect(401);
  });

  it('gives the admin exactly one programme — the default — through the session resolver and the API', async () => {
    const session = await withTenantTransaction(
      appPool,
      { tenantId: primary.tenantId, userId: primary.adminUserId },
      async (tx) => tx.session,
    );
    expect(session.programmeIds).toEqual([primary.programmeId]);

    const listed = await request(server())
      .get(PROGRAMMES)
      .set(asUser(primary.tenantId, primary.adminUserId))
      .expect(200);
    const items = listed.body.items as { id: string }[];
    expect(items.map((item) => item.id)).toEqual([primary.programmeId]);
  });

  // --- what one transaction creates ----------------------------------------

  it('creates the tenant, one business unit, one default programme and one active admin, and nothing dangling', async () => {
    const options = primaryOptions();

    const rows = await asMigrator(async (client) => {
      const one = async <R extends Record<string, unknown>>(sql: string) =>
        (await client.query<R>(sql, [primary.tenantId])).rows;
      return {
        tenant: await one<{ name: string; slug: string; status: string }>(
          `SELECT name, slug, status FROM tenant WHERE id = $1`,
        ),
        units: await one<{ id: string }>(`SELECT id FROM business_unit WHERE tenant_id = $1`),
        programmes: await one<{
          id: string;
          business_unit_id: string;
          is_default: boolean;
          status: string;
        }>(`SELECT id, business_unit_id, is_default, status FROM programme WHERE tenant_id = $1`),
        users: await one<{ id: string; email: string; display_name: string; status: string }>(
          `SELECT id, email, display_name, status FROM "user" WHERE tenant_id = $1`,
        ),
        memberships: await one<{ user_id: string; programme_id: string }>(
          `SELECT user_id, programme_id FROM user_programme WHERE tenant_id = $1`,
        ),
        credentials: await one<{ user_id: string }>(
          `SELECT user_id FROM user_credential WHERE tenant_id = $1`,
        ),
      };
    });

    expect(rows.tenant).toHaveLength(1);
    expect(rows.tenant[0]).toMatchObject({ name: options.name, slug: options.slug });
    expect(['active', 'trial']).toContain(rows.tenant[0]?.status);

    expect(rows.units.map((unit) => unit.id)).toEqual([primary.businessUnitId]);

    expect(rows.programmes).toEqual([
      {
        id: primary.programmeId,
        business_unit_id: primary.businessUnitId,
        is_default: true,
        status: 'active',
      },
    ]);

    expect(rows.users).toEqual([
      {
        id: primary.adminUserId,
        email: options.adminEmail,
        display_name: options.adminDisplayName,
        status: 'active',
      },
    ]);

    // createProgramme makes the session's user the programme's first member;
    // the admin's one membership is the proof the path ran as the admin.
    expect(rows.memberships).toEqual([
      { user_id: primary.adminUserId, programme_id: primary.programmeId },
    ]);
    expect(rows.credentials).toEqual([{ user_id: primary.adminUserId }]);
  });

  it('builds the default programme through the reusable createProgramme, and ships a CLI over the same function', () => {
    // Two implementations of "create a programme" drift apart — the same
    // argument the task makes for T-0015 and T-0016 sharing tenant creation.
    const files = listTsFiles(DOMAIN_CORE_SRC).filter((path) => !/\.test\.ts$/.test(path));
    const definers = files.filter((path) =>
      /export\s+(async\s+)?function\s+provisionTenant\b/.test(readFileSync(path, 'utf8')),
    );
    expect(
      definers,
      'provisionTenant must be defined once, under packages/domain/core/src',
    ).toHaveLength(1);

    const source = readFileSync(definers[0] as string, 'utf8');
    expect(source, 'provisionTenant must call createProgramme').toMatch(/\bcreateProgramme\s*\(/);
    expect(source, 'provisionTenant must not insert programmes itself').not.toMatch(
      /INSERT\s+INTO\s+"?programme"?\s*\(/i,
    );

    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.['tenant:provision'],
      'root package.json has no tenant:provision script',
    ).toEqual(expect.any(String));
  });

  it('creates the default permission sets in the T-0022 seed shape, with ids of its own', async () => {
    const expected = SEED_PERMISSION_SETS.filter((set) => set.tenantId === TENANT_A)
      .map((set) => ({
        key: set.key,
        label: set.label,
        locked: set.locked,
        sortOrder: set.sortOrder,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
    expect(expected.length).toBeGreaterThan(0);

    const rows = await asMigrator(async (client) => {
      const result = await client.query<{
        id: string;
        key: string;
        label: string;
        locked: boolean;
        sort_order: number;
      }>(
        `SELECT id, key, label, locked, sort_order FROM permission_set
          WHERE tenant_id = $1 ORDER BY sort_order`,
        [primary.tenantId],
      );
      return result.rows;
    });

    expect(
      rows.map((row) => ({
        key: row.key,
        label: row.label,
        locked: row.locked,
        sortOrder: row.sort_order,
      })),
    ).toEqual(expected);

    const seededIds = new Set(SEED_PERMISSION_SETS.map((set) => set.id));
    for (const row of rows) {
      expect(seededIds.has(row.id), `permission set ${row.key} reused a seeded id`).toBe(false);
    }
  });

  // --- isolation -------------------------------------------------------------

  it('is invisible to every existing tenant, even to a forced scope that names its ids — and sees none of theirs', async () => {
    // Forced scope, not the API: this asks what RLS alone lets through if the
    // application layer were compromised and named the new programme itself.
    for (const seeded of SEED_TENANTS) {
      const leaked = await withForcedScope(
        appPool,
        {
          tenantId: seeded.id,
          userId: seeded.users[0]!.id,
          programmeIds: [...seeded.programmes.map((p) => p.id), primary.programmeId],
        },
        async (query) => {
          const found: string[] = [];
          for (const table of TENANT_SCOPED_TABLES) {
            const rows = await query<{ n: number }>(
              `SELECT count(*)::int AS n FROM "${table}" WHERE ${tenantColumn(table)} = $1`,
              [primary.tenantId],
            );
            if ((rows[0]?.n ?? 0) > 0) found.push(table);
          }
          return found;
        },
      );
      expect(leaked, `tenant ${seeded.slug} can see the provisioned tenant in`).toEqual([]);
    }

    // The other direction: the new tenant, even naming every seeded programme.
    const seededTenantIds = SEED_TENANTS.map((tenant) => tenant.id);
    const reverse = await withForcedScope(
      appPool,
      {
        tenantId: primary.tenantId,
        userId: primary.adminUserId,
        programmeIds: [
          primary.programmeId,
          ...SEED_TENANTS.flatMap((t) => t.programmes.map((p) => p.id)),
        ],
      },
      async (query) => {
        const found: string[] = [];
        for (const table of TENANT_SCOPED_TABLES) {
          const rows = await query<{ n: number }>(
            `SELECT count(*)::int AS n FROM "${table}" WHERE ${tenantColumn(table)} = ANY($1::uuid[])`,
            [seededTenantIds],
          );
          if ((rows[0]?.n ?? 0) > 0) found.push(table);
        }
        return found;
      },
    );
    expect(reverse, 'the provisioned tenant can see a seeded tenant in').toEqual([]);
  });

  // --- region ------------------------------------------------------------------

  it('records region ZA by default in the one place the cell router reads, never inferred from the customer', async () => {
    expect(primary.region).toBe('ZA');
    expect(primary.regionCell).toBe('za-1');

    // Everything about this customer says Nigeria. None of it may move them.
    const lagos = await provisioning.provisionTenant({
      connectionString: inject('migrationUrl'),
      slug: `lekki-${RUN}`,
      name: 'Lagos Lekki Contact Centre',
      adminEmail: `ops.${RUN}@lekki-contact.com.ng`,
      adminDisplayName: 'Chidi Okafor',
    });
    expect(lagos.region).toBe('ZA');

    const cells = await asMigrator(async (client) => {
      const result = await client.query<{ id: string; region_cell: string }>(
        `SELECT id, region_cell FROM tenant WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[primary.tenantId, lagos.tenantId]],
      );
      return Object.fromEntries(result.rows.map((row) => [row.id, row.region_cell]));
    });
    expect(cells[primary.tenantId]).toBe('za-1');
    expect(cells[lagos.tenantId]).toBe('za-1');

    // The API reads the same value back, not a second copy of it.
    const summary = await request(server())
      .get(HOME_SUMMARY)
      .set(asUser(primary.tenantId, primary.adminUserId))
      .expect(200);
    expect(summary.body.dataRegion?.code).toBe('af-south-1');
  });

  it('does not let the created admin change the region, through a real session or raw SQL in their own scope', async () => {
    // A real session, committing if the database lets it.
    await withTenantTransaction(
      appPool,
      { tenantId: primary.tenantId, userId: primary.adminUserId },
      async (tx) =>
        tx.query(`UPDATE tenant SET region_cell = 'ke-1' WHERE id = $1`, [primary.tenantId]),
    ).catch(() => undefined);

    const after = await asMigrator(async (client) => {
      const result = await client.query<{ region_cell: string }>(
        `SELECT region_cell FROM tenant WHERE id = $1`,
        [primary.tenantId],
      );
      return result.rows[0]?.region_cell;
    });
    expect(after, 'the admin moved their own data region').toBe('za-1');

    // And code holding the admin's scope with arbitrary SQL sees the write
    // refused or ignored inside its own transaction, not merely rolled back.
    const seen = await withForcedScope(
      appPool,
      {
        tenantId: primary.tenantId,
        userId: primary.adminUserId,
        programmeIds: [primary.programmeId],
      },
      async (query) => {
        await query('SAVEPOINT region_attempt');
        try {
          await query(`UPDATE tenant SET region_cell = 'ng-1' WHERE id = $1`, [primary.tenantId]);
        } catch {
          await query('ROLLBACK TO SAVEPOINT region_attempt');
        }
        return query<{ region_cell: string }>(`SELECT region_cell FROM tenant WHERE id = $1`, [
          primary.tenantId,
        ]);
      },
    );
    expect(seen[0]?.region_cell).toBe('za-1');
  });

  it('refuses a region that is not one of the codes, and writes nothing', async () => {
    for (const region of ['Lagos', 'EU', '', 'za-1', 'za']) {
      const slug = `region-${RUN}-${region.length}${region.charCodeAt(0) || 0}`;
      await expect(
        provisioning.provisionTenant({
          connectionString: inject('migrationUrl'),
          slug,
          name: 'Free Text Region Ltd',
          region: region as Region,
          adminEmail: `admin.${RUN}@free-text.test`,
          adminDisplayName: 'Free Text',
        }),
        `region ${JSON.stringify(region)} was accepted`,
      ).rejects.toBeInstanceOf(provisioning.InvalidRegionError);
      expect(await tenantIdForSlug(slug)).toBeNull();
    }
  });

  // --- the guard ---------------------------------------------------------------

  it('refuses a non-local database without the explicit opt-in, and says which switch it is', async () => {
    for (const host of ['db.staging.internal', '10.0.0.5', 'localhost.evil.test']) {
      await expect(
        provisioning.provisionTenant({
          ...quietOptions(),
          slug: `remote-${RUN}`,
          connectionString: `postgres://kasuwa_migrator@${host}:5432/kasuwa`,
        }),
        `${host} was treated as local`,
      ).rejects.toThrow(/non-local/i);
    }

    // An error that only says "refused" gets worked around; one that names the
    // opt-in gets read, and the opt-in is then a decision somebody made.
    await expect(
      provisioning.provisionTenant({
        ...quietOptions(),
        slug: `remote-${RUN}`,
        connectionString: 'postgres://kasuwa_migrator@db.staging.internal:5432/kasuwa',
      }),
    ).rejects.toThrow(/allow-non-local|allowNonLocalDatabase/);
  });

  it('gets past the guard with the explicit opt-in, and says so loudly', async () => {
    const logs: string[] = [];
    const host = 'db.kasuwa-provisioning.invalid';

    // `.invalid` never resolves (RFC 2606), so this fails at connect — which is
    // the proof the guard let it through rather than short-circuiting.
    await expect(
      provisioning.provisionTenant({
        ...quietOptions(),
        slug: `optin-${RUN}`,
        connectionString: `postgres://kasuwa_migrator@${host}:5432/kasuwa`,
        allowNonLocalDatabase: true,
        log: (message) => logs.push(message),
      }),
    ).rejects.not.toThrow(/non-local/i);

    expect(
      logs.some((line) => /non-local/i.test(line) && line.includes(host)),
      'the opt-in was taken silently',
    ).toBe(true);
  }, 30_000);

  // --- idempotence and validation ----------------------------------------------

  it('fails cleanly on a slug that already exists, leaving every table exactly as it was', async () => {
    const before = await countEverything();

    await expect(
      provisioning.provisionTenant({
        ...quietOptions(),
        adminEmail: `second.${RUN}@harmattan.test`,
        adminDisplayName: 'Second Attempt',
      }),
    ).rejects.toBeInstanceOf(provisioning.TenantSlugTakenError);

    // A seeded tenant's slug, too: "already exists" is any tenant, not this suite's.
    await expect(
      provisioning.provisionTenant({
        ...quietOptions(),
        slug: SEED_TENANTS[0]?.slug ?? 'sahel-bpo',
        adminEmail: `third.${RUN}@harmattan.test`,
      }),
    ).rejects.toBeInstanceOf(provisioning.TenantSlugTakenError);

    expect(await countEverything()).toEqual(before);

    // And the original tenant is untouched: still one admin, the first one.
    const admins = await asMigrator(async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM "user" WHERE tenant_id = $1`,
        [primary.tenantId],
      );
      return result.rows.map((row) => row.id);
    });
    expect(admins).toEqual([primary.adminUserId]);
  });

  it('validates the slug hard — reserved, length, non-ASCII, punycode — and writes nothing', async () => {
    const before = await countEverything();
    const invalid = [
      'admin',
      'api',
      'www',
      'a',
      'a'.repeat(64),
      '-leading',
      'trailing-',
      'has space',
      'under_score',
      // Cyrillic "ѕ" (U+0455): renders as "sahel-bpo" and is not it.
      'ѕahel-bpo',
      // Punycode for a non-ASCII label: the same confusable, encoded.
      'xn--sahel-bpo-9xc',
    ];

    for (const slug of invalid) {
      await expect(
        provisioning.provisionTenant({ ...quietOptions(), slug }),
        `slug ${JSON.stringify(slug)} was accepted`,
      ).rejects.toBeInstanceOf(provisioning.InvalidTenantSlugError);
    }

    // Upper case is either refused or treated as the slug it folds to — which
    // is taken. Either way it must not become a second "sahel-bpo".
    await expect(
      provisioning.provisionTenant({ ...quietOptions(), slug: 'Sahel-BPO' }),
    ).rejects.toThrow();

    expect(await countEverything()).toEqual(before);
  });

  // --- credentials -------------------------------------------------------------

  it('stores no plaintext credential, logs none, and never reuses one', async () => {
    const credential = primary.setupCredential;
    expect(credential.length, 'a setup credential short enough to guess').toBeGreaterThanOrEqual(
      20,
    );
    expect(credential).not.toBe(SEED_PASSWORD);

    // Only a slow hash reaches the database.
    const hashes = await asMigrator(async (client) => {
      const result = await client.query<{ password_hash: string }>(
        `SELECT password_hash FROM user_credential WHERE tenant_id = $1`,
        [primary.tenantId],
      );
      return result.rows.map((row) => row.password_hash);
    });
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toMatch(/^\$argon2id\$/);

    // Not in any row the tenant owns, in any column.
    const containing = await asMigrator(async (client) => {
      const found: string[] = [];
      for (const table of TENANT_SCOPED_TABLES) {
        const result = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "${table}" t
            WHERE t.${tenantColumn(table)} = $1 AND strpos(t::text, $2) > 0`,
          [primary.tenantId, credential],
        );
        if ((result.rows[0]?.n ?? 0) > 0) found.push(table);
      }
      return found;
    });
    expect(containing, 'the setup credential is stored in plaintext in').toEqual([]);

    // Not logged. The CLI prints it once to the operator; the log is not that.
    expect(primaryLogs.length, 'provisioning logged nothing at all').toBeGreaterThan(0);
    for (const line of primaryLogs) {
      expect(line).not.toContain(credential);
      expect(line).not.toMatch(/\$argon2/);
    }

    // The result carries the credential and not its hash.
    expect(JSON.stringify(primary)).not.toMatch(/\$argon2|passwordHash/i);

    // Every tenant gets its own.
    const other = await provisioning.provisionTenant({
      connectionString: inject('migrationUrl'),
      slug: `sirocco-${RUN}`,
      name: 'Sirocco Support',
      adminEmail: `founder.${RUN}@sirocco.test`,
      adminDisplayName: 'Kofi Mensah',
    });
    expect(other.setupCredential).not.toBe(credential);
  });
});

function listTsFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      out.push(...listTsFiles(path));
    } else if (path.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}
