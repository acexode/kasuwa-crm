import type { Translator } from '@kasuwa/i18n/bundle';

/**
 * A contact's name where the API may not serve one (D-L68, T-0124).
 *
 * `displayName` follows its name parts: it is omitted (a whole record) or
 * `null` (a summary) whenever `givenNames` or `familyName` is withheld from the
 * caller. A screen prints the translated stand-in, never an empty string, never
 * a name composed from the part that is readable, and never the id.
 */
export function nameOrWithheld(t: Translator, name: string | null | undefined): string {
  return typeof name === 'string' && name !== '' ? name : t.t('records.name.withheld');
}
