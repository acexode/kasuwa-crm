import {
  change,
  redactedChange,
  type AuditChange,
  type AuditEventInput,
} from '../admin/audit/audit-writer';
import type { Deal } from './deal.repository';
import type { DealWritableField } from './deals.schemas';

/**
 * What a deal write records (T-0108; D-L72, D-L88, D-L115, R8-R11).
 *
 * One event per successful write, `objectType: 'deal'`, labelled by the deal
 * id, never its name (R8): a deal name and a next step hold people's names in
 * practice (D-L115). A create is `created`; an update and a move are
 * `updated` (the audit action check has no `moved`). The actor is the session
 * user, which the writer binds itself.
 *
 * Every change is by FIELD NAME ONLY (`redacted: true`, no value), with two
 * exceptions, both identifiers and never a name:
 *   - a move records `stageId` before and after: configuration ids (D-L88);
 *   - a reassignment records `ownerUserId` before and after, canonical lower
 *     case, `null` for no owner (D-L71, D-L115).
 *
 * Nothing here is logged; the event is the record.
 */

/** A create: every body key sent with a non-null value, by name (R10). */
export function dealCreateChanges(
  sent: Partial<Record<DealWritableField, unknown>>,
): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const field of [
    'name',
    'amount',
    'expectedCloseDate',
    'ownerUserId',
    'primaryContactId',
    'accountId',
    'nextStep',
  ] as const) {
    const value = sent[field];
    if (value !== undefined && value !== null) changes.push(redactedChange(field));
  }
  return changes;
}

const lower = (value: string | null) => (value === null ? null : value.toLowerCase());

/** The comparable value of each writable field, never logged or stored. */
function valuesOf(deal: Deal): Record<DealWritableField, string | null> {
  return {
    name: deal.name,
    amount:
      deal.amountMinor === null || deal.currency === null
        ? null
        : `${deal.amountMinor} ${deal.currency}`,
    expectedCloseDate: deal.expectedCloseDate,
    ownerUserId: lower(deal.ownerUserId),
    primaryContactId: lower(deal.primaryContactId),
    accountId: lower(deal.accountId),
    nextStep: deal.nextStep,
  };
}

/**
 * An update: exactly the fields whose stored value changed (R11), by name; a
 * reassignment with both owner ids.
 */
export function dealUpdateChanges(before: Deal, after: Deal): AuditChange[] {
  const was = valuesOf(before);
  const now = valuesOf(after);
  const changes: AuditChange[] = [];
  for (const field of Object.keys(was) as DealWritableField[]) {
    if (was[field] === now[field]) continue;
    changes.push(
      field === 'ownerUserId' ? change(field, was[field], now[field]) : redactedChange(field),
    );
  }
  return changes;
}

/**
 * A move (R9): the stage ids, each field the move filled, by name, `checks`
 * when a check was newly ticked, and `stageEnteredAt` (and `closedAt` when it
 * changed) by name.
 */
export function dealMoveChanges(
  before: Deal,
  after: Deal,
  filled: readonly string[],
  newlyChecked: boolean,
): AuditChange[] {
  const changes: AuditChange[] = [change('stageId', lower(before.stageId), lower(after.stageId))];
  for (const field of filled) changes.push(redactedChange(field));
  if (newlyChecked) changes.push(redactedChange('checks'));
  changes.push(redactedChange('stageEnteredAt'));
  if ((before.closedAt === null) !== (after.closedAt === null)) {
    changes.push(redactedChange('closedAt'));
  }
  return changes;
}

export function dealAuditEvent(
  action: 'created' | 'updated',
  deal: Pick<Deal, 'id' | 'programmeId'>,
  changes: readonly AuditChange[],
): AuditEventInput {
  return {
    action,
    objectType: 'deal',
    objectId: deal.id,
    objectLabel: deal.id,
    programmeId: deal.programmeId,
    changes,
  };
}
