'use client';

import type { ComponentPropsWithRef, ReactNode } from 'react';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';

/**
 * P07's toggle pills (T-0136), as the export draws them: the task filters
 * ("All", "Mine only": 36px, 0 12px, 13/600) and the composer's and booking
 * page's duration and channel pills (40px, 13/700). Radius 999, a 1px
 * border-strong edge on surface; pressed is a solid primary fill with
 * on-primary text (`soft` is the reminder pills' primary-soft instead).
 *
 * `@kasuwa/ui/components`' Chip is the P04 filter chip, whose active state is
 * primary-soft; the P07 export fills its pressed pills, so the two differ in
 * the one property that says which is chosen. When the component library
 * grows a solid toggle pill, these become it.
 */
export function ToggleChip({
  pressed,
  size = 'filter',
  soft = false,
  icon,
  className = '',
  children,
  ...rest
}: Omit<ComponentPropsWithRef<'button'>, 'children'> & {
  readonly pressed: boolean;
  readonly size?: 'filter' | 'choice';
  readonly soft?: boolean;
  readonly icon?: IconName;
  readonly children: ReactNode;
}) {
  const on = soft
    ? 'border-primary bg-primary-soft text-primary-text'
    : 'border-primary bg-primary text-on-primary is-hover:bg-primary-hover';
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={`relative inline-flex shrink-0 select-none items-center gap-1 whitespace-nowrap rounded-full border px-3 text-meta transition-colors duration-instant before:absolute before:inset-x-0 before:-inset-y-1 is-focus-visible:ring-focus disabled:cursor-not-allowed disabled:border-border disabled:bg-surface disabled:text-disabled-text ${
        size === 'filter' ? 'h-control-sm font-semibold' : 'h-control-md font-bold'
      } ${pressed ? on : 'border-border-strong bg-surface text-text is-hover:bg-surface-sunken'} ${className}`}
      {...rest}
    >
      {icon === undefined ? null : <Icon name={icon} size={16} />}
      {children}
    </button>
  );
}
