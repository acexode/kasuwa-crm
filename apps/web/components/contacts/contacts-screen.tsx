'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { guarded } from '../custom/lazy-boundary';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { isWithheld, type Contact } from '../../lib/records-api';
import { dropQueryFromAddressBar } from '../../lib/search-query';
import { filterableFields, NO_CUSTOM_FILTERS, listRefusalId, setCustomFilter, type CustomFilters } from '../../lib/custom-values-filters';
import { LazyCustomFilterBar } from '../custom/lazy-filters';
import { useCustomDefinitions } from '../custom/use-custom-fields';
import {
  FilterOptions,
  ListError,
  ListLoading,
  LoadMore,
  LockedValue,
  Muted,
  OfflineBanner,
  HeaderLock,
} from '../records/list-parts';
import type { ChooserProps } from '../records/column-chooser';
import { CHIP, CHIP_OFF, CHIP_ON, FOCUS, POPOVER } from '../records/list-classes';
import {
  COLUMNS,
  FILTERS,
  NO_FILTERS,
  activeFilterKeys,
  defaultHiddenColumns,
  formatPhone,
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
import { DuplicatesLink, ImportLink, UnavailableAction } from './contacts-parts';

// Loaded when opened: neither the phone's filter sheet nor the column chooser is on the list's first paint.
const ColumnChooser = guarded(
  dynamic<ChooserProps<ColumnKey>>(() => import('../records/column-chooser').then((module) => module.ColumnChooser<ColumnKey>), { ssr: false }),
);
const NoRows = guarded(dynamic(() => import('./contacts-no-rows').then((module) => module.NoRows), { ssr: false }));
const FilterSheet = guarded(dynamic(() => import('./contacts-filter-sheet').then((module) => module.FilterSheet), { ssr: false }));

/**
 * `P04/02` — the Contacts list — with `P04/05` (empty, no results) and `P04/06`
 * (loading, offline), behind the CRM records flag, which only the server page reads (T-0042).
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
  live,
  initialQ,
  customFields = false,
  importId,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  /** Nav ids whose route is on here (`crmLiveNav()`), for the shell's links. */
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
  const [hidden, setHidden] = useState<readonly ColumnKey[]>(defaultHiddenColumns);
  const [popover, setPopover] = useState<Popover>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const searchId = useId();
  const custom = useCustomDefinitions('contact', customFields);
  const [customFilters, setCustomFilters] = useState<CustomFilters>(NO_CUSTOM_FILTERS);
  const view = useMemo(() => ({ filters, custom: customFilters, ...(importId === undefined ? {} : { importId }) }), [filters, customFilters, importId]);
  // The one place the import screen is linked from here (`live` is the server's word for what is on).
  const importHref = live.includes('import') ? '/contacts/import' : null;
  // And the one place the duplicates screen is linked from (T-0097).
  const duplicatesHref = live.includes('duplicates') ? '/contacts/duplicates' : null;
  const list = useContactList(q, view);

  const searched =
    list.answered.q.trim() !== '' ||
    activeFilterKeys(list.answered.view.filters).length > 0 ||
    Object.keys(list.answered.view.custom).length > 0 ||
    list.answered.view.importId !== undefined;
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
    setCustomFilters(NO_CUSTOM_FILTERS);
  };

  const offline = !list.online;

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="contacts" live={live}>
      <div data-screen="P04/02" data-list-state={state} className="flex min-w-0 flex-col gap-4">
        {offline ? <OfflineBanner t={t} locale={locale} syncedAt={list.syncedAt} /> : null}

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
            {duplicatesHref === null ? null : <DuplicatesLink t={t} href={duplicatesHref} offline={offline} />}
            {importHref === null ? (
              <UnavailableAction t={t} action="import-csv" icon="upload_file" label="records.action.import" />
            ) : (
              <ImportLink t={t} href={importHref} action="import-csv" label="records.action.import" offline={offline} />
            )}
            <UnavailableAction t={t} action="capture-new" icon="add" label="records.action.new" primary />
          </div>
          <p className="text-body-sm text-text-2">{t.t('records.programme.note')}</p>
        </div>

        {importId === undefined ? null : (
          <p data-testid="import-filter" className="flex flex-wrap items-center gap-2 text-body-sm text-text-2">
            {t.t('records.importFilter.note')}
            <Link href="/contacts" prefetch={false} className="font-semibold text-primary-text underline">
              {t.t('records.importFilter.clear')}
            </Link>
          </p>
        )}

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
                  className={`${CHIP} ${filters[spec.key].length > 0 ? CHIP_ON : CHIP_OFF}`}
                >
                  {chipText(t, spec, filters)}
                  <Icon name="expand_more" size="sm" />
                </button>
                {popover === `filter:${spec.key}` ? (
                  <div className={`absolute start-0 top-full mt-1 w-64 ${POPOVER}`}>
                    <ContactFilterOptions t={t} spec={spec} filters={filters} onToggle={(value) => setFilters((current) => toggleFilter(current, spec.key, value))} />
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
                columns={COLUMNS}
                hidden={hidden}
                locked={locked}
                onToggle={(key) => setHidden((current) => toggleColumn(current, key))}
              />
            ) : null}
          </div>
        </div>

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
          state={state}
          list={list}
          rows={list.rows}
          columns={visibleColumns.map((column) => column.key)}
          locked={locked}
          answered={{ q: list.answered.q, view: list.answered.view.filters }}
          offline={offline}
          onClear={clearAll}
          importHref={importHref}
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
function ContactFilterOptions({
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
    <FilterOptions
      menu={spec.key}
      label={t.t(spec.label)}
      options={spec.options.map((value) => ({ value, label: t.t(optionLabel(spec.key, value)) }))}
      selected={filters[spec.key]}
      onToggle={onToggle}
    />
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
  importHref,
}: {
  t: Translator;
  state: ReturnType<typeof listState>;
  list: ReturnType<typeof useContactList>;
  rows: readonly Contact[];
  columns: readonly ColumnKey[];
  locked: readonly ColumnKey[];
  answered: { readonly q: string; readonly view: FilterState };
  offline: boolean;
  onClear: () => void;
  importHref: string | null;
}) {
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
    return <NoRows t={t} state={state} answered={answered} onClear={onClear} importHref={importHref} offline={offline} />;
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
                      {locked.includes(key) ? <HeaderLock t={t} /> : null}
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
        <LoadMore t={t} loading={list.loadingMore} offline={offline} onLoadMore={list.loadMore} />
      )}
    </div>
  );
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
        <LockedValue t={t} />
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
          {phone === undefined ? notSet : <span data-record-text="" dir="ltr" className="whitespace-nowrap tabular-nums">{formatPhone(phone.e164)}</span>}
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
