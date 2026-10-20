'use client';

import { useState } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Button } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { StatusPill, TABLE_CARD, TABLE_HEAD } from '../data/parts';
import type { DuplicateSet } from '../../lib/duplicates-api';
import { formatCount, formatDay, formatWhen } from '../import/import-text';
import { pairOf, setKey, togglePick } from './duplicates-model';
import { PersonName } from './duplicates-parts';

/**
 * The duplicate sets as the API serves them (C), in served order, as the
 * export's table: Records (the first name, then how many and the others), Why
 * they match (exact phone or email, D-P12, as a tag), Confidence, when the
 * newest record was updated, and Review.
 *
 * No matched value and no score is served. A match is exact by rule (D-P12),
 * so the Confidence column says "Exact match", never a percentage; and the
 * design's "Found" date is not served, so the column is the newest update.
 *
 * A set of two opens the merge directly. In a larger set exactly two are
 * picked first (pairwise, D-L146); picking a third is allowed and simply turns
 * Review off, so the person sees why.
 */

const GRID = 'lg:grid lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1.3fr)_130px_110px_100px] lg:items-center lg:gap-3.5';

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
    <div className={TABLE_CARD}>
      <div aria-hidden="true" className={`${TABLE_HEAD} hidden ${GRID}`}>
        <span>{t.t('duplicates.col.records')}</span>
        <span>{t.t('duplicates.col.why')}</span>
        <span>{t.t('duplicates.col.confidence')}</span>
        <span>{t.t('duplicates.col.updated')}</span>
        <span />
      </div>
      <ul data-testid="duplicate-sets" className="m-0 list-none p-0">
        {sets.map((set) => {
          const key = setKey(set);
          const picked = picks[key] ?? [];
          const pair = pairOf(set, picked);
          const choose = set.contacts.length > 2;
          const [first, ...others] = set.contacts;
          const newest = set.contacts.reduce((latest, contact) => (contact.updatedAt > latest ? contact.updatedAt : latest), set.contacts[0]?.updatedAt ?? '');
          return (
            <li key={key} data-duplicate-set="" data-match-on={set.matchOn} className={`flex flex-wrap items-start gap-x-4 gap-y-2.5 border-b border-border px-4 py-3 last:border-b-0 ${GRID}`}>
              <div className="flex min-w-0 basis-full items-start gap-2.5 lg:basis-auto">
                <span aria-hidden="true" className="flex size-[34px] shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary-text">
                  <Icon name="person" size={18} />
                </span>
                {choose ? (
                  <fieldset className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0">
                    <legend className="mb-0.5 p-0 text-body-sm font-bold">
                      {t.t('duplicates.records.count', { count: set.contacts.length, formatted: formatCount(locale, set.contacts.length) })}
                      <span className="block text-caption font-normal text-text-2">{t.t('duplicates.pick.legend')}</span>
                    </legend>
                    {set.contacts.map((contact) => (
                      <label key={contact.id} data-duplicate-contact={contact.id} className="flex min-h-touch min-w-0 cursor-pointer items-center gap-2.5 text-body-sm lg:min-h-8">
                        <input
                          type="checkbox"
                          data-duplicate-pick={contact.id}
                          checked={picked.includes(contact.id)}
                          onChange={() => setPicks((held) => ({ ...held, [key]: togglePick(held[key] ?? [], contact.id) }))}
                          className="size-4.5 shrink-0 accent-primary"
                        />
                        <PersonName t={t} name={contact.displayName} />
                      </label>
                    ))}
                  </fieldset>
                ) : (
                  <div className="flex min-w-0 flex-col">
                    {first === undefined ? null : (
                      <span data-duplicate-contact={first.id} className="min-w-0 text-body-sm">
                        <PersonName t={t} name={first.displayName} />
                      </span>
                    )}
                    <span className="text-caption font-normal text-text-2">
                      {t.t('duplicates.records.count', { count: set.contacts.length, formatted: formatCount(locale, set.contacts.length) })}
                      {others.map((contact) => (
                        <span key={contact.id} data-duplicate-contact={contact.id}>
                          {' · '}
                          <PersonName t={t} name={contact.displayName} quiet />
                        </span>
                      ))}
                    </span>
                  </div>
                )}
              </div>
              <span className="flex flex-wrap gap-1.5">
                <span className="inline-flex h-6 items-center rounded-6 bg-surface-sunken px-2 text-caption font-semibold text-text">
                  {t.t(set.matchOn === 'phone' ? 'duplicates.match.phone' : 'duplicates.match.email')}
                </span>
              </span>
              <span>
                <StatusPill tone="success">{t.t('duplicates.confidence.exact')}</StatusPill>
              </span>
              <time dateTime={newest} title={formatWhen(locale, newest)} className="text-body-sm text-text-2">
                {formatDay(locale, newest)}
              </time>
              <span className="ms-auto flex flex-col items-end gap-1 lg:ms-0">
                <Button size="compact" data-duplicate-review="" disabled={pair === null} onClick={() => (pair === null ? undefined : onReview(pair))}>
                  {t.t('duplicates.review')}
                </Button>
              </span>
              {choose && pair === null ? <span className="basis-full text-caption font-normal text-text-2 lg:col-span-5">{t.t('duplicates.pick.hint')}</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The next page of sets, while `nextCursor` says there is one: no total, no page count. */
export function MoreButton({ t, testId, loading, disabled, onClick }: { t: Translator; testId: string; loading: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <div className="flex justify-center">
      <Button data-testid={testId} disabled={disabled || loading} onClick={onClick}>
        {loading ? t.t('records.loadingMore') : t.t('duplicates.more')}
      </Button>
    </div>
  );
}
