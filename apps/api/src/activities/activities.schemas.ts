import { ACTIVITY_TYPES } from '@kasuwa/domain-core';
import { z } from 'zod';
import { text } from '../common/text';

/**
 * Boundary schemas for the activity writes (T-0061), transcribed from
 * `CreateActivityRequest` and `UpdateActivityRequest` in
 * docs/api/records.openapi.yaml. Parse, never cast (CLAUDE.md 4).
 *
 * Both bodies are CLOSED (`.strict()`): an unknown or server-owned property
 * is 400 at its own path. That is how a client-chosen `id` (D-L79), a
 * `createdByUserId` (D-L79), a `programmeId` (the programme is the
 * target's), a `tenantId`, the timestamps, `version` on create, `completedAt`
 * (the server sets it) and a retarget on update are all refused, with one
 * body whatever the value names.
 *
 * Free text is `text()` (D-L78): a NUL is 400 `invalid_character`, never a
 * Postgres 22021 and never silently stripped.
 */

export const SUBJECT_MAX_LENGTH = 200;
export const BODY_MAX_LENGTH = 10_000;

/** Postgres `integer`: anything larger is 22003 at `::integer`, a 500, not a 400. */
const VERSION = z.number().int().min(1).max(2_147_483_647);

/**
 * UTC ISO 8601 with a `Z` (the contract's times) and a real calendar date:
 * the shape alone admits `2026-02-30`, which Postgres would refuse later as a
 * 500. `Date` rolls an impossible day into the next month, so a round trip
 * that changes the date catches it. The year is held to 1970..9999: `Date`
 * accepts year 0000, which Postgres rejects (22008), also a 500.
 */
export const UtcDateTime = z
  .string()
  .datetime()
  .refine(
    (value) => {
      const year = Number(value.slice(0, 4));
      if (!(year >= 1970 && year <= 9999)) return false;
      const parsed = new Date(value);
      return (
        !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value.slice(0, 10)
      );
    },
    { params: { reason: 'invalid_date' } },
  );

export const ActivityIdParam = z.object({ id: z.string().uuid() });

/** The create body's keys a caller may send, as the contract names them. */
export const CREATE_ACTIVITY_KEYS = [
  'type',
  'subject',
  'body',
  'dueAt',
  'startsAt',
  'endsAt',
  'ownerUserId',
  'contactId',
  'accountId',
] as const;

/** A meeting's longest span (D-L107: the API's limit, not the database's). */
export const MEETING_MAX_MS = 24 * 60 * 60 * 1000;

type Issue = { path: string; reason: string };

/**
 * A meeting's times, judged on the RESULT (T-0082, W1/W2): `endsAt` after
 * `startsAt` (`invalid_range`; equal is not after) and at most 24 hours after
 * it (`too_long`), reported at `at`, the field the caller sent (`endsAt` when
 * both were sent). Null when the span is valid.
 */
export function meetingSpanIssue(
  startsAt: string,
  endsAt: string,
  at: 'startsAt' | 'endsAt',
): Issue | null {
  const span = Date.parse(endsAt) - Date.parse(startsAt);
  if (!(span > 0)) return { path: at, reason: 'invalid_range' };
  if (span > MEETING_MAX_MS) return { path: at, reason: 'too_long' };
  return null;
}

const addIssue = (context: z.RefinementCtx, issue: Issue, message: string) =>
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: [issue.path],
    message,
    params: { reason: issue.reason },
  });

export const CreateActivityBody = z
  .object({
    type: z.enum(ACTIVITY_TYPES),
    subject: text(1, SUBJECT_MAX_LENGTH).nullable().optional(),
    body: text(1, BODY_MAX_LENGTH).nullable().optional(),
    dueAt: UtcDateTime.nullable().optional(),
    // A meeting's times (T-0082): never nullable, a meeting always has both.
    startsAt: UtcDateTime.optional(),
    endsAt: UtcDateTime.optional(),
    ownerUserId: z.string().uuid().nullable().optional(),
    contactId: z.string().uuid().nullable().optional(),
    accountId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .superRefine((body, context) => {
    if (
      (body.contactId === undefined || body.contactId === null) &&
      (body.accountId === undefined || body.accountId === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contactId'],
        message: 'an activity needs a contact or an account',
        params: { reason: 'target_required' },
      });
    }
    // 0027: due and completed times belong to tasks only.
    if (body.type !== 'task' && body.dueAt !== undefined && body.dueAt !== null) {
      addIssue(context, { path: 'dueAt', reason: 'task_only' }, 'only a task has a due time');
    }
    // 0034 (D-L107): a meeting has both times, end after start, at most 24 h;
    // nothing else has either.
    if (body.type === 'meeting') {
      for (const field of ['startsAt', 'endsAt'] as const) {
        if (body[field] === undefined) {
          addIssue(context, { path: field, reason: 'required' }, 'a meeting needs both times');
        }
      }
      if (body.startsAt !== undefined && body.endsAt !== undefined) {
        const issue = meetingSpanIssue(body.startsAt, body.endsAt, 'endsAt');
        if (issue !== null) addIssue(context, issue, 'a meeting ends after it starts, within a day');
      }
    } else {
      for (const field of ['startsAt', 'endsAt'] as const) {
        if (body[field] !== undefined) {
          addIssue(context, { path: field, reason: 'meeting_only' }, 'only a meeting has times');
        }
      }
    }
  });
export type CreateActivityBody = z.infer<typeof CreateActivityBody>;

/**
 * `UpdateActivityRequest`: `version` plus `completed: true` and/or
 * `ownerUserId` (D-L81), and from T-0082 `dueAt` (snooze a task; `null`
 * clears it) and `startsAt` / `endsAt` (reschedule a meeting; never null).
 * Reopening a task (`completed: false`) is not in the MVP and is 400.
 * Retargeting is not an edit. Which type each field belongs to, and a
 * meeting's span, are judged against the stored row by the service.
 */
export const UpdateActivityBody = z
  .object({
    version: VERSION,
    completed: z.literal(true).optional(),
    ownerUserId: z.string().uuid().nullable().optional(),
    dueAt: UtcDateTime.nullable().optional(),
    startsAt: UtcDateTime.optional(),
    endsAt: UtcDateTime.optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.completed !== undefined ||
      body.ownerUserId !== undefined ||
      body.dueAt !== undefined ||
      body.startsAt !== undefined ||
      body.endsAt !== undefined,
    {
      message: 'an update must change something',
      path: [],
      params: { reason: 'nothing_to_update' },
    },
  );
export type UpdateActivityBody = z.infer<typeof UpdateActivityBody>;

/** Update body key -> the Activity property field security judges for it. */
export const UPDATE_ACTIVITY_SECURED = {
  completed: 'completedAt',
  ownerUserId: 'ownerUserId',
  dueAt: 'dueAt',
  startsAt: 'startsAt',
  endsAt: 'endsAt',
} as const;
