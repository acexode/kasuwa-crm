'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Result, ScreenError } from '../../lib/admin-api';

/**
 * One read, with the four states a screen on a 256 kbps link actually has.
 *
 * ---------------------------------------------------------------------------
 * "STILL CONNECTING" IS A STATE, NOT A SPINNER.
 *
 * `loading` is a skeleton. At four seconds — the P01 number, kept — it becomes
 * `slow`, which is a sentence and an offer of low-bandwidth mode rather than a
 * rotating circle. A spinner tells a person on a 2G connection something they
 * already knew; "your network is slow, here is a lighter page" is an action.
 *
 * It is the first thing cut for time, because nothing visibly breaks when it is
 * missing and the failure is invisible from an office on fibre. It is not cut.
 * ---------------------------------------------------------------------------
 *
 * Every read is abortable, and the abort is what unmounting does. A `setState`
 * from a request whose screen has gone is not merely a warning — on this shell
 * it would repaint a programme's data over a different programme's screen.
 */

export const STILL_CONNECTING_MS = 4_000;

export interface Resource<T> {
  readonly data: T | null;
  readonly error: ScreenError | null;
  readonly loading: boolean;
  /** True once the request has been in flight for `STILL_CONNECTING_MS`. */
  readonly slow: boolean;
  readonly reload: () => void;
}

export function useResource<T>(
  load: (signal: AbortSignal) => Promise<Result<T>>,
  deps: readonly unknown[],
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ScreenError | null>(null);
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;

    setLoading(true);
    setSlow(false);
    setError(null);

    const timer = setTimeout(() => {
      if (live) setSlow(true);
    }, STILL_CONNECTING_MS);

    void load(controller.signal).then((result) => {
      if (!live) return;
      clearTimeout(timer);
      setLoading(false);
      setSlow(false);
      if (result.ok) {
        setData(result.value);
        setError(null);
      } else {
        setError(result.error);
      }
    });

    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
    // `load` is recreated on every render by design; `deps` is the real key.
  }, [...deps, attempt]);

  return { data, error, loading, slow, reload };
}
