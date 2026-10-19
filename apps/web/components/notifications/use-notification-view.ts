'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { refreshCount, setCount, stepCount } from '../../lib/notification-store';
import { DEFAULT_WAIT_MS, INITIAL_VIEW, RESEND_DELAYS_MS, shouldContinue, viewReducer, type ViewState } from '../../lib/notification-view';
import { listNotifications, markAllRead, updateNotification, type NotificationFilter, type NotificationItem, type NotificationKind } from '../../lib/notifications-api';
import type { RecordsResult } from '../../lib/records-api';

/**
 * Drives one drawn list (the dropdown's or the centre's) against the four
 * operations. Every decision about what is drawn is `viewReducer`'s; this
 * hook performs the requests and dispatches what came back.
 *
 *   - READS ARE ABORTED when the view is left or its query changes (D-L171
 *     B1): nothing surfaces after. WRITES ARE NOT: a mark-read begun by opening
 *     a link must finish after the page has gone.
 *   - A WRITE IS DRAWN WHEN IT IS ANSWERED, never ahead of it. A lost answer (a
 *     network failure, whether or not it applied) is found out by sending THE
 *     SAME idempotent request again, twice at most and inside ten seconds
 *     (D-L171 N2): a lost mark-read is never undone with a mark-unread, and a
 *     read-all resend never widens its bound. The answer then carries the
 *     server's truth.
 *   - A 429 is a wait. The list retries by itself when `Retry-After` is over
 *     (the same cursor); a write is not resent by itself, it is the reader's.
 */

interface Query {
  readonly filter: NotificationFilter;
  readonly kind: NotificationKind | null;
  readonly limit: number;
}

export interface NotificationView {
  readonly state: ViewState;
  readonly loadMore: () => void;
  readonly reload: () => void;
  readonly toggle: (item: NotificationItem) => void;
  /** Opening an item's link: marks it read on the way, never unread. */
  readonly open: (item: NotificationItem) => void;
  readonly readAll: () => void;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** One write, sent again with the same body when its answer was lost. */
async function sendWithResends<T>(run: () => Promise<RecordsResult<T>>): Promise<RecordsResult<T>> {
  let result = await run();
  for (const delay of RESEND_DELAYS_MS) {
    if (result.ok || result.error.code !== 'network') return result;
    await sleep(delay);
    result = await run();
  }
  return result;
}

function waitFrom(retryAfterSeconds: number | undefined): number {
  return Date.now() + (retryAfterSeconds === undefined ? DEFAULT_WAIT_MS : retryAfterSeconds * 1000);
}

export function useNotificationView(query: Query, autoContinue: boolean): NotificationView {
  const [state, dispatch] = useReducer(viewReducer, INITIAL_VIEW);
  const stateRef = useRef<ViewState>(state);
  stateRef.current = state;
  const queryRef = useRef(query);
  queryRef.current = query;
  const controller = useRef<AbortController | null>(null);
  const moving = useRef(false);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const later = useCallback((run: () => void, at: number) => {
    const handle = setTimeout(() => {
      timers.current.delete(handle);
      run();
    }, Math.max(0, at - Date.now()));
    timers.current.add(handle);
  }, []);

  const loadFirst = useCallback(() => {
    controller.current?.abort();
    const mine = new AbortController();
    controller.current = mine;
    moving.current = false;
    const { filter, kind, limit } = queryRef.current;
    void listNotifications({ filter, ...(kind === null ? {} : { kind }), limit }, mine.signal).then((result) => {
      if (mine.signal.aborted) return;
      if (result.ok) {
        dispatch({ type: 'first-loaded', page: result.value });
      } else if (result.error.code === 'too_many_requests') {
        const until = waitFrom(result.error.retryAfterSeconds);
        dispatch({ type: 'list-wait', until });
        later(() => {
          if (mine.signal.aborted) return;
          dispatch({ type: 'list-wait-over' });
          loadFirst();
        }, until);
      } else {
        dispatch({ type: 'read-failed', code: result.error.code });
      }
    });
  }, [later]);

  /** `afterWait`: called when a 429's wait is over, so the stale `listWaitUntil` in the last render does not block the retry. */
  const loadMore = useCallback((afterWait = false) => {
    const current = stateRef.current;
    const cursor = current.nextCursor;
    const signal = controller.current?.signal;
    if (cursor === null || signal === undefined || signal.aborted || moving.current || (!afterWait && current.listWaitUntil !== null)) return;
    moving.current = true;
    dispatch({ type: 'more-start' });
    const { filter, kind, limit } = queryRef.current;
    void listNotifications({ filter, ...(kind === null ? {} : { kind }), cursor, limit }, signal).then((result) => {
      moving.current = false;
      if (signal.aborted) return;
      if (result.ok) {
        dispatch({ type: 'more-loaded', page: result.value });
      } else if (result.error.code === 'too_many_requests') {
        const until = waitFrom(result.error.retryAfterSeconds);
        dispatch({ type: 'list-wait', until });
        later(() => {
          if (signal.aborted) return;
          dispatch({ type: 'list-wait-over' });
          loadMore(true);
        }, until);
      } else {
        dispatch({ type: 'read-failed', code: result.error.code });
      }
    });
  }, [later]);

  // A new query starts from the top, with no cursor carried over (I9). Leaving aborts the read in flight.
  useEffect(() => {
    const pending = timers.current;
    dispatch({ type: 'reset' });
    loadFirst();
    return () => {
      controller.current?.abort();
      controller.current = null;
      for (const handle of pending) clearTimeout(handle);
      pending.clear();
    };
  }, [query.filter, query.kind, query.limit, loadFirst]);

  // A page that is empty but not the last continues by itself: the way on is never a dead end.
  useEffect(() => {
    if (autoContinue && shouldContinue(state, Date.now())) loadMore();
  }, [autoContinue, state, loadMore]);

  const writeBlocked = (): boolean => {
    const until = stateRef.current.writeWaitUntil;
    return until !== null && until > Date.now();
  };

  const afterWriteFailure = useCallback(
    (code: string, retryAfterSeconds: number | undefined) => {
      if (code === 'too_many_requests') {
        const until = waitFrom(retryAfterSeconds);
        dispatch({ type: 'write-wait', until });
        later(() => dispatch({ type: 'write-wait-over' }), until);
        return;
      }
      dispatch({ type: 'write-failed', code });
      // Whether it applied is unknown: the count is read again, and the next page read shows the rest.
      refreshCount();
    },
    [later],
  );

  const setRead = useCallback(
    (item: NotificationItem, read: boolean) => {
      const drawn = stateRef.current.items.find((row) => row.id === item.id);
      if (drawn === undefined || stateRef.current.busyIds.includes(item.id) || writeBlocked()) return;
      const wasUnread = drawn.readAt === null;
      dispatch({ type: 'busy', id: item.id, on: true });
      void sendWithResends(() => updateNotification(item.id, read)).then((result) => {
        dispatch({ type: 'busy', id: item.id, on: false });
        if (result.ok) {
          dispatch({ type: 'item-state', id: item.id, readAt: result.value.readAt });
          const nowUnread = result.value.readAt === null;
          if (wasUnread && !nowUnread) stepCount(-1);
          else if (!wasUnread && nowUnread) stepCount(1);
        } else if (result.error.code === 'not_found') {
          // Gone from the reader's view: drawn no more, never sent again, and nothing said about why.
          dispatch({ type: 'item-gone', id: item.id });
          if (wasUnread) stepCount(-1);
        } else {
          afterWriteFailure(result.error.code, result.error.retryAfterSeconds);
        }
      });
    },
    [afterWriteFailure],
  );

  const toggle = useCallback((item: NotificationItem) => setRead(item, item.readAt === null), [setRead]);
  const open = useCallback(
    (item: NotificationItem) => {
      if (item.readAt === null) setRead(item, true);
    },
    [setRead],
  );

  const readAll = useCallback(() => {
    const current = stateRef.current;
    const throughId = current.headId;
    if (throughId === null || current.allBusy || writeBlocked()) return;
    const kind = queryRef.current.kind;
    // One body, built once: a resend is the same bounded request, never a wider one (D-L154).
    const body = { throughId, ...(kind === null ? {} : { kind }) };
    dispatch({ type: 'all-busy', on: true });
    void sendWithResends(() => markAllRead(body)).then((result) => {
      dispatch({ type: 'all-busy', on: false });
      if (result.ok) {
        setCount(result.value);
        dispatch({ type: 'all-read', kind, readAt: new Date().toISOString() });
      } else {
        afterWriteFailure(result.error.code, result.error.retryAfterSeconds);
      }
    });
  }, [afterWriteFailure]);

  // Not `loadMore` itself: an `onClick` would hand it the event as `afterWait`.
  const more = useCallback(() => loadMore(), [loadMore]);

  return { state, loadMore: more, reload: loadFirst, toggle, open, readAll };
}
