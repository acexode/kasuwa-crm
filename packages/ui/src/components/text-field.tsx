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

/**
 * The control's shared look. Exported to the select, not to callers.
 *
 * No colour transition: the export does not ask for one on fields, and a
 * focus edge that fades in reads as lag on a slow phone. (It would also leave
 * the computed border mid-fade for 100ms after focus, which is what a test
 * of the focus state reads.)
 */
export const FIELD_CONTROL =
  'w-full min-w-0 rounded-md bg-surface text-text placeholder:text-text-muted is-focus:field-focus disabled:cursor-not-allowed disabled:border-border disabled:bg-disabled-bg disabled:text-disabled-text';

/**
 * `default` is the v1.1 44px field with a 15px value. `large` is the P01
 * auth and setup field (T-0131): 48px, 0 14px, a 16px value, which is also
 * the size iOS needs to not zoom the page when the field takes focus.
 */
export type FieldSize = 'default' | 'large';

export const FIELD_SIZE: Record<FieldSize, string> = {
  default: 'h-control-base ps-3 text-label font-normal',
  large: 'h-control-lg ps-3.5 text-body-md',
};

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
  /**
   * Something beside the label, at its end: "Forgot password?". A sibling of
   * the <label>, never inside it, so it is not part of the field's name.
   */
  readonly labelAside?: ReactNode;
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
  labelAside,
  children,
}: FieldFrameProps) {
  const labelElement = (
    <label
      htmlFor={id}
      className={cx('text-body-sm font-semibold', disabled ? 'text-disabled-text' : 'text-text')}
      {...labelAttributes}
    >
      {label}
    </label>
  );
  return (
    <div className={cx('flex min-w-0 flex-col gap-1.5', className)}>
      {labelAside === undefined || labelAside === null ? (
        labelElement
      ) : (
        <span className="flex items-baseline justify-between gap-3">
          {labelElement}
          {labelAside}
        </span>
      )}
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
  readonly size?: FieldSize;
  /**
   * In error with no message of its own: the message is elsewhere, such as
   * the one alert P01/1a shows for both credentials. Draws the danger edge
   * and sets aria-invalid; `error` still wins when both are given.
   */
  readonly invalid?: boolean;
  /**
   * A control inside the field, at its end: the password reveal button. It
   * replaces the error glyph, so the field shows its error by edge and
   * message alone.
   */
  readonly trailing?: ReactNode;
  readonly labelAside?: ReactNode;
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
  size = 'default',
  invalid: invalidProp = false,
  trailing: trailingControl,
  labelAside,
  className,
  id,
  disabled,
  type = 'text',
  ...rest
}: TextFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const invalid = (error !== undefined && error !== null) || invalidProp;
  const hasControl = trailingControl !== undefined && trailingControl !== null;
  const trailing = !hasControl && (invalid || loading);

  return (
    <FieldFrame
      id={fieldId}
      label={label}
      hint={hint}
      error={error}
      disabled={disabled === true}
      className={className}
      labelAttributes={labelAttributes}
      labelAside={labelAside}
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
            FIELD_SIZE[size],
            invalid ? FIELD_EDGE_ERROR : FIELD_EDGE,
            hasControl ? 'pe-12' : trailing ? 'pe-10' : size === 'large' ? 'pe-3.5' : 'pe-3',
            mono && 'font-mono',
          )}
          {...rest}
        />
        {hasControl ? (
          <span className="absolute inset-y-0 end-1 flex items-center">{trailingControl}</span>
        ) : null}
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
