import { newId, type TenantTx } from '@kasuwa/db';
import type { CommerceCurrency } from './catalogue.types';
import {
  computeQuoteTotals,
  QUOTE_TRANSITIONS,
  type CreateQuoteInput,
  type Quote,
  type QuoteLine,
  type QuoteLineInput,
  type QuoteStatus,
  type SetQuoteStatusInput,
  type UpdateQuoteInput,
} from './quotes.types';

export class QuoteProgrammeOutOfScopeError extends Error {
  constructor() {
    super('Refusing to access quote data in a programme outside the session scope');
    this.name = 'QuoteProgrammeOutOfScopeError';
  }
}

export class QuoteInvalidTransitionError extends Error {
  constructor() {
    super('Quote status transition is not allowed');
    this.name = 'QuoteInvalidTransitionError';
  }
}

export class QuoteNotEditableError extends Error {
  constructor() {
    super('Quote can only be edited while draft');
    this.name = 'QuoteNotEditableError';
  }
}

/** Product/variant has no entry in the quote's price book (D-L211). */
export class QuoteNoPriceError extends Error {
  constructor() {
    super('No price book entry for that product');
    this.name = 'QuoteNoPriceError';
  }
}

function assertInScope(tx: TenantTx, programmeId: string): void {
  if (!tx.session.programmeIds.includes(programmeId)) {
    throw new QuoteProgrammeOutOfScopeError();
  }
}

interface QuoteRow {
  id: string;
  programme_id: string;
  price_book_id: string;
  deal_id: string | null;
  contact_id: string | null;
  currency: CommerceCurrency;
  status: QuoteStatus;
  discount_bps: number;
  valid_until: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface LineRow {
  id: string;
  product_id: string;
  variant_id: string | null;
  quantity: number;
  unit_amount_minor: string;
  discount_bps: number;
  sort_order: number;
}

function toLine(row: LineRow): QuoteLine {
  return {
    id: row.id,
    productId: row.product_id,
    variantId: row.variant_id,
    quantity: row.quantity,
    unitAmountMinor: row.unit_amount_minor,
    discountBps: row.discount_bps,
    sortOrder: row.sort_order,
  };
}

async function loadLines(
  tx: TenantTx,
  programmeId: string,
  quoteIds: readonly string[],
): Promise<Map<string, QuoteLine[]>> {
  const map = new Map<string, QuoteLine[]>();
  if (quoteIds.length === 0) return map;
  const rows = await tx.query<LineRow & { quote_id: string }>(
    `SELECT id, quote_id, product_id, variant_id, quantity,
            unit_amount_minor::text AS unit_amount_minor, discount_bps, sort_order
       FROM quote_line
      WHERE tenant_id = $1::uuid
        AND programme_id = $2::uuid
        AND quote_id = ANY($3::uuid[])
      ORDER BY sort_order, created_at, id`,
    [tx.session.tenantId, programmeId, quoteIds],
  );
  for (const row of rows) {
    const list = map.get(row.quote_id) ?? [];
    list.push(toLine(row));
    map.set(row.quote_id, list);
  }
  return map;
}

function toQuote(row: QuoteRow, lines: QuoteLine[]): Quote {
  const totals = computeQuoteTotals(lines, row.discount_bps);
  return {
    id: row.id,
    programmeId: row.programme_id,
    priceBookId: row.price_book_id,
    dealId: row.deal_id,
    contactId: row.contact_id,
    currency: row.currency,
    status: row.status,
    discountBps: row.discount_bps,
    validUntil: row.valid_until,
    version: row.version,
    lines,
    ...totals,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const QUOTE_COLUMNS = `id, programme_id, price_book_id, deal_id, contact_id, currency, status,
  discount_bps, valid_until, version, created_at, updated_at`;

async function assertProductInProgramme(
  tx: TenantTx,
  programmeId: string,
  productId: string,
  variantId: string | null,
): Promise<boolean> {
  const products = await tx.query<{ id: string }>(
    `SELECT id FROM product
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid AND id = $3::uuid`,
    [tx.session.tenantId, programmeId, productId],
  );
  if (products.length === 0) return false;
  if (variantId === null) return true;
  const variants = await tx.query<{ id: string }>(
    `SELECT id FROM product_variant
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid
        AND product_id = $3::uuid AND id = $4::uuid`,
    [tx.session.tenantId, programmeId, productId, variantId],
  );
  return variants.length > 0;
}

async function assertOptionalRef(
  tx: TenantTx,
  programmeId: string,
  table: 'deal' | 'contact',
  id: string | null | undefined,
): Promise<boolean> {
  if (id === null || id === undefined) return true;
  const rows = await tx.query<{ id: string }>(
    `SELECT id FROM ${table}
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid AND id = $3::uuid`,
    [tx.session.tenantId, programmeId, id],
  );
  return rows.length > 0;
}

/** null → missing / out-of-scope book (404). */
async function loadPriceBook(
  tx: TenantTx,
  programmeId: string,
  priceBookId: string,
): Promise<{ id: string; currency: CommerceCurrency } | null> {
  const rows = await tx.query<{ id: string; currency: CommerceCurrency }>(
    `SELECT id, currency FROM price_book
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid AND id = $3::uuid`,
    [tx.session.tenantId, programmeId, priceBookId],
  );
  return rows[0] ?? null;
}

/**
 * Variant entry first, else product entry (D-L211). Throws QuoteNoPriceError
 * when neither exists.
 */
async function resolveUnitAmount(
  tx: TenantTx,
  programmeId: string,
  priceBookId: string,
  productId: string,
  variantId: string | null,
): Promise<string> {
  if (variantId !== null) {
    const variantRows = await tx.query<{ amount_minor: string }>(
      `SELECT amount_minor::text AS amount_minor FROM price_book_entry
        WHERE tenant_id = $1::uuid AND programme_id = $2::uuid
          AND price_book_id = $3::uuid AND product_id = $4::uuid
          AND variant_id = $5::uuid`,
      [tx.session.tenantId, programmeId, priceBookId, productId, variantId],
    );
    const variant = variantRows[0];
    if (variant) return variant.amount_minor;
  }
  const productRows = await tx.query<{ amount_minor: string }>(
    `SELECT amount_minor::text AS amount_minor FROM price_book_entry
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid
        AND price_book_id = $3::uuid AND product_id = $4::uuid
        AND variant_id IS NULL`,
    [tx.session.tenantId, programmeId, priceBookId, productId],
  );
  const product = productRows[0];
  if (product) return product.amount_minor;
  throw new QuoteNoPriceError();
}

async function replaceLines(
  tx: TenantTx,
  programmeId: string,
  quoteId: string,
  priceBookId: string,
  lines: readonly QuoteLineInput[],
): Promise<boolean> {
  for (const line of lines) {
    const ok = await assertProductInProgramme(
      tx,
      programmeId,
      line.productId,
      line.variantId ?? null,
    );
    if (!ok) return false;
  }
  await tx.query(
    `DELETE FROM quote_line
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid AND quote_id = $3::uuid`,
    [tx.session.tenantId, programmeId, quoteId],
  );
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const unitAmountMinor = await resolveUnitAmount(
      tx,
      programmeId,
      priceBookId,
      line.productId,
      line.variantId ?? null,
    );
    await tx.query(
      `INSERT INTO quote_line
         (id, tenant_id, programme_id, quote_id, product_id, variant_id,
          quantity, unit_amount_minor, discount_bps, sort_order)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
               $7, $8::bigint, $9, $10)`,
      [
        newId(),
        tx.session.tenantId,
        programmeId,
        quoteId,
        line.productId,
        line.variantId ?? null,
        line.quantity,
        unitAmountMinor,
        line.discountBps ?? 0,
        i,
      ],
    );
  }
  return true;
}

/** null → caller answers 404 (missing / out-of-scope reference). */
export async function createQuote(
  tx: TenantTx,
  programmeId: string,
  input: CreateQuoteInput,
): Promise<Quote | null> {
  assertInScope(tx, programmeId);
  const book = await loadPriceBook(tx, programmeId, input.priceBookId);
  if (book === null) return null;

  const dealId = input.dealId === undefined ? null : input.dealId;
  const contactId = input.contactId === undefined ? null : input.contactId;
  if (!(await assertOptionalRef(tx, programmeId, 'deal', dealId))) return null;
  if (!(await assertOptionalRef(tx, programmeId, 'contact', contactId))) return null;

  for (const line of input.lines) {
    const ok = await assertProductInProgramme(
      tx,
      programmeId,
      line.productId,
      line.variantId ?? null,
    );
    if (!ok) return null;
  }

  const id = newId();
  const validUntil = input.validUntil ? new Date(input.validUntil) : null;
  await tx.query(
    `INSERT INTO quote
       (id, tenant_id, programme_id, price_book_id, deal_id, contact_id, currency, status,
        discount_bps, valid_until, version)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, 'draft',
             $8, $9, 1)`,
    [
      id,
      tx.session.tenantId,
      programmeId,
      book.id,
      dealId,
      contactId,
      book.currency,
      input.discountBps ?? 0,
      validUntil,
    ],
  );

  const replaced = await replaceLines(tx, programmeId, id, book.id, input.lines);
  if (!replaced) return null;
  return findQuoteById(tx, id);
}

export async function listQuotes(tx: TenantTx, programmeId: string): Promise<Quote[]> {
  assertInScope(tx, programmeId);
  const rows = await tx.query<QuoteRow>(
    `SELECT ${QUOTE_COLUMNS}
       FROM quote
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid
      ORDER BY created_at DESC, id DESC`,
    [tx.session.tenantId, programmeId],
  );
  const lines = await loadLines(
    tx,
    programmeId,
    rows.map((r) => r.id),
  );
  return rows.map((row) => toQuote(row, lines.get(row.id) ?? []));
}

export async function findQuoteById(tx: TenantTx, quoteId: string): Promise<Quote | null> {
  const rows = await tx.query<QuoteRow>(
    `SELECT ${QUOTE_COLUMNS}
       FROM quote
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND programme_id = ANY($3::uuid[])`,
    [tx.session.tenantId, quoteId, tx.session.programmeIds],
  );
  const row = rows[0];
  if (!row) return null;
  const lines = await loadLines(tx, row.programme_id, [row.id]);
  return toQuote(row, lines.get(row.id) ?? []);
}

export async function updateQuote(
  tx: TenantTx,
  quoteId: string,
  input: UpdateQuoteInput,
): Promise<Quote | null> {
  const current = await findQuoteById(tx, quoteId);
  if (current === null) return null;
  if (current.status !== 'draft') throw new QuoteNotEditableError();

  const dealId = input.dealId === undefined ? current.dealId : input.dealId;
  const contactId = input.contactId === undefined ? current.contactId : input.contactId;
  if (!(await assertOptionalRef(tx, current.programmeId, 'deal', dealId))) return null;
  if (!(await assertOptionalRef(tx, current.programmeId, 'contact', contactId))) return null;

  if (input.lines !== undefined) {
    const ok = await replaceLines(
      tx,
      current.programmeId,
      quoteId,
      current.priceBookId,
      input.lines,
    );
    if (!ok) return null;
  }

  const discountBps = input.discountBps ?? current.discountBps;
  const validUntil =
    input.validUntil === undefined
      ? current.validUntil
      : input.validUntil === null
        ? null
        : new Date(input.validUntil);

  await tx.query(
    `UPDATE quote
        SET deal_id = $3::uuid,
            contact_id = $4::uuid,
            discount_bps = $5,
            valid_until = $6,
            version = version + 1,
            updated_at = now()
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid AND id = $7::uuid`,
    [
      tx.session.tenantId,
      current.programmeId,
      dealId,
      contactId,
      discountBps,
      validUntil,
      quoteId,
    ],
  );

  return findQuoteById(tx, quoteId);
}

export async function setQuoteStatus(
  tx: TenantTx,
  quoteId: string,
  input: SetQuoteStatusInput,
): Promise<Quote | null> {
  const current = await findQuoteById(tx, quoteId);
  if (current === null) return null;
  const allowed = QUOTE_TRANSITIONS[current.status];
  if (!allowed.includes(input.status)) throw new QuoteInvalidTransitionError();
  await tx.query(
    `UPDATE quote
        SET status = $3, updated_at = now()
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid AND id = $4::uuid`,
    [tx.session.tenantId, current.programmeId, input.status, quoteId],
  );
  return findQuoteById(tx, quoteId);
}
