import { describe, expect, it } from 'vitest';
import {
  effectiveDiscountBps,
  quoteApprovalRequestedEvent,
} from './approvals.types';

describe('effectiveDiscountBps', () => {
  it('takes the greater of quote and line discounts', () => {
    expect(effectiveDiscountBps(500, [{ discountBps: 100 }, { discountBps: 2000 }])).toBe(2000);
    expect(effectiveDiscountBps(1800, [{ discountBps: 100 }])).toBe(1800);
    expect(effectiveDiscountBps(0, [])).toBe(0);
  });
});

describe('quoteApprovalRequestedEvent', () => {
  it('is ids-only and typed', () => {
    const event = quoteApprovalRequestedEvent(
      '11111111-0000-4000-8000-0000001f0002',
      '11111111-0000-4000-8000-0000001d0001',
    );
    expect(event.eventType).toBe('quote.approval_requested');
    expect(event.aggregateType).toBe('quote_approval');
    expect(event.payload).toEqual({
      approvalId: '11111111-0000-4000-8000-0000001f0002',
      quoteId: '11111111-0000-4000-8000-0000001d0001',
    });
  });
});
