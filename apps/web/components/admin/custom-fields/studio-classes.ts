/**
 * P18's control styles, from the export's inline styles (T-0142), written with
 * the T-0127 utilities only. The export draws its buttons and inputs at 40px
 * on desktop; below `md` they keep the 44px touch target (CLAUDE.md, WCAG 2.2).
 */

/** 40px (44 on touch), 0 16px, radius 8, 14/600: "New field", "Save field". */
export const STUDIO_PRIMARY =
  'inline-flex h-control-base shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-4 text-body-sm font-semibold text-on-primary is-hover:bg-primary-hover outline-none focus-visible:ring-focus disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-text md:h-control-md';

/** The bordered 40px button: "Relationships", "Discard", "Cancel". */
export const STUDIO_SECONDARY =
  'inline-flex h-control-base shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-surface px-3.5 text-body-sm font-semibold text-text is-hover:bg-surface-sunken outline-none focus-visible:ring-focus disabled:cursor-not-allowed disabled:text-disabled-text md:h-control-md';

/** The danger text button in the editor's footer (the export's "Delete"; here, Retire). */
export const STUDIO_DANGER_GHOST =
  'inline-flex h-control-base shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2.5 text-body-sm font-semibold text-danger-text is-hover:bg-danger-soft outline-none focus-visible:ring-focus md:h-control-md';

/** A 40px input, radius 8, border-strong, 14px. */
export const STUDIO_INPUT =
  'h-control-base w-full min-w-0 rounded-md border border-border-strong bg-surface px-3 text-body-sm font-normal text-text placeholder:text-text-muted outline-none focus-visible:field-focus aria-[invalid=true]:border-danger disabled:bg-disabled-bg disabled:text-text-2 md:h-control-md';

/** A field's label: 13/700 over its control, 6px apart. */
export const STUDIO_LABEL = 'flex flex-col gap-1.5 text-meta font-bold text-text';

/** A 36px pill chip in the toolbar: "Not used anywhere", "Show retired". */
export const STUDIO_CHIP =
  'inline-flex h-control-base items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-meta font-semibold outline-none focus-visible:ring-focus md:h-control-sm';

/** The export's segmented track: sunken, 3px inset, radius 10. */
export const STUDIO_SEGMENTED = 'flex shrink-0 gap-0.5 rounded-10 bg-surface-sunken p-0.5';

/** One segment: 34px, 0 12px, radius 8, 14/600; pressed is the raised surface. */
export const STUDIO_SEGMENT =
  'inline-flex h-control-base items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-body-sm font-semibold outline-none focus-visible:ring-focus md:h-control-sm';
export const STUDIO_SEGMENT_ON = 'bg-surface text-text shadow-1';
export const STUDIO_SEGMENT_OFF = 'text-text-2 is-hover:text-text';

/** The 24px property chip in the field table (required, unique, filterable, lock). */
export const PROPERTY_CHIP = 'flex size-6 items-center justify-center rounded-6 bg-surface-sunken text-text-2';

/** The object tile: 52px, radius 12, primary-soft for a standard object. */
export const OBJECT_TILE = 'flex size-control-xl shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-text';
