import { describe, expect, it } from 'vitest';
import type { CreatePaymentLinkRequest, PaymentWebhookEvent } from './contracts';
import {
  InvalidPaymentRequestError,
  InvalidWebhookError,
  ProviderRejectedError,
  ProviderUnavailableError,
} from './errors';
import {
  FAKE_SIGNATURE_HEADER,
  FakePaymentProvider,
} from './fake';

const SCOPE = {
  tenantId: '11111111-0000-4000-8000-000000000001',
  programmeId: '11111111-0000-4000-8000-0000000c0001',
};

function linkRequest(overrides: Partial<CreatePaymentLinkRequest> = {}): CreatePaymentLinkRequest {
  return {
    scope: SCOPE,
    amountMinor: 15_000n,
    currency: 'NGN',
    reference: 'quote-unit-0001',
    idempotencyKey: 'idem-unit-0001',
    ...overrides,
  };
}

function paidEvent(providerLinkId: string): PaymentWebhookEvent {
  return {
    eventId: 'evt-unit-0001',
    occurredAt: new Date('2026-10-28T00:00:00.000Z'),
    type: 'payment.paid',
    providerLinkId,
    reference: 'quote-unit-0001',
    amountMinor: 15_000n,
    currency: 'NGN',
    paymentMethod: { token: 'tok_unit_4242', lastFour: '4242' },
  };
}

describe('FakePaymentProvider', () => {
  it('creates a pending payment link with a url and provider id', async () => {
    const provider = new FakePaymentProvider();
    const result = await provider.createPaymentLink(linkRequest());
    expect(result.status).toBe('pending');
    expect(result.providerLinkId).toMatch(/^fake-link-/);
    expect(result.url).toContain(result.providerLinkId);
    expect(provider.createdLinks).toHaveLength(1);
  });

  it('replays the same result for the same idempotency key', async () => {
    const provider = new FakePaymentProvider();
    const first = await provider.createPaymentLink(linkRequest());
    const second = await provider.createPaymentLink(
      linkRequest({ amountMinor: 99_999n, reference: 'other' }),
    );
    expect(second).toEqual(first);
    expect(provider.createdLinks).toHaveLength(1);
  });

  it('refuses a non-positive amount without accepting the request', async () => {
    const provider = new FakePaymentProvider();
    await expect(
      provider.createPaymentLink(linkRequest({ amountMinor: 0n })),
    ).rejects.toBeInstanceOf(InvalidPaymentRequestError);
    expect(provider.createdLinks).toHaveLength(0);
  });

  it('honours failNextCreate for unavailable and rejected', async () => {
    const provider = new FakePaymentProvider();
    provider.failNextCreate('unavailable');
    await expect(provider.createPaymentLink(linkRequest())).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    provider.failNextCreate('rejected');
    await expect(
      provider.createPaymentLink(linkRequest({ idempotencyKey: 'idem-2' })),
    ).rejects.toBeInstanceOf(ProviderRejectedError);
  });

  it('verifies a signed webhook and parses token plus lastFour only', async () => {
    const provider = new FakePaymentProvider();
    const link = await provider.createPaymentLink(linkRequest());
    const { rawBody, headers } = provider.signWebhook(paidEvent(link.providerLinkId));

    await expect(provider.verifyWebhookSignature({ rawBody, headers })).resolves.toBe(true);
    await expect(
      provider.verifyWebhookSignature({
        rawBody,
        headers: { [FAKE_SIGNATURE_HEADER]: 'deadbeef' },
      }),
    ).resolves.toBe(false);

    const event = await provider.parseWebhookEvent({ rawBody, headers });
    expect(event.type).toBe('payment.paid');
    expect(event.paymentMethod).toEqual({ token: 'tok_unit_4242', lastFour: '4242' });
    const serialised = JSON.stringify(event, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialised).not.toMatch(/pan|cardNumber|card_number/i);
  });

  it('refuses a malformed webhook body', async () => {
    const provider = new FakePaymentProvider();
    await expect(
      provider.parseWebhookEvent({ rawBody: '{"not":"a-payment-event"}', headers: {} }),
    ).rejects.toBeInstanceOf(InvalidWebhookError);
    await expect(
      provider.parseWebhookEvent({ rawBody: 'not-json', headers: {} }),
    ).rejects.toBeInstanceOf(InvalidWebhookError);
  });
});
