'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { MessageBundle, MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import type { LanguageOption } from '../auth/language-menu';
import { AdminShell } from '../admin/admin-shell';
import { SHELL_FOCUS } from '../shell/shell-parts';

/**
 * P28's "Data management" frame (T-0141): the admin bar with its section title
 * and residency pill (`AdminShell` with `section`, no settings menu), a 232px
 * sub-nav (196 at 1024; a scrolling row of tabs on a phone), the content
 * column at most 1240 wide, and the sticky action bar a step hands in.
 *
 * The sub-nav carries no counts and no status pills: the design's "Running",
 * "148", "1" and "2 due" come from modules that have no API yet, and a number
 * nobody served is a number nobody should act on (D-L194). A section whose
 * flag is off is drawn as the design draws it but is not a link, and says so.
 *
 * `AdminShell` pads its content; the frame cancels that padding so the sub-nav
 * runs edge to edge under the bar, as the export draws it.
 */

export type DataSection = 'import' | 'migration' | 'duplicates' | 'exports' | 'requests';

const SECTIONS: readonly { id: DataSection; icon: IconName; label: MessageId; href: string }[] = [
  { id: 'import', icon: 'upload_file', label: 'data.nav.import', href: '/admin/data/import' },
  { id: 'migration', icon: 'cloud_sync', label: 'data.nav.migration', href: '/admin/data/migration' },
  { id: 'duplicates', icon: 'join', label: 'data.nav.duplicates', href: '/admin/data/duplicates' },
  { id: 'exports', icon: 'download', label: 'data.nav.exports', href: '/admin/data/exports' },
  { id: 'requests', icon: 'privacy_tip', label: 'data.nav.requests', href: '/admin/data/requests' },
];

/** The sections whose screens are on in this process, read on the server by each page. */
export type DataLive = Readonly<Record<DataSection, boolean>>;

/** A sub-nav row: 44px, 0 10px, gap 10, radius 8, 14/600, a 20px glyph (P28). */
const ROW = `flex min-h-touch shrink-0 items-center gap-2.5 rounded-md px-2.5 text-body-sm font-semibold ${SHELL_FOCUS}`;

export function DataShell({
  t,
  locale,
  messages,
  locales,
  bell,
  current,
  live,
  footer,
  children,
}: {
  t: Translator;
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  bell: boolean;
  current: DataSection;
  live: DataLive;
  /** The sticky action bar's contents: status on the start side, actions on the end. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <AdminShell
      locale={locale}
      messages={messages}
      locales={locales}
      activeSettingId={null}
      linkedSettings={{}}
      bell={bell}
      nav={false}
      section={{ icon: 'database', label: t.t('data.shell.title') }}
    >
      <div
        data-frame="data-management"
        className="-m-4 flex min-h-[calc(100dvh-var(--k-shell-header))] flex-col md:-m-6 md:flex-row xl:-mx-8 xl:-mb-10 xl:-mt-7"
      >
        <nav
          aria-label={t.t('data.shell.title')}
          data-testid="data-nav"
          className="sticky top-shell-header z-10 flex shrink-0 gap-0.5 overflow-x-auto border-b border-border bg-surface px-2.5 py-2 md:h-[calc(100dvh-var(--k-shell-header))] md:w-shell-data-nav-compact md:flex-col md:overflow-visible md:border-b-0 md:border-e md:py-4 xl:w-shell-data-nav"
        >
          {SECTIONS.map((section) => {
            const here = section.id === current;
            const inner = (
              <>
                <Icon name={section.icon} size={20} />
                <span className="min-w-0 flex-1 truncate">{t.t(section.label)}</span>
              </>
            );
            const tone = here
              ? 'bg-primary-soft text-primary-text'
              : 'text-text is-hover:bg-surface-sunken';
            return live[section.id] ? (
              <Link
                key={section.id}
                href={section.href}
                prefetch={false}
                aria-current={here ? 'page' : undefined}
                data-data-section={section.id}
                className={`${ROW} ${tone}`}
              >
                {inner}
              </Link>
            ) : (
              <span
                key={section.id}
                aria-disabled="true"
                title={t.t('records.nav.soon')}
                data-data-section={section.id}
                className={`${ROW} cursor-not-allowed text-text-muted`}
              >
                {inner}
              </span>
            );
          })}
        </nav>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex w-full max-w-shell-data-content flex-1 flex-col gap-5 px-4 pb-8 pt-5 md:px-5 xl:px-8 xl:pb-10 xl:pt-7">
            {children}
          </div>
          {footer === undefined ? null : (
            <footer
              data-testid="data-action-bar"
              className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t border-border bg-surface px-4 py-3 md:px-5 xl:px-8"
            >
              {footer}
            </footer>
          )}
        </main>
      </div>
    </AdminShell>
  );
}

/**
 * The page header every P28 section draws: a 26/800 title, the 14/21 lede at
 * most 760 wide, and an optional action opposite.
 */
export function DataHeader({
  title,
  lede,
  back,
  action,
  children,
}: {
  title: ReactNode;
  lede?: ReactNode;
  /** The "← Duplicates" link above the title (C1, D1, E1). */
  back?: ReactNode;
  action?: ReactNode;
  /** Under the lede, 14px down: the stepper. */
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3.5">
      {back === undefined ? null : <div className="-mb-1.5">{back}</div>}
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="m-0 text-title-sm">{title}</h1>
          {lede === undefined ? null : (
            <p className="m-0 max-w-[760px] text-pretty text-body-relaxed text-text-2">{lede}</p>
          )}
        </div>
        {action === undefined ? null : <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      {children}
    </header>
  );
}

/** The bar's status text: an 18px glyph and a 13px line in text-2 (or a tone). */
export function BarStatus({
  icon,
  tone = 'muted',
  children,
}: {
  icon: IconName;
  tone?: 'muted' | 'danger' | 'success';
  children: ReactNode;
}) {
  const colour = tone === 'danger' ? 'text-danger-text' : tone === 'success' ? 'text-success-text' : 'text-text-2';
  return (
    <span className={`flex min-w-0 flex-1 items-center gap-1.5 text-meta ${colour}`}>
      <Icon name={icon} size={18} className="shrink-0" />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** "← Duplicates": a 13/600 primary-text link with an 18px arrow. */
export function BackLink({ href, onClick, children, testId, disabled }: { href?: string; onClick?: () => void; children: ReactNode; testId?: string; disabled?: boolean }) {
  const className = `inline-flex min-h-8 items-center gap-1.5 rounded-6 text-meta font-semibold text-primary-text is-hover:underline disabled:cursor-not-allowed disabled:text-disabled-text ${SHELL_FOCUS}`;
  const inner = (
    <>
      <Icon name="arrow_back" size={18} className="rtl:-scale-x-100" />
      {children}
    </>
  );
  if (href !== undefined) {
    return (
      <Link href={href} prefetch={false} className={className} data-testid={testId}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={className} data-testid={testId}>
      {inner}
    </button>
  );
}
