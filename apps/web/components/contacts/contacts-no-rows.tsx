'use client';

import Link from 'next/link';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { EmptyLanding, NoResults, STATE_PRIMARY, STATE_QUIET, STATE_SECONDARY, UnbuiltAction } from '../records/list-states';
import { FILTERS, activeFilterKeys, optionLabel, type FilterState } from './contacts-model';

/**
 * The two states with no rows on P04/05 (restyled to the export by T-0133):
 * no contacts yet, and no results for this search. Loaded when one is
 * reached, not on the list's first paint.
 */
export function NoRows({
  t,
  state,
  answered,
  onClear,
  onRemoveLast,
  importHref,
  offline,
}: {
  t: Translator;
  state: 'empty' | 'no-results';
  answered: { readonly q: string; readonly view: FilterState };
  onClear: () => void;
  onRemoveLast: (() => void) | null;
  /** The import screen, where it is live here (`live.includes('import')`, decided by the list). */
  importHref: string | null;
  offline: boolean;
}) {
  if (state === 'empty') return <EmptyState t={t} importHref={importHref} offline={offline} />;

  return (
    <NoResults
      t={t}
      title={t.t('records.noResults.title')}
      message={
        <>
          {answered.q.trim() === '' ? null : t.t('records.noResults.query', { query: answered.q.trim() })}{' '}
          {activeFilterKeys(answered.view).length === 0
            ? null
            : t.t('records.noResults.filters', { filters: describeFilters(t, answered.view) })}
        </>
      }
      onClear={onClear}
      onRemoveLast={onRemoveLast}
    />
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

/** The import action where the import screen is live (T-0096): the `[data-action^="import"]` hook, as a link. */
function ImportCsv({ t, href, action, offline, className }: { t: Translator; href: string; action: string; offline: boolean; className: string }) {
  return (
    <Link
      href={href}
      prefetch={false}
      data-action={action}
      data-requires-connection=""
      aria-disabled={offline ? 'true' : undefined}
      onClick={(event) => {
        if (offline) event.preventDefault();
      }}
      className={className}
    >
      <Icon name="upload" size={20} />
      {t.t('records.empty.import.action')}
    </Link>
  );
}

function EmptyState({ t, importHref, offline }: { t: Translator; importHref: string | null; offline: boolean }) {
  return (
    <EmptyLanding
      icon="contacts"
      title={t.t('records.empty.title')}
      body={t.t('records.empty.body')}
      cards={[
        {
          icon: 'upload_file',
          tone: 'sunken',
          title: t.t('records.empty.import.title'),
          body: t.t('records.empty.import.body'),
          actions: (
            <>
              {importHref === null ? (
                <UnbuiltAction t={t} action="import-csv-empty" icon="upload" label="records.empty.import.action" className={STATE_PRIMARY} />
              ) : (
                <ImportCsv t={t} href={importHref} action="import-csv-empty" offline={offline} className={STATE_PRIMARY} />
              )}
              <UnbuiltAction t={t} action="import-zoho" label="records.empty.import.zoho" className={STATE_SECONDARY} />
              <UnbuiltAction t={t} action="import-salesforce" label="records.empty.import.salesforce" className={STATE_SECONDARY} />
            </>
          ),
        },
        {
          icon: 'chat',
          tone: 'success',
          title: t.t('records.empty.capture.title'),
          body: t.t('records.empty.capture.body'),
          actions: (
            <>
              <UnbuiltAction t={t} action="capture-whatsapp" icon="link" label="records.empty.capture.action" className={STATE_SECONDARY} />
              <UnbuiltAction t={t} action="capture-ussd" label="records.empty.capture.ussd" className={STATE_QUIET} />
            </>
          ),
        },
      ]}
      footer={t.t('records.empty.later')}
      phoneActions={
        <>
          <UnbuiltAction
            t={t}
            action="capture-whatsapp-phone"
            icon="chat"
            label="records.empty.capture.title"
            className={`${STATE_PRIMARY} h-control-lg w-full`}
          />
          {importHref === null ? (
            <UnbuiltAction
              t={t}
              action="import-phone"
              icon="upload_file"
              label="records.empty.import.phone"
              className={`${STATE_SECONDARY} h-control-lg w-full`}
            />
          ) : (
            <ImportCsv t={t} href={importHref} action="import-phone" offline={offline} className={`${STATE_SECONDARY} h-control-lg w-full`} />
          )}
        </>
      }
      phoneNote={t.t('records.empty.phoneNote')}
    />
  );
}
