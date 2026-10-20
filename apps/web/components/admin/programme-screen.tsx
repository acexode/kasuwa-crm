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
import { Pill } from '@kasuwa/ui/components';
import { AdminButton, CARD, PageHeader, TEXT_ACTION } from './admin-ui';
import { STATUS_TONE } from './programmes-screen';
import { getProgramme, getProgrammeKpis, type ProgrammeDetail } from '../../lib/admin-api';
import {
  formatCount,
  formatCountry,
  formatDate,
  formatDuration,
  formatPercent,
} from '../../lib/admin-format';

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

/** The settings-menu entry each tab stands for, so the menu follows the tab (P02/B4, B5, B6, B7). */
const TAB_SETTING: Readonly<Partial<Record<ProgrammeTab, string>>> = {
  sla: 'b-sla',
  dispositions: 'b-disp',
  scripts: 'b-scripts',
  retention: 'b-ret',
};

export function ProgrammeScreen({
  locale,
  messages,
  locales,
  linkedSettings,
  bell,
  programmeId,
  tab,
  live,
  placeholders,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  linkedSettings: Readonly<Record<string, string>>;
  bell: boolean;
  programmeId: string;
  tab: ProgrammeTab;
  /**
   * The live-API flag, evaluated on the server (T-0035). When true, KPIs and
   * skill cover render labelled sample data instead of calling the two
   * endpoints the API has not built.
   */
  live: boolean;
  /** `admin_placeholders` (D-L194): the cards' Edit links, drawn disabled. */
  placeholders: boolean;
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
    <AdminShell
      locale={locale}
      messages={messages}
      locales={locales}
      linkedSettings={linkedSettings}
      bell={bell}
      activeSettingId={TAB_SETTING[tab] ?? 'programmes'}
    >
      <div data-screen="P02/B2" className="flex flex-col gap-6 pb-24">
        <div className="flex flex-col gap-2.5">
          <nav
            aria-label={t.t('admin.prog.breadcrumb')}
            className="flex min-w-0 items-center gap-1 text-meta font-semibold text-text-muted"
          >
            <span>{t.t('admin.prog.eyebrow')}</span>
            <Icon name="chevron_right" size={16} className="rtl:-scale-x-100" />
            <Link
              href="/admin/programmes"
              className="rounded-sm text-primary-text underline underline-offset-2 outline-none is-focus-visible:ring-focus"
            >
              {t.t('admin.prog.title')}
            </Link>
            <Icon name="chevron_right" size={16} className="rtl:-scale-x-100" />
            <span aria-current="page" className="min-w-0 truncate">
              {programme.data?.name ?? ''}
            </span>
          </nav>

          <Panel t={t} resource={programme} skeletonRows={3}>
            {(data) => {
              const subline = [data.clientName ?? null, formatCountry(locale, data.countryCode)].filter(
                (part): part is string => part !== null && part !== '',
              );
              return (
                <PageHeader
                  title={data.name}
                  aside={
                    <Pill tone={STATUS_TONE[data.status]}>
                      {t.t(`admin.prog.status.${data.status}` as MessageId)}
                    </Pill>
                  }
                  intro={
                    subline.length === 0 && (data.reference ?? '') === '' ? undefined : (
                      <p className="m-0">
                        {subline.join(' · ')}
                        {(data.reference ?? '') === '' ? null : (
                          <>
                            {subline.length === 0 ? null : <span aria-hidden="true">{' · '}</span>}
                            <span className="font-mono text-meta">{data.reference}</span>
                          </>
                        )}
                      </p>
                    )
                  }
                  actions={
                    <>
                      <AdminButton icon="open_in_new" notReady>
                        {t.t('admin.prog.portal')}
                      </AdminButton>
                      <AdminButton icon="pause" notReady>
                        {t.t('admin.prog.pause')}
                      </AdminButton>
                      {/* `P02/B9`. The dialog is where the decision is made: it
                          reads the impact when it opens, asks for the name, and
                          on success the programme is re-read so the status pill
                          says what happened. Any failure is shown, never
                          swallowed. */}
                      <AdminButton
                        variant="danger-outline"
                        icon="archive"
                        data-testid="archive-programme"
                        onClick={() => setArchiving(true)}
                      >
                        {t.t('admin.prog.archive')}
                      </AdminButton>
                    </>
                  }
                />
              );
            }}
          </Panel>
        </div>

        <div
          role="tablist"
          aria-label={t.t('admin.prog.tabs')}
          className="-mt-1 flex gap-0.5 overflow-x-auto border-b border-border"
        >
          {PROGRAMME_TABS.map((value) => {
            // Counts only where the API serves them (T-0140): the programme
            // read carries its agent count and nothing else, and a tab never
            // shows a total it had to guess.
            const count =
              value === 'agents' ? (programme.data?.people?.agentCount ?? null) : null;
            const selected = value === tab;
            return (
              <Link
                key={value}
                role="tab"
                href={href(value)}
                aria-selected={selected}
                data-testid={`tab-${value}`}
                className={`relative inline-flex h-control-base shrink-0 items-center gap-1.5 whitespace-nowrap px-3.5 text-body-sm outline-none is-focus-visible:ring-focus ${
                  selected
                    ? 'font-bold text-primary-text after:absolute after:inset-x-0 after:bottom-0 after:h-0.75 after:bg-primary'
                    : 'font-semibold text-text-2 is-hover:text-text'
                }`}
              >
                {t.t(`admin.prog.tab.${value}` as MessageId)}
                {count === null ? null : (
                  <span className="inline-flex h-5 min-w-5.5 items-center justify-center rounded-full bg-surface-sunken px-1.5 text-caption font-bold text-text-2">
                    {formatCount(locale, count)}
                  </span>
                )}
              </Link>
            );
          })}
        </div>

        {tab === 'overview' ? (
          <OverviewTab
            t={t}
            locale={locale}
            programmeId={programmeId}
            detail={programme.data}
            live={live}
            placeholders={placeholders}
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
              <AdminButton data-testid="leave-cancel" onClick={() => setPending(null)}>
                {t.t('admin.leave.cancel')}
              </AdminButton>
              <AdminButton
                variant="danger"
                data-testid="leave-confirm"
                onClick={() => {
                  const destination = pending;
                  setPending(null);
                  setDirtyCount(0);
                  setDiscardSignal((value) => value + 1);
                  router.push(destination);
                }}
              >
                {t.t('admin.leave.confirm')}
              </AdminButton>
            </>
          }
        >
          <p className="m-0 rounded-10 bg-surface-sunken px-3.5 py-3 text-meta">
            {t.t('admin.unsaved.count', { count: dirtyCount })}
          </p>
        </Dialog>
      )}
    </AdminShell>
  );
}

function OverviewTab({
  t,
  locale,
  programmeId,
  detail,
  live,
  placeholders,
}: {
  t: Translator;
  locale: string;
  programmeId: string;
  detail: ProgrammeDetail | null;
  live: boolean;
  placeholders: boolean;
}) {
  const kpis = useResource(
    useCallback(
      (signal: AbortSignal) =>
        live
          ? // Loaded only on the live console: the default route does not
            // pay for sample data it never shows (T-0010 budget).
            import('../../lib/admin-sample').then((sample) =>
              sample.sampleResult(sample.sampleProgrammeKpis((id) => t.t(id))),
            )
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
  const date = (candidate: string | null | undefined) =>
    candidate === null || candidate === undefined ? notKnown : formatDate(locale, candidate);

  const edit = placeholders ? (
    <button type="button" disabled aria-disabled="true" className={TEXT_ACTION}>
      {t.t('admin.prog.card.edit')}
    </button>
  ) : null;

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
                <div key={kpi.kpiId} className={`${CARD} flex flex-col gap-1 p-4.5`} data-kpi-id={kpi.kpiId}>
                  <span className="text-meta font-semibold text-text-2">{kpi.label}</span>
                  <b className="text-title-sm">{value(kpi.format, kpi.value)}</b>
                  {kpi.targetValue === null || kpi.targetValue === undefined ? null : (
                    <span
                      className={`text-meta font-semibold ${
                        kpi.status === 'bad'
                          ? 'text-danger-text'
                          : kpi.status === 'warn'
                            ? 'text-warning-text'
                            : kpi.status === 'good'
                              ? 'text-success-text'
                              : 'text-text-2'
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
        <div className="grid items-start gap-4 xl:grid-cols-3">
          <InfoCard icon="description" title={t.t('admin.prog.card.contract')} action={edit}>
            <Row term={t.t('admin.prog.field.client')} detailValue={text(detail.clientName)} />
            <Row
              term={t.t('admin.prog.field.reference')}
              detailValue={text(detail.contract?.reference ?? detail.reference)}
            />
            <Row term={t.t('admin.prog.field.started')} detailValue={date(detail.contract?.startedOn)} />
            <Row term={t.t('admin.prog.field.renews')} detailValue={date(detail.contract?.renewsOn)} />
            <Row term={t.t('admin.prog.field.billing')} detailValue={text(detail.contract?.billingBasis)} />
          </InfoCard>

          <InfoCard icon="forum" title={t.t('admin.prog.card.channels')} action={edit}>
            {(detail.operating?.channels ?? []).map((channel) => (
              <Row
                key={channel.channel}
                term={t.t(`admin.channel.${channel.channel}` as MessageId)}
                detailValue={channel.label}
              />
            ))}
            <Row term={t.t('admin.prog.field.hours')} detailValue={text(detail.operating?.hoursSummary)} />
            <Row
              term={t.t('admin.prog.field.holidays')}
              detailValue={text(detail.operating?.holidayCalendar)}
            />
          </InfoCard>

          <InfoCard icon="groups" title={t.t('admin.prog.card.people')} action={edit}>
            <Row
              term={t.t('admin.prog.field.manager')}
              detailValue={text(detail.people?.programmeManagerName)}
            />
            <Row term={t.t('admin.prog.field.teamLeads')} detailValue={number(detail.people?.teamLeadCount)} />
            <Row term={t.t('admin.prog.field.agents')} detailValue={number(detail.people?.agentCount)} />
            <Row term={t.t('admin.prog.field.qa')} detailValue={number(detail.people?.qaAnalystCount)} />
            <Row
              term={t.t('admin.prog.field.portalUsers')}
              detailValue={number(detail.people?.portalUserCount)}
            />
          </InfoCard>
        </div>
      )}
    </div>
  );
}

function InfoCard({
  icon,
  title,
  action,
  children,
}: {
  icon: IconName;
  title: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`${CARD} flex flex-col gap-2.5 px-5 py-4.5`}>
      <div className="flex min-h-8 items-center gap-2">
        <Icon name={icon} size={20} className="text-text-2" />
        <h2 className="m-0 flex-1 text-label font-bold">{title}</h2>
        {action}
      </div>
      <dl className="m-0 flex flex-col">{children}</dl>
    </section>
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
      <dt className="w-32 shrink-0 text-text-muted">{term}</dt>
      <dd className="m-0 min-w-0 flex-1 font-semibold">{detailValue}</dd>
    </div>
  );
}
