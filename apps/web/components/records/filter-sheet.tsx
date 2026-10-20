'use client';

import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { FOCUS } from './list-classes';
import type { FilterOption } from './list-parts';
import { OptionChips } from './list-toolbar';

/**
 * The phone's filter sheet on every P04 list (P04 "Filter sheet · 360",
 * T-0133): a bottom sheet over the scrim, radius 16 at the top, a grab
 * handle, "Filters" at 18/700 with a 48px close, each filter as a group of
 * 40px option chips, and a footer with "Clear all" and the primary "Show
 * leads" — no count in it (D-P13). Loaded when it is first opened.
 */

export interface SheetGroup {
  readonly key: string;
  readonly label: string;
  readonly options: readonly FilterOption[];
  readonly selected: readonly string[];
}

export function FilterSheet({
  t,
  groups,
  extra,
  showLabel,
  sheetRef,
  onToggle,
  onClear,
  onClose,
}: {
  t: Translator;
  groups: readonly SheetGroup[];
  /** Filters that are not a set of options (an account's free values), after the groups. */
  extra?: ReactNode;
  showLabel: MessageId;
  sheetRef: RefObject<HTMLDivElement | null>;
  onToggle: (key: string, value: string) => void;
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
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input'));
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
    <div className="fixed inset-0 z-40 flex flex-col justify-end md:hidden">
      <span aria-hidden="true" className="absolute inset-0 bg-scrim" onClick={onClose} />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="filter-sheet"
        onKeyDown={trap}
        className="relative flex max-h-[86%] flex-col rounded-t-xl bg-surface shadow-3"
      >
        <span aria-hidden="true" className="mt-2 h-1 w-9 self-center rounded-sm bg-border-strong" />
        <div className="flex items-center py-1 pe-1 ps-5">
          <h2 id={titleId} className="flex-1 text-h5 font-bold">
            {t.t('records.filter.label')}
          </h2>
          <button
            ref={closeRef}
            type="button"
            aria-label={t.t('records.filter.sheet.close')}
            onClick={onClose}
            className={`flex size-12 items-center justify-center rounded-md text-text ${FOCUS}`}
          >
            <Icon name="close" size={24} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-3">
          {groups.map((group) => (
            <OptionChips
              key={group.key}
              menu={group.key}
              label={group.label}
              options={group.options}
              selected={group.selected}
              onToggle={(value) => onToggle(group.key, value)}
            />
          ))}
          {extra}
        </div>
        <div className="flex gap-2 border-t border-border px-4 pb-4 pt-3">
          <button
            type="button"
            onClick={onClear}
            className={`h-control-lg rounded-md border border-border-strong bg-surface px-4 text-label text-text ${FOCUS}`}
          >
            {t.t('records.filter.clearAll')}
          </button>
          <button
            type="button"
            data-testid="filter-apply"
            onClick={onClose}
            className={`h-control-lg flex-1 rounded-md bg-primary text-label font-bold text-on-primary ${FOCUS}`}
          >
            {t.t(showLabel)}
          </button>
        </div>
      </div>
    </div>
  );
}
