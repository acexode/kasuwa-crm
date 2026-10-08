import type { MessageId } from '@kasuwa/i18n/bundle';
import { ContactSource, RecordsErrorCode } from '../../lib/records-api';
import { CRM_SHELL_MESSAGE_IDS } from '../crm/crm-nav';
import { LEAD_COLUMNS, LEAD_FILTERS, LEAD_SORTS, LEAD_STATUSES, leadSortLabel, sourceLabel, statusLabel } from './leads-model';

/**
 * The strings P04/01 and P04/04 need, resolved on the SERVER (T-0058).
 *
 * **No `'use client'` in this file, ever** — a server component importing a
 * client module's array gets a proxy, which fails at request time and not at
 * compile time (`app/client-boundary.test.ts`). Only these strings cross the
 * wire; the catalogues stay on the server.
 *
 * `message-ids.test.ts` checks every id the leads sources name is here.
 */
export const LEADS_MESSAGE_IDS: readonly MessageId[] = [
  ...CRM_SHELL_MESSAGE_IDS,
  'leads.title',
  'leads.programme.note',
  'records.programme.chip',
  'leads.view.label',
  'leads.view.table',
  'leads.view.kanban',
  'leads.search.label',
  'leads.search.placeholder',
  'records.filter.label',
  'records.filter.active',
  'records.filter.clear',
  'records.filter.clearAll',
  'records.filter.done',
  'accounts.filter.locked',
  ...LEAD_FILTERS.map((filter) => filter.label),
  'records.owner.filter.me',
  'records.owner.filter.unassigned',
  'accounts.sort.label',
  'accounts.sort.current',
  ...LEAD_SORTS.map(leadSortLabel),
  ...LEAD_COLUMNS.map((column) => column.label),
  'accounts.col.actions',
  // The shared list pieces' column chooser (`list-parts.tsx`). This screen
  // draws no chooser, but the module names them, and a bundle that lacks an id
  // a rendered piece asks for throws at request time.
  'records.columns.title',
  'records.columns.always',
  'records.columns.lockedNote',
  // Every status a row can carry is drawn as a label, `customer` included
  // (a convert never demotes one); the board's columns are the lead stages.
  ...LEAD_STATUSES.map(statusLabel),
  statusLabel('customer'),
  ...ContactSource.options.map(sourceLabel),
  'records.locked',
  'records.locked.header',
  'records.cell.empty',
  'records.more',
  'records.owner.unassigned',
  // A former owner (T-0103, D-P23): the server sends no name, the row shows this.
  'records.owner.former',
  'leads.loading',
  'records.loadMore',
  'records.loadingMore',
  'leads.empty.title',
  'leads.empty.body',
  'leads.noResults.title',
  'records.noResults.query',
  'records.noResults.filters',
  'records.noResults.clear',
  'records.offline.title',
  'records.offline.synced',
  'records.offline.never',
  'leads.error.title',
  'leads.error.statusWithheld',
  'accounts.error.fieldWithheld',
  ...RecordsErrorCode.options.map((code) => `records.error.${code}` as MessageId),
  'records.error.network',
  'records.retry',
  'leads.kanban.label',
  'leads.kanban.hint',
  'leads.kanban.empty',
  'leads.move.button',
  'leads.move.menu',
  'leads.move.moved',
  'leads.move.error.notPermitted',
  'leads.move.error.stale',
  'leads.action.convert',
  'leads.convert.locked',
  'leads.convert.converted',
  'leads.convert.title',
  'leads.convert.body',
  'leads.convert.mode',
  'leads.convert.mode.existing',
  'leads.convert.mode.new',
  'leads.convert.search.label',
  'leads.convert.search.hint',
  'leads.convert.search.prompt',
  'leads.convert.search.loading',
  'leads.convert.search.none',
  'leads.convert.picked',
  'leads.convert.newName',
  'leads.convert.invalid.account',
  'accounts.invalid.name',
  'leads.convert.confirm',
  'leads.convert.converting',
  'leads.convert.offline',
  'leads.convert.lost',
  'leads.convert.done',
  'leads.convert.error.notPermitted',
  'leads.convert.error.stale',
  'leads.convert.error.accountNotFound',
  'leads.convert.error.already_linked',
  'accounts.error.fieldNotEditable',
  'accounts.error.notAccepted',
  'accounts.sheet.close',
  'accounts.sheet.cancel',
  // The "still connecting" state is the admin console's, word for word: the
  // same NFR, the same sentence, already translated.
  'admin.slow.title',
  'admin.slow.body',
  'admin.slow.switch',
];
