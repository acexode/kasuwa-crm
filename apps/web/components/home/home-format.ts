import type { MessageId } from '@kasuwa/i18n/bundle';

/**
 * How P03 writes times, days and money (T-0132). Pure functions, no
 * `'use client'`.
 *
 * THE ZONE IS THE BROWSER'S, as on P07: no `timeZone` option is ever passed,
 * so a Lagos desk reads WAT and a Nairobi desk EAT. Only the zone's NAME is
 * looked for: `en` abbreviates Africa/Lagos as "GMT+1", which nobody on that
 * desk calls it, so a locale that knows the African abbreviations is asked
 * when the active one only offers an offset.
 */

/**
 * Plain `en` writes the month first ("Wednesday, September 30"), which no desk
 * Kasuwa serves reads that way; the design's day-first order is en-NG's. Only
 * the bare tag is mapped: every other language keeps its own order.
 */
function dayFirst(locale: string): string {
  return locale === 'en' ? 'en-NG' : locale;
}

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat('en', options);
  }
}

/** The greeting's part of the day, from the browser's clock. */
export function greetingId(now: Date, named: boolean): MessageId {
  const hour = now.getHours();
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  return `home.greeting.${part}${named ? '' : '.anon'}` as MessageId;
}

/** The first word of a display name ("Musa Bello" -> "Musa"). */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/u)[0] ?? '';
}

/** "Wednesday 30 September" at 1440, "Wed 30 Sep" at 360. */
export function formatDay(locale: string, now: Date, short: boolean): string {
  return formatter(dayFirst(locale), short ? { weekday: 'short', day: 'numeric', month: 'short' } : { weekday: 'long', day: 'numeric', month: 'long' })
    .format(now)
    .replace(/,/gu, '');
}

/** A 24-hour clock, as the design's mono times ("10:12"). */
export function formatClock(locale: string, at: Date): string {
  return formatter(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

const OFFSET_ONLY = /^(GMT|UTC)([+-−]|$)/u;

/** The browser's zone by its name ("WAT", "EAT", "SAST"), or its offset where no name is known. */
export function zoneName(locale: string, at: Date = new Date()): string {
  const read = (tag: string): string =>
    formatter(tag, { timeZoneName: 'short' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value ?? '';
  const own = read(locale);
  if (!OFFSET_ONLY.test(own)) return own;
  for (const tag of ['en-NG', 'en-KE', 'en-ZA', 'en-GH']) {
    const named = read(tag);
    if (named !== '' && !OFFSET_ONLY.test(named)) return named;
  }
  return own;
}

/** Local midnight today and tomorrow, as UTC instants: the agenda's calendar window. */
export function todayWindow(now: Date): { from: string; to: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Whole days since `iso`, never negative. */
export function daysSince(iso: string, now: Date): number {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.floor((now.getTime() - at) / 86_400_000));
}

/** Minutes between two instants, or null. */
export function minutesBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (from === null || from === undefined || to === null || to === undefined) return null;
  const minutes = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

/** "14 Oct": a close date (a calendar date, so read as UTC and written as a day). */
export function formatCloseDate(locale: string, date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return '';
  return formatter(dayFirst(locale), { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(at);
}

/** The calendar quarter of `now`: 1 to 4. */
export function quarterOf(now: Date): number {
  return Math.floor(now.getMonth() / 3) + 1;
}

/** The currency toggle's label: the locale's narrow sign, then the code ("₦ NGN", "$ USD"). */
export function currencyLabel(locale: string, currency: string): string {
  try {
    const sign =
      new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
        .formatToParts(0)
        .find((part) => part.type === 'currency')?.value ?? '';
    return sign === '' || sign === currency ? currency : `${sign} ${currency}`;
  } catch {
    return currency;
  }
}
