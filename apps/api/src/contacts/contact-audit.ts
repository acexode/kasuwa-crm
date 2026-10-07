import type { Contact, ContactValues } from '@kasuwa/domain-core';
import {
  AUDIT_CHANGE_VALUE_MAX_LENGTH,
  change,
  redactedChange,
  type AuditChange,
  type AuditEventInput,
} from '../admin/audit/audit-writer';

/**
 * What a contact write records (T-0041; T-0061; S2 of the T-0041 suite,
 * D-L54, D-L63, D-L72, D-L81).
 *
 * A contact is a PERSON. Since T-0061 an event records the VALUES of the
 * non-PII enumerated fields D-L72 names, so the contact timeline can show
 * "status: new -> contacted", and records every other field by name only.
 *
 *   - VALUES, when the value actually moved: status, source,
 *     preferredLanguage, preferredChannel, consentState, whatsappOptIn,
 *     state, lga and tags. Encoded in the `AuditChange` string type (D-L81):
 *     a code or label is the string itself, a boolean `'true'`/`'false'`, the
 *     tag list its JSON array text; `null` is "had none". State, LGA and tags
 *     carry values by D-L81's ruling (operator-assigned labels; the timeline
 *     omits any field withheld from the reader).
 *   - REDACTED, whenever sent: the name parts, phones and emails. Deciding
 *     whether such a value moved would mean comparing personal data only to
 *     then not record it; the field name is the event (`redacted: true`,
 *     `before` and `after` null).
 *   - REDACTED, when it moved: the owner and the account. Never their ids
 *     (D-L64, D-L72).
 *   - On a CREATE, every field the create set (D-L81): a value field shows
 *     `before: null`, except consent, which starts at `unknown`. A field the
 *     create did not send, or sent as null, records nothing.
 *   - A value whose encoding would exceed the writer's limit (a very long tag
 *     list) is recorded by name only, rather than refusing the write.
 *   - The label is the record id (D-L63), never the contact's name.
 *
 * Events written before T-0061 carry every change redacted; the timeline
 * renders those without values.
 */

/** Recorded by name only, whenever sent. */
const REDACTED_WHEN_SENT: readonly (keyof ContactValues)[] = [
  'displayName',
  'givenNames',
  'familyName',
  'phones',
  'emails',
];

/** Recorded with before and after, when the value moved (D-L72). */
export const CONTACT_AUDIT_VALUE_FIELDS = [
  'status',
  'source',
  'preferredLanguage',
  'preferredChannel',
  'consentState',
  'whatsappOptIn',
  'state',
  'lga',
  'tags',
] as const satisfies readonly (keyof ContactValues & keyof Contact)[];

/** Recorded by name only, when the value moved. */
const REDACTED_WHEN_CHANGED: readonly (keyof ContactValues & keyof Contact)[] = [
  'ownerUserId',
  'accountId',
];

/** Uuid-valued fields: the same id in either case is the same value. */
const ID_FIELDS: ReadonlySet<keyof ContactValues> = new Set(['ownerUserId', 'accountId']);

/** What a value field is before a contact exists: consent starts at `unknown` (the column default). */
const CREATE_BEFORE: Partial<Record<keyof ContactValues, string>> = { consentState: 'unknown' };

/**
 * A value field's value in the `AuditChange` string type. Strings are
 * themselves, booleans `'true'`/`'false'`, arrays their JSON text, absence
 * `null`. `decodeContactAuditValue` is the inverse.
 */
export function encodeContactAuditValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}

/**
 * The value as it is compared for "did it move". Uuids are canonicalised to
 * lower case (how Postgres returns them), so an upper-case spelling of the id
 * already stored is not recorded as a change.
 */
function comparable(field: keyof ContactValues, value: unknown): string | null {
  const encoded = encodeContactAuditValue(value);
  return ID_FIELDS.has(field) && encoded !== null ? encoded.toLowerCase() : encoded;
}

function fits(value: string | null): boolean {
  return value === null || value.length <= AUDIT_CHANGE_VALUE_MAX_LENGTH;
}

/** The changes a write records. `before` is null for a create. */
export function contactChanges(values: ContactValues, before: Contact | null): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const field of REDACTED_WHEN_SENT) {
    if (values[field] !== undefined) changes.push(redactedChange(field));
  }
  for (const field of CONTACT_AUDIT_VALUE_FIELDS) {
    const next = values[field];
    if (next === undefined) continue;
    const after = encodeContactAuditValue(next);
    let previous: string | null;
    if (before === null) {
      if (after === null) continue;
      previous = CREATE_BEFORE[field] ?? null;
    } else {
      previous = encodeContactAuditValue(before[field]);
      if (comparable(field, before[field]) === comparable(field, next)) continue;
    }
    changes.push(
      fits(previous) && fits(after) ? change(field, previous, after) : redactedChange(field),
    );
  }
  for (const field of REDACTED_WHEN_CHANGED) {
    const next = values[field];
    if (next === undefined) continue;
    const moved =
      before === null
        ? next !== null
        : comparable(field, before[field]) !== comparable(field, next);
    if (moved) changes.push(redactedChange(field));
  }
  return changes;
}

export function contactAuditEvent(
  action: 'created' | 'updated',
  contact: Contact,
  changes: readonly AuditChange[],
): AuditEventInput {
  return {
    action,
    objectType: 'contact',
    objectId: contact.id,
    objectLabel: contact.id,
    programmeId: contact.programmeId,
    changes,
  };
}
