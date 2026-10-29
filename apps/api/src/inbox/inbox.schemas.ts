import { z } from 'zod';

export const ProgrammeIdParam = z.object({ programmeId: z.uuid() });

export const ConversationIdParam = z.object({ conversationId: z.uuid() });

export const SendMessageBody = z.strictObject({
  body: z.string().min(1).max(4096),
  purpose: z.enum(['transactional', 'promotional']),
  idempotencyKey: z.string().min(1).max(128),
});
