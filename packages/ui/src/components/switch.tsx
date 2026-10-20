'use client';

import { useId, useState, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cx } from './class-names';

export interface SwitchProps extends Omit<
  ComponentPropsWithRef<'button'>,
  'children' | 'onChange' | 'value' | 'defaultValue'
> {
  /** The visible label. Without one, pass `aria-label`. */
  readonly label?: ReactNode;
  /** Controlled state. */
  readonly checked?: boolean;
  /** Initial state when uncontrolled. */
  readonly defaultChecked?: boolean;
  readonly onCheckedChange?: (checked: boolean) => void;
}

/**
 * A switch (v1.1 "Toggle"): a 44 x 26 track, primary when on and border-strong
 * when off, with a 20px knob inset 3px that travels 18px. Disabled is
 * disabled-bg with a 1px border edge, label in disabled-text. Focus is the
 * 2px surface gap and 2px ring around the track.
 *
 * The track is a <button role="switch" aria-checked>, so Space and Enter
 * toggle it and a screen reader announces "on" and "off". The row is a
 * <label> at least 44px tall, so tapping the words toggles it too: the
 * 26px track alone would be under the WCAG 2.2 target size.
 *
 * In right-to-left layouts the knob starts at the right and travels left.
 */
export function Switch({
  label,
  checked,
  defaultChecked = false,
  onCheckedChange,
  disabled,
  className,
  onClick,
  id,
  type = 'button',
  ...rest
}: SwitchProps) {
  const [own, setOwn] = useState(defaultChecked);
  const on = checked ?? own;
  const generated = useId();
  const switchId = id ?? generated;
  const labelId = `${switchId}-label`;

  return (
    <label
      htmlFor={switchId}
      className={cx(
        'inline-flex min-h-touch items-center gap-3 text-body-sm',
        disabled === true ? 'cursor-not-allowed text-disabled-text' : 'cursor-pointer text-text',
        label === undefined && 'min-w-touch justify-center',
        className,
      )}
    >
      <button
        id={switchId}
        type={type}
        role="switch"
        aria-checked={on}
        aria-labelledby={label === undefined ? undefined : labelId}
        disabled={disabled}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented) return;
          if (checked === undefined) setOwn(!on);
          onCheckedChange?.(!on);
        }}
        className={cx(
          'relative inline-flex h-6.5 w-touch shrink-0 rounded-full transition-colors duration-quick is-focus-visible:ring-focus disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:shadow-switch-disabled',
          on ? 'bg-primary' : 'bg-border-strong',
        )}
        {...rest}
      >
        <span
          aria-hidden="true"
          className={cx(
            'pointer-events-none absolute start-0.75 top-0.75 size-5 rounded-full bg-on-primary shadow-knob transition-transform duration-quick',
            on && 'translate-x-4.5 rtl:-translate-x-4.5',
          )}
        />
      </button>
      {label === undefined ? null : <span id={labelId}>{label}</span>}
    </label>
  );
}
