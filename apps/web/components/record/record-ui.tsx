'use client';

import Link from 'next/link';
import { useId, useState, type ReactNode } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Button, Menu, MenuItem, SegmentedControl, Tabs, type DataAttributes } from '@kasuwa/ui/components';
import { Icon } from '../icon';

/**
 * The P05 record frame (T-0134, D-L193), shared by the contact and the
 * account: the card, the breadcrumb, the header chips, the action bar with
 * its More menu, the collapsible details groups and the three-column layout
 * that becomes Insights | Details at 1024 and tabs at 360. Values from the
 * export (`docs/design/P05`): cards 12px radius with a 1px border, 20px
 * column gaps, 300 / fluid / 340 at 1440, fluid / 320 at 1024.
 *
 * ONE DOM AT EVERY WIDTH. Each block renders once and the grid moves it:
 * the e2e hooks (`record-details`, `[data-field]`, the timeline) exist once,
 * and CSS alone decides what a width shows. Nothing is duplicated to be
 * shown at another breakpoint.
 */

/** A record card: surface, 1px border, 12px radius. Padding is the caller's: the export varies it per card. */
export const CARD = 'flex min-w-0 flex-col rounded-lg border border-border bg-surface';

/** A card title: 16/24/700. */
export const CARD_TITLE = 'text-card-title';

/**
 * The record header's button size: 44px tall like every Button, but the
 * export's 14/600 label, 20px glyph and 14px padding (the library's default
 * is 15/600 with a 22px glyph). Icon-only, and full width, below `md`.
 */
export const ACTION_SIZE = '!text-body-sm !font-semibold [&_.k-icon]:text-icon-20 max-md:!px-0 md:!px-3.5';

/** Caps group label, 12/700 with 0.05em tracking, as the export's "What's happened" and "Contact info". */
export const CAPS = 'text-caption font-bold uppercase tracking-wider';

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

export function RecordBreadcrumb({ t, href, list, current }: { t: Translator; href: string; list: string; current: ReactNode }) {
  return (
    <nav aria-label={t.t('record.breadcrumb')} className="max-md:hidden">
      <ol className="flex flex-wrap items-center gap-1 text-meta">
        <li className="inline-flex items-center gap-1">
          <Link
            href={href}
            prefetch={false}
            className="rounded-sm text-primary-text underline underline-offset-2 focus-visible:outline-none focus-visible:ring-focus"
          >
            {list}
          </Link>
          <Icon name="chevron_right" size={16} className="text-text-muted rtl:-scale-x-100" />
        </li>
        <li aria-current="page" className="min-w-0 break-words font-bold">
          {current}
        </li>
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Header chips and badges
// ---------------------------------------------------------------------------

export type ChipTone = 'neutral' | 'success' | 'danger' | 'warning' | 'primary' | 'info';

const CHIP_TONE: Record<ChipTone, string> = {
  neutral: 'bg-surface-sunken text-text-2',
  success: 'bg-success-soft text-success-text',
  danger: 'bg-danger-soft text-danger-text',
  warning: 'bg-warning-soft text-warning-text',
  primary: 'bg-primary-soft text-primary-text',
  info: 'bg-info-soft text-info-text',
};

/** The header's status chips: 26px, 12/600, a 15px glyph, so a state never relies on colour alone. */
export function HeaderChip({ tone, icon, lang, children }: { tone: ChipTone; icon: IconName; lang?: string; children: ReactNode }) {
  return (
    <span
      lang={lang}
      className={`inline-flex h-6.5 items-center gap-1 whitespace-nowrap rounded-full px-2.25 text-caption font-semibold ${CHIP_TONE[tone]}`}
    >
      <Icon name={icon} size={15} />
      {children}
    </span>
  );
}

/** A small status pill inside a card: 11/700, 2px 8px. */
export function MiniPill({ tone, dashed = false, children }: { tone: ChipTone; dashed?: boolean; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-micro ${
        dashed ? 'border border-dashed border-border-strong text-text-2' : CHIP_TONE[tone]
      }`}
    >
      {children}
    </span>
  );
}

/** The badge after the record's name ("VIP", "Gold"): 12/700 on primary, 4px radius. */
export function NameBadge({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded-sm bg-primary px-2.25 py-0.75 text-caption font-bold text-on-primary">{children}</span>;
}

// ---------------------------------------------------------------------------
// The action bar
// ---------------------------------------------------------------------------

export interface MenuEntry {
  readonly key: string;
  readonly icon: IconName;
  readonly label: string;
  readonly disabled?: boolean | undefined;
  readonly onSelect: () => void;
  readonly attributes?: DataAttributes;
}

export interface RecordAction {
  readonly key: string;
  readonly icon: IconName;
  readonly label: string;
  readonly primary?: boolean;
  readonly disabled?: boolean;
  /** Why a placeholder action is off (D-L194), as its tooltip. */
  readonly title?: string;
  readonly onClick?: () => void;
  /** An action that opens a menu ("Log activity"): in the More menu its entries are listed in its place. */
  readonly menu?: readonly MenuEntry[];
  readonly attributes?: DataAttributes;
}

/**
 * Where each action sits, by position. The export keeps four icon-only
 * buttons at 360, five labelled ones at 1024, and everything at 1440; the
 * rest go in More. Literal class strings, so Tailwind sees them.
 */
function inlineClass(index: number): string {
  if (index < 4) return 'inline-flex';
  if (index === 4) return 'hidden md:inline-flex';
  return 'hidden xl:inline-flex';
}

function moreEntryClass(index: number): string {
  return index === 4 ? 'md:hidden' : '';
}

function moreButtonClass(count: number): string | null {
  if (count <= 4) return null;
  return count === 5 ? 'md:hidden' : 'xl:hidden';
}

function MenuEntries({ entries }: { entries: readonly (MenuEntry & { className?: string })[] }) {
  return (
    <>
      {entries.map((entry) => (
        <MenuItem key={entry.key} icon={entry.icon} disabled={entry.disabled} onSelect={entry.onSelect} className={entry.className} {...entry.attributes}>
          {entry.label}
        </MenuItem>
      ))}
    </>
  );
}

function MenuAction({ action, className }: { action: RecordAction; className: string }) {
  return (
    <Menu
      aria-label={action.label}
      className={`${className} max-md:flex-1`}
      trigger={(props) => (
        <Button {...props} icon={action.icon} disabled={action.disabled} title={action.title} className={`w-full ${ACTION_SIZE}`} {...action.attributes}>
          <span className="max-md:sr-only">{action.label}</span>
        </Button>
      )}
    >
      <MenuEntries entries={action.menu ?? []} />
    </Menu>
  );
}

/**
 * The header's action row: the primary action filled, the rest outlined,
 * icon-only at 360. `extra` (the P10 start control) follows the actions.
 */
export function ActionBar({ t, actions, extra }: { t: Translator; actions: readonly RecordAction[]; extra?: ReactNode }) {
  const moreClass = moreButtonClass(actions.length);
  const overflow = actions.flatMap((action, index) => {
    if (index < 4) return [];
    const className = moreEntryClass(index);
    if (action.menu !== undefined) return action.menu.map((entry) => ({ ...entry, className }));
    return [
      {
        key: action.key,
        icon: action.icon,
        label: action.label,
        disabled: action.disabled,
        onSelect: () => action.onClick?.(),
        className,
      },
    ];
  });

  return (
    <div role="group" aria-label={t.t('record.actions')} className="flex flex-wrap gap-2 border-t border-border pt-3">
      {actions.map((action, index) =>
        action.menu !== undefined ? (
          <MenuAction key={action.key} action={action} className={inlineClass(index)} />
        ) : (
          <Button
            key={action.key}
            variant={action.primary === true ? 'primary' : 'secondary'}
            icon={action.icon}
            disabled={action.disabled}
            title={action.title ?? action.label}
            onClick={action.onClick}
            className={`${inlineClass(index)} max-md:flex-1 ${ACTION_SIZE}`}
            {...action.attributes}
          >
            <span className="max-md:sr-only">{action.label}</span>
          </Button>
        ),
      )}
      {moreClass === null ? null : (
        <Menu
          aria-label={t.t('record.action.moreLabel')}
          align="end"
          className={`${moreClass} max-md:flex-1`}
          trigger={(props) => (
            <Button {...props} icon="more_horiz" aria-label={t.t('record.action.moreLabel')} title={t.t('record.action.more')} className={`w-full ${ACTION_SIZE}`}>
              <span aria-hidden="true" className="max-md:sr-only">
                {t.t('record.action.more')}
              </span>
            </Button>
          )}
        >
          <MenuEntries entries={overflow} />
        </Menu>
      )}
      {/* The P10 start control: on its own row at 360, after the icon-only actions. */}
      {extra === undefined || extra === null ? null : <div className="flex flex-wrap gap-2 max-md:basis-full">{extra}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The phone app bar's trailing actions
// ---------------------------------------------------------------------------

const BAR_ICON = 'flex size-control-lg shrink-0 items-center justify-center rounded-md text-text is-hover:bg-surface-sunken outline-none focus-visible:ring-focus';

/**
 * P05 at 360: the app bar's search and kebab (the shell draws the back
 * arrow and the title). The kebab holds the record's own entries.
 */
export function RecordAppBarActions({ t, search, entries }: { t: Translator; search: boolean; entries: readonly MenuEntry[] }) {
  return (
    <>
      {search ? (
        <Link href="/search" prefetch={false} aria-label={t.t('search.title')} className={BAR_ICON}>
          <Icon name="search" size={24} />
        </Link>
      ) : null}
      {entries.length === 0 ? null : (
        <Menu
          aria-label={t.t('record.appBar.more')}
          align="end"
          trigger={(props) => (
            <button {...props} type="button" aria-label={t.t('record.appBar.more')} className={BAR_ICON}>
              <Icon name="more_vert" size={24} />
            </button>
          )}
        >
          <MenuEntries entries={entries} />
        </Menu>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Details groups
// ---------------------------------------------------------------------------

/** A collapsible group of the Details card: a 44px sunken caps header with a chevron. */
export function DetailGroup({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const body = useId();
  return (
    <div className="flex flex-col border-b border-border last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => setOpen((value) => !value)}
        className={`flex min-h-touch items-center gap-1.5 bg-surface-sunken px-3.5 text-start text-text-2 focus-visible:outline-none focus-visible:ring-focus ${CAPS}`}
      >
        <span className="flex-1">{title}</span>
        <Icon name={open ? 'expand_less' : 'expand_more'} size={18} />
      </button>
      <dl id={body} hidden={!open} className="flex flex-col px-3.5 pb-2.5 pt-1">
        {children}
      </dl>
    </div>
  );
}

/**
 * One detail: a 12/600 muted label over the value, and the design's pencil
 * where the field is edited. The pencil opens the full edit (the one write
 * path the contract has for these fields), so it carries the screen's
 * `data-action` and needs a connection.
 */
export function DetailRow({
  field,
  label,
  locked,
  mono = false,
  edit,
  children,
}: {
  field?: string;
  label: ReactNode;
  locked?: boolean;
  mono?: boolean;
  edit?: { readonly label: string; readonly action: string; readonly disabled: boolean; readonly onClick: () => void } | undefined;
  children: ReactNode;
}) {
  return (
    <div
      data-field={field}
      data-locked={locked === true ? 'true' : undefined}
      className="flex min-w-0 flex-col gap-0.5 border-b border-border py-2 last:border-b-0"
    >
      <dt className="flex items-center gap-1.5 text-caption font-semibold text-text-muted">{label}</dt>
      <dd className="flex min-h-7 min-w-0 items-center gap-1.5">
        <span className={`min-w-0 flex-1 break-words text-body-sm ${mono ? 'font-mono' : ''}`}>{children}</span>
        {edit === undefined || locked === true ? null : (
          <button
            type="button"
            data-action={edit.action}
            data-requires-connection=""
            aria-haspopup="dialog"
            aria-label={edit.label}
            title={edit.label}
            disabled={edit.disabled}
            onClick={edit.onClick}
            className="-my-1 -me-1.5 flex size-8 shrink-0 items-center justify-center rounded-6 text-text-muted is-hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-focus disabled:text-disabled-text"
          >
            <Icon name="edit" size={18} />
          </button>
        )}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------

export type Pane = 'insights' | 'details';

export interface CentreBlock {
  /** The 360 tab that shows this block ("activity", "contacts"). */
  readonly tab: string;
  readonly node: ReactNode;
}

/**
 * 1440: details / centre / insights at 300 / fluid / 340. 1024: the centre,
 * and a 320px column switched between Insights and Details. 360: tabs, one
 * section at a time. Without an insights column (every block in it flagged
 * off, D-L194) the record is two columns and the switch is not drawn.
 */
export function RecordLayout({
  t,
  tabs,
  tab,
  onTab,
  pane,
  onPane,
  left,
  centre,
  right,
}: {
  t: Translator;
  tabs: readonly { readonly value: string; readonly label: string }[];
  tab: string;
  onTab: (tab: string) => void;
  pane: Pane;
  onPane: (pane: Pane) => void;
  left: ReactNode;
  centre: readonly CentreBlock[];
  right: ReactNode | null;
}) {
  const hasRight = right !== null;
  const leftClass = [
    tab === 'details' ? 'flex' : 'hidden',
    !hasRight || pane === 'details' ? 'lg:flex' : 'lg:hidden',
    'xl:flex',
    hasRight ? 'lg:col-start-2 lg:row-start-2' : 'lg:col-start-2 lg:row-start-1',
    'xl:col-start-1 xl:row-start-1',
  ].join(' ');
  const rightClass = [
    tab === 'insights' ? 'flex' : 'hidden',
    pane === 'insights' ? 'lg:flex' : 'lg:hidden',
    'xl:flex lg:col-start-2 lg:row-start-2 xl:col-start-3 xl:row-start-1',
  ].join(' ');
  const centreShown = centre.some((block) => block.tab === tab);

  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-5">
      <Tabs
        aria-label={t.t('record.sections')}
        items={tabs.map((item) => ({ value: item.value, label: item.label }))}
        value={tab}
        onValueChange={onTab}
        className="overflow-x-auto bg-surface lg:hidden [&>button]:flex-1"
      />
      <div
        className={`grid min-w-0 items-start gap-3 lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[auto_1fr] lg:gap-5 xl:grid-rows-none ${
          hasRight ? 'xl:grid-cols-[300px_minmax(0,1fr)_340px]' : 'xl:grid-cols-[300px_minmax(0,1fr)]'
        }`}
      >
        <div
          className={`${centreShown ? 'flex' : 'hidden'} min-w-0 flex-col gap-4 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:flex xl:col-start-2 xl:row-span-1 xl:row-start-1`}
        >
          {centre.map((block) => (
            <div key={block.tab} className={`${block.tab === tab ? 'flex' : 'hidden'} min-w-0 flex-col gap-4 lg:flex`}>
              {block.node}
            </div>
          ))}
        </div>
        {hasRight ? (
          <div className="hidden min-w-0 lg:col-start-2 lg:row-start-1 lg:block xl:hidden">
            <SegmentedControl
              aria-label={t.t('record.sections')}
              options={[
                { value: 'insights', label: t.t('record.section.insights') },
                { value: 'details', label: t.t('record.section.details') },
              ]}
              value={pane}
              onValueChange={(value) => onPane(value === 'details' ? 'details' : 'insights')}
              className="flex w-full rounded-10 p-1 [&>button]:h-control-md [&>button]:flex-1 [&>button]:text-body-sm"
            />
          </div>
        ) : null}
        <div className={`${leftClass} min-w-0 flex-col gap-4`}>{left}</div>
        {hasRight ? <div className={`${rightClass} min-w-0 flex-col gap-4`}>{right}</div> : null}
      </div>
    </div>
  );
}
