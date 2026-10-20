'use client';

import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';

/**
 * The six-box one-time-code field from `P01/2`.
 *
 * ---------------------------------------------------------------------------
 * PASTE AND AUTO-ADVANCE ARE THE WHOLE POINT
 *
 * Six separate boxes that reject a pasted code is the single most irritating
 * thing in any sign-in flow, and it is the default behaviour you get for free:
 * a paste into box one lands one character and drops five, silently. Every
 * person who has ever copied a code out of an SMS then has to retype it while
 * the ten-minute window runs down.
 *
 * So:
 *   - paste anywhere fills from that box onward, digits only, and focus lands
 *     on the first box still empty
 *   - typing advances; Backspace on an empty box goes back and clears
 *   - arrow keys move; Home/End jump
 *   - each box is `inputMode="numeric"` with `autoComplete="one-time-code"`, so
 *     Android and iOS offer the code from the SMS itself
 *
 * ACCESSIBILITY. Six inputs with six labels read as six unrelated fields, so
 * they sit in a labelled group and each box says which position it is. A
 * screen-reader user hears "Digit 3 of 6", not "edit text".
 * ---------------------------------------------------------------------------
 */

const LENGTH = 6;

export function OtpInput({
  value,
  onChange,
  groupLabel,
  digitLabel,
  invalid,
  disabled,
}: {
  /** The code so far. Shorter than six characters is a partial entry. */
  value: string;
  onChange: (next: string) => void;
  groupLabel: string;
  /** Formats "Digit {position} of 6" — passed in already localised per index. */
  digitLabel: (position: number) => string;
  invalid: boolean;
  disabled: boolean;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  // On a fresh challenge the code is cleared; put the caret where the person
  // has to type rather than making them find it.
  useEffect(() => {
    if (value === '') {
      refs.current[0]?.focus();
    }
  }, [value]);

  const digits = Array.from({ length: LENGTH }, (_, index) => value[index] ?? '');

  function setAt(index: number, next: string) {
    const characters = digits.slice();
    characters[index] = next;
    onChange(characters.join('').replace(/\s/g, ''));
  }

  function focusAt(index: number) {
    refs.current[Math.min(Math.max(index, 0), LENGTH - 1)]?.focus();
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>, index: number) {
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '');
    if (pasted === '') return;

    event.preventDefault();
    const characters = digits.slice();
    for (let offset = 0; offset < pasted.length && index + offset < LENGTH; offset += 1) {
      characters[index + offset] = pasted.charAt(offset);
    }
    const next = characters.join('');
    onChange(next);
    focusAt(Math.min(index + pasted.length, LENGTH - 1));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>, index: number) {
    if (event.key === 'Backspace') {
      if (digits[index] === '' && index > 0) {
        event.preventDefault();
        setAt(index - 1, '');
        focusAt(index - 1);
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusAt(index - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusAt(index + 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusAt(LENGTH - 1);
    }
  }

  return (
    <div role="group" aria-label={groupLabel} data-testid="otp-input" className="flex gap-2">
      {digits.map((digit, index) => (
        <input
          // The index IS the identity here: these boxes are positions, not a
          // reorderable list, and nothing is ever inserted between them.
          key={index}
          ref={(element) => {
            refs.current[index] = element;
          }}
          value={digit}
          disabled={disabled}
          aria-label={digitLabel(index + 1)}
          aria-invalid={invalid}
          inputMode="numeric"
          // One `one-time-code` per group is enough for the platform to offer
          // the SMS; putting it on every box makes some browsers fill only the
          // first and then give up.
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          pattern="[0-9]*"
          onPaste={(event) => onPaste(event, index)}
          onKeyDown={(event) => onKeyDown(event, index)}
          onChange={(event) => {
            const typed = event.target.value.replace(/\D/g, '').slice(-1);
            setAt(index, typed);
            if (typed !== '') {
              focusAt(index + 1);
            }
          }}
          // 44x52, mono 22/600, an 8px gap: six cells are 304px, inside the
          // 320px column a 360px phone leaves (T-0131). Focus is the field
          // halo; an error is the 2px danger edge on every cell.
          className={`h-control-xl w-11 min-w-0 rounded-md bg-surface text-center font-mono text-icon-22 font-semibold text-text outline-none focus:field-focus disabled:bg-disabled-bg disabled:text-disabled-text ${
            invalid ? 'border-2 border-danger' : 'border border-border-strong'
          }`}
        />
      ))}
    </div>
  );
}
