import type { TenantTx } from '@kasuwa/db';
import {
  CatalogueCurrencyMismatchError,
  CatalogueProgrammeOutOfScopeError,
  createProduct,
  listPriceBooks,
  listProducts,
  listTaxProfiles,
  updateProduct,
  upsertPriceBookEntry,
  type PriceBook,
  type PriceBookEntry,
  type Product,
  type TaxProfile,
} from '@kasuwa/domain-core';
import { notFound, validationFailed, validationFailedFrom } from '../admin/common/admin-errors';
import {
  CreateProductBody,
  ProgrammeIdParam,
  PriceBookIdParam,
  ProductIdParam,
  UpdateProductBody,
  UpsertPriceBookEntryBody,
} from './commerce.schemas';

export interface ProductWire {
  id: string;
  programmeId: string;
  name: string;
  description: string | null;
  sku: string | null;
  status: string;
  taxProfileId: string | null;
  version: number;
  variants: Array<{ id: string; name: string; sku: string | null }>;
  createdAt: string;
  updatedAt: string;
}

export interface TaxProfileWire {
  id: string;
  programmeId: string;
  name: string;
  rateBps: number;
}

export interface PriceBookEntryWire {
  id: string;
  priceBookId: string;
  productId: string;
  variantId: string | null;
  amountMinor: string;
  currency: string;
}

export interface PriceBookWire {
  id: string;
  programmeId: string;
  name: string;
  currency: string;
  entries: PriceBookEntryWire[];
}

function toIso(date: Date): string {
  return date.toISOString();
}

function toProductWire(product: Product): ProductWire {
  return {
    id: product.id,
    programmeId: product.programmeId,
    name: product.name,
    description: product.description,
    sku: product.sku,
    status: product.status,
    taxProfileId: product.taxProfileId,
    version: product.version,
    variants: product.variants,
    createdAt: toIso(product.createdAt),
    updatedAt: toIso(product.updatedAt),
  };
}

function toTaxWire(profile: TaxProfile): TaxProfileWire {
  return {
    id: profile.id,
    programmeId: profile.programmeId,
    name: profile.name,
    rateBps: profile.rateBps,
  };
}

function toEntryWire(entry: PriceBookEntry): PriceBookEntryWire {
  return {
    id: entry.id,
    priceBookId: entry.priceBookId,
    productId: entry.productId,
    variantId: entry.variantId,
    amountMinor: entry.amountMinor,
    currency: entry.currency,
  };
}

function toBookWire(book: PriceBook): PriceBookWire {
  return {
    id: book.id,
    programmeId: book.programmeId,
    name: book.name,
    currency: book.currency,
    entries: book.entries.map(toEntryWire),
  };
}

function programmeFromPath(tx: TenantTx, params: unknown): string {
  const { programmeId } = ProgrammeIdParam.parse(params);
  if (!tx.session.programmeIds.includes(programmeId)) throw notFound();
  return programmeId;
}

function mapScopeError(error: unknown): never {
  if (error instanceof CatalogueProgrammeOutOfScopeError) {
    throw notFound();
  }
  if (error instanceof CatalogueCurrencyMismatchError) {
    throw validationFailed([{ path: 'currency', code: 'currency_mismatch' }]);
  }
  throw error;
}

export async function listProductsFor(
  tx: TenantTx,
  params: unknown,
): Promise<{ data: ProductWire[] }> {
  const programmeId = programmeFromPath(tx, params);
  try {
    const data = await listProducts(tx, programmeId);
    return { data: data.map(toProductWire) };
  } catch (error) {
    mapScopeError(error);
  }
}

export async function createProductFor(tx: TenantTx, params: unknown, body: unknown): Promise<ProductWire> {
  const programmeId = programmeFromPath(tx, params);
  const parsed = CreateProductBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  try {
    const product = await createProduct(tx, programmeId, parsed.data);
    return toProductWire(product);
  } catch (error) {
    mapScopeError(error);
  }
}

export async function updateProductFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<ProductWire> {
  const { productId } = ProductIdParam.parse(params);
  const parsed = UpdateProductBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  try {
    const updated = await updateProduct(tx, productId, parsed.data);
    if (updated === null) throw notFound();
    return toProductWire(updated);
  } catch (error) {
    mapScopeError(error);
  }
}

export async function listTaxProfilesFor(
  tx: TenantTx,
  params: unknown,
): Promise<{ data: TaxProfileWire[] }> {
  const programmeId = programmeFromPath(tx, params);
  try {
    const data = await listTaxProfiles(tx, programmeId);
    return { data: data.map(toTaxWire) };
  } catch (error) {
    mapScopeError(error);
  }
}

export async function listPriceBooksFor(
  tx: TenantTx,
  params: unknown,
): Promise<{ data: PriceBookWire[] }> {
  const programmeId = programmeFromPath(tx, params);
  try {
    const data = await listPriceBooks(tx, programmeId);
    return { data: data.map(toBookWire) };
  } catch (error) {
    mapScopeError(error);
  }
}

export async function upsertPriceBookEntryFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<PriceBookEntryWire> {
  const { priceBookId } = PriceBookIdParam.parse(params);
  const parsed = UpsertPriceBookEntryBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  try {
    const entry = await upsertPriceBookEntry(tx, priceBookId, parsed.data);
    if (entry === null) throw notFound();
    return toEntryWire(entry);
  } catch (error) {
    mapScopeError(error);
  }
}
