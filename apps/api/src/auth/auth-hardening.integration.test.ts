import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { totpCode } from '@kasuwa/auth-crypto';
import {
  NON_TENANT_SCOPED_TABLES,
  seedSignIn,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../app.module';

/**
 * Regression tests for a security review of T-0001's first implementation.
 *
 * Every test here corresponds to a finding. None of them would have failed
 * against the code as first written **because none of them existed** — the
 * suite was green and two of the findings were races that a sequential test can
 * never see. That is the lesson worth keeping: a green suite was not evidence,
 * and from here it has to be.
 *
 * The two race tests fire genuinely concurrent requests. They are not
 * deterministic proofs — a passing run does not prove the race is gone — but
 * they fail reliably against the broken implementation, which is what a
 * regression test is for.
 */

const SIGN_IN = '/api/v1/auth/sign-in';
const MFA = '/api/v1/auth/mfa';

function credentialsFor(userId: string) {
  const fixture = seedSignIn(userId);
  if (fixture === undefined) {
    throw new Error(`No seeded sign-in fixture for user ${userId}`);
  }
  return fixture;
}


/**
 * Put every piece of authentication state back to what the seed produced.
 *
 * Both integration files in this directory drive the same seeded users against
 * the same container, and authentication is made almost entirely of state that
 * is SUPPOSED to persist: failed-attempt counters, open challenges, issued
 * sessions, the single-use TOTP watermark, whether a user is disabled, whether
 * a tenant is suspended. Every one of those is deliberate in production and
 * poison between tests, and leaving any of them behind makes a later test fail
 * for a reason that has nothing to do with what it asserts — which is exactly
 * what happened, in a different combination on each run.
 *
 * This is isolation, not leniency. The limits themselves stay at their real
 * defaults; each test simply starts from the same place.
 */
async function resetAuthState(migrationUrl: string): Promise<void> {
  const client = new Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    // DELETE rather than TRUNCATE. TRUNCATE takes an ACCESS EXCLUSIVE lock on
    // every table named, which deadlocks against a request still holding row
    // locks on those same tables in the other order — and an aborted
    // transaction silently loses the counter it was writing, so the symptom
    // surfaces as an unrelated assertion in a later test.
    await client.query('DELETE FROM auth_session');
    await client.query('DELETE FROM auth_challenge');
    await client.query('DELETE FROM auth_rate_limit');
    await client.query('UPDATE user_mfa_factor SET last_used_step = NULL');
    await client.query(`UPDATE "user" SET status = 'active' WHERE status <> 'active'`);
    await client.query(`UPDATE tenant SET status = 'active' WHERE status <> 'active'`);
  } finally {
    await client.end();
  }
}

describe('authentication hardening', () => {
  let app: INestApplication;
  let databaseUrl: string;
  let migrationUrl: string;

  beforeAll(async () => {
    databaseUrl = inject('databaseUrl');
    migrationUrl = inject('migrationUrl');
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          databaseUrl,
          poolMax: 10,
          // The throttle is a resource control and is exercised in its own test
          // below with a deliberately low limit. Leaving it at the default here
          // would make every other test in this file a test of the throttle.
          authPolicy: { signInPerMinutePerClient: 0 },
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    // Leave no lockouts, suspensions or disabled users behind. These tests
    // deliberately create all three, and the suite shares one container with
    // every other integration file.
    await resetAuthState(migrationUrl);
  });

  const server = () => app.getHttpServer();

  beforeEach(async () => {
    await resetAuthState(migrationUrl);
  });

  const startChallenge = async (userId: string): Promise<string> => {
    const credentials = credentialsFor(userId);
    const started = await request(server())
      .post(SIGN_IN)
      .send({
        tenantSlug: credentials.tenantSlug,
        email: credentials.email,
        password: credentials.password,
      })
      .expect(200);
    return started.body.challengeId as string;
  };

  describe('BLOCKING — the second factor cannot be brute-forced', () => {
    it('counts concurrent wrong codes atomically instead of losing them', async () => {
      // The original read attempt_count, added one in JavaScript and wrote the
      // result back. Under READ COMMITTED, ten concurrent guesses all read 0
      // and all wrote 1, so the burn at the threshold never fired and one
      // challenge accepted unlimited guesses. With a stolen password that is a
      // full session for about 3.3e5 requests.
      const challengeId = await startChallenge(USER_A_AGENT_1);
      const attempts = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(server()).post(MFA).send({ challengeId, code: '000000' }),
        ),
      );

      // Not one of them may succeed, however they interleaved.
      for (const attempt of attempts) {
        expect(attempt.status).not.toBe(200);
      }

      // Whatever the interleaving, the challenge must be spent afterwards.
      const afterwards = await request(server())
        .post(MFA)
        .send({ challengeId, code: totpCode(credentialsFor(USER_A_AGENT_1).totpSecret) });
      expect(afterwards.status).toBe(401);
      expect(afterwards.body.code).toBe('mfa_challenge_invalid');

      const client = new Client({ connectionString: migrationUrl });
      await client.connect();
      try {
        const [, challengeUuid] = challengeId.split('.');
        const rows = await client.query<{ attempt_count: number; consumed_at: Date | null }>(
          'SELECT attempt_count, consumed_at FROM auth_challenge WHERE id = $1',
          [challengeUuid],
        );
        // Every attempt was recorded; none was lost to a lost update.
        expect(rows.rows[0]?.attempt_count).toBeGreaterThanOrEqual(5);
        expect(rows.rows[0]?.consumed_at).not.toBeNull();
      } finally {
        await client.end();
      }
    });

    it('locks the user across challenges, not merely the challenge', async () => {
      // Burning one challenge bounds nothing: somebody holding the password
      // simply opens another. This is the counter that decides what a stolen
      // password is actually worth.
      const userId = USER_A_SUPERVISOR;
      let sawLock = false;

      for (let round = 0; round < 4 && !sawLock; round += 1) {
        const challengeId = await startChallenge(userId);
        for (let guess = 0; guess < 5; guess += 1) {
          const response = await request(server())
            .post(MFA)
            .send({ challengeId, code: '000000' });
          if (response.status === 429) {
            expect(response.body.code).toBe('account_locked');
            sawLock = true;
            break;
          }
        }
      }

      expect(sawLock, 'the user-level MFA lockout never fired').toBe(true);
    });

    it('caps how many challenges one user may have open at once', async () => {
      // Without a cap, an attacker opens a thousand challenges and gets
      // challengeMaxAttempts guesses against each.
      const userId = USER_A_NO_PROGRAMME;
      const opened: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        opened.push(await startChallenge(userId));
      }

      const client = new Client({ connectionString: migrationUrl });
      await client.connect();
      try {
        const rows = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM auth_challenge
            WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now()`,
          [userId],
        );
        expect(Number(rows.rows[0]?.count)).toBeLessThanOrEqual(3);
      } finally {
        await client.end();
      }

      // The newest still works — the cap must not become a way to deny a
      // legitimate user their sign-in.
      const newest = opened[opened.length - 1] as string;
      await request(server())
        .post(MFA)
        .send({ challengeId: newest, code: totpCode(credentialsFor(userId).totpSecret) })
        .expect(200);
    });
  });

  describe('the lock order the first fix introduced', () => {
    it('survives sign-ins and second factors arriving together for one user', async () => {
      // A third race, found while fixing the first two and not covered by
      // either. Sign-in wrote `auth_rate_limit` and then `auth_challenge`;
      // verifying a second factor wrote them in the opposite order. Two
      // requests for the same user arriving together could each hold the row
      // the other wanted, and Postgres resolves that by aborting one of them.
      //
      // The damage is not the error. The aborted transaction rolls back the
      // counter increment it was making, so the lockout it was building
      // towards never arrives — a brute-force control that quietly stops
      // counting under exactly the load an attack produces. It surfaced as
      // four unrelated tests failing in a different combination on every run.
      const credentials = credentialsFor(USER_A_SUPERVISOR);
      const challenges = await Promise.all([
        startChallenge(USER_A_SUPERVISOR),
        startChallenge(USER_A_SUPERVISOR),
      ]);

      const mixed = await Promise.all([
        ...challenges.map((challengeId) =>
          request(server()).post(MFA).send({ challengeId, code: '000000' }),
        ),
        ...Array.from({ length: 6 }, () =>
          request(server()).post(SIGN_IN).send({
            tenantSlug: credentials.tenantSlug,
            email: credentials.email,
            password: 'definitely-wrong',
          }),
        ),
      ]);

      // Nothing may 500. A deadlock abort reaches the client as one.
      for (const response of mixed) {
        expect([401, 429], `unexpected ${response.status}`).toContain(response.status);
      }

      // And every failure was actually counted: six wrong passwords past a
      // threshold of five must leave the identifier locked.
      const afterwards = await request(server()).post(SIGN_IN).send({
        tenantSlug: credentials.tenantSlug,
        email: credentials.email,
        password: credentials.password,
      });
      expect(afterwards.status).toBe(429);
      expect(afterwards.body.code).toBe('account_locked');
    });
  });

  describe('MAJOR — one challenge mints exactly one session', () => {
    it('survives concurrent verifies with the same valid code', async () => {
      // findOpenChallenge checked `consumed_at IS NULL`, then the consume ran
      // without `AND consumed_at IS NULL` and without RETURNING. Eight parallel
      // requests with a valid code all passed the check and all issued a
      // session.
      const challengeId = await startChallenge(USER_A_AGENT_2);
      const code = totpCode(credentialsFor(USER_A_AGENT_2).totpSecret);

      const responses = await Promise.all(
        Array.from({ length: 8 }, () => request(server()).post(MFA).send({ challengeId, code })),
      );

      const issued = responses.filter((response) => response.status === 200);
      expect(issued).toHaveLength(1);

      const tokens = new Set(issued.map((response) => response.body.accessToken as string));
      expect(tokens.size).toBe(1);
    });

    it('refuses to replay a code that has already been accepted', async () => {
      // A code stays arithmetically valid for ninety seconds. Without
      // last_used_step, anyone who saw it over a shoulder or in a phishing form
      // could use it while the victim was still typing.
      const userId = USER_A_AGENT_2;
      const code = totpCode(credentialsFor(userId).totpSecret);

      const first = await startChallenge(userId);
      await request(server()).post(MFA).send({ challengeId: first, code }).expect(200);

      const second = await startChallenge(userId);
      const replayed = await request(server()).post(MFA).send({ challengeId: second, code });
      expect(replayed.status).toBe(401);
      expect(replayed.body.code).toBe('mfa_code_invalid');
    });
  });

  describe('MAJOR — a workspace that does not exist answers like one that does', () => {
    it('counts down and locks identically for a fake slug', async () => {
      const real = credentialsFor(USER_A_AGENT_1);
      const fail = (tenantSlug: string, email: string) =>
        request(server()).post(SIGN_IN).send({ tenantSlug, email, password: 'wrong' });

      const realCountdown: unknown[] = [];
      const fakeCountdown: unknown[] = [];

      for (let attempt = 0; attempt < 4; attempt += 1) {
        realCountdown.push((await fail(real.tenantSlug, real.email)).body);
        fakeCountdown.push((await fail('no-such-workspace', real.email)).body);
      }

      // Previously the fake slug reported `attemptsRemaining: 4` forever while
      // the real one counted down. Two requests told them apart.
      expect(fakeCountdown).toEqual(realCountdown);

      const realLock = await fail(real.tenantSlug, real.email);
      const fakeLock = await fail('no-such-workspace', real.email);
      expect(fakeLock.status).toBe(realLock.status);
      expect(fakeLock.status).toBe(429);
      expect(fakeLock.body.code).toBe(realLock.body.code);
      // retryAt is a timestamp and will differ by milliseconds; everything else
      // about the two bodies must not.
      expect(Object.keys(fakeLock.body).sort()).toEqual(Object.keys(realLock.body).sort());
      expect(fakeLock.body.timeZone).toBe(realLock.body.timeZone);
    });

    it('does not disclose the hosting region through the lockout zone', async () => {
      // The zone is the cell's, one value for the deployment, so it says
      // nothing about any particular workspace.
      const fail = (tenantSlug: string) =>
        request(server())
          .post(SIGN_IN)
          .send({ tenantSlug, email: 'nobody@example.test', password: 'wrong' });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await fail('sahel-bpo');
      }
      const tenantA = await fail('sahel-bpo');

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await fail('rift-valley-contact');
      }
      const tenantB = await fail('rift-valley-contact');

      expect(tenantA.status).toBe(429);
      expect(tenantB.status).toBe(429);
      // Tenant A is seeded into za-1 and tenant B into ke-1. The old
      // implementation reported different zones for them.
      expect(tenantA.body.timeZone).toBe(tenantB.body.timeZone);
    });
  });

  describe('MAJOR — unauthenticated resource exhaustion', () => {
    it('throttles sign-in per client address', async () => {
      const throttled = await Test.createTestingModule({
        imports: [
          AppModule.forRoot({
            databaseUrl,
            poolMax: 5,
            authPolicy: { signInPerMinutePerClient: 3, lockoutMaxAttempts: 0 },
          }),
        ],
      }).compile();
      const limitedApp = throttled.createNestApplication({ logger: false });
      await limitedApp.init();

      try {
        const send = () =>
          request(limitedApp.getHttpServer())
            .post(SIGN_IN)
            .send({ tenantSlug: 'sahel-bpo', email: 'nobody@example.test', password: 'wrong' });

        expect((await send()).status).toBe(401);
        expect((await send()).status).toBe(401);
        expect((await send()).status).toBe(401);

        const blocked = await send();
        expect(blocked.status).toBe(429);
        expect(blocked.body.code).toBe('too_many_requests');
      } finally {
        await limitedApp.close();
      }
    });

    it('bounds concurrent argon2id work rather than allocating per request', async () => {
      // Sixteen concurrent sign-ins against a cap of six. The assertion is not
      // about speed: it is that every request is answered, which is what does
      // not happen when each one allocates 19 MiB unbounded.
      const responses = await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          request(server()).post(SIGN_IN).send({
            tenantSlug: 'sahel-bpo',
            email: `nobody-${index}@example.test`,
            password: 'wrong',
          }),
        ),
      );
      for (const response of responses) {
        expect([401, 429]).toContain(response.status);
      }
    });
  });

  describe('the tenancy review — suspension must contain', () => {
    it('refuses an existing session once the tenant is suspended', async () => {
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
        .send({
          challengeId: started.body.challengeId,
          code: totpCode(credentials.totpSecret),
        })
        .expect(200);
      const token = verified.body.accessToken as string;

      await request(server())
        .get('/api/v1/auth/me')
        .set('authorization', `Bearer ${token}`)
        .expect(200);

      const client = new Client({ connectionString: migrationUrl });
      await client.connect();
      try {
        await client.query(`UPDATE tenant SET status = 'suspended' WHERE id = $1`, [TENANT_A]);
        // Previously this stayed 200 until the token expired: suspension
        // stopped new sign-ins and did nothing about sessions already issued.
        await request(server())
          .get('/api/v1/auth/me')
          .set('authorization', `Bearer ${token}`)
          .expect(401);
      } finally {
        await client.query(`UPDATE tenant SET status = 'active' WHERE id = $1`, [TENANT_A]);
        await client.end();
      }
    });

    it('refuses a challenge whose tenant was suspended mid-flow', async () => {
      const credentials = credentialsFor(USER_B_AGENT_1);
      const started = await request(server())
        .post(SIGN_IN)
        .send({
          tenantSlug: credentials.tenantSlug,
          email: credentials.email,
          password: credentials.password,
        })
        .expect(200);

      const client = new Client({ connectionString: migrationUrl });
      await client.connect();
      try {
        await client.query(`UPDATE tenant SET status = 'suspended' WHERE id = $1`, [TENANT_B]);
        const response = await request(server())
          .post(MFA)
          .send({
            challengeId: started.body.challengeId,
            code: totpCode(credentials.totpSecret),
          });
        expect(response.status).toBe(401);
      } finally {
        await client.query(`UPDATE tenant SET status = 'active' WHERE id = $1`, [TENANT_B]);
        await client.end();
      }
    });
  });

  describe('the exempted table is still protected', () => {
    it('has RLS enabled, forced and policied despite carrying no tenant_id', async () => {
      // Being exempt from tenant scoping is not being exempt from RLS. Without
      // this, NON_TENANT_SCOPED_TABLES would be a way to smuggle a table past
      // the catalogue invariant entirely.
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        const rows = await client.query<{
          relname: string;
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
          policies: number;
        }>(
          `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
                  (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = ANY ($1::text[])`,
          [[...NON_TENANT_SCOPED_TABLES]],
        );

        expect(rows.rows).toHaveLength(NON_TENANT_SCOPED_TABLES.length);
        for (const row of rows.rows) {
          expect(row.relrowsecurity, `${row.relname}: RLS not enabled`).toBe(true);
          expect(row.relforcerowsecurity, `${row.relname}: RLS not forced`).toBe(true);
          expect(row.policies, `${row.relname}: no policy`).toBeGreaterThan(0);
        }
      } finally {
        await client.end();
      }
    });

    it('is a list of exactly one, so the exemption cannot spread quietly', () => {
      // Growing this list is an architecture decision and needs an ADR. If this
      // fails, read NON_TENANT_SCOPED_TABLES and ask whether the new entry has
      // one.
      expect([...NON_TENANT_SCOPED_TABLES]).toEqual(['auth_rate_limit']);
    });
  });
});

