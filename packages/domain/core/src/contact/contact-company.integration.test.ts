import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  TENANT_A,
  USER_A_SUPERVISOR,
  withTenantTransaction,
  type TenantTx,
} from '@kasuwa/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { insertContact, listContacts, updateContactIfVersion } from './contact.repository';
import { LEAD_STATUSES } from './contact-lead';

/**
 * T-0076 — `contact.company_name` through the repository, against real
 * Postgres (migration 0028): written, cleared, read back, refused by the
 * CHECK when empty, and matched by `q` only in the programmes the caller
 * names for it. Every test rolls back. Values are invented.
 */

class Rollback extends Error {}

describe('contact company name (T-0076)', () => {
  let pool: ReturnType<typeof createPool>;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function inRollback(work: (tx: TenantTx) => Promise<void>) {
    await expect(
      withTenantTransaction(pool, { tenantId: TENANT_A, userId: USER_A_SUPERVISOR }, async (tx) => {
        await work(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  it('stores, returns and clears it; version moves once per write', async () => {
    await inRollback(async (tx) => {
      const created = await insertContact(tx, PROGRAMME_A1, {
        displayName: 'T0076 Company Probe',
        companyName: 'Probe Quarries Ltd',
      });
      expect(created.companyName).toBe('Probe Quarries Ltd');
      const cleared = await updateContactIfVersion(
        tx,
        { id: created.id, programmeId: PROGRAMME_A1, version: created.version },
        { companyName: null },
      );
      expect(cleared?.companyName).toBeNull();
      expect(cleared?.version).toBe(created.version + 1);
    });
  });

  it('the CHECK refuses an empty company (the API answers 400 first)', async () => {
    await expect(
      withTenantTransaction(pool, { tenantId: TENANT_A, userId: USER_A_SUPERVISOR }, (tx) =>
        insertContact(tx, PROGRAMME_A1, { displayName: 'T0076 Empty', companyName: '' }),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('q matches the company, case- and diacritic-insensitively, only where it is named readable', async () => {
    await inRollback(async (tx) => {
      const inA1 = await insertContact(tx, PROGRAMME_A1, {
        displayName: 'T0076 Lead One',
        companyName: 'Ọ̀jà Probe Foods',
        status: 'new',
      });
      const inA2 = await insertContact(tx, PROGRAMME_A2, {
        displayName: 'T0076 Lead Two',
        companyName: 'Oja Probe Foods',
        status: 'contacted',
      });
      const find = async (companyNameProgrammeIds: string[] | undefined) =>
        (
          await listContacts(tx, {
            limit: 100,
            search: {
              text: 'oja probe',
              displayNameProgrammeIds: [],
              givenNamesProgrammeIds: [],
              familyNameProgrammeIds: [],
              companyNameProgrammeIds,
            },
            filters: { status: LEAD_STATUSES },
          })
        ).data
          .map((contact) => contact.id)
          .sort();

      expect(await find([PROGRAMME_A1, PROGRAMME_A2])).toEqual([inA1.id, inA2.id].sort());
      expect(await find([PROGRAMME_A1]), 'matched where it is withheld').toEqual([inA1.id]);
      expect(await find([]), 'matched with no readable programme').toEqual([]);
      // listContacts passes no company list: its `q` does not search the company.
      expect(await find(undefined)).toEqual([]);
    });
  });
});
