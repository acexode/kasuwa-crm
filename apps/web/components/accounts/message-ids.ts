import type { MessageId } from '@kasuwa/i18n/bundle';
import { AccountTier } from '../../lib/accounts-api';
import { RecordsErrorCode } from '../../lib/records-api';
import { CRM_SHELL_MESSAGE_IDS } from '../crm/crm-nav';
import { ACCOUNT_COLUMNS, ACCOUNT_FILTERS, ACCOUNT_SORTS, sortLabel, tierLabel } from './accounts-model';

/**
 * The strings P04/03 needs, resolved on the SERVER (T-0057).
 *
 * **No `'use client'` in this file, ever** — a server component importing a
 * client module's array gets a proxy, which fails at request time and not at
 * compile time (`app/client-boundary.test.ts`). Only these strings cross the
 * wire; the catalogues stay on the server.
 *
 * `message-ids.test.ts` checks every id the accounts sources name is here.
 */
/**
 * What the sheet renders in EDIT mode (`account-sheet.tsx`), on its own so the
 * P05 account record (T-0063), which opens the same sheet to edit and never to
 * create, bundles exactly it and nothing of the create flow.
 */
export const ACCOUNT_EDIT_SHEET_MESSAGE_IDS: readonly MessageId[] = [
  'accounts.sheet.edit',
  'accounts.sheet.close',
  'accounts.sheet.offline',
  'accounts.sheet.cancel',
  'accounts.sheet.save',
  'accounts.sheet.saving',
  'accounts.field.name',
  'accounts.field.tags.hint',
  'accounts.field.phones',
  'accounts.field.phones.hint',
  'accounts.field.locked',
  'accounts.col.industry',
  'accounts.col.tier',
  'records.col.tags',
  'accounts.filter.state',
  'accounts.filter.lga',
  'records.cell.empty',
  'records.locked',
  ...AccountTier.options.map(tierLabel),
  'accounts.invalid.name',
  'accounts.invalid.tooLong',
  'accounts.invalid.tags',
  'accounts.invalid.phones',
  'accounts.error.fieldNotEditable',
  'accounts.error.notAccepted',
  // A field somebody else also changed, after a 409 re-read (the P05 record).
  'record.conflict.otherChange',
  ...RecordsErrorCode.options.map((code) => `records.error.${code}` as MessageId),
  'records.error.network',
];

/** What only CREATE renders: the title and the target programme. */
export const ACCOUNT_CREATE_ONLY_MESSAGE_IDS: readonly MessageId[] = [
  'accounts.sheet.create',
  'accounts.field.programme',
  'accounts.field.programme.choose',
  'accounts.field.programme.loading',
  'accounts.invalid.programme',
];

export const ACCOUNTS_MESSAGE_IDS: readonly MessageId[] = [
  ...CRM_SHELL_MESSAGE_IDS,
  'accounts.title',
  'records.search.numberHint',
  'records.search.useSearch',
  'accounts.programme.note',
  'accounts.programme.unknown',
  'records.programme.chip',
  'accounts.action.new',
  'accounts.action.edit',
  'accounts.search.label',
  'accounts.search.placeholder',
  'records.filter.label',
  'records.filter.active',
  'records.filter.clear',
  'records.filter.clearAll',
  'records.filter.done',
  'accounts.filter.locked',
  'accounts.filter.input',
  'accounts.filter.add',
  'accounts.filter.remove',
  ...ACCOUNT_FILTERS.map((filter) => filter.label),
  'records.owner.filter.me',
  'records.owner.filter.unassigned',
  ...AccountTier.options.map(tierLabel),
  'accounts.sort.label',
  'accounts.sort.current',
  ...ACCOUNT_SORTS.map(sortLabel),
  'records.columns.button',
  'records.columns.title',
  'records.columns.always',
  'records.columns.lockedNote',
  ...ACCOUNT_COLUMNS.map((column) => column.label),
  'accounts.col.actions',
  'records.locked',
  'records.locked.header',
  'records.cell.empty',
  'records.more',
  'records.owner.unassigned',
  'accounts.loading',
  'records.loadMore',
  'records.loadingMore',
  'accounts.empty.title',
  'accounts.empty.body',
  'accounts.noResults.title',
  'records.noResults.query',
  'records.noResults.filters',
  'records.noResults.clear',
  'records.offline.title',
  'records.offline.synced',
  'records.offline.never',
  'accounts.error.title',
  'accounts.error.fieldWithheld',
  'accounts.error.fieldNotEditable',
  'accounts.error.notAccepted',
  ...RecordsErrorCode.options.map((code) => `records.error.${code}` as MessageId),
  'records.error.network',
  'records.retry',
  ...ACCOUNT_EDIT_SHEET_MESSAGE_IDS,
  ...ACCOUNT_CREATE_ONLY_MESSAGE_IDS,
  'accounts.sheet.saved',
  // The "still connecting" state is the admin console's, word for word: the
  // same NFR, the same sentence, already translated.
  'admin.slow.title',
  'admin.slow.body',
  'admin.slow.switch',
];
