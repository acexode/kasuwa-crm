import { INITIAL_COUNT, applyLocalCount, applyLocalStep, applyServerCount, needsReread, type CountState } from './notification-count';
import { createPoller, type PollOutcome, type Poller } from './notification-poller';
import { getUnreadCount, type UnreadCount } from './notifications-api';

/**
 * The unread count, shared by everything on a page that shows it (T-0101, I5).
 *
 * ONE POLLER PER PAGE however many bells are drawn: the first subscriber starts
 * it and the last one stops it, so a shell drawn twice (a phone and a desktop
 * top bar in one tree) or a bell beside the centre never doubles the reads. A
 * page change in the CRM remounts the shell; the stop is deferred one tick so a
 * remount keeps the poller and its cadence instead of reading again.
 *
 * The count is held in this module's memory ONLY, never on the device (D-P21).
 * The state machine is `notification-count.ts` and the cadence is
 * `notification-poller.ts`; this file only wires them to the browser.
 */

let state: CountState = INITIAL_COUNT;
const listeners = new Set<() => void>();
let poller: Poller | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;
let detach: (() => void) | null = null;

function set(next: CountState): void {
  if (next === state) return;
  state = next;
  for (const listener of [...listeners]) listener();
}

async function read(signal: AbortSignal): Promise<PollOutcome> {
  const startedEpoch = state.epoch;
  const result = await getUnreadCount(signal);
  if (signal.aborted) return { kind: 'aborted' };
  if (result.ok) {
    set(applyServerCount(state, result.value, startedEpoch));
    return { kind: 'ok' };
  }
  // A failure, or a 429, never clears or changes what is drawn.
  return result.error.code === 'too_many_requests'
    ? { kind: 'throttled', retryAfterSeconds: result.error.retryAfterSeconds }
    : { kind: 'failed' };
}

function attach(): () => void {
  const created = createPoller({
    read,
    now: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    isVisible: () => document.visibilityState !== 'hidden',
  });
  poller = created;
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') created.pause();
    else created.wake();
  };
  const onFocus = (): void => created.wake();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  created.start();
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    created.stop();
    poller = null;
  };
}

export function subscribeCount(listener: () => void): () => void {
  listeners.add(listener);
  if (stopTimer !== null) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  if (detach === null) detach = attach();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || stopTimer !== null) return;
    stopTimer = setTimeout(() => {
      stopTimer = null;
      if (listeners.size === 0) {
        detach?.();
        detach = null;
      }
    }, 0);
  };
}

export function countSnapshot(): CountState {
  return state;
}

export function countServerSnapshot(): CountState {
  return INITIAL_COUNT;
}

/** The reader marked one item read (-1) or unread (+1) and the server agreed: the badge follows at once. */
export function stepCount(delta: -1 | 1): void {
  set(applyLocalStep(state, delta));
  if (needsReread(state)) poller?.refresh();
}

/** A server answer that is itself the new count (a mark-all). It outdates any read in flight. */
export function setCount(answer: UnreadCount): void {
  set(applyLocalCount(state, answer));
}

/** Read the count again, when the server allows (after a lost answer). */
export function refreshCount(): void {
  poller?.refresh();
}
