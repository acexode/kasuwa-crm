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

export interface PortalSessionResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresAt: string;
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
