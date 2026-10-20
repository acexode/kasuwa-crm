'use client';

import { useId, type ReactNode } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import type { ComplianceField, ContactMergePreview, MergeSide, PreviewContact } from '../../lib/duplicates-api';
import { formatDay } from '../import/import-text';
import {
  COMPLIANCE_LABELS,
  FIELD_LABELS,
  complianceLabel,
  complianceRows,
  fieldValue,
  rowsOf,
  type ComplianceRow,
  type FieldRow,
  type FieldValue,
} from './merge-model';

/**
 * C1's comparison, to the export: one `<table>` with a Field column, one
 * column per record (a header card holding the main-record radio, when the
 * record was created and how), and the success-soft "Merged record" column
 * showing what will be saved.
 *
 * The columns stay in the pair's order whichever record is the main one: the
 * preview is read the other way round when the main record changes (survivor
 * and merged swap), and each column finds its side by id. Merges are pairwise
 * (D-L146); with `merge_three_way` on, a third column is drawn in its disabled
 * state, holding no record.
 *
 * THREE KINDS OF ROW, drawn differently on purpose:
 *   - a CHOICE: one named radio group per field, spanning the record columns,
 *     the person's pick (or the API's default) selected;
 *   - WITHHELD: either side's field security hides it, so no value and no
 *     choice is drawn, and none of the value is in the page;
 *   - LOCKED: readable on both sides but not editable by the caller (or
 *     refused by the API since), so both values are shown and neither can be
 *     chosen: a merge is never a way round field security.
 *
 * Compliance rows are locked at the most restrictive outcome whichever record
 * is the main one (D-P28): each record's value is shown, the outcome is in the
 * merged column, and nothing is chosen.
 */

const LETTERS = ['A', 'B', 'C'] as const;

function Value({ t, value }: { t: Translator; value: FieldValue }) {
  if (value.kind === 'empty') return <span className="text-text-muted">{t.t('records.cell.empty')}</span>;
  if (value.kind === 'label') return <span>{t.t(value.id)}</span>;
  return (
    <span className="flex min-w-0 flex-wrap gap-x-2">
      {value.parts.map((part, index) => (
        <span key={index} data-record-text="" dir="auto" className="min-w-0 break-all">
          {part}
        </span>
      ))}
    </span>
  );
}

function same(a: FieldValue, b: FieldValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One record's pick: a 40px pill, primary-edged on primary-soft when chosen. */
function Pick({
  t,
  letter,
  value,
  name,
  side,
  checked,
  disabled,
  onChange,
}: {
  t: Translator;
  letter: string;
  value: FieldValue;
  name: string;
  side: MergeSide;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className={`flex min-h-control-md min-w-0 items-center gap-2.5 rounded-md border px-3 py-1.5 text-body-sm ${
        checked ? 'border-primary bg-primary-soft' : 'border-transparent'
      } ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span className="relative flex size-4.5 shrink-0 items-center justify-center">
        <input
          type="radio"
          name={name}
          data-merge-side={side}
          checked={checked}
          disabled={disabled}
          onChange={onChange}
          className="peer absolute inset-0 m-0 cursor-pointer appearance-none rounded-full border-2 border-border-strong checked:border-primary focus-visible:ring-focus disabled:cursor-not-allowed"
        />
        <span aria-hidden="true" className="pointer-events-none hidden size-2 rounded-full bg-primary peer-checked:block" />
      </span>
      <span className="sr-only">{t.t('duplicates.record.label', { letter })}</span>
      <span className="min-w-0 truncate">
        <Value t={t} value={value} />
      </span>
    </label>
  );
}

export interface CompareColumn {
  readonly id: string;
  readonly side: MergeSide;
}

export function MergeCompare({
  t,
  locale,
  preview,
  columns,
  names,
  mainId,
  mainName,
  overrides,
  refused,
  disabled,
  threeWay,
  onMain,
  onPick,
}: {
  t: Translator;
  locale: string;
  /** `null` while the preview for this main record is being read. */
  preview: ContactMergePreview | null;
  /** The pair, in its own order, each with the side it is in the preview. */
  columns: readonly [CompareColumn, CompareColumn];
  names: Readonly<Record<string, string | null>>;
  mainId: string;
  /** The main-record radios' group name. */
  mainName: string;
  overrides: Readonly<Record<string, MergeSide>>;
  refused: readonly string[];
  disabled: boolean;
  /** `merge_three_way`: draw the disabled third record slot. */
  threeWay: boolean;
  onMain: (id: string) => void;
  onPick: (field: string, side: MergeSide) => void;
}) {
  const group = useId();
  const rows = preview === null ? [] : rowsOf(preview, overrides, refused);
  const contact = (column: CompareColumn): PreviewContact | null => (preview === null ? null : preview[column.side]);
  const recordColumns = threeWay ? 3 : 2;

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface md:overflow-x-auto">
      <table data-testid="merge-compare" className="w-full table-fixed border-separate border-spacing-0 text-body-sm max-md:block md:min-w-[640px]">
        <caption className="sr-only">{t.t('duplicates.merge.compare')}</caption>
        <colgroup className="max-md:hidden">
          <col className="w-[150px]" />
          {Array.from({ length: recordColumns + 1 }, (_, index) => (
            <col key={index} />
          ))}
        </colgroup>
        <thead className="max-md:block">
          <tr className="bg-surface-sunken max-md:grid max-md:grid-cols-2">
            <th scope="col" className="border-b border-border px-4 pb-3 pt-2.5 text-start align-bottom text-meta font-bold max-md:hidden">
              {t.t('duplicates.col.field')}
            </th>
            {columns.map((column, index) => {
              const main = column.id === mainId;
              const created = contact(column);
              return (
                <th key={column.id} scope="col" className="border-b border-border px-1.5 pb-2.5 pt-2.5 text-start align-top font-normal max-md:block">
                  <label
                    className={`flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-10 bg-surface px-3 py-2.5 ${
                      main ? 'border-2 border-primary bg-primary-soft' : 'border border-border'
                    } ${disabled ? 'cursor-not-allowed' : ''}`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="relative flex size-4.5 shrink-0 items-center justify-center">
                        <input
                          type="radio"
                          name={mainName}
                          data-main={column.id}
                          checked={main}
                          disabled={disabled}
                          onChange={() => onMain(column.id)}
                          className="peer absolute inset-0 m-0 cursor-pointer appearance-none rounded-full border-2 border-border-strong checked:border-primary focus-visible:ring-focus disabled:cursor-not-allowed"
                        />
                        <span aria-hidden="true" className="pointer-events-none hidden size-2 rounded-full bg-primary peer-checked:block" />
                      </span>
                      <b className="text-body-sm font-bold text-text">{t.t('duplicates.record.label', { letter: LETTERS[index] ?? '' })}</b>
                      {names[column.id] === undefined ? null : (
                        <span className="sr-only">{names[column.id] ?? t.t('duplicates.withheld')}</span>
                      )}
                    </span>
                    <span className="text-caption font-normal text-text-2">
                      {created === null ? ' ' : <RecordOrigin t={t} locale={locale} contact={created} />}
                    </span>
                    {main ? <span className="text-caption font-bold text-primary-text">{t.t('duplicates.col.main')}</span> : null}
                  </label>
                </th>
              );
            })}
            {threeWay ? (
              <th scope="col" data-merge-slot="third" className="border-b border-border px-1.5 pb-2.5 pt-2.5 text-start align-top font-normal max-md:hidden">
                <span aria-disabled="true" className="flex min-w-0 flex-col gap-0.5 rounded-10 border border-dashed border-border-strong bg-surface px-3 py-2.5 text-text-muted">
                  <span className="flex items-center gap-2">
                    <span aria-hidden="true" className="size-4.5 shrink-0 rounded-full border-2 border-border" />
                    <b className="text-body-sm font-bold">{t.t('duplicates.record.label', { letter: 'C' })}</b>
                  </span>
                  <span className="text-caption font-normal">{t.t('duplicates.third.body')}</span>
                </span>
              </th>
            ) : null}
            <th scope="col" className="border-b border-border px-1.5 pb-2.5 pt-2.5 text-start align-top font-normal max-md:col-span-2 max-md:block">
              <span className="flex min-h-full flex-col justify-end gap-0.5 rounded-10 bg-success-soft px-3 py-2.5">
                <b className="mt-auto text-body-sm font-bold text-success-text">{t.t('duplicates.result.title')}</b>
                <span className="text-caption font-normal text-text-2">{t.t('duplicates.result.body')}</span>
              </span>
            </th>
          </tr>
        </thead>
        <tbody className="max-md:block">
          {preview === null
            ? Array.from({ length: 5 }, (_, index) => (
                <tr key={index} aria-hidden="true">
                  <td colSpan={recordColumns + 2} className="border-b border-border px-4 py-3">
                    <span className="block h-7 rounded-md bg-surface-sunken" />
                  </td>
                </tr>
              ))
            : rows.map((row) => (
                <Row key={row.field} t={t} row={row} preview={preview} columns={columns} group={group} disabled={disabled} threeWay={threeWay} onPick={onPick} />
              ))}
        </tbody>
        {preview === null ? null : (
          <tbody data-testid="merge-compliance" className="max-md:block">
            {complianceRows(preview).map((row) => (
              <ComplianceTableRow key={row.field} t={t} row={row} preview={preview} columns={columns} threeWay={threeWay} />
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
}

function RecordOrigin({ t, locale, contact }: { t: Translator; locale: string; contact: PreviewContact }) {
  const created = t.t('duplicates.record.created', { date: formatDay(locale, contact.createdAt) });
  return (
    <>
      <time dateTime={contact.createdAt}>{created}</time>
      {contact.source === null || contact.source === undefined ? null : ` · ${t.t(`records.source.${contact.source}` as MessageId)}`}
    </>
  );
}

const CELL = 'border-b border-border px-1.5 py-1.5 align-middle max-md:block max-md:border-b-0';

function FieldHeader({ label, note }: { label: string; note?: ReactNode }) {
  return (
    <th scope="row" className="border-b border-border px-4 py-2 text-start align-middle font-normal max-md:col-span-2 max-md:block max-md:border-b-0 max-md:pb-0">
      <span className="flex flex-col">
        <b className="break-words text-body-sm font-bold">{label}</b>
        {note === undefined ? null : <span className="text-caption font-normal text-text-2">{note}</span>}
      </span>
    </th>
  );
}

function Row({
  t,
  row,
  preview,
  columns,
  group,
  disabled,
  threeWay,
  onPick,
}: {
  t: Translator;
  row: FieldRow;
  preview: ContactMergePreview;
  columns: readonly [CompareColumn, CompareColumn];
  group: string;
  disabled: boolean;
  threeWay: boolean;
  onPick: (field: string, side: MergeSide) => void;
}) {
  const label = t.t(FIELD_LABELS[row.field]);
  const values = columns.map((column) => fieldValue(preview[column.side], row.field)) as [FieldValue, FieldValue];
  const equal = row.kind !== 'withheld' && same(values[0], values[1]);
  const kept = row.kind === 'choice' && row.pick !== null ? fieldValue(preview[row.pick], row.field) : fieldValue(preview.survivor, row.field);
  return (
    <tr
      className="max-md:grid max-md:grid-cols-2 max-md:border-b max-md:border-border max-md:py-1.5"
      data-merge-field={row.field}
      {...(row.kind === 'withheld' ? { 'data-withheld': 'true' } : {})}
      {...(row.kind === 'locked' ? { 'data-locked': 'true' } : {})}
    >
      <FieldHeader label={label} note={equal ? t.t('duplicates.same') : row.kind === 'locked' ? t.t('duplicates.locked.short') : undefined} />
      <td colSpan={2} className={`${CELL} max-md:col-span-2`}>
        {row.kind === 'withheld' ? (
          <p className="m-0 flex items-center gap-2 px-3 text-body-sm text-text-2">
            <Icon name="lock" size={18} />
            {t.t('duplicates.withheld')}
          </p>
        ) : null}
        {row.kind === 'locked' ? (
          <div className="grid grid-cols-2 gap-3" title={t.t('duplicates.locked')}>
            {values.map((value, index) => (
              <span key={index} className="flex min-w-0 items-center gap-2 px-3 text-body-sm">
                <Icon name="lock" size={16} className="shrink-0 text-text-muted" />
                <span className="sr-only">{t.t('duplicates.record.label', { letter: LETTERS[index] ?? '' })}</span>
                <span className="min-w-0 truncate">
                  <Value t={t} value={value} />
                </span>
              </span>
            ))}
            <span className="sr-only">{t.t('duplicates.locked')}</span>
          </div>
        ) : null}
        {row.kind === 'choice' ? (
          <fieldset disabled={disabled} className="m-0 grid min-w-0 grid-cols-2 gap-3 border-0 p-0">
            <legend className="sr-only">{label}</legend>
            {columns.map((column, index) => (
              <Pick
                key={column.id}
                t={t}
                letter={LETTERS[index] ?? ''}
                value={values[index] ?? { kind: 'empty' }}
                name={`${group}-${row.field}`}
                side={column.side}
                checked={row.pick === column.side}
                disabled={disabled}
                onChange={() => onPick(row.field, column.side)}
              />
            ))}
          </fieldset>
        ) : null}
      </td>
      {threeWay ? (
        <td className={`${CELL} px-4 text-text-muted max-md:hidden`}>
          <span aria-hidden="true">—</span>
        </td>
      ) : null}
      <td className={`${CELL} px-4 font-bold max-md:col-span-2 max-md:flex max-md:gap-1.5`}>
        <span className="font-normal text-success-text md:hidden">{t.t('duplicates.result.title')}:</span>
        {row.kind === 'withheld' ? <span className="font-normal text-text-2">{t.t('duplicates.withheld')}</span> : <Value t={t} value={kept} />}
      </td>
    </tr>
  );
}

/** A record's own compliance value, drawn as words, or withheld. */
function recordCompliance(contact: PreviewContact, field: ComplianceField): ComplianceRow {
  const value = contact[field];
  const withheld = contact.withheldFields.includes(field) || value === undefined;
  return { field, withheld, value: withheld ? null : String(value) };
}

function ComplianceTableRow({
  t,
  row,
  preview,
  columns,
  threeWay,
}: {
  t: Translator;
  row: ComplianceRow;
  preview: ContactMergePreview;
  columns: readonly [CompareColumn, CompareColumn];
  threeWay: boolean;
}) {
  return (
    <tr data-merge-compliance={row.field} {...(row.withheld ? { 'data-withheld': 'true' } : {})} className="max-md:grid max-md:grid-cols-2 max-md:border-b max-md:border-border max-md:py-1.5">
      <FieldHeader label={t.t(COMPLIANCE_LABELS[row.field])} note={t.t('duplicates.compliance.kept')} />
      {columns.map((column) => {
        const own = recordCompliance(preview[column.side], row.field);
        return (
          <td key={column.id} className={`${CELL} px-4 text-text-2`}>
            <span className="flex items-center gap-2">
              <Icon name="lock" size={16} className="shrink-0 text-text-muted" />
              {own.withheld ? t.t('duplicates.withheld') : t.t(complianceLabel(own))}
            </span>
          </td>
        );
      })}
      {threeWay ? (
        <td className={`${CELL} px-4 text-text-muted max-md:hidden`}>
          <span aria-hidden="true">—</span>
        </td>
      ) : null}
      <td className={`${CELL} px-4 max-md:col-span-2 max-md:flex max-md:gap-1.5`}>
        <span className="text-success-text md:hidden">{t.t('duplicates.result.title')}:</span>
        {row.withheld ? (
          <span className="text-text-2">{t.t('duplicates.withheld')}</span>
        ) : (
          <span data-compliance-value={row.value ?? ''} className="font-bold">
            {t.t(complianceLabel(row))}
          </span>
        )}
      </td>
    </tr>
  );
}
