import { newId, type TenantTx } from '@kasuwa/db';
import { findConversationById } from './conversations.repository';

export interface InboxQueue {
  id: string;
  programmeId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CannedResponse {
  id: string;
  programmeId: string;
  title: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

interface QueueRow {
  id: string;
  programme_id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

interface CannedRow {
  id: string;
  programme_id: string;
  title: string;
  body: string;
  created_at: Date;
  updated_at: Date;
}

export async function listInboxQueues(tx: TenantTx, programmeId: string): Promise<InboxQueue[]> {
  const rows = await tx.query<QueueRow>(
    `SELECT id, programme_id, name, created_at, updated_at
       FROM inbox_queue
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid
      ORDER BY name ASC`,
    [tx.session.tenantId, programmeId],
  );
  return rows.map((row) => ({
    id: row.id,
    programmeId: row.programme_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function createInboxQueue(
  tx: TenantTx,
  programmeId: string,
  name: string,
): Promise<InboxQueue> {
  const id = newId();
  const rows = await tx.query<QueueRow>(
    `INSERT INTO inbox_queue (id, tenant_id, programme_id, name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, programme_id, name, created_at, updated_at`,
    [id, tx.session.tenantId, programmeId, name],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('inbox_queue insert failed');
  return {
    id: row.id,
    programmeId: row.programme_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listCannedResponses(
  tx: TenantTx,
  programmeId: string,
): Promise<CannedResponse[]> {
  const rows = await tx.query<CannedRow>(
    `SELECT id, programme_id, title, body, created_at, updated_at
       FROM canned_response
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid
      ORDER BY title ASC`,
    [tx.session.tenantId, programmeId],
  );
  return rows.map((row) => ({
    id: row.id,
    programmeId: row.programme_id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function createCannedResponse(
  tx: TenantTx,
  programmeId: string,
  title: string,
  body: string,
): Promise<CannedResponse> {
  const id = newId();
  const rows = await tx.query<CannedRow>(
    `INSERT INTO canned_response (id, tenant_id, programme_id, title, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, programme_id, title, body, created_at, updated_at`,
    [id, tx.session.tenantId, programmeId, title, body],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('canned_response insert failed');
  return {
    id: row.id,
    programmeId: row.programme_id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findLastInboundMessageAt(
  tx: TenantTx,
  conversationId: string,
): Promise<Date | null> {
  const rows = await tx.query<{ created_at: Date }>(
    `SELECT created_at
       FROM message
      WHERE tenant_id = $1::uuid
        AND conversation_id = $2::uuid
        AND direction = 'inbound'
      ORDER BY created_at DESC
      LIMIT 1`,
    [tx.session.tenantId, conversationId],
  );
  return rows[0]?.created_at ?? null;
}

export async function assignConversationToUser(
  tx: TenantTx,
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const conversation = await findConversationById(tx, conversationId);
  if (conversation === null) return false;

  await tx.query(
    `DELETE FROM conversation_participant
      WHERE tenant_id = $1::uuid
        AND programme_id = $2::uuid
        AND conversation_id = $3::uuid
        AND role = 'assignee'`,
    [tx.session.tenantId, conversation.programmeId, conversationId],
  );

  const id = newId();
  await tx.query(
    `INSERT INTO conversation_participant
       (id, tenant_id, programme_id, conversation_id, user_id, role)
     VALUES ($1, $2, $3, $4, $5, 'assignee')
     ON CONFLICT (tenant_id, programme_id, conversation_id, user_id)
     DO UPDATE SET role = 'assignee', updated_at = now()`,
    [id, tx.session.tenantId, conversation.programmeId, conversationId, userId],
  );
  return true;
}

export async function transferConversationToUser(
  tx: TenantTx,
  conversationId: string,
  targetUserId: string,
): Promise<boolean> {
  return assignConversationToUser(tx, conversationId, targetUserId);
}
