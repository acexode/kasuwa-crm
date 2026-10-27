import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@kasuwa/domain-core';
import { z } from 'zod';
import { UtcDateTime } from './activities.schemas';
import { ACTIVITY_BUCKETS, isIanaTimeZone } from './activity-buckets';

/**
 * Query schemas for listMyActivities and listCalendar (T-0082), transcribed
 * from docs/api/records.openapi.yaml. Parse, never cast (CLAUDE.md 4).
 *
 * NOT strict, as every records list (accounts.schemas.ts): an unknown query
 * parameter is ignored, never honoured. Neither list has an owner, user or
 * programme parameter, so `?ownerUserId=` or `?programmeId=` can neither
 * widen nor narrow anything. A repeated parameter arrives as an array and is
 * 400 (`invalid_type`).
 *
 * `cursor` is only a string here; whatever is wrong with it (length,
 * encoding, the row it names) is the ONE `invalid_cursor` body, decided by the
 * service, so the limits of the contract's `ActivityCursor` never surface as
 * a different code.
 *
 * No error detail ever carries the submitted value (admin-errors.ts): a
 * refused `timeZone` is `invalid_time_zone` at `timeZone`, whatever it was.
 */

const limit = z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE);
const cursor = z.string().optional();

export const ListMyActivitiesQuery = z.object({
  timeZone: z
    .string()
    .refine(isIanaTimeZone, {
      message: 'not an IANA zone name',
      params: { reason: 'invalid_time_zone' },
    }),
  bucket: z.enum(ACTIVITY_BUCKETS),
  cursor,
  limit,
});
export type ListMyActivitiesQuery = z.infer<typeof ListMyActivitiesQuery>;

/** Six weeks: a month grid (contract `WindowTo`). */
export const CALENDAR_WINDOW_MAX_MS = 42 * 24 * 60 * 60 * 1000;

export const ListCalendarQuery = z
  .object({
    from: UtcDateTime,
    to: UtcDateTime,
    cursor,
    limit,
  })
  .superRefine((query, context) => {
    const span = Date.parse(query.to) - Date.parse(query.from);
    // Never clamped: a window that is too long is refused, not shortened.
    if (!(span > 0)) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'to must be after from',
        params: { reason: 'invalid_window' },
      });
    } else if (span > CALENDAR_WINDOW_MAX_MS) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'the window is at most 42 days',
        params: { reason: 'window_too_long' },
      });
    }
  });
export type ListCalendarQuery = z.infer<typeof ListCalendarQuery>;
