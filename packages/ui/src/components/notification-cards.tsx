import type { ReactNode } from 'react';
import type { IconName } from '../icons.generated';
import { cx } from './class-names';
import { Glyph } from './glyph';

/**
 * The P26 notification surfaces that are not the v1.1 generic toast (T-0137):
 *
 *   NotificationToast       C: a 380px card at the desktop's bottom-right:
 *                           radius 12, padding 14 8 14 14, a 12px gap,
 *                           surface-raised with a 1px border (danger for an
 *                           error), shadow-3. A 32px round tinted glyph, a
 *                           14/20 bold title, a 13/19 text-2 body, 32px
 *                           actions at radius 7 (here 6), and a 32px dismiss.
 *   NotificationToastStack  C: the bottom-right stack, 10px apart, at most
 *                           four; full width above the bottom bar on a phone.
 *   CriticalBanner          A2: full width under the top bar, danger with
 *                           on-primary text, a filled 22px glyph, a bold
 *                           lead-in, and two 34px actions: outlined and solid.
 *
 * Every word comes in through props.
 */

export type NotificationToastTone = 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

const TILE: Record<NotificationToastTone, string> = {
  primary: 'bg-primary-soft text-primary-text',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-danger-soft text-danger-text',
  info: 'bg-info-soft text-info-text',
  accent: 'bg-accent-soft text-accent-text',
};

export interface NotificationToastAction {
  readonly label: ReactNode;
  readonly onClick: VoidFunction;
  readonly primary?: boolean | undefined;
}

export interface NotificationToastProps {
  readonly icon: IconName;
  readonly tone: NotificationToastTone;
  readonly title: ReactNode;
  readonly body?: ReactNode | undefined;
  readonly action?: NotificationToastAction | undefined;
  /** An error stays until acted on, and draws a danger edge. */
  readonly error?: boolean | undefined;
  readonly dismissLabel: string;
  readonly onDismiss: VoidFunction;
  readonly className?: string | undefined;
}

export function NotificationToast({ icon, tone, title, body, action, error, dismissLabel, onDismiss, className }: NotificationToastProps) {
  return (
    <div
      role={error === true ? 'alert' : 'status'}
      className={cx(
        'flex w-full gap-3 rounded-lg border bg-surface-raised py-3.5 pe-2 ps-3.5 text-text shadow-3',
        error === true ? 'border-danger' : 'border-border',
        className,
      )}
    >
      <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-full', TILE[tone])}>
        <Glyph name={icon} size={18} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <b className="text-body-sm font-bold">{title}</b>
        {body === undefined ? null : <span className="text-meta text-text-2">{body}</span>}
        {action === undefined ? null : (
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={action.onClick}
              className={cx(
                'h-8 whitespace-nowrap rounded-6 border px-3 text-meta font-semibold is-focus-visible:ring-focus',
                action.primary === true
                  ? 'border-primary bg-primary text-on-primary is-hover:bg-primary-hover'
                  : 'border-border-strong bg-surface text-text is-hover:bg-surface-sunken',
              )}
            >
              {action.label}
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="flex size-8 shrink-0 items-center justify-center rounded-6 text-text-2 is-hover:bg-surface-sunken is-focus-visible:ring-focus"
      >
        <Glyph name="close" size={18} />
      </button>
    </div>
  );
}

export interface NotificationToastStackProps {
  /** The region's accessible name ("Notifications"). */
  readonly label: string;
  /** At most four are drawn; the newest last. */
  readonly children: ReactNode;
  /** `fixed` pins it bottom-right (bottom-centre on a phone); `inline` draws it in flow, for a gallery. */
  readonly placement?: 'fixed' | 'inline' | undefined;
}

export function NotificationToastStack({ label, children, placement = 'fixed' }: NotificationToastStackProps) {
  return (
    <section
      aria-label={label}
      className={cx(
        'flex flex-col gap-2.5',
        placement === 'fixed'
          ? 'fixed inset-x-4 bottom-20 z-40 md:inset-x-auto md:bottom-5 md:end-5 md:w-overlay-notification-toast'
          : 'w-full max-w-overlay-notification-toast',
      )}
    >
      {children}
    </section>
  );
}

export interface CriticalBannerProps {
  readonly icon?: IconName | undefined;
  /** The bold lead-in ("Unrecognised sign-in to your account."). */
  readonly title: ReactNode;
  readonly children?: ReactNode | undefined;
  /** The outlined action ("This was me"). */
  readonly secondary?: { readonly label: ReactNode; readonly onClick: VoidFunction } | undefined;
  /** The solid action ("Secure account"). */
  readonly primary?: { readonly label: ReactNode; readonly onClick: VoidFunction } | undefined;
  readonly className?: string | undefined;
}

export function CriticalBanner({ icon = 'gpp_maybe', title, children, secondary, primary, className }: CriticalBannerProps) {
  return (
    <div role="alert" className={cx('flex min-h-14 flex-wrap items-center gap-x-3.5 gap-y-2 bg-danger px-4 py-2.5 text-body-sm text-on-primary', className)}>
      <Glyph name={icon} size={22} className="k-icon-filled" />
      <p className="min-w-0 flex-1 basis-80">
        <b>{title}</b> {children}
      </p>
      {secondary === undefined && primary === undefined ? null : (
        <div className="flex gap-2">
          {secondary === undefined ? null : (
            <button type="button" onClick={secondary.onClick} className="h-8 whitespace-nowrap rounded-6 border border-on-primary bg-transparent px-3 text-meta font-bold text-on-primary is-focus-visible:ring-focus">
              {secondary.label}
            </button>
          )}
          {primary === undefined ? null : (
            <button type="button" onClick={primary.onClick} className="h-8 whitespace-nowrap rounded-6 bg-on-primary px-3 text-meta font-bold text-danger is-focus-visible:ring-focus">
              {primary.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
