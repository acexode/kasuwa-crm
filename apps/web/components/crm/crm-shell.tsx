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
import { Icon } from '../icon';
import { LanguageMenu, type LanguageOption } from '../auth/language-menu';
import { LiteModeToggle } from '../auth/lite-mode';
import { SHELL_SEARCH_STRINGS } from '../search/message-ids';
import { CRM_NAV, liveHref, type CrmNavItem } from './crm-nav';

/**
 * The bell is its OWN chunk (D-L182): a lazy `import()` (React's own, as the palette's: `next/dynamic` would add its runtime to every page) that is rendered only where
 * the server-side flag says so, so a process with the notifications flag off never ships
 * its component, poller, store or writes, and the shell costs it nothing.
 */
const NotificationBell = lazy(() => import('../notifications/bell'));

/**
 * The CRM app shell (T-0042) — the frame every record screen sits in, and NOT
 * the admin console's. Different people, different jobs: an agent working a
 * queue never sees the settings menu, and an admin frame wearing a different
 * menu would leak one into the other.
 *
 * A sidebar from `md` up and a five-item bottom bar at 360 px, as P04 draws
 * both. Unbuilt destinations are non-links (see `crm-nav.ts`).
 *
 * THE GLOBAL SEARCH (T-0087, P27). Where its flag is on in this process
 * (`live.includes('search')`, from `crmLiveNav()`), the header links `/search`
 * and Control+K or Meta+K opens the command palette from anywhere in the
 * shell, a text field included. The palette's code is a dynamic `import()`
 * made on the first open (R29): it is in no screen's first load, so a user who
 * never opens it never pays for it. While it is open, everything behind it is
 * inert; when it closes, focus goes back to where it was.
 *
 * THE BELL (T-0101, P26). Where the notifications flag is on in this process
 * (`live.includes('notifications')`), the header draws the notifications bell:
 * its code, the count store and the poller are in this shell's first load, and
 * the dropdown is a dynamic `import()` on its first open.
 *
 * Still to come, and deliberately absent rather than faked: agent availability
 * and the account menu. Each needs an API that does not
 * exist yet; a control that does nothing is a promise the product breaks the
 * first time someone presses it.
 */

interface PaletteProps {
  t: Translator;
  onClose: () => void;
  onRetry: () => void;
  dealsLive: boolean;
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

const QUIET_BUTTON_SHELL =
  'flex min-h-touch items-center justify-center gap-2 rounded-md px-3 text-body-sm font-semibold text-primary-text hover:bg-surface-sunken';

const LINK_FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

function SideItem({ item, href, current, t }: { item: CrmNavItem; href: string | null; current: string; t: Translator }) {
  const active = item.id === current;
  const className = `flex min-h-touch items-center gap-3 rounded-md px-3 text-body-sm font-semibold ${LINK_FOCUS}`;
  if (href === null) {
    return (
      <span aria-disabled="true" className={`${className} text-text-muted`}>
        <Icon name={item.icon} size="sm" />
        {t.t(item.label)}
        <span className="sr-only">{t.t('records.nav.soon')}</span>
      </span>
    );
  }
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`${className} ${active ? 'bg-primary-soft text-primary-text' : 'text-text hover:bg-surface-sunken'}`}
    >
      <Icon name={item.icon} size="sm" />
      {t.t(item.label)}
    </Link>
  );
}

function BottomItem({ item, href, current, t }: { item: CrmNavItem; href: string | null; current: string; t: Translator }) {
  const active = item.id === current;
  const className = `flex min-h-touch min-w-0 flex-col items-center justify-center gap-1 px-1 text-caption font-semibold ${LINK_FOCUS}`;
  const inner = (
    <>
      <Icon name={item.icon} size="sm" />
      <span className="max-w-full truncate">{t.t(item.label)}</span>
    </>
  );
  if (href === null) {
    return (
      <span aria-disabled="true" className={`${className} text-text-muted`}>
        {inner}
        <span className="sr-only">{t.t('records.nav.soon')}</span>
      </span>
    );
  }
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`${className} ${active ? 'text-primary-text' : 'text-text'}`}
    >
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
  children,
}: {
  t: Translator;
  locale: string;
  locales: readonly LanguageOption[];
  /** The nav item id of the screen inside, for `aria-current`. */
  current: string;
  /** Nav ids whose route is on in this process (`crmLiveNav()`); only these link. */
  live: readonly string[];
  children: ReactNode;
}) {
  // The wordmark goes to the first screen that answers here: the one inside
  // is always among them, so it is never a link to a 404.
  const home = CRM_NAV.map((item) => liveHref(item, live)).find((href) => href !== null) ?? null;
  const searchLive = live.includes('search');
  const bellLive = live.includes('notifications');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [Palette, setPalette] = useState<LazyExoticComponent<ComponentType<PaletteProps>> | null>(null);
  const openRef = useRef(false);
  const openerRef = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  openRef.current = paletteOpen;

  // Control+K and Meta+K, from anywhere in the shell, a text field included
  // (R4), on any keyboard layout (`code` is the physical key, D-L137 L2). Not
  // over another modal dialog: that dialog owns the page until it closes (M1).
  useEffect(() => {
    if (!searchLive) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const isK = event.code === 'KeyK' || event.key.toLowerCase() === 'k';
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || !isK) return;
      event.preventDefault();
      if (openRef.current || document.querySelector('[aria-modal="true"]') !== null) return;
      openerRef.current = document.activeElement;
      // `lazy` returns an object, not a function, so React stores it rather than calling it.
      setPalette((current: LazyExoticComponent<ComponentType<PaletteProps>> | null) => current ?? loadPalette());
      setPaletteOpen(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [searchLive]);

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

  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const retryPalette = useCallback(() => setPalette(loadPalette()), []);
  const behind = paletteOpen ? { inert: true } : {};

  return (
    <div data-shell="crm" className="flex min-h-screen flex-col bg-bg text-text">
      <header {...behind} className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <Link href={home ?? `/${current}`} className={`flex shrink-0 items-center gap-2 rounded-md ${LINK_FOCUS}`}>
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-body-md font-extrabold text-accent"
          >
            {t.t('app.name').slice(0, 1)}
          </span>
          {/* With the bell the 360 px header is one 44 px target too wide: the name goes to the screen reader alone below `sm`. */}
          <b className={`text-body-md ${bellLive ? 'sr-only sm:not-sr-only' : ''}`}>{t.t('app.name')}</b>
        </Link>
        <span className="flex-1" />
        {searchLive ? (
          <Link
            href="/search"
            prefetch={false}
            aria-current={current === 'search' ? 'page' : undefined}
            aria-keyshortcuts="Control+K Meta+K"
            className={`flex min-h-touch min-w-touch shrink-0 items-center justify-center gap-2 rounded-md border border-border px-2 text-body-sm font-semibold sm:px-3 ${
              current === 'search' ? 'bg-primary-soft text-primary-text' : 'bg-surface text-text hover:bg-surface-sunken'
            } ${LINK_FOCUS}`}
          >
            <Icon name="search" size="sm" />
            <span className="sr-only sm:not-sr-only">{t.t(SHELL_SEARCH_STRINGS.entry)}</span>
          </Link>
        ) : null}
        {bellLive ? (
          <Suspense>
            <NotificationBell t={t} locale={locale} live={live} />
          </Suspense>
        ) : null}
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
      </header>

      <div {...behind} className="flex min-w-0 flex-1 items-stretch">
        <nav
          aria-label={t.t('records.nav.label')}
          className="hidden w-56 shrink-0 flex-col gap-1 border-e border-border bg-surface p-3 md:flex"
        >
          {CRM_NAV.map((item) => (
            <SideItem key={item.id} item={item} href={liveHref(item, live)} current={current} t={t} />
          ))}
        </nav>
        <div className="min-w-0 flex-1 p-4 pb-16 md:p-6">{children}</div>
      </div>

      <nav
        {...behind}
        aria-label={t.t('records.nav.label')}
        className="fixed inset-x-0 bottom-0 z-30 grid h-16 grid-cols-5 border-t border-border bg-surface md:hidden"
      >
        {CRM_NAV.filter((item) => item.mobile).map((item) => (
          <BottomItem key={item.id} item={item} href={liveHref(item, live)} current={current} t={t} />
        ))}
      </nav>

      {searchLive && paletteOpen && Palette !== null ? (
        <Suspense fallback={<PaletteLoading t={t} onClose={closePalette} />}>
          <Palette t={t} onClose={closePalette} onRetry={retryPalette} dealsLive={live.includes('deals')} />
        </Suspense>
      ) : null}
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
      <span aria-hidden="true" className="absolute inset-0 -z-10 bg-inverse opacity-60" />
      {children}
    </div>
  );
}

/** While the palette's code arrives on a slow link: a status, never nothing, and it can still be dismissed. */
function PaletteLoading({ t, onClose }: { t: Translator; onClose: () => void }) {
  return (
    <PaletteOverlay onClose={onClose}>
      <p role="status" className="w-full max-w-xl bg-surface-raised p-4 text-body-md text-text-2 shadow-3 sm:rounded-lg">
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
        className="flex w-full max-w-xl flex-col items-start gap-2 bg-surface-raised p-4 shadow-3 sm:rounded-lg"
      >
        <h2 id={titleId} className="flex items-center gap-2 text-h4 font-bold">
          <Icon name="error" size="sm" />
          {t.t(SHELL_SEARCH_STRINGS.failedTitle)}
        </h2>
        <p className="text-body-sm text-text-2">{t.t(SHELL_SEARCH_STRINGS.failedBody)}</p>
        <div className="flex flex-wrap gap-2">
          <button ref={retryRef} type="button" onClick={onRetry} className={`${QUIET_BUTTON_SHELL} ${LINK_FOCUS}`}>
            {t.t(SHELL_SEARCH_STRINGS.retry)}
          </button>
          <button type="button" onClick={onClose} className={`${QUIET_BUTTON_SHELL} ${LINK_FOCUS}`}>
            {t.t(SHELL_SEARCH_STRINGS.close)}
          </button>
        </div>
      </div>
    </PaletteOverlay>
  );
}
