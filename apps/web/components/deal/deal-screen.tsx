'use client';

import { clientLazy } from '../../lib/client-lazy';
import Link from 'next/link';
import { useCallback, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  createBundleTranslator,
  type MessageBundle,
  type MessageId,
  type Translator,
} from '@kasuwa/i18n/bundle';
import { Button, initials } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { LINK } from '../auth/button-classes';
import { FOCUS } from '../records/list-classes';
import { formatDateTime, zoneName } from '../record/record-core';
import {
  RecordLoading,
  RecordNotFound,
  RecordOfflineBanner,
  RecordUnavailable,
} from '../record/record-states';
import { RecordTimeline, type TimelineVocabulary } from '../record/record-timeline';
import { useOnline } from '../script-builder/use-online';
import { LazyCustomValuesPanel } from '../custom/lazy-panel';
import { useCustomFields, useReadOnlyKeys, type CustomContext, type ReadOnlyStore } from '../custom/use-custom-fields';
import { withheld, type MoveDealBody, type Pipeline, type PipelineStage } from '../../lib/pipelines-api';
import {
  DEAL_TIMELINE_FIELDS,
  createDealActivity,
  moveDealDetail,
  updateDeal,
  type DealActivityDraft,
  type DealDetail,
  type DealTimelineField,
} from '../../lib/deal-detail-api';
import {
  EMPTY_INPUT,
  allowedTargets,
  errorMessage,
  fieldLabel,
  formatLongDate,
  formatPercent,
  formatShortDate,
  isAllowed,
  rebaseViews,
  requirementViews,
  stageById,
  type PromptState,
  type RequirementView,
} from '../pipeline/pipeline-model';
import { moveRefusalText } from '../pipeline/move-refusal';
import { AmountValue, Locked, Money, OwnerValue, daysSince } from '../pipeline/pipeline-parts';
import { NO_MODULES, type DealModules } from '../pipeline/deal-modules';
import { choiceLabel, usePipelineChoices, type ChoicesState } from '../pipeline/pipeline-select';
import { DealsBarActions } from '../pipeline/bar-actions';
import type { RecordLinks } from '../pipeline/pipeline-board';
import {
  activityTargets,
  asRecordsError,
  checkRows,
  composerRefusal,
  dealFieldLabel,
  offersAssignToMe,
  pathStages,
  refusedFields,
  uuidHref,
} from './deal-model';
import { useDealDetail, type DealDetailModel } from './use-deal-detail';
import { nameOrWithheld } from '../records/name';

/**
 * `P06/05` — the deal detail (T-0110), and `P06/06` — the same at 360 px —
 * behind the pipeline flag, which only the server page reads. In the CRM
 * shell, with Deals current.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT WINS WHERE THE DESIGN DISAGREES (R5–R18). Money is the
 * server's, exact, in the currency's own format, never compact and never
 * recomputed. The close date is a calendar date, drawn as served in every
 * zone. A withheld field is a lock, never a blank or a zero; `name` is never
 * withheld; `null` is "not set". No AI deal risk, products or price books, FX
 * or US$ figures, VAT or totals, quotes, approvals, contact roles,
 * competitors, forecast category, deal type, territory, lead source, deal
 * number, attachments, WhatsApp or email items, and no Undo (D-L88).
 *
 * WRITES. The edit sheet sends `version` plus only what changed (D-L102); a
 * 409 rebases it. "Assign to me" is the only reassignment (R11). A move is
 * T-0109's sheet and prompt, through moveDeal. An activity is linked with
 * `dealId` and targets the deal's own contact and account; with neither there
 * is no composer, and the screen says why (D-L129). After every successful
 * write the timeline's first page is read again (R15). Refusals are
 * translated and never retried; nothing is optimistic.
 *
 * Write controls show to every caller (D-L84) except where the screen KNOWS
 * the API refuses (R21). Offline, every write is off and nothing queues
 * (D-P21); nothing is stored on the device (D-L64).
 *
 * The dialogs and the activity form load when first opened: the deal is what
 * a person on 256 kbps waits for.
 * ---------------------------------------------------------------------------
 */

const MoveSheet = clientLazy(() => import('../pipeline/move-sheet').then((module) => module.MoveSheet));
const RequirementPrompt = clientLazy(() => import('../pipeline/requirement-prompt').then((module) => module.RequirementPrompt));
const DealSheet = clientLazy(() => import('./deal-sheet').then((module) => module.DealSheet));
const ActivityForm = clientLazy(() => import('../record/activity-form').then((module) => module.ActivityForm));

const PANEL = 'flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4';

const LOG_TYPES = ['note', 'task', 'call'] as const;
type LogType = (typeof LOG_TYPES)[number];

function isTimelineField(field: string): field is DealTimelineField {
  return (DEAL_TIMELINE_FIELDS as readonly string[]).includes(field);
}

/** The deal's timeline names Deal fields, by name only: there is never a value to draw (T-0111 R8). */
const DEAL_TIMELINE: TimelineVocabulary = {
  fieldLabel: (field) => (isTimelineField(field) ? dealFieldLabel(field) : null),
};

export function DealScreen({
  dealId,
  locale,
  messages,
  locales,
  live,
  links,
  customFields = false,
  modules = NO_MODULES,
}: {
  dealId: string;
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  live: readonly string[];
  /** Whether `/contacts/[id]` and `/accounts/[id]` answer in this process: a summary links only then. */
  links: RecordLinks;
  /** Custom values are on in this process (read by the server page, T-0091): draw, edit and log them. */
  customFields?: boolean;
  /** The D-L194 placeholders this process draws (read by the server page). */
  modules?: DealModules;
}) {
  const t = createBundleTranslator(locale, messages);
  const online = useOnline();
  const model = useDealDetail(dealId);
  const custom = useCustomFields('deal', customFields);
  const activityKeys = useReadOnlyKeys();

  return (
    <CrmShell
      t={t}
      locale={locale}
      locales={locales}
      current="deals"
      live={live}
      appBar={{ title: t.t('deal.documentTitle'), back: (model.pipeline === null ? null : uuidHref('/pipelines', model.pipeline.id)) ?? '/pipelines', actions: <DealsBarActions t={t} live={live} /> }}
    >
      <div
        data-screen="P06/05"
        data-record-state={model.phase}
        className="flex min-w-0 flex-col gap-4"
      >
        {online ? null : <RecordOfflineBanner t={t} locale={locale} syncedAt={model.syncedAt} />}
        {model.phase === 'loading' ? (
          <RecordLoading t={t} slow={model.slow} label="deal.loading" />
        ) : null}
        {model.phase === 'not-found' ? <RecordNotFound t={t} /> : null}
        {model.phase === 'unavailable' ? (
          <RecordUnavailable
            t={t}
            heading="deal.unavailable"
            error={model.error === null ? null : asRecordsError(model.error)}
            offline={!online}
            onRetry={model.retry}
          />
        ) : null}
        {model.phase === 'ready' && model.deal !== null && model.pipeline !== null ? (
          <Ready
            t={t}
            locale={locale}
            model={model}
            deal={model.deal}
            pipeline={model.pipeline}
            online={online}
            links={links}
            custom={custom}
            customFields={customFields}
            activityKeys={activityKeys}
            modules={modules}
          />
        ) : null}
      </div>
    </CrmShell>
  );
}

type Notice = { readonly tone: 'error' | 'done'; readonly text: string } | null;

function Ready({
  t,
  locale,
  model,
  deal,
  pipeline,
  online,
  links,
  custom,
  customFields,
  activityKeys,
  modules,
}: {
  t: Translator;
  locale: string;
  model: DealDetailModel;
  deal: DealDetail;
  pipeline: Pipeline;
  online: boolean;
  links: RecordLinks;
  /** The deal's custom-field definitions and what this session has been told is read-only (T-0091). */
  custom: CustomContext;
  /** The custom-fields flag, for the activity form's own definitions. */
  customFields: boolean;
  /** Read-only activity keys, owned here so they outlive the activity form. */
  activityKeys: ReadOnlyStore;
  modules: DealModules;
}) {
  // The breadcrumb's pipeline is told apart from a namesake by its programme, as the board's dropdown is.
  const choices: ChoicesState = usePipelineChoices();
  const [moving, setMoving] = useState(false);
  const [prompt, setPrompt] = useState<PromptState<DealDetail> | null>(null);
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState<LogType | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [announcement, setAnnouncement] = useState('');
  const [busy, setBusy] = useState(false);
  const logButtons = useRef<Partial<Record<LogType, HTMLButtonElement | null>>>({});
  const headings = {
    stage: useId(),
    fields: useId(),
    checks: useId(),
    activity: useId(),
    requirements: useId(),
  };
  // The prompt as it stands now, for an answer that arrives after an await.
  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  const { apply, reReadDeal, reReadTimeline, refreshPipeline } = model;
  const stage = stageById(pipeline, deal.stageId);
  const targets = activityTargets(deal);
  const callerId = model.caller?.id ?? null;
  const dialogOpen = moving || prompt !== null || editing;

  /** One moveDeal. Never retried: a refusal is said; a 409 re-reads (and rebases an open prompt). */
  const send = useCallback(
    async (from: DealDetail, body: MoveDealBody, fromPrompt: boolean) => {
      setBusy(true);
      const result = await moveDealDetail(from.id, body);
      if (result.ok) {
        setBusy(false);
        setPrompt(null);
        apply(result.value);
        reReadTimeline();
        setAnnouncement(
          t.t('pipeline.move.moved', {
            stage: stageById(pipeline, result.value.stageId)?.name ?? '',
          }),
        );
        return;
      }
      const { error } = result;
      if (error.code === 'stale_write') {
        const fresh = await reReadDeal();
        reReadTimeline();
        setBusy(false);
        if (fromPrompt && promptRef.current !== null) {
          setPrompt((current) => {
            if (current === null) return current;
            const target = stageById(pipeline, current.toStageId);
            if (fresh === null || target === undefined)
              return { ...current, sending: false, refusal: t.t(errorMessage(error)) };
            const rebased = rebaseViews(
              current.views,
              current.deal,
              fresh,
              target,
              fresh.withheldFields,
              current.input,
            );
            return {
              ...current,
              deal: fresh,
              views: rebased.views,
              conflicts: rebased.conflicts,
              sending: false,
              refusal: t.t('pipeline.prompt.stale'),
            };
          });
          return;
        }
        setNotice({ tone: 'error', text: t.t('records.error.stale_write') });
        return;
      }
      const text = await moveRefusalText(t, error, pipeline, refreshPipeline);
      setBusy(false);
      if (fromPrompt && promptRef.current !== null) {
        setPrompt((current) =>
          current === null ? current : { ...current, sending: false, refusal: text },
        );
      } else {
        setNotice({ tone: 'error', text });
      }
    },
    [apply, pipeline, reReadDeal, reReadTimeline, refreshPipeline, t],
  );

  /** A choice in the move sheet: off the allow-list is said and never sent; unmet requirements open the prompt. */
  const requestMove = (toStageId: string) => {
    if (!navigator.onLine || busy || toStageId === deal.stageId) return;
    setNotice(null);
    setAnnouncement('');
    if (!isAllowed(pipeline, deal.stageId, toStageId)) {
      setNotice({ tone: 'error', text: t.t('pipeline.move.notAllowed') });
      return;
    }
    const target = stageById(pipeline, toStageId);
    if (target === undefined) return;
    const views = requirementViews(target, deal, deal.withheldFields);
    if (views.some((view) => !view.met)) {
      setPrompt({
        deal,
        toStageId,
        views,
        input: EMPTY_INPUT,
        conflicts: [],
        refusal: null,
        sending: false,
      });
      return;
    }
    void send(deal, { version: deal.version, toStageId }, false);
  };

  const assignToMe = async () => {
    if (callerId === null || busy || !navigator.onLine) return;
    setBusy(true);
    setNotice(null);
    const result = await updateDeal(deal.id, { version: deal.version, ownerUserId: callerId });
    if (result.ok) {
      setBusy(false);
      apply(result.value);
      reReadTimeline();
      setNotice({ tone: 'done', text: t.t('deal.assigned') });
      return;
    }
    if (result.error.code === 'stale_write') {
      await reReadDeal();
      reReadTimeline();
      setBusy(false);
      setNotice({ tone: 'error', text: t.t('records.error.stale_write') });
      return;
    }
    setBusy(false);
    // R13: a field the caller may not change is named by its label, as in the sheet.
    const fields = refusedFields(result.error);
    setNotice({
      tone: 'error',
      text:
        fields.length > 0
          ? t.t('deal.edit.field_not_editable', {
              fields: fields.map((field) => t.t(dealFieldLabel(field))).join(', '),
            })
          : t.t(errorMessage(result.error)),
    });
  };

  const log = async (draft: DealActivityDraft) => {
    if (targets === null)
      return { ok: false as const, error: { code: 'validation_failed' as const } };
    const result = await createDealActivity(deal.id, targets, draft);
    if (!result.ok) return { ok: false as const, error: asRecordsError(result.error) };
    // Whatever the create answered, the timeline draws what it serves (R15, R17).
    reReadTimeline();
    return result;
  };

  const closeLog = (saved: boolean) => {
    const type = logging;
    setLogging(null);
    if (saved) setNotice({ tone: 'done', text: t.t('record.saved') });
    if (type !== null) logButtons.current[type]?.focus();
  };

  const probability = stage === undefined ? null : formatPercent(locale, stage.probabilityBp);
  const pipelineHref = uuidHref('/pipelines', pipeline.id);
  const choice = choices.phase === 'ready' ? choices.choices.find((entry) => entry.id === pipeline.id) : undefined;
  const pipelineLabel = choice === undefined ? pipeline.name : choiceLabel(t, choice);
  const nowMs = Date.now();
  const moves = stageMoves(pipeline, deal);
  const unmetFor = (target: PipelineStage) => requirementViews(target, deal, deal.withheldFields).filter((view) => !view.met).length;
  const nextCount = moves.next === null ? 0 : unmetFor(moves.next);
  const closeDate = withheld(deal, 'expectedCloseDate') ? null : (deal.expectedCloseDate ?? null);
  const closeDays = closeDate === null ? null : daysUntil(closeDate, nowMs);
  const account = deal.account ?? null;

  return (
    <>
      {/* Behind an open dialog the screen is inert: focus cannot reach a second write. */}
      <div inert={dialogOpen} className="flex min-w-0 flex-col gap-3 md:gap-4">
        <nav data-testid="deal-breadcrumb" aria-label={t.t('deal.breadcrumb')} className="hidden md:block">
          <ol className="flex min-w-0 flex-wrap items-center gap-x-1 text-meta">
            <li className="inline-flex items-center">
              <Link prefetch={false} href="/pipelines" className={`inline-flex items-center underline underline-offset-[3px] text-primary-text ${FOCUS}`}>
                {t.t('records.nav.deals')}
              </Link>
            </li>
            <li className="inline-flex min-w-0 items-center gap-1">
              <Icon name="chevron_right" size={16} className="text-text-muted rtl:-scale-x-100" />
              {pipelineHref === null ? (
                <span data-record-text="" className="break-words">
                  {pipelineLabel}
                </span>
              ) : (
                <Link prefetch={false} href={pipelineHref} className={`inline-flex min-w-0 items-center break-words underline underline-offset-[3px] text-primary-text ${FOCUS}`}>
                  <span data-record-text="">{pipelineLabel}</span>
                </Link>
              )}
            </li>
            <li className="inline-flex min-w-0 items-center gap-1">
              <Icon name="chevron_right" size={16} className="text-text-muted rtl:-scale-x-100" />
              <b aria-current="page" data-record-text="" className="break-words">
                {deal.name}
              </b>
            </li>
          </ol>
        </nav>

        <section aria-labelledby={headings.stage} className="flex min-w-0 flex-col gap-3.5 rounded-lg border border-border bg-surface p-3.5 md:px-5 md:py-4.5">
          <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
            <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-1.5">
              <h1 id={headings.stage} data-record-text="" className="break-words text-h4 font-bold leading-tight md:text-title-sm md:font-bold">
                {deal.name}
              </h1>
              <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-body-sm leading-[21px] text-text-2">
                <span data-related="account" data-locked={withheld(deal, 'accountId') ? 'true' : undefined}>
                  {withheld(deal, 'accountId') ? (
                    <Locked t={t} />
                  ) : account === null ? (
                    <span className="text-text-muted">{t.t('deal.header.noAccount')}</span>
                  ) : links.accounts && uuidHref('/accounts', account.id) !== null ? (
                    <Link href={uuidHref('/accounts', account.id) ?? ''} prefetch={false} className={`font-semibold text-primary-text underline underline-offset-[3px] ${FOCUS}`}>
                      <span data-record-text="">{account.name}</span>
                    </Link>
                  ) : (
                    <span data-record-text="" className="font-semibold text-text">
                      {account.name}
                    </span>
                  )}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {t.t('deal.header.owner')}{' '}
                  <b data-field="owner" data-locked={withheld(deal, 'ownerUserId') ? 'true' : undefined} className="text-text">
                    <OwnerValue t={t} deal={deal} />
                  </b>
                </span>
              </p>
            </div>
            <div className="flex flex-col items-start gap-px md:items-end">
              <b className="text-h4 leading-[1.2] md:text-title-sm md:font-bold">
                <AmountValue t={t} locale={locale} deal={deal} />
              </b>
              {closeDate === null || closeDays === null ? null : (
                <span className="text-caption font-normal text-text-2">
                  {t.t('deal.header.closes')} <b className="text-text">{formatShortDate(locale, closeDate)}</b>{' '}
                  {closeDays >= 0 ? t.t('deal.header.daysLeft', { days: closeDays }) : t.t('deal.header.daysOverdue', { days: -closeDays })}
                </span>
              )}
            </div>
          </div>

          {/* The chevron path. At 360 px it scrolls inside itself, never the page; a scroller is a keyboard stop (WCAG 2.1.1). */}
          <div role="region" aria-label={t.t('deal.path')} tabIndex={0} className={`-mx-3.5 min-w-0 overflow-x-auto px-3.5 md:mx-0 md:px-0 ${FOCUS}`}>
            <ol role="list" data-testid="stage-path" aria-label={t.t('deal.path')} className="flex min-w-0 gap-0.5">
              {pathStages(pipeline).map((step, index) => {
                const state = stepState(pipeline, deal, step);
                const unmet = state === 'allowed' ? unmetFor(step) : 0;
                const tone =
                  state === 'done'
                    ? 'bg-success-soft text-success-text'
                    : state === 'current'
                      ? 'bg-primary text-on-primary'
                      : state === 'allowed'
                        ? 'bg-primary-soft text-primary-text'
                        : 'bg-surface-sunken text-text-muted';
                const icon = state === 'done' ? 'check' : state === 'current' ? 'radio_button_checked' : state === 'allowed' ? (unmet > 0 ? 'lock' : 'arrow_forward') : 'block';
                const sub =
                  state === 'done'
                    ? t.t('deal.path.done')
                    : state === 'current'
                      ? t.t('deal.path.current', { days: daysSince(deal.stageEnteredAt, nowMs), percent: probability ?? '' })
                      : state === 'allowed'
                        ? unmet > 0
                          ? t.t('deal.path.requirements', { count: unmet })
                          : t.t('deal.path.allowed')
                        : t.t('deal.path.notAllowed');
                return (
                  <li
                    key={step.id}
                    data-stage-step={step.id}
                    aria-current={state === 'current' ? 'step' : undefined}
                    style={index === 0 ? CHEVRON_FIRST : CHEVRON}
                    className={`flex min-h-[52px] min-w-[132px] flex-[1_0_132px] flex-col justify-center pe-5 ps-6 [clip-path:var(--chevron)] md:min-w-[120px] md:flex-[1_0_120px] rtl:[clip-path:var(--chevron-rtl)] ${tone}`}
                  >
                    <span className="flex items-center gap-1 whitespace-nowrap text-meta font-bold">
                      <Icon name={icon} size={16} />
                      <span data-record-text="" {...(state === 'current' ? { 'data-field': 'stage' } : {})}>
                        {step.name}
                      </span>
                    </span>
                    <span className="whitespace-nowrap text-micro font-semibold opacity-90">{sub}</span>
                  </li>
                );
              })}
            </ol>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {moves.next === null ? null : (
              <Button
                variant="primary"
                icon="arrow_forward"
                data-action="move-next"
                data-requires-connection=""
                disabled={!online || busy}
                onClick={() => (moves.next === null ? undefined : requestMove(moves.next.id))}
                className="px-4 !text-body-sm"
              >
                {t.t('deal.action.moveTo', { stage: moves.next.name })}
                {nextCount > 0 ? <span className="rounded-full bg-primary-hover px-1.5 py-0.5 text-micro">{t.t('pipeline.move.toComplete', { count: nextCount })}</span> : null}
              </Button>
            )}
            {moves.back === null ? null : (
              <Button
                icon="arrow_back"
                data-action="move-back"
                data-requires-connection=""
                disabled={!online || busy}
                onClick={() => (moves.back === null ? undefined : requestMove(moves.back.id))}
                className="px-3.5 !text-body-sm"
              >
                {t.t('deal.action.backTo', { stage: moves.back.name })}
              </Button>
            )}
            {moves.lost === null ? null : (
              <button
                type="button"
                data-action="mark-lost"
                data-requires-connection=""
                disabled={!online || busy}
                onClick={() => (moves.lost === null ? undefined : requestMove(moves.lost.id))}
                className={`inline-flex h-control-base items-center gap-1.5 rounded-md px-3 text-body-sm font-semibold text-danger-text hover:bg-danger-soft disabled:cursor-not-allowed disabled:text-disabled-text ${FOCUS}`}
              >
                <Icon name="thumb_down" size={18} />
                {t.t('deal.action.lost')}
              </button>
            )}
            <button
              type="button"
              data-action="move-deal"
              data-requires-connection=""
              aria-haspopup="dialog"
              disabled={!online || busy}
              onClick={() => setMoving(true)}
              className={`inline-flex h-control-base items-center gap-1.5 rounded-md px-3 text-body-sm font-semibold text-primary-text hover:bg-primary-soft disabled:cursor-not-allowed disabled:text-disabled-text ${FOCUS}`}
            >
              <Icon name="open_with" size={18} />
              {t.t('deal.action.allStages')}
            </button>
            <span className="min-w-0 flex-[1_1_220px] text-caption font-normal leading-[17px] text-text-muted">{t.t('deal.action.hint')}</span>
            <span className="flex flex-wrap gap-2">
              <Button
                size="compact"
                icon="edit"
                data-action="edit-deal"
                data-requires-connection=""
                aria-haspopup="dialog"
                disabled={!online}
                onClick={() => setEditing(true)}
              >
                {t.t('deal.edit')}
              </Button>
              {offersAssignToMe(deal, callerId) ? (
                <Button size="compact" icon="person_add" data-action="assign-to-me" data-requires-connection="" disabled={!online || busy} onClick={() => void assignToMe()}>
                  {t.t('deal.assignToMe')}
                </Button>
              ) : null}
            </span>
          </div>
        </section>

        {notice === null ? null : notice.tone === 'error' ? (
          <p role="alert" className="flex items-start gap-2 rounded-10 border-2 border-danger bg-danger-soft px-3.5 py-3 text-body-sm text-danger-text">
            <Icon name="block" size={20} />
            <span>{notice.text}</span>
          </p>
        ) : (
          <p role="status" className="flex items-center gap-2 text-body-sm font-semibold text-success-text">
            <Icon name="check_circle" size={18} />
            {notice.text}
          </p>
        )}
        <p role="status" className="sr-only">
          {announcement}
        </p>

        {custom.fields.length > 0 ? <LazyCustomValuesPanel t={t} locale={locale} fields={custom.fields} custom={deal.custom} withheldFields={deal.withheldFields} /> : null}

        <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="flex min-w-0 flex-col gap-4">
            {modules.risk ? <RiskCard t={t} compact className="lg:hidden" /> : null}

            <section aria-labelledby={headings.fields} className={PANEL}>
              <h2 id={headings.fields} className="text-card-title">
                {t.t('deal.fields')}
              </h2>
              <dl className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-5 gap-y-3.5">
                <Field label={t.t('pipeline.field.amount')} field="amount" locked={withheld(deal, 'amount')}>
                  <AmountValue t={t} locale={locale} deal={deal} />
                </Field>
                <Field
                  label={probability === null ? t.t('deal.weighted.plain') : t.t('deal.weighted.short', { percent: probability })}
                  field="weightedAmount"
                  locked={withheld(deal, 'amount')}
                >
                  {withheld(deal, 'amount') ? (
                    <Locked t={t} />
                  ) : deal.weightedAmount === null || deal.weightedAmount === undefined ? (
                    <span className="text-text-muted">{t.t('pipeline.card.noAmount')}</span>
                  ) : (
                    <Money t={t} locale={locale} money={deal.weightedAmount} kind="weighted" />
                  )}
                </Field>
                <Field label={t.t('deal.field.expectedClose')} field="expectedCloseDate" locked={withheld(deal, 'expectedCloseDate')}>
                  {withheld(deal, 'expectedCloseDate') ? (
                    <Locked t={t} />
                  ) : deal.expectedCloseDate === null || deal.expectedCloseDate === undefined ? (
                    <NotSet t={t} />
                  ) : (
                    <time dateTime={deal.expectedCloseDate}>{formatLongDate(locale, deal.expectedCloseDate)}</time>
                  )}
                </Field>
                <Field label={t.t('pipeline.field.nextStep')} field="nextStep" locked={withheld(deal, 'nextStep')}>
                  {withheld(deal, 'nextStep') ? (
                    <Locked t={t} />
                  ) : deal.nextStep === null || deal.nextStep === undefined ? (
                    <NotSet t={t} />
                  ) : (
                    <span data-record-text="" className="break-words">
                      {deal.nextStep}
                    </span>
                  )}
                </Field>
                <Related t={t} kind="contact" deal={deal} link={links.contacts} />
              </dl>
            </section>

            {modules.products ? <ProductsCard t={t} /> : null}

            <section aria-labelledby={headings.activity} className={PANEL}>
              <div className="flex flex-wrap items-center gap-2">
                <h2 id={headings.activity} className="flex-1 text-card-title">
                  {t.t('record.section.activity')}
                </h2>
                <span className="text-caption font-normal text-text-muted">{t.t('record.timeline.zone', { zone: zoneName(locale) })}</span>
              </div>
              {targets === null ? (
                <p data-testid="activity-no-target" className="flex items-start gap-2 rounded-md bg-surface-sunken p-3 text-body-sm text-text-2">
                  <Icon name="info" size={18} />
                  {t.t('deal.activity.noTarget')}
                </p>
              ) : (
                <div role="group" aria-label={t.t('record.log.group')} className="flex flex-wrap gap-2">
                  {LOG_TYPES.map((type) => (
                    <Button
                      key={type}
                      ref={(element) => {
                        logButtons.current[type] = element;
                      }}
                      size="compact"
                      icon={type === 'note' ? 'edit_note' : type === 'task' ? 'add_task' : 'call'}
                      data-action="log-activity"
                      data-activity-type={type}
                      data-requires-connection=""
                      aria-expanded={logging === type}
                      disabled={!online}
                      onClick={() => setLogging(type)}
                    >
                      {t.t(`record.activity.type.${type}` as MessageId)}
                    </Button>
                  ))}
                </div>
              )}
              {logging === null || targets === null ? null : (
                <ActivityForm
                  key={logging}
                  t={t}
                  type={logging}
                  offline={!online}
                  onSave={log}
                  onClose={closeLog}
                  refusal={composerRefusal}
                  customFields={customFields}
                  readOnlyStore={activityKeys}
                />
              )}
              <RecordTimeline
                t={t}
                locale={locale}
                timeline={model.timeline}
                vocabulary={DEAL_TIMELINE}
                loadingLabel="deal.loading"
                versions={NO_VERSIONS}
                completing={null}
                offline={!online}
                onRetry={model.retry}
                onLoadOlder={model.loadOlder}
                onComplete={ignore}
                meetingTimes
              />
            </section>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            {modules.risk ? <RiskCard t={t} className="hidden lg:flex" /> : null}
            {modules.relationships ? <ContactRolesCard t={t} locale={locale} deal={deal} /> : null}
            {modules.relationships ? <EmptyCard title={t.t('deal.competitors.title')} body={t.t('deal.competitors.empty')} icon="groups" /> : null}
            {modules.quotes ? (
              <EmptyCard
                title={t.t('deal.quotes.title')}
                body={t.t('deal.quotes.empty')}
                icon="request_quote"
                action={
                  <button type="button" disabled className="h-control-sm rounded-6 px-2.5 text-meta font-bold text-disabled-text">
                    {t.t('deal.quotes.new')}
                  </button>
                }
              />
            ) : null}
            {modules.quotes ? <EmptyCard title={t.t('deal.approvals.title')} body={t.t('deal.approvals.empty')} icon="approval" /> : null}
            <section aria-labelledby={headings.requirements} className={PANEL}>
              <h2 id={headings.requirements} className="text-card-title">
                {t.t('deal.requirements')}
              </h2>
              <Requirements t={t} views={stage === undefined ? [] : requirementViews(stage, deal, deal.withheldFields)} />
            </section>
            <section aria-labelledby={headings.checks} className={PANEL}>
              <h2 id={headings.checks} className="text-card-title">
                {t.t('deal.checks')}
              </h2>
              <Checks t={t} locale={locale} deal={deal} pipeline={pipeline} />
            </section>
          </div>
        </div>
      </div>

      {moving ? (
        <MoveSheet
          t={t}
          pipeline={pipeline}
          deal={deal}
          online={online}
          onClose={() => setMoving(false)}
          onChoose={(toStageId) => {
            setMoving(false);
            requestMove(toStageId);
          }}
        />
      ) : null}
      {prompt === null ? null : (
        <RequirementPrompt
          t={t}
          pipeline={pipeline}
          prompt={prompt}
          online={online}
          onInput={(input) => setPrompt((current) => (current === null ? current : { ...current, input }))}
          onClose={() => setPrompt(null)}
          onConfirm={(body) => {
            if (prompt.sending) return;
            setPrompt({ ...prompt, sending: true, refusal: null });
            void send(prompt.deal, body, true);
          }}
        />
      )}
      {editing ? (
        <DealSheet
          t={t}
          deal={deal}
          online={online}
          custom={custom}
          names={{
            primaryContactId: deal.contact ? nameOrWithheld(t, deal.contact.displayName) : '',
            accountId: deal.account?.name ?? '',
          }}
          onSave={(body) => updateDeal(deal.id, body)}
          onReRead={async () => {
            const fresh = await reReadDeal();
            reReadTimeline();
            return fresh;
          }}
          onSaved={(saved) => {
            apply(saved);
            setEditing(false);
            reReadTimeline();
            setNotice({ tone: 'done', text: t.t('record.saved') });
          }}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}

/**
 * The chevron's shape (P06/12): a 14px point on the trailing edge, and a 14px
 * notch on the leading edge after the first, mirrored for right-to-left.
 */
const CHEVRON = {
  '--chevron': 'polygon(0 0,calc(100% - 14px) 0,100% 50%,calc(100% - 14px) 100%,0 100%,14px 50%)',
  '--chevron-rtl': 'polygon(14px 0,100% 0,calc(100% - 14px) 50%,100% 100%,14px 100%,0 50%)',
} as CSSProperties;
const CHEVRON_FIRST = {
  '--chevron': 'polygon(0 0,calc(100% - 14px) 0,100% 50%,calc(100% - 14px) 100%,0 100%)',
  '--chevron-rtl': 'polygon(14px 0,100% 0,100% 100%,14px 100%,0 50%)',
} as CSSProperties;

type StepState = 'done' | 'current' | 'allowed' | 'blocked';

/** A step on the path: behind the deal (done), where it is, a later stage the allow-list lets it reach, or not. */
function stepState(pipeline: Pipeline, deal: DealDetail, step: PipelineStage): StepState {
  if (step.id === deal.stageId) return 'current';
  // Behind the deal is done, as P06/12 draws it, even where the allow-list lets it step back ("Back to …" is the way back).
  const current = stageById(pipeline, deal.stageId);
  if (current !== undefined && current.kind !== 'lost' && step.position < current.position) return 'done';
  if (isAllowed(pipeline, deal.stageId, step.id)) return 'allowed';
  return 'blocked';
}

/** The design's three moves: forward to the nearest allowed later stage, back to the nearest allowed earlier one, and lost. */
function stageMoves(pipeline: Pipeline, deal: DealDetail): { next: PipelineStage | null; back: PipelineStage | null; lost: PipelineStage | null } {
  const current = stageById(pipeline, deal.stageId);
  const targets = allowedTargets(pipeline, deal.stageId);
  const position = current?.position ?? 0;
  const later = targets.filter((stage) => stage.kind !== 'lost' && stage.position > position);
  const earlier = targets.filter((stage) => stage.kind === 'open' && stage.position < position);
  return {
    next: later[0] ?? null,
    back: earlier[earlier.length - 1] ?? null,
    lost: targets.find((stage) => stage.kind === 'lost') ?? null,
  };
}

/** Whole days from today (the reader's zone) to a calendar date; negative once it has passed. */
function daysUntil(date: string, nowMs: number): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const now = new Date(nowMs);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1) - today) / 86_400_000);
}

/** A design card with a title, an empty state and an optional header action (D-L194). */
function EmptyCard({ title, body, icon, action }: { title: string; body: string; icon: 'groups' | 'request_quote' | 'approval'; action?: ReactNode }) {
  return (
    <section className={`${PANEL} gap-1`}>
      <div className="mb-1.5 flex items-center">
        <h2 className="flex-1 text-card-title">{title}</h2>
        {action}
      </div>
      <p className="flex items-start gap-2 border-t border-border py-2.5 text-caption font-normal text-text-2">
        <Icon name={icon} size={16} className="text-text-muted" />
        {body}
      </p>
    </section>
  );
}

/** P06/12's Deal risk card, in its empty state: nothing scores deals yet (D-L194). Compact above the fields on a phone. */
function RiskCard({ t, compact = false, className = '' }: { t: Translator; compact?: boolean; className?: string }) {
  return (
    <section aria-label={t.t('deal.risk.title')} className={`flex-col gap-2.5 rounded-lg border border-warning bg-surface ${compact ? 'p-3.5' : 'p-4'} ${className || 'flex'}`}>
      <div className="flex items-center gap-2">
        <Icon name="auto_awesome" size={20} className="text-primary-text" />
        <h2 className="flex-1 text-card-title">{t.t('deal.risk.title')}</h2>
        <span className="rounded-full bg-surface-sunken px-2.25 py-0.75 text-caption font-bold text-text-2">{t.t('deal.risk.notScored')}</span>
      </div>
      <p className="text-meta text-text-2">{t.t('deal.risk.empty')}</p>
    </section>
  );
}

/** Contact roles: the served primary contact, the one role the deal has; the rest is the design's empty state (D-L194). */
function ContactRolesCard({ t, locale, deal }: { t: Translator; locale: string; deal: DealDetail }) {
  const contact = withheld(deal, 'primaryContactId') ? null : (deal.contact ?? null);
  const name = contact === null ? null : nameOrWithheld(t, contact.displayName);
  return (
    <section className={`${PANEL} gap-1`}>
      <h2 className="mb-1.5 text-card-title">{t.t('deal.roles.title')}</h2>
      {name === null ? null : (
        <div className="flex min-h-[52px] items-center gap-2.5 border-t border-border">
          <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-soft-strong text-caption font-bold text-primary-text">
            {initials(name, locale)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <b data-record-text="" className="text-body-sm">
              {name}
            </b>
            <span className="text-caption font-normal text-text-2">{t.t('pipeline.field.primaryContactId')}</span>
          </span>
        </div>
      )}
      <p className="border-t border-border py-2.5 text-caption font-normal text-text-2">{t.t('deal.roles.empty')}</p>
    </section>
  );
}

/** P06/12's Products card in its empty state: the table's head, no lines, and the totals as dashes (D-L194). */
function ProductsCard({ t }: { t: Translator }) {
  const head = 'px-3 text-micro uppercase tracking-[0.05em] text-text-2';
  return (
    <section className={PANEL}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-card-title">{t.t('deal.products.title')}</h2>
        <span className="flex-1" />
        <Button size="compact" icon="add" disabled>
          {t.t('deal.products.add')}
        </Button>
      </div>
      <div className="overflow-hidden rounded-10 border border-border">
        <div className="hidden grid-cols-[minmax(0,2.4fr)_100px_130px_56px_64px_140px] gap-2.5 bg-surface-sunken py-2.5 md:grid">
          <span className={head}>{t.t('deal.products.product')}</span>
          <span className={`${head} text-end`}>{t.t('deal.products.list')}</span>
          <span className={`${head} text-end`}>{t.t('deal.products.unit')}</span>
          <span className={`${head} text-end`}>{t.t('deal.products.qty')}</span>
          <span className={`${head} text-end`}>{t.t('deal.products.discount')}</span>
          <span className={`${head} text-end`}>{t.t('deal.products.total')}</span>
        </div>
        <p className="flex items-start gap-2 border-t border-border px-3 py-4 text-meta text-text-2 first:border-t-0 md:first:border-t">
          <Icon name="inventory_2" size={18} className="text-text-muted" />
          {t.t('deal.products.empty')}
        </p>
        <div className="flex flex-col gap-1 border-t border-border bg-surface-sunken px-3 py-2.5 text-meta">
          {(['deal.products.subtotal', 'deal.products.vat'] as const).map((label) => (
            <span key={label} className="flex justify-end gap-6">
              <span className="text-text-2">{t.t(label)}</span>
              <span className="min-w-[140px] text-end font-mono">{'—'}</span>
            </span>
          ))}
          <span className="flex justify-end gap-6 text-label">
            <b>{t.t('deal.products.total')}</b>
            <b className="min-w-[140px] text-end font-mono">{'—'}</b>
          </span>
        </div>
      </div>
    </section>
  );
}

const NO_VERSIONS: Readonly<Record<string, number>> = {};

/** Completing a task from the deal timeline is not T-0110's (R16): no version is offered, so no control is drawn. */
function ignore(): void {}


function NotSet({ t }: { t: Translator }) {
  return <span className="text-text-muted">{t.t('records.cell.empty')}</span>;
}

/** One key field: its label (12/600 muted), and the VALUE alone under `data-field` (R9). */
function Field({
  label,
  field,
  locked,
  children,
}: {
  label: string;
  field: string;
  locked: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-caption font-semibold text-text-muted">{label}</dt>
      <dd data-field={field} data-locked={locked ? 'true' : undefined} className="min-w-0 text-body-sm">
        {children}
      </dd>
    </div>
  );
}

/** The primary contact or the account: a link only from a well-formed uuid, else text; a lock; or "not set". */
function Related({
  t,
  kind,
  deal,
  link,
}: {
  t: Translator;
  kind: 'contact' | 'account';
  deal: DealDetail;
  link: boolean;
}) {
  const field = kind === 'contact' ? 'primaryContactId' : 'accountId';
  const locked = withheld(deal, field);
  const summary = kind === 'contact' ? (deal.contact ?? null) : (deal.account ?? null);
  const name =
    summary === null ? null : 'name' in summary ? summary.name : nameOrWithheld(t, summary.displayName);
  const href =
    summary === null || !link
      ? null
      : uuidHref(kind === 'contact' ? '/contacts' : '/accounts', summary.id);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-caption font-semibold text-text-muted">{t.t(dealFieldLabel(field))}</dt>
      <dd
        data-related={kind}
        data-locked={locked ? 'true' : undefined}
        className="flex min-w-0 items-center gap-1 text-body-sm"
      >
        {locked ? (
          <Locked t={t} />
        ) : name === null ? (
          <NotSet t={t} />
        ) : (
          <>
            {href === null ? (
              <span data-record-text="" className="min-w-0 break-words">
                {name}
              </span>
            ) : (
              <Link href={href} prefetch={false} className={`min-w-0 break-words ${LINK}`}>
                <span data-record-text="">{name}</span>
              </Link>
            )}
          </>
        )}
      </dd>
    </div>
  );
}

/** The CURRENT stage's requirements, met or unmet; a field requirement on a withheld field is a lock (R7). */
function Requirements({ t, views }: { t: Translator; views: readonly RequirementView[] }) {
  if (views.length === 0)
    return <p className="text-body-sm text-text-2">{t.t('deal.requirements.none')}</p>;
  return (
    <ul data-testid="stage-requirements" className="flex flex-col gap-2">
      {views.map((view) => {
        const { requirement } = view;
        return (
          <li
            key={requirement.id}
            data-requirement={requirement.id}
            data-met={view.locked ? undefined : String(view.met)}
            data-locked={view.locked ? 'true' : undefined}
            className="flex min-w-0 items-start gap-2 text-body-sm"
          >
            <Icon
              name={view.locked ? 'lock' : view.met ? 'check_circle' : 'radio_button_unchecked'}
              size="sm"
              className={view.met ? 'text-success-text' : 'text-text-muted'}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              {requirement.kind === 'check' ? (
                <span data-record-text="" className="break-words">
                  {requirement.label}
                </span>
              ) : (
                <span>{t.t(fieldLabel(requirement.field))}</span>
              )}
              <span className="text-caption text-text-2">
                {t.t(
                  view.locked
                    ? 'records.locked'
                    : view.met
                      ? 'pipeline.prompt.met'
                      : 'deal.requirements.unmet',
                )}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Every served check, in served order: the label word for word, who ticked it and when (R8). */
function Checks({
  t,
  locale,
  deal,
  pipeline,
}: {
  t: Translator;
  locale: string;
  deal: DealDetail;
  pipeline: Pipeline;
}) {
  const rows = checkRows(deal, pipeline);
  if (rows.length === 0)
    return <p className="text-body-sm text-text-2">{t.t('deal.checks.none')}</p>;
  return (
    <ul data-testid="deal-checks" className="flex flex-col gap-3">
      {rows.map((row) => (
        <li
          key={row.requirementId}
          data-check={row.requirementId}
          className="flex min-w-0 items-start gap-2 text-body-sm"
        >
          <Icon name="task_alt" size="sm" className="text-success-text" />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            {row.label === null ? (
              <span className="text-text-2">{t.t('deal.checks.removed')}</span>
            ) : (
              <span data-record-text="" className="break-words font-semibold">
                {row.label}
              </span>
            )}
            <span className="flex flex-wrap items-center gap-x-1 text-caption text-text-2">
              <span>{t.t('deal.checks.by')}</span>
              {row.checkedBy === null ? (
                <span data-checked-by="">{t.t('deal.checker.former')}</span>
              ) : (
                <span data-checked-by="" data-record-text="" className="font-semibold text-text">
                  {row.checkedBy}
                </span>
              )}
              <span aria-hidden="true">{'·'}</span>
              <time dateTime={row.checkedAt}>{formatDateTime(locale, row.checkedAt)}</time>
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
