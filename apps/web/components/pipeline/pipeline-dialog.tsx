'use client';

import { useCallback, useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../icon';
import { FOCUS } from '../records/list-classes';

/**
 * The modal the P06 move sheet, requirement prompt and create form sit in: a
 * bottom sheet at 360 px, a centred dialog from `sm` up. The obligations that
 * get forgotten: focus moves IN on open, is RETURNED to the opener on close
 * (the screen re-finds a moved card's control, whose old element is gone), and
 * Tab is TRAPPED inside, and the screen behind is inert while it is open.
 * Escape, the close button and a press on the backdrop all close it, except
 * while a write is in flight: a write's answer always lands.
 *
 * Rendered INSIDE the screen root, never portalled, so a refusal it carries
 * is still the screen's own alert. Nothing typed here outlives it (D-P21).
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function PipelineDialog({
  testId,
  title,
  subtitle,
  closeLabel,
  busy = false,
  onClose,
  children,
}: {
  testId: string;
  title: ReactNode;
  subtitle?: ReactNode;
  closeLabel: string;
  /** A write is in flight: Escape and the backdrop do not close it, so its answer has somewhere to land. */
  busy?: boolean;
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

  // Escape closes from anywhere while the dialog is open: a control that was
  // focused and then disabled (a confirm button while it sends) hands focus
  // to the page, and the dialog must still close from the keyboard. Not while
  // a write is in flight, not while an input method is composing, and not when
  // a control inside already used the key (the picker clearing its search).
  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || busy || event.isComposing || event.defaultPrevented) return;
      onClose();
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [busy, onClose]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
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
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <span aria-hidden="true" className="absolute inset-0 -z-10 bg-inverse opacity-60" />
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
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 id={titleId} className="text-h4 font-bold">
              {title}
            </h2>
            {subtitle === undefined ? null : <div className="min-w-0 break-words text-body-sm text-text-2">{subtitle}</div>}
          </div>
          <button
            type="button"
            aria-label={closeLabel}
            // Not while a write is in flight: its answer must land somewhere (as Escape and the backdrop).
            disabled={busy}
            onClick={onClose}
            className={`flex min-h-touch min-w-touch items-center justify-center rounded-md text-text-muted hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`}
          >
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
