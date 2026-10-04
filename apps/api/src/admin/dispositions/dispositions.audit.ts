import type { Disposition } from '@kasuwa/domain-core';
import type { TenantTx } from '@kasuwa/db';
import { change, changedFields, recordAuditEvent, type AuditChange } from '../audit/audit-writer';

/**
 * The audit rows for the four disposition writes (T-0033, D-L54). Each is
 * called with the request's `TenantTx` after its write succeeded, so the event
 * commits with the change or not at all; a refusal (404, 400, a duplicate
 * code) throws before reaching here.
 *
 * `objectType: disposition`, `programmeId` the programme (the event is
 * readable only by its members, D-L48). A disposition's code and label are
 * programme configuration agents pick from, not record data, so they may be
 * shown. Values are strings; a field that did not move is not a change.
 */

const DISPOSITION_FIELDS = [
  'code',
  'label',
  'category',
  'noteRequired',
  'followUpRequired',
  'active',
] as const;

const valueOf = (disposition: Disposition | null, field: (typeof DISPOSITION_FIELDS)[number]) =>
  disposition === null ? null : String(disposition[field]);

/** The fields that differ between two states of a disposition. Exported for unit testing. */
export function dispositionChanges(
  previous: Disposition | null,
  updated: Disposition,
): AuditChange[] {
  return changedFields(
    DISPOSITION_FIELDS.map(
      (field) => [field, valueOf(previous, field), valueOf(updated, field)] as const,
    ),
  );
}

/**
 * How many dispositions a reorder moved. A count, not the order itself: a
 * long list's order does not fit an audit value, and the screen re-reads the
 * list anyway. (`deleteRole`'s `movedUserCount` is the precedent, D-L48.)
 */
export function movedCount(previous: readonly Disposition[], updated: readonly Disposition[]) {
  const was = new Map(previous.map((item) => [item.id, item.position]));
  return updated.filter((item) => was.get(item.id) !== item.position).length;
}

export async function auditDispositionCreated(
  tx: TenantTx,
  programmeId: string,
  created: Disposition,
): Promise<void> {
  await recordAuditEvent(tx, {
    action: 'created',
    objectType: 'disposition',
    objectId: created.id,
    objectLabel: created.label,
    programmeId,
    changes: dispositionChanges(null, created),
  });
}

/** Records nothing when nothing moved: a no-op patch is not news (updateProgramme's rule). */
export async function auditDispositionUpdated(
  tx: TenantTx,
  programmeId: string,
  previous: Disposition,
  updated: Disposition,
): Promise<void> {
  const changes = dispositionChanges(previous, updated);
  if (changes.length === 0) return;
  await recordAuditEvent(tx, {
    action: 'updated',
    objectType: 'disposition',
    objectId: updated.id,
    objectLabel: updated.label,
    programmeId,
    changes,
  });
}

/**
 * `previous` is null when the disposition was already deleted: the idempotent
 * repeat `204` changed nothing, so it records nothing (archiveProgramme's rule).
 */
export async function auditDispositionDeleted(
  tx: TenantTx,
  programmeId: string,
  previous: Disposition | null,
): Promise<void> {
  if (previous === null) return;
  await recordAuditEvent(tx, {
    action: 'deleted',
    objectType: 'disposition',
    objectId: previous.id,
    objectLabel: previous.label,
    programmeId,
    // Mirrors `created` (null -> code). The code itself stays reserved (D-L47).
    changes: [change('code', previous.code, null)],
  });
}

/** One event per reorder request (D-L54), whatever it moved; it names the programme's list. */
export async function auditDispositionsReordered(
  tx: TenantTx,
  programmeId: string,
  previous: readonly Disposition[],
  updated: readonly Disposition[],
): Promise<void> {
  await recordAuditEvent(tx, {
    action: 'updated',
    objectType: 'disposition',
    objectId: null,
    objectLabel: 'Disposition order',
    programmeId,
    changes: [
      change('dispositionCount', null, String(updated.length)),
      change('movedCount', null, String(movedCount(previous, updated))),
    ],
  });
}
