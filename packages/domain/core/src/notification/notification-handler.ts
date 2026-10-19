import { randomUUID } from 'node:crypto';
import type { ConsumedOutboxEvent, TenantTx } from '@kasuwa/db';
import { fieldLevel, UnknownObjectDefError } from '@kasuwa/metadata-engine';
import { loadFieldAccessForUser } from '@kasuwa/metadata-engine/field-access-for-user';
import { canProgramme, canReadPipelines, type Grants } from '@kasuwa/permissions';
import type { OwnerChangeObject } from './owner-events';
import { NOTIFICATION_KIND_OF, type NotificationObjectType } from './notification-events';

/**
 * The notifications consumer's handler (T-0100; ADR-0018 point 8; D-L156,
 * D-L157, D-L161, D-L164). `consumeOutboxJob` has already re-entered the
 * tenant AS THE EVENT'S ACTOR and re-read the event under RLS, so everything
 * here runs in the actor's scope, on the row the database holds, never on
 * what Redis carried.
 *
 * ACT ON CURRENT STATE (N-R1). The payload only GATES; the recipient always
 * comes from the row. The aggregate is re-read within the event's programme,
 * and a notification is written only when its CURRENT owner equals the
 * payload's `newOwnerId`. A stale event (the record was reassigned again
 * before this one was consumed), a raw-SQL event naming someone who is not the
 * owner, and an aggregate that is gone, merged away or in another programme
 * all write nothing.
 *
 * WHO IS NEVER NOTIFIED (N-R2, N-R3):
 *   - the actor (a self-assignment);
 *   - nobody, when the owner was cleared (D-P23);
 *   - a recipient who is not an active member of the object's programme now;
 *   - a recipient who cannot read the object now (judged on THEIR own rights:
 *     a deal needs a pipeline-reading set, an import needs `contact.import`);
 *   - a recipient from whom `owner_user_id` is withheld by field security in
 *     that programme: "you were assigned X" would tell them who owns X, which
 *     the record itself withholds from them.
 *
 * IDEMPOTENT WITHOUT ON CONFLICT (D-L164). Delivery is at-least-once, and a
 * handler that throws is retried five times and then parked. A plain INSERT in
 * a SAVEPOINT treats 23505 on (source_event_id, recipient_user_id) as "already
 * delivered": INSERT ... ON CONFLICT needs SELECT rights, which the
 * restrictive recipient-only SELECT policy refuses the actor. No RETURNING,
 * for the same reason. A concurrent twin blocks on the unique index until the
 * first commits, then gets 23505 the same way.
 *
 * WRITES IDS AND CODES ONLY (D-P29) and logs nothing: the outcome is a fixed
 * word.
 */

export type NotificationHandling = 'written' | 'duplicate' | 'skipped';

const SAVEPOINT = 'kasuwa_notification_delivery';
const UNIQUE_KEY = 'notification_source_event_recipient_key';

/**
 * Each aggregate's table, selected by a fixed map: no identifier ever comes from an event.
 *
 * tenancy-reviewed: each statement filters on id, tenant (the session's) and the
 * event's programme (one the consumer already checked is in scope), beside RLS.
 */
const OWNER_SQL: Readonly<Record<OwnerChangeObject, string>> = {
  contact: `SELECT owner_user_id FROM contact
             WHERE id = $1 AND tenant_id = $2 AND programme_id = $3 AND deleted_at IS NULL`,
  account: `SELECT owner_user_id FROM account
             WHERE id = $1 AND tenant_id = $2 AND programme_id = $3`,
  deal: `SELECT owner_user_id FROM deal
          WHERE id = $1 AND tenant_id = $2 AND programme_id = $3`,
  activity: `SELECT owner_user_id FROM activity
              WHERE id = $1 AND tenant_id = $2 AND programme_id = $3`,
};

const OBJECT_DEF: Readonly<Record<OwnerChangeObject, string>> = {
  contact: 'contact',
  account: 'account',
  deal: 'deal',
  activity: 'activity',
};

const EVENT_OBJECT: Readonly<Record<string, { object: OwnerChangeObject; key: string }>> = {
  'contact.owner_changed': { object: 'contact', key: 'contactId' },
  'account.owner_changed': { object: 'account', key: 'accountId' },
  'deal.owner_changed': { object: 'deal', key: 'dealId' },
  'activity.assigned': { object: 'activity', key: 'activityId' },
};

interface OwnerRow {
  owner_user_id: string | null;
}

interface MemberRow {
  is_tenant_admin: boolean;
  set_key: string | null;
}

/**
 * The recipient's grants in ONE programme, or null when they are not an
 * active member of it. Read under the actor's RLS: `user`, `user_programme`
 * and `permission_set` are tenant-scoped.
 */
async function recipientGrants(
  tx: TenantTx,
  userId: string,
  programmeId: string,
): Promise<Grants | null> {
  // tenancy-reviewed: tenant from the session; the recipient and programme are
  // the event's (the programme is in the session's scope, checked by the
  // consumer); RLS besides.
  const rows = await tx.query<MemberRow>(
    `SELECT u.is_tenant_admin, ps.key AS set_key
       FROM "user" u
       JOIN user_programme up
         ON up.tenant_id = u.tenant_id AND up.user_id = u.id
       LEFT JOIN permission_set ps
         ON ps.tenant_id = up.tenant_id AND ps.id = up.permission_set_id
      WHERE u.tenant_id = $1
        AND u.id = $2
        AND u.status = 'active'
        AND up.programme_id = $3`,
    [tx.session.tenantId, userId, programmeId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    isTenantAdmin: row.is_tenant_admin,
    reachableProgrammeIds: [programmeId],
    programmeSets: new Map([[programmeId, row.set_key]]),
  };
}

/** Whether the recipient may read an object of this type in the programme (a read, so never 403). */
export function recipientMayRead(
  grants: Grants,
  objectType: NotificationObjectType,
  programmeId: string,
): boolean {
  switch (objectType) {
    case 'deal':
      return canReadPipelines(grants, programmeId);
    case 'import':
      return canProgramme(grants, 'contact.import', programmeId);
    default:
      // Contacts, accounts and activities are read by every member (RLS).
      return grants.reachableProgrammeIds.includes(programmeId);
  }
}

/** True when field security withholds `owner_user_id` from the recipient. Fails closed. */
async function ownerWithheldFrom(
  tx: TenantTx,
  object: OwnerChangeObject,
  recipientId: string,
  programmeId: string,
): Promise<boolean> {
  try {
    const access = await loadFieldAccessForUser(tx, OBJECT_DEF[object], recipientId, [programmeId]);
    return fieldLevel(access, programmeId, 'owner_user_id') === 'none';
  } catch (error) {
    // No definition for the object: every field is withheld (fail closed).
    // Anything else (a lost connection, a bug) is NOT swallowed: it rejects
    // and the job is retried, never silently skipped (D-L174).
    if (error instanceof UnknownObjectDefError) return true;
    throw error;
  }
}

interface Delivery {
  readonly programmeId: string;
  readonly recipientUserId: string;
  readonly actorUserId: string;
  readonly objectType: NotificationObjectType;
  readonly objectId: string;
  readonly sourceEventId: string;
}

/** Plain INSERT in a SAVEPOINT; 23505 on the idempotency key is "already delivered". */
async function deliver(
  tx: TenantTx,
  delivery: Delivery,
): Promise<'written' | 'duplicate' | 'skipped'> {
  await tx.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    // tenancy-reviewed: tenant and actor from the session (the restrictive
    // INSERT policy pins the actor again); the programme is the event's, one
    // the session reaches (the permissive WITH CHECK refuses any other).
    await tx.query(
      `INSERT INTO notification
         (id, tenant_id, programme_id, recipient_user_id, kind, object_type, object_id,
          actor_user_id, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        randomUUID(),
        tx.session.tenantId,
        delivery.programmeId,
        delivery.recipientUserId,
        NOTIFICATION_KIND_OF[delivery.objectType],
        delivery.objectType,
        delivery.objectId,
        delivery.actorUserId,
        delivery.sourceEventId,
      ],
    );
    await tx.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return 'written';
  } catch (error) {
    const refused = isDuplicateDelivery(error)
      ? 'duplicate'
      : isUndeliverable(error)
        ? 'skipped'
        : null;
    if (refused === null) throw error;
    await tx.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    await tx.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return refused;
  }
}

/**
 * Failures that retrying cannot fix, so the job is SKIPPED, not retried five
 * times and parked (D-L174): 23503 on the recipient FK (the recipient was
 * deleted between the read and the insert) and 42501 (the actor lost the
 * programme between the consumer's check and the insert, so RLS refuses the
 * row). Nothing from the error is kept.
 */
export function isUndeliverable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  if (code === '42501') return true;
  return code === '23503' && constraint === 'notification_recipient_same_tenant_fk';
}

/** True for 23505 on the idempotency key, and for nothing else. */
export function isDuplicateDelivery(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === '23505' && constraint === UNIQUE_KEY;
}

async function handleOwnerEvent(
  tx: TenantTx,
  event: ConsumedOutboxEvent,
  object: OwnerChangeObject,
  key: string,
): Promise<NotificationHandling> {
  const payload = event.payload;
  const aggregateId = payload[key];
  const newOwnerId = payload['newOwnerId'];
  // The registry's schema guarantees both; a row that disagrees is dropped.
  if (typeof aggregateId !== 'string' || aggregateId !== event.aggregateId) return 'skipped';
  if (typeof newOwnerId !== 'string') return 'skipped'; // unassignment: D-P23

  const current = await tx.query<OwnerRow>(OWNER_SQL[object], [
    event.aggregateId,
    tx.session.tenantId,
    event.programmeId,
  ]);
  const owner = current[0]?.owner_user_id ?? null;
  // N-R1: current state decides; the payload only gates.
  if (owner === null || owner !== newOwnerId) return 'skipped';
  // N-R2: never the actor.
  if (owner === event.actorUserId) return 'skipped';

  const grants = await recipientGrants(tx, owner, event.programmeId);
  if (grants === null) return 'skipped';
  if (!recipientMayRead(grants, object, event.programmeId)) return 'skipped';
  // N-R3: do not reveal an owner the recipient's own record read withholds.
  if (await ownerWithheldFrom(tx, object, owner, event.programmeId)) return 'skipped';

  return deliver(tx, {
    programmeId: event.programmeId,
    recipientUserId: owner,
    actorUserId: event.actorUserId,
    objectType: object,
    objectId: event.aggregateId,
    sourceEventId: event.id,
  });
}

interface ImportRow {
  created_by_user_id: string;
  status: string;
}

async function handleImportFinished(
  tx: TenantTx,
  event: ConsumedOutboxEvent,
): Promise<NotificationHandling> {
  // tenancy-reviewed: id, tenant (the session's) and the event's programme,
  // which the consumer checked is in scope; RLS besides.
  const rows = await tx.query<ImportRow>(
    `SELECT created_by_user_id, status FROM import_job
      WHERE id = $1 AND tenant_id = $2 AND programme_id = $3`,
    [event.aggregateId, tx.session.tenantId, event.programmeId],
  );
  const job = rows[0];
  if (job === undefined) return 'skipped';
  // Only a job that has ended, and only for the user who started it, who is
  // also the actor: the worker runs a job as its creator, so any other actor
  // is a forged "X finished your import" (an import is exempt from the
  // never-notify-the-actor rule: the creator IS the actor).
  if (job.status !== 'finished' && job.status !== 'failed') return 'skipped';
  if (job.created_by_user_id !== event.actorUserId) return 'skipped';

  const grants = await recipientGrants(tx, job.created_by_user_id, event.programmeId);
  if (grants === null) return 'skipped';
  if (!recipientMayRead(grants, 'import', event.programmeId)) return 'skipped';

  return deliver(tx, {
    programmeId: event.programmeId,
    recipientUserId: job.created_by_user_id,
    actorUserId: event.actorUserId,
    objectType: 'import',
    objectId: event.aggregateId,
    sourceEventId: event.id,
  });
}

/**
 * The notifications OutboxHandler (T-0100 I1): what apps/worker registers with
 * `outboxConsumerProcessor(consumeOutboxJob, appPool,
 * 'kasuwa.events.notifications', handleNotificationEvent, write)`. A duplicate
 * delivery RESOLVES (never rejects), so it is not retried and not parked.
 */
export async function handleNotificationEvent(
  tx: TenantTx,
  event: ConsumedOutboxEvent,
): Promise<NotificationHandling> {
  const owner = Object.prototype.hasOwnProperty.call(EVENT_OBJECT, event.eventType)
    ? EVENT_OBJECT[event.eventType]
    : undefined;
  if (owner !== undefined) return handleOwnerEvent(tx, event, owner.object, owner.key);
  if (event.eventType === 'import.finished') return handleImportFinished(tx, event);
  // Another queue's type never gets here (the consumer is bound to its queue).
  return 'skipped';
}
