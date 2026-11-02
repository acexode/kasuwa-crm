import { z } from 'zod';

export const EMPLOYEE_SIZES = ['1-10', '11-50', '51-200', '201-1000', '1000+'] as const;

export const SignUpBody = z.strictObject({
  fullName: z.string().min(1).max(200),
  email: z.string().email().max(320),
  phoneE164: z.string().regex(/^\+[1-9][0-9]{6,14}$/u),
  organisationName: z.string().min(1).max(200),
  country: z.string().regex(/^[A-Z]{2}$/u),
  employeeSize: z.enum(EMPLOYEE_SIZES).optional(),
  isBpo: z.boolean().optional(),
  password: z.string().min(12).max(512),
  acceptedTermsAt: z.string().datetime(),
});

export type SignUpBody = z.infer<typeof SignUpBody>;

export const VerifyOtpBody = z.strictObject({
  verificationId: z.string().uuid(),
  channel: z.enum(['email', 'phone']),
  code: z.string().regex(/^[0-9]{6}$/u),
});

export type VerifyOtpBody = z.infer<typeof VerifyOtpBody>;

export const ResendOtpBody = z.strictObject({
  verificationId: z.string().uuid(),
  channel: z.enum(['email', 'phone']),
});

export type ResendOtpBody = z.infer<typeof ResendOtpBody>;
