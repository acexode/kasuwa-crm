'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { FIELD, QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { FOCUS } from '../records/list-classes';
import { appendPage } from '../records/list-model';
import {
  DEAL_SORTS,
  DEFAULT_DEAL_SORT,
  listDeals,
  type Deal,
  type DealFilters,
  type DealSort,
  type Pipeline,
  type PipelineError,
} from '../../lib/pipelines-api';
import { filterableFields, NO_CUSTOM_FILTERS, listRefusalId, setCustomFilter, type CustomFilters } from '../../lib/custom-values-filters';
import { LazyCustomFilterBar } from '../custom/lazy-filters';
import { useCustomFields } from '../custom/use-custom-fields';
import { errorMessage, filtersKey, isDealSort, sortLabel, stageById } from './pipeline-model';
import { AmountValue, CloseValue, OwnerValue, lockedProps } from './pipeline-parts';

/**
 * `P06/01b` — the list view (T-0109, R13): listDeals in served order, every
 * stage, lost included (named by its stage), with the board's filters.
 *
 * NO COUNT AND NO TOTALS. Keyset "more" on `nextCursor`, echoed with the same
 * filters and sort, never in the URL (D-P13). No footer totals either: the
 * list holds lost deals the board's totals never cover, so totals copied from
 * the board would mislabel them.
 *
 * SORT ONLY BY THE CONTRACT'S KEYS. Amount, close date, owner and stage do not
 * sort: ordering by a value field security can withhold leaks it one
 * comparison at a time. A new sort starts again from the top.
 *
 * Desktop only, as the design draws it; at 360 px the board is the swipe list.
 */

type Phase = 'loading' | 'loaded' | 'error';

export function DealList({
  t,
  locale,
  pipeline,
  filters: boardFilters,
  filtered,
  online,
  nonce,
  customFields = false,
}: {
  t: Translator;
  locale: string;
  pipeline: Pipeline;
  filters: DealFilters;
  /** Whether anything narrows the list: "no results" rather than "no deals yet". */
  filtered: boolean;
  online: boolean;
  /** Bumped after a create: read again from the top. */
  nonce: number;
  /** Custom values are on in this process (read by the server page, T-0091): offer the custom filters. */
  customFields?: boolean;
}) {
  const definitions = useCustomFields('deal', customFields);
  const [customFilters, setCustomFilters] = useState<CustomFilters>(NO_CUSTOM_FILTERS);
  // The list read carries the custom filters; the board's read never does (C6).
  const filters = useMemo(() => ({ ...boardFilters, custom: customFilters }), [boardFilters, customFilters]);
  const [sort, setSort] = useState<DealSort>(DEFAULT_DEAL_SORT);
  const [rows, setRows] = useState<readonly Deal[]>([]);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<PipelineError | null>(null);
  const [page, setPage] = useState<{ readonly filters: DealFilters; readonly sort: DealSort; readonly cursor: string | null }>({
    filters,
    sort,
    cursor: null,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<PipelineError | null>(null);
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  const key = filtersKey(filters);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  useEffect(() => {
    sequence.current += 1;
    const mine = sequence.current;
    const asked = filtersRef.current;
    setPhase('loading');
    setMoreError(null);
    void listDeals(pipeline.id, asked, sort).then((result) => {
      if (mine !== sequence.current) return;
      if (result.ok) {
        setRows(result.value.data);
        setPage({ filters: asked, sort, cursor: result.value.nextCursor });
        setError(null);
        setPhase('loaded');
        return;
      }
      setError(result.error);
      setPhase('error');
    });
  }, [pipeline.id, key, sort, nonce, retry]);

  const loadMore = useCallback(() => {
    if (page.cursor === null || loadingMore) return;
    const mine = sequence.current;
    setLoadingMore(true);
    setMoreError(null);
    // The cursor travels with the query that produced it (the contract's DealCursor).
    void listDeals(pipeline.id, page.filters, page.sort, page.cursor).then((result) => {
      if (mine !== sequence.current) return;
      setLoadingMore(false);
      if (result.ok) {
        setRows((current) => appendPage(current, result.value.data));
        setPage((current) => ({ ...current, cursor: result.value.nextCursor }));
        return;
      }
      setMoreError(result.error);
    });
  }, [loadingMore, page, pipeline.id]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end justify-end gap-3">
        {filterableFields(definitions.fields).length > 0 ? (
        <LazyCustomFilterBar
          t={t}
          fields={definitions.fields}
          filters={customFilters}
          onChange={(key, value) => setCustomFilters((current) => setCustomFilter(current, key, value))}
        />
        ) : null}
        <label className="flex flex-col gap-1 text-body-sm font-semibold">
          {t.t('pipeline.sort.label')}
          <select
            data-testid="sort-control"
            value={sort}
            onChange={(event) => {
              if (isDealSort(event.target.value)) setSort(event.target.value);
            }}
            className={`${FIELD} font-normal`}
          >
            {DEAL_SORTS.map((option) => (
              <option key={option} value={option}>
                {t.t(sortLabel(option))}
              </option>
            ))}
          </select>
        </label>
      </div>

      {phase === 'loading' ? (
        <div aria-busy="true" className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
          <span role="status" className="sr-only">
            {t.t('pipeline.list.loading')}
          </span>
          {[0, 1, 2, 3, 4].map((index) => (
            <span key={index} aria-hidden="true" className="h-8 rounded-sm bg-surface-sunken" />
          ))}
        </div>
      ) : phase === 'error' ? (
        <div
          role="alert"
          data-testid="list-error"
          className="flex flex-col items-start gap-2 rounded-lg border border-danger bg-danger-soft p-4 text-body-sm text-danger-text"
        >
          <p className="flex items-center gap-2 font-bold">
            <Icon name="error" size="sm" />
            {t.t('pipeline.list.error')}
          </p>
          <p>{t.t(listRefusalId(error) ?? errorMessage(error ?? { status: 0, code: 'network', details: [] }, 'read'))}</p>
          <button type="button" data-requires-connection="" disabled={!online} onClick={() => setRetry((current) => current + 1)} className={QUIET_BUTTON}>
            {t.t('records.retry')}
          </button>
        </div>
      ) : rows.length === 0 ? (
        filtered || Object.keys(customFilters).length > 0 ? (
          <p data-testid="list-no-results" className="rounded-lg border border-border bg-surface p-6 text-body-sm text-text-2">
            {t.t('pipeline.list.noResults')}
          </p>
        ) : (
          <div data-testid="list-empty" className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-6">
            <h2 className="text-h4 font-bold">{t.t('pipeline.board.empty.title')}</h2>
            <p className="text-body-sm text-text-2">{t.t('pipeline.board.empty.body')}</p>
          </div>
        )
      ) : (
        <div role="region" aria-label={t.t('pipeline.list.label')} tabIndex={0} className={`min-w-0 overflow-x-auto rounded-lg border border-border bg-surface ${FOCUS}`}>
          <table data-testid="deal-list" className="w-full text-start text-body-sm">
            <thead className="bg-surface-sunken text-caption text-text-2">
              <tr>
                <Header column="name" label={t.t('pipeline.list.deal')} />
                <Header column="stage" label={t.t('pipeline.list.stage')} />
                <Header column="amount" label={t.t('pipeline.field.amount')} />
                <Header column="expectedCloseDate" label={t.t('pipeline.field.expectedCloseDate')} />
                <Header column="owner" label={t.t('pipeline.field.owner')} />
              </tr>
            </thead>
            <tbody>
              {rows.map((deal) => (
                <tr key={deal.id} data-deal-row={deal.id} className="border-t border-border align-top">
                  <td data-field="name" className="px-3 py-2 font-semibold">
                    <span data-record-text="">{deal.name}</span>
                  </td>
                  <td data-field="stage" className="px-3 py-2">
                    <span data-record-text="">{stageById(pipeline, deal.stageId)?.name ?? ''}</span>
                  </td>
                  <td data-field="amount" {...lockedProps(deal, 'amount')} className="px-3 py-2">
                    <AmountValue t={t} locale={locale} deal={deal} />
                  </td>
                  <td data-field="expectedCloseDate" {...lockedProps(deal, 'expectedCloseDate')} className="px-3 py-2">
                    <CloseValue t={t} locale={locale} deal={deal} />
                  </td>
                  <td data-field="owner" {...lockedProps(deal, 'ownerUserId')} className="px-3 py-2">
                    <OwnerValue t={t} deal={deal} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {moreError === null ? null : (
        <p role="alert" className="text-body-sm text-danger-text">
          {t.t(errorMessage(moreError, 'read'))}
        </p>
      )}
      {phase === 'loaded' && page.cursor !== null ? (
        <div className="flex justify-center">
          <button
            type="button"
            data-testid="deal-list-more"
            data-requires-connection=""
            disabled={!online || loadingMore}
            onClick={loadMore}
            className={`${SECONDARY_BUTTON} disabled:cursor-not-allowed disabled:opacity-60`}
          >
            {t.t(loadingMore ? 'records.loadingMore' : 'records.loadMore')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A column header. None sorts here: the sort control offers the contract's keys (R13). */
function Header({ column, label }: { column: string; label: string }) {
  return (
    <th role="columnheader" scope="col" data-column={column} className="px-3 py-2 text-start font-bold">
      {label}
    </th>
  );
}
