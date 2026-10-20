'use client';

import Link from 'next/link';
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Button } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import type { LanguageOption } from '../auth/language-menu';
import { SHELL_SEARCH_STRINGS } from '../search/message-ids';
import { CommandsButton, TopBarSearch, useShellShortcuts } from '../search/top-bar-search';
import { AccountItems, AccountMenu, moveInMenu } from '../shell/account-menu';
import { Brand, SHELL_FOCUS, ShellLiteToggle } from '../shell/shell-parts';
import { useShellUserName } from '../shell/use-shell-user';
import {
  CRM_NAV,
  CRM_SCREEN_TITLES,
  bottomNav,
  liveHref,
  shownNav,
  type CrmNavItem,
} from './crm-nav';

/**
 * The bell is its OWN chunk (D-L182): a lazy `import()` (React's own, as the palette's: `next/dynamic` would add its runtime to every page) that is rendered only where
 * the server-side flag says so, so a process with the notifications flag off never ships
 * its component, poller, store or writes, and the shell costs it nothing.
 */
const NotificationBell = lazy(() => import('../notifications/bell'));

/**
 * The CRM app shell (T-0042, rebuilt to the designs by T-0130) — the frame
 * every record screen sits in, and NOT the admin console's.
 *
 * FROM `md` UP (P03 frame 01, P04, P05, P07): a 60px top bar — logo and
 * wordmark, the inline search field with its Ctrl K hint, then the labelled
 * Lite mode switch, the bell and the avatar menu (language and Sign out) — over
 * a 72px sunken icon rail, kept at 1024.
 *
 * BELOW `md` (P04/02, P05, P07 at 360): no global top bar. The bar becomes the
 * screen's own 56px app bar — a 48px menu (or back) button, a title and
 * subtitle, and 48px trailing actions — which a screen fills through `appBar`;
 * until it does, the bar shows the screen's nav title. A 64px bottom bar holds
 * Home, Inbox, the current object, Deals and More, each a 52×28 pill, and a
 * screen may put its extended "+ New" button above it through `fab`. The menu
 * button and More open one sheet with every entry and the account items.
 *
 * It is ONE header element at every width, restyled by breakpoint, so the
 * bell — its own chunk, poller and store — is mounted once.
 *
 * THE GLOBAL SEARCH (T-0087, P27; T-0138). Where its flag is on in this
 * process (`live.includes('search')`), the bar holds the P27 search field
 * (`TopBarSearch`: `/` focuses it, and its dropdown loads on first focus) and
 * the Commands button. Control+K or Meta+K opens the command palette from
 * anywhere in the shell, a text field included. The palette's code is a
 * dynamic `import()` made on the first open (R29). While it is open,
 * everything behind it is inert; when it closes, focus goes back.
 *
 * THE BELL (T-0101, P26), where `live.includes('notifications')`.
 *
 * Still to come, and deliberately absent rather than faked: agent
 * availability. It needs an API that does not exist yet.
 */

export interface CrmAppBar {
  /** The screen's title, already translated, or a served name (see `titleText`). */
  readonly title: string;
  /**
   * When the title is not copy but a served value (a record's or a script's
   * own name), which: it is then marked `data-record-text` or `data-script-text`
   * like the same name anywhere else on the screen (T-0150).
   */
  readonly titleText?: 'record' | 'script';
  readonly subtitle?: string;
  /** A back link in place of the menu button (a record's list). */
  readonly back?: string;
  /** 48px trailing actions; given, they replace the default search and bell. */
  readonly actions?: ReactNode;
  /**
   * The logo tile in place of the menu button, and no visible title (P03 Home
   * at 360: the tile, then the screen's own actions). The title stays as the
   * bar's accessible heading; More still opens the navigation sheet.
   */
  readonly brand?: boolean;
}

interface PaletteProps {
  t: Translator;
  onClose: () => void;
  onRetry: () => void;
  dealsLive: boolean;
  live: readonly string[];
}

/**
 * The palette, loaded on the first open only (R29): never part of the
 * shell's first load. A chunk that does not arrive (a dropped 256 kbps link)
 * resolves to `PaletteFailed` rather than crashing the screen, and a retry
 * makes a fresh loader, because `lazy` remembers what it resolved to (D-L137 M4).
 */
function loadPalette(): LazyExoticComponent<ComponentType<PaletteProps>> {
  return lazy(() =>
    import('../search/command-palette').then(
      (module): { default: ComponentType<PaletteProps> } => ({ default: module.CommandPalette }),
      (): { default: ComponentType<PaletteProps> } => ({ default: PaletteFailed }),
    ),
  );
}

/** A 48px app-bar button (P04/02: `width:48px;height:48px`, a 24px glyph). */
const BAR_BUTTON = `flex size-control-lg shrink-0 items-center justify-center rounded-md text-text is-hover:bg-surface-sunken ${SHELL_FOCUS}`;

/** A rail item: 56×52, radius 10, a 22px glyph over a 10/600 label (P03, P04). */
function RailItem({ item, href, active, t }: { item: CrmNavItem; href: string | null; active: boolean; t: Translator }) {
  const className = `flex min-h-shell-rail-item-height w-shell-rail-item-width flex-col items-center justify-center gap-0.5 rounded-10 px-0.5 text-center text-rail-label ${SHELL_FOCUS}`;
  const inner = (
    <>
      <Icon name={item.icon} size={22} />
      <span className="max-w-full break-words">{t.t(item.label)}</span>
    </>
  );
  if (href === null) {
    // A placeholder entry can still be where the person is (Studio on the script screens, T-0139).
    return active ? (
      <span aria-current="page" className={`${className} bg-primary-soft text-primary-text`}>
        {inner}
      </span>
    ) : (
      <span aria-disabled="true" title={t.t('records.nav.soon')} className={`${className} text-text-2`}>
        {inner}
        <span className="sr-only">{t.t('records.nav.soon')}</span>
      </span>
    );
  }
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`${className} ${active ? 'bg-primary-soft text-primary-text' : 'text-text-2 is-hover:bg-surface'}`}
    >
      {inner}
    </Link>
  );
}

/**
 * A bottom-bar item: a 52×28 pill (radius 14) behind a 22px glyph,
 * primary-soft and filled when active, over an 11px label (700 active, 500 not).
 */
function BottomItem({ item, href, active, t }: { item: CrmNavItem; href: string | null; active: boolean; t: Translator }) {
  const className = `flex min-w-0 flex-col items-center justify-center gap-0.5 text-micro ${SHELL_FOCUS} ${
    active ? 'font-bold text-primary-text' : 'font-medium text-text-2'
  }`;
  const inner = (
    <>
      <span
        className={`flex h-7 w-control-xl items-center justify-center rounded-14 ${active ? 'bg-primary-soft' : ''}`}
      >
        {item.icon === 'bar_chart' || item.icon === 'account_tree' ? (
          <Icon name={item.icon} size={22} />
        ) : (
          <Icon name={item.icon} size={22} filled={active} />
        )}
      </span>
      <span className="max-w-full truncate">{t.t(item.label)}</span>
    </>
  );
  if (href === null) {
    return (
      <span aria-disabled={active ? undefined : 'true'} aria-current={active ? 'page' : undefined} className={className}>
        {inner}
        <span className="sr-only">{t.t('records.nav.soon')}</span>
      </span>
    );
  }
  return (
    <Link href={href} aria-current={active ? 'page' : undefined} className={className}>
      {inner}
    </Link>
  );
}

export function CrmShell({
  t,
  locale,
  locales,
  current,
  live,
  appBar,
  fab,
  bottomObjects,
  children,
}: {
  t: Translator;
  locale: string;
  locales: readonly LanguageOption[];
  /** The nav item id of the screen inside, for `aria-current`. */
  current: string;
  /** Nav ids whose route is on in this process (`crmLiveNav()`); only these link. */
  live: readonly string[];
  /** The phone app bar (below `md`). Left out, it shows the screen's nav title. */
  appBar?: CrmAppBar;
  /** The phone's extended "+ New" button (`CrmFab`), drawn above the bottom bar below `md`. */
  fab?: ReactNode;
  /** The bottom bar's two object slots, where the screen names its own (`bottomNav`). */
  bottomObjects?: readonly string[];
  children: ReactNode;
}) {
  // The wordmark goes to the first screen that answers here: the one inside
  // is always among them, so it is never a link to a 404.
  const home = CRM_NAV.map((item) => liveHref(item, live)).find((href) => href !== null) ?? null;
  const searchLive = live.includes('search');
  const bellLive = live.includes('notifications');
  const rail = shownNav(live);
  const bottom = bottomNav(live, current, bottomObjects);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [Palette, setPalette] = useState<LazyExoticComponent<ComponentType<PaletteProps>> | null>(null);
  const openRef = useRef(false);
  const openerRef = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  openRef.current = paletteOpen;

  const navTitle = CRM_NAV.find((item) => item.id === current)?.label ?? CRM_SCREEN_TITLES[current] ?? 'app.name';
  const barTitle = appBar?.title ?? t.t(navTitle);

  const openPalette = useCallback(() => {
    if (openRef.current || document.querySelector('[aria-modal="true"]') !== null) return;
    openerRef.current = document.activeElement;
    // `lazy` returns an object, not a function, so React stores it rather than calling it.
    setPalette((loaded: LazyExoticComponent<ComponentType<PaletteProps>> | null) => loaded ?? loadPalette());
    setPaletteOpen(true);
  }, []);

  // Control+K and Meta+K, from anywhere in the shell, a text field included
  // (R4), on any keyboard layout (`code` is the physical key, D-L137 L2). Not
  // over another modal dialog: that dialog owns the page until it closes (M1).
  useEffect(() => {
    if (!searchLive) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const isK = event.code === 'KeyK' || event.key.toLowerCase() === 'k';
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || !isK) return;
      event.preventDefault();
      openPalette();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [searchLive, openPalette]);

  // Focus goes back where it was once the palette has closed and the page is no longer inert.
  useEffect(() => {
    if (paletteOpen) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
  }, [paletteOpen]);

  // The shortcuts the palette's rows show (G then a letter; Ctrl+Shift+L), where the palette exists.
  useShellShortcuts(live, searchLive);

  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const retryPalette = useCallback(() => setPalette(loadPalette()), []);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const behind = paletteOpen || sheetOpen ? { inert: true } : {};

  return (
    <div data-shell="crm" className="flex min-h-screen flex-col bg-bg text-text">
      <header
        {...behind}
        className="sticky top-0 z-30 flex h-shell-mobile-header shrink-0 items-center gap-0.5 border-b border-border bg-surface px-1 md:h-shell-header md:gap-2 md:pe-3 md:ps-4"
      >
        {/* Phone: the screen's own app bar. */}
        {appBar?.brand === true ? (
          <div className="flex ps-3 md:hidden">
            <Brand t={t} href={null} wordmark={false} />
          </div>
        ) : appBar?.back === undefined ? (
          <button
            type="button"
            aria-label={t.t('shell.menu.open')}
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            data-testid="crm-menu"
            onClick={() => setSheetOpen(true)}
            className={`${BAR_BUTTON} md:hidden`}
          >
            <Icon name="menu" size={24} />
          </button>
        ) : (
          <Link href={appBar.back} aria-label={t.t('shell.back')} className={`${BAR_BUTTON} md:hidden`}>
            <Icon name="arrow_back" size={24} className="rtl:-scale-x-100" />
          </Link>
        )}
        <div className="flex min-w-0 flex-1 flex-col md:hidden">
          <b
            data-record-text={appBar?.titleText === 'record' ? '' : undefined}
            data-script-text={appBar?.titleText === 'script' ? '' : undefined}
            className={appBar?.brand === true ? 'sr-only' : 'truncate text-h5 font-bold'}
          >
            {barTitle}
          </b>
          {appBar?.subtitle === undefined ? null : (
            <span className="truncate text-caption font-normal text-text-muted">{appBar.subtitle}</span>
          )}
        </div>
        {appBar?.actions === undefined ? (
          searchLive ? (
            <Link
              href="/search"
              prefetch={false}
              aria-label={t.t(SHELL_SEARCH_STRINGS.entry)}
              aria-current={current === 'search' ? 'page' : undefined}
              className={`${BAR_BUTTON} md:hidden`}
            >
              <Icon name="search" size={24} />
            </Link>
          ) : null
        ) : (
          <div className="flex shrink-0 items-center md:hidden">{appBar.actions}</div>
        )}

        {/* From `md` up: the global top bar. */}
        <div className="hidden md:flex">
          <Brand t={t} href={home} />
        </div>
        {searchLive ? <TopBarSearch t={t} live={live} current={current} onOpenPalette={openPalette} /> : null}
        <span className="hidden flex-1 md:block" />
        <ShellLiteToggle t={t} className="hidden md:inline-flex" />
        {searchLive ? <CommandsButton t={t} onClick={openPalette} /> : null}
        {bellLive ? (
          <div className={appBar?.actions === undefined ? 'flex shrink-0' : 'hidden shrink-0 md:flex'}>
            <Suspense>
              <NotificationBell t={t} locale={locale} live={live} />
            </Suspense>
          </div>
        ) : null}
        <div className="hidden md:flex">
          <AccountMenu t={t} locale={locale} locales={locales} withLite={false} />
        </div>
      </header>

      <div {...behind} className="flex min-w-0 flex-1 items-stretch">
        <nav
          aria-label={t.t('records.nav.label')}
          className="hidden w-shell-rail shrink-0 border-e border-border bg-surface-sunken md:block"
        >
          <div className="sticky top-shell-header flex flex-col items-center gap-1 py-3">
            {rail.map((item) => (
              <RailItem key={item.id} item={item} href={liveHref(item, live)} active={item.id === current} t={t} />
            ))}
          </div>
        </nav>
        {/* Below `md` the bottom padding clears the bar, and the FAB where there is one. */}
        <div className={`min-w-0 flex-1 p-4 md:p-6 ${fab === undefined ? 'pb-24' : 'pb-40'}`}>{children}</div>
      </div>

      {fab === undefined ? null : (
        <div {...behind} className="fixed bottom-20 end-4 z-30 md:hidden">
          {fab}
        </div>
      )}

      <nav
        {...behind}
        aria-label={t.t('records.nav.label')}
        className="fixed inset-x-0 bottom-0 z-30 grid h-shell-bottom-bar auto-cols-fr grid-flow-col border-t border-border bg-surface md:hidden"
      >
        {bottom.map((item) => (
          <BottomItem key={item.id} item={item} href={liveHref(item, live)} active={item.id === current} t={t} />
        ))}
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          data-testid="crm-more"
          onClick={() => setSheetOpen(true)}
          className={`flex min-w-0 flex-col items-center justify-center gap-0.5 text-micro font-medium text-text-2 ${SHELL_FOCUS}`}
        >
          <span className="flex h-7 w-control-xl items-center justify-center rounded-14">
            <Icon name="menu" size={22} />
          </span>
          <span className="max-w-full truncate">{t.t('records.nav.more')}</span>
        </button>
      </nav>

      {sheetOpen ? (
        <NavSheet t={t} locale={locale} locales={locales} live={live} current={current} onClose={closeSheet} />
      ) : null}

      {searchLive && paletteOpen && Palette !== null ? (
        <Suspense fallback={<PaletteLoading t={t} onClose={closePalette} />}>
          <Palette t={t} onClose={closePalette} onRetry={retryPalette} dealsLive={live.includes('deals')} live={live} />
        </Suspense>
      ) : null}
    </div>
  );
}

/**
 * The phone's extended "+ New" button (P04/02): 56px, 0 20 0 16, radius 16,
 * primary, 15/700 with a 24px `add`, shadow-2. A list screen passes one as the
 * shell's `fab`; the shell places it above the bottom bar, on phones only.
 */
export function CrmFab({ label, onClick, href }: { label: string; onClick?: () => void; href?: string }) {
  const className = `flex h-shell-fab items-center gap-2 rounded-xl bg-primary pe-5 ps-4 text-label font-bold text-on-primary shadow-2 is-hover:bg-primary-hover is-active:bg-primary-active ${SHELL_FOCUS}`;
  const inner = (
    <>
      <Icon name="add" size={24} />
      {label}
    </>
  );
  return href === undefined ? (
    <button type="button" onClick={onClick} className={className}>
      {inner}
    </button>
  ) : (
    <Link href={href} className={className}>
      {inner}
    </Link>
  );
}

/**
 * The phone's navigation sheet, opened by the app bar's menu button and by
 * More: every entry this process draws, then the account items (lite mode,
 * language, sign out) that live in the desktop bar and avatar menu. A modal
 * bottom sheet on the scrim; Escape or a press on the scrim closes it, and
 * focus goes back to what opened it.
 */
function NavSheet({
  t,
  locale,
  locales,
  live,
  current,
  onClose,
}: {
  t: Translator;
  locale: string;
  locales: readonly LanguageOption[];
  live: readonly string[];
  current: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const name = useShellUserName();
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement;
    sheetRef.current?.querySelector<HTMLElement>('a, button')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-end md:hidden"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-scrim" />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="crm-nav-sheet"
        className="flex max-h-screen w-full flex-col overflow-y-auto rounded-t-xl bg-surface-raised p-2 pb-4 shadow-3"
      >
        <div className="flex items-center gap-2 ps-3">
          <h2 id={titleId} className="flex-1 text-card-title">
            {t.t('records.nav.label')}
          </h2>
          <button type="button" aria-label={t.t('shell.menu.close')} onClick={onClose} className={BAR_BUTTON}>
            <Icon name="close" size={24} />
          </button>
        </div>
        <nav aria-labelledby={titleId} className="grid grid-cols-4 gap-1 pb-2">
          {shownNav(live).map((item) => {
            const href = liveHref(item, live);
            const active = item.id === current;
            const className = `flex min-h-shell-fab flex-col items-center justify-center gap-0.5 rounded-10 px-1 text-center text-micro font-semibold ${SHELL_FOCUS}`;
            const inner = (
              <>
                <Icon name={item.icon} size={22} />
                <span className="max-w-full truncate">{t.t(item.label)}</span>
              </>
            );
            return href === null ? (
              <span key={item.id} aria-disabled="true" className={`${className} text-text-muted`}>
                {inner}
                <span className="sr-only">{t.t('records.nav.soon')}</span>
              </span>
            ) : (
              <Link
                key={item.id}
                href={href}
                onClick={onClose}
                aria-current={active ? 'page' : undefined}
                className={`${className} ${active ? 'bg-primary-soft text-primary-text' : 'text-text-2 is-hover:bg-surface-sunken'}`}
              >
                {inner}
              </Link>
            );
          })}
        </nav>
        <div role="menu" aria-label={t.t('auth.account')} onKeyDown={moveInMenu} className="flex flex-col border-t border-border pt-1">
          <AccountItems t={t} locale={locale} locales={locales} withLite name={name} />
        </div>
      </div>
    </div>
  );
}

/** The dimmed page behind the palette's interim states: Escape (caught first, M1) and a press on it close. */
function PaletteOverlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onEscape, true);
    return () => document.removeEventListener('keydown', onEscape, true);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center sm:p-4 sm:pt-16"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <span aria-hidden="true" className="absolute inset-0 -z-10 bg-scrim" />
      {children}
    </div>
  );
}

/** While the palette's code arrives on a slow link: a status, never nothing, and it can still be dismissed. */
function PaletteLoading({ t, onClose }: { t: Translator; onClose: () => void }) {
  return (
    <PaletteOverlay onClose={onClose}>
      <p role="status" className="w-full max-w-xl bg-surface-raised p-4 text-body-md text-text-2 shadow-3 sm:rounded-14">
        {t.t(SHELL_SEARCH_STRINGS.loading)}
      </p>
    </PaletteOverlay>
  );
}

/** The palette's code did not arrive: say so, and offer to try again or to close (D-L137 M4). */
function PaletteFailed({ t, onClose, onRetry }: PaletteProps) {
  const titleId = useId();
  const retryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    retryRef.current?.focus();
  }, []);
  return (
    <PaletteOverlay onClose={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="command-palette-failed"
        className="flex w-full max-w-xl flex-col items-start gap-2 bg-surface-raised p-4 shadow-3 sm:rounded-14"
      >
        <h2 id={titleId} className="flex items-center gap-2 text-card-title">
          <Icon name="error" size={20} />
          {t.t(SHELL_SEARCH_STRINGS.failedTitle)}
        </h2>
        <p className="text-body-sm text-text-2">{t.t(SHELL_SEARCH_STRINGS.failedBody)}</p>
        <div className="flex flex-wrap gap-2">
          <Button ref={retryRef} variant="ghost" onClick={onRetry}>
            {t.t(SHELL_SEARCH_STRINGS.retry)}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t.t(SHELL_SEARCH_STRINGS.close)}
          </Button>
        </div>
      </div>
    </PaletteOverlay>
  );
}
