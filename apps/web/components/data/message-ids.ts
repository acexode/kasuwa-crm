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

/** Migration (B), the Export centre (D) and Data-subject requests (E), drawn empty (D-L194). */
export const DATA_PLACEHOLDER_MESSAGE_IDS: readonly MessageId[] = [
  'data.soon',
  'import.steps.label',
  'import.steps.compact',
  'data.migration.title',
  'data.migration.lede',
  'data.migration.step.connect',
  'data.migration.step.choose',
  'data.migration.step.mapping',
  'data.migration.step.dryRun',
  'data.migration.step.migrate',
  'data.migration.source',
  'data.migration.zoho',
  'data.migration.zoho.initial',
  'data.migration.zoho.body',
  'data.migration.salesforce',
  'data.migration.salesforce.initial',
  'data.migration.salesforce.body',
  'data.migration.connect.title',
  'data.migration.connect.body',
  'data.migration.connect.action',
  'data.migration.read',
  'data.migration.noWrite',
  'data.migration.disconnect',
  'data.migration.bar',
  'data.migration.next',
  'data.exports.title',
  'data.exports.lede',
  'data.exports.new',
  'data.exports.filter',
  'data.exports.filter.all',
  'data.exports.filter.waiting',
  'data.exports.filter.ready',
  'data.exports.filter.rejected',
  'data.exports.filter.expired',
  'data.exports.empty.title',
  'data.exports.empty.body',
  'data.exports.detail',
  'data.exports.detail.title',
  'data.exports.detail.body',
  'data.requests.title',
  'data.requests.lede',
  'data.requests.log',
  'data.requests.none',
  'data.requests.tile.open',
  'data.requests.tile.due',
  'data.requests.tile.overdue',
  'data.requests.tile.completed',
  'data.requests.col.request',
  'data.requests.col.type',
  'data.requests.col.received',
  'data.requests.col.stage',
  'data.requests.col.left',
  'data.requests.empty.title',
  'data.requests.empty.body',
];
