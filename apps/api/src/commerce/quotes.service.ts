import type { TenantTx } from '@kasuwa/db';
import {
  createQuote,
  findQuoteById,
  listQuotes,
  QuoteInvalidTransitionError,
  QuoteNoPriceError,
  QuoteNotEditableError,
  QuoteProgrammeOutOfScopeError,
  setQuoteStatus,
  updateQuote,
  type Quote,
} from '@kasuwa/domain-core';
import { canProgramme, loadGrants } from '@kasuwa/permissions';
import { HttpStatus } from '@nestjs/common';
import {
  AdminError,
  notFound,
  notPermitted,
  validationFailedFrom,
} from '../admin/common/admin-errors';
import {
  CreateQuoteBody,
  ProgrammeIdParam,
  QuoteIdParam,
  SetQuoteStatusBody,
  UpdateQuoteBody,
} from './commerce.schemas';

export interface QuoteLineWire {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  unitAmountMinor: string;
  discountBps: number;
}

export interface QuoteWire {
  id: string;
  programmeId: string;
  priceBookId: string;
  dealId: string | null;
  contactId: string | null;
  currency: string;
  status: string;
  discountBps: number;
  validUntil: string | null;
  version: number;
  lines: QuoteLineWire[];
  subtotalMinor: string;
  discountMinor: string;
  totalMinor: string;
  createdAt: string;
  updatedAt: string;
}

function toWire(quote: Quote): QuoteWire {
  return {
    id: quote.id,
    programmeId: quote.programmeId,
    priceBookId: quote.priceBookId,
    dealId: quote.dealId,
    contactId: quote.contactId,
    currency: quote.currency,
    status: quote.status,
    discountBps: quote.discountBps,
    validUntil: quote.validUntil ? quote.validUntil.toISOString() : null,
    version: quote.version,
    lines: quote.lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      variantId: line.variantId,
      quantity: line.quantity,
      unitAmountMinor: line.unitAmountMinor,
      discountBps: line.discountBps,
    })),
    subtotalMinor: quote.subtotalMinor,
    discountMinor: quote.discountMinor,
    totalMinor: quote.totalMinor,
    createdAt: quote.createdAt.toISOString(),
    updatedAt: quote.updatedAt.toISOString(),
  };
}

function programmeFromPath(tx: TenantTx, params: unknown): string {
  const { programmeId } = ProgrammeIdParam.parse(params);
  if (!tx.session.programmeIds.includes(programmeId)) throw notFound();
  return programmeId;
}

function mapQuoteError(error: unknown): never {
  if (error instanceof QuoteProgrammeOutOfScopeError) throw notFound();
  if (error instanceof QuoteInvalidTransitionError) {
    throw new AdminError(HttpStatus.BAD_REQUEST, 'invalid_transition', 'That status change is not allowed.');
  }
  if (error instanceof QuoteNotEditableError) {
    throw new AdminError(HttpStatus.CONFLICT, 'not_editable', 'Only a draft quote can be edited.');
  }
  if (error instanceof QuoteNoPriceError) {
    throw new AdminError(
      HttpStatus.BAD_REQUEST,
      'no_price',
      'That product has no price in the quote price book.',
    );
  }
  throw error;
}

export async function listQuotesFor(
  tx: TenantTx,
  params: unknown,
): Promise<{ data: QuoteWire[] }> {
  const programmeId = programmeFromPath(tx, params);
  try {
    const data = await listQuotes(tx, programmeId);
    return { data: data.map(toWire) };
  } catch (error) {
    mapQuoteError(error);
  }
}

export async function createQuoteFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<QuoteWire> {
  const programmeId = programmeFromPath(tx, params);
  if (!canProgramme(await loadGrants(tx), 'quotes.write', programmeId)) throw notPermitted();
  const parsed = CreateQuoteBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  try {
    const quote = await createQuote(tx, programmeId, parsed.data);
    if (quote === null) throw notFound();
    return toWire(quote);
  } catch (error) {
    mapQuoteError(error);
  }
}

export async function getQuoteFor(tx: TenantTx, params: unknown): Promise<QuoteWire> {
  const { quoteId } = QuoteIdParam.parse(params);
  const quote = await findQuoteById(tx, quoteId);
  if (quote === null) throw notFound();
  return toWire(quote);
}

export async function updateQuoteFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<QuoteWire> {
  const { quoteId } = QuoteIdParam.parse(params);
  const current = await findQuoteById(tx, quoteId);
  if (current === null) throw notFound();
  if (!canProgramme(await loadGrants(tx), 'quotes.write', current.programmeId)) {
    throw notPermitted();
  }
  const parsed = UpdateQuoteBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  try {
    const updated = await updateQuote(tx, quoteId, parsed.data);
    if (updated === null) throw notFound();
    return toWire(updated);
  } catch (error) {
    mapQuoteError(error);
  }
}

export async function setQuoteStatusFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<QuoteWire> {
  const { quoteId } = QuoteIdParam.parse(params);
  const current = await findQuoteById(tx, quoteId);
  if (current === null) throw notFound();
  if (!canProgramme(await loadGrants(tx), 'quotes.write', current.programmeId)) {
    throw notPermitted();
  }
  const parsed = SetQuoteStatusBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  try {
    const updated = await setQuoteStatus(tx, quoteId, parsed.data);
    if (updated === null) throw notFound();
    return toWire(updated);
  } catch (error) {
    mapQuoteError(error);
  }
}
