import type { HttpException } from '@nestjs/common';
import type { TenantTx } from '@kasuwa/db';
import type * as DomainCore from '@kasuwa/domain-core';
import type * as Permissions from '@kasuwa/permissions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decideApprovalFor, requestApprovalFor } from './approvals.service';

const PROGRAMME = '11111111-0000-4000-8000-0000000c0001';
const QUOTE = '11111111-0000-4000-8000-0000001d0001';
const APPROVAL = '11111111-0000-4000-8000-0000001f0002';

const mocks = vi.hoisted(() => ({
  findQuote: vi.fn(),
  findApproval: vi.fn(),
  request: vi.fn(),
  decide: vi.fn(),
  allowed: vi.fn<(action: string, programmeId: string) => boolean>(),
}));

vi.mock('@kasuwa/domain-core', async (importOriginal) => ({
  ...(await importOriginal<typeof DomainCore>()),
  findQuoteById: mocks.findQuote,
  findApprovalById: mocks.findApproval,
  requestApproval: mocks.request,
  decideApproval: mocks.decide,
}));

vi.mock('@kasuwa/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof Permissions>()),
  loadGrants: () => Promise.resolve({}),
  canProgramme: (_grants: unknown, action: string, programmeId: string) =>
    mocks.allowed(action, programmeId),
}));

const tx = {
  session: {
    tenantId: '11111111-0000-4000-8000-000000000001',
    userId: 'u',
    programmeIds: [PROGRAMME],
  },
} as unknown as TenantTx;

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return (error as HttpException).getResponse();
  }
}

const quote = {
  id: QUOTE,
  programmeId: PROGRAMME,
  dealId: null,
  contactId: null,
  currency: 'NGN' as const,
  status: 'draft' as const,
  discountBps: 2000,
  validUntil: null,
  version: 1,
  lines: [],
  subtotalMinor: '100',
  discountMinor: '0',
  totalMinor: '100',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const approval = {
  id: APPROVAL,
  programmeId: PROGRAMME,
  quoteId: QUOTE,
  requestedByUserId: 'u',
  discountBps: 2000,
  status: 'pending' as const,
  decidedByUserId: null,
  decidedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('discount approvals need the right action (T-0166)', () => {
  beforeEach(() => {
    mocks.findQuote.mockReset();
    mocks.findApproval.mockReset();
    mocks.request.mockReset();
    mocks.decide.mockReset();
    mocks.allowed.mockReset();
  });

  it('request answers 404 before 403 when the quote is missing', async () => {
    mocks.findQuote.mockResolvedValue(null);
    mocks.allowed.mockReturnValue(false);
    expect(await outcome(() => requestApprovalFor(tx, { quoteId: QUOTE }))).toMatchObject({
      error: { code: 'not_found' },
    });
    expect(mocks.allowed).not.toHaveBeenCalled();
  });

  it('request refuses without quotes.write', async () => {
    mocks.findQuote.mockResolvedValue(quote);
    mocks.allowed.mockReturnValue(false);
    expect(await outcome(() => requestApprovalFor(tx, { quoteId: QUOTE }))).toMatchObject({
      error: { code: 'not_permitted' },
    });
    expect(mocks.allowed).toHaveBeenCalledWith('quotes.write', PROGRAMME);
  });

  it('decide answers 404 before 403 when the approval is missing', async () => {
    mocks.findApproval.mockResolvedValue(null);
    mocks.allowed.mockReturnValue(false);
    expect(
      await outcome(() => decideApprovalFor(tx, { approvalId: APPROVAL }, { decision: 'approved' })),
    ).toMatchObject({ error: { code: 'not_found' } });
    expect(mocks.allowed).not.toHaveBeenCalled();
  });

  it('decide refuses without quotes.approve', async () => {
    mocks.findApproval.mockResolvedValue(approval);
    mocks.allowed.mockReturnValue(false);
    expect(
      await outcome(() => decideApprovalFor(tx, { approvalId: APPROVAL }, { decision: 'approved' })),
    ).toMatchObject({ error: { code: 'not_permitted' } });
    expect(mocks.allowed).toHaveBeenCalledWith('quotes.approve', PROGRAMME);
  });
});
