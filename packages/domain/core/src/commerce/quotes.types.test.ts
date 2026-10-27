import { describe, expect, it } from 'vitest';
import { computeQuoteTotals } from './quotes.types';

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
