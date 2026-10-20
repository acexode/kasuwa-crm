/**
 * The audit log's pure parts (`P02/E`), kept out of the component so the rules
 * that matter most here can be tested without a browser.
 *
 * ---------------------------------------------------------------------------
 * THIS SCREEN IS BROADLY READABLE, SO ITS PII RULES ARE CODE, NOT CONVENTION
 *
 * `docs/api/admin.openapi.yaml` is explicit: an audit entry names a Kasuwa
 * user and the Kasuwa configuration they changed. It must never name a
 * customer, and `objectLabel` must never be an email address — the design's
 * "Invited · fatima.bello@…" row is the exact thing the contract rules out,
 * because an address is a credential-adjacent identifier and "can read the
 * audit log" is one of the most widely granted admin permissions.
 *
 * The server is responsible for that. `withheldIfIdentifier` is the screen's
 * second layer: if an address ever does arrive, the row still renders — with
 * the fact of the event intact — and the address does not. Visibly withheld,
 * not silently dropped, so the defect is reportable rather than invisible.
 * ---------------------------------------------------------------------------
 */

/**
 * Deliberately loose. Anything with an `@` between two non-space runs is
 * treated as an address; there is no legitimate `objectLabel` that looks like
 * one, so a false positive costs a label and a false negative leaks an
 * identifier.
 */
const LOOKS_LIKE_ADDRESS = /\S@\S/;

export function looksLikeIdentifier(label: string): boolean {
  return LOOKS_LIKE_ADDRESS.test(label);
}

/** The label, or `null` when it must be withheld and the caller shown a note. */
export function withheldIfIdentifier(label: string): string | null {
  return looksLikeIdentifier(label) ? null : label;
}

export type AuditRangeKey = '1' | '7' | '30' | 'all';

export const AUDIT_RANGES: readonly AuditRangeKey[] = ['1', '7', '30', 'all'];

/**
 * The design's date filter is "Last 24 hours / 7 days / 30 days / All time",
 * and the contract says the range is computed by the CLIENT and sent as UTC
 * `from`/`to`. `now` is a parameter rather than a call to `Date.now()` so the
 * test asserts a value instead of a tolerance.
 */
export function rangeToFrom(range: AuditRangeKey, now: Date): string | undefined {
  if (range === 'all') return undefined;
  const days = Number(range);
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/**
 * How many filter chips are set. The chips exist so an empty result is
 * attributable: `P02/E1` is the same empty page for "nobody did anything" and
 * for "you filtered by an actor you cannot see", and the only way out of that
 * ambiguity — which is deliberate, it must not become an existence oracle — is
 * being able to see and clear what you asked for.
 */
export function activeFilterCount(filters: {
  actorId: string;
  action: string;
  objectType: string;
  range: AuditRangeKey;
  ipPrefix: string;
}): number {
  let count = 0;
  if (filters.actorId !== '') count += 1;
  if (filters.action !== '') count += 1;
  if (filters.objectType !== '') count += 1;
  if (filters.range !== '30') count += 1;
  if (filters.ipPrefix !== '') count += 1;
  return count;
}

/**
 * How each action is coloured (`P02/E`, T-0140): additions green, changes
 * blue, removals and refusals red, data leaving the system amber, and the
 * routine rest neutral. Every badge carries its word too, so the colour is
 * never the only signal.
 */
export type AuditActionTone = 'success' | 'info' | 'danger' | 'warning' | 'neutral';

const ACTION_TONE: Readonly<Record<string, AuditActionTone>> = {
  created: 'success',
  published: 'success',
  restored: 'success',
  updated: 'info',
  merged: 'info',
  deleted: 'danger',
  rejected: 'danger',
  failed_sign_in: 'danger',
  exported: 'warning',
  played_recording: 'warning',
  invited: 'neutral',
  rotated: 'neutral',
  viewed: 'neutral',
};

export function auditActionTone(action: string): AuditActionTone {
  return ACTION_TONE[action] ?? 'neutral';
}

/** The actions with a catalogue label (`admin.audit.action.<action>`). */
export const AUDIT_ACTIONS = Object.keys(ACTION_TONE);

export function isLabelledAction(action: string): boolean {
  return Object.prototype.hasOwnProperty.call(ACTION_TONE, action);
}

/**
 * The object types the API writes today, each with a catalogue label
 * (`admin.audit.object.<type>`), so "retention_policy" reads "Retention
 * policy" in every language rather than as a key.
 */
export const AUDIT_OBJECT_TYPES = [
  'account',
  'activity',
  'audit_export',
  'contact',
  'custom_field',
  'deal',
  'disposition',
  'field_security',
  'import_job',
  'invoice',
  'portal_user',
  'programme',
  'retention_policy',
  'role',
  'script',
  'script_run',
  'sla_policy',
] as const;

export type AuditObjectType = (typeof AUDIT_OBJECT_TYPES)[number];

export function isLabelledObjectType(value: string): value is AuditObjectType {
  return (AUDIT_OBJECT_TYPES as readonly string[]).includes(value);
}

/**
 * A key a newer API writes before this catalogue knows it, made readable
 * ("sms_sender_id" → "Sms sender id"). A fallback only: the catalogue label,
 * then the server's own label, come first.
 */
export function humaniseKey(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words === '' ? key : words.charAt(0).toUpperCase() + words.slice(1);
}
