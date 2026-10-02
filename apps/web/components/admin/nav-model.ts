import type { MessageId } from '@kasuwa/i18n';
import type { IconName } from '@kasuwa/ui';

/**
 * `P02/A1` — the settings menu.
 *
 * **The structure is the client's, not the server's**, and the contract says so
 * in as many words (`GET /settings-menu/badges`): ten groups and their items are
 * presentation, and a server-rendered navigation tree would make every label a
 * deployment. Only the numbers are data, and they arrive keyed by `settingId`.
 *
 * `settingId` is the join. It is what a badge is keyed on, what a health check's
 * "Fix" button routes to, and what an alert points at — so the ids here are
 * transcribed from the design export and must not be renamed for tidiness.
 *
 * `href` is `null` for everything not built yet. A menu entry that navigates to
 * a 404 is worse than one that is visibly not ready, and the same rule applies
 * here as to the language menu: offering less is better than offering a promise
 * the product breaks when somebody accepts it.
 */

export interface NavItem {
  readonly settingId: string;
  readonly label: MessageId;
  readonly href: string | null;
}

export interface NavGroup {
  readonly id: string;
  readonly label: MessageId;
  readonly icon: IconName;
  readonly items: readonly NavItem[];
}

function item(settingId: string, label: MessageId, href: string | null = null): NavItem {
  return { settingId, label, href };
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'company',
    label: 'admin.nav.group.company',
    icon: 'domain',
    items: [
      item('c-profile', 'admin.nav.item.c-profile'),
      item('c-bu', 'admin.nav.item.c-bu'),
      item('c-fy', 'admin.nav.item.c-fy'),
      item('c-fx', 'admin.nav.item.c-fx'),
      item('c-hours', 'admin.nav.item.c-hours'),
    ],
  },
  {
    id: 'users',
    label: 'admin.nav.group.users',
    icon: 'group',
    items: [
      item('u-users', 'admin.nav.item.u-users'),
      item('roles', 'admin.nav.item.roles'),
      item('u-perm', 'admin.nav.item.u-perm'),
      item('fls', 'admin.nav.item.fls'),
      item('u-share', 'admin.nav.item.u-share'),
      item('u-sso', 'admin.nav.item.u-sso'),
      item('u-mfa', 'admin.nav.item.u-mfa'),
      item('u-ip', 'admin.nav.item.u-ip'),
      item('u-sess', 'admin.nav.item.u-sess'),
    ],
  },
  {
    id: 'bpo',
    label: 'admin.nav.group.bpo',
    icon: 'support_agent',
    items: [
      item('b-clients', 'admin.nav.item.b-clients'),
      item('programmes', 'admin.nav.item.programmes', '/admin/programmes'),
      item('b-sla', 'admin.nav.item.b-sla'),
      item('b-ret', 'admin.nav.item.b-ret'),
      item('b-disp', 'admin.nav.item.b-disp'),
      item('b-scripts', 'admin.nav.item.b-scripts'),
      item('b-qa', 'admin.nav.item.b-qa'),
      item('b-brand', 'admin.nav.item.b-brand'),
    ],
  },
  {
    id: 'channels',
    label: 'admin.nav.group.channels',
    icon: 'forum',
    items: [
      item('ch-wa', 'admin.nav.item.ch-wa'),
      item('ch-sms', 'admin.nav.item.ch-sms'),
      item('ch-ussd', 'admin.nav.item.ch-ussd'),
      item('ch-email', 'admin.nav.item.ch-email'),
      item('ch-phone', 'admin.nav.item.ch-phone'),
    ],
  },
  {
    id: 'data',
    label: 'admin.nav.group.data',
    icon: 'database',
    items: [
      item('d-io', 'admin.nav.item.d-io'),
      item('d-dedup', 'admin.nav.item.d-dedup'),
      item('d-bin', 'admin.nav.item.d-bin'),
      item('d-ret', 'admin.nav.item.d-ret'),
    ],
  },
  {
    id: 'compliance',
    label: 'admin.nav.group.compliance',
    icon: 'verified_user',
    items: [
      item('co-consent', 'admin.nav.item.co-consent'),
      item('co-dnd', 'admin.nav.item.co-dnd'),
      item('co-dpia', 'admin.nav.item.co-dpia'),
      item('co-dsr', 'admin.nav.item.co-dsr'),
      item('co-xb', 'admin.nav.item.co-xb'),
      item('audit', 'admin.nav.item.audit'),
    ],
  },
  {
    id: 'custom',
    label: 'admin.nav.group.custom',
    icon: 'tune',
    items: [
      item('cu-obj', 'admin.nav.item.cu-obj'),
      item('cu-fields', 'admin.nav.item.cu-fields'),
      item('cu-layouts', 'admin.nav.item.cu-layouts'),
      item('cu-val', 'admin.nav.item.cu-val'),
      item('cu-rt', 'admin.nav.item.cu-rt'),
    ],
  },
  { id: 'automation', label: 'admin.nav.group.automation', icon: 'bolt', items: [] },
  { id: 'integrations', label: 'admin.nav.group.integrations', icon: 'extension', items: [] },
  { id: 'billing', label: 'admin.nav.group.billing', icon: 'payments', items: [] },
];

/** Every message id the menu needs, so the server can bundle exactly these. */
export const NAV_MESSAGE_IDS: readonly MessageId[] = NAV_GROUPS.flatMap((group) => [
  group.label,
  ...group.items.map((navItem) => navItem.label),
]);

/**
 * The groups that match `query`, with non-matching items removed.
 *
 * A group whose own label matches keeps all of its items — somebody typing
 * "channels" wants the channels group, not an empty one. Matching is
 * accent- and case-insensitive through `localeCompare`-grade normalisation,
 * because "Fiscal" and "fiscal" are the same word and so are "Yorùbá" and
 * "Yoruba" when somebody is typing quickly on a phone keyboard.
 */
export function filterNav(
  groups: readonly NavGroup[],
  query: string,
  label: (id: MessageId) => string,
): readonly NavGroup[] {
  const needle = fold(query);
  if (needle === '') return groups;

  const matched: NavGroup[] = [];
  for (const group of groups) {
    if (fold(label(group.label)).includes(needle)) {
      matched.push(group);
      continue;
    }
    const items = group.items.filter((navItem) => fold(label(navItem.label)).includes(needle));
    if (items.length > 0) matched.push({ ...group, items });
  }
  return matched;
}

function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}
