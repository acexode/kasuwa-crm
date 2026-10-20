'use client';

import {
  useCallback,
  useEffect,
  useRef,
  type ComponentPropsWithRef,
  type ReactNode,
  type Ref,
} from 'react';
import { BOX, ROW, rowTone } from './choice';
import { cx } from './class-names';
import { Glyph } from './glyph';

/**
 * Checkbox and radio, to the v1.1 Components page ("Checkbox", "Radio").
 *
 *   A 20px box with a 2px border-strong edge, radius 4 (a circle for the
 *   radio). Checked fills primary with an 18px on-primary `check` (`remove`
 *   when indeterminate); a checked radio keeps a primary ring around a 10px
 *   primary dot. Focus is the 2px surface gap and 2px ring. Error is a danger
 *   edge with the label in danger-text. Disabled is disabled-bg inside a plain
 *   border edge, label in disabled-text.
 *
 * Both are the platform's <input>, restyled, so they keep native semantics,
 * keyboard (Space toggles; arrows move between radios of one name) and form
 * participation. The whole row is the <label>, at least 44px tall, so the
 * target is the row and not the 20px box. Without a visible label pass
 * `aria-label`; the box then sits centred in a 44px square.
 */

export interface CheckboxProps extends Omit<ComponentPropsWithRef<'input'>, 'type' | 'size'> {
  /** The visible label. Without one, pass `aria-label`. */
  readonly label?: ReactNode;
  /** Neither checked nor unchecked: a "select all" over a partial selection. */
  readonly indeterminate?: boolean;
  /** A required box left unticked: danger edge and label. */
  readonly invalid?: boolean;
  /**
   * `compact` is the table's 18px box with a 16px glyph (v1.1 Components
   * "Table", T-0129). Default is the 20px form checkbox.
   */
  readonly size?: 'default' | 'compact';
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref !== null && ref !== undefined) (ref as { current: T | null }).current = value;
}

export function Checkbox({
  label,
  indeterminate = false,
  invalid = false,
  size = 'default',
  disabled,
  className,
  ref,
  ...rest
}: CheckboxProps) {
  const inner = useRef<HTMLInputElement | null>(null);
  // `indeterminate` is a DOM property with no HTML attribute, so it can only
  // be set from script.
  useEffect(() => {
    if (inner.current !== null) inner.current.indeterminate = indeterminate;
  }, [indeterminate]);
  const setRef = useCallback(
    (node: HTMLInputElement | null) => {
      inner.current = node;
      assignRef(ref, node);
    },
    [ref],
  );

  return (
    <label
      className={cx(
        ROW,
        rowTone(disabled === true, invalid),
        label === undefined && 'min-w-touch justify-center',
        className,
      )}
    >
      <span className="relative inline-flex shrink-0">
        <input
          ref={setRef}
          type="checkbox"
          disabled={disabled}
          aria-invalid={invalid || undefined}
          className={cx(
            BOX,
            size === 'compact' ? 'size-4.5' : 'size-5',
            'rounded-sm checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary disabled:checked:border-border disabled:checked:bg-disabled-bg',
          )}
          {...rest}
        />
        <Glyph
          name="check"
          size={size === 'compact' ? 16 : 18}
          className="pointer-events-none absolute inset-0 hidden items-center justify-center text-on-primary peer-checked:flex peer-indeterminate:hidden peer-disabled:text-disabled-text"
        />
        <Glyph
          name="remove"
          size={size === 'compact' ? 16 : 18}
          className="pointer-events-none absolute inset-0 hidden items-center justify-center text-on-primary peer-indeterminate:flex peer-disabled:text-disabled-text"
        />
      </span>
      {label}
    </label>
  );
}
