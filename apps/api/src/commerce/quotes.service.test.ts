import type { HttpException } from '@nestjs/common';
import type { TenantTx } from '@kasuwa/db';
import type * as DomainCore from '@kasuwa/domain-core';
import type * as Permissions from '@kasuwa/permissions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuoteFor, setQuoteStatusFor, updateQuoteFor } from './quotes.service';

const PROGRAMME = '11111111-0000-4000-8000-0000000c0001';
const OTHER = '11111111-0000-4000-8000-0000000c0002';
const QUOTE = '11111111-0000-4000-8000-0000001d0001';
const PRODUCT = '11111111-0000-4000-8000-0000001a0001';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  setStatus: vi.fn(),
  find: vi.fn(),
  allowed: vi.fn<(action: string, programmeId: string) => boolean>(),
}));

vi.mock('@kasuwa/domain-core', async (importOriginal) => ({
  ...(await importOriginal<typeof DomainCore>()),
  createQuote: mocks.create,
  updateQuote: mocks.update,
  setQuoteStatus: mocks.setStatus,
  findQuoteById: mocks.find,
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

const draft = {
  id: QUOTE,
  programmeId: PROGRAMME,
  dealId: null,
  contactId: null,
  currency: 'NGN' as const,
  status: 'draft' as const,
  discountBps: 0,
  validUntil: null,
  version: 1,
  lines: [
    {
      id: 'l1',
      productId: PRODUCT,
      variantId: null,
      quantity: 1,
      unitAmountMinor: '100',
      discountBps: 0,
      sortOrder: 0,
    },
  ],
  subtotalMinor: '100',
  discountMinor: '0',
  totalMinor: '100',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('quotes writes need quotes.write (T-0165)', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.allowed.mockReturnValue(false);
  });

  it('create: 403 without the action, and nothing is written', async () => {
    const result = await outcome(() =>
      createQuoteFor(tx, { programmeId: PROGRAMME }, {
        currency: 'NGN',
        lines: [{ productId: PRODUCT, quantity: 1, unitAmountMinor: '100' }],
      }),
    );
    expect(result).toMatchObject({ code: 'not_permitted' });
    expect(mocks.allowed).toHaveBeenCalledWith('quotes.write', PROGRAMME);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('create: a programme outside the session is 404 before the permission check', async () => {
    const result = await outcome(() =>
      createQuoteFor(tx, { programmeId: OTHER }, {
        currency: 'NGN',
        lines: [{ productId: PRODUCT, quantity: 1, unitAmountMinor: '100' }],
      }),
    );
    expect(result).toMatchObject({ code: 'not_found' });
    expect(mocks.allowed).not.toHaveBeenCalled();
  });

  it('update: 409 not_editable when the domain refuses', async () => {
    mocks.find.mockResolvedValue(draft);
    mocks.allowed.mockReturnValue(true);
    const { QuoteNotEditableError } = await import('@kasuwa/domain-core');
    mocks.update.mockRejectedValue(new QuoteNotEditableError());
    expect(
      await outcome(() => updateQuoteFor(tx, { quoteId: QUOTE }, { discountBps: 100 })),
    ).toMatchObject({ code: 'not_editable' });
  });

  it('status: 400 invalid_transition when the domain refuses', async () => {
    mocks.find.mockResolvedValue(draft);
    mocks.allowed.mockReturnValue(true);
    const { QuoteInvalidTransitionError } = await import('@kasuwa/domain-core');
    mocks.setStatus.mockRejectedValue(new QuoteInvalidTransitionError());
    expect(
      await outcome(() => setQuoteStatusFor(tx, { quoteId: QUOTE }, { status: 'accepted' })),
    ).toMatchObject({ code: 'invalid_transition' });
  });
});
