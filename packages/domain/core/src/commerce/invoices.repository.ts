import { newId, type TenantTx } from '@kasuwa/db';
import { findQuoteById } from './quotes.repository';
import {
  computeTaxBucketsForLines,
  listTaxLines,
  replaceTaxLines,
  taxAmountFromBase,
  type ComputedTaxBucket,
} from './tax.repository';
import type { Invoice, InvoiceLine, InvoiceStatus } from './invoices.types';
import { INVOICE_TRANSITIONS } from './invoices.types';

export class InvoiceProgrammeOutOfScopeError extends Error {
  constructor() {
    super('Refusing to access invoice data in a programme outside the session scope');
    this.name = 'InvoiceProgrammeOutOfScopeError';
  }
}

export class InvoiceQuoteNotAcceptedError extends Error {
  constructor() {
    super('Only an accepted quote can be invoiced');
    this.name = 'InvoiceQuoteNotAcceptedError';
  }
}

export class InvoiceAlreadyExistsError extends Error {
  constructor() {
    super('This quote already has an invoice');
    this.name = 'InvoiceAlreadyExistsError';
  }
}

export class InvoiceInvalidTransitionError extends Error {
  constructor() {
    super('Invoice status transition is not allowed');
    this.name = 'InvoiceInvalidTransitionError';
  }
}

function assertInScope(tx: TenantTx, programmeId: string): void {
  if (!tx.session.programmeIds.includes(programmeId)) {
    throw new InvoiceProgrammeOutOfScopeError();
  }
}

interface InvoiceRow {
  id: string;
  programme_id: string;
  quote_id: string | null;
  number: string;
  status: InvoiceStatus;
  currency: Invoice['currency'];
  total_minor: string;
  created_at: Date;
  updated_at: Date;
}

interface LineRow {
  id: string;
  description: string;
  quantity: number;
  unit_amount_minor: string;
}

const INVOICE_COLUMNS = `id, programme_id, quote_id, number, status, currency,
  total_minor::text AS total_minor, created_at, updated_at`;

async function nextInvoiceNumber(tx: TenantTx, programmeId: string): Promise<string> {
  const rows = await tx.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM invoice
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid`,
    [tx.session.tenantId, programmeId],
  );
  const seq = BigInt(rows[0]?.n ?? '0') + 1n;
  return `INV-${seq.toString().padStart(4, '0')}`;
}

async function loadLines(
  tx: TenantTx,
  programmeId: string,
  invoiceIds: readonly string[],
): Promise<Map<string, InvoiceLine[]>> {
  const map = new Map<string, InvoiceLine[]>();
  if (invoiceIds.length === 0) return map;
  const rows = await tx.query<LineRow & { invoice_id: string }>(
    `SELECT id, invoice_id, description, quantity, unit_amount_minor::text AS unit_amount_minor
       FROM invoice_line
      WHERE tenant_id = $1::uuid
        AND programme_id = $2::uuid
        AND invoice_id = ANY($3::uuid[])
      ORDER BY created_at ASC, id ASC`,
    [tx.session.tenantId, programmeId, invoiceIds],
  );
  for (const row of rows) {
    const list = map.get(row.invoice_id) ?? [];
    list.push({
      id: row.id,
      description: row.description,
      quantity: row.quantity,
      unitAmountMinor: row.unit_amount_minor,
    });
    map.set(row.invoice_id, list);
  }
  return map;
}

function sumTaxMinor(taxLines: { amountMinor: string }[]): string {
  let sum = 0n;
  for (const line of taxLines) {
    sum += BigInt(line.amountMinor);
  }
  return sum.toString();
}

async function toInvoice(
  tx: TenantTx,
  row: InvoiceRow,
  lines: InvoiceLine[],
  includeTax: boolean,
): Promise<Invoice> {
  const taxLines = includeTax ? await listTaxLines(tx, 'invoice', row.id) : [];
  const taxMinor = includeTax ? sumTaxMinor(taxLines) : '0';
  return {
    id: row.id,
    programmeId: row.programme_id,
    quoteId: row.quote_id,
    number: row.number,
    status: row.status,
    currency: row.currency,
    totalMinor: row.total_minor,
    taxMinor,
    lines,
    taxLines,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findInvoiceByQuoteId(
  tx: TenantTx,
  quoteId: string,
): Promise<Invoice | null> {
  const rows = await tx.query<InvoiceRow>(
    `SELECT ${INVOICE_COLUMNS}
       FROM invoice
      WHERE tenant_id = $1::uuid
        AND quote_id = $2::uuid
        AND programme_id = ANY($3::uuid[])`,
    [tx.session.tenantId, quoteId, tx.session.programmeIds],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const lines = await loadLines(tx, row.programme_id, [row.id]);
  return toInvoice(tx, row, lines.get(row.id) ?? [], true);
}

export async function findInvoiceById(tx: TenantTx, invoiceId: string): Promise<Invoice | null> {
  const rows = await tx.query<InvoiceRow>(
    `SELECT ${INVOICE_COLUMNS}
       FROM invoice
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND programme_id = ANY($3::uuid[])`,
    [tx.session.tenantId, invoiceId, tx.session.programmeIds],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const lines = await loadLines(tx, row.programme_id, [row.id]);
  return toInvoice(tx, row, lines.get(row.id) ?? [], true);
}

export async function listInvoices(tx: TenantTx, programmeId: string): Promise<Invoice[]> {
  assertInScope(tx, programmeId);
  const rows = await tx.query<InvoiceRow>(
    `SELECT ${INVOICE_COLUMNS}
       FROM invoice
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid
      ORDER BY created_at DESC, id DESC`,
    [tx.session.tenantId, programmeId],
  );
  const lineMap = await loadLines(
    tx,
    programmeId,
    rows.map((r) => r.id),
  );
  return Promise.all(
    rows.map((row) => toInvoice(tx, row, lineMap.get(row.id) ?? [], true)),
  );
}

async function productDescription(
  tx: TenantTx,
  programmeId: string,
  productId: string,
  variantId: string | null,
): Promise<string> {
  const rows = await tx.query<{ name: string; variant_name: string | null }>(
    `SELECT p.name, pv.name AS variant_name
       FROM product p
       LEFT JOIN product_variant pv
         ON pv.tenant_id = p.tenant_id
        AND pv.programme_id = p.programme_id
        AND pv.id = $4::uuid
      WHERE p.tenant_id = $1::uuid
        AND p.programme_id = $2::uuid
        AND p.id = $3::uuid`,
    [tx.session.tenantId, programmeId, productId, variantId],
  );
  const row = rows[0];
  if (row === undefined) return 'Line item';
  if (row.variant_name) return `${row.name} — ${row.variant_name}`;
  return row.name;
}

export async function createInvoiceFromQuote(
  tx: TenantTx,
  quoteId: string,
  options: { includeTax: boolean },
): Promise<Invoice | null> {
  const existing = await findInvoiceByQuoteId(tx, quoteId);
  if (existing !== null) throw new InvoiceAlreadyExistsError();

  const quote = await findQuoteById(tx, quoteId);
  if (quote === null) return null;
  if (quote.status !== 'accepted') throw new InvoiceQuoteNotAcceptedError();

  const id = newId();
  const number = await nextInvoiceNumber(tx, quote.programmeId);
  let totalMinor = BigInt(quote.totalMinor);
  let taxBuckets: ComputedTaxBucket[] | null = null;
  if (options.includeTax) {
    taxBuckets = await computeTaxBucketsForLines(
      tx,
      quote.programmeId,
      quote.lines,
      quote.discountBps,
    );
    await replaceTaxLines(tx, quote.programmeId, 'quote', quote.id, taxBuckets);
    for (const bucket of taxBuckets) {
      totalMinor += bucket.amountMinor;
    }
  }

  await tx.query(
    `INSERT INTO invoice
       (id, tenant_id, programme_id, quote_id, number, status, currency, total_minor)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'draft', $6, $7::bigint)`,
    [
      id,
      tx.session.tenantId,
      quote.programmeId,
      quote.id,
      number,
      quote.currency,
      totalMinor.toString(),
    ],
  );

  for (const line of quote.lines) {
    const description = await productDescription(
      tx,
      quote.programmeId,
      line.productId,
      line.variantId,
    );
    await tx.query(
      `INSERT INTO invoice_line
         (id, tenant_id, programme_id, invoice_id, description, quantity, unit_amount_minor)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::bigint)`,
      [
        newId(),
        tx.session.tenantId,
        quote.programmeId,
        id,
        description,
        line.quantity,
        line.unitAmountMinor,
      ],
    );
  }

  if (taxBuckets !== null) {
    await replaceTaxLines(tx, quote.programmeId, 'invoice', id, taxBuckets);
  }

  return findInvoiceById(tx, id);
}

export async function setInvoiceStatus(
  tx: TenantTx,
  invoiceId: string,
  status: InvoiceStatus,
): Promise<Invoice | null> {
  const current = await findInvoiceById(tx, invoiceId);
  if (current === null) return null;
  const allowed = INVOICE_TRANSITIONS[current.status];
  if (!allowed.includes(status)) throw new InvoiceInvalidTransitionError();
  await tx.query(
    `UPDATE invoice SET status = $4
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid AND id = $3::uuid`,
    [tx.session.tenantId, current.programmeId, invoiceId, status],
  );
  return findInvoiceById(tx, invoiceId);
}

/** Recompute and persist quote tax lines (vat_multitax). */
export async function syncQuoteTaxLines(tx: TenantTx, quoteId: string): Promise<void> {
  const quote = await findQuoteById(tx, quoteId);
  if (quote === null) return;
  const buckets = await computeTaxBucketsForLines(
    tx,
    quote.programmeId,
    quote.lines,
    quote.discountBps,
  );
  await replaceTaxLines(tx, quote.programmeId, 'quote', quote.id, buckets);
}

export function totalWithDefaultVat(netMinor: string, rateBps = 750): string {
  const tax = taxAmountFromBase(BigInt(netMinor), rateBps);
  return (BigInt(netMinor) + tax).toString();
}
