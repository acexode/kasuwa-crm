import {
  createPool,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  withTenantTransaction,
} from '@kasuwa/db';
import { createFieldDef, listObjectDefs, UnknownObjectDefError } from '@kasuwa/metadata-engine';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { reseed } from './containers';
import { seedObjectDef } from './factories';

/**
 * Integration cover for `seedObjectDef` and the metadata repository (T-0002).
 *
 * The acceptance suite at tests/acceptance/metadata owns the isolation
 * contract; this file exists so the fixture helper that suite depends on is
 * itself exercised against a real Postgres, and so the repository's behaviour
 * has cover outside the lead-owned suite.
 */

const OBJECT_A = '11111111-0000-4000-8000-0000000fa001';
const OBJECT_B = '22222222-0000-4000-8000-0000000fb002';

describe('seedObjectDef', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 5 });
  });

  afterAll(async () => {
    await pool.end();
    // This file writes; restore the fixture data for whatever runs next.
    await reseed(inject('migrationUrl'));
  });

  it('is idempotent, so a suite may seed the same definition per test', async () => {
    const first = await seedObjectDef(pool, TENANT_A, OBJECT_A, 'site_visit');
    const second = await seedObjectDef(pool, TENANT_A, OBJECT_A, 'site_visit');

    expect(first.id).toBe(OBJECT_A);
    expect(second.id).toBe(OBJECT_A);
    expect(second.tenantId).toBe(TENANT_A);
  });

  it('lets two tenants hold the same api_name', async () => {
    await seedObjectDef(pool, TENANT_A, OBJECT_A, 'site_visit');
    const b = await seedObjectDef(pool, TENANT_B, OBJECT_B, 'site_visit');
    expect(b.tenantId).toBe(TENANT_B);
  });

  it('is visible to a user in a different programme of the same tenant', async () => {
    // The deliberate exception: metadata is tenant-scoped, not programme-scoped.
    // USER_A_AGENT_2 is in programme A2; the definition was seeded under A1.
    await seedObjectDef(pool, TENANT_A, OBJECT_A, 'site_visit');

    const visible = await withTenantTransaction(
      pool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_2 },
      async (tx) => listObjectDefs(tx),
    );

    expect(visible.map((row) => row.id)).toContain(OBJECT_A);
  });

  it('treats another tenant parent object as unknown rather than forbidden', async () => {
    await seedObjectDef(pool, TENANT_B, OBJECT_B, 'site_visit');

    await expect(
      withTenantTransaction(pool, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, async (tx) =>
        createFieldDef(tx, {
          objectId: OBJECT_B,
          apiName: 'leak',
          label: 'Leak',
          type: 'text',
        }),
      ),
    ).rejects.toThrow(UnknownObjectDefError);
  });

  it('refuses a duplicate api_name on the same object', async () => {
    await seedObjectDef(pool, TENANT_A, OBJECT_A, 'site_visit');

    const addPriority = () =>
      withTenantTransaction(pool, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, async (tx) =>
        createFieldDef(tx, {
          objectId: OBJECT_A,
          apiName: 'priority',
          label: 'Priority',
          type: 'text',
        }),
      );

    await expect(addPriority()).resolves.toBeDefined();
    await expect(addPriority()).rejects.toThrow(/already in use/);
  });
});
