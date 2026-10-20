'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import { AdminShell } from './admin-shell';
import { Panel } from './panel';
import { useResource } from './use-resource';
import { NAV_GROUPS } from './nav-model';
import { AdminLinkButton, CARD, PageHeader, ROW_ICON_BUTTON, TEXT_ACTION, adminButtonClass } from './admin-ui';
import type { LanguageOption } from '../auth/language-menu';
import {
  dismissAlert,
  getHomeSummary,
  getUsage,
  listAlerts,
  listRecentAuditEvents,
  restoreAlert,
  type AdminAlert,
  type HealthCheck,
  type Severity,
  type UsageMeter,
} from '../../lib/admin-api';
import { humaniseKey, isLabelledAction, isLabelledObjectType, withheldIfIdentifier } from '../../lib/admin-audit';
import {
  formatAgo,
  formatCount,
  formatDayMonth,
  formatMeter,
  formatMoney,
  formatPeriod,
  formatStamp,
  looksLikeId,
  periodProgress,
} from '../../lib/admin-format';

/**
 * `P02/A` — admin home.
 *
 * ---------------------------------------------------------------------------
 * THE SCORE IS NOT COMPUTED HERE.
 *
 * `GET /home/summary` sends the score, the points available and one row per
 * named check. The contract is explicit that the client must not derive it: a
 * second implementation of the health rules in the browser is a second
 * implementation to keep in step, and the one that drifts is the one the admin
 * is looking at. This screen adds up nothing. The ring is drawn to the score
 * it is sent (T-0140), and the "+N" per row comes from the row.
 * ---------------------------------------------------------------------------
 *
 * Alerts dismiss to an EMPTY STATE, not to a gap. Dismissal is per user, per the
 * contract — one admin clearing an alert must not hide it from another — and
 * "Show dismissed alerts" is how you get them back, which is why the dismissal
 * is a `PUT` and its undo is a `DELETE` rather than a local filter.
 *
 * Usage meters (T-0140, D-L194): the design draws four. A meter the API does
 * not send yet is drawn, with `admin_placeholders` on, in its empty state —
 * its name, an empty track and "No data yet" — and never with a number.
 */

const HEALTH_ICON: Readonly<Record<HealthCheck['status'], { icon: IconName; className: string }>> = {
  pass: { icon: 'check_circle', className: 'text-success-text' },
  warn: { icon: 'warning', className: 'text-warning-text' },
  fail: { icon: 'error', className: 'text-danger-text' },
  todo: { icon: 'radio_button_unchecked', className: 'text-text-muted' },
};

const ALERT_ICON: Readonly<Record<Severity, IconName>> = {
  danger: 'block',
  warning: 'lock_open',
  info: 'hourglass_top',
  success: 'check_circle',
};

const SEVERITY_TONE: Readonly<Record<Severity, string>> = {
  info: 'bg-info-soft text-info-text',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-danger-soft text-danger-text',
};

/** The design's four meters, in its order. */
const METERS: readonly string[] = ['seats', 'whatsapp_conversations', 'storage', 'ai_credits'];

const METER_ICON: Readonly<Record<string, IconName>> = {
  seats: 'event_seat',
  whatsapp_conversations: 'chat',
  storage: 'cloud',
  ai_credits: 'auto_awesome',
};

/** Where a settings id leads, when its screen is built and on in this process. */
function settingHref(
  settingId: string | null | undefined,
  linkedSettings: Readonly<Record<string, string>>,
): string | null {
  if (settingId === null || settingId === undefined) return null;
  for (const group of NAV_GROUPS) {
    for (const entry of group.items) {
      if (entry.settingId === settingId && entry.href !== null) return entry.href;
    }
  }
  return linkedSettings[settingId] ?? null;
}

export function AdminHomeScreen({
  locale,
  messages,
  locales,
  linkedSettings,
  bell,
  placeholders,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  linkedSettings: Readonly<Record<string, string>>;
  bell: boolean;
  /** `admin_placeholders` (D-L194), evaluated on the server. */
  placeholders: boolean;
}) {
  const t = createBundleTranslator(locale, messages);

  const summary = useResource((signal) => getHomeSummary(signal), []);
  const usage = useResource((signal) => getUsage(signal), []);
  const recent = useResource((signal) => listRecentAuditEvents(signal), []);

  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [dismissing, setDismissing] = useState<readonly string[]>([]);
  const alerts = useResource(
    useCallback((signal: AbortSignal) => listAlerts(includeDismissed, signal), [includeDismissed]),
    [includeDismissed],
  );

  const onDismiss = async (alert: AdminAlert) => {
    setDismissing((current) => [...current, alert.id]);
    const result = alert.dismissed
      ? await restoreAlert(alert.id)
      : await dismissAlert(alert.id);
    setDismissing((current) => current.filter((id) => id !== alert.id));
    if (result.ok) alerts.reload();
  };

  const visibleAlerts = (items: readonly AdminAlert[]) =>
    includeDismissed ? items : items.filter((alert) => !alert.dismissed);

  // No stored plan (null, or empty from the API until M23) leaves the plan out
  // rather than printing a placeholder as if it were a plan's name (T-0143).
  const planName = summary.data?.tenant.planName ?? null;
  const subtitle =
    summary.data === null
      ? undefined
      : planName === null || planName.trim() === ''
        ? t.t('admin.home.subtitle.noPlan', {
            name: summary.data.tenant.name,
            countries: t.t('admin.home.subtitle.countries', { count: summary.data.tenant.countryCount }),
            users: t.t('admin.home.subtitle.users', { count: summary.data.tenant.userCount }),
          })
        : t.t('admin.home.subtitle', {
            name: summary.data.tenant.name,
            plan: t.t('admin.home.subtitle.plan', { plan: planName }),
            countries: t.t('admin.home.subtitle.countries', { count: summary.data.tenant.countryCount }),
            users: t.t('admin.home.subtitle.users', { count: summary.data.tenant.userCount }),
          });

  return (
    <AdminShell
      locale={locale}
      messages={messages}
      locales={locales} linkedSettings={linkedSettings} bell={bell}
      activeSettingId="home"
    >
      <div data-screen="P02/A" className="flex flex-col gap-6">
        <PageHeader
          title={t.t('admin.home.title')}
          intro={subtitle}
          actions={
            // Live now that `P02/E` exists. It was a disabled control while the
            // audit screen did not: a menu entry that navigates to a 404 is
            // worse than one that is visibly not ready.
            <AdminLinkButton href="/admin/audit" data-testid="go-audit" icon="history">
              {t.t('admin.home.auditLog')}
            </AdminLinkButton>
          }
        />

        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)]">
          <section
            aria-labelledby="admin-health"
            className={`${CARD} flex flex-col gap-4.5 p-5`}
            data-testid="setup-health"
          >
            <div className="flex items-baseline gap-2">
              <h2 id="admin-health" className="m-0 flex-1 text-card-title">
                {t.t('admin.home.health.title')}
              </h2>
              {summary.data === null ? null : (
                <span className="text-caption font-normal text-text-muted">
                  {t.t('admin.home.health.checked', {
                    time: formatAgo(locale, summary.data.health.checkedAt),
                  })}
                </span>
              )}
            </div>

            <Panel t={t} resource={summary} skeletonRows={4}>
              {(data) => {
                const outstanding = data.health.checks.filter((check) => check.status !== 'pass');
                return (
                  <>
                    <div className="flex items-center gap-4">
                      <HealthRing
                        score={data.health.score}
                        outOf={data.health.outOf}
                        label={t.t('admin.home.health.score', {
                          score: data.health.score,
                          outOf: data.health.outOf,
                        })}
                        value={formatCount(locale, data.health.score)}
                        caption={t.t('admin.home.health.outOf', { outOf: data.health.outOf })}
                      />
                      <div className="flex min-w-0 flex-col gap-1">
                        <b className="text-label font-bold">
                          {outstanding.length === 0
                            ? t.t('admin.home.health.allClear')
                            : t.t('admin.home.health.fixes', { count: outstanding.length })}
                        </b>
                        {data.health.pointsAvailable > 0 ? (
                          <span className="text-pretty text-meta text-text-2">
                            {t.t('admin.home.health.points', {
                              points: data.health.pointsAvailable,
                            })}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <ul className="m-0 flex list-none flex-col p-0">
                      {data.health.checks.map((check) => {
                        const tone = HEALTH_ICON[check.status];
                        const href =
                          check.status === 'pass' ? null : settingHref(check.settingId, linkedSettings);
                        return (
                          <li
                            key={check.checkId}
                            data-check-id={check.checkId}
                            className="flex min-h-control-md items-center gap-2.5 border-t border-border"
                          >
                            <Icon name={tone.icon} size={20} className={tone.className} />
                            <span className="sr-only">
                              {t.t(`admin.home.health.status.${check.status}` as MessageId)}
                            </span>
                            <span className="min-w-0 flex-1 text-body-sm">{check.label}</span>
                            {check.points > 0 ? (
                              <span className="text-caption font-semibold text-text-muted">
                                {t.t('admin.home.health.gain', { points: check.points })}
                              </span>
                            ) : null}
                            {href === null ? null : (
                              <Link prefetch={false} href={href} className={`${TEXT_ACTION} font-bold`}>
                                {t.t('admin.home.health.fix')}
                              </Link>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                );
              }}
            </Panel>
          </section>

          <section
            aria-labelledby="admin-alerts"
            className={`${CARD} flex flex-col overflow-hidden`}
            data-testid="alerts"
          >
            <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
              <h2 id="admin-alerts" className="m-0 text-card-title">
                {t.t('admin.home.alerts.title')}
              </h2>
              {alerts.data === null ? null : visibleAlerts(alerts.data.items).length > 0 ? (
                <span className="inline-flex h-5.5 items-center rounded-full bg-danger-soft px-2 text-caption font-bold text-danger-text">
                  {t.t('admin.home.alerts.open', {
                    count: visibleAlerts(alerts.data.items).length,
                  })}
                </span>
              ) : null}
              <span className="flex-1" />
              {placeholders ? (
                <button type="button" disabled aria-disabled="true" className={TEXT_ACTION}>
                  {t.t('admin.home.alerts.settings')}
                </button>
              ) : null}
            </div>

            <div className="flex flex-col">
              <Panel t={t} resource={alerts} skeletonRows={3}>
                {(data) => {
                  const items = visibleAlerts(data.items);
                  if (items.length === 0) {
                    return (
                      <div
                        data-testid="alerts-empty"
                        className="flex flex-col items-center gap-2.5 px-6 py-10 text-center"
                      >
                        <span className="flex size-12 items-center justify-center rounded-full bg-success-soft text-success-text">
                          <Icon name="task_alt" size={26} />
                        </span>
                        <b className="text-sheet-title">{t.t('admin.home.alerts.empty.title')}</b>
                        <p className="m-0 max-w-sm text-pretty text-body-relaxed text-text-2">
                          {t.t('admin.home.alerts.empty.body')}
                        </p>
                        <button
                          type="button"
                          data-testid="show-dismissed"
                          onClick={() => setIncludeDismissed(true)}
                          className={TEXT_ACTION}
                        >
                          {t.t('admin.home.alerts.showDismissed')}
                        </button>
                      </div>
                    );
                  }

                  return (
                    <>
                      <ul className="m-0 flex list-none flex-col p-0">
                        {items.map((alert) => {
                          const href = settingHref(alert.settingId, linkedSettings);
                          return (
                            <li
                              key={alert.id}
                              data-alert-id={alert.id}
                              className="flex items-start gap-3.5 border-b border-border py-3.5 pe-3 ps-5"
                            >
                              <span
                                className={`flex size-9 shrink-0 items-center justify-center rounded-md ${SEVERITY_TONE[alert.severity]}`}
                              >
                                <Icon name={ALERT_ICON[alert.severity]} size={20} />
                              </span>
                              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <b className="text-body-sm font-bold">{alert.title}</b>
                                <span className="text-pretty text-meta text-text-2">{alert.body}</span>
                                <span className="text-caption font-normal text-text-muted">
                                  {t.t('admin.home.alerts.meta', {
                                    source: alert.sourceLabel ?? '',
                                    time: formatAgo(locale, alert.raisedAt),
                                  })}
                                </span>
                              </div>
                              {alert.actionLabel === null ||
                              alert.actionLabel === undefined ||
                              href === null ? null : (
                                <Link
                                  prefetch={false}
                                  href={href}
                                  className={`${adminButtonClass('secondary')} h-9 px-3 text-meta max-sm:hidden`}
                                >
                                  {alert.actionLabel}
                                </Link>
                              )}
                              <button
                                type="button"
                                aria-label={t.t('admin.home.alerts.dismiss')}
                                data-testid="dismiss-alert"
                                disabled={dismissing.includes(alert.id)}
                                onClick={() => void onDismiss(alert)}
                                className={ROW_ICON_BUTTON}
                              >
                                <Icon name={alert.dismissed ? 'add' : 'close'} size={20} />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                      <div className="flex px-3 py-2">
                        <button
                          type="button"
                          onClick={() => setIncludeDismissed((value) => !value)}
                          className={TEXT_ACTION}
                        >
                          {includeDismissed
                            ? t.t('admin.home.alerts.hideDismissed')
                            : t.t('admin.home.alerts.showDismissed')}
                        </button>
                      </div>
                    </>
                  );
                }}
              </Panel>
            </div>
          </section>
        </div>

        <section aria-labelledby="admin-usage" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 id="admin-usage" className="m-0 flex-1 text-h5 font-bold">
              {t.t('admin.home.usage.title')}
            </h2>
            {usage.data === null ? null : (
              <UsagePeriod t={t} locale={locale} start={usage.data.periodStart} end={usage.data.periodEnd} />
            )}
          </div>
          <Panel t={t} resource={usage} skeletonRows={2}>
            {(data) => {
              const served = new Map(data.meters.map((meter) => [meter.meterId, meter]));
              return (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  {METERS.map((id) => {
                    const meter = served.get(id);
                    if (meter !== undefined) {
                      return <UsageCard key={id} meter={meter} locale={locale} t={t} />;
                    }
                    return placeholders ? <EmptyUsageCard key={id} meterId={id} t={t} /> : null;
                  })}
                  {data.meters
                    .filter((meter) => !METERS.includes(meter.meterId))
                    .map((meter) => (
                      <UsageCard key={meter.meterId} meter={meter} locale={locale} t={t} />
                    ))}
                </div>
              );
            }}
          </Panel>
        </section>

        <section aria-labelledby="admin-recent" className={`${CARD} overflow-hidden`}>
          <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
            <h2 id="admin-recent" className="m-0 flex-1 text-card-title">
              {t.t('admin.home.recent.title')}
            </h2>
            <Link prefetch={false} href="/admin/audit" data-testid="recent-see-all" className={TEXT_ACTION}>
              {t.t('admin.home.recent.seeAll')}
            </Link>
          </div>
          <div className="p-5 [&:has(>ul)]:p-0">
            <Panel t={t} resource={recent} skeletonRows={3}>
              {(data) => (
                <ul className="m-0 flex list-none flex-col p-0">
                  {data.items.map((entry) => {
                    const action = isLabelledAction(entry.action)
                      ? t.t(`admin.audit.action.${entry.action}` as MessageId)
                      : (entry.summary ?? humaniseKey(entry.action));
                    const objectType = entry.objectType ?? null;
                    const object =
                      objectType === null
                        ? null
                        : isLabelledObjectType(objectType)
                          ? t.t(`admin.audit.object.${objectType}` as MessageId)
                          : humaniseKey(objectType);
                    const rawRecord = entry.recordLabel ?? entry.objectLabel ?? null;
                    const record =
                      rawRecord === null
                        ? null
                        : looksLikeId(rawRecord)
                          ? t.t('admin.audit.record.id', { id: rawRecord.slice(-6).toUpperCase() })
                          : withheldIfIdentifier(rawRecord);
                    return (
                      <li
                        key={entry.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-border px-5 py-2.5 text-body-sm last:border-b-0 sm:min-h-12 sm:flex-nowrap sm:py-0"
                      >
                        <time
                          dateTime={entry.occurredAt}
                          className="w-full shrink-0 text-meta text-text-muted sm:w-36"
                        >
                          {formatStamp(locale, entry.occurredAt)}
                        </time>
                        <span className="shrink-0 font-semibold sm:w-1/5 sm:min-w-36">
                          {entry.actor.displayName ?? ''}
                        </span>
                        <span className="min-w-0 sm:flex-1">
                          {object === null ? action : t.t('admin.home.recent.what', { action, object })}
                        </span>
                        <span className="w-full min-w-0 truncate text-text-2 sm:w-auto sm:flex-1">
                          {record ?? ''}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </div>
        </section>
      </div>
    </AdminShell>
  );
}

/**
 * The setup-health ring, drawn to its score: a 96px ring, 10px thick, the
 * score's share in the tone of its band over a sunken track. Banded rather
 * than a gradient for the same reason as the SLA bars: "is this in trouble"
 * reads faster than a hue.
 */
function HealthRing({
  score,
  outOf,
  label,
  value,
  caption,
}: {
  score: number;
  outOf: number;
  label: string;
  value: string;
  caption: string;
}) {
  const share = outOf <= 0 ? 0 : Math.max(0, Math.min(1, score / outOf));
  const radius = 43;
  const circumference = 2 * Math.PI * radius;
  const tone = share >= 0.75 ? 'stroke-success' : share >= 0.5 ? 'stroke-warning' : 'stroke-danger';
  return (
    <div role="img" aria-label={label} className="relative flex size-24 shrink-0 items-center justify-center">
      <svg
        aria-hidden="true"
        viewBox="0 0 96 96"
        className="absolute inset-0 size-24 -rotate-90 rtl:-scale-x-100"
      >
        <circle cx="48" cy="48" r={radius} fill="none" strokeWidth="10" className="stroke-surface-sunken" />
        {share === 0 ? null : (
          <circle
            cx="48"
            cy="48"
            r={radius}
            fill="none"
            strokeWidth="10"
            strokeDasharray={`${share * circumference} ${circumference}`}
            className={tone}
            data-testid="health-ring"
            data-share={Math.round(share * 100)}
          />
        )}
      </svg>
      <span className="relative flex flex-col items-center">
        <b className="text-title leading-8" data-testid="health-score">
          {value}
        </b>
        <span className="text-micro font-normal text-text-muted">{caption}</span>
      </span>
    </div>
  );
}

function UsagePeriod({ t, locale, start, end }: { t: Translator; locale: string; start: string; end: string }) {
  const progress = periodProgress(start, end);
  const resets = formatDayMonth(locale, new Date(end), 'UTC');
  return (
    <>
      {progress === null ? null : (
        <span className="inline-flex items-center gap-1.5 text-caption font-normal text-text-2">
          <span aria-hidden="true" className="h-3 w-0.5 bg-text" />
          {t.t('admin.home.usage.today', { day: progress.day, days: progress.days })}
        </span>
      )}
      <span className="text-caption font-normal text-text-muted">
        {t.t('admin.home.usage.resets', { period: formatPeriod(locale, start, end), date: resets })}
      </span>
    </>
  );
}

const METER_CARD = `${CARD} flex flex-col gap-2.5 p-4.5`;

function UsageCard({
  meter,
  locale,
  t,
}: {
  meter: UsageMeter;
  locale: string;
  t: Translator;
}) {
  const limit = meter.limit ?? null;
  const percent = limit === null || limit === 0 ? null : Math.min(100, (meter.used / limit) * 100);
  const warnAt = meter.warnAtPercent ?? null;
  const warning = percent !== null && warnAt !== null && percent >= warnAt;

  return (
    <div data-meter-id={meter.meterId} className={METER_CARD}>
      <div className="flex items-center gap-2 text-text-2">
        <Icon name={METER_ICON[meter.meterId] ?? 'bar_chart'} size={20} />
        <span className="text-body-sm font-semibold">{meter.label}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <b className="text-title-sm leading-8">{formatMeter(locale, meter.used, meter.unit)}</b>
        <span className="text-body-sm text-text-muted">
          {limit === null
            ? t.t('admin.home.usage.uncapped')
            : t.t('admin.home.usage.of', { limit: formatMeter(locale, limit, meter.unit) })}
        </span>
      </div>
      {percent === null ? null : (
        <div
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={meter.label}
          className="relative h-2 rounded-sm bg-surface-sunken"
        >
          <span
            className={`absolute inset-y-0 start-0 rounded-sm ${warning ? 'bg-warning' : 'bg-primary'}`}
            style={{ inlineSize: `${percent}%` }}
          />
          {warnAt === null ? null : (
            <span
              aria-hidden="true"
              className="absolute -inset-y-1 w-0.5 bg-text"
              style={{ insetInlineStart: `${Math.min(100, warnAt)}%` }}
            />
          )}
        </div>
      )}
      {meter.spend === null || meter.spend === undefined ? null : (
        <span className="text-pretty text-meta text-text-2">
          {t.t('admin.home.usage.spend', {
            spent: formatMoney(locale, meter.spend.amountMinor, meter.spend.currency),
            estimated:
              meter.spend.estimatedTotalMinor === null ||
              meter.spend.estimatedTotalMinor === undefined
                ? ''
                : formatMoney(locale, meter.spend.estimatedTotalMinor, meter.spend.currency),
          })}
        </span>
      )}
      {meter.note === null || meter.note === undefined ? null : (
        <span className="text-pretty text-meta text-text-2">{meter.note}</span>
      )}
    </div>
  );
}

/**
 * A designed meter the API does not serve yet (D-L194): its name, an empty
 * track and "No data yet". Never a number, and never a bar that implies one.
 */
function EmptyUsageCard({ meterId, t }: { meterId: string; t: Translator }) {
  return (
    <div data-meter-id={meterId} data-placeholder="true" className={METER_CARD}>
      <div className="flex items-center gap-2 text-text-2">
        <Icon name={METER_ICON[meterId] ?? 'bar_chart'} size={20} />
        <span className="text-body-sm font-semibold">
          {t.t(`admin.home.usage.meter.${meterId}` as MessageId)}
        </span>
      </div>
      <div className="flex h-8 items-end">
        <span className="text-label text-text-muted">{t.t('admin.home.usage.noData')}</span>
      </div>
      <div aria-hidden="true" className="h-2 rounded-sm bg-surface-sunken" />
      <span className="text-pretty text-meta text-text-2">{t.t('admin.home.usage.noData.note')}</span>
    </div>
  );
}
