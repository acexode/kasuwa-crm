'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { createBundleTranslator, type MessageBundle, type Translator } from '@kasuwa/i18n/bundle';
import { Banner, Button, EmptyState, SegmentedControl, Switch, initials } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { FIELD, QUIET_BUTTON } from '../auth/button-classes';
import { StillConnecting } from '../admin/panel';
import { useOnline } from '../script-builder/use-online';
import {
  DEAL_CURRENCIES,
  getDeal,
  moveDeal,
  type Deal,
  type MoveDealBody,
  type Pipeline,
  type PipelineError,
} from '../../lib/pipelines-api';
import { NO_MODULES, type DealModules } from './deal-modules';
import {
  CLOSE_PRESETS,
  EMPTY_INPUT,
  NO_FILTERS,
  OWNER_FILTERS,
  WON_WINDOWS,
  boardSummary,
  closeRangeFor,
  closedSinceFor,
  errorMessage,
  filtersActive,
  formatCount,
  formatShortDate,
  isAllowed,
  isClosePreset,
  rebaseViews,
  requirementViews,
  stageById,
  toDealFilters,
  type BoardSummary,
  type ClosePreset,
  type CurrencySum,
  type FilterState,
  type OwnerFilter,
  type PromptState,
} from './pipeline-model';
import { moveRefusalText } from './move-refusal';
import { PipelineBoard, type RecordLinks } from './pipeline-board';
import { Money, OfflineBanner } from './pipeline-parts';
import { PipelineSelect, usePipelineChoices } from './pipeline-select';
import { DealsBarActions } from './bar-actions';
import { usePipelineBoard } from './use-pipeline-board';

/**
 * `P06/01` — the pipeline board — and `P06/03` — the list view — behind the
 * pipeline flag, which only the server page reads (T-0109, rebuilt to the
 * export in T-0135). In the CRM shell.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT STILL DECIDES THE FIGURES (R4–R18). Column counts and totals
 * are the server's, per currency, never converted. The design's short forms
 * ("₦40M") label a column; the exact figure is on every card. The summary line
 * (`pipeline_summary`) adds the served figures per currency and nothing else.
 * Elements with no backend are drawn in the design's empty or disabled state
 * behind their own flags (D-L194): the US$ switch (`fx_display`) and the last
 * WhatsApp contact (`whatsapp_recency`). The design's amount-band and
 * territory filters have no contract, so their places hold the currency and
 * won-window filters, which do (D-L195).
 *
 * A MOVE IS ONE moveDeal, by drag, by the move sheet, or by the list's stage
 * pill: `version` and `toStageId`, plus the target stage's requirements the
 * person filled in the prompt, in the same call. A target off the allow-list
 * the screen read is said and never sent. Refusals are translated messages and
 * are never retried; a `409 stale_write` re-reads and rebases an open prompt,
 * keeping what was typed (D-L102). Nothing is optimistic: a card moves when
 * the server has answered, and every write is followed by a re-read.
 *
 * Write controls show to every caller; the API's 403 is the gate (D-L84).
 * Offline, every write and drag is off and nothing queues (D-P21). Nothing is
 * stored on the device (D-L64).
 *
 * The list view and the dialogs load when first opened: the board is what a
 * person on 256 kbps waits for, and it is all the first paint carries.
 * ---------------------------------------------------------------------------
 */

const DealList = dynamic(() => import('./deal-list').then((module) => module.DealList), { ssr: false, loading: Loading });
const MoveSheet = dynamic(() => import('./move-sheet').then((module) => module.MoveSheet), { ssr: false });
const RequirementPrompt = dynamic(() => import('./requirement-prompt').then((module) => module.RequirementPrompt), { ssr: false });
const DealCreate = dynamic(() => import('./deal-create').then((module) => module.DealCreate), { ssr: false });
const FilterSheet = dynamic(() => import('./filter-sheet').then((module) => module.FilterSheet), { ssr: false });

function Loading() {
  return <div aria-busy="true" className="h-64 rounded-lg bg-surface-sunken" />;
}

const SEARCH_DEBOUNCE_MS = 300;

type View = 'board' | 'list';

/** A refusal on the screen. With a deal and a target, it is P06/07's "Can't move" banner, and the card is outlined. */
interface Blocked {
  readonly text: string;
  readonly dealId?: string;
  readonly dealName?: string;
  readonly stageName?: string;
}

/** An owner offered in the avatar row: someone who owns a deal this board has served. */
interface OwnerChoice {
  readonly id: string;
  readonly name: string;
}


export function PipelineScreen({
  pipelineId,
  locale,
  messages,
  locales,
  live,
  links,
  customFields = false,
  modules = NO_MODULES,
}: {
  pipelineId: string;
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  live: readonly string[];
  /** Whether `/contacts/[id]` and `/accounts/[id]` answer in this process: a summary links only then. */
  links: RecordLinks;
  /** Custom values are on in this process (read by the server page, T-0091): the list view offers the custom filters. */
  customFields?: boolean;
  /** The D-L194 placeholders this process draws (read by the server page). */
  modules?: DealModules;
}) {
  const t = createBundleTranslator(locale, messages);
  const online = useOnline();
  const choices = usePipelineChoices();
  const [view, setView] = useState<View>('board');
  const [filterState, setFilterState] = useState<FilterState>(NO_FILTERS);
  const [debouncedQ, setDebouncedQ] = useState('');
  const [withheldSeen, setWithheldSeen] = useState<readonly string[]>([]);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [sheet, setSheet] = useState<Deal | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [creating, setCreating] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [listNonce, setListNonce] = useState(0);
  const [refocus, setRefocus] = useState<string | null>(null);
  const [activeColumn, setActiveColumn] = useState(0);
  const [owners, setOwners] = useState<readonly OwnerChoice[]>([]);
  const searchId = useId();
  // The prompt as it stands now, for an answer that arrives after an await: a
  // refusal for a prompt that has been closed meanwhile goes to the screen.
  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(filterState.q), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [filterState.q]);

  const filters = useMemo(
    () => toDealFilters({ ...filterState, q: debouncedQ }, withheldSeen),
    [filterState, debouncedQ, withheldSeen],
  );
  const model = usePipelineBoard(pipelineId, filters, view === 'board');
  const { pipeline, columns, withheldFields, reload, place, refreshPipeline } = model;

  // A filter on a field the board said is withheld is `400 field_withheld`:
  // once the board names one, its filter is gone for the rest of the visit.
  useEffect(() => {
    if (withheldFields.some((field) => !withheldSeen.includes(field))) {
      setWithheldSeen((current) => [...new Set([...current, ...withheldFields])]);
    }
  }, [withheldFields, withheldSeen]);

  // The avatar row: everyone who owns a card this board has served, kept for
  // the visit so a filter that narrows the board does not remove its own chip.
  useEffect(() => {
    const found = new Map<string, string>();
    for (const column of columns) {
      for (const card of column.cards) {
        if (card.owner !== null && card.owner !== undefined && card.owner.displayName !== null) found.set(card.owner.id, card.owner.displayName);
      }
    }
    setOwners((current) => {
      const next = new Map(current.map((owner) => [owner.id, owner.name] as const));
      let changed = false;
      for (const [id, name] of found) {
        if (next.get(id) !== name) {
          next.set(id, name);
          changed = true;
        }
      }
      if (!changed) return current;
      return [...next.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, locale));
    });
  }, [columns, locale]);

  // The freshest copy of every card, for a drop: a drag that started before a
  // re-read arrived must still send the version the server last served.
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const findDeal = useCallback((id: string): Deal | undefined => {
    for (const column of columnsRef.current) {
      const found = column.cards.find((card) => card.id === id);
      if (found !== undefined) return found;
    }
    return undefined;
  }, []);

  // After a move by the sheet, focus follows the card to its new column, so a
  // keyboard user is not dropped at the top of the page.
  useEffect(() => {
    if (refocus === null) return;
    const controls = document.querySelectorAll<HTMLElement>(`[data-deal-card="${CSS.escape(refocus)}"] [data-action="move-deal"]`);
    Array.from(controls).find((control) => control.offsetParent !== null)?.focus();
    setRefocus(null);
  }, [refocus, columns]);

  const setBusy = useCallback((id: string, busy: boolean) => {
    setPending((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  /** A refusal as the person reads it: translated, naming fields and requirements by label, never an id. */
  const refusalText = useCallback(
    (error: PipelineError, config: Pipeline | null): Promise<string> => moveRefusalText(t, error, config, refreshPipeline),
    [refreshPipeline, t],
  );

  /** P06/07: the banner names the deal and the stage it could not reach. */
  const blockedFor = useCallback(
    (deal: Deal, toStageId: string, text: string): Blocked => ({
      text,
      dealId: deal.id,
      dealName: deal.name,
      stageName: stageById(pipeline, toStageId)?.name ?? '',
    }),
    [pipeline],
  );

  /** One moveDeal. Never retried: a refusal is said, and the board is re-read where it matters. */
  const send = useCallback(
    async (deal: Deal, body: MoveDealBody, fromPrompt: boolean, byControl: boolean) => {
      setBusy(deal.id, true);
      const result = await moveDeal(deal.id, body);
      if (result.ok) {
        setBusy(deal.id, false);
        setPrompt(null);
        place(result.value);
        reload();
        setListNonce((current) => current + 1);
        setAnnouncement(t.t('pipeline.move.moved', { stage: stageById(pipeline, result.value.stageId)?.name ?? '' }));
        if (byControl) setRefocus(deal.id);
        return;
      }
      const { error } = result;
      if (error.code === 'stale_write') {
        if (fromPrompt) {
          // D-L102: re-read, keep what was typed, note what somebody else changed, and let the person confirm again.
          const fresh = await getDeal(deal.id);
          setBusy(deal.id, false);
          reload();
          if (promptRef.current === null) {
            setBlocked({ text: t.t('records.error.stale_write') });
            return;
          }
          setPrompt((current) => {
            if (current === null) return current;
            const stage = stageById(pipeline, current.toStageId);
            if (!fresh.ok || stage === undefined) return { ...current, sending: false, refusal: t.t(errorMessage(fresh.ok ? error : fresh.error)) };
            const { views, conflicts } = rebaseViews(current.views, current.deal, fresh.value, stage, withheldFields, current.input);
            return { ...current, deal: fresh.value, views, conflicts, sending: false, refusal: t.t('pipeline.prompt.stale') };
          });
          return;
        }
        setBlocked({ text: t.t('records.error.stale_write') });
        reload();
        setBusy(deal.id, false);
        return;
      }
      const text = await refusalText(error, pipeline);
      setBusy(deal.id, false);
      if (fromPrompt && promptRef.current !== null) {
        setPrompt((current) => (current === null ? current : { ...current, sending: false, refusal: text }));
      } else {
        setBlocked(blockedFor(deal, body.toStageId, text));
      }
    },
    [blockedFor, pipeline, place, refusalText, reload, setBusy, t, withheldFields],
  );

  /**
   * A drop, a sheet choice or a list pill. Off the allow-list: said, never
   * sent (R9). A target whose requirements the deal does not meet: the
   * prompt. Otherwise the move goes as `{ version, toStageId }`.
   */
  const requestMove = useCallback(
    (deal: Deal, toStageId: string, byControl: boolean) => {
      if (!navigator.onLine || pipeline === null || toStageId === deal.stageId || pending.has(deal.id)) return;
      setBlocked(null);
      setAnnouncement('');
      if (!isAllowed(pipeline, deal.stageId, toStageId)) {
        setBlocked(blockedFor(deal, toStageId, t.t('pipeline.move.notAllowed')));
        return;
      }
      const stage = stageById(pipeline, toStageId);
      if (stage === undefined) return;
      const views = requirementViews(stage, deal, withheldFields);
      if (views.some((entry) => !entry.met)) {
        setPrompt({ deal, toStageId, views, input: EMPTY_INPUT, conflicts: [], refusal: null, sending: false });
        return;
      }
      void send(deal, { version: deal.version, toStageId }, false, byControl);
    },
    [blockedFor, pending, pipeline, send, t, withheldFields],
  );

  const onDrop = useCallback(
    (dealId: string, toStageId: string) => {
      const deal = findDeal(dealId);
      if (deal !== undefined) requestMove(deal, toStageId, false);
    },
    [findDeal, requestMove],
  );

  const confirmPrompt = useCallback(
    (body: MoveDealBody) => {
      if (prompt === null || prompt.sending) return;
      setPrompt({ ...prompt, sending: true, refusal: null });
      void send(prompt.deal, body, true, false);
    },
    [prompt, send],
  );

  const onCreated = useCallback(() => {
    setCreating(false);
    setAnnouncement(t.t('pipeline.created'));
    reload();
    setListNonce((current) => current + 1);
  }, [reload, t]);

  const setFilter = (change: Partial<FilterState>) => setFilterState((current) => ({ ...current, ...change }));
  const active = filtersActive(filterState);
  const empty = model.phase === 'ready' && !filtersActive({ ...filterState, q: debouncedQ }) && columns.every((column) => column.count === 0);
  const known = model.phase === 'ready' || withheldSeen.length > 0;
  const hiddenFields = [...new Set([...withheldSeen, ...withheldFields])];
  const dialogOpen = sheet !== null || prompt !== null || creating || filtering;
  const ready = model.phase === 'ready';
  const shown = columns.reduce((sum, column) => sum + column.count, 0);
  const summary = pipeline === null || !ready ? null : boardSummary(pipeline, columns);

  const scrollToColumn = (index: number) => {
    const column = columns[index];
    if (column === undefined) return;
    setActiveColumn(index);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document
      .querySelector(`[data-stage-column="${CSS.escape(column.stageId)}"]`)
      ?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest', inline: 'start' });
  };

  const newDeal = () => setCreating(true);

  return (
    <CrmShell
      t={t}
      locale={locale}
      locales={locales}
      current="deals"
      live={live}
      appBar={{ title: t.t('records.nav.deals'), actions: <DealsBarActions t={t} live={live} onNew={newDeal} newDisabled={!online || !ready} /> }}
    >
      <div data-screen="P06/01" data-view={view} className="flex min-w-0 flex-col gap-3 md:gap-4">
        {/* Behind an open dialog the screen is inert: focus cannot reach another card and open a second one. */}
        <div inert={dialogOpen} className="flex min-w-0 flex-col gap-3 md:gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2.5">
            {/* The heading names the pipeline for a screen reader; the design draws "Deals" and the dropdown. */}
            <h1 className="sr-only text-title md:not-sr-only">
              {t.t('records.nav.deals')}
              {pipeline === null ? null : (
                <span className="sr-only">
                  {' · '}
                  <span data-record-text="">{pipeline.name}</span>
                </span>
              )}
            </h1>
            <PipelineSelect
              t={t}
              state={choices}
              currentId={pipelineId}
              currentName={pipeline?.name ?? ''}
              className="flex-1 basis-0 md:max-w-[280px] md:flex-initial md:basis-[280px]"
            />
            <span className="hidden flex-1 md:block" />
            {ready ? (
              <SegmentedControl
                aria-label={t.t('pipeline.view.label')}
                value={view}
                onValueChange={(value) => setView(value === 'list' ? 'list' : 'board')}
                className="hidden md:inline-flex"
                options={[
                  { value: 'board', label: t.t('pipeline.view.board'), icon: 'view_kanban', attributes: { 'data-view-option': 'board' } },
                  { value: 'list', label: t.t('pipeline.view.list'), icon: 'list', attributes: { 'data-view-option': 'list' } },
                ]}
              />
            ) : null}
            {modules.fxDisplay ? (
              <span
                data-action="show-usd"
                title={t.t('pipeline.usd.unavailable')}
                className="hidden h-control-base items-center rounded-md border border-border-strong bg-surface pe-3 ps-1 md:inline-flex"
              >
                <Switch label={<span className="text-meta font-semibold">{t.t('pipeline.usd.show')}</span>} disabled checked={false} />
              </span>
            ) : null}
            <Button
              variant="primary"
              icon="add"
              data-action="new-deal"
              data-requires-connection=""
              disabled={!online || !ready}
              onClick={newDeal}
              className="hidden px-4 md:inline-flex"
            >
              {t.t('pipeline.newDeal')}
            </Button>
          </div>

          {modules.summary && summary !== null ? <SummaryLine t={t} locale={locale} summary={summary} closedSince={model.closedSince} /> : null}

          {ready || model.phase === 'loading' ? (
            <>
              {/* Desktop: P06/01's filter card. */}
              <div
                role="search"
                aria-label={t.t('records.filter.label')}
                className="hidden min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-surface px-2.5 py-2 md:flex"
              >
                {known && !hiddenFields.includes('ownerUserId') && owners.length > 0 ? (
                  <>
                    <span className="ps-1 text-meta font-semibold text-text-2">{t.t('pipeline.filter.owner')}</span>
                    <OwnerRow t={t} locale={locale} owners={owners} picked={filterState.owners} onChange={(next) => setFilter({ owners: next })} />
                    <span aria-hidden="true" className="h-7 w-px bg-border" />
                  </>
                ) : null}
                {known ? <FilterControls t={t} state={filterState} withheldFields={hiddenFields} onChange={setFilter} /> : null}
                <label htmlFor={searchId} className="relative flex items-center">
                  <span className="sr-only">{t.t('pipeline.search.label')}</span>
                  <span className="pointer-events-none absolute start-2.5 flex text-text-2">
                    <Icon name="search" size={18} />
                  </span>
                  <input
                    id={searchId}
                    type="search"
                    data-filter="q"
                    value={filterState.q}
                    maxLength={100}
                    autoComplete="off"
                    placeholder={t.t('pipeline.search.label')}
                    onChange={(event) => setFilter({ q: event.target.value })}
                    className="h-control-md w-48 rounded-md border border-border-strong bg-surface pe-2 ps-9 text-meta font-semibold text-text placeholder:font-normal placeholder:text-text-muted is-focus:field-focus"
                  />
                </label>
                <span className="flex-1" />
                {ready ? (
                  <span className="text-meta text-text-muted">{t.t('pipeline.filter.shown', { count: shown })}</span>
                ) : null}
                {active ? (
                  <button
                    type="button"
                    onClick={() => setFilterState(NO_FILTERS)}
                    className="h-control-md rounded-md px-2.5 text-meta font-bold text-primary-text is-hover:bg-primary-soft is-focus-visible:ring-focus"
                  >
                    {t.t('records.filter.clearAll')}
                  </button>
                ) : null}
              </div>
              {/* Phone: P06/09's Filters button and the owner avatars, one sideways row. */}
              <div className="-mx-4 flex gap-2 overflow-x-auto px-4 md:hidden">
                <button
                  type="button"
                  data-action="open-filters"
                  aria-haspopup="dialog"
                  onClick={() => setFiltering(true)}
                  className={`inline-flex h-control-md shrink-0 items-center gap-1.5 rounded-full border px-3 text-meta font-semibold is-focus-visible:ring-focus ${
                    active ? 'border-primary bg-primary-soft text-primary-text' : 'border-border-strong bg-surface text-text'
                  }`}
                >
                  <Icon name="tune" size={18} />
                  {t.t('pipeline.filter.more')}
                </button>
                {known && !hiddenFields.includes('ownerUserId') ? (
                  <OwnerRow t={t} locale={locale} owners={owners} picked={filterState.owners} onChange={(next) => setFilter({ owners: next })} compact />
                ) : null}
              </div>
            </>
          ) : null}

          {online ? null : <OfflineBanner t={t} locale={locale} syncedAt={model.syncedAt} />}

          {blocked === null ? null : <BlockedBanner t={t} blocked={blocked} onDismiss={() => setBlocked(null)} />}
          {model.refreshFailed ? (
            <div data-testid="board-refresh-failed">
              <Banner tone="warning" action={online ? { label: t.t('records.retry'), onClick: model.reload } : undefined}>
                {t.t('pipeline.board.refreshFailed')}
              </Banner>
            </div>
          ) : null}
          <p role="status" className="sr-only">
            {announcement}
          </p>

          {ready && view === 'board' && !empty && pipeline !== null ? (
            <div role="group" aria-label={t.t('pipeline.stages.label')} className="-mx-4 flex gap-1.5 overflow-x-auto px-4 py-0.5 md:hidden">
              {columns.map((column, index) => {
                const selected = index === activeColumn;
                return (
                  <button
                    key={column.stageId}
                    type="button"
                    aria-pressed={selected}
                    data-stage-chip={column.stageId}
                    onClick={() => scrollToColumn(index)}
                    className={`inline-flex h-control-md shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-meta font-bold is-focus-visible:ring-focus ${
                      selected ? 'border-primary bg-primary text-on-primary' : 'border-border-strong bg-surface text-text'
                    }`}
                  >
                    <span data-record-text="">{stageById(pipeline, column.stageId)?.name ?? ''}</span>
                    <span className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-micro ${selected ? 'bg-primary-hover' : 'bg-surface-sunken'}`}>
                      {formatCount(locale, column.count)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {model.phase === 'loading' ? (
            <div data-testid="board-skeleton" aria-busy="true" className="flex flex-col gap-3">
              {model.slow ? <StillConnecting t={t} /> : null}
              <span role="status" className="sr-only">
                {t.t('pipeline.loading')}
              </span>
              <div aria-hidden="true" className="flex gap-3 overflow-hidden">
                {[0, 1, 2, 3, 4].map((index) => (
                  <span key={index} className="h-[420px] min-w-[228px] flex-1 shrink-0 rounded-lg border border-border bg-surface-sunken" />
                ))}
              </div>
            </div>
          ) : model.phase === 'not-found' ? (
            <div data-testid="record-not-found" className="flex flex-col items-start gap-2 rounded-lg border border-border bg-surface p-6">
              <span className="mb-1.5 flex size-12 items-center justify-center rounded-full bg-surface-sunken text-text-2">
                <Icon name="search_off" size={24} />
              </span>
              <h2 className="text-h4 font-bold">{t.t('pipeline.notFound.title')}</h2>
              <p className="text-body-sm text-text-2">{t.t('pipeline.notFound.body')}</p>
            </div>
          ) : model.phase === 'error' ? (
            <div
              role="alert"
              data-testid="board-error"
              className="flex flex-col items-start gap-2 rounded-10 border-2 border-danger bg-danger-soft px-3.5 py-3 text-body-sm text-danger-text"
            >
              <p className="flex items-center gap-2 font-bold">
                <Icon name="error" size={20} />
                {t.t('pipeline.board.error')}
              </p>
              <p>{t.t(errorMessage(model.error ?? { status: 0, code: 'network', details: [] }, 'read'))}</p>
              <button type="button" data-requires-connection="" disabled={!online} onClick={model.reload} className={QUIET_BUTTON}>
                {t.t('records.retry')}
              </button>
            </div>
          ) : pipeline === null ? null : view === 'list' ? (
            <DealList
              t={t}
              locale={locale}
              pipeline={pipeline}
              filters={filters}
              filtered={filtersActive({ ...filterState, q: debouncedQ })}
              online={online}
              nonce={listNonce}
              customFields={customFields}
              whatsapp={modules.whatsapp}
              blockedId={blocked?.dealId ?? null}
              pending={pending}
              onMove={(deal, toStageId) => requestMove(deal, toStageId, false)}
              onClearFilters={() => setFilterState(NO_FILTERS)}
            />
          ) : empty ? (
            <div data-testid="board-empty" className="max-w-[960px] rounded-xl border border-border bg-surface p-7">
              <EmptyState
                icon="view_kanban"
                title={t.t('pipeline.board.empty.title')}
                body={t.t('pipeline.board.empty.body')}
                action={
                  <Button variant="primary" icon="add" data-requires-connection="" disabled={!online} onClick={newDeal}>
                    {t.t('pipeline.newDeal')}
                  </Button>
                }
              />
            </div>
          ) : (
            <PipelineBoard
              t={t}
              locale={locale}
              pipeline={pipeline}
              columns={columns}
              closedSince={model.closedSince}
              withheldFields={withheldFields}
              online={online}
              pending={pending}
              links={links}
              whatsapp={modules.whatsapp}
              blockedId={blocked?.dealId ?? null}
              onLoadMore={model.loadMore}
              onDrop={onDrop}
              onMoveSheet={setSheet}
              onActiveColumn={setActiveColumn}
            />
          )}
        </div>

        {sheet !== null && pipeline !== null ? (
          <MoveSheet
            t={t}
            pipeline={pipeline}
            deal={sheet}
            online={online}
            onClose={() => setSheet(null)}
            onChoose={(toStageId) => {
              const deal = findDeal(sheet.id) ?? sheet;
              setSheet(null);
              requestMove(deal, toStageId, true);
            }}
          />
        ) : null}
        {prompt !== null && pipeline !== null ? (
          <RequirementPrompt
            t={t}
            pipeline={pipeline}
            prompt={prompt}
            online={online}
            onInput={(input) => setPrompt((current) => (current === null ? current : { ...current, input }))}
            onClose={() => setPrompt(null)}
            onConfirm={confirmPrompt}
          />
        ) : null}
        {creating && pipeline !== null ? (
          <DealCreate
            t={t}
            pipelineId={pipeline.id}
            withheldFields={withheldFields}
            online={online}
            onClose={() => setCreating(false)}
            onCreated={onCreated}
            onOrphanRefusal={(text) => setBlocked({ text })}
          />
        ) : null}
        {filtering ? (
          <FilterSheet t={t} active={active} onClear={() => setFilterState(NO_FILTERS)} onClose={() => setFiltering(false)}>
            <label className="flex min-w-0 flex-col gap-1.5 text-body-sm font-semibold">
              {t.t('pipeline.search.label')}
              <input
                type="search"
                data-filter="q"
                value={filterState.q}
                maxLength={100}
                autoComplete="off"
                placeholder={t.t('pipeline.search.placeholder')}
                onChange={(event) => setFilter({ q: event.target.value })}
                className={`${FIELD} font-normal`}
              />
            </label>
            <Filters t={t} state={filterState} withheldFields={hiddenFields} owners={owners} onChange={setFilter} />
          </FilterSheet>
        ) : null}
      </div>
    </CrmShell>
  );
}

/** One currency's figure, or each currency's, joined: never converted, never summed across currencies. */
function Sums({ t, locale, sums, weighted = false, tone = 'text-text' }: { t: Translator; locale: string; sums: readonly CurrencySum[]; weighted?: boolean; tone?: string }) {
  if (sums.length === 0) return <b className={`font-mono text-label ${tone}`}>{'—'}</b>;
  return (
    <>
      {sums.map((sum, index) => (
        <span key={sum.currency}>
          {index === 0 ? null : ' + '}
          <b className={`text-label ${tone}`}>
            <Money t={t} locale={locale} money={{ amountMinor: weighted ? sum.weightedAmountMinor : sum.amountMinor, currency: sum.currency }} shape="compact" />
          </b>
        </span>
      ))}
    </>
  );
}

/** P06/01's summary line: the served column figures, added per currency. */
function SummaryLine({ t, locale, summary, closedSince }: { t: Translator; locale: string; summary: BoardSummary; closedSince: string | null }) {
  return (
    <div data-testid="board-summary" className="flex flex-wrap items-baseline gap-x-5 gap-y-2 text-meta text-text-2">
      {summary.open === null ? null : (
        <>
          <span>
            {t.t('pipeline.summary.open')} <Sums t={t} locale={locale} sums={summary.open} />
          </span>
          <span>
            {t.t('pipeline.summary.weighted')} <Sums t={t} locale={locale} sums={summary.open} weighted />
          </span>
        </>
      )}
      {summary.won === null || closedSince === null ? null : (
        <span>
          {t.t('pipeline.summary.wonSince', { date: formatShortDate(locale, closedSince.slice(0, 10)) })}{' '}
          <Sums t={t} locale={locale} sums={summary.won} tone="text-success-text" />
        </span>
      )}
      <span>{t.t('pipeline.summary.openDeals', { count: summary.openCount })}</span>
    </div>
  );
}

/**
 * The owner avatars (P06/01): a toggle per person who owns a served card.
 * Picked is a solid primary chip with a ring; when any is picked, the others
 * fade. Several may be picked; the contract's `owner` takes each id.
 */
function OwnerRow({
  t,
  locale,
  owners,
  picked,
  onChange,
  compact = false,
}: {
  t: Translator;
  locale: string;
  owners: readonly OwnerChoice[];
  picked: readonly string[];
  onChange: (owners: readonly string[]) => void;
  compact?: boolean;
}) {
  const any = picked.length > 0;
  return (
    <div role="group" aria-label={t.t('pipeline.filter.owner')} data-filter-group="owner" className="flex shrink-0">
      {owners.map((owner) => {
        const on = picked.includes(owner.id);
        return (
          <button
            key={owner.id}
            type="button"
            aria-pressed={on}
            aria-label={owner.name}
            title={owner.name}
            data-owner-option={owner.id}
            onClick={() => onChange(on ? picked.filter((id) => id !== owner.id) : [...picked, owner.id])}
            className={`flex ${compact ? 'h-control-md' : 'h-control-base'} w-touch shrink-0 items-center justify-center rounded-full is-focus-visible:ring-focus`}
          >
            <span
              aria-hidden="true"
              className={`flex size-8 items-center justify-center rounded-full text-micro transition-opacity duration-quick ${
                on ? 'bg-primary text-on-primary ring-2 ring-primary ring-offset-2 ring-offset-surface' : 'bg-primary-soft-strong text-primary-text'
              } ${any && !on ? 'opacity-55' : ''}`}
            >
              {initials(owner.name, locale)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A P06/01 filter dropdown: a native select with a leading icon, 40px, 13/600; primary when narrowing. */
function FilterSelect({
  label,
  icon,
  active,
  children,
  ...rest
}: {
  label: string;
  icon: 'event' | 'payments' | 'event_available';
  active: boolean;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<'select'>, 'children'>) {
  return (
    <label className="relative flex items-center">
      <span className="sr-only">{label}</span>
      <span className="pointer-events-none absolute start-2.5 flex text-text-2">
        <Icon name={icon} size={18} />
      </span>
      <select
        className={`h-control-md cursor-pointer appearance-none rounded-md border pe-8 ps-9 text-meta font-semibold text-text is-focus:field-focus ${
          active ? 'border-primary bg-primary-soft' : 'border-border-strong bg-surface'
        }`}
        {...rest}
      >
        {children}
      </select>
      <span className="pointer-events-none absolute end-2 flex text-text">
        <Icon name="expand_more" size={18} />
      </span>
    </label>
  );
}

const CLOSE_PRESET_LABELS = {
  any: 'pipeline.filter.close.any',
  month: 'pipeline.filter.close.month',
  next60: 'pipeline.filter.close.next60',
  overdue: 'pipeline.filter.close.overdue',
  custom: 'pipeline.filter.close.custom',
} as const satisfies Record<ClosePreset, string>;

/**
 * The filter card's dropdowns: close date (presets, or two dates), currency
 * and the won window. The design's amount-band and territory filters have no
 * contract (R14), so these take their places (D-L195). A filter on a field the
 * board said is withheld is not offered at all.
 */
function FilterControls({
  t,
  state,
  withheldFields,
  onChange,
}: {
  t: Translator;
  state: FilterState;
  withheldFields: readonly string[];
  onChange: (change: Partial<FilterState>) => void;
}) {
  return (
    <>
      {withheldFields.includes('expectedCloseDate') ? null : (
        <>
          <FilterSelect
            label={t.t('pipeline.filter.close')}
            icon="event"
            active={state.closePreset !== 'any'}
            data-filter="close"
            value={state.closePreset}
            onChange={(event) => {
              const preset = isClosePreset(event.target.value) ? event.target.value : 'any';
              onChange({ closePreset: preset, ...(closeRangeFor(preset, Date.now()) ?? {}) });
            }}
          >
            {CLOSE_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {t.t(CLOSE_PRESET_LABELS[preset])}
              </option>
            ))}
          </FilterSelect>
          {state.closePreset === 'custom' ? <CloseDates t={t} state={state} onChange={onChange} /> : null}
        </>
      )}
      {withheldFields.includes('amount') ? null : (
        <FilterSelect
          label={t.t('pipeline.filter.currency')}
          icon="payments"
          active={state.currency !== ''}
          data-filter="currency"
          value={state.currency}
          onChange={(event) => onChange({ currency: event.target.value })}
        >
          <option value="">{t.t('pipeline.filter.currency.any')}</option>
          {DEAL_CURRENCIES.map((code) => (
            // ISO codes are served data, not copy: the same in every language.
            <option key={code} value={code} data-record-text="">
              {code}
            </option>
          ))}
        </FilterSelect>
      )}
      <FilterSelect
        label={t.t('pipeline.filter.won')}
        icon="event_available"
        active={state.closedSince !== null}
        data-filter="closedSince"
        value={String(state.wonDays)}
        onChange={(event) => {
          const days = WON_WINDOWS.find((choice) => String(choice) === event.target.value) ?? state.wonDays;
          onChange({ wonDays: days, closedSince: closedSinceFor(days, Date.now()) });
        }}
      >
        {WON_WINDOWS.map((days) => (
          <option key={days} value={String(days)}>
            {t.t('pipeline.filter.won.option', { days })}
          </option>
        ))}
      </FilterSelect>
    </>
  );
}

function CloseDates({ t, state, onChange }: { t: Translator; state: FilterState; onChange: (change: Partial<FilterState>) => void }) {
  const control = 'h-control-md rounded-md border border-border-strong bg-surface px-2 text-meta text-text is-focus:field-focus';
  return (
    <span className="flex items-center gap-2">
      <label className="flex items-center gap-1.5 text-meta font-semibold text-text-2">
        {t.t('pipeline.filter.closeFrom')}
        <input type="date" data-filter-input="closeFrom" value={state.closeFrom} onChange={(event) => onChange({ closeFrom: event.target.value })} className={control} />
      </label>
      <label className="flex items-center gap-1.5 text-meta font-semibold text-text-2">
        {t.t('pipeline.filter.closeTo')}
        <input
          type="date"
          data-filter-input="closeTo"
          value={state.closeTo}
          min={state.closeFrom === '' ? undefined : state.closeFrom}
          onChange={(event) => onChange({ closeTo: event.target.value })}
          className={control}
        />
      </label>
    </span>
  );
}

/**
 * The phone's Filters sheet body (P06/09's "Filters"): every filter as a
 * labelled native control, the owner choice with "Me" and "Unassigned"
 * included. A filter on a field the board said is withheld is not offered.
 */
function Filters({
  t,
  state,
  withheldFields,
  owners,
  onChange,
}: {
  t: Translator;
  state: FilterState;
  withheldFields: readonly string[];
  owners: readonly OwnerChoice[];
  onChange: (change: Partial<FilterState>) => void;
}) {
  const label = 'flex min-w-0 flex-col gap-1.5 text-body-sm font-semibold';
  const control = `${FIELD} font-normal`;
  return (
    <div role="group" aria-label={t.t('records.filter.label')} className="flex min-w-0 flex-col gap-4">
      {withheldFields.includes('ownerUserId') ? null : (
        <label className={label}>
          {t.t('pipeline.filter.owner')}
          <select
            data-filter="owner"
            value={state.owners.length === 1 ? (state.owners[0] ?? '') : state.owner}
            onChange={(event) => {
              const value = event.target.value;
              if ((OWNER_FILTERS as readonly string[]).includes(value)) onChange({ owner: value as OwnerFilter, owners: [] });
              else if (owners.some((owner) => owner.id === value)) onChange({ owner: '', owners: [value] });
              else onChange({ owner: '', owners: [] });
            }}
            className={control}
          >
            <option value="">{t.t('pipeline.filter.owner.any')}</option>
            <option value="me">{t.t('pipeline.filter.owner.me')}</option>
            <option value="unassigned">{t.t('pipeline.card.unassigned')}</option>
            {owners.map((owner) => (
              <option key={owner.id} value={owner.id} data-record-text="">
                {owner.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {withheldFields.includes('expectedCloseDate') ? null : (
        <>
          <label className={label}>
            {t.t('pipeline.filter.close')}
            <select
              data-filter="close"
              value={state.closePreset}
              onChange={(event) => {
                const preset = isClosePreset(event.target.value) ? event.target.value : 'any';
                onChange({ closePreset: preset, ...(closeRangeFor(preset, Date.now()) ?? {}) });
              }}
              className={control}
            >
              {CLOSE_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {t.t(CLOSE_PRESET_LABELS[preset])}
                </option>
              ))}
            </select>
          </label>
          {state.closePreset === 'custom' ? (
            <div className="grid grid-cols-2 gap-3">
              <label className={label}>
                {t.t('pipeline.filter.closeFrom')}
                <input type="date" data-filter-input="closeFrom" value={state.closeFrom} onChange={(event) => onChange({ closeFrom: event.target.value })} className={control} />
              </label>
              <label className={label}>
                {t.t('pipeline.filter.closeTo')}
                <input
                  type="date"
                  data-filter-input="closeTo"
                  value={state.closeTo}
                  min={state.closeFrom === '' ? undefined : state.closeFrom}
                  onChange={(event) => onChange({ closeTo: event.target.value })}
                  className={control}
                />
              </label>
            </div>
          ) : null}
        </>
      )}
      {withheldFields.includes('amount') ? null : (
        <label className={label}>
          {t.t('pipeline.filter.currency')}
          <select data-filter="currency" value={state.currency} onChange={(event) => onChange({ currency: event.target.value })} className={control}>
            <option value="">{t.t('pipeline.filter.currency.any')}</option>
            {DEAL_CURRENCIES.map((code) => (
              <option key={code} value={code} data-record-text="">
                {code}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className={label}>
        {t.t('pipeline.filter.won')}
        <select
          data-filter="closedSince"
          value={String(state.wonDays)}
          onChange={(event) => {
            const days = WON_WINDOWS.find((choice) => String(choice) === event.target.value) ?? state.wonDays;
            onChange({ wonDays: days, closedSince: closedSinceFor(days, Date.now()) });
          }}
          className={control}
        >
          {WON_WINDOWS.map((days) => (
            <option key={days} value={String(days)}>
              {t.t('pipeline.filter.won.days', { days })}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/**
 * P06/07 and P06/08: the refusal, across the board under the filters, 2px
 * danger. With a deal and a target it names both in bold, then why; the deal
 * stayed where it was. Dismissable.
 */
function BlockedBanner({ t, blocked, onDismiss }: { t: Translator; blocked: Blocked; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      data-testid="move-blocked"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-10 border-2 border-danger bg-danger-soft py-3 pe-2.5 ps-3.5 text-body-sm text-danger-text"
    >
      <Icon name="block" size={22} />
      <span className="min-w-0 flex-[1_1_240px]">
        {blocked.dealName === undefined ? null : (
          <>
            <b>{t.t('pipeline.blocked.title', { deal: blocked.dealName, stage: blocked.stageName ?? '' })}</b>{' '}
          </>
        )}
        {blocked.text}
      </span>
      <button
        type="button"
        aria-label={t.t('pipeline.blocked.dismiss')}
        onClick={onDismiss}
        className="flex size-10 items-center justify-center rounded-md text-danger-text is-hover:bg-surface is-focus-visible:ring-focus"
      >
        <Icon name="close" size={20} />
      </button>
    </div>
  );
}
