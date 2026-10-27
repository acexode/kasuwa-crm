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

export const SignInBody = z.strictObject({
  tenantSlug: z.string().min(1).max(64),
  email: z.email().max(320),
  password: z.string().min(1).max(512),
});
export type SignInInput = z.infer<typeof SignInBody>;

export const MfaMethod = z.enum(['totp', 'sms', 'backup_code']);
export type MfaMethodType = z.infer<typeof MfaMethod>;

export const MfaChallengeBody = z.strictObject({
  challengeId: z.string().min(1).max(128),
  method: MfaMethod,
});
export type MfaChallengeInput = z.infer<typeof MfaChallengeBody>;

export const MfaVerifyBody = z.strictObject({
  challengeId: z.string().min(1).max(128),
  code: z.string().min(1).max(32),
});
export type MfaVerifyInput = z.infer<typeof MfaVerifyBody>;

export const SsoLookupBody = z.strictObject({
  domain: z.string().min(3).max(253),
});
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

// --- MFA enrolment and recovery (T-0012) --------------------------------------
//
// Note what these bodies do NOT accept. Enrolment is addressed by a challenge,
// never by a slug or an email: a body naming a person is a 400 whether or not
// the person exists. And no step-up body accepts a password — a password is not
// a second factor, and a field that took one would be the bypass this task
// exists to prevent.

export const MfaEnrolBody = z.strictObject({
  challengeId: z.string().min(1).max(128),
});
export type MfaEnrolInput = z.infer<typeof MfaEnrolBody>;

export const MfaEnrolConfirmBody = z.strictObject({
  challengeId: z.string().min(1).max(128),
  code: z.string().min(1).max(32),
});
export type MfaEnrolConfirmInput = z.infer<typeof MfaEnrolConfirmBody>;

/** The current second factor, presented again before a write (step-up). */
export const StepUpBody = z.strictObject({
  code: z.string().min(1).max(32),
  method: z.enum(['totp', 'backup_code']).default('totp'),
});
export type StepUpInput = z.infer<typeof StepUpBody>;

/** A code from the NEW secret. */
export const TotpConfirmBody = z.strictObject({
  code: z.string().min(1).max(32),
});
export type TotpConfirmInput = z.infer<typeof TotpConfirmBody>;

/** Sent once. Never logged, never cached (`Cache-Control: no-store`). */
export interface TotpEnrolmentStarted {
  otpauthUri: string;
  secret: string;
  expiresAt: string;
}

export interface SessionWithBackupCodes extends SessionResponse {
  backupCodes: string[];
}

export interface BackupCodesIssued {
  backupCodes: string[];
}

/** Never the secret, never a code, never a hash. */
export interface MfaStatusResponse {
  totp: { confirmedAt: string | null };
  backupCodesRemaining: number;
}
