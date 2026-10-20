import { IntlMessageFormat } from 'intl-messageformat';
import { DEFAULT_LOCALE, PSEUDO_LOCALE, fallbackChain } from './bundle';
import { DESIGN_MENU_LOCALES, LOCALE_SOURCES } from './catalogues';
import { deriveBetaLocales, deriveSupportedLocales, localeReadiness } from './completeness';
import { pseudoCatalogue } from './pseudo';
import type { Catalogue, MessageId } from './message-id';
import type { MessageBundle, ParsedMessage, Translator } from './bundle';
import en from './locales/en.json';

/**
 * ICU MessageFormat catalogues, the fallback chain, and the gate that decides
 * which languages are offered at all.
 *
 * `en` is the complete catalogue and the source for extraction. `en-NG` is an
 * overlay holding only the strings that differ — which is the whole point of a
 * fallback chain.
 *
 * `en-XA` is the pseudo-locale. It is GENERATED (pnpm i18n:pseudo), gitignored,
 * and built in CI. Its job is to make two classes of bug visible at a glance:
 * strings that were never externalised (they stay in plain English) and layouts
 * that break when translations run ~35% longer than English.
 *
 * ---------------------------------------------------------------------------
 * SUPPORTED_LOCALES IS DERIVED, NOT KEPT (T-0009)
 *
 *   Shipping a menu entry that falls back to English is worse than offering
 *   fewer languages.
 *
 * A hand-maintained list drifts, and one direction of drift ships the bug:
 * somebody adds the constant ahead of the catalogue to "unblock the menu", and
 * a Hausa speaker who picks Hausa gets an English form — told, in the most
 * concrete way available, that the menu was decoration.
 *
 * So the list is computed by `completeness.ts` from the catalogues themselves.
 * Adding a language to the menu is not an edit here; it is finishing and
 * attesting its catalogue. See `localeReadiness(locale).problems` for exactly
 * what a locale is missing.
 * ---------------------------------------------------------------------------
 */

/**
 * The client-safe half of this package lives in `./bundle` and is re-exported
 * here so server code has one name for everything. A `'use client'` module must
 * import `@kasuwa/i18n/bundle` directly: anything importing THIS file pulls
 * every catalogue in the repository with it. See the note in `bundle.ts`.
 */
export {
  DEFAULT_LOCALE,
  PSEUDO_LOCALE,
  LOCALE_LABELS,
  createBundleTranslator,
  fallbackChain,
  localeLabel,
  textDirection,
} from './bundle';
export type { MessageBundle, ParsedMessage, TextDirection, Translator } from './bundle';

/**
 * Derived. Do not turn this back into a literal: an incomplete locale would be
 * one keystroke from the menu, and the acceptance suite asserts the shape of
 * this declaration for that reason.
 */
export const SUPPORTED_LOCALES: readonly string[] = deriveSupportedLocales();

/**
 * Complete but unattested menu languages (D-P1): offered, with a Beta badge
 * and a "help improve this translation" link. Derived, like the list above,
 * and disjoint from it — a sign-off moves a language across, nothing else.
 */
export const BETA_LOCALES: readonly string[] = deriveBetaLocales();

/**
 * Everything the language menu lists, in the design's order: the attested and
 * the Beta languages, then any attested regional overlay (`en-NG`) after the
 * languages the design names.
 */
export const MENU_LOCALES: readonly string[] = [
  ...DESIGN_MENU_LOCALES.filter(
    (locale) => SUPPORTED_LOCALES.includes(locale) || BETA_LOCALES.includes(locale),
  ),
  ...SUPPORTED_LOCALES.filter(
    (locale) => !(DESIGN_MENU_LOCALES as readonly string[]).includes(locale),
  ),
];

export type SupportedLocale = string;

export type { Catalogue, MessageId } from './message-id';

/**
 * Every catalogue in the repository — which is NOT the same set as the offered
 * ones. Arabic is registered and unoffered on purpose: RTL is a layout mode,
 * not a translation, and proving it needs real strings to render. Registration
 * is what makes `dir="rtl" lang="ar"` renderable; offering is what puts a
 * language in front of a user, and only completeness does that.
 */
const BASE: Record<string, Catalogue> = Object.fromEntries(
  Object.entries(LOCALE_SOURCES).map(([locale, entry]) => [locale, entry.messages as Catalogue]),
);

/**
 * The pseudo-locale, DERIVED from `en` on first use (T-0042). Nothing ever
 * called the old `registerPseudoCatalogue`, so `?locale=en-XA` silently
 * rendered English and the check it exists for could not run. Deriving it
 * costs one pass over `en` on the server, never ships a catalogue to the
 * browser, and cannot drift from the source the way a generated file can.
 *
 * `en-XA` is a PREVIEW locale like `ar`: reachable by `?locale=`, on no menu,
 * persisted nowhere (`apps/web/lib/locale.ts`).
 */
let pseudo: Catalogue | undefined;

/** Overrides the derived pseudo-locale, for a test that needs a fixed one. */
export function registerPseudoCatalogue(catalogue: Catalogue): void {
  pseudo = catalogue;
}

function catalogueFor(locale: string): Catalogue | undefined {
  if (locale === PSEUDO_LOCALE) {
    pseudo ??= pseudoCatalogue(en) as Catalogue;
    return pseudo;
  }
  return BASE[locale];
}

function resolveMessage(locale: string, id: MessageId): string {
  for (const candidate of fallbackChain(locale)) {
    const message = catalogueFor(candidate)?.[id];
    if (message !== undefined) {
      return message;
    }
  }
  throw new Error(`Missing message "${id}" for locale "${locale}"`);
}

export function createTranslator(locale: string = DEFAULT_LOCALE): Translator {
  return {
    locale,
    t(id, values) {
      const message = resolveMessage(locale, id);
      // Fast path: no ICU arguments means no parser, which matters on the
      // low-bandwidth/low-CPU devices the PWA targets.
      if (values === undefined && !message.includes('{')) {
        return message;
      }
      return new IntlMessageFormat(message, locale).format(values) as string;
    },
  };
}

/**
 * Resolves one message through the fallback chain, formatting it when the
 * arguments it needs are supplied.
 *
 * Unlike `Translator.t`, this does NOT throw when an argument is missing: it
 * returns the raw pattern instead. That is deliberate and its audience is
 * tooling — the validator, the completeness gate and the acceptance suite all
 * want to see WHICH message a locale resolves to without having to invent
 * plausible values for every placeholder in the catalogue. Application code
 * should use `createTranslator`, which is strict.
 */
export function translate(locale: string, id: string, values?: Record<string, unknown>): string {
  const message = resolveMessage(locale, id as MessageId);
  if (values === undefined && !message.includes('{')) {
    return message;
  }
  try {
    return new IntlMessageFormat(message, locale).format(values) as string;
  } catch {
    return message;
  }
}

/**
 * Resolves `ids` for `locale` into a plain object a client island can format
 * from. Throws on a missing id, exactly like `t`.
 *
 * SERVER ONLY, and that is the whole point: the catalogues stay here and only
 * the handful of strings a screen asked for cross the wire. The client half is
 * `createBundleTranslator` in `./bundle`, which imports no catalogue at all.
 */
/**
 * What `bundleMessages` sends for one resolved string (T-0145): the string
 * itself when it has no ICU syntax, which is how `t` has always returned such a
 * string, and otherwise the tree `IntlMessageFormat` parses it to, with the
 * same locale, for the browser's formatter in `./bundle`. A message that does
 * not parse stays a string, so it fails where it always did, when a screen
 * formats it, and not while the page is built.
 */
export function bundledMessage(message: string, locale: string): string | ParsedMessage {
  if (!message.includes('{')) return message;
  try {
    return new IntlMessageFormat(message, locale).getAst();
  } catch {
    return message;
  }
}

export function bundleMessages(locale: string, ids: readonly MessageId[]): MessageBundle {
  const bundle: Record<string, string | ParsedMessage> = {};
  for (const id of ids) {
    // ICU strings cross already parsed (T-0145): see `MessageBundle`.
    bundle[id] = bundledMessage(resolveMessage(locale, id), locale);
  }
  return bundle;
}

export const MESSAGE_IDS = Object.keys(en) as MessageId[];

export { pseudoCatalogue, pseudoMessage } from './pseudo';
export { requiredPluralCategories, PLURAL_CATEGORIES } from './plurals';
export type { PluralCategory } from './plurals';
export {
  allLocaleReadiness,
  deriveBetaLocales,
  deriveSupportedLocales,
  localeReadiness,
} from './completeness';
export type { LocaleReadiness, LocaleKind } from './completeness';
export { DESIGN_MENU_LOCALES, LOCALE_SOURCES, parseReview } from './catalogues';
export type { LocaleReview, LocaleSource, ReviewStatus } from './catalogues';
export { EN_CATALOGUE, EN_NG_CATALOGUE } from './catalogues';

/**
 * Every registered catalogue, offered or not. `SUPPORTED_LOCALES` is the menu;
 * this is the inventory, and the difference between them is the point.
 */
export const REGISTERED_LOCALES: readonly string[] = Object.keys(LOCALE_SOURCES);

/** One line per locale explaining why it is or is not on the menu. */
export function localeReadinessReport(): string {
  return REGISTERED_LOCALES.map((locale) => {
    const readiness = localeReadiness(locale);
    const offered = SUPPORTED_LOCALES.includes(locale);
    const onMenu = (DESIGN_MENU_LOCALES as readonly string[]).includes(locale);
    const state = offered ? 'offered' : onMenu ? 'held back' : 'not on the menu';
    const detail = readiness.problems.length === 0 ? 'ready' : readiness.problems.join('; ');
    return `${locale.padEnd(6)} ${state.padEnd(15)} ${detail}`;
  }).join('\n');
}
