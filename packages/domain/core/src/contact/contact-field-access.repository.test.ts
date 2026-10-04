import type { TenantTx } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import { loadContactFieldAccess } from './contact-field-access.repository';
import { WITHHOLDABLE_CONTACT_FIELDS, withheldContactFields } from './contact-fields';

const TENANT = '11111111-0000-4000-8000-000000000001';
const USER = '11111111-0000-4000-8000-0000000d0001';
const A1 = '11111111-0000-4000-8000-0000000c0001';

function fakeTx(rows: Record<string, unknown>[]): TenantTx {
  return {
    session: { tenantId: TENANT, userId: USER, programmeIds: [A1] },
    query: () => Promise.resolve(rows as never[]),
  } as unknown as TenantTx;
}

describe('loadContactFieldAccess', () => {
  it('withholds every field when scope names a programme the membership read did not return', async () => {
    // Security review finding: the grants ride on the membership rows, so a
    // revocation committed mid-request used to yield an empty matrix and
    // every field defaulting to edit.
    const access = await loadContactFieldAccess(fakeTx([]));
    expect(withheldContactFields(access, A1)).toEqual([...WITHHOLDABLE_CONTACT_FIELDS]);
  });

  it('applies the grants when the membership is there', async () => {
    const access = await loadContactFieldAccess(
      fakeTx([
        {
          programme_id: A1,
          set_key: 'agent',
          grants: [{ field: 'emails', set: 'agent', locked: false, level: 'none' }],
        },
      ]),
    );
    expect(withheldContactFields(access, A1)).toEqual(['emails']);
  });
});
