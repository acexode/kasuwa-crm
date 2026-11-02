import { describe, expect, it } from 'vitest';
import { taxAmountFromBase } from './tax.repository';

describe('taxAmountFromBase', () => {
  it('computes 7.5% VAT in minor units with integer rounding', () => {
    expect(taxAmountFromBase(10000n, 750)).toBe(750n);
    expect(taxAmountFromBase(1n, 750)).toBe(1n);
  });
});
