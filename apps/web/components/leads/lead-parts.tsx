'use client';

import type { Translator } from '@kasuwa/i18n/bundle';
import { LockedValue, Muted } from '../records/list-parts';
import { formatPhone } from '../records/list-model';
import type { Lead } from '../../lib/leads-api';
import { leadCellWithheld, sourceLabel, statusLabel, type LeadColumnKey } from './leads-model';

/**
 * The cells the Leads table, its 360 px cards and the Kanban cards draw the
 * same way (T-0058). A WITHHELD field is a lock and "Restricted", decided PER
 * ROW; a `null` is "Not set" (or "Unassigned" for an owner) and never a lock.
 * Record data is drawn as text inside `data-record-text`, never parsed: a
 * name or a company can carry markup.
 */

const STATUS_TONE: Readonly<Record<string, string>> = {
  new: 'bg-info-soft text-info-text',
  contacted: 'bg-primary-soft text-primary-text',
  qualified: 'bg-success-soft text-success-text',
  unqualified: 'bg-surface-sunken text-text-2',
  customer: 'bg-accent-soft text-accent-text',
};

/** A status: a code on the wire, a translated label in a pill on screen. */
export function StatusPill({ t, status }: { t: Translator; status: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 text-caption font-bold ${STATUS_TONE[status] ?? ''}`}>
      {t.t(statusLabel(status))}
    </span>
  );
}

/** One field of a lead: a lock when the row withholds it, the value or "Not set" otherwise. */
export function LeadValue({ t, row, field }: { t: Translator; row: Lead; field: Exclude<LeadColumnKey, 'displayName'> }) {
  if (leadCellWithheld(row, field)) {
    return <LockedValue t={t} />;
  }
  const notSet = <Muted>{t.t('records.cell.empty')}</Muted>;
  switch (field) {
    case 'companyName':
      return typeof row.companyName === 'string' ? (
        <span data-record-text="" className="break-words">
          {row.companyName}
        </span>
      ) : (
        notSet
      );
    case 'phones': {
      const phones = row.phones ?? [];
      const first = phones[0];
      if (first === undefined) return notSet;
      return (
        <span className="flex flex-wrap items-center gap-2">
          <span data-record-text="" className="whitespace-nowrap tabular-nums">
            {formatPhone(first.e164)}
          </span>
          {phones.length > 1 ? <Muted>{t.t('records.more', { count: phones.length - 1 })}</Muted> : null}
        </span>
      );
    }
    case 'status':
      return typeof row.status === 'string' ? <StatusPill t={t} status={row.status} /> : notSet;
    case 'source':
      return typeof row.source === 'string' ? <span>{t.t(sourceLabel(row.source))}</span> : notSet;
    case 'owner':
      return row.owner === null || row.owner === undefined ? (
        <Muted>{t.t('records.owner.unassigned')}</Muted>
      ) : (
        <span data-record-text="">{row.owner.displayName}</span>
      );
  }
}

/** A field's wrapper: `data-field` for the cell, `data-locked` when the row withholds it. */
export function fieldProps(row: Lead, field: LeadColumnKey): { 'data-field': LeadColumnKey; 'data-locked'?: 'true' } {
  return leadCellWithheld(row, field) ? { 'data-field': field, 'data-locked': 'true' } : { 'data-field': field };
}
