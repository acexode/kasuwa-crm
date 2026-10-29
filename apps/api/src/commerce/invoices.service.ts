import type { TenantTx } from '@kasuwa/db';
import {
  createInvoiceFromQuote,
  findInvoiceById,
  findQuoteById,
  InvoiceAlreadyExistsError,
  InvoiceInvalidTransitionError,
  InvoiceProgrammeOutOfScopeError,
  InvoiceQuoteNotAcceptedError,
  listInvoices,
  setInvoiceStatus,
  syncQuoteTaxLines,
  type Invoice,
} from '@kasuwa/domain-core';
import { canProgramme, loadGrants } from '@kasuwa/permissions';
import { HttpStatus } from '@nestjs/common';
import {
  AdminError,
  notFound,
  notPermitted,
  validationFailedFrom,
} from '../admin/common/admin-errors';
import { InvoiceIdParam, ProgrammeIdParam, QuoteIdParam, SetInvoiceStatusBody } from './commerce.schemas';

export interface TaxLineWire {
  id: string;
  code: string;
  rateBps: number;
  amountMinor: string;
}

export interface InvoiceLineWire {
  id: string;
  description: string;
  quantity: number;
  unitAmountMinor: string;
}

export interface InvoiceWire {
  id: string;
  programmeId: string;
  quoteId: string | null;
  number: string;
  status: string;
  currency: string;
  totalMinor: string;
  taxMinor: string;
  lines: InvoiceLineWire[];
  taxLines: TaxLineWire[];
  createdAt: string;
  updatedAt: string;
}

function toWire(invoice: Invoice): InvoiceWire {
  return {
    id: invoice.id,
    programmeId: invoice.programmeId,
    quoteId: invoice.quoteId,
    number: invoice.number,
    status: invoice.status,
    currency: invoice.currency,
    totalMinor: invoice.totalMinor,
    taxMinor: invoice.taxMinor,
    lines: invoice.lines.map((line) => ({
      id: line.id,
      description: line.description,
      quantity: line.quantity,
      unitAmountMinor: line.unitAmountMinor,
    })),
    taxLines: invoice.taxLines.map((line) => ({
      id: line.id,
      code: line.code,
      rateBps: line.rateBps,
      amountMinor: line.amountMinor,
    })),
    createdAt: invoice.createdAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString(),
  };
}

function mapDomainError(error: unknown): never {
  if (error instanceof InvoiceProgrammeOutOfScopeError) throw notFound();
  if (error instanceof InvoiceQuoteNotAcceptedError) {
    throw new AdminError(HttpStatus.BAD_REQUEST, 'quote_not_accepted', 'Quote is not accepted');
  }
  if (error instanceof InvoiceAlreadyExistsError) {
    throw new AdminError(HttpStatus.CONFLICT, 'already_invoiced', 'Quote already has an invoice');
  }
  if (error instanceof InvoiceInvalidTransitionError) {
    throw new AdminError(HttpStatus.BAD_REQUEST, 'invalid_transition', 'Invalid status transition');
  }
  throw error;
}

export async function listInvoicesFor(tx: TenantTx, params: unknown): Promise<{ data: InvoiceWire[] }> {
  const { programmeId } = ProgrammeIdParam.parse(params);
  if (!tx.session.programmeIds.includes(programmeId)) throw notFound();
  const invoices = await listInvoices(tx, programmeId);
  return { data: invoices.map(toWire) };
}

export async function getInvoiceFor(tx: TenantTx, params: unknown): Promise<InvoiceWire> {
  const { invoiceId } = InvoiceIdParam.parse(params);
  const invoice = await findInvoiceById(tx, invoiceId);
  if (invoice === null) throw notFound();
  return toWire(invoice);
}

export async function createInvoiceFromQuoteFor(
  tx: TenantTx,
  params: unknown,
): Promise<InvoiceWire> {
  const { quoteId } = QuoteIdParam.parse(params);
  const includeTax = true;
  const quote = await findQuoteById(tx, quoteId);
  if (quote === null) throw notFound();
  if (!canProgramme(await loadGrants(tx), 'invoices.write', quote.programmeId)) {
    throw notPermitted();
  }
  try {
    const quoteScoped = await createInvoiceFromQuote(tx, quoteId, { includeTax });
    if (quoteScoped === null) throw notFound();
    return toWire(quoteScoped);
  } catch (error) {
    mapDomainError(error);
  }
}

export async function setInvoiceStatusFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<InvoiceWire> {
  const { invoiceId } = InvoiceIdParam.parse(params);
  const parsed = SetInvoiceStatusBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  const current = await findInvoiceById(tx, invoiceId);
  if (current === null) throw notFound();
  if (!canProgramme(await loadGrants(tx), 'invoices.write', current.programmeId)) {
    throw notPermitted();
  }
  try {
    const updated = await setInvoiceStatus(tx, invoiceId, parsed.data.status);
    if (updated === null) throw notFound();
    return toWire(updated);
  } catch (error) {
    mapDomainError(error);
  }
}

export async function syncQuoteTaxFor(tx: TenantTx, quoteId: string): Promise<void> {
  await syncQuoteTaxLines(tx, quoteId);
}
