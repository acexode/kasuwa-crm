import type { TenantTx } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import {
  ConversationProgrammeOutOfScopeError,
  findConversationById,
  listConversations,
  listMessages,
} from './conversations.repository';

const TENANT = '11111111-0000-4000-8000-000000000001';
const PROGRAMME = '11111111-0000-4000-8000-0000000c0001';
const OTHER_PROGRAMME = '11111111-0000-4000-8000-0000000c0002';
const CONVERSATION = '11111111-0000-4000-8000-0000001100bb';

function fakeTx(programmeIds: string[] = [PROGRAMME]) {
  const tx = {
    session: { tenantId: TENANT, userId: 'u', programmeIds },
    query: (sql: string, params: unknown[] = []): Promise<unknown[]> => {
      const conversationRow = {
        id: CONVERSATION,
        programme_id: PROGRAMME,
        contact_id: '11111111-0000-4000-8000-0000000e0001',
        channel: 'whatsapp',
        status: 'open',
        subject: null,
        last_message_at: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
      };
      if (sql.includes('FROM conversation_participant')) {
        return Promise.resolve([
          {
            id: '11111111-0000-4000-8000-0000001100bd',
            conversation_id: CONVERSATION,
            user_id: '11111111-0000-4000-8000-000000030001',
            role: 'assignee',
          },
        ]);
      }
      if (sql.includes('FROM message')) {
        return Promise.resolve([
          {
            id: '11111111-0000-4000-8000-0000001100bc',
            programme_id: PROGRAMME,
            conversation_id: CONVERSATION,
            direction: 'inbound',
            body_redacted: 'hello',
            provider_message_id: null,
            sent_by_user_id: null,
            created_at: new Date('2026-01-02T00:00:00.000Z'),
            updated_at: new Date('2026-01-02T00:00:00.000Z'),
          },
        ]);
      }
      if (sql.includes('FROM conversation')) {
        if (sql.includes('programme_id = ANY')) {
          if (params[1] !== CONVERSATION) return Promise.resolve([]);
          return Promise.resolve([conversationRow]);
        }
        return Promise.resolve([conversationRow]);
      }
      return Promise.resolve([]);
    },
  } as unknown as TenantTx;
  return tx;
}

describe('listConversations', () => {
  it('returns rows for an in-scope programme', async () => {
    const rows = await listConversations(fakeTx(), PROGRAMME);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.participants).toHaveLength(1);
  });

  it('throws when the programme is outside session scope', async () => {
    await expect(listConversations(fakeTx(), OTHER_PROGRAMME)).rejects.toBeInstanceOf(
      ConversationProgrammeOutOfScopeError,
    );
  });
});

describe('findConversationById', () => {
  it('returns null when the id is missing', async () => {
    expect(await findConversationById(fakeTx(), '00000000-0000-4000-8000-000000000099')).toBeNull();
  });
});

describe('listMessages', () => {
  it('returns null when the conversation is out of scope', async () => {
    expect(await listMessages(fakeTx(), '00000000-0000-4000-8000-000000000099')).toBeNull();
  });

  it('returns messages in thread order', async () => {
    const rows = await listMessages(fakeTx(), CONVERSATION);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.bodyRedacted).toBe('hello');
  });
});
