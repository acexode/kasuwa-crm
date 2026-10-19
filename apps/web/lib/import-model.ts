/**
 * The pure rules of the P28 import wizard (T-0096): the vocabulary the
 * contract fixes, the mapping checklist, the polling backoff and the choice of
 * a content type. No I/O and no `'use client'`, so the server page and the
 * screen decide the same way (and the Contacts page reads `importIdFromUrl`).
 *
 * NOTHING HERE READS A FILE. The browser never parses the CSV (D-P21, I4): the
 * header row is the SERVER's answer, so every rule below works from the
 * headers and the suggestion the API served, never from a cell.
 */

/** `x-kasuwa-import-limits.maxFileBytes`: 25 MiB. A larger file is refused BEFORE createImport (A1). */
export const MAX_FILE_BYTES = 26_214_400;

export const IMPORT_STATUSES = [
  'awaiting_upload',
  'reading_header',
  'awaiting_mapping',
  'queued',
  'running',
  'finished',
  'failed',
  'rejected',
  'cancelled',
  'expired',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** A job in one of these never changes again: polling stops. */
const TERMINAL: readonly ImportStatus[] = ['finished', 'failed', 'rejected', 'cancelled', 'expired'];

export function isTerminal(status: ImportStatus): boolean {
  return TERMINAL.includes(status);
}

/** The contract's `ImportRowErrorCode`, closed. */
export const ROW_ERROR_CODES = [
  'required',
  'invalid_value',
  'invalid_phone',
  'invalid_email',
  'too_long',
  'unknown_value',
  'unknown_field',
  'custom_too_large',
  'possible_duplicate',
  'consent_grant_refused',
  'field_not_editable',
  'row_too_large',
  'too_many_rows',
] as const;
export type RowErrorCode = (typeof ROW_ERROR_CODES)[number];

/** The standard contact fields a column may set (`ImportField`'s enum). Never an id, owner, account or timestamp. */
export const IMPORT_FIELDS = [
  'displayName',
  'givenNames',
  'familyName',
  'companyName',
  'phones',
  'emails',
  'status',
  'source',
  'tags',
  'preferredLanguage',
  'preferredChannel',
  'state',
  'lga',
  'dnd',
  'whatsappOptIn',
  'consentState',
] as const;
export type ImportFieldName = (typeof IMPORT_FIELDS)[number];

/** The fields more than one column may fill (putImportMapping). */
const REPEATABLE: readonly string[] = ['phones', 'emails', 'tags'];
/** Any one of these satisfies the required `displayName`. */
const NAME_FIELDS: readonly string[] = ['displayName', 'givenNames', 'familyName'];
/** Mapped, these only ever RESTRICT (D-P28, D-L148). */
const COMPLIANCE: readonly string[] = ['dnd', 'whatsappOptIn', 'consentState'];

export const DEFAULT_COUNTRIES = ['NG', 'GH', 'KE', 'ZA'] as const;
export type DefaultCountry = (typeof DEFAULT_COUNTRIES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A uuid from a query string, or `undefined`: never a value the page did not check. */
export function importIdFromUrl(value: string | readonly string[] | undefined): string | undefined {
  const one = typeof value === 'string' ? value : undefined;
  return one !== undefined && UUID.test(one) ? one.toLowerCase() : undefined;
}

// ---------------------------------------------------------------------------
// The mapping: one choice per header, `null` for "do not import"
// ---------------------------------------------------------------------------

export type Choices = readonly (string | null)[];

/** One choice per header, from the columns the API served (suggested or saved); an unnamed column is not imported. */
export function choicesFrom(
  headerCount: number,
  columns: readonly { readonly index: number; readonly field: string | null }[] | null,
): Choices {
  const choices: (string | null)[] = Array.from({ length: headerCount }, () => null);
  for (const column of columns ?? []) {
    if (column.index >= 0 && column.index < headerCount) choices[column.index] = column.field;
  }
  return choices;
}

export function withChoice(choices: Choices, index: number, field: string | null): Choices {
  return choices.map((current, position) => (position === index ? field : current));
}

/** The checklist's one item: a name, from `displayName`, a given name or a family name. */
export function nameMapped(choices: Choices): boolean {
  return choices.some((field) => field !== null && NAME_FIELDS.includes(field));
}

/** Fields mapped from more than one column that may not be (the API would answer `duplicate_mapping`). */
export function repeatedFields(choices: Choices): readonly string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const field of choices) {
    if (field === null || REPEATABLE.includes(field)) continue;
    if (seen.has(field)) repeated.add(field);
    seen.add(field);
  }
  return [...repeated];
}

export function complianceMapped(choices: Choices): boolean {
  return choices.some((field) => field !== null && COMPLIANCE.includes(field));
}

/** The body's `columns`: every header, its field or `null`. */
export function toColumns(choices: Choices): { index: number; field: string | null }[] {
  return choices.map((field, index) => ({ index, field }));
}

/** A field the API refused as not editable, with its choices cleared and the field returned. */
export function withoutFields(choices: Choices, fields: ReadonlySet<string>): Choices {
  return choices.map((field) => (field !== null && fields.has(field) ? null : field));
}

/**
 * The fields a `403` names: `details[].path` is the field itself (`status`,
 * `custom.<key>`), never a column (the contract's ImportMappingNotPermitted).
 */
export function refusedFields(details: readonly { readonly path: string; readonly code: string }[] | undefined): readonly string[] {
  return (details ?? []).filter((detail) => detail.code === 'field_not_editable').map((detail) => detail.path);
}

/** A spreadsheet's letter for a zero-based column: 0 is A, 25 is Z, 26 is AA. */
export function columnLetter(index: number): string {
  let rest = index;
  let letters = '';
  do {
    letters = String.fromCharCode(65 + (rest % 26)) + letters;
    rest = Math.floor(rest / 26) - 1;
  } while (rest >= 0);
  return letters;
}

// ---------------------------------------------------------------------------
// Polling: a growing interval, never a loop (I8)
// ---------------------------------------------------------------------------

export const POLL_MIN_MS = 600;
export const POLL_MAX_MS = 20_000;
const POLL_GROWTH = 1.5;

/** The wait before poll `attempt` (0 is the first): grows by half each time, within 400 ms and 20 s. */
export function pollDelay(attempt: number, base: number = POLL_MIN_MS): number {
  return Math.min(POLL_MAX_MS, Math.round(Math.max(base, 400) * POLL_GROWTH ** Math.max(0, attempt)));
}

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

export type Declared =
  | { readonly ok: true; readonly contentType: 'text/csv' | 'application/csv' | 'application/vnd.ms-excel' }
  | { readonly ok: false; readonly reason: 'unsupported_type' | 'file_too_large' };

/**
 * What to declare for a chosen file, or why it is refused before anything is
 * sent. CSV only, by the file's name: Windows browsers type a `.csv` as
 * `application/vnd.ms-excel` (admitted only with the `.csv` name) and some
 * send no type at all. A spreadsheet is never uploaded.
 */
export function declare(name: string, type: string, sizeBytes: number): Declared {
  if (!/\.csv$/i.test(name)) return { ok: false, reason: 'unsupported_type' };
  if (sizeBytes > MAX_FILE_BYTES) return { ok: false, reason: 'file_too_large' };
  if (type === 'application/csv' || type === 'application/vnd.ms-excel') return { ok: true, contentType: type };
  return { ok: true, contentType: 'text/csv' };
}
