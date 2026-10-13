import type { TenantTx } from '@kasuwa/db';
import type * as DomainCore from '@kasuwa/domain-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createValues } from './deals.service';

/**
 * T-0108 review: the DEFAULT owner of a create goes through the same
 * membership check (and so the same shared membership lock, D-L99) as a named
 * owner, and a caller who is no longer a member is answered as a named
 * non-member owner. No database: the domain-core checks are mocked.
 */

const memberExists = vi.hoisted(() =>
  vi.fn<(tx: unknown, programmeId: string, userId: string) => Promise<boolean>>(),
);

vi.mock('@kasuwa/domain-core', async (importOriginal) => ({
  ...(await importOriginal<typeof DomainCore>()),
  programmeMemberExists: (tx: unknown, programmeId: string, userId: string) =>
    memberExists(tx, programmeId, userId),
}));

// Invented ids; nothing seeds them.
const PROGRAMME = '11111111-0000-4000-8000-00000108c001';
const CALLER = '11111111-0000-4000-8000-00000108C002';
const tx = {
  session: {
    tenantId: '11111111-0000-4000-8000-00000108c000',
    userId: CALLER,
    programmeIds: [PROGRAMME],
  },
} as unknown as TenantTx;

describe('createDeal’s default owner (D-L67, D-L99)', () => {
  beforeEach(() => memberExists.mockReset());

  it('checks the caller’s membership, which takes the lock, and owns the deal in lower case', async () => {
    memberExists.mockResolvedValue(true);
    const values = await createValues(tx, PROGRAMME, { name: 'x' }, { name: 'x' });
    expect(memberExists).toHaveBeenCalledTimes(1);
    expect(memberExists).toHaveBeenCalledWith(tx, PROGRAMME, CALLER.toLowerCase());
    expect(values.ownerUserId).toBe(CALLER.toLowerCase());
  });

  it('a caller no longer a member is 400 unknown_reference at ownerUserId, as a named non-member', async () => {
    memberExists.mockResolvedValue(false);
    const refusal = (raw: Record<string, unknown>) =>
      createValues(tx, PROGRAMME, raw, raw as { name: string }).then(
        () => null,
        (error: { getResponse(): unknown }) => error.getResponse(),
      );
    const defaulted = await refusal({ name: 'x' });
    const named = await refusal({ name: 'x', ownerUserId: CALLER });
    expect(defaulted).toMatchObject({
      statusCode: 400,
      code: 'validation_failed',
      details: [{ path: 'ownerUserId', code: 'unknown_reference' }],
    });
    expect(JSON.stringify(defaulted)).toBe(JSON.stringify(named));
  });

  it('an unowned create (null, reassign holders only) checks nobody', async () => {
    const values = await createValues(
      tx,
      PROGRAMME,
      { name: 'x', ownerUserId: null },
      { name: 'x', ownerUserId: null },
    );
    expect(memberExists).not.toHaveBeenCalled();
    expect(values.ownerUserId).toBeNull();
  });
});
