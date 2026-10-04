import { apiEnv } from '@kasuwa/config';
import { AUTH_RETENTION, type PruneAuthTablesCounts } from '@kasuwa/db';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthRetentionJobError,
  authRetentionJob,
  authRetentionLine,
  runAuthRetention,
  type Pool,
  type Prune,
} from './auth-retention';

const pool = {} as Pool;

/** Shaped like pg's: the message and detail can carry row values. */
class DatabaseError extends Error {
  code = '23505';
  detail = '';
}
const counts = (c: number, s: number, r: number): PruneAuthTablesCounts => ({
  authChallenge: c,
  authSession: s,
  authRateLimit: r,
});

function pruneReturning(...answers: PruneAuthTablesCounts[]): ReturnType<typeof vi.fn<Prune>> {
  const prune = vi.fn<Prune>();
  for (const answer of answers) prune.mockResolvedValueOnce(answer);
  prune.mockResolvedValue(counts(0, 0, 0));
  return prune;
}

describe('runAuthRetention', () => {
  const now = new Date('2026-10-04T12:00:00Z');

  it('calls again while any table returns a full batch, and stops on the first short one', async () => {
    const prune = pruneReturning(counts(2, 0, 2), counts(0, 0, 2), counts(1, 0, 1));
    const run = await runAuthRetention(prune, pool, { now, batchSize: 2 });
    expect(prune).toHaveBeenCalledTimes(3);
    expect(run).toEqual({ authChallenge: 3, authSession: 0, authRateLimit: 5, batches: 3 });
    for (const call of prune.mock.calls) {
      expect(call[0]).toBe(pool);
      expect(call[1]).toEqual({ now, batchSize: 2 });
    }
  });

  it('runs once when nothing is due', async () => {
    const prune = pruneReturning();
    const run = await runAuthRetention(prune, pool, { now, batchSize: 10 });
    expect(prune).toHaveBeenCalledTimes(1);
    expect(run.batches).toBe(1);
  });

  it('never runs more than maxBatches calls, even if every batch is full', async () => {
    const prune = vi.fn<Prune>().mockResolvedValue(counts(5, 5, 5));
    const run = await runAuthRetention(prune, pool, { now, batchSize: 5, maxBatches: 4 });
    expect(prune).toHaveBeenCalledTimes(4);
    expect(run).toEqual({ authChallenge: 20, authSession: 20, authRateLimit: 20, batches: 4 });
  });

  it('propagates a failed batch so BullMQ retries the job', async () => {
    const prune = vi.fn<Prune>().mockRejectedValue(new Error('boom'));
    await expect(runAuthRetention(prune, pool, { now })).rejects.toThrow('boom');
  });
});

describe('authRetentionLine', () => {
  it('reports counts only', () => {
    expect(
      authRetentionLine({ authChallenge: 1, authSession: 2, authRateLimit: 3, batches: 1 }),
    ).toBe('auth retention: deleted challenges=1 sessions=2 rate_limits=3 batches=1');
  });
});

describe('authRetentionJob', () => {
  it('rethrows a failure as its class name only, with no message, detail or cause', async () => {
    // Invented value (CLAUDE.md 6): stands in for a row value in a pg message.
    const probe = 'chinedu.probe@example.test';
    const pgError = Object.assign(new DatabaseError(`duplicate key value ${probe}`), {
      detail: `Key (email)=(${probe}) already exists.`,
    });
    const prune = vi.fn<Prune>().mockRejectedValue(pgError);
    const failure: unknown = await authRetentionJob(prune, pool, new Date()).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AuthRetentionJobError);
    const error = failure as AuthRetentionJobError;
    expect(error.message).toBe('auth retention failed: DatabaseError');
    expect(error.cause).toBeUndefined();
    expect(`${error.message}
${error.stack ?? ''}`).not.toContain(probe);
  });

  it('names a thrown non-error as UnknownError', async () => {
    const prune = vi.fn<Prune>().mockRejectedValue({ constructor: { name: 'Bad name!' } });
    await expect(authRetentionJob(prune, pool, new Date())).rejects.toThrow(
      'auth retention failed: UnknownError',
    );
  });
});

describe('retention is pinned to what the API can be configured with', () => {
  const DATABASE_URL = 'postgres://kasuwa_app:not-a-secret@localhost:5432/kasuwa';

  it('keeps rate-limit rows at least as long as the longest permitted failure window', () => {
    // KASUWA_AUTH_LOCKOUT_WINDOW_MINUTES max is 1440. If that maximum rises,
    // this fails, and the retention here AND the policy in migration 0020
    // must rise with it - or the sweep resets live countdowns.
    expect(() => apiEnv({ DATABASE_URL, KASUWA_AUTH_LOCKOUT_WINDOW_MINUTES: '1440' })).not.toThrow();
    expect(() => apiEnv({ DATABASE_URL, KASUWA_AUTH_LOCKOUT_WINDOW_MINUTES: '1441' })).toThrow(
      /KASUWA_AUTH_LOCKOUT_WINDOW_MINUTES/,
    );
    expect(AUTH_RETENTION.rateLimitAfterLastFailureMinutes).toBeGreaterThanOrEqual(1440);
  });

  it('keeps the revoked-session shortcut sound: no session outlives the session retention', () => {
    // The revoked-session statement also requires `expires_at < now`, which
    // holds only while a session lives no longer than the retention period.
    expect(() => apiEnv({ DATABASE_URL, KASUWA_AUTH_SESSION_HOURS: '720' })).not.toThrow();
    expect(() => apiEnv({ DATABASE_URL, KASUWA_AUTH_SESSION_HOURS: '721' })).toThrow(
      /KASUWA_AUTH_SESSION_HOURS/,
    );
    expect(AUTH_RETENTION.sessionAfterEndMinutes).toBeGreaterThanOrEqual(720 * 60);
  });
});
