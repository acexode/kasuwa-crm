'use client';

import { useId } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { FIELD, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { DEFAULT_COUNTRIES, type DefaultCountry } from '../../lib/import-model';

/**
 * A4: the default country, and the duplicate rule in words.
 *
 * The rule is a sentence, not a choice (D-P12): an exact phone or email
 * already in the programme is skipped. There is no name-and-date-of-birth
 * rule, no "when a row matches" menu and no before-and-after preview of file
 * values: the page holds no cell of the file (D-P21), so there is nothing to
 * preview.
 */
export function PhonesStep({
  t,
  country,
  busy,
  onCountry,
  onBack,
  onStart,
}: {
  t: Translator;
  country: DefaultCountry;
  busy: boolean;
  onCountry: (country: DefaultCountry) => void;
  onBack: () => void;
  onStart: () => void;
}) {
  const id = useId();
  return (
    <section className="flex flex-col gap-4" aria-labelledby={`${id}-title`}>
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-h3">
          {t.t('import.phones.title')}
        </h2>
        <p className="text-body-md text-text-2">{t.t('import.phones.body')}</p>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-country`} className="text-body-sm font-semibold">
          {t.t('import.country.label')}
        </label>
        <select
          id={`${id}-country`}
          data-testid="import-country"
          value={country}
          onChange={(event) => {
            const next = DEFAULT_COUNTRIES.find((code) => code === event.target.value);
            if (next !== undefined) onCountry(next);
          }}
          className={`${FIELD} w-full md:max-w-sm`}
        >
          {DEFAULT_COUNTRIES.map((code) => (
            <option key={code} value={code}>
              {t.t(`import.country.${code}` as MessageId)}
            </option>
          ))}
        </select>
        <p className="text-body-sm text-text-2">{t.t('import.country.help')}</p>
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="text-h4">{t.t('import.duplicates.title')}</h3>
        <p data-testid="import-duplicate-rule" className="text-body-md">
          {t.t('import.duplicate_rule')}
        </p>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onBack} disabled={busy} className={SECONDARY_BUTTON}>
          {t.t('import.back')}
        </button>
        <button type="button" data-testid="import-start" disabled={busy} onClick={onStart} className={PRIMARY_BUTTON}>
          {t.t('import.start')}
        </button>
      </div>
    </section>
  );
}
