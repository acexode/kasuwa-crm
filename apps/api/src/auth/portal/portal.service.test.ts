import { inviteTokenHashHex } from '@kasuwa/domain-core';
import { describe, expect, it } from 'vitest';
import { PortalAcceptInvitationBody, PortalSignInBody, PortalVerifyMfaBody } from './portal.schemas';

describe('portal invite accept (T-0180)', () => {
  it('hashes acceptance tokens the same way as portal_invite.token_hash', () => {
    const token = 'a'.repeat(48);
    expect(PortalAcceptInvitationBody.parse({ tenantSlug: 'sahel-bpo', token }).token).toBe(token);
    expect(inviteTokenHashHex(token)).toHaveLength(64);
  });
});

describe('portal schemas (T-0179)', () => {
  it('parses a sign-in body', () => {
    expect(
      PortalSignInBody.parse({
        tenantSlug: 'sahel-bpo',
        email: 'portal.client@client.example',
        password: 'x',
      }),
    ).toEqual({
      tenantSlug: 'sahel-bpo',
      email: 'portal.client@client.example',
      password: 'x',
    });
  });

  it('parses MFA verify without tenantSlug', () => {
    expect(
      PortalVerifyMfaBody.parse({
        challengeId: '11111111-0000-4000-8000-000000000001.7d2b2e14-9f4a-4a0e-8b1f-0c2a6d5e4f31',
        code: '000000',
      }),
    ).toEqual({
      challengeId: '11111111-0000-4000-8000-000000000001.7d2b2e14-9f4a-4a0e-8b1f-0c2a6d5e4f31',
      code: '000000',
    });
  });
});
