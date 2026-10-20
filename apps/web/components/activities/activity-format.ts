/**
 * How P07 writes a time down (T-0083, T-0136). Every format is the browser's
 * zone — no `timeZone` option, ever — so a Nairobi desk reads Nairobi's clock
 * and a Lagos desk Lagos'. Each result is drawn inside a `<time datetime>`
 * with the instant itself, so the words are for people and the attribute is
 * exact.
 *
 * The design writes days the en-NG way and clocks on 24 hours ("Wed 30 Sep",
 * "Fri 2 Oct 10:00", "16:00 WAT"), with the zone as "WAT · UTC+1 · Lagos".
 * English is assembled from its parts so it reads exactly that (ICU's en-GB
 * says "Sept" and adds commas); every other language keeps its own order,
 * with the commas dropped, and a 24-hour clock.
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

function english(locale: string): boolean {
  return /^en(-|$)/i.test(locale) && !/^en-XA$/i.test(locale);
}

function part(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((entry) => entry.type === type)?.value ?? '';
}

/** A locale's own parts, joined without the commas ICU puts between them. */
function joined(parts: readonly Intl.DateTimeFormatPart[]): string {
  return parts
    .map((entry) => (entry.type === 'literal' ? entry.value.replace(/,\s*/g, ' ') : entry.value))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Wed 30 Sep": the weekday, the day and the month. */
export function formatDayShort(locale: string, value: string | Date): string {
  const date = at(value);
  if (date === null) return '';
  const parts = formatter(locale, { weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(date);
  if (!english(locale)) return joined(parts);
  return `${part(parts, 'weekday')} ${part(parts, 'day')} ${part(parts, 'month')}`;
}

/** "28 Sep": the day and the month, for the start of a range. */
export function formatDayMonth(locale: string, value: string | Date): string {
  const date = at(value);
  if (date === null) return '';
  const parts = formatter(locale, { day: 'numeric', month: 'short' }).formatToParts(date);
  if (!english(locale)) return joined(parts);
  return `${part(parts, 'day')} ${part(parts, 'month')}`;
}

/** "4 Oct 2026": the day, the month and the year, for the end of a range. */
export function formatDay(locale: string, value: string | Date): string {
  const date = at(value);
  if (date === null) return '';
  const parts = formatter(locale, { day: 'numeric', month: 'short', year: 'numeric' }).formatToParts(date);
  if (!english(locale)) return joined(parts);
  return `${part(parts, 'day')} ${part(parts, 'month')} ${part(parts, 'year')}`;
}

/** "Thu 1 Oct 2026": a single day's title. */
export function formatDayLong(locale: string, value: string | Date): string {
  const date = at(value);
  if (date === null) return '';
  const parts = formatter(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).formatToParts(date);
  if (!english(locale)) return joined(parts);
  return `${part(parts, 'weekday')} ${part(parts, 'day')} ${part(parts, 'month')} ${part(parts, 'year')}`;
}

/** A clock time on 24 hours ("09:00", "16:30"). */
export function formatClockTime(locale: string, value: string | Date): string {
  const date = at(value);
  return date === null ? '' : formatter(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

/** A due time on a row or in a menu: the day and the clock ("Fri 2 Oct 10:00"). */
export function formatWhen(locale: string, value: string | Date): string {
  const date = at(value);
  return date === null ? '' : `${formatDayShort(locale, date)} ${formatClockTime(locale, date)}`;
}

/** A weekday alone ("Mon"), for a calendar column's header. */
export function formatWeekday(locale: string, day: Date): string {
  return formatter(locale, { weekday: 'short' }).format(day);
}

/** The day of the month alone ("28"), in the locale's digits. */
export function formatDayNumber(locale: string, day: Date): string {
  return formatter(locale, { day: 'numeric' }).format(day);
}

/** A calendar day's header: the weekday and the date ("Wed 30"). */
export function formatDayHeader(locale: string, day: Date): string {
  return `${formatWeekday(locale, day)} ${formatDayNumber(locale, day)}`;
}

/** A month's title ("October 2026"). */
export function formatMonth(locale: string, day: Date): string {
  return formatter(locale, { month: 'long', year: 'numeric' }).format(day);
}

/** Local midnight of the day an instant falls on. */
function midnight(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Calendar days from `now`'s day to `value`'s, in the browser's zone: -1 is yesterday. */
export function dayOffset(value: string | Date, now: Date = new Date()): number | null {
  const date = at(value);
  if (date === null) return null;
  return Math.round((midnight(date) - midnight(now)) / 86_400_000);
}

export interface ZoneParts {
  /** The zone's abbreviation where one is in use ("WAT", "EAT", "SAST"), else empty. */
  readonly abbreviation: string;
  /** The offset from UTC ("UTC+1", "UTC+5:30", "UTC"). */
  readonly offset: string;
  /** The zone's city, from its IANA name ("Lagos"), else empty. */
  readonly city: string;
}

/**
 * The browser's own zone, as the design names it. The abbreviation is ICU's
 * en-NG short name, which knows the African zones by name (WAT, CAT, EAT,
 * SAST); where it only has an offset, there is no abbreviation. The zone is
 * read from the browser, never written here.
 */
export function zoneParts(when: Date = new Date()): ZoneParts {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const short = formatter('en-NG', { timeZoneName: 'short' }).formatToParts(when).find((entry) => entry.type === 'timeZoneName')?.value ?? '';
  const long = formatter('en', { timeZoneName: 'longOffset' }).formatToParts(when).find((entry) => entry.type === 'timeZoneName')?.value ?? '';
  const match = /([+-])(\d{2}):?(\d{2})?/.exec(long);
  const offset =
    match === null
      ? 'UTC'
      : `UTC${match[1] ?? '+'}${Number(match[2] ?? '0')}${match[3] !== undefined && match[3] !== '00' ? `:${match[3]}` : ''}`;
  const abbreviation = /^(GMT|UTC)[+-]/.test(short) || short === '' ? '' : short;
  const segments = (zone ?? '').split('/');
  const city = segments.length > 1 ? (segments[segments.length - 1] ?? '').replace(/_/g, ' ') : '';
  return { abbreviation, offset, city };
}

/** The header pill: "WAT · UTC+1 · Lagos", or "UTC+5:30 · Kolkata" for a zone with no abbreviation. */
export function zonePill(when: Date = new Date()): string {
  const { abbreviation, offset, city } = zoneParts(when);
  return [abbreviation, offset, city].filter((entry) => entry !== '').join(' · ');
}

/** What follows a clock time on today's rows: the abbreviation, else the offset ("12:00 WAT"). */
export function zoneSuffix(when: Date = new Date()): string {
  const { abbreviation, offset } = zoneParts(when);
  return abbreviation === '' ? offset : abbreviation;
}

/** The browser's zone as the locale abbreviates it ("GMT+1", "SAST"): the screen names its own zone only. */
export function zoneLabel(locale: string, when: Date = new Date()): string {
  return formatter(locale, { timeZoneName: 'short' }).formatToParts(when).find((entry) => entry.type === 'timeZoneName')?.value ?? '';
}
