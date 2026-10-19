import { appendPage, markAllCovered, removeItem, setItemState } from './notification-model';
import type { NotificationItem, NotificationKind, NotificationPage } from './notifications-api';

/**
 * The state of one drawn list, the dropdown's or the centre's (T-0101), as a
 * pure reducer: what a read, a page, a write, a 404 and a throttle do to what
 * the reader sees. The hook that drives it only performs requests and
 * dispatches; every rule that decides what is drawn is here and is tested.
 *
 * Three rules shape it:
 *   - NOTHING IS DRAWN BEFORE THE SERVER SAYS SO. A write is shown when it is
 *     answered, never ahead of it, so a refused or lost write cannot leave the
 *     list lying (I11, I13, I14).
 *   - A SHORT OR EMPTY PAGE WITH A CURSOR IS NOT THE END. The first page is
 *     "empty" (B2) only when it is empty AND `nextCursor` is null (I9).
 *   - A THROTTLE IS A WAIT, NOT AN ERROR. It never replaces what is drawn.
 */

export type ViewPhase = 'loading' | 'ready' | 'failed';

export interface ViewState {
  readonly items: readonly NotificationItem[];
  readonly nextCursor: string | null;
  /** The newest notification the server served for this view: a mark-all's bound (D-L154). */
  readonly headId: string | null;
  readonly phase: ViewPhase;
  readonly loadingMore: boolean;
  /** A read failed (not a 429): the code to translate, for the first page or the next one. */
  readonly readError: string | null;
  /** A write failed after its resends: the code to translate. */
  readonly writeError: string | null;
  /** The earliest time (ms since the epoch) the list may be asked again after a 429, or `null`. */
  readonly listWaitUntil: number | null;
  /** The earliest time a write may be sent again after a 429, or `null`. */
  readonly writeWaitUntil: number | null;
  /** Ids with a write in flight (the dot is busy), and whether a mark-all is. */
  readonly busyIds: readonly string[];
  readonly allBusy: boolean;
}

export const INITIAL_VIEW: ViewState = {
  items: [],
  nextCursor: null,
  headId: null,
  phase: 'loading',
  loadingMore: false,
  readError: null,
  writeError: null,
  listWaitUntil: null,
  writeWaitUntil: null,
  busyIds: [],
  allBusy: false,
};

export type ViewAction =
  | { readonly type: 'reset' }
  | { readonly type: 'first-loaded'; readonly page: NotificationPage }
  | { readonly type: 'more-start' }
  | { readonly type: 'more-loaded'; readonly page: NotificationPage }
  | { readonly type: 'read-failed'; readonly code: string }
  | { readonly type: 'list-wait'; readonly until: number }
  | { readonly type: 'list-wait-over' }
  | { readonly type: 'write-wait'; readonly until: number }
  | { readonly type: 'write-wait-over' }
  | { readonly type: 'busy'; readonly id: string; readonly on: boolean }
  | { readonly type: 'all-busy'; readonly on: boolean }
  | { readonly type: 'item-state'; readonly id: string; readonly readAt: string | null }
  | { readonly type: 'item-gone'; readonly id: string }
  | { readonly type: 'all-read'; readonly kind: NotificationKind | null; readonly readAt: string }
  | { readonly type: 'write-failed'; readonly code: string }
  | { readonly type: 'write-ok' };

export function viewReducer(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case 'reset':
      return { ...INITIAL_VIEW };
    case 'first-loaded':
      return {
        ...state,
        items: action.page.items,
        nextCursor: action.page.nextCursor,
        headId: action.page.headId,
        phase: 'ready',
        loadingMore: false,
        readError: null,
        listWaitUntil: null,
      };
    case 'more-start':
      return { ...state, loadingMore: true, readError: null };
    case 'more-loaded':
      return {
        ...state,
        items: appendPage(state.items, action.page.items),
        nextCursor: action.page.nextCursor,
        // The head is the newest the view ever drew: a later page cannot move it.
        headId: state.headId ?? action.page.headId,
        loadingMore: false,
        listWaitUntil: null,
      };
    case 'read-failed':
      // Drawn items stay. Only a first page that never arrived is a failed view.
      return { ...state, phase: state.phase === 'ready' ? 'ready' : 'failed', loadingMore: false, readError: action.code };
    case 'list-wait':
      return { ...state, loadingMore: false, listWaitUntil: action.until };
    case 'list-wait-over':
      return { ...state, listWaitUntil: null };
    case 'write-wait':
      return { ...state, writeWaitUntil: action.until };
    case 'write-wait-over':
      return { ...state, writeWaitUntil: null };
    case 'busy':
      return { ...state, busyIds: action.on ? [...state.busyIds.filter((id) => id !== action.id), action.id] : state.busyIds.filter((id) => id !== action.id) };
    case 'all-busy':
      return { ...state, allBusy: action.on };
    case 'item-state':
      return { ...state, items: setItemState(state.items, action.id, action.readAt), writeError: null };
    case 'item-gone':
      return { ...state, items: removeItem(state.items, action.id) };
    case 'all-read':
      return { ...state, items: markAllCovered(state.items, action.kind, action.readAt), writeError: null };
    case 'write-failed':
      return { ...state, writeError: action.code };
    case 'write-ok':
      return { ...state, writeError: null, writeWaitUntil: null };
  }
}

/** B2: the first page is empty and final. A page that is empty with a cursor is not the end. */
export function isEmptyForever(state: ViewState): boolean {
  return state.phase === 'ready' && state.items.length === 0 && state.nextCursor === null;
}

/** An empty page that is not the last: the view continues by itself, once. */
export function shouldContinue(state: ViewState, now: number): boolean {
  return state.phase === 'ready' && state.items.length === 0 && state.nextCursor !== null && !state.loadingMore && state.readError === null && (state.listWaitUntil === null || state.listWaitUntil <= now);
}

/** The wait to show after a 429, in whole seconds from `now`, never below one. */
export function waitSeconds(until: number | null, now: number): number {
  return until === null ? 0 : Math.max(1, Math.ceil((until - now) / 1000));
}

/** The default wait when a 429 carries no `Retry-After`. */
export const DEFAULT_WAIT_MS = 5_000;

/** The delays before each resend of a write whose answer was lost: both inside the ten seconds I14 allows. */
export const RESEND_DELAYS_MS: readonly number[] = [1_000, 3_000];
