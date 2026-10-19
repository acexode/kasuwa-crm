import { randomUUID } from 'node:crypto';
import { appendOutboxEvent, type TenantTx } from '@kasuwa/db';

/**
 * The producer half of notifications (T-0100; ADR-0018; D-L161's producer
 * contract). A service calls it right after the statement that changed an
 * owner, in the SAME tenant transaction, so the event commits with the change
 * or not at all.
 *
 *   1. THE ROW LOCK. The caller has just run the UPDATE (or INSERT) that set
 *      the owner, which holds the row's lock until commit. Appending only after
 *      that is what keeps two changes to one record from publishing out of
 *      order (`seq` is assigned at INSERT, not at COMMIT).
 *   2. THE ID is `randomUUID()`, fresh per event: the primary key, the BullMQ
 *      jobId and the consumer's idempotency key.
 *   3. IDS ONLY (D-P29). The payload is the record's id and the two owners'
 *      ids.
 *
 * WHEN NO EVENT IS APPENDED (so nothing is relayed and nothing is consumed):
 *   - the owner did not change (a re-sent owner already in place);
 *   - the new owner is nobody (D-P23: an unassignment notifies no one);
 *   - the new owner is the caller (a self-assignment notifies no one, so the
 *     event would only be dropped by the consumer).
 * The consumer re-checks all of this against current state; skipping here
 * only saves a queue round trip.
 */

export type OwnerChangeObject = 'contact' | 'account' | 'deal' | 'activity';

const EVENT_OF: Readonly<Record<OwnerChangeObject, { eventType: string; key: string }>> = {
  contact: { eventType: 'contact.owner_changed', key: 'contactId' },
  account: { eventType: 'account.owner_changed', key: 'accountId' },
  deal: { eventType: 'deal.owner_changed', key: 'dealId' },
  activity: { eventType: 'activity.assigned', key: 'activityId' },
};

export interface OwnerChange {
  readonly object: OwnerChangeObject;
  readonly id: string;
  readonly programmeId: string;
  /** The owner before the write, or null when there was none (a create). */
  readonly previousOwnerId: string | null;
  /** The owner after the write. */
  readonly newOwnerId: string | null;
}

export interface OwnerEvent {
  readonly eventType: string;
  readonly aggregateType: OwnerChangeObject;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, string | null>>;
}

const sameId = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/**
 * The event a change calls for, or null for none. Pure, so every rule above is
 * unit-tested without a database.
 */
export function ownerEventFor(change: OwnerChange, actorUserId: string): OwnerEvent | null {
  if (change.newOwnerId === null) return null;
  if (sameId(change.previousOwnerId, change.newOwnerId)) return null;
  if (sameId(actorUserId, change.newOwnerId)) return null;
  const definition = EVENT_OF[change.object];
  return {
    eventType: definition.eventType,
    aggregateType: change.object,
    aggregateId: change.id,
    payload: {
      [definition.key]: change.id,
      previousOwnerId: change.previousOwnerId,
      newOwnerId: change.newOwnerId,
    },
  };
}

/** Appends the event for `change`, if it calls for one. True when one was appended. */
export async function appendOwnerChangedEvent(
  tx: TenantTx,
  change: OwnerChange,
): Promise<boolean> {
  const event = ownerEventFor(change, tx.session.userId);
  if (event === null) return false;
  await appendOutboxEvent(tx, {
    id: randomUUID(),
    eventType: event.eventType,
    programmeId: change.programmeId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: event.payload,
  });
  return true;
}

/**
 * `import.finished`: one event per import job (T-0094's worker calls it when a
 * job ends), never one per row. The session user is the job's creator, who is
 * the one notified.
 */
export async function appendImportFinishedEvent(
  tx: TenantTx,
  job: { readonly id: string; readonly programmeId: string },
): Promise<void> {
  await appendOutboxEvent(tx, {
    id: randomUUID(),
    eventType: 'import.finished',
    programmeId: job.programmeId,
    aggregateType: 'import',
    aggregateId: job.id,
    payload: { importId: job.id },
  });
}
