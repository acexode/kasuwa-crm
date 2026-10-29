import { COMMERCE_CURRENCIES } from '@kasuwa/domain-core';
import { z } from 'zod';

export const CommerceCurrencySchema = z.enum(COMMERCE_CURRENCIES);

export const AmountMinorSchema = z.string().regex(/^\d{1,18}$/);

export const ProgrammeIdParam = z.object({ programmeId: z.uuid() });

export const ProductIdParam = z.object({ productId: z.uuid() });

export const PriceBookIdParam = z.object({ priceBookId: z.uuid() });

const VariantInput = z.strictObject({
  name: z.string().min(1).max(200),
  sku: z.string().min(1).max(120).optional(),
});

export const CreateProductBody = z.strictObject({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  sku: z.string().min(1).max(120).optional(),
  taxProfileId: z.uuid().optional(),
  variants: z.array(VariantInput).max(50).optional(),
});

export const UpdateProductBody = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  sku: z.string().min(1).max(120).nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
  taxProfileId: z.uuid().nullable().optional(),
});

export const UpsertPriceBookEntryBody = z.strictObject({
  productId: z.uuid(),
  variantId: z.uuid().optional(),
  amountMinor: AmountMinorSchema,
  currency: CommerceCurrencySchema,
});

export const QuoteIdParam = z.object({ quoteId: z.uuid() });

/** D-L211: client lines carry no price; the server reads the book. */
export const QuoteLineBody = z.strictObject({
  productId: z.uuid(),
  variantId: z.uuid().optional(),
  quantity: z.number().int().min(1).max(999999),
  discountBps: z.number().int().min(0).max(10000).optional(),
});

export const CreateQuoteBody = z.strictObject({
  priceBookId: z.uuid(),
  dealId: z.uuid().nullable().optional(),
  contactId: z.uuid().nullable().optional(),
  discountBps: z.number().int().min(0).max(10000).optional(),
  validUntil: z.string().datetime().nullable().optional(),
  lines: z.array(QuoteLineBody).min(1).max(200),
});

export const UpdateQuoteBody = z.strictObject({
  dealId: z.uuid().nullable().optional(),
  contactId: z.uuid().nullable().optional(),
  discountBps: z.number().int().min(0).max(10000).optional(),
  validUntil: z.string().datetime().nullable().optional(),
  lines: z.array(QuoteLineBody).min(1).max(200).optional(),
});

export const SetQuoteStatusBody = z.strictObject({
  status: z.enum(['draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled']),
});

export const ApprovalIdParam = z.object({ approvalId: z.uuid() });

export const DecideApprovalBody = z.strictObject({
  decision: z.enum(['approved', 'rejected']),
});

/** T-0167: email only until WhatsApp quote delivery after S3. */
export const InvoiceIdParam = z.object({ invoiceId: z.uuid() });

export const DealIdParam = z.object({ dealId: z.uuid() });

export const SetInvoiceStatusBody = z.strictObject({
  status: z.enum(['draft', 'issued', 'paid', 'void', 'overdue']),
});

export const CreateFxRateBody = z.strictObject({
  baseCurrency: CommerceCurrencySchema,
  quoteCurrency: CommerceCurrencySchema,
  rateMicros: z.string().regex(/^\d{1,18}$/),
  effectiveAt: z.string().datetime().optional(),
});

export const FxPairQuery = z.strictObject({
  baseCurrency: CommerceCurrencySchema,
  quoteCurrency: CommerceCurrencySchema,
});

export const CreateFxLockBody = z.strictObject({
  baseCurrency: CommerceCurrencySchema,
  quoteCurrency: CommerceCurrencySchema,
});

export const SendQuoteBody = z.strictObject({
  channel: z.literal('email'),
  to: z.email().max(320),
});
