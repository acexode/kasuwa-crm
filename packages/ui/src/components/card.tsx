import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from './class-names';

/**
 * A card, to the v1.1 Components and Patterns pages: surface, a 1px border,
 * radius 12, no shadow (elevation 0 is "flat, bordered": a border survives
 * both themes and a cheap screen in daylight, a faint shadow does not).
 *
 *   padding  lg  24      every Components card
 *            md  24 20   the Patterns empty-state cards (24 top and bottom)
 *            sm  20      the Patterns notes ("Anatomy & scroll")
 *            none        a card holding a table or a list edge to edge
 *
 * `title` is the cards' 18/700 heading and `actions` sits opposite it, as in
 * "Table · Comfortable | Dense". Leave both out for a bare surface.
 */

export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

const PADDING: Record<CardPadding, string> = {
  none: '',
  sm: 'p-5',
  md: 'px-5 py-6',
  lg: 'p-4 sm:p-6',
};

export interface CardProps extends Omit<ComponentPropsWithRef<'div'>, 'title'> {
  readonly padding?: CardPadding | undefined;
  readonly title?: ReactNode | undefined;
  /** A line beside the title in 13px muted ("44px height · 8px radius"). */
  readonly meta?: ReactNode | undefined;
  readonly actions?: ReactNode | undefined;
  /** The heading level of `title`. Defaults to h3, as on the Components page. */
  readonly headingLevel?: 2 | 3 | 4 | undefined;
}

export function Card({
  padding = 'lg',
  title,
  meta,
  actions,
  headingLevel = 3,
  className,
  children,
  ...rest
}: CardProps) {
  const Heading = `h${headingLevel}` as const;
  const hasHeader = title !== undefined || actions !== undefined;
  return (
    <div
      className={cx(
        'flex min-w-0 flex-col gap-3.5 rounded-lg border border-border bg-surface text-text',
        PADDING[padding],
        className,
      )}
      {...rest}
    >
      {hasHeader ? (
        <div className="flex flex-wrap items-center gap-3">
          {title === undefined ? null : (
            <Heading className="m-0 text-h5 font-bold text-text">{title}</Heading>
          )}
          {meta === undefined ? null : <span className="text-meta text-text-muted">{meta}</span>}
          {actions === undefined ? null : (
            <div className="ms-auto flex items-center gap-2">{actions}</div>
          )}
        </div>
      ) : null}
      {children}
    </div>
  );
}
