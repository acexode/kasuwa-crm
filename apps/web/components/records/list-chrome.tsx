'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { SegmentedControl, type SegmentedOption } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { Emphasis } from '../auth/rich-text';
import { LineParts } from './list-table';
import type { MyProgramme } from '../../lib/my-programmes-api';
import {
  FOCUS,
  HEADER_BUTTON,
  HEADER_PRIMARY,
  MENU_LABEL,
  P04_MENU,
  P04_MENU_ROW,
  TOOL_BUTTON,
} from './list-classes';

/**
 * The chrome every P04 list draws the same way (T-0133, D-L193): the page
 * header — a 28/800 title, a count chip, the programme pill, the saved-views
 * menu, the view switcher, Import / export and the primary action — and its
 * phone counterpart, the title block with the bookmark and overflow buttons.
 *
 * WHAT IS NOT DRAWN, AND WHY.
 *   - The count chip never holds an exact total (D-P13, D-L195): it says how
 *     many rows are held and that there are more ("25+"), or it is not drawn.
 *   - The programme pill is not a switcher: scope is the session's, and a
 *     control that sent a programme would be a client choosing its own scope
 *     (CLAUDE.md 2.2). It names the caller's programmes and nothing else.
 *   - Saved views, the Map segment and anything else with no backend is behind
 *     its own flag and drawn in the design's disabled state (D-L194).
 */

// ---------------------------------------------------------------------------
// Dismissing a menu
// ---------------------------------------------------------------------------

/** Escape and a press outside close an open menu; Escape gives focus back to its trigger. */
export function useMenu(): {
  open: boolean;
  toggle: () => void;
  close: (returnFocus: boolean) => void;
  panelRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
} {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true);
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (panelRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open, close]);
  return { open, toggle: () => setOpen((current) => !current), close, panelRef, triggerRef };
}

// ---------------------------------------------------------------------------
// The title, its count and the programme
// ---------------------------------------------------------------------------

/**
 * "25+": the rows held and that more exist. Never a total (D-P13): with no
 * more to read, the chip is not drawn rather than drawn exact.
 */
export function heldCount(locale: string, held: number, more: boolean): string | null {
  if (!more || held === 0) return null;
  return `${new Intl.NumberFormat(locale).format(held)}+`;
}

/** The mono count chip beside the title: 13/600, 3px 8px, radius 6, sunken. Outside the h1, so the heading holds no number. */
export function CountChip({ t, count }: { t: Translator; count: string | null }) {
  if (count === null) return null;
  return (
    <span
      data-testid="list-count"
      className="rounded-6 bg-surface-sunken px-2 py-0.75 font-mono text-meta font-semibold text-text-2"
    >
      <span aria-hidden="true">{count}</span>
      {/*
        The spoken sentence is in the sans face: it is never seen (sr-only),
        but a browser still downloads a font for every character it lays out,
        and in mono its letters cost the 5 KB lowercase face on every list
        (T-0145). The visible figures stay in mono.
      */}
      <span className="sr-only font-sans">{t.t('records.count.more', { count })}</span>
    </span>
  );
}

/**
 * The caller's programme names, each its own `data-record-text` (served by
 * `/me/programmes`), with the comma between them left as plain text: one
 * joined string would not be a served value (T-0150).
 */
function programmeNames(programmes: readonly MyProgramme[] | null): ReactNode | null {
  if (programmes === null || programmes.length === 0) return null;
  return <LineParts parts={programmes.map((programme) => ({ text: programme.name, record: true }))} separator=", " />;
}

/**
 * The programme pill (P04 "Contacts · BPO programme"): accent edge on
 * accent-soft, 32px, 13/700, a `work` glyph. It names the caller's own
 * programmes. Not a switcher (CLAUDE.md 2.2), so it carries no chevron.
 * Until the names are read it says only that the list is programme-scoped.
 */
export function ProgrammePill({
  t,
  programmes,
  compact = false,
}: {
  t: Translator;
  programmes: readonly MyProgramme[] | null;
  compact?: boolean;
}) {
  const names = programmeNames(programmes);
  return (
    <span
      data-testid="programme-chip"
      className={`inline-flex min-w-0 max-w-full items-center rounded-full border border-accent bg-accent-soft font-bold text-accent-text ${
        compact ? 'h-7 gap-1.5 self-start px-2.5 text-caption' : 'h-8 gap-1.5 pe-3 ps-2.5 text-meta'
      }`}
    >
      <Icon name="work" size={compact ? 15 : 16} />
      <span className="truncate">
        {names === null ? (
          t.t('records.programme.chip')
        ) : (
          // The sentence is copy and the names are record data: the names go
          // back into the translated sentence at the catalogue's own position.
          <Emphasis
            sentence={(slot) => t.t(programmes?.length === 1 ? 'records.programme.one' : 'records.programme.many', { names: slot })}
            values={[names]}
          />
        )}
      </span>
    </span>
  );
}

/** The scope line under the header: a lock, then which programme's records these are. */
export function ScopeLine({
  t,
  programmes,
  compact = false,
}: {
  t: Translator;
  programmes: readonly MyProgramme[] | null;
  compact?: boolean;
}) {
  const names = programmeNames(programmes);
  return (
    <p
      data-testid="programme-scope"
      className={`flex items-center gap-1.5 text-text-2 ${compact ? 'text-caption' : 'text-meta'}`}
    >
      <Icon name="lock" size={compact ? 14 : 16} className="text-text-muted" />
      <span>
        {compact || names === null ? (
          t.t(compact ? 'records.scope.short' : 'records.scope.generic')
        ) : (
          <>
            {t.t('records.scope.only')}{' '}
            <b className="text-text">{names}</b>{' '}
            {t.t('records.scope.rest')}
          </>
        )}
      </span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Saved views (D-L194: `saved_views`; no backend, one built-in view)
// ---------------------------------------------------------------------------

export function SavedViews({ t, allLabel, unsaved }: { t: Translator; allLabel: MessageId; unsaved: boolean }) {
  const menu = useMenu();
  const id = useId();
  return (
    <div className="relative">
      <button
        ref={menu.triggerRef}
        type="button"
        data-testid="saved-views"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.open ? id : undefined}
        onClick={menu.toggle}
        className={`${TOOL_BUTTON} pe-2 ps-3`}
      >
        <Icon name="bookmark" size={18} className="text-text-2" />
        {t.t(unsaved ? 'records.views.unsaved' : allLabel)}
        <Icon name="expand_more" size={18} />
      </button>
      {menu.open ? (
        <div id={id} ref={menu.panelRef} role="menu" className={`absolute start-0 top-full mt-1.5 w-72 ${P04_MENU}`}>
          <p className={MENU_LABEL}>{t.t('records.views.title')}</p>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!unsaved}
            onClick={() => menu.close(true)}
            className={`${P04_MENU_ROW} ${unsaved ? '' : 'bg-primary-soft font-semibold'}`}
          >
            <span className="flex w-4.5 justify-center text-primary-text">
              {unsaved ? null : <Icon name="check" size={18} />}
            </span>
            <span className="flex-1">{t.t(allLabel)}</span>
          </button>
          <span role="separator" className="my-1.5 block h-px bg-border" />
          <button
            type="button"
            role="menuitem"
            disabled
            title={t.t('records.action.unavailable')}
            className={`${P04_MENU_ROW} font-semibold text-primary-text`}
          >
            <Icon name="bookmark_add" size={18} />
            {t.t('records.views.save')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The view switcher
// ---------------------------------------------------------------------------

export type ListView = 'table' | 'kanban' | 'map' | 'split';

const VIEW_ICON: Record<ListView, IconName> = {
  table: 'table_rows',
  kanban: 'view_kanban',
  map: 'map',
  split: 'vertical_split',
};

const VIEW_LABEL: Record<ListView, MessageId> = {
  table: 'records.view.table',
  kanban: 'records.view.kanban',
  map: 'records.view.map',
  split: 'records.view.split',
};

/**
 * Table / Kanban / Map / Split view (P04). A view this list has built carries
 * `data-view-option`; one it has not is drawn disabled and named
 * `data-view-unavailable`, with the reason read out. Map is shown only where
 * `map_view` is on (D-L195), and is always disabled: the Map view is 501.
 */
export function ViewSwitcher({
  t,
  value,
  built,
  mapView,
  onChange,
}: {
  t: Translator;
  value: ListView;
  built: readonly ListView[];
  mapView: boolean;
  onChange: (view: ListView) => void;
}) {
  const views: ListView[] = ['table', 'kanban', ...(mapView ? (['map'] as const) : []), 'split'];
  const options: SegmentedOption[] = views.map((view) => {
    const live = built.includes(view);
    return {
      value: view,
      icon: VIEW_ICON[view],
      disabled: !live,
      label: (
        <>
          {t.t(VIEW_LABEL[view])}
          {live ? null : <span className="sr-only">{t.t('records.action.unavailable')}</span>}
        </>
      ),
      attributes: live ? { 'data-view-option': view } : { 'data-view-unavailable': view },
    };
  });
  return (
    <SegmentedControl
      aria-label={t.t('leads.view.label')}
      options={options}
      value={value}
      onValueChange={(next) => onChange(next as ListView)}
      className="hidden shrink-0 rounded-10 md:inline-flex"
    />
  );
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

export interface MenuLink {
  readonly kind: 'link';
  readonly href: string;
  readonly action: string;
  readonly icon: IconName;
  readonly label: MessageId;
}

export interface MenuUnavailable {
  readonly kind: 'unavailable';
  readonly action: string;
  readonly icon: IconName;
  readonly label: MessageId;
}

export type MenuItem = MenuLink | MenuUnavailable;

function MenuItems({ t, items, offline, onPick }: { t: Translator; items: readonly MenuItem[]; offline: boolean; onPick: () => void }) {
  return (
    <>
      {items.map((item) =>
        item.kind === 'link' ? (
          <Link
            key={item.action}
            role="menuitem"
            href={item.href}
            prefetch={false}
            data-action={item.action}
            data-requires-connection=""
            aria-disabled={offline ? 'true' : undefined}
            onClick={(event) => {
              if (offline) event.preventDefault();
              else onPick();
            }}
            className={`${P04_MENU_ROW} ${offline ? 'cursor-not-allowed text-disabled-text' : 'text-text'}`}
          >
            <Icon name={item.icon} size={18} className="text-text-2" />
            {t.t(item.label)}
          </Link>
        ) : (
          <button
            key={item.action}
            type="button"
            role="menuitem"
            data-action={item.action}
            data-requires-connection=""
            disabled
            title={t.t('records.action.unavailable')}
            className={P04_MENU_ROW}
          >
            <Icon name={item.icon} size={18} />
            {t.t(item.label)}
            <span className="sr-only">{t.t('records.action.unavailable')}</span>
          </button>
        ),
      )}
    </>
  );
}

/** "Import / export ▾": a 40px outlined menu button (P04). */
export function ImportExportMenu({ t, items, offline }: { t: Translator; items: readonly MenuItem[]; offline: boolean }) {
  const menu = useMenu();
  const id = useId();
  return (
    <div className="relative hidden md:block">
      <button
        ref={menu.triggerRef}
        type="button"
        data-testid="import-export"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.open ? id : undefined}
        onClick={menu.toggle}
        className={HEADER_BUTTON}
      >
        <Icon name="import_export" size={20} />
        {t.t('records.importExport')}
        <Icon name="expand_more" size={18} />
      </button>
      {menu.open ? (
        <div id={id} ref={menu.panelRef} role="menu" className={`absolute end-0 top-full mt-1.5 w-64 ${P04_MENU}`}>
          <MenuItems t={t} items={items} offline={offline} onPick={() => menu.close(false)} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The primary action ("New lead"). `onClick` absent means the create flow is
 * not built: drawn at full fidelity, `aria-disabled`, with the reason as its
 * tooltip and read out — never an opacity fade that reads as broken.
 */
export function NewButton({
  t,
  label,
  action,
  offline,
  onClick,
}: {
  t: Translator;
  label: MessageId;
  action: string;
  offline: boolean;
  onClick?: () => void;
}) {
  const unavailable = onClick === undefined;
  return (
    <button
      type="button"
      data-action={action}
      data-requires-connection=""
      aria-disabled={unavailable || offline ? 'true' : undefined}
      title={unavailable ? t.t('records.action.unavailable') : undefined}
      onClick={unavailable || offline ? undefined : onClick}
      className={`${HEADER_PRIMARY} aria-disabled:cursor-not-allowed`}
    >
      <Icon name="add" size={20} />
      {t.t(label)}
      {unavailable ? <span className="sr-only">{t.t('records.action.unavailable')}</span> : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The header itself
// ---------------------------------------------------------------------------

export interface HeaderProps {
  readonly t: Translator;
  readonly titleId: MessageId;
  readonly count: string | null;
  readonly programmes: readonly MyProgramme[] | null;
  /** The saved-views menu, where `saved_views` is on; `null` hides it. */
  readonly savedViews: { readonly allLabel: MessageId; readonly unsaved: boolean } | null;
  readonly switcher: ReactNode;
  readonly menuItems: readonly MenuItem[];
  readonly primary: ReactNode;
  readonly offline: boolean;
}

/**
 * The phone app bar's trailing actions (P04 360): the saved-views bookmark,
 * where `saved_views` is on, and the overflow menu (Import / export). The
 * shell draws the bar itself (T-0130, `appBar`); this fills its actions.
 */
export function PhoneBarActions({
  t,
  savedViews,
  menuItems,
  offline,
}: {
  t: Translator;
  savedViews: boolean;
  menuItems: readonly MenuItem[];
  offline: boolean;
}) {
  const overflow = useMenu();
  const overflowId = useId();
  return (
    <>
      {savedViews ? (
        <button
          type="button"
          aria-label={t.t('records.views.title')}
          className={`flex size-12 items-center justify-center rounded-md text-text hover:bg-surface-sunken ${FOCUS}`}
        >
          <Icon name="bookmark" size={24} />
        </button>
      ) : null}
      <div className="relative">
        <button
          ref={overflow.triggerRef}
          type="button"
          aria-label={t.t('records.importExport')}
          aria-haspopup="menu"
          aria-expanded={overflow.open}
          aria-controls={overflow.open ? overflowId : undefined}
          onClick={overflow.toggle}
          className={`flex size-12 items-center justify-center rounded-md text-text hover:bg-surface-sunken ${FOCUS}`}
        >
          <Icon name="more_vert" size={24} />
        </button>
        {overflow.open ? (
          <div id={overflowId} ref={overflow.panelRef} role="menu" className={`absolute end-0 top-full mt-1 w-64 ${P04_MENU}`}>
            <MenuItems t={t} items={menuItems} offline={offline} onPick={() => overflow.close(false)} />
          </div>
        ) : null}
      </div>
    </>
  );
}

/** The phone app bar's subtitle: "All leads · 25+", or "Unsaved view · 25+". */
export function phoneSubtitle(t: Translator, view: MessageId, unsaved: boolean, count: string | null): string {
  const name = t.t(unsaved ? 'records.views.unsaved' : view);
  return count === null ? name : `${name} · ${count}`;
}

/**
 * P04's page header at `md` and up; below `md` the shell's app bar carries
 * the title (`appBar`), and this draws only the programme pill and its line.
 */
export function ListHeader({ t, titleId, count, programmes, savedViews, switcher, menuItems, primary, offline }: HeaderProps) {
  return (
    <>
      <div className="hidden flex-col gap-2 md:flex">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-title">{t.t(titleId)}</h1>
          <CountChip t={t} count={count} />
          <ProgrammePill t={t} programmes={programmes} />
          {savedViews === null ? null : <SavedViews t={t} allLabel={savedViews.allLabel} unsaved={savedViews.unsaved} />}
          <span className="flex-1" />
          {switcher}
          <ImportExportMenu t={t} items={menuItems} offline={offline} />
          {primary}
        </div>
        <ScopeLine t={t} programmes={programmes} />
      </div>

      <div className="-mx-4 -mt-4 flex flex-col gap-1 bg-surface px-4 pt-1 md:hidden">
        <ProgrammePill t={t} programmes={programmes} compact />
        <ScopeLine t={t} programmes={programmes} compact />
      </div>
    </>
  );
}
