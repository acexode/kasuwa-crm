import { newId, type TenantTx } from '@kasuwa/db';
import { findContactById } from '../contact/contact.repository';
import { findConversationById } from './conversations.repository';
import type { ConversationChannel, Message } from './conversations.types';
import { redactMessageBodyForStorage } from './message-body-redact';

export type SendPurpose = 'transactional' | 'promotional';

export interface SendOutboundMessageInput {
  body: string;
  purpose: SendPurpose;
}

export interface MessageDeliveryRecord {
  id: string;
  messageId: string;
  state: 'queued' | 'sent' | 'delivered' | 'failed' | 'dead';
  providerMessageId: string | null;
  attempt: number;
  lastErrorCode: string | null;
}

export interface OutboundSendResult {
  message: Message;
  delivery: MessageDeliveryRecord;
}

export class ConversationMissingDestinationError extends Error {
  constructor() {
    super('Contact has no destination for this conversation channel');
    this.name = 'ConversationMissingDestinationError';
  }
}

function resolveDestination(
  channel: ConversationChannel,
  phones: readonly { e164: string }[],
  emails: readonly string[],
): string {
  if (channel === 'email') {
    const email = emails[0];
    if (email === undefined || email === '') throw new ConversationMissingDestinationError();
    return email;
  }
  const phone = phones[0]?.e164;
  if (phone === undefined || phone === '') throw new ConversationMissingDestinationError();
  return phone;
}

function mapDeliveryState(state: string): MessageDeliveryRecord['state'] {
  if (state === 'sent' || state === 'delivered' || state === 'failed' || state === 'dead') {
    return state;
  }
  return 'queued';
}

export async function recordOutboundMessage(
  tx: TenantTx,
  conversationId: string,
  input: SendOutboundMessageInput,
  providerMessageId: string,
  providerState: string,
): Promise<OutboundSendResult | null> {
  const conversation = await findConversationById(tx, conversationId);
  if (conversation === null) return null;

  const contact = await findContactById(tx, conversation.contactId);
  if (contact === null) return null;
  resolveDestination(conversation.channel, contact.phones, contact.emails);

  const messageId = newId();
  const deliveryId = newId();
  const bodyRedacted = redactMessageBodyForStorage(input.body);
  const deliveryState = mapDeliveryState(providerState);

  await tx.query(
    `INSERT INTO message
       (id, tenant_id, programme_id, conversation_id, direction, body_redacted,
        provider_message_id, sent_by_user_id)
     VALUES ($1, $2, $3, $4, 'outbound', $5, $6, $7)`,
    [
      messageId,
      tx.session.tenantId,
      conversation.programmeId,
      conversationId,
      bodyRedacted,
      providerMessageId,
      tx.session.userId,
    ],
  );

  await tx.query(
    `INSERT INTO message_delivery
       (id, tenant_id, programme_id, message_id, provider_message_id, state, attempt)
     VALUES ($1, $2, $3, $4, $5, $6, 1)`,
    [
      deliveryId,
      tx.session.tenantId,
      conversation.programmeId,
      messageId,
      providerMessageId,
      deliveryState,
    ],
  );

  await tx.query(
    `UPDATE conversation
        SET last_message_at = now(), updated_at = now()
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid AND id = $3::uuid`,
    [tx.session.tenantId, conversation.programmeId, conversationId],
  );

  const now = new Date();
  return {
    message: {
      id: messageId,
      programmeId: conversation.programmeId,
      conversationId,
      direction: 'outbound',
      bodyRedacted,
      providerMessageId,
      sentByUserId: tx.session.userId,
      createdAt: now,
      updatedAt: now,
    },
    delivery: {
      id: deliveryId,
      messageId,
      state: deliveryState,
      providerMessageId,
      attempt: 1,
      lastErrorCode: null,
    },
  };
}

/** Resolves the channel send `to` address; null when conversation or contact is out of scope. */
export async function resolveConversationDestination(
  tx: TenantTx,
  conversationId: string,
): Promise<{ programmeId: string; channel: ConversationChannel; to: string } | null> {
  const conversation = await findConversationById(tx, conversationId);
  if (conversation === null) return null;
  const contact = await findContactById(tx, conversation.contactId);
  if (contact === null) return null;
  try {
    const to = resolveDestination(conversation.channel, contact.phones, contact.emails);
    return { programmeId: conversation.programmeId, channel: conversation.channel, to };
  } catch {
    throw new ConversationMissingDestinationError();
  }
}
