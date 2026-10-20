'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Banner } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { StillConnecting } from '../admin/panel';
import { QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { FOCUS, MENU_ROW } from './list-classes';
import { formatSyncedAt } from './list-model';

/**
 * The pieces every P04 record list draws the same way (T-0042 Contacts, T-0057
 * Accounts): the offline banner, the loading skeleton, the failed read, the
 * column chooser, a filter's options, a lock and a "Not set". One copy, so a
 * fix to how a lock or an offline list reads lands on every screen at once.
 *
 * Every id these render is in each screen's bundle (`message-ids.ts`): the
 * offline, loading, error, columns and lock copy under `records.*`.
 */

/**
 * P04/06 offline (T-0133): the design's inverse banner, above the header —
 * cloud_off, "You're offline.", when the list was last read with its zone in
 * mono, and Retry. The rows are still here (in memory, D-L64). No count of
 * cached rows (D-P13), and no promise of queued edits: there are none (D-P21).
 * On a phone it is the one-line strip.
 */
export function OfflineBanner({
  t,
  locale,
  syncedAt,
  onRetry,
}: {
  t: Translator;
  locale: string;
  syncedAt: Date | null;
  onRetry?: () => void;
}) {
  const time = syncedAt === null ? null : formatSyncedAt(locale, syncedAt);
  return (
    <div data-testid="offline-banner" className="-mx-4 -mt-4 md:mx-0 md:mt-0">
      <Banner
        tone="offline"
        icon="cloud_off"
        title={t.t('records.offline.title')}
        className="max-md:hidden"
        {...(onRetry === undefined ? {} : { action: { label: t.t('records.retry'), onClick: onRetry } })}
      >
        {time === null ? (
          t.t('records.offline.never')
        ) : (
          <>
            {t.t('records.offline.cached')} <span className="font-mono">{time}</span>
            {'. '}
            {t.t('records.offline.after')}
          </>
        )}
      </Banner>
      <p role="status" className="flex items-center gap-2 bg-inverse px-4 py-2 text-caption text-on-inverse md:hidden">
        <Icon name="cloud_off" size={16} />
        <span className="flex-1">
          <b>{t.t('records.offline.short')}</b>
          {time === null ? null : (
            <>
              {' · '}
              {t.t('records.offline.cachedShort')} <span className="font-mono">{time}</span>
            </>
          )}
        </span>
      </p>
    </div>
  );
}

/** Skeleton bar widths, cycled so the rows read as text of different lengths, never as a pattern. */
const BARS = ['w-28', 'w-36', 'w-44', 'w-32', 'w-40'] as const;

/**
 * P04/06 loading (T-0133): skeletons that keep the table's geometry — the
 * selection square, the avatar circle, a two-line name, the phone, the WA
 * disc, the email, a pill — and "Loading leads…" in the footer; on a phone,
 * card-shaped rows. On a slow link the "still connecting" offer of
 * low-bandwidth mode comes first. Never a bare spinner, never the empty state.
 */
export function ListLoading({ t, slow, label }: { t: Translator; slow: boolean; label: MessageId }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      {slow ? <StillConnecting t={t} /> : null}
      <span role="status" className="sr-only">
        {t.t(label)}
      </span>
      <div aria-hidden="true" className="hidden overflow-hidden rounded-lg border border-border bg-surface md:block">
        <div className="h-10 border-b border-border bg-surface-sunken" />
        {Array.from({ length: 12 }, (_, index) => (
          <div key={index} data-testid="skeleton-row" className="flex h-control-xl items-center gap-3 border-b border-border px-3">
            <span className="size-4 shrink-0 rounded-sm bg-surface-sunken" />
            <span className="ms-4 size-8 shrink-0 rounded-full bg-surface-sunken" />
            <span className="flex w-44 flex-col gap-1.5">
              <span className={`h-2.5 rounded-sm bg-surface-sunken ${BARS[index % BARS.length]}`} />
              <span className="h-2 w-28 rounded-sm bg-surface-sunken" />
            </span>
            <span className="ms-6 h-2.5 w-44 rounded-sm bg-surface-sunken" />
            <span className="ms-12 size-6 shrink-0 rounded-full bg-surface-sunken" />
            <span className={`ms-6 hidden h-2.5 rounded-sm bg-surface-sunken lg:block ${BARS[(index + 2) % BARS.length]}`} />
            <span className="ms-6 hidden h-2.5 w-24 rounded-sm bg-surface-sunken xl:block" />
            <span className="flex-1" />
            <span className={`h-5 rounded-sm bg-surface-sunken ${index % 2 === 0 ? 'w-16' : 'w-24'}`} />
          </div>
        ))}
        <p className="px-4 py-4 text-meta text-text-2">{t.t(label)}</p>
      </div>
      <ul aria-hidden="true" className="-mx-4 flex flex-col md:hidden">
        {Array.from({ length: 7 }, (_, index) => (
          <li key={index} data-testid="skeleton-row" className="flex items-start gap-3 border-b border-border bg-surface px-4 py-4">
            <span className="size-touch shrink-0 rounded-full bg-surface-sunken" />
            <span className="flex flex-1 flex-col gap-2.5 pt-1">
              <span className={`h-3 rounded-sm bg-surface-sunken ${BARS[index % BARS.length]}`} />
              <span className="h-3 w-56 rounded-sm bg-surface-sunken" />
              <span className={`h-3 rounded-sm bg-surface-sunken ${BARS[(index + 3) % BARS.length]}`} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A failed read, or a refused query: never drawn as "nothing here". */
export function ListError({
  t,
  heading,
  message,
  code,
  offline,
  onRetry,
}: {
  t: Translator;
  heading: MessageId;
  message: MessageId;
  code: string;
  offline: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid="list-error"
      data-error-code={code}
      className="flex flex-col items-start gap-2 rounded-lg border border-danger bg-danger-soft p-4 text-body-sm text-danger-text"
    >
      <p className="flex items-center gap-2 font-bold">
        <Icon name="error" size="sm" />
        {t.t(heading)}
      </p>
      <p>{t.t(message)}</p>
      <button type="button" data-requires-connection="" disabled={offline} onClick={onRetry} className={QUIET_BUTTON}>
        {t.t('records.retry')}
      </button>
    </div>
  );
}

/** "Load more" while `nextCursor` says there is more (D-P13: no page count, no total). */
export function LoadMore({
  t,
  loading,
  offline,
  onLoadMore,
}: {
  t: Translator;
  loading: boolean;
  offline: boolean;
  onLoadMore: () => void;
}) {
  return (
    <div className="flex justify-center">
      <button
        type="button"
        data-testid="load-more"
        data-requires-connection=""
        disabled={offline || loading}
        onClick={onLoadMore}
        className={SECONDARY_BUTTON}
      >
        {loading ? t.t('records.loadingMore') : t.t('records.loadMore')}
      </button>
    </div>
  );
}

/**
 * A number or an email address typed into a list's own search box (T-0124 I9,
 * R21): it is not sent, because the API refuses an identifier in `q`, and it
 * must not reach a URL. The box says where the number goes instead. Search
 * (`/search`) looks a whole number up in a POST body; the link is drawn only
 * where it is live (`live.includes('search')`), and carries nothing typed.
 */
export function NumberSearchHint({ t, searchLive }: { t: Translator; searchLive: boolean }) {
  return (
    <p role="status" data-testid="number-search-hint" className="flex flex-wrap items-center gap-x-2 text-body-sm text-text-2">
      <Icon name="info" size="sm" />
      <span>{t.t('records.search.numberHint')}</span>
      {searchLive ? (
        <Link href="/search" prefetch={false} className={`font-semibold text-primary-text underline ${FOCUS}`}>
          {t.t('records.search.useSearch')}
        </Link>
      ) : null}
    </p>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <span className="text-text-muted">{children}</span>;
}

/**
 * A withheld field: a lock and "Restricted". Never an empty cell — a lock tells
 * an agent the value exists and their role cannot see it, and "Not set" tells
 * them nobody filled it in.
 */
export function LockedValue({ t }: { t: Translator }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Icon name="lock" size="sm" />
      {t.t('records.locked')}
    </span>
  );
}

/** The drawn box beside a menu option (the option itself carries `aria-pressed`). */
export function CheckMark({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-5 w-5 items-center justify-center rounded-sm border ${on ? 'border-primary bg-primary text-on-primary' : 'border-border-strong'}`}
    >
      {on ? <Icon name="check" size="sm" /> : null}
    </span>
  );
}

export interface FilterOption {
  /** The wire value, exactly as the operation declares it. */
  readonly value: string;
  readonly label: string;
}

/** One filter's options, as toggles. `data-filter-option` is the wire value. */
export function FilterOptions({
  menu,
  label,
  options,
  selected,
  onToggle,
}: {
  menu: string;
  label: string;
  options: readonly FilterOption[];
  selected: readonly string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div data-filter-menu={menu} role="group" aria-label={label} className="flex flex-col">
      {options.map((option) => {
        const on = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            data-filter-option={option.value}
            aria-pressed={on}
            onClick={() => onToggle(option.value)}
            className={`${MENU_ROW} ${on ? 'font-semibold text-primary-text' : 'text-text'}`}
          >
            <CheckMark on={on} />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A header's lock: some row on screen withholds this column. */
export function HeaderLock({ t }: { t: Translator }) {
  return (
    <>
      <Icon name="lock" size="sm" />
      <span className="sr-only">{t.t('records.locked.header')}</span>
    </>
  );
}
