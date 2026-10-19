import { retryAfterMs } from './retry-after';

/**
 * The bell's poller (T-0101, I5-I7), with no React, no `window` and no
 * `fetch`: everything it touches is handed in, so every rule below is a unit
 * test on a fake clock rather than a hope.
 *
 *   - one read on start, then one every `CADENCE_MS` while the tab is visible;
 *     the contract says 30 s and the task file 60 s (C1), so 45 s;
 *   - hidden: no timer and no read. Shown again (visibilitychange and focus
 *     both say so): a read at once, but never two within `WAKE_COALESCE_MS`,
 *     so ten focus events in a second are one read;
 *   - a 429 waits the WHOLE `Retry-After`, even past the cadence, and a wake
 *     cannot cut it short; it is not a failure and does not grow the back-off;
 *   - a 5xx or a network failure waits `CADENCE_MS * 2^n`, never less than the
 *     cadence, never more than five minutes, and never gives up; one success
 *     returns to the cadence;
 *   - A WAKE THAT DECLINES STILL SCHEDULES. Pausing clears the timer, so a
 *     wake that is turned away (inside the coalescing window, or while a 429's
 *     wait runs) must set the next read itself, for the time that is left:
 *     otherwise the poller would never read again (B1, D-L179).
 *   - a read is requested for "the newest truth" with `refresh()` (after a
 *     local change a stale answer was dropped): it obeys a 429's wait but not
 *     the failure back-off or the wake coalescing.
 */

export const CADENCE_MS = 45_000;
export const BACKOFF_CAP_MS = 300_000;
export const WAKE_COALESCE_MS = 5_000;
export { RETRY_AFTER_CAP_MS, retryAfterMs } from './retry-after';

export type PollOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'throttled'; readonly retryAfterSeconds?: number | undefined }
  | { readonly kind: 'failed' }
  /** The read was aborted by `stop()`: nothing more is scheduled. */
  | { readonly kind: 'aborted' };

export interface Wait {
  readonly waitMs: number;
  /** Consecutive failures after this outcome. */
  readonly failures: number;
  /** Set only for a 429: reads (wake or refresh included) are not allowed before this wait is over. */
  readonly hold: boolean;
}

/** How long to wait after `outcome`, given the failures before it. */
export function waitAfter(outcome: PollOutcome, failures: number): Wait {
  switch (outcome.kind) {
    case 'ok':
    case 'aborted':
      return { waitMs: CADENCE_MS, failures: 0, hold: false };
    case 'throttled': {
      return { waitMs: Math.max(CADENCE_MS, retryAfterMs(outcome.retryAfterSeconds, CADENCE_MS)), failures, hold: true };
    }
    case 'failed': {
      const next = failures + 1;
      return { waitMs: Math.min(BACKOFF_CAP_MS, CADENCE_MS * 2 ** Math.min(next, 10)), failures: next, hold: false };
    }
  }
}

/** Whether showing or focusing the tab should read now. */
export function shouldReadOnWake(input: {
  readonly visible: boolean;
  readonly now: number;
  readonly lastStartedAt: number | null;
  readonly inFlight: boolean;
  readonly heldUntil: number;
}): boolean {
  if (!input.visible || input.inFlight || input.now < input.heldUntil) return false;
  return input.lastStartedAt === null || input.now - input.lastStartedAt >= WAKE_COALESCE_MS;
}

export interface PollerEnv {
  /** One read of the count; the caller applies its answer. It must resolve, never throw. */
  readonly read: (signal: AbortSignal) => Promise<PollOutcome>;
  readonly now: () => number;
  readonly setTimer: (run: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly isVisible: () => boolean;
}

export interface Poller {
  start(): void;
  stop(): void;
  /** The tab became visible or focused. */
  wake(): void;
  /** The tab was hidden: pause. */
  pause(): void;
  /** Read the newest truth as soon as a 429's wait allows. */
  refresh(): void;
}

export function createPoller(env: PollerEnv): Poller {
  let running = false;
  let timer: unknown = null;
  let controller: AbortController | null = null;
  let failures = 0;
  let heldUntil = 0;
  let lastStartedAt: number | null = null;
  let refreshWanted = false;
  /** When the schedule says the next read is due: the last read's wait, absolute. Survives a pause. */
  let nextDue = 0;

  const clear = (): void => {
    if (timer !== null) env.clearTimer(timer);
    timer = null;
  };

  const schedule = (ms: number): void => {
    clear();
    if (!running || !env.isVisible()) return;
    timer = env.setTimer(() => {
      timer = null;
      if (running && env.isVisible()) void readNow();
    }, ms);
  };

  async function readNow(): Promise<void> {
    clear();
    if (!running || controller !== null) return;
    refreshWanted = false;
    const mine = new AbortController();
    controller = mine;
    lastStartedAt = env.now();
    const outcome = await env.read(mine.signal);
    if (controller === mine) controller = null;
    if (!running || outcome.kind === 'aborted') return;
    const wait = waitAfter(outcome, failures);
    failures = wait.failures;
    heldUntil = wait.hold ? env.now() + wait.waitMs : 0;
    nextDue = env.now() + wait.waitMs;
    if (refreshWanted) {
      schedule(wait.hold ? wait.waitMs : 0);
      return;
    }
    schedule(wait.waitMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      if (env.isVisible()) void readNow();
    },
    stop() {
      running = false;
      clear();
      controller?.abort();
      controller = null;
    },
    wake() {
      if (!running) return;
      const now = env.now();
      if (shouldReadOnWake({ visible: env.isVisible(), now, lastStartedAt, inFlight: controller !== null, heldUntil })) {
        void readNow();
      } else if (env.isVisible() && controller === null && timer === null) {
        // Turned away: pause() had cleared the timer, so put the next read back, no earlier than what held it off.
        schedule(Math.max(0, Math.max(nextDue, heldUntil, (lastStartedAt ?? now) + WAKE_COALESCE_MS) - now));
      }
    },
    pause() {
      clear();
    },
    refresh() {
      if (!running) return;
      refreshWanted = true;
      if (controller !== null) return;
      const remaining = heldUntil - env.now();
      if (remaining > 0) schedule(remaining);
      else void readNow();
    },
  };
}
