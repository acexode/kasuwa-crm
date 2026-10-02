import { randomUUID } from 'node:crypto';
import type {
  ChannelProvider,
  DeliveryState,
  DeliveryStatus,
  DndRegister,
  SendRequest,
  SendResult,
  TenantScope,
} from './contracts';
import { MessageNotFoundError, ProviderRejectedError, ProviderUnavailableError } from './errors';

/** The fake keeps only the most recent accepted requests, so a long-lived one cannot grow without bound. */
export const FAKE_SENT_LIMIT = 1_000;

interface StoredMessage {
  scope: TenantScope;
  state: DeliveryState;
  updatedAt: Date;
}

/**
 * In-memory channel provider, for tests and local development until the
 * provider decision is made. It sends nothing anywhere.
 *
 * It deliberately does NOT check DND or validate: those live in
 * `createChannelAdapter`, in front of every provider, so they cannot vanish
 * the day this fake is swapped for a real one.
 */
export class FakeChannelProvider implements ChannelProvider {
  private readonly accepted: SendRequest[] = [];
  private readonly messages = new Map<string, StoredMessage>();
  private pendingFailure: 'unavailable' | 'rejected' | undefined;

  /** The last FAKE_SENT_LIMIT requests the provider accepted, in order. Failed sends are not recorded. */
  get sent(): readonly SendRequest[] {
    return [...this.accepted];
  }

  /** Make the next send fail once, transiently or permanently. */
  failNextSend(kind: 'unavailable' | 'rejected'): void {
    this.pendingFailure = kind;
  }

  /** Simulate a delivery receipt for a message this fake accepted. */
  setDeliveryState(messageId: string, state: DeliveryState): void {
    const message = this.messages.get(messageId);
    if (message === undefined) throw new MessageNotFoundError();
    message.state = state;
    message.updatedAt = new Date();
  }

  async send(request: SendRequest): Promise<SendResult> {
    const failure = this.pendingFailure;
    this.pendingFailure = undefined;
    if (failure === 'unavailable') throw new ProviderUnavailableError();
    if (failure === 'rejected') throw new ProviderRejectedError();

    const messageId = `fake-${randomUUID()}`;
    this.accepted.push({ ...request, scope: { ...request.scope } });
    if (this.accepted.length > FAKE_SENT_LIMIT) this.accepted.shift();
    this.messages.set(messageId, {
      scope: { ...request.scope },
      state: 'queued',
      updatedAt: new Date(),
    });
    return { messageId, state: 'queued' };
  }

  async getDeliveryStatus(scope: TenantScope, messageId: string): Promise<DeliveryStatus> {
    const message = this.messages.get(messageId);
    // Another tenant's or programme's message is indistinguishable from none.
    if (
      message === undefined ||
      message.scope.tenantId !== scope.tenantId ||
      message.scope.programmeId !== scope.programmeId
    ) {
      throw new MessageNotFoundError();
    }
    return { messageId, state: message.state, updatedAt: new Date(message.updatedAt) };
  }
}

/** In-memory DND register over a fixed set of E.164 numbers. */
export class FakeDndRegister implements DndRegister {
  private readonly registered: ReadonlySet<string>;

  constructor(registered: Iterable<string>) {
    this.registered = new Set(registered);
  }

  async isRegistered(e164: string): Promise<boolean> {
    return this.registered.has(e164);
  }
}
