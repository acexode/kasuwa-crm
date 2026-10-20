'use client';

import { useCallback, useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../icon';
import { FOCUS } from '../records/list-classes';

/**
 * The modal P07's composer and reschedule form sit in. The three obligations
 * that get forgotten, as in the admin console's dialog: focus moves IN on
 * open, is RETURNED to the opener on close, and Tab is TRAPPED inside.
 * Escape closes; so does a press that starts on the backdrop itself.
 *
 * Nothing typed here is kept anywhere but this component's state (D-P21): a
 * draft does not outlive the dialog, and is never written to the device.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ActivityDialog({
  testId,
  title,
  closeLabel,
  onClose,
  children,
}: {
  testId: string;
  title: ReactNode;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    openerRef.current = document.activeElement;
    panelRef.current?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (panel === null) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <span aria-hidden="true" className="absolute inset-0 -z-10 bg-scrim" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        onKeyDown={onKeyDown}
        className={`flex max-h-full w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-t-lg bg-surface-raised p-4 shadow-3 sm:rounded-lg sm:p-6 ${FOCUS}`}
      >
        <div className="flex items-start gap-3">
          <h2 id={titleId} className="min-w-0 flex-1 text-h4 font-bold">
            {title}
          </h2>
          <button
            type="button"
            aria-label={closeLabel}
            onClick={onClose}
            className={`flex min-h-touch min-w-touch items-center justify-center rounded-md text-text-muted hover:bg-surface-sunken ${FOCUS}`}
          >
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
