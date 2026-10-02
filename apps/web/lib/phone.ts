/**
 * The mobile-number field on `P01/3`.
 *
 * The design defaults the picker to Nigeria (+234) and lets it change. The
 * contract wants E.164 (`^\+[1-9][0-9]{6,14}$`), and people type the number the
 * way it is printed on a SIM pack — with the trunk `0` in front ("0803 555
 * 4567"). Sending that as `+2340803…` is a wrong number that still passes a
 * length check, so the trunk prefix is dropped here, once, with a test.
 *
 * Countries are the four markets the PRD names. Their NAMES come from the
 * catalogue (`signup.country.<code>`), not from here.
 */
export const SIGN_UP_COUNTRIES = [
  { code: 'NG', dial: '234' },
  { code: 'GH', dial: '233' },
  { code: 'KE', dial: '254' },
  { code: 'ZA', dial: '27' },
] as const;

export type SignUpCountry = (typeof SIGN_UP_COUNTRIES)[number]['code'];

export const DEFAULT_SIGN_UP_COUNTRY: SignUpCountry = 'NG';

const E164 = /^\+[1-9][0-9]{6,14}$/;

export function dialCode(country: SignUpCountry): string {
  return SIGN_UP_COUNTRIES.find((entry) => entry.code === country)?.dial ?? '';
}

/** `+<dial><national>` with the trunk `0` removed, or `null` if it cannot be a number. */
export function toE164(country: SignUpCountry, typed: string): string | null {
  const digits = typed.replace(/\D/g, '').replace(/^0+/, '');
  if (digits === '') return null;
  const candidate = `+${dialCode(country)}${digits}`;
  return E164.test(candidate) ? candidate : null;
}
