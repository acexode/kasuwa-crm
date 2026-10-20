'use client';

import { useId } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CARD, CARD_TITLE, NativeSelect } from '../data/parts';
import { DEFAULT_COUNTRIES, type DefaultCountry } from '../../lib/import-model';

/**
 * A4 "Clean up": the export's two cards, phone numbers and duplicates.
 *
 * The rule is a sentence, not a choice (D-P12): an exact phone or email
 * already in the programme is skipped. So the duplicates card draws the
 * design's switches for the two keys that apply, on and locked, and the one
 * outcome there is; there is no name-and-date-of-birth rule and no "when a row
 * matches" menu. There is no before-and-after preview of file values: the page
 * holds no cell of the file (D-P21), so there is nothing to preview.
 */
export function PhonesStep({
  t,
  designed,
  country,
  onCountry,
}: {
  t: Translator;
  designed: boolean;
  country: DefaultCountry;
  onCountry: (country: DefaultCountry) => void;
}) {
  const id = useId();
  return (
    <div className="grid items-start gap-5 xl:grid-cols-2">
      <section className={CARD} aria-labelledby={`${id}-title`}>
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex min-w-0 flex-1 basis-60 flex-col gap-1">
            <h2 id={`${id}-title`} className={CARD_TITLE}>
              {t.t('import.phones.title')}
            </h2>
            <p className="m-0 text-body-sm text-text-2">{t.t('import.phones.body')}</p>
          </div>
          <div className="flex w-full flex-col gap-1.5 sm:w-auto">
            <label htmlFor={`${id}-country`} className="text-meta font-semibold">
              {t.t('import.country.label')}
            </label>
            <NativeSelect
              id={`${id}-country`}
              data-testid="import-country"
              value={country}
              onChange={(event) => {
                const next = DEFAULT_COUNTRIES.find((code) => code === event.target.value);
                if (next !== undefined) onCountry(next);
              }}
            >
              {DEFAULT_COUNTRIES.map((code) => (
                <option key={code} value={code}>
                  {t.t(`import.country.${code}` as MessageId)}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
        <p className="m-0 flex items-start gap-2 rounded-10 bg-surface-sunken px-3.5 py-3 text-meta text-text-2">
          <Icon name="call" size={18} className="shrink-0" />
          {t.t('import.country.help')}
        </p>
      </section>

      <section className={CARD} aria-labelledby={`${id}-dup-title`}>
        <div className="flex flex-col gap-1">
          <h2 id={`${id}-dup-title`} className={CARD_TITLE}>
            {t.t('import.duplicates.title')}
          </h2>
          <p className="m-0 text-body-sm text-text-2">{t.t('import.duplicates.body')}</p>
        </div>
        {designed ? (
          <div className="flex flex-col gap-3">
            <b className="text-body-sm font-bold">{t.t('import.duplicates.when')}</b>
            {(['phone', 'email'] as const).map((key) => (
              <div key={key} className="flex items-start gap-3">
                <span aria-hidden="true" className="relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-primary">
                  <span className="absolute end-0.5 size-5 rounded-full bg-on-primary shadow-knob" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-body-sm font-semibold">
                    {t.t(`import.duplicates.key.${key}` as MessageId)}
                    <span className="sr-only">{` ${t.t('import.duplicates.locked')}`}</span>
                  </span>
                  <span className="text-caption font-normal text-text-2">{t.t(`import.duplicates.key.${key}.body` as MessageId)}</span>
                </span>
              </div>
            ))}
            <b className="mt-1 text-body-sm font-bold">{t.t('import.duplicates.outcome')}</b>
            <div className="flex items-start gap-2.5">
              <span aria-hidden="true" className="mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-full border-2 border-primary">
                <span className="size-2 rounded-full bg-primary" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-body-sm">{t.t('import.duplicates.skip')}</span>
                <span className="text-caption font-normal text-text-2">{t.t('import.duplicates.skip.body')}</span>
              </span>
            </div>
          </div>
        ) : null}
        <p data-testid="import-duplicate-rule" className="m-0 flex items-start gap-2 rounded-10 bg-info-soft px-4 py-3 text-body-sm text-info-text">
          <Icon name="join" size={18} className="mt-px shrink-0" />
          {t.t('import.duplicate_rule')}
        </p>
      </section>
    </div>
  );
}
