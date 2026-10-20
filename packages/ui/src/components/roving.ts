/**
 * Keyboard movement for the single-select groups: SegmentedControl (a radio
 * group) and Tabs (a tab list). Pure, so the rules are unit-tested without a
 * DOM, and so both components move focus the same way.
 *
 * The rules are the WAI-ARIA Authoring Practices' for both patterns:
 *
 *   - Only the selected item is in the tab order (roving tabindex). Tab leaves
 *     the group; the arrow keys move inside it.
 *   - Next and previous WRAP, and skip disabled items.
 *   - Home and End go to the first and last enabled item.
 *   - In a right-to-left layout the left arrow means "next". RTL is a layout
 *     mode (packages/i18n/CLAUDE.md), and an Arabic reader expects the arrow
 *     that points along the reading direction to move along it.
 *   - A radio group also answers Up and Down (APG: "Down Arrow and Right Arrow
 *     move focus to the next radio button"). A horizontal tab list does not,
 *     so Down stays free for the page to scroll.
 */

export type RovingOrientation = 'horizontal' | 'both';

export interface RovingOptions {
  /** True when the group is laid out right to left. */
  readonly rtl: boolean;
  /** 'both' for a radio group, 'horizontal' for a tab list. */
  readonly orientation: RovingOrientation;
}

/** The first index that is not disabled, scanning from `start` in `step` direction, wrapping. */
function scan(disabled: readonly boolean[], start: number, step: 1 | -1): number | null {
  const count = disabled.length;
  for (let offset = 0; offset < count; offset += 1) {
    const index = (((start + step * offset) % count) + count) % count;
    if (disabled[index] !== true) return index;
  }
  return null;
}

/**
 * Where a key press moves focus to, or `null` when the key is not one the
 * group handles (so the caller leaves the event alone) or when every item is
 * disabled.
 */
export function rovingTarget(
  key: string,
  current: number,
  disabled: readonly boolean[],
  options: RovingOptions,
): number | null {
  if (disabled.length === 0) return null;
  const forward = options.rtl ? 'ArrowLeft' : 'ArrowRight';
  const backward = options.rtl ? 'ArrowRight' : 'ArrowLeft';
  const vertical = options.orientation === 'both';

  if (key === forward || (vertical && key === 'ArrowDown')) {
    return scan(disabled, current + 1, 1);
  }
  if (key === backward || (vertical && key === 'ArrowUp')) {
    return scan(disabled, current - 1, -1);
  }
  if (key === 'Home') return scan(disabled, 0, 1);
  if (key === 'End') return scan(disabled, disabled.length - 1, -1);
  return null;
}

/**
 * The one item that takes part in the tab order: the selected item when it
 * is enabled, otherwise the first enabled item. `null` when there is none.
 */
export function tabStopIndex(selected: number, disabled: readonly boolean[]): number | null {
  if (selected >= 0 && selected < disabled.length && disabled[selected] !== true) return selected;
  return scan(disabled, 0, 1);
}
