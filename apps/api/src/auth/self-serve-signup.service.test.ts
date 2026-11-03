import { createHash } from 'node:crypto';
import type { ChannelProvider } from '@kasuwa/channel-adapter';
import type * as Db from '@kasuwa/db';
import type * as DomainCore from '@kasuwa/domain-core';
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpException } from '@nestjs/common';
import { DEFAULT_AUTH_POLICY } from './auth.policy';
import { SelfServeSignupService } from './self-serve-signup.service';

const ID = '11111111-0000-4000-8000-00000000aa01';

interface Row {
  id: string;
  email_hash: Buffer;
  payload: Record<string, unknown>;
  password_hash: string;
  phone_otp_hash: Buffer | null;
  email_otp_hash: Buffer | null;
  phone_verified: boolean;
  email_verified: boolean;
  otp_attempt_count: number;
  expires_at: Date;
  resend_available_at: Date;
  provisioned_tenant_id: string | null;
}

const state = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  let tail = Promise.resolve();
  function locked<T>(fn: () => T): Promise<T> {
    const run = tail.then(fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  const tx = {
    query(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
      return locked(() => {
        const id = String(params[0]);
        const row = rows.get(id);
        if (sql.includes('otp_attempt_count = otp_attempt_count + 1')) {
          const max = Number(params[1]);
          if (row === undefined || row.expires_at.getTime() <= Date.now() || row.otp_attempt_count >= max) {
            return [];
          }
          row.otp_attempt_count += 1;
          return [{ ...row }];
        }
        if (sql.includes('SET phone_verified = true')) {
          if (row !== undefined) {
            row.phone_verified = true;
          }
          return [];
        }
        if (sql.includes('SET email_verified = true')) {
          if (row !== undefined) {
            row.email_verified = true;
          }
          return [];
        }
        if (sql.includes('SET phone_otp_hash')) {
          if (row !== undefined) {
            row.phone_otp_hash = params[1] as Buffer;
            row.resend_available_at = params[2] as Date;
          }
          return [];
        }
        if (sql.includes('SET email_otp_hash')) {
          if (row !== undefined) {
            row.email_otp_hash = params[1] as Buffer;
            row.resend_available_at = params[2] as Date;
          }
          return [];
        }
        if (sql.includes('SELECT * FROM signup_attempt')) {
          return row === undefined ? [] : [{ ...row }];
        }
        throw new Error(`unexpected signup sql: ${sql}`);
      });
    },
  };
  return { rows, tx };
});

const provision = vi.hoisted(() => vi.fn());

vi.mock('@kasuwa/db', async (importOriginal) => {
  const actual = await importOriginal<typeof Db>();
  return {
    ...actual,
    withAuthTransaction: async (
      _pool: unknown,
      _scope: unknown,
      fn: (tx: typeof state.tx) => Promise<unknown>,
    ) => fn(state.tx),
  };
});

vi.mock('@kasuwa/domain-core', async (importOriginal) => {
  const actual = await importOriginal<typeof DomainCore>();
  return { ...actual, provisionSelfServeTenant: provision };
});

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function seed(opts: {
  phoneCode?: string;
  emailCode?: string;
  phoneVerified?: boolean;
  emailVerified?: boolean;
  attempts?: number;
}): void {
  state.rows.set(ID, {
    id: ID,
    email_hash: sha256('other.person@example.test'),
    payload: {
      email: 'other.person@example.test',
      fullName: 'Other Person',
      organisationName: 'Other Org',
      phoneE164: '+27820000099',
    },
    password_hash: 'stored-password-hash',
    phone_otp_hash: opts.phoneCode === undefined ? null : sha256(opts.phoneCode),
    email_otp_hash: opts.emailCode === undefined ? null : sha256(opts.emailCode),
    phone_verified: opts.phoneVerified ?? false,
    email_verified: opts.emailVerified ?? false,
    otp_attempt_count: opts.attempts ?? 0,
    expires_at: new Date(Date.now() + 10 * 60_000),
    resend_available_at: new Date(Date.now() - 1_000),
    provisioned_tenant_id: null,
  });
}

function service(channel?: ChannelProvider, provisioning: string | null = null): SelfServeSignupService {
  return new SelfServeSignupService(
    {} as Pool,
    DEFAULT_AUTH_POLICY,
    channel ?? ({ send: vi.fn() } as unknown as ChannelProvider),
    true,
    provisioning,
  );
}

function codeOf(error: unknown): string {
  return ((error as HttpException).getResponse() as { code: string }).code;
}

describe('self-serve phone OTP', () => {
  beforeEach(() => {
    state.rows.clear();
    provision.mockReset();
  });

  it('evaluates at most five wrong codes when twenty arrive together', async () => {
    seed({ phoneCode: '999999', emailCode: '888888' });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service()
          .verifyOtp({ verificationId: ID, channel: 'phone', code: '000000' })
          .then(
            () => 'accepted',
            (error: unknown) => codeOf(error),
          ),
      ),
    );
    expect(results.filter((code) => code === 'otp_invalid')).toHaveLength(5);
    expect(results.filter((code) => code === 'otp_too_many_attempts')).toHaveLength(15);
    expect(results).not.toContain('accepted');
    expect(state.rows.get(ID)?.otp_attempt_count).toBe(5);
    expect(state.rows.get(ID)?.phone_verified).toBe(false);
  });

  it('does not accept the right code once the cap is reached', async () => {
    seed({ phoneCode: '123456', emailCode: '654321' });
    const signup = service();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        signup.verifyOtp({ verificationId: ID, channel: 'phone', code: '000000' }),
      ).rejects.toMatchObject({ message: expect.any(String) });
    }
    try {
      await signup.verifyOtp({ verificationId: ID, channel: 'phone', code: '123456' });
      throw new Error('accepted');
    } catch (error) {
      expect(codeOf(error)).toBe('otp_too_many_attempts');
    }
    expect(state.rows.get(ID)?.phone_verified).toBe(false);
    expect(provision).not.toHaveBeenCalled();
  });

  it('does not verify the email or provision a tenant from a phone code', async () => {
    seed({ phoneCode: '123456', emailCode: '654321' });
    const result = await service().verifyOtp({
      verificationId: ID,
      channel: 'phone',
      code: '123456',
    });
    expect(result).toEqual({
      emailVerified: false,
      phoneVerified: true,
      nextStep: 'verify_email',
    });
    expect(state.rows.get(ID)?.email_verified).toBe(false);
    expect(state.rows.get(ID)?.phone_verified).toBe(true);
    expect(provision).not.toHaveBeenCalled();
  });

  it('answers otp_invalid for an unknown verification id', async () => {
    try {
      await service().verifyOtp({
        verificationId: '11111111-0000-4000-8000-00000000aa99',
        channel: 'phone',
        code: '123456',
      });
      throw new Error('accepted');
    } catch (error) {
      expect(codeOf(error)).toBe('otp_invalid');
    }
  });
});

describe('self-serve email OTP', () => {
  beforeEach(() => {
    state.rows.clear();
    provision.mockReset();
  });

  it('sets email_verified only from a correct email code', async () => {
    seed({ phoneCode: '123456', emailCode: '654321', phoneVerified: true });
    const result = await service().verifyOtp({
      verificationId: ID,
      channel: 'email',
      code: '654321',
    });
    expect(result).toEqual({
      emailVerified: true,
      phoneVerified: true,
      nextStep: 'onboarding',
    });
    expect(state.rows.get(ID)?.email_verified).toBe(true);
  });

  it('does not set email_verified from a phone code equal to the email OTP', async () => {
    seed({ phoneCode: '111111', emailCode: '222222' });
    await expect(
      service().verifyOtp({ verificationId: ID, channel: 'phone', code: '222222' }),
    ).rejects.toMatchObject({ message: expect.any(String) });
    expect(state.rows.get(ID)?.email_verified).toBe(false);
    expect(state.rows.get(ID)?.phone_verified).toBe(false);
  });

  it('caps email attempts at five and increments before compare', async () => {
    seed({ phoneCode: '123456', emailCode: '654321', phoneVerified: true });
    const signup = service();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        signup
          .verifyOtp({ verificationId: ID, channel: 'email', code: '000000' })
          .then(
            () => 'accepted',
            (error: unknown) => codeOf(error),
          ),
      ),
    );
    expect(results.filter((code) => code === 'otp_invalid')).toHaveLength(5);
    expect(results.filter((code) => code === 'otp_too_many_attempts')).toHaveLength(15);
    expect(state.rows.get(ID)?.otp_attempt_count).toBe(5);
    expect(state.rows.get(ID)?.email_verified).toBe(false);
  });

  it('resends an email code through the email channel', async () => {
    seed({ phoneCode: '123456', emailCode: '654321', phoneVerified: true });
    const send = vi.fn().mockResolvedValue({ messageId: 'm1', state: 'queued' });
    const result = await service({ send } as unknown as ChannelProvider).resendOtp({
      verificationId: ID,
      channel: 'email',
    });
    expect(result.verificationId).toBe(ID);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'email',
        to: 'other.person@example.test',
        purpose: 'transactional',
      }),
    );
    const body = String(send.mock.calls[0]?.[0]?.body ?? '');
    expect(body).toMatch(/\d{6}/u);
  });

  it('never refills the email guesses: a correct phone code or a resend keeps the count', async () => {
    seed({ phoneCode: '123456', emailCode: '654321', attempts: 4 });
    const send = vi.fn().mockResolvedValue({ messageId: 'm1', state: 'queued' });
    const svc = service({ send } as unknown as ChannelProvider);
    await svc.verifyOtp({ verificationId: ID, channel: 'phone', code: '123456' });
    expect(state.rows.get(ID)?.otp_attempt_count).toBe(5);
    await expect(
      svc.verifyOtp({ verificationId: ID, channel: 'email', code: '654321' }),
    ).rejects.toBeDefined();
    expect(state.rows.get(ID)?.email_verified).toBe(false);
    await expect(svc.resendOtp({ verificationId: ID, channel: 'email' })).rejects.toBeDefined();
    expect(send).not.toHaveBeenCalled();
    expect(state.rows.get(ID)?.otp_attempt_count).toBe(5);
  });

  it('a resend neither extends the ten minutes nor works on a verified channel', async () => {
    seed({ phoneCode: '123456', emailCode: '654321', phoneVerified: true });
    const before = state.rows.get(ID)?.expires_at.getTime();
    const send = vi.fn().mockResolvedValue({ messageId: 'm1', state: 'queued' });
    const svc = service({ send } as unknown as ChannelProvider);
    await svc.resendOtp({ verificationId: ID, channel: 'email' });
    expect(state.rows.get(ID)?.expires_at.getTime()).toBe(before);
    await expect(svc.resendOtp({ verificationId: ID, channel: 'phone' })).rejects.toBeDefined();
  });

  it('calls provision after a correct email code when the phone is already verified', async () => {
    seed({ phoneCode: '123456', emailCode: '654321', phoneVerified: true });
    const signup = service(undefined, 'postgres://127.0.0.1:9/unused');
    const hasAccount = vi
      .spyOn(
        signup as unknown as { emailHasAccount: (email: string) => Promise<boolean> },
        'emailHasAccount',
      )
      .mockResolvedValue(false);

    const result = await signup.verifyOtp({
      verificationId: ID,
      channel: 'email',
      code: '654321',
    });
    expect(result.nextStep).toBe('onboarding');
    expect(provision).toHaveBeenCalledOnce();
    expect(hasAccount).toHaveBeenCalledOnce();
    expect(hasAccount.mock.calls[0]?.[0]).toBe('other.person@example.test');
  });

  it('does not provision from an email code alone when the phone is unverified', async () => {
    seed({ phoneCode: '123456', emailCode: '654321', phoneVerified: false });
    const signup = service(undefined, 'postgres://127.0.0.1:9/unused');
    vi.spyOn(
      signup as unknown as { emailHasAccount: (email: string) => Promise<boolean> },
      'emailHasAccount',
    ).mockResolvedValue(false);

    const result = await signup.verifyOtp({
      verificationId: ID,
      channel: 'email',
      code: '654321',
    });
    expect(result).toEqual({
      emailVerified: true,
      phoneVerified: false,
      nextStep: 'verify_phone',
    });
    expect(provision).not.toHaveBeenCalled();
  });
});
