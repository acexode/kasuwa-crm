import { z } from 'zod';
import { CommerceCurrencySchema, type CommerceCurrency } from './catalogue.types';

export const QUOTE_STATUSES = [
  'draft',
  'sent',
  'accepted',
  'rejected',
  'expired',
  'cancelled',
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export const QuoteStatusSchema = z.enum(QUOTE_STATUSES);

export const QUOTE_TRANSITIONS: Readonly<Record<QuoteStatus, readonly QuoteStatus[]>> = {
  draft: ['sent', 'cancelled'],
  sent: ['accepted', 'rejected', 'expired', 'cancelled'],
  accepted: [],
  rejected: [],
  expired: [],
  cancelled: [],
};

export const AmountMinorSchema = z.string().regex(/^\d{1,18}$/);

/** Client line input (D-L211): no price — the server reads it from the quote's book. */
export const QuoteLineInputSchema = z.strictObject({
  productId: z.uuid(),
  variantId: z.uuid().optional(),
  quantity: z.number().int().min(1).max(999999),
  discountBps: z.number().int().min(0).max(10000).optional(),
});

export type QuoteLineInput = z.infer<typeof QuoteLineInputSchema>;

export const CreateQuoteInputSchema = z.strictObject({
  priceBookId: z.uuid(),
  dealId: z.uuid().nullable().optional(),
  contactId: z.uuid().nullable().optional(),
  discountBps: z.number().int().min(0).max(10000).optional(),
  validUntil: z.string().datetime().nullable().optional(),
  lines: z.array(QuoteLineInputSchema).min(1).max(200),
});

export type CreateQuoteInput = z.infer<typeof CreateQuoteInputSchema>;

export const UpdateQuoteInputSchema = z.strictObject({
  dealId: z.uuid().nullable().optional(),
  contactId: z.uuid().nullable().optional(),
  discountBps: z.number().int().min(0).max(10000).optional(),
  validUntil: z.string().datetime().nullable().optional(),
  lines: z.array(QuoteLineInputSchema).min(1).max(200).optional(),
});

export type UpdateQuoteInput = z.infer<typeof UpdateQuoteInputSchema>;

export const SetQuoteStatusInputSchema = z.strictObject({
  status: QuoteStatusSchema,
});

export type SetQuoteStatusInput = z.infer<typeof SetQuoteStatusInputSchema>;

export interface QuoteLine {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  unitAmountMinor: string;
  discountBps: number;
  sortOrder: number;
}

export interface Quote {
  id: string;
  programmeId: string;
  priceBookId: string;
  dealId: string | null;
  contactId: string | null;
  currency: CommerceCurrency;
  status: QuoteStatus;
  discountBps: number;
  validUntil: Date | null;
  version: number;
  lines: QuoteLine[];
  subtotalMinor: string;
  discountMinor: string;
  totalMinor: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Line discounts first, then quote discount on the remainder (R11). */
export function computeQuoteTotals(
  lines: readonly { quantity: number; unitAmountMinor: string; discountBps: number }[],
  quoteDiscountBps: number,
): { subtotalMinor: string; discountMinor: string; totalMinor: string } {
  let subtotal = 0n;
  let lineDiscountTotal = 0n;
  for (const line of lines) {
    const lineSub = BigInt(line.quantity) * BigInt(line.unitAmountMinor);
    subtotal += lineSub;
    lineDiscountTotal += (lineSub * BigInt(line.discountBps)) / 10000n;
  }
  const afterLines = subtotal - lineDiscountTotal;
  const quoteDiscount = (afterLines * BigInt(quoteDiscountBps)) / 10000n;
  const discountMinor = lineDiscountTotal + quoteDiscount;
  const total = subtotal - discountMinor;
  return {
    subtotalMinor: subtotal.toString(),
    discountMinor: discountMinor.toString(),
    totalMinor: (total < 0n ? 0n : total).toString(),
  };
}
