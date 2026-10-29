import {
  FakeChannelProvider,
  FakeDndRegister,
  NullChannelProvider,
  createChannelAdapter,
} from '@kasuwa/channel-adapter';
import type { TenantTx } from '@kasuwa/db';
import type { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { sendMessageFor } from './send-message.service';

async function outcome(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await fn();
    return { ok: true };
  } catch (error) {
    const response = (error as HttpException).getResponse();
    return typeof response === 'object' && response !== null
      ? (response as Record<string, unknown>)
      : { ok: false };
  }
}

const TENANT = '11111111-0000-4000-8000-000000000001';
const PROGRAMME = '11111111-0000-4000-8000-0000000c0001';
const CONVERSATION = '11111111-0000-4000-8000-0000001100bb';
const CONTACT = '11111111-0000-4000-8000-0000000e0001';

function fakeTx(): TenantTx {
  return {
    session: {
      tenantId: TENANT,
      userId: '11111111-0000-4000-8000-0000000d0001',
      programmeIds: [PROGRAMME],
    },
    query: async (sql: string) => {
      if (sql.includes('FROM conversation_participant')) return [];
      if (sql.includes('FROM conversation') && sql.includes('programme_id = ANY')) {
        return [
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
        ];
      }
      if (sql.includes('FROM contact')) {
        return [
          {
            id: CONTACT,
            programme_id: PROGRAMME,
            display_name: 'Test',
            given_names: null,
            family_name: null,
            company_name: null,
            phones: [{ type: 'mobile', e164: '+2348031234001' }],
            emails: [],
            account_id: null,
            owner_user_id: null,
            status: 'active',
            source: null,
            tags: [],
            preferred_language: null,
            preferred_channel: null,
            state: null,
            lga: null,
            whatsapp_opt_in: true,
            consent_state: 'unknown',
            version: 1,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) return [];
      return [];
    },
  } as unknown as TenantTx;
}

describe('sendMessageFor channel errors', () => {
  it('maps DND refusal to 403 dnd_refused', async () => {
    const provider = createChannelAdapter({
      provider: new FakeChannelProvider(),
      dnd: new FakeDndRegister(['+2348031234001']),
    });
    const dnd = new FakeDndRegister(['+2348031234001']);
    expect(
      await outcome(() =>
        sendMessageFor(
          fakeTx(),
          provider,
          dnd,
          { conversationId: CONVERSATION },
          {
            body: 'Promo',
            purpose: 'promotional',
            idempotencyKey: 'unit-dnd',
          },
        ),
      ),
    ).toMatchObject({ code: 'dnd_refused' });
  });

  it('maps null provider to 503', async () => {
    const provider = createChannelAdapter({
      provider: new NullChannelProvider(),
      dnd: new FakeDndRegister([]),
    });
    const dnd = new FakeDndRegister([]);
    expect(
      await outcome(() =>
        sendMessageFor(
          fakeTx(),
          provider,
          dnd,
          { conversationId: CONVERSATION },
          {
            body: 'Hi',
            purpose: 'transactional',
            idempotencyKey: 'unit-null',
          },
        ),
      ),
    ).toMatchObject({ code: 'service_unavailable' });
  });
});
