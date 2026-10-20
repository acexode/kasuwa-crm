'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * The behaviour every modal overlay shares: Dialog, Drawer and BottomSheet
 * (T-0129), to the v1.1 Patterns "J · Drawers & modals" rules:
 *
 *   - Esc dismisses.
 *   - On open, focus the first field; a destructive or read-only overlay
 *     passes `initialFocus` to focus the safe button instead.
 *   - Tab and Shift+Tab cycle inside; everything behind is `inert`.
 *   - The page behind is scroll-locked.
 *   - On close, focus returns to whatever had it before (the trigger).
 *
 * A non-modal overlay (a record preview drawer: "no scrim, no trap") skips
 * the trap, the inert and the scroll lock, and keeps Esc.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * The overlay's tab stops, in order. An element with `tabindex="-1"` is not
 * one, whatever its tag: a listbox's option links (the command palette's
 * rows) are reached with the arrow keys, and counting one as the trap's last
 * stop let Tab walk out of the dialog from the real last one (D-L137 M2).
 */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.tabIndex >= 0 && element.getClientRects().length > 0,
  );
}

/** The first field in the body, else the first focusable, else the panel itself. */
function firstFocus(panel: HTMLElement): HTMLElement {
  const body = panel.querySelector<HTMLElement>('[data-k-overlay-body]');
  const field = body?.querySelector<HTMLElement>('input, select, textarea');
  if (field !== null && field !== undefined && !field.hasAttribute('disabled')) return field;
  return focusables(panel)[0] ?? panel;
}

export interface OverlayOptions {
  readonly open: boolean;
  readonly onClose: VoidFunction;
  /** The panel element, from a callback ref, so the effect runs once it mounts. */
  readonly panel: HTMLElement | null;
  readonly modal: boolean;
  readonly initialFocus?: RefObject<HTMLElement | null> | undefined;
}

export function useOverlay({ open, onClose, panel, modal, initialFocus }: OverlayOptions): void {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const node = panel;
    if (node === null) return undefined;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Everything outside the overlay's portal root becomes inert, so neither a
    // screen reader's virtual cursor nor a stray Tab can reach it.
    const root = node.closest<HTMLElement>('[data-k-portal]');
    const hidden: HTMLElement[] = [];
    let previousOverflow = '';
    if (modal) {
      for (const sibling of document.body.children) {
        if (sibling instanceof HTMLElement && sibling !== root && !sibling.inert) {
          sibling.inert = true;
          hidden.push(sibling);
        }
      }
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }

    (initialFocus?.current ?? firstFocus(node)).focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
        return;
      }
      if (!modal || event.key !== 'Tab' || node === null) return;
      const items = focusables(node);
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      for (const sibling of hidden) sibling.inert = false;
      if (modal) document.body.style.overflow = previousOverflow;
      if (returnTo !== null && returnTo.isConnected) returnTo.focus();
    };
  }, [open, modal, panel, initialFocus]);
}

/**
 * The fixed header's divider and the fixed footer's shadow "react to scroll"
 * (v1.1 Patterns): the divider shows once the body has scrolled at all, the
 * shadow while content remains below the footer.
 */
export function useScrollEdges(open: boolean): {
  readonly bodyRef: { (node: HTMLElement | null): void };
  readonly scrolled: boolean;
  readonly more: boolean;
} {
  const [scrolled, setScrolled] = useState(false);
  const [more, setMore] = useState(false);
  const node = useRef<HTMLElement | null>(null);

  const measure = useCallback(() => {
    const body = node.current;
    if (body === null) return;
    setScrolled(body.scrollTop > 0);
    setMore(body.scrollTop + body.clientHeight < body.scrollHeight - 1);
  }, []);

  const bodyRef = useCallback(
    (element: HTMLElement | null) => {
      node.current?.removeEventListener('scroll', measure);
      node.current = element;
      element?.addEventListener('scroll', measure, { passive: true });
      measure();
    },
    [measure],
  );

  useLayoutEffect(() => {
    if (!open) return undefined;
    measure();
    const body = node.current;
    if (body === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    for (const child of body.children) observer.observe(child);
    return () => observer.disconnect();
  }, [open, measure]);

  return { bodyRef, scrolled, more };
}

/** A stable id for aria-labelledby, from React's own id. */
export { useId } from 'react';
