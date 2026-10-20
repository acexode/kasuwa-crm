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

export type DialogSize = 'dialog' | 'sheet' | 'prompt';

/**
 * Sizes, as P06 draws them. `sheet` (the move sheet, P06/09's bottom sheet):
 * a 20px-radius sheet with a grab handle on a phone, a 448px dialog from `sm`.
 * `prompt` ("Complete to move", P06/05 and P06/06): full screen on a phone,
 * 560px with a 16px radius from `sm`. `dialog` (the create form): a sheet on a
 * phone, 512px from `sm`.
 */
const PANEL_SIZE: Record<DialogSize, string> = {
  dialog: 'max-h-full rounded-t-xl sm:max-w-lg sm:rounded-xl',
  sheet: 'max-h-full rounded-t-[20px] sm:max-w-md sm:rounded-xl',
  prompt: 'h-full max-h-full sm:h-auto sm:max-w-[560px] sm:rounded-xl',
};

export function PipelineDialog({
  testId,
  title,
  subtitle,
  closeLabel,
  busy = false,
  onClose,
  children,
  footer,
  size = 'dialog',
}: {
  testId: string;
  title: ReactNode;
  subtitle?: ReactNode;
  closeLabel: string;
  /** A write is in flight: Escape and the backdrop do not close it, so its answer has somewhere to land. */
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  /** A footer bar under a scrolling body, P06/05's "4 left · Cancel · Move". */
  footer?: ReactNode;
  size?: DialogSize;
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
      className={`fixed inset-0 z-50 flex justify-center sm:items-center sm:p-6 ${size === 'prompt' ? 'items-stretch' : 'items-end'}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
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
        className={`flex w-full min-h-0 flex-col overflow-hidden bg-surface-raised shadow-3 ${PANEL_SIZE[size]} ${FOCUS}`}
      >
        {size === 'sheet' ? <span aria-hidden="true" className="mx-auto mb-0.5 mt-2 h-1 w-10 shrink-0 rounded-sm bg-border-strong sm:hidden" /> : null}
        <div className={`flex shrink-0 items-start gap-2 pe-2 ps-5 ${size === 'sheet' ? 'pb-2 pt-2 sm:border-b sm:border-border sm:pb-3 sm:pt-3.5' : 'border-b border-border pb-3 pt-3.5'}`}>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id={titleId} className="break-words text-h5 font-bold">
              {title}
            </h2>
            {subtitle === undefined ? null : <div className="min-w-0 break-words text-meta text-text-2">{subtitle}</div>}
          </div>
          <button
            type="button"
            aria-label={closeLabel}
            // Not while a write is in flight: its answer must land somewhere (as Escape and the backdrop).
            disabled={busy}
            onClick={onClose}
            className={`flex size-touch shrink-0 items-center justify-center rounded-md text-text hover:bg-surface-sunken disabled:cursor-not-allowed disabled:text-disabled-text ${FOCUS}`}
          >
            <Icon name="close" size={22} />
          </button>
        </div>
        <div className={`flex min-h-0 flex-1 flex-col overflow-y-auto ${size === 'sheet' ? 'gap-1 px-2 pb-4 sm:px-3 sm:pt-2' : 'gap-4.5 px-5 py-4'}`}>{children}</div>
        {footer === undefined ? null : (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-5 pb-4 pt-3">{footer}</div>
        )}
      </div>
    </div>
  );
}
