'use client';

import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from '../icon';
import type { IconName } from '@kasuwa/ui';

/**
 * A modal dialog, with the three accessibility obligations that get forgotten.
 *
 *   1. Focus MOVES IN on open, to the dialog itself, so a screen-reader user is
 *      told what appeared instead of continuing to read the page behind it.
 *   2. Focus is RETURNED on close, to the control that opened it. Without this
 *      a keyboard user lands back at the top of the document and has to walk
 *      the whole table again to reach the next row's delete button.
 *   3. Tab is TRAPPED. A dialog you can tab out of is a dialog a keyboard user
 *      cannot tell they are still in.
 *
 * Escape closes, and so does the backdrop — but only on `mousedown` inside the
 * backdrop itself, or a drag that starts on the panel and ends on the backdrop
 * closes a destructive dialog by accident.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type DialogTone = 'danger' | 'warning' | 'info';

const TONE_CLASS: Readonly<Record<DialogTone, string>> = {
  danger: 'bg-danger-soft text-danger-text',
  warning: 'bg-warning-soft text-warning-text',
  info: 'bg-info-soft text-info-text',
};

export function Dialog({
  title,
  body,
  icon,
  tone,
  closeLabel,
  onClose,
  children,
  footer,
  testId,
}: {
  title: string;
  body?: string;
  icon: IconName;
  tone: DialogTone;
  closeLabel: string;
  onClose: () => void;
  children?: ReactNode;
  footer: ReactNode;
  testId?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    openerRef.current = document.activeElement;
    panelRef.current?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && document.contains(opener)) {
        opener.focus();
      }
    };
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (panel === null) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;

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
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* The scrim is its own element so the panel is not dimmed with it.
          `inverse` is the design system's dark surface; there is no scrim
          token and inventing a colour here is exactly what lint forbids. */}
      <span aria-hidden="true" className="absolute inset-0 -z-10 bg-inverse opacity-60" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        onKeyDown={onKeyDown}
        className="flex max-h-full w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-lg bg-surface-raised p-6 shadow-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <div className="flex items-start gap-4">
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${TONE_CLASS[tone]}`}
          >
            <Icon name={icon} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <h2 id={titleId} className="text-h4 font-bold">
              {title}
            </h2>
            {body === undefined ? null : <p className="text-body-sm text-text-2">{body}</p>}
          </div>
          <button
            type="button"
            aria-label={closeLabel}
            onClick={onClose}
            className="flex min-h-touch min-w-touch items-center justify-center rounded-md text-text-muted hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <Icon name="close" />
          </button>
        </div>
        {children}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">{footer}</div>
      </div>
    </div>
  );
}
