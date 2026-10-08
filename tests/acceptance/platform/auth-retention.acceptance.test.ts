import 'reflect-metadata';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule, type AppModuleOptions } from '@kasuwa/api';
import { workerEnv } from '@kasuwa/config';
import * as db from '@kasuwa/db';
import { createPool, TENANT_A, TENANT_B, USER_A_AGENT_1, USER_B_AGENT_1 } from '@kasuwa/db';
import { reseed, withForcedScope } from '@kasuwa/testing';
import { Client, type Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { asUser, withAuthDatabase } from '../support/api';

/**
 * ACCEPTANCE — T-0045: auth-table retention, and pool exhaustion answered as 503.
 *
 * Written by Agent 12 for the lead before assignment (D-L23). Read the task file
 * and D-L56 first; this header says only what the suite pins and why.
 *
 * ========================================================================
 * PART 1 — RETENTION
 * ========================================================================
 *
 * THE INTERFACE THE BUILDER MUST PROVIDE
 *
 *     // exported from @kasuwa/db (beside the auth repository in src/auth.ts)
 *     pruneAuthTables(
 *       pool: Pool,                                // a kasuwa_app pool
 *       options: { now: Date; batchSize: number },
 *     ): Promise<{ authChallenge: number; authSession: number; authRateLimit: number }>
 *
 *   * ONE CALL IS ONE BOUNDED BATCH PER TABLE. It deletes at most `batchSize`
 *     rows from each table and returns how many it deleted from each. The
 *     worker job calls it again while any count equals `batchSize`. That is how
 *     "bounded batches" is observable from outside without parsing SQL: a call
 *     that loops internally until a table is empty returns more than
 *     `batchSize` and fails the batch test.
 *   * RETENTION, as the task states it:
 *       auth_challenge   expired more than 1 day ago        (expires_at < now - 1 day)
 *       auth_session     revoked more than 30 days ago, or expired more than 30 days ago
 *       auth_rate_limit  the failure window AND any lock have both lapsed
 *     The tests plant rows clearly on either side of each line (25 h vs 23 h,
 *     31 d vs 29 d, two days lapsed vs ten minutes old), so the exact cut-off
 *     inside those margins is the builder's.
 *   * IT RUNS ON A kasuwa_app POOL. `packages/db/sql/bootstrap.sql` says
 *     kasuwa_app is the role apps/worker uses, and the task says the job must
 *     not use a pool that bypasses RLS. So the pool this suite hands over is
 *     built from `inject('databaseUrl')` and nothing else.
 *
 * THE MECHANISM, AND WHY IT IS NOT THE ONE ADR-0009 NAMES
 *
 * ADR-0009's amendment (and migration 0004's header) say the sweep "must run as
 * kasuwa_migrator, which is BYPASSRLS". The task overrides that: no BYPASSRLS,
 * no migration URL in apps/worker, no third SECURITY DEFINER function
 * (CLAUDE.md 2.7). Against the policies as they stand today a kasuwa_app
 * connection can prune NOTHING across tenants:
 *
 *   auth_challenge, auth_session  USING (tenant_id = app.current_tenant_id())
 *   auth_rate_limit               USING (key_hash = app.current_rate_limit_key())
 *
 * A sweep knows neither the tenants (the `tenant` table is itself policied) nor
 * the keys. So the builder has to add something. Safe options exist without a
 * definer function — for example a NOBYPASSRLS role whose ONLY policies on these
 * three tables admit rows that are already dead by the retention rule (the
 * policy predicate IS the retention rule, so the role cannot reach a live row
 * whatever SQL it runs), entered from the kasuwa_app connection. Which option,
 * and the argument for it, belongs in the PR; it is not pinned here. What IS
 * pinned is what any acceptable mechanism must leave true:
 *
 *   * still exactly two SECURITY DEFINER functions;
 *   * no role reachable from kasuwa_app (by membership or SET ROLE) holds
 *     BYPASSRLS or SUPERUSER;
 *   * apps/worker cannot see DATABASE_MIGRATION_URL and its source never names
 *     the migrator;
 *   * THE ORDINARY PATHS DO NOT WIDEN. A kasuwa_app transaction with no GUCs
 *     still sees no auth row, dead or alive, and a tenant-A transaction still
 *     sees none of tenant B's. The lazy fix — a permissive "dead rows" policy
 *     for kasuwa_app — makes every forgotten tenant context a cross-tenant read
 *     of session and challenge rows, and every request able to enumerate
 *     lapsed rate-limit digests (which ADR-0009 says are personal data). Those
 *     guards are the adversarial half of this part.
 *
 * If the builder finds that no safe mechanism exists without a definer
 * function, that is the task's escalation case: stop and say so; do not edit
 * this file.
 *
 * ========================================================================
 * PART 2 — POOL EXHAUSTION IS 503
 * ========================================================================
 *
 * THE INTERFACE: `AppModule.forRoot` gains `poolConnectionTimeoutMillis?:
 * number`, passed through to `createPool`'s existing `connectionTimeoutMillis`
 * (default unchanged at 5 s). This suite boots with 2 connections and 250 ms.
 *
 * HOW THE POOL IS STARVED, without reaching into the app: the migrator takes
 * ACCESS EXCLUSIVE on `user` and `user_programme`, which every tenant
 * transaction reads first. Two ordinary requests then each take a pooled
 * connection and block on the lock, holding it. The suite WAITS ON STATE — two
 * backends with an ungranted lock on those tables in `pg_locks` — and never on
 * a timer. Every further request has to wait for a connection, and the
 * connection timeout fires.
 *
 * Four requests are made during the starvation: a stub-identity read, a
 * bearer-session read (the guard's `app.resolve_session` call, which today
 * goes through `pool.query`, not the interceptor), and two sign-ins — one for a
 * workspace that exists and one for a workspace that does not. All four must be
 * the SAME 503: same status, same body, same Retry-After. A bearer request that
 * answers 401 here would sign a real user out because the database was busy; a
 * sign-in that answers 401 says "wrong password" about a password nobody
 * checked; a body that differs between the two sign-ins is the ADR-0009
 * enumeration oracle again.
 *
 * ------------------------------------------------------------------------
 * D-L23: on main, `pruneAuthTables` does not exist (Part 1 fails on the missing
 * export) and a pool timeout falls to `UnexpectedErrorFilter` as 500
 * `internal_error` after the 5 s default (Part 2 fails on the status). The
 * negative guards in Part 1 PASS on main by construction — they hold before the
 * work starts and must still hold after it. Each one says so where it stands.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MINUTE = 60 * 1000;

// ---------------------------------------------------------------------------
// the prune interface
// ---------------------------------------------------------------------------

interface PruneCounts {
  authChallenge: number;
  authSession: number;
  authRateLimit: number;
}
type PruneAuthTables = (
  pool: Pool,
  options: { now: Date; batchSize: number },
) => Promise<PruneCounts>;

function loadPrune(): PruneAuthTables {
  const candidate: unknown = (db as Record<string, unknown>).pruneAuthTables;
  if (typeof candidate !== 'function') {
    throw new Error('T-0045: @kasuwa/db does not export pruneAuthTables(pool, { now, batchSize })');
  }
  return candidate as PruneAuthTables;
}

// ---------------------------------------------------------------------------
// planting rows, as the migrator (BYPASSRLS), with back-dated timestamps
// ---------------------------------------------------------------------------

async function withMigrator<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: inject('migrationUrl') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

interface ChallengeRow {
  tenantId: string;
  userId: string;
  expiresAt: Date;
  consumedAt?: Date;
}
async function plantChallenge(client: Client, row: ChallengeRow): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO auth_challenge (id, tenant_id, user_id, method, expires_at, consumed_at, created_at)
     VALUES ($1, $2, $3, 'totp', $4, $5, $6)`,
    [
      id,
      row.tenantId,
      row.userId,
      row.expiresAt,
      row.consumedAt ?? null,
      new Date(row.expiresAt.getTime() - 10 * MINUTE),
    ],
  );
  return id;
}

interface SessionRow {
  tenantId: string;
  userId: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  tokenHash?: Buffer;
}
async function plantSession(client: Client, row: SessionRow): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO auth_session (id, tenant_id, user_id, token_hash, issued_at, expires_at, revoked_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $5)`,
    [
      id,
      row.tenantId,
      row.userId,
      row.tokenHash ?? randomBytes(32),
      row.issuedAt,
      row.expiresAt,
      row.revokedAt ?? null,
    ],
  );
  return id;
}

interface RateLimitRow {
  firstFailedAt: Date;
  lastFailedAt: Date;
  lockedUntil?: Date;
  failedCount?: number;
}
async function plantRateLimit(client: Client, row: RateLimitRow): Promise<string> {
  const key = randomBytes(32);
  await client.query(
    `INSERT INTO auth_rate_limit (key_hash, failed_count, first_failed_at, last_failed_at, locked_until)
     VALUES ($1, $2, $3, $4, $5)`,
    [key, row.failedCount ?? 3, row.firstFailedAt, row.lastFailedAt, row.lockedUntil ?? null],
  );
  return key.toString('hex');
}

async function survivingChallenges(ids: readonly string[]): Promise<string[]> {
  return withMigrator(async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM auth_challenge WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [ids],
    );
    return result.rows.map((row) => row.id);
  });
}

async function survivingSessions(ids: readonly string[]): Promise<string[]> {
  return withMigrator(async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM auth_session WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [ids],
    );
    return result.rows.map((row) => row.id);
  });
}

async function survivingRateLimits(keys: readonly string[]): Promise<string[]> {
  return withMigrator(async (client) => {
    const result = await client.query<{ key: string }>(
      `SELECT encode(key_hash, 'hex') AS key FROM auth_rate_limit
        WHERE encode(key_hash, 'hex') = ANY($1::text[]) ORDER BY 1`,
      [keys],
    );
    return result.rows.map((row) => row.key);
  });
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

/** Rows a prune must never touch, counted before and after. */
async function bystanderCounts(): Promise<Record<string, number>> {
  return withMigrator(async (client) => {
    const result = await client.query<{ name: string; n: string }>(
      `SELECT 'user' AS name, count(*) AS n FROM "user"
       UNION ALL SELECT 'user_credential', count(*) FROM user_credential
       UNION ALL SELECT 'user_mfa_factor', count(*) FROM user_mfa_factor
       UNION ALL SELECT 'tenant', count(*) FROM tenant`,
    );
    return Object.fromEntries(result.rows.map((row) => [row.name, Number(row.n)]));
  });
}

/** Lists the source files under a directory, skipping tests and build output. */
function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry) && !/\.test\.[a-z]+$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** Strings that mean a file can reach the BYPASSRLS migrator. */
const MIGRATOR_REFERENCES = /DATABASE_MIGRATION_URL|migratorEnv|migrationUrl|kasuwa_migrator/;

describe('acceptance: auth-table retention (T-0045 part 1)', () => {
  let appPool: Pool;

  beforeAll(() => {
    // kasuwa_app, the role apps/worker runs as. See the header.
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 4 });
  });

  afterAll(async () => {
    await appPool.end();
    await reseed(inject('migrationUrl'));
  });

  beforeEach(async () => {
    // The seed truncates tenant CASCADE (sessions, challenges) and, since D-L59,
    // auth_rate_limit. Every test starts with no auth rows but its own, so the
    // per-call counts below are exact.
    await reseed(inject('migrationUrl'));
  });

  it('deletes expired challenges older than a day and keeps fresh, recently expired and recently consumed ones', async () => {
    const now = new Date();
    const ids = await withMigrator(async (client) => ({
      expired25hA: await plantChallenge(client, {
        tenantId: TENANT_A,
        userId: USER_A_AGENT_1,
        expiresAt: new Date(now.getTime() - 25 * HOUR),
      }),
      expired3dB: await plantChallenge(client, {
        tenantId: TENANT_B,
        userId: USER_B_AGENT_1,
        expiresAt: new Date(now.getTime() - 3 * DAY),
      }),
      consumedAndExpired2dA: await plantChallenge(client, {
        tenantId: TENANT_A,
        userId: USER_A_AGENT_1,
        expiresAt: new Date(now.getTime() - 2 * DAY),
        consumedAt: new Date(now.getTime() - 2 * DAY - 5 * MINUTE),
      }),
      expired23hB: await plantChallenge(client, {
        tenantId: TENANT_B,
        userId: USER_B_AGENT_1,
        expiresAt: new Date(now.getTime() - 23 * HOUR),
      }),
      openA: await plantChallenge(client, {
        tenantId: TENANT_A,
        userId: USER_A_AGENT_1,
        expiresAt: new Date(now.getTime() + 5 * MINUTE),
      }),
      consumedRecentlyB: await plantChallenge(client, {
        tenantId: TENANT_B,
        userId: USER_B_AGENT_1,
        expiresAt: new Date(now.getTime() + 8 * MINUTE),
        consumedAt: new Date(now.getTime() - MINUTE),
      }),
    }));

    const prune = loadPrune();
    const counts = await prune(appPool, { now, batchSize: 100 });

    expect(counts.authChallenge, 'three challenges are more than a day past expiry').toBe(3);
    expect(await survivingChallenges(Object.values(ids))).toEqual(
      sorted([ids.expired23hB, ids.openA, ids.consumedRecentlyB]),
    );
  });

  it('deletes sessions revoked or expired more than 30 days ago and keeps live, recently expired and recently revoked ones', async () => {
    const now = new Date();
    const ago = (ms: number): Date => new Date(now.getTime() - ms);
    const ids = await withMigrator(async (client) => ({
      expired31dA: await plantSession(client, {
        tenantId: TENANT_A,
        userId: USER_A_AGENT_1,
        issuedAt: ago(31 * DAY + 12 * HOUR),
        expiresAt: ago(31 * DAY),
      }),
      // Revoked 31 days ago on a long-lived session that EXPIRED only 25 hours
      // ago (30-day lifetime, KASUWA_AUTH_SESSION_HOURS' maximum). Only the
      // revocation rule deletes it, so an expiry-only prune keeps it and fails.
      revoked31dB: await plantSession(client, {
        tenantId: TENANT_B,
        userId: USER_B_AGENT_1,
        issuedAt: ago(31 * DAY + 1 * HOUR),
        revokedAt: ago(31 * DAY),
        expiresAt: ago(DAY + HOUR),
      }),
      expired29dB: await plantSession(client, {
        tenantId: TENANT_B,
        userId: USER_B_AGENT_1,
        issuedAt: ago(29 * DAY + 12 * HOUR),
        expiresAt: ago(29 * DAY),
      }),
      revoked1dA: await plantSession(client, {
        tenantId: TENANT_A,
        userId: USER_A_AGENT_1,
        issuedAt: ago(DAY + HOUR),
        revokedAt: ago(DAY),
        expiresAt: new Date(now.getTime() + 11 * HOUR),
      }),
      liveA: await plantSession(client, {
        tenantId: TENANT_A,
        userId: USER_A_AGENT_1,
        issuedAt: ago(HOUR),
        expiresAt: new Date(now.getTime() + 11 * HOUR),
      }),
      liveB: await plantSession(client, {
        tenantId: TENANT_B,
        userId: USER_B_AGENT_1,
        issuedAt: ago(HOUR),
        expiresAt: new Date(now.getTime() + 11 * HOUR),
      }),
    }));

    const before = await bystanderCounts();
    const prune = loadPrune();
    const counts = await prune(appPool, { now, batchSize: 100 });

    expect(counts.authSession, 'one expired and one revoked session are past 30 days').toBe(2);
    expect(await survivingSessions(Object.values(ids))).toEqual(
      sorted([ids.expired29dB, ids.revoked1dA, ids.liveA, ids.liveB]),
    );
    expect(await bystanderCounts(), 'the prune touched a table it does not own').toEqual(before);
  });

  it('deletes rate-limit rows only when the window and any lock have both lapsed, and never an active lock', async () => {
    const now = new Date();
    const ago = (ms: number): Date => new Date(now.getTime() - ms);
    const keys = await withMigrator(async (client) => ({
      lapsedNoLock: await plantRateLimit(client, {
        firstFailedAt: ago(2 * DAY + 10 * MINUTE),
        lastFailedAt: ago(2 * DAY),
      }),
      lapsedOldLock: await plantRateLimit(client, {
        failedCount: 5,
        firstFailedAt: ago(2 * DAY + 10 * MINUTE),
        lastFailedAt: ago(2 * DAY),
        lockedUntil: ago(2 * DAY - 15 * MINUTE),
      }),
      // Attacker-shaped: an identifier hammered ten minutes ago. Its window is
      // still open, so deleting it would reset the countdown mid-attack.
      windowOpen: await plantRateLimit(client, {
        firstFailedAt: ago(10 * MINUTE),
        lastFailedAt: ago(5 * MINUTE),
      }),
      // A lock in force now, set by a recent run of failures.
      lockedNow: await plantRateLimit(client, {
        failedCount: 5,
        firstFailedAt: ago(12 * MINUTE),
        lastFailedAt: ago(10 * MINUTE),
        lockedUntil: new Date(now.getTime() + 5 * MINUTE),
      }),
      // A lock in force now whose failures are long past. Unrealistic under the
      // default 15/15 policy, and that is the point: a prune keyed on
      // last_failed_at alone deletes it and lifts a lockout early. "Any lock"
      // means any lock.
      lockedNowStaleFailures: await plantRateLimit(client, {
        failedCount: 5,
        firstFailedAt: ago(2 * DAY + 10 * MINUTE),
        lastFailedAt: ago(2 * DAY),
        lockedUntil: new Date(now.getTime() + 10 * MINUTE),
      }),
    }));

    const prune = loadPrune();
    const counts = await prune(appPool, { now, batchSize: 100 });

    expect(counts.authRateLimit, 'two rows have both window and lock lapsed').toBe(2);
    expect(await survivingRateLimits(Object.values(keys))).toEqual(
      sorted([keys.windowOpen, keys.lockedNow, keys.lockedNowStaleFailures]),
    );
  });

  it('deletes at most batchSize rows per table per call, and makes progress until none are left', async () => {
    const now = new Date();
    const ago = (ms: number): Date => new Date(now.getTime() - ms);
    const DEAD = 5;
    const BATCH = 2;

    const live = await withMigrator(async (client) => {
      for (let index = 0; index < DEAD; index += 1) {
        const tenantId = index % 2 === 0 ? TENANT_A : TENANT_B;
        const userId = index % 2 === 0 ? USER_A_AGENT_1 : USER_B_AGENT_1;
        await plantChallenge(client, {
          tenantId,
          userId,
          expiresAt: ago(2 * DAY + index * MINUTE),
        });
        await plantSession(client, {
          tenantId,
          userId,
          issuedAt: ago(40 * DAY + 12 * HOUR),
          expiresAt: ago(40 * DAY + index * MINUTE),
        });
        await plantRateLimit(client, {
          firstFailedAt: ago(2 * DAY + 10 * MINUTE),
          lastFailedAt: ago(2 * DAY + index * MINUTE),
        });
      }
      return {
        challenge: await plantChallenge(client, {
          tenantId: TENANT_A,
          userId: USER_A_AGENT_1,
          expiresAt: new Date(now.getTime() + 5 * MINUTE),
        }),
        session: await plantSession(client, {
          tenantId: TENANT_B,
          userId: USER_B_AGENT_1,
          issuedAt: ago(HOUR),
          expiresAt: new Date(now.getTime() + 11 * HOUR),
        }),
        rateLimit: await plantRateLimit(client, {
          firstFailedAt: ago(5 * MINUTE),
          lastFailedAt: ago(MINUTE),
        }),
      };
    });

    const prune = loadPrune();
    const totals: PruneCounts = { authChallenge: 0, authSession: 0, authRateLimit: 0 };
    const calls: PruneCounts[] = [];
    // Bounded loop: DEAD / BATCH rounded up is three calls; ten is a guard
    // against an implementation that returns 0 forever, not a retry budget.
    for (let call = 0; call < 10; call += 1) {
      const counts = await prune(appPool, { now, batchSize: BATCH });
      calls.push(counts);
      for (const table of Object.keys(totals) as (keyof PruneCounts)[]) {
        expect(
          counts[table],
          `call ${call + 1} deleted ${counts[table]} rows from ${table}; batchSize is ${BATCH}`,
        ).toBeLessThanOrEqual(BATCH);
        if (totals[table] < DEAD) {
          expect(
            counts[table],
            `call ${call + 1} deleted nothing from ${table} with dead rows left`,
          ).toBeGreaterThan(0);
        }
        totals[table] += counts[table];
      }
      if (counts.authChallenge + counts.authSession + counts.authRateLimit === 0) break;
    }

    expect(totals, `per-call counts: ${JSON.stringify(calls)}`).toEqual({
      authChallenge: DEAD,
      authSession: DEAD,
      authRateLimit: DEAD,
    });
    expect(calls.at(-1), 'the last call should find nothing left').toEqual({
      authChallenge: 0,
      authSession: 0,
      authRateLimit: 0,
    });
    expect(await survivingChallenges([live.challenge])).toEqual([live.challenge]);
    expect(await survivingSessions([live.session])).toEqual([live.session]);
    expect(await survivingRateLimits([live.rateLimit])).toEqual([live.rateLimit]);
  });

  it('is safe to run twice at once: no error, and every dead row is counted exactly once', async () => {
    // Jobs are redelivered (apps/worker/CLAUDE.md invariant 3), and two worker
    // instances may hold the schedule at once during a deploy.
    const now = new Date();
    const ago = (ms: number): Date => new Date(now.getTime() - ms);
    const DEAD = 6;
    await withMigrator(async (client) => {
      for (let index = 0; index < DEAD; index += 1) {
        const tenantId = index % 2 === 0 ? TENANT_A : TENANT_B;
        const userId = index % 2 === 0 ? USER_A_AGENT_1 : USER_B_AGENT_1;
        await plantChallenge(client, { tenantId, userId, expiresAt: ago(2 * DAY) });
        await plantSession(client, {
          tenantId,
          userId,
          issuedAt: ago(40 * DAY + 12 * HOUR),
          expiresAt: ago(40 * DAY),
        });
        await plantRateLimit(client, { firstFailedAt: ago(3 * DAY), lastFailedAt: ago(3 * DAY) });
      }
    });

    const prune = loadPrune();
    const [first, second] = await Promise.all([
      prune(appPool, { now, batchSize: 100 }),
      prune(appPool, { now, batchSize: 100 }),
    ]);
    expect({
      authChallenge: first.authChallenge + second.authChallenge,
      authSession: first.authSession + second.authSession,
      authRateLimit: first.authRateLimit + second.authRateLimit,
    }).toEqual({ authChallenge: DEAD, authSession: DEAD, authRateLimit: DEAD });
    expect(await prune(appPool, { now, batchSize: 100 })).toEqual({
      authChallenge: 0,
      authSession: 0,
      authRateLimit: 0,
    });
  });

  it('really runs on the pool it is given (kasuwa_app), not on a connection of its own', async () => {
    const now = new Date();
    await withMigrator((client) =>
      plantChallenge(client, {
        tenantId: TENANT_B,
        userId: USER_B_AGENT_1,
        expiresAt: new Date(now.getTime() - 2 * DAY),
      }),
    );
    let acquired = 0;
    const onAcquire = (): void => {
      acquired += 1;
    };
    appPool.on('acquire', onAcquire);
    try {
      const counts = await loadPrune()(appPool, { now, batchSize: 100 });
      expect(counts.authChallenge).toBe(1);
    } finally {
      appPool.off('acquire', onAcquire);
    }
    expect(
      acquired,
      'pruneAuthTables never took a connection from the pool it was given',
    ).toBeGreaterThan(0);

    const role = await appPool.query<{ current_user: string }>('SELECT current_user');
    expect(role.rows[0]?.current_user).toBe('kasuwa_app');
  });

  describe('the mechanism does not open a hole', () => {
    it('leaves exactly the two SECURITY DEFINER functions CLAUDE.md 2.7 documents', async () => {
      // PASSES ON MAIN BY CONSTRUCTION — a guard on the mechanism, not
      // evidence of the work. Duplicates the permissions suite's assertion on
      // purpose: this task is the one most tempted to add a third.
      const result = await appPool.query<{ name: string }>(
        `SELECT n.nspname || '.' || p.proname AS name
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prosecdef
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          ORDER BY 1`,
      );
      expect(result.rows.map((row) => row.name)).toEqual([
        'app.resolve_session',
        'app.resolve_tenant_by_slug',
      ]);
    });

    it('gives kasuwa_app no path to a BYPASSRLS or superuser role, by membership or SET ROLE', async () => {
      // PASSES ON MAIN BY CONSTRUCTION. Catches "GRANT kasuwa_migrator TO
      // kasuwa_app" plus a SET ROLE inside the prune, which would satisfy the
      // pool test above while bypassing RLS completely.
      const result = await appPool.query<{ rolname: string }>(
        `SELECT r.rolname
           FROM pg_roles r
          WHERE pg_has_role('kasuwa_app', r.oid, 'MEMBER')
            AND (r.rolbypassrls OR r.rolsuper)`,
      );
      expect(result.rows.map((row) => row.rolname)).toEqual([]);
    });

    it('still shows a kasuwa_app transaction with no session context no auth row at all, dead or alive', async () => {
      // PASSES ON MAIN BY CONSTRUCTION, and must still pass after the work.
      // Dead rows are planted so that a "dead rows are fair game" policy for
      // kasuwa_app shows up here as rows.
      const now = new Date();
      await withMigrator(async (client) => {
        await plantChallenge(client, {
          tenantId: TENANT_B,
          userId: USER_B_AGENT_1,
          expiresAt: new Date(now.getTime() - 3 * DAY),
        });
        await plantSession(client, {
          tenantId: TENANT_B,
          userId: USER_B_AGENT_1,
          issuedAt: new Date(now.getTime() - 41 * DAY),
          expiresAt: new Date(now.getTime() - 40 * DAY),
        });
        await plantRateLimit(client, {
          firstFailedAt: new Date(now.getTime() - 3 * DAY),
          lastFailedAt: new Date(now.getTime() - 3 * DAY),
        });
      });
      // Non-vacuous: the rows are there for a role that can see them.
      const planted = await withMigrator(async (client) => {
        const result = await client.query<{ n: string }>(
          `SELECT (SELECT count(*) FROM auth_challenge)
                + (SELECT count(*) FROM auth_session)
                + (SELECT count(*) FROM auth_rate_limit) AS n`,
        );
        return Number(result.rows[0]?.n);
      });
      expect(planted).toBe(3);

      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        for (const table of ['auth_challenge', 'auth_session', 'auth_rate_limit']) {
          const seen = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
          expect(Number(seen.rows[0]?.n), `${table} is readable with no session context`).toBe(0);
          // Refused either way: RLS hides every row (0 deleted), or, since
          // T-0049 (D-P16), kasuwa_app holds no DELETE on the auth tables and
          // the statement is 42501. A savepoint keeps the transaction usable.
          await client.query('SAVEPOINT probe');
          try {
            const deleted = await client.query(`DELETE FROM ${table}`);
            expect(deleted.rowCount, `${table} is deletable with no session context`).toBe(0);
          } catch (error) {
            expect((error as { code?: string }).code, `${table}: ${String(error)}`).toBe('42501');
            await client.query('ROLLBACK TO SAVEPOINT probe');
          }
        }
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it("still shows a tenant-A transaction none of tenant B's dead auth rows, and no rate-limit row it did not present", async () => {
      // PASSES ON MAIN BY CONSTRUCTION, and must still pass after the work.
      const now = new Date();
      await withMigrator(async (client) => {
        await plantChallenge(client, {
          tenantId: TENANT_B,
          userId: USER_B_AGENT_1,
          expiresAt: new Date(now.getTime() - 3 * DAY),
        });
        await plantSession(client, {
          tenantId: TENANT_B,
          userId: USER_B_AGENT_1,
          issuedAt: new Date(now.getTime() - 41 * DAY),
          expiresAt: new Date(now.getTime() - 40 * DAY),
        });
        await plantRateLimit(client, {
          firstFailedAt: new Date(now.getTime() - 3 * DAY),
          lastFailedAt: new Date(now.getTime() - 3 * DAY),
        });
      });

      await withForcedScope(
        appPool,
        { tenantId: TENANT_A, userId: USER_A_AGENT_1, programmeIds: [] },
        async (query) => {
          for (const table of ['auth_challenge', 'auth_session']) {
            const seen = await query<{ n: string }>(
              `SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1`,
              [TENANT_B],
            );
            expect(Number(seen[0]?.n), `tenant A can read tenant B's ${table}`).toBe(0);
            // Refused either way: RLS hides tenant B's rows (0 deleted), or,
            // since T-0049 (D-P16), kasuwa_app holds no DELETE here (42501).
            await query('SAVEPOINT probe');
            try {
              const deleted = await query(
                `DELETE FROM ${table} WHERE tenant_id = $1 RETURNING 1`,
                [TENANT_B],
              );
              expect(deleted.length, `tenant A can delete tenant B's ${table}`).toBe(0);
            } catch (error) {
              expect((error as { code?: string }).code, `${table}: ${String(error)}`).toBe('42501');
              await query('ROLLBACK TO SAVEPOINT probe');
            }
          }
          const keys = await query<{ n: string }>(`SELECT count(*) AS n FROM auth_rate_limit`);
          expect(Number(keys[0]?.n), 'a tenant session can enumerate rate-limit digests').toBe(0);
        },
      );
    });

    it('keeps DATABASE_MIGRATION_URL away from apps/worker', () => {
      // The schema half PASSES ON MAIN BY CONSTRUCTION (Zod strips the key);
      // it is here so that adding the key to WorkerSchema fails. The worker's
      // own connection is DATABASE_URL, which T-0045 adds: the schema comment
      // in @kasuwa/config says that is how the first database job lands.
      const env: Record<string, unknown> = {
        ...workerEnv({
          // NODE_ENV explicit: since D-L95 the worker refuses an unset one (T-0117).
          NODE_ENV: 'test',
          DATABASE_URL: 'postgres://kasuwa_app:not-a-secret@localhost:5432/kasuwa',
          DATABASE_MIGRATION_URL: 'postgres://kasuwa_migrator:not-a-secret@localhost:5432/kasuwa',
          REDIS_URL: 'redis://localhost:6379',
        }),
      };
      expect(env).not.toHaveProperty('DATABASE_MIGRATION_URL');
      expect(env.DATABASE_URL, 'workerEnv has no DATABASE_URL for the prune job to use').toBe(
        'postgres://kasuwa_app:not-a-secret@localhost:5432/kasuwa',
      );

      const workerFiles = sourceFiles(join(repoRoot, 'apps', 'worker', 'src'));
      // Non-vacuous: main.ts at least.
      expect(workerFiles.length).toBeGreaterThan(0);
      const offenders = workerFiles.filter((file) =>
        MIGRATOR_REFERENCES.test(readFileSync(file, 'utf8')),
      );
      expect(
        offenders.map((file) => relative(repoRoot, file)),
        'apps/worker names the migrator connection',
      ).toEqual([]);
    });

    it('defines the prune in a file that does not reach for the migrator or the environment', () => {
      const dbFiles = sourceFiles(join(repoRoot, 'packages', 'db', 'src'));
      const definers = dbFiles.filter((file) =>
        /export\s+(async\s+)?function\s+pruneAuthTables\b|export\s+const\s+pruneAuthTables\b/.test(
          readFileSync(file, 'utf8'),
        ),
      );
      expect(
        definers.map((file) => relative(repoRoot, file)),
        'no file in packages/db/src defines pruneAuthTables',
      ).toHaveLength(1);
      const source = readFileSync(definers[0] as string, 'utf8');
      expect(source, 'the prune names the migrator connection').not.toMatch(MIGRATOR_REFERENCES);
      expect(source, 'the prune reads the environment for itself').not.toMatch(/process\.env/);
    });
  });

  it('is wired into apps/worker on a schedule', () => {
    // Lightweight by design (the lead's brief): a worker source file calls the
    // prune and registers a repeating job. Booting BullMQ against Redis to
    // watch a cron fire would prove BullMQ, not this task.
    const workerFiles = sourceFiles(join(repoRoot, 'apps', 'worker', 'src'));
    const sources = workerFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(sources, 'apps/worker never calls pruneAuthTables').toMatch(/\bpruneAuthTables\s*\(/);
    expect(sources, 'apps/worker registers no repeating job').toMatch(
      /upsertJobScheduler\s*\(|\brepeat\s*:\s*\{/,
    );

    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'apps', 'worker', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies?.['@kasuwa/db'], 'apps/worker does not depend on @kasuwa/db').toBe(
      'workspace:*',
    );
  });
});

// ===========================================================================
// PART 2
// ===========================================================================

const SIGN_IN = '/api/v1/auth/sign-in';
const CONTACTS = '/api/v1/contacts';
const WORKSPACE = 'sahel-bpo';
const NO_SUCH_WORKSPACE = 't0045-no-such-workspace';
const SIGN_IN_EMAIL = 'ngozi.agent@tenant-a.test';
const SIGN_IN_PASSWORD = 't0045-not-the-password';
const POOL_MAX = 2;
const CONNECTION_TIMEOUT_MS = 250;

interface Answer {
  label: string;
  status: number;
  text: string;
  body: Record<string, unknown>;
  retryAfter: string | undefined;
  contentType: string | undefined;
}

async function answer(label: string, send: request.Test): Promise<Answer> {
  const response = await send;
  const header = (name: string): string | undefined => {
    const value: unknown = response.headers[name];
    return typeof value === 'string' ? value : undefined;
  };
  return {
    label,
    status: response.status,
    text: response.text,
    body: (response.body ?? {}) as Record<string, unknown>,
    retryAfter: header('retry-after'),
    contentType: header('content-type'),
  };
}

describe('acceptance: pool exhaustion is answered 503 (T-0045 part 2)', () => {
  let app: INestApplication;
  let url: string;
  const token = `ksw_s1_${randomBytes(32).toString('base64url')}`;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    // A real, live session for a seeded user, so the bearer request below is
    // one that SHOULD succeed and is refused only because the pool is empty.
    await withMigrator((client) =>
      plantSession(client, {
        tenantId: TENANT_A,
        userId: USER_A_AGENT_1,
        issuedAt: new Date(Date.now() - HOUR),
        expiresAt: new Date(Date.now() + 11 * HOUR),
        tokenHash: createHash('sha256').update(token, 'utf8').digest(),
      }),
    );

    // Built as a variable, not a literal, so the new option typechecks on main
    // before it exists; the builder adds it to AppModuleOptions.
    const options: AppModuleOptions & { poolConnectionTimeoutMillis: number } = withAuthDatabase({
      databaseUrl: inject('databaseUrl'),
      poolMax: POOL_MAX,
      poolConnectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(options)],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    await reseed(inject('migrationUrl'));
  });

  it('answers a database-backed read, a bearer read and both sign-ins with one identical 503, never 500', async () => {
    // Non-vacuous: before starvation both identities work.
    const warmStub = await request(url).get(CONTACTS).set(asUser(TENANT_A, USER_A_AGENT_1));
    expect(warmStub.status, 'the stub-identity read should work before the pool is starved').toBe(
      200,
    );
    const warmBearer = await request(url).get(CONTACTS).set('authorization', `Bearer ${token}`);
    expect(warmBearer.status, 'the planted session should work before the pool is starved').toBe(
      200,
    );

    const locker = new Client({ connectionString: inject('migrationUrl') });
    await locker.connect();
    const observer = new Client({ connectionString: inject('testAdminUrl') });
    await observer.connect();
    let holders: Promise<request.Response>[] = [];
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE "user", user_programme IN ACCESS EXCLUSIVE MODE');

      // Each holder takes a pooled connection and blocks on the lock with it.
      holders = Array.from({ length: POOL_MAX }, () =>
        request(url)
          .get(CONTACTS)
          .set(asUser(TENANT_A, USER_A_AGENT_1))
          .then((response) => response),
      );
      await vi.waitFor(
        async () => {
          const waiting = await observer.query<{ n: string }>(
            // pg_locks, not pg_stat_activity: a non-superuser sees other
            // roles' backends there with wait_event_type NULL. One ungranted
            // lock per blocked holder; the locker's own locks are granted.
            `SELECT count(DISTINCT pid) AS n FROM pg_locks
              WHERE NOT granted
                AND relation IN ('public."user"'::regclass, 'public.user_programme'::regclass)`,
          );
          expect(Number(waiting.rows[0]?.n)).toBeGreaterThanOrEqual(POOL_MAX);
        },
        { timeout: 10_000, interval: 20 },
      );

      const answers = await Promise.all([
        answer('stub read', request(url).get(CONTACTS).set(asUser(TENANT_A, USER_A_AGENT_1))),
        answer('bearer read', request(url).get(CONTACTS).set('authorization', `Bearer ${token}`)),
        answer(
          'sign-in, real workspace',
          request(url)
            .post(SIGN_IN)
            .send({ tenantSlug: WORKSPACE, email: SIGN_IN_EMAIL, password: SIGN_IN_PASSWORD }),
        ),
        answer(
          'sign-in, no such workspace',
          request(url)
            .post(SIGN_IN)
            .send({
              tenantSlug: NO_SUCH_WORKSPACE,
              email: SIGN_IN_EMAIL,
              password: SIGN_IN_PASSWORD,
            }),
        ),
      ]);

      const summary = answers
        .map((a) => `${a.label}: ${a.status} ${a.text.slice(0, 160)}`)
        .join('\n');

      for (const a of answers) {
        expect(a.status, `${a.label} answered 500 for an exhausted pool\n${summary}`).not.toBe(500);
        expect(a.status, `${a.label} did not answer 503\n${summary}`).toBe(503);
        expect(a.contentType ?? '', `${a.label} is not JSON`).toMatch(/^application\/json/);
        expect(Object.keys(a.body).sort(), `${a.label} is not the bare Error envelope`).toEqual([
          'code',
          'error',
          'message',
          'statusCode',
        ]);
        expect(a.body).toMatchObject({
          statusCode: 503,
          error: 'Service Unavailable',
          code: 'service_unavailable',
        });
        expect(typeof a.body.message).toBe('string');
        expect(a.retryAfter, `${a.label} has no Retry-After`).toMatch(/^[1-9]\d*$/);

        // Nothing the caller sent, nothing about the database.
        for (const secret of [
          SIGN_IN_EMAIL,
          SIGN_IN_PASSWORD,
          WORKSPACE,
          NO_SUCH_WORKSPACE,
          TENANT_A,
          USER_A_AGENT_1,
          token,
        ]) {
          expect(a.text, `${a.label} echoes a request value`).not.toContain(secret);
        }
        expect(a.text, `${a.label} leaks database detail`).not.toMatch(
          /\bselect\b|\binsert\b|sqlstate|postgres|pg_|kasuwa_|timeout exceeded|connection terminated|ECONN|\b(?:08|53|57)[0-9A-Z]{3}\b/i,
        );
      }

      // No oracle: one body and one Retry-After for every route and both
      // sign-in branches.
      const first = answers[0] as Answer;
      for (const a of answers.slice(1)) {
        expect(a.text, `${a.label} differs from ${first.label}`).toBe(first.text);
        expect(a.retryAfter, `${a.label}'s Retry-After differs from ${first.label}'s`).toBe(
          first.retryAfter,
        );
      }
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined);
      await locker.end();
      await observer.end();
    }

    // The holders were waiting on the lock, not broken by it.
    const held = await Promise.all(holders);
    expect(held.map((response) => response.status)).toEqual(Array(POOL_MAX).fill(200));

    // And the pool recovers: nothing was poisoned by the timeouts.
    const after = await request(url).get(CONTACTS).set(asUser(TENANT_A, USER_A_AGENT_1));
    expect(after.status, 'the API did not recover once connections were free').toBe(200);
  });
});
