import { z } from 'zod';
import {
  CONTACTS_PATH,
  Contact,
  ContactStatus,
  ConsentState,
  NETWORK_ERROR_CODE,
  RecordsErrorCode,
  type RecordsError,
  type RecordsResult,
} from './records-api';

/**
 * The browser's half of the P05 contact record (T-0062): `getContact`,
 * `updateContact`, `listContactTimeline`, `createActivity` and `updateActivity`
 * from `docs/api/records.openapi.yaml`, plus `getCurrentUser` and
 * `listMyProgrammes`. Built on `records-api.ts` and held to the same rules.
 *
 * SAME-ORIGIN, PARSED, AND NEVER SCOPED BY THE CALLER. Every path is a relative
 * `/api/v1/...`; every answer is Zod-parsed, and one the contract does not
 * describe is a network failure, not a record. No function here takes a
 * programme, and no request carries one in a header or a query: the session
 * says who the caller is and `user_programme` says what they reach.
 *
 * WRITES SEND WHAT THEY ARE GIVEN AND NOTHING ELSE. Field security has a
 * read-only level the wire cannot show, so a readable field sent back
 * unchanged is `403 field_not_editable` and the WHOLE edit is refused. The
 * screen computes the changed fields (`contact-record-model.ts`); this module
 * never pads a body with the rest of the record.
 *
 * THE TIMELINE CURSOR IS OPAQUE. Echoed back exactly as served, never parsed,
 * built or put in the address bar: it is a position in somebody's history.
 */

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

const Person = z.object({ id: z.string(), displayName: z.string() });
export type Person = z.infer<typeof Person>;

const AccountSummary = z.object({ id: z.string(), name: z.string() });
export type AccountSummary = z.infer<typeof AccountSummary>;

/**
 * A Contact as getContact serves it: the list's shape plus the two derived
 * properties the record prints by name (T-0043, T-0061). Both are omitted
 * with their id when field security withholds it, and `null` when the id is.
 */
export const ContactRecord = Contact.extend({
  // Free text; withheld like any field (T-0076). Shown, not yet offered in the edit sheet.
  companyName: z.string().nullable().optional(),
  owner: Person.nullable().optional(),
  account: AccountSummary.nullable().optional(),
});
export type ContactRecord = z.infer<typeof ContactRecord>;

export const ActivityType = z.enum(['note', 'task', 'call']);
export type ActivityType = z.infer<typeof ActivityType>;

// ---------------------------------------------------------------------------
// The timeline (a closed union on `type`, D-L72)
// ---------------------------------------------------------------------------

const ChangeValue = z.union([z.string(), z.boolean(), z.array(z.string()), z.null()]);
export type ChangeValue = z.infer<typeof ChangeValue>;

const ItemBase = {
  id: z.string(),
  occurredAt: z.string(),
  actor: Person.nullable(),
};

const FieldChangedItem = z.object({
  ...ItemBase,
  type: z.literal('field_changed'),
  field: z.string(),
  redacted: z.literal(true).optional(),
  before: ChangeValue.optional(),
  after: ChangeValue.optional(),
});

const ConsentChangedItem = z.object({
  ...ItemBase,
  type: z.literal('consent_changed'),
  before: ConsentState.optional(),
  after: ConsentState.optional(),
});

const ActivityItem = z.object({
  ...ItemBase,
  type: z.literal('activity'),
  activityId: z.string(),
  activityType: ActivityType,
  subject: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
});

export const TimelineItem = z.discriminatedUnion('type', [FieldChangedItem, ConsentChangedItem, ActivityItem]);
export type TimelineItem = z.infer<typeof TimelineItem>;
export type FieldChangedItem = z.infer<typeof FieldChangedItem>;
export type ConsentChangedItem = z.infer<typeof ConsentChangedItem>;
export type ActivityTimelineItem = z.infer<typeof ActivityItem>;

export const TimelinePage = z.object({
  data: z.array(TimelineItem),
  nextCursor: z.string().nullable(),
});
export type TimelinePage = z.infer<typeof TimelinePage>;

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export const Activity = z.object({
  id: z.string(),
  type: ActivityType,
  version: z.number().int(),
  subject: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  withheldFields: z.array(z.string()),
});
export type Activity = z.infer<typeof Activity>;

/** `createActivity`'s closed body, as the record sends it: always against the contact on screen. */
export interface NewActivity {
  readonly type: ActivityType;
  readonly contactId: string;
  readonly subject?: string;
  readonly body?: string;
  /** UTC, with a `Z`. Tasks only. */
  readonly dueAt?: string;
}

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

/** `getCurrentUser`, narrowed to what the record uses. The email is never read. */
const CurrentUser = z.object({ id: z.string(), displayName: z.string() });
export type CurrentUser = z.infer<typeof CurrentUser>;

const MyProgrammes = z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })) });
export type MyProgrammes = z.infer<typeof MyProgrammes>;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const ApiError = z.object({
  code: RecordsErrorCode,
  details: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
});

const NETWORK_FAILURE: RecordsError = { code: NETWORK_ERROR_CODE };

const ACTIVITIES_PATH = '/api/v1/activities';

async function call<T>(
  path: string,
  schema: z.ZodType<T>,
  init: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; signal?: AbortSignal } = {},
): Promise<RecordsResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? 'GET',
      // Never into the browser's HTTP cache: every answer here is a person's
      // record or a staff member's identity, on a shared desk (T-0062 review).
      cache: 'no-store',
      headers:
        init.body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
  } catch {
    return { ok: false, error: NETWORK_FAILURE };
  }
  const payload: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = schema.safeParse(payload);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: NETWORK_FAILURE };
  }
  const parsed = ApiError.safeParse(payload);
  return { ok: false, error: parsed.success ? { code: parsed.data.code } : NETWORK_FAILURE };
}

function contactPath(id: string): string {
  return `${CONTACTS_PATH}/${encodeURIComponent(id)}`;
}

export function getContact(id: string, signal?: AbortSignal): Promise<RecordsResult<ContactRecord>> {
  return call(contactPath(id), ContactRecord, { ...(signal === undefined ? {} : { signal }) });
}

/** `body` is `version` plus exactly the fields the user changed. */
export function updateContact(
  id: string,
  body: Readonly<Record<string, unknown>> & { readonly version: number },
): Promise<RecordsResult<ContactRecord>> {
  return call(contactPath(id), ContactRecord, { method: 'PATCH', body });
}

/** The query `listContactTimeline` takes: an echoed cursor, and no limit (the server's 25). */
export function timelineSearch(cursor: string | null): string {
  return cursor === null ? '' : `?${new URLSearchParams({ cursor }).toString()}`;
}

export function listContactTimeline(
  id: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<RecordsResult<TimelinePage>> {
  return call(`${contactPath(id)}/timeline${timelineSearch(cursor)}`, TimelinePage, {
    ...(signal === undefined ? {} : { signal }),
  });
}

/** `createActivity`'s body: empty text is left out, never sent as `""` (minLength 1). */
export function createActivityBody(activity: NewActivity): Record<string, string> {
  const body: Record<string, string> = { type: activity.type, contactId: activity.contactId };
  const subject = activity.subject?.trim() ?? '';
  const text = activity.body?.trim() ?? '';
  if (subject !== '') body.subject = subject;
  if (text !== '') body.body = text;
  if (activity.type === 'task' && activity.dueAt !== undefined) body.dueAt = activity.dueAt;
  return body;
}

export function createActivity(activity: NewActivity): Promise<RecordsResult<Activity>> {
  return call(ACTIVITIES_PATH, Activity, { method: 'POST', body: createActivityBody(activity) });
}

/** Completes a task, with the version a 201 or 200 for it carried (never invented). */
export function completeActivity(id: string, version: number): Promise<RecordsResult<Activity>> {
  return call(`${ACTIVITIES_PATH}/${encodeURIComponent(id)}`, Activity, {
    method: 'PATCH',
    body: { version, completed: true },
  });
}

export function getCurrentUser(signal?: AbortSignal): Promise<RecordsResult<CurrentUser>> {
  return call('/api/v1/auth/me', CurrentUser, { ...(signal === undefined ? {} : { signal }) });
}

export function listMyProgrammes(signal?: AbortSignal): Promise<RecordsResult<MyProgrammes>> {
  return call('/api/v1/me/programmes', MyProgrammes, { ...(signal === undefined ? {} : { signal }) });
}

export { ContactStatus };
