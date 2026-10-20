'use client';

import { useId } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { EmptyState } from '@kasuwa/ui/components';
import { RadioCard, StatTile, TABLE_CARD } from '../data/parts';
import type { Choices, DefaultCountry } from '../../lib/import-model';
import { formatCount } from './import-text';

/**
 * A5 "Review" (T-0141, D-L128 Q6, D-L195): the design's step and layout, with
 * only the counts the API returns before a run. There is no dry run, so the
 * export's rows-in-file, ready, warnings and errors are not known yet; the
 * tiles count what IS known (the file's columns, how many are mapped and how
 * many are not, and where they go), and the error table is the design's empty
 * state saying the rows are checked when the import runs.
 *
 * The skip-or-fix pair stands: a run always skips rows with problems and
 * lists them in its report, or the person goes back and fixes the file first
 * (the bar's primary action changes to "Choose another file").
 */
export function ReviewStep({
  t,
  locale,
  headers,
  choices,
  programmeName,
  country,
  fixFirst,
  onFixFirst,
}: {
  t: Translator;
  locale: string;
  headers: readonly string[];
  choices: Choices;
  programmeName: string | null;
  country: DefaultCountry;
  fixFirst: boolean;
  onFixFirst: (fix: boolean) => void;
}) {
  const id = useId();
  const mapped = choices.filter((choice) => choice !== null).length;
  return (
    <section data-testid="import-review" aria-labelledby={`${id}-title`} className="flex flex-col gap-5">
      <h2 id={`${id}-title`} className="sr-only">
        {t.t('import.step.review')}
      </h2>
      <dl className="m-0 grid grid-cols-2 gap-3.5 xl:grid-cols-4">
        <StatTile icon="table_rows" label={t.t('import.review.columns')} value={formatCount(locale, headers.length)} />
        <StatTile icon="check_circle" tone="success" label={t.t('import.review.mapped')} value={formatCount(locale, mapped)} />
        <StatTile icon="do_not_disturb_on" label={t.t('import.review.skipped')} value={formatCount(locale, headers.length - mapped)} />
        <StatTile
          icon="location_on"
          label={t.t('import.review.into')}
          value={<span className="block truncate text-body-md font-bold" data-record-text="" dir="auto">{programmeName ?? t.t('import.programme.unknown')}</span>}
        />
      </dl>

      <div className={TABLE_CARD}>
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <span className="inline-flex rounded-md bg-surface-sunken p-0.75">
            <span className="rounded-6 bg-surface px-3 py-1.5 text-meta font-bold text-text shadow-1">{t.t('import.review.problems')}</span>
          </span>
          <span className="flex-1" />
          <span className="text-meta text-text-2">{t.t(`import.country.${country}` as MessageId)}</span>
        </div>
        <div className="px-5 py-6">
          <EmptyState icon="rule" tone="neutral" headingLevel={3} title={t.t('import.review.empty.title')} body={t.t('import.review.empty.body')} />
        </div>
      </div>

      <div role="radiogroup" aria-label={t.t('import.review.choice')} className="grid gap-3.5 xl:grid-cols-2">
        <RadioCard
          name={`${id}-choice`}
          trailing="leading"
          checked={!fixFirst}
          onChange={() => onFixFirst(false)}
          title={t.t('import.review.skip')}
          body={t.t('import.review.skip.body')}
        />
        <RadioCard
          name={`${id}-choice`}
          trailing="leading"
          checked={fixFirst}
          onChange={() => onFixFirst(true)}
          title={t.t('import.review.fix')}
          body={t.t('import.review.fix.body')}
        />
      </div>
    </section>
  );
}
