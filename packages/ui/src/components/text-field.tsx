import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cx, type DataAttributes } from './class-names';
import { Glyph } from './glyph';
import { Spinner } from './spinner';

/**
 * Text field and select, to the v1.1 Components page ("B · Inputs").
 *
 *   Label    14/600, 6px above the control.
 *   Control  44px, 0 12px, a 1px border-strong edge, radius 8, 15px value,
 *            muted placeholder.
 *   Hover    the edge goes text-2.
 *   Focus    a primary edge and a 3px primary-soft-strong halo, on any focus:
 *            a field shows focus while someone types, however they got there.
 *   Error    a 2px danger edge, a trailing 20px `error` glyph in danger-text,
 *            and the message under the control at 13px in danger-text. The
 *            glyph means the error never relies on colour alone.
 *   Disabled disabled-bg, a plain border edge, disabled-text, label included.
 *   Loading  a trailing spinner in primary-text, with the hint ("Verifying…")
 *            under the control.
 *
 * The label is a real <label>, and the hint and error are wired to the control
 * with aria-describedby, so a screen reader reads them with the field.
 */

/** The control's shared look. Exported to the select, not to callers. */
export const FIELD_CONTROL =
  'h-control-base w-full min-w-0 rounded-md bg-surface ps-3 text-label font-normal text-text transition-colors duration-instant placeholder:text-text-muted is-focus:field-focus disabled:cursor-not-allowed disabled:border-border disabled:bg-disabled-bg disabled:text-disabled-text';

export const FIELD_EDGE = 'border border-border-strong is-hover:border-text-2';
export const FIELD_EDGE_ERROR = 'border-2 border-danger';

export interface FieldFrameProps {
  readonly id: string;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly disabled?: boolean;
  readonly className?: string | undefined;
  readonly labelAttributes?: DataAttributes | undefined;
  readonly children: ReactNode;
}

export function describedBy(id: string, hint: ReactNode, error: ReactNode): string | undefined {
  const ids = [
    error === undefined || error === null ? null : `${id}-error`,
    hint === undefined || hint === null ? null : `${id}-hint`,
  ].filter((value): value is string => value !== null);
  return ids.length === 0 ? undefined : ids.join(' ');
}

/** Label, control slot, hint and error, stacked with the v1.1 6px gap. */
export function FieldFrame({
  id,
  label,
  hint,
  error,
  disabled = false,
  className,
  labelAttributes,
  children,
}: FieldFrameProps) {
  return (
    <div className={cx('flex min-w-0 flex-col gap-1.5', className)}>
      <label
        htmlFor={id}
        className={cx('text-body-sm font-semibold', disabled ? 'text-disabled-text' : 'text-text')}
        {...labelAttributes}
      >
        {label}
      </label>
      {children}
      {error === undefined || error === null ? null : (
        <p id={`${id}-error`} className="text-meta text-danger-text">
          {error}
        </p>
      )}
      {hint === undefined || hint === null ? null : (
        <p id={`${id}-hint`} className="text-meta text-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export interface TextFieldProps extends Omit<ComponentPropsWithRef<'input'>, 'size'> {
  readonly label: ReactNode;
  /** Help under the control, in text-muted. */
  readonly hint?: ReactNode;
  /** The error message. Present means the field is in error. */
  readonly error?: ReactNode;
  /** A lookup is running: trailing spinner, aria-busy. */
  readonly loading?: boolean;
  /** IDs, phone numbers and amounts: JetBrains Mono, as in the export. */
  readonly mono?: boolean;
  /** `data-*` for the label element (the gallery marks it for measuring). */
  readonly labelAttributes?: DataAttributes;
  /** `data-*` for the trailing error glyph. */
  readonly statusIconAttributes?: DataAttributes;
  /** Classes for the outer wrapper (layout only: width, grid placement). */
  readonly className?: string;
}

export function TextField({
  label,
  hint,
  error,
  loading = false,
  mono = false,
  labelAttributes,
  statusIconAttributes,
  className,
  id,
  disabled,
  type = 'text',
  ...rest
}: TextFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const invalid = error !== undefined && error !== null;
  const trailing = invalid || loading;

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
        <input
          id={fieldId}
          type={type}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-busy={loading || undefined}
          aria-describedby={describedBy(fieldId, hint, error)}
          className={cx(
            FIELD_CONTROL,
            invalid ? FIELD_EDGE_ERROR : FIELD_EDGE,
            trailing ? 'pe-10' : 'pe-3',
            mono && 'font-mono',
          )}
          {...rest}
        />
        {trailing ? (
          <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center">
            {invalid ? (
              <Glyph
                name="error"
                size={20}
                className="text-danger-text"
                {...statusIconAttributes}
              />
            ) : (
              <Spinner className="text-primary-text" />
            )}
          </span>
        ) : null}
      </span>
    </FieldFrame>
  );
}
