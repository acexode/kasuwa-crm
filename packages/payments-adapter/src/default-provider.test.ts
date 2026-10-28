import { describe, expect, it } from 'vitest';
import type { CreatePaymentLinkRequest } from './contracts';
import { defaultPaymentProvider, NullPaymentProvider } from './default-provider';
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

  it('is the in-memory fake in development and test', () => {
    expect(defaultPaymentProvider('development')).toBeInstanceOf(FakePaymentProvider);
    expect(defaultPaymentProvider('test')).toBeInstanceOf(FakePaymentProvider);
  });

  it('returns a fresh provider each time', () => {
    expect(defaultPaymentProvider('test')).not.toBe(defaultPaymentProvider('test'));
  });
});
