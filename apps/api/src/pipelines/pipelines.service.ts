import type { TenantTx } from '@kasuwa/db';
import {
  boardColumnCards,
  boardColumnSelects,
  decodeIdCursor,
  encodeIdCursor,
  findPipeline,
  isUuid,
  listPipelines,
  loadDealFieldAccess,
  loadPipelineDetail,
  loadPipelineStages,
  tallyBoardColumns,
  withheldDealFields,
  type BoardColumn,
  type BoardFilters,
  type BoardQuery,
  type PipelineStageRow,
  type PipelineSummary,
} from '@kasuwa/domain-core';
import { loadGrants, programmesReadingPipelines } from '@kasuwa/permissions';
import {
  invalidCursor,
  notFound,
  validationFailed,
  validationFailedFrom,
  type AdminErrorDetail,
} from '../admin/common/admin-errors';
import {
  toDealWire,
  toPipelineSummaryWire,
  toPipelineWire,
  type BoardStageWire,
  type PipelineBoardWire,
  type PipelineSummaryWire,
  type PipelineWire,
} from './pipeline-wire';
import {
  BOARD_FILTER_FIELDS,
  DEAL_CURRENCIES,
  ListPipelinesQuery,
  PipelineBoardQuery,
} from './pipelines.schemas';

/**
 * listPipelines, getPipeline and getPipelineBoard (T-0107; D-L88, D-P19,
 * D-L115, D-L120).
 *
 * SCOPE comes from the session only: the programmes it resolves, less those
 * whose permission set reads no pipeline (`client_portal`, D-L115;
 * `programmesReadingPipelines`). No parameter narrows or widens it (R13).
 *
 * ERROR ORDER (the contract's x-kasuwa-error-order): a pipeline the caller
 * cannot reach is THE one 404 before any parameter is looked at (R3, R4), so
 * a bad parameter on someone else's pipeline is that 404. These are reads:
 * there is no 403 (R3).
 *
 * NOTHING HERE LOGS: deal names and next steps are pii (D-L115), and `q` is a
 * fragment of one.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** D-L88: the won column's default window. */
export const DEFAULT_CLOSED_SINCE_DAYS = 90;
/** D-L115: how far back closedSince may reach. Never clamped. */
export const MAX_CLOSED_SINCE_DAYS = 366;

async function readableProgrammes(tx: TenantTx): Promise<string[]> {
  if (tx.session.programmeIds.length === 0) return [];
  return programmesReadingPipelines(await loadGrants(tx));
}

/** The pipeline named by the raw path, in reach, or THE one 404. */
async function reachablePipeline(tx: TenantTx, params: unknown): Promise<PipelineSummary> {
  const id =
    typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>).pipelineId
      : undefined;
  if (!isUuid(id)) throw notFound();
  const pipeline = await findPipeline(tx, id, await readableProgrammes(tx));
  if (pipeline === null) throw notFound();
  return pipeline;
}

export async function listPipelinesFor(
  tx: TenantTx,
  rawQuery: unknown,
): Promise<{ data: PipelineSummaryWire[]; nextCursor: string | null }> {
  const query = ListPipelinesQuery.parse(rawQuery);
  const page = await listPipelines(tx, {
    programmeIds: await readableProgrammes(tx),
    limit: query.limit,
    cursor: query.cursor,
  });
  return { data: page.data.map(toPipelineSummaryWire), nextCursor: page.nextCursor };
}

export async function getPipelineFor(tx: TenantTx, params: unknown): Promise<PipelineWire> {
  const pipeline = await reachablePipeline(tx, params);
  return toPipelineWire(await loadPipelineDetail(tx, pipeline));
}

/**
 * The won window: the sent `closedSince` (already a UTC date-time), at most
 * 366 days back and never in the future, or 90 days before the request.
 * Returns the value to use and echo, or the refusal.
 */
export function resolveClosedSince(
  sent: string | undefined,
  nowMs: number,
): { closedSince: string } | { refusal: AdminErrorDetail } {
  if (sent === undefined) {
    return { closedSince: new Date(nowMs - DEFAULT_CLOSED_SINCE_DAYS * DAY_MS).toISOString() };
  }
  const at = Date.parse(sent);
  if (at > nowMs) return { refusal: { path: 'closedSince', code: 'invalid_window' } };
  if (at < nowMs - MAX_CLOSED_SINCE_DAYS * DAY_MS) {
    return { refusal: { path: 'closedSince', code: 'window_too_long' } };
  }
  return { closedSince: sent };
}

/** The stage `stageId` names among the board's columns, or null (R2, R18). */
export function boardStageNamed(
  columns: readonly PipelineStageRow[],
  stageId: unknown,
): PipelineStageRow | null {
  if (!isUuid(stageId)) return null;
  const wanted = stageId.toLowerCase();
  return columns.find((stage) => stage.id.toLowerCase() === wanted) ?? null;
}

export async function getPipelineBoardFor(
  tx: TenantTx,
  params: unknown,
  rawQuery: unknown,
  nowMs: number = Date.now(),
): Promise<PipelineBoardWire> {
  // 1. Reach, before anything the caller sent is judged (404 before 400).
  const pipeline = await reachablePipeline(tx, params);

  // 2. The parameters' shapes.
  const parsed = PipelineBoardQuery.safeParse(rawQuery);
  if (!parsed.success) throw validationFailedFrom(parsed.error);
  const query = parsed.data;

  // 3. Field security, judged in the pipeline's programme (I5): a filter on a
  //    withheld field is refused at its parameter, never silently ignored.
  const withheld = withheldDealFields(await loadDealFieldAccess(tx), pipeline.programmeId);
  const refusals: AdminErrorDetail[] = [];
  for (const [parameter, field] of Object.entries(BOARD_FILTER_FIELDS)) {
    if (
      query[parameter as keyof typeof BOARD_FILTER_FIELDS] !== undefined &&
      withheld.includes(field)
    ) {
      refusals.push({ path: parameter, code: 'field_withheld' });
    }
  }
  if (refusals.length > 0) throw validationFailed(refusals);

  // 4. Values the contract gives their own codes.
  if (query.currency?.some((code) => !DEAL_CURRENCIES.includes(code)) === true) {
    refusals.push({ path: 'currency', code: 'unknown_currency' });
  }
  if (query.closeFrom !== undefined && query.closeTo !== undefined) {
    if (query.closeTo < query.closeFrom) refusals.push({ path: 'closeTo', code: 'invalid_window' });
  }
  const stages = await loadPipelineStages(tx, pipeline);
  // Open stages then won, in position order; lost is not a column (R2).
  const columns = stages.filter((stage) => stage.kind !== 'lost');
  let selected = columns;
  if (query.stageId !== undefined) {
    const named = boardStageNamed(columns, query.stageId);
    if (named === null) refusals.push({ path: 'stageId', code: 'unknown_reference' });
    else selected = [named];
  }
  const window = resolveClosedSince(query.closedSince, nowMs);
  if ('refusal' in window) refusals.push(window.refusal);
  if (refusals.length > 0 || 'refusal' in window) throw validationFailed(refusals);

  const owners = query.owner ?? [];
  const filters: BoardFilters = {
    search: query.q,
    ownerUserIds: owners
      .filter((owner) => owner !== 'unassigned')
      .map((owner) => (owner === 'me' ? tx.session.userId : owner.toLowerCase())),
    ownerUnassigned: owners.includes('unassigned'),
    currencies: query.currency,
    closeFrom: query.closeFrom,
    closeTo: query.closeTo,
  };
  const boardQuery: BoardQuery = { pipeline, closedSince: window.closedSince, filters };
  const boardColumns: BoardColumn[] = selected.map((stage) => ({
    stageId: stage.id,
    kind: stage.kind === 'won' ? 'won' : 'open',
    probabilityBp: stage.probabilityBp,
  }));

  // 5. The cursor: one column's, naming a deal that column still holds under
  //    the same filters (R8). Anything else is the one invalid_cursor body.
  let afterDealId: string | undefined;
  if (query.cursor !== undefined) {
    const column = boardColumns.length === 1 ? boardColumns[0] : undefined;
    if (query.stageId === undefined || column === undefined) throw invalidCursor();
    afterDealId = decodeIdCursor(query.cursor);
    if (!(await boardColumnSelects(tx, boardQuery, column, afterDealId))) throw invalidCursor();
  }

  // 6. Exact counts and totals, then each column's page.
  const tallies = await tallyBoardColumns(tx, boardQuery, boardColumns);
  const amountWithheld = withheld.includes('amount');
  const out: BoardStageWire[] = [];
  for (const [index, column] of boardColumns.entries()) {
    const stage = selected[index];
    const page = await boardColumnCards(tx, boardQuery, column, {
      limit: query.limit,
      afterDealId,
    });
    const tally = tallies.get(column.stageId) ?? { count: 0, totals: [] };
    const last = page.cards.at(-1);
    out.push({
      stageId: column.stageId,
      count: tally.count,
      ...(amountWithheld ? {} : { totals: tally.totals }),
      cards: page.cards.map((card) =>
        toDealWire(card, withheld, stage?.rottingAfterDays ?? null, nowMs),
      ),
      nextCursor: page.hasMore && last !== undefined ? encodeIdCursor(last.id) : null,
    });
  }
  return {
    pipelineId: pipeline.id,
    closedSince: window.closedSince,
    withheldFields: withheld,
    stages: out,
  };
}
