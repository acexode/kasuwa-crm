import type { ComponentPropsWithRef, ReactNode } from 'react';
import { BOX, ROW, rowTone } from './choice';
import { cx } from './class-names';

export interface RadioProps extends Omit<ComponentPropsWithRef<'input'>, 'type' | 'size'> {
  /** The visible label. Without one, pass `aria-label`. */
  readonly label?: ReactNode;
  readonly invalid?: boolean;
}

/**
 * A radio (v1.1 "Radio"): the checkbox's 20px box as a circle. Checked keeps
 * a primary ring around a 10px primary dot rather than filling, as in the
 * export. Radios that share a `name` are one group: the platform moves
 * between them with the arrow keys and Tab enters at the checked one. See
 * Checkbox for the row, the 44px target and the states.
 */
export function Radio({ label, invalid = false, disabled, className, ...rest }: RadioProps) {
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
          type="radio"
          disabled={disabled}
          aria-invalid={invalid || undefined}
          className={cx(BOX, 'rounded-full checked:border-primary disabled:checked:border-border')}
          {...rest}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 hidden items-center justify-center text-primary peer-checked:flex peer-disabled:text-disabled-text"
        >
          <span className="size-2.5 rounded-full bg-current" />
        </span>
      </span>
      {label}
    </label>
  );
}
