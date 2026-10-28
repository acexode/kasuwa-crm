import { ProviderRejectedError, ProviderUnavailableError } from '@kasuwa/channel-adapter';
import type { TenantTx } from '@kasuwa/db';
import type * as DomainCore from '@kasuwa/domain-core';
import type * as Permissions from '@kasuwa/permissions';
import type { HttpException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderQuotePdfFor, sendQuoteFor } from './quote-send.service';

const PROGRAMME = '11111111-0000-4000-8000-0000000c0001';
const QUOTE = '11111111-0000-4000-8000-0000001d0001';
const ADDRESS = 'unit.quote-send@client.example';

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  record: vi.fn(),
  render: vi.fn(),
  allowed: vi.fn<(action: string, programmeId: string) => boolean>(),
  send: vi.fn(),
}));

vi.mock('@kasuwa/domain-core', async (importOriginal) => ({
  ...(await importOriginal<typeof DomainCore>()),
  findQuoteById: mocks.find,
  recordQuoteSend: mocks.record,
  renderQuotePdf: mocks.render,
  isQuoteSendable: (status: string) => status === 'draft' || status === 'sent',
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
  lines: [],
  subtotalMinor: '100',
  discountMinor: '0',
  totalMinor: '100',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return (error as HttpException).getResponse();
  }
}

describe('quote send / PDF (T-0167)', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.allowed.mockReturnValue(true);
    mocks.find.mockResolvedValue(draft);
    mocks.render.mockReturnValue(Buffer.from('%PDF-1.4'));
    mocks.send.mockResolvedValue({ messageId: 'fake-1', state: 'queued' });
    mocks.record.mockResolvedValue({
      id: 's1',
      programmeId: PROGRAMME,
      quoteId: QUOTE,
      channel: 'email',
      status: 'sent',
      toMasked: 'u•••d@client.example',
      providerMessageId: 'fake-1',
      quoteVersion: 1,
      sentByUserId: 'u',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('renderQuotePdfFor: 404 when the quote is out of scope', async () => {
    mocks.find.mockResolvedValue(null);
    expect(await outcome(() => renderQuotePdfFor(tx, { quoteId: QUOTE }))).toMatchObject({
      code: 'not_found',
    });
  });

  it('renderQuotePdfFor: returns the buffer for an in-scope quote', async () => {
    const pdf = await renderQuotePdfFor(tx, { quoteId: QUOTE });
    expect(pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    expect(mocks.render).toHaveBeenCalledWith(draft);
  });

  it('sendQuoteFor: 403 without quotes.write, and nothing is sent', async () => {
    mocks.allowed.mockReturnValue(false);
    expect(
      await outcome(() =>
        sendQuoteFor(tx, { send: mocks.send } as never, { quoteId: QUOTE }, {
          channel: 'email',
          to: ADDRESS,
        }),
      ),
    ).toMatchObject({ code: 'not_permitted' });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('sendQuoteFor: 404 before permission when the quote is missing', async () => {
    mocks.find.mockResolvedValue(null);
    expect(
      await outcome(() =>
        sendQuoteFor(tx, { send: mocks.send } as never, { quoteId: QUOTE }, {
          channel: 'email',
          to: ADDRESS,
        }),
      ),
    ).toMatchObject({ code: 'not_found' });
    expect(mocks.allowed).not.toHaveBeenCalled();
  });

  it('sendQuoteFor: 503 and no record when the channel fails closed', async () => {
    mocks.send.mockRejectedValue(new ProviderUnavailableError());
    expect(
      await outcome(() =>
        sendQuoteFor(tx, { send: mocks.send } as never, { quoteId: QUOTE }, {
          channel: 'email',
          to: ADDRESS,
        }),
      ),
    ).toMatchObject({ code: 'service_unavailable' });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('sendQuoteFor: maps any ChannelError to 503', async () => {
    class Other extends ChannelError {
      readonly code = 'provider_rejected' as const;
      readonly retryable = false;
      constructor() {
        super('probe');
      }
    }
    mocks.send.mockRejectedValue(new Other());
    expect(
      await outcome(() =>
        sendQuoteFor(tx, { send: mocks.send } as never, { quoteId: QUOTE }, {
          channel: 'email',
          to: ADDRESS,
        }),
      ),
    ).toMatchObject({ code: 'service_unavailable' });
  });

  it('sendQuoteFor: refuses whatsapp (and any non-email) at the body boundary', async () => {
    expect(
      await outcome(() =>
        sendQuoteFor(tx, { send: mocks.send } as never, { quoteId: QUOTE }, {
          channel: 'whatsapp',
          to: ADDRESS,
        }),
      ),
    ).toMatchObject({ code: 'validation_failed' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('sendQuoteFor: 409 not_sendable for a terminal status', async () => {
    mocks.find.mockResolvedValue({ ...draft, status: 'accepted' });
    expect(
      await outcome(() =>
        sendQuoteFor(tx, { send: mocks.send } as never, { quoteId: QUOTE }, {
          channel: 'email',
          to: ADDRESS,
        }),
      ),
    ).toMatchObject({ code: 'not_sendable' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('sendQuoteFor: records after a successful email send', async () => {
    const wire = await sendQuoteFor(
      tx,
      { send: mocks.send } as never,
      { quoteId: QUOTE },
      { channel: 'email', to: ADDRESS },
    );
    expect(wire).toMatchObject({
      quoteId: QUOTE,
      channel: 'email',
      status: 'sent',
      providerMessageId: 'fake-1',
    });
    expect(wire).not.toHaveProperty('to');
    expect(JSON.stringify(wire)).not.toContain(ADDRESS);
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'email',
        to: ADDRESS,
        purpose: 'transactional',
        scope: { tenantId: tx.session.tenantId, programmeId: PROGRAMME },
      }),
    );
  });
});
