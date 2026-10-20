'use client';

import { useId, useState, type ReactNode, type RefObject } from 'react';
import type { IconName } from '../icons.generated';
import { cx } from './class-names';
import { Glyph } from './glyph';
import { useOverlay, useScrollEdges } from './overlay';
import { Portal } from './portal';

/**
 * Dialogs, to the v1.1 Components ("F · Feedback & overlays") and Patterns
 * ("J · Drawers & modals") pages.
 *
 *   Dialog         radius 14, surface-raised, shadow-3 over the scrim; 440px
 *                  for a form, 640px for a wide one; at most 85vh. A fixed
 *                  60px header (title 18/700, a 44px close) and a fixed footer
 *                  (12px 20px, actions at the end); only the body scrolls.
 *                  The header divider shows once the body has scrolled, the
 *                  footer shadow while content remains below.
 *                  On a phone it is full screen: a 56px bar with a 48px close
 *                  first and a 17/700 title, and one full-width 52px primary
 *                  at the bottom (the close button is the way out, so the
 *                  secondary action is dropped).
 *   ConfirmDialog  360px, padding 22: a 40px icon disc (danger-soft for a
 *                  destructive confirm), an 18/700 title, one sentence in
 *                  text-2, and the actions at the end. Focus starts on the
 *                  first action, which is the safe one ("Keep").
 *
 * Both are modal: Esc, the close button and a scrim press dismiss; focus is
 * trapped, the page behind is inert and scroll-locked, and focus returns to
 * the trigger on close.
 */

export interface CloseButtonProps {
  readonly label: string;
  readonly onClick: VoidFunction;
  /** `bar` is the phone's 48px close with a 24px glyph. */
  readonly className?: string | undefined;
}

/** The overlays' close button: 44px with a 22px glyph, ghost. */
export function OverlayCloseButton({ label, onClick, className }: CloseButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cx(
        'inline-flex size-control-base shrink-0 items-center justify-center rounded-md text-text transition-colors duration-instant is-hover:bg-surface-sunken is-focus-visible:ring-focus',
        className,
      )}
    >
      <Glyph name="close" size={22} className="max-sm:text-icon-24" />
    </button>
  );
}

export type DialogSize = 'form' | 'wide';

const WIDTH: Record<DialogSize, string> = {
  form: 'sm:max-w-overlay-dialog-form',
  wide: 'sm:max-w-overlay-dialog-wide',
};

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: VoidFunction;
  readonly title: ReactNode;
  /** One sentence above the fields, in text-2. */
  readonly description?: ReactNode | undefined;
  readonly children?: ReactNode | undefined;
  /** The primary button. On a phone it becomes the full-width 52px action. */
  readonly primaryAction?: ReactNode | undefined;
  /** The secondary button (Cancel). Hidden on a phone, where close is first. */
  readonly secondaryAction?: ReactNode | undefined;
  /** The close button's accessible name ("Close"). */
  readonly closeLabel: string;
  readonly size?: DialogSize | undefined;
  /** What to focus on open, instead of the first field. */
  readonly initialFocus?: RefObject<HTMLElement | null> | undefined;
  /**
   * Draw it in place, inside a positioned frame, with no portal, focus trap
   * or scroll lock: the /design/components-2 gallery's specimens.
   */
  readonly preview?: boolean | undefined;
}

/** A portal for a live overlay; the children as they are for a preview. */
export function OverlayLayer({
  preview,
  children,
}: {
  readonly preview: boolean;
  readonly children: ReactNode;
}) {
  return preview ? children : <Portal>{children}</Portal>;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  primaryAction,
  secondaryAction,
  closeLabel,
  size = 'form',
  initialFocus,
  preview = false,
}: DialogProps) {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const titleId = useId();
  const { bodyRef, scrolled, more } = useScrollEdges(open && panel !== null);
  useOverlay({ open: open && !preview, onClose, panel, modal: true, initialFocus });

  if (!open) return null;
  const hasFooter = primaryAction !== undefined || secondaryAction !== undefined;

  return (
    <OverlayLayer preview={preview}>
      <div
        className={cx(
          'inset-0 flex items-center justify-center p-6 max-sm:p-0',
          preview ? 'absolute' : 'fixed z-50',
        )}
      >
        <div aria-hidden="true" onClick={onClose} className="absolute inset-0 animate-fade-in bg-scrim" />
        <div
          ref={setPanel}
          role="dialog"
          aria-modal={preview ? undefined : 'true'}
          aria-labelledby={titleId}
          tabIndex={-1}
          className={cx(
            'relative flex w-full min-h-0 flex-col overflow-hidden bg-surface-raised text-text shadow-3 outline-none',
            preview ? 'h-full sm:h-auto sm:max-h-full sm:rounded-14' : 'h-full sm:h-auto sm:max-h-[85vh] sm:rounded-14',
            WIDTH[size],
            !preview && 'animate-pop-in',
          )}
        >
          <div
            className={cx(
              'flex shrink-0 items-center gap-1 border-b p-1 transition-colors duration-quick',
              'min-h-shell-mobile-header sm:min-h-shell-header sm:gap-2 sm:py-2 sm:pe-2 sm:ps-5',
              scrolled ? 'border-border' : 'border-transparent',
            )}
          >
            <h2
              id={titleId}
              className="m-0 min-w-0 flex-1 text-sheet-title text-text sm:text-h5 sm:font-bold"
            >
              {title}
            </h2>
            <OverlayCloseButton
              label={closeLabel}
              onClick={onClose}
              className="max-sm:order-first max-sm:size-control-lg"
            />
          </div>
          <div
            ref={bodyRef}
            data-k-overlay-body=""
            className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-4 sm:px-5 sm:py-4"
          >
            {description === undefined ? null : (
              <p className="m-0 text-body-relaxed text-text-2">{description}</p>
            )}
            {children}
          </div>
          {hasFooter ? (
            <div
              className={cx(
                'flex shrink-0 justify-end gap-2 border-t border-border px-4 pb-4 pt-3 sm:px-5 sm:py-3',
                more && 'shadow-scroll-edge',
              )}
            >
              {secondaryAction === undefined ? null : (
                <span className="flex max-sm:hidden">{secondaryAction}</span>
              )}
              {primaryAction === undefined ? null : (
                <span className="flex max-sm:flex-1 max-sm:[&>*]:h-control-xl max-sm:[&>*]:w-full max-sm:[&>*]:rounded-10 max-sm:[&>*]:text-body-md max-sm:[&>*]:font-bold">
                  {primaryAction}
                </span>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </OverlayLayer>
  );
}

export type ConfirmTone = 'danger' | 'primary' | 'warning';

const DISC: Record<ConfirmTone, string> = {
  danger: 'bg-danger-soft text-danger-text',
  primary: 'bg-primary-soft text-primary-text',
  warning: 'bg-warning-soft text-warning-text',
};

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onClose: VoidFunction;
  readonly title: ReactNode;
  readonly description?: ReactNode | undefined;
  /** The 40px disc's glyph: `delete` for a destructive confirm. */
  readonly icon?: IconName | undefined;
  readonly tone?: ConfirmTone | undefined;
  /** The actions, safe one first ("Keep", then "Delete 3"). */
  readonly actions: ReactNode;
  readonly initialFocus?: RefObject<HTMLElement | null> | undefined;
}

export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  icon,
  tone = 'danger',
  actions,
  initialFocus,
}: ConfirmDialogProps) {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const titleId = useId();
  const bodyId = useId();
  useOverlay({ open, onClose, panel, modal: true, initialFocus });

  if (!open) return null;
  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
        <div aria-hidden="true" onClick={onClose} className="absolute inset-0 animate-fade-in bg-scrim" />
        <ConfirmPanel
          ref={setPanel}
          titleId={titleId}
          bodyId={bodyId}
          title={title}
          description={description}
          icon={icon}
          tone={tone}
          actions={actions}
          role="alertdialog"
        />
      </div>
    </Portal>
  );
}

interface ConfirmPanelProps {
  readonly ref?: { (node: HTMLDivElement | null): void } | undefined;
  readonly titleId: string;
  readonly bodyId: string;
  readonly title: ReactNode;
  readonly description?: ReactNode | undefined;
  readonly icon?: IconName | undefined;
  readonly tone: ConfirmTone;
  readonly actions: ReactNode;
  readonly role: 'alertdialog' | 'group';
}

/**
 * The confirm dialog's panel. Exported for the gallery, which draws it in
 * place over a scrim tile the way the v1.1 Components page does.
 */
export function ConfirmPanel({
  ref,
  titleId,
  bodyId,
  title,
  description,
  icon,
  tone,
  actions,
  role,
}: ConfirmPanelProps) {
  return (
    <div
      ref={ref}
      role={role}
      aria-modal={role === 'alertdialog' ? 'true' : undefined}
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : bodyId}
      tabIndex={-1}
      className="relative flex w-full max-w-overlay-dialog-confirm animate-pop-in flex-col gap-3 rounded-14 bg-surface-raised p-5.5 text-text shadow-3 outline-none"
    >
      <div className="flex items-start gap-3">
        {icon === undefined ? null : (
          <span
            aria-hidden="true"
            className={cx('flex size-10 shrink-0 items-center justify-center rounded-full', DISC[tone])}
          >
            <Glyph name={icon} size={22} />
          </span>
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={titleId} className="m-0 text-h5 font-bold">
            {title}
          </h2>
          {description === undefined ? null : (
            <p id={bodyId} className="m-0 text-body-sm text-text-2">
              {description}
            </p>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap justify-end gap-2">{actions}</div>
    </div>
  );
}
