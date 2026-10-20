'use client';

import { useEffect, useState } from 'react';
import { listMyProgrammes, type MyProgramme } from '../../lib/my-programmes-api';

export interface Programmes {
  /** `null` until read, or when the read failed: a screen then names no programme. */
  readonly list: readonly MyProgramme[] | null;
  readonly phase: 'loading' | 'loaded' | 'error';
}

/**
 * The caller's own programmes with their names (T-0043), read once. The P04
 * lists name them in the programme pill and the scope line (T-0133), and the
 * accounts sheet picks one to create in. It is the session's answer — the
 * screen never sends a programme anywhere to change what it reads.
 */
export function useMyProgrammes(): Programmes {
  const [state, setState] = useState<Programmes>({ list: null, phase: 'loading' });
  useEffect(() => {
    let live = true;
    void listMyProgrammes().then((result) => {
      if (!live) return;
      setState(result.ok ? { list: result.value, phase: 'loaded' } : { list: null, phase: 'error' });
    });
    return () => {
      live = false;
    };
  }, []);
  return state;
}
