'use client';

import { useId } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { FIELD } from '../auth/button-classes';
import type { CustomField } from '../../lib/custom-values-api';
import { IS_EMPTY, filterableFields, type CustomFilters } from '../../lib/custom-values-model';

/**
 * The custom filters on a list (P04, the pipeline's list view): one native
 * `<select>` per active PICKLIST or BOOLEAN field and nothing else (D-L128 Q4).
 * Each offers "any", the field's values (labels for a picklist, a translated
 * yes and no for a boolean) and "is empty" (`is-empty`: a picklist value can
 * never contain a `-`). One value per key, so choosing "is empty" replaces an
 * equality on that key. There is no custom sort.
 */
export function CustomFilterBar({
  t,
  fields,
  filters,
  onChange,
}: {
  t: Translator;
  fields: readonly CustomField[];
  filters: CustomFilters;
  onChange: (key: string, value: string) => void;
}) {
  const prefix = useId();
  const offered = filterableFields(fields);
  if (offered.length === 0) return null;
  return (
    <div role="group" aria-label={t.t('custom.filter.group')} className="flex flex-wrap items-center gap-2">
      {offered.map((field) => {
        const key = field.apiName;
        return (
          <select
            key={key}
            id={`${prefix}-${key}`}
            data-filter={`custom.${key}`}
            data-custom-filter=""
            aria-label={field.label}
            value={filters[key] ?? ''}
            onChange={(event) => onChange(key, event.target.value)}
            className={`${FIELD} max-w-full`}
          >
            <option value="">{t.t('custom.filter.any', { field: field.label })}</option>
            {field.type === 'picklist' ? (
              field.values.map((entry) => (
                <option key={entry.value} value={entry.value} data-record-text="">
                  {entry.label}
                </option>
              ))
            ) : (
              <>
                <option value="true">{t.t('custom.boolean.true')}</option>
                <option value="false">{t.t('custom.boolean.false')}</option>
              </>
            )}
            <option value={IS_EMPTY}>{t.t('custom.filter.isEmpty')}</option>
          </select>
        );
      })}
    </div>
  );
}
