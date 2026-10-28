import { z } from 'zod';

/**
 * Payment provider contract — v0 (T-0168).
 *
 * The single boundary between Kasuwa and African payment providers (CLAUDE.md
 * section 2 rule 8; D-L205). Provider names (`paystack`, `flutterwave`) are
 * defined only in this package. Real SDKs arrive with T-0169; until then the
 * implementations are the in-memory fake and the fail-closed null provider.
 *
 * PAN never enters Kasuwa. Payment method refs carry `token` and `lastFour`
 * only — there is deliberately no `pan` / `cardNumber` field on any type here.
 */

export const TenantScope = z.object({
  tenantId: z.uuid(),
  programmeId: z.uuid(),
});
export type TenantScope = z.infer<typeof TenantScope>;

/**
 * Providers this package is allowed to name. Application code selects through
 * these ids (or a factory that takes them); it must not spell the vendor in
 * its own source.
 */
export const PAYMENT_PROVIDER_IDS = ['paystack', 'flutterwave'] as const;
export type PaymentProviderId = (typeof PAYMENT_PROVIDER_IDS)[number];
export const PaymentProviderIdSchema = z.enum(PAYMENT_PROVIDER_IDS);

/** Ids persisted on payment_link.provider (real vendors + in-memory fake). */
export const STORED_PAYMENT_PROVIDER_IDS = [...PAYMENT_PROVIDER_IDS, 'fake'] as const;
export type StoredPaymentProviderId = (typeof STORED_PAYMENT_PROVIDER_IDS)[number];
export const StoredPaymentProviderIdSchema = z.enum(STORED_PAYMENT_PROVIDER_IDS);

/** True when a webhook path segment is a known stored provider id. */
export function isStoredPaymentProviderId(value: string): value is StoredPaymentProviderId {
  return (STORED_PAYMENT_PROVIDER_IDS as readonly string[]).includes(value);
}

/** Currencies payment links may collect in at P0 (B6 / commerce catalogue). */
export const PAYMENT_CURRENCIES = ['NGN', 'GHS', 'KES', 'ZAR'] as const;
export type PaymentCurrency = (typeof PAYMENT_CURRENCIES)[number];
export const PaymentCurrencySchema = z.enum(PAYMENT_CURRENCIES);

export const PaymentLinkStatus = z.enum(['pending', 'paid', 'expired', 'cancelled']);
export type PaymentLinkStatus = z.infer<typeof PaymentLinkStatus>;

export const PaymentWebhookEventType = z.enum([
  'payment.paid',
  'payment.expired',
  'payment.failed',
]);
export type PaymentWebhookEventType = z.infer<typeof PaymentWebhookEventType>;

/**
 * A card (or wallet) reference returned after a successful charge.
 *
 * Token plus last four digits ONLY. Adding a PAN-like field here is a
 * stop-the-line defect — the T-0168 acceptance suite fails on any such name.
 */
export const PaymentMethodRef = z
  .object({
    token: z.string().min(1).max(256),
    /** Exactly four digit characters; never a longer fragment of a PAN. */
    lastFour: z.string().regex(/^\d{4}$/),
  })
  .strict();
export type PaymentMethodRef = z.infer<typeof PaymentMethodRef>;

/** Money as minor units (`bigint`) plus ISO currency — never a float. */
export const CreatePaymentLinkRequest = z.object({
  scope: TenantScope,
  amountMinor: z.bigint().positive(),
  currency: PaymentCurrencySchema,
  /** Caller reference (e.g. quote id); opaque to the provider. */
  reference: z.string().min(1).max(128),
  idempotencyKey: z.string().min(1).max(128),
  description: z.string().min(1).max(256).optional(),
  successUrl: z.url().optional(),
  cancelUrl: z.url().optional(),
  expiresAt: z.date().optional(),
});
export type CreatePaymentLinkRequest = z.infer<typeof CreatePaymentLinkRequest>;

export const PaymentLinkResult = z.object({
  providerLinkId: z.string().min(1).max(256),
  url: z.url(),
  status: PaymentLinkStatus,
  expiresAt: z.date().optional(),
});
export type PaymentLinkResult = z.infer<typeof PaymentLinkResult>;

/**
 * Raw webhook ingress. The adapter verifies the signature against the secret
 * configured on the provider instance — never against a secret from the
 * request. `rawBody` is never logged.
 */
export const VerifyWebhookSignatureRequest = z.object({
  rawBody: z.union([z.string(), z.instanceof(Uint8Array)]),
  /** Header names are lower-cased by the caller before they reach here. */
  headers: z.record(z.string(), z.union([z.string(), z.array(z.string())]).optional()),
});
export type VerifyWebhookSignatureRequest = z.infer<typeof VerifyWebhookSignatureRequest>;

export const ParseWebhookEventRequest = z.object({
  rawBody: z.union([z.string(), z.instanceof(Uint8Array)]),
  headers: z.record(z.string(), z.union([z.string(), z.array(z.string())]).optional()),
});
export type ParseWebhookEventRequest = z.infer<typeof ParseWebhookEventRequest>;

/**
 * Normalised webhook event. Closed shape: no provider-specific bag of fields,
 * and no path for a PAN to travel through.
 */
export const PaymentWebhookEvent = z
  .object({
    eventId: z.string().min(1).max(256),
    occurredAt: z.date(),
    type: PaymentWebhookEventType,
    providerLinkId: z.string().min(1).max(256),
    reference: z.string().min(1).max(128).optional(),
    amountMinor: z.bigint().positive().optional(),
    currency: PaymentCurrencySchema.optional(),
    paymentMethod: PaymentMethodRef.optional(),
  })
  .strict();
export type PaymentWebhookEvent = z.infer<typeof PaymentWebhookEvent>;

/**
 * What every payment provider implements.
 *
 * A provider SHOULD throw the typed errors in ./errors.ts. Callers treat
 * anything else as unavailable / rejected — never as success.
 */
export interface PaymentProvider {
  readonly id: PaymentProviderId | 'fake' | 'null';

  createPaymentLink(request: CreatePaymentLinkRequest): Promise<PaymentLinkResult>;

  /**
   * Returns true only when the signature is valid for this provider's secret.
   * Returns false (never throws for a bad signature) so an unknown slug and a
   * bad signature can share one response body (D-L205). Throws only when the
   * provider itself is unavailable.
   */
  verifyWebhookSignature(request: VerifyWebhookSignatureRequest): Promise<boolean>;

  /**
   * Parses and Zod-validates a verified webhook body. Must not be called on a
   * body that failed `verifyWebhookSignature`. Never logs `rawBody`.
   */
  parseWebhookEvent(request: ParseWebhookEventRequest): Promise<PaymentWebhookEvent>;
}

export type PaymentLogFn = (message: string, fields?: Record<string, unknown>) => void;

export interface PaymentLogger {
  debug: PaymentLogFn;
  info: PaymentLogFn;
  warn: PaymentLogFn;
  error: PaymentLogFn;
}
