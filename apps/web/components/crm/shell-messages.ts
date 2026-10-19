import type { MessageId } from '@kasuwa/i18n/bundle';
import { withNotificationMessages } from '../notifications/message-ids';
import { withSearchMessages } from '../search/message-ids';

/**
 * A CRM page's bundle with everything the shell itself may draw: the search's
 * strings where `crm_search` is live and the bell's where `crm_notifications`
 * is (`live` is `crmLiveNav()`). Every CRM page calls this and nothing else
 * for the shell's words, so a new shell feature is one edit here, not fourteen.
 *
 * No `'use client'` in this file.
 */
export function withShellMessages(ids: readonly MessageId[], live: readonly string[]): readonly MessageId[] {
  return withNotificationMessages(withSearchMessages(ids, live), live);
}
