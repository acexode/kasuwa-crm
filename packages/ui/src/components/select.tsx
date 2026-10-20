import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cx, type DataAttributes } from './class-names';
import { Glyph } from './glyph';
import { describedBy, FIELD_CONTROL, FIELD_EDGE, FIELD_EDGE_ERROR, FieldFrame } from './text-field';

export interface SelectProps extends Omit<ComponentPropsWithRef<'select'>, 'size' | 'multiple'> {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  /** `data-*` for the label element. */
  readonly labelAttributes?: DataAttributes;
  /** Classes for the outer wrapper (layout only). */
  readonly className?: string;
  /** `<option>` elements. */
  readonly children: ReactNode;
}

/**
 * A select, closed exactly as the v1.1 text field: 44px, radius 8, a 1px
 * border-strong edge, 15px value, the same hover, focus, error and disabled
 * states, and a 20px `expand_more` at the end.
 *
 * It is the platform's <select>, so the open list is the operating system's.
 * On the phones Kasuwa is built for that is the better list: a full-screen
 * native picker with the platform's own scrolling, type-ahead and screen
 * reader support, at no JavaScript cost. The v1.1 drawn list (radius 10 panel,
 * 40px rows, a `check` on the selected row) is a menu, and menus are T-0129.
 */
export function Select({
  label,
  hint,
  error,
  labelAttributes,
  className,
  id,
  disabled,
  children,
  ...rest
}: SelectProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const invalid = error !== undefined && error !== null;

  return (
    <FieldFrame
      id={fieldId}
      label={label}
      hint={hint}
      error={error}
      disabled={disabled === true}
      className={className}
      labelAttributes={labelAttributes}
    >
      <span className="relative flex">
        <select
          id={fieldId}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy(fieldId, hint, error)}
          className={cx(
            'peer cursor-pointer appearance-none pe-10',
            FIELD_CONTROL,
            invalid ? FIELD_EDGE_ERROR : FIELD_EDGE,
          )}
          {...rest}
        >
          {children}
        </select>
        <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-text peer-disabled:text-disabled-text">
          <Glyph name="expand_more" size={20} />
        </span>
      </span>
    </FieldFrame>
  );
}
