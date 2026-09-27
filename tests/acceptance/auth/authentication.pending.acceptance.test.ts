import type { INestApplication } from '@nestjs/common';
import { assertAuthModeIsSafe } from '@kasuwa/config';
import { TENANT_A, TENANT_B, USER_A_AGENT_1, USER_B_AGENT_1 } from '@kasuwa/db';
import {
  disableSeededUser,
  enableSeededUser,
  resetSeededTotpUsage,
  seededCredentialsForTenant,
  seededTotpCodeForTenant,
} from '@kasuwa/testing';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  onTestFinished,
} from 'vitest';
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

  /**
   * ADDED BY THE LEAD, 2026-09-27, round two.
   *
   * TOTP codes are single-use, which is correct (RFC 6238 §5.2) and is a
   * control T-0001 added. It collides with this suite: `signIn()` runs four
   * times in about a second as the same user, and **no correct implementation
   * can serve more than three rapid sign-ins per user** — the server accepts
   * one step either side of the current one, so there are only three codes in
   * play.
   *
   * The builder offered two fixes and recommended this one over constructing
   * the app with `rejectReusedTotpCodes: false`. It is right, and for the same
   * reason the lockout threshold stayed at five: turning a security control
   * off so a test goes green is the mistake, whichever direction it comes
   * from. It did not make that change itself even though it would have been
   * the quicker path.
   *
   * So the control stays on and the fixture's usage record is cleared between
   * tests instead.
   */
  beforeEach(async () => {
    await resetSeededTotpUsage(inject('migrationUrl'));
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
    //
    // AMENDED BY THE LEAD, 2026-09-27. This originally took five samples
    // against CREDENTIALS.email, and the indistinguishability test above adds
    // a sixth failure to the same address — so with the lockout threshold of
    // 5 that the P01 board specifies, the account was locked before the later
    // tests tried to sign in, and the suite could not pass.
    //
    // The T-0001 builder found it and asked whether to default the threshold
    // to 10 so the suite would pass. **No.** The design says five, this test
    // was wrong, and loosening a security default to satisfy a test the lead
    // wrote is the same mistake as editing a test to satisfy the code, with
    // worse consequences. Raising it would also have been invisible: the suite
    // would have gone green and nobody would have known the number moved.
    //
    // Fixed by staying under the threshold instead: a dedicated identity that
    // no other test signs in as, and three samples rather than five.
    const TIMING_PROBE = 'musa.supervisor@tenant-a.test';

    const sample = async (email: string) => {
      const timings: number[] = [];
      // Three, not five: the threshold is 5, and a locked account skips
      // hashing entirely — which would make this test measure the lockout
      // rather than the hash, and pass for the wrong reason.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const start = performance.now();
        await request(server())
          .post(SIGN_IN)
          .send({ tenantSlug: 'sahel-bpo', email, password: 'wrong-either-way' });
        timings.push(performance.now() - start);
      }
      return timings.sort((a, b) => a - b)[1] as number;
    };

    const unknown = await sample('nobody@tenant-a.test');
    const known = await sample(TIMING_PROBE);

    // Generous: catches "no hashing at all for unknown users", not micro-jitter.
    const ratio = Math.max(unknown, known) / Math.min(unknown, known);
    expect(ratio).toBeLessThan(3);
  });

  it('locks the account on the fifth consecutive failure, as the design says', async () => {
    // ADDED BY THE LEAD, 2026-09-27, with the timing fix above.
    //
    // The number was only in the design before this. That made it a value
    // somebody could change in config without anything going red — and the
    // T-0001 builder was about to be pushed into doing exactly that by a
    // broken test of mine. A security default that lives only in a picture is
    // not a default, so it is pinned here.
    //
    // A dedicated identity: this test deliberately burns one, and sharing it
    // is what caused the original problem.
    const VICTIM = 'emeka.unassigned@tenant-a.test';

    const attempt = () =>
      request(server())
        .post(SIGN_IN)
        .send({ tenantSlug: 'sahel-bpo', email: VICTIM, password: 'wrong' });

    for (let index = 0; index < 4; index += 1) {
      const response = await attempt();
      expect(response.status, `attempt ${index + 1} should still be a plain rejection`).toBe(401);
    }

    const locked = await attempt();
    expect(locked.status, 'the fifth failure must lock the account').toBe(429);

    // P01/1b: naming the time without naming the zone is useless to someone
    // whose phone clock is in another one, and BPO rosters span WAT/EAT/SAST.
    expect(locked.body.code).toBe('account_locked');
    expect(locked.body.retryAt, 'no retryAt').toBeDefined();
    expect(locked.body.timeZone, 'no IANA timeZone — see P01/1b').toBeDefined();

    // And still no enumeration: a locked real account and an unknown address
    // must not be told apart by the lockout either.
    const unknown = await request(server())
      .post(SIGN_IN)
      .send({ tenantSlug: 'sahel-bpo', email: 'nobody-else@tenant-a.test', password: 'wrong' });
    expect(unknown.status, 'the lockout itself became the enumeration oracle').toBe(401);
  });

  it('forgets the failed attempts once a sign-in succeeds', async () => {
    // Without this, four typos spread across a week lock an agent out on the
    // fifth, which reads as a broken product rather than a security control.
    const email = 'ngozi.agent@tenant-a.test';

    await request(server())
      .post(SIGN_IN)
      .send({ tenantSlug: 'sahel-bpo', email, password: 'wrong' });

    const ok = await request(server())
      .post(SIGN_IN)
      .send({ tenantSlug: 'sahel-bpo', email, password: CREDENTIALS.password });
    expect(ok.status).toBe(200);

    // Four more must still be survivable — the counter restarted.
    for (let index = 0; index < 4; index += 1) {
      const response = await request(server())
        .post(SIGN_IN)
        .send({ tenantSlug: 'sahel-bpo', email, password: 'wrong' });
      expect(response.status, `attempt ${index + 1} after a success`).toBe(401);
    }
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

    // Undo it when this test finishes. Two later tests sign in as this same
    // user, and a disable that outlives its test makes them fail at the
    // sign-in step for a reason that looks like an implementation bug and is
    // not. The T-0001 builder spotted this and could not fix it from outside
    // the file.
    onTestFinished(async () => {
      await enableSeededUser(inject('migrationUrl'), USER_A_AGENT_1);
    });

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
//
// AMENDED BY THE LEAD, 2026-09-27, for the same reason as the metadata suite
// (D-L29). These were stubs that threw, inside a file the builder is forbidden
// to edit, with a comment saying the builder fills them in. That is a
// contradiction in the task design, and it is the SECOND time it has appeared —
// T-0002 hit the identical shape on the same day.
//
// The T-0001 builder did what the T-0002 builder did: it did not touch this
// file, it implemented the fixtures in `@kasuwa/testing` where a builder
// legitimately can, and it handed back the delegation written out. This is it.
//
// D-L29 now requires such fixtures to live in `@kasuwa/testing` from the start.
// Two occurrences in one day is the evidence that the rule was needed.

async function signIn(server: unknown, tenantId: string): Promise<string> {
  const credentials = seededCredentialsForTenant(tenantId);

  const started = await request(server as never)
    .post(SIGN_IN)
    .send({
      tenantSlug: credentials.tenantSlug,
      email: credentials.email,
      password: credentials.password,
    })
    .expect(200);

  const verified = await request(server as never)
    .post('/api/v1/auth/mfa')
    .send({
      challengeId: started.body.challengeId,
      code: seededTotpCodeForTenant(tenantId),
    })
    .expect(200);

  return verified.body.accessToken as string;
}

async function disableUser(userId: string): Promise<void> {
  await disableSeededUser(inject('migrationUrl'), userId);
}

void USER_B_AGENT_1;
