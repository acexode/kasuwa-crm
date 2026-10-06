import type { TenantTx } from '@kasuwa/db';
import { UnknownObjectDefError } from '@kasuwa/metadata-engine';
import { describe, expect, it } from 'vitest';
import { loadContactFieldAccess } from './contact-field-access.repository';
import {
  contactFieldApiName,
  contactFieldLevel,
  WITHHOLDABLE_CONTACT_FIELDS,
  withheldContactFields,
} from './contact-fields';

const TENANT = '11111111-0000-4000-8000-000000000001';
const USER = '11111111-0000-4000-8000-0000000d0001';
const A1 = '11111111-0000-4000-8000-0000000c0001';
const AGENT_SET = '11111111-0000-4000-8000-0000000e0001';

/** Every withholdable property has a standard field_def since T-0053. */
const ALL_FIELDS = WITHHOLDABLE_CONTACT_FIELDS.map(contactFieldApiName);

function fakeTx(
  rows: Record<string, unknown>[],
  programmeIds: string[] = [A1],
): TenantTx & { calls: number } {
  const tx = {
    calls: 0,
    session: { tenantId: TENANT, userId: USER, programmeIds },
    query: () => {
      tx.calls += 1;
      return Promise.resolve(rows as never[]);
    },
  };
  return tx as unknown as TenantTx & { calls: number };
}

describe('loadContactFieldAccess', () => {
  it('withholds every field when scope names a programme the membership read did not return', async () => {
    // Security review finding (T-0041): a revocation committed mid-request
    // must not yield every field defaulting to edit.
    const access = await loadContactFieldAccess(
      fakeTx([{ fields: ALL_FIELDS, grants: [], memberships: [] }]),
    );
    expect(withheldContactFields(access, A1)).toEqual([...WITHHOLDABLE_CONTACT_FIELDS]);
  });

  it('applies the grants when the membership is there', async () => {
    const access = await loadContactFieldAccess(
      fakeTx([
        {
          fields: ALL_FIELDS,
          grants: [{ field: 'emails', set: AGENT_SET, locked: false, level: 'none' }],
          memberships: [{ programme: A1, set: AGENT_SET, locked: false }],
        },
      ]),
    );
    expect(withheldContactFields(access, A1)).toEqual(['emails']);
    expect(contactFieldLevel(access, A1, 'givenNames')).toBe('edit');
  });

  it('fails closed on a withholdable property that has no field_def (a broken catalogue)', async () => {
    const access = await loadContactFieldAccess(
      fakeTx([
        {
          fields: ALL_FIELDS.filter((name) => name !== 'lga'),
          grants: [],
          memberships: [{ programme: A1, set: AGENT_SET, locked: false }],
        },
      ]),
    );
    expect(withheldContactFields(access, A1)).toEqual(['lga']);
  });

  it('rejects when the tenant has no contact definition, rather than defaulting to edit', async () => {
    await expect(loadContactFieldAccess(fakeTx([]))).rejects.toBeInstanceOf(
      UnknownObjectDefError,
    );
  });

  it('makes no round trip for a session that reaches no programme', async () => {
    const tx = fakeTx([], []);
    const access = await loadContactFieldAccess(tx);
    expect(access.size).toBe(0);
    expect(tx.calls).toBe(0);
  });
});
