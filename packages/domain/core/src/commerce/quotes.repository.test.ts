import type { TenantTx } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import { createQuote, QuoteNoPriceError } from './quotes.repository';

const TENANT = '11111111-0000-4000-8000-000000000001';
const PROGRAMME = '11111111-0000-4000-8000-0000000c0001';
const BOOK = '11111111-0000-4000-8000-000000190001';
const PRODUCT = '11111111-0000-4000-8000-0000001a0001';
const VARIANT = '11111111-0000-4000-8000-0000001b0001';

interface Entry {
  productId: string;
  variantId: string | null;
  amount: string;
}

/** A tx whose price_book_entry reads answer from `entries` and which records writes. */
function fakeTx(entries: Entry[], bookCurrency: 'NGN' | 'GHS' | null = 'NGN') {
  const inserts: unknown[][] = [];
  const tx = {
    session: { tenantId: TENANT, userId: 'u', programmeIds: [PROGRAMME] },
    query: (sql: string, params: unknown[] = []): Promise<unknown[]> => {
      if (sql.includes('FROM price_book_entry')) {
        const variantId = sql.includes('variant_id = $5') ? (params[4] as string) : null;
        const hit = entries.find(
          (e) => e.productId === params[3] && e.variantId === variantId,
        );
        return Promise.resolve(hit ? [{ amount_minor: hit.amount }] : []);
      }
      if (sql.includes('FROM price_book')) {
        return Promise.resolve(bookCurrency ? [{ id: BOOK, currency: bookCurrency }] : []);
      }
      if (sql.includes('FROM product_variant') || sql.includes('FROM product')) {
        return Promise.resolve([{ id: 'x' }]);
      }
      if (sql.includes('INSERT INTO quote_line')) inserts.push(params);
      return Promise.resolve([]);
    },
  } as unknown as TenantTx;
  return { tx, inserts };
}

const input = (variantId?: string) => ({
  priceBookId: BOOK,
  lines: [{ productId: PRODUCT, ...(variantId ? { variantId } : {}), quantity: 2 }],
});

describe('createQuote prices lines from the book (D-L211)', () => {
  it('stores the variant entry as the line snapshot when one exists', async () => {
    const { tx, inserts } = fakeTx([
      { productId: PRODUCT, variantId: null, amount: '100' },
      { productId: PRODUCT, variantId: VARIANT, amount: '250' },
    ]);
    await createQuote(tx, PROGRAMME, input(VARIANT));
    expect(inserts[0]?.[7]).toBe('250');
  });

  it('falls back to the product entry when the variant has none', async () => {
    const { tx, inserts } = fakeTx([{ productId: PRODUCT, variantId: null, amount: '100' }]);
    await createQuote(tx, PROGRAMME, input(VARIANT));
    expect(inserts[0]?.[7]).toBe('100');
  });

  it('throws QuoteNoPriceError when the book prices neither', async () => {
    const { tx } = fakeTx([]);
    await expect(createQuote(tx, PROGRAMME, input(VARIANT))).rejects.toBeInstanceOf(
      QuoteNoPriceError,
    );
  });

  it('is null (404) for a book outside the programme or missing', async () => {
    const { tx } = fakeTx([], null);
    expect(await createQuote(tx, PROGRAMME, input())).toBeNull();
  });
});
