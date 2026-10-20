'use client';

import { useId } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import { StillConnecting } from '../admin/panel';
import { CheckChip, NativeSelect, TABLE_CARD, TABLE_HEAD } from '../data/parts';
import { IMPORT_FIELDS, complianceMapped, nameMapped, repeatedFields, type Choices } from '../../lib/import-model';
import type { ImportSummary } from '../../lib/imports-api';
import { formatCount, formatWhen } from './import-text';

/**
 * A2 and A3: the export's mapping table, one row per column of the file: the
 * column's name, the Kasuwa field (a native select of the fields the caller
 * may edit, prefilled from the server's suggestion) and the row's status.
 *
 * THE HEADER IS THE SERVER'S ANSWER. The page never parses the file (D-P21),
 * so the column names, and the guess at what each one is, come from the API;
 * until they arrive this draws the "reading your file" state, then the
 * "still connecting" offer of low-bandwidth mode. No cell of the file reaches
 * the page, so the design's Sample values column is drawn (in the Data
 * management frame) in its empty state.
 *
 * THE STATUS IS REAL: matched automatically (the server's suggestion,
 * unchanged), from a previous import, chosen by the person, not imported, or
 * used twice. The summary line counts the same four.
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

type RowStatus = 'auto' | 'template' | 'chosen' | 'skipped' | 'repeated';

const STATUS: Readonly<Record<RowStatus, { icon: IconName; tone: string; label: MessageId }>> = {
  auto: { icon: 'check_circle', tone: 'text-success-text', label: 'import.map.status.auto' },
  template: { icon: 'bookmark', tone: 'text-success-text', label: 'import.map.status.template' },
  chosen: { icon: 'edit', tone: 'text-primary-text', label: 'import.map.status.chosen' },
  skipped: { icon: 'do_not_disturb_on', tone: 'text-text-2', label: 'import.map.status.skipped' },
  repeated: { icon: 'error', tone: 'text-danger-text', label: 'import.map.status.repeated' },
};

function statusOf(choice: string | null, index: number, suggested: Choices | null, reused: boolean, repeated: readonly string[]): RowStatus {
  if (choice !== null && repeated.includes(choice)) return 'repeated';
  if (choice === null) return 'skipped';
  if (reused) return 'template';
  if (suggested !== null && suggested[index] === choice) return 'auto';
  return 'chosen';
}

/** The table's columns: the design's 170 / 1fr / 1.1fr / 200, and the Sample values column only where it is drawn. */
const GRID_DESIGNED = 'md:grid md:grid-cols-[170px_minmax(0,1fr)_minmax(0,1.1fr)_200px]';
const GRID_PLAIN = 'md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_200px]';

export function MappingStep({
  t,
  locale,
  designed,
  headers,
  choices,
  suggested,
  readOnly,
  reusable,
  reuseId,
  busy,
  slow,
  onChoice,
  onReuse,
}: {
  t: Translator;
  locale: string;
  designed: boolean;
  /** `null` while the server is still reading the first row. */
  headers: readonly string[] | null;
  choices: Choices | null;
  /** The server's first suggestion, to tell "matched automatically" from "chosen". */
  suggested: Choices | null;
  readOnly: ReadonlySet<string>;
  reusable: readonly ImportSummary[];
  reuseId: string;
  busy: boolean;
  slow: boolean;
  onChoice: (index: number, field: string | null) => void;
  onReuse: (importId: string) => void;
}) {
  const reuseSelect = useId();
  const reading = headers === null || choices === null;
  if (reading) {
    return (
      <section aria-busy="true" className="flex flex-col gap-3">
        {slow ? <StillConnecting t={t} /> : null}
        <p role="status" className="m-0 text-body-sm text-text-2">
          {t.t('import.map.reading')}
        </p>
        <div aria-hidden="true" className={`${TABLE_CARD} flex flex-col`}>
          <span className={`${TABLE_HEAD} flex`} />
          {Array.from({ length: 4 }, (_, index) => (
            <span key={index} className="flex h-14 items-center gap-3.5 border-b border-border px-4 last:border-b-0">
              <span className="h-3.5 w-32 rounded-sm bg-surface-sunken" />
              <span className="h-[38px] flex-1 rounded-md bg-surface-sunken" />
            </span>
          ))}
        </div>
      </section>
    );
  }

  const named = nameMapped(choices);
  const repeated = repeatedFields(choices);
  const fields = IMPORT_FIELDS.filter((field) => !readOnly.has(field));
  const reused = reuseId !== '';
  const statuses = choices.map((choice, index) => statusOf(choice, index, suggested, reused, repeated));
  const count = (status: RowStatus) => formatCount(locale, statuses.filter((value) => value === status).length);
  const grid = designed ? GRID_DESIGNED : GRID_PLAIN;

  return (
    <section className="flex flex-col gap-5" aria-labelledby={`${reuseSelect}-title`}>
      <h2 id={`${reuseSelect}-title`} className="sr-only">
        {t.t('import.map.title')}
      </h2>

      {named ? null : (
        <div role="note" data-testid="import-name-missing" className="flex gap-3 rounded-lg bg-danger-soft px-5 py-4 text-danger-text">
          <Icon name="error" size={20} className="mt-px shrink-0" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <b className="text-body-md font-bold">{t.t('import.map.missing.title')}</b>
            <span className="text-body-sm text-text">{t.t('import.map.missing.body')}</span>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {reusable.length === 0 ? null : (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <label htmlFor={reuseSelect} className="text-meta font-semibold">
              {t.t('import.map.reuse.label')}
            </label>
            <NativeSelect id={reuseSelect} data-testid="import-reuse" value={reuseId} disabled={busy} onChange={(event) => onReuse(event.target.value)} className="w-full sm:w-auto">
              <option value="">{t.t('import.map.reuse.none')}</option>
              {reusable.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {`${entry.filename ?? ''} · ${formatWhen(locale, entry.createdAt)}`}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
        <ul data-testid="import-required" aria-label={t.t('import.required.title')} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          <li data-required="displayName" data-met={named ? 'true' : 'false'}>
            <CheckChip met={named}>
              {t.t('import.required.chip')}
              <span className="sr-only">{` ${t.t('import.required.name')}. ${t.t(named ? 'import.required.done' : 'import.required.todo')}`}</span>
            </CheckChip>
          </li>
        </ul>
        <span className="flex-1" />
        <span data-testid="import-map-summary" className="text-meta text-text-2">
          {t.t('import.map.summary', { auto: count('auto'), template: count('template'), chosen: count('chosen'), skipped: count('skipped') })}
        </span>
      </div>

      <div role="table" aria-label={t.t('import.map.title')} className={TABLE_CARD}>
        <div role="rowgroup" className="hidden md:block">
          <div role="row" className={`${TABLE_HEAD} ${grid}`}>
            <span role="columnheader">{t.t('import.map.column')}</span>
            {designed ? <span role="columnheader">{t.t('import.map.sample')}</span> : null}
            <span role="columnheader">{t.t('import.map.field')}</span>
            <span role="columnheader">{t.t('import.map.status')}</span>
          </div>
        </div>
        <div role="rowgroup">
          {headers.map((header, index) => (
            <ColumnRow
              key={index}
              t={t}
              grid={grid}
              designed={designed}
              index={index}
              header={header}
              choice={choices[index] ?? null}
              status={statuses[index] ?? 'skipped'}
              fields={fields}
              onChoice={onChoice}
            />
          ))}
        </div>
      </div>

      {complianceMapped(choices) ? (
        <p data-testid="import-compliance" className="m-0 flex items-start gap-2 rounded-lg bg-info-soft px-4 py-3 text-body-sm text-info-text">
          <Icon name="info" size={20} className="shrink-0" />
          {t.t('import.compliance.restrict_only')}
        </p>
      ) : null}

      {repeated.length === 0 ? null : (
        <p role="alert" data-testid="import-mapping-note" className="m-0 flex items-start gap-2 text-body-sm text-danger-text">
          <Icon name="error" size={20} className="shrink-0" />
          {t.t('import.error.duplicate_mapping')}
        </p>
      )}
    </section>
  );
}

function ColumnRow({
  t,
  grid,
  designed,
  index,
  header,
  choice,
  status,
  fields,
  onChoice,
}: {
  t: Translator;
  grid: string;
  designed: boolean;
  index: number;
  header: string;
  choice: string | null;
  status: RowStatus;
  fields: readonly string[];
  onChoice: (index: number, field: string | null) => void;
}) {
  const id = useId();
  const bad = status === 'repeated';
  const shown = STATUS[status];
  // A custom key the server suggested is kept as an option, so the select can show it.
  const custom = choice !== null && !(IMPORT_FIELDS as readonly string[]).includes(choice) ? choice : null;
  return (
    <div
      role="row"
      data-map-column={index}
      data-map-status={status}
      className={`flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0 md:min-h-14 md:items-center md:gap-3.5 md:py-1.5 ${grid} ${bad ? 'bg-danger-soft' : 'bg-surface'}`}
    >
      <span role="rowheader" id={`${id}-header`} data-record-text="" dir="auto" className="min-w-0 truncate font-mono text-meta font-semibold">
        {header}
      </span>
      {designed ? (
        <span role="cell" className="hidden text-caption font-normal text-text-muted md:block" title={t.t('import.map.sample.none')}>
          <span aria-hidden="true">—</span>
          <span className="sr-only">{t.t('import.map.sample.none')}</span>
        </span>
      ) : null}
      <span role="cell" className="min-w-0">
        <span id={`${id}-label`} className="sr-only">
          {t.t('import.map.fieldFor')}
        </span>
        <NativeSelect
          compact
          invalid={bad}
          data-map-field={index}
          aria-labelledby={`${id}-label ${id}-header`}
          value={choice ?? ''}
          onChange={(event) => onChoice(index, event.target.value === '' ? null : event.target.value)}
        >
          <option value="">{t.t('import.map.skip')}</option>
          {fields.map((field) => (
            <option key={field} value={field}>
              {t.t(`import.mapfield.${field}` as MessageId)}
            </option>
          ))}
          {custom === null ? null : <option value={custom}>{t.t('import.mapfield.custom', { name: custom.replace(/^custom\./, '') })}</option>}
        </NativeSelect>
      </span>
      <span role="cell" className={`flex min-w-0 items-center gap-1.5 text-caption font-semibold ${shown.tone}`}>
        <Icon name={shown.icon} size={18} className="shrink-0" />
        <span className="truncate">{t.t(shown.label)}</span>
      </span>
    </div>
  );
}
