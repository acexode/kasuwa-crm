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
const UtcDateTime = z
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
  'ownerUserId',
  'contactId',
  'accountId',
] as const;

export const CreateActivityBody = z
  .object({
    type: z.enum(ACTIVITY_TYPES),
    subject: text(1, SUBJECT_MAX_LENGTH).nullable().optional(),
    body: text(1, BODY_MAX_LENGTH).nullable().optional(),
    dueAt: UtcDateTime.nullable().optional(),
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
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dueAt'],
        message: 'only a task has a due time',
        params: { reason: 'task_only' },
      });
    }
  });
export type CreateActivityBody = z.infer<typeof CreateActivityBody>;

/**
 * `UpdateActivityRequest`: `version` plus `completed: true` and/or
 * `ownerUserId` (D-L81). Reopening a task (`completed: false`) is not in the
 * MVP and is 400. Retargeting is not an edit.
 */
export const UpdateActivityBody = z
  .object({
    version: VERSION,
    completed: z.literal(true).optional(),
    ownerUserId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((body) => body.completed !== undefined || body.ownerUserId !== undefined, {
    message: 'an update must change something',
    path: [],
    params: { reason: 'nothing_to_update' },
  });
export type UpdateActivityBody = z.infer<typeof UpdateActivityBody>;

/** Update body key -> the Activity property field security judges for it. */
export const UPDATE_ACTIVITY_SECURED = {
  completed: 'completedAt',
  ownerUserId: 'ownerUserId',
} as const;
