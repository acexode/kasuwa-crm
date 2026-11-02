import type { HttpException } from '@nestjs/common';
import type { TenantTx } from '@kasuwa/db';
import type * as DomainCore from '@kasuwa/domain-core';
import type * as Permissions from '@kasuwa/permissions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setMobilePaymentStatusFor } from './mobile-payment.service';

const PROGRAMME = '11111111-0000-4000-8000-0000000c0001';
const PAYMENT = '11111111-0000-4000-8000-0000001e0001';

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  setStatus: vi.fn(),
  audit: vi.fn(),
  allowed: vi.fn<(action: string, programmeId: string) => boolean>(),
}));

vi.mock('@kasuwa/domain-core', async (importOriginal) => ({
  ...(await importOriginal<typeof DomainCore>()),
  findMobilePaymentById: mocks.find,
  setMobilePaymentStatus: mocks.setStatus,
  recordAuditEvent: mocks.audit,
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

const pending = {
  id: PAYMENT,
  programmeId: PROGRAMME,
  providerKind: 'mpesa' as const,
  status: 'pending' as const,
  amountMinor: '5000',
  currency: 'KES' as const,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return (error as HttpException).getResponse();
  }
}

describe('setMobilePaymentStatusFor', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.allowed.mockReturnValue(true);
    mocks.find.mockResolvedValue(pending);
  });

  it('refuses paid from a caller who can write invoices, and does not update the row', async () => {
    const result = await outcome(() =>
      setMobilePaymentStatusFor(tx, { paymentId: PAYMENT }, { status: 'paid' }),
    );
    expect(result).toMatchObject({ code: 'validation_failed' });
    expect(mocks.setStatus).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(pending.status).toBe('pending');
  });
});
