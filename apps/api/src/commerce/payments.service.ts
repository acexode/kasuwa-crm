import type { IncomingHttpHeaders } from 'node:http';
import { HttpStatus } from '@nestjs/common';
import type { Pool } from 'pg';
import { nodeEnv } from '@kasuwa/config';
import { withAuthTransaction, withTenantTransaction, type TenantTx } from '@kasuwa/db';
import {
  applyPaymentEvent,
  computeQuoteTotals,
  findPaymentLinkById,
  findPaymentLinkByIdempotency,
  findQuoteById,
  insertPaymentLink,
  PaymentNotAppliedError,
  PaymentProgrammeOutOfScopeError,
  type PaymentLinkRow,
} from '@kasuwa/domain-core';
import {
  paymentProviderFor,
  ProviderRejectedError,
  ProviderUnavailableError,
  type PaymentProvider,
} from '@kasuwa/payments-adapter';
import { canProgramme, loadGrants } from '@kasuwa/permissions';
import {
  AdminError,
  notAuthenticated,
  notFound,
  notPermitted,
  validationFailed,
  validationFailedFrom,
} from '../admin/common/admin-errors';
import {
  CreatePaymentLinkBody,
  PaymentLinkIdParam,
  ProgrammeQuoteParams,
  WebhookPathParams,
} from './commerce.schemas';

/** Unknown slug and a bad signature share this answer, so neither confirms the other. */
const NIL_TENANT = '00000000-0000-4000-8000-000000000000';

export interface PaymentLinkWire {
  id: string;
  programmeId: string;
  quoteId: string;
  providerLinkId: string;
  status: 'pending' | 'paid' | 'expired';
  amountMinor: string;
  currency: 'NGN' | 'GHS' | 'KES' | 'ZAR';
  url: string;
  expiresAt: string | null;
  paidAt: string | null;
}

export interface WebhookWire {
  status: 'pending' | 'paid' | 'expired';
  replay: boolean;
  dealMoved: boolean;
}

function unavailable(): AdminError {
  return new AdminError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'service_unavailable',
    'The service is busy right now. Please try again in a moment.',
  );
}

function paymentEnvironment(): 'development' | 'test' | 'production' {
  const env = nodeEnv();
  if (env === 'production' || env === 'test') return env;
  return 'development';
}

function toWire(link: PaymentLinkRow): PaymentLinkWire {
  return {
    id: link.id,
    programmeId: link.programmeId,
    quoteId: link.quoteId,
    providerLinkId: link.providerLinkId,
    status: link.status,
    amountMinor: link.amountMinor,
    currency: link.currency,
    url: link.url,
    expiresAt: link.expiresAt === null ? null : link.expiresAt.toISOString(),
    paidAt: link.paidAt === null ? null : link.paidAt.toISOString(),
  };
}

function programmeFromPath(tx: TenantTx, params: unknown): string {
  const { programmeId } = ProgrammeQuoteParams.parse(params);
  if (!tx.session.programmeIds.includes(programmeId)) throw notFound();
  return programmeId;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export async function createPaymentLinkFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<PaymentLinkWire> {
  const parsedParams = ProgrammeQuoteParams.safeParse(params);
  if (!parsedParams.success) throw validationFailedFrom(parsedParams.error);
  const programmeId = programmeFromPath(tx, parsedParams.data);
  if (!canProgramme(await loadGrants(tx), 'quotes.write', programmeId)) throw notPermitted();
  const parsed = CreatePaymentLinkBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);

  const existing = await findPaymentLinkByIdempotency(tx, programmeId, parsed.data.idempotencyKey);
  if (existing !== null) return toWire(existing);

  const quote = await findQuoteById(tx, parsedParams.data.quoteId);
  if (quote === null || quote.programmeId !== programmeId) throw notFound();
  if (quote.status !== 'sent' && quote.status !== 'accepted') {
    throw validationFailed([{ path: 'status', code: 'invalid' }]);
  }
  const totalMinor = computeQuoteTotals(quote.lines, quote.discountBps).totalMinor;
  if (BigInt(totalMinor) <= 0n) {
    throw validationFailed([{ path: 'amountMinor', code: 'invalid' }]);
  }

  const provider = paymentProviderFor(paymentEnvironment(), tx.session.tenantId);
  let created: Awaited<ReturnType<PaymentProvider['createPaymentLink']>>;
  try {
    created = await provider.createPaymentLink({
      scope: { tenantId: tx.session.tenantId, programmeId },
      amountMinor: BigInt(totalMinor),
      currency: quote.currency,
      reference: quote.id,
      idempotencyKey: parsed.data.idempotencyKey,
      ...(quote.validUntil !== null ? { expiresAt: quote.validUntil } : {}),
    });
  } catch (error) {
    if (error instanceof ProviderUnavailableError) throw unavailable();
    if (error instanceof ProviderRejectedError) {
      throw validationFailed([{ path: 'provider', code: 'rejected' }]);
    }
    throw unavailable();
  }
  if (created.status !== 'pending' || !/^[a-z]{1,32}$/.test(provider.id)) throw unavailable();

  try {
    const link = await insertPaymentLink(tx, {
      programmeId,
      quoteId: quote.id,
      provider: provider.id,
      providerLinkId: created.providerLinkId,
      amountMinor: totalMinor,
      currency: quote.currency,
      url: created.url,
      idempotencyKey: parsed.data.idempotencyKey,
      expiresAt: created.expiresAt ?? quote.validUntil,
    });
    return toWire(link);
  } catch (error) {
    if (error instanceof PaymentProgrammeOutOfScopeError) throw notFound();
    if (isUniqueViolation(error)) {
      const raced = await findPaymentLinkByIdempotency(tx, programmeId, parsed.data.idempotencyKey);
      if (raced !== null) return toWire(raced);
    }
    throw error;
  }
}

export async function getPaymentLinkFor(tx: TenantTx, params: unknown): Promise<PaymentLinkWire> {
  const { linkId } = PaymentLinkIdParam.parse(params);
  const link = await findPaymentLinkById(tx, linkId);
  if (link === null) throw notFound();
  return toWire(link);
}

function headerRecord(headers: IncomingHttpHeaders): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string' || Array.isArray(value)) out[key.toLowerCase()] = value;
  }
  return out;
}

/**
 * Verify a webhook and apply it. Unknown slug, bad signature, unreadable body
 * and an unknown link all answer 401 with one body. Production fails closed
 * (503) because no provider is configured.
 */
export async function receivePaymentWebhook(
  pool: Pool,
  params: unknown,
  rawBody: Buffer | undefined,
  headers: IncomingHttpHeaders,
): Promise<WebhookWire> {
  const parsedPath = WebhookPathParams.safeParse(params);
  if (!parsedPath.success || rawBody === undefined) throw notAuthenticated();

  const tenantId = await withAuthTransaction(pool, { tenantSlug: parsedPath.data.tenantSlug }, async (tx) => tx.tenantId);
  const provider = paymentProviderFor(paymentEnvironment(), tenantId ?? NIL_TENANT);
  let signatureOk = false;
  try {
    signatureOk = await provider.verifyWebhookSignature({
      rawBody: rawBody.toString('utf8'),
      headers: headerRecord(headers),
    });
  } catch (error) {
    if (error instanceof ProviderUnavailableError) throw unavailable();
    throw unavailable();
  }
  if (tenantId === null || !signatureOk) throw notAuthenticated();

  let event: Awaited<ReturnType<PaymentProvider['parseWebhookEvent']>>;
  try {
    event = await provider.parseWebhookEvent({
      rawBody: rawBody.toString('utf8'),
      headers: headerRecord(headers),
    });
  } catch {
    throw notAuthenticated();
  }

  const link = await withAuthTransaction(pool, { tenantSlug: parsedPath.data.tenantSlug }, async (tx) => {
    if (tx.tenantId === null || tx.tenantId !== tenantId) return null;
    const rows = await tx.query<{
      id: string;
      programme_id: string;
      quote_id: string;
      created_by_user_id: string;
    }>(
      `SELECT id, programme_id, quote_id, created_by_user_id
         FROM payment_link
        WHERE tenant_id = $1::uuid
          AND provider = $2
          AND provider_link_id = $3`,
      [tx.tenantId, parsedPath.data.provider, event.providerLinkId],
    );
    return rows[0] ?? null;
  });
  if (link === null) throw notAuthenticated();

  try {
    return await withTenantTransaction(pool, { tenantId, userId: link.created_by_user_id }, async (tx) => {
      try {
        return await applyPaymentEvent(tx, {
          programmeId: link.programme_id,
          linkId: link.id,
          quoteId: link.quote_id,
          provider: parsedPath.data.provider,
          eventId: event.eventId,
          eventType: event.type,
        });
      } catch (error) {
        if (error instanceof PaymentNotAppliedError || error instanceof PaymentProgrammeOutOfScopeError) {
          throw unavailable();
        }
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof AdminError) throw error;
    throw unavailable();
  }
}
