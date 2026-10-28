import { describe, expect, it } from 'vitest';
import {
  lineTotalMinor,
  listPriceForProduct,
  quotesForDeal,
  sortCatalogueProducts,
  type PriceBook,
  type Product,
  type Quote,
  type QuoteLine,
} from './commerce-api';

const PRODUCT_A: Product = {
  id: '11111111-1111-4111-8111-111111111111',
  programmeId: 'p1',
  name: 'Beta plan',
  description: null,
  sku: 'B',
  status: 'active',
  taxProfileId: null,
  version: 1,
  variants: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const PRODUCT_B: Product = {
  ...PRODUCT_A,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Alpha plan',
  status: 'archived',
  sku: 'A',
};

const BOOKS: readonly PriceBook[] = [
  {
    id: 'b1',
    programmeId: 'p1',
    name: 'NGN book',
    currency: 'NGN',
    entries: [
      {
        id: 'e1',
        priceBookId: 'b1',
        productId: PRODUCT_A.id,
        variantId: null,
        amountMinor: '150000',
        currency: 'NGN',
      },
      {
        id: 'e2',
        priceBookId: 'b1',
        productId: PRODUCT_B.id,
        variantId: '33333333-3333-4333-8333-333333333333',
        amountMinor: '9900',
        currency: 'NGN',
      },
    ],
  },
  {
    id: 'b2',
    programmeId: 'p1',
    name: 'GHS book',
    currency: 'GHS',
    entries: [
      {
        id: 'e3',
        priceBookId: 'b2',
        productId: PRODUCT_A.id,
        variantId: null,
        amountMinor: '5000',
        currency: 'GHS',
      },
    ],
  },
];

function quote(dealId: string | null, id: string): Quote {
  return {
    id,
    programmeId: 'p1',
    dealId,
    contactId: null,
    currency: 'NGN',
    status: 'draft',
    discountBps: 0,
    validUntil: null,
    version: 1,
    lines: [],
    subtotalMinor: '0',
    discountMinor: '0',
    totalMinor: '0',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('quotesForDeal', () => {
  it('keeps only quotes whose dealId matches', () => {
    const deal = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const listed = [quote(deal, 'q1'), quote(null, 'q2'), quote(other, 'q3'), quote(deal, 'q4')];
    expect(quotesForDeal(listed, deal).map((row) => row.id)).toEqual(['q1', 'q4']);
  });
});

describe('listPriceForProduct', () => {
  it('prefers a no-variant entry in the requested currency and never converts', () => {
    expect(listPriceForProduct(BOOKS, PRODUCT_A.id, 'NGN')).toEqual({
      amountMinor: '150000',
      currency: 'NGN',
    });
    expect(listPriceForProduct(BOOKS, PRODUCT_A.id, 'GHS')).toEqual({
      amountMinor: '5000',
      currency: 'GHS',
    });
    expect(listPriceForProduct(BOOKS, PRODUCT_A.id, 'KES')).toBeNull();
  });

  it('falls back to a variant entry when no base price exists', () => {
    expect(listPriceForProduct(BOOKS, PRODUCT_B.id, 'NGN')).toEqual({
      amountMinor: '9900',
      currency: 'NGN',
    });
  });
});

describe('sortCatalogueProducts', () => {
  it('lists active before archived, then by name', () => {
    expect(sortCatalogueProducts([PRODUCT_B, PRODUCT_A]).map((row) => row.id)).toEqual([
      PRODUCT_A.id,
      PRODUCT_B.id,
    ]);
  });
});

describe('lineTotalMinor', () => {
  it('applies line discount in integer minor units', () => {
    const line: QuoteLine = {
      id: 'l1',
      productId: PRODUCT_A.id,
      variantId: null,
      quantity: 2,
      unitAmountMinor: '10000',
      discountBps: 1000,
    };
    expect(lineTotalMinor(line)).toBe('18000');
  });
});
