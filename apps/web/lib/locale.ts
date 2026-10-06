import { cookies, headers } from 'next/headers';
import {
  BETA_LOCALES,
  DEFAULT_LOCALE,
  MENU_LOCALES,
  PSEUDO_LOCALE,
  REGISTERED_LOCALES,
  SUPPORTED_LOCALES,
  createTranslator,
  localeLabel,
  textDirection,
  type TextDirection,
} from '@kasuwa/i18n';

/**
 * Which language a request renders in.
 *
 * Three lists, and the differences between them are the whole point (see
 * `packages/i18n/CLAUDE.md`):
 *
 *   SUPPORTED_LOCALES  — finished AND attested: complete catalogue plus a named
 *                        reviewer's sign-off. Today that is `en` and `en-NG`.
 *   BETA_LOCALES       — finished but NOT attested (D-P1, answered 2026-10-03):
 *                        every id translated, no reviewer yet. Offered, with a
 *                        Beta badge and a "help improve this translation" link.
 *                        Today the six drafts.
 *   MENU_LOCALES       — the two above, in the design's order: the menu.
 *   REGISTERED_LOCALES — the inventory. Includes `ar`, which exists so RTL can
 *                        be exercised against real strings and is deliberately
 *                        not on any menu.
 *
 * The cookie may only ever hold a MENU locale, because only the menu can set
 * it. A Beta language is complete by construction, so choosing one never
 * produces an English form. The preview header — set by `middleware.ts` from
 * `?locale=` — is limited to REGISTERED locales, renders once and persists
 * nothing. It is how
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

  // `en-XA` is derived, not registered, and previewable for the same reason as
  // `ar`: a check (strings never externalised) that needs a real screen.
  if (preview !== null && (REGISTERED_LOCALES.includes(preview) || preview === PSEUDO_LOCALE)) {
    return { locale: preview, dir: textDirection(preview), preview: true };
  }

  const store = await cookies();
  const chosen = store.get(LOCALE_COOKIE)?.value ?? '';
  const locale = MENU_LOCALES.includes(chosen) ? chosen : DEFAULT_LOCALE;

  return { locale, dir: textDirection(locale), preview: false };
}

/** Where the menu's "help improve this translation" link goes (`app/translations`). */
export const TRANSLATION_HELP_PATH = '/translations';

/** One language-menu entry, as `components/auth/language-menu.tsx` renders it. */
export interface MenuLanguage {
  readonly code: string;
  readonly label: string;
  /** Present only for a Beta language; both strings are in the UI's locale. */
  readonly beta?: { readonly badge: string; readonly help: string; readonly href: string };
}

/**
 * The language menu for a page rendered in `locale`, built on the SERVER.
 *
 * Every entry is an endonym from `localeLabel()`. A Beta entry carries its
 * badge and link text already resolved in the UI's language, so the client
 * menu imports no catalogue and decides nothing: which languages are Beta is
 * read from the review files by `@kasuwa/i18n`, and a reviewer's sign-off
 * moves one off this list without an edit here.
 *
 * `SUPPORTED_LOCALES` languages never carry a badge, and nothing outside
 * `MENU_LOCALES` is ever listed.
 */
export function languageOptions(locale: string): MenuLanguage[] {
  const t = createTranslator(locale);
  const beta = {
    badge: t.t('lang.beta'),
    help: t.t('lang.beta.help'),
    href: TRANSLATION_HELP_PATH,
  };
  return MENU_LOCALES.map((code) =>
    BETA_LOCALES.includes(code) && !SUPPORTED_LOCALES.includes(code)
      ? { code, label: localeLabel(code), beta }
      : { code, label: localeLabel(code) },
  );
}
