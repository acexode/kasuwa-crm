'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { cx } from './class-names';

/**
 * Skeleton loaders, to the v1.1 Components page ("Skeleton loaders"):
 * "Match final layout to avoid shift. Shimmer 1.4s; with reduced motion it
 * becomes a static block. After 8s on slow networks, swap to 'Still loading
 * on a slow connection…'."
 *
 *   Skeleton  a surface-sunken block: `line` 12px (radius 4), `line-sm`
 *             10px, `circle` 44px, `block` 64px (radius 8). Width is the
 *             caller's (`w-3/5`), so the skeleton has the final layout's shape.
 *   SkeletonGroup  holds the blocks, draws one shimmer sweep across all of
 *             them, sets aria-busy, and after `slowAfterMs` (8s) shows the
 *             caller's slow-connection line in a polite live region. That is
 *             the 256 kbps NFR made visible: a spinner says nothing, this says
 *             the network is slow and the app is not broken.
 */

export type SkeletonShape = 'line' | 'line-sm' | 'circle' | 'block';

const SHAPE: Record<SkeletonShape, string> = {
  line: 'h-3 rounded-sm',
  'line-sm': 'h-2.5 rounded-sm',
  circle: 'size-11 shrink-0 rounded-full',
  block: 'h-16 rounded-md',
};

export interface SkeletonProps {
  readonly shape?: SkeletonShape | undefined;
  /** Width and any override: `w-3/5`, `h-control-xl`. */
  readonly className?: string | undefined;
}

export function Skeleton({ shape = 'line', className }: SkeletonProps) {
  return <span aria-hidden="true" className={cx('block bg-surface-sunken', SHAPE[shape], className)} />;
}

/** How long before the slow-connection line appears (v1.1: "After 8s"). */
export const SLOW_LOADING_MS = 8000;

export interface SkeletonGroupProps {
  readonly children: ReactNode;
  /** The accessible name while loading ("Loading leads"). */
  readonly label: string;
  /** "Still loading on a slow connection…", shown after `slowAfterMs`. */
  readonly slowMessage?: ReactNode | undefined;
  readonly slowAfterMs?: number | undefined;
  readonly className?: string | undefined;
}

export function SkeletonGroup({
  children,
  label,
  slowMessage,
  slowAfterMs = SLOW_LOADING_MS,
  className,
}: SkeletonGroupProps) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (slowMessage === undefined) return undefined;
    const timer = window.setTimeout(() => {
      setSlow(true);
    }, slowAfterMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [slowAfterMs, slowMessage]);

  return (
    <div className={cx('flex flex-col gap-3.5', className)}>
      <div
        role="progressbar"
        aria-busy="true"
        aria-label={label}
        className="relative flex flex-col gap-3.5 overflow-hidden"
      >
        {children}
        <span
          aria-hidden="true"
          data-k-shimmer=""
          className="pointer-events-none absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-shimmer to-transparent motion-reduce:hidden"
        />
      </div>
      <p role="status" className="m-0 text-meta text-text-muted">
        {slow ? slowMessage : null}
      </p>
    </div>
  );
}
