import type { MessageId } from '@kasuwa/i18n/bundle';
import {
  COMPLIANCE_FIELDS,
  MERGE_FIELDS,
  type ComplianceField,
  type ContactMerge,
  type ContactMergePreview,
  type CreateMergeBody,
  type MergeField,
  type MergeSide,
  type PreviewContact,
} from '../../lib/duplicates-api';
import type { Refusal } from './duplicates-model';

/**
 * The pure half of C1 (T-0097): what each comparison row is, what the merge
 * sends, and the merge view's state. No React and no `'use client'`, so it is
 * unit-tested directly and a server component may import it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SCREEN MAY CHOOSE, AND WHAT IT MAY NOT
 *
 *   - A field is CHOOSABLE only when it is a key of the preview's `defaults`:
 *     T-0095 lists every field the caller may edit there, equal values
 *     included. A field either side withholds is WITHHELD: no value, no choice.
 *     A field readable on both sides but absent from `defaults` is LOCKED.
 *   - Dnd, WhatsApp opt-in and consent are never in `MERGE_FIELDS` and never
 *     sent: the API keeps the most restrictive value (D-P28), the screen only
 *     shows the outcome.
 *   - The owner and the account are ids with no name anywhere in the preview
 *     (D-L64), so they are not drawn as a choice; they keep the API's default,
 *     which the merge leaves unsent.
 * ---------------------------------------------------------------------------
 */


/** The fields drawn as a comparison row: every `MergeField` with a value a person can read. */
export type DrawnField = Exclude<MergeField, 'ownerUserId' | 'accountId'>;

export const DRAWN_FIELDS: readonly DrawnField[] = MERGE_FIELDS.filter((field): field is DrawnField => field !== 'ownerUserId' && field !== 'accountId');

/** The label of each drawn field: the import wizard's own words for the same fields. */
export const FIELD_LABELS: Readonly<Record<DrawnField, MessageId>> = {
  displayName: 'import.mapfield.displayName',
  givenNames: 'import.mapfield.givenNames',
  familyName: 'import.mapfield.familyName',
  companyName: 'import.mapfield.companyName',
  phones: 'import.mapfield.phones',
  emails: 'import.mapfield.emails',
  status: 'import.mapfield.status',
  source: 'import.mapfield.source',
  tags: 'import.mapfield.tags',
  preferredLanguage: 'import.mapfield.preferredLanguage',
  preferredChannel: 'import.mapfield.preferredChannel',
  state: 'import.mapfield.state',
  lga: 'import.mapfield.lga',
};

export const COMPLIANCE_LABELS: Readonly<Record<ComplianceField, MessageId>> = {
  dnd: 'import.mapfield.dnd',
  whatsappOptIn: 'import.mapfield.whatsappOptIn',
  consentState: 'import.mapfield.consentState',
};


// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/**
 * What a field's value is, before it is drawn: nothing, record text (one part
 * per phone, address or tag, each drawn as its own piece of record data), or a
 * label of ours.
 */
export type FieldValue =
  | { readonly kind: 'empty' }
  | { readonly kind: 'text'; readonly parts: readonly string[] }
  | { readonly kind: 'label'; readonly id: MessageId };

const EMPTY: FieldValue = { kind: 'empty' };

function text(value: string | null | undefined): FieldValue {
  return value === null || value === undefined || value.trim() === '' ? EMPTY : { kind: 'text', parts: [value] };
}

/** The value of a drawn field on one record. Enumerations are our words; everything else is the record's own text. */
export function fieldValue(contact: PreviewContact, field: DrawnField): FieldValue {
  switch (field) {
    case 'phones':
      // As stored (E.164): a grouped copy of a number is not the number the person will search for.
      return contact.phones === undefined || contact.phones.length === 0 ? EMPTY : { kind: 'text', parts: contact.phones.map((phone) => phone.e164) };
    case 'emails':
      return contact.emails === undefined || contact.emails.length === 0 ? EMPTY : { kind: 'text', parts: contact.emails };
    case 'tags':
      return contact.tags === undefined || contact.tags.length === 0 ? EMPTY : { kind: 'text', parts: contact.tags };
    case 'status':
      return contact.status === null || contact.status === undefined ? EMPTY : { kind: 'label', id: `records.status.${contact.status}` as MessageId };
    case 'source':
      return contact.source === null || contact.source === undefined ? EMPTY : { kind: 'label', id: `records.source.${contact.source}` as MessageId };
    case 'preferredChannel':
      return contact.preferredChannel === null || contact.preferredChannel === undefined ? EMPTY : { kind: 'label', id: `records.channel.${contact.preferredChannel}` as MessageId };
    default:
      return text(contact[field]);
  }
}

export type RowKind = 'choice' | 'withheld' | 'locked';

export interface FieldRow {
  readonly field: DrawnField;
  readonly kind: RowKind;
  /** For a choice: the side the survivor takes (the person's pick, else the API's default). */
  readonly pick: MergeSide | null;
}

/** The rows of the comparison, in the contract's field order. */
export function rowsOf(preview: ContactMergePreview, overrides: Readonly<Record<string, MergeSide>>, refused: readonly string[]): FieldRow[] {
  return DRAWN_FIELDS.map((field): FieldRow => {
    if (preview.survivor.withheldFields.includes(field) || preview.merged.withheldFields.includes(field)) return { field, kind: 'withheld', pick: null };
    const offered = preview.defaults[field];
    if (offered === undefined || refused.includes(field)) return { field, kind: 'locked', pick: null };
    return { field, kind: 'choice', pick: overrides[field] ?? offered };
  });
}

export interface ComplianceRow {
  readonly field: ComplianceField;
  readonly withheld: boolean;
  /** The raw outcome (`true`, `false`, `withdrawn`...), for the attribute and for choosing a label. */
  readonly value: string | null;
}

/** The three compliance outcomes, in the contract's order. */
export function complianceRows(preview: ContactMergePreview): ComplianceRow[] {
  return COMPLIANCE_FIELDS.map((field): ComplianceRow => {
    const value = preview.compliance[field];
    if (preview.compliance.withheldFields.includes(field) || value === undefined) return { field, withheld: true, value: null };
    return { field, withheld: false, value: String(value) };
  });
}

/** The label of a compliance outcome, in the reader's language. */
export function complianceLabel(row: ComplianceRow): MessageId {
  const raw = row.value ?? '';
  switch (row.field) {
    case 'dnd':
      return raw === 'true' ? 'records.dnd.label' : 'duplicates.dnd.off';
    case 'whatsappOptIn':
      return raw === 'true' ? 'records.wa.in' : 'records.wa.out';
    case 'consentState':
      return `records.consent.${raw}` as MessageId;
  }
}

/**
 * The merge to send: the last preview's ids and versions, and a choice for each
 * field the screen drew as a choice and the API has not since refused. Nothing
 * else is ever named: not a compliance field, a withheld field, a read-only
 * field or a refused one.
 */
export function mergeBody(preview: ContactMergePreview, overrides: Readonly<Record<string, MergeSide>>, refused: readonly string[]): CreateMergeBody {
  const choices: Record<string, MergeSide> = {};
  for (const row of rowsOf(preview, overrides, refused)) {
    if (row.kind === 'choice' && row.pick !== null) choices[row.field] = row.pick;
  }
  return {
    survivorId: preview.survivor.id,
    mergedId: preview.merged.id,
    survivorVersion: preview.survivor.version,
    mergedVersion: preview.merged.version,
    choices,
  };
}

// ---------------------------------------------------------------------------
// The merge view's state
// ---------------------------------------------------------------------------

export type MergeStep = 'compare' | 'merging' | 'done' | 'undoing' | 'undone';

export interface MergeView {
  /** The pair in the order the set served it: the main-record radios keep their place when the other way round is read. */
  readonly pair: readonly [string, string];
  readonly mainId: string;
  readonly otherId: string;
  /** The names a preview has served, by id, so the main-record choice stays drawn while the next preview is read. */
  readonly names: Readonly<Record<string, string | null>>;
  readonly load: 'loading' | 'ready' | 'failed';
  readonly preview: ContactMergePreview | null;
  /** Only what the person changed: everything else is the API's default. */
  readonly overrides: Readonly<Record<string, MergeSide>>;
  /** Fields the API refused (403 `field_not_editable`): locked for good. */
  readonly refused: readonly string[];
  readonly step: MergeStep;
  readonly merge: ContactMerge | null;
  /** False once the server has said this merge cannot be undone, or that it has expired. */
  readonly undoable: boolean;
  readonly expired: boolean;
  /**
   * A merge was sent and its answer never arrived (B1) and the history did not show it: whether it
   * happened is unknown, so Merge stays off and the person goes back to the sets.
   */
  readonly blocked: boolean;
  /** The sets or the history changed under this view: coming back must read them again. */
  readonly dirty: boolean;
}

export type MergeAction =
  | { readonly type: 'main'; readonly id: string }
  | { readonly type: 'reread' }
  | { readonly type: 'loaded'; readonly preview: ContactMergePreview }
  | { readonly type: 'loadFailed' }
  | { readonly type: 'pick'; readonly field: string; readonly side: MergeSide }
  | { readonly type: 'merging' }
  | { readonly type: 'merged'; readonly merge: ContactMerge }
  | { readonly type: 'mergeFailed'; readonly refusal: Refusal }
  | { readonly type: 'lost' }
  | { readonly type: 'undoing' }
  | { readonly type: 'undone'; readonly merge: ContactMerge }
  | { readonly type: 'undoFailed'; readonly refusal: Refusal };

export function startMerge(pair: readonly [string, string]): MergeView {
  return { pair, mainId: pair[0], otherId: pair[1], names: {}, load: 'loading', preview: null, overrides: {}, refused: [], step: 'compare', merge: null, undoable: true, expired: false, blocked: false, dirty: false };
}

export function mergeReducer(view: MergeView, action: MergeAction): MergeView {
  switch (action.type) {
    case 'main':
      // The other way round: a new preview, and the picks start again from its defaults (I5).
      if (action.id === view.mainId || action.id !== view.otherId || view.step !== 'compare') return view;
      return { ...view, mainId: action.id, otherId: view.mainId, load: 'loading', preview: null, overrides: {} };
    case 'reread':
      return { ...view, load: 'loading', preview: null };
    case 'loaded': {
      // A pick survives a re-read only for a field that is still a choice.
      const overrides = Object.fromEntries(Object.entries(view.overrides).filter(([field]) => action.preview.defaults[field] !== undefined && !view.refused.includes(field)));
      return {
        ...view,
        load: 'ready',
        preview: action.preview,
        overrides,
        names: { ...view.names, [action.preview.survivor.id]: action.preview.survivor.displayName ?? null, [action.preview.merged.id]: action.preview.merged.displayName ?? null },
      };
    }
    case 'loadFailed':
      return { ...view, load: 'failed', preview: null };
    case 'pick':
      return view.step === 'compare' ? { ...view, overrides: { ...view.overrides, [action.field]: action.side } } : view;
    case 'merging':
      return { ...view, step: 'merging' };
    case 'merged':
      return { ...view, step: 'done', merge: action.merge, undoable: true, expired: false, blocked: false, dirty: true };
    case 'lost':
      // The answer was lost and the history shows nothing of ours: do not send again blind.
      return { ...view, step: 'compare', blocked: true, dirty: true };
    case 'mergeFailed': {
      const base: MergeView = { ...view, step: 'compare' };
      switch (action.refusal.effect) {
        case 'fields': {
          const refused = [...new Set([...view.refused, ...action.refusal.fields])];
          const overrides = Object.fromEntries(Object.entries(view.overrides).filter(([field]) => !refused.includes(field)));
          return { ...base, refused, overrides };
        }
        case 'preview':
          return { ...base, load: 'loading', preview: null };
        case 'sets':
          return { ...base, dirty: true };
        default:
          return base;
      }
    }
    case 'undoing':
      return { ...view, step: 'undoing' };
    case 'undone':
      return { ...view, step: 'undone', merge: action.merge, dirty: true };
    case 'undoFailed':
      return {
        ...view,
        step: 'done',
        undoable: action.refusal.effect === 'none',
        expired: action.refusal.effect === 'expired',
      };
  }
}

/**
 * After a merge's answer was lost (B1): the person's own open merge of this
 * pair in the history's first page, in either orientation (the API may name the
 * survivor the other way round), or `null`. An undone merge is not it: merging
 * the pair again would be a new merge.
 */
export function findOwnMerge(rows: readonly ContactMerge[], pair: readonly [string, string]): ContactMerge | null {
  const [a, b] = pair;
  return (
    rows.find((row) => row.undoneAt === null && ((row.survivor.id === a && row.merged.id === b) || (row.survivor.id === b && row.merged.id === a))) ?? null
  );
}
