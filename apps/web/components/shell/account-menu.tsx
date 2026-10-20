'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import type { LanguageOption } from '../auth/language-choice';
import type { AccountItems as AccountItemsComponent } from './account-items';
import { SHELL_FOCUS, ShellAvatar } from './shell-parts';
import { useShellUserName } from './use-shell-user';

/**
 * The account menu behind the header avatar (T-0130). The design's top bars
 * carry no language button and no "Sign out" link: both moved here, so the bar
 * is the design's (search, lite mode, bell, avatar) and nothing else.
 *
 * `AccountItems` (its own module) is the list itself, shared by the desktop
 * popover and the phone's More sheet, so the two cannot drift. It loads on the
 * first press (T-0145): the popover opens once it has arrived, so it is never
 * drawn empty, and focus lands on an item exactly as before. Menu rows follow the v1.1 menu:
 * 40px rows at radius 6, 14px text, the selected language primary-soft with a
 * check, 11/700 caps section labels.
 *
 * Sign out (ADR-0019 point 5) ends the session at the API through the BFF and
 * always goes on to sign-in with a full navigation, so nothing of the signed-in
 * screen survives into the signed-out one.
 */


type ItemsComponent = typeof AccountItemsComponent;

let itemsModule: Promise<ItemsComponent> | null = null;

/**
 * The account items' module, fetched once. A failed fetch is forgotten, so
 * the next press tries again rather than leaving the menu shut for good.
 */
export function loadAccountItems(): Promise<ItemsComponent> {
  itemsModule ??= import('./account-items').then(
    (module) => module.AccountItems,
    (error: unknown) => {
      itemsModule = null;
      throw error;
    },
  );
  return itemsModule;
}

/** Starts the fetch early, on a hover or a focus, so a press usually finds it there. */
export function preloadAccountItems(): void {
  loadAccountItems().catch(() => undefined);
}

/** Up and Down move between the menu's items, Home and End to the ends (WAI-ARIA menu). */
export function moveInMenu(event: ReactKeyboardEvent<HTMLElement>): void {
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
  ];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === 'ArrowDown'
      ? (at + 1) % items.length
      : event.key === 'ArrowUp'
        ? (at - 1 + items.length) % items.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : null;
  if (next === null || items.length === 0) return;
  event.preventDefault();
  items[next]?.focus();
}

/**
 * The 36px avatar button and its popover (radius 10, padding 4, surface-raised,
 * shadow-2). Escape and a press outside close it; Escape puts focus back on
 * the avatar.
 */
export function AccountMenu({
  t,
  locale,
  locales,
  withLite,
}: {
  t: Translator;
  locale: string;
  locales: readonly LanguageOption[];
  withLite: boolean;
}) {
  const name = useShellUserName();
  const [open, setOpen] = useState(false);
  const [Items, setItems] = useState<ItemsComponent | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const first =
      menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"][aria-checked="true"]') ??
      menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]');
    first?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !containerRef.current?.contains(event.target)) setOpen(false);
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
    <div ref={containerRef} className="relative flex shrink-0">
      <button
        ref={buttonRef}
        type="button"
        data-testid="user-menu"
        aria-label={name === null ? t.t('auth.account') : `${t.t('auth.account')}: ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onPointerEnter={preloadAccountItems}
        onFocus={preloadAccountItems}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          loadAccountItems().then(
            (loaded) => {
              setItems(() => loaded);
              setOpen(true);
            },
            () => undefined,
          );
        }}
        // 36px drawn, a 44px target: the invisible band keeps the hit area.
        className={`relative flex rounded-full before:absolute before:-inset-1 ${SHELL_FOCUS}`}
      >
        <ShellAvatar name={name} locale={locale} />
      </button>
      {open && Items !== null ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={t.t('auth.account')}
          onKeyDown={(event) => {
            if (event.key === 'Tab') setOpen(false);
            moveInMenu(event);
          }}
          className="absolute end-0 top-full z-40 mt-2 flex w-64 flex-col rounded-10 border border-border bg-surface-raised p-1 shadow-2"
        >
          <Items t={t} locale={locale} locales={locales} withLite={withLite} name={name} />
        </div>
      ) : null}
    </div>
  );
}
