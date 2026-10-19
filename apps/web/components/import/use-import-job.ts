'use client';

import { useEffect, useRef, useState } from 'react';
import { getImport, type ImportJob } from '../../lib/imports-api';
import { isTerminal, pollDelay } from '../../lib/import-model';
import type { RecordsError } from '../../lib/records-api';

/**
 * Reads one import job until it has nothing more to say (T-0096, I8).
 *
 * A GROWING INTERVAL, NEVER A LOOP. The wait before each read grows by half
 * (`pollDelay`: from 600 ms, never under 400 ms, never over 20 s), so a long
 * run on a 256 kbps link is not a request every half second, and the counts
 * are still live. `phase: 'header'` reads until the server has read the first
 * row of the file; `'run'` reads until the job ends. Polling stops the moment
 * the answer says so, and when the screen goes away.
 *
 * A READ THAT FAILS IS TRIED AGAIN. A dropped connection is `retrying`, not an
 * ended import: the next read is simply the next one in the schedule. So is a
 * `429` (D-L179 N7), which is a wait and never an ended import: the schedule's
 * own growing wait (up to 20 s) is the wait. The server's `Retry-After` is not
 * read here, because carrying it through the shared records client costs every
 * records page bytes where the notifications flag is off (D-L182). Only a
 * refusal that is not the network (a `404` for an import that is not ours)
 * ends it, and says so through `onRefused`.
 */
export type PollPhase = 'header' | 'run';

export interface JobPoll {
  /** The last read failed on the network and the next one is already scheduled. */
  readonly retrying: boolean;
}

export function useImportJob(
  importId: string | null,
  phase: PollPhase | null,
  options: {
    /** The first read at once (a job opened from the history) instead of after the first wait. */
    readonly immediate: boolean;
    readonly onRefused: (error: RecordsError) => void;
    /** Every answer, for the screen to keep. */
    readonly onJob: (job: ImportJob) => void;
  },
): JobPoll {
  const [retrying, setRetrying] = useState(false);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (importId === null || phase === null) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const base = phase === 'header' ? 500 : 600;

    // The next read, if one is waiting, and where the schedule stands.
    let next = 0;
    let done = false;
    let inFlight = false;

    const schedule = (attempt: number): void => {
      next = attempt;
      // A hidden tab reads nothing (N6): the schedule picks up again when it is shown.
      if (document.hidden) return;
      timer = setTimeout(() => void read(attempt), pollDelay(attempt, base));
    };

    const read = async (attempt: number): Promise<void> => {
      timer = undefined;
      inFlight = true;
      const result = await getImport(importId, controller.signal);
      inFlight = false;
      if (controller.signal.aborted) return;
      if (result.ok) {
        setRetrying(false);
        latest.current.onJob(result.value);
        done = phase === 'header' ? result.value.status !== 'reading_header' && result.value.status !== 'awaiting_upload' : isTerminal(result.value.status);
        if (done) return;
      } else if (result.error.code === 'network' || result.error.code === 'too_many_requests') {
        setRetrying(true);
      } else {
        done = true;
        latest.current.onRefused(result.error);
        return;
      }
      schedule(attempt + 1);
    };

    const onVisibility = (): void => {
      if (document.hidden) {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      } else if (!done && !inFlight && timer === undefined) {
        void read(next);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    if (options.immediate) void read(0);
    else schedule(0);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
    // The schedule restarts only for a different import or phase.
  }, [importId, phase]);

  return { retrying };
}
