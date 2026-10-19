import type { MessageId } from '@kasuwa/i18n/bundle';
import type { NotificationKind } from '../../lib/notifications-api';

/**
 * The strings the P26 bell, its dropdown and the centre need (T-0101),
 * resolved on the SERVER.
 *
 * **No `'use client'` in this file, ever** (see `components/admin/message-ids.ts`):
 * a server component importing a client module's array gets a proxy that fails
 * at request time.
 *
 * The bell is in the shell of every CRM and admin screen and its dropdown loads
 * on first open, but the dropdown's WORDS must already be on the page, in the
 * language the page was rendered in. So every shell page bundles them, but ONLY
 * where the notifications flag is live (`withNotificationMessages`): a process
 * without the bell sends none of its words to a 256 kbps user. The centre's own
 * words are bundled by `/notifications` alone.
 */

export function kindLabel(kind: NotificationKind): MessageId {
  switch (kind) {
    case 'record_assigned':
      return 'notifications.kind.record_assigned';
    case 'task_assigned':
      return 'notifications.kind.task_assigned';
    case 'import_finished':
      return 'notifications.kind.import_finished';
  }
}

/** What the bell itself draws on every page. */
export const BELL_MESSAGE_IDS: readonly MessageId[] = [
  'notifications.bell.label',
  'notifications.bell.labelCount',
  'notifications.bell.labelCapped',
  'notifications.announce.rise',
  'notifications.announce.riseCapped',
  'notifications.dropdown.title',
  'notifications.dropdown.close',
  'notifications.error.title',
  'records.retry',
];

/** What the dropdown and the list rows draw: the words that wait for the first open. */
export const LIST_MESSAGE_IDS: readonly MessageId[] = [
  'notifications.viewAll',
  'notifications.readAll',
  'notifications.caughtUp.title',
  'notifications.caughtUp.body',
  'notifications.loading',
  'notifications.slow',
  'notifications.error.write',
  'notifications.kind.record_assigned',
  'notifications.kind.task_assigned',
  'notifications.kind.import_finished',
  'notifications.toggle.markRead',
  'notifications.toggle.markUnread',
  'notifications.day.today',
  'notifications.day.yesterday',
  'notifications.sentence.record_assigned.contact',
  'notifications.sentence.record_assigned.account',
  'notifications.sentence.record_assigned.deal',
  'notifications.sentence.task_assigned.activity',
  'notifications.sentence.import_finished.import',
  'records.error.validation_failed',
  'records.error.not_authenticated',
  'records.error.too_many_requests',
  'records.error.internal_error',
  'records.error.network',
];

/** What the centre adds to what every shell page already carries where the bell is on (`/notifications` answers only there). */
export const CENTRE_MESSAGE_IDS: readonly MessageId[] = [
  'notifications.title',
  'notifications.filter.label',
  'notifications.filter.all',
  'notifications.filter.unread',
  'notifications.kind.label',
  'notifications.kind.all',
  'notifications.readAllKind',
  'notifications.more',
  'notifications.empty.title',
  'notifications.empty.unreadTitle',
  'notifications.empty.body',
];

/** A shell page's bundle, plus the bell's strings where the notifications flag is live (`live` is `crmLiveNav()`, or the admin menu's keys). */
export function withNotificationMessages(ids: readonly MessageId[], live: readonly string[]): readonly MessageId[] {
  return live.includes('notifications') ? [...ids, ...BELL_MESSAGE_IDS, ...LIST_MESSAGE_IDS] : ids;
}

/** The translated words for a failure code of a notifications operation: `records.error.<code>`, an unknown code reading as an internal error. */
export function errorMessageId(code: string): MessageId {
  switch (code) {
    case 'validation_failed':
      return 'records.error.validation_failed';
    case 'not_authenticated':
      return 'records.error.not_authenticated';
    case 'too_many_requests':
      return 'records.error.too_many_requests';
    case 'network':
      return 'records.error.network';
    default:
      return 'records.error.internal_error';
  }
}
