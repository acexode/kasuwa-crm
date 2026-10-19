import type { TenantTx } from '@kasuwa/db';
import {
  actorKey,
  findOwnNotification,
  listNotificationRows,
  listUnreadWindow,
  markNotificationsRead,
  NOTIFICATION_COUNT_CAP,
  notificationObjectKey,
  ownNotificationExists,
  resolveNotificationActors,
  resolveNotificationObjects,
  setNotificationRead,
  type NotificationRecord,
} from '@kasuwa/domain-core';
import { notFound, validationFailed } from '../admin/common/admin-errors';
import {
  ListNotificationsQuery,
  MarkAllNotificationsReadBody,
  NotificationIdParam,
  UpdateNotificationBody,
} from './notifications.schemas';

/**
 * The notifications API (T-0100; records.openapi.yaml `notifications`; D-P29,
 * D-L154, D-L157), over the caller's own rows in ONE tenant transaction.
 * Scope is `tx.session`'s, and a notification is the RECIPIENT's alone: the
 * database's restrictive policy and every statement's explicit recipient
 * filter agree on that, so there is no 403 anywhere, only the one 404.
 *
 * NOTHING STORED IS A NAME. The names here are read NOW, under the caller's
 * scope and field security (domain-core `resolveNotificationObjects`):
 *   - an item whose object the caller can no longer read is DROPPED, never
 *     sent with its names set to null;
 *   - a name field the caller's set withholds is `objectDisplayName: null`;
 *   - the actor is named only while still a member of the object's programme.
 * Nothing here logs a name, an id or a count.
 */

export interface NotificationWire {
  id: string;
  kind: string;
  objectType: string;
  objectId: string;
  actor: { id: string; displayName: string | null };
  objectDisplayName: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationUnreadCountWire {
  count: number;
  capped: boolean;
}

/**
 * The wire items for `records`, in order, dropping those whose object the
 * caller cannot read now. `visible` (when given) is the resolved objects map
 * already in hand.
 */
async function toWires(
  tx: TenantTx,
  records: readonly NotificationRecord[],
): Promise<NotificationWire[]> {
  const objects = await resolveNotificationObjects(tx, records);
  const shown = records.filter((record) =>
    objects.has(notificationObjectKey(record.objectType, record.objectId)),
  );
  const actors = await resolveNotificationActors(tx, shown);
  return shown.map((record) => ({
    id: record.id,
    kind: record.kind,
    objectType: record.objectType,
    objectId: record.objectId,
    actor: {
      id: record.actorUserId,
      displayName: actors.get(actorKey(record.actorUserId, record.programmeId)) ?? null,
    },
    objectDisplayName:
      objects.get(notificationObjectKey(record.objectType, record.objectId)) ?? null,
    createdAt: record.createdAt.toISOString(),
    readAt: record.readAt === null ? null : record.readAt.toISOString(),
  }));
}

/** listNotifications. Examines at most `limit` rows; the page may be short or empty. */
export async function listNotificationsFor(
  tx: TenantTx,
  rawQuery: unknown,
): Promise<{ data: NotificationWire[]; nextCursor: string | null }> {
  const query = ListNotificationsQuery.parse(rawQuery); // 400
  const page = await listNotificationRows(tx, {
    limit: query.limit,
    unreadOnly: query.filter === 'unread',
    ...(query.kind === undefined ? {} : { kind: query.kind }),
    ...(query.cursor === undefined ? {} : { cursorId: query.cursor }),
  });
  return { data: await toWires(tx, page.rows), nextCursor: page.nextCursor };
}

/**
 * The count of visible unread, over the newest NOTIFICATION_UNREAD_WINDOW
 * unread only, capped at 99 (D-L157). May undercount past the window.
 */
export async function unreadCountFor(tx: TenantTx): Promise<NotificationUnreadCountWire> {
  const window = await listUnreadWindow(tx);
  const objects = await resolveNotificationObjects(tx, window);
  const visible = window.filter((record) =>
    objects.has(notificationObjectKey(record.objectType, record.objectId)),
  ).length;
  return visible > NOTIFICATION_COUNT_CAP
    ? { count: NOTIFICATION_COUNT_CAP, capped: true }
    : { count: visible, capped: false };
}

/**
 * updateNotification. ONE 404 for none, another user's, another tenant's and
 * one whose object the caller can no longer read: the object is judged BEFORE
 * anything is written, so a 404 changes nothing.
 */
export async function updateNotificationFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<NotificationWire> {
  const { notificationId } = NotificationIdParam.parse(params); // 400
  const { read } = UpdateNotificationBody.parse(body); // 400
  const found = await findOwnNotification(tx, notificationId);
  if (found === null) throw notFound();
  const objects = await resolveNotificationObjects(tx, [found]);
  if (!objects.has(notificationObjectKey(found.objectType, found.objectId))) throw notFound();
  const updated = await setNotificationRead(tx, notificationId, read);
  if (updated === null) throw notFound();
  const [wire] = await toWires(tx, [updated]);
  if (wire === undefined) throw notFound();
  return wire;
}

/**
 * markAllNotificationsRead. The answer is the new visible unread count, never
 * how many rows changed (which would count invisible items). A `throughId`
 * that is not the caller's own notification is `400 invalid_value`, one body
 * for unknown, a colleague's and another tenant's: it never says whether the
 * id exists.
 */
export async function markAllReadFor(
  tx: TenantTx,
  body: unknown,
): Promise<NotificationUnreadCountWire> {
  const parsed = MarkAllNotificationsReadBody.parse(body); // 400
  if (parsed.throughId !== undefined && !(await ownNotificationExists(tx, parsed.throughId))) {
    throw validationFailed([{ path: 'throughId', code: 'invalid_value' }]);
  }
  await markNotificationsRead(tx, {
    ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
    ...(parsed.throughId === undefined ? {} : { throughId: parsed.throughId }),
  });
  return unreadCountFor(tx);
}
