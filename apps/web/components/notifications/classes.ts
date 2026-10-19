/**
 * The class strings the notification screens share. Tokens only, and a copy of
 * the records lists' own (`../records/list-classes`) rather than an import of
 * them: a module the centre and the bell share with the record lists would give
 * the bundler one more consumer to regroup the lists' shared chunks around, and
 * every page that never shows a notification would pay for it (D-L182).
 * No `'use client'`, so any module may import them.
 */

export const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/** A filter chip: a 44 px target, a pill, a visible focus ring. */
export const CHIP = `flex min-h-touch items-center gap-2 rounded-full border px-4 text-body-sm font-semibold ${FOCUS}`;
export const CHIP_ON = 'border-primary bg-primary-soft text-primary-text';
export const CHIP_OFF = 'border-border bg-surface text-text hover:bg-surface-sunken';
