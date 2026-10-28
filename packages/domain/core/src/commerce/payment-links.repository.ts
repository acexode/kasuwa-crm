import { newId, type TenantTx } from '@kasuwa/db';
import { findQuoteById, setQuoteStatus } from './quotes.repository';
import type { Quote } from './quotes.types';

export type PaymentLinkStatus = 'pending' | 'paid' | 'expired' | 'cancelled';
/** Opaque provider id; concrete vendor names live only in `@kasuwa/payments-adapter`. */
export type PaymentLinkProvider = string;

export interface PaymentLink {
  id: string;
  programmeId: string;
  quoteId: string;
  provider: PaymentLinkProvider;
  providerLinkId: string;
  url: string;
  status: PaymentLinkStatus;
  amountMinor: string;
  currency: string;
  reference: string;
  idempotencyKey: string;
  expiresAt: Date | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePaymentLinkRowInput {
  quoteId: string;
  provider: PaymentLinkProvider;
  providerLinkId: string;
  url: string;
  amountMinor: bigint;
  currency: string;
  reference: string;
  idempotencyKey: string;
  expiresAt: Date | null;
}

interface PaymentLinkRow {
  id: string;
  programme_id: string;
  quote_id: string;
  provider: PaymentLinkProvider;
  provider_link_id: string;
  url: string;
  status: PaymentLinkStatus;
  amount_minor: string;
  currency: string;
  reference: string;
  idempotency_key: string;
  expires_at: Date | null;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
}

function mapLink(row: PaymentLinkRow): PaymentLink {
  return {
    id: row.id,
    programmeId: row.programme_id,
    quoteId: row.quote_id,
    provider: row.provider,
    providerLinkId: row.provider_link_id,
    url: row.url,
    status: row.status,
    amountMinor: row.amount_minor,
    currency: row.currency,
    reference: row.reference,
    idempotencyKey: row.idempotency_key,
    expiresAt: row.expires_at,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const LINK_COLS = `
  id, programme_id, quote_id, provider, provider_link_id, url, status,
  amount_minor::text AS amount_minor, currency, reference, idempotency_key,
  expires_at, created_by_user_id, created_at, updated_at
`;

export async function findPaymentLinkById(
  tx: TenantTx,
  paymentLinkId: string,
): Promise<PaymentLink | null> {
  const rows = await tx.query<PaymentLinkRow>(
    `SELECT ${LINK_COLS} FROM payment_link WHERE id = $1 LIMIT 1`,
    [paymentLinkId],
  );
  const row = rows[0];
  return row === undefined ? null : mapLink(row);
}

export async function findPaymentLinkByProviderLinkId(
  tx: TenantTx,
  provider: PaymentLinkProvider,
  providerLinkId: string,
): Promise<PaymentLink | null> {
  const rows = await tx.query<PaymentLinkRow>(
    `SELECT ${LINK_COLS}
       FROM payment_link
      WHERE provider = $1 AND provider_link_id = $2
      LIMIT 1`,
    [provider, providerLinkId],
  );
  const row = rows[0];
  return row === undefined ? null : mapLink(row);
}

export async function findPaymentLinkByIdempotencyKey(
  tx: TenantTx,
  programmeId: string,
  idempotencyKey: string,
): Promise<PaymentLink | null> {
  const rows = await tx.query<PaymentLinkRow>(
    `SELECT ${LINK_COLS}
       FROM payment_link
      WHERE programme_id = $1 AND idempotency_key = $2
      LIMIT 1`,
    [programmeId, idempotencyKey],
  );
  const row = rows[0];
  return row === undefined ? null : mapLink(row);
}

export async function insertPaymentLink(
  tx: TenantTx,
  input: CreatePaymentLinkRowInput,
): Promise<PaymentLink | null> {
  const quote = await findQuoteById(tx, input.quoteId);
  if (quote === null) return null;
  const id = newId();
  const rows = await tx.query<PaymentLinkRow>(
    `INSERT INTO payment_link (
       id, tenant_id, programme_id, quote_id, provider, provider_link_id, url,
       status, amount_minor, currency, reference, idempotency_key, expires_at,
       created_by_user_id
     ) VALUES (
       $1, app.current_tenant_id(), $2, $3, $4, $5, $6,
       'pending', $7, $8, $9, $10, $11, $12
     )
     RETURNING ${LINK_COLS}`,
    [
      id,
      quote.programmeId,
      quote.id,
      input.provider,
      input.providerLinkId,
      input.url,
      input.amountMinor.toString(),
      input.currency,
      input.reference,
      input.idempotencyKey,
      input.expiresAt,
      tx.session.userId,
    ],
  );
  const row = rows[0];
  return row === undefined ? null : mapLink(row);
}

export async function setPaymentLinkStatus(
  tx: TenantTx,
  paymentLinkId: string,
  status: PaymentLinkStatus,
): Promise<PaymentLink | null> {
  const rows = await tx.query<PaymentLinkRow>(
    `UPDATE payment_link
        SET status = $2
      WHERE id = $1
      RETURNING ${LINK_COLS}`,
    [paymentLinkId, status],
  );
  const row = rows[0];
  return row === undefined ? null : mapLink(row);
}

export async function recordPaymentEvent(
  tx: TenantTx,
  input: {
    paymentLinkId: string;
    providerEventId: string;
    eventType: 'payment.paid' | 'payment.expired' | 'payment.failed';
    paymentMethodToken: string | null;
    paymentMethodLastFour: string | null;
    occurredAt: Date;
  },
): Promise<boolean> {
  const link = await findPaymentLinkById(tx, input.paymentLinkId);
  if (link === null) return false;
  try {
    await tx.query(
      `INSERT INTO payment_event (
         id, tenant_id, programme_id, payment_link_id, provider_event_id,
         event_type, payment_method_token, payment_method_last_four, occurred_at
       ) VALUES (
         $1, app.current_tenant_id(), $2, $3, $4,
         $5, $6, $7, $8
       )`,
      [
        newId(),
        link.programmeId,
        link.id,
        input.providerEventId,
        input.eventType,
        input.paymentMethodToken,
        input.paymentMethodLastFour,
        input.occurredAt,
      ],
    );
    return true;
  } catch (error) {
    // Unique provider_event_id → idempotent replay.
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505'
    ) {
      return false;
    }
    throw error;
  }
}

/** Mark quote accepted when a link is paid (P0 reconciliation). */
export async function markQuotePaidFromLink(
  tx: TenantTx,
  quoteId: string,
): Promise<Quote | null> {
  const quote = await findQuoteById(tx, quoteId);
  if (quote === null) return null;
  if (quote.status === 'accepted') return quote;
  if (quote.status !== 'sent' && quote.status !== 'draft') return quote;
  try {
    return await setQuoteStatus(tx, quoteId, { status: 'accepted' });
  } catch {
    return quote;
  }
}
