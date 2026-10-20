import type { MessageId } from '@kasuwa/i18n/bundle';
import { minorDigits, parseMajorAmount } from '../../lib/deal-money';
import {
  DEAL_SORTS,
  REQUIREMENT_FIELDS,
  isDealCurrency,
  type Deal,
  type DealFilters,
  type DealSort,
  type MoveDealBody,
  type MoveFields,
  type Pipeline,
  type PipelineError,
  type PipelineStage,
  type RequirementField,
  type StageRequirement,
} from '../../lib/pipelines-api';
import { numberingLocale } from '../../lib/numbering';

/**
 * The pure half of the P06 board and list (T-0109): filters, the allow-list,
 * the requirement prompt's arithmetic of WHAT IS ASKED (never of money or
 * counts, which are the server's, R4), refusals and dates. No React and no
 * `'use client'`, so it is unit-tested directly.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A summary links only from a well-formed uuid (R15): anything else is drawn as text. */
export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID.test(value);
}

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Filters (R12, R14)
// ---------------------------------------------------------------------------

/** The won window's choices, in whole days: each at most 366, a year among them (R12). */
export const WON_WINDOWS = [30, 90, 180, 365] as const;
/** The server's own default window (D-L88): sent as no `closedSince` at all. */
export const DEFAULT_WON_DAYS = 90;

export const OWNER_FILTERS = ['me', 'unassigned'] as const;
export type OwnerFilter = (typeof OWNER_FILTERS)[number];

/** The close-date presets of P06/01's "Any close date" dropdown; `custom` shows the two dates. */
export const CLOSE_PRESETS = ['any', 'month', 'next60', 'overdue', 'custom'] as const;
export type ClosePreset = (typeof CLOSE_PRESETS)[number];

export function isClosePreset(value: string): value is ClosePreset {
  return (CLOSE_PRESETS as readonly string[]).includes(value);
}

function isoDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A preset as the calendar dates the API filters on, in the reader's own
 * zone, fixed when it is chosen (so a column's cursor stays valid). `custom`
 * keeps what was typed.
 */
export function closeRangeFor(preset: ClosePreset, nowMs: number): { readonly closeFrom: string; readonly closeTo: string } | null {
  const now = new Date(nowMs);
  switch (preset) {
    case 'any':
      return { closeFrom: '', closeTo: '' };
    case 'month':
      return { closeFrom: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), closeTo: isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
    case 'next60':
      return { closeFrom: isoDate(now), closeTo: isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 60)) };
    case 'overdue':
      return { closeFrom: '', closeTo: isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)) };
    case 'custom':
      return null;
  }
}

export interface FilterState {
  readonly q: string;
  /** The owners picked in the avatar row: user ids, as the contract's `owner` takes them. */
  readonly owners: readonly string[];
  readonly closePreset: ClosePreset;
  readonly owner: OwnerFilter | '';
  readonly currency: string;
  readonly closeFrom: string;
  readonly closeTo: string;
  readonly wonDays: number;
  /**
   * The won window's start, fixed when the window is chosen (never recomputed
   * on a render, so the same choice is the same query and a column's cursor
   * stays valid). `null` is the server's default.
   */
  readonly closedSince: string | null;
}

export const NO_FILTERS: FilterState = {
  q: '',
  owners: [],
  closePreset: 'any',
  owner: '',
  currency: '',
  closeFrom: '',
  closeTo: '',
  wonDays: DEFAULT_WON_DAYS,
  closedSince: null,
};

/** `closedSince` for a window of `days` ending now, or `null` for the server's default. */
export function closedSinceFor(days: number, nowMs: number): string | null {
  if (days === DEFAULT_WON_DAYS) return null;
  return new Date(nowMs - days * DAY_MS).toISOString();
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The filters as the API takes them. A filter on a field the board said is
 * withheld is never built (it would be `400 field_withheld`), and a close
 * window that ends before it starts sends only its start.
 */
export function toDealFilters(state: FilterState, withheldFields: readonly string[]): DealFilters {
  const closeHidden = withheldFields.includes('expectedCloseDate');
  const closeFrom = !closeHidden && CALENDAR_DATE.test(state.closeFrom) ? state.closeFrom : '';
  const closeTo = !closeHidden && CALENDAR_DATE.test(state.closeTo) && (closeFrom === '' || state.closeTo >= closeFrom) ? state.closeTo : '';
  return {
    q: state.q,
    owner: withheldFields.includes('ownerUserId') ? [] : [...state.owners.filter(isUuid), ...(state.owner === '' ? [] : [state.owner])],
    currency: isDealCurrency(state.currency) && !withheldFields.includes('amount') ? [state.currency] : [],
    closeFrom,
    closeTo,
    closedSince: state.closedSince,
  };
}

/** True when anything narrows the deals shown: "no results", not "no deals yet". */
export function filtersActive(state: FilterState): boolean {
  return (
    state.q.trim() !== '' ||
    state.owners.length > 0 ||
    state.owner !== '' ||
    state.currency !== '' ||
    state.closeFrom !== '' ||
    state.closeTo !== '' ||
    state.wonDays !== DEFAULT_WON_DAYS
  );
}

// ---------------------------------------------------------------------------
// The board's summary line (T-0135): the served figures, added per currency
// ---------------------------------------------------------------------------

export interface CurrencySum {
  readonly currency: string;
  readonly amountMinor: string;
  readonly weightedAmountMinor: string;
}

export interface BoardSummary {
  /** Per currency, open stages only; `null` when `amount` is withheld. */
  readonly open: readonly CurrencySum[] | null;
  /** Per currency, the won column (its served window); `null` when withheld. */
  readonly won: readonly CurrencySum[] | null;
  /** The open columns' exact counts, added. */
  readonly openCount: number;
}

interface SummaryColumn {
  readonly stageId: string;
  readonly count: number;
  readonly totals: readonly { readonly currency: string; readonly amountMinor: string; readonly weightedAmountMinor: string }[] | undefined;
}

function addTotals(into: Map<string, { amount: bigint; weighted: bigint }>, column: SummaryColumn): void {
  for (const total of column.totals ?? []) {
    const current = into.get(total.currency) ?? { amount: 0n, weighted: 0n };
    into.set(total.currency, { amount: current.amount + BigInt(total.amountMinor), weighted: current.weighted + BigInt(total.weightedAmountMinor) });
  }
}

function sums(map: Map<string, { amount: bigint; weighted: bigint }>): CurrencySum[] {
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, value]) => ({ currency, amountMinor: value.amount.toString(), weightedAmountMinor: value.weighted.toString() }));
}

/**
 * The served column figures added up: never converted, never summed across
 * currencies (D-P19), in BigInt, so a 24-digit total stays exact. Counts are
 * the served exact counts. A withheld amount is `null`, never zero.
 */
export function boardSummary(pipeline: Pipeline, columns: readonly SummaryColumn[]): BoardSummary {
  const open = new Map<string, { amount: bigint; weighted: bigint }>();
  const won = new Map<string, { amount: bigint; weighted: bigint }>();
  let openCount = 0;
  let locked = false;
  for (const column of columns) {
    const kind = stageById(pipeline, column.stageId)?.kind;
    if (column.totals === undefined) locked = true;
    if (kind === 'open') {
      openCount += column.count;
      addTotals(open, column);
    } else if (kind === 'won') {
      addTotals(won, column);
    }
  }
  return { open: locked ? null : sums(open), won: locked ? null : sums(won), openCount };
}

/** A stable key for "the board answered these filters". */
export function filtersKey(filters: DealFilters): string {
  return JSON.stringify(filters);
}

const SORT_LABELS: Readonly<Record<DealSort, MessageId>> = {
  '-updatedAt': 'pipeline.sort.updated',
  '-createdAt': 'pipeline.sort.created',
  name: 'pipeline.sort.name',
  stageEnteredAt: 'pipeline.sort.waiting',
};

export function sortLabel(sort: DealSort): MessageId {
  return SORT_LABELS[sort];
}

export function isDealSort(value: string): value is DealSort {
  return (DEAL_SORTS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Dragging a card (R15: its name is a link)
// ---------------------------------------------------------------------------

/** How long after a drag ends a click on the dragged card is taken as the drag's own, and swallowed. */
export const DRAG_CLICK_WINDOW_MS = 500;

/**
 * Whether a click that follows a drag is the drag's own (and must not follow
 * the card's link): on the dragged card, within the window. Any other click
 * is the person's.
 */
export function swallowsClick(armedAtMs: number, clickedAtMs: number, insideCard: boolean): boolean {
  return insideCard && clickedAtMs - armedAtMs >= 0 && clickedAtMs - armedAtMs <= DRAG_CLICK_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Stages and the allow-list (R9)
// ---------------------------------------------------------------------------

export function stageById(pipeline: Pipeline | null, id: string): PipelineStage | undefined {
  return pipeline?.stages.find((stage) => stage.id === id);
}

/** The stages a deal in `fromStageId` may move to, by the allow-list the screen read, in position order. */
export function allowedTargets(pipeline: Pipeline, fromStageId: string): PipelineStage[] {
  const targets = new Set(pipeline.transitions.filter((pair) => pair.fromStageId === fromStageId).map((pair) => pair.toStageId));
  return pipeline.stages.filter((stage) => stage.id !== fromStageId && targets.has(stage.id)).sort((a, b) => a.position - b.position);
}

export function isAllowed(pipeline: Pipeline, fromStageId: string, toStageId: string): boolean {
  return pipeline.transitions.some((pair) => pair.fromStageId === fromStageId && pair.toStageId === toStageId);
}

// ---------------------------------------------------------------------------
// The requirement prompt (R9, R11)
// ---------------------------------------------------------------------------

export function fieldLabel(field: RequirementField): MessageId {
  return `pipeline.field.${field}` as MessageId;
}

function isRequirementField(value: string): value is RequirementField {
  return (REQUIREMENT_FIELDS as readonly string[]).includes(value);
}

/** What the deal holds for a requirement field, comparable as text; `null` for no value. */
export function fieldValue(deal: Deal, field: RequirementField): string | null {
  switch (field) {
    case 'amount':
      return deal.amount === null || deal.amount === undefined ? null : `${deal.amount.amountMinor} ${deal.amount.currency}`;
    case 'expectedCloseDate':
      return deal.expectedCloseDate ?? null;
    case 'nextStep':
      return deal.nextStep ?? null;
    case 'primaryContactId':
      return deal.primaryContactId ?? null;
    case 'accountId':
      return deal.accountId ?? null;
  }
}

export interface RequirementView {
  readonly requirement: StageRequirement;
  /** Already satisfied by the deal: shown met, never asked again. */
  readonly met: boolean;
  /** A field withheld from the caller: a lock, never filled. */
  readonly locked: boolean;
}

/** Every requirement of the target stage, as the deal stands. */
export function requirementViews(stage: PipelineStage, deal: Deal, withheldFields: readonly string[]): RequirementView[] {
  return stage.requirements.map((requirement) => {
    if (requirement.kind === 'check') {
      return { requirement, met: deal.checks.some((entry) => entry.requirementId === requirement.id), locked: false };
    }
    const locked = withheldFields.includes(requirement.field) || deal.withheldFields.includes(requirement.field);
    return { requirement, met: !locked && fieldValue(deal, requirement.field) !== null, locked };
  });
}

export interface PromptInput {
  /** Typed text per requirement id: a date, a next step, or an amount in major units. */
  readonly text: Readonly<Record<string, string>>;
  /** The amount's currency per requirement id. */
  readonly currency: Readonly<Record<string, string>>;
  /** The record picked per requirement id (contact or account). */
  readonly picked: Readonly<Record<string, { readonly id: string; readonly name: string }>>;
  /** Ticked checks. */
  readonly checks: Readonly<Record<string, boolean>>;
}

export const EMPTY_INPUT: PromptInput = { text: {}, currency: {}, picked: {}, checks: {} };

/** The requirement prompt, open on one move (the board's on a card, the deal detail's on the full deal). */
export interface PromptState<D extends Deal = Deal> {
  readonly deal: D;
  readonly toStageId: string;
  readonly views: readonly RequirementView[];
  readonly input: PromptInput;
  /** Requirement ids somebody else changed since the person started (D-L102). */
  readonly conflicts: readonly string[];
  readonly refusal: string | null;
  readonly sending: boolean;
}

/** The value the person gave a field requirement, as MoveDealFields takes it; `undefined` if none or invalid. */
function filledValue(requirement: StageRequirement & { kind: 'field' }, input: PromptInput): MoveFields[RequirementField] | undefined {
  const typed = (input.text[requirement.id] ?? '').trim();
  switch (requirement.field) {
    case 'amount': {
      const currency = input.currency[requirement.id] ?? '';
      if (!isDealCurrency(currency) || typed === '') return undefined;
      const minor = parseMajorAmount(typed, minorDigits(currency));
      return minor === null ? undefined : { amountMinor: minor, currency };
    }
    case 'expectedCloseDate':
      return CALENDAR_DATE.test(typed) ? typed : undefined;
    case 'nextStep':
      return typed === '' ? undefined : typed.slice(0, 200);
    case 'primaryContactId':
    case 'accountId':
      return input.picked[requirement.id]?.id;
  }
}

/** True when the person has touched a requirement (typed, picked or ticked). */
export function isFilled(view: RequirementView, input: PromptInput): boolean {
  const { requirement } = view;
  if (requirement.kind === 'check') return input.checks[requirement.id] === true;
  return filledValue(requirement, input) !== undefined;
}

/** Every requirement the person can fill is filled. Locks cannot be, and are left to the server (R10). */
export function promptReady(views: readonly RequirementView[], input: PromptInput): boolean {
  return views.every((view) => view.met || view.locked || isFilled(view, input));
}

/** An amount typed but not acceptable: a local, translated field error, and nothing is sent. */
export function amountInvalid(view: RequirementView, input: PromptInput): boolean {
  const { requirement } = view;
  if (requirement.kind !== 'field' || requirement.field !== 'amount') return false;
  const typed = (input.text[requirement.id] ?? '').trim();
  return typed !== '' && parseMajorAmount(typed, 2) === null;
}

/**
 * The move, carrying exactly what the person filled (D-L102): the unmet field
 * requirements they gave a value and the unmet checks they ticked. A met
 * requirement, a lock and an untouched field are never sent.
 */
export function promptBody(version: number, toStageId: string, views: readonly RequirementView[], input: PromptInput): MoveDealBody {
  const fields: MoveFields = {};
  const checks: string[] = [];
  for (const view of views) {
    if (view.met || view.locked) continue;
    const { requirement } = view;
    if (requirement.kind === 'check') {
      if (input.checks[requirement.id] === true) checks.push(requirement.id);
      continue;
    }
    const value = filledValue(requirement, input);
    if (value !== undefined) Object.assign(fields, { [requirement.field]: value });
  }
  return {
    version,
    toStageId,
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
    ...(checks.length === 0 ? {} : { checks }),
  };
}

/**
 * The prompt after a `409 stale_write` (D-L102, R11), against the deal as it
 * now stands. A requirement the person filled stays theirs, with a conflict
 * noted where somebody else changed the same field meanwhile; one they did
 * not touch takes the fresh deal's state (met if somebody else met it).
 */
export function rebaseViews(
  previous: readonly RequirementView[],
  served: Deal,
  fresh: Deal,
  stage: PipelineStage,
  withheldFields: readonly string[],
  input: PromptInput,
): { views: RequirementView[]; conflicts: string[] } {
  const freshViews = requirementViews(stage, fresh, withheldFields);
  const conflicts: string[] = [];
  const views = freshViews.map((view) => {
    const before = previous.find((entry) => entry.requirement.id === view.requirement.id);
    if (before === undefined || before.met || before.locked || !isFilled(before, input)) return view;
    const { requirement } = before;
    if (requirement.kind === 'field' && fieldValue(served, requirement.field) !== fieldValue(fresh, requirement.field)) {
      conflicts.push(requirement.id);
    }
    return { ...before, met: false };
  });
  return { views, conflicts };
}

// ---------------------------------------------------------------------------
// Refusals (R10)
// ---------------------------------------------------------------------------

/** Server faults and a lost connection: the only refusals worded as "something went wrong on our side". */
const SERVER_ERRORS = new Set(['service_unavailable', 'internal_error']);

/** 4xx codes with their own copy, as long as no detail says the request itself was unusable. */
const CLIENT_ERRORS = new Set([
  'not_authenticated',
  'not_permitted',
  'not_found',
  'stale_write',
  'too_many_requests',
  'transition_not_allowed',
  'requirements_unmet',
]);

/** Detail reasons that mean "this change could not be saved as sent", whatever the code. */
const UNSAVED_DETAILS = new Set(['unknown_reference', 'field_withheld', 'field_not_editable']);

/**
 * The copy for a refusal, switching on `code` and `details` and never on
 * `message`. A 5xx or a lost connection is the server's fault; every other
 * 4xx a write meets — an unknown reference, a withheld or uneditable field
 * the screen cannot label, a validation failure, a code this screen does not
 * know — is "this change could not be saved", never the server-fault text.
 * A READ keeps `validation_failed`'s own copy (clear the search and filters).
 */
export function errorMessage(error: PipelineError, mode: 'read' | 'write' = 'write'): MessageId {
  if (error.code === 'network' || error.status === 0) return 'records.error.network';
  if (error.status >= 500) return (SERVER_ERRORS.has(error.code) ? `records.error.${error.code}` : 'records.error.internal_error') as MessageId;
  if (error.details.some((detail) => UNSAVED_DETAILS.has(detail.code))) return 'pipeline.error.unsaved';
  if (CLIENT_ERRORS.has(error.code)) return `records.error.${error.code}` as MessageId;
  if (mode === 'read' && error.code === 'validation_failed') return 'records.error.validation_failed';
  return 'pipeline.error.unsaved';
}

/**
 * A pipeline row's link on `/pipelines`, or `null` for an id that is not a
 * well-formed uuid: such a row is drawn as text and links nowhere (R15).
 */
export function pipelineHref(id: string): string | null {
  return isUuid(id) ? `/pipelines/${id}` : null;
}

/** The fields a `403 field_not_editable` names, as requirement fields the screen can label. */
export function notEditableFields(error: PipelineError): RequirementField[] {
  return error.details.filter((detail) => detail.code === 'field_not_editable').map((detail) => detail.path).filter(isRequirementField);
}

/** The requirement ids a `422 requirements_unmet` names (`requirements.<id>`). */
export function unmetRequirementIds(error: PipelineError): string[] {
  return error.details
    .filter((detail) => detail.path.startsWith('requirements.'))
    .map((detail) => detail.path.slice('requirements.'.length));
}

/** A requirement by id in any stage of the pipeline. */
export function findRequirement(pipeline: Pipeline | null, id: string): StageRequirement | undefined {
  for (const stage of pipeline?.stages ?? []) {
    const found = stage.requirements.find((requirement) => requirement.id === id);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat('en', options);
  }
}

/** A calendar date (`YYYY-MM-DD`, no zone) as the reader writes it, never shifted by a zone. */
export function formatCalendarDate(locale: string, date: string): string {
  if (!CALENDAR_DATE.test(date)) return date;
  return dateFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00.000Z`));
}

/** A calendar date without its year ("15 Dec"), as the P06 cards and list draw it. Never shifted by a zone. */
export function formatShortDate(locale: string, date: string): string {
  if (!CALENDAR_DATE.test(date)) return date;
  return dateFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00.000Z`));
}

/** A calendar date with its weekday ("Sat 31 Oct 2026"), as the deal's key fields draw it. */
export function formatLongDate(locale: string, date: string): string {
  if (!CALENDAR_DATE.test(date)) return date;
  return dateFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00.000Z`));
}

/** A stage's probability as the reader writes a percentage ("70%"). */
export function formatPercent(locale: string, basisPoints: number): string {
  try {
    return new Intl.NumberFormat(numberingLocale(locale), { style: 'percent', maximumFractionDigits: 1 }).format(basisPoints / 10_000);
  } catch {
    return new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 }).format(basisPoints / 10_000);
  }
}

/** An instant's date in the reader's own zone. */
export function formatInstantDate(locale: string, instant: string): string {
  const at = new Date(instant);
  return Number.isNaN(at.getTime()) ? '' : dateFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(at);
}

/** The count exactly as served, grouped for the reader. Never added to, never rounded (R4). */
export function formatCount(locale: string, count: number): string {
  try {
    return new Intl.NumberFormat(numberingLocale(locale), { maximumFractionDigits: 0 }).format(count);
  } catch {
    return String(count);
  }
}
