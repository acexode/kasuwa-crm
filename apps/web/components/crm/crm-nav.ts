import type { MessageId } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';

/**
 * The CRM app shell's main navigation (P04, `nav` in the List Screen export):
 * Home, Inbox, Leads, Contacts, Accounts, Deals, Tickets, Reports.
 *
 * `href: null` means NOT BUILT, and an unbuilt destination is drawn as a
 * non-link. A menu entry that navigates to a 404 is worse than one that
 * visibly does nothing — the same rule as the admin settings menu and the
 * language menu. Each entry gains its `href` when its screen ships.
 *
 * A BUILT screen is still behind its flag (`crm_records`, `crm_accounts`,
 * `crm_leads`, `crm_activities`, `crm_pipeline`), so
 * an `href` alone does not make a link: the shell links only the ids the
 * server says are on in this process (`crmLiveNav()` in
 * `lib/feature-flags.ts`), and draws the rest like an unbuilt entry.
 *
 * No `'use client'`: the message ids are read on the server too.
 */

export interface CrmNavItem {
  readonly id: string;
  readonly label: MessageId;
  readonly icon: IconName;
  readonly href: string | null;
  /** One of the five on the 360 px bottom bar. */
  readonly mobile: boolean;
}

export const CRM_NAV: readonly CrmNavItem[] = [
  { id: 'home', label: 'records.nav.home', icon: 'space_dashboard', href: null, mobile: true },
  { id: 'inbox', label: 'records.nav.inbox', icon: 'forum', href: null, mobile: true },
  { id: 'leads', label: 'records.nav.leads', icon: 'person_add', href: '/leads', mobile: false },
  { id: 'contacts', label: 'records.nav.contacts', icon: 'contacts', href: '/contacts', mobile: true },
  { id: 'accounts', label: 'records.nav.accounts', icon: 'domain', href: '/accounts', mobile: false },
  { id: 'activities', label: 'records.nav.activities', icon: 'task_alt', href: '/activities', mobile: false },
  { id: 'deals', label: 'records.nav.deals', icon: 'handshake', href: '/pipelines', mobile: true },
  { id: 'tickets', label: 'records.nav.tickets', icon: 'confirmation_number', href: null, mobile: false },
  { id: 'reports', label: 'records.nav.reports', icon: 'bar_chart', href: null, mobile: true },
];

/** The entry's link, or `null` when it is unbuilt or its flag is off here. */
export function liveHref(item: CrmNavItem, live: readonly string[]): string | null {
  return item.href !== null && live.includes(item.id) ? item.href : null;
}

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
  ...CRM_NAV.map((item) => item.label),
];
