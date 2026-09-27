/**
 * The control vocabulary every P01 screen shares.
 *
 * Kept as class strings rather than components because these screens are the
 * first real UI in Kasuwa and the component API should be designed once there
 * are thirty screens to design it against, not guessed at from five. What must
 * NOT drift meanwhile is the accessibility contract, so it lives here in one
 * place:
 *
 *   min-h-touch  — the WCAG 2.2 AA target-size floor (44 px), and a TOKEN,
 *                  never a number typed into a class name
 *   focus-visible outline, always offset — a ring flush against a control on a
 *                  cheap screen in daylight is not a visible focus indicator
 *
 * Every colour here is a semantic token. There is no literal in this file and
 * there must never be one: lint enforces that, and a one-off colour is how a
 * design system dies.
 */

export const PRIMARY_BUTTON =
  'flex min-h-touch items-center justify-center gap-2 rounded-md bg-primary px-4 text-body-md font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

export const SECONDARY_BUTTON =
  'flex min-h-touch items-center justify-center gap-2 rounded-md border border-border-strong bg-surface px-4 text-body-md font-semibold text-text hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

export const QUIET_BUTTON =
  'flex min-h-touch items-center justify-center gap-2 rounded-md px-3 text-body-sm font-semibold text-primary-text hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

export const FIELD =
  'min-h-touch rounded-md border border-border-strong bg-surface px-3 text-body-md text-text placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-[invalid=true]:border-danger';

export const LINK =
  'font-semibold text-primary-text underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
