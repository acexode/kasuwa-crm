import type { Activity } from '@kasuwa/domain-core';
import {
  redactedChange,
  type AuditChange,
  type AuditEventInput,
} from '../admin/audit/audit-writer';
import type { CreateActivityBody } from './activities.schemas';

/**
 * What an activity write records (T-0061).
 *
 * One event per successful write, `objectType: 'activity'`, labelled by the
 * record id (D-L63: the label is never a name, and a subject such as "Call
 * back Mrs X" is one). Every change is by FIELD NAME ONLY, never a value: a
 * subject or body is personal data in practice (D-L77), and D-L72's values
 * are the contact timeline's alone (D-L78 rules the same for accounts). The
 * actor is the session user, which the writer binds itself.
 *
 * Nothing here is logged; the event is the record.
 */

/** A create: every field it set to a value. */
export function activityCreateChanges(body: CreateActivityBody): AuditChange[] {
  const changes: AuditChange[] = [redactedChange('type')];
  for (const field of [
    'subject',
    'body',
    'dueAt',
    'startsAt',
    'endsAt',
    'ownerUserId',
    'contactId',
    'accountId',
  ] as const) {
    const value = body[field];
    if (value !== undefined && value !== null) changes.push(redactedChange(field));
  }
  return changes;
}

const sameInstant = (a: Date | null, b: Date | null) =>
  a === null || b === null ? a === b : a.getTime() === b.getTime();

/**
 * An update: completion when it newly happened, the owner when it moved, and
 * (T-0082) each time whose value changed: `dueAt` on a snooze or a clear,
 * `startsAt` and `endsAt` on a reschedule. Times are not value fields (D-L72):
 * by name only, like everything here.
 */
export function activityUpdateChanges(before: Activity, after: Activity): AuditChange[] {
  const changes: AuditChange[] = [];
  if (before.completedAt === null && after.completedAt !== null) {
    changes.push(redactedChange('completedAt'));
  }
  if (before.ownerUserId !== after.ownerUserId) changes.push(redactedChange('ownerUserId'));
  for (const field of ['dueAt', 'startsAt', 'endsAt'] as const) {
    if (!sameInstant(before[field], after[field])) changes.push(redactedChange(field));
  }
  return changes;
}

export function activityAuditEvent(
  action: 'created' | 'updated',
  activity: Activity,
  changes: readonly AuditChange[],
): AuditEventInput {
  return {
    action,
    objectType: 'activity',
    objectId: activity.id,
    objectLabel: activity.id,
    programmeId: activity.programmeId,
    changes,
  };
}
