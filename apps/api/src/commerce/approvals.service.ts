import type { TenantTx } from '@kasuwa/db';
import {
  ApprovalAlreadyPendingError,
  ApprovalBelowThresholdError,
  ApprovalNoRuleError,
  ApprovalNotPendingError,
  ApprovalProgrammeOutOfScopeError,
  ApprovalQuoteNotDraftError,
  decideApproval,
  findApprovalById,
  findQuoteById,
  listApprovals,
  requestApproval,
  type QuoteApproval,
} from '@kasuwa/domain-core';
import { canProgramme, loadGrants } from '@kasuwa/permissions';
import { HttpStatus } from '@nestjs/common';
import {
  AdminError,
  notFound,
  notPermitted,
  validationFailedFrom,
} from '../admin/common/admin-errors';
import {
  ApprovalIdParam,
  DecideApprovalBody,
  ProgrammeIdParam,
  QuoteIdParam,
} from './commerce.schemas';

export interface QuoteApprovalWire {
  id: string;
  programmeId: string;
  quoteId: string;
  requestedByUserId: string;
  discountBps: number;
  status: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toWire(row: QuoteApproval): QuoteApprovalWire {
  return {
    id: row.id,
    programmeId: row.programmeId,
    quoteId: row.quoteId,
    requestedByUserId: row.requestedByUserId,
    discountBps: row.discountBps,
    status: row.status,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function programmeFromPath(tx: TenantTx, params: unknown): string {
  const { programmeId } = ProgrammeIdParam.parse(params);
  if (!tx.session.programmeIds.includes(programmeId)) throw notFound();
  return programmeId;
}

function mapApprovalError(error: unknown): never {
  if (error instanceof ApprovalProgrammeOutOfScopeError) throw notFound();
  if (error instanceof ApprovalBelowThresholdError) {
    throw new AdminError(
      HttpStatus.BAD_REQUEST,
      'below_threshold',
      'The quote discount is not above the programme approval threshold.',
    );
  }
  if (error instanceof ApprovalNoRuleError) {
    throw new AdminError(
      HttpStatus.BAD_REQUEST,
      'no_approval_rule',
      'This programme has no discount approval rule.',
    );
  }
  if (error instanceof ApprovalAlreadyPendingError) {
    throw new AdminError(
      HttpStatus.CONFLICT,
      'already_pending',
      'This quote already has a pending approval.',
    );
  }
  if (error instanceof ApprovalNotPendingError) {
    throw new AdminError(
      HttpStatus.CONFLICT,
      'not_pending',
      'Only a pending approval can be decided.',
    );
  }
  if (error instanceof ApprovalQuoteNotDraftError) {
    throw new AdminError(
      HttpStatus.CONFLICT,
      'not_draft',
      'Only a draft quote can request discount approval.',
    );
  }
  throw error;
}

export async function listApprovalsFor(
  tx: TenantTx,
  params: unknown,
): Promise<{ data: QuoteApprovalWire[] }> {
  const programmeId = programmeFromPath(tx, params);
  try {
    const data = await listApprovals(tx, programmeId);
    return { data: data.map(toWire) };
  } catch (error) {
    mapApprovalError(error);
  }
}

export async function requestApprovalFor(
  tx: TenantTx,
  params: unknown,
): Promise<QuoteApprovalWire> {
  const { quoteId } = QuoteIdParam.parse(params);
  const quote = await findQuoteById(tx, quoteId);
  if (quote === null) throw notFound();
  if (!canProgramme(await loadGrants(tx), 'quotes.write', quote.programmeId)) {
    throw notPermitted();
  }
  try {
    const created = await requestApproval(tx, quoteId);
    if (created === null) throw notFound();
    return toWire(created);
  } catch (error) {
    mapApprovalError(error);
  }
}

export async function decideApprovalFor(
  tx: TenantTx,
  params: unknown,
  body: unknown,
): Promise<QuoteApprovalWire> {
  const { approvalId } = ApprovalIdParam.parse(params);
  const current = await findApprovalById(tx, approvalId);
  if (current === null) throw notFound();
  if (!canProgramme(await loadGrants(tx), 'quotes.approve', current.programmeId)) {
    throw notPermitted();
  }
  const parsed = DecideApprovalBody.safeParse(body);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  try {
    const updated = await decideApproval(tx, approvalId, parsed.data);
    if (updated === null) throw notFound();
    return toWire(updated);
  } catch (error) {
    mapApprovalError(error);
  }
}
