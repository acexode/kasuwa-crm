import { describe, expect, it } from 'vitest';
import { CreatePaymentLinkBody, SetQuoteStatusBody } from './commerce.schemas';

describe('payment link request shapes', () => {
  it('requires an idempotency key and nothing else', () => {
    expect(CreatePaymentLinkBody.safeParse({ idempotencyKey: 'once' }).success).toBe(true);
    expect(CreatePaymentLinkBody.safeParse({}).success).toBe(false);
    expect(CreatePaymentLinkBody.safeParse({ idempotencyKey: 'once', amountMinor: '1' }).success).toBe(false);
  });

  it('refuses paid on the client status body', () => {
    expect(SetQuoteStatusBody.safeParse({ status: 'sent' }).success).toBe(true);
    expect(SetQuoteStatusBody.safeParse({ status: 'paid' }).success).toBe(false);
  });
});
