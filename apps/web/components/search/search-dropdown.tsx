'use client';

import Link from 'next/link';
import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import { listMyProgrammes, type MyProgramme } from '../../lib/my-programmes-api';
import { seeAllHref, type SearchType } from '../../lib/search-api';
import { planSearch } from '../../lib/search-query';
import { groupLabel, seeAllLabel } from './message-ids';
import { narrow, rowsOf, typesWithHits, type SearchRow } from './search-model';
import {
  FOCUS,
  InvalidStrip,
  KEYS,
  KeyCap,
  KeyHint,
  LoadingRows,
  NoMatches,
  PhoneStrip,
  RowName,
  SearchError,
  SECTION_LABEL,
  StatusPill,
  TypeTile,
} from './search-panel';
import { useSearch } from './use-search';

/**
 * P27 A–A5 and B1 (T-0138): the panel under the top-bar search field, and
 * the programme scope menu. LOADED ON FIRST FOCUS (R29): the shell reaches
 * this module only through a dynamic `import()`, so a 256 kbps user who never
 * focuses the field never downloads it.
 *
 * THE FIELD STAYS THE COMBOBOX (R6). The shell's input keeps focus; ArrowDown
 * and ArrowUp move `aria-activedescendant` over the options here, Enter opens
 * the active one, and the shell asks this panel which one that is through
 * `keys`. As in the export, the first hit is active as soon as hits arrive.
 *
 * NO COUNTS (D-P13): the object chips name the types that have a hit in this
 * answer, never how many. Owner and date (A3) are drawn behind
 * `search_filters` with only "Any" choosable: search serves neither (D-L194).
 * RECENT SEARCHES (A) is behind `recent_searches`, in the design's empty state:
 * nothing is stored (D-L133 R19). The "n results hidden" strip is never drawn
 * (D-L195, CLAUDE.md 6.4).
 */

export interface DropdownKeys {
  /** Handles a key pressed in the field; `true` when it was this panel's. */
  readonly onKey: (event: KeyboardEvent<HTMLInputElement>) => boolean;
}

export interface DropdownProps {
  readonly t: Translator;
  readonly text: string;
  readonly live: readonly string[];
  readonly listboxId: string;
  readonly keysRef: Ref<DropdownKeys>;
  /** The option the field points at, and whether a listbox is drawn. */
  readonly onActive: (id: string | undefined, expanded: boolean) => void;
  /** A hit or a list was opened: the shell closes the panel and forgets the text. */
  readonly onNavigate: (href: string) => void;
  /** "See all results": the results page reads the text from the shared store (never the URL). */
  readonly onSeeAll: () => void;
  readonly onOpenPalette: () => void;
}

const CHIP = 'inline-flex h-[30px] items-center gap-[5px] whitespace-nowrap rounded-full border px-2.5 text-caption font-semibold';
const FILTER_BUTTON =
  'inline-flex h-[30px] items-center gap-1 whitespace-nowrap rounded-md border border-border bg-surface pe-1.5 ps-2.5 text-caption font-semibold text-text-2 is-hover:bg-surface-sunken';

export default function SearchDropdown({ t, text, live, listboxId, keysRef, onActive, onNavigate, onSeeAll, onOpenPalette }: DropdownProps) {
  const baseId = useId();
  const plan = planSearch(text);
  const { state, retry } = useSearch(text);
  const [chosen, setChosen] = useState<SearchType | 'all'>('all');
  const [active, setActive] = useState(-1);
  const dealsLive = live.includes('deals');
  const filters = live.includes('search_filters');
  const scope = live.includes('programme_scope_search');
  const programmes = useProgrammeNames(scope);

  const answered = state.kind === 'results' ? state.groups : [];
  const kinds = typesWithHits(answered);
  const shownGroups = narrow(
    answered.filter((group) => group.hits.length > 0),
    chosen === 'all' ? [] : [chosen],
  );
  const rows = rowsOf(baseId, shownGroups, dealsLive);
  const expanded = rows.length > 0;
  const activeRow = active >= 0 ? rows[active] : undefined;
  const query = plan.kind === 'search' ? plan.q : '';
  const typed = plan.kind !== 'idle';

  // A chip the new answer no longer has goes back to All.
  useEffect(() => {
    if (chosen !== 'all' && state.kind === 'results' && !kinds.includes(chosen)) setChosen('all');
  }, [chosen, state.kind, kinds]);

  // A new answer, a new chip or new text: the first hit is active (P27 `sel: 0`).
  const signature = rows.map((row) => row.id + row.hit.id).join('|');
  useEffect(() => {
    setActive(signature === '' ? -1 : 0);
  }, [signature]);

  useEffect(() => {
    onActive(activeRow?.id, expanded);
  }, [activeRow?.id, expanded, onActive]);

  useEffect(() => {
    if (activeRow === undefined) return;
    document.getElementById(activeRow.id)?.scrollIntoView({ block: 'nearest' });
  }, [activeRow]);

  useImperativeHandle(
    keysRef,
    () => ({
      onKey: (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (rows.length === 0) return false;
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setActive((current) => (current < 0 ? (step === 1 ? 0 : rows.length - 1) : (current + step + rows.length) % rows.length));
          return true;
        }
        if (event.key === 'Enter') {
          if (event.shiftKey || activeRow === undefined) {
            if (plan.kind === 'search' || plan.kind === 'lookup') {
              event.preventDefault();
              onSeeAll();
              return true;
            }
            return false;
          }
          event.preventDefault();
          if (activeRow.href !== null) onNavigate(activeRow.href);
          return true;
        }
        return false;
      },
    }),
    [rows.length, activeRow, plan.kind, onNavigate, onSeeAll],
  );

  const hasResults = state.kind === 'results' && answered.some((group) => group.hits.length > 0);

  return (
    <div
      data-testid="search-dropdown"
      className="absolute start-0 top-12 z-40 flex max-h-overlay-search-dropdown-max-height w-overlay-search-dropdown max-w-overlay-search-dropdown-max-width flex-col rounded-lg border border-border bg-surface text-text shadow-3 xl:max-h-overlay-search-dropdown-max-height-wide xl:w-overlay-search-dropdown-wide"
    >
      {typed ? (
        <div className="relative z-10 flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2.5">
          <div role="group" aria-label={t.t('search.chip.label')} className="flex flex-wrap gap-1.5">
            {(['all', ...kinds] as const).map((kind) => {
              const on = chosen === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={on}
                  data-chip={kind}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setChosen(kind)}
                  className={`${CHIP} ${FOCUS} ${on ? 'border-primary bg-primary text-on-primary' : 'border-border bg-surface text-text is-hover:bg-surface-sunken'}`}
                >
                  {t.t(kind === 'all' ? 'search.chip.all' : groupLabel(kind))}
                </button>
              );
            })}
          </div>
          <span className="flex-1" />
          {filters ? (
            <>
              <FilterMenu
                t={t}
                icon="person"
                current="search.filter.owner.any"
                options={['search.filter.owner.any', 'search.filter.owner.me']}
              />
              <FilterMenu
                t={t}
                icon="calendar_today"
                current="search.filter.time.any"
                options={['search.filter.time.any', 'search.filter.time.week', 'search.filter.time.month']}
              />
            </>
          ) : null}
        </div>
      ) : null}

      {plan.kind === 'keepTyping' ? <PhoneStrip t={t} typing /> : null}
      {plan.kind === 'lookup' && plan.field === 'phone' && state.kind === 'results' ? <PhoneStrip t={t} typing={false} /> : null}
      {state.kind === 'invalid' ? <InvalidStrip t={t} field={state.field} /> : null}

      <div className="min-h-0 flex-1 overflow-y-auto pb-2 pt-1">
        {!typed && live.includes('recent_searches') ? <RecentPanel t={t} /> : null}

        <div role="status" aria-live="polite">
          {state.kind === 'loading' ? <LoadingRows t={t} /> : null}
          {state.kind === 'results' && !hasResults ? <NoMatches t={t} query={text.trim()} lookup={plan.kind === 'lookup'} /> : null}
          {expanded ? (
            <span data-search-announcement="" className="sr-only">
              {t.t('search.results.count', { count: rows.length })}
            </span>
          ) : null}
        </div>
        {state.kind === 'error' ? <SearchError error={state.error} t={t} onRetry={retry} /> : null}

        {expanded ? (
          <div role="listbox" id={listboxId} aria-label={t.t('search.results.label')} className="flex flex-col">
            {shownGroups.map((group) => {
              const labelId = `${baseId}-${group.type}-label`;
              const seeAll = state.kind === 'results' && state.q !== null ? seeAllHref(group.type, state.q) : null;
              return (
                <div key={group.type} role="group" aria-labelledby={labelId} data-group={group.type} className="flex flex-col pt-1">
                  <div className={`flex h-[30px] items-center gap-2 px-4 ${SECTION_LABEL}`}>
                    <span id={labelId} role="presentation">
                      {t.t(groupLabel(group.type))}
                    </span>
                    <span className="flex-1" />
                    {seeAll === null || group.type === 'deal' ? null : (
                      // Inside the listbox, so an option (a link there failed axe's aria-required-children,
                      // T-0148); it keeps its tab stop and is never the arrow keys' active row.
                      <Link
                        href={seeAll}
                        prefetch={false}
                        role="option"
                        aria-selected={false}
                        data-see-all={group.type}
                        onClick={(event) => {
                          event.preventDefault();
                          onNavigate(seeAll);
                        }}
                        className={`inline-flex h-[26px] items-center rounded-6 px-1.5 text-caption font-bold normal-case tracking-normal text-primary-text is-hover:bg-primary-soft ${FOCUS}`}
                      >
                        {t.t(seeAllLabel(group.type as 'contact' | 'lead' | 'account'))}
                      </Link>
                    )}
                  </div>
                  {rows
                    .filter((row) => row.type === group.type)
                    .map((row) => (
                      <HitOption
                        key={row.id}
                        row={row}
                        t={t}
                        query={query}
                        selected={activeRow?.id === row.id}
                        programme={scope ? programmes.get(row.hit.programmeId ?? '') : undefined}
                        onHover={() => setActive(rows.indexOf(row))}
                        onNavigate={onNavigate}
                      />
                    ))}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-3.5 rounded-b-lg border-t border-border py-2 pe-3 ps-4 text-caption font-normal text-text-muted">
        <span className="sr-only">{t.t('search.footer.keys')}</span>
        <KeyHint keyLabel={KEYS.move} label={t.t('search.footer.move')} />
        <KeyHint keyLabel={KEYS.enter} label={t.t('search.footer.open')} />
        <KeyHint keyLabel={t.t('design.components.kbd.escape')} label={t.t('search.footer.close')} />
        <span className="flex-1" />
        {typed ? (
          (plan.kind === 'search' || plan.kind === 'lookup') && state.kind !== 'invalid' ? (
            <button
              type="button"
              data-testid="search-see-all-results"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onSeeAll}
              className={`inline-flex h-[30px] items-center gap-1 whitespace-nowrap rounded-6 px-2 text-meta font-bold text-primary-text is-hover:bg-primary-soft ${FOCUS}`}
            >
              {t.t('search.seeAllResults')}
              <Icon name="arrow_forward" size={18} className="rtl:-scale-x-100" />
            </button>
          ) : null
        ) : (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onOpenPalette}
            className={`inline-flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-6 px-2 text-caption font-semibold text-text-2 is-hover:bg-surface-sunken ${FOCUS}`}
          >
            <KeyCap>{t.t('design.components.kbd.search')}</KeyCap>
            {t.t(live.includes('ai_assistant') ? 'search.footer.commandsAi' : 'search.footer.commands')}
          </button>
        )}
      </div>
    </div>
  );
}

/** One 52px hit row (P27 A1): tile, highlighted name, details, status, programme. */
function HitOption({
  row,
  t,
  query,
  selected,
  programme,
  onHover,
  onNavigate,
}: {
  row: SearchRow;
  t: Translator;
  query: string;
  selected: boolean;
  programme: string | undefined;
  onHover: () => void;
  onNavigate: (href: string) => void;
}) {
  const className = `flex min-h-[52px] w-full min-w-0 items-center gap-3 px-4 py-1.5 text-start ${selected ? 'bg-primary-soft' : ''}`;
  const body: ReactNode = (
    <>
      <TypeTile type={row.type} />
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="flex min-w-0 text-body-sm font-semibold">
          <RowName row={row} query={query} t={t} />
        </span>
        {row.detail === null ? null : (
          <span data-field="company" data-record-text="" className="truncate text-caption font-normal leading-[18px] text-text-2">
            {row.detail}
          </span>
        )}
      </span>
      {row.status === null ? null : <StatusPill status={row.status} t={t} />}
      {programme === undefined ? null : <ProgrammeTag name={programme} />}
    </>
  );
  return row.href === null ? (
    <div id={row.id} role="option" aria-selected={selected} data-hit={row.hit.id} data-hit-type={row.type} onMouseEnter={onHover} className={className}>
      {body}
    </div>
  ) : (
    <Link
      id={row.id}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      href={row.href}
      prefetch={false}
      data-hit={row.hit.id}
      data-hit-type={row.type}
      onMouseEnter={onHover}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0 || row.href === null) return;
        event.preventDefault();
        onNavigate(row.href);
      }}
      className={className}
    >
      {body}
    </Link>
  );
}

/** A hit's programme (P27 B): 22px, radius 6, a 1px border, 11/600 text-2. */
export function ProgrammeTag({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span
      data-field="programme"
      data-record-text=""
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-6 border border-border text-micro font-semibold text-text-2 ${small ? 'h-5 px-[7px]' : 'h-5.5 px-2'}`}
    >
      {name}
    </span>
  );
}

/** RECENT SEARCHES and RECENTLY VIEWED (P27 A), in the design's empty state: nothing is ever stored (R19). */
function RecentPanel({ t }: { t: Translator }) {
  return (
    <div data-testid="search-recent" className="flex flex-col">
      <div className="flex flex-col gap-1.5 px-4 pb-2 pt-2.5">
        <div className={`flex h-[26px] items-center ${SECTION_LABEL}`}>{t.t('search.recent.title')}</div>
        <span className="text-meta text-text-muted">{t.t('search.recent.empty')}</span>
      </div>
      <div className="flex flex-col pt-1">
        <div className={`flex h-[30px] items-center px-4 ${SECTION_LABEL}`}>{t.t('search.viewed.title')}</div>
        <span className="px-4 pb-1 text-meta text-text-muted">{t.t('search.viewed.empty')}</span>
      </div>
    </div>
  );
}

/**
 * "Any owner" and "Any time" (P27 A3): a 30px bordered button and a 200px
 * menu with a check on the choice. Search serves neither an owner nor an
 * update time, so the other choices are drawn disabled (D-L194).
 */
function FilterMenu({ t, icon, current, options }: { t: Translator; icon: IconName; current: MessageId; options: readonly MessageId[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || wrapRef.current?.contains(event.target) !== true) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={`${FILTER_BUTTON} ${FOCUS}`}
      >
        <Icon name={icon} size={16} />
        {t.t(current)}
        <Icon name="expand_more" size={16} />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            setOpen(false);
          }}
          className="absolute end-0 top-9 z-20 flex w-[200px] flex-col rounded-10 border border-border bg-surface p-1 shadow-2"
        >
          {options.map((option) => {
            const on = option === current;
            return (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                aria-disabled={on ? undefined : 'true'}
                title={on ? undefined : t.t('records.action.unavailable')}
                onClick={() => {
                  if (on) setOpen(false);
                }}
                className={`flex h-[38px] items-center gap-2 rounded-6 px-2.5 text-start text-meta ${FOCUS} ${
                  on ? 'font-bold text-text is-hover:bg-surface-sunken' : 'cursor-not-allowed font-medium text-disabled-text'
                }`}
              >
                <span className="flex-1">{t.t(option)}</span>
                <Icon name="check" size={18} className={`text-primary-text ${on ? '' : 'opacity-0'}`} />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The caller's programmes by id, read once and only where the scope is drawn.
 * The session decides the list; the screen never sends one (CLAUDE.md 2.2).
 */
export function useProgrammeNames(enabled: boolean): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    void listMyProgrammes().then((result) => {
      if (live && result.ok) setNames(new Map(result.value.map((programme: MyProgramme) => [programme.id, programme.name])));
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return names;
}

/**
 * The scope menu (P27 B1), behind `programme_scope_search`. Search already
 * covers every programme the session is assigned to, and narrowing it is not
 * served (D-L87), so "All my programmes" is the checked choice and each
 * programme is drawn disabled. The lock note closes it, as designed.
 */
export function ScopeMenu({ t, onClose }: { t: Translator; onClose: () => void }) {
  const [list, setList] = useState<readonly MyProgramme[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    void listMyProgrammes().then((result) => {
      if (live) setList(result.ok ? result.value : []);
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [list]);
  const names = (list ?? []).map((programme) => programme.name);
  const joined = names.length === 0 ? '' : new Intl.ListFormat(t.locale, { type: 'conjunction' }).format(names);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t.t('search.scope.menu')}
      data-testid="search-scope-menu"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
      className="absolute start-0 top-12 z-40 flex w-overlay-search-scope-menu max-w-overlay-search-dropdown-max-width flex-col rounded-lg border border-border bg-surface p-1.5 text-text shadow-3"
    >
      <span className={`px-2.5 pb-1.5 pt-2 ${SECTION_LABEL}`}>{t.t('search.scope.menu')}</span>
      {(list ?? []).map((programme) => (
        <ScopeOption
          key={programme.id}
          icon="badge"
          label={programme.name}
          sub={t.t('search.cmd.unavailable')}
          title={t.t('search.scope.narrowUnavailable')}
          on={false}
        />
      ))}
      <ScopeOption icon="select_all" label={t.t('search.scope.all')} sub={joined} on onPick={onClose} />
      <span className="mt-1 flex gap-2 border-t border-border px-2.5 pb-1.5 pt-2.5 text-caption font-normal leading-[17px] text-text-2">
        <Icon name="lock" size={16} className="shrink-0" />
        {t.t('search.scope.note')}
      </span>
    </div>
  );
}

function ScopeOption({
  icon,
  label,
  sub,
  on,
  title,
  onPick,
}: {
  icon: IconName;
  label: string;
  sub: string;
  on: boolean;
  title?: string;
  onPick?: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      role="menuitemradio"
      aria-checked={on}
      aria-disabled={on ? undefined : 'true'}
      onClick={on ? onPick : undefined}
      className={`flex min-h-12 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-start ${FOCUS} ${
        on ? 'bg-primary-soft text-text' : 'cursor-not-allowed text-disabled-text'
      }`}
    >
      <Icon name={icon} size={20} className={on ? 'text-primary-text' : ''} />
      <span className="flex min-w-0 flex-1 flex-col">
        <b className="text-body-sm font-bold">{label}</b>
        {sub === '' ? null : <span className={`text-caption font-normal ${on ? 'text-text-2' : ''}`}>{sub}</span>}
      </span>
      <Icon name="check" size={20} className={`text-primary-text ${on ? '' : 'opacity-0'}`} />
    </button>
  );
}
