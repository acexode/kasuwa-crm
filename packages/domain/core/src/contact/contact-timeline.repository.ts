import type { TenantTx } from '@kasuwa/db';
import {
  decodeRecordTimelineCursor,
  encodeRecordTimelineCursor,
  listRecordTimeline,
  type TimelinePageRows,
} from '../timeline/record-timeline.repository';

/**
 * The contact timeline's rows (T-0061; the T-0059 contract, D-L72, D-L73,
 * D-L81): the shared record timeline (`../timeline/record-timeline.repository`,
 * T-0080) with the contact's constants: the contact's own `contact` audit
 * events, and the activities whose `contact_id` is the contact. Paging,
 * ordering, item ids and the cursor format (`{ k, t, i }`) are the shared
 * statement's, unchanged from T-0061.
 */

export interface ListContactTimelineOptions {
  contactId: string;
  /** The contact's programme; must be in the session's scope. */
  programmeId: string;
  limit: number;
  cursor?: string | undefined;
  /** Audit change `field` values the caller may see. Anything else is omitted. */
  visibleChangeFields: readonly string[];
  /** Whether activity rows are included at all. */
  includeActivities: boolean;
}

export interface TimelineCursor {
  contactId: string;
  occurredAt: string;
  itemId: string;
}

export function encodeTimelineCursor(position: TimelineCursor): string {
  return encodeRecordTimelineCursor('contact', {
    recordId: position.contactId,
    occurredAt: position.occurredAt,
    itemId: position.itemId,
  });
}

/** Throws InvalidCursorError for garbage, or for a cursor issued for another contact. */
export function decodeTimelineCursor(cursor: string, contactId: string): TimelineCursor {
  const at = decodeRecordTimelineCursor('contact', cursor, contactId);
  return { contactId: at.recordId, occurredAt: at.occurredAt, itemId: at.itemId };
}

/** One page of a contact's timeline rows (see the shared statement). */
export async function listContactTimeline(
  tx: TenantTx,
  options: ListContactTimelineOptions,
): Promise<TimelinePageRows> {
  const { contactId, ...rest } = options;
  return listRecordTimeline(tx, 'contact', { recordId: contactId, ...rest });
}
