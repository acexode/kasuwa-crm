import type { MessageId } from '@kasuwa/i18n/bundle';
import { minorDigits, minorToMajorText, parseMajorAmount } from '../../lib/deal-money';
import {
  isDealCurrency,
  withheld,
  type Pipeline,
  type PipelineError,
  type PipelineStage,
} from '../../lib/pipelines-api';
import type {
  DealActivityTargets,
  DealDetail,
  DealTimelineField,
  UpdateDealBody,
} from '../../lib/deal-detail-api';
import type { RecordsError, RecordsScreenErrorCode } from '../../lib/records-api';
import { rebaseEdits } from '../record/record-core';
import { findRequirement, isUuid } from '../pipeline/pipeline-model';

/**
 * The pure half of the P06/05 deal detail (T-0110): what the header draws,
 * what the edit sheet sends and how it rebases after a 409, who "assign to
 * me" is offered to, and what an activity is logged against. No React and no
 * `'use client'`, so it is unit-tested directly.
 *
 * Nothing here does arithmetic on money or counts: amounts are the server's,
 * exact, and drawn by `lib/deal-money.ts`.
 */

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** A Deal field's translated name: on the timeline, in a refusal, beside a lock. */
export function dealFieldLabel(field: DealTimelineField | 'currency' | 'owner'): MessageId {
  return `pipeline.field.${field}` as MessageId;
}

// ---------------------------------------------------------------------------
// The stage path and the checks (R7, R8)
// ---------------------------------------------------------------------------

/** Every open stage then won, in position order; lost is never a step. */
export function pathStages(pipeline: Pipeline): PipelineStage[] {
  return pipeline.stages
    .filter((stage) => stage.kind !== 'lost')
    .sort((a, b) => a.position - b.position);
}

export interface CheckRow {
  readonly requirementId: string;
  /** The requirement's label word for word, or `null` when it is no longer configured. */
  readonly label: string | null;
  /** The checker's name, or `null` for a former checker (D-L127). */
  readonly checkedBy: string | null;
  readonly checkedAt: string;
}

/** Every served check, in served order, labelled from the pipeline the screen read. */
export function checkRows(deal: DealDetail, pipeline: Pipeline | null): CheckRow[] {
  return deal.checks.map((entry) => {
    const requirement = findRequirement(pipeline, entry.requirementId);
    return {
      requirementId: entry.requirementId,
      label: requirement?.kind === 'check' ? requirement.label : null,
      checkedBy: entry.checkedBy.displayName,
      checkedAt: entry.checkedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Links (R2, R9)
// ---------------------------------------------------------------------------

/** `/<base>/<id>` from a well-formed uuid only; anything else is drawn as text. */
export function uuidHref(
  base: '/contacts' | '/accounts' | '/pipelines',
  id: string | null | undefined,
): string | null {
  return isUuid(id) ? `${base}/${id}` : null;
}

// ---------------------------------------------------------------------------
// Assign to me (R11)
// ---------------------------------------------------------------------------

/**
 * "Assign to me" is offered when the caller is known, the owner is readable,
 * and the caller is not already the owner (unassigned and a former owner
 * included). Nothing else about reassignment is offered.
 */
export function offersAssignToMe(deal: DealDetail, callerId: string | null): boolean {
  if (callerId === null || withheld(deal, 'ownerUserId')) return false;
  return (deal.ownerUserId ?? null) !== callerId;
}

// ---------------------------------------------------------------------------
// Activities (R17)
// ---------------------------------------------------------------------------

/**
 * What an activity logged here targets: exactly the deal's served primary
 * contact and account, whichever are present and readable. `null` when there
 * is neither, and then no composer is offered.
 */
export function activityTargets(deal: DealDetail): DealActivityTargets | null {
  const contactId = withheld(deal, 'primaryContactId') ? null : (deal.primaryContactId ?? null);
  const accountId = withheld(deal, 'accountId') ? null : (deal.accountId ?? null);
  return contactId === null && accountId === null ? null : { contactId, accountId };
}

const RECORDS_CODES: ReadonlySet<string> = new Set<RecordsScreenErrorCode>([
  'validation_failed',
  'not_authenticated',
  'not_permitted',
  'not_found',
  'stale_write',
  'too_many_requests',
  'service_unavailable',
  'internal_error',
  'network',
]);

/** A refused create as the shared activity form reads it: a code it translates, and the reasons the contract named. */
export function asRecordsError(error: PipelineError): RecordsError {
  const details = error.details.length === 0 ? {} : { details: error.details };
  if (RECORDS_CODES.has(error.code))
    return { code: error.code as RecordsScreenErrorCode, ...details };
  if (error.status === 0) return { code: 'network' };
  return { code: error.status >= 500 ? 'internal_error' : 'validation_failed', ...details };
}

/**
 * The composer's own copy for a refusal the shared form has no words for: a
 * `field_not_editable` at `dealId` (the activity's deal link, under field
 * security, R17) is "you cannot link an activity to this deal", never "check
 * it and try again". `null` keeps the form's own copy.
 */
export function composerRefusal(error: RecordsError): MessageId | null {
  const linkRefused = (error.details ?? []).some(
    (detail) => detail.code === 'field_not_editable' && detail.path === 'dealId',
  );
  return linkRefused ? 'deal.activity.linkRefused' : null;
}

// ---------------------------------------------------------------------------
// The edit sheet (R10, R12)
// ---------------------------------------------------------------------------

/** What the sheet edits, all as the inputs hold it: text, a currency code, and picked ids ('' for none). */
export interface DealForm {
  readonly name: string;
  readonly amount: string;
  readonly currency: string;
  readonly expectedCloseDate: string;
  readonly nextStep: string;
  readonly primaryContactId: string;
  readonly accountId: string;
}

export type DealFormKey = keyof DealForm;

export const DEAL_FORM_KEYS: readonly DealFormKey[] = [
  'name',
  'amount',
  'currency',
  'expectedCloseDate',
  'nextStep',
  'primaryContactId',
  'accountId',
];

/** The wire field a form key writes: the amount and its currency are one `amount`. */
export function wireField(
  key: DealFormKey,
): Exclude<DealTimelineField, 'ownerUserId' | 'stageId' | 'checks'> {
  return key === 'currency' ? 'amount' : key;
}

/** The form keys the sheet offers: never a withheld field (R9, R10). `name` is never withheld. */
export function offeredKeys(deal: DealDetail): DealFormKey[] {
  return DEAL_FORM_KEYS.filter((key) => key === 'name' || !withheld(deal, wireField(key)));
}

export function formOf(deal: DealDetail): DealForm {
  const amount = deal.amount ?? null;
  return {
    name: deal.name,
    amount:
      amount === null ? '' : minorToMajorText(amount.amountMinor, minorDigits(amount.currency)),
    currency: amount === null ? '' : amount.currency,
    expectedCloseDate: deal.expectedCloseDate ?? '',
    nextStep: deal.nextStep ?? '',
    primaryContactId: deal.primaryContactId ?? '',
    accountId: deal.accountId ?? '',
  };
}

export type FormError = 'name' | 'amount' | 'currency';

export type EditOutcome =
  | { readonly kind: 'send'; readonly body: UpdateDealBody }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'invalid'; readonly errors: readonly FormError[] };

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The update, judged against `deal` (the deal the sheet now stands on): only
 * the keys the person `edited`, among those offered, and only where the value
 * differs from what the deal holds — retyping the held value is no change
 * (D-L102). An emptied amount, close date, next step, contact or account is
 * `null`. A blank name, an amount that is not figures, or an amount with no
 * currency is a local error, and nothing is sent.
 */
export function editOutcome(
  deal: DealDetail,
  form: DealForm,
  edited: readonly DealFormKey[],
): EditOutcome {
  const offered = new Set(offeredKeys(deal));
  const touched = new Set(edited.filter((key) => offered.has(key)));
  const body: { -readonly [K in keyof UpdateDealBody]: UpdateDealBody[K] } = {
    version: deal.version,
  };
  const errors: FormError[] = [];

  if (touched.has('name')) {
    const name = form.name.trim();
    if (name === '') errors.push('name');
    else if (name !== deal.name) body.name = name.slice(0, 200);
  }

  if (touched.has('amount') || touched.has('currency')) {
    const typed = form.amount.trim();
    const held = deal.amount ?? null;
    if (typed === '') {
      if (held !== null) body.amount = null;
    } else {
      const currency = form.currency;
      const minor = parseMajorAmount(typed, isDealCurrency(currency) ? minorDigits(currency) : 2);
      if (minor === null) errors.push('amount');
      if (!isDealCurrency(currency)) errors.push('currency');
      if (
        minor !== null &&
        isDealCurrency(currency) &&
        (held === null || held.amountMinor !== minor || held.currency !== currency)
      ) {
        body.amount = { amountMinor: minor, currency };
      }
    }
  }

  if (touched.has('expectedCloseDate')) {
    const typed = form.expectedCloseDate.trim();
    const value = CALENDAR_DATE.test(typed) ? typed : null;
    if (value !== (deal.expectedCloseDate ?? null)) body.expectedCloseDate = value;
  }

  if (touched.has('nextStep')) {
    const typed = form.nextStep.trim().slice(0, 200);
    const value = typed === '' ? null : typed;
    if (value !== (deal.nextStep ?? null)) body.nextStep = value;
  }

  for (const key of ['primaryContactId', 'accountId'] as const) {
    if (!touched.has(key)) continue;
    const value = form[key] === '' ? null : form[key];
    if (value !== (deal[key] ?? null)) body[key] = value;
  }

  if (errors.length > 0) return { kind: 'invalid', errors };
  return Object.keys(body).length > 1 ? { kind: 'send', body } : { kind: 'unchanged' };
}

/** The keys whose input differs from what the sheet was seeded with: the person's edits. */
export function editedKeys(seed: DealForm, form: DealForm): DealFormKey[] {
  return DEAL_FORM_KEYS.filter((key) => seed[key] !== form[key]);
}

export interface Rebased {
  readonly form: DealForm;
  /** Wire fields the person changed that somebody else ALSO changed meanwhile: the typed value is kept, and flagged. */
  readonly conflicts: readonly string[];
}

/**
 * After a `409 stale_write` (D-L102, R12): the fresh deal's form with the
 * person's edits laid back on top. An untouched field takes the fresh value
 * (and is then never sent); an edit to a field since withheld is dropped.
 */
export function rebaseForm(seedDeal: DealDetail, freshDeal: DealDetail, typed: DealForm): Rebased {
  const result = rebaseEdits<DealFormKey, DealForm>(
    formOf(seedDeal),
    formOf(freshDeal),
    typed,
    offeredKeys(freshDeal),
  );
  return { form: result.form, conflicts: [...new Set(result.conflicts.map(wireField))] };
}

/** The wire fields a `403 field_not_editable` names that the screen can label. */
export function refusedFields(error: PipelineError): DealTimelineField[] {
  const known: readonly string[] = [
    'name',
    'amount',
    'expectedCloseDate',
    'ownerUserId',
    'primaryContactId',
    'accountId',
    'nextStep',
  ];
  return error.details
    .filter((detail) => detail.code === 'field_not_editable' && known.includes(detail.path))
    .map((detail) => detail.path as DealTimelineField);
}
