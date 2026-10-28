import * as z from 'zod/mini';
import { requestRecords, type RecordsResult } from './records-request';

/**
 * The browser's half of the commerce catalogue and quotes reads the deal page
 * needs (T-0170): `listProducts`, `listPriceBooks`, `listTaxProfiles` and
 * `listQuotes` from `docs/api/commerce.openapi.yaml`. Its own module so the
 * deal's first paint ships none of it until `deal_products` / `deal_quotes`
 * draw (lazy chunk).
 *
 * SAME-ORIGIN, NO SCOPE HEADER. The programme id is a PATH segment the deal
 * already holds from its pipeline — the session still decides whether that
 * programme is reachable (404 otherwise). Money stays a digit string.
 */

export const COMMERCE_CURRENCIES = ['NGN', 'GHS', 'KES', 'ZAR'] as const;
export type CommerceCurrency = (typeof COMMERCE_CURRENCIES)[number];

export const QUOTE_STATUSES = [
  'draft',
  'sent',
  'accepted',
  'rejected',
  'expired',
  'cancelled',
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

const AmountMinor = z.string().check(z.regex(/^\d{1,18}$/));
const Currency = z.enum(COMMERCE_CURRENCIES);
const QuoteStatusSchema = z.enum(QUOTE_STATUSES);

export const ProductVariant = z.object({
  id: z.string(),
  name: z.string(),
  sku: z.nullable(z.string()),
});
export type ProductVariant = z.infer<typeof ProductVariant>;

export const Product = z.object({
  id: z.string(),
  programmeId: z.string(),
  name: z.string(),
  description: z.nullable(z.string()),
  sku: z.nullable(z.string()),
  status: z.enum(['active', 'archived']),
  taxProfileId: z.nullable(z.string()),
  version: z.int(),
  variants: z.array(ProductVariant),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Product = z.infer<typeof Product>;

export const TaxProfile = z.object({
  id: z.string(),
  programmeId: z.string(),
  name: z.string(),
  rateBps: z.int(),
});
export type TaxProfile = z.infer<typeof TaxProfile>;

export const PriceBookEntry = z.object({
  id: z.string(),
  priceBookId: z.string(),
  productId: z.string(),
  variantId: z.nullable(z.string()),
  amountMinor: AmountMinor,
  currency: Currency,
});
export type PriceBookEntry = z.infer<typeof PriceBookEntry>;

export const PriceBook = z.object({
  id: z.string(),
  programmeId: z.string(),
  name: z.string(),
  currency: Currency,
  entries: z.array(PriceBookEntry),
});
export type PriceBook = z.infer<typeof PriceBook>;

export const QuoteLine = z.object({
  id: z.string(),
  productId: z.string(),
  variantId: z.nullable(z.string()),
  quantity: z.int(),
  unitAmountMinor: AmountMinor,
  discountBps: z.int(),
});
export type QuoteLine = z.infer<typeof QuoteLine>;

export const Quote = z.object({
  id: z.string(),
  programmeId: z.string(),
  dealId: z.nullable(z.string()),
  contactId: z.nullable(z.string()),
  currency: Currency,
  status: QuoteStatusSchema,
  discountBps: z.int(),
  validUntil: z.nullable(z.string()),
  version: z.int(),
  lines: z.array(QuoteLine),
  subtotalMinor: AmountMinor,
  discountMinor: AmountMinor,
  totalMinor: AmountMinor,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Quote = z.infer<typeof Quote>;

const ProductList = z.object({ data: z.array(Product) });
const PriceBookList = z.object({ data: z.array(PriceBook) });
const TaxProfileList = z.object({ data: z.array(TaxProfile) });
const QuoteList = z.object({ data: z.array(Quote) });

function programmePath(programmeId: string, leaf: string): string {
  return `/api/v1/programmes/${encodeURIComponent(programmeId)}/${leaf}`;
}

export async function listProducts(
  programmeId: string,
  signal?: AbortSignal,
): Promise<RecordsResult<readonly Product[]>> {
  const result = await requestRecords(programmePath(programmeId, 'products'), ProductList, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  });
  return result.ok ? { ok: true, value: result.value.data } : result;
}

export async function listPriceBooks(
  programmeId: string,
  signal?: AbortSignal,
): Promise<RecordsResult<readonly PriceBook[]>> {
  const result = await requestRecords(programmePath(programmeId, 'price-books'), PriceBookList, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  });
  return result.ok ? { ok: true, value: result.value.data } : result;
}

export async function listTaxProfiles(
  programmeId: string,
  signal?: AbortSignal,
): Promise<RecordsResult<readonly TaxProfile[]>> {
  const result = await requestRecords(programmePath(programmeId, 'tax-profiles'), TaxProfileList, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  });
  return result.ok ? { ok: true, value: result.value.data } : result;
}

export async function listQuotes(
  programmeId: string,
  signal?: AbortSignal,
): Promise<RecordsResult<readonly Quote[]>> {
  const result = await requestRecords(programmePath(programmeId, 'quotes'), QuoteList, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  });
  return result.ok ? { ok: true, value: result.value.data } : result;
}

/** Quotes whose `dealId` is this deal — programme list, filtered on the client. */
export function quotesForDeal(quotes: readonly Quote[], dealId: string): readonly Quote[] {
  return quotes.filter((quote) => quote.dealId === dealId);
}

/**
 * The list price for a product in `currency`: the price-book entry with no
 * variant first, else any entry for that product. Never converts currencies.
 */
export function listPriceForProduct(
  books: readonly PriceBook[],
  productId: string,
  currency: string,
): { amountMinor: string; currency: CommerceCurrency } | null {
  const matching = books.filter((book) => book.currency === currency);
  let fallback: PriceBookEntry | null = null;
  for (const book of matching) {
    for (const entry of book.entries) {
      if (entry.productId !== productId) continue;
      if (entry.variantId === null) {
        return { amountMinor: entry.amountMinor, currency: entry.currency };
      }
      fallback ??= entry;
    }
  }
  return fallback === null ? null : { amountMinor: fallback.amountMinor, currency: fallback.currency };
}

/** Active catalogue rows first, then archived; name ascending within each. */
export function sortCatalogueProducts(products: readonly Product[]): readonly Product[] {
  return [...products].sort((left, right) => {
    if (left.status !== right.status) return left.status === 'active' ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

/** Line total in minor units: qty × unit, minus line discount bps. Digit string. */
export function lineTotalMinor(line: QuoteLine): string {
  const subtotal = BigInt(line.quantity) * BigInt(line.unitAmountMinor);
  const discount = (subtotal * BigInt(line.discountBps)) / 10000n;
  const total = subtotal - discount;
  return (total < 0n ? 0n : total).toString();
}
