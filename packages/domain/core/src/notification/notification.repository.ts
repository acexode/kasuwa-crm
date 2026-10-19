import type { TenantTx } from '@kasuwa/db';
import { fieldLevel, loadFieldAccess, UnknownObjectDefError, type FieldAccess } from '@kasuwa/metadata-engine';
import { canProgramme, canReadPipelines, loadGrants, type Grants } from '@kasuwa/permissions';
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_OBJECT_TYPES,
  type NotificationKind,
  type NotificationObjectType,
} from './notification-events';

/**
 * The notification inbox: the recipient's own rows, and the names resolved for
 * them at read time (T-0100; D-P29, D-L154, D-L157). Every statement repeats
 * the tenant, the RECIPIENT and the session's programmes beside RLS
 * (CLAUDE.md 2.3); the database's restrictive policy pins the recipient a
 * second time, so a typo in either does not leak another user's row.
 *
 * NOTHING STORED IS A NAME. Names are read from each object's own table now,
 * under the READER's scope and field security in the object's programme:
 *   - an object the reader cannot read now (a programme left, rights lost, a
 *     deal in a programme whose pipelines they do not read, a contact merged
 *     away, an object that no longer exists) is DROPPED, never redacted;
 *   - a name field the reader's set withholds is null.
 * Nothing here logs.
 */

export const NOTIFICATION_MAX_PAGE = 100;
export const NOTIFICATION_DEFAULT_PAGE = 25;
/** The unread count examines at most this many of the newest unread (D-L157). */
export const NOTIFICATION_UNREAD_WINDOW = 500;
/** The badge's cap (the contract: 99, then "99+"). */
export const NOTIFICATION_COUNT_CAP = 99;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface NotificationRecord {
  readonly id: string;
  readonly programmeId: string;
  readonly kind: NotificationKind;
  readonly objectType: NotificationObjectType;
  readonly objectId: string;
  readonly actorUserId: string;
  readonly createdAt: Date;
  readonly readAt: Date | null;
}

interface Row {
  id: string;
  programme_id: string;
  kind: string;
  object_type: string;
  object_id: string;
  actor_user_id: string;
  created_at: Date;
  read_at: Date | null;
}

const COLUMNS = `n.id, n.programme_id, n.kind, n.object_type, n.object_id, n.actor_user_id,
                 n.created_at, n.read_at`;

function toRecord(row: Row): NotificationRecord {
  // The table's CHECK admits only these codes; a value outside would be a
  // migration bug, and is refused rather than sent on.
  if (
    !(NOTIFICATION_KINDS as readonly string[]).includes(row.kind) ||
    !(NOTIFICATION_OBJECT_TYPES as readonly string[]).includes(row.object_type)
  ) {
    throw new Error('A notification row holds a code outside the closed vocabulary');
  }
  return {
    id: row.id,
    programmeId: row.programme_id,
    kind: row.kind as NotificationKind,
    objectType: row.object_type as NotificationObjectType,
    objectId: row.object_id,
    actorUserId: row.actor_user_id,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export interface NotificationPageQuery {
  readonly limit: number;
  /** A notification id: the position, resolved from that row (the caller's own). */
  readonly cursorId?: string;
  readonly unreadOnly: boolean;
  readonly kind?: NotificationKind;
}

/**
 * The caller's rows, newest first by (created_at, id), keyset. EXAMINES at most
 * `limit` rows; the page's visible items are a subset (D-P29 drop rule). A
 * cursor naming a row that is not the caller's, or that does not exist, finds
 * no position and so no rows: one empty page, never anyone else's.
 */
export async function listNotificationRows(
  tx: TenantTx,
  query: NotificationPageQuery,
): Promise<{ rows: NotificationRecord[]; nextCursor: string | null }> {
  const { tenantId, userId, programmeIds } = tx.session;
  if (programmeIds.length === 0) return { rows: [], nextCursor: null };
  const found = await tx.query<Row>(
    `SELECT ${COLUMNS}
       FROM notification n
      WHERE n.tenant_id = $1
        AND n.recipient_user_id = $2
        AND n.programme_id = ANY ($3::uuid[])
        AND ($4::text IS NULL OR n.kind = $4::text)
        AND (NOT $5::boolean OR n.read_at IS NULL)
        AND ($6::uuid IS NULL
             OR (n.created_at, n.id) < (SELECT c.created_at, c.id
                                          FROM notification c
                                         WHERE c.id = $6::uuid
                                           AND c.tenant_id = $1
                                           AND c.recipient_user_id = $2))
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT $7::integer`,
    [
      tenantId,
      userId,
      [...programmeIds],
      query.kind ?? null,
      query.unreadOnly,
      query.cursorId ?? null,
      query.limit + 1,
    ],
  );
  const more = found.length > query.limit;
  const page = (more ? found.slice(0, query.limit) : found).map(toRecord);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: more && last !== undefined ? last.id : null };
}

/** The caller's newest unread rows, at most `NOTIFICATION_UNREAD_WINDOW`. */
export async function listUnreadWindow(tx: TenantTx): Promise<NotificationRecord[]> {
  const { tenantId, userId, programmeIds } = tx.session;
  if (programmeIds.length === 0) return [];
  const rows = await tx.query<Row>(
    `SELECT ${COLUMNS}
       FROM notification n
      WHERE n.tenant_id = $1
        AND n.recipient_user_id = $2
        AND n.programme_id = ANY ($3::uuid[])
        AND n.read_at IS NULL
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT $4::integer`,
    [tenantId, userId, [...programmeIds], NOTIFICATION_UNREAD_WINDOW],
  );
  return rows.map(toRecord);
}

/** One of the caller's own notifications, or null (another user's, another tenant's, absent). */
export async function findOwnNotification(
  tx: TenantTx,
  id: string,
): Promise<NotificationRecord | null> {
  const { tenantId, userId, programmeIds } = tx.session;
  if (!UUID.test(id) || programmeIds.length === 0) return null;
  const rows = await tx.query<Row>(
    `SELECT ${COLUMNS}
       FROM notification n
      WHERE n.id = $1::uuid
        AND n.tenant_id = $2
        AND n.recipient_user_id = $3
        AND n.programme_id = ANY ($4::uuid[])`,
    [id, tenantId, userId, [...programmeIds]],
  );
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

/**
 * Marks one of the caller's notifications read (an already-read one keeps its
 * first `read_at`) or unread. Null when it is not the caller's.
 */
export async function setNotificationRead(
  tx: TenantTx,
  id: string,
  read: boolean,
): Promise<NotificationRecord | null> {
  const { tenantId, userId, programmeIds } = tx.session;
  if (!UUID.test(id) || programmeIds.length === 0) return null;
  const rows = await tx.query<Row>(
    `UPDATE notification AS n
        SET read_at = CASE WHEN $5::boolean THEN COALESCE(n.read_at, now()) ELSE NULL END
      WHERE n.id = $1::uuid
        AND n.tenant_id = $2
        AND n.recipient_user_id = $3
        AND n.programme_id = ANY ($4::uuid[])
      RETURNING ${COLUMNS}`,
    [id, tenantId, userId, [...programmeIds], read],
  );
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

/** True when `id` is one of the caller's own notifications (the only valid `throughId`). */
export async function ownNotificationExists(tx: TenantTx, id: string): Promise<boolean> {
  return (await findOwnNotification(tx, id)) !== null;
}

/**
 * Marks the caller's unread notifications read: every one, one kind, and/or
 * only those at or older than `throughId` by (created_at, id), so one that
 * arrived after the caller looked stays unread (D-L154). Covers items whose
 * object is no longer visible too. The caller has validated `throughId`.
 */
export async function markNotificationsRead(
  tx: TenantTx,
  options: { kind?: NotificationKind; throughId?: string },
): Promise<void> {
  const { tenantId, userId, programmeIds } = tx.session;
  if (programmeIds.length === 0) return;
  await tx.query(
    `UPDATE notification AS n
        SET read_at = now()
      WHERE n.tenant_id = $1
        AND n.recipient_user_id = $2
        AND n.programme_id = ANY ($3::uuid[])
        AND n.read_at IS NULL
        AND ($4::text IS NULL OR n.kind = $4::text)
        AND ($5::uuid IS NULL
             OR (n.created_at, n.id) <= (SELECT c.created_at, c.id
                                           FROM notification c
                                          WHERE c.id = $5::uuid
                                            AND c.tenant_id = $1
                                            AND c.recipient_user_id = $2))`,
    [tenantId, userId, [...programmeIds], options.kind ?? null, options.throughId ?? null],
  );
}

// ---------------------------------------------------------------------------
// Names, resolved now, under the reader's scope and field security
// ---------------------------------------------------------------------------

type ObjectKey = string;

/** The key `resolveNotificationObjects` answers on. */
export function notificationObjectKey(objectType: NotificationObjectType, objectId: string): ObjectKey {
  return `${objectType}:${objectId.toLowerCase()}`;
}

interface NamedRow {
  id: string;
  programme_id: string;
  name: string | null;
}

/** Each type's read: a fixed statement, the name column aliased `name`. Live rows only. */
const OBJECT_SQL: Readonly<Record<NotificationObjectType, string>> = {
  contact: `SELECT id, programme_id, display_name AS name FROM contact
             WHERE tenant_id = $1 AND id = ANY ($2::uuid[]) AND programme_id = ANY ($3::uuid[])
               AND deleted_at IS NULL`,
  account: `SELECT id, programme_id, name FROM account
             WHERE tenant_id = $1 AND id = ANY ($2::uuid[]) AND programme_id = ANY ($3::uuid[])`,
  deal: `SELECT id, programme_id, name FROM deal
          WHERE tenant_id = $1 AND id = ANY ($2::uuid[]) AND programme_id = ANY ($3::uuid[])`,
  activity: `SELECT id, programme_id, subject AS name FROM activity
              WHERE tenant_id = $1 AND id = ANY ($2::uuid[]) AND programme_id = ANY ($3::uuid[])`,
  import: `SELECT id, programme_id, filename AS name FROM import_job
            WHERE tenant_id = $1 AND id = ANY ($2::uuid[]) AND programme_id = ANY ($3::uuid[])`,
};

/** The standard field_def api_names that gate each object's display name. */
const NAME_FIELDS: Readonly<Record<Exclude<NotificationObjectType, 'import'>, readonly string[]>> = {
  // D-L68: a contact's name follows its parts, never composed from one of them.
  contact: ['given_names', 'family_name'],
  account: ['name'],
  deal: ['name'],
  activity: ['subject'],
};

async function accessOrNone(tx: TenantTx, objectApiName: string): Promise<FieldAccess> {
  try {
    return await loadFieldAccess(tx, objectApiName);
  } catch (error) {
    // No definition: every field is withheld (fail closed, never the default).
    if (error instanceof UnknownObjectDefError) return new Map();
    throw error;
  }
}

/** Whether the reader may read an object of this type in the programme. */
function readerMayRead(grants: Grants, objectType: NotificationObjectType, programmeId: string): boolean {
  switch (objectType) {
    case 'deal':
      return canReadPipelines(grants, programmeId);
    case 'import':
      return canProgramme(grants, 'contact.import', programmeId);
    default:
      return grants.reachableProgrammeIds.includes(programmeId);
  }
}

function nonEmpty(value: string | null): string | null {
  return value === null || value === '' ? null : value;
}

/**
 * For each notification whose object the READER can read now, the object's
 * display name (null when withheld, empty or erased). An absent key means the
 * item is to be dropped. The object must still be in the notification's own
 * programme.
 */
export async function resolveNotificationObjects(
  tx: TenantTx,
  records: readonly Pick<NotificationRecord, 'programmeId' | 'objectType' | 'objectId'>[],
): Promise<Map<ObjectKey, string | null>> {
  const resolved = new Map<ObjectKey, string | null>();
  const { tenantId, programmeIds } = tx.session;
  if (records.length === 0 || programmeIds.length === 0) return resolved;

  const grants = await loadGrants(tx);
  for (const objectType of NOTIFICATION_OBJECT_TYPES) {
    const wanted = records.filter((record) => record.objectType === objectType);
    if (wanted.length === 0) continue;
    const ids = [...new Set(wanted.map((record) => record.objectId.toLowerCase()))];
    const rows = await tx.query<NamedRow>(OBJECT_SQL[objectType], [
      tenantId,
      ids,
      [...programmeIds],
    ]);
    const byId = new Map(rows.map((row) => [row.id.toLowerCase(), row]));
    const access = objectType === 'import' ? null : await accessOrNone(tx, objectType);
    for (const record of wanted) {
      const row = byId.get(record.objectId.toLowerCase());
      if (row === undefined || row.programme_id !== record.programmeId) continue;
      if (!readerMayRead(grants, objectType, row.programme_id)) continue;
      let readable = true;
      if (access !== null && objectType !== 'import') {
        readable = NAME_FIELDS[objectType].every(
          (field) => fieldLevel(access, row.programme_id, field) !== 'none',
        );
      }
      resolved.set(
        notificationObjectKey(objectType, record.objectId),
        readable ? nonEmpty(row.name) : null,
      );
    }
  }
  return resolved;
}

interface ActorRow {
  user_id: string;
  programme_id: string;
  display_name: string;
}

/**
 * The actors' current display names, keyed `userId:programmeId`: present only
 * while the actor is a member of that programme (the D-P23 former-owner rule),
 * and re-read every time.
 */
export async function resolveNotificationActors(
  tx: TenantTx,
  records: readonly Pick<NotificationRecord, 'programmeId' | 'actorUserId'>[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (records.length === 0) return names;
  const rows = await tx.query<ActorRow>(
    `SELECT up.user_id, up.programme_id, u.display_name
       FROM user_programme up
       JOIN "user" u ON u.tenant_id = up.tenant_id AND u.id = up.user_id
      WHERE up.tenant_id = $1
        AND up.user_id = ANY ($2::uuid[])
        AND up.programme_id = ANY ($3::uuid[])`,
    [
      tx.session.tenantId,
      [...new Set(records.map((record) => record.actorUserId))],
      [...new Set(records.map((record) => record.programmeId))],
    ],
  );
  for (const row of rows) {
    const name = nonEmpty(row.display_name);
    if (name !== null) names.set(actorKey(row.user_id, row.programme_id), name);
  }
  return names;
}

export function actorKey(userId: string, programmeId: string): string {
  return `${userId.toLowerCase()}:${programmeId.toLowerCase()}`;
}
