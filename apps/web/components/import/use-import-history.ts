'use client';

import { useCallback, useEffect, useState } from 'react';
import { listImports, listMyProgrammes, type ImportSummary, type Programme } from '../../lib/imports-api';

/**
 * The two reads the landing needs: the session's programmes (the target of an
 * import, and the names in the history) and the past imports, newest first.
 * Both in memory only (D-P21), both read from the browser so the loading and
 * failed states are the user's to see. `reload` reads the history again
 * (after an import, when the landing comes back).
 */
export interface ImportHistory {
  readonly phase: 'loading' | 'loaded' | 'error';
  readonly rows: readonly ImportSummary[];
  readonly nextCursor: string | null;
  readonly loadingMore: boolean;
  readonly loadMore: () => void;
  readonly reload: () => void;
}

export interface ProgrammeList {
  readonly phase: 'loading' | 'loaded' | 'error';
  readonly programmes: readonly Programme[];
}

export function useProgrammes(): ProgrammeList {
  const [state, setState] = useState<ProgrammeList>({ phase: 'loading', programmes: [] });
  useEffect(() => {
    const controller = new AbortController();
    void listMyProgrammes(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setState(result.ok ? { phase: 'loaded', programmes: result.value } : { phase: 'error', programmes: [] });
    });
    return () => controller.abort();
  }, []);
  return state;
}

export function useImportHistory(): ImportHistory {
  const [phase, setPhase] = useState<ImportHistory['phase']>('loading');
  const [rows, setRows] = useState<readonly ImportSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setPhase('loading');
    void listImports(undefined, controller.signal).then((result) => {
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

  const loadMore = useCallback(() => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    void listImports(nextCursor).then((result) => {
      setLoadingMore(false);
      if (!result.ok) return;
      setRows((held) => [...held, ...result.value.data]);
      setNextCursor(result.value.nextCursor);
    });
  }, [nextCursor, loadingMore]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { phase, rows, nextCursor, loadingMore, loadMore, reload };
}
