import { z } from 'zod';

export const APPROVER_PERMISSION_SET_KEYS = [
  'admin',
  'team_lead',
  'programme_manager',
] as const;
export type ApproverPermissionSetKey = (typeof APPROVER_PERMISSION_SET_KEYS)[number];
export const ApproverPermissionSetKeySchema = z.enum(APPROVER_PERMISSION_SET_KEYS);

export const QUOTE_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type QuoteApprovalStatus = (typeof QUOTE_APPROVAL_STATUSES)[number];
export const QuoteApprovalStatusSchema = z.enum(QUOTE_APPROVAL_STATUSES);

export const QUOTE_APPROVAL_DECISIONS = ['approved', 'rejected'] as const;
export type QuoteApprovalDecision = (typeof QUOTE_APPROVAL_DECISIONS)[number];
export const QuoteApprovalDecisionSchema = z.enum(QUOTE_APPROVAL_DECISIONS);

export const DecideApprovalInputSchema = z.strictObject({
  decision: QuoteApprovalDecisionSchema,
});
export type DecideApprovalInput = z.infer<typeof DecideApprovalInputSchema>;

export interface ApprovalRule {
  id: string;
  programmeId: string;
  thresholdBps: number;
  approverPermissionSetKey: ApproverPermissionSetKey;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuoteApproval {
  id: string;
  programmeId: string;
  quoteId: string;
  requestedByUserId: string;
  discountBps: number;
  status: QuoteApprovalStatus;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Effective discount for the threshold check: the greater of quote-level and
 * any line-level `discountBps` (founding pack AC2: discounts above threshold).
 */
export function effectiveDiscountBps(
  quoteDiscountBps: number,
  lines: readonly { discountBps: number }[],
): number {
  let max = quoteDiscountBps;
  for (const line of lines) {
    if (line.discountBps > max) max = line.discountBps;
  }
  return max;
}

/**
 * Typed domain event for a requested approval (T-0166).
 *
 * `appendOutboxEvent` is complete and this payload is registered as
 * `quote.approval_requested`. In-app notification delivery is not wired yet
 * (notification kinds / object types are closed in migration 0044); the
 * notifications consumer skips unknown types on its queue until a later slice
 * expands them. Do not invent a substitute bus.
 */
export interface QuoteApprovalRequestedEvent {
  readonly eventType: 'quote.approval_requested';
  readonly aggregateType: 'quote_approval';
  readonly aggregateId: string;
  readonly payload: {
    readonly approvalId: string;
    readonly quoteId: string;
  };
}

export function quoteApprovalRequestedEvent(
  approvalId: string,
  quoteId: string,
): QuoteApprovalRequestedEvent {
  return {
    eventType: 'quote.approval_requested',
    aggregateType: 'quote_approval',
    aggregateId: approvalId,
    payload: { approvalId, quoteId },
  };
}
