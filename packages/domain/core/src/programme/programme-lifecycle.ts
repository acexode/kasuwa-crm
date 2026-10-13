import { ensureDefaultPipelines, newId, type TenantTx } from '@kasuwa/db';
import { ADMIN_PERMISSION_SET_KEY } from '@kasuwa/permissions';
import { versionFromUpdatedAt, NEXT_UPDATED_AT_SQL } from './programme-version';
import {
  DuplicateProgrammeNameError,
  findProgrammeById,
  isUniqueViolation,
  toProgrammeStatus,
  type Programme,
  type ProgrammeStatus,
} from './programme.repository';

/**
 * Programme lifecycle — create, archive preview, archive (T-0029, D-L46).
 *
 * Same discipline as programme.repository.ts: every statement repeats the
 * tenant predicate (and, for an existing programme, `id = ANY(session
 * programme ids)`) on top of RLS. Nothing here accepts a tenant id, a
 * programme scope or a user id from its caller; all three come from
 * `tx.session`.
 */

/** The business unit does not exist in the caller's tenant — or exists in another one. */
export class BusinessUnitNotFoundError extends Error {
  constructor() {
    super('Business unit not found');
    this.name = 'BusinessUnitNotFoundError';
  }
}

/** `confirmation` was not the programme's exact name. Carries neither value. */
export class ArchiveConfirmationMismatchError extends Error {
  constructor() {
    super('Archive confirmation does not match the programme name');
    this.name = 'ArchiveConfirmationMismatchError';
  }
}

export interface CreateProgrammeInput {
  name: string;
  clientName?: string | null | undefined;
  businessUnitId: string;
  /**
   * For tenant provisioning (T-0015), which creates the tenant's one default
   * programme. The admin API never sets it.
   */
  isDefault?: boolean | undefined;
}

/** Archiving is restorable for this many days (archiveProgramme description). */
export const ARCHIVE_RESTORABLE_DAYS = 30;

export interface ArchivePreview {
  agentsLosingAccess: number;
  openInteractionsBecomingReadOnly: number;
  retentionSummary: string | null;
  portalUsersSignedOut: number;
  restorableUntilDays: number;
}

const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Creates a programme in the session's tenant and makes the session's user
 * its first member. Reusable outside HTTP — tenant provisioning (T-0015) calls
 * it inside its own tenant transaction.
 *
 * How this works under RLS (D-L46): the `programme` FOR ALL policy only admits
 * rows whose id is already in the session's programme ids, which a new id
 * never is, and the session GUCs are sealed (T-0020). Migration 0012 adds a
 * permissive FOR INSERT policy checking the tenant alone. The new row is
 * therefore writable but NOT readable in this transaction, so:
 *
 *   - no `INSERT ... RETURNING` (RETURNING is held to the SELECT policies);
 *   - the result is built from the values inserted, with the timestamp read
 *     from the transaction clock first, so `version` is the real one;
 *   - the creator's `user_programme` row (tenant-scoped) goes in here, in the
 *     same transaction, so the programme is reachable from the next request.
 *
 * The creator is always `tx.session.userId`. No caller names who gets access.
 *
 * Throws `BusinessUnitNotFoundError` (unknown or foreign business unit — one
 * error for both, never a hint which) and `DuplicateProgrammeNameError`.
 */
export async function createProgramme(
  tx: TenantTx,
  input: CreateProgrammeInput,
): Promise<Programme> {
  const { tenantId, userId } = tx.session;

  // tenancy-reviewed: tenant_id as well as RLS (business_unit is tenant-scoped).
  const unit = await tx.query<{ id: string }>(
    `SELECT id FROM business_unit WHERE id = $1 AND tenant_id = $2`,
    [input.businessUnitId, tenantId],
  );
  if (unit.length === 0) {
    throw new BusinessUnitNotFoundError();
  }

  // One instant for both columns, truncated to the version's millisecond
  // precision, rendered the way programme-version.ts parses.
  //
  // LOAD-BEARING FOR RLS (0015): created_at must be
  // date_trunc('milliseconds', clock_timestamp()) - never earlier than
  // date_trunc('milliseconds', transaction_timestamp()). The creation marker
  // ANDs that with the xmin test so a frozen pre-wraparound row can never
  // pass as "created in this transaction". Do not backdate it.
  const clock = await tx.query<{ at: string }>(
    `SELECT to_char(date_trunc('milliseconds', clock_timestamp()) AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
  );
  const at = clock[0]?.at;
  if (at === undefined) {
    throw new Error('Transaction clock returned no row');
  }

  const id = newId();
  const clientName = input.clientName ?? null;
  const isDefault = input.isDefault ?? false;
  const status: ProgrammeStatus = 'active';

  try {
    // tenancy-reviewed: tenant_id from the session; admitted by
    // programme_insert_in_tenant (0012). Deliberately no RETURNING.
    await tx.query(
      `INSERT INTO programme
         (id, tenant_id, business_unit_id, name, client_name, is_default, status,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz)`,
      [id, tenantId, input.businessUnitId, input.name, clientName, isDefault, status, at],
    );
  } catch (error) {
    if (isUniqueViolation(error, 'programme_tenant_id_name_key')) {
      throw new DuplicateProgrammeNameError();
    }
    // The business unit vanished between the check and the insert. The
    // composite FK carries tenant_id, so a foreign unit fails here too.
    if (isForeignKeyViolation(error, 'programme_bu_same_tenant_fk')) {
      throw new BusinessUnitNotFoundError();
    }
    throw error;
  }

  // tenancy-reviewed: tenant_id + user id from the session. The creator
  // administers what they made: they hold the tenant's `admin` set here
  // (T-0032), or no set at all if the tenant has none (NULL = no permission).
  // RLS admits this row only because the programme was written by THIS
  // transaction: 0015's user_programme_insert_in_scope compares the
  // programme row's xmin with the current transaction id (D-L51).
  await tx.query(
    `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
     VALUES ($1, $2, $3,
             (SELECT ps.id FROM permission_set ps WHERE ps.tenant_id = $3 AND ps.key = $4))`,
    [userId, id, tenantId, ADMIN_PERMISSION_SET_KEY],
  );

  // The new programme's default pipeline (T-0106, D-L113, R9), from the
  // template, in this same transaction: when it commits, the programme has
  // one. As kasuwa_app the session's scope was resolved before the programme
  // existed; the pipeline tables admit these rows only because the programme
  // was written by THIS transaction (0036 uses 0015's creation marker), so
  // nothing here widens what any session can reach.
  // tenancy-reviewed: tenant id from the session; the programme just created.
  await ensureDefaultPipelines((text, values) => tx.query(text, values), tenantId, id);

  return {
    id,
    businessUnitId: input.businessUnitId,
    name: input.name,
    clientName,
    isDefault,
    status,
    version: versionFromUpdatedAt(at),
  };
}

/**
 * What archiving would do, computed now and never cached. `null` when the
 * programme is not reachable.
 *
 *   - `agentsLosingAccess` — the programme's `user_programme` rows.
 *   - `openInteractionsBecomingReadOnly` — 0: no interaction model exists yet.
 *   - `portalUsersSignedOut` — 0: no portal-user model exists yet.
 *   - `retentionSummary` — null: no retention policy exists yet (M21).
 *
 * Counts only. No user id or name leaves this function.
 */
export async function getProgrammeArchivePreview(
  tx: TenantTx,
  programmeId: string,
): Promise<ArchivePreview | null> {
  // user_programme is tenant-scoped only under RLS, so reachability is
  // established first — RLS alone would count a sibling programme's members.
  if (
    !tx.session.programmeIds.includes(programmeId) ||
    (await findProgrammeById(tx, programmeId)) === null
  ) {
    return null;
  }
  // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
  const rows = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM user_programme
      WHERE tenant_id = $1
        AND programme_id = $2
        AND programme_id = ANY($3::uuid[])`,
    [tx.session.tenantId, programmeId, tx.session.programmeIds],
  );
  return {
    agentsLosingAccess: rows[0]?.n ?? 0,
    openInteractionsBecomingReadOnly: 0,
    retentionSummary: null,
    portalUsersSignedOut: 0,
    restorableUntilDays: ARCHIVE_RESTORABLE_DAYS,
  };
}

/**
 * Sets `status = 'archived'` if `confirmation` is the programme's exact name.
 *
 * Deletes nothing: memberships, contacts and every other row stay, and
 * assigned users keep read access (D-L46 — enforcing loss of access waits for
 * the permissions engine). Archiving an already-archived programme is a no-op
 * that returns it unchanged, version included (idempotent, D-L46).
 *
 * `null` when the programme is not reachable — decided before the
 * confirmation is compared, so a guessed name on an unreachable id learns
 * nothing. The row is locked by the read, so the comparison and the write are
 * one decision against a name a concurrent rename cannot change underneath.
 */
export async function archiveProgramme(
  tx: TenantTx,
  programmeId: string,
  confirmation: string,
): Promise<Programme | null> {
  // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
  const current = await tx.query<{ name: string; status: string }>(
    `SELECT name, status
       FROM programme
      WHERE id = $1
        AND tenant_id = $2
        AND id = ANY($3::uuid[])
        FOR UPDATE`,
    [programmeId, tx.session.tenantId, tx.session.programmeIds],
  );
  const row = current[0];
  if (row === undefined) {
    return null;
  }
  if (confirmation !== row.name) {
    throw new ArchiveConfirmationMismatchError();
  }
  if (toProgrammeStatus(row.status) !== 'archived') {
    // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
    await tx.query(
      `UPDATE programme
          SET status = 'archived',
              updated_at = ${NEXT_UPDATED_AT_SQL}
        WHERE id = $1
          AND tenant_id = $2
          AND id = ANY($3::uuid[])`,
      [programmeId, tx.session.tenantId, tx.session.programmeIds],
    );
  }
  return findProgrammeById(tx, programmeId);
}

function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === FOREIGN_KEY_VIOLATION && candidate.constraint === constraint;
}
