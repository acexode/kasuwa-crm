'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { LanguageMenu, type LanguageOption } from '../auth/language-menu';
import { LiteModeToggle } from '../auth/lite-mode';
import { SignOutButton } from '../auth/sign-out-button';
import { NAV_GROUPS, filterNav, type NavGroup } from './nav-model';
import { getHomeSummary, getSettingsMenuBadges, type Severity } from '../../lib/admin-api';
import { useResource } from './use-resource';

/**
 * `P02/A1` — the admin frame: top bar, residency badge and the settings menu.
 *
 * ---------------------------------------------------------------------------
 * THE MENU IS A SIDEBAR ON DESKTOP AND A DRAWER ON TABLET, AND IT IS ONE TREE.
 *
 * Not two components and not two DOM trees. Rendering it twice is how the
 * search box, the expanded/collapsed state and the `aria-current` mark drift
 * apart — and how a tablet user ends up with a menu that filters and a desktop
 * user with one that does not. The breakpoint changes position and nothing
 * else, which is also why "find a setting" filters EVERY group at both sizes.
 *
 * `find a setting` matches group labels and item labels, accent-folded. A group
 * whose own label matches keeps all of its items; somebody typing "channels"
 * wants the channels group, not an empty one.
 * ---------------------------------------------------------------------------
 *
 * The residency badge never scrolls away because data residency is a
 * contractual promise in this market and the design puts it in the top bar for
 * that reason, not for decoration.
 */

const SEVERITY_BADGE: Readonly<Record<Severity, string>> = {
  info: 'bg-info-soft text-info-text',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-danger-soft text-danger-text',
};

export function AdminShell({
  locale,
  messages,
  locales,
  activeSettingId,
  linkedSettings,
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
   * The residency badge is read by the SHELL, not passed in, because it is on
   * every admin screen and the design is explicit that it never scrolls away.
   * Threading it through every page as a prop meant each page had to remember
   * to supply it, and the programme screens have no reason to know the
   * workspace's region.
   *
   * It renders only once the region is KNOWN. There is no placeholder, because
   * a residency badge is a contractual promise in this market and a badge that
   * says "—" for a second teaches people that the badge is decoration.
   */
  const summary = useResource((signal) => getHomeSummary(signal), []);
  const regionName = summary.data?.dataRegion.displayName ?? null;

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
      <header className="sticky top-0 z-30 flex h-16 shrink-0 flex-wrap items-center gap-3 border-b border-border bg-surface px-4">
        <button
          ref={drawerButtonRef}
          type="button"
          aria-label={t.t('admin.shell.menu.toggle')}
          aria-expanded={drawerOpen}
          data-testid="nav-toggle"
          onClick={() => setDrawerOpen((open) => !open)}
          className="flex min-h-touch min-w-touch items-center justify-center rounded-md hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:hidden"
        >
          <Icon name="menu" />
        </button>

        <Link
          href="/admin"
          className="flex shrink-0 items-center gap-2 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-body-md font-extrabold text-accent">
            {t.t('app.name').slice(0, 1)}
          </span>
          <b className="text-body-md">{t.t('app.name')}</b>
          <span className="rounded-sm bg-primary-soft px-2 text-caption font-bold text-primary-text">
            {t.t('admin.shell.admin')}
          </span>
        </Link>

        <span className="flex-1" />

        {regionName === null ? null : (
          <span
            data-testid="residency-badge"
            title={t.t('admin.shell.residency.note')}
            className="inline-flex items-center gap-2 rounded-full bg-success-soft px-3 py-1 text-body-sm font-semibold text-success-text"
          >
            <Icon name="location_on" size="sm" />
            {t.t('admin.shell.residency', { region: regionName })}
          </span>
        )}

        <LanguageMenu
          options={locales}
          current={locale}
          label={t.t('auth.topbar.language')}
          currentLabel={t.t('auth.topbar.language.current', {
            language: locales.find((option) => option.code === locale)?.label ?? locale,
          })}
          compact
        />
        <LiteModeToggle
          label={t.t('auth.topbar.lite')}
          onLabel={t.t('auth.topbar.lite.on')}
          accessibleName={t.t('auth.topbar.lite.toggle')}
          compact
        />
        <SignOutButton label={t.t('auth.signOut')} />
      </header>

      <div className="relative flex flex-1 items-stretch">
        {drawerOpen ? (
          <button
            type="button"
            aria-label={t.t('admin.shell.menu.close')}
            onClick={() => setDrawerOpen(false)}
            className="fixed inset-0 z-20 bg-inverse opacity-60 lg:hidden"
          />
        ) : null}

        <nav
          aria-label={t.t('admin.shell.menu.label')}
          data-testid="settings-menu"
          data-open={drawerOpen ? 'true' : 'false'}
          className={`${
            drawerOpen ? 'flex' : 'hidden'
          } fixed inset-y-0 start-0 z-30 w-72 shrink-0 flex-col gap-1 overflow-y-auto border-e border-border bg-surface p-3 lg:sticky lg:top-16 lg:z-0 lg:flex lg:max-h-screen`}
        >
          <div className="relative mb-2">
            <label className="sr-only" htmlFor={searchId}>
              {t.t('admin.shell.menu.find')}
            </label>
            <input
              id={searchId}
              type="search"
              value={query}
              data-testid="settings-filter"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t.t('admin.shell.menu.find')}
              className="min-h-touch w-full rounded-md border border-border bg-surface-sunken px-3 text-body-md text-text placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            />
          </div>

          <Link
            href="/admin"
            aria-current={activeSettingId === 'home' ? 'page' : undefined}
            className={`flex min-h-touch items-center gap-3 rounded-md px-3 text-body-sm font-semibold hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
              activeSettingId === 'home' ? 'bg-primary-soft text-primary-text' : 'text-text'
            }`}
          >
            <Icon name="space_dashboard" size="sm" />
            {t.t('admin.shell.home')}
          </Link>

          {groups.map((group) => {
            const open = isOpen(group);
            const groupAlert = group.items.some((item) => badgeFor(item.settingId) !== null);
            return (
              <div key={group.id} className="flex flex-col">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggleGroup(group.id)}
                  data-testid={`nav-group-${group.id}`}
                  className="flex min-h-touch items-center gap-3 rounded-md px-3 text-start text-body-sm font-semibold text-text hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <Icon name={group.icon} size="sm" />
                  <span className="flex-1">{t.t(group.label)}</span>
                  {groupAlert ? (
                    <span
                      aria-label={t.t('admin.shell.menu.attention')}
                      className="h-2 w-2 rounded-full bg-warning"
                    />
                  ) : null}
                  <Icon name={open ? 'expand_less' : 'expand_more'} size="sm" />
                </button>

                {open && group.items.length > 0 ? (
                  <div className="flex flex-col">
                    {group.items.map((item) => {
                      const badge = badgeFor(item.settingId);
                      const current = item.settingId === activeSettingId;
                      const inner = (
                        <>
                          <span className="flex-1">{t.t(item.label)}</span>
                          {badge === null ? null : (
                            <span
                              className={`rounded-full px-2 text-caption font-bold ${SEVERITY_BADGE[badge.severity]}`}
                            >
                              {badge.count}
                            </span>
                          )}
                        </>
                      );
                      const className = `flex min-h-touch items-center gap-2 rounded-md ps-10 pe-3 text-start text-body-sm hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                        current ? 'bg-primary-soft font-semibold text-primary-text' : 'text-text-2'
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
                          className={`${className} text-text-muted`}
                        >
                          {inner}
                        </span>
                      ) : (
                        <Link
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
            <p data-testid="settings-no-results" className="px-3 py-2 text-body-sm text-text-muted">
              {t.t('admin.shell.menu.noResults')}
            </p>
          ) : null}
        </nav>

        <div className="min-w-0 flex-1 p-4 lg:p-6">{children}</div>
      </div>
    </div>
  );
}
