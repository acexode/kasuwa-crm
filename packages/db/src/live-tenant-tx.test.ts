import { describe, expect, it } from 'vitest';
import { TenantTxNotLiveError, assertLiveTenantTx, type TenantTx } from './session';

/**
 * D-L155: `assertLiveTenantTx` believes only the tx object that
 * `withTenantTransaction` is running. Here, with no database: an object
 * literal and every way of copying one. The committed and rolled-back cases,
 * which need a real transaction, are in live-tenant-tx.integration.test.ts.
 */
const forged: TenantTx = {
  session: {
    tenantId: '0a000000-0000-4000-8000-000000000001',
    userId: '0a000000-0000-4000-8000-0000000000f1',
    programmeIds: ['0a000000-0000-4000-8000-0000000000a1'],
  },
  query: async () => [],
};

describe('assertLiveTenantTx', () => {
  it.each([
    ['an object literal', forged],
    ['a spread copy', { ...forged }],
    ['a prototype copy', Object.create(forged) as unknown],
    ['null', null],
    ['a string', 'tx'],
  ])('refuses %s', (_label, value) => {
    expect(() => assertLiveTenantTx(value)).toThrow(TenantTxNotLiveError);
  });

  it('names nothing in its refusal', () => {
    try {
      assertLiveTenantTx(forged);
    } catch (error) {
      expect((error as Error).message).not.toContain(forged.session.tenantId);
      expect((error as TenantTxNotLiveError).code).toBe('tenant_tx_not_live');
      return;
    }
    throw new Error('it did not throw');
  });
});
