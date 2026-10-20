'use client';

import type { ReactNode, SelectHTMLAttributes } from 'react';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';

/**
 * The P28 vocabulary the import, duplicates and placeholder sections share,
 * to the export's own numbers (T-0141). Class strings and small components
 * only; every word is the caller's.
 */

/** A P28 card: surface, a 1px border, radius 12, 20px padding (16 on a phone). */
export const CARD = 'flex min-w-0 flex-col gap-3.5 rounded-lg border border-border bg-surface p-4 sm:p-5';

/** A bordered table card holding rows edge to edge. */
export const TABLE_CARD = 'min-w-0 overflow-hidden rounded-lg border border-border bg-surface';

/** The sunken header row of a P28 table: 40px, 0 16px, 12/700 in text-2. */
export const TABLE_HEAD = 'min-h-control-md items-center gap-3.5 border-b border-border bg-surface-sunken px-4 text-caption font-bold text-text-2';

/** A 16/700 card title ("1. Choose a file"). */
export const CARD_TITLE = 'm-0 text-card-title';

/** A native select at the export's size: 40px, radius 8, 14px, a 20px chevron. */
export function NativeSelect({
  className,
  compact = false,
  invalid = false,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { compact?: boolean; invalid?: boolean }) {
  return (
    <span className={`relative flex min-w-0 ${className ?? ''}`}>
      <select
        {...rest}
        aria-invalid={invalid || undefined}
        className={`peer w-full min-w-0 cursor-pointer appearance-none rounded-md border bg-surface text-text focus-visible:field-focus disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-text ${
          compact ? 'h-[38px] pe-8 ps-2.5 text-meta' : 'h-control-md pe-9 ps-3 text-body-sm'
        } ${invalid ? 'border-2 border-danger' : 'border-border-strong'}`}
      >
        {children}
      </select>
      <span className="pointer-events-none absolute inset-y-0 end-2 flex items-center text-text peer-disabled:text-disabled-text">
        <Icon name="expand_more" size={20} />
      </span>
    </span>
  );
}

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'primary';

const PILL_TONE: Record<Tone, string> = {
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-danger-soft text-danger-text',
  info: 'bg-info-soft text-info-text',
  neutral: 'bg-surface-sunken text-text-2',
  primary: 'bg-primary-soft text-primary-text',
};

/** A 12/700 status pill, 3px 8px, optionally with a 15px glyph (P28's "Done", "High · 98%"). */
export function StatusPill({ tone, icon, children }: { tone: Tone; icon?: IconName; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.75 text-caption font-bold ${PILL_TONE[tone]}`}>
      {icon === undefined ? null : <Icon name={icon} size={15} />}
      {children}
    </span>
  );
}

/** A 28px chip with a 16px glyph ("✓ A name"), success or danger. */
export function CheckChip({ met, children, ...rest }: { met: boolean; children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <span
      {...rest}
      className={`inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-caption font-bold ${met ? 'bg-success-soft text-success-text' : 'bg-danger-soft text-danger-text'}`}
    >
      <Icon name={met ? 'check_circle' : 'error'} size={16} />
      {children}
    </span>
  );
}

/**
 * A stat tile (P28 A4, A5, A6, E): a label with an optional 18px glyph over a
 * 24/800 figure. `value` is already formatted; a tile with nothing served
 * draws the design's empty dash, never a number.
 */
export function StatTile({
  label,
  value,
  icon,
  tone,
  sunken = false,
  attributes,
}: {
  label: ReactNode;
  value: ReactNode;
  icon?: IconName;
  tone?: 'success' | 'warning' | 'danger';
  /** The run's count tiles are sunken boxes; the review's are bordered cards. */
  sunken?: boolean;
  attributes?: Record<`data-${string}`, string>;
}) {
  const colour = tone === 'success' ? 'text-success-text' : tone === 'warning' ? 'text-warning-text' : tone === 'danger' ? 'text-danger-text' : 'text-text';
  return (
    <div className={`flex min-w-0 flex-col gap-0.5 rounded-10 px-3 py-2.5 ${sunken ? 'bg-surface-sunken' : 'border border-border bg-surface px-4 py-3.5'}`}>
      <dt className={`flex items-center gap-1.5 ${sunken ? 'order-2 text-meta text-text-2' : 'text-body-sm text-text-2'}`}>
        {icon === undefined ? null : <Icon name={icon} size={18} className={colour} />}
        {label}
      </dt>
      <dd {...attributes} className={`m-0 font-extrabold tabular-nums ${sunken ? 'order-1 text-h5' : 'text-h3'} ${colour}`}>
        {value}
      </dd>
    </div>
  );
}

/**
 * A radio card (P28's object picker, the review's skip-or-fix pair, E1's
 * request type): 2px primary on primary-soft when chosen, 1px border when not.
 * A native radio inside a label, so the group is a real radio group.
 */
export function RadioCard({
  name,
  checked,
  disabled = false,
  onChange,
  icon,
  title,
  body,
  trailing = 'radio',
  attributes,
}: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  onChange?: () => void;
  icon?: IconName;
  title: ReactNode;
  body?: ReactNode;
  /** Where the radio dot sits: at the end (A) or the start (A5). */
  trailing?: 'radio' | 'leading';
  attributes?: Record<`data-${string}`, string>;
}) {
  const dot = (
    <span className="relative flex size-4.5 shrink-0 items-center justify-center">
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange ?? (() => undefined)}
        {...attributes}
        className="peer absolute inset-0 m-0 cursor-pointer appearance-none rounded-full border-2 border-border-strong checked:border-primary focus-visible:ring-focus disabled:cursor-not-allowed disabled:border-border"
      />
      <span aria-hidden="true" className="pointer-events-none hidden size-2 rounded-full bg-primary peer-checked:block" />
    </span>
  );
  return (
    <label
      className={`flex min-h-control-xl items-center gap-3 rounded-10 px-3 py-1.5 text-start ${
        checked ? 'border-2 border-primary bg-primary-soft' : 'border border-border bg-surface'
      } ${disabled ? 'cursor-not-allowed text-text-muted' : 'cursor-pointer text-text'}`}
    >
      {trailing === 'leading' ? dot : null}
      {icon === undefined ? null : <Icon name={icon} size={20} className={disabled ? '' : 'text-primary-text'} />}
      <span className="flex min-w-0 flex-1 flex-col">
        <b className="text-body-sm font-bold">{title}</b>
        {body === undefined ? null : <span className={`text-caption font-normal ${disabled ? '' : 'text-text-2'}`}>{body}</span>}
      </span>
      {trailing === 'radio' ? dot : null}
    </label>
  );
}

/** A 40px icon tile on primary-soft (the upload row, the run card). */
export function IconTile({ icon, size = 'md' }: { icon: IconName; size?: 'md' | 'lg' }) {
  return (
    <span aria-hidden="true" className={`flex shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary-text ${size === 'lg' ? 'size-11' : 'size-10'}`}>
      <Icon name={icon} size={22} />
    </span>
  );
}

/** A 34px bordered icon button (the upload row's pause and cancel). */
export function SmallIconButton({
  icon,
  label,
  onClick,
  bordered = true,
  testId,
  disabled,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  bordered?: boolean;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={`relative flex size-[34px] shrink-0 items-center justify-center rounded-md before:absolute before:-inset-1 is-hover:bg-surface-sunken is-focus-visible:ring-focus disabled:cursor-not-allowed disabled:text-disabled-text ${
        bordered ? 'border border-border bg-surface text-text' : 'text-text-2'
      }`}
    >
      <Icon name={icon} size={20} />
    </button>
  );
}
