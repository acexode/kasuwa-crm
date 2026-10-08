'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Account } from '../../lib/accounts-api';
import { getAccount, listAccountContacts, listAccountTimeline, type AccountTimelineItem } from '../../lib/account-record-api';
import { completeActivity, createActivity, listMyProgrammes, type Activity, type ActivityDraft } from '../../lib/contact-record-api';
import type { RecordsError, RecordsResult } from '../../lib/records-api';
import { STILL_CONNECTING_MS } from '../admin/use-resource';
import { appendPage as appendContacts } from '../records/list-model';
import {
  appendPage,
  itemVersions,
  mergeHead,
  noTimeline,
  readOutcome,
  withCompleted,
  withServedVersions,
  type ActivityVersions,
  type ReadOutcome,
  type RecordPhase,
  type TimelineState,
} from '../record/record-core';
import { NO_CONTACTS, contactsOutcome, walkAncestors, type ContactsState, type Hierarchy } from './account-record-model';

/**
 * The account record as a screen on a 256 kbps link has it (P05/04, /05, /06).
 *
 * THE ACCOUNT, ITS CONTACTS AND ITS TIMELINE ARE READ AT ONCE. At 300 ms of
 * latency every extra round trip in series is a third of a second of nothing.
 * They fail apart: a timeline or a contacts grid that did not load says so,
 * and the details still show. Only the hierarchy waits on the account, because
 * the account names its parent; the walk then reads one ancestor at a time,
 * at most four (D-L74), each once.
 *
 * IN MEMORY, NEVER ON THE DEVICE (D-L64, D-P21). The record survives a dropped
 * connection because it is still in this hook's state. Offline, every write
 * is off; there is no queue.
 *
 * NOTHING OPTIMISTIC, AND NO VERSION INVENTED. What is drawn is what the
 * server last served. A task is completed with the version its timeline item
 * carries (T-0080) or a 201/200 returned; a 409 re-reads the newest page so
 * the next attempt carries the fresh version, and is never retried blind.
 */

export interface AccountRecordState {
  readonly phase: RecordPhase;
  readonly error: RecordsError | null;
  readonly slow: boolean;
  readonly record: Account | null;
  /** `null` while the walk is in flight. */
  readonly hierarchy: Hierarchy | null;
  readonly contacts: ContactsState;
  readonly timeline: TimelineState<AccountTimelineItem>;
  readonly programmeName: string | null;
  readonly online: boolean;
  readonly syncedAt: Date | null;
  readonly versions: ActivityVersions;
  readonly reload: () => void;
  readonly retryContacts: () => void;
  readonly moreContacts: () => void;
  readonly retryTimeline: () => void;
  readonly loadOlder: () => void;
  /** The edit sheet saved: show what the server returned, and its new history. */
  readonly saved: (row: Account) => void;
  /** The edit sheet was refused as stale: read the account again, so the next save carries its version. */
  readonly refresh: () => void;
  readonly log: (activity: ActivityDraft) => Promise<RecordsResult<Activity>>;
  readonly complete: (activityId: string) => Promise<RecordsResult<Activity>>;
}

const NO_TIMELINE = noTimeline<AccountTimelineItem>();

export function useAccountRecord(id: string): AccountRecordState {
  const [phase, setPhase] = useState<RecordPhase>('loading');
  const [error, setError] = useState<RecordsError | null>(null);
  const [slow, setSlow] = useState(false);
  const [record, setRecord] = useState<Account | null>(null);
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [contacts, setContacts] = useState<ContactsState>(NO_CONTACTS);
  const [timeline, setTimeline] = useState<TimelineState<AccountTimelineItem>>(NO_TIMELINE);
  const [programmes, setProgrammes] = useState<readonly { id: string; name: string }[]>([]);
  const [online, setOnline] = useState(true);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [versions, setVersions] = useState<ActivityVersions>({});
  const [attempt, setAttempt] = useState(0);
  const [contactsAttempt, setContactsAttempt] = useState(0);
  const [timelineAttempt, setTimelineAttempt] = useState(0);
  // The parent the hierarchy was walked for: a save that leaves it alone does not walk again.
  const walkedFrom = useRef<string | null | undefined>(undefined);
  const walkToken = useRef(0);

  const settle = useCallback((outcome: ReadOutcome<Account>) => {
    if (outcome.phase === 'ready') {
      setRecord(outcome.record);
      setSyncedAt(new Date());
      setError(null);
    } else {
      setRecord(null);
      setError(outcome.phase === 'unavailable' ? outcome.error : null);
    }
    setPhase(outcome.phase);
  }, []);

  const served = useCallback((items: readonly AccountTimelineItem[]) => {
    setVersions((known) => withServedVersions(known, itemVersions(items)));
  }, []);

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

  // The names of the caller's programmes: never blocks the record.
  useEffect(() => {
    const controller = new AbortController();
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
    void getAccount(id, controller.signal).then((result) => {
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

  // The hierarchy: walked once per parent link, from the account as served. A
  // save that leaves the parent alone walks nothing; a newer walk drops the
  // answer of an older one.
  useEffect(() => {
    if (record === null) return;
    const from = record.withheldFields.includes('parentAccountId') ? 'locked' : (record.parentAccountId ?? null);
    if (walkedFrom.current === from) return;
    walkedFrom.current = from;
    walkToken.current += 1;
    const token = walkToken.current;
    setHierarchy(null);
    void walkAncestors(record, (ancestor) => getAccount(ancestor)).then((walked) => {
      if (walkToken.current === token) setHierarchy(walked);
    });
  }, [record]);

  useEffect(() => {
    const controller = new AbortController();
    setContacts(NO_CONTACTS);
    void listAccountContacts(id, null, controller.signal).then((result) => {
      if (!controller.signal.aborted) setContacts(contactsOutcome(result));
    });
    return () => controller.abort();
  }, [id, attempt, contactsAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    setTimeline(NO_TIMELINE);
    void listAccountTimeline(id, null, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) served(result.value.data);
      setTimeline(
        result.ok
          ? { ...NO_TIMELINE, phase: 'ready', items: result.value.data, cursor: result.value.nextCursor }
          : { ...NO_TIMELINE, phase: 'error' },
      );
    });
    return () => controller.abort();
  }, [id, attempt, timelineAttempt, served]);

  const moreContacts = useCallback(() => {
    const cursor = contacts.cursor;
    if (contacts.phase !== 'ready' || cursor === null || contacts.loadingMore) return;
    setContacts((state) => ({ ...state, loadingMore: true, moreError: null }));
    void listAccountContacts(id, cursor).then((result) => {
      setContacts((state) =>
        result.ok
          ? { ...state, loadingMore: false, rows: appendContacts(state.rows, result.value.data), cursor: result.value.nextCursor }
          : { ...state, loadingMore: false, moreError: result.error },
      );
    });
  }, [id, contacts.phase, contacts.cursor, contacts.loadingMore]);

  const loadOlder = useCallback(() => {
    const cursor = timeline.cursor;
    if (cursor === null || timeline.loadingOlder) return;
    setTimeline((state) => ({ ...state, loadingOlder: true, olderError: null }));
    void listAccountTimeline(id, cursor).then((result) => {
      if (result.ok) served(result.value.data);
      setTimeline((state) =>
        result.ok
          ? { ...state, loadingOlder: false, items: appendPage(state.items, result.value), cursor: result.value.nextCursor }
          : { ...state, loadingOlder: false, olderError: result.error },
      );
    });
  }, [id, timeline.cursor, timeline.loadingOlder, served]);

  /** After a write: the newest page again, laid over the top (see `mergeHead`). */
  const refreshHead = useCallback(async (): Promise<void> => {
    const result = await listAccountTimeline(id, null);
    if (!result.ok) return;
    served(result.value.data);
    setTimeline((state) => (state.phase === 'ready' ? { ...state, items: mergeHead(state.items, result.value) } : state));
  }, [id, served]);

  const saved = useCallback(
    (row: Account) => {
      setRecord(row);
      setSyncedAt(new Date());
      void refreshHead();
    },
    [refreshHead],
  );

  const refresh = useCallback(() => {
    void getAccount(id).then((result) => settle(readOutcome(result)));
  }, [id, settle]);

  const log = useCallback(
    async (activity: ActivityDraft): Promise<RecordsResult<Activity>> => {
      // Logged from the account record, it is the account's: no contact (T-0063).
      const result = await createActivity({ ...activity, accountId: id });
      if (result.ok) {
        setVersions((known) => withServedVersions(known, [{ activityId: result.value.id, version: result.value.version }]));
        await refreshHead();
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
        setVersions((known) => withServedVersions(known, [{ activityId: updated.id, version: updated.version }]));
        if (updated.completedAt !== undefined) {
          setTimeline((state) => ({ ...state, items: withCompleted(state.items, updated.id, updated.completedAt ?? null) }));
        }
      } else if (result.error.code === 'stale_write') {
        // Somebody changed it first. Read what they left, with its version,
        // before the control is offered again; never retry blind.
        await refreshHead();
      }
      return result;
    },
    [versions, refreshHead],
  );

  const programmeName = record === null ? null : (programmes.find((programme) => programme.id === record.programmeId)?.name ?? null);

  return {
    phase,
    error,
    slow,
    record,
    hierarchy,
    contacts,
    timeline,
    programmeName,
    online,
    syncedAt,
    versions,
    reload: useCallback(() => setAttempt((value) => value + 1), []),
    retryContacts: useCallback(() => setContactsAttempt((value) => value + 1), []),
    moreContacts,
    retryTimeline: useCallback(() => setTimelineAttempt((value) => value + 1), []),
    loadOlder,
    saved,
    refresh,
    log,
    complete,
  };
}
