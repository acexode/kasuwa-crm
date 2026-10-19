'use client';

import { useId } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import type { ContactMergePreview, MergeSide, PreviewContact } from '../../lib/duplicates-api';
import { COMPLIANCE_LABELS, FIELD_LABELS, complianceLabel, complianceRows, fieldValue, rowsOf, type DrawnField, type FieldRow, type FieldValue } from './merge-model';

/**
 * C1's comparison, as a table: a row header per field and, in the one cell, a
 * labelled radio group naming the two sides. At 360 px the two options stack,
 * so nothing scrolls sideways; from `sm` they sit side by side.
 *
 * THREE KINDS OF ROW, drawn differently on purpose:
 *   - a CHOICE: the person's pick, or the API's default, selected;
 *   - WITHHELD: either side's field security hides it, so no value and no
 *     choice is drawn, and none of the value is in the page;
 *   - LOCKED: readable on both sides but not editable by the caller (or
 *     refused by the API since), so both values are shown and neither can be
 *     chosen: a merge is never a way round field security.
 *
 * Compliance is a second table, because it is a different promise: locked at
 * the most restrictive outcome whichever record is the main one (D-P28).
 */

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

function Option({
  t,
  side,
  contact,
  field,
  name,
  checked,
  disabled,
  onChange,
}: {
  t: Translator;
  side: MergeSide;
  contact: PreviewContact;
  field: DrawnField;
  name: string;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <label className={`flex min-h-touch min-w-0 cursor-pointer items-start gap-3 rounded-md border p-2 ${checked ? 'border-primary bg-primary-soft' : 'border-border bg-surface'}`}>
      <input type="radio" name={name} data-merge-side={side} checked={checked} disabled={disabled} onChange={onChange} className="mt-1 h-5 w-5 shrink-0 accent-primary" />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-caption text-text-2">{t.t(side === 'survivor' ? 'duplicates.col.main' : 'duplicates.col.other')}</span>
        <Value t={t} value={fieldValue(contact, field)} />
      </span>
    </label>
  );
}

function ReadOnly({ t, preview, field }: { t: Translator; preview: ContactMergePreview; field: DrawnField }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {(['survivor', 'merged'] as const).map((side) => (
        <div key={side} className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-surface-sunken p-2">
          <span className="text-caption text-text-2">{t.t(side === 'survivor' ? 'duplicates.col.main' : 'duplicates.col.other')}</span>
          <Value t={t} value={fieldValue(preview[side], field)} />
        </div>
      ))}
    </div>
  );
}

function Row({
  t,
  row,
  preview,
  group,
  disabled,
  onPick,
}: {
  t: Translator;
  row: FieldRow;
  preview: ContactMergePreview;
  group: string;
  disabled: boolean;
  onPick: (field: string, side: MergeSide) => void;
}) {
  const label = t.t(FIELD_LABELS[row.field]);
  return (
    <tr
      data-merge-field={row.field}
      {...(row.kind === 'withheld' ? { 'data-withheld': 'true' } : {})}
      {...(row.kind === 'locked' ? { 'data-locked': 'true' } : {})}
      className="border-b border-border align-top last:border-b-0"
    >
      <th scope="row" className="w-1/3 min-w-0 break-words p-2 text-start text-body-sm font-semibold sm:w-1/4">
        {label}
      </th>
      <td className="min-w-0 p-2">
        {row.kind === 'withheld' ? (
          <p className="flex items-center gap-2 text-body-sm text-text-2">
            <Icon name="lock" size="sm" />
            {t.t('duplicates.withheld')}
          </p>
        ) : null}
        {row.kind === 'locked' ? (
          <div className="flex flex-col gap-2">
            <ReadOnly t={t} preview={preview} field={row.field} />
            <p className="flex items-center gap-2 text-caption text-text-2">
              <Icon name="lock" size="sm" />
              {t.t('duplicates.locked')}
            </p>
          </div>
        ) : null}
        {row.kind === 'choice' ? (
          <fieldset disabled={disabled} className="grid min-w-0 gap-2 sm:grid-cols-2">
            <legend className="sr-only">{label}</legend>
            {(['survivor', 'merged'] as const).map((side) => (
              <Option
                key={side}
                t={t}
                side={side}
                contact={preview[side]}
                field={row.field}
                name={`${group}-${row.field}`}
                checked={row.pick === side}
                disabled={disabled}
                onChange={() => onPick(row.field, side)}
              />
            ))}
          </fieldset>
        ) : null}
      </td>
    </tr>
  );
}

export function MergeCompare({
  t,
  preview,
  overrides,
  refused,
  disabled,
  onPick,
}: {
  t: Translator;
  preview: ContactMergePreview;
  overrides: Readonly<Record<string, MergeSide>>;
  refused: readonly string[];
  disabled: boolean;
  onPick: (field: string, side: MergeSide) => void;
}) {
  const group = useId();
  const rows = rowsOf(preview, overrides, refused);
  return (
    <div className="flex flex-col gap-4">
      <table data-testid="merge-compare" className="w-full table-fixed rounded-lg border border-border bg-surface">
        <caption className="sr-only">{t.t('duplicates.merge.compare')}</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">{t.t('duplicates.col.field')}</th>
            <th scope="col">{t.t('duplicates.col.value')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row key={row.field} t={t} row={row} preview={preview} group={group} disabled={disabled} onPick={onPick} />
          ))}
        </tbody>
      </table>
      <table data-testid="merge-compliance" className="w-full table-fixed rounded-lg border border-border bg-surface-sunken">
        <caption className="p-2 text-start text-body-sm font-bold">
          <span className="flex items-center gap-2">
            <Icon name="lock" size="sm" />
            {t.t('duplicates.compliance.title')}
          </span>
        </caption>
        <tbody>
          {complianceRows(preview).map((row) => (
            <tr key={row.field} data-merge-compliance={row.field} {...(row.withheld ? { 'data-withheld': 'true' } : {})} className="border-t border-border">
              <th scope="row" className="w-1/3 min-w-0 break-words p-2 text-start text-body-sm font-semibold sm:w-1/4">
                {t.t(COMPLIANCE_LABELS[row.field])}
              </th>
              <td className="min-w-0 p-2 text-body-sm">
                {row.withheld ? (
                  <span className="text-text-2">{t.t('duplicates.withheld')}</span>
                ) : (
                  <span data-compliance-value={row.value ?? ''} className="font-semibold">
                    {t.t(complianceLabel(row))}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p data-testid="merge-compliance-note" className="flex items-start gap-2 text-body-sm text-text-2">
        <Icon name="info" size="sm" />
        {t.t('duplicates.compliance.note')}
      </p>
    </div>
  );
}
