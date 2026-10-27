import { z } from 'zod';

export const COMMERCE_CURRENCIES = ['NGN', 'GHS', 'KES', 'ZAR'] as const;
export type CommerceCurrency = (typeof COMMERCE_CURRENCIES)[number];

export const CommerceCurrencySchema = z.enum(COMMERCE_CURRENCIES);

export const ProductStatusSchema = z.enum(['active', 'archived']);
export type ProductStatus = z.infer<typeof ProductStatusSchema>;

export const CreateProductVariantSchema = z.strictObject({
  name: z.string().min(1).max(200),
  sku: z.string().min(1).max(120).optional(),
});

export const CreateProductInputSchema = z.strictObject({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  sku: z.string().min(1).max(120).optional(),
  taxProfileId: z.uuid().optional(),
  variants: z.array(CreateProductVariantSchema).max(50).optional(),
});

export type CreateProductInput = z.infer<typeof CreateProductInputSchema>;

export const UpdateProductInputSchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  sku: z.string().min(1).max(120).nullable().optional(),
  status: ProductStatusSchema.optional(),
  taxProfileId: z.uuid().nullable().optional(),
});

export type UpdateProductInput = z.infer<typeof UpdateProductInputSchema>;

export const UpsertPriceBookEntryInputSchema = z.strictObject({
  productId: z.uuid(),
  variantId: z.uuid().optional(),
  amountMinor: z.string().regex(/^\d+$/),
  currency: CommerceCurrencySchema,
});

export type UpsertPriceBookEntryInput = z.infer<typeof UpsertPriceBookEntryInputSchema>;

export interface ProductVariant {
  id: string;
  name: string;
  sku: string | null;
}

export interface Product {
  id: string;
  programmeId: string;
  name: string;
  description: string | null;
  sku: string | null;
  status: ProductStatus;
  taxProfileId: string | null;
  version: number;
  variants: ProductVariant[];
  createdAt: Date;
  updatedAt: Date;
}

export interface TaxProfile {
  id: string;
  programmeId: string;
  name: string;
  rateBps: number;
}

export interface PriceBookEntry {
  id: string;
  priceBookId: string;
  productId: string;
  variantId: string | null;
  amountMinor: string;
  currency: CommerceCurrency;
}

export interface PriceBook {
  id: string;
  programmeId: string;
  name: string;
  currency: CommerceCurrency;
  entries: PriceBookEntry[];
}
