import type { TenantTx } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import {
  MEMBERSHIP_LOCK_NAMESPACE,
  MembershipCheckIsolationError,
  programmeMemberExists,
} from './contact.repository';

// Invented (CLAUDE.md 6.1).
const TENANT = '11111111-0000-4000-8000-0103000000a1';
const PROGRAMME = '11111111-0000-4000-8000-0103000000b1';
const USER = '11111111-0000-4000-8000-0103000000c1';

/** A TenantTx that answers each query from `answers`, in order, and records what it was asked. */
function fakeTx(answers: unknown[][]) {
  const asked: { text: string; values: readonly unknown[] }[] = [];
  const tx: TenantTx = {
    session: { tenantId: TENANT, userId: USER, programmeIds: [PROGRAMME] },
    query: async <T>(text: string, values: readonly unknown[] = []) => {
      asked.push({ text, values });
      return (answers.shift() ?? []) as T[];
    },
  } as TenantTx;
  return { tx, asked };
}

describe('programmeMemberExists (T-0103)', () => {
  it('takes the shared membership lock first, in a statement of its own, then reads membership', async () => {
    const { tx, asked } = fakeTx([[{ isolation: 'read committed' }], [{ ok: 1 }]]);
    expect(await programmeMemberExists(tx, PROGRAMME, USER)).toBe(true);
    expect(asked).toHaveLength(2);
    expect(asked[0]?.text).toContain('pg_advisory_xact_lock_shared');
    expect(asked[0]?.values).toEqual([MEMBERSHIP_LOCK_NAMESPACE, PROGRAMME, USER]);
    expect(asked[1]?.text).toContain('user_programme');
    expect(asked[1]?.text).not.toContain('pg_advisory');
  });

  it('answers false for no membership row', async () => {
    const { tx } = fakeTx([[{ isolation: 'read committed' }], []]);
    expect(await programmeMemberExists(tx, PROGRAMME, USER)).toBe(false);
  });

  for (const isolation of ['repeatable read', 'serializable']) {
    it(`refuses to answer under ${isolation}, before reading membership, naming nobody`, async () => {
      const { tx, asked } = fakeTx([[{ isolation }], [{ ok: 1 }]]);
      const thrown = await programmeMemberExists(tx, PROGRAMME, USER).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(MembershipCheckIsolationError);
      expect(asked).toHaveLength(1);
      const message = String((thrown as Error).message);
      for (const id of [TENANT, PROGRAMME, USER]) expect(message).not.toContain(id);
    });
  }

  it('fails closed when the isolation level is not reported at all', async () => {
    const { tx } = fakeTx([[], [{ ok: 1 }]]);
    await expect(programmeMemberExists(tx, PROGRAMME, USER)).rejects.toBeInstanceOf(
      MembershipCheckIsolationError,
    );
  });

  it('the namespace is ASCII "KMEM", as migration 0031 declares it', () => {
    expect(MEMBERSHIP_LOCK_NAMESPACE).toBe(1263355213);
    expect(Buffer.from([0x4b, 0x4d, 0x45, 0x4d]).toString('ascii')).toBe('KMEM');
  });
});
