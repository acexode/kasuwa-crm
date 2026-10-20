'use client';

import type { Translator } from '@kasuwa/i18n/bundle';
import { LockedValue, Muted } from '../records/list-parts';
import { OwnerValue, PhoneValue, STATUS_TONE, StatusWord, TagList, WaDot, copyPart, recordPart, subLine, type LinePart } from '../records/list-table';
import { isWithheld } from '../../lib/records-api';
import type { Lead } from '../../lib/leads-api';
import { leadCellWithheld, sourceLabel, statusLabel, type LeadColumnKey } from './leads-model';

/**
 * The cells the Leads table, its 360 px cards and the Kanban cards draw the
 * same way (T-0058, restyled to P04 by T-0133). A WITHHELD field is a lock and
 * "Restricted", decided PER ROW; a `null` is "Not set" (or "Unassigned" for an
 * owner) and never a lock. Record data is drawn as text inside
 * `data-record-text`, never parsed: a name or a company can carry markup.
 */

/** A status: a code on the wire, a translated label in a pill on screen. */
export function StatusPill({ t, status, small = false }: { t: Translator; status: string; small?: boolean }) {
  return <StatusWord label={t.t(statusLabel(status))} tone={STATUS_TONE[status] ?? ''} small={small} />;
}

/** The phone network, where the row serves it readable. */
export function networkOf(row: Lead): string | null {
  return typeof row.phoneNetwork === 'string' && row.phoneNetwork !== '' && !isWithheld(row, 'phoneNetwork') ? row.phoneNetwork : null;
}

/** DND, where the row serves it readable. A screen never infers it. */
export function dndOf(row: Lead): boolean {
  return row.dnd === true && !isWithheld(row, 'dnd');
}

/** "via Missed call · Lagos · Ikeja": the name's second line, from what is readable. */
export function leadSubLine(t: Translator, row: Lead): LinePart[] | null {
  const source =
    typeof row.source === 'string' && !isWithheld(row, 'source') ? t.t('leads.via', { source: t.t(sourceLabel(row.source)) }) : null;
  const state = typeof row.state === 'string' && !isWithheld(row, 'state') ? row.state : null;
  const lga = typeof row.lga === 'string' && !isWithheld(row, 'lga') ? row.lga : null;
  return subLine([copyPart(source), recordPart(state), recordPart(lga)]);
}

/** The owner for a meta line: the name (record), "Unassigned" (copy), or nothing when withheld or former. */
export function ownerPart(t: Translator, row: Lead): LinePart | null {
  if (leadCellWithheld(row, 'owner')) return null;
  if (row.owner === null || row.owner === undefined) return copyPart(t.t('records.owner.unassigned'));
  return recordPart(row.owner.displayName);
}

/** One field of a lead: a lock when the row withholds it, the value or "Not set" otherwise. */
export function LeadValue({ t, row, field }: { t: Translator; row: Lead; field: Exclude<LeadColumnKey, 'displayName'> }) {
  if (leadCellWithheld(row, field)) {
    return (
      <span className="text-meta text-text-muted">
        <LockedValue t={t} />
      </span>
    );
  }
  const notSet = (
    <span className="text-meta">
      <Muted>{t.t('records.cell.empty')}</Muted>
    </span>
  );
  switch (field) {
    case 'companyName':
      return typeof row.companyName === 'string' ? (
        <span data-record-text="" className="block truncate text-meta">
          {row.companyName}
        </span>
      ) : (
        notSet
      );
    case 'phones': {
      const phones = row.phones ?? [];
      const first = phones[0];
      if (first === undefined) return notSet;
      return <PhoneValue t={t} e164={first.e164} network={networkOf(row)} dnd={dndOf(row)} more={phones.length - 1} />;
    }
    case 'whatsappOptIn':
      return <WaDot t={t} optedIn={row.whatsappOptIn === true} />;
    case 'emails': {
      const emails = row.emails ?? [];
      if (emails[0] === undefined) return notSet;
      return (
        <span data-record-text="" className="block truncate text-meta text-text-2">
          {emails[0]}
        </span>
      );
    }
    case 'tags': {
      const tags = row.tags ?? [];
      return tags.length === 0 ? notSet : <TagList t={t} tags={tags} />;
    }
    case 'status':
      return typeof row.status === 'string' ? <StatusPill t={t} status={row.status} /> : notSet;
    case 'source':
      return typeof row.source === 'string' ? <span className="text-meta">{t.t(sourceLabel(row.source))}</span> : notSet;
    case 'owner':
      if (row.owner === null || row.owner === undefined) return <OwnerValue t={t} name={null} />;
      // A former owner (T-0103, D-P23): the server sends no name. Never the id.
      if (row.owner.displayName === null) {
        return (
          <span data-owner="former" className="flex items-center gap-2 text-meta text-text-muted">
            <span aria-hidden="true" className="size-6 shrink-0 rounded-full border border-dashed border-border-strong" />
            {t.t('records.owner.former')}
          </span>
        );
      }
      return <OwnerValue t={t} name={row.owner.displayName} />;
  }
}

/** A field's wrapper: `data-field` for the cell, `data-locked` when the row withholds it. */
export function fieldProps(row: Lead, field: LeadColumnKey): { 'data-field': LeadColumnKey; 'data-locked'?: 'true' } {
  return leadCellWithheld(row, field) ? { 'data-field': field, 'data-locked': 'true' } : { 'data-field': field };
}
