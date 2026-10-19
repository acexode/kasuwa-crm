import type { NotificationItem } from './notifications-api';

/**
 * Where an item's link goes, or `null` for no link at all (T-0101, I10).
 *
 * `live` is the object types whose record route is ON in this process. A link
 * is made ONLY from a well-formed uuid and ONLY to a route that answers, so no
 * link is ever a 404 and no `objectId` can steer the address (`../../admin`,
 * a query, a fragment). An activity and an import have no record route that
 * takes their id (C9): they go to their list screen where that is live.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RECORD_ROUTE: Readonly<Record<string, string>> = {
  contact: '/contacts/',
  account: '/accounts/',
  deal: '/deals/',
};

export function notificationHref(
  item: Pick<NotificationItem, 'objectType' | 'objectId'> | { readonly objectType?: unknown; readonly objectId?: unknown },
  live: readonly string[],
): string | null {
  const type = typeof item.objectType === 'string' ? item.objectType : '';
  const id = item.objectId;
  // Every link needs a well-formed id, even the list screens that never print it: an id that is not a uuid is a notification that cannot be trusted to point anywhere.
  if (!live.includes(type) || typeof id !== 'string' || !UUID.test(id)) return null;
  const record = RECORD_ROUTE[type];
  if (record !== undefined) return `${record}${id}`;
  // The list screens: nothing takes the id, so they link only where their own screen is on.
  if (type === 'activity' && live.includes('activity')) return '/activities';
  if (type === 'import' && live.includes('import')) return '/contacts/import';
  return null;
}

/**
 * The object types whose route is on in this process, from the ids
 * `crmLiveNav()` sent (`notifications:<type>`, added only where the bell is on:
 * the server decides, because a contact record needs two flags). No flag is
 * named in the browser.
 */
export function liveObjectTypes(live: readonly string[]): readonly string[] {
  return live.filter((id) => id.startsWith('notifications:')).map((id) => id.slice('notifications:'.length));
}
