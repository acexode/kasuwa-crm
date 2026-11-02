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
 * Only an environment whose name is exactly `test` gets the in-memory fake.
 * Development, production, and any other name get `NullPaymentProvider`,
 * which refuses every call. A staging process must not accept a webhook
 * signed with the fake secret that ships in this repo.
 *
 * The environment is an argument, not read here: this package names no
 * configuration source, and the API will pass `nodeEnv()` from `@kasuwa/config`.
 */
export function defaultPaymentProvider(environment: PaymentEnvironment): PaymentProvider {
  return environment === 'test' ? new FakePaymentProvider() : new NullPaymentProvider();
}

/**
 * Fake webhook secret for one tenant. Derived, never stored. A signature made
 * for tenant B does not verify against tenant A's secret. Used only when
 * {@link paymentProviderFor} is given the `test` environment.
 */
export function fakeWebhookSecretForTenant(tenantId: string): string {
  return createHmac('sha256', FAKE_WEBHOOK_SECRET).update(tenantId).digest('hex');
}

/**
 * Provider for one tenant. Anything other than exactly `test` fails closed.
 * In `test`, the fake's webhook secret belongs to `tenantId` alone.
 */
export function paymentProviderFor(environment: string, tenantId: string): PaymentProvider {
  if (environment !== 'test') return new NullPaymentProvider();
  return new FakePaymentProvider({ webhookSecret: fakeWebhookSecretForTenant(tenantId) });
}
