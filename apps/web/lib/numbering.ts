/**
 * The digits a language writes numbers in, decided HERE and not by the host.
 *
 * Which numbering system a bare locale defaults to is the host's ICU data, not
 * ours: older ICU writes `ar` in Arabic-Indic digits, newer ICU (Node 22, the
 * Windows runner) in Latin ones, so the same page read differently on two
 * machines. The app's rule is the one P01 drew: Arabic-Indic for Arabic,
 * Latin everywhere else. A locale that already names its numbering system
 * (`-u-nu-`) keeps it.
 *
 * Pass the result to `Intl.NumberFormat` in place of the bare locale. An
 * unknown locale still throws there, as before, for the caller's fallback.
 */
export function numberingLocale(locale: string): string {
  if (/-u-(?:[a-z0-9]+-)*nu-/i.test(locale)) return locale;
  const arabic = locale.split('-')[0]?.toLowerCase() === 'ar';
  const system = arabic ? 'arab' : 'latn';
  return locale.includes('-u-') ? `${locale}-nu-${system}` : `${locale}-u-nu-${system}`;
}
