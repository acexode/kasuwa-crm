import { describe, expect, it } from 'vitest';
import { createChannelAdapter } from './adapter';
import type { SendRequest } from './contracts';
import { defaultChannelProvider, NullChannelProvider } from './default-provider';
import { MessageNotFoundError, ProviderUnavailableError } from './errors';
import { FakeChannelProvider, FakeDndRegister } from './fake';

// Invented values only (CLAUDE.md section 6).
const REQUEST: SendRequest = {
  scope: {
    tenantId: '11111111-0000-4000-8000-000000000001',
    programmeId: '11111111-0000-4000-8000-0000000c0001',
  },
  channel: 'email',
  to: 'unit.null-probe@client.example',
  body: 'Accept: /portal?token=UNIT-NULL-PROBE',
  purpose: 'transactional',
};

describe('NullChannelProvider (D-L52)', () => {
  it('refuses every send as unavailable, so nothing is reported as sent', async () => {
    await expect(new NullChannelProvider().send(REQUEST)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it('surfaces through the adapter as a retryable ProviderUnavailableError', async () => {
    const channel = createChannelAdapter({
      provider: new NullChannelProvider(),
      dnd: new FakeDndRegister([]),
    });
    const error = await channel.send(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect((error as ProviderUnavailableError).retryable).toBe(true);
  });

  it('knows no message, and keeps nothing it was given', async () => {
    const provider = new NullChannelProvider();
    await provider.send(REQUEST).catch(() => undefined);
    await expect(provider.getDeliveryStatus(REQUEST.scope, 'any')).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
    expect(JSON.stringify(provider)).not.toContain('null-probe');
  });
});

describe('defaultChannelProvider (D-L52)', () => {
  it('is the null provider in production', () => {
    expect(defaultChannelProvider('production')).toBeInstanceOf(NullChannelProvider);
  });

  it('is the in-memory fake in development and test', () => {
    expect(defaultChannelProvider('development')).toBeInstanceOf(FakeChannelProvider);
    expect(defaultChannelProvider('test')).toBeInstanceOf(FakeChannelProvider);
  });

  it('returns a fresh provider each time, so two apps never share sent messages', () => {
    expect(defaultChannelProvider('test')).not.toBe(defaultChannelProvider('test'));
  });
});
