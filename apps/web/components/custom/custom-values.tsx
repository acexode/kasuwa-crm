'use client';

import { useId } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import type { CustomField } from '../../lib/custom-values-api';
import { describeCustom, isCustomWithheld, type CustomValues } from '../../lib/custom-values-model';

/**
 * The record's custom values (P05/01 and P05/04, P06/05), one slot per ACTIVE
 * definition the screen read, in the definitions' order.
 *
 * WITHHOLDING IS DECIDED PER RECORD from its own `withheldFields` (C10), never
 * cached per key. A withheld key is the screens' existing treatment: a lock and
 * "Restricted", and no value element at all. A key the record has no value for
 * is "Not set", not locked. A key with no definition is never drawn.
 *
 * The label and a text, picklist or number value are TENANT DATA: marked
 * `data-record-text`, drawn as text and never parsed. A boolean is copy, so it
 * is translated. A date is a CALENDAR date in a `<time>`, formatted in UTC so
 * it is the same day in every zone.
 */
export function CustomValuesPanel({
  t,
  locale,
  fields,
  custom,
  withheldFields,
}: {
  t: Translator;
  locale: string;
  fields: readonly CustomField[];
  custom: CustomValues | undefined;
  withheldFields: readonly string[];
}) {
  const heading = useId();
  if (fields.length === 0) return null;
  return (
    <section
      data-testid="custom-fields"
      aria-labelledby={heading}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <h2 id={heading} className="text-h5">
        {t.t('custom.section.title')}
      </h2>
      <dl className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((field) => {
          const locked = isCustomWithheld(withheldFields, field.apiName);
          return (
            <div
              key={field.apiName}
              data-custom-field={field.apiName}
              data-locked={locked ? 'true' : undefined}
              className="flex min-w-0 flex-col gap-1 py-2"
            >
              <dt className="text-caption text-text-muted">
                <span data-record-text="">{field.label}</span>
              </dt>
              <dd className="min-w-0 break-words text-body-md">
                {locked ? (
                  <span className="inline-flex items-center gap-1 text-text-muted">
                    <Icon name="lock" size="sm" />
                    {t.t('records.locked')}
                  </span>
                ) : (
                  <Shown t={t} locale={locale} field={field} value={custom?.[field.apiName]} />
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function Shown({ t, locale, field, value }: { t: Translator; locale: string; field: CustomField; value: unknown }) {
  const view = describeCustom(field, value, locale);
  switch (view.kind) {
    case 'empty':
      return <span className="text-text-muted">{t.t('records.cell.empty')}</span>;
    case 'boolean':
      return <span data-custom-value="">{t.t(view.value ? 'custom.boolean.true' : 'custom.boolean.false')}</span>;
    case 'date':
      return (
        <span data-custom-value="" data-record-text="">
          <time dateTime={view.iso}>{view.text}</time>
        </span>
      );
    case 'text':
      return (
        <span data-custom-value="" data-record-text="">
          {view.text}
        </span>
      );
  }
}
