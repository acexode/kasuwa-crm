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
        if (sql.includes('SET phone_verified = true') && !sql.includes('email_verified = true')) {
          if (row !== undefined) row.phone_verified = true;
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

function seed(code: string): void {
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
    phone_otp_hash: sha256(code),
    phone_verified: false,
    email_verified: false,
    otp_attempt_count: 0,
    expires_at: new Date(Date.now() + 10 * 60_000),
    resend_available_at: new Date(Date.now() + 60_000),
    provisioned_tenant_id: null,
  });
}

function service(): SelfServeSignupService {
  return new SelfServeSignupService(
    {} as Pool,
    DEFAULT_AUTH_POLICY,
    { send: vi.fn() } as unknown as ChannelProvider,
    true,
    'postgres://127.0.0.1:9/unused',
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
    seed('999999');
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
    seed('123456');
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
    seed('123456');
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
});
