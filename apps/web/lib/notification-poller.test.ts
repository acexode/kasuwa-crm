import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKOFF_CAP_MS, CADENCE_MS, RETRY_AFTER_CAP_MS, WAKE_COALESCE_MS, retryAfterMs, createPoller, shouldReadOnWake, waitAfter, type PollOutcome } from './notification-poller';

describe('waitAfter', () => {
  it('returns to the cadence after a success and clears the failures', () => {
    expect(waitAfter({ kind: 'ok' }, 4)).toEqual({ waitMs: CADENCE_MS, failures: 0, hold: false });
  });

  it('grows with each failure, never below the cadence and never past five minutes', () => {
    let failures = 0;
    const waits: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      const next = waitAfter({ kind: 'failed' }, failures);
      waits.push(next.waitMs);
      failures = next.failures;
    }
    expect(waits[0]).toBeGreaterThanOrEqual(CADENCE_MS);
    expect(waits[2] ?? 0).toBeGreaterThanOrEqual(1.5 * CADENCE_MS);
    expect(Math.max(...waits)).toBe(BACKOFF_CAP_MS);
    waits.slice(1).forEach((wait, index) => expect(wait).toBeGreaterThanOrEqual(waits[index] ?? 0));
  });

  it('honours the whole Retry-After, even past the cadence, and holds', () => {
    expect(waitAfter({ kind: 'throttled', retryAfterSeconds: 120 }, 2)).toEqual({ waitMs: 120_000, failures: 2, hold: true });
    expect(waitAfter({ kind: 'throttled', retryAfterSeconds: 3 }, 0).waitMs).toBe(CADENCE_MS);
    expect(waitAfter({ kind: 'throttled' }, 0).waitMs).toBe(CADENCE_MS);
    expect(waitAfter({ kind: 'throttled', retryAfterSeconds: 999_999 }, 0).waitMs).toBeLessThanOrEqual(900_000);
  });
});

describe('shouldReadOnWake', () => {
  const base = { visible: true, now: 100_000, lastStartedAt: 0, inFlight: false, heldUntil: 0 };
  it('reads when shown after a while, not when hidden, in flight or held', () => {
    expect(shouldReadOnWake(base)).toBe(true);
    expect(shouldReadOnWake({ ...base, visible: false })).toBe(false);
    expect(shouldReadOnWake({ ...base, inFlight: true })).toBe(false);
    expect(shouldReadOnWake({ ...base, heldUntil: 200_000 })).toBe(false);
  });
  it('coalesces a burst', () => {
    expect(shouldReadOnWake({ ...base, lastStartedAt: base.now - WAKE_COALESCE_MS + 1 })).toBe(false);
    expect(shouldReadOnWake({ ...base, lastStartedAt: base.now - WAKE_COALESCE_MS })).toBe(true);
    expect(shouldReadOnWake({ ...base, lastStartedAt: null })).toBe(true);
  });
});

describe('createPoller on a fake clock', () => {
  let visible = true;
  let outcomes: PollOutcome[] = [];
  let reads: number[] = [];

  const make = () =>
    createPoller({
      read: async () => {
        reads.push(Date.now());
        return outcomes.shift() ?? { kind: 'ok' };
      },
      now: () => Date.now(),
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      isVisible: () => visible,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    visible = true;
    outcomes = [];
    reads = [];
  });
  afterEach(() => vi.useRealTimers());

  it('reads on start and then every cadence while visible', async () => {
    const poller = make();
    poller.start();
    await vi.advanceTimersByTimeAsync(CADENCE_MS * 3 + 10);
    expect(reads).toHaveLength(4);
    poller.stop();
  });

  it('reads nothing while hidden and once at once when shown, however many focus events follow', async () => {
    const poller = make();
    poller.start();
    await vi.advanceTimersByTimeAsync(10);
    visible = false;
    poller.pause();
    await vi.advanceTimersByTimeAsync(CADENCE_MS * 10);
    expect(reads).toHaveLength(1);
    visible = true;
    for (let index = 0; index < 10; index += 1) poller.wake();
    await vi.advanceTimersByTimeAsync(10);
    expect(reads).toHaveLength(2);
    poller.stop();
  });

  it('waits a whole Retry-After, and a wake cannot cut it short', async () => {
    outcomes = [{ kind: 'throttled', retryAfterSeconds: 120 }];
    const poller = make();
    poller.start();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(60_000);
    poller.wake();
    poller.refresh();
    await vi.advanceTimersByTimeAsync(10);
    expect(reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toHaveLength(2);
    expect((reads[1] ?? 0) - (reads[0] ?? 0)).toBeGreaterThanOrEqual(120_000);
    poller.stop();
  });

  it('backs off on failures, never gives up and returns to the cadence on a success', async () => {
    outcomes = [{ kind: 'failed' }, { kind: 'failed' }, { kind: 'failed' }, { kind: 'failed' }, { kind: 'failed' }, { kind: 'failed' }];
    const poller = make();
    poller.start();
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    const gaps = reads.slice(1).map((at, index) => at - (reads[index] ?? 0));
    expect(gaps[0]).toBeGreaterThanOrEqual(CADENCE_MS);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    expect(gaps.at(-1)).toBe(CADENCE_MS);
    poller.stop();
  });

  it('refresh reads at once when nothing holds it, and stop aborts a read in flight', async () => {
    let aborted = false;
    const poller = createPoller({
      read: (signal) =>
        new Promise<PollOutcome>((resolve) => {
          reads.push(Date.now());
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve({ kind: 'aborted' });
          });
        }),
      now: () => Date.now(),
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      isVisible: () => visible,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(10);
    poller.stop();
    await vi.advanceTimersByTimeAsync(CADENCE_MS * 2);
    expect(aborted).toBe(true);
    expect(reads).toHaveLength(1);
  });

  // B1 (D-L179): pause() clears the timer, so a declined wake used to leave nothing scheduled, for good.
  it('keeps polling after a quick hide and show inside the coalescing window', async () => {
    const poller = make();
    poller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    visible = false;
    poller.pause();
    await vi.advanceTimersByTimeAsync(1_000);
    visible = true;
    poller.wake();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(reads.length).toBeGreaterThan(60);
    const gaps = reads.slice(1).map((at, index) => at - (reads[index] ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(WAKE_COALESCE_MS);
    poller.stop();
  });

  it('keeps polling after a 429 hold followed by a hide and show, and still waits the whole Retry-After', async () => {
    outcomes = [{ kind: 'throttled', retryAfterSeconds: 120 }];
    const poller = make();
    poller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    visible = false;
    poller.pause();
    await vi.advanceTimersByTimeAsync(60_000);
    visible = true;
    poller.wake();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect((reads[1] ?? 0) - (reads[0] ?? 0)).toBeGreaterThanOrEqual(120_000);
    expect(reads.length).toBeGreaterThan(60);
    poller.stop();
  });

  it('caps a Retry-After at fifteen minutes', () => {
    expect(retryAfterMs(undefined, 7)).toBe(7);
    expect(retryAfterMs(30, 7)).toBe(30_000);
    expect(retryAfterMs(999_999, 7)).toBe(RETRY_AFTER_CAP_MS);
  });
});
