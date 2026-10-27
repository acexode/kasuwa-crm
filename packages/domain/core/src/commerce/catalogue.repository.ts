import { newId, type TenantTx } from '@kasuwa/db';
import type {
  CommerceCurrency,
  CreateProductInput,
  PriceBook,
  PriceBookEntry,
  Product,
  ProductVariant,
  TaxProfile,
  UpdateProductInput,
  UpsertPriceBookEntryInput,
} from './catalogue.types';

export class CatalogueProgrammeOutOfScopeError extends Error {
  constructor() {
    super('Refusing to access catalogue data in a programme outside the session scope');
    this.name = 'CatalogueProgrammeOutOfScopeError';
  }
}

function assertInScope(tx: TenantTx, programmeId: string): void {
  if (!tx.session.programmeIds.includes(programmeId)) {
    throw new CatalogueProgrammeOutOfScopeError();
  }
}

interface ProductRow {
  id: string;
  programme_id: string;
  name: string;
  description: string | null;
  sku: string | null;
  status: 'active' | 'archived';
  tax_profile_id: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface VariantRow {
  id: string;
  name: string;
  sku: string | null;
}

function toVariant(row: VariantRow): ProductVariant {
  return { id: row.id, name: row.name, sku: row.sku };
}

async function loadVariants(
  tx: TenantTx,
  programmeId: string,
  productIds: readonly string[],
): Promise<Map<string, ProductVariant[]>> {
  const map = new Map<string, ProductVariant[]>();
  if (productIds.length === 0) return map;
  const rows = await tx.query<VariantRow & { product_id: string }>(
    `SELECT id, product_id, name, sku
       FROM product_variant
      WHERE tenant_id = $1::uuid
        AND programme_id = $2::uuid
        AND product_id = ANY($3::uuid[])
      ORDER BY created_at, id`,
    [tx.session.tenantId, programmeId, productIds],
  );
  for (const row of rows) {
    const list = map.get(row.product_id) ?? [];
    list.push(toVariant(row));
    map.set(row.product_id, list);
  }
  return map;
}

function toProduct(row: ProductRow, variants: ProductVariant[]): Product {
  return {
    id: row.id,
    programmeId: row.programme_id,
    name: row.name,
    description: row.description,
    sku: row.sku,
    status: row.status,
    taxProfileId: row.tax_profile_id,
    version: row.version,
    variants,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PRODUCT_COLUMNS = `id, programme_id, name, description, sku, status, tax_profile_id, version, created_at, updated_at`;

export async function listProducts(tx: TenantTx, programmeId: string): Promise<Product[]> {
  assertInScope(tx, programmeId);
  const rows = await tx.query<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS}
       FROM product
      WHERE tenant_id = $1::uuid
        AND programme_id = $2::uuid
      ORDER BY name COLLATE "C", id`,
    [tx.session.tenantId, programmeId],
  );
  const variants = await loadVariants(
    tx,
    programmeId,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toProduct(row, variants.get(row.id) ?? []));
}

export async function findProductById(tx: TenantTx, productId: string): Promise<Product | null> {
  const rows = await tx.query<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS}
       FROM product
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid`,
    [tx.session.tenantId, productId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  assertInScope(tx, row.programme_id);
  const variants = await loadVariants(tx, row.programme_id, [row.id]);
  return toProduct(row, variants.get(row.id) ?? []);
}

export async function createProduct(
  tx: TenantTx,
  programmeId: string,
  input: CreateProductInput,
): Promise<Product> {
  assertInScope(tx, programmeId);
  const productId = newId();
  const inserted = await tx.query<ProductRow>(
    `INSERT INTO product
       (id, tenant_id, programme_id, name, description, sku, tax_profile_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid)
     RETURNING ${PRODUCT_COLUMNS}`,
    [
      productId,
      tx.session.tenantId,
      programmeId,
      input.name,
      input.description ?? null,
      input.sku ?? null,
      input.taxProfileId ?? null,
    ],
  );
  const row = inserted[0];
  if (row === undefined) throw new Error('INSERT product returned no row');

  const variants: ProductVariant[] = [];
  for (const variant of input.variants ?? []) {
    const variantId = newId();
    const inserted = await tx.query<VariantRow>(
      `INSERT INTO product_variant
         (id, tenant_id, programme_id, product_id, name, sku)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)
       RETURNING id, name, sku`,
      [
        variantId,
        tx.session.tenantId,
        programmeId,
        productId,
        variant.name,
        variant.sku ?? null,
      ],
    );
    const v = inserted.at(0);
    if (v !== undefined) variants.push(toVariant(v));
  }

  return toProduct(row, variants);
}

export async function updateProduct(
  tx: TenantTx,
  productId: string,
  input: UpdateProductInput,
): Promise<Product | null> {
  const current = await findProductById(tx, productId);
  if (current === null) return null;

  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;
  const add = (column: string, value: unknown): void => {
    sets.push(`${column} = $${index}`);
    values.push(value);
    index += 1;
  };

  if (input.name !== undefined) add('name', input.name);
  if (input.description !== undefined) add('description', input.description);
  if (input.sku !== undefined) add('sku', input.sku);
  if (input.status !== undefined) add('status', input.status);
  if (input.taxProfileId !== undefined) add('tax_profile_id', input.taxProfileId);

  if (sets.length === 0) return current;

  sets.push('version = version + 1');

  const updated = await tx.query<ProductRow>(
    `UPDATE product
        SET ${sets.join(', ')}
      WHERE id = $${index}::uuid
        AND tenant_id = $${index + 1}::uuid
        AND programme_id = $${index + 2}::uuid
      RETURNING ${PRODUCT_COLUMNS}`,
    [...values, productId, tx.session.tenantId, current.programmeId],
  );
  const row = updated[0];
  if (row === undefined) return null;
  const variants = await loadVariants(tx, row.programme_id, [row.id]);
  return toProduct(row, variants.get(row.id) ?? []);
}

export async function listTaxProfiles(tx: TenantTx, programmeId: string): Promise<TaxProfile[]> {
  assertInScope(tx, programmeId);
  const rows = await tx.query<{
    id: string;
    programme_id: string;
    name: string;
    rate_bps: number;
  }>(
    `SELECT id, programme_id, name, rate_bps
       FROM tax_profile
      WHERE tenant_id = $1::uuid
        AND programme_id = $2::uuid
      ORDER BY name COLLATE "C", id`,
    [tx.session.tenantId, programmeId],
  );
  return rows.map((row) => ({
    id: row.id,
    programmeId: row.programme_id,
    name: row.name,
    rateBps: row.rate_bps,
  }));
}

interface PriceBookRow {
  id: string;
  programme_id: string;
  name: string;
  currency: CommerceCurrency;
}

interface EntryRow {
  id: string;
  price_book_id: string;
  product_id: string;
  variant_id: string | null;
  amount_minor: string;
  currency: CommerceCurrency;
}

function toEntry(row: EntryRow): PriceBookEntry {
  return {
    id: row.id,
    priceBookId: row.price_book_id,
    productId: row.product_id,
    variantId: row.variant_id,
    amountMinor: row.amount_minor,
    currency: row.currency,
  };
}

export async function listPriceBooks(tx: TenantTx, programmeId: string): Promise<PriceBook[]> {
  assertInScope(tx, programmeId);
  const books = await tx.query<PriceBookRow>(
    `SELECT id, programme_id, name, currency
       FROM price_book
      WHERE tenant_id = $1::uuid
        AND programme_id = $2::uuid
      ORDER BY currency`,
    [tx.session.tenantId, programmeId],
  );
  if (books.length === 0) return [];

  const bookIds = books.map((book) => book.id);
  const entries = await tx.query<EntryRow>(
    `SELECT id, price_book_id, product_id, variant_id, amount_minor::text, currency
       FROM price_book_entry
      WHERE tenant_id = $1::uuid
        AND programme_id = $2::uuid
        AND price_book_id = ANY($3::uuid[])`,
    [tx.session.tenantId, programmeId, bookIds],
  );
  const byBook = new Map<string, PriceBookEntry[]>();
  for (const row of entries) {
    const list = byBook.get(row.price_book_id) ?? [];
    list.push(toEntry(row));
    byBook.set(row.price_book_id, list);
  }

  return books.map((book) => ({
    id: book.id,
    programmeId: book.programme_id,
    name: book.name,
    currency: book.currency,
    entries: byBook.get(book.id) ?? [],
  }));
}

export async function findPriceBookById(
  tx: TenantTx,
  priceBookId: string,
): Promise<PriceBookRow | null> {
  const rows = await tx.query<PriceBookRow>(
    `SELECT id, programme_id, name, currency
       FROM price_book
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid`,
    [tx.session.tenantId, priceBookId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  assertInScope(tx, row.programme_id);
  return row;
}

export async function upsertPriceBookEntry(
  tx: TenantTx,
  priceBookId: string,
  input: UpsertPriceBookEntryInput,
): Promise<PriceBookEntry | null> {
  const book = await findPriceBookById(tx, priceBookId);
  if (book === null) return null;

  const product = await findProductById(tx, input.productId);
  if (product === null || product.programmeId !== book.programme_id) return null;

  if (input.variantId !== undefined) {
    const variantOk = product.variants.some((variant) => variant.id === input.variantId);
    if (!variantOk) return null;
  }

  const entryId = newId();
  const variantId = input.variantId ?? null;
  const params = [
    entryId,
    tx.session.tenantId,
    book.programme_id,
    priceBookId,
    input.productId,
    variantId,
    input.amountMinor,
    input.currency,
  ] as const;

  const sql =
    variantId === null
      ? `INSERT INTO price_book_entry
           (id, tenant_id, programme_id, price_book_id, product_id, variant_id, amount_minor, currency)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::bigint, $8)
         ON CONFLICT (tenant_id, programme_id, price_book_id, product_id) WHERE variant_id IS NULL
         DO UPDATE SET amount_minor = EXCLUDED.amount_minor, currency = EXCLUDED.currency, updated_at = now()
         RETURNING id, price_book_id, product_id, variant_id, amount_minor::text, currency`
      : `INSERT INTO price_book_entry
           (id, tenant_id, programme_id, price_book_id, product_id, variant_id, amount_minor, currency)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::bigint, $8)
         ON CONFLICT (tenant_id, programme_id, price_book_id, product_id, variant_id) WHERE variant_id IS NOT NULL
         DO UPDATE SET amount_minor = EXCLUDED.amount_minor, currency = EXCLUDED.currency, updated_at = now()
         RETURNING id, price_book_id, product_id, variant_id, amount_minor::text, currency`;

  const rows = await tx.query<EntryRow>(sql, [...params]);
  const row = rows[0];
  return row === undefined ? null : toEntry(row);
}
