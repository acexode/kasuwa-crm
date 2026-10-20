'use client';

/**
 * What the P01 language menu and the shells' account menu share (T-0130): the
 * option type, the switch itself and the Beta badge. Apart from
 * `language-menu`, so a CRM or admin screen, whose language list lives in the
 * account menu, does not also ship the P01 menu to reach them (T-0145).
 */

export interface LanguageOption {
  readonly code: string;
  /**
   * The ENDONYM — the language's own name for itself, diacritics included,
   * never an English name with a country in brackets. The diacritics are part
   * of the word, and a menu written in English is useless to the person who
   * cannot read English, which is the entire population it exists for.
   *
   * Supplied by the caller from `localeLabel()`. Typing one here would be a
   * second source of truth for a fact `@kasuwa/i18n` already owns, and an
   * acceptance test scans this directory for exactly that.
   */
  readonly label: string;
  /**
   * Present only for a BETA language (D-P1): complete, but no named reviewer
   * has signed it off. Both strings arrive already resolved in the UI's
   * language from `lib/locale.ts`, so this client module decides nothing about
   * which language is Beta and imports no catalogue to find out.
   */
  readonly beta?: { readonly badge: string; readonly help: string; readonly href: string };
}

/**
 * Switches the UI language: a year, path-scoped to the app, and readable by the
 * server so the very next render is in the chosen language rather than the
 * default one. Shared with the shells' account menu (T-0130).
 */
export function chooseLanguage(code: string): void {
  document.cookie = `kasuwa_locale=${encodeURIComponent(code)}; path=/; max-age=31536000; samesite=lax`;
  window.location.reload();
}

/**
 * The Beta badge (D-P1). Text, not colour alone, and in the UI's language: a
 * Hausa reader looking at the menu in Hausa reads "Gwaji", not "Beta".
 */
export function BetaBadge({ text, lang }: { text: string; lang: string }) {
  return (
    <span
      data-testid="language-beta"
      lang={lang}
      className="rounded-full bg-warning-soft px-2 text-caption font-bold text-warning-text"
    >
      {text}
    </span>
  );
}
