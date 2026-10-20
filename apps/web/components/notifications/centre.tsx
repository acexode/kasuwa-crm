'use client';

import Link from 'next/link';
import { useState, useSyncExternalStore } from 'react';
import { createBundleTranslator, type MessageBundle, type Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { SECONDARY_BUTTON } from '../auth/button-classes';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { liveObjectTypes } from '../../lib/notification-href';
import { CENTRE_LIMIT, unreadIn } from '../../lib/notification-model';
import type { CountState } from '../../lib/notification-count';
import { countServerSnapshot, countSnapshot, subscribeCount } from '../../lib/notification-store';
import { isEmptyForever } from '../../lib/notification-view';
import { canReadAll } from '../../lib/notification-writes';
import type { NotificationFilter, NotificationKind } from '../../lib/notifications-api';
import { Icon } from '../icon';
import { FOCUS, HEADER_BUTTON, PILL, PILL_OFF, PILL_ON, PILL_SIZE } from './classes';
import { PREFERENCES_HREF, PREFERENCES_LIVE, SHOW_PLACEHOLDERS, TYPE_ENTRIES, TYPES_LIVE } from './kinds';
import { kindLabel } from './message-ids';
import { LoadingNotifications, NotificationGroups, ViewStatus } from './notification-list';
import { useNotificationView } from './use-notification-view';

/**
 * `P26` frames B, B1 and B2 — the notification centre at `/notifications`, in
 * the CRM shell, drawn to the export by T-0137: a 240px filter card (Show,
 * then Type) beside one list card of day groups at 1440; the same filters as
 * pills over the card at 1024; a scrolling pill row over a full-bleed list on
 * a phone. Unread or all, one kind or all kinds, paged by the cursor exactly
 * as served.
 *
 * `SECONDARY_BUTTON` is the shared button class every other screen already loads: a screen that
 * did not use it would leave the one chunk of modules every route shares (the bundler's
 * "commons") and push it into every other page's own chunks (D-L182).
 *
 * Absent on purpose (C2-C4): per-type counts on the filters and an exact
 * unread total (the count is capped at 99 and per-kind counts are not served,
 * D-P13 per D-L195), "13 in the last 90 days", titles, bodies and inline
 * approvals. Types with no producer yet, and the preferences that have no API,
 * are drawn disabled behind their D-L194 flags.
 */

/** The page subtitle: the bell's own count (capped), never a total the API does not serve. */
function subtitle(t: Translator, count: CountState, empty: boolean): string | null {
  if (empty) return t.t('notifications.subtitle.none');
  if (!count.known) return null;
  if (count.capped) return t.t('notifications.unreadCapped', { count: count.count });
  return count.count === 0 ? t.t('notifications.empty.unreadTitle') : t.t('notifications.unreadCount', { count: count.count });
}

/** A rail row (P26 B): 40px Show rows at 14/600, 36px Type rows at 13/500, radius 8. */
function RailButton({
  icon,
  label,
  on,
  tone,
  disabled,
  soon,
  onClick,
  data,
}: {
  icon: IconName;
  label: string;
  on: boolean;
  tone: 'show' | 'type';
  disabled?: boolean;
  soon?: string;
  onClick?: () => void;
  data: Record<string, string>;
}) {
  const show = tone === 'show';
  const state = disabled === true
    ? 'cursor-not-allowed text-disabled-text'
    : on
      ? show
        ? 'bg-primary-soft text-primary-text'
        : 'bg-surface-sunken font-bold text-text'
      : 'text-text is-hover:bg-surface-sunken';
  return (
    <button
      type="button"
      aria-pressed={disabled === true ? undefined : on}
      disabled={disabled}
      onClick={onClick}
      {...data}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 text-start transition-colors duration-instant ${
        show ? 'min-h-control-md text-body-sm font-semibold' : 'min-h-control-sm text-meta font-medium'
      } ${state} ${FOCUS}`}
    >
      <Icon name={icon} size={show ? 20 : 18} className={show || disabled === true ? '' : 'text-text-2'} />
      <span className="min-w-0 flex-1">{label}</span>
      {soon === undefined ? null : <span className="sr-only">{soon}</span>}
    </button>
  );
}

export function NotificationCentre({
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
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const [kind, setKind] = useState<NotificationKind | null>(null);
  const view = useNotificationView({ filter, kind, limit: CENTRE_LIMIT }, true);
  const { state } = view;
  const count = useSyncExternalStore(subscribeCount, countSnapshot, countServerSnapshot);
  const typesLive = live.includes(TYPES_LIVE);
  const preferencesLive = live.includes(PREFERENCES_LIVE);
  const soon = t.t('records.nav.soon');

  const waiting = state.listWaitUntil !== null || state.writeWaitUntil !== null;
  const anyUnreadElsewhere = kind === null && count.known && (count.count > 0 || count.capped);
  // A mark-all and a dot are never in flight together (N4): `canReadAll` also waits for every busy dot.
  const readAllUsable = state.phase === 'ready' && canReadAll(state, Date.now()) && (unreadIn(state.items, kind) > 0 || anyUnreadElsewhere);
  const emptyForever = isEmptyForever(state);
  const nothingAtAll = emptyForever && filter === 'all' && kind === null;
  const summary = subtitle(t, count, nothingAtAll);

  const showFilters = (['all', 'unread'] as const).map((value) => ({
    value,
    icon: (value === 'all' ? 'inbox' : 'mark_email_unread') as IconName,
    label: t.t(value === 'all' ? 'notifications.filter.all' : 'notifications.filter.unread'),
  }));
  const types = TYPE_ENTRIES.filter((entry) => 'kind' in entry || typesLive);
  const pill = (on: boolean) => `${PILL} ${PILL_SIZE} ${on ? PILL_ON : PILL_OFF}`;

  return (
    <CrmShell
      t={t}
      locale={locale}
      locales={locales}
      current="notifications"
      live={live}
      appBar={{ title: t.t('notifications.title'), ...(summary === null ? {} : { subtitle: summary }) }}
    >
      <div data-screen="P26" className="flex w-full min-w-0 max-w-layout-page-wide flex-col gap-3 md:mx-2 md:mt-1 md:gap-4">
        {/* Header: the title and its count on the left, Mark all read and Preferences on the right (B); on a phone the app bar carries the title. */}
        <div className="flex flex-wrap items-end justify-end gap-x-3 gap-y-2 max-md:-mt-2 max-md:gap-x-1">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 max-md:sr-only">
            <h1 className="text-title-sm">{t.t('notifications.title')}</h1>
            {summary === null ? null : <p className="text-body-sm text-text-2">{summary}</p>}
          </div>
          <button
            type="button"
            data-testid="notifications-read-all"
            disabled={!readAllUsable}
            onClick={view.readAll}
            className={`${HEADER_BUTTON} max-md:h-touch max-md:border-0 max-md:bg-transparent max-md:px-2.5 max-md:font-bold max-md:text-primary-text max-md:disabled:text-disabled-text`}
          >
            <Icon name="done_all" size={20} className="max-md:hidden" />
            {kind === null ? t.t('notifications.readAll') : t.t('notifications.readAllKind', { kind: t.t(kindLabel(kind)) })}
          </button>
          {preferencesLive ? (
            <Link
              href={PREFERENCES_HREF}
              prefetch={false}
              className={`${HEADER_BUTTON} max-md:size-touch max-md:justify-center max-md:border-0 max-md:bg-transparent max-md:px-0 max-md:text-text-2`}
            >
              <Icon name="tune" size={20} className="max-md:text-icon-22" />
              <span className="max-md:sr-only">{t.t('notifications.preferences')}</span>
            </Link>
          ) : null}
        </div>

        <div className="flex items-start gap-5">
          {/* 1440: the 240px filter card (B). */}
          <aside className="hidden w-layout-filter-rail shrink-0 flex-col gap-4 rounded-lg border border-border bg-surface p-3 xl:flex">
            <div role="group" aria-label={t.t('notifications.filter.label')} className="flex flex-col gap-0.5">
              {showFilters.map((entry) => (
                <RailButton
                  key={entry.value}
                  tone="show"
                  icon={entry.icon}
                  label={entry.label}
                  on={filter === entry.value}
                  onClick={() => setFilter(entry.value)}
                  data={{ 'data-notifications-filter': entry.value }}
                />
              ))}
              {typesLive
                ? SHOW_PLACEHOLDERS.map((entry) => (
                    <RailButton key={entry.id} tone="show" icon={entry.icon} label={t.t(entry.label)} on={false} disabled soon={soon} data={{ 'data-notifications-placeholder': entry.id }} />
                  ))
                : null}
            </div>
            <div role="group" aria-labelledby="notifications-type-heading" className="flex flex-col gap-0.5 border-t border-border pt-3">
              <span id="notifications-type-heading" className="px-2.5 pb-1.5 text-caption font-bold uppercase tracking-wide text-text-2">
                {t.t('notifications.kind.label')}
              </span>
              <RailButton tone="type" icon="category" label={t.t('notifications.kind.all')} on={kind === null} onClick={() => setKind(null)} data={{ 'data-notifications-kind': 'all' }} />
              {types.map((entry) =>
                'kind' in entry ? (
                  <RailButton
                    key={entry.kind}
                    tone="type"
                    icon={entry.icon}
                    label={t.t(entry.label)}
                    on={kind === entry.kind}
                    onClick={() => setKind(entry.kind)}
                    data={{ 'data-notifications-kind': entry.kind }}
                  />
                ) : (
                  <RailButton key={entry.placeholder} tone="type" icon={entry.icon} label={t.t(entry.label)} on={false} disabled soon={soon} data={{ 'data-notifications-placeholder': entry.placeholder }} />
                ),
              )}
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {/* 1024 and phone: the same filters as pills (B at 1024, E2): Show on the left, Type after it. A phone scrolls the row sideways. */}
            <div className="flex items-center gap-x-3 gap-y-2 max-md:-mx-4 max-md:overflow-x-auto max-md:px-4 max-md:pb-1 md:flex-wrap xl:hidden">
              <div role="group" aria-label={t.t('notifications.filter.label')} className="flex shrink-0 gap-1.5 max-md:gap-2 md:flex-1 md:flex-wrap">
                {showFilters.map((entry) => (
                  <button key={entry.value} type="button" data-notifications-filter={entry.value} aria-pressed={filter === entry.value} onClick={() => setFilter(entry.value)} className={pill(filter === entry.value)}>
                    {entry.label}
                  </button>
                ))}
                {typesLive
                  ? SHOW_PLACEHOLDERS.map((entry) => (
                      <button key={entry.id} type="button" disabled data-notifications-placeholder={entry.id} className={pill(false)}>
                        {t.t(entry.label)}
                        <span className="sr-only">{soon}</span>
                      </button>
                    ))
                  : null}
              </div>
              <div role="group" aria-labelledby="notifications-type-pills" className="flex shrink-0 items-center gap-1.5 max-md:gap-2 md:flex-wrap">
                <span id="notifications-type-pills" className="text-meta font-semibold text-text-2 max-md:sr-only">
                  {t.t('notifications.kind.label')}
                </span>
                <button type="button" data-notifications-kind="all" aria-pressed={kind === null} onClick={() => setKind(null)} className={pill(kind === null)}>
                  {t.t('notifications.kind.all')}
                </button>
                {TYPE_ENTRIES.map((entry) =>
                  'kind' in entry ? (
                    <button key={entry.kind} type="button" data-notifications-kind={entry.kind} aria-pressed={kind === entry.kind} onClick={() => setKind(entry.kind)} className={pill(kind === entry.kind)}>
                      {t.t(entry.label)}
                    </button>
                  ) : null,
                )}
              </div>
            </div>

            <ViewStatus t={t} state={state} onRetry={state.items.length === 0 ? view.reload : view.loadMore} />

            {/* The list card (B): one bordered card of day groups; full bleed on a phone (E2). */}
            <div className="overflow-hidden bg-surface max-md:-mx-4 max-md:border-y max-md:border-border md:rounded-lg md:border md:border-border">
              {state.phase === 'loading' && state.listWaitUntil === null ? <LoadingNotifications t={t} size="page" /> : null}
              {emptyForever ? (
                <div data-testid="notifications-empty" className="flex flex-col items-center gap-2 px-6 py-14 text-center">
                  <span aria-hidden="true" className="flex size-14 items-center justify-center rounded-full bg-surface-sunken text-text-2">
                    <Icon name="notifications" size={28} />
                  </span>
                  <p className="text-sheet-title text-text">{t.t(filter === 'unread' ? 'notifications.empty.unreadTitle' : 'notifications.empty.title')}</p>
                  <p className="max-w-layout-column text-body-sm text-text-2">{t.t('notifications.empty.body')}</p>
                  {preferencesLive ? (
                    <Link href={PREFERENCES_HREF} prefetch={false} className={`mt-2 ${HEADER_BUTTON} px-4`}>
                      {t.t('notifications.preferences.set')}
                    </Link>
                  ) : null}
                </div>
              ) : null}
              <NotificationGroups
                items={state.items}
                headingLevel={2}
                final={state.nextCursor === null}
                size="page"
                t={t}
                locale={locale}
                live={liveObjectTypes(live)}
                busyIds={state.busyIds}
                allBusy={state.allBusy}
                onToggle={view.toggle}
                onOpen={view.open}
              />
              {state.nextCursor !== null ? (
                <div className="flex justify-center border-t border-border p-3">
                  <button
                    type="button"
                    data-testid="notifications-more"
                    disabled={state.loadingMore || waiting}
                    onClick={view.loadMore}
                    className={`${SECONDARY_BUTTON} disabled:cursor-not-allowed disabled:text-disabled-text`}
                  >
                    {t.t(state.loadingMore ? 'notifications.loading' : 'notifications.more')}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </CrmShell>
  );
}
