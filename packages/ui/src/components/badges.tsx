import type { ComponentPropsWithRef, ReactNode } from 'react';
import type { IconName } from '../icons.generated';
import { cx } from './class-names';
import { Glyph } from './glyph';

/**
 * Pills, tags and count badges, to the v1.1 Components page ("Badges & status
 * pills") and the P04 list rows.
 *
 * Status never relies on colour alone: every pill and tag carries a word, and
 * the caller writes that word. These render it; they never invent one.
 */

export type PillTone =
  'info' | 'warning' | 'danger' | 'success' | 'neutral' | 'primary' | 'unknown';

const PILL_TONE: Record<PillTone, string> = {
  info: 'bg-info-soft text-info-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-danger-soft text-danger-text',
  success: 'bg-success-soft text-success-text',
  neutral: 'bg-surface-sunken text-text-2',
  primary: 'bg-primary-soft text-primary-text',
  // v1.1 "Consent unknown": no fill, a dashed border-strong edge.
  unknown: 'border border-dashed border-border-strong text-text-2',
};

export interface PillProps extends ComponentPropsWithRef<'span'> {
  readonly tone: PillTone;
  /**
   * A 15px leading glyph. With one, the pill is v1.1's consent pill ("Consent
   * & DND"): 12/600 at 3px 9px with a 4px gap. Consent carries an icon so it
   * never relies on colour alone.
   */
  readonly icon?: IconName;
  readonly children: ReactNode;
}

/**
 * A status pill: 12/700 at 3px 10px, radius 999, a *-text word on its *-soft
 * fill (v1.1 "Badges & status pills"). With an icon, a consent pill.
 */
export function Pill({ tone, icon, className, children, ...rest }: PillProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center whitespace-nowrap rounded-full py-0.75 text-caption',
        icon === undefined ? 'px-2.5 font-bold' : 'gap-1 px-2.25 font-semibold',
        PILL_TONE[tone],
        className,
      )}
      {...rest}
    >
      {icon === undefined ? null : <Glyph name={icon} size={15} />}
      {children}
    </span>
  );
}

export type TagTone = 'primary' | 'accent' | 'danger' | 'outline' | 'danger-soft';
export type TagSize = 'default' | 'small';

const TAG_TONE: Record<TagTone, string> = {
  primary: 'bg-primary text-on-primary',
  accent: 'bg-accent text-on-accent',
  // White in the export, in both themes: on-primary is white in both.
  danger: 'bg-danger text-on-primary',
  outline: 'border border-border text-text-2',
  'danger-soft': 'bg-danger-soft text-danger-text',
};

const TAG_SIZE: Record<TagSize, string> = {
  default: 'px-2.5 py-0.75 text-caption font-bold',
  small: 'h-5 px-1.5 text-micro',
};

export interface TagProps extends ComponentPropsWithRef<'span'> {
  readonly tone: TagTone;
  readonly size?: TagSize;
  readonly children: ReactNode;
}

/**
 * A square tag, radius 4. Default is v1.1's VIP / Hot / P1: 12/700 at 3px 10px
 * on a solid fill. Small is P04's network and DND tags: 20px high, 0 6px,
 * 11/700, an outline (MTN, Airtel) or danger-soft (DND).
 */
export function Tag({ tone, size = 'default', className, children, ...rest }: TagProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center whitespace-nowrap rounded-sm',
        TAG_SIZE[size],
        TAG_TONE[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

export type CountBadgeTone = 'danger' | 'primary';

const COUNT_TONE: Record<CountBadgeTone, string> = {
  danger: 'bg-danger text-on-primary',
  primary: 'bg-primary text-on-primary',
};

export interface CountBadgeProps extends ComponentPropsWithRef<'span'> {
  readonly tone?: CountBadgeTone;
  /** The count, already formatted for the locale ("9+", "12"). */
  readonly children: ReactNode;
}

/**
 * A count badge: 20px high, at least 20px wide, 0 6px, radius 999, 11/700
 * (v1.1 "9+"). Pass the count formatted for the locale; give it an
 * `aria-label` when the number alone would not make sense read aloud.
 */
export function CountBadge({ tone = 'danger', className, children, ...rest }: CountBadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex h-5 min-w-5 items-center justify-center whitespace-nowrap rounded-full px-1.5 text-micro',
        COUNT_TONE[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

export interface KbdProps extends ComponentPropsWithRef<'kbd'> {
  readonly children: ReactNode;
}

/**
 * A keyboard key (the header's "Ctrl K", the palette's "Esc"): JetBrains Mono
 * 11px, 20px high, 0 6px, a 1px border-strong edge, radius 4, in the colour of
 * the text around it.
 */
export function Kbd({ className, children, ...rest }: KbdProps) {
  return (
    <kbd
      className={cx(
        'inline-flex h-5 items-center whitespace-nowrap rounded-sm border border-border-strong px-1.5 font-mono text-micro font-normal',
        className,
      )}
      {...rest}
    >
      {children}
    </kbd>
  );
}
