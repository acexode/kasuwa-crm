import { newId, type TenantTx } from '@kasuwa/db';
import { maskEmail } from '../portal-user/portal-user-invite';
import { findQuoteById, setQuoteStatus } from './quotes.repository';
import type { Quote } from './quotes.types';

export type QuoteSendChannel = 'email';
export type QuoteSendStatus = 'sent';

export interface QuoteSend {
  id: string;
  programmeId: string;
  quoteId: string;
  channel: QuoteSendChannel;
  status: QuoteSendStatus;
  toMasked: string;
  providerMessageId: string | null;
  quoteVersion: number;
  sentByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RecordQuoteSendInput {
  quoteId: string;
  channel: QuoteSendChannel;
  /** Full address — masked before storage; never logged by callers. */
  to: string;
  providerMessageId: string;
}

export class QuoteNotSendableError extends Error {
  constructor() {
    super('Quote cannot be sent in its current status');
    this.name = 'QuoteNotSendableError';
  }
}

interface QuoteSendRow {
  id: string;
  programme_id: string;
  quote_id: string;
  channel: QuoteSendChannel;
  status: QuoteSendStatus;
  to_masked: string;
  provider_message_id: string | null;
  quote_version: number;
  sent_by_user_id: string;
  created_at: Date;
  updated_at: Date;
}

function toSend(row: QuoteSendRow): QuoteSend {
  return {
    id: row.id,
    programmeId: row.programme_id,
    quoteId: row.quote_id,
    channel: row.channel,
    status: row.status,
    toMasked: row.to_masked,
    providerMessageId: row.provider_message_id,
    quoteVersion: row.quote_version,
    sentByUserId: row.sent_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Quotes that may be emailed: draft (moves to sent) or already sent (resend).
 * Terminal statuses are refused.
 */
export function isQuoteSendable(status: Quote['status']): boolean {
  return status === 'draft' || status === 'sent';
}

/**
 * After a successful channel send: optionally transition draft→sent, then
 * insert the append-only quote_send row. Call only after the provider accepted.
 */
export async function recordQuoteSend(
  tx: TenantTx,
  input: RecordQuoteSendInput,
): Promise<QuoteSend | null> {
  const quote = await findQuoteById(tx, input.quoteId);
  if (quote === null) return null;
  if (!isQuoteSendable(quote.status)) throw new QuoteNotSendableError();

  let version = quote.version;
  if (quote.status === 'draft') {
    const updated = await setQuoteStatus(tx, quote.id, { status: 'sent' });
    if (updated === null) return null;
    version = updated.version;
  }

  const id = newId();
  const toMasked = maskEmail(input.to);
  const rows = await tx.query<QuoteSendRow>(
    `INSERT INTO quote_send (
        id, tenant_id, programme_id, quote_id, channel, status,
        to_masked, provider_message_id, quote_version, sent_by_user_id
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'sent',
        $6, $7, $8, $9::uuid
      )
      RETURNING id, programme_id, quote_id, channel, status, to_masked,
                provider_message_id, quote_version, sent_by_user_id,
                created_at, updated_at`,
    [
      id,
      tx.session.tenantId,
      quote.programmeId,
      quote.id,
      input.channel,
      toMasked,
      input.providerMessageId,
      version,
      tx.session.userId,
    ],
  );
  const row = rows[0];
  return row === undefined ? null : toSend(row);
}

export async function findQuoteSendById(
  tx: TenantTx,
  sendId: string,
): Promise<QuoteSend | null> {
  const rows = await tx.query<QuoteSendRow>(
    `SELECT id, programme_id, quote_id, channel, status, to_masked,
            provider_message_id, quote_version, sent_by_user_id,
            created_at, updated_at
       FROM quote_send
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND programme_id = ANY ($3::uuid[])`,
    [tx.session.tenantId, sendId, tx.session.programmeIds],
  );
  const row = rows[0];
  return row === undefined ? null : toSend(row);
}
