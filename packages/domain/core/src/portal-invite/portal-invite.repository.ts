import { randomUUID } from 'node:crypto';
import type { TenantTx } from '@kasuwa/db';
import { inviteTokenHashHex } from '../portal-user/portal-user-invite';

export { inviteTokenHashHex };

export interface PortalInviteRow {
  id: string;
  emailMasked: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: Date;
  createdAt: Date;
}

export interface NewPortalInviteRecord {
  id: string;
  programmeId: string;
  email: string;
  emailMasked: string;
  tokenHashHex: string;
  invitedByUserId: string;
  expiresAt: Date;
}

const INVITE_RATE_WINDOW_MS = 60 * 60 * 1000;
const INVITE_RATE_MAX = 5;

export async function countRecentPortalInvites(
  tx: TenantTx,
  programmeId: string,
  email: string,
): Promise<number> {
  const rows = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM portal_invite
      WHERE tenant_id = $1
        AND programme_id = $2
        AND programme_id = ANY($3::uuid[])
        AND lower(email) = lower($4)
        AND created_at > now() - ($5::bigint * interval '1 millisecond')`,
    [
      tx.session.tenantId,
      programmeId,
      tx.session.programmeIds,
      email,
      INVITE_RATE_WINDOW_MS,
    ],
  );
  return Number(rows[0]?.count ?? '0');
}

export function portalInviteRateLimited(count: number): boolean {
  return count >= INVITE_RATE_MAX;
}

export async function insertPortalInvite(
  tx: TenantTx,
  invite: NewPortalInviteRecord,
): Promise<void> {
  await tx.query(
    `INSERT INTO portal_invite
       (id, tenant_id, programme_id, email, email_masked, token_hash, status,
        invited_by_user_id, expires_at)
     SELECT $1, $2, $3, $4, $5, $6, 'pending', $7, $8
      WHERE $3 = ANY($9::uuid[])`,
    [
      invite.id,
      tx.session.tenantId,
      invite.programmeId,
      invite.email,
      invite.emailMasked,
      invite.tokenHashHex,
      invite.invitedByUserId,
      invite.expiresAt,
      tx.session.programmeIds,
    ],
  );
}

export async function rotatePortalInviteToken(
  tx: TenantTx,
  programmeId: string,
  email: string,
  tokenHashHex: string,
  expiresAt: Date,
): Promise<string | null> {
  const rows = await tx.query<{ id: string }>(
    `UPDATE portal_invite AS pi
        SET token_hash = $4,
            expires_at = $5,
            status = 'pending',
            updated_at = now()
      WHERE pi.tenant_id = $1
        AND pi.programme_id = $2
        AND pi.programme_id = ANY($6::uuid[])
        AND lower(pi.email) = lower($3)
        AND pi.status = 'pending'
      RETURNING pi.id`,
    [tx.session.tenantId, programmeId, email, tokenHashHex, expiresAt, tx.session.programmeIds],
  );
  return rows[0]?.id ?? null;
}

export interface PortalInviteListPage {
  data: PortalInviteRow[];
  nextCursor: string | null;
}

const LIST_INVITE = `id, email_masked, status, expires_at, created_at`;

function toInviteRow(row: {
  id: string;
  email_masked: string;
  status: PortalInviteRow['status'];
  expires_at: Date;
  created_at: Date;
}): PortalInviteRow {
  return {
    id: row.id,
    emailMasked: row.email_masked,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export async function listPortalInvites(
  tx: TenantTx,
  programmeId: string,
  limit: number,
  cursor: string | undefined,
): Promise<PortalInviteListPage | null> {
  if (!tx.session.programmeIds.includes(programmeId)) {
    return null;
  }

  const capped = Math.min(Math.max(limit, 1), 100);
  let afterCreated: Date | null = null;
  let afterId: string | null = null;
  if (cursor !== undefined && cursor !== '') {
    const sep = cursor.indexOf('|');
    if (sep > 0) {
      afterCreated = new Date(cursor.slice(0, sep));
      afterId = cursor.slice(sep + 1);
    }
  }

  const rows = await tx.query<{
    id: string;
    email_masked: string;
    status: PortalInviteRow['status'];
    expires_at: Date;
    created_at: Date;
  }>(
    `SELECT ${LIST_INVITE}
       FROM portal_invite
      WHERE tenant_id = $1
        AND programme_id = $2
        AND programme_id = ANY($3::uuid[])
        AND (
          $4::timestamptz IS NULL
          OR (created_at, id) < ($4::timestamptz, $5::uuid)
        )
      ORDER BY created_at DESC, id DESC
      LIMIT $6`,
    [
      tx.session.tenantId,
      programmeId,
      tx.session.programmeIds,
      afterCreated,
      afterId,
      capped + 1,
    ],
  );

  const page = rows.slice(0, capped).map(toInviteRow);
  const hasMore = rows.length > capped;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last !== undefined ? `${last.createdAt.toISOString()}|${last.id}` : null;

  return { data: page, nextCursor };
}

export function newPortalInviteId(): string {
  return randomUUID();
}
