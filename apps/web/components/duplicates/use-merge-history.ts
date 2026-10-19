'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageId } from '@kasuwa/i18n/bundle';
import { listContactMerges, undoContactMerge, type ContactMerge } from '../../lib/duplicates-api';
import { undoRefusal } from './duplicates-model';

/**
 * The merges history (D-P27: the Phase 2 recycle bin), as the API serves it:
 * newest first, `cursor` and `limit` only, no total. In memory only (D-P21).
 *
 * A non-writer's list is empty, not an error ("others see no merges"), and is
 * drawn as the empty history.
 *
 * AN UNDO IS ASKED ONCE. The server's refusal decides what the row offers
 * next: a 410 turns the merge expired (the server's clock wins over the
 * browser's); a 404, a 403 or a 409 takes the control away for good (it stays away across reloads of the list), because asking
 * again cannot change the answer. A dropped connection is the one refusal that
 * leaves the control where it was.
 *
 * Leaving the screen cancels a read in flight; an undo already sent is not
 * cancelled (a half-cancelled write is worse than a late one), and its answer
 * is simply not drawn.
 */

export interface MergeHistory {
  readonly phase: 'loading' | 'loaded' | 'error';
  readonly rows: readonly ContactMerge[];
  readonly nextCursor: string | null;
  readonly loadingMore: boolean;
  /** Merges the server said have expired, whatever the browser's clock says. */
  readonly expired: ReadonlySet<string>;
  /** Merges whose undo was refused: not offered again. */
  readonly closed: ReadonlySet<string>;
  /** The merge whose undo is in flight. */
  readonly undoing: string | null;
  readonly more: () => void;
  readonly reload: () => void;
  readonly undo: (mergeId: string) => void;
}

export function useMergeHistory(callbacks: {
  /** An undo went through: the sets must be read again. */
  readonly onUndone: () => void;
  /** An undo was refused: a sentence, or `null` to clear. */
  readonly onMessage: (message: MessageId | null) => void;
}): MergeHistory {
  const [phase, setPhase] = useState<MergeHistory['phase']>('loading');
  const [rows, setRows] = useState<readonly ContactMerge[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expired, setExpired] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [undoing, setUndoing] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  const sending = useRef(false);
  const generation = useRef(0);
  const cursor = useRef<string | null>(null);
  cursor.current = nextCursor;
  const latest = useRef(callbacks);
  latest.current = callbacks;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    // A reload drops any "show more" still in flight: a stale page 2 never lands on a fresh page 1 (N3).
    generation.current += 1;
    setLoadingMore(false);
    const controller = new AbortController();
    setPhase('loading');
    void listContactMerges(undefined, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setRows(result.value.data);
        setNextCursor(result.value.nextCursor);
        setPhase('loaded');
      } else {
        setPhase('error');
      }
    });
    return () => controller.abort();
  }, [attempt]);

  const more = useCallback(() => {
    const from = cursor.current;
    if (from === null || loadingMore) return;
    setLoadingMore(true);
    const mine = generation.current;
    void listContactMerges(from).then((result) => {
      if (!mounted.current || mine !== generation.current) return;
      setLoadingMore(false);
      if (!result.ok) return;
      setRows((held) => [...held, ...result.value.data]);
      setNextCursor(result.value.nextCursor);
    });
  }, [loadingMore]);

  const undo = useCallback((mergeId: string) => {
    if (sending.current) return;
    sending.current = true;
    setUndoing(mergeId);
    latest.current.onMessage(null);
    void undoContactMerge(mergeId).then((result) => {
      sending.current = false;
      if (!mounted.current) return;
      setUndoing(null);
      if (result.ok) {
        setRows((held) => held.map((row) => (row.id === mergeId ? result.value : row)));
        latest.current.onUndone();
        return;
      }
      const refusal = undoRefusal(result.error);
      latest.current.onMessage(refusal.message);
      if (refusal.effect === 'expired') setExpired((held) => new Set([...held, mergeId]));
      else if (refusal.effect === 'dead') setClosed((held) => new Set([...held, mergeId]));
    });
  }, []);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { phase, rows, nextCursor, loadingMore, expired, closed, undoing, more, reload, undo };
}
