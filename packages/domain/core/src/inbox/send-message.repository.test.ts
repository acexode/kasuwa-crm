import type { TenantTx } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import {
  ConversationMissingDestinationError,
  recordOutboundMessage,
  resolveConversationDestination,
} from './send-message.repository';

const TENANT = '11111111-0000-4000-8000-000000000001';
const PROGRAMME = '11111111-0000-4000-8000-0000000c0001';
const CONVERSATION = '11111111-0000-4000-8000-0000001100bb';
const CONTACT = '11111111-0000-4000-8000-0000000e0001';

function fakeTx() {
  const inserts: string[] = [];
  const tx = {
    session: { tenantId: TENANT, userId: '11111111-0000-4000-8000-0000000d0001', programmeIds: [PROGRAMME] },
    query: (sql: string): Promise<unknown[]> => {
      if (sql.includes('FROM conversation_participant')) return Promise.resolve([]);
      if (sql.includes('FROM conversation') && sql.includes('programme_id = ANY')) {
        return Promise.resolve([
          {
            id: CONVERSATION,
            programme_id: PROGRAMME,
            contact_id: CONTACT,
            channel: 'whatsapp',
            status: 'open',
            subject: null,
            last_message_at: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ]);
      }
      if (sql.includes('FROM contact')) {
        return Promise.resolve([
          {
            phones: [{ type: 'mobile', e164: '+2348031234001' }],
            emails: [],
          },
        ]);
      }
      if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) {
        inserts.push(sql);
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    },
  } as unknown as TenantTx;
  return { tx, inserts };
}

describe('resolveConversationDestination', () => {
  it('returns E.164 for whatsapp conversations', async () => {
    const { tx } = fakeTx();
    const dest = await resolveConversationDestination(tx, CONVERSATION);
    expect(dest).toEqual({
      programmeId: PROGRAMME,
      channel: 'whatsapp',
      to: '+2348031234001',
    });
  });
});

describe('recordOutboundMessage', () => {
  it('writes message and delivery rows', async () => {
    const { tx, inserts } = fakeTx();
    const result = await recordOutboundMessage(
      tx,
      CONVERSATION,
      { body: 'Hello there', purpose: 'transactional' },
      'fake-msg-1',
      'queued',
    );
    expect(result?.message.direction).toBe('outbound');
    expect(result?.delivery.state).toBe('queued');
    expect(inserts.filter((s) => /^INSERT INTO message\s/m.test(s))).toHaveLength(1);
    expect(inserts.filter((s) => s.includes('INSERT INTO message_delivery'))).toHaveLength(1);
  });
});

describe('ConversationMissingDestinationError', () => {
  it('is thrown when the contact has no phone for SMS/WhatsApp', async () => {
    const tx = {
      session: { tenantId: TENANT, userId: 'u', programmeIds: [PROGRAMME] },
      query: (sql: string): Promise<unknown[]> => {
        if (sql.includes('FROM conversation_participant')) return Promise.resolve([]);
        if (sql.includes('FROM conversation')) {
          return Promise.resolve([
            {
              id: CONVERSATION,
              programme_id: PROGRAMME,
              contact_id: CONTACT,
              channel: 'sms',
              status: 'open',
              subject: null,
              last_message_at: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ]);
        }
        if (sql.includes('FROM contact')) {
          return Promise.resolve([{ phones: [], emails: [] }]);
        }
        return Promise.resolve([]);
      },
    } as unknown as TenantTx;
    await expect(resolveConversationDestination(tx, CONVERSATION)).rejects.toBeInstanceOf(
      ConversationMissingDestinationError,
    );
  });
});
