import { describe, expect, it } from 'vitest';
import {
  MAX_FILE_BYTES,
  POLL_MAX_MS,
  choicesFrom,
  columnLetter,
  complianceMapped,
  declare,
  importIdFromUrl,
  isTerminal,
  nameMapped,
  pollDelay,
  refusedFields,
  repeatedFields,
  toColumns,
  withChoice,
  withoutFields,
} from './import-model';

describe('the import mapping checklist', () => {
  it('needs a name, and only a name', () => {
    expect(nameMapped(['phones', 'emails'])).toBe(false);
    expect(nameMapped(['phones', 'familyName'])).toBe(true);
    expect(nameMapped(['givenNames'])).toBe(true);
    expect(nameMapped(['displayName', null])).toBe(true);
    expect(nameMapped([null, null])).toBe(false);
  });

  it('refuses a field mapped twice, except phones, emails and tags', () => {
    expect(repeatedFields(['status', 'givenNames', 'status'])).toEqual(['status']);
    expect(repeatedFields(['phones', 'phones', 'emails', 'emails', 'tags', 'tags'])).toEqual([]);
    expect(repeatedFields([null, null])).toEqual([]);
  });

  it('flags a compliance field, which only restricts', () => {
    expect(complianceMapped(['dnd'])).toBe(true);
    expect(complianceMapped(['consentState', null])).toBe(true);
    expect(complianceMapped(['whatsappOptIn'])).toBe(true);
    expect(complianceMapped(['status', 'phones'])).toBe(false);
  });

  it('prefills one choice per header from the served columns, and sends every header', () => {
    const choices = choicesFrom(3, [{ index: 0, field: 'givenNames' }, { index: 2, field: 'phones' }, { index: 9, field: 'tags' }]);
    expect(choices).toEqual(['givenNames', null, 'phones']);
    expect(toColumns(withChoice(choices, 1, 'emails'))).toEqual([
      { index: 0, field: 'givenNames' },
      { index: 1, field: 'emails' },
      { index: 2, field: 'phones' },
    ]);
    expect(choicesFrom(2, null)).toEqual([null, null]);
  });

  it('drops a refused field from the choices and reads the field from the 403, never a column', () => {
    expect(withoutFields(['status', 'phones', 'status'], new Set(['status']))).toEqual([null, 'phones', null]);
    expect(
      refusedFields([
        { path: 'status', code: 'field_not_editable' },
        { path: 'custom.credit_limit__c', code: 'field_not_editable' },
        { path: 'columns.2.field', code: 'duplicate_mapping' },
      ]),
    ).toEqual(['status', 'custom.credit_limit__c']);
    expect(refusedFields(undefined)).toEqual([]);
  });
});

describe('what is declared, and what is refused before anything is sent', () => {
  it('declares a CSV by its name, whatever type the browser gave it', () => {
    expect(declare('a.csv', 'text/csv', 10)).toEqual({ ok: true, contentType: 'text/csv' });
    expect(declare('A.CSV', '', 10)).toEqual({ ok: true, contentType: 'text/csv' });
    expect(declare('a.csv', 'application/vnd.ms-excel', 10)).toEqual({ ok: true, contentType: 'application/vnd.ms-excel' });
    expect(declare('a.csv', 'application/octet-stream', 10)).toEqual({ ok: true, contentType: 'text/csv' });
  });

  it('refuses a spreadsheet, however it is typed', () => {
    expect(declare('a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 10)).toEqual({ ok: false, reason: 'unsupported_type' });
    expect(declare('a.xls', 'application/vnd.ms-excel', 10)).toEqual({ ok: false, reason: 'unsupported_type' });
  });

  it('accepts exactly 25 MiB and refuses one byte more', () => {
    expect(MAX_FILE_BYTES).toBe(25 * 1_048_576);
    expect(declare('a.csv', 'text/csv', MAX_FILE_BYTES).ok).toBe(true);
    expect(declare('a.csv', 'text/csv', MAX_FILE_BYTES + 1)).toEqual({ ok: false, reason: 'file_too_large' });
  });
});

describe('polling', () => {
  it('grows by half from the first wait and stops growing at 20 seconds', () => {
    const waits = [0, 1, 2, 3].map((attempt) => pollDelay(attempt));
    expect(waits).toEqual([600, 900, 1350, 2025]);
    expect(pollDelay(40)).toBe(POLL_MAX_MS);
  });

  it('never waits under 400 ms, whatever the base', () => {
    expect(pollDelay(0, 10)).toBe(400);
  });

  it('ends on a final status only', () => {
    for (const status of ['finished', 'failed', 'rejected', 'cancelled', 'expired'] as const) expect(isTerminal(status)).toBe(true);
    for (const status of ['awaiting_upload', 'reading_header', 'awaiting_mapping', 'queued', 'running'] as const) expect(isTerminal(status)).toBe(false);
  });
});

describe('small readers', () => {
  it('names a column as a spreadsheet does', () => {
    expect([0, 6, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(['A', 'G', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('reads an import id from a query only when it is a uuid', () => {
    const id = '5e1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6a01';
    expect(importIdFromUrl(id)).toBe(id);
    expect(importIdFromUrl(id.toUpperCase())).toBe(id);
    expect(importIdFromUrl('not-an-id')).toBeUndefined();
    expect(importIdFromUrl([id])).toBeUndefined();
    expect(importIdFromUrl(undefined)).toBeUndefined();
  });
});
