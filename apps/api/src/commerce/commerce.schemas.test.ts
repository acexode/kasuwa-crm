import { describe, expect, it } from 'vitest';
import { CreateProductBody, UpsertPriceBookEntryBody } from './commerce.schemas';

describe('commerce.schemas', () => {
  it('rejects a closed body with a stray key', () => {
    const result = CreateProductBody.safeParse({
      name: 'X',
      tenantId: '00000000-0000-4000-8000-000000000001',
    });
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

describe('commerce.schemas caps (D-L210)', () => {
  const productId = '11111111-0000-4000-8000-000000190001';

  it('accepts 18 digits and rejects 19 and 20', () => {
    const parse = (amountMinor: string) =>
      UpsertPriceBookEntryBody.safeParse({ productId, amountMinor, currency: 'NGN' }).success;
    expect(parse('9'.repeat(18))).toBe(true);
    expect(parse('1'.repeat(19))).toBe(false);
    expect(parse('1'.repeat(20))).toBe(false);
  });

  it('allows 50 variants and rejects 51', () => {
    const variants = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `V${String(i)}` }));
    expect(CreateProductBody.safeParse({ name: 'X', variants: variants(50) }).success).toBe(true);
    expect(CreateProductBody.safeParse({ name: 'X', variants: variants(51) }).success).toBe(false);
  });
});
