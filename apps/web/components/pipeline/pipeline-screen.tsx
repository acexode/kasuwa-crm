'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { FIELD, PRIMARY_BUTTON, QUIET_BUTTON } from '../auth/button-classes';
import { StillConnecting } from '../admin/panel';
import { FOCUS } from '../records/list-classes';
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
import {
  EMPTY_INPUT,
  NO_FILTERS,
  OWNER_FILTERS,
  WON_WINDOWS,
  closedSinceFor,
  errorMessage,
  fieldLabel,
  filtersActive,
  findRequirement,
  isAllowed,
  notEditableFields,
  rebaseViews,
  requirementViews,
  stageById,
  toDealFilters,
  unmetRequirementIds,
  type FilterState,
  type OwnerFilter,
  type PromptInput,
  type RequirementView,
} from './pipeline-model';
import { PipelineBoard, type RecordLinks } from './pipeline-board';
import { OfflineBanner } from './pipeline-parts';
import { usePipelineBoard } from './use-pipeline-board';

/**
 * `P06/01` — the pipeline board — and `P06/01b` — the list view — behind the
 * pipeline flag, which only the server page reads (T-0109). In the CRM shell.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT WINS WHERE THE DESIGN DISAGREES (R4–R18). Counts and totals
 * are the server's, exact, per currency, never summed and never compact. No
 * board-level summary, no US$ or FX, no territory or amount band, no AI risk,
 * products, quotes, approvals, attachments, WhatsApp contact or Undo.
 *
 * A MOVE IS ONE moveDeal, by drag or by the move sheet: `version` and
 * `toStageId`, plus the target stage's requirements the person filled in the
 * prompt, in the same call. A target off the allow-list the screen read is
 * said and never sent. Refusals are translated messages and are never
 * retried; a `409 stale_write` re-reads and rebases an open prompt, keeping
 * what was typed (D-L102). Nothing is optimistic: a card moves when the server
 * has answered, and every write is followed by a re-read of the board.
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

function Loading() {
  return <div aria-busy="true" className="h-64 rounded-lg bg-surface-sunken" />;
}

const SEARCH_DEBOUNCE_MS = 300;

type View = 'board' | 'list';

/** The requirement prompt, open on one move. */
export interface PromptState {
  readonly deal: Deal;
  readonly toStageId: string;
  readonly views: readonly RequirementView[];
  readonly input: PromptInput;
  /** Requirement ids somebody else changed since the person started (D-L102). */
  readonly conflicts: readonly string[];
  readonly refusal: string | null;
  readonly sending: boolean;
}

export function PipelineScreen({
  pipelineId,
  locale,
  messages,
  locales,
  live,
  links,
}: {
  pipelineId: string;
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  live: readonly string[];
  /** Whether `/contacts/[id]` and `/accounts/[id]` answer in this process: a summary links only then. */
  links: RecordLinks;
}) {
  const t = createBundleTranslator(locale, messages);
  const online = useOnline();
  const [view, setView] = useState<View>('board');
  const [filterState, setFilterState] = useState<FilterState>(NO_FILTERS);
  const [debouncedQ, setDebouncedQ] = useState('');
  const [withheldSeen, setWithheldSeen] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [sheet, setSheet] = useState<Deal | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [creating, setCreating] = useState(false);
  const [listNonce, setListNonce] = useState(0);
  const [refocus, setRefocus] = useState<string | null>(null);
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
    document.querySelector<HTMLElement>(`[data-deal-card="${CSS.escape(refocus)}"] [data-action="move-deal"]`)?.focus();
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
    async (error: PipelineError, config: Pipeline | null): Promise<string> => {
      if (error.code === 'requirements_unmet') {
        let known = config;
        const ids = unmetRequirementIds(error);
        if (ids.some((id) => findRequirement(known, id) === undefined)) {
          // The pipeline was reconfigured since it was read: learn the new requirement's label.
          known = (await refreshPipeline()) ?? known;
        }
        const labels = ids
          .map((id) => findRequirement(known, id))
          .flatMap((requirement) =>
            requirement === undefined ? [] : [requirement.kind === 'check' ? requirement.label : t.t(fieldLabel(requirement.field))],
          );
        return labels.length === 0 ? t.t('records.error.requirements_unmet') : t.t('pipeline.move.unmet', { requirements: labels.join(', ') });
      }
      const fields = notEditableFields(error);
      if (fields.length > 0) {
        return t.t('pipeline.move.field_not_editable', { fields: fields.map((field) => t.t(fieldLabel(field))).join(', ') });
      }
      if (error.code === 'transition_not_allowed') {
        // The allow-list changed since it was read: learn it, so the next try is said here.
        void refreshPipeline();
      }
      return t.t(errorMessage(error));
    },
    [refreshPipeline, t],
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
            setNotice(t.t('records.error.stale_write'));
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
        setNotice(t.t('records.error.stale_write'));
        reload();
        setBusy(deal.id, false);
        return;
      }
      const text = await refusalText(error, pipeline);
      setBusy(deal.id, false);
      if (fromPrompt && promptRef.current !== null) {
        setPrompt((current) => (current === null ? current : { ...current, sending: false, refusal: text }));
      } else {
        setNotice(text);
      }
    },
    [pipeline, place, refusalText, reload, setBusy, t, withheldFields],
  );

  /**
   * A drop or a sheet choice. Off the allow-list: said, never sent (R9). A
   * target whose requirements the deal does not meet: the prompt. Otherwise
   * the move goes as `{ version, toStageId }`.
   */
  const requestMove = useCallback(
    (deal: Deal, toStageId: string, byControl: boolean) => {
      if (!navigator.onLine || pipeline === null || toStageId === deal.stageId || pending.has(deal.id)) return;
      setNotice(null);
      setAnnouncement('');
      if (!isAllowed(pipeline, deal.stageId, toStageId)) {
        setNotice(t.t('pipeline.move.notAllowed'));
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
    [pending, pipeline, send, t, withheldFields],
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
  const dialogOpen = sheet !== null || prompt !== null || creating;

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="deals" live={live}>
      <div data-screen="P06/01" data-view={view} className="flex min-w-0 flex-col gap-4">
        {/* Behind an open dialog the screen is inert: focus cannot reach another card and open a second one. */}
        <div inert={dialogOpen} className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Link href="/pipelines" className={`inline-flex min-h-touch items-center gap-1 self-start rounded-md text-body-sm font-semibold text-primary-text ${FOCUS}`}>
            <Icon name="arrow_back" size="sm" />
            {t.t('pipeline.index.back')}
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="min-w-0 break-words text-h2">
              {pipeline === null ? t.t('records.nav.deals') : <span data-record-text="">{pipeline.name}</span>}
            </h1>
            <span className="flex-1" />
            {model.phase === 'ready' ? (
              <>
                <div role="group" aria-label={t.t('pipeline.view.label')} className="hidden gap-1 rounded-md border border-border bg-surface p-1 md:flex">
                  {(['board', 'list'] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      data-view-option={option}
                      aria-pressed={view === option}
                      onClick={() => setView(option)}
                      className={`flex min-h-touch items-center gap-2 rounded-sm px-3 text-body-sm font-semibold ${FOCUS} ${
                        view === option ? 'bg-primary-soft text-primary-text' : 'text-text hover:bg-surface-sunken'
                      }`}
                    >
                      <Icon name={option === 'board' ? 'space_dashboard' : 'menu'} size="sm" />
                      {t.t(option === 'board' ? 'pipeline.view.board' : 'pipeline.view.list')}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  data-action="new-deal"
                  data-requires-connection=""
                  disabled={!online}
                  onClick={() => setCreating(true)}
                  className={`${PRIMARY_BUTTON} disabled:cursor-not-allowed`}
                >
                  <Icon name="add" size="sm" />
                  {t.t('pipeline.newDeal')}
                </button>
              </>
            ) : null}
          </div>
        </div>

        {model.phase === 'ready' || model.phase === 'loading' ? (
          <div role="search" className="flex min-w-0 flex-wrap items-end gap-3">
            <label htmlFor={searchId} className="flex min-w-0 flex-1 basis-full flex-col gap-1 text-body-sm font-semibold md:max-w-xs md:basis-auto">
              {t.t('pipeline.search.label')}
              <span className="flex min-h-touch items-center gap-2 rounded-md border border-border-strong bg-surface px-3">
                <Icon name="search" size="sm" className="text-text-muted" />
                <input
                  id={searchId}
                  type="search"
                  data-filter="q"
                  value={filterState.q}
                  maxLength={100}
                  autoComplete="off"
                  placeholder={t.t('pipeline.search.placeholder')}
                  onChange={(event) => setFilter({ q: event.target.value })}
                  className={`min-h-touch min-w-0 flex-1 bg-transparent text-body-md font-normal text-text placeholder:text-text-muted ${FOCUS}`}
                />
              </span>
            </label>
            {known ? (
              <Filters t={t} state={filterState} withheldFields={hiddenFields} onChange={setFilter} />
            ) : null}
            {active ? (
              <button type="button" onClick={() => setFilterState(NO_FILTERS)} className={QUIET_BUTTON}>
                {t.t('records.filter.clearAll')}
              </button>
            ) : null}
          </div>
        ) : null}

        {online ? null : <OfflineBanner t={t} locale={locale} syncedAt={model.syncedAt} />}

        {notice === null ? null : (
          <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
            <Icon name="error" size="sm" />
            <span>{notice}</span>
          </p>
        )}
        {model.refreshFailed ? (
          <div
            role="status"
            data-testid="board-refresh-failed"
            className="flex flex-wrap items-center gap-2 rounded-md border border-warning bg-warning-soft p-3 text-body-sm text-warning-text"
          >
            <Icon name="warning" size="sm" />
            <span className="flex-1">{t.t('pipeline.board.refreshFailed')}</span>
            <button type="button" data-requires-connection="" disabled={!online} onClick={model.reload} className={QUIET_BUTTON}>
              {t.t('records.retry')}
            </button>
          </div>
        ) : null}
        <p role="status" className="sr-only">
          {announcement}
        </p>

        {model.phase === 'loading' ? (
          <div data-testid="board-skeleton" aria-busy="true" className="flex flex-col gap-3">
            {model.slow ? <StillConnecting t={t} /> : null}
            <span role="status" className="sr-only">
              {t.t('pipeline.loading')}
            </span>
            <div aria-hidden="true" className="flex gap-3 overflow-hidden">
              {[0, 1, 2, 3].map((index) => (
                <span key={index} className="h-64 w-72 shrink-0 rounded-lg bg-surface-sunken" />
              ))}
            </div>
          </div>
        ) : model.phase === 'not-found' ? (
          <div data-testid="record-not-found" className="flex flex-col items-start gap-2 rounded-lg border border-border bg-surface p-6">
            <h2 className="text-h4 font-bold">{t.t('pipeline.notFound.title')}</h2>
            <p className="text-body-sm text-text-2">{t.t('pipeline.notFound.body')}</p>
          </div>
        ) : model.phase === 'error' ? (
          <div
            role="alert"
            data-testid="board-error"
            className="flex flex-col items-start gap-2 rounded-lg border border-danger bg-danger-soft p-4 text-body-sm text-danger-text"
          >
            <p className="flex items-center gap-2 font-bold">
              <Icon name="error" size="sm" />
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
          />
        ) : empty ? (
          <div data-testid="board-empty" className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface p-6">
            <h2 className="text-h4 font-bold">{t.t('pipeline.board.empty.title')}</h2>
            <p className="text-body-sm text-text-2">{t.t('pipeline.board.empty.body')}</p>
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
            onLoadMore={model.loadMore}
            onDrop={onDrop}
            onMoveSheet={setSheet}
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
            onOrphanRefusal={setNotice}
          />
        ) : null}
      </div>
    </CrmShell>
  );
}

/**
 * Owner, currency, close window and the won window (R12, R14). Native
 * selects and date inputs: compact, accessible, and the same on every phone.
 * A filter on a field the board said is withheld is not offered at all.
 */
function Filters({
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
  const label = 'flex min-w-0 flex-col gap-1 text-body-sm font-semibold';
  const control = `${FIELD} font-normal`;
  return (
    <div role="group" aria-label={t.t('records.filter.label')} className="flex min-w-0 flex-wrap items-end gap-3">
      {withheldFields.includes('ownerUserId') ? null : (
        <label className={label}>
          {t.t('pipeline.filter.owner')}
          <select
            data-filter="owner"
            value={state.owner}
            onChange={(event) => onChange({ owner: (OWNER_FILTERS as readonly string[]).includes(event.target.value) ? (event.target.value as OwnerFilter) : '' })}
            className={control}
          >
            <option value="">{t.t('pipeline.filter.owner.any')}</option>
            <option value="me">{t.t('pipeline.filter.owner.me')}</option>
            <option value="unassigned">{t.t('pipeline.card.unassigned')}</option>
          </select>
        </label>
      )}
      {withheldFields.includes('amount') ? null : (
        <label className={label}>
          {t.t('pipeline.filter.currency')}
          <select data-filter="currency" value={state.currency} onChange={(event) => onChange({ currency: event.target.value })} className={control}>
            <option value="">{t.t('pipeline.filter.currency.any')}</option>
            {DEAL_CURRENCIES.map((code) => (
              // ISO codes are served data, not copy: the same in every language.
              <option key={code} value={code} data-record-text="">
                {code}
              </option>
            ))}
          </select>
        </label>
      )}
      {withheldFields.includes('expectedCloseDate') ? null : (
        <>
          <label className={label}>
            {t.t('pipeline.filter.closeFrom')}
            <input
              type="date"
              data-filter-input="closeFrom"
              value={state.closeFrom}
              onChange={(event) => onChange({ closeFrom: event.target.value })}
              className={control}
            />
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
        </>
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
