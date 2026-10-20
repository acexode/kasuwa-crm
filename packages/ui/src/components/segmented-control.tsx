'use client';

import {
  useRef,
  useState,
  type ComponentPropsWithRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { IconName } from '../icons.generated';
import { cx, type DataAttributes } from './class-names';
import { Glyph } from './glyph';
import { rovingTarget, tabStopIndex } from './roving';

export interface SegmentedOption {
  readonly value: string;
  readonly label: ReactNode;
  /** An 18px leading glyph (P04's view switcher: table_rows, view_kanban). */
  readonly icon?: IconName;
  readonly disabled?: boolean;
  /** `data-*` for this option's element. */
  readonly attributes?: DataAttributes;
}

export interface SegmentedControlProps extends Omit<
  ComponentPropsWithRef<'div'>,
  'onChange' | 'defaultValue' | 'children'
> {
  readonly options: readonly SegmentedOption[];
  /** Controlled selection. */
  readonly value?: string;
  /** Initial selection when uncontrolled. Defaults to the first option. */
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  /** What the group chooses ("View", "Density"). Required: the group needs a name. */
  readonly 'aria-label': string;
}

/**
 * A segmented control (v1.1 table density toggle; P04 view switcher; v1.1
 * currency picker): a surface-sunken track, 3px padding, radius 8, 4px apart;
 * 36px items at 13/600, 0 12px, radius 6. The selected item is surface with
 * shadow-1 in text; the others are transparent in text-2.
 *
 * One choice of several, so it is a radio group: Tab enters at the selected
 * item and leaves the group, the arrow keys (left and right swap in RTL) move
 * and select, Home and End go to the ends.
 */
export function SegmentedControl({
  options,
  value,
  defaultValue,
  onValueChange,
  className,
  ...rest
}: SegmentedControlProps) {
  const [own, setOwn] = useState(defaultValue ?? options[0]?.value);
  const selected = value ?? own;
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const disabled = options.map((option) => option.disabled === true);
  const stop = tabStopIndex(
    options.findIndex((option) => option.value === selected),
    disabled,
  );

  function choose(index: number): void {
    const option = options[index];
    if (option === undefined || option.disabled === true) return;
    if (value === undefined) setOwn(option.value);
    if (option.value !== selected) onValueChange?.(option.value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const current = items.current.findIndex((item) => item === event.target);
    if (current === -1) return;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const next = rovingTarget(event.key, current, disabled, { rtl, orientation: 'both' });
    if (next === null) return;
    event.preventDefault();
    items.current[next]?.focus();
    choose(next);
  }

  return (
    <div
      role="radiogroup"
      onKeyDown={onKeyDown}
      className={cx('inline-flex max-w-full gap-1 rounded-md bg-surface-sunken p-0.75', className)}
      {...rest}
    >
      {options.map((option, index) => {
        const isSelected = option.value === selected;
        return (
          <button
            key={option.value}
            ref={(node) => {
              items.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={isSelected}
            disabled={option.disabled}
            tabIndex={index === stop ? 0 : -1}
            onClick={() => choose(index)}
            className={cx(
              'inline-flex h-control-sm shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-6 px-3 text-meta font-semibold transition-colors duration-quick is-focus-visible:ring-focus disabled:cursor-not-allowed disabled:text-disabled-text',
              isSelected ? 'bg-surface text-text shadow-1' : 'bg-transparent text-text-2',
            )}
            {...option.attributes}
          >
            {option.icon === undefined ? null : <Glyph name={option.icon} size={18} />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
