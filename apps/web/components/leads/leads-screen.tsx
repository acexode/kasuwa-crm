'use client';

import { clientLazy } from '../../lib/client-lazy';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { filterableFields, NO_CUSTOM_FILTERS, setCustomFilter } from '../../lib/custom-values-filters';
import { LazyCustomFilterBar } from '../custom/lazy-filters';
import { useCustomDefinitions } from '../custom/use-custom-fields';
import { guarded } from '../custom/lazy-boundary';
import { createBundleTranslator, type MessageBundle, type Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import { dropQueryFromAddressBar, listQ, numberTyped } from '../../lib/search-query';
import type { LanguageOption } from '../auth/language-menu';
import { QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { MENU_ROW, POPOVER, TOOL_BUTTON } from '../records/list-classes';
import { CheckMark, FilterOptions, NumberSearchHint, OfflineBanner } from '../records/list-parts';
import type { ChooserProps } from '../records/column-chooser';
import type { ListState } from '../records/list-model';
import { ListHeader, NewButton, PhoneBarActions, ViewSwitcher, heldCount, phoneSubtitle, type ListView, type MenuItem } from '../records/list-chrome';
import {
  ActiveFilterChips,
  ColumnsButton,
  FilterChip,
  FilterSheetButton,
  LockedChip,
  SearchField,
  UnavailableChip,
} from '../records/list-toolbar';
import { NewFab } from '../records/record-card';
import { useMyProgrammes } from '../records/use-my-programmes';
import type { PageSize } from '../records/paging';
import {
  DEFAULT_LEAD_VIEW,
  LEAD_COLUMNS,
  LEAD_FILTERS,
  LEAD_SORTS,
  NO_LEAD_FILTERS,
  activeLeadFilters,
  defaultHiddenLeadColumns,
  leadOptionLabel,
  leadSortLabel,
  lockedLeadFilters,
  toggleLeadColumn,
  toggleLeadFilter,
  type LeadColumnKey,
  type LeadFilter,
  type LeadFilterKey,
  type LeadView,
} from './leads-model';
import { LeadsTable, type LeadsMeta } from './leads-table';

/**
 * `P04/01` — the Leads table — and `P04/04` — the Kanban by status — with
 * `P04/05` (empty, no results) and `P04/06` (loading, offline), behind the
 * leads flag, which only the server page reads (T-0058, D-L86). Built in the
 * CRM shell on the list pieces the Contacts and Accounts screens share
 * (`components/records/`), and drawn to the export by T-0133 (D-L193).
 *
 * ---------------------------------------------------------------------------
 * A LEAD IS A CONTACT AT A LEAD STAGE (D-P17), read from `listLeads` only.
 * The table and each Kanban column are their own keyset reads: a column reads
 * its own stage alone and pages inside itself, so a busy stage never pushes a
 * quiet one off the board. No column, chip or title carries a count (D-P13);
 * the count chip says only "25+" — rows held, and that more exist.
 *
 * THE ONE CONTACT WRITE IS A MOVE, `{ version, status }`, by drag or by the
 * card's "Move" control (WCAG 2.2 SC 2.5.7). CONVERT is one convertContact.
 * Write controls show to every caller and the API's 403 is the gate (D-L84);
 * a row that withholds `status` or `accountId` offers no convert (D-L86).
 *
 * The Kanban, the column chooser, the filter sheet and the convert sheet load
 * when first opened: the table is what a person on 256 kbps waits for.
 *
 * NO MERGE, LEAD SCORE, BULK WHATSAPP OR MAP VIEW (D-L69, T-0058). The bulk bar
 * (Assign, Update field), saved views, Last activity, the Map segment and the
 * card's Call / WhatsApp / SMS are each behind their own flag, drawn in the
 * design's disabled or empty state (D-L194). NO OFFLINE EDITS (D-P21).
 * NOTHING ON THE DEVICE (D-L64): rows live in memory.
 * ---------------------------------------------------------------------------
 */

const LeadsKanban = clientLazy(() => import('./leads-kanban').then((module) => module.LeadsKanban), { loading: BoardLoading });
const ColumnChooser = guarded(
  clientLazy<ChooserProps<LeadColumnKey>>(() => import('../records/column-chooser').then((module) => module.ColumnChooser<LeadColumnKey>)),
);
const FilterSheet = guarded(clientLazy(() => import('../records/filter-sheet').then((module) => module.FilterSheet)));

function BoardLoading() {
  return <div aria-busy="true" className="h-64 rounded-lg bg-surface-sunken" />;
}

type Mode = 'table' | 'kanban';

type Popover = `filter:${LeadFilter['key']}` | 'sort' | 'columns' | 'sheet' | null;

/** P04's chip order and glyphs: Owner, Status, Source. */
const CHIP_ORDER: readonly LeadFilterKey[] = ['owner', 'status', 'source'];
const CHIP_ICON: Readonly<Record<LeadFilterKey, IconName>> = { owner: 'person', status: 'flag', source: 'input' };

/** The P04 chips no `listLeads` parameter backs (`more_filters`, D-L194). */
const UNAVAILABLE_CHIPS = [
  { name: 'stateLga', icon: 'location_on', label: 'records.filter.stateLga' },
  { name: 'preferredLanguage', icon: 'translate', label: 'records.filter.language' },
  { name: 'consentState', icon: 'verified_user', label: 'records.filter.consent' },
  { name: 'dnd', icon: 'do_not_disturb_on', label: 'records.filter.dnd' },
] as const;

export function LeadsScreen({
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
  // A lead is a contact (D-P17): the leads list filters on the contact's own fields.
  const custom = useCustomDefinitions('contact', customFields);
  const programmes = useMyProgrammes();
  const [q, setQ] = useState(initialQ ?? '');
  // The search never stays in the URL (`use-keyset-list.ts`): read once, then dropped.
  useEffect(() => {
    dropQueryFromAddressBar();
  }, []);
  const [view, setView] = useState<LeadView>(DEFAULT_LEAD_VIEW);
  const [mode, setMode] = useState<Mode>('table');
  const [state, setState] = useState<ListState>('loading');
  const [popover, setPopover] = useState<Popover>(null);
  const [hidden, setHidden] = useState<readonly LeadColumnKey[]>(defaultHiddenLeadColumns);
  const [meta, setMeta] = useState<LeadsMeta | null>(null);
  const [withheldSeen, setWithheldSeen] = useState<ReadonlySet<string>>(() => new Set());
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

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
  const noteWithheld = useCallback((fields: readonly string[]) => {
    setWithheldSeen((current) => (fields.every((field) => current.has(field)) ? current : new Set([...current, ...fields])));
  }, []);

  const lockedFilters = lockedLeadFilters(withheldSeen);
  // On the board the columns ARE the stages, so the status chip is the table's.
  const filters = CHIP_ORDER.map((key) => LEAD_FILTERS.find((spec) => spec.key === key)).filter(
    (spec): spec is LeadFilter => spec !== undefined && (mode === 'table' || spec.key !== 'status'),
  );
  const activeCount = activeLeadFilters(view.filters).length;
  const offline = meta !== null && !meta.online;

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

  const setFilters = (change: (filters: LeadView['filters']) => LeadView['filters']) =>
    setView((current) => ({ ...current, filters: change(current.filters) }));

  const clearAll = useCallback(() => {
    setQ('');
    setView((current) => ({ ...current, filters: NO_LEAD_FILTERS, custom: NO_CUSTOM_FILTERS }));
  }, []);

  // "Remove last filter": the last active chip, in the toolbar's order.
  const lastActive = [...CHIP_ORDER].reverse().find((key) => view.filters[key].length > 0);
  const removeLast =
    lastActive === undefined ? null : () => setFilters((current) => ({ ...current, [lastActive]: [] }));

  const switchTo = (next: ListView) => {
    if (next === mode || (next !== 'table' && next !== 'kanban')) return;
    setPopover(null);
    setState('loading');
    setMode(next);
  };

  const menuItems: readonly MenuItem[] = [
    { kind: 'unavailable', action: 'import-leads', icon: 'upload_file', label: 'records.action.importCsv' },
    { kind: 'unavailable', action: 'export-leads', icon: 'download', label: 'records.action.export' },
  ];

  const sheetGroups = filters.map((spec) => ({
    key: spec.key,
    label: t.t(spec.label),
    options: spec.options.map((value) => ({ value, label: t.t(leadOptionLabel(spec.key, value)) })),
    selected: view.filters[spec.key],
  }));

  const count = mode === 'table' && meta !== null ? heldCount(locale, meta.held, meta.more) : null;
  const unsaved = activeCount > 0 || q.trim() !== '';

  return (
    <CrmShell
      t={t}
      locale={locale}
      locales={locales}
      current="leads"
      live={live}
      appBar={{
        title: t.t('leads.title'),
        subtitle: phoneSubtitle(t, 'leads.views.all', unsaved, count),
        actions: <PhoneBarActions t={t} savedViews={flags.savedViews} menuItems={menuItems} offline={offline} />,
      }}
      fab={<NewFab t={t} action="capture-new-lead-fab" offline={offline} />}
    >
      <div data-screen="P04/01" data-list-state={state} className="flex min-w-0 flex-col md:gap-3">
        {offline && meta !== null && mode === 'table' ? (
          <OfflineBanner
            t={t}
            locale={locale}
            syncedAt={meta.syncedAt}
            onRetry={() => {
              if (navigator.onLine) meta.reload();
            }}
          />
        ) : null}

        <ListHeader
          t={t}
          titleId="leads.title"
          count={count}
          programmes={programmes.list}
          savedViews={flags.savedViews ? { allLabel: 'leads.views.all', unsaved } : null}
          switcher={<ViewSwitcher t={t} value={mode} built={['table', 'kanban']} mapView={flags.mapView} onChange={switchTo} />}
          menuItems={menuItems}
          primary={<NewButton t={t} label="leads.action.new" action="capture-new-lead" offline={offline} />}
          offline={offline}
        />

        <div role="search" className="flex min-w-0 flex-wrap items-center gap-2 max-md:-mx-4 max-md:border-b max-md:border-border max-md:bg-surface max-md:px-3 max-md:py-2.5">
          <SearchField
            t={t}
            value={q}
            label="leads.search.label"
            placeholderId="leads.search.placeholderWide"
            phonePlaceholderId="leads.search.placeholder"
            onChange={setQ}
          />
          <FilterSheetButton t={t} active={activeCount} open={popover === 'sheet'} onOpen={(trigger) => open('sheet', trigger)} />

          <div role="group" aria-label={t.t('records.filter.label')} className="hidden md:contents">
            {filters.map((spec) => (
              <LeadFilterChip
                key={spec.key}
                t={t}
                spec={spec}
                values={view.filters[spec.key]}
                locked={lockedFilters.includes(spec.key)}
                open={popover === `filter:${spec.key}`}
                popoverRef={popoverRef}
                onOpen={(trigger) => open(`filter:${spec.key}`, trigger)}
                onDone={() => close(true)}
                onToggle={(value) => setFilters((current) => toggleLeadFilter(current, spec.key, value))}
                onClear={() => setFilters((current) => ({ ...current, [spec.key]: [] }))}
              />
            ))}
            {flags.moreFilters
              ? UNAVAILABLE_CHIPS.map((chip) => <UnavailableChip key={chip.name} t={t} name={chip.name} icon={chip.icon} label={chip.label} />)
              : null}
          </div>

          <div className="hidden md:contents">
            {activeCount > 0 ? (
              <button
                type="button"
                onClick={() => setFilters(() => NO_LEAD_FILTERS)}
                className="h-control-sm px-2.5 text-meta font-bold text-primary-text underline underline-offset-2"
              >
                {t.t('records.filter.clearAll')}
              </button>
            ) : null}
            <span className="flex-1" />
            {mode === 'table' ? (
              <div className="relative" ref={popover === 'columns' ? popoverRef : undefined}>
                <ColumnsButton t={t} open={popover === 'columns'} onOpen={(trigger) => open('columns', trigger)} />
                {popover === 'columns' ? (
                  <ColumnChooser
                    t={t}
                    columns={LEAD_COLUMNS}
                    hidden={hidden}
                    locked={meta?.locked ?? []}
                    onToggle={(key) => setHidden((current) => toggleLeadColumn(current, key))}
                  />
                ) : null}
              </div>
            ) : null}
            <SortControl
              t={t}
              sort={view.sort}
              open={popover === 'sort'}
              popoverRef={popoverRef}
              onOpen={(trigger) => open('sort', trigger)}
              onPick={(sort) => {
                setView((current) => ({ ...current, sort }));
                close(true);
              }}
            />
          </div>
          <ActiveFilterChips
            t={t}
            chips={activeLeadFilters(view.filters).flatMap((key) =>
              view.filters[key].map((value) => ({
                key: `${key}:${value}`,
                text: `${t.t(LEAD_FILTERS.find((spec) => spec.key === key)?.label ?? 'records.filter.label')}: ${t.t(leadOptionLabel(key, value))}`,
                onRemove: () => setFilters((current) => toggleLeadFilter(current, key, value)),
              })),
            )}
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

        {mode === 'table' ? (
          <LeadsTable
            t={t}
            locale={locale}
            q={listQ(q)}
            view={view}
            hidden={hidden}
            flags={{ bulk: flags.bulk, lastActivity: flags.lastActivity, quickActions: flags.quickActions }}
            onState={setState}
            onWithheld={noteWithheld}
            onClear={clearAll}
            onRemoveLast={removeLast}
            onPageSize={(pageSize: PageSize) => setView((current) => ({ ...current, pageSize }))}
            onMeta={setMeta}
          />
        ) : (
          <LeadsKanban t={t} locale={locale} q={listQ(q)} view={view} onState={setState} onWithheld={noteWithheld} />
        )}

        {popover === 'sheet' ? (
          <FilterSheet
            t={t}
            groups={sheetGroups}
            showLabel="leads.filter.show"
            sheetRef={popoverRef}
            onToggle={(key, value) => setFilters((current) => toggleLeadFilter(current, key as LeadFilterKey, value))}
            onClear={() => setFilters(() => NO_LEAD_FILTERS)}
            onClose={() => close(true)}
          />
        ) : null}
      </div>
    </CrmShell>
  );
}

// ---------------------------------------------------------------------------
// Filters and sort
// ---------------------------------------------------------------------------

function chipText(t: Translator, spec: LeadFilter, values: readonly string[]): string {
  if (values.length === 0) return t.t(spec.label);
  return t.t('records.filter.active', {
    filter: t.t(spec.label),
    values: values.map((value) => t.t(leadOptionLabel(spec.key, value))).join(', '),
  });
}

function LeadFilterChip({
  t,
  spec,
  values,
  locked,
  open,
  popoverRef,
  onOpen,
  onDone,
  onToggle,
  onClear,
}: {
  t: Translator;
  spec: LeadFilter;
  values: readonly string[];
  locked: boolean;
  open: boolean;
  popoverRef: RefObject<HTMLDivElement | null>;
  onOpen: (trigger: HTMLElement) => void;
  onDone: () => void;
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
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
          <FilterOptions
            menu={spec.key}
            label={t.t(spec.label)}
            options={spec.options.map((value) => ({ value, label: t.t(leadOptionLabel(spec.key, value)) }))}
            selected={values}
            onToggle={onToggle}
          />
          <div className="mt-2 flex justify-end gap-2 border-t border-border pt-2">
            <button type="button" onClick={onClear} className={QUIET_BUTTON}>
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

/** The sort the contract offers (created, updated). The design sorts by header; the contract cannot sort by most columns. */
function SortControl({
  t,
  sort,
  open,
  popoverRef,
  onOpen,
  onPick,
}: {
  t: Translator;
  sort: LeadView['sort'];
  open: boolean;
  popoverRef: RefObject<HTMLDivElement | null>;
  onOpen: (trigger: HTMLElement) => void;
  onPick: (sort: LeadView['sort']) => void;
}) {
  return (
    <div className="relative" ref={open ? popoverRef : undefined}>
      <button
        type="button"
        data-testid="sort-control"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={(event) => onOpen(event.currentTarget)}
        className={TOOL_BUTTON}
      >
        <Icon name="unfold_more" size={18} />
        {t.t('accounts.sort.current', { sort: t.t(leadSortLabel(sort)) })}
      </button>
      {open ? (
        <div role="group" aria-label={t.t('accounts.sort.label')} className={`absolute start-0 top-full mt-1 w-64 ${POPOVER}`}>
          {LEAD_SORTS.map((option) => (
            <button
              key={option}
              type="button"
              data-sort-option={option}
              aria-pressed={sort === option}
              onClick={() => onPick(option)}
              className={`${MENU_ROW} ${sort === option ? 'font-semibold text-primary-text' : 'text-text'}`}
            >
              <CheckMark on={sort === option} />
              {t.t(leadSortLabel(option))}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
