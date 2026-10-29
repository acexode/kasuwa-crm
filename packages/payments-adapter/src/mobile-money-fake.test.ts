import { describe, expect, it } from 'vitest';
import { ProviderUnavailableError } from './errors';
import { FakeMobileMoneyProvider } from './mobile-money-fake';

const SCOPE = {
  tenantId: '11111111-0000-4000-8000-000000000001',
  programmeId: '11111111-0000-4000-8000-0000000c0001',
};

describe('FakeMobileMoneyProvider', () => {
  it('creates pending collections for mpesa and momo kinds', async () => {
    const provider = new FakeMobileMoneyProvider();
    const mpesa = await provider.createCollection({
      scope: SCOPE,
      kind: 'mpesa',
      amountMinor: 5_000n,
      currency: 'KES',
      reference: 'inv-0001',
      idempotencyKey: 'idem-mm-1',
    });
    expect(mpesa.status).toBe('pending');
    const momo = await provider.createCollection({
      scope: SCOPE,
      kind: 'momo',
      amountMinor: 5_000n,
      currency: 'GHS',
      reference: 'inv-0002',
      idempotencyKey: 'idem-mm-2',
    });
    expect(momo.providerCollectionId).toMatch(/^fake-mm-/);
  });

  it('failNextCreate throws ProviderUnavailableError', async () => {
    const provider = new FakeMobileMoneyProvider();
    provider.failNextCreate('unavailable');
    await expect(
      provider.createCollection({
        scope: SCOPE,
        kind: 'momo',
        amountMinor: 1n,
        currency: 'GHS',
        reference: 'x',
        idempotencyKey: 'idem-fail',
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
