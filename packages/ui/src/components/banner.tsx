import type { ReactNode } from 'react';
import type { IconName } from '../icons.generated';
import { cx } from './class-names';
import { Glyph } from './glyph';
import { Spinner } from './spinner';

/**
 * Banners, to the v1.1 Components page ("G · Connectivity, trust &
 * compliance"): full width, at least 48px, radius 10, padding 6 16, a 12px
 * gap, 14px text with a bold lead-in, a 20px glyph.
 *
 *   offline  inverse in on-inverse ("You're offline. 7 changes queued"), with
 *            a 36px action outlined in the current colour at radius 6, 13/700.
 *   info     info-soft in info-text ("Reconnected. Syncing…"; `busy` swaps
 *            the glyph for the spinner).
 *   success  success-soft in success-text ("All changes synced.").
 *   warning  warning-soft in warning-text.
 *   danger   danger-soft in danger-text, announced assertively.
 *
 * A banner with an action trims its end padding to 8, as the export does, so
 * the button sits 8px from the edge.
 */

export type BannerTone = 'offline' | 'info' | 'success' | 'warning' | 'danger';

const TONE: Record<BannerTone, string> = {
  offline: 'bg-inverse text-on-inverse',
  info: 'bg-info-soft text-info-text',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-danger-soft text-danger-text',
};

const ICON: Record<BannerTone, IconName> = {
  offline: 'cloud_off',
  info: 'info',
  success: 'cloud_done',
  warning: 'warning',
  danger: 'error',
};

export interface BannerProps {
  readonly tone: BannerTone;
  /** The bold lead-in ("You're offline."). */
  readonly title?: ReactNode | undefined;
  readonly children?: ReactNode | undefined;
  readonly icon?: IconName | undefined;
  /** Show the spinner in place of the glyph (syncing). */
  readonly busy?: boolean | undefined;
  /** The action button ("View queue (7)"), drawn by the banner. */
  readonly action?: { readonly label: ReactNode; readonly onClick: VoidFunction } | undefined;
  readonly className?: string | undefined;
}

export function Banner({ tone, title, children, icon, busy, action, className }: BannerProps) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cx(
        'flex min-h-12 flex-wrap items-center gap-3 rounded-10 py-1.5 ps-4 text-body-sm',
        action === undefined ? 'pe-4' : 'pe-2',
        TONE[tone],
        className,
      )}
    >
      {busy === true ? (
        <Spinner className="size-5" />
      ) : (
        <Glyph name={icon ?? ICON[tone]} size={20} />
      )}
      <span className="min-w-0 flex-1">
        {title === undefined ? null : <b className="font-bold">{title}</b>}
        {title !== undefined && children !== undefined ? ' ' : null}
        {children}
      </span>
      {action === undefined ? null : (
        <button
          type="button"
          onClick={action.onClick}
          className="h-control-sm shrink-0 rounded-6 border border-current bg-transparent px-3 text-meta font-bold text-inherit is-focus-visible:ring-focus"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
