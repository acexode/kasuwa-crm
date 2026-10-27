import * as z from 'zod/mini';
import { post, type Result } from './auth-api';

/**
 * The browser's half of the SELF-SERVE operations in docs/api/auth.openapi.yaml.
 *
 * A separate module from `auth-api.ts` for one measured reason: sign-in
 * imports that file, so every schema added to it ships on `P01/1` — the page
 * a user on 256 kbps waits for first. Putting these here kept 160 bytes of
 * sign-up schemas off the sign-in route.
 */

/* --------------------------------------------------------------------------
 * Self-serve sign-up — `signUp`, `verifyOtp`, `resendOtp`.
 *
 * All three are `x-kasuwa-implemented: false` in the contract (T-0016 builds
 * them) and their screens sit behind `self_serve_signup`.
 *
 * `signUp` answers 202 with ONE body whether or not the address already has an
 * account (D-P3). There is no "already registered" branch to write, and the
 * screens must not invent one: they render the server's masked hints, never
 * the address the person typed, so a new and an existing address produce the
 * same page.
 * ------------------------------------------------------------------------ */

export const EMPLOYEE_SIZES = ['1-10', '11-50', '51-200', '201-1000', '1000+'] as const;
export type EmployeeSize = (typeof EMPLOYEE_SIZES)[number];

export interface SignUpInput {
  fullName: string;
  email: string;
  phoneE164: string;
  organisationName: string;
  country: string;
  employeeSize: EmployeeSize;
  isBpo: boolean;
  password: string;
  acceptedTermsAt: string;
}

export const VerificationStarted = z.object({
  verificationId: z.string(),
  emailHint: z.optional(z.nullable(z.string())),
  phoneHint: z.optional(z.nullable(z.string())),
  expiresAt: z.string(),
  resendAvailableAt: z.string(),
});
export type VerificationStarted = z.infer<typeof VerificationStarted>;

export const VerificationResult = z.object({
  emailVerified: z.boolean(),
  phoneVerified: z.boolean(),
  nextStep: z.enum(['verify_email', 'verify_phone', 'onboarding']),
});
export type VerificationResult = z.infer<typeof VerificationResult>;

export type VerificationChannel = 'email' | 'phone';

export function signUp(input: SignUpInput, signal?: AbortSignal): Promise<Result<VerificationStarted>> {
  return post('/api/v1/auth/sign-up', input, VerificationStarted, signal);
}

export function verifyOtp(
  input: { verificationId: string; channel: VerificationChannel; code: string },
  signal?: AbortSignal,
): Promise<Result<VerificationResult>> {
  return post('/api/v1/auth/verify-otp', input, VerificationResult, signal);
}

export function resendOtp(
  input: { verificationId: string; channel: VerificationChannel },
  signal?: AbortSignal,
): Promise<Result<VerificationStarted>> {
  return post('/api/v1/auth/verify-otp/resend', input, VerificationStarted, signal);
}
