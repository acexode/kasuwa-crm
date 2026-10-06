'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { listContacts, type Contact, type RecordsError } from '../../lib/records-api';
import { toListQuery, type FilterState } from './contacts-model';
import { STILL_CONNECTING_MS } from '../admin/use-resource';

/**
 * The contacts list as a screen on a 256 kbps link actually has it (P04/06).
 *
 * IN MEMORY, NEVER ON THE DEVICE (D-L64). The rows survive a dropped
 * connection because they are still in this component's state — not because
 * they were written to localStorage, IndexedDB or a service-worker cache.
 * Storing personal data on the device is an NDPA decision nobody has made.
 *
 * A SEARCH NEVER ENTERS THE URL. `q` is a phone number as often as a name, and
 * in the address bar it lands in history, bookmarks, screenshots and the
 * Referer of every link followed.
 *
 * STALE ANSWERS ARE DROPPED, NOT ABORTED. Every request carries a sequence
 * number and only the latest one's answer is applied, so typing "0803" fast
 * cannot paint the "08" answer over the "0803" one.
 *
 * A CURSOR TRAVELS WITH ITS QUERY. "Load more" re-sends the exact query that
 * produced `nextCursor`, never the one in the search box now (the contract's
 * Cursor parameter), and it is hidden while a new query is loading.
 */

export const SEARCH_DEBOUNCE_MS = 300;

export interface ContactList {
  readonly rows: readonly Contact[];
  readonly phase: 'loading' | 'loaded' | 'error';
  readonly error: RecordsError | null;
  readonly slow: boolean;
  readonly nextCursor: string | null;
  readonly loadingMore: boolean;
  readonly moreError: RecordsError | null;
  readonly syncedAt: Date | null;
  readonly online: boolean;
  /** The search and filters the rows on screen answer — not what is typed now. */
  readonly answered: { readonly q: string; readonly filters: FilterState };
  readonly loadMore: () => void;
  readonly reload: () => void;
}

export function useContactList(q: string, filters: FilterState): ContactList {
  const [debounced, setDebounced] = useState(q);
  const [rows, setRows] = useState<readonly Contact[]>([]);
  const [phase, setPhase] = useState<ContactList['phase']>('loading');
  const [error, setError] = useState<RecordsError | null>(null);
  const [slow, setSlow] = useState(false);
  const [page, setPage] = useState<{ cursor: string | null; q: string; filters: FilterState }>({
    cursor: null,
    q: '',
    filters,
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

    void listContacts(toListQuery(debounced, filters)).then((result) => {
      if (sequence.current !== mine) return;
      clearTimeout(timer);
      setSlow(false);
      if (result.ok) {
        setRows(result.value.data);
        setPage({ cursor: result.value.nextCursor, q: debounced, filters });
        setSyncedAt(new Date());
        setPhase('loaded');
      } else {
        setRows([]);
        setPage({ cursor: null, q: debounced, filters });
        setError(result.error);
        setPhase('error');
      }
    });

    return () => clearTimeout(timer);
  }, [debounced, filters, attempt]);

  const loadMore = useCallback(() => {
    if (page.cursor === null || loadingMore) return;
    const mine = sequence.current;
    setLoadingMore(true);
    setMoreError(null);
    void listContacts(toListQuery(page.q, page.filters, page.cursor)).then((result) => {
      if (sequence.current !== mine) return;
      setLoadingMore(false);
      if (result.ok) {
        setRows((current) => [...current, ...result.value.data]);
        setPage((current) => ({ ...current, cursor: result.value.nextCursor }));
        setSyncedAt(new Date());
      } else {
        setMoreError(result.error);
      }
    });
  }, [page, loadingMore]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

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
    answered: { q: page.q, filters: page.filters },
    loadMore,
    reload,
  };
}
