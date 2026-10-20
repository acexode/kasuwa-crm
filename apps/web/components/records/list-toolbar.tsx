'use client';

import { forwardRef, useId, useSyncExternalStore, type ReactNode } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Chip, CountBadge } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { FOCUS, OPTION_CHIP, OPTION_CHIP_OFF, CHIP_ON, TOOL_BUTTON } from './list-classes';
import type { FilterOption } from './list-parts';

/**
 * The P04 toolbar (T-0133): the search field, the icon-led filter chips, the
 * chips the design draws for filters no list read declares (disabled, behind
 * `more_filters`)), the Columns button, and the
 * phone's search plus filter-sheet button.
 */

const WIDE = '(min-width: 768px)';

/** `md` and up, read from the browser; the server renders the wide layout's copy. */
export function useWide(): boolean {
  return useSyncExternalStore(
    (change) => {
      const query = window.matchMedia(WIDE);
      query.addEventListener('change', change);
      return () => query.removeEventListener('change', change);
    },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

/**
 * The search field. Desktop: 280px, 40px, radius 8, a 20px glyph, 14px text,
 * "Search name, number, email…". Phone: a 48px pill, 15px, "Name or number".
 */
export function SearchField({
  t,
  value,
  label,
  placeholder,
  phonePlaceholder,
  onChange,
}: {
  t: Translator;
  value: string;
  label: MessageId;
  placeholder: MessageId;
  phonePlaceholder: MessageId;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const wide = useWide();
  return (
    <label
      htmlFor={id}
      className="flex h-12 min-w-0 flex-1 items-center gap-2 rounded-full border border-border-strong bg-surface px-3.5 text-text-muted focus-within:border-primary md:h-control-md md:w-72 md:flex-none md:rounded-md md:px-3"
    >
      <Icon name="search" size={20} />
      <input
        id={id}
        type="search"
        value={value}
        maxLength={100}
        autoComplete="off"
        aria-label={t.t(label)}
        placeholder={t.t(wide ? placeholder : phonePlaceholder)}
        onChange={(event) => onChange(event.target.value)}
        className="h-full min-w-0 flex-1 bg-transparent text-label font-normal text-text placeholder:text-text-muted focus:outline-none md:text-body-sm"
      />
    </label>
  );
}

/** A filter chip that opens its menu: the `@kasuwa/ui` Chip, a leading glyph, `data-filter` the wire parameter. */
export const FilterChip = forwardRef<
  HTMLButtonElement,
  {
    filter: string;
    icon: IconName;
    active: boolean;
    open: boolean;
    children: ReactNode;
    onOpen: (trigger: HTMLElement) => void;
  }
>(function FilterChip({ filter, icon, active, open, children, onOpen }, ref) {
  return (
    <Chip
      ref={ref}
      data-filter={filter}
      icon={icon}
      trailingIcon="expand_more"
      active={active}
      aria-haspopup="true"
      aria-expanded={open}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      {children}
    </Chip>
  );
});

/** A withheld filter: the server would refuse it (400 field_withheld), so the chip says so and offers nothing. */
export function LockedChip({ t, filter, icon, label }: { t: Translator; filter: string; icon: IconName; label: string }) {
  return (
    <Chip data-filter={filter} data-locked="true" icon={icon} aria-disabled="true" className="cursor-not-allowed text-text-muted">
      {label}
      <Icon name="lock" size={16} />
      <span className="sr-only">{t.t('accounts.filter.locked')}</span>
    </Chip>
  );
}

/**
 * A chip the design draws for a filter this list's read does not declare
 * (Preferred language, Consent status, State/LGA on Leads): disabled, with the
 * reason as its tooltip and read out (D-L194). `data-filter-unavailable`, not
 * `data-filter`: it is no parameter.
 */
export function UnavailableChip({ t, name, icon, label }: { t: Translator; name: string; icon: IconName; label: MessageId }) {
  return (
    <Chip data-filter-unavailable={name} icon={icon} trailingIcon="expand_more" disabled title={t.t('records.action.unavailable')}>
      {t.t(label)}
      <span className="sr-only">{t.t('records.action.unavailable')}</span>
    </Chip>
  );
}

/** "Columns": 36px outlined, a `view_column` glyph. */
export const ColumnsButton = forwardRef<HTMLButtonElement, { t: Translator; open: boolean; onOpen: (trigger: HTMLElement) => void }>(
  function ColumnsButton({ t, open, onOpen }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        data-testid="column-chooser"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={(event) => onOpen(event.currentTarget)}
        className={`${TOOL_BUTTON} pe-3`}
      >
        <Icon name="view_column" size={18} />
        {t.t('records.columns.button')}
      </button>
    );
  },
);

/** The phone's filter button: a 48px circle with `tune`, and a count badge when filters are on. */
export function FilterSheetButton({
  t,
  active,
  open,
  onOpen,
}: {
  t: Translator;
  active: number;
  open: boolean;
  onOpen: (trigger: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      data-testid="filter-sheet-button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={t.t('records.filter.label')}
      onClick={(event) => onOpen(event.currentTarget)}
      className={`relative flex size-12 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface text-text md:hidden ${FOCUS}`}
    >
      <Icon name="tune" size={22} />
      {active > 0 ? (
        <CountBadge tone="primary" className="absolute -end-1 -top-1">
          {active}
        </CountBadge>
      ) : null}
    </button>
  );
}

/**
 * One filter's options as 40px option chips (the phone's filter sheet): a
 * check glyph when on. Same hooks as the desktop menu: `data-filter-menu` on
 * the group, `data-filter-option` the wire value, `aria-pressed` the state.
 */
export function OptionChips({
  menu,
  label,
  options,
  selected,
  onToggle,
}: {
  menu: string;
  label: string;
  options: readonly FilterOption[];
  selected: readonly string[];
  onToggle: (value: string) => void;
}) {
  return (
    <fieldset data-filter-menu={menu} className="flex flex-col gap-2">
      <legend className="pb-2 text-meta font-bold text-text-2">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const on = selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              data-filter-option={option.value}
              aria-pressed={on}
              onClick={() => onToggle(option.value)}
              className={`${OPTION_CHIP} ${on ? CHIP_ON : OPTION_CHIP_OFF}`}
            >
              {on ? <Icon name="check" size={16} /> : null}
              {option.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** The active filters as removable chips under the phone's search (P04 "Contacts · no results · 360"). */
export function ActiveFilterChips({
  t,
  chips,
}: {
  t: Translator;
  chips: readonly { readonly key: string; readonly text: string; readonly onRemove: () => void }[];
}) {
  if (chips.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5 md:hidden">
      {chips.map((chip) => (
        <li key={chip.key}>
          <button
            type="button"
            aria-label={t.t('accounts.filter.remove', { value: chip.text })}
            onClick={chip.onRemove}
            className={`inline-flex h-8 items-center gap-1 rounded-full border border-primary bg-primary-soft pe-1.5 ps-2.5 text-caption font-bold text-primary-text ${FOCUS}`}
          >
            {chip.text}
            <Icon name="close" size={16} />
          </button>
        </li>
      ))}
    </ul>
  );
}
