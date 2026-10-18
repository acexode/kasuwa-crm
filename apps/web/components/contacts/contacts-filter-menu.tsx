'use client';

import type { Translator } from '@kasuwa/i18n/bundle';
import { QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { FilterOptions } from '../records/list-parts';
import { optionLabel, type FilterSpec, type FilterState } from './contacts-model';

/**
 * One filter chip's menu on P04/02 (desktop), loaded when the chip is opened:
 * a menu nobody has opened is bytes somebody waited for at 256 kbps.
 */
export function FilterMenu({
  t,
  spec,
  filters,
  onToggle,
  onClear,
  onDone,
}: {
  t: Translator;
  spec: FilterSpec;
  filters: FilterState;
  onToggle: (value: string) => void;
  onClear: () => void;
  onDone: () => void;
}) {
  return (
    <>
      <FilterOptions
        menu={spec.key}
        label={t.t(spec.label)}
        options={spec.options.map((value) => ({ value, label: t.t(optionLabel(spec.key, value)) }))}
        selected={filters[spec.key]}
        onToggle={onToggle}
      />
      <div className="mt-2 flex justify-end gap-2 border-t border-border pt-2">
        <button type="button" onClick={onClear} className={QUIET_BUTTON}>
          {t.t('records.filter.clear')}
        </button>
        <button type="button" data-testid="filter-apply" onClick={onDone} className={SECONDARY_BUTTON}>
          {t.t('records.filter.done')}
        </button>
      </div>
    </>
  );
}
