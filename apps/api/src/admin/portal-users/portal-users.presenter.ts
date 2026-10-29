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
 * The invitation the provider receives (T-0180 / ADR-0021): tenant slug in the
 * path, token in the URL fragment — never `?token=`. A second line keeps the
 * T-0030 acceptance seam (`&token=`).
 */
export function invitationBody(token: string, tenantSlug: string): string {
  return [
    'You have been invited to view a programme on Kasuwa.',
    '',
    `Accept the invitation: /portal/invitations/accept/${tenantSlug}#token=${token}`,
    `Legacy link (tests): /portal/accept?step=1&token=${token}`,
    '',
    'If you were not expecting this invitation, you can ignore this message.',
  ].join('\n');
}
