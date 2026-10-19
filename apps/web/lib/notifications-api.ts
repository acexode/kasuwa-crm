import { z } from 'zod';
import { requestRecords, type RecordsResult } from './records-api';

/**
 * The browser's half of the notifications tag in
 * `docs/api/records.openapi.yaml` (T-0099, served by T-0100): listNotifications,
 * getNotificationUnreadCount, markAllNotificationsRead and updateNotification,
 * for the P26 bell and centre (T-0101).
 *
 * SAME-ORIGIN, RELATIVE PATHS, through `requestRecords`: never from or into the
 * HTTP cache (names of people at a URL that is the same for every user), no
 * header argument, and NO SCOPE ARGUMENT. The session says who the reader is;
 * the API says what they reach (CLAUDE.md section 2, rule 2).
 *
 * TOLERANT OF WHAT THE CONTRACT SAYS WILL GROW. A kind this client does not
 * know is ignored, not a failure of the page (D-L87); an item that does not
 * parse is dropped and the rest kept. An `objectId` is read as a string and
 * linked only when it is a well-formed uuid (`notificationHref`).
 *
 * NOTHING IS KEPT ON THE DEVICE (D-P21): no module state here holds a name.
 */

export const NOTIFICATION_KINDS = ['record_assigned', 'task_assigned', 'import_finished'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_OBJECT_TYPES = ['contact', 'account', 'deal', 'activity', 'import'] as const;
export type NotificationObjectType = (typeof NOTIFICATION_OBJECT_TYPES)[number];

/** `x-kasuwa-notification-kinds`: the kind fixes the object type. */
export const KIND_OBJECT_TYPES: Readonly<Record<NotificationKind, readonly NotificationObjectType[]>> = {
  record_assigned: ['contact', 'account', 'deal'],
  task_assigned: ['activity'],
  import_finished: ['import'],
};

export const NOTIFICATION_LIMIT_MAX = 100;

export type NotificationFilter = 'all' | 'unread';

export interface NotificationItem {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly objectType: NotificationObjectType;
  readonly objectId: string;
  /** `null` when withheld or a former member: a generic sentence, never a stand-in. */
  readonly actorName: string | null;
  readonly objectName: string | null;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export interface NotificationPage {
  readonly items: readonly NotificationItem[];
  /** Opaque, echoed back exactly as served. `null` is the end, and only `null`. */
  readonly nextCursor: string | null;
  /** The newest notification the server SERVED (drawn or not): what a mark-all is bounded by (D-L154). */
  readonly headId: string | null;
}

export interface UnreadCount {
  readonly count: number;
  readonly capped: boolean;
}

export interface NotificationQuery {
  readonly filter?: NotificationFilter;
  readonly kind?: NotificationKind;
  readonly cursor?: string;
  readonly limit?: number;
}

const RawItem = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  objectType: z.string(),
  objectId: z.string(),
  actor: z.object({ displayName: z.string().nullable() }),
  objectDisplayName: z.string().nullable(),
  createdAt: z.string().datetime(),
  readAt: z.string().datetime().nullable(),
});

const Head = z.object({ id: z.string().uuid() });

const RawPage = z.object({
  data: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
});

const CountAnswer = z.object({
  count: z.number().int().min(0).max(99),
  capped: z.boolean(),
});

const UpdateAnswer = z.object({
  id: z.string().uuid(),
  readAt: z.string().datetime().nullable(),
});

export function isKind(value: string): value is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

/** One served item, or `null` when it is a kind or a kind/object pair this client does not know. */
export function toItem(raw: unknown): NotificationItem | null {
  const parsed = RawItem.safeParse(raw);
  if (!parsed.success) return null;
  const { kind, objectType } = parsed.data;
  if (!isKind(kind)) return null;
  const types: readonly string[] = KIND_OBJECT_TYPES[kind];
  if (!types.includes(objectType)) return null;
  return {
    id: parsed.data.id,
    kind,
    objectType: objectType as NotificationObjectType,
    objectId: parsed.data.objectId,
    actorName: parsed.data.actor.displayName,
    objectName: parsed.data.objectDisplayName,
    createdAt: parsed.data.createdAt,
    readAt: parsed.data.readAt,
  };
}

const PageAnswer = RawPage.transform((page): NotificationPage => {
  const head = page.data.map((row) => Head.safeParse(row)).find((result) => result.success);
  return {
    items: page.data.map(toItem).filter((item): item is NotificationItem => item !== null),
    nextCursor: page.nextCursor,
    headId: head?.success === true ? head.data.id : null,
  };
});

/** The query string for `listNotifications`: declared parameters only, `kind` once. */
export function notificationSearch(query: NotificationQuery): string {
  const params = new URLSearchParams();
  if (query.filter === 'unread') params.set('filter', 'unread');
  if (query.kind !== undefined) params.set('kind', query.kind);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(Math.min(NOTIFICATION_LIMIT_MAX, Math.max(1, query.limit))));
  const search = params.toString();
  return search === '' ? '' : `?${search}`;
}

export function listNotifications(query: NotificationQuery, signal?: AbortSignal): Promise<RecordsResult<NotificationPage>> {
  return requestRecords(`/api/v1/notifications${notificationSearch(query)}`, PageAnswer, {
    method: 'GET',
    readBareThrottle: true,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function getUnreadCount(signal?: AbortSignal): Promise<RecordsResult<UnreadCount>> {
  return requestRecords('/api/v1/notifications/unread-count', CountAnswer, {
    method: 'GET',
    readBareThrottle: true,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Always bounded: without `throughId` an arrival after the reader looked would be marked read too (D-L154). */
export function markAllRead(body: { readonly throughId: string; readonly kind?: NotificationKind }, signal?: AbortSignal): Promise<RecordsResult<UnreadCount>> {
  return requestRecords('/api/v1/notifications/read-all', CountAnswer, {
    method: 'POST',
    readBareThrottle: true,
    body: body.kind === undefined ? { throughId: body.throughId } : { kind: body.kind, throughId: body.throughId },
    ...(signal === undefined ? {} : { signal }),
  });
}

export function updateNotification(id: string, read: boolean, signal?: AbortSignal): Promise<RecordsResult<{ id: string; readAt: string | null }>> {
  return requestRecords(`/api/v1/notifications/${encodeURIComponent(id)}`, UpdateAnswer, {
    method: 'PATCH',
    readBareThrottle: true,
    body: { read },
    ...(signal === undefined ? {} : { signal }),
  });
}
