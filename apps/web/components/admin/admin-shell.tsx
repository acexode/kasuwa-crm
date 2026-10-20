'use client';

import Link from 'next/link';
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  createBundleTranslator,
  type MessageBundle,
  type MessageId,
  type Translator,
} from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import type { LanguageOption } from '../auth/language-menu';
import { AccountMenu, moveInMenu } from '../shell/account-menu';
import { Brand, SHELL_FOCUS } from '../shell/shell-parts';
import { NAV_GROUPS, filterNav, type NavGroup } from './nav-model';
import { getHomeSummary, getSettingsMenuBadges, type Severity } from '../../lib/admin-api';
import { useResource } from './use-resource';

/**
 * `P02/A1` — the admin frame (rebuilt to P02 and P18 by T-0130): top bar,
 * residency pill and the settings menu.
 *
 * THE TOP BAR (60px, 0 16px, gap 12): the logo, the wordmark and the "Admin"
 * pill; the tenant switcher (from 1280 up, as P02 draws it at 1440 and drops
 * it at 1024); a spacer; the residency pill ("Data stored in: South Africa
 * (af-south-1)", the region in bold); help; the bell; and the 36px avatar
 * menu, which holds lite mode, the language and Sign out.
 *
 * ---------------------------------------------------------------------------
 * THE MENU IS A SIDEBAR ON DESKTOP AND A DRAWER BELOW 1280, AND IT IS ONE TREE.
 *
 * Not two components and not two DOM trees. Rendering it twice is how the
 * search box, the expanded/collapsed state and the `aria-current` mark drift
 * apart — and how a tablet user ends up with a menu that filters and a desktop
 * user with one that does not. The breakpoint changes position and nothing
 * else, which is also why "find a setting" filters EVERY group at both sizes.
 * At 1024 the design hides it behind the menu button so the content has the
 * full width (P02/02); from 1280 it is the 272px full-height column.
 *
 * `find a setting` matches group labels and item labels, accent-folded. A group
 * whose own label matches keeps all of its items; somebody typing "channels"
 * wants the channels group, not an empty one.
 * ---------------------------------------------------------------------------
 *
 * The residency pill never scrolls away because data residency is a
 * contractual promise in this market and the design puts it in the top bar for
 * that reason, not for decoration.
 *
 * P18's studio frame is this bar with a section title after a divider and a
 * 44px breadcrumb strip under it, and no settings menu: `section`,
 * `breadcrumb` and `nav={false}`.
 */

const SEVERITY_BADGE: Readonly<Record<Severity, string>> = {
  info: 'bg-info-soft text-info-text',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-danger-soft text-danger-text',
};

/** The bell is its own chunk, rendered only where the server-side flag says so (D-L182). */
const NotificationBell = lazy(() => import('../notifications/bell'));

/** A 44px ghost button in the bar: a 22px glyph in text-2. */
const BAR_ICON_BUTTON = `flex size-control-base shrink-0 items-center justify-center rounded-md text-text-2 is-hover:bg-surface-sunken ${SHELL_FOCUS}`;

/** A settings group row: 40px, 0 10px, gap 10, radius 8, 14/600, a 20px glyph (P02). */
const GROUP_ROW = `flex min-h-control-md w-full items-center gap-2.5 rounded-md px-2.5 text-start text-body-sm font-semibold is-hover:bg-surface-sunken ${SHELL_FOCUS}`;

/** A settings item row: 36px, 0 10 0 40, radius 8, 14/500 in text-2; current is primary-soft 700. */
const ITEM_ROW = `flex min-h-control-sm items-center gap-2 rounded-md pe-2.5 ps-10 text-start text-body-sm ${SHELL_FOCUS}`;

/**
 * "Data stored in: {region}" with the region in bold, from ONE translated
 * sentence: the region's place in it is the translation's to decide.
 */
function ResidencyText({ t, region }: { t: Translator; region: string }) {
  const marker = '\u0001';
  const [before = '', after = ''] = t.t('admin.shell.residency', { region: marker }).split(marker);
  return (
    <span className="truncate">
      {before}
      <b>{region}</b>
      {after}
    </span>
  );
}

/**
 * The tenant switcher (P02): a bordered 36px button with `apartment`, the
 * workspace's name and a chevron. It lists the current workspace only: a
 * tenant admin reaches one workspace, and nothing else is invented.
 */
function TenantSwitcher({ t, name }: { t: Translator; name: string }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const labelId = useId();

  useEffect(() => {
    if (!open) return undefined;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !containerRef.current?.contains(event.target))
        setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative ms-2 hidden shrink-0 xl:flex">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t.t('admin.shell.tenant', { name })}
        data-testid="tenant-switcher"
        onClick={() => setOpen((current) => !current)}
        className={`inline-flex h-control-sm items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-surface pe-2 ps-3 text-body-sm font-semibold text-text is-hover:bg-surface-sunken ${SHELL_FOCUS}`}
      >
        <Icon name="apartment" size={18} className="text-text-2" />
        {name}
        <Icon name={open ? 'expand_less' : 'expand_more'} size={18} />
      </button>
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-labelledby={labelId}
          onKeyDown={(event) => {
            if (event.key === 'Tab') setOpen(false);
            moveInMenu(event);
          }}
          className="absolute start-0 top-full z-40 mt-2 flex w-64 flex-col rounded-10 border border-border bg-surface-raised p-1 shadow-2"
        >
          <p id={labelId} className="px-3 pb-1 pt-2 text-overline text-text-muted">
            {t.t('admin.shell.tenant.current')}
          </p>
          <button
            type="button"
            role="menuitemradio"
            aria-checked="true"
            onClick={() => setOpen(false)}
            className={`flex h-control-md items-center gap-2.5 rounded-6 bg-primary-soft px-3 text-start text-body-sm font-semibold text-text ${SHELL_FOCUS}`}
          >
            <Icon name="apartment" size={20} className="text-text-2" />
            <span className="flex-1 truncate">{name}</span>
            <Icon name="check" size={20} className="text-primary-text" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function AdminShell({
  locale,
  messages,
  locales,
  activeSettingId,
  linkedSettings,
  bell,
  section,
  breadcrumb,
  nav = true,
  children,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  /** Which settings-menu item is the current page, for `aria-current`. */
  activeSettingId: string | null;
  /**
   * The flag-gated menu entries that are links in this process, by `settingId`
   * (`adminLiveNav()`, read on the server by each page). An entry whose screen
   * is off stays a non-link, like an unbuilt one, so no menu entry leads to a
   * 404. A prop and not a layout or a context: a layout is a chunk of its own,
   * and every admin route would pay a request for it on a 256 kbps link.
   */
  linkedSettings: Readonly<Record<string, string>>;
  /** The notifications bell is on in this process (`adminBellLive()`, read on the server by each page). */
  bell: boolean;
  /** P18: a section title after a divider in the bar ("Customisation studio"). */
  section?: { readonly icon: IconName; readonly label: string };
  /** P18: the 44px breadcrumb strip under the bar (`AdminBreadcrumb`). */
  breadcrumb?: ReactNode;
  /** The settings menu. P18's studio has none. */
  nav?: boolean;
  children: ReactNode;
}) {
  const t = createBundleTranslator(locale, messages);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<readonly string[]>(() =>
    activeSettingId === null
      ? []
      : NAV_GROUPS.filter((group) =>
          group.items.some((item) => item.settingId === activeSettingId),
        ).map((group) => group.id),
  );
  const searchId = useId();
  const drawerButtonRef = useRef<HTMLButtonElement>(null);

  const badges = useResource((signal) => getSettingsMenuBadges(signal), []);

  /**
   * The residency pill and the tenant switcher are read by the SHELL, not
   * passed in, because they are on every admin screen and the design is
   * explicit that residency never scrolls away. Threading them through every
   * page as a prop meant each page had to remember to supply them.
   *
   * Each renders only once it is KNOWN. There is no placeholder, because a
   * residency badge is a contractual promise in this market and a badge that
   * says "—" for a second teaches people that the badge is decoration.
   */
  const summary = useResource((signal) => getHomeSummary(signal), []);
  const region = summary.data?.dataRegion ?? null;
  const tenantName = summary.data?.tenant.name ?? null;

  const label = useCallback((id: MessageId) => t.t(id), [t]);
  const groups = useMemo(() => filterNav(NAV_GROUPS, query, label), [query, label]);

  // While filtering, every matching group is open: a search result you still
  // have to expand to see is not a search result.
  const isOpen = (group: NavGroup) => query.trim() !== '' || expanded.includes(group.id);

  const toggleGroup = (id: string) =>
    setExpanded((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );

  // Escape closes the drawer and returns focus to the control that opened it.
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawerOpen(false);
        drawerButtonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  const badgeFor = (settingId: string) =>
    badges.data?.badges.find((badge) => badge.settingId === settingId) ?? null;

  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <header className="sticky top-0 z-30 flex h-shell-header shrink-0 items-center gap-1 border-b border-border bg-surface px-2 sm:gap-3 sm:px-4">
        {nav ? (
          <button
            ref={drawerButtonRef}
            type="button"
            aria-label={t.t('admin.shell.menu.toggle')}
            aria-expanded={drawerOpen}
            data-testid="nav-toggle"
            onClick={() => setDrawerOpen((open) => !open)}
            className={`flex size-control-base shrink-0 items-center justify-center rounded-md text-text is-hover:bg-surface-sunken xl:hidden ${SHELL_FOCUS}`}
          >
            <Icon name="menu" size={24} />
          </button>
        ) : null}

        <Brand t={t} href="/admin">
          <span className="flex items-center rounded-6 bg-primary-soft px-2 py-0.5 text-caption font-bold text-primary-text">
            {t.t('admin.shell.admin')}
          </span>
        </Brand>

        {section === undefined ? null : (
          <>
            <span aria-hidden="true" className="mx-1 hidden h-6 w-px shrink-0 bg-border sm:block" />
            <span className="hidden items-center gap-2 whitespace-nowrap text-label font-bold sm:inline-flex">
              <Icon name={section.icon} size={20} className="text-primary-text" />
              {section.label}
            </span>
          </>
        )}

        {tenantName === null || section !== undefined ? null : (
          <TenantSwitcher t={t} name={tenantName} />
        )}

        <span className="min-w-0 flex-1" />

        {region === null ? null : (
          <span
            data-testid="residency-badge"
            role="note"
            title={t.t('admin.shell.residency.note')}
            aria-label={t.t('admin.shell.residency', {
              region: `${region.displayName} (${region.code})`,
            })}
            className="inline-flex size-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-success-soft text-meta font-semibold text-success-text md:w-auto md:min-w-0 md:shrink md:justify-start md:px-3"
          >
            <Icon name="location_on" size={18} />
            <span className="hidden min-w-0 md:inline-flex">
              <ResidencyText t={t} region={`${region.displayName} (${region.code})`} />
            </span>
          </span>
        )}

        <span
          role="button"
          aria-disabled="true"
          tabIndex={0}
          aria-label={`${t.t('admin.shell.help')}: ${t.t('records.nav.soon')}`}
          title={t.t('records.nav.soon')}
          className={`${BAR_ICON_BUTTON} hidden sm:flex`}
        >
          <Icon name="help" size={22} />
        </span>

        {bell ? (
          <Suspense>
            <NotificationBell t={t} locale={locale} live={[]} />
          </Suspense>
        ) : null}

        <AccountMenu t={t} locale={locale} locales={locales} withLite />
      </header>

      {breadcrumb === undefined ? null : (
        <div className="flex h-control-base shrink-0 items-center overflow-hidden border-b border-border bg-surface px-4">
          {breadcrumb}
        </div>
      )}

      <div className="relative flex flex-1 items-stretch">
        {nav && drawerOpen ? (
          <button
            type="button"
            aria-label={t.t('admin.shell.menu.close')}
            onClick={() => setDrawerOpen(false)}
            className="fixed inset-x-0 bottom-0 top-shell-header z-20 bg-scrim xl:hidden"
          />
        ) : null}

        {nav ? (
          <nav
            aria-label={t.t('admin.shell.menu.label')}
            data-testid="settings-menu"
            data-open={drawerOpen ? 'true' : 'false'}
            className={`${
              drawerOpen ? 'flex' : 'hidden'
            } fixed bottom-0 start-0 top-shell-header z-30 w-shell-admin-nav shrink-0 flex-col border-e border-border bg-surface shadow-3 xl:static xl:z-0 xl:flex xl:shadow-none`}
          >
            <div className="flex max-h-full flex-col gap-0.5 overflow-y-auto px-2.5 pb-8 pt-3 xl:sticky xl:top-shell-header xl:max-h-[calc(100dvh-var(--k-shell-header))]">
              <div className="relative mb-2">
                <label className="sr-only" htmlFor={searchId}>
                  {t.t('admin.shell.menu.find')}
                </label>
                <Icon
                  name="search"
                  size={20}
                  className="pointer-events-none absolute start-2.5 top-2.5 text-text-muted"
                />
                <input
                  id={searchId}
                  type="search"
                  value={query}
                  data-testid="settings-filter"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t.t('admin.shell.menu.find')}
                  className="h-control-md w-full rounded-md border border-border bg-surface-sunken pe-3 ps-10 text-body-sm text-text placeholder:text-text-muted focus-visible:field-focus"
                />
              </div>

              <Link
                prefetch={false}
                href="/admin"
                aria-current={activeSettingId === 'home' ? 'page' : undefined}
                className={`${GROUP_ROW} ${activeSettingId === 'home' ? 'bg-primary-soft text-primary-text' : 'text-text'}`}
              >
                <Icon name="space_dashboard" size={20} />
                {t.t('admin.shell.home')}
              </Link>

              {groups.map((group) => {
                const open = isOpen(group);
                const hasItems = group.items.length > 0;
                const holdsCurrent = group.items.some((item) => item.settingId === activeSettingId);
                const groupAlert = group.items.some((item) => badgeFor(item.settingId) !== null);
                return (
                  <div key={group.id} className="flex flex-col">
                    <button
                      type="button"
                      aria-expanded={hasItems ? open : undefined}
                      onClick={() => toggleGroup(group.id)}
                      data-testid={`nav-group-${group.id}`}
                      className={`${GROUP_ROW} ${open && holdsCurrent ? 'text-primary-text' : 'text-text'}`}
                    >
                      <Icon name={group.icon} size={20} />
                      <span className="flex-1">{t.t(group.label)}</span>
                      {groupAlert ? (
                        <span
                          aria-label={t.t('admin.shell.menu.attention')}
                          className="size-2 shrink-0 rounded-full bg-warning"
                        />
                      ) : null}
                      {hasItems ? (
                        <Icon
                          name={open ? 'expand_less' : 'expand_more'}
                          size={20}
                          className="text-text-muted"
                        />
                      ) : null}
                    </button>

                    {open && hasItems ? (
                      <div className="flex flex-col gap-px pb-2 pt-0.5">
                        {group.items.map((item) => {
                          const badge = badgeFor(item.settingId);
                          const current = item.settingId === activeSettingId;
                          const inner = (
                            <>
                              <span className="flex-1">{t.t(item.label)}</span>
                              {badge === null ? null : (
                                <span
                                  className={`rounded-full px-2 text-micro ${SEVERITY_BADGE[badge.severity]}`}
                                >
                                  {badge.count}
                                </span>
                              )}
                            </>
                          );
                          const className = `${ITEM_ROW} ${
                            current
                              ? 'bg-primary-soft font-bold text-primary-text'
                              : 'font-medium text-text-2 is-hover:bg-surface-sunken'
                          }`;

                          // A flag-gated screen is a link only where its flag is on.
                          const href = item.href || linkedSettings[item.settingId] || null;

                          return href === null ? (
                            // Not built yet, so not a link. A menu entry that
                            // navigates to a 404 is worse than one that visibly
                            // does nothing — same rule as the language menu. It stays
                            // announced as disabled, so assistive technology hears
                            // what is coming and that it is not available yet.
                            <span
                              key={item.settingId}
                              data-setting-id={item.settingId}
                              aria-disabled="true"
                              title={t.t('records.nav.soon')}
                              className={className}
                            >
                              {inner}
                            </span>
                          ) : (
                            <Link
                              prefetch={false}
                              key={item.settingId}
                              href={href}
                              data-setting-id={item.settingId}
                              aria-current={current ? 'page' : undefined}
                              onClick={() => setDrawerOpen(false)}
                              className={className}
                            >
                              {inner}
                            </Link>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}

              {groups.length === 0 ? (
                <p
                  data-testid="settings-no-results"
                  className="px-3 py-2 text-body-sm text-text-muted"
                >
                  {t.t('admin.shell.menu.noResults')}
                </p>
              ) : null}
            </div>
          </nav>
        ) : null}

        <div className="min-w-0 flex-1 p-4 md:p-6 xl:px-8 xl:pb-10 xl:pt-7">{children}</div>
      </div>
    </div>
  );
}

/**
 * One step of P18's breadcrumb strip: a 13/600 primary-text link, or the
 * current page in text, each after a muted 18px chevron but the first.
 */
export function AdminBreadcrumb({
  label,
  steps,
}: {
  /** The trail's accessible name, translated by the screen. */
  label: string;
  steps: readonly { readonly label: string; readonly href?: string }[];
}) {
  return (
    <nav aria-label={label} className="min-w-0">
      <ol className="flex min-w-0 items-center gap-0.5 text-meta font-semibold">
        {steps.map((step, index) => (
          <li
            key={`${step.label}-${index}`}
            className="flex min-w-0 items-center gap-0.5 whitespace-nowrap"
          >
            {index === 0 ? null : (
              <Icon name="chevron_right" size={18} className="text-text-muted rtl:-scale-x-100" />
            )}
            {step.href === undefined ? (
              <span aria-current="page" className="truncate px-1.5 text-text">
                {step.label}
              </span>
            ) : (
              <Link
                prefetch={false}
                href={step.href}
                className={`flex h-8 items-center rounded-6 px-1.5 text-primary-text is-hover:bg-surface-sunken ${SHELL_FOCUS}`}
              >
                {step.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
