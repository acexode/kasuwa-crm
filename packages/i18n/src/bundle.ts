import { IntlMessageFormat } from 'intl-messageformat';
import type { MessageId } from './message-id';

export type { Catalogue, MessageId } from './message-id';

/**
 * The client-safe half of `@kasuwa/i18n` — **a leaf module that imports no
 * catalogue**, and that is the entire reason it exists.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE, AND WHY CLIENT COMPONENTS IMPORT
 * `@kasuwa/i18n/bundle` RATHER THAN `@kasuwa/i18n`
 *
 * `index.ts` imports `catalogues.ts`, which statically imports every locale
 * JSON in the repository — nine catalogues, eight passthrough files and nine
 * review files — and then evaluates `deriveSupportedLocales()` at module scope.
 * None of that can be tree-shaken: a top-level call over a graph of JSON
 * imports is not something a bundler is allowed to drop.
 *
 * So a single `import { createBundleTranslator } from '@kasuwa/i18n'` in a
 * `'use client'` component pulled EVERY catalogue, in EVERY language, into the
 * browser bundle — including the reviewer prose in the `*.review.json` files.
 * Measured on the production build of the admin console: 26.5 KB gzipped in
 * one shared chunk, growing with every string any screen adds, to render one
 * screen in one language.
 *
 * `bundleMessages` on the server was always the right idea. It only works if
 * the client never reaches the catalogues at all, and a barrel file made that
 * one import away. This module is the enforcement: nothing here can reach a
 * catalogue, because nothing here imports one.
 *
 * **Server code should keep importing `@kasuwa/i18n`** — index re-exports all
 * of this, so there is one name for everything on the server. A `'use client'`
 * module imports `@kasuwa/i18n/bundle`.
 * ---------------------------------------------------------------------------
 */

export const DEFAULT_LOCALE = 'en';
export const PSEUDO_LOCALE = 'en-XA';

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
 * Endonyms, transcribed from `docs/design/P01/v1.0/Kasuwa Auth Screen.dc.html`.
 * A language menu written in English is useless to the person who cannot read
 * English, which is the entire population it exists for. The diacritics are
 * part of the word: "Yorùbá", not "Yoruba (Nigeria)".
 *
 * It lives here rather than beside the catalogues because the language menu is
 * rendered by a client component, and a label table is a few hundred bytes
 * where the catalogues it used to sit next to are tens of kilobytes.
 */
export const LOCALE_LABELS: Readonly<Record<string, string>> = {
  en: 'English',
  'en-NG': 'English (Naija)',
  fr: 'Français',
  ha: 'Hausa',
  ig: 'Igbo',
  sw: 'Kiswahili',
  pcm: 'Pidgin',
  yo: 'Yorùbá',
  ar: 'العربية',
};

/**
 * The name of a language in that language. "Yorùbá", not "Yoruba (Nigeria)".
 * Falls back to the tag itself rather than to an English name: a tag is
 * obviously a placeholder, an English name silently looks finished.
 */
export function localeLabel(locale: string): string {
  return LOCALE_LABELS[locale] ?? locale;
}

export interface Translator {
  readonly locale: string;
  /** Formats a message. Unknown ids throw — a missing string is a bug, not a blank. */
  t(id: MessageId, values?: Record<string, string | number | Date>): string;
}

/**
 * A subset of a catalogue, already resolved through the fallback chain.
 *
 * WHY THIS EXISTS — it is a bandwidth decision, not an ergonomics one. See the
 * note at the top of this file for the measurement.
 */
export type MessageBundle = Readonly<Record<string, string>>;

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
