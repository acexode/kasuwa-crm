'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { listMyProgrammes, type Programme } from '../../lib/duplicates-api';
import { DuplicateScanner, IDLE, type ScanState } from './duplicate-scanner';

/**
 * The two reads the landing needs before any set can be drawn: the session's
 * programmes (the scan's target is one of the caller's own, in the path, D-L148)
 * and that programme's duplicate sets. The rules of the scan, and of the 429
 * wait, are `DuplicateScanner`'s (`duplicate-scanner.ts`); this hook only gives
 * it a React lifecycle: a programme change or `reload` starts a fresh scan, and
 * leaving the screen cancels what is in flight.
 */

export interface ProgrammeList {
  readonly phase: 'loading' | 'loaded' | 'error';
  readonly programmes: readonly Programme[];
  readonly reload: () => void;
}

export function useProgrammes(): ProgrammeList {
  const [state, setState] = useState<Pick<ProgrammeList, 'phase' | 'programmes'>>({ phase: 'loading', programmes: [] });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: 'loading', programmes: [] });
    void listMyProgrammes(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setState(result.ok ? { phase: 'loaded', programmes: result.value } : { phase: 'error', programmes: [] });
    });
    return () => controller.abort();
  }, [attempt]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { ...state, reload };
}

export interface DuplicateSets extends ScanState {
  readonly more: () => void;
  readonly retry: () => void;
  readonly reload: () => void;
}

export function useDuplicateSets(programmeId: string | null): DuplicateSets {
  const [state, setState] = useState<ScanState>(IDLE);
  const [attempt, setAttempt] = useState(0);
  const scanner = useRef<DuplicateScanner | null>(null);
  if (scanner.current === null) scanner.current = new DuplicateScanner(setState);
  const held = scanner.current;

  useEffect(() => {
    held.start(programmeId);
    return () => held.cancel();
  }, [held, programmeId, attempt]);

  const more = useCallback(() => held.more(), [held]);
  const retry = useCallback(() => held.retry(), [held]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { ...state, more, retry, reload };
}
