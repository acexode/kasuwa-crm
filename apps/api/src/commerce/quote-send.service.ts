import {
  ChannelError,
  type ChannelProvider,
} from '@kasuwa/channel-adapter';
import type { TenantTx } from '@kasuwa/db';
import {
  findQuoteById,
  isQuoteSendable,
  QuoteNotSendableError,
  recordQuoteSend,
  renderQuotePdf,
  type QuoteSend,
} from '@kasuwa/domain-core';
import { canProgramme, loadGrants } from '@kasuwa/permissions';
import { HttpStatus } from '@nestjs/common';
import {
  AdminError,
  notFound,
  notPermitted,
  validationFailedFrom,
} from '../admin/common/admin-errors';
import { QuoteIdParam, SendQuoteBody } from './commerce.schemas';

export interface QuoteSendWire {
  id: string;
  quoteId: string;
  programmeId: string;
  channel: 'email';
  status: 'sent';
  toMasked: string;
  providerMessageId: string | null;
  quoteVersion: number;
  createdAt: string;
}

function toWire(send: QuoteSend): QuoteSendWire {
  return {
    id: send.id,
    quoteId: send.quoteId,
    programmeId: send.programmeId,
    channel: send.channel,
    status: send.status,
    toMasked: send.toMasked,
    providerMessageId: send.providerMessageId,
    quoteVersion: send.quoteVersion,
    createdAt: send.createdAt.toISOString(),
  };
}

/** The channel provider could not accept the message. Nothing was saved. */
export const quoteSendUnavailable = (): AdminError =>
  new AdminError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'service_unavailable',
    'The quote could not be sent. Try again shortly.',
  );

export const quoteNotSendable = (): AdminError =>
  new AdminError(
    HttpStatus.CONFLICT,
    'not_sendable',
    'Only a draft or sent quote can be emailed.',
  );

/**
 * Render a deterministic PDF for a quote in scope. Readable by any programme
 * member (mirrors getQuote). Never logs quote contents.
 */
export async function renderQuotePdfFor(
  tx: TenantTx,
  params: unknown,
): Promise<Buffer> {
  const { quoteId } = QuoteIdParam.parse(params);
  const quote = await findQuoteById(tx, quoteId);
  if (quote === null) throw notFound();
  return renderQuotePdf(quote);
}

/**
 * Send a quote by email through the channel adapter (T-0167).
 *
 * Fail closed: any ChannelError (including NullChannelProvider in production)
 * becomes 503 and the transaction rolls back — no quote_send row, no status
 * flip. WhatsApp is not an allowed channel (schema refuses it).
 *
 * Never logs `to` or the message body.
 */
export async function sendQuoteFor(
  tx: TenantTx,
  channel: ChannelProvider,
  params: unknown,
  body: unknown,
): Promise<QuoteSendWire> {
  const { quoteId } = QuoteIdParam.parse(params);
  const quote = await findQuoteById(tx, quoteId);
  if (quote === null) throw notFound();
  if (!canProgramme(await loadGrants(tx), 'quotes.write', quote.programmeId)) {
    throw notPermitted();
  }
  const parsed = SendQuoteBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  if (!isQuoteSendable(quote.status)) throw quoteNotSendable();

  let providerMessageId: string;
  try {
    const result = await channel.send({
      scope: { tenantId: tx.session.tenantId, programmeId: quote.programmeId },
      channel: 'email',
      to: parsed.data.to,
      body: quoteEmailBody(quote.id, quote.version, quote.currency, quote.totalMinor),
      purpose: 'transactional',
    });
    providerMessageId = result.messageId;
  } catch (error) {
    if (error instanceof ChannelError) throw quoteSendUnavailable();
    throw error;
  }

  try {
    const send = await recordQuoteSend(tx, {
      quoteId: quote.id,
      channel: 'email',
      to: parsed.data.to,
      providerMessageId,
    });
    if (send === null) throw notFound();
    return toWire(send);
  } catch (error) {
    if (error instanceof QuoteNotSendableError) throw quoteNotSendable();
    throw error;
  }
}

/** Fixed template — ids and money only; no recipient address in the body text. */
function quoteEmailBody(
  quoteId: string,
  version: number,
  currency: string,
  totalMinor: string,
): string {
  return (
    `Your quote ${quoteId} (v${String(version)}) totals ${totalMinor} ${currency}. ` +
    'Open the attached PDF from your Kasuwa workspace to review the full detail.'
  );
}
