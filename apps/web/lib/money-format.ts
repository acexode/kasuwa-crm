/**
 * The live format preview on `P01/5.2`.
 *
 * NO CURRENCY SYMBOL IS TYPED IN THIS APP (CLAUDE.md section 4). The symbol,
 * its position, the grouping and the number of minor digits all come from
 * `Intl`, for the currency and a locale that writes it. A typed symbol is wrong
 * the first time a currency is formatted for a locale that places it
 * differently — and CFA francs have no minor unit at all.
 *
 * Money is minor units as a `bigint` plus an ISO code, never a float. The
 * fraction is spliced in from the integer remainder rather than by dividing to
 * a `number`, so a large balance does not lose its last kobo on the way to the
 * screen.
 */

export interface OnboardingCurrency {
  readonly code: string;
  /** A locale that conventionally writes this currency. Formatting only — not a UI language. */
  readonly formatLocale: string;
}

/** The six the design offers, in its order. */
export const ONBOARDING_CURRENCIES: readonly OnboardingCurrency[] = [
  { code: 'NGN', formatLocale: 'en-NG' },
  { code: 'GHS', formatLocale: 'en-GH' },
  { code: 'KES', formatLocale: 'en-KE' },
  { code: 'ZAR', formatLocale: 'en-ZA' },
  { code: 'XOF', formatLocale: 'fr-SN' },
  // en-NG, not en-US: an African workspace reads dollars as "US$" beside its
  // own currency, as the P01/5.2 board prints it (T-0131).
  { code: 'USD', formatLocale: 'en-NG' },
];

function currencyFormat(currency: OnboardingCurrency, fractionDigits?: number): Intl.NumberFormat {
  return new Intl.NumberFormat(currency.formatLocale, {
    style: 'currency',
    currency: currency.code,
    ...(fractionDigits === undefined
      ? {}
      : { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }),
  });
}

/** The symbol `Intl` uses for this currency in its own locale. */
export function currencySymbol(currency: OnboardingCurrency): string {
  return (
    currencyFormat(currency)
      .formatToParts(0)
      .find((part) => part.type === 'currency')?.value ?? currency.code
  );
}

/** How many minor digits this currency has, according to `Intl` (NGN 2, XOF 0). */
export function minorDigits(currency: OnboardingCurrency): number {
  return currencyFormat(currency).resolvedOptions().maximumFractionDigits ?? 2;
}

export function formatMinorUnits(minor: bigint, currency: OnboardingCurrency): string {
  const digits = minorDigits(currency);
  const scale = 10n ** BigInt(digits);
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const major = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(digits, '0');

  const parts = currencyFormat(currency, 0).formatToParts(negative ? -major : major);
  if (digits === 0) {
    return parts.map((part) => part.value).join('');
  }

  const decimal =
    currencyFormat(currency, 1)
      .formatToParts(1.5)
      .find((part) => part.type === 'decimal')?.value ?? '.';

  const lastInteger = parts.map((part) => part.type).lastIndexOf('integer');
  return parts
    .map((part, index) => (index === lastInteger ? `${part.value}${decimal}${fraction}` : part.value))
    .join('');
}
