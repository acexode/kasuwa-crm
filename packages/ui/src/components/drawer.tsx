'use client';

import { useId, useState, type ReactNode, type RefObject } from 'react';
import { cx } from './class-names';
import { OverlayCloseButton, OverlayLayer } from './dialog';
import { useOverlay, useScrollEdges } from './overlay';

/**
 * The right drawer and the bottom sheet, to the v1.1 Patterns page ("J ·
 * Drawers & modals").
 *
 *   Drawer       400px (at most 90vw) from the inline end, full height,
 *                surface-raised with shadow-3. A fixed 60px header (16/700
 *                title over a 12px muted subtitle, a 44px close), a 16px
 *                body, and a fixed footer (12px 16px, actions at the end).
 *                Below 640px a drawer is drawn as the bottom sheet ("Right
 *                drawer · ≥ 600px viewports").
 *   BottomSheet  from the bottom edge, at most 90% high, top corners 20px,
 *                a decorative 40×4 grab handle, a 56px header (17/700 title,
 *                a 48px close with a 24px glyph), a body padded 12 16 with
 *                48px fields, and a footer whose actions share the width as
 *                48px buttons at radius 10.
 *
 * Both are modal by default (scrim, focus trap, inert page, scroll lock, Esc
 * and scrim press dismiss, focus returns to the trigger). `modal={false}` is
 * the record-preview drawer: no scrim, no trap, Esc still closes. The header
 * divider and the footer shadow react to scroll, as in the dialog.
 */

export interface SidePanelProps {
  readonly open: boolean;
  readonly onClose: VoidFunction;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode | undefined;
  readonly children?: ReactNode | undefined;
  readonly primaryAction?: ReactNode | undefined;
  readonly secondaryAction?: ReactNode | undefined;
  /** The close button's accessible name ("Close"). */
  readonly closeLabel: string;
  readonly modal?: boolean | undefined;
  readonly initialFocus?: RefObject<HTMLElement | null> | undefined;
  /** Draw it in place inside a positioned frame: the gallery's specimens. */
  readonly preview?: boolean | undefined;
}

type Form = 'drawer' | 'sheet';

/**
 * Class lists per part. A drawer carries the sheet's look behind `max-sm:`;
 * a sheet carries it at every width. Written out in full so Tailwind sees
 * every class.
 */
const PANEL: Record<Form, string> = {
  drawer:
    'fixed inset-y-0 end-0 w-overlay-drawer max-w-[90vw] animate-drawer-in rtl:animate-drawer-in-rtl max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-auto max-sm:w-full max-sm:max-w-none max-sm:max-h-[90%] max-sm:rounded-t-sheet max-sm:animate-sheet-in',
  sheet:
    'fixed inset-x-0 bottom-0 mx-auto w-full max-w-overlay-dialog-wide max-h-[90%] rounded-t-sheet animate-sheet-in',
};

const HANDLE: Record<Form, string> = {
  drawer: 'hidden max-sm:block',
  sheet: 'block',
};

const HEADER: Record<Form, string> = {
  drawer:
    'min-h-shell-header gap-2 py-2 pe-2 ps-4 max-sm:min-h-shell-mobile-header max-sm:py-1 max-sm:pe-1',
  sheet: 'min-h-shell-mobile-header gap-2 py-1 pe-1 ps-4',
};

const TITLE: Record<Form, string> = {
  drawer: 'text-card-title max-sm:text-sheet-title',
  sheet: 'text-sheet-title',
};

const CLOSE: Record<Form, string> = {
  drawer: 'max-sm:size-control-lg',
  sheet: 'size-control-lg [&_span]:text-icon-24',
};

const BODY: Record<Form, string> = {
  drawer: 'p-4 max-sm:py-3',
  sheet: 'px-4 py-3',
};

const FOOTER: Record<Form, string> = {
  drawer:
    'justify-end px-4 py-3 max-sm:pb-4 max-sm:[&>*]:flex-1 max-sm:[&>*>*]:h-control-lg max-sm:[&>*>*]:w-full max-sm:[&>*>*]:rounded-10',
  sheet: 'px-4 pb-4 pt-3 [&>*]:flex-1 [&>*>*]:h-control-lg [&>*>*]:w-full [&>*>*]:rounded-10',
};

function SidePanel({
  form,
  open,
  onClose,
  title,
  subtitle,
  children,
  primaryAction,
  secondaryAction,
  closeLabel,
  modal = true,
  initialFocus,
  preview = false,
}: SidePanelProps & { readonly form: Form }) {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const titleId = useId();
  const { bodyRef, scrolled, more } = useScrollEdges(open && panel !== null);
  useOverlay({ open: open && !preview, onClose, panel, modal, initialFocus });

  if (!open) return null;
  const hasFooter = primaryAction !== undefined || secondaryAction !== undefined;

  return (
    <OverlayLayer preview={preview}>
      {modal ? (
        <div
          aria-hidden="true"
          onClick={onClose}
          className={cx('inset-0 animate-fade-in bg-scrim', preview ? 'absolute' : 'fixed z-50')}
        />
      ) : null}
      <div
        ref={setPanel}
        role="dialog"
        aria-modal={modal && !preview ? 'true' : undefined}
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          'z-50 flex min-h-0 flex-col bg-surface-raised text-text shadow-3 outline-none',
          PANEL[form],
          preview && '!absolute !animate-none',
        )}
      >
        <span
          aria-hidden="true"
          className={cx('mt-2 h-1 w-10 shrink-0 self-center rounded-full bg-border-strong', HANDLE[form])}
        />
        <div
          className={cx(
            'flex shrink-0 items-center border-b transition-colors duration-quick',
            HEADER[form],
            scrolled ? 'border-border' : 'border-transparent',
          )}
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 id={titleId} className={cx('m-0 truncate text-text', TITLE[form])}>
              {title}
            </h2>
            {subtitle === undefined ? null : (
              <span className="truncate text-caption font-normal text-text-muted">{subtitle}</span>
            )}
          </div>
          <OverlayCloseButton label={closeLabel} onClick={onClose} className={CLOSE[form]} />
        </div>
        <div
          ref={bodyRef}
          data-k-overlay-body=""
          className={cx('flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto', BODY[form])}
        >
          {children}
        </div>
        {hasFooter ? (
          <div
            className={cx(
              'flex shrink-0 gap-2 border-t border-border',
              FOOTER[form],
              more && 'shadow-scroll-edge',
            )}
          >
            {secondaryAction === undefined ? null : <span className="flex">{secondaryAction}</span>}
            {primaryAction === undefined ? null : <span className="flex">{primaryAction}</span>}
          </div>
        ) : null}
      </div>
    </OverlayLayer>
  );
}

export type DrawerProps = SidePanelProps;

export function Drawer(props: DrawerProps) {
  return <SidePanel form="drawer" {...props} />;
}

export type BottomSheetProps = SidePanelProps;

export function BottomSheet(props: BottomSheetProps) {
  return <SidePanel form="sheet" {...props} />;
}
