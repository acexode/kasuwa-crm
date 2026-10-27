'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { FOCUS } from '../records/list-classes';
import { nameOrWithheld } from '../records/name';
import { TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from '@kasuwa/ui/components';
import { appendPage } from '../records/list-model';
import {
  DEAL_SORTS,
  DEFAULT_DEAL_SORT,
  listDeals,
  withheld,
  type Deal,
  type DealFilters,
  type DealSort,
  type Pipeline,
  type PipelineError,
} from '../../lib/pipelines-api';
import { filterableFields, NO_CUSTOM_FILTERS, listRefusalId, setCustomFilter, type CustomFilters } from '../../lib/custom-values-filters';
import { LazyCustomFilterBar } from '../custom/lazy-filters';
import { useCustomDefinitions } from '../custom/use-custom-fields';
import { errorMessage, filtersKey, formatPercent, isAllowed, isDealSort, isUuid, sortLabel, stageById } from './pipeline-model';
import { AmountValue, CloseShort, InStageChip, Locked, Money, OwnerAvatar, lockedProps, stageTone } from './pipeline-parts';

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
  whatsapp = false,
  blockedId = null,
  pending,
  onMove,
  mayMove = true,
  onClearFilters,
}: {
  t: Translator;
  locale: string;
  pipeline: Pipeline;
  filters: DealFilters;
  /** Whether anything narrows the list: "no results" rather than "no deals yet". */
  filtered: boolean;
  online: boolean;
  /** Bumped after a create or a move: read again from the top. */
  nonce: number;
  /** Custom values are on in this process (read by the server page, T-0091): offer the custom filters. */
  customFields?: boolean;
  /** `whatsapp_recency` (D-L194): the WhatsApp column, an empty dash. */
  whatsapp?: boolean;
  /** The row P06/07's banner names: tinted danger. */
  blockedId?: string | null;
  /** Deals with a move in flight. */
  pending: ReadonlySet<string>;
  /** The stage pill: the board's move, through the same allow-list, prompt and moveDeal. */
  onMove: (deal: Deal, toStageId: string) => void;
  /** T-0158: false only when the API said the caller holds `deal.write` nowhere: the stage is shown, not changeable. */
  mayMove?: boolean;
  onClearFilters: () => void;
}) {
  const nowMs = useMemo(() => Date.now(), [nonce]);
  const definitions = useCustomDefinitions('deal', customFields);
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
      <div className="flex flex-wrap items-center justify-end gap-3">
        {filterableFields(definitions.fields).length > 0 ? (
        <LazyCustomFilterBar
          t={t}
          fields={definitions.fields}
          filters={customFilters}
          onChange={(key, value) => setCustomFilters((current) => setCustomFilter(current, key, value))}
        />
        ) : null}
        <label className="relative flex items-center gap-2 text-meta font-semibold text-text-2">
          {t.t('pipeline.sort.label')}
          <select
            data-testid="sort-control"
            value={sort}
            onChange={(event) => {
              if (isDealSort(event.target.value)) setSort(event.target.value);
            }}
            className="h-control-md cursor-pointer appearance-none rounded-md border border-border-strong bg-surface pe-8 ps-3 text-meta font-semibold text-text is-focus:field-focus"
          >
            {DEAL_SORTS.map((option) => (
              <option key={option} value={option}>
                {t.t(sortLabel(option))}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute end-2 flex text-text">
            <Icon name="expand_more" size={18} />
          </span>
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
          <p data-testid="list-no-results" className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-body-sm text-text-2">
            {t.t('pipeline.list.noResults')}{' '}
            <button type="button" onClick={onClearFilters} className="h-9 rounded-md px-2 font-bold text-primary-text is-hover:bg-primary-soft is-focus-visible:ring-focus">
              {t.t('records.filter.clearAll')}
            </button>
          </p>
        ) : (
          <div data-testid="list-empty" className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-6">
            <h2 className="text-h4 font-bold">{t.t('pipeline.board.empty.title')}</h2>
            <p className="text-body-sm text-text-2">{t.t('pipeline.board.empty.body')}</p>
          </div>
        )
      ) : (
        <div role="region" aria-label={t.t('pipeline.list.label')} tabIndex={0} className={`max-h-[620px] min-w-0 overflow-auto rounded-lg border border-border bg-surface ${FOCUS}`}>
          <table data-testid="deal-list" className="w-full min-w-[1170px] table-fixed border-separate border-spacing-0 text-start text-meta">
            <colgroup>
              <col className="w-[22%]" />
              <col className="w-[180px]" />
              <col className="w-[150px]" />
              <col className="w-[130px]" />
              <col className="w-[110px]" />
              <col className="w-16" />
              <col className="w-[130px]" />
              <col />
              {whatsapp ? <col className="w-24" /> : null}
            </colgroup>
            <TableHead>
              <TableRow>
                <Header column="name" label={t.t('pipeline.list.deal')} sort={sort === 'name' ? 'ascending' : 'none'} onSort={() => setSort(sort === 'name' ? DEFAULT_DEAL_SORT : 'name')} />
                <Header column="stage" label={t.t('pipeline.list.stage')} />
                <Header column="amount" label={t.t('pipeline.field.amount')} end />
                <Header column="weightedAmount" label={t.t('pipeline.list.weighted')} end />
                <Header column="expectedCloseDate" label={t.t('pipeline.list.close')} />
                <Header column="owner" label={t.t('pipeline.field.owner')} />
                <Header
                  column="inStage"
                  label={t.t('pipeline.list.inStage')}
                  sort={sort === 'stageEnteredAt' ? 'ascending' : 'none'}
                  onSort={() => setSort(sort === 'stageEnteredAt' ? DEFAULT_DEAL_SORT : 'stageEnteredAt')}
                />
                <Header column="nextStep" label={t.t('pipeline.field.nextStep')} />
                {whatsapp ? <Header column="whatsapp" label={t.t('pipeline.list.whatsapp')} /> : null}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((deal) => (
                <Row
                  key={deal.id}
                  t={t}
                  locale={locale}
                  pipeline={pipeline}
                  deal={deal}
                  online={online}
                  pending={pending.has(deal.id)}
                  blocked={blockedId === deal.id}
                  whatsapp={whatsapp}
                  nowMs={nowMs}
                  onMove={onMove}
                  mayMove={mayMove}
                />
              ))}
            </TableBody>
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

/** A column header (@kasuwa/ui's TableHeaderCell). Deal and In stage sort, by the contract's keys (R13); none else does. */
function Header({
  column,
  label,
  end = false,
  sort,
  onSort,
}: {
  column: string;
  label: string;
  end?: boolean;
  sort?: 'ascending' | 'none';
  onSort?: () => void;
}) {
  return (
    <TableHeaderCell role="columnheader" data-column={column} align={end ? 'end' : 'start'} sort={sort} onSort={onSort} className="h-11">
      {label}
    </TableHeaderCell>
  );
}

/** One P06/03 row: the board card's facts across nine columns. */
function Row({
  t,
  locale,
  pipeline,
  deal,
  online,
  pending,
  blocked,
  whatsapp,
  nowMs,
  onMove,
  mayMove,
}: {
  t: Translator;
  locale: string;
  pipeline: Pipeline;
  deal: Deal;
  online: boolean;
  pending: boolean;
  blocked: boolean;
  whatsapp: boolean;
  nowMs: number;
  onMove: (deal: Deal, toStageId: string) => void;
  mayMove: boolean;
}) {
  const stage = stageById(pipeline, deal.stageId);
  const tone = stageTone(stage);
  const gated = (stage?.requirements.length ?? 0) > 0;
  const account = deal.account ?? null;
  const contact = deal.contact ?? null;
  // Every stage in position order, lost last: the pill offers what the allow-list allows and shows the rest disabled.
  const stages = [...pipeline.stages].sort((a, b) => (a.kind === 'lost' ? 1 : 0) - (b.kind === 'lost' ? 1 : 0) || a.position - b.position);
  const next = deal.nextStep ?? null;
  // A 60px row (P06/03); the row P06/07's banner names is tinted danger; others take the sunken hover.
  const fill = `h-[60px] ${blocked ? '!bg-danger-soft' : 'group-hover/row:bg-surface-sunken'}`;
  return (
    <TableRow data-deal-row={deal.id} aria-busy={pending ? 'true' : undefined}>
      <TableCell data-field="name" className={`${fill} px-3 py-2`}>
        <span className="flex min-w-0 flex-col gap-px">
          {isUuid(deal.id) ? (
            <Link href={`/deals/${deal.id}`} prefetch={false} data-record-text="" className={`truncate rounded-sm text-body-sm font-bold text-primary-text hover:underline ${FOCUS}`}>
              {deal.name}
            </Link>
          ) : (
            <span data-record-text="" className="truncate text-body-sm font-bold text-primary-text">
              {deal.name}
            </span>
          )}
          {account === null && contact === null ? null : (
            <span data-record-text="" className="truncate text-caption font-normal text-text-2">
              {[account?.name, contact === null ? undefined : nameOrWithheld(t, contact.displayName)].filter((part) => part !== undefined).join(' · ')}
            </span>
          )}
        </span>
      </TableCell>
      <TableCell className={`${fill} !px-2`}>
        <label className="relative flex items-center">
          <span className="sr-only">{t.t('pipeline.list.stageFor', { deal: deal.name })}</span>
          {gated ? (
            <span aria-hidden="true" className={`pointer-events-none absolute start-2.25 flex ${tone.icon}`}>
              <Icon name="lock" size={14} />
            </span>
          ) : null}
          <select
            data-field="stage"
            data-requires-connection=""
            value={deal.stageId}
            disabled={!online || pending || !mayMove}
            onChange={(event) => onMove(deal, event.target.value)}
            className={`h-control-sm w-full cursor-pointer appearance-none truncate rounded-full border pe-7 text-meta font-bold disabled:cursor-not-allowed is-focus-visible:ring-focus ${gated ? 'ps-6.5' : 'ps-3'} ${tone.pill}`}
          >
            {stages.map((entry) => (
              // "Proposal · 50%" is copy with a name in it: only a bare stage name is record text (the en-XA check, T-0147).
              <option
                key={entry.id}
                value={entry.id}
                disabled={entry.id !== deal.stageId && !isAllowed(pipeline, deal.stageId, entry.id)}
                data-record-text={entry.kind === 'lost' ? '' : undefined}
              >
                {entry.kind === 'lost' ? entry.name : t.t('pipeline.list.stageOption', { stage: entry.name, percent: formatPercent(locale, entry.probabilityBp) })}
              </option>
            ))}
          </select>
          <span aria-hidden="true" className={`pointer-events-none absolute end-2 flex ${tone.icon}`}>
            <Icon name="expand_more" size={16} />
          </span>
        </label>
      </TableCell>
      <TableCell data-field="amount" {...lockedProps(deal, 'amount')} className={`${fill} px-3 text-end font-semibold`}>
        <AmountValue t={t} locale={locale} deal={deal} />
      </TableCell>
      <TableCell data-field="weightedAmount" {...lockedProps(deal, 'amount')} className={`${fill} px-3 text-end text-text-2`}>
        {withheld(deal, 'amount') ? (
          <Locked t={t} />
        ) : deal.weightedAmount === null || deal.weightedAmount === undefined ? null : (
          <Money t={t} locale={locale} money={deal.weightedAmount} kind="weighted" />
        )}
      </TableCell>
      <TableCell data-field="expectedCloseDate" {...lockedProps(deal, 'expectedCloseDate')} className={`${fill} px-3 font-semibold`}>
        <CloseShort t={t} locale={locale} deal={deal} nowMs={nowMs} withIcon={false} />
      </TableCell>
      <TableCell data-field="owner" {...lockedProps(deal, 'ownerUserId')} className={`${fill} px-3`}>
        <OwnerAvatar t={t} deal={deal} locale={locale} size="row" />
      </TableCell>
      <TableCell className={`${fill} px-3`}>
        <InStageChip t={t} deal={deal} nowMs={nowMs} />
      </TableCell>
      <TableCell data-field="nextStep" {...lockedProps(deal, 'nextStep')} className={`${fill} px-3 py-2`}>
        {withheld(deal, 'nextStep') ? (
          <Locked t={t} />
        ) : next !== null ? (
          <span className="flex items-start gap-1">
            <Icon name="flag" size={15} className="mt-px" />
            <span data-record-text="" className="min-w-0 break-words">
              {next}
            </span>
          </span>
        ) : deal.rotting === null ? null : (
          <span className="flex items-start gap-1 font-bold text-warning-text">
            <Icon name="warning" size={15} className="mt-px" />
            {t.t('pipeline.card.noNextStep')}
          </span>
        )}
      </TableCell>
      {whatsapp ? (
        <TableCell className={`${fill} px-3 text-caption text-text-muted`} title={t.t('pipeline.card.whatsappNone')}>
          <span className="inline-flex items-center gap-1">
            <Icon name="chat" size={16} />
            <span aria-hidden="true">{'—'}</span>
            <span className="sr-only">{t.t('pipeline.card.whatsappNone')}</span>
          </span>
        </TableCell>
      ) : null}
    </TableRow>
  );
}
