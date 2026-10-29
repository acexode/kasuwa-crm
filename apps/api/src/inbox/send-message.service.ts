import {
  ChannelError,
  DndRefusedError,
  InvalidSendRequestError,
  ProviderRejectedError,
  ProviderUnavailableError,
  type ChannelProvider,
} from '@kasuwa/channel-adapter';
import type { TenantTx } from '@kasuwa/db';
import {
  ConversationMissingDestinationError,
  recordOutboundMessage,
  resolveConversationDestination,
} from '@kasuwa/domain-core';
import { HttpStatus } from '@nestjs/common';
import {
  AdminError,
  notFound,
  validationFailed,
  validationFailedFrom,
} from '../admin/common/admin-errors';
import { toMessageWire, type MessageWire } from './conversations.service';
import { ConversationIdParam, SendMessageBody } from './inbox.schemas';

export interface MessageDeliveryWire {
  id: string;
  messageId: string;
  state: string;
  providerMessageId: string | null;
  attempt: number;
  lastErrorCode: string | null;
}

export interface SendMessageWire {
  message: MessageWire;
  delivery: MessageDeliveryWire;
}

const sendUnavailable = (): AdminError =>
  new AdminError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'service_unavailable',
    'The message could not be sent. Try again shortly.',
  );

const dndRefused = (): AdminError =>
  new AdminError(
    HttpStatus.FORBIDDEN,
    'dnd_refused',
    'Promotional messages cannot be sent to this number.',
  );

const providerRejected = (): AdminError =>
  new AdminError(
    HttpStatus.BAD_REQUEST,
    'provider_rejected',
    'The channel provider rejected the message.',
  );

const noDestination = (): AdminError =>
  new AdminError(
    HttpStatus.BAD_REQUEST,
    'no_destination',
    'The contact has no destination for this conversation channel.',
  );

function mapChannelError(error: ChannelError): never {
  if (error instanceof DndRefusedError) throw dndRefused();
  if (error instanceof InvalidSendRequestError) {
    throw validationFailed(error.fields.map((path) => ({ path, code: 'invalid' })));
  }
  if (error instanceof ProviderUnavailableError) throw sendUnavailable();
  if (error instanceof ProviderRejectedError) throw providerRejected();
  throw sendUnavailable();
}

export async function sendMessageFor(
  tx: TenantTx,
  channel: ChannelProvider,
  params: unknown,
  body: unknown,
): Promise<SendMessageWire> {
  const { conversationId } = ConversationIdParam.parse(params);
  const parsed = SendMessageBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);

  let destination: Awaited<ReturnType<typeof resolveConversationDestination>>;
  try {
    destination = await resolveConversationDestination(tx, conversationId);
  } catch (error) {
    if (error instanceof ConversationMissingDestinationError) throw noDestination();
    throw error;
  }
  if (destination === null) throw notFound();

  let providerMessageId: string;
  let providerState: string;
  try {
    const result = await channel.send({
      scope: { tenantId: tx.session.tenantId, programmeId: destination.programmeId },
      channel: destination.channel,
      to: destination.to,
      body: parsed.data.body,
      purpose: parsed.data.purpose,
      idempotencyKey: `inbox:${conversationId}:${parsed.data.idempotencyKey}`,
    });
    providerMessageId = result.messageId;
    providerState = result.state;
  } catch (error) {
    if (error instanceof ChannelError) mapChannelError(error);
    throw error;
  }

  const recorded = await recordOutboundMessage(
    tx,
    conversationId,
    { body: parsed.data.body, purpose: parsed.data.purpose },
    providerMessageId,
    providerState,
  );
  if (recorded === null) throw notFound();

  return {
    message: toMessageWire(recorded.message),
    delivery: {
      id: recorded.delivery.id,
      messageId: recorded.delivery.messageId,
      state: recorded.delivery.state,
      providerMessageId: recorded.delivery.providerMessageId,
      attempt: recorded.delivery.attempt,
      lastErrorCode: recorded.delivery.lastErrorCode,
    },
  };
}
