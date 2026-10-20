'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  browserTimeZone,
  listCalendar,
  listMyActivities,
  type ActivityBucket,
  type MyActivity,
} from '../../lib/activities-api';
import type { RecordsError } from '../../lib/records-api';
import { getCurrentUser } from '../../lib/contact-record-api';
import {
  BUCKETS,
  LOADING_BUCKET,
  bucketAppended,
  bucketFailed,
  bucketLoaded,
  windowOf,
  wireWindow,
  withVersion,
  startOfDay,
  type BucketState,
  type CalendarView,
} from './activities-model';

/**
 * P07's reads, in memory only (D-L64, D-P21): the three buckets, the calendar
 * window, the caller and the versions writes answered with. Nothing here
 * touches the device; the lists survive a dropped connection because they are
 * still in state, and a reload reads them again.
 *
 * - Each bucket is its own listMyActivities read, read ONCE on load, in the
 *   browser's zone, and paged by "more" on the cursor it served.
 * - The calendar reads its window to the last page, each cursor echoed for
 *   the same window, before it is drawn: a calendar missing an event is wrong.
 * - After a write the buckets (and the calendar, once opened) are read again
 *   from the top: where a task now sits is the server's call, never a guess.
 * - Every answer carries a sequence number and only the latest is applied, so
 *   a slow answer for last month never paints over this one.
 */

export type BucketStates = Readonly<Record<ActivityBucket, BucketState>>;

export interface CalendarState {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error';
  readonly items: readonly MyActivity[];
  readonly error: RecordsError | null;
}

const ALL_LOADING: BucketStates = { overdue: LOADING_BUCKET, today: LOADING_BUCKET, upcoming: LOADING_BUCKET };

/** Reads a window to its last page. `null` when any page fails: half a window is never drawn as the whole. */
async function readWindow(view: CalendarView): Promise<{ ok: true; items: MyActivity[] } | { ok: false; error: RecordsError }> {
  const window = wireWindow(windowOf(view));
  if (window === null) return { ok: false, error: { code: 'validation_failed' } };
  const items: MyActivity[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  // Bounded: a server that never stops serving cursors cannot spin the tab.
  for (let page = 0; page < 50; page += 1) {
    const result = await listCalendar(window, cursor);
    if (!result.ok) return { ok: false, error: result.error };
    for (const item of result.value.data) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        items.push(item);
      }
    }
    cursor = result.value.nextCursor;
    if (cursor === null) return { ok: true, items };
  }
  return { ok: true, items };
}

export function useActivities() {
  // Read in the browser, after mount: a server render has no business knowing
  // the zone, and an answer from the server's own clock would be a guess.
  const [zone, setZone] = useState<string | null>(null);
  const zoneRef = useRef<string | null>(null);
  const [buckets, setBuckets] = useState<BucketStates>(ALL_LOADING);
  const [calendarView, setCalendarView] = useState<CalendarView>(() => ({ range: 'week', anchor: startOfDay(new Date()) }));
  const [calendarOpened, setCalendarOpened] = useState(false);
  const [calendar, setCalendar] = useState<CalendarState>({ phase: 'idle', items: [], error: null });
  const [online, setOnline] = useState(true);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [me, setMe] = useState<string | null>(null);
  /** The caller's display name, for the owner avatar on each row: every row here is the caller's own. */
  const [meName, setMeName] = useState<string | null>(null);
  const [versions, setVersions] = useState<Readonly<Record<string, number>>>({});
  const bucketSeq = useRef<Record<ActivityBucket, number>>({ overdue: 0, today: 0, upcoming: 0 });
  const calendarSeq = useRef(0);
  const started = useRef(false);
  const bucketsRef = useRef(buckets);
  bucketsRef.current = buckets;
  const viewRef = useRef(calendarView);
  viewRef.current = calendarView;
  const openedRef = useRef(calendarOpened);
  openedRef.current = calendarOpened;

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

  /** One bucket's first page; resolves with what it read (empty on failure). */
  const readBucket = useCallback(
    async (bucket: ActivityBucket): Promise<readonly MyActivity[]> => {
      bucketSeq.current[bucket] += 1;
      const seq = bucketSeq.current[bucket];
      const result = await listMyActivities(bucket, zoneRef.current ?? browserTimeZone(), null);
      if (seq !== bucketSeq.current[bucket]) return result.ok ? result.value.data : [];
      if (result.ok) {
        setBuckets((current) => ({ ...current, [bucket]: bucketLoaded(result.value) }));
        setSyncedAt(new Date());
        return result.value.data;
      }
      setBuckets((current) => ({ ...current, [bucket]: bucketFailed(current[bucket], result.error) }));
      return [];
    },
    [],
  );

  const refreshBuckets = useCallback(async (): Promise<MyActivity[]> => {
    const pages = await Promise.all(BUCKETS.map((bucket) => readBucket(bucket)));
    return pages.flat();
  }, [readBucket]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    zoneRef.current = browserTimeZone();
    setZone(zoneRef.current);
    void refreshBuckets();
    void getCurrentUser().then((result) => {
      if (!result.ok) return;
      setMe(result.value.id);
      setMeName(result.value.displayName);
    });
  }, [refreshBuckets]);

  const retryBucket = useCallback(
    (bucket: ActivityBucket) => {
      setBuckets((current) => ({ ...current, [bucket]: LOADING_BUCKET }));
      void readBucket(bucket);
    },
    [readBucket],
  );

  const loadMore = useCallback(
    async (bucket: ActivityBucket) => {
      const state = bucketsRef.current[bucket];
      if (state.cursor === null || state.loadingMore) return;
      const cursor = state.cursor;
      const seq = bucketSeq.current[bucket];
      setBuckets((current) => ({ ...current, [bucket]: { ...current[bucket], loadingMore: true, moreError: null } }));
      const result = await listMyActivities(bucket, zoneRef.current ?? browserTimeZone(), cursor);
      if (seq !== bucketSeq.current[bucket]) return;
      setBuckets((current) => ({
        ...current,
        [bucket]: result.ok
          ? bucketAppended(current[bucket], result.value)
          : { ...current[bucket], loadingMore: false, moreError: result.error },
      }));
    },
    [],
  );

  /** Reads the calendar's window to its last page. `quiet` keeps the drawn events up while it does (a re-read). */
  const readCalendar = useCallback(async (view: CalendarView, quiet: boolean): Promise<MyActivity[]> => {
    calendarSeq.current += 1;
    const seq = calendarSeq.current;
    if (!quiet) setCalendar({ phase: 'loading', items: [], error: null });
    const result = await readWindow(view);
    if (seq !== calendarSeq.current) return result.ok ? result.items : [];
    if (result.ok) {
      setCalendar({ phase: 'ready', items: result.items, error: null });
      return result.items;
    }
    setCalendar((current) => (quiet && current.phase === 'ready' ? current : { phase: 'error', items: [], error: result.error }));
    return [];
  }, []);

  const openCalendar = useCallback(() => {
    if (openedRef.current) return;
    setCalendarOpened(true);
    void readCalendar(viewRef.current, false);
  }, [readCalendar]);

  const showCalendar = useCallback(
    (next: CalendarView) => {
      setCalendarView(next);
      void readCalendar(next, false);
    },
    [readCalendar],
  );

  const retryCalendar = useCallback(() => void readCalendar(viewRef.current, false), [readCalendar]);

  /** After a write: everything read again from the top. Resolves with every row the re-read served. */
  const refreshAll = useCallback(async (): Promise<MyActivity[]> => {
    const [fromBuckets, fromCalendar] = await Promise.all([
      refreshBuckets(),
      openedRef.current ? readCalendar(viewRef.current, true) : Promise.resolve([]),
    ]);
    return [...fromBuckets, ...fromCalendar];
  }, [refreshBuckets, readCalendar]);

  const noteVersion = useCallback((id: string, version: number) => {
    setVersions((current) => withVersion(current, id, version));
  }, []);

  /** The caller, read again if the first read failed: the composer cannot set an owner without it. */
  const whoAmI = useCallback(async (): Promise<string | null> => {
    if (me !== null) return me;
    const result = await getCurrentUser();
    if (!result.ok) return null;
    setMe(result.value.id);
    setMeName(result.value.displayName);
    return result.value.id;
  }, [me]);

  return {
    zone,
    buckets,
    retryBucket,
    loadMore,
    calendarView,
    calendarOpened,
    calendar,
    openCalendar,
    showCalendar,
    retryCalendar,
    refreshAll,
    online,
    syncedAt,
    versions,
    noteVersion,
    whoAmI,
    me,
    meName,
  };
}

export type Activities = ReturnType<typeof useActivities>;
