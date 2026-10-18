import {
  CLASSIFICATIONS,
  picklistValuesOf,
  type Classification,
  type CustomFieldDefinition,
  type PicklistValue,
  type UpdateCustomFieldBody,
} from './custom-fields-api';

/**
 * The studio's rules, as pure functions: what the screen can refuse before it
 * sends, and what an edit actually changed. Nothing here touches the DOM or the
 * network, so the rules the contract states (D-P24, D-L138, D-L140) are tested
 * in milliseconds instead of through a browser.
 */

/** `^[a-z][a-z0-9_]*__c$`, 4 to 63 characters (D-P24). */
export const API_NAME_PATTERN = /^[a-z][a-z0-9_]*__c$/;
export const API_NAME_MIN = 4;
export const API_NAME_MAX = 63;
export const LABEL_MAX = 255;
export const DESCRIPTION_MAX = 2000;
export const API_NAME_SUFFIX = '__c';

/** A picklist value: what a record stores, immutable once saved. */
export const VALUE_PATTERN = /^[a-z][a-z0-9_]{0,61}[a-z0-9]$/;

export function isValidApiName(apiName: string): boolean {
  const length = [...apiName].length;
  return length >= API_NAME_MIN && length <= API_NAME_MAX && API_NAME_PATTERN.test(apiName);
}

/** Lower snake case from free text, accents folded; empty when nothing usable is left. */
function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * A suggestion for the api name, from the label. It obeys the rule or it is
 * empty: a label in a script with no Latin letters yields nothing, and the
 * admin types a name. The suggestion is written only until the admin types in
 * the api name box themselves.
 */
export function suggestApiName(label: string): string {
  const base = slug(label).slice(0, API_NAME_MAX - API_NAME_SUFFIX.length).replace(/_+$/g, '');
  const suggestion = `${base}${API_NAME_SUFFIX}`;
  return isValidApiName(suggestion) ? suggestion : '';
}

/** A well-formed picklist value from a label, or a numbered one when the label gives none. */
function valueFromLabel(label: string, position: number): string {
  let base = slug(label);
  if (base === '') base = `value_${position}`;
  if (!/^[a-z]/.test(base)) base = `v_${base}`;
  if (base.length < 2) base = `v_${base}`;
  base = base.slice(0, 62).replace(/_+$/g, '');
  return VALUE_PATTERN.test(base) ? base : `value_${position}`;
}

/**
 * The `value` for each new picklist label, in order, unique among themselves
 * and against the values the field already holds (`taken`). A repeated base
 * gets `_2`, `_3`, and so on; the suffix never pushes it past the pattern.
 */
export function deriveValues(labels: readonly string[], taken: readonly string[] = []): string[] {
  const used = new Set(taken);
  return labels.map((label, index) => {
    const base = valueFromLabel(label, taken.length + index + 1);
    let candidate = base;
    for (let attempt = 2; used.has(candidate); attempt += 1) {
      const suffix = `_${attempt}`;
      candidate = `${base.slice(0, 63 - suffix.length).replace(/_+$/g, '')}${suffix}`;
    }
    used.add(candidate);
    return candidate;
  });
}

const RANK: Readonly<Record<Classification, number>> = { none: 0, pii: 1, sensitive: 2 };

/** `none` to `pii` or `sensitive`, or `pii` to `sensitive` (D-L140). */
export function isClassificationRaised(from: Classification, to: Classification): boolean {
  return RANK[to] > RANK[from];
}

export function isClassification(value: string): value is Classification {
  return (CLASSIFICATIONS as readonly string[]).includes(value);
}

export interface EditDraft {
  label: string;
  description: string;
  classification: Classification;
  /** The edited label of each existing picklist value, by `value`. */
  valueLabels: Readonly<Record<string, string>>;
  /** Labels typed into new rows; blank ones are ignored. */
  newLabels: readonly string[];
}

/**
 * Only what the admin changed (D-L140: the audit names what changed, by key).
 * Empty when nothing did; the form then has nothing to send.
 */
export function updateBody(field: CustomFieldDefinition, draft: EditDraft): UpdateCustomFieldBody {
  const body: UpdateCustomFieldBody = {};
  const label = draft.label.trim();
  if (label !== field.label) body.label = label;
  const description = draft.description.trim();
  if (description !== (field.description ?? '')) body.description = description === '' ? null : description;
  if (draft.classification !== field.classification) body.classification = draft.classification;

  if (field.type === 'picklist') {
    const existing = picklistValuesOf(field);
    const relabelled: PicklistValue[] = [];
    for (const entry of existing) {
      const edited = draft.valueLabels[entry.value]?.trim();
      if (edited !== undefined && edited !== '' && edited !== entry.label) {
        relabelled.push({ value: entry.value, label: edited });
      }
    }
    if (relabelled.length > 0) body.relabelValues = relabelled;

    const added = draft.newLabels.map((entry) => entry.trim()).filter((entry) => entry !== '');
    if (added.length > 0) {
      const values = deriveValues(added, existing.map((entry) => entry.value));
      body.addValues = added.map((entry, index) => ({ value: values[index] ?? '', label: entry }));
    }
  }
  return body;
}
