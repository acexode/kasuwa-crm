import type { TenantTx } from '@kasuwa/db';
import {
  activityFieldLevel,
  decodeActivityCursor,
  encodeActivityCursor,
  listMyCalendar,
  listMyOpenTasks,
  loadActivityFieldAccess,
  type ActivityFieldAccess,
  type MyActivityCursorKind,
  type MyActivityPageRows,
  type MyActivityRow,
  type SecuredActivityField,
} from '@kasuwa/domain-core';
import { bucketRange } from './activity-buckets';
import { ListCalendarQuery, ListMyActivitiesQuery } from './my-activities.schemas';

/**
 * listMyActivities and listCalendar (T-0082, P07; records.openapi.yaml;
 * D-L80, D-L105, D-L107, D-P13, D-P22).
 *
 * Order of work, so that nothing is read before it may be:
 *   1. the query (400 at its path; `invalid_time_zone`, `invalid_window`,
 *      `window_too_long`), never a fallback zone or a clamped window;
 *   2. the cursor's shape (400 `invalid_cursor`, one body);
 *   3. the field matrix, ONCE: the programmes where the row's time is
 *      readable decide what the repository may read at all, so a row whose
 *      time is withheld is dropped before the page is cut (L3);
 *   4. the repository, which re-resolves the cursor inside the caller's scope
 *      (400 `invalid_cursor`, the same body, for anything it cannot show).
 *
 * Every reader may call both: nothing here asks for a permission, and there
 * is no record id, so there is no 403 and no 404. The owner is always the
 * session user. NOTHING HERE LOGS: subjects and names are personal data.
 */

/** `#/components/schemas/MyActivity`, field security applied. */
export interface MyActivityWire {
  id: string;
  programmeId: string;
  type: 'task' | 'meeting';
  subject?: string | null;
  dueAt?: string | null;
  completedAt?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  contact?: { id: string; displayName: string } | null;
  account?: { id: string; name: string } | null;
  version: number;
  withheldFields: MyActivityWithheld[];
}

/** The contract's `MyActivity.withheldFields` names, in its order. */
export type MyActivityWithheld =
  | 'subject'
  | 'dueAt'
  | 'completedAt'
  | 'startsAt'
  | 'endsAt'
  | 'contact'
  | 'account';

/** `#/components/schemas/MyActivityPage`: no total, no count (D-P13). */
export interface MyActivityPageWire {
  data: MyActivityWire[];
  nextCursor: string | null;
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

/**
 * One row on the wire. WITHHELD MEANS OMITTED, NEVER NULLED, and named: a
 * property the caller may not read in the activity's programme is deleted;
 * `contact` follows `contactId` and `account` follows `accountId`. No body
 * and no owner, ever (the contract's item is closed).
 */
export function toMyActivityWire(row: MyActivityRow, access: ActivityFieldAccess): MyActivityWire {
  const readable = (field: SecuredActivityField) =>
    activityFieldLevel(access, row.programmeId, field) !== 'none';
  const withheld: MyActivityWithheld[] = [];
  const item: MyActivityWire = {
    id: row.id,
    programmeId: row.programmeId,
    type: row.type,
    version: row.version,
    withheldFields: withheld,
  };
  const put = <K extends MyActivityWithheld>(
    key: K,
    field: SecuredActivityField,
    value: MyActivityWire[K],
  ) => {
    if (readable(field)) item[key] = value;
    else withheld.push(key);
  };
  put('subject', 'subject', row.subject);
  put('dueAt', 'dueAt', iso(row.dueAt));
  put('completedAt', 'completedAt', iso(row.completedAt));
  put('startsAt', 'startsAt', iso(row.startsAt));
  put('endsAt', 'endsAt', iso(row.endsAt));
  put(
    'contact',
    'contactId',
    row.contactId !== null && row.contactDisplayName !== null
      ? { id: row.contactId, displayName: row.contactDisplayName }
      : null,
  );
  put(
    'account',
    'accountId',
    row.accountId !== null && row.accountName !== null
      ? { id: row.accountId, name: row.accountName }
      : null,
  );
  // Rebuilt in the contract's key order; `withheldFields` stays last.
  const { version, withheldFields, ...rest } = item;
  return { ...rest, version, withheldFields };
}

/** Session programmes in which every one of `fields` is readable (L3). */
export function programmesReading(
  access: ActivityFieldAccess,
  programmeIds: readonly string[],
  fields: readonly SecuredActivityField[],
): string[] {
  return programmeIds.filter((programmeId) =>
    fields.every((field) => activityFieldLevel(access, programmeId, field) !== 'none'),
  );
}

function page(
  kind: MyActivityCursorKind,
  rows: MyActivityPageRows,
  access: ActivityFieldAccess,
): MyActivityPageWire {
  return {
    data: rows.rows.map((row) => toMyActivityWire(row, access)),
    nextCursor: rows.nextCursorId === null ? null : encodeActivityCursor(kind, rows.nextCursorId),
  };
}

/** listMyActivities. `nowMs` is the server's instant, read once per request. */
export async function listMyActivitiesFor(
  tx: TenantTx,
  rawQuery: unknown,
  nowMs: number,
): Promise<MyActivityPageWire> {
  const query = ListMyActivitiesQuery.parse(rawQuery); // 400
  const cursorId =
    query.cursor === undefined ? null : decodeActivityCursor('tasks', query.cursor); // 400
  const access = await loadActivityFieldAccess(tx);
  const rows = await listMyOpenTasks(tx, {
    range: bucketRange(query.bucket, query.timeZone, nowMs),
    dueReadableProgrammeIds: programmesReading(access, tx.session.programmeIds, ['dueAt']),
    cursorId,
    limit: query.limit,
  });
  return page('tasks', rows, access);
}

/** listCalendar. */
export async function listCalendarFor(
  tx: TenantTx,
  rawQuery: unknown,
): Promise<MyActivityPageWire> {
  const query = ListCalendarQuery.parse(rawQuery); // 400
  const cursorId =
    query.cursor === undefined ? null : decodeActivityCursor('calendar', query.cursor); // 400
  const access = await loadActivityFieldAccess(tx);
  const programmeIds = tx.session.programmeIds;
  const rows = await listMyCalendar(tx, {
    from: new Date(query.from),
    to: new Date(query.to),
    dueReadableProgrammeIds: programmesReading(access, programmeIds, ['dueAt']),
    meetingReadableProgrammeIds: programmesReading(access, programmeIds, ['startsAt', 'endsAt']),
    cursorId,
    limit: query.limit,
  });
  return page('calendar', rows, access);
}
