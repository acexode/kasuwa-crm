import { describe, expect, it } from 'vitest';
import { CreateProductBody, UpsertPriceBookEntryBody } from './commerce.schemas';

describe('commerce.schemas', () => {
  it('rejects a closed body with a stray key', () => {
    const result = CreateProductBody.safeParse({ name: 'X', tenantId: '00000000-0000-4000-8000-000000000001' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown currency and a float amountMinor', () => {
    const badCurrency = UpsertPriceBookEntryBody.safeParse({
      productId: '11111111-0000-4000-8000-000000190001',
      amountMinor: '100',
      currency: 'USD',
    });
    expect(badCurrency.success).toBe(false);

    const floatAmount = UpsertPriceBookEntryBody.safeParse({
      productId: '11111111-0000-4000-8000-000000190001',
      amountMinor: 250.5,
      currency: 'NGN',
    });
    expect(floatAmount.success).toBe(false);
  });
});
