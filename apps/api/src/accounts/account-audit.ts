import type { Account, AccountValues } from '@kasuwa/domain-core';
import {
  redactedChange,
  type AuditChange,
  type AuditEventInput,
} from '../admin/audit/audit-writer';

/**
 * What an account write records (T-0055; S2 of the suite, D-L54, D-L63,
 * D-L78).
 *
 * The contract: changes are "field names, never values". So every change is a
 * redacted one: the wire name of the field (D-L48), `redacted: true`, before
 * and after null. No value of any kind is stored, not even a tier code, and
 * the label is the record id (D-L63: a sole trader's account name is a
 * person's name).
 *
 *   - Recorded WHENEVER SENT: free text (name, industry, tags, State, LGA)
 *     and phones (D-L54). Deciding whether such a value moved would mean
 *     comparing personal data only to then not record it; the field name is
 *     the event.
 *   - Recorded only when the value actually changed: the closed value set and
 *     the ids (tier, owner, parent). On a create, every one that was set.
 */

const ALWAYS_WHEN_SENT: readonly (keyof AccountValues)[] = [
  'name',
  'industry',
  'tags',
  'phones',
  'state',
  'lga',
];

const WHEN_CHANGED: readonly (keyof AccountValues & keyof Account)[] = [
  'tier',
  'ownerUserId',
  'parentAccountId',
];

/** Uuid-valued fields: the same id in either case is the same value. */
const ID_FIELDS: ReadonlySet<keyof AccountValues> = new Set(['ownerUserId', 'parentAccountId']);

function comparable(field: keyof AccountValues, value: unknown): unknown {
  return ID_FIELDS.has(field) && typeof value === 'string' ? value.toLowerCase() : value;
}

/** The changes a write records. `before` is null for a create. */
export function accountChanges(values: AccountValues, before: Account | null): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const field of ALWAYS_WHEN_SENT) {
    if (values[field] !== undefined) changes.push(redactedChange(field));
  }
  for (const field of WHEN_CHANGED) {
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

export function accountAuditEvent(
  action: 'created' | 'updated',
  account: Account,
  changes: readonly AuditChange[],
): AuditEventInput {
  return {
    action,
    objectType: 'account',
    objectId: account.id,
    objectLabel: account.id,
    programmeId: account.programmeId,
    changes,
  };
}
