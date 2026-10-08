import {
  activityFieldLevel,
  DEFAULT_PAGE_SIZE,
  isActivityType,
  listRecordTimeline,
  loadActivityFieldAccess,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
  type ActivityFieldAccess,
  type TimelineActivityRow,
  type TimelineActorRow,
  type TimelineChangeRow,
  type TimelineRow,
  type TimelineSubject,
} from '@kasuwa/domain-core';
import type { TenantTx } from '@kasuwa/db';
import { z } from 'zod';
import { notFound } from '../admin/common/admin-errors';

/**
 * What the contact timeline (T-0061) and the account timeline (T-0080) share,
 * so neither forks the other: the query, the activity item, the fail-closed
 * field-security path and the order of checks. Each timeline supplies only
 * what differs (`RecordTimelineSpec`): whose matrix judges its field changes,
 * which change fields exist, how a change row becomes an item, and which
 * activity link puts an activity on it.
 *
 * 1. SCOPE FIRST. The record must be one the session reaches, found by THE
 *    SAME lookup as the record's get operation (getContact's
 *    `findContactById`, getAccount's `findAccountById`), so a record can
 *    never be 404 on one and served on the other (a later soft-delete, D-P27,
 *    changes both at once). Anything else is the one 404 body, and nothing
 *    about its history is read before that.
 *    A cursor is decoded only after, so a cursor never opens a record.
 * 2. FIELD SECURITY, BEFORE PAGING. Judged today, in the record's programme,
 *    by the set the caller holds there. Both matrices are loaded ONCE per
 *    request. The repository is handed the allow-list of change fields the
 *    caller may see, so withheld items never reach the LIMIT. Activity items
 *    follow the ACTIVITY object's matrix: a withheld subject, body, due or
 *    completed time is omitted from the item, and when the activity's link
 *    to THIS record (its `contact_id` on a contact's timeline, its
 *    `account_id` on an account's) is withheld no activity item is shown at
 *    all, since the item itself would disclose the link. Every lookup fails
 *    closed: a programme or field the matrix does not carry is `none`.
 * 3. VERSION (D-L85). Every activity item carries the row's `version`, never
 *    withheld: it is what updateActivity needs, and it says nothing about
 *    the activity's content.
 *
 * NOTHING HERE LOGS: subjects and bodies hold names in practice.
 */

export const TimelineQuery = z.object({
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

// --- the wire ------------------------------------------------------------------

export interface TimelineItemBase {
  id: string;
  occurredAt: string;
  actor: TimelineActorRow | null;
}

/** `ActivityItem`: one schema on both timelines. */
export type ActivityItemWire = TimelineItemBase & {
  type: 'activity';
  activityId: string;
  activityType: string;
  subject?: string | null;
  body?: string | null;
  dueAt?: string | null;
  completedAt?: string | null;
  version: number;
};

export interface TimelinePage<Item> {
  data: Item[];
  nextCursor: string | null;
}

export function itemBase(row: TimelineRow): TimelineItemBase {
  return { id: row.itemId, occurredAt: row.occurredAt, actor: row.actor };
}

/** An activity row carries a type outside the contract. 0027's CHECK makes this impossible. */
class TimelineActivityTypeError extends Error {
  constructor() {
    super('A timeline activity carries an unknown type');
    this.name = 'TimelineActivityTypeError';
  }
}

/** The activity item, the activity matrix applied in `programmeId`. */
export function activityItem(
  row: TimelineActivityRow,
  access: ActivityFieldAccess,
  programmeId: string,
): ActivityItemWire {
  if (!isActivityType(row.activityType)) throw new TimelineActivityTypeError();
  const readable = (field: 'subject' | 'body' | 'dueAt' | 'completedAt') =>
    activityFieldLevel(access, programmeId, field) !== 'none';
  return {
    ...itemBase(row),
    type: 'activity',
    activityId: row.activityId,
    activityType: row.activityType,
    ...(readable('subject') ? { subject: row.subject } : {}),
    ...(readable('body') ? { body: row.body } : {}),
    ...(readable('dueAt') ? { dueAt: row.dueAt?.toISOString() ?? null } : {}),
    ...(readable('completedAt') ? { completedAt: row.completedAt?.toISOString() ?? null } : {}),
    version: row.version,
  };
}

/**
 * The wire items for a page of rows: activity rows through the activity
 * matrix, change rows through the timeline's own mapping, which may drop one
 * (`null`) it cannot show.
 */
export function timelineItems<Change>(
  rows: readonly TimelineRow[],
  activityAccess: ActivityFieldAccess,
  programmeId: string,
  changeItem: (row: TimelineChangeRow) => Change | null,
): (Change | ActivityItemWire)[] {
  const items: (Change | ActivityItemWire)[] = [];
  for (const row of rows) {
    const item =
      row.kind === 'activity' ? activityItem(row, activityAccess, programmeId) : changeItem(row);
    if (item !== null) items.push(item);
  }
  return items;
}

// --- the operation -------------------------------------------------------------------

/** What one timeline decides for itself. */
export interface RecordTimelineSpec<RecordAccess, Change> {
  subject: TimelineSubject;
  /**
   * The record's programme, or null when the session cannot reach it. MUST be
   * the record's get operation's own lookup, never a second query of its own.
   */
  findRecordProgramme: (tx: TenantTx, recordId: string) => Promise<string | null>;
  /** The record object's matrix: one round trip. */
  loadRecordAccess(tx: TenantTx): Promise<RecordAccess>;
  /** The change fields the caller may see on a record in `programmeId`. */
  visibleChangeFields(access: RecordAccess, programmeId: string): string[];
  /** A change row as an item, or `null` to drop it. */
  changeItem(row: TimelineChangeRow): Change | null;
  /** The Activity property that puts an activity on this timeline. */
  activityLink: 'contactId' | 'accountId';
}

/**
 * One page of a record's timeline. `recordId` must already be a well-formed
 * uuid (each operation decides what a malformed one answers).
 */
export async function readRecordTimeline<RecordAccess, Change>(
  tx: TenantTx,
  spec: RecordTimelineSpec<RecordAccess, Change>,
  recordId: string,
  query: unknown,
): Promise<TimelinePage<Change | ActivityItemWire>> {
  // 1. Scope first: one 404 for absent, another tenant's and a sibling's.
  const programmeId = await spec.findRecordProgramme(tx, recordId);
  if (programmeId === null) throw notFound();
  // 2. Then the query (400), then the cursor (400 invalid_cursor, in the repository).
  const { cursor, limit } = TimelineQuery.parse(query);

  // Each matrix once per request.
  const recordAccess = await spec.loadRecordAccess(tx);
  const activityAccess = await loadActivityFieldAccess(tx);
  const page = await listRecordTimeline(tx, spec.subject, {
    recordId,
    programmeId,
    limit,
    cursor,
    visibleChangeFields: spec.visibleChangeFields(recordAccess, programmeId),
    includeActivities:
      activityFieldLevel(activityAccess, programmeId, spec.activityLink) !== 'none',
  });
  return {
    data: timelineItems(page.rows, activityAccess, programmeId, spec.changeItem),
    nextCursor: page.nextCursor,
  };
}
