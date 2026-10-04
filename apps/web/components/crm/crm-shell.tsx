'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { LanguageMenu, type LanguageOption } from '../auth/language-menu';
import { LiteModeToggle } from '../auth/lite-mode';
import { CRM_NAV, type CrmNavItem } from './crm-nav';

/**
 * The CRM app shell (T-0042) — the frame every record screen sits in, and NOT
 * the admin console's. Different people, different jobs: an agent working a
 * queue never sees the settings menu, and an admin frame wearing a different
 * menu would leak one into the other.
 *
 * A sidebar from `md` up and a five-item bottom bar at 360 px, as P04 draws
 * both. Unbuilt destinations are non-links (see `crm-nav.ts`).
 *
 * Still to come, and deliberately absent rather than faked: the global search
 * and Ctrl K palette, notifications, agent availability and the account menu.
 * Each needs an API that does not exist yet; a control that does nothing is a
 * promise the product breaks the first time someone presses it.
 */

const LINK_FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

function SideItem({ item, current, t }: { item: CrmNavItem; current: string; t: Translator }) {
  const active = item.id === current;
  const className = `flex min-h-touch items-center gap-3 rounded-md px-3 text-body-sm font-semibold ${LINK_FOCUS}`;
  if (item.href === null) {
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
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={`${className} ${active ? 'bg-primary-soft text-primary-text' : 'text-text hover:bg-surface-sunken'}`}
    >
      <Icon name={item.icon} size="sm" />
      {t.t(item.label)}
    </Link>
  );
}

function BottomItem({ item, current, t }: { item: CrmNavItem; current: string; t: Translator }) {
  const active = item.id === current;
  const className = `flex min-h-touch min-w-0 flex-col items-center justify-center gap-1 px-1 text-caption font-semibold ${LINK_FOCUS}`;
  const inner = (
    <>
      <Icon name={item.icon} size="sm" />
      <span className="max-w-full truncate">{t.t(item.label)}</span>
    </>
  );
  if (item.href === null) {
    return (
      <span aria-disabled="true" className={`${className} text-text-muted`}>
        {inner}
        <span className="sr-only">{t.t('records.nav.soon')}</span>
      </span>
    );
  }
  return (
    <Link
      href={item.href}
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
  children,
}: {
  t: Translator;
  locale: string;
  locales: readonly LanguageOption[];
  /** The nav item id of the screen inside, for `aria-current`. */
  current: string;
  children: ReactNode;
}) {
  return (
    <div data-shell="crm" className="flex min-h-screen flex-col bg-bg text-text">
      <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <Link href="/contacts" className={`flex shrink-0 items-center gap-2 rounded-md ${LINK_FOCUS}`}>
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-body-md font-extrabold text-accent"
          >
            {t.t('app.name').slice(0, 1)}
          </span>
          <b className="text-body-md">{t.t('app.name')}</b>
        </Link>
        <span className="flex-1" />
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

      <div className="flex min-w-0 flex-1 items-stretch">
        <nav
          aria-label={t.t('records.nav.label')}
          className="hidden w-56 shrink-0 flex-col gap-1 border-e border-border bg-surface p-3 md:flex"
        >
          {CRM_NAV.map((item) => (
            <SideItem key={item.id} item={item} current={current} t={t} />
          ))}
        </nav>
        <div className="min-w-0 flex-1 p-4 pb-16 md:p-6">{children}</div>
      </div>

      <nav
        aria-label={t.t('records.nav.label')}
        className="fixed inset-x-0 bottom-0 z-30 grid h-16 grid-cols-5 border-t border-border bg-surface md:hidden"
      >
        {CRM_NAV.filter((item) => item.mobile).map((item) => (
          <BottomItem key={item.id} item={item} current={current} t={t} />
        ))}
      </nav>
    </div>
  );
}
