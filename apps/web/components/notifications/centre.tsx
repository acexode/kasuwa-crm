'use client';

import { useState, useSyncExternalStore } from 'react';
import { createBundleTranslator, type MessageBundle } from '@kasuwa/i18n/bundle';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { liveObjectTypes } from '../../lib/notification-href';
import { CENTRE_LIMIT, unreadIn } from '../../lib/notification-model';
import { countServerSnapshot, countSnapshot, subscribeCount } from '../../lib/notification-store';
import { isEmptyForever } from '../../lib/notification-view';
import { NOTIFICATION_KINDS, type NotificationFilter, type NotificationKind } from '../../lib/notifications-api';
import { Icon } from '../icon';
import { CHIP, CHIP_OFF, CHIP_ON, FOCUS } from '../records/list-classes';
import { kindLabel } from './message-ids';
import { LoadingNotifications, NotificationGroups, ViewStatus } from './notification-list';
import { useNotificationView } from './use-notification-view';

/**
 * `P26` frames B and B2 — the notification centre at `/notifications`, in the
 * CRM shell: unread or all, one kind or all kinds, in day groups, paged by the
 * cursor exactly as served.
 *
 * Absent on purpose (C2-C4): per-type counts on the tabs and an exact unread
 * total (the count is capped at 99 and per-kind counts are not served), "clear
 * the noisiest type", titles and bodies, inline approvals and the preferences
 * link (a 404). The one-tap clear is the kind filter's own "mark all read".
 */
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

  const waiting = state.listWaitUntil !== null || state.writeWaitUntil !== null;
  const anyUnreadElsewhere = kind === null && count.known && (count.count > 0 || count.capped);
  const canReadAll = state.phase === 'ready' && state.headId !== null && !state.allBusy && (unreadIn(state.items, kind) > 0 || anyUnreadElsewhere);

  const chip = (on: boolean) => `${CHIP} ${on ? CHIP_ON : CHIP_OFF}`;

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="notifications" live={live}>
      <div data-screen="P26" className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 flex-1 text-h2">{t.t('notifications.title')}</h1>
          <button
            type="button"
            data-testid="notifications-read-all"
            disabled={!canReadAll}
            onClick={view.readAll}
            className={`flex min-h-touch items-center gap-2 rounded-md px-3 text-body-sm font-semibold text-primary-text hover:bg-surface-sunken disabled:text-text-muted ${FOCUS}`}
          >
            <Icon name="done_all" size="sm" />
            {kind === null ? t.t('notifications.readAll') : t.t('notifications.readAllKind', { kind: t.t(kindLabel(kind)) })}
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <div role="group" aria-label={t.t('notifications.filter.label')} className="flex flex-wrap gap-2">
            {(['all', 'unread'] as const).map((value) => (
              <button key={value} type="button" data-notifications-filter={value} aria-pressed={filter === value} onClick={() => setFilter(value)} className={chip(filter === value)}>
                {t.t(value === 'all' ? 'notifications.filter.all' : 'notifications.filter.unread')}
              </button>
            ))}
          </div>
          <div role="group" aria-label={t.t('notifications.kind.label')} className="flex flex-wrap gap-2">
            <button type="button" data-notifications-kind="all" aria-pressed={kind === null} onClick={() => setKind(null)} className={chip(kind === null)}>
              {t.t('notifications.kind.all')}
            </button>
            {NOTIFICATION_KINDS.map((value) => (
              <button key={value} type="button" data-notifications-kind={value} aria-pressed={kind === value} onClick={() => setKind(value)} className={chip(kind === value)}>
                {t.t(kindLabel(value))}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <ViewStatus t={t} state={state} onRetry={state.items.length === 0 ? view.reload : view.loadMore} />
          {state.phase === 'loading' && state.listWaitUntil === null ? <LoadingNotifications t={t} /> : null}
          {isEmptyForever(state) ? (
            <div data-testid="notifications-empty" className="flex flex-col items-center gap-1 rounded-lg border border-border bg-surface p-6 text-center">
              <Icon name="inbox" size="xl" className="text-text-muted" />
              <p className="text-h4 font-bold">{t.t(filter === 'unread' ? 'notifications.empty.unreadTitle' : 'notifications.empty.title')}</p>
              <p className="text-body-sm text-text-2">{t.t('notifications.empty.body')}</p>
            </div>
          ) : null}
          <NotificationGroups
            items={state.items}
            headingLevel={2}
            t={t}
            locale={locale}
            live={liveObjectTypes(live)}
            busyIds={state.busyIds}
            onToggle={view.toggle}
            onOpen={view.open}
          />
          {state.nextCursor !== null ? (
            <button
              type="button"
              data-testid="notifications-more"
              disabled={state.loadingMore || waiting}
              onClick={view.loadMore}
              className={`flex min-h-touch items-center justify-center rounded-md border border-border bg-surface px-4 text-body-sm font-semibold text-primary-text hover:bg-surface-sunken disabled:text-text-muted ${FOCUS}`}
            >
              {t.t(state.loadingMore ? 'notifications.loading' : 'notifications.more')}
            </button>
          ) : null}
        </div>
      </div>
    </CrmShell>
  );
}
