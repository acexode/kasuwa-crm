import { z } from 'zod';

export const ProgrammeIdParam = z.object({ programmeId: z.uuid() });

export const ConversationIdParam = z.object({ conversationId: z.uuid() });
