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
 * A message that has placeholders, plurals or selects, already parsed on the
 * server (T-0145): the element list `IntlMessageFormat` builds from the
 * string (`getAst()`), built where the catalogues are. Described here by
 * shape only, so no type outside this package names the parser's package.
 */
export type ParsedMessage = readonly { readonly type: number }[];

/**
 * A subset of a catalogue, already resolved through the fallback chain.
 *
 * WHY THIS EXISTS — it is a bandwidth decision, not an ergonomics one. See the
 * note at the top of this file for the measurement.
 *
 * WHY SOME ENTRIES ARE PARSED (T-0145). A message with no `{` crosses as its
 * string. A message with ICU syntax crosses as its parse tree, built by
 * `bundleMessages` on the server, so the browser never parses ICU and never
 * loads `intl-messageformat`: the parser alone was about 9 KB gzipped on every
 * page, the formatter another 3 KB. On a typical screen 22 of 339 strings are
 * ICU, and their trees add under 200 bytes to the page.
 */
export type MessageBundle = Readonly<Record<string, string | ParsedMessage>>;

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
      if (typeof message === 'string') {
        if (!message.includes('{')) return message;
        // `bundleMessages` parses every message that parses, so this is one
        // that does not: it fails here, when the screen formats it, as it
        // always did.
        throw new Error(`Message "${id}" for locale "${locale}" is not valid ICU`);
      }
      return formatParsed(message as readonly Element[], locale, values, id);
    },
  };
}

// ---------------------------------------------------------------------------
// The browser's formatter (T-0145)
//
// `IntlMessageFormat#format` over a parse tree, for the elements Kasuwa's
// catalogues use: text, `{name}`, `{n, plural, …}` with `#`, and
// `{x, select, …}`. It follows `intl-messageformat` 10.7's `formatToParts` and
// `format` step for step, including what they throw and the odd corners (`#`
// inside a select prints nothing; a non-string, non-number argument comes
// back as a part, not as text). `bundle.test.ts` formats every catalogue
// message in every locale both ways and requires the same answer, and fails
// on any element kind this does not handle, so a catalogue that starts using
// one (`{n, number}`, a tag) is caught there and not in a browser.
// ---------------------------------------------------------------------------

/** The `@formatjs/icu-messageformat-parser` element kinds this handles. */
const LITERAL = 0;
const ARGUMENT = 1;
const SELECT = 5;
const PLURAL = 6;
const POUND = 7;

/** Every element kind `formatParsed` formats. */
export const FORMATTED_ELEMENT_TYPES: readonly number[] = [LITERAL, ARGUMENT, SELECT, PLURAL, POUND];

interface Element {
  readonly type: number;
  readonly value?: string;
  readonly options?: Readonly<Record<string, { readonly value: readonly Element[] }>>;
  readonly offset?: number;
  readonly pluralType?: 'cardinal' | 'ordinal';
}

interface Part {
  readonly literal: boolean;
  value: unknown;
}

const numberFormats = new Map<string, Intl.NumberFormat>();
const pluralRules = new Map<string, Intl.PluralRules>();

function numberFormat(locale: string): Intl.NumberFormat {
  let found = numberFormats.get(locale);
  if (found === undefined) {
    found = new Intl.NumberFormat(locale);
    numberFormats.set(locale, found);
  }
  return found;
}

function pluralRule(locale: string, type: 'cardinal' | 'ordinal' | undefined): Intl.PluralRules {
  const key = `${locale} ${type ?? ''}`;
  let found = pluralRules.get(key);
  if (found === undefined) {
    found = new Intl.PluralRules(locale, { type });
    pluralRules.set(key, found);
  }
  return found;
}

function formatParsed(
  elements: readonly Element[],
  locale: string,
  values: Record<string, unknown> | undefined,
  id: string,
): string {
  const parts = toParts(elements, locale, values, undefined, id);
  if (parts.length === 1) return parts[0]?.value as string;
  const joined: unknown[] = [];
  for (const part of parts) {
    const last = joined.length - 1;
    if (joined.length === 0 || !part.literal || typeof joined[last] !== 'string') joined.push(part.value);
    else joined[last] = `${joined[last] as string}${part.value as string}`;
  }
  // As `format` does: a part that is not text (an object argument) comes back
  // in an array, which the `string` return type has always glossed over.
  if (joined.length <= 1) return (joined[0] as string | undefined) || '';
  return joined as unknown as string;
}

function toParts(
  elements: readonly Element[],
  locale: string,
  values: Record<string, unknown> | undefined,
  pluralValue: number | undefined,
  id: string,
): Part[] {
  const only = elements[0];
  if (elements.length === 1 && only !== undefined && only.type === LITERAL) {
    return [{ literal: true, value: only.value }];
  }
  const parts: Part[] = [];
  for (const element of elements) {
    if (element.type === LITERAL) {
      parts.push({ literal: true, value: element.value });
      continue;
    }
    if (element.type === POUND) {
      if (typeof pluralValue === 'number') parts.push({ literal: true, value: numberFormat(locale).format(pluralValue) });
      continue;
    }
    const name = element.value ?? '';
    if (!(values !== undefined && name in values)) {
      throw new Error(`The value "${name}" was not provided to message "${id}"`);
    }
    const value = values[name];
    if (element.type === ARGUMENT) {
      const text = !value || typeof value === 'string' || typeof value === 'number'
        ? typeof value === 'string' || typeof value === 'number' ? String(value) : ''
        : value;
      parts.push({ literal: typeof text === 'string', value: text });
      continue;
    }
    const options = element.options ?? {};
    if (element.type === SELECT) {
      const option = options[String(value)] ?? options.other;
      if (option === undefined) throw new Error(`"${String(value)}" is not an option of "${name}" in message "${id}"`);
      parts.push(...toParts(option.value, locale, values, undefined, id));
      continue;
    }
    if (element.type === PLURAL) {
      const counted = (value as number) - (element.offset ?? 0);
      const option =
        options[`=${String(value)}`] ?? options[pluralRule(locale, element.pluralType).select(counted)] ?? options.other;
      if (option === undefined) throw new Error(`"${String(value)}" is not an option of "${name}" in message "${id}"`);
      parts.push(...toParts(option.value, locale, values, counted, id));
      continue;
    }
    throw new Error(`Message "${id}" uses an ICU element (type ${element.type}) the browser formatter does not handle`);
  }
  return mergeLiterals(parts);
}

function mergeLiterals(parts: Part[]): Part[] {
  if (parts.length < 2) return parts;
  const merged: Part[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (last === undefined || !last.literal || !part.literal) merged.push({ ...part });
    else last.value = `${last.value as string}${part.value as string}`;
  }
  return merged;
}
