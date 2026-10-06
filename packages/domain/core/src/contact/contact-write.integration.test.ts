import {
  createPool,
  newId,
  PROGRAMME_A1,
  PROGRAMME_A2,
  SEED_ACCOUNTS,
  SEED_PERMISSION_SETS,
  TENANT_A,
  USER_A_AGENT_2,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
  type TenantTx,
} from '@kasuwa/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  ContactProgrammeOutOfScopeError,
  insertContact,
  listContacts,
  loadTenantDefaultCountry,
  programmeAccountExists,
  programmeMemberExists,
  updateContactIfVersion,
} from './contact.repository';
import { loadContactFieldAccess } from './contact-field-access.repository';
import { contactFieldLevel, withheldContactFields } from './contact-fields';

/**
 * T-0041 — the contact write path and the list's search, sort and scope,
 * against real Postgres (RLS, the 0019 version trigger, the composite FKs).
 *
 * Every test runs in one transaction and rolls it back by throwing
 * `Rollback`, so nothing here outlives the test. Values are invented.
 */

class Rollback extends Error {}

describe('contact writes and search (T-0041)', () => {
  let pool: ReturnType<typeof createPool>;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 3 });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function inRollback(userId: string, work: (tx: TenantTx) => Promise<void>) {
    await expect(
      withTenantTransaction(pool, { tenantId: TENANT_A, userId }, async (tx) => {
        await work(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  it('moves version exactly once per update, and refuses a stale one', async () => {
    await inRollback(USER_A_SUPERVISOR, async (tx) => {
      const created = await insertContact(tx, PROGRAMME_A1, { displayName: 'T0041 Version' });
      expect(created.version).toBe(1);
      expect(created.consentState).toBe('unknown');
      expect(created.tags).toEqual([]);

      const target = { id: created.id, programmeId: PROGRAMME_A1, version: 1 };
      const updated = await updateContactIfVersion(tx, target, { status: 'contacted' });
      // The statement bumps version itself; the trigger leaves it alone.
      expect(updated?.version).toBe(2);
      expect(updated?.status).toBe('contacted');

      expect(await updateContactIfVersion(tx, target, { status: 'customer' })).toBeNull();
      const future = { ...target, version: 9 };
      expect(await updateContactIfVersion(tx, future, { status: 'customer' })).toBeNull();
    });
  });

  it('refuses to write in a programme outside the session, before SQL', async () => {
    await inRollback(USER_A_AGENT_2, async (tx) => {
      await expect(
        insertContact(tx, PROGRAMME_A1, { displayName: 'T0041 Elsewhere' }),
      ).rejects.toBeInstanceOf(ContactProgrammeOutOfScopeError);
    });
  });

  it('cannot tell another tenant’s or another programme’s user or account from nothing', async () => {
    const a1Account = SEED_ACCOUNTS.find((account) => account.programmeId === PROGRAMME_A1);
    await inRollback(USER_A_SUPERVISOR, async (tx) => {
      // D-L67: an owner must be a member of the contact's programme.
      expect(await programmeMemberExists(tx, PROGRAMME_A2, USER_A_AGENT_2)).toBe(true);
      // Cross-programme: agent 2 is real, in this tenant, but only in A2.
      expect(await programmeMemberExists(tx, PROGRAMME_A1, USER_A_AGENT_2)).toBe(false);
      // Cross-tenant and nowhere: the same false.
      expect(await programmeMemberExists(tx, PROGRAMME_A1, USER_B_AGENT_1)).toBe(false);
      expect(await programmeMemberExists(tx, PROGRAMME_A1, newId())).toBe(false);
      expect(await programmeAccountExists(tx, PROGRAMME_A1, a1Account?.id ?? '')).toBe(true);
      expect(await programmeAccountExists(tx, PROGRAMME_A2, a1Account?.id ?? '')).toBe(false);
    });
  });

  it('reads the default country from the tenant', async () => {
    await inRollback(USER_A_SUPERVISOR, async (tx) => {
      expect(await loadTenantDefaultCountry(tx)).toBe('NG');
    });
  });

  it('searches names without diacritics and phones only where they may be read', async () => {
    await inRollback(USER_A_SUPERVISOR, async (tx) => {
      const adebayo = await insertContact(tx, PROGRAMME_A1, {
        displayName: 'T0041 Probe',
        givenNames: 'Adébáyọ̀',
        phones: [{ type: 'mobile', e164: '+2348069990411' }],
      });
      const everywhere = [PROGRAMME_A1, PROGRAMME_A2];
      const search = (text: string, phoneE164: string | null, phoneProgrammeIds: string[]) =>
        listContacts(tx, {
          limit: 100,
          search: {
            text,
            phoneE164,
            phoneProgrammeIds,
            givenNamesProgrammeIds: everywhere,
            familyNameProgrammeIds: everywhere,
          },
        });

      expect((await search('adebayo', null, everywhere)).data.map((c) => c.id)).toEqual([
        adebayo.id,
      ]);
      const byPhone = await search('08069990411', '+2348069990411', everywhere);
      expect(byPhone.data.map((c) => c.id)).toEqual([adebayo.id]);
      // Phones withheld in A1: the same number finds nothing there.
      expect((await search('08069990411', '+2348069990411', [PROGRAMME_A2])).data).toEqual([]);
      // Wildcards are literal.
      expect((await search('%', null, everywhere)).data).toEqual([]);
      expect((await search('_', null, everywhere)).data).toEqual([]);
    });
  });

  it('loads field access in one statement, with the matrix semantics', async () => {
    const agentSet = SEED_PERMISSION_SETS.find(
      (set) => set.tenantId === TENANT_A && set.key === 'agent',
    );
    const adminSet = SEED_PERMISSION_SETS.find(
      (set) => set.tenantId === TENANT_A && set.key === 'admin',
    );
    await inRollback(USER_A_AGENT_2, async (tx) => {
      // Nothing saved: everything edit (D-L45).
      const before = await loadContactFieldAccess(tx);
      expect(withheldContactFields(before, PROGRAMME_A2)).toEqual([]);

      // The seeded tenant's standard contact definitions (T-0053): decisions
      // attach to the field_defs every tenant has, never to planted ones.
      for (const [field, setId, level] of [
        ['emails', agentSet?.id, 'none'],
        ['lga', agentSet?.id, 'read'],
        // A locked set is edit whatever is stored.
        ['phones', adminSet?.id, 'none'],
      ] as const) {
        const rows = await tx.query<{ id: string }>(
          `SELECT f.id
             FROM field_def f
             JOIN object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
            WHERE f.tenant_id = $1 AND o.api_name = 'contact' AND f.api_name = $2
              AND NOT f.is_custom`,
          [TENANT_A, field],
        );
        const fieldId = rows[0]?.id;
        if (fieldId === undefined) throw new Error(`no standard contact.${field} field_def`);
        await tx.query(
          `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
           VALUES ($1, $2, $3, $4)`,
          [TENANT_A, fieldId, setId, level],
        );
      }

      const access = await loadContactFieldAccess(tx);
      expect(withheldContactFields(access, PROGRAMME_A2)).toEqual(['emails']);
      expect(contactFieldLevel(access, PROGRAMME_A2, 'lga')).toBe('read');
      expect(contactFieldLevel(access, PROGRAMME_A2, 'phones')).toBe('edit');
      // Agent 2 does not reach A1: fail closed.
      expect(contactFieldLevel(access, PROGRAMME_A1, 'status')).toBe('none');
    });
  });

  it('pages by displayName in name order, every row once', async () => {
    await inRollback(USER_A_SUPERVISOR, async (tx) => {
      const collected: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const result = await listContacts(tx, { limit: 2, cursor, sort: 'displayName' });
        collected.push(...result.data.map((contact) => contact.displayName));
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }
      const all = await listContacts(tx, { limit: 100, sort: 'displayName' });
      expect(collected).toEqual(all.data.map((contact) => contact.displayName));
      expect(collected).toHaveLength(6);
    });
  });
});
