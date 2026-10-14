import type { MessageId } from '@kasuwa/i18n/bundle';
import type { SearchType } from '../../lib/search-api';

/**
 * The strings the P27 search panel needs (T-0087), resolved on the SERVER.
 *
 * **No `'use client'` in this file, ever** (see `components/admin/message-ids.ts`):
 * a server component importing a client module's array gets a proxy that fails
 * at request time.
 *
 * The panel is drawn on `/search` AND in the command palette, which sits in
 * the CRM shell of every screen and loads on first open (R29). The palette's
 * CODE is fetched when it is first opened, but its words must already be on
 * the page, in the language (or the `?locale=` preview) the page was rendered
 * in. So every CRM page bundles them — but ONLY where `crm_search` is live
 * (`withSearchMessages`, D-L137 L3): a process without the search sends none
 * of its words to a 256 kbps user.
 */

export function groupLabel(type: SearchType): MessageId {
  return `search.group.${type}`;
}

export function seeAllLabel(type: 'contact' | 'lead' | 'account'): MessageId {
  return `search.seeAll.${type}`;
}

export const SEARCH_PANEL_MESSAGE_IDS: readonly MessageId[] = [
  'search.title',
  'search.palette.title',
  'search.palette.close',
  'search.palette.keys',
  'search.input.label',
  'search.input.placeholder',
  'search.results.label',
  groupLabel('contact'),
  groupLabel('lead'),
  groupLabel('account'),
  groupLabel('deal'),
  seeAllLabel('contact'),
  seeAllLabel('lead'),
  seeAllLabel('account'),
  'search.loading',
  'search.empty.title',
  'search.empty.body',
  'search.error.title',
  'search.error.body',
  'search.invalidPhone',
  'search.invalidEmail',
  'search.keepTyping',
  'search.hit.nameWithheld',
  'search.results.count',
  'records.retry',
  'records.error.not_authenticated',
  'records.error.too_many_requests',
  'records.error.validation_failed',
];

/**
 * The search strings the CRM shell itself draws (the header entry, and the
 * palette's loading and failed states, which live in the shell because they
 * must work when the palette's chunk does not arrive). Named here, not as
 * literals in the shell, because the shell draws them only where the search is
 * live, and that is exactly when `withSearchMessages` bundles them.
 */
export const SHELL_SEARCH_STRINGS = {
  entry: 'search.title',
  loading: 'search.loading',
  failedTitle: 'search.error.title',
  failedBody: 'search.error.body',
  retry: 'records.retry',
  close: 'search.palette.close',
} as const satisfies Readonly<Record<string, MessageId>>;

/** A CRM page's bundle, plus the search's strings where `crm_search` is live (`live` is `crmLiveNav()`). */
export function withSearchMessages(ids: readonly MessageId[], live: readonly string[]): readonly MessageId[] {
  return live.includes('search') ? [...ids, ...SEARCH_PANEL_MESSAGE_IDS] : ids;
}

