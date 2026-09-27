import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  dummyPasswordHash,
  hashRateLimitKey,
  hashSessionToken,
  matchTotpStep,
  newSessionToken,
  verifyPassword,
} from '@kasuwa/auth-crypto';
import {
  clearAuthFailures,
  hasTenant,
  readAuthLock,
  registerAuthFailure,
  resolveSessionIdentity,
  withAuthTransaction,
} from '@kasuwa/db';
import type { AuthTx, RateLimitPolicy, ResolvedAuthTx } from '@kasuwa/db';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import {
  accountLocked,
  AuthError,
  invalidCredentials,
  mfaChallengeExpired,
  mfaChallengeInvalid,
  mfaCodeInvalid,
  notImplemented,
  ssoDomainNotFound,
} from './auth.errors';
import { AUTH_POLICY, type AuthPolicy } from './auth.policy';
import {
  formatChallengeId,
  parseChallengeId,
  type ChallengeReference,
} from './challenge-id';
import type {
  MfaChallengeInput,
  MfaChallengeResponse,
  MfaVerifyInput,
  SessionResponse,
  SignInInput,
  SsoLookupInput,
} from './auth.schemas';

/**
 * Authentication: establishing WHO the caller is.
 *
 * Read the tenancy comment in `withAuthTransaction` (@kasuwa/db) before
 * changing anything here. Nothing in this service decides what anyone can
 * reach. It reads and writes five identity tables and issues an opaque token;
 * scope is still resolved from `user_programme` inside
 * `withTenantTransaction`, on every subsequent request, exactly as it was under
 * the stub.
 *
 * Five properties are load-bearing. Each has a test that fails without it, and
 * three of them are here because a security review found them missing:
 *
 *   1. Unknown workspace, unknown email, wrong password and disabled user are
 *      one response and one timing profile. Every path that can fail does the
 *      same argon2id work against a dummy hash, and — since the review — takes
 *      the same route through the same transaction, so the equality is
 *      structural rather than maintained by hand.
 *   2. The first factor issues a challenge and nothing else.
 *   3. Rate limiting is keyed on what the CALLER SUBMITTED, never on resolved
 *      identity, so a workspace that does not exist counts down and locks
 *      exactly like one that does.
 *   4. Every counter is incremented by Postgres in one statement. Read-modify-
 *      write in application code does not survive concurrency, and the failure
 *      mode is silent: the threshold is simply never reached.
 *   5. A challenge is consumed conditionally, so it mints exactly one session
 *      however many requests race for it.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUTH_POLICY) private readonly policy: AuthPolicy,
  ) {}

  /** First factor. Returns a challenge; never a session. */
  async signIn(input: SignInInput): Promise<MfaChallengeResponse> {
    // Keyed on the slug and address AS TYPED, before anything is resolved.
    // This is the whole of the fix for workspace-slug enumeration: there is no
    // branch where a real workspace has a counter and a fake one does not.
    const rateKey = hashRateLimitKey('signin', input.tenantSlug, input.email);

    return this.commitThenFail(
      withAuthTransaction(this.pool, { tenantSlug: input.tenantSlug }, async (tx) => {
        const locked = await this.activeLock(tx, rateKey, this.signInLimits());
        if (locked !== null) {
          return locked;
        }

        // `account` is null both when the workspace does not resolve and when
        // the address is unknown within it. The two are not distinguished
        // anywhere below, including in how much work is done.
        const account = hasTenant(tx) ? await this.findAccount(tx, input.email) : null;
        const hash = account?.passwordHash ?? (await dummyPasswordHash());
        const passwordMatches = await verifyPassword(hash, input.password);

        // Status is checked here rather than in the query so that a disabled
        // user costs exactly as much as an active one.
        if (!passwordMatches || account === null || account.status !== 'active') {
          return this.failFirstFactor(tx, rateKey);
        }

        // A correct password clears the counter. Four typos across a week must
        // not lock somebody out on the fifth.
        await clearAuthFailures(tx, rateKey);

        return this.openChallenge(tx as ResolvedAuthTx, account.id);
      }),
    );
  }

  /**
   * Re-issues or switches the second factor.
   *
   * Only `totp` is implemented. There is nothing to send for TOTP — the
   * authenticator app already holds the secret — so this returns the existing
   * challenge unchanged. SMS and backup codes need a channel provider that does
   * not exist yet and are an explicit non-goal of T-0001.
   */
  async reissueChallenge(input: MfaChallengeInput): Promise<MfaChallengeResponse> {
    if (input.method !== 'totp') {
      throw notImplemented();
    }

    const reference = parseChallengeId(input.challengeId);
    if (reference === null) {
      throw mfaChallengeInvalid();
    }

    return this.commitThenFail(
      withAuthTransaction(this.pool, { tenantId: reference.tenantId }, async (tx) => {
        if (!hasTenant(tx)) {
          return mfaChallengeInvalid();
        }
        const challenge = await this.findOpenChallenge(tx, reference.challengeId);
        if (challenge instanceof AuthError) {
          return challenge;
        }
        return this.describeChallenge(tx, challenge.userId, reference, challenge.expiresAt);
      }),
    );
  }

  /** Second factor. The only place a session token is issued. */
  async verifyMfa(input: MfaVerifyInput): Promise<SessionResponse> {
    const reference = parseChallengeId(input.challengeId);
    if (reference === null) {
      throw mfaChallengeInvalid();
    }

    return this.commitThenFail(
      withAuthTransaction(this.pool, { tenantId: reference.tenantId }, async (tx) => {
        if (!hasTenant(tx)) {
          return mfaChallengeInvalid();
        }

        const challenge = await this.findOpenChallenge(tx, reference.challengeId);
        if (challenge instanceof AuthError) {
          return challenge;
        }

        // A second, independent throttle on the user, not the challenge.
        //
        // The per-challenge counter alone is not a control: an attacker who
        // already has the password can open a fresh challenge whenever the old
        // one burns, and guess for as long as they like. This is the counter
        // that actually bounds a stolen-password attack, and it is why the
        // challenge cap in openChallenge exists as well.
        const mfaKey = hashRateLimitKey('mfa', tx.tenantId, challenge.userId);
        const locked = await this.activeLock(tx, mfaKey, this.mfaLimits());
        if (locked !== null) {
          return locked;
        }

        const factors = await tx.query<{ id: string; secret: string; last_used_step: string | null }>(
          `SELECT id, secret, last_used_step
             FROM user_mfa_factor
            WHERE tenant_id = $1 AND user_id = $2 AND type = 'totp' AND confirmed_at IS NOT NULL`,
          [tx.tenantId, challenge.userId],
        );

        const factor = factors[0];
        const step = factor === undefined ? null : matchTotpStep(factor.secret, input.code);
        // A code is usable once. Accepting it for the whole ninety seconds it
        // stays arithmetically valid means a code seen over a shoulder or in a
        // phishing form can be replayed while the victim is still typing.
        const alreadyUsed =
          step !== null &&
          factor?.last_used_step != null &&
          step <= Number(factor.last_used_step);

        if (alreadyUsed) {
          // A replay is refused, but it is NOT counted as a wrong guess.
          //
          // The commonest cause by far is the user's own browser: a
          // double-submitted form, or a retry after a timeout, sending the code
          // that was just accepted. Counting those made a person doing nothing
          // wrong six clicks away from being locked out of their own second
          // factor — a control meant for an attacker, aimed at the victim.
          //
          // `mfa_challenge_invalid` rather than `mfa_code_invalid`, because
          // "that code did not match" is not what happened and the screen
          // should send them back to sign in rather than invite another guess.
          return mfaChallengeInvalid();
        }

        if (factor === undefined || step === null) {
          return this.failSecondFactor(tx, reference, mfaKey, challenge.userId);
        }

        // Same lock order as every other path: `auth_rate_limit` first, then
        // `auth_challenge`. Clearing before the consume means a request that
        // then loses the consume race has cleared a counter it was entitled to
        // clear anyway — it did present a correct code.
        await clearAuthFailures(tx, mfaKey);

        // Consume the challenge CONDITIONALLY. `findOpenChallenge` checked
        // `consumed_at IS NULL` a few statements ago, and under READ COMMITTED
        // that check is worthless by itself: N racing requests with the same
        // valid code all pass it and all issue a session. The `AND consumed_at
        // IS NULL ... RETURNING` is what makes one challenge mint exactly one
        // session, and the row count is the only thing that proves it.
        const claimed = await tx.query<{ id: string }>(
          `UPDATE auth_challenge
              SET consumed_at = now()
            WHERE tenant_id = $1
              AND id = $2
              AND consumed_at IS NULL
        RETURNING id`,
          [tx.tenantId, reference.challengeId],
        );
        if (claimed.length === 0) {
          return mfaChallengeInvalid();
        }

        await tx.query(
          `UPDATE user_mfa_factor
              SET last_used_step = $3, updated_at = now()
            WHERE tenant_id = $1
              AND id = $2
              AND (last_used_step IS NULL OR last_used_step < $3)`,
          [tx.tenantId, factor.id, step],
        );

        return this.issueSession(tx, challenge.userId);
      }),
    );
  }

  /**
   * Revokes a session. Idempotent and silent about whether the token was real:
   * a sign-out that reported "no such session" would tell somebody holding a
   * stolen token whether it is still live.
   */
  async signOut(token: string | null): Promise<void> {
    if (token === null) {
      return;
    }
    const identity = await resolveSessionIdentity(this.pool, hashSessionToken(token));
    if (identity === null) {
      return;
    }
    await withAuthTransaction(this.pool, { tenantId: identity.tenantId }, async (tx) => {
      if (!hasTenant(tx)) {
        return;
      }
      await tx.query(
        `UPDATE auth_session
            SET revoked_at = now()
          WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`,
        [identity.tenantId, identity.sessionId],
      );
    });
  }

  /**
   * SSO connection for an email domain.
   *
   * No connection can be configured yet — SAML/OIDC is a later M2 task — so
   * this always reports "not found", which is exactly the state `P01/1c`
   * renders. The 404 is not an existence leak: the domain is public
   * information the caller supplied, and the answer says nothing about whether
   * any account exists.
   */
  async lookupSso(_input: SsoLookupInput): Promise<never> {
    throw ssoDomainNotFound();
  }

  // --- internals ---------------------------------------------------------

  /**
   * Commits the transaction, then throws whatever went wrong.
   *
   * This is not a style choice, it is the bug that makes lockout work. Every
   * failure path here has a side effect that must survive: a failed sign-in
   * increments a counter, a wrong code burns an attempt against the challenge.
   * Throwing from inside `withAuthTransaction` rolls the whole transaction
   * back, which silently discards exactly the row that was meant to be a record
   * of the failure — so the counter never advances, nothing ever locks, and the
   * tests that check it pass for the wrong reason until somebody counts.
   *
   * So the callbacks RETURN an `AuthError` rather than throwing one. The
   * transaction commits, and the error is raised out here where it can no
   * longer undo anything. Anything that genuinely should not persist — a
   * malformed challenge id, an unimplemented method — is still thrown before
   * the transaction opens at all.
   */
  private async commitThenFail<T>(outcome: Promise<T | AuthError>): Promise<T> {
    const value = await outcome;
    if (value instanceof AuthError) {
      throw value;
    }
    return value;
  }

  private signInLimits(): RateLimitPolicy {
    return {
      maxAttempts: this.policy.lockoutMaxAttempts,
      windowMinutes: this.policy.lockoutWindowMinutes,
      lockMinutes: this.policy.lockoutMinutes,
    };
  }

  private mfaLimits(): RateLimitPolicy {
    return {
      maxAttempts: this.policy.mfaMaxAttempts,
      windowMinutes: this.policy.lockoutWindowMinutes,
      lockMinutes: this.policy.lockoutMinutes,
    };
  }

  private async activeLock(
    tx: AuthTx,
    keyHash: Buffer,
    limits: RateLimitPolicy,
  ): Promise<AuthError | null> {
    if (limits.maxAttempts === 0) {
      return null;
    }
    const state = await readAuthLock(tx, keyHash);
    return state?.lockedUntil == null ? null : accountLocked(state.lockedUntil, this.timeZone());
  }

  private async failFirstFactor(tx: AuthTx, keyHash: Buffer): Promise<AuthError> {
    if (this.policy.lockoutMaxAttempts === 0) {
      return invalidCredentials(null);
    }
    const state = await registerAuthFailure(tx, keyHash, this.signInLimits());
    if (state.lockedUntil !== null && state.lockedUntil.getTime() > Date.now()) {
      return accountLocked(state.lockedUntil, this.timeZone());
    }
    return invalidCredentials(
      Math.max(this.policy.lockoutMaxAttempts - state.failedCount, 0),
    );
  }

  private async failSecondFactor(
    tx: ResolvedAuthTx,
    reference: ChallengeReference,
    mfaKey: Buffer,
    _userId: string,
  ): Promise<AuthError> {
    // ORDER MATTERS, AND NOT FOR STYLE. `auth_rate_limit` is locked before
    // `auth_challenge`, here and everywhere else in this service.
    //
    // It used to be the other way round in this one method, while sign-in took
    // them in the opposite order — so a sign-in and a second-factor attempt for
    // the same user, arriving together, could each hold the row the other
    // wanted. Postgres detects that and aborts one of them, which rolls back
    // the transaction and with it the counter increment that was the whole
    // point. The visible symptom is not an error: it is a lockout that never
    // fires, a countdown stuck at its first value, and tests that fail
    // somewhere else entirely.
    const mfaState = await registerAuthFailure(tx, mfaKey, this.mfaLimits());

    // Postgres does the arithmetic. The first version read attempt_count,
    // added one in JavaScript and wrote the result back, so N concurrent
    // guesses against one challenge all read 0 and all wrote 1 — the burn never
    // fired and a single challenge accepted unlimited guesses.
    const bumped = await tx.query<{ attempt_count: number }>(
      `UPDATE auth_challenge
          SET attempt_count = attempt_count + 1
        WHERE tenant_id = $1 AND id = $2 AND consumed_at IS NULL
    RETURNING attempt_count`,
      [tx.tenantId, reference.challengeId],
    );

    const attempts = bumped[0]?.attempt_count;
    if (attempts === undefined) {
      // Consumed underneath us by a racing request. The failure above still
      // counts: it was a wrong code either way.
      return mfaChallengeInvalid();
    }

    if (mfaState.lockedUntil !== null && mfaState.lockedUntil.getTime() > Date.now()) {
      await this.burn(tx, reference);
      return accountLocked(mfaState.lockedUntil, this.timeZone());
    }

    if (attempts >= this.policy.challengeMaxAttempts) {
      await this.burn(tx, reference);
      return mfaChallengeInvalid();
    }

    return mfaCodeInvalid(Math.max(this.policy.challengeMaxAttempts - attempts, 0));
  }

  private async burn(tx: ResolvedAuthTx, reference: ChallengeReference): Promise<void> {
    await tx.query(
      `UPDATE auth_challenge SET consumed_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, reference.challengeId],
    );
  }

  /**
   * The zone a retry time is rendered in.
   *
   * `P01/1b` needs the zone with the time. It is the CELL's zone, one value for
   * the whole deployment, and that is deliberate on two counts. It cannot be
   * the tenant's, because deriving it from a tenant would make the lockout
   * response for a workspace that does not exist differ from one that does —
   * the review's point that the 429 discloses the hosting region. And the
   * server does not know the user's own zone; the browser does, and should
   * render `retryAt` in it.
   */
  private timeZone(): string {
    return this.policy.cellTimeZone;
  }

  private async findAccount(
    tx: ResolvedAuthTx,
    email: string,
  ): Promise<{ id: string; status: string; passwordHash: string | null } | null> {
    // RLS confines this to the resolved tenant, and the explicit tenant_id
    // predicate says so a second time. Two independent layers; a mistake in
    // one does not leak (CLAUDE.md section 2, rule 3).
    const rows = await tx.query<{ id: string; status: string; password_hash: string | null }>(
      `SELECT u.id, u.status, c.password_hash
         FROM "user" u
         LEFT JOIN user_credential c ON c.user_id = u.id AND c.tenant_id = u.tenant_id
        WHERE u.tenant_id = $1
          AND lower(u.email) = lower($2)`,
      [tx.tenantId, email],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { id: row.id, status: row.status, passwordHash: row.password_hash };
  }

  private async openChallenge(
    tx: ResolvedAuthTx,
    userId: string,
  ): Promise<MfaChallengeResponse> {
    // Cap how many challenges one user can have open at once.
    //
    // Without this, the per-challenge attempt counter is not a bound at all:
    // an attacker holding the password opens a thousand challenges and guesses
    // five times against each. Consuming the oldest rather than refusing the
    // newest means an attacker cannot use this to deny a legitimate user their
    // sign-in — the most recent challenge always works.
    await tx.query(
      `UPDATE auth_challenge
          SET consumed_at = now()
        WHERE tenant_id = $1
          AND user_id = $2
          AND consumed_at IS NULL
          AND id IN (
            SELECT id
              FROM auth_challenge
             WHERE tenant_id = $1
               AND user_id = $2
               AND consumed_at IS NULL
               AND expires_at > now()
             ORDER BY created_at DESC
            OFFSET $3
          )`,
      [tx.tenantId, userId, Math.max(this.policy.maxOpenChallenges - 1, 0)],
    );

    // Random (v4) rather than the time-ordered v7 used for business rows: a
    // challenge id is a short-lived secret handed to the client, and an id an
    // attacker can guess the neighbourhood of is a worse starting point than
    // one they cannot.
    const challengeId = randomUUID();
    const expiresAt = new Date(Date.now() + this.policy.challengeMinutes * 60_000);

    await tx.query(
      `INSERT INTO auth_challenge (id, tenant_id, user_id, method, expires_at)
       VALUES ($1, $2, $3, 'totp', $4)`,
      [challengeId, tx.tenantId, userId, expiresAt],
    );

    return this.describeChallenge(tx, userId, { tenantId: tx.tenantId, challengeId }, expiresAt);
  }

  private async describeChallenge(
    tx: ResolvedAuthTx,
    userId: string,
    reference: ChallengeReference,
    expiresAt: Date,
  ): Promise<MfaChallengeResponse> {
    const enrolled = await tx.query<{ type: string }>(
      `SELECT type
         FROM user_mfa_factor
        WHERE tenant_id = $1 AND user_id = $2 AND confirmed_at IS NOT NULL`,
      [tx.tenantId, userId],
    );
    const hasTotp = enrolled.some((factor) => factor.type === 'totp');

    return {
      mfaRequired: true,
      challengeId: formatChallengeId(reference),
      method: 'totp',
      methods: [
        { type: 'totp', available: hasTotp, deliveryHint: null },
        // Specified in the contract so the screen can render the fallbacks it
        // is designed with; unavailable until a channel provider exists.
        { type: 'sms', available: false, deliveryHint: null },
        { type: 'backup_code', available: false, deliveryHint: null },
      ],
      enrolmentRequired: !hasTotp,
      expiresAt: expiresAt.toISOString(),
      resendAvailableAt: null,
    };
  }

  private async findOpenChallenge(
    tx: ResolvedAuthTx,
    challengeId: string,
  ): Promise<{ userId: string; attemptCount: number; expiresAt: Date } | AuthError> {
    const rows = await tx.query<{
      user_id: string;
      attempt_count: number;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT user_id, attempt_count, expires_at, consumed_at
         FROM auth_challenge
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, challengeId],
    );

    const row = rows[0];
    if (row === undefined || row.consumed_at !== null) {
      return mfaChallengeInvalid();
    }
    if (row.expires_at.getTime() <= Date.now()) {
      // A distinct code, because holding the challenge id already proves the
      // password was right — telling this caller that their code timed out
      // reveals nothing they did not already know, and `P01/2b` needs it to
      // offer "Send a new code".
      return mfaChallengeExpired();
    }
    return { userId: row.user_id, attemptCount: row.attempt_count, expiresAt: row.expires_at };
  }

  private async issueSession(
    tx: ResolvedAuthTx,
    userId: string,
  ): Promise<SessionResponse | AuthError> {
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + this.policy.sessionHours * 3_600_000);

    await tx.query(
      `INSERT INTO auth_session (id, tenant_id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tx.tenantId, userId, hashSessionToken(token), expiresAt],
    );

    const rows = await tx.query<{ email: string; display_name: string; locale: string }>(
      `SELECT email, display_name, locale FROM "user" WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, userId],
    );
    const user = rows[0];
    if (user === undefined) {
      // Cannot happen: the challenge's foreign key guarantees the user. If it
      // ever does, refuse rather than issue a session for nobody.
      return mfaChallengeInvalid();
    }

    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresAt: expiresAt.toISOString(),
      user: {
        id: userId,
        tenantId: tx.tenantId,
        email: user.email,
        displayName: user.display_name,
        locale: user.locale,
      },
    };
  }
}
