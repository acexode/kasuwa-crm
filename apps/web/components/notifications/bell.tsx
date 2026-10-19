'use client';

import { Suspense, lazy, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ComponentType, type LazyExoticComponent } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { badgeLabel, isRise } from '../../lib/notification-count';
import { liveObjectTypes } from '../../lib/notification-href';
import { countServerSnapshot, countSnapshot, subscribeCount } from '../../lib/notification-store';
import { Icon } from '../icon';
import { FOCUS } from '../records/list-classes';

/**
 * The notifications bell (P26 A, A1), drawn in the CRM shell and the admin
 * console wherever the notifications flag is live.
 *
 * WHAT IT COSTS EVERY SCREEN, AND NOTHING MORE. This module, the shared count
 * store and the poller are in every shell's first load; the dropdown, its rows
 * and the centre are not (a dynamic `import()` on the first open), so a reader
 * who never opens the bell never pays for them (I21).
 *
 * THE BADGE IS NOT A LIVE REGION: the bell's accessible name carries the count,
 * so a poll every 45 seconds reads nothing out. A RISE in the count is the one
 * thing said aloud, politely, from a region that exists before its first
 * message (a region added with its text is often not read).
 */

interface DropdownProps {
  t: Translator;
  locale: string;
  live: readonly string[];
  onClose: (returnFocus: boolean) => void;
}

/** The dropdown's code, loaded on the first open only. A chunk that never arrives resolves to a small failed panel, and a retry makes a fresh loader (`lazy` remembers what it resolved to). */
function loadDropdown(): LazyExoticComponent<ComponentType<DropdownProps>> {
  return lazy(() =>
    import('./dropdown').then(
      (module): { default: ComponentType<DropdownProps> } => ({ default: module.NotificationDropdown }),
      (): { default: ComponentType<DropdownProps> } => ({ default: DropdownFailed }),
    ),
  );
}

function DropdownFailed({ t, onClose }: DropdownProps) {
  const titleId = useId();
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="notifications-dropdown"
      className="fixed inset-x-2 top-16 z-40 flex flex-col items-start gap-2 rounded-lg border border-border bg-surface-raised p-3 shadow-3 sm:absolute sm:inset-x-auto sm:end-0 sm:top-full sm:mt-2 sm:w-96"
    >
      <h2 id={titleId} className="text-h4 font-bold">
        {t.t('notifications.error.title')}
      </h2>
      <button ref={ref} type="button" onClick={() => onClose(true)} className={`flex min-h-touch items-center rounded-md px-3 text-body-sm font-semibold text-primary-text hover:bg-surface-sunken ${FOCUS}`}>
        {t.t('notifications.dropdown.close')}
      </button>
    </div>
  );
}

export function NotificationBell({ t, locale, live }: { t: Translator; locale: string; live: readonly string[] }) {
  const count = useSyncExternalStore(subscribeCount, countSnapshot, countServerSnapshot);
  const [open, setOpen] = useState(false);
  const [Dropdown, setDropdown] = useState<LazyExoticComponent<ComponentType<DropdownProps>> | null>(null);
  const [said, setSaid] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const previous = useRef(count);

  // A rise is announced once; the first count, an unchanged one and a fall are not (a fall clears the region so the next rise is heard again).
  useEffect(() => {
    const before = previous.current;
    if (before === count) return;
    previous.current = count;
    if (!isRise(before, count)) {
      setSaid('');
      return;
    }
    setSaid(count.capped ? t.t('notifications.announce.riseCapped', { count: count.count }) : t.t('notifications.announce.rise', { count: count.count }));
  }, [count, t]);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  const badge = badgeLabel(count);
  const label = count.capped
    ? t.t('notifications.bell.labelCapped', { count: count.count })
    : badge === ''
      ? t.t('notifications.bell.label')
      : t.t('notifications.bell.labelCount', { count: count.count });

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        data-testid="notifications-bell"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        onClick={() => {
          if (open) {
            close(false);
            return;
          }
          // `lazy` returns an object, not a function, so React stores it rather than calling it.
          setDropdown((current: LazyExoticComponent<ComponentType<DropdownProps>> | null) => current ?? loadDropdown());
          setOpen(true);
        }}
        className={`relative flex min-h-touch min-w-touch items-center justify-center rounded-md border border-border bg-surface text-text hover:bg-surface-sunken ${FOCUS}`}
      >
        <Icon name="notifications" size="sm" />
        {badge === '' ? null : (
          <span
            aria-hidden="true"
            data-testid="notifications-badge"
            className="absolute -end-1 -top-1 flex min-w-5 items-center justify-center rounded-full bg-danger px-1 text-caption font-bold text-on-primary"
          >
            {badge}
          </span>
        )}
      </button>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {said}
      </span>
      {open && Dropdown !== null ? (
        <Suspense fallback={null}>
          <Dropdown t={t} locale={locale} live={liveObjectTypes(live)} onClose={close} />
        </Suspense>
      ) : null}
    </div>
  );
}
