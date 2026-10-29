import type { TenantTx } from '@kasuwa/db';
import {
  ConversationProgrammeOutOfScopeError,
  findConversationById,
  listConversations,
  listMessages,
  type Conversation,
  type Message,
} from '@kasuwa/domain-core';
import { notFound } from '../admin/common/admin-errors';
import { ConversationIdParam, ProgrammeIdParam } from './inbox.schemas';

export interface ConversationParticipantWire {
  id: string;
  userId: string;
  role: string;
}

export interface ConversationWire {
  id: string;
  programmeId: string;
  contactId: string;
  channel: string;
  status: string;
  subject: string | null;
  lastMessageAt: string | null;
  participants: ConversationParticipantWire[];
  createdAt: string;
  updatedAt: string;
}

export interface MessageWire {
  id: string;
  programmeId: string;
  conversationId: string;
  direction: string;
  bodyRedacted: string;
  providerMessageId: string | null;
  sentByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

function toConversationWire(conversation: Conversation): ConversationWire {
  return {
    id: conversation.id,
    programmeId: conversation.programmeId,
    contactId: conversation.contactId,
    channel: conversation.channel,
    status: conversation.status,
    subject: conversation.subject,
    lastMessageAt: conversation.lastMessageAt ? conversation.lastMessageAt.toISOString() : null,
    participants: conversation.participants.map((participant) => ({
      id: participant.id,
      userId: participant.userId,
      role: participant.role,
    })),
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

export function toMessageWire(message: Message): MessageWire {
  return {
    id: message.id,
    programmeId: message.programmeId,
    conversationId: message.conversationId,
    direction: message.direction,
    bodyRedacted: message.bodyRedacted,
    providerMessageId: message.providerMessageId,
    sentByUserId: message.sentByUserId,
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}

function programmeFromPath(tx: TenantTx, params: unknown): string {
  const { programmeId } = ProgrammeIdParam.parse(params);
  if (!tx.session.programmeIds.includes(programmeId)) throw notFound();
  return programmeId;
}

function mapConversationError(error: unknown): never {
  if (error instanceof ConversationProgrammeOutOfScopeError) throw notFound();
  throw error;
}

export async function listConversationsFor(
  tx: TenantTx,
  params: unknown,
): Promise<{ data: ConversationWire[] }> {
  const programmeId = programmeFromPath(tx, params);
  try {
    const data = await listConversations(tx, programmeId);
    return { data: data.map(toConversationWire) };
  } catch (error) {
    mapConversationError(error);
  }
}

export async function getConversationFor(
  tx: TenantTx,
  params: unknown,
): Promise<ConversationWire> {
  const { conversationId } = ConversationIdParam.parse(params);
  const conversation = await findConversationById(tx, conversationId);
  if (conversation === null) throw notFound();
  return toConversationWire(conversation);
}

export async function listMessagesFor(
  tx: TenantTx,
  params: unknown,
): Promise<{ data: MessageWire[] }> {
  const { conversationId } = ConversationIdParam.parse(params);
  const messages = await listMessages(tx, conversationId);
  if (messages === null) throw notFound();
  return { data: messages.map(toMessageWire) };
}
