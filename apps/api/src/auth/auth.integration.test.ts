import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  seedSignIn,
  PROGRAMME_A1,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { totpCode } from '@kasuwa/auth-crypto';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../app.module';

/**
 * T-0001, end to end against a real Postgres.
 *
 * This suite exists because the committed acceptance suite
 * (tests/acceptance/auth) carries two helpers that deliberately throw — they
 * describe the shape the implementation must provide, and filling them in is
 * the lead's edit, not a builder's. These tests assert the same contract from
 * inside the package, so that the behaviour is proved by something that runs
 * today rather than by a promise.
 *
 * The ordering of the lockout cases matters and is commented where it does: a
 * failed-attempt counter is shared state, and a test that leaves it dirty
 * breaks the next one.
 */

/**
 * Local rather than from @kasuwa/testing, which the boundary rule keeps out of
 * an application package — the harness there can forge RLS session variables
 * and must stay unreachable from anything that ships. The equivalents used by
 * the acceptance suite live in `packages/testing/src/auth.ts`.
 */
function credentialsFor(userId: string) {
  const fixture = seedSignIn(userId);
  if (fixture === undefined) {
    throw new Error(`No seeded sign-in fixture for user ${userId}`);
  }
  return fixture;
}

/** The code the user's authenticator app would show right now. */
function codeFor(userId: string): string {
  return totpCode(credentialsFor(userId).totpSecret);
}

/**
 * Sets a user's status, as an administrator's tooling would. Runs as
 * kasuwa_migrator because there is no user-administration endpoint yet; that
 * is M2's permissions work and a separate task.
 */
async function setUserStatus(
  migrationUrl: string,
  userId: string,
  status: 'active' | 'disabled',
): Promise<void> {
  const client = new Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    await client.query(`UPDATE "user" SET status = $2, updated_at = now() WHERE id = $1`, [
      userId,
      status,
    ]);
  } finally {
    await client.end();
  }
}

const SIGN_IN = '/api/v1/auth/sign-in';
const MFA = '/api/v1/auth/mfa';
const ME = '/api/v1/auth/me';
const CONTACTS = '/api/v1/contacts';

describe('authentication', () => {
  let app: INestApplication;
  let migrationUrl: string;

  beforeAll(async () => {
    migrationUrl = inject('migrationUrl');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot({ databaseUrl: inject('databaseUrl'), poolMax: 5 })],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  /** The whole two-step flow, returning the session token. */
  const signInAs = async (userId: string): Promise<string> => {
    const credentials = credentialsFor(userId);
    const started = await request(server())
      .post(SIGN_IN)
      .send({
        tenantSlug: credentials.tenantSlug,
        email: credentials.email,
        password: credentials.password,
      })
      .expect(200);

    const verified = await request(server())
      .post(MFA)
      .send({ challengeId: started.body.challengeId, code: codeFor(userId) })
      .expect(200);

    return verified.body.accessToken as string;
  };

  describe('the first factor', () => {
    it('opens a challenge and hands out nothing usable on its own', async () => {
      const credentials = credentialsFor(USER_A_AGENT_1);
      const response = await request(server())
        .post(SIGN_IN)
        .send({
          tenantSlug: credentials.tenantSlug,
          email: credentials.email,
          password: credentials.password,
        })
        .expect(200);

      expect(response.body.mfaRequired).toBe(true);
      expect(response.body.challengeId).toEqual(expect.any(String));
      expect(response.body.enrolmentRequired).toBe(false);
      // No field a client could mistake for a credential.
      expect(JSON.stringify(response.body)).not.toMatch(/session|token|bearer/iu);
    });

    it('writes no credential material into the response', async () => {
      const credentials = credentialsFor(USER_A_AGENT_1);
      const response = await request(server()).post(SIGN_IN).send({
        tenantSlug: credentials.tenantSlug,
        email: credentials.email,
        password: credentials.password,
      });

      const body = JSON.stringify(response.body);
      expect(body).not.toContain(credentials.password);
      expect(body).not.toContain(credentials.totpSecret);
      expect(body).not.toMatch(/\$argon2/u);
      expect(body).not.toMatch(/passwordHash/iu);
    });

    it('answers identically for an unknown email and a wrong password', async () => {
      const credentials = credentialsFor(USER_A_AGENT_1);

      const unknown = await request(server()).post(SIGN_IN).send({
        tenantSlug: credentials.tenantSlug,
        email: 'nobody@tenant-a.test',
        password: 'whatever',
      });
      const wrongPassword = await request(server()).post(SIGN_IN).send({
        tenantSlug: credentials.tenantSlug,
        email: credentials.email,
        password: 'wrong',
      });

      expect(unknown.status).toBe(401);
      expect(unknown.status).toBe(wrongPassword.status);
      expect(unknown.body).toEqual(wrongPassword.body);
      expect(unknown.body.code).toBe('invalid_credentials');

      // A correct sign-in clears the counter this just dirtied.
      await signInAs(USER_A_AGENT_1);
    });

    it('answers identically for an unknown workspace', async () => {
      const credentials = credentialsFor(USER_A_AGENT_1);
      const unknownTenant = await request(server()).post(SIGN_IN).send({
        tenantSlug: 'no-such-workspace',
        email: credentials.email,
        password: credentials.password,
      });
      const wrongPassword = await request(server()).post(SIGN_IN).send({
        tenantSlug: credentials.tenantSlug,
        email: credentials.email,
        password: 'wrong',
      });

      expect(unknownTenant.status).toBe(401);
      expect(unknownTenant.body).toEqual(wrongPassword.body);

      await signInAs(USER_A_AGENT_1);
    });

    it('refuses a user from another tenant with the same generic failure', async () => {
      const tenantB = credentialsFor(USER_B_AGENT_1);
      const tenantA = credentialsFor(USER_A_AGENT_1);

      const crossed = await request(server()).post(SIGN_IN).send({
        // Tenant B's user, tenant A's workspace, tenant B's real password.
        tenantSlug: tenantA.tenantSlug,
        email: tenantB.email,
        password: tenantB.password,
      });

      expect(crossed.status).toBe(401);
      expect(crossed.body.code).toBe('invalid_credentials');
    });

    it('does not leak which addresses exist through response timing', async () => {
      // The usual leak is an early return for "no such user", which skips
      // argon2id entirely. Generous threshold: this catches "no hashing at
      // all", not scheduler jitter.
      const credentials = credentialsFor(USER_A_SUPERVISOR);
      const sample = async (email: string) => {
        const timings: number[] = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const started = performance.now();
          await request(server()).post(SIGN_IN).send({
            tenantSlug: credentials.tenantSlug,
            email,
            password: 'wrong-either-way',
          });
          timings.push(performance.now() - started);
        }
        return timings.sort((a, b) => a - b)[1] as number;
      };

      const unknown = await sample('nobody-at-all@tenant-a.test');
      const known = await sample(credentials.email);

      expect(Math.max(unknown, known) / Math.min(unknown, known)).toBeLessThan(3);

      await signInAs(USER_A_SUPERVISOR);
    });
  });

  describe('lockout', () => {
    const fail = async (email: string) => {
      const credentials = credentialsFor(USER_A_AGENT_1);
      return request(server())
        .post(SIGN_IN)
        .send({ tenantSlug: credentials.tenantSlug, email, password: 'definitely-wrong' });
    };

    // Uses Ngozi, whom nothing else in this file signs in as: lockout is
    // shared state keyed on the address, and she stays locked for fifteen
    // minutes afterwards, which is fine because nobody else touches her.
    it('counts down, locks on the fifth failure, and leaves other addresses alone', async () => {
      const credentials = credentialsFor(USER_A_AGENT_2);

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const response = await fail(credentials.email);
        expect(response.status).toBe(401);
        expect(response.body.attemptsRemaining).toBe(5 - attempt);
      }

      const locked = await fail(credentials.email);
      expect(locked.status).toBe(429);
      expect(locked.body.code).toBe('account_locked');
      expect(locked.body.retryAt).toEqual(expect.any(String));
      // P01/1b: a time without a zone is useless to somebody in another one.
      //
      // Johannesburg, not Lagos, and that is the approximation showing itself:
      // Sahel BPO is a Nigerian tenant seeded into the `za-1` cell, and the
      // zone is derived from the cell because the schema holds no tenant
      // timezone. Recorded as an open question in team/reports/T-0001.md.
      expect(locked.body.timeZone).toBe('Africa/Johannesburg');

      // A different address is untouched. The counter is per identifier, so a
      // lockout is not itself evidence that an address is real.
      const stranger = await fail('someone-else@tenant-a.test');
      expect(stranger.status).toBe(401);
      expect(stranger.body.code).toBe('invalid_credentials');

      // Even the right password is refused while the lock holds.
      const rightPassword = await request(server()).post(SIGN_IN).send({
        tenantSlug: credentials.tenantSlug,
        email: credentials.email,
        password: credentials.password,
      });
      expect(rightPassword.status).toBe(429);
    });

    it('resets the counter on a successful sign-in', async () => {
      // Four typos across a week must not lock somebody out on the fifth.
      const credentials = credentialsFor(USER_A_AGENT_1);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await fail(credentials.email);
      }
      await signInAs(USER_A_AGENT_1);

      const afterSuccess = await fail(credentials.email);
      expect(afterSuccess.status).toBe(401);
      expect(afterSuccess.body.attemptsRemaining).toBe(4);

      await signInAs(USER_A_AGENT_1);
    });
  });

  describe('the second factor', () => {
    it('rejects a wrong code and counts the attempt down', async () => {
      const credentials = credentialsFor(USER_A_AGENT_1);
      const started = await request(server())
        .post(SIGN_IN)
        .send({
          tenantSlug: credentials.tenantSlug,
          email: credentials.email,
          password: credentials.password,
        })
        .expect(200);

      const rejected = await request(server())
        .post(MFA)
        .send({ challengeId: started.body.challengeId, code: '000000' })
        .expect(401);

      expect(rejected.body.code).toBe('mfa_code_invalid');
      expect(rejected.body.attemptsRemaining).toBe(4);
    });

    it('refuses a challenge id from another tenant', async () => {
      const credentials = credentialsFor(USER_A_AGENT_1);
      const started = await request(server())
        .post(SIGN_IN)
        .send({
          tenantSlug: credentials.tenantSlug,
          email: credentials.email,
          password: credentials.password,
        })
        .expect(200);

      const [, challengeUuid] = String(started.body.challengeId).split('.');
      const forged = `${TENANT_B}.${challengeUuid}`;

      const response = await request(server())
        .post(MFA)
        .send({ challengeId: forged, code: codeFor(USER_A_AGENT_1) })
        .expect(401);
      expect(response.body.code).toBe('mfa_challenge_invalid');
    });

    it('burns the challenge once it has been used', async () => {
      const credentials = credentialsFor(USER_A_AGENT_1);
      const started = await request(server())
        .post(SIGN_IN)
        .send({
          tenantSlug: credentials.tenantSlug,
          email: credentials.email,
          password: credentials.password,
        })
        .expect(200);

      const code = codeFor(USER_A_AGENT_1);
      await request(server())
        .post(MFA)
        .send({ challengeId: started.body.challengeId, code })
        .expect(200);

      // Same id, same valid code: one challenge must mint exactly one session.
      const replayed = await request(server())
        .post(MFA)
        .send({ challengeId: started.body.challengeId, code })
        .expect(401);
      expect(replayed.body.code).toBe('mfa_challenge_invalid');
    });

    it('returns a token and the user, and no credential material', async () => {
      const credentials = credentialsFor(USER_A_AGENT_1);
      const started = await request(server())
        .post(SIGN_IN)
        .send({
          tenantSlug: credentials.tenantSlug,
          email: credentials.email,
          password: credentials.password,
        })
        .expect(200);

      const verified = await request(server())
        .post(MFA)
        .send({ challengeId: started.body.challengeId, code: codeFor(USER_A_AGENT_1) })
        .expect(200);

      expect(verified.body.tokenType).toBe('Bearer');
      expect(verified.body.accessToken).toMatch(/^ksw_s1_/u);
      expect(verified.body.user).toMatchObject({ id: USER_A_AGENT_1, tenantId: TENANT_A });
      // Identity only: no scope of any kind travels to the client.
      expect(JSON.stringify(verified.body)).not.toMatch(/programme|role|permission/iu);
      expect(JSON.stringify(verified.body)).not.toContain(credentials.totpSecret);
    });
  });

  describe('the session', () => {
    it('authenticates a request and scopes it exactly as the stub did', async () => {
      const token = await signInAs(USER_A_AGENT_1);

      const response = await request(server())
        .get(CONTACTS)
        .set('authorization', `Bearer ${token}`)
        .expect(200);

      const programmes = new Set(
        (response.body.data as { programmeId: string }[]).map((row) => row.programmeId),
      );
      // Tunde is in A1 only. Authentication changed; authorisation did not.
      expect([...programmes]).toEqual([PROGRAMME_A1]);
    });

    it('refuses a token presented alongside a tenant header', async () => {
      const token = await signInAs(USER_A_AGENT_1);
      await request(server())
        .get(ME)
        .set('authorization', `Bearer ${token}`)
        .set('x-kasuwa-tenant-id', TENANT_B)
        .expect(401);
    });

    it('never accepts a token from a query string', async () => {
      const token = await signInAs(USER_A_AGENT_1);
      await request(server()).get(`${ME}?access_token=${token}`).expect(401);
      await request(server()).get(`${ME}?token=${token}`).expect(401);
    });

    it('rejects a forged or unknown token', async () => {
      await request(server()).get(ME).set('authorization', 'Bearer ksw_s1_not-a-real-token').expect(401);
      await request(server()).get(ME).set('authorization', 'Basic abcdef').expect(401);
    });

    it('stops working the moment the session is signed out', async () => {
      const token = await signInAs(USER_A_AGENT_1);
      await request(server()).get(ME).set('authorization', `Bearer ${token}`).expect(200);

      await request(server())
        .post('/api/v1/auth/sign-out')
        .set('authorization', `Bearer ${token}`)
        .expect(204);

      await request(server()).get(ME).set('authorization', `Bearer ${token}`).expect(401);
    });

    it('is silent about whether a token it is asked to revoke was ever real', async () => {
      await request(server())
        .post('/api/v1/auth/sign-out')
        .set('authorization', 'Bearer ksw_s1_never-existed')
        .expect(204);
      await request(server()).post('/api/v1/auth/sign-out').expect(204);
    });

    it('rejects the next request after the user is disabled, without waiting for expiry', async () => {
      const token = await signInAs(USER_A_AGENT_1);
      await request(server()).get(ME).set('authorization', `Bearer ${token}`).expect(200);

      await setUserStatus(migrationUrl, USER_A_AGENT_1, 'disabled');
      try {
        // A token valid until its own expiry means a dismissed agent keeps
        // access for however long that is.
        await request(server()).get(ME).set('authorization', `Bearer ${token}`).expect(401);
        await request(server()).get(CONTACTS).set('authorization', `Bearer ${token}`).expect(401);
      } finally {
        await setUserStatus(migrationUrl, USER_A_AGENT_1, 'active');
      }
    });
  });

  describe('the rest of the published contract', () => {
    it('reports no SSO connection for any domain', async () => {
      const response = await request(server())
        .post('/api/v1/auth/sso/lookup')
        .send({ domain: 'sahel-bpo.example' })
        .expect(404);
      expect(response.body.code).toBe('sso_domain_not_found');
    });

    it('answers 501 for the endpoints T-0001 published but did not build', async () => {
      for (const path of [
        '/api/v1/auth/sign-up',
        '/api/v1/auth/verify-otp',
        '/api/v1/auth/verify-otp/resend',
      ]) {
        const response = await request(server()).post(path).send({});
        expect(response.status, path).toBe(501);
        expect(response.body.code, path).toBe('not_implemented');
      }
    });

    it('rejects an unexpected property rather than ignoring it', async () => {
      // Strict parsing is what stops a future `programmeIds` being silently
      // accepted by a body schema that shrugged at extra fields.
      const credentials = credentialsFor(USER_A_AGENT_1);
      const response = await request(server())
        .post(SIGN_IN)
        .send({
          tenantSlug: credentials.tenantSlug,
          email: credentials.email,
          password: credentials.password,
          programmeIds: [PROGRAMME_A1],
        })
        .expect(400);
      expect(response.body.code).toBe('validation_failed');
      // Field paths only. The body carried a password.
      expect(JSON.stringify(response.body)).not.toContain(credentials.password);
    });

    it('still rejects a scope header, with or without a session', async () => {
      const token = await signInAs(USER_A_AGENT_1);
      await request(server())
        .get(CONTACTS)
        .set('authorization', `Bearer ${token}`)
        .set('x-kasuwa-programme-ids', `{${PROGRAMME_A1}}`)
        .expect(400);
    });
  });
});
