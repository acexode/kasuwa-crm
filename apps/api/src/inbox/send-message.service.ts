import {
  ChannelError,
  DndRefusedError,
  InvalidSendRequestError,
  ProviderRejectedError,
  ProviderUnavailableError,
  isDndChannel,
  type ChannelKind,
  type ChannelProvider,
  type DndRegister,
} from '@kasuwa/channel-adapter';
import type { TenantTx } from '@kasuwa/db';
import {
  ConversationMissingDestinationError,
  findLastInboundMessageAt,
  findMessageTemplateById,
  hashE164ForConsent,
  isWhatsappWindowOpen,
  recordConsentCheck,
  recordConsentCheckAutocommit,
  recordOutboundMessage,
  resolveConversationDestination,
} from '@kasuwa/domain-core';
import type { Pool } from 'pg';
import { HttpStatus } from '@nestjs/common';
import type { z } from 'zod';
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

const windowClosed = (): AdminError =>
  new AdminError(
    HttpStatus.BAD_REQUEST,
    'window_closed',
    'Free-form messages are blocked outside the customer window. Use an approved template.',
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

async function resolveSendBody(
  tx: TenantTx,
  programmeId: string,
  channel: string,
  parsed: z.infer<typeof SendMessageBody>,
  windowEnforced: boolean,
  conversationId: string,
): Promise<string> {
  if (!windowEnforced || channel !== 'whatsapp') {
    if (parsed.body === undefined) {
      throw validationFailed([{ path: 'body', code: 'required' }]);
    }
    return parsed.body;
  }

  const lastInbound = await findLastInboundMessageAt(tx, conversationId);
  const open = isWhatsappWindowOpen(lastInbound);
  if (open) {
    if (parsed.body === undefined) {
      throw validationFailed([{ path: 'body', code: 'required' }]);
    }
    return parsed.body;
  }

  if (parsed.messageTemplateId === undefined) {
    throw windowClosed();
  }
  const template = await findMessageTemplateById(tx, programmeId, parsed.messageTemplateId);
  if (template === null || template.channel !== channel) {
    throw notFound();
  }
  return template.body;
}

async function auditConsentForSend(
  tx: TenantTx,
  pool: Pool,
  dnd: DndRegister,
  programmeId: string,
  channel: string,
  to: string,
  purpose: 'transactional' | 'promotional',
): Promise<void> {
  const hash = hashE164ForConsent(tx.session.tenantId, to);

  if (!isDndChannel(channel as ChannelKind) || purpose === 'transactional') {
    await recordConsentCheck(tx, programmeId, hash, purpose, 'allowed');
    return;
  }

  let answer: unknown;
  try {
    answer = await dnd.isRegistered(to);
  } catch {
    await recordConsentCheckAutocommit(pool, tx.session, programmeId, hash, purpose, 'unavailable');
    throw sendUnavailable();
  }
  if (answer !== false) {
    await recordConsentCheckAutocommit(pool, tx.session, programmeId, hash, purpose, 'dnd_refused');
    throw dndRefused();
  }
  await recordConsentCheck(tx, programmeId, hash, purpose, 'allowed');
}

export async function sendMessageFor(
  tx: TenantTx,
  pool: Pool,
  channel: ChannelProvider,
  dnd: DndRegister,
  params: unknown,
  body: unknown,
  options: { inboxTemplatesEnabled?: boolean } = {},
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

  const sendBody = await resolveSendBody(
    tx,
    destination.programmeId,
    destination.channel,
    parsed.data,
    options.inboxTemplatesEnabled === true,
    conversationId,
  );

  await auditConsentForSend(
    tx,
    pool,
    dnd,
    destination.programmeId,
    destination.channel,
    destination.to,
    parsed.data.purpose,
  );

  let providerMessageId: string;
  let providerState: string;
  try {
    const result = await channel.send({
      scope: { tenantId: tx.session.tenantId, programmeId: destination.programmeId },
      channel: destination.channel,
      to: destination.to,
      body: sendBody,
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
    { body: sendBody, purpose: parsed.data.purpose },
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
