'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getPipeline,
  getPipelineBoard,
  type Deal,
  type DealFilters,
  type Pipeline,
  type PipelineBoard,
  type PipelineError,
  type StageTotal,
} from '../../lib/pipelines-api';
import { STILL_CONNECTING_MS } from '../../lib/still-connecting';
import { filtersKey } from './pipeline-model';

/**
 * The P06 board as a 256 kbps screen has it (T-0109).
 *
 * READ WHOLE, DRAWN AS SERVED (R4). The board is one getPipelineBoard read on
 * load and after every write or filter change: every column's count and
 * totals arrive together, from the server, and are never added to, rounded or
 * summed here. A column pages on its own `nextCursor`, inside itself, with
 * its own `stageId` and the filters that produced the cursor.
 *
 * IN MEMORY ONLY (D-L64, D-P21). Nothing is written to the device; going
 * offline keeps what was read on screen, with the time it was read.
 *
 * STALE ANSWERS ARE DROPPED. Every whole-board read carries a sequence
 * number, and only the latest one's answer is applied.
 */

export interface Column {
  readonly stageId: string;
  readonly count: number;
  /** Absent when `amount` is withheld from the caller: a lock, never zero. */
  readonly totals: readonly StageTotal[] | undefined;
  readonly cards: readonly Deal[];
  readonly nextCursor: string | null;
  readonly loadingMore: boolean;
  readonly moreError: PipelineError | null;
}

export type BoardPhase = 'loading' | 'ready' | 'error' | 'not-found';

export interface BoardModel {
  readonly pipeline: Pipeline | null;
  readonly phase: BoardPhase;
  readonly error: PipelineError | null;
  readonly slow: boolean;
  readonly closedSince: string | null;
  readonly withheldFields: readonly string[];
  readonly columns: readonly Column[];
  /** The filters the columns on screen answer, for paging. */
  readonly answered: DealFilters | null;
  readonly syncedAt: Date | null;
  /** A re-read failed while a board is on screen: the last served board stays, and the screen says so. */
  readonly refreshFailed: boolean;
  readonly loadMore: (stageId: string) => void;
  readonly reload: () => void;
  /** Re-reads the pipeline's configuration (requirements, allow-list) and returns it. */
  readonly refreshPipeline: () => Promise<Pipeline | null>;
  /** Applies a deal the server just served: out of its old column, into its new one if that is a column. */
  readonly place: (deal: Deal) => void;
}

function toColumns(board: PipelineBoard): Column[] {
  return board.stages.map((stage) => ({
    stageId: stage.stageId,
    count: stage.count,
    totals: stage.totals,
    cards: stage.cards,
    nextCursor: stage.nextCursor,
    loadingMore: false,
    moreError: null,
  }));
}

export function usePipelineBoard(pipelineId: string, filters: DealFilters, active: boolean): BoardModel {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [pipelineError, setPipelineError] = useState<PipelineError | null>(null);
  const [board, setBoard] = useState<{
    readonly key: string;
    readonly filters: DealFilters;
    readonly closedSince: string;
    readonly withheldFields: readonly string[];
    readonly columns: readonly Column[];
  } | null>(null);
  const [boardError, setBoardError] = useState<PipelineError | null>(null);
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [nonce, setNonce] = useState(0);
  const sequence = useRef(0);
  const pipelineSequence = useRef(0);

  const key = filtersKey(filters);

  const readPipeline = useCallback(async (): Promise<Pipeline | null> => {
    pipelineSequence.current += 1;
    const mine = pipelineSequence.current;
    const result = await getPipeline(pipelineId);
    if (mine !== pipelineSequence.current) return null;
    if (result.ok) {
      setPipeline(result.value);
      setPipelineError(null);
      return result.value;
    }
    setPipelineError(result.error);
    return null;
  }, [pipelineId]);

  useEffect(() => {
    void readPipeline();
  }, [readPipeline]);

  // The whole board, for these filters: on load, on a filter change while the
  // board is the view, and on `reload()` after a write. A failed read is not
  // retried by itself; the person retries, or the next write or filter does.
  const requested = useRef<{ readonly key: string; readonly nonce: number } | null>(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  useEffect(() => {
    if (!active || (requested.current?.key === key && requested.current.nonce === nonce)) return undefined;
    requested.current = { key, nonce };
    sequence.current += 1;
    const mine = sequence.current;
    const asked = filtersRef.current;
    setLoading(true);
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), STILL_CONNECTING_MS);
    void getPipelineBoard(pipelineId, asked).then((result) => {
      window.clearTimeout(timer);
      if (mine !== sequence.current) return;
      setLoading(false);
      setSlow(false);
      if (result.ok) {
        setBoard({
          key,
          filters: asked,
          closedSince: result.value.closedSince,
          withheldFields: result.value.withheldFields,
          columns: toColumns(result.value),
        });
        setBoardError(null);
        setSyncedAt(new Date());
        return;
      }
      setBoardError(result.error);
    });
    return undefined;
  }, [active, key, nonce, pipelineId]);

  const reload = useCallback(() => setNonce((current) => current + 1), []);

  const patchColumn = useCallback((stageId: string, change: (column: Column) => Column) => {
    setBoard((current) =>
      current === null ? current : { ...current, columns: current.columns.map((column) => (column.stageId === stageId ? change(column) : column)) },
    );
  }, []);

  const loadMore = useCallback(
    (stageId: string) => {
      const current = board;
      const column = current?.columns.find((entry) => entry.stageId === stageId);
      if (current === null || column === undefined || column.nextCursor === null || column.loadingMore) return;
      const cursor = column.nextCursor;
      const boardKey = current.key;
      patchColumn(stageId, (entry) => ({ ...entry, loadingMore: true, moreError: null }));
      void getPipelineBoard(pipelineId, current.filters, { stageId, cursor }).then((result) => {
        setBoard((latest) => {
          // A whole-board read since this page was asked for wins.
          if (latest === null || latest.key !== boardKey) return latest;
          return {
            ...latest,
            columns: latest.columns.map((entry) => {
              if (entry.stageId !== stageId || entry.nextCursor !== cursor) return entry;
              if (!result.ok) return { ...entry, loadingMore: false, moreError: result.error };
              const page = result.value.stages.find((stage) => stage.stageId === stageId);
              if (page === undefined) return { ...entry, loadingMore: false };
              const held = new Set(entry.cards.map((card) => card.id));
              return {
                ...entry,
                count: page.count,
                totals: page.totals,
                cards: [...entry.cards, ...page.cards.filter((card) => !held.has(card.id))],
                nextCursor: page.nextCursor,
                loadingMore: false,
                moreError: null,
              };
            }),
          };
        });
      });
    },
    [board, patchColumn, pipelineId],
  );

  const place = useCallback(
    (deal: Deal) => {
    const won = pipeline?.stages.find((stage) => stage.id === deal.stageId)?.kind === 'won';
    setBoard((current) => {
      if (current === null) return current;
      return {
        ...current,
        columns: current.columns.map((column) => {
          const without = column.cards.filter((card) => card.id !== deal.id);
          if (column.stageId !== deal.stageId) return without.length === column.cards.length ? column : { ...column, cards: without };
          // Open columns list the longest-waiting first, so a deal that has just
          // arrived is last; won lists the newest first. The re-read that follows
          // every write puts it exactly where the server says.
          return { ...column, cards: won ? [deal, ...without] : [...without, deal] };
        }),
      };
    });
    },
    [pipeline],
  );

  const notFound = pipelineError?.code === 'not_found' || boardError?.code === 'not_found';
  const failed = pipelineError ?? boardError;
  const phase: BoardPhase = notFound
    ? 'not-found'
    : board !== null && pipeline !== null
      ? 'ready'
      : failed !== null
        ? 'error'
        : 'loading';

  return {
    pipeline,
    phase,
    error: failed,
    slow: slow && loading,
    closedSince: board?.closedSince ?? null,
    withheldFields: board?.withheldFields ?? [],
    columns: board?.columns ?? [],
    answered: board?.filters ?? null,
    syncedAt,
    refreshFailed: phase === 'ready' && (boardError ?? pipelineError) !== null,
    loadMore,
    reload: useCallback(() => {
      if (pipeline === null) void readPipeline();
      reload();
    }, [pipeline, readPipeline, reload]),
    refreshPipeline: readPipeline,
    place,
  };
}
