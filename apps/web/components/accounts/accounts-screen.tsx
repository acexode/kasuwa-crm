'use client';

import { clientLazy } from '../../lib/client-lazy';
import { guarded } from '../custom/lazy-boundary';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { createBundleTranslator, type MessageBundle, type Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import { CrmFab, CrmShell } from '../crm/crm-shell';
import { dropQueryFromAddressBar, listQ, numberTyped } from '../../lib/search-query';
import type { LanguageOption } from '../auth/language-menu';
import { QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { ColumnChooser } from '../records/column-chooser';
import { CHIP_ON, FOCUS, MENU_ROW, OPTION_CHIP, POPOVER, TH, TOOL_BUTTON } from '../records/list-classes';
import { CheckMark, FilterOptions, ListError, ListLoading, LockedValue, Muted, NumberSearchHint, OfflineBanner } from '../records/list-parts';
import { listState } from '../records/list-model';
import { filterableFields, NO_CUSTOM_FILTERS, listRefusalId, setCustomFilter } from '../../lib/custom-values-filters';
import { LazyCustomFilterBar } from '../custom/lazy-filters';
import { useCustomDefinitions } from '../custom/use-custom-fields';
import { useKeysetList, type KeysetList } from '../records/use-keyset-list';
import { isAccountWithheld, listAccounts, type Account, type MyProgramme } from '../../lib/accounts-api';
import { ListHeader, NewButton, PhoneBarActions, ViewSwitcher, heldCount, phoneSubtitle, type MenuItem } from '../records/list-chrome';
import { ActiveFilterChips, ColumnsButton, FilterChip, FilterSheetButton, LockedChip, SearchField, UnavailableChip } from '../records/list-toolbar';
import {
  HeaderLabel,
  LastActivityEmpty,
  NameBlock,
  OwnerValue,
  PhoneValue,
  RecordAvatar,
  SELECT_TH,
  SelectAll,
  SelectRow,
  StatusWord,
  TABLE,
  TagList,
  cellClass,
  nameTd,
  nameTh,
  selectTd,
  subLine,
  LineParts,
  copyPart,
  recordPart,
  type LinePart,
} from '../records/list-table';
import { PagingFooter, usePaging, type PageSize } from '../records/paging';
import { useSelection } from '../records/bulk-bar';
import { CardName, RecordCard, SwipeHint, type CardAction } from '../records/record-card';
import { EmptyLanding, NoResults, STATE_PRIMARY } from '../records/list-states';
import { useMyProgrammes } from '../records/use-my-programmes';
import {
  ACCOUNT_COLUMNS,
  ACCOUNT_FILTERS,
  ACCOUNT_SORTS,
  DEFAULT_ACCOUNT_VIEW,
  NO_ACCOUNT_FILTERS,
  accountOptionLabel,
  activeAccountFilters,
  addFreeValue,
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
  type AccountFilterKey,
  type AccountFilterState,
  type AccountView,
} from './accounts-model';
import type { SheetMode } from './account-sheet';

// Loaded when opened: the create and edit sheet and the phone's filter sheet are not on the list's first paint.
const AccountSheet = guarded(clientLazy(() => import('./account-sheet').then((module) => module.AccountSheet)));
const FilterSheet = guarded(clientLazy(() => import('../records/filter-sheet').then((module) => module.FilterSheet)));

/**
 * `P04/03` — the Accounts list — with `P04/05` (empty, no results) and `P04/06`
 * (loading, offline), behind the accounts flag, which only the server page reads
 * (T-0057), drawn to the export by T-0133 (D-L193). Built in the CRM shell and
 * on the list pieces every P04 screen shares (`components/records/`).
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
 * NO TOTALS (D-P13): "25+" at most, and a paging footer with no page count.
 * NO MAP, HEALTH OR ROLLUPS (D-L69). NO BULK ACTIONS (T-0057): where
 * `bulk_actions` is on the selection column is drawn, and no bar, because no
 * bulk action is allowed here. NO OFFLINE EDITS (D-P21), NOTHING ON THE DEVICE
 * (D-L64).
 * ---------------------------------------------------------------------------
 */

type Popover = `filter:${AccountFilter['key']}` | 'columns' | 'sort' | 'sheet' | null;

const TIER_TONE: Readonly<Record<string, string>> = {
  enterprise: 'bg-primary-soft text-primary-text',
  mid_market: 'bg-info-soft text-info-text',
  sme: 'bg-surface-sunken text-text-2',
};

/** P04's chip glyphs. */
const CHIP_ICON: Readonly<Record<AccountFilterKey, IconName>> = {
  owner: 'person',
  tier: 'flag',
  industry: 'work',
  tag: 'layers',
  state: 'location_on',
  lga: 'location_on',
};

/** P04/03's widths, by column. */
const WIDTH: Readonly<Record<Exclude<AccountColumnKey, 'name'> | 'lastActivity', string>> = {
  phones: 'w-64',
  industry: 'w-48',
  owner: 'w-44',
  lastActivity: 'w-36',
  tier: 'w-36',
  tags: 'w-56',
  state: 'w-44',
  programmeId: 'w-48',
};

/** Module-level, so the list's effect sees one stable function. */
function fetchAccounts(q: string, view: AccountView, cursor?: string) {
  return listAccounts(toAccountQuery(q, view, cursor));
}

export function AccountsScreen({
  locale,
  messages,
  locales,
  live,
  initialQ,
  customFields = false,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  /** Nav ids whose route is on here (`crmLiveNav()`), for the shell's links, and the P04 placeholder flags. */
  live: readonly string[];
  /**
   * The `q` the page was opened with (a P27 "see all", T-0087 R8), already
   * checked to be a name on the server (`nameFromUrl`): the first search.
   */
  initialQ?: string;
  /** Custom values are on in this process (read by the server page, T-0091): offer the custom filters. */
  customFields?: boolean;
}) {
  const t = createBundleTranslator(locale, messages);
  const custom = useCustomDefinitions('account', customFields);
  const [q, setQ] = useState(initialQ ?? '');
  // The search never stays in the URL (`use-keyset-list.ts`): read once, then dropped.
  useEffect(() => {
    dropQueryFromAddressBar();
  }, []);
  const [view, setView] = useState<AccountView>(DEFAULT_ACCOUNT_VIEW);
  const [hidden, setHidden] = useState<readonly AccountColumnKey[]>(defaultHiddenAccountColumns);
  const [popover, setPopover] = useState<Popover>(null);
  const [sheet, setSheet] = useState<SheetMode | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [withheldSeen, setWithheldSeen] = useState<ReadonlySet<string>>(() => new Set());
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const list = useKeysetList(listQ(q), view, fetchAccounts);
  const programmes = useMyProgrammes();

  const flags = {
    mapView: live.includes('map_view'),
    bulk: live.includes('bulk_actions'),
    savedViews: live.includes('saved_views'),
    lastActivity: live.includes('last_activity'),
    quickActions: live.includes('quick_actions'),
    moreFilters: live.includes('more_filters'),
  };

  // A filter on a field withheld from the caller is `400 field_withheld`. Every
  // withheld field seen this session — on a row, or named by a refusal — locks
  // its chip, so the next person is told before they try.
  useEffect(() => {
    const seen = [...list.rows.flatMap((row) => row.withheldFields), ...withheldFromError(list.error)];
    setWithheldSeen((current) => (seen.every((field) => current.has(field)) ? current : new Set([...current, ...seen])));
  }, [list.rows, list.error]);

  const searched =
    list.answered.q.trim() !== '' ||
    activeAccountFilters(list.answered.view.filters).length > 0 ||
    Object.keys(list.answered.view.custom ?? NO_CUSTOM_FILTERS).length > 0;
  const state = listState({ phase: list.phase, rowCount: list.rows.length, searching: searched });
  const lockedColumns = lockedAccountColumns(list.rows);
  const lockedFilters = lockedAccountFilters(withheldSeen);
  const columns = ACCOUNT_COLUMNS.filter((column) => !hidden.includes(column.key)).map((column) => column.key);
  const offline = !list.online;
  const activeCount = activeAccountFilters(view.filters).length;

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
    setView((current) => ({ ...current, filters: NO_ACCOUNT_FILTERS, custom: NO_CUSTOM_FILTERS }));
  };
  const lastActive = [...ACCOUNT_FILTERS].reverse().find((spec) => view.filters[spec.key].length > 0)?.key;
  const removeLast = lastActive === undefined ? null : () => setFilters((current) => ({ ...current, [lastActive]: [] }));

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

  const menuItems: MenuItem[] = [
    { kind: 'unavailable', action: 'import-accounts', icon: 'upload_file', label: 'records.action.importCsv' },
    { kind: 'unavailable', action: 'export-accounts', icon: 'download', label: 'records.action.export' },
  ];
  const count = heldCount(locale, list.rows.length, list.nextCursor !== null);
  const unsaved = activeCount > 0 || q.trim() !== '';

  return (
    <CrmShell
      t={t}
      locale={locale}
      locales={locales}
      current="accounts"
      live={live}
      appBar={{
        title: t.t('accounts.title'),
        subtitle: phoneSubtitle(t, 'accounts.views.all', unsaved, count),
        actions: <PhoneBarActions t={t} savedViews={flags.savedViews} menuItems={menuItems} offline={offline} />,
      }}
      fab={<CrmFab label={t.t('records.action.newShort')} onClick={startCreate} />}
    >
      <div data-screen="P04/03" data-list-state={state} className="flex min-w-0 flex-col md:gap-3">
        {offline ? (
          <OfflineBanner
            t={t}
            locale={locale}
            syncedAt={list.syncedAt}
            onRetry={() => {
              if (navigator.onLine) list.reload();
            }}
          />
        ) : null}

        <ListHeader
          t={t}
          titleId="accounts.title"
          count={count}
          programmes={programmes.list}
          savedViews={flags.savedViews ? { allLabel: 'accounts.views.all', unsaved } : null}
          switcher={<ViewSwitcher t={t} value="table" built={['table']} mapView={flags.mapView} onChange={() => undefined} />}
          menuItems={menuItems}
          primary={<NewButton t={t} label="accounts.action.new" action="create-account" offline={offline} onClick={startCreate} />}
          offline={offline}
        />

        <div role="search" className="flex min-w-0 flex-wrap items-center gap-2 max-md:-mx-4 max-md:border-b max-md:border-border max-md:bg-surface max-md:px-3 max-md:py-2.5">
          <SearchField
            t={t}
            value={q}
            label="accounts.search.label"
            placeholderId="accounts.search.placeholderWide"
            phonePlaceholderId="accounts.search.placeholder"
            onChange={setQ}
          />
          <FilterSheetButton t={t} active={activeCount} open={popover === 'sheet'} onOpen={(trigger) => open('sheet', trigger)} />

          <div role="group" aria-label={t.t('records.filter.label')} className="hidden md:contents">
            {ACCOUNT_FILTERS.map((spec) => (
              <AccountFilterChip
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
            )).flatMap((chip, index) =>
              flags.moreFilters && index === 3
                ? [chip, <UnavailableChip key="source" t={t} name="source" icon="input" label="records.filter.source" />]
                : [chip],
            )}
            {flags.moreFilters ? (
              <>
                <UnavailableChip t={t} name="preferredLanguage" icon="translate" label="records.filter.language" />
                <UnavailableChip t={t} name="consentState" icon="verified_user" label="records.filter.consent" />
                <UnavailableChip t={t} name="dnd" icon="do_not_disturb_on" label="records.filter.dnd" />
              </>
            ) : null}
          </div>

          <div className="hidden md:contents">
            {activeCount > 0 ? (
              <button
                type="button"
                onClick={() => setFilters(() => NO_ACCOUNT_FILTERS)}
                className="h-control-sm px-2.5 text-meta font-bold text-primary-text underline underline-offset-2"
              >
                {t.t('records.filter.clearAll')}
              </button>
            ) : null}
            <span className="flex-1" />
            <div className="relative" ref={popover === 'columns' ? popoverRef : undefined}>
              <ColumnsButton t={t} open={popover === 'columns'} onOpen={(trigger) => open('columns', trigger)} />
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
            <div className="relative" ref={popover === 'sort' ? popoverRef : undefined}>
              <button
                type="button"
                data-testid="sort-control"
                aria-haspopup="true"
                aria-expanded={popover === 'sort'}
                onClick={(event) => open('sort', event.currentTarget)}
                className={TOOL_BUTTON}
              >
                <Icon name="unfold_more" size={18} />
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
          </div>
          <ActiveFilterChips
            t={t}
            chips={activeAccountFilters(view.filters).flatMap((key) => {
              const spec = ACCOUNT_FILTERS.find((filter) => filter.key === key);
              return view.filters[key].map((value) => ({
                key: `${key}:${value}`,
                text: `${spec === undefined ? key : t.t(spec.label)}: ${spec === undefined ? value : valueLabel(t, spec, value)}`,
                onRemove: () => setFilters((current) => ({ ...current, [key]: current[key].filter((item) => item !== value) })),
              }));
            })}
          />
        </div>

        {numberTyped(q) ? <NumberSearchHint t={t} searchLive={live.includes('search')} /> : null}

        {filterableFields(custom.fields).length > 0 ? (
          <LazyCustomFilterBar
            t={t}
            fields={custom.fields}
            filters={view.custom ?? NO_CUSTOM_FILTERS}
            onChange={(key, value) => setView((current) => ({ ...current, custom: setCustomFilter(current.custom ?? NO_CUSTOM_FILTERS, key, value) }))}
          />
        ) : null}

        <Body
          t={t}
          locale={locale}
          state={state}
          list={list}
          columns={columns}
          lockedColumns={lockedColumns}
          sort={view.sort}
          pageSize={(view.pageSize ?? 25) as PageSize}
          flags={flags}
          programmes={programmes.list}
          offline={offline}
          onClear={clearAll}
          onRemoveLast={removeLast}
          onCreate={startCreate}
          onEdit={startEdit}
          onPageSize={(pageSize) => setView((current) => ({ ...current, pageSize }))}
        />

        <p role="status" className="sr-only">
          {announcement}
        </p>

        {popover === 'sheet' ? (
          <FilterSheet
            t={t}
            groups={ACCOUNT_FILTERS.filter((spec) => spec.options.length > 0 && !lockedFilters.includes(spec.key)).map((spec) => ({
              key: spec.key,
              label: t.t(spec.label),
              options: spec.options.map((value) => ({ value, label: valueLabel(t, spec, value) })),
              selected: view.filters[spec.key],
            }))}
            extra={ACCOUNT_FILTERS.filter((spec) => spec.options.length === 0 && !lockedFilters.includes(spec.key)).map((spec) => (
              <fieldset key={spec.key} className="flex flex-col gap-2">
                <legend className="pb-2 text-meta font-bold text-text-2">{t.t(spec.label)}</legend>
                <FreeValues t={t} spec={spec} values={view.filters[spec.key]} onChange={setFilters} />
              </fieldset>
            ))}
            showLabel="accounts.filter.show"
            sheetRef={popoverRef}
            onToggle={(key, value) => setFilters((current) => toggleAccountFilter(current, key as AccountFilterKey, value))}
            onClear={() => setFilters(() => NO_ACCOUNT_FILTERS)}
            onClose={() => close(true)}
          />
        ) : null}
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

function AccountFilterChip({
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
    return <LockedChip t={t} filter={spec.key} icon={CHIP_ICON[spec.key]} label={t.t(spec.label)} />;
  }

  return (
    <div className="relative" ref={open ? popoverRef : undefined}>
      <FilterChip filter={spec.key} icon={CHIP_ICON[spec.key]} active={values.length > 0} open={open} onOpen={onOpen}>
        {chipText(t, spec, values)}
      </FilterChip>
      {open ? (
        <div className={`absolute start-0 top-full mt-1 w-64 ${POPOVER}`}>
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
                className={`${OPTION_CHIP} ${CHIP_ON}`}
              >
                <span data-record-text="">{value}</span>
                <Icon name="close" size={16} />
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
            className={`h-control-md min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-3 text-body-sm text-text ${FOCUS}`}
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
  locale,
  state,
  list,
  columns,
  lockedColumns,
  sort,
  pageSize,
  flags,
  programmes,
  offline,
  onClear,
  onRemoveLast,
  onCreate,
  onEdit,
  onPageSize,
}: {
  t: Translator;
  locale: string;
  state: ReturnType<typeof listState>;
  list: KeysetList<Account, AccountView>;
  columns: readonly AccountColumnKey[];
  lockedColumns: readonly AccountColumnKey[];
  sort: AccountView['sort'];
  pageSize: PageSize;
  flags: { readonly bulk: boolean; readonly lastActivity: boolean; readonly quickActions: boolean };
  programmes: readonly MyProgramme[] | null;
  offline: boolean;
  onClear: () => void;
  onRemoveLast: (() => void) | null;
  onCreate: () => void;
  onEdit: (row: Account) => void;
  onPageSize: (size: PageSize) => void;
}) {
  const paging = usePaging(list, pageSize);
  const selection = useSelection(list.answered.q, list.answered.view);

  if (state === 'loading') {
    return <ListLoading t={t} slow={list.slow} label="accounts.loading" />;
  }

  if (state === 'error') {
    return (
      <ListError
        t={t}
        heading="accounts.error.title"
        message={listRefusalId(list.error) ?? listErrorMessage(list.error)}
        code={list.error?.code ?? 'network'}
        offline={offline}
        onRetry={list.reload}
      />
    );
  }

  if (state === 'empty') {
    return (
      <EmptyLanding
        icon="domain"
        title={t.t('accounts.empty.title')}
        body={t.t('accounts.empty.body')}
        cards={[]}
        footer={null}
        phoneActions={null}
        phoneNote=""
        actions={
          <button
            type="button"
            data-action="create-account"
            data-requires-connection=""
            aria-disabled={offline ? 'true' : undefined}
            onClick={onCreate}
            className={STATE_PRIMARY}
          >
            <Icon name="add" size={20} />
            {t.t('accounts.action.new')}
          </button>
        }
      />
    );
  }

  if (state === 'no-results') {
    const answered = list.answered;
    return (
      <NoResults
        t={t}
        title={t.t('accounts.noResults.title')}
        message={
          <>
            {answered.q.trim() === '' ? null : t.t('records.noResults.query', { query: answered.q.trim() })}{' '}
            {activeAccountFilters(answered.view.filters).length === 0
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
  const cells = columns.filter((key): key is Exclude<AccountColumnKey, 'name'> => key !== 'name');
  const ownerAt = cells.indexOf('owner');
  const pageIds = rows.map((row) => row.id);
  const selectedOnPage = pageIds.filter((id) => selection.selected.has(id)).length;
  // T-0057: no bulk action is allowed on accounts, so the column is drawn and the bar is not.
  const bulk = flags.bulk;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="hidden md:block">
        {/* A scrolling region is a keyboard stop, or keyboard users cannot reach
            the columns past the edge (WCAG 2.1.1). */}
        <div
          role="region"
          aria-label={t.t('accounts.title')}
          tabIndex={0}
          className={`overflow-x-auto rounded-t-lg border border-border bg-surface ${FOCUS}`}
        >
          <table className={TABLE}>
            <caption className="sr-only">{t.t('accounts.title')}</caption>
            <colgroup>
              {bulk ? <col className="w-11" /> : null}
              <col className="w-64" />
              {cells.flatMap((key, index) => [
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
                <th role="columnheader" scope="col" data-column="name" aria-sort={nameAriaSort(sort)} className={nameTh(bulk)}>
                  <HeaderLabel t={t} label="accounts.col.name" locked={lockedColumns.includes('name')} />
                </th>
                {cells.flatMap((key, index) => {
                  const column = ACCOUNT_COLUMNS.find((spec) => spec.key === key);
                  const header = (
                    <th key={key} role="columnheader" scope="col" data-column={key} className={TH}>
                      <HeaderLabel t={t} label={column?.label ?? 'accounts.col.name'} locked={lockedColumns.includes(key)} />
                    </th>
                  );
                  return flags.lastActivity && index === ownerAt
                    ? [
                        header,
                        <th key="lastActivity" scope="col" data-column-stub="lastActivity" className={TH}>
                          {t.t('records.col.lastActivity')}
                        </th>,
                      ]
                    : [header];
                })}
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
                        <SelectRow t={t} name={row.name} checked={selected} onChange={() => selection.toggle(row.id)} />
                      </td>
                    ) : null}
                    <th scope="row" data-field="name" className={`${nameTd(selected, bulk)} text-start`}>
                      <NameBlock t={t} name={row.name} sub={placeLine(row)} square />
                    </th>
                    {cells.flatMap((key, index) => {
                      const cell = <Cell key={key} t={t} row={row} field={key} programmes={programmes} selected={selected} />;
                      return flags.lastActivity && index === ownerAt
                        ? [
                            cell,
                            <td key="lastActivity" className={cellClass(selected)}>
                              <LastActivityEmpty t={t} />
                            </td>,
                          ]
                        : [cell];
                    })}
                    <td className={cellClass(selected, 'text-end')}>
                      <EditButton t={t} row={row} offline={offline} onEdit={onEdit} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <PagingFooter t={t} locale={locale} paging={paging} size={pageSize} offline={offline} onSize={onPageSize} />
      </div>

      {flags.quickActions ? <SwipeHint t={t} label="records.card.hint" /> : null}
      <ul className="-mx-4 flex flex-col border-t border-border md:hidden">
        {rows.map((row) => (
          <AccountCard key={row.id} t={t} row={row} offline={offline} quickActions={flags.quickActions} onEdit={onEdit} />
        ))}
      </ul>
      <div className="md:hidden">
        <PagingFooter t={t} locale={locale} paging={paging} size={pageSize} offline={offline} onSize={onPageSize} />
      </div>

      {list.moreError === null ? null : (
        <p role="alert" className="text-body-sm text-danger-text">
          {t.t(listErrorMessage(list.moreError))}
        </p>
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
      className={`inline-flex h-control-sm items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-meta font-semibold text-primary-text hover:bg-primary-soft aria-disabled:cursor-not-allowed aria-disabled:text-disabled-text ${FOCUS}`}
    >
      <Icon name="edit" size={18} />
      {t.t('accounts.action.edit')}
      <span data-record-text="" className="sr-only">
        {row.name}
      </span>
    </button>
  );
}

/** "Lagos · Ikeja": the name's second line, from what is readable. */
function placeLine(row: Account): LinePart[] | null {
  return subLine([
    typeof row.state === 'string' && !cellWithheld(row, 'state') ? recordPart(row.state) : null,
    typeof row.lga === 'string' && !isAccountWithheld(row, 'lga') ? recordPart(row.lga) : null,
  ]);
}

/** The 360 px card (P04 "Accounts · Card list"): name, phone, "Industry · Owner", the tier. */
function AccountCard({
  t,
  row,
  offline,
  quickActions,
  onEdit,
}: {
  t: Translator;
  row: Account;
  offline: boolean;
  quickActions: boolean;
  onEdit: (row: Account) => void;
}) {
  const phone = row.phones?.[0];
  const actions: CardAction[] = [
    ...(quickActions
      ? ([
          { key: 'call', icon: 'call', label: 'records.card.call', onClick: null, tone: 'primary' },
          { key: 'whatsapp', icon: 'chat', label: 'records.card.whatsapp', onClick: null, tone: 'success' },
          { key: 'sms', icon: 'sms', label: 'records.card.sms', onClick: null, tone: 'info' },
        ] as const)
      : []),
    {
      key: 'edit',
      icon: 'edit',
      label: 'accounts.action.edit',
      onClick: () => onEdit(row),
      tone: 'soft',
      ariaDisabled: offline,
      attributes: { 'data-action': 'edit-account', 'data-requires-connection': '' },
    },
  ];
  const owner = cellWithheld(row, 'owner')
    ? null
    : row.owner === null || row.owner === undefined
      ? copyPart(t.t('records.owner.unassigned'))
      : recordPart(row.owner.displayName);
  const meta = subLine([cellWithheld(row, 'industry') ? null : recordPart(row.industry), owner]);
  return (
    <RecordCard t={t} rowId={row.id} name={row.name} actions={actions} avatar={<span data-field="name"><RecordAvatar name={row.name} square size={44} /></span>}>
      <CardName t={t} name={row.name} withheld={false} whatsapp={false} />
      {cellWithheld(row, 'phones') ? (
        <span data-field="phones" data-locked="true" className="text-meta text-text-muted">
          <LockedValue t={t} />
        </span>
      ) : phone === undefined ? null : (
        <span data-field="phones">
          <PhoneValue t={t} e164={phone.e164} network={null} dnd={false} more={0} compact />
        </span>
      )}
      {meta === null ? null : (
        <span className="truncate text-caption text-text-2">
          <LineParts parts={meta} />
        </span>
      )}
      {row.tier === null || row.tier === undefined || cellWithheld(row, 'tier') ? null : (
        <span data-field="tier" className="mt-0.75 flex">
          <StatusWord label={t.t(tierLabel(row.tier))} tone={TIER_TONE[row.tier] ?? ''} small />
        </span>
      )}
    </RecordCard>
  );
}

/** One cell: a lock when the row withholds the field, the value otherwise. */
function Cell({
  t,
  row,
  field,
  programmes,
  selected,
}: {
  t: Translator;
  row: Account;
  field: Exclude<AccountColumnKey, 'name'>;
  programmes: readonly MyProgramme[] | null;
  selected: boolean;
}) {
  if (cellWithheld(row, field)) {
    return (
      <td data-field={field} data-locked="true" className={cellClass(selected, 'text-meta text-text-muted')}>
        <LockedValue t={t} />
      </td>
    );
  }
  return (
    <td data-field={field} className={cellClass(selected)}>
      <Value t={t} row={row} field={field} programmes={programmes} />
    </td>
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
  const notSet = (
    <span className="text-meta">
      <Muted>{t.t('records.cell.empty')}</Muted>
    </span>
  );
  switch (field) {
    case 'industry':
      return row.industry === null || row.industry === undefined ? (
        notSet
      ) : (
        <span data-record-text="" className="block truncate text-meta">
          {row.industry}
        </span>
      );
    case 'tier':
      return row.tier === null || row.tier === undefined ? (
        notSet
      ) : (
        <StatusWord label={t.t(tierLabel(row.tier))} tone={TIER_TONE[row.tier] ?? ''} />
      );
    case 'phones': {
      const phones = row.phones ?? [];
      const first = phones[0];
      if (first === undefined) return notSet;
      // No DND marker: the contract has no DND flag for an account's numbers,
      // and a screen must not infer one.
      return <PhoneValue t={t} e164={first.e164} network={null} dnd={false} more={phones.length - 1} />;
    }
    case 'owner':
      return <OwnerValue t={t} name={row.owner === null || row.owner === undefined ? null : row.owner.displayName} />;
    case 'tags': {
      const tags = row.tags ?? [];
      return tags.length === 0 ? notSet : <TagList t={t} tags={tags} />;
    }
    case 'state':
      return row.state === null || row.state === undefined ? (
        notSet
      ) : (
        <span className="flex flex-wrap gap-1 text-meta">
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
      return name === null ? (
        <span className="text-meta">
          <Muted>{t.t('accounts.programme.unknown')}</Muted>
        </span>
      ) : (
        <span data-record-text="" className="text-meta">
          {name}
        </span>
      );
    }
  }
}
