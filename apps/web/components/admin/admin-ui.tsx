import Link from 'next/link';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';

/**
 * The P02 console's own controls (T-0140), drawn to the admin export
 * (`docs/design/P02/Kasuwa Admin Console.html`).
 *
 * The export's admin screens use a denser vocabulary than the v1.1 controls in
 * `@kasuwa/ui/components`: 40px header and toolbar buttons at 14/600 with 20px
 * glyphs, 36px status chips and object tabs, 40px search fields with a leading
 * glyph, 12/700 caps table heads on surface-sunken, and an unsaved-changes bar
 * that floats as a dark card. They live here once, so the six screens and seven
 * tabs cannot drift from each other again. Every value is a T-0127 token
 * utility; nothing here holds a colour or pixel literal, and nothing holds copy.
 *
 * No `'use client'`: these render inside client screens, and a directive here
 * would make the module a client boundary for no reason.
 */

const FOCUS = 'is-focus-visible:ring-focus outline-none';

export type AdminButtonVariant = 'primary' | 'secondary' | 'danger' | 'danger-outline';

const BUTTON_VARIANT: Readonly<Record<AdminButtonVariant, string>> = {
  primary:
    'border-transparent bg-primary px-4 text-on-primary is-hover:bg-primary-hover is-active:bg-primary-active disabled:bg-disabled-bg disabled:text-disabled-text',
  secondary:
    'border-border bg-surface px-3.5 text-text is-hover:bg-surface-sunken disabled:text-disabled-text',
  danger:
    'border-transparent bg-danger px-4 font-bold text-on-primary is-hover:bg-danger-hover disabled:bg-disabled-bg disabled:text-disabled-text',
  'danger-outline':
    'border-danger bg-surface px-3.5 text-danger-text is-hover:bg-danger-soft disabled:border-border disabled:text-disabled-text',
};

/** 40px, radius 8, 14/600, a 6px gap and 20px glyphs: the export's header and toolbar button. */
export function adminButtonClass(variant: AdminButtonVariant, className = ''): string {
  return `inline-flex h-control-md shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md border text-body-sm font-semibold transition-colors duration-instant disabled:cursor-not-allowed ${FOCUS} ${BUTTON_VARIANT[variant]} ${className}`;
}

export interface AdminButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  readonly variant?: AdminButtonVariant;
  readonly icon?: IconName;
  /**
   * A designed control whose backend does not exist yet: drawn in the
   * disabled tokens and announced as unavailable (D-L194). Never an opacity
   * fade, which reads as "loading" on a cheap screen.
   */
  readonly notReady?: boolean;
  readonly children: ReactNode;
}

export function AdminButton({
  variant = 'secondary',
  icon,
  notReady = false,
  className,
  type = 'button',
  disabled,
  children,
  ...rest
}: AdminButtonProps) {
  return (
    <button
      type={type}
      disabled={notReady || disabled}
      aria-disabled={notReady || disabled ? true : undefined}
      className={adminButtonClass(variant, className)}
      {...rest}
    >
      {icon === undefined ? null : <Icon name={icon} size={20} />}
      {children}
    </button>
  );
}

export function AdminLinkButton({
  href,
  variant = 'secondary',
  icon,
  className,
  children,
  ...rest
}: Omit<ComponentPropsWithRef<typeof Link>, 'children'> & {
  readonly variant?: AdminButtonVariant;
  readonly icon?: IconName;
  readonly children: ReactNode;
}) {
  return (
    <Link href={href} prefetch={false} className={adminButtonClass(variant, className)} {...rest}>
      {icon === undefined ? null : <Icon name={icon} size={20} />}
      {children}
    </Link>
  );
}

/** The export's text action: 32px, 0 8px, radius 6, 13/600 in primary-text ("Edit", "See all in audit log"). */
export const TEXT_ACTION = `inline-flex h-8 shrink-0 items-center rounded-6 px-2 text-meta font-semibold text-primary-text is-hover:bg-primary-soft disabled:cursor-not-allowed disabled:text-disabled-text ${FOCUS}`;

/** The 36px borderless icon button in rows (dismiss, delete, expand). */
export const ROW_ICON_BUTTON = `inline-flex size-9 shrink-0 items-center justify-center rounded-md text-text-muted is-hover:bg-surface-sunken ${FOCUS}`;

/**
 * Page header: an optional 13/600 eyebrow (or breadcrumb), the 28/800 title,
 * and a 15/22 intro at most 720px wide, with the actions at the end. Below
 * `sm` the actions drop under the text rather than squeezing it.
 */
export function PageHeader({
  eyebrow,
  title,
  intro,
  actions,
  aside,
}: {
  readonly eyebrow?: ReactNode;
  readonly title: ReactNode;
  readonly intro?: ReactNode;
  readonly actions?: ReactNode;
  /** Something beside the title on its line: the programme's status pill. */
  readonly aside?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="flex min-w-0 grow basis-80 flex-col gap-1.5">
        {eyebrow === undefined ? null : (
          <span className="text-meta font-semibold text-text-muted">{eyebrow}</span>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <h1 className="m-0 min-w-0 text-title text-text">{title}</h1>
          {aside}
        </div>
        {intro === undefined ? null : (
          <div className="max-w-3xl text-pretty text-label font-normal text-text-2">{intro}</div>
        )}
      </div>
      {actions === undefined ? null : <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** A 40px search field with the leading 20px search glyph (the export's toolbar search). */
export function SearchField({
  id,
  label,
  className = '',
  ...rest
}: Omit<ComponentPropsWithRef<'input'>, 'type'> & { readonly id: string; readonly label: string }) {
  return (
    <div className={`relative min-w-0 ${className}`}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Icon
        name="search"
        size={20}
        className="pointer-events-none absolute start-2.5 top-2.5 text-text-muted"
      />
      <input
        id={id}
        type="search"
        className="h-control-md w-full min-w-0 rounded-md border border-border-strong bg-surface pe-3 ps-10 text-body-sm text-text placeholder:text-text-muted is-focus:field-focus"
        {...rest}
      />
    </div>
  );
}

/**
 * A status chip or object tab, 36px: selected is solid primary with on-primary
 * text, the rest a bordered surface. `shape` is `pill` for filter chips
 * (programmes) and `tab` for the radius-8 object tabs (field security).
 */
export function chipClass(selected: boolean, shape: 'pill' | 'tab' = 'pill'): string {
  return `inline-flex h-control-sm shrink-0 select-none items-center gap-1.5 whitespace-nowrap border px-3 font-semibold transition-colors duration-instant ${FOCUS} ${
    shape === 'pill' ? 'rounded-full text-meta' : 'rounded-md text-body-sm'
  } ${
    selected
      ? 'border-primary bg-primary text-on-primary is-hover:bg-primary-hover'
      : 'border-border bg-surface text-text is-hover:bg-surface-sunken'
  }`;
}

/** The count inside a chip: same colour, 500 (12px on the object tabs). */
export function ChipCount({ children, small = false }: { readonly children: ReactNode; readonly small?: boolean }) {
  return <span className={small ? 'text-caption font-medium' : 'font-medium'}>{children}</span>;
}

/** Table heads: 40px on surface-sunken, 12/700 caps at a wide tracking, text-muted. */
export const TABLE_HEAD =
  'h-10 bg-surface-sunken text-caption font-bold uppercase tracking-wider text-text-muted';

/** A bordered surface card at radius 12. */
export const CARD = 'rounded-lg border border-border bg-surface';

/**
 * The floating unsaved-changes bar (`P02/B4`): a dark card, at most ~720px,
 * centred over the content 20px above the bottom, beside the settings menu
 * from 1280 up. An `edit_note` glyph in accent, two lines (the count, and
 * what holds the changes), Discard outlined on dark, Save in accent.
 */
export function UnsavedBar({
  label,
  count,
  detail,
  discardLabel,
  saveLabel,
  savingLabel,
  saving,
  saveDisabled = false,
  onDiscard,
  onSave,
}: {
  /** The region's name ("Unsaved changes"). */
  readonly label: string;
  readonly count: string;
  readonly detail?: string;
  readonly discardLabel: string;
  readonly saveLabel: string;
  readonly savingLabel: string;
  readonly saving: boolean;
  readonly saveDisabled?: boolean;
  readonly onDiscard: () => void;
  readonly onSave: () => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-20 flex justify-center px-4 sm:px-6 xl:start-shell-admin-nav">
      <div
        role="region"
        aria-label={label}
        data-testid="unsaved-bar"
        className="pointer-events-auto flex w-full max-w-3xl flex-wrap items-center gap-3.5 rounded-lg bg-inverse py-2.5 pe-2.5 ps-4.5 text-on-inverse shadow-3"
      >
        <Icon name="edit_note" size={22} className="text-accent" />
        <div className="flex min-w-0 flex-1 flex-col">
          <b data-testid="unsaved-count" className="text-body-sm font-bold">
            {count}
          </b>
          {detail === undefined ? null : (
            <span className="truncate text-meta text-surface-sunken">{detail}</span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="discard-changes"
            onClick={onDiscard}
            className={`inline-flex h-control-md items-center rounded-md border border-border-strong bg-transparent px-3.5 text-body-sm font-semibold text-on-inverse ${FOCUS}`}
          >
            {discardLabel}
          </button>
          <button
            type="button"
            data-testid="save-changes"
            disabled={saving || saveDisabled}
            onClick={onSave}
            className={`inline-flex h-control-md items-center rounded-md bg-accent px-4 text-body-sm font-bold text-on-accent disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-text ${FOCUS}`}
          >
            {saving ? savingLabel : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A message line under a panel: an error (`role=alert`) or a confirmation (`role=status`). */
export function Notice({
  tone,
  testId,
  errorCode,
  children,
}: {
  readonly tone: 'danger' | 'success';
  readonly testId: string;
  readonly errorCode?: string;
  readonly children: ReactNode;
}) {
  return (
    <p
      role={tone === 'danger' ? 'alert' : 'status'}
      data-testid={testId}
      data-error-code={errorCode}
      className={`flex items-center gap-2 rounded-10 px-3.5 py-3 text-meta ${
        tone === 'danger' ? 'bg-danger-soft text-danger-text' : 'bg-success-soft text-success-text'
      }`}
    >
      <Icon name={tone === 'danger' ? 'error' : 'check_circle'} size={18} />
      {children}
    </p>
  );
}
