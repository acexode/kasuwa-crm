'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import { StillConnecting } from '../admin/panel';
import type { LanguageOption } from '../auth/language-menu';
import { PRIMARY_BUTTON, QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { isWithheld, type Contact } from '../../lib/records-api';
import {
  COLUMNS,
  FILTERS,
  NO_FILTERS,
  activeFilterKeys,
  defaultHiddenColumns,
  formatPhone,
  formatSyncedAt,
  initials,
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

/**
 * `P04/02` — the Contacts list — with `P04/05` (empty, no results) and `P04/06`
 * (loading, offline), behind `crm_records` (T-0042).
 *
 * ---------------------------------------------------------------------------
 * A LOCK IS NOT AN EMPTY CELL, AND AN EMPTY CELL IS NOT A LOCK.
 *
 * Field security omits a property and names it in `withheldFields`; `null`
 * means the record has no value. They are drawn differently on purpose: a
 * lock tells an agent the value exists and their role cannot see it, and
 * "Not set" tells them nobody has filled it in. Collapsing the two sends an
 * agent to ask a customer for an email the company already holds. Locks are
 * decided PER ROW: two rows on one page can come from two programmes with
 * different field security.
 *
 * THE PROGRAMME CHIP NAMES NO PROGRAMME (D-L64). The contract gives the screen
 * programme ids, never names, and an id is not a label. Until T-0043 adds a
 * scoped name lookup the chip says only that the list is limited to the
 * caller's programmes. It sends nothing: scope is resolved by the session.
 *
 * NO TOTALS (D-P13). No "1–25 of 148", no "Page 1 of 6", no count in the
 * title. The list grows with "Load more" while `nextCursor` says there is more.
 * ---------------------------------------------------------------------------
 */

const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

const CHIP = `flex min-h-touch items-center gap-2 rounded-full border px-4 text-body-sm font-semibold ${FOCUS}`;

const STATUS_TONE: Readonly<Record<string, string>> = {
  new: 'bg-info-soft text-info-text',
  contacted: 'bg-primary-soft text-primary-text',
  qualified: 'bg-success-soft text-success-text',
  unqualified: 'bg-surface-sunken text-text-2',
  customer: 'bg-accent-soft text-accent-text',
};

type Popover = `filter:${FilterKey}` | 'columns' | 'sheet' | null;

export function ContactsScreen({
  locale,
  messages,
  locales,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
}) {
  const t = createBundleTranslator(locale, messages);
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<FilterState>(NO_FILTERS);
  const [hidden, setHidden] = useState<readonly ColumnKey[]>(defaultHiddenColumns);
  const [popover, setPopover] = useState<Popover>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const searchId = useId();
  const list = useContactList(q, filters);

  const searched = list.answered.q.trim() !== '' || activeFilterKeys(list.answered.filters).length > 0;
  const state = listState({ phase: list.phase, rowCount: list.rows.length, searching: searched });
  const locked = lockedColumns(list.rows);
  const visibleColumns = COLUMNS.filter((column) => !hidden.includes(column.key));

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
  };

  const offline = !list.online;

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="contacts">
      <div data-screen="P04/02" data-list-state={state} className="flex min-w-0 flex-col gap-4">
        {offline ? (
          <div
            role="status"
            data-testid="offline-banner"
            className="flex items-start gap-3 rounded-lg border border-warning bg-warning-soft p-3 text-body-sm text-warning-text"
          >
            <Icon name="cloud_off" size="sm" />
            <p>
              <b>{t.t('records.offline.title')}</b>{' '}
              {list.syncedAt === null
                ? t.t('records.offline.never')
                : t.t('records.offline.synced', { time: formatSyncedAt(locale, list.syncedAt) })}
            </p>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-h2">{t.t('records.title')}</h1>
            <span
              data-testid="programme-chip"
              className="inline-flex min-w-0 items-center gap-2 rounded-full border border-accent bg-accent-soft px-3 py-1 text-body-sm font-semibold text-accent-text"
            >
              <Icon name="lock" size="sm" />
              {t.t('records.programme.chip')}
            </span>
            <span className="flex-1" />
            <UnavailableAction t={t} action="import-csv" icon="upload_file" label="records.action.import" />
            <UnavailableAction t={t} action="capture-new" icon="add" label="records.action.new" primary />
          </div>
          <p className="text-body-sm text-text-2">{t.t('records.programme.note')}</p>
        </div>

        <div role="search" className="flex min-w-0 flex-wrap items-center gap-2">
          <label htmlFor={searchId} className="flex min-h-touch min-w-0 flex-1 items-center gap-2 rounded-md border border-border-strong bg-surface px-3 md:max-w-sm">
            <Icon name="search" size="sm" className="text-text-muted" />
            <input
              id={searchId}
              type="search"
              value={q}
              maxLength={100}
              autoComplete="off"
              aria-label={t.t('records.search.label')}
              placeholder={t.t('records.search.placeholder')}
              onChange={(event) => setQ(event.target.value)}
              className={`min-h-touch min-w-0 flex-1 bg-transparent text-body-md text-text placeholder:text-text-muted ${FOCUS}`}
            />
          </label>

          <button
            type="button"
            data-testid="filter-sheet-button"
            aria-haspopup="dialog"
            aria-expanded={popover === 'sheet'}
            aria-label={t.t('records.filter.label')}
            onClick={(event) => open('sheet', event.currentTarget)}
            className={`relative flex min-h-touch min-w-touch items-center justify-center rounded-md border border-border-strong bg-surface md:hidden ${FOCUS}`}
          >
            <Icon name="tune" size="sm" />
            {activeFilterKeys(filters).length > 0 ? (
              <span aria-hidden="true" className="absolute end-1 top-1 h-2 w-2 rounded-full bg-primary" />
            ) : null}
          </button>

          <div role="group" aria-label={t.t('records.filter.label')} className="hidden flex-wrap items-center gap-2 md:flex">
            {FILTERS.map((spec) => (
              <div key={spec.key} className="relative" ref={popover === `filter:${spec.key}` ? popoverRef : undefined}>
                <button
                  type="button"
                  data-filter={spec.key}
                  aria-haspopup="true"
                  aria-expanded={popover === `filter:${spec.key}`}
                  onClick={(event) => open(`filter:${spec.key}`, event.currentTarget)}
                  className={`${CHIP} ${
                    filters[spec.key].length > 0
                      ? 'border-primary bg-primary-soft text-primary-text'
                      : 'border-border bg-surface text-text hover:bg-surface-sunken'
                  }`}
                >
                  {chipText(t, spec, filters)}
                  <Icon name="expand_more" size="sm" />
                </button>
                {popover === `filter:${spec.key}` ? (
                  <div className="absolute start-0 top-full z-20 mt-1 w-64 rounded-lg border border-border bg-surface-raised p-2 shadow-2">
                    <FilterOptions t={t} spec={spec} filters={filters} onToggle={(value) => setFilters((current) => toggleFilter(current, spec.key, value))} />
                    <div className="mt-2 flex justify-end gap-2 border-t border-border pt-2">
                      <button
                        type="button"
                        onClick={() => setFilters((current) => ({ ...current, [spec.key]: [] }))}
                        className={QUIET_BUTTON}
                      >
                        {t.t('records.filter.clear')}
                      </button>
                      <button type="button" data-testid="filter-apply" onClick={() => close(true)} className={SECONDARY_BUTTON}>
                        {t.t('records.filter.done')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
            {activeFilterKeys(filters).length > 0 ? (
              <button type="button" onClick={() => setFilters(NO_FILTERS)} className={QUIET_BUTTON}>
                {t.t('records.filter.clearAll')}
              </button>
            ) : null}
          </div>

          <span className="hidden flex-1 md:block" />

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
                hidden={hidden}
                locked={locked}
                onToggle={(key) => setHidden((current) => toggleColumn(current, key))}
              />
            ) : null}
          </div>
        </div>

        <Body
          t={t}
          state={state}
          list={list}
          rows={list.rows}
          columns={visibleColumns.map((column) => column.key)}
          locked={locked}
          answered={list.answered}
          offline={offline}
          onClear={clearAll}
        />

        {popover === 'sheet' ? (
          <FilterSheet
            t={t}
            filters={filters}
            sheetRef={popoverRef}
            onToggle={(key, value) => setFilters((current) => toggleFilter(current, key, value))}
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

/** Import and create are not built (createContact is contract-only), so they are visibly off. */
function UnavailableAction({
  t,
  action,
  icon,
  label,
  primary,
}: {
  t: Translator;
  action: string;
  icon: 'upload_file' | 'add' | 'chat';
  label: MessageId;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      data-action={action}
      data-requires-connection=""
      aria-disabled="true"
      title={t.t('records.action.unavailable')}
      className={`${primary === true ? PRIMARY_BUTTON : SECONDARY_BUTTON} cursor-not-allowed opacity-60`}
    >
      <Icon name={icon} size="sm" />
      {t.t(label)}
      <span className="sr-only">{t.t('records.action.unavailable')}</span>
    </button>
  );
}

function FilterOptions({
  t,
  spec,
  filters,
  onToggle,
}: {
  t: Translator;
  spec: FilterSpec;
  filters: FilterState;
  onToggle: (value: string) => void;
}) {
  return (
    <div data-filter-menu={spec.key} role="group" aria-label={t.t(spec.label)} className="flex flex-col">
      {spec.options.map((value) => {
        const selected = filters[spec.key].includes(value);
        return (
          <button
            key={value}
            type="button"
            data-filter-option={value}
            aria-pressed={selected}
            onClick={() => onToggle(value)}
            className={`flex min-h-touch items-center gap-2 rounded-md px-2 text-start text-body-sm hover:bg-surface-sunken ${FOCUS} ${
              selected ? 'font-semibold text-primary-text' : 'text-text'
            }`}
          >
            <span aria-hidden="true" className={`flex h-5 w-5 items-center justify-center rounded-sm border ${selected ? 'border-primary bg-primary text-on-primary' : 'border-border-strong'}`}>
              {selected ? <Icon name="check" size="sm" /> : null}
            </span>
            {t.t(optionLabel(spec.key, value))}
          </button>
        );
      })}
    </div>
  );
}

function ColumnChooser({
  t,
  hidden,
  locked,
  onToggle,
}: {
  t: Translator;
  hidden: readonly ColumnKey[];
  locked: readonly ColumnKey[];
  onToggle: (key: ColumnKey) => void;
}) {
  const titleId = useId();
  return (
    <div
      data-testid="column-chooser-panel"
      role="group"
      aria-labelledby={titleId}
      className="absolute end-0 top-full z-20 mt-1 w-72 rounded-lg border border-border bg-surface-raised p-2 shadow-2"
    >
      <p id={titleId} className="px-2 py-1 text-caption font-bold text-text-muted">
        {t.t('records.columns.title')}
      </p>
      {COLUMNS.map((column) => {
        const shown = !hidden.includes(column.key);
        const isLocked = locked.includes(column.key);
        return (
          <button
            key={column.key}
            type="button"
            data-column-option={column.key}
            data-locked={isLocked ? 'true' : undefined}
            aria-pressed={shown}
            disabled={column.fixed === true}
            onClick={() => onToggle(column.key)}
            className={`flex min-h-touch w-full items-center gap-2 rounded-md px-2 text-start text-body-sm text-text hover:bg-surface-sunken disabled:hover:bg-transparent ${FOCUS}`}
          >
            <span aria-hidden="true" className={`flex h-5 w-5 items-center justify-center rounded-sm border ${shown ? 'border-primary bg-primary text-on-primary' : 'border-border-strong'}`}>
              {shown ? <Icon name="check" size="sm" /> : null}
            </span>
            <span className="flex-1">{t.t(column.label)}</span>
            {column.fixed === true ? <span className="text-caption text-text-muted">{t.t('records.columns.always')}</span> : null}
            {isLocked ? (
              <>
                <Icon name="lock" size="sm" className="text-text-muted" />
                <span className="sr-only">{t.t('records.locked.header')}</span>
              </>
            ) : null}
          </button>
        );
      })}
      {locked.length > 0 ? (
        <p data-testid="locked-columns-note" className="mt-2 flex gap-2 border-t border-border px-2 pt-2 text-caption text-text-2">
          <Icon name="lock" size="sm" />
          {t.t('records.columns.lockedNote')}
        </p>
      ) : null}
    </div>
  );
}

function FilterSheet({
  t,
  filters,
  sheetRef,
  onToggle,
  onClear,
  onClose,
}: {
  t: Translator;
  filters: FilterState;
  sheetRef: React.RefObject<HTMLDivElement | null>;
  onToggle: (key: FilterKey, value: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Focus stays inside a modal sheet: Tab past the last control comes back round.
  const trap = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])'),
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end md:hidden">
      <span aria-hidden="true" className="absolute inset-0 bg-scrim" />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="filter-sheet"
        onKeyDown={trap}
        className="relative flex max-h-full w-full flex-col gap-3 overflow-y-auto rounded-t-xl bg-surface p-4 shadow-3"
      >
        <div className="flex items-center gap-2">
          <h2 id={titleId} className="flex-1 text-h4">
            {t.t('records.filter.label')}
          </h2>
          <button
            ref={closeRef}
            type="button"
            aria-label={t.t('records.filter.sheet.close')}
            onClick={onClose}
            className={`flex min-h-touch min-w-touch items-center justify-center rounded-md hover:bg-surface-sunken ${FOCUS}`}
          >
            <Icon name="close" size="sm" />
          </button>
        </div>
        {FILTERS.map((spec) => (
          <div key={spec.key} className="flex flex-col gap-1">
            <b className="text-body-sm">{t.t(spec.label)}</b>
            <FilterOptions t={t} spec={spec} filters={filters} onToggle={(value) => onToggle(spec.key, value)} />
          </div>
        ))}
        <div className="sticky bottom-0 flex gap-2 border-t border-border bg-surface pt-3">
          <button type="button" onClick={onClear} className={`${SECONDARY_BUTTON} flex-1`}>
            {t.t('records.filter.clearAll')}
          </button>
          <button type="button" data-testid="filter-apply" onClick={onClose} className={`${PRIMARY_BUTTON} flex-1`}>
            {t.t('records.filter.sheet.apply')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The body: one of five states
// ---------------------------------------------------------------------------

function Body({
  t,
  state,
  list,
  rows,
  columns,
  locked,
  answered,
  offline,
  onClear,
}: {
  t: Translator;
  state: ReturnType<typeof listState>;
  list: ReturnType<typeof useContactList>;
  rows: readonly Contact[];
  columns: readonly ColumnKey[];
  locked: readonly ColumnKey[];
  answered: { readonly q: string; readonly filters: FilterState };
  offline: boolean;
  onClear: () => void;
}) {
  if (state === 'loading') {
    return (
      <div aria-busy="true" className="flex flex-col gap-3">
        {list.slow ? <StillConnecting t={t} /> : null}
        <span role="status" className="sr-only">
          {t.t('records.loading')}
        </span>
        <div aria-hidden="true" className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} data-testid="skeleton-row" className="flex items-center gap-3 py-2">
              <span className="h-8 w-8 shrink-0 rounded-full bg-surface-sunken" />
              <span className="h-4 w-40 rounded-sm bg-surface-sunken" />
              <span className="hidden h-4 w-32 rounded-sm bg-surface-sunken sm:block" />
              <span className="hidden h-4 flex-1 rounded-sm bg-surface-sunken md:block" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div
        role="alert"
        data-testid="list-error"
        data-error-code={list.error?.code ?? 'network'}
        className="flex flex-col items-start gap-2 rounded-lg border border-danger bg-danger-soft p-4 text-body-sm text-danger-text"
      >
        <p className="flex items-center gap-2 font-bold">
          <Icon name="error" size="sm" />
          {t.t('records.error.title')}
        </p>
        <p>{t.t(`records.error.${list.error?.code ?? 'network'}` as MessageId)}</p>
        <button type="button" data-requires-connection="" disabled={offline} onClick={list.reload} className={QUIET_BUTTON}>
          {t.t('records.retry')}
        </button>
      </div>
    );
  }

  if (state === 'empty') {
    return <EmptyState t={t} />;
  }

  if (state === 'no-results') {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface p-10 text-center">
        <Icon name="search_off" size="xl" className="text-text-muted" />
        <h2 className="text-h3">{t.t('records.noResults.title')}</h2>
        <p data-testid="no-results-message" className="max-w-xl text-body-md text-text-2">
          {answered.q.trim() === '' ? null : t.t('records.noResults.query', { query: answered.q.trim() })}{' '}
          {activeFilterKeys(answered.filters).length === 0
            ? null
            : t.t('records.noResults.filters', { filters: describeFilters(t, answered.filters) })}
        </p>
        <button type="button" data-action="clear-search-filters" onClick={onClear} className={SECONDARY_BUTTON}>
          {t.t('records.noResults.clear')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* A scrolling region is a keyboard stop, or keyboard users cannot reach the
          columns past the edge (WCAG 2.1.1). Tabular figures rather than the
          monospace face for numbers: that face is ~31 KB of font at 256 kbps. */}
      <div
        role="region"
        aria-label={t.t('records.title')}
        tabIndex={0}
        className={`hidden overflow-x-auto rounded-lg border border-border bg-surface md:block ${FOCUS}`}
      >
        <table className="w-full min-w-max border-collapse text-body-sm">
          <caption className="sr-only">{t.t('records.title')}</caption>
          <thead className="bg-surface-sunken text-caption text-text-muted">
            <tr>
              {columns.map((key) => {
                const column = COLUMNS.find((spec) => spec.key === key);
                return (
                  <th key={key} role="columnheader" scope="col" data-column={key} className="p-3 text-start font-bold">
                    <span className="inline-flex items-center gap-1">
                      {column === undefined ? null : t.t(column.label)}
                      {locked.includes(key) ? (
                        <>
                          <Icon name="lock" size="sm" />
                          <span className="sr-only">{t.t('records.locked.header')}</span>
                        </>
                      ) : null}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-row-id={row.id} className="border-t border-border align-top hover:bg-surface-sunken">
                {columns.map((key) =>
                  key === 'displayName' ? (
                    <th key={key} scope="row" data-field={key} className="p-3 text-start font-normal">
                      <NameCell row={row} />
                    </th>
                  ) : (
                    <FieldCell key={key} t={t} row={row} field={key} as="td" />
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-2 md:hidden">
        {rows.map((row) => (
          <li key={row.id} data-row-id={row.id} className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-surface p-3">
            <div data-field="displayName" className="min-w-0">
              <NameCell row={row} />
            </div>
            <FieldCell t={t} row={row} field="phones" as="div" />
            <div className="flex flex-wrap items-center gap-2">
              {columns.includes('status') ? <FieldCell t={t} row={row} field="status" as="div" /> : null}
              {columns.includes('tags') ? <FieldCell t={t} row={row} field="tags" as="div" /> : null}
            </div>
          </li>
        ))}
      </ul>

      {list.moreError === null ? null : (
        <p role="alert" className="text-body-sm text-danger-text">
          {t.t(`records.error.${list.moreError.code}` as MessageId)}
        </p>
      )}

      {list.nextCursor === null ? null : (
        <div className="flex justify-center">
          <button
            type="button"
            data-testid="load-more"
            data-requires-connection=""
            disabled={offline || list.loadingMore}
            onClick={list.loadMore}
            className={SECONDARY_BUTTON}
          >
            {list.loadingMore ? t.t('records.loadingMore') : t.t('records.loadMore')}
          </button>
        </div>
      )}
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

function NameCell({ row }: { row: Contact }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-caption font-bold text-primary-text"
      >
        {initials(row.displayName)}
      </span>
      <b data-record-text="" className="min-w-0 truncate text-body-sm">
        {row.displayName}
      </b>
    </span>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-text-muted">{children}</span>;
}

/** One cell: a lock when the row withholds the field, the value otherwise. */
function FieldCell({
  t,
  row,
  field,
  as,
}: {
  t: Translator;
  row: Contact;
  field: ColumnKey;
  as: 'td' | 'div';
}) {
  const Tag = as;
  const padding = as === 'td' ? 'p-3' : '';
  if (isWithheld(row, field)) {
    return (
      <Tag data-field={field} data-locked="true" className={`${padding} text-text-muted`}>
        <span className="inline-flex items-center gap-1">
          <Icon name="lock" size="sm" />
          {t.t('records.locked')}
        </span>
      </Tag>
    );
  }
  return (
    <Tag data-field={field} className={padding}>
      <FieldValue t={t} row={row} field={field} />
    </Tag>
  );
}

function FieldValue({ t, row, field }: { t: Translator; row: Contact; field: ColumnKey }) {
  const notSet = <Muted>{t.t('records.cell.empty')}</Muted>;
  switch (field) {
    case 'displayName':
      return <NameCell row={row} />;
    case 'phones': {
      const phone = row.phones?.[0];
      return (
        <span className="flex flex-wrap items-center gap-2">
          {phone === undefined ? notSet : <span data-record-text="" className="whitespace-nowrap tabular-nums">{formatPhone(phone.e164)}</span>}
          {row.phoneNetwork === null || row.phoneNetwork === undefined || isWithheld(row, 'phoneNetwork') ? null : (
            <span data-record-text="" className="rounded-sm bg-surface-sunken px-1 text-caption font-semibold text-text-2">
              {row.phoneNetwork}
            </span>
          )}
          {row.dnd === true && !isWithheld(row, 'dnd') ? (
            <span className="inline-flex items-center gap-1 rounded-sm bg-danger-soft px-1 text-caption font-bold text-danger-text">
              <Icon name="do_not_disturb_on" size="sm" />
              {t.t('records.dnd.badge')}
              <span className="sr-only">{t.t('records.dnd.label')}</span>
            </span>
          ) : null}
        </span>
      );
    }
    case 'whatsappOptIn':
      return row.whatsappOptIn === true ? (
        <span className="inline-flex items-center text-success-text">
          <Icon name="chat" size="sm" />
          <span className="sr-only">{t.t('records.wa.in')}</span>
        </span>
      ) : (
        <span className="inline-flex items-center text-text-muted">
          <span aria-hidden="true">{'–'}</span>
          <span className="sr-only">{t.t('records.wa.out')}</span>
        </span>
      );
    case 'emails': {
      const emails = row.emails ?? [];
      if (emails.length === 0) return notSet;
      return (
        <span className="flex flex-wrap items-center gap-1">
          <span data-record-text="">{emails[0]}</span>
          {emails.length > 1 ? <Muted>{t.t('records.more', { count: emails.length - 1 })}</Muted> : null}
        </span>
      );
    }
    case 'accountId':
      return row.accountId === null || row.accountId === undefined ? (
        <Muted>{t.t('records.account.none')}</Muted>
      ) : (
        <span>{t.t('records.account.linked')}</span>
      );
    case 'ownerUserId':
      return row.ownerUserId === null || row.ownerUserId === undefined ? (
        <Muted>{t.t('records.owner.unassigned')}</Muted>
      ) : (
        <span>{t.t('records.owner.assigned')}</span>
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
    case 'status':
      return row.status === null || row.status === undefined ? (
        notSet
      ) : (
        <span className={`inline-flex rounded-full px-2 text-caption font-bold ${STATUS_TONE[row.status] ?? ''}`}>
          {t.t(`records.status.${row.status}` as MessageId)}
        </span>
      );
    case 'source':
      return row.source === null || row.source === undefined ? notSet : <span>{t.t(`records.source.${row.source}` as MessageId)}</span>;
    case 'state':
      return row.state === null || row.state === undefined ? (
        notSet
      ) : (
        <span className="flex flex-wrap gap-1">
          <span data-record-text="">{row.state}</span>
          {row.lga === null || row.lga === undefined || isWithheld(row, 'lga') ? null : (
            <span data-record-text="" className="text-text-muted">
              {row.lga}
            </span>
          )}
        </span>
      );
    case 'consentState':
      return row.consentState === undefined ? notSet : <span>{t.t(`records.consent.${row.consentState}` as MessageId)}</span>;
    case 'preferredChannel':
      return row.preferredChannel === null || row.preferredChannel === undefined ? (
        notSet
      ) : (
        <span>{t.t(`records.channel.${row.preferredChannel}` as MessageId)}</span>
      );
  }
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
