import type { MessageId } from '@kasuwa/i18n/bundle';
import { listDuplicates, type DuplicatePage, type DuplicateSet, type DuplicatesResult } from '../../lib/duplicates-api';
import { throttleStep } from './duplicates-model';

/**
 * The duplicate scan, as a state machine with no React in it, so that the
 * rules a 256 kbps user and a throttled API depend on are tested directly
 * (`duplicate-scanner.test.ts`) and not only seen in a browser.
 *
 * ---------------------------------------------------------------------------
 * EACH PAGE IS A WHOLE-PROGRAMME SCAN (D-L163), SO THIS ASKS SPARINGLY.
 *
 * One scan per `start` (landing, a programme change, a return from a merge),
 * per `more` and per explicit `retry`. There is no polling and no refetch on
 * focus, and two scans are never in flight at once.
 *
 * A 429 is a wait, not a failure and not "no duplicates": the sets already
 * drawn stay, nothing is asked again until `Retry-After` has passed — across a
 * programme change too, because the budget is the user's and not the
 * programme's — and then the scanner asks once more by itself. After
 * `MAX_AUTO_RETRIES` refusals in a row it stops asking and offers a button.
 *
 * `cancel` (leaving the screen, or the programme changing) aborts what is in
 * flight and clears every timer: a late answer never paints one programme's
 * sets over another's, and a timer never fires on a screen that has gone.
 * Everything is in memory only (D-P21).
 * ---------------------------------------------------------------------------
 */

export interface Throttle {
  /** The wait the API asked for, for the sentence. */
  readonly seconds: number;
  /** The scanner has stopped asking by itself: the button is the way on. */
  readonly manual: boolean;
  /** For a manual retry: the wait is over. */
  readonly ready: boolean;
}

export interface ScanState {
  readonly phase: 'idle' | 'loading' | 'loaded' | 'failed';
  readonly sets: readonly DuplicateSet[];
  readonly nextCursor: string | null;
  readonly loadingMore: boolean;
  readonly throttle: Throttle | null;
  /** A sentence for a failed scan (never a 429). */
  readonly failure: MessageId | null;
}

export const IDLE: ScanState = { phase: 'idle', sets: [], nextCursor: null, loadingMore: false, throttle: null, failure: null };

/** A hair past the wait, so a scan never lands inside it on a clock that drifted. */
export const MARGIN_MS = 120;

export interface ScanDeps {
  readonly list: (programmeId: string, cursor: string | undefined, signal: AbortSignal) => Promise<DuplicatesResult<DuplicatePage>>;
  readonly now: () => number;
  readonly after: (run: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const REAL: ScanDeps = {
  list: (programmeId, cursor, signal) => listDuplicates(programmeId, cursor, signal),
  now: () => Date.now(),
  after: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Request {
  readonly programme: string;
  readonly cursor: string | undefined;
  readonly generation: number;
}

export class DuplicateScanner {
  private current: ScanState = IDLE;
  private generation = 0;
  private until = 0;
  private streak = 0;
  private timer: unknown = null;
  private controller: AbortController | null = null;
  private waiting: Request | null = null;
  private programme: string | null = null;

  constructor(
    private readonly onChange: (state: ScanState) => void,
    private readonly deps: ScanDeps = REAL,
  ) {}

  get state(): ScanState {
    return this.current;
  }

  /** A fresh scan from the first page of `programmeId`, dropping whatever was in flight. `null` is nothing to scan. */
  start(programmeId: string | null): void {
    this.cancel();
    this.programme = programmeId;
    if (programmeId === null) {
      this.set(IDLE);
      return;
    }
    this.set({ ...IDLE, phase: 'loading' });
    this.ask({ programme: programmeId, cursor: undefined, generation: this.generation });
  }

  /** The next page, if there is one and nothing is in flight or waiting. */
  more(): void {
    const { programme, current } = this;
    if (programme === null || current.nextCursor === null || current.loadingMore || current.phase === 'loading' || current.throttle !== null) return;
    this.set({ ...current, loadingMore: true, failure: null });
    this.ask({ programme, cursor: current.nextCursor, generation: this.generation });
  }

  /** The button after repeated refusals; nothing happens before its wait is over. */
  retry(): void {
    const held = this.waiting;
    const throttle = this.current.throttle;
    if (held === null || held.generation !== this.generation || throttle === null || !throttle.ready) return;
    this.waiting = null;
    this.set({ ...this.current, throttle: null, loadingMore: held.cursor !== undefined });
    this.ask(held);
  }

  /** Aborts what is in flight and clears every timer. The Retry-After already running is kept: it is the user's. */
  cancel(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.clearTimer();
    this.waiting = null;
  }

  private set(next: ScanState): void {
    this.current = next;
    this.onChange(next);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.deps.clear(this.timer);
    this.timer = null;
  }

  private ask(request: Request): void {
    this.clearTimer();
    this.waiting = null;
    const remaining = this.until - this.deps.now();
    if (remaining > 0) {
      // Still inside a Retry-After: nothing is asked until it has passed.
      this.set({ ...this.current, throttle: { seconds: Math.ceil(remaining / 1000), manual: false, ready: false } });
      this.timer = this.deps.after(() => this.ask(request), remaining + MARGIN_MS);
      return;
    }
    const mine = new AbortController();
    this.controller = mine;
    void this.deps.list(request.programme, request.cursor, mine.signal).then((result) => {
      if (request.generation !== this.generation || mine.signal.aborted) return;
      this.answered(request, result);
    });
  }

  private answered(request: Request, result: DuplicatesResult<DuplicatePage>): void {
    if (result.ok) {
      this.streak = 0;
      this.set({
        phase: 'loaded',
        sets: request.cursor === undefined ? result.value.data : [...this.current.sets, ...result.value.data],
        nextCursor: result.value.nextCursor,
        loadingMore: false,
        throttle: null,
        failure: null,
      });
      return;
    }
    if (result.error.code === 'too_many_requests') {
      this.streak += 1;
      const step = throttleStep(this.streak, result.error, this.deps.now());
      this.until = step.until;
      this.set({ ...this.current, loadingMore: false, throttle: { seconds: step.seconds, manual: step.manual, ready: false }, failure: null });
      if (step.manual) {
        this.waiting = request;
        this.timer = this.deps.after(() => this.becameReady(request), step.seconds * 1000 + MARGIN_MS);
      } else {
        this.timer = this.deps.after(() => this.ask(request), step.seconds * 1000 + MARGIN_MS);
      }
      return;
    }
    this.streak = 0;
    this.set({
      ...this.current,
      phase: this.current.sets.length === 0 ? 'failed' : this.current.phase,
      loadingMore: false,
      throttle: null,
      failure: `records.error.${result.error.code}` as MessageId,
    });
  }

  private becameReady(request: Request): void {
    if (request.generation !== this.generation || this.current.throttle === null) return;
    this.set({ ...this.current, throttle: { ...this.current.throttle, ready: true } });
  }
}
