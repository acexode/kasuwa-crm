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

// ---------------------------------------------------------------------------
// T-0133 (D-L193): the P04 lists, re-measured against the export. The names
// above stay as they were for the other screens that share them.
// Controls `@kasuwa/ui/components` has (Chip, SegmentedControl, Checkbox,
// Avatar, Pill, Tag) come from there; the 40px header buttons, the menus and
// the table are drawn here until T-0129's Table and Menu land.
// ---------------------------------------------------------------------------

/** An option chip in a filter menu or the phone's filter sheet: 40px, a pill, 13/600 (P04 "Filter sheet"). */
export const OPTION_CHIP = `inline-flex h-control-md items-center gap-1 rounded-full border px-3.5 text-meta font-semibold ${FOCUS}`;
export const OPTION_CHIP_OFF = 'border-border-strong bg-surface text-text hover:bg-surface-sunken';

/** A P04 menu row: 40px, 14px, radius 6 (saved views). */
export const P04_MENU_ROW = `flex min-h-control-md w-full items-center gap-2.5 rounded-6 px-2.5 text-start text-body-sm hover:bg-surface-sunken disabled:cursor-not-allowed disabled:text-disabled-text disabled:hover:bg-transparent ${FOCUS}`;

/** A P04 menu panel: radius 12, shadow 2, 6px inset. The caller adds its position. */
export const P04_MENU = 'z-30 rounded-lg border border-border bg-surface-raised p-1.5 shadow-2';

/** The menu's small-caps section label ("SAVED VIEWS"). */
export const MENU_LABEL = 'px-2.5 pb-1 pt-2 text-overline text-text-muted';

/** P04's 40px outlined header button ("Import / export"): radius 8, 14/600. */
export const HEADER_BUTTON = `inline-flex h-control-md shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border-strong bg-surface pe-2.5 ps-3 text-body-sm font-semibold text-text hover:bg-surface-sunken ${FOCUS}`;

/** P04's 40px primary header button ("New lead"): radius 8, 14/700. */
export const HEADER_PRIMARY = `inline-flex h-control-md shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-primary pe-4 ps-3 text-body-sm font-bold text-on-primary hover:bg-primary-hover ${FOCUS}`;

/** The 36px outlined toolbar button ("All leads", "Columns"): radius 8, 13/600. */
export const TOOL_BUTTON = `inline-flex h-control-sm shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border-strong bg-surface px-2.5 text-meta font-semibold text-text hover:bg-surface-sunken ${FOCUS}`;

/** A table header cell without its padding: 40px, sunken, 12/700 in text-2. */
export const TH_BASE = 'h-10 whitespace-nowrap border-b border-border bg-surface-sunken text-start align-middle text-caption font-bold text-text-2';
export const TH = `${TH_BASE} px-3`;

/** A table body cell without its padding: 52px with a 1px rule. */
export const TD_BASE = 'h-control-xl border-b border-border align-middle';
export const TD = `${TD_BASE} px-3`;
