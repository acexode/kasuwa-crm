import type { MessageId } from '@kasuwa/i18n/bundle';
import type { CustomField } from './custom-values-api';

/**
 * The pure half of the custom-value screens (T-0091): how a stored value is
 * drawn for a locale, how a typed one is encoded for the wire, and which keys a
 * save or a create carries. No React, no DOM, no network.
 *
 * MONEY AND DECIMALS ARE STRINGS, END TO END (CLAUDE.md 4). An amount is
 * minor units as an integer string; it is turned into a decimal string by
 * moving the point in the TEXT, handed to `Intl` as a string (which keeps every
 * digit), and typed major units are turned back the same way. No float and no
 * `Number` touches an amount or a decimal.
 */

export type CustomValues = Readonly<Record<string, unknown>>;

/** `custom.<key>`: how `withheldFields` and error details name a custom key. */
export function customPath(key: string): string {
  return `custom.${key}`;
}

export function isCustomWithheld(withheldFields: readonly string[], key: string): boolean {
  return withheldFields.includes(customPath(key));
}

const INTEGER = /^-?\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DIGITS = 18;

function digitCount(text: string): number {
  return text.replace(/\D/g, '').length;
}

/** `125000050` -> `1250000.50`, in text. `null` when it is not an integer string. */
export function minorToMajor(minor: string): string | null {
  if (!INTEGER.test(minor)) return null;
  const negative = minor.startsWith('-');
  const unsigned = (negative ? minor.slice(1) : minor).padStart(3, '0');
  return `${negative ? '-' : ''}${unsigned.slice(0, -2)}.${unsigned.slice(-2)}`;
}

/** Typed major units (`2500000.75`, `-12,5`) -> minor units as an integer string; `null` when not an amount. */
export function majorToMinor(text: string): string | null {
  const match = /^(-?)(\d+)(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (match === null) return null;
  const whole = (match[2] ?? '').replace(/^0+(?=\d)/, '');
  const minor = `${whole}${(match[3] ?? '').padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
  if (digitCount(minor) > MAX_DIGITS) return null;
  return minor === '0' ? '0' : `${match[1] ?? ''}${minor}`;
}

/** Typed decimal -> the contract's canonical form (`12.50` -> `12.5`); `null` when not a number. */
export function canonicalNumber(text: string): string | null {
  const match = /^(-?)(\d*)(?:[.,](\d*))?$/.exec(text.trim());
  if (match === null) return null;
  const whole = (match[2] ?? '').replace(/^0+/, '');
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  if (!/\d/.test(text)) return null;
  if (digitCount(`${whole}${fraction}`) > MAX_DIGITS) return null;
  const body = `${whole === '' ? '0' : whole}${fraction === '' ? '' : `.${fraction}`}`;
  return body === '0' ? '0' : `${match[1] ?? ''}${body}`;
}

// ---------------------------------------------------------------------------
// Showing a value
// ---------------------------------------------------------------------------

export type CustomView =
  | { readonly kind: 'empty' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'date'; readonly iso: string; readonly text: string }
  | { readonly kind: 'boolean'; readonly value: boolean };

const EMPTY: CustomView = { kind: 'empty' };

type DecimalString = `${number}`;

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(locale, options);
  } catch {
    return new Intl.NumberFormat('en', options);
  }
}

function dateFormat(locale: string): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeZone: 'UTC' };
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat('en', options);
  }
}

/** The value as a screen draws it, or `empty` for anything the definition does not describe (never drawn raw). */
export function describeCustom(field: CustomField, value: unknown, locale: string): CustomView {
  if (value === undefined || value === null) return EMPTY;
  switch (field.type) {
    case 'text':
      return typeof value === 'string' && value !== '' ? { kind: 'text', text: value } : EMPTY;
    case 'number': {
      if (typeof value !== 'string' || canonicalNumber(value) !== value) return EMPTY;
      const text = numberFormat(locale, { maximumFractionDigits: 20 }).format(value as DecimalString);
      return { kind: 'text', text };
    }
    case 'currency': {
      const minor = typeof value === 'object' && value !== null ? (value as { amountMinor?: unknown }).amountMinor : undefined;
      const major = typeof minor === 'string' ? minorToMajor(minor) : null;
      if (major === null || field.currency === null) return EMPTY;
      const text = numberFormat(locale, { style: 'currency', currency: field.currency }).format(major as DecimalString);
      return { kind: 'text', text };
    }
    case 'date': {
      const match = typeof value === 'string' && DATE.test(value) ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
      if (match === null || typeof value !== 'string') return EMPTY;
      const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      if (Number.isNaN(at)) return EMPTY;
      return { kind: 'date', iso: value, text: dateFormat(locale).format(at) };
    }
    case 'picklist': {
      const label = field.values.find((entry) => entry.value === value)?.label;
      return label === undefined ? EMPTY : { kind: 'text', text: label };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { kind: 'boolean', value } : EMPTY;
  }
}

// ---------------------------------------------------------------------------
// Typing a value: the draft and the wire
// ---------------------------------------------------------------------------

/** What each control holds, as text: a picklist value, `true`/`false`, a date, a decimal, a line. */
export type CustomDraft = Readonly<Record<string, string>>;

function draftText(field: CustomField, value: unknown): string {
  if (value === undefined || value === null) return '';
  switch (field.type) {
    case 'currency': {
      const minor = typeof value === 'object' ? (value as { amountMinor?: unknown }).amountMinor : undefined;
      return (typeof minor === 'string' ? minorToMajor(minor) : null) ?? '';
    }
    case 'boolean':
      return typeof value === 'boolean' ? String(value) : '';
    default:
      return typeof value === 'string' ? value : '';
  }
}

export function draftOfCustom(fields: readonly CustomField[], custom: CustomValues | undefined): CustomDraft {
  return Object.fromEntries(fields.map((field) => [field.apiName, draftText(field, custom?.[field.apiName])]));
}

type Encoded = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/** A typed text as the contract's encoding for the field; `null` is "no value". */
export function encodeCustom(field: CustomField, text: string): Encoded {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  switch (field.type) {
    case 'text':
      return /[\n\r\u2028\u2029]/.test(trimmed) || trimmed.length > 1000 ? { ok: false } : { ok: true, value: trimmed };
    case 'number': {
      const canonical = canonicalNumber(trimmed);
      return canonical === null ? { ok: false } : { ok: true, value: canonical };
    }
    case 'currency': {
      const minor = majorToMinor(trimmed);
      return minor === null || field.currency === null ? { ok: false } : { ok: true, value: { amountMinor: minor, currency: field.currency } };
    }
    case 'date':
      return DATE.test(trimmed) ? { ok: true, value: trimmed } : { ok: false };
    case 'picklist':
      return field.values.some((entry) => entry.value === trimmed) ? { ok: true, value: trimmed } : { ok: false };
    case 'boolean':
      return trimmed === 'true' || trimmed === 'false' ? { ok: true, value: trimmed === 'true' } : { ok: false };
  }
}

/** The served value in the same encoding `encodeCustom` makes, so the two compare. `undefined` when none. */
function servedValue(field: CustomField, value: unknown): unknown {
  const text = draftText(field, value);
  if (text === '') return undefined;
  const encoded = encodeCustom(field, text);
  return encoded.ok && encoded.value !== null ? encoded.value : undefined;
}

export interface CustomChange {
  /** Only the keys that changed; `null` clears. `null` here when nothing did. */
  readonly patch: Record<string, unknown> | null;
  /** Keys whose typed text is not a value of their type. */
  readonly invalid: readonly string[];
}

/**
 * A per-key merge of ONLY what the person changed. `skip` is every key the
 * caller must not send: withheld for this record, or told read-only.
 */
export function customPatch(
  fields: readonly CustomField[],
  served: CustomValues | undefined,
  draft: CustomDraft,
  skip: ReadonlySet<string>,
): CustomChange {
  const patch: Record<string, unknown> = {};
  const invalid: string[] = [];
  for (const field of fields) {
    if (skip.has(field.apiName)) continue;
    const text = draft[field.apiName] ?? '';
    const encoded = encodeCustom(field, text);
    if (!encoded.ok) {
      invalid.push(field.apiName);
      continue;
    }
    const before = servedValue(field, served?.[field.apiName]);
    if (encoded.value === null) {
      if (before !== undefined) patch[field.apiName] = null;
    } else if (JSON.stringify(encoded.value) !== JSON.stringify(before)) {
      patch[field.apiName] = encoded.value;
    }
  }
  return { patch: Object.keys(patch).length === 0 ? null : patch, invalid };
}

/** The values of a create: the filled ones only. Never a `null`, never an empty key. */
export function customValues(fields: readonly CustomField[], draft: CustomDraft, skip: ReadonlySet<string>): CustomChange {
  const values: Record<string, unknown> = {};
  const invalid: string[] = [];
  for (const field of fields) {
    if (skip.has(field.apiName)) continue;
    const encoded = encodeCustom(field, draft[field.apiName] ?? '');
    if (!encoded.ok) invalid.push(field.apiName);
    else if (encoded.value !== null) values[field.apiName] = encoded.value;
  }
  return { patch: Object.keys(values).length === 0 ? null : values, invalid };
}

/**
 * After a 409 the form is the fresh record with the person's own edits laid
 * back on top: a key they did not touch takes the fresh value.
 */
export function rebaseCustomDraft(
  fields: readonly CustomField[],
  seed: CustomValues | undefined,
  fresh: CustomValues | undefined,
  typed: CustomDraft,
): CustomDraft {
  const before = draftOfCustom(fields, seed);
  const after = draftOfCustom(fields, fresh);
  return Object.fromEntries(
    fields.map((field) => {
      const key = field.apiName;
      return [key, (typed[key] ?? '') === before[key] ? (after[key] ?? '') : (typed[key] ?? '')];
    }),
  );
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

interface Refusal {
  readonly details?: readonly { readonly path: string; readonly code: string }[];
}

/** What a screen says when a typed custom value is not a value of its type, before anything is sent. */
export const CUSTOM_INVALID: MessageId = 'custom.error.invalid_value';

const REASONS: Readonly<Record<string, MessageId>> = {
  invalid_value: 'custom.error.invalid_value',
  unknown_value: 'custom.error.invalid_value',
  currency_mismatch: 'custom.error.invalid_value',
  custom_too_large: 'custom.error.custom_too_large',
  unknown_field: 'custom.error.unknown_field',
  field_not_editable: 'custom.error.field_not_editable',
  field_withheld: 'custom.error.field_withheld',
};

function aboutCustom(path: string): boolean {
  return path === 'custom' || path.startsWith('custom.') || path === 'customEmpty';
}

/** The translated message for the custom-field refusal an error carries, or `null` when it carries none. */
export function customErrorId(error: Refusal | null | undefined): MessageId | null {
  for (const detail of error?.details ?? []) {
    const id = REASONS[detail.code];
    if (id !== undefined && aboutCustom(detail.path)) return id;
  }
  return null;
}

/** The keys a refusal named `field_not_editable`: read-only from now on, and never sent again. */
export function notEditableKeys(error: Refusal | null | undefined): string[] {
  const keys: string[] = [];
  for (const detail of error?.details ?? []) {
    const match = detail.code === 'field_not_editable' ? /^custom\.([^.]+)$/.exec(detail.path) : null;
    if (match?.[1] !== undefined) keys.push(match[1]);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// List filters
// ---------------------------------------------------------------------------

/** The option value that means "no value" on a custom filter; a picklist value can never contain `-`. */
export const IS_EMPTY = 'is-empty';

/** One value per key: a picklist value, `true`/`false`, or `is-empty`. */
export type CustomFilters = Readonly<Record<string, string>>;

export const NO_CUSTOM_FILTERS: CustomFilters = {};

/** The fields a list can filter on: picklist and boolean (D-L128 Q4). */
export function filterableFields(fields: readonly CustomField[]): readonly CustomField[] {
  return fields.filter((field) => field.type === 'picklist' || field.type === 'boolean');
}

/** Adds the custom filters to a query: `custom[key]=value`, or `customEmpty=key`. */
export function appendCustomFilters(params: URLSearchParams, filters: CustomFilters | undefined): void {
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (value === IS_EMPTY) params.append('customEmpty', key);
    else if (value !== '') params.set(`custom[${key}]`, value);
  }
}

export function setCustomFilter(filters: CustomFilters, key: string, value: string): CustomFilters {
  const next = { ...filters };
  if (value === '') delete next[key];
  else next[key] = value;
  return next;
}
