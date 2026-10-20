'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { CommandDialog } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { useLiteMode } from '../auth/lite-mode';
import { CRM_NAV, liveHref, shownNav } from '../crm/crm-nav';
import { listMyProgrammes, type MyProgramme } from '../../lib/my-programmes-api';
import { planSearch, folded } from '../../lib/search-query';
import { groupLabel } from './message-ids';
import { rowsOf, type SearchRow } from './search-model';
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
import { GO_KEYS } from './top-bar-search';
import { useSearch } from './use-search';

/**
 * The Ctrl/Cmd+K command palette (T-0087, rebuilt to P27 D–D2 by T-0138),
 * opened from anywhere in the CRM shell and by the top bar's Commands button.
 *
 * LOADED ON FIRST OPEN (R29). The shell reaches this module only through a
 * dynamic `import()`, so not one byte of it is in any screen's first load.
 *
 * A REAL DIALOG (R4, R5), the T-0129 overlay without a title row: the input
 * is the first row and the dialog is named by its label. Focus is trapped,
 * the page behind is inert, and focus returns to the opener on close.
 *
 * WHAT IT OFFERS, nothing it cannot do:
 *   - SUGGESTED: commands as 30px tiles with their key chords. Turning
 *     low-bandwidth mode on or off works. Create lead is drawn disabled until a
 *     create flow exists; Call last contact, Create ticket and Go to wallboard
 *     only where their module's placeholder flag is on, disabled (D-L194).
 *   - Switch programme (D2) behind `programme_scope_search`: the caller's own
 *     programmes, drawn disabled, because search and lists already cover them
 *     all and switching is not served (D-L87).
 *   - GO TO: every rail entry; the ones that answer here link, the rest are
 *     disabled. Never a link to a 404.
 *   - The record search (D1) once something is typed, grouped by type, with
 *     every T-0087 rule and state.
 *   - Ask AI behind `ai_assistant`, disabled: no assistant exists (D-L194).
 *
 * NOTHING SURVIVES A CLOSE (R19): the shell unmounts this on close.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

/**
 * What Tab can reach inside the dialog. Options are `tabindex="-1"` (the
 * input owns focus; arrows move the active option), so they are not stops.
 */
export function tabStops(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.tabIndex >= 0);
}

type Tone = 'primary' | 'neutral' | 'accent';

const TONE: Readonly<Record<Tone, string>> = {
  primary: 'bg-primary-soft text-primary-text',
  neutral: 'bg-surface-sunken text-text-2',
  accent: 'bg-accent-soft text-accent-text',
};

interface Item {
  readonly id: string;
  readonly icon: IconName;
  readonly tone: Tone;
  readonly label: string;
  readonly hint: string | null;
  readonly keys: readonly string[];
  readonly disabled: boolean;
  readonly run?: () => void;
  readonly href?: string;
}

interface Section {
  readonly id: string;
  readonly label: MessageId;
  readonly items: readonly Item[];
}

type Mode = 'list' | 'switch';

export function CommandPalette({
  t,
  onClose,
  dealsLive = false,
  live = [],
}: {
  t: Translator;
  onClose: () => void;
  onRetry?: () => void;
  /** The deal screen answers in this process (`crmLiveNav()` lists `deals`): deal hits may link to it. */
  dealsLive?: boolean;
  /** `crmLiveNav()`: which routes answer and which placeholders are drawn. */
  live?: readonly string[];
}) {
  const router = useRouter();
  const baseId = useId();
  const listboxId = `${baseId}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const { lite, setLite } = useLiteMode();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>('list');
  const [active, setActive] = useState(-1);
  const scope = live.includes('programme_scope_search');
  const ai = live.includes('ai_assistant');

  const plan = planSearch(mode === 'list' ? text : '');
  const { state, retry } = useSearch(mode === 'list' ? text : '');
  const typed = mode === 'list' && text.trim() !== '';

  const go = useCallback(
    (href: string) => {
      onClose();
      router.push(href);
    },
    [onClose, router],
  );

  // ----- the command and navigation rows -----------------------------------
  const commands: Item[] = useMemo(() => {
    const unavailable = t.t('search.cmd.unavailable');
    const list: (Item | null)[] = [
      { id: 'create-lead', icon: 'person_add', tone: 'primary', label: t.t('search.cmd.createLead'), hint: t.t('search.cmd.createLead.hint'), keys: ['C', 'L'], disabled: true },
      live.includes('placeholder:calls')
        ? { id: 'call', icon: 'call', tone: 'primary', label: t.t('search.cmd.call'), hint: t.t('search.cmd.call.hint'), keys: ['C', 'C'], disabled: true }
        : null,
      live.includes('placeholder:tickets')
        ? { id: 'ticket', icon: 'confirmation_number', tone: 'primary', label: t.t('search.cmd.createTicket'), hint: t.t('search.cmd.createTicket.hint'), keys: ['C', 'T'], disabled: true }
        : null,
      scope
        ? {
            id: 'switch',
            icon: 'swap_horiz',
            tone: 'primary',
            label: t.t('search.cmd.switch'),
            hint: t.t('search.cmd.switch.hint'),
            keys: ['P'],
            disabled: false,
            run: () => {
              setMode('switch');
              setText('');
            },
          }
        : null,
      live.includes('placeholder:reports')
        ? { id: 'wallboard', icon: 'monitoring', tone: 'primary', label: t.t('search.cmd.wallboard'), hint: t.t('search.cmd.wallboard.hint'), keys: ['G', 'W'], disabled: true }
        : null,
      {
        id: 'lite',
        icon: 'network_check',
        tone: 'primary',
        label: t.t(lite ? 'search.cmd.liteOff' : 'search.cmd.liteOn'),
        hint: t.t(lite ? 'search.cmd.liteOff.hint' : 'search.cmd.liteOn.hint'),
        keys: [t.t('search.key.ctrl'), KEYS.shift, 'L'],
        disabled: false,
        run: () => {
          setLite(!lite);
          onClose();
        },
      },
    ];
    return list.filter((item): item is Item => item !== null).map((item) => (item.disabled ? { ...item, hint: item.hint ?? unavailable } : item));
  }, [t, live, scope, lite, setLite, onClose]);

  const nav: Item[] = useMemo(
    () =>
      shownNav(live).map((entry) => {
        const href = liveHref(entry, live);
        const letter = GO_KEYS[entry.id];
        return {
          id: `nav-${entry.id}`,
          icon: entry.icon,
          tone: 'neutral' as const,
          label: t.t(entry.label),
          hint: href === null ? t.t('search.cmd.unavailable') : null,
          keys: letter === undefined ? [] : ['G', letter],
          disabled: href === null,
          ...(href === null ? {} : { href }),
        };
      }),
    [t, live],
  );

  const aiItem: Item | null = ai
    ? typed
      ? { id: 'ai', icon: 'auto_awesome', tone: 'accent', label: t.t('search.ai.askQuery', { q: text.trim() }), hint: t.t('search.ai.askQuery.hint'), keys: [KEYS.enter], disabled: true }
      : { id: 'ai', icon: 'auto_awesome', tone: 'accent', label: t.t('search.ai.ask'), hint: t.t('search.ai.ask.hint'), keys: [KEYS.question], disabled: true }
    : null;

  const query = folded(text);
  const matches = (item: Item) => folded(`${item.label} ${item.hint ?? ''}`).includes(query);
  const sections: Section[] = typed
    ? [
        { id: 'actions', label: 'search.palette.actions' as const, items: commands.filter(matches) },
        { id: 'goto', label: 'search.palette.goTo' as const, items: nav.filter(matches) },
      ].filter((section) => section.items.length > 0)
    : [
        { id: 'suggested', label: 'search.palette.suggested', items: commands },
        { id: 'goto', label: 'search.palette.goTo', items: nav },
      ];
  const aiSection: Section | null = aiItem === null ? null : { id: 'ai', label: 'search.palette.ai', items: [aiItem] };

  // ----- the record rows (D1) ------------------------------------------------
  const groups = typed && state.kind === 'results' ? state.groups.filter((group) => group.hits.length > 0) : [];
  const rows = rowsOf(`${baseId}-hit`, groups, dealsLive);

  // ----- the switch step (D2) -----------------------------------------------
  const [programmes, setProgrammes] = useState<readonly MyProgramme[] | null>(null);
  useEffect(() => {
    if (mode !== 'switch' || programmes !== null) return undefined;
    let current = true;
    void listMyProgrammes().then((result) => {
      if (current) setProgrammes(result.ok ? result.value : []);
    });
    return () => {
      current = false;
    };
  }, [mode, programmes]);

  // ----- one list of options, in DOM order ------------------------------------
  type Option = { readonly id: string; readonly disabled: boolean; readonly activate: () => void };
  const optionId = (item: Item) => `${baseId}-${item.id}`;
  const options: Option[] =
    mode === 'switch'
      ? []
      : [
          ...sections.flatMap((section) =>
            section.items.map((item) => ({
              id: optionId(item),
              disabled: item.disabled,
              activate: () => {
                if (item.disabled) return;
                if (item.href !== undefined) go(item.href);
                else item.run?.();
              },
            })),
          ),
          ...rows.map((row) => ({
            id: row.id,
            disabled: row.href === null,
            activate: () => {
              if (row.href !== null) go(row.href);
            },
          })),
          ...(aiSection === null ? [] : aiSection.items.map((item) => ({ id: optionId(item), disabled: true, activate: () => undefined }))),
        ];
  const enabled = options.map((option, index) => (option.disabled ? -1 : index)).filter((index) => index >= 0);
  const activeOption = active >= 0 ? options[active] : undefined;

  // A new list starts on its first option that can run (P27 `csel: 0`).
  const signature = `${mode}|${options.map((option) => option.id).join('|')}`;
  useEffect(() => {
    setActive(enabled[0] ?? -1);
    // `enabled` follows `signature`.
  }, [signature]);

  useEffect(() => {
    if (activeOption === undefined) return;
    document.getElementById(activeOption.id)?.scrollIntoView({ block: 'nearest' });
  }, [activeOption]);

  // Escape steps back out of Switch programme, else closes the palette, and NOTHING ELSE (D-L137 M1):
  // caught in the capture phase and stopped there, so a popover behind never sees it.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (modeRef.current !== 'list') {
        setMode('list');
        setText('');
        inputRef.current?.focus();
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', onEscape, true);
    return () => document.removeEventListener('keydown', onEscape, true);
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (enabled.length === 0) return;
      event.preventDefault();
      const at = enabled.indexOf(active);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = at < 0 ? (step === 1 ? 0 : enabled.length - 1) : (at + step + enabled.length) % enabled.length;
      setActive(enabled[next] ?? -1);
      return;
    }
    if (event.key === 'Enter' && activeOption !== undefined) {
      event.preventDefault();
      activeOption.activate();
      return;
    }
    if (event.key === 'Backspace' && text === '' && mode !== 'list') {
      setMode('list');
    }
  };

  const renderItem = (item: Item) => {
    const id = optionId(item);
    const index = options.findIndex((option) => option.id === id);
    const selected = index === active && !item.disabled;
    const className = `mx-1.5 flex min-h-12 items-center gap-3 rounded-md px-3 py-1.5 text-start ${
      selected ? 'bg-primary-soft' : ''
    } ${item.disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`;
    const body: ReactNode = (
      <>
        <span
          aria-hidden="true"
          className={`flex size-[30px] shrink-0 items-center justify-center rounded-md ${item.disabled ? 'bg-disabled-bg text-disabled-text' : TONE[item.tone]}`}
        >
          <Icon name={item.icon} size={18} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={`truncate text-body-sm font-semibold ${item.disabled ? 'text-disabled-text' : ''}`}>{item.label}</span>
          {item.hint === null ? null : (
            <span className="truncate text-caption font-normal leading-[17px] text-text-2">{item.hint}</span>
          )}
        </span>
        {item.keys.length === 0 ? null : (
          <span aria-hidden="true" className="flex shrink-0 gap-[3px]">
            {item.keys.map((key, keyIndex) => (
              <KeyCap key={keyIndex}>{key}</KeyCap>
            ))}
          </span>
        )}
      </>
    );
    return item.href !== undefined && !item.disabled ? (
      <Link
        key={item.id}
        id={id}
        role="option"
        aria-selected={selected}
        tabIndex={-1}
        href={item.href}
        prefetch={false}
        data-command={item.id}
        onMouseEnter={() => setActive(index)}
        onClick={() => onClose()}
        className={className}
      >
        {body}
      </Link>
    ) : (
      <div
        key={item.id}
        id={id}
        role="option"
        aria-selected={selected}
        aria-disabled={item.disabled || undefined}
        data-command={item.id}
        onMouseEnter={() => {
          if (!item.disabled) setActive(index);
        }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => options[index]?.activate()}
        className={className}
      >
        {body}
      </div>
    );
  };

  const renderSection = (section: Section) => {
    const labelId = `${baseId}-${section.id}-label`;
    return (
      <div key={section.id} role="group" aria-labelledby={labelId} className="flex flex-col pt-1">
        <span id={labelId} role="presentation" className={`flex h-7 items-center px-4.5 ${SECTION_LABEL}`}>
          {t.t(section.label)}
        </span>
        {section.items.map(renderItem)}
      </div>
    );
  };

  const recordQuery = plan.kind === 'search' ? plan.q : '';

  return (
    <CommandDialog open onClose={onClose} label={t.t('search.palette.label')} initialFocus={inputRef} data-testid="command-palette">
      <div className="flex h-[58px] shrink-0 items-center gap-2.5 border-b border-border px-3.5">
        {mode === 'list' ? (
          <Icon name="bolt" size={22} className="text-text-muted" />
        ) : (
          <button
            type="button"
            title={t.t('search.switch.back')}
            aria-label={t.t('search.switch.back')}
            onClick={() => {
              setMode('list');
              setText('');
              inputRef.current?.focus();
            }}
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] bg-primary-soft pe-2.5 ps-1.5 text-meta font-bold text-primary-text ${FOCUS}`}
          >
            <Icon name="arrow_back" size={18} className="rtl:-scale-x-100" />
            <Icon name="swap_horiz" size={18} />
            {t.t('search.switch.chip')}
          </button>
        )}
        <input
          ref={inputRef}
          data-testid="search-input"
          type="text"
          role="combobox"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={text}
          aria-label={t.t(mode === 'list' ? 'search.palette.placeholder' : 'search.switch.placeholder')}
          placeholder={t.t(mode === 'list' ? 'search.palette.placeholder' : 'search.switch.placeholder')}
          aria-autocomplete="list"
          aria-expanded={options.length > 0}
          aria-controls={options.length > 0 ? listboxId : undefined}
          aria-activedescendant={activeOption?.id}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent text-body-md text-text outline-none placeholder:text-text-muted"
        />
        <button
          type="button"
          aria-label={t.t('search.palette.close')}
          onClick={onClose}
          className={`inline-flex h-6 shrink-0 items-center justify-center rounded-sm border border-border bg-surface-sunken px-1.5 font-mono text-micro font-semibold text-text-2 ${FOCUS}`}
        >
          {t.t('design.components.kbd.escape')}
        </button>
      </div>

      {/* The rows scroll, and their links are not tab stops (the input owns them): the region itself is one, so a
          keyboard can scroll it (axe scrollable-region-focusable, T-0148). */}
      <div
        role="region"
        aria-label={t.t('search.palette.label')}
        tabIndex={0}
        className={`min-h-0 flex-1 overflow-y-auto pb-2 pt-1.5 ${FOCUS} focus-visible:ring-inset`}
      >
        {mode === 'switch' ? (
          <SwitchStep t={t} programmes={programmes} filter={folded(text)} />
        ) : (
          <>
            {plan.kind === 'keepTyping' ? <PhoneStrip t={t} typing /> : null}
            {state.kind === 'invalid' ? <InvalidStrip t={t} field={state.field} /> : null}
            {options.length > 0 ? (
              <div role="listbox" id={listboxId} aria-label={t.t('search.palette.label')} className="flex flex-col">
                {sections.map(renderSection)}
                {groups.map((group) => {
                  const labelId = `${baseId}-${group.type}-label`;
                  return (
                    <div key={group.type} role="group" aria-labelledby={labelId} data-group={group.type} className="flex flex-col pt-1">
                      <span id={labelId} role="presentation" className={`flex h-7 items-center px-4.5 ${SECTION_LABEL}`}>
                        {t.t(groupLabel(group.type))}
                      </span>
                      {rows
                        .filter((row) => row.type === group.type)
                        .map((row) => (
                          <RecordOption
                            key={row.id}
                            row={row}
                            t={t}
                            query={recordQuery}
                            selected={activeOption?.id === row.id}
                            onHover={() => setActive(options.findIndex((option) => option.id === row.id))}
                            onOpen={onClose}
                          />
                        ))}
                    </div>
                  );
                })}
              </div>
            ) : null}
            {typed ? (
              <div role="status" aria-live="polite">
                {state.kind === 'loading' ? <LoadingRows t={t} /> : null}
                {state.kind === 'results' && rows.length === 0 && sections.length === 0 ? (
                  <NoMatches t={t} query={text.trim()} lookup={plan.kind === 'lookup'} />
                ) : null}
                {state.kind === 'results' && rows.length > 0 ? (
                  <span data-search-announcement="" className="sr-only">
                    {t.t('search.results.count', { count: rows.length })}
                  </span>
                ) : null}
              </div>
            ) : null}
            {typed && state.kind === 'error' ? <SearchError error={state.error} t={t} onRetry={retry} /> : null}
            {aiSection === null ? null : (
              <div role="listbox" aria-label={t.t('search.palette.ai')} className="flex flex-col">
                {renderSection(aiSection)}
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3.5 border-t border-border bg-surface-sunken px-3.5 py-2 text-caption font-normal text-text-muted">
        <KeyHint onSunken keyLabel={KEYS.move} label={t.t('search.footer.move')} />
        <KeyHint onSunken keyLabel={KEYS.enter} label={t.t('search.footer.run')} />
        {ai ? <KeyHint onSunken keyLabel={KEYS.question} label={t.t('search.footer.askAi')} /> : null}
        <span className="flex-1" />
        {scope ? (
          <span className="hidden items-center gap-1 whitespace-nowrap font-semibold text-text-2 sm:inline-flex">
            <Icon name="badge" size={16} />
            {t.t('search.scope.all')}
          </span>
        ) : null}
      </div>
    </CommandDialog>
  );
}

/** A record row in the palette (D1): the 30px tile of its type, the highlighted name and its details. */
function RecordOption({
  row,
  t,
  query,
  selected,
  onHover,
  onOpen,
}: {
  row: SearchRow;
  t: Translator;
  query: string;
  selected: boolean;
  onHover: () => void;
  onOpen: () => void;
}) {
  const className = `mx-1.5 flex min-h-12 min-w-0 items-center gap-3 rounded-md px-3 py-1.5 text-start ${selected ? 'bg-primary-soft' : ''}`;
  const body = (
    <>
      <span className="flex size-[30px] shrink-0 items-center justify-center [&>span]:size-[30px]">
        <TypeTile type={row.type} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 text-body-sm font-semibold">
          <RowName row={row} query={query} t={t} />
        </span>
        {row.detail === null ? null : (
          <span data-field="company" data-record-text="" className="truncate text-caption font-normal leading-[17px] text-text-2">
            {row.detail}
          </span>
        )}
      </span>
      {row.status === null ? null : <StatusPill status={row.status} t={t} />}
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
      onClick={onOpen}
      onMouseEnter={onHover}
      data-hit={row.hit.id}
      data-hit-type={row.type}
      className={className}
    >
      {body}
    </Link>
  );
}

/**
 * Switch programme (P27 D2), behind `programme_scope_search`: YOUR
 * PROGRAMMES with their initials tiles, from the session's own list. Each is
 * drawn disabled with no "Current" pill: search and lists already cover every
 * programme the caller is assigned to, and switching is not served (D-L87).
 */
function SwitchStep({ t, programmes, filter }: { t: Translator; programmes: readonly MyProgramme[] | null; filter: string }) {
  const shown = (programmes ?? []).filter((programme) => folded(programme.name).includes(filter));
  return (
    <div data-testid="switch-programme" className="flex flex-col">
      <span className={`flex h-7 items-center px-4.5 pt-1 ${SECTION_LABEL}`}>{t.t('search.switch.title')}</span>
      {programmes === null ? <LoadingRows t={t} /> : null}
      {programmes !== null && shown.length === 0 ? (
        <span className="px-4.5 py-2 text-meta text-text-2">{t.t('search.switch.empty')}</span>
      ) : null}
      {shown.map((programme) => (
        <div
          key={programme.id}
          aria-disabled="true"
          className="mx-1.5 flex min-h-[60px] cursor-not-allowed items-center gap-3 rounded-md px-3 py-2"
        >
          <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-soft text-meta font-extrabold text-primary-text">
            {initialsOf(programme.name)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <b data-record-text="" className="truncate text-body-sm font-bold">
              {programme.name}
            </b>
            <span title={t.t('search.scope.narrowUnavailable')} className="text-caption font-normal leading-[17px] text-text-2">
              {t.t('search.cmd.unavailable')}
            </span>
          </span>
        </div>
      ))}
      <span className="flex gap-2 px-4.5 pb-1 pt-3 text-caption font-normal leading-[17px] text-text-2">
        <Icon name="info" size={16} className="shrink-0" />
        {t.t('search.switch.note')}
      </span>
    </div>
  );
}

/** Two letters for a programme tile ("Paygo Wallet" -> "PW"): the first letter of the first two words. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/u).filter((word) => word !== '');
  return words
    .slice(0, 2)
    .map((word) => [...word][0] ?? '')
    .join('')
    .toLocaleUpperCase();
}

// Keep the rail's order for anyone reading the Go to rows against it.
export const PALETTE_NAV_ORDER = CRM_NAV.map((entry) => entry.id);
