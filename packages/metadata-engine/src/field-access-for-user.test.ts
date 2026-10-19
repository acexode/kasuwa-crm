import type { TenantTx } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import * as barrel from './index';
import { loadFieldAccessForUser } from './field-access-for-user';

// Invented (CLAUDE.md 6.1).
const REACHED = '14000000-0000-4000-8000-000000000001';
const NOT_REACHED = '14000000-0000-4000-8000-000000000002';
const USER = '14000000-0000-4000-8000-000000000003';

describe('loadFieldAccessForUser (T-0100, D-L174)', () => {
  it('is not on the package barrel', () => {
    expect('loadFieldAccessForUser' in barrel).toBe(false);
    expect('readFieldAccess' in barrel).toBe(false);
  });

  it('asks only about programmes the session reaches', async () => {
    const asked: unknown[][] = [];
    const tx = {
      session: { tenantId: 't', userId: 'u', programmeIds: [REACHED] },
      query: async (_text: string, values: unknown[]) => {
        asked.push(values);
        return [{ fields: ['owner_user_id'], grants: [], memberships: [] }];
      },
    } as unknown as TenantTx;
    const access = await loadFieldAccessForUser(tx, 'contact', USER, [REACHED, NOT_REACHED]);
    expect(asked[0]?.[3]).toEqual([REACHED]);
    expect([...access.keys()]).toEqual([REACHED]);
  });
});
