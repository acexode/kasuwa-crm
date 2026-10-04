import type { Contact, ContactValues } from '@kasuwa/domain-core';
import {
  redactedChange,
  type AuditChange,
  type AuditEventInput,
} from '../admin/audit/audit-writer';

/**
 * What a contact write records (T-0041; S2 of the suite, D-L54, D-L63).
 *
 * records.openapi.yaml: an update records "which fields changed, never their
 * values". A contact is a PERSON, so every change is a redacted one - the wire
 * name of the field (D-L48), `redacted: true`, before and after null - and no
 * value of any kind is stored, not even a status code.
 *
 *   - Recorded WHENEVER SENT (S2: "phones and emails, whenever sent"): names,
 *     phones, emails, tags (free text), State and LGA (where someone lives).
 *     Deciding whether such a value moved would mean comparing personal data
 *     only to then not record it; the field name is the event.
 *   - Recorded only when the value actually changed: the closed value sets
 *     and ids (status, source, language, channel, consent, WhatsApp opt-in,
 *     owner, account). On a create, every one that was set.
 *   - The label is the record id (D-L63), never the contact's name.
 */

const ALWAYS_WHEN_SENT: readonly (keyof ContactValues)[] = [
  'displayName',
  'givenNames',
  'familyName',
  'phones',
  'emails',
  'tags',
  'state',
  'lga',
];

const WHEN_CHANGED: readonly (keyof ContactValues & keyof Contact)[] = [
  'status',
  'source',
  'preferredLanguage',
  'preferredChannel',
  'consentState',
  'whatsappOptIn',
  'ownerUserId',
  'accountId',
];

/** The changes a write records. `before` is null for a create. */
export function contactChanges(values: ContactValues, before: Contact | null): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const field of ALWAYS_WHEN_SENT) {
    if (values[field] !== undefined) changes.push(redactedChange(field));
  }
  for (const field of WHEN_CHANGED) {
    const next = values[field];
    if (next === undefined) continue;
    const moved = before === null ? next !== null : before[field] !== next;
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
