'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { createBundleTranslator, type MessageBundle, type Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { PRIMARY_BUTTON, QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { CHIP, CHIP_OFF, CHIP_ON, FOCUS, MENU_ROW, POPOVER } from '../records/list-classes';
import {
  CheckMark,
  ColumnChooser,
  FilterOptions,
  HeaderLock,
  ListError,
  ListLoading,
  LoadMore,
  LockedValue,
  Muted,
  OfflineBanner,
} from '../records/list-parts';
import { formatPhone, initials, listState } from '../records/list-model';
import { useKeysetList, type KeysetList } from '../records/use-keyset-list';
import { listAccounts, listMyProgrammes, type Account, type MyProgramme } from '../../lib/accounts-api';
import {
  ACCOUNT_COLUMNS,
  ACCOUNT_FILTERS,
  ACCOUNT_SORTS,
  DEFAULT_ACCOUNT_VIEW,
  NO_ACCOUNT_FILTERS,
  accountOptionLabel,
  activeAccountFilters,
  addFreeValue,
  cardShows,
  cellWithheld,
  defaultHiddenAccountColumns,
  listErrorMessage,
  lockedAccountColumns,
  lockedAccountFilters,
  nameAriaSort,
  programmeName,
  sortLabel,
  tierLabel,
  toAccountQuery,
  toggleAccountColumn,
  toggleAccountFilter,
  withheldFromError,
  type AccountColumnKey,
  type AccountFilter,
  type AccountFilterState,
  type AccountView,
} from './accounts-model';
import { AccountSheet, type SheetMode } from './account-sheet';

/**
 * `P04/03` — the Accounts list — with `P04/05` (empty, no results) and `P04/06`
 * (loading, offline), behind the accounts flag, which only the server page reads
 * (T-0057). Built in the CRM shell and on the list pieces T-0042's Contacts
 * screen shares (`components/records/`).
 *
 * ---------------------------------------------------------------------------
 * WRITE CONTROLS SHOW TO EVERY CALLER, AND THE API'S 403 IS THE GATE (D-L84).
 * Nothing in the contract tells the screen whether the caller holds
 * `account.write` (no capability read until T-0079). A refused write is said
 * plainly, in translated copy, inside the sheet, which keeps what was typed.
 *
 * A LOCK IS NOT AN EMPTY CELL, AND AN EMPTY CELL IS NOT A LOCK. Field security
 * omits a property and names it in `withheldFields`; `null` means no value.
 * Locks are decided PER ROW: two rows on one page can be two programmes.
 *
 * NO ROW LINKS ANYWHERE YET (D-L84): the account record page is T-0063, and a
 * link to a 404 is worse than no link.
 *
 * NO TOTALS (D-P13), NO MAP, HEALTH, BULK ACTIONS OR ROLLUPS (D-L69), NO
 * OFFLINE EDITS (D-P21), NOTHING ON THE DEVICE (D-L64).
 * ---------------------------------------------------------------------------
 */

type Popover = `filter:${AccountFilter['key']}` | 'columns' | 'sort' | null;

const TIER_TONE: Readonly<Record<string, string>> = {
  enterprise: 'bg-primary-soft text-primary-text',
  mid_market: 'bg-info-soft text-info-text',
  sme: 'bg-surface-sunken text-text-2',
};

/** Module-level, so the list's effect sees one stable function. */
function fetchAccounts(q: string, view: AccountView, cursor?: string) {
  return listAccounts(toAccountQuery(q, view, cursor));
}

interface Programmes {
  /** `null` until read, or when the read failed: the sheet then lets the server decide. */
  readonly list: readonly MyProgramme[] | null;
  readonly phase: 'loading' | 'loaded' | 'error';
}

/** The caller's programmes with their names (T-0043), read once: create picks one, the programme column prints one. */
function useMyProgrammes(): Programmes {
  const [state, setState] = useState<Programmes>({ list: null, phase: 'loading' });
  useEffect(() => {
    let live = true;
    void listMyProgrammes().then((result) => {
      if (!live) return;
      setState(result.ok ? { list: result.value, phase: 'loaded' } : { list: null, phase: 'error' });
    });
    return () => {
      live = false;
    };
  }, []);
  return state;
}

export function AccountsScreen({
  locale,
  messages,
  locales,
  live,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  /** Nav ids whose route is on here (`crmLiveNav()`), for the shell's links. */
  live: readonly string[];
}) {
  const t = createBundleTranslator(locale, messages);
  const [q, setQ] = useState('');
  const [view, setView] = useState<AccountView>(DEFAULT_ACCOUNT_VIEW);
  const [hidden, setHidden] = useState<readonly AccountColumnKey[]>(defaultHiddenAccountColumns);
  const [popover, setPopover] = useState<Popover>(null);
  const [sheet, setSheet] = useState<SheetMode | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [withheldSeen, setWithheldSeen] = useState<ReadonlySet<string>>(() => new Set());
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const searchId = useId();
  const list = useKeysetList(q, view, fetchAccounts);
  const programmes = useMyProgrammes();

  // A filter on a field withheld from the caller is `400 field_withheld`. Every
  // withheld field seen this session — on a row, or named by a refusal — locks
  // its chip, so the next person is told before they try.
  useEffect(() => {
    const seen = [...list.rows.flatMap((row) => row.withheldFields), ...withheldFromError(list.error)];
    setWithheldSeen((current) => (seen.every((field) => current.has(field)) ? current : new Set([...current, ...seen])));
  }, [list.rows, list.error]);

  const searched = list.answered.q.trim() !== '' || activeAccountFilters(list.answered.view.filters).length > 0;
  const state = listState({ phase: list.phase, rowCount: list.rows.length, searching: searched });
  const lockedColumns = lockedAccountColumns(list.rows);
  const lockedFilters = lockedAccountFilters(withheldSeen);
  const columns = ACCOUNT_COLUMNS.filter((column) => !hidden.includes(column.key)).map((column) => column.key);
  const offline = !list.online;

  const open = (next: Exclude<Popover, null>, trigger: HTMLElement) => {
    triggerRef.current = trigger;
    setPopover((current) => (current === next ? null : next));
  };
  const close = useCallback((returnFocus: boolean) => {
    setPopover(null);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Escape closes whatever is open and gives focus back to what opened it; a
  // press outside closes it too.
  useEffect(() => {
    if (popover === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true);
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (popoverRef.current !== null && target !== null && !popoverRef.current.contains(target)) {
        setPopover(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [popover, close]);

  const setFilters = (change: (filters: AccountFilterState) => AccountFilterState) =>
    setView((current) => ({ ...current, filters: change(current.filters) }));

  const clearAll = () => {
    setQ('');
    setView((current) => ({ ...current, filters: NO_ACCOUNT_FILTERS }));
  };

  const startCreate = () => {
    if (offline) return;
    setAnnouncement('');
    setSheet({ kind: 'create' });
  };
  const startEdit = (row: Account) => {
    if (offline) return;
    setAnnouncement('');
    setSheet({ kind: 'edit', row });
  };

  const saved = (row: Account) => {
    const created = sheet?.kind === 'create';
    list.mutate((rows) =>
      created ? [row, ...rows.filter((held) => held.id !== row.id)] : rows.map((held) => (held.id === row.id ? row : held)),
    );
    setSheet(null);
    setAnnouncement(t.t('accounts.sheet.saved', { name: row.name }));
  };

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="accounts" live={live}>
      <div data-screen="P04/03" data-list-state={state} className="flex min-w-0 flex-col gap-4">
        {offline ? <OfflineBanner t={t} locale={locale} syncedAt={list.syncedAt} /> : null}

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-h2">{t.t('accounts.title')}</h1>
            <span className="inline-flex min-w-0 items-center gap-2 rounded-full border border-accent bg-accent-soft px-3 py-1 text-body-sm font-semibold text-accent-text">
              <Icon name="lock" size="sm" />
              {t.t('records.programme.chip')}
            </span>
            <span className="flex-1" />
            <CreateButton t={t} offline={offline} onCreate={startCreate} />
          </div>
          <p className="text-body-sm text-text-2">{t.t('accounts.programme.note')}</p>
        </div>

        <div role="search" className="flex min-w-0 flex-wrap items-center gap-2">
          <label
            htmlFor={searchId}
            className="flex min-h-touch min-w-0 flex-1 basis-full items-center gap-2 rounded-md border border-border-strong bg-surface px-3 md:max-w-sm md:basis-auto"
          >
            <Icon name="search" size="sm" className="text-text-muted" />
            <input
              id={searchId}
              type="search"
              value={q}
              maxLength={100}
              autoComplete="off"
              aria-label={t.t('accounts.search.label')}
              placeholder={t.t('accounts.search.placeholder')}
              onChange={(event) => setQ(event.target.value)}
              className={`min-h-touch min-w-0 flex-1 bg-transparent text-body-md text-text placeholder:text-text-muted ${FOCUS}`}
            />
          </label>

          <div role="group" aria-label={t.t('records.filter.label')} className="flex flex-wrap items-center gap-2">
            {ACCOUNT_FILTERS.map((spec) => (
              <FilterChip
                key={spec.key}
                t={t}
                spec={spec}
                filters={view.filters}
                locked={lockedFilters.includes(spec.key)}
                open={popover === `filter:${spec.key}`}
                popoverRef={popoverRef}
                onOpen={(trigger) => open(`filter:${spec.key}`, trigger)}
                onDone={() => close(true)}
                onChange={setFilters}
              />
            ))}
            {activeAccountFilters(view.filters).length > 0 ? (
              <button type="button" onClick={() => setFilters(() => NO_ACCOUNT_FILTERS)} className={QUIET_BUTTON}>
                {t.t('records.filter.clearAll')}
              </button>
            ) : null}
          </div>

          <span className="hidden flex-1 md:block" />

          <div className="relative" ref={popover === 'sort' ? popoverRef : undefined}>
            <button
              type="button"
              data-testid="sort-control"
              aria-haspopup="true"
              aria-expanded={popover === 'sort'}
              onClick={(event) => open('sort', event.currentTarget)}
              className={SECONDARY_BUTTON}
            >
              <Icon name="unfold_more" size="sm" />
              {t.t('accounts.sort.current', { sort: t.t(sortLabel(view.sort)) })}
            </button>
            {popover === 'sort' ? (
              <div role="group" aria-label={t.t('accounts.sort.label')} className={`absolute end-0 top-full mt-1 w-64 ${POPOVER}`}>
                {ACCOUNT_SORTS.map((sort) => (
                  <button
                    key={sort}
                    type="button"
                    data-sort-option={sort}
                    aria-pressed={view.sort === sort}
                    onClick={() => {
                      setView((current) => ({ ...current, sort }));
                      close(true);
                    }}
                    className={`${MENU_ROW} ${view.sort === sort ? 'font-semibold text-primary-text' : 'text-text'}`}
                  >
                    <CheckMark on={view.sort === sort} />
                    {t.t(sortLabel(sort))}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="relative hidden md:block" ref={popover === 'columns' ? popoverRef : undefined}>
            <button
              type="button"
              data-testid="column-chooser"
              aria-haspopup="true"
              aria-expanded={popover === 'columns'}
              onClick={(event) => open('columns', event.currentTarget)}
              className={SECONDARY_BUTTON}
            >
              <Icon name="visibility" size="sm" />
              {t.t('records.columns.button')}
            </button>
            {popover === 'columns' ? (
              <ColumnChooser
                t={t}
                columns={ACCOUNT_COLUMNS}
                hidden={hidden}
                locked={lockedColumns}
                onToggle={(key) => setHidden((current) => toggleAccountColumn(current, key))}
              />
            ) : null}
          </div>
        </div>

        <Body
          t={t}
          state={state}
          list={list}
          columns={columns}
          lockedColumns={lockedColumns}
          sort={view.sort}
          programmes={programmes.list}
          offline={offline}
          onClear={clearAll}
          onCreate={startCreate}
          onEdit={startEdit}
        />

        <p role="status" className="sr-only">
          {announcement}
        </p>
      </div>

      {sheet === null ? null : (
        <AccountSheet
          t={t}
          mode={sheet}
          programmes={programmes}
          online={!offline}
          onClose={() => setSheet(null)}
          onSaved={saved}
        />
      )}
    </CrmShell>
  );
}

function CreateButton({ t, offline, onCreate }: { t: Translator; offline: boolean; onCreate: () => void }) {
  return (
    <button
      type="button"
      data-action="create-account"
      data-requires-connection=""
      aria-disabled={offline ? 'true' : undefined}
      onClick={onCreate}
      className={`${PRIMARY_BUTTON} aria-disabled:cursor-not-allowed aria-disabled:opacity-60`}
    >
      <Icon name="add" size="sm" />
      {t.t('accounts.action.new')}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function chipText(t: Translator, spec: AccountFilter, values: readonly string[]): string {
  if (values.length === 0) return t.t(spec.label);
  return t.t('records.filter.active', {
    filter: t.t(spec.label),
    values: values.map((value) => valueLabel(t, spec, value)).join(', '),
  });
}

/** A listed option's label, or a free value as it was typed. */
function valueLabel(t: Translator, spec: AccountFilter, value: string): string {
  const id = accountOptionLabel(spec.key, value);
  return id === null ? value : t.t(id);
}

function FilterChip({
  t,
  spec,
  filters,
  locked,
  open,
  popoverRef,
  onOpen,
  onDone,
  onChange,
}: {
  t: Translator;
  spec: AccountFilter;
  filters: AccountFilterState;
  locked: boolean;
  open: boolean;
  popoverRef: RefObject<HTMLDivElement | null>;
  onOpen: (trigger: HTMLElement) => void;
  onDone: () => void;
  onChange: (change: (filters: AccountFilterState) => AccountFilterState) => void;
}) {
  const values = filters[spec.key];

  // Withheld from this role: the server would refuse the filter (400
  // field_withheld), so the chip says so and offers nothing. A filter already
  // chosen stays clearable.
  if (locked && values.length === 0) {
    return (
      <button
        type="button"
        data-filter={spec.key}
        data-locked="true"
        aria-disabled="true"
        className={`${CHIP} ${CHIP_OFF} cursor-not-allowed text-text-muted`}
      >
        {t.t(spec.label)}
        <Icon name="lock" size="sm" />
        <span className="sr-only">{t.t('accounts.filter.locked')}</span>
      </button>
    );
  }

  return (
    <div className="relative" ref={open ? popoverRef : undefined}>
      <button
        type="button"
        data-filter={spec.key}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={(event) => onOpen(event.currentTarget)}
        className={`${CHIP} ${values.length > 0 ? CHIP_ON : CHIP_OFF}`}
      >
        {chipText(t, spec, values)}
        <Icon name="expand_more" size="sm" />
      </button>
      {open ? (
        // At 360 px the menu is a panel across the screen, not a dropdown that
        // pushes the page sideways.
        <div
          className={`fixed inset-x-4 bottom-20 md:absolute md:inset-x-auto md:bottom-auto md:start-0 md:top-full md:mt-1 md:w-64 ${POPOVER}`}
        >
          {spec.options.length > 0 ? (
            <FilterOptions
              menu={spec.key}
              label={t.t(spec.label)}
              options={spec.options.map((value) => ({ value, label: valueLabel(t, spec, value) }))}
              selected={values}
              onToggle={(value) => onChange((current) => toggleAccountFilter(current, spec.key, value))}
            />
          ) : (
            <FreeValues t={t} spec={spec} values={values} onChange={onChange} />
          )}
          <div className="mt-2 flex justify-end gap-2 border-t border-border pt-2">
            <button
              type="button"
              onClick={() => onChange((current) => ({ ...current, [spec.key]: [] }))}
              className={QUIET_BUTTON}
            >
              {t.t('records.filter.clear')}
            </button>
            <button type="button" data-testid="filter-apply" onClick={onDone} className={SECONDARY_BUTTON}>
              {t.t('records.filter.done')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A free-valued filter (industry, tag, State, LGA): type a value, Enter adds it. Matched exactly by the server. */
function FreeValues({
  t,
  spec,
  values,
  onChange,
}: {
  t: Translator;
  spec: AccountFilter;
  values: readonly string[];
  onChange: (change: (filters: AccountFilterState) => AccountFilterState) => void;
}) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onChange((current) => addFreeValue(current, spec.key, typed));
    setTyped('');
  };
  return (
    <div data-filter-menu={spec.key} role="group" aria-label={t.t(spec.label)} className="flex flex-col gap-2">
      {values.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1">
          {values.map((value) => (
            <li key={value}>
              <button
                type="button"
                aria-label={t.t('accounts.filter.remove', { value })}
                onClick={() =>
                  onChange((current) => ({ ...current, [spec.key]: current[spec.key].filter((item) => item !== value) }))
                }
                className={`${CHIP} ${CHIP_ON}`}
              >
                <span data-record-text="">{value}</span>
                <Icon name="close" size="sm" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-caption font-bold text-text-muted">
          {t.t('accounts.filter.input')}
        </label>
        <div className="flex gap-2">
          <input
            id={inputId}
            type="text"
            value={typed}
            maxLength={64}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
            className={`min-h-touch min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-3 text-body-md text-text ${FOCUS}`}
          />
          <button type="submit" className={SECONDARY_BUTTON}>
            {t.t('accounts.filter.add')}
          </button>
        </div>
      </form>
    </div>
  );
}

function describeFilters(t: Translator, filters: AccountFilterState): string {
  return activeAccountFilters(filters)
    .map((key) => {
      const spec = ACCOUNT_FILTERS.find((filter) => filter.key === key);
      if (spec === undefined) return key;
      return `${t.t(spec.label)}: ${filters[key].map((value) => valueLabel(t, spec, value)).join(', ')}`;
    })
    .join('; ');
}

// ---------------------------------------------------------------------------
// The body: one of five states
// ---------------------------------------------------------------------------

function Body({
  t,
  state,
  list,
  columns,
  lockedColumns,
  sort,
  programmes,
  offline,
  onClear,
  onCreate,
  onEdit,
}: {
  t: Translator;
  state: ReturnType<typeof listState>;
  list: KeysetList<Account, AccountView>;
  columns: readonly AccountColumnKey[];
  lockedColumns: readonly AccountColumnKey[];
  sort: AccountView['sort'];
  programmes: readonly MyProgramme[] | null;
  offline: boolean;
  onClear: () => void;
  onCreate: () => void;
  onEdit: (row: Account) => void;
}) {
  if (state === 'loading') {
    return <ListLoading t={t} slow={list.slow} label="accounts.loading" />;
  }

  if (state === 'error') {
    return (
      <ListError
        t={t}
        heading="accounts.error.title"
        message={listErrorMessage(list.error)}
        code={list.error?.code ?? 'network'}
        offline={offline}
        onRetry={list.reload}
      />
    );
  }

  if (state === 'empty') {
    return (
      <div className="flex flex-col items-center gap-4 rounded-lg border border-border bg-surface p-8 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-lg bg-primary-soft text-primary-text">
          <Icon name="domain" size="xl" />
        </span>
        <h2 className="text-h3">{t.t('accounts.empty.title')}</h2>
        <p className="max-w-xl text-body-md text-text-2">{t.t('accounts.empty.body')}</p>
        <CreateButton t={t} offline={offline} onCreate={onCreate} />
      </div>
    );
  }

  if (state === 'no-results') {
    const answered = list.answered;
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface p-10 text-center">
        <Icon name="search_off" size="xl" className="text-text-muted" />
        <h2 className="text-h3">{t.t('accounts.noResults.title')}</h2>
        <p data-testid="no-results-message" className="max-w-xl text-body-md text-text-2">
          {answered.q.trim() === '' ? null : t.t('records.noResults.query', { query: answered.q.trim() })}{' '}
          {activeAccountFilters(answered.view.filters).length === 0
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
  return (
    <div className="flex flex-col gap-3">
      {/* A scrolling region is a keyboard stop, or keyboard users cannot reach
          the columns past the edge (WCAG 2.1.1). */}
      <div
        role="region"
        aria-label={t.t('accounts.title')}
        tabIndex={0}
        className={`hidden overflow-x-auto rounded-lg border border-border bg-surface md:block ${FOCUS}`}
      >
        <table className="w-full min-w-max border-collapse text-body-sm">
          <caption className="sr-only">{t.t('accounts.title')}</caption>
          <thead className="bg-surface-sunken text-caption text-text-muted">
            <tr>
              {columns.map((key) => {
                const column = ACCOUNT_COLUMNS.find((spec) => spec.key === key);
                return (
                  <th
                    key={key}
                    role="columnheader"
                    scope="col"
                    data-column={key}
                    aria-sort={key === 'name' ? nameAriaSort(sort) : undefined}
                    className="p-3 text-start font-bold"
                  >
                    <span className="inline-flex items-center gap-1">
                      {column === undefined ? null : t.t(column.label)}
                      {lockedColumns.includes(key) ? <HeaderLock t={t} /> : null}
                    </span>
                  </th>
                );
              })}
              <th scope="col" className="p-3 text-start font-bold">
                <span className="sr-only">{t.t('accounts.col.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-row-id={row.id} className="border-t border-border align-top hover:bg-surface-sunken">
                {columns.map((key) =>
                  key === 'name' ? (
                    <th key={key} scope="row" data-field="name" className="p-3 text-start font-normal">
                      <NameCell row={row} />
                    </th>
                  ) : (
                    <Cell key={key} t={t} row={row} field={key} programmes={programmes} as="td" />
                  ),
                )}
                <td className="p-2 text-end">
                  <EditButton t={t} row={row} offline={offline} onEdit={onEdit} />
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
              <div data-field="name" className="min-w-0 flex-1">
                <NameCell row={row} />
              </div>
              <EditButton t={t} row={row} offline={offline} onEdit={onEdit} />
            </div>
            {/* A card names what each value is, and leaves out what nobody filled
                in: a column of bare "Not set"s says nothing at 360 px. A lock is
                always shown — it says the value exists. */}
            <dl className="flex flex-col gap-1 text-body-sm">
              {CARD_FIELDS.filter((field) => columns.includes(field) && cardShows(row, field)).map((field) => (
                <CardField key={field} t={t} row={row} field={field} programmes={programmes} />
              ))}
            </dl>
          </li>
        ))}
      </ul>

      {list.moreError === null ? null : (
        <p role="alert" className="text-body-sm text-danger-text">
          {t.t(listErrorMessage(list.moreError))}
        </p>
      )}

      {list.nextCursor === null ? null : (
        <LoadMore t={t} loading={list.loadingMore} offline={offline} onLoadMore={list.loadMore} />
      )}
    </div>
  );
}

function EditButton({
  t,
  row,
  offline,
  onEdit,
}: {
  t: Translator;
  row: Account;
  offline: boolean;
  onEdit: (row: Account) => void;
}) {
  return (
    <button
      type="button"
      data-action="edit-account"
      data-requires-connection=""
      aria-disabled={offline ? 'true' : undefined}
      onClick={() => onEdit(row)}
      className={`${QUIET_BUTTON} shrink-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-60`}
    >
      <Icon name="edit" size="sm" />
      {t.t('accounts.action.edit')}
      <span data-record-text="" className="sr-only">
        {row.name}
      </span>
    </button>
  );
}

/** What a 360 px card shows under the name, in P04/03's card order. */
const CARD_FIELDS: readonly Exclude<AccountColumnKey, 'name'>[] = [
  'tier',
  'industry',
  'phones',
  'owner',
  'tags',
  'state',
  'programmeId',
];

function CardField({
  t,
  row,
  field,
  programmes,
}: {
  t: Translator;
  row: Account;
  field: Exclude<AccountColumnKey, 'name'>;
  programmes: readonly MyProgramme[] | null;
}) {
  const column = ACCOUNT_COLUMNS.find((spec) => spec.key === field);
  const locked = cellWithheld(row, field);
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <dt className="text-caption font-semibold text-text-muted">{column === undefined ? null : t.t(column.label)}</dt>
      <dd data-field={field} data-locked={locked ? 'true' : undefined} className={`min-w-0 ${locked ? 'text-text-muted' : ''}`}>
        {locked ? <LockedValue t={t} /> : <Value t={t} row={row} field={field} programmes={programmes} />}
      </dd>
    </div>
  );
}

/** Businesses get square avatars (P04/03); people get round ones. */
function NameCell({ row }: { row: Account }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-soft text-caption font-bold text-primary-text"
      >
        {initials(row.name)}
      </span>
      <b data-record-text="" className="min-w-0 break-words text-body-sm">
        {row.name}
      </b>
    </span>
  );
}

/** One cell: a lock when the row withholds the field, the value otherwise. */
function Cell({
  t,
  row,
  field,
  programmes,
  as,
}: {
  t: Translator;
  row: Account;
  field: Exclude<AccountColumnKey, 'name'>;
  programmes: readonly MyProgramme[] | null;
  as: 'td' | 'div';
}) {
  const Tag = as;
  const padding = as === 'td' ? 'p-3' : '';
  if (cellWithheld(row, field)) {
    return (
      <Tag data-field={field} data-locked="true" className={`${padding} text-text-muted`}>
        <LockedValue t={t} />
      </Tag>
    );
  }
  return (
    <Tag data-field={field} className={padding}>
      <Value t={t} row={row} field={field} programmes={programmes} />
    </Tag>
  );
}

function Value({
  t,
  row,
  field,
  programmes,
}: {
  t: Translator;
  row: Account;
  field: Exclude<AccountColumnKey, 'name'>;
  programmes: readonly MyProgramme[] | null;
}) {
  const notSet = <Muted>{t.t('records.cell.empty')}</Muted>;
  switch (field) {
    case 'industry':
      return row.industry === null || row.industry === undefined ? notSet : <span data-record-text="">{row.industry}</span>;
    case 'tier':
      return row.tier === null || row.tier === undefined ? (
        notSet
      ) : (
        <span className={`inline-flex rounded-full px-2 text-caption font-bold ${TIER_TONE[row.tier] ?? ''}`}>
          {t.t(tierLabel(row.tier))}
        </span>
      );
    case 'phones': {
      const phones = row.phones ?? [];
      const first = phones[0];
      if (first === undefined) return notSet;
      // No DND marker: the contract has no DND flag for an account's numbers,
      // and a screen must not infer one.
      return (
        <span className="flex flex-wrap items-center gap-2">
          <span data-record-text="" className="whitespace-nowrap tabular-nums">
            {formatPhone(first.e164)}
          </span>
          {phones.length > 1 ? <Muted>{t.t('records.more', { count: phones.length - 1 })}</Muted> : null}
        </span>
      );
    }
    case 'owner':
      return row.owner === null || row.owner === undefined ? (
        <Muted>{t.t('records.owner.unassigned')}</Muted>
      ) : (
        <span data-record-text="">{row.owner.displayName}</span>
      );
    case 'tags': {
      const tags = row.tags ?? [];
      if (tags.length === 0) return notSet;
      return (
        <span className="flex flex-wrap items-center gap-1">
          {tags.slice(0, 2).map((tag) => (
            <span key={tag} data-record-text="" className="rounded-full bg-surface-sunken px-2 text-caption font-semibold text-text-2">
              {tag}
            </span>
          ))}
          {tags.length > 2 ? <Muted>{t.t('records.more', { count: tags.length - 2 })}</Muted> : null}
        </span>
      );
    }
    case 'state':
      return row.state === null || row.state === undefined ? (
        notSet
      ) : (
        <span className="flex flex-wrap gap-1">
          <span data-record-text="">{row.state}</span>
          {row.lga === null || row.lga === undefined ? null : (
            <span data-record-text="" className="text-text-muted">
              {row.lga}
            </span>
          )}
        </span>
      );
    case 'programmeId': {
      const name = programmeName(programmes, row.programmeId);
      return name === null ? <Muted>{t.t('accounts.programme.unknown')}</Muted> : <span data-record-text="">{name}</span>;
    }
  }
}

