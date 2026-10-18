'use client';

import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { SECONDARY_BUTTON } from '../auth/button-classes';
import { FILTERS, activeFilterKeys, optionLabel, type FilterState } from './contacts-model';
import { UnavailableAction } from './contacts-parts';

/**
 * The two states with no rows on P04/05: no contacts yet, and no results for
 * this search. Loaded when one is reached, not on the list's first paint.
 */
export function NoRows({
  t,
  state,
  answered,
  onClear,
}: {
  t: Translator;
  state: 'empty' | 'no-results';
  answered: { readonly q: string; readonly view: FilterState };
  onClear: () => void;
}) {
  if (state === 'empty') return <EmptyState t={t} />;

    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface p-10 text-center">
        <Icon name="search_off" size="xl" className="text-text-muted" />
        <h2 className="text-h3">{t.t('records.noResults.title')}</h2>
        <p data-testid="no-results-message" className="max-w-xl text-body-md text-text-2">
          {answered.q.trim() === '' ? null : t.t('records.noResults.query', { query: answered.q.trim() })}{' '}
          {activeFilterKeys(answered.view).length === 0
            ? null
            : t.t('records.noResults.filters', { filters: describeFilters(t, answered.view) })}
        </p>
        <button type="button" data-action="clear-search-filters" onClick={onClear} className={SECONDARY_BUTTON}>
          {t.t('records.noResults.clear')}
        </button>
      </div>
    );
}

function describeFilters(t: Translator, filters: FilterState): string {
  return activeFilterKeys(filters)
    .map((key) => {
      const spec = FILTERS.find((filter) => filter.key === key);
      const label = spec === undefined ? key : t.t(spec.label);
      return `${label}: ${filters[key].map((value) => t.t(optionLabel(key, value))).join(', ')}`;
    })
    .join('; ');
}

function EmptyState({ t }: { t: Translator }) {
  return (
    <div data-screen-state="P04/05" className="flex flex-col items-center gap-4 rounded-lg border border-border bg-surface p-8 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-soft text-primary-text">
        <Icon name="contacts" size="xl" />
      </span>
      <h2 className="text-h3">{t.t('records.empty.title')}</h2>
      <p className="max-w-xl text-body-md text-text-2">{t.t('records.empty.body')}</p>
      <div className="grid w-full max-w-3xl gap-4 text-start md:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <b className="flex items-center gap-2 text-body-md">
            <Icon name="upload_file" size="sm" />
            {t.t('records.empty.import.title')}
          </b>
          <p className="text-body-sm text-text-2">{t.t('records.empty.import.body')}</p>
          <UnavailableAction t={t} action="import-csv-empty" icon="upload_file" label="records.empty.import.action" />
        </div>
        <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <b className="flex items-center gap-2 text-body-md">
            <Icon name="chat" size="sm" />
            {t.t('records.empty.capture.title')}
          </b>
          <p className="text-body-sm text-text-2">{t.t('records.empty.capture.body')}</p>
          <UnavailableAction t={t} action="capture-whatsapp" icon="chat" label="records.empty.capture.action" />
        </div>
      </div>
      <p className="text-body-sm text-text-muted">{t.t('records.empty.later')}</p>
    </div>
  );
}
