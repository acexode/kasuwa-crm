/**
 * Phone search normalisation (T-0041).
 *
 * `q` on the contacts list is "name or number". A number can arrive the way a
 * person types it - `0803 123 4567`, `2348031234567`, `+234 803 123 4567` - and
 * contacts store E.164 only, so the number is normalised with the TENANT'S
 * default country before matching. A Kenyan tenant's `0712 345 021` is
 * `+254712345021`, a Nigerian tenant's `0803...` is `+234803...`.
 *
 * Pure, so every rule is unit-tested without a database. Nothing here logs:
 * every input is a phone number.
 */

/** The countries Kasuwa prices in today (CLAUDE.md 1), with their calling codes. */
export const CALLING_CODES = {
  NG: '234',
  GH: '233',
  KE: '254',
  ZA: '27',
} as const;

export type DefaultCountry = keyof typeof CALLING_CODES;

const CURRENCY_COUNTRY: Readonly<Record<string, DefaultCountry>> = {
  NGN: 'NG',
  GHS: 'GH',
  KES: 'KE',
  ZAR: 'ZA',
};

function isDefaultCountry(value: string): value is DefaultCountry {
  return Object.prototype.hasOwnProperty.call(CALLING_CODES, value);
}

/**
 * The tenant's default country: the region of its default locale (`en-NG`)
 * when that names a country we dial, else the country of its default
 * currency (`KES` -> KE), else null (no national-format matching at all).
 */
export function tenantDefaultCountry(tenant: {
  localeDefault: string | null;
  currencyDefault: string | null;
}): DefaultCountry | null {
  const region = /^[A-Za-z]{2,3}[-_]([A-Za-z]{2})$/.exec(tenant.localeDefault ?? '')?.[1];
  if (region !== undefined) {
    const upper = region.toUpperCase();
    if (isDefaultCountry(upper)) return upper;
  }
  const currency = (tenant.currencyDefault ?? '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(CURRENCY_COUNTRY, currency)
    ? (CURRENCY_COUNTRY[currency] ?? null)
    : null;
}

/** The contract's Phone.e164 pattern. */
export const E164 = /^\+[1-9][0-9]{6,14}$/;

/** What a typed number may contain: digits, one leading +, and separators. */
const PHONE_LIKE = /^\+?[0-9][0-9\s\-().]*$/;

/**
 * The E.164 form of `q` if it reads as a phone number, else null.
 *
 *   - `+234 803 123 4567` -> `+2348031234567` (separators dropped)
 *   - `00234...`          -> `+234...` (international prefix)
 *   - `0803 123 4567`     -> `+234` + `8031234567` (trunk 0 dropped)
 *   - `2348031234567`     -> `+2348031234567` (already carries the code)
 *   - `8031234567`        -> `+2348031234567` (national significant number)
 *
 * A `q` with letters, wildcards or fewer than seven digits is not a number.
 */
export function phoneSearchE164(q: string, country: DefaultCountry | null): string | null {
  const text = q.trim();
  if (!PHONE_LIKE.test(text)) return null;
  const digits = text.replace(/[^0-9]/g, '');
  if (digits.length < 7) return null;
  let candidate: string;
  if (text.startsWith('+')) {
    candidate = `+${digits}`;
  } else if (digits.startsWith('00')) {
    candidate = `+${digits.slice(2)}`;
  } else if (country === null) {
    candidate = `+${digits}`;
  } else {
    const code = CALLING_CODES[country];
    if (digits.startsWith('0')) {
      candidate = `+${code}${digits.slice(1)}`;
    } else if (digits.startsWith(code) && digits.length - code.length >= 7) {
      candidate = `+${digits}`;
    } else {
      candidate = `+${code}${digits}`;
    }
  }
  return E164.test(candidate) ? candidate : null;
}

/**
 * Case- and diacritic-folding for the name half of `q`, matching the SQL
 * `fold()` in the repository: NFD, drop combining marks (U+0300-U+036F), lower
 * case. `Adébáyọ̀` and `adebayo` fold to the same string.
 */
export function foldForSearch(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * The shortest national significant number a WHOLE number may have (T-0086
 * suite R10): six digits or fewer, after the trunk 0 or the country code, is
 * a partial number for every country Kasuwa dials, never a whole one.
 */
const MIN_NATIONAL_DIGITS = 7;
/** The longest national significant number of the countries in CALLING_CODES. */
const MAX_NATIONAL_DIGITS = 10;
/** A country code is 1-3 digits: an unknown one needs at least 3 + MIN_NATIONAL_DIGITS. */
const MIN_INTERNATIONAL_DIGITS = 3 + MIN_NATIONAL_DIGITS;

/** The calling code `digits` (no `+`) starts with, among the countries Kasuwa dials. */
function knownCallingCode(digits: string): string | null {
  for (const code of Object.values(CALLING_CODES)) {
    if (digits.startsWith(code)) return code;
  }
  return null;
}

/** `+<digits>` for an international number, when it is one whole number. */
function wholeInternational(digits: string): string | null {
  const code = knownCallingCode(digits);
  if (code !== null) {
    // `+234 (0) 803 ...`: the trunk 0 some people keep after the code.
    const rest = digits.slice(code.length);
    const national = rest.startsWith('0') ? rest.slice(1) : rest;
    return wholeNational(code, national);
  }
  if (digits.length < MIN_INTERNATIONAL_DIGITS) return null;
  const candidate = `+${digits}`;
  return E164.test(candidate) ? candidate : null;
}

function wholeNational(code: string, national: string): string | null {
  if (national.length < MIN_NATIONAL_DIGITS || national.length > MAX_NATIONAL_DIGITS) return null;
  if (national.startsWith('0')) return null;
  const candidate = `+${code}${national}`;
  return E164.test(candidate) ? candidate : null;
}

/**
 * The E.164 form of ONE WHOLE phone number, or null (lookupRecords, T-0086).
 *
 * Stricter than `phoneSearchE164`, which reads seven typed digits as a number
 * because a list's `q` is a substring search anyway: an exact lookup must
 * never turn a partial number into a different, shorter whole one
 * (`0803 456` is not `+234803456`; R10). So:
 *
 *   - only digits, one leading `+`, spaces and `( ) - .` are accepted;
 *   - `+<digits>` and `00<digits>` are international; any other form is
 *     national in the tenant's default country: a trunk `0`, or the country
 *     code typed without the `+`, or the national significant number alone;
 *   - the national significant number is 7 to 10 digits and never starts
 *     with 0, for the countries in CALLING_CODES; an international number
 *     under any other code needs at least 10 digits in all;
 *   - with no default country, a national form is never a whole number.
 *
 * Pure. Nothing here logs: every input is a phone number.
 */
export function wholePhoneE164(input: string, country: DefaultCountry | null): string | null {
  const compact = input.trim().replace(/[ ().-]/g, '');
  if (!/^\+?[0-9]+$/.test(compact)) return null;
  if (compact.startsWith('+')) return wholeInternational(compact.slice(1));
  if (compact.startsWith('00')) return wholeInternational(compact.slice(2));
  if (country === null) return null;
  const code = CALLING_CODES[country];
  if (compact.startsWith('0')) return wholeNational(code, compact.slice(1));
  if (compact.startsWith(code)) {
    const withCode = wholeNational(code, compact.slice(code.length));
    if (withCode !== null) return withCode;
  }
  return wholeNational(code, compact);
}
