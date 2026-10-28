import type { TenantTx } from '@kasuwa/db';
import {
  findPaymentLinkById,
  findPaymentLinkByIdempotencyKey,
  findPaymentLinkByProviderLinkId,
  findQuoteById,
  insertPaymentLink,
  markQuotePaidFromLink,
  recordPaymentEvent,
  setPaymentLinkStatus,
  type PaymentLink,
} from '@kasuwa/domain-core';
import {
  defaultPaymentProvider,
  type PaymentProvider,
  type PaymentProviderId,
} from '@kasuwa/payments-adapter';
import { nodeEnv } from '@kasuwa/config';
import { canProgramme, loadGrants } from '@kasuwa/permissions';
import { z } from 'zod';
import {
  notFound,
  notPermitted,
  validationFailedFrom,
} from '../admin/common/admin-errors';
import { QuoteIdParam } from './commerce.schemas';

const CreatePaymentLinkBody = z
  .object({
    provider: z.enum(['paystack', 'flutterwave']).default('paystack'),
    idempotencyKey: z.string().min(1).max(128),
    successUrl: z.url().optional(),
    cancelUrl: z.url().optional(),
  })
  .strict();

export interface PaymentLinkWire {
  id: string;
  programmeId: string;
  quoteId: string;
  provider: string;
  url: string;
  status: string;
  amountMinor: string;
  currency: string;
  reference: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toWire(link: PaymentLink): PaymentLinkWire {
  return {
    id: link.id,
    programmeId: link.programmeId,
    quoteId: link.quoteId,
    provider: link.provider,
    url: link.url,
    status: link.status,
    amountMinor: link.amountMinor,
    currency: link.currency,
    reference: link.reference,
    expiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
  };
}

/** Test/dev provider; production wiring uses Null via defaultPaymentProvider. */
let paymentProviderOverride: PaymentProvider | undefined;

export function setPaymentProviderForTests(provider: PaymentProvider | undefined): void {
  paymentProviderOverride = provider;
}

function activeProvider(): PaymentProvider {
  return paymentProviderOverride ?? defaultPaymentProvider(nodeEnv() as 'development' | 'test' | 'production');
}

export async function createPaymentLinkFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<PaymentLinkWire> {
  const { quoteId } = QuoteIdParam.parse(params);
  const quote = await findQuoteById(tx, quoteId);
  if (quote === null) throw notFound();
  if (!canProgramme(await loadGrants(tx), 'quotes.write', quote.programmeId)) {
    throw notPermitted();
  }
  const parsed = CreatePaymentLinkBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);

  const existing = await findPaymentLinkByIdempotencyKey(
    tx,
    quote.programmeId,
    parsed.data.idempotencyKey,
  );
  if (existing !== null) return toWire(existing);

  const provider = activeProvider();
  const providerId: PaymentProviderId | 'fake' =
    provider.id === 'null' ? 'fake' : provider.id === 'fake' ? 'fake' : parsed.data.provider;

  const result = await provider.createPaymentLink({
    scope: { tenantId: tx.session.tenantId, programmeId: quote.programmeId },
    amountMinor: BigInt(quote.totalMinor),
    currency: quote.currency as 'NGN' | 'GHS' | 'KES' | 'ZAR',
    reference: quote.id,
    idempotencyKey: parsed.data.idempotencyKey,
    description: `Quote ${quote.id}`,
    successUrl: parsed.data.successUrl,
    cancelUrl: parsed.data.cancelUrl,
  });

  const link = await insertPaymentLink(tx, {
    quoteId: quote.id,
    provider: providerId === 'fake' ? 'fake' : parsed.data.provider,
    providerLinkId: result.providerLinkId,
    url: result.url,
    amountMinor: BigInt(quote.totalMinor),
    currency: quote.currency,
    reference: quote.id,
    idempotencyKey: parsed.data.idempotencyKey,
    expiresAt: result.expiresAt ?? null,
  });
  if (link === null) throw notFound();
  return toWire(link);
}

export async function getPaymentLinkFor(
  tx: TenantTx,
  paymentLinkId: string,
): Promise<PaymentLinkWire> {
  const link = await findPaymentLinkById(tx, paymentLinkId);
  if (link === null) throw notFound();
  return toWire(link);
}

export async function applyPaymentWebhookEvent(
  tx: TenantTx,
  input: {
    provider: 'paystack' | 'flutterwave' | 'fake';
    providerLinkId: string;
    providerEventId: string;
    eventType: 'payment.paid' | 'payment.expired' | 'payment.failed';
    paymentMethodToken: string | null;
    paymentMethodLastFour: string | null;
    occurredAt: Date;
  },
): Promise<'applied' | 'duplicate' | 'missing'> {
  const link = await findPaymentLinkByProviderLinkId(tx, input.provider, input.providerLinkId);
  if (link === null) return 'missing';

  const inserted = await recordPaymentEvent(tx, {
    paymentLinkId: link.id,
    providerEventId: input.providerEventId,
    eventType: input.eventType,
    paymentMethodToken: input.paymentMethodToken,
    paymentMethodLastFour: input.paymentMethodLastFour,
    occurredAt: input.occurredAt,
  });
  if (!inserted) return 'duplicate';

  if (input.eventType === 'payment.paid') {
    await setPaymentLinkStatus(tx, link.id, 'paid');
    await markQuotePaidFromLink(tx, link.quoteId);
  } else if (input.eventType === 'payment.expired') {
    if (link.status === 'pending') await setPaymentLinkStatus(tx, link.id, 'expired');
  }
  return 'applied';
}
