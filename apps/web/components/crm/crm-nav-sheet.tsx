'use client';

import Link from 'next/link';
import { useEffect, useId, useRef } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import type { LanguageOption } from '../auth/language-choice';
import { AccountItems } from '../shell/account-items';
import { moveInMenu } from '../shell/account-menu';
import { SHELL_FOCUS } from '../shell/shell-parts';
import { useShellUserName } from '../shell/use-shell-user';
import { BAR_BUTTON } from './crm-classes';
import { liveHref, shownNav } from './crm-nav';

/**
 * The phone's navigation sheet, opened by the app bar's menu button and by
 * More: every entry this process draws, then the account items (lite mode,
 * language, sign out) that live in the desktop bar and avatar menu. A modal
 * bottom sheet on the scrim; Escape or a press on the scrim closes it, and
 * focus goes back to what opened it.
 *
 * Its own module (T-0145): drawn only after a press on the menu button or
 * More, so the shell fetches it then and opens it once it has arrived.
 */
export function NavSheet({
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
                prefetch={false}
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
