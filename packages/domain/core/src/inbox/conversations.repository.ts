import type { TenantTx } from '@kasuwa/db';
import type {
  Conversation,
  ConversationChannel,
  ConversationParticipant,
  ConversationStatus,
  Message,
  MessageDirection,
  ParticipantRole,
} from './conversations.types';

export class ConversationProgrammeOutOfScopeError extends Error {
  constructor() {
    super('Refusing to access conversation data in a programme outside the session scope');
    this.name = 'ConversationProgrammeOutOfScopeError';
  }
}

function assertInScope(tx: TenantTx, programmeId: string): void {
  if (!tx.session.programmeIds.includes(programmeId)) {
    throw new ConversationProgrammeOutOfScopeError();
  }
}

interface ConversationRow {
  id: string;
  programme_id: string;
  contact_id: string;
  channel: ConversationChannel;
  status: ConversationStatus;
  subject: string | null;
  last_message_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ParticipantRow {
  id: string;
  conversation_id: string;
  user_id: string;
  role: ParticipantRole;
}

interface MessageRow {
  id: string;
  programme_id: string;
  conversation_id: string;
  direction: MessageDirection;
  body_redacted: string;
  provider_message_id: string | null;
  sent_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const CONVERSATION_COLUMNS = `id, programme_id, contact_id, channel, status, subject,
  last_message_at, created_at, updated_at`;

function toParticipant(row: ParticipantRow): ConversationParticipant {
  return {
    id: row.id,
    userId: row.user_id,
    role: row.role,
  };
}

function toConversation(row: ConversationRow, participants: ConversationParticipant[]): Conversation {
  return {
    id: row.id,
    programmeId: row.programme_id,
    contactId: row.contact_id,
    channel: row.channel,
    status: row.status,
    subject: row.subject,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    participants,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    programmeId: row.programme_id,
    conversationId: row.conversation_id,
    direction: row.direction,
    bodyRedacted: row.body_redacted,
    providerMessageId: row.provider_message_id,
    sentByUserId: row.sent_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadParticipants(
  tx: TenantTx,
  programmeId: string,
  conversationIds: readonly string[],
): Promise<Map<string, ConversationParticipant[]>> {
  const map = new Map<string, ConversationParticipant[]>();
  if (conversationIds.length === 0) return map;
  const rows = await tx.query<ParticipantRow & { conversation_id: string }>(
    `SELECT id, conversation_id, user_id, role
       FROM conversation_participant
      WHERE tenant_id = $1::uuid
        AND programme_id = $2::uuid
        AND conversation_id = ANY($3::uuid[])
      ORDER BY created_at, id`,
    [tx.session.tenantId, programmeId, conversationIds],
  );
  for (const row of rows) {
    const list = map.get(row.conversation_id) ?? [];
    list.push(toParticipant(row));
    map.set(row.conversation_id, list);
  }
  return map;
}

export async function listConversations(
  tx: TenantTx,
  programmeId: string,
): Promise<Conversation[]> {
  assertInScope(tx, programmeId);
  const rows = await tx.query<ConversationRow>(
    `SELECT ${CONVERSATION_COLUMNS}
       FROM conversation
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid
      ORDER BY last_message_at DESC NULLS LAST, created_at DESC, id DESC`,
    [tx.session.tenantId, programmeId],
  );
  const participants = await loadParticipants(
    tx,
    programmeId,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toConversation(row, participants.get(row.id) ?? []));
}

export async function findConversationById(
  tx: TenantTx,
  conversationId: string,
): Promise<Conversation | null> {
  const rows = await tx.query<ConversationRow>(
    `SELECT ${CONVERSATION_COLUMNS}
       FROM conversation
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND programme_id = ANY($3::uuid[])`,
    [tx.session.tenantId, conversationId, tx.session.programmeIds],
  );
  const row = rows[0];
  if (!row) return null;
  const participants = await loadParticipants(tx, row.programme_id, [row.id]);
  return toConversation(row, participants.get(row.id) ?? []);
}

export async function listMessages(
  tx: TenantTx,
  conversationId: string,
): Promise<Message[] | null> {
  const conversation = await findConversationById(tx, conversationId);
  if (conversation === null) return null;
  const rows = await tx.query<MessageRow>(
    `SELECT id, programme_id, conversation_id, direction, body_redacted,
            provider_message_id, sent_by_user_id, created_at, updated_at
       FROM message
      WHERE tenant_id = $1::uuid
        AND programme_id = $2::uuid
        AND conversation_id = $3::uuid
      ORDER BY created_at ASC, id ASC`,
    [tx.session.tenantId, conversation.programmeId, conversationId],
  );
  return rows.map(toMessage);
}
