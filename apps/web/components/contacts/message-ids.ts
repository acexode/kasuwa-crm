import type { MessageId } from '@kasuwa/i18n/bundle';
import { ContactSource, ContactStatus, ConsentState, PreferredChannel, RecordsErrorCode } from '../../lib/records-api';
import { CRM_SHELL_MESSAGE_IDS } from '../crm/crm-nav';
import { COLUMNS, FILTERS, optionLabel } from './contacts-model';

/**
 * The strings P04/02 needs, resolved on the SERVER (T-0042).
 *
 * **No `'use client'` in this file, ever** — the same rule as
 * `components/admin/message-ids.ts`: a server component importing a client
 * module's array gets a proxy, which fails at request time and not at compile
 * time. And only these strings cross the wire; the catalogues stay on the
 * server.
 */
export const CONTACTS_MESSAGE_IDS: readonly MessageId[] = [
  ...CRM_SHELL_MESSAGE_IDS,
  'records.title',
  'records.programme.chip',
  'records.programme.note',
  'records.action.import',
  'records.action.new',
  'records.action.unavailable',
  'records.search.label',
  'records.search.placeholder',
  'records.search.numberHint',
  'records.search.useSearch',
  'records.name.withheld',
  'records.filter.label',
  'records.filter.active',
  'records.filter.clear',
  'records.filter.clearAll',
  'records.filter.done',
  'records.filter.sheet.close',
  'records.filter.sheet.apply',
  ...FILTERS.flatMap((filter) => [filter.label, ...filter.options.map((value) => optionLabel(filter.key, value))]),
  'records.columns.button',
  'records.columns.title',
  'records.columns.always',
  'records.columns.lockedNote',
  ...COLUMNS.map((column) => column.label),
  'records.locked',
  'records.locked.header',
  'records.cell.empty',
  'records.more',
  'records.owner.assigned',
  'records.owner.unassigned',
  'records.account.linked',
  'records.account.none',
  'records.wa.in',
  'records.wa.out',
  'records.dnd.badge',
  'records.dnd.label',
  ...ContactStatus.options.map((value) => `records.status.${value}` as MessageId),
  ...ContactSource.options.map((value) => `records.source.${value}` as MessageId),
  ...ConsentState.options.map((value) => `records.consent.${value}` as MessageId),
  ...PreferredChannel.options.map((value) => `records.channel.${value}` as MessageId),
  'records.loading',
  'records.loadMore',
  'records.loadingMore',
  'records.empty.title',
  'records.empty.body',
  'records.empty.import.title',
  'records.empty.import.body',
  'records.empty.import.action',
  'records.empty.capture.title',
  'records.empty.capture.body',
  'records.empty.capture.action',
  'records.empty.later',
  'records.noResults.title',
  'records.noResults.query',
  'records.noResults.filters',
  'records.noResults.clear',
  'records.offline.title',
  'records.offline.synced',
  'records.offline.never',
  'records.error.title',
  ...RecordsErrorCode.options.map((code) => `records.error.${code}` as MessageId),
  'records.error.network',
  'records.retry',
  // The "still connecting" state is the admin console's, word for word: the
  // same NFR, the same sentence, already translated.
  'admin.slow.title',
  'admin.slow.body',
  'admin.slow.switch',
];

/**
 * The words of the "filtered by one import" chip (T-0096, N9), bundled only
 * where the import is live (`live.includes('import')`): a process without it
 * sends none of them to a 256 kbps user.
 */
export const CONTACTS_IMPORT_MESSAGE_IDS: readonly MessageId[] = ['records.importFilter.note', 'records.importFilter.clear'];

/** The words of the link to the duplicates screen (T-0097), bundled only where it is live (`live.includes('duplicates')`). */
export const CONTACTS_DUPLICATES_MESSAGE_IDS: readonly MessageId[] = ['records.action.duplicates'];
