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
