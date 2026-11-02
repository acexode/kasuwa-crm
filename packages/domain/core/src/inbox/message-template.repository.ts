import { newId, type TenantTx } from '@kasuwa/db';
import type { ConversationChannel } from './conversations.types';

export type MessageTemplateCategory =
  | 'utility'
  | 'marketing'
  | 'authentication'
  | 'service';

export interface MessageTemplate {
  id: string;
  programmeId: string;
  name: string;
  channel: ConversationChannel;
  category: MessageTemplateCategory;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

interface TemplateRow {
  id: string;
  programme_id: string;
  name: string;
  channel: ConversationChannel;
  category: MessageTemplateCategory;
  body: string;
  created_at: Date;
  updated_at: Date;
}

function toTemplate(row: TemplateRow): MessageTemplate {
  return {
    id: row.id,
    programmeId: row.programme_id,
    name: row.name,
    channel: row.channel,
    category: row.category,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listMessageTemplates(
  tx: TenantTx,
  programmeId: string,
): Promise<MessageTemplate[]> {
  const rows = await tx.query<TemplateRow>(
    `SELECT id, programme_id, name, channel, category, body, created_at, updated_at
       FROM message_template
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid
      ORDER BY name ASC`,
    [tx.session.tenantId, programmeId],
  );
  return rows.map(toTemplate);
}

export interface CreateMessageTemplateInput {
  name: string;
  channel: ConversationChannel;
  category: MessageTemplateCategory;
  body: string;
}

export async function createMessageTemplate(
  tx: TenantTx,
  programmeId: string,
  input: CreateMessageTemplateInput,
): Promise<MessageTemplate> {
  const id = newId();
  const rows = await tx.query<TemplateRow>(
    `INSERT INTO message_template
       (id, tenant_id, programme_id, name, channel, category, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, programme_id, name, channel, category, body, created_at, updated_at`,
    [
      id,
      tx.session.tenantId,
      programmeId,
      input.name,
      input.channel,
      input.category,
      input.body,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('message_template insert failed');
  return toTemplate(row);
}

export async function findMessageTemplateById(
  tx: TenantTx,
  programmeId: string,
  templateId: string,
): Promise<MessageTemplate | null> {
  const rows = await tx.query<TemplateRow>(
    `SELECT id, programme_id, name, channel, category, body, created_at, updated_at
       FROM message_template
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid AND id = $3::uuid`,
    [tx.session.tenantId, programmeId, templateId],
  );
  const row = rows[0];
  return row === undefined ? null : toTemplate(row);
}
