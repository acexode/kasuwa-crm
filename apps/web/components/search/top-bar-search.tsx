'use client';

import { useRouter } from 'next/navigation';
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Kbd } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { useLiteMode } from '../auth/lite-mode';
import { CRM_NAV, liveHref } from '../crm/crm-nav';
import { SHELL_SEARCH_STRINGS } from './message-ids';
import type { DropdownKeys, DropdownProps } from './search-dropdown';
import { clearSearchText, setSearchOrigin, setSearchText, useSearchField } from './search-store';

/**
 * The top-bar search field (T-0138, P27 A and C), the Commands button and
 * the shell's keyboard shortcuts. Drawn by the CRM shell from `md` up where
 * search is in the server's live list (the flag is never named on the client).
 *
 *   - Idle it is a 42px sunken field, radius 10, with a `/` key; focused it is
 *     surface with a focus edge and a 3px primary-soft halo, a clear button
 *     once something is typed, and the P27 dropdown 6px under it.
 *   - `/` focuses it from anywhere that is not a text field; Ctrl/Cmd+K is the
 *     palette, which the Commands button also opens (mouse and touch).
 *   - On `/search` the field IS the results page's box: no dropdown, the page
 *     follows what is typed (`search-store`).
 *
 * The dropdown's code is loaded on the first focus (R29), so a page where the
 * field is never used pays only for this file.
 */

function failedDropdown(): { default: ComponentType<DropdownProps> } {
  return { default: DropdownFailed };
}

const SearchDropdown = lazy(() => import('./search-dropdown').then((module) => ({ default: module.default }), failedDropdown));
const ScopeMenu = lazy(() =>
  import('./search-dropdown').then(
    (module) => ({ default: module.ScopeMenu }),
    () => ({ default: (() => null) as ComponentType<{ t: Translator; onClose: () => void }> }),
  ),
);

/** The design's 3px primary-soft halo around the focused field. */
const FIELD_OPEN = 'border-focus bg-surface shadow-[0_0_0_3px_var(--k-primary-soft)]';
const FIELD_IDLE = 'border-surface-sunken bg-surface-sunken';

export function isTyping(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName);
}

export function TopBarSearch({
  t,
  live,
  current,
  onOpenPalette,
}: {
  t: Translator;
  live: readonly string[];
  current: string;
  onOpenPalette: () => void;
}) {
  const router = useRouter();
  const { text } = useSearchField();
  const onResults = current === 'search';
  const scope = live.includes('programme_scope_search');
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [active, setActive] = useState<{ id: string | undefined; expanded: boolean }>({ id: undefined, expanded: false });
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const keysRef = useRef<DropdownKeys>(null);
  const listboxId = useId();

  // A screen other than the results page starts with an empty field: nothing typed outlives the screen it was typed on.
  useEffect(() => {
    if (!onResults) clearSearchText();
  }, [onResults]);

  const close = useCallback(() => {
    setOpen(false);
    setScopeOpen(false);
    setActive({ id: undefined, expanded: false });
  }, []);

  // `/` focuses the field from anywhere that is not a text field or a modal dialog (P27 `_key`).
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (isTyping(document.activeElement) || document.querySelector('[aria-modal="true"]') !== null) return;
      if (inputRef.current === null || inputRef.current.getClientRects().length === 0) return;
      event.preventDefault();
      inputRef.current.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // A press outside the field and its panels closes them.
  useEffect(() => {
    if (!open && !scopeOpen) return undefined;
    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Node && wrapRef.current?.contains(event.target) === true) return;
      close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, scopeOpen, close]);

  const onActive = useCallback((id: string | undefined, expanded: boolean) => setActive({ id, expanded }), []);

  const onNavigate = useCallback(
    (href: string) => {
      close();
      clearSearchText();
      inputRef.current?.blur();
      router.push(href);
    },
    [close, router],
  );

  const onSeeAll = useCallback(() => {
    setSearchOrigin(current);
    close();
    inputRef.current?.blur();
    router.push('/search');
  }, [close, current, router]);

  const openPalette = useCallback(() => {
    close();
    onOpenPalette();
  }, [close, onOpenPalette]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      event.currentTarget.blur();
      return;
    }
    if (onResults) return;
    if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) setOpen(true);
    keysRef.current?.onKey(event);
  };

  const showDropdown = open && !onResults;
  const lit = focused || showDropdown;

  return (
    <div
      ref={wrapRef}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        if (event.relatedTarget !== null) close();
      }}
      className="relative ms-4 hidden min-w-0 flex-[0_1_600px] md:block"
    >
      <div
        className={`flex h-[42px] items-center gap-1.5 rounded-10 border pe-1.5 ps-[5px] transition-colors duration-instant ${lit ? FIELD_OPEN : FIELD_IDLE}`}
      >
        {scope ? (
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={scopeOpen}
            title={t.t(SHELL_SEARCH_STRINGS.scopeTitle)}
            data-testid="search-scope"
            onClick={() => {
              setOpen(false);
              setScopeOpen((value) => !value);
            }}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] bg-primary-soft pe-1.5 ps-[9px] text-meta font-bold text-primary-text outline-none focus-visible:ring-focus"
          >
            <Icon name="badge" size={18} />
            {t.t(SHELL_SEARCH_STRINGS.scopeAll)}
            <Icon name="expand_more" size={18} />
          </button>
        ) : (
          <Icon name="search" size={20} className="ps-1.5 text-text-muted" />
        )}
        <input
          ref={inputRef}
          data-testid="shell-search"
          type="text"
          role="combobox"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={text}
          aria-label={t.t(SHELL_SEARCH_STRINGS.fieldLabel)}
          aria-keyshortcuts="/"
          aria-autocomplete="list"
          aria-expanded={showDropdown && active.expanded}
          aria-controls={showDropdown && active.expanded ? listboxId : undefined}
          aria-activedescendant={showDropdown ? active.id : undefined}
          placeholder={t.t(scope ? SHELL_SEARCH_STRINGS.scopePlaceholder : 'shell.search.placeholder')}
          onFocus={() => {
            setFocused(true);
            setScopeOpen(false);
            if (!onResults) setOpen(true);
          }}
          onBlur={() => setFocused(false)}
          onChange={(event) => {
            setSearchText(event.target.value);
            if (!onResults) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent px-1 text-body-sm text-text outline-none placeholder:text-text-muted"
        />
        {text === '' ? null : (
          <button
            type="button"
            aria-label={t.t(SHELL_SEARCH_STRINGS.clear)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setSearchText('');
              inputRef.current?.focus();
            }}
            className="flex size-[30px] shrink-0 items-center justify-center rounded-6 text-text-2 outline-none is-hover:bg-surface-sunken focus-visible:ring-focus"
          >
            <Icon name="close" size={18} />
          </button>
        )}
        {lit || text !== '' ? null : (
          <kbd
            title={t.t(SHELL_SEARCH_STRINGS.slashHint)}
            className="me-1 inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-sm border border-border-strong px-[5px] font-mono text-caption font-semibold text-text-2"
          >
            {t.t(SHELL_SEARCH_STRINGS.slashKey)}
          </kbd>
        )}
      </div>

      {showDropdown ? (
        <Suspense fallback={<DropdownLoading t={t} />}>
          <SearchDropdown
            t={t}
            text={text}
            live={live}
            listboxId={listboxId}
            keysRef={keysRef}
            onActive={onActive}
            onNavigate={onNavigate}
            onSeeAll={onSeeAll}
            onOpenPalette={openPalette}
          />
        </Suspense>
      ) : null}
      {scope && scopeOpen ? (
        <Suspense fallback={null}>
          <ScopeMenu
            t={t}
            onClose={() => {
              setScopeOpen(false);
              inputRef.current?.focus();
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

/** While the dropdown's code arrives on a slow link: its frame and a status line, never nothing. */
function DropdownLoading({ t }: { t: Translator }) {
  return (
    <p
      role="status"
      className="absolute start-0 top-12 z-40 m-0 w-[600px] max-w-[calc(100vw-120px)] rounded-lg border border-border bg-surface px-4 py-3 text-caption font-normal text-text-muted shadow-3 min-[1280px]:w-[680px]"
    >
      {t.t(SHELL_SEARCH_STRINGS.loading)}
    </p>
  );
}

/** The dropdown's code did not arrive: say so in its place (D-L137 M4); focusing again retries. */
function DropdownFailed({ t }: DropdownProps) {
  return (
    <p
      role="alert"
      className="absolute start-0 top-12 z-40 m-0 flex w-[600px] max-w-[calc(100vw-120px)] flex-col gap-1 rounded-lg border border-border bg-surface px-4 py-3 shadow-3 min-[1280px]:w-[680px]"
    >
      <b className="text-body-sm">{t.t(SHELL_SEARCH_STRINGS.failedTitle)}</b>
      <span className="text-caption font-normal text-text-2">{t.t(SHELL_SEARCH_STRINGS.failedBody)}</span>
    </p>
  );
}

/**
 * The top bar's Commands button (P27): 40px, radius 8, a bordered surface,
 * a 20px bolt, "Commands" from 1280px up, and the Ctrl K key. It opens the
 * palette, so the palette is not reachable by keyboard alone.
 */
export function CommandsButton({ t, onClick }: { t: Translator; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={t.t(SHELL_SEARCH_STRINGS.commandsOpen)}
      aria-keyshortcuts="Control+K Meta+K"
      aria-haspopup="dialog"
      data-testid="shell-commands"
      onClick={onClick}
      className="hidden h-control-md shrink-0 items-center gap-2 whitespace-nowrap rounded-md border border-border bg-surface px-2.5 text-meta font-semibold text-text-2 outline-none is-hover:bg-surface-sunken focus-visible:ring-focus md:inline-flex"
    >
      <Icon name="bolt" size={20} />
      <span className="hidden min-[1280px]:inline">{t.t(SHELL_SEARCH_STRINGS.commands)}</span>
      <Kbd aria-hidden="true">{t.t('design.components.kbd.search')}</Kbd>
    </button>
  );
}

/** "G then a letter" goes to a screen, as the palette's Go to rows show (P27 D). */
export const GO_KEYS: Readonly<Record<string, string>> = {
  home: 'H',
  inbox: 'I',
  contacts: 'C',
  deals: 'D',
  tickets: 'T',
  calls: 'A',
  reports: 'R',
};

/**
 * The shortcuts the palette's rows promise, live without opening it:
 * G then H, I, C, D, T, A or R goes to that screen where it answers, and
 * Ctrl/Cmd+Shift+L turns low-bandwidth mode on or off. Never while typing or
 * over a modal dialog.
 */
export function useShellShortcuts(live: readonly string[], enabled: boolean): void {
  const router = useRouter();
  const { lite, setLite } = useLiteMode();
  const liteRef = useRef(lite);
  liteRef.current = lite;
  useEffect(() => {
    if (!enabled) return undefined;
    let pendingG = 0;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || isTyping(document.activeElement) || document.querySelector('[aria-modal="true"]') !== null) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && (event.code === 'KeyL' || key === 'l')) {
        event.preventDefault();
        setLite(!liteRef.current);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (key === 'g' && !event.shiftKey) {
        pendingG = Date.now();
        return;
      }
      if (pendingG === 0 || Date.now() - pendingG > 1500) return;
      pendingG = 0;
      const item = CRM_NAV.find((entry) => GO_KEYS[entry.id]?.toLowerCase() === key);
      const href = item === undefined ? null : liveHref(item, live);
      if (href === null) return;
      event.preventDefault();
      router.push(href);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled, live, router, setLite]);
}
