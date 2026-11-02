import { z } from 'zod';

export const ProgrammeIdParam = z.object({ programmeId: z.uuid() });

export const ConversationIdParam = z.object({ conversationId: z.uuid() });

export const SendMessageBody = z
  .strictObject({
    body: z.string().min(1).max(4096).optional(),
    messageTemplateId: z.uuid().optional(),
    purpose: z.enum(['transactional', 'promotional']),
    idempotencyKey: z.string().min(1).max(128),
  })
  .superRefine((value, ctx) => {
    if (value.body === undefined && value.messageTemplateId === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'body or messageTemplateId required',
        path: ['body'],
      });
    }
  });

export const CreateMessageTemplateBody = z.strictObject({
  name: z.string().min(1).max(128),
  channel: z.enum(['sms', 'whatsapp', 'email']),
  category: z.enum(['utility', 'marketing', 'authentication', 'service']),
  body: z.string().min(1).max(4096),
});

export const CreateInboxQueueBody = z.strictObject({
  name: z.string().min(1).max(128),
});

export const CreateCannedResponseBody = z.strictObject({
  title: z.string().min(1).max(128),
  body: z.string().min(1).max(4096),
});

export const AssignConversationBody = z.strictObject({
  userId: z.uuid(),
});

export const TransferConversationBody = z.strictObject({
  targetUserId: z.uuid(),
});
