import type { MessageId } from '@kasuwa/i18n/bundle';
import { CRM_SHELL_MESSAGE_IDS } from '../crm/crm-nav';
import { SEARCH_PANEL_MESSAGE_IDS } from './message-ids';

/**
 * The strings `/search` sends (T-0087): the CRM shell's, the search panel's
 * (always: the route answers only where `crm_search` is on), and the screen's own.
 * A separate module from `message-ids.ts` because the shell's list imports
 * that one. **No `'use client'`, ever.**
 */
export const SEARCH_MESSAGE_IDS: readonly MessageId[] = [
  ...CRM_SHELL_MESSAGE_IDS,
  ...SEARCH_PANEL_MESSAGE_IDS,
  'search.intro',
  // T-0138: the results page (P27/C).
  'search.results.title',
  'search.results.sub',
  'search.results.subLookup',
  'search.results.back',
  'search.results.list',
  'search.sort.label',
  'search.sort.best',
  'search.sort.recent',
  'search.filters.title',
  'search.filters.clear',
  'search.filters.object',
  'search.filters.owner',
  'search.filters.anyone',
  'search.filters.updated',
  'search.col.owner',
  'search.col.updated',
  'search.col.none',
];
