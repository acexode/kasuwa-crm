import type { TenantTx } from '@kasuwa/db';
import {
  assignConversationToUser,
  createCannedResponse,
  createInboxQueue,
  listCannedResponses,
  listInboxQueues,
  transferConversationToUser,
} from '@kasuwa/domain-core';
import { notFound, validationFailedFrom } from '../admin/common/admin-errors';
import {
  AssignConversationBody,
  ConversationIdParam,
  CreateCannedResponseBody,
  CreateInboxQueueBody,
  ProgrammeIdParam,
  TransferConversationBody,
} from './inbox.schemas';
import { getConversationFor } from './conversations.service';

function programmeFromPath(tx: TenantTx, params: unknown): string {
  const { programmeId } = ProgrammeIdParam.parse(params);
  if (!tx.session.programmeIds.includes(programmeId)) throw notFound();
  return programmeId;
}

export async function listQueuesFor(tx: TenantTx, params: unknown) {
  const programmeId = programmeFromPath(tx, params);
  const rows = await listInboxQueues(tx, programmeId);
  return {
    data: rows.map((row) => ({
      id: row.id,
      programmeId: row.programmeId,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

export async function createQueueFor(tx: TenantTx, params: unknown, body: unknown) {
  const programmeId = programmeFromPath(tx, params);
  const parsed = CreateInboxQueueBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  const row = await createInboxQueue(tx, programmeId, parsed.data.name);
  return {
    data: {
      id: row.id,
      programmeId: row.programmeId,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
  };
}

export async function listCannedResponsesFor(tx: TenantTx, params: unknown) {
  const programmeId = programmeFromPath(tx, params);
  const rows = await listCannedResponses(tx, programmeId);
  return {
    data: rows.map((row) => ({
      id: row.id,
      programmeId: row.programmeId,
      title: row.title,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

export async function createCannedResponseFor(tx: TenantTx, params: unknown, body: unknown) {
  const programmeId = programmeFromPath(tx, params);
  const parsed = CreateCannedResponseBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  const row = await createCannedResponse(tx, programmeId, parsed.data.title, parsed.data.body);
  return {
    data: {
      id: row.id,
      programmeId: row.programmeId,
      title: row.title,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
  };
}

export async function assignConversationFor(tx: TenantTx, params: unknown, body: unknown) {
  const { conversationId } = ConversationIdParam.parse(params);
  const parsed = AssignConversationBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  const ok = await assignConversationToUser(tx, conversationId, parsed.data.userId);
  if (!ok) throw notFound();
  return getConversationFor(tx, params);
}

export async function transferConversationFor(tx: TenantTx, params: unknown, body: unknown) {
  const { conversationId } = ConversationIdParam.parse(params);
  const parsed = TransferConversationBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  const ok = await transferConversationToUser(tx, conversationId, parsed.data.targetUserId);
  if (!ok) throw notFound();
  return getConversationFor(tx, params);
}
