'use client';

import { useId } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { FIELD } from '../auth/button-classes';
import type { CustomField } from '../../lib/custom-values-api';
import { isCustomWithheld, type CustomDraft } from '../../lib/custom-values-model';

/**
 * One input per active, READABLE custom field, inside a record's edit form or
 * an activity form (`data-custom-input`). A withheld key has no input at all:
 * a caller cannot clear what they cannot see. A key the API has said is
 * read-only is disabled, with its reason.
 *
 * Native controls, because on a mid-range Android phone they open the system
 * picker: picklist and boolean are a `<select>` whose empty option is "no
 * value"; a date is `type="date"`. text, number and currency are text inputs,
 * NEVER `type="number"`: that parses to a float and loses digits. A currency is
 * typed in major units in the field's one currency, named in its hint.
 */
export function CustomInputs({
  t,
  fields,
  draft,
  withheldFields = [],
  readOnly,
  disabled,
  invalid,
  onChange,
}: {
  t: Translator;
  fields: readonly CustomField[];
  draft: CustomDraft;
  /** The record's own `withheldFields`; empty on a create. */
  withheldFields?: readonly string[];
  readOnly: ReadonlySet<string>;
  disabled: boolean;
  invalid: readonly string[];
  onChange: (key: string, value: string) => void;
}) {
  const prefix = useId();
  const shown = fields.filter((field) => !isCustomWithheld(withheldFields, field.apiName));
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((field) => {
        const key = field.apiName;
        const id = `${prefix}-${key}`;
        const locked = readOnly.has(key);
        const hint = locked ? 'custom.readOnly' : field.type === 'currency' ? 'custom.currencyHint' : null;
        const common = {
          id,
          'data-custom-input': key,
          value: draft[key] ?? '',
          disabled: disabled || locked,
          'aria-invalid': invalid.includes(key) ? true : undefined,
          'aria-describedby': hint === null ? undefined : `${id}-hint`,
          onChange: (event: { target: { value: string } }) => onChange(key, event.target.value),
          className: `${FIELD} w-full`,
        };
        return (
          <div key={key} className="flex flex-col gap-1">
            <label htmlFor={id} className="text-body-sm font-semibold">
              <span data-record-text="">{field.label}</span>
            </label>
            {field.type === 'picklist' || field.type === 'boolean' ? (
              <select {...common}>
                <option value="">{t.t('custom.noValue')}</option>
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
              </select>
            ) : field.type === 'date' ? (
              <input {...common} type="date" />
            ) : (
              <input
                {...common}
                type="text"
                inputMode={field.type === 'text' ? 'text' : 'decimal'}
                autoComplete="off"
                maxLength={field.type === 'text' ? 1000 : 40}
              />
            )}
            {hint === null ? null : (
              <span id={`${id}-hint`} className="text-caption text-text-muted">
                {t.t(hint, { currency: field.currency ?? '' })}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}
