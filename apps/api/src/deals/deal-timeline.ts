import type { ActivityFieldAccess, TimelineChangeRow, TimelineRow } from '@kasuwa/domain-core';
import type { TenantTx } from '@kasuwa/db';
import type { FieldAccess } from '@kasuwa/metadata-engine';
import { notFound } from '../admin/common/admin-errors';
import {
  itemBase,
  readRecordTimeline,
  timelineItems,
  type ActivityItemWire,
  type RecordTimelineSpec,
  type TimelineItemBase,
  type TimelinePage,
} from '../timeline/record-timeline';
import { loadDealFieldAccess, withheldDealFields } from './deal-fields';
import { findReadableDealProgramme } from './deals.service';

/**
 * listDealTimeline (T-0111; `GET /api/v1/deals/{dealId}/timeline`,
 * `DealTimelinePage` in records.openapi.yaml; D-L88, D-L127, D-L129 R8-R13,
 * R19), on the record timeline it shares with the contact's and the
 * account's (`../timeline/record-timeline.ts`): scope first, the query, both
 * matrices once, field security before paging, the activity item with its
 * `version`. Nothing is forked: the deal is a third subject of the same
 * statement, cursor format and item mapping.
 *
 * What only the deal's timeline decides:
 *   - SCOPE IS getDeal's (R12, D-L127): the deal must be one the caller
 *     reaches AND reads (the five staff sets, or the tenant-admin flag, in
 *     the deal's programme). A non-uuid id, a deal out of scope, a
 *     client_portal caller and a custom set are getDeal's ONE 404 body, by
 *     the very same lookup (`findReadableDealProgramme`), before the query
 *     or the cursor is read: 404 before 400, and a read has no 403.
 *   - FIELD CHANGES ARE BY NAME ONLY, ALWAYS (R8): `{ field, redacted: true }`,
 *     never `before` or `after`, even where the audit row holds a move's
 *     stage ids or a reassignment's owner ids (D-L64). Only the closed list
 *     below gives items; `stageEnteredAt`, `closedAt` and any other name
 *     give none (the repository is handed the allow-list, so they never
 *     reach the LIMIT).
 *   - FIELD SECURITY (R9): the DEAL matrix judges change items exactly as
 *     getDeal judges the Deal: an item is omitted precisely when getDeal lists
 *     its field in `withheldFields` for this caller. `name`, `stageId` and
 *     `checks` are never withheld (D-L124 R13).
 *   - ACTIVITIES (R10, R19): an activity is on it through its `deal_id`
 *     (0037), so a withheld activity `deal_id` hides every activity item; a
 *     withheld `contact_id` or `account_id` hides nothing here (the item
 *     names neither). The deal's contact's and account's other activities
 *     are not rolled up.
 *
 * NOTHING HERE LOGS: subjects, bodies, deal names and next steps hold names
 * in practice.
 */

/** `DealFieldChangedItem.field`'s enum, in contract order (R8). */
export const DEAL_TIMELINE_FIELDS = [
  'name',
  'amount',
  'expectedCloseDate',
  'ownerUserId',
  'primaryContactId',
  'accountId',
  'nextStep',
  'stageId',
  'checks',
] as const;

const DEAL_FIELDS = new Set<string>(DEAL_TIMELINE_FIELDS);

// --- the wire ------------------------------------------------------------------

export type DealChangeItemWire = TimelineItemBase & {
  type: 'field_changed';
  field: string;
  redacted: true;
};

export type DealTimelineItemWire = DealChangeItemWire | ActivityItemWire;

export type DealTimelinePageWire = TimelinePage<DealTimelineItemWire>;

// --- field security --------------------------------------------------------------

/**
 * The deal audit change fields the caller may see on a deal in
 * `programmeId`: every timeline field that getDeal would not withhold there
 * (R9). `name`, `stageId` and `checks` are never withheld; a programme the
 * matrix does not carry withholds every withholdable one (fails closed).
 */
export function visibleDealChangeFields(access: FieldAccess, programmeId: string): string[] {
  const withheld = new Set<string>(withheldDealFields(access, programmeId));
  return DEAL_TIMELINE_FIELDS.filter((field) => !withheld.has(field));
}

/** Always by name only. A name outside the closed list gives no item. */
export function dealChangeItem(row: TimelineChangeRow): DealChangeItemWire | null {
  if (!DEAL_FIELDS.has(row.field)) return null;
  return { ...itemBase(row), type: 'field_changed', field: row.field, redacted: true };
}

/** The wire items for a page of deal timeline rows. */
export function toDealTimelineItems(
  rows: readonly TimelineRow[],
  activityAccess: ActivityFieldAccess,
  programmeId: string,
): DealTimelineItemWire[] {
  return timelineItems(rows, activityAccess, programmeId, dealChangeItem);
}

// --- the operation -------------------------------------------------------------------

export const DEAL_TIMELINE: RecordTimelineSpec<FieldAccess, DealChangeItemWire> = {
  subject: 'deal',
  // getDeal's lookup (deals.service.ts), so the two never disagree on reach.
  findRecordProgramme: findReadableDealProgramme,
  loadRecordAccess: loadDealFieldAccess,
  visibleChangeFields: visibleDealChangeFields,
  changeItem: dealChangeItem,
  activityLink: 'dealId',
};

/**
 * `dealId` is the raw path segment. A malformed id is the one 404 (the
 * lookup refuses it before any SQL), and nothing is read before scope passes.
 */
export async function listDealTimelineFor(
  tx: TenantTx,
  dealId: unknown,
  query: unknown,
): Promise<DealTimelinePageWire> {
  if (typeof dealId !== 'string') throw notFound();
  return readRecordTimeline(tx, DEAL_TIMELINE, dealId, query);
}
