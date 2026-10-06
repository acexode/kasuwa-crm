import { cookies, headers } from 'next/headers';
import { flagProcessNodeEnv, type FlagProcessNodeEnv } from '@kasuwa/config/feature-flags';
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

/** The process's NODE_ENV, as `@kasuwa/config` parses it. */
export type LocaleNodeEnv = FlagProcessNodeEnv;

/** Everything a request contributes to its locale, already read out of it. */
export interface LocaleRequest {
  /** The `x-kasuwa-preview-locale` header (`PREVIEW_LOCALE_HEADER`), or null. */
  readonly preview: string | null;
  /** The `kasuwa_locale` cookie (`LOCALE_COOKIE`), or null. */
  readonly cookie: string | null;
  /** NODE_ENV, read at RUNTIME by the caller (see `activeLocale`). */
  readonly nodeEnv: LocaleNodeEnv;
}

/**
 * The environments in which `en-XA` may be previewed (D-P15, answered): the
 * pseudo-locale is a development and test tool, and production refuses it.
 * An allowlist, so that anything else fails closed.
 */
const PSEUDO_PREVIEW_ENVS: readonly LocaleNodeEnv[] = ['development', 'test'];

/**
 * Whether a preview value may be honoured. The match is EXACT: no trimming,
 * case-folding or `_`-to-`-` normalisation, because each of those would be a
 * second spelling of `en-XA` for the production gate to miss.
 *
 * `ar` is registered and previews in every environment: RTL is proven on a
 * real screen, in production too. `en-XA` is derived, not registered, and
 * previewable only where `PSEUDO_PREVIEW_ENVS` says.
 */
function previewAllowed(preview: string, nodeEnv: LocaleNodeEnv): boolean {
  if (REGISTERED_LOCALES.includes(preview)) {
    return true;
  }
  return preview === PSEUDO_LOCALE && PSEUDO_PREVIEW_ENVS.includes(nodeEnv);
}

/**
 * Which language a request renders in, as a pure function of what the request
 * carries. No `next/headers`, no environment read: `activeLocale()` reads both
 * and passes them in, which is what makes this testable for every NODE_ENV.
 *
 * The gate is here, not in `middleware.ts`, because the middleware forwards
 * every incoming header: a client can send `x-kasuwa-preview-locale: en-XA`
 * with no `?locale=` at all. A refused preview is treated exactly as an absent
 * one, so it falls through to the cookie rather than discarding the user's
 * menu choice.
 */
export function resolveActiveLocale(request: LocaleRequest): ActiveLocale {
  const { preview, cookie, nodeEnv } = request;
  if (preview !== null && previewAllowed(preview, nodeEnv)) {
    return { locale: preview, dir: textDirection(preview), preview: true };
  }

  const chosen = cookie ?? '';
  const locale = MENU_LOCALES.includes(chosen) ? chosen : DEFAULT_LOCALE;
  return { locale, dir: textDirection(locale), preview: false };
}

/**
 * The request's locale. Reads the preview header, the cookie and NODE_ENV,
 * and decides nothing itself.
 *
 * NODE_ENV is read at RUNTIME through `@kasuwa/config/feature-flags`, the same
 * `.env`-free read the feature-flag boot guard uses. Never as a literal
 * `process.env.NODE_ENV`: Next inlines that at build time, the build is always
 * `production`, and the e2e server is that build started with NODE_ENV=test
 * (D-L64). An inlined read would refuse `en-XA` there and fail `@p04-pseudo`.
 */
export async function activeLocale(): Promise<ActiveLocale> {
  const requestHeaders = await headers();
  const store = await cookies();
  return resolveActiveLocale({
    preview: requestHeaders.get(PREVIEW_LOCALE_HEADER),
    cookie: store.get(LOCALE_COOKIE)?.value ?? null,
    nodeEnv: flagProcessNodeEnv(),
  });
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
