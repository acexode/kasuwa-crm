import type { TenantTx } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import { loadGrants, mayProgramme, mayTenant } from './grants';

/**
 * `loadGrants` against a scripted TenantTx - no database. What RLS does with
 * these statements is the acceptance suite's job (permissions M3, D-L51);
 * this pins what the loader asks for and how it reads the answer.
 */

// Invented ids; same shape as the seed's, nothing seeds them.
const TENANT = '11111111-0000-4000-8000-00000032000a';
const USER = '11111111-0000-4000-8000-000000320001';
const P1 = '11111111-0000-4000-8000-00000032c001';
const P2 = '11111111-0000-4000-8000-00000032c002';

interface Call {
  text: string;
  values: readonly unknown[];
}

function fakeTx(
  programmeIds: string[],
  rows: { user: unknown[]; memberships: unknown[] },
): { tx: TenantTx; calls: Call[] } {
  const calls: Call[] = [];
  const tx = {
    session: { tenantId: TENANT, userId: USER, programmeIds },
    query: async (text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values });
      return text.includes('FROM "user"') ? rows.user : rows.memberships;
    },
  } as unknown as TenantTx;
  return { tx, calls };
}

describe('loadGrants', () => {
  it('asks only about the session user, in the session tenant, within the resolved scope', async () => {
    const { tx, calls } = fakeTx([P1, P2], {
      user: [{ is_tenant_admin: false }],
      memberships: [
        { programme_id: P1, key: 'admin' },
        { programme_id: P2, key: null },
      ],
    });

    const grants = await loadGrants(tx);

    expect(grants.isTenantAdmin).toBe(false);
    expect(grants.reachableProgrammeIds).toEqual([P1, P2]);
    expect([...grants.programmeSets]).toEqual([
      [P1, 'admin'],
      [P2, null],
    ]);

    const [user, memberships] = calls;
    expect(user?.text).toMatch(/FROM "user"/u);
    expect(user?.values).toEqual([USER, TENANT]);
    // Both the tenant and the scope are repeated on top of RLS (CLAUDE.md 2.3).
    expect(memberships?.text).toMatch(/up\.tenant_id = \$1/u);
    expect(memberships?.text).toMatch(/up\.programme_id = ANY\(\$3::uuid\[\]\)/u);
    expect(memberships?.values).toEqual([TENANT, USER, [P1, P2]]);
  });

  it('reads an unknown or inactive user as no tenant admin, and skips the membership query with no scope', async () => {
    const { tx, calls } = fakeTx([], { user: [], memberships: [] });
    const grants = await loadGrants(tx);
    expect(grants.isTenantAdmin).toBe(false);
    expect(grants.programmeSets.size).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('re-reads the database on every call: nothing is cached between decisions (M3)', async () => {
    const state = { admin: true };
    const calls: string[] = [];
    const tx = {
      session: { tenantId: TENANT, userId: USER, programmeIds: [] },
      query: async (text: string) => {
        calls.push(text);
        return [{ is_tenant_admin: state.admin }];
      },
    } as unknown as TenantTx;

    expect(await mayTenant(tx, 'role.write')).toBe(true);
    state.admin = false;
    expect(await mayTenant(tx, 'role.write')).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('refuses a malformed row rather than guessing', async () => {
    const { tx } = fakeTx([P1], {
      user: [{ is_tenant_admin: 'yes' }],
      memberships: [],
    });
    await expect(loadGrants(tx)).rejects.toThrow();
  });
});

describe('mayProgramme', () => {
  it('answers from the set held in that programme', async () => {
    const { tx } = fakeTx([P1, P2], {
      user: [{ is_tenant_admin: false }],
      memberships: [
        { programme_id: P1, key: 'admin' },
        { programme_id: P2, key: 'agent' },
      ],
    });
    expect(await mayProgramme(tx, 'disposition.write', P1)).toBe(true);
    expect(await mayProgramme(tx, 'disposition.write', P2)).toBe(false);
  });
});
