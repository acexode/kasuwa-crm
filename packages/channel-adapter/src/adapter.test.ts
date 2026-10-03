import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { ChannelLogger, ChannelProvider, SendRequest } from './contracts';
import { createChannelAdapter } from './adapter';
import {
  ChannelError,
  DndRefusedError,
  InvalidSendRequestError,
  MessageNotFoundError,
  ProviderRejectedError,
  ProviderUnavailableError,
} from './errors';
import { FAKE_SENT_LIMIT, FakeChannelProvider, FakeDndRegister } from './fake';

// Invented identifiers only (CLAUDE.md section 6).
const SCOPE = {
  tenantId: '11111111-0000-4000-8000-000000000001',
  programmeId: '11111111-0000-4000-8000-0000000c0001',
};
const OTHER_PROGRAMME = { ...SCOPE, programmeId: '11111111-0000-4000-8000-0000000c0002' };
const OTHER_TENANT = '22222222-0000-4000-8000-000000000002';
const TO = '+2348090000999';
const BODY = 'Your code is UNIT-PROBE-77.';

function request(overrides: Partial<SendRequest> = {}): SendRequest {
  return {
    scope: SCOPE,
    channel: 'sms',
    to: TO,
    body: BODY,
    purpose: 'transactional',
    ...overrides,
  };
}

function recordingLogger(): ChannelLogger & { entries: unknown[] } {
  const entries: unknown[] = [];
  const at = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    entries.push({ level, message, fields });
  };
  return { entries, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** A provider that ignores scope entirely, as a careless real one might. */
function stubProvider(): ChannelProvider {
  let count = 0;
  return {
    send: async () => ({ messageId: `stub-${(count += 1)}`, state: 'queued' }),
    getDeliveryStatus: async (_scope, messageId) => ({
      messageId,
      state: 'delivered',
      updatedAt: new Date(),
    }),
  };
}

function throwingProvider(thrown: unknown): ChannelProvider {
  return {
    send: async () => {
      throw thrown;
    },
    getDeliveryStatus: async () => {
      throw thrown;
    },
  };
}

describe('createChannelAdapter', () => {
  it('passes the parsed request to the provider, not the caller object', async () => {
    const provider = new FakeChannelProvider();
    const channel = createChannelAdapter({ provider, dnd: new FakeDndRegister([]) });
    await channel.send({ ...request(), extra: 'dropped' } as SendRequest);
    expect(provider.sent).toEqual([request()]);
  });

  it('rejects malformed destinations and names only the failing field', async () => {
    const channel = createChannelAdapter({
      provider: new FakeChannelProvider(),
      dnd: new FakeDndRegister([]),
    });
    for (const to of ['2348090000999', '+0348090000999', '+234 809 000 0999', '+1234']) {
      const error = await channel.send(request({ to })).catch((e: unknown) => e);
      expect(error, to).toBeInstanceOf(InvalidSendRequestError);
      expect((error as InvalidSendRequestError).fields).toEqual(['to']);
      expect(inspect(error, { showHidden: true }), to).not.toContain(to);
    }
  });

  it('rejects an empty body and a non-uuid scope', async () => {
    const channel = createChannelAdapter({
      provider: new FakeChannelProvider(),
      dnd: new FakeDndRegister([]),
    });
    await expect(channel.send(request({ body: '' }))).rejects.toBeInstanceOf(
      InvalidSendRequestError,
    );
    await expect(
      channel.send(request({ scope: { tenantId: 'a', programmeId: 'b' } })),
    ).rejects.toBeInstanceOf(InvalidSendRequestError);
  });

  it('does not consult the DND register for transactional sends', async () => {
    let lookups = 0;
    const channel = createChannelAdapter({
      provider: new FakeChannelProvider(),
      dnd: { isRegistered: async () => (lookups += 1) > 0 },
    });
    await channel.send(request());
    expect(lookups).toBe(0);
  });

  it('fails closed when the DND lookup itself fails', async () => {
    const provider = new FakeChannelProvider();
    const channel = createChannelAdapter({
      provider,
      dnd: {
        isRegistered: async () => {
          throw new Error(`lookup failed for ${TO}`);
        },
      },
    });
    const error = await channel.send(request({ purpose: 'promotional' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(inspect(error, { showHidden: true })).not.toContain(TO);
    expect(provider.sent).toHaveLength(0);
  });

  it('rebuilds typed provider errors so nothing the provider attached survives', async () => {
    const leaky = Object.assign(new ProviderUnavailableError(), {
      request: { to: TO, body: BODY },
    });
    const logger = recordingLogger();
    const channel = createChannelAdapter({
      provider: throwingProvider(leaky),
      dnd: new FakeDndRegister([]),
      logger,
    });
    const error = await channel.send(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error).not.toBe(leaky);
    const text = inspect({ error, logs: logger.entries }, { depth: 10, showHidden: true });
    expect(text).not.toContain(TO);
    expect(text).not.toContain('UNIT-PROBE-77');
    expect(text).toContain('provider_unavailable');
  });

  it('treats an unclassified send failure as permanent, and a status failure as transient', async () => {
    const channel = createChannelAdapter({
      provider: throwingProvider(new Error('socket hang up')),
      dnd: new FakeDndRegister([]),
    });
    await expect(channel.send(request())).rejects.toBeInstanceOf(ProviderRejectedError);
    await expect(channel.send(request())).rejects.not.toHaveProperty('cause');

    const statusFails = createChannelAdapter({
      provider: {
        ...stubProvider(),
        getDeliveryStatus: throwingProvider(new Error('x')).getDeliveryStatus,
      },
      dnd: new FakeDndRegister([]),
    });
    const { messageId } = await statusFails.send(request());
    await expect(statusFails.getDeliveryStatus(SCOPE, messageId)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it.each([undefined, null, 'no', 0, true])(
    'fails closed when the DND register answers %s instead of false',
    async (answer) => {
      const provider = new FakeChannelProvider();
      const channel = createChannelAdapter({
        provider,
        dnd: { isRegistered: async () => answer as boolean },
      });
      await expect(channel.send(request({ purpose: 'promotional' }))).rejects.toBeInstanceOf(
        DndRefusedError,
      );
      expect(provider.sent).toHaveLength(0);
    },
  );

  it('enforces delivery-status scope even when the provider ignores it', async () => {
    const channel = createChannelAdapter({
      provider: stubProvider(),
      dnd: new FakeDndRegister([]),
    });
    const { messageId } = await channel.send(request());
    await expect(channel.getDeliveryStatus(SCOPE, messageId)).resolves.toMatchObject({ messageId });
    for (const scope of [OTHER_PROGRAMME, { ...SCOPE, tenantId: OTHER_TENANT }]) {
      await expect(channel.getDeliveryStatus(scope, messageId)).rejects.toBeInstanceOf(
        MessageNotFoundError,
      );
    }
    await expect(channel.getDeliveryStatus(SCOPE, 'never-sent')).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
  });

  it('turns malformed provider output into typed errors', async () => {
    const badSend = createChannelAdapter({
      provider: {
        ...stubProvider(),
        send: async () => ({ messageId: '', state: 'lost' }) as never,
      },
      dnd: new FakeDndRegister([]),
    });
    await expect(badSend.send(request())).rejects.toBeInstanceOf(ProviderRejectedError);

    for (const status of [
      { messageId: 'wrong-id', state: 'sent', updatedAt: new Date() },
      { messageId: 'stub-1', state: 'sent', updatedAt: 'yesterday' },
      { messageId: 'stub-1', state: 'teleported', updatedAt: new Date() },
    ]) {
      const badStatus = createChannelAdapter({
        provider: { ...stubProvider(), getDeliveryStatus: async () => status as never },
        dnd: new FakeDndRegister([]),
      });
      const { messageId } = await badStatus.send(request());
      await expect(badStatus.getDeliveryStatus(SCOPE, messageId)).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
    }
  });

  it('survives a logger that throws', async () => {
    const boom = () => {
      throw new Error('logger down');
    };
    const channel = createChannelAdapter({
      provider: new FakeChannelProvider(),
      dnd: new FakeDndRegister([]),
      logger: { debug: boom, info: boom, warn: boom, error: boom },
    });
    await expect(channel.send(request())).resolves.toHaveProperty('state', 'queued');
  });

  it('logs a DND refusal at warn, by code', async () => {
    const logger = recordingLogger();
    const channel = createChannelAdapter({
      provider: new FakeChannelProvider(),
      dnd: new FakeDndRegister([TO]),
      logger,
    });
    await expect(channel.send(request({ purpose: 'promotional' }))).rejects.toBeInstanceOf(
      DndRefusedError,
    );
    expect(logger.entries).toEqual([
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({ code: 'dnd_refused' }),
      }),
    ]);
  });
});

describe('FakeChannelProvider', () => {
  it('scopes delivery status to tenant and programme', async () => {
    const provider = new FakeChannelProvider();
    const { messageId } = await provider.send(request());
    await expect(provider.getDeliveryStatus(SCOPE, messageId)).resolves.toMatchObject({
      state: 'queued',
    });
    await expect(provider.getDeliveryStatus(OTHER_PROGRAMME, messageId)).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
  });

  it('refuses a delivery state for an unknown message', () => {
    expect(() => new FakeChannelProvider().setDeliveryState('nope', 'sent')).toThrow(
      MessageNotFoundError,
    );
  });

  it('keeps only the most recent FAKE_SENT_LIMIT accepted requests', async () => {
    const provider = new FakeChannelProvider();
    for (let i = 0; i < FAKE_SENT_LIMIT + 5; i += 1) await provider.send(request());
    expect(provider.sent).toHaveLength(FAKE_SENT_LIMIT);
  });

  it('does not record a failed send, and fails only once', async () => {
    const provider = new FakeChannelProvider();
    provider.failNextSend('rejected');
    await expect(provider.send(request())).rejects.toBeInstanceOf(ProviderRejectedError);
    await provider.send(request());
    expect(provider.sent).toHaveLength(1);
  });
});

describe('errors', () => {
  it('carry fixed codes and retry answers', () => {
    const cases: [ChannelError, string, boolean][] = [
      [new DndRefusedError(), 'dnd_refused', false],
      [new InvalidSendRequestError(), 'invalid_request', false],
      [new ProviderUnavailableError(), 'provider_unavailable', true],
      [new ProviderRejectedError(), 'provider_rejected', false],
      [new MessageNotFoundError(), 'message_not_found', false],
    ];
    for (const [error, code, retryable] of cases) {
      expect(error).toBeInstanceOf(ChannelError);
      expect([error.code, error.retryable, error.name]).toEqual([
        code,
        retryable,
        error.constructor.name,
      ]);
    }
  });
});
