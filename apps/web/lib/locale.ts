import { cookies, headers } from 'next/headers';
import {
  DEFAULT_LOCALE,
  REGISTERED_LOCALES,
  SUPPORTED_LOCALES,
  textDirection,
  type TextDirection,
} from '@kasuwa/i18n';

/**
 * Which language a request renders in.
 *
 * Two lists, and the difference between them is the whole point (see
 * `packages/i18n/CLAUDE.md`):
 *
 *   SUPPORTED_LOCALES  — the menu. Derived from catalogue completeness plus a
 *                        named reviewer. Today that is `en` and `en-NG`; six
 *                        more are finished and held back on D-P1.
 *   REGISTERED_LOCALES — the inventory. Includes `ar`, which exists so RTL can
 *                        be exercised against real strings and is deliberately
 *                        not on any menu.
 *
 * The cookie may only ever hold an OFFERED locale, because only the menu can
 * set it. The preview header — set by `middleware.ts` from `?locale=` — is
 * limited to REGISTERED locales, renders once and persists nothing. It is how
 * `dir="rtl" lang="ar"` gets proven on a real screen rather than on a specimen,
 * which is the reason Arabic is in the repository at all.
 */

export const LOCALE_COOKIE = 'kasuwa_locale';
export const PREVIEW_LOCALE_HEADER = 'x-kasuwa-preview-locale';

export interface ActiveLocale {
  readonly locale: string;
  readonly dir: TextDirection;
  /** True when the locale came from `?locale=` rather than from the menu. */
  readonly preview: boolean;
}

export async function activeLocale(): Promise<ActiveLocale> {
  const requestHeaders = await headers();
  const preview = requestHeaders.get(PREVIEW_LOCALE_HEADER);

  if (preview !== null && REGISTERED_LOCALES.includes(preview)) {
    return { locale: preview, dir: textDirection(preview), preview: true };
  }

  const store = await cookies();
  const chosen = store.get(LOCALE_COOKIE)?.value ?? '';
  const locale = SUPPORTED_LOCALES.includes(chosen) ? chosen : DEFAULT_LOCALE;

  return { locale, dir: textDirection(locale), preview: false };
}
