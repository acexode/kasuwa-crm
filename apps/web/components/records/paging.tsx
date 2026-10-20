'use client';

import { useEffect, useState } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { FOCUS } from './list-classes';
import type { KeysetList } from './use-keyset-list';

/**
 * P04's pagination footer on a keyset list (T-0133, D-P13, D-L195): the
 * design's bar — "Showing 1–25", rows per page 25 / 50 / 100, previous and
 * next — with no total and no page count, because the contract has neither.
 *
 * Pages are windows over the rows held. "Next" shows the next window when it
 * is held, and otherwise asks for one more keyset page (the read's `limit` IS
 * the page size, so one page is one window). "Previous" never reads: the rows
 * are still here (in memory, D-L64). A new search, filter or page size starts
 * again at the first window.
 */

export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export interface Paging<Row> {
  readonly rows: readonly Row[];
  readonly start: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  /** The next window is already held: it needs no connection. */
  readonly hasNextHeld: boolean;
  readonly loading: boolean;
  readonly previous: () => void;
  readonly next: () => void;
}

export function usePaging<Row, View>(list: KeysetList<Row, View>, size: number): Paging<Row> {
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState(false);
  const { q, view } = list.answered;

  useEffect(() => {
    setPage(0);
    setPending(false);
  }, [q, view, size]);

  const start = page * size;
  const held = list.rows.length;

  // A requested page arrived: move onto it. An empty last page leaves us here.
  useEffect(() => {
    if (!pending || list.loadingMore) return;
    setPending(false);
    if (held > start + size) setPage((current) => current + 1);
  }, [pending, list.loadingMore, held, start, size]);

  return {
    rows: list.rows.slice(start, start + size),
    start,
    hasPrevious: page > 0,
    hasNext: held > start + size || list.nextCursor !== null,
    hasNextHeld: held > start + size,
    loading: pending,
    previous: () => setPage((current) => Math.max(0, current - 1)),
    next: () => {
      if (held > start + size) {
        setPage((current) => current + 1);
        return;
      }
      if (list.nextCursor === null) return;
      setPending(true);
      list.loadMore();
    },
  };
}

/** The footer: 56px, 13px text-2, under the table inside the same card. */
export function PagingFooter({
  t,
  locale,
  paging,
  size,
  offline,
  onSize,
}: {
  t: Translator;
  locale: string;
  paging: Paging<unknown>;
  size: PageSize;
  offline: boolean;
  onSize: (size: PageSize) => void;
}) {
  const format = new Intl.NumberFormat(locale);
  const first = paging.rows.length === 0 ? 0 : paging.start + 1;
  const last = paging.start + paging.rows.length;
  return (
    <div
      data-testid="paging-footer"
      className="flex min-h-14 flex-wrap items-center gap-3 rounded-b-lg border border-t-0 border-border bg-surface py-2 pe-2 ps-4 text-meta text-text-2"
    >
      <span>
        {t.t('records.paging.showing')}{' '}
        <b className="font-mono font-semibold text-text">{`${format.format(first)}–${format.format(last)}`}</b>
      </span>
      <span className="flex-1" />
      <span className="hidden sm:inline">{t.t('records.paging.rowsPerPage')}</span>
      <div role="group" aria-label={t.t('records.paging.rowsPerPage')} className="hidden gap-0.5 rounded-md bg-surface-sunken p-0.75 sm:flex">
        {PAGE_SIZES.map((option) => (
          <button
            key={option}
            type="button"
            data-page-size={option}
            aria-pressed={size === option}
            disabled={offline}
            onClick={() => onSize(option)}
            className={`h-7 min-w-10 rounded-6 px-2 font-mono text-caption font-semibold ${FOCUS} ${
              size === option ? 'bg-surface text-text shadow-1' : 'text-text-2 hover:text-text'
            }`}
          >
            {format.format(option)}
          </button>
        ))}
      </div>
      <span aria-hidden="true" className="hidden h-6 w-px bg-border sm:block" />
      <button
        type="button"
        data-testid="prev-page"
        aria-label={t.t('records.paging.previous')}
        disabled={!paging.hasPrevious}
        onClick={paging.previous}
        className={`flex size-10 items-center justify-center rounded-md border border-border-strong bg-surface text-text disabled:cursor-not-allowed disabled:border-border disabled:text-disabled-text ${FOCUS}`}
      >
        <Icon name="chevron_left" size={20} className="rtl:-scale-x-100" />
      </button>
      <button
        type="button"
        data-testid="next-page"
        data-requires-connection=""
        aria-label={t.t('records.paging.next')}
        aria-busy={paging.loading || undefined}
        disabled={!paging.hasNext || paging.loading || (offline && !paging.hasNextHeld)}
        onClick={paging.next}
        className={`flex size-10 items-center justify-center rounded-md border border-border-strong bg-surface text-text disabled:cursor-not-allowed disabled:border-border disabled:text-disabled-text ${FOCUS}`}
      >
        <Icon name="chevron_right" size={20} className="rtl:-scale-x-100" />
      </button>
    </div>
  );
}
