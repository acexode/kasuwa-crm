import { randomUUID } from 'node:crypto';
import type { TenantTx } from '@kasuwa/db';

/**
 * Client-portal users and their invitations (T-0030, migration 0013).
 *
 * Same discipline as the programme and contact repositories: every statement
 * repeats the tenant predicate AND `programme_id = ANY(session.programmeIds)`,
 * though the `portal_user` policy enforces both. The programme ids come from
 * `tx.session`, which came from `user_programme` - never from an argument. The
 * `programmeId` argument is a record identifier the caller asked about; one
 * outside the session matches nothing.
 *
 * Nothing here returns the full address except `upsertPortalInvitation`, whose
 * caller needs it to send the invitation. The list returns the masked form
 * only (D-L49). The token is never passed in, only its digest.
 */

export type PortalUserAccess = 'viewer' | 'reports_only';
export type PortalUserStatus = 'invited' | 'active' | 'suspended';

export interface PortalUser {
  id: string;
  displayName: string;
  emailMasked: string;
  access: PortalUserAccess;
  status: PortalUserStatus;
  invitedAt: Date;
}

export interface NewPortalInvitation {
  /** As submitted. Stored; never logged and never returned by a list. */
  email: string;
  emailMasked: string;
  displayName: string;
  access: PortalUserAccess;
  /** SHA-256 of the invite token. */
  tokenHash: Buffer;
  tokenExpiresAt: Date;
}

export interface PortalInvitationResult {
  user: PortalUser;
  /** Where the invitation goes: the stored address (the first one invited, on a resend). */
  deliverTo: string;
  /** `created` for a new portal user; `resent` when one was already pending (D-L49). */
  outcome: 'created' | 'resent';
}

/**
 * The address already belongs to an active or suspended portal user of this
 * programme, so there is nothing to (re)send. Carries no identifier and no
 * address. Unreachable until M18 adds the accept flow.
 */
export class PortalUserNotInvitableError extends Error {
  constructor() {
    super('Portal user is not in an invitable state');
    this.name = 'PortalUserNotInvitableError';
  }
}

interface PortalUserRow {
  id: string;
  display_name: string;
  email_masked: string;
  access: PortalUserAccess;
  status: PortalUserStatus;
  invited_at: Date;
}

const SELECT_PORTAL_USER = `id, display_name, email_masked, access, status, invited_at`;

function toPortalUser(row: PortalUserRow): PortalUser {
  return {
    id: row.id,
    displayName: row.display_name,
    emailMasked: row.email_masked,
    access: row.access,
    status: row.status,
    invitedAt: row.invited_at,
  };
}

/**
 * Portal users and pending invitations of one programme, newest first.
 * Unpaginated, as the spec is: the designed state is empty or nearly so.
 */
export async function listPortalUsers(tx: TenantTx, programmeId: string): Promise<PortalUser[]> {
  // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
  const rows = await tx.query<PortalUserRow>(
    `SELECT ${SELECT_PORTAL_USER}
       FROM portal_user
      WHERE tenant_id = $1
        AND programme_id = $2
        AND programme_id = ANY($3::uuid[])
      ORDER BY invited_at DESC, id DESC`,
    [tx.session.tenantId, programmeId, tx.session.programmeIds],
  );
  return rows.map(toPortalUser);
}

/**
 * Creates a pending portal user, or - when the address is already pending in
 * this programme - rotates its token and re-stamps `invited_at` (a resend,
 * D-L49). The old token's digest is overwritten in the same statement, so the
 * old token stops working the moment this commits. A resend does not change
 * the display name or the access level: it re-sends the invitation that
 * exists, it does not edit it.
 *
 * `null` when `programmeId` is not one the session reaches; the caller checks
 * that first, so `null` means the scope changed under it and is a 404.
 *
 * Throws `PortalUserNotInvitableError` for an active or suspended portal user.
 */
export async function upsertPortalInvitation(
  tx: TenantTx,
  programmeId: string,
  invitation: NewPortalInvitation,
): Promise<PortalInvitationResult | null> {
  // tenancy-reviewed: the INSERT carries the session tenant and is filtered on
  // the session programme ids; the policy's WITH CHECK enforces both again.
  // The id is server-generated, never the caller's.
  const rows = await tx.query<PortalUserRow & { email: string; inserted: boolean }>(
    `INSERT INTO portal_user AS p
            (id, tenant_id, programme_id, email, email_masked, display_name, access,
             invite_token_hash, invite_token_expires_at)
     SELECT $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text, $7::text,
            $8::bytea, $9::timestamptz
      WHERE $3::uuid = ANY($10::uuid[])
     ON CONFLICT (tenant_id, programme_id, lower(email)) DO UPDATE
        SET invite_token_hash = EXCLUDED.invite_token_hash,
            invite_token_expires_at = EXCLUDED.invite_token_expires_at,
            invited_at = now(),
            updated_at = now()
      WHERE p.status = 'invited'
        AND p.tenant_id = $2
        AND p.programme_id = ANY($10::uuid[])
     RETURNING ${SELECT_PORTAL_USER}, email, (xmax = 0) AS inserted`,
    [
      randomUUID(),
      tx.session.tenantId,
      programmeId,
      invitation.email,
      invitation.emailMasked,
      invitation.displayName,
      invitation.access,
      invitation.tokenHash,
      invitation.tokenExpiresAt,
      tx.session.programmeIds,
    ],
  );
  const row = rows[0];
  if (row !== undefined) {
    return {
      user: toPortalUser(row),
      deliverTo: row.email,
      outcome: row.inserted ? 'created' : 'resent',
    };
  }

  if (!tx.session.programmeIds.includes(programmeId)) {
    return null;
  }
  // In scope, and nothing was written: the conflict arm's WHERE refused an
  // existing row that is no longer pending.
  throw new PortalUserNotInvitableError();
}
