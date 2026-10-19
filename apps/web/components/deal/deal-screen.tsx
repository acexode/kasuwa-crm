'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import {
  createBundleTranslator,
  type MessageBundle,
  type MessageId,
  type Translator,
} from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { LINK, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
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
import { withheld, type MoveDealBody, type Pipeline } from '../../lib/pipelines-api';
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
  errorMessage,
  fieldLabel,
  formatCalendarDate,
  isAllowed,
  rebaseViews,
  requirementViews,
  stageById,
  type PromptState,
  type RequirementView,
} from '../pipeline/pipeline-model';
import { moveRefusalText } from '../pipeline/move-refusal';
import { AmountValue, Locked, Money, OwnerValue } from '../pipeline/pipeline-parts';
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
import { numberingLocale } from '../../lib/numbering';
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

const MoveSheet = dynamic(
  () => import('../pipeline/move-sheet').then((module) => module.MoveSheet),
  { ssr: false },
);
const RequirementPrompt = dynamic(
  () => import('../pipeline/requirement-prompt').then((module) => module.RequirementPrompt),
  { ssr: false },
);
const DealSheet = dynamic(() => import('./deal-sheet').then((module) => module.DealSheet), {
  ssr: false,
});
const ActivityForm = dynamic(
  () => import('../record/activity-form').then((module) => module.ActivityForm),
  { ssr: false },
);

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
}) {
  const t = createBundleTranslator(locale, messages);
  const online = useOnline();
  const model = useDealDetail(dealId);
  const custom = useCustomFields('deal', customFields);
  const activityKeys = useReadOnlyKeys();

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="deals" live={live}>
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
}) {
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

  const probability = stage === undefined ? null : percent(locale, stage.probabilityBp);
  const pipelineHref = uuidHref('/pipelines', pipeline.id);

  return (
    <>
      {/* Behind an open dialog the screen is inert: focus cannot reach a second write. */}
      <div inert={dialogOpen} className="flex min-w-0 flex-col gap-4">
        <nav data-testid="deal-breadcrumb" aria-label={t.t('deal.breadcrumb')}>
          <ol className="flex min-w-0 flex-wrap items-center gap-x-1 text-body-sm">
            <li className="inline-flex items-center">
              <Link href="/pipelines" className={`inline-flex min-h-touch items-center ${LINK}`}>
                {t.t('records.nav.deals')}
              </Link>
            </li>
            <li className="inline-flex min-w-0 items-center gap-1">
              <Icon name="chevron_right" size="sm" className="text-text-muted rtl:-scale-x-100" />
              {pipelineHref === null ? (
                <span data-record-text="" className="break-words">
                  {pipeline.name}
                </span>
              ) : (
                <Link
                  href={pipelineHref}
                  className={`inline-flex min-h-touch min-w-0 items-center break-words ${LINK}`}
                >
                  <span data-record-text="">{pipeline.name}</span>
                </Link>
              )}
            </li>
          </ol>
        </nav>

        <section aria-labelledby={headings.stage} className={`${PANEL} gap-4`}>
          <div className="flex min-w-0 flex-col gap-1">
            <h1 data-record-text="" className="break-words text-h3 md:text-h2">
              {deal.name}
            </h1>
            <p className="flex flex-wrap items-center gap-x-2 text-body-sm text-text-2">
              <span id={headings.stage}>{t.t('pipeline.field.stageId')}</span>
              <span data-field="stage" data-record-text="" className="font-semibold text-text">
                {stage?.name ?? ''}
              </span>
            </p>
          </div>

          {/* At 360 px the path scrolls inside itself, never the page; a scroller is a keyboard stop (WCAG 2.1.1). */}
          <div
            role="region"
            aria-label={t.t('deal.path')}
            tabIndex={0}
            className={`min-w-0 overflow-x-auto rounded-md pb-1 ${FOCUS}`}
          >
            <ol
              role="list"
              data-testid="stage-path"
              aria-label={t.t('deal.path')}
              className="flex w-max min-w-0 gap-1"
            >
              {pathStages(pipeline).map((step) => {
                const current = step.id === deal.stageId;
                return (
                  <li
                    key={step.id}
                    data-stage-step={step.id}
                    aria-current={current ? 'step' : undefined}
                    className={`flex min-h-touch shrink-0 items-center gap-1 rounded-md px-3 text-body-sm font-semibold ${
                      current ? 'bg-primary text-on-primary' : 'bg-surface-sunken text-text-2'
                    }`}
                  >
                    {step.requirements.length === 0 ? null : <Icon name="lock" size="sm" />}
                    <span data-record-text="">{step.name}</span>
                  </li>
                );
              })}
            </ol>
          </div>

          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <button
              type="button"
              data-action="move-deal"
              data-requires-connection=""
              aria-haspopup="dialog"
              disabled={!online || busy}
              onClick={() => setMoving(true)}
              className={`${PRIMARY_BUTTON} disabled:cursor-not-allowed`}
            >
              <Icon name="arrow_forward" size="sm" className="rtl:-scale-x-100" />
              {t.t('pipeline.card.move')}
            </button>
            <button
              type="button"
              data-action="edit-deal"
              data-requires-connection=""
              aria-haspopup="dialog"
              disabled={!online}
              onClick={() => setEditing(true)}
              className={`${SECONDARY_BUTTON} disabled:opacity-60`}
            >
              <Icon name="edit" size="sm" />
              {t.t('deal.edit')}
            </button>
            {offersAssignToMe(deal, callerId) ? (
              <button
                type="button"
                data-action="assign-to-me"
                data-requires-connection=""
                disabled={!online || busy}
                onClick={() => void assignToMe()}
                className={`${SECONDARY_BUTTON} disabled:opacity-60`}
              >
                <Icon name="person_add" size="sm" />
                {t.t('deal.assignToMe')}
              </button>
            ) : null}
          </div>
        </section>

        {notice === null ? null : notice.tone === 'error' ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text"
          >
            <Icon name="error" size="sm" />
            <span>{notice.text}</span>
          </p>
        ) : (
          <p
            role="status"
            className="flex items-center gap-2 text-body-sm font-semibold text-success-text"
          >
            <Icon name="check_circle" size="sm" />
            {notice.text}
          </p>
        )}
        <p role="status" className="sr-only">
          {announcement}
        </p>

        {custom.fields.length > 0 ? <LazyCustomValuesPanel t={t} locale={locale} fields={custom.fields} custom={deal.custom} withheldFields={deal.withheldFields} /> : null}

        <div className="grid min-w-0 items-start gap-4 md:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-4">
            <section aria-labelledby={headings.fields} className={PANEL}>
              <h2 id={headings.fields} className="text-h5">
                {t.t('deal.fields')}
              </h2>
              <dl className="flex flex-col divide-y divide-border">
                <Row
                  label={t.t('pipeline.field.amount')}
                  field="amount"
                  locked={withheld(deal, 'amount')}
                >
                  <AmountValue t={t} locale={locale} deal={deal} />
                </Row>
                <Row
                  label={
                    probability === null
                      ? t.t('deal.weighted.plain')
                      : t.t('deal.weighted', { percent: probability })
                  }
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
                </Row>
                <Row
                  label={t.t('pipeline.field.expectedCloseDate')}
                  field="expectedCloseDate"
                  locked={withheld(deal, 'expectedCloseDate')}
                >
                  {withheld(deal, 'expectedCloseDate') ? (
                    <Locked t={t} />
                  ) : deal.expectedCloseDate === null || deal.expectedCloseDate === undefined ? (
                    <NotSet t={t} />
                  ) : (
                    <time dateTime={deal.expectedCloseDate}>
                      {formatCalendarDate(locale, deal.expectedCloseDate)}
                    </time>
                  )}
                </Row>
                <Row
                  label={t.t('pipeline.field.owner')}
                  field="owner"
                  locked={withheld(deal, 'ownerUserId')}
                >
                  <OwnerValue t={t} deal={deal} />
                </Row>
                <Related t={t} kind="contact" deal={deal} link={links.contacts} />
                <Related t={t} kind="account" deal={deal} link={links.accounts} />
                <Row
                  label={t.t('pipeline.field.nextStep')}
                  field="nextStep"
                  locked={withheld(deal, 'nextStep')}
                >
                  {withheld(deal, 'nextStep') ? (
                    <Locked t={t} />
                  ) : deal.nextStep === null || deal.nextStep === undefined ? (
                    <NotSet t={t} />
                  ) : (
                    <span data-record-text="" className="break-words">
                      {deal.nextStep}
                    </span>
                  )}
                </Row>
              </dl>
            </section>

            <section aria-labelledby={headings.requirements} className={PANEL}>
              <h2 id={headings.requirements} className="text-h5">
                {t.t('deal.requirements')}
              </h2>
              <Requirements
                t={t}
                views={
                  stage === undefined ? [] : requirementViews(stage, deal, deal.withheldFields)
                }
              />
            </section>

            <section aria-labelledby={headings.checks} className={PANEL}>
              <h2 id={headings.checks} className="text-h5">
                {t.t('deal.checks')}
              </h2>
              <Checks t={t} locale={locale} deal={deal} pipeline={pipeline} />
            </section>
          </div>

          <section aria-labelledby={headings.activity} className={`${PANEL} gap-4 md:col-span-2`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id={headings.activity} className="text-h5">
                {t.t('record.section.activity')}
              </h2>
              <span className="text-caption text-text-muted">
                {t.t('record.timeline.zone', { zone: zoneName(locale) })}
              </span>
            </div>
            {targets === null ? (
              <p
                data-testid="activity-no-target"
                className="flex items-start gap-2 rounded-md bg-surface-sunken p-3 text-body-sm text-text-2"
              >
                <Icon name="info" size="sm" />
                {t.t('deal.activity.noTarget')}
              </p>
            ) : (
              <div
                role="group"
                aria-label={t.t('record.log.group')}
                className="flex flex-wrap gap-2"
              >
                {LOG_TYPES.map((type) => (
                  <button
                    key={type}
                    ref={(element) => {
                      logButtons.current[type] = element;
                    }}
                    type="button"
                    data-action="log-activity"
                    data-activity-type={type}
                    data-requires-connection=""
                    aria-expanded={logging === type}
                    disabled={!online}
                    onClick={() => setLogging(type)}
                    className={`${SECONDARY_BUTTON} disabled:opacity-60`}
                  >
                    <Icon
                      name={type === 'note' ? 'edit_note' : type === 'task' ? 'add_task' : 'call'}
                      size="sm"
                    />
                    {t.t(`record.activity.type.${type}` as MessageId)}
                  </button>
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
          onInput={(input) =>
            setPrompt((current) => (current === null ? current : { ...current, input }))
          }
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

const NO_VERSIONS: Readonly<Record<string, number>> = {};

/** Completing a task from the deal timeline is not T-0110's (R16): no version is offered, so no control is drawn. */
function ignore(): void {}

function percent(locale: string, basisPoints: number): string {
  try {
    return new Intl.NumberFormat(numberingLocale(locale), { style: 'percent', maximumFractionDigits: 2 }).format(
      basisPoints / 10_000,
    );
  } catch {
    return new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 2 }).format(
      basisPoints / 10_000,
    );
  }
}

function NotSet({ t }: { t: Translator }) {
  return <span className="text-text-muted">{t.t('records.cell.empty')}</span>;
}

/** One field: its label, and the VALUE alone under `data-field` (R9). */
function Row({
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
    <div className="flex min-w-0 flex-col gap-1 py-2">
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd
        data-field={field}
        data-locked={locked ? 'true' : undefined}
        className="min-w-0 text-body-md"
      >
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
    <div className="flex min-w-0 flex-col gap-1 py-2">
      <dt className="text-caption text-text-muted">{t.t(dealFieldLabel(field))}</dt>
      <dd
        data-related={kind}
        data-locked={locked ? 'true' : undefined}
        className="flex min-w-0 items-center gap-1 text-body-md"
      >
        {locked ? (
          <Locked t={t} />
        ) : name === null ? (
          <NotSet t={t} />
        ) : (
          <>
            <Icon
              name={kind === 'contact' ? 'person' : 'domain'}
              size="sm"
              className="text-text-muted"
            />
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
