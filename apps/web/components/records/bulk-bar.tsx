'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import { FOCUS } from './list-classes';

/**
 * P04's selection and bulk bar (T-0133, D-L194, D-L195), behind
 * `bulk_actions`. No bulk endpoint exists, so every action is drawn in the
 * design's disabled state with its reason; which actions a list may draw at
 * all is its earlier cut (Leads: Assign and Update field, T-0058; Accounts:
 * none, so no bar, T-0057). Selection is of the rows on this page only: "Select
 * all 64" would need a total the contract does not have (D-P13).
 */

/** Selected row ids; a new search or view (`q`, `view` by identity) clears them. */
export function useSelection(q: string, view: unknown): {
  selected: ReadonlySet<string>;
  toggle: (id: string) => void;
  setAll: (ids: readonly string[], on: boolean) => void;
  clear: () => void;
} {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    setSelected(new Set());
  }, [q, view]);
  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const setAll = useCallback((ids: readonly string[], on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);
  const clear = useCallback(() => setSelected(new Set()), []);
  return { selected, toggle, setAll, clear };
}

export interface BulkAction {
  readonly key: string;
  readonly icon: IconName;
  readonly label: MessageId;
}

export const BULK_ASSIGN: BulkAction = { key: 'assign', icon: 'person_add_alt', label: 'records.bulk.assign' };
export const BULK_CAMPAIGN: BulkAction = { key: 'campaign', icon: 'campaign', label: 'records.bulk.campaign' };
export const BULK_UPDATE: BulkAction = { key: 'update', icon: 'edit_note', label: 'records.bulk.update' };
export const BULK_MERGE: BulkAction = { key: 'merge', icon: 'merge', label: 'records.bulk.merge' };
export const BULK_WHATSAPP: BulkAction = { key: 'whatsapp', icon: 'chat', label: 'records.bulk.whatsapp' };

/** The inverse bar: 48px, radius 10, "3 selected", the actions, and ✕. */
export function BulkBar({
  t,
  count,
  actions,
  onSelectPage,
  onClear,
}: {
  t: Translator;
  count: number;
  actions: readonly BulkAction[];
  onSelectPage: () => void;
  onClear: () => void;
}) {
  if (count === 0 || actions.length === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label={t.t('records.bulk.label')}
      data-testid="bulk-bar"
      className="hidden min-h-12 flex-wrap items-center gap-0.5 rounded-10 bg-inverse py-1 pe-1.5 ps-4 text-on-inverse md:flex"
    >
      <b className="me-1.5 text-body-sm">{t.t('records.bulk.selected', { count })}</b>
      <button
        type="button"
        onClick={onSelectPage}
        className={`h-10 px-2 text-meta font-semibold underline underline-offset-2 ${FOCUS}`}
      >
        {t.t('records.select.page')}
      </button>
      <span aria-hidden="true" className="mx-2 h-6 w-px bg-current opacity-30" />
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          data-bulk-action={action.key}
          disabled
          title={t.t('records.action.unavailable')}
          className="inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-meta font-semibold opacity-45 disabled:cursor-not-allowed"
        >
          <Icon name={action.icon} size={18} />
          {t.t(action.label)}
          <span className="sr-only">{t.t('records.action.unavailable')}</span>
        </button>
      ))}
      <span className="flex-1" />
      <button
        type="button"
        aria-label={t.t('records.bulk.clear')}
        onClick={onClear}
        className={`flex size-10 items-center justify-center rounded-md ${FOCUS}`}
      >
        <Icon name="close" size={20} />
      </button>
    </div>
  );
}
