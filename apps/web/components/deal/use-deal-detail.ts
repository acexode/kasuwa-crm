'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getPipeline, type Pipeline, type PipelineError } from '../../lib/pipelines-api';
import {
  getCaller,
  getDealDetail,
  listDealTimeline,
  type Caller,
  type DealDetail,
  type DealTimelineItem,
} from '../../lib/deal-detail-api';
import { STILL_CONNECTING_MS } from '../admin/use-resource';
import { appendPage, noTimeline, type TimelineState } from '../record/record-core';

/**
 * The P06/05 deal detail as a 256 kbps screen has it (T-0110).
 *
 * READ FROM THE BROWSER. getDeal first (and the deal's timeline and the
 * caller beside it, so the page costs one round trip less on a 300 ms link),
 * then the deal's OWN pipeline for its stage names, requirement labels and
 * allow-list. A 404 is the generic not-found, out of scope and missing alike
 * (D-L69); any other failure is "did not load", never "not found".
 *
 * DRAWN AS SERVED. A write's answer replaces the deal; the timeline is re-read
 * after every successful write (R15) and is what it serves: never spliced
 * from a write's answer, because field security decides what appears on it.
 *
 * IN MEMORY ONLY (D-L64, D-P21). Nothing is written to the device; offline,
 * what was read stays on screen with the time it was read.
 *
 * STALE ANSWERS ARE DROPPED. Every deal and timeline read carries a sequence
 * number, and only the latest one's answer is applied.
 */

export type DealPhase = 'loading' | 'ready' | 'not-found' | 'unavailable';

export interface DealDetailModel {
  readonly phase: DealPhase;
  readonly deal: DealDetail | null;
  readonly pipeline: Pipeline | null;
  readonly caller: Caller | null;
  readonly error: PipelineError | null;
  readonly slow: boolean;
  readonly syncedAt: Date | null;
  readonly timeline: TimelineState<DealTimelineItem>;
  /** The deal a write just answered: drawn as served. */
  readonly apply: (deal: DealDetail) => void;
  /** Re-reads the deal (after a 409) and returns it, or `null` when that read failed. */
  readonly reReadDeal: () => Promise<DealDetail | null>;
  /** Re-reads the pipeline's configuration (requirements, allow-list) and returns it. */
  readonly refreshPipeline: () => Promise<Pipeline | null>;
  /** The timeline's first page, read again: after every successful write. */
  readonly reReadTimeline: () => void;
  readonly loadOlder: () => void;
  readonly retry: () => void;
}

export function useDealDetail(dealId: string): DealDetailModel {
  const [deal, setDeal] = useState<DealDetail | null>(null);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [caller, setCaller] = useState<Caller | null>(null);
  const [error, setError] = useState<PipelineError | null>(null);
  const [missing, setMissing] = useState(false);
  const [slow, setSlow] = useState(false);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [timeline, setTimeline] = useState<TimelineState<DealTimelineItem>>(noTimeline);
  const [nonce, setNonce] = useState(0);
  const dealSequence = useRef(0);
  const pipelineSequence = useRef(0);
  const timelineSequence = useRef(0);

  const readPipeline = useCallback(async (pipelineId: string): Promise<Pipeline | null> => {
    pipelineSequence.current += 1;
    const mine = pipelineSequence.current;
    const result = await getPipeline(pipelineId);
    if (mine !== pipelineSequence.current) return null;
    if (result.ok) {
      setPipeline(result.value);
      return result.value;
    }
    setError(result.error);
    return null;
  }, []);

  const readTimeline = useCallback(() => {
    timelineSequence.current += 1;
    const mine = timelineSequence.current;
    void listDealTimeline(dealId, null).then((result) => {
      if (mine !== timelineSequence.current) return;
      if (result.ok) {
        setTimeline({
          phase: 'ready',
          items: result.value.data,
          cursor: result.value.nextCursor,
          loadingOlder: false,
          olderError: null,
        });
      } else {
        // A failed re-read keeps a timeline already on screen; a failed first read is the error state.
        setTimeline((current) =>
          current.phase === 'ready'
            ? current
            : { ...noTimeline<DealTimelineItem>(), phase: 'error' },
        );
      }
    });
  }, [dealId]);

  // The first read: the deal, its timeline and the caller together, then the deal's pipeline.
  useEffect(() => {
    dealSequence.current += 1;
    const mine = dealSequence.current;
    setError(null);
    setMissing(false);
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), STILL_CONNECTING_MS);
    readTimeline();
    void getCaller().then((result) => {
      if (result.ok) setCaller(result.value);
    });
    void getDealDetail(dealId).then(async (result) => {
      if (mine !== dealSequence.current) return;
      if (!result.ok) {
        window.clearTimeout(timer);
        setSlow(false);
        if (result.error.code === 'not_found') setMissing(true);
        else setError(result.error);
        return;
      }
      await readPipeline(result.value.pipelineId);
      window.clearTimeout(timer);
      if (mine !== dealSequence.current) return;
      setSlow(false);
      setDeal(result.value);
      setSyncedAt(new Date());
    });
    return () => window.clearTimeout(timer);
  }, [dealId, nonce, readPipeline, readTimeline]);

  const apply = useCallback((next: DealDetail) => {
    dealSequence.current += 1;
    setDeal(next);
    setSyncedAt(new Date());
  }, []);

  const reReadDeal = useCallback(async (): Promise<DealDetail | null> => {
    dealSequence.current += 1;
    const mine = dealSequence.current;
    const result = await getDealDetail(dealId);
    if (mine !== dealSequence.current) return null;
    if (result.ok) {
      setDeal(result.value);
      setSyncedAt(new Date());
      return result.value;
    }
    if (result.error.code === 'not_found') setMissing(true);
    return null;
  }, [dealId]);

  const refreshPipeline = useCallback(async (): Promise<Pipeline | null> => {
    const pipelineId = deal?.pipelineId ?? pipeline?.id;
    return pipelineId === undefined ? null : readPipeline(pipelineId);
  }, [deal, pipeline, readPipeline]);

  const loadOlder = useCallback(() => {
    const cursor = timeline.cursor;
    if (timeline.phase !== 'ready' || cursor === null || timeline.loadingOlder) return;
    const mine = timelineSequence.current;
    setTimeline((current) => ({ ...current, loadingOlder: true, olderError: null }));
    void listDealTimeline(dealId, cursor).then((result) => {
      // A first-page re-read since this page was asked for wins.
      if (mine !== timelineSequence.current) return;
      setTimeline((current) => {
        if (current.cursor !== cursor) return current;
        if (!result.ok) {
          return {
            ...current,
            loadingOlder: false,
            olderError: { code: result.error.code === 'network' ? 'network' : 'internal_error' },
          };
        }
        return {
          ...current,
          items: appendPage(current.items, result.value),
          cursor: result.value.nextCursor,
          loadingOlder: false,
          olderError: null,
        };
      });
    });
  }, [dealId, timeline]);

  const retry = useCallback(() => {
    if (deal === null) {
      setNonce((current) => current + 1);
      return;
    }
    readTimeline();
  }, [deal, readTimeline]);

  const phase: DealPhase = missing
    ? 'not-found'
    : deal !== null && pipeline !== null
      ? 'ready'
      : error !== null
        ? 'unavailable'
        : 'loading';

  return {
    phase,
    deal,
    pipeline,
    caller,
    error,
    slow: slow && phase === 'loading',
    syncedAt,
    timeline,
    apply,
    reReadDeal,
    refreshPipeline,
    reReadTimeline: readTimeline,
    loadOlder,
    retry,
  };
}
