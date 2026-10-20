import type { IconName } from '../icons.generated';
import type { IconSize } from '../tokens';
import { cx, type DataAttributes } from './class-names';

/**
 * Icon sizes as `text-icon-*` utilities, which set a font size and nothing
 * else: the glyph inherits the weight of the text around it, as in the
 * exports (D-L198). `Record<IconSize, …>` makes a size added to ICON_SIZE
 * without a class here a compile error. The strings are literal so Tailwind
 * sees them.
 */
const SIZE_CLASS: Record<IconSize, string> = {
  14: 'text-icon-14',
  15: 'text-icon-15',
  16: 'text-icon-16',
  18: 'text-icon-18',
  20: 'text-icon-20',
  22: 'text-icon-22',
  24: 'text-icon-24',
  28: 'text-icon-28',
  32: 'text-icon-32',
};

export type GlyphProps = {
  readonly name: IconName;
  readonly size: IconSize;
  readonly className?: string | undefined;
} & DataAttributes;

/**
 * A Material Symbols glyph inside a component. Internal to the library: the
 * app's `<Icon>` (apps/web/components/icon.tsx) is the public one until the
 * screens move onto these components.
 *
 * `name` is the generated `IconName` union, so a glyph outside the font subset
 * is a compile error rather than a blank box in production. Always
 * `aria-hidden`: the control that draws it carries the name.
 */
export function Glyph({ name, size, className, ...attributes }: GlyphProps) {
  return (
    <span
      aria-hidden="true"
      className={cx('k-icon shrink-0 leading-none', SIZE_CLASS[size], className)}
      {...attributes}
    >
      {name}
    </span>
  );
}
