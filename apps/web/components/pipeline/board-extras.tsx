'use client';

import type { Translator } from '@kasuwa/i18n/bundle';
import { Select, Switch } from '@kasuwa/ui/components';
import { FIELD } from '../auth/button-classes';
import { DEAL_CURRENCIES } from '../../lib/pipelines-api';
import {
  CLOSE_PRESETS,
  OWNER_FILTERS,
  WON_WINDOWS,
  closeRangeFor,
  closedSinceFor,
  formatShortDate,
  isClosePreset,
  type BoardSummary,
  type CurrencySum,
  type FilterState,
  type OwnerChoice,
  type OwnerFilter,
} from './pipeline-model';
import { CLOSE_PRESET_LABELS } from './filter-labels';
import { Money } from './pipeline-parts';

/**
 * The board's parts that are never in its first load (T-0145): the phone's
 * filter form, drawn only inside the Filters sheet, and two D-L194
 * placeholders, the summary line and the disabled USD switch, drawn only where
 * their flags are on. The board loads this module the first time it draws one
 * of them, so with the flags off and the sheet shut it costs nothing.
 */

/** The disabled "Show US$" switch (`fx_display`). */
export function UsdSwitch({ t }: { t: Translator }) {
  return (
    <span
      data-action="show-usd"
      title={t.t('pipeline.usd.unavailable')}
      className="hidden h-control-base items-center rounded-md border border-border-strong bg-surface pe-3 ps-1 md:inline-flex"
    >
      <Switch
        label={
          <span className="text-meta font-semibold">{t.t('pipeline.usd.show')}</span>
        }
        disabled
        checked={false}
      />
    </span>
  );
}

/** One currency's figure, or each currency's, joined: never converted, never summed across currencies. */
function Sums({
  t,
  locale,
  sums,
  weighted = false,
  tone = 'text-text',
}: {
  t: Translator;
  locale: string;
  sums: readonly CurrencySum[];
  weighted?: boolean;
  tone?: string;
}) {
  if (sums.length === 0) return <b className={`font-mono text-label ${tone}`}>{'—'}</b>;
  return (
    <>
      {sums.map((sum, index) => (
        <span key={sum.currency}>
          {index === 0 ? null : ' + '}
          <b className={`text-label ${tone}`}>
            <Money
              t={t}
              locale={locale}
              money={{
                amountMinor: weighted ? sum.weightedAmountMinor : sum.amountMinor,
                currency: sum.currency,
              }}
            />
          </b>
        </span>
      ))}
    </>
  );
}

/** P06/01's summary line: the served column figures, added per currency. */
export function SummaryLine({
  t,
  locale,
  summary,
  closedSince,
}: {
  t: Translator;
  locale: string;
  summary: BoardSummary;
  closedSince: string | null;
}) {
  return (
    <div
      data-testid="board-summary"
      className="flex flex-wrap items-baseline gap-x-5 gap-y-2 text-meta text-text-2"
    >
      {summary.open === null ? null : (
        <>
          <span>
            {t.t('pipeline.summary.open')} <Sums t={t} locale={locale} sums={summary.open} />
          </span>
          <span>
            {t.t('pipeline.summary.weighted')}{' '}
            <Sums t={t} locale={locale} sums={summary.open} weighted />
          </span>
        </>
      )}
      {summary.won === null || closedSince === null ? null : (
        <span>
          {t.t('pipeline.summary.wonSince', {
            date: formatShortDate(locale, closedSince.slice(0, 10)),
          })}{' '}
          <Sums t={t} locale={locale} sums={summary.won} tone="text-success-text" />
        </span>
      )}
      <span>{t.t('pipeline.summary.openDeals', { count: summary.openCount })}</span>
    </div>
  );
}

export function SheetFilters({
  t,
  state,
  withheldFields,
  owners,
  onChange,
}: {
  t: Translator;
  state: FilterState;
  withheldFields: readonly string[];
  owners: readonly OwnerChoice[];
  onChange: (change: Partial<FilterState>) => void;
}) {
  const label = 'flex min-w-0 flex-col gap-1.5 text-body-sm font-semibold';
  const control = `${FIELD} font-normal`;
  return (
    <div
      role="group"
      aria-label={t.t('records.filter.label')}
      className="flex min-w-0 flex-col gap-4"
    >
      {withheldFields.includes('ownerUserId') ? null : (
        <Select
          label={t.t('pipeline.filter.owner')}
          data-filter="owner"
          value={state.owners.length === 1 ? (state.owners[0] ?? '') : state.owner}
          onChange={(event) => {
            const value = event.target.value;
            if ((OWNER_FILTERS as readonly string[]).includes(value))
              onChange({ owner: value as OwnerFilter, owners: [] });
            else if (owners.some((owner) => owner.id === value))
              onChange({ owner: '', owners: [value] });
            else onChange({ owner: '', owners: [] });
          }}
        >
          <option value="">{t.t('pipeline.filter.owner.any')}</option>
          <option value="me">{t.t('pipeline.filter.owner.me')}</option>
          <option value="unassigned">{t.t('pipeline.card.unassigned')}</option>
          {owners.map((owner) => (
            <option key={owner.id} value={owner.id} data-record-text="">
              {owner.name}
            </option>
          ))}
        </Select>
      )}
      {withheldFields.includes('expectedCloseDate') ? null : (
        <>
          <Select
            label={t.t('pipeline.filter.close')}
            data-filter="close"
            value={state.closePreset}
            onChange={(event) => {
              const preset = isClosePreset(event.target.value) ? event.target.value : 'any';
              onChange({ closePreset: preset, ...(closeRangeFor(preset, Date.now()) ?? {}) });
            }}
          >
            {CLOSE_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {t.t(CLOSE_PRESET_LABELS[preset])}
              </option>
            ))}
          </Select>
          {state.closePreset === 'custom' ? (
            <div className="grid grid-cols-2 gap-3">
              <label className={label}>
                {t.t('pipeline.filter.closeFrom')}
                <input
                  type="date"
                  data-filter-input="closeFrom"
                  value={state.closeFrom}
                  onChange={(event) => onChange({ closeFrom: event.target.value })}
                  className={control}
                />
              </label>
              <label className={label}>
                {t.t('pipeline.filter.closeTo')}
                <input
                  type="date"
                  data-filter-input="closeTo"
                  value={state.closeTo}
                  min={state.closeFrom === '' ? undefined : state.closeFrom}
                  onChange={(event) => onChange({ closeTo: event.target.value })}
                  className={control}
                />
              </label>
            </div>
          ) : null}
        </>
      )}
      {withheldFields.includes('amount') ? null : (
        <Select
          label={t.t('pipeline.filter.currency')}
          data-filter="currency"
          value={state.currency}
          onChange={(event) => onChange({ currency: event.target.value })}
        >
          <option value="">{t.t('pipeline.filter.currency.any')}</option>
          {DEAL_CURRENCIES.map((code) => (
            <option key={code} value={code} data-record-text="">
              {code}
            </option>
          ))}
        </Select>
      )}
      <Select
        label={t.t('pipeline.filter.won')}
        data-filter="closedSince"
        value={String(state.wonDays)}
        onChange={(event) => {
          const days =
            WON_WINDOWS.find((choice) => String(choice) === event.target.value) ?? state.wonDays;
          onChange({ wonDays: days, closedSince: closedSinceFor(days, Date.now()) });
        }}
      >
        {WON_WINDOWS.map((days) => (
          <option key={days} value={String(days)}>
            {t.t('pipeline.filter.won.days', { days })}
          </option>
        ))}
      </Select>
    </div>
  );
}
