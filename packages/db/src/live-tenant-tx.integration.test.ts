import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { TENANT_A, USER_A_AGENT_1 } from './fixtures';
import { createPool } from './pool';
import { TenantTxNotLiveError, assertLiveTenantTx, withTenantTransaction, type TenantTx } from './session';

/**
 * D-L155: a TenantTx is live only while its transaction is open. Inside the
 * callback the real tx passes and a copy of it does not; once the transaction
 * has committed, or rolled back, the same object is refused.
 */
describe('a tenant transaction is live only while it is open', () => {
  let appPool: Pool;

  beforeAll(() => {
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  });

  afterAll(async () => {
    await appPool.end();
  });

  it('accepts the running tx, refuses a copy of it, and refuses it after COMMIT', async () => {
    let kept: TenantTx | undefined;
    await withTenantTransaction(appPool, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, async (tx) => {
      expect(() => assertLiveTenantTx(tx)).not.toThrow();
      expect(() => assertLiveTenantTx({ ...tx })).toThrow(TenantTxNotLiveError);
      expect(() => assertLiveTenantTx({ session: tx.session, query: tx.query })).toThrow(TenantTxNotLiveError);
      kept = tx;
    });
    expect(() => assertLiveTenantTx(kept)).toThrow(TenantTxNotLiveError);
  });

  it('refuses it after ROLLBACK', async () => {
    let kept: TenantTx | undefined;
    await expect(
      withTenantTransaction(appPool, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, async (tx) => {
        kept = tx;
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(() => assertLiveTenantTx(kept)).toThrow(TenantTxNotLiveError);
  });
});
