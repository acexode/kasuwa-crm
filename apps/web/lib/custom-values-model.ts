import type { CustomField } from './custom-values-api';
import { numberingLocale } from './numbering';

export * from './custom-values-core';
export * from './custom-values-filters';

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

const CALENDAR_ZONE = 'UTC';
const INTEGER = /^-?\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DIGITS = 18;

/** Digits that carry value: leading zeros (before or after the point) do not count. */
function significantDigits(text: string): number {
  return text.replace(/\D/g, '').replace(/^0+/, '').length;
}

interface Separators {
  readonly decimal: string;
  readonly group: string;
}

/** The page locale's own decimal and group characters, from `Intl` and never from a table here. */
function separators(locale: string): Separators {
  try {
    const parts = new Intl.NumberFormat(numberingLocale(locale)).formatToParts(1234567.5);
    return {
      decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
      group: parts.find((part) => part.type === 'group')?.value ?? ',',
    };
  } catch {
    return { decimal: '.', group: ',' };
  }
}

/**
 * Typed text with its decimal separator made a point, or `null`. A comma is a
 * decimal separator only where the locale's is a comma; grouping of any kind
 * (`1,000`, `12,345`) is refused, never guessed at: "1,000" is a thousand in
 * one country and one in another.
 */
function pointed(text: string, locale: string): string | null {
  const { decimal, group } = separators(locale);
  const commaDecimal = decimal === ',';
  if (text.includes(',') && !commaDecimal) return null;
  if (commaDecimal && text.includes('.') && group === '.') return null;
  if (commaDecimal && text.includes(',') && text.includes('.')) return null;
  return commaDecimal ? text.replace(',', '.') : text;
}

/** The minor-unit digits a currency has, from `Intl` (0 for a currency with none). */
export function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** `125000050` -> `1250000.50`, in text. `null` when it is not an integer string. */
export function minorToMajor(minor: string, digits = 2): string | null {
  if (!INTEGER.test(minor)) return null;
  const negative = minor.startsWith('-');
  const unsigned = (negative ? minor.slice(1) : minor).padStart(digits + 1, '0');
  if (digits === 0) return `${negative ? '-' : ''}${unsigned}`;
  return `${negative ? '-' : ''}${unsigned.slice(0, -digits)}.${unsigned.slice(-digits)}`;
}

/** Typed major units (`2500000.75`) -> minor units as an integer string; `null` when not an amount. */
export function majorToMinor(text: string, digits = 2, locale = 'en'): string | null {
  const dotted = pointed(text.trim(), locale);
  if (dotted === null) return null;
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(dotted);
  if (match === null) return null;
  const fraction = match[3] ?? '';
  if (fraction.length > digits) return null;
  const whole = (match[2] ?? '').replace(/^0+(?=\d)/, '');
  const minor = `${whole}${fraction.padEnd(digits, '0')}`.replace(/^0+(?=\d)/, '');
  if (significantDigits(minor) > MAX_DIGITS) return null;
  return minor === '0' ? '0' : `${match[1] ?? ''}${minor}`;
}

/** Typed decimal -> the contract's canonical form (`12.50` -> `12.5`); `null` when not a number. */
export function canonicalNumber(text: string, locale = 'en'): string | null {
  const dotted = pointed(text.trim(), locale);
  if (dotted === null) return null;
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(dotted);
  if (match === null || !/\d/.test(dotted)) return null;
  const whole = (match[2] ?? '').replace(/^0+/, '');
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  if (significantDigits(`${whole}${fraction}`) > MAX_DIGITS) return null;
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
    return new Intl.NumberFormat(numberingLocale(locale), options);
  } catch {
    return new Intl.NumberFormat('en', options);
  }
}

function dateFormat(locale: string): Intl.DateTimeFormat {
  // A calendar date has no zone: it is formatted as the UTC day it names, in every browser.
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeZone: CALENDAR_ZONE };
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
      const major = typeof minor === 'string' && field.currency !== null ? minorToMajor(minor, minorDigits(field.currency)) : null;
      if (major === null || field.currency === null) return EMPTY;
      const text = numberFormat(locale, { style: 'currency', currency: field.currency }).format(major as DecimalString);
      return { kind: 'text', text };
    }
    case 'date': {
      const match = typeof value === 'string' && DATE.test(value) ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
      if (match === null || typeof value !== 'string') return EMPTY;
      const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      const day = new Date(at);
      // 2027-02-30 is not a day: it never round-trips, so it is shown as nothing, never as March.
      if (day.getUTCFullYear() !== Number(match[1]) || day.getUTCMonth() !== Number(match[2]) - 1 || day.getUTCDate() !== Number(match[3])) return EMPTY;
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
      return (typeof minor === 'string' && field.currency !== null ? minorToMajor(minor, minorDigits(field.currency)) : null) ?? '';
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
export function encodeCustom(field: CustomField, text: string, locale = 'en'): Encoded {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  switch (field.type) {
    case 'text':
      return /[\n\r\u2028\u2029]/.test(trimmed) || [...trimmed].length > 1000 ? { ok: false } : { ok: true, value: trimmed };
    case 'number': {
      const canonical = canonicalNumber(trimmed, locale);
      return canonical === null ? { ok: false } : { ok: true, value: canonical };
    }
    case 'currency': {
      const minor = field.currency === null ? null : majorToMinor(trimmed, minorDigits(field.currency), locale);
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
 *
 * A key missing from the draft is untouched; only an explicit `''` clears. And
 * only a key whose text differs from the saved value is looked at at all: an
 * untouched key that holds something this screen cannot parse (a value written
 * by another client) never blocks a save of the others.
 */
export function customPatch(
  fields: readonly CustomField[],
  served: CustomValues | undefined,
  draft: CustomDraft,
  skip: ReadonlySet<string>,
  locale = 'en',
): CustomChange {
  const patch: Record<string, unknown> = {};
  const invalid: string[] = [];
  for (const field of fields) {
    if (skip.has(field.apiName)) continue;
    const text = draft[field.apiName];
    if (text === undefined || text === draftText(field, served?.[field.apiName])) continue;
    const encoded = encodeCustom(field, text, locale);
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
export function customValues(
  fields: readonly CustomField[],
  draft: CustomDraft,
  skip: ReadonlySet<string>,
  locale = 'en',
): CustomChange {
  const values: Record<string, unknown> = {};
  const invalid: string[] = [];
  for (const field of fields) {
    const text = draft[field.apiName];
    if (skip.has(field.apiName) || text === undefined || text.trim() === '') continue;
    const encoded = encodeCustom(field, text, locale);
    if (!encoded.ok) invalid.push(field.apiName);
    else if (encoded.value !== null) values[field.apiName] = encoded.value;
  }
  return { patch: Object.keys(values).length === 0 ? null : values, invalid };
}

/** Puts these keys back to the saved value (or empty): a key the API has just said is read-only is no longer the person's edit. */
export function resetKeys(
  fields: readonly CustomField[],
  served: CustomValues | undefined,
  draft: CustomDraft,
  keys: readonly string[],
): CustomDraft {
  const saved = draftOfCustom(fields, served);
  return { ...draft, ...Object.fromEntries(keys.map((key) => [key, saved[key] ?? ''])) };
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

