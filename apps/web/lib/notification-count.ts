import type { UnreadCount } from './notifications-api';

/**
 * The bell's count as a pure state machine (T-0101, I4, I7, I11, I19).
 *
 * The server's count is capped at 99 and may undercount past 500, so it is
 * never treated as an exact total: `capped` means "more than 99", drawn "99+".
 * Every transition is a function here, so the rules that are easy to get
 * subtly wrong (a stale answer, a fall announced, the first count announced)
 * are unit tests.
 */

export interface CountState {
  /** `false` until the first answer: the badge draws nothing, and nothing is announced. */
  readonly known: boolean;
  readonly count: number;
  readonly capped: boolean;
  /** Bumped by every LOCAL change and every write SENT; a read that began before the latest bump is stale. */
  readonly epoch: number;
  /** Writes sent and not yet answered. While there is one, no count read is believed (N1). */
  readonly pending: number;
}

export const INITIAL_COUNT: CountState = { known: false, count: 0, capped: false, epoch: 0, pending: 0 };

/** The badge text: nothing at 0, the number to 99 exactly, "99+" when more (the cap is the contract's). */
export function badgeLabel(state: CountState): string {
  if (!state.known || (state.count === 0 && !state.capped)) return '';
  return state.capped ? `${state.count}+` : String(state.count);
}

/** A server answer for a read that STARTED at `startedEpoch`; dropped when a local change came since (latest answer wins). */
export function applyServerCount(state: CountState, answer: UnreadCount, startedEpoch: number): CountState {
  // A read that overlaps a write (begun before it was sent, or answered while it is in flight) saw the state on one side of it: it is dropped.
  if (startedEpoch !== state.epoch || state.pending > 0) return state;
  if (state.known && state.count === answer.count && state.capped === answer.capped) return state;
  return { ...state, known: true, count: answer.count, capped: answer.capped };
}

/** A write is about to be sent: reads in flight are outdated, and none is believed until it is answered (N1). */
export function beginWrite(state: CountState): CountState {
  return { ...state, epoch: state.epoch + 1, pending: state.pending + 1 };
}

/** A write was answered (or given up on): the next read is believed again. */
export function endWrite(state: CountState): CountState {
  return { ...state, epoch: state.epoch + 1, pending: Math.max(0, state.pending - 1) };
}

/** A local change that carries the server's own answer (a mark-all): authoritative, and it outdates every read in flight. */
export function applyLocalCount(state: CountState, answer: UnreadCount): CountState {
  return { ...state, known: true, count: answer.count, capped: answer.capped, epoch: state.epoch + 1 };
}

/**
 * One item marked read (`delta` -1) or unread (+1) by the reader. Exact only
 * when the count is not capped; a capped count stays capped and needs a re-read
 * (`needsReread`).
 */
export function applyLocalStep(state: CountState, delta: -1 | 1): CountState {
  const epoch = state.epoch + 1;
  if (!state.known || state.capped) return { ...state, epoch };
  return { ...state, count: Math.max(0, state.count + delta), epoch };
}

/** A capped count cannot be stepped, so it is read again. */
export function needsReread(state: CountState): boolean {
  return !state.known || state.capped;
}

/** "More than 99" outranks 99, which outranks 98. */
function rank(state: Pick<CountState, 'count' | 'capped'>): number {
  return state.capped ? state.count + 1 : state.count;
}

/**
 * Whether going from `before` to `after` is announced: only a RISE, and never
 * the first count of a page (`before.known` false), an unchanged one or a fall.
 */
export function isRise(before: CountState, after: CountState): boolean {
  return before.known && after.known && rank(after) > rank(before);
}
