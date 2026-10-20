import { numberingLocale } from './numbering';
import { dateFormatter, tidyMonth } from './date-locale';
import { zoneAbbreviation } from './zone-name';

/**
 * Formatting and parsing for the admin console, kept pure so it can be tested
 * without a browser.
 *
 * ---------------------------------------------------------------------------
 * WHY DURATIONS ARE PARSED AND NOT TYPED AS SECONDS
 *
 * `docs/api/admin.openapi.yaml` is explicit: an SLA target is an integer number
 * of seconds on the wire, never the string "2 min". The design (`P02/B4`) shows
 * a free-text field, and it is right to \u2014 "2 min" is what an operations manager
 * writes in a contract schedule, and a spin box counting to 86400 is not.
 *
 * So the client owns the translation between the two, and that has an i18n trap
 * in it: an English developer writes an alias table of `sec / min / h` and a
 * Hausa or French user's input silently fails to parse. The accepted suffixes
 * are therefore derived from `Intl.NumberFormat`'s own CLDR unit names for the
 * ACTIVE LOCALE, with the ASCII English forms always accepted on top \u2014 because
 * a BPO contract schedule is very often written in English even when the
 * workspace is not.
 * ---------------------------------------------------------------------------
 */

export type DurationUnit = 'second' | 'minute' | 'hour' | 'day';

const UNIT_SECONDS: Readonly<Record<DurationUnit, number>> = {
  second: 1,
  minute: 60,
  hour: 3_600,
  day: 86_400,
};

/** Always accepted, whatever the locale. See the note above. */
const ASCII_ALIASES: ReadonlyArray<readonly [string, DurationUnit]> = [
  ['s', 'second'],
  ['sec', 'second'],
  ['secs', 'second'],
  ['second', 'second'],
  ['seconds', 'second'],
  ['m', 'minute'],
  ['min', 'minute'],
  ['mins', 'minute'],
  ['minute', 'minute'],
  ['minutes', 'minute'],
  ['h', 'hour'],
  ['hr', 'hour'],
  ['hrs', 'hour'],
  ['hour', 'hour'],
  ['hours', 'hour'],
  ['d', 'day'],
  ['day', 'day'],
  ['days', 'day'],
];

/**
 * Digits a person may actually type. Arabic-Indic and Eastern Arabic-Indic are
 * here because `ar` is a registered locale and the whole point of registering
 * it is that RTL is exercised against something real.
 */
function normaliseDigits(text: string): string {
  return text.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (character) => {
    const code = character.codePointAt(0) ?? 0;
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/** The unit words CLDR uses for `locale`, short and long, lower-cased. */
function localeAliases(locale: string): Map<string, DurationUnit> {
  const aliases = new Map<string, DurationUnit>();

  for (const [alias, unit] of ASCII_ALIASES) {
    aliases.set(alias, unit);
  }

  for (const unit of Object.keys(UNIT_SECONDS) as DurationUnit[]) {
    for (const unitDisplay of ['short', 'long', 'narrow'] as const) {
      try {
        const rendered = new Intl.NumberFormat(numberingLocale(locale), {
          style: 'unit',
          unit,
          unitDisplay,
        }).format(1);
        const word = rendered.replace(/[0-9\u0660-\u0669\u06F0-\u06F9\s\u00A0]/g, '').toLowerCase();
        if (word !== '') aliases.set(word, unit);
      } catch {
        // A runtime without the unit data is not a reason to fail the screen;
        // the ASCII aliases above still parse everything the design shows.
      }
    }
  }

  return aliases;
}

/**
 * Seconds as the shortest whole unit that divides them exactly \u2014 86400 is
 * "24 h", not "1440 min". Rendered through `Intl`, so the unit word is CLDR's
 * and not a string this repository would have to translate nine times.
 */
export function formatDuration(locale: string, seconds: number): string {
  const unit: DurationUnit =
    seconds % UNIT_SECONDS.day === 0 && seconds >= UNIT_SECONDS.day
      ? 'day'
      : seconds % UNIT_SECONDS.hour === 0 && seconds >= UNIT_SECONDS.hour
        ? 'hour'
        : seconds % UNIT_SECONDS.minute === 0 && seconds >= UNIT_SECONDS.minute
          ? 'minute'
          : 'second';

  const value = seconds / UNIT_SECONDS[unit];
  try {
    return new Intl.NumberFormat(numberingLocale(locale), { style: 'unit', unit, unitDisplay: 'short' }).format(
      value,
    );
  } catch {
    return `${value}`;
  }
}

/**
 * `null` when the text is not a duration. The caller marks the field invalid \u2014
 * it does NOT guess, because guessing "2" means minutes turns a 2-second
 * first-response target into a contractual number nobody chose.
 */
export function parseDuration(locale: string, text: string): number | null {
  const normalised = normaliseDigits(text).trim().toLowerCase().replace(/\u00A0/g, ' ');
  const match = /^([0-9]+(?:[.,][0-9]+)?)\s*([^\s0-9]*)$/.exec(normalised);
  if (match === null) return null;

  const [, rawNumber = '', rawUnit = ''] = match;
  const amount = Number(rawNumber.replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = localeAliases(locale).get(rawUnit.replace(/[.]/g, ''));
  if (unit === undefined) return null;

  const seconds = Math.round(amount * UNIT_SECONDS[unit]);
  return seconds >= 1 ? seconds : null;
}

/** A percentage with one decimal, the way the contract sends SLA attainment. */
export function formatPercent(locale: string, value: number, decimals = 1): string {
  return new Intl.NumberFormat(numberingLocale(locale), {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value / 100);
}

export function formatCount(locale: string, value: number): string {
  return new Intl.NumberFormat(numberingLocale(locale)).format(value);
}

/**
 * A usage meter's own unit, rendered. `byte` is the only one that needs a
 * magnitude \u2014 the contract sends bytes and the design shows "312 GB" \u2014 and
 * `Intl` does the unit word so no catalogue key is invented for "GB".
 */
export function formatMeter(locale: string, value: number, unit: string): string {
  if (unit === 'byte') {
    const gigabytes = value / 1_000_000_000;
    return new Intl.NumberFormat(numberingLocale(locale), {
      style: 'unit',
      unit: 'gigabyte',
      unitDisplay: 'short',
      maximumFractionDigits: 0,
    }).format(gigabytes);
  }
  return formatCount(locale, value);
}

/**
 * Money, from minor units and an ISO code. **Never a hard-coded symbol** \u2014
 * `Intl` knows that `NGN` is `\u20A6` in `en-NG` and `NGN` in `de`, and guessing is
 * how a currency symbol ends up wrong in the one market that cares.
 */
export function formatMoney(locale: string, amountMinor: string, currency: string): string {
  const minor = Number(amountMinor);
  if (!Number.isFinite(minor)) return '';
  // Two minor digits for every currency in scope (NGN, GHS, KES, ZAR).
  return new Intl.NumberFormat(numberingLocale(locale), { style: 'currency', currency }).format(minor / 100);
}

/**
 * A timestamp in a NAMED zone. `CLAUDE.md` section 4: the database is UTC and
 * the edges convert explicitly. A BPO roster spans WAT, EAT and SAST, so "the
 * date" is never unambiguous and the zone is shown, not assumed.
 */
export function formatDateTime(locale: string, iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  // Day first and 24-hour in every English ("20 Oct 2026, 15:00"), T-0143.
  return tidyMonth(
    locale,
    dateFormatter(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      hourCycle: 'h23',
      ...(timeZone === undefined ? {} : { timeZone }),
    }).format(date),
  );
}

export function formatDate(locale: string, iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  // Day first in every English ("20 Oct 2026"), T-0143.
  return tidyMonth(
    locale,
    dateFormatter(locale, {
      dateStyle: 'medium',
      ...(timeZone === undefined ? {} : { timeZone }),
    }).format(date),
  );
}

/*
 * ---------------------------------------------------------------------------
 * THE DESIGN'S SHORT FORMS (T-0140)
 *
 * The admin export writes times as "27 Sep, 14:32 WAT" and periods as
 * "1–30 Sep 2026": day before month, a 24-hour clock and the zone by its
 * African name. ICU's English says "Sept" and "GMT+1", so English is assembled
 * from its parts; every other language keeps its own order and its own zone
 * convention ("UTC+1" in French). The zone is always named: a BPO roster spans
 * WAT, EAT and SAST, and a bare "14:32" is a time somebody acts on in the
 * wrong hour.
 * ---------------------------------------------------------------------------
 */

function english(locale: string): boolean {
  return /^en(-|$)/i.test(locale) && !/^en-XA$/i.test(locale);
}

function safeFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat('en', options);
  }
}

function partOf(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((entry) => entry.type === type)?.value ?? '';
}

/**
 * A zone as a person in the region says it: "WAT", "EAT", "SAST", in every
 * locale (`lib/zone-name.ts`, T-0144), else the locale's own offset.
 */
export function formatZone(locale: string, when: Date, timeZone?: string): string {
  return zoneAbbreviation(locale, when, timeZone);
}

/** "27 Sep, 14:32 WAT". `timeZone` unset means the reader's own zone. */
export function formatStamp(locale: string, iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const zone = timeZone === undefined ? {} : { timeZone };
  const parts = safeFormatter(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...zone,
  }).formatToParts(date);
  const clock = `${partOf(parts, 'hour')}:${partOf(parts, 'minute')}`;
  const name = formatZone(locale, date, timeZone);
  if (english(locale)) {
    const month = partOf(parts, 'month').replace(/^Sept$/, 'Sep');
    return `${partOf(parts, 'day')} ${month}, ${clock} ${name}`.trim();
  }
  const text = safeFormatter(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...zone,
  }).format(date);
  return `${text} ${name}`.trim();
}

/** "27 Sep", for a reset date. */
export function formatDayMonth(locale: string, date: Date, timeZone?: string): string {
  const zone = timeZone === undefined ? {} : { timeZone };
  const parts = safeFormatter(locale, { day: 'numeric', month: 'short', ...zone }).formatToParts(date);
  if (english(locale)) {
    return `${partOf(parts, 'day')} ${partOf(parts, 'month').replace(/^Sept$/, 'Sep')}`;
  }
  return safeFormatter(locale, { day: 'numeric', month: 'short', ...zone }).format(date);
}

/**
 * A usage period, "1–30 Sep 2026", from the contract's half-open
 * `[periodStart, periodEnd)`: the last day shown is the day before the end.
 * Billing periods are calendar months in UTC, so they are drawn in UTC; in
 * the reader's zone a 00:00Z boundary would land on the wrong day.
 */
export function formatPeriod(locale: string, startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(new Date(endIso).getTime() - 1);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
  // English in the day-month order the design writes ("1–30 Sep 2026").
  const text = safeFormatter(english(locale) ? 'en-GB' : locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).formatRange(start, end);
  return english(locale) ? text.replace(/\bSept\b/g, 'Sep') : text;
}

/**
 * Where today sits in a usage period: day `day` of `days`. `null` when today
 * is outside it, so the marker is not drawn rather than drawn wrong.
 */
export function periodProgress(
  startIso: string,
  endIso: string,
  now: Date = new Date(),
): { day: number; days: number } | null {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  const at = now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (at < start || at >= end) return null;
  const dayMs = 86_400_000;
  return { day: Math.floor((at - start) / dayMs) + 1, days: Math.round((end - start) / dayMs) };
}

/** A country's name in the reader's language, from its ISO 3166 code ("NG" → "Nigeria"). */
export function formatCountry(locale: string, code: string | null | undefined): string | null {
  if (code === null || code === undefined || code === '') return null;
  try {
    return new Intl.DisplayNames([locale, 'en'], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** True for a value that is an identifier rather than a name: a UUID or a bare hex id. */
export function looksLikeId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

/**
 * How long ago, the way the export writes it ("5 min ago", "2 hours ago",
 * "yesterday"); past a week, the day itself ("27 Sep"). English is set in
 * en-GB, whose short units have no full stop ("5 min ago", not "5 min. ago").
 */
export function formatAgo(locale: string, iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  const relativeLocale = english(locale) ? 'en-GB' : locale;
  // Minutes short ("5 min ago"), hours and days long ("2 hours ago"), as the export writes them.
  const relative = (style: 'short' | 'long'): Intl.RelativeTimeFormat => {
    try {
      return new Intl.RelativeTimeFormat(relativeLocale, { numeric: 'auto', style });
    } catch {
      return new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto', style });
    }
  };
  if (abs < 60) return relative('long').format(0, 'second');
  if (abs < 3_600) return relative('short').format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relative('long').format(Math.round(seconds / 3_600), 'hour');
  if (abs < 7 * 86_400) return relative('long').format(Math.round(seconds / 86_400), 'day');
  return formatDayMonth(locale, date);
}
