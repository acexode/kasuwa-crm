import type { MergeColumnField, MergeValues } from './contact-merge.repository';

/**
 * The pure rules of a merge (T-0095; D-P12, D-P23, D-P28, M4, M16). No I/O.
 */

export type MergeSide = 'survivor' | 'merged';

/** `x-kasuwa-compliance-order` for consent: most restrictive first. */
export const CONSENT_ORDER = ['withdrawn', 'unknown', 'pending', 'opted_in'] as const;

export interface ComplianceValues {
  dnd: boolean;
  whatsappOptIn: boolean;
  consentState: string;
}

/**
 * D-P28: the most restrictive of two, field by field, whichever record
 * survives and whichever is newer. `dnd` true beats false, `whatsappOptIn`
 * false beats true, consent by CONSENT_ORDER. An unknown consent code counts
 * as the most restrictive (fail closed).
 */
export function strictestCompliance(a: ComplianceValues, b: ComplianceValues): ComplianceValues {
  const rank = (value: string): number => {
    const index = (CONSENT_ORDER as readonly string[]).indexOf(value);
    return index === -1 ? 0 : index;
  };
  return {
    dnd: a.dnd || b.dnd,
    whatsappOptIn: a.whatsappOptIn && b.whatsappOptIn,
    consentState:
      CONSENT_ORDER[Math.min(rank(a.consentState), rank(b.consentState))] ?? 'withdrawn',
  };
}

export function complianceOf(values: MergeValues): ComplianceValues {
  return {
    dnd: values.dnd === true,
    whatsappOptIn: values.whatsappOptIn === true,
    consentState: typeof values.consentState === 'string' ? values.consentState : 'withdrawn',
  };
}

/** Null, undefined, an empty or blank string, an empty array or object: nothing to keep. */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** Stable comparison of two stored values (uuids are stored lower case). */
export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (value: unknown) => (value === undefined ? null : value);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * The default side of one field (M16): the more recently updated side when
 * its value is non-empty, else the other side when ITS value is non-empty,
 * else the survivor (nothing changes). A tie in update time is the survivor.
 * `acceptable` (the owner's membership, M4) rules a side out entirely.
 */
export function defaultSide(
  survivorValue: unknown,
  mergedValue: unknown,
  mergedIsNewer: boolean,
  acceptable: (side: MergeSide) => boolean = () => true,
): MergeSide | null {
  const order: MergeSide[] = mergedIsNewer ? ['merged', 'survivor'] : ['survivor', 'merged'];
  const valueOf = (side: MergeSide) => (side === 'survivor' ? survivorValue : mergedValue);
  for (const side of order) {
    if (!isEmptyValue(valueOf(side)) && acceptable(side)) return side;
  }
  // Nothing acceptable to take: a side whose value is empty (the field ends
  // up empty), else none at all.
  for (const side of ['survivor', 'merged'] as const) {
    if (isEmptyValue(valueOf(side))) return side;
  }
  return null;
}

/** Field names, in a fixed order, whose stored values differ between two value sets. */
export function changedMergeFields(
  before: MergeValues,
  after: MergeValues,
  fields: readonly MergeColumnField[],
): MergeColumnField[] {
  return fields.filter((field) => field in after && !sameValue(before[field], after[field]));
}

/** The custom keys whose values differ between two stored custom objects. */
export function changedCustomKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !sameValue(before[key], after[key])).sort();
}
