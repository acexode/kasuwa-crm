import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { TENANT_A, USER_A_AGENT_1 } from '@kasuwa/db';
import { reseed, resetSeededTotpUsage, seededCredentials } from '@kasuwa/testing';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApi } from '../support/api';
import { collectTelemetry } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0012, MFA enrolment, backup codes and recovery.
 *
 * ACTIVE (D-L23). Written by the lead from
 * team/tasks/T-0012-mfa-enrolment-and-recovery.md ("Acceptance tests"),
 * DECISION-LOG D-L13 (envelope encryption through @kasuwa/auth-crypto, the
 * mechanism that already protects TOTP secrets), DECISIONS D-L54 (the
 * provisioned first admin signs in with a one-time setup credential and must
 * enrol MFA), CLAUDE.md sections 2 and 6.
 *
 * ------------------------------------------------------------------------
 * THE HOLE THIS CLOSES
 * ------------------------------------------------------------------------
 * A user with no confirmed factor cannot sign in, and the first such user is
 * the administrator `pnpm tenant:provision` just created. A user who loses
 * their phone is in the same place with no way back. And the classic failure
 * of the fix: an enrolment route reachable with a password alone, so a stolen
 * password enrols the thief's phone and the second factor is gone.
 *
 * ------------------------------------------------------------------------
 * THE INTERFACE THE BUILDER MUST PROVIDE (add each to docs/api/auth.openapi.yaml
 * in the same style as the existing operations — that is the builder's job)
 * ------------------------------------------------------------------------
 *
 * Pre-session, bound to a sign-in challenge (no session exists yet; holding
 * the `challengeId` is the proof of the first factor). `security: []`, no
 * throttle guard (no hashing), and the same per-challenge and per-user
 * counters as `POST /api/v1/auth/mfa`:
 *
 *   POST /api/v1/auth/mfa/enrol
 *     body  { challengeId }                                  additionalProperties: false
 *     200   TotpEnrolmentStarted { otpauthUri, secret, expiresAt }
 *             otpauthUri  otpauth://totp/<label>?secret=<base32>&issuer=<non-empty>
 *             secret      the same base32 secret (>= 160 bits), for manual entry
 *           Only for a user with NO confirmed factor (`enrolmentRequired: true`).
 *           Calling it again on the same challenge issues a NEW secret and the
 *           earlier one can no longer be confirmed. QR rendering is the web
 *           app's, from `otpauthUri`; the secret is not sent in any other form.
 *     401   mfa_challenge_invalid / mfa_challenge_expired (as /auth/mfa)
 *     403   mfa_already_enrolled — the user has a confirmed factor. A password
 *           cannot replace it; replacement is the session route below.
 *     429   account_locked (the per-user MFA lock)
 *
 *   POST /api/v1/auth/mfa/enrol/confirm
 *     body  { challengeId, code }                            additionalProperties: false
 *     200   SessionEstablished & { backupCodes: string[] }
 *           Marks the factor `confirmed_at`, consumes the challenge, issues the
 *           session and returns the backup codes — the only time they exist in
 *           plaintext. This is the ONLY way a pending factor becomes usable.
 *     401   mfa_code_invalid (attemptsRemaining counts down) /
 *           mfa_challenge_invalid / mfa_challenge_expired
 *     429   account_locked
 *
 * Session-bound (`Authorization: Bearer`, KasuwaAuthGuard + tenant
 * transaction, exactly like GET /auth/me). Every write requires the CURRENT
 * second factor again (step-up): a session alone is not enough to swap the
 * factor out from under its owner.
 *
 *   GET  /api/v1/auth/me/mfa
 *     200   { totp: { confirmedAt: string | null }, backupCodesRemaining: number }
 *           Never the secret, never a code, never a hash.
 *
 *   POST /api/v1/auth/me/mfa/totp                (start replacing the factor)
 *     body  { code, method?: 'totp' | 'backup_code' }        additionalProperties: false
 *           `method` defaults to 'totp'. 'backup_code' is the lost-device path:
 *           it consumes that backup code.
 *     200   TotpEnrolmentStarted. The OLD factor keeps working until confirm.
 *     400   validation_failed (no code; a `password` field is not a factor)
 *     401   mfa_code_invalid — counted against the same per-user MFA counter
 *           as sign-in; not_authenticated without a session
 *     429   account_locked
 *
 *   POST /api/v1/auth/me/mfa/totp/confirm
 *     body  { code }   (from the NEW secret)
 *     2xx   The new secret replaces the old; the old one stops working.
 *
 *   POST /api/v1/auth/me/mfa/backup-codes        (regenerate)
 *     body  { code, method?: 'totp' | 'backup_code' }
 *     200   { backupCodes: string[] } — the previous set stops working.
 *
 * Existing operations that change:
 *
 *   POST /api/v1/auth/mfa/challenge  { challengeId, method: 'backup_code' }
 *     200 (was 501) when the user has an unused backup code; `method` in the
 *     response is 'backup_code'. Then POST /api/v1/auth/mfa { challengeId,
 *     code: <backup code> } establishes the session and consumes the code.
 *   MfaChallengeStarted.methods[backup_code].available is true while the user
 *     has unused backup codes.
 *   Error.code gains `mfa_already_enrolled`.
 *
 * Every response that carries a secret or backup codes sends
 * `Cache-Control: no-store`.
 *
 * ------------------------------------------------------------------------
 * STORAGE (asserted from the database, as kasuwa_migrator)
 * ------------------------------------------------------------------------
 *   - A factor written by this task is envelope-only (D-L13): the four
 *     `secret_*` columns from 0005 set, the legacy plaintext `secret` NULL.
 *   - Backup codes are hashed like passwords (task: "hashed at rest like a
 *     password, never like a secret"). The suite greps EVERY table in the
 *     database for the codes in plaintext, hex, base64 and unsalted SHA-256,
 *     so where they live is the builder's choice; any new table must be in
 *     TENANT_SCOPED_TABLES with RLS forced (CLAUDE.md 2.4, asserted by
 *     tenancy/rls-enforcement).
 *
 * ------------------------------------------------------------------------
 * DELIBERATELY NOT ASSERTED HERE
 * ------------------------------------------------------------------------
 *   - The administrator revoking another user's factor (scope item 4). It
 *     belongs with the permissions engine and needs its own shape; say what
 *     you built in the report.
 *   - The cleanup sweep in apps/worker for auth_challenge, auth_session,
 *     auth_rate_limit (also T-0012). It needs a worker harness this suite does
 *     not have; it is held by the builder's integration tests and the report.
 *   - Any SMS or email recovery channel: none exists (Agent 5, M8). Backup
 *     codes are the recovery path this suite proves.
 *   - Backup-code count and format beyond a floor (>= 8 codes, >= 8
 *     alphanumeric characters each, never six digits). State the reasoning.
 *
 * ------------------------------------------------------------------------
 * HARNESS NOTES
 * ------------------------------------------------------------------------
 * No-factor users come from the REAL provisioning path (D-L54): every test
 * that needs one provisions its own tenant through
 * `@kasuwa/domain-core/provisioning`, so lockout counters (auth_rate_limit is
 * not tenant-scoped and survives a reseed) never leak between tests or into
 * the seeded users. Seeded users are only signed in, never locked.
 *
 * TOTP codes are computed here from the secret the API returned, with a
 * self-contained RFC 6238 implementation, so the suite does not trust the
 * implementation's own arithmetic. Codes are single-use; when a user runs out
 * of unused steps in the current window the suite calls
 * `resetSeededTotpUsage` — the lead-approved fixture that clears the
 * single-use watermark between operations without switching the control off
 * (see authentication.acceptance.test.ts).
 *
 * Writes: reseeds in afterAll (the seed truncates every provisioned tenant).
 */

const SIGN_IN = '/api/v1/auth/sign-in';
const MFA = '/api/v1/auth/mfa';
const MFA_CHALLENGE = '/api/v1/auth/mfa/challenge';
const ENROL = '/api/v1/auth/mfa/enrol';
const ENROL_CONFIRM = '/api/v1/auth/mfa/enrol/confirm';
const ME = '/api/v1/auth/me';
const ME_MFA = '/api/v1/auth/me/mfa';
const ME_TOTP = '/api/v1/auth/me/mfa/totp';
const ME_TOTP_CONFIRM = '/api/v1/auth/me/mfa/totp/confirm';
const ME_BACKUP_CODES = '/api/v1/auth/me/mfa/backup-codes';

/** The P01 numbers, pinned in auth.policy.ts and the T-0001 suite. */
const CHALLENGE_MAX_ATTEMPTS = 5;
const MFA_MAX_ATTEMPTS = 10;

/** Unique per run, lowercase alphanumeric, so every slug built from it is valid. */
const RUN = Date.now().toString(36);
let tenantCounter = 0;

// --- an independent RFC 6238 authenticator ---------------------------------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;

function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/=+$/u, '').replace(/\s+/gu, '').toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of cleaned) {
    const value = BASE32.indexOf(character);
    if (value === -1) throw new Error('not base32');
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: string, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 1_000_000).toString().padStart(6, '0');
}

const currentStep = () => Math.floor(Date.now() / STEP_MS);

/**
 * One user's phone. Hands out codes at the current step and the next one only
 * (both stay inside the server's one-step window even if a step boundary
 * passes mid-request), never the same step twice — the server watermark is per
 * user, and may carry over when a factor is replaced, so the steps are tracked
 * per user rather than per secret.
 */
class Phone {
  private lastStep: number | null = null;

  async code(secret: string): Promise<string> {
    const now = currentStep();
    let step = this.lastStep === null ? now : Math.max(this.lastStep + 1, now);
    if (step > now + 1) {
      await resetSeededTotpUsage(inject('migrationUrl'));
      step = now;
    }
    this.lastStep = step;
    return hotp(secret, step);
  }

  /** Six digits that match no step anywhere near the server's window. */
  static wrongCode(secret: string): string {
    const now = currentStep();
    const live = new Set([-2, -1, 0, 1, 2].map((offset) => hotp(secret, now + offset)));
    for (let candidate = 0; ; candidate += 1) {
      const code = candidate.toString().padStart(6, '0');
      if (!live.has(code)) return code;
    }
  }
}

// --- leak detection ---------------------------------------------------------

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const unique = (values: string[]) => [...new Set(values)];

/** Every recognisable form of a TOTP secret. */
function formsOfSecret(secret: string): string[] {
  const raw = base32Decode(secret);
  return unique([
    secret,
    secret.toLowerCase(),
    raw.toString('hex'),
    raw.toString('base64'),
    raw.toString('base64url'),
  ]);
}

/** Every recognisable recoverable form of a backup code, including a cheap unsalted hash. */
function formsOfBackupCode(code: string): string[] {
  const bare = code.replace(/[^A-Za-z0-9]/gu, '');
  const variants = unique([code, bare, bare.toLowerCase(), bare.toUpperCase()]);
  return unique(
    variants.flatMap((variant) => [
      variant,
      Buffer.from(variant).toString('hex'),
      Buffer.from(variant).toString('base64'),
      sha256(variant),
    ]),
  );
}

function expectAbsent(haystack: string, needles: string[], what: string): void {
  for (const needle of needles) {
    expect(haystack.includes(needle), `${what} contains "${needle}"`).toBe(false);
  }
}

/** Runs `fn` as kasuwa_migrator (BYPASSRLS): the auditor's view of the whole cell. */
async function asMigrator<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: inject('migrationUrl') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Every row of every table in the database, as JSON text. bytea renders as hex. */
async function dumpDatabase(): Promise<string> {
  return asMigrator(async (client) => {
    const tables = await client.query<{ schema: string; name: string }>(
      `SELECT table_schema AS schema, table_name AS name
         FROM information_schema.tables
        WHERE table_type = 'BASE TABLE'
          AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
    );
    const parts: string[] = [];
    for (const table of tables.rows) {
      const rows = await client.query<{ dump: string | null }>(
        `SELECT json_agg(t)::text AS dump FROM "${table.schema}"."${table.name}" t`,
      );
      parts.push(`${table.schema}.${table.name}:${rows.rows[0]?.dump ?? ''}`);
    }
    return parts.join('\n');
  });
}

interface FactorRow {
  id: string;
  secret: string | null;
  secret_ciphertext: Buffer | null;
  secret_wrapped_key: Buffer | null;
  secret_key_id: string | null;
  secret_algorithm: string | null;
  confirmed_at: Date | null;
}

async function factorsOf(tenantId: string, userId: string): Promise<FactorRow[]> {
  return asMigrator(async (client) => {
    const result = await client.query<FactorRow>(
      `SELECT id, secret, secret_ciphertext, secret_wrapped_key, secret_key_id,
              secret_algorithm, confirmed_at
         FROM user_mfa_factor
        WHERE tenant_id = $1 AND user_id = $2
        ORDER BY created_at`,
      [tenantId, userId],
    );
    return result.rows;
  });
}

// --- provisioning (D-L54), loaded by path so this file typechecks on its own ---

interface ProvisionedTenant {
  tenantId: string;
  slug: string;
  adminUserId: string;
  setupCredential: string;
}

interface ProvisioningModule {
  provisionTenant: (options: {
    connectionString: string;
    slug: string;
    name: string;
    adminEmail: string;
    adminDisplayName: string;
  }) => Promise<ProvisionedTenant>;
}

const PROVISIONING: string = '@kasuwa/domain-core/provisioning';

/** A provisioned first admin: who they are and how they sign in. */
interface Admin {
  tenantId: string;
  userId: string;
  slug: string;
  email: string;
  password: string;
  phone: Phone;
}

/** An admin who has enrolled and confirmed, with what that returned. */
interface EnrolledAdmin extends Admin {
  secret: string;
  backupCodes: string[];
  accessToken: string;
}

describe('acceptance: MFA enrolment and recovery (T-0012)', () => {
  let app: INestApplication;
  let provisioning: ProvisioningModule;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
    provisioning = (await import(PROVISIONING)) as ProvisioningModule;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();

  /** A brand-new tenant whose only user has never had a second factor. */
  async function newAdmin(): Promise<Admin> {
    tenantCounter += 1;
    const slug = `mfa-${RUN}-${tenantCounter}`;
    const email = `founder.${RUN}.${tenantCounter}@mfa-enrol.test`;
    const tenant = await provisioning.provisionTenant({
      connectionString: inject('migrationUrl'),
      slug,
      name: `MFA Enrolment ${tenantCounter}`,
      adminEmail: email,
      adminDisplayName: 'Halima Garba',
    });
    return {
      tenantId: tenant.tenantId,
      userId: tenant.adminUserId,
      slug,
      email,
      password: tenant.setupCredential,
      phone: new Phone(),
    };
  }

  async function signIn(user: Pick<Admin, 'slug' | 'email' | 'password'>) {
    const response = await request(server())
      .post(SIGN_IN)
      .send({ tenantSlug: user.slug, email: user.email, password: user.password })
      .expect(200);
    return response.body as {
      challengeId: string;
      enrolmentRequired: boolean;
      methods: { type: string; available: boolean }[];
    };
  }

  const enrol = (challengeId: string) => request(server()).post(ENROL).send({ challengeId });

  const confirm = (challengeId: string, code: string) =>
    request(server()).post(ENROL_CONFIRM).send({ challengeId, code });

  const verify = (challengeId: string, code: string) =>
    request(server()).post(MFA).send({ challengeId, code });

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  /** Parses and checks a TotpEnrolmentStarted body; returns the secret. */
  function secretFrom(body: { otpauthUri?: unknown; secret?: unknown }): string {
    expect(typeof body.otpauthUri, 'no otpauthUri').toBe('string');
    expect(typeof body.secret, 'no manual-entry secret').toBe('string');
    const uri = new URL(body.otpauthUri as string);
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.hostname).toBe('totp');
    expect(uri.searchParams.get('issuer'), 'otpauth URI has no issuer').toBeTruthy();
    const secret = uri.searchParams.get('secret') ?? '';
    expect(secret, 'the URI and the manual-entry secret disagree').toBe(body.secret);
    // >= 160 bits (RFC 4226 section 4): 32 base32 characters.
    expect(base32Decode(secret).length).toBeGreaterThanOrEqual(20);
    return secret;
  }

  /** Provision, sign in with the setup credential, enrol and confirm. */
  async function enrolledAdmin(): Promise<EnrolledAdmin> {
    const admin = await newAdmin();
    const challenge = await signIn(admin);
    const started = await enrol(challenge.challengeId).expect(200);
    const secret = secretFrom(started.body);
    const confirmed = await confirm(challenge.challengeId, await admin.phone.code(secret)).expect(
      200,
    );
    return {
      ...admin,
      secret,
      backupCodes: confirmed.body.backupCodes as string[],
      accessToken: confirmed.body.accessToken as string,
    };
  }

  /** Sign in with the second factor; returns the response so callers can assert on it. */
  async function signInWithTotp(user: Admin, secret: string) {
    const challenge = await signIn(user);
    return verify(challenge.challengeId, await user.phone.code(secret));
  }

  async function signInWithBackupCode(user: Admin, code: string) {
    const challenge = await signIn(user);
    const switched = await request(server())
      .post(MFA_CHALLENGE)
      .send({ challengeId: challenge.challengeId, method: 'backup_code' })
      .expect(200);
    expect(switched.body.method).toBe('backup_code');
    return verify(challenge.challengeId, code);
  }

  // --- enrolment ---------------------------------------------------------------

  it('lets a provisioned admin enrol with the setup credential and finish signing in (D-L54)', async () => {
    const admin = await newAdmin();

    const challenge = await signIn(admin);
    expect(challenge.enrolmentRequired).toBe(true);

    const started = await enrol(challenge.challengeId).expect(200);
    expect(started.headers['cache-control'], 'a secret must not be cached').toMatch(/no-store/);
    const secret = secretFrom(started.body);

    const confirmed = await confirm(challenge.challengeId, await admin.phone.code(secret)).expect(
      200,
    );
    expect(confirmed.headers['cache-control']).toMatch(/no-store/);
    expect(confirmed.body.tokenType).toBe('Bearer');
    expect(confirmed.body.user.id).toBe(admin.userId);
    expect(Array.isArray(confirmed.body.backupCodes)).toBe(true);

    await request(server()).get(ME).set(bearer(confirmed.body.accessToken)).expect(200);

    // The challenge minted one session and is spent.
    await confirm(challenge.challengeId, await admin.phone.code(secret)).expect(401);

    const [factor] = await factorsOf(admin.tenantId, admin.userId);
    expect(factor?.confirmed_at, 'the factor was not marked confirmed').not.toBeNull();

    // From now on the admin is an ordinary MFA user.
    const next = await signIn(admin);
    expect(next.enrolmentRequired).toBe(false);
    expect(next.methods.find((method) => method.type === 'totp')?.available).toBe(true);
    await verify(next.challengeId, await admin.phone.code(secret)).expect(200);
  });

  it('never lets an unconfirmed factor satisfy a challenge', async () => {
    const admin = await newAdmin();
    const challenge = await signIn(admin);
    const secret = secretFrom((await enrol(challenge.challengeId).expect(200)).body);

    // A correct code for the PENDING secret, presented to the ordinary second
    // factor route, must not establish a session.
    const sneaked = await verify(challenge.challengeId, await admin.phone.code(secret));
    expect(sneaked.status).toBe(401);
    expect(JSON.stringify(sneaked.body)).not.toMatch(/accessToken|ksw_s1_/);

    // Nor a wrong code at confirm.
    const wrong = await confirm(challenge.challengeId, Phone.wrongCode(secret));
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('mfa_code_invalid');

    const factors = await factorsOf(admin.tenantId, admin.userId);
    expect(factors.every((factor) => factor.confirmed_at === null)).toBe(true);

    // The next sign-in still says enrolment is required.
    expect((await signIn(admin)).enrolmentRequired).toBe(true);
  });

  it('issues a fresh secret when enrolment restarts, and the first can no longer be confirmed', async () => {
    const admin = await newAdmin();
    const challenge = await signIn(admin);

    const first = secretFrom((await enrol(challenge.challengeId).expect(200)).body);
    const second = secretFrom((await enrol(challenge.challengeId).expect(200)).body);
    // The secret is shown once. A second call that handed back the same one
    // would make the enrolment response a way to read the secret again.
    expect(second).not.toBe(first);

    const stale = await confirm(challenge.challengeId, await admin.phone.code(first));
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('mfa_code_invalid');

    await confirm(challenge.challengeId, await admin.phone.code(second)).expect(200);
  });

  it('refuses password-only enrolment for a user who already has a confirmed factor', async () => {
    // A seeded user with a confirmed factor, and an attacker holding only the
    // password: a challenge is all a password buys.
    const tunde = seededCredentials(USER_A_AGENT_1);
    const before = await factorsOf(TENANT_A, USER_A_AGENT_1);

    const challenge = await signIn({
      slug: tunde.tenantSlug,
      email: tunde.email,
      password: tunde.password,
    });
    expect(challenge.enrolmentRequired).toBe(false);

    const refused = await enrol(challenge.challengeId);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('mfa_already_enrolled');
    expect(JSON.stringify(refused.body)).not.toMatch(/otpauth|secret/i);

    // Nothing about the existing factor moved.
    const shape = (rows: FactorRow[]) =>
      rows.map((row) => ({
        id: row.id,
        secret: row.secret,
        ciphertext: row.secret_ciphertext?.toString('hex') ?? null,
        confirmedAt: row.confirmed_at?.toISOString() ?? null,
      }));
    expect(shape(await factorsOf(TENANT_A, USER_A_AGENT_1))).toEqual(shape(before));

    // The same for a factor enrolled through T-0012 itself, and confirm cannot
    // be used to slip a factor in either. (A provisioned user, so the wrong
    // code below never touches a seeded user's MFA counter, which survives a
    // reseed.)
    const admin = await enrolledAdmin();
    const adminBefore = shape(await factorsOf(admin.tenantId, admin.userId));
    const stolen = await signIn(admin);
    expect(stolen.enrolmentRequired).toBe(false);

    const again = await enrol(stolen.challengeId);
    expect(again.status).toBe(403);
    expect(again.body.code).toBe('mfa_already_enrolled');

    const slipped = await confirm(stolen.challengeId, '123456');
    expect(slipped.status).not.toBe(200);
    expect(JSON.stringify(slipped.body)).not.toMatch(/accessToken|backupCodes|otpauth/);

    expect(shape(await factorsOf(admin.tenantId, admin.userId))).toEqual(adminBefore);
  });

  it('requires the current factor, not a session or a password, to start replacing it', async () => {
    const admin = await enrolledAdmin();
    const before = await factorsOf(admin.tenantId, admin.userId);

    // No session at all.
    await request(server()).post(ME_TOTP).send({ code: '123456' }).expect(401);

    // A session but no factor.
    const bare = await request(server()).post(ME_TOTP).set(bearer(admin.accessToken)).send({});
    expect(bare.status).toBe(400);

    // A password is not a second factor.
    const withPassword = await request(server())
      .post(ME_TOTP)
      .set(bearer(admin.accessToken))
      .send({ password: admin.password });
    expect(withPassword.status).toBe(400);

    // A wrong code.
    const wrong = await request(server())
      .post(ME_TOTP)
      .set(bearer(admin.accessToken))
      .send({ code: Phone.wrongCode(admin.secret) });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('mfa_code_invalid');

    for (const response of [bare, withPassword, wrong]) {
      expect(JSON.stringify(response.body)).not.toMatch(/otpauth/);
    }
    const after = await factorsOf(admin.tenantId, admin.userId);
    expect(after.map((factor) => factor.id)).toEqual(before.map((factor) => factor.id));
  });

  it('replaces a factor only when the new one is confirmed, and the old one then stops working', async () => {
    const admin = await enrolledAdmin();

    const started = await request(server())
      .post(ME_TOTP)
      .set(bearer(admin.accessToken))
      .send({ code: await admin.phone.code(admin.secret) })
      .expect(200);
    expect(started.headers['cache-control']).toMatch(/no-store/);
    const replacement = secretFrom(started.body);
    expect(replacement).not.toBe(admin.secret);

    // Pending: the new secret does not sign anyone in yet.
    expect((await signInWithTotp(admin, replacement)).status).toBe(401);

    await request(server())
      .post(ME_TOTP_CONFIRM)
      .set(bearer(admin.accessToken))
      .send({ code: await admin.phone.code(replacement) })
      .expect((response) => expect(response.status).toBeLessThan(300));

    expect((await signInWithTotp(admin, admin.secret)).status, 'the old factor still works').toBe(
      401,
    );
    expect((await signInWithTotp(admin, replacement)).status).toBe(200);
  });

  // --- the secret ------------------------------------------------------------

  it('stores the TOTP secret envelope-encrypted and nowhere in plaintext (D-L13)', async () => {
    const admin = await enrolledAdmin();

    const factors = await factorsOf(admin.tenantId, admin.userId);
    expect(factors.length).toBeGreaterThan(0);
    const raw = base32Decode(admin.secret);
    for (const factor of factors) {
      expect(factor.secret, 'a factor written by T-0012 carries the legacy plaintext').toBeNull();
      expect(factor.secret_ciphertext).not.toBeNull();
      expect(factor.secret_wrapped_key).not.toBeNull();
      expect(factor.secret_key_id).toBeTruthy();
      expect(factor.secret_algorithm).toBeTruthy();
      const ciphertext = factor.secret_ciphertext ?? Buffer.alloc(0);
      expect(ciphertext.includes(raw), 'the ciphertext contains the raw secret').toBe(false);
      expect(ciphertext.includes(Buffer.from(admin.secret))).toBe(false);
    }

    expectAbsent(await dumpDatabase(), formsOfSecret(admin.secret), 'the database');
  });

  it('never returns the secret again after the enrolment response', async () => {
    const admin = await newAdmin();
    const first = await signIn(admin);
    const secret = secretFrom((await enrol(first.challengeId).expect(200)).body);

    const later: { body: unknown; headers: unknown }[] = [];
    const keep = (response: request.Response) => {
      later.push({ body: response.body, headers: response.headers });
      return response;
    };

    keep(
      await request(server())
        .post(MFA_CHALLENGE)
        .send({ challengeId: first.challengeId, method: 'totp' }),
    );
    const confirmed = keep(await confirm(first.challengeId, await admin.phone.code(secret)));
    expect(confirmed.status).toBe(200);
    const token = confirmed.body.accessToken as string;

    keep(await request(server()).get(ME).set(bearer(token)));
    keep(await request(server()).get(ME_MFA).set(bearer(token)).expect(200));
    const second = await signIn(admin);
    later.push({ body: second, headers: {} });
    keep(await verify(second.challengeId, await admin.phone.code(secret)));

    const haystack = JSON.stringify(later);
    expectAbsent(haystack, formsOfSecret(secret), 'a later response');
    expect(haystack).not.toMatch(/otpauth/);
  });

  it('keeps the secret and the backup codes out of logs, traces and stdout', async () => {
    const admin = await newAdmin();
    let secret = '';
    let backupCodes: string[] = [];
    const written: string[] = [];

    const stdoutWrite = process.stdout.write.bind(process.stdout);
    const stderrWrite = process.stderr.write.bind(process.stderr);
    const capture =
      (original: typeof process.stdout.write): typeof process.stdout.write =>
      (chunk: unknown, ...rest: unknown[]) => {
        written.push(typeof chunk === 'string' ? chunk : String(chunk));
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      };

    let telemetry: { spans: unknown[]; logs: unknown[] };
    process.stdout.write = capture(stdoutWrite);
    process.stderr.write = capture(stderrWrite);
    try {
      telemetry = await collectTelemetry(async () => {
        const challenge = await signIn(admin);
        secret = secretFrom((await enrol(challenge.challengeId).expect(200)).body);
        // A wrong code first: error paths are where secrets end up in logs.
        await confirm(challenge.challengeId, Phone.wrongCode(secret)).expect(401);
        const confirmed = await confirm(
          challenge.challengeId,
          await admin.phone.code(secret),
        ).expect(200);
        backupCodes = confirmed.body.backupCodes as string[];
        expect((await signInWithBackupCode(admin, backupCodes[0] as string)).status).toBe(200);
        expect((await signInWithBackupCode(admin, backupCodes[0] as string)).status).toBe(401);
      });
    } finally {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    }

    const haystack = JSON.stringify({ ...telemetry, written });
    expectAbsent(haystack, formsOfSecret(secret), 'telemetry or process output');
    for (const code of backupCodes) {
      expectAbsent(haystack, formsOfBackupCode(code), 'telemetry or process output');
    }
  });

  // --- backup codes ------------------------------------------------------------

  it('returns backup codes once, and stores them only as password-style hashes', async () => {
    const admin = await enrolledAdmin();
    const codes = admin.backupCodes;

    expect(codes.length).toBeGreaterThanOrEqual(8);
    expect(new Set(codes).size, 'backup codes repeat').toBe(codes.length);
    for (const code of codes) {
      expect(code.replace(/[^A-Za-z0-9]/gu, '').length).toBeGreaterThanOrEqual(8);
      // Never confusable with a TOTP code at the same input.
      expect(code).not.toMatch(/^[0-9]{6}$/);
    }

    const database = await dumpDatabase();
    for (const code of codes) {
      expectAbsent(database, formsOfBackupCode(code), 'the database');
    }

    const status = await request(server()).get(ME_MFA).set(bearer(admin.accessToken)).expect(200);
    expect(status.body.backupCodesRemaining).toBe(codes.length);
    expect(status.body.totp.confirmedAt).toEqual(expect.any(String));
  });

  it('accepts each backup code exactly once', async () => {
    const admin = await enrolledAdmin();
    const [code] = admin.backupCodes;

    const challenge = await signIn(admin);
    expect(challenge.methods.find((method) => method.type === 'backup_code')?.available).toBe(true);

    const used = await signInWithBackupCode(admin, code as string);
    expect(used.status).toBe(200);
    expect(used.body.accessToken).toEqual(expect.any(String));

    const replayed = await signInWithBackupCode(admin, code as string);
    expect(replayed.status).toBe(401);
    expect(replayed.body.code).toBe('mfa_code_invalid');

    const status = await request(server()).get(ME_MFA).set(bearer(admin.accessToken)).expect(200);
    expect(status.body.backupCodesRemaining).toBe(admin.backupCodes.length - 1);
  });

  it('never reads backup codes back, and regenerating them needs the factor and kills the old set', async () => {
    const admin = await enrolledAdmin();
    const auth = bearer(admin.accessToken);

    const readable: unknown[] = [];
    for (const path of [ME, ME_MFA, ME_BACKUP_CODES, ME_TOTP]) {
      const response = await request(server()).get(path).set(auth);
      readable.push({ path, status: response.status, body: response.body });
    }
    const readBack = JSON.stringify(readable);
    for (const code of admin.backupCodes) {
      expectAbsent(readBack, formsOfBackupCode(code), 'a GET response');
    }
    expectAbsent(readBack, formsOfSecret(admin.secret), 'a GET response');

    // Regeneration is a write that mints credentials: same step-up rule.
    expect((await request(server()).post(ME_BACKUP_CODES).set(auth).send({})).status).toBe(400);
    const wrong = await request(server())
      .post(ME_BACKUP_CODES)
      .set(auth)
      .send({ code: Phone.wrongCode(admin.secret) });
    expect(wrong.status).toBe(401);
    expect(JSON.stringify(wrong.body)).not.toMatch(/backupCodes/);

    const regenerated = await request(server())
      .post(ME_BACKUP_CODES)
      .set(auth)
      .send({ code: await admin.phone.code(admin.secret) })
      .expect(200);
    expect(regenerated.headers['cache-control']).toMatch(/no-store/);
    const fresh = regenerated.body.backupCodes as string[];
    expect(fresh.length).toBeGreaterThanOrEqual(8);
    expect(fresh.some((code) => admin.backupCodes.includes(code))).toBe(false);

    expect((await signInWithBackupCode(admin, admin.backupCodes[1] as string)).status).toBe(401);
    expect((await signInWithBackupCode(admin, fresh[0] as string)).status).toBe(200);
  });

  it('recovers a lost device with backup codes, and each code used is then dead', async () => {
    const admin = await enrolledAdmin();
    const [toSignIn, toReplace] = admin.backupCodes as [string, string];

    // The phone is gone. A backup code is the second factor.
    const recovered = await signInWithBackupCode(admin, toSignIn);
    expect(recovered.status).toBe(200);
    const auth = bearer(recovered.body.accessToken as string);

    // Replacing the factor needs a factor; without the phone, that is a
    // second backup code, consumed.
    const started = await request(server())
      .post(ME_TOTP)
      .set(auth)
      .send({ method: 'backup_code', code: toReplace })
      .expect(200);
    const replacement = secretFrom(started.body);

    await request(server())
      .post(ME_TOTP_CONFIRM)
      .set(auth)
      .send({ code: await admin.phone.code(replacement) })
      .expect((response) => expect(response.status).toBeLessThan(300));

    expect((await signInWithTotp(admin, admin.secret)).status, 'the lost phone still works').toBe(
      401,
    );
    expect((await signInWithTotp(admin, replacement)).status).toBe(200);

    expect((await signInWithBackupCode(admin, toSignIn)).status).toBe(401);
    expect((await signInWithBackupCode(admin, toReplace)).status).toBe(401);

    const status = await request(server()).get(ME_MFA).set(auth).expect(200);
    expect(status.body.backupCodesRemaining).toBe(admin.backupCodes.length - 2);
  });

  // --- rate limiting -------------------------------------------------------------

  it('counts wrong enrolment codes against the same challenge and user limits as sign-in', async () => {
    const admin = await newAdmin();

    // Challenge one: the per-challenge cap burns it on the fifth wrong code.
    const one = await signIn(admin);
    const firstSecret = secretFrom((await enrol(one.challengeId).expect(200)).body);
    for (let attempt = 1; attempt < CHALLENGE_MAX_ATTEMPTS; attempt += 1) {
      const response = await confirm(one.challengeId, Phone.wrongCode(firstSecret));
      expect(response.status, `wrong code ${attempt}`).toBe(401);
      expect(response.body.code).toBe('mfa_code_invalid');
      expect(response.body.attemptsRemaining).toBe(CHALLENGE_MAX_ATTEMPTS - attempt);
    }
    const burned = await confirm(one.challengeId, Phone.wrongCode(firstSecret));
    expect(burned.status).toBe(401);
    expect(burned.body.code).toBe('mfa_challenge_invalid');
    // A burned challenge is burned for the right code too.
    expect((await confirm(one.challengeId, await admin.phone.code(firstSecret))).status).toBe(401);

    // Challenge two: the per-user counter carries over, so the tenth wrong
    // code in total locks the user's second factor — exactly as /auth/mfa does.
    const two = await signIn(admin);
    const secondSecret = secretFrom((await enrol(two.challengeId).expect(200)).body);
    for (let total = CHALLENGE_MAX_ATTEMPTS + 1; total < MFA_MAX_ATTEMPTS; total += 1) {
      const response = await confirm(two.challengeId, Phone.wrongCode(secondSecret));
      expect(response.status, `wrong code ${total} overall`).toBe(401);
    }
    const locked = await confirm(two.challengeId, Phone.wrongCode(secondSecret));
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('account_locked');
    expect(locked.body.retryAt).toBeDefined();
    expect(locked.body.timeZone).toBeDefined();

    // Locked means locked, on every route that accepts a second factor.
    const three = await signIn(admin);
    const restarted = await enrol(three.challengeId);
    if (restarted.status === 200) {
      const thirdSecret = secretFrom(restarted.body);
      const correct = await confirm(three.challengeId, await admin.phone.code(thirdSecret));
      expect(correct.status, 'a locked user confirmed a factor').toBe(429);
      expect(correct.body.code).toBe('account_locked');
    } else {
      expect(restarted.status).toBe(429);
    }
    expect((await verify(three.challengeId, '123456')).status).toBe(429);
  });

  it('locks step-up attempts on the same per-user counter as the sign-in second factor', async () => {
    const admin = await enrolledAdmin();
    const auth = bearer(admin.accessToken);

    // Four wrong at sign-in...
    const challenge = await signIn(admin);
    for (let attempt = 1; attempt < CHALLENGE_MAX_ATTEMPTS; attempt += 1) {
      expect((await verify(challenge.challengeId, Phone.wrongCode(admin.secret))).status).toBe(401);
    }

    // ...then wrong at step-up, until the tenth overall.
    for (let total = CHALLENGE_MAX_ATTEMPTS; total < MFA_MAX_ATTEMPTS; total += 1) {
      const response = await request(server())
        .post(ME_TOTP)
        .set(auth)
        .send({ code: Phone.wrongCode(admin.secret) });
      expect(response.status, `wrong code ${total} overall`).toBe(401);
      expect(response.body.code).toBe('mfa_code_invalid');
    }
    const locked = await request(server())
      .post(ME_TOTP)
      .set(auth)
      .send({ code: Phone.wrongCode(admin.secret) });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('account_locked');

    // A correct code changes nothing while locked, here or at sign-in.
    const correct = await request(server())
      .post(ME_TOTP)
      .set(auth)
      .send({ code: await admin.phone.code(admin.secret) });
    expect(correct.status).toBe(429);
    expect(JSON.stringify(correct.body)).not.toMatch(/otpauth/);
    expect((await signInWithTotp(admin, admin.secret)).status).toBe(429);
  });

  // --- existence ---------------------------------------------------------------

  it('reveals nothing about who exists through the new endpoints (CLAUDE.md 6.4)', async () => {
    const admin = await newAdmin();
    const real = await signIn(admin);
    const [realTenant] = real.challengeId.split('.');

    // Forged challenges: a real tenant with a random id, the admin's own
    // tenant with a random id, an unknown tenant, and garbage. One answer.
    const forged = [
      `${TENANT_A}.${randomUUID()}`,
      `${realTenant}.${randomUUID()}`,
      `${randomUUID()}.${randomUUID()}`,
      'not-a-challenge',
    ];
    for (const send of [enrol, (id: string) => confirm(id, '123456')]) {
      const responses = await Promise.all(forged.map((id) => send(id)));
      for (const response of responses) {
        expect(response.status).toBe(401);
        expect(response.body).toEqual(responses[0]?.body);
        expect(response.body.code).toBe('mfa_challenge_invalid');
      }
    }

    // Enrolment cannot be addressed by identity at all: a body naming a real
    // address and one naming nobody are refused identically.
    const byRealEmail = await request(server())
      .post(ENROL)
      .send({ tenantSlug: admin.slug, email: admin.email });
    const byUnknownEmail = await request(server())
      .post(ENROL)
      .send({ tenantSlug: admin.slug, email: `nobody.${RUN}@mfa-enrol.test` });
    expect(byRealEmail.status).toBe(400);
    expect(byUnknownEmail.status).toBe(byRealEmail.status);
    expect(byUnknownEmail.body).toEqual(byRealEmail.body);

    // Session-bound routes: one uninformative 401 for a token that is not real.
    const bogus = bearer('ksw_s1_thisIsNotARealSessionTokenAtAll000000000');
    const unauthenticated = [
      await request(server()).get(ME_MFA).set(bogus),
      await request(server()).post(ME_TOTP).set(bogus).send({ code: '123456' }),
      await request(server()).post(ME_TOTP_CONFIRM).set(bogus).send({ code: '123456' }),
      await request(server()).post(ME_BACKUP_CODES).set(bogus).send({ code: '123456' }),
    ];
    for (const response of unauthenticated) {
      expect(response.status).toBe(401);
      expect(response.body.code).toBe('not_authenticated');
      expect(response.body).toEqual(unauthenticated[0]?.body);
    }
  });
});
