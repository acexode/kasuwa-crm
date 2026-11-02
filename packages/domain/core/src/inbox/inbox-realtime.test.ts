import {
  InboxMessagePersistedPayload,
  OUTBOX_QUEUES,
  outboxEventDefinition,
  type ConsumedOutboxEvent,
  type TenantTx,
} from '@kasuwa/db';
import { describe, expect, it, vi } from 'vitest';
import {
  handleInboxMessagePersisted,
  handleRelayedOutboxEvent,
  INBOX_MESSAGE_PERSISTED,
  INBOX_REALTIME_CHANNEL,
  inboxMessagePersistedEvent,
  inboxRealtimePublication,
  serialiseInboxRealtimeEvent,
  type InboxRealtimePublisher,
} from './inbox-realtime';

const TENANT = '11111111-0000-4000-8000-000000191001';
const PROGRAMME = '11111111-0000-4000-8000-000000191002';
const CONVERSATION = '11111111-0000-4000-8000-000000191003';
const MESSAGE = '11111111-0000-4000-8000-000000191004';
const ACTOR = '11111111-0000-4000-8000-000000191005';

const payload = {
  tenantId: TENANT,
  programmeId: PROGRAMME,
  conversationId: CONVERSATION,
  messageId: MESSAGE,
};

function event(over: Partial<ConsumedOutboxEvent> = {}): ConsumedOutboxEvent {
  return {
    id: '11111111-0000-4000-8000-000000191006',
    tenantId: TENANT,
    programmeId: PROGRAMME,
    actorUserId: ACTOR,
    eventType: INBOX_MESSAGE_PERSISTED,
    schemaVersion: 1,
    aggregateType: 'message',
    aggregateId: MESSAGE,
    payload,
    createdAt: '2026-11-02T12:00:00.000Z',
    ...over,
  };
}

describe('inbox message persisted payload (T-0191)', () => {
  it('is the registry schema, on the existing notifications queue, about the message', () => {
    expect(InboxMessagePersistedPayload).toBe(
      outboxEventDefinition(INBOX_MESSAGE_PERSISTED)?.schema,
    );
    expect(outboxEventDefinition(INBOX_MESSAGE_PERSISTED)).toMatchObject({
      aggregateType: 'message',
      aggregateKey: 'messageId',
      queue: OUTBOX_QUEUES.notifications,
      schemaVersion: 1,
    });
    expect(INBOX_REALTIME_CHANNEL).toBe('kasuwa.realtime.events');
  });

  it('carries the four ids and rejects a body, a phone and an email', () => {
    expect(inboxMessagePersistedEvent({ ...payload }).payload).toEqual(payload);
    expect(Object.keys(inboxMessagePersistedEvent({ ...payload }).payload).sort()).toEqual([
      'conversationId',
      'messageId',
      'programmeId',
      'tenantId',
    ]);
    expect(InboxMessagePersistedPayload.safeParse(payload).success).toBe(true);
    for (const extra of [
      { body: 'Hello there' },
      { bodyRedacted: 'Hello' },
      { phone: '+2348031234001' },
      { email: 'person@example.com' },
    ]) {
      expect(InboxMessagePersistedPayload.safeParse({ ...payload, ...extra }).success).toBe(false);
    }
    expect(InboxMessagePersistedPayload.safeParse({ ...payload, messageId: 'not-a-uuid' }).success).toBe(
      false,
    );
  });

  it('lower-cases ids so they match the outbox row', () => {
    expect(
      InboxMessagePersistedPayload.parse({
        tenantId: TENANT.toUpperCase(),
        programmeId: PROGRAMME.toUpperCase(),
        conversationId: CONVERSATION.toUpperCase(),
        messageId: MESSAGE.toUpperCase(),
      }),
    ).toEqual(payload);
  });

  it('publishes the row ids only when the message conversation matches', () => {
    const publication = inboxRealtimePublication(event(), { conversationId: CONVERSATION });
    expect(publication).toEqual({
      tenantId: TENANT,
      programmeId: PROGRAMME,
      type: INBOX_MESSAGE_PERSISTED,
      ids: [CONVERSATION, MESSAGE],
    });
    if (publication === null) return;
    const raw = JSON.parse(serialiseInboxRealtimeEvent(publication)) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['ids', 'programmeId', 'tenantId', 'type']);
    expect(raw.ids).toEqual([CONVERSATION, MESSAGE]);
    expect(JSON.stringify(raw)).not.toMatch(/body|phone|email|\+234/iu);
  });

  it('drops a mismatched conversation, a foreign tenant and a free-text payload', () => {
    expect(inboxRealtimePublication(event(), { conversationId: ACTOR })).toBeNull();
    expect(inboxRealtimePublication(event({ tenantId: ACTOR }), { conversationId: CONVERSATION })).toBeNull();
    expect(
      inboxRealtimePublication(event({ payload: { ...payload, email: 'a@b.c' } }), {
        conversationId: CONVERSATION,
      }),
    ).toBeNull();
    expect(inboxRealtimePublication(event(), null)).toBeNull();
  });
});

describe('handleInboxMessagePersisted', () => {
  function fakeTx(conversationId: string | null): { tx: TenantTx; sql: string[] } {
    const sql: string[] = [];
    const tx = {
      session: { tenantId: TENANT, userId: ACTOR, programmeIds: [PROGRAMME] },
      query: (statement: string): Promise<{ conversation_id: string }[]> => {
        sql.push(statement);
        return Promise.resolve(conversationId === null ? [] : [{ conversation_id: conversationId }]);
      },
    } as unknown as TenantTx;
    return { tx, sql };
  }

  it('publishes ids only, and the read does not select the body', async () => {
    const { tx, sql } = fakeTx(CONVERSATION);
    const publish = vi.fn(async (_body: string) => undefined);
    const publisher: InboxRealtimePublisher = { publish };
    await expect(handleInboxMessagePersisted(publisher)(tx, event())).resolves.toBe('published');
    expect(sql.some((statement) => statement.includes('body'))).toBe(false);
    const sent = publish.mock.calls[0]?.[0];
    expect(sent).toBeTypeOf('string');
    const body = JSON.parse(sent ?? '') as Record<string, unknown>;
    expect(body).toEqual({
      tenantId: TENANT,
      programmeId: PROGRAMME,
      type: INBOX_MESSAGE_PERSISTED,
      ids: [CONVERSATION, MESSAGE],
    });
  });

  it('publishes nothing when the message is gone', async () => {
    const { tx } = fakeTx(null);
    const publish = vi.fn(async (_body: string) => undefined);
    const stderr: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(
        handleInboxMessagePersisted({ publish })(tx, event()),
      ).resolves.toBe('skipped');
    } finally {
      process.stderr.write = write;
    }
    expect(publish).not.toHaveBeenCalled();
    expect(stderr.join('')).toBe('inbox.message_persisted skipped (ids_disagree)\n');
  });

  it('logs programme_out_of_reach without ids when the session cannot reach it', async () => {
    const { tx } = fakeTx(CONVERSATION);
    tx.session.programmeIds = ['11111111-0000-4000-8000-0000000c0099'];
    const publish = vi.fn(async (_body: string) => undefined);
    const stderr: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(
        handleInboxMessagePersisted({ publish })(tx, event()),
      ).resolves.toBe('skipped');
    } finally {
      process.stderr.write = write;
    }
    expect(publish).not.toHaveBeenCalled();
    expect(stderr.join('')).toBe(
      'inbox.message_persisted skipped (programme_out_of_reach)\n',
    );
    expect(stderr.join('')).not.toMatch(/11111111|000000/);
  });

  it('leaves other event types on the notifications handler and does not publish them', async () => {
    const { tx } = fakeTx(null);
    const publish = vi.fn(async (_body: string) => undefined);
    await expect(
      handleRelayedOutboxEvent({ publish })(
        tx,
        event({
          eventType: 'contact.owner_changed',
          aggregateType: 'contact',
          payload: { contactId: MESSAGE, previousOwnerId: null, newOwnerId: ACTOR },
        }),
      ),
    ).resolves.toBe('skipped');
    expect(publish).not.toHaveBeenCalled();
  });
});
