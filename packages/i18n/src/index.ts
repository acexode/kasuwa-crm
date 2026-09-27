import { IntlMessageFormat } from 'intl-messageformat';
import en from './locales/en.json';
import enNG from './locales/en-NG.json';

/**
 * ICU MessageFormat catalogues and the fallback chain.
 *
 * `en` is the complete catalogue and the source for extraction. `en-NG` is an
 * overlay holding only the strings that differ — which is the whole point of a
 * fallback chain, and why it exists in the scaffold with a single override:
 * so the mechanism is proven before there are nine locales to get wrong.
 *
 * `en-XA` is the pseudo-locale. It is GENERATED (pnpm i18n:pseudo), gitignored,
 * and built in CI. Its job is to make two classes of bug visible at a glance:
 * strings that were never externalised (they stay in plain English) and layouts
 * that break when translations run ~35% longer than English.
 *
 * Per PRD 2.9 the real locale set is en, en-NG, pcm, ha, yo, ig, fr, sw, pt and
 * ar (RTL). Adding them is Agent 11's work, not the scaffold's.
 */

export const DEFAULT_LOCALE = 'en';
export const PSEUDO_LOCALE = 'en-XA';

export const SUPPORTED_LOCALES = ['en', 'en-NG'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number] | typeof PSEUDO_LOCALE;

export type MessageId = keyof typeof en;
export type Catalogue = Partial<Record<MessageId, string>>;

const BASE: Record<string, Catalogue> = {
  en: en as Catalogue,
  'en-NG': enNG as Catalogue,
};

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

export interface Translator {
  readonly locale: string;
  /** Formats a message. Unknown ids throw — a missing string is a bug, not a blank. */
  t(id: MessageId, values?: Record<string, string | number | Date>): string;
}

export function createTranslator(locale: string = DEFAULT_LOCALE): Translator {
  const chain = fallbackChain(locale);

  function resolve(id: MessageId): string {
    for (const candidate of chain) {
      const message = catalogueFor(candidate)?.[id];
      if (message !== undefined) {
        return message;
      }
    }
    throw new Error(`Missing message "${id}" for locale "${locale}"`);
  }

  return {
    locale,
    t(id, values) {
      const message = resolve(id);
      // Fast path: no ICU arguments means no parser, which matters on the
      // low-bandwidth/low-CPU devices the PWA targets.
      if (values === undefined && !message.includes('{')) {
        return message;
      }
      return new IntlMessageFormat(message, locale).format(values) as string;
    },
  };
}

export const MESSAGE_IDS = Object.keys(en) as MessageId[];
export { en as EN_CATALOGUE, enNG as EN_NG_CATALOGUE };
