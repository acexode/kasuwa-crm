import type { IconName } from '@kasuwa/ui';

/**
 * A glyph from the self-hosted Material Symbols subset.
 *
 * `name` is a union generated from `packages/ui/icon-subset.txt`, not a string.
 * The font ships only the glyphs that file lists — kilobytes instead of several
 * megabytes, which is what makes it affordable at 256 kbps — and a name outside
 * that set renders as a BLANK BOX: silently, only in production, with nothing in
 * any log. A union turns that into a compile error on the line that typed the
 * name; `pnpm verify:icons` (run in CI) catches the cases the union cannot see.
 *
 * To add one: put it in `icon-subset.txt`, run `pnpm ui:fetch-fonts`, and the
 * union regenerates with it.
 *
 * Always `aria-hidden`. Every icon in these screens sits beside its own label
 * or inside a button that carries one; an icon that is the only content of a
 * control gets its name from `aria-label` on the control, never from here.
 */
/**
 * Icon sizes are TYPE-scale steps, because an icon font's size is a font size.
 * The design uses 18/20/22/28 px; the scale offers 18, 20, 24 and 32, so the
 * two odd values round to the nearest step rather than becoming a raw `22px`
 * somewhere in a class name. A one-off size is how a design system starts
 * leaking, exactly like a one-off colour.
 */
const SIZE_CLASS = {
  sm: 'text-body-lg',
  md: 'text-h4',
  lg: 'text-h3',
  xl: 'text-h2',
} as const;

export type IconSize = keyof typeof SIZE_CLASS;

export function Icon({
  name,
  size = 'md',
  className,
}: {
  name: IconName;
  size?: IconSize;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`k-icon shrink-0 leading-none ${SIZE_CLASS[size]} ${className ?? ''}`}
    >
      {name}
    </span>
  );
}
