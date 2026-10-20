'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { BetaBadge, chooseLanguage, type LanguageOption } from '../auth/language-menu';
import { useLiteMode } from '../auth/lite-mode';
import { signOut } from '../../lib/sign-out';
import { SIGN_IN_PATH } from '../../lib/api-fetch';
import { SHELL_FOCUS, ShellAvatar } from './shell-parts';
import { useShellUserName } from './use-shell-user';

/**
 * The account menu behind the header avatar (T-0130). The design's top bars
 * carry no language button and no "Sign out" link: both moved here, so the bar
 * is the design's (search, lite mode, bell, avatar) and nothing else.
 *
 * `AccountItems` is the list itself, shared by the desktop popover and the
 * phone's More sheet, so the two cannot drift. Menu rows follow the v1.1 menu:
 * 40px rows at radius 6, 14px text, the selected language primary-soft with a
 * check, 11/700 caps section labels.
 *
 * Sign out (ADR-0019 point 5) ends the session at the API through the BFF and
 * always goes on to sign-in with a full navigation, so nothing of the signed-in
 * screen survives into the signed-out one.
 */

const ROW = `flex h-control-md w-full items-center gap-2.5 rounded-6 px-3 text-start text-body-sm text-text is-hover:bg-surface-sunken ${SHELL_FOCUS}`;

export function AccountItems({
  t,
  locale,
  locales,
  withLite,
  name,
}: {
  t: Translator;
  locale: string;
  locales: readonly LanguageOption[];
  /** The lite-mode switch, where the bar itself has none (the admin bar, the phone sheet). */
  withLite: boolean;
  name: string | null;
}) {
  const [pending, setPending] = useState(false);
  const { lite, setLite } = useLiteMode();
  const groupId = useId();
  const helpLink = locales.find((option) => option.beta !== undefined)?.beta;

  return (
    <>
      {name === null ? null : (
        <p className="truncate px-3 pb-1 pt-2 text-body-sm font-semibold text-text">{name}</p>
      )}
      {withLite ? (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={lite}
          data-testid="lite-mode-toggle"
          onClick={() => setLite(!lite)}
          className={ROW}
        >
          <Icon name="network_check" size={20} className="text-text-2" />
          <span className="flex-1">{t.t('auth.topbar.lite.toggle')}</span>
          {lite ? <Icon name="check" size={20} className="text-primary-text" /> : null}
        </button>
      ) : null}
      <p id={groupId} className="px-3 pb-1 pt-2 text-overline text-text-muted">
        {t.t('auth.topbar.language')}
      </p>
      <div role="group" aria-labelledby={groupId} className="flex flex-col">
        {locales.map((option) => {
          const selected = option.code === locale;
          return (
            <button
              key={option.code}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              lang={option.code}
              data-testid="language-option"
              onClick={() => {
                if (!selected) chooseLanguage(option.code);
              }}
              className={`${ROW} ${selected ? 'bg-primary-soft font-semibold' : ''}`}
            >
              <span className="flex-1">{option.label}</span>
              {option.beta === undefined ? null : <BetaBadge text={option.beta.badge} lang={locale} />}
              {selected ? <Icon name="check" size={20} className="text-primary-text" /> : null}
            </button>
          );
        })}
      </div>
      {helpLink === undefined ? null : (
        <a
          href={helpLink.href}
          role="menuitem"
          data-testid="language-help"
          lang={locale}
          className={`${ROW} font-semibold text-primary-text underline underline-offset-2`}
        >
          <Icon name="translate" size={20} />
          {helpLink.help}
        </a>
      )}
      <span role="separator" className="mx-1 my-1 block border-t border-border" />
      <button
        type="button"
        role="menuitem"
        data-testid="sign-out"
        aria-busy={pending || undefined}
        aria-disabled={pending || undefined}
        onClick={() => {
          if (pending) return;
          setPending(true);
          void signOut().then(() => {
            window.location.assign(SIGN_IN_PATH);
          });
        }}
        className={ROW}
      >
        <Icon name="logout" size={20} className="text-text-2" />
        {t.t('auth.signOut')}
      </button>
    </>
  );
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
        onClick={() => setOpen((current) => !current)}
        // 36px drawn, a 44px target: the invisible band keeps the hit area.
        className={`relative flex rounded-full before:absolute before:-inset-1 ${SHELL_FOCUS}`}
      >
        <ShellAvatar name={name} locale={locale} />
      </button>
      {open ? (
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
          <AccountItems t={t} locale={locale} locales={locales} withLite={withLite} name={name} />
        </div>
      ) : null}
    </div>
  );
}
