import type { ComponentPropsWithRef, ReactNode } from 'react';
import type { IconName } from '../icons.generated';
import { cx, type DataAttributes } from './class-names';
import { Glyph } from './glyph';

export interface ChipProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  /** The 18px leading glyph: the filter's subject (person, flag, location_on). */
  readonly icon?: IconName;
  /** A trailing 18px glyph, `expand_more` when the chip opens a menu. */
  readonly trailingIcon?: IconName;
  /**
   * A filter is applied: primary edge on primary-soft, primary-text. Visual
   * only; the caller states what it means (`aria-pressed` for a toggle chip,
   * `aria-expanded` and `aria-haspopup` for one that opens a menu).
   */
  readonly active?: boolean;
  /** `data-*` for the leading glyph. */
  readonly iconAttributes?: DataAttributes;
  /**
   * `filter` is the P04 toolbar chip. `choice` is the P01 choice pill
   * (T-0131: customer languages, employee size): 40px, 0 12px, 14px, a
   * border-strong edge on the page, and when chosen a solid primary fill with
   * on-primary text.
   */
  readonly variant?: 'filter' | 'choice';
  /** A `choice` pill at 44px with a 600 label (P01/3's employee sizes). */
  readonly large?: boolean;
  readonly children: ReactNode;
}

/**
 * A filter chip, as the P04 list toolbars draw it ("Owner", "Status",
 * "Source: USSD"): 36px, radius 999, 0 8px 0 10px, 13/600, a 6px gap, a 1px
 * border-strong edge, 18px glyphs. Active is a primary edge on primary-soft
 * with primary-text (P04 "Contacts · no results"). Hover is surface-sunken,
 * the secondary button's hover; the exports draw no chip hover of their own.
 *
 * 36px is a desktop size, so an invisible band keeps the target 44px tall.
 */
export function Chip({
  icon,
  trailingIcon,
  active = false,
  iconAttributes,
  variant = 'filter',
  large = false,
  children,
  className,
  type = 'button',
  ...rest
}: ChipProps) {
  if (variant === 'choice') {
    return (
      <button
        type={type}
        className={cx(
          'relative inline-flex shrink-0 select-none items-center gap-1 whitespace-nowrap rounded-full border text-body-sm transition-colors duration-instant is-focus-visible:ring-focus disabled:cursor-not-allowed disabled:border-border disabled:bg-surface disabled:text-disabled-text',
          large ? 'h-control-base px-3.5 font-semibold' : 'h-control-md px-3',
          active
            ? 'border-primary bg-primary font-semibold text-on-primary is-hover:bg-primary-hover'
            : 'border-border-strong bg-surface text-text is-hover:bg-surface-sunken',
          className,
        )}
        {...rest}
      >
        {icon === undefined ? null : <Glyph name={icon} size={16} {...iconAttributes} />}
        {children}
      </button>
    );
  }
  return (
    <button
      type={type}
      className={cx(
        'relative inline-flex h-control-sm shrink-0 select-none items-center gap-1.5 whitespace-nowrap rounded-full border ps-2.5 pe-2 text-meta font-semibold transition-colors duration-instant before:absolute before:inset-x-0 before:-inset-y-1 is-focus-visible:ring-focus disabled:cursor-not-allowed disabled:border-border disabled:bg-surface disabled:text-disabled-text',
        active
          ? 'border-primary bg-primary-soft text-primary-text'
          : 'border-border-strong bg-surface text-text is-hover:bg-surface-sunken',
        className,
      )}
      {...rest}
    >
      {icon === undefined ? null : <Glyph name={icon} size={18} {...iconAttributes} />}
      {children}
      {trailingIcon === undefined ? null : <Glyph name={trailingIcon} size={18} />}
    </button>
  );
}
