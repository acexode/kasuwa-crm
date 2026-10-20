'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { IconName } from '../icons.generated';
import { cx } from './class-names';
import { Glyph } from './glyph';

/**
 * Toasts, to the v1.1 Components page ("F · Feedback & overlays · Toasts"):
 *
 *   all      radius 10, padding 10 8 10 14, a 10px gap, 14px text, a 20px
 *            status glyph, shadow-2.
 *   success  inverse with on-inverse text, a success check, and an
 *            underlined 700 action (Undo).
 *   error    surface-raised with a border (none on the inline start), a
 *            danger-text error glyph and a primary-text 700 action (Retry).
 *   info     surface-raised with a border, an info-text glyph and a 36px
 *            muted dismiss.
 *   warning  warning-soft in warning-text at 600, shadow-1.
 *
 * Placement: bottom-centre on a phone, bottom-right on a desktop. Errors stay
 * until dismissed; the others hide after 6s, paused while the pointer or
 * focus is on the stack. Two live regions: polite (role=status) for the
 * others, assertive (role=alert) for errors.
 */

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

const SURFACE: Record<ToastTone, string> = {
  success: 'bg-inverse text-on-inverse shadow-2',
  error: 'border border-s-0 border-border bg-surface-raised text-text shadow-2',
  info: 'border border-border bg-surface-raised text-text shadow-2',
  warning: 'bg-warning-soft font-semibold text-warning-text shadow-1',
};

const ICON: Record<ToastTone, { readonly name: IconName; readonly className: string }> = {
  success: { name: 'check_circle', className: 'text-success' },
  error: { name: 'error', className: 'text-danger-text' },
  info: { name: 'info', className: 'text-info-text' },
  warning: { name: 'warning', className: '' },
};

const ACTION: Record<ToastTone, string> = {
  success: 'text-inherit underline underline-offset-3',
  error: 'text-primary-text',
  info: 'text-primary-text',
  warning: 'text-inherit underline underline-offset-3',
};

export interface ToastAction {
  readonly label: ReactNode;
  readonly onClick: VoidFunction;
}

export interface ToastProps {
  readonly tone: ToastTone;
  readonly message: ReactNode;
  /** A different glyph, e.g. `cloud_upload` for "Saved offline". */
  readonly icon?: IconName | undefined;
  readonly action?: ToastAction | undefined;
  /** Given, a 36px dismiss button with this accessible name. */
  readonly dismissLabel?: string | undefined;
  readonly onDismiss?: VoidFunction | undefined;
  readonly className?: string | undefined;
}

/** One toast, as drawn. `ToastProvider` stacks and times them. */
export function Toast({
  tone,
  message,
  icon,
  action,
  dismissLabel,
  onDismiss,
  className,
}: ToastProps) {
  const glyph = ICON[tone];
  return (
    <div
      className={cx(
        'flex w-full items-center gap-2.5 rounded-10 py-2.5 pe-2 ps-3.5 text-body-sm',
        SURFACE[tone],
        className,
      )}
    >
      <Glyph name={icon ?? glyph.name} size={20} className={glyph.className} />
      <span className="min-w-0 flex-1">{message}</span>
      {action === undefined ? null : (
        <button
          type="button"
          onClick={action.onClick}
          className={cx(
            'h-control-sm shrink-0 rounded-md px-2.5 text-body-sm font-bold is-focus-visible:ring-focus',
            ACTION[tone],
          )}
        >
          {action.label}
        </button>
      )}
      {dismissLabel === undefined ? null : (
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className="inline-flex size-control-sm shrink-0 items-center justify-center rounded-md text-text-muted is-hover:bg-surface-sunken is-focus-visible:ring-focus"
        >
          <Glyph name="close" size={20} />
        </button>
      )}
    </div>
  );
}

/** How long a non-error toast stays (v1.1: "others auto-hide after 6s"). */
export const TOAST_TIMEOUT_MS = 6000;

export interface ToastInput extends Omit<ToastProps, 'onDismiss' | 'className'> {
  /** Override the 6s; `null` keeps it until dismissed. Errors always stay. */
  readonly timeout?: number | null | undefined;
}

interface QueuedToast extends ToastInput {
  readonly id: number;
}

interface ToastApi {
  readonly show: { (toast: ToastInput): number };
  readonly dismiss: { (id: number): void };
}

const ToastContext = createContext<ToastApi | null>(null);

/** The toast API, from the nearest ToastProvider. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error('useToast needs a ToastProvider above it');
  return api;
}

export interface ToastProviderProps {
  readonly children: ReactNode;
  /** The region's accessible name ("Notifications"). */
  readonly label: string;
}

export function ToastProvider({ children, label }: ToastProviderProps) {
  const [toasts, setToasts] = useState<readonly QueuedToast[]>([]);
  const nextId = useRef(1);
  const [paused, setPaused] = useState(false);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback((toast: ToastInput) => {
    const id = nextId.current;
    nextId.current += 1;
    setToasts((current) => [...current, { ...toast, id }]);
    return id;
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastRegion
        label={label}
        toasts={toasts}
        paused={paused}
        onPause={setPaused}
        onDismiss={dismiss}
      />
    </ToastContext.Provider>
  );
}

function TimedToast({
  toast,
  paused,
  onDismiss,
}: {
  readonly toast: QueuedToast;
  readonly paused: boolean;
  readonly onDismiss: { (id: number): void };
}) {
  const timeout = toast.tone === 'error' ? null : (toast.timeout ?? TOAST_TIMEOUT_MS);
  const dismissThis = useCallback(() => {
    onDismiss(toast.id);
  }, [onDismiss, toast.id]);
  useEffect(() => {
    if (timeout === null || paused) return undefined;
    const timer = window.setTimeout(() => {
      onDismiss(toast.id);
    }, timeout);
    return () => {
      window.clearTimeout(timer);
    };
  }, [timeout, paused, onDismiss, toast.id]);

  return (
    <div className="pointer-events-auto w-full animate-toast-in">
      <Toast
        tone={toast.tone}
        message={toast.message}
        icon={toast.icon}
        action={
          toast.action === undefined
            ? undefined
            : {
                label: toast.action.label,
                onClick: () => {
                  toast.action?.onClick();
                  dismissThis();
                },
              }
        }
        dismissLabel={toast.dismissLabel}
        onDismiss={dismissThis}
      />
    </div>
  );
}

interface ToastRegionProps {
  readonly label: string;
  readonly toasts: readonly QueuedToast[];
  readonly paused: boolean;
  readonly onPause: { (paused: boolean): void };
  readonly onDismiss: { (id: number): void };
}

function isError(toast: QueuedToast): boolean {
  return toast.tone === 'error';
}

function isPolite(toast: QueuedToast): boolean {
  return !isError(toast);
}

/**
 * The fixed stack. Both live regions are always in the DOM, empty or not: a
 * region added at the moment its message arrives is not announced.
 */
function ToastRegion({ label, toasts, paused, onPause, onDismiss }: ToastRegionProps) {
  const pause = useCallback(() => {
    onPause(true);
  }, [onPause]);
  const resume = useCallback(() => {
    onPause(false);
  }, [onPause]);
  const polite = toasts.filter(isPolite);
  const assertive = toasts.filter(isError);
  return (
    <section
      aria-label={label}
      onPointerEnter={pause}
      onPointerLeave={resume}
      onFocus={pause}
      onBlur={resume}
      className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] mx-auto flex max-w-overlay-toast flex-col items-center gap-2.5 sm:end-4 sm:start-auto sm:mx-0 sm:w-overlay-toast sm:items-end"
    >
      <div role="alert" className="flex w-full flex-col gap-2.5">
        {assertive.map((toast) => (
          <TimedToast key={toast.id} toast={toast} paused={paused} onDismiss={onDismiss} />
        ))}
      </div>
      <div role="status" className="flex w-full flex-col gap-2.5">
        {polite.map((toast) => (
          <TimedToast key={toast.id} toast={toast} paused={paused} onDismiss={onDismiss} />
        ))}
      </div>
    </section>
  );
}
