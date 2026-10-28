import { describe, expect, it } from 'vitest';
import {
  computeQuoteTotals,
  CreateQuoteInputSchema,
  UpdateQuoteInputSchema,
} from './quotes.types';

describe('computeQuoteTotals', () => {
  it('sums quantity × unit before discounts', () => {
    expect(
      computeQuoteTotals(
        [{ quantity: 2, unitAmountMinor: '25000000', discountBps: 0 }],
        0,
      ),
    ).toEqual({
      subtotalMinor: '50000000',
      discountMinor: '0',
      totalMinor: '50000000',
    });
  });

  it('applies line discounts then quote discount on the remainder', () => {
    expect(
      computeQuoteTotals(
        [{ quantity: 1, unitAmountMinor: '25000000', discountBps: 0 }],
        1000,
      ),
    ).toEqual({
      subtotalMinor: '25000000',
      discountMinor: '2500000',
      totalMinor: '22500000',
    });
  });

  it('never returns a negative total', () => {
    expect(
      computeQuoteTotals(
        [{ quantity: 1, unitAmountMinor: '100', discountBps: 10000 }],
        10000,
      ),
    ).toEqual({
      subtotalMinor: '100',
      discountMinor: '100',
      totalMinor: '0',
    });
  });
});

describe('quote bodies carry no price or currency (D-L211)', () => {
  const line = { productId: '11111111-0000-4000-8000-0000001a0001', quantity: 1 };
  const book = '11111111-0000-4000-8000-000000190001';

  it('accepts a book and priceless lines', () => {
    expect(CreateQuoteInputSchema.safeParse({ priceBookId: book, lines: [line] }).success).toBe(
      true,
    );
  });

  it('refuses a posted unitAmountMinor or currency, and a missing book', () => {
    expect(
      CreateQuoteInputSchema.safeParse({
        priceBookId: book,
        lines: [{ ...line, unitAmountMinor: '1' }],
      }).success,
    ).toBe(false);
    expect(
      CreateQuoteInputSchema.safeParse({ priceBookId: book, currency: 'NGN', lines: [line] })
        .success,
    ).toBe(false);
    expect(CreateQuoteInputSchema.safeParse({ lines: [line] }).success).toBe(false);
    expect(
      UpdateQuoteInputSchema.safeParse({ lines: [{ ...line, unitAmountMinor: '1' }] }).success,
    ).toBe(false);
  });
});
