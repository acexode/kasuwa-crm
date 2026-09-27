import { IntlMessageFormat } from 'intl-messageformat';
import { DESIGN_MENU_LOCALES, LOCALE_LABELS, LOCALE_SOURCES } from './catalogues';
import { deriveSupportedLocales, localeReadiness } from './completeness';
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

export const DEFAULT_LOCALE = 'en';
export const PSEUDO_LOCALE = 'en-XA';

/**
 * Derived. Do not turn this back into a literal: an incomplete locale would be
 * one keystroke from the menu, and the acceptance suite asserts the shape of
 * this declaration for that reason.
 */
export const SUPPORTED_LOCALES: readonly string[] = deriveSupportedLocales();

export type SupportedLocale = string;

export type MessageId = keyof typeof en;
export type Catalogue = Partial<Record<MessageId, string>>;

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
 * Fallback chain for a locale: most specific first, `en` always last.
 * "en-NG" -> ["en-NG", "en"];  "pcm-NG" -> ["pcm-NG", "pcm", "en"].
 */
export function fallbackChain(locale: string): string[] {
  const chain: string[] = [];
  const parts = locale.split('-');
  for (let index = parts.length; index > 0; index -= 1) {
    chain.push(parts.slice(0, index).join('-'));
  }
  if (!chain.includes(DEFAULT_LOCALE)) {
    chain.push(DEFAULT_LOCALE);
  }
  return chain;
}

let pseudoCatalogue: Catalogue | undefined;

/** Registers the generated pseudo-locale. Called by the web app in CI builds. */
export function registerPseudoCatalogue(catalogue: Catalogue): void {
  pseudoCatalogue = catalogue;
}

function catalogueFor(locale: string): Catalogue | undefined {
  if (locale === PSEUDO_LOCALE) {
    return pseudoCatalogue;
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

export interface Translator {
  readonly locale: string;
  /** Formats a message. Unknown ids throw — a missing string is a bug, not a blank. */
  t(id: MessageId, values?: Record<string, string | number | Date>): string;
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
export function translate(
  locale: string,
  id: string,
  values?: Record<string, unknown>,
): string {
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
 * Scripts written right-to-left, by ISO 639 language subtag. Direction belongs
 * to the language, not the region, so only the base tag is consulted.
 */
const RTL_LANGUAGES: ReadonlySet<string> = new Set([
  'ar',
  'arc',
  'ckb',
  'dv',
  'fa',
  'he',
  'ps',
  'sd',
  'ug',
  'ur',
  'yi',
]);

export type TextDirection = 'ltr' | 'rtl';

/** `dir` for `<html>`. Unknown locales are `ltr`, which is the safe default. */
export function textDirection(locale: string): TextDirection {
  const base = locale.split('-')[0]?.toLowerCase() ?? '';
  return RTL_LANGUAGES.has(base) ? 'rtl' : 'ltr';
}

/**
 * The name of a language in that language. "Yorùbá", not "Yoruba (Nigeria)".
 * Falls back to the tag itself rather than to an English name: a tag is
 * obviously a placeholder, an English name silently looks finished.
 */
export function localeLabel(locale: string): string {
  return LOCALE_LABELS[locale] ?? locale;
}

export const MESSAGE_IDS = Object.keys(en) as MessageId[];

export { requiredPluralCategories, PLURAL_CATEGORIES } from './plurals';
export type { PluralCategory } from './plurals';
export {
  allLocaleReadiness,
  deriveSupportedLocales,
  localeReadiness,
} from './completeness';
export type { LocaleReadiness, LocaleKind } from './completeness';
export { DESIGN_MENU_LOCALES, LOCALE_LABELS, LOCALE_SOURCES, parseReview } from './catalogues';
export type { LocaleReview, LocaleSource, ReviewStatus } from './catalogues';
export { EN_CATALOGUE, EN_NG_CATALOGUE } from './catalogues';

/**
 * A subset of a catalogue, already resolved through the fallback chain.
 *
 * WHY THIS EXISTS — it is a bandwidth decision, not an ergonomics one.
 *
 * `createTranslator` closes over every registered catalogue. In a React server
 * component that costs nothing; in a client component it drags all nine
 * catalogues into the browser bundle, and that set only grows — by the time
 * thirty screens exist it is most of what a user on 256 kbps waits for, in
 * order to render one form in one language.
 *
 * So a screen resolves its strings on the server, ships the handful it needs,
 * and the interactive island formats them with the real ICU formatter. The
 * catalogues stay on the server; the formatter — fixed in size, and needed for
 * the plural on `auth.attemptsRemaining` and the retry time on `P01/1b` —
 * is the only part that crosses the wire.
 */
export type MessageBundle = Readonly<Record<string, string>>;

/** Resolves `ids` for `locale`. Throws on a missing id, exactly like `t`. */
export function bundleMessages(locale: string, ids: readonly MessageId[]): MessageBundle {
  const bundle: Record<string, string> = {};
  for (const id of ids) {
    bundle[id] = resolveMessage(locale, id);
  }
  return bundle;
}

/**
 * A translator over an already-resolved bundle. No catalogue and no fallback
 * chain: if an id is not in the bundle the screen forgot to ask for it, and
 * that throws rather than rendering a blank.
 */
export function createBundleTranslator(locale: string, messages: MessageBundle): Translator {
  return {
    locale,
    t(id, values) {
      const message = messages[id];
      if (message === undefined) {
        throw new Error(`Message "${id}" is not in the bundle for locale "${locale}"`);
      }
      if (values === undefined && !message.includes('{')) {
        return message;
      }
      return new IntlMessageFormat(message, locale).format(values) as string;
    },
  };
}

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
