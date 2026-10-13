import { newId, type TenantTx } from '@kasuwa/db';

/**
 * Activity reads and writes (T-0061; the table is 0027, T-0060).
 *
 * The contact repository's rules, unchanged (packages/domain/core/CLAUDE.md):
 *   - every function takes a TenantTx; tenant and programme scope come from
 *     `tx.session`, never from the caller;
 *   - every WHERE repeats `tenant_id` and the session's programmes even though
 *     RLS (activity_isolation) enforces both: two independent layers;
 *   - an out-of-scope row is `null` here and `404` at the API;
 *   - no SQL is built from input: columns are constants, values are bound.
 *
 * What only this file knows about an activity:
 *   - its id is minted HERE (`newId()`), never accepted from a client (D-L79):
 *     a global primary key a client could choose is an existence oracle;
 *   - `created_by_user_id` is the session's user, bound from `tx.session`
 *     (D-L79), and nothing updates it (0027 grants kasuwa_app no UPDATE on it
 *     or on `created_at`);
 *   - `id`, `tenant_id` and `programme_id` are never in a SET (0027's key
 *     guard refuses them anyway).
 *
 * Nothing here decides permission, field security or whether an owner may
 * own the activity (D-L67): the API does, before it calls a write.
 */

/** 0027's codes, and `meeting` since 0034 (T-0082). */
export const ACTIVITY_TYPES = ['note', 'task', 'call', 'meeting'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/**
 * A meeting's longest span: 24 hours. ONE constant for the API's `too_long`
 * (apps/api activities.schemas.ts) and listCalendar's scan bound; 0034's
 * activity_meeting_span_check holds the database to the same `interval '24
 * hours'`. Move all three together, in a new migration.
 */
export const MEETING_MAX_MS = 24 * 60 * 60 * 1000;

export interface Activity {
  id: string;
  programmeId: string;
  type: ActivityType;
  subject: string | null;
  body: string | null;
  dueAt: Date | null;
  completedAt: Date | null;
  /** A meeting's start (0034); `null` on any other type. */
  startsAt: Date | null;
  /** A meeting's end, after `startsAt` (0034); `null` on any other type. */
  endsAt: Date | null;
  ownerUserId: string | null;
  contactId: string | null;
  accountId: string | null;
  /** The linked deal (0037, T-0111): a link, never a target; `null` when none. */
  dealId: string | null;
  /** `null` is the system (an import, a migration). */
  createdByUserId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface ActivityRow {
  id: string;
  programme_id: string;
  type: string;
  subject: string | null;
  body: string | null;
  due_at: Date | null;
  completed_at: Date | null;
  starts_at: Date | null;
  ends_at: Date | null;
  owner_user_id: string | null;
  contact_id: string | null;
  account_id: string | null;
  deal_id: string | null;
  created_by_user_id: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLUMNS = `
  id, programme_id, type, subject, body, due_at, completed_at, starts_at, ends_at,
  owner_user_id, contact_id, account_id, deal_id, created_by_user_id, version, created_at,
  updated_at
`;

/** A stored type outside the CHECK. 0027 makes this impossible; carries no value. */
export class ActivityTypeUnknownError extends Error {
  constructor() {
    super('An activity row carries a type outside the known set');
    this.name = 'ActivityTypeUnknownError';
  }
}

export function isActivityType(value: string): value is ActivityType {
  return (ACTIVITY_TYPES as readonly string[]).includes(value);
}

function toActivity(row: ActivityRow): Activity {
  if (!isActivityType(row.type)) throw new ActivityTypeUnknownError();
  return {
    id: row.id,
    programmeId: row.programme_id,
    type: row.type,
    subject: row.subject,
    body: row.body,
    dueAt: row.due_at,
    completedAt: row.completed_at,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    ownerUserId: row.owner_user_id,
    contactId: row.contact_id,
    accountId: row.account_id,
    dealId: row.deal_id,
    createdByUserId: row.created_by_user_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Thrown for a programme outside the session. The API answers 404 before this. */
export class ActivityProgrammeOutOfScopeError extends Error {
  constructor() {
    super('Refusing to write an activity in a programme outside the session scope');
    this.name = 'ActivityProgrammeOutOfScopeError';
  }
}

function assertInScope(tx: TenantTx, programmeId: string): void {
  if (!tx.session.programmeIds.includes(programmeId)) {
    throw new ActivityProgrammeOutOfScopeError();
  }
}

/**
 * One activity the session reaches, or null: another tenant's, a sibling
 * programme's and an absent one are the same `null`.
 *
 * tenancy-reviewed: id AND tenant (session) AND programme in the session's
 * scope; RLS besides.
 */
export async function findActivityById(tx: TenantTx, id: string): Promise<Activity | null> {
  const rows = await tx.query<ActivityRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM activity
      WHERE id = $1
        AND tenant_id = $2
        AND programme_id = ANY($3::uuid[])`,
    [id, tx.session.tenantId, [...tx.session.programmeIds]],
  );
  const row = rows[0];
  return row === undefined ? null : toActivity(row);
}

/**
 * The programme of a create's target, if the session reaches it: the
 * contact's when a contact is named, else the account's. `null` for an
 * unreachable or absent target, one answer for another programme, another
 * tenant and nowhere. Reads the programme id only, never the record.
 *
 * tenancy-reviewed: tenant from the session, the programme required to be in
 * the session's scope; RLS on contact and account besides.
 */
export async function findActivityTargetProgramme(
  tx: TenantTx,
  target: { kind: 'contact' | 'account'; id: string },
): Promise<string | null> {
  // A constant per kind, never input.
  const table = target.kind === 'contact' ? 'contact' : 'account';
  const rows = await tx.query<{ programme_id: string }>(
    `SELECT programme_id
       FROM ${table}
      WHERE id = $1
        AND tenant_id = $2
        AND programme_id = ANY($3::uuid[])`,
    [target.id, tx.session.tenantId, [...tx.session.programmeIds]],
  );
  return rows[0]?.programme_id ?? null;
}

/**
 * Is `contactId` a contact in `programmeId`? For the second target of a
 * create, which must be in the activity's own programme (0027's composite
 * key): answering here turns a 23503 (a 500) into the same refusal as an id
 * that names nothing.
 *
 * tenancy-reviewed: tenant from the session, the programme both named and
 * required to be in the session's scope; RLS on contact besides.
 */
export async function programmeContactExists(
  tx: TenantTx,
  programmeId: string,
  contactId: string,
): Promise<boolean> {
  const rows = await tx.query<{ ok: number }>(
    `SELECT 1 AS ok
       FROM contact
      WHERE tenant_id = $1
        AND programme_id = $2
        AND programme_id = ANY($3::uuid[])
        AND id = $4`,
    [tx.session.tenantId, programmeId, [...tx.session.programmeIds], contactId],
  );
  return rows.length > 0;
}

/**
 * Is `dealId` a deal in `programmeId`? For an activity's deal link (T-0111,
 * R2), which must be in the activity's own programme (0037's composite key):
 * answering here turns a 23503 (a 500) into one `unknown_reference`, the same
 * whether the deal is real in another programme or tenant, or names nothing.
 * Reads existence only, never the deal.
 *
 * tenancy-reviewed: tenant from the session, the programme both named and
 * required to be in the session's scope; RLS on deal besides.
 */
export async function programmeDealExists(
  tx: TenantTx,
  programmeId: string,
  dealId: string,
): Promise<boolean> {
  const rows = await tx.query<{ ok: number }>(
    `SELECT 1 AS ok
       FROM deal
      WHERE tenant_id = $1
        AND programme_id = $2
        AND programme_id = ANY($3::uuid[])
        AND id = $4`,
    [tx.session.tenantId, programmeId, [...tx.session.programmeIds], dealId],
  );
  return rows.length > 0;
}

/** What a create writes. Server-owned columns are not here. */
export interface NewActivityValues {
  type: ActivityType;
  subject: string | null;
  body: string | null;
  dueAt: string | null;
  /** A meeting's times (0034); both or neither, as the CHECK requires. */
  startsAt: string | null;
  endsAt: string | null;
  ownerUserId: string | null;
  contactId: string | null;
  accountId: string | null;
  /**
   * The deal link (0037, T-0111); must be a deal in the same programme (the
   * API checks first). Omitted is no link.
   */
  dealId?: string | null | undefined;
}

/**
 * Inserts an activity in `programmeId`, which must be in the session's scope.
 * The id is minted here and the creator is the session user (D-L79).
 *
 * tenancy-reviewed: tenant and creator from the session, programme checked
 * against the session; RLS WITH CHECK and the composite keys refuse either
 * independently.
 */
export async function insertActivity(
  tx: TenantTx,
  programmeId: string,
  values: NewActivityValues,
): Promise<Activity> {
  assertInScope(tx, programmeId);
  const rows = await tx.query<ActivityRow>(
    `INSERT INTO activity
       (id, tenant_id, programme_id, type, subject, body, due_at, owner_user_id,
        contact_id, account_id, created_by_user_id, starts_at, ends_at, deal_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text,
             $7::timestamptz, $8::uuid, $9::uuid, $10::uuid, $11::uuid,
             $12::timestamptz, $13::timestamptz, $14::uuid)
     RETURNING ${SELECT_COLUMNS}`,
    [
      newId(),
      tx.session.tenantId,
      programmeId,
      values.type,
      values.subject,
      values.body,
      values.dueAt,
      values.ownerUserId,
      values.contactId,
      values.accountId,
      tx.session.userId,
      values.startsAt,
      values.endsAt,
      values.dealId ?? null,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('INSERT ... RETURNING returned no row');
  return toActivity(row);
}

/**
 * What an update may change: completion (server time), the owner, a task's
 * due time (snooze, T-0082), a meeting's times (reschedule, T-0082) and the
 * deal link (T-0111).
 * `undefined` leaves a column untouched (D-L102); `dueAt: null` clears it.
 * Times are UTC ISO strings, bound as `timestamptz`, never through a `Date`.
 */
export interface ActivityChanges {
  /** Set `completed_at` to now, unless it is already set. */
  complete?: boolean | undefined;
  ownerUserId?: string | null | undefined;
  dueAt?: string | null | undefined;
  startsAt?: string | undefined;
  endsAt?: string | undefined;
  /** Set, move (a uuid) or clear (`null`) the deal link (0037, T-0111). */
  dealId?: string | null | undefined;
}

/**
 * Applies `changes` to one activity iff its version is still `version`.
 * Null when no row matched (the version moved): the API answers 409. The
 * statement bumps `version` itself, as the contact update does.
 *
 * `completed_at` is the SERVER's clock and is kept if already set, so a
 * repeated "complete" never rewrites when a task was done.
 *
 * tenancy-reviewed: id AND tenant (session) AND programme (checked against the
 * session above) AND version; RLS besides. SET names neither key column, nor
 * created_by_user_id, nor created_at. The time columns come from a constant
 * list (T-0082), never from input.
 */
export async function updateActivityIfVersion(
  tx: TenantTx,
  target: { id: string; programmeId: string; version: number },
  changes: ActivityChanges,
): Promise<Activity | null> {
  assertInScope(tx, target.programmeId);
  const values: unknown[] = [target.id, tx.session.tenantId, target.programmeId, target.version];
  const sets = ['version = version + 1'];
  if (changes.complete === true) sets.push('completed_at = COALESCE(completed_at, now())');
  if (changes.ownerUserId !== undefined) {
    values.push(changes.ownerUserId);
    sets.push(`owner_user_id = $${values.length}::uuid`);
  }
  if (changes.dealId !== undefined) {
    values.push(changes.dealId);
    sets.push(`deal_id = $${values.length}::uuid`);
  }
  // Column names are constants; only the values are bound.
  for (const [column, value] of [
    ['due_at', changes.dueAt],
    ['starts_at', changes.startsAt],
    ['ends_at', changes.endsAt],
  ] as const) {
    if (value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${values.length}::timestamptz`);
  }
  const rows = await tx.query<ActivityRow>(
    `UPDATE activity
        SET ${sets.join(', ')}
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
        AND programme_id = $3::uuid
        AND version = $4::integer
      RETURNING ${SELECT_COLUMNS}`,
    values,
  );
  const row = rows[0];
  return row === undefined ? null : toActivity(row);
}
