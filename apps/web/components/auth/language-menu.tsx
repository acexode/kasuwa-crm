'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../icon';

export interface LanguageOption {
  readonly code: string;
  /** The endonym. "Yorùbá", never "Yoruba (Nigeria)". */
  readonly label: string;
}

/**
 * The language menu from `P01/1`.
 *
 * `options` is passed in from a server component that reads `SUPPORTED_LOCALES`
 * — the DERIVED list of languages that are finished and attested. Nothing here
 * may hard-code a language name. A menu that lists seven while the catalogue
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

  const currentOption = options.find((option) => option.code === current) ?? options[0];

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

  function choose(code: string) {
    // A year, path-scoped to the app, and readable by the server so the very
    // next render is in the chosen language rather than the default one.
    document.cookie = `kasuwa_locale=${encodeURIComponent(code)}; path=/; max-age=31536000; samesite=lax`;
    window.location.reload();
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={currentLabel}
        onClick={() => setOpen((previous) => !previous)}
        className="inline-flex min-h-touch items-center gap-1 rounded-md border border-border bg-surface px-2 text-body-sm font-semibold text-text hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <Icon name="language" />
        <span lang={currentOption?.code}>
          {compact ? (currentOption?.code.slice(0, 2).toUpperCase() ?? '') : (currentOption?.label ?? '')}
        </span>
        <Icon name={open ? 'expand_less' : 'expand_more'} size="sm" />
      </button>

      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute end-0 top-full z-10 mt-1 flex w-max flex-col rounded-lg border border-border bg-surface-raised p-1 shadow-2"
        >
          {options.map((option) => {
            const selected = option.code === current;
            return (
              <li key={option.code} role="option" aria-selected={selected}>
                <button
                  type="button"
                  lang={option.code}
                  onClick={() => choose(option.code)}
                  className={`flex min-h-touch w-full items-center gap-2 rounded-sm px-3 text-start text-body-sm text-text hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                    selected ? 'bg-primary-soft font-bold' : 'font-normal'
                  }`}
                >
                  <span className="flex-1">{option.label}</span>
                  {selected ? <Icon name="check" size="sm" className="text-primary-text" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
