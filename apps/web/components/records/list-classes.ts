/**
 * Class strings every P04 record list shares. Tokens only: no colour, spacing
 * or duration literal, ever (`packages/ui`). No `'use client'`, so any module
 * may import them.
 */

export const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/** A filter chip: a 44 px target, a pill, a visible focus ring. */
export const CHIP = `flex min-h-touch items-center gap-2 rounded-full border px-4 text-body-sm font-semibold ${FOCUS}`;

export const CHIP_ON = 'border-primary bg-primary-soft text-primary-text';
export const CHIP_OFF = 'border-border bg-surface text-text hover:bg-surface-sunken';

/** A menu row inside a popover. */
export const MENU_ROW = `flex min-h-touch w-full items-center gap-2 rounded-md px-2 text-start text-body-sm hover:bg-surface-sunken ${FOCUS}`;

/** A popover panel's surface; the caller adds its position. */
export const POPOVER = 'z-20 rounded-lg border border-border bg-surface-raised p-2 shadow-2';
