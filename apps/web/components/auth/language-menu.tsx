'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../icon';
import { rovingIndex } from '../../lib/roving';

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
 * The language menu from `P01/1`.
 *
 * `options` is passed in from a server component (`languageOptions()` in
 * `lib/locale.ts`), which lists the attested `SUPPORTED_LOCALES` and the
 * complete-but-unreviewed Beta languages — both DERIVED from the catalogues.
 * A Beta entry carries a badge, and the menu offers a "help improve this
 * translation" link beneath the list (D-P1). Nothing here may hard-code a
 * language name. A menu that lists seven while the catalogue
 * supports two is a promise the product breaks the moment someone accepts it,
 * and an acceptance test greps this app for typed-in endonyms for that reason.
 *
 * Each entry carries `lang` so the browser applies that language's typography
 * to its own name, and the check mark is `aria-selected` rather than decoration.
 */
export function LanguageMenu({
  options,
  current,
  label,
  currentLabel,
  compact,
}: {
  options: readonly LanguageOption[];
  current: string;
  label: string;
  /** "Language: {language}", already formatted — this is the accessible name. */
  currentLabel: string;
  compact: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);

  const currentOption = options.find((option) => option.code === current) ?? options[0];
  const helpLink = options.find((option) => option.beta !== undefined)?.beta;

  // Opening the list puts focus on the chosen language, as the listbox
  // pattern expects; Escape (below) puts it back on the button.
  useEffect(() => {
    if (!open) return;
    const selectedIndex = options.findIndex((option) => option.code === current);
    optionRefs.current[selectedIndex < 0 ? 0 : selectedIndex]?.focus();
  }, [open, options, current]);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        // Focus returns to the control that opened the menu. Losing it to the
        // document is how a keyboard user ends up back at the top of the page.
        buttonRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const choose = chooseLanguage;

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        data-testid="language-button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={currentLabel}
        onClick={() => setOpen((previous) => !previous)}
        className="inline-flex min-h-touch items-center gap-1 rounded-md border border-border bg-surface px-2 text-body-sm font-semibold text-text hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <Icon name="language" />
        <span lang={currentOption?.code}>
          {compact
            ? (currentOption?.code.slice(0, 2).toUpperCase() ?? '')
            : (currentOption?.label ?? '')}
        </span>
        {currentOption?.beta === undefined || compact ? null : (
          <BetaBadge text={currentOption.beta.badge} lang={current} />
        )}
        <Icon name={open ? 'expand_less' : 'expand_more'} size="sm" />
      </button>

      {open ? (
        <div className="absolute end-0 top-full z-10 mt-1 flex w-max flex-col rounded-lg border border-border bg-surface-raised p-1 shadow-2">
          <ul id={listId} role="listbox" aria-label={label} className="flex flex-col">
            {options.map((option, index) => {
              const selected = option.code === current;
              // The OPTION is the control: an <li role="option"> wrapping a
              // <button> is a nested interactive control (axe
              // `nested-interactive`), which a screen reader announces twice
              // or not at all. One tab stop for the list; arrows move.
              return (
                <li
                  key={option.code}
                  ref={(element) => {
                    optionRefs.current[index] = element;
                  }}
                  role="option"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  lang={option.code}
                  onClick={() => choose(option.code)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      choose(option.code);
                      return;
                    }
                    const next = rovingIndex(event.key, index, options.length);
                    if (next !== null) {
                      event.preventDefault();
                      optionRefs.current[next]?.focus();
                    }
                  }}
                  className={`flex min-h-touch w-full cursor-pointer items-center gap-2 rounded-sm px-3 text-start text-body-sm text-text hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                    selected ? 'bg-primary-soft font-bold' : 'font-normal'
                  }`}
                >
                  <span className="flex-1">{option.label}</span>
                  {option.beta === undefined ? null : (
                    <BetaBadge text={option.beta.badge} lang={current} />
                  )}
                  {selected ? <Icon name="check" size="sm" className="text-primary-text" /> : null}
                </li>
              );
            })}
          </ul>
          {/* Outside the listbox: a listbox may only own options, and a link is
            not one. Shown whenever the menu lists a Beta language, in the UI's
            language, so a reader of a Beta translation can say what is wrong. */}
          {helpLink === undefined ? null : (
            <a
              href={helpLink.href}
              data-testid="language-help"
              lang={current}
              className="flex min-h-touch items-center gap-2 rounded-sm border-t border-border px-3 text-body-sm font-semibold text-primary-text underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <Icon name="translate" size="sm" />
              {helpLink.help}
            </a>
          )}
        </div>
      ) : null}
    </div>
  );
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
