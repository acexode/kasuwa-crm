import type { MessageId } from '@kasuwa/i18n/bundle';
import { KEY_PATTERN, VARIABLE, nodeById, type FormField, type ScriptGraph, type ScriptLocale, type ScriptNode, type ScriptVersion } from '../../lib/script-graph';
import type { AnswerValue, NodeAnswer, RunContact, RunOutcome, ScriptRun } from '../../lib/script-runs-api';
import { numberingLocale } from '../../lib/numbering';
import { formatDayFirst } from '../../lib/date-locale';

/**
 * The pure half of the P10 agent screen (T-0116): which steps are drawn, what
 * completion is offered, how wording is filled in and how a form's inputs
 * become answers. No React and no `'use client'`, so each rule is unit-tested
 * directly.
 *
 * ---------------------------------------------------------------------------
 * THE SCREEN DRAWS WHAT THE SERVER SAYS (R3)
 *
 * The steps are the run's `path`, the current node is `currentNodeId`, and a
 * branch is never drawn as something to act on: the server evaluated it on
 * entry. Nothing here evaluates a branch condition, so a screen that would
 * have gone the other way on what it can see still draws the server's side.
 *
 * ANSWERS ARE SENSITIVE (D-L93). They are formatted for the screen and sent
 * to the run; nothing here stores, logs or serialises them anywhere else.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export interface Step {
  readonly key: string;
  readonly node: ScriptNode;
  readonly current: boolean;
}

/**
 * The run's path as cards, in order. A branch the server passed through is not
 * a card; a branch the run STOPPED on is the current card, with no controls.
 * A node the run has not entered is never drawn.
 */
export function stepsOf(run: ScriptRun, graph: ScriptGraph): Step[] {
  const steps: Step[] = [];
  run.path.forEach((entry, index) => {
    const node = nodeById(graph, entry.nodeId);
    if (node === undefined) return;
    const last = index === run.path.length - 1;
    const current = run.status !== 'completed' && last && run.currentNodeId === entry.nodeId;
    if (node.type === 'branch' && !(current && run.status === 'stopped')) return;
    steps.push({ key: `${index}:${entry.nodeId}`, node, current });
  });
  return steps;
}

/**
 * R4, D-L93: `completed` only at an `end` node or on a stopped run; anywhere
 * else the only completion offered is `interrupted`. `null` once completed.
 */
export function completionOffered(run: ScriptRun, graph: ScriptGraph): RunOutcome | null {
  if (run.status === 'completed') return null;
  if (run.status === 'stopped') return 'completed';
  return nodeById(graph, run.currentNodeId)?.type === 'end' ? 'completed' : 'interrupted';
}

export function isAcknowledged(run: ScriptRun, nodeId: string): boolean {
  return run.acknowledgements.some((entry) => entry.nodeId === nodeId);
}

/** The end node's suggested disposition, pre-chosen in the picker. None away from an end. */
export function suggestedDisposition(run: ScriptRun, graph: ScriptGraph): string | null {
  const node = nodeById(graph, run.currentNodeId);
  return node?.type === 'end' ? (node.suggestedDispositionId ?? null) : null;
}

// ---------------------------------------------------------------------------
// Languages (R5): the pinned version's source and translated locales
// ---------------------------------------------------------------------------

export function localesOf(version: ScriptVersion): ScriptLocale[] {
  const translated = Object.keys(version.translations).filter((locale): locale is ScriptLocale =>
    (['en', 'fr', 'pcm', 'ha', 'yo', 'ig', 'sw'] as readonly string[]).includes(locale),
  );
  return [version.sourceLocale, ...translated.filter((locale) => locale !== version.sourceLocale)];
}

/** The screen's language if the version carries it, else the source. */
export function initialLocale(version: ScriptVersion, uiLocale: string): ScriptLocale {
  const base = uiLocale.split('-')[0] ?? uiLocale;
  return localesOf(version).find((locale) => locale === base) ?? version.sourceLocale;
}

export interface Wording {
  readonly title: string;
  readonly text: string | null;
  readonly hint: string | null;
  /** The locale the wording is actually shown in: the source when the translation has no text. */
  readonly shown: ScriptLocale;
  /** True when a translation was asked for and this node has no text in it. */
  readonly fallback: boolean;
  readonly choiceLabel: (key: string, label: string) => string;
  readonly fieldLabel: (key: string, label: string) => string;
}

export function wordingFor(node: ScriptNode, version: ScriptVersion, locale: ScriptLocale): Wording {
  const own = node.type === 'branch' ? null : (node.text ?? null);
  const hint = node.type === 'question' ? (node.hint ?? null) : null;
  const translated = locale === version.sourceLocale ? undefined : version.translations[locale]?.[node.id];
  const hasText = translated?.text !== undefined;
  const fallback = locale !== version.sourceLocale && own !== null && !hasText;
  return {
    title: translated?.title ?? node.title,
    text: hasText ? (translated?.text ?? own) : own,
    hint: translated?.hint ?? hint,
    shown: hasText || own === null ? locale : version.sourceLocale,
    fallback,
    choiceLabel: (key, label) => translated?.choices?.[key] ?? label,
    fieldLabel: (key, label) => translated?.fields?.[key] ?? label,
  };
}

// ---------------------------------------------------------------------------
// Variables: filled in from what the screen holds, a placeholder otherwise
// ---------------------------------------------------------------------------

export type Segment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'placeholder'; readonly variable: string }
  /**
   * `{contact.displayName}` withheld from this agent (D-L68, D-L180, T-0124
   * I13): drawn as a neutral, translated stand-in ("the customer"), the
   * message the scripting contract names as
   * `x-kasuwa-withheld-name-message-id`. Never the name, never a part of it.
   */
  | { readonly kind: 'withheldName' };

/** The stand-in's message id (scripting.openapi.yaml getScriptRunScript `x-kasuwa-withheld-name-message-id`). */
export const WITHHELD_NAME_MESSAGE_ID: MessageId = 'scripting.run.withheldName';

/** True when the contact is loaded and field security withholds its `displayName` (it follows its name parts). */
export function nameWithheld(contact: RunContact | null): boolean {
  return contact !== null && (contact.withheldFields.includes('displayName') || typeof contact.displayName !== 'string');
}

export interface FillContext {
  readonly contact: RunContact | null;
  readonly agentName: string | null;
  readonly answers: ScriptRun['answers'];
  readonly graph: ScriptGraph;
  readonly locale: string;
}

function contactValue(contact: RunContact | null, field: string): string | null {
  if (contact === null || contact.withheldFields.includes(field)) return null;
  const value: unknown = (contact as Record<string, unknown>)[field];
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === 'string');
    return parts.length === 0 ? null : parts.join(', ');
  }
  return null;
}

function answerValue(context: FillContext, nodeId: string, key: string): string | null {
  const answer: NodeAnswer | undefined = context.answers[nodeId];
  if (answer?.type !== 'form') return null;
  const value = answer.values[key];
  if (value === undefined || value === null) return null;
  const node = nodeById(context.graph, nodeId);
  const field = node?.type === 'form' ? node.fields.find((entry) => entry.key === key) : undefined;
  return formatAnswer(field, value, context.locale);
}

/**
 * Wording as text segments, each variable replaced by its value or by a
 * placeholder; a withheld `{contact.displayName}` by the name's stand-in.
 * Never HTML. Display only: nothing here decides a branch (the server does).
 */
export function fill(text: string, context: FillContext): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(VARIABLE)) {
    const at = match.index;
    if (at > last) segments.push({ kind: 'text', text: text.slice(last, at) });
    const variable = match[1] ?? '';
    const [family, first, second] = variable.split('.');
    let value: string | null = null;
    if (family === 'contact' && first === 'displayName' && second === undefined && nameWithheld(context.contact)) {
      segments.push({ kind: 'withheldName' });
      last = at + match[0].length;
      continue;
    }
    if (family === 'contact' && first !== undefined) value = contactValue(context.contact, first);
    else if (family === 'agent') value = context.agentName;
    else if (family === 'answer' && first !== undefined && second !== undefined) value = answerValue(context, first, second);
    segments.push(value === null ? { kind: 'placeholder', variable } : { kind: 'text', text: value });
    last = at + match[0].length;
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });
  return segments;
}

// ---------------------------------------------------------------------------
// Money: typed in major units, sent in minor units as a string (R6)
// ---------------------------------------------------------------------------

export function minorDigitsOf(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * "25000", "25,000" or "25000.5" in major units to minor units as a string,
 * by string arithmetic, never through a float. `null` when it is not an amount.
 */
export function toMinor(input: string, currency: string): string | null {
  // `\s` covers the no-break and narrow no-break spaces Intl uses as group separators.
  const cleaned = input.replace(/[\s,]/g, '');
  const match = /^(\d{1,16})(?:\.(\d*))?$/.exec(cleaned);
  if (match === null) return null;
  const digits = minorDigitsOf(currency);
  const fraction = match[2] ?? '';
  if (fraction.length > digits) return null;
  const minor = `${match[1] ?? '0'}${fraction.padEnd(digits, '0')}`.replace(/^0+(?=\d)/, '');
  return minor;
}

const MINOR = /^(-?)(\d+)$/;

/**
 * Minor units back to what the agent typed: "2500000" NGN is "25000". An
 * amount that is not an integer string is not money, and reads as `''` so
 * the agent types it again; this never throws in a render.
 */
export function toMajor(minor: string, currency: string): string {
  const match = MINOR.exec(minor);
  if (match === null) return '';
  const sign = match[1] ?? '';
  const digits = minorDigitsOf(currency);
  const padded = (match[2] ?? '').padStart(digits + 1, '0');
  const whole = padded.slice(0, padded.length - digits).replace(/^0+(?=\d)/, '');
  const fraction = padded.slice(padded.length - digits).replace(/0+$/, '');
  const major = fraction === '' ? whole : `${whole}.${fraction}`;
  return sign === '' || /^[0.]+$/.test(major) ? major : `-${major}`;
}

/**
 * Minor units formatted for the locale, by integer arithmetic. `null` when
 * the amount is not an integer string: unavailable, never a thrown render.
 */
export function formatMoney(minor: string, currency: string, locale: string): string | null {
  if (!MINOR.test(minor)) return null;
  const digits = minorDigitsOf(currency);
  const scale = 10n ** BigInt(digits);
  const value = BigInt(minor);
  const magnitude = value < 0n ? -value : value;
  const whole = magnitude / scale;
  const fraction = magnitude % scale;
  try {
    const format = new Intl.NumberFormat(numberingLocale(locale), { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
    // The whole part formatted by Intl, the fraction spliced in from the
    // integer remainder: never by dividing to a float.
    return format
      // A negative amount under one major unit keeps its sign through -0.
      .formatToParts(value >= 0n ? whole : whole === 0n ? -0 : -whole)
      .map((part) => (part.type === 'fraction' ? fraction.toString().padStart(digits, '0') : part.value))
      .join('');
  } catch {
    return `${toMajor(minor, currency)} ${currency}`;
  }
}

export function formatDate(day: string, locale: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) return day;
  const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return formatDayFirst(locale, at, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** An answer as the agent reads it back: money formatted, a date in words, a choice by its label. */
export function formatAnswer(field: FormField | undefined, value: AnswerValue, locale: string): string | null {
  if (value === null) return null;
  if (typeof value === 'object') return formatMoney(value.amountMinor, value.currency, locale);
  if (typeof value === 'number') return new Intl.NumberFormat(numberingLocale(locale)).format(value);
  if (field?.type === 'date') return formatDate(value, locale);
  if (field?.type === 'choice') return field.options?.find((option) => option.key === value)?.label ?? value;
  return value;
}

// ---------------------------------------------------------------------------
// Forms (D-P31): inputs to answers, on the run only
// ---------------------------------------------------------------------------

/** What an input holds, as typed. */
export type FormInputs = Readonly<Record<string, string>>;

/** The inputs a form starts with: the answers already on the run, as the agent would type them. */
export function inputsFromAnswers(fields: readonly FormField[], answer: NodeAnswer | undefined): Record<string, string> {
  const inputs: Record<string, string> = {};
  const values = answer?.type === 'form' ? answer.values : {};
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || value === null) inputs[field.key] = '';
    else if (typeof value === 'object') inputs[field.key] = toMajor(value.amountMinor, value.currency);
    else inputs[field.key] = String(value);
  }
  return inputs;
}

export interface FormReading {
  /** The values to record: every filled field, and `null` for one cleared since it was saved. */
  readonly values: Record<string, AnswerValue>;
  /** Field key to a reason code (`required`, `invalid_amount`, `invalid_type`, `too_big`). */
  readonly errors: Record<string, string>;
}

export function readForm(fields: readonly FormField[], inputs: FormInputs, saved: NodeAnswer | undefined): FormReading {
  const values: Record<string, AnswerValue> = {};
  const errors: Record<string, string> = {};
  const before = saved?.type === 'form' ? saved.values : {};
  for (const field of fields) {
    if (!KEY_PATTERN.test(field.key)) continue;
    const raw = (inputs[field.key] ?? '').trim();
    if (raw === '') {
      if (field.required) errors[field.key] = 'required';
      else if (before[field.key] !== undefined && before[field.key] !== null) values[field.key] = null;
      continue;
    }
    switch (field.type) {
      case 'money': {
        const currency = field.currency ?? '';
        const minor = toMinor(raw, currency);
        if (minor === null) errors[field.key] = 'invalid_amount';
        else values[field.key] = { amountMinor: minor, currency };
        break;
      }
      case 'number': {
        if (!/^-?\d{1,10}$/.test(raw) || Math.abs(Number(raw)) > 2147483647) errors[field.key] = 'invalid_type';
        else values[field.key] = Number(raw);
        break;
      }
      case 'text': {
        if (field.maxLength !== undefined && raw.length > field.maxLength) errors[field.key] = 'too_big';
        else values[field.key] = raw;
        break;
      }
      case 'date':
      case 'choice':
        values[field.key] = raw;
        break;
    }
  }
  return { values, errors };
}

/** The field-level reasons the screen words, each `scripting.run.fieldError.<code>`. Anything else reads as `invalid_type`. */
export const FIELD_ERRORS = ['required', 'too_small', 'too_big', 'invalid_type', 'invalid_date', 'invalid_option', 'invalid_amount', 'unknown_field'] as const;

/** `details[]` from a 400 or a 409 as field errors: `values.<key>` to its code. Nothing else is read. */
export function fieldErrors(details: readonly { readonly path: string; readonly code: string }[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const detail of details) {
    const key = /^values\.([a-z][a-z0-9_]{0,39})$/.exec(detail.path)?.[1];
    if (key !== undefined && errors[key] === undefined) errors[key] = detail.code;
  }
  return errors;
}

/** True when nothing would be recorded: no value to send. */
export function isEmptyReading(reading: FormReading): boolean {
  return Object.keys(reading.values).length === 0;
}

/** Compliance node titles left unread, as the server recorded them, in graph order. */
export function unreadTitles(run: ScriptRun, graph: ScriptGraph): { id: string; title: string }[] {
  return run.unacknowledgedComplianceNodeIds.map((id) => ({ id, title: nodeById(graph, id)?.title ?? '' }));
}
