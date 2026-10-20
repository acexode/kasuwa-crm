'use client';

import type { ReactNode } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import { FOCUS } from './list-classes';

/**
 * P04/05's two states with no rows (T-0133), measured from the export:
 *   - EMPTY ("No leads yet"): a 72px primary-soft disc, a 28/800 title, a
 *     16px explanation, two option cards (radius 12, 22px inset, a 40px icon
 *     tile, a 17/700 heading) and a muted footer line; on a phone, two stacked
 *     full-width buttons and the "easier on a computer" line.
 *   - NO RESULTS ("No contacts match"): inside the table's own card, a 56px
 *     sunken disc with `search_off`, a 22/700 title, the 15px sentence saying
 *     what was searched, "Clear search and filters" and "Remove last filter".
 */

export const STATE_PRIMARY = `inline-flex h-control-base items-center justify-center gap-1.5 rounded-md bg-primary px-3.5 text-body-sm font-bold text-on-primary hover:bg-primary-hover aria-disabled:cursor-not-allowed ${FOCUS}`;
export const STATE_SECONDARY = `inline-flex h-control-base items-center justify-center gap-1.5 rounded-md border border-border-strong bg-surface px-3.5 text-body-sm font-semibold text-text hover:bg-surface-sunken aria-disabled:cursor-not-allowed ${FOCUS}`;
export const STATE_QUIET = `inline-flex h-control-base items-center justify-center rounded-md px-3 text-body-sm font-bold text-primary-text hover:bg-primary-soft aria-disabled:cursor-not-allowed ${FOCUS}`;

export interface OptionCard {
  readonly icon: IconName;
  readonly tone: 'sunken' | 'success';
  readonly title: string;
  readonly body: string;
  readonly actions: ReactNode;
}

export function EmptyLanding({
  icon,
  title,
  body,
  cards,
  footer,
  phoneActions,
  phoneNote,
}: {
  icon: IconName;
  title: string;
  body: string;
  cards: readonly OptionCard[];
  footer: ReactNode;
  phoneActions: ReactNode;
  phoneNote: string;
}) {
  return (
    <div data-testid="empty-state" data-screen-state="P04/05" className="flex justify-center py-6 md:py-16">
      <div className="flex w-full max-w-4xl flex-col items-center gap-5 text-center">
        <span className="flex items-center justify-center rounded-full bg-primary-soft p-5 text-primary-text">
          <Icon name={icon} size={32} />
        </span>
        <div className="flex flex-col items-center gap-2">
          <h2 className="text-h4 font-extrabold md:text-title">{title}</h2>
          <p className="max-w-xl text-body-md text-text-2">{body}</p>
        </div>
        <div className="hidden w-full grid-cols-2 gap-4 text-start md:grid">
          {cards.map((card) => (
            <div key={card.title} className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-5">
              <span className="flex items-center gap-2.5">
                <span
                  className={`flex size-10 shrink-0 items-center justify-center rounded-10 ${
                    card.tone === 'success' ? 'bg-success-soft text-success-text' : 'bg-surface-sunken text-text'
                  }`}
                >
                  <Icon name={card.icon} size={22} />
                </span>
                <b className="text-h5 font-bold">{card.title}</b>
              </span>
              <span className="text-body-sm text-text-2">{card.body}</span>
              <div className="mt-1 flex flex-wrap gap-2">{card.actions}</div>
            </div>
          ))}
        </div>
        <span className="hidden text-meta text-text-muted md:block">{footer}</span>
        <div className="flex w-full flex-col gap-2 md:hidden">{phoneActions}</div>
        <span className="text-caption text-text-2 md:hidden">{phoneNote}</span>
      </div>
    </div>
  );
}

export function NoResults({
  t,
  title,
  message,
  onClear,
  onRemoveLast,
}: {
  t: Translator;
  title: string;
  message: ReactNode;
  onClear: () => void;
  /** Present when at least one filter is on. */
  onRemoveLast: (() => void) | null;
}) {
  return (
    <div className="flex min-h-96 items-center justify-center rounded-lg border border-border bg-surface p-8 max-md:-mx-4 max-md:min-h-0 max-md:rounded-none max-md:border-x-0 max-md:border-b-0 max-md:bg-transparent">
      <div className="flex max-w-lg flex-col items-center gap-3 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-surface-sunken text-text-2">
          <Icon name="search_off" size={28} />
        </span>
        <h2 className="text-h5 font-bold md:text-h4">{title}</h2>
        <p data-testid="no-results-message" className="text-label font-normal text-text-2">
          {message}
        </p>
        <div className="mt-1 flex flex-wrap justify-center gap-2">
          <button type="button" data-action="clear-search-filters" onClick={onClear} className={STATE_PRIMARY}>
            {t.t('records.noResults.clear')}
          </button>
          {onRemoveLast === null ? null : (
            <button type="button" data-action="remove-last-filter" onClick={onRemoveLast} className={`${STATE_SECONDARY} max-md:hidden`}>
              {t.t('records.noResults.removeLast')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A disabled state action for a flow that is not built: full fidelity, `aria-disabled`, the reason read out. */
export function UnbuiltAction({
  t,
  action,
  icon,
  label,
  className,
}: {
  t: Translator;
  action: string;
  icon?: IconName;
  label: MessageId;
  className: string;
}) {
  return (
    <button
      type="button"
      data-action={action}
      data-requires-connection=""
      aria-disabled="true"
      title={t.t('records.action.unavailable')}
      className={className}
    >
      {icon === undefined ? null : <Icon name={icon} size={20} />}
      {t.t(label)}
      <span className="sr-only">{t.t('records.action.unavailable')}</span>
    </button>
  );
}
