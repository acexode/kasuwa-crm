import type { MessageId } from '@kasuwa/i18n/bundle';
import type { RecordsError } from '../../lib/records-api';
import { ROW_ERROR_CODES } from '../../lib/import-model';
import { numberingLocale } from '../../lib/numbering';
import { dateFormatter, tidyMonth } from '../../lib/date-locale';
import { formatDateTime } from '../record/record-core';

/**
 * Words for what the import API answers (T-0096). Always by `code`, never by
 * `message`, and never a raw code on screen.
 */

/** The reasons a refusal can name in `details[].code` that have their own sentence. */
const DETAIL_REASONS = ['file_too_large', 'unsupported_type', 'mapping_incomplete', 'duplicate_mapping', 'unknown_reference', 'field_not_editable'] as const;

/**
 * The sentence for a refusal: the reason it names if there is one the screen
 * has a sentence for, else the error's own (`records.error.<code>`, the
 * network's included). A `403 not_permitted` that names a field is the field's
 * sentence; one that names none is plain "not permitted".
 */
export function refusalId(error: RecordsError): MessageId {
  const reason = error.details?.find((detail) => (DETAIL_REASONS as readonly string[]).includes(detail.code));
  if (reason !== undefined) return `import.error.${reason.code}` as MessageId;
  return `records.error.${error.code}` as MessageId;
}

/** The sentence for a row error's code; a code this build does not know is the generic one. */
export function rowErrorId(code: string): MessageId {
  return (ROW_ERROR_CODES as readonly string[]).includes(code) ? (`import.error.${code}` as MessageId) : 'import.error.other';
}

/** Day first in every English, "Sep" not "Sept" (`lib/date-locale.ts`, T-0143). */
function formatter(locale: string, options: Intl.DateTimeFormatOptions): { format: (at: Date) => string } {
  const inner = dateFormatter(locale, options);
  return { format: (at) => tidyMonth(locale, inner.format(at)) };
}

/**
 * A moment as the reader's clock shows it, with its zone named: a bare
 * "09:05" is useless to someone whose phone is in another zone, and BPO
 * rosters span WAT, EAT and SAST.
 */
export function formatWhen(locale: string, iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  // "20 Oct 15:00 WAT", as every record screen writes it; never "GMT+1" (T-0143).
  return formatDateTime(locale, iso);
}

export function formatCount(locale: string, value: number): string {
  try {
    return new Intl.NumberFormat(numberingLocale(locale)).format(value);
  } catch {
    return new Intl.NumberFormat('en').format(value);
  }
}

/** A day as the reader's calendar shows it ("12 Sep"), with the year when it is not this one. A date, not a moment: no zone. */
export function formatDay(locale: string, iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const sameYear = at.getFullYear() === new Date().getFullYear();
  return formatter(locale, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }).format(at);
}
