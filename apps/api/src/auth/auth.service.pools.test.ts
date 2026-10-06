import 'reflect-metadata';
import type * as AuthCrypto from '@kasuwa/auth-crypto';
import type { KeyProvider } from '@kasuwa/auth-crypto';
import type * as Db from '@kasuwa/db';
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTH_POLICY } from './auth.policy';
import { AuthService } from './auth.service';
import { formatChallengeId } from './challenge-id';

/**
 * Which pool each auth path opens its transaction on (T-0049, D-P16).
 *
 * Since migration 0024 only `kasuwa_auth` may write the auth tables, so a
 * transaction that writes one and runs on the app pool is a 42501 in
 * production. The acceptance suites prove the happy path end to end; this pins
 * the routing itself, path by path, so a refactor that hands a writing
 * transaction the wrong pool fails here, by name, rather than as a sign-in
 * outage three suites away.
 *
 * Two reads deliberately stay on the app pool (see the AuthService class
 * comment): sign-in's phase one, and sign-out's `app.resolve_session`.
 *
 * The database and hashing are stubbed: this is about which pool, not about SQL.
 */

const crypto = vi.hoisted(() => ({
  dummyPasswordHash: vi.fn<() => Promise<string>>(),
  verifyPassword: vi.fn<(hash: string, password: string) => Promise<boolean>>(),
}));

vi.mock('@kasuwa/auth-crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthCrypto>()),
  dummyPasswordHash: crypto.dummyPasswordHash,
  verifyPassword: crypto.verifyPassword,
}));

/** Every pool a transaction or a session lookup was opened on, in order. */
const opened = vi.hoisted(() => ({ calls: [] as { kind: string; pool: unknown }[] }));

vi.mock('@kasuwa/db', async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  withAuthTransaction: async (
    pool: unknown,
    _selector: unknown,
    fn: (tx: { tenantId: string | null; query: () => Promise<unknown[]> }) => unknown,
  ) => {
    opened.calls.push({ kind: 'transaction', pool });
    // No tenant resolves: every path takes its refusal branch, which is
    // enough to see which pool it opened, and writes nothing.
    return fn({ tenantId: null, query: async () => [] });
  },
  resolveSessionIdentity: async (pool: unknown) => {
    opened.calls.push({ kind: 'resolve_session', pool });
    return {
      sessionId: '00000000-0000-4000-8000-000000000001',
      tenantId: '00000000-0000-4000-8000-000000000002',
      userId: '00000000-0000-4000-8000-000000000003',
    };
  },
  readAuthLock: async () => null,
  registerAuthFailure: async () => ({ failedCount: 1, lockedUntil: null }),
}));

// Distinct objects, so `toBe` tells them apart.
const appPool = { name: 'app' } as unknown as Pool;
const authPool = { name: 'auth' } as unknown as Pool;

function service(): AuthService {
  return new AuthService(appPool, authPool, DEFAULT_AUTH_POLICY, {} as KeyProvider);
}

/** Invented ids: the shape of a real challenge id, naming nothing. */
const CHALLENGE_ID = formatChallengeId({
  tenantId: '00000000-0000-4000-8000-00000000000a',
  challengeId: '00000000-0000-4000-8000-00000000000b',
});

function pools(): { kind: string; pool: string }[] {
  return opened.calls.map((call) => ({
    kind: call.kind,
    pool: call.pool === appPool ? 'app' : call.pool === authPool ? 'auth' : 'unknown',
  }));
}

describe('AuthService: writes on the auth pool, two reads on the app pool (T-0049)', () => {
  beforeEach(() => {
    opened.calls = [];
    crypto.dummyPasswordHash.mockReset().mockResolvedValue('$argon2id$dummy');
    crypto.verifyPassword.mockReset().mockResolvedValue(false);
  });

  it('sign-in reads on the app pool, then records the outcome on the auth pool', async () => {
    await expect(
      service().signIn({
        tenantSlug: 'no-such-workspace',
        email: 'nobody@example.test',
        password: 'not-a-password',
      }),
    ).rejects.toThrow();
    expect(pools()).toEqual([
      { kind: 'transaction', pool: 'app' },
      { kind: 'transaction', pool: 'auth' },
    ]);
  });

  it.each([
    ['verifyMfa', (s: AuthService) => s.verifyMfa({ challengeId: CHALLENGE_ID, code: '123456' })],
    [
      'reissueChallenge',
      (s: AuthService) => s.reissueChallenge({ challengeId: CHALLENGE_ID, method: 'totp' }),
    ],
    ['startEnrolment', (s: AuthService) => s.startEnrolment({ challengeId: CHALLENGE_ID })],
    [
      'confirmEnrolment',
      (s: AuthService) => s.confirmEnrolment({ challengeId: CHALLENGE_ID, code: '123456' }),
    ],
  ])('%s runs its one transaction on the auth pool', async (_name, call) => {
    await expect(call(service())).rejects.toThrow();
    expect(pools()).toEqual([{ kind: 'transaction', pool: 'auth' }]);
  });

  it('sign-out resolves the token on the app pool and revokes on the auth pool', async () => {
    await service().signOut('an-invented-token');
    expect(pools()).toEqual([
      { kind: 'resolve_session', pool: 'app' },
      { kind: 'transaction', pool: 'auth' },
    ]);
  });
});
