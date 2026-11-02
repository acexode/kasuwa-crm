import { describe, expect, it } from 'vitest';
import type { CreatePaymentLinkRequest } from './contracts';
import {
  defaultPaymentProvider,
  fakeWebhookSecretForTenant,
  NullPaymentProvider,
  paymentProviderFor,
} from './default-provider';
import { ProviderUnavailableError } from './errors';
import { FakePaymentProvider } from './fake';

const REQUEST: CreatePaymentLinkRequest = {
  scope: {
    tenantId: '11111111-0000-4000-8000-000000000001',
    programmeId: '11111111-0000-4000-8000-0000000c0001',
  },
  amountMinor: 1_000n,
  currency: 'NGN',
  reference: 'quote-null-probe',
  idempotencyKey: 'idem-null-probe',
};

describe('NullPaymentProvider', () => {
  it('refuses every create as unavailable', async () => {
    await expect(new NullPaymentProvider().createPaymentLink(REQUEST)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it('refuses signature verification (fail closed)', async () => {
    await expect(
      new NullPaymentProvider().verifyWebhookSignature({ rawBody: '{}', headers: {} }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('refuses webhook parse (fail closed)', async () => {
    await expect(
      new NullPaymentProvider().parseWebhookEvent({ rawBody: '{}', headers: {} }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('keeps nothing it was given', async () => {
    const provider = new NullPaymentProvider();
    await provider.createPaymentLink(REQUEST).catch(() => undefined);
    expect(JSON.stringify(provider)).not.toContain('null-probe');
  });
});

describe('defaultPaymentProvider', () => {
  it('is the null provider in production', () => {
    expect(defaultPaymentProvider('production')).toBeInstanceOf(NullPaymentProvider);
  });

  it('is the in-memory fake only when the environment is exactly test', () => {
    expect(defaultPaymentProvider('development')).toBeInstanceOf(NullPaymentProvider);
    expect(defaultPaymentProvider('test')).toBeInstanceOf(FakePaymentProvider);
  });

  it('returns a fresh provider each time', () => {
    expect(defaultPaymentProvider('test')).not.toBe(defaultPaymentProvider('test'));
  });
});

describe('paymentProviderFor', () => {
  const tenantA = '11111111-0000-4000-8000-000000000001';
  const tenantB = '22222222-0000-4000-8000-000000000002';

  it('fails closed for every environment other than test', () => {
    expect(paymentProviderFor('production', tenantA)).toBeInstanceOf(NullPaymentProvider);
    expect(paymentProviderFor('development', tenantA)).toBeInstanceOf(NullPaymentProvider);
    expect(paymentProviderFor('staging', tenantA)).toBeInstanceOf(NullPaymentProvider);
  });

  it('rejects a signature made for another tenant', async () => {
    const signedByB = new FakePaymentProvider({
      webhookSecret: fakeWebhookSecretForTenant(tenantB),
    }).signWebhook({
      eventId: 'evt-cross',
      occurredAt: new Date('2026-11-02T00:00:00.000Z'),
      type: 'payment.paid',
      providerLinkId: 'plink_1',
      reference: 'quote-1',
    });
    await expect(
      paymentProviderFor('test', tenantA).verifyWebhookSignature({
        rawBody: signedByB.rawBody,
        headers: signedByB.headers,
      }),
    ).resolves.toBe(false);
  });
});
