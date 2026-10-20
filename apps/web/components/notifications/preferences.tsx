'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Checkbox, Radio, Switch } from '@kasuwa/ui/components';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { numberingLocale } from '../../lib/numbering';
import { Icon } from '../icon';
import { FOCUS, HEADER_BUTTON } from './classes';

/**
 * P26 D — notification preferences at `/settings/notifications` (T-0137),
 * behind `notification_preferences` (D-L194). There is no preferences API, so
 * the screen is the design's own layout in its disabled state: every control
 * is drawn and none can change, nothing is saved, and the D1 unsaved-changes
 * bar never appears.
 *
 * Only what is true is shown checked: an assignment and a finished import
 * reach you in the app today, so those two In-app cells are checked (and
 * locked). Everything else is unchecked. The design's channel sub-labels
 * (your email address, phone number, device count, SMS price) and the quiet
 * hours' times are not drawn: the API serves none of them.
 */

const CHANNELS: readonly { readonly id: string; readonly icon: IconName; readonly label: MessageId; readonly hint?: MessageId }[] = [
  { id: 'in-app', icon: 'notifications', label: 'notifications.prefs.channel.inApp', hint: 'notifications.prefs.channel.inAppHint' },
  { id: 'email', icon: 'mail', label: 'notifications.prefs.channel.email' },
  { id: 'push', icon: 'smartphone', label: 'notifications.prefs.channel.push' },
  { id: 'whatsapp', icon: 'chat', label: 'notifications.prefs.channel.whatsapp' },
  { id: 'sms', icon: 'sms', label: 'notifications.prefs.channel.sms' },
];

interface EventRow {
  readonly id: string;
  readonly icon: IconName;
  readonly tile: string;
  readonly title: MessageId;
  readonly body: MessageId;
  /** In-app delivery that exists today. */
  readonly inApp?: true;
}

const GROUPS: readonly { readonly id: string; readonly label: MessageId; readonly rows: readonly EventRow[] }[] = [
  {
    id: 'work',
    label: 'notifications.prefs.group.work',
    rows: [
      { id: 'assigned', icon: 'assignment_ind', tile: 'bg-primary-soft text-primary-text', title: 'notifications.prefs.event.assigned', body: 'notifications.prefs.event.assignedBody', inApp: true },
      { id: 'mentions', icon: 'alternate_email', tile: 'bg-primary-soft text-primary-text', title: 'notifications.filter.mentions', body: 'notifications.prefs.event.mentionsBody' },
      { id: 'approvals', icon: 'approval', tile: 'bg-accent-soft text-accent-text', title: 'notifications.prefs.event.approvals', body: 'notifications.prefs.event.approvalsBody' },
      { id: 'sla', icon: 'timer', tile: 'bg-warning-soft text-warning-text', title: 'notifications.type.sla', body: 'notifications.prefs.event.slaBody' },
    ],
  },
  {
    id: 'marketing',
    label: 'notifications.prefs.group.marketing',
    rows: [
      { id: 'campaign', icon: 'campaign', tile: 'bg-success-soft text-success-text', title: 'notifications.prefs.event.campaign', body: 'notifications.prefs.event.campaignBody' },
      { id: 'import', icon: 'upload_file', tile: 'bg-info-soft text-info-text', title: 'notifications.prefs.event.import', body: 'notifications.prefs.event.importBody', inApp: true },
    ],
  },
  {
    id: 'finance',
    label: 'notifications.prefs.group.finance',
    rows: [
      { id: 'payment', icon: 'payments', tile: 'bg-success-soft text-success-text', title: 'notifications.prefs.event.payment', body: 'notifications.prefs.event.paymentBody' },
      { id: 'einvoice', icon: 'receipt_long', tile: 'bg-danger-soft text-danger-text', title: 'notifications.prefs.event.einvoice', body: 'notifications.prefs.event.einvoiceBody' },
    ],
  },
  {
    id: 'security',
    label: 'notifications.type.security',
    rows: [{ id: 'security', icon: 'shield_person', tile: 'bg-danger-soft text-danger-text', title: 'notifications.prefs.event.security', body: 'notifications.prefs.event.securityBody' }],
  },
];

/** The five columns after the event: 88px each, 4px apart (P26 D). */
const GRID = 'flex items-center gap-1 px-4';
/** One channel cell: 88px wide. */
const CELL = 'flex w-layout-prefs-channel shrink-0 justify-center';

/** Monday-first one-letter weekday names in the page's language, from Intl (no hard-coded letters). */
function weekdayLetters(locale: string): string[] {
  const format = new Intl.DateTimeFormat(numberingLocale(locale), { weekday: 'narrow', timeZone: 'UTC' });
  // 2024-01-01 was a Monday.
  return Array.from({ length: 7 }, (_, index) => format.format(new Date(Date.UTC(2024, 0, 1 + index))));
}

function CardTitle({ icon, title, sub, trailing }: { icon: IconName; title: string; sub?: string; trailing?: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <Icon name={icon} size={22} className="text-primary-text" />
      <span className="flex min-w-0 flex-1 flex-col">
        <h2 className="text-card-title leading-snug">{title}</h2>
        {sub === undefined ? null : <span className="text-caption font-normal text-text-2">{sub}</span>}
      </span>
      {trailing}
    </div>
  );
}

function ToggleRow({ t, title, body, label }: { t: Translator; title: MessageId; body: MessageId; label: string }) {
  return (
    <div className="flex min-h-control-lg items-center gap-3">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body-sm font-semibold">{t.t(title)}</span>
        <span className="text-caption font-normal text-text-2">{t.t(body)}</span>
      </span>
      <Switch aria-label={label} checked={false} disabled />
    </div>
  );
}

export function NotificationPreferences({
  locale,
  messages,
  locales,
  live,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  live: readonly string[];
}) {
  const t = createBundleTranslator(locale, messages);
  // The reader's own zone, read in the browser after the first paint (the server's zone is not theirs).
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => setZone(Intl.DateTimeFormat().resolvedOptions().timeZone), []);
  const days = weekdayLetters(locale);

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="notification-preferences" live={live} appBar={{ title: t.t('notifications.preferences.label'), back: '/notifications' }}>
      <div data-screen="P26/D" className="flex w-full min-w-0 max-w-screen-xl flex-col gap-5 xl:mx-2 xl:mt-1">
        <div className="flex items-end gap-3 max-md:flex-col max-md:items-stretch">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <nav aria-label={t.t('notifications.prefs.breadcrumb')} className="flex items-center gap-1 text-meta max-md:hidden">
              <span className="px-1 text-text-2">{t.t('notifications.prefs.settings')}</span>
              <Icon name="chevron_right" size={18} className="text-text-muted rtl:-scale-x-100" />
              <Link href="/notifications" className={`rounded-sm px-1 font-semibold text-primary-text ${FOCUS}`}>
                {t.t('notifications.title')}
              </Link>
            </nav>
            <h1 className="text-title-sm max-md:sr-only">{t.t('notifications.preferences.label')}</h1>
            <p className="text-body-sm text-text-2">{t.t('notifications.prefs.subtitle')}</p>
          </div>
          <button type="button" disabled className={HEADER_BUTTON}>
            <Icon name="send" size={20} className="rtl:-scale-x-100" />
            {t.t('notifications.prefs.test')}
          </button>
        </div>

        <div className="flex flex-col items-start gap-5 xl:flex-row">
          {/* The events by channels matrix (D). */}
          <section aria-label={t.t('notifications.prefs.matrix')} className="w-full min-w-0 flex-1 overflow-x-auto rounded-lg border border-border bg-surface">
            <div className="min-w-fit">
              <div className={`${GRID} items-end border-b border-border bg-surface-sunken pb-3 pt-3.5`}>
                <span className="min-w-64 flex-1 text-caption font-bold uppercase tracking-wide text-text-2">{t.t('notifications.prefs.event')}</span>
                {CHANNELS.map((channel) => (
                  <span key={channel.id} className={`${CELL} flex-col items-center gap-0.5 text-center`}>
                    <Icon name={channel.icon} size={20} className="text-text-2" />
                    <b className="text-meta font-bold">{t.t(channel.label)}</b>
                    {channel.hint === undefined ? null : <span className="text-micro font-normal text-text-muted">{t.t(channel.hint)}</span>}
                  </span>
                ))}
              </div>
              {GROUPS.map((group) => (
                <div key={group.id} role="group" aria-labelledby={`prefs-group-${group.id}`} className="flex flex-col">
                  <span id={`prefs-group-${group.id}`} className="px-4 pb-1 pt-3.5 text-caption font-bold uppercase tracking-wide text-text-2">
                    {t.t(group.label)}
                  </span>
                  {group.rows.map((row) => (
                    <div key={row.id} className={`${GRID} min-h-16 border-b border-border py-1.5`}>
                      <span className="flex min-w-64 flex-1 items-center gap-3">
                        <span aria-hidden="true" className={`flex size-8 shrink-0 items-center justify-center rounded-md ${row.tile}`}>
                          <Icon name={row.icon} size={18} />
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <b className="text-body-sm font-bold">{t.t(row.title)}</b>
                          <span className="text-caption font-normal text-text-2">{t.t(row.body)}</span>
                        </span>
                      </span>
                      {CHANNELS.map((channel) => (
                        <span key={channel.id} className={CELL}>
                          <Checkbox
                            disabled
                            checked={row.inApp === true && channel.id === 'in-app'}
                            readOnly
                            aria-label={t.t('notifications.prefs.cell', { event: t.t(row.title), channel: t.t(channel.label) })}
                          />
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </section>

          <div className="flex w-full min-w-0 flex-col gap-5 xl:w-layout-settings-aside xl:shrink-0">
            {/* Quiet hours (D). */}
            <section className="flex flex-col gap-3.5 rounded-lg border border-border bg-surface p-4">
              <CardTitle
                icon="bedtime"
                title={t.t('notifications.prefs.quiet')}
                {...(zone === null ? {} : { sub: zone })}
                trailing={<Switch aria-label={t.t('notifications.prefs.quiet')} checked={false} disabled />}
              />
              <div className="flex gap-2.5">
                {(['notifications.prefs.from', 'notifications.prefs.until'] as const).map((label) => (
                  <label key={label} className="flex flex-1 flex-col gap-1 text-caption font-semibold text-text-2">
                    {t.t(label)}
                    <select disabled className="h-control-md rounded-md border border-border-strong bg-surface px-2.5 text-body-sm text-disabled-text">
                      <option value="">{t.t('notifications.prefs.noTime')}</option>
                    </select>
                  </label>
                ))}
              </div>
              <div role="group" aria-label={t.t('notifications.prefs.days')} className="flex gap-1.5">
                {days.map((day, index) => (
                  <button key={index} type="button" disabled aria-pressed={false} className="h-control-sm flex-1 rounded-md border border-border bg-surface text-meta font-bold text-disabled-text">
                    {day}
                  </button>
                ))}
              </div>
              <p className="text-meta text-text-2">{t.t('notifications.prefs.quietBody')}</p>
              <div className="flex flex-col border-t border-border pt-1.5">
                <span className="py-1.5 text-caption font-bold uppercase tracking-wide text-text-2">{t.t('notifications.prefs.letThrough')}</span>
                <ToggleRow t={t} title="notifications.prefs.event.security" body="notifications.prefs.securityAlways" label={t.t('notifications.prefs.event.security')} />
                <ToggleRow t={t} title="notifications.prefs.slaBreaches" body="notifications.prefs.slaBreachesBody" label={t.t('notifications.prefs.slaBreaches')} />
                <ToggleRow t={t} title="notifications.prefs.largeApprovals" body="notifications.prefs.largeApprovalsBody" label={t.t('notifications.prefs.largeApprovals')} />
              </div>
            </section>

            {/* Email digest (D). */}
            <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
              <CardTitle icon="inbox" title={t.t('notifications.prefs.digest')} />
              <div role="radiogroup" aria-label={t.t('notifications.prefs.digest')} className="flex flex-col gap-0.5">
                {(
                  [
                    ['notifications.prefs.instant', 'notifications.prefs.instantBody'],
                    ['notifications.prefs.daily', 'notifications.prefs.dailyBody'],
                    ['notifications.prefs.weekly', 'notifications.prefs.weeklyBody'],
                  ] as const
                ).map(([title, body]) => (
                  <Radio
                    key={title}
                    name="digest"
                    disabled
                    checked={false}
                    readOnly
                    label={
                      <span className="flex flex-col">
                        <span className="font-semibold">{t.t(title)}</span>
                        <span className="text-caption font-normal text-text-2">{t.t(body)}</span>
                      </span>
                    }
                  />
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </CrmShell>
  );
}
