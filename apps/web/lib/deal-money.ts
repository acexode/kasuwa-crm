import { numberingLocale } from './numbering';

/**
 * Deal money on the P06 board (T-0109, D-L88, D-P19): exact, in the
 * currency's own format, for the page's language.
 *
 * NEVER THROUGH A JS NUMBER. A deal holds up to 18 digits of minor units and a
 * column total up to 24; a number is exact only to 2^53 (16 digits). The
 * minor-unit string is split into whole and fraction as TEXT, the whole part
 * is formatted as a `BigInt` (exact at any size), and the fraction is spliced
 * in where Intl put the integer. `lib/admin-format.ts`'s `formatMoney`
 * divides a number by 100 and must never be used for a deal.
 *
 * NO CURRENCY SYMBOL IS WRITTEN HERE (CLAUDE.md 4). The symbol, its position,
 * the grouping and the minor digits all come from Intl, for the active
 * language. The symbol is Intl's NARROW one (`currencyDisplay: 'narrowSymbol'`),
 * so naira reads "₦31,000,000" as P06 draws it, not "NGN 31,000,000.00".
 *
 * THREE SHAPES (T-0135, D-L193). `formatDealMoney` is exact to the last kobo
 * (the deal header and key fields). `formatDealMoneyWhole` rounds to the major
 * unit, half up, by string arithmetic (the board cards and the list, which the
 * design draws without minor units). `formatDealMoneyCompact` is the design's
 * column-header short form ("₦40M", "₦15.9M"): a label, not an amount, so it
 * alone goes through a JS number, and an exact figure is always one step away.
 */

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(numberingLocale(locale), options);
  } catch {
    return new Intl.NumberFormat('en', options);
  }
}

/** The currency's minor digits, as Intl knows them (NGN, GHS, KES and ZAR: 2). */
export function minorDigits(currency: string): number {
  return numberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** Thrown for an amount that is not a run of digits: it is never drawn as a zero (R5). */
export class UnreadableAmountError extends Error {
  constructor() {
    super('The amount is not a decimal string of minor units');
    this.name = 'UnreadableAmountError';
  }
}

/**
 * The language's own digits for 0 to 9 (Arabic-Indic for `ar`, Latin for
 * most), each formatted alone: a single digit is exact as any number.
 */
function digitSet(locale: string): readonly string[] {
  const format = numberFormat(locale, { useGrouping: false, maximumFractionDigits: 0 });
  return Array.from({ length: 10 }, (_, digit) => format.format(digit));
}

/**
 * `amountMinor` (a decimal string of minor units) as the active language
 * writes it: `('en', '125050', 'GHS')` is Intl's own cedi mark followed by
 * "1,250.50" — exactly what `Intl.NumberFormat('en', { style: 'currency',
 * currency: 'GHS' })` draws for 1250.50, but without passing through a JS
 * number — and the fraction is written in the same digits as the whole part. Throws
 * `UnreadableAmountError` for anything but a digit run.
 */
export function formatDealMoney(locale: string, amountMinor: string, currency: string): string {
  if (!/^\d+$/.test(amountMinor)) throw new UnreadableAmountError();
  const digits = minorDigits(currency);
  const padded = amountMinor.padStart(digits + 1, '0');
  const whole = BigInt(padded.slice(0, padded.length - digits));
  const native = digitSet(locale);
  const fraction = Array.from(padded.slice(padded.length - digits), (digit) => native[digit.charCodeAt(0) - 48] ?? digit).join('');
  const format = numberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const parts = format.formatToParts(whole);
  if (digits === 0) {
    return parts.map((part) => part.value).join('');
  }
  const decimal =
    numberFormat(locale, { minimumFractionDigits: 1 })
      .formatToParts(1.5)
      .find((part) => part.type === 'decimal')?.value ?? '.';
  const lastInteger = parts.map((part) => part.type).lastIndexOf('integer');
  return parts.map((part, index) => (index === lastInteger ? `${part.value}${decimal}${fraction}` : part.value)).join('');
}

/** The major units of `amountMinor`, rounded half up, as a BigInt: exact at any size. */
function wholeUnits(amountMinor: string, currency: string): bigint {
  if (!/^\d+$/.test(amountMinor)) throw new UnreadableAmountError();
  const digits = minorDigits(currency);
  if (digits === 0) return BigInt(amountMinor);
  const padded = amountMinor.padStart(digits + 1, '0');
  const whole = BigInt(padded.slice(0, padded.length - digits));
  const first = padded.charCodeAt(padded.length - digits) - 48;
  return first >= 5 ? whole + 1n : whole;
}

/**
 * `amountMinor` rounded to the major unit (half up), with Intl's narrow
 * symbol: "₦31,000,000". The board's cards and the list's amounts (P06/01,
 * P06/03). Never through a JS number.
 */
export function formatDealMoneyWhole(locale: string, amountMinor: string, currency: string): string {
  const whole = wholeUnits(amountMinor, currency);
  return numberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(whole);
}

/**
 * The design's short form for a column header or a summary: "₦40M",
 * "₦15.9M", "₦340K" (P06/01). Intl's compact notation for the language, at
 * most one decimal. A label, so a JS number is fine here: the exact figure is
 * on the cards and the list.
 */
export function formatDealMoneyCompact(locale: string, amountMinor: string, currency: string): string {
  const whole = wholeUnits(amountMinor, currency);
  return numberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    notation: 'compact',
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(Number(whole));
}

/** DealMoney's ceiling: at most 18 digits of minor units, no leading zero. */
const MAX_MINOR_DIGITS = 18;

/**
 * A typed amount in MAJOR units ("1250.5", "." as the decimal point, at most
 * the currency's minor digits) as DealMoney's minor-unit string ("125050"),
 * by string arithmetic alone. `null` for anything else: a sign, a grouping
 * comma, letters, too many decimals, or more than 18 digits of minor units.
 */
export function parseMajorAmount(input: string, digits: number): string | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (match === null) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > digits) return null;
  const minor = `${match[1] ?? ''}${fraction.padEnd(digits, '0')}`.replace(/^0+(?=\d)/, '');
  return minor.length > MAX_MINOR_DIGITS ? null : minor;
}

/**
 * A minor-unit string as the text an amount input is seeded with, in MAJOR
 * units with "." (`'1500000015', 2` is "15000000.15"; a whole amount drops its
 * zero fraction: `'1650000000', 2` is "16500000"), by string arithmetic alone.
 * `parseMajorAmount` reads it back to the same string.
 */
export function minorToMajorText(amountMinor: string, digits: number): string {
  if (!/^\d+$/.test(amountMinor)) return '';
  if (digits === 0) return amountMinor.replace(/^0+(?=\d)/, '');
  const padded = amountMinor.padStart(digits + 1, '0');
  const whole = padded.slice(0, padded.length - digits).replace(/^0+(?=\d)/, '');
  const fraction = padded.slice(padded.length - digits);
  return /^0+$/.test(fraction) ? whole : `${whole}.${fraction}`;
}
