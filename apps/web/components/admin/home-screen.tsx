'use client';

import { useCallback, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import { AdminShell } from './admin-shell';
import { Panel } from './panel';
import { useResource } from './use-resource';
import type { LanguageOption } from '../auth/language-menu';
import { QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
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
import { formatCount, formatDateTime, formatMeter, formatMoney } from '../../lib/admin-format';

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
 * is looking at. This screen adds up nothing. It renders `points` per row
 * because the design promises "fixing them adds 22 points", and that number
 * comes from `pointsAvailable`.
 * ---------------------------------------------------------------------------
 *
 * Alerts dismiss to an EMPTY STATE, not to a gap. Dismissal is per user, per the
 * contract — one admin clearing an alert must not hide it from another — and
 * "Show dismissed alerts" is how you get them back, which is why the dismissal
 * is a `PUT` and its undo is a `DELETE` rather than a local filter.
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

const METER_ICON: Readonly<Record<string, IconName>> = {
  seats: 'event_seat',
  whatsapp_conversations: 'chat',
  storage: 'cloud',
  ai_credits: 'auto_awesome',
};

const CARD = 'flex flex-col gap-4 rounded-lg border border-border bg-surface p-5';

export function AdminHomeScreen({
  locale,
  messages,
  locales,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
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

  return (
    <AdminShell
      locale={locale}
      messages={messages}
      locales={locales}
      activeSettingId="home"
    >
      <div data-screen="P02/A" className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <h1 className="text-h2">{t.t('admin.home.title')}</h1>
            {summary.data === null ? null : (
              <dl className="flex flex-wrap gap-x-6 gap-y-1 text-body-sm text-text-2">
                <div className="flex gap-2">
                  <dt className="text-text-muted">{t.t('admin.home.stat.plan')}</dt>
                  <dd className="font-semibold">{summary.data.tenant.planName}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-text-muted">{t.t('admin.home.stat.countries')}</dt>
                  <dd className="font-semibold">
                    {formatCount(locale, summary.data.tenant.countryCount)}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-text-muted">{t.t('admin.home.stat.users')}</dt>
                  <dd className="font-semibold">
                    {formatCount(locale, summary.data.tenant.userCount)}
                  </dd>
                </div>
              </dl>
            )}
          </div>
          <span className={`${SECONDARY_BUTTON} pointer-events-none opacity-60`} aria-disabled>
            <Icon name="history" size="sm" />
            {t.t('admin.home.auditLog')}
          </span>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <section aria-labelledby="admin-health" className={CARD} data-testid="setup-health">
            <div className="flex items-baseline gap-2">
              <h2 id="admin-health" className="flex-1 text-h5">
                {t.t('admin.home.health.title')}
              </h2>
              {summary.data === null ? null : (
                <span className="text-caption text-text-muted">
                  {t.t('admin.home.health.checked', {
                    time: formatDateTime(locale, summary.data.health.checkedAt),
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
                      <div
                        role="img"
                        aria-label={t.t('admin.home.health.score', {
                          score: data.health.score,
                          outOf: data.health.outOf,
                        })}
                        className="flex h-24 w-24 shrink-0 flex-col items-center justify-center rounded-full border-4 border-success bg-surface-sunken"
                      >
                        <b className="text-h3" data-testid="health-score">
                          {formatCount(locale, data.health.score)}
                        </b>
                        <span className="text-caption text-text-muted">
                          {t.t('admin.home.health.outOf', { outOf: data.health.outOf })}
                        </span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <b className="text-body-md">
                          {outstanding.length === 0
                            ? t.t('admin.home.health.allClear')
                            : t.t('admin.home.health.fixes', { count: outstanding.length })}
                        </b>
                        {data.health.pointsAvailable > 0 ? (
                          <span className="text-body-sm text-text-2">
                            {t.t('admin.home.health.points', {
                              points: data.health.pointsAvailable,
                            })}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <ul className="flex flex-col">
                      {data.health.checks.map((check) => {
                        const tone = HEALTH_ICON[check.status];
                        return (
                          <li
                            key={check.checkId}
                            data-check-id={check.checkId}
                            className="flex min-h-touch items-center gap-3 border-t border-border py-1"
                          >
                            <span className={tone.className}>
                              <Icon name={tone.icon} size="sm" />
                            </span>
                            <span className="sr-only">
                              {t.t(`admin.home.health.status.${check.status}` as MessageId)}
                            </span>
                            <span className="flex-1 text-body-sm">{check.label}</span>
                            {check.points > 0 ? (
                              <span className="text-caption font-semibold text-text-muted">
                                {t.t('admin.home.health.gain', { points: check.points })}
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                );
              }}
            </Panel>
          </section>

          <section aria-labelledby="admin-alerts" className={CARD} data-testid="alerts">
            <div className="flex items-center gap-3">
              <h2 id="admin-alerts" className="text-h5">
                {t.t('admin.home.alerts.title')}
              </h2>
              {alerts.data === null ? null : visibleAlerts(alerts.data.items).length > 0 ? (
                <span className="rounded-full bg-danger-soft px-2 text-caption font-bold text-danger-text">
                  {t.t('admin.home.alerts.open', {
                    count: visibleAlerts(alerts.data.items).length,
                  })}
                </span>
              ) : null}
            </div>

            <Panel t={t} resource={alerts} skeletonRows={3}>
              {(data) => {
                const items = visibleAlerts(data.items);
                if (items.length === 0) {
                  return (
                    <div
                      data-testid="alerts-empty"
                      className="flex flex-col items-center gap-2 py-10 text-center"
                    >
                      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success-soft text-success-text">
                        <Icon name="task_alt" size="lg" />
                      </span>
                      <b className="text-body-md">{t.t('admin.home.alerts.empty.title')}</b>
                      <p className="max-w-sm text-body-sm text-text-2">
                        {t.t('admin.home.alerts.empty.body')}
                      </p>
                      <button
                        type="button"
                        data-testid="show-dismissed"
                        onClick={() => setIncludeDismissed(true)}
                        className={QUIET_BUTTON}
                      >
                        {t.t('admin.home.alerts.showDismissed')}
                      </button>
                    </div>
                  );
                }

                return (
                  <>
                    <ul className="flex flex-col">
                      {items.map((alert) => (
                        <li
                          key={alert.id}
                          data-alert-id={alert.id}
                          className="flex items-start gap-3 border-t border-border py-3"
                        >
                          <span
                            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${SEVERITY_TONE[alert.severity]}`}
                          >
                            <Icon name={ALERT_ICON[alert.severity]} size="sm" />
                          </span>
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <b className="text-body-sm">{alert.title}</b>
                            <span className="text-body-sm text-text-2">{alert.body}</span>
                            <span className="text-caption text-text-muted">
                              {t.t('admin.home.alerts.meta', {
                                source: alert.sourceLabel ?? '',
                                time: formatDateTime(locale, alert.raisedAt),
                              })}
                            </span>
                          </div>
                          <button
                            type="button"
                            aria-label={t.t('admin.home.alerts.dismiss')}
                            data-testid="dismiss-alert"
                            disabled={dismissing.includes(alert.id)}
                            onClick={() => void onDismiss(alert)}
                            className="flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                          >
                            <Icon name={alert.dismissed ? 'add' : 'close'} size="sm" />
                          </button>
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      onClick={() => setIncludeDismissed((value) => !value)}
                      className={QUIET_BUTTON}
                    >
                      {includeDismissed
                        ? t.t('admin.home.alerts.hideDismissed')
                        : t.t('admin.home.alerts.showDismissed')}
                    </button>
                  </>
                );
              }}
            </Panel>
          </section>
        </div>

        <section aria-labelledby="admin-usage" className="flex flex-col gap-3">
          <h2 id="admin-usage" className="text-h5">
            {t.t('admin.home.usage.title')}
          </h2>
          <Panel t={t} resource={usage} skeletonRows={2}>
            {(data) => (
              <>
                <p className="text-caption text-text-muted">
                  {t.t('admin.home.usage.period', {
                    start: formatDateTime(locale, data.periodStart),
                    end: formatDateTime(locale, data.periodEnd),
                  })}
                </p>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  {data.meters.map((meter) => (
                    <UsageCard key={meter.meterId} meter={meter} locale={locale} t={t} />
                  ))}
                </div>
              </>
            )}
          </Panel>
        </section>

        <section
          aria-labelledby="admin-recent"
          className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5"
        >
          <div className="flex items-center gap-3">
            <h2 id="admin-recent" className="flex-1 text-h5">
              {t.t('admin.home.recent.title')}
            </h2>
            <span className="text-body-sm text-text-muted">{t.t('admin.home.recent.seeAll')}</span>
          </div>
          <Panel t={t} resource={recent} skeletonRows={3}>
            {(data) => (
              <table className="w-full text-start text-body-sm">
                <thead className="text-caption uppercase text-text-muted">
                  <tr>
                    <th scope="col" className="py-2 text-start font-bold">
                      {t.t('admin.home.recent.col.time')}
                    </th>
                    <th scope="col" className="py-2 text-start font-bold">
                      {t.t('admin.home.recent.col.actor')}
                    </th>
                    <th scope="col" className="py-2 text-start font-bold">
                      {t.t('admin.home.recent.col.what')}
                    </th>
                    <th scope="col" className="py-2 text-start font-bold">
                      {t.t('admin.home.recent.col.record')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((entry) => (
                    <tr key={entry.id} className="border-t border-border">
                      <td className="py-2 text-text-muted">
                        {formatDateTime(locale, entry.occurredAt)}
                      </td>
                      <td className="py-2 font-semibold">{entry.actor.displayName ?? ''}</td>
                      <td className="py-2">{entry.summary ?? entry.action}</td>
                      <td className="py-2 text-text-2">{entry.recordLabel ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </section>
      </div>
    </AdminShell>
  );
}

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

  return (
    <div
      data-meter-id={meter.meterId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex items-center gap-2 text-text-2">
        <Icon name={METER_ICON[meter.meterId] ?? 'bar_chart'} size="sm" />
        <span className="text-body-sm font-semibold">{meter.label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <b className="text-h3">{formatMeter(locale, meter.used, meter.unit)}</b>
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
          className="h-2 overflow-hidden rounded-full bg-surface-sunken"
        >
          <span
            className={
              meter.warnAtPercent !== null &&
              meter.warnAtPercent !== undefined &&
              percent >= meter.warnAtPercent
                ? 'block h-full bg-warning'
                : 'block h-full bg-primary'
            }
            style={{ inlineSize: `${percent}%` }}
          />
        </div>
      )}
      {meter.spend === null || meter.spend === undefined ? null : (
        <span className="text-body-sm text-text-2">
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
        <span className="text-body-sm text-text-2">{meter.note}</span>
      )}
    </div>
  );
}
