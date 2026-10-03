import { FakeChannelProvider } from '@kasuwa/channel-adapter';
import { generateInviteToken } from '@kasuwa/domain-core';
import { describe, expect, it } from 'vitest';
import { createApiChannel } from '../../messaging/channel';
import { portalValidationFailed } from './portal-users.errors';
import { invitationBody, toPortalUserResponse } from './portal-users.presenter';
import { InvitePortalUserBody } from './portal-users.schemas';

// Invented values only (CLAUDE.md section 6).
const ADDRESS = 'unit.portal-probe@client.example';
const SCOPE = {
  tenantId: '11111111-0000-4000-8000-000000000001',
  programmeId: '11111111-0000-4000-8000-0000000c0001',
};

function detailsOf(input: unknown): unknown[] {
  const result = InvitePortalUserBody.safeParse(input);
  if (result.success) throw new Error('expected a validation failure');
  return (portalValidationFailed(result.error).getResponse() as { details: unknown[] }).details;
}

describe('portal users boundary (T-0030)', () => {
  it('accepts the spec example and leaves the address exactly as submitted', () => {
    const parsed = InvitePortalUserBody.parse({
      email: 'Portal.Invitee@Client.example',
      displayName: 'Invited Client User',
      access: 'viewer',
    });
    expect(parsed.email).toBe('Portal.Invitee@Client.example');
  });

  it('refuses scope keys by name, and never echoes the address', () => {
    expect(detailsOf({ email: ADDRESS, access: 'viewer', programmeId: SCOPE.programmeId })).toEqual(
      [{ path: 'programmeId', code: 'unrecognized_keys' }],
    );
    expect(detailsOf({ email: ADDRESS, access: 'viewer', tenantId: SCOPE.tenantId })).toEqual([
      { path: 'tenantId', code: 'unrecognized_keys' },
    ]);
    const details = detailsOf({ email: ADDRESS, access: 'owner' });
    expect(details).toEqual([{ path: 'access', code: 'invalid_enum_value' }]);
    expect(JSON.stringify(details)).not.toContain(ADDRESS);
  });

  it('bounds email at 320 and displayName at 200 characters', () => {
    expect(
      detailsOf({ email: `${'x'.repeat(320)}@client.example`, access: 'viewer' }),
    ).toContainEqual({ path: 'email', code: 'too_big' });
    expect(detailsOf({ email: ADDRESS, displayName: 'x'.repeat(201), access: 'viewer' })).toEqual([
      { path: 'displayName', code: 'too_big' },
    ]);
    expect(
      InvitePortalUserBody.safeParse({
        email: ADDRESS,
        displayName: 'x'.repeat(200),
        access: 'viewer',
      }).success,
    ).toBe(true);
  });

  it('puts the token in the body as a `token` query parameter, intact', () => {
    const { token } = generateInviteToken();
    const match = /[?&]token=([A-Za-z0-9._~%-]+)/.exec(invitationBody(token));
    expect(match?.[1]).toBe(token);
  });

  it('presents a portal user without the address, a digest or a tenant id', () => {
    const response = toPortalUserResponse({
      id: '11111111-0000-4000-8000-0000000d0001',
      displayName: 'Invited Client User',
      emailMasked: 'u•••e@client.example',
      access: 'viewer',
      status: 'invited',
      invitedAt: new Date(Date.UTC(2026, 9, 3, 8, 0, 0)),
    });
    expect(Object.keys(response).sort()).toEqual(
      ['access', 'displayName', 'emailMasked', 'id', 'invitedAt', 'status'].sort(),
    );
    expect(response.invitedAt).toBe('2026-10-03T08:00:00.000Z');
  });

  it("sends email through the adapter, and the API's DND register fails closed for promotional SMS", async () => {
    const provider = new FakeChannelProvider();
    const channel = createApiChannel(provider);
    await channel.send({
      scope: SCOPE,
      channel: 'email',
      to: ADDRESS,
      body: 'probe',
      purpose: 'transactional',
    });
    await expect(
      channel.send({
        scope: SCOPE,
        channel: 'sms',
        to: '+2348090000999',
        body: 'probe',
        purpose: 'promotional',
      }),
    ).rejects.toHaveProperty('code', 'provider_unavailable');
    expect(provider.sent.map((message) => message.channel)).toEqual(['email']);
  });
});
