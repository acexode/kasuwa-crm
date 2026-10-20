'use client';

import { clientLazy } from '../../lib/client-lazy';
import { useCallback, useEffect, useState } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { nameOrWithheld } from '../records/name';
import { FOCUS, TH } from '../records/list-classes';
import { ListError, ListLoading, Muted } from '../records/list-parts';
import { listState, type ListState } from '../records/list-model';
import { useKeysetList, type KeysetList } from '../records/use-keyset-list';
import {
  LastActivityEmpty,
  NameBlock,
  RecordAvatar,
  SELECT_TH,
  SelectAll,
  SelectRow,
  TABLE,
  HeaderLabel,
  cellClass,
  nameTd,
  nameTh,
  selectTd,
} from '../records/list-table';
import { PagingFooter, usePaging, type PageSize } from '../records/paging';
import { BULK_ASSIGN, BULK_UPDATE, BulkBar, useSelection } from '../records/bulk-bar';
import { CardName, RecordCard, SwipeHint, type CardAction } from '../records/record-card';
import { EmptyLanding, NoResults, STATE_PRIMARY, STATE_QUIET, STATE_SECONDARY, UnbuiltAction } from '../records/list-states';
import { getLead, listLeads, type ConvertLeadResult, type Lead } from '../../lib/leads-api';
import { isWithheld } from '../../lib/records-api';
import {
  LEAD_COLUMNS,
  LEAD_FILTERS,
  activeLeadFilters,
  convertOffer,
  leadListError,
  leadOptionLabel,
  lockedLeadColumns,
  toLeadQuery,
  withheldFromLeadError,
  type LeadColumnKey,
  type LeadFilterState,
  type LeadView,
} from './leads-model';
import { LeadValue, StatusPill, dndOf, fieldProps, leadSubLine, networkOf, ownerText } from './lead-parts';
import { PhoneValue } from '../records/list-table';

/**
 * `P04/01`'s body (T-0058, restyled to the export by T-0133): the leads table
 * at `md` and up — selection, a sticky name column, 52px rows, the paging
 * footer — a dense swipe card per lead at 360 px, and the five list states. It
 * owns its keyset read (`listLeads`, in memory only, D-L64) and the convert
 * sheet, which loads when it is first opened.
 *
 * A converted lead stays on the list as Qualified (D-L75): the row is replaced
 * by the contact convert answers with, so the next write carries its version.
 */

const ConvertSheet = clientLazy(() => import('./convert-sheet').then((module) => module.ConvertSheet));

/** Module-level, so the list's effect sees one stable function. */
function fetchLeads(q: string, view: LeadView, cursor?: string) {
  return listLeads(toLeadQuery(q, view, cursor));
}

/** What the screen around the table needs to know: the count chip, the offline banner. */
export interface LeadsMeta {
  readonly held: number;
  readonly more: boolean;
  readonly online: boolean;
  readonly syncedAt: Date | null;
  readonly reload: () => void;
  /** Columns withheld on a row held: the chooser carries a lock on them. */
  readonly locked: readonly LeadColumnKey[];
}

/** The P04 widths, by column: 260 / 260 / 60 / 230 / 190 / 170 / 140 / 230 / 170. */
const WIDTH: Readonly<Record<Exclude<LeadColumnKey, 'displayName'> | 'lastActivity', string>> = {
  phones: 'w-64',
  whatsappOptIn: 'w-16',
  emails: 'w-56',
  companyName: 'w-48',
  owner: 'w-44',
  lastActivity: 'w-36',
  tags: 'w-56',
  status: 'w-44',
  source: 'w-36',
};

export interface LeadsTableFlags {
  readonly bulk: boolean;
  readonly lastActivity: boolean;
  readonly quickActions: boolean;
}

export function LeadsTable({
  t,
  locale,
  q,
  view,
  hidden,
  flags,
  onState,
  onWithheld,
  onClear,
  onRemoveLast,
  onPageSize,
  onMeta,
}: {
  t: Translator;
  locale: string;
  q: string;
  view: LeadView;
  hidden: readonly LeadColumnKey[];
  flags: LeadsTableFlags;
  onState: (state: ListState) => void;
  onWithheld: (fields: readonly string[]) => void;
  onClear: () => void;
  onRemoveLast: (() => void) | null;
  onPageSize: (size: PageSize) => void;
  onMeta: (meta: LeadsMeta) => void;
}) {
  const list = useKeysetList(q, view, fetchLeads);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const searched =
    list.answered.q.trim() !== '' ||
    activeLeadFilters(list.answered.view.filters).length > 0 ||
    Object.keys(list.answered.view.custom ?? {}).length > 0;
  const state = listState({ phase: list.phase, rowCount: list.rows.length, searching: searched });
  const offline = !list.online;
  const converting = convertingId === null ? null : (list.rows.find((row) => row.id === convertingId) ?? null);

  useEffect(() => onState(state), [state, onState]);
  useEffect(() => {
    onWithheld([...list.rows.flatMap((row) => row.withheldFields), ...withheldFromLeadError(list.error)]);
  }, [list.rows, list.error, onWithheld]);
  const { reload } = list;
  useEffect(() => {
    onMeta({
      held: list.rows.length,
      more: list.nextCursor !== null,
      online: list.online,
      syncedAt: list.syncedAt,
      reload,
      locked: lockedLeadColumns(list.rows),
    });
  }, [list.rows, list.nextCursor, list.online, list.syncedAt, reload, onMeta]);

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
      setAnnouncement(t.t('leads.convert.done', { name: nameOrWithheld(t, result.contact.displayName), account: result.account.name }));
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
      <Body
        t={t}
        locale={locale}
        state={state}
        list={list}
        view={view}
        hidden={hidden}
        flags={flags}
        offline={offline}
        onClear={onClear}
        onRemoveLast={onRemoveLast}
        onConvert={startConvert}
        onPageSize={onPageSize}
      />
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
  locale,
  state,
  list,
  view,
  hidden,
  flags,
  offline,
  onClear,
  onRemoveLast,
  onConvert,
  onPageSize,
}: {
  t: Translator;
  locale: string;
  state: ListState;
  list: KeysetList<Lead, LeadView>;
  view: LeadView;
  hidden: readonly LeadColumnKey[];
  flags: LeadsTableFlags;
  offline: boolean;
  onClear: () => void;
  onRemoveLast: (() => void) | null;
  onConvert: (row: Lead) => void;
  onPageSize: (size: PageSize) => void;
}) {
  const size = (view.pageSize ?? 25) as PageSize;
  const paging = usePaging(list, size);
  const selection = useSelection(list.answered.q, list.answered.view);

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
    return <LeadsEmpty t={t} />;
  }

  if (state === 'no-results') {
    const answered = list.answered;
    return (
      <NoResults
        t={t}
        title={t.t('leads.noResults.title')}
        message={
          <>
            {answered.q.trim() === '' ? null : t.t('records.noResults.query', { query: answered.q.trim() })}{' '}
            {activeLeadFilters(answered.view.filters).length === 0
              ? null
              : t.t('records.noResults.filters', { filters: describeFilters(t, answered.view.filters) })}
          </>
        }
        onClear={onClear}
        onRemoveLast={onRemoveLast}
      />
    );
  }

  const rows = paging.rows;
  const locked = lockedLeadColumns(list.rows);
  const columns = LEAD_COLUMNS.filter((column) => column.key !== 'displayName' && !hidden.includes(column.key)).map(
    (column) => column.key as Exclude<LeadColumnKey, 'displayName'>,
  );
  const ownerAt = columns.indexOf('owner');
  const pageIds = rows.map((row) => row.id);
  const selectedOnPage = pageIds.filter((id) => selection.selected.has(id)).length;
  const bulk = flags.bulk;

  return (
    <div className="flex flex-col gap-2.5">
      {bulk ? (
        <BulkBar
          t={t}
          count={selection.selected.size}
          actions={[BULK_ASSIGN, BULK_UPDATE]}
          onSelectPage={() => selection.setAll(pageIds, true)}
          onClear={selection.clear}
        />
      ) : null}

      <div className="hidden md:block">
        {/* A scrolling region is a keyboard stop, or keyboard users cannot reach
            the columns past the edge (WCAG 2.1.1). */}
        <div
          role="region"
          aria-label={t.t('leads.title')}
          tabIndex={0}
          className={`relative overflow-x-auto rounded-t-lg border border-border bg-surface ${FOCUS}`}
        >
          <table className={TABLE}>
            <caption className="sr-only">{t.t('leads.title')}</caption>
            <colgroup>
              {bulk ? <col className="w-11" /> : null}
              <col className="w-64" />
              {columns.flatMap((key, index) => [
                <col key={key} className={WIDTH[key]} />,
                ...(flags.lastActivity && index === ownerAt ? [<col key="lastActivity" className={WIDTH.lastActivity} />] : []),
              ])}
              <col />
            </colgroup>
            <thead>
              <tr>
                {bulk ? (
                  <th scope="col" className={SELECT_TH}>
                    <SelectAll t={t} count={pageIds.length} selected={selectedOnPage} onChange={(all) => selection.setAll(pageIds, all)} />
                  </th>
                ) : null}
                <th role="columnheader" scope="col" data-column="displayName" className={nameTh(bulk)}>
                  <HeaderLabel t={t} label="records.col.lead" locked={locked.includes('displayName')} />
                </th>
                {columns.map((key, index) => (
                  <HeaderCells
                    key={key}
                    t={t}
                    column={key}
                    locked={locked.includes(key)}
                    lastActivity={flags.lastActivity && index === ownerAt}
                  />
                ))}
                <th scope="col" className={TH}>
                  <span className="sr-only">{t.t('accounts.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const selected = selection.selected.has(row.id);
                return (
                  <tr key={row.id} data-row-id={row.id} data-selected={selected ? 'true' : undefined} className="group">
                    {bulk ? (
                      <td className={selectTd(selected)}>
                        <SelectRow
                          t={t}
                          name={nameOrWithheld(t, row.displayName)}
                          checked={selected}
                          onChange={() => selection.toggle(row.id)}
                        />
                      </td>
                    ) : null}
                    <th scope="row" data-field="displayName" className={`${nameTd(selected, bulk)} text-start`}>
                      <NameBlock t={t} name={row.displayName} sub={leadSubLine(t, row)} />
                    </th>
                    {columns.map((field, index) => (
                      <BodyCells
                        key={field}
                        t={t}
                        row={row}
                        field={field}
                        selected={selected}
                        lastActivity={flags.lastActivity && index === ownerAt}
                      />
                    ))}
                    <td className={cellClass(selected, 'text-end')}>
                      <ConvertAction t={t} row={row} offline={offline} onConvert={onConvert} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <PagingFooter t={t} locale={locale} paging={paging} size={size} offline={offline} onSize={onPageSize} />
      </div>

      {flags.quickActions ? <SwipeHint t={t} label="records.card.hint" /> : null}
      <ul className="-mx-4 flex flex-col border-t border-border md:hidden">
        {rows.map((row) => (
          <LeadCard key={row.id} t={t} row={row} offline={offline} quickActions={flags.quickActions} onConvert={onConvert} />
        ))}
      </ul>
      <div className="md:hidden">
        <PagingFooter t={t} locale={locale} paging={paging} size={size} offline={offline} onSize={onPageSize} />
      </div>

      {list.moreError === null ? null : (
        <p role="alert" className="text-body-sm text-danger-text">
          {t.t(leadListError(list.moreError))}
        </p>
      )}
    </div>
  );
}

function HeaderCells({
  t,
  column,
  locked,
  lastActivity,
}: {
  t: Translator;
  column: Exclude<LeadColumnKey, 'displayName'>;
  locked: boolean;
  lastActivity: boolean;
}) {
  const spec = LEAD_COLUMNS.find((item) => item.key === column);
  return (
    <>
      <th
        role="columnheader"
        scope="col"
        data-column={column}
        aria-label={column === 'whatsappOptIn' ? t.t('records.col.whatsappOptIn') : undefined}
        className={`${TH} ${WIDTH[column]} ${column === 'whatsappOptIn' ? 'text-center' : ''}`}
      >
        {column === 'whatsappOptIn' ? (
          <span aria-hidden="true">{t.t('records.col.wa')}</span>
        ) : (
          <HeaderLabel t={t} label={spec?.label ?? 'records.col.displayName'} locked={locked} />
        )}
      </th>
      {lastActivity ? (
        <th scope="col" data-column-placeholder="lastActivity" className={`${TH} ${WIDTH.lastActivity}`}>
          {t.t('records.col.lastActivity')}
        </th>
      ) : null}
    </>
  );
}

function BodyCells({
  t,
  row,
  field,
  selected,
  lastActivity,
}: {
  t: Translator;
  row: Lead;
  field: Exclude<LeadColumnKey, 'displayName'>;
  selected: boolean;
  lastActivity: boolean;
}) {
  return (
    <>
      <td {...fieldProps(row, field)} className={cellClass(selected, `${WIDTH[field]} max-w-0 ${field === 'whatsappOptIn' ? 'text-center' : ''}`)}>
        <LeadValue t={t} row={row} field={field} />
      </td>
      {lastActivity ? (
        <td className={cellClass(selected, WIDTH.lastActivity)}>
          <LastActivityEmpty t={t} />
        </td>
      ) : null}
    </>
  );
}

/** The 360 px card: name and WA, phone and network, "Company · Owner", the status. */
function LeadCard({
  t,
  row,
  offline,
  quickActions,
  onConvert,
}: {
  t: Translator;
  row: Lead;
  offline: boolean;
  quickActions: boolean;
  onConvert: (row: Lead) => void;
}) {
  const name = nameOrWithheld(t, row.displayName);
  const phone = row.phones?.[0];
  const offer = convertOffer(row);
  const actions: CardAction[] = [
    ...(quickActions
      ? ([
          { key: 'call', icon: 'call', label: 'records.card.call', onClick: null, tone: 'primary' },
          { key: 'whatsapp', icon: 'chat', label: row.whatsappOptIn === true ? 'records.card.whatsapp' : 'records.card.noOptIn', onClick: null, tone: 'success' },
          { key: 'sms', icon: 'sms', label: 'records.card.sms', onClick: null, tone: 'info' },
        ] as const)
      : []),
    ...(offer === 'offer'
      ? [
          {
            key: 'convert',
            icon: 'task_alt',
            label: 'leads.action.convert',
            onClick: () => onConvert(row),
            tone: 'soft',
            ariaDisabled: offline,
            attributes: { 'data-action': 'convert-lead', 'data-requires-connection': '' },
          } as const,
        ]
      : []),
  ];
  const meta = [
    !isWithheld(row, 'companyName') && typeof row.companyName === 'string' ? row.companyName : null,
    ownerText(t, row),
  ].filter((part): part is string => part !== null && part !== '');
  return (
    <RecordCard t={t} rowId={row.id} name={name} actions={actions} avatar={<RecordAvatar name={row.displayName} size={44} />}>
      <CardName t={t} name={name} withheld={row.displayName === undefined} whatsapp={row.whatsappOptIn === true && !isWithheld(row, 'whatsappOptIn')} />
      <span {...fieldProps(row, 'phones')}>
        {isWithheld(row, 'phones') ? (
          <LeadValue t={t} row={row} field="phones" />
        ) : phone === undefined ? null : (
          <PhoneValue t={t} e164={phone.e164} network={networkOf(row)} dnd={dndOf(row)} more={0} compact />
        )}
      </span>
      {meta.length === 0 ? null : (
        <span data-record-text="" className="truncate text-caption text-text-2">
          {meta.join(' · ')}
        </span>
      )}
      <span className="mt-0.75 flex items-center gap-1.5">
        <span {...fieldProps(row, 'status')}>
          {isWithheld(row, 'status') ? (
            <LeadValue t={t} row={row} field="status" />
          ) : typeof row.status === 'string' ? (
            <StatusPill t={t} status={row.status} small />
          ) : null}
        </span>
        {offer === 'converted' ? (
          <span className="inline-flex items-center gap-1 text-caption">
            <Icon name="check_circle" size={16} className="text-success-text" />
            <Muted>{t.t('leads.convert.converted')}</Muted>
          </span>
        ) : null}
      </span>
    </RecordCard>
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
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-meta text-text-muted">
        <Icon name="lock" size={16} />
        {t.t('leads.convert.locked')}
      </span>
    );
  }
  if (offer === 'converted') {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-meta">
        <Icon name="check_circle" size={16} className="text-success-text" />
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
      className={`inline-flex h-control-sm items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-meta font-semibold text-primary-text hover:bg-primary-soft aria-disabled:cursor-not-allowed aria-disabled:text-disabled-text ${FOCUS}`}
    >
      <Icon name="task_alt" size={18} />
      {t.t('leads.action.convert')}
      <span data-record-text="" className="sr-only">
        {nameOrWithheld(t, row.displayName)}
      </span>
    </button>
  );
}

/** P04/05 "No leads yet": import and capture, both not built here, in the design's disabled state. */
function LeadsEmpty({ t }: { t: Translator }) {
  return (
    <EmptyLanding
      icon="person_add"
      title={t.t('leads.empty.title')}
      body={t.t('leads.empty.body')}
      cards={[
        {
          icon: 'upload_file',
          tone: 'sunken',
          title: t.t('leads.empty.import.title'),
          body: t.t('leads.empty.import.body'),
          actions: (
            <>
              <UnbuiltAction t={t} action="import-csv-empty" icon="upload" label="records.empty.import.action" className={STATE_PRIMARY} />
              <UnbuiltAction t={t} action="import-zoho" label="records.empty.import.zoho" className={STATE_SECONDARY} />
              <UnbuiltAction t={t} action="import-salesforce" label="records.empty.import.salesforce" className={STATE_SECONDARY} />
            </>
          ),
        },
        {
          icon: 'chat',
          tone: 'success',
          title: t.t('leads.empty.capture.title'),
          body: t.t('leads.empty.capture.body'),
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
          <UnbuiltAction t={t} action="capture-whatsapp-phone" icon="chat" label="leads.empty.capture.title" className={`${STATE_PRIMARY} h-control-lg w-full`} />
          <UnbuiltAction t={t} action="import-phone" icon="upload_file" label="records.empty.import.phone" className={`${STATE_SECONDARY} h-control-lg w-full`} />
        </>
      }
      phoneNote={t.t('records.empty.phoneNote')}
    />
  );
}
