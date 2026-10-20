'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type Translator } from '@kasuwa/i18n/bundle';
import { Checkbox, Radio } from '@kasuwa/ui/components';
import { CrmShell } from '../crm/crm-shell';
import { CRM_NAV, liveHref } from '../crm/crm-nav';
import { Icon } from '../icon';
import type { LanguageOption } from '../auth/language-menu';
import { dropQueryFromAddressBar, planSearch } from '../../lib/search-query';
import { SEARCH_TYPES, type SearchType } from '../../lib/search-api';
import { groupLabel } from './message-ids';
import { ProgrammeTag, useProgrammeNames } from './search-dropdown';
import { TYPE_ICON, TYPE_LABEL, narrow, rowsOf, typesWithHits, type SearchRow } from './search-model';
import {
  FOCUS,
  InvalidStrip,
  LoadingRows,
  NoMatches,
  PhoneStrip,
  RowName,
  SearchError,
  SECTION_LABEL,
  StatusPill,
  TypeTile,
} from './search-panel';
import { setSearchText, useSearchField } from './search-store';
import { useSearch } from './use-search';

/**
 * `P27/C` — the full search results (T-0087, rebuilt to the export by
 * T-0138). The query is the top bar's field (`search-store`): typing there
 * updates this page, and "See all results" in the dropdown lands here with
 * the text it had, a whole number or address included, without ever putting
 * it in the URL (R12). Below `md`, where the phone app bar has no field, the
 * page draws its own.
 *
 *   - "Back to …" names the screen the search was opened from, when known.
 *   - `Results for "…"` and a line saying what is shown. NO COUNT (D-P13): the
 *     read answers at most three hits per type and no total.
 *   - Sort: Best match, the served order. "Recently updated" is drawn
 *     disabled: no update time is served.
 *   - Filters: OBJECT narrows the served groups, boxes for types without a
 *     hit dimmed, never counted. OWNER and UPDATED, and the owner and updated
 *     columns, are behind `search_filters` (D-L194): only "Anyone" and "Any
 *     time", and an empty dash in the columns.
 *   - The "n results hidden" strip is never drawn (D-L195, CLAUDE.md 6.4).
 */
export function SearchScreen({
  locale,
  messages,
  locales,
  live,
  initialText,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  live: readonly string[];
  initialText: string;
}) {
  const t = createBundleTranslator(locale, messages);
  const field = useSearchField();
  const [seeded, setSeeded] = useState(false);

  // A `q` the page was opened with (a name only: `nameFromUrl`, on the server) becomes the field's text,
  // and leaves the address bar at once (R12).
  useEffect(() => {
    if (initialText !== '') setSearchText(initialText);
    setSeeded(true);
    dropQueryFromAddressBar();
    // Nothing to show yet: put the caret in the box. With a query the field stays at rest, as P27/C draws it.
    if (initialText !== '' || field.text !== '') return;
    const shellField = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]');
    const own = document.querySelector<HTMLInputElement>('[data-screen="P27"] [data-testid="search-input"]');
    const target = shellField !== null && shellField.getClientRects().length > 0 ? shellField : own;
    target?.focus();
    // Once, on arrival.
  }, []);

  const text = seeded ? field.text : initialText || field.text;

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="search" live={live}>
      <div data-screen="P27" className="flex w-full min-w-0 max-w-[1232px] flex-col gap-4 md:px-2 md:pb-4 md:pt-1">
        <ResultsPage t={t} text={text} live={live} origin={field.origin} />
      </div>
    </CrmShell>
  );
}

function ResultsPage({ t, text, live, origin }: { t: Translator; text: string; live: readonly string[]; origin: string | null }) {
  const baseId = useId();
  const plan = planSearch(text);
  const { state, retry } = useSearch(text);
  const [chosen, setChosen] = useState<readonly SearchType[]>([]);
  const filters = live.includes('search_filters');
  const scope = live.includes('programme_scope_search');
  const programmes = useProgrammeNames(scope);

  const answered = state.kind === 'results' ? state.groups : [];
  const withHits = typesWithHits(answered);
  const groups = narrow(
    answered.filter((group) => group.hits.length > 0),
    chosen,
  );
  const rows = rowsOf(baseId, groups, live.includes('deals'));
  const typed = plan.kind !== 'idle';
  const query = plan.kind === 'search' ? plan.q : '';
  const lookup = plan.kind === 'lookup';
  const anyFacet = chosen.length > 0;

  const originItem = origin === null ? undefined : CRM_NAV.find((item) => item.id === origin);
  const originHref = originItem === undefined ? null : liveHref(originItem, live);

  const title = typed ? t.t('search.results.title', { q: text.trim() }) : t.t('search.title');
  const sub = !typed ? t.t('search.intro') : lookup ? t.t('search.results.subLookup') : t.t('search.results.sub');

  return (
    <>
      <PhoneField t={t} text={text} />

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-1">
          {originItem !== undefined && originHref !== null ? (
            <Link
              href={originHref}
              className={`inline-flex h-7 items-center gap-1 self-start rounded-6 pe-1.5 ps-0.5 text-meta font-semibold text-primary-text ${FOCUS}`}
            >
              <Icon name="arrow_back" size={18} className="rtl:-scale-x-100" />
              {t.t('search.results.back', { screen: t.t(originItem.label) })}
            </Link>
          ) : null}
          <h1 className="m-0 truncate text-title-sm tracking-[-0.01em]">{title}</h1>
          <span className="text-body-sm text-text-2">{sub}</span>
        </div>
        {typed ? (
          <label className="flex items-center gap-2 text-meta font-semibold text-text-2">
            {t.t('search.sort.label')}
            <span className="relative flex">
              <select
                defaultValue="best"
                className={`h-control-md cursor-pointer appearance-none rounded-md border border-border-strong bg-surface pe-9 ps-3 text-body-sm font-normal text-text ${FOCUS}`}
              >
                <option value="best">{t.t('search.sort.best')}</option>
                <option value="recent" disabled>
                  {t.t('search.sort.recent')}
                </option>
              </select>
              <Icon name="expand_more" size={20} className="pointer-events-none absolute end-2 top-2.5 text-text" />
            </span>
          </label>
        ) : null}
      </div>

      {plan.kind === 'keepTyping' ? <PhoneStrip t={t} typing page /> : null}
      {lookup && plan.field === 'phone' && state.kind === 'results' ? <PhoneStrip t={t} typing={false} page /> : null}
      {state.kind === 'invalid' ? <InvalidStrip t={t} field={state.field} page /> : null}

      {typed ? (
        <div className="grid items-start gap-5 md:grid-cols-[220px_minmax(0,1fr)] min-[1280px]:grid-cols-[260px_minmax(0,1fr)]">
          <aside
            aria-label={t.t('search.filters.title')}
            className="hidden flex-col gap-4.5 rounded-lg border border-border bg-surface p-4 md:flex"
          >
            <div className="flex items-center">
              <b className="flex-1 text-label font-bold">{t.t('search.filters.title')}</b>
              {anyFacet ? (
                <button
                  type="button"
                  onClick={() => setChosen([])}
                  className={`h-7 rounded-6 px-1.5 text-meta font-bold text-primary-text ${FOCUS}`}
                >
                  {t.t('search.filters.clear')}
                </button>
              ) : null}
            </div>
            <div role="group" aria-label={t.t('search.filters.object')} className="flex flex-col gap-0.5">
              <span className={`pb-1 ${SECTION_LABEL}`}>{t.t('search.filters.object')}</span>
              {SEARCH_TYPES.map((type) => {
                const on = chosen.includes(type);
                const dim = !on && !withHits.includes(type);
                return (
                  <Checkbox
                    key={type}
                    size="compact"
                    checked={on}
                    // A type with no hit in this answer narrows to nothing: an inactive box, drawn in the
                    // disabled tone. Dimmed by opacity instead it failed 4.5:1 while still acting (T-0148).
                    disabled={dim}
                    data-facet={type}
                    onChange={() => setChosen(on ? chosen.filter((kind) => kind !== type) : [...chosen, type])}
                    className="min-h-9 rounded-6 px-1.5 text-body-sm"
                    label={
                      <span className="flex min-w-0 flex-1 items-center gap-2.5">
                        <Icon name={TYPE_ICON[type]} size={18} className="text-text-2" />
                        <span className="flex-1">{t.t(groupLabel(type))}</span>
                      </span>
                    }
                  />
                );
              })}
            </div>
            {filters ? (
              <>
                <RadioGroup t={t} label="search.filters.owner" options={['search.filters.anyone', 'search.filter.owner.me']} />
                <RadioGroup
                  t={t}
                  label="search.filters.updated"
                  options={['search.filter.time.any', 'search.filter.time.week', 'search.filter.time.month']}
                />
              </>
            ) : null}
          </aside>

          <div className="flex min-w-0 flex-col gap-3">
            {/* Below `md` the object facets are the dropdown's chips. */}
            {withHits.length > 0 ? (
              <div role="group" aria-label={t.t('search.filters.object')} className="flex flex-wrap gap-1.5 md:hidden">
                {(['all', ...withHits] as const).map((kind) => {
                  const on = kind === 'all' ? chosen.length === 0 : chosen.length === 1 && chosen[0] === kind;
                  return (
                    <button
                      key={kind}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setChosen(kind === 'all' ? [] : [kind])}
                      className={`inline-flex h-control-sm items-center whitespace-nowrap rounded-full border px-3 text-meta font-semibold ${FOCUS} ${
                        on ? 'border-primary bg-primary text-on-primary' : 'border-border bg-surface text-text'
                      }`}
                    >
                      {t.t(kind === 'all' ? 'search.chip.all' : groupLabel(kind))}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="overflow-hidden rounded-lg border border-border bg-surface">
              <div role="status" aria-live="polite">
                {state.kind === 'loading' ? <LoadingRows t={t} page /> : null}
                {state.kind === 'results' && rows.length === 0 ? (
                  <NoMatches
                    t={t}
                    page
                    query={text.trim()}
                    lookup={lookup}
                    filtered={anyFacet && withHits.length > 0}
                    onClearFilters={() => setChosen([])}
                  />
                ) : null}
                {rows.length > 0 ? (
                  <span data-search-announcement="" className="sr-only">
                    {t.t('search.results.count', { count: rows.length })}
                  </span>
                ) : null}
              </div>
              {state.kind === 'error' ? <SearchError error={state.error} t={t} onRetry={retry} page /> : null}
              {state.kind === 'keepTyping' || state.kind === 'invalid' ? <IdleCard t={t} /> : null}
              {rows.length > 0 ? (
                <ul aria-label={t.t('search.results.list')} className="m-0 flex list-none flex-col p-0">
                  {rows.map((row) => (
                    <ResultRow
                      key={row.id}
                      row={row}
                      t={t}
                      query={query}
                      columns={filters}
                      programme={scope ? programmes.get(row.hit.programmeId ?? '') : undefined}
                    />
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <IdleCard t={t} />
      )}
    </>
  );
}

/** Nothing searched yet: the design's empty disc and one line, never "no matches". */
function IdleCard({ t }: { t: Translator }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface px-6 py-10 text-center">
      <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-full bg-surface-sunken text-text-2">
        <Icon name="search" size={26} />
      </span>
      <span className="max-w-[420px] text-meta text-text-2">{t.t('search.input.placeholder')}</span>
    </div>
  );
}

/** The page's own field below `md` (the phone app bar has none): the top bar's field, restyled for a phone. */
function PhoneField({ t, text }: { t: Translator; text: string }) {
  return (
    <div className="flex h-12 items-center gap-1.5 rounded-10 border border-surface-sunken bg-surface-sunken pe-1.5 ps-2.5 focus-within:border-focus focus-within:bg-surface focus-within:shadow-[0_0_0_3px_var(--k-primary-soft)] md:hidden">
      <Icon name="search" size={20} className="text-text-muted" />
      <input
        data-testid="search-input"
        type="text"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={text}
        aria-label={t.t('search.input.label')}
        placeholder={t.t('shell.search.placeholder')}
        onChange={(event) => setSearchText(event.target.value)}
        className="h-full min-w-0 flex-1 bg-transparent px-1 text-body-md text-text outline-none placeholder:text-text-muted"
      />
      {text === '' ? null : (
        <button
          type="button"
          aria-label={t.t('search.field.clear')}
          onClick={() => setSearchText('')}
          className={`flex size-control-sm shrink-0 items-center justify-center rounded-6 text-text-2 ${FOCUS}`}
        >
          <Icon name="close" size={20} />
        </button>
      )}
    </div>
  );
}

/**
 * OWNER and UPDATED (P27 C), behind `search_filters`: search serves neither,
 * so the first choice is the only one and the rest are drawn disabled (D-L194).
 */
function RadioGroup({ t, label, options }: { t: Translator; label: 'search.filters.owner' | 'search.filters.updated'; options: readonly Parameters<Translator['t']>[0][] }) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={t.t(label)} className="flex flex-col gap-0.5">
      <span className={`pb-1 ${SECTION_LABEL}`}>{t.t(label)}</span>
      {options.map((option, index) => (
        <Radio
          key={option}
          name={name}
          defaultChecked={index === 0}
          disabled={index !== 0}
          title={index === 0 ? undefined : t.t('records.action.unavailable')}
          className="min-h-9 rounded-6 px-1.5 text-body-sm"
          label={<span className="flex-1">{t.t(option)}</span>}
        />
      ))}
    </div>
  );
}

/**
 * One 68px result (P27 C): a 40px tile, the highlighted name with its type
 * tag and status pill, the company line, and, behind `search_filters`, the
 * owner and updated columns with the design's empty dash.
 */
function ResultRow({
  row,
  t,
  query,
  columns,
  programme,
}: {
  row: SearchRow;
  t: Translator;
  query: string;
  columns: boolean;
  programme: string | undefined;
}) {
  const grid = columns
    ? 'grid-cols-[40px_minmax(0,1fr)] md:grid-cols-[40px_minmax(0,1fr)_110px] min-[1280px]:grid-cols-[40px_minmax(0,1fr)_150px_120px]'
    : 'grid-cols-[40px_minmax(0,1fr)]';
  const className = `grid min-h-[68px] w-full items-center gap-3.5 border-b border-border bg-surface px-4 py-2.5 text-start text-text ${grid} ${
    row.href === null ? '' : `is-hover:bg-surface-sunken ${FOCUS} focus-visible:ring-inset`
  }`;
  const body = (
    <>
      <TypeTile type={row.type} large />
      <span className="flex min-w-0 flex-col gap-0.75">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 md:flex-nowrap">
          <span className="flex min-w-0 max-w-full text-label font-semibold leading-[21px] max-md:basis-full max-md:[&_[data-field=name]]:whitespace-normal">
            <RowName row={row} query={query} t={t} />
          </span>
          <span className="inline-flex h-5 shrink-0 items-center rounded-6 bg-surface-sunken px-[7px] text-micro text-text-2">
            {t.t(TYPE_LABEL[row.type])}
          </span>
          {row.status === null ? null : <StatusPill status={row.status} t={t} small />}
          {programme === undefined ? null : <ProgrammeTag name={programme} small />}
        </span>
        {row.detail === null ? null : (
          <span data-field="company" data-record-text="" className="truncate text-meta text-text-2">
            {row.detail}
          </span>
        )}
      </span>
      {columns ? (
        <>
          <span className="hidden min-w-0 items-center gap-1.5 text-meta text-text-2 min-[1280px]:flex">
            <Icon name="person" size={16} />
            <span aria-hidden="true">{EMPTY}</span>
            <span className="sr-only">{t.t('search.col.none')}</span>
          </span>
          <span className="hidden flex-col items-end gap-1 text-caption font-normal text-text-muted md:flex">
            <span aria-hidden="true">{EMPTY}</span>
            <span className="sr-only">{t.t('search.col.none')}</span>
          </span>
        </>
      ) : null}
    </>
  );
  return (
    <li className="contents">
      {row.href === null ? (
        <div data-hit={row.hit.id} data-hit-type={row.type} className={className}>
          {body}
        </div>
      ) : (
        <Link href={row.href} prefetch={false} data-hit={row.hit.id} data-hit-type={row.type} className={className}>
          {body}
        </Link>
      )}
    </li>
  );
}

/** The design's empty cell: a dash, never a made-up owner or time. */
const EMPTY = '—';
