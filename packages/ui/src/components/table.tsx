'use client';

import {
  createContext,
  useContext,
  useRef,
  type ComponentPropsWithRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { IconName } from '../icons.generated';
import { Checkbox } from './checkbox';
import { cx } from './class-names';
import { Glyph } from './glyph';
import { rovingTarget, tabStopIndex } from './roving';

/**
 * The data table, to the v1.1 Components page ("D · Data · Table") and the P04
 * list export (bulk bar, footer):
 *
 *   wrapper   1px border, radius 10, surface; the body scrolls inside it.
 *   header    sticky, 40px, surface-sunken, 12/700 caps at .04em in text-2,
 *             a 1px divider between columns, and the header shadow.
 *   rows      52px comfortable (touch, agents new to the queue) or 36px dense
 *             (desktop power users), 14px cells, a border under each; a
 *             selected row is primary-soft.
 *   select    a 44px first column holding the 18px table checkbox.
 *   bulk bar  inverse, radius 10, at least 48px: "3 selected", "Select all",
 *             a divider, the actions, and a clear button at the end.
 *   footer    56px: "Showing" in mono, a rows-per-page segmented control of
 *             30px mono items, a divider, the page label and the pager.
 *
 * Native table elements, so a screen reader announces rows, columns and the
 * sort without any ARIA of ours. Every word (column names, "Showing", the
 * pager's labels) is the caller's.
 */

export type TableDensity = 'comfortable' | 'dense';

const DensityContext = createContext<TableDensity>('comfortable');

export interface TableProps extends ComponentPropsWithRef<'table'> {
  readonly density?: TableDensity | undefined;
  /** Classes for the scrolling region, e.g. a max height so the header sticks. */
  readonly scrollClassName?: string | undefined;
  /** A TableFooter, drawn inside the same border. */
  readonly footer?: ReactNode | undefined;
  /** Classes for the bordered wrapper. */
  readonly wrapperClassName?: string | undefined;
}

export function Table({
  density = 'comfortable',
  scrollClassName,
  footer,
  wrapperClassName,
  className,
  children,
  ...rest
}: TableProps) {
  return (
    <DensityContext.Provider value={density}>
      <div
        className={cx(
          'flex min-w-0 flex-col overflow-hidden rounded-10 border border-border bg-surface',
          wrapperClassName,
        )}
      >
        <div className={cx('min-h-0 flex-1 overflow-auto', scrollClassName)}>
          <table
            className={cx(
              'w-full min-w-max border-separate border-spacing-0 text-body-sm text-text',
              className,
            )}
            {...rest}
          >
            {children}
          </table>
        </div>
        {footer}
      </div>
    </DensityContext.Provider>
  );
}

export function TableHead({ className, ...rest }: ComponentPropsWithRef<'thead'>) {
  return <thead className={cx('sticky top-0 z-[2]', className)} {...rest} />;
}

export function TableBody(props: ComponentPropsWithRef<'tbody'>) {
  return <tbody {...props} />;
}

export interface TableRowProps extends ComponentPropsWithRef<'tr'> {
  readonly selected?: boolean | undefined;
}

export function TableRow({ selected, className, ...rest }: TableRowProps) {
  return (
    <tr
      aria-selected={selected}
      data-selected={selected === true ? '' : undefined}
      className={cx('group/row', className)}
      {...rest}
    />
  );
}

/** The header cell's look, shared with the select-all cell. */
const HEADER_CELL =
  'h-control-md whitespace-nowrap border-b border-border bg-surface-sunken px-3 text-start align-middle text-caption font-bold uppercase tracking-[0.04em] text-text-2 shadow-table-header [&:not(:first-child)]:border-s [[data-k-select]+&]:border-s-0';

export type SortDirection = 'ascending' | 'descending' | 'none';

export interface TableHeaderCellProps extends Omit<ComponentPropsWithRef<'th'>, 'align'> {
  readonly align?: 'start' | 'end' | 'center' | undefined;
  /** The column's sort. Given with `onSort`, the header is a button. */
  readonly sort?: SortDirection | undefined;
  readonly onSort?: VoidFunction | undefined;
}

const ALIGN = { start: 'text-start', end: 'text-end', center: 'text-center' } as const;
const JUSTIFY = { start: 'justify-start', end: 'justify-end', center: 'justify-center' } as const;
const SORT_ICON: Record<Exclude<SortDirection, 'none'>, IconName> = {
  ascending: 'arrow_upward',
  descending: 'arrow_downward',
};

export function TableHeaderCell({
  align = 'start',
  sort,
  onSort,
  className,
  children,
  ...rest
}: TableHeaderCellProps) {
  const icon = sort === undefined || sort === 'none' ? null : SORT_ICON[sort];
  return (
    <th
      scope="col"
      aria-sort={sort}
      className={cx(HEADER_CELL, ALIGN[align], className)}
      {...rest}
    >
      {onSort === undefined ? (
        <span className={cx('inline-flex items-center gap-1', JUSTIFY[align])}>
          {children}
          {icon === null ? null : <Glyph name={icon} size={16} />}
        </span>
      ) : (
        <button
          type="button"
          onClick={onSort}
          className={cx(
            'inline-flex h-control-sm items-center gap-1 rounded-sm uppercase tracking-[0.04em] is-focus-visible:ring-focus',
            JUSTIFY[align],
          )}
        >
          {children}
          {icon === null ? null : <Glyph name={icon} size={16} />}
        </button>
      )}
    </th>
  );
}

const ROW_HEIGHT: Record<TableDensity, string> = {
  comfortable: 'h-control-xl',
  dense: 'h-control-sm',
};

/** A body cell's look: the row's height, its border and its selected fill. */
function bodyCell(density: TableDensity): string {
  return cx(
    ROW_HEIGHT[density],
    'border-b border-border bg-surface align-middle group-data-[selected]/row:bg-primary-soft',
  );
}

export interface TableCellProps extends Omit<ComponentPropsWithRef<'td'>, 'align'> {
  readonly align?: 'start' | 'end' | 'center' | undefined;
  /** IDs, phones and amounts: mono 13 with tabular figures, never wrapping. */
  readonly numeric?: boolean | undefined;
}

export function TableCell({ align, numeric, className, ...rest }: TableCellProps) {
  const density = useContext(DensityContext);
  return (
    <td
      className={cx(
        bodyCell(density),
        'px-3',
        numeric === true && 'whitespace-nowrap font-mono text-meta tabular-nums',
        ALIGN[align ?? (numeric === true ? 'end' : 'start')],
        className,
      )}
      {...rest}
    />
  );
}

/** A two-line primary cell: a 600 name over a 12px muted line, both truncating. */
export function TableCellTitle({
  title,
  subtitle,
}: {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode | undefined;
}) {
  return (
    <span className="flex min-w-0 flex-col">
      <b className="truncate font-semibold">{title}</b>
      {subtitle === undefined ? null : (
        <span className="truncate text-caption font-normal text-text-muted">{subtitle}</span>
      )}
    </span>
  );
}

interface SelectCellProps {
  readonly checked: boolean;
  readonly onCheckedChange: { (checked: boolean): void };
  /** The accessible name: "Select Adaeze Eze", "Select all on this page". */
  readonly label: string;
  readonly indeterminate?: boolean | undefined;
  readonly disabled?: boolean | undefined;
}

function SelectBox({ checked, onCheckedChange, label, indeterminate, disabled }: SelectCellProps) {
  const density = useContext(DensityContext);
  return (
    <Checkbox
      size="compact"
      aria-label={label}
      checked={checked}
      indeterminate={indeterminate === true}
      disabled={disabled}
      onChange={(event) => onCheckedChange(event.currentTarget.checked)}
      // The 44px hit area overlaps the dense row's 36px rather than growing it.
      className={density === 'dense' ? '-my-1' : undefined}
    />
  );
}

/** The 44px select-all header cell. */
export function TableSelectHeader(props: SelectCellProps) {
  return (
    <th scope="col" data-k-select="" className={cx(HEADER_CELL, 'w-control-base px-0 text-center')}>
      <SelectBox {...props} />
    </th>
  );
}

/** The 44px select cell at the start of a body row. */
export function TableSelectCell(props: SelectCellProps) {
  const density = useContext(DensityContext);
  return (
    <td className={cx(bodyCell(density), 'w-control-base px-0 text-center')}>
      <SelectBox {...props} />
    </td>
  );
}

// ---------------------------------------------------------------------------
// Bulk bar
// ---------------------------------------------------------------------------

export interface TableBulkBarProps extends Omit<ComponentPropsWithRef<'div'>, 'children'> {
  /** "3 selected", already formatted with the count. */
  readonly count: ReactNode;
  /** "Select all 64", when more rows exist than are selected. */
  readonly selectAll?: { readonly label: ReactNode; readonly onClick: VoidFunction } | undefined;
  /** BulkAction buttons. */
  readonly actions?: ReactNode | undefined;
  readonly onClear: VoidFunction;
  /** The clear button's accessible name ("Clear selection"). */
  readonly clearLabel: string;
  /** The toolbar's accessible name ("Bulk actions"). */
  readonly 'aria-label': string;
}

export function TableBulkBar({
  count,
  selectAll,
  actions,
  onClear,
  clearLabel,
  className,
  ...rest
}: TableBulkBarProps) {
  return (
    <div
      role="toolbar"
      className={cx(
        'flex min-h-12 flex-wrap items-center gap-0.5 rounded-10 bg-inverse py-1 pe-1.5 ps-4 text-on-inverse',
        className,
      )}
      {...rest}
    >
      <b className="me-1.5 text-body-sm font-bold">{count}</b>
      {selectAll === undefined ? null : (
        <button
          type="button"
          onClick={selectAll.onClick}
          className="h-control-md rounded-md px-2 text-meta font-semibold underline underline-offset-3 is-focus-visible:ring-focus"
        >
          {selectAll.label}
        </button>
      )}
      {actions === undefined ? null : (
        <>
          <span aria-hidden="true" className="mx-2 h-6 w-px bg-current opacity-30" />
          {actions}
        </>
      )}
      <button
        type="button"
        aria-label={clearLabel}
        onClick={onClear}
        className="ms-auto inline-flex size-control-md items-center justify-center rounded-md is-focus-visible:ring-focus"
      >
        <Glyph name="close" size={20} />
      </button>
    </div>
  );
}

export interface BulkActionProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  readonly icon: IconName;
  readonly children: ReactNode;
}

/** One action in the bulk bar: a 40px, 13/600 text button with a leading glyph. */
export function BulkAction({ icon, className, children, type = 'button', ...rest }: BulkActionProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex h-control-md items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-meta font-semibold is-focus-visible:ring-focus disabled:cursor-not-allowed disabled:text-disabled-text',
        className,
      )}
      {...rest}
    >
      <Glyph name={icon} size={20} />
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

export interface PagerButton {
  readonly label: string;
  readonly onClick: VoidFunction;
  readonly disabled?: boolean | undefined;
}

export interface RowsPerPage {
  /** The visible label and the group's name ("Rows per page"). */
  readonly label: string;
  readonly options: readonly number[];
  readonly value: number;
  readonly onChange: { (value: number): void };
}

export interface TableFooterProps {
  /** "Showing 1–25", with the range in a mono <b> (`TableFooterRange`). */
  readonly summary: ReactNode;
  readonly rowsPerPage?: RowsPerPage | undefined;
  /** "Page 1". */
  readonly page?: ReactNode | undefined;
  readonly previous: PagerButton;
  readonly next: PagerButton;
}

/** The mono range inside the footer's summary. */
export function TableFooterRange({ children }: { readonly children: ReactNode }) {
  return <b className="font-mono font-bold text-text">{children}</b>;
}

function RowsPerPageGroup({ label, options, value, onChange }: RowsPerPage) {
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const disabled: readonly boolean[] = new Array<boolean>(options.length).fill(false);
  const stop = tabStopIndex(options.indexOf(value), disabled);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const current = items.current.findIndex((item) => item === event.target);
    if (current === -1) return;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const next = rovingTarget(event.key, current, disabled, { rtl, orientation: 'both' });
    if (next === null) return;
    event.preventDefault();
    items.current[next]?.focus();
    const option = options[next];
    if (option !== undefined) onChange(option);
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="inline-flex gap-0.5 rounded-md bg-surface-sunken p-0.75"
    >
      {options.map((option, index) => {
        const selected = option === value;
        return (
          <button
            key={option}
            ref={(node) => {
              items.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={index === stop ? 0 : -1}
            onClick={() => onChange(option)}
            className={cx(
              'h-overlay-pager-item min-w-10 rounded-6 px-2 font-mono text-caption font-semibold transition-colors duration-quick is-focus-visible:ring-focus',
              selected ? 'bg-surface text-text shadow-1' : 'bg-transparent text-text-2',
            )}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

function PagerIconButton({ icon, button }: { readonly icon: IconName; readonly button: PagerButton }) {
  return (
    <button
      type="button"
      aria-label={button.label}
      disabled={button.disabled}
      onClick={button.onClick}
      className="inline-flex size-control-md shrink-0 items-center justify-center rounded-md border border-border-strong bg-surface text-text transition-colors duration-instant is-hover:bg-surface-sunken is-focus-visible:ring-focus disabled:cursor-not-allowed disabled:border-border disabled:text-disabled-text"
    >
      <Glyph name={icon} size={20} className="rtl:-scale-x-100" />
    </button>
  );
}

/**
 * The 56px footer under the rows (P04). D-P13 lists show no exact total: pass
 * a summary and a page label without "of N" there.
 */
export function TableFooter({ summary, rowsPerPage, page, previous, next }: TableFooterProps) {
  return (
    <div className="flex min-h-overlay-table-footer shrink-0 flex-wrap items-center gap-3 border-t border-border bg-surface py-2 pe-2 ps-4 text-meta text-text-2">
      <span>{summary}</span>
      <span className="flex-1" />
      {rowsPerPage === undefined ? null : (
        <span className="flex items-center gap-3">
          <span aria-hidden="true">{rowsPerPage.label}</span>
          <RowsPerPageGroup {...rowsPerPage} />
          <span aria-hidden="true" className="h-6 w-px bg-border" />
        </span>
      )}
      {page === undefined ? null : <span>{page}</span>}
      <span className="flex items-center gap-2">
        <PagerIconButton icon="chevron_left" button={previous} />
        <PagerIconButton icon="chevron_right" button={next} />
      </span>
    </div>
  );
}
