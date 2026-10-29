export const CONVERSATION_CHANNELS = ['sms', 'whatsapp', 'email'] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];

export const CONVERSATION_STATUSES = ['open', 'pending', 'closed'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound', 'note'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const PARTICIPANT_ROLES = ['assignee', 'watcher', 'transfer_target'] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export interface ConversationParticipant {
  id: string;
  userId: string;
  role: ParticipantRole;
}

export interface Conversation {
  id: string;
  programmeId: string;
  contactId: string;
  channel: ConversationChannel;
  status: ConversationStatus;
  subject: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  participants: ConversationParticipant[];
}

export interface Message {
  id: string;
  programmeId: string;
  conversationId: string;
  direction: MessageDirection;
  bodyRedacted: string;
  providerMessageId: string | null;
  sentByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
