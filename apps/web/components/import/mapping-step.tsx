'use client';

import { useId } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { StillConnecting } from '../admin/panel';
import { FIELD, PRIMARY_BUTTON } from '../auth/button-classes';
import { IMPORT_FIELDS, complianceMapped, nameMapped, repeatedFields, type Choices } from '../../lib/import-model';
import type { ImportSummary } from '../../lib/imports-api';
import { formatWhen } from './import-text';

/**
 * A2 and A3: one row per column of the file, each a native select of the
 * fields the caller may edit, prefilled from the server's suggestion.
 *
 * THE HEADER IS THE SERVER'S ANSWER. The page never parses the file (D-P21),
 * so the column names, and the guess at what each one is, come from the API;
 * until they arrive this draws the "reading your file" state, then the
 * "still connecting" offer of low-bandwidth mode.
 *
 * ONE REQUIREMENT: a name (`displayName`, a given name or a family name). The
 * design's "last name" and "phone or email" are overruled (I5). A field that
 * may be set once and is set twice blocks Continue here, and the API would
 * refuse it as `duplicate_mapping` anyway.
 *
 * A column's header is file content: drawn as text, never parsed
 * (`data-record-text`). A field the API refused as not editable is not
 * offered again (`readOnly`).
 */

export function MappingStep({
  t,
  locale,
  headers,
  choices,
  readOnly,
  reusable,
  reuseId,
  busy,
  slow,
  onChoice,
  onReuse,
  onContinue,
}: {
  t: Translator;
  locale: string;
  /** `null` while the server is still reading the first row. */
  headers: readonly string[] | null;
  choices: Choices | null;
  readOnly: ReadonlySet<string>;
  reusable: readonly ImportSummary[];
  reuseId: string;
  busy: boolean;
  slow: boolean;
  onChoice: (index: number, field: string | null) => void;
  onReuse: (importId: string) => void;
  onContinue: () => void;
}) {
  const reuseSelect = useId();
  const reading = headers === null || choices === null;
  if (reading) {
    return (
      <section aria-busy="true" className="flex flex-col gap-3">
        {slow ? <StillConnecting t={t} /> : null}
        <p role="status" className="text-body-md text-text-2">
          {t.t('import.map.reading')}
        </p>
        <div aria-hidden="true" className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
          {Array.from({ length: 4 }, (_, index) => (
            <span key={index} className="h-8 rounded-sm bg-surface-sunken" />
          ))}
        </div>
      </section>
    );
  }

  const named = nameMapped(choices);
  const repeated = repeatedFields(choices);
  const ready = named && repeated.length === 0;
  const fields = IMPORT_FIELDS.filter((field) => !readOnly.has(field));

  return (
    <section className="flex flex-col gap-4" aria-labelledby={`${reuseSelect}-title`}>
      <h2 id={`${reuseSelect}-title`} className="text-h3">
        {t.t('import.map.title')}
      </h2>

      {reusable.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <label htmlFor={reuseSelect} className="text-body-sm font-semibold">
            {t.t('import.map.reuse.label')}
          </label>
          <select
            id={reuseSelect}
            data-testid="import-reuse"
            value={reuseId}
            disabled={busy}
            onChange={(event) => onReuse(event.target.value)}
            className={`${FIELD} w-full md:max-w-md`}
          >
            <option value="">{t.t('import.map.reuse.none')}</option>
            {reusable.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {`${entry.filename ?? ''} · ${formatWhen(locale, entry.createdAt)}`}
              </option>
            ))}
          </select>
        </div>
      )}

      <div data-testid="import-required" className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-3">
        <b className="text-body-sm">{t.t('import.required.title')}</b>
        <ul>
          <li data-required="displayName" data-met={named ? 'true' : 'false'} className="flex items-center gap-2 text-body-sm">
            <Icon name={named ? 'check_circle' : 'radio_button_unchecked'} size="sm" className={named ? 'text-success-text' : 'text-text-muted'} />
            {t.t('import.required.name')}
            <span className="sr-only">{t.t(named ? 'import.required.done' : 'import.required.todo')}</span>
          </li>
        </ul>
      </div>

      <div className="hidden items-center gap-3 px-3 text-caption font-bold text-text-muted sm:flex" aria-hidden="true">
        <span className="w-1/2">{t.t('import.map.column')}</span>
        <span className="w-1/2">{t.t('import.map.field')}</span>
      </div>
      <ul className="flex flex-col rounded-lg border border-border bg-surface">
        {headers.map((header, index) => (
          <ColumnRow key={index} t={t} index={index} header={header} choice={choices[index] ?? null} fields={fields} onChoice={onChoice} />
        ))}
      </ul>

      {complianceMapped(choices) ? (
        <p data-testid="import-compliance" className="flex items-start gap-2 rounded-lg bg-info-soft p-3 text-body-sm text-info-text">
          <Icon name="info" size="sm" />
          {t.t('import.compliance.restrict_only')}
        </p>
      ) : null}

      {repeated.length === 0 ? null : (
        <p role="alert" data-testid="import-mapping-note" className="flex items-start gap-2 text-body-sm text-danger-text">
          <Icon name="error" size="sm" />
          {t.t('import.error.duplicate_mapping')}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" data-testid="import-continue" disabled={!ready || busy} onClick={onContinue} className={PRIMARY_BUTTON}>
          {t.t('import.continue')}
        </button>
      </div>
    </section>
  );
}

function ColumnRow({
  t,
  index,
  header,
  choice,
  fields,
  onChoice,
}: {
  t: Translator;
  index: number;
  header: string;
  choice: string | null;
  fields: readonly string[];
  onChoice: (index: number, field: string | null) => void;
}) {
  const id = useId();
  // A custom key the server suggested is kept as an option, so the select can show it.
  const custom = choice !== null && !(IMPORT_FIELDS as readonly string[]).includes(choice) ? choice : null;
  return (
    <li data-map-column={index} className="flex flex-col gap-1 border-b border-border p-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-3">
      <span id={`${id}-header`} data-record-text="" dir="auto" className="min-w-0 break-words text-body-sm font-semibold sm:w-1/2">
        {header}
      </span>
      <span id={`${id}-label`} className="sr-only">
        {t.t('import.map.fieldFor')}
      </span>
      <select
        data-map-field={index}
        aria-labelledby={`${id}-label ${id}-header`}
        value={choice ?? ''}
        onChange={(event) => onChoice(index, event.target.value === '' ? null : event.target.value)}
        className={`${FIELD} w-full min-w-0 sm:w-1/2`}
      >
        <option value="">{t.t('import.map.skip')}</option>
        {fields.map((field) => (
          <option key={field} value={field}>
            {t.t(`import.mapfield.${field}` as MessageId)}
          </option>
        ))}
        {custom === null ? null : <option value={custom}>{t.t('import.mapfield.custom', { name: custom.replace(/^custom\./, '') })}</option>}
      </select>
    </li>
  );
}
