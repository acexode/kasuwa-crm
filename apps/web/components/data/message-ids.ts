import type { MessageId } from '@kasuwa/i18n/bundle';
import { ADMIN_SHELL_MESSAGE_IDS } from '../admin/message-ids';
import { withNotificationMessages } from '../notifications/message-ids';

/**
 * The strings P28's Data management frame needs (T-0141), resolved on the
 * SERVER. **No `'use client'` in this file, ever** (see
 * `components/admin/message-ids.ts`).
 */
export const DATA_SHELL_MESSAGE_IDS: readonly MessageId[] = [
  ...ADMIN_SHELL_MESSAGE_IDS,
  'data.shell.title',
  'data.nav.import',
  'data.nav.migration',
  'data.nav.duplicates',
  'data.nav.exports',
  'data.nav.requests',
  'records.nav.soon',
];

/** A section's own ids plus the frame's, and the bell's when it is on. */
export function withDataShell(ids: readonly MessageId[], bell: boolean): readonly MessageId[] {
  return withNotificationMessages([...new Set([...DATA_SHELL_MESSAGE_IDS, ...ids])], bell ? ['notifications'] : []);
}
