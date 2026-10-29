import { describe, expect, it } from 'vitest';
import { inviteTokenHashHex, portalInviteRateLimited } from './portal-invite.repository';
import { hashInviteToken } from '../portal-user/portal-user-invite';

describe('portal invite repository helpers (T-0180)', () => {
  it('stores token digests as hex matching hashInviteToken', () => {
    const token = 'a'.repeat(48);
    expect(inviteTokenHashHex(token)).toBe(hashInviteToken(token).toString('hex'));
    expect(inviteTokenHashHex(token)).toHaveLength(64);
  });

  it('rate-limits after five invites in the window', () => {
    expect(portalInviteRateLimited(4)).toBe(false);
    expect(portalInviteRateLimited(5)).toBe(true);
  });

  it('treats each resend row as a countable attempt (W3-13)', () => {
    // countRecentPortalInvites counts portal_invite rows; revoke+insert must
    // leave five rows after five invites so the sixth is refused.
    expect(portalInviteRateLimited(0)).toBe(false);
    expect(portalInviteRateLimited(1)).toBe(false);
    expect(portalInviteRateLimited(5)).toBe(true);
    expect(portalInviteRateLimited(6)).toBe(true);
  });
});
