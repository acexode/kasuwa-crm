'use client';

import Link from 'next/link';
import { useCallback, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  createBundleTranslator,
  type MessageBundle,
  type MessageId,
  type Translator,
} from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import { AdminShell } from './admin-shell';
import { Panel } from './panel';
import { Dialog } from './dialog';
import { useResource } from './use-resource';
import { useUnsavedGuard } from './use-unsaved-guard';
import { PROGRAMME_TABS, type ProgrammeTab } from './programme-tabs';
import { SlaTab } from './sla-tab';
import { DispositionsTab } from './dispositions-tab';
import { AgentsTab } from './agents-tab';
import { ScriptsTab } from './scripts-tab';
import { RetentionTab } from './retention-tab';
import { PortalTab } from './portal-tab';
import { ArchiveDialog } from './archive-dialog';
import { SampleData } from './sample-data';
import type { LanguageOption } from '../auth/language-menu';
import { SECONDARY_BUTTON } from '../auth/button-classes';
import {
  getProgramme,
  getProgrammeKpis,
  type ProgrammeDetail,
  type ProgrammeStatus,
} from '../../lib/admin-api';
import { formatCount, formatDate, formatDuration, formatPercent } from '../../lib/admin-format';
import { sampleProgrammeKpis, sampleResult } from '../../lib/admin-sample';

/**
 * `P02/B2`–`P02/B9` — one programme, seven tabs and one destructive dialog,
 * all on one route.
 *
 * The tab lives in the URL (`?tab=sla`) so a link to the SLA tab is a link a
 * person can send to a colleague, and so the back button does what it looks
 * like it does. It is NOT component state: a tab strip that resets on reload is
 * the kind of small dishonesty that makes people distrust the rest of a screen.
 *
 * `{programmeId}` is an identifier, not a scope. A programme in another tenant
 * and a programme in this tenant the caller cannot reach both come back `404`,
 * and this screen renders exactly one thing for both — `admin.error.not_found`.
 * There must never be a `403` branch here: a `403` would confirm the id names
 * something real.
 */

const STATUS_TONE: Readonly<Record<ProgrammeStatus, string>> = {
  active: 'bg-success-soft text-success-text',
  paused: 'bg-warning-soft text-warning-text',
  draft: 'bg-surface-sunken text-text-2',
  archived: 'bg-surface-sunken text-text-muted',
};

export function ProgrammeScreen({
  locale,
  messages,
  locales,
  programmeId,
  tab,
  live,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  programmeId: string;
  tab: ProgrammeTab;
  /**
   * The live-API flag, evaluated on the server (T-0035). When true, KPIs and
   * skill cover render labelled sample data instead of calling the two
   * endpoints the API has not built.
   */
  live: boolean;
}) {
  const t = createBundleTranslator(locale, messages);
  const router = useRouter();

  const programme = useResource(
    useCallback((signal: AbortSignal) => getProgramme(programmeId, signal), [programmeId]),
    [programmeId],
  );

  /** How many unsaved edits the current tab is holding. Zero elsewhere. */
  const [dirtyCount, setDirtyCount] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [discardSignal, setDiscardSignal] = useState(0);
  const [archiving, setArchiving] = useState(false);

  const onIntercept = useCallback((destination: string) => setPending(destination), []);
  useUnsavedGuard(dirtyCount > 0, onIntercept);

  const href = (next: ProgrammeTab) =>
    `/admin/programmes/${encodeURIComponent(programmeId)}?tab=${next}`;

  return (
    <AdminShell locale={locale} messages={messages} locales={locales} activeSettingId="programmes">
      <div data-screen="P02/B2" className="flex flex-col gap-6 pb-24">
        <nav aria-label={t.t('admin.prog.breadcrumb')} className="flex items-center gap-1">
          <span className="text-body-sm font-semibold text-text-muted">
            {t.t('admin.prog.eyebrow')}
          </span>
          <Icon name="chevron_right" size="sm" className="text-text-muted" />
          <Link
            href="/admin/programmes"
            className="text-body-sm font-semibold text-primary-text underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {t.t('admin.prog.title')}
          </Link>
          <Icon name="chevron_right" size="sm" className="text-text-muted" />
          <span aria-current="page" className="text-body-sm font-semibold text-text-muted">
            {programme.data?.name ?? ''}
          </span>
        </nav>

        <Panel t={t} resource={programme} skeletonRows={3}>
          {(data) => (
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="text-h2">{data.name}</h1>
                  <span
                    className={`inline-flex rounded-full px-3 py-1 text-caption font-bold ${STATUS_TONE[data.status]}`}
                  >
                    {t.t(`admin.prog.status.${data.status}` as MessageId)}
                  </span>
                </div>
                <p className="text-body-md text-text-2">
                  {[data.clientName, data.countryCode, data.reference]
                    .filter((part): part is string => typeof part === 'string' && part !== '')
                    .join(' · ')}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <span
                  className={`${SECONDARY_BUTTON} pointer-events-none opacity-60`}
                  aria-disabled
                >
                  <Icon name="open_in_new" size="sm" />
                  {t.t('admin.prog.portal')}
                </span>
                <span
                  className={`${SECONDARY_BUTTON} pointer-events-none opacity-60`}
                  aria-disabled
                >
                  <Icon name="pause" size="sm" />
                  {t.t('admin.prog.pause')}
                </span>
                {/* `P02/B9`. The dialog is where the decision is made: it
                    reads the impact when it opens, asks for the name, and on
                    success the programme is re-read so the status chip says
                    what happened. Any failure is shown, never swallowed. */}
                <button
                  type="button"
                  data-testid="archive-programme"
                  onClick={() => setArchiving(true)}
                  className="flex min-h-touch items-center justify-center gap-2 rounded-md border border-danger px-4 text-body-md font-semibold text-danger-text hover:bg-danger-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <Icon name="archive" size="sm" />
                  {t.t('admin.prog.archive')}
                </button>
              </div>
            </div>
          )}
        </Panel>

        <div
          role="tablist"
          aria-label={t.t('admin.prog.tabs')}
          className="flex gap-1 overflow-x-auto border-b border-border"
        >
          {PROGRAMME_TABS.map((value) => (
            <Link
              key={value}
              role="tab"
              href={href(value)}
              aria-selected={value === tab}
              data-testid={`tab-${value}`}
              className={`flex min-h-touch shrink-0 items-center whitespace-nowrap border-b-2 px-4 text-body-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                value === tab
                  ? 'border-primary font-bold text-primary-text'
                  : 'border-transparent font-semibold text-text-2 hover:text-text'
              }`}
            >
              {t.t(`admin.prog.tab.${value}` as MessageId)}
            </Link>
          ))}
        </div>

        {tab === 'overview' ? (
          <OverviewTab
            t={t}
            locale={locale}
            programmeId={programmeId}
            detail={programme.data}
            live={live}
          />
        ) : null}
        {tab === 'agents' ? (
          <AgentsTab t={t} locale={locale} programmeId={programmeId} live={live} />
        ) : null}
        {tab === 'sla' ? (
          <SlaTab
            t={t}
            locale={locale}
            programmeId={programmeId}
            onDirtyChange={setDirtyCount}
            discardSignal={discardSignal}
          />
        ) : null}
        {tab === 'dispositions' ? (
          <DispositionsTab t={t} locale={locale} programmeId={programmeId} />
        ) : null}
        {tab === 'scripts' ? <ScriptsTab t={t} locale={locale} programmeId={programmeId} /> : null}
        {tab === 'retention' ? (
          <RetentionTab
            t={t}
            programmeId={programmeId}
            onDirtyChange={setDirtyCount}
            discardSignal={discardSignal}
          />
        ) : null}
        {tab === 'portal' ? (
          <PortalTab t={t} locale={locale} programmeId={programmeId} detail={programme.data} />
        ) : null}
      </div>

      {archiving && programme.data !== null ? (
        <ArchiveDialog
          t={t}
          programmeId={programmeId}
          programmeName={programme.data.name}
          onClose={() => setArchiving(false)}
          onArchived={programme.reload}
        />
      ) : null}

      {pending === null ? null : (
        <Dialog
          title={t.t('admin.leave.title')}
          body={t.t('admin.leave.body')}
          icon="edit_note"
          tone="warning"
          testId="leave-dialog"
          closeLabel={t.t('admin.dialog.close')}
          onClose={() => setPending(null)}
          footer={
            <>
              <button
                type="button"
                data-testid="leave-cancel"
                onClick={() => setPending(null)}
                className={SECONDARY_BUTTON}
              >
                {t.t('admin.leave.cancel')}
              </button>
              <button
                type="button"
                data-testid="leave-confirm"
                onClick={() => {
                  const destination = pending;
                  setPending(null);
                  setDirtyCount(0);
                  setDiscardSignal((value) => value + 1);
                  router.push(destination);
                }}
                className="flex min-h-touch items-center justify-center rounded-md bg-danger px-4 text-body-md font-bold text-on-primary hover:bg-danger-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {t.t('admin.leave.confirm')}
              </button>
            </>
          }
        >
          <p className="rounded-md bg-surface-sunken p-3 text-body-sm">
            {t.t('admin.unsaved.count', { count: dirtyCount })}
          </p>
        </Dialog>
      )}
    </AdminShell>
  );
}

const CARD = 'flex flex-col gap-3 rounded-lg border border-border bg-surface p-5';

const KPI_ICON: Readonly<Record<string, IconName>> = {
  sla_met: 'timer',
  contacts_handled: 'headset_mic',
  average_handle_time: 'schedule',
  qa_score: 'verified',
};

function OverviewTab({
  t,
  locale,
  programmeId,
  detail,
  live,
}: {
  t: Translator;
  locale: string;
  programmeId: string;
  detail: ProgrammeDetail | null;
  live: boolean;
}) {
  const kpis = useResource(
    useCallback(
      (signal: AbortSignal) =>
        live
          ? sampleResult(sampleProgrammeKpis((id) => t.t(id)))
          : getProgrammeKpis(programmeId, signal),
      // `t` is rebuilt every render; the locale is what changes its output.
      [programmeId, live, locale],
    ),
    [programmeId, live, locale],
  );

  const value = (format: 'percent' | 'count' | 'duration_seconds', raw: number) =>
    format === 'percent'
      ? formatPercent(locale, raw)
      : format === 'duration_seconds'
        ? formatDuration(locale, raw)
        : formatCount(locale, raw);

  const notKnown = t.t('admin.prog.unknown');
  const text = (candidate: string | null | undefined) =>
    candidate === null || candidate === undefined || candidate === '' ? notKnown : candidate;
  const number = (candidate: number | null | undefined) =>
    candidate === null || candidate === undefined ? notKnown : formatCount(locale, candidate);

  return (
    <div className="flex flex-col gap-4">
      {/* KPIs are a SEPARATE read on purpose: they are analytics over a window
          and they will be slow. Folding them into the detail response would
          make the whole page wait for the slowest number on it. */}
      <KpiFrame t={t} live={live}>
        <Panel t={t} resource={kpis} skeletonRows={1}>
          {(data) => (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {data.kpis.map((kpi) => (
                <div key={kpi.kpiId} className={CARD} data-kpi-id={kpi.kpiId}>
                  <span className="flex items-center gap-2 text-body-sm font-semibold text-text-2">
                    <Icon name={KPI_ICON[kpi.kpiId] ?? 'bar_chart'} size="sm" />
                    {kpi.label}
                  </span>
                  <b className="text-h3">{value(kpi.format, kpi.value)}</b>
                  {kpi.targetValue === null || kpi.targetValue === undefined ? null : (
                    <span
                      className={`text-body-sm font-semibold ${
                        kpi.status === 'bad'
                          ? 'text-danger-text'
                          : kpi.status === 'warn'
                            ? 'text-warning-text'
                            : 'text-success-text'
                      }`}
                    >
                      {t.t('admin.prog.kpi.target', {
                        value: value(kpi.format, kpi.targetValue),
                      })}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </KpiFrame>

      {detail === null ? null : (
        <div className="grid gap-4 xl:grid-cols-3">
          <section className={CARD}>
            <h2 className="flex items-center gap-2 text-h5">
              <Icon name="description" size="sm" className="text-text-2" />
              {t.t('admin.prog.card.contract')}
            </h2>
            <dl className="flex flex-col">
              <Row term={t.t('admin.prog.field.reference')} detailValue={text(detail.reference)} />
              <Row
                term={t.t('admin.prog.field.started')}
                detailValue={
                  detail.contract?.startedOn === null || detail.contract?.startedOn === undefined
                    ? notKnown
                    : formatDate(locale, detail.contract.startedOn)
                }
              />
              <Row
                term={t.t('admin.prog.field.renews')}
                detailValue={
                  detail.contract?.renewsOn === null || detail.contract?.renewsOn === undefined
                    ? notKnown
                    : formatDate(locale, detail.contract.renewsOn)
                }
              />
              <Row
                term={t.t('admin.prog.field.billing')}
                detailValue={text(detail.contract?.billingBasis)}
              />
            </dl>
          </section>

          <section className={CARD}>
            <h2 className="flex items-center gap-2 text-h5">
              <Icon name="forum" size="sm" className="text-text-2" />
              {t.t('admin.prog.card.channels')}
            </h2>
            <dl className="flex flex-col">
              <Row
                term={t.t('admin.prog.field.timezone')}
                detailValue={text(detail.operating?.timeZone)}
              />
              <Row
                term={t.t('admin.prog.field.hours')}
                detailValue={text(detail.operating?.hoursSummary)}
              />
              <Row
                term={t.t('admin.prog.field.holidays')}
                detailValue={text(detail.operating?.holidayCalendar)}
              />
              {(detail.operating?.channels ?? []).map((channel) => (
                <Row
                  key={channel.channel}
                  term={t.t(`admin.channel.${channel.channel}` as MessageId)}
                  detailValue={channel.label}
                />
              ))}
            </dl>
          </section>

          <section className={CARD}>
            <h2 className="flex items-center gap-2 text-h5">
              <Icon name="group" size="sm" className="text-text-2" />
              {t.t('admin.prog.card.people')}
            </h2>
            <dl className="flex flex-col">
              <Row
                term={t.t('admin.prog.field.manager')}
                detailValue={text(detail.people?.programmeManagerName)}
              />
              <Row
                term={t.t('admin.prog.field.teamLeads')}
                detailValue={number(detail.people?.teamLeadCount)}
              />
              <Row
                term={t.t('admin.prog.field.agents')}
                detailValue={number(detail.people?.agentCount)}
              />
              <Row
                term={t.t('admin.prog.field.qa')}
                detailValue={number(detail.people?.qaAnalystCount)}
              />
              <Row
                term={t.t('admin.prog.field.portalUsers')}
                detailValue={number(detail.people?.portalUserCount)}
              />
            </dl>
          </section>
        </div>
      )}
    </div>
  );
}

/**
 * KPIs on the live console are SAMPLE data and say so (T-0035); against the
 * contract they render bare, exactly as before the API existed.
 */
function KpiFrame({ t, live, children }: { t: Translator; live: boolean; children: ReactNode }) {
  return live ? (
    <SampleData t={t} testId="kpi-sample">
      {children}
    </SampleData>
  ) : (
    <>{children}</>
  );
}

function Row({ term, detailValue }: { term: string; detailValue: string }) {
  return (
    <div className="flex gap-3 border-t border-border py-2 text-body-sm">
      <dt className="w-36 shrink-0 text-text-muted">{term}</dt>
      <dd className="flex-1 font-semibold">{detailValue}</dd>
    </div>
  );
}
