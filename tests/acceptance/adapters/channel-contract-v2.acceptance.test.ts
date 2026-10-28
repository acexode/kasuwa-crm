import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createChannelAdapter,
  FakeChannelProvider,
  FakeDndRegister,
  NullChannelProvider,
  type SendRequest,
} from '@kasuwa/channel-adapter';
import { describe, expect, it } from 'vitest';

/**
 * ACCEPTANCE — T-0186 ChannelProvider v2.
 *
 * R1. `send` requires `idempotencyKey` (D-L37); missing key is invalid.
 * R2. `capabilities()` reports channels / templates / webhooks.
 * R3. Fake honours idempotency (same key → same messageId).
 * R4. Null provider stays fail-closed on send / templates / parseWebhook.
 * R5. Vendor names stay inside packages/channel-adapter (boundary).
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const SCOPE = {
  tenantId: '11111111-0000-4000-8000-000000000001',
  programmeId: '11111111-0000-4000-8000-0000000c0001',
};

function baseSend(overrides: Partial<SendRequest> = {}): SendRequest {
  return {
    scope: SCOPE,
    channel: 'sms',
    to: '+2348090000999',
    body: 'Acceptance probe OTP UNIT-0186',
    purpose: 'transactional',
    idempotencyKey: 'idem-accept-0186-0001',
    ...overrides,
  };
}

describe('T-0186 ChannelProvider v2', () => {
  it('R1: send without idempotencyKey is invalid', async () => {
    const channel = createChannelAdapter({
      provider: new FakeChannelProvider(),
      dnd: new FakeDndRegister([]),
    });
    const { idempotencyKey: _drop, ...without } = baseSend();
    await expect(channel.send(without as SendRequest)).rejects.toMatchObject({
      code: 'invalid_send_request',
    });
  });

  it('R2/R3: capabilities and idempotent fake send', async () => {
    const provider = new FakeChannelProvider();
    const channel = createChannelAdapter({ provider, dnd: new FakeDndRegister([]) });
    expect(channel.capabilities()).toEqual({
      channels: ['sms', 'whatsapp', 'email'],
      templates: true,
      webhooks: true,
    });
    const first = await channel.send(baseSend());
    const second = await channel.send(baseSend());
    expect(second.messageId).toBe(first.messageId);
    expect(provider.sent).toHaveLength(1);
  });

  it('R4: NullChannelProvider fails closed', async () => {
    const provider = new NullChannelProvider();
    await expect(provider.send(baseSend())).rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(provider.templates(SCOPE)).rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(provider.parseWebhook('{}')).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  });

  it('R5: provider vendor strings stay inside the adapter package', () => {
    const root = join(repoRoot, 'packages', 'channel-adapter', 'src');
    const files = readdirSync(root).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    // Dotgo / Gupshup must not appear until T-0017.
    for (const name of files) {
      const text = readFileSync(join(root, name), 'utf8');
      expect(text.toLowerCase()).not.toMatch(/dotgo|gupshup|twilio|termii/);
    }
  });
});
