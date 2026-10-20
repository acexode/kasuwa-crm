'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import type { IconName } from '../icons.generated';
import { cx } from './class-names';
import { Glyph } from './glyph';

/**
 * Menus and popovers, to the v1.1 Components "Select" menu and the P04 saved
 * views menu:
 *
 *   panel    radius 10, a 1px border, shadow-2, padding 6 (4 for a select's
 *            option list), surface (surface-raised in a select).
 *   section  an 11/700 caps overline in text-muted, padded 8 10 6.
 *   row      at least 40px, radius 6, 0 10px, 14px, a 10px gap. Hover is
 *            surface-sunken. The selected row is primary-soft with a check
 *            in primary-text in an 18px leading slot; a trailing count is mono
 *            12 muted. A disabled row is disabled-text.
 *   divider  1px border, 6px above and below.
 *
 * `Menu` is the WAI-ARIA menu button: the trigger opens it, focus moves to
 * the selected (else the first) item, the arrow keys, Home and End move,
 * Enter or Space chooses and closes, Esc and Tab close, and focus returns to
 * the trigger. `Popover` is the same panel holding anything (a column
 * chooser, the notification list): a non-modal dialog that Esc and an
 * outside click close.
 */

export type PanelSurface = 'surface' | 'raised';

export interface MenuPanelProps extends ComponentPropsWithRef<'div'> {
  readonly surface?: PanelSurface | undefined;
  /** `tight` is the select list's 4px padding; default is 6px. */
  readonly tight?: boolean | undefined;
}

/** The menu and popover surface on its own, for a list that is always shown. */
export function MenuPanel({ surface = 'surface', tight, className, ...rest }: MenuPanelProps) {
  return (
    <div
      className={cx(
        'flex flex-col rounded-10 border border-border text-text shadow-2',
        surface === 'raised' ? 'bg-surface-raised' : 'bg-surface',
        tight === true ? 'p-1' : 'p-1.5',
        className,
      )}
      {...rest}
    />
  );
}

export function MenuSection({ children }: { readonly children: ReactNode }) {
  return (
    <span role="presentation" className="px-2.5 pb-1.5 pt-2 text-overline text-text-muted">
      {children}
    </span>
  );
}

export function MenuSeparator() {
  return <span role="separator" className="my-1.5 h-px shrink-0 bg-border" />;
}

const CloseContext = createContext<VoidFunction | null>(null);

export interface MenuItemProps extends Omit<ComponentPropsWithRef<'button'>, 'onSelect'> {
  /** Given (true or false), the item is a radio item with the leading check slot. */
  readonly selected?: boolean | undefined;
  readonly icon?: IconName | undefined;
  /** A trailing count or shortcut, mono 12 muted. */
  readonly meta?: ReactNode | undefined;
  /** `primary` is an action row ("Save current filters as a view…"). */
  readonly tone?: 'default' | 'primary' | 'danger' | undefined;
  readonly onSelect?: VoidFunction | undefined;
  /** Leave the menu open after choosing (a multi-toggle list). */
  readonly keepOpen?: boolean | undefined;
}

const TONE = {
  default: 'text-text',
  primary: 'font-semibold text-primary-text',
  danger: 'font-semibold text-danger-text',
} as const;

export function MenuItem({
  selected,
  icon,
  meta,
  tone = 'default',
  onSelect,
  keepOpen,
  disabled,
  className,
  children,
  ...rest
}: MenuItemProps) {
  const close = useContext(CloseContext);
  const radio = selected !== undefined;
  return (
    <button
      type="button"
      role={radio ? 'menuitemradio' : 'menuitem'}
      aria-checked={radio ? selected : undefined}
      aria-disabled={disabled === true || undefined}
      tabIndex={-1}
      data-k-menuitem=""
      onClick={() => {
        if (disabled === true) return;
        onSelect?.();
        if (keepOpen !== true) close?.();
      }}
      className={cx(
        'flex min-h-control-md w-full shrink-0 items-center gap-2.5 rounded-6 px-2.5 text-start text-body-sm outline-none transition-colors duration-instant',
        disabled === true
          ? 'cursor-not-allowed text-disabled-text'
          : cx(
              TONE[tone],
              'is-hover:bg-surface-sunken focus-visible:bg-surface-sunken',
              selected === true && 'bg-primary-soft is-hover:bg-primary-soft focus-visible:bg-primary-soft-strong',
            ),
        className,
      )}
      {...rest}
    >
      {radio ? (
        <span className="inline-flex w-4.5 shrink-0 justify-center text-primary-text">
          {selected ? <Glyph name="check" size={18} /> : null}
        </span>
      ) : icon === undefined ? null : (
        <Glyph name={icon} size={18} />
      )}
      <span className="min-w-0 flex-1">{children}</span>
      {meta === undefined ? null : (
        <span className="font-mono text-caption text-text-muted">{meta}</span>
      )}
    </button>
  );
}

/** Closes on an outside pointer press and on Esc, and reports which. */
function useDismiss(
  open: boolean,
  root: RefObject<HTMLElement | null>,
  onDismiss: { (byKeyboard: boolean): void },
): void {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!open) return undefined;
    function onPointer(event: PointerEvent): void {
      if (root.current !== null && !root.current.contains(event.target as Node)) {
        dismiss.current(false);
      }
    }
    function onKey(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') dismiss.current(true);
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, root]);
}

/** What a trigger must spread onto its button. */
export interface TriggerProps {
  readonly ref: Ref<HTMLButtonElement>;
  readonly 'aria-haspopup': 'menu' | 'dialog';
  readonly 'aria-expanded': boolean;
  readonly 'aria-controls': string;
  readonly onClick: VoidFunction;
  readonly onKeyDown: { (event: KeyboardEvent<HTMLButtonElement>): void };
}

interface FloatingProps {
  readonly trigger: { (props: TriggerProps): ReactNode };
  readonly children: ReactNode;
  /** Which edge of the trigger the panel lines up with. */
  readonly align?: 'start' | 'end' | undefined;
  /** Open on first render (the gallery's static frame). */
  readonly defaultOpen?: boolean | undefined;
  readonly open?: boolean | undefined;
  readonly onOpenChange?: { (open: boolean): void } | undefined;
  readonly surface?: PanelSurface | undefined;
  /** Classes for the panel: a width other than the default 300px. */
  readonly panelClassName?: string | undefined;
  readonly className?: string | undefined;
}

function useOpenState(
  defaultOpen: boolean | undefined,
  open: boolean | undefined,
  onOpenChange: ({ (open: boolean): void }) | undefined,
): [boolean, { (next: boolean): void }] {
  const [own, setOwn] = useState(defaultOpen === true);
  const isOpen = open ?? own;
  const set = useCallback(
    (next: boolean) => {
      if (open === undefined) setOwn(next);
      onOpenChange?.(next);
    },
    [open, onOpenChange],
  );
  return [isOpen, set];
}

const PLACEMENT = { start: 'start-0', end: 'end-0' } as const;

function items(panel: HTMLElement | null): HTMLElement[] {
  if (panel === null) return [];
  return [...panel.querySelectorAll<HTMLElement>('[data-k-menuitem]')].filter(
    (item) => item.getAttribute('aria-disabled') !== 'true',
  );
}

export interface MenuProps extends FloatingProps {
  /** The menu's accessible name, when the trigger's text is not enough. */
  readonly 'aria-label'?: string | undefined;
}

export function Menu({
  trigger,
  children,
  align = 'start',
  defaultOpen,
  open,
  onOpenChange,
  surface,
  panelClassName,
  className,
  'aria-label': label,
}: MenuProps) {
  const [isOpen, setOpen] = useOpenState(defaultOpen, open, onOpenChange);
  const root = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const id = useId();
  const focusOnOpen = useRef<'selected' | 'last' | null>(null);

  const close = useCallback(
    (returnFocus = true) => {
      setOpen(false);
      if (returnFocus) button.current?.focus();
    },
    [setOpen],
  );
  const closeFromItem = useCallback(() => close(true), [close]);
  useDismiss(isOpen, root, (byKeyboard) => close(byKeyboard));

  useEffect(() => {
    if (!isOpen || focusOnOpen.current === null) return;
    const list = items(panel.current);
    const target =
      focusOnOpen.current === 'last'
        ? list[list.length - 1]
        : (list.find((item) => item.getAttribute('aria-checked') === 'true') ?? list[0]);
    focusOnOpen.current = null;
    target?.focus();
  }, [isOpen]);

  function openWith(focus: 'selected' | 'last'): void {
    focusOnOpen.current = focus;
    setOpen(true);
  }

  function onPanelKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const list = items(panel.current);
    const current = list.findIndex((item) => item === document.activeElement);
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = (current + 1) % list.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + list.length) % list.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = list.length - 1;
    else if (event.key === 'Tab') {
      close(false);
      return;
    }
    if (next === null || list.length === 0) return;
    event.preventDefault();
    list[next]?.focus();
  }

  return (
    <div ref={root} className={cx('relative inline-flex', className)}>
      {trigger({
        ref: button,
        'aria-haspopup': 'menu',
        'aria-expanded': isOpen,
        'aria-controls': id,
        onClick: () => (isOpen ? close(false) : openWith('selected')),
        onKeyDown: (event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openWith(event.key === 'ArrowUp' ? 'last' : 'selected');
          }
        },
      })}
      {isOpen ? (
        <CloseContext.Provider value={closeFromItem}>
          <MenuPanel
            ref={panel}
            id={id}
            role="menu"
            aria-label={label}
            surface={surface}
            onKeyDown={onPanelKeyDown}
            className={cx(
              'absolute top-full z-30 mt-1.5 w-overlay-menu max-w-[calc(100vw-2rem)] animate-fade-in',
              PLACEMENT[align],
              panelClassName,
            )}
          >
            {children}
          </MenuPanel>
        </CloseContext.Provider>
      ) : null}
    </div>
  );
}

export interface PopoverProps extends FloatingProps {
  /** The dialog's accessible name ("Columns", "Notifications"). */
  readonly 'aria-label': string;
}

export function Popover({
  trigger,
  children,
  align = 'start',
  defaultOpen,
  open,
  onOpenChange,
  surface,
  panelClassName,
  className,
  'aria-label': label,
}: PopoverProps) {
  const [isOpen, setOpen] = useOpenState(defaultOpen, open, onOpenChange);
  const root = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const id = useId();

  useDismiss(isOpen, root, (byKeyboard) => {
    setOpen(false);
    if (byKeyboard) button.current?.focus();
  });

  return (
    <div ref={root} className={cx('relative inline-flex', className)}>
      {trigger({
        ref: button,
        'aria-haspopup': 'dialog',
        'aria-expanded': isOpen,
        'aria-controls': id,
        onClick: () => setOpen(!isOpen),
        onKeyDown: () => undefined,
      })}
      {isOpen ? (
        <MenuPanel
          id={id}
          role="dialog"
          aria-label={label}
          surface={surface}
          className={cx(
            'absolute top-full z-30 mt-1.5 w-overlay-menu max-w-[calc(100vw-2rem)] animate-fade-in',
            PLACEMENT[align],
            panelClassName,
          )}
        >
          {children}
        </MenuPanel>
      ) : null}
    </div>
  );
}
