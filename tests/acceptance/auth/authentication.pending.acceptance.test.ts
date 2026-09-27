import type { INestApplication } from '@nestjs/common';
import { assertAuthModeIsSafe } from '@kasuwa/config';
import { TENANT_A, TENANT_B, USER_A_AGENT_1, USER_B_AGENT_1 } from '@kasuwa/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0001, real authentication.
 *
 * PENDING. These are real tests and they fail today, because the endpoints do
 * not exist. That is the point: D-L23 says a task is not assigned until its
 * acceptance tests exist and fail for a real reason, and `it.todo` holds nobody
 * to anything.
 *
 * The `.pending.` in the filename keeps them out of the blocking CI gate while
 * the work is unstarted — a backlog must not look like a broken build, because
 * "CI red on main" is a stop-the-line condition and has to keep meaning
 * something. Run them with `pnpm test:pending`.
 *
 * WHEN ASSIGNING T-0001: rename this file to drop `.pending`, in a
 * lead-approved PR. `pnpm verify:tasks` fails if the task is marked assigned
 * while its tests are still pending, so the rename is not optional. From that
 * moment the builder's job is to turn this suite green without editing it.
 *
 * ------------------------------------------------------------------------
 * The single most important assertion in this file is the last one:
 * `tests/acceptance/tenancy/` must still pass, unmodified, afterwards. Auth
 * changes how we learn WHO the caller is. It must not change WHAT they can
 * reach — that is still resolved from `user_programme` inside the transaction.
 * If Agent 1 needs to touch the tenancy suite, scope has leaked into the token.
 * ------------------------------------------------------------------------
 */

const SIGN_IN = '/api/v1/auth/sign-in';
const ME = '/api/v1/auth/me';

/** Seeded in T-0001's own fixture work; the password is never a real one. */
const CREDENTIALS = {
  email: 'tunde.agent@tenant-a.test',
  password: 'correct-horse-battery-staple',
};

describe('acceptance (pending): authentication', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  it('establishes a session for valid credentials plus a valid second factor', async () => {
    const started = await request(server())
      .post(SIGN_IN)
      .send({ tenantSlug: 'sahel-bpo', ...CREDENTIALS })
      .expect(200);

    expect(started.body.mfaRequired).toBe(true);
    expect(started.body.challengeId).toEqual(expect.any(String));
    // The first factor must not hand out anything usable on its own.
    expect(JSON.stringify(started.body)).not.toMatch(/session|token|bearer/i);
  });

  it('rejects a valid password with an invalid second factor', async () => {
    const started = await request(server())
      .post(SIGN_IN)
      .send({ tenantSlug: 'sahel-bpo', ...CREDENTIALS })
      .expect(200);

    await request(server())
      .post('/api/v1/auth/mfa')
      .send({ challengeId: started.body.challengeId, code: '000000' })
      .expect(401);
  });

  it('is indistinguishable between an unknown email and a wrong password', async () => {
    // A response that differs between the two is a user-enumeration oracle:
    // it tells an attacker which addresses are real. Same rule as the 404 on
    // out-of-scope records (CLAUDE.md section 6).
    const unknown = await request(server())
      .post(SIGN_IN)
      .send({ tenantSlug: 'sahel-bpo', email: 'nobody@tenant-a.test', password: 'whatever' });

    const wrongPassword = await request(server())
      .post(SIGN_IN)
      .send({ tenantSlug: 'sahel-bpo', email: CREDENTIALS.email, password: 'wrong' });

    expect(unknown.status).toBe(wrongPassword.status);
    expect(unknown.body).toEqual(wrongPassword.body);
  });

  it('does not leak which addresses exist through response timing', async () => {
    // Argon2id on a real hash versus an early return for "no such user" is a
    // timing difference big enough to measure over a network. The fix is to
    // verify against a dummy hash when the user is absent.
    const sample = async (email: string) => {
      const timings: number[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const start = performance.now();
        await request(server())
          .post(SIGN_IN)
          .send({ tenantSlug: 'sahel-bpo', email, password: 'wrong-either-way' });
        timings.push(performance.now() - start);
      }
      return timings.sort((a, b) => a - b)[2] as number;
    };

    const unknown = await sample('nobody@tenant-a.test');
    const known = await sample(CREDENTIALS.email);

    // Generous: catches "no hashing at all for unknown users", not micro-jitter.
    const ratio = Math.max(unknown, known) / Math.min(unknown, known);
    expect(ratio).toBeLessThan(3);
  });

  it('rejects a session established for tenant A when presented against tenant B', async () => {
    const session = await signIn(server(), TENANT_A);

    await request(server())
      .get(ME)
      .set('authorization', `Bearer ${session}`)
      .set('x-kasuwa-tenant-id', TENANT_B)
      .expect(401);
  });

  it('rejects the next request after a user is disabled, without waiting for expiry', async () => {
    const session = await signIn(server(), TENANT_A);
    await request(server()).get(ME).set('authorization', `Bearer ${session}`).expect(200);

    await disableUser(USER_A_AGENT_1);

    // A token valid until its own expiry means a dismissed agent keeps access
    // for however long that is. Revocation has to be checked per request.
    await request(server()).get(ME).set('authorization', `Bearer ${session}`).expect(401);
  });

  it('never accepts a session token from a query string or URL fragment', async () => {
    const session = await signIn(server(), TENANT_A);

    await request(server()).get(`${ME}?access_token=${session}`).expect(401);
    await request(server()).get(`${ME}?token=${session}`).expect(401);
  });

  it('writes no credential material to responses', async () => {
    const response = await request(server())
      .post(SIGN_IN)
      .send({ tenantSlug: 'sahel-bpo', ...CREDENTIALS });

    const body = JSON.stringify(response.body);
    expect(body).not.toContain(CREDENTIALS.password);
    expect(body).not.toMatch(/\$argon2/);
    expect(body).not.toMatch(/passwordHash/i);
  });

  it('scopes an authenticated request exactly as the stub did', async () => {
    // The whole point: authentication changed, authorisation did not. Tunde is
    // in programme A1 only, and must still see only A1's contacts.
    const session = await signIn(server(), TENANT_A);

    const response = await request(server())
      .get('/api/v1/contacts')
      .set('authorization', `Bearer ${session}`)
      .expect(200);

    const programmes = new Set(
      (response.body.data as { programmeId: string }[]).map((row) => row.programmeId),
    );
    expect(programmes.size).toBe(1);
  });

  it('refuses to start in production with the stub resolver', () => {
    // The guard that keeps header-based auth out of a live deployment. It must
    // survive T-0001 rather than being deleted along with the stub.
    expect(() =>
      assertAuthModeIsSafe({ NODE_ENV: 'production', KASUWA_AUTH_MODE: 'stub' }),
    ).toThrow(/Refusing to start/);
  });
});

// --- helpers the implementer will need ------------------------------------
// Deliberately unimplemented: they describe the shape T-0001 must provide.
// Filling them in is part of the task, not part of the contract.

async function signIn(_server: unknown, _tenantId: string): Promise<string> {
  throw new Error(
    'T-0001: implement signIn() — complete the two-step flow and return the session token.',
  );
}

async function disableUser(_userId: string): Promise<void> {
  throw new Error('T-0001: implement disableUser() — set user.status to disabled.');
}

void USER_B_AGENT_1;
