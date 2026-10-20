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
  children,
  className,
  type = 'button',
  ...rest
}: ChipProps) {
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
