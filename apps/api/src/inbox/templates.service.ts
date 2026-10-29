import type { TenantTx } from '@kasuwa/db';
import { createMessageTemplate, listMessageTemplates, type MessageTemplate } from '@kasuwa/domain-core';
import { notFound, validationFailedFrom } from '../admin/common/admin-errors';
import { CreateMessageTemplateBody, ProgrammeIdParam } from './inbox.schemas';

export interface MessageTemplateWire {
  id: string;
  programmeId: string;
  name: string;
  channel: string;
  category: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

function toWire(template: MessageTemplate): MessageTemplateWire {
  return {
    id: template.id,
    programmeId: template.programmeId,
    name: template.name,
    channel: template.channel,
    category: template.category,
    body: template.body,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}

function programmeFromPath(tx: TenantTx, params: unknown): string {
  const { programmeId } = ProgrammeIdParam.parse(params);
  if (!tx.session.programmeIds.includes(programmeId)) throw notFound();
  return programmeId;
}

export async function listTemplatesFor(
  tx: TenantTx,
  params: unknown,
): Promise<{ data: MessageTemplateWire[] }> {
  const programmeId = programmeFromPath(tx, params);
  const rows = await listMessageTemplates(tx, programmeId);
  return { data: rows.map(toWire) };
}

export async function submitTemplateFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<{ data: MessageTemplateWire }> {
  const programmeId = programmeFromPath(tx, params);
  const parsed = CreateMessageTemplateBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  const created = await createMessageTemplate(tx, programmeId, parsed.data);
  return { data: toWire(created) };
}
