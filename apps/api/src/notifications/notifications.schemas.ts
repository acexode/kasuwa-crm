import {
  NOTIFICATION_DEFAULT_PAGE,
  NOTIFICATION_KINDS,
  NOTIFICATION_MAX_PAGE,
  type NotificationKind,
} from '@kasuwa/domain-core';
import { z } from 'zod';

/**
 * Boundary schemas for the notifications API (records.openapi.yaml,
 * `notifications` tag, T-0099's contract). Details carry a path and a reason
 * code only, never the submitted value (the contract's `invalid_value`,
 * `invalid_cursor`). The 429 is decided before any of this runs.
 */

const reason = (ctx: z.RefinementCtx, code: string): void =>
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid', params: { reason: code } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DIGITS = /^[0-9]{1,6}$/u;

/** `filter`: `all` (default) or `unread`. Anything else, an array included, is `invalid_value`. */
const FilterParam = z.unknown().transform((value, ctx): 'all' | 'unread' => {
  if (value === undefined) return 'all';
  if (value === 'all' || value === 'unread') return value;
  reason(ctx, 'invalid_value');
  return z.NEVER;
});

const KindParam = z.unknown().transform((value, ctx): NotificationKind | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value)) {
    return value as NotificationKind;
  }
  reason(ctx, 'invalid_value');
  return z.NEVER;
});

/** A cursor is a notification id and nothing else; anything else is `invalid_cursor`. */
const CursorParam = z.unknown().transform((value, ctx): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && UUID.test(value)) return value.toLowerCase();
  reason(ctx, 'invalid_cursor');
  return z.NEVER;
});

/** 1..100, never clamped. */
const LimitParam = z.unknown().transform((value, ctx): number => {
  if (value === undefined) return NOTIFICATION_DEFAULT_PAGE;
  if (typeof value !== 'string' || !DIGITS.test(value)) {
    reason(ctx, 'invalid_value');
    return z.NEVER;
  }
  const limit = Number(value);
  if (limit < 1 || limit > NOTIFICATION_MAX_PAGE) {
    reason(ctx, 'out_of_range');
    return z.NEVER;
  }
  return limit;
});

/** Unknown query parameters are ignored, never honoured. */
export const ListNotificationsQuery = z.object({
  filter: FilterParam,
  kind: KindParam,
  cursor: CursorParam,
  limit: LimitParam,
});
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuery>;

export const NotificationIdParam = z.object({ notificationId: z.string().uuid() });

/** `{ read: boolean }`, closed: a recipient, a time or anything else is 400. */
export const UpdateNotificationBody = z.object({ read: z.boolean() }).strict();

/**
 * `{}`, `{ kind }`, `{ throughId }`. A `throughId` that is not a uuid is the
 * same `invalid_value` at `throughId` as one that names nothing of the
 * caller's (the service), so the answer never says whether an id exists.
 */
export const MarkAllNotificationsReadBody = z
  .object({
    kind: z
      .unknown()
      .transform((value, ctx): NotificationKind | undefined => {
        if (value === undefined) return undefined;
        if (typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value)) {
          return value as NotificationKind;
        }
        reason(ctx, 'invalid_value');
        return z.NEVER;
      }),
    throughId: z.unknown().transform((value, ctx): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value === 'string' && UUID.test(value)) return value.toLowerCase();
      reason(ctx, 'invalid_value');
      return z.NEVER;
    }),
  })
  .strict();
export type MarkAllNotificationsReadBody = z.infer<typeof MarkAllNotificationsReadBody>;
