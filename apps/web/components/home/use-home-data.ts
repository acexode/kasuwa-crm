'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as z from 'zod/mini';
import { listCalendar, listMyActivities, browserTimeZone, updateActivity, type MyActivity } from '../../lib/activities-api';
import { requestRecords } from '../../lib/records-api';
import {
  PIPELINES_PATH,
  DealPage,
  getPipeline,
  listPipelines,
  pipelineRequest,
  withSearch,
  type Deal,
  type PipelineStage,
} from '../../lib/pipelines-api';
import { todayWindow } from './home-format';

/**
 * P03's reads (T-0132), in the browser and in memory only, like P07's.
 *
 *   me       getCurrentUser: the id the layout is kept under, and the first
 *            name the greeting uses. Identity only (no role, no scope).
 *   agenda   listCalendar for today's window in the browser's zone: the
 *            caller's own tasks due today, open or done, and meetings that
 *            overlap today. One read, every page of it (a calendar missing an
 *            event is wrong), bounded.
 *   deals    listPipelines, then per pipeline getPipeline (stage names) and
 *            listDeals with `owner=me` on the open stages, oldest in stage first:
 *            the caller's own deals that are going stale or have no next step.
 *
 * NEVER SCOPED BY THE CALLER. No programme, owner id or user id is sent:
 * `owner=me` is the contract's own word for "the session's user", and the API
 * scopes every row from the session and `user_programme` (CLAUDE.md 2.2).
 * Withheld fields stay withheld: a deal whose `nextStep` or `rotting` the
 * caller cannot read is never flagged for it.
 */

const Me = z.object({ id: z.string(), displayName: z.string() });
export type Me = z.infer<typeof Me>;

/** How many pipelines are read for "Deals needing attention": a bounded fan-out on a 256 kbps link. */
const MAX_PIPELINES = 5;
/** How many deals the widget lists (the design's four, plus one). */
export const MAX_ATTENTION = 5;

export type Phase<T> =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error' }
  | { readonly phase: 'ready'; readonly value: T };

export type Attention = 'rotting' | 'stale' | 'noNextStep';

export interface AttentionDeal {
  readonly deal: Deal;
  readonly reason: Attention;
  readonly stage: PipelineStage | null;
}

export interface DealsSummary {
  /** The caller's open deals needing attention, worst first, at most MAX_ATTENTION. */
  readonly attention: readonly AttentionDeal[];
  /** Whether the caller owns any open deal at all (the "No deals yet" state). */
  readonly anyOwned: boolean;
}

function attentionOf(deal: Deal): Attention | null {
  if (!deal.withheldFields.includes('rotting')) {
    if (deal.rotting === 'rotting') return 'rotting';
    if (deal.rotting === 'stale') return 'stale';
  }
  const nextStep = deal.nextStep;
  if (!deal.withheldFields.includes('nextStep') && (nextStep === null || nextStep === undefined || nextStep.trim() === '')) {
    return 'noNextStep';
  }
  return null;
}

const RANK: Readonly<Record<Attention, number>> = { rotting: 0, stale: 1, noNextStep: 2 };

async function readCalendar(now: Date): Promise<MyActivity[] | null> {
  const window = todayWindow(now);
  const items: MyActivity[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 5; page += 1) {
    const result = await listCalendar(window, cursor);
    if (!result.ok) return null;
    for (const item of result.value.data) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        items.push(item);
      }
    }
    cursor = result.value.nextCursor;
    if (cursor === null) break;
  }
  return items;
}

async function readDeals(): Promise<DealsSummary | null> {
  const pipelines = await listPipelines();
  if (!pipelines.ok) return null;
  const found: AttentionDeal[] = [];
  let anyOwned = false;
  for (const summary of pipelines.value.data.slice(0, MAX_PIPELINES)) {
    const pipeline = await getPipeline(summary.id);
    if (!pipeline.ok) return null;
    const open = pipeline.value.stages.filter((stage) => stage.kind === 'open');
    if (open.length === 0) continue;
    const params = new URLSearchParams({ owner: 'me', sort: 'stageEnteredAt', limit: '50' });
    for (const stage of open) params.append('stageId', stage.id);
    const deals = await pipelineRequest(withSearch(`${PIPELINES_PATH}/${encodeURIComponent(summary.id)}/deals`, params), DealPage);
    if (!deals.ok) return null;
    if (deals.value.data.length > 0) anyOwned = true;
    for (const deal of deals.value.data) {
      const reason = attentionOf(deal);
      if (reason !== null) {
        found.push({ deal, reason, stage: pipeline.value.stages.find((stage) => stage.id === deal.stageId) ?? null });
      }
    }
  }
  found.sort((a, b) => RANK[a.reason] - RANK[b.reason] || a.deal.stageEnteredAt.localeCompare(b.deal.stageEnteredAt));
  return { attention: found.slice(0, MAX_ATTENTION), anyOwned };
}

/**
 * Whether this looks like a new workspace for this person: nothing on their
 * calendar later either, and no deal anyone in their scope can see. Read only
 * when today's agenda and their own deals are both empty.
 */
async function readNothingYet(): Promise<boolean> {
  const upcoming = await listMyActivities('upcoming', browserTimeZone(), null);
  if (!upcoming.ok || upcoming.value.data.length > 0) return false;
  const pipelines = await listPipelines();
  if (!pipelines.ok) return false;
  for (const summary of pipelines.value.data.slice(0, MAX_PIPELINES)) {
    const params = new URLSearchParams({ limit: '1' });
    const deals = await pipelineRequest(withSearch(`${PIPELINES_PATH}/${encodeURIComponent(summary.id)}/deals`, params), DealPage);
    if (!deals.ok || deals.value.data.length > 0) return false;
  }
  return true;
}

export interface HomeData {
  readonly me: Me | null;
  readonly agenda: Phase<readonly MyActivity[]>;
  readonly deals: Phase<DealsSummary>;
  /** Today's agenda and deals are both empty and nothing else exists yet: the new-tenant Home. */
  readonly nothingYet: boolean;
  /** The clock the screen draws, ticking once a minute. */
  readonly now: Date | null;
  readonly busy: ReadonlySet<string>;
  readonly done: ReadonlySet<string>;
  readonly retryAgenda: () => void;
  readonly retryDeals: () => void;
  readonly complete: (item: MyActivity) => void;
}

export function useHomeData({ agendaLive, dealsLive }: { agendaLive: boolean; dealsLive: boolean }): HomeData {
  const [me, setMe] = useState<Me | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [agenda, setAgenda] = useState<Phase<readonly MyActivity[]>>({ phase: 'loading' });
  const [deals, setDeals] = useState<Phase<DealsSummary>>({ phase: 'loading' });
  const [nothingYet, setNothingYet] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  const agendaSeq = useRef(0);
  const dealsSeq = useRef(0);

  // The clock is the browser's, read after mount: a server render cannot know the zone.
  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let live = true;
    void requestRecords('/api/v1/auth/me', Me).then((result) => {
      if (live && result.ok) setMe(result.value);
    });
    return () => {
      live = false;
    };
  }, []);

  const loadAgenda = useCallback(async () => {
    agendaSeq.current += 1;
    const seq = agendaSeq.current;
    setAgenda({ phase: 'loading' });
    const items = await readCalendar(new Date());
    if (seq !== agendaSeq.current) return;
    setAgenda(items === null ? { phase: 'error' } : { phase: 'ready', value: items });
  }, []);

  const loadDeals = useCallback(async () => {
    dealsSeq.current += 1;
    const seq = dealsSeq.current;
    setDeals({ phase: 'loading' });
    const summary = await readDeals();
    if (seq !== dealsSeq.current) return;
    setDeals(summary === null ? { phase: 'error' } : { phase: 'ready', value: summary });
  }, []);

  useEffect(() => {
    if (agendaLive) void loadAgenda();
  }, [agendaLive, loadAgenda]);

  useEffect(() => {
    if (dealsLive) void loadDeals();
  }, [dealsLive, loadDeals]);

  const agendaEmpty = !agendaLive || (agenda.phase === 'ready' && agenda.value.length === 0);
  const dealsEmpty = !dealsLive || (deals.phase === 'ready' && !deals.value.anyOwned);
  useEffect(() => {
    if (!agendaEmpty || !dealsEmpty || (!agendaLive && !dealsLive)) {
      setNothingYet(false);
      return undefined;
    }
    let live = true;
    void readNothingYet().then((value) => {
      if (live) setNothingYet(value);
    });
    return () => {
      live = false;
    };
  }, [agendaEmpty, dealsEmpty, agendaLive, dealsLive]);

  /** Marks a task done: `version` plus `completed`, nothing optimistic; the row turns when the server says so. */
  const complete = useCallback(
    (item: MyActivity) => {
      if (busy.has(item.id) || item.type !== 'task') return;
      setBusy((current) => new Set(current).add(item.id));
      void updateActivity(item.id, { version: item.version, completed: true }).then((result) => {
        setBusy((current) => {
          const next = new Set(current);
          next.delete(item.id);
          return next;
        });
        if (result.ok) setDone((current) => new Set(current).add(item.id));
        else void loadAgenda();
      });
    },
    [busy, loadAgenda],
  );

  return {
    me,
    agenda,
    deals,
    nothingYet,
    now,
    busy,
    done,
    retryAgenda: () => void loadAgenda(),
    retryDeals: () => void loadDeals(),
    complete,
  };
}

