import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { hashPassword } from '@kasuwa/auth-crypto';
import { organisationToSlug, provisionSelfServeTenant } from '@kasuwa/domain-core';
import { newId, PROGRAMME_A1, TENANT_A, withAuthTransaction } from '@kasuwa/db';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { ChannelProvider } from '@kasuwa/channel-adapter';
import { Client } from 'pg';
import { CHANNEL } from '../messaging/channel';
import { AUTH_PG_POOL } from './auth-database.module';
import {
  AuthError,
  otpExpired,
  otpInvalid,
  otpTooManyAttempts,
  resendTooSoon,
} from './auth.errors';
import { notFound } from '../admin/common/admin-errors';
import { AUTH_POLICY, type AuthPolicy } from './auth.policy';
import {
  SELF_SERVE_PROVISIONING_CONNECTION,
  SELF_SERVE_SIGNUP_ENABLED,
} from './self-serve.tokens';
import type { ResendOtpBody, SignUpBody, VerifyOtpBody } from './self-serve.schemas';

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'tempmail.com',
  'throwaway.email',
  'yopmail.com',
]);

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
/** Cell-level routing for pre-tenant OTP (B1 fake channel). */
const SIGNUP_CELL_SCOPE = { tenantId: TENANT_A, programmeId: PROGRAMME_A1 };

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (local === undefined || domain === undefined) {
    return '•••@•••';
  }
  const shown =
    local.length <= 2 ? '••' : `${local[0] ?? ''}•••${local[local.length - 1] ?? ''}`;
  return `${shown}@${domain}`;
}

function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/gu, '');
  const tail = digits.slice(-4);
  return `${e164.slice(0, 4)} ••• ••• ${tail}`;
}

function randomOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function isDisposableEmail(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain !== undefined && DISPOSABLE_DOMAINS.has(domain);
}

interface SignupRow {
  id: string;
  email_hash: Buffer;
  payload: Record<string, unknown>;
  password_hash: string;
  phone_otp_hash: Buffer | null;
  phone_verified: boolean;
  email_verified: boolean;
  otp_attempt_count: number;
  expires_at: Date;
  resend_available_at: Date;
  provisioned_tenant_id: string | null;
}

@Injectable()
export class SelfServeSignupService {
  constructor(
    @Inject(AUTH_PG_POOL) private readonly authPool: Pool,
    @Inject(AUTH_POLICY) private readonly policy: AuthPolicy,
    @Inject(CHANNEL) private readonly channel: ChannelProvider,
    @Inject(SELF_SERVE_SIGNUP_ENABLED) private readonly enabled: boolean,
    @Inject(SELF_SERVE_PROVISIONING_CONNECTION) private readonly provisioningConnection: string | null,
  ) {}

  private assertEnabled(): void {
    if (!this.enabled) {
      throw notFound();
    }
  }

  async signUp(input: SignUpBody): Promise<{
    verificationId: string;
    emailHint: string | null;
    phoneHint: string | null;
    expiresAt: string;
    resendAvailableAt: string;
  }> {
    this.assertEnabled();
    if (isDisposableEmail(input.email)) {
      throw new AuthError(
        HttpStatus.BAD_REQUEST,
        'validation_failed',
        'That email address cannot be used.',
      );
    }
    if (input.country !== 'ZA') {
      throw new AuthError(
        HttpStatus.BAD_REQUEST,
        'validation_failed',
        'Self-serve sign-up is available in South Africa only.',
      );
    }
    const normalizedEmail = input.email.trim().toLowerCase();
    const emailHash = sha256(normalizedEmail);
    const phoneHash = sha256(input.phoneE164);
    const verificationId = newId();
    const otp = randomOtp();
    const otpHash = sha256(otp);
    const passwordHash = await hashPassword(input.password);
    const now = Date.now();
    const expiresAt = new Date(now + OTP_TTL_MINUTES * 60_000);
    const resendAvailableAt = new Date(now + this.policy.resendSeconds * 1000);

    await withAuthTransaction(this.authPool, { tenantSlug: 'self-serve' }, async (tx) => {
      await tx.query(
        `INSERT INTO signup_attempt
           (id, email_hash, phone_hash, payload, password_hash, phone_otp_hash,
            expires_at, resend_available_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
        [
          verificationId,
          emailHash,
          phoneHash,
          JSON.stringify({
            fullName: input.fullName,
            email: normalizedEmail,
            phoneE164: input.phoneE164,
            organisationName: input.organisationName,
            country: input.country,
            employeeSize: input.employeeSize ?? null,
            isBpo: input.isBpo ?? false,
            acceptedTermsAt: input.acceptedTermsAt,
          }),
          passwordHash,
          otpHash,
          expiresAt,
          resendAvailableAt,
        ],
      );
    });

    await this.channel.send({
      scope: SIGNUP_CELL_SCOPE,
      channel: 'sms',
      to: input.phoneE164,
      body: `Your Kasuwa verification code is ${otp}. It expires in ten minutes.`,
      purpose: 'transactional',
      idempotencyKey: `signup:${verificationId}:phone`,
    });

    return {
      verificationId,
      emailHint: maskEmail(normalizedEmail),
      phoneHint: maskPhone(input.phoneE164),
      expiresAt: expiresAt.toISOString(),
      resendAvailableAt: resendAvailableAt.toISOString(),
    };
  }

  async verifyOtp(input: VerifyOtpBody): Promise<{
    emailVerified: boolean;
    phoneVerified: boolean;
    nextStep: 'verify_email' | 'verify_phone' | 'onboarding';
  }> {
    this.assertEnabled();
    const row = await this.loadAttempt(input.verificationId);
    if (row.expires_at.getTime() <= Date.now()) {
      throw otpExpired();
    }
    if (row.otp_attempt_count >= OTP_MAX_ATTEMPTS) {
      throw otpTooManyAttempts(row.expires_at, this.policy.cellTimeZone);
    }
    const submitted = sha256(input.code);
    const expected = row.phone_otp_hash;
    if (expected === null || !timingSafeEqual(submitted, expected)) {
      await this.incrementOtpAttempts(row.id, row.otp_attempt_count);
      throw otpInvalid(Math.max(0, OTP_MAX_ATTEMPTS - row.otp_attempt_count - 1));
    }

    await withAuthTransaction(this.authPool, { tenantSlug: 'self-serve' }, async (tx) => {
      await tx.query(
        `UPDATE signup_attempt
            SET phone_verified = true, email_verified = true, updated_at = now()
          WHERE id = $1`,
        [row.id],
      );
    });

    if (row.provisioned_tenant_id === null && this.provisioningConnection !== null) {
      const payload = row.payload;
      const email = String(payload.email ?? '');
      const exists = await this.emailHasAccount(email);
      if (!exists) {
        const slug = organisationToSlug(String(payload.organisationName ?? 'workspace'));
        await provisionSelfServeTenant({
          connectionString: this.provisioningConnection,
          slug,
          organisationName: String(payload.organisationName ?? 'Workspace'),
          adminEmail: email,
          adminDisplayName: String(payload.fullName ?? 'Admin'),
          passwordHash: row.password_hash,
          allowNonLocalDatabase: true,
        });
      }
    }

    return { emailVerified: true, phoneVerified: true, nextStep: 'onboarding' };
  }

  async resendOtp(input: ResendOtpBody): Promise<{
    verificationId: string;
    emailHint: string | null;
    phoneHint: string | null;
    expiresAt: string;
    resendAvailableAt: string;
  }> {
    this.assertEnabled();
    const row = await this.loadAttempt(input.verificationId);
    if (row.resend_available_at.getTime() > Date.now()) {
      throw resendTooSoon(row.resend_available_at, this.policy.cellTimeZone);
    }
    const otp = randomOtp();
    const otpHash = sha256(otp);
    const now = Date.now();
    const expiresAt = new Date(now + OTP_TTL_MINUTES * 60_000);
    const resendAvailableAt = new Date(now + this.policy.resendSeconds * 1000);
    const phone = String(row.payload.phoneE164 ?? '');
    const email = String(row.payload.email ?? '');

    await withAuthTransaction(this.authPool, { tenantSlug: 'self-serve' }, async (tx) => {
      await tx.query(
        `UPDATE signup_attempt
            SET phone_otp_hash = $2, expires_at = $3, resend_available_at = $4,
                otp_attempt_count = 0, updated_at = now()
          WHERE id = $1`,
        [row.id, otpHash, expiresAt, resendAvailableAt],
      );
    });

    await this.channel.send({
      scope: SIGNUP_CELL_SCOPE,
      channel: 'sms',
      to: phone,
      body: `Your Kasuwa verification code is ${otp}. It expires in ten minutes.`,
      purpose: 'transactional',
      idempotencyKey: `signup:${row.id}:phone:resend:${resendAvailableAt.toISOString()}`,
    });

    return {
      verificationId: row.id,
      emailHint: maskEmail(email),
      phoneHint: maskPhone(phone),
      expiresAt: expiresAt.toISOString(),
      resendAvailableAt: resendAvailableAt.toISOString(),
    };
  }

  private async loadAttempt(id: string): Promise<SignupRow> {
    const rows = await withAuthTransaction(this.authPool, { tenantSlug: 'self-serve' }, async (tx) =>
      tx.query<SignupRow>(`SELECT * FROM signup_attempt WHERE id = $1`, [id]),
    );
    const row = rows[0];
    if (row === undefined) {
      throw otpInvalid(null);
    }
    return row;
  }

  private async incrementOtpAttempts(id: string, current: number): Promise<void> {
    await withAuthTransaction(this.authPool, { tenantSlug: 'self-serve' }, async (tx) => {
      await tx.query(
        `UPDATE signup_attempt SET otp_attempt_count = $2, updated_at = now() WHERE id = $1`,
        [id, current + 1],
      );
    });
  }

  private async emailHasAccount(email: string): Promise<boolean> {
    if (this.provisioningConnection === null) {
      return false;
    }
    const client = new Client({ connectionString: this.provisioningConnection });
    await client.connect();
    try {
      const result = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "user" WHERE lower(email) = lower($1)`,
        [email],
      );
      return (result.rows[0]?.n ?? 0) > 0;
    } finally {
      await client.end();
    }
  }
}
