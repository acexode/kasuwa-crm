/**
 * How English writes a date on every Kasuwa screen (T-0143).
 *
 * Bare `en` is ICU's American English: "Oct 20, 2026, 3:00 PM". No desk
 * Kasuwa serves writes dates that way, and every Claude Design export writes
 * them day first on a 24-hour clock ("20 Oct 15:00 WAT"). So bare `en` is
 * formatted as Nigerian English, which is day first and 24-hour; a regional
 * English (`en-KE`, `en-ZA`) and every other language keep their own order.
 *
 * ICU's British-style English abbreviates September "Sept"; the designs write
 * "Sep", so English output is tidied after formatting.
 *
 * Pure, no `'use client'`: server components and unit tests import it.
 */

export function dayFirstLocale(locale: string): string {
  return /^en$/i.test(locale) ? 'en-NG' : locale;
}

export function tidyMonth(locale: string, text: string): string {
  return /^en(-|$)/i.test(locale) ? text.replace(/\bSept\b/g, 'Sep') : text;
}

/** `Intl.DateTimeFormat` in the day-first locale, falling back to `en-NG` for a tag the engine refuses. */
export function dateFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(dayFirstLocale(locale), options);
  } catch {
    return new Intl.DateTimeFormat('en-NG', options);
  }
}

/** Format `at` day first, tidied ("3 Sep 2026"). */
export function formatDayFirst(locale: string, at: Date, options: Intl.DateTimeFormatOptions): string {
  return tidyMonth(locale, dateFormatter(locale, options).format(at));
}
