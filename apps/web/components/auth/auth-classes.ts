/**
 * The page-level vocabulary the P01 screens share (T-0131, to `Kasuwa Auth and
 * Onboarding`). Controls come from `@kasuwa/ui/components`; these are only the
 * layout and type steps around them, so each screen does not retype them.
 *
 *   column      400px wide, an 18px stack, centred vertically (`margin:auto 0`)
 *   title       28/36, weight 700 and no tracking: the P01 page title, which
 *               is lighter than the list-page `title` step (800)
 *   subtitle    15px text-2 under the title
 *   icon disc   56px circle above a status screen's title (locked, MFA)
 *   link        an inline primary-text link, underlined
 */
export const AUTH_COLUMN = 'my-auto flex w-full max-w-layout-column flex-col gap-4.5';

export const PAGE_TITLE = 'text-title font-bold tracking-normal text-text';

export const PAGE_SUBTITLE = 'text-label font-normal text-text-2';

export const ICON_DISC = 'flex size-14 flex-shrink-0 items-center justify-center rounded-full';

export const AUTH_LINK =
  'rounded-sm font-semibold text-primary-text underline underline-offset-2 focus-visible:ring-focus';

/** "OTHER WAYS TO VERIFY": 12/700 caps at 0.06em, muted. */
export const SECTION_LABEL = 'text-caption font-bold uppercase tracking-wider text-text-muted';
