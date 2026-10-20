import type { ComponentPropsWithRef, MouseEvent, ReactNode } from 'react';
import type { IconName } from '../icons.generated';
import { cx } from './class-names';
import { Glyph } from './glyph';
import { Spinner } from './spinner';

/**
 * Buttons, to the v1.1 Components page ("A · Actions").
 *
 *   44px high, 0 12px padding, radius 8, 15/600, a 6px gap, 22px icons.
 *   Hover:    primary-hover; secondary goes surface-sunken; ghost primary-soft;
 *             danger danger-hover.
 *   Active:   primary-active, border, primary-soft-strong or danger-active,
 *             moved down 1px.
 *   Focus:    a 2px surface gap and a 2px focus ring, on :focus-visible only.
 *   Disabled: disabled-bg on disabled-text (secondary keeps a border edge on
 *             surface; ghost stays transparent). Never an opacity fade: a
 *             faded button on a cheap screen in daylight is invisible, and
 *             it reads as "loading" rather than "not available".
 *   Loading:  keeps its width, shows a spinner and the present-tense label
 *             ("Saving"), sets aria-busy and ignores clicks.
 *
 * Compact is 36px with 13/600 text and 18px icons, desktop only ("36px compact
 * size is desktop-only and keeps a 44px hit area"): below `md` it is the
 * standard 44px, and above it an invisible 4px band top and bottom keeps the
 * target 44px tall.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'default' | 'compact';

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'border-transparent bg-primary text-on-primary is-hover:bg-primary-hover is-active:bg-primary-active disabled:bg-disabled-bg disabled:text-disabled-text',
  secondary:
    'border-border-strong bg-surface text-text is-hover:bg-surface-sunken is-active:bg-border disabled:border-border disabled:bg-surface disabled:text-disabled-text',
  ghost:
    'border-transparent bg-transparent text-primary-text is-hover:bg-primary-soft is-active:bg-primary-soft-strong disabled:bg-transparent disabled:text-disabled-text',
  // The export draws the danger label in literal white, in both themes;
  // on-primary is the token that is white in both themes.
  danger:
    'border-transparent bg-danger text-on-primary is-hover:bg-danger-hover is-active:bg-danger-active disabled:bg-disabled-bg disabled:text-disabled-text',
};

const BASE =
  'relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md border px-3 transition-colors duration-instant is-focus-visible:ring-focus is-active:translate-y-px disabled:cursor-not-allowed';

const SIZE: Record<ButtonSize, string> = {
  default: 'h-control-base text-label',
  compact:
    'h-control-base text-label md:h-control-sm md:text-meta md:font-semibold md:before:absolute md:before:inset-x-0 md:before:-inset-y-1',
};

const ICON_SIZE: Record<ButtonSize, string | undefined> = {
  default: undefined,
  compact: 'md:text-icon-18',
};

export interface ButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  /** One primary per view. Defaults to secondary. */
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** A leading glyph. */
  readonly icon?: IconName;
  /** A trailing glyph, such as `expand_more` on a button that opens a menu. */
  readonly trailingIcon?: IconName;
  readonly loading?: boolean;
  /**
   * The present-tense label shown while loading ("Saving"). Given, the button
   * is always as wide as the wider of the two labels, so it never jumps when
   * loading starts. Left out, the label stays (invisibly) and a spinner sits
   * over it.
   */
  readonly loadingLabel?: ReactNode;
  readonly children: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'default',
  icon,
  trailingIcon,
  loading = false,
  loadingLabel,
  children,
  className,
  type = 'button',
  onClick,
  ...rest
}: ButtonProps) {
  const iconClass = ICON_SIZE[size];
  const label = (
    <>
      {icon === undefined ? null : <Glyph name={icon} size={22} className={iconClass} />}
      {children}
      {trailingIcon === undefined ? null : (
        <Glyph name={trailingIcon} size={22} className={iconClass} />
      )}
    </>
  );

  return (
    <button
      type={type}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={loading ? (event: MouseEvent<HTMLButtonElement>) => event.preventDefault() : onClick}
      className={cx(BASE, SIZE[size], VARIANT[variant], className)}
      {...rest}
    >
      {loadingLabel === undefined ? (
        <>
          <span className={cx('inline-flex items-center gap-1.5', loading && 'opacity-0')}>
            {label}
          </span>
          {loading ? (
            <span className="absolute inset-0 flex items-center justify-center">
              <Spinner />
            </span>
          ) : null}
        </>
      ) : (
        <span className="grid">
          <span
            aria-hidden={loading || undefined}
            className={cx(
              'col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5',
              loading && 'invisible',
            )}
          >
            {label}
          </span>
          <span
            aria-hidden={!loading || undefined}
            className={cx(
              'col-start-1 row-start-1 inline-flex items-center justify-center gap-2',
              !loading && 'invisible',
            )}
          >
            <Spinner />
            {loadingLabel}
          </span>
        </span>
      )}
    </button>
  );
}

export type IconButtonVariant = 'secondary' | 'ghost';

const ICON_VARIANT: Record<IconButtonVariant, string> = {
  secondary:
    'border-border-strong bg-surface text-text is-hover:bg-surface-sunken disabled:border-border disabled:bg-surface disabled:text-disabled-text',
  ghost:
    'border-transparent bg-transparent text-text is-hover:bg-surface-sunken disabled:text-disabled-text',
};

export interface IconButtonProps extends Omit<
  ComponentPropsWithRef<'button'>,
  'children' | 'aria-label'
> {
  readonly icon: IconName;
  /** The accessible name. An icon button always carries one (v1.1). */
  readonly label: string;
  /** Bordered (the v1.1 icon button) or borderless (the header bell). */
  readonly variant?: IconButtonVariant;
  /**
   * A toggle that is on: mute, hold, a pinned filter. Drawn as the v1.1
   * "Active" icon button, primary on on-primary, and announced as pressed.
   */
  readonly pressed?: boolean;
  readonly loading?: boolean;
}

/**
 * A 44px square button holding one 22px glyph (v1.1 "Icon" row).
 */
export function IconButton({
  icon,
  label,
  variant = 'secondary',
  pressed,
  loading = false,
  className,
  type = 'button',
  onClick,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={loading ? (event: MouseEvent<HTMLButtonElement>) => event.preventDefault() : onClick}
      className={cx(
        'relative inline-flex size-control-base shrink-0 select-none items-center justify-center rounded-md border transition-colors duration-instant is-focus-visible:ring-focus disabled:cursor-not-allowed',
        ICON_VARIANT[variant],
        'aria-pressed:border-transparent aria-pressed:bg-primary aria-pressed:text-on-primary aria-pressed:is-hover:bg-primary-hover',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : <Glyph name={icon} size={22} />}
    </button>
  );
}
