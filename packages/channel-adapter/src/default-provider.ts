import type {
  ChannelProvider,
  DeliveryStatus,
  SendRequest,
  SendResult,
  TenantScope,
} from './contracts';
import { MessageNotFoundError, ProviderUnavailableError } from './errors';
import { FakeChannelProvider } from './fake';

/**
 * The provider for an environment with no real provider configured (D-L52).
 *
 * Every send fails with `ProviderUnavailableError`, so a caller reports the
 * truth - nothing was sent - instead of the fake's "queued" for a message that
 * went nowhere. It keeps nothing: no address, no body, no token in memory.
 */
export class NullChannelProvider implements ChannelProvider {
  async send(_request: SendRequest): Promise<SendResult> {
    throw new ProviderUnavailableError();
  }

  async getDeliveryStatus(_scope: TenantScope, _messageId: string): Promise<DeliveryStatus> {
    // Nothing was ever sent, so every id is one this provider has never seen.
    throw new MessageNotFoundError();
  }
}

export type ChannelEnvironment = 'development' | 'test' | 'production';

/**
 * The provider to use when none is configured, by environment (D-L52, amending
 * D-L49): the in-memory fake in development and test, and `NullChannelProvider`
 * in production, until D-P10 chooses a real provider.
 *
 * The environment is an argument, not read here: this package names no
 * configuration source, and the API passes `nodeEnv()` from `@kasuwa/config`.
 * Lives inside the adapter so application code never imports the fake itself.
 */
export function defaultChannelProvider(environment: ChannelEnvironment): ChannelProvider {
  return environment === 'production' ? new NullChannelProvider() : new FakeChannelProvider();
}
