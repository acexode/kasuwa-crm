'use client';

import { useState, type ReactNode } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import type { DuplicateSet } from '../../lib/duplicates-api';
import { pairOf, setKey, togglePick } from './duplicates-model';
import { PersonName, When } from './duplicates-parts';

/**
 * The duplicate sets as the API serves them (C), in served order: what they
 * match on in words (exact phone or email, D-P12), each contact's name and when
 * it was last updated. No matched value, no score, no count: none is served.
 *
 * A set of two opens the merge directly. In a larger set exactly two are
 * picked first (pairwise, D-L146); picking a third is allowed and simply turns
 * Review off, so the person sees why.
 */
export function SetsList({
  t,
  locale,
  sets,
  onReview,
}: {
  t: Translator;
  locale: string;
  sets: readonly DuplicateSet[];
  onReview: (pair: readonly [string, string]) => void;
}) {
  const [picks, setPicks] = useState<Readonly<Record<string, readonly string[]>>>({});
  return (
    <ul data-testid="duplicate-sets" className="flex flex-col gap-3">
      {sets.map((set) => {
        const key = setKey(set);
        const picked = picks[key] ?? [];
        const pair = pairOf(set, picked);
        const choose = set.contacts.length > 2;
        return (
          <li key={key} data-duplicate-set="" data-match-on={set.matchOn} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
            <p className="flex items-center gap-2 text-body-sm font-semibold text-text-2">
              <Icon name={set.matchOn === 'phone' ? 'call' : 'mail'} size="sm" />
              {t.t(set.matchOn === 'phone' ? 'duplicates.match.phone' : 'duplicates.match.email')}
            </p>
            <Members choose={choose} legend={t.t('duplicates.pick.legend')}>
              {set.contacts.map((contact) => (
                <div key={contact.id} data-duplicate-contact={contact.id} className="flex min-h-touch flex-wrap items-center gap-x-3 gap-y-1">
                  {choose ? (
                    <label className="flex min-h-touch min-w-0 items-center gap-3">
                      <input
                        type="checkbox"
                        data-duplicate-pick={contact.id}
                        checked={picked.includes(contact.id)}
                        onChange={() => setPicks((held) => ({ ...held, [key]: togglePick(held[key] ?? [], contact.id) }))}
                        className="h-5 w-5 shrink-0 accent-primary"
                      />
                      <PersonName t={t} name={contact.displayName} />
                    </label>
                  ) : (
                    <PersonName t={t} name={contact.displayName} />
                  )}
                  <span className="text-body-sm text-text-2">
                    {t.t('duplicates.updated')} <When locale={locale} iso={contact.updatedAt} />
                  </span>
                </div>
              ))}
            </Members>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                data-duplicate-review=""
                disabled={pair === null}
                onClick={() => (pair === null ? undefined : onReview(pair))}
                className={PRIMARY_BUTTON}
              >
                {t.t('duplicates.review')}
              </button>
              {choose && pair === null ? <span className="text-body-sm text-text-2">{t.t('duplicates.pick.hint')}</span> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** A set of three or more is a labelled group of checkboxes; a pair is just its two names. */
function Members({ choose, legend, children }: { choose: boolean; legend: string; children: ReactNode }) {
  if (!choose) return <div className="flex min-w-0 flex-col gap-2">{children}</div>;
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-1 text-body-sm text-text-2">{legend}</legend>
      {children}
    </fieldset>
  );
}

/** The next page of sets, while `nextCursor` says there is one: no total, no page count. */
export function MoreButton({ t, testId, loading, disabled, onClick }: { t: Translator; testId: string; loading: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <div className="flex justify-center">
      <button type="button" data-testid={testId} disabled={disabled || loading} onClick={onClick} className={SECONDARY_BUTTON}>
        {loading ? t.t('records.loadingMore') : t.t('duplicates.more')}
      </button>
    </div>
  );
}
