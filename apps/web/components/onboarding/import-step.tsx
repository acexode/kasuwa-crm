'use client';

import { useId, useRef, useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Button } from '@kasuwa/ui/components';
import { Icon } from '../icon';
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
              className={`flex items-center gap-2.5 rounded-10 px-3 py-3.5 text-start text-body-sm font-semibold text-text focus-visible:ring-focus ${
                checked ? 'border-2 border-primary bg-primary-soft' : 'border border-border-strong bg-surface hover:bg-surface-sunken'
              }`}
            >
              {/* The board's source badges: the tool's initial, or a sheet for CSV. */}
              <span
                aria-hidden="true"
                className="flex size-8 flex-shrink-0 items-center justify-center rounded-md bg-surface-sunken text-body-sm font-extrabold text-text-2"
              >
                {value === 'csv' ? <Icon name="table" size={20} /> : sourceName(value).charAt(0)}
              </span>
              {sourceName(value)}
            </button>
          );
        })}
      </div>

      {source === 'csv' ? (
        <div className="flex flex-col gap-3" data-testid="import-csv">
          {mapping === null ? (
            <label className="flex h-control-lg cursor-pointer items-center justify-center gap-2 rounded-md border border-border-strong bg-surface px-3.5 text-label text-text hover:bg-surface-sunken focus-within:ring-focus">
              <Icon name="upload_file" size={20} />
              {t.t('import.csv.choose')}
              <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} className="sr-only" />
            </label>
          ) : (
            <div className="flex items-center gap-2.5 rounded-10 border border-border bg-surface px-3.5 py-3">
              <Icon name="check_circle" size={22} className="text-success-text" />
              <span className="flex min-w-0 flex-1 flex-col">
                <strong className="truncate text-body-sm font-bold">{mapping.fileName}</strong>
                <span data-testid="import-summary" className="text-meta text-text-2">
                  {t.t('import.csv.summary', { rows: mapping.rows, fix: columnsToFix(mapping) })}
                </span>
              </span>
              <button
                type="button"
                onClick={() => {
                  onMapping(null);
                  if (fileRef.current !== null) fileRef.current.value = '';
                }}
                className="h-control-base rounded-md px-2.5 text-body-sm font-semibold text-primary-text hover:bg-primary-soft focus-visible:ring-focus"
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
            <div className="overflow-hidden rounded-10 border border-border bg-surface">
              <table className="w-full border-collapse text-body-sm">
                <thead>
                  <tr className="bg-surface-sunken text-caption font-bold uppercase tracking-wide text-text-2">
                    <th scope="col" className="w-1/2 px-3.5 py-2.5 text-start font-bold">
                      {t.t('import.csv.yourColumn')}
                    </th>
                    <th scope="col" aria-hidden="true" className="w-6 p-0" />
                    <th scope="col" className="w-1/2 px-3.5 py-2.5 text-start font-bold">
                      {t.t('import.csv.kasuwaField')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {mapping.columns.map((column, index) => {
                    const unmapped = column.field === null;
                    return (
                      <tr
                        key={`${column.name}-${index}`}
                        className={`border-t border-border ${unmapped ? 'bg-warning-soft' : ''}`}
                      >
                        <td className="truncate px-3.5 py-1 font-mono text-meta">{column.name}</td>
                        <td className="w-6 p-0 text-center" aria-hidden="true">
                          <Icon
                            name={unmapped ? 'help' : 'arrow_forward'}
                            size={18}
                            className={`${unmapped ? 'text-warning-text' : 'text-text-muted'} rtl:-scale-x-100`}
                          />
                        </td>
                        <td className="px-3.5 py-1">
                          {/* The board shows the field as text; it is a plain
                              select drawn as that text, so every row stays
                              changeable. */}
                          <span className="relative flex items-center">
                            <select
                              aria-label={t.t('import.csv.fieldFor', { column: column.name })}
                              aria-invalid={unmapped}
                              data-column={column.name}
                              value={column.field ?? ''}
                              onChange={(event) =>
                                setField(
                                  index,
                                  event.target.value === '' ? null : (event.target.value as KasuwaImportField),
                                )
                              }
                              className={`h-control-base w-full min-w-0 cursor-pointer appearance-none rounded-6 bg-transparent pe-7 ps-1 text-body-sm focus-visible:ring-focus ${
                                unmapped ? 'font-semibold text-warning-text' : 'text-text'
                              }`}
                            >
                              <option value="">{t.t('import.field.choose')}</option>
                              {KASUWA_IMPORT_FIELDS.map((field) => (
                                <option key={field} value={field}>
                                  {t.t(`import.field.${field}` as MessageId)}
                                </option>
                              ))}
                            </select>
                            <Icon
                              name="expand_more"
                              size={18}
                              className="pointer-events-none absolute end-1 text-text-muted"
                            />
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          <p id={`${id}-csv-help`} className="text-meta text-text-muted">
            {t.t('import.csv.help')}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
          <p className="text-body-sm text-text-2">{t.t('import.crm.body', { name: sourceName(source) })}</p>
          <Button data-testid="import-connect" onClick={() => setCrmUnavailable(true)} className="self-start px-4">
            {t.t('import.crm.connect', { name: sourceName(source) })}
          </Button>
          {crmUnavailable ? (
            <p role="status" className="rounded-10 bg-info-soft px-3.5 py-3 text-body-sm text-info-text">
              {t.t('import.crm.unavailable', { name: sourceName(source) })}
            </p>
          ) : null}
        </div>
      )}

      <p className="rounded-10 border border-dashed border-border-strong px-3.5 py-3 text-body-sm text-text-2">
        {t.t('import.startFresh')}
      </p>
    </>
  );
}
