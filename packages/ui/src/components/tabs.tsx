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

export interface TabItem {
  readonly value: string;
  readonly label: ReactNode;
  /** An 18px leading glyph (the P05 composer: chat, sms, mail). */
  readonly icon?: IconName;
  /** A count after the label ("24"), already formatted for the locale. */
  readonly count?: ReactNode;
  readonly disabled?: boolean;
  /** The id of the panel this tab shows, for `aria-controls`. */
  readonly controls?: string;
  /** `data-*` for this tab's element. */
  readonly attributes?: DataAttributes;
}

export interface TabsProps extends Omit<
  ComponentPropsWithRef<'div'>,
  'onChange' | 'defaultValue' | 'children'
> {
  readonly items: readonly TabItem[];
  /** Controlled selection. */
  readonly value?: string;
  /** Initial selection when uncontrolled. Defaults to the first tab. */
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  /**
   * 'automatic' (the default) shows a tab's panel as soon as it is focused,
   * right for panels already in the page. 'manual' waits for Enter or Space,
   * for panels that fetch: on a slow connection, arrowing past three tabs must
   * not start three requests.
   */
  readonly activation?: 'automatic' | 'manual';
  /** What the tabs switch between ("Record sections"). */
  readonly 'aria-label': string;
  /** Prefix for each tab's id (`<id>-<value>`), so a panel can name its tab. */
  readonly id?: string;
}

/**
 * Underline tabs, as v1.1 ("C · Navigation") and the P05 and P07 exports draw
 * them: 44px, 0 12px, 14px, on a 1px border bottom edge, 4px apart. The
 * selected tab is 700 in primary-text over a 3px primary underline; the rest
 * are 500 in text-2. No fill: these are tabs, not pills. A count sits after
 * the label at 11px on surface-sunken in text-muted.
 *
 * The underline is a pseudo-element rather than a box-shadow, so the focus
 * ring (a box-shadow) does not replace it on the focused tab.
 *
 * Keyboard (WAI-ARIA tabs): Tab enters at the selected tab and leaves the
 * list; left and right (swapped in RTL) move between tabs, wrapping; Home and
 * End go to the ends.
 */
export function Tabs({
  items,
  value,
  defaultValue,
  onValueChange,
  activation = 'automatic',
  id,
  className,
  ...rest
}: TabsProps) {
  const [own, setOwn] = useState(defaultValue ?? items[0]?.value);
  const selected = value ?? own;
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const disabled = items.map((item) => item.disabled === true);
  const stop = tabStopIndex(
    items.findIndex((item) => item.value === selected),
    disabled,
  );

  function choose(index: number): void {
    const item = items[index];
    if (item === undefined || item.disabled === true) return;
    if (value === undefined) setOwn(item.value);
    if (item.value !== selected) onValueChange?.(item.value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const current = tabs.current.findIndex((tab) => tab === event.target);
    if (current === -1) return;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const next = rovingTarget(event.key, current, disabled, { rtl, orientation: 'horizontal' });
    if (next === null) return;
    event.preventDefault();
    tabs.current[next]?.focus();
    if (activation === 'automatic') choose(next);
  }

  return (
    <div
      role="tablist"
      id={id}
      onKeyDown={onKeyDown}
      className={cx('flex gap-1 border-b border-border', className)}
      {...rest}
    >
      {items.map((item, index) => {
        const isSelected = item.value === selected;
        return (
          <button
            key={item.value}
            ref={(node) => {
              tabs.current[index] = node;
            }}
            id={id === undefined ? undefined : `${id}-${item.value}`}
            type="button"
            role="tab"
            aria-selected={isSelected}
            aria-controls={item.controls}
            disabled={item.disabled}
            tabIndex={index === stop ? 0 : -1}
            onClick={() => choose(index)}
            className={cx(
              'relative inline-flex h-control-base shrink-0 select-none items-center gap-1.5 whitespace-nowrap bg-transparent px-3 text-body-sm transition-colors duration-quick is-focus-visible:ring-focus disabled:cursor-not-allowed disabled:text-disabled-text',
              isSelected
                ? 'font-bold text-primary-text after:absolute after:inset-x-0 after:bottom-0 after:h-0.75 after:bg-primary'
                : 'font-medium text-text-2',
            )}
            {...item.attributes}
          >
            {item.icon === undefined ? null : <Glyph name={item.icon} size={18} />}
            {item.label}
            {item.count === undefined ? null : (
              <span
                className={cx(
                  'rounded-full bg-surface-sunken px-1.5 py-px text-micro text-text-muted',
                  isSelected ? 'font-bold' : 'font-medium',
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
