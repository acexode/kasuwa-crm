'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { guarded } from '../custom/lazy-boundary';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { isWithheld, type Contact } from '../../lib/records-api';
import { dropQueryFromAddressBar, listQ, numberTyped } from '../../lib/search-query';
import { filterableFields, NO_CUSTOM_FILTERS, listRefusalId, setCustomFilter, type CustomFilters } from '../../lib/custom-values-filters';
import { LazyCustomFilterBar } from '../custom/lazy-filters';
import { useCustomDefinitions } from '../custom/use-custom-fields';
import { FilterOptions, ListError, ListLoading, LockedValue, Muted, NumberSearchHint, OfflineBanner } from '../records/list-parts';
import type { ChooserProps } from '../records/column-chooser';
import { FOCUS, POPOVER, TH } from '../records/list-classes';
import { ListHeader, NewButton, PhoneBarActions, ViewSwitcher, heldCount, phoneSubtitle, type MenuItem } from '../records/list-chrome';
import { ActiveFilterChips, ColumnsButton, FilterChip, FilterSheetButton, SearchField, UnavailableChip } from '../records/list-toolbar';
import {
  HeaderLabel,
  LastActivityEmpty,
  NameBlock,
  OwnerValue,
  PhoneValue,
  RecordAvatar,
  SELECT_TH,
  STATUS_TONE,
  SelectAll,
  SelectRow,
  StatusWord,
  TABLE,
  TagList,
  WaDot,
  cellClass,
  nameTd,
  nameTh,
  selectTd,
  subLine,
} from '../records/list-table';
import { PagingFooter, usePaging, type PageSize } from '../records/paging';
import { BULK_ASSIGN, BULK_CAMPAIGN, BULK_MERGE, BULK_UPDATE, BULK_WHATSAPP, BulkBar, useSelection } from '../records/bulk-bar';
import { CardName, NewFab, RecordCard, SwipeHint, type CardAction } from '../records/record-card';
import { useMyProgrammes } from '../records/use-my-programmes';
import { nameOrWithheld } from '../records/name';
import {
  COLUMNS,
  FILTERS,
  NO_FILTERS,
  activeFilterKeys,
  defaultHiddenColumns,
  listState,
  lockedColumns,
  optionLabel,
  toggleColumn,
  toggleFilter,
  type ColumnKey,
  type FilterKey,
  type FilterSpec,
  type FilterState,
} from './contacts-model';
import { useContactList } from './use-contact-list';

// Loaded when opened: neither the phone's filter sheet nor the column chooser is on the list's first paint.
const ColumnChooser = guarded(
  dynamic<ChooserProps<ColumnKey>>(() => import('../records/column-chooser').then((module) => module.ColumnChooser<ColumnKey>), { ssr: false }),
);
const NoRows = guarded(dynamic(() => import('./contacts-no-rows').then((module) => module.NoRows), { ssr: false }));
const FilterSheet = guarded(dynamic(() => import('../records/filter-sheet').then((module) => module.FilterSheet), { ssr: false }));

/**
 * `P04/02` — the Contacts list — with `P04/05` (empty, no results) and `P04/06`
 * (loading, offline), behind the CRM records flag, which only the server page
 * reads (T-0042), drawn to the export by T-0133 (D-L193).
 *
 * ---------------------------------------------------------------------------
 * A LOCK IS NOT AN EMPTY CELL, AND AN EMPTY CELL IS NOT A LOCK.
 *
 * Field security omits a property and names it in `withheldFields`; `null`
 * means the record has no value. They are drawn differently on purpose: a
 * lock tells an agent the value exists and their role cannot see it, and
 * "Not set" tells them nobody has filled it in. Locks are decided PER ROW:
 * two rows on one page can come from two programmes.
 *
 * THE PROGRAMME PILL NAMES THE CALLER'S OWN PROGRAMMES (T-0043's scoped read)
 * and is not a switcher: scope is resolved by the session, and nothing here
 * sends a programme.
 *
 * NO TOTALS (D-P13). No "1–25 of 148", no "Page 1 of 6", no count in the
 * title: the count chip says "25+" at most, and the footer pages forward on
 * `nextCursor`. Owner and account print the names the row embeds (T-0043,
 * T-0061), never an id and never a stand-in like "Assigned".
 * ---------------------------------------------------------------------------
 */

type Popover = `filter:${FilterKey}` | 'columns' | 'sheet' | null;

/** P04's chip order and glyphs; WhatsApp opt-in is this list's own extra filter. */
const CHIP_ORDER: readonly FilterKey[] = ['owner', 'status', 'source', 'dnd', 'whatsappOptIn'];
const CHIP_ICON: Readonly<Record<FilterKey, IconName>> = {
  owner: 'person',
  status: 'flag',
  source: 'input',
  dnd: 'do_not_disturb_on',
  whatsappOptIn: 'chat',
};

/** The P04 chips no `listContacts` parameter backs (`more_filters`, D-L194), drawn after Source. */
const UNAVAILABLE_CHIPS = [
  { name: 'stateLga', icon: 'location_on', label: 'records.filter.stateLga' },
  { name: 'preferredLanguage', icon: 'translate', label: 'records.filter.language' },
  { name: 'consentState', icon: 'verified_user', label: 'records.filter.consent' },
] as const;

/** The P04/02 widths, by column. */
const WIDTH: Readonly<Record<Exclude<ColumnKey, 'displayName'> | 'lastActivity', string>> = {
  phones: 'w-64',
  whatsappOptIn: 'w-16',
  emails: 'w-56',
  accountId: 'w-48',
  ownerUserId: 'w-44',
  lastActivity: 'w-36',
  tags: 'w-56',
  status: 'w-36',
  source: 'w-36',
  state: 'w-44',
  consentState: 'w-36',
  preferredChannel: 'w-40',
};

export function ContactsScreen({
  locale,
  messages,
  locales,
  live,
  initialQ,
  customFields = false,
  importId,
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
  /**
   * The import whose contacts to list (the report's link, T-0096 I9), already
   * checked to be a uuid on the server and passed only where the import flag is
   * live: the API ignores an unknown filter, so sending it where it is not
   * served would show unfiltered rows that look filtered (D-L75).
   */
  importId?: string;
}) {
  const t = createBundleTranslator(locale, messages);
  const [q, setQ] = useState(initialQ ?? '');
  // The search never stays in the URL (`use-keyset-list.ts`): read once, then dropped.
  useEffect(() => {
    dropQueryFromAddressBar();
  }, []);
  const [filters, setFilters] = useState<FilterState>(NO_FILTERS);
  const [pageSize, setPageSize] = useState<PageSize>(25);
  const [hidden, setHidden] = useState<readonly ColumnKey[]>(defaultHiddenColumns);
  const [popover, setPopover] = useState<Popover>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const custom = useCustomDefinitions('contact', customFields);
  const programmes = useMyProgrammes();
  const [customFilters, setCustomFilters] = useState<CustomFilters>(NO_CUSTOM_FILTERS);
  const view = useMemo(
    () => ({ filters, custom: customFilters, pageSize, ...(importId === undefined ? {} : { importId }) }),
    [filters, customFilters, pageSize, importId],
  );
  // The one place the import screen is linked from here (`live` is the server's word for what is on).
  const importHref = live.includes('import') ? '/contacts/import' : null;
  // And the one place the duplicates screen is linked from (T-0097).
  const duplicatesHref = live.includes('duplicates') ? '/contacts/duplicates' : null;
  // A number typed here is not sent (the API refuses it in `q`): the hint points at Search.
  const numberHeld = numberTyped(q);
  const list = useContactList(listQ(q), view);

  const flags = {
    mapView: live.includes('map_view'),
    bulk: live.includes('bulk_actions'),
    savedViews: live.includes('saved_views'),
    lastActivity: live.includes('last_activity'),
    quickActions: live.includes('quick_actions'),
    moreFilters: live.includes('more_filters'),
  };

  const searched =
    list.answered.q.trim() !== '' ||
    activeFilterKeys(list.answered.view.filters).length > 0 ||
    Object.keys(list.answered.view.custom).length > 0 ||
    list.answered.view.importId !== undefined;
  const state = listState({ phase: list.phase, rowCount: list.rows.length, searching: searched });
  const locked = lockedColumns(list.rows);
  const visibleColumns = COLUMNS.filter((column) => !hidden.includes(column.key));
  const activeCount = activeFilterKeys(filters).length;

  const open = (next: Exclude<Popover, null>, trigger: HTMLElement) => {
    triggerRef.current = trigger;
    setPopover((current) => (current === next ? null : next));
  };
  const close = (returnFocus: boolean) => {
    setPopover(null);
    if (returnFocus) triggerRef.current?.focus();
  };

  // Escape closes whatever is open and gives focus back to what opened it; a
  // press outside closes it too.
  useEffect(() => {
    if (popover === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPopover(null);
        triggerRef.current?.focus();
      }
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
  }, [popover]);

  const clearAll = () => {
    setQ('');
    setFilters(NO_FILTERS);
    setCustomFilters(NO_CUSTOM_FILTERS);
  };
  const lastActive = [...CHIP_ORDER].reverse().find((key) => filters[key].length > 0);
  const removeLast = lastActive === undefined ? null : () => setFilters((current) => ({ ...current, [lastActive]: [] }));

  const offline = !list.online;

  const menuItems: MenuItem[] = [
    importHref === null
      ? { kind: 'unavailable', action: 'import-csv', icon: 'upload_file', label: 'records.action.importCsv' }
      : { kind: 'link', href: importHref, action: 'import-csv', icon: 'upload_file', label: 'records.action.importCsv' },
    { kind: 'unavailable', action: 'export-contacts', icon: 'download', label: 'records.action.export' },
    ...(duplicatesHref === null
      ? []
      : [{ kind: 'link', href: duplicatesHref, action: 'duplicates', icon: 'group', label: 'records.action.duplicates' } as const]),
  ];

  const filtersInOrder = CHIP_ORDER.map((key) => FILTERS.find((spec) => spec.key === key)).filter(
    (spec): spec is FilterSpec => spec !== undefined,
  );

  const count = heldCount(locale, list.rows.length, list.nextCursor !== null);
  const unsaved = activeCount > 0 || q.trim() !== '';

  return (
    <CrmShell
      t={t}
      locale={locale}
      locales={locales}
      current="contacts"
      live={live}
      appBar={{
        title: t.t('records.title'),
        subtitle: phoneSubtitle(t, 'records.views.all', unsaved, count),
        actions: <PhoneBarActions t={t} savedViews={flags.savedViews} menuItems={menuItems} offline={offline} />,
      }}
      fab={<NewFab t={t} action="capture-new-fab" offline={offline} />}
    >
      <div data-screen="P04/02" data-list-state={state} className="flex min-w-0 flex-col md:gap-3">
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
          title="records.title"
          count={count}
          programmes={programmes.list}
          savedViews={flags.savedViews ? { allLabel: 'records.views.all', unsaved } : null}
          switcher={<ViewSwitcher t={t} value="table" built={['table']} mapView={flags.mapView} onChange={() => undefined} />}
          menuItems={menuItems}
          primary={<NewButton t={t} label="records.action.new" action="capture-new" offline={offline} />}
          offline={offline}
        />

        {importId === undefined ? null : (
          <p data-testid="import-filter" className="flex flex-wrap items-center gap-2 text-body-sm text-text-2 max-md:pt-2">
            {t.t('records.importFilter.note')}
            <Link href="/contacts" prefetch={false} className="font-semibold text-primary-text underline">
              {t.t('records.importFilter.clear')}
            </Link>
          </p>
        )}

        <div role="search" className="flex min-w-0 flex-wrap items-center gap-2 max-md:-mx-4 max-md:border-b max-md:border-border max-md:bg-surface max-md:px-3 max-md:py-2.5">
          <SearchField
            t={t}
            value={q}
            label="records.search.label"
            placeholder="records.search.placeholderWide"
            phonePlaceholder="records.search.placeholder"
            onChange={setQ}
          />
          <FilterSheetButton t={t} active={activeCount} open={popover === 'sheet'} onOpen={(trigger) => open('sheet', trigger)} />

          <div role="group" aria-label={t.t('records.filter.label')} className="hidden md:contents">
            {filtersInOrder.map((spec) => (
              <ContactChip key={spec.key} t={t} spec={spec} filters={filters} popover={popover} popoverRef={popoverRef} onOpen={open} onClose={close} setFilters={setFilters} />
            )).flatMap((chip, index) =>
              index === 2 && flags.moreFilters
                ? [chip, ...UNAVAILABLE_CHIPS.map((item) => <UnavailableChip key={item.name} t={t} name={item.name} icon={item.icon} label={item.label} />)]
                : [chip],
            )}
          </div>

          <div className="hidden md:contents">
            {activeCount > 0 ? (
              <button
                type="button"
                onClick={() => setFilters(NO_FILTERS)}
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
                  columns={COLUMNS}
                  hidden={hidden}
                  locked={locked}
                  onToggle={(key) => setHidden((current) => toggleColumn(current, key))}
                />
              ) : null}
            </div>
          </div>
          <ActiveFilterChips
            t={t}
            chips={activeFilterKeys(filters).flatMap((key) =>
              filters[key].map((value) => ({
                key: `${key}:${value}`,
                text: `${t.t(FILTERS.find((spec) => spec.key === key)?.label ?? 'records.filter.label')}: ${t.t(optionLabel(key, value))}`,
                onRemove: () => setFilters((current) => toggleFilter(current, key, value)),
              })),
            )}
          />
        </div>

        {numberHeld ? <NumberSearchHint t={t} searchLive={live.includes('search')} /> : null}

        {filterableFields(custom.fields).length > 0 ? (
          <LazyCustomFilterBar
            t={t}
            fields={custom.fields}
            filters={customFilters}
            onChange={(key, value) => setCustomFilters((current) => setCustomFilter(current, key, value))}
          />
        ) : null}

        <Body
          t={t}
          locale={locale}
          state={state}
          list={list}
          columns={visibleColumns.map((column) => column.key)}
          locked={locked}
          flags={flags}
          pageSize={pageSize}
          answered={{ q: list.answered.q, view: list.answered.view.filters }}
          offline={offline}
          onClear={clearAll}
          onRemoveLast={removeLast}
          onPageSize={setPageSize}
          importHref={importHref}
        />

        {popover === 'sheet' ? (
          <FilterSheet
            t={t}
            groups={filtersInOrder.map((spec) => ({
              key: spec.key,
              label: t.t(spec.label),
              options: spec.options.map((value) => ({ value, label: t.t(optionLabel(spec.key, value)) })),
              selected: filters[spec.key],
            }))}
            showLabel="records.filter.show"
            sheetRef={popoverRef}
            onToggle={(key, value) => setFilters((current) => toggleFilter(current, key as FilterKey, value))}
            onClear={() => setFilters(NO_FILTERS)}
            onClose={() => close(true)}
          />
        ) : null}
      </div>
    </CrmShell>
  );
}

function chipText(t: Translator, spec: FilterSpec, filters: FilterState): string {
  const values = filters[spec.key];
  if (values.length === 0) return t.t(spec.label);
  return t.t('records.filter.active', {
    filter: t.t(spec.label),
    values: values.map((value) => t.t(optionLabel(spec.key, value))).join(', '),
  });
}

function ContactChip({
  t,
  spec,
  filters,
  popover,
  popoverRef,
  onOpen,
  onClose,
  setFilters,
}: {
  t: Translator;
  spec: FilterSpec;
  filters: FilterState;
  popover: Popover;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  onOpen: (next: Exclude<Popover, null>, trigger: HTMLElement) => void;
  onClose: (returnFocus: boolean) => void;
  setFilters: (change: (current: FilterState) => FilterState) => void;
}) {
  const open = popover === `filter:${spec.key}`;
  return (
    <div className="relative" ref={open ? popoverRef : undefined}>
      <FilterChip
        filter={spec.key}
        icon={CHIP_ICON[spec.key]}
        active={filters[spec.key].length > 0}
        open={open}
        onOpen={(trigger) => onOpen(`filter:${spec.key}`, trigger)}
      >
        {chipText(t, spec, filters)}
      </FilterChip>
      {open ? (
        <div className={`absolute start-0 top-full mt-1 w-64 ${POPOVER}`}>
          <FilterOptions
            menu={spec.key}
            label={t.t(spec.label)}
            options={spec.options.map((value) => ({ value, label: t.t(optionLabel(spec.key, value)) }))}
            selected={filters[spec.key]}
            onToggle={(value) => setFilters((current) => toggleFilter(current, spec.key, value))}
          />
          <div className="mt-2 flex justify-end gap-2 border-t border-border pt-2">
            <button type="button" onClick={() => setFilters((current) => ({ ...current, [spec.key]: [] }))} className={QUIET_BUTTON}>
              {t.t('records.filter.clear')}
            </button>
            <button type="button" data-testid="filter-apply" onClick={() => onClose(true)} className={SECONDARY_BUTTON}>
              {t.t('records.filter.done')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
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
  locked,
  flags,
  pageSize,
  answered,
  offline,
  onClear,
  onRemoveLast,
  onPageSize,
  importHref,
}: {
  t: Translator;
  locale: string;
  state: ReturnType<typeof listState>;
  list: ReturnType<typeof useContactList>;
  columns: readonly ColumnKey[];
  locked: readonly ColumnKey[];
  flags: { readonly bulk: boolean; readonly lastActivity: boolean; readonly quickActions: boolean };
  pageSize: PageSize;
  answered: { readonly q: string; readonly view: FilterState };
  offline: boolean;
  onClear: () => void;
  onRemoveLast: (() => void) | null;
  onPageSize: (size: PageSize) => void;
  importHref: string | null;
}) {
  const paging = usePaging(list, pageSize);
  const selection = useSelection(list.answered.q, list.answered.view);

  if (state === 'loading') {
    return <ListLoading t={t} slow={list.slow} label="records.loading" />;
  }

  if (state === 'error') {
    const code = list.error?.code ?? 'network';
    return (
      <ListError
        t={t}
        heading="records.error.title"
        message={listRefusalId(list.error) ?? (`records.error.${code}` as MessageId)}
        code={code}
        offline={offline}
        onRetry={list.reload}
      />
    );
  }

  if (state === 'empty' || state === 'no-results') {
    return (
      <NoRows t={t} state={state} answered={answered} onClear={onClear} onRemoveLast={onRemoveLast} importHref={importHref} offline={offline} />
    );
  }

  const rows = paging.rows;
  const cells = columns.filter((key): key is Exclude<ColumnKey, 'displayName'> => key !== 'displayName');
  const ownerAt = cells.indexOf('ownerUserId');
  const pageIds = rows.map((row) => row.id);
  const selectedOnPage = pageIds.filter((id) => selection.selected.has(id)).length;
  const bulk = flags.bulk;

  return (
    <div className="flex flex-col gap-2.5">
      {bulk ? (
        <BulkBar
          t={t}
          count={selection.selected.size}
          actions={[BULK_ASSIGN, BULK_CAMPAIGN, BULK_UPDATE, BULK_MERGE, BULK_WHATSAPP]}
          onSelectPage={() => selection.setAll(pageIds, true)}
          onClear={selection.clear}
        />
      ) : null}

      <div className="hidden md:block">
        {/* A scrolling region is a keyboard stop, or keyboard users cannot reach the
            columns past the edge (WCAG 2.1.1). */}
        <div
          role="region"
          aria-label={t.t('records.title')}
          tabIndex={0}
          className={`overflow-x-auto rounded-t-lg border border-border bg-surface ${FOCUS}`}
        >
          <table className={TABLE}>
            <caption className="sr-only">{t.t('records.title')}</caption>
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
                <th role="columnheader" scope="col" data-column="displayName" className={nameTh(bulk)}>
                  <HeaderLabel t={t} label="records.col.displayName" locked={locked.includes('displayName')} />
                </th>
                {cells.flatMap((key, index) => {
                  const column = COLUMNS.find((spec) => spec.key === key);
                  const header = (
                    <th
                      key={key}
                      role="columnheader"
                      scope="col"
                      data-column={key}
                      aria-label={key === 'whatsappOptIn' ? t.t('records.col.whatsappOptIn') : undefined}
                      className={`${TH} ${key === 'whatsappOptIn' ? 'text-center' : ''}`}
                    >
                      {key === 'whatsappOptIn' ? (
                        <span aria-hidden="true">{t.t('records.col.wa')}</span>
                      ) : (
                        <HeaderLabel t={t} label={column?.label ?? 'records.col.displayName'} locked={locked.includes(key)} />
                      )}
                    </th>
                  );
                  return flags.lastActivity && index === ownerAt
                    ? [
                        header,
                        <th key="lastActivity" scope="col" data-column-placeholder="lastActivity" className={TH}>
                          {t.t('records.col.lastActivity')}
                        </th>,
                      ]
                    : [header];
                })}
                <th scope="col" aria-hidden="true" className={TH} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const selected = selection.selected.has(row.id);
                return (
                  <tr key={row.id} data-row-id={row.id} data-selected={selected ? 'true' : undefined} className="group">
                    {bulk ? (
                      <td className={selectTd(selected)}>
                        <SelectRow t={t} name={nameOrWithheld(t, row.displayName)} checked={selected} onChange={() => selection.toggle(row.id)} />
                      </td>
                    ) : null}
                    <th scope="row" data-field="displayName" className={`${nameTd(selected, bulk)} text-start`}>
                      <NameBlock t={t} name={row.displayName} sub={placeLine(row)} />
                    </th>
                    {cells.flatMap((key, index) => {
                      const cell = <FieldCell key={key} t={t} row={row} field={key} selected={selected} />;
                      return flags.lastActivity && index === ownerAt
                        ? [
                            cell,
                            <td key="lastActivity" className={cellClass(selected)}>
                              <LastActivityEmpty t={t} />
                            </td>,
                          ]
                        : [cell];
                    })}
                    <td aria-hidden="true" className={cellClass(selected)} />
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
          <ContactCard key={row.id} t={t} row={row} columns={columns} quickActions={flags.quickActions} />
        ))}
      </ul>
      <div className="md:hidden">
        <PagingFooter t={t} locale={locale} paging={paging} size={pageSize} offline={offline} onSize={onPageSize} />
      </div>

      {list.moreError === null ? null : (
        <p role="alert" className="text-body-sm text-danger-text">
          {t.t(`records.error.${list.moreError.code}` as MessageId)}
        </p>
      )}
    </div>
  );
}

/** "Lagos · Ikeja": the name's second line, from what is readable. */
function placeLine(row: Contact): string | null {
  return subLine([
    typeof row.state === 'string' && !isWithheld(row, 'state') ? row.state : null,
    typeof row.lga === 'string' && !isWithheld(row, 'lga') ? row.lga : null,
  ]);
}

function networkOf(row: Contact): string | null {
  return typeof row.phoneNetwork === 'string' && row.phoneNetwork !== '' && !isWithheld(row, 'phoneNetwork') ? row.phoneNetwork : null;
}

function ownerName(t: Translator, row: Contact): string | null {
  if (isWithheld(row, 'ownerUserId') || isWithheld(row, 'owner')) return null;
  if (row.ownerUserId === null || row.ownerUserId === undefined) return t.t('records.owner.unassigned');
  return row.owner?.displayName ?? null;
}

/** The 360 px card: name and WA, phone and network, the owner, the status pill. */
function ContactCard({ t, row, columns, quickActions }: { t: Translator; row: Contact; columns: readonly ColumnKey[]; quickActions: boolean }) {
  const name = nameOrWithheld(t, row.displayName);
  const phone = row.phones?.[0];
  const actions: CardAction[] = quickActions
    ? [
        { key: 'call', icon: 'call', label: 'records.card.call', onClick: null, tone: 'primary' },
        { key: 'whatsapp', icon: 'chat', label: row.whatsappOptIn === true ? 'records.card.whatsapp' : 'records.card.noOptIn', onClick: null, tone: 'success' },
        { key: 'sms', icon: 'sms', label: 'records.card.sms', onClick: null, tone: 'info' },
      ]
    : [];
  const owner = ownerName(t, row);
  const meta = [
    row.account !== null && row.account !== undefined && !isWithheld(row, 'accountId') ? row.account.name : null,
    owner,
  ].filter((part): part is string => part !== null && part !== '');
  return (
    <RecordCard t={t} rowId={row.id} name={name} actions={actions} avatar={<RecordAvatar name={row.displayName} size={44} />}>
      <CardName t={t} name={name} withheld={row.displayName === undefined} whatsapp={row.whatsappOptIn === true && !isWithheld(row, 'whatsappOptIn')} />
      {isWithheld(row, 'phones') ? (
        <span data-field="phones" data-locked="true" className="text-meta text-text-muted">
          <LockedValue t={t} />
        </span>
      ) : phone === undefined ? null : (
        <span data-field="phones">
          <PhoneValue t={t} e164={phone.e164} network={networkOf(row)} dnd={row.dnd === true && !isWithheld(row, 'dnd')} more={0} compact />
        </span>
      )}
      {meta.length === 0 ? null : (
        <span data-record-text="" className="truncate text-caption text-text-2">
          {meta.join(' · ')}
        </span>
      )}
      <span className="mt-0.75 flex flex-wrap items-center gap-1.5">
        {columns.includes('status') && typeof row.status === 'string' && !isWithheld(row, 'status') ? (
          <span data-field="status">
            <StatusWord label={t.t(`records.status.${row.status}` as MessageId)} tone={STATUS_TONE[row.status] ?? ''} small />
          </span>
        ) : null}
        {columns.includes('tags') && (row.tags ?? []).length > 0 && !isWithheld(row, 'tags') ? (
          <span data-field="tags">
            <TagList t={t} tags={row.tags ?? []} />
          </span>
        ) : null}
      </span>
    </RecordCard>
  );
}

/** One cell: a lock when the row withholds the field, the value otherwise. */
function FieldCell({
  t,
  row,
  field,
  selected,
}: {
  t: Translator;
  row: Contact;
  field: Exclude<ColumnKey, 'displayName'>;
  selected: boolean;
}) {
  if (isWithheld(row, field)) {
    return (
      <td data-field={field} data-locked="true" className={cellClass(selected, 'text-meta text-text-muted')}>
        <LockedValue t={t} />
      </td>
    );
  }
  return (
    <td data-field={field} className={cellClass(selected, field === 'whatsappOptIn' ? 'text-center' : '')}>
      <FieldValue t={t} row={row} field={field} />
    </td>
  );
}

function FieldValue({ t, row, field }: { t: Translator; row: Contact; field: Exclude<ColumnKey, 'displayName'> }) {
  const notSet = (
    <span className="text-meta">
      <Muted>{t.t('records.cell.empty')}</Muted>
    </span>
  );
  switch (field) {
    case 'phones': {
      const phones = row.phones ?? [];
      const phone = phones[0];
      if (phone === undefined) return notSet;
      return (
        <PhoneValue
          t={t}
          e164={phone.e164}
          network={networkOf(row)}
          dnd={row.dnd === true && !isWithheld(row, 'dnd')}
          more={phones.length - 1}
        />
      );
    }
    case 'whatsappOptIn':
      return <WaDot t={t} optedIn={row.whatsappOptIn === true} />;
    case 'emails': {
      const emails = row.emails ?? [];
      if (emails[0] === undefined) return notSet;
      return (
        <span data-record-text="" className="block truncate text-meta text-text-2">
          {emails[0]}
        </span>
      );
    }
    case 'accountId':
      if (row.accountId === null || row.accountId === undefined) {
        return (
          <span className="text-meta">
            <Muted>{t.t('records.account.none')}</Muted>
          </span>
        );
      }
      return row.account === null || row.account === undefined ? (
        notSet
      ) : (
        <span data-record-text="" className="block truncate text-meta">
          {row.account.name}
        </span>
      );
    case 'ownerUserId':
      if (row.ownerUserId === null || row.ownerUserId === undefined) return <OwnerValue t={t} name={null} />;
      if (row.owner === null || row.owner === undefined || row.owner.displayName === null) return <OwnerValue t={t} name={null} former />;
      return <OwnerValue t={t} name={row.owner.displayName} />;
    case 'tags': {
      const tags = row.tags ?? [];
      return tags.length === 0 ? notSet : <TagList t={t} tags={tags} />;
    }
    case 'status':
      return row.status === null || row.status === undefined ? (
        notSet
      ) : (
        <StatusWord label={t.t(`records.status.${row.status}` as MessageId)} tone={STATUS_TONE[row.status] ?? ''} />
      );
    case 'source':
      return row.source === null || row.source === undefined ? (
        notSet
      ) : (
        <span className="text-meta">{t.t(`records.source.${row.source}` as MessageId)}</span>
      );
    case 'state':
      return row.state === null || row.state === undefined ? (
        notSet
      ) : (
        <span className="flex flex-wrap gap-1 text-meta">
          <span data-record-text="">{row.state}</span>
          {row.lga === null || row.lga === undefined || isWithheld(row, 'lga') ? null : (
            <span data-record-text="" className="text-text-muted">
              {row.lga}
            </span>
          )}
        </span>
      );
    case 'consentState':
      return row.consentState === undefined ? notSet : <span className="text-meta">{t.t(`records.consent.${row.consentState}` as MessageId)}</span>;
    case 'preferredChannel':
      return row.preferredChannel === null || row.preferredChannel === undefined ? (
        notSet
      ) : (
        <span className="text-meta">{t.t(`records.channel.${row.preferredChannel}` as MessageId)}</span>
      );
  }
}
