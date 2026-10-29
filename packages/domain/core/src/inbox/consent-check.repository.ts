import { newId, withTenantTransaction, type TenantSession, type TenantTx } from '@kasuwa/db';
import type { Pool } from 'pg';
import type { SendPurpose } from './send-message.repository';

export type ConsentOutcome = 'allowed' | 'dnd_refused' | 'unavailable';

export async function recordConsentCheck(
  tx: TenantTx,
  programmeId: string,
  e164Hash: string,
  purpose: SendPurpose,
  outcome: ConsentOutcome,
): Promise<void> {
  await tx.query(
    `INSERT INTO consent_check
       (id, tenant_id, programme_id, e164_hash, purpose, outcome)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [newId(), tx.session.tenantId, programmeId, e164Hash, purpose, outcome],
  );
}

/**
 * Records a consent outcome in its own transaction so refusal and fail-closed
 * paths still leave an audit row when the request transaction rolls back.
 */
export async function recordConsentCheckAutocommit(
  pool: Pool,
  session: TenantSession,
  programmeId: string,
  e164Hash: string,
  purpose: SendPurpose,
  outcome: ConsentOutcome,
): Promise<void> {
  await withTenantTransaction(pool, { tenantId: session.tenantId, userId: session.userId }, (tx) =>
    recordConsentCheck(tx, programmeId, e164Hash, purpose, outcome),
  );
}
