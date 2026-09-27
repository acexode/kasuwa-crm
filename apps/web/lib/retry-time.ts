/**
 * Renders "you can try again at ..." for `P01/1b`.
 *
 * THE ZONE IS NOT OPTIONAL. "Try again in 15 minutes" is useless to someone
 * whose phone clock is in a different zone from the tenant, and BPO rosters
 * routinely span WAT, EAT and SAST — an agent in Nairobi working a Lagos
 * programme is the normal case here, not an edge one. The contract sends an
 * IANA zone alongside `retryAt` for exactly this line, and the lockout
 * acceptance test asserts that both arrive.
 *
 * Conversion is explicit (`CLAUDE.md` section 4: dates are UTC in the database,
 * converted at the edges). `Intl.DateTimeFormat` does the arithmetic, including
 * the abbreviation, so nothing here maintains a table of zone names.
 */
/**
 * An index signature as well as the two named fields, so the result can be
 * handed straight to an ICU message without being copied field by field — and
 * so adding a third part later cannot silently stop reaching the sentence.
 */
export interface RetryTimeParts {
  readonly [part: string]: string;
  /** The local wall-clock time, e.g. "14:47". */
  readonly time: string;
  /** The zone as a person would say it, e.g. "WAT" — or the IANA id if unknown. */
  readonly zone: string;
}

export function formatRetryTime(
  retryAt: string,
  timeZone: string | undefined,
  locale: string,
): RetryTimeParts {
  const when = new Date(retryAt);

  // A malformed date must not render "Invalid Date" at a user. Falling back to
  // the raw value at least gives support something to work from.
  if (Number.isNaN(when.getTime())) {
    return { time: retryAt, zone: timeZone ?? '' };
  }

  const options: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone === undefined ? {} : { timeZone }),
  };

  let time: string;
  let zone: string;
  try {
    time = new Intl.DateTimeFormat(locale, options).format(when);
    zone =
      new Intl.DateTimeFormat(locale, { ...options, timeZoneName: 'short' })
        .formatToParts(when)
        .find((part) => part.type === 'timeZoneName')?.value ?? (timeZone ?? '');
  } catch {
    // An unknown IANA id throws rather than guessing. Showing UTC and saying so
    // is honest; showing a local time under a zone name we could not resolve is
    // the failure this whole function exists to avoid.
    time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(when);
    zone = 'UTC';
  }

  return { time, zone };
}
