import { z } from 'zod';
import { requestRecords, type RecordsResult } from './records-api';

/**
 * The browser's half of P07 (T-0083): `listMyActivities`, `listCalendar`,
 * `createActivity` and `updateActivity` from `docs/api/records.openapi.yaml`,
 * on the same transport as every records client (`requestRecords`).
 *
 * SAME-ORIGIN, PARSED, AND NEVER SCOPED BY THE CALLER. Relative `/api/v1/...`
 * paths only. Neither list takes an owner, a user or a programme: the server
 * lists the session user's OWN activities in the programmes the session
 * resolves, and nothing a request carries can widen that.
 *
 * THE ZONE IS THE BROWSER'S. `timeZone` is whatever the browser resolves
 * (`browserTimeZone()`), sent on every listMyActivities read. No module names
 * a zone: "always WAT" is the design's sketch, not the rule, and a Nairobi
 * desk reads its own clock. The calendar's window is local midnights turned
 * into UTC by the browser, so the server assumes no zone at all.
 *
 * CURSORS ARE OPAQUE. Echoed back exactly as served, with the same bucket and
 * zone or the same window, never built, parsed or put in the address bar.
 *
 * WITHHELD IS NOT NULL. A property field security withholds is omitted and
 * named in `withheldFields`; every withholdable property is `.optional()` and
 * the screen asks `withheld(item, field)` before it reads one.
 */

export const MY_ACTIVITIES_PATH = '/api/v1/me/activities';
export const CALENDAR_PATH = '/api/v1/me/calendar';
export const ACTIVITIES_PATH = '/api/v1/activities';

/** The most rows one page may carry (the contract's Limit). The screen always asks for it. */
export const PAGE_LIMIT = 100;

export const ActivityBucket = z.enum(['overdue', 'today', 'upcoming']);
export type ActivityBucket = z.infer<typeof ActivityBucket>;

/** What the two lists carry: tasks and meetings only. */
export const ListedType = z.enum(['task', 'meeting']);
export type ListedType = z.infer<typeof ListedType>;

const ContactSummary = z.object({ id: z.string(), displayName: z.string() });
const AccountSummary = z.object({ id: z.string(), name: z.string() });

export const MyActivity = z.object({
  id: z.string(),
  programmeId: z.string(),
  type: ListedType,
  subject: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  startsAt: z.string().nullable().optional(),
  endsAt: z.string().nullable().optional(),
  contact: ContactSummary.nullable().optional(),
  account: AccountSummary.nullable().optional(),
  version: z.number().int(),
  withheldFields: z.array(z.string()),
});
export type MyActivity = z.infer<typeof MyActivity>;

export const MyActivityPage = z.object({
  data: z.array(MyActivity),
  nextCursor: z.string().nullable(),
});
export type MyActivityPage = z.infer<typeof MyActivityPage>;

/** The Activity a write answers with, narrowed to what the screen takes back from it. */
export const WrittenActivity = z.object({
  id: z.string(),
  type: z.enum(['note', 'task', 'call', 'meeting']),
  version: z.number().int(),
  withheldFields: z.array(z.string()),
});
export type WrittenActivity = z.infer<typeof WrittenActivity>;

/** `true` when field security withheld `field` from this caller on this item. */
export function withheld(item: { readonly withheldFields: readonly string[] }, field: string): boolean {
  return item.withheldFields.includes(field);
}

/**
 * The browser's IANA zone, exactly as it resolves it. Never a constant, never
 * a default: an empty answer is sent as it is and refused by the server,
 * rather than guessed here.
 */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The query listMyActivities takes: the zone, the bucket, the page size and an echoed cursor. */
export function myActivitiesSearch(bucket: ActivityBucket, timeZone: string, cursor: string | null): string {
  const params = new URLSearchParams({ timeZone, bucket, limit: String(PAGE_LIMIT) });
  if (cursor !== null) params.set('cursor', cursor);
  return `?${params.toString()}`;
}

export function listMyActivities(
  bucket: ActivityBucket,
  timeZone: string,
  cursor: string | null,
): Promise<RecordsResult<MyActivityPage>> {
  return requestRecords(`${MY_ACTIVITIES_PATH}${myActivitiesSearch(bucket, timeZone, cursor)}`, MyActivityPage);
}

/** A window of the calendar, in UTC with a `Z`: `from` inclusive, `to` exclusive. */
export interface CalendarWindow {
  readonly from: string;
  readonly to: string;
}

export function calendarSearch(window: CalendarWindow, cursor: string | null): string {
  const params = new URLSearchParams({ from: window.from, to: window.to, limit: String(PAGE_LIMIT) });
  if (cursor !== null) params.set('cursor', cursor);
  return `?${params.toString()}`;
}

export function listCalendar(window: CalendarWindow, cursor: string | null): Promise<RecordsResult<MyActivityPage>> {
  return requestRecords(`${CALENDAR_PATH}${calendarSearch(window, cursor)}`, MyActivityPage);
}

/** The ONE record an activity is composed against. */
export type ComposeTarget = { readonly kind: 'contact'; readonly id: string } | { readonly kind: 'account'; readonly id: string };

/** What the composer collects. Times are UTC with a `Z`. */
export type ComposedActivity =
  | { readonly type: 'task'; readonly subject: string; readonly dueAt: string | null; readonly target: ComposeTarget }
  | {
      readonly type: 'meeting';
      readonly subject: string;
      readonly startsAt: string;
      readonly endsAt: string;
      readonly target: ComposeTarget;
    };

/**
 * createActivity's closed body. The owner is the caller (P07 composes for the
 * person composing, so a meeting lands on their own calendar), the target is
 * the one record picked, and a task carries no meeting times nor a meeting a
 * due time.
 */
export function createBody(activity: ComposedActivity, ownerUserId: string): Record<string, string> {
  const body: Record<string, string> = { type: activity.type, ownerUserId };
  const subject = activity.subject.trim();
  if (subject !== '') body.subject = subject;
  if (activity.target.kind === 'contact') body.contactId = activity.target.id;
  else body.accountId = activity.target.id;
  if (activity.type === 'task') {
    if (activity.dueAt !== null) body.dueAt = activity.dueAt;
  } else {
    body.startsAt = activity.startsAt;
    body.endsAt = activity.endsAt;
  }
  return body;
}

export function createActivity(activity: ComposedActivity, ownerUserId: string): Promise<RecordsResult<WrittenActivity>> {
  return requestRecords(ACTIVITIES_PATH, WrittenActivity, { method: 'POST', body: createBody(activity, ownerUserId) });
}

/**
 * updateActivity's body: `version` plus ONLY what the person changed (D-L102).
 * The screen decides what changed; this module never pads a body.
 */
export interface ActivityChange {
  readonly version: number;
  readonly completed?: true;
  readonly dueAt?: string;
  readonly startsAt?: string;
  readonly endsAt?: string;
}

export function updateActivity(id: string, change: ActivityChange): Promise<RecordsResult<WrittenActivity>> {
  return requestRecords(`${ACTIVITIES_PATH}/${encodeURIComponent(id)}`, WrittenActivity, { method: 'PATCH', body: change });
}
