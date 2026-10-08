import {
  accountFieldLevel,
  findAccountById,
  isWithholdableAccountField,
  loadAccountFieldAccess,
  type AccountFieldAccess,
  type ActivityFieldAccess,
  type TimelineChangeRow,
  type TimelineRow,
} from '@kasuwa/domain-core';
import type { TenantTx } from '@kasuwa/db';
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
import { AccountIdParam } from './accounts.schemas';

/**
 * listAccountTimeline (T-0080; `GET /api/v1/accounts/{accountId}/timeline`,
 * `AccountTimelinePage` in records.openapi.yaml; D-L78, D-L85, D-L90), on the
 * record timeline it shares with the contact's (`../timeline/record-timeline.ts`):
 * scope first, the query, both matrices once, field security before paging,
 * the activity item with its `version`.
 *
 * What only the account's timeline decides:
 *   - A PATH ID THAT IS NOT A UUID IS THE SAME 404 as an unreachable account,
 *     byte for byte (D-L90), never the 400 the other account operations give:
 *     nothing distinguishes a malformed id.
 *   - FIELD CHANGES ARE BY NAME ONLY, ALWAYS: `{ field, redacted: true }`,
 *     never `before` or `after`, whatever an audit row holds (D-L78: account
 *     audit records names; T-0078: an account has no value fields). Only
 *     Account wire names are items; anything else an audit row names gives
 *     no item (the repository is handed the allow-list), and there is never
 *     a `consent_changed` item.
 *   - FIELD SECURITY: the ACCOUNT matrix judges change items. `name` is never
 *     withheld (as on the Account itself); every other field follows its
 *     row, failing closed. An activity is on it through its `account_id`, so
 *     a withheld `account_id` hides every activity item.
 *   - A WITHHELD activity `contact_id` hides nothing here: the item carries no
 *     contact (the contact link is not on the activity item), and what put
 *     the activity on this timeline is its account link, judged above.
 *
 * NOTHING HERE LOGS: subjects and bodies hold names in practice, and an
 * account's name can be a person's.
 */

/** `AccountFieldChangedItem.field`'s enum, in contract order. */
export const ACCOUNT_TIMELINE_FIELDS = [
  'name',
  'ownerUserId',
  'industry',
  'tier',
  'tags',
  'phones',
  'state',
  'lga',
  'parentAccountId',
] as const;

const ACCOUNT_FIELDS = new Set<string>(ACCOUNT_TIMELINE_FIELDS);

// --- the wire ------------------------------------------------------------------

export type AccountChangeItemWire = TimelineItemBase & {
  type: 'field_changed';
  field: string;
  redacted: true;
};

export type AccountTimelineItemWire = AccountChangeItemWire | ActivityItemWire;

export type AccountTimelinePageWire = TimelinePage<AccountTimelineItemWire>;

// --- field security --------------------------------------------------------------

/**
 * The account audit change fields the caller may see on an account in
 * `programmeId`: `name` always, and every other Account field whose row is
 * readable there. A programme the matrix does not carry withholds them all.
 */
export function visibleAccountChangeFields(
  access: AccountFieldAccess,
  programmeId: string,
): string[] {
  return ACCOUNT_TIMELINE_FIELDS.filter(
    (field) =>
      field === 'name' ||
      (isWithholdableAccountField(field) &&
        accountFieldLevel(access, programmeId, field) !== 'none'),
  );
}

/** Always by name only. A name outside the Account fields gives no item. */
export function accountChangeItem(row: TimelineChangeRow): AccountChangeItemWire | null {
  if (!ACCOUNT_FIELDS.has(row.field)) return null;
  return { ...itemBase(row), type: 'field_changed', field: row.field, redacted: true };
}

/** The wire items for a page of account timeline rows. */
export function toAccountTimelineItems(
  rows: readonly TimelineRow[],
  activityAccess: ActivityFieldAccess,
  programmeId: string,
): AccountTimelineItemWire[] {
  return timelineItems(rows, activityAccess, programmeId, accountChangeItem);
}

// --- the operation -------------------------------------------------------------------

export const ACCOUNT_TIMELINE: RecordTimelineSpec<AccountFieldAccess, AccountChangeItemWire> = {
  subject: 'account',
  // getAccount's lookup (accounts.service.ts), so the two never disagree on reach.
  findRecordProgramme: async (tx, id) => (await findAccountById(tx, id))?.programmeId ?? null,
  loadRecordAccess: loadAccountFieldAccess,
  visibleChangeFields: visibleAccountChangeFields,
  changeItem: accountChangeItem,
  activityLink: 'accountId',
};

/** `params` is the raw path: a malformed id is the one 404, before anything is read. */
export async function listAccountTimelineFor(
  tx: TenantTx,
  params: unknown,
  query: unknown,
): Promise<AccountTimelinePageWire> {
  const parsed = AccountIdParam.safeParse(params);
  if (!parsed.success) throw notFound();
  return readRecordTimeline(tx, ACCOUNT_TIMELINE, parsed.data.accountId, query);
}
