'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { countServerSnapshot, countSnapshot, subscribeCount } from '../../lib/notification-store';
import { DROPDOWN_LIMIT, unreadIn } from '../../lib/notification-model';
import { isEmptyForever } from '../../lib/notification-view';
import { Icon } from '../icon';
import { FOCUS } from '../records/list-classes';
import { LoadingNotifications, NotificationGroups, ViewStatus } from './notification-list';
import { useNotificationView } from './use-notification-view';

/**
 * The bell's dropdown (P26 A, A1, A3): a labelled dialog over the latest
 * notifications, grouped by the reader's local day.
 *
 * LOADED ON FIRST OPEN. The bell reaches this module only through a dynamic
 * `import()`, so none of it is in any screen's first load.
 *
 * It reads the first page ONCE, when it opens, and never on a timer; closing it
 * (Escape, the close button, a press outside, or leaving the page) aborts a read
 * still in flight. Focus moves inside and is trapped; the bell takes it back on
 * close. Nothing is kept: the next opening reads afresh.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

function tabStops(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.tabIndex >= 0 && element.offsetParent !== null);
}

export function NotificationDropdown({
  t,
  locale,
  live,
  onClose,
}: {
  t: Translator;
  locale: string;
  /** The object types whose route is on here (`liveObjectTypes`). */
  live: readonly string[];
  onClose: (returnFocus: boolean) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const view = useNotificationView({ filter: 'all', kind: null, limit: DROPDOWN_LIMIT }, true);
  const { state } = view;
  const count = useSyncExternalStore(subscribeCount, countSnapshot, countServerSnapshot);

  useEffect(() => {
    closeRef.current?.focus();
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
  const countZero = !count.known || (count.count === 0 && !count.capped);
  // A3: nothing unread, by what is drawn and, when the count is known, by the count; or nothing at all.
  const caughtUp = state.phase === 'ready' && (isEmptyForever(state) || (unreadDrawn === 0 && countZero));

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="notifications-dropdown"
      onKeyDown={onKeyDown}
      className="fixed inset-x-2 bottom-2 top-16 z-40 flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-3 shadow-3 sm:absolute sm:inset-x-auto sm:bottom-auto sm:end-0 sm:top-full sm:mt-2 sm:w-96"
    >
      <div className="flex items-center gap-2">
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-h4 font-bold">
          {t.t('notifications.dropdown.title')}
        </h2>
        {state.phase === 'ready' && !caughtUp ? (
          <button
            type="button"
            data-testid="notifications-read-all"
            disabled={state.headId === null || state.allBusy}
            onClick={view.readAll}
            className={`flex min-h-touch items-center gap-2 rounded-md px-2 text-body-sm font-semibold text-primary-text hover:bg-surface-sunken disabled:text-text-muted ${FOCUS}`}
          >
            <Icon name="done_all" size="sm" />
            {t.t('notifications.readAll')}
          </button>
        ) : null}
        <button
          ref={closeRef}
          type="button"
          aria-label={t.t('notifications.dropdown.close')}
          onClick={() => onClose(true)}
          className={`flex min-h-touch min-w-touch items-center justify-center rounded-md text-text-muted hover:bg-surface-sunken ${FOCUS}`}
        >
          <Icon name="close" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto sm:max-h-96 sm:flex-none">
        <ViewStatus t={t} state={state} onRetry={view.reload} />
        {state.phase === 'loading' && state.listWaitUntil === null ? <LoadingNotifications t={t} /> : null}
        {caughtUp ? (
          <div data-testid="notifications-caught-up" className="flex flex-col items-center gap-1 p-4 text-center">
            <Icon name="task_alt" size="lg" className="text-success-text" />
            <p className="font-semibold">{t.t('notifications.caughtUp.title')}</p>
            <p className="text-body-sm text-text-2">{t.t('notifications.caughtUp.body')}</p>
          </div>
        ) : null}
        <NotificationGroups
          items={state.items}
          headingLevel={3}
          t={t}
          locale={locale}
          live={live}
          busyIds={state.busyIds}
          onToggle={view.toggle}
          onOpen={view.open}
        />
      </div>

      <Link
        href="/notifications"
        prefetch={false}
        onClick={() => onClose(false)}
        className={`flex min-h-touch items-center justify-center gap-2 rounded-md border border-border text-body-sm font-semibold text-primary-text hover:bg-surface-sunken ${FOCUS}`}
      >
        {t.t('notifications.viewAll')}
        <Icon name="arrow_forward" size="sm" />
      </Link>
    </div>
  );
}
