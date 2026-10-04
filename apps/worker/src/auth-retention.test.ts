import type { PruneAuthTablesCounts } from '@kasuwa/db';
import { describe, expect, it, vi } from 'vitest';
import { authRetentionLine, runAuthRetention, type Pool, type Prune } from './auth-retention';

const pool = {} as Pool;
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
