import type { PortalUser } from '@kasuwa/domain-core';

/**
 * `#/components/schemas/PortalUser`. Built field by field, so nothing the
 * domain record gains later (an address, a token digest, a tenant id) is
 * published by accident: the masked address is the only form that leaves.
 */
export interface PortalUserResponse {
  id: string;
  displayName: string;
  emailMasked: string;
  access: PortalUser['access'];
  status: PortalUser['status'];
  invitedAt: string;
}

export function toPortalUserResponse(user: PortalUser): PortalUserResponse {
  return {
    id: user.id,
    displayName: user.displayName,
    emailMasked: user.emailMasked,
    access: user.access,
    status: user.status,
    invitedAt: user.invitedAt.toISOString(),
  };
}

/**
 * The invitation the provider receives. The token travels as the `token`
 * query parameter of the acceptance link (seam S3); base64url needs no
 * escaping. There is no configured public web origin yet and no accept route
 * (M18), so the link is a path; English only, because the outsider's locale is
 * unknown (both raised in the T-0030 report).
 */
export function invitationBody(token: string): string {
  return [
    'You have been invited to view a programme on Kasuwa.',
    '',
    `Accept the invitation: /portal/invitations/accept?token=${token}`,
    '',
    'If you were not expecting this invitation, you can ignore this message.',
  ].join('\n');
}
