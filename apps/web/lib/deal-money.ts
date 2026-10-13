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
 * language. Never compact: the design's abbreviated millions are overruled by
 * D-P19's exactness, so a column total reads to the last kobo.
 */

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(locale, options);
  } catch {
    return new Intl.NumberFormat('en', options);
  }
}

/** The currency's minor digits, as Intl knows them (NGN, GHS, KES and ZAR: 2). */
export function minorDigits(currency: string): number {
  return numberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/**
 * `amountMinor` (a decimal string of minor units) as the active language
 * writes it: `('en', '125050', 'GHS')` is "GH₵1,250.50" in Intl's own symbol.
 */
export function formatDealMoney(locale: string, amountMinor: string, currency: string): string {
  const digits = minorDigits(currency);
  const clean = /^\d+$/.test(amountMinor) ? amountMinor : '0';
  const padded = clean.padStart(digits + 1, '0');
  const whole = BigInt(padded.slice(0, padded.length - digits));
  const fraction = padded.slice(padded.length - digits);
  const format = numberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 });
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
