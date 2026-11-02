import { z } from 'zod';

export const PortalSignInBody = z.object({
  tenantSlug: z.string().min(1).max(120),
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
});

export type PortalSignInInput = z.infer<typeof PortalSignInBody>;

export const PortalVerifyMfaBody = z.object({
  challengeId: z.string().min(1),
  code: z.string().min(1).max(64),
});

export type PortalVerifyMfaInput = z.infer<typeof PortalVerifyMfaBody>;

export const PortalAcceptInvitationBody = z.strictObject({
  tenantSlug: z.string().min(1).max(120),
  token: z.string().min(32).max(256),
});

export type PortalAcceptInvitationInput = z.infer<typeof PortalAcceptInvitationBody>;

export interface PortalMfaChallengeResponse {
  mfaRequired: true;
  challengeId: string;
  expiresAt: string;
}

export interface PortalTokenResponse {
  token: string;
  tokenType: 'Bearer';
  expiresAt: string;
}

export interface PortalProgrammeWire {
  id: string;
  name: string;
}

export interface PortalContactWire {
  id: string;
  programmeId: string;
  displayName: string;
}

export interface PortalReportWire {
  id: string;
  timeline: readonly {
    id: string;
    occurredAt: string;
    type: string;
    field: string;
    actorLabel: string;
  }[];
}

export interface PortalMeResponse {
  identity: {
    id: string;
    tenantId: string;
    emailMasked: string;
    displayName: string;
  };
  programmes: readonly {
    id: string;
    name: string;
  }[];
}
