import type { ReactNode } from 'react';
import type { IconName } from '../icons.generated';
import { cx } from './class-names';
import { Glyph } from './glyph';

/**
 * The empty state, to the v1.1 Patterns ("I · Empty states") and Components
 * ("F · Feedback & overlays") pages. "Text first: one 26px icon in a tinted
 * circle, a title that states the situation, one sentence on what to do."
 *
 *   start   the Patterns block: a 48px disc with a 26px glyph, an optional
 *           11/700 caps overline in text-muted, a 17/24/700 title, 14/21 body
 *           in text-2, then the action. Left-aligned, 10px apart.
 *   center  the Components block: a 64px disc with a 32px glyph, an 18/700
 *           title, a 14/20 body at most 280px wide, the action 6px lower.
 *
 * Tones: `primary` (primary-soft) for first use, `neutral` (surface-sunken in
 * text-2) for no results and permission, `info` (info-soft) for offline.
 * Only first use gets a primary button; the others use secondary, because
 * they are recoveries rather than invitations. The caller passes the button.
 */

export type EmptyStateTone = 'primary' | 'neutral' | 'info' | 'danger';
export type EmptyStateAlign = 'start' | 'center';

const DISC: Record<EmptyStateTone, string> = {
  primary: 'bg-primary-soft text-primary-text',
  neutral: 'bg-surface-sunken text-text-2',
  info: 'bg-info-soft text-info-text',
  danger: 'bg-danger-soft text-danger-text',
};

export interface EmptyStateProps {
  readonly icon: IconName;
  readonly title: ReactNode;
  readonly body?: ReactNode | undefined;
  /** An 11px caps line above the title ("First use", "Offline · cached only"). */
  readonly eyebrow?: ReactNode | undefined;
  readonly tone?: EmptyStateTone | undefined;
  readonly align?: EmptyStateAlign | undefined;
  /** The one action: a Button. */
  readonly action?: ReactNode | undefined;
  /** Anything between body and action: the removable filter chips. */
  readonly extra?: ReactNode | undefined;
  /** A muted line under the action ("or import a CSV"). */
  readonly footnote?: ReactNode | undefined;
  /** The title's heading level. Defaults to h2. */
  readonly headingLevel?: 2 | 3 | 4 | undefined;
  readonly className?: string | undefined;
}

export function EmptyState({
  icon,
  title,
  body,
  eyebrow,
  tone = 'primary',
  align = 'start',
  action,
  extra,
  footnote,
  headingLevel = 2,
  className,
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  const center = align === 'center';
  return (
    <div
      className={cx(
        'flex flex-col gap-2.5',
        center ? 'items-center text-center' : 'items-start text-start',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'flex shrink-0 items-center justify-center rounded-full',
          center ? 'size-16' : 'size-12',
          DISC[tone],
        )}
      >
        <Glyph name={icon} size={center ? 32 : 26} />
      </span>
      {eyebrow === undefined ? null : (
        <span className="text-overline text-text-muted">{eyebrow}</span>
      )}
      <Heading className={cx('m-0 text-text', center ? 'text-h5 font-bold' : 'text-sheet-title')}>
        {title}
      </Heading>
      {body === undefined ? null : (
        <p
          className={cx(
            'm-0 text-pretty text-text-2',
            center ? 'max-w-overlay-empty-text text-body-sm' : 'text-body-relaxed',
          )}
        >
          {body}
        </p>
      )}
      {extra}
      {action === undefined ? null : (
        <div className={center ? 'mt-1.5' : 'mt-1'}>{action}</div>
      )}
      {footnote === undefined ? null : (
        <span className="text-meta text-text-muted">{footnote}</span>
      )}
    </div>
  );
}
