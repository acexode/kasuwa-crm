import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  runMigrations,
  SEED_PERMISSION_SETS,
  SEED_TENANTS,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
  type TenantTx,
} from '@kasuwa/db';
import { loadContactFieldAccess, WITHHOLDABLE_CONTACT_FIELDS } from '@kasuwa/domain-core';
import { reseed, withForcedScope } from '@kasuwa/testing';
import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * ACCEPTANCE — T-0053: standard objects get metadata rows, and field security
 * reads them for any object (Agent 2; D-L69, D-P4, D-P9, D-L45, D-L65).
 *
 * Written from the invariants, before any implementation (D-L23, D-L25).
 *
 * ------------------------------------------------------------------------
 * PINNED (the builder must honour these exactly)
 * ------------------------------------------------------------------------
 *
 * 1. MIGRATION. Exactly one file `packages/db/migrations/0025_*.sql`, applied
 *    by the runner. It adds no SECURITY DEFINER function (the census stays at
 *    `app.resolve_session` and `app.resolve_tenant_by_slug`, CLAUDE.md 2.7).
 *    Any table it adds has `tenant_id`, RLS ENABLED and FORCED, a policy whose
 *    WITH CHECK equals its USING, and an entry in TENANT_SCOPED_TABLES.
 *
 * 2. ROWS. Every tenant, however it came to exist, has exactly one
 *    `object_def` for `contact` and one for `account`, both STANDARD:
 *      - "standard" is `is_custom = false`, on `object_def` and on each
 *        standard `field_def`. That is the meaning migration 0002's header
 *        already gives the column; the task's escalation clause says a new
 *        column is allowed, but `is_custom` must still read false;
 *      - `field_def.api_name` is the SNAKE_CASE of the records contract's
 *        wire name (`givenNames` -> `given_names`). The task says "the
 *        contract's wire names", but 0002's CHECK forbids upper case, and
 *        the T-0041 contact path (S3, `contactFieldApiName`) already uses the
 *        snake_case form. This suite follows the database.
 *      - CONTACT: a field_def for every withholdable `Contact` property in
 *        docs/api/records.openapi.yaml (the optional ones; the contract's
 *        `required` list is exactly the never-withheld set). It may also
 *        carry the never-withheld properties; it may carry nothing that is
 *        not a contract property, and never `withheld_fields`.
 *      - ACCOUNT: there is no Account schema in the contract yet (T-0052).
 *        Until there is, the account's wire names are its business columns:
 *        every column of `account` other than id, tenant_id, programme_id,
 *        version, created_at and updated_at has a field_def (today: `name`).
 *        Extras must be a column or, once it exists, an Account contract
 *        property. A later task that adds an account column therefore adds
 *        its field_def in the same migration.
 *    Rows come from three places, and all three produce the SAME standard
 *    catalogue (object, labels, field names, types): the 0025 backfill of
 *    existing tenants, the seed (which TRUNCATEs and so must create them
 *    itself), and tenant provisioning.
 *
 * 3. PROTECTED, as kasuwa_app inside a real `withTenantTransaction`, even as
 *    the tenant admin: a standard object_def or field_def cannot be deleted,
 *    its `api_name` cannot change (D-P4), it cannot stop being standard, and a
 *    standard field cannot be moved to another object. "Refused" means the
 *    statement raises OR touches zero rows; either way the committed end
 *    state is asserted unchanged. NOT over-reached: custom definitions stay
 *    deletable, standard LABELS stay editable (D-P4), and kasuwa_migrator can
 *    still offboard a tenant by `DELETE FROM tenant` (delete-guard D5).
 *
 * 4. TENANT-SCOPED, NOT PROGRAMME-SCOPED (ADR-0008, 0002 header): tenant A's
 *    sessions see only tenant A's definitions, and every session in tenant A
 *    sees the same ones, whichever programmes it reaches.
 *
 * 5. PROVISIONING. `provisionTenant` (`@kasuwa/domain-core/provisioning`,
 *    T-0015) creates the rows in the SAME transaction as the tenant: proved
 *    with a deferred constraint trigger that counts them at COMMIT and then
 *    fails the commit, after which nothing of that tenant may remain.
 *
 * 6. THE LOADER. Exported from `@kasuwa/metadata-engine` (scope:shared, so
 *    any domain package may call it; a loader in `@kasuwa/domain-core` would
 *    be unreachable from a future deals or activities domain under the
 *    boundary rule):
 *
 *      loadFieldAccess(tx: TenantTx, objectApiName: string)
 *        : Promise<ReadonlyMap<programmeId, ReadonlyMap<fieldApiName, 'none' | 'read' | 'edit'>>>
 *
 *    One entry per programme in `tx.session.programmeIds`; each inner map
 *    has one entry per `field_def` of that object, keyed by its api_name.
 *    Semantics are T-0026/T-0041's, unchanged: the set held in the programme
 *    (D-P9); an unsaved cell is `edit` (D-L45); a locked set is `edit`; a
 *    membership with no set gets the weakest unlocked level. For `contact`
 *    it agrees with `loadContactFieldAccess` (which stays exported from
 *    `@kasuwa/domain-core`) field for field. An unknown object, another
 *    tenant's object or a malformed name REJECTS, and the first two are
 *    indistinguishable. Rejecting, not returning an empty map: the default
 *    for an unsaved cell is `edit`, so a caller that reads "absent" as
 *    "default" would fail OPEN on an empty map.
 *
 * ------------------------------------------------------------------------
 * THE BUILDER'S (not pinned)
 * ------------------------------------------------------------------------
 * Field types, labels and `is_required` values (only that all three sources
 * agree); classification; whether never-withheld properties get rows; the
 * mechanism of the protection (trigger, restrictive policy, privileges);
 * where the standard catalogue lives in code; how the contact path is
 * rewritten on top of the loader; the SQL and its round-trip count.
 *
 * ------------------------------------------------------------------------
 * HOW THE BACKFILL IS TESTED
 * ------------------------------------------------------------------------
 * The shared harness migrates an EMPTY database and then seeds it, so in it
 * 0025's backfill runs over zero tenants and proves nothing. The last block
 * therefore builds a second database in the same container: bootstrap,
 * every migration before 0025, three tenants that pre-date 0025 (one bare,
 * one with a custom object, one carrying a `contact` definition and a
 * field-security decision exactly as the T-0041 suite plants them), then the
 * remaining migrations. It connects as the container's superuser (the
 * Testcontainers credentials in packages/testing/src/containers.ts) because
 * only a superuser may CREATE DATABASE, and it drops the database afterwards.
 *
 * Writes: this suite reseeds before it starts and when it finishes.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'packages/db/migrations');
const BOOTSTRAP_SQL = resolve(REPO_ROOT, 'packages/db/sql/bootstrap.sql');
const RECORDS_SPEC = resolve(REPO_ROOT, 'docs/api/records.openapi.yaml');

/** Unique per run, lowercase alphanumeric. */
const RUN = Date.now().toString(36);

type Level = 'none' | 'read' | 'edit';
type FieldAccess = ReadonlyMap<string, ReadonlyMap<string, Level>>;
type LoadFieldAccess = (tx: TenantTx, objectApiName: string) => Promise<FieldAccess>;

// Typed as `string`, so tsc checks this file against the local types above
// rather than against an export that does not exist yet.
const METADATA_ENGINE: string = '@kasuwa/metadata-engine';
const PROVISIONING: string = '@kasuwa/domain-core/provisioning';

async function loadFieldAccessExport(): Promise<LoadFieldAccess> {
  const loaded = (await import(METADATA_ENGINE)) as Record<string, unknown>;
  const candidate = loaded.loadFieldAccess;
  if (typeof candidate !== 'function') {
    throw new Error(
      `T-0053: ${METADATA_ENGINE} does not export loadFieldAccess(tx, objectApiName)`,
    );
  }
  return candidate as LoadFieldAccess;
}

interface ProvisionedTenant {
  tenantId: string;
  adminUserId: string;
}

type ProvisionTenant = (options: {
  connectionString: string;
  slug: string;
  name: string;
  adminEmail: string;
  adminDisplayName: string;
}) => Promise<ProvisionedTenant>;

async function loadProvisionTenant(): Promise<ProvisionTenant> {
  const loaded = (await import(PROVISIONING)) as Record<string, unknown>;
  const candidate = loaded.provisionTenant;
  if (typeof candidate !== 'function') {
    throw new Error(`${PROVISIONING} does not export provisionTenant`);
  }
  return candidate as ProvisionTenant;
}

// --- the contract ------------------------------------------------------------

/** `givenNames` -> `given_names`: the S3 rule, and 0002's api_name CHECK. */
const snake = (wire: string): string =>
  wire.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

interface SchemaShape {
  properties: string[];
  required: string[];
}

function contractSchema(name: string): SchemaShape | null {
  const spec = parseYaml(readFileSync(RECORDS_SPEC, 'utf8')) as {
    components?: { schemas?: Record<string, { properties?: object; required?: string[] }> };
  };
  const schema = spec.components?.schemas?.[name];
  if (schema === undefined) return null;
  return {
    properties: Object.keys(schema.properties ?? {}),
    required: [...(schema.required ?? [])],
  };
}

/** Not a field: the list of what was withheld. Never a field_def. */
const META_PROPERTY = 'withheldFields';

/** Contact field_defs: `required` must exist, nothing outside `allowed`. */
function contactFieldExpectation(): { required: string[]; allowed: Set<string> } {
  const contact = contractSchema('Contact');
  if (contact === null) throw new Error('records.openapi.yaml has no Contact schema');
  const withholdable = contact.properties.filter((name) => !contact.required.includes(name));
  return {
    required: withholdable.map(snake),
    allowed: new Set(contact.properties.filter((name) => name !== META_PROPERTY).map(snake)),
  };
}

const ACCOUNT_SYSTEM_COLUMNS = new Set([
  'id',
  'tenant_id',
  'programme_id',
  'version',
  'created_at',
  'updated_at',
]);

// --- catalogue reads (as kasuwa_migrator: the auditor's view) ---------------

interface DefRow {
  object_id: string;
  object_api: string;
  object_label: string;
  object_custom: boolean;
  field_id: string | null;
  field_api: string | null;
  field_label: string | null;
  field_type: string | null;
  field_custom: boolean | null;
}

async function catalogue(pool: Pool, tenantId: string): Promise<DefRow[]> {
  const result = await pool.query<DefRow>(
    `SELECT o.id AS object_id, o.api_name AS object_api, o.label AS object_label,
            o.is_custom AS object_custom,
            f.id AS field_id, f.api_name AS field_api, f.label AS field_label,
            f.type AS field_type, f.is_custom AS field_custom
       FROM object_def o
       LEFT JOIN field_def f ON f.tenant_id = o.tenant_id AND f.object_id = o.id
      WHERE o.tenant_id = $1
      ORDER BY o.api_name, f.api_name`,
    [tenantId],
  );
  return result.rows;
}

/** The standard part of a tenant's catalogue, id-free, for comparing tenants. */
async function standardTuples(pool: Pool, tenantId: string): Promise<string[]> {
  const rows = await catalogue(pool, tenantId);
  const tuples = new Set<string>();
  for (const row of rows) {
    if (row.object_custom) continue;
    tuples.add(`object ${row.object_api} "${row.object_label}"`);
    if (row.field_api !== null && row.field_custom === false) {
      tuples.add(
        `field ${row.object_api}.${row.field_api} "${row.field_label ?? ''}" ${row.field_type ?? ''}`,
      );
    }
  }
  return [...tuples].sort();
}

/** Field api_name -> is_custom, for one object of one tenant. Throws if the object is absent. */
async function fieldsOf(
  pool: Pool,
  tenantId: string,
  objectApi: string,
): Promise<{ objectId: string; objectCustom: boolean; fields: Map<string, boolean> }> {
  const rows = (await catalogue(pool, tenantId)).filter((row) => row.object_api === objectApi);
  const first = rows[0];
  if (first === undefined) {
    throw new Error(`T-0053: tenant ${tenantId} has no object_def for "${objectApi}"`);
  }
  const fields = new Map<string, boolean>();
  for (const row of rows) {
    if (row.field_api !== null) fields.set(row.field_api, row.field_custom === true);
  }
  return { objectId: first.object_id, objectCustom: first.object_custom, fields };
}

async function accountFieldExpectation(
  pool: Pool,
): Promise<{ required: string[]; allowed: Set<string> }> {
  const columns = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'account'
      ORDER BY ordinal_position`,
  );
  const business = columns.rows
    .map((row) => row.column_name)
    .filter((name) => !ACCOUNT_SYSTEM_COLUMNS.has(name));
  const account = contractSchema('Account');
  const contractNames =
    account === null ? [] : account.properties.filter((name) => name !== META_PROPERTY).map(snake);
  return { required: business, allowed: new Set([...business, ...contractNames]) };
}

function permissionSetId(tenantId: string, key: string): string {
  const set = SEED_PERMISSION_SETS.find(
    (candidate) => candidate.tenantId === tenantId && candidate.key === key,
  );
  if (set === undefined) throw new Error(`no seeded permission set ${key} in ${tenantId}`);
  return set.id;
}

/** The SECURITY DEFINER census, CLAUDE.md 2.7. */
const DEFINERS_SQL = `
  SELECT n.nspname || '.' || p.proname AS name
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   ORDER BY 1`;

const PUBLIC_TABLES_SQL = `
  SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
   ORDER BY 1`;

// =============================================================================
// 1-4: the shared harness database
// =============================================================================

describe('acceptance: standard object metadata (T-0053)', () => {
  let observer: Pool; // kasuwa_migrator, BYPASSRLS: reads and plants only
  let appPool: Pool; // kasuwa_app: every assertion about what a session may do

  const asUser = <T>(tenantId: string, userId: string, work: (tx: TenantTx) => Promise<T>) =>
    withTenantTransaction(appPool, { tenantId, userId }, work);

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    observer = createPool({ connectionString: inject('migrationUrl'), max: 3 });
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 5 });
  });

  afterAll(async () => {
    await appPool?.end();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  // ---------------------------------------------------------------------------
  // 1. The migration
  // ---------------------------------------------------------------------------
  describe('migration 0025', () => {
    it('exists as exactly one 0025_*.sql and has been applied by the runner', async () => {
      const files = readdirSync(MIGRATIONS_DIR).filter((name) => /^0025_.*\.sql$/.test(name));
      expect(files, 'packages/db/migrations has no single 0025_*.sql').toHaveLength(1);

      const applied = await observer.query<{ id: string }>(
        `SELECT id FROM _kasuwa_migration WHERE id LIKE '0025\\_%' ORDER BY id`,
      );
      expect(applied.rows.map((row) => `${row.id}.sql`)).toEqual(files);
    });

    it('adds no SECURITY DEFINER function: the census is still the two CLAUDE.md 2.7 names', async () => {
      // Passes on main too: it is a regression guard, not evidence of work.
      const definers = await observer.query<{ name: string }>(DEFINERS_SQL);
      expect(definers.rows.map((row) => row.name)).toEqual([
        'app.resolve_session',
        'app.resolve_tenant_by_slug',
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. The rows, after migrations and the seed
  // ---------------------------------------------------------------------------
  describe('every seeded tenant has the standard definitions', () => {
    it('reads a non-empty withholdable Contact property list from the contract', () => {
      // Guards the checks below against a vacuous pass on a misread spec.
      const { required } = contactFieldExpectation();
      expect(required).toEqual(expect.arrayContaining(['given_names', 'emails', 'phones']));
      expect(required).not.toContain('id');
      expect(required).not.toContain('withheld_fields');
    });

    it.each(SEED_TENANTS.map((tenant) => [tenant.slug, tenant.id] as const))(
      '%s: exactly one standard object_def for contact and one for account',
      async (_slug, tenantId) => {
        const rows = await observer.query<{ api_name: string; is_custom: boolean; n: number }>(
          `SELECT api_name, bool_or(is_custom) AS is_custom, count(*)::int AS n
             FROM object_def
            WHERE tenant_id = $1 AND api_name IN ('contact', 'account')
            GROUP BY api_name ORDER BY api_name`,
          [tenantId],
        );
        expect(rows.rows).toEqual([
          { api_name: 'account', is_custom: false, n: 1 },
          { api_name: 'contact', is_custom: false, n: 1 },
        ]);
      },
    );

    it.each(SEED_TENANTS.map((tenant) => [tenant.slug, tenant.id] as const))(
      '%s: contact has a standard field_def for every withholdable contract property, and nothing invented',
      async (_slug, tenantId) => {
        const { required, allowed } = contactFieldExpectation();
        const { fields } = await fieldsOf(observer, tenantId, 'contact');

        const missing = required.filter((name) => !fields.has(name));
        expect(missing, 'contact properties with no field_def').toEqual([]);

        const notStandard = required.filter((name) => fields.get(name) === true);
        expect(notStandard, 'contact field_defs marked custom (is_custom = true)').toEqual([]);

        const standard = [...fields].filter(([, custom]) => !custom).map(([name]) => name);
        const invented = standard.filter((name) => !allowed.has(name));
        expect(invented, 'standard contact field_defs that name no contract property').toEqual([]);
      },
    );

    it.each(SEED_TENANTS.map((tenant) => [tenant.slug, tenant.id] as const))(
      '%s: account has a standard field_def for every business column, and nothing invented',
      async (_slug, tenantId) => {
        const { required, allowed } = await accountFieldExpectation(observer);
        // Guards the vacuous pass: the account table has had `name` since 0019.
        expect(required).toContain('name');

        const { fields } = await fieldsOf(observer, tenantId, 'account');
        expect(
          required.filter((name) => !fields.has(name)),
          'account columns with no field_def',
        ).toEqual([]);
        expect(
          required.filter((name) => fields.get(name) === true),
          'account field_defs marked custom',
        ).toEqual([]);
        const standard = [...fields].filter(([, custom]) => !custom).map(([name]) => name);
        expect(
          standard.filter((name) => !allowed.has(name)),
          'standard account field_defs that name no column or contract property',
        ).toEqual([]);
      },
    );

    it('gives both tenants the same standard catalogue, under ids of their own', async () => {
      const a = await standardTuples(observer, TENANT_A);
      const b = await standardTuples(observer, TENANT_B);
      expect(a.length, 'tenant A has no standard definitions').toBeGreaterThan(2);
      expect(b).toEqual(a);

      const ids = await observer.query<{ id: string }>(
        `SELECT id FROM object_def
          WHERE api_name IN ('contact', 'account') AND tenant_id = ANY ($1::uuid[])`,
        [[TENANT_A, TENANT_B]],
      );
      expect(new Set(ids.rows.map((row) => row.id)).size).toBe(4);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Tenant-scoped, not programme-scoped
  // ---------------------------------------------------------------------------
  describe('the definitions are tenant-scoped under RLS', () => {
    it('a tenant A session sees tenant A’s standard definitions and none of tenant B’s', async () => {
      const bContact = await fieldsOf(observer, TENANT_B, 'contact');
      const bFieldIds = (await catalogue(observer, TENANT_B))
        .map((row) => row.field_id)
        .filter((id): id is string => id !== null);
      expect(bFieldIds.length).toBeGreaterThan(0);

      const seen = await asUser(TENANT_A, USER_A_AGENT_1, async (tx) => ({
        objects: await tx.query<{ tenant_id: string; api_name: string }>(
          `SELECT tenant_id, api_name FROM object_def WHERE api_name IN ('contact', 'account')`,
        ),
        fieldTenants: await tx.query<{ tenant_id: string }>(
          'SELECT DISTINCT tenant_id FROM field_def',
        ),
        bObject: await tx.query('SELECT id FROM object_def WHERE id = $1', [bContact.objectId]),
        bFields: await tx.query('SELECT id FROM field_def WHERE id = ANY ($1::uuid[])', [
          bFieldIds,
        ]),
      }));

      expect(seen.objects.map((row) => row.api_name).sort()).toEqual(['account', 'contact']);
      expect(new Set(seen.objects.map((row) => row.tenant_id))).toEqual(new Set([TENANT_A]));
      expect(seen.fieldTenants).toEqual([{ tenant_id: TENANT_A }]);
      expect(seen.bObject).toEqual([]);
      expect(seen.bFields).toEqual([]);
    });

    it('every session in the tenant sees the same definitions, whatever programmes it reaches (ADR-0008)', async () => {
      const read = (userId: string) =>
        asUser(TENANT_A, userId, (tx) =>
          tx.query<{ id: string }>(
            `SELECT f.id FROM field_def f
               JOIN object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
              WHERE o.api_name IN ('contact', 'account')
              ORDER BY f.id`,
          ),
        );
      const a1 = await read(USER_A_AGENT_1);
      expect(a1.length, 'no standard field_defs visible in tenant A').toBeGreaterThan(0);
      expect(await read(USER_A_AGENT_2)).toEqual(a1);
      expect(await read(USER_A_NO_PROGRAMME)).toEqual(a1);
    });

    it('a forged programme scope in tenant A still reads none of tenant B’s definitions', async () => {
      const bContact = await fieldsOf(observer, TENANT_B, 'contact');
      const rows = await withForcedScope(
        appPool,
        { tenantId: TENANT_A, programmeIds: [PROGRAMME_A1, PROGRAMME_A2] },
        (query) =>
          query('SELECT id FROM field_def WHERE tenant_id = $1 OR object_id = $2', [
            TENANT_B,
            bContact.objectId,
          ]),
      );
      expect(rows).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. The generic loader
  // ---------------------------------------------------------------------------
  describe('loadFieldAccess(tx, objectApiName)', () => {
    /** Decisions that could not be planted because a definition is missing. */
    const unplanted: string[] = [];
    const SITE_VISIT_A = '11111111-0000-4000-8000-0000005300a1';
    const INTEL_B = '22222222-0000-4000-8000-0000005300b1';

    async function fieldId(tenantId: string, objectApi: string, fieldApi: string) {
      const result = await observer.query<{ id: string }>(
        `SELECT f.id FROM field_def f
           JOIN object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
          WHERE f.tenant_id = $1 AND o.api_name = $2 AND f.api_name = $3`,
        [tenantId, objectApi, fieldApi],
      );
      return result.rows[0]?.id;
    }

    async function decide(
      tenantId: string,
      objectApi: string,
      fieldApi: string,
      setKey: string,
      level: Level,
    ) {
      const id = await fieldId(tenantId, objectApi, fieldApi);
      if (id === undefined) {
        unplanted.push(`${tenantId}:${objectApi}.${fieldApi}`);
        return;
      }
      await observer.query(
        `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
        [tenantId, id, permissionSetId(tenantId, setKey), level],
      );
    }

    beforeAll(async () => {
      // A custom object per tenant: the loader is for ANY object, and tenant
      // B's is the existence-oracle probe. site_visit has a field called
      // `name`, the same api_name as the account's, to catch a loader that
      // forgets which object a grant belongs to.
      await asUser(TENANT_A, USER_A_SUPERVISOR, async (tx) => {
        await tx.query(
          `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
           VALUES ($1, $2, 'site_visit', 'Site visit', true)`,
          [SITE_VISIT_A, TENANT_A],
        );
        for (const field of ['name', 'priority']) {
          await tx.query(
            `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type)
             VALUES (gen_random_uuid(), $1, $2, $3, $3, 'text')`,
            [TENANT_A, SITE_VISIT_A, field],
          );
        }
      });
      await asUser(TENANT_B, USER_B_AGENT_1, async (tx) => {
        await tx.query(
          `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
           VALUES ($1, $2, 'competitor_intel', 'Competitor intel', true)`,
          [INTEL_B, TENANT_B],
        );
        await tx.query(
          `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type)
           VALUES (gen_random_uuid(), $1, $2, 'rival_name', 'Rival name', 'text')`,
          [TENANT_B, INTEL_B],
        );
      });

      // Tenant A. agent: emails none, phones read. qa_analyst: emails read.
      // admin (locked): emails none, which must read as edit.
      await decide(TENANT_A, 'contact', 'emails', 'agent', 'none');
      await decide(TENANT_A, 'contact', 'phones', 'agent', 'read');
      await decide(TENANT_A, 'contact', 'emails', 'qa_analyst', 'read');
      await decide(TENANT_A, 'contact', 'emails', 'admin', 'none');
      // account.name: agent read, qa_analyst none, admin none (locked -> edit).
      await decide(TENANT_A, 'account', 'name', 'agent', 'read');
      await decide(TENANT_A, 'account', 'name', 'qa_analyst', 'none');
      await decide(TENANT_A, 'account', 'name', 'admin', 'none');
      // site_visit: agent name none, priority read.
      await decide(TENANT_A, 'site_visit', 'name', 'agent', 'none');
      await decide(TENANT_A, 'site_visit', 'priority', 'agent', 'read');
      // Tenant B says the opposite for the same keys: a leak would show.
      await decide(TENANT_B, 'contact', 'emails', 'agent', 'edit');
      await decide(TENANT_B, 'contact', 'phones', 'agent', 'none');
      await decide(TENANT_B, 'account', 'name', 'agent', 'none');

      // USER_A_AGENT_2 holds NO set in A2: never more than the weakest unlocked set.
      await observer.query(
        `UPDATE user_programme SET permission_set_id = NULL
          WHERE tenant_id = $1 AND user_id = $2 AND programme_id = $3`,
        [TENANT_A, USER_A_AGENT_2, PROGRAMME_A2],
      );
    });

    const load = async (tenantId: string, userId: string, objectApi: string) => {
      const loader = await loadFieldAccessExport();
      return asUser(tenantId, userId, (tx) => loader(tx, objectApi));
    };

    const level = (access: FieldAccess, programmeId: string, field: string) =>
      access.get(programmeId)?.get(field);

    it('is exported from @kasuwa/metadata-engine as a function', async () => {
      expect(typeof (await loadFieldAccessExport())).toBe('function');
    });

    it('contact: applies the matrix with T-0026/T-0041 semantics, per programme', async () => {
      await loadFieldAccessExport();
      expect(unplanted, 'decisions that had no field_def to attach to').toEqual([]);

      const agent = await load(TENANT_A, USER_A_AGENT_1, 'contact');
      expect([...agent.keys()]).toEqual([PROGRAMME_A1]);
      expect(level(agent, PROGRAMME_A1, 'emails')).toBe('none');
      expect(level(agent, PROGRAMME_A1, 'phones')).toBe('read');
      expect(level(agent, PROGRAMME_A1, 'given_names'), 'an unsaved cell is edit (D-L45)').toBe(
        'edit',
      );

      const noSet = await load(TENANT_A, USER_A_AGENT_2, 'contact');
      expect([...noSet.keys()]).toEqual([PROGRAMME_A2]);
      expect(level(noSet, PROGRAMME_A2, 'emails'), 'weakest of agent none, qa read').toBe('none');
      expect(level(noSet, PROGRAMME_A2, 'phones'), 'weakest of agent read').toBe('read');
      expect(level(noSet, PROGRAMME_A2, 'given_names')).toBe('edit');

      const admin = await load(TENANT_A, USER_A_SUPERVISOR, 'contact');
      expect(new Set(admin.keys())).toEqual(new Set([PROGRAMME_A1, PROGRAMME_A2]));
      for (const programme of [PROGRAMME_A1, PROGRAMME_A2]) {
        expect(level(admin, programme, 'emails'), 'the locked admin set is always edit').toBe(
          'edit',
        );
      }

      const nobody = await load(TENANT_A, USER_A_NO_PROGRAMME, 'contact');
      expect(nobody.size).toBe(0);
    });

    it('contact: agrees with loadContactFieldAccess for every user, programme and field', async () => {
      const loader = await loadFieldAccessExport();
      expect(unplanted).toEqual([]);
      const users: [string, string][] = [
        [TENANT_A, USER_A_AGENT_1],
        [TENANT_A, USER_A_AGENT_2],
        [TENANT_A, USER_A_SUPERVISOR],
        [TENANT_A, USER_A_NO_PROGRAMME],
        [TENANT_B, USER_B_AGENT_1],
      ];
      for (const [tenantId, userId] of users) {
        const { generic, contact } = await asUser(tenantId, userId, async (tx) => ({
          generic: await loader(tx, 'contact'),
          contact: await loadContactFieldAccess(tx),
        }));
        expect(new Set(generic.keys()), `programmes for ${userId}`).toEqual(
          new Set(contact.keys()),
        );
        const disagreements: string[] = [];
        for (const [programmeId, fields] of contact) {
          for (const field of WITHHOLDABLE_CONTACT_FIELDS) {
            const expected = fields.get(field);
            const actual = level(generic, programmeId, snake(field));
            if (actual !== expected) {
              disagreements.push(`${userId} ${programmeId} ${field}: ${actual} != ${expected}`);
            }
          }
        }
        expect(disagreements).toEqual([]);
      }
    });

    it('account: returns the matrix for account fields, and only account fields', async () => {
      await loadFieldAccessExport();
      expect(unplanted).toEqual([]);
      const { fields } = await fieldsOf(observer, TENANT_A, 'account');

      const agent = await load(TENANT_A, USER_A_AGENT_1, 'account');
      expect([...agent.keys()]).toEqual([PROGRAMME_A1]);
      expect(new Set(agent.get(PROGRAMME_A1)?.keys()), 'one entry per account field_def').toEqual(
        new Set(fields.keys()),
      );
      // Not site_visit.name (none) and not tenant B's account.name (none).
      expect(level(agent, PROGRAMME_A1, 'name')).toBe('read');

      const noSet = await load(TENANT_A, USER_A_AGENT_2, 'account');
      expect(level(noSet, PROGRAMME_A2, 'name'), 'weakest of agent read, qa none').toBe('none');

      const admin = await load(TENANT_A, USER_A_SUPERVISOR, 'account');
      expect(level(admin, PROGRAMME_A1, 'name')).toBe('edit');
      expect(level(admin, PROGRAMME_A2, 'name')).toBe('edit');
    });

    it('any object: reads a custom object’s matrix the same way', async () => {
      await loadFieldAccessExport();
      const agent = await load(TENANT_A, USER_A_AGENT_1, 'site_visit');
      expect(new Set(agent.get(PROGRAMME_A1)?.keys())).toEqual(new Set(['name', 'priority']));
      expect(level(agent, PROGRAMME_A1, 'name')).toBe('none');
      expect(level(agent, PROGRAMME_A1, 'priority')).toBe('read');
    });

    it('fails closed: an unknown object rejects, and another tenant’s object rejects identically', async () => {
      const loader = await loadFieldAccessExport();
      const failure = async (objectApi: string): Promise<{ name: string; message: string }> => {
        try {
          const result = await asUser(TENANT_A, USER_A_AGENT_1, (tx) => loader(tx, objectApi));
          return { name: 'resolved', message: `resolved with ${result.size} programme(s)` };
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          return { name: err.constructor.name, message: err.message.split(objectApi).join('<x>') };
        }
      };

      const unknown = await failure('no_such_object');
      expect(unknown.name, unknown.message).not.toBe('resolved');
      // Tenant B's object exists; from tenant A it must be the same nothing.
      expect(await failure('competitor_intel')).toEqual(unknown);
    });

    it.each(['', 'CONTACT', "contact' OR '1'='1", 'contact;--', 'contact '.repeat(20)])(
      'fails closed on a malformed object name (%j)',
      async (objectApi) => {
        const loader = await loadFieldAccessExport();
        await expect(
          asUser(TENANT_A, USER_A_AGENT_1, (tx) => loader(tx, objectApi)),
        ).rejects.toBeInstanceOf(Error);
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 5. Standard rows are protected (kept last: an attack that lands commits)
  // ---------------------------------------------------------------------------
  describe('standard definitions cannot be deleted, renamed or un-standarded, by kasuwa_app', () => {
    type Attempt =
      | { outcome: 'raised'; code: string }
      | { outcome: 'no rows' }
      | { outcome: 'applied'; rows: number };

    /** One statement as tenant A's ADMIN, in a real tenant transaction that commits if it can. */
    async function attempt(sql: string, values: unknown[]): Promise<Attempt> {
      try {
        const rows = await asUser(TENANT_A, USER_A_SUPERVISOR, (tx) => tx.query(sql, values));
        return rows.length === 0
          ? { outcome: 'no rows' }
          : { outcome: 'applied', rows: rows.length };
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return { outcome: 'raised', code: typeof code === 'string' ? code : String(error) };
      }
    }

    const expectRefused = (result: Attempt, what: string) => {
      expect(result.outcome, `${what} was applied: ${JSON.stringify(result)}`).not.toBe('applied');
    };

    /** Tenant A's standard rows, as committed. Throws if contact or account is missing. */
    async function standardState() {
      await fieldsOf(observer, TENANT_A, 'contact');
      await fieldsOf(observer, TENANT_A, 'account');
      const rows = (await catalogue(observer, TENANT_A)).filter(
        (row) => row.object_api === 'contact' || row.object_api === 'account',
      );
      return rows
        .filter((row) => row.field_custom !== true)
        .map(
          (row) =>
            `${row.object_id} ${row.object_api} ${String(row.object_custom)} ` +
            `${row.field_id ?? '-'} ${row.field_api ?? '-'} ${String(row.field_custom)}`,
        )
        .sort();
    }

    const standardIds = async () => {
      const contact = await fieldsOf(observer, TENANT_A, 'contact');
      const account = await fieldsOf(observer, TENANT_A, 'account');
      const emails = (await catalogue(observer, TENANT_A)).find(
        (row) => row.object_api === 'contact' && row.field_api === 'emails',
      )?.field_id;
      if (emails === undefined || emails === null) {
        throw new Error('T-0053: tenant A has no standard field_def contact.emails');
      }
      return { contactId: contact.objectId, accountId: account.objectId, emailsId: emails };
    };

    it('DELETE of a standard object_def is refused, and nothing changed', async () => {
      const before = await standardState();
      const { contactId, accountId } = await standardIds();

      expectRefused(
        await attempt('DELETE FROM object_def WHERE id = $1 RETURNING id', [contactId]),
        'deleting the contact object_def',
      );
      expectRefused(
        await attempt('DELETE FROM object_def WHERE id = $1 RETURNING id', [accountId]),
        'deleting the account object_def',
      );
      expect(await standardState()).toEqual(before);
    });

    it('DELETE of standard field_defs is refused, one at a time or all at once', async () => {
      const before = await standardState();
      const { contactId, emailsId } = await standardIds();

      expectRefused(
        await attempt('DELETE FROM field_def WHERE id = $1 RETURNING id', [emailsId]),
        'deleting contact.emails',
      );
      expectRefused(
        await attempt('DELETE FROM field_def WHERE object_id = $1 AND NOT is_custom RETURNING id', [
          contactId,
        ]),
        'deleting every standard contact field',
      );
      expect(await standardState()).toEqual(before);
    });

    it('api_name of a standard object_def or field_def cannot change (D-P4)', async () => {
      const before = await standardState();
      const { contactId, emailsId } = await standardIds();

      expectRefused(
        await attempt(`UPDATE object_def SET api_name = 'customer' WHERE id = $1 RETURNING id`, [
          contactId,
        ]),
        'renaming contact',
      );
      expectRefused(
        await attempt(`UPDATE field_def SET api_name = 'email_list' WHERE id = $1 RETURNING id`, [
          emailsId,
        ]),
        'renaming contact.emails',
      );
      expect(await standardState()).toEqual(before);
    });

    it('a standard row cannot be made custom and then deleted', async () => {
      const before = await standardState();
      const { contactId, emailsId } = await standardIds();

      // Two separate transactions: if the flip commits, the delete runs
      // against a row that no longer says it is standard.
      await attempt('UPDATE field_def SET is_custom = true WHERE id = $1 RETURNING id', [emailsId]);
      await attempt('DELETE FROM field_def WHERE id = $1 RETURNING id', [emailsId]);
      await attempt('UPDATE object_def SET is_custom = true WHERE id = $1 RETURNING id', [
        contactId,
      ]);
      await attempt('DELETE FROM object_def WHERE id = $1 RETURNING id', [contactId]);

      expect(await standardState(), 'a standard row was un-standarded or removed').toEqual(before);
    });

    it('a standard field cannot be moved to another object', async () => {
      // Moving contact.emails onto a custom object removes it from contact as
      // surely as a DELETE does, and takes its matrix decisions with it.
      const before = await standardState();
      const { emailsId } = await standardIds();
      const decoy = '11111111-0000-4000-8000-0000005300a2';
      await asUser(TENANT_A, USER_A_SUPERVISOR, (tx) =>
        tx.query(
          `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
           VALUES ($1, $2, 't0053_decoy', 'Decoy', true)`,
          [decoy, TENANT_A],
        ),
      );

      expectRefused(
        await attempt('UPDATE field_def SET object_id = $2 WHERE id = $1 RETURNING id', [
          emailsId,
          decoy,
        ]),
        'moving contact.emails to another object',
      );
      expect(await standardState()).toEqual(before);
    });

    it('does not over-reach: custom definitions stay deletable, even on a standard object', async () => {
      const { contactId } = await standardIds();
      const customField = '11111111-0000-4000-8000-0000005301a1';
      const customObject = '11111111-0000-4000-8000-0000005300a3';
      await asUser(TENANT_A, USER_A_SUPERVISOR, async (tx) => {
        await tx.query(
          `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, is_custom)
           VALUES ($1, $2, $3, 'loyalty_tier', 'Loyalty tier', 'text', true)`,
          [customField, TENANT_A, contactId],
        );
        await tx.query(
          `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
           VALUES ($1, $2, 't0053_scratch', 'Scratch', true)`,
          [customObject, TENANT_A],
        );
      });

      expect(
        await attempt('DELETE FROM field_def WHERE id = $1 RETURNING id', [customField]),
      ).toEqual({ outcome: 'applied', rows: 1 });
      expect(
        await attempt('DELETE FROM object_def WHERE id = $1 RETURNING id', [customObject]),
      ).toEqual({ outcome: 'applied', rows: 1 });
    });

    it('does not over-reach: a standard row’s label stays editable (D-P4)', async () => {
      const { contactId, emailsId } = await standardIds();
      const rolledBack = new Error('roll back the label edit');
      let labels: string[] = [];
      await expect(
        asUser(TENANT_A, USER_A_SUPERVISOR, async (tx) => {
          const object = await tx.query<{ label: string }>(
            `UPDATE object_def SET label = 'Customer' WHERE id = $1 RETURNING label`,
            [contactId],
          );
          const field = await tx.query<{ label: string }>(
            `UPDATE field_def SET label = 'Email addresses' WHERE id = $1 RETURNING label`,
            [emailsId],
          );
          labels = [...object, ...field].map((row) => row.label);
          throw rolledBack;
        }),
      ).rejects.toBe(rolledBack);
      expect(labels).toEqual(['Customer', 'Email addresses']);
    });
  });
});

// =============================================================================
// 5: tenant provisioning
// =============================================================================

describe('acceptance: provisioning creates the standard definitions (T-0053)', () => {
  let observer: Pool;
  let provisionTenant: ProvisionTenant;
  let provisioned: ProvisionedTenant | undefined;
  let provisionError: unknown;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    observer = createPool({ connectionString: inject('migrationUrl'), max: 3 });
    provisionTenant = await loadProvisionTenant();
    try {
      provisioned = await provisionTenant({
        connectionString: inject('migrationUrl'),
        slug: `t0053-ok-${RUN}`,
        name: 'Standard Objects Ltd',
        adminEmail: `admin.${RUN}@t0053.test`,
        adminDisplayName: 'Adaeze Okafor',
      });
    } catch (error) {
      provisionError = error;
    }
  }, 60_000);

  afterAll(async () => {
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  const tenant = (): ProvisionedTenant => {
    expect(provisionError, 'provisionTenant failed').toBeUndefined();
    if (provisioned === undefined) throw new Error('provisionTenant returned nothing');
    return provisioned;
  };

  it('gives a new tenant the same standard catalogue as the seeded tenants', async () => {
    const created = tenant();
    const expected = await standardTuples(observer, TENANT_A);
    expect(expected.length, 'the seeded tenant has no standard definitions').toBeGreaterThan(2);
    expect(await standardTuples(observer, created.tenantId)).toEqual(expected);
  });

  it('the new tenant’s own admin reads them through RLS', async () => {
    const created = tenant();
    const appPool = createPool({ connectionString: inject('databaseUrl'), max: 1 });
    try {
      const rows = await withTenantTransaction(
        appPool,
        { tenantId: created.tenantId, userId: created.adminUserId },
        (tx) =>
          tx.query<{ api_name: string; tenant_id: string }>(
            `SELECT api_name, tenant_id FROM object_def
              WHERE api_name IN ('contact', 'account') ORDER BY api_name`,
          ),
      );
      expect(rows).toEqual([
        { api_name: 'account', tenant_id: created.tenantId },
        { api_name: 'contact', tenant_id: created.tenantId },
      ]);
    } finally {
      await appPool.end();
    }
  });

  it('writes them in the tenant’s own transaction: a commit that fails leaves none', async () => {
    const slug = `t0053-fail-${RUN}`;
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('unsafe slug for the trigger');

    const totals = async () => {
      const result = await observer.query<{ objects: number; fields: number; tenants: number }>(
        `SELECT (SELECT count(*) FROM object_def)::int AS objects,
                (SELECT count(*) FROM field_def)::int  AS fields,
                (SELECT count(*) FROM tenant WHERE slug = $1)::int AS tenants`,
        [slug],
      );
      return result.rows[0];
    };

    // A deferred constraint trigger fires at COMMIT, after everything
    // provisioning does inside its transaction. It reports what the
    // transaction holds for the new tenant at that moment, then fails the
    // commit. Rows written in some other transaction would not be counted,
    // and rows that survive the failure would show in `totals`.
    await observer.query(`
      CREATE FUNCTION public.t0053_fail_at_commit() RETURNS trigger
        LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 't0053 injected commit failure: object_def=% field_def=%',
          (SELECT count(*) FROM object_def WHERE tenant_id = NEW.id),
          (SELECT count(*) FROM field_def WHERE tenant_id = NEW.id);
      END;
      $$`);
    try {
      await observer.query(`
        CREATE CONSTRAINT TRIGGER t0053_fail_at_commit
          AFTER INSERT ON tenant DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW WHEN (NEW.slug = '${slug}')
          EXECUTE FUNCTION public.t0053_fail_at_commit()`);

      const before = await totals();
      let message = '';
      try {
        await provisionTenant({
          connectionString: inject('migrationUrl'),
          slug,
          name: 'Doomed Ltd',
          adminEmail: `doomed.${RUN}@t0053.test`,
          adminDisplayName: 'Bola Ade',
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      const counted = /object_def=(\d+) field_def=(\d+)/.exec(message);
      expect(
        counted,
        `provisioning did not reach the injected commit failure: ${message}`,
      ).not.toBe(null);
      const { required } = contactFieldExpectation();
      expect(
        Number(counted?.[1]),
        'standard object_defs in the provisioning transaction at COMMIT',
      ).toBeGreaterThanOrEqual(2);
      expect(
        Number(counted?.[2]),
        'standard field_defs in the provisioning transaction at COMMIT',
      ).toBeGreaterThanOrEqual(required.length + 1);

      expect(await totals(), 'a failed provisioning left rows behind').toEqual(before);
    } finally {
      await observer.query('DROP TRIGGER IF EXISTS t0053_fail_at_commit ON tenant');
      await observer.query('DROP FUNCTION IF EXISTS public.t0053_fail_at_commit()');
    }
  }, 60_000);

  it('does not block offboarding: kasuwa_migrator can still delete the tenant, definitions and all', async () => {
    // Delete-guard D5: the migrator's deletes still cascade. A BEFORE DELETE
    // guard on standard rows that also fires for the migrator's cascade would
    // make a tenant impossible to offboard.
    const created = tenant();
    const count = async () =>
      (
        await observer.query<{ n: number }>(
          `SELECT ((SELECT count(*) FROM object_def WHERE tenant_id = $1)
                 + (SELECT count(*) FROM field_def WHERE tenant_id = $1))::int AS n`,
          [created.tenantId],
        )
      ).rows[0]?.n;
    expect(await count(), 'nothing to offboard: the tenant has no definitions').toBeGreaterThan(2);

    await observer.query('DELETE FROM tenant WHERE id = $1', [created.tenantId]);
    expect(await count()).toBe(0);
  });
});

// =============================================================================
// 6: the 0025 backfill, on a database whose tenants pre-date it
// =============================================================================

describe('acceptance: 0025 backfills tenants that existed before it (T-0053)', () => {
  const database = `kasuwa_t0053_${RUN}`;
  const LEGACY_PLAIN = '53000000-0000-4000-8000-000000000001';
  const LEGACY_CUSTOM = '53000000-0000-4000-8000-000000000002';
  const LEGACY_CONTACT = '53000000-0000-4000-8000-000000000003';
  const LEGACY_SITE_VISIT = '53000000-0000-4000-8000-0000000000a2';
  const LEGACY_CONTACT_OBJECT = '53000000-0000-4000-8000-0000000000a3';
  const LEGACY_EMAILS = '53000000-0000-4000-8000-0000000000f3';
  const LEGACY_LOYALTY = '53000000-0000-4000-8000-0000000000f4';
  const LEGACY_AGENT_SET = '53000000-0000-4000-8000-0000000000e3';

  let superuserUrl: URL | undefined;
  let backfillMigrationUrl: string;
  let migrator: Pool | undefined;
  let mainObserver: Pool;
  let preDir = '';
  let migrateError: unknown;
  let tablesBefore: string[] = [];
  let definersBefore: string[] = [];

  beforeAll(async () => {
    mainObserver = createPool({ connectionString: inject('migrationUrl'), max: 1 });
    const migrationUrl = new URL(inject('migrationUrl'));

    // Only a superuser may CREATE DATABASE (packages/testing/src/containers.ts).
    const superuser = new URL(migrationUrl.href);
    superuser.username = 'postgres';
    superuser.password = 'postgres';
    superuser.pathname = '/postgres';
    superuserUrl = superuser;
    const admin = new Client({ connectionString: superuser.href });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${database}`);
    } finally {
      await admin.end();
    }

    // The same bootstrap as every other database; roles are cluster-wide
    // and already exist, the grants are per database.
    const inNewDatabase = new URL(superuser.href);
    inNewDatabase.pathname = `/${database}`;
    const bootstrap = new Client({ connectionString: inNewDatabase.href });
    await bootstrap.connect();
    try {
      await bootstrap.query(
        readFileSync(BOOTSTRAP_SQL, 'utf8').replace(/\bDATABASE kasuwa\b/g, `DATABASE ${database}`),
      );
    } finally {
      await bootstrap.end();
    }

    const backfillUrl = new URL(migrationUrl.href);
    backfillUrl.pathname = `/${database}`;
    backfillMigrationUrl = backfillUrl.href;

    // Every migration before 0025: the schema a populated cell has today.
    preDir = mkdtempSync(join(tmpdir(), 't0053-pre-'));
    for (const name of readdirSync(MIGRATIONS_DIR)) {
      if (name.endsWith('.sql') && name < '0025') {
        copyFileSync(join(MIGRATIONS_DIR, name), join(preDir, name));
      }
    }
    await runMigrations({ connectionString: backfillMigrationUrl, migrationsDir: preDir });

    migrator = createPool({ connectionString: backfillMigrationUrl, max: 2 });
    tablesBefore = (await migrator.query<{ name: string }>(PUBLIC_TABLES_SQL)).rows.map(
      (row) => row.name,
    );
    definersBefore = (await migrator.query<{ name: string }>(DEFINERS_SQL)).rows.map(
      (row) => row.name,
    );

    // Three tenants that pre-date 0025.
    for (const [id, slug] of [
      [LEGACY_PLAIN, 'legacy-plain'],
      [LEGACY_CUSTOM, 'legacy-custom'],
      [LEGACY_CONTACT, 'legacy-contact'],
    ] as const) {
      await migrator.query(`INSERT INTO tenant (id, name, slug) VALUES ($1, $2, $3)`, [
        id,
        `Legacy ${slug}`,
        slug,
      ]);
    }
    // One with a custom object of its own.
    await migrator.query(
      `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
       VALUES ($1, $2, 'site_visit', 'Site visit', true)`,
      [LEGACY_SITE_VISIT, LEGACY_CUSTOM],
    );
    await migrator.query(
      `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type)
       VALUES (gen_random_uuid(), $1, $2, 'priority', 'Priority', 'text')`,
      [LEGACY_CUSTOM, LEGACY_SITE_VISIT],
    );
    // One carrying a contact definition exactly as the T-0041 suite plants it,
    // a custom field on it, and a field-security decision that must survive.
    await migrator.query(
      `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
       VALUES ($1, $2, 'contact', 'Contact', false)`,
      [LEGACY_CONTACT_OBJECT, LEGACY_CONTACT],
    );
    await migrator.query(
      `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, is_custom)
       VALUES ($1, $2, $3, 'emails', 'emails', 'text', false),
              ($4, $2, $3, 'loyalty_tier', 'Loyalty tier', 'text', true)`,
      [LEGACY_EMAILS, LEGACY_CONTACT, LEGACY_CONTACT_OBJECT, LEGACY_LOYALTY],
    );
    await migrator.query(
      `INSERT INTO permission_set (id, tenant_id, key, label, locked, sort_order)
       VALUES ($1, $2, 'agent', 'Agent', false, 10)`,
      [LEGACY_AGENT_SET, LEGACY_CONTACT],
    );
    await migrator.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
       VALUES ($1, $2, $3, 'none')`,
      [LEGACY_CONTACT, LEGACY_EMAILS, LEGACY_AGENT_SET],
    );

    // Now the rest of the chain, 0025 included.
    try {
      await runMigrations({ connectionString: backfillMigrationUrl });
    } catch (error) {
      migrateError = error;
    }
  }, 120_000);

  afterAll(async () => {
    await migrator?.end();
    await mainObserver?.end();
    if (preDir !== '') rmSync(preDir, { recursive: true, force: true });
    if (superuserUrl === undefined) return;
    const admin = new Client({ connectionString: superuserUrl.href });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  const pool = (): Pool => {
    if (migrator === undefined) throw new Error('the backfill database was not built');
    return migrator;
  };

  it('applies 0025 cleanly over existing tenants, including one that already has a contact definition', async () => {
    expect(
      migrateError === undefined ? null : String(migrateError),
      'the migration chain failed on a populated database',
    ).toBe(null);
    const applied = await pool().query<{ id: string }>(
      `SELECT id FROM _kasuwa_migration WHERE id LIKE '0025\\_%'`,
    );
    expect(applied.rows, '0025 was not applied').toHaveLength(1);
  });

  it.each([
    ['a bare tenant', LEGACY_PLAIN],
    ['a tenant with a custom object', LEGACY_CUSTOM],
  ])(
    'gives %s exactly the standard catalogue the seed and provisioning give',
    async (_what, tenantId) => {
      const expected = await standardTuples(mainObserver, TENANT_A);
      expect(expected.length, 'the seeded tenant has no standard definitions').toBeGreaterThan(2);
      expect(await standardTuples(pool(), tenantId)).toEqual(expected);
    },
  );

  it('keeps what was already there: the custom object, the contact row, its custom field and its decision', async () => {
    const custom = await fieldsOf(pool(), LEGACY_CUSTOM, 'site_visit');
    expect(custom.objectId).toBe(LEGACY_SITE_VISIT);
    expect(custom.objectCustom).toBe(true);
    expect([...custom.fields.keys()]).toEqual(['priority']);

    const contact = await fieldsOf(pool(), LEGACY_CONTACT, 'contact');
    expect(contact.objectId, 'the existing contact object_def was replaced').toBe(
      LEGACY_CONTACT_OBJECT,
    );
    expect(contact.objectCustom).toBe(false);
    expect(contact.fields.get('loyalty_tier'), 'the custom field was lost or re-marked').toBe(true);
    const { required } = contactFieldExpectation();
    expect(required.filter((name) => contact.fields.get(name) !== false)).toEqual([]);
    await fieldsOf(pool(), LEGACY_CONTACT, 'account');

    // A field-security decision is security configuration: a backfill that
    // drops and recreates contact.emails would silently reset it to `edit`.
    const grant = await pool().query<{ field_id: string; level: string }>(
      `SELECT field_id, level FROM field_security_grant WHERE tenant_id = $1`,
      [LEGACY_CONTACT],
    );
    expect(grant.rows).toEqual([{ field_id: LEGACY_EMAILS, level: 'none' }]);
  });

  it('adds only tables that meet the tenancy invariants and are in TENANT_SCOPED_TABLES', async () => {
    // Vacuous when 0025 adds no table (the expected case): the list is empty
    // and the loop does not run. It is here so that a table that does arrive
    // cannot skip the rules.
    const after = (await pool().query<{ name: string }>(PUBLIC_TABLES_SQL)).rows.map(
      (row) => row.name,
    );
    const added = after.filter((name) => !tablesBefore.includes(name) && !name.startsWith('_'));
    const problems: string[] = [];
    for (const table of added) {
      if (!(TENANT_SCOPED_TABLES as readonly string[]).includes(table)) {
        problems.push(`${table}: not in TENANT_SCOPED_TABLES`);
      }
      const state = await pool().query<{
        enabled: boolean;
        forced: boolean;
        tenant_id: boolean;
      }>(
        `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
                EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'public' AND table_name = c.relname
                           AND column_name = 'tenant_id' AND is_nullable = 'NO') AS tenant_id
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = $1`,
        [table],
      );
      const row = state.rows[0];
      if (row?.enabled !== true) problems.push(`${table}: RLS not enabled`);
      if (row?.forced !== true) problems.push(`${table}: RLS not forced`);
      if (row?.tenant_id !== true) problems.push(`${table}: no NOT NULL tenant_id`);
      const policies = await pool().query<{ qual: string | null; with_check: string | null }>(
        `SELECT qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      );
      if (
        !policies.rows.some((policy) => policy.qual !== null && policy.qual === policy.with_check)
      ) {
        problems.push(`${table}: no policy whose WITH CHECK equals its USING`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('adds no SECURITY DEFINER function', async () => {
    const after = (await pool().query<{ name: string }>(DEFINERS_SQL)).rows.map((row) => row.name);
    expect(definersBefore.length, 'the census before 0025 read nothing').toBe(2);
    expect(after).toEqual(definersBefore);
  });
});
