import type {
  CreatePaymentLinkRequest,
  ParseWebhookEventRequest,
  PaymentLinkResult,
  PaymentProvider,
  PaymentWebhookEvent,
  VerifyWebhookSignatureRequest,
} from './contracts';
import { ProviderUnavailableError } from './errors';
import { FakePaymentProvider } from './fake';

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
