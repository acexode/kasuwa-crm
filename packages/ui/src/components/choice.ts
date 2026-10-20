/**
 * The row and box shared by Checkbox and Radio (v1.1 "Checkbox", "Radio").
 * In a plain module, not the client one, so the server-rendered Radio can
 * import it: a value imported from a 'use client' module is a client
 * reference on the server, not the value.
 */

export const ROW = 'inline-flex min-h-touch items-center gap-3 text-body-sm';

export function rowTone(disabled: boolean, invalid: boolean): string {
  if (disabled) return 'cursor-not-allowed text-disabled-text';
  if (invalid) return 'cursor-pointer text-danger-text';
  return 'cursor-pointer text-text';
}

export const BOX =
  'peer size-5 shrink-0 cursor-[inherit] appearance-none border-2 border-border-strong bg-transparent transition-colors duration-quick is-focus-visible:ring-focus aria-[invalid=true]:border-danger disabled:border-border disabled:bg-disabled-bg';
