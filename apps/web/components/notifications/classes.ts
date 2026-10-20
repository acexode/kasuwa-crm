/**
 * The class strings the notification screens share, to the P26 export
 * (T-0137). Tokens only, and a copy of the records lists' own
 * (`../records/list-classes`) rather than an import of them: a module the
 * centre and the bell share with the record lists would give the bundler one
 * more consumer to regroup the lists' shared chunks around, and every page that
 * never shows a notification would pay for it (D-L182).
 * No `'use client'`, so any module may import them.
 */

export const FOCUS = 'outline-none focus-visible:ring-focus';

/**
 * A filter pill (P26 B at 1024, E2, and the bell's chips): a full radius,
 * 600, the chosen one solid primary with on-primary text, the rest surface
 * with a 1px border. The 36px pill keeps a 44px hit area.
 */
export const PILL = `relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border font-semibold transition-colors duration-instant disabled:cursor-not-allowed disabled:border-border disabled:bg-surface disabled:text-disabled-text ${FOCUS}`;
export const PILL_SIZE = 'h-control-sm px-3.5 text-meta font-semibold before:absolute before:inset-x-0 before:-inset-y-1';
/** The bell's chips: 30px, 0 11px, 12/600. */
export const PILL_SIZE_SMALL = 'h-control-xs px-2.5 text-caption font-semibold';
export const PILL_ON = 'border-primary bg-primary text-on-primary';
export const PILL_OFF = 'border-border bg-surface text-text is-hover:bg-surface-sunken';

/** The centre's 40px header buttons (Mark all read, Preferences): surface, a 1px border, 14/600, a 20px glyph. */
export const HEADER_BUTTON = `inline-flex h-control-md shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-surface px-3.5 text-body-sm font-semibold text-text transition-colors duration-instant is-hover:bg-surface-sunken disabled:cursor-not-allowed disabled:text-disabled-text ${FOCUS}`;

/** A text button in primary-text (the bell's and the phone's Mark all read); disabled is disabled-text, never an opacity. */
export const TEXT_BUTTON = `inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-6 font-bold text-primary-text transition-colors duration-instant is-hover:bg-primary-soft disabled:cursor-not-allowed disabled:bg-transparent disabled:text-disabled-text ${FOCUS}`;

/** A small secondary button inside a list (Show all, Set preferences): 36px, 13/600. */
export const SMALL_BUTTON = `inline-flex h-control-sm shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-surface px-3.5 text-meta font-semibold text-text transition-colors duration-instant is-hover:bg-surface-sunken disabled:cursor-not-allowed disabled:text-disabled-text ${FOCUS}`;

/** The day heading over a group: 12/700 caps in text-2; the group's unread count sits on the right in text-muted. */
export const DAY_HEADING = 'flex items-center px-2.5 text-caption font-bold uppercase tracking-wide text-text-2';
