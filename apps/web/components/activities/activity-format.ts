/**
 * How P07 writes a time down (T-0083). Every format is the browser's zone —
 * no `timeZone` option, ever — so a Nairobi desk reads Nairobi's clock and a
 * Lagos desk Lagos'. Each result is drawn inside a `<time datetime>` with
 * the instant itself, so the words are for people and the attribute is exact.
 *
 * No `'use client'`: pure functions, unit-tested directly.
 */

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat('en', options);
  }
}

function at(value: string | Date): Date | null {
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A due time on a row: the day and the clock ("Wed, Sep 30, 12:00 PM"). */
export function formatWhen(locale: string, value: string | Date): string {
  const date = at(value);
  return date === null
    ? ''
    : formatter(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(date);
}

/** A clock time alone, for an event on its own day. */
export function formatClockTime(locale: string, value: string | Date): string {
  const date = at(value);
  return date === null ? '' : formatter(locale, { hour: 'numeric', minute: '2-digit' }).format(date);
}

/** A calendar day's header: the weekday and the date ("Wed 30"). */
export function formatDayHeader(locale: string, day: Date): string {
  return formatter(locale, { weekday: 'short', day: 'numeric' }).format(day);
}

/** A day in the range label ("Sep 28, 2026"). */
export function formatDay(locale: string, day: Date): string {
  return formatter(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(day);
}

/** A month's title ("September 2026"). */
export function formatMonth(locale: string, day: Date): string {
  return formatter(locale, { month: 'long', year: 'numeric' }).format(day);
}

/** The browser's zone as the locale abbreviates it ("GMT+1", "SAST"): the screen names its own zone only. */
export function zoneLabel(locale: string, when: Date = new Date()): string {
  return formatter(locale, { timeZoneName: 'short' }).formatToParts(when).find((part) => part.type === 'timeZoneName')?.value ?? '';
}
