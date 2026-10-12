import type { DueRange } from '@kasuwa/domain-core';

/**
 * listMyActivities' buckets (T-0082, D-L105; records.openapi.yaml
 * `ActivityBucket` and the `TimeZone` parameter), computed by the SERVER at
 * one instant in the caller's IANA zone:
 *
 *   overdue   dueAt < now
 *   today     now <= dueAt < M, M the first local midnight after now
 *   upcoming  dueAt >= M, then every undated task
 *
 * Midnight follows the zone's own rules, so "today" is not always 24 hours
 * (a DST change makes it 23 or 25), and in a zone whose clocks jump over
 * midnight (America/Santiago, America/Havana on their spring-forward days)
 * the next day starts at the first instant that exists, 01:00 local.
 *
 * Pure: no clock is read here (the caller passes its instant) and nothing is
 * logged. The zone is looked up by NAME in the runtime's IANA database
 * (Intl), never used as a file path, and never replaced by UTC or a default.
 */

export const ACTIVITY_BUCKETS = ['overdue', 'today', 'upcoming'] as const;
export type ActivityBucket = (typeof ACTIVITY_BUCKETS)[number];

/** The contract's `TimeZone` pattern and maxLength, verbatim. */
const TIME_ZONE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z0-9_+-]+){0,2}$/;
const TIME_ZONE_MAX_LENGTH = 64;

let canonicalZones: ReadonlySet<string> | null = null;

function canonical(): ReadonlySet<string> {
  canonicalZones ??= new Set(Intl.supportedValuesOf('timeZone'));
  return canonicalZones;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A formatter for `zone`, or `null` when the runtime does not know the name. */
function formatterFor(zone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(zone);
  if (cached !== undefined) return cached;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return null;
  }
  // Bounded: only names that passed the checks below are ever cached.
  if (formatters.size < 1024) formatters.set(zone, format);
  return format;
}

/**
 * True for an IANA zone NAME the runtime's database knows: a canonical name
 * (`Africa/Lagos`), a backward link with a region (`Asia/Kolkata`,
 * `US/Pacific`), or `UTC`. Refused, whatever Intl would accept: an
 * abbreviation or a legacy three-letter id (`WAT`, `EAT`, `EST`: ICU maps
 * some of these to a city, the IANA database does not name them), an offset
 * (`+01:00`, `UTC+1`), a path (`../`), whitespace, a NUL, an empty value,
 * and a name not written as the database writes it (each part starts with a
 * capital letter).
 */
export function isIanaTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > TIME_ZONE_MAX_LENGTH) return false;
  if (!TIME_ZONE_PATTERN.test(value)) return false;
  if (value === 'UTC' || canonical().has(value)) return formatterFor(value) !== null;
  if (!value.includes('/')) return false;
  if (!value.split('/').every((part) => /^[A-Z]/.test(part))) return false;
  return formatterFor(value) !== null;
}

/** The zone did not resolve. `isIanaTimeZone` makes this unreachable from the API. */
export class UnknownTimeZoneError extends Error {
  constructor() {
    super('Unknown time zone');
    this.name = 'UnknownTimeZoneError';
  }
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(format: Intl.DateTimeFormat, ms: number): Wall {
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(ms)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts['year'] ?? Number.NaN,
    month: parts['month'] ?? Number.NaN,
    day: parts['day'] ?? Number.NaN,
    hour: parts['hour'] ?? Number.NaN,
    minute: parts['minute'] ?? Number.NaN,
    second: parts['second'] ?? Number.NaN,
  };
}

/** A local calendar date as one comparable number. */
const dayKey = (wall: Wall) => wall.year * 10_000 + wall.month * 100 + wall.day;

/** Wall time minus UTC at `ms`, in ms (offsets are whole seconds). */
function offsetAt(format: Intl.DateTimeFormat, ms: number): number {
  const wall = wallClock(format, ms);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const SEARCH_SPAN = 50 * 60 * 60 * 1000;

/**
 * The first instant strictly after `nowMs` whose local date (in `zone`) is
 * later than the local date at `nowMs`: the next local midnight, or the first
 * instant of the next day when the zone skips midnight. In UTC ms.
 */
export function nextLocalMidnight(zone: string, nowMs: number): number {
  const format = formatterFor(zone);
  if (format === null) throw new UnknownTimeZoneError();
  const today = dayKey(wallClock(format, nowMs));
  const isLater = (ms: number) => dayKey(wallClock(format, ms)) > today;

  // The common case: midnight exists. Solve wall(t) = next day 00:00 by
  // fixed-point on the offset, then confirm the answer is the FIRST such
  // instant (the day before it is still today).
  const now = wallClock(format, nowMs);
  const target = Date.UTC(now.year, now.month - 1, now.day + 1);
  let guess = target - offsetAt(format, target);
  for (let step = 0; step < 3; step += 1) guess = target - offsetAt(format, guess);
  const at = wallClock(format, guess);
  if (
    guess > nowMs &&
    at.hour === 0 &&
    at.minute === 0 &&
    at.second === 0 &&
    isLater(guess) &&
    !isLater(guess - 1)
  ) {
    return guess;
  }

  // No local midnight (the clocks jumped over it), or an unusual offset
  // history: the smallest later instant whose date is later, by bisection.
  let low = nowMs; // never later
  let high = nowMs + SEARCH_SPAN; // always later: two days on
  if (!isLater(high)) throw new UnknownTimeZoneError();
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (isLater(middle)) high = middle;
    else low = middle;
  }
  return high;
}

/** The due-time range of `bucket` at the server's instant `nowMs`, in `zone`. */
export function bucketRange(bucket: ActivityBucket, zone: string, nowMs: number): DueRange {
  const now = new Date(nowMs);
  switch (bucket) {
    case 'overdue':
      return { from: null, to: now, undated: false };
    case 'today':
      return { from: now, to: new Date(nextLocalMidnight(zone, nowMs)), undated: false };
    case 'upcoming':
      return { from: new Date(nextLocalMidnight(zone, nowMs)), to: null, undated: true };
  }
}
