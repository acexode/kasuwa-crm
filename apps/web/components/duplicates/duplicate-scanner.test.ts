import { describe, expect, it } from 'vitest';
import type { DuplicatePage, DuplicateSet, DuplicatesResult } from '../../lib/duplicates-api';
import { DuplicateScanner, MARGIN_MS, type ScanDeps, type ScanState } from './duplicate-scanner';
import { MAX_AUTO_RETRIES } from './duplicates-model';

/**
 * The scanner against a clock and a network the test holds in its hand: no
 * timers, no fetch, no React. Every answer is released by the test, so "an
 * answer after the screen left" and "a retry inside the wait" are things that
 * can be arranged, not hoped for.
 */

const SET = (id: string): DuplicateSet => ({
  matchOn: 'phone',
  contacts: [
    { id: `${id}-a`, displayName: 'a', updatedAt: '2026-10-10T09:00:00Z' },
    { id: `${id}-b`, displayName: 'b', updatedAt: '2026-10-11T09:00:00Z' },
  ],
});

const page = (ids: string[], nextCursor: string | null): DuplicatesResult<DuplicatePage> => ({ ok: true, value: { data: ids.map(SET), nextCursor } });
const limited = (seconds?: number): DuplicatesResult<DuplicatePage> => ({ ok: false, error: { code: 'too_many_requests', ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }) } });

interface Asked {
  readonly programme: string;
  readonly cursor: string | undefined;
  readonly signal: AbortSignal;
  readonly at: number;
  answer: (result: DuplicatesResult<DuplicatePage>) => Promise<void>;
}

function rig() {
  let clock = 1_000_000;
  const asked: Asked[] = [];
  const timers: { id: number; at: number; run: () => void }[] = [];
  const states: ScanState[] = [];
  let next = 1;
  const deps: ScanDeps = {
    list: (programme, cursor, signal) =>
      new Promise((resolve) => {
        asked.push({ programme, cursor, signal, at: clock, answer: async (result) => { resolve(result); await Promise.resolve(); await Promise.resolve(); } });
      }),
    now: () => clock,
    after: (run, ms) => {
      const id = next++;
      timers.push({ id, at: clock + ms, run });
      return id;
    },
    clear: (handle) => {
      const at = timers.findIndex((timer) => timer.id === handle);
      if (at >= 0) timers.splice(at, 1);
    },
  };
  const scanner = new DuplicateScanner((state) => states.push(state), deps);
  /** Moves the clock and runs every timer that has come due, in order. */
  const advance = (ms: number) => {
    const target = clock + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      timers.splice(timers.indexOf(due), 1);
      clock = due.at;
      due.run();
    }
    clock = target;
  };
  return { scanner, asked, timers, states, advance, now: () => clock };
}

describe('the duplicate scan (I2, I3)', () => {
  it('scans once on start, with no cursor, and draws the sets as served', async () => {
    const { scanner, asked } = rig();
    scanner.start('p1');
    expect(scanner.state.phase).toBe('loading');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ programme: 'p1', cursor: undefined });
    await asked[0]?.answer(page(['x', 'y'], 'next'));
    expect(scanner.state).toMatchObject({ phase: 'loaded', nextCursor: 'next', loadingMore: false, throttle: null, failure: null });
    expect(scanner.state.sets).toHaveLength(2);
  });

  it('asks the next page with the cursor exactly as served, appends in order, and never twice at once', async () => {
    const { scanner, asked } = rig();
    scanner.start('p1');
    await asked[0]?.answer(page(['x'], 'opaque=='));
    scanner.more();
    scanner.more();
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatchObject({ programme: 'p1', cursor: 'opaque==' });
    expect(scanner.state.loadingMore).toBe(true);
    await asked[1]?.answer(page(['y'], null));
    expect(scanner.state.sets.map((set) => set.contacts[0]?.id)).toEqual(['x-a', 'y-a']);
    expect(scanner.state.nextCursor).toBeNull();
    scanner.more();
    expect(asked).toHaveLength(2);
  });

  it('does not ask for more before the first page is in, or on a programme with nothing to scan', () => {
    const { scanner, asked } = rig();
    scanner.more();
    scanner.start(null);
    scanner.more();
    expect(asked).toHaveLength(0);
    expect(scanner.state.phase).toBe('idle');
  });

  it('drops a late answer from a programme the person has left, and aborts its request', async () => {
    const { scanner, asked } = rig();
    scanner.start('p1');
    scanner.start('p2');
    expect(asked[0]?.signal.aborted).toBe(true);
    await asked[0]?.answer(page(['stale'], null));
    expect(scanner.state.sets).toEqual([]);
    await asked[1]?.answer(page(['fresh'], null));
    expect(scanner.state.sets.map((set) => set.contacts[0]?.id)).toEqual(['fresh-a']);
  });

  it('aborts and goes quiet on cancel: a late answer paints nothing and no timer survives (the unmount rule)', async () => {
    const { scanner, asked, timers, states } = rig();
    scanner.start('p1');
    scanner.cancel();
    expect(asked[0]?.signal.aborted).toBe(true);
    const seen = states.length;
    await asked[0]?.answer(page(['late'], null));
    expect(states).toHaveLength(seen);

    scanner.start('p1');
    await asked[1]?.answer(limited(5));
    expect(timers).toHaveLength(1);
    scanner.cancel();
    expect(timers).toHaveLength(0);
  });

  it('keeps nothing from one programme’s first page for another’s, cursor included', async () => {
    const { scanner, asked } = rig();
    scanner.start('p1');
    await asked[0]?.answer(page(['x'], 'cursor-1'));
    scanner.start('p2');
    expect(scanner.state).toMatchObject({ phase: 'loading', sets: [], nextCursor: null });
    expect(asked[1]).toMatchObject({ programme: 'p2', cursor: undefined });
  });

  it('says a failed scan in words, keeps the sets already drawn, and lets the next page be tried again', async () => {
    const { scanner, asked } = rig();
    scanner.start('p1');
    await asked[0]?.answer({ ok: false, error: { code: 'network' } });
    expect(scanner.state).toMatchObject({ phase: 'failed', failure: 'records.error.network' });
    scanner.start('p1');
    await asked[1]?.answer(page(['x'], 'c'));
    scanner.more();
    await asked[2]?.answer({ ok: false, error: { code: 'service_unavailable' } });
    expect(scanner.state).toMatchObject({ phase: 'loaded', failure: 'records.error.service_unavailable', nextCursor: 'c', loadingMore: false });
    expect(scanner.state.sets).toHaveLength(1);
    scanner.more();
    expect(asked).toHaveLength(4);
  });
});

describe('a 429 is a wait, not a failure (I3, D-L163)', () => {
  it('is drawn as a wait, never as an empty programme, and asks nothing until Retry-After has passed', async () => {
    const { scanner, asked, advance } = rig();
    scanner.start('p1');
    await asked[0]?.answer(limited(3));
    expect(scanner.state).toMatchObject({ phase: 'loading', sets: [], throttle: { seconds: 3, manual: false, ready: false }, failure: null });
    advance(2_999);
    expect(asked).toHaveLength(1);
    advance(1 + MARGIN_MS);
    expect(asked).toHaveLength(2);
    expect((asked[1]?.at ?? 0) - (asked[0]?.at ?? 0)).toBeGreaterThanOrEqual(3000);
    await asked[1]?.answer(page(['x'], null));
    expect(scanner.state).toMatchObject({ phase: 'loaded', throttle: null });
  });

  it('keeps the sets already drawn when the next page is refused, and asks that page again with its cursor', async () => {
    const { scanner, asked, advance } = rig();
    scanner.start('p1');
    await asked[0]?.answer(page(['x'], 'c1'));
    scanner.more();
    await asked[1]?.answer(limited(2));
    expect(scanner.state.sets).toHaveLength(1);
    expect(scanner.state).toMatchObject({ loadingMore: false, throttle: { seconds: 2 } });
    scanner.more();
    expect(asked).toHaveLength(2);
    advance(2_000 + MARGIN_MS);
    expect(asked[2]).toMatchObject({ cursor: 'c1' });
    await asked[2]?.answer(page(['y'], null));
    expect(scanner.state.sets).toHaveLength(2);
  });

  it('never asks inside the wait, even for another programme: the budget is the user’s', async () => {
    const { scanner, asked, advance } = rig();
    scanner.start('p1');
    await asked[0]?.answer(limited(10));
    scanner.start('p2');
    expect(asked).toHaveLength(1);
    expect(scanner.state.throttle).toMatchObject({ manual: false, ready: false });
    expect(scanner.state.throttle?.seconds).toBeGreaterThan(0);
    advance(10_000 + MARGIN_MS);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatchObject({ programme: 'p2', cursor: undefined });
  });

  it('waits the default when Retry-After says nothing usable', async () => {
    const { scanner, asked } = rig();
    scanner.start('p1');
    await asked[0]?.answer(limited());
    expect(scanner.state.throttle?.seconds).toBe(30);
  });

  it('stops asking by itself after repeated refusals, and offers a retry that is no use until the wait is over', async () => {
    const { scanner, asked, advance } = rig();
    scanner.start('p1');
    for (let refused = 1; refused < MAX_AUTO_RETRIES; refused += 1) {
      await asked[refused - 1]?.answer(limited(1));
      expect(scanner.state.throttle?.manual).toBe(false);
      advance(1_000 + MARGIN_MS);
    }
    await asked[MAX_AUTO_RETRIES - 1]?.answer(limited(4));
    expect(asked).toHaveLength(MAX_AUTO_RETRIES);
    expect(scanner.state.throttle).toEqual({ seconds: 4, manual: true, ready: false });

    scanner.retry();
    expect(asked).toHaveLength(MAX_AUTO_RETRIES);
    advance(60_000);
    expect(asked).toHaveLength(MAX_AUTO_RETRIES);
    expect(scanner.state.throttle).toEqual({ seconds: 4, manual: true, ready: true });

    scanner.retry();
    expect(asked).toHaveLength(MAX_AUTO_RETRIES + 1);
    expect(scanner.state.throttle).toBeNull();
    scanner.retry();
    expect(asked).toHaveLength(MAX_AUTO_RETRIES + 1);
    await asked[MAX_AUTO_RETRIES]?.answer(page(['x'], null));
    expect(scanner.state.phase).toBe('loaded');
  });

  it('counts refusals in a row, so a success starts the count again', async () => {
    const { scanner, asked, advance } = rig();
    scanner.start('p1');
    await asked[0]?.answer(limited(1));
    advance(1_000 + MARGIN_MS);
    await asked[1]?.answer(page(['x'], 'c'));
    scanner.more();
    await asked[2]?.answer(limited(1));
    expect(scanner.state.throttle?.manual).toBe(false);
  });

  it('forgets a manual retry that belongs to a scan the person has left', async () => {
    const { scanner, asked, advance } = rig();
    scanner.start('p1');
    for (let refused = 1; refused <= MAX_AUTO_RETRIES; refused += 1) {
      await asked[refused - 1]?.answer(limited(1));
      advance(1_000 + MARGIN_MS);
    }
    scanner.cancel();
    advance(10_000);
    scanner.retry();
    expect(asked).toHaveLength(MAX_AUTO_RETRIES);
  });
});
