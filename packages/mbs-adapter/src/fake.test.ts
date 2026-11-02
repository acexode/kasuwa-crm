import { describe, expect, it } from 'vitest';
import { FakeMbsProvider, fakeIrn } from './fake';

describe('FakeMbsProvider', () => {
  it('clears with a deterministic IRN', async () => {
    const provider = new FakeMbsProvider();
    const invoiceId = '11111111-0000-4000-8000-000000200001';
    const result = await provider.submit({
      scope: {
        tenantId: '11111111-0000-4000-8000-000000000001',
        programmeId: '11111111-0000-4000-8000-0000000c0001',
      },
      invoiceId,
      invoiceNumber: 'INV-0001',
      totalMinor: 1000n,
      currency: 'NGN',
    });
    expect(result.outcome).toBe('cleared');
    expect(result.irn).toBe(fakeIrn(invoiceId));
    expect(result.qrPayload).toContain(result.irn);
  });

  it('fails when the invoice number contains MBS-FAIL', async () => {
    const provider = new FakeMbsProvider();
    const result = await provider.submit({
      scope: {
        tenantId: '11111111-0000-4000-8000-000000000001',
        programmeId: '11111111-0000-4000-8000-0000000c0001',
      },
      invoiceId: '11111111-0000-4000-8000-000000200002',
      invoiceNumber: 'INV-MBS-FAIL-1',
      totalMinor: 1000n,
      currency: 'NGN',
    });
    expect(result.outcome).toBe('failed');
  });
});
