'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { countServerSnapshot, countSnapshot, subscribeCount } from '../../lib/notification-store';
import { DROPDOWN_LIMIT, unreadIn } from '../../lib/notification-model';
import { isEmptyForever } from '../../lib/notification-view';
import { canReadAll } from '../../lib/notification-writes';
import type { NotificationFilter } from '../../lib/notifications-api';
import { Icon } from '../icon';
import { FOCUS, PILL, PILL_OFF, PILL_ON, PILL_SIZE_SMALL, SMALL_BUTTON, TEXT_BUTTON } from './classes';
import { inertOutside } from './inert-outside';
import { PREFERENCES_HREF, SHOW_PLACEHOLDERS } from './kinds';
import { LoadingNotifications, NotificationGroups, ViewStatus } from './notification-list';
import { useNotificationView } from './use-notification-view';

/**
 * The bell's dropdown (P26 A, A1, A3), drawn to the export by T-0137: a 440px
 * panel anchored under the top bar at the inline end, radius 14, shadow-3.
 * A header (Notifications, the unread count, Mark all read and the
 * preferences gear), a row of filter pills, the day groups, and a footer link
 * to the centre. No close button: Escape, a press outside or the bell close it.
 *
 * Not the T-0129 `Popover`: that is a non-modal panel, and this one is a modal
 * dialog that traps focus and makes the page inert (T-0101 I8, N13).
 *
 * LOADED ON FIRST OPEN. The bell reaches this module only through a dynamic
 * `import()`, so none of it is in any screen's first load.
 *
 * It reads the first page ONCE when it opens, and again only when the reader
 * picks another pill; never on a timer. Closing it (Escape, a press outside,
 * or leaving the page) aborts a read still in flight. Focus moves inside and
 * is trapped; the bell takes it back on close. Nothing is kept: the next
 * opening reads afresh.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

function tabStops(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.tabIndex >= 0 && element.offsetParent !== null);
}

/** What the bell knows of the P26 placeholders this process draws (D-L194). */
export interface DropdownExtras {
  readonly types: boolean;
  readonly preferences: boolean;
}

export function NotificationDropdown({
  t,
  locale,
  live,
  extras,
  onClose,
}: {
  t: Translator;
  locale: string;
  /** The object types whose route is on here (`liveObjectTypes`). */
  live: readonly string[];
  extras: DropdownExtras;
  onClose: (returnFocus: boolean) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const view = useNotificationView({ filter, kind: null, limit: DROPDOWN_LIMIT }, true);
  const { state } = view;
  const count = useSyncExternalStore(subscribeCount, countSnapshot, countServerSnapshot);

  // A modal dialog: the page behind it neither takes focus nor is read, until it closes (N13).
  useEffect(() => {
    const panel = panelRef.current;
    const undo = panel === null ? undefined : inertOutside(panel);
    if (panel !== null) tabStops(panel)[0]?.focus();
    return undo;
  }, []);

  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      onClose(true);
    };
    const onPress = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || panelRef.current?.contains(target)) return;
      // The bell's own button toggles; it is not "outside".
      if (target instanceof Element && target.closest('[data-testid="notifications-bell"]') !== null) return;
      onClose(false);
    };
    document.addEventListener('keydown', onEscape);
    document.addEventListener('mousedown', onPress);
    return () => {
      document.removeEventListener('keydown', onEscape);
      document.removeEventListener('mousedown', onPress);
    };
  }, [onClose]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (panel === null) return;
    const stops = tabStops(panel);
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    const inside = panel.contains(document.activeElement);
    if (event.shiftKey && (!inside || document.activeElement === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!inside || document.activeElement === last)) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const unreadDrawn = unreadIn(state.items, null);
  // A3 only when the count is KNOWN to be zero and nothing drawn is unread (N14): an unknown count
  // (the poll has not answered, or is failing) says nothing, and "all caught up" would be a guess.
  const countZero = count.known && count.count === 0 && !count.capped;
  const caughtUp = state.phase === 'ready' && unreadDrawn === 0 && countZero;
  const nothingAtAll = isEmptyForever(state) && !caughtUp;
  const readAllUsable = state.phase === 'ready' && !caughtUp && canReadAll(state, Date.now());
  const unreadLabel = !count.known || countZero ? null : count.capped ? t.t('notifications.unreadCapped', { count: count.count }) : t.t('notifications.unreadCount', { count: count.count });
  const pill = (on: boolean) => `${PILL} ${PILL_SIZE_SMALL} ${on ? PILL_ON : PILL_OFF}`;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="notifications-dropdown"
      onKeyDown={onKeyDown}
      className="fixed inset-x-2 top-14 z-40 flex max-h-overlay-notification-panel-max-height flex-col rounded-14 border border-border bg-surface text-text shadow-3 animate-fade-in md:inset-x-auto md:end-3 md:w-overlay-notification-panel"
    >
      {/* Header (A): the title and count, Mark all read, the preferences gear. */}
      <div className="flex items-center gap-2 pb-2 pe-2 ps-4 pt-3">
        <h2 id={titleId} className="shrink-0 text-card-title leading-6">
          {t.t('notifications.dropdown.title')}
        </h2>
        {unreadLabel === null ? null : <span className="min-w-0 truncate text-meta text-text-muted">{unreadLabel}</span>}
        <span className="flex-1" />
        <button type="button" data-testid="notifications-read-all" disabled={!readAllUsable} onClick={view.readAll} className={`${TEXT_BUTTON} h-control-xs px-2 text-meta`}>
          {t.t('notifications.readAll')}
        </button>
        {extras.preferences ? (
          <Link
            href={PREFERENCES_HREF}
            prefetch={false}
            aria-label={t.t('notifications.preferences.label')}
            onClick={() => onClose(false)}
            className={`flex size-control-sm shrink-0 items-center justify-center rounded-md text-text-2 is-hover:bg-surface-sunken ${FOCUS}`}
          >
            <Icon name="settings" size={20} />
          </Link>
        ) : null}
      </div>

      {/* The filter pills (A): All and Unread; Mentions and Approvals disabled until something produces them. */}
      <div role="group" aria-label={t.t('notifications.filter.label')} className="flex gap-1.5 overflow-x-auto border-b border-border px-4 pb-2.5">
        {(['all', 'unread'] as const).map((value) => (
          <button key={value} type="button" data-notifications-filter={value} aria-pressed={filter === value} onClick={() => setFilter(value)} className={pill(filter === value)}>
            {t.t(value === 'all' ? 'notifications.filter.all' : 'notifications.filter.unread')}
          </button>
        ))}
        {extras.types
          ? SHOW_PLACEHOLDERS.map((entry) => (
              <button key={entry.id} type="button" disabled data-notifications-placeholder={entry.id} className={pill(false)}>
                {t.t(entry.label)}
                <span className="sr-only">{t.t('records.nav.soon')}</span>
              </button>
            ))
          : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex flex-col gap-2 p-2 empty:hidden">
          <ViewStatus t={t} state={state} onRetry={view.reload} />
        </div>
        {state.phase === 'loading' && state.listWaitUntil === null ? <LoadingNotifications t={t} size="panel" /> : null}
        {caughtUp ? (
          <div data-testid="notifications-caught-up" className="flex flex-col items-center gap-2 px-6 pb-8 pt-10 text-center">
            <span aria-hidden="true" className="flex size-touch items-center justify-center rounded-full bg-surface-sunken text-text-2">
              <Icon name="done_all" size={28} />
            </span>
            <p className="text-card-title">{t.t('notifications.caughtUp.title')}</p>
            <p className="max-w-layout-column text-meta text-text-2">{t.t('notifications.caughtUp.body')}</p>
            {filter === 'unread' ? (
              <button type="button" onClick={() => setFilter('all')} className={`mt-1.5 ${SMALL_BUTTON}`}>
                {t.t('notifications.caughtUp.showAll')}
              </button>
            ) : null}
          </div>
        ) : null}
        {nothingAtAll ? (
          <div className="flex flex-col items-center gap-2 px-6 pb-8 pt-10 text-center">
            <span aria-hidden="true" className="flex size-touch items-center justify-center rounded-full bg-surface-sunken text-text-2">
              <Icon name="notifications" size={28} />
            </span>
            <p className="text-card-title">{t.t('notifications.empty.title')}</p>
            <p className="max-w-layout-column text-meta text-text-2">{t.t('notifications.empty.body')}</p>
          </div>
        ) : null}
        <NotificationGroups
          items={state.items}
          headingLevel={3}
          final={state.nextCursor === null}
          size="panel"
          t={t}
          locale={locale}
          live={live}
          busyIds={state.busyIds}
          allBusy={state.allBusy}
          onToggle={view.toggle}
          onOpen={view.open}
        />
      </div>

      {/* Footer (A): a centred text link to the centre, over a divider. */}
      <div className="flex border-t border-border p-2 ps-3">
        <Link
          href="/notifications"
          prefetch={false}
          onClick={() => onClose(false)}
          className={`flex h-control-md flex-1 items-center justify-center gap-1.5 rounded-md text-meta font-bold text-primary-text is-hover:bg-primary-soft ${FOCUS}`}
        >
          {t.t('notifications.viewAll')}
          <Icon name="arrow_forward" size={18} className="rtl:-scale-x-100" />
        </Link>
      </div>
    </div>
  );
}
