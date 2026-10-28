import type {
  ChannelCapabilities,
  ChannelProvider,
  ChannelTemplate,
  ChannelWebhookEvent,
  DeliveryStatus,
  SendRequest,
  SendResult,
  TenantScope,
} from './contracts';
import { ProviderUnavailableError } from './errors';

/**
 * Real BSP-shaped provider skeleton (T-0017 / D-L212 provisional B1).
 * Fail-closed until production credentials and DND answers exist.
 * Vendor name is selected only via config outside this package.
 */
export class BspShapedProvider implements ChannelProvider {
  readonly id = 'bsp-shaped' as const;

  async send(_request: SendRequest): Promise<SendResult> {
    throw new ProviderUnavailableError();
  }

  async getDeliveryStatus(_scope: TenantScope, _messageId: string): Promise<DeliveryStatus> {
    throw new ProviderUnavailableError();
  }

  capabilities(): ChannelCapabilities {
    return { channels: ['sms', 'whatsapp'], templates: true, webhooks: true };
  }

  async templates(_scope: TenantScope): Promise<readonly ChannelTemplate[]> {
    throw new ProviderUnavailableError();
  }

  async parseWebhook(_rawBody: string | Uint8Array): Promise<ChannelWebhookEvent> {
    throw new ProviderUnavailableError();
  }
}
