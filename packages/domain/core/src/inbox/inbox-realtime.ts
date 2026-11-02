import { randomUUID } from 'node:crypto';
import {
  appendOutboxEvent,
  InboxMessagePersistedPayload,
  type OutboxHandler,
  type TenantTx,
} from '@kasuwa/db';
import {
  handleNotificationEvent,
  type NotificationHandling,
} from '../notification/notification-handler';

/** The same schema object the outbox registry parses. One schema, not two. */
export { InboxMessagePersistedPayload };

export const INBOX_MESSAGE_PERSISTED = 'inbox.message_persisted';

/** Redis channel `apps/realtime` already subscribes to (ADR-0020). Not a second bus. */
export const INBOX_REALTIME_CHANNEL = 'kasuwa.realtime.events';

export interface InboxMessageRef {
  readonly programmeId: string;
  readonly conversationId: string;
  readonly messageId: string;
}

export interface InboxMessagePersistedEvent {
  readonly eventType: typeof INBOX_MESSAGE_PERSISTED;
  readonly aggregateType: 'message';
  readonly aggregateId: string;
  readonly payload: {
    readonly tenantId: string;
    readonly programmeId: string;
    readonly conversationId: string;
    readonly messageId: string;
  };
}

/** Ids only. The tenant is the session's when this is appended, never a caller's. */
export function inboxMessagePersistedEvent(
  message: InboxMessageRef & { readonly tenantId: string },
): InboxMessagePersistedEvent {
  return {
    eventType: INBOX_MESSAGE_PERSISTED,
    aggregateType: 'message',
    aggregateId: message.messageId,
    payload: {
      tenantId: message.tenantId,
      programmeId: message.programmeId,
      conversationId: message.conversationId,
      messageId: message.messageId,
    },
  };
}

/**
 * Appends `inbox.message_persisted` on the caller's tenant transaction, after
 * the message row is locked by its INSERT. The payload is the four ids.
 */
export async function appendInboxMessagePersisted(
  tx: TenantTx,
  message: InboxMessageRef,
): Promise<void> {
  const event = inboxMessagePersistedEvent({
    tenantId: tx.session.tenantId,
    programmeId: message.programmeId,
    conversationId: message.conversationId,
    messageId: message.messageId,
  });
  await appendOutboxEvent(tx, {
    id: randomUUID(),
    eventType: event.eventType,
    programmeId: message.programmeId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: event.payload,
  });
}

/** What the realtime channel carries: conversation id, then message id. No tenant in the socket frame. */
export interface InboxRealtimePublication {
  readonly tenantId: string;
  readonly programmeId: string;
  readonly type: typeof INBOX_MESSAGE_PERSISTED;
  readonly ids: readonly [string, string];
}

/**
 * The publication for a re-read message, or null. The payload's ids must match
 * the outbox row and the message's conversation. A body, phone or email does
 * not parse, so it cannot be published.
 */
export function inboxRealtimePublication(
  event: {
    readonly tenantId: string;
    readonly programmeId: string;
    readonly eventType: string;
    readonly aggregateId: string;
    readonly payload: unknown;
  },
  message: { readonly conversationId: string } | null,
): InboxRealtimePublication | null {
  if (event.eventType !== INBOX_MESSAGE_PERSISTED) return null;
  const parsed = InboxMessagePersistedPayload.safeParse(event.payload);
  if (!parsed.success) return null;
  const payload = parsed.data;
  if (payload.messageId !== event.aggregateId.toLowerCase()) return null;
  if (payload.tenantId !== event.tenantId.toLowerCase()) return null;
  if (payload.programmeId !== event.programmeId.toLowerCase()) return null;
  if (message === null) return null;
  if (message.conversationId.toLowerCase() !== payload.conversationId) return null;
  return {
    tenantId: payload.tenantId,
    programmeId: payload.programmeId,
    type: INBOX_MESSAGE_PERSISTED,
    ids: [payload.conversationId, payload.messageId],
  };
}

/** The Redis message: the four fields the hub parses, and nothing else. */
export function serialiseInboxRealtimeEvent(event: InboxRealtimePublication): string {
  return JSON.stringify({
    tenantId: event.tenantId,
    programmeId: event.programmeId,
    type: event.type,
    ids: [event.ids[0], event.ids[1]],
  });
}

export interface InboxRealtimePublisher {
  publish(body: string): Promise<void>;
}

export type InboxRealtimeHandling = 'published' | 'skipped';

/**
 * Confirms the message still exists in the event's programme, then publishes
 * ids only. Delivery is at-least-once: a second publish names the same ids.
 */
export function handleInboxMessagePersisted(
  publisher: InboxRealtimePublisher,
): OutboxHandler<InboxRealtimeHandling> {
  return async (tx, event) => {
    if (event.eventType !== INBOX_MESSAGE_PERSISTED) return 'skipped';
    if (event.tenantId !== tx.session.tenantId) return 'skipped';
    if (!tx.session.programmeIds.includes(event.programmeId)) return 'skipped';
    // tenancy-reviewed: tenant from the session; the programme is the event's,
    // one the session reaches. The message body is not selected.
    const rows = await tx.query<{ conversation_id: string }>(
      `SELECT conversation_id
         FROM message
        WHERE id = $1::uuid
          AND tenant_id = $2::uuid
          AND programme_id = $3::uuid`,
      [event.aggregateId, tx.session.tenantId, event.programmeId],
    );
    const row = rows[0];
    const publication = inboxRealtimePublication(
      event,
      row === undefined ? null : { conversationId: row.conversation_id },
    );
    if (publication === null) return 'skipped';
    await publisher.publish(serialiseInboxRealtimeEvent(publication));
    return 'published';
  };
}

/**
 * The consumer on the existing notifications queue. Inbox messages are
 * published to realtime; every other type stays with the notifications handler.
 */
export function handleRelayedOutboxEvent(
  publisher: InboxRealtimePublisher,
): OutboxHandler<InboxRealtimeHandling | NotificationHandling> {
  const inbox = handleInboxMessagePersisted(publisher);
  return (tx, event) =>
    event.eventType === INBOX_MESSAGE_PERSISTED
      ? inbox(tx, event)
      : handleNotificationEvent(tx, event);
}
