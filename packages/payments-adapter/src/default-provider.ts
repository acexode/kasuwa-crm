import { createHmac } from 'node:crypto';
import type {
  CreatePaymentLinkRequest,
  ParseWebhookEventRequest,
  PaymentLinkResult,
  PaymentProvider,
  PaymentWebhookEvent,
  VerifyWebhookSignatureRequest,
} from './contracts';
import { ProviderUnavailableError } from './errors';
import { FAKE_WEBHOOK_SECRET, FakePaymentProvider } from './fake';

/**
 * The provider for an environment with no real provider configured.
 *
 * Every operation fails with `ProviderUnavailableError`, so a caller reports
 * the truth — nothing was created or verified — instead of inventing success.
 * It keeps nothing: no body, no secret, no token in memory.
 */
export class NullPaymentProvider implements PaymentProvider {
  readonly id = 'null' as const;

  async createPaymentLink(_request: CreatePaymentLinkRequest): Promise<PaymentLinkResult> {
    throw new ProviderUnavailableError();
  }

  async verifyWebhookSignature(_request: VerifyWebhookSignatureRequest): Promise<boolean> {
    // Fail closed: an unconfigured provider never authenticates a webhook.
    throw new ProviderUnavailableError();
  }

  async parseWebhookEvent(_request: ParseWebhookEventRequest): Promise<PaymentWebhookEvent> {
    throw new ProviderUnavailableError();
  }
}

export type PaymentEnvironment = 'development' | 'test' | 'production';

/**
 * The provider to use when none is configured, by environment.
 *
 * Production gets `NullPaymentProvider` (fail closed). Development and test
 * get the in-memory fake so local journeys and acceptance suites can exercise
 * the contract without sandbox credentials (PLAN § External sandboxes).
 *
 * The environment is an argument, not read here: this package names no
 * configuration source, and the API will pass `nodeEnv()` from `@kasuwa/config`.
 */
export function defaultPaymentProvider(environment: PaymentEnvironment): PaymentProvider {
  return environment === 'production' ? new NullPaymentProvider() : new FakePaymentProvider();
}

/**
 * Webhook secret for one tenant on the in-memory fake (T-0169). Derived, never
 * stored. A signature made for tenant B does not verify against tenant A's
 * secret, so a valid signature posted to the wrong slug is refused.
 * Production never uses it: {@link paymentProviderFor} returns the null provider.
 */
export function fakeWebhookSecretForTenant(tenantId: string): string {
  return createHmac('sha256', FAKE_WEBHOOK_SECRET).update(tenantId).digest('hex');
}

/**
 * The provider a request should use. Production fails closed. Development and
 * test get a fresh fake whose webhook secret belongs to `tenantId` alone, so
 * two instances still agree on the signature without sharing memory.
 */
export function paymentProviderFor(environment: PaymentEnvironment, tenantId: string): PaymentProvider {
  if (environment === 'production') return new NullPaymentProvider();
  return new FakePaymentProvider({ webhookSecret: fakeWebhookSecretForTenant(tenantId) });
}
