import {
  DeliveryStatusOutput,
  isDndChannel,
  MessageId,
  SendRequest,
  SendResultOutput,
  TenantScope,
  type ChannelLogger,
  type ChannelProvider,
  type DeliveryStatus,
  type DndRegister,
  type SendResult,
} from './contracts';
import type { ChannelError } from './errors';
import {
  DndRefusedError,
  InvalidSendRequestError,
  MessageNotFoundError,
  ProviderRejectedError,
  ProviderUnavailableError,
} from './errors';

export interface ChannelAdapterOptions {
  provider: ChannelProvider;
  dnd: DndRegister;
  logger?: ChannelLogger;
}

/**
 * How many sent messages the wrapper remembers the owner of. The in-memory
 * map is a stand-in: with a real provider, ownership must live in a durable
 * store, or delivery status is unreachable after a restart.
 */
export const OWNERSHIP_LIMIT = 10_000;

const silent: ChannelLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Re-creates a provider's typed error from its class alone, so nothing the
 * provider attached (a message, a cause, the request) survives. Anything
 * unclassified becomes `fallback`.
 */
function sanitise(thrown: unknown, fallback: () => ChannelError): ChannelError {
  if (thrown instanceof DndRefusedError) return new DndRefusedError();
  if (thrown instanceof InvalidSendRequestError) return new InvalidSendRequestError();
  if (thrown instanceof ProviderUnavailableError) return new ProviderUnavailableError();
  if (thrown instanceof ProviderRejectedError) return new ProviderRejectedError();
  if (thrown instanceof MessageNotFoundError) return new MessageNotFoundError();
  return fallback();
}

/**
 * The compliance boundary every send goes through, in front of any provider:
 *
 *   1. Zod-validates the request. `purpose` is required with no default; an
 *      SMS or WhatsApp destination must be E.164 so a national-format number
 *      cannot slip past a register keyed on E.164, and an email destination
 *      must be an address.
 *   2. Checks DND for promotional SMS and WhatsApp only. A transactional
 *      message (an OTP the person asked for) is lawful to a registered number,
 *      and email is outside the NCC register (D-L49).
 *   3. Calls the provider and replaces whatever it throws with a typed
 *      ChannelError carrying no message, cause or request from the provider.
 *
 * Logs carry codes, channel, purpose, scope and message ids — never the
 * destination or the body.
 */
export function createChannelAdapter(options: ChannelAdapterOptions): ChannelProvider {
  const { provider, dnd } = options;
  const logger = options.logger ?? silent;
  /** messageId -> the scope that sent it. Enforced here so no provider can leak across scopes. */
  const owners = new Map<string, TenantScope>();
  const remember = (messageId: string, scope: TenantScope): void => {
    owners.delete(messageId);
    owners.set(messageId, { tenantId: scope.tenantId, programmeId: scope.programmeId });
    while (owners.size > OWNERSHIP_LIMIT) {
      const oldest = owners.keys().next();
      if (oldest.done === true) break;
      owners.delete(oldest.value);
    }
  };

  const log = (
    level: keyof ChannelLogger,
    message: string,
    fields: Record<string, unknown>,
  ): void => {
    try {
      logger[level](message, fields);
    } catch {
      // A broken logger must not turn a delivered message into a failure.
    }
  };

  /** Policy refusals log at warn; provider failures at error. Either way, by code. */
  const refuse = (error: ChannelError, event: string, fields: Record<string, unknown>): never => {
    const policy = error instanceof InvalidSendRequestError || error instanceof DndRefusedError;
    log(policy ? 'warn' : 'error', event, { ...fields, code: error.code });
    throw error;
  };

  return {
    async send(input: SendRequest): Promise<SendResult> {
      const parsed = SendRequest.safeParse(input);
      if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
        return refuse(new InvalidSendRequestError(fields), 'channel.send.invalid', { fields });
      }
      const request = parsed.data;
      const context = {
        tenantId: request.scope.tenantId,
        programmeId: request.scope.programmeId,
        channel: request.channel,
        purpose: request.purpose,
      };

      // DND governs SMS and WhatsApp only (D-L49); email has no NCC register.
      if (request.purpose === 'promotional' && isDndChannel(request.channel)) {
        let answer: unknown;
        try {
          answer = await dnd.isRegistered(request.to);
        } catch {
          // Fail closed: an unanswered DND lookup never becomes a send.
          return refuse(new ProviderUnavailableError(), 'channel.send.dnd_lookup_failed', context);
        }
        // Fail closed: only a literal `false` clears a number. `undefined`,
        // `null` or a truthy non-boolean from a buggy register is a refusal.
        if (answer !== false) {
          return refuse(new DndRefusedError(), 'channel.send.dnd_refused', context);
        }
      }

      let raw: unknown;
      try {
        raw = await provider.send(request);
      } catch (thrown) {
        // Unclassified send failures are NOT retryable: without an idempotency
        // key, a retry after an ambiguous failure can deliver an OTP twice.
        const error = sanitise(thrown, () => new ProviderRejectedError());
        return refuse(error, 'channel.send.failed', context);
      }

      const output = SendResultOutput.safeParse(raw);
      if (!output.success) {
        // The provider may have sent it; not retryable, for the same reason as above.
        return refuse(new ProviderRejectedError(), 'channel.send.invalid_output', context);
      }
      const result: SendResult = output.data;
      remember(result.messageId, request.scope);

      log('info', 'channel.send.accepted', {
        ...context,
        messageId: result.messageId,
        state: result.state,
      });
      return { messageId: result.messageId, state: result.state };
    },

    async getDeliveryStatus(scope: TenantScope, messageId: string): Promise<DeliveryStatus> {
      const parsedScope = TenantScope.safeParse(scope);
      const parsedId = MessageId.safeParse(messageId);
      if (!parsedScope.success || !parsedId.success) {
        const fields = [
          ...(parsedScope.success ? [] : ['scope']),
          ...(parsedId.success ? [] : ['messageId']),
        ];
        return refuse(new InvalidSendRequestError(fields), 'channel.status.invalid', { fields });
      }
      const context = {
        tenantId: parsedScope.data.tenantId,
        programmeId: parsedScope.data.programmeId,
      };

      // Scope is enforced here, not trusted to the provider: another tenant's or
      // programme's message gets the same answer as one that never existed.
      const owner = owners.get(parsedId.data);
      if (
        owner === undefined ||
        owner.tenantId !== parsedScope.data.tenantId ||
        owner.programmeId !== parsedScope.data.programmeId
      ) {
        throw new MessageNotFoundError();
      }

      let raw: unknown;
      try {
        raw = await provider.getDeliveryStatus(parsedScope.data, parsedId.data);
      } catch (thrown) {
        // A status read is idempotent, so an unclassified failure may be retried.
        const error = sanitise(thrown, () => new ProviderUnavailableError());
        if (error instanceof MessageNotFoundError) throw error;
        return refuse(error, 'channel.status.failed', context);
      }

      const output = DeliveryStatusOutput.safeParse(raw);
      if (!output.success || output.data.messageId !== parsedId.data) {
        return refuse(new ProviderUnavailableError(), 'channel.status.invalid_output', context);
      }
      return output.data;
    },
  };
}
