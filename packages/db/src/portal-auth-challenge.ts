import type { Pool } from 'pg';
import { z } from 'zod';
import { releaseClean } from './session';

const Uuid = z.uuid();

export interface PortalAuthChallengeRow {
  tenantId: string;
  programmeId: string;
  portalIdentityId: string;
  attemptCount: number;
  expiresAt: Date;
  consumedAt: Date | null;
}

const PRESENT_CHALLENGE_SQL = `
  SELECT set_config('app.portal_auth_challenge_id', $1, true)
`;

const LOOKUP_CHALLENGE_SQL = `
  SELECT tenant_id, programme_id, portal_identity_id, attempt_count, expires_at, consumed_at
    FROM portal_auth_challenge
   WHERE id = $1
`;

/**
 * Reads a portal MFA challenge by id before tenant context is known (T-0179).
 * Uses the presented-challenge SELECT policy — not a SECURITY DEFINER.
 */
export async function lookupPortalAuthChallenge(
  pool: Pool,
  challengeId: string,
): Promise<PortalAuthChallengeRow | null> {
  const id = Uuid.parse(challengeId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(PRESENT_CHALLENGE_SQL, [id]);
    const result = await client.query<{
      tenant_id: string;
      programme_id: string;
      portal_identity_id: string;
      attempt_count: number;
      expires_at: Date;
      consumed_at: Date | null;
    }>(LOOKUP_CHALLENGE_SQL, [id]);
    await client.query('ROLLBACK');
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          tenantId: row.tenant_id,
          programmeId: row.programme_id,
          portalIdentityId: row.portal_identity_id,
          attemptCount: row.attempt_count,
          expiresAt: row.expires_at,
          consumedAt: row.consumed_at,
        };
  } catch {
    await client.query('ROLLBACK').catch(() => undefined);
    return null;
  } finally {
    await releaseClean(client, false);
  }
}
