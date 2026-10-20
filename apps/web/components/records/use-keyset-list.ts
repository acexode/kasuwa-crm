'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordsError, RecordsResult } from '../../lib/records-api';
import { STILL_CONNECTING_MS } from '../../lib/still-connecting';
import { appendPage } from './list-model';

/**
 * A P04 record list as a screen on a 256 kbps link actually has it (P04/06),
 * shared by Contacts (T-0042) and Accounts (T-0057).
 *
 * IN MEMORY, NEVER ON THE DEVICE (D-L64, D-P21). The rows survive a dropped
 * connection because they are still in this component's state — not because
 * they were written to localStorage, IndexedDB or a service-worker cache.
 * Storing personal data on the device is an NDPA decision nobody has made.
 *
 * A SEARCH NEVER ENTERS THE URL. A search term is a phone number or a person's
 * name as often as not (an account name can be a sole trader's, D-L80), and in
 * the address bar it lands in history, bookmarks, screenshots and the Referer
 * of every link followed. The same goes for the cursor.
 *
 * STALE ANSWERS ARE DROPPED, NOT ABORTED. Every request carries a sequence
 * number and only the latest one's answer is applied, so typing "0803" fast
 * cannot paint the "08" answer over the "0803" one.
 *
 * A CURSOR TRAVELS WITH ITS QUERY. "Load more" re-sends the exact query that
 * produced `nextCursor`, never the one in the search box now (the contract's
 * Cursor parameter), and it is hidden while a new query is loading. A new
 * search, filter or sort starts again from the first page.
 *
 * `view` is everything but the search box — filters, a sort — and is compared
 * by IDENTITY: keep it in state and replace it to change it. `fetchPage` must
 * be stable (a module-level function).
 */

export const SEARCH_DEBOUNCE_MS = 300;

export interface KeysetPage<Row> {
  readonly data: readonly Row[];
  readonly nextCursor: string | null;
}

export type FetchPage<Row, View> = (
  q: string,
  view: View,
  cursor?: string,
) => Promise<RecordsResult<KeysetPage<Row>>>;

export interface KeysetList<Row, View> {
  readonly rows: readonly Row[];
  readonly phase: 'loading' | 'loaded' | 'error';
  readonly error: RecordsError | null;
  readonly slow: boolean;
  readonly nextCursor: string | null;
  readonly loadingMore: boolean;
  readonly moreError: RecordsError | null;
  readonly syncedAt: Date | null;
  readonly online: boolean;
  /** The search and view the rows on screen answer — not what is typed now. */
  readonly answered: { readonly q: string; readonly view: View };
  readonly loadMore: () => void;
  readonly reload: () => void;
  /** Applies a write the server confirmed (a create or an update) to the rows held. */
  readonly mutate: (change: (rows: readonly Row[]) => readonly Row[]) => void;
}

export function useKeysetList<Row extends { readonly id: string }, View>(
  q: string,
  view: View,
  fetchPage: FetchPage<Row, View>,
): KeysetList<Row, View> {
  const [debounced, setDebounced] = useState(q);
  const [rows, setRows] = useState<readonly Row[]>([]);
  const [phase, setPhase] = useState<KeysetList<Row, View>['phase']>('loading');
  const [error, setError] = useState<RecordsError | null>(null);
  const [slow, setSlow] = useState(false);
  const [page, setPage] = useState<{ cursor: string | null; q: string; view: View }>({
    cursor: null,
    q: '',
    view,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<RecordsError | null>(null);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [online, setOnline] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const sequence = useRef(0);

  // An emptied box searches at once; typing waits for a pause.
  useEffect(() => {
    if (q.trim() === '') {
      setDebounced('');
      return undefined;
    }
    const timer = setTimeout(() => setDebounced(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    sequence.current += 1;
    const mine = sequence.current;
    setPhase('loading');
    setError(null);
    setSlow(false);
    setMoreError(null);
    setLoadingMore(false);
    const timer = setTimeout(() => {
      if (sequence.current === mine) setSlow(true);
    }, STILL_CONNECTING_MS);

    void fetchPage(debounced, view).then((result) => {
      if (sequence.current !== mine) return;
      clearTimeout(timer);
      setSlow(false);
      if (result.ok) {
        setRows(result.value.data);
        setPage({ cursor: result.value.nextCursor, q: debounced, view });
        setSyncedAt(new Date());
        setPhase('loaded');
      } else {
        setRows([]);
        setPage({ cursor: null, q: debounced, view });
        setError(result.error);
        setPhase('error');
      }
    });

    return () => clearTimeout(timer);
  }, [debounced, view, attempt, fetchPage]);

  const loadMore = useCallback(() => {
    if (page.cursor === null || loadingMore) return;
    const mine = sequence.current;
    setLoadingMore(true);
    setMoreError(null);
    void fetchPage(page.q, page.view, page.cursor).then((result) => {
      if (sequence.current !== mine) return;
      setLoadingMore(false);
      if (result.ok) {
        setRows((current) => appendPage(current, result.value.data));
        setPage((current) => ({ ...current, cursor: result.value.nextCursor }));
        setSyncedAt(new Date());
      } else {
        setMoreError(result.error);
      }
    });
  }, [page, loadingMore, fetchPage]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  const mutate = useCallback((change: (rows: readonly Row[]) => readonly Row[]) => setRows(change), []);

  return {
    rows,
    phase,
    error,
    slow,
    nextCursor: phase === 'loaded' ? page.cursor : null,
    loadingMore,
    moreError,
    syncedAt,
    online,
    answered: { q: page.q, view: page.view },
    loadMore,
    reload,
    mutate,
  };
}
