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
