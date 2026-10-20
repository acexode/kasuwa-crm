import type { MessageId } from '@kasuwa/i18n/bundle';
import type { FilledIconName } from '@kasuwa/ui';

/**
 * The CRM app shell's main navigation (T-0130): the 72px icon rail at 1440 and
 * 1024 (P03, P04, P07), in the designs' order — Home, Inbox, Leads, Contacts,
 * Accounts, Activities, Deals, Tickets, Calls, Reports.
 *
 * Three kinds of entry:
 *   - BUILT (`href` set): a link where its flag is on in this process (the
 *     server's `crmLiveNav()`), and drawn disabled where it is off, so no entry
 *     ever leads to a 404.
 *   - NOT BUILT YET, with a module flag (`placeholder: true`): drawn, disabled,
 *     as the design draws it, only where `placeholder:<id>` is live
 *     (D-L194); not drawn at all where its flag is off.
 *   - Home: built by T-0132 (D-L196). Drawn disabled until it gains its `href`.
 *
 * Every icon but Reports' is in the filled face too (`icon-subset-filled.txt`),
 * because the phone bottom bar draws the active entry's icon filled (P26), and
 * Reports never sits on the bottom bar.
 *
 * No `'use client'`: the message ids are read on the server too.
 */

export interface CrmNavItem {
  readonly id: string;
  readonly label: MessageId;
  /** Reports' and Studio's glyphs are not in the filled face: they are never drawn filled. */
  readonly icon: FilledIconName | 'bar_chart' | 'account_tree';
  readonly href: string | null;
  /** An unbuilt module's entry, drawn only where its flag is on (`placeholder:<id>`). */
  readonly placeholder: boolean;
}

export const CRM_NAV: readonly CrmNavItem[] = [
  { id: 'home', label: 'records.nav.home', icon: 'home', href: null, placeholder: false },
  { id: 'inbox', label: 'records.nav.inbox', icon: 'forum', href: null, placeholder: true },
  { id: 'leads', label: 'records.nav.leads', icon: 'person_add', href: '/leads', placeholder: false },
  { id: 'contacts', label: 'records.nav.contacts', icon: 'contacts', href: '/contacts', placeholder: false },
  { id: 'accounts', label: 'records.nav.accounts', icon: 'domain', href: '/accounts', placeholder: false },
  { id: 'activities', label: 'records.nav.activities', icon: 'event_note', href: '/activities', placeholder: false },
  { id: 'deals', label: 'records.nav.deals', icon: 'handshake', href: '/pipelines', placeholder: false },
  { id: 'tickets', label: 'records.nav.tickets', icon: 'confirmation_number', href: null, placeholder: true },
  { id: 'calls', label: 'records.nav.calls', icon: 'headset_mic', href: null, placeholder: true },
  // P10 (T-0139): the design's "Studio", holding the script builder. No link until a
  // capability read says who may author (R3, T-0079); current on the script screens.
  { id: 'studio', label: 'records.nav.studio', icon: 'account_tree', href: null, placeholder: true },
  { id: 'reports', label: 'records.nav.reports', icon: 'bar_chart', href: null, placeholder: true },
];

/** The entry's link, or `null` when it is unbuilt or its flag is off here. */
export function liveHref(item: CrmNavItem, live: readonly string[]): string | null {
  return item.href !== null && live.includes(item.id) ? item.href : null;
}

/** The entries this process draws: every built one, and each placeholder whose flag is on. */
export function shownNav(live: readonly string[]): readonly CrmNavItem[] {
  return CRM_NAV.filter((item) => !item.placeholder || live.includes(`placeholder:${item.id}`));
}

/**
 * The phone bottom bar (P04/02, P03): Home, Inbox, the current object, Deals,
 * then More, which the shell draws. The third slot is the screen's own entry
 * when it is not already on the bar, and Contacts otherwise.
 */
export function bottomNav(live: readonly string[], current: string): readonly CrmNavItem[] {
  const shown = shownNav(live);
  const fixed = new Set(['home', 'inbox', 'deals']);
  const object =
    shown.find((item) => item.id === current && !fixed.has(item.id)) ??
    shown.find((item) => item.id === 'contacts');
  return [
    ...shown.filter((item) => item.id === 'home' || item.id === 'inbox'),
    ...(object === undefined ? [] : [object]),
    ...shown.filter((item) => item.id === 'deals'),
  ];
}

/**
 * The phone app bar's default title for screens that are not nav entries. Not
 * in the shell's bundle: each is already in its own screen's (the search
 * strings must stay out of a CRM page where `crm_search` is off, D-L137 L3).
 */
export const CRM_SCREEN_TITLES: Readonly<Record<string, MessageId>> = {
  search: 'search.title',
  notifications: 'notifications.title',
  scripts: 'scripting.builder.title',
};

export const CRM_SHELL_MESSAGE_IDS: readonly MessageId[] = [
  'app.name',
  'auth.topbar.language',
  'auth.topbar.language.current',
  'auth.topbar.lite',
  'auth.topbar.lite.on',
  'auth.topbar.lite.toggle',
  'auth.signOut',
  'auth.account',
  'records.nav.label',
  'records.nav.soon',
  'records.nav.more',
  'shell.search.placeholder',
  'design.components.kbd.search',
  'shell.menu.open',
  'shell.menu.close',
  'shell.back',
  ...CRM_NAV.map((item) => item.label),
];
