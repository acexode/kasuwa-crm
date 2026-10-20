'use client';

import type { ReactNode } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Checkbox, Tag } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { formatPhone, initials } from './list-model';
import { TD, TD_BASE, TH, TH_BASE } from './list-classes';

/**
 * The P04 table's pieces (T-0133, D-L193), measured from the export until
 * T-0129's Table lands: 40px sunken header cells at 12/700, 52px rows with a
 * 1px rule, a 44px selection column and a sticky 260px name column with its
 * right-hand rule, a 32px avatar, a 14/700 name over a 12px muted line, phone
 * numbers in mono with outlined network tags and a danger-soft DND tag, the
 * WA dot, and the owner as a 24px accent-soft avatar beside the name.
 *
 * The table is a real <table> (role=columnheader stays on every header the
 * e2e suites read), `border-separate` so the sticky cells keep their rules
 * while the region scrolls sideways.
 */

export const TABLE = 'w-full min-w-max table-fixed border-separate border-spacing-0 text-body-sm';

/** The selection column: 44px, sticky at the start edge. */
export const SELECT_TH = `${TH_BASE} sticky start-0 z-20 w-11 text-center`;

/** The name column: 260px, sticky after the selection column (or at the edge without it), with its rule. */
export function nameTh(selectable: boolean): string {
  return `${TH} sticky z-20 w-64 border-e ${selectable ? 'start-11' : 'start-0'}`;
}

/** Row cell background: a selected row is primary-soft, hover is sunken; sticky cells need it painted. */
export function rowTone(selected: boolean): string {
  return selected ? 'bg-primary-soft' : 'bg-surface group-hover:bg-surface-sunken';
}

export function cellClass(selected: boolean, extra = ''): string {
  return `${TD} ${rowTone(selected)} overflow-hidden ${extra}`;
}

export function selectTd(selected: boolean): string {
  return `${TD_BASE} ${rowTone(selected)} sticky start-0 z-10 w-11 text-center`;
}

export function nameTd(selected: boolean, selectable: boolean): string {
  return `${TD} ${rowTone(selected)} sticky z-10 border-e font-normal ${selectable ? 'start-11' : 'start-0'}`;
}

/** The header's tri-state "select all on this page". */
export function SelectAll({
  t,
  count,
  selected,
  onChange,
}: {
  t: Translator;
  count: number;
  selected: number;
  onChange: (all: boolean) => void;
}) {
  return (
    <Checkbox
      aria-label={t.t('records.select.page')}
      checked={count > 0 && selected === count}
      indeterminate={selected > 0 && selected < count}
      onChange={(event) => onChange(event.currentTarget.checked)}
      className="mx-auto"
    />
  );
}

export function SelectRow({ t, name, checked, onChange }: { t: Translator; name: string; checked: boolean; onChange: () => void }) {
  return (
    <Checkbox
      aria-label={t.t('records.select.row', { name })}
      checked={checked}
      onChange={onChange}
      className="mx-auto"
    />
  );
}

/** A person's 32px round avatar, or a business's 32px rounded square, in primary-soft-strong (P04). */
export function RecordAvatar({ name, square = false, size = 32 }: { name: string | undefined; square?: boolean; size?: 32 | 44 }) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center bg-primary-soft-strong font-bold text-primary-text ${
        size === 44 ? 'size-touch text-body-sm' : 'size-8 text-caption'
      } ${square ? 'rounded-md' : 'rounded-full'}`}
    >
      {name === undefined ? <Icon name="lock" size={size === 44 ? 20 : 16} /> : initials(name)}
    </span>
  );
}

/** The name cell's content: avatar, a 14/700 name and the muted 12px line under it. */
export function NameBlock({
  t,
  name,
  sub,
  square = false,
}: {
  t: Translator;
  name: string | undefined;
  sub: string | null;
  square?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <RecordAvatar name={name} square={square} />
      <span className="flex min-w-0 flex-col">
        {name === undefined ? (
          <span data-name-withheld="" className="truncate text-body-sm text-text-muted">
            {t.t('records.name.withheld')}
          </span>
        ) : (
          <b data-record-text="" className="truncate text-body-sm font-bold leading-5">
            {name}
          </b>
        )}
        {sub === null || sub === '' ? null : (
          <span data-record-text="" className="truncate text-caption text-text-muted">
            {sub}
          </span>
        )}
      </span>
    </span>
  );
}

/** "via Missed call · Lagos · Ikeja": the readable parts, joined. */
export function subLine(parts: readonly (string | null | undefined)[]): string | null {
  const kept = parts.filter((part): part is string => typeof part === 'string' && part !== '');
  return kept.length === 0 ? null : kept.join(' · ');
}

/** A phone: mono 13px, then the network as an outlined 11/700 tag, then DND in danger-soft. */
export function PhoneValue({
  t,
  e164,
  network,
  dnd,
  more,
  compact = false,
}: {
  t: Translator;
  e164: string;
  network: string | null;
  dnd: boolean;
  more: number;
  compact?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span data-record-text="" dir="ltr" className="whitespace-nowrap font-mono text-meta">
        {formatPhone(e164)}
      </span>
      {network === null ? null : (
        <Tag tone="outline" size="small" data-record-text="" className={compact ? 'h-4.5' : ''}>
          {network}
        </Tag>
      )}
      {dnd ? (
        <Tag tone="danger-soft" size="small" title={t.t('records.dnd.label')}>
          {t.t('records.dnd.badge')}
          <span className="sr-only">{t.t('records.dnd.label')}</span>
        </Tag>
      ) : null}
      {more > 0 ? <span className="text-caption text-text-muted">{t.t('records.more', { count: more })}</span> : null}
    </span>
  );
}

/** The WA column: a 28px success-soft disc with `chat`, or a muted dash. */
export function WaDot({ t, optedIn }: { t: Translator; optedIn: boolean }) {
  return optedIn ? (
    <span
      role="img"
      aria-label={t.t('records.wa.in')}
      title={t.t('records.wa.in')}
      className="mx-auto flex size-7 items-center justify-center rounded-full bg-success-soft text-success-text"
    >
      <Icon name="chat" size={16} />
    </span>
  ) : (
    <span className="flex justify-center text-text-muted">
      <span aria-hidden="true">{'—'}</span>
      <span className="sr-only">{t.t('records.wa.out')}</span>
    </span>
  );
}

/** An owner: a 24px accent-soft initials disc and the name; unassigned is a dashed circle, muted. */
export function OwnerValue({ t, name, former }: { t: Translator; name: string | null; former?: boolean }) {
  if (former === true) {
    return (
      <span data-owner="former" className="flex items-center gap-2 text-meta text-text-muted">
        <span aria-hidden="true" className="size-6 shrink-0 rounded-full border border-dashed border-border-strong" />
        {t.t('records.owner.former')}
      </span>
    );
  }
  if (name === null) {
    return (
      <span className="flex items-center gap-2 text-meta text-text-muted">
        <span aria-hidden="true" className="size-6 shrink-0 rounded-full border-2 border-dashed border-border-strong" />
        {t.t('records.owner.unassigned')}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2 text-meta">
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-micro text-accent-text"
      >
        {initials(name)}
      </span>
      <span data-record-text="" className="truncate">
        {name}
      </span>
    </span>
  );
}

/** Last activity (D-L194, `last_activity`): no list read serves it, so the design's empty dash. */
export function LastActivityEmpty({ t }: { t: Translator }) {
  return (
    <span className="text-meta text-text-muted">
      <span aria-hidden="true">{'—'}</span>
      <span className="sr-only">{t.t('records.lastActivity.none')}</span>
    </span>
  );
}

/** A header cell's content with its optional lock and edit glyphs. */
export function HeaderLabel({ t, label, locked, children }: { t: Translator; label: MessageId; locked: boolean; children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      {t.t(label)}
      {locked ? (
        <>
          <Icon name="lock" size={14} className="text-text-muted" />
          <span className="sr-only">{t.t('records.locked.header')}</span>
        </>
      ) : null}
      {children}
    </span>
  );
}

/** Tags as 22px sunken squares, two shown and "+n". */
export function TagList({ tags }: { t?: Translator; tags: readonly string[] }) {
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {tags.slice(0, 2).map((tag) => (
        <span
          key={tag}
          data-record-text=""
          className="inline-flex items-center whitespace-nowrap rounded-sm bg-surface-sunken px-2 py-0.75 text-caption font-semibold text-text-2"
        >
          {tag}
        </span>
      ))}
      {tags.length > 2 ? <span className="text-caption font-semibold text-text-muted">{`+${tags.length - 2}`}</span> : null}
    </span>
  );
}

/** The status pill: 12/700, radius 999, a word on its soft fill (P04). */
export const STATUS_TONE: Readonly<Record<string, string>> = {
  new: 'bg-info-soft text-info-text',
  contacted: 'bg-primary-soft text-primary-text',
  qualified: 'bg-success-soft text-success-text',
  unqualified: 'bg-surface-sunken text-text-2',
  customer: 'bg-accent-soft text-accent-text',
};

export function StatusWord({ label, tone, small = false }: { label: string; tone: string; small?: boolean }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full font-bold ${
        small ? 'px-2 py-0.75 text-micro' : 'h-7 px-2.5 text-caption'
      } ${tone}`}
    >
      {label}
    </span>
  );
}
