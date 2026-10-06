import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_TENANTS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { listMyProgrammes } from './my-programmes.repository';

/**
 * T-0043 — `listMyProgrammes` against real Postgres and RLS: exactly the
 * session user's memberships, by name, never the tenant's programmes.
 * Read-only.
 */
describe('listMyProgrammes (T-0043)', () => {
  let pool: ReturnType<typeof createPool>;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 3 });
  });

  afterAll(async () => {
    await pool.end();
  });

  const nameOf = (id: string): string => {
    for (const tenant of SEED_TENANTS) {
      const programme = tenant.programmes.find((candidate) => candidate.id === id);
      if (programme !== undefined) return programme.name;
    }
    throw new Error(`Fixture drift: no seeded programme ${id}`);
  };

  const expected = (ids: string[]) =>
    ids
      .map((id) => ({ id, name: nameOf(id) }))
      .sort((left, right) => left.id.localeCompare(right.id));

  async function mine(tenantId: string, userId: string) {
    const rows = await withTenantTransaction(pool, { tenantId, userId }, (tx) =>
      listMyProgrammes(tx),
    );
    return [...rows].sort((left, right) => left.id.localeCompare(right.id));
  }

  it('returns exactly the caller memberships as closed { id, name } rows', async () => {
    expect(await mine(TENANT_A, USER_A_AGENT_1)).toEqual(expected([PROGRAMME_A1]));
    expect(await mine(TENANT_A, USER_A_AGENT_2)).toEqual(expected([PROGRAMME_A2]));
    const rows = await mine(TENANT_A, USER_A_SUPERVISOR);
    expect(rows).toEqual(expected([PROGRAMME_A1, PROGRAMME_A2]));
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['id', 'name']);
  });

  it('is empty for a user with no membership, and never crosses tenants', async () => {
    expect(await mine(TENANT_A, USER_A_NO_PROGRAMME)).toEqual([]);
    const tenantB = await mine(TENANT_B, USER_B_AGENT_1);
    expect(tenantB).toEqual(expected([PROGRAMME_B1]));
    expect(JSON.stringify(tenantB)).not.toContain(nameOf(PROGRAMME_A1));
  });
});
