import { describe, expect, it } from 'vitest';
import { taxAmountFromBase } from './tax.repository';

describe('taxAmountFromBase', () => {
  it('computes 7.5% VAT in minor units with integer rounding', () => {
    expect(taxAmountFromBase(10000n, 750)).toBe(750n);
    expect(taxAmountFromBase(1n, 750)).toBe(1n);
  });
});

import type { TenantTx } from '@kasuwa/db';
import { computeTaxBucketsForLines } from './tax.repository';
import type { QuoteLine } from './quotes.types';

interface Profile {
  product_id: string;
  rate_bps: number;
  name: string;
}

function fakeTx(profiles: Profile[]): TenantTx {
  return {
    session: { tenantId: 't1' },
    query: async () => profiles,
  } as unknown as TenantTx;
}

function line(productId: string, unit: string, qty = 1, discountBps = 0): QuoteLine {
  return {
    id: `l-${productId}`,
    productId,
    variantId: null,
    quantity: qty,
    unitAmountMinor: unit,
    discountBps,
    sortOrder: 0,
  };
}

describe('taxAmountFromBase rounding', () => {
  it('rounds up (ceil) in minor units and never goes through floats', () => {
    expect(taxAmountFromBase(1n, 750)).toBe(1n); // 0.075 -> 1
    expect(taxAmountFromBase(14n, 750)).toBe(2n); // 1.05 -> 2
    expect(taxAmountFromBase(40n, 750)).toBe(3n); // 3.0 exact stays 3
    expect(taxAmountFromBase(10n ** 18n, 750)).toBe(75n * 10n ** 15n);
  });

  it('is zero for zero-rated or non-positive rates', () => {
    expect(taxAmountFromBase(100000n, 0)).toBe(0n);
    expect(taxAmountFromBase(100000n, -5)).toBe(0n);
  });
});

describe('computeTaxBucketsForLines (multi-rate invoice)', () => {
  const profiles: Profile[] = [
    { product_id: 'vat', rate_bps: 750, name: 'VAT 7.5%' },
    { product_id: 'levy', rate_bps: 500, name: 'Education levy' },
    { product_id: 'zero', rate_bps: 0, name: 'VAT zero-rated' },
  ];

  it('buckets mixed rates separately and skips zero-rated and exempt lines', async () => {
    const buckets = await computeTaxBucketsForLines(
      fakeTx(profiles),
      'p1',
      [
        line('vat', '10000'),
        line('levy', '10000'),
        line('zero', '10000'), // zero-rated: no bucket
        line('exempt', '10000'), // no tax profile: exempt, no bucket
      ],
      0,
    );
    expect(buckets).toEqual([
      { code: 'VAT', rateBps: 750, amountMinor: 750n },
      { code: 'TAX', rateBps: 500, amountMinor: 500n },
    ]);
  });

  it('applies the line discount before tax', async () => {
    const buckets = await computeTaxBucketsForLines(
      fakeTx(profiles),
      'p1',
      [line('vat', '10000', 2, 5000)], // net 10000
      0,
    );
    expect(buckets[0]?.amountMinor).toBe(750n);
  });

  it('allocates the quote discount across lines before tax', async () => {
    const buckets = await computeTaxBucketsForLines(
      fakeTx(profiles),
      'p1',
      [line('vat', '10000'), line('levy', '10000')],
      1000, // 10% of 20000 = 2000, 1000 per line
    );
    expect(buckets).toEqual([
      { code: 'VAT', rateBps: 750, amountMinor: 675n },
      { code: 'TAX', rateBps: 500, amountMinor: 450n },
    ]);
  });

  it('rounds per line, so the total can exceed rounding the summed base once', async () => {
    // Two 1-minor lines at 7.5%: per line ceil(0.075)=1 each -> 2.
    // Rounding the combined base (2) once would give ceil(0.15)=1.
    const buckets = await computeTaxBucketsForLines(
      fakeTx(profiles),
      'p1',
      [line('vat', '1'), line('vat', '1')],
      0,
    );
    expect(buckets).toEqual([{ code: 'VAT', rateBps: 750, amountMinor: 2n }]);
    expect(taxAmountFromBase(2n, 750)).toBe(1n);
  });

  it('returns no buckets for an empty quote', async () => {
    expect(await computeTaxBucketsForLines(fakeTx([]), 'p1', [], 0)).toEqual([]);
  });
});
