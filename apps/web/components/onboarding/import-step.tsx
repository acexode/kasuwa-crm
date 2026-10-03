'use client';

import { useId, useRef, useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { FIELD, QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import {
  KASUWA_IMPORT_FIELDS,
  guessField,
  summariseCsv,
  type KasuwaImportField,
} from '../../lib/csv-columns';
import { directionOf, rovingIndex } from '../../lib/roving';
import { StepHeading } from './onboarding-shell';

export const IMPORT_SOURCES = ['zoho', 'salesforce', 'hubspot', 'csv'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export interface CsvMapping {
  readonly fileName: string;
  readonly rows: number;
  readonly columns: readonly { readonly name: string; readonly field: KasuwaImportField | null }[];
}

export function columnsToFix(mapping: CsvMapping | null): number {
  return mapping === null ? 0 : mapping.columns.filter((column) => column.field === null).length;
}

/**
 * `P01/5.4` — bring contacts and deals.
 *
 * The import itself is M20/M21's; T-0018 wires submission. What is here is
 * the part the board draws: choose a source, and for a CSV, map columns with
 * the ones we could not guess left visibly unmapped ("one field left to fix").
 * Only the header row and a row count are read, in the browser; no customer
 * row is parsed, shown or kept.
 *
 * Excel is named on the board. Reading `.xlsx` needs a parser library, which
 * would be a new dependency on a 256 kbps critical path, so the help line asks
 * for CSV instead of pretending to accept a file it cannot read.
 */
export function ImportStep({
  t,
  source,
  onSource,
  mapping,
  onMapping,
}: {
  t: Translator;
  source: ImportSource;
  onSource: (next: ImportSource) => void;
  mapping: CsvMapping | null;
  onMapping: (next: CsvMapping | null) => void;
}) {
  const id = useId();
  const groupRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [crmUnavailable, setCrmUnavailable] = useState(false);

  const sourceName = (value: ImportSource) => t.t(`import.source.${value}` as MessageId);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = IMPORT_SOURCES.indexOf(source);
    const next = rovingIndex(event.key, index, IMPORT_SOURCES.length, directionOf(groupRef.current));
    const target = next === null ? undefined : IMPORT_SOURCES[next];
    if (target === undefined) return;
    event.preventDefault();
    onSource(target);
    setCrmUnavailable(false);
    groupRef.current?.querySelector<HTMLElement>(`[data-source="${target}"]`)?.focus();
  }

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    try {
      const summary = summariseCsv(await file.text());
      if (summary.columns.length === 0) throw new Error('no header row');
      setUnreadable(false);
      onMapping({
        fileName: file.name,
        rows: summary.rows,
        columns: summary.columns.map((name) => ({ name, field: guessField(name) })),
      });
    } catch {
      // Never echo the file's contents into an error: it is customer data.
      setUnreadable(true);
      onMapping(null);
    }
  }

  function setField(index: number, field: KasuwaImportField | null) {
    if (mapping === null) return;
    onMapping({
      ...mapping,
      columns: mapping.columns.map((column, at) => (at === index ? { ...column, field } : column)),
    });
  }

  return (
    <>
      <StepHeading title={t.t('import.title')} subtitle={t.t('import.subtitle')} />

      <div
        ref={groupRef}
        role="radiogroup"
        aria-label={t.t('import.source')}
        onKeyDown={onKeyDown}
        className="grid grid-cols-2 gap-2 md:grid-cols-4"
      >
        {IMPORT_SOURCES.map((value) => {
          const checked = value === source;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              data-source={value}
              onClick={() => {
                onSource(value);
                setCrmUnavailable(false);
              }}
              className={`flex min-h-touch items-center gap-2 rounded-lg px-3 py-2 text-body-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                checked ? 'border-2 border-primary bg-primary-soft' : 'border border-border-strong bg-surface'
              }`}
            >
              {value === 'csv' ? <Icon name="description" size="sm" /> : null}
              {sourceName(value)}
            </button>
          );
        })}
      </div>

      {source === 'csv' ? (
        <div className="flex flex-col gap-3" data-testid="import-csv">
          {mapping === null ? (
            <label
              className={`${SECONDARY_BUTTON} cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus`}
            >
              <Icon name="upload_file" size="sm" />
              {t.t('import.csv.choose')}
              <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} className="sr-only" />
            </label>
          ) : (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
              <Icon name="check_circle" className="text-success-text" />
              <span className="flex flex-1 flex-col">
                <strong className="text-body-sm">{mapping.fileName}</strong>
                <span data-testid="import-summary" className="text-body-sm text-text-2">
                  {t.t('import.csv.summary', { rows: mapping.rows, fix: columnsToFix(mapping) })}
                </span>
              </span>
              <button
                type="button"
                onClick={() => {
                  onMapping(null);
                  if (fileRef.current !== null) fileRef.current.value = '';
                }}
                className={QUIET_BUTTON}
              >
                {t.t('import.csv.replace')}
              </button>
            </div>
          )}
          {unreadable ? (
            <p role="alert" className="text-body-sm text-danger-text">
              {t.t('import.csv.unreadable')}
            </p>
          ) : null}

          {mapping !== null ? (
            <table className="w-full border-collapse text-body-sm">
              <thead>
                <tr className="text-start text-caption text-text-muted">
                  <th scope="col" className="py-2 text-start font-semibold">
                    {t.t('import.csv.yourColumn')}
                  </th>
                  <th scope="col" className="py-2 text-start font-semibold">
                    {t.t('import.csv.kasuwaField')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {mapping.columns.map((column, index) => (
                  <tr key={`${column.name}-${index}`} className="border-t border-border">
                    <td className="py-2 pe-3 font-mono">{column.name}</td>
                    <td className="flex items-center gap-2 py-2">
                      {column.field === null ? <Icon name="help" size="sm" className="text-warning-text" /> : null}
                      <select
                        aria-label={t.t('import.csv.fieldFor', { column: column.name })}
                        aria-invalid={column.field === null}
                        data-column={column.name}
                        value={column.field ?? ''}
                        onChange={(event) =>
                          setField(index, event.target.value === '' ? null : (event.target.value as KasuwaImportField))
                        }
                        className={`${FIELD} flex-1`}
                      >
                        <option value="">{t.t('import.field.choose')}</option>
                        {KASUWA_IMPORT_FIELDS.map((field) => (
                          <option key={field} value={field}>
                            {t.t(`import.field.${field}` as MessageId)}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <p id={`${id}-csv-help`} className="text-caption text-text-muted">
            {t.t('import.csv.help')}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
          <p className="text-body-sm text-text-2">{t.t('import.crm.body', { name: sourceName(source) })}</p>
          <button
            type="button"
            data-testid="import-connect"
            onClick={() => setCrmUnavailable(true)}
            className={SECONDARY_BUTTON}
          >
            {t.t('import.crm.connect', { name: sourceName(source) })}
          </button>
          {crmUnavailable ? (
            <p role="status" className="rounded-lg bg-info-soft p-3 text-body-sm text-info-text">
              {t.t('import.crm.unavailable', { name: sourceName(source) })}
            </p>
          ) : null}
        </div>
      )}

      <p className="text-body-sm text-text-2">{t.t('import.startFresh')}</p>
    </>
  );
}
