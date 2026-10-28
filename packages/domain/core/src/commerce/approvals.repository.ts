import { appendOutboxEvent, newId, type TenantTx } from '@kasuwa/db';
import { findQuoteById } from './quotes.repository';
import {
  effectiveDiscountBps,
  quoteApprovalRequestedEvent,
  type ApprovalRule,
  type DecideApprovalInput,
  type QuoteApproval,
  type QuoteApprovalStatus,
} from './approvals.types';

export class ApprovalProgrammeOutOfScopeError extends Error {
  constructor() {
    super('Refusing to access approval data in a programme outside the session scope');
    this.name = 'ApprovalProgrammeOutOfScopeError';
  }
}

export class ApprovalBelowThresholdError extends Error {
  constructor() {
    super('Quote discount is not above the programme approval threshold');
    this.name = 'ApprovalBelowThresholdError';
  }
}

export class ApprovalNoRuleError extends Error {
  constructor() {
    super('Programme has no approval rule');
    this.name = 'ApprovalNoRuleError';
  }
}

export class ApprovalAlreadyPendingError extends Error {
  constructor() {
    super('Quote already has a pending approval');
    this.name = 'ApprovalAlreadyPendingError';
  }
}

export class ApprovalNotPendingError extends Error {
  constructor() {
    super('Approval is not pending');
    this.name = 'ApprovalNotPendingError';
  }
}

export class ApprovalQuoteNotDraftError extends Error {
  constructor() {
    super('Only a draft quote can request discount approval');
    this.name = 'ApprovalQuoteNotDraftError';
  }
}

function assertInScope(tx: TenantTx, programmeId: string): void {
  if (!tx.session.programmeIds.includes(programmeId)) {
    throw new ApprovalProgrammeOutOfScopeError();
  }
}

interface RuleRow {
  id: string;
  programme_id: string;
  threshold_bps: number;
  approver_permission_set_key: ApprovalRule['approverPermissionSetKey'];
  created_at: Date;
  updated_at: Date;
}

interface ApprovalRow {
  id: string;
  programme_id: string;
  quote_id: string;
  requested_by_user_id: string;
  discount_bps: number;
  status: QuoteApprovalStatus;
  decided_by_user_id: string | null;
  decided_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toRule(row: RuleRow): ApprovalRule {
  return {
    id: row.id,
    programmeId: row.programme_id,
    thresholdBps: row.threshold_bps,
    approverPermissionSetKey: row.approver_permission_set_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toApproval(row: ApprovalRow): QuoteApproval {
  return {
    id: row.id,
    programmeId: row.programme_id,
    quoteId: row.quote_id,
    requestedByUserId: row.requested_by_user_id,
    discountBps: row.discount_bps,
    status: row.status,
    decidedByUserId: row.decided_by_user_id,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const APPROVAL_COLUMNS = `id, programme_id, quote_id, requested_by_user_id, discount_bps,
  status, decided_by_user_id, decided_at, created_at, updated_at`;

export async function findApprovalRule(
  tx: TenantTx,
  programmeId: string,
): Promise<ApprovalRule | null> {
  assertInScope(tx, programmeId);
  const rows = await tx.query<RuleRow>(
    `SELECT id, programme_id, threshold_bps, approver_permission_set_key,
            created_at, updated_at
       FROM approval_rule
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid`,
    [tx.session.tenantId, programmeId],
  );
  const row = rows[0];
  return row ? toRule(row) : null;
}

export async function findApprovalById(
  tx: TenantTx,
  approvalId: string,
): Promise<QuoteApproval | null> {
  const rows = await tx.query<ApprovalRow>(
    `SELECT ${APPROVAL_COLUMNS}
       FROM quote_approval
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND programme_id = ANY($3::uuid[])`,
    [tx.session.tenantId, approvalId, tx.session.programmeIds],
  );
  const row = rows[0];
  return row ? toApproval(row) : null;
}

export async function listApprovals(
  tx: TenantTx,
  programmeId: string,
): Promise<QuoteApproval[]> {
  assertInScope(tx, programmeId);
  const rows = await tx.query<ApprovalRow>(
    `SELECT ${APPROVAL_COLUMNS}
       FROM quote_approval
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid
      ORDER BY created_at DESC, id DESC`,
    [tx.session.tenantId, programmeId],
  );
  return rows.map(toApproval);
}

/**
 * null → caller answers 404 (quote missing / out of scope).
 * Throws domain errors for threshold, draft, pending, missing rule.
 */
export async function requestApproval(
  tx: TenantTx,
  quoteId: string,
): Promise<QuoteApproval | null> {
  const quote = await findQuoteById(tx, quoteId);
  if (quote === null) return null;
  if (quote.status !== 'draft') throw new ApprovalQuoteNotDraftError();

  const rule = await findApprovalRule(tx, quote.programmeId);
  if (rule === null) throw new ApprovalNoRuleError();

  const discountBps = effectiveDiscountBps(quote.discountBps, quote.lines);
  if (discountBps <= rule.thresholdBps) throw new ApprovalBelowThresholdError();

  const pending = await tx.query<{ id: string }>(
    `SELECT id FROM quote_approval
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid
        AND quote_id = $3::uuid AND status = 'pending'`,
    [tx.session.tenantId, quote.programmeId, quoteId],
  );
  if (pending.length > 0) throw new ApprovalAlreadyPendingError();

  const id = newId();
  await tx.query(
    `INSERT INTO quote_approval
       (id, tenant_id, programme_id, quote_id, requested_by_user_id, discount_bps, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 'pending')`,
    [id, tx.session.tenantId, quote.programmeId, quoteId, tx.session.userId, discountBps],
  );

  const event = quoteApprovalRequestedEvent(id, quoteId);
  await appendOutboxEvent(tx, {
    id: newId(),
    eventType: event.eventType,
    programmeId: quote.programmeId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: event.payload,
  });

  const created = await findApprovalById(tx, id);
  if (created === null) throw new ApprovalProgrammeOutOfScopeError();
  return created;
}

export async function decideApproval(
  tx: TenantTx,
  approvalId: string,
  input: DecideApprovalInput,
): Promise<QuoteApproval | null> {
  const current = await findApprovalById(tx, approvalId);
  if (current === null) return null;
  if (current.status !== 'pending') throw new ApprovalNotPendingError();

  await tx.query(
    `UPDATE quote_approval
        SET status = $3,
            decided_by_user_id = $4::uuid,
            decided_at = now(),
            updated_at = now()
      WHERE tenant_id = $1::uuid AND programme_id = $2::uuid AND id = $5::uuid`,
    [tx.session.tenantId, current.programmeId, input.decision, tx.session.userId, approvalId],
  );

  return findApprovalById(tx, approvalId);
}
