'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordsError, RecordsResult } from '../../lib/records-api';
import {
  completeActivity,
  createActivity,
  getContact,
  getCurrentUser,
  listContactTimeline,
  listMyProgrammes,
  updateContact,
  type Activity,
  type ContactRecord,
  type CurrentUser,
  type NewActivity,
  type TimelineItem,
} from '../../lib/contact-record-api';
import { STILL_CONNECTING_MS } from '../admin/use-resource';
import { appendPage, mergeHead, readOutcome, withCompleted, type ReadOutcome } from './record-model';

/**
 * The contact record as a screen on a 256 kbps link has it (P05/01, /05, /06).
 *
 * THE CONTACT AND ITS TIMELINE ARE READ AT ONCE, NOT ONE AFTER THE OTHER. At
 * 300 ms of latency a second round trip is a third of a second of nothing.
 * They fail apart: a timeline that did not load is "the timeline did not
 * load", never "no history", and the details still show.
 *
 * IN MEMORY, NEVER ON THE DEVICE (D-L64, D-P21). The record survives a dropped
 * connection because it is still in this hook's state, not because it was
 * written anywhere. Offline, every write is off; there is no queue.
 *
 * NOTHING OPTIMISTIC. What is drawn is what the server last served. A refused
 * or stale edit therefore leaves the served value on screen by construction,
 * and a 409 re-reads the record so the next attempt carries a real version.
 * If that re-read fails, the stale record comes off the screen: not-found if
 * it is gone, "did not load" otherwise (`readOutcome`).
 *
 * VERSIONS ARE NEVER INVENTED. A task can be completed only with a version a
 * 201 or 200 for it actually carried. A timeline item carries none (the
 * contract gap D-L85 names), so a task seen only on the timeline cannot be
 * completed here until T-0080.
 */

export type RecordPhase = 'loading' | 'ready' | 'not-found' | 'unavailable';

export interface TimelineState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly items: readonly TimelineItem[];
  readonly cursor: string | null;
  readonly loadingOlder: boolean;
  readonly olderError: RecordsError | null;
}

const NO_TIMELINE: TimelineState = { phase: 'loading', items: [], cursor: null, loadingOlder: false, olderError: null };

export interface ContactRecordState {
  readonly phase: RecordPhase;
  readonly error: RecordsError | null;
  readonly slow: boolean;
  readonly record: ContactRecord | null;
  readonly timeline: TimelineState;
  readonly me: CurrentUser | null;
  readonly programmeName: string | null;
  readonly online: boolean;
  readonly syncedAt: Date | null;
  /** Versions served for activities, by activity id: the only ones the screen may complete. */
  readonly versions: Readonly<Record<string, number>>;
  readonly reload: () => void;
  readonly retryTimeline: () => void;
  readonly loadOlder: () => void;
  readonly save: (body: Readonly<Record<string, unknown>>) => Promise<RecordsResult<ContactRecord>>;
  readonly log: (activity: Omit<NewActivity, 'contactId'>) => Promise<RecordsResult<Activity>>;
  readonly complete: (activityId: string) => Promise<RecordsResult<Activity>>;
}

export function useContactRecord(id: string): ContactRecordState {
  const [phase, setPhase] = useState<RecordPhase>('loading');
  const [error, setError] = useState<RecordsError | null>(null);
  const [slow, setSlow] = useState(false);
  const [record, setRecord] = useState<ContactRecord | null>(null);
  const [timeline, setTimeline] = useState<TimelineState>(NO_TIMELINE);
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [programmes, setProgrammes] = useState<readonly { id: string; name: string }[]>([]);
  const [online, setOnline] = useState(true);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [versions, setVersions] = useState<Readonly<Record<string, number>>>({});
  const [attempt, setAttempt] = useState(0);
  const [timelineAttempt, setTimelineAttempt] = useState(0);
  // The record's own version, read synchronously by a write that follows another.
  const current = useRef<ContactRecord | null>(null);

  const accept = useCallback((next: ContactRecord) => {
    current.current = next;
    setRecord(next);
    setSyncedAt(new Date());
  }, []);

  /** Applies a getContact answer: the record, or a state in which none is shown. */
  const settle = useCallback(
    (outcome: ReadOutcome) => {
      if (outcome.phase === 'ready') {
        accept(outcome.record);
        setError(null);
      } else {
        current.current = null;
        setRecord(null);
        setError(outcome.phase === 'unavailable' ? outcome.error : null);
      }
      setPhase(outcome.phase);
    },
    [accept],
  );

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

  // Who is asking, and the names of their programmes: neither blocks the record.
  useEffect(() => {
    const controller = new AbortController();
    void getCurrentUser(controller.signal).then((result) => {
      if (result.ok) setMe(result.value);
    });
    void listMyProgrammes(controller.signal).then((result) => {
      if (result.ok) setProgrammes(result.value.data);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setPhase('loading');
    setError(null);
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), STILL_CONNECTING_MS);
    void getContact(id, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      window.clearTimeout(timer);
      setSlow(false);
      settle(readOutcome(result));
    });
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [id, attempt, settle]);

  useEffect(() => {
    const controller = new AbortController();
    setTimeline(NO_TIMELINE);
    void listContactTimeline(id, null, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setTimeline(
        result.ok
          ? { ...NO_TIMELINE, phase: 'ready', items: result.value.data, cursor: result.value.nextCursor }
          : { ...NO_TIMELINE, phase: 'error' },
      );
    });
    return () => controller.abort();
  }, [id, attempt, timelineAttempt]);

  const loadOlder = useCallback(() => {
    const cursor = timeline.cursor;
    if (cursor === null || timeline.loadingOlder) return;
    setTimeline((state) => ({ ...state, loadingOlder: true, olderError: null }));
    void listContactTimeline(id, cursor).then((result) => {
      setTimeline((state) =>
        result.ok
          ? { ...state, loadingOlder: false, items: appendPage(state.items, result.value), cursor: result.value.nextCursor }
          : { ...state, loadingOlder: false, olderError: result.error },
      );
    });
  }, [id, timeline.cursor, timeline.loadingOlder]);

  /** After a write: the newest page again, laid over the top (see `mergeHead`). */
  const refreshHead = useCallback(() => {
    void listContactTimeline(id, null).then((result) => {
      if (!result.ok) return;
      setTimeline((state) => (state.phase === 'ready' ? { ...state, items: mergeHead(state.items, result.value) } : state));
    });
  }, [id]);

  const save = useCallback(
    async (fields: Readonly<Record<string, unknown>>): Promise<RecordsResult<ContactRecord>> => {
      const served = current.current;
      if (served === null) return { ok: false, error: { code: 'not_found' } };
      const result = await updateContact(served.id, { ...fields, version: served.version });
      if (result.ok) {
        accept(result.value);
        refreshHead();
      } else if (result.error.code === 'stale_write') {
        // Somebody saved first. Show what they saved, with its version; and if
        // that read fails, never leave the stale record on screen as current.
        settle(readOutcome(await getContact(served.id)));
      }
      return result;
    },
    [settle, refreshHead],
  );

  const log = useCallback(
    async (activity: Omit<NewActivity, 'contactId'>): Promise<RecordsResult<Activity>> => {
      const result = await createActivity({ ...activity, contactId: id });
      if (result.ok) {
        const created = result.value;
        setVersions((known) => ({ ...known, [created.id]: created.version }));
        refreshHead();
      }
      return result;
    },
    [id, refreshHead],
  );

  const complete = useCallback(
    async (activityId: string): Promise<RecordsResult<Activity>> => {
      const version = versions[activityId];
      if (version === undefined) return { ok: false, error: { code: 'stale_write' } };
      const result = await completeActivity(activityId, version);
      if (result.ok) {
        const updated = result.value;
        setVersions((known) => ({ ...known, [updated.id]: updated.version }));
        if (updated.completedAt !== undefined) {
          setTimeline((state) => ({ ...state, items: withCompleted(state.items, updated.id, updated.completedAt ?? null) }));
        }
      }
      return result;
    },
    [versions],
  );

  const programmeName = record === null ? null : (programmes.find((programme) => programme.id === record.programmeId)?.name ?? null);

  return {
    phase,
    error,
    slow,
    record,
    timeline,
    me,
    programmeName,
    online,
    syncedAt,
    versions,
    reload: useCallback(() => setAttempt((value) => value + 1), []),
    retryTimeline: useCallback(() => setTimelineAttempt((value) => value + 1), []),
    loadOlder,
    save,
    log,
    complete,
  };
}
