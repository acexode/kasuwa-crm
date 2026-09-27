import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_CONTACTS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  UnknownSessionUserError,
  withTenantTransaction,
} from '@kasuwa/db';
import { findContactById, listContacts } from '@kasuwa/domain-core';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * ACCEPTANCE — isolation at the repository layer, with no HTTP involved.
 *
 * The API suite could pass while the repository leaks, if a controller happened
 * to filter results. This suite calls the domain functions directly, so the
 * only things standing between the caller and the data are the repository's own
 * predicates and the RLS policies.
 *
 * It also pins down the session resolver's contract: scope comes from
 * user_programme, and asking for a user who is not in the tenant fails rather
 * than returning an empty scope (which would silently look like "a user who can
 * see nothing" instead of "not authenticated").
 */

describe('acceptance: repository-level isolation', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 5 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('resolves programme scope from the database, not from the caller', async () => {
    const session = await withTenantTransaction(
      pool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => tx.session,
    );

    expect(session.programmeIds).toEqual([PROGRAMME_A1]);
  });

  it('resolves the full set for a multi-programme user', async () => {
    const session = await withTenantTransaction(
      pool,
      { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
      async (tx) => tx.session,
    );

    expect([...session.programmeIds].sort()).toEqual([PROGRAMME_A1, PROGRAMME_A2].sort());
  });

  it('resolves an empty scope for a user with no memberships, and returns no rows', async () => {
    const page = await withTenantTransaction(
      pool,
      { tenantId: TENANT_A, userId: USER_A_NO_PROGRAMME },
      async (tx) => {
        expect(tx.session.programmeIds).toEqual([]);
        return listContacts(tx, { limit: 25 });
      },
    );

    expect(page.data).toEqual([]);
  });

  it('refuses a user that does not belong to the requested tenant', async () => {
    await expect(
      withTenantTransaction(
        pool,
        { tenantId: TENANT_B, userId: USER_A_AGENT_1 },
        async (tx) => tx.session,
      ),
    ).rejects.toBeInstanceOf(UnknownSessionUserError);
  });

  it('cannot read a cross-tenant contact by id', async () => {
    const tenantBContact = SEED_CONTACTS.find((row) => row.programmeId === PROGRAMME_B1);
    expect(tenantBContact).toBeDefined();

    const found = await withTenantTransaction(
      pool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => findContactById(tx, tenantBContact!.id),
    );

    expect(found).toBeNull();
  });

  it('cannot read a sibling-programme contact by id', async () => {
    const siblingContact = SEED_CONTACTS.find((row) => row.programmeId === PROGRAMME_A2);
    expect(siblingContact).toBeDefined();

    const found = await withTenantTransaction(
      pool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => findContactById(tx, siblingContact!.id),
    );

    expect(found).toBeNull();
  });

  it('scopes every row of a list to the caller’s tenant', async () => {
    const tenantBIds = new Set(
      SEED_CONTACTS.filter((row) => row.tenantId === TENANT_B).map((row) => row.id),
    );

    const page = await withTenantTransaction(
      pool,
      { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
      async (tx) => listContacts(tx, { limit: 100 }),
    );

    expect(page.data.length).toBeGreaterThan(0);
    for (const contact of page.data) {
      expect(tenantBIds.has(contact.id)).toBe(false);
    }
  });

  it('does not leak session context between pooled connections', async () => {
    // Runs a tenant B session immediately after a tenant A session. If the
    // transaction-local GUCs leaked, the second call would see A's rows — or
    // worse, the first call's scope would persist for an unauthenticated user.
    const a = await withTenantTransaction(
      pool,
      { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
      async (tx) => listContacts(tx, { limit: 100 }),
    );
    const b = await withTenantTransaction(
      pool,
      { tenantId: TENANT_B, userId: USER_B_AGENT_1 },
      async (tx) => listContacts(tx, { limit: 100 }),
    );

    const aIds = new Set(a.data.map((row) => row.id));
    expect(b.data.length).toBeGreaterThan(0);
    for (const contact of b.data) {
      expect(aIds.has(contact.id)).toBe(false);
    }
  });
});
