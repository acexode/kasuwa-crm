import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  dummyPasswordHash,
  HashingOverloadedError,
  hashRateLimitKey,
  hashSessionToken,
  matchTotpStep,
  newSessionToken,
  verifyPassword,
} from '@kasuwa/auth-crypto';
import type { KeyProvider } from '@kasuwa/auth-crypto';
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
import { AUTH_PG_POOL } from './auth-database.module';
import {
  accountLocked,
  AuthError,
  invalidCredentials,
  mfaAlreadyEnrolled,
  mfaChallengeExpired,
  mfaChallengeInvalid,
  mfaCodeInvalid,
  mfaMethodUnavailable,
  notImplemented,
  signInUnavailable,
  ssoDomainNotFound,
} from './auth.errors';
import { AUTH_POLICY, type AuthPolicy } from './auth.policy';
import { KEY_PROVIDER } from './key-provider.token';
import { resolveTotpSecret, type MfaSecretRow } from './mfa-secret';
import {
  confirmPendingTotp,
  consumeBackupCode,
  countUnusedBackupCodes,
  findPendingTotp,
  hasConfirmedFactor,
  issueBackupCodes,
  matchBackupCode,
  matchTotp,
  otpauthUri,
  startTotpEnrolment,
} from './mfa-store';
import {
  formatChallengeId,
  parseChallengeId,
  type ChallengeReference,
} from './challenge-id';
import type {
  MfaChallengeInput,
  MfaChallengeResponse,
  MfaEnrolConfirmInput,
  MfaEnrolInput,
  MfaVerifyInput,
  SessionResponse,
  SessionWithBackupCodes,
  TotpEnrolmentStarted,
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
 *
 * TWO POOLS, AND WHICH ONE IS WHICH (T-0049, D-P16, ADR-0013). Every
 * transaction that WRITES an auth table (the five identity tables and
 * `auth_rate_limit`) runs on `authPool`, which logs in as `kasuwa_auth`, the
 * only role holding those writes since migration 0024. Since T-0157 it also
 * runs every read of a SECRET: sign-in's phase one joins `user_credential`, and
 * migration 0046 took `kasuwa_app`'s SELECT on credential hashes and MFA
 * secrets away, so the app pool cannot read them at all. `appPool`
 * (`kasuwa_app`) is used for exactly one read:
 *
 *   * `app.resolve_session` in sign-out, the SECURITY DEFINER read that is
 *     granted to `kasuwa_app` only; the auth role is not given a second door
 *     around RLS for the sake of one revoke.
 *
 * Writing any of the six tables through `appPool` fails with 42501 by design,
 * and so does reading a secret column from it.
 */
@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    @Inject(PG_POOL) private readonly appPool: Pool,
    @Inject(AUTH_PG_POOL) private readonly authPool: Pool,
    @Inject(AUTH_POLICY) private readonly policy: AuthPolicy,
    @Inject(KEY_PROVIDER) private readonly keyProvider: KeyProvider,
  ) {}

  /**
   * Computes the dummy hash before the first request, not during it.
   *
   * Left lazy, the first unknown-user sign-in after boot paid for TWO argon2
   * tasks (make the dummy, then verify against it) where a known user pays for
   * one — a timing difference — and was the one request that could meet a full
   * queue on the dummy rather than on the verify. Awaited, so the API does not
   * listen with a cold cache. A failure is swallowed: refusing to boot over it
   * would be worse than the lazy path, which retries on next use.
   */
  async onModuleInit(): Promise<void> {
    await dummyPasswordHash().catch(() => undefined);
  }

  /**
   * First factor. Returns a challenge; never a session.
   *
   * THREE PHASES, AND THE SHAPE IS THE POINT. argon2id runs in phase two, with
   * no database connection held.
   *
   * It used to run inside a single `withAuthTransaction`, which meant every
   * sign-in pinned a pooled `pg` client for the whole ~86 ms of hashing — and
   * for however long it queued behind other hashes before that. With a pool of
   * ten, about a dozen concurrent sign-ins owned every connection in the
   * process and **all other tenant traffic in the cell blocked on
   * `pool.connect()`** until they drained. No account and no valid workspace
   * were needed: unknown slugs do the same argon2 work by design, which is what
   * makes the timing equal and is exactly what made this reachable.
   *
   * Splitting it costs two short transactions instead of one long one, and
   * costs nothing in correctness: the lock read is advisory either way, and
   * `registerAuthFailure` is atomic in a single statement, so nothing here
   * depended on the read and the write sharing a snapshot.
   *
   * What must NOT change: both branches still do the same argon2 work, against
   * a dummy hash when there is no account, and phase three runs for the unknown
   * workspace exactly as it does for a real one.
   */
  async signIn(input: SignInInput): Promise<MfaChallengeResponse> {
    // Keyed on the slug and address AS TYPED, before anything is resolved.
    // This is the whole of the fix for workspace-slug enumeration: there is no
    // branch where a real workspace has a counter and a fake one does not.
    const rateKey = hashRateLimitKey('signin', input.tenantSlug, input.email);

    // --- phase one: read, then let the connection go ----------------------
    // On the AUTH pool (T-0157): the account lookup joins `user_credential`, a
    // secret `kasuwa_app` can no longer read (migration 0046). It writes
    // nothing here. A real workspace and a fake one take exactly the same
    // path, so an exhausted auth pool is the same 503 for both and no branch
    // can block on a lock while the other answers 401 (T-0045's no-oracle
    // rule).
    const prepared = await withAuthTransaction(
      this.authPool,
      { tenantSlug: input.tenantSlug },
      async (tx) => ({
        locked: await this.activeLock(tx, rateKey, this.signInLimits()),
        // `account` is null both when the workspace does not resolve and when
        // the address is unknown within it. The two are not distinguished
        // anywhere below, including in how much work is done.
        account: hasTenant(tx) ? await this.findAccount(tx, input.email) : null,
      }),
    );

    if (prepared.locked !== null) {
      // A locked identifier is refused without hashing. That is deliberate and
      // it is not a timing oracle: reaching a lockout takes five failures
      // against that same identifier, so anyone who can observe the difference
      // already knows the answer it would give.
      throw prepared.locked;
    }

    // --- phase two: the expensive part, holding nothing --------------------
    // No connection, and since T-0013 not the event loop either: the verify
    // runs on a worker thread and this awaits a message. Unknown-user and
    // known-user verifies share that one pool and queue, with the same
    // parameters, so where the work runs cannot differ between them.
    //
    // The dummy hash is fetched INSIDE `verify`, under the same 503 mapping:
    // when its cache is cold and the queue is full, an unknown user must be
    // refused exactly as a known user is, not with a 500 of its own.
    const passwordMatches = await this.verify(
      prepared.account?.passwordHash ?? null,
      input.password,
    );

    // --- phase three: record what happened --------------------------------
    // On the AUTH pool: the failure counter (auth_rate_limit), the challenge
    // and the cleared failures are writes that only kasuwa_auth may make
    // (migration 0024 revokes all six tables' writes from kasuwa_app).
    return this.commitThenFail(
      withAuthTransaction(this.authPool, { tenantSlug: input.tenantSlug }, async (tx) => {
        const account = prepared.account;

        // Status is checked here rather than in the query so that a disabled
        // user costs exactly as much as an active one.
        if (!passwordMatches || account === null || account.status !== 'active') {
          return this.failFirstFactor(tx, rateKey);
        }
        if (!hasTenant(tx)) {
          // The workspace resolved in phase one and does not now — it was
          // suspended in between. Refuse, in the one shape everything else
          // refuses in.
          return invalidCredentials(null);
        }

        // A correct password clears the counter. Four typos across a week must
        // not lock somebody out on the fifth.
        await clearAuthFailures(tx, rateKey);

        return this.openChallenge(tx, account.id);
      }),
    );
  }

  /**
   * Verifies a password, turning a refusal to do the work into a 503.
   *
   * `HashingOverloadedError` means the hashing queue was full, which is load
   * shedding and not an authentication decision. Answering 401 would say the
   * credentials were wrong when they were never checked — misleading to a real
   * user, and a cheap oracle to an attacker, because a shed request comes back
   * far faster than a hashed one.
   *
   * `hash === null` means there is no usable credential (no workspace, no
   * account, or no password set), and the dummy hash is verified instead. That
   * lookup is inside the same try: the dummy can itself be refused for
   * overload, and both branches must answer with the same 503.
   */
  private async verify(hash: string | null, password: string): Promise<boolean> {
    try {
      return await verifyPassword(hash ?? (await dummyPasswordHash()), password);
    } catch (error) {
      if (error instanceof HashingOverloadedError) {
        throw signInUnavailable();
      }
      throw error;
    }
  }

  /**
   * Re-issues or switches the second factor.
   *
   * `totp` and `backup_code` are implemented. Neither sends anything — the
   * authenticator app holds the secret and the user holds the codes — so this
   * records which method the challenge expects and describes it. `sms` needs a
   * channel provider that does not exist yet (Agent 5, M8) and stays 501.
   *
   * Switching to `backup_code` needs at least one unused code; otherwise it is
   * `mfa_method_unavailable`. That answer is only available to someone holding
   * a live challenge, who has already presented this user's password.
   */
  async reissueChallenge(input: MfaChallengeInput): Promise<MfaChallengeResponse> {
    if (input.method === 'sms') {
      throw notImplemented();
    }
    const method = input.method;

    const reference = parseChallengeId(input.challengeId);
    if (reference === null) {
      throw mfaChallengeInvalid();
    }

    return this.commitThenFail(
      withAuthTransaction(this.authPool, { tenantId: reference.tenantId }, async (tx) => {
        if (!hasTenant(tx)) {
          return mfaChallengeInvalid();
        }
        const challenge = await this.findOpenChallenge(tx, reference.challengeId);
        if (challenge instanceof AuthError) {
          return challenge;
        }
        if (
          method === 'backup_code' &&
          (await countUnusedBackupCodes(tx, tx.tenantId, challenge.userId)) === 0
        ) {
          return mfaMethodUnavailable();
        }
        await tx.query(
          `UPDATE auth_challenge
              SET method = $3
            WHERE tenant_id = $1 AND id = $2 AND consumed_at IS NULL`,
          [tx.tenantId, reference.challengeId, method],
        );
        return this.describeChallenge(
          tx,
          challenge.userId,
          reference,
          challenge.expiresAt,
          method,
        );
      }),
    );
  }

  // --- enrolment, bound to a sign-in challenge (T-0012) ----------------------
  //
  // No session exists yet: holding the challenge id is the proof of the first
  // factor, exactly as it is for /auth/mfa. These two routes are ONLY for a
  // user with no confirmed factor. For anybody else a challenge proves a
  // password and nothing more, and a password must never be enough to put a
  // new factor in place of an existing one — that is the classic bypass.
  //
  // Wrong codes go through `failSecondFactor`: the same per-challenge (5) and
  // per-user (10) counters as /auth/mfa, so enrolment is not a side door
  // around the T-0001 brute-force controls.

  /** POST /auth/mfa/enrol — a fresh pending secret, shown once. */
  async startEnrolment(input: MfaEnrolInput): Promise<TotpEnrolmentStarted> {
    const reference = parseChallengeId(input.challengeId);
    if (reference === null) {
      throw mfaChallengeInvalid();
    }

    return this.commitThenFail(
      withAuthTransaction(this.authPool, { tenantId: reference.tenantId }, async (tx) => {
        if (!hasTenant(tx)) {
          return mfaChallengeInvalid();
        }
        const challenge = await this.findOpenChallenge(tx, reference.challengeId);
        if (challenge instanceof AuthError) {
          return challenge;
        }
        const mfaKey = hashRateLimitKey('mfa', tx.tenantId, challenge.userId);
        const locked = await this.activeLock(tx, mfaKey, this.mfaLimits());
        if (locked !== null) {
          return locked;
        }
        const account = await this.accountLabel(tx, challenge.userId);
        // `first`: under the user lock, refuses (writing nothing) when a
        // confirmed factor exists, so the check and the insert cannot be
        // separated by a racing request.
        const secret = await startTotpEnrolment(
          tx,
          this.keyProvider,
          tx.tenantId,
          challenge.userId,
          'first',
        );
        if (secret === null) {
          return mfaAlreadyEnrolled();
        }
        return {
          otpauthUri: otpauthUri(account, secret),
          secret,
          expiresAt: challenge.expiresAt.toISOString(),
        };
      }),
    );
  }

  /**
   * POST /auth/mfa/enrol/confirm — the ONLY way a pending factor becomes
   * usable at sign-in. Confirms the factor, consumes the challenge, issues the
   * session and the backup codes, in one transaction.
   */
  async confirmEnrolment(input: MfaEnrolConfirmInput): Promise<SessionWithBackupCodes> {
    const reference = parseChallengeId(input.challengeId);
    if (reference === null) {
      throw mfaChallengeInvalid();
    }

    return this.commitThenFail(
      withAuthTransaction(this.authPool, { tenantId: reference.tenantId }, async (tx) => {
        if (!hasTenant(tx)) {
          return mfaChallengeInvalid();
        }
        const challenge = await this.findOpenChallenge(tx, reference.challengeId);
        if (challenge instanceof AuthError) {
          return challenge;
        }
        const mfaKey = hashRateLimitKey('mfa', tx.tenantId, challenge.userId);
        const locked = await this.activeLock(tx, mfaKey, this.mfaLimits());
        if (locked !== null) {
          return locked;
        }
        if (await hasConfirmedFactor(tx, tx.tenantId, challenge.userId)) {
          // A password-holder cannot slip a factor in through confirm either.
          return mfaAlreadyEnrolled();
        }

        const pending = await findPendingTotp(
          tx,
          tx.tenantId,
          challenge.userId,
          this.policy.challengeMinutes,
        );
        const match = await matchTotp(this.keyProvider, tx.tenantId, pending, input.code);
        if (pending === undefined || match.kind !== 'match') {
          return this.failSecondFactor(tx, reference, mfaKey, challenge.userId);
        }

        // Lock order as everywhere else: auth_rate_limit, the user row,
        // user_mfa_factor, auth_challenge.
        await clearAuthFailures(tx, mfaKey);
        // `first`: promotes the pending row only. It never deletes a confirmed
        // factor, and it re-checks under the user lock that none exists.
        const outcome = await confirmPendingTotp(
          tx,
          tx.tenantId,
          challenge.userId,
          pending.id,
          match.step,
          'first',
        );
        if (outcome.kind === 'already_enrolled') {
          // A factor was confirmed between the check above and the lock.
          // Thrown, so nothing here (including the cleared counter) commits.
          throw mfaAlreadyEnrolled();
        }
        const claimed =
          outcome.kind !== 'confirmed'
            ? []
            : await tx.query<{ id: string }>(
                `UPDATE auth_challenge
                    SET consumed_at = now()
                  WHERE tenant_id = $1 AND id = $2 AND consumed_at IS NULL
              RETURNING id`,
                [tx.tenantId, reference.challengeId],
              );
        if (claimed.length === 0) {
          // A racing confirm won. THROWN, so this transaction rolls back
          // whole: it must not leave a factor confirmed with no session.
          throw mfaChallengeInvalid();
        }

        const session = await this.issueSession(tx, challenge.userId);
        if (session instanceof AuthError) {
          return session;
        }
        const backupCodes = await issueBackupCodes(
          tx,
          this.keyProvider,
          tx.tenantId,
          challenge.userId,
        );
        return { ...session, backupCodes };
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
      withAuthTransaction(this.authPool, { tenantId: reference.tenantId }, async (tx) => {
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

        if (challenge.method === 'backup_code') {
          return this.verifyBackupCode(tx, reference, mfaKey, challenge.userId, input.code);
        }

        const factors = await tx.query<MfaSecretRow & { last_used_step: string | null }>(
          `SELECT id, secret, secret_ciphertext, secret_wrapped_key, secret_key_id,
                  secret_algorithm, last_used_step
             FROM user_mfa_factor
            WHERE tenant_id = $1 AND user_id = $2 AND type = 'totp' AND confirmed_at IS NOT NULL`,
          [tx.tenantId, challenge.userId],
        );

        const factor = factors[0];
        // The secret is read HERE, once, into a local, and goes no further —
        // see the note in mfa-secret.ts. `resolveTotpSecret` THROWS if a row
        // exists but cannot be decrypted; that propagates out of the
        // transaction rather than being folded into "wrong code" or, far
        // worse, "no factor enrolled". A sign-in that cannot read the second
        // factor must fail, loudly.
        const secret =
          factor === undefined
            ? undefined
            : await resolveTotpSecret(this.keyProvider, tx.tenantId, factor);
        const step = secret === undefined ? null : matchTotpStep(secret, input.code);
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
        // `user_mfa_factor`, then `auth_challenge`. Clearing before the claim
        // means a request that then loses a race has cleared a counter it was
        // entitled to clear anyway — it did present a correct code.
        await clearAuthFailures(tx, mfaKey);

        // CLAIM the step, and believe the row count.
        //
        // The guard `last_used_step < $3` was already here; what was missing
        // was checking whether it matched anything. Two verifies arriving
        // together with the same live code both passed the in-memory
        // `alreadyUsed` check, both ran this UPDATE, and the second one
        // silently updated nothing and carried on to a session. "A code is
        // usable once" was true sequentially and false under concurrency,
        // which is the only condition an attacker with a shoulder-surfed code
        // would ever create.
        const claimedStep = await tx.query<{ id: string }>(
          `UPDATE user_mfa_factor
              SET last_used_step = $3, updated_at = now()
            WHERE tenant_id = $1
              AND id = $2
              AND (last_used_step IS NULL OR last_used_step < $3)
        RETURNING id`,
          [tx.tenantId, factor.id, step],
        );
        if (claimedStep.length === 0) {
          // Somebody else used this code first. Same answer as any other
          // rejected code.
          return this.failSecondFactor(tx, reference, mfaKey, challenge.userId);
        }

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

        return this.issueSession(tx, challenge.userId);
      }),
    );
  }

  /**
   * The second factor as a backup code (the lost-device path, T-0012).
   *
   * Same shape as the TOTP path above, and deliberately the same counters: a
   * wrong backup code is a wrong second factor, burns an attempt against the
   * challenge and counts towards the per-user lock. A code is consumed by a
   * conditional UPDATE, so it establishes exactly one session however many
   * requests race with it.
   */
  private async verifyBackupCode(
    tx: ResolvedAuthTx,
    reference: ChallengeReference,
    mfaKey: Buffer,
    userId: string,
    code: string,
  ): Promise<SessionResponse | AuthError> {
    const codeId = await matchBackupCode(tx, this.keyProvider, tx.tenantId, userId, code);
    if (codeId === null) {
      return this.failSecondFactor(tx, reference, mfaKey, userId);
    }

    await clearAuthFailures(tx, mfaKey);
    if (!(await consumeBackupCode(tx, tx.tenantId, userId, codeId))) {
      // Used by a racing request first. The same answer as any other wrong code.
      return this.failSecondFactor(tx, reference, mfaKey, userId);
    }

    const claimed = await tx.query<{ id: string }>(
      `UPDATE auth_challenge
          SET consumed_at = now()
        WHERE tenant_id = $1 AND id = $2 AND consumed_at IS NULL
    RETURNING id`,
      [tx.tenantId, reference.challengeId],
    );
    if (claimed.length === 0) {
      // The challenge was consumed underneath us. THROWN, not returned, so the
      // transaction rolls back and the backup code is not spent on a sign-in
      // that did not happen. Nothing else here needs to survive.
      throw mfaChallengeInvalid();
    }
    return this.issueSession(tx, userId);
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
    // The token is resolved on the app pool, exactly as the guard resolves it
    // (app.resolve_session is granted to kasuwa_app only); the revoke is a
    // write, so it runs on the auth pool.
    const identity = await resolveSessionIdentity(this.appPool, hashSessionToken(token));
    if (identity === null) {
      return;
    }
    await withAuthTransaction(this.authPool, { tenantId: identity.tenantId }, async (tx) => {
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
    method: 'totp' | 'backup_code' = 'totp',
  ): Promise<MfaChallengeResponse> {
    const enrolled = await tx.query<{ type: string }>(
      `SELECT type
         FROM user_mfa_factor
        WHERE tenant_id = $1 AND user_id = $2 AND confirmed_at IS NOT NULL`,
      [tx.tenantId, userId],
    );
    const hasTotp = enrolled.some((factor) => factor.type === 'totp');
    // A count, never a code or a hash.
    const backupCodesLeft = await countUnusedBackupCodes(tx, tx.tenantId, userId);

    return {
      mfaRequired: true,
      challengeId: formatChallengeId(reference),
      method,
      methods: [
        { type: 'totp', available: hasTotp, deliveryHint: null },
        // Specified in the contract so the screen can render the fallback it
        // is designed with; unavailable until a channel provider exists.
        { type: 'sms', available: false, deliveryHint: null },
        { type: 'backup_code', available: backupCodesLeft > 0, deliveryHint: null },
      ],
      enrolmentRequired: !hasTotp,
      expiresAt: expiresAt.toISOString(),
      resendAvailableAt: null,
    };
  }

  private async findOpenChallenge(
    tx: ResolvedAuthTx,
    challengeId: string,
  ): Promise<
    { userId: string; attemptCount: number; expiresAt: Date; method: string } | AuthError
  > {
    const rows = await tx.query<{
      user_id: string;
      attempt_count: number;
      expires_at: Date;
      consumed_at: Date | null;
      method: string;
    }>(
      `SELECT user_id, attempt_count, expires_at, consumed_at, method
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
    return {
      userId: row.user_id,
      attemptCount: row.attempt_count,
      expiresAt: row.expires_at,
      method: row.method,
    };
  }

  /** The account name an authenticator app shows beside the code: the user's address. */
  private async accountLabel(tx: ResolvedAuthTx, userId: string): Promise<string> {
    const rows = await tx.query<{ email: string }>(
      `SELECT email FROM "user" WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, userId],
    );
    return rows[0]?.email ?? userId;
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
