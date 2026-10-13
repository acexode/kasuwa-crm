import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AdminErrorFilter } from '../admin/common/admin-errors';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { currentTx } from '../tenancy/tenant-context';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import type { PipelineBoardWire, PipelineSummaryWire, PipelineWire } from './pipeline-wire';
import { getPipelineBoardFor, getPipelineFor, listPipelinesFor } from './pipelines.service';

/**
 * The pipeline reads of `docs/api/records.openapi.yaml` (contract T-0105,
 * implemented by T-0107): listPipelines, getPipeline and getPipelineBoard.
 * Deal reads and writes and the gated move are T-0108's.
 *
 * The controller never reads a tenant or programme id from the request. Scope
 * arrives through `currentTx()`, which came from the interceptor, which got it
 * from the database. The path id is handed to the service RAW: a value that
 * is not a uuid is the one `404 not_found` (D-L115), so no pipe or schema may
 * validate it first, and the query is judged only once the pipeline is known
 * to be in reach (404 before 400).
 *
 * Errors use the shared `Error` envelope through the admin filter. Every
 * answer is `Cache-Control: no-store`: the header here, which Nest sets after
 * the guards, and `NoStoreMiddleware` (app.module.ts, RECORDS_CONTROLLERS),
 * which also covers the guard's 401 and 400 and every error.
 *
 * Nothing here logs: deal names and next steps are pii (D-L115).
 */
const CACHE_CONTROL = 'Cache-Control';
const NO_STORE = 'no-store';

@Controller('api/v1/pipelines')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class PipelinesController {
  /**
   * `GET /api/v1/pipelines` — operationId `listPipelines`. 200 · 400 · 401.
   * The pipelines of the programmes the session reads, by name then id, on
   * id-only cursors (`PipelineCursor`, `Limit` 1..100, default 25). A cursor
   * naming no reachable pipeline is `400 invalid_cursor`. `client_portal`
   * reads none (D-L115): an empty page.
   */
  @Get()
  @Header(CACHE_CONTROL, NO_STORE)
  async list(
    @Query() query: unknown,
  ): Promise<{ data: PipelineSummaryWire[]; nextCursor: string | null }> {
    return listPipelinesFor(currentTx(), query);
  }

  /**
   * `GET /api/v1/pipelines/{pipelineId}` — operationId `getPipeline`.
   * 200 · 401 · 404. Stages and their requirements in position order, and the
   * transition allow-list. One 404 body for anything out of reach.
   */
  @Get(':pipelineId')
  @Header(CACHE_CONTROL, NO_STORE)
  async findOne(@Param() params: unknown): Promise<PipelineWire> {
    return getPipelineFor(currentTx(), params);
  }

  /**
   * `GET /api/v1/pipelines/{pipelineId}/board` — operationId
   * `getPipelineBoard`. 200 · 400 · 401 · 404 (404 before 400). Per column an
   * exact `count` and per-currency `totals` (omitted when `amount` is
   * withheld), and one page of cards; `stageId` with that column's `cursor`
   * reads its next page. Query: `q`, `owner`, `closeFrom`, `closeTo`,
   * `currency`, `closedSince`, `stageId`, `cursor`, `limit` (1..50, default 20).
   */
  @Get(':pipelineId/board')
  @Header(CACHE_CONTROL, NO_STORE)
  async board(@Param() params: unknown, @Query() query: unknown): Promise<PipelineBoardWire> {
    return getPipelineBoardFor(currentTx(), params, query);
  }
}
