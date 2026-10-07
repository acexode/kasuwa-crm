'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import { createBundleTranslator, type MessageBundle, type Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { CHIP, CHIP_OFF, CHIP_ON, FOCUS, MENU_ROW, POPOVER } from '../records/list-classes';
import { CheckMark, FilterOptions } from '../records/list-parts';
import type { ListState } from '../records/list-model';
import {
  DEFAULT_LEAD_VIEW,
  LEAD_FILTERS,
  LEAD_SORTS,
  NO_LEAD_FILTERS,
  activeLeadFilters,
  leadOptionLabel,
  leadSortLabel,
  lockedLeadFilters,
  toggleLeadFilter,
  type LeadFilter,
  type LeadFilterState,
  type LeadView,
} from './leads-model';
import { LeadsTable } from './leads-table';

/**
 * `P04/01` — the Leads table — and `P04/04` — the Kanban by status — with
 * `P04/05` (empty, no results) and `P04/06` (loading, offline), behind the
 * leads flag, which only the server page reads (T-0058, D-L86). Built in the
 * CRM shell on the list pieces the Contacts and Accounts screens share
 * (`components/records/`).
 *
 * ---------------------------------------------------------------------------
 * A LEAD IS A CONTACT AT A LEAD STAGE (D-P17), read from `listLeads` only.
 * The table and each Kanban column are their own keyset reads: a column reads
 * its own stage alone and pages inside itself, so a busy stage never pushes a
 * quiet one off the board. No column, chip or title carries a count (D-P13).
 *
 * THE ONE CONTACT WRITE IS A MOVE, `{ version, status }`, by drag or by the
 * card's "Move" control (WCAG 2.2 SC 2.5.7). CONVERT is one convertContact.
 * Write controls show to every caller and the API's 403 is the gate (D-L84);
 * a row that withholds `status` or `accountId` offers no convert (D-L86).
 *
 * The Kanban and the convert sheet load when first opened: the table is what
 * a person on 256 kbps waits for, and it is all the first paint carries.
 *
 * NO MERGE, LEAD SCORE, MAP, BULK SELECTION OR BULK WHATSAPP (D-L69). NO
 * OFFLINE EDITS (D-P21). NOTHING ON THE DEVICE (D-L64): rows live in memory.
 * ---------------------------------------------------------------------------
 */

const LeadsKanban = dynamic(() => import('./leads-kanban').then((module) => module.LeadsKanban), {
  ssr: false,
  loading: BoardLoading,
});

function BoardLoading() {
  return <div aria-busy="true" className="h-64 rounded-lg bg-surface-sunken" />;
}

type Mode = 'table' | 'kanban';

type Popover = `filter:${LeadFilter['key']}` | 'sort' | null;

export function LeadsScreen({
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
  const [view, setView] = useState<LeadView>(DEFAULT_LEAD_VIEW);
  const [mode, setMode] = useState<Mode>('table');
  const [state, setState] = useState<ListState>('loading');
  const [popover, setPopover] = useState<Popover>(null);
  const [withheldSeen, setWithheldSeen] = useState<ReadonlySet<string>>(() => new Set());
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const searchId = useId();

  // A filter on a field withheld from the caller is `400 field_withheld`. Every
  // withheld field seen this session — on a row, or named by a refusal — locks
  // its chip, so the next person is told before they try.
  const noteWithheld = useCallback((fields: readonly string[]) => {
    setWithheldSeen((current) => (fields.every((field) => current.has(field)) ? current : new Set([...current, ...fields])));
  }, []);

  const lockedFilters = lockedLeadFilters(withheldSeen);
  // On the board the columns ARE the stages, so the status chip is the table's.
  const filters = LEAD_FILTERS.filter((spec) => mode === 'table' || spec.key !== 'status');

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

  const setFilters = (change: (filters: LeadFilterState) => LeadFilterState) =>
    setView((current) => ({ ...current, filters: change(current.filters) }));

  const clearAll = useCallback(() => {
    setQ('');
    setView((current) => ({ ...current, filters: NO_LEAD_FILTERS }));
  }, []);

  const switchTo = (next: Mode) => {
    if (next === mode) return;
    setPopover(null);
    setState('loading');
    setMode(next);
  };

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="leads" live={live}>
      <div data-screen="P04/01" data-list-state={state} className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-h2">{t.t('leads.title')}</h1>
            <span className="inline-flex min-w-0 items-center gap-2 rounded-full border border-accent bg-accent-soft px-3 py-1 text-body-sm font-semibold text-accent-text">
              <Icon name="lock" size="sm" />
              {t.t('records.programme.chip')}
            </span>
            <span className="flex-1" />
            <div role="group" aria-label={t.t('leads.view.label')} className="flex gap-1 rounded-md border border-border bg-surface p-1">
              {(['table', 'kanban'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  data-view-option={option}
                  aria-pressed={mode === option}
                  onClick={() => switchTo(option)}
                  className={`flex min-h-touch items-center gap-2 rounded-sm px-3 text-body-sm font-semibold ${FOCUS} ${
                    mode === option ? 'bg-primary-soft text-primary-text' : 'text-text hover:bg-surface-sunken'
                  }`}
                >
                  <Icon name={option === 'table' ? 'menu' : 'space_dashboard'} size="sm" />
                  {t.t(option === 'table' ? 'leads.view.table' : 'leads.view.kanban')}
                </button>
              ))}
            </div>
          </div>
          <p className="text-body-sm text-text-2">{t.t('leads.programme.note')}</p>
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
              aria-label={t.t('leads.search.label')}
              placeholder={t.t('leads.search.placeholder')}
              onChange={(event) => setQ(event.target.value)}
              className={`min-h-touch min-w-0 flex-1 bg-transparent text-body-md text-text placeholder:text-text-muted ${FOCUS}`}
            />
          </label>

          <div role="group" aria-label={t.t('records.filter.label')} className="flex flex-wrap items-center gap-2">
            {filters.map((spec) => (
              <FilterChip
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
            {activeLeadFilters(view.filters).length > 0 ? (
              <button type="button" onClick={() => setFilters(() => NO_LEAD_FILTERS)} className={QUIET_BUTTON}>
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
              {t.t('accounts.sort.current', { sort: t.t(leadSortLabel(view.sort)) })}
            </button>
            {popover === 'sort' ? (
              <div role="group" aria-label={t.t('accounts.sort.label')} className={`absolute end-0 top-full mt-1 w-64 ${POPOVER}`}>
                {LEAD_SORTS.map((sort) => (
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
                    {t.t(leadSortLabel(sort))}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {mode === 'table' ? (
          <LeadsTable
            t={t}
            locale={locale}
            q={q}
            view={view}
            onState={setState}
            onWithheld={noteWithheld}
            onClear={clearAll}
          />
        ) : (
          <LeadsKanban t={t} locale={locale} q={q} view={view} onState={setState} onWithheld={noteWithheld} />
        )}
      </div>
    </CrmShell>
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function chipText(t: Translator, spec: LeadFilter, values: readonly string[]): string {
  if (values.length === 0) return t.t(spec.label);
  return t.t('records.filter.active', {
    filter: t.t(spec.label),
    values: values.map((value) => t.t(leadOptionLabel(spec.key, value))).join(', '),
  });
}

function FilterChip({
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
