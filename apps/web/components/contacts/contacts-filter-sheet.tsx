'use client';

import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { FOCUS } from '../records/list-classes';
import { FilterOptions } from '../records/list-parts';
import { FILTERS, optionLabel, type FilterKey, type FilterState } from './contacts-model';

/**
 * The phone's filter sheet on P04/02 (a modal sheet, `md:hidden`), loaded only
 * when it is opened: it is not on the list's first paint, and at 256 kbps the
 * bytes of a sheet nobody has opened are bytes somebody waited for.
 */

export function FilterSheet({
  t,
  filters,
  sheetRef,
  onToggle,
  onClear,
  onClose,
}: {
  t: Translator;
  filters: FilterState;
  sheetRef: React.RefObject<HTMLDivElement | null>;
  onToggle: (key: FilterKey, value: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Focus stays inside a modal sheet: Tab past the last control comes back round.
  const trap = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])'),
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end md:hidden">
      <span aria-hidden="true" className="absolute inset-0 bg-scrim" />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="filter-sheet"
        onKeyDown={trap}
        className="relative flex max-h-full w-full flex-col gap-3 overflow-y-auto rounded-t-xl bg-surface p-4 shadow-3"
      >
        <div className="flex items-center gap-2">
          <h2 id={titleId} className="flex-1 text-h4">
            {t.t('records.filter.label')}
          </h2>
          <button
            ref={closeRef}
            type="button"
            aria-label={t.t('records.filter.sheet.close')}
            onClick={onClose}
            className={`flex min-h-touch min-w-touch items-center justify-center rounded-md hover:bg-surface-sunken ${FOCUS}`}
          >
            <Icon name="close" size="sm" />
          </button>
        </div>
        {FILTERS.map((spec) => (
          <div key={spec.key} className="flex flex-col gap-1">
            <b className="text-body-sm">{t.t(spec.label)}</b>
            <FilterOptions
              menu={spec.key}
              label={t.t(spec.label)}
              options={spec.options.map((value) => ({ value, label: t.t(optionLabel(spec.key, value)) }))}
              selected={filters[spec.key]}
              onToggle={(value) => onToggle(spec.key, value)}
            />
          </div>
        ))}
        <div className="sticky bottom-0 flex gap-2 border-t border-border bg-surface pt-3">
          <button type="button" onClick={onClear} className={`${SECONDARY_BUTTON} flex-1`}>
            {t.t('records.filter.clearAll')}
          </button>
          <button type="button" data-testid="filter-apply" onClick={onClose} className={`${PRIMARY_BUTTON} flex-1`}>
            {t.t('records.filter.sheet.apply')}
          </button>
        </div>
      </div>
    </div>
  );
}
