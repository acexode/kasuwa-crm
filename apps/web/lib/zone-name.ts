/**
 * How Kasuwa names a time zone, in every language: by the abbreviation the
 * desks there use — "WAT", "EAT", "SAST", "CAT" — never by an offset where a
 * name exists (lead ruling, T-0144). A French screen in Lagos says "WAT", as
 * the English one does; ICU's French "UTC+1" and bare English "GMT+1" are what
 * this replaces. The abbreviation is a name, not a word, so it is not
 * translated.
 *
 * Where no name is known (a zone outside the regions below that ICU only knows
 * by offset), the reader's own locale writes the offset ("UTC−4").
 *
 * Pure, no `'use client'`: server components and unit tests import it.
 */

/**
 * The zones Kasuwa's desks sit in, by their English long name. Matched on the
 * long name so every IANA zone in a region maps, not one city. Engines differ:
 * Node's ICU says "West Africa Standard Time", Chromium's "West Africa Time".
 */
const AFRICAN_ZONES: Readonly<Record<string, string>> = {
  'West Africa Standard Time': 'WAT',
  'West Africa Time': 'WAT',
  'West Africa Summer Time': 'WAST',
  'Central Africa Time': 'CAT',
  'East Africa Time': 'EAT',
  'South Africa Standard Time': 'SAST',
  'South Africa Time': 'SAST',
  'Greenwich Mean Time': 'GMT',
};

/** The African Englishes, which name the regions' zones where bare `en` gives an offset. */
const NAMING_LOCALES = ['en-NG', 'en-KE', 'en-ZA', 'en-GH'] as const;

const OFFSET_ONLY = /^(GMT|UTC)([+\-−]|$)/u;

function zonePart(locale: string, at: Date, style: 'short' | 'long', timeZone: string | undefined): string {
  return (
    new Intl.DateTimeFormat(locale, { timeZoneName: style, ...(timeZone === undefined ? {} : { timeZone }) })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value ?? ''
  );
}

/** The locale's own short name, falling back to English's for a tag the engine refuses. */
function ownShort(locale: string, at: Date, timeZone: string | undefined): string {
  const tag = /^en$/i.test(locale) ? 'en-NG' : locale;
  try {
    return zonePart(tag, at, 'short', timeZone);
  } catch {
    // A malformed tag. An unknown zone throws again here, which is the contract.
    return zonePart('en-NG', at, 'short', timeZone);
  }
}

/**
 * `timeZone` unset means the reader's own zone. An unknown IANA id throws a
 * `RangeError`, as `Intl` does: the caller decides what an unresolvable zone
 * shows (the lockout line says "UTC" and converts to it).
 */
export function zoneAbbreviation(locale: string, at: Date = new Date(), timeZone?: string): string {
  const known = AFRICAN_ZONES[zonePart('en', at, 'long', timeZone)];
  if (known !== undefined) return known;
  for (const tag of NAMING_LOCALES) {
    const named = zonePart(tag, at, 'short', timeZone);
    if (named !== '' && !OFFSET_ONLY.test(named)) return named;
  }
  return ownShort(locale, at, timeZone);
}
