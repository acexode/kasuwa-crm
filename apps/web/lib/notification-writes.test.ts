import { describe, expect, it } from 'vitest';
import { RESEND_DELAYS_MS, canReadAll, canToggle, dotEffect, isCurrentGeneration, sendWithResends, type GateView } from './notification-writes';

const idle: GateView = { busyIds: [], allBusy: false, writeWaitUntil: null, headId: 'head' };
type Answer = { ok: boolean; error?: { code: string } };

describe('resends', () => {
  const lost: Answer = { ok: false, error: { code: 'network' } };

  it('sends the same request again after a lost answer, twice at most, inside ten seconds', async () => {
    const slept: number[] = [];
    let calls = 0;
    const result = await sendWithResends<Answer>(async () => (calls++ < 2 ? lost : { ok: true }), async (ms) => void slept.push(ms));
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
    expect(slept).toEqual([...RESEND_DELAYS_MS]);
    expect(RESEND_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBeLessThan(10_000);
  });

  it('gives up after the last resend, and never resends an answer or a refusal', async () => {
    let calls = 0;
    expect((await sendWithResends<Answer>(async () => (calls++, lost), async () => undefined)).ok).toBe(false);
    expect(calls).toBe(1 + RESEND_DELAYS_MS.length);
    calls = 0;
    await sendWithResends<Answer>(async () => (calls++, { ok: false, error: { code: 'not_found' } }), async () => undefined);
    expect(calls).toBe(1);
  });
});

describe('N4: a dot and a mark-all are never in flight together', () => {
  it('blocks every dot while a mark-all is in flight, and the mark-all while any dot is', () => {
    expect(canToggle(idle, 'a', 0)).toBe(true);
    expect(canReadAll(idle, 0)).toBe(true);
    expect(canToggle({ ...idle, allBusy: true }, 'a', 0)).toBe(false);
    expect(canReadAll({ ...idle, busyIds: ['b'] }, 0)).toBe(false);
    expect(canToggle({ ...idle, busyIds: ['a'] }, 'a', 0)).toBe(false);
    expect(canToggle({ ...idle, busyIds: ['b'] }, 'a', 0)).toBe(true);
  });

  it('needs a bound, and waits out a 429', () => {
    expect(canReadAll({ ...idle, headId: null }, 0)).toBe(false);
    expect(canToggle({ ...idle, writeWaitUntil: 5_000 }, 'a', 1_000)).toBe(false);
    expect(canReadAll({ ...idle, writeWaitUntil: 5_000 }, 1_000)).toBe(false);
    expect(canReadAll({ ...idle, writeWaitUntil: 5_000 }, 5_000)).toBe(true);
  });
});

describe('N2: what a dot’s answer does to the badge', () => {
  it('steps once for a confirmed change, down for read and up for unread, and not for a no-op', () => {
    expect(dotEffect(true, { ok: true, readAt: 'T' })).toEqual({ kind: 'step', delta: -1 });
    expect(dotEffect(false, { ok: true, readAt: null })).toEqual({ kind: 'step', delta: 1 });
    expect(dotEffect(false, { ok: true, readAt: 'T' })).toEqual({ kind: 'none' });
    expect(dotEffect(true, { ok: true, readAt: null })).toEqual({ kind: 'none' });
  });

  it('reads the count again after a 404 or any failure, instead of stepping it', () => {
    expect(dotEffect(true, { ok: false, code: 'not_found' })).toEqual({ kind: 'refresh' });
    expect(dotEffect(false, { ok: false, code: 'not_found' })).toEqual({ kind: 'refresh' });
    expect(dotEffect(true, { ok: false, code: 'network' })).toEqual({ kind: 'refresh' });
  });
});

describe('N3: a mark-all answer belongs to its query', () => {
  it('is current only for the generation it was sent in', () => {
    expect(isCurrentGeneration(3, 3)).toBe(true);
    expect(isCurrentGeneration(3, 4)).toBe(false);
  });
});
