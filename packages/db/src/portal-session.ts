import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import {
  assertRoleIntact,
  assertScopeIntact,
  formatProgrammeIds,
  releaseClean,
  SessionScopeViolationError,
  scopeDiverged,
  type SessionScopeSnapshot,
} from './session';

const Uuid = z.uuid();

export interface PortalSessionRequest {
  tenantId: string;
  portalIdentityId: string;
}

export interface PortalTenantSession {
  readonly tenantId: string;
  readonly portalIdentityId: string;
  /** Resolved from portal_programme. Never supplied by the caller. */
  readonly programmeIds: readonly string[];
}

export interface PortalTenantTx {
  readonly session: PortalTenantSession;
  query<T extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<T[]>;
}

export interface PortalSessionIdentity {
  sessionId: string;
  tenantId: string;
  portalIdentityId: string;
}

const SET_PORTAL_CONTEXT_SQL = `
  SELECT
    set_config('app.tenant_id',     $1, true),
    set_config('app.user_id',       $2, true),
    set_config('app.programme_ids', $3, true),
    current_user = session_user AS role_intact
`;

const RESOLVE_PORTAL_PROGRAMMES_SQL = `
  SELECT pp.programme_id
    FROM portal_programme pp
    JOIN portal_identity pi
      ON pi.id = pp.portal_identity_id AND pi.tenant_id = pp.tenant_id
   WHERE pp.portal_identity_id = $1
     AND pi.status = 'active'
   ORDER BY pp.programme_id
`;

const PORTAL_IDENTITY_ACTIVE_SQL = `
  SELECT 1 FROM portal_identity WHERE id = $1 AND status = 'active'
`;

const PRESENT_PORTAL_TOKEN_SQL = `
  SELECT set_config('app.portal_session_token', $1, true)
`;

const RESOLVE_PORTAL_SESSION_SQL = `
  SELECT id AS session_id, tenant_id, portal_identity_id
    FROM portal_session
   WHERE revoked_at IS NULL
     AND expires_at > now()
`;

const LIVE_PORTAL_SESSION_SQL = `
  SELECT 1 AS ok
    FROM portal_session
   WHERE id = $1
     AND tenant_id = $2
     AND portal_identity_id = $3
     AND revoked_at IS NULL
     AND expires_at > now()
`;

/**
 * Resolves a portal bearer token to identifiers, without a third SECURITY DEFINER.
 * Presents the token hash in a transaction-local GUC; RLS admits the matching row.
 */
export async function resolvePortalSessionIdentity(
  pool: Pool,
  tokenHashHex: string,
): Promise<PortalSessionIdentity | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(PRESENT_PORTAL_TOKEN_SQL, [tokenHashHex]);
    const result = await client.query<{
      session_id: string;
      tenant_id: string;
      portal_identity_id: string;
    }>(RESOLVE_PORTAL_SESSION_SQL);
    await client.query('ROLLBACK');
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          sessionId: row.session_id,
          tenantId: row.tenant_id,
          portalIdentityId: row.portal_identity_id,
        };
  } catch {
    await client.query('ROLLBACK').catch(() => undefined);
    return null;
  } finally {
    await releaseClean(client, false);
  }
}

export class UnknownPortalIdentityError extends Error {
  constructor(tenantId: string, portalIdentityId: string) {
    super(`No active portal identity ${portalIdentityId} in tenant ${tenantId}`);
    this.name = 'UnknownPortalIdentityError';
  }
}

const LIVE_PORTAL_TXS = new WeakSet<PortalTenantTx>();

export async function withPortalTenantTransaction<T>(
  pool: Pool,
  request: PortalSessionRequest,
  fn: (tx: PortalTenantTx) => Promise<T>,
): Promise<T> {
  const tenantId = Uuid.parse(request.tenantId);
  const portalIdentityId = Uuid.parse(request.portalIdentityId);

  const client: PoolClient = await pool.connect();
  let discard = false;
  let live: PortalTenantTx | undefined;
  try {
    await client.query('BEGIN');

    const started = await client.query<{ role_intact: boolean | null }>(SET_PORTAL_CONTEXT_SQL, [
      tenantId,
      portalIdentityId,
      '{}',
    ]);
    assertRoleIntact(started.rows[0]);

    const active = await client.query(PORTAL_IDENTITY_ACTIVE_SQL, [portalIdentityId]);
    if (active.rowCount === 0) {
      throw new UnknownPortalIdentityError(tenantId, portalIdentityId);
    }

    const programmeResult = await client.query<{ programme_id: string }>(
      RESOLVE_PORTAL_PROGRAMMES_SQL,
      [portalIdentityId],
    );
    const programmeIds = programmeResult.rows.map((row) => row.programme_id);
    const programmeScope = formatProgrammeIds(programmeIds);

    const scoped = await client.query<{ role_intact: boolean | null }>(SET_PORTAL_CONTEXT_SQL, [
      tenantId,
      portalIdentityId,
      programmeScope,
    ]);
    assertRoleIntact(scoped.rows[0]);

    const expected: SessionScopeSnapshot = {
      tenantId,
      userId: portalIdentityId,
      programmeIds: programmeScope,
    };

    const tx: PortalTenantTx = {
      session: { tenantId, portalIdentityId, programmeIds },
      query: async <R extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
        const result = await client.query<R>(text, values as unknown[]);
        return result.rows;
      },
    };
    live = tx;
    LIVE_PORTAL_TXS.add(tx);

    const value = await fn(tx);

    await assertScopeIntact(client, expected);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    discard = true;
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof SessionScopeViolationError) {
      throw error;
    }
    throw error;
  } finally {
    if (live !== undefined) {
      LIVE_PORTAL_TXS.delete(live);
    }
    await releaseClean(client, discard);
  }
}

/** Re-reads a portal session inside an open portal tenant transaction. */
export async function assertLivePortalSession(
  tx: PortalTenantTx,
  sessionId: string,
): Promise<void> {
  const rows = await tx.query<{ ok: number }>(LIVE_PORTAL_SESSION_SQL, [
    sessionId,
    tx.session.tenantId,
    tx.session.portalIdentityId,
  ]);
  if (rows.length === 0) {
    throw new Error('portal session not live');
  }
}

export function portalScopeDiverged(
  expected: SessionScopeSnapshot,
  actual: SessionScopeSnapshot,
): boolean {
  return scopeDiverged(expected, actual);
}
