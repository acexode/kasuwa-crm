'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { FOCUS } from '../records/list-classes';
import { HeaderLock, ListError, ListLoading, LoadMore, Muted, OfflineBanner } from '../records/list-parts';
import { initials, listState, type ListState } from '../records/list-model';
import { useKeysetList, type KeysetList } from '../records/use-keyset-list';
import { getLead, listLeads, type ConvertLeadResult, type Lead } from '../../lib/leads-api';
import {
  LEAD_COLUMNS,
  LEAD_FILTERS,
  activeLeadFilters,
  convertOffer,
  leadColumnLabel,
  leadListError,
  leadOptionLabel,
  lockedLeadColumns,
  nameAriaSort,
  toLeadQuery,
  withheldFromLeadError,
  type LeadColumnKey,
  type LeadFilterState,
  type LeadView,
} from './leads-model';
import { LeadValue, fieldProps } from './lead-parts';

/**
 * `P04/01`'s body (T-0058): the leads table at `md` and up, a card per lead at
 * 360 px, and the five list states. It owns its keyset read (`listLeads`,
 * in memory only, D-L64) and the convert sheet, which loads when it is first
 * opened.
 *
 * A converted lead stays on the list as Qualified (D-L75): the row is replaced
 * by the contact convert answers with, so the next write carries its version.
 */

const ConvertSheet = dynamic(() => import('./convert-sheet').then((module) => module.ConvertSheet), { ssr: false });

/** Module-level, so the list's effect sees one stable function. */
function fetchLeads(q: string, view: LeadView, cursor?: string) {
  return listLeads(toLeadQuery(q, view, cursor));
}

/** The table's cells after the name, in P04/01's order (`LEAD_COLUMNS`). */
const TABLE_FIELDS: readonly Exclude<LeadColumnKey, 'displayName'>[] = ['companyName', 'phones', 'status', 'source', 'owner'];

/** What a 360 px card shows under the name: the company and the stage first. */
const CARD_FIELDS: readonly Exclude<LeadColumnKey, 'displayName'>[] = ['companyName', 'status', 'phones', 'source', 'owner'];

export function LeadsTable({
  t,
  locale,
  q,
  view,
  onState,
  onWithheld,
  onClear,
}: {
  t: Translator;
  locale: string;
  q: string;
  view: LeadView;
  onState: (state: ListState) => void;
  onWithheld: (fields: readonly string[]) => void;
  onClear: () => void;
}) {
  const list = useKeysetList(q, view, fetchLeads);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const searched = list.answered.q.trim() !== '' || activeLeadFilters(list.answered.view.filters).length > 0;
  const state = listState({ phase: list.phase, rowCount: list.rows.length, searching: searched });
  const offline = !list.online;
  const converting = convertingId === null ? null : (list.rows.find((row) => row.id === convertingId) ?? null);

  useEffect(() => onState(state), [state, onState]);
  useEffect(() => {
    onWithheld([...list.rows.flatMap((row) => row.withheldFields), ...withheldFromLeadError(list.error)]);
  }, [list.rows, list.error, onWithheld]);

  const startConvert = (row: Lead) => {
    if (offline) return;
    setAnnouncement('');
    setConvertingId(row.id);
  };

  const { mutate } = list;
  const converted = useCallback(
    (result: ConvertLeadResult) => {
      mutate((rows) => rows.map((row) => (row.id === result.contact.id ? result.contact : row)));
      setConvertingId(null);
      setAnnouncement(t.t('leads.convert.done', { name: result.contact.displayName, account: result.account.name }));
    },
    [mutate, t],
  );

  // A 409 means the row this screen holds is out of date: read it again, so
  // the next attempt carries the version the server has now (never a blind retry).
  const refresh = useCallback(
    (id: string) => {
      void getLead(id).then((fresh) => {
        if (fresh.ok) mutate((rows) => rows.map((row) => (row.id === id ? fresh.value : row)));
      });
    },
    [mutate],
  );

  return (
    <>
      {offline ? <OfflineBanner t={t} locale={locale} syncedAt={list.syncedAt} /> : null}
      <Body t={t} state={state} list={list} sort={view.sort} offline={offline} onClear={onClear} onConvert={startConvert} />
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {converting === null ? null : (
        <ConvertSheet
          t={t}
          lead={converting}
          online={!offline}
          onClose={() => setConvertingId(null)}
          onConverted={converted}
          onStale={refresh}
        />
      )}
    </>
  );
}

function describeFilters(t: Translator, filters: LeadFilterState): string {
  return activeLeadFilters(filters)
    .map((key) => {
      const spec = LEAD_FILTERS.find((filter) => filter.key === key);
      if (spec === undefined) return key;
      return `${t.t(spec.label)}: ${filters[key].map((value) => t.t(leadOptionLabel(key, value))).join(', ')}`;
    })
    .join('; ');
}

function Body({
  t,
  state,
  list,
  sort,
  offline,
  onClear,
  onConvert,
}: {
  t: Translator;
  state: ListState;
  list: KeysetList<Lead, LeadView>;
  sort: LeadView['sort'];
  offline: boolean;
  onClear: () => void;
  onConvert: (row: Lead) => void;
}) {
  if (state === 'loading') {
    return <ListLoading t={t} slow={list.slow} label="leads.loading" />;
  }

  if (state === 'error') {
    return (
      <ListError
        t={t}
        heading="leads.error.title"
        message={leadListError(list.error)}
        code={list.error?.code ?? 'network'}
        offline={offline}
        onRetry={list.reload}
      />
    );
  }

  if (state === 'empty') {
    return (
      <div data-testid="empty-state" className="flex flex-col items-center gap-4 rounded-lg border border-border bg-surface p-8 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-lg bg-primary-soft text-primary-text">
          <Icon name="person_add" size="xl" />
        </span>
        <h2 className="text-h3">{t.t('leads.empty.title')}</h2>
        <p className="max-w-xl text-body-md text-text-2">{t.t('leads.empty.body')}</p>
      </div>
    );
  }

  if (state === 'no-results') {
    const answered = list.answered;
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface p-10 text-center">
        <Icon name="search_off" size="xl" className="text-text-muted" />
        <h2 className="text-h3">{t.t('leads.noResults.title')}</h2>
        <p data-testid="no-results-message" className="max-w-xl text-body-md text-text-2">
          {answered.q.trim() === '' ? null : t.t('records.noResults.query', { query: answered.q.trim() })}{' '}
          {activeLeadFilters(answered.view.filters).length === 0
            ? null
            : t.t('records.noResults.filters', { filters: describeFilters(t, answered.view.filters) })}
        </p>
        <button type="button" data-action="clear-search-filters" onClick={onClear} className={SECONDARY_BUTTON}>
          {t.t('records.noResults.clear')}
        </button>
      </div>
    );
  }

  const rows = list.rows;
  const locked = lockedLeadColumns(rows);
  return (
    <div className="flex flex-col gap-3">
      {/* A scrolling region is a keyboard stop, or keyboard users cannot reach
          the columns past the edge (WCAG 2.1.1). */}
      <div
        role="region"
        aria-label={t.t('leads.title')}
        tabIndex={0}
        className={`relative hidden overflow-x-auto rounded-lg border border-border bg-surface md:block ${FOCUS}`}
      >
        <table className="w-full min-w-max border-collapse text-body-sm">
          <caption className="sr-only">{t.t('leads.title')}</caption>
          <thead className="bg-surface-sunken text-caption text-text-muted">
            <tr>
              {LEAD_COLUMNS.map((column) => (
                <th
                  key={column.key}
                  role="columnheader"
                  scope="col"
                  data-column={column.key}
                  aria-sort={column.key === 'displayName' ? nameAriaSort(sort) : undefined}
                  className="p-3 text-start font-bold"
                >
                  <span className="inline-flex items-center gap-1">
                    {t.t(column.label)}
                    {locked.includes(column.key) ? <HeaderLock t={t} /> : null}
                  </span>
                </th>
              ))}
              <th scope="col" className="p-3 text-start font-bold">
                <span className="sr-only">{t.t('accounts.col.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-row-id={row.id} className="border-t border-border align-top hover:bg-surface-sunken">
                <th scope="row" data-field="displayName" className="p-3 text-start font-normal">
                  <NameCell row={row} />
                </th>
                {TABLE_FIELDS.map((field) => (
                  <td key={field} {...fieldProps(row, field)} className="p-3">
                    <LeadValue t={t} row={row} field={field} />
                  </td>
                ))}
                <td className="p-2 text-end">
                  <ConvertAction t={t} row={row} offline={offline} onConvert={onConvert} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-2 md:hidden">
        {rows.map((row) => (
          <li key={row.id} data-row-id={row.id} className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-3">
            <div className="flex min-w-0 items-start gap-2">
              <div data-field="displayName" className="min-w-0 flex-1">
                <NameCell row={row} />
              </div>
              <ConvertAction t={t} row={row} offline={offline} onConvert={onConvert} />
            </div>
            <dl className="flex flex-col gap-1 text-body-sm">
              {CARD_FIELDS.map((field) => (
                <div key={field} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <dt className="text-caption font-semibold text-text-muted">{t.t(leadColumnLabel(field))}</dt>
                  <dd {...fieldProps(row, field)} className="min-w-0">
                    <LeadValue t={t} row={row} field={field} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

      {list.moreError === null ? null : (
        <p role="alert" className="text-body-sm text-danger-text">
          {t.t(leadListError(list.moreError))}
        </p>
      )}

      {list.nextCursor === null ? null : (
        <LoadMore t={t} loading={list.loadingMore} offline={offline} onLoadMore={list.loadMore} />
      )}
    </div>
  );
}

/** People get round avatars (P04/01); the initials are decoration. */
function NameCell({ row }: { row: Lead }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-caption font-bold text-primary-text"
      >
        {initials(row.displayName)}
      </span>
      <b data-record-text="" className="min-w-0 break-words text-body-sm">
        {row.displayName}
      </b>
    </span>
  );
}

/**
 * The row's convert action (D-L86). Shown to every caller — the API's 403 is
 * the gate (D-L84) — except where the row withholds `status` or `accountId`,
 * the two fields convert writes: there the row says so instead. A lead
 * already qualified and linked says it is converted.
 */
function ConvertAction({
  t,
  row,
  offline,
  onConvert,
}: {
  t: Translator;
  row: Lead;
  offline: boolean;
  onConvert: (row: Lead) => void;
}) {
  const offer = convertOffer(row);
  if (offer === 'locked') {
    return (
      <span className="inline-flex min-h-touch shrink-0 items-center gap-1 px-3 text-body-sm text-text-muted">
        <Icon name="lock" size="sm" />
        {t.t('leads.convert.locked')}
      </span>
    );
  }
  if (offer === 'converted') {
    return (
      <span className="inline-flex min-h-touch shrink-0 items-center gap-1 px-3 text-body-sm">
        <Icon name="check_circle" size="sm" className="text-success-text" />
        <Muted>{t.t('leads.convert.converted')}</Muted>
      </span>
    );
  }
  return (
    <button
      type="button"
      data-action="convert-lead"
      data-requires-connection=""
      aria-disabled={offline ? 'true' : undefined}
      onClick={() => onConvert(row)}
      className={`${QUIET_BUTTON} shrink-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-60`}
    >
      <Icon name="task_alt" size="sm" />
      {t.t('leads.action.convert')}
      <span data-record-text="" className="sr-only">
        {row.displayName}
      </span>
    </button>
  );
}
