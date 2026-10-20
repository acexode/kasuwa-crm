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
  // T-0138: the P27 top-bar field and dropdown (A–A5), the shared row parts and the palette (D–D2).
  'search.field.clear',
  'search.field.slashHint',
  'search.key.slash',
  'search.key.ctrl',
  'search.commands.label',
  'search.commands.open',
  'search.footer.move',
  'search.footer.open',
  'search.footer.close',
  'search.footer.run',
  'search.footer.commands',
  'search.footer.keys',
  'search.seeAllResults',
  'search.chip.label',
  'search.chip.all',
  'search.filter.owner.any',
  'search.filter.owner.me',
  'search.filter.time.any',
  'search.filter.time.week',
  'search.filter.time.month',
  'search.phone.title',
  'search.phone.body',
  'search.recent.title',
  'search.recent.empty',
  'search.viewed.title',
  'search.viewed.empty',
  'search.loading.line',
  'search.noMatch.title',
  'search.noMatch.lookupBody',
  'search.create.contactNamed',
  'search.create.contact',
  'search.create.lead',
  'search.filtered.title',
  'search.filtered.body',
  'search.filtered.clear',
  'search.type.contact',
  'search.type.lead',
  'search.type.account',
  'search.type.deal',
  'search.scope.title',
  'search.scope.all',
  'search.scope.menu',
  'search.scope.note',
  'search.scope.placeholder',
  'search.scope.narrowUnavailable',
  'search.palette.label',
  'search.palette.placeholder',
  'search.palette.suggested',
  'search.palette.actions',
  'search.palette.goTo',
  'search.cmd.createLead',
  'search.cmd.createLead.hint',
  'search.cmd.call',
  'search.cmd.call.hint',
  'search.cmd.createTicket',
  'search.cmd.createTicket.hint',
  'search.cmd.switch',
  'search.cmd.switch.hint',
  'search.cmd.wallboard',
  'search.cmd.wallboard.hint',
  'search.cmd.liteOn',
  'search.cmd.liteOn.hint',
  'search.cmd.liteOff',
  'search.cmd.liteOff.hint',
  'search.cmd.unavailable',
  'search.switch.chip',
  'search.switch.back',
  'search.switch.placeholder',
  'search.switch.title',
  'search.switch.note',
  'search.switch.empty',
  'records.action.unavailable',
  'design.components.kbd.escape',
  'design.components.kbd.search',
  'records.status.new',
  'records.status.contacted',
  'records.status.qualified',
  'records.status.unqualified',
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
  // T-0138: the top-bar field, its Commands button and the scope pill, drawn by the shell's own chunk.
  fieldLabel: 'search.input.label',
  clear: 'search.field.clear',
  slashHint: 'search.field.slashHint',
  slashKey: 'search.key.slash',
  commands: 'search.commands.label',
  commandsOpen: 'search.commands.open',
  scopeTitle: 'search.scope.title',
  scopeAll: 'search.scope.all',
  scopePlaceholder: 'search.scope.placeholder',
} as const satisfies Readonly<Record<string, MessageId>>;

/**
 * The palette's and dropdown's "Ask AI" strings (T-0138), drawn only where
 * `ai_assistant` is on (D-L194). Bundled only then too, as T-0136 does for the
 * P07 placeholders: a page with no assistant sends none of its words, which
 * is both bytes at 256 kbps and a promise the page never shows (T-0150).
 */
export const SEARCH_AI_MESSAGE_IDS: readonly MessageId[] = [
  'search.footer.askAi',
  'search.footer.commandsAi',
  'search.palette.ai',
  'search.ai.ask',
  'search.ai.ask.hint',
  'search.ai.askQuery',
  'search.ai.askQuery.hint',
];

/**
 * A CRM page's bundle, plus the search's strings where `crm_search` is live
 * (`live` is `crmLiveNav()`), and the AI ones only where `ai_assistant` is too.
 */
export function withSearchMessages(ids: readonly MessageId[], live: readonly string[]): readonly MessageId[] {
  if (!live.includes('search')) return ids;
  return live.includes('ai_assistant')
    ? [...ids, ...SEARCH_PANEL_MESSAGE_IDS, ...SEARCH_AI_MESSAGE_IDS]
    : [...ids, ...SEARCH_PANEL_MESSAGE_IDS];
}

