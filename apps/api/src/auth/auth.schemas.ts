import { z } from 'zod';

/**
 * Zod at the boundary (CLAUDE.md section 4). Parse, do not cast.
 *
 * `.strict()` everywhere: an unexpected property in a sign-in body is either a
 * client bug or somebody trying a field that used to mean something, and both
 * deserve a 400 rather than to be quietly dropped. It is also what stops a
 * future `programmeIds` from being silently accepted if anyone ever adds one.
 *
 * Nothing here is echoed back. The validation filter reports field paths and
 * issue codes only — never the submitted value — because these bodies carry
 * passwords and codes.
 */

export const SignInBody = z
  .object({
    tenantSlug: z.string().min(1).max(64),
    email: z.string().email().max(320),
    password: z.string().min(1).max(512),
  })
  .strict();
export type SignInInput = z.infer<typeof SignInBody>;

export const MfaMethod = z.enum(['totp', 'sms', 'backup_code']);
export type MfaMethodType = z.infer<typeof MfaMethod>;

export const MfaChallengeBody = z
  .object({
    challengeId: z.string().min(1).max(128),
    method: MfaMethod,
  })
  .strict();
export type MfaChallengeInput = z.infer<typeof MfaChallengeBody>;

export const MfaVerifyBody = z
  .object({
    challengeId: z.string().min(1).max(128),
    code: z.string().min(1).max(32),
  })
  .strict();
export type MfaVerifyInput = z.infer<typeof MfaVerifyBody>;

export const SsoLookupBody = z
  .object({
    domain: z.string().min(3).max(253),
  })
  .strict();
export type SsoLookupInput = z.infer<typeof SsoLookupBody>;

export interface MfaMethodDescription {
  type: MfaMethodType;
  available: boolean;
  deliveryHint: string | null;
}

export interface MfaChallengeResponse {
  mfaRequired: true;
  challengeId: string;
  method: MfaMethodType;
  methods: MfaMethodDescription[];
  enrolmentRequired: boolean;
  expiresAt: string;
  resendAvailableAt: string | null;
}

/**
 * The authenticated user, as the API describes them.
 *
 * Identity only. There is deliberately no programme list, no role and no
 * permission set here — those are scope, and scope is never handed to a client
 * as something to act on. The same reasoning as `AuthContext`.
 */
export interface CurrentUserResponse {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  locale: string;
}

export interface SessionResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresAt: string;
  user: CurrentUserResponse;
}
