import * as z from 'zod/mini';
import { ACCOUNTS_PATH, Account } from './accounts-api';
import { ActivityItem } from './contact-record-api';
import { ContactPage, requestRecords, type RecordsResult } from './records-api';

/**
 * The browser's half of the P05 account record (T-0063): `getAccount`,
 * `listAccountContacts` and `listAccountTimeline` from
 * `docs/api/records.openapi.yaml`. The writes are the ones the other screens
 * already use: `updateAccount` (`accounts-api.ts`, through T-0057's sheet) and
 * `createActivity` / `completeActivity` (`contact-record-api.ts`, with the
 * account as the target).
 *
 * SAME-ORIGIN, PARSED, AND NEVER SCOPED BY THE CALLER. Relative
 * `/api/v1/...` paths through `requestRecords`, every answer Zod-parsed and
 * kept out of the browser cache. No function here takes a programme, and no
 * request carries one: the session decides what the caller reaches.
 *
 * CURSORS ARE OPAQUE. Echoed exactly as served, for the account they were
 * served for, never parsed, built or put in the address bar.
 */

function accountPath(id: string): string {
  return `${ACCOUNTS_PATH}/${encodeURIComponent(id)}`;
}

function withCursor(cursor: string | null): string {
  return cursor === null ? '' : `?${new URLSearchParams({ cursor }).toString()}`;
}

export function getAccount(id: string, signal?: AbortSignal): Promise<RecordsResult<Account>> {
  return requestRecords(accountPath(id), Account, { method: 'GET', ...(signal === undefined ? {} : { signal }) });
}

/**
 * One page of the account's contacts, in the server's default order (name).
 * No `limit`: the server's 25, and a short page is NOT the last page — only a
 * `null` cursor is. When the caller's role cannot see a contact's account
 * link, this is `400` with `details[].code: field_withheld` (never rows).
 */
export function listAccountContacts(id: string, cursor: string | null, signal?: AbortSignal): Promise<RecordsResult<ContactPage>> {
  return requestRecords(`${accountPath(id)}/contacts${withCursor(cursor)}`, ContactPage, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  });
}

/** The Account fields an account timeline item can name (`AccountFieldChangedItem.field`). */
export const AccountTimelineField = z.enum(['name', 'ownerUserId', 'industry', 'tier', 'tags', 'phones', 'state', 'lga', 'parentAccountId']);
export type AccountTimelineField = z.infer<typeof AccountTimelineField>;

/** A change by name only, always (D-L78, D-L90): no `before`, no `after`, and nothing here could carry one. */
const AccountFieldChangedItem = z.object({
  id: z.string(),
  type: z.literal('field_changed'),
  occurredAt: z.string(),
  actor: z.nullable(z.object({ id: z.string(), displayName: z.string() })),
  field: AccountTimelineField,
  redacted: z.literal(true),
});

/** The contact timeline's activity item, with the `version` T-0080 made required. */
const AccountActivityItem = z.extend(ActivityItem, { version: z.int() });

export const AccountTimelineItem = z.discriminatedUnion('type', [AccountFieldChangedItem, AccountActivityItem]);
export type AccountTimelineItem = z.infer<typeof AccountTimelineItem>;

export const AccountTimelinePage = z.object({
  data: z.array(AccountTimelineItem),
  nextCursor: z.nullable(z.string()),
});
export type AccountTimelinePage = z.infer<typeof AccountTimelinePage>;

/** No `limit`: the server's 25 is above the 20 a first page must hold. */
export function listAccountTimeline(id: string, cursor: string | null, signal?: AbortSignal): Promise<RecordsResult<AccountTimelinePage>> {
  return requestRecords(`${accountPath(id)}/timeline${withCursor(cursor)}`, AccountTimelinePage, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  });
}
