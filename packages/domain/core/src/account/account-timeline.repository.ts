import type { TenantTx } from '@kasuwa/db';
import {
  decodeRecordTimelineCursor,
  encodeRecordTimelineCursor,
  listRecordTimeline,
  type TimelinePageRows,
} from '../timeline/record-timeline.repository';

/**
 * The account timeline's rows (T-0080): the shared record timeline
 * (`../timeline/record-timeline.repository`) with the account's constants.
 *
 *   - Field changes: the account's own `account` audit events, recorded in
 *     the account's programme. Not a contact's event naming its `accountId`,
 *     not an activity's own events, not a child account's.
 *   - Activities: those whose `account_id` is the account, with or without a
 *     contact, read on activity_account_keyset_idx (0027). Not the activities
 *     of the account's contacts that carry no `account_id`, and not a child
 *     account's.
 *
 * The cursor is `{ a, t, i }`: the account, the millisecond and the item id.
 * A contact timeline's `{ k, t, i }` never parses here, nor this one there.
 */

export interface ListAccountTimelineOptions {
  accountId: string;
  /** The account's programme; must be in the session's scope. */
  programmeId: string;
  limit: number;
  cursor?: string | undefined;
  /** Account audit change `field` values the caller may see. Anything else is omitted. */
  visibleChangeFields: readonly string[];
  /** Whether activity rows are included at all. */
  includeActivities: boolean;
}

export interface AccountTimelineCursor {
  accountId: string;
  occurredAt: string;
  itemId: string;
}

export function encodeAccountTimelineCursor(position: AccountTimelineCursor): string {
  return encodeRecordTimelineCursor('account', {
    recordId: position.accountId,
    occurredAt: position.occurredAt,
    itemId: position.itemId,
  });
}

/** Throws InvalidCursorError for garbage, or for a cursor issued for another account or list. */
export function decodeAccountTimelineCursor(
  cursor: string,
  accountId: string,
): AccountTimelineCursor {
  const at = decodeRecordTimelineCursor('account', cursor, accountId);
  return { accountId: at.recordId, occurredAt: at.occurredAt, itemId: at.itemId };
}

/** One page of an account's timeline rows (see the shared statement). */
export async function listAccountTimeline(
  tx: TenantTx,
  options: ListAccountTimelineOptions,
): Promise<TimelinePageRows> {
  const { accountId, ...rest } = options;
  return listRecordTimeline(tx, 'account', { recordId: accountId, ...rest });
}
