import type { ICON_SIZE_ALIAS, IconName, IconSize, IconSizeAlias } from '@kasuwa/ui';

/**
 * Icon sizes come from the icon's own scale, `ICON_SIZE` in `@kasuwa/ui`, keyed
 * by pixel size: pass the number the export uses (`size={22}` for a rail or
 * header icon). Never a type-scale class: those also set a font
 * weight, and a weight above 400 on the icon font draws a faux-bold glyph.
 *
 * `sm`/`md`/`lg`/`xl` are the pre-T-0127 names, kept so existing screens render
 * at the size they always did (18/20/24/32). The class strings are literal so
 * Tailwind's scanner sees them; `Record<IconSize, …>` makes a size added to
 * `ICON_SIZE` without a class here a compile error.
 *
 * Types only from `@kasuwa/ui`: this component ships in client bundles, and a
 * value import would pull the package barrel (every colour, the CSS and preset
 * builders) into them. `typeof ICON_SIZE_ALIAS` still pins `ALIAS` to the
 * package's mapping, value for value, at compile time.
 */
const ALIAS: typeof ICON_SIZE_ALIAS = { sm: 18, md: 20, lg: 24, xl: 32 };

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
export function Icon({
  name,
  size = 'md',
  filled = false,
  className,
}: {
  name: IconName;
  size?: IconSize | IconSizeAlias;
  /** The design's filled variant: the active bottom-tab icon, the bell, `gpp_maybe`. */
  filled?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`k-icon shrink-0 leading-none ${SIZE_CLASS[typeof size === 'number' ? size : ALIAS[size]]}${filled ? ' k-icon-filled' : ''} ${className ?? ''}`}
    >
      {name}
    </span>
  );
}
