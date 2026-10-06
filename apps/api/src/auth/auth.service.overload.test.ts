import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { HashingOverloadedError } from '@kasuwa/auth-crypto';
import type * as AuthCrypto from '@kasuwa/auth-crypto';
import type { KeyProvider } from '@kasuwa/auth-crypto';
import type * as Db from '@kasuwa/db';
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTH_POLICY } from './auth.policy';
import { AuthService } from './auth.service';

/**
 * Overload must not tell unknown users from known ones (T-0013 review).
 *
 * The hashing pool sheds with `HashingOverloadedError` when its queue is full,
 * and the API answers 503. The dummy hash an unknown user is verified against
 * is computed through that same pool, so on a cold cache it can be the thing
 * that is shed. It used to be fetched outside the 503 mapping: a known user
 * under overload got a 503 and an unknown one got a 500 — an enumeration
 * oracle that only needs a flood to read.
 *
 * Database and hashing are stubbed: this is about which error reaches the
 * caller, not about SQL. The pool is a real one in the acceptance suite.
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

interface FakeTx {
  tenantId: string | null;
  query: (sql: string, params: unknown[]) => Promise<unknown[]>;
}

const db = vi.hoisted(() => ({ tx: undefined as FakeTx | undefined }));

vi.mock('@kasuwa/db', async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  withAuthTransaction: async (_pool: unknown, _selector: unknown, fn: (tx: FakeTx) => unknown) =>
    fn(db.tx as FakeTx),
  readAuthLock: async () => null,
  registerAuthFailure: async () => ({ failedCount: 1, lockedUntil: null }),
}));

const STORED_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$a2FzdXdhLXQwMDEzLXNsdA$fsuclpjg4utgztGHSjdVA8cslilj2/aeNvWU0rz8YxM';

function service(): AuthService {
  return new AuthService({} as Pool, {} as Pool, DEFAULT_AUTH_POLICY, {} as KeyProvider);
}

/** The status and body a caller would see, or the raw error if it is not an HTTP one. */
async function outcome(
  tx: FakeTx,
  tenantSlug = 'sahel-bpo',
): Promise<{ status: number | 'not-http'; body: unknown }> {
  db.tx = tx;
  try {
    await service().signIn({ tenantSlug, email: 'someone@tenant-a.test', password: 'pw' });
  } catch (error) {
    if (error instanceof HttpException) {
      return { status: error.getStatus(), body: error.getResponse() };
    }
    return { status: 'not-http', body: String(error) };
  }
  throw new Error('sign-in unexpectedly succeeded');
}

const knownUser: FakeTx = {
  tenantId: 'tenant-a',
  query: async () => [{ id: 'user-1', status: 'active', password_hash: STORED_HASH }],
};
const unknownUser: FakeTx = { tenantId: 'tenant-a', query: async () => [] };
const unknownWorkspace: FakeTx = { tenantId: null, query: async () => [] };

describe('AuthService under hashing overload', () => {
  beforeEach(() => {
    crypto.dummyPasswordHash.mockReset();
    crypto.verifyPassword.mockReset();
  });

  it('answers unknown users, unknown workspaces and known users with the same 503 when the dummy hash is cold and the queue is full', async () => {
    // Cold cache + full queue: computing the dummy is refused, and so is any
    // verify. Every branch must come out identical.
    crypto.dummyPasswordHash.mockRejectedValue(new HashingOverloadedError());
    crypto.verifyPassword.mockRejectedValue(new HashingOverloadedError());

    const known = await outcome(knownUser);
    const unknown = await outcome(unknownUser);
    const noWorkspace = await outcome(unknownWorkspace, 'no-such-workspace');

    expect(known.status).toBe(503);
    expect(unknown).toEqual(known);
    expect(noWorkspace).toEqual(known);
  });

  it('answers the same 503 when the dummy is warm and only the verify is shed', async () => {
    crypto.dummyPasswordHash.mockResolvedValue(STORED_HASH);
    crypto.verifyPassword.mockRejectedValue(new HashingOverloadedError());

    const known = await outcome(knownUser);
    expect(known.status).toBe(503);
    expect(await outcome(unknownUser)).toEqual(known);
  });

  it('still does the dummy verify for an unknown user when not overloaded', async () => {
    // The fix moved the dummy lookup; it must not have skipped the work.
    crypto.dummyPasswordHash.mockResolvedValue('$argon2id$dummy');
    crypto.verifyPassword.mockResolvedValue(false);

    expect((await outcome(unknownUser)).status).toBe(401);
    expect(crypto.verifyPassword).toHaveBeenCalledWith('$argon2id$dummy', 'pw');
  });

  it('warms the dummy hash at start-up, and a failed warm-up does not stop boot', async () => {
    crypto.dummyPasswordHash.mockResolvedValue(STORED_HASH);
    await service().onModuleInit();
    expect(crypto.dummyPasswordHash).toHaveBeenCalledTimes(1);

    crypto.dummyPasswordHash.mockRejectedValue(new HashingOverloadedError());
    await expect(service().onModuleInit()).resolves.toBeUndefined();
  });
});
